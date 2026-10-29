import type { Migration } from '../migrate';

/*
 * `mail.db` schema 0003, additive (0001 and 0002 are frozen). `Account/set` and `Account/disconnect` need:
 * - `accounts.color_tag`: the owner's colour token (`Account.colorTag`); NULL means the stable hash colour.
 * - `accounts.notifications`: the per-account switch (`Account.notifications`), on for every existing account.
 * - `file_removals`: attachment files whose rows an `accountRemove` deleted. The host removes each file (the neutral
 *   engine has no `node:fs`) and then commits `fileRemoved`, which drops the queue row.
 * `accounts.settings` (JSON, default '{}') already exists from 0001.
 */
const statements: string[] = [
  `ALTER TABLE accounts ADD COLUMN color_tag TEXT`,
  `ALTER TABLE accounts ADD COLUMN notifications INTEGER NOT NULL DEFAULT 1`,
  `CREATE TABLE file_removals(path TEXT PRIMARY KEY, queued_at INTEGER NOT NULL) STRICT, WITHOUT ROWID`,
];

export const migration0003: Migration = {
  version: 3,
  name: 'account-settings',
  sql: statements.join(';\n') + ';\n',
};
