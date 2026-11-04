/**
 * The Search page's screen (DESIGN §7.9): the field's state, the local `search` window as you type, and
 * `Search/remote` on Return only, exactly once (U7 acceptance 7). The one call site of `api.search.remote` is the
 * `remote` effect of `submit`; no effect hook, re-render or window `reset` can reach it. The shell mounts this for
 * the `{ label: 'Search' }` screen (REQUESTS.md in ../palette); it is props-in so the harness can draw it too.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { api, useAccounts, useFrames, useSettings, useView } from '../../data';
import type { Account, AccountId, ErrorBody, ThreadId } from '../../data';
import type { CommandId, TagColor } from '../../ui/props';
import {
  openThread,
  pushToast,
  useAccountScope,
  useCommandTarget,
  useRegisterCommands,
  useShellKeyLayer,
} from '../../shell';
import { densityOf } from '../home/homeRows';
import { requestPaletteOpen } from '../palette';
import { useIdCursor } from '../lists/useIdCursor';
import {
  BUSY_DELAY_MS,
  currentQuery,
  initialSearch,
  remoteFrame,
  remoteRejected,
  remoteStarted,
  removeToken,
  resultRow,
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

function errorBody(error: unknown): ErrorBody {
  return (
    (error as { body?: ErrorBody } | null)?.body ?? {
      type: 'internal',
      message: 'Something went wrong.',
    }
  );
}

function accountTag(account: Account | undefined): { label: string; color: TagColor } | undefined {
  if (!account) return undefined;
  return { label: account.name, color: (account.colorTag ?? 'sky') as TagColor };
}

/** Who Return's remote search may ask, for the current scope. */
function remoteFacts(
  accounts: readonly Account[],
  accountId: AccountId | undefined,
  now: number,
): Pick<RemoteContext, 'supported' | 'pausedUntil'> {
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
  };
}

/** The thread-id cursor's row facts for keys and the target line. */
interface CursorRow {
  readonly id: string;
  readonly sender: string;
  readonly subject: string;
}

export function SearchScreen(props: SearchScreenProps): ReactElement {
  const scope = useAccountScope();
  const accountId = props.accountId !== undefined ? props.accountId : (scope ?? undefined);
  const openInReader = useCallback((id: ThreadId) => openThread(id, { from: SEARCH_SCREEN }), []);
  const open = props.onOpen ?? openInReader;

  const [state, setState] = useState<SearchState>(initialSearch);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [, tick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);

  const accounts = useAccounts();
  const density = densityOf(useSettings()?.ui.density);
  const { query } = currentQuery(state);
  const local = useView({ kind: 'search', query, accountId });
  const runId = 'runId' in state.remote ? state.remote.runId : undefined;
  const frames = useFrames('progress', { runId }).frames;

  function commit(next: SearchState) {
    stateRef.current = next;
    setState(next);
  }

  function perform(stepped: SearchStep) {
    commit(stepped.state);
    stepped.effects.forEach(runEffect);
  }
  // The command table calls perform through a ref, so the memoised table never re-registers for it.
  const performRef = useRef(perform);
  performRef.current = perform;

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
        commit(remoteRejected(stateRef.current, effect.key, errorBody(error))),
      );
  }

  useEffect(() => {
    let next = stateRef.current;
    for (const frame of frames) next = remoteFrame(next, frame);
    if (next !== stateRef.current) commit(next);
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
  );

  const showAccountDot = accounts.length >= 2;
  const rowFor = (id: string, remote: boolean) => {
    const thread = local.rows.get(id);
    return thread
      ? resultRow(
          thread,
          model.query,
          remote,
          showAccountDot ? accountTag(accounts.find(a => a.id === thread.accountId)) : undefined,
        )
      : null;
  };
  const localRows = model.localIds.map(id => rowFor(id, false)).filter(r => r !== null);
  const remoteRows = model.remoteIds.map(id => rowFor(id, true)).filter(r => r !== null);
  const all = useMemo(() => [...localRows, ...remoteRows], [localRows, remoteRows]);

  const cursor = useIdCursor(all.map(r => r.threadId));
  const cursorRow = all.find(r => r.threadId === cursor.key);
  const live = useRef<{ row: CursorRow | undefined }>({ row: undefined });
  live.current = {
    row: cursorRow
      ? { id: cursorRow.threadId, sender: cursorRow.sender, subject: cursorRow.primary }
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

  function act(threadId: string, action: { type: string }, message: string): void {
    const { opId, receipt } = api.thread.act({ ids: [threadId], action: action as never });
    receipt.catch(() => undefined);
    pushToast({ id: opId, kind: 'info', message, undoable: true });
  }

  const commands = useMemo(
    () => ({
      'list.down': {
        run: () => {
          const ids = cursor.ids;
          const at = cursor.key === null ? -1 : ids.indexOf(cursor.key);
          if (at < ids.length - 1) cursor.setCursor(ids[at + 1]);
        },
      },
      'list.up': {
        run: () => {
          const ids = cursor.ids;
          const at = cursor.key === null ? ids.length : ids.indexOf(cursor.key);
          if (at > 0) cursor.setCursor(ids[at - 1]);
        },
      },
      'mail.open': {
        run: () => {
          if (live.current.row) open(live.current.row.id);
        },
      },
      'mail.done': {
        run: () => {
          if (live.current.row) act(live.current.row.id, { type: 'done' }, 'Done');
        },
      },
      'mail.later': {
        run: () => {
          if (live.current.row) act(live.current.row.id, { type: 'later' }, 'Moved to Later');
        },
      },
      'mail.trash': {
        run: () => {
          if (live.current.row) act(live.current.row.id, { type: 'trash' }, 'Moved to Trash');
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
    }),
    [cursor, accounts, accountId, local.ids, open],
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
    onLeaveToList: (edge: 'first' | 'last') => {
      const row = edge === 'first' ? all[0] : all[all.length - 1];
      if (!row) return;
      cursor.setCursor(row.threadId);
      listRef.current?.focus();
    },
    onSelectRow: (threadId: string) => cursor.setCursor(threadId),
    onOpenRow: (threadId: string) => open(threadId),
    onRowAction: (threadId: string, commandId: CommandId) => {
      if (commandId === 'mail.done') act(threadId, { type: 'done' }, 'Done');
      else if (commandId === 'mail.later') act(threadId, { type: 'later' }, 'Moved to Later');
      else if (commandId === 'mail.trash') act(threadId, { type: 'trash' }, 'Moved to Trash');
    },
  };

  const scoped = accountId ? accounts.find(a => a.id === accountId) : undefined;
  return (
    <div className="aplos-screen-fill" data-keyctx="search,list">
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
