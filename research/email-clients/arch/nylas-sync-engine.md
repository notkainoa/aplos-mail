# Nylas Sync Engine: architecture audit for the Aplos revamp

2026-10-25. Shallow clone of `https://github.com/nylas/sync-engine` at `5069899`, stored in `/Users/knewton/.t3/aplos-research/src/sync-engine`. Unless noted otherwise, paths are relative to that directory. I read files only. Nothing was installed, built or run. The code is **AGPL-3.0**, so this report describes ideas in my own words and quotes no more than a line at a time. Nothing from it should be copied into Aplos.

Labels: **Verified** means I read it in the code or got it from `gh api`. **Inference** means my own reasoning. **Background** means outside knowledge I did not check.

---

## 1. Overview

**What it is.** A multi-tenant, server-side email sync platform. It keeps a full copy of each connected mailbox in MySQL plus a blob store, and serves a REST API over that copy, including a **delta (change-feed) API**. It was the open-source core of the hosted Nylas API (README).

**License.** AGPL-3.0 (`LICENSE`, GitHub `spdx_id`). Contributors had to sign a CLA.

**Maturity and activity (verified with `gh api`).**
- Created 2014-01-15. 4,396 commits.
- The last code release is 17.3.8, dated 2017-03-08 (`setup.py:8`). The only commit since then is the 2026-06-25 README archive notice.
- Archived. 3,493 stars, 344 forks, 69 open issues, about 80 contributors.
- Four people wrote most of it: emfree 1,021 commits, spang 999, grinich 706, kav-ya 491.
- Stack: Python 2.7, gevent, a forked SQLAlchemy, MySQL, Redis, Flask 0.10, and pinned forks of imapclient and flanker (`requirements.txt`). Treat it as a design document. It isn't a usable dependency.

**Target user.** Developers building on email, plus self-hosters. The OSS build is explicitly developer-grade:
- The API has no authentication.
- Secrets are stored unencrypted by default (README "Security"; `etc/config-dev.json` sets `ENCRYPT_SECRETS: false`).
- Exchange ActiveSync was hosted-only. The OSS tree has only traces of it.

**The lineage is the most relevant fact for Aplos (verified by listing the GitHub repos, not read in depth).**
- Nylas later built `nylas/nylas-mail` (MIT, archived, about 24.7k stars). Its `packages/client-sync` contains:
  - `local-api`: a Hapi HTTP server on a localhost port with per-account token Basic auth. Its routes cover threads, messages, drafts, send, files, categories, contacts, events and calendars.
  - `local-sync-worker`, with sync, syncback and send task runners.
  - `local-sync-delta-emitter`.
- Its `packages/cloud-workers` held only `send-later`, `send-reminders` and `snooze`.
- Mailspring forked Nylas Mail and rewrote the sync engine in C++ (`Foundry376/Mailspring-Sync`, GPL-3.0, active).

So the team that built this server engine moved sync onto the desktop, behind a **local server with the same API shape**. They kept a thin cloud only for jobs that must run while the laptop sleeps. That is almost exactly what the Aplos owner is considering.

---

## 2. Feature inventory

| Feature | Evidence | Maturity |
|---|---|---|
| Generic IMAP sync (folders, flags, expunge, UIDVALIDITY) | `inbox/mailsync/backends/imap/generic.py` | Production-hardened |
| Gmail over IMAP plus X-GM-MSGID, X-GM-THRID and X-GM-LABELS | `mailsync/backends/gmail.py`, `inbox/crispin.py` | Production-hardened |
| CONDSTORE flag sync; IDLE on the inbox only | `generic.py:95-110, 640-706` | Mature. No QRESYNC. |
| Outlook.com over IMAP with OAuth | `models/backends/outlook.py` | Thin |
| Exchange/EAS | README | Absent from OSS |
| Provider autodetect (about 30 presets by domain, MX and NS, with folder maps) | `inbox/providers.py` | Mature |
| Localized folder-role detection | `inbox/folder_edge_cases.py` | Mature, hand-curated |
| SMTP send with error classification | `sendmail/smtp/postel.py`, `smtp/util.py` | Mature |
| Versioned draft sync to IMAP Drafts; Sent-folder APPEND | `actions/base.py`, `actions/backends/generic.py` | Mature |
| Folder and label create, rename, delete | `actions/backends/*.py` | Mature |
| Delta API: poll, long-poll, streaming | `transactions/delta_sync.py`, `api/ns_api.py:1720-1915` | Mature. This is the core idea. |
| Search delegated to the provider | `inbox/search/backends/` | Basic |
| Contacts: Google gdata (dead), iCloud CardDAV, harvested from mail; rankings and groups | `inbox/contacts/` | Dated or experimental |
| Google Calendar, iCal invite import, RSVP, recurrence | `inbox/events/` | Moderate |
| App metadata attached to any object, carried in deltas | `models/metadata.py` | Read side only in OSS (Inference: writes were hosted-only) |
| Multi-send; tracking | `ns_api.py` | Multi-send works. Tracking returns 501 in OSS. |
| Rules, unsubscribe, snooze, send-later, AI | — | Absent |
| Fleet operations (shards, migration, throttling, heartbeats, GC) | `bin/`, `inbox/scheduling/`, `inbox/heartbeat/` | Mature, cloud-only |

---

## 3. Architecture deep dive

### 3a. Process and deployment topology (verified)

**Mail sync processes** (`bin/inbox-start`, `inbox/mailsync/service.py`).
- Each host runs N processes, each a single gevent loop holding at most 150 accounts (`MAX_ACCOUNTS_PER_PROCESS`).
- Inside a process: one monitor greenlet per account, one `FolderSyncEngine` greenlet per synced folder, plus a delete handler, contacts sync and events sync.
- Each process embeds a Flask introspection server on `0.0.0.0:16384+N` with `/profile`, `/load` and `/mem` (`mailsync/frontend.py`). It runs on a real OS thread so it still answers when a greenlet is stuck.

**Syncback service** (`bin/syncback-service`, `transactions/actions.py`). It executes queued remote writes for its assigned database shards.

**API server** (`bin/inbox-api`, `api/srv.py`, `api/ns_api.py`). Flask on port 5555.

**State.**
- Sharded MySQL. Row IDs encode the shard (`ignition.py`, `util/sharding.py`).
- Redis holds the account-scheduling queues and per-folder heartbeats.
- A content-addressed blockstore lives on local disk or S3.

**Account placement.**
- `account.sync_host` and `desired_sync_host` record which process owns an account.
- Processes re-poll every 5-20 s and listen on Redis queues.
- A process "steals" unassigned accounts only while its event-loop backlog stays under a threshold (`service.py:130-160`).

**The key split.**
- The API never reads from IMAP. Reads come from MySQL.
- Every write becomes an `actionlog` row that syncback executes later.
- Only send and search call the provider synchronously (the `before_remote_request` docstring in `ns_api.py`).

This read-local, write-via-queue split is the most transferable structural idea.

### 3b. Connectivity per provider

**Gmail (verified).**
- Mail travels over **IMAP plus XOAUTH2**, not the Gmail REST API. Sending uses SMTP plus XOAUTH2.
- REST is used only to re-fetch a raw message by hex message ID (`s3/backends/gmail.py`) and for server search (`search/backends/gmail.py`).
- Calendar uses Calendar v3. Contacts used the long-dead gdata feed.
- Scopes are the full `https://mail.google.com/` plus calendar, contacts and userinfo (`auth/gmail.py:34-40`).
- Auth is the out-of-band `urn:ietf:wg:oauth:2.0:oob` paste-the-code flow. Google has since retired it (Background).
- Gmail sync needs "Show in IMAP" enabled for All Mail. Without it the engine raises a clear `GmailSettingError` (`crispin.py`).

**The credential model is worth studying (verified).**
- A Gmail account can hold several `GmailAuthCredentials`, each with its own `client_id`, refresh-token secret, `scopes` and `is_valid` flag.
- `new_token(scope)` picks a valid credential that covers the scope it needs. `invalid_grant` marks only that credential invalid (`models/backends/gmail.py`).
- `Account.mark_invalid(scope=…)` turns off events sync for a calendar-scope failure, and turns off mail only for a mail-scope failure (`models/account.py`).
- On IMAP `AUTHENTICATIONFAILED`, the engine force-refreshes the token once, then reports "IMAP disabled" instead of "bad password". Workspace "IMAP disabled for domain" is reported as a distinct reason (`auth/gmail.py`).

**Outlook.com.** IMAP with Microsoft Live OAuth, modeled as folders (`models/backends/outlook.py`).

**Generic IMAP and SMTP.**
- Password auth, with presets for host and port, `folder_map` (for example iCloud's "Sent Messages"), `condstore` hints, and detection by domain, MX or NS (`providers.py`).
- Servers that require an app password (such as QQ) are recognized from their error text.
- "Invalid credentials" is told apart from a temporary failure by matching about 20 server error prefixes (`auth/generic.py`).

**TLS verification is off (verified, a serious flaw).** `create_default_context()` in `auth/generic.py:393-410` sets `CERT_NONE` and turns hostname checking off for every IMAP connection. Anyone on the network path could capture passwords and tokens.

**Token storage.**
- Secrets live in a `secret` table. With `ENCRYPT_SECRETS` on, they're sealed with NaCl SecretBox under **one static key from config** (`security/oracles.py`, `models/secret.py`).
- A key-version field exists but is always 0, so keys can't be rotated (`security/blobstorage.py`).
- OAuth client IDs and secrets sit in plaintext columns next to a `STOPSHIP` comment.

### 3c. Sync algorithm

**Per-folder state machine (verified, `generic.py:35-49, 201-251`).**
- States run `initial` → `poll`, with "uidinvalid" side states. The current state is saved in `imapfoldersyncstatus.state`.
- Handlers are idempotent, so a crash between a handler and its state commit is harmless.
- After more than 5 UIDVALIDITY resyncs in a row, the engine disables the account so it can't loop forever.

**Initial sync, generic IMAP (verified, `generic.py:334-380`).**
1. SELECT the folder and store UIDVALIDITY and UIDNEXT.
2. `UID SEARCH ALL` gives the remote set. Delete local UIDs that are no longer remote. New = remote minus local.
3. **Start a change-poller greenlet alongside the backfill**, so new mail keeps arriving during a long first sync.
4. Download newest first, **one full RFC 822 message per round trip, committing after every message.**
5. An operator can set a "throttled" flag, which slows a folder to one message a minute after its first 200.

**Resume works by set difference.** There is no backfill cursor to lose. The committed `imapuid` rows *are* the checkpoint, and a restart simply recomputes remote minus local.

**One backfill per account at a time.** The monitor starts folders inbox-first and waits for each one to reach `poll` before starting the next (`monitor.py`). The docstring explains that Gmail shards per user, so parallel folder downloads don't help.

**Gmail initial sync (verified, `gmail.py:221-275, 426-481`).**
- Only All Mail, Trash and Spam are synced. Every other label is an attribute.
- Inbox messages go to the front of the queue. Above a million messages, that lookup is limited to the last 30 days.
- Metadata (message ID, thread ID, size) is fetched in chunks of 1,024. Bodies are fetched in batches capped by bytes (1 MiB) and count. The count was cut to 1, with the comment "until N1 launch herding dies" (`gmail.py:49-50`).
- **Thread expansion**: when one message of a thread is scheduled, the rest of the thread comes with it, so a conversation never shows up half-synced.
- Messages are deduplicated by Gmail message ID. A copy in another folder gets a new UID row, not a second download.

**Incremental sync (verified, `generic.py:609-756`).**
- **New mail:** check `STATUS UIDNEXT`, then `UID FETCH lastseen+1:*`.
- **Flags, with CONDSTORE:**
  - When `HIGHESTMODSEQ` changes, fetch the changes since the old value.
  - Apply them in modseq order, 200 at a time, **saving an interim modseq after each batch** so a restart resumes partway (`generic.py:668-686`).
  - Expunges are found by diffing all UIDs, which is O(n). There is no QRESYNC.
- **Flags, without CONDSTORE:** a fast refresh of the newest 100 UIDs every 30 s and a slow refresh of 2,000 every hour. Nothing is written if the response hasn't changed.
- **UIDVALIDITY change:** generic IMAP resyncs the folder. Gmail **remaps** UIDs through the stable message ID, so nothing is downloaded again (`gmail.py:277-318`).

**Push (verified).**
- IMAP IDLE runs on the inbox (or All Mail for Gmail) only, with a **30 s timeout** followed by a STATUS check. The comment says IDLE misses flag changes.
- Other folders are polled every 30 s. The inbox is polled every 10 s when the server has no IDLE.
- Google Calendar `watch` webhooks exist behind a feature flag (`webhooks/gpush_notifications.py`).
- There is no Gmail Pub/Sub for mail.

**Retries and rate limits (verified).**
- **One generic wrapper retries forever with a fixed 30 s plus jitter** (`util/concurrency.py`).
  - It records the error message, exception and a truncated traceback in `account._sync_status['sync_error']`.
  - It stays quiet about transient network and database errors until 20 occur in a row.
- IMAP uses 3 read connections plus 1 write connection per account, with a fair semaphore. Any error discards the connection, and sockets time out after 120 s (`crispin.py:89-200`).
- Google Calendar parses `error.errors[0].reason` (`events/google.py:152-206`):
  - Rate-limited: sleep 30-90 s.
  - "API not enabled": turn off the feature.
  - 401: refresh the token.
  - 410 for an `updatedMin` that's too old: refetch everything.
- The Gmail raw re-fetch treats 403 and 429 as temporary and 404 as permanent.
- **Gmail IMAP bandwidth and over-quota responses are never handled.** My grep found nothing. Inference: serial single-message fetches plus the manual throttle were the real pacing.

**Conflict resolution (verified, `api/update.py`, `imap/common.py`).**
- Writes are optimistic. The local row change and an `actionlog` row are written in one transaction.
- A message's folders and labels are protected from incoming sync while a move or label action is pending, **or for 90 s after it finishes**.
- Read and starred flags have no such guard. Inference: they can flicker.
- **Nothing is rolled back** when an action finally fails. The TODO admits this.
- Draft pushes check the draft `version` first, so stale actions do nothing.
- **Moves keep message identity.** A message that loses its last UID is only marked deleted. It's removed 2 minutes later unless a UID has reappeared, and empty threads are kept 7 days (`mailsync/gc.py`). An IMAP move therefore keeps the same message and thread.

**Syncback (verified, `transactions/actions.py`).**
- Polls every 1 s and samples up to 500 accounts at random for fairness.
- Takes batches of 10 per account and **merges adjacent identical label changes** into one IMAP call.
- A per-account lock keeps actions in order.
- Each action gets up to 20 attempts with a fixed 30 s wait. The TODO asks for exponential backoff.
- Actions for invalid accounts are held for a 2 h grace period, then marked failed.
- If creating an event fails, every action that depends on it fails too.

**Offline outbox.** None, because the server is always online. Send is synchronous inside the request, with a 60 s guard so a client never disconnects while a send silently completes, and one SMTP retry (`postel.py:27`). Inference: that retry can send a message twice after an ambiguous failure. Aplos's `findSent` reconciliation is already better.

### 3d. Local storage (verified, `inbox/models/`)

MySQL with InnoDB, sharded, using SQLAlchemy. About 237 numbered Alembic revisions. Many are backfixes and new indexes, which shows how much a mail schema changes once it's in production.

**Main tables:**
- `account`, with subtypes for IMAP, Gmail, generic and Outlook: provider, `sync_host`, `sync_should_run`, `sync_state`, and `_sync_status` JSON (times, `sync_error`, disabled reason). Plus `throttled`, `sync_email`, `sync_contacts` and `sync_events`.
- `namespace`, the API tenant. `secret`. `gmailauthcredentials` (`client_id`, `scopes`, `is_valid`).
- `folder` and `label` (name, role, initial-sync start and end), and `category` (folder or label, soft-deleted), joined to messages through `messagecategory`.
- `thread` (subject, cleaned subject, first and last dates, snippet, `version`; Gmail adds `g_thrid`).
- `message`:
  - Address JSON (from, to, cc, bcc, reply_to), Message-ID, In-Reply-To and References.
  - Subject, date, size and the raw-message `data_sha256`.
  - `snippet` and `_compacted_body`, the HTML body compressed and optionally encrypted.
  - Flags (read, starred, draft, sent), `version`, the draft header ID, Gmail message and thread IDs, and `thread_id`.
- `imapuid` (folder, UID, flags, Gmail labels). **This is the provider-mapping table, so the message row stays provider-neutral.**
- `imapfolderinfo` (UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ, last slow refresh) and `imapfoldersyncstatus` (state, plus progress metrics such as remote count, downloaded count and percent).
- `block` (blob size, sha256, content type, filename) and `part` (message, block, MIME index, disposition, content-id).
- `transaction` (namespace, object type, record ID, public ID, `insert`/`update`/`delete`, timestamp).
- `actionlog` (action, record, `pending`/`successful`/`failed`, retries, args JSON).
- `metadata` (app ID, target object, JSON value, `version`). Rows are never deleted, so versions keep increasing.
- `contact`, `calendar` and `event` (with recurring subtypes), plus cached contact rankings.

**Bodies and attachments: everything is stored, but as a cache.**
- The raw RFC 822 of every synced message, and each MIME part, is written to a **content-addressed blockstore**: `MSG_PARTS_DIRECTORY/<hash-prefix dirs>/<sha256>`, or S3 (`util/blockstore.py`).
- **Eviction is safe by design.** When a part is missing, `Blob.data` reloads the raw message. If that's gone too, it **re-fetches the message from the provider** (Gmail `format=raw`, or IMAP `UID FETCH`), finds the part whose sha256 matches, re-caches it and returns it (`models/roles.py`, `s3/backends/`).
- Every read is checked against its hash.
- The S3 bucket is named "TEMP…". Inference: it expired on a schedule, with the provider acting as cold storage.

**Search.** There is no local full-text index for mail. Queries go to the provider (Gmail `q`, or IMAP `SEARCH` per folder), and the hits are matched back to local rows.

**Encryption at rest.** Optional, using the static SecretBox key. It is off in dev.

**Retention.**
- Transaction rows are purged after 60 days (`bin/purge-transaction-log`).
- A client with a purged cursor just gets a 400 "Invalid cursor". There is no specific "expired, resnapshot" signal.

### 3e. API between UI and engine (verified)

**Shape.**
- REST JSON with filterable lists (`in`, `unread`, `from`, `any_email`, date ranges) and `view=ids|count|expanded`.
- Paging is by `limit` and offset: default 100, maximum 1,000 (`ns_api.py:80`, `validation.py:17`).

**List and detail are separate** (`api/kellogs.py`).
- A thread list item is lean: participants, snippet, timestamps, flags, labels, `version` and message IDs.
- The "expanded" view adds message headers **but not bodies**. Bodies come only from `/messages/<id>`.
- A thread's `version` goes up whenever a child message's flags or labels change (`models/transaction.py`: `propagate_changes`, `increment_versions`).

**Change propagation through the transaction log.**
- An SQLAlchemy `after_flush` hook writes one `transaction` row for every insert, update or delete of a versioned object, **inside the same database transaction** as the change (`models/session.py:86-101`). The log can never disagree with the data.
- The delta reader takes rows after the cursor and **compacts** them, keeping only the latest entry per object and command.
- It bulk-loads the *current* objects and emits `{object, event: create|modify|delete, id, cursor, attributes}`. Objects deleted since then are skipped (`delta_sync.py`).
- There are three transports:
  - `/delta`: returns immediately.
  - `/delta/longpoll`: holds up to 120 s.
  - `/delta/streaming`: chunked newline-delimited JSON.

  Both waiting modes **re-query MySQL every second per client**.
- Clients can include or exclude object types. `latest_cursor` and `generate_cursor` (from a timestamp) let a client start from "now".
- The implied client contract: snapshot through the lists, hold a cursor, apply deltas, and resnapshot if the cursor is rejected.

**Auth (`api/srv.py`).**
- The account's public ID doubles as the Basic or Bearer credential.
- `/accounts` lists every account with no auth.
- CORS reflects any origin with credentials allowed.

That is fine inside a dev VM. On a localhost daemon, any web page could reach it.

### 3f. Send, drafts, threading, labels, calendar, contacts, AI

**Send (verified).**
- Draft state is flushed first, but committed only if the send succeeds.
- SMTP errors go through a table keyed by reply code plus enhanced status code (for example 550 5.4.5 means the daily quota is exceeded). Each maps to HTTP 402 (permanent), 429 (back off) or 503 (transient), with plain-language copy (`smtp/util.py`).
- When only some recipients fail, the response returns a map of them.
- BCC is stripped. Multi-send sends a custom body to each recipient.

**Drafts (verified, `message.py`, `actions/backends/generic.py`, `models/util.py`).**
- Each revision gets a header made of `<public_id>-<version>` and a **deterministic Message-ID derived from it**.
- An update APPENDs the new revision (skipping it if one with that Message-ID already exists), then deletes the old revision by its old Message-ID.
- When sync downloads the server copy, it is mapped back to the local draft through the header, or through the raw message's sha256 if the header is missing.
- Stale revisions never turn into separate messages. Sent copies for IMAP go through the same APPEND path.

**Threading (verified, `util/threading.py`).**
- Gmail uses the thread ID that Gmail provides.
- Generic IMAP matches on **cleaned subject plus at least two shared participants (BCC excluded)**, capped at 500 messages per thread.
- It ignores References and In-Reply-To even though it stores them. The comment admits the subject assumption is "only right 95% of the time".

**Labels and folders.**
- One `category` type covers both. The API shows a single `folder` or a list of `labels`, depending on the account.
- Roles come from SPECIAL-USE flags, the provider's folder map, and a curated table of localized folder names.
- Gmail label renames are detected. Labels are soft-deleted because Gmail lets users hide them from IMAP.

**Calendar.** Google Calendar REST with `updatedMin` incremental sync and optional push. iCal attachments are imported automatically, RSVPs go out by email, and recurrence is expanded locally. There is no CalDAV.

**Contacts.**
- Harvested from mail participants as well as from providers.
- **Rankings** are recency-weighted counts of mail *sent* to each address, decaying linearly over two years.
- **Groups** cluster recurring recipient sets by Jaccard similarity (`contacts/algorithms.py`).

**AI.** None.

---

## 4. Engineering quality

**Tests (verified).**
- About 520 pytest functions, in `tests/` and in a near-duplicate `inbox/test/`. CI runs the latter.
- They use a real MySQL test database, a mock IMAP client (`util/testutils.py`) and mock Redis.
- Tests that need the network are skipped in CI. `tests/system/` runs against live accounts by hand.
- Coverage is strongest where it matters: transaction creation and deletion, delta sync, thread versioning, folder sync state, delete handling and draft reconciliation.

**CI.** Travis runs flake8 (errors only), one pylint check and pytest. Review went through Phabricator.

**Organization.**
- Clean layers: `models/`, `mailsync/backends/`, `actions/backends/`, `sendmail/`, `search/backends/` and `api/`.
- Providers are found through a module registry, and backends can live outside the tree. That's how the closed EAS backend plugged in.
- Docstrings are unusually good. The IMAP module opens with an ASCII state diagram.
- gevent monkey-patching hides where code yields, which makes it easy to block the loop by accident.

**Observability (strong for 2016).**
- Structured loggers with the account and folder attached, and Sentry.
- statsd metrics: receive-to-sync latency, download speed, time to first message, and syncback latency and failures.
- Redis heartbeats per folder. A `sync_error` blob per account. Progress counters per folder.
- An event-loop stall detector that can kill stuck greenlets (`instrumentation.py`).
- Profiler and memory endpoints, which bind `0.0.0.0` with no auth.

**OSS security posture.** Weak: no TLS verification, no API auth, and secrets unencrypted by default.

---

## 5. UI notes

None. This is a headless engine. The UI was N1/Nylas Mail, a separate Electron and React repository that I did not audit. There are no motion or keyboard findings.

---

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **A durable change log as the spine.**
   - Add a `changes` table (`seq`, account, type, ID, op) and write to it **in the same SQLite transaction** as every mutation: sync, ops, AI enrichment and settings.
   - Clients catch up with "changes since `seq`".
   - Aplos's in-memory `{epoch, rev}` diffs (`src/shared/live.ts`) are already this protocol for one process. Making it durable lets clients resume after a restart, and lets a phone catch up after a day offline.
2. **Compacted, state-based deltas** that say "object X changed" and give its current state or ID, plus an **explicit cursor-expired reply** that triggers a resnapshot.
3. **Lean list objects, with bodies fetched per message.** Combined with SQLite-backed queries, this removes the "whole mailbox in memory, cloned on every change" ceiling.
4. **An initial sync that always makes progress.**
   - Newest first and inbox first. A metadata pass, then bodies, committed page by page.
   - **Resume by set difference** (remote IDs minus stored IDs).
   - **One backfill per account at a time, with the new-mail poller running alongside it.**
   - This directly cures the all-or-nothing, 500-thread, concurrency-4 Gmail first sync that hit 403s.
5. **Gmail thread expansion during backfill**, so the UI never shows half a conversation.
6. **A content-addressed blob store used as a cache.**
   - Raw MIME and attachments go on disk, keyed by sha256 and checked on read. SQLite keeps metadata, the sanitized body and pointers.
   - Evict by size or LRU, and **re-fetch from the provider by provider ID** (Gmail raw, IMAP `UID FETCH`, Graph `$value`, a JMAP blob).
7. **A persisted sync state machine per account and folder, with progress counters.** These feed a real progress UI and the connection report the synthesis asks for.
8. **A structured `sync_error` on each account**, holding the message, error class, the provider's reason and a short redacted trace. Show it in Settings and in "Copy diagnostics".
9. **Per-scope credential health.**
   - Check which scopes were granted, and turn off only the feature whose scope is missing.
   - Map `invalid_grant` to an "invalid, reconnect" state that **pauses** that account's op queue for a grace period.
10. **Classify errors by the provider's own reason.** Sort each into retry soon, back off, stop for today, needs the user, or permanent, each with plain copy. Google `reason` strings and SMTP enhanced status codes both work this way. For example, `quotaExceeded` means stop for today.
11. **Syncback hygiene.** Merge adjacent identical label or archive ops into one provider call. Keep ops ordered per account. Check a version before pushing a draft.
12. **Draft sync through a stable app header plus a deterministic Message-ID.** Reconcile server copies back to the local draft. This closes the "drafts never reach Gmail or the phone" gap.
13. **A tombstone grace period for IMAP moves**, so a move keeps the same message and thread.
14. **Cheap IMAP push.**
    - IDLE on INBOX with a short timeout, then STATUS.
    - CONDSTORE with the modseq checkpointed per batch.
    - Remap UIDs on UIDVALIDITY change wherever a stable ID exists.
    - Add QRESYNC, which Nylas lacked.
15. **Contact rankings from sent mail** as a free, deterministic importance signal and autocomplete order, with no AI involved.
16. **Watchdogs.** Track event-loop delay in the engine (`perf_hooks.monitorEventLoopDelay`) and a heartbeat per account.
17. **Provider presets with folder maps and localized role names**, so role detection doesn't depend on SPECIAL-USE alone.

### Avoid

1. **Never disable TLS certificate or hostname verification.**
2. **Never run an unauthenticated local API or reflect CORS origins**, and never bind debug endpoints to `0.0.0.0`.
3. **A single static key in config with unused key versioning.** Keep Aplos's Keychain-wrapped data key, and make rotation real if blob encryption is added.
4. **Subject-plus-participants threading.** Use References and In-Reply-To first, and the provider's thread ID wherever one exists.
5. **Retry-forever loops with a fixed delay, or retrying quota errors.** Use exponential backoff with jitter, honour Retry-After, set caps and keep a per-account budget.
6. **Polling the database every second for each client.** In one local process, publish changes from the write path to an in-memory bus, and read the database only when a client is catching up.
7. **Synchronous send with a blind SMTP retry.** Keep Aplos's queued, idempotent send.
8. **Optimistic writes with no rollback** when an op fails for good. Revert, or show "failed, retry?".
9. **Offset pagination.** Use keyset cursors or JMAP-style anchors.
10. **Downloading every full message during initial sync.** A server could afford it. A laptop within Gmail's per-user limits can't.
11. **The full `https://mail.google.com/` scope and the OOB flow.**
12. **Fleet machinery** (shards, Redis, account stealing). None of it is needed on one Mac.

---

## 7. "Local server" translation: an Aplos engine as a daemon on the Mac

### Mapping

| Nylas | Aplos local equivalent |
|---|---|
| Sync process with per-account monitors | The engine, with one async task group per account and one backfill at a time |
| Folder state machine in MySQL | A `sync_state` table (phase, cursor or modseq, counts, last error), so adapters hold no state between runs |
| Sharded MySQL | One SQLite file (WAL). **The daemon is the only writer.** The UI never opens the database. |
| Blockstore | `~/Library/Application Support/Aplos/blobs/<xx>/<sha256>`, capped and re-fetchable |
| `transaction` table plus delta API | A `changes` table, plus "changes since" and a push of new state |
| `actionlog` plus syncback | Aplos's `ops` queue, with merging, an invalid-account hold and rollback added |
| Flask REST | Typed resources (threads, messages, drafts, labels, events, contacts, settings, AI jobs) |
| Heartbeats, statsd, Sentry | A rotating local log, crash reports, per-account health, and a token-protected `/debug/health` |
| nylas-mail cloud workers (send-later, snooze) | "Mac must be awake", or a tiny opt-in relay |

### API shape: JMAP semantics without full JMAP compliance

- Keep a **state string per object type**.
- `X/changes(since)` returns created, updated and destroyed IDs, or a "cannot calculate" error that triggers a resnapshot.
- `X/get(ids)` returns current objects.
- `Thread/query(filter, sort, anchor, limit)` uses keyset paging.
- `Thread/queryChanges` lets an open, virtualized inbox list update in place. Nylas lacked this.
- **Push** sends only the new state strings over SSE or WebSocket, and the client pulls what it needs (JMAP's EventSource model).
- Mutations are commands (`thread.archive`, `draft.save`). Each writes the local change, an op row and change rows in one transaction.
- One handler table serves both IPC and HTTP. That also ends the "method allowlist copied in three places" problem.

### Transport and exposure tiers

1. **Electron UI.** Today's IPC, or main talking to the daemon over a **Unix domain socket** with mode 0600. That avoids TCP, DNS rebinding and origin issues.
2. **Browser preview and dev.** `127.0.0.1` with a random per-launch bearer token, strict Host and Origin checks, and no CORS reflection.
3. **Phone on the same network.**
   - Opt-in, advertised over Bonjour.
   - TLS with a self-signed certificate **pinned during QR-code pairing**.
   - Per-device tokens that can be scoped and revoked. For example, a phone token can't read AI keys or export the mailbox.
4. **Phone away from home.** Tailscale (no new code, and the owner already uses it), or a relay that only forwards end-to-end-encrypted frames.

### Lifecycle options

- **A. Keep the `utilityProcess` and add the API.** Cheapest. Sync stops when the app quits.
- **B. A headless background agent.**
  - The same signed app binary runs in a no-window engine mode, started as a login item or LaunchAgent. That keeps the code signature, Keychain ACL and `safeStorage` identical.
  - Check whether the Electron version in use exposes macOS service-type login items.
  - The UI becomes a client. It runs a version handshake on connect and resnapshots on mismatch.
  - A file lock ensures there is only ever one writer.
- **C. Phone** on top of B.

### Pros

- One sync and one AI pipeline for every client. A phone gets the Mac's cache, local models and rules **without a hosted mail server**, so the privacy story holds.
- UI crashes and reloads no longer interrupt sync. With option B, sync keeps going when the window is closed.
- Steps 1 and 2 below are exactly the fixes for the memory ceiling and full-state IPC. They pay off even if a daemon or phone never ships.
- The engine becomes testable headlessly. Preview mode becomes a real client.
- The design has been proven: Nylas Mail shipped this split in 2017.

### Cons and risks

- **The Mac must be awake.**
  - While it sleeps, the phone sees nothing new and send-later and snooze don't fire. Lid closed on battery means asleep.
  - The options are provider-side automation (Gmail filters, Outlook rules, Sieve), a minimal relay for scheduled jobs only, or honest UI copy.
- **Security surface.** A process holding every mailbox and the AI keys now accepts connections. Pairing, certificate pinning, token scoping and revocation must be right from the start.
- **Version skew** between the app and the agent. The daemon must own migrations alone.
- **Operations.** Two lifecycles, macOS background-item approval prompts, logs and crash reports for a process the user never sees, and uninstall cleanup.
- **SQLite allows one writer.** Every client must go through the daemon.

### Effort (one developer plus agents; rough, Inference)

| Step | Scope | Effort |
|---|---|---|
| 1 | `changes` table written in the same transaction; lean resources; `changes`, `get` and keyset `query` over the existing IPC; the renderer stops loading every thread | 1.5-2.5 weeks |
| 2 | Blob store with lazy bodies, eviction and provider re-fetch; SQLite replaces the in-memory clone as the source of truth | 1-1.5 weeks |
| 3 | The same handlers over a Unix socket or loopback with token auth, plus SSE or WebSocket push. `server.ts` grows into this. | 3-5 days |
| 4 | Headless agent (option B): login item, writer lock, version handshake, reconnect, logs and crash reports | 2-3 weeks |
| 5 | Phone: pairing, TLS pinning, Bonjour, device tokens, Tailscale or relay, plus the mobile client | 6-10+ weeks |

**Recommended order.** Do steps 1-2 inside the backend revamp, together with the first-sync rework (section 6, items 4-10). They fix known problems and everything else depends on them. Step 3 is cheap once step 1 exists. Steps 4-5 come after the 30-day "a stranger can install it and sync" milestone, which matches the synthesis deferring mobile and push.
