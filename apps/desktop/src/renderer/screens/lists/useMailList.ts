/**
 * The shared list's state for one mounted screen (DESIGN 4.1, 5 rule 6, 7.4): the watched view with the list's hold
 * gate, the cursor, the actions and the confirmation they may ask for. All mail, Drafts, Sent, Trash, Spam, labels,
 * Done and Bookmarks all run on this; `MailListView` draws it. Keys come from the shell's registry and key listener:
 * the screen attaches its command table with `use<Screen>Keys(list.actions)`; this hook adds the list's contexts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { ContextName, Registry } from '../../commands';
import {
  api,
  useAccounts,
  useCounts,
  useHold,
  useSettings,
  useStatus,
  useView,
  type Account,
  type AccountId,
  type HoldController,
  type ViewResult,
} from '../../data';
import type { HoldGate } from '../../data/holds';
import {
  useCommandTarget,
  dismissToast,
  pushToast,
  useShellKeyLayer,
  useShellRegistry,
} from '../../shell';
import { toSyncStatus } from '../../shell/status-map';
import { statusCopy } from '../../ui/status';
import type { Density } from '../../ui/props';
import { densityOf } from '../home/homeRows';
import {
  createListActions,
  type Confirmation,
  type ListActions,
  type ListSnapshot,
} from './listActions';
import type { ListConfig } from './listKinds';
import { viewSpecOf } from './listKinds';
import { absoluteIndex, confirmationIsStale, LIST_WINDOW, rangeAround } from './listModel';
import { asListRow, targetOf, type ListRowData, type OpenKind } from './listRows';
import { useIdCursor, type IdCursor } from './useIdCursor';

/** What a list screen is given. */
export interface MailListOptions {
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
  /** Open a thread, draft or submission (Return, O, double-click). Absent until the reader and composer land. */
  readonly onOpen?: (id: string, kind: OpenKind, listIds?: readonly string[]) => void;
  /** Permanent deletion, offered in Trash and Spam behind a Confirm. Absent: the key does nothing there. */
  readonly deleteForever?: (ids: readonly string[]) => Promise<unknown>;
  /** A transient the screen has open on top of the list (the Later date picker): it owns the keys while it shows. */
  readonly modal?: ContextName | null;
  /**
   * The ids the screen actually draws, in order, when that is fewer than the whole window (Later draws only the groups
   * it knows). The cursor and the keys then never land on a thread nobody can see. Default: every id of the window.
   */
  readonly drawnIds?: (view: ViewResult<unknown>) => readonly string[];
}

/** The sync states in which an empty list is not really empty. */
const SETTLING_STATES: readonly string[] = ['backfilling', 'paused'];

/** What the list shows instead of rows. */
export interface EmptyState {
  /** First sync is still reading mail, or sync is paused: not a real empty. */
  readonly settling: boolean;
  /** The status slot's sentence for the same moment. */
  readonly reason?: string;
}

/** Everything `MailListView` draws and every handler it calls. */
export interface MailListState {
  readonly config: ListConfig;
  readonly view: ViewResult<unknown>;
  readonly ids: readonly string[];
  readonly rowOf: (id: string) => ListRowData | undefined;
  readonly cursor: IdCursor;
  readonly actions: ListActions;
  readonly confirmation: Confirmation | null;
  readonly density: Density;
  readonly accounts: readonly Account[];
  readonly empty: EmptyState;
  readonly hold: HoldController;
  readonly pointer: {
    onPointerMove(event: PointerEvent<HTMLElement>): void;
    onPointerLeave(): void;
  };
}

function isGate(hold: HoldController): hold is HoldGate {
  return 'pointerEnter' in hold && 'subscribe' in hold;
}

/** The pointer rests on a row: pin it (the hold waits until the pointer leaves). */
function usePointerHold(hold: HoldController, domPrefix: string) {
  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!isGate(hold) || !(event.target instanceof Element)) return;
      const option = event.target.closest('[role="option"]');
      if (option?.id.startsWith(domPrefix)) hold.pointerEnter([option.id.slice(domPrefix.length)]);
    },
    [hold, domPrefix],
  );
  const onPointerLeave = useCallback(() => {
    if (isGate(hold)) hold.pointerLeave();
  }, [hold]);
  return { onPointerMove, onPointerLeave };
}

/** The DOM id of a row's option in this list. */
export function rowDomId(config: ListConfig, id: string): string {
  return `${config.id}-row-${id}`;
}

/** The row id in an option's DOM id, or null for anything else. */
export function rowIdOfDom(config: ListConfig, domId: string): string | null {
  const prefix = `${config.id}-row-`;
  return domId.startsWith(prefix) ? domId.slice(prefix.length) : null;
}

/** Keeps the cursor row in view as it moves. */
function useScrollToCursor(config: ListConfig, key: string | null): void {
  useEffect(() => {
    if (key === null) return;
    document.getElementById(rowDomId(config, key))?.scrollIntoView?.({ block: 'nearest' });
  }, [config, key]);
}

/** Asks the engine for the window around the cursor when the view is longer than one window. */
function useFollowCursor(view: ViewResult<unknown>, key: string | null): void {
  const { ids, position, total, move } = view;
  const at = key === null ? -1 : ids.indexOf(key);
  useEffect(() => {
    if (total <= LIST_WINDOW || at < 0) return;
    move(rangeAround(absoluteIndex(position, at), total));
  }, [total, position, at, move]);
}

function useEmptyState(accountId: AccountId | undefined): EmptyState {
  const counts = useCounts(accountId);
  const status = useStatus(accountId);
  const settling = counts.hidden || SETTLING_STATES.includes(status?.status.state ?? '');
  const reason = status ? statusCopy(toSyncStatus(status))?.text : undefined;
  return { settling, reason };
}

function undoLabelOf(registry: Registry, commandId: string, fallback: string): string {
  const entry = registry.get(commandId);
  return (entry?.kind === 'command' ? entry.spec.undo?.label : undefined) ?? fallback;
}

const NO_SNAPSHOT: ListSnapshot = { ids: [], key: null, rowOf: () => undefined };

export function useMailList(config: ListConfig, options: MailListOptions): MailListState {
  const { accountId, onOpen, deleteForever } = options;
  const hold = useHold(config.scope);
  const view = useView(viewSpecOf(config, accountId), { holdIds: hold.heldIds });
  const { registry } = useShellRegistry();
  const accounts = useAccounts();
  const density = densityOf(useSettings()?.ui.density);
  const empty = useEmptyState(accountId);

  const rowOf = useCallback((id: string) => asListRow(view.rows.get(id)), [view.rows]);
  const cursor = useIdCursor(options.drawnIds ? options.drawnIds(view) : view.ids);
  useScrollToCursor(config, cursor.key);
  useFollowCursor(view, cursor.key);

  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const live = useRef({ snapshot: NO_SNAPSHOT, confirmation, onOpen, deleteForever });
  live.current = {
    snapshot: { ids: cursor.ids, key: cursor.key, rowOf },
    confirmation,
    onOpen,
    deleteForever,
  };

  useEffect(() => {
    // The rows it asked about are gone (the list emptied under it): nothing is left to confirm, and the dialog's keys go.
    if (confirmation && confirmationIsStale(confirmation, cursor.ids)) setConfirmation(null);
  }, [confirmation, cursor.ids]);

  const actions = useMemo(
    () =>
      createListActions({
        kind: config.kind,
        snapshot: () => live.current.snapshot,
        setCursor: cursor.setCursor,
        act: args => api.thread.act(args),
        discardDraft: id => api.draft.destroy({ id }),
        canDeleteForever: () => live.current.deleteForever !== undefined,
        deleteForever: ids => live.current.deleteForever?.(ids) ?? Promise.resolve(),
        push: pushToast,
        dismiss: dismissToast,
        hold: { extend: ids => hold.extend(ids) },
        open: (id, kind, listIds) => live.current.onOpen?.(id, kind, listIds),
        confirmation: () => live.current.confirmation,
        setConfirmation,
        undoLabel: (commandId, fallback) => undoLabelOf(registry, commandId, fallback),
      }),
    [config.kind, cursor.setCursor, hold, registry],
  );

  const cursorRow = cursor.key === null ? undefined : rowOf(cursor.key);
  useCommandTarget(cursorRow ? targetOf(cursorRow) : null);
  const modal = confirmation ? 'dialog' : (options.modal ?? null);
  useShellKeyLayer({ contexts: modal ? [...config.contexts, modal] : config.contexts });
  const pointer = usePointerHold(hold, `${config.id}-row-`);

  return {
    config,
    view,
    ids: cursor.ids,
    rowOf,
    cursor,
    actions,
    confirmation,
    density,
    accounts,
    empty,
    hold,
    pointer,
  };
}
