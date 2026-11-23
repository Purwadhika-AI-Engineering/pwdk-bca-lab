// A small PromQL subset over metrics derived from the backend request log.
//
// Metrics (labels: job, method, path, status):
//   http_requests_total                     counter, one per request
//   http_request_duration_seconds_bucket    histogram buckets (extra label le)
//   http_request_duration_seconds_sum / _count
//   log_messages_total                      counter per log line (labels: job, level, logger)
// Supported: selectors with = != =~ !~, rate(), increase(), sum/avg/min/max/count [by (...)],
// histogram_quantile(), + - * / between numbers and vectors, parentheses.
// Examples:
//   sum by (status) (rate(http_requests_total[5m]))
//   sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
//   histogram_quantile(0.95, sum by (le, path) (rate(http_request_duration_seconds_bucket[5m])))

import { parseDuration } from './logql.mjs';

export class PromQLError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const METRICS = {
  http_requests_total: { help: 'Requests to /api, by method, path, status', samples: (r) => [{ labels: r.labels, inc: 1 }] },
  http_request_duration_seconds_bucket: {
    help: 'Request duration histogram buckets',
    samples: (r) => [...BUCKETS.map((le) => ({ labels: { ...r.labels, le: String(le) }, inc: r.seconds <= le ? 1 : 0 })), { labels: { ...r.labels, le: '+Inf' }, inc: 1 }],
  },
  http_request_duration_seconds_sum: { help: 'Total request time in seconds', samples: (r) => [{ labels: r.labels, inc: r.seconds }] },
  http_request_duration_seconds_count: { help: 'Number of timed requests', samples: (r) => [{ labels: r.labels, inc: 1 }] },
  log_messages_total: { help: 'Log lines by level and logger', source: 'logs', samples: (l) => [{ labels: l.labels, inc: 1 }] },
};

function lexer(src) {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const lx = {
    eof: () => (ws(), i >= src.length),
    peek: (s) => (ws(), src.startsWith(s, i)),
    eat: (s) => {
      ws();
      if (src.startsWith(s, i)) {
        // keywords must end at a word boundary
        if (/^[a-z]/i.test(s) && /[A-Za-z0-9_]/.test(src[i + s.length] || '')) return false;
        i += s.length;
        return true;
      }
      return false;
    },
    expect: (s) => {
      if (!lx.eat(s)) throw new PromQLError(`Expected "${s}" at position ${i}: ${src.slice(i, i + 25) || '(end)'}`);
    },
    ident: () => {
      ws();
      const m = /^[A-Za-z_:][A-Za-z0-9_:]*/.exec(src.slice(i));
      if (!m) throw new PromQLError(`Expected a name at position ${i}: ${src.slice(i, i + 25) || '(end)'}`);
      i += m[0].length;
      return m[0];
    },
    number: () => {
      ws();
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i));
      if (!m) return null;
      i += m[0].length;
      return Number(m[0]);
    },
    string: () => {
      ws();
      const q = src[i];
      if (q !== '"' && q !== "'") throw new PromQLError(`Expected a quoted string at position ${i}`);
      const end = src.indexOf(q, i + 1);
      if (end < 0) throw new PromQLError(`Missing closing ${q}`);
      const s = src.slice(i + 1, end);
      i = end + 1;
      return s;
    },
    duration: () => {
      ws();
      const m = /^\d+(ms|s|m|h|d)/.exec(src.slice(i));
      if (!m) throw new PromQLError(`Expected a duration like 5m at position ${i}`);
      i += m[0].length;
      return parseDuration(m[0]);
    },
    rest: () => src.slice(i),
  };
  return lx;
}

function labelList(lx) {
  lx.expect('(');
  const out = [];
  if (!lx.eat(')')) {
    do out.push(lx.ident());
    while (lx.eat(','));
    lx.expect(')');
  }
  return out;
}

function matcher(op, value) {
  if (op === '=') return (v) => (v ?? '') === value;
  if (op === '!=') return (v) => (v ?? '') !== value;
  let re;
  try {
    re = new RegExp(`^(?:${value})$`);
  } catch {
    throw new PromQLError(`Bad regular expression: ${value}`);
  }
  return op === '=~' ? (v) => re.test(v ?? '') : (v) => !re.test(v ?? '');
}

const AGGS = ['sum', 'avg', 'min', 'max', 'count'];

function parsePrimary(lx) {
  if (lx.eat('(')) {
    const e = parseAdd(lx);
    lx.expect(')');
    return e;
  }
  const n = lx.number();
  if (n !== null) return { type: 'number', value: n };
  const name = lx.ident();
  if (AGGS.includes(name)) {
    let by = null;
    if (lx.eat('by')) by = labelList(lx);
    lx.expect('(');
    const inner = parseAdd(lx);
    lx.expect(')');
    if (!by && lx.eat('by')) by = labelList(lx);
    return { type: 'agg', op: name, by, inner };
  }
  if (name === 'rate' || name === 'increase') {
    lx.expect('(');
    const sel = parseSelector(lx, lx.ident());
    if (!sel.range) throw new PromQLError(`${name}() needs a range, for example ${name}(http_requests_total[5m])`);
    lx.expect(')');
    return { type: 'func', fn: name, sel };
  }
  if (name === 'histogram_quantile') {
    lx.expect('(');
    const q = lx.number();
    if (q === null || q < 0 || q > 1) throw new PromQLError('histogram_quantile needs a number between 0 and 1 first');
    lx.expect(',');
    const inner = parseAdd(lx);
    lx.expect(')');
    return { type: 'hq', q, inner };
  }
  if (lx.peek('(')) throw new PromQLError(`Function "${name}" is not supported. Use rate, increase, sum, avg, min, max, count, histogram_quantile.`);
  const sel = parseSelector(lx, name);
  if (sel.range) throw new PromQLError('A range vector must be inside rate() or increase()');
  return sel;
}

function parseSelector(lx, name) {
  if (!METRICS[name]) throw new PromQLError(`Unknown metric "${name}". Known: ${Object.keys(METRICS).join(', ')}`);
  const matchers = [];
  if (lx.eat('{')) {
    if (!lx.eat('}')) {
      do {
        const label = lx.ident();
        let op = null;
        for (const o of ['=~', '!~', '!=', '=']) if (lx.eat(o)) { op = o; break; }
        if (!op) throw new PromQLError(`Expected =, !=, =~ or !~ after ${label}`);
        const value = lx.string();
        matchers.push({ label, test: matcher(op, value) });
      } while (lx.eat(','));
      lx.expect('}');
    }
  }
  let range = null;
  if (lx.eat('[')) {
    range = lx.duration();
    lx.expect(']');
  }
  return { type: 'selector', name, matchers, range };
}

function parseMul(lx) {
  let left = parsePrimary(lx);
  for (;;) {
    if (lx.eat('*')) left = { type: 'bin', op: '*', left, right: parsePrimary(lx) };
    else if (lx.eat('/')) left = { type: 'bin', op: '/', left, right: parsePrimary(lx) };
    else return left;
  }
}

function parseAdd(lx) {
  let left = parseMul(lx);
  for (;;) {
    if (lx.eat('+')) left = { type: 'bin', op: '+', left, right: parseMul(lx) };
    else if (lx.eat('-')) left = { type: 'bin', op: '-', left, right: parseMul(lx) };
    else return left;
  }
}

export function parsePromQL(src) {
  const lx = lexer(String(src || '').trim());
  if (lx.eof()) throw new PromQLError('Empty query. Example: sum by (status) (rate(http_requests_total[5m]))');
  const ast = parseAdd(lx);
  if (!lx.eof()) throw new PromQLError(`Unexpected text: ${lx.rest().slice(0, 30)}`);
  return ast;
}

const key = (labels) => JSON.stringify(Object.keys(labels).sort().map((k) => [k, labels[k]]));

/** Sums sample increments of a metric per label set, over events with from < ts <= to. */
function series(sel, data, from, to) {
  const def = METRICS[sel.name];
  const events = def.source === 'logs' ? data.logs : data.requests;
  const out = new Map();
  for (const ev of events) {
    if (ev.ts > to || ev.ts <= from) continue;
    for (const s of def.samples(ev)) {
      if (!sel.matchers.every((m) => m.test(s.labels[m.label]))) continue;
      const k = key(s.labels);
      const cur = out.get(k) || { metric: s.labels, value: 0 };
      cur.value += s.inc;
      out.set(k, cur);
    }
  }
  return [...out.values()];
}

function quantile(q, buckets) {
  const sorted = buckets.map((b) => ({ le: b.le === '+Inf' ? Infinity : Number(b.le), v: b.value })).sort((a, b) => a.le - b.le);
  const total = sorted.at(-1)?.v ?? 0;
  if (!total) return NaN;
  const rank = q * total;
  let prevLe = 0;
  let prevV = 0;
  for (const b of sorted) {
    if (b.v >= rank) {
      if (b.le === Infinity) return prevLe;
      return prevLe + ((b.le - prevLe) * (rank - prevV)) / Math.max(b.v - prevV, 1e-12);
    }
    prevLe = b.le;
    prevV = b.v;
  }
  return prevLe;
}

/** Evaluates at time t (ms). Returns a number (scalar) or an array of { metric, value }. */
export function evalPromQL(ast, data, t) {
  switch (ast.type) {
    case 'number':
      return ast.value;
    case 'selector':
      return series(ast, data, -Infinity, t).map((s) => ({ metric: { __name__: ast.name, ...s.metric }, value: s.value }));
    case 'func': {
      const list = series(ast.sel, data, t - ast.sel.range, t);
      const div = ast.fn === 'rate' ? ast.sel.range / 1000 : 1;
      return list.map((s) => ({ metric: s.metric, value: s.value / div }));
    }
    case 'agg': {
      const inner = evalPromQL(ast.inner, data, t);
      if (typeof inner === 'number') throw new PromQLError(`${ast.op}() needs a vector`);
      const groups = new Map();
      for (const s of inner) {
        const metric = ast.by ? Object.fromEntries(ast.by.map((l) => [l, s.metric[l] ?? ''])) : {};
        const k = key(metric);
        const g = groups.get(k) || { metric, values: [] };
        g.values.push(s.value);
        groups.set(k, g);
      }
      return [...groups.values()].map(({ metric, values: v }) => ({
        metric,
        value: { sum: v.reduce((a, b) => a + b, 0), avg: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v), count: v.length }[ast.op],
      }));
    }
    case 'hq': {
      const inner = evalPromQL(ast.inner, data, t);
      if (typeof inner === 'number') throw new PromQLError('histogram_quantile needs a vector with an "le" label');
      const groups = new Map();
      for (const s of inner) {
        if (s.metric.le === undefined) throw new PromQLError('histogram_quantile needs the "le" label. Use sum by (le) (rate(http_request_duration_seconds_bucket[5m]))');
        const { le, __name__, ...rest } = s.metric;
        const k = key(rest);
        const g = groups.get(k) || { metric: rest, buckets: [] };
        g.buckets.push({ le, value: s.value });
        groups.set(k, g);
      }
      return [...groups.values()].map((g) => ({ metric: g.metric, value: quantile(ast.q, g.buckets) })).filter((s) => !Number.isNaN(s.value));
    }
    case 'bin': {
      const l = evalPromQL(ast.left, data, t);
      const r = evalPromQL(ast.right, data, t);
      const f = { '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b }[ast.op];
      if (typeof l === 'number' && typeof r === 'number') return f(l, r);
      if (typeof l === 'number') return r.map((s) => ({ metric: strip(s.metric), value: f(l, s.value) }));
      if (typeof r === 'number') return l.map((s) => ({ metric: strip(s.metric), value: f(s.value, r) }));
      const right = new Map(r.map((s) => [key(strip(s.metric)), s.value]));
      return l
        .map((s) => ({ metric: strip(s.metric), value: right.has(key(strip(s.metric))) ? f(s.value, right.get(key(strip(s.metric)))) : undefined }))
        .filter((s) => s.value !== undefined && Number.isFinite(s.value));
    }
    default:
      throw new PromQLError('Unsupported expression');
  }
}

function strip(metric) {
  const { __name__, ...rest } = metric;
  return rest;
}
