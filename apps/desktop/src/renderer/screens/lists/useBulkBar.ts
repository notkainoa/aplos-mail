/**
 * The pane header's bulk bar (DESIGN 7.4): "3 selected · Done · Later · Trash · More · Esc" while rows are picked. Each
 * list names the verbs it owns, in order; the keycaps come from the registry through the command ids. More opens a
 * small menu (Bookmark, Select all). Pure tables plus one hook that hands the bar to the shell.
 */
import { useCallback, useMemo, useState } from 'react';
import type { CommandAction, MenuEntry } from '../../ui/props';
import { usePaneHeaderPart, type PaneHeaderPart } from '../../shell';
import type { ListActions } from './listActions';
import type { ListKind } from './listKinds';

/** One verb on the bar. */
interface BarVerb {
  readonly label: string;
  readonly commandId: string;
  readonly run: (actions: ListActions) => void;
}

const DONE: BarVerb = { label: 'Done', commandId: 'mail.done', run: a => a.done() };
const LATER: BarVerb = { label: 'Later', commandId: 'mail.later', run: a => a.later() };
const TRASH: BarVerb = { label: 'Trash', commandId: 'mail.trash', run: a => a.trash() };

const BAR_VERBS: Readonly<Record<ListKind, readonly BarVerb[]>> = {
  all: [DONE, LATER, TRASH],
  label: [DONE, LATER, TRASH],
  sent: [DONE, LATER, TRASH],
  bookmarks: [DONE, LATER, TRASH],
  later: [],
  trash: [{ label: 'Restore', commandId: 'mail.restore', run: a => a.restore() }],
  spam: [{ label: 'Not spam', commandId: 'mail.restore', run: a => a.restore() }],
  drafts: [{ ...TRASH, label: 'Discard' }],
  done: [{ label: 'Move to Home', commandId: 'done.moveToHome', run: a => a.moveToHome() }],
};

/** Kinds whose rows can be bookmarked from the bar's More menu. */
const BOOKMARK_KINDS: readonly ListKind[] = ['all', 'label', 'sent', 'bookmarks'];

/** The verbs of a list's bar as header actions. */
export function barActionsOf(kind: ListKind, actions: ListActions): readonly CommandAction[] {
  return BAR_VERBS[kind].map(verb => ({
    label: verb.label,
    commandId: verb.commandId,
    onSelect: () => verb.run(actions),
  }));
}

/** The More menu's rows. */
export function moreEntriesOf(kind: ListKind): readonly MenuEntry[] {
  const select: MenuEntry = { kind: 'item', id: 'selectAll', label: 'Select all' };
  if (!BOOKMARK_KINDS.includes(kind)) return [select];
  const bookmark: MenuEntry = { kind: 'item', id: 'bookmark', label: 'Bookmark', icon: 'bookmark' };
  return [
    { ...bookmark, commandId: 'mail.bookmark' },
    { ...select, commandId: 'list.selectAll' },
  ];
}

/** What `MailListView` needs to draw the More menu. */
export interface BulkMenu {
  readonly anchor: HTMLElement | null;
  readonly entries: readonly MenuEntry[];
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}

/** What the bar shows: the verbs, then the More menu's rows. */
export interface BulkBarPlan {
  readonly actions: readonly CommandAction[];
  readonly entries: readonly MenuEntry[];
}

/** What the bar's More menu and Esc call. A list's and Home's actions both have these. */
export interface BulkBarControls {
  bookmark(): void;
  selectAll(): void;
  clearSelection(): void;
}

/** Puts the bar in the pane header while `count` rows are picked, and returns the More menu. */
export function useBulkBarPart(
  plan: BulkBarPlan,
  controls: BulkBarControls,
  count: number | null,
): BulkMenu {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const onClose = useCallback(() => setAnchor(null), []);
  const part = useMemo<PaneHeaderPart | null>(
    () =>
      count === null
        ? null
        : {
            bulk: {
              count,
              actions: plan.actions,
              onMore: setAnchor,
              onClear: () => controls.clearSelection(),
            },
          },
    [plan.actions, controls, count],
  );
  usePaneHeaderPart(part);
  const onSelect = useCallback(
    (id: string) => {
      setAnchor(null);
      if (id === 'bookmark') controls.bookmark();
      else controls.selectAll();
    },
    [controls],
  );
  return { anchor: count === null ? null : anchor, entries: plan.entries, onSelect, onClose };
}

/** A list's bar: the verbs it owns for its kind. */
export function useBulkBar(kind: ListKind, actions: ListActions, count: number | null): BulkMenu {
  const plan = useMemo(
    () => ({ actions: barActionsOf(kind, actions), entries: moreEntriesOf(kind) }),
    [kind, actions],
  );
  return useBulkBarPart(plan, actions, count);
}
