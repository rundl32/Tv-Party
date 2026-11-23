// Tiny reconnecting WebSocket client shared by the TV and phone pages.
// Vercel closes WebSockets when the function hits maxDuration (5 min on Hobby),
// so reconnecting quietly is part of normal operation, not an error path.
(function () {
  function RoomSocket(params, handlers) {
    this.params = params;
    this.h = handlers || {};
    this.delay = 500;
    this.closed = false;
    this.ws = null;
    this.connect();
  }

  RoomSocket.prototype.url = function () {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var q = Object.keys(this.params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(this.params[k]);
    }, this).join('&');
    return proto + location.host + '/api/ws?' + q;
  };

  RoomSocket.prototype.connect = function () {
    var self = this;
    var ws = new WebSocket(this.url());
    this.ws = ws;
    // We treat the server's "hello" (not the socket's onopen) as "connected":
    // it arrives once the server has subscribed us to the room.
    this.ready = false;
    ws.onmessage = function (e) {
      if (ws !== self.ws) return;
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.t === 'hello') {
        self.delay = 500;
        self.ready = true;
        if (self.h.open) self.h.open(msg);
        return;
      }
      if (self.h.message) self.h.message(msg);
    };
    ws.onclose = function (e) {
      if (ws !== self.ws) return;
      self.ready = false;
      if (self.h.close) self.h.close(e);
      if (self.closed || e.code === 4000) return;
      var wait = self.delay + Math.random() * 300; // jitter
      self.delay = Math.min(self.delay * 2, 8000);
      setTimeout(function () { if (!self.closed) self.connect(); }, wait);
    };
    ws.onerror = function () {};
  };

  RoomSocket.prototype.send = function (msg) {
    if (this.ws && this.ws.readyState === 1 && this.ready) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  };

  RoomSocket.prototype.isOpen = function () {
    return !!this.ws && this.ws.readyState === 1 && this.ready;
  };

  RoomSocket.prototype.close = function () {
    this.closed = true;
    if (this.ws) this.ws.close();
  };

  window.RoomSocket = RoomSocket;

  window.store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
})();
