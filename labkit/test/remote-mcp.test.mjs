import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, listen } from '../lib/http.mjs';
import { createServer, mountHttp, checkBearer } from '../lib/mcp.mjs';
import { getToken } from '../lib/token.mjs';
import { createStore, createApp as atlassianApp } from '../services/atlassian/server.mjs';
import { mcpConfig, createApp as hubApp } from '../services/hub/server.mjs';

const TOKEN = 'lbk_test_token';
let server, url;
before(async () => {
  const r = createRouter();
  const mcp = createServer({ name: 't', tools: [{ name: 'echo', description: 'echo', handler: async (a) => a }] });
  mountHttp(r, '/mcp', mcp, { token: TOKEN });
  server = await listen(r, 0);
  url = `http://127.0.0.1:${server.address().port}/mcp`;
});
after(() => server.close());

const post = (body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });

test('checkBearer accepts only the exact token', () => {
  assert.equal(checkBearer(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(checkBearer(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(checkBearer('Bearer nope', TOKEN), false);
  assert.equal(checkBearer(undefined, TOKEN), false);
});

test('initialize gives a session id; tools/list and tools/call work with it', async () => {
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.status, 200);
  const sid = init.headers.get('mcp-session-id');
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.equal((await init.json()).result.serverInfo.name, 't');

  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid });
  assert.equal(note.status, 202);

  const call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } }, { 'mcp-session-id': sid });
  assert.deepEqual(JSON.parse((await call.json()).result.content[0].text), { a: 1 });

  const batch = await post([{ jsonrpc: '2.0', id: 3, method: 'ping' }, { jsonrpc: '2.0', id: 4, method: 'tools/list' }], { 'mcp-session-id': sid });
  const replies = await batch.json();
  assert.deepEqual(replies.map((r) => r.id), [3, 4]);

  const del = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}`, 'mcp-session-id': sid } });
  assert.equal(del.status, 204);
  const gone = await post({ jsonrpc: '2.0', id: 5, method: 'ping' }, { 'mcp-session-id': sid });
  assert.equal(gone.status, 404);
});

test('no token, wrong token, foreign origin and GET are refused', async () => {
  const noToken = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(noToken.status, 401);
  assert.match(noToken.headers.get('www-authenticate'), /Bearer/);
  assert.match((await noToken.json()).error.message, /API token/);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'http://localhost:4200' })).status, 200);
  const get = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(get.status, 405);
});

test('Atlassian service answers MCP at /mcp, calling its own REST API', async () => {
  const store = createStore({ seedPath: fileURLToPath(new URL('./fixtures/atlassian-seed.json', import.meta.url)) });
  store.reset();
  // The tools call the REST API by URL, so start once to learn the port, then mount.
  const placeholder = await listen(atlassianApp(store), 0);
  const port = placeholder.address().port;
  placeholder.close();
  process.env.LABKIT_ATLASSIAN_URL = `http://127.0.0.1:${port}`;
  const { server: mcp } = await import('../mcp/atlassian.mjs');
  const svc = await listen(atlassianApp(store, { mcp: { server: mcp, token: TOKEN } }), port);
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getJiraIssue', arguments: { issueIdOrKey: 'LB-1' } } }),
  });
  const out = await res.json();
  assert.equal(JSON.parse(out.result.content[0].text).key, 'LB-1');
  svc.close();
  store.close();
});

test('remote config uses URLs and the token, never commands', () => {
  const cfg = mcpConfig({ remote: true, token: 'abc', gateway: null });
  for (const name of ['labkit-atlassian', 'labkit-grafana', 'labkit-db', 'labkit-ping']) {
    const s = cfg.mcpServers[name];
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:43\d0\/mcp/);
    assert.equal(s.headers.Authorization, 'Bearer abc');
    assert.equal(s.command, undefined);
  }
  const named = mcpConfig({ remote: true, token: 'abc', gateway: 80 });
  assert.equal(named.mcpServers['labkit-atlassian'].url, 'http://jira.labbank.localhost/mcp');
  assert.equal(named.mcpServers['labkit-db'].url, 'http://db.labbank.localhost/mcp');
  assert.equal(mcpConfig({ remote: true, gateway: 8000 }).mcpServers['labkit-grafana'].url, 'http://grafana.labbank.localhost:8000/mcp');
});

test('hub serves the token only to local host names', async () => {
  const hub = await listen(hubApp({ mcp: { db: createServer({ name: 'db', tools: [] }), ping: createServer({ name: 'p', tools: [] }), token: TOKEN } }), 0);
  const port = hub.address().port;
  const ok = await (await fetch(`http://127.0.0.1:${port}/api/remote-mcp`)).json();
  assert.equal(ok.token, TOKEN);
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/remote-mcp', headers: { host: 'evil.example' } }, (r) => resolve(r.statusCode));
  });
  assert.equal(status, 403);
  hub.close();
});

test('getToken creates one token and then reuses it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'labkit-')), 'mcp-token.txt');
  const saved = process.env.LABKIT_MCP_TOKEN;
  delete process.env.LABKIT_MCP_TOKEN;
  const a = getToken(file);
  assert.match(a, /^lbk_[0-9a-f]{40}$/);
  assert.equal(getToken(file), a);
  if (saved) process.env.LABKIT_MCP_TOKEN = saved;
});
