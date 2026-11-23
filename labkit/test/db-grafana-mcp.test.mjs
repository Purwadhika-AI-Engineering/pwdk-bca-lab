import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { checkSelect } from '../mcp/db.mjs';
import { createIndex, createApp, toEntry } from '../services/grafana/server.mjs';
import { listen } from '../lib/http.mjs';

test('checkSelect allows one read-only statement', () => {
  assert.equal(checkSelect('SELECT * FROM accounts;'), 'SELECT * FROM accounts');
  assert.equal(checkSelect('-- note\nwith t as (select 1) select * from t'), 'with t as (select 1) select * from t');
  assert.equal(checkSelect("SELECT ';' AS x"), "SELECT ';' AS x");
  assert.throws(() => checkSelect('UPDATE accounts SET balance_cents = 0'), /Only SELECT/);
  assert.throws(() => checkSelect('SELECT 1; DROP TABLE accounts'), /One statement/);
  assert.throws(() => checkSelect('/* x */ delete from transfers'), /Only SELECT/);
  assert.throws(() => checkSelect('WITH x AS (DELETE FROM transfers) SELECT 1'), /Only SELECT/);
  assert.throws(() => checkSelect('  '), /empty/);
});

let server, tools;
before(async () => {
  const now = Date.now();
  const index = createIndex();
  const line = (secAgo, level, message, extra) =>
    toEntry(JSON.stringify({ '@timestamp': new Date(now - secAgo * 1000).toISOString(), log: { level, logger: 'labkit.request' }, service: { name: 'banklab-backend' }, message, ...extra }));
  index.add(line(30, 'INFO', 'POST /api/transfers -> 201 (20 ms)', { method: 'POST', path: '/api/transfers', status: '201', duration_ms: '20', traceId: 'aaa' }));
  index.add(line(20, 'WARN', 'POST /api/transfers -> 422 (5 ms) DAILY_LIMIT_EXCEEDED', { method: 'POST', path: '/api/transfers', status: '422', duration_ms: '5', errorCode: 'DAILY_LIMIT_EXCEEDED', traceId: 'bbb' }));
  server = await listen(createApp(index, null), 0);
  process.env.LABKIT_GRAFANA_URL = `http://127.0.0.1:${server.address().port}`;
  ({ tools } = await import('../mcp/grafana.mjs'));
});
after(() => server.close());
const call = (name, args = {}) => tools.find((t) => t.name === name).handler(args);

test('grafana tools mirror mcp-grafana names', () => {
  assert.deepEqual(tools.map((t) => t.name).sort(), ['list_datasources', 'list_loki_label_names', 'list_loki_label_values', 'list_prometheus_metric_names', 'query_loki_logs', 'query_prometheus']);
});

test('query_loki_logs finds the error, newest first', async () => {
  const rows = await call('query_loki_logs', { datasourceUid: 'loki', logql: '{job="banklab-backend"} | json | status >= 400' });
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].line).errorCode, 'DAILY_LIMIT_EXCEEDED');
  const all = await call('query_loki_logs', { logql: '{job="banklab-backend"}' });
  assert.deepEqual(all.map((r) => JSON.parse(r.line).traceId), ['bbb', 'aaa']);
  assert.match(await call('query_loki_logs', { logql: '{job="banklab-backend"} |= "nothing like this"' }), /No log lines matched/);
});

test('query_loki_logs metric query and labels', async () => {
  const series = await call('query_loki_logs', { logql: 'sum by (level) (count_over_time({job="banklab-backend"}[5m]))', startRfc3339: 'now-1m' });
  assert.deepEqual(series.map((s) => s.metric.level).sort(), ['info', 'warn']);
  assert.deepEqual(await call('list_loki_label_values', { labelName: 'level' }), ['info', 'warn']);
});

test('query_prometheus instant and range', async () => {
  const v = await call('query_prometheus', { expr: 'sum by (status) (increase(http_requests_total[5m]))' });
  assert.deepEqual(Object.fromEntries(v.map((s) => [s.metric.status, s.value])), { 201: 1, 422: 1 });
  const r = await call('query_prometheus', { expr: 'sum(increase(http_requests_total[5m]))', queryType: 'range', startTime: 'now-10m', stepSeconds: 60 });
  assert.equal(r[0].values.at(-1)[1], 2);
  await assert.rejects(call('query_prometheus', { expr: 'up' }), /Unknown metric/);
});

const dbUp = await new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: 5435 });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

test('db tools against the running backend (labkit profile)', { skip: !dbUp && 'backend with the labkit profile is not running' }, async () => {
  const { tools: dbTools, close } = await import('../mcp/db.mjs');
  const db = (name, args = {}) => dbTools.find((t) => t.name === name).handler(args);
  const tables = await db('list_tables');
  assert.deepEqual(tables.map((t) => t.table), ['accounts', 'external_accounts', 'transfers']);
  const cols = await db('describe_table', { table: 'accounts' });
  assert.ok(cols.some((c) => c.column === 'account_no'));
  const r = await db('query', { sql: "SELECT account_no, owner FROM accounts WHERE account_no = '1234567890'" });
  assert.deepEqual(r.rows, [{ account_no: '1234567890', owner: 'Andi Wijaya' }]);
  await assert.rejects(db('query', { sql: 'SELECT * FROM users' }), /not found/);
  await assert.rejects(db('query', { sql: 'UPDATE accounts SET owner = 1' }), /Only SELECT/);
  await close();
});
