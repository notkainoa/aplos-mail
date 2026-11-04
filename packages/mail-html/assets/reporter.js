/* global window */
(function (w) {
  'use strict';
  const d = w.document;
  const M = w.Math;
  let live = false;
  let token = '';
  function size(value, max) {
    return typeof value === 'number' && w.isFinite(value)
      ? M.round(M.min(M.max(value, 0), max))
      : 0;
  }
  function background() {
    const body = d.body;
    const colour = body ? w.getComputedStyle(body).backgroundColor : '';
    return typeof colour === 'string' ? colour.slice(0, 64) : '';
  }
  function report() {
    if (!live) return;
    try {
      const width = w.innerWidth;
      if (!(typeof width === 'number' && width > 0)) return;
      const root = d.documentElement;
      const body = d.body;
      const height = M.max(root ? root.scrollHeight : 0, body ? body.scrollHeight : 0);
      const message = {
        token: token,
        h: size(height, 1000000),
        w: size(width, 100000),
        bg: background(),
        ready: d.readyState === 'complete',
        marks: size(d.querySelectorAll('mark.aplos-find').length, 100000),
      };
      w.parent.postMessage(message, '*');
    } catch {
      return;
    }
  }
  try {
    token = ('' + w.location.pathname).split('/')[1];
    if (!/^[0-9a-f]{32}$/.test(token)) return;
    d.addEventListener('DOMContentLoaded', report);
    d.addEventListener('toggle', report, true);
    w.addEventListener('load', report);
    w.addEventListener('resize', report);
    if (typeof w.ResizeObserver === 'function') {
      new w.ResizeObserver(report).observe(d.documentElement);
    }
    if (d.fonts && d.fonts.ready && typeof d.fonts.ready.then === 'function') {
      d.fonts.ready.then(report, report);
    }
    live = true;
    report();
  } catch {
    return;
  }
})(window);
