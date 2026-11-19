import type { AppState, Settings, Thread } from '@aplos/contract/legacy/types';
import { liveAction } from '@aplos/contract/legacy/mailbox';
import type { SyncResult, ThreadFlags } from './provider';

type Status = Thread['status'];
type Mapping = Pick<Settings, 'doneAction' | 'laterAction'>;

/**
 * Combine the host's view of a thread with Aplos workflow state.
 * The host owns trash, spam and inbox membership; Aplos owns Done vs. merely read and Later.
 */
export function mergeStatus(
  local: Status,
  remote: ThreadFlags['status'],
  arrived: boolean,
  settings: Mapping,
): Status {
  if (remote === 'trash' || remote === 'spam') return remote;
  if (local === 'trash' || local === 'spam') return remote;
  if (local === 'new') return remote;
  if (arrived && remote === 'new') return 'new';
  // Back in the inbox without new mail: only meaningful when the triage action archives,
  // otherwise the inbox label is expected and the thread stays where the user put it.
  if (remote === 'new')
    return (local === 'done' ? settings.doneAction : settings.laterAction) === 'archive'
      ? 'new'
      : local;
  return local;
}

/** A message the user did not send that this device has not seen before. */
export function hasArrival(local: Thread, remote: Thread): boolean {
  const known = new Set(local.messages.map(m => m.id));
  return remote.messages.some(m => !m.sent && !known.has(m.id));
}

export interface MergeOutcome {
  /** Threads this device had never stored. */
  added: Thread[];
  /** Threads that gained a message from someone else, including added ones. */
  arrivals: Thread[];
}

/**
 * Apply one provider sync result to a mutable state snapshot. Threads in `pending` have local changes
 * the host has not received yet, so their host-owned flags stay as the user left them.
 */
export function applySync(
  state: AppState,
  accountId: string,
  result: SyncResult,
  pending: ReadonlySet<string> = new Set(),
): MergeOutcome {
  const blocked = (t: Thread) =>
    t.messages.some(m => state.blockedSenders.includes(m.from.toLowerCase()));
  const index = new Map(state.threads.map((t, i) => [t.id, i]));
  const outcome: MergeOutcome = { added: [], arrivals: [] };
  for (const remote of result.threads) {
    if (remote.accountId !== accountId) continue;
    if (blocked(remote)) remote.status = 'spam';
    const at = index.get(remote.id);
    if (at === undefined) {
      index.set(remote.id, state.threads.length);
      state.threads.push(remote);
      outcome.added.push(remote);
      if (remote.messages.some(m => !m.sent)) outcome.arrivals.push(remote);
      continue;
    }
    const old = state.threads[at],
      arrived = hasArrival(old, remote);
    if (pending.has(remote.id)) {
      state.threads[at] = {
        ...remote,
        status: arrived && remote.status === 'new' ? 'new' : old.status,
        unread: arrived ? remote.unread : old.unread,
        bookmarked: old.bookmarked,
        labels: old.labels,
        summary: old.summary || remote.summary,
        aiSummary: old.summary ? old.aiSummary : undefined,
        importance: old.importance,
        replyStatus: old.replyStatus,
        todo: old.todo,
        dueDate: old.dueDate,
        action: old.action,
        reminderAt: old.reminderAt,
        reminderFired: old.reminderFired,
        hiddenFromHome: arrived ? false : old.hiddenFromHome,
      };
      state.threads[at].action = liveAction(state.threads[at]);
      if (arrived) outcome.arrivals.push(state.threads[at]);
      continue;
    }
    state.threads[at] = {
      ...remote,
      status: mergeStatus(
        old.status,
        remote.status as ThreadFlags['status'],
        arrived,
        state.settings,
      ),
      summary: old.summary || remote.summary,
      aiSummary: old.summary ? old.aiSummary : undefined,
      importance: old.importance,
      replyStatus:
        arrived && old.replyStatus === 'awaiting-reply' ? 'needs-reply' : old.replyStatus,
      todo: old.todo,
      dueDate: old.dueDate,
      action: old.action,
      reminderAt: old.reminderAt,
      reminderFired: old.reminderFired,
      bookmarked: remote.bookmarked,
      hiddenFromHome: arrived ? false : old.hiddenFromHome,
    };
    state.threads[at].action = liveAction(state.threads[at]);
    if (arrived) outcome.arrivals.push(state.threads[at]);
  }
  for (const flags of result.flags) {
    const at = index.get(flags.id);
    if (at === undefined || pending.has(flags.id)) continue;
    const old = state.threads[at];
    state.threads[at] = {
      ...old,
      unread: flags.unread,
      bookmarked: flags.bookmarked,
      ...(flags.labels ? { labels: flags.labels } : {}),
      status: blocked(old) ? 'spam' : mergeStatus(old.status, flags.status, false, state.settings),
    };
  }
  if (result.removed.length) {
    const gone = new Set(result.removed);
    state.threads = state.threads.filter(t => t.accountId !== accountId || !gone.has(t.id));
  }
  return outcome;
}
