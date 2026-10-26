# Redakt (stylessh/redakt): architecture audit for the Aplos revamp

2026-10-25. The source is a full clone at `/Users/knewton/.t3/aplos-research/src/redakt` (HEAD `92d310c`, 2026-09-28). I read files only. Nothing was installed, built or run. Paths below are relative to that clone unless they start with `aplos:`, which means the Aplos repo. Each finding is labeled **[V]** if I verified it in code, docs or on a live page, or **[I]** if it is my inference.

---

## 1. Overview

**What it is.** Redakt calls itself a "design-first, open-source mail client and provider" (`README.md`). It does two things:

1. **Hosted mail on your own domain.** Onboarding creates a domain and a mailbox in a Stalwart mail server, shows the DNS records to add, and checks them over DNS-over-HTTPS (`packages/core/src/stalwart/provider.ts`, `packages/core/src/dns/doh.ts`).
2. **A Gmail client.** It reads Gmail through the Gmail REST API, and Gmail stays the source of truth (`docs/gmail.md`).

It is a **server-hosted web app**, not a local client. It is built on TanStack Start (React 19 with SSR) and Postgres, with a background worker using Hono and pg-boss. A thin native iOS client consumes the same `/api` routes. Production runs at `https://redakt.app` (live, `/api/health` returned `{"status":"ok"}` today [V]). Railway hosts the web app and worker, and an OVH VPS runs Stalwart (`.trylle/README.md`, `docs/self-hosting.md`).

**License.** MIT (`LICENSE`, "Copyright (c) 2026 Alan Daniel and Redakt contributors") [V]. The Trylle API reports `license: null` because it doesn't parse the file, but the file is plain MIT. Stalwart itself is AGPL, and Redakt only talks to it over the network (README "License"). MIT allows reuse, but per the research rules this report describes ideas only and copies no code.

**Maturity and activity** [V]:
- The forge is Trylle, not GitHub, so `gh api` doesn't apply. The repo page shows **11 stars, 4 forks, 1 watcher**, scraped from `https://trylle.com/stylessh/redakt`.
- After unshallowing: **68 commits on `main`** from 2026-08-31 to 2026-09-28, and **43 remote branches**.
- One human author, Alan Daniel (`stylessh`), wrote 58 commits. "Claude" wrote 10. Branch heads also show "Cursor Agent" and "Trylle magic-session" agent branches. This is effectively a one-developer, AI-assisted project, like Aplos.
- Commits are large squashes. The last one ("Trigger CI for the pull request", 425 files, +16.5k lines) added the whole iOS app.
- **No commits on any branch since 2026-09-28**, about four weeks idle.
- Version is `0.1.0` (`package.json`), and the README says "The project is early."

**Size** [V], counting TS, TSX, MJS and Swift and excluding generated files and migrations:

| Part | Lines |
|---|---|
| `apps/web` | ~25.4k |
| `packages/core` | ~21.9k (about 5k of it demo catalogs) |
| `apps/worker` | ~1.7k |
| `apps/ios` | ~9.7k Swift |
| Tests | 61 `*.test.mjs` files, ~5k lines |

**Target user.** People who want a calm, well-designed inbox on a custom domain without running mail themselves, plus Gmail users who want a nicer client. Redakt runs the servers. The README's "Self-hosting" section points technical users to Coolify on a mail-friendly VPS.

**Why it matters to Aplos.** Redakt is a working example of the "server" half of the question the owner is asking. It puts a provider-neutral mail contract behind one HTTP API that serves both a web UI and a native phone app. It has push ingestion, a durable job queue and a quota-aware Gmail gate. Its own design doc (`docs/plans/gmail-cache.md`) explains why its first Gmail approach, a stateless proxy with no local store, ran into Google's quota. That is close to the problem Aplos hit from the opposite direction.

---

## 2. Feature inventory

Maturity scale: **Shipped** means it is wired end to end and has tests or production evidence. **Partial** means it works with notable gaps. **Absent** means it isn't there.

| Feature | Maturity | Evidence / notes |
|---|---|---|
| Custom-domain hosted mailbox (Stalwart) | Shipped | Admin JMAP `x:Domain/set` and `x:Account/set` in `stalwart/client.ts`. DNS wizard and DoH verification in `dns/*.ts`. One mailbox per user (`data/accounts.ts`, `mailboxes` table keyed by user). |
| Gmail read, labels, archive, spam, trash, star, unread | Shipped | `gmail/provider.ts`, with capability list in `mail/connectors.ts` |
| Gmail drafts synced to Gmail | Shipped | `saveDraft` uses Gmail `drafts.create`/`update`. The composer autosaves after a 900 ms pause through a serialized save chain (`apps/web/components/shell/standalone-composer.tsx` ~L406-442). |
| Hosted (Stalwart) drafts | Absent | `saveDraft` throws "Drafts are not available for this account yet" (`stalwart/provider.ts` ~L597) |
| Send, reply threading, attachments | Shipped | Gmail: hand-built MIME (`gmail/mime.ts`). Stalwart: JMAP `Email/set` plus `EmailSubmission/set`. |
| Undo send (30 s) | Partial | In-browser timer only (`mail/use-pending-send.ts`, `UNDO_WINDOW_MS`). On `pagehide` it flushes with `sendBeacon`. Nothing durable. |
| Push for Gmail (Pub/Sub) | Shipped | `apps/web/src/routes/api/mail/sync/google-pubsub.ts` verifies the OIDC JWT. Watch renewal runs as a worker job and a cron route. |
| Push or delta sync for hosted (JMAP state, EventSource) | Absent | No `Email/changes`, `state` or EventSource anywhere. The client poll skips hosted accounts (`apps/web/components/shell/app-shell.tsx` ~L719-720). |
| Search | Partial | Passes through to Gmail `q` or JMAP `text` filter. No local index. |
| Multiple accounts (one hosted plus N Gmail); workspace tabs | Shipped | `mail/accounts.ts`, `mail_accounts` table, `mail/workspace-tabs.ts` |
| Focus (AI triage into 5 categories) | Shipped | `intelligence/ingest.ts`, `ai/focus.ts`. Worker-driven, with stored snapshot. |
| Smart Compose (inline completion, tone rewrite) | Shipped | `ai/compose.ts`, `components/mail/smart-compose.tsx` |
| Prepared replies (draft before you open) | Shipped | `apps/worker/src/jobs/reply-draft.ts`, `intelligence/reply-policy.ts`, `prepared_replies` table |
| Reply-outcome feedback and per-sender suppression | Shipped | `intelligence/reply-feedback.ts`, `reply_outcomes` table |
| Follow-up nudge ("no reply for N days") | Partial | `intelligence/follow-up.ts`, derived only inside Focus |
| Rules, filters, snooze, send later, List-Unsubscribe | Absent | No matches anywhere for unsubscribe, snooze or rule engines |
| IMAP, Outlook/Graph, iCloud, Fastmail as external accounts | Absent | Only two connector IDs exist, `"hosted"` and `"gmail"` (`mail/types.ts`) |
| Calendar and contacts | Absent | Recipient suggestions come from recent mail only (`mail/recipients.ts`) |
| Native iOS client | Partial | Read-only v1: folders, list, reader, swipe actions. Search, compose and Focus are placeholders (`apps/ios/README.md`, "Scope"). |
| Demo mode; data deletion and retention | Shipped | `packages/core/src/demo/*`, `account-deletion.ts`, `apps/worker/src/jobs/maintenance.ts` |

---

## 3. Architecture deep dive

### 3a. Process and deployment topology

[V] from `README.md`, `.railway/railway.ts`, `docs/plans/focus-background-worker.md` and `docs/self-hosting.md`:

```
 Browser (React, TanStack Router/Query) ─┐
 iOS app (SwiftUI, URLSession+cookies) ──┼─HTTPS─▶ apps/web  (TanStack Start SSR + /api routes, Node)
                                         │            │  getMailProvider(user, accountId)
 Google Pub/Sub push (OIDC JWT) ─────────┘            ├──▶ Gmail REST API (per-request access token)
 Cloud Scheduler (bearer secret) ──▶ /api/mail/sync/renew
                                                      ├──▶ Stalwart JMAP (Basic auth: user mailbox / admin)
                                                      ├──▶ Postgres (Drizzle)  ◀── pg-boss schema
                                                      └──POST /v1/jobs/:name (bearer, 3 s timeout)──▶ apps/worker (Hono + pg-boss)
                                                                                                        ├─▶ Gmail / Stalwart (same provider factory)
                                                                                                        └─▶ Vercel AI Gateway
 Stalwart (Docker on OVH VPS): SMTP 25/465, IMAPS 993, JMAP 8080; RocksDB storage
```

- **No local daemon. The server is the engine.** Redakt has no on-device engine. Web and iOS are thin clients, and all provider I/O happens on the server. The iOS app holds an in-memory list and detail cache only (`apps/ios/Redakt/App/MailStore.swift`).
- **The web app and the worker share one library**, `packages/core`, imported as `@redakt/core/*`. Server-only modules start with `import "server-only"`, so they can't leak into the client bundle (for example `gmail/client.ts`, `mail/provider-factory.ts`). The provider factory was refactored specifically so that route handlers and background jobs use the same code (`mail/provider-factory.ts`, doc comment on `getMailProvider`).
- **The worker is its own service** with `/healthz`, `/readyz` and a bearer-authenticated `POST /v1/jobs/:name` (`apps/worker/src/app.ts`). The web app's enqueue never throws and times out after 3 s; scheduled sweeps catch missed enqueues (`packages/core/src/jobs/worker-client.ts`).

### 3b. Connectivity per provider

**Gmail** [V]
- **Protocol.** Gmail REST v1 through a small hand-written `fetch` client (`gmail/client.ts`, `google/api.ts`). It does not use `googleapis` or IMAP.
- **Auth.** Better Auth runs a server-side authorization-code flow (`auth-core.ts`, `google/oauth.ts`). Sign-in asks only for `openid email profile` with `access_type=online`. Connecting Gmail is a separate incremental grant: `gmail.modify` with `access_type=offline`, `include_granted_scopes=true` and `prompt=select_account consent`. A narrow sign-in must never overwrite the Gmail-enabled token (`updateAccountOnSignIn: false` in `auth-core.ts`).
- **Scope verification.** Only Google account rows whose stored `scope` string contains `gmail.modify` count as mailboxes (`hasScope` in `data/mail-accounts.ts`). Aplos doesn't do this check today (SYNTHESIS weakness 5).
- **Token storage.** Tokens live in Postgres in the `account` table with Better Auth's `encryptOAuthTokens: true`. `docs/gmail.md` says this is XChaCha20-Poly1305 with a versioned keyring (`BETTER_AUTH_SECRETS`). The ID token is deleted after enrollment (`clearOAuthIdentityToken`).
- **Disconnect** stops the watch, revokes the grant and clears tokens and derived data (`google/mail-accounts.ts`).
- **Refresh failure handling.** Better Auth reports a revoked grant and a temporary failure the same way. Redakt retries once. It marks the account `reauthorize` only on an interactive request and never from a background job, because the user can reconnect immediately (`provider-factory.ts`, the `markReauthorization` option). A 403 means "reconnect" only for `insufficientPermissions`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT` or `authError`, and a 401 always does (`gmail/sync-core.ts`). This was the fix for a "Reconnect needed" loop caused by quota 403s (`docs/plans/gmail-cache.md`, "Why").
- **Google Cloud setup** (separate projects per tier, restricted-scope verification, CASA) is documented step by step in `docs/gmail.md`.

**Hosted / Stalwart** [V]
- **Protocol.** JMAP over HTTP: Core, Mail and Submission (`stalwart/client.ts`). Provisioning uses Stalwart's proprietary management methods (`x:Domain/*`, `x:Account/*`, `x:DkimSignature/*`, using `urn:stalwart:jmap`) against `/api`.
- **Auth.** HTTP Basic with the admin credentials from the environment for provisioning. For mail access it uses the user's own mailbox credentials. The **mailbox password is stored reversibly** in Postgres (`mailboxes.secret`), encrypted with AES-256-GCM and a versioned keyring (`REDAKT_ENCRYPTION_KEYS`, `crypto/secret.ts`). When the key version is stale it is re-encrypted lazily on read (`getMailboxSecret` in `data/accounts.ts`).
- **Plaintext fallback.** `decryptSecret` returns the stored value unchanged when it doesn't match either encrypted format (`crypto/secret.ts`, final `return payload`). That is a silent plaintext fallback.
- **JMAP usage done well.** It uses result back-references (`#ids` with `resultOf`) to do query plus get in one round trip, `collapseThreads`, anchor paging, `calculateTotal`, and `onSuccessUpdateEmail` to move a sent message out of Drafts atomically.
- **JMAP features not used.** `state`, `/changes`, `/queryChanges`, push (`eventSourceUrl`) and WebSocket. The session object is cached per client instance only.

No other providers exist [V].

### 3c. Sync algorithm

Redakt mostly **doesn't sync mail**. It proxies reads to the provider, and "sync" means detecting that something changed.

**Initial sync** [V]
- None. On Gmail connect it stores `users.getProfile().historyId` as the cursor, then calls `users.watch` (`google/mail-accounts.ts`, `api/mail/accounts/google/complete.ts`).
- Folder pages are fetched on demand, one page at a time. Each page is one `threads.list`, then up to 20 `threads.get?format=metadata` calls, then a second `threads.list` with `maxResults=1` to estimate unread (`gmail/provider.ts` `listThreads`).
- Their own doc puts a cold folder page at about 220 quota units (`docs/plans/gmail-cache.md`).

**Incremental sync, Gmail** [V]
- `readGmailHistory` pages `history.list` from the stored cursor.
- It only records **whether** any history exists, and advances the cursor to the response's `historyId`.
- A 404 or 410 (cursor too old) resets the cursor to the current profile `historyId` and reports "changed". That is safe here because there is no local state to repair (`gmail/sync-core.ts`).
- A change bumps `mail_accounts.sync_revision` atomically (`sync_revision + 1` in SQL, `data/mail-accounts.ts`) and clears the in-process list cache.

**Incremental sync, Stalwart.** None [V].

**Push** [V]
- Gmail `users.watch` publishes to a Pub/Sub topic. The push subscription calls `/api/mail/sync/google-pubsub`.
- The route checks the Google OIDC JWT's signature, issuer and audience, the exact service-account email, and `email_verified` before it does anything.
- It then bumps the revision for every Redakt account with that address, clears the cache, and enqueues `mail.ingest` with a 30 s delay. The queue's "stately" singleton key turns a burst into one job.
- **Watch renewal.** The sync path renews when expiry is under 24 h away (`gmail/sync.ts`). A daily Cloud Scheduler call to `/api/mail/sync/renew` (bearer secret, constant-time compare in `crypto/tokens.ts`) and a worker `gmail.watch-sweep` every 6 h renew anything within 36 h (`apps/worker/src/jobs/gmail-watch.ts`).
- After a failed `watch` call, which costs 100 units, it waits 15 min before trying again.

**Client polling** [V]. A visible tab POSTs `/api/mail/accounts/:id/sync` 5 s after mount, every 30 s, and on becoming visible (`app-shell.tsx` ~L719-751). A higher revision triggers `router.refresh()`, re-running every loader: coarse invalidation with no deltas. The poll is the fallback for dropped Pub/Sub messages (`docs/gmail.md`).

**Rate limits and retries** [V], in `gmail/request-gate.ts`
- One `RequestGate` per mailbox **per process**: concurrency 6, total wait budget 8 s, 2 retries, exponential backoff from 1 s capped at 4 s. It honors `Retry-After`.
- On a rate limit it **pauses the whole mailbox** instead of letting parallel calls keep hitting the limit. If the wait would run past 8 s it fails fast with a user-facing "Gmail is busy" error.
- Errors are classified by the reason in Google's error body (`google/api.ts` collects `errors[].reason` and `details[].reason`), not by HTTP status alone.
- **Same bug as Aplos:** `quotaExceeded` is in the rate-limit set, so a daily-quota failure gets short retries (SYNTHESIS "New findings").

**Caching** [V] (`gmail/client.ts`, `response-cache.ts`)
- An in-process LRU: lists 20 s, labels 30 s, attachments 1 h (64 MB cap). Threads are **versioned by `historyId`** from `threads.list`, so an unchanged thread is never fetched again. Writes clear the cache before and after the request, so a racing read can't re-cache stale data.
- The authors list its limits: per process, cold after deploy, push clears one replica only, no quota accounting (`docs/plans/gmail-cache.md`).

**Background jobs** [V] (`apps/worker/src/queue.ts`, `jobs/job.ts`). Each job declares a zod schema, a pg-boss policy with an optional singleton key, retries with backoff, a timeout, concurrency and an optional cron. `PermanentJobError` skips retries, exhausted jobs go to a 30-day `dead-letter` queue, and SIGTERM drains for 45 s.

**Checkpointing and resume.** Not applicable, since there is no backfill. The proposed mirror design adds `backfill_cursor` and `full_sync_completed_at` (`docs/plans/gmail-cache.md`, "Storage").

**Conflict resolution.** The provider always wins. Writes go straight to Gmail or JMAP with no local optimistic store beyond component state, then the client invalidates (`invalidateMailAccount`, `components/routing/start-navigation-provider.tsx`).

**Offline outbox.** None. Undo send is a timer in browser memory, flushed with `sendBeacon` on `pagehide`. Closing the tab sends the message immediately, and a browser crash loses it (`mail/use-pending-send.ts` ~L211-270).

**A latent bug to learn from** [I, from code reading]
- `ensureGmailSubscription` writes the cursor from `watch().historyId` (`gmail/sync.ts`).
- When renewal runs from the worker or cron instead of right after a sync, this jumps the cursor forward without ever reading the history in between, and without bumping the revision.
- Today the only cost is a missed UI refresh. Once the planned local mirror exists, it becomes **silent data loss**: changes in that gap are never applied.
- Rule: only the sync loop may advance a cursor.

### 3d. Local storage

**Engine.** Server-side Postgres through Drizzle ORM (`packages/core/src/db/schema.ts`). Migrations are SQL generated by drizzle-kit (16 files in `db/migrations/`) and applied by `packages/core/scripts/migrate.mjs` as Railway's pre-deploy step. pg-boss keeps its own `pgboss` schema [V].

**Tables** [V]:

| Table | Main columns | Notes |
|---|---|---|
| `user`, `session`, `account`, `verification` | Better Auth standard. `account` holds `access_token`, `refresh_token`, `id_token`, expiries and `scope`. | Tokens encrypted by Better Auth |
| `mail_accounts` | `id, user_id, connector, external_account_id, auth_account_id, email, display_name, image, status (connected/reauthorize), sync_cursor, subscription_expires_at, last_synced_at, sync_revision, last_error` | The entire "sync state" lives here. Unique per (user, connector, external id). |
| `mailboxes` | `user_id, email, secret (encrypted), stalwart_account_id` | Hosted credentials |
| `domains`, `dns_checks` | Name, status, Stalwart id, `zone_cache` (JSON text), `ok_count` | DNS wizard |
| `user_preferences` | Theme, density, `load_remote_images` (**default true**), `single_key_shortcuts`, `message_preview`, `last_mail_account_id` | |
| `ai_settings` | Feature toggles, `consent_version`, `consented_at`, interactive rate-limit counters, daily background counters. Unused `provider/model/encrypted_api_key`. | Migration `0010_purge-ai-provider-keys.sql` cleared bring-your-own keys when they moved to a managed gateway. |
| `focus_snapshots` | `(user, account) → items (encrypted), analyzed_at` | Last Focus result |
| `thread_insights` | `(user, account, thread) → fingerprint, category, confidence, reply_probability, sender_email, analyzed_at, last_seen_at` | Labels and scores only, no content |
| `prepared_replies` | `(user, account, thread) → fingerprint, sender, suggestion (encrypted), status, expires_at` | 7-day lifetime |
| `reply_outcomes` | `sender_email, outcome, similarity, created_at` | 180-day retention |
| `mail_collection_appearances` | Per-user icon and color for labels and folders | |

**Message bodies and attachments.** Not stored, by design. `docs/gmail.md` says Redakt "does not persist Gmail message bodies or attachments", and responses are `private, no-store`. That decision is tied to Google's restricted-scope review. Hosted mail lives only in Stalwart's RocksDB.

**Search index.** None local.

**Encryption at rest.** Application-level AES-256-GCM with a versioned keyring for the mailbox secret, Focus snapshots and prepared replies. Better Auth encrypts the OAuth tokens. Disk-level encryption of Postgres isn't covered.

**Eviction and retention.** A daily `maintenance.cleanup` job (03:41 UTC) removes expired prepared replies (recording them as `ignored`), insights not seen in 30 days, and outcomes older than 180 days. Turning a feature off deletes its stored output.

**Write fencing.** `writeWhileFeatureOn` in `data/feature-guard.ts` takes a share lock on the settings and account rows. AI output written by a slow job therefore can't outlive the user switching the feature off or deleting the account [V].

### 3e. API between UI and engine

[V] from `apps/web/src/routes/api/**`, `apps/web/src/server/*.functions.ts` and `apps/ios/Packages/RedaktKit/Sources/RedaktKit/APIClient.swift`.

**Two transports for one engine**

1. **The web app** reads through TanStack Start server functions (RPC called from route loaders, `mail.functions.ts`), cached in TanStack Query (staleTime 30 s, gcTime 30 min, `src/router.tsx`). It **mutates** through plain REST routes:
   - `PATCH /api/mail/threads/:id` with a body of `{unread}` or `{action: archive|star|move|collection, ...}`
   - `POST /api/mail/send` (multipart FormData)
   - `POST`/`DELETE /api/mail/drafts`
2. **The iOS app** uses only JSON REST: `/api/me`, `/api/mail/shell`, `/api/mail/threads`, `/api/mail/threads/:id` (GET and PATCH), and `/api/mail/attachments/:id`. It authenticates with **the same Better Auth session cookies** as the browser, stored in the shared cookie jar (`APIClient.swift` doc comment).

**Shell endpoint.** `GET /api/mail/shell?account=` returns the user, all accounts, the selected account, its folder counts and its collections in one call. Its comment says it was added so a native client can draw its frame in one round trip.

**Resource shapes.** All come from one provider-neutral type file, `mail/types.ts`: `MailAccount` with `capabilities[]` and `syncRevision`, `Thread`, `ThreadDetail`, `ThreadListPage` (`threads, total, unread, hasMore, nextCursor`), `ComposeInput` and `SendResult`. The iOS `Models.swift` mirrors these by hand, with no generated contract.

**Capabilities.** Each connector advertises a capability list (`read, send, drafts, markUnread, star, archive, spam, trash, attachments, collections, sort, pushSync`), and the UI hides actions the connector can't do (`mail/connectors.ts`, `hasMailCapability`).

**Pagination.** Cursor first: Gmail `pageToken`, or the JMAP anchor (the last id) with `anchorOffset 1`. Offset is a legacy fallback. Limit is clamped to 1-50, default 20 (`mail/list-query.ts`, `gmail/provider.ts`). Gmail totals are `resultSizeEstimate`, which is approximate.

**Realtime propagation.** Polling only. Clients compare `syncRevision` and refetch everything when it increases. There is no SSE or WebSocket. The cache plan names SSE/WebSocket as a later step.

**Other.** Gmail attachment ids are self-describing (encoded message id, attachment id, MIME type and filename in `gmail/normalize.ts`), so downloads need no lookup table.

### 3f. Send, drafts, threading, labels, calendar, AI

**Gmail send** [V]
- MIME is built in-house (`gmail/mime.ts`): headers sanitized against CR/LF, RFC 2047 encoding for non-ASCII headers, multipart/alternative and mixed, `8bit` transfer encoding. There is no line wrapping at 998 characters and no RFC 2231 encoding for filenames [I: risky for long HTML lines and non-ASCII attachment names].
- Replies fetch the original's `Message-ID` and `References` (`messages.get` metadata) to set `In-Reply-To`, `References` and `threadId`.
- If a Gmail draft exists, send becomes `drafts.update` then `drafts.send`, so the draft and the sent message stay one object.

**Stalwart send** [V]
1. Upload attachment blobs.
2. Create the email in Drafts with the `$draft` keyword.
3. `EmailSubmission/set` with `onSuccessUpdateEmail`: remove from Drafts, add to Sent, set `$seen`, clear `$draft`.
4. Auto-create an identity if none exists.

The lookup after submission is wrapped so that a failure after delivery can't produce an error that tempts the user to resend (comment in `stalwart/provider.ts` ~L631).

**Drafts.** Gmail drafts autosave with a debounce, a fingerprint that skips identical saves, and a promise chain so saves never run concurrently. Every save re-uploads all attachments as a full raw MIME `drafts.update` [V]. That costs quota and bandwidth for large attachments [I].

**Threading.** Provider-native: Gmail `threadId`, JMAP `threadId` with `collapseThreads`. The hosted list always reports `messageCount: 1` (`toThread` in `stalwart/provider.ts`), so hosted thread sizes are wrong in the list [V].

**Labels and folders.** One "collection" model with `kind: folder | label`. Gmail user labels and non-role JMAP mailboxes are both collections. Moving into a folder-kind collection is modeled as a transfer between views (`mail/collections.ts`). Per-user icons and colors live in Postgres.

**Calendar and contacts.** Absent.

**AI** [V]
- **Gateway.** Calls go through Vercel AI Gateway with the `ai` SDK (`ai/provider.ts`). Focus uses an "evaluation" model (`FOCUS_EVALUATION_MODEL`) that answers multiple-choice, score and boolean questions. Smart Compose uses a small Gemini Flash Lite model. Every call has a 45 s timeout and is tagged by feature, phase and user for cost attribution.
- **Two-pass classification.** The first pass sees only subjects, participants, dates and previews of at most 20 inbox threads. Only low-confidence results get a second pass with bounded thread text: 4,500 characters and the last 5 messages (`intelligence/focus.ts`, `prompt-context.ts`).
- **Opaque prompt IDs.** Thread IDs are replaced with `t1…tN` tokens in prompts, so the model never sees or invents provider IDs.
- **Heuristics before AI.** An automated-sender pattern (no-reply, notifications, billing and so on) forces reply probability to 0 without an AI call (`intelligence/signals.ts`).
- **Fingerprint cache.** A thread is reclassified only when a hash of id, last date and message count changes, or the insight is more than a day old (`intelligence/fingerprint.ts`).
- **Budgets and consent.** A daily background budget of 60 classifications and 30 drafts per user (`ai/background-budget.ts`) plus interactive limits. Raising `AI_CONSENT_VERSION` (now 4) turns every AI feature off until the user agrees again (`ai/settings.ts`).
- **Safety boundary.** AI never sends mail or changes the mailbox. Prepared replies are suggestions held in Redakt, not provider drafts.

---

## 4. Engineering quality

**Tests** [V]
- 61 `node:test` files run with `--experimental-strip-types` (no Jest or Vitest), in `packages/core/src/**` and `apps/worker/src/*.test.mjs`.
- **Pure decision logic is split from I/O** so it can be tested: `gmail/sync-core.ts` and `gmail/provider-core.ts` are server-independent, while `gmail/sync.ts` and `gmail/provider.ts` do the I/O.
- The gate tests cover concurrency caps, backoff, `Retry-After`, giving up at the wait limit, and handing a freed slot to a live waiter (`gmail/request-gate.test.mjs`).
- The Stalwart client has a 462-line test with a fake fetch.
- A worker queue integration test runs against real Postgres when `WORKER_TEST_DATABASE_URL` is set.
- No browser end-to-end tests, and no tests against a live Gmail or Stalwart.

**CI** [V]. `.trylle/workflows/railway.yml` runs build, lint (ESLint, Biome/Ultracite), typecheck and tests on every PR. `main` deploys to staging, and production deploys only from a published `v*` release. A manual workflow updates Stalwart through a forced-command SSH key after archiving volumes (`.trylle/README.md`).

**Organization** [V]
- A clean three-layer split: `apps/web` (UI and HTTP), `apps/worker` (jobs), `packages/core` (domain, providers, data, AI).
- Large UI files are a smell: `app-shell.tsx` is 1,996 lines and `thread-list.tsx` is 1,310, the same smell as Aplos's `service.ts` god closure.
- Design docs live in `docs/plans/` with status, decisions, rollout steps and "changed from the plan" notes, a good habit for an agent-heavy repo.

**Observability** [V]
- The worker writes JSON-lines logs with `level`, `message` and `time` and a child-logger pattern. Its comments say logs carry IDs and never mail content (`apps/worker/src/logger.ts`). It has `/readyz` and queue-depth stats.
- The web app has only `console.error` plus `Server-Timing` headers.
- No Sentry or other crash reporter, and no metrics pipeline. The cache plan asks for a per-mailbox quota log line that doesn't exist yet.

**Security posture** [V]
- Pub/Sub JWT verification, constant-time bearer comparison, and a canonical-origin check for OAuth redirects (`getAppUrl` refuses to start live auth without `BETTER_AUTH_URL`).
- Email HTML is rendered in a sandboxed `srcdoc` iframe (see §5).
- No app-level CSP header.

---

## 5. UI notes

**Stack** [V] (`apps/web/package.json`): TanStack Start, Router (hover preloading after 50 ms) and Query; StyleX tokens (`theme/tokens.stylex.ts`); Base UI primitives; Lexical rich text; Hugeicons; `motion` v13; Blobatar avatars. The iOS glyph set includes sparkles and wand icons (`apps/ios/Redakt/Resources/Assets.xcassets/Glyphs/`). The owner dislikes that AI glyph, so don't borrow Redakt's AI iconography.

**Motion constants (web)** [V]:
- Almost every hover and press transition is `150ms ease-out` (`components/ui/*.tsx`, `settings-ui.tsx`, `sidebar.tsx`).
- Panels use `cubic-bezier(0.2, 0, 0, 1)`: 180 ms for the standalone composer and 150 ms in the sidebar and settings.
- Sidebar indicator spring: stiffness 560, damping 27, mass 0.65.
- Thread drag: position spring 760/30/0.55, card spring 520/25/0.65, drop animation 0.42 s on a keyframed linear path with an ease-out opacity tail (`components/mail/thread-drag.tsx`).
- A global `prefers-reduced-motion` override collapses durations to 0.01 ms (`src/styles/globals.css` ~L310), and components pass `{duration: 0}` when reduced motion is on.

**Motion constants (iOS)** [V], all in one named `Motion` enum (`apps/ios/Redakt/Design/Motion.swift`):

| Name | Duration | Bounce |
|---|---|---|
| press | 0.16 s spring | 0.25 |
| snappy | 0.26 s | extra bounce 0.04 |
| bar | 0.34 s | 0.22 |
| drawer | 0.36 s | 0.1 |
| entrance | 0.5 s | 0.12 |
| reflow | 0.3 s | 0 |

The pattern of naming each spring by its purpose is worth copying, even though the values are Redakt's own.

**Keyboard model** [V]. Thin compared with Aplos: `⌥N`/`c` compose, `⌘W` close tab, `j`/`k`, `r`, `⌘A`, `Esc`, and `⌥←/→` to reorder tabs (announced through a live region). Single-key shortcuts can be turned off. There is no command palette and no archive key. Focus moves to the route's `h1` on navigation (`app-shell.tsx` ~L702-716).

**Email rendering** [V]
- Web: DOMPurify forbids `script`, `iframe`, `object`, `embed`, `form`, `base`, `link` and `meta`. CSS is cleaned of `@import`, `expression()`, `behavior` and `javascript:` URLs, and remote URLs can be blocked (`packages/core/src/render/sanitize.ts`).
- The cleaned document is wrapped with its own CSP meta tag (`default-src 'none'`, images limited to allowed sources) and rendered in an iframe with `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"`, no `allow-scripts`, and `referrerPolicy="no-referrer"`. Height is measured from the parent with ResizeObserver, which is why `allow-same-origin` is needed (`components/mail/message-body.tsx`).
- CID images become `blob:` URLs.
- iOS uses a WKWebView with `allowsContentJavaScript = false` (`EmailWebView.swift`).
- **Remote images load by default** (`load_remote_images` default true, and the commit "Load email images automatically"), with no image proxy. That is a privacy regression to avoid.

---

## 6. Lessons for Aplos

### Adopt (ideas, not code)

1. **A per-account request gate as the only path to the provider.** Cap concurrency, pause the *whole account* on a rate limit, honor `Retry-After`, and give interactive calls a short total wait budget that fails with a clear message. For Aplos: one gate per account *inside the engine*, with separate priority lanes (interactive > sync > enrichment). Redakt's per-process gate is a known weakness ("Limits of the stopgap" in `docs/plans/gmail-cache.md`). Aplos should have exactly one process that owns provider I/O.
2. **Classify Google errors by reason, and map reconnect narrowly.** Only `insufficientPermissions`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `authError`, a 401, or `invalid_grant` on refresh should mean "reconnect". Everything else is busy, quota or config. Also check the granted `scope` before treating an account as a mailbox. This directly targets the 403 that hit Aplos on its first live sync.
3. **Version cached threads by Gmail `historyId`.** A list response carries each thread's `historyId`. Never re-fetch a thread whose version hasn't changed. For Aplos's first sync this means a metadata-first pass, with bodies fetched only for threads whose version changed.
4. **Treat a history 404 as a bounded resync, not a failure.** Redakt resets its cursor. Aplos, which keeps local state, should run a bounded reconciliation of the recent window. This also closes SYNTHESIS weakness 8 (the engine ignores `reset`).
5. **A revision counter per account as the cheap change signal.** Bump it inside the same transaction that applies changes, and let clients ask "anything newer than N?". Aplos should go one step further and send *which* ids changed (see §7), but the monotonic counter is a good primitive for a phone or a reconnecting UI.
6. **Job definitions with singleton keys.** Each job type declares its schema, a dedupe key ("one queued plus one running per account"), retry limit, backoff range, timeout, concurrency and an optional schedule, with a permanent-error escape and a dead-letter store. Built on SQLite, this replaces Aplos's ad hoc 60 s poll plus inline AI. Sync triggers from IDLE, push, a timer and the user all collapse into one job per account.
7. **AI enrichment off the sync path, with fingerprints, budgets and heuristics first.**
   - Fingerprint each thread (id, last date, message count) and summarize only when it changes.
   - Keep a daily background budget separate from interactive limits.
   - Recognize automated senders before calling a model.
   - Run a summary-only first pass, and fetch bounded body text only for low-confidence results.
   - Replace ids with opaque `t1…tN` tokens in prompts.
   - Fence writes so output from a slow job is dropped if the user turned the feature off meanwhile.

   Together these fix SYNTHESIS weakness 4.
8. **Consent versioning.** Store which version of the AI-processing terms the user accepted. Raise the version when processing changes (for example, starting background summaries), which turns features off until the user agrees again. This fits Aplos's "consent card before the first bulk AI pass".
9. **Sandboxed iframe for email HTML.** Use `srcdoc` with no `allow-scripts`, an inner CSP of `default-src 'none'`, `no-referrer`, CID images as blob URLs, and a click-to-load banner for remote images. This is the minimum fix for Aplos's "email HTML in the privileged renderer". For Electron, go further than Redakt: serve the frame from a separate origin (a custom protocol or the daemon's content port) so `allow-same-origin` doesn't mean "same origin as the renderer that holds `window.aplos`" [I].
10. **Gmail draft sync.** Debounced autosave, a fingerprint to skip no-op saves, saves serialized in a chain, then send through `drafts.send` when a draft exists. Aplos has no Gmail draft sync today, and this is the simplest correct shape.
11. **A capability list per connector, exposed to the UI.** Aplos has five adapters with uneven abilities (IMAP vs Gmail labels vs JMAP keywords). Advertising capabilities lets the UI hide what a connector can't do.
12. **Small conveniences:** a one-call "shell" endpoint and self-describing attachment ids (both make a phone client cheaper), and structured logs that carry ids and never mail content.

### Avoid

1. **Retrying `quotaExceeded` like a burst limit.** Redakt and Aplos 0.2.3 both do this. Daily quota should stop that work until the reset time.
2. **Advancing a sync cursor anywhere except the sync loop.** Redakt's watch renewal overwrites `sync_cursor` (§3c), which becomes data loss once there is a local store.
3. **Reading the provider live to render list pages.** Redakt's stateless proxy costs about 220 Gmail units per cold page, multiplied by hover preloading, tabs and the worker. Its own plan concludes that "page loads should read Postgres, not Gmail". Aplos's local SQLite is the right foundation. Keep it, but make it metadata-first with lazy bodies, not 500 full threads held in memory.
4. **Caches and gates per process.** If Aplos splits into daemon plus UI plus phone, only the daemon may call providers or keep caches.
5. **JMAP without `state` and `/changes`.** Redakt's hosted connector has no change detection at all. Aplos's `jmap.ts` already uses `Email/changes` and `Thread/changes` (aplos: `apps/desktop/src/main/jmap.ts`). Keep that, and add JMAP push (EventSource) while the app is open.
6. **Coarse "refetch everything" on any change** (`router.refresh()` on a revision bump). Push changed ids instead.
7. **Undo send kept only in memory.** Aplos's outbox and undo-send must be SQLite rows with a send-at time, so a crash neither loses nor duplicates mail. Never send early because a window closed.
8. **Smaller traps:** remote images on by default with no proxy; re-uploading every attachment on each draft autosave; a hand-rolled MIME builder (use a mature library); reversible server-side password storage with a plaintext decrypt fallback (Aplos should use Keychain or `safeStorage` and fail closed).

---

## 7. "Local server" translation

### What Redakt shows about the server-style design

Redakt's server has five parts worth separating:
- **(a)** A provider-neutral `MailProvider` contract with capability flags (`mail/provider.ts`, `mail/types.ts`).
- **(b)** One JSON HTTP surface that serves two very different clients: SSR React and native SwiftUI.
- **(c)** A separate worker process with a durable job queue that owns background work.
- **(d)** Push sources (Pub/Sub) feeding a cheap per-account revision counter.
- **(e)** Server-held credentials and a server-side quota gate.

The iOS README explains the payoff: "any Redakt deployment is a backend". A LAN dev mode already works, with the dev server bound to the LAN and a `.local` hostname built into the app (`apps/ios/README.md`). That is close to the owner's "phone on the same network" idea. The difference is that Redakt's server runs in a datacenter and the Aplos server would run on the user's Mac.

### Mapping onto an Aplos engine daemon

**Process.** Promote the current utilityProcess engine into **`aplosd`**, a standalone Node process.
- Phase 1: Electron starts it as today.
- Phase 2: it runs as a per-user **LaunchAgent**, so it keeps syncing while the UI is closed and can serve a phone.
- It owns SQLite, all provider adapters, the per-account request gates, the job queue, AI enrichment, logs and crash reports. Electron becomes a client like the phone and the browser-preview mode, which already talks to a loopback HTTP server with Host and Origin checks and an SSE stream (aplos: `apps/desktop/src/main/server.ts`).

**API shape.** Two options:
- **Option A, REST plus a change stream (Redakt-like, recommended first).**
  - Resources: `GET /v1/shell`, `GET /v1/threads?view=&cursor=&limit=`, `GET /v1/threads/:id`, `PATCH /v1/threads/:id`, `POST /v1/outbox` (durable, returns a send-at time for undo), `PUT /v1/drafts/:id`, `GET /v1/attachments/:id`, `GET /v1/accounts/:id/health`.
  - One `GET /v1/events` SSE stream (or a WebSocket) that emits `{accountId, revision, threadsChanged[], threadsRemoved[], countsChanged}` whenever a sync transaction commits. This improves on Redakt, which only sends a counter.
  - Clients reconnect with `?since=<revision>`, and the daemon replays from a change log table, or tells the client to reload if the gap is too old.
- **Option B, JMAP-shaped.** Model the local API on RFC 8620/8621 semantics: per-type `state` strings, `Foo/changes` and `Foo/queryChanges`, batched method calls with back-references, and EventSource push. Pros: proven sync semantics designed for exactly this, and Aplos already speaks JMAP to Fastmail, so one client library could be reused. Cons: the full spec is large, and Gmail labels, snooze and AI fields need custom extensions.
- **Synthesis [I]:** start with Option A and borrow JMAP's two best ideas, opaque state tokens and `/changes` endpoints keyed by a monotonic SQLite change sequence. Don't implement RFC 8621 wholesale.

**Typed contract.** Define the API once (zod or TS types in `packages/`) and generate or validate both the Electron client and a future Swift client from it. Redakt hand-mirrors Swift models (`Models.swift`), which drifts. Aplos's current IPC allowlist is copied in three places, so it needs the single source anyway (SYNTHESIS weakness 10).

**Auth and exposure.**
- *Loopback (Electron and browser preview).* Bind to `127.0.0.1` only. Use a random per-launch bearer token passed to Electron over IPC or the environment. Keep the Host and Origin checks to block DNS rebinding and CSRF from web pages. Never use cookies on loopback.
- *LAN (phone).* A second listener, **off by default**:
  - Pairing through a QR code shown in Settings that carries a per-device token plus the daemon's self-signed TLS certificate fingerprint, which the phone pins.
  - Discovery over Bonjour/mDNS.
  - Per-device tokens listed and revocable, like Redakt's sessions screen with "revoke others" (`api/settings/sessions/*`).
- *Remote (relay).* The cheapest path for this owner is Tailscale, which he already uses on all his machines. A general-audience relay needs end-to-end encryption, so the relay never sees mail. That is a later, separate project.

**Background work.**
- A SQLite job table with Redakt-style definitions: a singleton key per account for `sync`, `push-renew`, `enrich` and `outbox-send`, retry with exponential backoff, a timeout, a dead-letter table, and cron entries.
- The gate per account lives in the daemon, so the Electron UI, the phone and enrichment all share one quota budget.
- IMAP IDLE and JMAP EventSource connections live in the daemon too, and they only enqueue sync jobs.

**Email HTML.** The daemon serves sanitized message HTML from a separate content origin (another port or a custom scheme), with a strict CSP, an image proxy and remote images off by default. Electron and the phone both render it in a sandboxed frame or a WKWebView with JS off, the same model as Redakt's web and iOS clients [I].

### Pros

- **One source of truth.** Electron, browser preview and the phone all see identical state and actions. The phone becomes a thin client, as Redakt's iOS app is.
- **Sync keeps running when the UI is closed or crashes.** It runs whenever the Mac is awake and logged in. The UI can restart without interrupting a long first sync.
- **One quota owner.** That is the structural fix for the 403-style bursts.
- **Easier to test.** Playwright and contract tests hit the same HTTP API, and a fake daemon can serve demo data for UI work in CI.
- **A natural home** for logs, crash reporting, the "Copy diagnostics" button and per-account health (`last_error`, `status: reauthorize` as in Redakt's `mail_accounts`).

### Cons and risks

- **Security surface.** A loopback HTTP server is reachable by any local process and, without strict Host and Origin checks, by malicious web pages through DNS rebinding. A LAN listener exposes mail to the local network, so TLS, pinning and pairing are mandatory, not optional.
- **The Mac can sleep.** A phone can reach the daemon only while the Mac is awake. That remains the hard ceiling noted in SYNTHESIS: a local daemon is not an always-on server. Provider-side filters stay the only "while asleep" automation.
- **Lifecycle complexity.** Installing and updating a LaunchAgent, migrations with several clients attached, version skew between daemon and UI (so the API needs `/v1`), and Keychain entitlements for a background agent.
- **More moving parts for a one-person team.** Redakt runs three services and still lists cache, invalidation and quota as open problems. Serialization overhead versus IPC is negligible with paging.

### Effort estimate for one developer with agents [I]

| Phase | Scope | Estimate |
|---|---|---|
| 0 | Typed API contract shared by engine and renderer; existing invoke methods move behind it | 3-5 days |
| 1 | Loopback REST plus SSE change stream with per-launch token; renderer switches from IPC to HTTP; change-log table and `since=` replay | 1.5-2 weeks |
| 2 | SQLite job queue (singleton keys, backoff, dead letter); per-account gate with priority lanes; sync, IDLE/JMAP push and enrichment as jobs; durable outbox and undo | 2-3 weeks (overlaps the first-sync rework already planned) |
| 3 | Standalone `aplosd` as a LaunchAgent: install and update, Keychain access, version handshake, health and diagnostics | 1-2 weeks |
| 4 | LAN pairing: TLS with a pinned certificate, QR pairing, Bonjour, device list and revocation | 1-2 weeks |
| 5 | Phone client: read-only v1 like Redakt's iOS scope, then compose | 3-6+ weeks |

Phases 0-2 pay off even if the phone never ships, because they fix the 403 bursts, take AI off the sync path, add a durable outbox and give UI-independent tests. Phases 3-5 only make sense once one real mailbox syncs reliably, which the 30-day plan in SYNTHESIS makes the gate.

