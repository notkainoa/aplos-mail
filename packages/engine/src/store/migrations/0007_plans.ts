import type { Migration } from '../migrate';

/*
 * `mail.db` schema 0007, additive (0001 to 0006 are frozen). `plans` holds the dates and meetings AI finds in mail
 * (`Event/extract`, the `plan` job): proposals the owner confirms (`Plan/confirm` writes the event) or dismisses.
 * They are Aplos-side only — never written to the provider. `thread_id` cascades so a removed account or thread
 * takes its plans with it; `input_hash` keys a plan job's output to the thread content it read.
 */
const statements: string[] = [
  `CREATE TABLE plans(id INTEGER PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE,thread_id INTEGER NOT NULL REFERENCES threads ON DELETE CASCADE,input_hash TEXT NOT NULL,message_remote_id TEXT,from_name TEXT,quote TEXT,title TEXT NOT NULL,start_utc INTEGER,start_date TEXT,end_utc INTEGER,end_date TEXT,all_day INTEGER NOT NULL DEFAULT 0,time_zone TEXT,location TEXT,state TEXT NOT NULL DEFAULT 'open',event_id TEXT,op_id TEXT,calendar_id TEXT,model TEXT,rev INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL) STRICT`,
  `CREATE INDEX plans_thread ON plans(thread_id, state)`,
  `CREATE INDEX plans_state ON plans(state)`,
];

export const migration0007: Migration = {
  version: 7,
  name: 'plans',
  sql: statements.join(';\n') + ';\n',
};
