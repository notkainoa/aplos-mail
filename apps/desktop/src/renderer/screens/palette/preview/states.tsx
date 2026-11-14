/**
 * The preview states for the palette and the Search page (DESIGN §7.9, §12.5). Each state is a pure render of the
 * real components over the real registry and models — `paletteView` for the palette, `searchPage`/`resultRow` for
 * Search — with demo threads and no-op handlers, so no data layer, engine or account is needed.
 */
import type { ReactElement } from 'react';
import { createAppRegistry, DEFAULT_KEY_PREFS, type CommandContext } from '../../../commands';
import type { ThreadRow } from '../../../data';
import { openPalette, paletteView, setQuery, applyRun } from '../palette.model';
import { PaletteScreen } from '../PaletteScreen';
import { initialSearch, resultRow, searchPage, type SearchState } from '../../search/search.model';
import { SearchPage } from '../../search/SearchPage';

export const registry = createAppRegistry();
for (const spec of registry.list())
  registry.attach(spec.id, { run: () => undefined, ...(spec.page ? { children: () => [] } : {}) });

const noop = () => undefined;
const PALETTE_HANDLERS = {
  onQueryChange: noop,
  onActiveChange: noop,
  onRun: noop,
  onBack: noop,
  onClose: noop,
  onConfirm: noop,
  onCancelConfirm: noop,
};
const SEARCH_HANDLERS = {
  onChange: noop,
  onRemoveToken: noop,
  onSubmit: noop,
  onRetryResults: noop,
  onLeaveToList: noop,
  onSelectRow: noop,
  onOpenRow: noop,
  onRowAction: noop,
};

const CTX: CommandContext = {
  stack: ['global', 'list', 'compose'],
  target: { kind: 'thread', id: 't-drew', title: 'Drew Bell', detail: 'October illustrations' },
  selection: [],
  conditions: {},
  prefs: DEFAULT_KEY_PREFS,
  focus: 'control',
};

const ENTRIES = registry.commandsForPalette(CTX);
const INPUT = { ctx: CTX, entries: ENTRIES, recents: ['nav.calendar'] };

type Row = Pick<
  ThreadRow,
  | 'id'
  | 'fromName'
  | 'subject'
  | 'snippet'
  | 'unread'
  | 'lastDate'
  | 'hasAttachments'
  | 'workflow'
  | 'accountId'
>;

const FROZEN = Date.parse('2026-10-29T17:00:00Z');
const HOUR = 3_600_000;

function thread(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    fromName: 'Jordan Park',
    subject: `Invoice ${id}`,
    snippet: 'The October illustrations are finished.',
    unread: false,
    lastDate: FROZEN - HOUR,
    hasAttachments: false,
    workflow: { status: 'new', bookmarked: false, hiddenFromHome: false },
    accountId: 'acct-demo',
    ...over,
  };
}

const LOCAL_THREADS = [
  thread('t-1', {
    subject: 'Invoice 0412 · October illustrations',
    unread: true,
    hasAttachments: true,
  }),
  thread('t-2', {
    subject: 'Invoice 0398 · September illustrations',
    lastDate: FROZEN - 48 * HOUR,
  }),
  thread('t-3', {
    subject: 'A quieter home for the Hollow Creek site',
    lastDate: FROZEN - 72 * HOUR,
  }),
];
const REMOTE_THREADS = [
  thread('t-9', { subject: 'Invoice 201 · Spring mural', lastDate: FROZEN - 4000 * HOUR }),
];

const EMPTY_LOCAL = { status: 'live' as const, ids: [] as string[], total: 0 };
const WITH_LOCAL = {
  status: 'live' as const,
  ids: LOCAL_THREADS.map(t => t.id),
  total: LOCAL_THREADS.length,
};
const WITH_REMOTE = {
  status: 'live' as const,
  ids: [...WITH_LOCAL.ids, 't-9'],
  total: WITH_LOCAL.total + 1,
};

const QUERY = { text: 'invoice' };

function SearchScene({
  state,
  remote = false,
  local,
}: {
  state: SearchState;
  remote?: boolean;
  local?: Parameters<typeof searchPage>[1];
}) {
  const model = searchPage(
    state,
    local ?? (remote ? WITH_REMOTE : state.field || state.tokens.length ? WITH_LOCAL : EMPTY_LOCAL),
    FROZEN,
  );
  return (
    <div className="search-screen-wrap">
      <SearchPage
        model={model}
        localRows={model.localIds
          .map(id => LOCAL_THREADS.find(t => t.id === id))
          .filter(Boolean)
          .map(t => resultRow(t as Row, QUERY as never, false))}
        remoteRows={model.remoteIds
          .map(id => REMOTE_THREADS.find(t => t.id === id))
          .filter(Boolean)
          .map(t => resultRow(t as Row, QUERY as never, true))}
        density="comfortable"
        scopeLabel="All accounts"
        handlers={SEARCH_HANDLERS}
      />
    </div>
  );
}

function PaletteScene({ state }: { state: ReturnType<typeof openPalette> }) {
  return (
    <PaletteScreen state={state} view={paletteView(state, INPUT)} handlers={PALETTE_HANDLERS} />
  );
}

const CONFIRM_STATE = applyRun(
  openPalette(),
  { kind: 'command', id: 'compose.discard' },
  {
    status: 'confirm',
    title: 'Discard this draft?',
    prompt: '“Invoice notes” will be removed. This can’t be undone.',
    confirmLabel: 'Discard',
    destructive: true,
  },
).state;

const PAGE_STATE = applyRun(
  openPalette(),
  { kind: 'command', id: 'mail.moveToLabel' },
  {
    status: 'page',
    title: 'Move to label',
    items: [
      { id: 'receipts', label: 'Receipts', detail: 'Label', run: noop },
      { id: 'hollow-creek', label: 'Hollow Creek', detail: 'Label', run: noop },
      { id: 'new', label: 'New label…', run: noop },
    ],
  },
).state;

export interface StateEntry {
  readonly title: string;
  readonly kind: 'overlay' | 'page';
  readonly render: () => ReactElement;
}

export const states: Record<string, StateEntry> = {
  'palette-first-open': {
    title: 'Palette: first open (Suggested + Go to)',
    kind: 'overlay',
    render: () => <PaletteScene state={openPalette()} />,
  },
  'palette-typing': {
    title: 'Palette: filtered results with matches and group labels',
    kind: 'overlay',
    render: () => <PaletteScene state={setQuery(openPalette(), 'tr')} />,
  },
  'palette-page': {
    title: 'Palette: a nested page with breadcrumbs',
    kind: 'overlay',
    render: () => <PaletteScene state={PAGE_STATE} />,
  },
  'palette-confirm': {
    title: 'Palette: destructive confirm, Cancel is the default',
    kind: 'overlay',
    render: () => <PaletteScene state={CONFIRM_STATE} />,
  },
  'palette-no-results': {
    title: 'Palette: no commands match',
    kind: 'overlay',
    render: () => <PaletteScene state={setQuery(openPalette(), 'xyzzy')} />,
  },
  'search-empty': {
    title: 'Search: empty field with the operator hint',
    kind: 'page',
    render: () => <SearchScene state={initialSearch} />,
  },
  'search-tokens': {
    title: 'Search: operator tokens under the field (in:done, is:unread)',
    kind: 'page',
    render: () => (
      <SearchScene
        state={{
          field: 'invoice',
          tokens: [
            { operator: 'from', value: 'drew' },
            { operator: 'in', value: 'done' },
            { operator: 'is', value: 'unread' },
          ],
          remote: { phase: 'idle' },
        }}
      />
    ),
  },
  'search-local': {
    title: 'Search: local results as ordinary rows',
    kind: 'page',
    render: () => <SearchScene state={{ ...initialSearch, field: 'invoice' }} />,
  },
  'search-remote-offer': {
    title: 'Search: “Search all mail on Google · Return” under the results',
    kind: 'page',
    render: () => <SearchScene state={{ ...initialSearch, field: 'invoice' }} />,
  },
  'search-remote-running': {
    title: 'Search: remote search running (busy after 150 ms)',
    kind: 'page',
    render: () => (
      <SearchScene
        remote
        state={{
          field: 'invoice',
          tokens: [],
          remote: {
            phase: 'running',
            key: 'all|invoice',
            at: 0,
            runId: 'r1',
            localIds: WITH_LOCAL.ids,
          },
        }}
      />
    ),
  },
  'search-remote-results': {
    title: 'Search: remote hits under “From Google”',
    kind: 'page',
    render: () => (
      <SearchScene
        remote
        state={{
          field: 'invoice',
          tokens: [],
          remote: { phase: 'done', key: 'all|invoice', runId: 'r1', localIds: WITH_LOCAL.ids },
        }}
      />
    ),
  },
  'search-remote-error': {
    title: 'Search: remote error with Try again',
    kind: 'page',
    render: () => (
      <SearchScene
        state={{
          field: 'invoice',
          tokens: [],
          remote: { phase: 'failed', key: 'all|invoice', reason: 'error' },
        }}
      />
    ),
  },
  'search-failed-reauth': {
    title: 'Search: sign-in expired — the reason line alone, no generic banner',
    kind: 'page',
    render: () => (
      <SearchScene
        local={{
          status: 'failed',
          ids: [],
          total: 0,
          error: { type: 'needsReauth' },
        }}
        state={{
          field: 'invoice',
          tokens: [],
          remote: { phase: 'failed', key: 'all|invoice', reason: 'needsReauth' },
        }}
      />
    ),
  },
  'search-failed-partial': {
    title: 'Search: remote sign-in failure under kept local results',
    kind: 'page',
    render: () => (
      <SearchScene
        local={{
          status: 'failed',
          ids: WITH_LOCAL.ids,
          total: WITH_LOCAL.total,
          error: { type: 'needsReauth' },
        }}
        state={{
          field: 'invoice',
          tokens: [],
          remote: { phase: 'failed', key: 'all|invoice', reason: 'needsReauth' },
        }}
      />
    ),
  },
  'search-failed-window-paused': {
    title: 'Search: window failed without a reason under a remote pause — one line, Try again',
    kind: 'page',
    render: () => (
      <SearchScene
        local={{
          status: 'failed',
          ids: [],
          total: 0,
          error: { type: 'internal' },
        }}
        state={{
          field: 'invoice',
          tokens: [],
          remote: {
            phase: 'paused',
            key: 'all|invoice',
            resumeAt: FROZEN + HOUR,
            at: FROZEN,
          },
        }}
      />
    ),
  },
  'search-no-results': {
    title: 'Search: no match carries the Google offer',
    kind: 'page',
    render: () => (
      <SearchScene state={{ field: 'dentist', tokens: [], remote: { phase: 'idle' } }} />
    ),
  },
};
