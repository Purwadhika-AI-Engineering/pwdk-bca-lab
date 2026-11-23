import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIndex, createTailer, toEntry, route, parseTime, lokiQuery, promInstant, promRange, dashboard, createApp } from '../services/grafana/server.mjs';
import { parseLogQL } from '../services/grafana/logql.mjs';
import { parsePromQL } from '../services/grafana/promql.mjs';
import { listen, requestJson } from '../lib/http.mjs';

const T0 = Date.parse('2026-11-26T02:00:00Z');
const ecs = (sec, level, logger, message, extra = {}) =>
  JSON.stringify({ '@timestamp': new Date(T0 + sec * 1000).toISOString(), log: { level, logger }, process: { pid: 1 }, service: { name: 'banklab-backend' }, message, ...extra, ecs: { version: '8.11' } });
const req = (sec, method, p, status, ms, extra = {}) =>
  ecs(sec, status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO', 'labkit.request', `${method} ${p} -> ${status} (${ms} ms)`, { method, path: p, status: String(status), duration_ms: String(ms), traceId: `t${sec}`, ...extra });

const LINES = [
  ecs(0, 'INFO', 'com.example.banklab.BankLabApplication', 'Started BankLabApplication'),
  req(10, 'POST', '/api/auth/login', 200, 40),
  req(20, 'GET', '/api/accounts/******7890', 200, 8),
  req(30, 'POST', '/api/transfers', 201, 30),
  req(40, 'POST', '/api/transfers', 422, 5, { errorCode: 'DAILY_LIMIT_EXCEEDED' }),
  req(50, 'POST', '/api/transfers', 422, 6, { errorCode: 'BELOW_MINIMUM' }),
  ecs(60, 'ERROR', 'com.example.banklab.common.GlobalExceptionHandler', 'Unexpected error', { traceId: 't60', error: { type: 'java.lang.IllegalStateException', message: 'boom', stack_trace: 'java.lang.IllegalStateException: boom\n\tat x' } }),
  req(60, 'GET', '/api/accounts/******7891/summary', 500, 300),
  req(70, 'GET', '/api/transfers', 401, 1),
];
const NOW = T0 + 120_000;

function loaded() {
  const index = createIndex();
  for (const l of LINES) index.add(toEntry(l));
  return index;
}
const lines = (res, dir = 1) =>
  res.data.result.flatMap((s) => s.values).sort((a, b) => dir * (Number(BigInt(a[0]) - BigInt(b[0])))).map(([, line]) => JSON.parse(line));

test('toEntry keeps useful fields and drops noise', () => {
  const e = toEntry(LINES[4]);
  assert.deepEqual(e.labels, { job: 'banklab-backend', level: 'warn', logger: 'labkit.request' });
  const line = JSON.parse(e.line);
  assert.equal(line.errorCode, 'DAILY_LIMIT_EXCEEDED');
  assert.equal(line.process, undefined);
  assert.equal(toEntry('not json'), null);
});

test('route normalises masked accounts and ids', () => {
  assert.equal(route('/api/accounts/******7890/summary'), '/api/accounts/{account}/summary');
  assert.equal(route('/api/transfers/42?x=1'), '/api/transfers/{id}');
});

test('parseTime accepts RFC3339, epochs and relative times', () => {
  assert.equal(parseTime('2026-11-26T09:00:00+07:00'), T0);
  assert.equal(parseTime(String(T0 / 1000)), T0);
  assert.equal(parseTime(String(T0 * 1e6)), T0);
  assert.equal(parseTime('now-15m', 0, NOW), NOW - 900e3);
  assert.equal(parseTime('-1h', 0, NOW), NOW - 3600e3);
});

test('LogQL: selector, line filters and json label filters', () => {
  const index = loaded();
  const q = (query) => lines(lokiQuery(index, { query, start: String(T0 / 1000), end: String(NOW / 1000), direction: 'forward' }, NOW));
  assert.equal(q('{job="banklab-backend"}').length, 9);
  assert.deepEqual(q('{job="banklab-backend", level=~"warn|error"}').map((l) => l.traceId), ['t40', 't50', 't60', 't60', 't70']);
  assert.deepEqual(q('{job="banklab-backend"} |= "DAILY_LIMIT"').map((l) => l.traceId), ['t40']);
  assert.deepEqual(q('{logger="labkit.request"} | json | status >= 400 and method = "POST"').map((l) => l.errorCode), ['DAILY_LIMIT_EXCEEDED', 'BELOW_MINIMUM']);
  assert.deepEqual(q('{job="banklab-backend"} | json | traceId = "t60"').map((l) => l.logger), ['com.example.banklab.common.GlobalExceptionHandler', 'labkit.request']);
  assert.deepEqual(q('{job="banklab-backend"} |~ "IllegalState\\\\w+" != "health"').map((l) => l.error.type), ['java.lang.IllegalStateException']);
  assert.deepEqual(q('{job="banklab-backend"} | json | error_type =~ "java.*"').length, 1);
});

test('LogQL: backward is newest first, limit applies', () => {
  const res = lines(lokiQuery(loaded(), { query: '{logger="labkit.request"}', start: String(T0 / 1000), limit: 2 }, NOW), -1);
  assert.deepEqual(res.map((l) => l.traceId), ['t70', 't60']);
});

test('LogQL: metric queries count lines', () => {
  const res = lokiQuery(loaded(), { query: 'sum by (level) (count_over_time({job="banklab-backend"}[2m]))', start: String(NOW / 1000), end: String(NOW / 1000) }, NOW);
  const byLevel = Object.fromEntries(res.data.result.map((s) => [s.metric.level, Number(s.values[0][1])]));
  assert.deepEqual(byLevel, { info: 3, warn: 3, error: 2 }); // the line at second 0 is outside (now-2m, now]
  const byCode = lokiQuery(loaded(), { query: 'sum by (errorCode) (count_over_time({logger="labkit.request"} | json | status = 422 [5m]))', start: String(NOW / 1000), end: String(NOW / 1000) }, NOW);
  assert.deepEqual(byCode.data.result.map((s) => s.metric.errorCode).sort(), ['BELOW_MINIMUM', 'DAILY_LIMIT_EXCEEDED']);
});

test('LogQL: clear errors for unsupported syntax', () => {
  assert.throws(() => parseLogQL('{}'), /at least one matcher/);
  assert.throws(() => parseLogQL('{job="x"} | logfmt'), /not supported in labkit/);
  assert.throws(() => parseLogQL('job="x"'), /not supported|Expected/);
  assert.throws(() => lokiQuery(loaded(), { query: '{job=~".*"}' }), /does not match an empty value/);
});

test('PromQL: request rate by status and error ratio', () => {
  const index = loaded();
  const v = (query) => promInstant(index, { query, time: String(NOW / 1000) }, NOW).data;
  const byStatus = Object.fromEntries(v('sum by (status) (increase(http_requests_total[5m]))').result.map((s) => [s.metric.status, Number(s.value[1])]));
  assert.deepEqual(byStatus, { 200: 2, 201: 1, 422: 2, 500: 1, 401: 1 });
  const ratio = v('sum(rate(http_requests_total{status=~"4..|5.."}[5m])) / sum(rate(http_requests_total[5m]))');
  assert.equal(Number(ratio.result[0].value[1]).toFixed(4), (4 / 7).toFixed(4));
  assert.equal(Number(v('sum(rate(http_requests_total[5m])) * 60').result[0].value[1]).toFixed(6), (7 / 5).toFixed(6));
  assert.equal(v('1 + 2').resultType, 'scalar');
});

test('PromQL: p95 latency by path from histogram buckets', () => {
  const index = loaded();
  const r = promInstant(index, { query: 'histogram_quantile(0.95, sum by (le, path) (rate(http_request_duration_seconds_bucket[5m])))', time: String(NOW / 1000) }, NOW).data.result;
  const p95 = Object.fromEntries(r.map((s) => [s.metric.path, Number(s.value[1])]));
  assert.ok(p95['/api/accounts/{account}/summary'] > 0.25 && p95['/api/accounts/{account}/summary'] <= 0.5);
  assert.ok(p95['/api/transfers'] > 0.025 && p95['/api/transfers'] <= 0.05);
});

test('PromQL: range query and errors', () => {
  const r = promRange(loaded(), { query: 'sum(increase(http_requests_total[1m]))', start: String(T0 / 1000), end: String((T0 + 120e3) / 1000), step: '60' }, NOW);
  // No sample at T0: like Prometheus, sum() of an empty vector has no value.
  assert.deepEqual(r.data.result[0].values.map((x) => [x[0] - T0 / 1000, Number(x[1])]), [[60, 6], [120, 1]]);
  assert.throws(() => parsePromQL('up'), /Unknown metric/);
  assert.throws(() => parsePromQL('rate(http_requests_total)'), /needs a range/);
  assert.throws(() => parsePromQL('irate(http_requests_total[5m])'), /not supported/);
});

test('dashboard summarises the last minutes', () => {
  const d = dashboard(loaded(), NOW, 5);
  assert.equal(d.total, 7);
  assert.equal(d.serverErrors, 1);
  assert.equal(d.routes[0].route, 'POST /api/transfers');
  assert.equal(d.routes[0].errors, 2);
  assert.equal(d.recentErrors[0].message, 'GET /api/transfers -> 401 (1 ms)');
});

test('tailer reads new lines, partial lines, and a truncated file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labkit-'));
  const file = path.join(dir, 'app.json');
  const index = createIndex();
  const tail = createTailer(file, index);
  tail.poll();
  assert.equal(index.entries.length, 0);
  fs.writeFileSync(file, LINES[0] + '\n' + LINES[1].slice(0, 20));
  tail.poll();
  assert.equal(index.entries.length, 1);
  fs.appendFileSync(file, LINES[1].slice(20) + '\r\n');
  tail.poll();
  assert.equal(index.entries.length, 2);
  assert.equal(index.requests.length, 1);
  fs.writeFileSync(file, LINES[2] + '\n');
  tail.poll();
  assert.equal(index.entries.length, 3);
  fs.rmSync(dir, { recursive: true });
});

test('HTTP API answers Loki and Prometheus paths', async () => {
  const index = loaded();
  const server = await listen(createApp(index, null), 0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const ds = await requestJson(base, 'GET', '/api/datasources');
  assert.deepEqual(ds.map((d) => d.uid), ['loki', 'prometheus']);
  const labels = await requestJson(base, 'GET', `/loki/api/v1/labels?start=${T0 / 1000}&end=${NOW / 1000}`);
  assert.deepEqual(labels.data, ['job', 'level', 'logger']);
  const values = await requestJson(base, 'GET', `/loki/api/v1/label/level/values?start=${T0 / 1000}&end=${NOW / 1000}`);
  assert.deepEqual(values.data, ['error', 'info', 'warn']);
  await assert.rejects(requestJson(base, 'GET', '/loki/api/v1/query_range?query=' + encodeURIComponent('{job="x"} | logfmt')), /400/);
  server.close();
});
