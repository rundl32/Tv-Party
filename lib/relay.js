// Room relay: the server knows nothing about games. It only forwards JSON
// messages between one "screen" (the TV) and many "ctrl" connections (phones)
// that share a 6-digit room code.
//
//   phone  --msg-->  room:<code>:screen  -->  TV      (stamped with from + cid)
//   TV     --msg-->  room:<code>:ctrl    -->  phones  (msg.to = player id to target one)

import { randomBytes } from 'node:crypto';

const MAX_MSG_BYTES = 1024;
const MAX_MSGS_PER_SEC = 90;
const PING_MS = 20_000;
const SERVER_ONLY = new Set(['hello', 'leave']); // message types only the server may send

const cleanRoom = (s) => String(s || '').replace(/\D/g, '').slice(0, 6);
const cleanId = (s) => String(s || '').replace(/[^\w-]/g, '').slice(0, 32);

export function attachRelay(wss, bus) {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', 'http://local');
    const role = url.searchParams.get('role');
    const room = cleanRoom(url.searchParams.get('room'));
    const id = cleanId(url.searchParams.get('id')) || randomBytes(6).toString('hex');
    const cid = randomBytes(4).toString('hex'); // unique per connection

    if (room.length !== 6 || (role !== 'screen' && role !== 'ctrl')) {
      ws.close(4000, 'bad params');
      return;
    }

    const toScreen = `room:${room}:screen`;
    const toCtrl = `room:${room}:ctrl`;
    const inbox = role === 'screen' ? toScreen : toCtrl;
    const outbox = role === 'screen' ? toCtrl : toScreen;

    const unsubscribe = bus.subscribe(inbox, (msg) => {
      if (role === 'ctrl' && msg.to && msg.to !== id) return; // targeted at another phone
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    });

    // "hello" means: you're subscribed, messages to you will now arrive.
    // Clients wait for it before sending anything (avoids losing the first reply).
    Promise.resolve(unsubscribe.ready).then(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'hello', id, cid, room, role }));
    });

    // Simple per-connection rate limit.
    let windowStart = Date.now();
    let count = 0;

    ws.on('message', (data, isBinary) => {
      if (isBinary || data.length > MAX_MSG_BYTES) return;
      const now = Date.now();
      if (now - windowStart > 1000) { windowStart = now; count = 0; }
      if (++count > MAX_MSGS_PER_SEC) return;

      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      if (SERVER_ONLY.has(msg.t)) return; // a phone must not fake "hello" / "leave" to the TV

      if (role === 'ctrl') {
        msg.from = id; // phones can't spoof each other
        msg.cid = cid;
        delete msg.to;
      }
      bus.publish(outbox, msg);
    });

    // Keep the connection warm through proxies / NAT.
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      try { ws.ping(); } catch {}
    }, PING_MS);

    ws.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      if (role === 'ctrl') bus.publish(toScreen, { t: 'leave', from: id, cid });
    });
    ws.on('error', () => {});
  });
}
