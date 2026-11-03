import type { CommitExtension, CommitExtensionTx } from '../store';
import { applyDraft, applyDraftDelete, applyRemoteDraft } from './draft-writes';
import { applyNotification, ingestNotifications } from './notifications';
import { applySubmission } from './store';

/**
 * Lane `eng-time`'s commit extension (seam 2): the writers for `submissions`, `drafts` and `notifications`, and the ingest hook that fills the last. Stateless, so one value
 * serves every store.
 */
function apply(write: { kind: string }, tx: CommitExtensionTx) {
  switch (write.kind) {
    case 'draft':
      return applyDraft(write, tx);
    case 'draftDelete':
      return applyDraftDelete(write, tx);
    case 'remoteDraft':
      return applyRemoteDraft(write, tx);
    case 'notification':
      return applyNotification(write, tx);
    default:
      return applySubmission(write, tx);
  }
}

/** Pass to `openStore({ extensions })`. */
export const outboxExtension: CommitExtension = {
  lane: 'eng-time',
  kinds: ['submission', 'draft', 'draftDelete', 'remoteDraft', 'notification'],
  changeTypes: ['Submission', 'Draft'],
  apply,
  ingest: ingestNotifications,
};
