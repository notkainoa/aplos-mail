/**
 * The Low importance sheet (DESIGN 7.2) on its data: the `lowBySender` view, one group per sender. Mounted only while
 * the sheet is open, so the window is watched only then; with more threads than one window it follows the cursor. The
 * first → arms and the second marks every thread done in one operation (a selector over the section, at the state the
 * owner saw), with one Undo toast.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useHold, useView, type HoldController } from '../../data';
import type { Account, AccountId, ThreadId, ThreadRow, ViewResult } from '../../data';
import {
  dismissToast,
  pushToast,
  scrollTopOf,
  useRegisterCommands,
  useRestoreScroll,
  useReturnRestore,
  useReturnSource,
  type ReturnPoint,
} from '../../shell';
import type { Density, ListRowProps, LowSheetGroup } from '../../ui/props';
import { LowSheet } from '../../ui/list';
import { absoluteIndex, neighbourKeys, stepKey } from '../lists/listModel';
import { useRestoreWindow, windowReaches } from '../lists/restoreWindow';
import { useIdCursor } from '../lists/useIdCursor';
import { UNDO_ACTION, undoHandler } from '../undoOperation';
import { listRowProps, primaryOf } from './homeRows';
import { useFollowWindow } from './useFollowHomeCursor';

const BINDING_ID = 'home-low-list';
/** The hold scope of the sheet's list, apart from Home's own. */
const HOLD_SCOPE = 'home-low';

/** Props for `LowSheetHost`. */
export interface LowSheetHostProps {
  readonly accountId?: AccountId;
  readonly density: Density;
  readonly accounts: readonly Account[];
  readonly onOpenThread: (id: ThreadId) => void;
  readonly onClose: () => void;
}

const lowDomId = (id: string): string => `home-low-row-${id}`;

/** The key the open sheet is saved under when a thread opens over it, beside Home's own. */
const RETURN_KEY = 'home/low';

/** The sender groups of the view, each with its threads in window order. */
export function groupsOf(
  view: Pick<ViewResult<ThreadRow>, 'ids' | 'rows' | 'sections' | 'position'>,
  rowProps: (row: ThreadRow) => ListRowProps,
): LowSheetGroup[] {
  return view.sections.flatMap(section => {
    const from = section.start - view.position;
    const rows = view.ids
      .slice(Math.max(0, from), Math.max(0, from + section.count))
      .flatMap(id => view.rows.get(id) ?? [])
      .map(rowProps);
    return rows.length === 0
      ? []
      : [{ id: `home-low-${section.key}`, sender: section.label ?? section.key, rows }];
  });
}

/**
 * The sheet's cursor is a thread id, so mail arriving above it never moves the highlighted row; each step also holds
 * the rows around it, so a re-rank does not reorder them behind the highlight (DESIGN 5 rule 6).
 */
function useSheetCursor(
  view: ViewResult<ThreadRow>,
  hold: HoldController,
  restore: ReturnPoint | null,
) {
  useRestoreWindow(view, restore);
  const cursor = useIdCursor(view.ids, restore, windowReaches(restore, view));
  useReturnSource(RETURN_KEY, () => ({
    cursorId: cursor.key,
    order: cursor.ids,
    scrollTop: scrollTopOf(document.getElementById(cursor.key ? lowDomId(cursor.key) : '')),
    index: absoluteIndex(view.position, view.ids.indexOf(cursor.key ?? '')),
  }));
  useRestoreScroll(restore, cursor.key ? lowDomId(cursor.key) : null);
  const latest = useRef({ cursor, hold });
  useEffect(() => {
    latest.current = { cursor, hold };
  });
  const table = useMemo(() => {
    const step = (delta: 1 | -1) => {
      const { cursor: now, hold: gate } = latest.current;
      const next = stepKey(now.ids, now.key, delta);
      now.setCursor(next);
      gate.extend(neighbourKeys(now.ids, next));
    };
    return {
      'lowImportance.next': { run: () => step(1) },
      'lowImportance.previous': { run: () => step(-1) },
    };
  }, []);
  useRegisterCommands(table);
  return cursor.key ?? undefined;
}

/** The sheet over Home. */
export function LowSheetHost(props: LowSheetHostProps) {
  const { accountId, density, accounts, onOpenThread, onClose } = props;
  const hold = useHold(HOLD_SCOPE);
  const view = useView(
    { kind: 'lowBySender' as const, ...(accountId ? { accountId } : {}) },
    { holdIds: hold.heldIds },
  );
  const [armed, setArmed] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const cursorId = useSheetCursor(view, hold, useReturnRestore(RETURN_KEY));
  // More low-importance threads than one window: the window follows the cursor, so every thread can be reached.
  useFollowWindow(view, cursorId ?? null, hold.isHeld);
  const rowProps = (row: ThreadRow): ListRowProps =>
    listRowProps(row, {
      domId: lowDomId(row.id),
      layout: 'list',
      density,
      cursor: row.id === cursorId,
      accounts,
      handlers: {
        onSelect: () => undefined,
        onOpen: () => onOpenThread(row.id),
        onAction: () => undefined,
      },
    });
  const groups = groupsOf(view, row => ({ ...rowProps(row), hoverActions: [] }));

  const markAll = () => {
    if (!view.state) return;
    const { opId, receipt } = api.thread.act({
      selector: { spec: { kind: 'homeSection', section: 'low', accountId }, atState: view.state },
      action: { type: 'done' },
    });
    pushToast({
      id: opId,
      kind: 'done',
      message: 'Done',
      undoable: true,
      actions: [UNDO_ACTION],
      onAction: undoHandler(opId),
    });
    receipt.catch(() => dismissToast(opId));
    onClose();
  };

  const hovered = hover === null ? undefined : view.rows.get(hover.replace(/^home-low-row-/, ''));
  return (
    <LowSheet
      open
      binding={{
        id: BINDING_ID,
        label: 'Low importance',
        activeDescendantId: cursorId ? lowDomId(cursorId) : undefined,
      }}
      groups={groups}
      total={view.total}
      armed={armed}
      markAllCommandId="lowImportance.markAllDone"
      preview={
        hovered ? { rowId: hover ?? '', text: hovered.snippet || primaryOf(hovered) } : undefined
      }
      onPreview={setHover}
      onArm={() => setArmed(true)}
      onCommitAll={markAll}
      onClose={() => (armed ? setArmed(false) : onClose())}
    />
  );
}
