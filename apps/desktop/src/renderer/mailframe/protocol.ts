// The host side of the reporter protocol (PROTOCOL.md, draft). Pure: every check takes the event and what the host
// expects, so spoofed messages are unit-tested without a browser.

import { FRAME_PAPER } from './paper';
import type { MailFrameKey } from './types';

/** Heights outside 0-200,000 are rejected; 0 is clamped up to 1. */
export const MAX_HEIGHT = 200_000;
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

/**
 * The only keys either frame relays to the shell: the sealed reporter's fallback `key` messages and the srcdoc frame's
 * keydown relay (keys.ts). Non-destructive and never a hold key (research section 7: never E, Space or R).
 */
export const FALLBACK_KEYS = new Set([
  'j',
  'k',
  'J',
  'K',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Escape',
]);

/** What the host expects of one frame instance. */
export interface ReportExpectation {
  /** The frame's `contentWindow`; null until mounted (then nothing is accepted). */
  source: unknown;
  /** Accepted origins; an opaque sandboxed frame reports `'null'`. */
  origins: readonly string[];
  /** The per-render token (the `aplos-mail://m/<token>` path segment). */
  token: string;
  /** The slot width in CSS px; a size report of another width is ignored. */
  width?: number;
}

/** A size report the host accepted. */
export interface SizeReport {
  type: 'size';
  height: number;
  bg: string;
  ready: boolean;
}

/** A key the in-frame fallback relay reported. */
export interface KeyReport extends MailFrameKey {
  type: 'key';
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

/** A finite height in 0-200,000, rounded up and clamped to at least 1; anything else is null (rejected). */
export function clampHeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > MAX_HEIGHT) return null;
  return Math.min(MAX_HEIGHT, Math.max(1, Math.ceil(value)));
}

/** The fields each message type may carry; any other own key (`__proto__`, `constructor`, …) rejects the message. */
const FIELDS = new Map<string, ReadonlySet<string>>([
  ['size', new Set(['t', 'token', 'h', 'w', 'bg', 'ready'])],
  ['key', new Set(['t', 'token', 'key', 'shift', 'alt'])],
]);
const MAX_FIELDS = 6;

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A plain object's own data fields copied into a null-prototype record, so nothing is read through a prototype (a
 * polluted `Object.prototype` cannot fill a missing field) and no getter runs. Null for anything else, for symbol
 * keys, and for a field the message type does not define.
 */
function ownFields(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) return null;
  const names = Object.getOwnPropertyNames(value);
  if (names.length > MAX_FIELDS) return null;
  const fields = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor)) return null;
    fields[name] = descriptor.value;
  }
  const allowed = typeof fields.t === 'string' ? FIELDS.get(fields.t) : undefined;
  if (!allowed || names.some(name => !allowed.has(name))) return null;
  return fields;
}

function sizeReport(data: Record<string, unknown>, width: number | undefined): SizeReport | null {
  const height = clampHeight(data.h);
  if (height === null) return null;
  // Research section 3: an out-of-process child can report before it knows its width (0 or ~43,000 px tall).
  if (width !== undefined) {
    if (typeof data.w !== 'number' || !Number.isFinite(data.w) || data.w <= 0) return null;
    if (Math.abs(data.w - width) > WIDTH_SLACK) return null;
  }
  return { type: 'size', height, bg: parseBg(data.bg), ready: data.ready === true };
}

function keyReport(data: Record<string, unknown>): KeyReport | null {
  if (typeof data.key !== 'string' || !FALLBACK_KEYS.has(data.key)) return null;
  return { type: 'key', key: data.key, shift: data.shift === true, alt: data.alt === true };
}

/**
 * Accept a `message` event only from this frame instance: the source is its `contentWindow`, the origin is expected,
 * the token matches, and the payload is a plain object with exactly its type's fields, well formed. Returns null for
 * anything else.
 */
export function acceptReport(
  event: ReportEvent,
  expect: ReportExpectation,
): SizeReport | KeyReport | null {
  if (expect.source === null || expect.source === undefined || event.source !== expect.source) {
    return null;
  }
  if (!expect.origins.includes(event.origin)) return null;
  const data = ownFields(event.data);
  if (!data || typeof data.token !== 'string' || !expect.token) return null;
  if (data.token !== expect.token) return null;
  if (data.t === 'size') return sizeReport(data, expect.width);
  if (data.t === 'key') return keyReport(data);
  return null;
}

/** The token of an `aplos-mail://m/<token>[/…]` URL, or '' when the URL is not one. */
export function tokenOf(url: string): string {
  const m = /^aplos-mail:\/\/m\/([A-Za-z0-9_-]{8,128})(?:[/?#]|$)/.exec(url);
  return m ? m[1]! : '';
}
