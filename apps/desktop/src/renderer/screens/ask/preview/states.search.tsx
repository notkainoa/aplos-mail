/**
 * Preview fixtures for the Search page: invented threads and the helpers that put them through the real
 * `searchPage` model and `SearchPage`. Split out of states.tsx.
 */
import type { ThreadRow } from '../../../data';
import { SearchPage } from '../../search/SearchPage';
import {
  initialSearch,
  remoteStarted,
  resultRow,
  searchPage,
  submit as submitSearch,
  typeField,
  type LocalResults,
  type SearchState,
} from '../../search/search.model';
import { at, NOW, noop } from './shared';

export function thread(
  id: string,
  fromName: string,
  subject: string,
  snippet: string,
  lastDate: number,
  extra: Partial<ThreadRow> = {},
): ThreadRow {
  return {
    id,
    accountId: 'acc',
    rev: 1,
    subject,
    snippet,
    fromName,
    participants: [],
    lastDate,
    messageCount: 2,
    unreadCount: 0,
    partial: false,
    unread: false,
    flagged: false,
    hasAttachments: false,
    labels: [],
    workflow: { status: 'new', bookmarked: false, hiddenFromHome: false },
    rank: { lane: 'update', importance: 'normal', source: 'heuristic', dueBand: 3 },
    summary: { state: 'none' },
    fromLater: false,
    unsubscribe: false,
    ...extra,
  } as ThreadRow;
}

export const THREADS: ThreadRow[] = [
  thread(
    't1',
    'Jordan Park',
    'A quieter home for the Hollow Creek site',
    'Two layout directions are ready, one quieter and one bolder.',
    at(29, 10),
    { unread: true, hasAttachments: true },
  ),
  thread(
    't2',
    'Jordan Park',
    'Kicking off Hollow Creek',
    'Here is the brief we agreed on Friday, with the layout notes.',
    at(20, 9),
    { hasAttachments: true },
  ),
  thread(
    't3',
    'Jordan Park',
    'Sitemap v2',
    'Updated site map with the booking form on the first page.',
    at(14, 16),
    { hasAttachments: true },
  ),
  thread(
    't4',
    'Jordan Park',
    'Logo files',
    'The layout grid and logo files for the trail map, as promised.',
    at(8, 11),
    { hasAttachments: true },
  ),
];
export const REMOTE: ThreadRow[] = [
  thread(
    'g1',
    'Jordan Park',
    'Layout feedback from the board',
    'The board liked the quieter layout for the landing page.',
    at(2, 15),
    { partial: true, hasAttachments: true },
  ),
];

export function rowsById(list: ThreadRow[]) {
  return new Map(list.map(t => [t.id, t]));
}

export function search(
  state: SearchState,
  local: LocalResults,
  rows: Map<string, ThreadRow>,
  now = NOW,
) {
  const model = searchPage(state, local, now);
  const toRow = (id: string, remote: boolean) => {
    const t = rows.get(id);
    return t ? resultRow(t, model.query, remote) : null;
  };
  return (
    <SearchPage
      model={model}
      localRows={model.localIds.map(id => toRow(id, false)).filter(r => r !== null)}
      remoteRows={model.remoteIds.map(id => toRow(id, true)).filter(r => r !== null)}
      cursorId={model.localIds.length > 0 ? `search-row-${model.localIds[0]}` : undefined}
      density="comfortable"
      showAccountDot={false}
      scopeLabel="All accounts"
      handlers={{
        onChange: noop,
        onRemoveToken: noop,
        onSubmit: noop,
        onLeaveToList: noop,
        onSelectRow: noop,
        onOpenRow: noop,
        onRowAction: noop,
      }}
    />
  );
}

export function typed(text: string): SearchState {
  return typeField(initialSearch, text).state;
}

export function asked(state: SearchState, localIds: string[], now: number): SearchState {
  const stepped = submitSearch(state, { now, supported: true, localIds });
  const effect = stepped.effects[0];
  return effect?.kind === 'remote'
    ? remoteStarted(stepped.state, effect.key, 'search-run')
    : stepped.state;
}
