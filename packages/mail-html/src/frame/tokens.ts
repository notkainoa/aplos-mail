import { frameUrl, isToken, tokenOf } from './paths';

// The frame token registry (ARCH 10, plan 10 E4 item 3). Pure: no DOM, no Node, no clock of its
// own (every time-sensitive call takes `now`). Rules:
// - A token is 128 random bits from Web Crypto, 32 lowercase hex, never reused while live.
// - Tokens belong to one window: every lookup names the window, and another window's token is
//   refused exactly like an unknown one.
// - Single render: the document is handed out once per token (`takeDocument`); a second request
//   is refused. Sub-resources (`cid/<n>`, `img/<n>`) are served only after the document, only for
//   indexes this render issued, and only while the token lives; `img/<n>` never while blocked.
// - At most 64 live tokens per window: issuing the 65th evicts that window's oldest token.
// - A token dies on release, on replacement (a newer render for the same slot), on eviction, on
//   its window closing and at `expiresAt`. A dead token is deleted, never kept as a tombstone.
// Every refusal is the same `undefined`, whatever the reason.

export const TOKEN_TTL_MS = 10 * 60 * 1000;
export const MAX_TOKENS_PER_WINDOW = 64;

export type FrameImagePolicy = 'block' | 'allow';

/** What the caller renders into a token. */
export interface FrameRenderInput {
  /** Opaque, supplied by the caller (main's window identity, carried by the engine). */
  windowId: string;
  /** A newer render for the same window and slot (the reader pane, say) frees the older token. */
  slot?: string;
  messageId: string;
  accountScope: string;
  imagePolicy: FrameImagePolicy;
  findQuery?: string;
  quotesOpen?: boolean;
  /** The sanitized frame document, reporter included. */
  document: string;
  /** Remote image URLs by index n (`img/<n>`), from `MailHtmlResult.remoteImages`. */
  remoteImages: readonly string[];
  /** Inline parts' references by index n (`cid/<n>`), as given to the sanitizer. */
  cids: readonly string[];
}

/** The render as kept while the token lives; the document is held apart and dropped once served. */
export interface FrameRecord extends Readonly<Omit<FrameRenderInput, 'document'>> {
  readonly token: string;
  readonly bodyKind: 'html';
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface IssuedFrame {
  token: string;
  url: string;
  expiresAt: number;
}

export interface FrameTokensOptions {
  ttlMs?: number;
  maxPerWindow?: number;
  /** Fills `bytes` with random values; Web Crypto unless a test injects one. */
  random?: (bytes: Uint8Array) => void;
}

interface Entry {
  record: FrameRecord;
  documentServed: boolean;
  /** Until the one document request; single render never needs it again. */
  document: string | undefined;
}

/** A window id is a non-empty string: a relay defaulting to '' must not merge windows. */
export function isWindowId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export class FrameTokens {
  private readonly byToken = new Map<string, Entry>();
  /** Per window, in issue order, so the first key is the oldest. */
  private readonly byWindow = new Map<string, Map<string, Entry>>();
  private readonly ttlMs: number;
  private readonly maxPerWindow: number;
  private readonly random: (bytes: Uint8Array) => void;

  constructor(options: FrameTokensOptions = {}) {
    this.ttlMs = options.ttlMs ?? TOKEN_TTL_MS;
    this.maxPerWindow = options.maxPerWindow ?? MAX_TOKENS_PER_WINDOW;
    this.random = options.random ?? webRandom;
  }

  issue(input: FrameRenderInput, now: number): IssuedFrame {
    if (!isWindowId(input.windowId)) throw new Error('frame tokens: no window id');
    this.sweepWindow(input.windowId, now);
    if (input.slot !== undefined) this.releaseSlot(input.windowId, input.slot);
    this.evictOverCap(input.windowId);
    const token = this.freshToken();
    const record = freeze(input, token, now, now + this.ttlMs);
    this.add({ record, documentServed: false, document: input.document });
    return { token, url: frameUrl(token), expiresAt: record.expiresAt };
  }

  /** Frees `old` (when it is this window's) and issues the newer render. */
  replace(old: string, input: FrameRenderInput, now: number): IssuedFrame {
    this.release(input.windowId, old);
    return this.issue(input, now);
  }

  /** The live record for this window's token, or undefined. */
  lookup(windowId: string, token: unknown, now: number): FrameRecord | undefined {
    return this.liveEntry(windowId, token, now)?.record;
  }

  /** The document, the first time only; the registry forgets it as it hands it out. */
  takeDocument(windowId: string, token: unknown, now: number): string | undefined {
    const entry = this.liveEntry(windowId, token, now);
    if (!entry || entry.documentServed) return undefined;
    const document = entry.document;
    entry.documentServed = true;
    entry.document = undefined;
    return document;
  }

  /** Whether the registry still holds this token's document (until it is served). */
  holdsDocument(windowId: string, token: unknown, now: number): boolean {
    return this.liveEntry(windowId, token, now)?.document !== undefined;
  }

  /** The record for a sub-resource request: only after the document was served. */
  forResource(windowId: string, token: unknown, now: number): FrameRecord | undefined {
    const entry = this.liveEntry(windowId, token, now);
    return entry?.documentServed ? entry.record : undefined;
  }

  /** Frees a token (document URL or bare token) of this window. True when one was freed. */
  release(windowId: string, urlOrToken: unknown): boolean {
    const token = tokenOf(urlOrToken);
    const entry = token === undefined ? undefined : this.byToken.get(token);
    if (!entry || entry.record.windowId !== windowId) return false;
    this.remove(entry.record);
    return true;
  }

  /** Frees every token of a closed window. */
  releaseWindow(windowId: string): void {
    for (const entry of [...(this.byWindow.get(windowId)?.values() ?? [])]) {
      this.remove(entry.record);
    }
  }

  /** Deletes every expired token. */
  sweep(now: number): void {
    for (const windowId of [...this.byWindow.keys()]) this.sweepWindow(windowId, now);
  }

  liveCount(windowId: string): number {
    return this.byWindow.get(windowId)?.size ?? 0;
  }

  private liveEntry(windowId: string, token: unknown, now: number): Entry | undefined {
    if (!isToken(token)) return undefined;
    const entry = this.byToken.get(token);
    if (!entry || entry.record.windowId !== windowId) return undefined;
    if (now >= entry.record.expiresAt) {
      this.remove(entry.record);
      return undefined;
    }
    return entry;
  }

  private sweepWindow(windowId: string, now: number): void {
    for (const entry of [...(this.byWindow.get(windowId)?.values() ?? [])]) {
      if (now >= entry.record.expiresAt) this.remove(entry.record);
    }
  }

  private releaseSlot(windowId: string, slot: string): void {
    for (const entry of [...(this.byWindow.get(windowId)?.values() ?? [])]) {
      if (entry.record.slot === slot) this.remove(entry.record);
    }
  }

  private evictOverCap(windowId: string): void {
    const tokens = this.byWindow.get(windowId);
    while (tokens && tokens.size >= this.maxPerWindow) {
      const oldest = tokens.values().next().value;
      if (!oldest) return;
      this.remove(oldest.record);
    }
  }

  /** A live token is never handed out twice; a source that keeps repeating itself is broken. */
  private freshToken(): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const bytes = new Uint8Array(16);
      this.random(bytes);
      const token = toHex(bytes);
      if (!this.byToken.has(token)) return token;
    }
    throw new Error('frame tokens: the random source repeats itself');
  }

  private add(entry: Entry): void {
    const { token, windowId } = entry.record;
    this.byToken.set(token, entry);
    const tokens = this.byWindow.get(windowId) ?? new Map<string, Entry>();
    tokens.set(token, entry);
    this.byWindow.set(windowId, tokens);
  }

  private remove(record: FrameRecord): void {
    this.byToken.delete(record.token);
    const tokens = this.byWindow.get(record.windowId);
    tokens?.delete(record.token);
    if (tokens?.size === 0) this.byWindow.delete(record.windowId);
  }
}

function freeze(
  input: FrameRenderInput,
  token: string,
  createdAt: number,
  expiresAt: number,
): FrameRecord {
  const { document: _document, ...kept } = input;
  return Object.freeze({
    ...kept,
    remoteImages: Object.freeze([...input.remoteImages]),
    cids: Object.freeze([...input.cids]),
    token,
    bodyKind: 'html' as const,
    createdAt,
    expiresAt,
  });
}

function webRandom(bytes: Uint8Array): void {
  crypto.getRandomValues(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
