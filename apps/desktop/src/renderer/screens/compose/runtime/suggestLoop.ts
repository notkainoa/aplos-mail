/**
 * The type-ahead's asking, apart from React: wait for the typing to pause, ask once, and drop an answer that arrives
 * after a newer question (a slow answer for "jo" must never replace the one for "jord"). A failed ask shows nothing:
 * suggestions are a convenience and their absence is quiet (DESIGN 9).
 */
import {
  SUGGEST_DEBOUNCE_MS,
  type SuggestAsked,
  type SuggestEntry,
  type SuggestFn,
} from '../model/suggestions';

export interface SuggestLoopOptions {
  readonly suggest: SuggestFn;
  /** The answer and the question it answers, so a caller never shows it under other text or another account. */
  readonly onResult: (entries: readonly SuggestEntry[], asked: SuggestAsked) => void;
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
      const asked = { query: query.trim(), accountId };
      if (asked.query === '') return onResult([], asked);
      cancel = later(() => {
        cancel = null;
        suggest(asked.query, accountId).then(
          entries => mine === seq && onResult(entries, asked),
          () => mine === seq && onResult([], asked),
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
