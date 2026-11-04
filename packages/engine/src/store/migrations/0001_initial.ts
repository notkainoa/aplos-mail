import type { Migration } from '../migrate';

/*
 * `mail.db` schema 0001: ARCH 3.2 plus the Providers review (port proposal section 7, S1-S11) and the change log keyed
 * for several rows per commit. Frozen with F4: never edit these statements after they ship; add 0002 instead (the
 * checksum row refuses an edited history). One line per table says who writes it; `SCHEMA.md` documents every coded
 * column (bits, enums, JSON shapes) and the provider each serves, kept out of the bundle's budget.
 *
 * Conventions: every table is STRICT; booleans are INTEGER 0/1; times are epoch ms; remote ids are TEXT so Gmail,
 * Graph, IMAP, JMAP and CalDAV ids all fit; internal rowids never leave the engine (contract ids are
 * `accountId:remoteId`, ARCH 3.1); JSON columns end in `_json` or are listed in SCHEMA.md.
 */
const statements: string[] = [
  // eng-store: db_epoch, seq, change_floor_seq, install_salt, created_at, import state (text values).
  `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
  // eng-store, in every commit: the change log windows read; several rows share one commit's seq (ARCH 3.5).
  `CREATE TABLE changes(seq INTEGER NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL,
op TEXT NOT NULL CHECK(op IN ('u','d','*')), PRIMARY KEY(seq, type, id)) STRICT, WITHOUT ROWID`,
  `CREATE INDEX changes_type ON changes(type, seq)`,
  // eng-store: applied opIds, so a replayed commit is a no-op and a receipt can name its seq.
  `CREATE TABLE commits(op_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, origin TEXT NOT NULL, at INTEGER NOT NULL) STRICT`,
  `CREATE INDEX commits_seq ON commits(seq)`,
  // prov-gov / prov-gmail: one row per mailbox with status, grant facts (S1-S4) and the baseline marker (AM-4).
  `CREATE TABLE accounts(id TEXT PRIMARY KEY, provider TEXT NOT NULL, address TEXT NOT NULL, display_name TEXT,
capabilities TEXT NOT NULL, granted_scopes TEXT,
status TEXT NOT NULL, status_reason TEXT, status_reason_code TEXT, status_detail TEXT, resume_at INTEGER,
baseline_done_at INTEGER, token_granted_at INTEGER, refresh_expires_at INTEGER, remote_subject TEXT, oauth_client TEXT,
ai_allowed INTEGER NOT NULL DEFAULT 0, primary_lease_until INTEGER, primary_lease_device TEXT,
settings TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT`,
  // prov-gmail (labels.list), later prov-imap/jmap/graph: labels and folders in one table.
  `CREATE TABLE folders(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE,
remote_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT, kind TEXT NOT NULL, sync_scope TEXT NOT NULL DEFAULT 'lazy',
uidvalidity INTEGER, hidden INTEGER NOT NULL DEFAULT 0, UNIQUE(account_id, remote_id)) STRICT`,
  // eng-store: one row per conversation; rollups are a SQL aggregate over its messages, never from a batch.
  `CREATE TABLE threads(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE,
remote_id TEXT NOT NULL, subject TEXT, snippet TEXT, participants TEXT,
first_date INTEGER, last_date INTEGER NOT NULL, last_inbound_date INTEGER,
msg_count INTEGER NOT NULL, unread_count INTEGER NOT NULL, flagged INTEGER NOT NULL, has_attach INTEGER NOT NULL,
complete INTEGER NOT NULL DEFAULT 0, remote_count INTEGER, list_unsub TEXT, rev INTEGER NOT NULL,
UNIQUE(account_id, remote_id)) STRICT`,
  // eng-store from prov-* facts: body-free message rows; id is date-ordered, seconds * 4096 + n (ARCH 3.1).
  `CREATE TABLE messages(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL,
thread_id INTEGER NOT NULL REFERENCES threads ON DELETE CASCADE, remote_id TEXT NOT NULL,
internet_id TEXT, in_reply_to TEXT, refs TEXT, from_addr TEXT, from_name TEXT,
to_json TEXT, cc_json TEXT, bcc_json TEXT, reply_to TEXT, subject TEXT, snippet TEXT,
date INTEGER NOT NULL, internal_date INTEGER NOT NULL, size INTEGER,
flags INTEGER NOT NULL DEFAULT 0, hdr INTEGER NOT NULL DEFAULT 0, list_unsub TEXT, parts INTEGER NOT NULL DEFAULT 1,
origin TEXT NOT NULL DEFAULT 'sync', first_seen_seq INTEGER NOT NULL, last_read_at INTEGER, rev INTEGER NOT NULL,
local_seq INTEGER, UNIQUE(account_id, remote_id)) STRICT`,
  `CREATE INDEX messages_thread ON messages(thread_id, id)`,
  `CREATE INDEX messages_iid ON messages(account_id, internet_id)`,
  `CREATE INDEX messages_unindexed ON messages(id) WHERE (parts & 8) = 0`,
  // eng-store: Gmail labels and IMAP/JMAP/Graph placements per message (uid, S7 seen_gen).
  `CREATE TABLE message_folders(message_id INTEGER NOT NULL REFERENCES messages ON DELETE CASCADE,
folder_id INTEGER NOT NULL REFERENCES folders ON DELETE CASCADE, uid INTEGER, seen_gen INTEGER,
PRIMARY KEY(message_id, folder_id)) STRICT, WITHOUT ROWID`,
  `CREATE INDEX mf_folder ON message_folders(folder_id, uid)`,
  `CREATE UNIQUE INDEX mf_uid ON message_folders(folder_id, uid) WHERE uid IS NOT NULL`,
  // eng-store, derived per commit: keyset folder lists and unread counts; Trash/Spam count only there (D8).
  `CREATE TABLE thread_folders(folder_id INTEGER NOT NULL REFERENCES folders ON DELETE CASCADE, last_date INTEGER NOT NULL,
thread_id INTEGER NOT NULL REFERENCES threads ON DELETE CASCADE, unread INTEGER NOT NULL,
PRIMARY KEY(folder_id, last_date, thread_id)) STRICT, WITHOUT ROWID`,
  `CREATE INDEX tf_thread ON thread_folders(thread_id)`,
  `CREATE INDEX tf_unread ON thread_folders(folder_id) WHERE unread > 0`,
  // eng-store (open, prefetch): the provider-original body record, compressed, sanitized on read (ARCH 3.3).
  `CREATE TABLE bodies(message_id INTEGER PRIMARY KEY REFERENCES messages ON DELETE CASCADE,
codec INTEGER NOT NULL, raw_size INTEGER NOT NULL, data BLOB NOT NULL) STRICT`,
  // eng-store: attachment metadata; bytes live in attachments/.noindex/, never in the row.
  `CREATE TABLE attachments(id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages ON DELETE CASCADE,
remote_part TEXT NOT NULL, name TEXT, mime TEXT, size INTEGER, cid TEXT, inline INTEGER NOT NULL, path TEXT,
state TEXT NOT NULL, UNIQUE(message_id, remote_part)) STRICT`,
  // eng-store (paced FTS job): contentless index, rowid = messages.id (ARCH 3.4).
  `CREATE VIRTUAL TABLE messages_fts USING fts5(subject, people, body, content='', contentless_delete=1,
tokenize='unicode61 remove_diacritics 2')`,
  // eng-store at ingest, eng-ai reads: who each account writes to and hears from (Home, Contact/suggest); per account so
  // suggestions filter by account and a removed account's addresses go with it (R2G-3).
  `CREATE TABLE correspondents(account_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE, address TEXT NOT NULL,
name TEXT, sent_to INTEGER NOT NULL DEFAULT 0, received_from INTEGER NOT NULL DEFAULT 0, last_sent_at INTEGER,
PRIMARY KEY(account_id, address)) STRICT, WITHOUT ROWID`,
  // eng-views, eng-ai, eng-time, prov-gmail (workflow channel): triage state, Later, reminders, lanes.
  `CREATE TABLE thread_workflow(thread_id INTEGER PRIMARY KEY REFERENCES threads ON DELETE CASCADE,
account_id TEXT NOT NULL, sync_key TEXT NOT NULL, status TEXT NOT NULL,
later_until INTEGER, due_date TEXT, due_source TEXT, reminder_at INTEGER, reminder_fired_at INTEGER,
bookmarked INTEGER, reply_status TEXT, todo TEXT, hidden_from_home INTEGER,
lane TEXT NOT NULL DEFAULT 'do', importance TEXT NOT NULL DEFAULT 'normal',
rank_source TEXT NOT NULL DEFAULT 'heuristic', ranked_at INTEGER, due_band INTEGER NOT NULL DEFAULT 3,
last_date INTEGER NOT NULL, edited_at INTEGER, edit_device TEXT, edit_gen INTEGER) STRICT`,
  `CREATE INDEX home ON thread_workflow(status, lane, due_band, importance, due_date, last_date DESC, thread_id)`,
  `CREATE INDEX wf_status ON thread_workflow(status, last_date DESC, thread_id)`,
  `CREATE INDEX wf_later ON thread_workflow(later_until, thread_id) WHERE status = 'later'`,
  `CREATE INDEX timers_wf ON thread_workflow(reminder_at) WHERE reminder_at IS NOT NULL AND reminder_fired_at IS NULL`,
  // eng-ai: one summary per thread input hash.
  `CREATE TABLE summaries(thread_id INTEGER NOT NULL REFERENCES threads ON DELETE CASCADE, input_hash TEXT NOT NULL,
model TEXT NOT NULL, text TEXT NOT NULL, action TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL,
PRIMARY KEY(thread_id, input_hash)) STRICT`,
  // eng-views (Settings), prov-gmail-write (filters): block and skip-Inbox rules.
  `CREATE TABLE sender_rules(id INTEGER PRIMARY KEY, account_id TEXT REFERENCES accounts ON DELETE CASCADE,
address_or_domain TEXT NOT NULL, action TEXT NOT NULL, remote_filter_id TEXT) STRICT`,
  // eng-ai (Ask): conversation history, imported unchanged.
  `CREATE TABLE conversations(id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL) STRICT`,
  // eng-contract (Settings/*): the owner's settings document.
  `CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL) STRICT`,
  // eng-views enqueues, prov-gov drains: provider writes whose local effect is replayed over sync until done (ARCH 4.3).
  `CREATE TABLE ops(seq INTEGER PRIMARY KEY, op_id TEXT NOT NULL UNIQUE,
account_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE, kind TEXT NOT NULL, target TEXT NOT NULL,
payload TEXT NOT NULL, base TEXT, effect TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER,
last_error TEXT, created_seq INTEGER NOT NULL, scope TEXT NOT NULL) STRICT`,
  `CREATE INDEX ops_queue ON ops(account_id, state, seq)`,
  // eng-time, prov-gmail-write: local drafts with revisions; S10 origin marks phone drafts (D9).
  `CREATE TABLE drafts(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE,
thread_id INTEGER REFERENCES threads ON DELETE SET NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
remote_draft_id TEXT, remote_message_id TEXT, remote_internet_id TEXT, synced_revision INTEGER,
origin TEXT NOT NULL DEFAULT 'local',
updated_at INTEGER NOT NULL) STRICT`,
  `CREATE INDEX drafts_account ON drafts(account_id, updated_at)`,
  // eng-time: the outbox state machine; undo send and send later share not_before (ARCH 7.1-7.3). Both waiting states,
  // `queued` (undo window) and `scheduled` (send later), are in sub_due, so the timer and the overdue rule see both (FR-2).
  `CREATE TABLE submissions(id TEXT PRIMARY KEY, draft_id TEXT NOT NULL,
account_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE, internet_id TEXT NOT NULL, mime BLOB,
not_before INTEGER NOT NULL, state TEXT NOT NULL, attempt_at INTEGER, error TEXT, error_until INTEGER,
remote_message_id TEXT, remote_thread_id TEXT) STRICT`,
  `CREATE INDEX sub_due ON submissions(not_before) WHERE state IN ('queued', 'scheduled')`,
  // eng-ai: background AI work, one job per key, behind its own governor (ARCH 8).
  `CREATE TABLE jobs(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL UNIQUE, priority INTEGER NOT NULL,
payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
last_error TEXT) STRICT`,
  `CREATE INDEX jobs_due ON jobs(priority, next_at) WHERE state = 'queued'`,
  // eng-time, in the sync commit after the baseline: the durable notification outbox (ARCH 7.6).
  `CREATE TABLE notifications(message_id INTEGER PRIMARY KEY REFERENCES messages ON DELETE CASCADE,
state TEXT NOT NULL, created_at INTEGER NOT NULL, claimed_by TEXT) STRICT`,
  `CREATE INDEX notifications_pending ON notifications(created_at) WHERE state = 'pending'`,
  // prov-gmail / prov-cal via commit: resume tokens committed with the page they cover (ARCH 4.2).
  `CREATE TABLE sync_state(account_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE, scope TEXT NOT NULL,
cursor TEXT, page_token TEXT, phase TEXT, oldest_loaded INTEGER, generation INTEGER NOT NULL DEFAULT 0, pending TEXT,
updated_at INTEGER NOT NULL, PRIMARY KEY(account_id, scope)) STRICT`,
  // prov-gov: poison items quarantined instead of failing the run (ARCH 4.2 rule 7).
  `CREATE TABLE sync_failures(account_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE, item TEXT NOT NULL,
attempts INTEGER NOT NULL, next_retry_at INTEGER NOT NULL, last_reason TEXT, PRIMARY KEY(account_id, item)) STRICT`,
  // prov-gov, eng-ai: cooldowns, AIMD and blocks that survive a restart; account '*' is project-wide.
  `CREATE TABLE governor_state(account_id TEXT NOT NULL, budget TEXT NOT NULL,
target INTEGER, cooldown_until INTEGER, reason TEXT, daily_block_until INTEGER,
cooldown_step INTEGER NOT NULL DEFAULT 0, last_refusal_at INTEGER, cls TEXT, in_flight_limit INTEGER, batch_size INTEGER,
window_spent INTEGER, window_at INTEGER, send_blocked_until INTEGER, blocked_cls TEXT, blocked_since INTEGER,
updated_at INTEGER NOT NULL, PRIMARY KEY(account_id, budget)) STRICT`,
  // prov-*: small provider-owned key/values (IMAP indexes, Graph delta links).
  `CREATE TABLE provider_memory(account_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE, key TEXT NOT NULL,
value TEXT NOT NULL, PRIMARY KEY(account_id, key)) STRICT`,
  // eng-ai: requests and tokens per day, provider, model and lane (ARCH 8.4).
  `CREATE TABLE ai_usage(day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, lane TEXT NOT NULL,
requests INTEGER NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL,
PRIMARY KEY(day, provider, model, lane)) STRICT`,
  // eng-ai: versioned AI consent per scope; no job before it (ARCH 8.3).
  `CREATE TABLE consent(scope TEXT PRIMARY KEY, version INTEGER NOT NULL, provider TEXT, model TEXT, granted_at INTEGER) STRICT`,
  // prov-cal: the calendar list with selected, time zone and ctag (S6).
  `CREATE TABLE calendars(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE,
remote_id TEXT NOT NULL, name TEXT, color TEXT, is_primary INTEGER, hidden INTEGER, read_only INTEGER,
selected INTEGER NOT NULL DEFAULT 1, time_zone TEXT, change_tag TEXT, UNIQUE(account_id, remote_id)) STRICT`,
  // prov-cal: masters, overrides (S5 recurrence_id) and single events; expanded on query (ADR-20); seen_gen for the 410 sweep.
  `CREATE TABLE events(id INTEGER PRIMARY KEY, calendar_id INTEGER NOT NULL REFERENCES calendars ON DELETE CASCADE,
remote_id TEXT NOT NULL, recurrence_id TEXT NOT NULL DEFAULT '', master_remote_id TEXT,
status TEXT NOT NULL DEFAULT 'confirmed', etag TEXT, recurrence TEXT, start_utc INTEGER, end_utc INTEGER,
all_day INTEGER, data TEXT NOT NULL, ics TEXT, seen_gen INTEGER, UNIQUE(calendar_id, remote_id, recurrence_id)) STRICT`,
  `CREATE INDEX events_time ON events(calendar_id, start_utc)`,
  `CREATE INDEX events_master ON events(calendar_id, master_remote_id) WHERE master_remote_id IS NOT NULL`,
  // eng-store (`eventHidden`, Event/hide): Aplos-only hiding, never sent; '' hides the resource, else one occurrence.
  `CREATE TABLE event_hidden(calendar_id INTEGER NOT NULL REFERENCES calendars ON DELETE CASCADE, remote_id TEXT NOT NULL,
recurrence_id TEXT NOT NULL DEFAULT '', hidden_at INTEGER NOT NULL, PRIMARY KEY(calendar_id, remote_id, recurrence_id))
STRICT, WITHOUT ROWID`,
  // eng-host: paired CLI, MCP and phone clients; only a token hash is stored.
  `CREATE TABLE clients(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT NOT NULL,
scopes TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER) STRICT`,
  // eng-host: which client called which method on what; content-free.
  `CREATE TABLE audit_log(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, client_id TEXT NOT NULL, method TEXT NOT NULL,
target TEXT) STRICT`,
  `CREATE INDEX audit_at ON audit_log(at)`,
];

export const migration0001: Migration = {
  version: 1,
  name: 'initial',
  sql: statements.join(';\n') + ';\n',
};
