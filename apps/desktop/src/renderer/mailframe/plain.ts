// A "plain" email (owner request 2026-11-10): sanitised markup that carries no colour of its own, so it can follow the
// app's dark theme instead of sitting on a bright white sheet. The check reads the sanitiser's own output (allowlisted
// elements and attributes, double-quoted, lower-case), never the raw mail. Any doubt means "not plain": a false
// positive in the text only makes the mail keep the light paper, which is the safe side.

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
  '<img', // logos and photos are drawn for a white sheet, and a blocked image keeps its placeholder
] as const;

/**
 * Properties that place text and never colour it: a style attribute made only of these keeps a mail plain. A quote's
 * `border-left` bar is allowed too (a hairline, and a reply's blockquote carries it).
 */
const LAYOUT_PROPERTY =
  /^(?:margin|padding)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$|^(?:text-align|text-indent|direction|unicode-bidi|white-space|word-break|word-wrap|overflow-wrap|border-(?:left|top)(?:-(?:width|style))?)$/;
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
  return html.replace(/ style="([^"]*)"/g, (whole, style: string) =>
    layoutOnly(style) ? '' : whole,
  );
}

/** Whether the sanitised body sets nothing that was written for white paper. */
export function isPlainBody(body: {
  readonly html: string;
  readonly bodyAttributes: string;
}): boolean {
  if (body.bodyAttributes.trim() !== '') return false;
  const html = withoutLayoutStyles(body.html.toLowerCase());
  return !COLOUR_MARKERS.some(marker => html.includes(marker));
}
