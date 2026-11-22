/*
 * LetterHunt: the parts of the letter game that the teacher page and the phone page share.
 * A grid is { l: '25 letters', w: [[word, points], ...], p: [placed words] } (see generator/generate_letter_grids.py).
 * The word list of a grid holds every word that can be found on it, so no dictionary runs in the browser.
 */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg', CELL = 100;

  function points(len) { return len <= 4 ? 1 : len === 5 ? 2 : len === 6 ? 3 : len === 7 ? 5 : 11; }   // Boggle-style

  function loadPool(level) {
    return fetch('grids/letters_ch' + level + '.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('grid file'); return r.json(); });
  }

  function adjacent(a, b, size) {
    var dr = Math.abs(Math.floor(a / size) - Math.floor(b / size)), dc = Math.abs(a % size - b % size);
    return (dr || dc) && dr <= 1 && dc <= 1;
  }

  // word -> points for the words of the grid that are at least minLen letters long
  function wordMap(grid, minLen) {
    var m = {};
    grid.w.forEach(function (e) { if (e[0].length >= minLen) m[e[0]] = e[1]; });
    return m;
  }

  // "12 words to find: 5 with 3 letters, 4 with 4 letters, 3 with 5 or more"
  function hint(grid, minLen) {
    var n3 = 0, n4 = 0, n5 = 0;
    grid.w.forEach(function (e) { var l = e[0].length; if (l < minLen) return; if (l === 3) n3++; else if (l === 4) n4++; else n5++; });
    var parts = [];
    if (n3) parts.push(n3 + ' with 3 letters');
    if (n4) parts.push(n4 + ' with 4 letters');
    if (n5) parts.push(n5 + ' with 5 or more');
    return (n3 + n4 + n5) + ' words to find: ' + parts.join(', ');
  }

  // does `path` spell `word` on the grid through neighbouring, distinct cells?
  function pathOk(letters, word, path) {
    if (!Array.isArray(path) || path.length !== word.length) return false;
    var size = Math.round(Math.sqrt(letters.length));
    for (var i = 0; i < path.length; i++) {
      var c = path[i];
      if (typeof c !== 'number' || c < 0 || c >= letters.length || path.indexOf(c) !== i) return false;
      if (letters.charAt(c).toLowerCase() !== word.charAt(i)) return false;
      if (i && !adjacent(path[i - 1], c, size)) return false;
    }
    return true;
  }

  // The scoring rule of one round for RoomKit.Scoring: a word counts if it is on the grid's list (and long
  // enough), or if the teacher accepted it and the path really spells it. Late answers do not count.
  function makeRule(grid, minLen, decisions, round, endsAt) {
    var map = wordMap(grid, minLen), dec = {};
    decisions.forEach(function (d) { if (d.round === round) dec[d.key] = d.accepted; });
    return function (s) {
      var w = String((s.payload && s.payload.word) || '').toLowerCase();
      if (w.length < minLen || (endsAt && s.at > endsAt + 2500)) return null;
      if (map[w] != null) return dec[w] === false ? null : { key: w, points: map[w] };
      if (dec[w] === true && pathOk(grid.l, w, s.payload.path)) return { key: w, points: points(w.length) };
      return null;
    };
  }

  // Words players sent that are not on the grid's list: [{ word, players: [nicknames], decision: true|false|undefined }]
  function rejected(snapshot, round, grid, minLen) {
    var map = wordMap(grid, minLen), dec = {}, out = {}, names = {};
    snapshot.players.forEach(function (p) { names[p.id] = p.nickname; });
    snapshot.decisions.forEach(function (d) { if (d.round === round) dec[d.key] = d.accepted; });
    snapshot.submissions.forEach(function (s) {
      if (s.round !== round || !names[s.playerId]) return;
      var w = String((s.payload && s.payload.word) || '').toLowerCase();
      if (w.length < minLen || map[w] != null || !pathOk(grid.l, w, s.payload.path)) return;
      var e = out[w] = out[w] || { word: w, players: [], decision: dec[w] };
      if (e.players.indexOf(names[s.playerId]) < 0) e.players.push(names[s.playerId]);
    });
    return Object.keys(out).sort().map(function (k) { return out[k]; });
  }

  function el(name, attrs, text) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  // The letter board in an <svg>. With onTap(cellIndex) the tiles can be tapped; `path` is the current selection.
  function Board(svg, letters, opts) {
    this.svg = svg; this.letters = letters; this.size = Math.round(Math.sqrt(letters.length));
    this.onTap = (opts && opts.onTap) || null; this.path = [];
    svg.setAttribute('viewBox', '0 0 ' + this.size * CELL + ' ' + this.size * CELL);
    this.render();
  }
  Board.prototype.setPath = function (path) { this.path = path; this.render(); };
  Board.prototype.render = function () {
    var svg = this.svg, self = this, size = this.size;
    svg.innerHTML = '';
    var cx = function (i) { return (i % size) * CELL + CELL / 2; }, cy = function (i) { return Math.floor(i / size) * CELL + CELL / 2; };
    if (this.path.length > 1) {
      svg.appendChild(el('polyline', { points: this.path.map(function (i) { return cx(i) + ',' + cy(i); }).join(' '),
        fill: 'none', stroke: '#b66a3c', 'stroke-width': 10, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': 0.55 }));
    }
    this.letters.split('').forEach(function (ch, i) {
      var sel = self.path.indexOf(i) >= 0;
      var g = el('g', { 'class': 'tile' + (sel ? ' sel' : ''), role: self.onTap ? 'button' : 'img', 'aria-label': ch });
      g.appendChild(el('rect', { x: cx(i) - 44, y: cy(i) - 44, width: 88, height: 88, rx: 16 }));
      g.appendChild(el('text', { x: cx(i), y: cy(i) + 2 }, ch));
      if (self.onTap) g.addEventListener('click', function () { self.onTap(i); });
      svg.appendChild(g);
    });
  };

  global.LetterHunt = { points: points, loadPool: loadPool, adjacent: adjacent, wordMap: wordMap, pathOk: pathOk, makeRule: makeRule, rejected: rejected, hint: hint, Board: Board };
})(window);
