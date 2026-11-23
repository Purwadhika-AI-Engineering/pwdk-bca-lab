// Tiny HTTP helpers: a router, JSON in and out, static files, and a JSON client.
// No dependencies. Servers bind to 127.0.0.1 only.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const HOST = '127.0.0.1';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

export function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  if (!size) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

function compile(pattern) {
  const keys = [];
  const re = pattern.replace(/\/:([A-Za-z_]+)/g, (_, key) => {
    keys.push(key);
    return '/([^/]+)';
  });
  return { re: new RegExp(`^${re}/?$`), keys };
}

/**
 * router.get('/rest/api/3/issue/:key', async (req) => ({ ... }))
 * A handler gets { params, query, body, req, res } and returns a JSON value,
 * or { status, body } via reply(), or handles res itself and returns undefined.
 */
export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, handler) => routes.push({ method, ...compile(pattern), handler });
  let staticDir = null;
  let staticPrefix = '/';

  const router = {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    delete: add('DELETE'),
    static(prefix, dir) {
      staticPrefix = prefix;
      staticDir = dir;
    },
    async handle(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      try {
        for (const route of routes) {
          if (route.method !== req.method) continue;
          const m = pathname.match(route.re);
          if (!m) continue;
          const params = {};
          route.keys.forEach((k, i) => (params[k] = m[i + 1]));
          const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : undefined;
          const query = Object.fromEntries(url.searchParams);
          const out = await route.handler({ params, query, body, req, res, url });
          if (res.writableEnded || res.headersSent) return;
          if (out && out.__reply) return sendJson(res, out.status, out.body);
          if (out === undefined) {
            res.writeHead(204);
            return res.end();
          }
          return sendJson(res, 200, out);
        }
        if (req.method === 'GET' && staticDir && pathname.startsWith(staticPrefix)) {
          if (serveStatic(res, staticDir, pathname.slice(staticPrefix.length))) return;
        }
        throw new HttpError(404, `Not found: ${req.method} ${pathname}`);
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) process.stderr.write(`${req.method} ${pathname}: ${err.stack}\n`);
        if (!res.headersSent) {
          sendJson(res, status, { errorMessages: [err.message], ...err.extra });
        } else {
          res.end();
        }
      }
    },
  };
  return router;
}

export function reply(status, body) {
  return { __reply: true, status, body };
}

function serveStatic(res, dir, rel) {
  const clean = path.normalize(rel || '/').replace(/^([/\\])+/, '');
  let file = path.join(dir, clean || 'index.html');
  if (!file.startsWith(path.resolve(dir))) return false;
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export function listen(router, port, host = HOST) {
  const server = http.createServer((req, res) => router.handle(req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** JSON client used by the MCP servers and the CLI. Throws with the server's message on 4xx/5xx. */
export async function requestJson(baseUrl, method, pathname, body) {
  let res;
  try {
    res = await fetch(new URL(pathname, baseUrl), {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Cannot reach ${baseUrl} (${err.cause?.code || err.message}). Is labkit running? Start it with labkit\\start.cmd`);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = data?.errorMessages?.join('; ') || data?.message || text || res.statusText;
    throw new Error(`${res.status} ${msg}`);
  }
  return data;
}
