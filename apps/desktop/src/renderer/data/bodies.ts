/**
 * Message bodies (DESIGN 5 rules 9-10): one `MessageBody/get` per message, shared by every reader of it, served from
 * the engine's LRU after a prefetch. `slow` turns on after 1.5 s so the reader can show its quiet loading line while
 * the previous letter stays on screen.
 */
import type { ErrorBody, MessageId } from './contract-shapes';
import { toErrorBody, type DataClient } from './client';
import { BODY_TOPIC, type Emitter } from './emitter';
import type { BodyResult } from './index';
import type { Timers } from './scheduler';

/** When the reader's loading line appears (DESIGN 5 rule 10). */
export const BODY_SLOW_MS = 1_500;
/** Bodies kept after their last reader leaves. */
const KEEP = 24;
/** A paused letter is asked again this long after the pause's `resumeAt`, so the account's pause has surely lifted. */
const RESUME_SLACK_MS = 1_000;

const IDLE: BodyResult = {
  status: 'idle',
  slow: false,
  body: undefined,
  error: null,
  retry: () => {},
};

interface BodyEntry {
  result: BodyResult;
  refs: number;
  cancelSlow: (() => void) | null;
  /** The ask again at a pause's end (`paused` with `resumeAt`), while the letter is open. */
  cancelWake?: (() => void) | null;
}

export class BodyStore {
  private readonly entries = new Map<MessageId, BodyEntry>();

  constructor(
    private readonly client: DataClient,
    private readonly emitter: Emitter,
    private readonly timers: Timers,
  ) {}

  get(messageId: MessageId | undefined): BodyResult {
    if (!messageId) return IDLE;
    return this.entries.get(messageId)?.result ?? this.load(messageId).result;
  }

  retain(messageId: MessageId | undefined): () => void {
    if (!messageId) return () => {};
    const entry = this.entries.get(messageId) ?? this.load(messageId);
    // A letter that failed is asked again when it is opened again (fix-bodies R2): a Gmail pause, an engine restart or
    // a network blip must not show "Couldn't load this email." on every reopen until Try again.
    if (entry.refs === 0 && entry.result.status === 'failed') this.fetch(messageId, entry);
    entry.refs++;
    return () => {
      entry.refs--;
      this.trim();
    };
  }

  private load(messageId: MessageId): BodyEntry {
    const retry = () => {
      const entry = this.entries.get(messageId);
      if (entry && entry.result.status !== 'failed') return;
      this.fetch(messageId, entry);
    };
    const entry: BodyEntry = {
      result: { status: 'loading', slow: false, body: undefined, error: null, retry },
      refs: 0,
      cancelSlow: null,
    };
    this.entries.set(messageId, entry);
    this.fetch(messageId, entry);
    return entry;
  }

  private fetch(messageId: MessageId, existing: BodyEntry | undefined): void {
    const entry = existing ?? this.entries.get(messageId);
    if (!entry) return;
    const retry = entry.result.retry;
    if (entry.result.status !== 'loading') {
      entry.result = { status: 'loading', slow: false, body: undefined, error: null, retry };
      this.emitter.emit(BODY_TOPIC);
    }
    entry.cancelSlow?.();
    entry.cancelWake?.();
    entry.cancelWake = null;
    entry.cancelSlow = this.timers.setTimeout(() => {
      if (entry.result.status !== 'loading') return;
      entry.result = { ...entry.result, slow: true };
      this.emitter.emit(BODY_TOPIC);
    }, BODY_SLOW_MS);
    this.client.call('MessageBody/get', { messageId }).then(
      body => {
        entry.cancelSlow?.();
        entry.result = { status: 'ready', slow: false, body, error: null, retry };
        this.emitter.emit(BODY_TOPIC);
      },
      error => {
        entry.cancelSlow?.();
        const body = toErrorBody(error);
        entry.result = { status: 'failed', slow: false, body: undefined, error: body, retry };
        this.emitter.emit(BODY_TOPIC);
        this.wakeAfterPause(messageId, entry, body);
      },
    );
  }

  /**
   * A body refused because the account is paused (a Gmail slow-down from background sync, fix-bodies R1) is asked again
   * once the pause ends, if the letter is still open; otherwise the next open asks (`retain`).
   */
  private wakeAfterPause(messageId: MessageId, entry: BodyEntry, error: ErrorBody): void {
    if (error.type !== 'paused' || typeof error.resumeAt !== 'number') return;
    const wait = Math.max(0, error.resumeAt - this.timers.now()) + RESUME_SLACK_MS;
    entry.cancelWake = this.timers.setTimeout(() => {
      entry.cancelWake = null;
      const open = entry.refs > 0 && this.entries.get(messageId) === entry;
      if (open && entry.result.status === 'failed') this.fetch(messageId, entry);
    }, wait);
  }

  private trim(): void {
    const unused = [...this.entries].filter(([, e]) => e.refs <= 0);
    for (const [id] of unused.slice(0, Math.max(0, unused.length - KEEP))) this.entries.delete(id);
  }
}
