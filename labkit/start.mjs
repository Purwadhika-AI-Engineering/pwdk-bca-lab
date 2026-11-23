#!/usr/bin/env node
// Starts the labkit services: hub (4300), Jira + Confluence (4310), Grafana (4330).
// The backend runs on its own: labkit\backend.cmd. Press Ctrl+C to stop everything.
//
//   node labkit/start.mjs            start
//   node labkit/start.mjs --reset    start and restore the Jira + Confluence seed data

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayPort } from './lib/names.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SERVICES = [
  { name: 'atlassian', file: 'services/atlassian/server.mjs', health: 'http://127.0.0.1:4310/health', sqlite: true },
  { name: 'grafana', file: 'services/grafana/server.mjs', health: 'http://127.0.0.1:4330/health' },
  { name: 'hub', file: 'services/hub/server.mjs', health: 'http://127.0.0.1:4300/health' },
  // Optional: friendly host names. Labkit works without it.
  { name: 'gateway', file: 'services/gateway/server.mjs', optional: true },
];

const isUp = (s) => (s.health ? up(s.health) : Promise.resolve(Boolean(gatewayPort())));

async function up(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Node 22.5 to 22.12 needs --experimental-sqlite; newer versions load node:sqlite without it. */
export function sqliteFlags(exec = process.execPath) {
  const probe = spawnSync(exec, ['--no-warnings', '-e', "require('node:sqlite')"], { encoding: 'utf8' });
  return probe.status === 0 ? [] : ['--experimental-sqlite'];
}

async function main() {
  const major = Number(process.version.slice(1).split('.')[0]);
  if (major < 22) {
    console.error(`Labkit needs Node 22 or newer. You have ${process.version}. Run labkit\\preflight.cmd for details.`);
    process.exit(1);
  }
  const extra = sqliteFlags();
  const children = [];
  let stopping = false;
  for (const s of SERVICES) {
    if (await isUp(s)) {
      console.log(`[${s.name}] already running`);
      continue;
    }
    const args = ['--no-warnings=ExperimentalWarning', ...(s.sqlite ? extra : []), path.join(HERE, s.file)];
    if (s.name === 'atlassian' && process.argv.includes('--reset')) args.push('--reset');
    const child = spawn(process.execPath, args, { cwd: path.resolve(HERE, '..'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const prefix = (stream, out) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          out.write(line.startsWith('[') ? `${line}\n` : `[${s.name}] ${line}\n`);
        }
      });
    };
    prefix(child.stdout, process.stdout);
    prefix(child.stderr, process.stderr);
    child.on('exit', (code) => {
      if (stopping) return;
      if (s.optional) console.log(`[${s.name}] not running. Use the 127.0.0.1 addresses instead.`);
      else console.error(`[${s.name}] stopped (exit ${code}). Check the messages above, then run labkit\\start.cmd again.`);
    });
    children.push(child);
  }

  for (let i = 0; i < 40; i++) {
    const states = await Promise.all(SERVICES.map(isUp));
    if (states.every(Boolean)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const states = await Promise.all(SERVICES.map(isUp));
  const gw = gatewayPort();
  const sfx = gw && gw !== 80 ? `:${gw}` : '';
  const names = { atlassian: `http://jira.labbank.localhost${sfx}`, grafana: `http://grafana.labbank.localhost${sfx}`, hub: `http://labkit.localhost${sfx}`, gateway: `127.0.0.1:${gw}` };
  console.log('');
  SERVICES.forEach((s, i) => {
    const where = s.health ? s.health.replace('/health', '') : '';
    const label = states[i] ? (gw ? `${names[s.name]}${where ? `  (${where})` : ''}` : where || 'off') : s.optional ? 'off: use the 127.0.0.1 addresses' : where;
    console.log(`  ${states[i] ? 'OK  ' : s.optional ? 'OFF ' : 'DOWN'} ${s.name.padEnd(10)} ${label}`);
  });
  console.log(`\n  Open the hub: ${gw ? names.hub : 'http://127.0.0.1:4300'}`);
  console.log('  Backend with the labkit profile: labkit\\backend.cmd (a second terminal)');
  console.log('  Press Ctrl+C to stop labkit.\n');
  if (!children.length) process.exit(0);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping labkit…');
    for (const c of children) c.kill();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
