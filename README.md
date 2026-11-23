# TV Party

An AirConsole-style starter: the **TV's web browser is the console**, **phones are the controllers**.
Hosted entirely on **Vercel** (static pages + a WebSocket Function), with **Redis** as the message bus.

```
 Phone (/play) ──ws──▶ Vercel Function /api/ws ──▶ Redis pub/sub ──▶ Vercel Function /api/ws ──ws──▶ TV (/tv)
                         (any instance)                              (any instance)
```

The TV page opens a room with a 6-digit code and a QR code. Phones scan it (or open `/play`
and type the code) and the TV runs the game. The TV tells each phone which controller to show,
so `/play` works for every game. Two games are included:

- **Star Grab** (`/tv`): a joystick and a DASH button. Grab stars, dash into friends to steal a point,
  and the first to 15 wins.
- **Monster Masher** (`/masher`): made for kids, with Indonesian on-screen words, big colours and icons,
  and very little reading. Rounds alternate between **Balapan** (a kart race to the finish line) and
  **Lawan Monster** (everyone fights a giant monster with a health bar before the time runs out). Each
  round is a chain of short challenges that the phone shows one at a time:
  - **TEKAN!** Mash the big coloured button to drive or punch.
  - **GOYANG!** Shake the phone to fill the rocket meter. Rubbing the screen also works, for phones
    without motion sensors and for plain-http dev, where browsers block the accelerometer.
  - **PERISAI** Pick the shield that matches the TV (each colour also has its own shape). In a race, a
    correct shield gives a boost and a wrong one spins you out. In a monster fight, the right shield blocks
    the attack; everyone else gets dizzy and the monster heals.

  Race podium and monster wins give ★ stars, which carry over between rounds.

Switching games in the same TV browser tab keeps the room code, so phones follow along without re-joining.

## Deploy to Vercel

1. Push this folder to a GitHub repo, then in Vercel choose **Add New → Project** and import it.
   The framework preset is **Other**. There is no build step.
2. Add Redis: in the project go to **Storage**, open the Marketplace, add **Redis** (Upstash or Redis Cloud) and connect it
   to the project. This sets `REDIS_URL` (or `KV_URL`, which is also accepted).
   Pick the **Singapore** region for Redis so it sits next to the Function region (`sin1` in `vercel.json`).
3. Deploy. Then:
   - On the TV: open `https://<your-app>.vercel.app/tv`
   - On phones: scan the QR code, or open `https://<your-app>.vercel.app/play`

CLI alternative: `npm i -g vercel && vercel` then `vercel --prod`.

> **Why Redis?** Vercel can run several instances of a Function, and the TV and a phone may
> connect to different ones. Redis pub/sub links them. Without Redis it falls back to an
> in-memory bus, which works locally but will randomly fail to connect players in production.

## Run locally

```bash
fnm use                # picks Node 20 from .node-version (fnm install 20 if missing)
npm install
npm run dev            # http://localhost:3000/tv
```

The console prints `http://<your-LAN-ip>:3000/tv` and `/play` URLs. Open the TV page through the
LAN address (not `localhost`) so its QR code points somewhere phones on the same Wi-Fi can reach.
On a laptop, the controller also accepts arrow keys/WASD plus Space (Star Grab), or Space = tap,
S = shake, 1–4 = shield (Monster Masher). On the TV, Enter/OK starts Monster Masher straight from the lobby.

Tests (the second run simulates the TV and phones landing on *different* Vercel instances):

```bash
npm test
REDIS_URL=redis://localhost:6379 npm test
```

## Files

| File | What it is |
|---|---|
| `api/ws.js` | Vercel WebSocket Function. It is a game-agnostic relay. |
| `lib/relay.js` | Room logic: `screen` ↔ `ctrl` routing, sender stamping, rate limit, heartbeats |
| `lib/bus.js` | Redis pub/sub bus, with an in-memory fallback |
| `api/qr.js` | `/api/qr?room=123456` returns an SVG QR code for the join link |
| `public/tv.html` | TV page: lobby + the Star Grab game (canvas) |
| `public/masher.html` | TV page: lobby + the Monster Masher game (canvas) |
| `public/play.html` | Phone controller for every game: joystick + button (Star Grab) or tap / shake / shield (Monster Masher), vibration, wake lock |
| `public/net.js` | Reconnecting WebSocket client used by both pages |
| `dev.js` | Local server that mirrors the Vercel routes |

## Message protocol (to build your own games)

The server only relays JSON. The TV page decides everything.

| Direction | Message | Notes |
|---|---|---|
| server → any | `{t:'hello', id, cid}` | You're subscribed, so you can start sending |
| phone → TV | `{t:'join', name}` | Server adds `from` (player id) and `cid` (connection id) |
| phone → TV | `{t:'in', x, y, a}` | Joystick −1..1 and button. Sent on change (≤30/s) plus a 1 s keepalive |
| server → TV | `{t:'leave', from, cid}` | Ignore it if `cid` is older than the player's latest connection |
| TV → phones | `{t:'screen-online'}` | Broadcast. Phones re-send `join` |
| TV → one phone | `{..., to: playerId}` | e.g. `welcome`, `score`, `buzz` (vibrate) |
| TV → one phone | `{t:'welcome', game, color, name, score}` | `game` picks the controller: missing = joystick, `'masher'` = Monster Masher |

Monster Masher adds:

| Direction | Message | Notes |
|---|---|---|
| TV → phones | `{t:'task', kind, color, options, delay, ms}` | `kind` is `tap`, `shake`, `shield` or `wait` (with `icon`). The phone shows "SIAP…" for `delay` ms, then accepts input for `ms` ms |
| phone → TV | `{t:'act', k:'tap'}` | One per tap. The TV counts at most 14 actions per second per player |
| phone → TV | `{t:'act', k:'shake', p}` | Shake strength 0..1, sent every 100 ms while shaking |
| phone → TV | `{t:'act', k:'pick', c}` | Chosen shield colour (`red`, `blue`, `green` or `yellow`). The TV answers `{t:'res', ok}` |

To make a new game, copy `tv.html` (or `masher.html`), keep the networking block, and replace the simulation
and rendering. To add a new controller layout, add a screen to `play.html` and have your TV send its
`game` name in `welcome`.

## Things to know

- **Connections reset every 5 min** on Hobby, because a Vercel Function has a maximum duration (`maxDuration`,
  up to 800 s on Pro). Both pages reconnect within about a second and players keep their scores.
  You may see a brief "reconnecting" flash.
- **Latency:** every input goes phone → Vercel (Singapore) → Redis → Vercel → TV, so expect
  roughly 30–80 ms from Indonesia. That is fine for party games and too slow for fighting games.
  For lower latency, a later step could use WebRTC data channels (peer-to-peer on the same Wi-Fi)
  and keep this WebSocket relay only for signalling and as a fallback.
- **Cost:** WebSockets use normal Function billing. Memory is billed while connections are open, and
  CPU only while messages are being processed. A few living-room sessions should fit on Hobby, but check
  the Usage page after your first evenings.
- **Smart TV browsers** vary. The TV page sticks to plain JS and Canvas 2D to maximise compatibility.
  If your TV's browser struggles, open `/tv` on a laptop connected over HDMI.
- Room codes are random 6-digit numbers with no collision check. That is fine for personal use. Add a
  Redis `SET NX` reservation if you open it to the public.
