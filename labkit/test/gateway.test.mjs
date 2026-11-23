import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createGateway, route, hostOf } from '../lib/gateway.mjs';
import { HOSTS, urlFor, remoteServers } from '../lib/names.mjs';
import { checkNames } from '../preflight.mjs';

test('route maps host names, paths and home redirects', () => {
  assert.equal(hostOf('JIRA.labbank.localhost:8000'), 'jira.labbank.localhost');
  assert.deepEqual(route(HOSTS, 'jira.labbank.localhost', '/mcp'), { port: 4310, upstream: '127.0.0.1', path: '/mcp', name: 'jira.labbank.localhost' });
  assert.deepEqual(route(HOSTS, 'confluence.labbank.localhost', '/'), { redirect: '/#/wiki/LB' });
  assert.deepEqual(route(HOSTS, 'db.labbank.localhost', '/mcp'), { port: 4300, upstream: '127.0.0.1', path: '/mcp/db', name: 'db.labbank.localhost' });
  assert.equal(route(HOSTS, 'db.labbank.localhost', '/api/remote-mcp').error, 404);
  assert.equal(route(HOSTS, 'db.labbank.localhost', '/mcpx').error, 404);
  assert.equal(route(HOSTS, 'evil.example', '/').error, 404);
});

test('urlFor and remoteServers use names with the gateway, 127.0.0.1 without', () => {
  assert.equal(urlFor('grafana.labbank.localhost', '/mcp', 80), 'http://grafana.labbank.localhost/mcp');
  assert.equal(urlFor('grafana.labbank.localhost', '/mcp', 8000), 'http://grafana.labbank.localhost:8000/mcp');
  assert.equal(urlFor('grafana.labbank.localhost', '/mcp', null), 'http://127.0.0.1:4330/mcp');
  assert.equal(urlFor('db.labbank.localhost', '/mcp', null), 'http://127.0.0.1:4300/mcp/db');
  assert.equal(remoteServers(null)['labkit-ping'].url, 'http://127.0.0.1:4300/mcp/ping');
});

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

function get(port, host, path, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: extra.method || 'GET', headers: { host, ...extra.headers } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(extra.body);
  });
}

test('gateway proxies by host name, rewrites Host, keeps the body', async () => {
  const seen = [];
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ host: req.headers.host, fwd: req.headers['x-forwarded-host'], url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'abc' });
      res.end('{"ok":true}');
    });
  });
  const bport = await listen(backend);
  const hosts = { 'jira.test.localhost': { port: bport }, 'db.test.localhost': { port: bport, path: { '/mcp': '/mcp/db' } }, 'down.test.localhost': { port: 1 } };
  const gw = createGateway(hosts);
  const gport = await listen(gw);

  const r = await get(gport, 'jira.test.localhost', '/mcp', { method: 'POST', body: '{"jsonrpc":"2.0"}', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['mcp-session-id'], 'abc');
  assert.deepEqual(seen[0], { host: `127.0.0.1:${bport}`, fwd: 'jira.test.localhost', url: '/mcp', body: '{"jsonrpc":"2.0"}' });

  await get(gport, 'db.test.localhost', '/mcp?x=1');
  assert.equal(seen[1].url, '/mcp/db?x=1');

  assert.equal((await get(gport, 'other.localhost', '/')).status, 404);
  const down = await get(gport, 'down.test.localhost', '/');
  assert.equal(down.status, 502);
  assert.match(down.body, /not running/);
  gw.closeAllConnections();
  gw.close();
  backend.closeAllConnections();
  backend.close();
});

test('gateway passes WebSocket upgrades through', async () => {
  const backend = http.createServer();
  const upstream = [];
  backend.on('upgrade', (req, socket) => {
    upstream.push(socket);
    socket.on('end', () => (socket.gotEnd = true));
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Host: ${req.headers.host}\r\n\r\n`);
    socket.on('data', (d) => socket.write(d)); // echo
  });
  const bport = await listen(backend);
  const gw = createGateway({ 'app.test.localhost': { port: bport } });
  const gport = await listen(gw);
  const reply = await new Promise((resolve) => {
    const s = net.connect(gport, '127.0.0.1', () => {
      s.write('GET /ws HTTP/1.1\r\nHost: app.test.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('\r\n\r\n') && !buf.includes('hello')) s.write('hello');
      if (buf.includes('hello')) {
        s.destroy();
        resolve(buf);
      }
    });
  });
  assert.match(reply, /^HTTP\/1.1 101/);
  assert.match(reply, new RegExp(`X-Seen-Host: 127.0.0.1:${bport}`));
  // The client left: the gateway must close its upstream socket too.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(upstream.every((s) => s.gotEnd), 'gateway closed the upstream socket');
  upstream.forEach((s) => s.destroy());
  gw.close();
  backend.close();
});

test('preflight host-name check passes on loopback and warns otherwise', async () => {
  // checkNames records into the shared report; it must not throw either way.
  await checkNames(async () => [{ address: '127.0.0.1' }]);
  await checkNames(async () => [{ address: '10.0.0.5' }]);
  await checkNames(async () => {
    throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
  });
});
