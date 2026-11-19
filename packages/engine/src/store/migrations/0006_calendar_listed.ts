import type { Migration } from '../migrate';

/*
 * `mail.db` schema 0006, additive (0001 to 0005 are frozen). `accounts.calendar_listed_at` is when the account's calendar
 * list was first committed (the `calendars` step of the sync actor, even when the list was empty): the UI tells "No
 * calendars" (listed, nothing there) from "Syncing…" (not listed yet) with it. `baseline_done_at` is the mail marker and
 * says nothing about calendars. NULL until the first list; rows from before 0006 stay NULL until their next list.
 */
const statements: string[] = [`ALTER TABLE accounts ADD COLUMN calendar_listed_at INTEGER`];

export const migration0006: Migration = {
  version: 6,
  name: 'calendar-listed',
  sql: statements.join(';\n') + ';\n',
};
