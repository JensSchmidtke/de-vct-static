/*
 * RoomKit.SupabaseBackend: the same methods as LocalBackend, on a Supabase project prepared with supabase.sql.
 * Every action is one rpc call to an rk_ function. After a change the page sends a small "tick" over a Supabase
 * Realtime broadcast channel (rk:CODE); every screen in the room then fetches the room again (at most about
 * every 150 ms), and a slow poll every 6 s catches anything missed. Needs the supabase-js library, loaded on first use.
 */
(function (global) {
  'use strict';
  var LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  var POLL_MS = 6000, DEBOUNCE_MS = 150;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (global.supabase && global.supabase.createClient) return resolve();
      var s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error('library')); };
      document.head.appendChild(s);
    });
  }

  function SupabaseBackend(cfg) { this.cfg = cfg; this.clientP = null; this.rooms = {}; }

  SupabaseBackend.prototype._client = function () {
    var cfg = this.cfg;
    if (!this.clientP) this.clientP = loadScript(LIB).then(function () {
      return global.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { params: { eventsPerSecond: 10 } } });
    });
    return this.clientP;
  };
  SupabaseBackend.prototype._rpc = function (fn, args) {
    return this._client().then(function (c) { return c.rpc(fn, args); }).then(function (r) {
      if (r.error) throw new Error(r.error.message || 'server');
      return r.data;
    });
  };

  // one broadcast channel, poll timer and set of listeners per room code
  SupabaseBackend.prototype._room = function (code) {
    var self = this, r = this.rooms[code];
    if (r) return r;
    r = this.rooms[code] = { cbs: [], timer: null, poll: null, ch: null, busy: false, again: false };
    r.ready = this._client().then(function (c) {
      return new Promise(function (resolve) {
        r.ch = c.channel('rk:' + code, { config: { broadcast: { self: false } } });
        r.ch.on('broadcast', { event: 'tick' }, function () { self._refresh(code); }).subscribe(function (st) { if (st === 'SUBSCRIBED') resolve(); });
        setTimeout(resolve, 4000);
      });
    }, function () {});
    return r;
  };
  SupabaseBackend.prototype._refresh = function (code) {
    var self = this, r = this.rooms[code];
    if (!r || r.timer) return;
    r.timer = setTimeout(function run() {
      r.timer = null;
      if (r.busy) { r.again = true; return; }
      r.busy = true;
      self.getState(code).then(function (s) { r.cbs.slice().forEach(function (cb) { cb(s); }); }, function () {}).then(function () {
        r.busy = false;
        if (r.again) { r.again = false; self._refresh(code); }
      });
    }, DEBOUNCE_MS);
  };
  SupabaseBackend.prototype._tick = function (code) {
    var r = this._room(code);
    this._refresh(code);
    r.ready.then(function () { if (r.ch) r.ch.send({ type: 'broadcast', event: 'tick', payload: {} }); });
  };

  SupabaseBackend.prototype.getState = function (code) {
    var t0 = Date.now();
    return this._rpc('rk_state', { p_code: String(code).toUpperCase() }).then(function (s) {
      if (s && s.now) global.RoomKit.setClockOffset(s.now - (t0 + Date.now()) / 2);
      return s || null;
    });
  };
  SupabaseBackend.prototype.subscribe = function (code, cb) {
    var self = this, r = this._room(code);
    r.cbs.push(cb);
    if (!r.poll) r.poll = setInterval(function () { self._refresh(code); }, POLL_MS);
    this._refresh(code);
    return function () {
      r.cbs = r.cbs.filter(function (f) { return f !== cb; });
      if (!r.cbs.length) {
        clearInterval(r.poll); clearTimeout(r.timer); delete self.rooms[code];
        self._client().then(function (c) { if (r.ch) c.removeChannel(r.ch); });
      }
    };
  };

  SupabaseBackend.prototype.createRoom = function (o) {
    return this._rpc('rk_create_room', { p_name: o.name || '', p_game: o.game || '', p_data: o.data || {} });
  };
  SupabaseBackend.prototype.join = function (code, nickname, team) {
    var self = this; code = String(code).toUpperCase();
    return this._rpc('rk_join', { p_code: code, p_nick: String(nickname || ''), p_team: team == null ? null : team }).then(function (p) { self._tick(code); return p; });
  };
  SupabaseBackend.prototype.submit = function (code, player, payload, id) {
    var self = this;
    return this._rpc('rk_submit', { p_code: code, p_player: player.id, p_secret: player.secret, p_payload: payload, p_cid: id || null }).then(function () { self._tick(code); });
  };
  SupabaseBackend.prototype.updateRoom = function (code, token, patch) {
    var self = this;
    return this._rpc('rk_update_room', { p_code: code, p_token: token, p_patch: patch }).then(function () { self._tick(code); });
  };
  SupabaseBackend.prototype.decide = function (code, token, d) {
    var self = this;
    return this._rpc('rk_decide', { p_code: code, p_token: token, p_round: d.round, p_key: d.key, p_accepted: !!d.accepted }).then(function () { self._tick(code); });
  };
  SupabaseBackend.prototype.removePlayer = function (code, token, playerId) {
    var self = this;
    return this._rpc('rk_remove_player', { p_code: code, p_token: token, p_player: playerId }).then(function () { self._tick(code); });
  };
  SupabaseBackend.prototype.deleteRoom = function (code, token) {
    var self = this;
    return this._rpc('rk_delete_room', { p_code: code, p_token: token }).then(function () { self._tick(code); });
  };

  global.RoomKit.SupabaseBackend = SupabaseBackend;
})(window);
