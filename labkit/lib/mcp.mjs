// Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0.
// Supports initialize, ping, tools/list and tools/call. No dependencies.
//
// Usage:
//   import { createServer, runStdio } from '../lib/mcp.mjs';
//   const server = createServer({ name: 'labkit-x', version: '1.0.0', tools: [
//     { name: 'ping', description: '...', inputSchema: { type: 'object', properties: {} },
//       handler: async (args) => 'pong' },
//   ]});
//   runStdio(server);
//
// A handler returns a string or any JSON value (sent as text). Throwing an error
// returns a tool result with isError: true, so the agent sees the message.

import crypto from 'node:crypto';
import readline from 'node:readline';

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function createServer({ name, version = '1.0.0', instructions, tools }) {
  const byName = new Map();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
    byName.set(tool.name, tool);
  }
  return { name, version, instructions, tools, byName };
}

function toText(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Handles one parsed JSON-RPC message. Returns the response, or null for notifications. */
export async function handleMessage(server, msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // A response from the client (we never send requests) or garbage: ignore unless it has an id.
    if (msg && msg.id !== undefined && msg.method === undefined) return null;
    return rpcError(msg?.id ?? null, -32600, 'Invalid request');
  }
  const isNotification = msg.id === undefined;
  const { method, params = {} } = msg;
  let result;
  try {
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        result = {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: server.name, version: server.version },
        };
        if (server.instructions) result.instructions = server.instructions;
        break;
      }
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = {
          tools: server.tools.map(({ name, title, description, inputSchema }) => ({
            name,
            ...(title ? { title } : {}),
            description,
            inputSchema: inputSchema || { type: 'object', properties: {} },
          })),
        };
        break;
      case 'tools/call': {
        const tool = server.byName.get(params.name);
        if (!tool) {
          if (isNotification) return null;
          return rpcError(msg.id, -32602, `Unknown tool: ${params.name}`);
        }
        try {
          const value = await tool.handler(params.arguments || {});
          result = { content: [{ type: 'text', text: toText(value) }], isError: false };
        } catch (err) {
          result = { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
        break;
      }
      default:
        if (method.startsWith('notifications/')) return null;
        if (isNotification) return null;
        return rpcError(msg.id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    return rpcError(msg.id, -32603, err.message);
  }
  if (isNotification) return null;
  return { jsonrpc: '2.0', id: msg.id, result };
}

/** Reads requests from stdin, writes responses to stdout. Logs go to stderr only. */
export function runStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (obj) => output.write(JSON.stringify(obj) + '\n');
  const pending = new Set();
  rl.on('line', (line) => {
    const job = onLine(line).finally(() => pending.delete(job));
    pending.add(job);
  });
  async function onLine(line) {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      write(rpcError(null, -32700, 'Parse error'));
      return;
    }
    const batch = Array.isArray(msg) ? msg : [msg];
    const replies = (await Promise.all(batch.map((m) => handleMessage(server, m)))).filter(Boolean);
    if (Array.isArray(msg)) {
      if (replies.length) write(replies);
    } else if (replies[0]) {
      write(replies[0]);
    }
  }
  // stdin closed: the client is gone. Finish open calls, then exit.
  rl.on('close', async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
  process.stderr.write(`[${server.name}] MCP server ready (stdio)\n`);
}

// ---------- Streamable HTTP transport (simulated remote MCP server) ----------
//
// Follows the MCP "Streamable HTTP" transport: one URL; the client POSTs JSON-RPC and gets
// JSON back. The server gives an Mcp-Session-Id on initialize. GET (server-sent stream) is not
// offered (405), like many real servers. Like a real remote server it needs a Bearer token.
// It also checks the Origin header, so a web page cannot call it (DNS rebinding).


const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function sendJson(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

/** True if the Authorization header carries the token. Constant-time compare. */
export function checkBearer(header, token) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Adds an MCP endpoint to a router from lib/http.mjs, for example router + '/mcp'.
 * Options: token (required Bearer token, or null for none), maxSessions.
 */
export function mountHttp(router, path, server, { token, maxSessions = 1000 } = {}) {
  const sessions = new Map(); // id -> last use (ms)

  function guard(req, res) {
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN.test(origin)) {
      sendJson(res, 403, rpcError(null, -32000, `Origin ${origin} is not allowed`));
      return false;
    }
    if (token && !checkBearer(req.headers.authorization, token)) {
      sendJson(res, 401, rpcError(null, -32001, 'Missing or wrong API token. Add the header "Authorization: Bearer <token>". Get the token on the labkit hub (http://127.0.0.1:4300).'), {
        'www-authenticate': 'Bearer realm="labkit"',
      });
      return false;
    }
    return true;
  }

  router.post(path, async ({ req, res, body }) => {
    if (!guard(req, res)) return;
    const batch = Array.isArray(body) ? body : [body];
    if (!body || !batch.length) return sendJson(res, 400, rpcError(null, -32600, 'Empty request'));
    const isInit = batch.some((m) => m?.method === 'initialize');
    const sid = req.headers['mcp-session-id'];
    const headers = {};
    if (isInit) {
      const id = crypto.randomUUID();
      if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
      sessions.set(id, Date.now());
      headers['mcp-session-id'] = id;
    } else if (sid) {
      if (!sessions.has(sid)) return sendJson(res, 404, rpcError(null, -32002, 'Session not found. Initialize again.'));
      sessions.set(sid, Date.now());
    }
    const replies = (await Promise.all(batch.map((m) => handleMessage(server, m)))).filter(Boolean);
    if (!replies.length) {
      res.writeHead(202, headers);
      return res.end();
    }
    sendJson(res, 200, Array.isArray(body) ? replies : replies[0], headers);
  });

  router.get(path, ({ req, res }) => {
    if (!guard(req, res)) return;
    sendJson(res, 405, rpcError(null, -32000, 'This server does not open a stream. Use POST.'), { allow: 'POST, DELETE' });
  });

  router.delete(path, ({ req, res }) => {
    if (!guard(req, res)) return;
    const sid = req.headers['mcp-session-id'];
    if (sid) sessions.delete(sid);
    res.writeHead(204);
    res.end();
  });

  return { sessions };
}
