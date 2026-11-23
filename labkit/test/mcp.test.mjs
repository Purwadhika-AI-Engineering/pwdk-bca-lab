import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, handleMessage } from '../lib/mcp.mjs';

const server = createServer({
  name: 't',
  tools: [
    { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} }, handler: async (a) => a },
    { name: 'boom', description: 'fails', handler: async () => { throw new Error('bad input'); } },
  ],
});

test('initialize echoes a supported protocol version', async () => {
  const r = await handleMessage(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(r.result.protocolVersion, '2024-11-05');
  assert.deepEqual(r.result.capabilities.tools, { listChanged: false });
  assert.equal(r.result.serverInfo.name, 't');
});

test('initialize falls back to the newest version for an unknown one', async () => {
  const r = await handleMessage(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
});

test('notifications get no reply', async () => {
  assert.equal(await handleMessage(server, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('tools/list returns names and schemas', async () => {
  const r = await handleMessage(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(r.result.tools.map((t) => t.name), ['echo', 'boom']);
  assert.deepEqual(r.result.tools[1].inputSchema, { type: 'object', properties: {} });
});

test('tools/call returns JSON as text', async () => {
  const r = await handleMessage(server, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } });
  assert.equal(r.result.isError, false);
  assert.deepEqual(JSON.parse(r.result.content[0].text), { a: 1 });
});

test('a failing tool returns isError with the message', async () => {
  const r = await handleMessage(server, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom' } });
  assert.equal(r.result.isError, true);
  assert.equal(r.result.content[0].text, 'Error: bad input');
});

test('unknown tool and unknown method are JSON-RPC errors', async () => {
  const a = await handleMessage(server, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(a.error.code, -32602);
  const b = await handleMessage(server, { jsonrpc: '2.0', id: 6, method: 'resources/list' });
  assert.equal(b.error.code, -32601);
});

test('ping server works over stdio end to end', async () => {
  const file = fileURLToPath(new URL('../mcp/ping.mjs', import.meta.url));
  const child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  child.stdout.setEncoding('utf8');
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: { message: 'hi' } } });
  child.stdin.end();
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].result.serverInfo.name, 'labkit-ping');
  assert.match(lines[1].result.content[0].text, /^pong: hi \(node v/);
});
