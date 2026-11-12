/**
 * Everything the one-by-one view does that is not drawing: it reads Do now (`useHome`), runs the walk
 * (`useWalkSession`), commits through Home's own actions (`createHomeActions`, over a snapshot holding just the thread
 * showing, so the toasts, Undo and the Remind offer are Home's), attaches its keys to the CommandRegistry, and sets the
 * pane header's back button and "Home  3 of 9" crumb.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useHold,
  useHome,
  useSettings,
  type AccountId,
  type RowFailure,
  type ThreadId,
  type ThreadRow,
} from '../../data';
import {
  returnKeyOf,
  usePaneHeaderPart,
  useCommandTarget,
  useCurrentTarget,
  useRegisterCommands,
  useReturnRestore,
  useReturnSource,
  useShellKeyLayer,
  type PaneHeaderPart,
} from '../../shell';
import type { Density } from '../../ui/props';
import type { HomeSnapshot } from './homeActions';
import { homeRunContext } from './homeCommands';
import { laneOf, stepLane, type MovableLane, type SectionKey } from './homeModel';
import { rowDomId } from './HomeList';
import { densityOf, failurePhrase, senderOf, subjectOf } from './homeRows';
import { commandsForOneByOne, type OneByOneControls } from './oneByOneCommands';
import { doNowIdsOf } from './oneByOneQueue';
import { undoLast, useHomeActionState } from './useHomeActions';
import { useHomeDatePicker } from './useHomeDatePicker';
import { useWalkSession } from './useWalkSession';
import type { WhyTarget } from './WhyHost';

const EMPTY: HomeSnapshot = { items: [], key: null, rowOf: () => undefined, state: null };

function ignore(): void {
  return undefined;
}

/**
 * Where the menus, Why and the date presets hang from: the card's header actions (Importance, bell, ⋯) when it has them,
 * else the card. A small anchor means a press anywhere else in the card closes them (a popover ignores presses in its anchor).
 */
function letterOf(key: string | null): HTMLElement | null {
  const card = key === null ? null : document.getElementById(rowDomId(key));
  return card?.querySelector<HTMLElement>('.ui-thread-message__actions') ?? card;
}

/** Props for `OneByOneScreen`. */
export interface OneByOneScreenProps {
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
  /** Back to Home (Esc, the header's back button, the finish line's button). */
  readonly onExit: () => void;
  /** Return, O and R: open the thread in the reader. Absent until the reader lands. */
  readonly onOpen?: (id: ThreadId) => void;
}

/** "Couldn't <op>." with Retry, as Home's rows word it; a retry is a commit, so the walk steps on again. */
function retryOf(failure: RowFailure, id: ThreadId, acted: (id: ThreadId) => void) {
  return {
    op: failurePhrase(failure.action),
    onRetry: () => {
      acted(id);
      void failure.retry();
    },
  };
}

function crumbOf(
  progress: { readonly index: number; readonly of: number } | null,
  onExit: () => void,
): PaneHeaderPart {
  return {
    lead: { kind: 'back', label: 'Back to Home', commandId: 'nav.back', onPress: onExit },
    crumb: { label: 'Home', position: progress ?? undefined },
  };
}

/** What the screen draws from. */
export interface OneByOne {
  readonly ready: boolean;
  /** The thread showing, or null when the walk is over (or has not started). */
  readonly row: ThreadRow | undefined;
  readonly finished: boolean;
  /** Do now held nothing when the walk started. */
  readonly nothingToWalk: boolean;
  readonly failed: boolean;
  readonly section: SectionKey;
  readonly density: Density;
  readonly menu: WhyTarget | null;
  readonly why: WhyTarget | null;
  readonly closeMenu: () => void;
  readonly closeWhy: () => void;
  readonly openMenuAt: (anchor: HTMLElement) => void;
  readonly openWhy: () => void;
  readonly datePicker: ReturnType<typeof useHomeDatePicker>;
  readonly actions: ReturnType<typeof useHomeActionState>['actions'];
  readonly rejected: { readonly op: string; readonly onRetry: () => void } | undefined;
  readonly lane: OneByOneControls['lane'];
  /** The Importance menu: the thread moves straight to this lane, and the walk steps on. */
  readonly laneTo: (to: MovableLane) => void;
  /** The thread showing, in the reader (Return, O, R). */
  readonly open: () => void;
  readonly exit: () => void;
}

/** The key the walk is saved under when a thread opens over it. */
const ONE_BY_ONE_RETURN_KEY = returnKeyOf({ label: 'one by one' });

export function useOneByOne({ accountId, onExit, onOpen }: OneByOneScreenProps): OneByOne {
  const home = useHome({ accountId });
  const restore = useReturnRestore(ONE_BY_ONE_RETURN_KEY);
  const walk = useWalkSession(home, restore);
  const queue = walk.session?.walk.queue;
  useReturnSource(ONE_BY_ONE_RETURN_KEY, () => ({
    cursorId: walk.shown,
    order: queue ?? [],
    scrollTop: 0,
  }));
  const hold = useHold('oneByOne');
  const density = densityOf(useSettings()?.ui.density);
  const target = useCurrentTarget();
  const row = walk.ready && walk.shown !== null ? home.rows.get(walk.shown) : undefined;
  const section: SectionKey =
    row && doNowIdsOf(home).fromLater.includes(row.id) ? 'fromLater' : 'do';

  const props = useRef({ onExit, onOpen });
  props.current = { onExit, onOpen };
  const snapshot = useRef<HomeSnapshot>(EMPTY);
  snapshot.current = row
    ? {
        items: [{ kind: 'row', id: row.id, section }],
        key: row.id,
        rowOf: id => home.rows.get(id),
        state: home.state,
        accountId,
      }
    : { ...EMPTY, state: home.state, accountId };
  useCommandTarget(
    row ? { kind: 'thread', id: row.id, title: senderOf(row), detail: subjectOf(row) } : null,
  );

  const [menu, setMenu] = useState<WhyTarget | null>(null);
  const [whyTarget, setWhyTarget] = useState<WhyTarget | null>(null);
  const openMenuAt = useCallback((anchor: HTMLElement) => {
    const id = snapshot.current.key;
    if (id !== null) setMenu({ id, anchor });
  }, []);
  const openMore = useCallback(() => {
    const anchor = letterOf(snapshot.current.key);
    if (anchor) openMenuAt(anchor);
  }, [openMenuAt]);
  const openWhy = useCallback(() => {
    const id = snapshot.current.key;
    const anchor = letterOf(id);
    if (id !== null && anchor) setWhyTarget({ id, anchor });
  }, []);

  const datePicker = useHomeDatePicker(hold, () => letterOf(snapshot.current.key));
  const keyState = useRef({ remindOffer: false, target });
  const { actions, remindOffer } = useHomeActionState({
    snapshot,
    context: () =>
      homeRunContext(
        keyState.current.target,
        false,
        keyState.current.remindOffer,
        document.activeElement,
      ),
    hold,
    setCursor: ignore,
    commit: (_kind, _ids, rowId) => walk.acted(rowId),
    openThread: id => props.current.onOpen?.(id),
    openLow: ignore,
    oneByOne: ignore,
    openMore,
    openDatePicker: datePicker.open,
  });
  keyState.current = { remindOffer, target };

  const { acted, step } = walk;
  const lane = useCallback(
    (direction: 'up' | 'down') => {
      const { key, rowOf } = snapshot.current;
      const current = key === null ? undefined : rowOf(key);
      const from = current ? laneOf(current) : null;
      // A lane move takes the thread out of Do now (or nowhere, at the end of the lanes): only the first steps on.
      if (current && from && stepLane(from, direction)) acted(current.id);
      actions.lane(direction);
    },
    [actions, acted],
  );
  const laneTo = useCallback(
    (to: MovableLane) => {
      const { key, rowOf } = snapshot.current;
      const current = key === null ? undefined : rowOf(key);
      // Any move out of the lane the thread is in takes it out of Do now, so the walk steps on.
      if (current && laneOf(current) !== null && laneOf(current) !== to) acted(current.id);
      actions.laneTo(to);
    },
    [actions, acted],
  );
  const controls = useMemo<OneByOneControls>(
    () => ({
      step,
      open: () => {
        const id = snapshot.current.key;
        if (id !== null) props.current.onOpen?.(id);
      },
      more: openMore,
      why: openWhy,
      lane,
      undo: () => undoLast(actions),
      back: () => props.current.onExit(),
    }),
    [step, openMore, openWhy, lane, actions],
  );
  useRegisterCommands(useMemo(() => commandsForOneByOne(actions, controls), [actions, controls]));
  useShellKeyLayer({
    contexts: datePicker.isOpen ? ['home', 'datePicker'] : ['home'],
    conditions: { remindOffer },
  });

  const exit = useCallback(() => props.current.onExit(), []);
  const index = walk.progress?.index;
  const of = walk.progress?.of;
  const part = useMemo(
    () => crumbOf(index === undefined || of === undefined ? null : { index, of }, exit),
    [index, of, exit],
  );
  usePaneHeaderPart(part);

  const showingId = row?.id;
  // A ⋯ menu belongs to the thread it was opened on: stepping on closes it for good, so walking back never reopens it.
  useEffect(() => setMenu(null), [showingId]);

  const failure = row ? home.failures.get(row.id) : undefined;
  const rejected = useMemo(
    () => (failure && row ? retryOf(failure, row.id, acted) : undefined),
    [failure, row, acted],
  );
  const showing = row?.id;
  return {
    ready: walk.ready,
    row,
    finished: walk.ready && walk.shown === null,
    nothingToWalk: (walk.session?.walk.queue.length ?? 0) === 0,
    failed: home.status === 'failed',
    section,
    density,
    menu: menu?.id === showing ? menu : null,
    why: whyTarget,
    closeMenu: () => setMenu(null),
    closeWhy: () => setWhyTarget(null),
    openMenuAt,
    openWhy,
    datePicker,
    actions,
    rejected,
    lane,
    laneTo,
    open: controls.open,
    exit,
  };
}
