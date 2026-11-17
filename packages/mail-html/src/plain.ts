// A "plain" email (owner request 2026-11-10): sanitised markup that sets nothing written for white paper, so the frame can
// draw it straight on the reader's card in the app's own type and colours, in both themes, instead of on a white sheet.
// The check reads the sanitiser's own output (allowlisted elements and attributes, lower-case names, double-quoted values),
// never the raw mail, and every doubt means "not plain": a false positive in the text only keeps the mail on its paper.

import type { WalkOutput } from './sanitize';

/** The marker on `<html>`; the mail cannot set it (only `dir` and `lang` survive on the root, and `data-` attributes are dropped). */
export const PLAIN_ATTRIBUTE = 'data-aplos-plain';

const COLOUR_MARKERS = [
  '<style', // author CSS
  ' style=', // inline colours, backgrounds, images (a style that only places text is removed first)
  ' color=', // <font color>, <hr color>
  ' bgcolor=', // table and cell fills
  ' background=', // legacy background images
  ' face=', // <font face>: the mail's own typeface
  ' size=', // <font size>, <hr size>: the mail's own type size
  '<mark', // a highlight in a colour of its own
  '<table', // layout tables
  '<img', // logos and photos are drawn for white paper, and a blocked image keeps its placeholder
] as const;

/**
 * Properties that place text and never colour it: a style attribute made only of these keeps a mail plain. A quote's
 * `border-left` bar is allowed too (a reply's blockquote carries it; the dark theme repaints a blockquote's bar and text, with
 * `!important`, so an inline bar colour cannot stay black on the dark card).
 */
const LAYOUT_PROPERTY =
  /^(?:margin|padding)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$|^(?:text-align|text-indent|direction|unicode-bidi|white-space|word-break|word-wrap|overflow-wrap|border-left(?:-(?:width|style))?)$/;
/** Never in a layout value: a URL, a script hook, a variable, an escape. */
const UNSAFE_VALUE = /url\(|expression|var\(|!important|\\/i;

function layoutOnly(style: string): boolean {
  const declarations = style.split(';').filter(d => d.trim() !== '');
  return declarations.every(declaration => {
    const at = declaration.indexOf(':');
    if (at < 1) return false;
    const value = declaration.slice(at + 1);
    return (
      LAYOUT_PROPERTY.test(declaration.slice(0, at).trim().toLowerCase()) &&
      !UNSAFE_VALUE.test(value)
    );
  });
}

/** The markup with every colour-free `style` attribute taken out (a quote's margin, a paragraph's alignment). */
function withoutLayoutStyles(html: string): string {
  return html.replace(/ style="([^"<>]*)"/g, (whole, style: string) =>
    layoutOnly(style) ? '' : whole,
  );
}

/**
 * The `<body>` attributes a plain mail may carry: direction, language, a class (author CSS is a marker of its own) and a
 * colour-free style (`<body dir="ltr">`, `<body style="margin:0">`, as a wrapper writes it). Anything else (`bgcolor`, `text`,
 * `link`, a coloured style, a background) is the mail's own look.
 */
function plainBodyAttributes(attributes: string): boolean {
  const rest = withoutLayoutStyles(attributes.toLowerCase()).replace(
    / (?:dir|lang|class)="[^"<>]*"/g,
    '',
  );
  return rest.trim() === '';
}

/** Whether the walked mail carries no colour, style, image or table of its own. */
export function isPlainWalk(walk: Pick<WalkOutput, 'bodyAttributes' | 'body'>): boolean {
  if (!plainBodyAttributes(walk.bodyAttributes)) return false;
  const body = withoutLayoutStyles(walk.body.toLowerCase());
  return !COLOUR_MARKERS.some(marker => body.includes(marker));
}
