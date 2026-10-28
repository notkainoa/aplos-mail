import type { MailHtml, MailHtmlInput, MailHtmlResult } from '@aplos/engine/ports/content';
import { countMatches, createFinder, type Finder } from './find';
import { ImageBook } from './images';
import { READING_CSS } from './reading-css';
import { sanitizeHtml } from './sanitize';

// `MailHtml` (ports/content.ts): pure, synchronous, versioned. Bump the version with every rule
// change: it is part of each rendered body's cache key, so a fix reaches mail already stored.

export const MAIL_HTML_VERSION = 'mail-html/1';

/** Longer HTML is cut here (Gmail clips at about 100 KB); the frame says so at the cut. */
export const MAX_HTML_CHARS = 1_500_000;

const CLIPPED_NOTE = '<p class="aplos-clipped"><em>This message is very long, so Aplos shows only its beginning.</em></p>';

export function render(input: MailHtmlInput): MailHtmlResult {
  const finder = createFinder(input.findQuery);
  const html = input.html ?? '';
  if (!html.trim()) return renderText(input.text ?? '', finder);
  return renderHtml(html, input, finder);
}

export const mailHtml: MailHtml = { version: MAIL_HTML_VERSION, render };

function renderHtml(html: string, input: MailHtmlInput, finder: Finder | undefined): MailHtmlResult {
  const clipped = html.length > MAX_HTML_CHARS;
  const images = new ImageBook(input.cids, input.imagePolicy);
  const walk = sanitizeHtml(clipped ? html.slice(0, MAX_HTML_CHARS) : html, images, finder);
  const document = [
    walk.doctype,
    `<html${walk.htmlAttributes}><head><style>${READING_CSS}</style></head>`,
    `<body${walk.bodyAttributes}>${walk.body}${clipped ? CLIPPED_NOTE : ''}</body></html>`,
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
    const quoted = /^\s*>/.test(line);
    if (quoted && !inQuote) blocks++;
    inQuote = quoted;
  }
  return blocks;
}
