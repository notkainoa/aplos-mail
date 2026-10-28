import type { Migration } from '../migrate';

/*
 * `mail.db` schema 0002 (eng-time, time-2): the columns the outbox needs for the contract's `Submission`, added to
 * `submissions` only. Append-only like 0001: never edit these statements after they ship. `sub_due` is unchanged.
 *
 * - `revision`: the draft revision this submission pins (FR-7), recorded at `send`.
 * - `queued_at`: when the send was queued; with `not_before` it sizes the undo tray's drain bar.
 * - `sent_at`: when the provider accepted it (`sent` only).
 * - `rev`: the store seq of the row's last change (`Submission.rev`).
 * - `check_count`, `check_at`: `findSent` checks made for an `uncertain` row, and when the next one is due (none: NULL).
 * - `meta`: JSON display and envelope fields fixed at `send` (`subject`, `toNames`, `threadId`, `envelope`, `opId`).
 * The existing `error` column holds the `Submission.problem` JSON and `error_until` its `until`.
 */
const statements: string[] = [
  `ALTER TABLE submissions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE submissions ADD COLUMN queued_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE submissions ADD COLUMN sent_at INTEGER`,
  `ALTER TABLE submissions ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE submissions ADD COLUMN check_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE submissions ADD COLUMN check_at INTEGER`,
  `ALTER TABLE submissions ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'`,
];

export const migration0002: Migration = {
  version: 2,
  name: 'outbox',
  sql: statements.join(';\n') + ';\n',
};
