import { tokenize, TokenType, type CSSToken } from '@csstools/css-tokenizer';
import { classValueRewrites } from './class-selectors';
import { replaceControls } from './escape';
import { ID_PREFIX, isOwnClass, scopeId } from './ids';
import type { ImageBook } from './images';
import { asciiLower } from './parse';
import { urlCleanup } from './url';

// Mail CSS is tokenized by the CSS Syntax 3 tokenizer (the algorithm Chromium follows) and written
// back token by token, so the browser re-reads the same tokens. Every URL, wherever it appears, is
// rewritten to `cid/<n>` or `img/<n>` or dropped; a string that looks like an address is emptied
// (it could reach a fetch through `src(var(--x))`); `attr()` goes (an attribute value must never
// become a URL), and so do `var()` and `env()` inside an image function; at-rules other than the layout ones are removed with their blocks; comments become
// empty comments so removing their text can never join two tokens into a new one; `#id` selectors
// follow the id rewrite (ids.ts); `aplos-` class names follow the class rewrite in every selector
// position (`.aplos-x`, `[class^=aplos-]`, inside `:is()` and the like, class-selectors.ts). Inside `<style>` only `</` can end the element, so it never
// appears in the output. Layer names move to `m-` (ids.ts); height-following media features and `writing-mode` become unknown names. A viewport or container-query unit (`100vh`, `50dvw`, `100cqh`, inside `calc()` too) becomes a length in px
// against a fixed reading viewport (`viewportLength`): the frame is sized to the letter, so a letter
// sized by its own viewport would grow the frame, which grows the letter, without end.

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
/**
 * `attr` and `expression` (an attribute value must never reach a URL); `if`, whose `media()` conditions take
 * the very height and orientation features the @media rewrite renames; `scroll` and `view`, the scroll-driven
 * animation timelines. A dropped function leaves `""`, so the declaration is invalid and the browser ignores it.
 */
const DROPPED_FUNCTIONS = new Set(['attr', 'expression', 'if', 'scroll', 'view']);
/** Inside an image function these could put a value in URL position that this writer never saw. */
const NO_IMAGE_FUNCTIONS = new Set(['var', 'env', 'attr']);
/** A string the URL parser would read as absolute or scheme-relative (it ignores tabs and newlines). */
const FETCHABLE = /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i;
const DROPPED = ' none ';
const SEPARATOR = '/**/';
/**
 * `vw`, `vh`, `vi`, `vb`, `vmin`, `vmax` with their `s`, `l` and `d` forms, and the container-query units
 * `cqw` ... `cqmax`: with no container the latter resolve against the small viewport, exactly like `vh`, and
 * the mail can declare no container we could rely on. Units compare in lowercase.
 */
const VIEWPORT_UNIT = /^(?:[sld]?v|cq)(?:w|h|i|b|min|max)$/;
/** The viewport a letter's viewport units are measured against, in px: roughly the reading pane. */
const READING_VIEWPORT = { width: 640, height: 600 };
const MAX_LENGTH_PX = 100_000;

/** What ends an at-rule prelude. */
const STOPS_PRELUDE = new Set([TokenType.OpenCurly, TokenType.Semicolon, TokenType.CloseCurly]);
/**
 * Media and container features that follow the frame's own height or shape. The frame is sized to the
 * letter, so a letter that styles itself by them is sized by the frame: `(max-height:300px)` and
 * `(orientation:landscape)` flip with every report, for ever. They are renamed to a custom-property
 * identifier, an unknown feature, so the query is false (the desktop layout) and the rule beside it cannot
 * toggle. The width features stay: the host fixes the frame's width.
 */
const HEIGHT_FEATURES = new Set([
  'height',
  'min-height',
  'max-height',
  'block-size',
  'min-block-size',
  'max-block-size',
  'aspect-ratio',
  'min-aspect-ratio',
  'max-aspect-ratio',
  'orientation',
  'device-height',
  'min-device-height',
  'max-device-height',
  'device-aspect-ratio',
  'min-device-aspect-ratio',
  'max-device-aspect-ratio',
]);
const QUERY_AT_RULES = new Set(['media', 'container']);
/**
 * `writing-mode` outside the root (under any vendor prefix: Chromium honours `-epub-writing-mode` and `-webkit-writing-mode` as aliases) turns a block's length into its width and back: vertical text in a
 * `div` grows 182, 214, 246 px ... for ever as the frame follows it. The property name becomes a custom
 * property (`--m-writing-mode`), which does nothing. Vertical text is lost to mail; the root and body are
 * kept horizontal by the reading layer anyway.
 */
const WRITING_MODE = /writing-mode$/;
/**
 * Scroll-driven animations (`animation-timeline:scroll(root)`, `view()`) tie an animation's progress to a
 * scroller's size, which is the frame's: a height keyframe flips the letter between two sizes for ever. The
 * timeline properties become custom properties too; ordinary animations and transitions are untouched.
 */
const TIMELINE =
  /^(?:-webkit-)?(?:animation-timeline|animation-range(?:-start|-end)?|scroll-timeline(?:-[a-z]+)?|view-timeline(?:-[a-z]+)?|timeline-scope)$/;

const enum Structure {
  None = 0,
  OpenCurly = 1,
  Semicolon = 2,
  CloseCurly = 3,
}

type Opener = 'fn' | '(' | '[' | '{';

const OPENERS: Partial<Record<TokenType, Opener>> = {
  [TokenType.OpenParen]: '(',
  [TokenType.OpenSquare]: '[',
  [TokenType.OpenCurly]: '{',
};

const CLOSER_OF: Partial<Record<TokenType, TokenType>> = {
  [TokenType.Function]: TokenType.CloseParen,
  [TokenType.OpenParen]: TokenType.CloseParen,
  [TokenType.OpenSquare]: TokenType.CloseSquare,
  [TokenType.OpenCurly]: TokenType.CloseCurly,
};

const CLOSES: Partial<Record<TokenType, Opener[]>> = {
  [TokenType.CloseParen]: ['fn', '('],
  [TokenType.CloseSquare]: ['['],
  [TokenType.CloseCurly]: ['{'],
};

export function cssTokens(css: string): CSSToken[] {
  return tokenize({ css }, { onParseError: () => undefined });
}

/** A stylesheet (`<style>`) or a declaration list (`style=""`), made safe. */
export function sanitizeCss(css: string, images: ImageBook, tokens = cssTokens(css)): string {
  const written = new CssWriter(tokens, images).write();
  // Safety net: the writer never leaves `</` outside a string, and `\/` is `/` inside one.
  return replaceControls(written.replaceAll('</', '<\\/'));
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

/**
 * A viewport or container-query length as fixed px, or undefined for any other unit. 1vh is a hundredth of
 * `READING_VIEWPORT`'s height and so on; `vmin` and `vmax` take the smaller and larger side.
 */
export function viewportLength(value: number, unit: string): string | undefined {
  const lower = asciiLower(unit);
  if (!VIEWPORT_UNIT.test(lower)) return undefined;
  const axis = lower.startsWith('cq') ? lower.slice(2) : lower.slice(lower.lastIndexOf('v') + 1);
  const px = (value * viewportSide(axis)) / 100;
  const bounded = Math.max(-MAX_LENGTH_PX, Math.min(MAX_LENGTH_PX, px));
  return `${Math.round(bounded * 100) / 100}px`;
}

/** The side a unit's last letters name: `w`/`i` the width, `h`/`b` the height, `min` and `max` the smaller and larger. */
function viewportSide(axis: string): number {
  const { width, height } = READING_VIEWPORT;
  if (axis === 'w' || axis === 'i') return width;
  if (axis === 'h' || axis === 'b') return height;
  return axis === 'min' ? Math.min(width, height) : Math.max(width, height);
}

function looksFetchable(value: string): boolean {
  return FETCHABLE.test(urlCleanup(value));
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
  private readonly classValues: Map<number, string>;
  private imageDepth = 0;
  /** Between `@layer` and the `{` or `;` that ends its prelude: identifiers there are layer names. */
  private layerNames = false;
  /** Between `@media` or `@container` and its `{`: feature names are in the prelude. */
  private queryFeatures = false;
  private at = 0;

  constructor(
    private readonly tokens: CSSToken[],
    private readonly images: ImageBook,
  ) {
    this.structure = structureAfter(tokens);
    this.classValues = classValueRewrites(tokens);
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
      case TokenType.Ident:
        return this.emit(this.ident(token));
      case TokenType.AtKeyword:
        return this.atRule(token[4].value, token[1]);
      case TokenType.Function:
        return this.func(token[4].value, token[1]);
      case TokenType.Dimension:
        return this.emit(this.dimension(token));
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

  private isSpace(index: number): boolean {
    const type = this.tokens[index]?.[0];
    return type === TokenType.Whitespace || type === TokenType.Comment;
  }

  /** A viewport length as px, keeping the `+` the number was written with (`calc(1px+100vh)`). */
  private dimension(token: CSSToken): string {
    if (token[0] !== TokenType.Dimension) return token[1];
    const length = viewportLength(token[4].value, token[4].unit);
    if (length === undefined) return token[1];
    return token[1].startsWith('+') ? `+${length}` : length;
  }

  private plain(token: CSSToken): void {
    if (STOPS_PRELUDE.has(token[0])) {
      this.layerNames = false;
      this.queryFeatures = false;
    }
    const kind = OPENERS[token[0]];
    if (kind) this.push(kind, false);
    if (isCloser(token[0])) this.close(token[0]);
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
    // A `[class=…]` value is written as rewritten, so it is judged as rewritten, like any string.
    const moved = this.classValues.get(this.at);
    const text = moved ?? value;
    if (this.imageDepth > 0) return this.url(text);
    if (looksFetchable(text)) return '""';
    return moved === undefined ? raw.replaceAll('</', '<\\/') : cssString(moved);
  }

  private hash(token: CSSToken): string {
    const selector = this.structure[this.at] === Structure.OpenCurly;
    if (token[0] !== TokenType.Hash || !selector || token[4].type !== 'id') return token[1];
    return `#${cssIdent(scopeId(token[4].value))}`;
  }

  /**
   * `.aplos-x` names Aplos's own elements; the mail's class moved to `m-aplos-x`. Whatever the
   * position (a selector list, `:is(`, a malformed rule): the browser drops comments, so a dot, a
   * comment and a name are still a class. Also the value of a `[class=…]` selector (class-selectors.ts).
   */
  private ident(token: CSSToken): string {
    if (token[0] === TokenType.Ident && this.layerNames) return cssIdent(scopeId(token[4].value));
    if (token[0] === TokenType.Ident && this.unsafeName(asciiLower(token[4].value))) {
      return `--m-${asciiLower(token[4].value)}`;
    }
    const attribute = this.classValues.get(this.at);
    if (attribute !== undefined) return cssIdent(attribute);
    if (token[0] !== TokenType.Ident || !isOwnClass(token[4].value) || !this.afterDot()) {
      return token[1];
    }
    return cssIdent(ID_PREFIX + token[4].value);
  }

  /** A height feature in a query prelude, or a `writing-mode` or timeline property name (an identifier before a colon). */
  private unsafeName(lower: string): boolean {
    if (this.queryFeatures) return HEIGHT_FEATURES.has(lower);
    if (lower.startsWith('--') || !(WRITING_MODE.test(lower) || TIMELINE.test(lower))) return false;
    let next = this.at + 1;
    while (this.isSpace(next)) next++;
    return this.tokens[next]?.[0] === TokenType.Colon;
  }

  private afterDot(): boolean {
    let before = this.at - 1;
    while (before >= 0 && this.tokens[before][0] === TokenType.Comment) before--;
    const previous = this.tokens[before];
    return previous?.[0] === TokenType.Delim && previous[4].value === '.';
  }

  private func(name: string, raw: string): void {
    const lower = asciiLower(name);
    if (URL_FUNCTIONS.has(lower))
      return this.replaceFunction(target => (target === undefined ? DROPPED : this.url(target)));
    if (this.imageDepth > 0 && NO_IMAGE_FUNCTIONS.has(lower))
      return this.replaceFunction(() => DROPPED);
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
    const lower = asciiLower(name);
    // The names in an `@layer` prelude move into the mail's `m-` namespace, so no mail layer can be the
    // reading layer (reading-css.ts), whose !important rules would then be open to the mail's.
    this.layerNames = lower === 'layer';
    this.queryFeatures = QUERY_AT_RULES.has(lower);
    if (KEPT_AT_RULES.has(lower)) return this.emit(raw);
    const end = this.ruleEnd(this.at + 1);
    this.emit(SEPARATOR, end - this.at);
  }

  /** Index of the `)` closing the function opened at `start`, or the last token. */
  private matchingClose(start: number): number {
    const blocks = new BlockTracker();
    for (let index = start; index < this.tokens.length; index++) {
      blocks.read(this.tokens[index][0]);
      if (blocks.depth === 0) return index;
    }
    return this.tokens.length - 1;
  }

  /** Index just past an at-rule: after its `;` or its `{}` block, before a closer that is not its own. */
  private ruleEnd(start: number): number {
    const blocks = new BlockTracker();
    for (let index = start; index < this.tokens.length; index++) {
      const type = this.tokens[index][0];
      if (type === TokenType.EOF) return index;
      if (blocks.depth === 0 && type === TokenType.Semicolon) return index + 1;
      if (blocks.depth === 0 && isCloser(type)) return index;
      blocks.read(type);
      if (blocks.depth === 0 && type === TokenType.CloseCurly) return index + 1;
    }
    return this.tokens.length;
  }
}

/**
 * Open blocks as CSS Syntax reads them: a block ends only at its own closer (`)` for a function
 * or `(`, `]` for `[`, `}` for `{`); any other closer inside it is an ordinary token.
 */
class BlockTracker {
  private readonly expected: TokenType[] = [];

  get depth(): number {
    return this.expected.length;
  }

  read(type: TokenType): void {
    const closer = CLOSER_OF[type];
    if (closer !== undefined) this.expected.push(closer);
    else if (type === this.expected[this.expected.length - 1]) this.expected.pop();
  }
}

/**
 * The top-level declarations of a `style` attribute, property to value (lowercase, `!important`
 * removed, the last one winning). Read from tokens, so escapes and comments cannot hide one.
 */
export function readDeclarations(css: string, tokens = cssTokens(css)): Map<string, string> {
  const declarations = new Map<string, string>();
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
  const blocks = new BlockTracker();
  for (at = isDeclaration ? at + 1 : at; at < tokens.length; at++) {
    const type = tokens[at][0];
    if (type === TokenType.Semicolon && blocks.depth === 0) break;
    blocks.read(type);
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

/**
 * The declarations of a style attribute whose property name `allowed` accepts, as source text joined by `;`
 * (a name is read through escapes and compared in lowercase). A declaration ends at a `;` outside any
 * bracket, so a `;` in a string, url or function cannot cut it short. Custom properties, malformed
 * declarations and everything not allowed are left out; the rest is as written, `!important` included.
 */
export function keepDeclarations(
  css: string,
  allowed: (name: string, value: readonly CSSToken[]) => boolean,
  tokens = cssTokens(css),
): string {
  const kept: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const start = index;
    const blocks = new BlockTracker();
    for (; index < tokens.length; index++) {
      const type = tokens[index][0];
      if (type === TokenType.Semicolon && blocks.depth === 0) break;
      blocks.read(type);
    }
    const head = declarationHead(tokens, start, index);
    const text = tokens
      .slice(start, index)
      .map(token => token[1])
      .join('');
    if (head && allowed(head.name, tokens.slice(head.valueFrom, index))) kept.push(text);
    index++;
  }
  return kept.join(';');
}

/** The lowercase property name a declaration in `tokens[from, to)` starts with, and where its value starts. */
function declarationHead(
  tokens: CSSToken[],
  from: number,
  to: number,
): { name: string; valueFrom: number } | undefined {
  let at = skipSpace(tokens, from);
  const name = tokens[at];
  at = skipSpace(tokens, at + 1);
  if (at >= to || name?.[0] !== TokenType.Ident || tokens[at]?.[0] !== TokenType.Colon)
    return undefined;
  return { name: asciiLower(name[4].value), valueFrom: at + 1 };
}
