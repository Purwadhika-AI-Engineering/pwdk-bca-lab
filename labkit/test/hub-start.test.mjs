import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mcpConfig, createApp } from '../services/hub/server.mjs';
import { listen, requestJson } from '../lib/http.mjs';

test('committed .kiro/settings/mcp.json matches the hub generator', () => {
  const committed = JSON.parse(fs.readFileSync(new URL('../../.kiro/settings/mcp.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, mcpConfig());
  assert.equal(committed.mcpServers.playwright.disabled, true);
});

test('absolute config uses full paths that exist', () => {
  const cfg = mcpConfig({ absolute: true });
  for (const [name, s] of Object.entries(cfg.mcpServers)) {
    if (name === 'playwright') continue;
    assert.ok(fs.existsSync(s.args[0]), s.args[0]);
  }
});

test('hub reports status of every part', async () => {
  const server = await listen(createApp(), 0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const s = await requestJson(base, 'GET', '/api/status');
  assert.deepEqual(s.parts.map((p) => p.id), ['atlassian', 'grafana', 'backend', 'db', 'frontend']);
  assert.ok(s.parts.every((p) => typeof p.up === 'boolean'));
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /Labkit · Lab Bank staging/);
  server.close();
});

test('every MCP server answers initialize and tools/list over stdio', async () => {
  for (const file of ['ping', 'atlassian', 'grafana', 'db']) {
    const child = spawn(process.execPath, [fileURLToPath(new URL(`../mcp/${file}.mjs`, import.meta.url))]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
    const [init, list] = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(init.result.serverInfo.name, `labkit-${file}`);
    assert.ok(list.result.tools.length > 0, file);
  }
});
