import { tokenize, TokenType, type CSSToken } from '@csstools/css-tokenizer';
import type { ImageBook } from './images';

// Mail CSS is tokenized by the CSS Syntax 3 tokenizer (the one Chromium follows) and written back
// token by token. Every URL, wherever it appears, is rewritten to `cid/<n>` or `img/<n>` or
// dropped; at-rules other than the layout ones are removed with their blocks; comments become
// empty comments so removing their text can never join two tokens into a new one.

const KEPT_AT_RULES = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes', 'layer', 'container']);
const URL_FUNCTIONS = new Set(['url', 'src']);
const IMAGE_SETS = new Set(['image-set', '-webkit-image-set']);
const FETCHABLE = /^\s*(?:(?:https?|ftp|wss?|data|javascript|vbscript|file|blob|cid|filesystem):|\/\/|\\\\)/i;
const DROPPED = ' none ';
const SEPARATOR = '/**/';

type Opener = 'fn' | '(' | '[' | '{';

const CLOSES: Partial<Record<TokenType, Opener[]>> = {
  [TokenType.CloseParen]: ['fn', '('],
  [TokenType.CloseSquare]: ['['],
  [TokenType.CloseCurly]: ['{'],
};

/** A stylesheet (`<style>`) or a declaration list (`style=""`), made safe. */
export function sanitizeCss(css: string, images: ImageBook): string {
  const tokens = tokenize({ css }, { onParseError: () => undefined });
  const written = new CssWriter(tokens, images).write();
  // Inside <style> only `</` can end the element; `\/` is the same character to CSS.
  return written.replace(/<\//g, '<\\/');
}

export function cssString(value: string): string {
  return `"${value.replace(/[\\"\n\r\f<>]/g, char => `\\${char.charCodeAt(0).toString(16)} `)}"`;
}

function isOpener(type: TokenType): boolean {
  return type === TokenType.OpenParen || type === TokenType.OpenSquare || type === TokenType.OpenCurly;
}

function isCloser(type: TokenType): boolean {
  return CLOSES[type] !== undefined;
}

class CssWriter {
  private readonly out: string[] = [];
  private readonly open: { kind: Opener; name: string }[] = [];
  private at = 0;

  constructor(
    private readonly tokens: CSSToken[],
    private readonly images: ImageBook,
  ) {}

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
      case TokenType.AtKeyword:
        return this.atRule(token[4].value, token[1]);
      case TokenType.Function:
        return this.func(token[4].value, token[1]);
      default:
        return this.plain(token);
    }
  }

  private emit(text: string, consumed = 1): void {
    this.out.push(text);
    this.at += consumed;
  }

  private plain(token: CSSToken): void {
    const type = token[0];
    if (type === TokenType.OpenParen) this.open.push({ kind: '(', name: '' });
    if (type === TokenType.OpenSquare) this.open.push({ kind: '[', name: '' });
    if (type === TokenType.OpenCurly) this.open.push({ kind: '{', name: '' });
    if (isCloser(type)) this.close(type);
    this.emit(token[1]);
  }

  private close(type: TokenType): void {
    const top = this.open[this.open.length - 1];
    if (top && CLOSES[type]?.includes(top.kind)) this.open.pop();
  }

  private url(value: string): string {
    const source = this.images.source(value);
    if (source.kind === 'none' || !source.url) return DROPPED;
    return `url(${cssString(source.url)})`;
  }

  private string(value: string, raw: string): string {
    if (this.open.some(block => IMAGE_SETS.has(block.name))) return this.url(value);
    return FETCHABLE.test(value) ? '""' : raw;
  }

  private func(name: string, raw: string): void {
    const lower = name.toLowerCase();
    if (!URL_FUNCTIONS.has(lower)) {
      this.open.push({ kind: 'fn', name: lower });
      return this.emit(raw);
    }
    const end = this.matchingClose(this.at);
    const inner = this.tokens.slice(this.at + 1, end);
    const target = inner.find(token => token[0] === TokenType.String);
    const replacement = target ? this.url(String(target[4]?.value ?? '')) : DROPPED;
    this.emit(replacement, end + 1 - this.at);
  }

  /** Drops an at-rule outside the layout allowlist with its prelude and block. */
  private atRule(name: string, raw: string): void {
    if (KEPT_AT_RULES.has(name.toLowerCase())) return this.emit(raw);
    const end = this.ruleEnd(this.at + 1);
    this.emit(SEPARATOR, end - this.at);
  }

  /** Index of the `)` closing the block opened at `start`, or the last token. */
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
