/**
 * The type-ahead's asking, apart from React: wait for the typing to pause, ask once, and drop an answer that arrives
 * after a newer question (a slow answer for "jo" must never replace the one for "jord"). A failed ask shows nothing:
 * suggestions are a convenience and their absence is quiet (DESIGN 9).
 */
import { SUGGEST_DEBOUNCE_MS, type SuggestEntry, type SuggestFn } from '../model/suggestions';

export interface SuggestLoopOptions {
  readonly suggest: SuggestFn;
  readonly onResult: (entries: readonly SuggestEntry[]) => void;
  /** Runs `fn` after `ms`; returns a cancel. Defaults to a timer. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

export function createSuggestLoop({ suggest, onResult, schedule }: SuggestLoopOptions) {
  const later =
    schedule ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  let seq = 0;
  let cancel: (() => void) | null = null;
  return {
    /** The typed text or the From account changed. */
    update(query: string, accountId: string) {
      cancel?.();
      cancel = null;
      const mine = ++seq;
      if (query.trim() === '') return onResult([]);
      cancel = later(() => {
        cancel = null;
        suggest(query.trim(), accountId).then(
          entries => mine === seq && onResult(entries),
          () => mine === seq && onResult([]),
        );
      }, SUGGEST_DEBOUNCE_MS);
    },
    /** The field is gone: nothing late may land. */
    dispose() {
      cancel?.();
      cancel = null;
      seq += 1;
    },
  };
}
