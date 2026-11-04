import type { MailHtml, MailHtmlInput, MailHtmlResult } from '@aplos/engine/ports/content';
import { countMatches, createFinder, type Finder } from './find';
import { ImageBook } from './images';
import { READING_CSS } from './reading-css';
import { sanitizeHtml, type WalkOutput } from './sanitize';

// `MailHtml` (ports/content.ts): pure, synchronous, versioned. Bump the version with every rule
// change: it is part of each rendered body's cache key, so a fix reaches mail already stored.
// A message over the size limits (sanitize.ts LIMITS) is cut, and the frame says so at the cut.

export const MAIL_HTML_VERSION = 'mail-html/2';

/**
 * Always the standards-mode doctype, whatever the mail declared. In quirks mode `body.scrollHeight` follows
 * the viewport, heights and percentages resolve differently, and a frame sized to its letter can neither
 * be measured nor shrink. Nothing may come before it (a comment or a BOM would bring quirks back).
 */
export const STANDARDS_DOCTYPE = '<!DOCTYPE html>';

const CLIPPED_NOTE =
  '<p class="aplos-clipped"><em>This message is very long, so Aplos shows only its beginning.</em></p>';

export function render(input: MailHtmlInput): MailHtmlResult {
  const finder = createFinder(input.findQuery);
  const html = input.html ?? '';
  if (!html.trim()) return renderText(input.text ?? '', finder);
  return renderHtml(html, input, finder);
}

export const mailHtml: MailHtml = { version: MAIL_HTML_VERSION, render };

export interface BodyOptions {
  cids?: readonly string[];
  imagePolicy?: MailHtmlInput['imagePolicy'];
  findQuery?: string;
  /** Re-reading the sanitizer's own output: keep `cid/<n>`, `img/<n>` and `aplos-` classes (tests only). */
  ownOutput?: boolean;
}

/** The sanitized `<body>` content alone, for the idempotence check and diagnostics. */
export function sanitizeBody(html: string, options: BodyOptions = {}): WalkOutput {
  const images = new ImageBook({
    cids: options.cids ?? [],
    policy: options.imagePolicy ?? 'block',
    ownOutput: options.ownOutput,
  });
  return sanitizeHtml(html, images, createFinder(options.findQuery), options.ownOutput);
}

function renderHtml(
  html: string,
  input: MailHtmlInput,
  finder: Finder | undefined,
): MailHtmlResult {
  const images = new ImageBook({ cids: input.cids, policy: input.imagePolicy });
  const walk = sanitizeHtml(html, images, finder, false, input.quotesOpen === true);
  const document = [
    STANDARDS_DOCTYPE,
    `<html${walk.htmlAttributes}><head><meta charset="utf-8"><style>${READING_CSS}</style></head>`,
    `<body${walk.bodyAttributes}>${walk.body}${walk.clipped ? CLIPPED_NOTE : ''}</body></html>`,
  ].join('');
  return {
    bodyKind: 'html',
    document,
    remoteImages: input.imagePolicy === 'allow' ? [...images.remote] : [],
    hasRemoteImages: images.remote.length > 0,
    trackersRemoved: walk.trackersRemoved,
    quotedCount: walk.quotedCount,
    marks: finder?.marks ?? 0,
  };
}

/** Plain-text mail: no frame; the host escapes the text into its own DOM. */
function renderText(text: string, finder: Finder | undefined): MailHtmlResult {
  return {
    bodyKind: 'text',
    text,
    remoteImages: [],
    hasRemoteImages: false,
    trackersRemoved: 0,
    quotedCount: countQuoteBlocks(text),
    marks: countMatches(text, finder),
  };
}

/** Runs of lines starting with `>`. */
function countQuoteBlocks(text: string): number {
  let blocks = 0;
  let inQuote = false;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const quoted = line.trimStart().startsWith('>');
    if (quoted && !inQuote) blocks++;
    inQuote = quoted;
  }
  return blocks;
}
