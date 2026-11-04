// CSS from a hostile sender: a `<style>` block or a `style` attribute. The approach is "normalise, then check the
// output": comments and every escape are decoded first and any leftover backslash dropped, so the string emitted
// holds no escapes and the browser tokenises exactly the text these checks read. Then every network-capable
// construct is removed:
// - `url(...)` keeps raster data URLs (and https images when loading) and becomes `none` otherwise; an https image
//   inside a `:hover`, `:active`, `:focus` or `[open]` rule is dropped even when loading (it would report the gesture);
// - functions that take bare string URLs (`image-set`, `src`, `image`, …) and `expression()` become `none`;
// - `@import` and `@namespace` statements and `@font-face` blocks are removed; any left, and `@layer`, are renamed to
//   an unknown at-rule, which the browser skips;
// - `-moz-binding` and `behavior` are renamed to unknown properties;
// - `!important` and every other `!` are removed, so the host's own `!important` rules always win;
// - any other `//host` text outside a kept `url("…")` is erased, so no remote URL survives at all;
// - `<` is removed, so a `<style>` block can never be closed early.
// Every step is linear: plain scans with indexOf, or patterns that cannot backtrack across the input.

import type { ImagePolicy } from './types';
import { decideImage } from './urls';

/** A counter the sanitiser shares across one body. */
export interface BlockedCount {
  blocked: number;
}

/** A `<style>` block is cut to this many characters before sanitising; the rest is dropped. */
export const MAX_STYLE_BLOCK = 200_000;
/** A `style` attribute is cut to this many characters before sanitising; the rest is dropped. */
export const MAX_STYLE_ATTRIBUTE = 8_000;

const ESCAPE = /\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([\s\S]))/gi;
const STRING_URL_FUNCTION =
  /(?<![\w-])(?:-webkit-image-set|image-set|-webkit-cross-fade|cross-fade|image|src|element|paint|expression)\s*\(/gi;
const STATEMENTS = /@(?:import|namespace)\b[^;{}]*;?/gi;
const FONT_FACE = /@font-face\s*\{[^}]*\}?/gi;
const BAD_AT_RULES = /@(import|font-face|namespace|layer)\b/gi;
const BAD_PROPERTIES = /(?<![\w-])(-moz-binding|behaviou?r)\s*:/gi;
const IMPORTANT = /!\s*important/gi;
/** Selectors whose rules apply only after a gesture. */
const INTERACTIVE = /:(?:hover|active|focus)|\[\s*open\b/i;
/** Characters that end remote-looking text. Anything else (other Unicode spaces too) is erased with it. */
const REMOTE_END = new Set(' \t\n\r\f\v"\'(),;{}');
/** Only these characters may appear in a URL we emit inside `url("…")`. */
const SAFE_URL = /^[^\s"'\\<>()]*$/;

function isLetter(code: number): boolean {
  const lower = code | 0x20;
  return lower >= 0x61 && lower <= 0x7a;
}

/** `[a-z0-9+.-]`, case-insensitive: the characters of a URL scheme. */
function isSchemeChar(code: number): boolean {
  return (
    isLetter(code) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2d ||
    code === 0x2e
  );
}

function decodeEscape(_m: string, hex: string | undefined, char: string | undefined): string {
  if (hex === undefined) return char === '\n' ? '' : (char ?? '');
  const code = parseInt(hex, 16);
  const ok = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return ok ? String.fromCodePoint(code) : '\ufffd';
}

/** Comments become a space (as the tokenizer treats them); an unterminated comment swallows the rest. */
function stripComments(css: string): string {
  const out: string[] = [];
  let from = 0;
  let open = css.indexOf('/*');
  while (open !== -1) {
    out.push(css.slice(from, open));
    const close = css.indexOf('*/', open + 2);
    if (close === -1) return out.join('');
    out.push(' ');
    from = close + 2;
    open = css.indexOf('/*', from);
  }
  out.push(css.slice(from));
  return out.join('');
}

/** Decode escapes, then drop every backslash and `<` left, so the output has no escapes and no tag openers. */
function normalise(css: string): string {
  return stripComments(css).replace(ESCAPE, decodeEscape).replace(/[\\<]/g, '');
}

/** The argument of `url(…)`: a whole quoted string or a bare token; null when it is neither. */
function urlArgument(inner: string): string | null {
  const v = inner.trim();
  const quote = v[0];
  if (quote !== '"' && quote !== "'") return /[\s"']/.test(v) ? null : v;
  const body = v.slice(1, -1);
  return v.length > 1 && v.endsWith(quote) && !body.includes(quote) ? body : null;
}

/** The kept `url("…")` for one argument, or null (counted when it named a remote resource). */
function keptUrl(inner: string, policy: ImagePolicy, count: BlockedCount): string | null {
  const raw = urlArgument(inner);
  const decision = raw === null ? null : decideImage(raw, policy);
  if (decision?.keep && SAFE_URL.test(decision.src)) return `url("${decision.src}")`;
  if (decision ? !decision.keep && decision.remote : inner.includes('//')) count.blocked++;
  return null;
}

/**
 * Rewrite every `url(`: one with a closing `)` becomes a kept `url("…")` or `none`; one without becomes `x-blocked(`.
 * Returns the CSS split so that odd indexes are the kept URLs and even indexes the text around them.
 */
function rewriteUrls(css: string, policy: ImagePolicy, count: BlockedCount): string[] {
  const parts: string[] = [];
  let plain = '';
  let from = 0;
  let close = 0;
  for (let paren = css.indexOf('('); paren !== -1; paren = css.indexOf('(', paren + 1)) {
    const open = paren - 3;
    if (open < from || css.slice(open, paren).toLowerCase() !== 'url') continue;
    const start = paren + 1;
    if (close !== -1 && close < start) close = css.indexOf(')', start);
    plain += css.slice(from, open);
    if (close === -1) {
      plain += 'x-blocked(';
      from = start;
      continue;
    }
    const kept = keptUrl(css.slice(start, close), policy, count);
    if (kept === null) {
      plain += 'none';
    } else {
      parts.push(plain, kept);
      plain = '';
    }
    from = close + 1;
    paren = close;
  }
  parts.push(plain + css.slice(from));
  return parts;
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
    if (css.slice(match.index, end).includes('//')) count.blocked++;
    out += `${css.slice(from, match.index)}none`;
    from = end + 1;
  }
  return out + css.slice(from);
}

/** Where remote text ending in the `//` at `at` starts: its `scheme:` when it has one, never before `floor`. */
function remoteStart(css: string, at: number, floor: number): number {
  const colon = at - 1;
  if (colon < floor || css[colon] !== ':') return at;
  let start = colon;
  while (start > floor && isSchemeChar(css.charCodeAt(start - 1))) start--;
  while (start < colon && !isLetter(css.charCodeAt(start))) start++;
  return start < colon ? start : at;
}

/** Erase remote-looking text (`scheme://host…` or `//host…`). A space stands in, so no tokens join around it. */
function scrubRemote(css: string): string {
  const out: string[] = [];
  let from = 0;
  let at = css.indexOf('//');
  while (at !== -1) {
    out.push(css.slice(from, remoteStart(css, at, from)), ' ');
    from = at + 2;
    while (from < css.length && !REMOTE_END.has(css[from]!)) from++;
    at = css.indexOf('//', from);
  }
  out.push(css.slice(from));
  return out.join('');
}

/** The fences for text outside kept URLs. Removals leave a space, so the pieces around them cannot join. */
function fence(css: string): string {
  const unimportant = css.replace(IMPORTANT, ' ').replace(/!/g, ' ');
  const renamed = unimportant
    .replace(BAD_AT_RULES, (_m, name: string) => `@x-blocked-${name}`)
    .replace(BAD_PROPERTIES, (_m, name: string) => `x-blocked-${name}:`);
  return scrubRemote(renamed);
}

/** A replacer that removes the match and counts it when it named a remote resource. */
function removeCounting(count: BlockedCount) {
  return (match: string) => {
    if (match.includes('//')) count.blocked++;
    return '';
  };
}

/** Index of the end of the string opened at `open` (its closing quote, or just before a newline, or the end). */
function stringEnd(css: string, open: number): number {
  const quote = css[open];
  for (let i = open + 1; i < css.length; i++) {
    const c = css[i];
    if (c === quote) return i;
    if (c === '\n' || c === '\r' || c === '\f') return i - 1;
  }
  return css.length;
}

interface Block {
  close: string;
  interactive: boolean;
}

/**
 * Spans `[open, close]` of the rules whose selector needs a gesture, nested rules included. Brackets nest and strings
 * are skipped as the CSS tokenizer does, so a `}` inside a string or a function cannot end a rule early. Runs on
 * sanitised CSS: no comments, no escapes, and every `url(` left is a kept, quoted one.
 */
function interactiveSpans(css: string): [number, number][] {
  const spans: [number, number][] = [];
  const stack: Block[] = [];
  let prelude = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    const top = stack.at(-1);
    const inherited = top?.interactive ?? false;
    if (c === '"' || c === "'") {
      i = stringEnd(css, i);
    } else if (c === '(' || c === '[') {
      stack.push({ close: c === '(' ? ')' : ']', interactive: inherited });
    } else if (c === '{') {
      const interactive = inherited || INTERACTIVE.test(css.slice(prelude, i));
      if (interactive && !inherited) start = i;
      stack.push({ close: '}', interactive });
      prelude = i + 1;
    } else if (c === top?.close) {
      stack.pop();
      if (top.interactive && !stack.at(-1)?.interactive) spans.push([start, i]);
      if (c === '}') prelude = i + 1;
    } else if (c === ';' && (top === undefined || top.close === '}')) {
      prelude = i + 1;
    }
  }
  if (stack.some(block => block.interactive)) spans.push([start, css.length]);
  return spans;
}

/** Join the parts, turning kept remote URLs inside gesture rules into `none`. */
function dropInteractiveUrls(parts: string[], count: BlockedCount): string {
  const joined = parts.join('');
  if (!INTERACTIVE.test(joined)) return joined;
  const spans = interactiveSpans(joined);
  let offset = 0;
  let s = 0;
  return parts
    .map((part, i) => {
      const at = offset;
      offset += part.length;
      if (i % 2 === 0 || part.startsWith('url("data:')) return part;
      while (s < spans.length && spans[s]![1] < at) s++;
      if (s === spans.length || spans[s]![0] > at) return part;
      count.blocked++;
      return 'none';
    })
    .join('');
}

/** Sanitise CSS text under the image policy; remote references removed are added to `count`. */
export function sanitiseCss(css: string, policy: ImagePolicy, count: BlockedCount): string {
  const rules = normalise(css)
    .replace(STATEMENTS, removeCounting(count))
    .replace(FONT_FACE, removeCounting(count));
  const parts = rewriteUrls(removeFunctions(rules, count), policy, count);
  return dropInteractiveUrls(
    parts.map((part, i) => (i % 2 === 1 ? part : fence(part))),
    count,
  );
}
