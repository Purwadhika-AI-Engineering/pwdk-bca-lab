// The API token for the simulated remote MCP endpoints.
// One random token per laptop, kept in labkit/data/mcp-token.txt (gitignored).
// LABKIT_MCP_TOKEN overrides it. Shown on the hub, like an "API token" page in a real product.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOKEN_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'mcp-token.txt');

export function getToken(file = TOKEN_FILE) {
  if (process.env.LABKIT_MCP_TOKEN) return process.env.LABKIT_MCP_TOKEN;
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch {}
  const token = `lbk_${crypto.randomBytes(20).toString('hex')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, token + '\n', { flag: 'wx' }); // another service may have written it first
    return token;
  } catch {
    return fs.readFileSync(file, 'utf8').trim();
  }
}
