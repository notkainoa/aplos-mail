/* global window */
(function (w) {
  'use strict';
  let live = false;
  function start() {
    // Every member is taken from the browser's own prototypes before the mail can matter. A named
    // element shadows `document.body` and any other Document or EventTarget member on the instance,
    // so after this block nothing is read from `document`, `window` or an element by name.
    const O = w.Object;
    const M = w.Math;
    const d = w.document;
    const host = w.parent;
    const getter = (type, key) => O.getOwnPropertyDescriptor(type.prototype, key).get;
    const rootOf = getter(w.Document, 'documentElement');
    const bodyOf = getter(w.Document, 'body');
    const stateOf = getter(w.Document, 'readyState');
    const fontsOf = getter(w.Document, 'fonts');
    const scrollOf = getter(w.Element, 'scrollHeight');
    const boxOf = w.Element.prototype.getBoundingClientRect;
    const findAll = w.Document.prototype.querySelectorAll;
    const listen = w.EventTarget.prototype.addEventListener;
    const token = ('' + w.location.pathname).split('/')[1];
    if (!/^[0-9a-f]{32}$/.test(token)) return;
    function size(value, max) {
      return typeof value === 'number' && w.isFinite(value)
        ? M.round(M.min(M.max(value, 0), max))
        : 0;
    }
    function paint(element) {
      const colour = element ? w.getComputedStyle(element).backgroundColor : '';
      return typeof colour === 'string' ? colour : '';
    }
    function clear(colour) {
      return colour === '' || colour === 'transparent' || /,\s*0\)$/.test(colour);
    }
    function background(root, body) {
      const colour = paint(body);
      return (clear(colour) && !clear(paint(root)) ? paint(root) : colour).slice(0, 64);
    }
    function report() {
      if (!live) return;
      try {
        const width = w.innerWidth;
        if (!(typeof width === 'number' && width > 0)) return;
        const root = rootOf.call(d);
        const body = bodyOf.call(d);
        // The content's height: the root's own box (auto height, so never the frame's) and what
        // the body holds that spills past it. The root's scrollHeight is at least the frame's.
        const height = M.max(M.ceil(boxOf.call(root).height), body ? scrollOf.call(body) : 0);
        host.postMessage(
          {
            token: token,
            h: size(height, 1000000),
            w: size(width, 100000),
            bg: background(root, body),
            ready: stateOf.call(d) === 'complete',
            marks: size(findAll.call(d, 'mark.aplos-find').length, 100000),
          },
          '*',
        );
      } catch {
        return;
      }
    }
    listen.call(d, 'DOMContentLoaded', report);
    listen.call(d, 'toggle', report, true);
    listen.call(w, 'load', report);
    listen.call(w, 'resize', report);
    if (typeof w.ResizeObserver === 'function') {
      new w.ResizeObserver(report).observe(rootOf.call(d));
    }
    const fonts = fontsOf.call(d);
    if (fonts && fonts.ready && typeof fonts.ready.then === 'function') {
      fonts.ready.then(report, report);
    }
    live = true;
    report();
  }
  try {
    start();
  } catch {
    return;
  }
})(window);
