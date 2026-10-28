/**
 * The Search page's container (DESIGN §7.9): the field's state, the local `search` window as you type, and
 * `Search/remote` on Return only, exactly once (U7 acceptance 7). The one call site of `api.search.remote` is the
 * `remote` effect of `submit`; no effect hook, re-render or window `reset` can reach it.
 */
import { useEffect, useRef, useState } from 'react';
import { api, useFrames, useView } from '../../data';
import type { ErrorBody } from '../../data';
import type { Announce, CommandId, Density, TagColor } from '../../ui/props';
import { paletteStore } from '../palette/paletteStore';
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
  type SearchEffect,
  type SearchState,
  type SearchStep,
} from './search.model';
import { SearchPage } from './SearchPage';
import './search.css';

export interface SearchPorts {
  /** `all` (absent) or one account, from the sidebar's account switcher. */
  readonly accountId?: string;
  readonly scopeLabel: string;
  /** The scope can search on the server (`capabilities.serverSearch`). */
  readonly remoteSupported: boolean;
  /** The account is paused until then (rate limit, daily quota). */
  readonly pausedUntil?: number;
  readonly showAccountDot: boolean;
  readonly accountTag: (accountId: string) => { label: string; color: TagColor } | undefined;
  readonly density: Density;
  readonly now: () => number;
  readonly openThread: (threadId: string) => void;
  /** A hover action: run the command on that thread. */
  readonly runRowCommand: (threadId: string, commandId: CommandId, anchor: HTMLElement) => void;
  /** The list took the keyboard: the cursor row is the command target. */
  readonly onCursor?: (threadId: string | undefined) => void;
  readonly announce?: Announce;
}

function errorBody(error: unknown): ErrorBody {
  return (
    (error as { body?: ErrorBody } | null)?.body ?? {
      type: 'internal',
      message: 'Something went wrong.',
    }
  );
}

export function SearchContainer({ ports }: { ports: SearchPorts }) {
  const [state, setState] = useState<SearchState>(initialSearch);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [cursorId, setCursorId] = useState<string | undefined>();
  const [, tick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);

  const { query } = currentQuery(state);
  const local = useView({ kind: 'search', query, accountId: ports.accountId });
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

  function runEffect(effect: SearchEffect) {
    if (effect.kind === 'openPalette') {
      paletteStore.open(effect.query);
      return;
    }
    // The only remote call: one per `remote` effect, and only `submit` (Return) makes one.
    api.search
      .remote({ query: effect.query, accountId: ports.accountId })
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

  const model = searchPage(
    state,
    { status: local.status, ids: local.ids, total: local.total, error: local.error },
    ports.now(),
    ports.remoteSupported,
  );

  const announced = useRef('');
  useEffect(() => {
    if (model.announce && model.announce !== announced.current) {
      announced.current = model.announce;
      ports.announce?.(model.announce);
    }
  }, [model.announce, ports]);

  const rowFor = (id: string, remote: boolean) => {
    const thread = local.rows.get(id);
    return thread
      ? resultRow(
          thread,
          model.query,
          remote,
          ports.showAccountDot ? ports.accountTag(thread.accountId) : undefined,
        )
      : null;
  };
  const localRows = model.localIds.map(id => rowFor(id, false)).filter(r => r !== null);
  const remoteRows = model.remoteIds.map(id => rowFor(id, true)).filter(r => r !== null);
  const all = [...localRows, ...remoteRows];

  function moveCursor(threadId: string | undefined) {
    const row = all.find(r => r.threadId === threadId);
    setCursorId(row?.id);
    ports.onCursor?.(threadId);
  }

  return (
    <SearchPage
      model={model}
      localRows={localRows}
      remoteRows={remoteRows}
      cursorId={cursorId}
      density={ports.density}
      showAccountDot={ports.showAccountDot}
      scopeLabel={ports.scopeLabel}
      inputRef={inputRef}
      listRef={listRef}
      handlers={{
        onChange: text => perform(typeField(stateRef.current, text)),
        onRemoveToken: index => perform(removeToken(stateRef.current, index)),
        onSubmit: () =>
          perform(
            submit(stateRef.current, {
              now: ports.now(),
              supported: ports.remoteSupported,
              pausedUntil: ports.pausedUntil,
              localIds: local.ids,
            }),
          ),
        onLeaveToList: edge => {
          const row = edge === 'first' ? all[0] : all[all.length - 1];
          if (!row) return;
          moveCursor(row.threadId);
          listRef.current?.focus();
        },
        onSelectRow: threadId => moveCursor(threadId),
        onOpenRow: threadId => ports.openThread(threadId),
        onRowAction: (threadId, commandId, anchor) =>
          ports.runRowCommand(threadId, commandId, anchor),
      }}
    />
  );
}
