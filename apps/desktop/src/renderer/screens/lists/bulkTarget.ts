/**
 * What a bulk action sends (DESIGN 7.4): the picked ids while they fit in the window, a `ThreadSelector` over
 * the whole view once ⌘A reaches past it. The engine resolves a selector at `atState`, the state the owner
 * saw, so mail that arrived since is not swept up.
 */
import type { State, ThreadListSelector, ThreadListSpec } from '../../data';

/** A `Thread/act` target: named ids, or a selector the engine resolves over the whole view. */
export type BulkTarget =
  { readonly ids: readonly string[] } | { readonly selector: ThreadListSelector };

/** What the picker knows about the view it sits on. */
export interface BulkScope {
  /** Ids the window holds: at most one window of the view. */
  readonly loadedIds: readonly string[];
  /** Rows in the whole view. */
  readonly total: number;
  /** The view's spec; null when the view cannot be selected whole. */
  readonly spec: ThreadListSpec | null;
  /** `view.state`, passed to the selector as `atState`; null while the view is opening. */
  readonly state: State | null;
  /** The owner pressed ⌘A. */
  readonly allPicked: boolean;
}

/**
 * The selector when ⌘A reached past the window: every loaded row is picked and the view holds more, over a
 * spec the engine can resolve. Otherwise null and the action names the picked ids one by one.
 */
function wholeViewSelector(
  args: BulkScope & { readonly count: number },
): ThreadListSelector | null {
  if (!args.allPicked || args.spec === null || args.state === null) return null;
  if (args.total <= args.loadedIds.length || args.count !== args.loadedIds.length) return null;
  return { spec: args.spec, atState: args.state };
}

/**
 * The target of a bulk action: `{selector}` for the whole view, else `{ids}` — the picked ids in list order,
 * exactly what the owner saw picked.
 */
export function bulkTargetOf(args: BulkScope & { readonly picked: readonly string[] }): BulkTarget {
  const selector = wholeViewSelector({ ...args, count: args.picked.length });
  return selector === null ? { ids: args.picked } : { selector };
}

/** The number the bar and the toast report: the view's `total` for a selector, else the picked count. */
export function bulkCount(args: BulkScope & { readonly count: number }): number {
  return wholeViewSelector(args) === null ? args.count : args.total;
}

const BULK_VERB = {
  done: 'Done',
  later: 'Moved to Later',
  trash: 'Moved to Trash',
} as const;

/** The toast after a bulk action: "Done · 3 emails", "Moved to Later · 1 email". */
export function bulkMessage(verb: keyof typeof BULK_VERB, count: number): string {
  const emails = count === 1 ? '1 email' : `${count} emails`;
  return `${BULK_VERB[verb]} · ${emails}`;
}
