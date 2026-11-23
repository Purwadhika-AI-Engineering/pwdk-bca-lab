#!/usr/bin/env node
// Smallest labkit MCP server. If Kiro can call "ping", MCP setup works on this laptop.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, runStdio } from '../lib/mcp.mjs';

export const tools = [
  {
    name: 'ping',
    description: 'Health check for the labkit MCP setup. Returns "pong" with the Node version and platform.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Optional text to echo back' } },
    },
    handler: async ({ message }) =>
      `pong${message ? `: ${message}` : ''} (node ${process.version}, ${process.platform}, cwd ${process.cwd()})`,
  },
];

export const server = createServer({ name: 'labkit-ping', version: '1.0.0', tools });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runStdio(server);
