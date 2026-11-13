// The `srcdoc` document and the iframe attributes for the stand-in path. Development only: builds the owner installs
// use the sealed `aplos-mail://` frame (contract MailFrame.srcdoc, FR-34; plan 30 section 4.4 source 1).

import { highlight } from './highlight';
import { FRAME_DARK, FRAME_PAPER } from './paper';
import { isPlainBody } from './plain';
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

/**
 * Layout rules the host's measurement depends on. They are `!important` in the `aplos` layer and the sanitiser strips
 * `!important` and `@layer` from the email, so no email rule (at any specificity, inline or not) can beat them.
 */
const MEASURE_CSS =
  'html,body{display:block!important;position:static!important;float:none!important;overflow:hidden!important;' +
  'height:auto!important;min-height:0!important;max-height:none!important}';

/**
 * The host's styles, all in the `aplos` cascade layer, declared before anything else. Normal rules are reading
 * defaults the email's own (unlayered) styles override; the `!important` ones (measuring, find marks) cannot be beaten.
 * `mark` is the per-instance find attribute, so the email cannot select the marks either.
 */
function hostCss(mark: string, plain: boolean, dark: boolean): string {
  const p = FRAME_PAPER;
  const d = FRAME_DARK;
  return [
    '@layer aplos;@layer aplos{',
    `:root{color-scheme:${dark ? 'dark' : 'light'};--aplos-read-size:${p.fontSize};--aplos-read-leading:${p.lineHeight}}`,
    `body{margin:0;${plain ? `background:${dark ? d.surface : p.paper};letter-spacing:${p.letterSpacing};` : ''}color:${dark ? d.ink : p.ink};font-family:${p.fontFamily};font-size:var(--aplos-read-size);line-height:var(--aplos-read-leading);overflow-wrap:anywhere}`,
    `img,table{max-width:100%}`,
    // A blocked image is a small placeholder, never a slab the height of the picture (it would push the text below the fold).
    `img[data-blocked]{max-height:48px!important;min-height:0!important;padding:0!important;border-width:0!important;margin-block:0!important}`,
    `pre,.aplos-flat{white-space:pre-wrap}`,
    `a{color:${dark ? d.accent : p.accent}}`,
    `mark[${mark}]{all:unset!important;background:color-mix(in srgb,${p.accent} 18%,${p.canvas})!important;color:inherit!important}`,
    ...(dark ? [`blockquote{border-left-color:${d.rule};color:${d.dim}}`] : []),
    MEASURE_CSS,
    '}',
  ].join('');
}

/** A fresh attribute name for this document's find marks (`data-find-` and 12 hex digits). */
function markAttribute(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `data-find-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A built frame document plus the host-chrome facts that came with it. */
export interface FrameDocument {
  /** The full `srcdoc` string. */
  srcdoc: string;
  /** The email is plain (`isPlainBody`): decided here, from the sanitiser's output, never from a colour the email chose. */
  plain: boolean;
  /** Remote resources removed or blocked. */
  blocked: number;
  /** Tracking pixels among them ("N trackers removed"). */
  trackers: number;
  /** Sentences the host shows above the frame (flattened, truncated). Never inside the frame. */
  notices: string[];
}

/**
 * Sanitise, highlight and wrap an HTML body into the scriptless frame's document. A plain email (`isPlainBody`: no colours,
 * styles, images or layout tables of its own) paints a sentinel surface the host reads as "draw me straight on the card", and in
 * the dark theme takes the card's dark surface and the theme's text colours; every other email stays on light paper.
 */
export function frameDocument(
  html: string,
  policy: ImagePolicy,
  findQuery: string | undefined,
  darkTheme = false,
): FrameDocument {
  const body = sanitiseBody(html, policy);
  const plain = isPlainBody(body);
  const dark = darkTheme && plain;
  const mark = markAttribute();
  const srcdoc =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="x-dns-prefetch-control" content="off">` +
    `<meta http-equiv="Content-Security-Policy" content="${frameCsp(policy)}">` +
    `<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="${dark ? 'dark' : 'light'}">` +
    `<style>${hostCss(mark, plain, dark)}</style></head>` +
    `<body${body.bodyAttributes}>${highlight(body.html, findQuery, mark)}</body></html>`;
  return { srcdoc, plain, blocked: body.blocked, trackers: body.trackers, notices: body.notices };
}
