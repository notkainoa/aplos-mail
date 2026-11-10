/** The suggestions for what is typed in one recipient field, for the From account (DESIGN 7.6). */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../data';
import { SUGGEST_LIMIT, type SuggestEntry, type SuggestFn } from '../model/suggestions';
import { createSuggestLoop } from './suggestLoop';

/** `Contact/suggest` through the data layer: the engine's local correspondents table, never a provider call. */
export const contactSuggest: SuggestFn = async (query, accountId) =>
  (await api.contact.suggest({ query, accountId, limit: SUGGEST_LIMIT + 4 })).list;

export function useRecipientSuggest(
  query: string,
  accountId: string,
  suggest: SuggestFn,
): readonly SuggestEntry[] {
  const [entries, setEntries] = useState<readonly SuggestEntry[]>([]);
  const loop = useRef<ReturnType<typeof createSuggestLoop> | null>(null);
  useEffect(() => {
    const made = createSuggestLoop({ suggest, onResult: setEntries });
    loop.current = made;
    return () => made.dispose();
  }, [suggest]);
  useEffect(() => loop.current?.update(query, accountId), [query, accountId, suggest]);
  return entries;
}
