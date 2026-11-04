/* global window */
(function (w) {
  'use strict';
  try {
    const d = w.document;
    const M = w.Math;
    const O = w.Object;
    const proto = (type, name, part) => {
      const found = type ? O.getOwnPropertyDescriptor(type.prototype, name) : null;
      const value = found ? found[part] : null;
      return typeof value === 'function' ? value : null;
    };
    const root = proto(w.Document, 'documentElement', 'get');
    const body = proto(w.Document, 'body', 'get');
    const state = proto(w.Document, 'readyState', 'get');
    const fonts = proto(w.Document, 'fonts', 'get');
    const query = proto(w.Document, 'querySelectorAll', 'value');
    const rect = proto(w.Element, 'getBoundingClientRect', 'value');
    const scroll = proto(w.Element, 'scrollHeight', 'get');
    const listen = proto(w.EventTarget, 'addEventListener', 'value');
    const style = w.getComputedStyle;
    const Observer = w.ResizeObserver;
    const up = w.parent;
    if (!(root && body && state && query && rect && scroll && listen)) return;
    if (typeof style !== 'function') return;
    const token = ('' + w.location.pathname).split('/')[1];
    if (!/^[0-9a-f]{32}$/.test(token)) return;
    const size = (value, max) =>
      typeof value === 'number' && w.isFinite(value) ? M.round(M.min(M.max(value, 0), max)) : 0;
    const paint = element => {
      const colour = element ? style.call(w, element).backgroundColor : '';
      return typeof colour === 'string' ? colour : '';
    };
    const clear = colour =>
      colour === '' ||
      colour === 'transparent' ||
      (colour.slice(0, 5) === 'rgba(' && colour.slice(-4) === ', 0)') ||
      colour.slice(-4) === '/ 0)';
    const background = top => {
      const mine = paint(body.call(d));
      const page = clear(mine) ? paint(top) : mine;
      return (clear(page) ? mine : page).slice(0, 64);
    };
    const extent = top => {
      const page = body.call(d);
      const own = top ? rect.call(top).height : 0;
      const below = page ? rect.call(page).top + scroll.call(page) : 0;
      return M.ceil(M.max(own, below));
    };
    let live = false;
    const report = () => {
      if (!live) return;
      try {
        const width = w.innerWidth;
        if (!(typeof width === 'number' && width > 0)) return;
        const top = root.call(d);
        const height = size(extent(top), 1000000);
        if (height === 0) return;
        up.postMessage(
          {
            token: token,
            h: height,
            w: size(width, 100000),
            bg: background(top),
            ready: state.call(d) === 'complete',
            marks: size(query.call(d, 'mark.aplos-find').length, 100000),
          },
          '*',
        );
      } catch {
        return;
      }
    };
    listen.call(d, 'DOMContentLoaded', report);
    listen.call(d, 'toggle', report, true);
    listen.call(w, 'load', report);
    listen.call(w, 'resize', report);
    if (typeof Observer === 'function') new Observer(report).observe(root.call(d));
    const set = fonts ? fonts.call(d) : null;
    if (set && set.ready && typeof set.ready.then === 'function') set.ready.then(report, report);
    live = true;
    report();
  } catch {
    return;
  }
})(window);
