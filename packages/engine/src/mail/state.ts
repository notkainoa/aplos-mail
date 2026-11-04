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
}

export function createMailFrames(): MailFrames {
  return { tokens: new FrameTokens(), cache: new Lru<CachedRender>(), cancelled: new Set() };
}
