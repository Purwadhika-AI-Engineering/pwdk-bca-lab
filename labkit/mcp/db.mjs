#!/usr/bin/env node
// MCP server for the labkit staging DB: the backend's H2 database over the Postgres protocol,
// with a read-only user. The SELECT check below is a convenience; the read-only user is the real guard.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, runStdio } from '../lib/mcp.mjs';
import { connect } from '../lib/pg.mjs';

const CONFIG = {
  host: process.env.LABKIT_DB_HOST || '127.0.0.1',
  port: Number(process.env.LABKIT_DB_PORT || 5435),
  user: process.env.LABKIT_DB_USER || 'labkit_ro',
  password: process.env.LABKIT_DB_PASSWORD || 'labkit-readonly',
  database: process.env.LABKIT_DB_NAME || 'banklab',
};
const MAX_ROWS = 200;

/** Allows one read-only statement. Returns the cleaned SQL or throws. */
export function checkSelect(sql) {
  const clean = String(sql || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;\s*$/, '');
  if (!clean) throw new Error('SQL is empty');
  const noStrings = clean.replace(/'(?:[^']|'')*'/g, "''");
  if (noStrings.includes(';')) throw new Error('One statement at a time');
  if (!/^(select|with|values|explain|table)\b/i.test(clean)) {
    throw new Error('Only SELECT queries are allowed: this is a read-only staging database');
  }
  if (/^with\b/i.test(clean) && /\b(insert|update|delete|merge)\b/i.test(noStrings)) {
    throw new Error('Only SELECT queries are allowed: this is a read-only staging database');
  }
  return clean;
}

let client = null;
async function getClient() {
  if (client && !client.closed) return client;
  try {
    client = await connect({ ...CONFIG, timeoutMs: 5000 });
    return client;
  } catch (err) {
    client = null;
    const why = err.code === 'ECONNREFUSED' || /ECONNREFUSED|Timed out/.test(err.message) ? 'nothing is listening there' : err.message;
    throw new Error(
      `Cannot reach the staging DB at ${CONFIG.host}:${CONFIG.port} (${why}). ` +
        'Start the backend with the labkit profile: cd backend, then mvnw.cmd spring-boot:run -Dspring-boot.run.profiles=labkit',
    );
  }
}

/** Closes the shared connection (tests, CLI). */
export async function close() {
  if (client) await client.end();
  client = null;
}

async function run(sql) {
  const c = await getClient();
  try {
    return await c.query(sql);
  } catch (err) {
    if (/closed/i.test(err.message)) client = null;
    throw new Error(err.code ? `${err.message.split('; SQL statement')[0]} (code ${err.code})` : err.message);
  }
}

export const tools = [
  {
    name: 'list_tables',
    description: 'List the tables in the staging DB that you can read, with row counts.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const r = await run("SELECT table_name FROM information_schema.tables WHERE table_schema = 'PUBLIC' ORDER BY table_name");
      const out = [];
      for (const { table_name: t } of r.rows) {
        const n = await run(`SELECT count(*) AS n FROM ${t}`);
        out.push({ table: t.toLowerCase(), rows: n.rows[0].n });
      }
      return out;
    },
  },
  {
    name: 'describe_table',
    description: 'Show the columns of a table: name, type, nullable.',
    inputSchema: { type: 'object', properties: { table: { type: 'string', description: 'For example accounts' } }, required: ['table'] },
    handler: async ({ table }) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table || '')) throw new Error('"table" must be a plain table name');
      const r = await run(
        `SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale, character_maximum_length FROM information_schema.columns ` +
          `WHERE table_schema = 'PUBLIC' AND table_name = '${table.toUpperCase()}' ORDER BY ordinal_position`,
      );
      if (!r.rows.length) throw new Error(`No table "${table}". Use list_tables.`);
      return r.rows.map((c) => ({
        column: c.column_name.toLowerCase(),
        type: c.data_type + (c.character_maximum_length ? `(${c.character_maximum_length})` : c.data_type === 'NUMERIC' ? `(${c.numeric_precision},${c.numeric_scale})` : ''),
        nullable: c.is_nullable === 'YES',
      }));
    },
  },
  {
    name: 'query',
    description: `Run one read-only SQL query (SELECT or WITH ... SELECT) on the staging DB (H2 in PostgreSQL mode). Returns up to ${MAX_ROWS} rows. Tables: accounts, transfers, external_accounts.`,
    inputSchema: { type: 'object', properties: { sql: { type: 'string', description: 'For example: SELECT * FROM transfers ORDER BY created_at DESC LIMIT 5' } }, required: ['sql'] },
    handler: async ({ sql }) => {
      const r = await run(checkSelect(sql));
      return { columns: r.fields, rowCount: r.rows.length, rows: r.rows.slice(0, MAX_ROWS), ...(r.rows.length > MAX_ROWS ? { note: `Showing the first ${MAX_ROWS} rows. Add LIMIT or a WHERE clause.` } : {}) };
    },
  },
];

export const server = createServer({
  name: 'labkit-db',
  version: '1.0.0',
  instructions: 'Read-only staging DB of Lab Bank (labkit). Tables: accounts, transfers, external_accounts.',
  tools,
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runStdio(server);
