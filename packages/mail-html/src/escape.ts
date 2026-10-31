// Every byte of output text and attribute values passes through here. Escaping `<` and `>` in
// attribute values too means no reading of the output can find markup inside a value. NUL becomes
// U+FFFD, as the HTML parser would make it anyway.

const TEXT_SPECIAL = /[&<>]/;
const ATTRIBUTE_SPECIAL = /[&<>"'`]/;
const NUL = '\u0000';

function replaceNul(value: string): string {
  return value.includes(NUL) ? value.replaceAll(NUL, '�') : value;
}

export function escapeText(text: string): string {
  if (!TEXT_SPECIAL.test(text)) return replaceNul(text);
  return replaceNul(text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
}

export function escapeAttribute(value: string): string {
  if (!ATTRIBUTE_SPECIAL.test(value)) return replaceNul(value);
  const escaped = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('`', '&#96;');
  return replaceNul(escaped);
}
