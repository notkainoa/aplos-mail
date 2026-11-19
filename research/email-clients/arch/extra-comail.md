# comail: architecture audit (lighter pass, sections 3, 6 and 7 in depth)

2026-10-25. Source: shallow clone of https://github.com/NextOSP/comail at `5f742be` (2026-10-25), in `/Users/knewton/.t3/aplos-research/src/comail`. I only read files. Nothing was built or run. Paths below are relative to the repo root, and `core/` is short for `src-tauri/crates/comail-core/src/`. **License: AGPL-3.0-only** (`LICENSE`, `src-tauri/Cargo.toml`, `package.json`). Treat it as study material only. No code or text from it should go into Aplos.

"Verified" means I read the code at the cited path. "Inference" is marked as such.

## 1. Overview

- **What it is:** a keyboard-first, offline-first desktop mail and calendar client for macOS, Windows and Linux. It has a React UI on Tauri 2 over a Tauri-free Rust library crate called `comail-core` (`docs/DEVELOPMENT.md`, "Architecture"). It has no vendor server, no account and no telemetry (`README.md`).
- **Activity (via `gh api`):** 116 stars and 14 forks. Created 2026-07-11, last push 2026-10-25, about 139 commits. Releases: v0.2.39 (10-18), v0.2.40 (10-19), v0.2.41 (10-22). Contributors: DeanOpen 58, dependabot 18, hungcuong9125 6, and three people with one or two commits each. In practice it is one main author plus a few outside PRs, like Aplos.
- **Size:** about 58k lines of Rust (core plus host) and about 43k lines of TS/TSX in `src/`. There are 536 Rust `#[test]`/`#[tokio::test]` functions and 30 frontend test files.
- **Target user:** a power user who triages with the keyboard, wants local or BYO AI, and doesn't mind registering their own OAuth app (`docs/oauth-setup.md`).

## 2. Feature inventory (brief)

| Feature | Maturity | Evidence |
|---|---|---|
| Gmail, M365, IMAP mail | Shipped. All three use IMAP/SMTP, with XOAUTH2 for Gmail and M365. | `core/oauth/providers.rs`, `core/accounts/providers.rs` |
| IMAP IDLE push (INBOX only) | Shipped | `core/sync/engine.rs` header comment, `run_actor` |
| Offline action queue, optimistic UI, undo | Shipped, with heavy hardening around identity, trash and delete | `core/queue/`, `core/trash/`, migrations 028-035 |
| Undo send, send-later, snooze | Shipped, but app-local only (the timers die when the app quits) | `core/scheduler/mod.rs`, `core/lib.rs` `queue_send` |
| Split inbox (rules, heuristic, AI) | Shipped | `core/route/mod.rs` |
| Plain-language automations (AI only decides whether a message matches) | Shipped | `core/lib.rs` `Deciders`, `tests/automations.rs` |
| Hybrid search (FTS5 plus local embeddings) | Shipped | `core/embed/`, `core/db/repo/search.rs` (RRF) |
| Ask-your-inbox with citations, streamed | Shipped | `core/lib.rs` `ai_ask`, `core/events.rs` Ask* events |
| Apple on-device model | Shipped (macOS 26+) | `core/ai/apple.rs` |
| Local MCP server for external AI clients | Shipped, opt-in | `core/mcp/` |
| List-Unsubscribe incl. RFC 8058 one-click | Shipped | `core/unsubscribe.rs`, migration 019 |
| CalDAV two-way and Graph calendar | Shipped | `core/caldav/`, `core/graphcal.rs` |
| Server-side draft sync | **Missing.** Drafts are local-only, and `drafts_meta.remote_uid` is never written. | grep for `remote_uid` finds only the schema |
| Real Gmail labels | **Missing.** Labels are pushed as custom IMAP keywords, not X-GM-LABELS. | migration `005_labels.sql`, `core/queue/mod.rs` `keyword_action` |

## 3. Architecture deep dive

### 3a. Process and deployment topology

There is **one OS process** (verified). Tauri's Rust host embeds `comail_core::Core` directly (`src-tauri/src/lib.rs` `AppState { core }`), and the system WebView renders the React UI. No separate daemon, utility process or server exists.

- `Core` (`core/lib.rs:217`) owns the `Db`, a tokio `broadcast` **EventBus** with capacity 1024 (`core/events.rs`), the token cache, one `AccountHandle` per mail account, one CalDAV task per calendar account, the embedding state, and the MCP manager. It exposes about 108 public async methods.
- Background tasks spawned at `Core::start`: per-account sync actors, CalDAV tasks, a scheduler that ticks every 5 s (`core/scheduler/mod.rs`), an embedding worker (`core/embed/worker.rs`), the AI router loop (`core/lib.rs` `ai_router_loop`), a one-shot routing backfill, and the optional MCP HTTP server.
- **The tray keeps it alive.** Closing the window hides it and calls `prevent_close` (`src-tauri/src/lib.rs:353`), so sync, the scheduler and notifications keep running. Quitting the app stops everything. The scheduler's own comment says the timers are app-local, so a send-later or snooze that comes due while the app isn't running fires at the next launch.
- Native notifications are sent from Rust, not from the webview. They go through a durable `notification_outbox` table whose `message_id` is unique, so a replayed sync transaction can't announce the same mail twice (`012_sync_resilience.sql`, `src-tauri/src/notifications.rs`).
- The core waits for a `ui_ready` signal before touching OAuth tokens, so the macOS keychain prompt doesn't appear over the first-run intro. A timeout fallback keeps tray-only syncing working (`core/lib.rs:229-236`). This is a small detail worth remembering.

### 3b. Connectivity per provider

- **Gmail:** IMAP `imap.gmail.com:993` and SMTP `:465`, both over XOAUTH2. The scope set is `https://mail.google.com/` plus `openid email profile` (`core/oauth/providers.rs`). There is **no Gmail REST API at all**. Gmail's extensions are used only for identity: `X-GM-MSGID` is the preferred stable remote key (`core/provider/mod.rs` `RemoteKey`). `X-GM-THRID` is **not** used. The `gm_thrid` column exists but sync writes `None` (`core/sync/engine.rs:2607`). Threading uses References/In-Reply-To, with a fallback to the normalized subject for replies within 14 days (`core/sync/threading.rs`).
- **Microsoft 365:** IMAP and SMTP on `outlook.office365.com` / `smtp.office365.com`, using the scopes `IMAP.AccessAsUser.All` and `SMTP.Send`. Graph is used **only** for calendars and Teams meetings, with a separately minted token for that audience, because Microsoft access tokens are single-resource (`core/oauth/providers.rs` comments, `core/graph.rs`, `TokenProvider::access_token_for_scope`).
- **Generic IMAP:** username and app password. Presets for Fastmail and iCloud live in the frontend onboarding form (`core/accounts/providers.rs` comment).
- **OAuth flow:** authorization code with PKCE (S256) and a **loopback redirect**. It binds 127.0.0.1 on an ephemeral port and tries the same port on ::1 (`core/oauth/loopback.rs`, `core/oauth/flow.rs`). The sign-in can be cancelled through a `Notify`. **Users bring their own client ID**, entered in Settings or through env vars such as `COMAIL_GOOGLE_CLIENT_ID` (`docs/oauth-setup.md`). That sidesteps Google's verification and CASA entirely, at a large usability cost.
- **Secrets:** stored in the OS keyring with service `comail` and user `<account_id>:<slot>`. Slots cover the password, refresh token, AI keys, CalDAV password and MCP token (`core/accounts/credentials.rs`). **Access tokens are held only in memory**, and the core refreshes them when less than 5 minutes remain (`core/oauth/tokens.rs`). On Windows, oversized secrets are split across several entries. There's a test-only plaintext file store behind `COMAIL_CREDENTIALS_INSECURE_FILE`.

### 3c. Sync algorithm

The best part of the codebase is `core/sync/engine.rs`. Its design is **an actor per account plus dedicated connections by job type**:

| Connection | Job |
|---|---|
| Main actor | Short cycle: INBOX first, then Sent, Drafts, Archive and the rest. Then it IDLEs on INBOX. |
| Priority reader | Opening a body or downloading an attachment never waits behind bulk work (`PriorityFetchCmd`). |
| History connection | Backfills headers downward (`run_history_backfill`). |
| Body pool (2) | Bulk body download (`run_backfill_pool`). |
| Mutation worker | Replays the queue, with a lease so only one worker runs per account. |

That adds up to about 6 IMAP connections per account. A code comment notes that Gmail's cap is 15.

- **Initial sync** (verified). On the first SELECT, the actor records UIDNEXT as the "live" high-water mark and owns every UID above it. The history worker walks downward from that point. It first runs `UID SEARCH SINCE` over a 90-day window and fetches headers newest-chunk-first, 200 at a time, **checkpointing `backfill_cursor` after every chunk** so a restart resumes where it stopped (`initial_backfill`). A comment says this was added after Office 365 throttling caused endless re-syncs. After the window, it extends downward in 500-UID steps until it reaches UID 1 (`extend_history`). The whole mailbox's headers are eventually local.
- **Bodies:** fetched separately from headers. A BODYSTRUCTURE-derived "MIME plan" is saved as versioned JSON (`messages.mime_plan_json`). Text parts are fetched in batches of up to 200 UIDs, capped at 8 MB per response (4 MB for Microsoft). Attachments are fetched lazily by IMAP section (`attachments.imap_section`), with one shared fetch per attachment (`Core.attachment_locks`).
- **Incremental sync:** fetches UIDs above `last_seen_uid` in chunks of 200. The watermark advances even when UIDs are sparse, and parse failures go to a retry table. **There is no CONDSTORE or QRESYNC.** `folders.highestmodseq` exists but is never used. Flag reconciliation covers only the newest 1000 UIDs, and expunge reconciliation uses `UID SEARCH ALL`. Both run every 5th cycle (`reconcile_flags`, `reconcile_expunges`). If UIDVALIDITY changes, the folder's UID mappings are reset. (Inference: flag changes on older mail are never noticed, and the expunge scan is O(folder) on large folders.)
- **Push:** IDLE on **INBOX only**. Each IDLE lasts until the next 60 s cycle, capped at 300 s, so the full cycle still runs as a correctness backstop. Servers without IDLE are polled every 20 s. Sync Now interrupts the wait.
- **Launch catch-up vs. live mail:** an `InboxBaseline.first_live_uid` keeps the chime and notifications quiet for mail that arrived while the app was closed (`sync/engine.rs:57-63`, `chime_worthy`).
- **Rate limits and backoff:** reconnects back off from 1 s, doubling to a 5-minute cap, and wake early on a command. Auth failures move the account to `needs_reauth` and wait for an external nudge instead of looping. Content failures go to a durable `sync_failures` ledger with partial unique indexes so retries are idempotent; the delay starts at 1 minute and doubles to 1 hour. **There is no quota-unit budget anywhere.** It doesn't need one, because IMAP has no per-call quota of the kind Gmail REST has.
- **Offline outbox and queue** (`core/queue/mod.rs`, `core/lib.rs` `perform_action` / `apply_thread_action`). Each user action does two things in one SQLite write transaction: it applies the change to local rows, and it inserts a `pending_actions` row (kind, payload, `not_before`, attempts). The executor runs in fair slices of at most 20 actions or 2 s. It claims actions inside a transaction, and actions on the same message run in order, because the `due()` query skips any action whose predecessor is still pending. Retries stop after 8 attempts. Undo reverses the last *gesture*, meaning actions of the same kind created within 150 ms of each other, inside a 30 s window.
- **Undo send:** a send is just a queued action with `not_before = now + undo_send_seconds` (default 10). Cancelling flips its state from `pending` to `cancelled` (`repo::actions::try_cancel`). The SMTP send really hasn't happened yet, so the undo is real. For sends due within 15 minutes, a one-off timer nudges the actor exactly when the action comes due, so it doesn't depend on the scheduler tick.
- **Weakness (verified code path):** **sends have no idempotency guard.** At startup, `recover_inflight` (`core/db/repo/actions.rs:161`) resets every `inflight` action to `pending`. `send_action` builds a fresh random Message-ID on every attempt (`core/mime/mod.rs` `build_message`) and has no "remote attempted" marker; only the Trash/delete path has one. A crash or timeout after SMTP accepts the message, but before the row is marked done, will send it again. Aplos already guards against duplicate sends (per `research/inbox-zero/aplos-architecture.md`). Keep that guard.
- **Conflicts:** mail actions are last-writer-wins, with a good deal of identity work to re-find a message after a move: `RemoteKey` is X-GM-MSGID, or Message-ID plus INTERNALDATE plus size (`core/provider/mod.rs`, `core/trash/reconcile.rs`, migrations 030-035). Calendar edits that lose to the server are kept as a conflict copy (`CoreEvent::CalendarConflict`).

### 3d. Local storage

- **Engine:** SQLite through `rusqlite` (bundled), in WAL mode, with **one writer thread and one reader thread**. Each owns its own connection, and async callers send closures to them (`core/db/mod.rs`). Settings: 256 MB mmap, 64 MB page cache, temp store in memory, 10 s busy timeout. **No encryption at rest** (no SQLCipher feature). Secrets are the only thing protected, through the keyring.
- **Migrations:** 35 numbered `.sql` files run at open (`core/db/migrations/`, `core/db/migrations.rs`).
- **Main tables:**
  - `accounts`
  - `folders`: role, role_source, uidvalidity, uidnext, highestmodseq (unused), last_seen_uid, backfill_cursor, backfill_done, stable_identity_cursor
  - `threads`: gm_thrid, subject_norm, last_message_at, message/unread/starred/attachment counts, snippet, participants_json, routed_tab
  - `messages`: one row per **(account, folder, uid)** copy, with message_id, gm_msgid, header fields, flags, is_automated, body_state none/fetching/cached, raw_path, mime_plan_json, list_unsubscribe(_post), embedding_state and automations_applied
  - `message_bodies`: text plus **sanitized** HTML
  - `message_refs`, `attachments` (imap_section, file_path), `contacts` and `contact_accounts`
  - `pending_actions`, `snoozes`, `drafts_meta`, `draft_attachments`
  - `split_rules` (query_json, condition_json, ai_json, target), `labels` and `message_labels`
  - `calendar_events`, `calendars`, `caldav_config`
  - `sync_failures`, `notification_outbox`, `ai_usage_events`, `search_events`, `message_embeddings` (vectors as f32 BLOBs)
  - `messages_fts`: **contentless** FTS5 with `unicode61 remove_diacritics 2`; rowid equals messages.id, and rows are indexed explicitly at write time
- **Bodies and attachments:** text and HTML bodies are eventually stored for the whole mailbox. Attachments are stored only once opened. Data lives in the platform data dir (`docs/DEVELOPMENT.md`). I found **no eviction policy**. (Inference: disk use grows with the mailbox, but the cost is bounded because attachments are lazy.)
- **Vector index:** an in-memory brute-force cosine index, rebuilt at startup from `message_embeddings`. The code comment says it is "single-digit ms" at 10k-200k messages × 384 dimensions (`core/embed/store.rs`). Embedding runs on the CPU via candle under `spawn_blocking`, with a bundled bge-small model.
- Unlike Aplos, **the mailbox is never held in memory.** Every list and detail read is a SQL query.

### 3e. API between UI and engine

- **Commands:** about 104 `#[tauri::command]` handlers (`src-tauri/src/commands.rs`). Each one deserializes its arguments, calls `Core`, and serializes the result. Errors are JSON `{code, message}` so the UI can translate them by a stable code (`src/ipc/errors.ts`). On the TypeScript side, one generic `call<K extends keyof Commands>` (`src/ipc/commands.ts`) is typed against a **hand-written** `Commands` interface (`src/ipc/types.ts:1066`). Inference: nothing generates it from the Rust types, so the two can drift apart.
- **Events:** core events go to the broadcast bus, then to a forwarder that **coalesces `mail:updated` over a 100 ms window**, dedupes thread IDs, and forces a refresh when the receiver lags (`src-tauri/src/events.rs`). The UI turns events into **TanStack Query invalidations** (`src/queries/events.ts` `refreshMailQueries`). Events carry **IDs, not data**, and the UI re-reads through commands.
- **Event names:** `sync:progress`, `sync:status`, `mail:new`, `mail:updated`, `action:state`, `thread:woke`, `network:state`, `account:state`, `calendar:*`, plus streaming channels keyed by `requestId` for AI: `ai:ask:citations`, `ai:ask:token`, `ai:ask:reasoning`, `ai:ask:reset` and `ai:ask:done`, plus `ai:draft:token` and `ai:summary:token`.
- **Pagination:** `list_threads(view, split, account, label, folder, cursor, limit)` returns `{threads, next_cursor}`. The cursor is keyset pagination on a `last_message_at` timestamp (`core/db/repo/threads.rs:352-377`).
- **Mock mode:** the same command surface can be served by a 4,152-line in-memory fixture (`src/ipc/mock.ts`), so `pnpm dev` runs the real UI in a browser. This mirrors Aplos's browser-preview mode.

### 3f. Send, drafts, labels, calendar, AI

- **Send:** the core builds MIME itself (`mail-builder`), sends over SMTP with `lettre`, then APPENDs the message to Sent unless the account is Gmail, which saves its own copy (`core/queue/mod.rs:1256`). The local draft row then becomes the sent message, so Sent-folder sync dedupes it by Message-ID. Attachments are copied into an app-owned staging directory when the draft is saved, and the sender refuses to read anything outside it (`queue/mod.rs` around line 1180). That is a good defence against a hostile renderer.
- **Drafts** are local-only. **Snooze** is local-only: `"snooze" | "unsnooze" => Ok(())` in the executor, so it doesn't sync across devices. **Labels** are IMAP keywords. (Inference: on Gmail, custom keywords don't become real Gmail labels, so they won't show up in Gmail's web UI.)
- **AI:**
  - Each scenario (Ask, Draft, Summarize, Voice, Command, QuickReply, Categorize) maps to a configurable model tier (`core/lib.rs` `Scenario`, `resolve_ai_model`). Providers are any OpenAI-compatible endpoint, plus Apple's on-device model. That one is selected with the sentinel base URL `apple://intelligence` and reached through a Swift static library linked at build time (`core/ai/apple.rs`, `src-tauri/build.rs`). Prompts are fitted to its 4,096-token window, and agentic tool rounds are skipped for it.
  - **Ask** retrieves 8 hybrid matches (4 on-device), using reciprocal rank fusion of bm25 and cosine scores (`core/db/repo/search.rs:486`). It **emits the citations before the answer starts**, downloads any missing bodies for those sources, then runs up to 6 streamed rounds in which the model can call search and read tools.
  - **AI is kept off the sync path** (verified, `core/route/mod.rs` header). User rules and the built-in heuristic run *inside* the sync transaction. Threads that need the AI classifier are marked `routed_tab='pending'`. The background `ai_router_loop` drains them in batches of 50 whenever mail changes, and pauses with exponential backoff (5 s up to 10 min) when the model fails. Automations use a "decision" endpoint that returns a confidence score, so the AI only answers yes or no, and the configured actions are deterministic.
  - **MCP server:** bound to `127.0.0.1:47823` and implementing streamable HTTP with plain JSON responses. It uses a random 32-byte bearer token kept in the keyring, with a `/mcp/<token>` fallback for clients that can't set headers. Requests whose Origin or Host isn't loopback are rejected. Tools are grouped Read, Draft, Send and Actions, each group gated by its own setting, and permanent delete needs a separate opt-in (`core/mcp/mod.rs`, `core/mcp/tools.rs`). Tool calls are logged to an in-app "recent activity" list.

## 4. Engineering quality (brief)

- **Tests:** 536 Rust tests, including **real-server end-to-end suites** against a throwaway Dovecot container and a local SMTP sink, gated by `COMAIL_TEST_IMAP=1` (`tests/dovecot_e2e.rs`, `tests/send_e2e.rs`, `tests/first_sync.rs`). `tests/first_sync.rs` seeds 600 messages and checks how fast bodies drain. `tests/offline.rs` points at a refused localhost port and checks that actions stay pending (never failed) and survive a restart. There are also `tests/mcp_http.rs`, `tests/perf.rs` and `tests/search_ranking.rs`.
- **CI** (`.github/workflows/ci.yml`): typecheck, `cargo fmt --check`, clippy, core tests (the end-to-end suites skip themselves when the env var is unset), and a full Linux Tauri build. Releases are a signed matrix build with an updater manifest.
- **Observability:** `tracing` writes to `<data_dir>/logs/comail.log`, rotated once to `.1`, and there's an "open logs folder" command. **No crash reporter** (grepping for sentry, crash and minidump finds nothing).
- **Organization:** the core/host split is clean. However, `core/lib.rs` is about 6,000 lines and `sync/engine.rs` is about 4,400, the same kind of "god file" Aplos has in `service.ts`.

## 5. UI notes (brief)

React 19, TanStack Query and TanStack Virtual, zustand, Tailwind 4, `motion` 12 and i18next (`package.json`). One command registry drives both the keymap and the Cmd+K palette (`src/keyboard/registry.ts`). Email HTML is rendered in an `<iframe srcDoc>` with `sandbox="allow-same-origin allow-top-navigation-by-user-activation"` (no `allow-scripts`), and the document carries its own `default-src 'none'` CSP (`src/components/thread/MessageCard.tsx:554-600`, `:855`). I didn't audit motion constants in this pass.

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **Separate the work into lanes.** Opening a message, receiving new mail, backfilling history, downloading bodies and replaying mutations should be independent queues, each with its own concurrency budget. In comail each lane gets its own IMAP connection. For Aplos's Gmail REST adapter, the equivalent is separate *request budgets* under one per-account token bucket: a foreground lane that always has headroom, and background lanes that yield. This directly fixes the all-or-nothing 500-thread `format=full` first sync.
2. **Snapshot the high-water mark, then backfill downward with a checkpoint after every chunk.** For Gmail, that means taking `historyId` before the backfill starts, listing pages newest-first, and saving the page token after each committed page. Restarts resume, and live mail is never lost behind a long backfill.
3. **Fetch headers or metadata first, then bodies in the background, then attachments only when opened.** Save a per-message "content plan" so body fetching can resume and retry, and record per-message failures in a durable ledger with backoff (comail's `sync_failures`) instead of failing the whole run.
4. **Keep the mailbox out of memory.** Make SQLite the source of truth, use a single writer, and serve every read as a query with keyset pagination. Aplos's whole-mailbox in-memory clone is the main thing to remove. comail shows that a fast keyboard UI doesn't need it.
5. **Send IDs, not data, in events, and coalesce them.** Debounce `mail:updated` for about 100 ms in the engine, and have the renderer invalidate TanStack-style queries. On a dropped or lagged event, fall back to "refresh everything". This replaces Aplos's clone-the-state replication and works the same way over IPC, SSE or WebSocket.
6. **AI marks work "pending" and a background router does it.** Deterministic rules and heuristics run inside the sync write. The LLM runs afterwards in bounded batches, with exponential pause on failure. This is exactly the fix Aplos needs for summaries and classification on the sync path.
7. **Implement undo send as "the queued action isn't due yet".** It's simple, and the undo is real. Pair it with a one-off timer for near-term sends.
8. **Run IDLE with a timed full cycle as a backstop**, and keep launch catch-up separate from live arrivals so notifications don't fire for the backlog. Aplos has no IMAP IDLE today. Add it for iCloud and Fastmail, which is the wedge the synthesis recommends.
9. **Use a durable notification outbox** keyed uniquely by message, dispatched by the engine rather than the renderer.
10. **Stage attachments in an engine-owned directory** and refuse to read paths outside it when sending.
11. **Test end-to-end against a real IMAP server in a container** (Dovecot plus an SMTP sink), plus an "offline equals refused port" test. This is cheap and catches the kind of failure Aplos hit live.
12. **Treat the MCP security model as a template for any local listener:** loopback bind, a random token in the keychain, an Origin/Host allowlist, capability groups that default to read-only, and an activity log.
13. **Show citations before the answer streams** in Ask, and reduce agentic rounds for small local models.

### Avoid

1. **Sends that aren't idempotent.** comail resets in-flight sends at startup, and every retry builds a new Message-ID, so a crash after SMTP accepts the message re-sends it. Keep Aplos's duplicate-send protection: one stable Message-ID per send, and a "remote attempted" state that needs reconciliation (search Sent by Message-ID) before any retry.
2. **App-local timers for snooze and send-later.** They don't fire while the app is quit and don't sync across devices. If Aplos moves to a daemon, the daemon should own timers. For cross-device, push snooze into the provider (a Gmail label plus the hidden workflow label Aplos already has).
3. **Local-only drafts and keyword "labels" on Gmail.** These are the gaps Aplos already has. Don't copy them. Gmail draft sync and real labels need Gmail's API (or X-GM-LABELS).
4. **Flag reconciliation limited to a window, with no CONDSTORE/QRESYNC.** It misses changes to older mail and scans every UID to detect expunges. Use CONDSTORE/QRESYNC where the server supports them.
5. **"Bring your own OAuth client"** as the main onboarding path for Gmail. It avoids CASA but would be fatal for Aplos's target users. At most, offer it as an advanced fallback.
6. **A hand-written TypeScript mirror of the command surface.** Generate the contract from one schema instead (see section 7).
7. **No encryption at rest and no eviction policy.** Fine for a power-user tool, but decide on both explicitly.

## 7. "Local server" translation for Aplos

comail is *one process with a library core*, not a daemon. Its structure still maps almost one-to-one onto the daemon Aplos is considering, because the core is already free of any UI framework and talks to the UI through exactly two channels: request/response commands and a broadcast stream of ID-only events. Its MCP listener also shows the core can serve HTTP on loopback alongside the desktop UI.

### Proposed mapping

| comail piece | Aplos daemon equivalent |
|---|---|
| `Core` with about 108 async methods | `aplosd`: the existing engine moved out of `utilityProcess` into a standalone Node process managed by launchd (a LaunchAgent), or as a first step kept as the utility process but listening on a socket |
| Tauri commands (`commands.rs`) | **one RPC transport with two front doors.** Electron keeps the fast in-process IPC path. Other clients use `POST /rpc/<method>` with JSON (or JSON-RPC 2.0) on `127.0.0.1` or, better, a Unix domain socket for the Electron app. Both are generated from one schema (zod or TypeBox) that also produces the TS client. This fixes the three copied allowlists. |
| EventBus plus the 100 ms coalescing forwarder | `GET /events` over **SSE** (Aplos's dev server already has `/api/events`) or a WebSocket, carrying `{type, ids, seq}`. Each event has a monotonic `seq`, and a reconnecting client sends `?since=seq`. If the gap is too large, the server answers "reset" and the client refetches, the same way comail handles `Lagged`. |
| `list_threads` with a keyset cursor | `GET /threads?view=…&cursor=…&limit=50` returning `{threads, nextCursor}` straight from SQLite. Use a compound `(last_message_at, id)` cursor rather than a bare timestamp. |
| Streaming AI events keyed by requestId | The same request ID on the event stream, or a per-request SSE response for Ask, Draft and Summary |
| MCP auth model | Daemon auth: a **per-client token** in the Keychain. The Electron app gets one at install. A phone gets one through a pairing flow (QR code with daemon URL, token and cert fingerprint). Enforce an Origin/Host allowlist, scope tokens (read, draft, send, actions), and keep a "connected devices" list with revoke. |
| Tray keeps syncing | The launchd agent keeps syncing with no window. **This fixes comail's app-local timer limit:** snooze, send-later and undo-send keep working while the UI is closed, though not while the Mac sleeps. |
| `notification_outbox` dispatched natively | Fits a daemon well, but on macOS the daemon needs a bundle identity to post notifications. Simplest: the daemon is a helper inside the `.app`, registered with `SMAppService`. |

### JMAP-like or REST?

The synthesis already favours "IDs in events, client refetches". A **JMAP-shaped** API is a natural formalization of that: `Email/query`, `Email/get`, `Email/changes(sinceState)`, `Email/set`, and a push channel that only says "state changed". It suits a future phone client because the phone can keep its own small cache and ask for `/changes` since its last known state, instead of replaying events. comail's per-thread IDs plus its action log are most of what a `changes` endpoint needs. The missing pieces are a per-account `modseq` counter written in the same transaction as each mutation, and a tombstone table. **My recommendation:** use REST plus SSE with JMAP-style naming and a `state`/`since` pair on each collection. Don't implement JMAP literally on day one.

### Pros

- One engine serves the Electron UI, the browser preview, MCP or agent clients, and later a phone. Today Aplos has two separate engine hosts (the utility process and `server.ts`).
- Sync, timers and notifications survive closing the UI. The UI can crash and restart without dropping sync or the send queue.
- Forces the typed contract and paged reads that Aplos needs anyway, and removes the whole-mailbox clone across IPC.
- Fits the "local-first, no vendor server" story. The phone talks to *your Mac*, not to Aplos's servers.

### Cons and risks

- **Security surface.** A listening port that can send mail is a high-value target. Use a Unix socket for local clients, loopback-only HTTP by default, a token on every request, Origin/Host checks (comail's MCP checks are the template), and **never** `0.0.0.0` without pairing plus TLS. LAN access for a phone needs TLS with a pinned self-signed certificate, which is real work.
- **Phone reachability.** Same-LAN only is fragile on iOS: local-network permission prompts, Bonjour, and the Mac sleeping. Remote access needs a relay or Tailscale-style tunnel, and that brings back a server, or at least a dependency. **The Mac sleeping is the hard ceiling.** A daemon doesn't change what the synthesis says: only provider-side filters and push run while the Mac is asleep.
- **Lifecycle complexity.** A launchd agent, version skew between the UI and the daemon (the protocol must be versioned), migrating the database while the daemon runs, auto-update replacing a running daemon, and the keychain access group shared by the app and the helper.
- **Node as a daemon.** Memory and startup costs are fine once the mailbox is out of RAM. comail's Rust core suggests Rust would be leaner, but rewriting the engine in Rust is not justified for Aplos now.

### Effort (rough, one developer plus agents)

1. **Schema-first contract plus generated TS client, with paged list and detail reads replacing state clones:** 1-2 weeks. Do this first. It pays off with or without a daemon.
2. **Event stream with `seq` and resume, ID-only coalesced events, query invalidation in the renderer:** 3-5 days.
3. **Move the engine host behind a socket. Keep the `utilityProcess` but listen on a Unix socket, and have the Electron main process proxy to it:** about 1 week.
4. **launchd/`SMAppService` helper, token auth, versioned protocol, update handling:** 1-2 weeks.
5. **Phone access (pairing, TLS, discovery, a minimal client):** 3-6 weeks or more, plus a relay decision. Not in the 30-day plan.

Steps 1-3 are worth doing in the backend revamp regardless, because they fix the memory ceiling and the untyped IPC. Step 4 is optional until snooze, send-later and notifications need to keep running without the UI. Step 5 is a separate product decision.
