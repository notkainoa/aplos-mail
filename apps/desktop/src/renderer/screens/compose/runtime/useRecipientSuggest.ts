/** The suggestions for what is typed in one recipient field, for the From account (DESIGN 7.6). */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../data';
import {
  freshEntries,
  SUGGEST_LIMIT,
  type SuggestAsked,
  type SuggestEntry,
  type SuggestFn,
  withOtherAccounts,
} from '../model/suggestions';
import { createSuggestLoop } from './suggestLoop';

/**
 * `Contact/suggest` through the data layer: the engine's local correspondents table, never a provider call. The From
 * account's people come first; the owner's other accounts fill the rest, so a name found on one account is found
 * whichever account the new message starts from.
 */
export const contactSuggest: SuggestFn = async (query, accountId) => {
  const limit = SUGGEST_LIMIT + 4;
  const [own, all] = await Promise.all([
    api.contact.suggest({ query, accountId, limit }),
    api.contact.suggest({ query, limit }),
  ]);
  return withOtherAccounts(own.list, all.list).slice(0, limit);
};

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
  return freshEntries(answer, query, accountId);
}
