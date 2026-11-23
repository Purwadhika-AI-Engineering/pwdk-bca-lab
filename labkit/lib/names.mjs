// Host names for labkit, so people see jira.labbank.localhost instead of 127.0.0.1:4310.
//
// Names that end in .localhost point to this computer (RFC 6761), with no DNS server and
// no hosts file. The gateway (services/gateway) listens on 127.0.0.1:80, or :8000 if 80 is
// taken, and sends each name to the right service. It writes its port to data/gateway.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATEWAY_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'gateway.json');
export const GATEWAY_PORTS = [80, 8000];

/**
 * Host name -> where it goes. "path" maps the public path to the service path (only these
 * paths are allowed on that host); "home" redirects "/" for hash-routed pages.
 */
export const HOSTS = {
  'labkit.localhost': { port: 4300, about: 'Labkit hub' },
  'jira.labbank.localhost': { port: 4310, about: 'Jira', home: '/#/board' },
  'confluence.labbank.localhost': { port: 4310, about: 'Confluence', home: '/#/wiki/LB' },
  'grafana.labbank.localhost': { port: 4330, about: 'Grafana' },
  'db.labbank.localhost': { port: 4300, about: 'Staging DB (MCP only)', path: { '/mcp': '/mcp/db' } },
  'api.labbank.localhost': { port: 8080, about: 'Backend API' },
  // ng serve may listen on ::1 only, so connect by name (Node tries IPv6 and IPv4).
  'app.labbank.localhost': { port: 4200, about: 'Web app', upstream: 'localhost' },
};

/** The gateway port if the gateway runs, else null. */
export function gatewayPort(file = GATEWAY_FILE) {
  try {
    const { port, pid } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pid) process.kill(pid, 0); // throws if that process is gone
    return port;
  } catch {
    return null;
  }
}

/** Public URL: by name through the gateway when it runs, else 127.0.0.1:<port>. */
export function urlFor(host, p = '/', port = gatewayPort()) {
  const h = HOSTS[host];
  if (!port) {
    const direct = h.path ? Object.entries(h.path).find(([from]) => p.startsWith(from)) : null;
    return `http://127.0.0.1:${h.port}${direct ? direct[1] + p.slice(direct[0].length) : p}`;
  }
  return `http://${host}${port === 80 ? '' : `:${port}`}${p}`;
}

/** Remote MCP endpoints: one URL per "product", like real hosted servers. */
export function remoteServers(port = gatewayPort()) {
  return {
    'labkit-atlassian': { url: urlFor('jira.labbank.localhost', '/mcp', port), file: 'atlassian.mjs' },
    'labkit-grafana': { url: urlFor('grafana.labbank.localhost', '/mcp', port), file: 'grafana.mjs' },
    'labkit-db': { url: urlFor('db.labbank.localhost', '/mcp', port), file: 'db.mjs' },
    'labkit-ping': { url: urlFor('labkit.localhost', '/mcp/ping', port), file: 'ping.mjs' },
  };
}
