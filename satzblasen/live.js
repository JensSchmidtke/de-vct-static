/*
 * SentenceLive: the parts of the live sentence game (everyone plays on their own phone at the same time)
 * that the teacher page and the phone page share. A layout is { cells: [words], valid: [[cell, ...]], solution: [[cell, ...]] }
 * (see generator/generate_pool_a2_group.py and generate_level_pools.py); `valid` holds every chain of neighbouring cells
 * that forms a sentence. Each player connects chains on their own copy of the same grid.
 */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg', CELL = 100;

  function loadPool(file) {
    return fetch('grids/' + file, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('grid file'); return r.json(); });
  }

  function adjacent(a, b, cols) {          // horizontal, vertical and diagonal neighbours
    var dr = Math.abs(Math.floor(a / cols) - Math.floor(b / cols)), dc = Math.abs(a % cols - b % cols);
    return (dr || dc) && dr <= 1 && dc <= 1;
  }
  function textOf(layout, path) { return path.map(function (i) { return layout.cells[i]; }).join(' ').toLowerCase(); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function chainOk(layout, cols, path, used) {      // a real chain: distinct cells of the grid, neighbours, none already used
    if (!Array.isArray(path) || path.length < 2 || path.length > 12) return false;
    for (var i = 0; i < path.length; i++) {
      var c = path[i];
      if (typeof c !== 'number' || c < 0 || c >= layout.cells.length || path.indexOf(c) !== i || used[c]) return false;
      if (i && !adjacent(path[i - 1], c, cols)) return false;
    }
    return true;
  }

  // Every player's round, replayed from their submissions in order. A chain counts if it is on the layout's list (or the
  // teacher accepted its sentence) and uses no bubble the player already connected. { undo: [cells] } takes that sentence back.
  // Returns one row per player, best first: points = words connected; ties go to fewer wrong attempts, then the earlier finish.
  function evaluate(snap, round, layout, cols, endsAt) {
    var valid = {}, dec = {}, startedAt = snap.room.data.startedAt || 0;
    layout.valid.forEach(function (p) { valid[p.join(',')] = true; });
    snap.decisions.forEach(function (d) { if (d.round === round) dec[d.key] = d.accepted; });
    var rows = {}, rejected = {};
    snap.players.forEach(function (p) { rows[p.id] = { player: p, accepted: [], tips: [], times: [], used: {}, wrong: 0, last: null }; });
    snap.submissions.slice().sort(function (a, b) { return a.at - b.at; }).forEach(function (s) {
      var r = rows[s.playerId];
      if (!r || s.round !== round || (endsAt && s.at > endsAt + 2500)) return;
      var pl = s.payload || {};
      if (pl.undo) {                       // { undo: [cells] } takes back that very sentence, if the player has it
        var key0 = Array.isArray(pl.undo) ? pl.undo.join(',') : null, at = -1;
        r.accepted.forEach(function (p, i) { if (p.join(',') === key0) at = i; });
        if (at >= 0) {
          r.accepted.splice(at, 1)[0].forEach(function (c) { delete r.used[c]; }); r.times.splice(at, 1); r.tips.splice(at, 1);
          r.last = r.times.length ? r.times[r.times.length - 1] : null;
        }
        return;
      }
      if (!chainOk(layout, cols, pl.path, r.used)) { r.wrong++; return; }
      var text = textOf(layout, pl.path), key = pl.path.join(',');
      if ((valid[key] && dec[text] !== false) || dec[text] === true) {
        r.accepted.push(pl.path.slice()); r.times.push(s.at - startedAt);
        r.tips.push(snap.room.data.hints ? Math.max(0, Math.min(pl.path.length - 1, pl.tips | 0)) : 0);   // a tipped word scores no point
        pl.path.forEach(function (c) { r.used[c] = true; });
        r.last = s.at - startedAt;
      } else {
        r.wrong++;
        var e = rejected[text] = rejected[text] || { text: text, players: [], decision: dec[text] };
        if (e.players.indexOf(r.player.nickname) < 0) e.players.push(r.player.nickname);
      }
    });
    var out = Object.keys(rows).map(function (k) {
      var r = rows[k], pts = 0;
      r.accepted.forEach(function (p, i) { pts += p.length - r.tips[i]; });
      return { player: r.player, points: pts, sentences: r.accepted.length, wrong: r.wrong, last: r.last, accepted: r.accepted, used: r.used,
               solved: Object.keys(r.used).length === layout.cells.length };
    });
    out.sort(function (a, b) {
      return b.points - a.points || a.wrong - b.wrong || (a.last == null) - (b.last == null) || a.last - b.last || a.player.nickname.localeCompare(b.player.nickname);
    });
    return { rows: out, rejected: Object.keys(rejected).sort().map(function (k) { return rejected[k]; }) };
  }

  function el(name, attrs, text) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  // The grid in an <svg>. opts.onTap(cellIndex) makes the bubbles tappable. render(used, path) draws the current state;
  // `used` is a set of cells already connected, `path` the chain being built. wide: pills that use the width of the area.
  function Board(svg, layout, cols, opts) {
    this.svg = svg; this.layout = layout; this.cols = cols; this.rows = layout.cells.length / cols;
    this.onTap = (opts && opts.onTap) || null; this.wide = !!(opts && opts.wide); this.groups = (opts && opts.groups) || [];
    this.cw = 100;
  }
  Board.prototype.cellWidth = function () {
    if (!this.wide) return 100;
    var r = this.svg.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) return 130;
    return Math.max(120, Math.min(190, Math.round(r.width / r.height * this.rows * CELL / this.cols)));
  };
  Board.prototype.render = function (used, path, groups, marks) {
    var svg = this.svg, self = this, cols = this.cols, rows = this.rows;
    used = used || {}; path = path || []; marks = marks || {};
    svg.innerHTML = '';
    this.cw = this.cellWidth();
    var cw = this.cw;
    svg.setAttribute('viewBox', '0 0 ' + cols * cw + ' ' + rows * CELL);
    var cx = function (i) { return (i % cols) * cw + cw / 2; }, cy = function (i) { return Math.floor(i / cols) * CELL + CELL / 2; };
    var pts = function (p) { return p.map(function (i) { return cx(i) + ',' + cy(i); }).join(' '); };
    (groups || []).forEach(function (p, k) {
      svg.appendChild(el('polyline', { points: pts(p), fill: 'none', stroke: ['#b66a3c', '#3d7a99', '#5a8f5a', '#9a6aa8', '#b8902f', '#c0506a'][k % 6],
        'stroke-width': 14, 'stroke-opacity': 0.55, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
    });
    if (path.length > 1) svg.appendChild(el('polyline', { points: pts(path), fill: 'none', stroke: '#b66a3c', 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
    this.layout.cells.forEach(function (w, i) {
      var isUsed = !!used[i], sel = path.indexOf(i) >= 0;
      var g = el('g', { 'class': 'bubble' + (isUsed ? ' used' : '') + (sel ? ' sel' : '') + (!isUsed && !sel && marks.tip && marks.tip[i] ? ' tip' : '') + (!isUsed && !sel && marks.start && marks.start[i] ? ' start' : ''),
        role: self.onTap ? 'button' : 'img', 'aria-label': w });
      var bw = cw - 12, bh = 88, avail = bw - 16, cap = cw > 100 ? 30 : 19, minFs = cw > 100 ? 22 : 0;
      g.appendChild(el('rect', { x: cx(i) - bw / 2, y: cy(i) - bh / 2, width: bw, height: bh, rx: bh / 2 }));
      var fs = Math.min(cap, avail / (w.length * 0.62)), fs2 = Math.min(cw > 100 ? 26 : 15, avail / ((w.length / 2 + 1) * 0.62));
      if (fs < (cw > 100 ? 22 : 15) && fs2 > fs) {          // a long word: two lines, hyphenated by the browser
        var fo = el('foreignObject', { x: cx(i) - bw / 2, y: cy(i) - bh / 2, width: bw, height: bh });
        var d = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
        d.className = 'fo'; d.lang = 'de'; d.style.fontSize = Math.max(minFs, fs2).toFixed(1) + 'px'; d.textContent = w;
        fo.appendChild(d); g.appendChild(fo);
      } else {
        g.appendChild(el('text', { x: cx(i), y: cy(i), style: 'font-size:' + Math.max(minFs, fs).toFixed(1) + 'px' }, w));
      }
      if (self.onTap) g.addEventListener('click', function () { self.onTap(i); });
      svg.appendChild(g);
    });
  };

  global.SentenceLive = { loadPool: loadPool, adjacent: adjacent, textOf: textOf, cap: cap, evaluate: evaluate, Board: Board };
})(window);
