/** The suggestions for what is typed in one recipient field, for the From account (DESIGN 7.6). */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../data';
import { SUGGEST_LIMIT, type SuggestEntry, type SuggestFn } from '../model/suggestions';
import { createSuggestLoop, type SuggestAsked } from './suggestLoop';

const NONE: readonly SuggestEntry[] = [];

/** `Contact/suggest` through the data layer: the engine's local correspondents table, never a provider call. */
export const contactSuggest: SuggestFn = async (query, accountId) =>
  (await api.contact.suggest({ query, accountId, limit: SUGGEST_LIMIT + 4 })).list;

export function useRecipientSuggest(
  query: string,
  accountId: string,
  suggest: SuggestFn,
): readonly SuggestEntry[] {
  const [answer, setAnswer] = useState<{
    readonly entries: readonly SuggestEntry[];
    readonly asked: SuggestAsked;
  } | null>(null);
  const loop = useRef<ReturnType<typeof createSuggestLoop> | null>(null);
  useEffect(() => {
    const made = createSuggestLoop({
      suggest,
      onResult: (entries, asked) => setAnswer({ entries, asked }),
    });
    loop.current = made;
    return () => made.dispose();
  }, [suggest]);
  useEffect(() => loop.current?.update(query, accountId), [query, accountId, suggest]);
  // An answer counts only for the text and account it was asked for: while the next one is on its way, nothing shows
  // (a stale list under new text could be picked by a quick Return).
  const fresh = answer?.asked.query === query.trim() && answer.asked.accountId === accountId;
  return fresh ? answer.entries : NONE;
}
