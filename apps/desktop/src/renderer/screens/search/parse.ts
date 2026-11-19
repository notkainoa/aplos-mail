/**
 * The Search page's operator parser (DESIGN §7.9; gap list E51: `ui-ask` owns it, the engine takes the structured
 * `SearchQuery`). Pure, no React.
 *
 * Grammar, one term at a time, separated by whitespace:
 * - `key:value` where key is from, to, subject, has, is, before, after or in (any case). The value is a bare word, or
 *   a quoted string `"Jordan Park"` with `\"` and `\\` escapes; an unclosed quote runs to the end of the text.
 * - Values are checked: `has:` takes `attachment` (or `attachments`), `is:` takes `unread`, `read`, `flagged` or
 *   `bookmarked`, `before:` and `after:` take a real date `YYYY-MM-DD` or `YYYY/MM/DD`, `in:` lower-cases a known
 *   place (`done`, `later`, `inbox`, …) and keeps a label name as typed. An empty or invalid value leaves the term
 *   as free text, so `before:soon` is just words.
 * - Anything else is free text. A free term that starts with a quote runs to its closing quote (a phrase).
 *
 * One operator, one value: `SearchQuery` holds a single `from`, `to`, `subject`, `before`, `after` and `in`, so a
 * later token of the same operator replaces the earlier one; `is:` is the exception — several flags can hold at
 * once (`is:unread is:flagged`), so the tokens for it accumulate in order of appearance.
 */
import type { SearchQuery } from '../../data';
import type { SearchOperator } from '../../ui/props';

/** The operators the page recognises: the component's union plus `is`, which the props union still lacks (REQUESTS.md). */
export type Operator = SearchOperator | 'is';

/** A recognised operator with its normalised value. */
export interface SearchToken {
  readonly operator: Operator;
  readonly value: string;
}

/** One term of the text, with where it sits. */
export type SearchTerm =
  | {
      readonly kind: 'op';
      readonly operator: Operator;
      readonly value: string;
      readonly start: number;
      readonly end: number;
      /** Followed by whitespace: the owner has finished typing it, so the field may turn it into a pill. */
      readonly complete: boolean;
    }
  | { readonly kind: 'free'; readonly text: string; readonly start: number; readonly end: number };

/** The parsed text: its tokens (one per operator, last wins; `is:` accumulates) and the free words. */
export interface ParsedSearch {
  readonly tokens: readonly SearchToken[];
  /** Free terms joined by one space. */
  readonly free: string;
}

export const OPERATORS: readonly Operator[] = [
  'from',
  'to',
  'subject',
  'has',
  'is',
  'before',
  'after',
  'in',
];

/** Values `is:` takes (the contract's `SearchQuery.is`). */
export const KNOWN_FLAGS = ['unread', 'read', 'flagged', 'bookmarked'] as const;

/** Places `in:` understands; anything else is a label name the engine resolves to a folder id. */
export const KNOWN_PLACES = [
  'inbox',
  'done',
  'later',
  'sent',
  'drafts',
  'trash',
  'spam',
  'all',
  'archive',
  'starred',
  'important',
  'bookmarks',
] as const;

const KEY = /^(from|to|subject|has|is|before|after|in):/i;
const SPACE = /\s/;

function isSpace(char: string | undefined): boolean {
  return char !== undefined && SPACE.test(char);
}

/** A real calendar day as `YYYY-MM-DD`, or null. */
export function normaliseDate(value: string): string | null {
  const hit = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (!hit) return null;
  const y = Number(hit[1]);
  const m = Number(hit[2]);
  const d = Number(hit[3]);
  if (m < 1 || m > 12 || d < 1) return null;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > days) return null;
  return `${hit[1]}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The normalised value an operator takes, or null when the value is not one it understands. */
export function normaliseValue(operator: Operator, raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  switch (operator) {
    case 'has':
      return /^attachments?$/i.test(value) ? 'attachment' : null;
    case 'is': {
      const lower = value.toLowerCase();
      return (KNOWN_FLAGS as readonly string[]).includes(lower) ? lower : null;
    }
    case 'before':
    case 'after':
      return normaliseDate(value);
    case 'in': {
      const lower = value.toLowerCase();
      return (KNOWN_PLACES as readonly string[]).includes(lower) ? lower : value;
    }
    default:
      return value;
  }
}

/** Reads a quoted run starting at `at` (the opening quote). */
function readQuoted(text: string, at: number): { value: string; end: number } {
  let value = '';
  let i = at + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === '\\' && i + 1 < text.length) {
      value += text[i + 1];
      i += 2;
      continue;
    }
    if (char === '"') return { value, end: i + 1 };
    value += char;
    i += 1;
  }
  return { value, end: text.length };
}

function readBare(text: string, at: number): number {
  let i = at;
  while (i < text.length && !isSpace(text[i])) i += 1;
  return i;
}

/** Every term of the text, in order. */
export function scanSearch(text: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  let i = 0;
  while (i < text.length) {
    if (isSpace(text[i])) {
      i += 1;
      continue;
    }
    const start = i;
    const key = KEY.exec(text.slice(i, i + 9));
    if (key) {
      const operator = key[1].toLowerCase() as Operator;
      const valueAt = i + key[0].length;
      let raw: string;
      let end: number;
      if (text[valueAt] === '"') {
        const quoted = readQuoted(text, valueAt);
        raw = quoted.value;
        end = quoted.end;
        // A closing quote glued to more characters ("a"b) ends the value at the quote; the rest is its own term.
      } else {
        end = readBare(text, valueAt);
        raw = text.slice(valueAt, end);
      }
      const value = normaliseValue(operator, raw);
      if (value !== null) {
        terms.push({ kind: 'op', operator, value, start, end, complete: isSpace(text[end]) });
        i = end;
        continue;
      }
      // Not a value this operator takes: the whole term, as typed, is free text.
      const freeEnd = Math.max(end, readBare(text, start));
      terms.push({ kind: 'free', text: text.slice(start, freeEnd), start, end: freeEnd });
      i = freeEnd;
      continue;
    }
    let end = text[i] === '"' ? readQuoted(text, i).end : readBare(text, i);
    // An unclosed quote runs to the end of the text; its trailing spaces are not part of the phrase.
    while (end > start + 1 && isSpace(text[end - 1])) end -= 1;
    terms.push({ kind: 'free', text: text.slice(start, end), start, end });
    i = Math.max(end, i + 1);
  }
  return terms;
}

/** Adds a token, replacing an earlier one with the same operator (single-valued; `is:` accumulates). */
export function withToken(tokens: readonly SearchToken[], token: SearchToken): SearchToken[] {
  if (token.operator === 'is') return [...tokens, token];
  return [...tokens.filter(t => t.operator !== token.operator), token];
}

/** Parses text into tokens and free words. */
export function parseSearch(text: string): ParsedSearch {
  let tokens: SearchToken[] = [];
  const free: string[] = [];
  for (const term of scanSearch(text)) {
    if (term.kind === 'op')
      tokens = withToken(tokens, { operator: term.operator, value: term.value });
    else free.push(term.text);
  }
  return { tokens, free: free.join(' ') };
}

/** A value as text: bare when it reads back the same, else quoted with `\"` and `\\` escaped. */
export function formatValue(value: string): string {
  const bare = value !== '' && !/[\s"\\]/.test(value);
  return bare ? value : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function formatToken(token: SearchToken): string {
  return `${token.operator}:${formatValue(token.value)}`;
}

/** Tokens then free words, the text that parses back to the same tokens and words. */
export function formatSearch(tokens: readonly SearchToken[], free = ''): string {
  return [...tokens.map(formatToken), free.trim()].filter(Boolean).join(' ');
}

/** The contract's structured query for tokens plus free words (the engine never sees the operator text). */
export function toSearchQuery(tokens: readonly SearchToken[], free: string): SearchQuery {
  const query: { -readonly [K in keyof SearchQuery]: SearchQuery[K] } = {
    text: free.trim().replace(/\s+/g, ' '),
  };
  for (const token of tokens) {
    switch (token.operator) {
      case 'from':
        query.from = token.value;
        break;
      case 'to':
        query.to = token.value;
        break;
      case 'subject':
        query.subject = token.value;
        break;
      case 'has':
        query.hasAttachment = true;
        break;
      case 'is':
        query.is = [
          ...(query.is ?? []),
          token.value as 'unread' | 'read' | 'flagged' | 'bookmarked',
        ];
        break;
      case 'before':
        query.before = token.value;
        break;
      case 'after':
        query.after = token.value;
        break;
      case 'in':
        query.in = token.value;
        break;
    }
  }
  return query;
}

/** True when the query asks for nothing (no words, no operators). */
export function isEmptyQuery(query: SearchQuery): boolean {
  return Object.entries(query).every(([key, value]) =>
    key === 'text' ? value === '' : value === undefined,
  );
}

/**
 * The field's half of tokenising as you type: operator terms the owner has finished (followed by whitespace) leave
 * the field and become pills; everything else stays as typed. Returns the new field text and token list.
 */
export function absorbTokens(
  field: string,
  tokens: readonly SearchToken[],
): { field: string; tokens: SearchToken[] } {
  let next = [...tokens];
  let rest = '';
  let at = 0;
  let changed = false;
  for (const term of scanSearch(field)) {
    if (term.kind === 'op' && term.complete) {
      next = withToken(next, { operator: term.operator, value: term.value });
      rest += field.slice(at, term.start);
      // Drop the term and the one space that finished it.
      at = term.end + 1;
      changed = true;
    }
  }
  if (!changed) return { field, tokens: next };
  rest += field.slice(at);
  return { field: rest.replace(/^\s+/, ''), tokens: next };
}

/** The tokens and free words the page searches for right now: pills plus whatever is in the field, finished or not. */
export function currentSearch(
  field: string,
  tokens: readonly SearchToken[],
): { tokens: SearchToken[]; free: string } {
  const typed = parseSearch(field);
  let all = [...tokens];
  for (const token of typed.tokens) all = withToken(all, token);
  return { tokens: all, free: typed.free };
}
