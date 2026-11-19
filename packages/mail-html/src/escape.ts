// Every byte of output text and attribute values passes through here. Escaping `<` and `>` in
// attribute values too means no reading of the output can find markup inside a value.
//
// Two control characters become U+FFFD: NUL (the HTML parser would make it so anyway) and ESC.
// ESC starts the ISO-2022-JP shift sequences (`ESC $ B` … `ESC ( B`); a browser that ever sniffed
// the frame as ISO-2022-JP would read the bytes after one as two-byte characters and could swallow
// a closing quote, turning the rest of an attribute value into attributes. The document also
// declares UTF-8 first thing, but the output must not depend on that.

const TEXT_SPECIAL = /[&<>]/;
const ATTRIBUTE_SPECIAL = /[&<>"'`]/;
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(0x1b);
const REPLACEMENT = String.fromCharCode(0xfffd);

/** NUL and ESC to U+FFFD. */
export function replaceControls(value: string): string {
  let out = value;
  if (out.includes(NUL)) out = out.replaceAll(NUL, REPLACEMENT);
  if (out.includes(ESC)) out = out.replaceAll(ESC, REPLACEMENT);
  return out;
}

export function escapeText(text: string): string {
  if (!TEXT_SPECIAL.test(text)) return replaceControls(text);
  return replaceControls(
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  );
}

export function escapeAttribute(value: string): string {
  if (!ATTRIBUTE_SPECIAL.test(value)) return replaceControls(value);
  const escaped = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('`', '&#96;');
  return replaceControls(escaped);
}
