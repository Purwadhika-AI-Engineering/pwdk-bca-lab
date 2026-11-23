// A small CQL subset for Confluence pages: space, title, text, type, dates.
import { parse, compileWhere, columnField, containsAll, dateField, textValues, QueryError } from './jql.mjs';

export const CQL_FIELDS = {
  space: (op, values, ctx) => {
    // space = LB or space = "Lab Bank": match the key or the name
    const vals = textValues(values, ctx, 'space');
    const one = '(SELECT key FROM spaces WHERE lower(key) = lower(?) OR lower(name) = lower(?) OR id = ?)';
    const params = vals.flatMap((v) => [v, v, v]);
    if (op === '=') return { sql: `p.space_key IN ${one}`, params };
    if (op === '!=') return { sql: `p.space_key NOT IN ${one}`, params };
    if (op === 'IN' || op === 'NOT IN') {
      const sub = `(SELECT key FROM spaces WHERE ${vals.map(() => '(lower(key) = lower(?) OR lower(name) = lower(?) OR id = ?)').join(' OR ')})`;
      return { sql: `p.space_key ${op} ${sub}`, params };
    }
    throw new QueryError(`Operator ${op} is not supported for space`);
  },
  title: (op, values, ctx) => {
    if (op === '~' || op === '!~') return containsAll(['p.title'], op, textValues(values, ctx, 'title')[0]);
    return columnField('p.title')(op, values, ctx);
  },
  text: (op, values, ctx) => {
    if (op !== '~' && op !== '!~') throw new QueryError('Use text ~ "words"');
    return containsAll(['p.title', 'p.body'], op, textValues(values, ctx, 'text')[0]);
  },
  type: (op, values, ctx) => {
    const vals = textValues(values, ctx, 'type').map((v) => v.toLowerCase());
    const ok = vals.every((v) => v === 'page');
    if (op === '=' || op === 'IN') return { sql: ok ? '1=1' : '1=0', params: [] };
    if (op === '!=' || op === 'NOT IN') return { sql: ok ? '1=0' : '1=1', params: [] };
    throw new QueryError(`Operator ${op} is not supported for type`);
  },
  id: columnField('p.id', { lower: false }),
  parent: columnField('p.parent_id', { lower: false }),
  created: dateField('p.created'),
  lastmodified: dateField('p.updated'),
};

const CQL_ALIASES = { 'space.key': 'space', 'space.title': 'space', 'content.id': 'id', ancestor: 'parent', lastupdated: 'lastmodified' };

const CQL_ORDER = { title: 'p.title', created: 'p.created', lastmodified: 'p.updated', id: 'p.id' };

export function compileCql(cql, ctx = {}) {
  const ast = parse(cql);
  const where = compileWhere(ast.where, CQL_FIELDS, ctx, CQL_ALIASES);
  const order = ast.order.length
    ? ast.order.map((o) => {
        const col = CQL_ORDER[CQL_ALIASES[o.field] || o.field];
        if (!col) throw new QueryError(`Cannot ORDER BY "${o.field}". Use one of: ${Object.keys(CQL_ORDER).join(', ')}`);
        return `${col} ${o.dir}`;
      })
    : ['p.updated DESC'];
  return { where: where.sql, params: where.params, orderBy: order.join(', ') };
}
