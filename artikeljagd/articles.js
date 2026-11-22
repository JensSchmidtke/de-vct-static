/*
 * ArticleHunt: what the host page and the phone page share.
 * A round has a schedule: `seq` is the list of articles (m, f, n) in the order they come, one per `art` seconds, counted from
 * data.startedAt (server time). The phone shows the article of the current slot and sends { w: word, s: slot } for every click.
 * The host replays the clicks to score them: a click is a hit if the word has the gender of that slot's article; a wrong click
 * freezes that player for `pen` seconds, and clicks inside the freeze are ignored.
 */
(function (global) {
  'use strict';

  var ART = { m: 'der', f: 'die', n: 'das' };
  var GRID = 20, MIN_MATCH = 4;                      // words on a phone's grid; at least this many always match the article
  var ART_SECONDS = 15, PENALTY_SECONDS = 3;         // the timing of a round (the host puts them into the room's data)

  function loadBank() {
    return fetch('nouns.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('nouns'); return r.json(); }).then(function (d) { return d.words; });
  }
  function genderMap(bank) { var m = {}; bank.forEach(function (w) { m[w[0]] = w[1]; }); return m; }

  function makeSeq(duration, art) {                  // random articles, never the same twice in a row
    var n = Math.ceil(duration / art) + 1, seq = [], g = ['m', 'f', 'n'];
    for (var i = 0; i < n; i++) {
      var opts = g.filter(function (x) { return x !== seq[i - 1]; });
      seq.push(opts[Math.floor(Math.random() * opts.length)]);
    }
    return seq;
  }
  function slotAt(startedAt, art, now) { return Math.max(0, Math.floor((now - startedAt) / (art * 1000))); }

  // one row per player for a round, best first: points = hits; ties go to fewer wrong clicks
  function evaluate(snap, round, gmap) {
    var d = snap.room.data, seq = (d.seqs && d.seqs[round]) || [], pen = (d.pen || PENALTY_SECONDS) * 1000, rows = {};
    snap.players.forEach(function (p) { rows[p.id] = { player: p, points: 0, wrong: 0, lockUntil: 0 }; });
    snap.submissions.slice().sort(function (a, b) { return a.at - b.at; }).forEach(function (s) {
      var r = rows[s.playerId], pl = s.payload || {};
      if (!r || s.round !== round || s.at < r.lockUntil) return;
      var g = gmap[pl.w], slot = pl.s;
      if (!g || typeof slot !== 'number' || slot < 0 || slot >= seq.length) return;
      if (g === seq[slot]) r.points++; else { r.wrong++; r.lockUntil = s.at + pen; }
    });
    return Object.keys(rows).map(function (k) { return rows[k]; }).sort(function (a, b) {
      return b.points - a.points || a.wrong - b.wrong || a.player.nickname.localeCompare(b.player.nickname);
    });
  }

  global.ArticleHunt = { ART: ART, GRID: GRID, MIN_MATCH: MIN_MATCH, ART_SECONDS: ART_SECONDS, PENALTY_SECONDS: PENALTY_SECONDS,
    loadBank: loadBank, genderMap: genderMap, makeSeq: makeSeq, slotAt: slotAt, evaluate: evaluate };
})(window);
