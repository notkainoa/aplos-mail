// The two classes the module needs at start, by their own paths: the `frame` barrel would drag the reporter and the
// response builder (about 8 KB) into the core, and only the lazy `Mail/*` modules use them.
import { FrameTokens } from '@aplos/mail-html/frame/tokens';
import { Lru } from '@aplos/mail-html/frame/lru';
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
  /** In-flight `Message/original` fetches, keyed `[principal, messageId]`: joined callers share one fetch. */
  readonly originals: Map<string, Promise<{ blobId: string; name: string; size: number }>>;
  /** A live `Message/original` result per `[principal, messageId]`: a repeat opens the same blob. */
  readonly originalBlobs: Map<string, { blobId: string; name: string; size: number }>;
}

export function createMailFrames(): MailFrames {
  return {
    tokens: new FrameTokens(),
    cache: new Lru<CachedRender>(),
    cancelled: new Set(),
    parts: new Map(),
    fetching: new Map(),
    aborter: new AbortController(),
    originals: new Map(),
    originalBlobs: new Map(),
  };
}
