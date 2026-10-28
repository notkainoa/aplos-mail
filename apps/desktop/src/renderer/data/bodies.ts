/**
 * Message bodies (DESIGN 5 rules 9-10): one `MessageBody/get` per message, shared by every reader of it, served from
 * the engine's LRU after a prefetch. `slow` turns on after 1.5 s so the reader can show its quiet loading line while
 * the previous letter stays on screen.
 */
import type { MessageId } from './contract-shapes';
import { toErrorBody, type DataClient } from './client';
import { BODY_TOPIC, type Emitter } from './emitter';
import type { BodyResult } from './index';
import type { Timers } from './scheduler';

/** When the reader's loading line appears (DESIGN 5 rule 10). */
export const BODY_SLOW_MS = 1_500;
/** Bodies kept after their last reader leaves. */
const KEEP = 24;

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
        entry.result = {
          status: 'failed',
          slow: false,
          body: undefined,
          error: toErrorBody(error),
          retry,
        };
        this.emitter.emit(BODY_TOPIC);
      },
    );
  }

  private trim(): void {
    const unused = [...this.entries].filter(([, e]) => e.refs <= 0);
    for (const [id] of unused.slice(0, Math.max(0, unused.length - KEEP))) this.entries.delete(id);
  }
}
