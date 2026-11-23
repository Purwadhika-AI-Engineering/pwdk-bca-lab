#!/usr/bin/env node
// Grafana mock: tails backend/logs/app.json (ECS JSON from the labkit profile), keeps it in memory,
// and answers Loki-style log queries and Prometheus-style metric queries on 127.0.0.1:4330.
//
//   node labkit/services/grafana/server.mjs [--port 4330] [--log ../backend/logs/app.json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, listen, HttpError } from '../../lib/http.mjs';
import { parseLogQL, filterEntries, evalMetric, flatten, parseDuration, LogQLError } from './logql.mjs';
import { parsePromQL, evalPromQL, METRICS, PromQLError } from './promql.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LABKIT = path.resolve(HERE, '..', '..');
export const DEFAULT_PORT = 4330;
export const DEFAULT_LOG = path.resolve(LABKIT, '..', 'backend', 'logs', 'app.json');
const MAX_ENTRIES = 200_000;

/** /api/accounts/******7890/summary -> /api/accounts/{account}/summary */
export function route(p) {
  return String(p || '')
    .split('?')[0]
    .replace(/\*{3,}\d{0,4}/g, '{account}')
    .replace(/\/\d+(?=\/|$)/g, '/{id}');
}

/** Turns one ECS JSON line into a log entry. Returns null for lines that are not JSON. */
export function toEntry(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const ts = Date.parse(j['@timestamp']);
  if (Number.isNaN(ts)) return null;
  const level = String(j.log?.level || j.level || 'info').toLowerCase();
  const logger = j.log?.logger || j.logger || '';
  const compact = { ts: j['@timestamp'], level, logger, message: j.message };
  for (const k of ['traceId', 'method', 'path', 'status', 'duration_ms', 'errorCode', 'user']) if (j[k] !== undefined) compact[k] = j[k];
  if (j.error) {
    compact.error = {
      type: j.error.type,
      message: j.error.message,
      stack_trace: j.error.stack_trace ? String(j.error.stack_trace).split('\n').slice(0, 15).join('\n') : undefined,
    };
  }
  const line = JSON.stringify(compact);
  return {
    ts,
    line,
    labels: { job: j.service?.name || 'banklab-backend', level, logger },
    fields: flatten(compact),
  };
}

export function createIndex() {
  const entries = [];
  const requests = [];
  return {
    entries,
    requests,
    add(entry) {
      if (!entry) return;
      entries.push(entry);
      if (entry.labels.logger === 'labkit.request' && entry.fields.status) {
        requests.push({
          ts: entry.ts,
          seconds: Number(entry.fields.duration_ms || 0) / 1000,
          labels: { job: entry.labels.job, method: entry.fields.method || '', path: route(entry.fields.path), status: String(entry.fields.status) },
        });
      }
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      while (requests.length && requests[0].ts < entries[0].ts) requests.shift();
    },
    clear() {
      entries.length = 0;
      requests.length = 0;
    },
    get logs() {
      return entries;
    },
  };
}

/** Polls the log file and feeds new lines to the index. Handles a missing, rotated or truncated file. */
export function createTailer(file, index, { intervalMs = 500 } = {}) {
  let offset = 0;
  let ino = null;
  let partial = '';
  let lastRead = null;
  let timer = null;
  function poll() {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    if ((ino !== null && st.ino !== ino) || st.size < offset) {
      offset = 0;
      partial = '';
    }
    ino = st.ino;
    if (st.size === offset) return;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size - offset, 32 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      offset += len;
      const text = partial + buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      partial = lines.pop();
      for (const l of lines) if (l.trim()) index.add(toEntry(l));
      lastRead = new Date().toISOString();
    } finally {
      fs.closeSync(fd);
    }
  }
  return {
    poll,
    start() {
      poll();
      timer = setInterval(poll, intervalMs);
      timer.unref?.();
    },
    stop: () => clearInterval(timer),
    skipToEnd() {
      try {
        offset = fs.statSync(file).size;
      } catch {
        offset = 0;
      }
      partial = '';
    },
    status: () => ({ file, offset, exists: fs.existsSync(file), lastRead }),
  };
}

/** Accepts RFC3339, epoch s/ms/ns, "now", "now-15m" or "-15m". */
export function parseTime(value, fallback, now = Date.now()) {
  if (value === undefined || value === null || value === '') return fallback;
  const s = String(value).trim();
  if (s === 'now') return now;
  const rel = /^(?:now)?-(\d+(?:ms|s|m|h|d))$/.exec(s);
  if (rel) return now - parseDuration(rel[1]);
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1e17) return Math.floor(n / 1e6); // ns
    if (n > 1e14) return Math.floor(n / 1e3); // µs
    if (n > 1e11) return n; // ms
    return n * 1000; // s
  }
  const d = Date.parse(s);
  if (Number.isNaN(d)) throw new HttpError(400, `Bad time "${s}". Use RFC3339 (2026-11-26T09:00:00+07:00), epoch seconds, or now-15m.`);
  return d;
}

function stepMs(step, start, end) {
  if (step) return /^\d+(\.\d+)?$/.test(String(step)) ? Number(step) * 1000 : parseDuration(String(step));
  return Math.max(1000, Math.ceil((end - start) / 250 / 1000) * 1000);
}

function wrap(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof LogQLError || err instanceof PromQLError) throw new HttpError(400, err.message);
    throw err;
  }
}

export function lokiQuery(index, { query, start, end, limit, direction, step }, now = Date.now()) {
  const endMs = parseTime(end, now, now);
  const startMs = parseTime(start, endMs - 3600e3, now);
  return wrap(() => {
    const ast = parseLogQL(query);
    if (ast.type === 'logs') {
      const lim = Math.min(Math.max(Number(limit) || 100, 1), 5000);
      let hits = filterEntries(ast, index.entries, { start: startMs, end: endMs });
      hits = direction === 'forward' ? hits.slice(0, lim) : hits.slice(-lim).reverse();
      const streams = new Map();
      for (const h of hits) {
        const k = JSON.stringify(h.streamLabels);
        const s = streams.get(k) || { stream: h.streamLabels, values: [] };
        s.values.push([String(BigInt(h.ts) * 1_000_000n), h.line]);
        streams.set(k, s);
      }
      return { status: 'success', data: { resultType: 'streams', result: [...streams.values()], stats: { matched: hits.length } } };
    }
    const sMs = stepMs(step, startMs, endMs);
    const matrix = new Map();
    for (let t = startMs; t <= endMs; t += sMs) {
      for (const s of evalMetric(ast, index.entries, t)) {
        const k = JSON.stringify(s.metric);
        const m = matrix.get(k) || { metric: s.metric, values: [] };
        m.values.push([t / 1000, String(s.value)]);
        matrix.set(k, m);
      }
    }
    return { status: 'success', data: { resultType: 'matrix', result: [...matrix.values()] } };
  });
}

export function promInstant(index, { query, time }, now = Date.now()) {
  const t = parseTime(time, now, now);
  return wrap(() => {
    const v = evalPromQL(parsePromQL(query), index, t);
    if (typeof v === 'number') return { status: 'success', data: { resultType: 'scalar', result: [t / 1000, String(v)] } };
    return { status: 'success', data: { resultType: 'vector', result: v.map((s) => ({ metric: s.metric, value: [t / 1000, String(s.value)] })) } };
  });
}

export function promRange(index, { query, start, end, step }, now = Date.now()) {
  const endMs = parseTime(end, now, now);
  const startMs = parseTime(start, endMs - 3600e3, now);
  const sMs = stepMs(step, startMs, endMs);
  if ((endMs - startMs) / sMs > 11000) throw new HttpError(400, 'Too many points. Use a bigger step.');
  return wrap(() => {
    const ast = parsePromQL(query);
    const matrix = new Map();
    for (let t = startMs; t <= endMs; t += sMs) {
      const v = evalPromQL(ast, index, t);
      const list = typeof v === 'number' ? [{ metric: {}, value: v }] : v;
      for (const s of list) {
        const k = JSON.stringify(s.metric);
        const m = matrix.get(k) || { metric: s.metric, values: [] };
        m.values.push([t / 1000, String(s.value)]);
        matrix.set(k, m);
      }
    }
    return { status: 'success', data: { resultType: 'matrix', result: [...matrix.values()] } };
  });
}

function labelNames(index, start, end) {
  const names = new Set();
  for (const e of index.entries) if (e.ts >= start && e.ts <= end) Object.keys(e.labels).forEach((k) => names.add(k));
  return [...names].sort();
}

function labelValues(index, name, start, end) {
  const values = new Set();
  for (const e of index.entries) if (e.ts >= start && e.ts <= end && e.labels[name] !== undefined) values.add(e.labels[name]);
  return [...values].sort();
}

/** Numbers for the dashboard page, last `minutes` minutes. */
export function dashboard(index, now = Date.now(), minutes = 30) {
  const start = now - minutes * 60e3;
  const reqs = index.requests.filter((r) => r.ts > start && r.ts <= now);
  const buckets = [];
  for (let i = minutes - 1; i >= 0; i--) {
    const from = now - (i + 1) * 60e3;
    const to = now - i * 60e3;
    const inMin = reqs.filter((r) => r.ts > from && r.ts <= to);
    buckets.push({
      t: to,
      ok: inMin.filter((r) => r.labels.status < '400').length,
      client: inMin.filter((r) => r.labels.status >= '400' && r.labels.status < '500').length,
      server: inMin.filter((r) => r.labels.status >= '500').length,
    });
  }
  const byPath = new Map();
  for (const r of reqs) {
    const k = `${r.labels.method} ${r.labels.path}`;
    const g = byPath.get(k) || { route: k, count: 0, errors: 0, durations: [] };
    g.count++;
    if (r.labels.status >= '400') g.errors++;
    g.durations.push(r.seconds * 1000);
    byPath.set(k, g);
  }
  const p95 = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : 0;
  };
  const errors = index.entries.filter((e) => e.ts > start && (e.labels.level === 'warn' || e.labels.level === 'error')).slice(-25).reverse();
  return {
    minutes,
    total: reqs.length,
    errorRate: reqs.length ? reqs.filter((r) => r.labels.status >= '400').length / reqs.length : 0,
    serverErrors: reqs.filter((r) => r.labels.status >= '500').length,
    p95ms: p95(reqs.map((r) => r.seconds * 1000)),
    perMinute: buckets,
    routes: [...byPath.values()].map((g) => ({ route: g.route, count: g.count, errors: g.errors, p95ms: p95(g.durations) })).sort((a, b) => b.count - a.count),
    recentErrors: errors.map((e) => ({ ts: new Date(e.ts).toISOString(), level: e.labels.level, logger: e.labels.logger, message: e.fields.message, traceId: e.fields.traceId })),
  };
}

export function createApp(index, tailer) {
  const r = createRouter();
  const range = (q) => {
    const now = Date.now();
    const end = parseTime(q.end, now, now);
    return [parseTime(q.start, end - 3600e3 * 6, now), end];
  };
  r.get('/health', () => ({ ok: true, service: 'grafana', entries: index.entries.length, log: tailer?.status() }));
  r.post('/admin/reset', () => {
    index.clear();
    tailer?.skipToEnd();
    return { ok: true };
  });
  r.get('/api/datasources', () => [
    { uid: 'loki', name: 'Loki (labkit)', type: 'loki', url: '/loki' },
    { uid: 'prometheus', name: 'Prometheus (labkit)', type: 'prometheus', url: '/api/v1' },
  ]);
  r.get('/api/dashboard', ({ query }) => dashboard(index, Date.now(), Math.min(Number(query.minutes) || 30, 24 * 60)));
  r.get('/loki/api/v1/query_range', ({ query }) => lokiQuery(index, query));
  r.get('/loki/api/v1/query', ({ query }) => lokiQuery(index, { ...query, end: query.time, start: undefined }));
  r.get('/loki/api/v1/labels', ({ query }) => ({ status: 'success', data: labelNames(index, ...range(query)) }));
  r.get('/loki/api/v1/label/:name/values', ({ params, query }) => ({ status: 'success', data: labelValues(index, params.name, ...range(query)) }));
  r.get('/api/v1/query', ({ query }) => promInstant(index, query));
  r.get('/api/v1/query_range', ({ query }) => promRange(index, query));
  r.get('/api/v1/metadata', () => ({ status: 'success', data: Object.fromEntries(Object.entries(METRICS).map(([k, v]) => [k, [{ type: k.endsWith('_bucket') ? 'histogram' : 'counter', help: v.help }]])) }));
  r.get('/api/v1/label/:name/values', ({ params }) => {
    if (params.name === '__name__') return { status: 'success', data: Object.keys(METRICS) };
    const set = new Set(index.requests.map((x) => x.labels[params.name]).filter(Boolean));
    return { status: 'success', data: [...set].sort() };
  });
  r.static('/', path.join(HERE, 'ui'));
  return r;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(arg('port', process.env.LABKIT_GRAFANA_PORT || DEFAULT_PORT));
  const file = path.resolve(arg('log', process.env.LABKIT_LOG_FILE || DEFAULT_LOG));
  const index = createIndex();
  const tailer = createTailer(file, index);
  tailer.start();
  const server = await listen(createApp(index, tailer), port);
  console.log(`[grafana] logs + metrics mock on http://127.0.0.1:${server.address().port} (reading ${file})`);
  if (!fs.existsSync(file)) console.log('[grafana] log file not found yet. Start the backend with the labkit profile; it is picked up within a second.');
}
