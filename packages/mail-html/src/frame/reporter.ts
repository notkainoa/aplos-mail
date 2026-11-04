// The frame's one script (ARCH 10): the exact text of `assets/reporter.js`, the shipped file. A
// test reads that file and fails when the two differ by one byte, so editing the asset without
// this copy (and so without the CSP hash, which is computed from this text) cannot pass CI.
// Plain browser JS: it reports height, width, background, readiness and find marks to the host
// and reads nothing else.

export const REPORTER_SOURCE = `/* global window */
(function (w) {
  'use strict';
  let live = false;
  function start() {
    // Every member is taken from the browser's own prototypes before the mail can matter. A named
    // element shadows \`document.body\` and any other Document or EventTarget member on the instance,
    // so after this block nothing is read from \`document\`, \`window\` or an element by name.
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
    // See-through: nothing, \`transparent\`, \`rgba(..., 0)\`, or any slash-alpha colour with alpha 0
    // (\`oklch(0.5 0.2 30 / 0)\`). An opaque \`rgb(255, 255, 0)\` ends in \`0)\` and is a colour.
    function clear(colour) {
      return (
        colour === '' ||
        colour === 'transparent' ||
        /^rgba\\(.*,\\s*0\\)$/.test(colour) ||
        /\\/\\s*0(?:\\.0*)?%?\\)$/.test(colour)
      );
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
