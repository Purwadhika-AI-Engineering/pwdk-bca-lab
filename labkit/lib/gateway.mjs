// Host-based reverse proxy: jira.labbank.localhost -> 127.0.0.1:4310 and so on.
// Node built-ins only. Handles normal requests and WebSocket upgrades (Angular live reload).

import http from 'node:http';
import net from 'node:net';

export function hostOf(header) {
  return String(header || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/** Returns { port, path } for a request, a { redirect } for a home page, or { error }. */
export function route(hosts, hostHeader, url) {
  const name = hostOf(hostHeader);
  const h = hosts[name];
  if (!h) return { error: 404, message: `Unknown host "${name}". Known: ${Object.keys(hosts).join(', ')}` };
  if (h.home && (url === '/' || url === '')) return { redirect: h.home };
  if (h.path) {
    const hit = Object.entries(h.path).find(([from]) => url === from || url.startsWith(from + '?') || url.startsWith(from + '/'));
    if (!hit) return { error: 404, message: `${name} only serves ${Object.keys(h.path).join(', ')}` };
    return { port: h.port, upstream: h.upstream || '127.0.0.1', path: hit[1] + url.slice(hit[0].length), name };
  }
  return { port: h.port, upstream: h.upstream || '127.0.0.1', path: url, name };
}

export function createGateway(hosts, { log = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    const r = route(hosts, req.headers.host, req.url);
    if (r.error) {
      res.writeHead(r.error, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(r.message);
    }
    if (r.redirect) {
      res.writeHead(302, { location: r.redirect });
      return res.end();
    }
    const headers = {
      ...req.headers,
      // Services see a plain local host, so dev servers with host checks (ng serve) accept it.
      host: `${r.upstream}:${r.port}`,
      'x-forwarded-host': req.headers.host,
      'x-forwarded-proto': 'http',
    };
    const up = http.request({ host: r.upstream, port: r.port, method: req.method, path: r.path, headers }, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', (err) => {
      log(`${r.name}: ${err.code || err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`${hostOf(req.headers.host)} is not running (127.0.0.1:${r.port}). Check the labkit hub.`);
      } else res.destroy();
    });
    req.pipe(up);
  });

  server.on('upgrade', (req, socket, head) => {
    const r = route(hosts, req.headers.host, req.url);
    if (r.error || r.redirect) return socket.destroy();
    const up = net.connect({ host: r.upstream, port: r.port }, () => {
      const lines = [`${req.method} ${r.path} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        lines.push(`${k}: ${k.toLowerCase() === 'host' ? `${r.upstream}:${r.port}` : req.rawHeaders[i + 1]}`);
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    // When one side goes away, close the other, or sockets leak (live reload reconnects often).
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
  });
  return server;
}
