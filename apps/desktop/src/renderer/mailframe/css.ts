// CSS from a hostile sender: a `<style>` block or a `style` attribute. The approach is "normalise, then check the
// output": comments and every escape are decoded first and any leftover backslash dropped, so the string emitted
// holds no escapes and the browser tokenises exactly the text these checks read. Then every network-capable
// construct is removed:
// - `url(...)` keeps raster data URLs (and https images when loading) and becomes `none` otherwise;
// - functions that take bare string URLs (`image-set`, `src`, `image`, …) and `expression()` become `none`;
// - `@import` and `@namespace` statements and `@font-face` blocks are removed; any left are renamed to an unknown
//   at-rule, which the browser skips;
// - `-moz-binding` and `behavior` are renamed to unknown properties;
// - any other `//host` text outside a kept `url("…")` is erased, so no remote URL survives at all;
// - `<` is removed, so a `<style>` block can never be closed early.

import type { ImagePolicy } from './types';
import { decideImage } from './urls';

/** A counter the sanitiser shares across one body. */
export interface BlockedCount {
  blocked: number;
}

const ESCAPE = /\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([\s\S]))/gi;
const URL_TOKEN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;
const LEFTOVER_URL = /url\(\s*(?!"(?:data:image\/|https:)[^"]*"\))/gi;
const STRING_URL_FUNCTION =
  /(?<![\w-])(?:-webkit-image-set|image-set|-webkit-cross-fade|cross-fade|image|src|element|paint|expression)\s*\(/gi;
const STATEMENTS = /@(?:import|namespace)\b[^;{}]*;?/gi;
const FONT_FACE = /@font-face\s*\{[^}]*\}?/gi;
const BAD_AT_RULES = /@(import|font-face|namespace)\b/gi;
const BAD_PROPERTIES = /(?<![\w-])(-moz-binding|behaviou?r)\s*:/gi;
const KEPT_URL = /(url\("(?:data:image\/|https:)[^"]*"\))/i;
const REMOTE_TEXT = /(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s"'(),;{}]*/gi;
/** Only these characters may appear in a URL we emit inside `url("…")`. */
const SAFE_URL = /^[^\s"'\\<>()]*$/;

function decodeEscape(_m: string, hex: string | undefined, char: string | undefined): string {
  if (hex === undefined) return char === '\n' ? '' : (char ?? '');
  const code = parseInt(hex, 16);
  const ok = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return ok ? String.fromCodePoint(code) : '\ufffd';
}

/** Comments become a space (as the tokenizer treats them); an unterminated comment swallows the rest. */
function stripComments(css: string): string {
  const closed = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const open = closed.indexOf('/*');
  return open === -1 ? closed : closed.slice(0, open);
}

/** Decode escapes, then drop every backslash and `<` left, so the output has no escapes and no tag openers. */
function normalise(css: string): string {
  return stripComments(css).replace(ESCAPE, decodeEscape).replace(/[\\<]/g, '');
}

function rewriteUrl(raw: string, policy: ImagePolicy, count: BlockedCount): string {
  const decision = decideImage(raw.trim(), policy);
  if (decision.keep && SAFE_URL.test(decision.src)) return `url("${decision.src}")`;
  if (!decision.keep && decision.remote) count.blocked++;
  return 'none';
}

/** Replace each call of a string-URL function, arguments and all (balanced parentheses), with `none`. */
function removeFunctions(css: string, count: BlockedCount): string {
  let out = '';
  let from = 0;
  for (const match of css.matchAll(STRING_URL_FUNCTION)) {
    if (match.index < from) continue;
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < css.length; end++) {
      if (css[end] === '(') depth++;
      else if (css[end] === ')' && --depth === 0) break;
    }
    if (/\/\//.test(css.slice(match.index, end))) count.blocked++;
    out += `${css.slice(from, match.index)}none`;
    from = end + 1;
  }
  return out + css.slice(from);
}

/** Erase remote-looking text everywhere except inside a kept `url("…")`. */
function scrubRemote(css: string): string {
  return css
    .split(KEPT_URL)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(REMOTE_TEXT, '')))
    .join('');
}

/** A replacer that removes the match and counts it when it named a remote resource. */
function removeCounting(count: BlockedCount) {
  return (match: string) => {
    if (/\/\//.test(match)) count.blocked++;
    return '';
  };
}

/** Sanitise CSS text under the image policy; remote references removed are added to `count`. */
export function sanitiseCss(css: string, policy: ImagePolicy, count: BlockedCount): string {
  const rules = normalise(css)
    .replace(STATEMENTS, removeCounting(count))
    .replace(FONT_FACE, removeCounting(count));
  const urls = rules.replace(URL_TOKEN, (_m, dq?: string, sq?: string, bare?: string) =>
    rewriteUrl(dq ?? sq ?? bare ?? '', policy, count),
  );
  // A `url(` the token pattern could not read (unbalanced, odd quoting) is neutralised, never kept.
  const fenced = removeFunctions(urls.replace(LEFTOVER_URL, 'x-blocked('), count)
    .replace(BAD_AT_RULES, (_m, name: string) => `@x-blocked-${name}`)
    .replace(BAD_PROPERTIES, (_m, name: string) => `x-blocked-${name}:`);
  return scrubRemote(fenced);
}
