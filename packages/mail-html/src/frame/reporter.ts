// The frame's one script (ARCH 10): the exact text of `assets/reporter.js`, the shipped file. A
// test reads that file and fails when the two differ by one byte, so editing the asset without
// this copy (and so without the CSP hash, which is computed from this text) cannot pass CI.
// Plain browser JS: it reports height, width, background, readiness and find marks to the host
// and reads nothing else.

export const REPORTER_SOURCE = `/* global window */
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
