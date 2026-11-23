#!/usr/bin/env node
// Drives the Lab Bank API so Grafana has logs and metrics to show.
//
//   node labkit/traffic.mjs                 run the scenario once (about 5 seconds)
//   node labkit/traffic.mjs --loop 15       then keep light traffic going, one round every 15 s (Ctrl+C to stop)
//   node labkit/traffic.mjs --api http://127.0.0.1:8080 --scenario labkit/seed/traffic-scenario.json
//
// Money moves in pairs, so demo balances end where they started (one small transfer goes to another bank).

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRunner({ api, password, log = console.log, pauseMs = 150 }) {
  const tokens = {};
  const keys = {};

  async function login(user, pw = password) {
    const res = await fetch(`${api}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: user, password: pw }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) tokens[user] = body.token;
    return { status: res.status, body };
  }

  async function step(s) {
    let result;
    if (s.call === 'login') {
      result = await login(s.as, s.password || password);
    } else {
      const [method, p] = s.call.split(' ');
      if (s.as && !tokens[s.as]) await login(s.as);
      const headers = { 'content-type': 'application/json' };
      if (s.as) headers.authorization = `Bearer ${tokens[s.as]}`;
      if (method === 'POST' && p === '/api/transfers') {
        if (s.idempotencyKey) keys[s.idempotencyKey] ||= crypto.randomUUID();
        headers['idempotency-key'] = s.idempotencyKey ? keys[s.idempotencyKey] : crypto.randomUUID();
      }
      const res = await fetch(`${api}${p}`, { method, headers, body: s.body ? JSON.stringify(s.body) : undefined });
      result = { status: res.status, body: await res.json().catch(() => null), traceId: res.headers.get('x-trace-id') };
    }
    const expected = [].concat(s.expect ?? []);
    const ok = !expected.length || expected.includes(result.status);
    const code = result.body?.errorCode ? ` ${result.body.errorCode}` : '';
    log(`${ok ? 'ok  ' : 'DIFF'} ${String(result.status).padEnd(4)}${(s.as || '-').padEnd(6)} ${s.call}${code}${s.name ? `  (${s.name})` : ''}${ok ? '' : `  expected ${expected.join(' or ')}`}`);
    await sleep(pauseMs);
    return { ...result, ok };
  }

  async function run(steps) {
    const results = [];
    for (const s of steps) results.push(await step(s));
    return results;
  }

  return { run, step, login };
}

async function main() {
  const api = String(arg('api', process.env.LABKIT_API_URL || 'http://127.0.0.1:8080')).replace(/\/$/, '');
  const scenarioPath = path.resolve(String(arg('scenario', path.join(HERE, 'seed', 'traffic-scenario.json'))));
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  const loop = arg('loop', false);

  // TCP check: an HTTP probe would add a line to the logs.
  const { hostname, port } = new URL(api);
  const reachable = await new Promise((resolve) => {
    const s = net.connect({ host: hostname, port: Number(port) || 80 });
    s.setTimeout(3000, () => (s.destroy(), resolve(false)));
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
  if (!reachable) {
    console.error(`Cannot reach the backend at ${api}. Start it first: labkit\\backend.cmd`);
    process.exit(1);
  }

  const runner = createRunner({ api, password: scenario.password });
  console.log(`Traffic to ${api}: ${scenario.steps.length} steps`);
  const results = await runner.run(scenario.steps);
  const diff = results.filter((r) => !r.ok).length;
  console.log(`\nDone: ${results.length} calls, ${results.filter((r) => r.status >= 400).length} expected errors, ${diff} unexpected results.`);
  if (diff) console.log('Unexpected results are fine if someone changed the app or the data. Restart the backend for fresh data.');

  if (loop) {
    const every = Number(loop === true ? 15 : loop) * 1000;
    console.log(`\nLight traffic every ${every / 1000} s. Press Ctrl+C to stop.`);
    for (;;) {
      await sleep(every);
      await runner.run(scenario.loop || []);
    }
  }
  process.exitCode = diff ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
