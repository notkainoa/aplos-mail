# `mail.db` schema 0001

Source: `migrations/0001_initial.ts` (ARCH 3.2 plus the Providers review S1-S11). Frozen with F4: change it only by adding a migration. Every table is `STRICT`, booleans are 0/1, times are epoch ms, remote ids are `TEXT`. Internal integer rowids never leave the engine; contract ids are `accountId:remoteId`. Only `store.commit` writes the mailbox tables. Providers column: **G** Gmail, **GC** Google Calendar (round 1); **O** Outlook/Graph, **I** iCloud/generic IMAP, **F** Fastmail/JMAP, **D** CalDAV (round 2).

| Table | Writer lane | What it holds; columns that serve specific providers |
|---|---|---|
| `meta` | eng-store | `db_epoch` (UUID, changes only on create/reset/restore), `seq`, `change_floor_seq`, `install_salt`, `created_at`, `imported_from`, `import_state`, `consent_version` |
| `changes` | eng-store (every commit) | `(seq, type, id, op)`, key `(seq, type, id)`: one commit = one seq, many rows. `op` `u`/`d`, or `*` = "type changed in account `id`" (backfill pages) |
| `commits` | eng-store | applied `op_id` → `seq`: replays are no-ops; receipts |
| `accounts` | prov-gov, prov-gmail; eng-ai (`ai_allowed`) | `status*`/`resume_at` (AccountStatus); `baseline_done_at` (AM-4); `granted_scopes` (G, O); `token_granted_at`, `refresh_expires_at` (G reconnectBy, S1); `remote_subject` (G `sub`, O `oid`, S2); `primary_lease_*` (all, S3); `oauth_client` (G, O, S4) |
| `folders` | prov-gmail, later prov-imap/jmap/graph | `role` (`FolderRole`) inbox/sent/drafts/trash/spam/archive/starred/important/all, and `category.personal`/`social`/`promotions`/`updates`/`forums` (G tabs, read by `laneFor`); `kind` label (G) / folder (O, I, F) / system / unknown (placeholder); `uidvalidity` (I; a changed value clears the folder's `message_folders.uid` in the same commit, FR-31); `sync_scope` live/backfill/lazy/none |
| `threads` | eng-store (rollups) | `remote_id` = G threadId, O conversationId, F threadId, I THREADID or header root; `complete`; `remote_count` (the server's message count, G `threads.get`; `openThread`'s `knownCount`, never `msg_count`); `participants` JSON (6 senders); `rev` = seq of last change |
| `messages` | eng-store from prov-* facts | id = `internal_date_s × 4096 + n`; `remote_id` = G id, O immutable id, F Email id, I EMAILID or hash; `flags` 1 seen, 2 flagged, 4 answered (I, F), 8 draft, 16 from_me, 32 has_attach; `hdr` 1 bulk, 2 list, 4 auto_submitted, 8 noreply, 16 direct_to_me, 32 cc_me; `parts` 1 meta, 2 text, 4 html, 8 fts, 16 attach_listed, 32 evicted; `origin` sync/search/local; `local_seq` (mutation fence); `list_unsub` JSON `{urls, oneClick}` |
| `message_folders` | eng-store | G labels; O/I/F placements; `uid` (I, unique per folder); `seen_gen` (bounded sweep, all; S7): the generation (store `seq` at round start) of the last round that listed it; only rises; NULL = written outside a round, never swept. `sweep` removes `seen_gen < generation` inside `(since, until)` and the UID range |
| `thread_folders` | eng-store (derived) | keyset lists `(folder_id, last_date, thread_id)` and `unread`; Trash/Spam messages count only there (D8); drafts and `search` rows excluded |
| `bodies` | eng-store | provider-original record; `codec` 0 raw, 1 zstd-3, 2 gzip |
| `attachments` | eng-store | metadata only; `remote_part` (G attachmentId, I section, O/F blob id); `state` absent/fetching/present/evicted |
| `messages_fts` | eng-store (paced job) | contentless FTS5, `contentless_delete=1`, rowid = `messages.id` |
| `correspondents` | eng-store; eng-ai reads | heuristic Home and autocomplete |
| `thread_workflow` | eng-views, eng-ai, eng-time, prov-gmail (workflow channel) | `status` new/done/later; Later = snooze (`later_until`); reminders; `lane` do/update/low; `importance`; `rank_source`; `due_band` 0-3; `sync_key` (G thread id, I root Message-ID); `edit_*` for cross-device merge. Created with defaults with the thread |
| `summaries` | eng-ai | per `(thread, input_hash)` |
| `sender_rules` | eng-views, prov-gmail-write | `remote_filter_id` (G filter, O messageRule) |
| `conversations` | eng-ai | Ask history, imported unchanged |
| `settings` | eng-contract | one JSON document |
| `ops` | eng-views enqueue, prov-gov drain | per-account FIFO, replayed over sync until done |
| `drafts` | eng-time, prov-gmail-write | `remote_draft_id` (G, O, F), `remote_message_id` (I APPEND), `remote_internet_id` (the synced copy's per-revision Message-ID: I deletes the old copy by it without UIDPLUS), `origin` local/remote (S10) |
| `submissions` | eng-time | state machine; `internet_id` (findSent on all); `mime`; `remote_message_id`, `remote_thread_id` (S11) |
| `jobs`, `ai_usage`, `consent` | eng-ai | AI queue, budget and consent |
| `notifications` | eng-time | outbox per message: pending/posted/claimed |
| `sync_state` | prov-gmail, prov-cal | `scope` history / window:inbox / backfill:inbox / folder:<id> (I, O) / cal:<id> (GC, D); `cursor` (G historyId, O deltaLink, I `uidvalidity:modseq:uidnext`, F state, GC/D sync token); `page_token` (G, O nextLink, D 507 paging); `pending` (S9) |
| `sync_failures` | prov-gov | quarantined poison items |
| `governor_state` | prov-gov, eng-ai | `budget` gmail/gcal/graph/imap/imapBytes/jmap/caldav/oauth/ai:*; S8 escalation, AIMD, sliding window, send and auth blocks (`blocked_cls`, `blocked_since`); an auth block is written to every budget of the account; `account_id='*'` project-wide (G daily limit) |
| `provider_memory` | prov-* | small key/values (I indexes, O delta links) |
| `calendars` | prov-cal | `selected`, `time_zone` (GC, D), `change_tag` (D ctag) (S6) |
| `events` | prov-cal | unique `(calendar_id, remote_id, recurrence_id)`; `recurrence_id` '' for masters (GC originalStartTime, D RECURRENCE-ID); `master_remote_id` (GC recurringEventId, D UID); `status` incl. cancelled; `etag` (GC, D, O); `ics` (D) (S5); `seen_gen` (the 410 / resync sweep, as `message_folders`) |
| `clients`, `audit_log` | eng-host | listener clients (token hash only) and a content-free audit |
| `schema_migrations` | migrate.ts | version, name, checksum: catches an edited shipped migration |

**Indexes for the views at 100k threads.** Inbox and labels: `thread_folders` primary key, reverse scan; unread counts: `tf_unread`. Home: `home`. Done and New by date: `wf_status`. Later and its timer: `wf_later`. Reminders: `timers_wf`. Search: FTS rowid order (date-ordered ids), then `messages` by primary key. A thread's messages: `messages_thread`. Send reconciliation: `messages_iid`. IMAP by UID: `mf_uid`. Paced FTS backlog: `messages_unindexed`.

**Deliberate differences from ARCH 3.2.** `changes` keyed `(seq, type, id)` because one commit writes many rows under one seq. `commits` and `messages.local_seq` are new (idempotency, mutation fence). `events.master_id` became `master_remote_id` (an override can arrive before its master). Foreign keys cascade from accounts, threads, messages and folders so a delete is one statement (FTS rows are removed explicitly). `messages.bcc_json` and flag bit 32 (`has_attach`) were added for sent mail and the thread rollup.
