// Message bus shared by every WebSocket connection.
//
// On Vercel, the TV and the phones in one room can land on different function
// instances, so messages must travel through Redis pub/sub. Without REDIS_URL
// we fall back to an in-memory bus, which is fine for local dev and for a
// single instance, but NOT reliable in production.

export function createBus(redisUrl = process.env.REDIS_URL || process.env.KV_URL) {
  return redisUrl ? redisBus(redisUrl) : memoryBus();
}

function memoryBus() {
  const subs = new Map(); // channel -> Set<fn>
  return {
    kind: 'memory',
    publish(channel, msg) {
      const set = subs.get(channel);
      if (!set) return;
      for (const fn of [...set]) fn(msg);
    },
    subscribe(channel, fn) {
      if (!subs.has(channel)) subs.set(channel, new Set());
      subs.get(channel).add(fn);
      const unsubscribe = () => {
        const set = subs.get(channel);
        if (!set) return;
        set.delete(fn);
        if (set.size === 0) subs.delete(channel);
      };
      unsubscribe.ready = Promise.resolve();
      return unsubscribe;
    },
  };
}

function redisBus(url) {
  let pub, sub;
  const handlers = new Map(); // channel -> Set<fn>
  const subscribed = new Map(); // channel -> Promise (resolves once SUBSCRIBE is confirmed)
  const whenReady = (c) => new Promise((resolve) => (c.status === 'ready' ? resolve() : c.once('ready', resolve)));

  // Lazy-load ioredis so local dev without Redis needs no connection.
  const ready = import('ioredis').then(({ default: Redis }) => {
    // ioredis re-subscribes to all channels automatically after a reconnect.
    pub = new Redis(url, { maxRetriesPerRequest: null, enableAutoPipelining: true });
    sub = new Redis(url, { maxRetriesPerRequest: null });
    for (const c of [pub, sub]) c.on('error', (e) => console.error('[redis]', e.message));
    sub.on('message', (channel, raw) => {
      const set = handlers.get(channel);
      if (!set) return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      for (const fn of [...set]) fn(msg);
    });
    return Promise.all([whenReady(pub), whenReady(sub)]);
  });

  return {
    kind: 'redis',
    publish(channel, msg) {
      ready.then(() => pub.publish(channel, JSON.stringify(msg))).catch((e) =>
        console.error('[redis publish]', e.message),
      );
    },
    subscribe(channel, fn) {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
        subscribed.set(
          channel,
          ready.then(() => sub.subscribe(channel)).catch((e) => console.error('[redis subscribe]', e.message)),
        );
      }
      set.add(fn);
      const unsubscribe = () => {
        const s = handlers.get(channel);
        if (!s) return;
        s.delete(fn);
        if (s.size === 0) {
          handlers.delete(channel);
          subscribed.delete(channel);
          ready.then(() => sub.unsubscribe(channel)).catch(() => {});
        }
      };
      unsubscribe.ready = subscribed.get(channel);
      return unsubscribe;
    },
    async close() {
      await ready;
      pub.disconnect();
      sub.disconnect();
    },
  };
}
