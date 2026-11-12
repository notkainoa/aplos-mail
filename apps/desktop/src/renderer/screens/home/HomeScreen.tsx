/**
 * The Home screen (DESIGN 7.2). It reads `useHome`, orders each section, keeps the cursor on a key, holds the list
 * still while keys or the pointer are at work, and routes every key through the CommandRegistry. The list itself is
 * `HomeList`; the empty states are `HomeEmpty`. Later, the lists and Done are the next round.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  useAccounts,
  useAccountsLoaded,
  useConnection,
  useCounts,
  useHold,
  useHome,
  useSettings,
  useStatus,
  useUndoTop,
  type AccountId,
  type HoldController,
  type State,
  type ThreadId,
} from '../../data';
import type { ContextName } from '../../commands';
import { toSyncStatus } from '../../shell/status-map';
import {
  scrollTopOf,
  useCommandTarget,
  useCurrentTarget,
  useRestoreScroll,
  useReturnRestore,
  useReturnSource,
  useShellKeyLayer,
  type ReturnPoint,
} from '../../shell';
import { statusCopy } from '../../ui/status';
import { CommitTemplates } from '../CommitTemplates';
import { BulkMenu } from '../lists/BulkMenu';
import type { Confirmation } from '../lists/listActions';
import { confirmationIsStale } from '../lists/listModel';
import { ListConfirm, ListFailed } from '../lists/ListStates';
import { useBulk } from '../lists/useBulk';
import { moreEntriesOf, useBulkBarPart } from '../lists/useBulkBar';
import { Reopenable } from '../lists/Reopenable';
import { accountsAreKnown, HomeEmpty } from './HomeStates';
import {
  activeDomId,
  HomeList,
  rowDomId,
  threadIdOfDomId,
  type HomeListHandlers,
} from './HomeList';
import { HomeOverlays } from './HomeOverlays';
import type { WhyTarget } from './WhyHost';
import type { HomeActions, HomeSnapshot, OpenHow } from './homeActions';
import type { HomeBulkDeps } from './homeBulk';
import { homeBarActions, homeRunContext } from './homeCommands';
import {
  buildItems,
  keyOf,
  layoutOf,
  orderLayout,
  pickableIds,
  type HomeItem,
  type HomeLayout,
} from './homeModel';
import { densityOf, senderOf, subjectOf, suggestionOf } from './homeRows';
import { useHomeActions } from './useHomeActions';
import { useHomeDatePicker } from './useHomeDatePicker';
import { useFollowHomeCursor } from './useFollowHomeCursor';
import { useHomeCursor } from './useHomeCursor';
import { isGate, useHomeMotion } from './useHomeMotion';

/** Props for `HomeScreen`. */
export interface HomeScreenProps {
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
  /** Open a thread in the reader, or its reply (the reader lane owns both; absent until it lands). */
  readonly onOpen?: (id: ThreadId, how: OpenHow) => void;
  /** "Go one by one" (S): the reader stepping through Do now. */
  readonly onOneByOne?: () => void;
}

const SETTLING_STATES: readonly string[] = ['backfilling', 'paused'];

function ignore(): void {
  return undefined;
}

type HomeData = ReturnType<typeof useHome>;

function hasRows(layout: HomeLayout): boolean {
  return (
    layout.do.length + layout.fromLater.length + layout.update.length + layout.follow.length > 0
  );
}

/** Whether Home shows something other than its list: an empty state, the opening moment or a failure with nothing to show. */
function listIsHidden(emptied: boolean, home: HomeData, layout: HomeLayout): boolean {
  if (emptied || home.status === 'opening') return true;
  return home.status === 'failed' && !hasRows(layout);
}

/** The pointer rests on a row: pin it (the hold waits until the pointer leaves). */
function usePointerHold(hold: HoldController) {
  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!isGate(hold) || !(event.target instanceof Element)) return;
      const option = event.target.closest('[role="option"]');
      const id = option ? threadIdOfDomId(option.id) : null;
      if (id !== null) hold.pointerEnter([id]);
    },
    [hold],
  );
  const onPointerLeave = useCallback(() => {
    if (isGate(hold)) hold.pointerLeave();
  }, [hold]);
  return { onPointerMove, onPointerLeave };
}

/** Keeps the cursor row in view as it moves. */
function useScrollToCursor(key: string | null): void {
  useEffect(() => {
    const id = activeDomId(key);
    document.getElementById(id ?? '')?.scrollIntoView?.({ block: 'nearest' });
  }, [key]);
}

/** The Low importance sheet was open when the reader opened over Home. */
function restoredLowOpen(point: ReturnPoint | null): boolean {
  return (point?.extra as { readonly lowOpen?: boolean } | undefined)?.lowOpen === true;
}

/** Saves Home's place (cursor, scroll, an open Low sheet) when a thread opens over it. */
function useHomeReturn(snapshot: { readonly current: HomeSnapshot }, lowOpen: boolean): void {
  const open = useRef(lowOpen);
  open.current = lowOpen;
  useReturnSource('home', () => {
    const { key, items } = snapshot.current;
    return {
      cursorId: key,
      order: items.map(keyOf),
      scrollTop: scrollTopOf(document.getElementById(activeDomId(key) ?? '')),
      extra: { lowOpen: open.current },
    };
  });
}

/** The key contexts above Home's own: a sheet, the date presets or the trash question, whichever is open. */
function keyContexts(lowOpen: boolean, datePickerOpen: boolean, asking: boolean): ContextName[] {
  if (lowOpen) return ['lowImportance'];
  if (datePickerOpen) return ['datePicker'];
  return asking ? ['dialog'] : [];
}

/** The pane header's bulk bar while rows are picked, and its More menu. */
function useHomeBar(actions: HomeActions, count: number | null) {
  const plan = useMemo(
    () => ({ actions: homeBarActions(actions), entries: moreEntriesOf('all') }),
    [actions],
  );
  return useBulkBarPart(plan, actions, count);
}

/** Home with nothing to list: no account yet, first sync, or inbox zero. */
function EmptyHome(props: {
  readonly accountCount: number;
  readonly counts: ReturnType<typeof useCounts>;
  readonly status: ReturnType<typeof useStatus>;
  readonly canUndo: boolean;
}) {
  const { counts, status } = props;
  const settling = counts.hidden || SETTLING_STATES.includes(status?.status.state ?? '');
  const reason = status ? statusCopy(toSyncStatus(status))?.text : undefined;
  return (
    <HomeEmpty
      accountCount={props.accountCount}
      settling={settling}
      reason={reason}
      handledToday={counts.counts.handledToday}
      canUndo={props.canUndo}
    />
  );
}

/** The bulk pick over the rows X can reach, and the trash question it may raise. */
function useHomePick(items: readonly HomeItem[], state: State | null) {
  const pickable = useMemo(() => pickableIds(items), [items]);
  // Home acts on named ids, never a selector: the view it freezes is just the rows ⌘A saw.
  const bulk = useBulk(pickable, { state, total: pickable.length });
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const current = useRef(confirmation);
  current.current = confirmation;
  useEffect(() => {
    // The rows it asked about are gone: nothing is left to confirm, and the dialog's keys go.
    if (confirmation && confirmationIsStale(confirmation, pickable)) setConfirmation(null);
  }, [confirmation, pickable]);
  const deps = useMemo<HomeBulkDeps>(
    () => ({ selection: bulk.controls, confirmation: () => current.current, setConfirmation }),
    [bulk.controls],
  );
  return { bulk, confirmation, deps };
}

function HomeBody({ accountId, onOpen, onOneByOne }: HomeScreenProps) {
  const hold = useHold('home');
  const home = useHome({ accountId, holdIds: hold.heldIds });
  const accounts = useAccounts();
  const known = accountsAreKnown(useAccountsLoaded(), useConnection().state);
  const counts = useCounts(accountId);
  const status = useStatus(accountId);
  const undoTop = useUndoTop();
  const density = densityOf(useSettings()?.ui.density);

  const rowOf = useCallback((id: ThreadId) => home.rows.get(id), [home.rows]);
  const layout = orderLayout(layoutOf(home), rowOf, hold.isHeld);
  const empty = home.status === 'live' && home.total === 0 && home.low.count === 0;
  const listHidden = listIsHidden(accounts.length === 0 || empty, home, layout);
  const restore = useReturnRestore('home');
  const cursor = useHomeCursor(buildItems(layout), restore);
  useRestoreScroll(restore, activeDomId(cursor.key));
  useScrollToCursor(cursor.key);
  useFollowHomeCursor(accountId, cursor.key, hold.isHeld);
  const pick = useHomePick(cursor.items, home.state);

  const snapshot = useRef<HomeSnapshot>({ items: [], key: null, rowOf, state: null });
  snapshot.current = {
    items: cursor.items,
    key: cursor.key,
    rowOf,
    state: home.state,
    accountId,
    picked: pick.bulk.picking ? pick.bulk.picked : undefined,
  };
  const cursorRow = cursor.key === null ? undefined : home.rows.get(cursor.key);
  const cursorSection = cursor.items.find(item => keyOf(item) === cursor.key);
  const suggestion =
    cursorRow && cursorSection?.kind === 'row'
      ? suggestionOf(cursorRow, cursorSection.section)
      : undefined;
  useCommandTarget(
    cursorRow
      ? {
          kind: 'thread',
          id: cursorRow.id,
          title: senderOf(cursorRow),
          detail: subjectOf(cursorRow),
        }
      : null,
  );

  const [lowOpen, setLowOpen] = useState(() => restoredLowOpen(restore));
  useHomeReturn(snapshot, lowOpen);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [why, setWhy] = useState<WhyTarget | null>(null);
  const templates = useRef<HTMLDivElement>(null);
  const motionCommit = useHomeMotion(hold, templates);
  const target = useCurrentTarget();

  const keyState = useRef({ lowSheetOpen: lowOpen, remindOffer: false, target });
  const context = useCallback(
    () =>
      homeRunContext(
        keyState.current.target,
        keyState.current.lowSheetOpen,
        keyState.current.remindOffer,
        document.activeElement,
      ),
    [],
  );
  const commit = useCallback(
    (kind: 'done' | 'later' | 'trash', ids: readonly string[], rowId: ThreadId) => {
      // The row acted on, which is not the one under the cursor when a hover button was pressed.
      motionCommit(kind, document.getElementById(rowDomId(rowId)), ids);
    },
    [motionCommit],
  );
  const datePicker = useHomeDatePicker(hold, () => {
    const dom = activeDomId(snapshot.current.key);
    return dom ? document.getElementById(dom) : null;
  });
  const closeDatePicker = datePicker.close;
  useEffect(() => {
    // The picker is drawn inside the list; with the list gone its key context must go too.
    if (listHidden) closeDatePicker();
  }, [listHidden, closeDatePicker]);
  const openLow = useCallback(() => setLowOpen(true), []);
  const openMore = useCallback(() => {
    // The ⋯ menu is a message menu: only a real row has one (the Low band does not).
    const item = snapshot.current.items.find(i => keyOf(i) === snapshot.current.key);
    if (item?.kind !== 'row') return;
    setMenuAnchor(document.getElementById(rowDomId(item.id)));
  }, []);
  const openWhy = useCallback(() => {
    const { key, items } = snapshot.current;
    const dom = activeDomId(key);
    const anchor = dom ? document.getElementById(dom) : null;
    const onRow = items.some(item => item.kind === 'row' && item.id === key);
    if (anchor && key !== null && onRow) setWhy({ id: key, anchor });
  }, []);
  const oneByOne = onOneByOne ?? ignore;
  const bulkMore = useRef<() => void>(ignore);
  const { actions, remindOffer } = useHomeActions({
    snapshot,
    context,
    hold,
    bulk: pick.deps,
    setCursor: cursor.setCursor,
    commit,
    openThread: onOpen ?? ignore,
    openLow,
    oneByOne,
    openMore,
    openBulkMore: () => bulkMore.current(),
    openDatePicker: datePicker.open,
    why: openWhy,
  });
  keyState.current = { lowSheetOpen: lowOpen, remindOffer, target };
  useShellKeyLayer({
    contexts: keyContexts(lowOpen, datePicker.isOpen && !listHidden, pick.confirmation !== null),
    conditions: pick.bulk.picking ? { remindOffer, selection: true } : { remindOffer },
  });
  const bulkMenu = useHomeBar(actions, pick.bulk.picking ? pick.bulk.picked.length : null);
  bulkMore.current = bulkMenu.open;
  const pointer = usePointerHold(hold);

  const handlers: HomeListHandlers = {
    select: cursor.setCursor,
    open: id => (onOpen ?? ignore)(id, 'open'),
    rowAction: (commandId, key) =>
      commandId === 'mail.later' ? actions.later(key) : actions.done(key),
    suggested: () => actions.suggested(),
    // The letter's own buttons mean its own row, even while others are picked.
    later: () => actions.later(snapshot.current.key ?? undefined),
    done: () => actions.done(snapshot.current.key ?? undefined),
    more: setMenuAnchor,
    openLow,
    oneByOne,
    clearFromHome: () => actions.clearFromHome(),
  };

  // Until the engine has answered, an empty account list means "not loaded yet", not "no accounts": stay neutral.
  if (accounts.length === 0 && !known) return null;
  if (accounts.length === 0 || empty) {
    return (
      <EmptyHome
        accountCount={accounts.length}
        counts={counts}
        status={status}
        canUndo={undoTop !== null}
      />
    );
  }
  if (home.status === 'failed' && !hasRows(layout)) return <ListFailed />;
  if (home.status === 'opening') return null;
  return (
    <div className="aplos-list-column" data-screen="home" {...pointer}>
      <HomeList
        view={home}
        layout={layout}
        cursorKey={cursor.key}
        density={density}
        accounts={accounts}
        demoted={lowOpen}
        picked={pick.bulk.selection.picked}
        handlers={handlers}
      />
      <CommitTemplates forwardedRef={templates} />
      <BulkMenu menu={bulkMenu} />
      {pick.confirmation ? (
        <ListConfirm
          confirmation={pick.confirmation}
          onConfirm={actions.confirm}
          onCancel={actions.cancelConfirm}
        />
      ) : null}
      {datePicker.element}
      <HomeOverlays
        accountId={accountId}
        lowOpen={lowOpen}
        onCloseLow={() => setLowOpen(false)}
        menuAnchor={menuAnchor}
        onCloseMenu={() => setMenuAnchor(null)}
        density={density}
        accounts={accounts}
        rowOf={rowOf}
        cursorKey={cursor.key}
        suggestion={suggestion}
        onOpen={onOpen ?? ignore}
        actions={actions}
        why={why}
        onWhy={openWhy}
        onCloseWhy={() => setWhy(null)}
      />
    </div>
  );
}

export function HomeScreen(props: HomeScreenProps) {
  return (
    <Reopenable>
      <HomeBody {...props} />
    </Reopenable>
  );
}
