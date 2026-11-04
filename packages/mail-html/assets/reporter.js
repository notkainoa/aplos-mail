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
    const schedule = typeof w.requestAnimationFrame === 'function' ? w.requestAnimationFrame : null;
    const clock = w.performance;
    const token = ('' + w.location.pathname).split('/')[1];
    if (!/^[0-9a-f]{32}$/.test(token)) return;
    // A letter that changes after load (a transition, an animation, an image) is looked at on every frame
    // until it has been still for QUIET ms. A report is posted only when it differs from the last one, and
    // at most LIMIT times a second: a height that animates for ever costs the host LIMIT messages a second.
    const QUIET = 3000;
    const LIMIT = 20;
    let last = '';
    let until = 0;
    let frame = 0;
    let dirty = false;
    let sent = 0;
    let since = 0;
    function now() {
      return clock && typeof clock.now === 'function' ? clock.now() : 0;
    }
    function size(value, max) {
      return typeof value === 'number' && w.isFinite(value)
        ? M.round(M.min(M.max(value, 0), max))
        : 0;
    }
    function paint(element) {
      const colour = element ? w.getComputedStyle(element).backgroundColor : '';
      return typeof colour === 'string' ? colour : '';
    }
    // See-through: nothing, `transparent`, `rgba(..., 0)`, or any slash-alpha colour with alpha 0
    // (`oklch(0.5 0.2 30 / 0)`). An opaque `rgb(255, 255, 0)` ends in `0)` and is a colour.
    function clear(colour) {
      return (
        colour === '' ||
        colour === 'transparent' ||
        /^rgba\(.*,\s*0\)$/.test(colour) ||
        /\/\s*0(?:\.0*)?%?\)$/.test(colour)
      );
    }
    function background(root, body) {
      const colour = paint(body);
      return (clear(colour) && !clear(paint(root)) ? paint(root) : colour).slice(0, 64);
    }
    function below(body) {
      if (!body) return 0;
      const scrolled = typeof w.scrollY === 'number' ? w.scrollY : 0;
      return M.ceil(boxOf.call(body).top + scrolled + scrollOf.call(body));
    }
    function report() {
      if (!live) return;
      try {
        const width = w.innerWidth;
        if (!(typeof width === 'number' && width > 0)) return;
        const root = rootOf.call(d);
        const body = bodyOf.call(d);
        // The content's height: the root's own box (auto height, so never the frame's) and what the
        // body holds that spills past it. The body is positioned (reading-css.ts), so its scroll
        // height takes in absolutely positioned and transformed content; its top (plus how far the
        // frame is scrolled) is where that height starts. The root's scrollHeight is at least the frame's.
        const height = M.max(M.ceil(boxOf.call(root).height), below(body));
        const message = {
          token: token,
          h: size(height, 1000000),
          w: size(width, 100000),
          bg: background(root, body),
          ready: stateOf.call(d) === 'complete',
          marks: size(findAll.call(d, 'mark.aplos-find').length, 100000),
        };
        const key = [message.h, message.w, message.bg, message.ready, message.marks].join('|');
        dirty = dirty && key !== last;
        if (key === last) return;
        const time = now();
        if (time - since >= 1000) {
          since = time;
          sent = 0;
        }
        if (sent >= LIMIT) {
          dirty = true;
          return;
        }
        sent += 1;
        last = key;
        until = time + QUIET;
        host.postMessage(message, '*');
      } catch {
        return;
      }
    }
    function step() {
      frame = 0;
      report();
      if (dirty || now() < until) watch();
    }
    function watch() {
      if (frame === 0 && schedule) frame = schedule.call(w, step);
    }
    function recheck() {
      report();
      until = now() + QUIET;
      watch();
    }
    listen.call(d, 'DOMContentLoaded', recheck);
    listen.call(d, 'toggle', recheck, true);
    listen.call(d, 'animationend', recheck, true);
    listen.call(d, 'animationcancel', recheck, true);
    listen.call(d, 'transitionend', recheck, true);
    listen.call(w, 'load', recheck, true);
    listen.call(w, 'error', recheck, true);
    listen.call(w, 'resize', recheck);
    if (typeof w.ResizeObserver === 'function') {
      const observer = new w.ResizeObserver(recheck);
      observer.observe(rootOf.call(d));
      observer.observe(bodyOf.call(d));
    }
    const fonts = fontsOf.call(d);
    if (fonts && fonts.ready && typeof fonts.ready.then === 'function') {
      fonts.ready.then(recheck, recheck);
    }
    live = true;
    recheck();
  }
  try {
    start();
  } catch {
    return;
  }
})(window);
