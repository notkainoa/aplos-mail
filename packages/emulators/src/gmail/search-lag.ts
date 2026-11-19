/**
 * Gmail's search index lags a send (live 2026-11-05: the sent copy showed on the 4th search, a few seconds later). A
 * message `messages.send` just made is hidden from list results (by `q` or by label) for `lagMs()` of the emulator's
 * clock; `messages.get` sees it at once. Zero lag (the default) hides nothing.
 */
export class SearchLag {
  private readonly sentAt = new Map<string, number>();

  constructor(private readonly lagMs: () => number) {}

  /** `id` was created by a send at `now`. */
  sent(id: string, now: number): void {
    this.sentAt.set(id, now);
  }

  /** Whether the index shows `id` at `now`. */
  shows(id: string, now: number): boolean {
    const at = this.sentAt.get(id);
    return at === undefined || now - at >= this.lagMs();
  }
}
