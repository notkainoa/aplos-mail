import type { Migration } from '../migrate';

/*
 * `mail.db` schema 0005, additive (0001 to 0004 are frozen). `messages.list_auth` keeps `ListHeaders.authenticated`
 * (RFC 8058 section 4): 1 when the provider verified a signature covering List-Unsubscribe and List-Unsubscribe-Post
 * aligned with From, 0 when it checked and that did not hold, NULL when unknown. Rows from before 0005 get NULL, which
 * `Unsubscribe/*` treats as not authenticated (no one-click, never preferred as the thread's target): fails safe.
 */
const statements: string[] = [
  `ALTER TABLE messages ADD COLUMN list_auth INTEGER CHECK (list_auth IN (0, 1))`,
];

export const migration0005: Migration = {
  version: 5,
  name: 'list-auth',
  sql: statements.join(';\n') + ';\n',
};
