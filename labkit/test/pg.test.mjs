import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { connect, PgError } from '../lib/pg.mjs';

// A fake Postgres server that speaks just enough of protocol 3.0.
function msg(type, body) {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'ascii');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}
const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const int16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const cstr = (s) => Buffer.from(s + '\0');

function rowDescription(cols) {
  return msg('T', Buffer.concat([int16(cols.length), ...cols.map(([name, oid]) =>
    Buffer.concat([cstr(name), int32(0), int16(0), int32(oid), int16(-1), int32(-1), int16(0)]))]));
}
function dataRow(values) {
  return msg('D', Buffer.concat([int16(values.length), ...values.map((v) =>
    v === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v)]))]));
}

function fakeServer() {
  const seen = { startup: null, password: null, queries: [] };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let started = false;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (!started) {
          if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
          const len = buf.readInt32BE(0);
          seen.startup = buf.subarray(8, len).toString().split('\0').filter(Boolean);
          buf = buf.subarray(len);
          started = true;
          sock.write(msg('R', int32(3))); // cleartext password please
          continue;
        }
        if (buf.length < 5 || buf.length < buf.readInt32BE(1) + 1) return;
        const type = String.fromCharCode(buf[0]);
        const len = buf.readInt32BE(1);
        const body = buf.subarray(5, len + 1).toString().replace(/\0$/, '');
        buf = buf.subarray(len + 1);
        if (type === 'p') {
          seen.password = body;
          if (body !== 'pw') {
            sock.write(msg('E', Buffer.concat([cstr('SFATAL'), cstr('C28P01'), cstr('Mbad password'), Buffer.from([0])])));
            sock.end();
            return;
          }
          sock.write(Buffer.concat([msg('R', int32(0)), msg('S', Buffer.concat([cstr('server_version'), cstr('8.2.23')])), msg('Z', Buffer.from('I'))]));
        } else if (type === 'Q') {
          seen.queries.push(body);
          if (body.startsWith('SELECT')) {
            sock.write(Buffer.concat([
              rowDescription([['account_no', 1043], ['balance_cents', 20], ['amount', 1700], ['active', 16]]),
              dataRow(['1234567890', '7500000000', '50000.00', 't']),
              dataRow(['2345678901', null, '1.50', 'f']),
              msg('C', cstr('SELECT 2')),
              msg('Z', Buffer.from('I')),
            ]));
          } else {
            sock.write(Buffer.concat([
              msg('E', Buffer.concat([cstr('SERROR'), cstr('C90096'), cstr('Mnot enough rights'), Buffer.from([0])])),
              msg('Z', Buffer.from('I')),
            ]));
          }
        } else if (type === 'X') {
          sock.end();
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

test('connects with a cleartext password and reads typed rows', async () => {
  const { server, seen, port } = await fakeServer();
  const c = await connect({ port, user: 'ro', password: 'pw', database: 'banklab' });
  const r = await c.query('SELECT 1');
  assert.deepEqual(seen.startup, ['user', 'ro', 'database', 'banklab', 'client_encoding', 'UTF8']);
  assert.equal(seen.password, 'pw');
  assert.equal(r.command, 'SELECT 2');
  assert.deepEqual(r.fields, ['account_no', 'balance_cents', 'amount', 'active']);
  assert.deepEqual(r.rows, [
    { account_no: '1234567890', balance_cents: 7500000000, amount: '50000.00', active: true },
    { account_no: '2345678901', balance_cents: null, amount: '1.50', active: false },
  ]);
  await c.end();
  server.close();
});

test('a server error becomes a PgError and the connection stays usable', async () => {
  const { server, port } = await fakeServer();
  const c = await connect({ port, user: 'ro', password: 'pw', database: 'banklab' });
  await assert.rejects(c.query('UPDATE x'), (e) => e instanceof PgError && e.code === '90096' && e.message === 'not enough rights');
  const r = await c.query('SELECT 1');
  assert.equal(r.rows.length, 2);
  await c.end();
  server.close();
});

test('a wrong password is rejected', async () => {
  const { server, port } = await fakeServer();
  await assert.rejects(connect({ port, user: 'ro', password: 'nope', database: 'banklab' }), /bad password/);
  server.close();
});
