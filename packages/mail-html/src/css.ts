import { tokenize, TokenType, type CSSToken } from '@csstools/css-tokenizer';
import { scopeId } from './ids';
import type { ImageBook } from './images';
import { asciiLower } from './parse';
import { urlCleanup } from './url';

// Mail CSS is tokenized by the CSS Syntax 3 tokenizer (the algorithm Chromium follows) and written
// back token by token, so the browser re-reads the same tokens. Every URL, wherever it appears, is
// rewritten to `cid/<n>` or `img/<n>` or dropped; a string that looks like an address is emptied
// (it could reach a fetch through `src(var(--x))`); `attr()` goes (an attribute value must never
// become a URL); at-rules other than the layout ones are removed with their blocks; comments become
// empty comments so removing their text can never join two tokens into a new one; `#id` selectors
// follow the id rewrite (ids.ts). Inside `<style>` only `</` can end the element, so it never
// appears in the output.

const KEPT_AT_RULES = new Set([
  'media',
  'supports',
  'keyframes',
  '-webkit-keyframes',
  'layer',
  'container',
]);
const URL_FUNCTIONS = new Set(['url', 'src']);
/** Functions whose string arguments are image URLs. */
const IMAGE_FUNCTIONS = new Set(['image-set', '-webkit-image-set', 'image']);
const DROPPED_FUNCTIONS = new Set(['attr', 'expression']);
/** A string the URL parser would read as absolute or scheme-relative (it ignores tabs and newlines). */
const FETCHABLE = /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i;
const DROPPED = ' none ';
const SEPARATOR = '/**/';

const enum Structure {
  None = 0,
  OpenCurly = 1,
  Semicolon = 2,
  CloseCurly = 3,
}

type Opener = 'fn' | '(' | '[' | '{';

const CLOSES: Partial<Record<TokenType, Opener[]>> = {
  [TokenType.CloseParen]: ['fn', '('],
  [TokenType.CloseSquare]: ['['],
  [TokenType.CloseCurly]: ['{'],
};

function cssTokens(css: string): CSSToken[] {
  return tokenize({ css }, { onParseError: () => undefined });
}

/** A stylesheet (`<style>`) or a declaration list (`style=""`), made safe. */
export function sanitizeCss(css: string, images: ImageBook): string {
  const written = new CssWriter(cssTokens(css), images).write();
  // Safety net: the writer never leaves `</` outside a string, and `\/` is `/` inside one.
  return written.replaceAll('</', '<\\/').replaceAll('\u0000', '�');
}

export function cssString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.charCodeAt(0);
    const plain =
      code >= 0x20 &&
      code !== 0x7f &&
      char !== '\\' &&
      char !== '"' &&
      char !== '<' &&
      char !== '>';
    out += plain ? char : `\\${code.toString(16)} `;
  }
  return `${out}"`;
}

/** An identifier, escaped so the tokenizer reads it back as exactly this value. */
export function cssIdent(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const plain = code >= 0x80 || /^[A-Za-z0-9_-]$/.test(char);
    out += plain ? char : `\\${code.toString(16)} `;
  }
  return out;
}

function looksFetchable(value: string): boolean {
  return FETCHABLE.test(urlCleanup(value));
}

function isOpener(type: TokenType): boolean {
  return (
    type === TokenType.OpenParen || type === TokenType.OpenSquare || type === TokenType.OpenCurly
  );
}

function isCloser(type: TokenType): boolean {
  return CLOSES[type] !== undefined;
}

/** For each token, the next `{`, `;` or `}` after it: a `#x` followed by `{` is a selector. */
function structureAfter(tokens: CSSToken[]): Uint8Array {
  const after = new Uint8Array(tokens.length);
  let next = Structure.None;
  for (let index = tokens.length - 1; index >= 0; index--) {
    after[index] = next;
    const type = tokens[index][0];
    if (type === TokenType.OpenCurly) next = Structure.OpenCurly;
    if (type === TokenType.Semicolon) next = Structure.Semicolon;
    if (type === TokenType.CloseCurly) next = Structure.CloseCurly;
  }
  return after;
}

class CssWriter {
  private readonly out: string[] = [];
  private readonly open: { kind: Opener; image: boolean }[] = [];
  private readonly structure: Uint8Array;
  private imageDepth = 0;
  private at = 0;

  constructor(
    private readonly tokens: CSSToken[],
    private readonly images: ImageBook,
  ) {
    this.structure = structureAfter(tokens);
  }

  write(): string {
    while (this.at < this.tokens.length) this.step(this.tokens[this.at]);
    return this.out.join('');
  }

  private step(token: CSSToken): void {
    switch (token[0]) {
      case TokenType.Comment:
        return this.emit(SEPARATOR);
      case TokenType.BadString:
        return this.emit('""');
      case TokenType.BadURL:
        return this.emit(DROPPED);
      case TokenType.URL:
        return this.emit(this.url(token[4].value));
      case TokenType.String:
        return this.emit(this.string(token[4].value, token[1]));
      case TokenType.Hash:
        return this.emit(this.hash(token));
      case TokenType.AtKeyword:
        return this.atRule(token[4].value, token[1]);
      case TokenType.Function:
        return this.func(token[4].value, token[1]);
      default:
        return this.plain(token);
    }
  }

  /** Appends text; a space keeps a `<` and a following `/` from ever meeting. */
  private emit(text: string, consumed = 1): void {
    const last = this.out[this.out.length - 1];
    if (last?.endsWith('<') && text.startsWith('/')) this.out.push(' ');
    this.out.push(text);
    this.at += consumed;
  }

  private plain(token: CSSToken): void {
    const type = token[0];
    if (isOpener(type))
      this.push(
        type === TokenType.OpenParen ? '(' : type === TokenType.OpenSquare ? '[' : '{',
        false,
      );
    if (isCloser(type)) this.close(type);
    this.emit(token[1]);
  }

  private push(kind: Opener, image: boolean): void {
    this.open.push({ kind, image });
    if (image) this.imageDepth++;
  }

  private close(type: TokenType): void {
    const top = this.open[this.open.length - 1];
    if (!top || !CLOSES[type]?.includes(top.kind)) return;
    this.open.pop();
    if (top.image) this.imageDepth--;
  }

  private url(value: string): string {
    const source = this.images.source(value, 'css');
    if (source.kind === 'none' || !source.url) return DROPPED;
    return `url(${cssString(source.url)})`;
  }

  private string(value: string, raw: string): string {
    if (this.imageDepth > 0) return this.url(value);
    return looksFetchable(value) ? '""' : raw.replaceAll('</', '<\\/');
  }

  private hash(token: CSSToken): string {
    const selector = this.structure[this.at] === Structure.OpenCurly;
    if (token[0] !== TokenType.Hash || !selector || token[4].type !== 'id') return token[1];
    return `#${cssIdent(scopeId(token[4].value))}`;
  }

  private func(name: string, raw: string): void {
    const lower = asciiLower(name);
    if (URL_FUNCTIONS.has(lower))
      return this.replaceFunction(target => (target === undefined ? DROPPED : this.url(target)));
    if (DROPPED_FUNCTIONS.has(lower)) return this.replaceFunction(() => '""');
    this.push('fn', IMAGE_FUNCTIONS.has(lower));
    this.emit(raw);
  }

  /** Replaces a whole function, up to its `)`, with what `make` returns for its first string. */
  private replaceFunction(make: (firstString: string | undefined) => string): void {
    const end = this.matchingClose(this.at);
    let first: string | undefined;
    for (let index = this.at + 1; index < end && first === undefined; index++) {
      const token = this.tokens[index];
      if (token[0] === TokenType.String) first = token[4].value;
    }
    this.emit(make(first), end + 1 - this.at);
  }

  /** Drops an at-rule outside the layout allowlist with its prelude and block. */
  private atRule(name: string, raw: string): void {
    if (KEPT_AT_RULES.has(asciiLower(name))) return this.emit(raw);
    const end = this.ruleEnd(this.at + 1);
    this.emit(SEPARATOR, end - this.at);
  }

  /** Index of the `)` closing the function opened at `start`, or the last token. */
  private matchingClose(start: number): number {
    let depth = 0;
    for (let index = start; index < this.tokens.length; index++) {
      const type = this.tokens[index][0];
      if (type === TokenType.Function || isOpener(type)) depth++;
      if (isCloser(type)) depth--;
      if (depth === 0) return index;
    }
    return this.tokens.length - 1;
  }

  /** Index just past an at-rule: after its `;` or its `{}` block, before a closer that is not its own. */
  private ruleEnd(start: number): number {
    let depth = 0;
    for (let index = start; index < this.tokens.length; index++) {
      const type = this.tokens[index][0];
      if (type === TokenType.EOF) return index;
      if (type === TokenType.Semicolon && depth === 0) return index + 1;
      if (type === TokenType.Function || isOpener(type)) depth++;
      if (!isCloser(type)) continue;
      if (depth === 0) return index;
      depth--;
      if (depth === 0 && type === TokenType.CloseCurly) return index + 1;
    }
    return this.tokens.length;
  }
}

/**
 * The top-level declarations of a `style` attribute, property to value (lowercase, `!important`
 * removed, the last one winning). Read from tokens, so escapes and comments cannot hide one.
 */
export function readDeclarations(css: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const tokens = cssTokens(css);
  let index = 0;
  while (index < tokens.length) index = readDeclaration(tokens, index, declarations);
  return declarations;
}

function skipSpace(tokens: CSSToken[], index: number): number {
  let at = index;
  while (
    at < tokens.length &&
    (tokens[at][0] === TokenType.Whitespace || tokens[at][0] === TokenType.Comment)
  )
    at++;
  return at;
}

function readDeclaration(tokens: CSSToken[], start: number, into: Map<string, string>): number {
  let at = skipSpace(tokens, start);
  const name = tokens[at];
  at = skipSpace(tokens, at + 1);
  const isDeclaration = name?.[0] === TokenType.Ident && tokens[at]?.[0] === TokenType.Colon;
  const values: string[] = [];
  let depth = 0;
  for (at = isDeclaration ? at + 1 : at; at < tokens.length; at++) {
    const type = tokens[at][0];
    if (type === TokenType.Semicolon && depth === 0) break;
    if (type === TokenType.Function || isOpener(type)) depth++;
    if (isCloser(type)) depth = Math.max(0, depth - 1);
    values.push(tokenText(tokens[at]));
  }
  if (isDeclaration && name[0] === TokenType.Ident) {
    into.set(asciiLower(name[4].value), cleanValue(values.join('')));
  }
  return Math.max(at + 1, start + 1);
}

/** A token's meaning as text: escapes decoded, units kept. */
function tokenText(token: CSSToken): string {
  switch (token[0]) {
    case TokenType.Comment:
      return ' ';
    case TokenType.Ident:
    case TokenType.String:
      return token[4].value;
    case TokenType.Number:
      return String(token[4].value);
    case TokenType.Percentage:
      return `${token[4].value}%`;
    case TokenType.Dimension:
      return `${token[4].value}${token[4].unit}`;
    default:
      return token[1];
  }
}

function cleanValue(value: string): string {
  const lower = asciiLower(value).trim();
  const bang = lower.lastIndexOf('!');
  const important = bang >= 0 && lower.slice(bang + 1).trim() === 'important';
  return (important ? lower.slice(0, bang) : lower).trim();
}
