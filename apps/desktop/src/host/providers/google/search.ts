import {
  ProviderError,
  type AdapterContext,
  type SearchResult,
  type ServerSearch,
} from '@aplos/engine/ports';
import { GmailClient, type GmailDeps } from './client';
import { fetchMetadata } from './sync';

/**
 * Server search, run only when the user presses Enter (D2): the local index answers while typing and this module has
 * no other entry point. One `messages.list?q=` page (5 units, at most 25 hits), then metadata for the newest hit of
 * each thread in one batch on the interactive lane. Bodies stay lazy; the store keeps the rows with `origin='search'`.
 * Drafts are never results (D9): the query leaves them out, so a thread's newest hit is a real message, and a draft
 * that slips through anyway is not returned (`fetchMetadata` keeps drafts out of `facts`).
 */

/** Hits of a first search (about 210 units). A call that asks for a next page may take up to `SEARCH_MORE`. */
export const SEARCH_PAGE = 10;
export const SEARCH_MORE = 25;

export const searchPageSize = (query: ServerSearch): number =>
  Math.max(1, Math.min(query.pageToken ? SEARCH_MORE : SEARCH_PAGE, query.limit));

/**
 * `SearchResult` has no partial flag, so a hit the metadata batch could not fetch (a transient part failure) is
 * logged and the search throws, so the user presses Enter again instead of paging past hits that were never shown.
 */
function reportIncomplete(
  ctx: AdapterContext,
  fetched: Awaited<ReturnType<typeof fetchMetadata>>,
  wanted: number,
): void {
  if (fetched.pending.length === 0) return;
  const error = {
    class: 'transient' as const,
    provider: 'gmail',
    method: 'gmail.search',
    reason: 'searchIncomplete',
    providerMessage: `${fetched.pending.length} of ${wanted} hits not fetched`,
  };
  ctx.log.event('sync.gmail.request_refused', { error });
  throw new ProviderError(error);
}

export async function search(
  deps: GmailDeps,
  query: ServerSearch,
  ctx: AdapterContext,
): Promise<SearchResult> {
  // No words: `() -in:drafts` would list recent mail, which is not a search answer.
  if (!query.text.trim()) return { upserts: [], remoteThreadIds: [], costUnits: 0 };
  const client = new GmailClient(deps, ctx);
  const page = await client.call<{
    messages?: { id: string; threadId: string }[];
    nextPageToken?: string;
  }>({
    method: 'gmail.messages.list',
    path: '/messages',
    query: {
      // Grouped so a trailing OR in the user's text cannot pair with the draft exclusion.
      q: `(${query.text}) -in:drafts`,
      maxResults: searchPageSize(query),
      pageToken: query.pageToken,
      labelIds: query.folder ? [query.folder] : undefined,
    },
    fields: 'messages(id,threadId),nextPageToken',
    lane: 'interactive',
  });
  const newest = new Map<string, string>();
  for (const m of page.messages ?? []) if (!newest.has(m.threadId)) newest.set(m.threadId, m.id);
  const fetched = await fetchMetadata(client, [...newest.values()], {
    lane: 'interactive',
    self: ctx.account.address,
    now: ctx.clock.now(),
  });
  // A refusal is the user's answer here, not something to hide behind fewer results.
  if (fetched.error) throw fetched.error;
  reportIncomplete(ctx, fetched, newest.size);
  const found = new Set(fetched.facts.map(f => f.remoteThreadId));
  return {
    upserts: fetched.facts,
    remoteThreadIds: [...newest.keys()].filter(id => found.has(id)),
    ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
    costUnits: client.spent,
  };
}
