import type { Migration } from '../migrate';

/*
 * `mail.db` schema 0002, additive (0001 is frozen). The pinned-revision rule (ARCH 7.1, freeze FR-7 and round 3) needs
 * two facts the outbox compares before it puts a precondition on `SubmissionPayload`:
 * - `submissions.revision`: the draft revision a submission sends (`Submission.revision`). Rows from before 0002 get 0,
 *   which no `drafts.synced_revision` equals, so they send their pinned `mime` (fails safe).
 * - `drafts.remote_change_key`: the synced copy's change key (Graph `@odata.etag`/`changeKey`), the source of
 *   `SubmissionPayload.baseChangeKey` and `DraftUpload.baseChangeKey`. Written with `synced_revision`, cleared with it.
 * Plus the two lookups `KnownLookup` runs on every Drafts delta (`trackedDraftIds`, `draftsByMessageId`, FR-26).
 */
const statements: string[] = [
  `ALTER TABLE submissions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE drafts ADD COLUMN remote_change_key TEXT`,
  `CREATE INDEX drafts_remote_draft ON drafts(account_id, remote_draft_id) WHERE remote_draft_id IS NOT NULL`,
  `CREATE INDEX drafts_remote_message ON drafts(account_id, remote_message_id) WHERE remote_message_id IS NOT NULL`,
];

export const migration0002: Migration = {
  version: 2,
  name: 'drafts-sync',
  sql: statements.join(';\n') + ';\n',
};
