// A "plain" email (owner request 2026-11-10): sanitised markup that carries no colour of its own, so it can follow the
// app's dark theme instead of sitting on a bright white sheet. The check reads the sanitiser's own output (allowlisted
// elements and attributes, double-quoted, lower-case), never the raw mail. Any doubt means "not plain": a false
// positive in the text only makes the mail keep the light paper, which is the safe side.

const COLOUR_MARKERS = [
  '<style', // author CSS
  ' style=', // inline colours, backgrounds, images
  ' color=', // <font color>, <hr color>
  ' bgcolor=', // table and cell fills
  ' background=', // legacy background images
  ' face=', // <font face>: the mail's own typeface
  ' size=', // <font size>, <hr size>: the mail's own type size
  '<mark', // a highlight in a colour of its own
  '<table', // layout tables
  '<img', // logos and photos are drawn for a white sheet, and a blocked image keeps its placeholder
] as const;

/** Whether the sanitised body sets nothing that was written for white paper. */
export function isPlainBody(body: {
  readonly html: string;
  readonly bodyAttributes: string;
}): boolean {
  if (body.bodyAttributes.trim() !== '') return false;
  const html = body.html.toLowerCase();
  return !COLOUR_MARKERS.some(marker => html.includes(marker));
}
