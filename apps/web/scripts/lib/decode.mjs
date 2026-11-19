// Small decoders shared by the site checks: HTML entities, CSS escapes and JS escapes.
// The checks decode before they match, so `https&#58;//`, `\68ttps` or `✨` cannot slip past.

const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '­',
  colon: ':',
  sol: '/',
  bsol: '\\',
  Tab: '\t',
  NewLine: '\n',
  period: '.',
  comma: ',',
  semi: ';',
  equals: '=',
  quest: '?',
  excl: '!',
  num: '#',
  percnt: '%',
  lowbar: '_',
  hyphen: '‐',
  dash: '‐',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lpar: '(',
  rpar: ')',
  lsqb: '[',
  rsqb: ']',
  lbrace: '{',
  rbrace: '}',
  commat: '@',
  dollar: '$',
  plus: '+',
  ast: '*',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwj: '‍',
  zwnj: '‌',
  ZeroWidthSpace: '​',
  NoBreak: '⁠',
  star: '☆',
  starf: '★',
  bigstar: '★',
};
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'shy']);

function fromCode(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
  return String.fromCodePoint(n);
}

/** Decodes HTML character references. `unknown` lists named references this table does not know. */
export function decodeEntities(s) {
  const unknown = [];
  const text = String(s).replace(
    /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z][A-Za-z0-9]*))(;?)/g,
    (m, hex, dec, name, semi) => {
      if (hex) return fromCode(parseInt(hex, 16));
      if (dec) return fromCode(parseInt(dec, 10));
      if (Object.hasOwn(NAMED, name) && (semi || LEGACY.has(name))) return NAMED[name];
      if (semi) unknown.push(m);
      return m;
    },
  );
  return { text, unknown };
}

/** Decodes CSS escapes: \68 (hex, optional trailing space) and \x (any other character). */
export function decodeCssEscapes(s) {
  return String(s).replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (m, hex, ch) =>
    hex ? fromCode(parseInt(hex, 16)) : ch,
  );
}

/** Decodes \uXXXX, \u{X}, \xXX and \/ inside JS source text. */
export function decodeJsEscapes(s) {
  return String(s)
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (m, h) => fromCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => fromCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => fromCode(parseInt(h, 16)))
    .replace(/\\\//g, '/');
}
