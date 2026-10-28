# Aplos Mail target architecture (definitive)

Chief architect's decision document, 2026-10-27, branch `revamp`. Planning only: nothing here is implemented, and nothing from this phase goes to main. It supersedes the three proposals in `plans/proposals/arch-*.md` where they disagree.

**Conventions.** `RC/` means `research/email-clients/`. Evidence labels: **[V]** verified by a research report (path given) or by me against that report; **[C]** a project's own claim; **[I]** inference; **[U]** unverified, to be checked live. Unlabelled statements are design decisions made here. Where the research conflicts with `plans/_council/CONTEXT.md`, CONTEXT wins: Aplos releases are Developer ID signed and notarized (team VW9NDM428H); provisioning profiles do not exist yet; the repository is private; Google OAuth is in Testing mode; Microsoft has no client ID; the first real Gmail sync failed with 403.

## In plain English

Aplos has never finished syncing a real Gmail account. Google caps the work an app can do per person per minute. Aplos asks for about ten minutes of work at once, Google refuses, and Aplos starts over. The app also keeps the whole mailbox in memory, forgets changes on restart, and stops fetching mail when you close the window.

This is the final plan for the engine, the part that talks to your mail providers and stores your mail. It repairs the existing engine in place instead of rebuilding it.

What changes for you. There is no separate quick fix. The Gmail fix is part of the rebuild, which ships as one redesigned version. The shared rules freeze in about three days, and Gmail passes live checks on test accounts by day 15. Closing the window keeps Aplos in the menu bar, so mail, reminders and scheduled sends keep working.

Gmail stays in Google's Testing mode, so you reconnect once a week. Nothing here costs money.

What stays the same. No Aplos server holds your mail, Groq stays the default AI, and nothing syncs while your Mac sleeps.

Questions 1, 2, 3, 11 and 12 below have answers. The other ten keep their defaults.

> **What this means:** Gmail works well on your own mail by about day 15.

## 0. How the winner was chosen

**Inputs.** Three proposals: `plans/proposals/arch-evolve.md` (repair in place, resident menu-bar app, listener late), `plans/proposals/arch-localserver.md` (local server first, A0 → A1 LaunchAgent → A2 phone), `plans/proposals/arch-portable.md` (engine on every device, Candidate D). Two judges ranked them the same way: evolve, then local server, then portable (`plans/_council/judge-arch-deepseek.md` 8.7/7.5/6.5; `plans/_council/judge-arch-mimo.md` 26/24/21).

**My own check.** I re-read the evidence the free-model judges cite instead of trusting their scores. The numbers hold: 6,000 units per user per project per minute and the new prices (`RC/protocols/proto-google.md` §1.1); 0.04-0.07 ms list pages (`RC/gaps/storage-engine-benchmark.md` §0); 0.12 ms windows against 39 ms full ID lists at 100k threads (`RC/gaps/engine-contract-rpc-stack.md` §3.2); 53 MB idle footprint today against 17 MB for a Node daemon (`RC/gaps/macos-daemon-lifecycle.md` §2). Two research claims are outdated: A1 is blocked on a provisioning profile and on need, not on signing (daemon report §0.3 predates CONTEXT); and phone-to-desktop-host has strong precedent outside email (`RC/gaps/phone-mac-connectivity.md` §0 overturns `RC/SYNTH-architecture.md` §0.3).

**Why evolve wins.** Sync quality comes from the data model and the governor, not the topology, and the 6-10 week foundation is the same for every topology (`RC/SYNTH-architecture.md` §2, §0.4). So the deciding questions are: which plan gets real Gmail working soonest, which keeps local edits and incoming mail in agreement, and which leaves risky choices late and reversible. Only evolve answers all three: an early Gmail fix inside the rebuild, a replay-plus-fence model for effective state (§4.5 there) that the local-server plan omits, and a purely additive B → A0 → A1 path (§11.5).

**What is grafted in.**

| From | Idea | Where |
|---|---|---|
| Local server | Staged A0 → A1 → A2 path, A1 packaged as a Node single-executable helper, never the Electron binary | §2 |
| Local server | Listener security matrix, tokenised browser preview, SSE resume with `Last-Event-ID` and `reset` | §9, §12 |
| Local server | Version handshake and update-drain choreography | §2 |
| Portable | `packages/engine` and `packages/contract` as real workspace packages; BLOBs in the SQL port | §9, §16 ADR-19 |
| Portable | Cross-device coordination by lease instead of evolve's divide-by-devices floor | §6.5 |
| Portable | Per-device connection discipline for iCloud | §13 |
| Judges | Keep the provider's original body form so sanitizer fixes reach old mail without spending quota | §3.3 |

**What is rejected.** The portable plan as a target (shared Gmail quota, months of phone work, CloudKit profiles, leases failing open; `RC/gaps/phone-mac-connectivity.md` §5); the local-server plan's ordering, which bundles resident mode with the listener and so delays timed features until late in the build; any LaunchAgent before a real need.

> **What this means:** We take the plan that gets real Gmail working first and stops changes flipping back, then borrow the best ideas from the other two.

## 1. System diagram

```
                         ┌──────────────────────── Aplos Mail.app (Electron, signed + notarized) ─────────────────────────┐
                         │                                                                                                 │
  macOS ──powerMonitor──►│  MAIN PROCESS                                                                                   │
  Keychain ◄─safeStorage─│  windows · menus · menu-bar item · notifications · updater · Keychain unwrap of data key       │
  Login item ───────────►│  aplos-mail:// protocol handler · before-input-event keyboard relay · crash/park supervisor     │
                         │      │ creates MessageChannelMain per window            │ forwards body/cid/img requests         │
                         │      ▼                                                  ▼                                        │
                         │  RENDERER (React UI)  ◄══ direct MessagePort ══►  ENGINE (utilityProcess, sole writer)          │
                         │   live windows, row cache                          ┌──────────────────────────────────────────┐  │
                         │   ┌────────────────────────┐                       │ contract registry (zod) · session/handshake│  │
                         │   │ MAIL FRAME (OOPIF)     │◄── aplos-mail://m/<t> │ account actors ─► governor ─► adapters     │  │
                         │   │ opaque, sandboxed,     │    (headers CSP)      │   Gmail REST · Graph · IMAP×2 · JMAP · DAV │  │
                         │   │ one hash-pinned script │                       │ ops queue · submissions · timer loop       │  │
                         │   └────────────────────────┘                       │ jobs (AI, FTS, prefetch) · AI governor     │  │
                         │                                                    │ mail-html sanitizer · image proxy          │  │
                         │                                                    │ change log · window engine · diagnostics   │  │
                         │                                                    └───────────────┬──────────────────────────┘  │
                         └────────────────────────────────────────────────────────────────────┼─────────────────────────────┘
                                                                                              │
              mail.db (SQLite WAL, 0600)  ◄──────────────── one writer ───────────────────────┤
              attachments/.noindex/ (files) · logs ~/Library/Logs/Aplos Mail/                  │
                                                                                              │
   A0 (M9):  ~/Library/Application Support/Aplos Mail/run/engine.sock (0600) + token ◄── CLI, MCP agent
             127.0.0.1 HTTP + SSE, token + Host/Origin checks             ◄── browser preview
   A2 (later): HTTPS over LAN / Tailscale, QR pairing, per-device sessions ◄── thin phone client
   A1 (deferred): same engine as a Node SEA LaunchAgent; main proxies over the socket

   Providers: Gmail API (6,000 units/user/min) · Graph (4 in flight/mailbox) · iCloud IMAP+CalDAV · Fastmail JMAP+CalDAV
   AI: Groq default; BYO OpenAI, Claude, Gemini (paid only for mail), OpenRouter, OpenCode Go, Ollama, LM Studio, custom
```

> **What this means:** One main process owns your mail database and every connection. Windows and other tools ask it for everything.

## 2. Process topology and lifecycle

### 2.1 Stages

| Stage | Owner of `mail.db` | Clients | Survives window close | Survives ⌘Q | When |
|---|---|---|---|---|---|
| **B (now)** | Engine `utilityProcess` | Electron windows over MessagePort | Yes, resident menu-bar mode | No | M1 |
| **A0** | Same process | + CLI/MCP over Unix socket, browser preview over loopback HTTP | Yes | No | M9 |
| **A1 (deferred)** | Node SEA in `Contents/Library/LoginItems/Aplos Mail Engine.app`, `SMAppService` agent | Main proxies over the socket | Yes | Yes | Only on trigger (§2.6) |
| **A2 (later)** | A0 or A1 | + paired phone over LAN/Tailscale | — | — | Decision 10 |

This is Candidate B growing into A0 (`RC/SYNTH-architecture.md` §11). Each stage reuses the previous one; nothing is thrown away.

### 2.2 Resident mode (M1)

Following `RC/gaps/macos-daemon-lifecycle.md` §9:
- Closing the last window keeps main and the engine alive. With no window, switch to the accessory activation policy (no Dock icon). A menu-bar item shows sync state and offers Open Aplos, Pause sync for 1 hour, and Quit Aplos completely. ⌘Q is a full quit, as in Mail.
- If the login item launched the app (`wasOpenedAtLogin`), start with no window.
- ⌘Q with pending scheduled sends or reminders shows: "2 scheduled messages will not send while Aplos is closed. Quit anyway?"
- Idle cost with no window is about 53 MB phys_footprint across four processes [V `RC/gaps/macos-daemon-lifecycle.md` §2]. Acceptable; A1 would cut it to about 17 MB.

### 2.3 Startup sequence

1. Main takes the single-instance lock, unwraps the data key with `safeStorage` (unchanged, DECISIONS 2026-10-16 M26) and forks the engine.
2. The engine takes `run/aplos.lock` (pid, start time; stale locks from dead pids are reclaimed), so a second engine on the same data refuses to start. Browser preview keeps its own data directory.
3. The engine opens `mail.db` and runs migrations or the one-time import (§3.8). Clients see `starting` until then, never half-migrated data.
4. Recovery: submissions in `sending` become `uncertain` and queue a Sent check; `running` jobs return to `queued`; the timer loop computes overdue items (§7.5).
5. The engine reports `ready {apiVersion, appVersion, schemaVersion, dbEpoch}`. Main creates a `MessageChannelMain` per window and transfers one port to each side. Windows call `Session/get`, then `View/watch`.
6. Account actors start with 0-3 s jitter after reading their persisted cooldowns, so a restart never hammers a paused account.

### 2.4 Shutdown, wake, crash

- **Drain on ⌘Q or update** (3 s deadline): stop accepting calls, let an in-flight send finish or mark it `uncertain`, checkpoint the WAL, release the lock, exit.
- **Wake:** `powerMonitor` `resume`/`unlock-screen` → `engine.wake()`; a wall-clock jump over 30 s between 1 s ticks also counts. Then wait for the network, reconnect IMAP and EventSource sockets with jitter, run one incremental pass per account, and let timers catch up (`RC/gaps/macos-daemon-lifecycle.md` §5).
- **Crash:** keep today's guard (more than 3 exits in 60 s, `electron.ts:243-250`) and add a **parked** state with "Export diagnostics / Try again". An event-loop-delay monitor logs p99 over 500 ms; account actors heartbeat every 30 s and a silent actor is restarted alone after 2 minutes.
- **Sleep:** nothing runs; Power Nap gives third-party apps no documented time on Apple silicon [V `RC/gaps/macos-daemon-lifecycle.md` §5].

### 2.5 Hardening that ships with resident mode

`minimumSystemVersion` 12.0 → 13.0 (Electron 44 already requires 13; today's plist is a latent bug [V `RC/gaps/macos-daemon-lifecycle.md` §0.1]). Fuses: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` off; `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` on. Verify `utilityProcess.fork` and the `aplos-symbols` tool still start in the packaged app.

### 2.6 A1 (LaunchAgent): deferred, kept cheap

**Triggers** (any one): "sync after ⌘Q" becomes a daily annoyance; an agent needs the engine with the UI quit; a phone needs a host that outlives the UI. **Shape:** Node SEA (`execArgvExtension:"none"`) in a nested `LSBackgroundOnly` bundle, an N-API shim for Keychain, notifications and wake, a shared Keychain access group, update choreography drain → exit → `quitAndInstall` → launchd restart, and a version handshake per connection. 3.5-5 weeks after A0, blocked on a provisioning profile (`RC/gaps/macos-daemon-lifecycle.md` §2(c), §4, §9). Never a windowless Electron copy: Squirrel aborts updates while it runs [V §2(a)]. **Kept cheap now** by a lint rule against Electron imports in `packages/engine`, the single-writer lock, a `KeyProvider` port and engine-only migrations.

> **What this means:** Closing the window no longer stops your mail. Quitting still does, which is fine for now.

## 3. Storage

### 3.1 Decisions

- **A new file, `mail.db`, next to today's `aplos.db`.** A fresh file allows `auto_vacuum=INCREMENTAL`, which cannot be added later without a full `VACUUM`, and keeps `aplos.db` as an untouched rollback copy until the redesigned release is stable.
- **Driver: `node:sqlite`.** better-sqlite3 is only 6-8% faster on commits and the switch is now one adapter file [V `RC/gaps/storage-engine-benchmark.md` §0.3, §6]. Extend the `SqlDatabase` port with `Uint8Array` values and `iterate()`. CI asserts `sqlite_version()` ≥ 3.43 and FTS5 present, because `node:sqlite` follows Electron's SQLite (§7 there). Switch to better-sqlite3 only if encryption is required, the engine moves to a runtime whose SQLite we do not control (A1's SEA), or `node:sqlite` regresses.
- **Ids.** Contract ids stay strings (`accountId:remoteId` for threads), so the roughly 60 renderer call sites keep working. Internally every row has an integer rowid. **Message rowids are date-ordered**: `internal_date_seconds × 4096 + n`, which turns newest-first search into `ORDER BY rowid DESC` (0.05 ms instead of 32-40 ms [V storage §0.5]). Use the provider's internal date, never the `Date:` header, and treat the id as opaque.

### 3.2 Schema

All tables `STRICT`. Pragmas at open: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `journal_size_limit=67108864`, `temp_store=MEMORY`; `auto_vacuum=INCREMENTAL` at creation.

```sql
-- Engine plumbing
meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)
  -- db_epoch (UUID per creation/restore), change_floor_seq, imported_from, consent_version
changes(seq INTEGER PRIMARY KEY, type TEXT NOT NULL, id TEXT NOT NULL,
        op TEXT NOT NULL CHECK(op IN ('u','d','*')))            -- '*' = coarse "type changed in account id"
  INDEX changes_type ON changes(type, seq)

-- Accounts and folders (labels and folders share one table)
accounts(id TEXT PRIMARY KEY, provider TEXT NOT NULL, address TEXT NOT NULL, display_name TEXT,
  capabilities TEXT NOT NULL,            -- JSON: labels, drafts, serverSearch, calendar, filters, push
  granted_scopes TEXT,                   -- JSON array, from the last token response (D5)
  status TEXT NOT NULL, status_reason TEXT, status_detail TEXT, resume_at INTEGER,
  baseline_done_at INTEGER,              -- silent-baseline marker: notifications/AI only after this
  ai_allowed INTEGER NOT NULL DEFAULT 0, primary_lease_until INTEGER, settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
folders(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE,
  remote_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT,  -- inbox|sent|drafts|trash|spam|archive|starred|important|all
  kind TEXT NOT NULL,                    -- label|folder|system
  sync_scope TEXT NOT NULL DEFAULT 'lazy', -- live|backfill|lazy|none
  uidvalidity INTEGER, hidden INTEGER NOT NULL DEFAULT 0, UNIQUE(account_id, remote_id))

-- Mailbox facts (provider truth with pending ops replayed over it, §4.3)
threads(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, remote_id TEXT NOT NULL,
  subject TEXT, snippet TEXT, participants TEXT,          -- JSON, at most 6
  first_date INTEGER, last_date INTEGER NOT NULL, last_inbound_date INTEGER,
  msg_count INTEGER NOT NULL, unread_count INTEGER NOT NULL, flagged INTEGER NOT NULL,
  has_attach INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0,  -- all messages known locally
  list_unsub TEXT, rev INTEGER NOT NULL, UNIQUE(account_id, remote_id))
messages(id INTEGER PRIMARY KEY,                          -- date-ordered, see §3.1
  account_id TEXT NOT NULL, thread_id INTEGER NOT NULL REFERENCES threads,
  remote_id TEXT NOT NULL, internet_id TEXT, in_reply_to TEXT, refs TEXT,
  from_addr TEXT, from_name TEXT, to_json TEXT, cc_json TEXT, reply_to TEXT, subject TEXT, snippet TEXT,
  date INTEGER NOT NULL, internal_date INTEGER NOT NULL, size INTEGER,
  flags INTEGER NOT NULL DEFAULT 0,      -- seen|flagged|answered|draft|from_me
  hdr INTEGER NOT NULL DEFAULT 0,        -- bulk|list|auto_submitted|noreply|direct_to_me|cc_me
  list_unsub TEXT,
  parts INTEGER NOT NULL DEFAULT 1,      -- meta|text|html|fts|attach_listed|evicted
  origin TEXT NOT NULL DEFAULT 'sync',   -- sync|search|local
  first_seen_seq INTEGER NOT NULL, last_read_at INTEGER, rev INTEGER NOT NULL,
  UNIQUE(account_id, remote_id))
  INDEX messages_thread ON messages(thread_id, id)
  INDEX messages_iid ON messages(account_id, internet_id)
message_folders(message_id INTEGER NOT NULL, folder_id INTEGER NOT NULL, uid INTEGER,
  PRIMARY KEY(message_id, folder_id)) WITHOUT ROWID          -- Gmail labels and IMAP/JMAP/Graph placements
  INDEX mf_folder ON message_folders(folder_id, uid)
thread_folders(folder_id INTEGER NOT NULL, last_date INTEGER NOT NULL, thread_id INTEGER NOT NULL,
  unread INTEGER NOT NULL, PRIMARY KEY(folder_id, last_date, thread_id)) WITHOUT ROWID  -- keyset lists
  INDEX tf_thread ON thread_folders(thread_id)
  INDEX tf_unread ON thread_folders(folder_id) WHERE unread > 0      -- 0.5 ms counts
bodies(message_id INTEGER PRIMARY KEY, codec INTEGER NOT NULL,     -- 0 raw, 1 zstd-3, 2 gzip
  raw_size INTEGER NOT NULL, data BLOB NOT NULL)                    -- provider-original body record, §3.3
attachments(id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, remote_part TEXT NOT NULL,
  name TEXT, mime TEXT, size INTEGER, cid TEXT, inline INTEGER NOT NULL,
  path TEXT, state TEXT NOT NULL)        -- absent|fetching|present|evicted; files under attachments/.noindex/
messages_fts USING fts5(subject, people, body, content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2')                          -- rowid = messages.id
correspondents(address TEXT PRIMARY KEY, name TEXT, sent_to INTEGER NOT NULL DEFAULT 0,
  received_from INTEGER NOT NULL DEFAULT 0, last_sent_at INTEGER)   -- heuristic Home + autocomplete

-- App-owned data: its own feed, never mixed into provider facts
thread_workflow(thread_id INTEGER PRIMARY KEY REFERENCES threads ON DELETE CASCADE,
  account_id TEXT NOT NULL, sync_key TEXT NOT NULL,  -- host thread id, or root Message-ID for IMAP (M29)
  status TEXT NOT NULL,                  -- new|done|later
  later_until INTEGER, due_date TEXT, due_source TEXT, -- user|structured|ai, in that order of trust
  reminder_at INTEGER, reminder_fired_at INTEGER,
  bookmarked INTEGER, reply_status TEXT, todo TEXT, hidden_from_home INTEGER,
  lane TEXT NOT NULL DEFAULT 'do',      -- do|update|low: Home's Do now, Important updates, Low importance (8.2)
  importance TEXT NOT NULL DEFAULT 'normal', -- important|normal; orders within a lane
  rank_source TEXT NOT NULL DEFAULT 'heuristic', ranked_at INTEGER, -- heuristic|ai|rule|user
  due_band INTEGER NOT NULL DEFAULT 3,  -- 0 overdue or today, 1 tomorrow, 2 within 7 days, 3 later or none; timer loop refreshes at local midnight
  last_date INTEGER NOT NULL,            -- denormalised from threads for the Home index
  edited_at INTEGER, edit_device TEXT, edit_gen INTEGER)
  INDEX home ON thread_workflow(status, lane, due_band, importance, due_date, last_date DESC, thread_id)
  INDEX timers_wf ON thread_workflow(reminder_at) WHERE reminder_at IS NOT NULL AND reminder_fired_at IS NULL
summaries(thread_id INTEGER NOT NULL, input_hash TEXT NOT NULL, model TEXT NOT NULL, text TEXT NOT NULL,
  action TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(thread_id, input_hash))
sender_rules(id INTEGER PRIMARY KEY, account_id TEXT, address_or_domain TEXT NOT NULL, action TEXT NOT NULL,
  remote_filter_id TEXT)                 -- mirrors Gmail filters / Graph messageRules where possible
conversations(...)                       -- Ask history, imported unchanged
settings(id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)

-- Durable work
ops(seq INTEGER PRIMARY KEY, op_id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL, kind TEXT NOT NULL,
  target TEXT NOT NULL, payload TEXT NOT NULL, base TEXT, state TEXT NOT NULL, -- queued|inflight|done|failed
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER, last_error TEXT, created_seq INTEGER NOT NULL)
drafts(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, thread_id INTEGER, revision INTEGER NOT NULL,
  data TEXT NOT NULL, remote_draft_id TEXT, remote_message_id TEXT, synced_revision INTEGER, updated_at INTEGER NOT NULL)
submissions(id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, account_id TEXT NOT NULL,
  internet_id TEXT NOT NULL,             -- stable Message-ID, never regenerated
  mime BLOB,                             -- exact bytes sent, kept until 'sent' is confirmed
  not_before INTEGER NOT NULL, state TEXT NOT NULL, -- queued|sending|sent|uncertain|failed|cancelled|suspended
  attempt_at INTEGER, error TEXT, error_until INTEGER)
  INDEX sub_due ON submissions(not_before) WHERE state = 'queued'
jobs(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL UNIQUE,  -- singleton, e.g. summary:<thread>:<hash>
  priority INTEGER NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,    -- queued|running|done|dead|skipped
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, last_error TEXT)
notifications(message_id INTEGER PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER NOT NULL, claimed_by TEXT)

-- Sync bookkeeping
sync_state(account_id TEXT NOT NULL, scope TEXT NOT NULL,  -- 'history', 'folder:<id>', 'cal:<id>', 'backfill:inbox'
  cursor TEXT, page_token TEXT, phase TEXT, oldest_loaded INTEGER, generation INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY(account_id, scope))
sync_failures(account_id TEXT NOT NULL, item TEXT NOT NULL, attempts INTEGER NOT NULL,
  next_retry_at INTEGER NOT NULL, last_reason TEXT, PRIMARY KEY(account_id, item))
governor_state(account_id TEXT NOT NULL, budget TEXT NOT NULL,  -- 'gmail', 'gcal', 'graph', 'ai:<provider>:<model>'
  target INTEGER, cooldown_until INTEGER, reason TEXT, daily_block_until INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, budget))
provider_memory(account_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(account_id, key))
ai_usage(day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, lane TEXT NOT NULL,
  requests INTEGER NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, PRIMARY KEY(day, provider, model, lane))
consent(scope TEXT PRIMARY KEY, version INTEGER NOT NULL, provider TEXT, granted_at INTEGER)

-- Calendar
calendars(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, remote_id TEXT NOT NULL, name TEXT, color TEXT,
  is_primary INTEGER, hidden INTEGER, read_only INTEGER, UNIQUE(account_id, remote_id))
events(id INTEGER PRIMARY KEY, calendar_id INTEGER NOT NULL, remote_id TEXT NOT NULL, etag TEXT,
  master_id INTEGER, recurrence TEXT, start_utc INTEGER, end_utc INTEGER, all_day INTEGER,
  data TEXT NOT NULL, ics TEXT, UNIQUE(calendar_id, remote_id))   -- masters + overrides; expansion on query

-- Listener (A0)
clients(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER)
audit_log(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, client_id TEXT NOT NULL, method TEXT NOT NULL, target TEXT)
```

**Rules that keep this correct.**
- **Thread rollups are a SQL aggregate over the thread's messages**, recomputed for touched threads in the same transaction, never taken from the incoming batch (Velo's bug, `RC/SYNTH-architecture.md` §5). Messages flagged `draft` are excluded from rollups (D9). A thread's folder memberships come from messages **not** in Trash or Spam, so one trashed reply no longer trashes the conversation (D8, `RC/protocols/proto-google.md` §9).
- **Counts count threads** through `tf_unread` (0.5 ms, against 26 ms for message joins [V storage §5.4]).
- Search results from the server are ordinary rows with `origin='search'`, excluded from folder lists, and garbage-collected after 7 days if never opened.

### 3.3 Bodies and attachments

**Decision: one compressed record per message holding the provider's original content, sanitized on every read.** The record is `{text, html (unsanitized), cidMap, quotedRanges}`, zstd-3 with a codec id per row (zstd is experimental in Node 24, so gzip and raw stay valid [V storage §6]). This settles a three-way disagreement: evolve stored only parsed output, which blocks re-rendering (judges); local server and portable wanted raw MIME, which drags attachments into the table (Gmail `format=raw` includes them); the isolation report wants sanitizing on read so fixes reach old mail (`RC/gaps/electron-email-html-isolation.md` §7). The unsanitized original gives re-render and re-index without the bloat. Raw MIME is fetched live only for "Show original" and `.eml` export; submissions keep their exact sent MIME until confirmed.

**Attachments** are files under `attachments/.noindex/`, fetched on open or save, served through blob routes, never base64 over IPC (`RC/gaps/engine-contract-rpc-stack.md` §1). Content-addressed body files are rejected: 32% more disk, 4.5x slower opens [V storage §0.4].

### 3.4 Full-text search

One contentless FTS5 table in the main database (a separate file loses atomicity with `changes` [V storage §6]), `detail=full`, no prefix index. Subject and people indexed in full; body text capped at 16 KB (18% smaller index, 9-20% fewer deep hits). Indexing is a **paced job** of 100 messages per batch, FTS rows inserted last in each transaction (1.5-1.8x faster [V storage §5.1]), so triage never waits behind a 45-136 ms sync commit. Local search runs as you type; **server search only on Enter** (about 500 units for 25 results, against about 12,000 per pause today, D2).

### 3.5 Change log

`changes` is written in the same transaction as every store write, from the `StoreDiff` the store already computes (`RC/gaps/engine-contract-rpc-stack.md` §1). State tokens are opaque `{dbEpoch, seq}` (HMAC-signed for network clients). Initial backfill writes **one coarse `*` entry per page**. Compaction keeps 50,000 entries or 30 days and records a floor; clients below it get `cannotCalculateChanges` and re-open their windows. `dbEpoch` changes only on creation, reset or restore, so a restart never forces a re-snapshot.

### 3.6 Retention

Metadata, folder links and the FTS index live forever: cheap, and they keep evicted mail searchable. Bodies are kept for 90 days, plus anything opened, starred or unread, under a 2 GB cap evicted by `last_read_at` (Decision 6). Eviction sets the `evicted` bit and frees the row; a later open refetches at 20-60 Gmail units, so eviction runs slowly, never during backfill, and is followed by paced `incremental_vacuum`.

### 3.7 SQLite discipline

One writer connection; short read transactions; no iterators held across awaits. A WAL supervisor checkpoints when idle and flags WAL over 256 MB in diagnostics (a busy reader grew it to 104-938 MB in 2.5 s [V storage §4.4]). A failed migration parks the engine.

### 3.8 Importing today's data (M2)

One transaction per table family from `aplos.db`: accounts, settings, vault references, drafts, conversations, ops, workflow state, provider memory, then threads and messages (bodies included where present). Gmail accounts then reconcile against the provider with a generation sweep. Tested against a synthetic 50k-thread fixture, with a kill-mid-import resume test and a rollback drill that relaunches 0.2.x on the untouched `aplos.db`.

**Encryption at rest:** none beyond FileVault (ADR-08, Decision 7). Files are 0600 in a 0700 directory; credentials and AI keys stay in the encrypted vault under the Keychain-wrapped data key.

> **What this means:** Your mail moves into a database that opens in milliseconds at any size. The old file stays as a backup.

## 4. Sync engine: the shared model

### 4.1 Account actors and lanes

Each account is one actor that owns its connections, cursors, op flush, incremental loop, backfill and wake handling (`RC/protocols/proto-others.md` §8). Accounts run concurrently. Every network call goes through the account's governor (§6) in one of six lanes, highest priority first: **interactive** (open thread, search on Enter, send), **op flush**, **incremental** (push- or poll-triggered), **body prefetch**, **backfill**, **enrichment** (calendar polish, workflow rounds). AI has its own governor and queue (§8); it is never a sync lane.

### 4.2 Rules for every provider

From the metadata-first consensus (`RC/SYNTH-architecture.md` §4.1-4.2):
1. Capture the incremental cursor **before** listing.
2. Commit each page in one transaction with its resume token; a crash costs one page.
3. Infer deletions only after a complete round, within that round's scope (generation sweep). This fixes the ignored `reset:true` (D10).
4. Before each resumed backfill page, run a head catch-up so new mail appears during a long backfill.
5. Leave Spam and Trash out of the first pass. One backfill per account.
6. The first sync is a **silent baseline**: no notifications and no background AI until `baseline_done_at` is set (it marks the first window; see AM-4).
7. Quarantine poison items in `sync_failures` (attempts, `next_retry_at`) instead of failing the run.
8. Push signals are data-free hints that trigger the normal checkpointed pull, coalesced over 1-1.5 s, with a slow safety poll.
9. The cursor advances only inside the sync loop and only together with the changes it covers.

### 4.3 Local edits and incoming sync agree

Today's per-mutation clone and `touched` heuristics are replaced by two mechanisms (`RC/SYNTH-architecture.md` §4.5):
- **Replay.** The store holds *effective* state. Every sync commit writes incoming provider state and then re-applies every still-pending op for the touched items in the same transaction. Rollback is free: drop the op and the next commit shows provider truth.
- **Mutation fence.** Before a page request goes out, the actor records the current `changes.seq`. When the page commits, any item whose local row changed after that sequence keeps its local value; the next incremental pass reconciles it.

Ops are per message and per label (Gmail) or per placement (IMAP, JMAP, Graph), coalesced: Gmail ops with the same add/remove label set merge into one `messages.batchModify` (50 units per 1,000 ids). Per-account FIFO; one failure holds back only that account's later ops (unchanged from DECISIONS 2026-10-15). A provider 404 drops the op.

> **What this means:** Each account gets one sync worker that never guesses about deletions. An email you archive stays archived while sync catches up.

## 5. Sync per provider

### 5.1 Gmail (REST; scopes `gmail.modify` + `gmail.settings.basic`)

**The constraint.** 6,000 units per user **per project** per minute on a sliding window; `messages.get` 20 (metadata) or 60 (full/raw); `threads.get` 40 or 120; `history.list` 2; `messages.list` 5; a separate per-user concurrency cap [V `RC/protocols/proto-google.md` §1.1, §2.5]. Every Aplos device on the same Cloud project shares it (§6.5). Batches save round trips, not units.

**First sync.**

| Phase | Calls | Units | Outcome |
|---|---|---|---|
| P0 | `getProfile` (historyId first), `labels.list` | ~2 | Cursor captured, folders known |
| P1 | `messages.list?labelIds=INBOX&maxResults=500` (5/page); dedupe by `threadId`; `messages.get?format=metadata` of each thread's newest message with a `fields` mask and the headers From, To, Cc, Subject, Date, Message-ID, List-Unsubscribe, Precedence, Auto-Submitted; commit per 50 | ~1,000 for 50 threads | Inbox visible in seconds |
| P2 | Continue to 500 Inbox threads | ~10,000 | About 2.5 min at 4,500/min |
| P3 | `labelIds=SENT`, 30 days, metadata | varies | Reply signals, correspondents |
| P4 | Body prefetch: unread Inbox, then newest 100 threads; at most 20% of the budget | 60-120 each | Instant opens |
| P5 | Idle Inbox backfill to 90 days (Decision 4), metadata only | paced | Older mail via server search |

Thread rows built from one message carry `complete=0`. **Opening a thread** fetches `threads.get?format=full` (120 units, all messages in one call) when the thread has two or more messages, else `messages.get?format=full` (60), then marks it complete. *(Superseded by amendment AM-1: always `threads.get` unless the engine already knows the thread has exactly one message.)* User labels sync **lazily**: a `folder:<id>` scope is created the first time the user opens that label, paged 25 at a time in the interactive lane.

**Incremental.** `history.list`, all four history types, `maxResults=500`. Apply `labelsAdded`/`labelsRemoved` to `message_folders` at zero fetch cost (D13); fetch added messages as metadata (20); skip untracked `DRAFT` messages (D9); fetch an unknown thread **only** if it gained `INBOX`, so a 2,000-thread archive in Gmail web costs nothing instead of about 240,000 units (D3). Commit and advance the cursor per history page. A 404 cursor triggers a bounded Inbox resync plus a generation sweep. Cadence: 15 s focused, 60 s with no visible window, 5 min on battery with no window, immediately on wake, network change and focus, ±25% jitter (`RC/protocols/proto-google.md` §5A); 15 s polling costs only 11,520 units a day.

**Writes.** `threads.modify` for one thread, `messages.batchModify` for bulk. Block and "skip Inbox" rules become Gmail filters so they act while the Mac sleeps; that is why `settings.basic` stays.

**Auth.** Loopback + PKCE (already right); `prompt=select_account` with `login_hint`, never forced consent (D21); check `sub` on reconnect so another Google account cannot silently replace this one; store granted scopes and refuse to connect without `gmail.modify` (D5); `invalid_grant`/`admin_policy_enforced` → `needsReauth` (D4); refresh token and client id stored as one bundle, refreshes serialized.

**Rejected:** `https://mail.google.com/` for IMAP bulk sync and IDLE: a second code path and a "permanently delete all your email" consent line for the same restricted-scope cost (`RC/SYNTH-architecture.md` §3.2). Revisit only if live data after M3 shows quota still dominates (Decision 3).

### 5.2 Microsoft Graph (round 2; ships dark until a client id exists)

At most **4 requests in flight** per mailbox; an unordered `$batch` (at most 20 sub-requests) counts as 4; failed sub-requests retry after the largest `Retry-After`; a token bucket at 75% of 10,000 per 10 minutes (`RC/protocols/proto-others.md` §1.3, §7 #1). The visible window comes from a plain list query with light `$select`; each role folder then runs an **unfiltered** delta in the backfill lane with persisted `nextLink` checkpoints, because filters baked into the `deltaLink` probably hide older mail moved back in (M2 there). The cost of an unfiltered first round on a large folder is **[U]**, measured live in M8; correctness does not depend on it. Immutable ids stay. Delta polling: 30-60 s focused, 2-5 min in the background. Sends stay MIME through `/me/sendMail` to keep `internetMessageId`; mail over about 3 MB stays refused until an upload-session path is proven to keep the Message-ID **[U]**. AADSTS reasons are logged; `interaction_required` → `needsReauth`.

### 5.3 IMAP: iCloud and generic hosts (round 2)

- **Connections:** two per account on the primary device, one elsewhere (§13). A holds IDLE on INBOX (restart per host: 25 min default, Yahoo 3 min); B is a priority command queue that releases between folders (`RC/protocols/proto-others.md` §2.3). Reconnect backoff depends on how long the connection survived.
- **Capability ladder:** QRESYNC where advertised and allowed by the host table; else CONDSTORE `CHANGEDSINCE` plus a bounded expunge check; else windowed flag scans (newest 400 UIDs every 2 min, deep scan every 10). `STATUS` skips unchanged folders; non-INBOX folders rotate every 2-5 min.
- **Never infer a deletion from a partial answer:** read RFC 9738 `MESSAGELIMIT` and chunk below it (500 on Yahoo if unannounced).
- **Tiered fetch:** envelope, BODYSTRUCTURE, flags, size, List-Unsubscribe and References first; text for the recent window; attachments on open. Catch-up after a gap fetches the newest 500 envelopes and leaves a gap cursor for backfill (I2/I3). Byte budget 1,000 MB/day per account.
- **iCloud host entry:** QRESYNC off (2021 evidence; Mailspring still disables it [S]) unless a scripted VANISHED probe passes in M7; tolerate `UID FETCH n:*`; append our own Sent copy (kept); one app-specific password for IMAP, SMTP and CalDAV, with the username rules in the preset copy (`RC/protocols/proto-others.md` §5).
- Placements become `message_folders` rows (I4). Upgrade `imapflow` 2.4.3 → 2.9.x and stop swallowing its `error` event; pass `accessToken` for future OAuth hosts (I6).

### 5.4 JMAP: Fastmail (round 2)

One EventSource per account on `eventSourceUrl` (`types=Email,Mailbox,Thread,EmailDelivery`, `closeafter=no`, `ping=60`), a watchdog after two missed pings, throttled reconnect honouring `Retry-After`, reconnect on wake, `/changes` every 60 s as a floor (`RC/SYNTH-architecture.md` §3.5). Lists use `preview`; bodies are lazy. Drafts use `Email/set` with `$draft`; sends keep today's single-request `EmailSubmission`. The owner's API token stays the personal path; Fastmail OAuth registration is an external prerequisite (`RC/protocols/proto-others.md` §3.2).

### 5.5 Calendars

- **Every provider stores masters and overrides and expands recurrences on the client** in one platform-neutral `recurrence` module (evaluate `ical.js`, MPL-2.0, against the bundle budget; else extend Aplos's own parser). Server `<C:expand>` is not relied upon.
- **CalDAV (iCloud, Fastmail):** one `PROPFIND Depth:1` for ctag and sync-token every 5 min and on focus; changed collections run `sync-collection` (RFC 6578) then `calendar-multiget` 50 at a time; 2 in flight; `PUT` with `If-Match`; redirects only within the same registrable domain (fixes the Basic-credential leak, C3).
- **Google Calendar:** its own budget (600 requests/min per user [V `RC/protocols/proto-google.md` §7]); per-calendar `syncToken` with `singleEvents=false`; primary every 2-5 min, others every 15-30, list every 30, jittered; `events.patch` with `If-Match` (D11); 410 resyncs one calendar; decoupled from mail sync (D12); `hidden`/`selected` respected (D24).

### 5.6 iCloud in one place

Mail is IMAP (§5.3: CONDSTORE without QRESYNC, IDLE on INBOX, at most two connections on the primary device and one elsewhere, own Sent copy); calendars are CalDAV (§5.5); contacts CardDAV later. One app-specific password, stored once in the vault, serves all three; Apple offers third parties no OAuth (`RC/protocols/proto-others.md` §5). Live acceptance is in M7.

> **What this means:** Gmail shows your inbox in seconds. Google Calendar stops redownloading everything and stops wiping meeting links. iCloud, Fastmail and Outlook follow in round 2 on the same design.

## 6. Governor and the single retry layer

### 6.1 Interface

Adapters never loop on `fetch`; every SDK runs with retries off (the Anthropic and OpenAI SDKs retry by default; set `maxRetries: 0`). All provider I/O goes through:

```ts
governor.run(account, { budget: 'gmail', lane: 'backfill', cost: 20, kind: 'read' | 'write' | 'send', signal }, fn)
```

`run` waits (never sends) until budget and an in-flight slot allow the call, classifies any failure, and is **the only code that retries**. A pause aborts the account's queued and in-flight siblings through a shared `AbortController`.

### 6.2 Budgets

| Budget | Unit and ceiling | Lane targets | In flight |
|---|---|---|---|
| Gmail | units, 60 s sliding log | interactive and op flush 100%; incremental 90%; prefetch at most 20% of target; backfill 75% (4,500) | 3, one reserved for interactive and ops; HTTP batches start at 10, halve on refusal, grow by 5 to 25 |
| Google Calendar | requests, 600/min/user | 50% | 2 |
| Graph | requests, 10,000 per 10 min | 75% | 4 (one `$batch` = 4) |
| IMAP | connections, `MESSAGELIMIT`, bytes/day | per lane priority on connection B | 1 command + 1 IDLE |
| JMAP | session `maxConcurrentRequests`, `maxObjectsInGet` | server values | per session |
| CalDAV | requests | modest | 2 |
| AI (per provider and model) | RPM/TPM/TPD learned from response headers; daily token cap from Settings | interactive first | per provider |

Batch sizes follow Neverest's refusal curve: 0% at 10, 1.2% at 25, 19% at 50 [C, `RC/SYNTH-architecture.md` §3.2].

**Adaptive target (AIMD).** Gmail targets start at 4,500 units/min on the primary device and 1,500 elsewhere. A rate refusal halves the target (floor 1,000) and starts a cooldown; after 10 quiet minutes it regrows by 250/min. A grandfathered project (`RC/SYNTH-architecture.md` §4.4) only needs one setting changed.

### 6.3 Error taxonomy

| Class | Examples | Action |
|---|---|---|
| `auth` | `invalid_grant`, `admin_policy_enforced`, AADSTS `interaction_required`, repeated 401 | One forced refresh on a first 401; then `needsReauth`: stop sync and ops, show Reconnect |
| `permission` | `insufficientPermissions` | Feature marked "needs permission"; full re-consent (installed apps cannot do incremental auth) |
| `throttle` | `userRateLimitExceeded`, `rateLimitExceeded`, 429 concurrency, Graph 429, IMAP throttle hints | Pause the account: `Retry-After` if given, else 60 s, then 5 min, then up to 1 h; reset after 10 quiet minutes. Concurrency 429 drops in-flight to 1. AIMD halves the target |
| `daily` | `dailyLimitExceeded`, bandwidth caps, Groq daily-token 429 | Stop that budget until reset (Gmail: next midnight Pacific [C]) and say so |
| `send_limit` | Gmail "User-rate limit exceeded (Mail sending)" | Submission becomes `failed` with "until HH:MM"; **never** auto-retried (D7) |
| `anti_abuse` | Calendar `quotaExceeded` | Back off for hours; tell the user. Not a burst limit (D6) |
| `config` | `accessNotConfigured`, `SERVICE_DISABLED` | Every account of that provider shows `misconfigured`; no retries |
| `transient` | 5xx, timeouts, DNS, resets | Jittered 1, 2, 4 s, three tries, **idempotent calls only**. A write that times out is `uncertain` |
| `permanent` | 400, 404 on one item | Surface once; quarantine the item |

Classification reads the provider's reason **and** message text, because Gmail's per-minute refusal can say only `rateLimitExceeded` (`RC/SYNTH-architecture.md` §0.9). Idempotent writes (label modify, draft update by revision) may retry; workflow `messages.insert` checks for its own copy first; sends never retry.

### 6.4 Persistence and status

Cooldowns, daily blocks and AIMD targets persist in `governor_state`. The `gate.ts` single-flight and spacing rules fold into the actor. One status vocabulary drives retry policy and the UI: `starting`, `ok`, `syncing`, `backfilling (n of m)`, `paused (until, reason)`, `needsReauth`, `needsPermission`, `needsAdmin`, `misconfigured`, `offline`, `error`. Only `offline` and `paused` resume automatically (Geary's rule, `RC/SYNTH-architecture.md` §9). Each Google account also carries `reconnectBy`, the token's grant time plus 7 days while the Google project is in Testing mode (12.5), so the UI can warn a day ahead. `needsReauth` still means the token has already expired. A reconnect passes `login_hint`, does not resync, and keeps queued local changes.

### 6.5 Several devices on one quota: the primary-device lease

Every copy of Aplos on the owner's three Macs shares one 6,000-unit budget [V `RC/gaps/phone-mac-connectivity.md` §5]. Evolve's "divide by devices, floor 2,000" leaves three devices no headroom (`plans/_council/judge-arch-deepseek.md`). Instead each account has a **primary device** that alone runs backfill, prefetch, background AI and workflow compaction; other devices poll incrementally (8 units/min at 15 s) and serve interactive work under a 1,500 ceiling. The lease (`{deviceId, until}`, 30-minute TTL, renewed each workflow round) rides the existing encrypted workflow channel; ties go to the lower device id. It is soft: if two devices both act as primary, AIMD and cooldowns absorb it. Settings shows "Background work runs on: MacBook Pro" with a "Use this Mac" override.

**Acceptance.** An emulator enforcing 6,000 units/min and a concurrency cap serves 500 threads with zero refusals and the first 50 in under 15 s; a crash mid-page resumes there; `dailyLimitExceeded` stops retries until reset; fake-clock tests cover escalation and AIMD; two emulated devices stay under 6,000 sustained.

> **What this means:** Aplos counts its own requests against Google's limit and waits instead of getting refused. When a provider says no, Aplos tells you why in plain words.

## 7. Outbox, send safety, drafts and timed features

### 7.1 Send safety (keep what works, add a state machine)

Aplos's stable Message-ID, `sendAttemptAt` marker and `rfc822msgid:` reconciliation already beat comail, Velo, Nylas and Zero (`RC/SYNTH-architecture.md` §7). They become `submissions`: `queued → sending → sent | uncertain | failed`, plus `cancelled` and `suspended`.
- The attempt marker is committed **before the first byte leaves**.
- **Provably not sent** (no connection, DNS failure, 4xx before acceptance, send-limit 429) → `failed`, with Retry offered.
- **Uncertain** (timeout or drop after the request was written) → never replayed. The engine searches Sent for the Message-ID (`rfc822msgid:` on Gmail, `HEADER Message-ID` on IMAP, `internetMessageId` filter on Graph, `Email/query` on JMAP); a match settles `sent`, otherwise the user sees "We could not confirm this was sent. Check Sent, or Send anyway."
- **The bytes that leave are always the submission's pinned revision** (`Submission.revision` and its MIME), never whatever a provider draft holds at send time. Gmail may use `drafts.send` (so the copy on other devices disappears) only when the remote draft is provably still that revision: its message id equals the one Aplos uploaded for the pinned revision (a `baseRemoteMessageId` precondition on the send payload). Otherwise, or with no synced draft, it sends the pinned MIME by `/upload/…/messages/send` as `message/rfc822` (resumable above 5 MB), fixing the 45 s JSON timeout for large mail (D20), and leaves a remote draft that changed elsewhere in place with a "This draft was edited on another device" note. Blobs attached to a held revision stay alive until the submission settles (freeze review FR-7, 2026-10-28).

### 7.2 Undo send and send later are one mechanism

A submission's `not_before` is `now + undo window` (default 10 s) or the scheduled time. Undo before `not_before` cancels it. Both survive restarts; nothing lives only in a toast or in browser memory (`RC/SYNTH-architecture.md` §7).

### 7.3 Overdue while the Mac was off

If, at launch or wake, a waiting submission (`queued`, or `scheduled` for send later) is past `not_before` by more than the grace (5 minutes), it becomes `suspended`: "Missed its time while your Mac was off. Send now or Reschedule" (Bulwark's laptop rule, `RC/arch/extra-bulwark-legacy-proxy.md` §6; Decision 9). An undo-window send interrupted by a quit and relaunched within the grace sends normally.

The overdue rule applies to waiting rows only (`queued` and `scheduled`; freeze review FR-2). A row found in `sending` at launch or wake is never suspended and never re-sent: it becomes `uncertain` and runs `findSent` first and settles as in §7.1's uncertain rule (frozen `SendPort` rule, 2026-10-27; Providers F3 review should-fix 4).

### 7.4 Drafts sync

The local draft with a revision number is the source of truth (compare-and-set saves). **Gmail:** upload after 5 s idle and on close (15 units), skipped when the content fingerprint is unchanged, serialized per draft, keyed by the stable `draftId`; a `DRAFT` history record with a message id Aplos did not write is a remote edit → "keep mine, take theirs, or keep both". **IMAP:** `APPEND`, then delete the previous copy by `APPENDUID`, or by a per-revision Message-ID without UIDPLUS (Nylas). **JMAP and Graph:** native drafts, M8. Other devices' drafts appear in Drafts, never in threads (D9).

### 7.5 One timer loop

A single loop sleeps until the earliest deadline across `submissions.not_before`, `thread_workflow.reminder_at` and `later_until`, replacing the 30 s `setInterval` and ad-hoc send timers in `service.ts`. It recomputes after any commit that touches those columns, on wake and at launch. Late reminders and Later returns fire with "was due 9:00". Timers run only while the engine is alive, which is exactly what resident mode buys.

### 7.6 Notifications

`notifications` is a durable outbox keyed by message: written in the sync commit for new inbound Inbox mail after the silent baseline, posted by main, marked `posted`. A crash cannot duplicate a notification, and a second client can later **claim** them (comail/Flectar pattern). The Dock badge comes from engine counters, not from a main-process mirror.

> **What this means:** Sending cannot double-send. Undo, scheduled sends and reminders survive restarts, and Aplos asks you before sending something that came due while your Mac was off.

## 8. AI job pipeline

### 8.1 Two paths, one budget

- **Interactive** (Ask, draft, polish, transcribe, "summarize this"): streamed, cancellable, immediate, counted in `ai_usage`. Ask keeps its bounded agent loop and preset-only tools (DECISIONS 2026-10-21).
- **Background enrichment** (summary, Home lane, a due date found in the text, reply-needed, suggested Space action) runs only in the durable `jobs` queue on the primary device, never inside a sync transaction. Singleton key `summary:<thread>:<input_hash>`, content-keyed so a label change does not invalidate it; backoff, dead letter after 5 attempts, 1-2 jobs per provider. Priority: visible Home, then unread Inbox newest first; never Spam, Trash or the silent baseline.
- **Follow-up drafts.** When a thread enters Home's Follow up (8.2), a `followup:<thread>:<last_sent_hash>` job writes a short nudge in the user's voice that refers to their last message. It runs after summaries in priority, under the same consent, daily cap and no-tools rules, and its text stays a local suggestion, never a synced draft, until the user keeps it (DESIGN §7.2). A new reply or a new sent message changes the hash and retires the old suggestion.

### 8.2 Heuristic Home works with AI off

Home sorts mail by what it asks of the user (DESIGN §7.2): **Do now**, **Important updates**, the Low importance band, then **Follow up**. The rule is respond, see or skip: mail the user would answer is `do`, mail they only need to see is `update`, and mail they don't need to see is `low`.

At ingest, a pure `laneFor(headers, labels, correspondents, invite, thread)` returns `{lane, importance, due?}`, stored with `rank_source='heuristic'`:

- **`low`:** `List-Unsubscribe`, `Precedence: bulk`, `Auto-Submitted`, no-reply senders, Gmail `CATEGORY_PROMOTIONS` and `CATEGORY_SOCIAL`, account and security notices ("New sign-in"), shipping progress ("on its way"), and a short reply with no question that only closes a thread the user ended ("Of course!").
- **`update`:** transactional mail with a final state ("delivered", "your payment is scheduled", "minutes posted"), from sender patterns, Gmail `CATEGORY_UPDATES`, and structured delivery, reservation or bill markup once a body is fetched.
- **`do`:** direct-to-me mail from people, especially known correspondents (`correspondents.sent_to > 0`); mail that asks a question or names a deadline; calendar invitations; bills and documents with a due date.
- When unsure, a person's mail goes to `do` and automated mail to `low`. A person's mail is never sent to `low` for being from a person, or kept out of it for that reason.
- **`importance`** (`important|normal`) comes from Gmail `IMPORTANT`, direct-to-me versus cc and known correspondent. It only orders threads within a lane.
- **`due`** comes from invites and bills (`due_source='structured'`). The user's own date is `user`, and a date the AI found is `ai`. A lower-trust source never overwrites a higher one.

The summary job also returns the lane, a due date found in the text and the suggested action, and may move a thread (`rank_source='ai'`). Sender rules (`'rule'`) and the user's one-key corrections (⌥↑ / ⌥↓, `'user'`) always win. **Follow up is computed, not stored:** the user sent the thread's last message and no reply arrived within the nudge period (3 days by default, a setting).

**Order.** `do` sorts by `due_band` (0 overdue or due today, 1 tomorrow, 2 within 7 days, 3 later or undated), then `importance`, then `due_date`, then `last_date DESC`. Later items whose date has arrived sit at the bottom of Do now in the same order, whatever their lane. `update` sorts by importance, then newest. Follow up sorts by longest wait. Home's sidebar count is `do` plus `update`. Lanes and bands instead of scores, plus `holdIds` on watched windows, stop Home reshuffling under the cursor (`RC/gaps/engine-contract-rpc-stack.md` §3.3, §5.4). A thread is never held back waiting for AI.

### 8.3 Consent

A versioned consent card appears before the first background pass, naming the provider, model and what is sent, and noting that Ollama and LM Studio never leave the Mac. Changing provider or scope bumps the version and pauses background AI until re-consent. Each account has a "Use this account's mail for AI" toggle. Enqueueing checks stored consent, replacing the in-memory `deferAI` set whose leaks the PR #21 review found (`research/pr21-onboarding-review.md`); PR #21 is not merged by this plan.

Every provider entry carries `trainsOnInputs`. Background mail content never goes to a provider marked true; the unpaid Gemini tier trains on inputs, so Gemini is mail-eligible only with a paid key [V `RC/protocols/proto-google.md` §0.6]. Groq and OpenRouter terms are checked the same way before release.

### 8.4 Budget

`ai_usage` records requests and tokens per provider, model and lane per day. The AI governor learns RPM/TPM/TPD from response headers and honours `Retry-After`; a daily-token 429 stops that model's queue until reset and says so. A daily background cap (default 150,000 tokens, Decision 13) stops enrichment cleanly. Groq's free tier allows 200,000 tokens per day **per model** (DECISIONS 2026-10-21), so using a different model for Summaries than for Ask keeps background work from starving Ask.

### 8.5 Prompt-injection safety

Background jobs run with **no tools**. Model output is data: suggested actions are one of the preset `SuggestedAction` values, rendered as proposals that need a keystroke, which also satisfies Google's per-invocation consent expectation for agentic actions (`RC/protocols/proto-google.md` §8.2). Mail text is wrapped as quoted, untrusted content in every prompt. No sparkle, wand or star glyph anywhere for AI state (owner rule).

> **What this means:** Home sorts your mail even with AI off. Summaries arrive later within a daily limit you set, and AI runs only after you consent.

## 9. The typed contract and transports

### 9.1 Shape

Adopt `RC/gaps/engine-contract-rpc-stack.md` in full:
- **Semantics from JMAP:** per type `get`, `changes`, `set`, `query`; opaque state strings; `cannotCalculateChanges`; `maxChanges`; client creation ids; `ifInState`.
- **Envelope: one RPC call per method**, `{v:1, id, method, args}` → `{id, ok, result}` or `{id, ok:false, error:{type, message, retryAfterMs?}}`, with `message` the human sentence the UI shows today. No JMAP batch envelope (Swift codegen handles heterogeneous tuples poorly).
- **Types:** Session, Account, Folder, Thread (body-free row with workflow, rank, summary), Message (with `bodyState`), MessageBody, Draft, Submission, Operation (receipt), Calendar, Event, and private types WorkflowState, Summary, AiJob, Conversation, Settings, SenderRule, Client.
- **Commands:** `Thread/act {opId, ids, action}`, `Operation/undo`, `Submission/set` (send, undo, send-later), `Sync/request`, `Ai/request`, `Ask/run` with `progress` frames.

### 9.2 Live windows instead of `queryChanges`

`View/watch {spec, holdIds?}` returns a first `window {windowId, state, ids, total, changed}` frame of at most 200 body-free rows; `View/move` scrolls; `View/unwatch` ends. After each relevant commit the engine re-runs open windows' keyset queries (at most 4 per second per window) and pushes ID-only frames; clients `Thread/get` only unknown or stale rows. Cost 0.1-0.5 ms per window at 100k threads [V `RC/gaps/engine-contract-rpc-stack.md` §3.2]. Today's `threadInView` and `isHomeNew` predicates become SQL view specs. Other push frames: `state` (coalesced 50-250 ms), ephemeral `progress`, `reset`. Commands return `receipt {opId, appliedState}`; the client drops its optimistic overlay once a window reaches that state.

### 9.3 Schema and codegen

zod v4 schemas in **`packages/contract`** (platform-neutral, no runtime dependencies beyond zod) and a thin in-house registry of about 500 lines that generates: the allowlists for preload, main and the HTTP server (ending the 66/47/47 drift); a typed client by inference; input validators at every host boundary; and an OpenAPI 3.1 document via `z.toJSONSchema`. Wire rules: discriminated unions of named objects, no tuples, no `Date`/`Map`/`BigInt`, no transforms in wire schemas, open string enums. The renderer sets `z.config({jitless:true})` because its CSP forbids eval. Output schemas are validated in tests and dev builds only. A golden-file test diffs `openapi.json` in CI. **oRPC** replaces the registry only if its v2 is GA **and** the registry passes about 800 lines or MCP, batching or typed errors become hand-maintained burdens; tRPC, ts-rest, Effect RPC and Cap'n Web are rejected (§4.1 there).

### 9.4 Transports

| Client | Binding | Trust |
|---|---|---|
| Electron renderer | Direct `MessageChannelMain` port to the engine; main is out of the data path and drops its `latestState` mirror; main keeps only native methods (`window.*`, `file.*`, `system.*`, `update.*`) | Main hands a port only to its own windows' main frames; preload checks the generated allowlist |
| CLI, MCP agent (A0) | Unix socket `run/engine.sock`, mode 0600 in a 0700 directory, NDJSON frames, token in the hello frame | Per-client token, scopes |
| Browser preview (A0) | `127.0.0.1` HTTP: `POST /v1/call/<Type>/<verb>`, `GET /v1/events` (SSE, `id: <seq>`, `Last-Event-ID` resume), `GET /v1/blob/:id`, `GET /v1/openapi.json` | Token, Host allowlist, exact Origin, no reflected CORS |
| Phone (A2) | Same HTTP binding over pinned TLS on LAN or Tailscale | Paired per-device session (§13) |

Binary data moves as transferable `ArrayBuffer` on MessagePort and blob routes on HTTP, never base64 (fixes 25 MB `ai.transcribe` payloads). Latency is not the decider: all three transports are sub-millisecond for small JSON [V `RC/gaps/macos-daemon-lifecycle.md` §7].

### 9.5 Versioning

Additive changes only within `v:1`; `Session/get` returns `{apiVersion, appVersion, schemaVersion, capabilities}`. Socket and HTTP clients send theirs in the hello; an incompatible major gets `unsupported` with an upgrade message.

> **What this means:** Screens load a small window of the list at a time, so a 100,000-message mailbox feels like a small one. A restart no longer reloads everything.

## 10. Email HTML isolation

Adopt the tested design in `RC/gaps/electron-email-html-isolation.md` §7. Today's `dangerouslySetInnerHTML` (`Reader.tsx:169`) puts hostile HTML in the process that holds Aplos's IPC, under a CSP that allows `https:` images and inline scripts.

**Origin and frame.** Register `aplos-mail` as `{standard:true, secure:true}` only. Main serves `aplos-mail://m/<token>` with `protocol.handle`; the 128-bit single-render token maps to `{account, messageId, imagePolicy, findQuery}`. Subresources are `…/<token>/cid/<n>` and `…/<token>/img/<n>`. The iframe is `sandbox="allow-scripts allow-popups" referrerpolicy="no-referrer" tabindex="-1"`, never `allow-same-origin`, forms, modals or top navigation. It runs out of process, all mail frames sharing one renderer (+22-35 MB for a 20-message thread [V §2]), with no preload. **One mail origin, not one per thread** (per-thread costs +18 MB each).

**Headers** (the CSP must be a header; custom-scheme frames do not inherit the host CSP [V §8]): `default-src 'none'; script-src 'sha256-<reporter>'; style-src 'unsafe-inline'; img-src aplos-mail: data:; font-src aplos-mail: data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-popups`, plus `nosniff`, `no-referrer`, `no-store`.

**The single script.** One hash-pinned reporter posts `{token, h, w, bg, ready, marks}` on body end, resize, load, ResizeObserver, `fonts.ready` and `<details>` toggle, only when `innerWidth > 0` (early out-of-process reports are wrong [V §3]). The parent accepts a message only when `source` is the frame, origin is `'null'`, the token matches and the height is finite and clamped. Email scripts stay blocked by the hash [V]. **Decision:** this single script is accepted as the cost of measuring height with process isolation (open question 1 there).

**Where sanitizing runs.** In the engine process, through a `MailHtml` port implemented by **`packages/mail-html`**: a pure-JS parser-based allowlist with no DOM or Node imports, bundled separately so it stays out of the 400 KB core engine budget (`tests/portability.test.ts`) yet can run on a future phone. This reconciles evolve's "host capability" with the isolation report's "sanitize in the engine". It keeps `<style>` and style attributes; strips `script`, `meta`, `link` (DNS prefetch escapes CSP [V §5]), `base`, forms, `iframe`, `object`, `embed`, SVG `foreignObject`, remote `@import`/`@font-face` and unrewritten `url()`; makes links `target=_blank rel="noopener noreferrer"`; drops tracking pixels and reports "N trackers removed"; wraps quoted history in `<details>`; injects find `<mark>`s and base reading CSS. Plain-text mail renders as escaped host DOM with no frame.

**Remote images.** Blocked by default (Decision 8); placeholders keep their size. "Load images" lives in host chrome outside the frame and re-renders with a new token. Allowed images go through the **engine's image proxy**: the frame names only an index bound to the token; DNS is resolved once and rejected if any address is loopback, private, link-local, CGNAT, ULA, multicast, mapped or NAT64; redirects are followed manually (max 3, revalidated); ports 80/443, size and pixel caps, raster types, no cookies or Referer. Images load on view only; remote web fonts never load. A session `webRequest` backstop cancels any request whose initiator is `'null'` or whose frame URL starts with `aplos-mail:`.

**Keyboard and links.** Main intercepts keys with `before-input-event` when `focusedFrame` is a mail frame and relays them to the renderer's shortcut registry; keys are never forwarded from the frame. Whether this fires for out-of-process frames is **[U]**: hand-check it in the packaged app before M4 closes; the fallback is a non-destructive relay from the frame script (J/K, scroll, Esc; never E, Space or R). `setWindowOpenHandler` opens links externally or routes mailto to Compose; `will-frame-navigate` cancels everything else. Pop-out and print use a `WebContentsView` with `javascript:false`.

**Stopgap.** The stand-in engine and the UI lanes use a same-origin `srcdoc` frame without scripts and with an inner meta CSP until M4's `aplos-mail://` frames land. No release ships it.

> **What this means:** Each email displays in an isolated frame that cannot reach your files or the network. Scripts never run, and remote images stay off until you load them.

## 11. Observability and diagnostics

Aplos has none today (`RC/SYNTH-architecture.md` §9), and the engine will run with no window.
- **Logs:** JSON lines in `~/Library/Logs/Aplos Mail/`, rotated 10 MB × 5, 0600. Root-logger redaction by field allowlist: no tokens, keys, auth headers, bodies, subjects or snippets; addresses as salted hashes.
- **Event catalog:** stable event ids (`sync.gmail.page_committed`, `governor.paused`, `send.uncertain`), Stalwart's model.
- **Ring buffer** per account and folder (500 events), snapshotted into every UI error (Geary). **Verbose protocol log**, headers only, auto-off after 15 minutes (Mailspring).
- **Classified errors** `{class, reason, code, retryAfter, providerMessage}`; this alone would have explained the first 403.
- **Diagnostics bundle**, content-free and previewed before saving: versions, per-account status and cursor ages, governor targets and pauses, units per minute, queue depths, recent errors, event-loop delay, DB/WAL/FTS-backlog sizes. Never uploaded. A **queue inspector** shows ops, jobs and submissions with Retry and Discard.
- **Crashes:** `crashReporter` with `uploadToServer:false`. **Watchdogs** as in §2.4.

**Acceptance.** From a deliberately stalled sync, the owner exports a bundle that contains no bodies, subjects or tokens and shows whether the stall is quota, auth or network.

> **What this means:** When sync stalls, Aplos tells you why, and you can share a report that contains none of your email.

## 12. Security

### 12.1 Electron hardening

Fuses and macOS 13 as in §2.5. Keep `contextIsolation`, `sandbox`, `assertCaller` and navigation lockdown; add `setPermissionRequestHandler` denying everything. After M4, remove `'unsafe-inline'` from `script-src`, drop `https:` from `img-src`, add `frame-src aplos-mail:`, and drop dev ports from production `connect-src`. Only trusted main frames receive engine ports; mail frames fail `assertCaller` by design.

### 12.2 Secrets

The data key stays Keychain-wrapped and lives only in main and engine memory. Credentials and AI keys stay in the encrypted vault or backend environment (AGENTS.md), never printed, logged, committed or bundled. The Google client secret stays inlined in official builds from CI secrets; Google treats an installed app's secret as non-confidential and PKCE carries the protection (`RC/protocols/proto-google.md` §8.1).

### 12.3 Local listener (A0), as acceptance criteria

From `RC/SYNTH-architecture.md` §10 and the local-server proposal §10:
1. Unix socket 0600 in a 0700 directory, path under 104 bytes; HTTP only on `127.0.0.1`; never `0.0.0.0` unless the owner turns on phone pairing.
2. A per-client token on every request, generated with 256 random bits, stored only as a SHA-256 hash in `clients`, compared in constant time, sent in a header, never given to the renderer. The CLI's token lives in a 0600 file.
3. Exact Host allowlist (DNS-rebinding defence), exact Origin for browser clients, no reflected CORS. Today's dev `server.ts` (no token) is replaced by this binding even for the preview.
4. Typed, scoped operations only: no paths, sockets, SQL or protocol objects.
5. Scopes `read`, `draft`, `send`, `admin`; a device list with immediate revoke; an `audit_log` row for every send, delete and settings change by a non-UI client; optional `LOCAL_PEERPID` logging.
6. The MCP adapter exposes `read` and `draft` methods; `send` and destructive actions need an explicit grant and a confirmation in the app.

### 12.4 Provider and network safety

Image proxy SSRF rules (§10); CalDAV same-registrable-domain redirects (§5.5); discovery ignores loopback and private addresses (already true); OAuth `sub` check and granted-scope check (§5.1).

### 12.5 Google policy

The Google project stays in Testing mode (owner decision, 2026-10-27). Only listed test users (up to 100) can sign in, and refresh tokens expire after 7 days, so every account needs a reconnect each week. The engine records the token grant time, exposes `reconnectBy` (6.4) and keeps the reconnect to one click with no resync. Both Gmail scopes are restricted and mail goes to LLM servers, so opening Gmail to people outside the test list would need Google's restricted-scope review and a yearly CASA assessment (`RC/protocols/proto-google.md` §8.2). Both cost money, so they are off the plan: later, if ever. The scope manifest, the privacy page on aplos.email and the no-telemetry rule stay in place, so nothing in the build prevents that later.

> **What this means:** Only your own Mac user can reach the local connection. Each tool needs its own revocable key, and sending needs separate permission.

## 13. Multi-device and the phone

### 13.1 Between Macs (now)

Mailbox facts always come from the provider. Workflow state (Done, Later, todos, reminders, the primary-device lease) keeps the encrypted hidden-label channel (DECISIONS 2026-10-16 M29) with the fixes from `RC/protocols/proto-google.md` §9: gate each round on `history.list?labelId=<app label>` (2 units) instead of full fetches (D17); paginate past 50 copies (D18); break edit-time ties by device id. **iCloud connection discipline:** the primary device holds two IMAP connections per account and every other device one (IDLE when idle, commands otherwise), so three Macs use four connections, under iCloud's reported cap of about five [S `RC/protocols/proto-others.md` §2.2].

### 13.2 The phone: thin client of the Mac first (A2)

- **Why thin:** it spends zero Gmail or Graph quota and needs no OAuth, AI keys or IMAP sockets; an engine on the phone would compete with the Macs for the shared quota [V `RC/gaps/phone-mac-connectivity.md` §5].
- **How:** the A0 HTTP binding over LAN plus the Tailscale app, T3 Code's pattern (§1.1, §7 there): QR pairing with the host certificate fingerprint and a one-time code, pinned TLS, per-device scoped sessions, proof-bound short-lived stream tickets, revoke from Settings, Bonjour only on opt-in.
- **Honest limit:** the phone sees mail only while a Mac is awake and reachable, and says so. Wake on Demand is a LAN-only bonus [V §3 there].
- **Later, optional:** CloudKit (needs a provisioning profile) for workflow sync, Mac-originated alerts and a snapshot-plus-command mailbox while the Mac sleeps (§4 there).
- **Deferred:** a phone engine (D) and a relay (C). D stays possible because `packages/engine` keeps passing the portability test (`MOBILE.md`); if built, it must adopt the primary-device lease.
- **Before scheduling a phone:** a 1-2 day Swift spike generates a client from `openapi.json` and consumes SSE (`RC/gaps/engine-contract-rpc-stack.md` §7 step 6).

> **What this means:** Your Macs share Done and Later today. A phone app can come later as a remote for your Mac, and it sees mail only while a Mac is awake.

## 14. What open-source readiness implies

The repository is private today but should be able to go public. That shapes the architecture now:
1. **Provenance.** The corpus includes GPL, AGPL, commercial and unlicensed code (Superlocal has no licence). Only ideas enter Aplos (`RC/SYNTH-architecture.md` §12.1); every execution brief repeats this.
2. **Configurable OAuth clients.** Official builds embed official client ids; source builds read `APLOS_GOOGLE_CLIENT_ID`, `APLOS_GOOGLE_CLIENT_SECRET` and `APLOS_MS_CLIENT_ID` from the environment or Settings. Forks verify their own Google projects.
3. **Secrets hygiene.** Before going public, scan the full git history for keys (for example gitleaks), confirm `.env` was never committed, and keep signing and OAuth secrets in CI only.
4. **Tests without the owner's mailbox.** CI relies on the demo engine, a Gmail quota emulator, an IMAP server fixture, Graph and JMAP fakes and a hostile-HTML corpus. Live acceptance stays an owner step; mocked Google never counts (AGENTS.md).
5. **The contract is a public API.** `packages/contract` and `openapi.json` document how to build CLIs, agents and clients; the golden-file test guards compatibility.
6. **No telemetry**, which also keeps a later Google review small.
7. **Distribution:** one repository and no releases repository (Decision 11). Builds are local or private drafts for now, and the repository goes public later at the owner's call, after a secret and history scan.
8. **Licence and brand** are separate (Decision 12); the name and the sky, envelope and hill icon stay reserved, and "Airmail" is never used (`RC/gaps/identity-collision-audit.md`).

> **What this means:** The code is built as if strangers will read it one day, with no secrets in it, no borrowed code and tests that work without your mailbox.

## 15. Migration from today's code, step by step

The roadmap (`plans/00-roadmap.md`) sets the schedule in days. Phase 0 (days 1-3) restructures the code and freezes the shared rules, Phase 1 (days 4-13) builds in parallel lanes, Phase 2 (days 11-18) joins the pieces and checks them, and Phase 3 (days 18-25) is the owner's daily use. The M-names below stay as milestone names and acceptance tests, and each maps to lanes: `eng-*` for the engine, `prov-*` for providers and `ui-*` for screens. One redesigned release ships, proposed as 0.3.0 (AM-5). `aplos.db` stays until that release is stable. Live acceptance uses the agent test account first, then the owner's own accounts by hand. Emulators only support development.

**M0: folded into M3 (no 0.2.4).** The separate Gmail hotfix is dropped. Google's exact refusal reason is logged from the first day of `prov-gmail`, through the redacting log (Phase 0 artifact F7). The rest of M0 becomes acceptance items of M3: a 60 s pause on rate 403s instead of per-request retries; `quotaExceeded` and sends never retried; no Spam or Trash; `invalid_grant` → Reconnect; granted-scope check; server search on Enter only (10 threads). Owner, on day 1: confirm 6,000 units/min in the Cloud console and add the agent test account as a test user.

**M1: groundwork (Phase 0, days 1-3; lanes to day 10).** The restructure chain: rename and imports, with today's engine, shared files and renderer moved into `legacy/` folders; the `electron.ts` split; the format and lint commits; `packages/contract` (registry with today's method names, generated allowlists, a host-agreement test) and `packages/engine`, moved in one mechanical commit before the lanes diverge. `service.ts` is not split. Then, in lanes: fuses, macOS 13, resident mode, wake hooks and lockfile (`eng-host`, by day 7), BLOBs and `iterate()` in the SQL port, the SQLite CI check. **Freeze the contract and ship a stand-in engine (demo data) for the UI threads at the end of Phase 0 (day 3).** **Acceptance:** closing the window keeps sync and reminders running in the packaged app; fuses confirmed in the binary; the agreement test passes.

**M2: new store (days 4-10, `eng-store`).** Schema (§3.2, frozen in Phase 0), import (§3.8), persisted change log, bodies, paced FTS. There is no compatibility assembler, because no release runs the old screens on the new store. **Acceptance:** an original benchmark script shows first page under 1 ms and all unread counts under 10 ms at 200k messages; kill mid-import resumes; restart no longer re-snapshots; the rollback drill restores 0.2.x; a replay property test proves `snapshot(seq0) + changes == snapshot(seqN)` (Bulwark shipped two delta bugs).

**M3: governor and Gmail rewrite (days 4-12, emulator gate on day 11; `prov-gov`, `prov-gmail`).** Governor, taxonomy, status vocabulary, AIMD, persisted state; account actors; Gmail P0-P5; history incremental; generation sweep; per-message labels and coalesced ops; replay plus fence; `needsReauth`; primary-device lease; the weekly reconnect (6.4, 12.5). The M0 rules above are acceptance items here. **Acceptance (emulator gate by day 11, then live on the agent test account on days 12-14 and by hand on the owner's Gmail on days 14-16):** first 50 threads under 15 s; 500 threads in about 3 minutes; zero refusals; kill mid-backfill resumes from the page; a bulk archive in Gmail web costs under 100 sync units; classified errors in the log; a reconnect after token expiry keeps queued local changes and does not resync. **Gmail daily-driver gate.**

**M4: windows and HTML isolation (days 4-11; `eng-views`, `eng-contract`, `eng-html`).** Contract steps 3-4 with the UI threads: `View/watch`, receipts, direct MessagePort, main's `latestState` removed; `aplos-mail://` frames, `packages/mail-html`, image proxy, CSP tightening. **Acceptance:** shortcuts work with focus inside a mail frame (hand-verified in the packaged app); the isolation report's hostile vectors (inline script, `onerror`, meta refresh, `<link>` prefetch, `url()` trackers, forms) leak nothing; a 100k-thread fixture reads through bounded windows.

**M5: AI queue, heuristic Home, consent (days 4-11, `eng-ai`).** `jobs` (including `followup`), AI governor, `ai_usage`, Home lanes (`laneFor`), consent card, `trainsOnInputs`, `deferAI` removed. **Acceptance:** with AI unreachable Home is ordered; no job enqueues before consent; a Groq 429 pauses the queue and says why; the PR #21 close-at-any-moment scenarios pass as tests.

**M6: outbox, drafts, timers (days 4-10, `eng-time`).** `submissions`, uncertain handling, Gmail and IMAP drafts, one timer loop, notification outbox. **Acceptance:** killing the engine before the marker, after the marker and after provider acceptance causes no duplicate and no silent loss (emulated provider, plus one real send to an owner-controlled address); an overdue send suspends.

**M7: IMAP, iCloud, JMAP, CalDAV (round 2; `prov-imap`, `prov-jmap`, CalDAV part of `prov-cal`).** Deferred by the owner on 2026-10-27 (Gmail first). The recurrence module stays in round 1 with `prov-cal`. Two-connection actors, host table, capability ladder, `imapflow` upgrade, EventSource, CalDAV sync tokens. **Acceptance (live, owner's iCloud and Fastmail):** new mail appears within seconds; an archive made on the phone arrives; iCloud stays at two connections or fewer per device role; a long sync never blocks triage. **Multi-provider daily-driver gate.**

**M8: Google Calendar (days 5-13; `prov-cal`), then Graph (round 2; `prov-graph`).** Google Calendar sync tokens and `patch` in round 1. Graph scheduler, unfiltered delta and Graph and JMAP drafts in round 2. **Acceptance:** live Calendar edits keep Meet links and RSVPs; in round 2, emulator proof of Graph's 4-in-flight and 429 handling.

**M9: listener and diagnostics (days 4-12, `eng-host`).** A0 socket and HTTP bindings with tokens, OpenAPI golden test, MCP adapter (read, draft), browser preview on the tokenised binding, diagnostics bundle, queue inspector, Swift spike. **Acceptance:** unauthenticated, wrong-Host and wrong-Origin requests are refused; revocation is immediate; the OpenAPI diff test runs in CI.

**M10: hardening (Phases 2 and 3, days 14-25).** Legacy folders deleted (days 14-17); fault injection (drops, 403/429 storms, corrupt page, disk full); second-Mac update test; a seven-day soak with sleep/wake and battery cycles, running in the background in Phase 3 (days 18-25). **Acceptance:** zero duplicate sends, zero ghost threads after a forced cursor expiry, flat memory over 24 hours, a clean update from 0.2.3 to the release candidate.

**Top risks.** The weekly Gmail reconnect (the only external prerequisite this round); a second cause behind the 403 (`prov-gmail` logs it from day 1); change-log bugs (replay test); unverified OOPIF keyboard routing (hand check, fallback); lanes colliding (Phase 0 restructure, exclusive paths, contract freeze); listener mistakes (§12.3 as acceptance plus a review before any LAN exposure).

**After M10, only on triggers:** A1 (§2.6, 3.5-5 weeks); A2 host half (2-4 weeks) plus a phone client (months); CloudKit (2-4 weeks after profiles).

**Effort and schedule.** About 25 days from the owner's go to a finished version (best 22, slow 35; roadmap 4.2). The Gmail chain is the longest: the real store commit by day 6, Gmail passing on the emulator by day 11, live checks on days 12-15. A daily-use build comes around day 17-18. Live verification, not coding, is the constraint.

> **What this means:** You get one redesigned release. Gmail runs on your own mail around day 15, and a finished version follows around day 25. Each lane adds one provider or safety feature without breaking the others.

## 16. Architecture decision records

Format: context / options / choice / consequences.

| ADR | Context | Options | Choice | Consequences |
|---|---|---|---|---|
| 01 Topology | Topology decides lifecycle, not sync quality; the foundation is identical everywhere (`RC/SYNTH-architecture.md` §2, §11.0) | B evolve; A server first; D engine per device; C relay | B + resident now, A0 at M9, A1 on trigger | Least new surface; sync stops on ⌘Q until A1; every step reversible |
| 02 Phone | Gmail quota is per project; T3 Code proves phone-to-host outside email (`RC/gaps/phone-mac-connectivity.md` §0, §5) | Thin client A2; engine D; none | A2 when scheduled; D kept possible by portability tests | Zero phone quota; phone offline while all Macs sleep |
| 03 Gmail scope | Both scopes restricted, same review cost (`RC/SYNTH-architecture.md` §3.2) | REST `modify` + `settings.basic`; add `mail.google.com` | REST only | One code path; quota-paced backfill |
| 04 Gmail first sync | 500 full threads ≈ 60,000 units vs 6,000/min (`RC/protocols/proto-google.md` §1.2) | Bulk full; metadata-first; no history | Metadata-first, page commits, lazy bodies | Inbox in seconds; rows partial until opened |
| 05 Store | V8 caps at 4,192 MB; 200k messages ≈ 5.2 GB HTML (`RC/gaps/storage-engine-benchmark.md` §0.1) | Evolve `aplos.db`; new normalized file | New `mail.db`, `node:sqlite`, date-ordered rowids | One import; rollback copy; one-file driver swap |
| 06 Bodies | Parsed-only blocks re-render; raw MIME bloats; fixes should reach old mail | Sanitized; raw MIME; provider original | Compressed provider original, sanitized on read | Re-render and re-index without quota |
| 07 Search | FTS ≈ 80% of write cost (storage §0.2) | Inline; separate DB; contentless + job | Contentless FTS5 in main file, paced job, 16 KB cap | Fast triage; brief index lag |
| 08 Encryption | SQLCipher 2-4x writes, up to 14x reads, driver change (storage §0.6) | FileVault; SQLCipher-class | FileVault + 0600/0700 + vault | Same-user malware can read mail; reversible |
| 09 Governor | 0.2.3 has two retry layers and retries daily quota (`RC/SYNTH-architecture.md` §0.9) | Per-adapter retries; one governor | One per account, priced lanes, single retry layer, AIMD, persisted | Every adapter's I/O wrapper rewritten |
| 10 Cross-device budget | Divide-by-devices leaves no headroom (`plans/_council/judge-arch-deepseek.md`) | Divide; separate projects; lease | Primary-device lease + AIMD | Heavy work on one Mac per account |
| 11 Effective state | Clone and `touched` heuristics flip changes back (`RC/SYNTH-architecture.md` §4.5) | UI overlays; replay + fence | Replay pending ops in the sync transaction + fence | Ops must be replayable pure functions |
| 12 Contract | Allowlist copied 3×, untyped IPC, epoch resets (`RC/gaps/engine-contract-rpc-stack.md` §1) | JMAP envelope; REST; JMAP semantics + RPC; tRPC/oRPC | JMAP semantics, RPC envelope, zod registry, live windows | renderer rebuilt on the typed client (`ui-shell` lane); OpenAPI for Swift and agents |
| 13 Transports | All sub-millisecond (`RC/gaps/macos-daemon-lifecycle.md` §7) | — | MessagePort for windows; 0600 socket for CLI/MCP; loopback HTTP+SSE | Main leaves the data path; tokens never in renderer |
| 14 Email HTML | No script-free cross-origin height (`RC/gaps/electron-email-html-isolation.md` §0) | `srcdoc`; custom-origin OOPIF + one script; view per message | `aplos-mail://` OOPIF, hash-pinned reporter, engine sanitizer | +22-35 MB per thread; keyboard needs a hand check |
| 15 Remote images | Tracking pixels report reads | Load; block | Block by default; DNS-pinned proxy on opt-in; no remote fonts | Some newsletters plain until allowed |
| 16 Scheduled send | Toast-only holds lose mail (`RC/SYNTH-architecture.md` §7) | Separate mechanisms; one `not_before` | One durable `not_before`; overdue suspends | A sleeping Mac never sends late silently |
| 17 AI | AI on the sync path stalls sync, lacks consent (`research/inbox-zero/SYNTHESIS.md` §4) | Inline; job queue | Jobs on primary device, heuristic Home lanes, versioned consent, no tools | Home useful with AI off |
| 18 Observability | No logs today (`RC/SYNTH-architecture.md` §9) | Telemetry; local only | Local logs, event catalog, content-free bundle | Support needs a user-exported bundle |
| 19 Packages | `packages/` reserved for shared code (AGENTS.md) | Keep in app; extract | `packages/contract`, `engine`, `mail-html`; amended by AM-2 (test-only `contract-fixture` and `emulators`; adapters stay in the app) | One mechanical move in M1 |
| 20 Recurrence | Server expansion inconsistent; single-occurrence edits refused | Server expand; client expand | Masters + overrides, client-side expansion | One recurrence engine to test well |
| 21 Push | Gmail, Graph, Calendar push need a server (`RC/SYNTH-architecture.md` §4.3) | Relay; poll | IDLE, EventSource, jittered polling; no relay | Gmail new mail within ~15 s focused |

> **What this means:** Every major choice is written down with its alternatives and costs, so settled questions stay settled.

## 16A. Amendments (2026-10-27)

Recorded by the integrator after the four workstream plans were reconciled (`plans/00-roadmap.md`). Each also goes into DECISIONS.md at the milestone named.

- **AM-1, opening a Gmail thread (plan 20 §2, "A1").** The engine cannot know a thread's message count before opening it, and learning it costs a 40-unit probe that loses on conversations. Opening a thread and body prefetch therefore use `threads.get?format=full` (120 units); `messages.get?format=full` (60) is used only when the engine already knows the thread has exactly one message. The port is thread-granular (`ProviderPort.openThread`, plan 10 §7.1). This supersedes §5.1's "two or more messages" sentence; nothing else in §5.1 changes. DECISIONS.md at E2a.
- **AM-2, packages (ADR-19).** Two test-support workspaces are added: `packages/contract-fixture` (the stand-in engine on demo data that the UI thread and CI share; its data never counts against the engine's 400 KB budget) and `packages/emulators` (provider emulators, fault kit, fake clock; test-only, never bundled). Provider adapters stay in the app at `apps/desktop/src/host/providers/<name>/`, with their dependencies in `apps/desktop/package.json`; the neutral actors, governor, lanes and recurrence module live in `packages/engine/src/{sync,calendar}/**` and reach adapters only through ports. A `packages/providers` workspace is allowed later only when a second consumer needs the adapters. DECISIONS.md at E1.
- **AM-3, release timing (§15). Superseded by AM-5.** It put 0.3.0 at M3 on the old screens and 0.4.0 at about week 14. AM-5 replaces both with one redesigned release.
- **AM-4, the silent baseline (§4.2 rule 6, §5.1).** `baseline_done_at` marks the end of the **first window** (P1, the newest ~50 Inbox threads), never the end of backfill. Pages from P2 onward are backfill: they never create notifications and never count as new mail. The first-sync screen's "found" count is an optional estimate, shown only when the provider gives one.
- **AM-5, the roadmap's schedule and the owner's answers (§6.4, §12.5, §14, §15, Decisions 1, 2, 3, 11, 12).** Recorded 2026-10-27 from the owner's answers and `plans/00-roadmap.md`. (1) No 0.2.4 hotfix. M0 folds into M3, and its log becomes Phase 0 artifact F7. (2) No legacy bridge and no typed-client codemod, because no release ships today's screens on the new engine. Legacy code sits in `legacy/` folders from Phase 0 and is deleted in Phase 2. (3) One redesigned release, proposed as 0.3.0, replaces 0.2.4, 0.3.0 and 0.4.0. It is tagged from main after the owner merges `revamp`, and builds before that are local or private drafts in this repo. (4) The Google project stays in Testing mode, with up to 100 test users and tokens that expire after 7 days. The engine exposes a per-account `reconnectBy` fact (6.4). There is no Google verification and no CASA, and nothing in the plan costs money (12.5). (5) One repository and no releases repository. (6) The schedule is in days, by phase and lane. M1 to M10 keep their names and acceptance, mapped to lanes in §15. DECISIONS.md at Phase 0.

> **What this means:** Five small corrections from lining the plans up and recording the owner's answers, including one redesigned release in place of three.

## 17. Non-goals

- No Aplos-hosted server, push relay or AI proxy; no mailbox data on any Aplos infrastructure.
- No work while the Mac sleeps, and no promise of it.
- No LaunchAgent (A1) and no engine on the phone (D) in this plan; both have defined triggers.
- No Gmail over IMAP, no `mail.google.com` scope, no Pub/Sub.
- No SQLCipher or app-level database encryption.
- No full RFC 8621 JMAP server compliance, no `queryChanges`, no JMAP batch envelope.
- No raw-MIME archive of all mail.
- No telemetry or crash upload.
- No Windows or Linux builds; macOS 13 and later only.
- No Proton support beyond the existing Bridge note.
- No reference-project code, assets, branding or wording; no "Airmail" naming.
- No UI design decisions; the UI thread builds against the frozen contract and fixture engine.

> **What this means:** These are things the plan deliberately skips.

## Decisions for you

Each question has a recommended default. The plan uses the defaults unless you say otherwise. Questions 1, 2, 3, 11 and 12 were answered on 2026-10-27, and the answers are marked.

1. **Ship a quick Gmail fix (0.2.4) before the rebuild?** Answered 2026-10-27: no. There is no 0.2.4. The Gmail fix is built into the rebuild (AM-5).
2. **Move the Google sign-in project from Testing to Production (unverified) now?** Answered 2026-10-27: no, stay in Testing mode. Up to 100 listed test users can sign in, and you reconnect every 7 days, made smooth (a note a day ahead, one click, no resync). There is no Google verification and no CASA, because nothing may cost money. Opening Gmail to others is later, if ever (12.5).
3. **Which Gmail permission should Aplos ask for?** Answered 2026-10-27: keep today's level, including the filter permission (`gmail.settings.basic`). The broader one stays rejected (ADR-03).
4. **How much mail should the first sync fetch?** The newest 500 Inbox conversations plus 30 days of Sent, then 90 days in the background; only 14 days; or everything. **Default is the first.** Your inbox appears in seconds. Fetching everything takes hours under Google's limit.
5. **Keep Aplos running in the menu bar when you close the window, and start hidden at login?** Both; menu bar only; or neither. **Default is both,** and ⌘Q quits fully. Mail, reminders and scheduled sends keep working. With neither, they stop when the window closes.
6. **How much message text stays on this Mac?** 90 days plus anything opened, starred or unread, up to 2 GB; everything; or a smaller cap. **Default is the first.** Keeping everything allows full offline reading but grows to many gigabytes.
7. **Encrypt the database beyond FileVault?** No or yes. **Default is no.** Yes protects against other programs running as you, but it slows writes 2 to 4 times.
8. **Block remote images by default?** Block until you allow them, or always load them through a safe proxy. **Default is block.** Blocking stops senders learning when you read. Loading looks nicer but leaks that.
9. **What happens when your Mac was off at a scheduled send time?** Ask you, or send on wake. **Default is ask,** after 5 minutes' grace. Asking avoids stale mail arriving hours late.
10. **When should the phone app start, and must it work while every Mac sleeps?** After the local connection is solid, as a remote for your Mac, and no; or earlier with its own engine. **Default is the first.** It is cheap, but it sees mail only while a Mac is awake. Its own engine works during sleep but costs months.
11. **Where do updates come from while the code is private?** Answered 2026-10-27: this repo, with no releases repository. Builds are local or private draft releases that you install by hand. Downloads and auto-update from a public repo wait until the code goes public.
12. **Which licence when Aplos goes open source?** Answered 2026-10-27 in part: the repo goes public later, at your call, after a secret and history scan. The licence is not chosen yet. The repo stays `UNLICENSED` until you choose, and the default stays GPL-3.0 for the app and engine and MIT for `packages/contract`. Your name and icon stay yours under any licence.
13. **How much background AI per day?** 150,000 tokens, adjustable; unlimited; or off until you ask. **Default is 150,000.** That fits Groq's free daily allowance. Unlimited can hit Groq's daily limit. Off means no automatic summaries.
14. **Build a background helper that keeps syncing after ⌘Q?** Only when quitting becomes a daily annoyance or a phone needs it; or right after the local connection. **Default is only on need.** It costs 3.5 to 5 weeks and an Apple provisioning profile.
15. **Is a hosted push relay ever acceptable?** Never; or later, only for phone alerts while Macs sleep, with no mail content. **Default is not now.** A relay is a server Aplos must run, and it may widen Google's security review.

> **What this means:** Decisions 1, 2, 3, 11 and 12 have answers. If you say nothing on the rest, the plan uses every default.

## External prerequisites (owner actions, not decisions)

- Google, on day 1: add the owner's spare Gmail account (the agent test account) to the project's test users. The 6,000 units/min per user limit was confirmed on 2026-10-27 (1,200,000/min for the project). Every 7 days, reconnect Gmail for you and the test accounts.
- Round 2 only: a Microsoft Entra public client (personal and work accounts, no publisher verification; registering now needs an Azure sign-up with a card, so the owner decides then), and optionally a Fastmail OAuth client and an iCloud app-specific password.
- Groq: a separate free key for tests (done 2026-10-27, Keychain item `aplos-groq-test`). For other providers, confirm no-training terms before they are mail-eligible.
- Apple: a Developer ID provisioning profile with `keychain-access-groups` and CloudKit only when A1 or CloudKit is scheduled.

> **What this means:** All free. This round is Gmail and Google Calendar; Outlook, iCloud and Fastmail come in round 2.

## Evidence index

`research/email-clients/SYNTH-architecture.md` (§0-§13); `RC/gaps/storage-engine-benchmark.md`; `RC/gaps/engine-contract-rpc-stack.md`; `RC/gaps/macos-daemon-lifecycle.md`; `RC/gaps/electron-email-html-isolation.md`; `RC/gaps/phone-mac-connectivity.md`; `RC/gaps/identity-collision-audit.md`; `RC/protocols/proto-google.md` (defects D1-D25); `RC/protocols/proto-others.md` (§0, §2, §5, §7, §8); `RC/arch/pimalaya.md`; `RC/arch/extra-bulwark-legacy-proxy.md`; `research/inbox-zero/SYNTHESIS.md`; `research/pr21-onboarding-review.md`; `plans/proposals/arch-evolve.md`, `arch-localserver.md`, `arch-portable.md`; `plans/_council/judge-arch-deepseek.md`, `judge-arch-mimo.md`, `CONTEXT.md`; Aplos main at `72095ff`: `DECISIONS.md` (2026-10-15, 10-16 M26/M29, 10-21), `MOBILE.md`, `SPEC.md`, `apps/desktop/src/engine/service.ts`, `src/main/engine-host.ts`.
