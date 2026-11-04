// The frame's one script (ARCH 10): the exact text of `assets/reporter.js`, the shipped file. A
// test reads that file and fails when the two differ by one byte, so editing the asset without
// this copy (and so without the CSP hash, which is computed from this text) cannot pass CI.
// Plain browser JS: it reports height, width, background, readiness and find marks to the host
// and reads nothing else. Every DOM built-in it calls is captured once, from a prototype (or an own
// property of the window), before it reads the page, and called with `.call`: the mail's markup is
// already parsed when it runs, and a document or window named property (`<img name=body>`) shadows
// `document.body` or what EventTarget gives the window, but never these. Missing one, it posts nothing.
// The height is the larger of the root's box (the reading CSS makes it the content's height, so a letter
// shrinks) and the body's top plus its scroll height, which takes in positioned, transformed and
// negative-margin content the root's box leaves out (the body is the containing block of absolutely
// positioned content); 0 (no layout yet: Chromium can run the script before the frame's first layout) is
// not posted.
// The paper is the body's background, or the root's when the body's is transparent.

export const REPORTER_SOURCE = `/* global window */
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
`;

/** The inline script element, exactly as hashed: no attribute, no whitespace around the text. */
export function reporterTag(): string {
  return `<script>${REPORTER_SOURCE}</script>`;
}

/** The document with the reporter as the last thing in its body (or appended when it has none). */
export function withReporter(html: string): string {
  const end = html.lastIndexOf('</body>');
  if (end < 0) return html + reporterTag();
  return html.slice(0, end) + reporterTag() + html.slice(end);
}

let hash: Promise<string> | undefined;

/** The base64 SHA-256 of the script's UTF-8 bytes, for `script-src 'sha256-...'`. Web Crypto. */
export function reporterHash(): Promise<string> {
  hash ??= sha256Base64(REPORTER_SOURCE);
  return hash;
}

export async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
