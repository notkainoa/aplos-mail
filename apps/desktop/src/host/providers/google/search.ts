import type { AdapterContext, SearchResult, ServerSearch } from '@aplos/engine/ports';
import { GmailClient, type GmailDeps } from './client';
import { fetchMetadata } from './sync';

/**
 * Server search, run only when the user presses Enter (D2): the local index answers while typing and this module has
 * no other entry point. One `messages.list?q=` page (5 units, at most 25 hits), then metadata for the newest hit of
 * each thread in one batch on the interactive lane. Bodies stay lazy; the store keeps the rows with `origin='search'`.
 * Drafts are never results (D9): the query leaves them out, so a thread's newest hit is a real message, and a draft
 * that slips through anyway is not returned (`fetchMetadata` keeps drafts out of `facts`).
 */

export const SEARCH_PAGE = 25;

export async function search(deps: GmailDeps, query: ServerSearch, ctx: AdapterContext): Promise<SearchResult> {
  const client = new GmailClient(deps, ctx);
  const page = await client.call<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>({
    method: 'gmail.messages.list',
    path: '/messages',
    query: {
      // Grouped so a trailing OR in the user's text cannot pair with the draft exclusion.
      q: `(${query.text}) -in:drafts`,
      maxResults: Math.max(1, Math.min(SEARCH_PAGE, query.limit)),
      pageToken: query.pageToken,
      labelIds: query.folder ? [query.folder] : undefined,
    },
    fields: 'messages(id,threadId),nextPageToken',
    lane: 'interactive',
  });
  const newest = new Map<string, string>();
  for (const m of page.messages ?? []) if (!newest.has(m.threadId)) newest.set(m.threadId, m.id);
  const fetched = await fetchMetadata(client, [...newest.values()], { lane: 'interactive', self: ctx.account.address, now: ctx.clock.now() });
  // A refusal is the user's answer here, not something to hide behind fewer results.
  if (fetched.error) throw fetched.error;
  const found = new Set(fetched.facts.map(f => f.remoteThreadId));
  return {
    upserts: fetched.facts,
    remoteThreadIds: [...newest.keys()].filter(id => found.has(id)),
    ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
    costUnits: client.spent,
  };
}
