import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRunner } from '../traffic.mjs';

test('runner logs in once, reuses Idempotency-Key per name and flags unexpected statuses', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, key: req.headers['idempotency-key'] });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/auth/login') return res.end(JSON.stringify({ token: `tok-${JSON.parse(body).username}` }));
      res.statusCode = req.method === 'POST' ? 201 : 200;
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const lines = [];
  const runner = createRunner({ api: `http://127.0.0.1:${server.address().port}`, password: 'pw', log: (l) => lines.push(l), pauseMs: 0 });
  const results = await runner.run([
    { as: 'andi', call: 'POST /api/transfers', body: { amount: 1 }, idempotencyKey: 'k', expect: 201 },
    { as: 'andi', call: 'POST /api/transfers', body: { amount: 1 }, idempotencyKey: 'k', expect: 201 },
    { as: 'andi', call: 'POST /api/transfers', body: { amount: 1 }, expect: 201 },
    { as: 'andi', call: 'GET /api/transfers', expect: 404 },
  ]);
  server.close();
  const posts = seen.filter((s) => s.url === '/api/transfers' && s.method === 'POST');
  assert.equal(seen.filter((s) => s.url === '/api/auth/login').length, 1);
  assert.equal(posts[0].auth, 'Bearer tok-andi');
  assert.equal(posts[0].key, posts[1].key);
  assert.notEqual(posts[1].key, posts[2].key);
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false]);
  assert.match(lines[3], /^DIFF 200 .*expected 404/);
});

test('scenario moves money in pairs (except other banks), so balances come back', () => {
  const scenario = JSON.parse(fs.readFileSync(new URL('../seed/traffic-scenario.json', import.meta.url), 'utf8'));
  for (const steps of [scenario.steps, scenario.loop]) {
    const net = {};
    const seenKeys = new Set();
    for (const s of steps) {
      if (s.call !== 'POST /api/transfers' || ![].concat(s.expect).some((c) => c === 201)) continue;
      if (s.idempotencyKey && seenKeys.has(s.idempotencyKey)) continue; // replay: no second debit
      if (s.idempotencyKey) seenKeys.add(s.idempotencyKey);
      const { fromAccount, toAccount, toBankCode, amount } = s.body;
      net[fromAccount] = (net[fromAccount] || 0) - amount;
      if (toBankCode === '999') net[toAccount] = (net[toAccount] || 0) + amount;
    }
    const nonZero = Object.entries(net).filter(([, v]) => v !== 0);
    assert.ok(nonZero.every(([acct, v]) => acct === '3456789012' && v === -25000) , JSON.stringify(nonZero));
  }
});
