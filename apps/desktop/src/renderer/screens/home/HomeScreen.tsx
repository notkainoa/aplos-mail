/**
 * The Home screen (DESIGN 7.2). It reads `useHome`, orders each section, keeps the cursor on a key, holds the list
 * still while keys or the pointer are at work, and routes every key through the CommandRegistry. The list itself is
 * `HomeList`; the empty states are `HomeEmpty`. Later, the lists and Done are the next round.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
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
  type ThreadId,
} from '../../data';
import { toSyncStatus } from '../../shell/status-map';
import { useCommandTarget, useCurrentTarget, useShellKeyLayer } from '../../shell';
import { statusCopy } from '../../ui/status';
import { CommitTemplates } from '../CommitTemplates';
import { ListFailed } from '../lists/ListStates';
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
import type { HomeSnapshot, OpenHow } from './homeActions';
import { homeRunContext } from './homeCommands';
import { buildItems, orderLayout, type HomeLayout } from './homeModel';
import { densityOf, senderOf, subjectOf } from './homeRows';
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

function layoutOf(home: HomeData): HomeLayout {
  const bySection = (key: 'do' | 'update' | 'follow') =>
    home.sections.find(section => section.key === key);
  return {
    do: bySection('do')?.ids ?? [],
    fromLater: bySection('do')?.fromLater?.ids ?? [],
    update: bySection('update')?.ids ?? [],
    follow: bySection('follow')?.ids ?? [],
    lowCount: home.low.count,
  };
}

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
  const cursor = useHomeCursor(buildItems(layout));
  useScrollToCursor(cursor.key);
  useFollowHomeCursor(accountId, cursor.key, hold.isHeld);

  const snapshot = useRef<HomeSnapshot>({ items: [], key: null, rowOf, state: null });
  snapshot.current = { items: cursor.items, key: cursor.key, rowOf, state: home.state, accountId };
  const cursorRow = cursor.key === null ? undefined : home.rows.get(cursor.key);
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

  const [lowOpen, setLowOpen] = useState(false);
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
    const dom = activeDomId(snapshot.current.key);
    setMenuAnchor(dom ? document.getElementById(dom) : null);
  }, []);
  const openWhy = useCallback(() => {
    const { key, items } = snapshot.current;
    const dom = activeDomId(key);
    const anchor = dom ? document.getElementById(dom) : null;
    const onRow = items.some(item => item.kind === 'row' && item.id === key);
    if (anchor && key !== null && onRow) setWhy({ id: key, anchor });
  }, []);
  const oneByOne = onOneByOne ?? ignore;
  const { actions, remindOffer } = useHomeActions({
    snapshot,
    context,
    hold,
    setCursor: cursor.setCursor,
    commit,
    openThread: onOpen ?? ignore,
    openLow,
    oneByOne,
    openMore,
    openDatePicker: datePicker.open,
    why: openWhy,
  });
  keyState.current = { lowSheetOpen: lowOpen, remindOffer, target };
  useShellKeyLayer({
    contexts: lowOpen ? ['lowImportance'] : datePicker.isOpen && !listHidden ? ['datePicker'] : [],
    conditions: { remindOffer },
  });
  const pointer = usePointerHold(hold);

  const handlers: HomeListHandlers = {
    select: cursor.setCursor,
    open: id => (onOpen ?? ignore)(id, 'open'),
    rowAction: (commandId, key) =>
      commandId === 'mail.later' ? actions.later(key) : actions.done(key),
    suggested: () => actions.suggested(),
    later: () => actions.later(),
    done: () => actions.done(),
    more: setMenuAnchor,
    openLow,
    oneByOne,
    clearFromHome: () => actions.clearFromHome(),
  };

  // Until the engine has answered, an empty account list means "not loaded yet", not "no accounts": stay neutral.
  if (accounts.length === 0 && !known) return null;
  if (accounts.length === 0 || empty) {
    const settling = counts.hidden || SETTLING_STATES.includes(status?.status.state ?? '');
    const reason = status ? statusCopy(toSyncStatus(status))?.text : undefined;
    return (
      <HomeEmpty
        accountCount={accounts.length}
        settling={settling}
        reason={reason}
        handledToday={counts.counts.handledToday}
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
        handlers={handlers}
      />
      <CommitTemplates forwardedRef={templates} />
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
