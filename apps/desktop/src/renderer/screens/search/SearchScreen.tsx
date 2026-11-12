/**
 * The Search page's screen (DESIGN §7.9): the field's state, the local `search` window as you type, and
 * `Search/remote` on Return only, exactly once (U7 acceptance 7). The one call site of `api.search.remote` is the
 * `remote` effect of `submit`; no effect hook, re-render or window `reset` can reach it. The shell mounts this for
 * the `{ label: 'Search' }` screen (REQUESTS.md in ../palette); it is props-in so the harness can draw it too.
 *
 * `SearchScreen` keeps the field's state and wraps `SearchBody` in `Reopenable`, so the failed window's "Try again"
 * remounts the view without losing the query. The field takes focus on mount: with it unfocused the list layer's
 * single keys (e, x, #) would act on real threads instead of typing.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { api, useAccounts, useFrames, useSettings, useView } from '../../data';
import type { Account, AccountId, ErrorBody, ThreadId } from '../../data';
import type { CommandId } from '../../ui/props';
import {
  navigate,
  returnKeyOf,
  scrollTopOf,
  useAccountScope,
  useCommandTarget,
  useRegisterCommands,
  useRestoreScroll,
  useReturnRestore,
  useReturnSource,
  useShellKeyLayer,
  type ReturnPoint,
} from '../../shell';
import { accountMark, densityOf } from '../home/homeRows';
import { requestPaletteOpen } from '../palette';
import { Reopenable, useReopen } from '../lists/Reopenable';
import { useIdCursor } from '../lists/useIdCursor';
import { ACT_DEPS, actOnRow, openResult, type RowAction } from './searchActions';
import {
  BUSY_DELAY_MS,
  clearField,
  currentQuery,
  initialSearch,
  remoteFrame,
  remoteRejected,
  remoteStarted,
  removeToken,
  resultRow,
  returnReady,
  searchPage,
  submit,
  typeField,
  type RemoteContext,
  type SearchEffect,
  type SearchState,
  type SearchStep,
} from './search.model';
import { SearchPage } from './SearchPage';

/** Props for `SearchScreen`; absent pieces fall back to the shell's own scope and openers. */
export interface SearchScreenProps {
  /** One account, or absent for the sidebar's scope (All accounts). */
  readonly accountId?: AccountId;
  /** Open a result; default `openThread` back to this screen. */
  readonly onOpen?: (id: ThreadId) => void;
}

const SEARCH_SCREEN = { label: 'Search' } as const;
const SEARCH_RETURN_KEY = returnKeyOf(SEARCH_SCREEN);

function errorBody(error: unknown): ErrorBody {
  return (
    (error as { body?: ErrorBody } | null)?.body ?? {
      type: 'internal',
      message: 'Something went wrong.',
    }
  );
}

/** Who Return's remote search may ask, for the current scope. */
function remoteFacts(
  accounts: readonly Account[],
  accountId: AccountId | undefined,
  now: number,
): Pick<RemoteContext, 'supported' | 'pausedUntil' | 'scope'> {
  const scoped = accountId ? accounts.filter(a => a.id === accountId) : accounts;
  const searchable = scoped.filter(a => a.capabilities.serverSearch);
  const supported = searchable.length > 0;
  const pauses = searchable.flatMap(a =>
    a.health.status.state === 'paused' && a.health.status.until > now
      ? [a.health.status.until]
      : [],
  );
  return {
    supported,
    pausedUntil: supported && pauses.length === searchable.length ? Math.min(...pauses) : undefined,
    scope: accountId ?? 'all',
  };
}

/** An unused slot's filter: contract run ids are non-empty, so this `runId` matches nothing. */
const NO_REMOTE_RUN = '';

/** The thread-id cursor's row facts for keys and the target line. */
interface CursorRow {
  readonly id: string;
  readonly sender: string;
  readonly subject: string;
  readonly unread: boolean;
  readonly bookmarked: boolean;
}

interface SearchBodyProps extends SearchScreenProps {
  readonly state: SearchState;
  readonly onState: (next: SearchState) => void;
}

/** The search as the owner left it when a result opened in the reader: query and tokens kept, a request still in flight forgotten (its frames went with the screen). */
function restoredSearch(point: ReturnPoint | null): SearchState {
  const saved = (point?.extra as { readonly search?: SearchState } | undefined)?.search;
  if (saved === undefined) return initialSearch;
  const inFlight = saved.remote.phase === 'starting' || saved.remote.phase === 'running';
  return inFlight ? { ...saved, remote: { phase: 'idle' } } : saved;
}

export function SearchScreen(props: SearchScreenProps): ReactElement {
  const saved = useReturnRestore(SEARCH_RETURN_KEY);
  const [state, setState] = useState<SearchState>(() => restoredSearch(saved));
  return (
    <Reopenable>
      <SearchBody {...props} state={state} onState={setState} />
    </Reopenable>
  );
}

function SearchBody(props: SearchBodyProps): ReactElement {
  const { state, onState } = props;
  const reopen = useReopen();
  const scope = useAccountScope();
  const accountId = props.accountId !== undefined ? props.accountId : (scope ?? undefined);
  const listIds = useRef<readonly string[]>([]);
  const openInReader = useCallback(
    (id: ThreadId) => openResult(SEARCH_SCREEN, id, listIds.current),
    [],
  );
  const open = props.onOpen ?? openInReader;

  const stateRef = useRef(state);
  stateRef.current = state;
  const [, tick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);

  // The field owns the keystrokes: mounted unfocused, the list layer's single keys would act on real threads.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const accounts = useAccounts();
  const density = densityOf(useSettings()?.ui.density);
  const { query } = currentQuery(state);
  const local = useView({ kind: 'search', query, accountId });
  const runId = 'runId' in state.remote ? state.remote.runId : undefined;
  // `runId: undefined` would match every progress frame on the bus; the sentinel matches none.
  const frames = useFrames('progress', { runId: runId ?? NO_REMOTE_RUN }).frames;

  function commit(next: SearchState) {
    stateRef.current = next;
    onState(next);
  }

  function perform(stepped: SearchStep) {
    commit(stepped.state);
    stepped.effects.forEach(runEffect);
  }
  // The command table calls perform through a ref, so the memoised table never re-registers for it.
  const performRef = useRef(perform);
  performRef.current = perform;
  // The frames effect reaches commit the same way.
  const commitRef = useRef(commit);
  commitRef.current = commit;

  function runEffect(effect: SearchEffect) {
    if (effect.kind === 'openPalette') {
      requestPaletteOpen(effect.query);
      return;
    }
    // The only remote call: one per `remote` effect, and only `submit` (Return) makes one.
    api.search
      .remote({ query: effect.query, accountId })
      .then(out => commit(remoteStarted(stateRef.current, effect.key, out.runId)))
      .catch((error: unknown) =>
        commit(remoteRejected(stateRef.current, effect.key, errorBody(error), Date.now())),
      );
  }

  useEffect(() => {
    let next = stateRef.current;
    const at = Date.now();
    for (const frame of frames) next = remoteFrame(next, frame, at);
    if (next !== stateRef.current) commitRef.current(next);
  }, [frames]);

  // "Searching Google…" waits 150 ms (DESIGN §5 rule 12): one re-render when that time comes.
  const phase = state.remote.phase;
  useEffect(() => {
    if (phase !== 'starting' && phase !== 'running') return;
    const timer = setTimeout(() => tick(n => n + 1), BUSY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const now = Date.now();
  const model = searchPage(
    state,
    { status: local.status, ids: local.ids, total: local.total, error: local.error },
    now,
    remoteFacts(accounts, accountId, now).supported,
    accountId ?? 'all',
  );

  const showAccountDot = accounts.length >= 2;
  const rowFor = (id: string, remote: boolean) => {
    const thread = local.rows.get(id);
    return thread
      ? resultRow(
          thread,
          model.query,
          remote,
          showAccountDot ? accountMark(thread.accountId, accounts) : undefined,
        )
      : null;
  };
  const localRows = model.localIds.map(id => rowFor(id, false)).filter(r => r !== null);
  const remoteRows = model.remoteIds.map(id => rowFor(id, true)).filter(r => r !== null);
  const all = useMemo(() => [...localRows, ...remoteRows], [localRows, remoteRows]);
  listIds.current = all.map(r => r.threadId);

  // Read here, not above `Reopenable`: a Try again remount starts fresh instead of snapping back to the saved row.
  const restore = useReturnRestore(SEARCH_RETURN_KEY);
  const resultIds = all.map(r => r.threadId);
  const cursor = useIdCursor(
    resultIds,
    restore,
    returnReady(restore?.cursorId, resultIds, local.status),
  );
  const cursorRow = all.find(r => r.threadId === cursor.key);
  useReturnSource(SEARCH_RETURN_KEY, () => ({
    cursorId: cursor.key,
    order: cursor.ids,
    scrollTop: scrollTopOf(document.getElementById(cursorRow?.id ?? '')),
    extra: { search: stateRef.current },
  }));
  useRestoreScroll(restore, cursorRow?.id ?? null);
  const live = useRef<{ row: CursorRow | undefined }>({ row: undefined });
  live.current = {
    row: cursorRow
      ? {
          id: cursorRow.threadId,
          sender: cursorRow.sender,
          subject: cursorRow.primary,
          unread: cursorRow.unread,
          bookmarked: cursorRow.marks.bookmarked === true,
        }
      : undefined,
  };

  useCommandTarget(
    cursorRow
      ? {
          kind: 'thread',
          id: cursorRow.threadId,
          title: cursorRow.sender,
          detail: cursorRow.primary,
        }
      : null,
  );
  useShellKeyLayer({ contexts: ['search', 'list'] });

  function act(
    threadId: string,
    action: RowAction,
    kind: 'done' | 'later' | 'trash' | 'bookmark' | 'info',
    message: string,
  ): void {
    actOnRow(ACT_DEPS, threadId, action, { kind, message });
  }

  // The cursor object is fresh each render; its parts are stable, so the table stays attached between keystrokes.
  const { key: cursorKey, ids: cursorIds, setCursor } = cursor;
  const commands = useMemo(
    () => ({
      'list.down': {
        run: () => {
          const at = cursorKey === null ? -1 : cursorIds.indexOf(cursorKey);
          if (at < cursorIds.length - 1) setCursor(cursorIds[at + 1]);
        },
      },
      'list.up': {
        run: () => {
          const at = cursorKey === null ? cursorIds.length : cursorIds.indexOf(cursorKey);
          if (at > 0) setCursor(cursorIds[at - 1]);
        },
      },
      'mail.open': {
        run: () => {
          if (live.current.row) open(live.current.row.id);
        },
      },
      'mail.suggested': {
        run: () => {
          if (live.current.row) open(live.current.row.id);
        },
      },
      'mail.done': {
        run: () => {
          if (live.current.row) act(live.current.row.id, { type: 'done' }, 'done', 'Done');
        },
      },
      'mail.later': {
        run: () => {
          if (live.current.row)
            act(live.current.row.id, { type: 'later' }, 'later', 'Moved to Later');
        },
      },
      'mail.trash': {
        run: () => {
          if (live.current.row)
            act(live.current.row.id, { type: 'trash' }, 'trash', 'Moved to Trash');
        },
      },
      'mail.bookmark': {
        run: () => {
          const row = live.current.row;
          if (row)
            act(
              row.id,
              { type: 'bookmark', on: !row.bookmarked },
              'bookmark',
              row.bookmarked ? 'Bookmark removed' : 'Bookmarked',
            );
        },
      },
      'mail.toggleRead': {
        run: () => {
          const row = live.current.row;
          if (row)
            act(
              row.id,
              { type: row.unread ? 'read' : 'unread' },
              'info',
              row.unread ? 'Marked read' : 'Marked unread',
            );
        },
      },
      'search.remote': {
        run: () => {
          const at = Date.now();
          performRef.current(
            submit(stateRef.current, {
              now: at,
              localIds: local.ids,
              ...remoteFacts(accounts, accountId, at),
            }),
          );
        },
      },
      // The last rung of the field's Esc ladder (the mockup's data-esc): Esc leaves for Home once the field is empty.
      'nav.back': {
        run: () => {
          navigate('home');
        },
      },
    }),
    [cursorKey, cursorIds, setCursor, accounts, accountId, local.ids, open],
  );
  useRegisterCommands(commands);

  function remoteSubmit() {
    const at = Date.now();
    perform(
      submit(stateRef.current, {
        now: at,
        localIds: local.ids,
        ...remoteFacts(accounts, accountId, at),
      }),
    );
  }

  const handlers = {
    onChange: (text: string) => perform(typeField(stateRef.current, text)),
    onRemoveToken: (index: number) => perform(removeToken(stateRef.current, index)),
    onSubmit: remoteSubmit,
    onRetryResults: reopen,
    onLeaveToList: (edge: 'first' | 'last') => {
      const row = edge === 'first' ? all[0] : all[all.length - 1];
      if (!row) return;
      cursor.setCursor(row.threadId);
      listRef.current?.focus();
    },
    onSelectRow: (threadId: string) => cursor.setCursor(threadId),
    onOpenRow: (threadId: string) => open(threadId),
    onRowAction: (threadId: string, commandId: CommandId) => {
      if (commandId === 'mail.done') act(threadId, { type: 'done' }, 'done', 'Done');
      else if (commandId === 'mail.later')
        act(threadId, { type: 'later' }, 'later', 'Moved to Later');
      else if (commandId === 'mail.trash')
        act(threadId, { type: 'trash' }, 'trash', 'Moved to Trash');
    },
  };

  // Esc in the field clears the text and the tokens before the key reaches the registry; the `preventDefault`
  // keeps that Esc from running `nav.back`, so only the next one, on the empty field, goes back (DESIGN §8 ladder).
  function onScreenKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest('.ui-search-field') === null) return;
    const current = stateRef.current;
    if (current.field === '' && current.tokens.length === 0) return;
    event.preventDefault();
    perform(clearField(current));
  }

  const scoped = accountId ? accounts.find(a => a.id === accountId) : undefined;
  return (
    <div className="aplos-screen-fill" data-keyctx="search,list" onKeyDown={onScreenKeyDown}>
      <SearchPage
        model={model}
        localRows={localRows}
        remoteRows={remoteRows}
        cursorId={cursorRow?.id}
        density={density}
        showAccountDot={showAccountDot}
        scopeLabel={scoped?.name ?? 'All accounts'}
        handlers={handlers}
        inputRef={inputRef}
        listRef={listRef}
      />
    </div>
  );
}
