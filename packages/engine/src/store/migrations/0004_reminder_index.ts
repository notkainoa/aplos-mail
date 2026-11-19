import type { Migration } from '../migrate';

/*
 * `mail.db` schema 0004, additive (0001 to 0003 are frozen). The reminders deadline source and `Reminder/list` read
 * every thread with a reminder time, fired or not, newest first; `timers_wf` only covers the unfired ones
 * (`reminder_fired_at IS NULL`), so the fired-and-unacked read scanned all of `thread_workflow` at 100k threads.
 */
const statements: string[] = [
  `CREATE INDEX IF NOT EXISTS reminders_wf ON thread_workflow(reminder_at) WHERE reminder_at IS NOT NULL`,
];

export const migration0004: Migration = {
  version: 4,
  name: 'reminder-index',
  sql: statements.join(';\n') + ';\n',
};
