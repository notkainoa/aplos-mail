import { FrameTokens, Lru } from '@aplos/mail-html/frame';
import type { MailHtmlResult } from '../ports';

/** One sanitized render as the cache keeps it: the result without a reporter, and the cids it numbered. */
export interface CachedRender {
  result: MailHtmlResult;
  cids: readonly string[];
}

/**
 * The engine's frame state (html-4): the token registry and the LRU of 12 sanitized renders. One per engine, built by
 * the `eng-html` module; nothing outside `mail/` reaches into it.
 */
export interface MailFrames {
  readonly tokens: FrameTokens;
  readonly cache: Lru<CachedRender>;
  /** Thread keys whose prefetch was cancelled before its render could warm the cache. */
  readonly cancelled: Set<string>;
  /**
   * Attachment fetches in flight (`Attachment/get`), keyed `<accountId>:<remoteId>:<remotePart>`: concurrent
   * requests for one part share the single provider fetch; each caller registers its own blob handle after.
   */
  readonly parts: Map<string, Promise<{ path: string; size: number }>>;
  /** In-flight fetch count per account scope (`Attachment/get` allows at most 3). */
  readonly fetching: Map<string, number>;
  /** The lane's fetch signal: `stop()` aborts it, so an engine close takes every in-flight fetch down. */
  readonly aborter: AbortController;
}

export function createMailFrames(): MailFrames {
  return {
    tokens: new FrameTokens(),
    cache: new Lru<CachedRender>(),
    cancelled: new Set(),
    parts: new Map(),
    fetching: new Map(),
    aborter: new AbortController(),
  };
}
