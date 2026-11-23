// A small LogQL subset over in-memory log entries.
//
// Log queries:
//   {job="banklab-backend", level=~"warn|error"} |= "transfer" != "health" |~ "LIMIT|BALANCE" | json | status >= 400
// Metric queries:
//   count_over_time(<log query> [5m])      rate(<log query> [5m])
//   sum(count_over_time(...))              sum by (level) (rate(...))
//
// An entry is { ts (ms), labels: {..}, line: string, fields: {..} } where fields is the flattened JSON.

export class LogQLError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const DURATION = /^(\d+)(ms|s|m|h|d)$/;
export function parseDuration(text) {
  const m = DURATION.exec(text);
  if (!m) throw new LogQLError(`Bad duration "${text}". Use 30s, 5m, 1h or 1d.`);
  return Number(m[1]) * { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
}

/** Flattens nested JSON the way Loki's json parser does: {log:{level:"x"}} -> {log_level:"x"}. */
export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = (prefix ? `${prefix}_${k}` : k).replace(/[^A-Za-z0-9_]/g, '_');
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

function lexer(src) {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  return {
    get pos() {
      return i;
    },
    set pos(v) {
      i = v;
    },
    eof() {
      ws();
      return i >= src.length;
    },
    peek(s) {
      ws();
      return src.startsWith(s, i);
    },
    eat(s) {
      ws();
      if (src.startsWith(s, i)) {
        i += s.length;
        return true;
      }
      return false;
    },
    expect(s) {
      if (!this.eat(s)) throw new LogQLError(`Expected "${s}" at position ${i}: ${src.slice(i, i + 20) || '(end)'}`);
    },
    ident() {
      ws();
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
      if (!m) throw new LogQLError(`Expected a name at position ${i}: ${src.slice(i, i + 20) || '(end)'}`);
      i += m[0].length;
      return m[0];
    },
    string() {
      ws();
      const q = src[i];
      if (q === '`') {
        const end = src.indexOf('`', i + 1);
        if (end < 0) throw new LogQLError('Missing closing `');
        const s = src.slice(i + 1, end);
        i = end + 1;
        return s;
      }
      if (q !== '"' && q !== "'") throw new LogQLError(`Expected a quoted string at position ${i}: ${src.slice(i, i + 20) || '(end)'}`);
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== q) {
        if (src[j] === '\\' && j + 1 < src.length) {
          j++;
          s += src[j] === 'n' ? '\n' : src[j];
        } else s += src[j];
        j++;
      }
      if (j >= src.length) throw new LogQLError(`Missing closing ${q}`);
      i = j + 1;
      return s;
    },
    value() {
      ws();
      if (['"', "'", '`'].includes(src[i])) return this.string();
      const m = /^[^\s|)},]+/.exec(src.slice(i));
      if (!m) throw new LogQLError(`Expected a value at position ${i}`);
      i += m[0].length;
      return m[0];
    },
    rest() {
      return src.slice(i);
    },
  };
}

function regex(text) {
  try {
    return new RegExp(`^(?:${text})$`);
  } catch {
    throw new LogQLError(`Bad regular expression: ${text}`);
  }
}
function lineRegex(text) {
  try {
    return new RegExp(text);
  } catch {
    throw new LogQLError(`Bad regular expression: ${text}`);
  }
}

function parseMatcherOp(lx) {
  for (const op of ['=~', '!~', '!=', '=']) if (lx.eat(op)) return op;
  throw new LogQLError(`Expected =, !=, =~ or !~ at position ${lx.pos}`);
}

function matcher(name, op, value) {
  if (op === '=') return (v) => (v ?? '') === value;
  if (op === '!=') return (v) => (v ?? '') !== value;
  const re = regex(value);
  if (op === '=~') return (v) => re.test(v ?? '');
  return (v) => !re.test(v ?? '');
}

function parseSelector(lx) {
  lx.expect('{');
  const matchers = [];
  if (!lx.eat('}')) {
    do {
      const name = lx.ident();
      const op = parseMatcherOp(lx);
      const value = lx.string();
      matchers.push({ name, op, value, test: matcher(name, op, value) });
    } while (lx.eat(','));
    lx.expect('}');
  }
  if (!matchers.length) throw new LogQLError('A stream selector needs at least one matcher, for example {job="banklab-backend"}');
  if (matchers.every((m) => (m.op === '=~' || m.op === '!~') && regex(m.value).test(''))) {
    throw new LogQLError('A stream selector needs at least one matcher that does not match an empty value');
  }
  return matchers;
}

function labelFilter(name, op, raw) {
  const num = Number(raw);
  const numeric = ['>', '>=', '<', '<='].includes(op) || (op !== '=~' && op !== '!~' && raw !== '' && !Number.isNaN(num) && /^-?[\d.]+$/.test(raw));
  if (['>', '>=', '<', '<='].includes(op)) {
    if (Number.isNaN(num)) throw new LogQLError(`"${name} ${op} ${raw}" needs a number`);
    const cmp = { '>': (a) => a > num, '>=': (a) => a >= num, '<': (a) => a < num, '<=': (a) => a <= num }[op];
    return (v) => v !== undefined && v !== '' && cmp(Number(v));
  }
  if (op === '==') op = '=';
  if (numeric && (op === '=' || op === '!=')) {
    return op === '=' ? (v) => Number(v) === num || v === raw : (v) => !(Number(v) === num || v === raw);
  }
  return matcher(name, op, raw);
}

function parsePipeline(lx) {
  const stages = [];
  for (;;) {
    if (lx.eat('|=')) {
      const s = lx.string();
      stages.push({ kind: 'line', test: (l) => l.includes(s) });
    } else if (lx.eat('!=')) {
      const s = lx.string();
      stages.push({ kind: 'line', test: (l) => !l.includes(s) });
    } else if (lx.eat('|~')) {
      const re = lineRegex(lx.string());
      stages.push({ kind: 'line', test: (l) => re.test(l) });
    } else if (lx.eat('!~')) {
      const re = lineRegex(lx.string());
      stages.push({ kind: 'line', test: (l) => !re.test(l) });
    } else if (lx.peek('|') && !lx.peek('||')) {
      lx.eat('|');
      const name = lx.ident();
      if (name === 'json') {
        stages.push({ kind: 'json' });
        continue;
      }
      if (['logfmt', 'pattern', 'regexp', 'unpack', 'line_format', 'label_format', 'unwrap', 'drop', 'keep', 'decolorize'].includes(name)) {
        throw new LogQLError(`"| ${name}" is not supported in labkit. Supported: |= != |~ !~ | json | <field> <op> <value>`);
      }
      let op = null;
      for (const o of ['>=', '<=', '==', '=~', '!~', '!=', '=', '>', '<']) {
        if (lx.eat(o)) {
          op = o;
          break;
        }
      }
      if (!op) throw new LogQLError(`Expected an operator after "| ${name}"`);
      const value = lx.value();
      stages.push({ kind: 'label', name: name.replace(/\./g, '_'), test: labelFilter(name, op, value) });
      // "| a = 1 and b = 2" or "| a = 1, b = 2"
      while (lx.eat(',') || lx.eat('and ')) {
        const n2 = lx.ident();
        let op2 = null;
        for (const o of ['>=', '<=', '==', '=~', '!~', '!=', '=', '>', '<']) {
          if (lx.eat(o)) {
            op2 = o;
            break;
          }
        }
        if (!op2) throw new LogQLError(`Expected an operator after "${n2}"`);
        stages.push({ kind: 'label', name: n2.replace(/\./g, '_'), test: labelFilter(n2, op2, lx.value()) });
      }
    } else {
      return stages;
    }
  }
}

function parseLogQuery(lx) {
  const selector = parseSelector(lx);
  const pipeline = parsePipeline(lx);
  return { type: 'logs', selector, pipeline };
}

const RANGE_FUNCS = ['count_over_time', 'rate', 'bytes_over_time'];
const AGGS = ['sum', 'count', 'max', 'min', 'avg', 'topk'];

function parseMetric(lx) {
  const name = lx.ident();
  if (AGGS.includes(name)) {
    let by = null;
    let k = null;
    if (lx.eat('by')) {
      lx.expect('(');
      by = [];
      if (!lx.eat(')')) {
        do by.push(lx.ident());
        while (lx.eat(','));
        lx.expect(')');
      }
    }
    lx.expect('(');
    if (name === 'topk') {
      k = Number(lx.value());
      lx.expect(',');
    }
    const inner = parseExpr(lx);
    lx.expect(')');
    if (!by && lx.eat('by')) {
      lx.expect('(');
      by = [];
      if (!lx.eat(')')) {
        do by.push(lx.ident());
        while (lx.eat(','));
        lx.expect(')');
      }
    }
    return { type: 'agg', op: name, by, k, inner };
  }
  if (RANGE_FUNCS.includes(name)) {
    lx.expect('(');
    const q = parseLogQuery(lx);
    lx.expect('[');
    const dur = parseDuration(lx.value().replace(/\]$/, ''));
    lx.eat(']');
    lx.expect(')');
    return { type: 'range', fn: name, query: q, range: dur };
  }
  throw new LogQLError(`Function "${name}" is not supported. Use count_over_time, rate, sum, count, max, min, avg, topk.`);
}

function parseExpr(lx) {
  if (lx.peek('{')) return parseLogQuery(lx);
  return parseMetric(lx);
}

export function parseLogQL(src) {
  const lx = lexer(String(src || '').trim());
  if (lx.eof()) throw new LogQLError('Empty query. Example: {job="banklab-backend"} |= "error"');
  const ast = parseExpr(lx);
  if (!lx.eof()) throw new LogQLError(`Unexpected text: ${lx.rest().slice(0, 30)}`);
  return ast;
}

/** Runs the selector and pipeline. Returns matching entries with any extracted fields as labels. */
export function filterEntries(query, entries, { start, end } = {}) {
  const out = [];
  for (const e of entries) {
    if (start !== undefined && e.ts < start) continue;
    if (end !== undefined && e.ts > end) continue;
    if (!query.selector.every((m) => m.test(e.labels[m.name]))) continue;
    let labels = e.labels;
    let ok = true;
    for (const st of query.pipeline) {
      if (st.kind === 'line') ok = st.test(e.line);
      else if (st.kind === 'json') labels = { ...labels, ...e.fields };
      else ok = st.test(labels[st.name]);
      if (!ok) break;
    }
    if (ok) out.push({ ...e, labels, streamLabels: e.labels });
  }
  return out;
}

const key = (labels) => JSON.stringify(Object.keys(labels).sort().map((k) => [k, labels[k]]));

/**
 * Counts matching entries in (t - range, t]. Series are grouped by stream labels, or by the
 * given label names (which may be json fields), so one line never becomes one series.
 */
function evalRange(ast, entries, t, groupBy) {
  const hits = filterEntries(ast.query, entries, { start: t - ast.range + 1, end: t });
  const groups = new Map();
  for (const h of hits) {
    const metric = groupBy ? Object.fromEntries(groupBy.map((l) => [l, h.labels[l] ?? ''])) : h.streamLabels;
    const k = key(metric);
    const g = groups.get(k) || { metric, value: 0 };
    g.value += ast.fn === 'bytes_over_time' ? Buffer.byteLength(h.line) : 1;
    groups.set(k, g);
  }
  const scale = ast.fn === 'rate' ? 1000 / ast.range : 1;
  return [...groups.values()].map((g) => ({ metric: g.metric, value: g.value * scale }));
}

/** Evaluates a metric query at time t. Returns [{ metric: labels, value }]. */
export function evalMetric(ast, entries, t) {
  if (ast.type === 'range') return evalRange(ast, entries, t);
  if (ast.type === 'agg') {
    if (ast.op === 'sum' && ast.inner.type === 'range') return evalRange(ast.inner, entries, t, ast.by || []);
    const inner = evalMetric(ast.inner, entries, t);
    if (ast.op === 'topk') return inner.sort((a, b) => b.value - a.value).slice(0, ast.k);
    const groups = new Map();
    for (const s of inner) {
      const metric = ast.by ? Object.fromEntries(ast.by.map((l) => [l, s.metric[l] ?? ''])) : {};
      const k = key(metric);
      const g = groups.get(k) || { metric, values: [] };
      g.values.push(s.value);
      groups.set(k, g);
    }
    return [...groups.values()].map((g) => {
      const v = g.values;
      const value = { sum: v.reduce((a, b) => a + b, 0), count: v.length, max: Math.max(...v), min: Math.min(...v), avg: v.reduce((a, b) => a + b, 0) / v.length }[ast.op];
      return { metric: g.metric, value };
    });
  }
  throw new LogQLError('A log query has no value. Wrap it, for example count_over_time({job="banklab-backend"}[5m])');
}
