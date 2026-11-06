import type { Migration } from '../migrate';

/*
 * `mail.db` schema 0006, additive (0001 to 0004 are frozen). `accounts.calendar_listed_at` stamps the first
 * `calendars` list commit (the #356 engine request): the UI can then tell "No calendars" from "Syncing…" —
 * the stamp exists only after a list landed. Written once; later lists keep the first stamp.
 */
const statements: string[] = [`ALTER TABLE accounts ADD COLUMN calendar_listed_at INTEGER`];

export const migration0006: Migration = {
  version: 6,
  name: 'calendar-listed',
  sql: statements.join(';\n') + ';\n',
};
