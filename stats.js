// Anonymous, cookie-free visit counting with GoatCounter (https://www.goatcounter.com).
// Put the site code (the part before ".goatcounter.com") into GC_CODE. While it is empty,
// nothing is loaded and nothing is sent.
(function () {
  var GC_CODE = 'herbertfeuerschmitt';

  // Custom events, e.g. track('finish/test/ch4'). Safe to call at any time.
  window.track = function (name) {
    try {
      if (GC_CODE && window.goatcounter && window.goatcounter.count)
        window.goatcounter.count({ path: name, title: name, event: true });
    } catch (e) {}
  };

  if (!GC_CODE) return;
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://gc.zgo.at/count.js';
  s.setAttribute('data-goatcounter', 'https://' + GC_CODE + '.goatcounter.com/count');
  document.head.appendChild(s);
})();
