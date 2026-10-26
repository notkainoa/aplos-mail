# Flectar Mail: architecture audit for the Aplos revamp (lighter pass)

2026-10-25. Source: shallow clone of `github.com/flectar/mail` at `b2086fe` (2026-10-25), in `/Users/knewton/.t3/aplos-research/src/flectar-mail`. I only read files. Nothing was built or run. Paths below are relative to `crates/flectar-mail-core/` unless they start with `src/` (the Slint app) or `.github/`. **[V]** means I checked it in code or the GitHub API. **[I]** means inference.

**License: AGPL-3.0-only** (`LICENSE`, `LICENSING.md`; the core crate is `publish = false`). It is for study only. Nothing here should be copied into Aplos.

**Lineage [V]:** Comail's `src-tauri/crates/comail-core/src` has nearly the same module list (sync, queue, scheduler, route, autolabel, embed, caldav, graph, graphcal). Even the module doc of `sync/engine.rs` matches. Flectar adds jmap, pop3, carddav, files, migration, net and mail_security. Comail adds `mcp` and `provider`. Treat the two as one design.

**Correction to the brief [V]:** Flectar does **not** sync Outlook mail over Microsoft Graph. `graph.rs:1-7` covers calendars and Teams meetings only. Microsoft mail goes over IMAP and SMTP with XOAUTH2 (`accounts/providers.rs`: `MICROSOFT` uses `MailProtocol::Imap`, `outlook.office365.com:993`, `smtp.office365.com:587`). So Flectar is a reference for Gmail REST, IMAP, JMAP and POP3 sync, and for Graph *calendar* delta. It is not a reference for Graph mail.

---

## 1. Overview

- **Purpose:** a native, low-memory mail, calendar, contacts and files client for Windows, macOS, Linux, Android and iOS. It is written in Rust with a Slint UI, and email HTML is rendered by Blitz, a Rust HTML/CSS engine, with no WebView (`README.md`).
- **Activity [V]** (`gh api`): created 2026-09-03, 1,607 stars, 120 forks, 18 open issues, last push 2026-10-25. Releases are prereleases only: `v0.1.0-alpha.4` through `alpha.7` (2026-10-08). The core crate's own version is `0.2.29`.
- **Contributors [V]:** `iamdarkle` has 615 contributions. The next eleven contributors have 1 to 6 each. In practice this is a one-person project merging daily. **[I]** It is very likely AI-assisted: `.agents/skills/slint/` is in the repo, and `CONTRIBUTING.md` asks contributors to disclose generative-tool use.
- **Maturity:** the README calls HTML rendering "the most experimental part". Google OAuth is blocked on an unfunded CASA assessment, and Microsoft verification is "in progress". Testers bring their own OAuth client IDs. macOS builds are ad-hoc signed and not notarized.
- **Target user:** people who want a fast native client across many protocols and devices, and who care about privacy (remote images blocked by default, no WebView).

## 2. Feature inventory (brief)

| Feature | Maturity [I from code and README] |
|---|---|
| Gmail (REST), IMAP, JMAP, POP3, SMTP | Substantial and defensive. Live tests run only against Dovecot and Stalwart, and only when an env var gates them on |
| Outlook / M365 mail | IMAP/SMTP XOAUTH2. SMTP AUTH is often disabled by tenants, and the code logs this as a known cause of stuck sends (`queue/mod.rs:144-150`) |
| Calendar (CalDAV, Google Calendar API plus CalDAV, Graph delta), contacts (CardDAV), files (JMAP/WebDAV) | Broad. Calendar has a conflict policy |
| Offline queue, undo-send (10 s default), send-later, snooze | Durable and solid |
| Gmail draft sync, JMAP drafts | Implemented, including idempotent send |
| Rules ("splits"), deterministic auto-labels, AI routing and automation rules | Implemented. AI is off the sync path |
| List-Unsubscribe (RFC 8058, mailto, browser) | Implemented with an SSRF guard |
| Local semantic search (candle embeddings), RAG "Ask" | Opt-in feature flag |
| OpenPGP via GnuPG, Thunderbird/K-9 import, mbox export, DB snapshots | Present |
| Logging and crash reporting | **Effectively none** (see §4) |

---

## 3. Architecture deep dive

### 3a. Process and deployment topology

**[V] There is one process and no server.** The app embeds a `Core` struct (`lib.rs:518-552`) on a Tokio runtime inside the Slint binary. `Core` owns:

- **Three SQLite databases:** mail, calendar and files (`config.rs`). Calendar is kept separate "so mailbox backfills cannot block the calendar UI" (`lib.rs:521-523`). The calendar and files databases open lazily.
- **A dedicated OS thread per connection:** one writer and one read-only reader for mail (`db/mod.rs:1-4, 86-130`).
- **A set of Tokio tasks per account,** started by `spawn_account` (`sync/engine.rs:288-375`):
  - **IMAP:** five tasks. A main actor (cheap per-cycle work plus IDLE), a priority body/attachment reader on its own connection, a two-connection bulk body pool, a history-backfill connection, and a durable SMTP dispatcher.
  - **Gmail:** an actor and a reader. **JMAP:** an actor and a body actor. **POP3:** a downloader and SMTP.
- **Global loops:** a 5 s scheduler (`scheduler/mod.rs`) for snooze wake-ups, due actions and meeting reminders; an AI router loop; a verification-code body loop (`lib.rs:870-930`); and an optional embedding worker.

**Lifecycle [V]:**
- `src/single_instance.rs` makes the first process own the profile. It holds a Unix socket guarded by an advisory lock, and later launches just ask it to show its window. Two sync engines never share one database.
- Close-to-tray and autostart (`src/autostart.rs`, `ui/tray.slint`) keep sync running with no window open.
- Account actors wait for a `ui_ready` notify before reading the keychain, so keychain prompts don't land on the intro animation. They fall back after 60 s for tray-only or headless starts (`lib.rs:541-548, 744-760`).

**Hosted services:** none today. `LICENSING.md` mentions *possible* future paid "hosted encrypted synchronization, relays". **[I]** That suggests they may later split out a relay or daemon.

### 3b. Connectivity and auth per provider

| Provider | Transport | Auth | Evidence |
|---|---|---|---|
| Gmail | REST only. IMAP and SMTP endpoints are recorded but never contacted | OAuth code + PKCE, loopback redirect, scope `https://mail.google.com/` + openid/email/profile. The full scope was chosen for permanent delete. Calendar scope is requested later through incremental consent | `accounts/providers.rs:22-31`, `oauth/providers.rs:33-37`, `oauth/flow.rs:1-3` |
| Microsoft | IMAP + SMTP with SASL XOAUTH2 | `IMAP.AccessAsUser.All`, `SMTP.Send`. Graph scopes (Calendars, OnlineMeetings) use a **separate token with a different audience**, because one Microsoft token can't span two resources | `oauth/providers.rs:8-19, 43-47`, `oauth/xoauth2.rs` |
| IMAP / POP3 / SMTP | async-imap, custom POP3, lettre, rustls | Password or app password | `imap/mod.rs`, `pop3/`, `smtp/` |
| JMAP | jmap-client (Stalwart Labs), plus EventSource push | API token: Bearer first, Basic as fallback. `/.well-known/jmap` is resolved **without credentials**, and cross-host redirects must publish the same Session | `jmap/client.rs:257-360, 493-520, 591-592` |
| CalDAV / CardDAV | reqwest + quick-xml | App password per connection. Google and Microsoft calendars reuse the OAuth tokens | `accounts/credentials.rs` Slot enum |

**Token storage [V]:**
- Secrets are kept in the OS keychain (the `keyring` crate, `apple-native`) and never in SQLite (`accounts/credentials.rs:1-5`).
- The refresh token and the OAuth client registration that issued it are stored together as one atomically replaced, versioned slot (`Slot::OAuthBundle`). A later custom client ID therefore can't orphan existing accounts.
- **Access tokens are kept only in memory.** They are deliberately not persisted, partly because Microsoft JWTs overflow the Windows credential-blob limit (`oauth/tokens.rs:1-7`).
- Refresh grants are serialized **per account**, so a rotated Microsoft refresh token can't race between the mail and Graph refreshes (`oauth/tokens.rs:27-31`).
- Release builds refuse to start OAuth when no secure store is available (`README.md`, "Linux desktop OAuth").

### 3c. Sync algorithm

**Gmail (`sync/gmail.rs`) [V]. This is the most useful part for Aplos's 403 problem.**

- **Watermark first:** a full scan starts by reading `profile.historyId` and storing it together with a new **generation number** (`db/repo/gmail.rs:36-58`). Mail that arrives during the backfill is then picked up by history replay.
- **Metadata only:** `messages.list` (100 per page, `includeSpamTrash=true`, with an optional `after:` cutoff from the account's 1/3/6/12-month or "all" history setting). Then `format=metadata` with an explicit list of 17 headers, including `List-Unsubscribe`, `Authentication-Results` and `References`, sent as multipart **batches of 10** (`gmail.rs:31-46, 61-79, 338-382`). The comment explains why: Gmail runs each batch's inner requests concurrently, so small batches stay under the per-user concurrency ceiling.
- **One page per cycle, then a fixed sleep:** after each page the actor sleeps `BACKFILL_INTERVAL = 22 s` (`gmail.rs:41-46, 3744-3752`). The comment's arithmetic: 5 units for the list plus 100 × 20 for metadata gets, against 6,000 units per user per minute. That matches the 2026 pricing in `protocols/proto-google.md`. **[I]** The math gives about 5,470 units per minute, or 91% of the budget. That's tight, and the interactive reader's `threads.get?format=full` calls (120 units each) draw from the same budget with no shared governor.
- **Checkpoint per page:** `sync_cursor` is saved after every page (`checkpoint_full_page`), so a crash resumes at the last page. A cursor that doesn't advance counts as an error.
- **Mark and sweep:** each stored message is stamped with the generation. When the last page lands, `cleanup_full_generation` deletes rows from older generations that fall inside the window. **This is the fix for Aplos's `reset:true` ghost threads.**
- **Incremental:** `history.list` pages are checkpointed with `history_page_token` and `completed_history_id`. Affected threads are re-fetched as **metadata** (two at a time, in groups of four). A 404 on a thread removes it locally. **A 404 on the history cursor triggers `expire_history`, which starts an authoritative rescan with a new generation** (`gmail.rs:2474-2487`).
- **Bodies are lazy:** the reader task hydrates whole threads with `format=full` only when a message is opened. It coalesces requests with a 40 ms debounce (`gmail.rs:3805-3887`). Gmail and JMAP bodies are never bulk-downloaded (`lib.rs:911-918`).
- **No Gmail push.** There is no Pub/Sub or `watch`. Polling runs on the user's interval, 5 minutes by default (`models.rs:1929`).
- **Errors** (`gmail.rs:768-817`):
  - Errors are classified by Google's `reason`, not just the HTTP status.
  - 401, and 403 with reason `authError`, `forbidden` or `insufficientPermissions`, mean NeedsReauth. The actor then **parks until the user acts**, with no timed auth loop (`gmail.rs:3754-3775`).
  - Rate limits retry with exponential backoff from 1 s up to 300 s.
  - **Weakness [V]:** `quotaExceeded`, `dailyLimitExceeded` and `backendError` count as rate limits and retry the same way. That is the same bug the synthesis found in Aplos 0.2.3. `Retry-After` is never parsed, and the per-request retry only covers reauth.

**IMAP (`sync/engine.rs`, `imap/mod.rs`) [V]:**

- **No CONDSTORE or QRESYNC, by design** (`imap/mod.rs:4-6`). Incremental sync uses:
  - new-UID fetches;
  - flag reconciliation over the newest 1,000 UIDs (`FLAG_WINDOW`);
  - UID-set expunge reconciliation, run on every 5th cycle for non-Inbox folders.
- UIDVALIDITY changes reset the folder's UID map.
- **Work is split across connections:** the main actor does only cheap work (one bounded slice of the action queue, then Inbox, then other folders in role order, skipping `\All`). Header backfill runs on its own connection, and bodies on a two-connection pool, so new mail isn't stuck behind a backfill. That is 4 connections per account, under Gmail's limit of 15 (`engine.rs:1-17, 66-81, 1365-1460`).
- **IDLE** runs between cycles, re-issued every 25 minutes, with a periodic sync as a backstop (`engine.rs:75-78`, `imap/mod.rs:1361-1435`).
- **Memory budgets** are global semaphores: at most 2 body-planning pages in flight across all accounts, and a 16 MiB budget for background body bytes (`engine.rs:44-66, 2663-2680`).
- **Per-message quarantine:** the `sync_failures` table (stage `header` or `content`, with attempts and `next_retry_at`) stops one bad message from failing the whole sync (`001_init.sql:303-326`).
- **Launch catch-up is not "new":** `InboxBaseline.first_live_uid` separates mail that arrived while the app was closed from mail that arrives while it runs (`engine.rs:84-90`). Only the latter triggers notifications.

**JMAP (`jmap/sync.rs`) [V]:**
- Sync uses `Email/changes` and `Mailbox/changes` with durable state strings. A full-sync progress table makes the initial pass resumable (`018_jmap_full_sync_progress.sql`).
- **EventSource push** is opened after each successful sync for Email, Mailbox and EmailSubmission with a 60 s ping. If push is unavailable, it falls back to polling (`jmap/sync.rs:155-185, 237-272`).
- Attachment listing runs one request at a time **while the actor is idle**, and gives way as soon as anything else needs the actor.

**Offline queue (`queue/mod.rs`, `pending_actions`) [V]:**
- Local mutations are applied optimistically when `Core::perform_action` enqueues them.
- The executor claims each action atomically, so undo can't race it, and works in **fair slices** of at most 20 actions or 2 s (`queue/mod.rs:17-20, 104-130`).
- Failures back off exponentially with jitter, up to 8 attempts. IMAP NO/BAD and SMTP 5xx count as permanent.
- On final failure, a move is rolled back **only if no newer move for that message exists** ("newest intent wins") (`queue/mod.rs:286-375`).
- A send that fails to connect is deferred 30 s without spending its retry budget.
- In-flight actions orphaned by a crash are reset at startup (`lib.rs:683-705`).
- **Calendar conflicts:** on HTTP 412 the server wins, and the user's edit is kept as a detached local copy (`caldav/push.rs:1-4`).

### 3d. Local storage

- **Engine:** rusqlite (bundled) in WAL mode with `synchronous=NORMAL` and foreign keys on (`db/mod.rs:176-195`).
  - Each store has one writer thread and one `query_only` reader thread, fed through a **bounded job queue of 128**. Repository code stays plain synchronous SQL.
  - The mail reader gets a deliberately small 2 MiB page cache, and idle connections are closed after startup recovery to release memory (`db/mod.rs:52-80`, `lib.rs:737-743`).
- **Main tables** (`db/migrations/001_init.sql`):
  - `threads`: account, `gm_thrid`, `jmap_id`, `subject_norm`, `last_message_at`, message/unread/starred/attachment counts, snippet, `participants_json`, `routed_tab`.
  - `messages`: account, thread, folder, `uid`, `message_id`, `gm_msgid`, `gm_thrid`, address JSON columns, flags, `is_automated`, `snippet`, `body_state` (none, fetching or cached), `raw_path`, `list_unsubscribe(_post)`, `mime_plan_json`, `sender_verification`, `gmail_sync_generation`, `gmail_draft_id`, `jmap_id`, `jmap_blob_id`.
  - Also: `message_bodies(text_body, html_body)`, `message_refs` (for threading), `message_folders` / `message_labels`, `attachments`, `pending_actions`, `snoozes`, `sync_failures`, `notification_outbox`, `gmail_sync_state`, `jmap_sync_state`, `pop3_uidls`, `split_rules`, `route_cache`, `sender_identities`, `drafts_meta`, `ai_usage_events`, `message_embeddings`, and `cross_store_operations`, which journals deletes that span the mail and calendar databases.
- **What's on disk:**
  - Raw `.eml` files go under `data/mail/<account>/` (durable).
  - Extracted attachments go under the OS **cache** directory, since they can be rebuilt (`config.rs:88-105`).
  - `data_dir` and `cache_dir` are explicitly split into durable and reconstructable data.
  - Inline CID images are capped at 8 MiB each and 32 MiB per thread (`lib.rs:61-71`).
- **Search:** a **contentless FTS5** table with `contentless_delete=1` and `unicode61 remove_diacritics 2`. When there is no body, the snippet is indexed instead (`db/repo/search.rs:8-33`). Search is local only, with no server fallback, so Gmail body search only covers messages that have been opened. The query parser supports operators, an OR fallback when the strict query finds nothing, and `-term` exclusions (`search/mod.rs`).
- **Eviction:** the per-account history window plus generation cleanup bound what is kept. **[I]** I found no LRU eviction of bodies.
- **Encryption at rest: none [V]** (no SQLCipher). It relies on disk encryption, the same as Aplos.
- **Migrations:** an ordered list of SQL files keyed on `user_version`. A special "table rebuild" step disables foreign keys and commits only if `foreign_key_check` passes (`db/migrations.rs:1-42`). There are separate migration sets for calendar and files. `db/snapshot.rs` exports verified snapshots.
- **Warm start:** a small JSON projection of the last visible mailbox page is kept in the cache directory and painted before the databases open (`config.rs:66-75`).

### 3e. API between UI and engine

- **Transport:** in-process Rust calls, about 140 `pub async fn` on `Core` (`lib.rs`). Examples include `list_threads`, `get_thread`, `perform_action`, `queue_send`, `search_chronological_page`, `ai_ask` and `due_notifications`.
- **Realtime:** a `tokio::broadcast` `EventBus` with capacity 1,024 (`events.rs`). **Events carry IDs, not data:** `MailUpdated{thread_ids}`, `MailNew{account_id, thread_ids}`, `ActionState{action_id, state, error}`, `AccountState`, `SyncProgress`, `CalendarUpdated`, and streamed AI deltas (`AskDelta`, `AiSummaryDelta`).
  - The UI listener collects dirty IDs and wakes the Slint thread once through an atomic flag (`src/ui_dispatch.rs`, `src/startup.rs:642-718`).
  - **A lagged receiver turns into "everything changed, refetch"**, so lost events can't corrupt the view.
- **Pagination:** keyset cursors, `ThreadCursor{last_message_at, thread_id}` and `SearchCursor{last_match_at, thread_id, relaxed}` (`models.rs:1056-1081`). There is no offset paging.
- **Notifications** go through a durable outbox that the host claims, marks delivered, defers or suppresses (the `notification_outbox` table and the `claim_notification_delivery` family in `lib.rs`). A crash can't duplicate or drop a notification.

### 3f. Send, drafts, threading, labels, calendar, AI

- **Send:**
  - `queue_send` first checks the sender against verified identities (including Gmail send-as aliases) and runs the GnuPG preflight. It then enqueues a `send` action with `not_before = send_at` or now plus `undo_send_seconds` (`lib.rs:4648-4690`).
  - IMAP and POP3 accounts send through the SMTP dispatcher. It keeps its own due-time timer and, after a successful send, triggers durable Sent-folder filing (`engine.rs:385-455`).
  - **Gmail send is idempotent:** before `drafts.send`, and again after an ambiguous 404, it searches `rfc822msgid:` to check whether Gmail already sent the message (`gmail.rs:296-340, 2932-2965`).
- **Drafts:** Gmail drafts are upserted remotely and mapped through `sync_draft_map`. JMAP drafts use `Email/set`. POP3 drafts stay on the device.
- **Threading:** Gmail and JMAP use the provider's thread IDs. IMAP uses References/In-Reply-To first, then a normalized-subject fallback limited to 14 days and applied only to replies (`sync/threading.rs`).
- **Labels and folders:** Gmail labels are native, and `message_folders` handles messages that live in several mailboxes. Auto-labels (Marketing, News, Social, Pitch) are **local-only** and never pushed to the server (`autolabel/mod.rs:1-5`).
- **Routing order** (`route/mod.rs:1-10`):
  1. user split rules;
  2. the AI classifier;
  3. a deterministic heuristic;
  4. Important or Other, based on `is_automated`.

  Steps 1 and 3 run **inside the sync transaction**. AI runs **after commit**, in a background loop that drains threads marked `pending` 50 at a time and caches decisions **per sender domain** (`lib.rs:887-910, 7583-7650`).
- **AI:** any OpenAI-compatible endpoint, OpenRouter by default (`ai/mod.rs:1-15`), with usage accounting. Optional local embeddings come from candle on CPU, run in batches of 4 with 500 ms yields (`embed/worker.rs`).

---

## 4. Engineering quality (brief)

- **CI** (`.github/workflows/quality.yml`): fmt, clippy with `-D warnings`, `cargo test --workspace`, an unused-dependency check, translation validation, verification of the vendored-patch queues, and builds for several feature profiles.
- **Tests:** about 860 `#[test]`/`#[tokio::test]` markers in the core. JMAP sync is tested against an in-process fake server (`jmap/sync_tests.rs:161-209`). Dovecot, POP3, SMTP-sink and perf tests are **gated by env var and not run in CI**. Gmail has only about 10 parser-level tests and no fake-API test.
- **Observability: weak [V].** `tracing` is called throughout, but no subscriber is installed outside the gated tests, so release builds drop every log line. The only switch is `FLECTAR_SYNC_DIAGNOSTICS=1`, which prints redacted stage/outcome JSON to stderr (`events.rs:8-23`). There is no crash reporter.
- **Organization:** clean module boundaries, but `lib.rs` is 10,756 lines and `sync/engine.rs` and `sync/gmail.rs` are over 4,000 lines each. Comments are excellent: nearly every constant explains *why*.

## 5. UI notes (brief)

- Slint 1.18 with a patched winit backend, and Blitz with vendored patches for email HTML.
- The renderer has **no network access unless the user consents**, with strict byte and pixel budgets and public-address pinning (`src/remote.rs:1-60`).
- Shortcuts are declared once in `ui/shortcuts.slint` and used by both the handlers and the Settings list, so the displayed keys can't drift from the real ones (Ctrl/⌘+K search, `/`, A archive, J spam, Backspace trash on Mac, F6 pane switch).
- I found no motion tokens worth noting.

---

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **Gmail full sync as a resumable, generation-stamped scan.** Store `historyId` and a new generation *before* listing. Save the page cursor after every page. Sweep rows from older generations inside the window at the end. Restart with a new generation when the history cursor returns 404. This fixes both the all-or-nothing first sync and the `reset:true` ghosts.
2. **Metadata first, bodies on open,** with an explicit header list that includes `List-Unsubscribe`, `List-Unsubscribe-Post`, `Authentication-Results` and `References`. Aplos's `threads.get?format=full` × 500 costs about 60k units. Metadata for 500 messages costs about 10k units.
3. **Small multipart batches (around 10) and one page per pacing interval.** But replace Flectar's fixed sleep with a **per-account token bucket shared by the backfill and the interactive reader**, and use different classes for `quotaExceeded`/`dailyLimitExceeded` (stop until reset) and 429 rate limits (honor `Retry-After`).
4. **Park on reauth.** Don't retry auth errors on a timer. Wait for the user's Reconnect, which matches the synthesis's `invalid_grant` item.
5. **A separate priority reader per account,** so opening a thread never waits behind a backfill. Debounce and batch open requests.
6. **A `sync_failures` quarantine** with per-message attempts and `next_retry_at`.
7. **Run deterministic routing inside the sync write and AI after commit.** Mark threads `pending`, drain them in bounded batches from an event-driven loop, and cache decisions by sender domain. This is a concrete design for SYNTHESIS weakness #4.
8. **Durable queue semantics:** atomic claim, fair slices, permanent-vs-transient classification, "newest intent wins" rollback, offline sends that don't spend retries, and orphan recovery at startup. Also the `rfc822msgid:` idempotency check before Gmail sends.
9. **Undo-send and send-later as one mechanism:** a `not_before` on the queued send. Aplos lacks both.
10. **ID-only change events, a "lagged means refetch everything" rule, and keyset cursors.** Aplos's `{epoch, rev}` diffs already point this way. Stop shipping `clone(state)`.
11. **A durable notification outbox and a launch-catch-up baseline,** so a restart doesn't fire notifications for old mail. This matters more once several clients share one engine.
12. **Split durable from reconstructable storage:** raw messages and the database in Application Support, extracted attachments in Caches. Keep calendar in a separate database so mail backfills can't block it.
13. **Keychain hygiene:** store the refresh token and the issuing client ID as one atomic bundle, keep access tokens in memory only, and serialize refreshes per account. That last point matters for Microsoft refresh-token rotation, which Inbox Zero gets wrong.
14. **For Microsoft, keep separate token audiences** for mail and Graph calendar if Aplos ever mixes resources.
15. **A bounded SQLite job queue, a small reader cache, and releasing idle connections** keep memory flat. The 80 MB claim comes from discipline, not from Rust alone.

### Avoid

1. **Logging calls with no sink.** Flectar has hundreds of `tracing` calls and still no log file. Aplos should install the rotating, redacted file sink *first*.
2. **Treating daily quota as a rate limit.** It's the same bug as Aplos 0.2.3.
3. **Fixed-interval pacing that ignores interactive traffic.** At 91% of the 6,000 units/min budget there's no room for a user opening threads during a backfill.
4. **Requesting `https://mail.google.com/` just for permanent delete.** Aplos's `gmail.modify` is already restricted. Don't widen it.
5. **`includeSpamTrash=true` on the first pass.** It spends budget on mail nobody reads. Fetch Spam and Trash later or on demand.
6. **Local-only search over lazy bodies.** Without a server search fallback, Gmail body search misses unopened mail. Keep Aplos's server search path.
7. **IMAP without CONDSTORE.** It's acceptable as a fallback, but the flag window of 1,000 UIDs misses older flag changes. Use CONDSTORE/QRESYNC where the server advertises it.
8. **10k-line god files.** Aplos's `service.ts` is already heading that way.
9. **Live-server tests that never run in CI.** Run at least one fake Gmail and one fake IMAP server in CI.

---

## 7. "Local server" translation

### What Flectar already shows

**[V]** Flectar is *not* a server, but its `Core` is already shaped like one.

- **It has a narrow boundary:** about 140 async methods plus one broadcast event stream. The UI never touches SQL, sockets or provider SDKs.
- **Its events are invalidations, not state.** Clients refetch by ID, and a lagged subscriber resyncs. That is the JMAP `state` + `/changes` model without the wire format.
- **It enforces single ownership.** `single_instance.rs` ensures one engine per profile, and it already runs headless through tray mode, autostart and the `ui_ready` timeout.
- **Hosts inject their platform services:** credentials, OAuth redirect broker and paths come in as handles (`start_mail_ui_with_platform`, `CredentialStoreHandle`, `OAuthRedirectBrokerHandle`). That's the same "ports" idea as Aplos's `src/engine/ports.ts`.

Its mobile answer is the same as Mustang's: **run the whole core on the phone** (Android and iOS hosts under `platform/`). That duplicates sync, credentials and AI on every device.

### Mapping onto an Aplos daemon

The sibling report `extra-parula-mustang.md` §7 already covers the generic daemon plumbing: ephemeral port, token file, `/v1`, Bonjour/QR pairing and TLS pinning. Flectar adds these specifics:

1. **Make the engine process the profile owner.** Copy the *idea* of `single_instance.rs`: an advisory lock plus a Unix socket in the data directory. The first Aplos engine owns `aplos.db` and the provider connections. Any later Electron window, CLI or phone bridge connects to it instead of starting a second sync. Run it as a login item or menu-bar agent so it syncs with no windows open.
2. **Make the API a projection of the core's methods, not the reverse.** Group Aplos's ~55 invoke methods into JMAP-like resources: `Thread/query` (keyset cursor `{lastMessageAt, threadId}`), `Thread/get`, `Message/get` (bodies lazy, through `GET /blob/:id`), `Action/set` (goes straight into the durable op queue and returns an action ID), and `Draft/set`, `Send/set` (with `sendAt` and `undoUntil`).
3. **Push.** One WebSocket or SSE stream carrying Flectar-style ID-only events, stamped with Aplos's `{epoch, rev}`:
   - `mail.changed{threadIds}`, `mail.new`, `action.state{id, state, error}`, `account.state`, `sync.progress`, `ai.delta{requestId}`.
   - A client that sees a rev gap does what Flectar does on `Lagged`: refetch the current page. This replaces today's whole-state snapshots and makes phone traffic small.
4. **Claimable notifications.** Turn the notification outbox into an API (`Notification/claim`, `/ack`). The Mac UI or the phone, whichever is active, claims each item once. Without this, two clients both alert, or neither does.
5. **AI and routing stay in the daemon.** The AI router is just another subscriber to `mail.changed`. A phone sees `routedTab` and summaries as plain fields, with no keys or models on the device.
6. **Separate concerns per account inside the daemon:** an actor for cheap sync and IDLE, a priority reader, a backfill worker, and a send dispatcher with its own timer. An interactive `Message/get` from the phone should use the priority reader, never the backfill queue.
7. **Credential gating.** The daemon may start before any UI. Flectar's "wait for UI ready, then time out" maps to "the daemon reads the Keychain at login. If the Keychain needs a prompt, `account.state = needs_unlock` until a UI attaches."

### Pros

- One engine, one database and one quota budget per Google account. A phone hitting Gmail directly would share the per-user, per-project 6,000 units/min with the Mac and cause exactly the kind of 403/429 Aplos already hit.
- Flectar's own split, an in-process core behind an ID-event bus, shows the boundary works. Aplos would just add a wire.
- It fixes Aplos's memory ceiling as a side effect. A paged, ID-invalidation API forces the move away from the in-memory, cloned mailbox.
- Durable outboxes for actions and notifications make multiple clients safe.

### Cons

- The Mac must be awake. For a phone, this gives at best a read cache with queued actions, or a direct-to-provider fallback, which brings back the quota sharing above.
- A LAN-reachable mail daemon is new attack surface. See the sibling report for the pairing and TLS floor.
- Lazy bodies plus a remote client mean many small fetches. The blob endpoint needs range support and HTTP caching (ETag = message ID + body state).
- **[I]** Flectar itself chose run-the-core-on-each-device for mobile. That path is proven but costly, and it suggests a daemon-plus-phone setup isn't solved in this lineage either.

### Effort (one developer plus agents) [I]

| Stage | Work | Estimate |
|---|---|---|
| A | Gmail sync rework: generation, checkpoints, metadata first, shared token bucket, reason classes | 4-6 days. Do it first, whatever happens with the daemon |
| B | SQLite-backed paging plus ID-only events. Remove `clone(state)` and the in-memory mailbox | 1-2 weeks |
| C | Profile-owner lock and headless engine lifecycle (login item, menu-bar) | 3-5 days |
| D | `/v1` resources, WebSocket push, blob endpoint, notification claim API | 1-2 weeks |
| E | LAN phone pairing and a phone client | Weeks to months. Defer, as the sibling report recommends |

**Recommendation:** A and B are worth doing now on their own merits. They turn Aplos's engine into a Flectar-style core. C and D are a small step after that, and E can wait.
