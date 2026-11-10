// The host side of the reporter protocol (PROTOCOL.md). The reporter is the engine's `packages/mail-html/assets/
// reporter.js` (ARCHITECTURE 10): it posts `{token, h, w, bg, ready, marks, plain}` to `parent` and nothing else. Pure: every
// check takes the event and what the host expects, so spoofed messages are unit-tested without a browser.

import { FRAME_PAPER } from './paper';

/** Heights are clamped into 1-200,000 for display. */
export const MAX_HEIGHT = 200_000;
/** The reporter clamps `h` to 0-1,000,000: a height outside that range is not the reporter's and is rejected. */
export const REPORTED_MAX_HEIGHT = 1_000_000;
/** The reporter clamps `marks` to 0-100,000. */
const MAX_MARKS = 100_000;
/** A reported width may differ from the slot by this many px (subpixel rounding). */
const WIDTH_SLACK = 1;
/** The pixels of a CSS length such as "16px"; 0 for anything else. */
function pixels(length: string): number {
  const value = Number.parseFloat(length);
  return Number.isFinite(value) ? value : 0;
}

/**
 * The width the frame's document lays out at, which is what the reporter measures: the iframe's client box less its
 * horizontal padding. A screen may pad the frame (`--sheet-inset`, the light sheet on a dark pane), and `clientWidth`
 * includes that padding, so comparing a genuine report with it would be off by twice the inset and be rejected.
 */
export function frameContentWidth(
  frame: { readonly clientWidth: number },
  style: { readonly paddingLeft: string; readonly paddingRight: string },
): number {
  return Math.max(0, frame.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight));
}

/** What the host expects of one frame instance. */
export interface ReportExpectation {
  /** The frame's `contentWindow`; null until mounted (then nothing is accepted). */
  source: unknown;
  /** Accepted origins; an opaque sandboxed frame reports `'null'`. */
  origins: readonly string[];
  /** The per-render token (the `aplos-mail://m/<token>/` path segment). */
  token: string;
  /**
   * The slot width in CSS px; a size report of another width is ignored. A function is called only once every other
   * check has passed, so a forged or foreign message costs the host no layout read.
   */
  width?: number | (() => number | undefined);
}

/** A size report the host accepted. */
export interface SizeReport {
  /** Clamped into 1-200,000. */
  height: number;
  /** Strict `#rrggbb`; the light paper when the reported colour is transparent or unparsable. */
  bg: string;
  /** The frame document had finished loading (`readyState === 'complete'`) when it measured. */
  ready: boolean;
  /** Find marks in the letter (the sanitiser's `mark.aplos-find`), 0-100,000. */
  marks: number;
  /** The letter's root carries the sanitiser's `data-aplos-plain` (a mail cannot set it); false when the reporter says nothing. */
  plain: boolean;
}

/** The minimal shape of a `MessageEvent` the host reads. */
export interface ReportEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

/** The light paper token, used whenever a background colour cannot be read strictly. */
export const LIGHT_PAPER = FRAME_PAPER.paper;

const RGB =
  /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function channel(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}

function opaque(alpha: string | undefined): boolean {
  if (alpha === undefined) return true;
  const n = alpha.endsWith('%') ? Number(alpha.slice(0, -1)) / 100 : Number(alpha);
  return Number.isFinite(n) && n >= 1;
}

/** The one output form: `#rrggbb`, lowercase. */
function toHex(channels: readonly number[]): string {
  return '#' + channels.map(c => c.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): string {
  const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex;
  return '#' + full.toLowerCase();
}

/**
 * Parse a background colour strictly into `#rrggbb`: `rgb()`/`rgba()` with integer channels or `#rgb`/`#rrggbb`. Anything else, or a
 * colour that is not fully opaque (the paper would show through), falls back to the light paper.
 */
export function parseBg(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) return fallbackBg();
  const v = value.trim();
  const hex = HEX.exec(v);
  if (hex) return fromHex(hex[1]!);
  const m = RGB.exec(v);
  if (!m || !opaque(m[4])) return fallbackBg();
  const [r, g, b] = [m[1], m[2], m[3]].map(channel);
  return r === null || g === null || b === null ? fallbackBg() : toHex([r, g, b]);
}

function fallbackBg(): string {
  return fromHex(LIGHT_PAPER.slice(1));
}

/** A finite, non-negative height rounded up and clamped into 1-200,000; anything else is null. */
export function clampHeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(MAX_HEIGHT, Math.max(1, Math.ceil(value)));
}

/** The reporter's one message: exactly these own fields, every one present. Anything else rejects the message. */
const FIELDS: ReadonlySet<string> = new Set(['token', 'h', 'w', 'bg', 'ready', 'marks', 'plain']);
/** The six every report has; `plain` is the seventh the current reporter adds (an older reporter's six are still accepted). */
const REQUIRED_FIELDS = 6;

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A plain object's own data fields copied into a null-prototype record, so nothing is read through a prototype (a
 * polluted `Object.prototype` cannot fill a missing field) and no getter runs. Null for anything else, for symbol
 * keys, and unless the own fields are the reporter's six, or its seven with `plain`.
 */
function ownFields(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) return null;
  const names = Object.getOwnPropertyNames(value);
  if (
    (names.length !== REQUIRED_FIELDS && names.length !== FIELDS.size) ||
    names.some(name => !FIELDS.has(name))
  )
    return null;
  const fields = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor)) return null;
    fields[name] = descriptor.value;
  }
  return fields;
}

/** The height to show, or null when it is not one the reporter could have sent (NaN, negative, over 1,000,000). */
function reportedHeight(h: unknown): number | null {
  if (typeof h !== 'number' || h > REPORTED_MAX_HEIGHT) return null;
  return clampHeight(h);
}

/** Research section 3: an out-of-process child can report before it knows its width (0 or ~43,000 px). */
function widthMatches(w: unknown, width: number | undefined): boolean {
  if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return false;
  return width === undefined || Math.abs(w - width) <= WIDTH_SLACK;
}

function isMarks(marks: unknown): marks is number {
  return typeof marks === 'number' && Number.isInteger(marks) && marks >= 0 && marks <= MAX_MARKS;
}

function sizeReport(
  data: Record<string, unknown>,
  width: ReportExpectation['width'],
): SizeReport | null {
  const height = reportedHeight(data.h);
  if (height === null) return null;
  if (typeof data.bg !== 'string' || typeof data.ready !== 'boolean' || !isMarks(data.marks)) {
    return null;
  }
  if (data.plain !== undefined && typeof data.plain !== 'boolean') return null;
  if (!widthMatches(data.w, typeof width === 'function' ? width() : width)) return null;
  return {
    height,
    bg: parseBg(data.bg),
    ready: data.ready,
    marks: data.marks,
    plain: data.plain === true,
  };
}

/**
 * Accept a `message` event only from this frame instance: the source is its `contentWindow`, the origin is expected,
 * the token matches, and the payload is a plain object with exactly the reporter's fields (its six, or its seven with `plain`), well formed. Returns
 * null for anything else.
 */
export function acceptReport(event: ReportEvent, expect: ReportExpectation): SizeReport | null {
  if (expect.source === null || expect.source === undefined || event.source !== expect.source) {
    return null;
  }
  if (!expect.origins.includes(event.origin)) return null;
  const data = ownFields(event.data);
  if (!data || typeof data.token !== 'string' || !expect.token) return null;
  if (data.token !== expect.token) return null;
  return sizeReport(data, expect.width);
}

/** The engine's document URL: 128 random bits as 32 lowercase hex digits (`@aplos/mail-html/frame` paths.ts). */
const FRAME_URL = /^aplos-mail:\/\/m\/([0-9a-f]{32})\/?$/;

/**
 * The token of a `Mail/frame` document URL, `aplos-mail://m/<token>/` (or the contract comment's form without the
 * slash), or '' for anything else: another scheme or host, a sub-resource path, a query or fragment, another token
 * shape. The reporter reads the same path segment from its own `location.pathname`; nothing is sent to the frame.
 */
export function tokenOf(url: string): string {
  const m = FRAME_URL.exec(url);
  return m ? m[1]! : '';
}
