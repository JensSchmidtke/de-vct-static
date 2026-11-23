/*
 * Hints: the beginner help of Sentence Bubbles, shared by every mode.
 *  - starting words: the bubbles a sentence from the list can begin with (only chains whose bubbles are all still free)
 *  - Tip: after a bubble was selected, the bubbles that can come next. A tip costs the point for the word that follows.
 * `valid` is the layout's list of chains (arrays of cell numbers).
 */
(function (global) {
  'use strict';

  function Tips(valid) { this.valid = valid || []; this.pos = {}; this.shown = {}; }

  Tips.prototype.starts = function (used) {         // { cell: true }
    var out = {};
    this.valid.forEach(function (p) { if (p.every(function (c) { return !used[c]; })) out[p[0]] = true; });
    return out;
  };

  // The bubbles that can follow `chain`. Asking records that the next position was tipped (once per position).
  Tips.prototype.ask = function (chain, used) {
    var n = chain.length, out = {};
    if (!n) return [];
    this.valid.forEach(function (p) {
      if (p.length <= n) return;
      for (var i = 0; i < n; i++) if (p[i] !== chain[i]) return;
      if (p.every(function (c) { return !used[c]; })) out[p[n]] = true;
    });
    var cells = Object.keys(out).map(Number);
    if (cells.length) { this.pos[n] = true; this.shown = out; }
    return cells;
  };

  Tips.prototype.hide = function () { this.shown = {}; };
  Tips.prototype.reset = function () { this.pos = {}; this.shown = {}; };
  Tips.prototype.cost = function (len) {              // tipped positions that are part of a sentence of this length
    var n = 0;
    for (var k in this.pos) if (+k < len) n++;
    return n;
  };
  Tips.prototype.marks = function (used, on) { return on ? { start: this.starts(used), tip: this.shown } : { start: {}, tip: {} }; };

  global.Hints = { Tips: Tips };
})(window);
