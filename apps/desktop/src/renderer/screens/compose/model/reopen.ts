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
