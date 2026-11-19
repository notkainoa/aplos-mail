// A small least-recently-used cache: the 12 rendered bodies that serve prefetch (plan 10 E4
// item 2). A sanitized body does not depend on its token, so the cache holds the sanitizer's
// result and every render still gets a fresh token. `get` refreshes recency; adding past capacity
// drops the least recently used entry.

export const RENDER_CACHE_SIZE = 12;

export class Lru<V> {
  private readonly entries = new Map<string, V>();

  constructor(readonly capacity: number = RENDER_CACHE_SIZE) {}

  get(key: string): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface RenderKeyParts {
  messageId: string;
  imagePolicy: 'block' | 'allow';
  findQuery?: string;
  quotesOpen?: boolean;
  /** `MailHtml.version`: a sanitizer fix misses every older entry. */
  version: string;
  /** Which stored copy of the message was rendered: a message deleted and stored again misses. */
  body?: string;
}

/** One unambiguous string per combination (JSON, so no separator can be forged by a part). */
export function renderKey(parts: RenderKeyParts): string {
  return JSON.stringify([
    parts.version,
    parts.messageId,
    parts.imagePolicy,
    parts.findQuery ?? null,
    parts.quotesOpen ?? false,
    parts.body ?? null,
  ]);
}
