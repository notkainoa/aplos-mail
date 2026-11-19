# Aplos revamp architecture proposal: reliability-first evolution

Principal architect, "evolve" angle, 2026-10-27, branch `revamp`. Nothing here is implemented or goes to main.

`RC/` means `research/email-clients/`. Labels: **[V]** verified by a research report, **[C]** a project's own claim, **[S]** secondary source, **[U]** unverified, check live. Unlabelled statements are my design choices.

## In plain English

Aplos is two weeks old and has never fully synced a real Gmail mailbox. The first real sync failed because Google now allows only 6,000 "units" of work per minute, and Aplos asks for about 60,000 units up front. That is the headline problem. Behind it sit structural ones: the whole mailbox lives in memory, nothing records changes durably, AI runs in the middle of syncing, and the app dies when you quit it.

This proposal fixes those in place instead of rebuilding from scratch. The good parts stay: the engine in its own process, the safe-send logic, the durable queue of pending changes, and the encrypted credentials. We add a new, properly organised database, a "governor" that spends each account's quota carefully, and a single list of changes that survives restarts. Aplos then keeps running in the menu bar so mail, reminders and scheduled sends keep working with the window closed. Later we add a small local doorway so command-line tools and AI agents can talk to the same engine. The phone comes after that.

The aim is the shortest path to an app you can live in every day on a real Gmail plus iCloud/Fastmail setup. A quick patch release in the first week makes real Gmail work in a limited way. The proper rebuild then lands in steps, and the app stays usable the whole time. Gmail is daily-drivable at about week five. iCloud and Fastmail follow by about week eight. The whole plan takes about eleven weeks for you plus AI agents.

What changes for you: faster opening, mail that keeps arriving with the window closed, no AI work blocking sync, safer rendering of hostile email, and a diagnostics screen that says why something is stuck. The look and feel belong to a separate UI thread.

> **What this means:** We repair the engine while it keeps running, rather than starting over. You get a usable Gmail app early, and the rest follows in small, safe steps.

## 0. Stance and the plan on one page

**Stance.** Sync quality comes from the data model and the governor, not the process topology (`RC/SYNTH-architecture.md` §2). Candidate B (evolve the `utilityProcess` engine) is fully reversible, and A0 (a listener) is a transport added on top of it (§11.5). The order: foundation, then resident menu-bar mode, then the listener, then the phone.

**Principles.** (1) One owner per mailbox: one engine process writes the database, spends the quota and holds the connections (`RC/SYNTH-architecture.md` §0.6). (2) One governor, one retry layer, errors classified by reason. (3) Metadata first, bodies lazy, commit per page (`RC/protocols/proto-google.md` §2.3). (4) Keep the two insurance items from day one, a persisted change log and a typed schema-first contract, since they make A0, a phone and a CLI cheap later (`RC/SYNTH-architecture.md` §11 Candidate B). (5) Every step ships and leaves the app usable; compat shims are temporary. (6) Live verification is the bottleneck, so every milestone has a live acceptance check and mocked Google never counts (AGENTS.md).

**What stays from today** (`RC/SYNTH-architecture.md` §1): the separate engine process, the durable op queue, idempotent send, staged provider memory and the Keychain-wrapped data key. **What changes:** the store, change tracking, quota handling, Gmail first sync, AI placement, email HTML rendering and process lifetime, as the sections below set out.

**Milestones** (detail in §12): M0 patch release, M1 platform groundwork, M2 new store, M3 governor and Gmail rewrite, M4 windows and HTML isolation, M5 AI queue, M6 outbox and timers, M7 IMAP, iCloud and JMAP, M8 Graph and calendars, M9 listener and diagnostics, M10 hardening.

> **What this means:** The plan is ordered so each step fixes a real problem and nothing has to be thrown away. The risky, reversible choices come late.

## 1. Process topology and lifecycle

**Topology (target through M10).**

```
Electron main (windows, menus, Keychain unwrap, updater, notifications, protocol handler)
  |-- MessageChannelMain --> renderer(s)   (direct port to engine; main not in the data path)
  |-- MessagePort ---------> utilityProcess: engine (sole owner of mail.db, sockets, governor, timers, AI queue)
  |-- aplos-mail:// protocol handler  --> asks engine for body/blob bytes
  `-- (M9) Unix socket 0600 + token <-- CLI / MCP / browser preview (served from the engine process)
```

This is candidate B plus A0 as `RC/SYNTH-architecture.md` §11 defines them, following Mailspring and Delta Chat (separate engine process) and comail, Flectar, Tuta and Geary (resident tray app). The engine already imports nothing from Electron (`RC/gaps/macos-daemon-lifecycle.md` §2), so this is wiring, not a rewrite.

**Resident menu-bar mode (M1, 2-3 days)** [per `RC/gaps/macos-daemon-lifecycle.md` §9]:
- Closing the last window keeps the app and engine alive. The Dock icon hides when no window is open (accessory activation policy). A menu-bar item shows sync state with Open, Pause sync, and Quit Aplos completely. ⌘Q is a full quit, like Mail.
- Start without a window when the login item opened the app (`wasOpenedAtLogin`).
- `powerMonitor` `suspend`/`resume`/`unlock-screen` call `engine.wake()`. On wake: wait for the network, reconnect IDLE sockets, then catch up through history/delta. A wall-clock jump of more than 30 s between one-second ticks also counts as a resume.
- Battery: backfill and prefetch drop to half budget on battery power; INBOX push stays on (an idle socket is cheap). Long-run battery behaviour is **[U]** and gets a soak test (M10).
- Idle cost is about 53 MB with no window [V `RC/gaps/macos-daemon-lifecycle.md` §2].

**Hardening at the same time (0.5-1 day):** `minimumSystemVersion` from 12.0 to 13.0 (Electron 44 already requires 13, so today's plist is a latent bug); fuses `RunAsNode`, `NodeOptions`, `NodeCliInspect` off and asar integrity on; verify `utilityProcess` and `aplos-symbols` still start (`RC/gaps/macos-daemon-lifecycle.md` §3, §9).

**Engine ownership.** A lockfile (`aplos.lock`, pid and start time) guarantees one writer. Migrations run only in the engine, before it accepts connections. Windows see "starting" rather than half-migrated data. Browser preview keeps its own data directory (`Aplos Mail Preview`) and never opens the real database.

**Crash policy.** Keep today's guard (more than three exits in 60 s shows a dialog, `electron.ts:243-250`) and add a parked mode plus an event-loop-delay monitor and per-account heartbeats, so a wedged actor is restarted, not just a dead process.

**Deliberately not here: a LaunchAgent helper (A1).** The daemon report priced it at 3.5-5 weeks on top of A0, needing a Node SEA, a native Keychain shim and a provisioning profile. Correction to that report: Aplos releases are Developer ID signed and notarized (team VW9NDM428H), so A1 is blocked on profiles and real need, not signing. Revisit only if "sync after ⌘Q" becomes a daily annoyance. To keep A1 cheap: no Electron imports in the engine (lint rule), a single-writer lock, and the data-key handoff behind an interface.

**Timers only run while resident.** This is the main thing resident mode buys (`RC/SYNTH-architecture.md` §7). Send-later, Later wake-ups and reminders are owned by one timer loop (§5) and catch up on launch and wake. Nothing runs while the Mac sleeps. Provider-side rules are the only "while asleep" automation and are out of scope here.

> **What this means:** Aplos keeps running in the menu bar when you close the window, so mail and reminders keep working. It will not act while your Mac sleeps, and we say so up front.

## 2. Storage design

**Decision: new database file, same SQLite, same driver.** Build a normalized store in a fresh `mail.db` beside today's `aplos.db`. A new file allows `auto_vacuum=INCREMENTAL` (not retrofittable without a full `VACUUM`) and keeps `aplos.db` untouched as a rollback copy for two releases. Keep `node:sqlite`: the storage benchmark found the driver is not the bottleneck (better-sqlite3 is 6-8% faster on commits, about 30% on ranked search) and the switch is cheap if ever needed [V `RC/gaps/storage-engine-benchmark.md` §0.3, §6]. Extend the `SqlDatabase` port with `Uint8Array` values and `iterate()`. Add a CI check on `sqlite_version()`, since `node:sqlite` tracks Electron's SQLite.

**Schema sketch** (`STRICT` tables; names indicative). This is the benchmarked shape: 0.04-0.07 ms list pages and a 10 ms first screen at 1M messages [V storage benchmark §0.1].

```sql
accounts(id TEXT PK, provider, address, status, status_detail, resume_at, data JSON)
labels(id INTEGER PK, account_id, remote_id, name, role, kind, UNIQUE(account_id, remote_id))

-- mailbox facts (the provider's truth)
messages(id INTEGER PK,                 -- date-ordered: unix_seconds*4096 + seq (opaque)
  account_id, remote_id, thread_id, internet_id, subject, from_addr, from_name, to_json, cc_json,
  date_ms, snippet, flags INT, size, list_unsub, parts INT /*bitmask: meta|text|html|fts*/,
  UNIQUE(account_id, remote_id))
message_labels(message_id, label_id) WITHOUT ROWID
message_locations(message_id, folder_id, uid, uidvalidity)   -- IMAP/JMAP placements
threads(id INTEGER PK, account_id, remote_id, subject, snippet, last_date, msg_count, unread_count, has_attach, participants JSON)
thread_labels(thread_id, label_id, last_date, unread) WITHOUT ROWID  -- keyset + partial unread index
bodies(message_id PK, codec, raw_size, data BLOB)            -- zstd-3, codec id per row
attachments(id, message_id, remote_part, name, mime, size, cid, path NULL, state)  -- files

-- app-owned data (its own feed, never mixed into provider facts)
thread_workflow(thread_id PK, status, bookmarked, reply_status, due_date, reminder_at, reminder_fired,
  todo, hidden_from_home, rank_bucket, rank_source, ranked_at, updated_at, device_id)
summaries(thread_id, input_hash, model, text, action, state, created_at)

-- engine plumbing
changes(seq INTEGER PK, type, id, op)  -- index (type, seq); written in the same txn as the data
meta(key, value)                       -- db_epoch, change_floor, schema flags, consent_version
sync_state(account_id, scope, cursor, page_token, phase, oldest_loaded, updated_at, PK(account_id, scope))
sync_failures(account_id, item, attempts, next_retry_at, last_reason)
provider_memory(account_id, key, value)           -- kept as is
ops(seq, id UNIQUE, account_id, kind, data JSON, attempts, next_at, state)   -- kept, extended
drafts(id, account_id, thread_id, revision, data JSON, remote_draft_id, synced_revision)
submissions(id, draft_id, message_id, not_before, state, attempt_at, error)
jobs(id, kind, key, payload JSON, state, attempts, next_at, last_error)
ai_usage(day, provider, requests, tokens);  governor(account_id PK, cooldown_until, reason, blocked_until)
calendars(...), events(id, calendar_id, remote_id, etag, sync_token, data JSON)
messages_fts: fts5(subject, people, body, content='', contentless_delete=1)  -- rowid = messages.id
```

**Design rules.**
- **External ids stay as today's strings** (`accountId:remoteId`); integer rowids are internal. The UI and its 60 call sites stay stable.
- **Thread rollups come from a SQL aggregate over the thread's messages**, never the incoming batch (Velo's bug). Thread status derives from messages not in Trash or Spam (defect D8), and `DRAFT` messages are excluded from thread rows (D9) [`RC/protocols/proto-google.md` §9].
- **Unread counts count threads** via the partial index: 0.5 ms versus 26 ms for message joins [V storage benchmark §5.4].
- **Provider facts and app metadata are separate feeds.** `thread_workflow` (Done, Later, due dates, reminders, rank) syncs between Macs through the existing hidden-label channel (§11), never mixed into mailbox facts (`RC/SYNTH-architecture.md` §8).

**Bodies.** A separate `bodies` table of zstd-3 blobs, not content-addressed files (files used 32% more disk, opened threads 4.5x slower and took 54 s to create 200k files) [V storage benchmark §0.4]. Store the **parsed body record** each adapter already produces (text, HTML, inline-cid map, attachment metadata), not raw MIME. This departs deliberately from Stalwart's "one raw format" idea (`RC/SYNTH-architecture.md` §5): adapters already emit parsed output, raw MIME would drag 25 MB attachments into the table, and a later switch is a store-side migration, not a contract change. Attachments are files in a `.noindex` directory served through blob routes (§7). zstd is experimental in Node 24, so each row carries a codec id with a gzip/none fallback.

**FTS.** One contentless FTS5 table sharing the message rowid, kept in the main database (a separate file loses atomicity with `changes`). Insert FTS rows **last** in each transaction (1.5-1.8x faster, since FTS5 flushes at later savepoints) and better still index in a paced job over messages whose `parts` lack the FTS bit, 100 per batch. Indexing is about 80% of write cost and each page commit holds the write lock for 45-136 ms, so job-based indexing keeps a keyboard triage action from waiting behind a sync page [V storage benchmark §0.2, §6]. Cap indexed body text at 16 KB (18% smaller index, 9-20% fewer deep hits); subject and people are fully indexed. Search sorts newest-first with `ORDER BY rowid DESC` (0.05 ms versus 32-40 ms for a date join), which is why message ids are date-ordered. Server search runs only on Enter, about 500 units for 25 results, never as-you-type (about 12,000 units per pause today, defect D2). Server results are ordinary rows tagged `origin='search'`, excluded from list counts and garbage-collected after seven days if unopened.

**Encryption at rest: not now.** SQLCipher-class codecs cost 2-4x on writes and 6-14x on cache-missing reads, and force a driver change because `node:sqlite` cannot load a codec [V storage benchmark §0.6]. Rely on FileVault, 0600 files in a 0700 directory, and the Keychain-wrapped data key for credentials and AI keys, as Delta Chat decided (`RC/arch/deltachat-core.md`). If required later: better-sqlite3-multiple-ciphers with ChaCha20 and a raw Keychain-unwrapped key, a one-file change behind the port.

**Retention.** Metadata, labels and the FTS index live forever (cheap, and they keep evicted mail searchable). Bodies keep 90 days plus anything opened, starred or unread, with a 2 GB LRU cap on `last_read_at`. Eviction clears the body bit and a read refetches at 20-60 Gmail units, so eviction is slow and never runs during backfill. `incremental_vacuum` runs paced.

**SQLite discipline.** One writer connection, short read transactions, `wal_checkpoint(TRUNCATE)` when idle plus `journal_size_limit` (a busy reader let the WAL reach 104-938 MB in 2.5 s in the benchmark), strict `user_version` migrations.

**Migration of existing data** (M2). One import transaction per table family from `aplos.db`: accounts, settings, drafts, conversations, ops, workflow state, provider memory, and thread and message rows with bodies. Gmail then reconciles against the provider with a generation sweep. Little real mail is at stake. Tested against a synthetic 50k-thread fixture and a rollback drill.

> **What this means:** Mail moves into a proper database that opens instantly and searches fast, with message text fetched only when you need it. Your data stays on disk protected by FileVault, and we keep the old file as a safety net.

## 3. Sync per provider

**Common core** (`RC/protocols/proto-others.md` §8). Each account is an actor with lanes in priority order: interactive, op flush, push-triggered incremental, scheduled incremental, body prefetch, backfill. AI is a separate budgeted queue (§6), not a lane. Each actor keeps persisted cursors per folder or collection, classifies every failure, and exposes a status for the UI (§4). A resume or network change interrupts every wait.

Rules everywhere (`RC/SYNTH-architecture.md` §4.1): capture the incremental cursor **before** listing; commit each page with its resume token in one transaction; infer deletions only after a complete round and only within its scope (the generation sweep, which fixes the ignored `reset:true`, D10); show new mail during a long backfill; leave Spam and Trash out of the first pass; treat the first sync as a silent baseline with no notifications or background AI; quarantine poison items in `sync_failures` instead of failing the run.

### Gmail (REST, scope `gmail.modify` + `settings.basic`)

The decisive constraint: 6,000 units per user per minute, `messages.get` 20 (metadata) or 60 (full/raw), `threads.get` 40 or 120, `history.list` 2, list 5 [V `RC/protocols/proto-google.md` §1.1]. The quota is per user **per project**, so a second Mac or a phone shares it.

**First sync** (`proto-google.md` §2.3, priced at published rates):
- **P0** (about 5 units): `getProfile.historyId`, `labels.list`.
- **P1**: `messages.list?labelIds=INBOX&maxResults=100`, then `messages.get?format=metadata` for the newest message of each thread with a `fields` mask, 20 units per thread. The first 50 threads cost about 1,000 units and appear in seconds. Commit the page.
- **P2**: continue to 500 threads, about 10,000 units, roughly 2.5 minutes at a 4,500 units/min target. **P3**: Sent for 30 days (reply signals).
- **P4**: body prefetch for unread Inbox then the newest 100 threads, capped near 20% of budget. Opening a thread fetches its newest message first (`messages.get` full, 60 units), then the rest.
- **P5**: idle Inbox backfill to 90 days; older mail stays reachable through server search.
- `sync_state` stores phase, page token and oldest loaded date with each page commit.

**Incremental**: `history.list` with all four types, `maxResults=500`. Apply `labelsAdded`/`labelsRemoved` to per-message labels at zero fetch cost. Fetch added messages as metadata only. Fetch an unknown thread only if it gained `INBOX`, so archiving 2,000 old threads in Gmail web costs nothing instead of about 240,000 units (D3, D13, D14). The cursor advances only together with the changes it covers. A 404 means bounded resync plus reconcile. Cadence is 15 s focused, 60 s backgrounded, 5 min hidden or on battery, plus jitter and an immediate pass on wake, network change and focus (`proto-google.md` §5A). `history.list` polling costs 2 units, so it is cheap.

**Writes**: `threads.modify` for single threads, `messages.batchModify` for bulk (50 units per 1,000), per-message targeting (D8). Large sends use the `/upload` path (D20); sends are never retried on rate errors (D7).

**Auth** (D4, D5, D21): store the granted `scope` on every token response; refuse to connect without `gmail.modify`; derive Calendar and filter capability from the grant; map `invalid_grant` and `admin_policy_enforced` to `needsReauth`, which pauses sync and ops and shows Reconnect; use `select_account` plus `login_hint`; keep the refresh token and its client id as one Keychain bundle with serialized per-account refresh.

**Not adopted:** the `mail.google.com` scope for IMAP bulk sync and IDLE (`RC/SYNTH-architecture.md` §3.2 option b). Verification cost is the same for both scopes, but (b) adds a second code path and a "permanently delete all your email" consent line. Reconsider only if live data shows quota still dominates after M3.

### iCloud (IMAP) and generic IMAP

From `RC/protocols/proto-others.md` §2, §5, §8:
- **Two connections per account at most.** A runs IDLE on INBOX (re-issued every 25 minutes or less, tuned per host); B is a priority command queue that releases between folders. Gate reconnect backoff on how long the connection survived.
- **Fetch tiers**: envelope plus BODYSTRUCTURE first, text for a recent window, attachments on open. Cap catch-up to the newest K with a gap cursor, replacing the unbounded `uidNext:*` (I2, I3).
- **Change detection by capability**: iCloud uses CONDSTORE with QRESYNC off [S, 2021 evidence, **[U]** today]; other hosts use QRESYNC where advertised, else CONDSTORE plus a bounded expunge check, else windowed flag scans. `STATUS` skips unchanged folders; rotate non-INBOX folders every 2-5 minutes.
- **Never infer a deletion from a partial answer.** Read RFC 9738 `MESSAGELIMIT` (Yahoo advertises 1000) and chunk below it (I5).
- iCloud: append your own Sent copy after SMTP (done today); the preset copy explains the app-specific password and username rule. Upgrade `imapflow` 2.4.3 to 2.9.x and stop swallowing its `error` event. The folder map becomes `message_locations` rows (I4).

### Fastmail (JMAP)

EventSource on the session's `eventSourceUrl` (ignored today), a watchdog after two missed pings, throttled reconnect honoring `Retry-After`, reconnect on wake, and `/changes` every 60 s as a floor. Lists use `preview`; bodies are lazy. The owner's API token stays the personal path; Fastmail OAuth registration is an external prerequisite before distribution [V `proto-others.md` §3.2].

### Microsoft Graph

Per-mailbox scheduler: at most four requests in flight, and one unordered `$batch` counts as four, so run one batch at a time; retry failed sub-requests after the maximum `Retry-After`; token bucket against 10,000 per 10 minutes. Replace the permanent `receivedDateTime` filter with a normal list query for the visible window plus an **unfiltered**, light-`$select` delta per folder with persisted `nextLink` checkpoints, because filtered deltaLinks probably hide older mail moved back in (M2 in `proto-others.md`; **[U]**, test live). Graph ships dark until a Microsoft client id exists.

### Calendars

- **CalDAV (iCloud, Fastmail)**: home PROPFIND for ctag/sync-token, then `sync-collection` and `multiget`, two requests in flight. Store master resources and expand recurrences client-side (evaluate `ical.js` against the 400 KB neutral-bundle budget; keep server `expand` as fallback). Follow redirects only within the same registrable domain, which fixes the cross-origin Basic-credential leak (C3).
- **Google Calendar**: per-calendar sync tokens, primary every 2-5 minutes and others every 15-30, `events.patch` with `If-Match`, decoupled from mail sync so one failing calendar cannot sink the rest (D11, D12). Resync a calendar on 410.

> **What this means:** Every provider gets the same careful treatment: show something quickly, fetch details only when needed, resume after a crash, and never guess about deletions. Gmail, the one that is failing today, is fixed first.

## 4. Governor and retry design

One governor per account, replacing `gate.ts`. Its job is to make sure no request is ever sent that the provider would likely refuse.

**Interface.** Adapters never call `fetch` in a retry loop and never set SDK retries. They call `governor.acquire({account, lane, cost, signal})`, which waits (never sends) until the budget allows it, then returns a permit. The caller reports `ok` or a classified error. Cancelling a signal aborts queued and in-flight sibling requests.

**Budgets priced in provider units** (`RC/SYNTH-architecture.md` §4.4, `proto-others.md` §8):

| Provider | Unit | Target | In flight |
|---|---|---|---|
| Gmail | 6,000 units/min rolling | backfill and prefetch 75% (4,500); incremental 90%; ops and interactive 100% | 2; batches of 10, adaptive to 25 |
| Graph | 10,000 requests per 10 min | 75% | 4 (one `$batch` = 4) |
| IMAP | connections | 2 per account | 1 command, 1 IDLE |
| JMAP | server `maxConcurrentRequests` | server value | per session |
| CalDAV | requests | modest | 2 |

Gmail batches start at 10 (Neverest saw refusals of 0% at 10, 1.2% at 25, 19% at 50 **[C]**, `RC/arch/pimalaya.md`); halve on refusal, grow slowly.

**Error taxonomy and handling** (`proto-google.md` §3; `proto-others.md` §1.3):

| Class | Examples | Action |
|---|---|---|
| `auth` | `invalid_grant`, `admin_policy_enforced`, repeated 401 | Park the account as `needsReauth`; stop sync and ops; show Reconnect. One forced refresh on a first 401 |
| `throttle` | `userRateLimitExceeded`, `rateLimitExceeded`, 429 concurrency, Graph 429 | Pause the account lane: use `Retry-After`, else 60 s, escalating 5 min then up to 1 h, reset after 10 quiet minutes. Drop in-flight to 1 on concurrency errors. Abort siblings |
| `daily` | `dailyLimitExceeded`, `quotaExceeded`, bandwidth caps | Stop until reset (Gmail: next midnight Pacific [C]) and say so. `quotaExceeded` is **not** a burst limit (D6) |
| `config` | `accessNotConfigured`, `SERVICE_DISABLED` | All accounts of that provider show `misconfigured`; no retries |
| `transient` | 5xx, timeouts, DNS | Jittered backoff 1, 2, 4 s, at most three tries, idempotent reads only. A write that times out is `uncertain` (§5) |
| `permanent` | 400 bad request, 404 on one item | Surface once; quarantine the item in `sync_failures` |

A bare `rateLimitExceeded` can mean per-minute only, so the reason alone is not enough; the escalation covers that.

**Persistence.** The `governor` table stores cooldowns and daily blocks, so a restart cannot hammer a paused account. The automatic-run spacing and failure backoff from `gate.ts` fold into the same actor.

**Status vocabulary** (drives retry policy and the UI): `ok`, `syncing`, `backfilling (n of m)`, `paused (until, reason)`, `needsReauth`, `needsAdmin`, `misconfigured`, `offline`, `error`. Only `offline` and transient states retry automatically; auth, TLS and config states wait for the user (`RC/SYNTH-architecture.md` §9, Geary's rule).

**Device-aware budget.** The owner runs three Macs, and each engine would assume the full 6,000 units. Using the device list workflow sync already carries, each device targets 75% divided by the devices seen in 24 hours (minimum 2,000 units/min), and only one runs backfill. Crude, but it stops two Macs locking each other out.

**Acceptance.** An emulator enforcing 6,000 units/min and the concurrency cap serves a 500-thread mailbox with zero 403s and the first 50 threads in under 15 s; a crash mid-page resumes from that page; `dailyLimitExceeded` stops all retries. Fake-clock tests cover pause escalation.

> **What this means:** Aplos will count its own requests against Google's limit and wait instead of getting refused. When Google does say no, Aplos reads the reason, waits the right amount, and tells you plainly.

## 5. Outbox, send safety, drafts, timed features

**Keep what works.** Stable Message-ID, a `sendAttemptAt` marker and `rfc822msgid:` reconciliation already make Aplos safer than comail, Velo, Nylas and Zero (`RC/SYNTH-architecture.md` §7). It becomes a `submissions` table with states `queued`, `sending`, `sent`, `uncertain`, `failed`, `cancelled`, `suspended`.

**Rules.**
- The attempt marker is written before the first byte leaves.
- Failures sort into **provably not sent** (no connection, 4xx before acceptance, sending-limit 429 with its "until HH:MM") and **uncertain** (timeout, connection drop after write). Uncertain is never replayed; the engine reconciles by searching Sent for the Message-ID and only then offers Resend. Never retry a send on a rate error (D7).
- **Undo-send and send-later are one mechanism**: a `not_before` on the queued submission, durable across restarts (comail, Flectar, Superlocal, Stalwart).
- **Overdue while the Mac was off**: if now exceeds `not_before` by more than the grace (5 minutes by default for send-later), the submission becomes `suspended` with "Missed its time while your Mac was off: Send now or Reschedule." This is Bulwark's rule (`RC/arch/extra-bulwark-legacy-proxy.md` §6).

**Pending changes and sync agree** (`RC/SYNTH-architecture.md` §4.5). The store holds effective state, and each sync commit **replays pending ops over incoming provider state in the same transaction**, then drops items changed after the pre-call change sequence (mutation fence). This replaces the per-mutation clone and `touched` heuristics, gives rollback for free, and ends "the UI flips back". For Gmail, ops are per message and label, coalesced into `batchModify`.

**Drafts.** Local-first with a revision compare-and-set. Gmail: debounced autosave (about 5 seconds idle, since `drafts.update` costs 15 units), a content fingerprint to skip unchanged saves, serialized saves, and a map from the original draft id to its current one. IMAP: `APPEND` to Drafts and delete the previous copy via UIDPLUS `APPENDUID`. Graph and JMAP follow in M8. Drafts from another device show as drafts, not messages (D9).

**One timer loop** sleeps until the next deadline over `submissions.not_before` and `thread_workflow.reminder_at` (Later wake-ups, reminders, later follow-ups), replacing the 30 s `setInterval` and ad-hoc send timers in `service.ts`. On launch and wake it catches up: Later and reminders fire late and say "was due 9:00"; sends follow the suspend rule. Notifications use a durable outbox keyed by message, so a crash cannot duplicate them and a second client can later claim them.

> **What this means:** Sending stays double-send safe. Scheduled sends and reminders survive restarts. If your Mac was off when a message was due, Aplos asks instead of sending it hours late.

## 6. AI pipeline

AI never blocks sync or display. Groq stays the default provider, with BYO keys and local servers as in AGENTS.md; the engine reads keys from the environment or the encrypted settings store and never logs them.

- **Interactive work** (Ask, draft, polish, transcribe, "summarize this thread") is streamed and cancellable, outside the queue, but counted in `ai_usage`.
- **Background enrichment** (summary, importance, reply state for incoming threads) runs in the durable `jobs` queue: singleton key `(summary, thread_id, input_hash)`, exponential backoff, dead letter after five attempts, one or two jobs per provider. `input_hash` is content-keyed, so a label change does not invalidate a summary (`RC/gaps/engine-contract-rpc-stack.md` §5.3).
- **Heuristics first, so Home works with AI off.** A deterministic bucket (`important`, `normal`, `low`) is computed at ingest from `List-Unsubscribe`, `Precedence: bulk`, `Auto-Submitted`, no-reply senders, Gmail category and `IMPORTANT` labels, direct-versus-cc recipient, known correspondent (the user has written to them) and an existing user reply. Bucket plus `rank_source` (`heuristic`, `ai`, `rule`, `user`) is stored. AI may later move a bucket, a thread is never held back waiting for it, and user choices win. Buckets rather than scores stop Home reshuffling under the cursor (`RC/gaps/engine-contract-rpc-stack.md` §3.3).
- **Budget.** `ai_usage` tracks requests and tokens per provider per day. A daily cap (default tuned to Groq's free tier, about 200k tokens a day per `research/inbox-zero/SYNTHESIS.md`) stops background work and says so. Order: visible and unread newest Inbox threads first, never Spam or Trash. 429s honor `Retry-After`; a daily-token 429 stops the queue until reset.
- **Consent.** A versioned consent card appears before the first background pass and names the provider and what is sent. A scope change bumps the version and turns background AI off until reconsent. There is a per-account "Send this account's mail to AI" toggle. Providers carry a `trainsOnInputs` flag: unpaid Gemini trains on inputs [V], so Gmail content never goes there in the background (`proto-google.md` §0.6). Persisted consent replaces the in-memory `deferAI` set whose leaks the PR #21 review found (`research/pr21-onboarding-review.md`): enqueueing depends on stored consent, so nothing needs clearing. PR #21 is not merged by this plan.
- **Safety.** Background jobs run without tools. Model output is data: proposed actions pass through the existing proposals step and need a click, which also meets Google's per-invocation consent and prompt-injection expectations.

> **What this means:** Home orders your mail sensibly even with AI switched off. Summaries arrive afterward, within a daily budget, and only after you agree to what is sent where.

## 7. UI-to-engine contract and transport

Adopt `RC/gaps/engine-contract-rpc-stack.md` in full.
- **Semantics:** JMAP-style verbs (`get`, `changes`, `set`, `query`), opaque per-type state strings, `cannotCalculateChanges`, client-generated ids and an `ifInState` guard. **Wire:** `{v, id, method, args}` per call with ID-only push frames; over HTTP, `POST /v1/call/<Type>/<verb>`. No JMAP batch envelope (Swift codegen handles tuples poorly).
- **Live windows, not `queryChanges`:** the engine re-runs each open view's keyset query after relevant commits, coalesced, and pushes `{windowId, state, ids, total, changed}`. At 100k threads a 100-row window costs 0.12 ms versus 39 ms and 1.2 MB for a full id list [M].
- **Schema:** zod v4 in a platform-neutral `contract` module with a thin in-house registry (about 500 lines) that emits the allowlists, a typed client by inference, validators and an OpenAPI 3.1 document. oRPC is the runner-up once v2 is GA.
- **Binary data** moves as transferable `ArrayBuffer` or blob routes, never base64.
- **Transports:** main creates a `MessageChannelMain` and gives one port to the engine and one to each window, so calls skip main. Main keeps only native methods and drops its `latestState` mirror (the Dock badge comes from engine counters). Browser preview, CLI and MCP use the A0 binding (§10).

**Staged migration** (steps from the same report §7): (1) registry with today's method names, generated allowlists and one test that all hosts agree, 2-3 days, no wire change; (2) typed client and validators, one method at a time, keeping human error messages, 3-5 days; (3) persisted `changes`, with `epoch` becoming `dbEpoch` and `rev` the persisted `seq`, still emitting old-style frames, and one coarse entry per page during backfill; (4) windows, 1.5-3 weeks: move `threadInView` and `isHomeNew` into SQL view specs, add `View/watch`, replace `createLiveState`'s whole-array model with an id list plus row cache.

**Compat shim for the old renderer** (3-4 days): `state.get` and `threads.page` serve body-less thread rows from SQL and the Reader fetches text through a new `message.body` call. The new UI will not land before week six, but the owner needs a working app by week five. The shim and `latestState` go away when the new UI consumes windows.

**Coordination with the UI thread.** Freeze the contract and a fixture engine (existing demo data) at the end of M1 so the UI thread builds against windows without waiting for the store.

> **What this means:** The window and the engine will talk through one clearly defined set of messages. Lists load a page at a time and update in place, so a huge mailbox feels the same as a small one.

## 8. Email HTML isolation

Use `RC/gaps/electron-email-html-isolation.md` §0 as written. Today's direct injection (`Reader.tsx:169`) puts hostile HTML in the process that holds Aplos's IPC, with a page CSP that allows `https:` images and inline scripts.

**Target (M4).** Serve each message from one custom origin, `aplos-mail://m/<token>`, via `protocol.handle`, into an **opaque, sandboxed iframe that allows exactly one hash-pinned script of ours** that reports height and paper colour by `postMessage` (gated on `innerWidth > 0`). The CSP is an HTTP response header (`default-src 'none'`, `img-src aplos-mail:`, `base-uri 'none'`, `form-action 'none'`, `frame-src 'none'`), and email scripts stay blocked by the hash [V]. All mail frames share one extra out-of-process renderer (+25-35 MB for a 20-message thread), away from the window holding the IPC port [V], and have no preload, so they cannot reach the engine.

**Where sanitizing runs.** The engine bundle is platform-neutral under a 400,000-byte budget (`RC/gaps/engine-contract-rpc-stack.md` §1), so no DOM library can live in it. Sanitizing is an engine-**host** capability: a pure-JS, parser-based allowlist in `engine-host.ts`, offered to main through the port like the existing `lookup` and `fetch` hooks. It strips `<link>` (DNS prefetch escapes CSP [V]), `<base>`, forms, meta refresh and scripts; drops tracking pixels (2 px or smaller, known trackers) and shows "N trackers removed"; rewrites cid images to `aplos-mail://m/<token>/cid/<n>`; and makes links `target=_blank`, with `will-frame-navigate` as a backstop. The sanitizer is hygiene; the sandbox and header CSP are the boundary.

**Remote images** are blocked by default and loaded per message or trusted sender through an engine-host image proxy: the frame never names a URL (it gets an index bound to the token); DNS is resolved once and rejected if any address is private, loopback, link-local, CGNAT, ULA, multicast or mapped; redirects are followed manually (at most 3, revalidated); ports 80 and 443 only; size and pixel caps; raster types only; no cookies or Referer.

**Keyboard.** Intercept shortcuts in main with `before-input-event` (trusted OS input), never forwarded from the frame. Whether it fires for out-of-process frames is **[U]** and must be hand-checked in the real app before M4 closes. Keep the frame focusable with `tabindex="-1"` so selection and copy work.

**Stopgap (M0, one day).** A same-origin `srcdoc` frame without scripts beats today's injection and is acceptable until M4 while the owner is the only user. It still decodes images in the privileged process, which is why M4 follows soon.


> **What this means:** Emails will render in a locked box that cannot touch the app or phone home. Remote images stay off until you allow them.

## 9. Observability and diagnostics

Aplos has none today (`RC/SYNTH-architecture.md` §9).
- **Rotating log files** in `~/Library/Logs/Aplos Mail/`, redacted at the root logger (no tokens, keys or bodies).
- **Ring buffer** per account and folder, snapshotted into every error shown in the UI.
- **Time-boxed verbose protocol log** (15 minutes, off by default, headers only).
- **Classified errors** stored as `{class, reason, code, retryAfter}` with Google's own reason, which would have told `userRateLimitExceeded` from `accessNotConfigured` on the first 403.
- **Diagnostics bundle**, content-free: versions, schema version, per-account status and cursor ages, governor stats, queue depths, recent classified errors, event-loop delay, DB and WAL sizes, FTS backlog, plus a queue inspector in Settings. Nothing is uploaded; crash minidumps stay local.
- **Heartbeats** per account actor restart wedged actors.

> **What this means:** When something sticks, Aplos will be able to say what and why, and you can share a safe report with no email content in it.

## 10. Security

**Electron hardening.** Fuses as in §1. Keep `contextIsolation`, `sandbox`, `assertCaller` and navigation lockdown. Remove `'unsafe-inline'` from `script-src` once email HTML leaves the page, and drop dev ports from production `connect-src`. Only a trusted window's main frame receives the engine port.

**Local listener (A0, M9)**, per `RC/SYNTH-architecture.md` §10:
1. A Unix socket, mode 0600, in a 0700 data directory (path under 104 bytes). HTTP on `127.0.0.1` only for browser preview and later phone pairing; never `0.0.0.0` by default.
2. A per-client token on every request (0600 token file, sent in a header, constant-time compare), never exposed to the renderer.
3. Allowlisted Host, exact Origin, no reflected CORS, DNS-rebinding protection. Today's dev `server.ts` has no token.
4. Typed, scoped operations only: no paths, sockets, SQL or protocol objects.
5. Token scopes `read`, `draft`, `send`, `admin`; a device list with revoke; an audit log for sends and deletes by non-UI clients; optional `LOCAL_PEERPID` check. The MCP adapter exposes `read` and `draft` methods; `send` and destroy need an explicit grant.

**Secrets.** The data key stays Keychain-wrapped via `safeStorage` in main; credentials and AI keys stay in their encrypted stores; nothing is printed, committed or bundled. The Google client id and secret are inlined into release builds from GitHub secrets, as today.

**Google policy.** Both Gmail scopes are restricted, so plan for verification and likely CASA now: brand verification, a privacy policy with the Limited Use statement, and a demo video (`proto-google.md` §8, §10.4). This is an external prerequisite, not engineering work.

> **What this means:** The local doorway is locked by default: only your own user account can use it, every tool needs a key, and risky actions need separate permission.

## 11. Multi-device and the phone

**Between Macs (now).** Keep the encrypted hidden-label channel for workflow state (Done, Later, todos, reminders), with fixes from `proto-google.md` §9: gate rounds on a cheap `history.list?labelId=<app label>` check (D17), paginate past 50 copies (D18), break ties by device id, not wall clock. Mailbox facts always come from the provider.

**Phone (later).** Build on A0 with phone-ready auth from day one: scoped per-device sessions, revocation and short-lived tickets (T3 Code's pattern, `RC/gaps/phone-mac-connectivity.md` §1.1, §7). The first phone is a **thin client** of the Mac engine over LAN plus Tailscale, paired by QR with a certificate fingerprint and one-time code. It needs no OAuth, AI keys or quota, which is its advantage over an engine per device (§5 there). A one to two day Swift codegen spike at the end of M9 proves the contract before a phone is scheduled.

**Deferred:** a hosted relay (candidate C), an engine on the phone (D) and the LaunchAgent (A1), per the answer to Decision 9.

> **What this means:** Your Macs can share Done and Later today. A phone app is possible later without redoing the engine, but it will only see mail while your Mac is awake.

## 12. Migration from today's code, step by step

Each step lists what changes, how the app stays usable, and the acceptance evidence required to check it off. Live acceptance uses real accounts; the browser preview and emulators only support development.

**M0: Make Gmail real (week 0-1, release 0.2.4).** In the old model only. Owner actions: confirm the Cloud console shows 6,000 units/min per user; switch the OAuth project to Production (unverified) so tokens stop expiring weekly (D4). Code: first window of about 40 threads at concurrency 1, no Spam or Trash, `quotaExceeded` not retried, `invalid_grant` becomes Reconnect, granted-scope check, server search only on Enter, the `srcdoc` HTML stopgap, a rotating redacted log. Acceptance: a real Gmail first sync completes and the log records any refusal reason. If the old thread model cannot hold a thinned window, skip the sync change, wait for M3, and record that in PROGRESS.md.

**M1: Platform groundwork (week 1-2).** Split `service.ts` (961 lines) along its seams (commands, sync, outbox, AI) with all 227 tests green first; this reduces merge conflicts between two architecture threads. Contract registry steps 1-2; fuses; macOS 13; resident mode; wake hooks; lockfile; `Uint8Array` and `iterate()` in the SQL port; sqlite-version CI check; freeze the contract and a fixture engine for the UI thread. Acceptance: closing the window keeps sync and reminders alive (checked in the packaged app); fuses confirmed in the packaged binary; the three-host allowlist test passes.

**M2: New store (week 2-3).** Create `mail.db` (§2), import from `aplos.db`, build the compat assembler and `message.body`, the persisted change log with `dbEpoch`, the paced FTS job and the bodies table. Acceptance: an original benchmark script under `scripts/` shows first page under 1 ms and unread counts under 5 ms at 200k messages; killing the engine mid-import resumes; a restart no longer re-snapshots windows; the rollback drill restores `aplos.db`; a replay test proves `snapshot(seq0) + changes == snapshot(seqN)` over random ops (Bulwark shipped two).

**M3: Governor and Gmail rewrite (week 3-5, release 0.3.0).** Governor, taxonomy and status vocabulary; per-account actors; Gmail P0-P5; history incremental; generation sweep; per-message labels and ops; `needsReauth`; device-aware budget. Acceptance (live, real account): first 50 threads in under 15 s, 500 threads in about 3 minutes, zero 403s; killing the app mid-backfill resumes; a bulk archive in Gmail web costs under 100 sync units; the log shows classified errors. **This is the Gmail daily-driver gate.**

**M4: Windows and HTML isolation (week 4-6, overlapping M3).** Contract steps 3-4 with the UI thread; remove main's `latestState`; `aplos-mail://` frames, sanitizer, image proxy. Acceptance: shortcuts work with focus inside a mail frame (hand-verified); the report's hostile-HTML vectors leak nothing; a 100k-thread fixture reads through a bounded window.

**M5: AI queue, heuristic Home, consent (week 5-6).** `jobs`, `ai_usage`, rank buckets, consent card, `trainsOnInputs`, `deferAI` removed. Acceptance: with AI unreachable Home is still ordered; no AI job is enqueued before consent; a Groq 429 pauses the queue and says why; the PR #21 close-at-any-moment scenarios pass as tests.

**M6: Outbox, drafts, timers (week 6-7).** `submissions`, uncertain handling, Gmail and IMAP drafts, one timer loop, notification outbox. Acceptance: kill the engine before the marker, after the marker, and after provider accept, with no duplicate and no silent loss (emulated provider, plus one real send to an owner-controlled address); overdue-while-off suspends.

**M7: IMAP, iCloud, JMAP, CalDAV (week 7-8).** Two-connection IMAP actors, capability-driven sync, `imapflow` upgrade, EventSource, CalDAV sync tokens with client-side recurrence. Acceptance (live, owner's iCloud and Fastmail): new mail appears within seconds, a phone archive arrives, iCloud stays at two connections or fewer, and a long sync never blocks triage. **This is the multi-provider daily-driver gate.**

**M8: Graph and calendars (week 8-9).** Graph scheduler and unfiltered delta (dark until a client id exists), Google Calendar sync tokens and `patch`, Graph and JMAP drafts. Acceptance: emulator proof of Graph's concurrency and 429 handling; live Calendar edits no longer wipe fields.

**M9: Listener and diagnostics (week 9-10).** A0 socket and token auth, HTTP binding, OpenAPI golden-file test, MCP adapter (read, draft), diagnostics bundle, queue inspector, Swift spike. Acceptance: unauthorized and wrong-Origin requests are refused; revoking a token is immediate; the OpenAPI diff test runs in CI.

**M10: Hardening and release (week 10-11, release 0.4.0).** Seven-day soak with sleep/wake and battery cycles; fault injection (network drops, 403/429 storms, corrupt page, disk full); update test on a second Mac; rollback drill; compat shims removed. Acceptance: zero duplicate sends, zero ghost threads after a deliberate cursor expiry, flat memory over 24 hours, a clean 0.3.x to 0.4.0 update.

**Usability throughout.** Releases 0.2.4, 0.3.0 and 0.4.0 are the checkpoints; every intermediate build stays launchable through the compat layer, and `aplos.db` stays until 0.4.0 is stable.

> **What this means:** There is never a "big bang". After about five weeks you have a Gmail app you can live in, and each later step adds a provider or a safety feature without breaking what already works.

## 13. Effort

For one owner plus AI agents, split across two architecture threads. Thread S owns store, sync, governor and providers (M2, M3, M7, M8). Thread P owns platform, contract, HTML, AI, outbox and listener (M1, M4, M5, M6, M9). Code is not the constraint (169 commits in 11 days); live verification and external prerequisites are.

Calendar weeks per phase: M0 0.5-1; M1 1; M2 1-1.5; M3 2 (the hard part, includes live verification); M4 2 (overlapping, gated by the UI thread); M5 0.5-1; M6 1; M7 1.5-2 (iCloud facts verified live); M8 1 (Graph dark until a client id exists); M9 1; M10 1 (seven-day soak).

**Total about 11 weeks nominal (range 9-14).** Gmail daily-driver at about week 5; Gmail plus iCloud and Fastmail at about week 8. The foundation items match the research's own 6-10 week estimate for F plus 1-2 weeks for A0 (`RC/SYNTH-architecture.md` §11).

> **What this means:** Roughly eleven weeks end to end, with a usable Gmail app at about five. The dates move mostly when we wait on Google, Microsoft or Fastmail.

## 14. Top risks

1. **Live verification and external prerequisites.** Google Testing mode (7-day tokens), no Microsoft client id, Fastmail OAuth registration, likely CASA. Mitigation: owner actions in M0; Graph ships dark.
2. **The 403 may have a second cause.** The real reason was never read (`RC/SYNTH-architecture.md` §12.2). Mitigation: M0 logs classified reasons; M3 acceptance is live.
3. **Change-log bugs.** Bulwark shipped two. Mitigation: the replay property test, coarse backfill entries, an explicit floor with `cannotCalculateChanges`.
4. **Two threads colliding in `service.ts`.** Mitigation: split first (M1), contract freeze, one owner per module.
5. **Quota shared across Macs and a future phone.** Mitigation: the device-aware budget; a thin phone avoids it.
6. **`node:sqlite` is a release candidate and follows Electron's SQLite.** Mitigation: CI version check; one-file swap to better-sqlite3 [V storage benchmark §7].
7. **Out-of-process frame keyboard routing is unverified.** Mitigation: hand-check before M4 closes.
8. **Private repo breaks the update feed.** Mitigation: Decision 10.
9. **Listener security mistakes** are the commonest failure here (`RC/SYNTH-architecture.md` §0.10). Mitigation: §10 as acceptance criteria, plus a review before LAN or phone exposure.

> **What this means:** The biggest risks are waiting on other companies and subtle bugs in the change tracking. Both have specific tests and owner actions attached.

## Decisions for you

1. **How much mail should the first sync fetch?** (a) Newest 500 Inbox threads fast, plus 30 days of Sent, then idle backfill to 90 days **(recommended)**; (b) 14 days only; (c) everything. (a) shows the Inbox in seconds, with older mail a search away. (b) hides history. (c) takes hours under Google's limit and wastes quota on mail you may never open.
2. **Which Gmail permission should Aplos ask for?** (a) Today's level, REST only **(recommended)**; (b) add the broader permission for faster bulk sync and free "new mail" signals. (a) adds no warning and works once the governor exists, but backfills big mailboxes slowly. (b) is faster but the consent screen says "permanently delete all your email" and needs a second code path. Decide before Google verification.
3. **Should closing the window keep Aplos running in the menu bar?** Yes, with ⌘Q and a menu item to quit fully **(recommended)**; or no. Yes keeps mail, reminders and scheduled sends working. No is simpler, but sync stops with the window.
4. **Encrypt the database beyond FileVault?** No, rely on FileVault and owner-only permissions **(recommended)**; or yes. No costs no speed. Yes guards against other programs under your login and unencrypted backups, but slows writes 2-4x and uncached reads up to 14x, and needs a driver change.
5. **How much message text stays on this Mac?** 90 days plus anything opened, starred or unread, capped at 2 GB **(recommended)**; everything forever; or a smaller cap. Everything gives full offline reading but grows to many GB. A cap means old mail re-downloads when opened, costing a little Google quota.
6. **Move the Google sign-in project from Testing to Production (unverified) now?** Yes **(recommended)**; or wait for verification. Yes stops 7-day sign-in expiry but shows an "unverified app" screen and caps users at 100. Waiting keeps the clean screen but means weekly reconnecting.
7. **Block remote images in emails by default?** Block until you allow per message or sender **(recommended)**; or always load through the safe proxy. Blocking stops tracking pixels reporting that you read a message. Loading looks nicer but leaks that.
8. **If your Mac was off when a scheduled message was due?** Pause and ask **(recommended)**; or send it on wake. Asking avoids stale messages hours late; sending is simpler but can surprise you.
9. **When should the phone start?** After the menu-bar engine and local doorway are solid, as a thin app talking to your Mac **(recommended)**; or earlier, with its own engine. Waiting makes the phone cheap and avoids sharing Google's limit, but it only sees mail while your Mac is awake. Earlier works when the Mac sleeps but multiplies quota use and work.
10. **Where do updates come from while the repository is private?** Signed builds on a separate public releases repository **(recommended)**; or open-source sooner. A separate repository fixes download and auto-update links without exposing code. Going public sooner needs a secrets and licence review first.
11. **Ship the quick 0.2.4 patch before the rebuild?** Yes **(recommended)**; or skip to the rebuild. Yes gives real Gmail evidence and a safer reader within a week for a few days of throwaway work. Skipping saves those days, but real mail waits about five weeks.

## Evidence index

- `research/email-clients/SYNTH-architecture.md` (§0-§11), `gaps/storage-engine-benchmark.md`, `gaps/engine-contract-rpc-stack.md`, `gaps/macos-daemon-lifecycle.md`, `gaps/electron-email-html-isolation.md`, `gaps/phone-mac-connectivity.md`, `protocols/proto-google.md` (defects D1-D25), `protocols/proto-others.md` (§7-§8), `arch/pimalaya.md`, `arch/deltachat-core.md`, `arch/extra-bulwark-legacy-proxy.md`, `research/inbox-zero/SYNTHESIS.md`, `research/pr21-onboarding-review.md`.
- Aplos code read on main at `72095ff`: `apps/desktop/src/engine/{ports,sql,gate,store,service}.ts`, `src/main/{store,engine-host}.ts`.
- Overriding facts: Developer ID signing exists, provisioning profiles do not, the repository is private, Google is in Testing mode, Microsoft has no client id, and the first Gmail sync failed with 403.
