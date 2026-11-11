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
    const attr = w.Element.prototype.hasAttribute;
    const findAll = w.Document.prototype.querySelectorAll;
    const listen = w.EventTarget.prototype.addEventListener;
    const schedule = typeof w.requestAnimationFrame === 'function' ? w.requestAnimationFrame : null;
    const later = typeof w.setTimeout === 'function' ? w.setTimeout : null;
    const clock = w.performance;
    const token = ('' + w.location.pathname).split('/')[1];
    if (!/^[0-9a-f]{32}$/.test(token)) return;
    // A letter that changes after load (a transition, an animation, an image) is looked at on every frame
    // until its SIZE has been still for QUIET ms: a new height or width, or a load, resize, toggle or font
    // event, extends the watch; an animation, transition or resize-observer event asks for one look and
    // extends it only if that look finds a new size - and once a look has found nothing those events ask
    // for the timer only, not a frame, so a storm costs about 4 looks a second, never one per frame (a
    // sub-pixel wiggle fires the observer forever at zero post cost). A report posts only when its
    // height, width, readiness or marks differ (background is no reason to post: colour costs nothing),
    // at most LIMIT a second, LIFETIME posts and LOOKS looks in all - the last post carrying the state
    // of that moment. A host-set width restarts the post budget (a drag can post far more than 2,000
    // honest reports; the letter cannot game its width). `live` gates the looks too: a dead
    // reporter's events schedule nothing. The mail's marks cannot change (no script runs in it), so they
    // are counted once, and an event does no measuring. A look is asked for on the next animation frame
    // AND by a timer WAIT ms later, whichever comes first: a frame off screen pauses animation
    // callbacks, and a held-back report must still arrive. Without a clock, `now` is -Infinity: the
    // rate limiter steps aside and a look never re-arms.
    const QUIET = 3000;
    const WAIT = 250;
    const LIMIT = 20;
    const LIFETIME = 2000;
    const LOOKS = 100000;
    let last = '';
    let form = '';
    let total = 0;
    let marks = 0;
    let plain = false;
    let ticket = 0;
    let armed = false;
    let until = 0;
    let dirty = false;
    let sent = 0;
    let since = 0;
    let calm = false;
    let seen = 0;
    let wide = -1;
    function now() {
      return clock && typeof clock.now === 'function' ? clock.now() : -Infinity;
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
      seen += 1;
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
          marks: marks,
          plain: plain,
        };
        const key = [message.h, message.w, message.ready, message.marks].join('|');
        calm = key === last;
        dirty = dirty && key !== last;
        if (key === last) return;
        const time = now();
        if (!w.isFinite(time) || time - since >= 1000) {
          since = time;
          sent = 0;
        }
        if (sent >= LIMIT) {
          dirty = true;
          return;
        }
        sent += 1;
        if (message.w !== wide) {
          wide = message.w;
          total = 0;
        }
        total += 1;
        last = key;
        const shape = message.h + '|' + message.w;
        if (shape !== form) {
          form = shape;
          until = time + QUIET;
        }
        host.postMessage(message, '*');
        if (total >= LIFETIME) live = false;
      } catch {
        return;
      }
    }
    function step(id) {
      if (id !== ticket || !armed) return;
      armed = false;
      report();
      if (seen >= LOOKS) live = false;
      if (live && (dirty || now() < until)) watch();
    }
    function watch(frame) {
      if (!live || armed) return;
      armed = true;
      ticket += 1;
      const id = ticket;
      const go = () => step(id);
      if (frame !== false && schedule) schedule.call(w, go);
      if (later) later.call(w, go, WAIT);
    }
    // One look, on the animation frame while real changes may still be landing, or on the timer alone
    // once the last look found nothing: a hostile letter's observer storm then costs about 4 looks a
    // second (and LOOKS bounds even that), never a forced layout per frame for as long as it is read.
    const look = () => watch(!calm);
    function recheck() {
      until = now() + QUIET;
      watch();
    }
    listen.call(d, 'DOMContentLoaded', recheck);
    listen.call(d, 'toggle', recheck, true);
    listen.call(d, 'animationend', look, true);
    listen.call(d, 'animationcancel', look, true);
    listen.call(d, 'transitionend', look, true);
    listen.call(w, 'load', recheck, true);
    listen.call(w, 'error', recheck, true);
    listen.call(w, 'resize', recheck);
    if (typeof w.ResizeObserver === 'function') {
      const observer = new w.ResizeObserver(look);
      observer.observe(rootOf.call(d));
      observer.observe(bodyOf.call(d));
    }
    const fonts = fontsOf.call(d);
    if (fonts && fonts.ready && typeof fonts.ready.then === 'function') {
      fonts.ready.then(recheck, recheck);
    }
    marks = size(findAll.call(d, 'mark.aplos-find').length, 100000);
    plain = attr.call(rootOf.call(d), 'data-aplos-plain') === true;
    live = true;
    report();
    recheck();
  }
  try {
    start();
  } catch {
    return;
  }
})(window);
