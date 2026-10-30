// The `srcdoc` document and the iframe attributes for the stand-in path. Development only: builds the owner installs
// use the sealed `aplos-mail://` frame (contract MailFrame.srcdoc, FR-34; plan 30 section 4.4 source 1).

import { highlight } from './highlight';
import { FRAME_PAPER } from './paper';
import { sanitiseBody } from './sanitise';
import type { ImagePolicy } from './types';

/**
 * The stand-in frame's sandbox: `allow-same-origin` and nothing else. No `allow-scripts`, so no script, handler,
 * `javascript:` URL or meta refresh can run; no `allow-popups`, `allow-forms`, `allow-modals` or
 * `allow-top-navigation*`. `allow-same-origin` is the one unavoidable token: with no script in the frame, the host
 * must read the height and paper colour from the document itself (research section 3: every scriptless alternative
 * failed). See PROTOCOL.md "Why the srcdoc frame is same-origin".
 */
export const SRCDOC_SANDBOX = 'allow-same-origin';
/** The sealed frame's sandbox (research section 7): scripts for the one hash-pinned reporter, never same-origin. */
export const URL_SANDBOX = 'allow-scripts allow-popups';

/** The inner Content-Security-Policy. With `block`, the frame may load nothing but data: images. */
export function frameCsp(policy: ImagePolicy): string {
  const img = policy === 'load' ? 'data: https:' : 'data:';
  return `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'`;
}

/** Reading defaults for the inside of the frame; the email's own styles come later and may override them. */
function defaultCss(): string {
  const p = FRAME_PAPER;
  return [
    `:root{color-scheme:light;--aplos-read-size:${p.fontSize};--aplos-read-leading:${p.lineHeight}}`,
    `body{margin:0;color:${p.ink};font-family:${p.fontFamily};font-size:var(--aplos-read-size);line-height:var(--aplos-read-leading);overflow-wrap:anywhere}`,
    `img,table{max-width:100%}`,
    `pre,.aplos-flat{white-space:pre-wrap}`,
    `a{color:${p.accent}}`,
    `mark[data-find]{background:color-mix(in srgb,${p.accent} 18%,${p.canvas});color:inherit}`,
    `.aplos-notice{color:${p.dim}}`,
  ].join('');
}

/** Layout rules the host's measurement depends on. Last in the document, so they win over the email's styles. */
const MEASURE_CSS =
  'html,body{overflow:hidden!important;height:auto!important;min-height:0!important;max-height:none!important}';

/** A built frame document plus the host-chrome facts that came with it. */
export interface FrameDocument {
  /** The full `srcdoc` string. */
  srcdoc: string;
  /** Remote resources removed ("N trackers removed"). */
  blocked: number;
}

/** Sanitise, highlight and wrap an HTML body into the scriptless frame's document. */
export function frameDocument(
  html: string,
  policy: ImagePolicy,
  findQuery: string | undefined,
): FrameDocument {
  const body = sanitiseBody(html, policy);
  const srcdoc =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${frameCsp(policy)}">` +
    `<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">` +
    `<style>${defaultCss()}</style></head>` +
    `<body${body.bodyAttributes}>${highlight(body.html, findQuery)}<style>${MEASURE_CSS}</style></body></html>`;
  return { srcdoc, blocked: body.blocked };
}
