// Minimal Postgres wire protocol client (protocol 3.0).
// Enough for labkit: startup, cleartext or MD5 password, simple query.
// No dependencies: node:net and node:crypto only.

import net from 'node:net';
import crypto from 'node:crypto';

const INT_TYPES = new Set([20, 21, 23, 26]); // int8, int2, int4, oid
const FLOAT_TYPES = new Set([700, 701]);
const BOOL_TYPE = 16;

export class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'Postgres error');
    this.code = fields.C;
    this.severity = fields.S;
    this.detail = fields.D;
  }
}

function cstring(s) {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}

function message(type, body) {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'ascii');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

function parseFields(buf) {
  const fields = {};
  let i = 0;
  while (i < buf.length && buf[i] !== 0) {
    const code = String.fromCharCode(buf[i]);
    const end = buf.indexOf(0, i + 1);
    fields[code] = buf.toString('utf8', i + 1, end);
    i = end + 1;
  }
  return fields;
}

function convert(text, typeOid) {
  if (text === null) return null;
  if (INT_TYPES.has(typeOid)) {
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : text;
  }
  if (FLOAT_TYPES.has(typeOid)) return Number(text);
  if (typeOid === BOOL_TYPE) return text === 't' || text === 'true';
  return text; // numeric, text, dates: keep the exact text
}

export class PgClient {
  constructor({ host = '127.0.0.1', port = 5435, user, password = '', database, timeoutMs = 10000 }) {
    Object.assign(this, { host, port, user, password, database, timeoutMs });
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.queue = [];
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to ${this.host}:${this.port}`));
      }, this.timeoutMs);
      socket.on('error', (err) => {
        clearTimeout(timer);
        this.fail(err);
        reject(err);
      });
      socket.on('close', () => {
        this.closed = true;
        this.fail(new Error('Connection closed'));
      });
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('connect', async () => {
        try {
          await this.startup();
          clearTimeout(timer);
          resolve(this);
        } catch (err) {
          clearTimeout(timer);
          socket.destroy();
          reject(err);
        }
      });
    });
  }

  fail(err) {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w.reject(err);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 5) {
      const len = this.buffer.readInt32BE(1);
      if (this.buffer.length < len + 1) break;
      const type = String.fromCharCode(this.buffer[0]);
      const body = this.buffer.subarray(5, len + 1);
      this.buffer = this.buffer.subarray(len + 1);
      this.queue.push({ type, body });
    }
    while (this.queue.length && this.waiters.length) {
      this.waiters.shift().resolve(this.queue.shift());
    }
  }

  next() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new Error('Connection closed'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async startup() {
    const params = Buffer.concat([
      cstring('user'), cstring(this.user),
      cstring('database'), cstring(this.database),
      cstring('client_encoding'), cstring('UTF8'),
      Buffer.from([0]),
    ]);
    const head = Buffer.alloc(8);
    head.writeInt32BE(params.length + 8, 0);
    head.writeInt32BE(196608, 4); // protocol 3.0
    this.socket.write(Buffer.concat([head, params]));

    for (;;) {
      const { type, body } = await this.next();
      if (type === 'R') {
        const code = body.readInt32BE(0);
        if (code === 0) continue; // AuthenticationOk
        if (code === 3) {
          this.socket.write(message('p', cstring(this.password)));
        } else if (code === 5) {
          const salt = body.subarray(4, 8);
          const inner = crypto.createHash('md5').update(this.password + this.user).digest('hex');
          const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
          this.socket.write(message('p', cstring('md5' + outer)));
        } else {
          throw new Error(`Unsupported auth method ${code}`);
        }
      } else if (type === 'E') {
        throw new PgError(parseFields(body));
      } else if (type === 'Z') {
        return;
      } // 'S' ParameterStatus, 'K' BackendKeyData, 'N' Notice: ignore
    }
  }

  /** Runs one SQL string with the simple query protocol. Returns the last result set. */
  async query(sql) {
    if (this.busy) throw new Error('One query at a time');
    this.busy = true;
    try {
      this.socket.write(message('Q', cstring(sql)));
      let fields = [];
      let rows = [];
      let command = null;
      let error = null;
      for (;;) {
        const { type, body } = await this.next();
        if (type === 'T') {
          fields = [];
          rows = [];
          const count = body.readInt16BE(0);
          let i = 2;
          for (let f = 0; f < count; f++) {
            const end = body.indexOf(0, i);
            const name = body.toString('utf8', i, end);
            i = end + 1;
            const typeOid = body.readInt32BE(i + 6);
            i += 18;
            fields.push({ name, typeOid });
          }
        } else if (type === 'D') {
          const count = body.readInt16BE(0);
          let i = 2;
          const row = {};
          for (let c = 0; c < count; c++) {
            const len = body.readInt32BE(i);
            i += 4;
            const text = len === -1 ? null : body.toString('utf8', i, i + len);
            if (len > 0) i += len;
            const field = fields[c] || { name: `col${c}`, typeOid: 25 };
            row[field.name] = convert(text, field.typeOid);
          }
          rows.push(row);
        } else if (type === 'C') {
          command = body.toString('utf8', 0, body.length - 1);
        } else if (type === 'E') {
          error = new PgError(parseFields(body));
        } else if (type === 'Z') {
          if (error) throw error;
          return { command, fields: fields.map((f) => f.name), rows };
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async end() {
    if (this.closed || !this.socket) return;
    this.socket.write(message('X', Buffer.alloc(0)));
    this.socket.end();
  }
}

export async function connect(options) {
  const client = new PgClient(options);
  return client.connect();
}
