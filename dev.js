// Local dev server: serves public/, /api/qr and the WebSocket relay on one port.
//   npm install && npm run dev  ->  http://localhost:3000
// Phones on the same Wi-Fi can open http://<your-computer-ip>:3000/play
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createBus } from './lib/bus.js';
import { attachRelay } from './lib/relay.js';
import qrHandler from './api/qr.js';

const PORT = Number(process.env.PORT) || 3000;
// import.meta.dirname only exists from Node 20.11; package.json allows any Node 20.
const ROOT = fileURLToPath(new URL('./public', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  if (path === '/api/qr') return qrHandler(req, res);

  // cleanUrls: /tv -> tv.html, / -> index.html
  let file = path === '/' ? '/index.html' : path;
  if (!extname(file)) file += '.html';
  const full = normalize(join(ROOT, file));
  if (!full.startsWith(ROOT + sep)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'content-type': TYPES[extname(full)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

const bus = createBus();
attachRelay(new WebSocketServer({ server, path: '/api/ws' }), bus);

server.listen(PORT, () => {
  console.log(`tv-party dev server (bus: ${bus.kind})`);
  console.log(`  TV:    http://localhost:${PORT}/tv   (QR code only works for this computer)`);
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // The TV page builds its QR code / join hint from its own address, so open
      // it via the LAN IP if phones should be able to scan it.
      console.log(`  TV:    http://${a.address}:${PORT}/tv   (QR code works for phones on this Wi-Fi)`);
      console.log(`  Phone: http://${a.address}:${PORT}/play`);
    }
  }
});
