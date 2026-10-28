/**
 * The Low importance sheet (DESIGN 7.2) on its data: the `lowBySender` view, one group per sender. Mounted only while
 * the sheet is open, so the window is watched only then. The first → arms and the second marks every thread done in
 * one operation (a selector over the section, at the state the owner saw), with one Undo toast.
 */
import { useEffect, useState } from 'react';
import type { Registry } from '../../commands';
import { api, useView } from '../../data';
import type { Account, AccountId, ThreadId, ThreadRow, ViewResult } from '../../data';
import { dismissToast, pushToast } from '../../shell';
import type { Density, ListRowProps, LowSheetGroup } from '../../ui/props';
import { LowSheet } from '../../ui/list';
import { listRowProps, primaryOf } from './homeRows';

const BINDING_ID = 'home-low-list';

/** Props for `LowSheetHost`. */
export interface LowSheetHostProps {
  readonly accountId?: AccountId;
  readonly density: Density;
  readonly accounts: readonly Account[];
  readonly registry: Registry;
  readonly onOpenThread: (id: ThreadId) => void;
  readonly onClose: () => void;
}

const lowDomId = (id: string): string => `home-low-row-${id}`;

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

function useSheetCursor(registry: Registry, ids: readonly string[]) {
  const [at, setAt] = useState(0);
  useEffect(() => {
    const step = (delta: 1 | -1) => setAt(i => Math.max(0, Math.min(ids.length - 1, i + delta)));
    const next = registry.attach('lowImportance.next', { run: () => step(1) });
    const previous = registry.attach('lowImportance.previous', { run: () => step(-1) });
    return () => {
      next();
      previous();
    };
  }, [registry, ids.length]);
  return ids[Math.min(at, ids.length - 1)];
}

/** The sheet over Home. */
export function LowSheetHost(props: LowSheetHostProps) {
  const { accountId, density, accounts, registry, onOpenThread, onClose } = props;
  const view = useView({ kind: 'lowBySender' as const, ...(accountId ? { accountId } : {}) });
  const [armed, setArmed] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const cursorId = useSheetCursor(registry, view.ids);
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
      actions: [{ id: 'undo', label: 'Undo', commandId: 'app.undo' }],
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
