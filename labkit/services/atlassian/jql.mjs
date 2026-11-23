// A small JQL subset, compiled to a SQLite WHERE clause with parameters.
// The parser is shared with CQL (cql.mjs).
//
// Grammar:
//   query  := [expr] [ORDER BY field [ASC|DESC] {, field [ASC|DESC]}]
//   expr   := and {OR and}
//   and    := not {AND not}
//   not    := NOT not | '(' expr ')' | clause
//   clause := field op value
//   op     := = | != | ~ | !~ | > | >= | < | <= | IN | NOT IN | IS | IS NOT
//   value  := "string" | 'string' | word | number | EMPTY | NULL | func() | '(' value {, value} ')'

export class QueryError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'IN', 'IS', 'ORDER', 'BY', 'ASC', 'DESC', 'EMPTY', 'NULL']);

export function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== c) {
        if (input[j] === '\\' && j + 1 < input.length) j++;
        value += input[j++];
      }
      if (j >= input.length) throw new QueryError(`Missing closing quote ${c} at position ${i}`);
      tokens.push({ type: 'string', value });
      i = j + 1;
    } else if ('(),'.includes(c)) {
      tokens.push({ type: c });
      i++;
    } else if (input.startsWith('!=', i) || input.startsWith('!~', i) || input.startsWith('>=', i) || input.startsWith('<=', i)) {
      tokens.push({ type: 'op', value: input.slice(i, i + 2) });
      i += 2;
    } else if ('=~<>'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
    } else {
      let j = i;
      while (j < input.length && !/[\s(),=!~<>"']/.test(input[j])) j++;
      if (j === i) throw new QueryError(`Unexpected character "${c}" at position ${i}`);
      const word = input.slice(i, j);
      const upper = word.toUpperCase();
      tokens.push(KEYWORDS.has(upper) ? { type: 'kw', value: upper } : { type: 'word', value: word });
      i = j;
    }
  }
  return tokens;
}

export function parse(input) {
  const tokens = tokenize(input || '');
  let pos = 0;
  const peek = () => tokens[pos];
  const isKw = (kw) => peek()?.type === 'kw' && peek().value === kw;
  const expect = (type, what) => {
    const t = tokens[pos];
    if (!t || t.type !== type) throw new QueryError(`Expected ${what} ${t ? `but found "${t.value ?? t.type}"` : 'at the end'}`);
    pos++;
    return t;
  };

  function value() {
    const t = peek();
    if (!t) throw new QueryError('Expected a value at the end');
    if (t.type === 'string') {
      pos++;
      return { kind: 'text', value: t.value };
    }
    if (t.type === 'kw' && (t.value === 'EMPTY' || t.value === 'NULL')) {
      pos++;
      return { kind: 'empty' };
    }
    if (t.type === 'word') {
      pos++;
      if (peek()?.type === '(') {
        pos++;
        expect(')', '")" after a function name');
        return { kind: 'func', name: t.value };
      }
      return { kind: 'text', value: t.value };
    }
    throw new QueryError(`Expected a value but found "${t.value ?? t.type}"`);
  }

  function clause() {
    const fieldTok = peek();
    if (!fieldTok || (fieldTok.type !== 'word' && fieldTok.type !== 'string')) {
      throw new QueryError(`Expected a field name ${fieldTok ? `but found "${fieldTok.value ?? fieldTok.type}"` : 'at the end'}`);
    }
    pos++;
    const field = fieldTok.value.toLowerCase();
    let op;
    if (peek()?.type === 'op') {
      op = tokens[pos++].value;
    } else if (isKw('IN')) {
      pos++;
      op = 'IN';
    } else if (isKw('NOT') && tokens[pos + 1]?.type === 'kw' && tokens[pos + 1].value === 'IN') {
      pos += 2;
      op = 'NOT IN';
    } else if (isKw('IS')) {
      pos++;
      if (isKw('NOT')) {
        pos++;
        op = 'IS NOT';
      } else {
        op = 'IS';
      }
    } else {
      throw new QueryError(`Expected an operator after "${fieldTok.value}"`);
    }
    let values;
    if (op === 'IN' || op === 'NOT IN') {
      expect('(', '"(" after IN');
      values = [value()];
      while (peek()?.type === ',') {
        pos++;
        values.push(value());
      }
      expect(')', '")" to close the IN list');
    } else {
      values = [value()];
    }
    return { type: 'clause', field, op, values };
  }

  function not() {
    if (isKw('NOT')) {
      pos++;
      return { type: 'not', expr: not() };
    }
    if (peek()?.type === '(') {
      pos++;
      const e = expr();
      expect(')', '")"');
      return e;
    }
    return clause();
  }

  function and() {
    let left = not();
    while (isKw('AND')) {
      pos++;
      left = { type: 'and', left, right: not() };
    }
    return left;
  }

  function expr() {
    let left = and();
    while (isKw('OR')) {
      pos++;
      left = { type: 'or', left, right: and() };
    }
    return left;
  }

  let where = null;
  if (peek() && !isKw('ORDER')) where = expr();
  const order = [];
  if (isKw('ORDER')) {
    pos++;
    if (!isKw('BY')) throw new QueryError('Expected BY after ORDER');
    pos++;
    do {
      if (peek()?.type === ',') pos++;
      const f = peek();
      if (!f || (f.type !== 'word' && f.type !== 'string')) throw new QueryError('Expected a field after ORDER BY');
      pos++;
      let dir = 'ASC';
      if (isKw('ASC') || isKw('DESC')) dir = tokens[pos++].value;
      order.push({ field: f.value.toLowerCase(), dir });
    } while (peek()?.type === ',');
  }
  if (pos < tokens.length) {
    const t = tokens[pos];
    throw new QueryError(`Unexpected "${t.value ?? t.type}". Join clauses with AND or OR.`);
  }
  return { where, order };
}

/**
 * Compiles an AST with a field map. Each field handler gets (op, values, ctx)
 * and returns { sql, params }.
 */
export function compileWhere(node, fields, ctx, aliases = {}) {
  if (!node) return { sql: '1=1', params: [] };
  if (node.type === 'and' || node.type === 'or') {
    const l = compileWhere(node.left, fields, ctx, aliases);
    const r = compileWhere(node.right, fields, ctx, aliases);
    return { sql: `(${l.sql} ${node.type.toUpperCase()} ${r.sql})`, params: [...l.params, ...r.params] };
  }
  if (node.type === 'not') {
    const e = compileWhere(node.expr, fields, ctx, aliases);
    return { sql: `(NOT ${e.sql})`, params: e.params };
  }
  const name = aliases[node.field] || node.field;
  const handler = fields[name];
  if (!handler) {
    throw new QueryError(`Field "${node.field}" is not supported here. Use one of: ${Object.keys(fields).join(', ')}`);
  }
  return handler(node.op, node.values, ctx);
}

// ---------- helpers for field handlers ----------

export function textValues(values, ctx, field) {
  return values.map((v) => {
    if (v.kind === 'text') return v.value;
    if (v.kind === 'func' && v.name.toLowerCase() === 'currentuser' && ctx?.currentUser) return ctx.currentUser;
    if (v.kind === 'func') throw new QueryError(`Function ${v.name}() is not supported for ${field}`);
    throw new QueryError(`EMPTY is only allowed with IS or IS NOT (field ${field})`);
  });
}

/** Equality-style field on a plain column, case-insensitive. */
export function columnField(column, { lower = true } = {}) {
  const col = lower ? `lower(${column})` : column;
  const val = lower ? 'lower(?)' : '?';
  return (op, values, ctx) => {
    if (op === 'IS' || op === 'IS NOT') {
      if (values[0].kind !== 'empty') throw new QueryError('Use IS EMPTY or IS NOT EMPTY');
      return { sql: op === 'IS' ? `(${column} IS NULL OR ${column} = '')` : `(${column} IS NOT NULL AND ${column} <> '')`, params: [] };
    }
    const vals = textValues(values, ctx, column);
    switch (op) {
      case '=':
        return { sql: `${col} = ${val}`, params: vals };
      case '!=':
        return { sql: `(${column} IS NULL OR ${col} <> ${val})`, params: vals };
      case 'IN':
        return { sql: `${col} IN (${vals.map(() => val).join(', ')})`, params: vals };
      case 'NOT IN':
        return { sql: `(${column} IS NULL OR ${col} NOT IN (${vals.map(() => val).join(', ')}))`, params: vals };
      case '~':
      case '!~':
        return containsAll([column], op, vals[0]);
      default:
        throw new QueryError(`Operator ${op} is not supported for this field`);
    }
  };
}

/** "~" search: every word must appear in at least one of the columns (case-insensitive). */
export function containsAll(columns, op, text) {
  const words = String(text)
    .replace(/[*?]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) throw new QueryError('Search text is empty');
  const parts = [];
  const params = [];
  for (const w of words) {
    parts.push(`(${columns.map((c) => `instr(lower(coalesce(${c}, '')), lower(?)) > 0`).join(' OR ')})`);
    columns.forEach(() => params.push(w));
  }
  const sql = `(${parts.join(' AND ')})`;
  return { sql: op === '!~' ? `(NOT ${sql})` : sql, params };
}

export function dateField(column) {
  return (op, values, ctx) => {
    if (!['=', '!=', '>', '>=', '<', '<='].includes(op)) throw new QueryError(`Operator ${op} is not supported for dates`);
    const [raw] = textValues(values, ctx, column);
    return { sql: `${column} ${op === '=' ? '=' : op === '!=' ? '<>' : op} ?`, params: [toIso(raw, ctx?.now)] };
  };
}

/** Accepts 2026-11-20, 2026-11-20 10:00, or relative -7d / -12h / -30m. */
export function toIso(raw, now = new Date()) {
  const rel = /^([-+]?)(\d+)([dhmw])$/i.exec(raw);
  if (rel) {
    const ms = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[rel[3].toLowerCase()];
    const sign = rel[1] === '+' ? 1 : -1;
    return new Date(now.getTime() + sign * Number(rel[2]) * ms).toISOString();
  }
  const d = new Date(raw.includes('T') || raw.length <= 10 ? raw : raw.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) throw new QueryError(`Not a date: "${raw}". Use 2026-11-20 or -7d.`);
  return d.toISOString();
}

// ---------- JQL for issues ----------

const PRIORITY_RANK = `CASE lower(i.priority) WHEN 'highest' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 WHEN 'lowest' THEN 1 ELSE 0 END`;

function userField(column) {
  return (op, values, ctx) => {
    if (op === 'IS' || op === 'IS NOT') {
      if (values[0].kind !== 'empty') throw new QueryError('Use IS EMPTY or IS NOT EMPTY');
      return { sql: `${column} IS ${op === 'IS' ? '' : 'NOT '}NULL`, params: [] };
    }
    const vals = textValues(values, ctx, column);
    const one = `(SELECT account_id FROM users WHERE lower(display_name) = lower(?) OR lower(account_id) = lower(?))`;
    const params = vals.flatMap((v) => [v, v]);
    switch (op) {
      case '=':
        return { sql: `${column} IN ${one}`, params };
      case '!=':
        return { sql: `(${column} IS NULL OR ${column} NOT IN ${one})`, params };
      case 'IN':
      case 'NOT IN': {
        const sub = `(SELECT account_id FROM users WHERE ${vals.map(() => '(lower(display_name) = lower(?) OR lower(account_id) = lower(?))').join(' OR ')})`;
        return op === 'IN' ? { sql: `${column} IN ${sub}`, params } : { sql: `(${column} IS NULL OR ${column} NOT IN ${sub})`, params };
      }
      case '~':
        return { sql: `${column} IN (SELECT account_id FROM users WHERE instr(lower(display_name), lower(?)) > 0)`, params: [vals[0]] };
      default:
        throw new QueryError(`Operator ${op} is not supported for ${column}`);
    }
  };
}

function labelsField(op, values, ctx) {
  const has = `EXISTS (SELECT 1 FROM json_each(i.labels) WHERE lower(json_each.value) = lower(?))`;
  if (op === 'IS' || op === 'IS NOT') {
    if (values[0].kind !== 'empty') throw new QueryError('Use IS EMPTY or IS NOT EMPTY');
    return { sql: `json_array_length(i.labels) ${op === 'IS' ? '=' : '>'} 0`, params: [] };
  }
  const vals = textValues(values, ctx, 'labels');
  switch (op) {
    case '=':
      return { sql: has, params: vals };
    case '!=':
      return { sql: `NOT ${has}`, params: vals };
    case 'IN':
      return { sql: `(${vals.map(() => has).join(' OR ')})`, params: vals };
    case 'NOT IN':
      return { sql: `NOT (${vals.map(() => has).join(' OR ')})`, params: vals };
    default:
      throw new QueryError(`Operator ${op} is not supported for labels`);
  }
}

function textField(op, values, ctx) {
  if (op !== '~' && op !== '!~') throw new QueryError('Use text ~ "words" or text !~ "words"');
  const [t] = textValues(values, ctx, 'text');
  return containsAll(['i.summary', 'i.description', '(SELECT group_concat(body, \' \') FROM comments c WHERE c.issue_key = i.key)'], op, t);
}

export const JQL_FIELDS = {
  project: columnField('i.project'),
  key: columnField('i.key'),
  status: columnField('i.status'),
  priority: columnField('i.priority'),
  issuetype: columnField('i.type'),
  assignee: userField('i.assignee'),
  reporter: userField('i.reporter'),
  labels: labelsField,
  text: textField,
  summary: (op, values, ctx) => {
    if (op !== '~' && op !== '!~') return columnField('i.summary')(op, values, ctx);
    return containsAll(['i.summary'], op, textValues(values, ctx, 'summary')[0]);
  },
  description: (op, values, ctx) => containsAll(['i.description'], op, textValues(values, ctx, 'description')[0]),
  created: dateField('i.created'),
  updated: dateField('i.updated'),
};

const JQL_ALIASES = { type: 'issuetype', label: 'labels', issue: 'key', issuekey: 'key', createddate: 'created', updateddate: 'updated' };

const JQL_ORDER = {
  created: 'i.created',
  updated: 'i.updated',
  priority: PRIORITY_RANK,
  key: 'i.id',
  status: 'i.status',
  summary: 'i.summary',
  assignee: 'i.assignee',
};

export function compileJql(jql, ctx = {}) {
  const ast = parse(jql);
  const where = compileWhere(ast.where, JQL_FIELDS, ctx, JQL_ALIASES);
  const order = ast.order.length
    ? ast.order.map((o) => {
        const col = JQL_ORDER[JQL_ALIASES[o.field] || o.field];
        if (!col) throw new QueryError(`Cannot ORDER BY "${o.field}". Use one of: ${Object.keys(JQL_ORDER).join(', ')}`);
        return `${col} ${o.dir}`;
      })
    : ['i.id DESC'];
  return { where: where.sql, params: where.params, orderBy: order.join(', ') };
}
