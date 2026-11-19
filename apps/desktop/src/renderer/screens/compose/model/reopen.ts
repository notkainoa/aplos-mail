/**
 * Finding a thread's reply again after a reload (lane card criterion 5): the reader mounts the inline reply host on a
 * thread, and the host looks for a send of a reply in that thread first (the `scheduled` view: live submissions), then
 * for a local reply draft (the `drafts` view, newest first). The engine's rows decide; nothing is kept locally.
 */
import type { Draft, Submission } from '../../../data';
import { isLiveSubmission } from './sendState';

const REPLY_MODES = new Set(['reply', 'replyAll']);

/** The draft id the inline reply on `threadId` should open, or null for a fresh reply. */
export function replyDraftFor(
  threadId: string,
  drafts: readonly Draft[],
  submissions: readonly Submission[],
): string | null {
  const sending = submissions.find(s => s.threadId === threadId && isLiveSubmission(s));
  if (sending) return sending.draftId;
  const mine = drafts
    .filter(d => d.threadId === threadId && d.origin !== 'remote' && REPLY_MODES.has(d.mode))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return mine[0]?.id ?? null;
}

/**
 * A watched window whose rows have all arrived. A view lists an id before its row is fetched, so "live" alone can mean
 * "live and still empty": a reply that looked for its draft then would start blank and leave the saved draft behind.
 */
export function rowsResolved(view: {
  readonly status: string;
  readonly ids: readonly string[];
  readonly rows: ReadonlyMap<string, unknown>;
}): boolean {
  // A failed window reads as empty (a fresh reply), so the host never waits forever.
  if (view.status === 'failed') return true;
  return view.status === 'live' && view.ids.every(id => view.rows.has(id));
}
