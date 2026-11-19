# Zero (Mail-0/Zero, 0.email): architecture audit for the Aplos revamp

2026-10-25. Read-only review of a shallow clone at `8c170b8` (2026-10-24) in `/Users/knewton/.t3/aplos-research/src/Zero`. Nothing was installed, built or run. Paths are relative to the Zero repo root unless they start with `apps/desktop/` (Aplos). I've marked each claim **[V]** when I checked it in code, docs or a URL, and **[I]** when it's my inference. This report builds on `research/inbox-zero/*` and doesn't repeat it.

---

## 0. The five things that matter most

1. **Google cut Gmail quotas, and that probably explains Aplos's 403s.** [V] Google's quota page (`developers.google.com/workspace/gmail/api/reference/quota`, last updated 2026-10-16) says that since **May 1, 2026**, a project gets **6,000 units per user per minute**. `threads.get` costs **40 units, or 120 with `format=full`**, and `messages.get` costs 20, or 60 with `full`/`raw`. Projects created on or after that date get the new limits. Aplos's first sync makes 500 `threads.get?format=full` calls (`apps/desktop/src/main/google.ts:27,179`). That costs about **60,000 units, ten times the per-user minute budget**. At concurrency 4 the budget runs out within a few seconds. [I] The earlier synthesis estimated "about 5,000 units, well under 15,000/min", and that estimate is now out of date. A first sync with full bodies is no longer possible on a new Google project, however well it's paced. Bodies have to load lazily.
2. **Zero is a cloud service, but its core is the "mailbox daemon" Aplos wants.** [V] Each connected mailbox is one Cloudflare Durable Object (`ZeroDriver`, `apps/server/src/routes/agent/index.ts:365`). Each one has its own SQLite database, persisted alarms, a serial work gate and durable job tables. Thread bodies live in R2, which is blob storage. If you swap "Durable Object" for "per-account actor inside a local engine process" and "R2" for "a blob directory", you get almost exactly the local-server shape Aplos is considering.
3. **Its newest sync design is very good on paper, and very new.** [V] The durable sync design (`apps/server/MAILBOX_SYNC.md`) captures the cursor before the snapshot, pages the snapshot resumably, deletes only after a verify step, keeps a label outbox keyed by (message, label) whose intents clear only when history confirms them, leases AI runs from a table, and shares a quota governor with foreground, sync and backfill lanes. It all landed in two commits titled "stuff" on 2026-10-14 (300 files, +38,946/−9,910 lines) and 2026-10-24. `DEPLOYMENT.md` says no remote migration had been deployed. Treat it as a design to learn from, not a proven one.
4. **Zero has the same security gaps Aplos is trying to close.** [V] Its fixes don't carry over:
   - Gmail OAuth access and refresh tokens are stored **in plaintext** in Postgres (`apps/server/src/db/schema.ts`, `connection.accessToken/refreshToken`). Only IMAP secrets are AES-GCM encrypted.
   - Email HTML is sanitized on the server and then injected into an **open Shadow DOM** in the app's own document (`apps/mail/components/mail/mail-content.tsx:107`). Shadow DOM isolates styles, not scripts.
5. **Ideas worth taking, all simple enough for a local engine** [V]:
   - durable *versioned* job tables for imports, label changes, notifications and AI runs;
   - a quota governor with priority reserves;
   - IMAP IDLE only while the user is present, in short slices;
   - Message-ID-based message keys plus JWZ threading for IMAP;
   - invalidation-only push to the UI.

---

## 1. Overview

| Item | Value |
|---|---|
| Purpose | "Open-source Gmail alternative": an AI-heavy web mail client (0.email) with a hosted backend. The README promises self-hosting (`README.md`). |
| License | **MIT** (`LICENSE`, "Copyright (c) 2025 Zero Email"). The license would allow reuse with attribution, but Aplos's rules say ideas only. |
| Stars / forks | 10,861 / 1,340 (`gh api repos/Mail-0/Zero`, 2026-10-25) |
| Created | 2025-02-02 |
| Commits / contributors | 3,718 commits, 130 contributors including anonymous. Top three: MrgSub (Adam) 1,409 (38%), nizzyabi 603, ahmetskilinc 482. |
| Releases | One tag, `v0.1` (2025-07-18) |
| Activity | Very busy February to August 2025. Almost nothing from August 2025 to May 2026. A May 2026 landing-page change. Then large "stuff" dumps on Oct 12–24, 2026, plus two Devin-bot PRs on Oct 24 (Keiki SMS assistant with Face ID approvals). The weekly commit-activity API shows zeros for most of the past year. |
| Open issues / PRs | 0 open issues (the tracker is enabled), 15 open PRs |
| Target user | Gmail users who want an AI-first web client (auto-drafts, summaries, chat agent, SMS assistant). It's monetized through Autumn plans: the AI "brain" workflow is gated on the `brain-activity` entitlement (`apps/server/src/lib/thread-ai-dispatch.ts`). |

**Maturity verdict [I]:** Zero is a well-known project with a broad feature surface, but it's sporadically maintained and nearly a one-person project (Adam). The newest sync design was clearly written with AI agents: `MAILBOX_SYNC.md` refers to `/var/folders/.../opencode/` log paths and says "changes remain local and uncommitted". The docs drift from the code. The README and AGENT.md say Next.js, but the frontend is React Router 7 in SPA mode (`apps/mail/react-router.config.ts`, `ssr: false`). AGENT.md lists `apps/ios-app` and `packages/db`, and neither exists. The self-host Compose file still uses `NEXT_PUBLIC_*` variables and points the backend at `http://cf-worker.example` (`docker-compose.prod.yaml`). In practice "self-host" means running your own Cloudflare account.

---

## 2. Feature inventory and maturity

| Feature | Evidence | Maturity |
|---|---|---|
| Gmail (REST) read, triage, send | `apps/server/src/lib/driver/google.ts` (1,466 lines) | **Production** for the basics. The durable sync rework is new and wasn't yet deployed (`DEPLOYMENT.md`). |
| Gmail push | Pub/Sub topic and subscription per connection, JWT-verified webhook (`apps/server/src/main.ts:847`, `lib/gmail-push.ts`, `lib/factories/google-subscription.factory.ts`) | Production-ish. Verified through a dev tunnel (`MAILBOX_SYNC.md` §Current local tunnel). |
| Outlook via Graph | `driver/microsoft.ts` exists, but the sign-in provider is commented out (`lib/auth-providers.ts`). The subscription factory is a 19-line stub. No delta queries. | **Disabled / stub** |
| Outlook and Gmail via IMAP XOAUTH2 | `lib/imap/oauth.ts`, `routes/imap-oauth.ts` (PKCE, Redis state) | Experimental, behind the `IMAP_ENABLED` flag |
| Generic IMAP/SMTP (iCloud, Fastmail, Yahoo presets; autodiscovery) | `lib/imap/*`, `lib/smtp/client.ts`, `lib/imap/discovery.ts` | Experimental and flag-gated. Tested against an in-memory IMAP server (`lib/imap/testing/memory-server.ts`). |
| IMAP IDLE push | `routes/agent/index.ts:1648-1765` | New. Runs only while the user is active. |
| JMAP, CalDAV, calendar | none | **Absent** |
| Labels, folders, star, importance, mute | Durable label outbox (`lib/mail-label-store.ts`) | Mature design, new code |
| Snooze | Cloudflare KV `snoozed_emails` plus a one-minute cron sweep (`main.ts:935+`), plus unsnooze-on-read in `trpc/routes/mail.ts` | Works. KV is scanned in full every minute [V], which won't scale [I]. |
| Drafts synced to the provider | `drafts.create/update` against Gmail (`google.ts:847-935`). Short-lived SQLite caches (`lib/mail-draft-store.ts`). | Real provider sync, not local-only |
| Send | Gmail `messages.send` / `drafts.send`; SMTP plus APPEND to Sent for IMAP (`driver/imap.ts` header) | Basic. **No send-later, no undo-send.** |
| Undo for triage | A 5 s toast delays the server call (`apps/mail/hooks/use-optimistic-actions.ts:193`) | Fragile (§3f) |
| Search | Gmail `q` passthrough with a 30 s membership cache (`lib/mail-search-store.ts`). AI search rewrites the query with an LLM first (`routes/agent/index.ts` `searchThreads`). Optional Cloudflare AutoRAG/Vectorize. IMAP: SEARCH translation plus a local label overlay (`lib/imap/search.ts`). | Works. No local full-text index. |
| List-Unsubscribe | Parser handles RFC 2369/8058 (`lib/email-utils.ts:21-60`), but **the UI is commented out** (`apps/mail/components/mail/mail-display.tsx:1653`) | Half-built |
| Unified inbox | `mail.listUnifiedInbox` (`trpc/routes/mail.ts:225`, PR #2087, Sep 2026) | New |
| AI | Chat agent (`ZeroAgent`, AIChatAgent DO), MCP server (`/mcp`, `/sse`), auto-drafts, summaries, auto-labels, writing-style matrix, voice (ElevenLabs), SMS assistant (Twilio/Keiki). All LLM calls go through OpenRouter (`lib/ai-models.ts`). | Broad. Gated behind billing. |
| Contacts | Learned from mail (`lib/mail-contact-store.ts`), Google People API | Basic |
| Native or mobile apps | none (an iOS scaffold PR #2086 was closed) | Absent |

---

## 3. Architecture deep dive

### 3a. Process and deployment topology

[V] Everything runs on Cloudflare (`apps/server/wrangler.jsonc`):

- **Frontend:** a React Router 7 SPA served as Worker static assets (`apps/mail`, deployed with `wrangler deploy`).
- **Backend Worker** (`apps/server/src/main.ts`, Hono):
  - tRPC at `/api/trpc`, Better Auth, MCP endpoints and the Gmail push webhook `/a8n/notify/:providerId`;
  - a **queue consumer** for `thread-queue` (push signals) and `subscribe-queue` (Pub/Sub provisioning);
  - a **cron that runs every minute** (`scheduled()`, `main.ts:935`).
- **Durable Objects:**
  - `ZeroDriver`: one per mailbox, with SQLite. It owns sync, the label outbox, counts, search and draft caches, and the IMAP index.
  - `ZeroAgent`: one per mailbox. It's the AI chat agent and also the **WebSocket fan-out hub** for UI invalidations.
  - `ZeroDB`: one per user. A thin proxy to Postgres through Hyperdrive.
  - `GmailQuota`: **one per OAuth project**, shared by every user.
  - `WorkflowRunner`: AI thread workflows.
  - `ZeroMCP` and `ThinkingMCP`.
- **Storage:** Postgres (users, connections and tokens, settings), **R2** `THREADS_BUCKET` (thread JSON, raw IMAP messages, attachment cache), KV (snoozes and misc), Vectorize (embeddings), Upstash Redis (OAuth state).
- **External services:** OpenRouter, Workers AI, ElevenLabs, Twilio, Resend (onboarding drip emails, `lib/auth.ts:33-90`), Autumn (billing), Dub, PostHog, Sentry (frontend only).

Request path for one tRPC call [V]: browser → Worker. The session cookie is resolved through Better Auth. `getActiveConnection` then reaches Postgres through the `ZeroDB` DO (`lib/server-utils.ts:55`). The call then goes over RPC to the `ZeroDriver` DO, which runs `setupAuth()` on every stub acquisition (`server-utils.ts:34-47`) before the method executes. Realtime updates travel the other way: `ZeroDriver` → `ZeroAgent.broadcastChatMessage` → PartySocket WebSocket → browser.

[I] Topology cost: each user action crosses three to four isolates and a Postgres round trip. The `GmailQuota` singleton serializes every Gmail call across all users through one DO, which is a global hotspot. The minute cron loads **every** connection from Postgres and wakes their DOs four at a time (`main.ts:944-966`). That's linear in the number of accounts and will overrun the minute at a few thousand accounts.

### 3b. Connectivity per provider and token storage

| Provider | Protocol | Auth | Token storage |
|---|---|---|---|
| Gmail | REST through `@googleapis/gmail`, transport wrapped by `GmailQuotaAuth` (`lib/gmail-quota-auth.ts`) | Better Auth social login. Scopes are **`https://mail.google.com/`** plus `gmail.modify` and profile/email (`lib/auth-providers.ts`, `google.ts:76-83`). `prompt=consent` only when `FORCE_GOOGLE_AUTH` is set. | **Plaintext** `access_token`/`refresh_token` columns in both `mail0_account` (Better Auth) and `mail0_connection` (`db/schema.ts`). No Better Auth token encryption is configured. [V] |
| Gmail / Microsoft 365 over IMAP | IMAP and SMTP with SASL XOAUTH2, on a hand-written client over Cloudflare `connect()` sockets (`lib/mail-transport/cloudflare-socket.ts`, `lib/imap/client.ts`) | Authorization code with PKCE, state stored in Redis with a 10-minute TTL (`routes/imap-oauth.ts`). Microsoft scopes `IMAP.AccessAsUser.All` and `SMTP.Send`. | The refresh token is **AES-256-GCM** encrypted with a versioned keyring from `CREDENTIALS_ENCRYPTION_KEYS`, using the connection ID as AAD (`lib/crypto/credentials.ts`). Rotated refresh tokens are persisted through `onSecretRotated` (`driver/types.ts`). [V] |
| Generic IMAP | IMAP and SMTP with passwords (app passwords for iCloud and Fastmail, noted in presets) | Discovery runs presets, then Thunderbird autoconfig/ISPDB, then RFC 6186 SRV over DoH, then a `imap.<domain>` guess (`lib/imap/discovery.ts:1-10`). Port 25 is blocked, and hosts that look private are rejected (`cloudflare-socket.ts`). | Same AES-GCM scheme |
| Outlook via Graph | Graph SDK and `$batch` (`driver/microsoft.ts`) | Disabled | n/a |

Notes [V]:

- `invalid_grant` disconnects an IMAP account and marks it for reconnect (`routes/agent/index.ts` `disconnectImap`).
- For Gmail, `gmailDeliveryFailure` classifies 401 and `invalid_grant` as `reauth_required` and **blocks** queues. It doesn't clear the credentials (`lib/gmail-delivery-failure.ts`).
- The front end signs the user out on "Required scopes missing" (`apps/mail/providers/query-provider.tsx`).
- [I] Zero requests the broadest Gmail scope (`mail.google.com`), so it carries the full restricted-scope verification burden. That's also what lets it use Gmail over IMAP.

### 3c. Sync algorithm

**Gmail (the new durable design)** [V]:

- **Tables** (DO SQLite, `lib/mail-history-store.ts:8-77`): a single-row `mailbox_history` (cursor, requested/processed revision counters, `next_at`, `active_at`, attempts, blocked, error, `snapshot_baseline`, `snapshot_page`); `mailbox_import_jobs(thread_id PK, version, kind ∈ delete|verify|import|backfill, next_at, attempts, blocked)`; plus `mailbox_notifications`, `mailbox_snapshot_threads`, `mailbox_backfill_pause`, `mailbox_history_dispatch` and `mailbox_ai_runs`.
- **Initial and full reconciliation** (`routes/agent/index.ts:729-785`, `mail-history-store.ts:402-438`):
  1. Read `users.getProfile.historyId` **before** listing and store it as `snapshot_baseline`.
  2. Page `threads.list` (`maxResults 500`, **`includeSpamTrash: true`**, `google.ts:160-172`). Each page commits its thread IDs as `backfill` jobs and the next page token in one transaction, so a crash resumes mid-inventory.
  3. When the last page lands (sentinel `__complete__`), cached threads missing from the inventory get **`verify`** jobs. They don't become deletes, because "Gmail pagination is not a transactionally consistent snapshot" (`MAILBOX_SYNC.md` lines 92–101). The baseline then commits as the cursor, and history from that point covers anything that changed during the snapshot.
  4. Body imports don't block advancing the cursor, because the work is already recorded.
- **Incremental sync:** `history.list` follows every page (`google.ts:84-108`). Label deltas update per-message labels **without fetching bodies**; `messagesAdded` enqueues an `import`; deletes tombstone the message and enqueue a refresh or verify. Cursor, deltas and new jobs commit in **one SQLite transaction** (`store.commit`). A push arriving mid-fetch bumps `requested`, forcing a follow-up pass. A 404 (or a 400 mid-snapshot) restarts the snapshot. Per-message checkpoints (`mail_message_checkpoints`) reject deltas older than a newer full snapshot.
- **Polling and push:**
  - Push: a Pub/Sub POST is verified (Google JWKS, issuer, audience, `email_verified`, matching service-account email; `lib/gmail-push.ts`). The webhook returns 503 if it can't admit the message to the queue. The consumer acks only after `signalMailboxHistory()` has durably recorded the signal (`main.ts:905-930`).
  - Polling: about once a minute while active and every 15 minutes when idle, with hash-based start offsets so mailboxes don't all fire together (`onStart`).
  - Watches renew daily, or sooner if expiration is near. Renewal never replaces the cursor.
- **Work loop.** The job loop runs **one import job per tick**. `store.job()` uses `LIMIT 1` (`mail-history-store.ts:296`). `beginTick` enforces a 1 s floor, and the next tick is scheduled at least 1 s out.
  - [V] Observed throughput (`MAILBOX_SYNC.md` §Reliability): 9,852 → 10,737 threads in a 30-minute soak, about 0.5 threads/s, against 45,774 discovered threads. Part of that soak ran under a deliberately tiny 400-unit budget.
  - Priority order is delete > verify > import > backfill. "Live imports and opened threads have priority over historical backfill."
  - Opening a thread that isn't cached yet triggers a foreground-priority import.
- **Quota and rate limits** (`lib/gmail-quota-*.ts`, `routes/gmail-quota.ts`):
  - Every Gmail request (search, drafts, attachments, watch) passes through `budgetGmailRequest`, which reserves units in **one-second buckets over a rolling minute** per project and per mailbox (keyed by the normalized Gmail address). Defaults are 80% of the published 1.2M/project and 6,000/mailbox per minute.
  - **Priority reserves:** foreground may use 100% of the budget, sync 90%, backfill 70%. Concurrency leases per mailbox: foreground 8, sync 6, backfill 4, expiring after two minutes if a worker dies.
  - A denied reservation is **never sent**; it becomes a durable deferral that doesn't count as a failed attempt.
  - Rate-limit errors set mailbox or project cooldowns ("per user"/"concurrent" in Google's message means mailbox). `Retry-After` is a minimum and cooldowns never shorten. SDK retries are disabled, so there's exactly one retry layer.
  - Backoff: rate limits 60 s doubling to 1 h; transient errors 2 s doubling to 60 s; +0–25% jitter. Other 4xx errors **block** the job (`gmail-delivery-failure.ts`).
- **A bug to avoid copying** [V]: `lib/gmail-quota-cost.ts:7,13` charges `threads.get` = 40 and `messages.get` = 20, and it never inspects the `format` query parameter. Zero's `get()` uses `format: 'full'` (`google.ts:505`), which Google now charges at 120, so Zero under-counts its main import call by 3×. [I] This only goes unnoticed because Zero's 2025-era project probably keeps its old quotas. A new project would hit real 429s or 403s.
- **Conflict resolution:** the label outbox (`lib/mail-label-store.ts`) holds one versioned intent per `(message_id, label_id)`; effective state is provider state with pending intents overlaid (`overlayLabels`). After a one-second coalescing window, messages sharing identical add/remove sets go out as `messages.batchModify` calls of at most 1,000 IDs (`pendingBatches`, lines 488-537). An ack marks an intent `delivered` but keeps the overlay until matching history or a fresh snapshot confirms it (`acknowledge`, lines 539-553), which prevents the "UI flips back" race. Acks match by version, so a late response can't clear a newer toggle. Trash and spam additions also record Gmail's implicit INBOX removal.

**IMAP** (`lib/imap/sync.ts`, `lib/imap/imap-store.ts`, `driver/imap.ts`) [V]:

- **Each pass:**
  1. Refresh folders every 15 runs.
  2. `STATUS` each folder to skip the unchanged ones.
  3. `SELECT` with **QRESYNC** when available (with `VANISHED` for expunges), else **CONDSTORE** `CHANGEDSINCE`, else rescan the last 300 UIDs for flag changes and diff with `UID SEARCH` for expunges.
  4. Rebuild a folder on a UIDVALIDITY change.
  5. Backfill newest-first.
- **Default limits:** 90 days, 2,000 messages per system folder, 500 per user folder, a 400-message budget per run, FETCH batches of 100.
- **What each pass fetches:** headers only (`BODY.PEEK[HEADER.FIELDS (...)]`). Full RFC822 is fetched on import and cached in R2 up to 25 MB per message (`driver/imap.ts:478-501`).
- **Identity and threading:**
  - Message keys come from the Message-ID, so a message stays the same thread member across folders and moves.
  - Threads are built **JWZ-style** from In-Reply-To/References, merging when a new message links two threads, with a fallback to the normalized subject within 30 days (`imap-store.ts:1-12`).
  - Folders become labels. Flags map to UNREAD, STARRED and IMPORTANT. IMAP keywords become "tag" labels. Labels the server can't store are kept app-side (`mail_thread_app_labels`).
- **IDLE** (`routes/agent/index.ts:1648-1765`):
  - Starts only when a browser socket is connected or the mailbox was used in the last 15 minutes. Presence comes from `setClientPresence`.
  - Each session lasts 10 minutes and IDLEs in 2-minute slices, rechecking presence between slices.
  - Bursts are debounced 300 ms, then a sync runs.
  - Servers without IDLE are marked unsupported. Failures back off up to 30 minutes, and the minute poll continues meanwhile.
  - [I] This presence-gated IDLE is exactly right for a laptop app.

**AI is kept off the sync path** [V]: committing history writes `mailbox_ai_runs` rows in the same transaction.

- Skipped: sent, draft, spam, trash, promotions and social mail, and any delta adding more than 50 threads (treated as a backfill) (`lib/thread-ai-dispatch.ts`).
- A row becomes ready when its import lands. Up to four rows per mailbox are leased for 10 minutes.
- A row is deleted only when the runner confirms the version it ran. Newer mail bumps the version.
- Retries use backoff (30 s doubling, 30-minute cap, five attempts) and never repeat an auto-draft.
- Backfill and reconciliation **never** create AI runs.

**Offline outbox:** the server-side label outbox above is durable. **The browser has no offline queue** [V]. Undo works by delaying the tRPC call until the 5 s toast closes or is dismissed (`use-optimistic-actions.ts:180-195`). If the tab closes during that window the action is lost [I]. The code also still contains debug `console.log('here', …)` lines.

### 3d. Local storage

| Store | Engine | Contents |
|---|---|---|
| Postgres (`db/schema.ts`, 43 Drizzle SQL migrations) | Postgres via Hyperdrive | `user`, `session`, `account` (plaintext tokens), `connection` (plaintext tokens, scope, expiresAt), `connection_imap` (hosts, ports, encryptedSecret, iv, keyVersion, status, lastError), `summary`, `note`, `user_settings` (JSONB), `user_hotkeys`, `writing_style_matrix`, `email_template`, `assistant_*`, OAuth provider tables |
| Per-mailbox DO SQLite | SQLite (Cloudflare) | `threads(id, thread_id, provider_id, latest_sender, latest_received_on, latest_subject, latest_label_ids JSON, categories, summary_json)` (`routes/agent/index.ts:337-361`); `mail_message_labels(message_id, thread_id, provider_labels JSON)`; `mail_label_intents`; `mail_deleted_messages` and `mail_deleted_threads` (tombstones); `mail_message_checkpoints`; `mail_thread_synthetic_labels` (SNOOZED/MUTE); `mail_thread_app_labels`; history and job tables (§3c); `mail_count_cache`; `mail_search_cache` (30 s TTL, 128 pages); `mail_draft_cache` (5–10 s TTL, 128 entries, skipped above 1 MiB); `mail_known_contacts`; IMAP tables `imap_folders`, `imap_messages`, `imap_locations(folder, uid, key, flags, modseq, size)`, `imap_refs`, `imap_dirty_threads`, `imap_new_mail`, `imap_keyword_labels`, `imap_thread_category` |
| R2 | Object storage | One JSON object per thread holding every message's decoded HTML. **Inline CID images are rewritten into the body as `data:` URIs** (`google.ts:540-563`), which inflates objects [I]. Also raw IMAP RFC822 and an attachment byte cache under `mail-assets/v1/` with a **30-day lifecycle rule**, which is the only eviction there is (`DEPLOYMENT.md` §Cache retention). |
| Browser | IndexedDB via `idb-keyval` | Persisted TanStack Query cache per connection. Throttled to one write per second, at idle. Bodies and attachments are never persisted. The snapshot is trusted for only **1 minute** after reload; queries are kept in memory for 30 minutes (`apps/mail/providers/query-provider.tsx:80-118`). |

- **Full bodies:** yes, for the **whole** mailbox, spam and trash included, kept forever in R2. **Attachments** are fetched on demand and cached for 30 days.
- **Search index:** none locally (no FTS). Gmail does the searching; Vectorize holds embeddings.
- **Encryption at rest:** only the platform's own encryption, plus app-level AES-GCM for IMAP secrets.
- **Migrations:** DO SQLite uses a `@Migratable` decorator for the base tables, plus ad-hoc `CREATE TABLE IF NOT EXISTS`, `PRAGMA table_info` checks and a `mailbox_sync_migrations` marker table inside each store's `initialize()`. [I] That's inconsistent but workable.

[V] The list query paginates by keyset on `latest_received_on` with a strict `<` (`getThreadsFromDB`, `routes/agent/index.ts:3079+`). Label filters use `json_each(latest_label_ids)` with no index, and "complex combinations" silently fall back to filtering by cursor only. [I] Threads that share a timestamp get skipped at page boundaries. Label lists are full scans. Both are weaknesses Aplos should design around: page by `(date, id)`, and keep a label-membership table.

### 3e. API between UI and engine

- **Transport** [V]: tRPC v11 over HTTP using `httpBatchLink` with `maxItems: 1`, so nothing is actually batched. It uses SuperJSON and cookie credentials, and there's an `X-Zero-Redirect` header hack (`query-provider.tsx:160-180`). About 60 procedures exist across `mail`, `drafts`, `labels`, `connections`, `settings`, `imap`, `ai` and others (`apps/server/src/trpc/routes/*`).
- **Shape:** mostly RPC methods (`listThreads`, `get`, `modifyLabels`, `bulkArchive`, `snoozeThreads`, `send`, `syncStatus`, `retryMailboxSync`). Lists return IDs plus a **body-free summary row per thread** in one round trip (`ThreadListSummarySchema`, `trpc/routes/mail.ts` around line 195). That way the list never fetches full threads.
- **Pagination:** an opaque `cursor` string. For local lists it's the `latest_received_on` keyset. For searches it's the Gmail page token.
- **Realtime:** a PartySocket WebSocket to `ZeroAgent` in room `<connectionId>` (`apps/mail/components/party.tsx`). Messages are **invalidation hints only** (`zero_mail_get_thread {threadId}`, `zero_mail_list_threads {folder}`, `zero_mail_count`, `zero_mail_sync_status`). The client invalidates the matching TanStack queries and refetches over tRPC, coalescing mailbox-wide refetches with a 2 s leading-and-trailing throttle (`lib/mail-cache-sync.ts`). Reconnect, focus and visibility trigger a full "catch up"; there's no polling timer. Server-side notifications are durable rows (`mailbox_notifications`) that retry if the broadcast fails.
  - [I] There are no sequence numbers, so a missed hint is repaired only by the reconnect and focus catch-up. Aplos's `{epoch, rev}` diffs are stronger and should be kept.
- **Auth for sockets:** `authorizeAgentRequest` exposes only `zero-agent` and only to the mailbox owner. Its comment admits that without this gate *every* DO binding would be reachable publicly (`lib/agent-socket-auth.ts:8-14`).

### 3f. Send, drafts, threading, labels, calendar, contacts, AI

- **Send** (`trpc/routes/mail.ts:481-548`): synchronous. `messages.send` or `drafts.send` for Gmail; SMTP plus APPEND to Sent for IMAP unless `serverSavesSent`. Forwarded attachments are re-fetched and matched by name and size. Sending fires a writing-style update in the background (`waitUntil`). There's no idempotency key, outbox, send-later or undo-send [V]. [I] A timeout after Gmail accepted the message, followed by a retry, could double-send. Aplos's `findSent` idempotency already beats this.
- **Drafts:** real provider drafts (Gmail `drafts.create/update/send`; IMAP APPEND to Drafts via `buildDraftMime`), cached briefly and invalidated by history, so a draft started on the phone shows up in Zero. This is the feature Aplos lacks.
- **Threading:** Gmail `threadId`; Outlook `conversationId`; JWZ for IMAP (§3c).
- **Labels:** the Gmail model is canonical. IMAP folders map to system labels. Synthetic labels (`SNOOZED`, `MUTE`) never reach Gmail batches (`lib/mail-label-policy.ts`).
- **Calendar:** none. **Contacts:** learned from observed messages, plus the People API.
- **AI:**
  - Everything goes through OpenRouter with default `openai/gpt-4.1` and `gpt-4.1-mini` (`lib/ai-models.ts`). The `@ai-sdk/groq`/`openai`/`anthropic` dependencies remain but aren't the main path.
  - Server-side workflows: auto-draft, summaries, labels and vectors (`thread-workflow-utils/`, `pipelines.ts`).
  - AI search sends **every query to an LLM** to rewrite it into Gmail syntax before searching (`searchThreads`).
  - The SMS/Keiki assistant asks for Face ID approval before write tools run (PR #2089).
  - Prompt-injection posture wasn't audited in depth.

---

## 4. Engineering quality

- **Tests** [V]: 57 test files, about 376 `it`/`test` cases. Server: 45 Vitest files in `apps/server/src/lib/**` plus `tests/email-processor.test.ts`; storage tests run real SQLite transactions through `node:sqlite`, IMAP runs against an in-memory server, and push tests use real JWTs signed with local keys. Frontend: 9 unit test files. Playwright: auth, inbox and a thread-open performance benchmark (`packages/testing/e2e`). One evalite file. The 4,015-line `routes/agent/index.ts` God-object has no tests of its own.
- **CI** [V]: `.github/workflows/ci.yml` runs only **oxlint** through autofix.ci. **Tests, typecheck and Playwright are not run in CI.** Other workflows handle translation sync and a force-push "deploy to prod" rebase command. `MAILBOX_SYNC.md` repeatedly says "full backend typechecking remains blocked by existing repository/dependency errors", although its final section says both typechecks now pass.
- **Organization:** a pnpm and Turbo monorepo. Prettier runs at 100 columns. ESLint, oxlint and React Doctor are wired into `pnpm check`. Effect-TS is used unevenly: some functions are built around Effect and others are plain async. Naming is confusing: `getZeroAgent()` returns the *driver* DO, and `getZeroSocketAgent()` returns the agent (`lib/server-utils.ts`).
- **Observability** [V]:
  - Frontend: Sentry, plus PostHog, plus a thread-open performance timeline (`apps/mail/lib/perf.ts`) that's sampled to PostHog and exposed to E2E as `window.__threadOpenPerf`.
  - Backend: `console.*` plus Cloudflare Workers Logs (`observability.enabled`). `@sentry/cloudflare` is a dependency but is **never initialized** in server code.
  - Sync health is exposed as authenticated endpoints (`mail.syncStatus`, `labelSyncStatus`, `retryMailboxSync`) and as a header strip. The strip distinguishes "discovering", "importing N of M", "paused for Gmail capacity until <time>", "retrying" and "blocked: reconnect".
  - [I] The status model is worth copying even though the backend has no error tracking.

---

## 5. UI notes

- **Stack** [V]: React 19 with the React Compiler (`babel-plugin-react-compiler`, `vite.config.ts:24`) and React Router 7 as an SPA. Also Tailwind 4, shadcn/Radix (`components/ui/*`), Jotai, TanStack Query, `virtua` for list virtualization (`components/mail/mail-list.tsx:43`), TipTap/Novel for compose, `cmdk` for the ⌘K palette, Sonner toasts, `vaul` drawers, `react-resizable-panels`, and Geist fonts.
- **Motion** [V]: `motion` v12 with `<MotionConfig reducedMotion="user">` (`providers/client-providers.tsx:31`). Animations are a user setting that's off by default (`hooks/use-animations.ts`).
  - Thread display: 80 ms with `cubic-bezier(0.4, 0, 0.2, 1)` (`thread-display.tsx:1127-1129`).
  - Composer: a width spring at stiffness 250, damping 35; 0.3–0.4 s enters with 0.15–0.4 s delays; 0.2–0.3 s exits (`email-composer.tsx:1973-2004`).
  - Connection list: 0.3 s fades with a 0.1 s stagger (`components/connection/add.tsx:140-199`).
  - [I] The thread transition is snappy. The composer choreography is slow for a keyboard-first app.
- **Keyboard model** [V]: `react-hotkeys-hook` with scopes (`global`, `navigation`, `mail-list`, `thread-display`, `compose`) defined in `config/shortcuts.ts`.
  - **Navigation:** `j`/`k` and the arrow keys move through the list (`hooks/use-mail-navigation.ts:199-205`). `g`-chords switch folders (`g i`, `g d`, `g t`, `g a`, `g b`).
  - **List triage:** `e` archive, `r`/`u` read and unread, `s` star, `d` delete. `1`–`6` switch category tabs.
  - **Thread:** `r` reply, `a` reply-all, `f` forward.
  - **Global:** `c` compose, `⌘K` palette, `⌘Z` undo, `v` voice.
  - Layout-aware key display covers Dvorak and similar layouts (`utils/keyboard-layout-map`). Custom shortcuts were planned but the sync is commented out (`lib/hotkeys/use-hotkey-utils.ts`).
  - [I] It covers Gmail parity but doesn't go deeper.
- **Email rendering** [V]: the server sanitizes with `sanitize-html` (`allowVulnerableTags: true` so `<style>` survives; `<style>` contents go through a CSS sanitizer that strips `url()` and `@import`). It allows `style` attributes on every element with **no `allowedStyles` filter** (`lib/email-processor.ts:16-60`). It collapses quotes into `<details>` and removes 1×1 pixels. The client then sets `innerHTML` of an **open Shadow Root** (`mail-content.tsx:107-113`). Remote images are blocked unless the sender is trusted.
  - [I] Inline `style="background:url(...)"` survives sanitization, which bypasses image blocking and tracking protection.
  - [I] Shadow DOM shares the app's JavaScript realm, so any sanitizer bypass is full XSS on 0.email. A May 2026 commit is titled "fixes build & XSS".
  - [I] Every message body also costs a server round trip (`processEmailContent` is a mutation).
  - **Aplos should not copy any of this.** The sandboxed opaque-origin iframe it plans to build is the right design.

---

## 6. Lessons for Aplos

### Fix first: the quota arithmetic

- Under the post-May-2026 quotas, the budget for one Gmail account on Aplos's project is about **4,800 units/min** (at 80%).
- Full-body reads (`threads.get` full = 120) give at most **about 40 threads/min**. Metadata `threads.get` (40) gives **about 120 threads/min**. Metadata `messages.get` on the newest message per thread (20) gives **about 240 rows/min**.
- `history.list` costs 2, so polling every 30–60 s costs almost nothing.
- **Consequences** [I]:
  - The first screen should come from `threads.list`/`messages.list` IDs plus metadata for roughly the first 50–100 threads, which is about 1–2k units.
  - Everything else becomes a paced background backfill.
  - Bodies load when a thread is opened, or later in a low-priority lane.
  - Spam and Trash are excluded from the first pass.
- Charge `format=full` at 120 in whatever budget table Aplos builds. Zero gets this wrong.
- For very large Gmail mailboxes, IMAP over XOAUTH2 has no unit quota, only 2,500 MB/day download (Google Workspace bandwidth limits page, [V]). It does require the `https://mail.google.com/` scope [I].

### Adopt (ideas only)

1. **Per-account durable job tables with a version column:**
   - `import_jobs(thread_id, version, kind, next_at, attempts, blocked)`, with priority delete > verify > live import > backfill;
   - acks that match by version, so a newer enqueue survives an older completion.

   This replaces Aplos's all-or-nothing `freshWindow` with checkpointed, resumable work.
2. **Snapshot reconciliation that's honest about Gmail:** capture `historyId` first, persist each listing page and its page token, verify absent threads before deleting them, then commit the baseline and replay history. This also fixes Aplos's ignored `reset:true`.
3. **A label-intent outbox keyed by (message, label) with a delivered-but-unconfirmed state.** Hold the overlay until history confirms it. Batch by identical add/remove sets through `messages.batchModify`, up to 1,000 IDs at 50 units. This is stronger than Aplos's per-thread op queue, and it removes "archive then star" interference.
4. **A quota governor with priority reserves and one retry layer:**
   - foreground 100%, live sync 90%, backfill 70%, plus a small concurrency cap per lane;
   - persisted cooldowns;
   - `Retry-After` as a lower bound;
   - denied requests deferred, never sent;
   - "per user/concurrent" errors handled separately from project errors;
   - `quotaExceeded` (daily) as stop-for-today.
5. **An AI-runs table written in the same transaction as the history commit**, with leases, a backfill guard (deltas over 50 threads, plus skipped categories), and version confirmation. It's the precise cure for Aplos's "summaries inside sync" problem.
6. **IMAP IDLE only while the user is present**, in short slices inside bounded sessions, with minute polling as the safety net. On a Mac, "present" can mean "app foreground or used in the last 15 minutes".
7. **The IMAP sync recipe:**
   - STATUS to skip unchanged folders;
   - QRESYNC, then CONDSTORE, then a UID-diff fallback;
   - a UIDVALIDITY rebuild;
   - newest-first backfill bounded by age, count and a per-run budget;
   - Message-ID-derived keys deduplicated across folders;
   - JWZ threading with a 30-day subject fallback;
   - IMAP keywords as tags, with labels the server can't store kept app-side.

   Aplos's O(n²) `folderMap` and O(known UIDs) expunge detection would both disappear.
8. **Body-free list rows** (`summary_json`) served in one call with the IDs. Bodies come from a blob store when a thread opens. It's the same idea as Aplos's planned "metadata in memory, bodies on demand".
9. **A user-facing sync status vocabulary:** discovering, importing N of M (never rounding to 100%), paused for provider capacity until a stated time, retrying, blocked (reconnect). Add explicit Retry endpoints. This doubles as Aplos's diagnostics panel.
10. **Real provider drafts** with short caches invalidated by history.
11. **Versioned AES-GCM credential keyring with AAD = account ID.** Aplos's vault already seals each entry with AES-GCM. The useful extras are a key version on every record, so keys can rotate, and AAD binding, so sealed rows can't be swapped between accounts.
12. **Autodiscovery order:** presets (iCloud, Fastmail, Yahoo, with app-password help links), then autoconfig/ISPDB, then SRV, then a guess.

### Avoid

- Plaintext OAuth tokens, and copies of them in two tables.
- Shadow DOM or any same-realm email rendering; unfiltered inline `style` attributes; a server round trip to sanitize every message.
- Undo implemented as a client-side delay with no durable queue.
- One import per tick with a 1 s floor. For a single local user, Aplos can drain jobs in small batches inside the quota budget.
- Full-mailbox backfill that includes spam and trash, with `format=full`, kept forever with no eviction.
- Rewriting every search query with an LLM. It sends private queries to a third party and adds latency.
- A 4,000-line God-object actor, and a CI pipeline that runs only a linter.
- Keyset pagination on a timestamp alone, and label filters over JSON columns.

---

## 7. "Local server" translation: Zero's design as an Aplos daemon on the Mac

### Mapping

| Zero (cloud) | Aplos local equivalent |
|---|---|
| `ZeroDriver` DO per mailbox (SQLite, alarms, serial gate) | A **mailbox actor per account** inside the engine. It keeps its own job, outbox, history and AI-run tables in `aplos.db`, keyed by `account_id` (or one SQLite file per account). It uses a promise-chain work gate like `withMailboxWork` and a `schedules(account_id, callback, due_at)` table driven by one timer. |
| R2 thread JSON and attachment cache with 30-day expiry | A blob directory under `~/Library/Application Support/Aplos/blobs/<account>/` (content-hashed). Messages are stored as raw MIME or sanitized HTML, with an **LRU cap** (for example 2–5 GB), not "forever". SQLite keeps metadata and FTS5 over extracted text. |
| `GmailQuota` DO (global) | An in-process token bucket per account with the same lanes. Cooldowns persist to SQLite so a restart can't burst. A project-wide cap isn't needed, because each user is alone on their own machine. |
| Pub/Sub, Queues, webhook | **Not needed locally.** Gmail: `history.list` every 30–60 s while active and every 5–15 min when idle (2 units per poll). IMAP: presence-gated IDLE. JMAP: EventSource. Graph: delta polling. Push that needs a public URL (Gmail watch, Graph subscriptions) should wait for an optional relay. |
| PartySocket invalidation hints | A localhost **WebSocket or SSE** stream. Keep Aplos's `{epoch, rev}` change log: clients resume from the last rev and resnapshot on a gap. That's better than Zero's hint-plus-focus catch-up. |
| tRPC over HTTP | One **typed contract** (zod or TypeBox schemas in `packages/`). It's served over Electron IPC for the desktop window (no TCP) *and* over HTTP for browser-preview and phone clients. A JMAP-shaped API is worth considering: `/session`, `Email/query`, `Email/get`, `Email/set`, `Thread/get`, `*/changes` with state strings. JMAP's model already encodes "state token, changes since state, invalidate". [I] |
| Better Auth sessions | Device pairing: the Mac shows a QR code holding a one-time code and the TLS certificate fingerprint. The phone stores a per-device bearer token, revocable in Settings. Aplos's existing Host/Origin checks stay. Bind to 127.0.0.1 by default, and to the LAN only after the user opts in and pairs. |
| Postgres user, connection and settings tables | Already local: `accounts` plus the encrypted vault |

### Two deployment options

- **A. The engine stays an Electron `utilityProcess` and grows a local API.**
  - This is the smallest step. The local server lives only while Aplos runs: a menu-bar or login item can keep it running with no window open.
  - Keychain access and `safeStorage` keep working, and the RunAsNode fuse can still be disabled.
  - **Effort** [I]: 1–2 weeks after the typed-contract work. Most of it is the auth and pairing layer and the HTTP/WS adapter around the existing invoke methods.
- **B. A separate launchd LaunchAgent daemon**, a signed standalone binary (Node SEA or Bun compile) that starts at login.
  - It can sync while the UI is closed, which is the nearest local analogue to Zero's always-on server.
  - Cost: Electron's `safeStorage` isn't available to it, so it needs a native Keychain binding with its own entitlements and access group. It's a second binary to sign, notarize and auto-update, and it needs version skew handling between the daemon and the UI.
  - Don't get there with `ELECTRON_RUN_AS_NODE`. The security plan wants that fuse off.
  - **Effort** [I]: 3–5 weeks, and ongoing release overhead.

### Pros [I]

- One sync owner for every client, so the phone gets the same rows without its own Gmail quota or OAuth.
- The design naturally forces the durable job model above, which fixes the 403 and resume problems anyway.
- The browser-preview server already exists (`apps/desktop/src/main/server.ts`), so the transport is half-built.
- Deterministic local rules, snooze and send-later could fire while the window is closed under option B.

### Cons and risks [I]

- A Mac asleep is a server down. The phone can't reach it unless the Mac is awake on the LAN or there's a relay (Tailscale, or an end-to-end encrypted relay).
- A local API that can read and send mail becomes the most attractive target on the machine. Per-device tokens, TLS on the LAN and capability scoping (for example, read-only phone tokens) are mandatory.
- Google sees one OAuth client. Phone-originated sends still go through the Mac's tokens, which is good for scopes and fragile for availability.

### Recommended sequencing [I]

1. Fix the Gmail first sync with job tables and the quota governor, metadata first and bodies lazy.
2. Move AI onto the AI-runs table.
3. Define the typed contract and the change-log stream, and serve it over IPC.
4. Expose the same contract on localhost with pairing (option A).
5. Revisit option B only if users ask for background sync with the window closed.

Zero shows that the per-mailbox actor design works. It also shows that the hard parts are durability, quota accounting and honest status reporting, not the transport.
