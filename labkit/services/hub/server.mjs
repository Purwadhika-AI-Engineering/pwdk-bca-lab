#!/usr/bin/env node
// Labkit hub on 127.0.0.1:4300: links, health of every part, reset, traffic, and the Kiro MCP config.

import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRouter, listen, HttpError } from '../../lib/http.mjs';
import { mountHttp } from '../../lib/mcp.mjs';
import { REMOTE } from '../../lib/token.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LABKIT = path.resolve(HERE, '..', '..');
export const ROOT = path.resolve(LABKIT, '..');
export const DEFAULT_PORT = 4300;

export const PARTS = [
  { id: 'atlassian', name: 'Jira + Confluence', url: 'http://127.0.0.1:4310/', health: 'http://127.0.0.1:4310/health', how: 'labkit\\start.cmd' },
  { id: 'grafana', name: 'Grafana (logs, metrics)', url: 'http://127.0.0.1:4330/', health: 'http://127.0.0.1:4330/health', how: 'labkit\\start.cmd' },
  // TCP only: an HTTP probe would add request lines (and errors) to the backend logs.
  { id: 'backend', name: 'Backend API', url: null, tcp: 8080, how: 'labkit\\backend.cmd' },
  { id: 'db', name: 'Staging DB (read-only)', url: null, tcp: 5435, how: 'labkit\\backend.cmd (labkit profile)' },
  { id: 'frontend', name: 'Web app', url: 'http://127.0.0.1:4200/', tcp: 4200, how: 'cd frontend, npm start' },
];

/** True if something accepts connections on the port. Tries IPv4, then IPv6 (ng serve may bind ::1 only). */
async function tcpUp(port) {
  return (await tcpUpOn('127.0.0.1', port)) || tcpUpOn('::1', port);
}

function tcpUpOn(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(800, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function check(part) {
  if (part.tcp) return { ...part, up: await tcpUp(part.tcp) };
  try {
    const res = await fetch(part.health, { signal: AbortSignal.timeout(1500) });
    return { ...part, up: true, status: res.status, info: part.id === 'grafana' ? await res.json().catch(() => null) : undefined };
  } catch {
    return { ...part, up: false };
  }
}

/**
 * The Kiro MCP config.
 * - local (default): Kiro starts each server with node over stdio. absolute=true writes full paths.
 * - remote: each server is a URL with a Bearer token, like a hosted MCP server.
 */
export function mcpConfig({ absolute = false, root = ROOT, node = 'node', remote = false, token = '<your labkit API token>' } = {}) {
  const file = (name) => (absolute ? path.join(root, 'labkit', 'mcp', name) : `labkit/mcp/${name}`);
  const entry = (name, autoApprove) => {
    if (!remote) return { command: node, args: [file(name)], env: {}, disabled: false, autoApprove };
    const id = Object.keys(REMOTE).find((k) => REMOTE[k].file === name);
    return { url: REMOTE[id].url, headers: { Authorization: `Bearer ${token}` }, disabled: false, autoApprove };
  };
  return {
    mcpServers: {
      'labkit-ping': entry('ping.mjs', ['ping']),
      'labkit-atlassian': entry('atlassian.mjs', ['getAccessibleAtlassianResources', 'atlassianUserInfo', 'lookupJiraAccountId', 'getVisibleJiraProjects', 'searchJiraIssuesUsingJql', 'getJiraIssue', 'getTransitionsForJiraIssue', 'getConfluenceSpaces', 'getPagesInConfluenceSpace', 'searchConfluenceUsingCql', 'getConfluencePage']),
      'labkit-grafana': entry('grafana.mjs', ['list_datasources', 'query_loki_logs', 'list_loki_label_names', 'list_loki_label_values', 'list_prometheus_metric_names', 'query_prometheus']),
      'labkit-db': entry('db.mjs', ['list_tables', 'describe_table']),
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--browser', 'chrome'], env: {}, disabled: true, autoApprove: [] },
    },
  };
}

let trafficRun = null;

/** mcp: { db, ping, token } mounts the simulated remote MCP endpoints /mcp/db and /mcp/ping. */
export function createApp({ mcp } = {}) {
  const r = createRouter();
  if (mcp) {
    mountHttp(r, '/mcp/db', mcp.db, { token: mcp.token });
    mountHttp(r, '/mcp/ping', mcp.ping, { token: mcp.token });
  }
  r.get('/health', () => ({ ok: true, service: 'hub' }));
  r.get('/api/status', async () => ({ parts: await Promise.all(PARTS.map(check)), time: new Date().toISOString() }));
  r.post('/api/reset', async () => {
    const res = await fetch('http://127.0.0.1:4310/admin/reset', { method: 'POST' }).catch(() => null);
    if (!res?.ok) throw new HttpError(502, 'The Atlassian mock is not running. Start labkit\\start.cmd first.');
    return { ok: true, message: 'Jira and Confluence seed data restored.' };
  });
  r.post('/api/clear-logs', async () => {
    const res = await fetch('http://127.0.0.1:4330/admin/reset', { method: 'POST' }).catch(() => null);
    if (!res?.ok) throw new HttpError(502, 'The Grafana mock is not running.');
    return { ok: true, message: 'Grafana now shows only new log lines.' };
  });
  r.post('/api/traffic', () => {
    if (trafficRun?.running) throw new HttpError(409, 'Traffic is already running');
    trafficRun = { running: true, output: '', code: null, started: new Date().toISOString() };
    const run = trafficRun;
    const child = spawn(process.execPath, [path.join(LABKIT, 'traffic.mjs')], { cwd: ROOT, windowsHide: true });
    child.stdout.on('data', (d) => (run.output += d));
    child.stderr.on('data', (d) => (run.output += d));
    child.on('close', (code) => Object.assign(run, { running: false, code }));
    return { ok: true };
  });
  r.get('/api/traffic', () => trafficRun || { running: false, output: '', code: null });
  r.get('/api/mcp-config', ({ query }) =>
    query.mode === 'remote'
      ? mcpConfig({ remote: true, token: mcp?.token })
      : mcpConfig({ absolute: query.absolute === '1' || query.absolute === 'true', node: query.absolute ? process.execPath : 'node' }),
  );
  // The token is only for this laptop: refuse requests that come in under another host name (DNS rebinding).
  r.get('/api/remote-mcp', ({ req }) => {
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || '')) throw new HttpError(403, 'Forbidden');
    return { token: mcp?.token || null, servers: Object.entries(REMOTE).map(([name, v]) => ({ name, url: v.url })) };
  });
  r.get('/api/events', async () => {
    const res = await fetch('http://127.0.0.1:4310/admin/events').catch(() => null);
    return res?.ok ? res.json() : { events: [] };
  });
  r.static('/', path.join(HERE, 'ui'));
  return r;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const port = Number(i > 0 ? process.argv[i + 1] : process.env.LABKIT_HUB_PORT || DEFAULT_PORT);
  const { getToken } = await import('../../lib/token.mjs');
  const { server: db } = await import('../../mcp/db.mjs');
  const { server: ping } = await import('../../mcp/ping.mjs');
  const server = await listen(createApp({ mcp: { db, ping, token: getToken() } }), port);
  console.log(`[hub] http://127.0.0.1:${server.address().port}`);
}
