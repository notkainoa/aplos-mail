# Velo: architecture audit for the Aplos revamp (lighter pass)

**Target.** `avihaymenahem/velo`, shallow clone at `ec47a7a` (2026-03-11, "fix: bind OAuth server to 127.0.0.1 instead of localhost"), read at `/Users/knewton/.t3/aplos-research/src/velo`. Nothing was installed, built or run. Paths are relative to the clone root. **License: Apache-2.0** (`LICENSE`, `package.json`, `src-tauri/Cargo.toml`). That is permissive, but this report still describes ideas only and copies no code.

**Scope.** This is a lighter audit focused on §3 (architecture), §6 (lessons) and §7 (the local-server translation). Sections 1, 2, 4 and 5 are kept short. Labels: **[V]** means I verified it in code or via the GitHub API. **[I]** means inference.

---

## 1. Overview

- **What it is.** A local-first, keyboard-first desktop client built on Tauri v2 with a Rust shell and a React 19 + TypeScript UI. It supports Gmail (REST API) and IMAP/SMTP, plus Google Calendar and CalDAV, and bundles a lot of AI features. In scope it is close to a feature twin of Aplos.
- **Activity [V]** (`gh api`):
  - Repo created 2026-02-11. Last release `velo-v0.4.21` on 2026-02-27. Last commit on `main` 2026-03-12. `pushed_at` is 2026-06-02 (some branch).
  - 726 stars, 127 forks, 67 open issues.
  - Contributors: `avihaymenahem` 175 commits, `github-actions[bot]` 38, `claude` 15, `knabe` 3, `dependabot` 3, `edvintb` 2.
  - So it was one developer plus AI agents, about 2.5 weeks from creation to v0.4.21, and then it stalled. That is very close to Aplos's own profile, and it shows what a feature-dense, agent-built client looks like about six months after the burst.
- **Target user.** Power users who want Superhuman-style keys, local storage and BYO AI keys, and who are willing to **create their own Google Cloud OAuth client** (`src/services/gmail/tokenManager.ts`, `getClientId`/`getClientSecret`; the `SetupClientId` UI).
- **Open issues worth knowing [V]:**
  - #240 SQLite BUSY during IMAP sync (with #192, #186 and #196 as related issues).
  - #297 the Bcc header is transmitted over SMTP.
  - #232 high CPU in WebKit on Linux.
  - #256 a password containing a quote breaks sync.
  - #278 the macOS build is ad-hoc signed and Gatekeeper rejects it.
  - #257 no Outlook 365 support.

## 2. Feature inventory (condensed)

| Feature | Evidence | Maturity |
|---|---|---|
| Gmail API sync (initial + History delta) | `src/services/gmail/sync.ts` | Works for small mailboxes; correctness gaps (§3c) |
| IMAP/SMTP (Rust `async-imap` + `lettre`), XOAUTH2 for Microsoft and Yahoo | `src-tauri/src/imap/client.rs`, `src/services/oauth/providers.ts` | New mail only; no flag or expunge sync |
| JWZ threading for IMAP | `src/services/threading/threadBuilder.ts` | Solid algorithm; weak IDs (§3f) |
| Offline action queue with compaction | `src/services/queue/queueProcessor.ts`, `db/pendingOperations.ts` | Good idea; ordering and crash gaps |
| Gmail draft sync up (3 s debounce) | `src/services/composer/draftAutoSave.ts` | Works on Gmail; IMAP duplicates drafts |
| Undo send, scheduled send, snooze, follow-ups, newsletter bundles | `src/services/snooze/*`, `followup/`, `bundles/` | Run only while the app window is alive |
| Local filters (AND criteria) and quick steps (18 action types) | `src/services/filters/filterEngine.ts`, `quickSteps/` | Gmail delta path only |
| Rule-first categorization plus AI refinement; smart labels | `src/services/categorization/ruleEngine.ts`, `ai/categorizationManager.ts`, `smartLabels/` | Reasonable design |
| AI: summaries, smart replies, compose/transform, Ask My Inbox, writing style, task extraction | `src/services/ai/*` | Claude, OpenAI, Gemini, Ollama, Copilot; run from the webview |
| One-click unsubscribe (RFC 8058 plus mailto) | `src/services/unsubscribe/unsubscribeManager.ts` | Headers stored at sync time |
| Phishing heuristics, SPF/DKIM/DMARC badges | `src/utils/phishingDetector.ts`, `gmail/authParser.ts` | Nice extra |
| Calendar (Google with syncToken; CalDAV via `tsdav`) | `src/services/calendar/*` | CalDAV refetches a 90-day window |
| Attachment cache with size cap, plus pre-cache | `src/services/attachments/*` | Good |
| Tasks, templates, signatures, send-as aliases, smart folders | `src/services/db/*` | Breadth over depth |

---

## 3. Architecture deep dive

### 3a. Process and deployment topology

**[V] Nearly everything runs inside the webview.**

- The Rust side (`src-tauri/src/lib.rs`, `commands.rs`, `oauth.rs`) is a thin native shell. It provides the tray, single-instance handling, the splash screen, the OAuth loopback listener, stateless IMAP/SMTP commands, and plugins (sql, http, fs, notification, updater, autostart, deep-link, global-shortcut).
- **The sync engine, the database access layer, the offline queue, every background checker, AI calls and token refresh are all TypeScript running in the main window's JS context.** `App.tsx` starts them in order (CLAUDE.md "Startup sequence"):
  - sync every 60 s
  - snooze, scheduled send, follow-ups and bundles every 60 s
  - the queue every 30 s
  - attachment pre-cache every 15 min
- These are plain `setInterval`s (`src/services/backgroundCheckers.ts`).
- The webview gets broad capabilities (`src-tauri/capabilities/default.json`): `sql:allow-execute` (raw SQL from JS), `http:default` for any `http(s)://*` URL, and `fs` for `$APPDATA/**`.
- AI SDKs run in the browser context with `dangerouslyAllowBrowser: true` (`src/services/ai/providers/claudeProvider.ts:6`, `openaiProvider.ts:6`).

Consequences:

- **There is no daemon and no server.** The closest thing to a background agent is minimize-to-tray plus autostart (`tauri-plugin-autostart`). The app hides instead of quitting, so the webview's timers keep running.
- If the webview reloads or hangs, sync, the queue and scheduled sends stop with it. **[I]** Long synchronous work such as JWZ threading over a year of mail, or JSON parsing of 200-message IPC chunks, competes with UI frames on the same thread. Issue #232 (WebKit CPU) is consistent with this, though the always-on 20 s blurred gradient-blob animation (`src/styles/globals.css:117`) is an equally likely cause.
- Pop-out thread and compose windows (`src/main.tsx`) are separate webviews. They read SQLite directly but don't receive the main window's `velo-sync-done` DOM events. **[I]** So they can go stale.

### 3b. Connectivity and credentials

- **Gmail**
  - REST at `https://www.googleapis.com/gmail/v1` (`src/services/gmail/client.ts`).
  - OAuth uses PKCE plus `state`, with a Rust loopback listener on `127.0.0.1:17248-17251` (`src-tauri/src/oauth.rs`) that has a 5-minute accept timeout and reads one request.
  - The client ID and secret are **supplied by the user** and stored in `settings`. The secret goes in an encrypted setting; `auth.ts` refuses to start without one.
  - Scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`, `gmail.labels`, `calendar.readonly`, `calendar.events` and userinfo (`src/services/gmail/auth.ts`).
  - Because each user runs their own Google Cloud project, Velo never needs Google verification or CASA. **[I]** The price is heavy onboarding friction, and if the user leaves their project in "Testing", refresh tokens expire after 7 days.
- **Microsoft and Yahoo** use IMAP/SMTP with XOAUTH2.
  - The Rust side implements the XOAUTH2 authenticator for IMAP (`client.rs:39-60`) and forces `Mechanism::Xoauth2` for SMTP (`smtp/client.rs:25-29`).
  - The Microsoft authority is hardcoded to the `consumers` tenant (`oauth/providers.ts`), which is why Microsoft 365 work accounts fail (#257).
  - The OAuth client ID is again per account and user-supplied (`oauthTokenManager.ts:44`).
- **Generic IMAP** uses password auth over TLS, STARTTLS or plain.
  - There is a static autodiscovery table for 7 providers (`imap/autoDiscovery.ts`).
  - An `accept_invalid_certs` per-account switch (migration 23; `client.rs:132-136`) turns off both certificate and hostname validation.
- **IMAP connection model [V].** Every Tauri command opens a fresh TCP, TLS and login session, runs SELECT and the command, then logs out (`src-tauri/src/commands.rs`). An initial sync of N chunks costs N logins. The only exception is the batched `imap_delta_check`, which checks all folders over one session.
  - Timeouts: TCP, TLS, auth and command 30 s; search 60 s; fetch 120 s; whole connect 60 s (`client.rs:12-20`).
  - There is a hand-written raw-TCP FETCH parser as a fallback when `async-imap` can't parse a server (`client.rs:939+`).
- **Token storage [V].** OAuth tokens, IMAP and CalDAV passwords, AI keys and the Google client secret are AES-256-GCM encrypted in SQLite columns (`src/utils/crypto.ts`, `db/accounts.ts:42-70`).
  - **The key is a random 32-byte value stored base64 in plain text in `velo.key` in the same AppData directory as `velo.db`** (`crypto.ts`, `KEY_FILE_NAME`).
  - There is no Keychain, libsecret or DPAPI. Anyone who can read the data directory gets both, so this is obfuscation, not protection.
  - Decrypted tokens live in the webview heap.
  - Aplos's Keychain-wrapped data key (`keyring.ts`) is strictly better. Keep it.

### 3c. Sync algorithm

**Gmail initial sync** (`gmail/sync.ts` `initialSync`) [V]:

1. Upsert labels.
2. Call `threads.list` with `q=after:<today − sync_period_days>` (default **365 days**, `syncManager.ts`), 100 per page, **with no cap**, collecting every ID in memory.
3. Call `threads.get?format=full` for each one at **concurrency 10** (`parallelLimit(..., 10)`). There is no batch endpoint, no `fields` mask and no metadata-first pass.
4. Each thread is stored as it arrives: thread row, labels, rule-based category, messages with full bodies, and attachment metadata.
   - Inline in that per-thread path, auto-archive categories fire a **network write** (`modifyThread`) and bundle "hold" rules run.

Problems:

- **Pacing.** `fetchWithRetry` retries only HTTP 429, three times, honoring Retry-After (`client.ts:76-95`). Gmail's usual `403 rateLimitExceeded`/`userRateLimitExceeded` isn't retried. `classifyError` maps every 401 or 403 to non-retryable "auth" (`src/utils/networkErrors.ts`). This is the same class of bug as Aplos's 403 incident, at 2.5× Aplos's concurrency and with no window cap.
- **Silent holes.** A thread that fails after retries is logged and skipped (`catch → console.error`), and the sync still "succeeds". Nothing records the missing IDs, so they are never retried. This is the opposite failure mode from Aplos's all-or-nothing approach, and also wrong.
- **Cursor race.** The stored `historyId` is the **maximum `thread.historyId` seen after all fetches**, written only at the end. It isn't `getProfile().historyId` captured *before* listing. If thread A changes after it was fetched, and a later-fetched thread B carries a higher historyId, A's change is skipped forever. **[I]** The race needs mail traffic during a long sync, which is exactly when a 365-day sync is long. Aplos already does this correctly.
- **No resume.** Since `history_id` is written only at the end, a crash or quit means the next launch starts `initialSync` from scratch. The upserts are idempotent, but the quota is spent again.

**Gmail delta** (`deltaSync`) [V]:

- Pages through `history.list` (with 4 `historyTypes`) and collects affected thread IDs. It then refetches **each affected thread in full at concurrency 10**, even for label-only changes and even though history records already carry `labelIds`.
- **It skips threads that have pending local ops but still advances `historyId`** (`sync.ts` delta loop, then `updateAccountSyncState(latestHistoryId)`). The server-side change to that thread is lost until something else touches it.
- **Deletions leave ghosts.** A fully deleted thread makes `getThread` return 404. That is caught and logged, and the local row stays.
- History expiry is detected by **string-matching "404" or "historyId" in the error message**. It falls back to `initialSync`, which only upserts and never removes rows that vanished upstream. This is the same as Aplos's ignored `reset` flag.
- Post-processing:
  - notifications, filtered by VIP, category and mute
  - local filters on new inbox messages
  - smart labels (fire-and-forget)
  - AI categorization of the 20 most recent rule-categorized threads, using subject and snippet only, fire-and-forget (`ai/categorizationManager.ts`)
- **AI is not on the sync critical path.** That is the right call, and the opposite of Aplos's awaited `classifyIncoming`.

**IMAP initial sync** (`imap/imapSync.ts` `imapInitialSync`) [V]:

1. LIST all folders. Only `[Gmail]` and `[Nostromo]*` containers are skipped, so Trash, Spam and Gmail-over-IMAP *All Mail* are synced (`folderMapper.ts:156-165`).
2. For each folder, run `UID SEARCH SINCE <date>`. Then `UID FETCH ... BODY.PEEK[]`, meaning the **entire RFC822 message**, in 200-UID IPC chunks. Each chunk opens its own connection.
3. **Each chunk is committed in its own transaction**, with a placeholder thread per message. Only lightweight metadata (IDs, headers, flags) stays in memory for threading. This is a deliberate fix for out-of-memory errors on large mailboxes, and a good one.
4. After all folders, JWZ-thread everything, rewrite `thread_id` in batches of 100, and delete the placeholder threads.
5. **Circuit breaker:** 1 s between folders, a 15 s cooldown after 3 consecutive connection failures, and skipping the remaining folders after 5. A chunk gets one retry after 2 s.
6. Per-folder `folder_sync_state` (UIDVALIDITY, last_uid) is written after each folder. The account is only marked synced at the end, so a crash re-runs everything.

**IMAP delta** (`imapDeltaSync`) [V]:

- For each known folder, one batched session checks UIDVALIDITY and runs `UID SEARCH UID last_uid+1:*`. It fetches only the new UIDs. If UIDVALIDITY changed, that folder is refetched in full.
- **There is no flag sync and no expunge or move detection.** Read, star or delete on another device never reaches Velo.
  - The `modseq` column exists, and the server's `HIGHESTMODSEQ` is even returned (`client.rs:246`), but every write stores `modseq: null`.
  - There is no CONDSTORE `CHANGEDSINCE`, no QRESYNC `VANISHED`, and no UID-set diff fallback.
- **Thread aggregate bug.** New messages are threaded only among themselves. The deterministic thread ID (below) lands them in the right existing thread. But `storeThreadsAndMessages` then calls `upsertThread` with `message_count`, `subject`, `snippet` and `is_read` computed from **only the new messages**. `setThreadLabels` **deletes and replaces all thread labels** with only the new messages' labels (`db/threads.ts:88-137`). A reply to a 10-message thread therefore resets its count to 1 and can drop SENT or user labels.

**Push: none [V].** There is no IMAP IDLE (no `idle` anywhere in `src-tauri/src` or `src/services`), no Gmail `watch` and no CalDAV push. `runSync` walks accounts **serially** under one global promise, with a pending-ID merge queue (`syncManager.ts`). The tray offers "check mail".

**Offline outbox and conflicts** (`emailActions.ts`, `queue/queueProcessor.ts`, `db/pendingOperations.ts`) [V]:

- **Every action does three things:** an optimistic Zustand update, a local SQL update, and then either a direct provider call (online) or a `pending_operations` row (offline, or a "retryable" online failure).
- **The processor** runs every 30 s and on reconnect. It processes up to 50 ops globally in `created_at` order. Backoff steps through 60 s, 300 s, 900 s and 3,600 s, then marks the op `failed`.
- **Compaction** cancels opposite star and read toggles and add/remove pairs for the same label on the same resource before each run. That is a nice touch.

Gaps:

- An op set to `executing` is **never reset** if the app dies mid-call (no code path selects or recovers `executing`).
- One failed op doesn't hold back later ops on the same resource, so order isn't preserved.
- **`sendMessage` is queued and retried on "retryable" errors**, including timeouts, with no idempotency check. A send that timed out after Gmail accepted it can go out twice. Aplos's `findSent` guard is better.
- Conflict policy is "skip incoming server data for threads with pending ops", with the cursor-advance flaw described above.

### 3d. Local storage

- **Engine.** SQLite through `tauri-plugin-sql` (sqlx), file `velo.db`. JS calls `Database.load()` and sends SQL strings over IPC (`src/services/db/connection.ts`).
  - **No WAL and no busy_timeout** [V]: there is no `journal_mode` pragma anywhere.
  - Transactions are serialized by a JS promise mutex (`withTransaction`). About 74 other files call `getDb()` and write outside it. Issue #240 traces SQLITE_BUSY failures to exactly this.
  - **[I]** Issuing `BEGIN` and `COMMIT` as separate `execute` calls through a pooled plugin is fragile in general. Migration 21's comment ("failed due to DB lock") suggests they hit it.
- **Schema** (`src/services/db/migrations.ts`, 23 versions, 37 `CREATE TABLE`s; the docs variously say 34, 35 and 37) [V]. It is properly relational:
  - `accounts`: provider, encrypted tokens and passwords, `history_id`, IMAP/SMTP host, port and security, `auth_method`, `accept_invalid_certs`.
  - `threads (account_id,id)`: subject, snippet, `last_message_at`, `message_count`, read, starred, important, attachments, snoozed, pinned and muted flags.
  - `thread_labels (account_id,thread_id,label_id)` as a junction table, and `labels`, which carries `imap_folder_path` and `imap_special_use`.
  - `messages (account_id,id)`: addresses, subject, snippet, date, flags, **`body_html` and `body_text` inline**, `raw_size`, `list_unsubscribe(_post)`, `auth_results`, `message_id_header`, `references_header`, `in_reply_to_header`, `imap_uid`, `imap_folder`.
  - `attachments`: metadata, `gmail_attachment_id` (reused for the IMAP part ID), `content_id`, `local_path`, `cached_at`, `cache_size`.
  - `folder_sync_state` (uidvalidity, last_uid, modseq), `pending_operations`, `ai_cache (account,thread,type)`, `thread_categories`, `calendars`, `calendar_events`, `filter_rules`, `scheduled_emails`, `contacts`, `tasks`, and about 20 more feature tables.
- **Indexes** are sensible: `(account_id, last_message_at DESC)`, a pinned index, `thread_labels(account_id,label_id)`, `messages(account_id,thread_id,date)`, `messages(message_id_header)`, and `(account_id,imap_folder,imap_uid)`.
- **Bodies and attachments.** Full bodies are always stored. Gmail stores `format=full`; IMAP stores the full message parsed by `mail-parser`.
  - Attachments are fetched lazily, cached to `attachment_cache/` with a size cap, and evicted oldest-first. A background pre-cache pulls attachments under 5 MB from the last 7 days every 15 min (`attachments/cacheManager.ts`, `preCacheManager.ts`).
  - **Bodies are never evicted.**
  - Re-fetching an IMAP attachment re-downloads the whole message (`client.rs:567+`).
- **Search.** An external-content FTS5 table `messages_fts` with the `trigram` tokenizer over subject, from_name, from_address, body_text and snippet, kept in sync by insert, update and delete triggers (migration 2).
  - A Gmail-operator parser turns `from:`, `has:attachment`, `before:` and so on into SQL (`search/searchParser.ts`, `searchQueryBuilder.ts`).
  - **[I]** Trigram needs at least 3-character terms and inflates the index to roughly 3× the text.
- **Encryption at rest.** Mail isn't encrypted. Secrets are encrypted with a key stored next to them (§3b).
- **Migrations.** Versioned, each in a transaction, tolerant of "duplicate column", with ad-hoc repair code after the loop.
  - Notably, **data-fix migrations just delete derived rows and clear sync cursors to force a resync** (v20, v21, `imap_attachment_repair_v1`). The local DB is treated as a rebuildable cache of the server. That's a cheap, robust lever.

### 3e. API between UI and engine

There is none [V]:

- Components call service functions, and services issue SQL directly.
- Lists page with `LIMIT/OFFSET` (`db/threads.ts:22-83`), with infinite scroll in `EmailList.tsx` and no virtualization.
- Change propagation is a coarse DOM event. `window.dispatchEvent('velo-sync-done')` comes from sync, snooze, follow-ups, bundles and actions, and every list re-queries after a 500 ms debounce (`EmailList.tsx:455-467`, `Sidebar.tsx:295`).
- There are no row-level diffs, no sequence numbers and no cross-window delivery.
- Services import UI stores directly: `emailActions.ts` reads `useUIStore.getState().isOnline` and mutates `useThreadStore`, and the queue processor checks `isOnline`. So **the service layer cannot run headless** without refactoring.

### 3f. Send, drafts, threading, labels, calendar, AI

- **Send.**
  - TipTap HTML goes to `buildRawEmail` (an RFC 2822 builder in TS).
  - A renderer `setTimeout` provides undo-send (default 5 s, a setting).
  - Then either Gmail `messages.send`, or SMTP via `lettre`, followed by a best-effort APPEND to Sent and a local insert (`imapSmtpProvider.ts:393-423`).
  - Issue #297: the SMTP path sends the `Bcc` header to recipients.
  - Scheduled send is a local table polled every 60 s, so it only fires while the app is running.
- **Drafts.**
  - Gmail drafts go up via `drafts.create`/`update` with a 3 s debounce. Drafts made elsewhere come in through normal sync via the DRAFT label.
  - **IMAP drafts are broken [V].** Each save APPENDs a new message with a made-up `imap-draft-…` ID (`imapSmtpProvider.ts:513-526`), because there is no UIDPLUS `APPENDUID`. The following update can't map that ID back to a UID, so it can't delete the previous copy (`:543-557`). Autosave therefore piles copies into the server's Drafts folder.
  - The `local_drafts` table and `db/localDrafts.ts` exist, but nothing outside tests imports them.
- **Threading.**
  - Gmail uses its native `threadId`.
  - IMAP uses a full JWZ implementation with phantom containers and subject merging. The thread ID is deterministic, derived from the root Message-ID so that delta sync and initial sync agree (`threadBuilder.ts:121`, `:298-307`). That's a good idea.
  - The hash, however, is **32-bit djb2**. By the birthday bound, about 50k thread roots per account gives roughly a 25% chance that two unrelated conversations merge, and 100k gives about 70%.
  - **[I]** Subject-merged roots that only the full pass can see will get different IDs on delta.
- **Labels and folders.**
  - The Gmail label model is canonical. IMAP folders map to labels via special-use flags and well-known names (`folderMapper.ts`).
  - Labels from copies of the same Message-ID in multiple folders are merged, which is what makes Gmail-over-IMAP All Mail tolerable.
- **Calendar.** Google uses `syncToken` incrementals with a 90-day bootstrap. CalDAV via `tsdav` ignores the token and refetches a 90-day window (`caldavProvider.ts:154-170`).
- **AI.**
  - Providers: Claude, OpenAI, Gemini, Ollama and GitHub Copilot models, chosen globally, with keys in encrypted settings (`providerManager.ts`). Every call runs in the webview.
  - Summaries and smart replies are on demand and cached in `ai_cache`.
  - Ask My Inbox strips stopwords, takes the top 15 FTS hits and makes one LLM call (`askInbox.ts`). It's simple, with no tools or agent loop. Aplos's agent is more capable.
  - Categorization and smart labels are rule-first, with AI refinement in the background.

---

## 4. Engineering quality (brief)

- **Tests.** 133 colocated Vitest/jsdom test files [V], covering services, stores, components and utils. There are 6 Rust tests, all in `smtp/client.rs`.
  - **CI runs tests only in the release workflow** (`.github/workflows/release.yml` triggers on `release: created` or a manual dispatch). There is no PR or push CI.
- **Code.** Readable, formatted, plain functions, and `noUncheckedIndexedAccess` is on. CLAUDE.md is an accurate map, which is a sign of agent-driven development like Aplos's.
- **Errors.** Classification is string-based (status regex over `error.message`, `includes("404")`), which is brittle.
- **Observability.**
  - Rust registers `tauri-plugin-log` (`lib.rs:118-128`, default targets). **[I]** That means stdout plus a log-dir file.
  - The TS service layer, where all the sync logic lives, uses `console.*` only and doesn't forward to the log plugin.
  - There is no crash reporter or diagnostics export. It has the same blind spot as Aplos.

## 5. UI notes (brief)

- **Stack.** React 19, Zustand 5 (9 stores), TanStack Router, Tailwind v4 with semantic tokens and 8 accent themes, TipTap v3, lucide, @dnd-kit, and react-transition-group with CSS classes.
- **Motion tokens.** `--anim-fast 150ms`, `--anim-normal 200ms`, `--anim-slow 300ms`. Enters use ease-out and exits use ease-in, and modals scale from 0.95 (`globals.css:276-351`). There is an always-running 20 s gradient-blob background.
- **Keyboard.** Superhuman-style single keys plus `g`-prefixed two-key sequences with a 1 s timeout. Keys are ignored inside inputs, and bindings are user-remappable and persisted in SQLite (`src/hooks/useKeyboardShortcuts.ts`, `constants/shortcuts.ts`).
- **Email HTML.**
  - Rendered in an `<iframe sandbox="allow-same-origin">` with no `allow-scripts`, written via `contentDocument.write` (`EmailRenderer.tsx:118-240`).
  - DOMPurify forbids `style` tags but allows `style` attributes (`utils/sanitize.ts`).
  - Remote images are blocked by default, with a per-sender allowlist.

---

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **A normalized relational mail schema with SQL paging, replacing the in-memory mailbox.**
   - Thread summary rows, a message table, a thread↔label junction, attachment metadata, and bodies in their own column or table loaded only on open.
   - Velo's UI never holds more than a page, and that is the direct fix for Aplos's memory ceiling.
   - Use keyset paging on `(last_message_at, id)` rather than Velo's `OFFSET`.
2. **Recompute thread rollups from messages, never from the delta batch.** This is Velo's own bug inverted: after any message insert, derive count, snippet, unread, starred and labels with one SQL aggregate over `messages` for that thread.
3. **External-content FTS5 maintained by triggers** keyed on `rowid`. This fixes Aplos's full scan on `DELETE … WHERE id=?` over an `UNINDEXED` column.
   - Consider `unicode61` with prefix indexes for bodies, plus trigram only on addresses and subjects, to avoid trigram's index size and 3-character minimum.
4. **AI off the sync path, with deterministic rules first.**
   - Categorize at ingest from labels, `List-Unsubscribe` and sender patterns.
   - Refine with AI on a small, recent, subject-and-snippet batch, fire-and-forget.
   - Summaries on demand, cached persistently per thread.
5. **Chunked, committed initial sync with bounded memory.** Write each fetch batch in its own transaction and keep only threading metadata in RAM. Add a per-account circuit breaker with inter-folder delays.
   - Go one step further than Velo: persist a resume cursor (per-folder UID watermark or Gmail page token plus a "done IDs" set), so a restart continues instead of starting over.
6. **One session for the IMAP "anything new?" sweep across all folders** (Velo's `imap_delta_check`), instead of a connection per folder.
7. **Queue compaction.** Cancel opposite toggles and add/remove pairs per resource before flushing. It's cheap and reduces provider calls after offline bursts.
8. **Gmail draft sync with a 3 s debounce through `drafts.create`/`update`.** This closes Aplos's "drafts never reach the phone" gap with little code. For IMAP, do it properly with UIDPLUS `APPENDUID` (or a SEARCH by Message-ID header as a fallback) so the previous copy can be deleted.
9. **Store `List-Unsubscribe` and `List-Unsubscribe-Post` at sync time**, then offer the one-click POST, mailto and link ladder from the UI.
10. **An attachment cache with a size cap and background pre-cache** of small, recent attachments, separate from the message rows.
11. **"Invalidate cursor" data-fix migrations.** When a parser or schema bug corrupts derived data, delete it and clear the cursor rather than writing a JS migration.
12. **Deterministic IMAP thread IDs from the root Message-ID**, but hashed with at least 128 bits (for example truncated SHA-256).
13. **A small local filter engine** (AND criteria → label, archive, read, star, trash) applied to new inbox mail during sync. It's a starting point for Aplos's missing rules, paired with provider-side filters for when the Mac is asleep.

### Avoid

1. **Running the engine in the UI context.** Velo's sync, DB, AI, tokens and timers all live in the webview. That is the root of #232-style jank, stale pop-outs and "nothing runs if the window is reloaded". Aplos's `utilityProcess` engine is already the better shape, so don't regress during the UI revamp.
2. **Key-next-to-ciphertext encryption** (`velo.key` beside `velo.db`). Keep the Keychain-wrapped key.
3. **Broad renderer capabilities**: raw SQL execution, HTTP to any URL, AI SDKs with `dangerouslyAllowBrowser`. Keep secrets and network in the engine.
4. **Velo's Gmail first-sync shape**:
   - an unbounded 365-day list
   - `format=full` at concurrency 10
   - retrying only 429 while classifying all 403s as permanent
   - swallowing per-thread failures
   - taking `historyId` from the fetched threads at the end
   Aplos's planned budgeted, metadata-first, resumable redesign is right. Velo shows that the opposite failure mode (best-effort with silent holes) is also wrong.
5. **Advancing the history cursor past changes you skipped.** If a thread has pending local ops, park its ID in a "recheck" set that is retried after the queue drains.
6. **Ignoring deletions.** 404 on refetch, expunges, and "history expired" fallbacks must all reconcile. Velo has the same ghost-thread bug as Aplos's ignored `reset`.
7. **IMAP delta that only looks at `UID > last_uid`.** Use CONDSTORE `CHANGEDSINCE` for flags and QRESYNC `VANISHED` for expunges. Fall back to a periodic `UID SEARCH ALL` diff on servers without them. Velo stores `modseq` and never uses it.
8. **Connect, login and logout per command.** Keep one long-lived session per account for commands and a second for IDLE.
9. **Retrying sends on ambiguous failures with no duplicate check.** Keep Aplos's `findSent` idempotency, and never put `executing` ops in a state that can't be recovered after a crash.
10. **String-matched error classification.** Carry structured `{status, reason, retryAfter}` from the adapters.
11. **SQLite without WAL and `busy_timeout`, with many uncoordinated writers.** Velo's #240 is the cautionary tale. Use one writer connection owned by the engine.
12. **The SMTP Bcc leak (#297).** Add a test that Aplos's SMTP path strips `Bcc` from the transmitted message.
13. **Coupling services to UI stores** (`isOnline`, optimistic list mutations inside `emailActions`). Engine logic must be headless to become a daemon (§7).
14. **CI only at release time**, and per-user Google client IDs as the *only* path. That is fine as an "advanced" option for Aplos, but a terrible default for onboarding.

---

## 7. "Local server" translation

Velo has no server of any kind. Its "daemon" is a hidden window kept alive by minimize-to-tray and autostart. That makes it useful here mostly as a negative example: it shows which jobs need a long-lived owner, and what breaks when the UI process is that owner. Its **data model and command vocabulary** do translate well, though.

**What would move into an Aplos daemon (`aplosd`).**

- Every job Velo runs as a webview `setInterval` belongs in the daemon:
  - sync scheduling, plus IMAP IDLE and JMAP EventSource connections
  - the op queue
  - scheduled send, snooze wake-ups and follow-up checks
  - attachment pre-cache
  - the AI enrichment queue
  - the single SQLite writer
- Aplos's current engine is already a separate process with ports (`src/engine/ports.ts`), so the first step is a transport change, not a rewrite.
- In process terms:
  - **Phase A:** keep the Electron `utilityProcess`.
  - **Phase B:** run the same entry point as a LaunchAgent (registered via `SMAppService`) that outlives the window. Electron becomes just a client.

**API shape.** Make it JMAP-shaped but private: one JSON protocol over WebSocket, with HTTP for blobs.

- **Commands.** Velo's `EmailAction` union (archive, trash, permanentDelete, markRead, star, spam, moveToFolder, addLabel, removeLabel, sendMessage, createDraft, updateDraft, deleteDraft) is a ready-made command set.
  - The endpoint is `command.submit {clientCommandId, accountId, type, target, params}`.
  - The daemon applies it locally, enqueues it (with compaction), and returns `{opId, seq}`.
  - `clientCommandId` gives you idempotency when a phone retries.
- **Queries.**
  - `threads.query {mailbox|label, filter, after:<keyset>, limit}` returns IDs plus summary rows.
  - `thread.get` returns messages without bodies.
  - `message.body` returns sanitized HTML with remote images rewritten to a daemon proxy URL.
  - `GET /blob/:attachmentId` streams the attachment.
  - `search.query` takes Velo-style operators plus FTS.
- **Change propagation.** Replace Velo's "something changed, re-query everything" event (and Aplos's in-memory `{epoch, rev}`) with a **persistent change log**: `changes(seq INTEGER PRIMARY KEY, entity, entity_id, kind)`, written in the same transaction as the data.
  - Clients subscribe with `since=<seq>` and receive `{seq, entity, ids}` batches, then refetch only those rows.
  - When the log has been trimmed past a client's `since`, the daemon answers "cannotCalculateChanges, resnapshot", exactly like JMAP `/changes`.
  - This is what makes a phone that reconnects after hours cheap.
- **Why not literal JMAP?** Aplos needs non-JMAP state (Done/Later, AI summaries, calendar, workflow sync), and RFC 8620/8621 is a lot of surface to conform to. Borrowing the semantics (state strings, `/changes`, `/query` with positions, `EmailSubmission` idempotency) gets most of the benefit. **[I]** A JMAP facade could be added later for third-party clients.

**Security.**

- Bind to `127.0.0.1`. Require a bearer token stored `0600` in the app support directory and handed to Electron at launch. Keep the Host and Origin checks that `server.ts` already has against DNS rebinding.
- Tokens and AI keys never cross the API. That is the reverse of Velo, which decrypts them into the UI.
- For the phone, pair with a QR code, issue per-device keys, use TLS with a pinned self-signed certificate, and reach the Mac over Tailscale or an end-to-end encrypted relay. Never serve plain HTTP on the LAN.

**Pros.**

- Sync, IDLE, scheduled send and snooze survive the window closing, without Velo's hide-to-tray trick.
- One SQLite writer eliminates the SQLITE_BUSY class of bug.
- The browser preview, Electron and a future phone share one typed contract.
- Headless end-to-end tests can drive the API against fake providers.
- The renderer no longer has to hold privileged bridges for mail actions.

**Cons.**

- A second lifecycle to manage: daemon and UI version skew, updating the daemon from electron-updater, migrations while a client is connected, crash restarts, and login-item approval prompts.
- A local port is an attack surface for other local processes, so token auth isn't optional.
- **A sleeping Mac still runs nothing.** The daemon doesn't replace provider-side filters or a server for "act while I'm away".
- Phone push needs APNs, which means some relay server.
- Debugging spans more processes, so logging has to land first.

**Effort for one developer plus agents.**

| Step | Work | Estimate |
|---|---|---|
| 1 | Normalized schema, paged queries, rollups-from-SQL, persistent change log, typed contract (zod or TS types shared by both sides). Valuable even with no daemon. | 1.5–2.5 weeks |
| 2 | The same contract over a localhost WebSocket plus blob HTTP with a token. `server.ts` already has `POST /api/invoke` plus SSE in 74 lines. Switch the Electron renderer to it. | ~1 week |
| 3 | LaunchAgent lifecycle, single-instance lock, daemon self-update and version handshake, log file and diagnostics. | 1–2 weeks |
| 4 | Phone: pairing, TLS, relay, APNs. | Multi-week; defer |

**Bottom line.** Velo shows that the "service layer in the UI" shortcut gets a feature-rich client out in weeks, then stalls on concurrency, background reliability and correctness bugs that need a long-lived owner to fix. Aplos's separate engine is the asset to build on. Take Velo's relational schema, its command vocabulary, its rule-first AI and its queue compaction, and put them behind a sequence-numbered local API.
