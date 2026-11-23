// Relay tests. Runs against the in-memory bus, and if REDIS_URL is set, against
// two separate servers sharing Redis (this mimics the TV and a phone landing on
// different Vercel function instances).
//   npm test                                  (memory only)
//   REDIS_URL=redis://localhost:6379 npm test (memory + cross-instance)
import http from 'node:http';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { createBus } from '../lib/bus.js';
import { attachRelay } from '../lib/relay.js';
import { joinUrl } from '../api/qr.js';

function startServer(bus) {
  return new Promise((resolve) => {
    const server = http.createServer();
    attachRelay(new WebSocketServer({ server }), bus);
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function client(port, qs) {
  const ws = new WebSocket(`ws://localhost:${port}/api/ws?${qs}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  return {
    ws,
    open: () => new Promise((r, j) => { ws.once('open', r); ws.once('error', j); }),
    send: (m) => ws.send(JSON.stringify(m)),
    next(pred = () => true, ms = 2000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); reject(new Error('timeout waiting for message')); } }, ms);
      });
    },
    none(pred, ms = 300) {
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: (m) => reject(new Error('unexpected ' + JSON.stringify(m))) };
        waiters.push(w);
        setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); resolve(); }, ms);
      });
    },
    close: () => ws.close(),
  };
}

async function scenario(label, tvPort, phonePort) {
  const room = String(100000 + Math.floor(Math.random() * 900000));
  const tv = client(tvPort, `role=screen&room=${room}`);
  await tv.open();
  await tv.next((m) => m.t === 'hello');
  await new Promise((r) => setTimeout(r, 100)); // let Redis SUBSCRIBE settle

  const p1 = client(phonePort, `role=ctrl&room=${room}&id=alice`);
  const p2 = client(phonePort, `role=ctrl&room=${room}&id=bob`);
  await Promise.all([p1.open(), p2.open()]);
  await Promise.all([p1.next((m) => m.t === 'hello'), p2.next((m) => m.t === 'hello')]);
  await new Promise((r) => setTimeout(r, 100));

  // phone -> TV, stamped with sender id
  p1.send({ t: 'join', name: 'Alice', from: 'mallory' });
  const join = await tv.next((m) => m.t === 'join');
  assert.equal(join.from, 'alice', 'server must overwrite "from"');
  assert.equal(join.name, 'Alice');
  assert.ok(join.cid);

  // TV -> one phone (targeted)
  tv.send({ t: 'welcome', to: 'alice', color: '#fff' });
  const w = await p1.next((m) => m.t === 'welcome');
  assert.equal(w.color, '#fff');
  await p2.none((m) => m.t === 'welcome');

  // TV -> all phones (broadcast)
  tv.send({ t: 'screen-online' });
  await p1.next((m) => m.t === 'screen-online');
  await p2.next((m) => m.t === 'screen-online');

  // input relay
  p2.send({ t: 'in', x: 0.5, y: -1, a: true });
  const inp = await tv.next((m) => m.t === 'in');
  assert.deepEqual([inp.from, inp.x, inp.y, inp.a], ['bob', 0.5, -1, true]);

  // phones can't fake server-only messages to the TV
  p2.send({ t: 'hello', id: 'x' });
  p2.send({ t: 'leave', cid: 'x' });
  await tv.none((m) => m.t === 'hello' || m.t === 'leave');

  // other rooms are isolated
  const other = client(phonePort, `role=ctrl&room=000000&id=eve`);
  await other.open();
  other.send({ t: 'join', name: 'Eve' });
  await tv.none((m) => m.from === 'eve');

  // leave on disconnect carries the connection id
  p1.close();
  const leave = await tv.next((m) => m.t === 'leave');
  assert.equal(leave.from, 'alice');
  assert.equal(leave.cid, join.cid);

  // bad params are rejected
  const bad = new WebSocket(`ws://localhost:${phonePort}/api/ws?role=ctrl&room=12`);
  const code = await new Promise((r) => bad.on('close', (c) => r(c)));
  assert.equal(code, 4000);

  for (const c of [tv, p2, other]) c.close();
  console.log(`ok  ${label}`);
}

// QR join link: http on the local dev server, proxy headers on Vercel
{
  const local = { url: '/api/qr?room=123456', headers: { host: '192.168.1.5:3000' }, socket: {} };
  assert.equal(joinUrl(local), 'http://192.168.1.5:3000/play?room=123456');
  const vercel = { url: '/api/qr?room=12a3456', headers: { host: 'x', 'x-forwarded-host': 'tv.example.app', 'x-forwarded-proto': 'https' }, socket: {} };
  assert.equal(joinUrl(vercel), 'https://tv.example.app/play?room=123456');
  console.log('ok  qr join url');
}

const memBus = createBus('');
const mem = await startServer(memBus);
await scenario('memory bus, single instance', mem.port, mem.port);
mem.server.close();

if (process.env.REDIS_URL) {
  const busA = createBus(process.env.REDIS_URL);
  const busB = createBus(process.env.REDIS_URL);
  const a = await startServer(busA);
  const b = await startServer(busB);
  await scenario('redis bus, TV and phones on DIFFERENT instances', a.port, b.port);
  await scenario('redis bus, same instance', a.port, a.port);
  a.server.close(); b.server.close();
  await busA.close(); await busB.close();
}
setTimeout(() => process.exit(0), 100);
