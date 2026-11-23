#!/usr/bin/env node
// Labkit gateway: friendly host names (jira.labbank.localhost, ...) on 127.0.0.1:80.
// Falls back to :8000 when port 80 is taken. Writes the port to data/gateway.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../../lib/gateway.mjs';
import { HOSTS, GATEWAY_FILE, GATEWAY_PORTS } from '../../lib/names.mjs';

function listenOn(server, port) {
  return new Promise((resolve) => {
    const onError = (err) => {
      server.off('listening', onListen);
      resolve(err.code || err.message);
    };
    const onListen = () => {
      server.off('error', onError);
      resolve(null);
    };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(port, '127.0.0.1');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createGateway(HOSTS, { log: (m) => console.error(`[gateway] ${m}`) });
  const ports = process.env.LABKIT_GATEWAY_PORT ? [Number(process.env.LABKIT_GATEWAY_PORT)] : GATEWAY_PORTS;
  let port = null;
  for (const p of ports) {
    const err = await listenOn(server, p);
    if (!err) {
      port = p;
      break;
    }
    console.log(`[gateway] port ${p} not available (${err})`);
  }
  if (!port) {
    console.log('[gateway] no free port. Host names are off; use the 127.0.0.1 addresses.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(GATEWAY_FILE), { recursive: true });
  fs.writeFileSync(GATEWAY_FILE, JSON.stringify({ port, pid: process.pid }));
  const cleanup = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(GATEWAY_FILE, 'utf8'));
      if (cur.pid === process.pid) fs.rmSync(GATEWAY_FILE);
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  const suffix = port === 80 ? '' : `:${port}`;
  console.log(`[gateway] host names on 127.0.0.1:${port}: http://labkit.localhost${suffix}, http://jira.labbank.localhost${suffix}, ...`);
}
