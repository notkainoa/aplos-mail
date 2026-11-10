// A "plain" email (owner request 2026-11-10): sanitised markup that sets nothing written for white paper, so the frame can
// draw it straight on the reader's card in the app's own type and colours, in both themes, instead of on a white sheet.
// The check reads the sanitiser's own output (allowlisted elements and attributes, lower-case names, double-quoted values),
// never the raw mail, and every doubt means "not plain": a false positive in the text only keeps the mail on its paper.

import type { WalkOutput } from './sanitize';

/** The marker on `<html>`; the mail cannot set it (only `dir` and `lang` survive on the root, and `data-` attributes are dropped). */
export const PLAIN_ATTRIBUTE = 'data-aplos-plain';

const COLOUR_MARKERS = [
  '<style', // author CSS
  ' style=', // inline colours, backgrounds, images
  ' color=', // <font color>, <hr color>
  ' bgcolor=', // table and cell fills
  ' background=', // legacy background images
  '<table', // layout tables
  '<img', // logos and photos are drawn for white paper, and a blocked image keeps its placeholder
] as const;

/** Whether the walked mail carries no colour, style, image or table of its own. */
export function isPlainWalk(walk: Pick<WalkOutput, 'bodyAttributes' | 'body'>): boolean {
  if (walk.bodyAttributes.trim() !== '') return false;
  const body = walk.body.toLowerCase();
  return !COLOUR_MARKERS.some(marker => body.includes(marker));
}
