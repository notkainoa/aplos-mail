import type { MailHtml, MailHtmlInput, MailHtmlResult } from '@aplos/engine/ports/content';
import { countMatches, createFinder, type Finder } from './find';
import { ImageBook } from './images';
import { isPlainWalk, PLAIN_ATTRIBUTE } from './plain';
import { READING_CSS } from './reading-css';
import { sanitizeHtml, type WalkOutput } from './sanitize';

// `MailHtml` (ports/content.ts): pure, synchronous, versioned. Bump the version with every rule
// change: it is part of each rendered body's cache key, so a fix reaches mail already stored.
// A message over the size limits (sanitize.ts LIMITS) is cut, and the frame says so at the cut.

export const MAIL_HTML_VERSION = 'mail-html/11';

/**
 * Always this doctype, whatever the mail declared: HTML 4.01 Transitional WITH its system identifier, which Chromium
 * treats as almost-standards mode (`document.compatMode` still reads `CSS1Compat`). It keeps everything the
 * standards-mode doctype gave, which a frame sized to its letter needs: `body.scrollHeight` follows the content
 * (quirks follows the viewport), heights and percentages resolve the standards way, and the frame can be measured and
 * can shrink. The one thing it takes back is the table-cell rule newsletters were written against: an image alone in a
 * cell sits in a line box with no strut, so the baseline strip under sliced images is gone (measured in Chromium with the reading CSS:
 * cell 120 beside a 120 px image, about 126 with `<!DOCTYPE html>`; the strip is a few px and depends on the font). Nothing may come before it (a comment or a BOM would
 * bring quirks back). The system identifier is only a mode switch: nothing ever fetches it.
 */
export const READING_DOCTYPE =
  '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">';

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
    READING_DOCTYPE,
    `<html${walk.htmlAttributes}${isPlainWalk(walk) ? ` ${PLAIN_ATTRIBUTE}` : ''}><head><meta charset="utf-8"><style>${READING_CSS}</style></head>`,
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
