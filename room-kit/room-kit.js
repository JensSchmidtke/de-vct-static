/*
 * RoomKit: reusable room / player / submission objects for classroom games.
 *
 * A teacher (Host) opens a room, students (Players) join it with a nickname and send submissions
 * (whatever the game defines as a payload); the host screen reads the room and scores it. The kit knows
 * nothing about any game. A game supplies the payloads and a scoring rule.
 *
 *   var backend = RoomKit.makeBackend();             // Supabase when room-kit-config.js is filled in, else a same-browser test backend
 *   var host = new RoomKit.Host(backend);
 *   host.create('7a', 'my-game', { ...settings });   // Promise of { code, token }
 *   host.subscribe(function (snapshot) { ... });     // snapshot = { room, players, submissions, decisions } or null
 *   host.startRound({ ...round settings });          // room.status 'running', room.round + 1
 *   host.endRound();                                 // room.status 'ended'
 *   host.decide(round, key, true);                   // the teacher accepts an answer the game did not recognise
 *   host.removePlayer(id);  host.deleteRoom();       // deleting removes the room, its players and submissions
 *
 *   var player = new RoomKit.Player(backend);
 *   player.join(code, 'Nickname', teamOrNull);       // Promise; rejects with 'room-not-found', 'nickname-taken', 'bad-nickname', 'room-full'
 *   player.submit({ ...payload });                   // only while the room is running
 *   player.subscribe(function (snapshot) { ... });
 *
 *   RoomKit.Scoring.tally(snapshot, round, rule)     // rule(submission) -> { key, points } or null; each key counts once per player
 *   RoomKit.Scoring.totals(snapshot, ruleForRound)   // the same over all rounds
 *   RoomKit.qr(element, text), RoomKit.Clock(...)    // small helpers
 *
 * Backend interface (every backend implements it, so a game never changes; each method may return its value or a Promise):
 *   createRoom({name, game, data}) -> {code, token}      getState(code) -> snapshot | null
 *   subscribe(code, callback) -> unsubscribe               join(code, nickname, team) -> player (with a secret)
 *   submit(code, player, payload, id, round)               updateRoom(code, token, patch)
 *   decide(code, token, {round, key, accepted})            removePlayer(code, token, playerId)
 *   deleteRoom(code, token)
 * RoomKit.now() is the time of the server (set by a server backend, since phones' clocks differ); use it for round starts and clocks.
 * Host and Player show their own actions at once (optimistic) and settle with the server's snapshot.
 * Options for busy games: new Player(backend, { light: true }) gets the room and the players but not everybody's submissions;
 * new Host(backend, { pollMs: 1500 }) fetches the room that often; player.submit(payload, { quiet: true }) does not announce
 * the submission to the room (the host's polling picks it up). Both keep a server backend within its message limits.
 */
(function (global) {
  'use strict';

  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';      // no 0/O, 1/I
  var ROOM_TTL = 24 * 3600 * 1000;                           // rooms older than a day are removed
  var PREFIX = 'roomkit:room:';

  function randomString(n, chars) {
    var s = '';
    for (var i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
  }
  function uid() { return randomString(12, 'abcdefghijklmnopqrstuvwxyz0123456789'); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function lsGet(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { global.localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { global.localStorage.removeItem(k); } catch (e) {} }
  function ssGet(k) { try { return global.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { global.sessionStorage.setItem(k, v); } catch (e) {} }
  function ssDel(k) { try { global.sessionStorage.removeItem(k); } catch (e) {} }

  /* ------------------------------------------------------------------ local backend */
  // Keeps every room in localStorage and tells other tabs through BroadcastChannel, so a host tab and
  // player tabs of the same browser can play together. Meant for testing: the teacher token is stored in the clear.

  function LocalBackend() {
    var self = this;
    this.listeners = {};
    this.channel = ('BroadcastChannel' in global) ? new global.BroadcastChannel('roomkit') : null;
    if (this.channel) this.channel.onmessage = function (e) { self._notify(e.data && e.data.code, true); };
    global.addEventListener('storage', function (e) {
      if (e.key && e.key.indexOf(PREFIX) === 0) self._notify(e.key.slice(PREFIX.length), true);
    });
  }
  LocalBackend.prototype._load = function (code) {
    var raw = lsGet(PREFIX + code);
    return raw ? JSON.parse(raw) : null;
  };
  LocalBackend.prototype._save = function (code, state) {
    lsSet(PREFIX + code, JSON.stringify(state));
    this._notify(code, false);
    if (this.channel) this.channel.postMessage({ code: code });
  };
  LocalBackend.prototype._notify = function (code) {
    var snap = this.getState(code), list = this.listeners[code] || [];
    list.slice().forEach(function (cb) { cb(snap); });
  };
  LocalBackend.prototype._cleanup = function () {
    try {
      for (var i = global.localStorage.length - 1; i >= 0; i--) {
        var k = global.localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) {
          var st = JSON.parse(global.localStorage.getItem(k));
          if (!st || Date.now() - st.room.createdAt > ROOM_TTL) global.localStorage.removeItem(k);
        }
      }
    } catch (e) {}
  };
  LocalBackend.prototype.createRoom = function (opts) {
    this._cleanup();
    var code;
    do { code = randomString(5, CODE_CHARS); } while (this._load(code));
    var token = uid();
    this._save(code, {
      token: token,
      room: { code: code, name: opts.name || '', game: opts.game || '', status: 'lobby', round: 0, data: clone(opts.data) || {}, createdAt: Date.now() },
      players: [], submissions: [], decisions: []
    });
    return { code: code, token: token };
  };
  LocalBackend.prototype.getState = function (code) {
    var st = this._load(code);
    if (!st) return null;
    delete st.token;
    return st;
  };
  LocalBackend.prototype.subscribe = function (code, cb) {
    var self = this;
    (this.listeners[code] = this.listeners[code] || []).push(cb);
    setTimeout(function () { cb(self.getState(code)); }, 0);
    return function () { self.listeners[code] = (self.listeners[code] || []).filter(function (f) { return f !== cb; }); };
  };
  LocalBackend.prototype._mustHost = function (code, token) {
    var st = this._load(code);
    if (!st) throw new Error('room-not-found');
    if (st.token !== token) throw new Error('not-allowed');
    return st;
  };
  LocalBackend.prototype.join = function (code, nickname, team) {
    var st = this._load(code);
    if (!st) throw new Error('room-not-found');
    var nick = String(nickname || '').replace(/\s+/g, ' ').trim();
    if (!nick || nick.length > 20) throw new Error('bad-nickname');
    var key = nick.toLowerCase();
    if (st.players.some(function (p) { return p.nickname.toLowerCase() === key; })) throw new Error('nickname-taken');
    var player = { id: uid(), nickname: nick, team: team == null ? null : team, joinedAt: Date.now() };
    st.players.push(player);
    this._save(code, st);
    return player;
  };
  LocalBackend.prototype.submit = function (code, player, payload, id) {
    var playerId = player && player.id ? player.id : player;
    var st = this._load(code);
    if (!st) throw new Error('room-not-found');
    if (!st.players.some(function (p) { return p.id === playerId; })) throw new Error('not-joined');
    if (st.room.status !== 'running') throw new Error('not-running');
    st.submissions.push({ id: id || uid(), playerId: playerId, round: st.room.round, payload: clone(payload), at: Date.now() });
    this._save(code, st);
  };
  LocalBackend.prototype.updateRoom = function (code, token, patch) {
    var st = this._mustHost(code, token);
    Object.keys(patch).forEach(function (k) { st.room[k] = clone(patch[k]); });
    this._save(code, st);
  };
  LocalBackend.prototype.decide = function (code, token, d) {
    var st = this._mustHost(code, token);
    st.decisions = st.decisions.filter(function (x) { return !(x.round === d.round && x.key === d.key); });
    st.decisions.push({ round: d.round, key: d.key, accepted: !!d.accepted, at: Date.now() });
    this._save(code, st);
  };
  LocalBackend.prototype.removePlayer = function (code, token, playerId) {
    var st = this._mustHost(code, token);
    st.players = st.players.filter(function (p) { return p.id !== playerId; });
    st.submissions = st.submissions.filter(function (s) { return s.playerId !== playerId; });
    this._save(code, st);
  };
  LocalBackend.prototype.deleteRoom = function (code, token) {
    this._mustHost(code, token);
    lsDel(PREFIX + code);
    this._notify(code);
    if (this.channel) this.channel.postMessage({ code: code });
  };

  /* ------------------------------------------------------------------ host and player */
  // Host and Player keep the latest snapshot of their room (state()) and apply their own actions to it at once,
  // so a screen reacts without waiting for a server. Calls that need an answer (create, join, resume) return Promises;
  // the others return a Promise too, but a game may ignore it. Backends may answer directly or with a Promise.

  var clockOffset = 0;                                       // server time minus this device's time, set by a server backend
  function now() { return Date.now() + clockOffset; }

  function Session(backend, opts) { this.backend = backend; this.opts = opts || {}; this.code = null; this.snap = null; this.listeners = []; this.pending = []; this.unsub = null; }
  Session.prototype._attach = function (code, snap) {
    var self = this;
    this.code = code; this.snap = snap || null;
    if (this.unsub) this.unsub();
    this.unsub = this.backend.subscribe(code, function (s) { self._receive(s); }, this.opts);
  };
  Session.prototype._receive = function (s) {
    s = clone(s);
    if (s) this.pending = this.pending.filter(function (p) { if (p.done) return false; p.apply(s); return true; });
    this.snap = s;
    this.listeners.slice().forEach(function (cb) { cb(s); });
  };
  // run `apply` on the current snapshot now, and `call` on the backend; the change stays applied until the server catches up
  Session.prototype._act = function (apply, call) {
    var self = this, p = { apply: apply, done: false };
    if (this.snap) { this.snap = clone(this.snap); apply(this.snap); this.pending.push(p); this.listeners.slice().forEach(function (cb) { cb(self.snap); }); }
    return Promise.resolve().then(call).then(function (r) { p.done = true; return r; }, function (e) {
      p.done = true;
      Promise.resolve(self.backend.getState(self.code, self.opts)).then(function (s) { self._receive(s); });     // undo the guess
      throw e;
    });
  };
  Session.prototype.state = function () { return this.snap; };
  Session.prototype.subscribe = function (cb) {
    var self = this;
    this.listeners.push(cb);
    setTimeout(function () { if (self.listeners.indexOf(cb) >= 0 && self.snap) cb(self.snap); }, 0);
    return function () { self.listeners = self.listeners.filter(function (f) { return f !== cb; }); };
  };
  Session.prototype._close = function () { if (this.unsub) this.unsub(); this.unsub = null; this.listeners = []; this.pending = []; };

  function Host(backend, opts) { Session.call(this, backend, opts); this.token = null; }
  Host.prototype = Object.create(Session.prototype);
  Host.prototype.create = function (name, game, data) {
    var self = this;
    return Promise.resolve().then(function () { return self.backend.createRoom({ name: name, game: game, data: data }); }).then(function (r) {
      self.token = r.token;
      ssSet('roomkit:host:' + game, JSON.stringify(r));
      return Promise.resolve(self.backend.getState(r.code, self.opts)).then(function (s) { self._attach(r.code, s); return r; });
    });
  };
  Host.prototype.resume = function (game) {       // after a reload of the host page: Promise of true, or false if the room is gone
    var self = this, raw = ssGet('roomkit:host:' + game);
    if (!raw) return Promise.resolve(false);
    var r = JSON.parse(raw);
    return Promise.resolve().then(function () { return self.backend.getState(r.code, self.opts); }).then(function (s) {
      if (!s) { ssDel('roomkit:host:' + game); return false; }
      self.token = r.token; self._attach(r.code, s);
      return true;
    }, function () { return false; });
  };
  Host.prototype._update = function (patch) {
    var self = this;
    return this._act(function (s) { Object.keys(patch).forEach(function (k) { s.room[k] = clone(patch[k]); }); },
                     function () { return self.backend.updateRoom(self.code, self.token, patch); });
  };
  Host.prototype.startRound = function (data) {
    var st = this.snap;
    return this._update({ status: 'running', round: st.room.round + 1, data: Object.assign({}, st.room.data, data || {}, { startedAt: now() }) });
  };
  Host.prototype.endRound = function () { return this._update({ status: 'ended' }); };
  Host.prototype.setData = function (patch) { return this._update({ data: Object.assign({}, this.snap.room.data, patch) }); };
  Host.prototype.decide = function (round, key, accepted) {
    var self = this, d = { round: round, key: key, accepted: !!accepted };
    return this._act(function (s) {
      s.decisions = s.decisions.filter(function (x) { return !(x.round === round && x.key === key); });
      s.decisions.push({ round: round, key: key, accepted: !!accepted, at: now() });
    }, function () { return self.backend.decide(self.code, self.token, d); });
  };
  Host.prototype.removePlayer = function (id) {
    var self = this;
    return this._act(function (s) {
      s.players = s.players.filter(function (p) { return p.id !== id; });
      s.submissions = s.submissions.filter(function (x) { return x.playerId !== id; });
    }, function () { return self.backend.removePlayer(self.code, self.token, id); });
  };
  Host.prototype.deleteRoom = function (game) {
    var self = this, code = this.code, token = this.token;
    if (game) ssDel('roomkit:host:' + game);
    this._close(); this.code = this.token = this.snap = null;
    var b = this.backend;
    return Promise.resolve().then(function () { return b.deleteRoom(code, token); });
  };

  function Player(backend, opts) { Session.call(this, backend, opts); this.player = null; }
  Player.prototype = Object.create(Session.prototype);
  Player.prototype.join = function (code, nickname, team) {
    var self = this;
    code = String(code || '').toUpperCase();
    return Promise.resolve().then(function () { return self.backend.join(code, nickname, team); }).then(function (p) {
      self.player = p;
      ssSet('roomkit:player:' + code, JSON.stringify(p));
      return Promise.resolve(self.backend.getState(code, self.opts)).then(function (s) { self._attach(code, s); return p; });
    });
  };
  Player.prototype.resume = function (code) {     // Promise of true, or false if not (or no longer) joined
    var self = this;
    code = String(code || '').toUpperCase();
    var raw = ssGet('roomkit:player:' + code);
    if (!raw) return Promise.resolve(false);
    return Promise.resolve().then(function () { return self.backend.getState(code, self.opts); }).then(function (snap) {
      var p = JSON.parse(raw);
      if (!snap || !snap.players.some(function (x) { return x.id === p.id; })) { ssDel('roomkit:player:' + code); return false; }
      self.player = p; self._attach(code, snap);
      return true;
    }, function () { return false; });
  };
  Player.prototype.submit = function (payload, o) {      // throws 'not-running' at once if the round is over; o.quiet: do not announce it to the room
    var self = this, me = this.player;
    if (!this.snap || this.snap.room.status !== 'running') throw new Error('not-running');
    var sub = { id: me.id + ':' + uid(), playerId: me.id, round: this.snap.room.round, payload: clone(payload), at: now() };
    return this._act(function (s) { if (!s.submissions.some(function (x) { return x.id === sub.id; })) s.submissions.push(clone(sub)); },
                     function () { return self.backend.submit(self.code, me, payload, sub.id, sub.round, o); });
  };
  Player.prototype.forget = function () { ssDel('roomkit:player:' + this.code); this._close(); this.player = null; this.snap = null; };

  /* ------------------------------------------------------------------ scoring */

  var Scoring = {
    // One row per player: the points of the distinct keys the rule accepts in this round, best first.
    tally: function (snapshot, round, rule) {
      var rows = {};
      snapshot.players.forEach(function (p) { rows[p.id] = { player: p, points: 0, count: 0, keys: {} }; });
      snapshot.submissions.forEach(function (s) {
        if (s.round !== round || !rows[s.playerId]) return;
        var r = rule(s), t = rows[s.playerId];
        if (!r || t.keys[r.key]) return;
        t.keys[r.key] = r.points; t.points += r.points; t.count++;
      });
      return Scoring.sort(Object.keys(rows).map(function (k) { return rows[k]; }));
    },
    // The same over all rounds so far; `ruleForRound(round)` returns that round's rule.
    totals: function (snapshot, ruleForRound) {
      var rows = {};
      snapshot.players.forEach(function (p) { rows[p.id] = { player: p, points: 0, count: 0 }; });
      for (var r = 1; r <= snapshot.room.round; r++) {
        Scoring.tally(snapshot, r, ruleForRound(r)).forEach(function (t) { rows[t.player.id].points += t.points; rows[t.player.id].count += t.count; });
      }
      return Scoring.sort(Object.keys(rows).map(function (k) { return rows[k]; }));
    },
    sort: function (rows) {
      return rows.sort(function (a, b) {
        return b.points - a.points || b.count - a.count || a.player.nickname.localeCompare(b.player.nickname);
      });
    },
    leaders: function (rows) {          // everyone on the top score (several on a tie); none if nobody scored
      if (!rows.length || !rows[0].points) return [];
      return rows.filter(function (r) { return r.points === rows[0].points; });
    }
  };

  /* ------------------------------------------------------------------ helpers */

  // Draws a QR code into `el` with the qrcode-generator library if it is loaded, otherwise the link as text.
  function qr(el, text) {
    el.innerHTML = '';
    if (global.qrcode) {
      var q = global.qrcode(0, 'M'); q.addData(text); q.make();
      el.innerHTML = q.createSvgTag(6, 2);
      var svg = el.querySelector('svg'); if (svg) { svg.style.width = '100%'; svg.style.height = 'auto'; svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'QR code to join'); }
    } else {
      el.textContent = text;
    }
  }

  // Counts down from startedAt + durationMs; calls onTick(msLeft) about five times a second and onEnd() once.
  function Clock(startedAt, durationMs, onTick, onEnd) {
    var done = false, id = setInterval(function () {
      var left = Math.max(0, startedAt + durationMs - now());
      onTick(left);
      if (left <= 0 && !done) { done = true; clearInterval(id); if (onEnd) onEnd(); }
    }, 200);
    this.stop = function () { done = true; clearInterval(id); };
    onTick(Math.max(0, startedAt + durationMs - now()));
  }

  global.RoomKit = { LocalBackend: LocalBackend, Host: Host, Player: Player, Scoring: Scoring, qr: qr, Clock: Clock, randomString: randomString, uid: uid,
    now: now, setClockOffset: function (ms) { clockOffset = ms; },
    // the backend a page uses: Supabase when room-kit-config.js names a project, else the same-browser test backend
    makeBackend: function () {
      var c = global.ROOMKIT_CONFIG || {};
      return (c.supabaseUrl && c.supabaseKey && global.RoomKit.SupabaseBackend) ? new global.RoomKit.SupabaseBackend(c) : new LocalBackend();
    } };
})(window);
