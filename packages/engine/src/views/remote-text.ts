import type { SearchQuery } from '@aplos/contract';

/**
 * What the provider is asked: the free words and the operators it understands, in Gmail's search syntax (the only
 * provider this round). Places, `done`, `later` and bookmarks are Aplos's own and stay local. Before, only the free
 * words went, so `from:airbnb` asked for nothing. Loaded on the first `Search/remote` (`import()` in `remote.ts`), so
 * the engine core bundle does not carry it.
 */
export function remoteText(query: SearchQuery): string {
  const quoted = (v: string) => `"${v.replace(/["\p{Cc}]/gu, ' ').trim()}"`;
  const day = (v: string) => v.replace(/-/g, '/');
  const IS: Record<string, string> = {
    unread: 'is:unread',
    read: 'is:read',
    flagged: 'is:starred',
  };
  return [
    query.text.trim(),
    query.from && `from:${quoted(query.from)}`,
    query.to && `to:${quoted(query.to)}`,
    query.subject && `subject:${quoted(query.subject)}`,
    query.hasAttachment && 'has:attachment',
    query.after && `after:${day(query.after)}`,
    query.before && `before:${day(query.before)}`,
    ...(query.is ?? []).map(flag => IS[flag]),
  ]
    .filter(Boolean)
    .join(' ');
}
