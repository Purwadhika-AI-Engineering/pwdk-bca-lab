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
