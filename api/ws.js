// Vercel Function that accepts WebSocket connections at /api/ws
// Docs: https://vercel.com/docs/functions/websockets
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createBus } from '../lib/bus.js';
import { attachRelay } from '../lib/relay.js';

const bus = createBus();
if (bus.kind === 'memory') {
  console.warn('[tv-party] REDIS_URL / KV_URL not set: using in-memory bus. TV and phones may not see each other if Vercel runs more than one instance.');
}

const server = http.createServer((req, res) => {
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('Expected a WebSocket connection');
});

attachRelay(new WebSocketServer({ server }), bus);

export default server;
