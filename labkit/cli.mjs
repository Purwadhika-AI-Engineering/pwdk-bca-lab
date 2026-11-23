#!/usr/bin/env node
// Labkit CLI: the fallback for every MCP tool. It runs the same tool code as the MCP servers.
//
//   node labkit/cli.mjs                                   list services
//   node labkit/cli.mjs atlassian                         list tools and their arguments
//   node labkit/cli.mjs atlassian getJiraIssue LB-1       positional args fill required arguments in order
//   node labkit/cli.mjs atlassian search --jql "project = LB"
//   node labkit/cli.mjs atlassian comment LB-1 --commentBody-file note.md
//   node labkit/cli.mjs atlassian transition LB-1 --transition.id 21
//   node labkit/cli.mjs status | reset
//
// Options: --name value, --name=value, --a.b value (nested object), --name-file path (read the value
// from a file: handy on Windows, where quoting is hard), --json (raw JSON output).

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SERVICES = {
  atlassian: {
    file: 'mcp/atlassian.mjs',
    about: 'Jira + Confluence mock',
    aliases: {
      search: 'searchJiraIssuesUsingJql',
      jql: 'searchJiraIssuesUsingJql',
      issue: 'getJiraIssue',
      get: 'getJiraIssue',
      create: 'createJiraIssue',
      edit: 'editJiraIssue',
      comment: 'addCommentToJiraIssue',
      transitions: 'getTransitionsForJiraIssue',
      transition: 'transitionJiraIssue',
      users: 'lookupJiraAccountId',
      projects: 'getVisibleJiraProjects',
      spaces: 'getConfluenceSpaces',
      pages: 'getPagesInConfluenceSpace',
      cql: 'searchConfluenceUsingCql',
      page: 'getConfluencePage',
      'create-page': 'createConfluencePage',
      'update-page': 'updateConfluencePage',
    },
  },
  grafana: {
    file: 'mcp/grafana.mjs',
    about: 'logs and metrics from the backend',
    aliases: { logs: 'query_loki_logs', labels: 'list_loki_label_names', values: 'list_loki_label_values', metrics: 'query_prometheus' },
  },
  db: {
    file: 'mcp/db.mjs',
    about: 'read-only staging DB',
    aliases: { tables: 'list_tables', describe: 'describe_table', sql: 'query' },
  },
};

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function resolveTool(tools, aliases, name) {
  const want = aliases[name] || name;
  return (
    tools.find((t) => t.name === want) ||
    tools.find((t) => t.name.toLowerCase() === want.toLowerCase()) ||
    tools.find((t) => t.name.toLowerCase() === camel(want).toLowerCase()) ||
    tools.find((t) => t.name.toLowerCase() === want.replace(/-/g, '_').toLowerCase())
  );
}

function coerce(value, prop) {
  const type = prop?.type;
  if (type === 'number') {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`Expected a number, got "${value}"`);
    return n;
  }
  if (type === 'boolean') return value === true || value === 'true' || value === '1';
  if (type === 'array') {
    if (Array.isArray(value)) return value;
    const s = String(value).trim();
    return s.startsWith('[') ? JSON.parse(s) : s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (type === 'object' && typeof value === 'string') {
    const s = value.trim();
    if (s.startsWith('{')) return JSON.parse(s);
    return s;
  }
  return value;
}

function setPath(obj, keys, value) {
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof o[k] !== 'object' || o[k] === null) o[k] = {};
    o = o[k];
  }
  o[keys.at(-1)] = value;
}

/** Turns argv after the tool name into tool arguments, using the tool's input schema. */
export function parseArgs(argv, schema = {}, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const props = schema.properties || {};
  const required = (schema.required || []).filter((r) => r !== 'cloudId');
  const args = {};
  const positional = [];
  const flags = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      flags.json = true;
      continue;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    let [key, value] = a.slice(2).split(/=(.*)/s, 2);
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) value = 'true';
      else value = argv[++i];
    }
    if (key.endsWith('-file')) {
      key = key.slice(0, -5);
      value = readFile(value);
    }
    const keys = key.split('.');
    const top = props[keys[0]] ? keys[0] : camel(keys[0]);
    keys[0] = top;
    if (keys.length > 1) setPath(args, keys, value);
    else args[top] = coerce(value, props[top]);
  }
  const free = required.filter((r) => args[r] === undefined);
  positional.forEach((v, i) => {
    const key = free[i];
    if (!key) throw new Error(`Too many positional arguments: "${v}"`);
    args[key] = key === 'transition' ? { id: String(v) } : coerce(v, props[key]);
  });
  return { args, flags };
}

async function loadTools(service) {
  const mod = await import(pathToFileURL(path.join(HERE, SERVICES[service].file)).href);
  return mod.tools;
}

function usageFor(service, tools) {
  const s = SERVICES[service];
  const alias = Object.fromEntries(Object.entries(s.aliases).map(([a, t]) => [t, a]));
  const lines = [`labkit ${service}: ${s.about}`, '', `Usage: node labkit/cli.mjs ${service} <tool> [args]`, ''];
  for (const t of tools) {
    const props = Object.entries(t.inputSchema?.properties || {}).filter(([k]) => k !== 'cloudId');
    const req = new Set(t.inputSchema?.required || []);
    const params = props.map(([k]) => (req.has(k) ? `--${k}` : `[--${k}]`)).join(' ');
    lines.push(`  ${t.name}${alias[t.name] ? ` (${alias[t.name]})` : ''} ${params}`);
    lines.push(`      ${t.description}`);
  }
  return lines.join('\n');
}

async function status() {
  const checks = [
    ['hub', 'http://127.0.0.1:4300/health'],
    ['atlassian', 'http://127.0.0.1:4310/health'],
    ['grafana', 'http://127.0.0.1:4330/health'],
  ];
  for (const [name, url] of checks) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      console.log(`${name.padEnd(10)} up (HTTP ${res.status})`);
    } catch {
      console.log(`${name.padEnd(10)} DOWN  ${url}`);
    }
  }
  // TCP only for the backend: an HTTP probe would show up in its logs.
  const backendUp = await new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: 8080 });
    s.setTimeout(1500, () => (s.destroy(), resolve(false)));
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
  console.log(`backend    ${backendUp ? 'up (127.0.0.1:8080)' : 'DOWN  start it with labkit\\backend.cmd'}`);
  const { tools } = await import(pathToFileURL(path.join(HERE, SERVICES.db.file)).href).catch(() => ({ tools: null }));
  if (tools) {
    try {
      await resolveTool(tools, {}, 'list_tables').handler({});
      console.log('db         up (127.0.0.1:5435)');
      await (await import(pathToFileURL(path.join(HERE, SERVICES.db.file)).href)).close();
    } catch (err) {
      console.log(`db         DOWN  ${err.message.split('\n')[0]}`);
    }
  }
}

async function reset() {
  const res = await fetch('http://127.0.0.1:4310/admin/reset', { method: 'POST' }).catch((err) => ({ ok: false, statusText: err.message }));
  console.log(res.ok ? 'Atlassian mock: seed data restored.' : `Atlassian mock: reset failed (${res.statusText}). Is labkit running?`);
  return res.ok;
}

/** Prints the Kiro MCP config, or writes it with --write. --absolute uses full paths (fallback for Windows); --remote uses URLs + token. */
async function kiroConfig(args) {
  const { mcpConfig, ROOT } = await import(pathToFileURL(path.join(HERE, 'services', 'hub', 'server.mjs')).href);
  const absolute = args.includes('--absolute');
  const remote = args.includes('--remote');
  const token = remote ? (await import(pathToFileURL(path.join(HERE, 'lib', 'token.mjs')).href)).getToken() : undefined;
  const text = JSON.stringify(mcpConfig({ absolute, remote, token, node: absolute ? process.execPath : 'node' }), null, 2) + '\n';
  if (!args.includes('--write')) {
    process.stdout.write(text);
    return 0;
  }
  const file = path.join(ROOT, '.kiro', 'settings', 'mcp.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`Wrote ${file}. Reload the MCP servers in Kiro.`);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const [service, toolName, ...rest] = argv;
  if (!service || service === 'help' || service === '--help') {
    console.log('Labkit CLI (fallback for the MCP tools)\n');
    for (const [name, s] of Object.entries(SERVICES)) console.log(`  node labkit/cli.mjs ${name.padEnd(10)} ${s.about}`);
    console.log('  node labkit/cli.mjs status     check what is running');
    console.log('  node labkit/cli.mjs reset      restore the Jira + Confluence seed data');
    console.log('  node labkit/cli.mjs kiro-config [--absolute|--remote] [--write]   print or write .kiro/settings/mcp.json');
    return 0;
  }
  if (service === 'status') return status().then(() => 0);
  if (service === 'reset') return (await reset()) ? 0 : 1;
  if (service === 'kiro-config') return kiroConfig(argv.slice(1));
  if (!SERVICES[service]) {
    console.error(`Unknown service "${service}". Use one of: ${Object.keys(SERVICES).join(', ')}, status, reset`);
    return 2;
  }
  const tools = await loadTools(service);
  if (!toolName || toolName === 'help' || toolName === '--help') {
    console.log(usageFor(service, tools));
    return 0;
  }
  const tool = resolveTool(tools, SERVICES[service].aliases, toolName);
  if (!tool) {
    console.error(`Unknown tool "${toolName}". Run: node labkit/cli.mjs ${service}`);
    return 2;
  }
  try {
    const { args, flags } = parseArgs(rest, tool.inputSchema);
    const result = await tool.handler(args);
    if (service === 'db') await (await import(pathToFileURL(path.join(HERE, SERVICES.db.file)).href)).close();
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, flags.json ? 0 : 2));
    return 0;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => (process.exitCode = code));
}
