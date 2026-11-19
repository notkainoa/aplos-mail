# Superlocal (R44VC0RP/superlocal): architecture audit for the Aplos revamp

Date: 2026-10-25. Source: shallow clone of `https://github.com/R44VC0RP/superlocal` at `d3725bc` (2026-09-08), in `/Users/knewton/.t3/aplos-research/src/superlocal`. I only read files. Nothing was installed, built or run. Paths below are relative to that clone unless they say otherwise.

**License: none.** The repo has no LICENSE file, `gh api` reports `license: null`, and no `package.json` declares one. Treat everything as **all rights reserved**. This report describes ideas in my own words. Do not copy any code, copy text or assets into Aplos. Section 5 explains why the UI assets in particular are dangerous.

Evidence labels: **[V]** means I verified it in the code or docs at the path given. **[I]** means it is my inference.

---

## 1. Overview

**What it is.** In its own words it is "desktop-focused email, backed by a provider-agnostic Inbox SDK" (`README.md`). The GitHub description calls it "an email client & provider gateway". There are four packages (`README.md` Architecture table):

- `packages/inbox-sdk`: a headless, multi-account mail engine. It covers normalized contracts, SQLite storage, encrypted credentials, sync, a durable operation queue, an event journal, and an HTTP+SSE API with OpenAPI.
- `apps/local-host`: the "host" process. It owns sessions, provider onboarding, the OAuth client configuration, runtime paths and keys, the AI triage, and a set of app-specific "inbox window" projections.
- `apps/web`: a React 19 + Vite client, served to an ordinary browser.
- `apps/mock-api`: a fictional upstream mail store plus a real provider adapter for it, used for "mock mode".

**"Desktop" means a desktop browser, not a native app [V].** There is no Electron or Tauri anywhere in the repo (searching for either finds nothing). `scripts/dev.ts` starts the host with `Bun.serve` on `127.0.0.1:8790`, then spawns Vite (dev, or `vite preview` for the optimized build) on port 5178. Vite proxies `/v1`, `/host`, `/session` and `/api/auth` to the host (`apps/web/vite.config.ts`). The same stack ships as a Docker image (`Dockerfile`, `compose.yaml`, `.github/workflows/publish-image.yml`). It runs as a hosted multi-user deployment behind Google login at `superlocal.ryan.ceo` (`AGENTS.md`, "User-authorized project handoff").

**Maturity and activity [V].**
- Created 2026-09-03, last pushed 2026-09-08. 231 stars, 13 forks.
- 218 commits: R44VC0RP (Ryan Vogel) wrote 215 and raunakdoesdev wrote 3. That is six intense days followed by seven weeks of silence.
- Seven outside PRs (#28-#34, opened 2026-09-09 to 09-30) are still unreviewed.
- The SDK was "extracted from OpenMail" (SDK `package.json`).
- Size: about 13.7k lines for the SDK, 8.4k for the host, 21.4k TS/TSX plus 7.3k CSS for the web app, and 25k lines of tests.
- It was written by AI agents. `AGENTS.md` is a long rulebook for agents, PR reviews cite "Fable 5.1" as the reviewer, and every UI change comes with before/after media under `docs/ui-prs/`.

**Conflict of interest [V/I].** Inbound (`inbound.new`) is a first-class provider (`server/sdk/inbound.ts`, 1,194 lines), and the roadmap centers on API-first mail services. Ryan Vogel runs Inbound [I].

**Target user.** Technical people who want a unified inbox across several mailboxes and domains, self-hosted locally or in Docker. Real providers are set up by editing `superlocal.local.json` and supplying your own Google OAuth client. It is not a consumer product.

---

## 2. Feature inventory and maturity

| Feature | State | Evidence |
|---|---|---|
| Unified inbox across mailboxes, with nine pinned mailboxes (Ctrl+0..9) | Working, documented decisions | `unified-inbox-decisions.md`, `apps/local-host/src/inbox-preferences.ts` |
| Gmail (OAuth, history sync, send, labels, send-as identities) | Implemented; live-tested by the author | `server/sdk/gmail.ts`, `server/google-oauth.ts` |
| iCloud via IMAP/SMTP with an app-specific password | Implemented, "narrowly qualified" on one account | `imap-provider-review.md`, `apple-provider.ind` |
| Generic IMAP | Host presets only (endpoints fixed by the host config) | `apps/local-host/src/config.ts` (`ImapHostPreset`) |
| Outlook (Graph delta, immutable IDs) | Adapter exists; **the host has no OAuth flow**, so it shows as "not available" | `server/sdk/outlook.ts`; `apps/local-host/src/providers.ts` (`unavailable` flow) |
| Inbound (API key, domain/address views) | Implemented, paced at 110 ms per request | `server/sdk/inbound.ts:257`, `unified-inbox-decisions.md` |
| Resend, Cloudflare Email | Planned only | `README.md` roadmap |
| Local Done / snooze per mailbox membership (no upstream archive) | Working | `src/contracts.ts` `MailboxMembership`; `/v1/mailbox-actions` |
| Undo send (hold window, default 10 s, max 120 s) and scheduled send (local hold) | Working, SDK-level, not provider-native | `src/core.ts:62-66`; `/v1/operations/:id/reschedule` |
| Drafts | **Local only**; never synced to Gmail or IMAP Drafts | `imap-provider-review.md` ("Native drafts remains false"); `/v1/drafts` described as "local draft" |
| Labels | SDK-local labels plus canonical IDs for provider custom labels | `src/contracts.ts` `Label`, `Changes.addProviderLabelIds` |
| Search | Over cached mail only, using SQL `LIKE` on a concatenated `search_text` column. No FTS | `src/core.ts:1565-1590` |
| Remote images through an authenticated, DNS-pinned proxy with tracker blocking | Working, carefully built | `src/media.ts`, `src/email-images.ts` |
| Email HTML in a script-less sandboxed `srcdoc` iframe, sanitized once on the server | Working | `apps/web/src/MessageBody.tsx:127,317`; `server/sanitize.ts` |
| AI "Important/Other" triage, taught rules, cost telemetry, diagnostics | Working but very complex; OpenAI Responses protocol only | `apps/local-host/src/ai-triage.ts` (1,281 lines), `ai-inference.ts` |
| Deterministic header-based "attention" baseline (no AI) | Working | `apps/shared/mail-attention.ts`, `src/mail-facts.ts` |
| "Get me to zero" bulk Done with receipts and undo | Working | `apps/local-host/src/zero-sweep.ts`, `inbox-window.ts` |
| Hide forwarded duplicates across mailboxes | Working | `src/forwarding.ts` |
| Calendar | **UI only.** Data lives in browser storage; no CalDAV or Google Calendar | `apps/web/src/CalendarView.tsx` imports only `data`/`storage`; `docs/qa/shortcuts/README.md` ("Calendar data is local") |
| Contacts | Derived from cached mail only (`/v1/mailbox-contacts`) | `src/http.ts:667` |
| List-Unsubscribe | Detected as a classifier fact only; no unsubscribe action | `src/mail-facts.ts:34` |
| Push (IDLE, Gmail Pub/Sub, Graph webhooks) | **None, by design.** Every provider is polled every 15 s | `server/sdk/imap.ts:353` (auto-IDLE disabled); SDK README "Events And Consistency" |
| Multi-user hosted mode (Google login plus allowlist) | Working; Better Auth, private owners | `apps/local-host/src/application-auth.ts`, `README.md` |
| In-app issue reporter (screenshot plus browser logs into IndexedDB) | Working | `apps/web/src/issue-reports.ts`, `IssueReporter.tsx` |

---

## 3. Architecture deep dive

### 3a. Process and deployment topology [V]

```text
Browser tab (React) ──HTTP/SSE──► Vite dev/preview :5178 ──proxy──► Bun host :8790 (127.0.0.1 only)
                                                                    ├─ local-host dispatch (/session, /host/*, /api/auth)
                                                                    ├─ inbox-sdk Hono API (/v1/*, SSE /v1/events)
                                                                    ├─ inbox-sdk core: SQLite + Effect fibers (poll 15 s, jobs 1 s)
                                                                    ├─ Bun Worker: read-only SQLite for heavy aggregates
                                                                    └─ AI triage queue (own SQLite tables, change-feed consumer)
```

- **One process does almost everything.** The host runs in the launcher process and spawns Vite as its only child, with a scrubbed environment so provider secrets never reach the frontend process (`scripts/dev.ts`).
- **The SDK runs in-process, not as a daemon.** `createLocalHost` calls `createInbox(...)` and mounts `createInboxApi(...)` behind its own dispatcher (`apps/local-host/src/host.ts:87-213`). The SDK can also run standalone with bearer-token auth (`server/index.ts`).
- **Background work** is two Effect fibers (`src/core.ts:3324-3329`): `runDue` every 1 s (operations, snooze wakeups) and `poll` every 15 s (provider sync, up to 4 accounts in parallel).
- **Heavy reads run off the main thread** in a Bun `Worker` that opens SQLite with `query_only=ON` (`src/correspondence-worker.ts`).
- **Docker** runs the same two-port stack. Only the web port is published, on loopback. State lives in a `/persist` volume.

### 3b. Connectivity per provider [V]

**The provider contract.** Each provider implements one interface, `InboxProvider` (`server/sdk/types.ts`). It covers `getAccount`, optional `identities`, `listFolders`, `createFolder`, `listMessages`, `listThreads`, `getMessage`, `getThread`, `sync(cursor, options, context)`, `send`, `mutate`, `getAttachment` and `disconnect`. Capabilities are declared flags. Errors are normalized into nine codes (`AUTHENTICATION`, `AUTHORIZATION`, `NOT_FOUND`, `RATE_LIMITED`, `INVALID_CURSOR`, `UNSUPPORTED_OPERATION`, `VALIDATION`, `NETWORK`, `UPSTREAM`), each carrying `retryable` and `retryAfter`. `ProviderMutationError` represents "partly applied, never retry blindly". A `ProviderDefinition` adds `create`, an optional `refresh` hook, `scopes`, onboarding field descriptors and `credentialReconnect` (`src/contracts.ts:125-142`, `src/providers.ts`). The browser renders connection forms from these descriptors. The host only adds readiness and trusted presets (`apps/local-host/src/providers.ts` `describeProvider`).

**Gmail.**
- REST, not IMAP. The host runs an OAuth **web-application** client with a client secret, redirecting to `http://localhost:5178/v1/oauth/google/callback`.
- The flow uses `openid-client` with PKCE, state, nonce and ID-token verification. Attempt secrets are stored encrypted, and a ten-minute one-use handoff ticket plus a binding cookie protect the callback (`server/google-oauth.ts`).
- Scopes are `openid email gmail.modify gmail.send`, or `gmail.readonly` on a read-only host (`config.ts`).
- **Refresh** (`server/credential-refresh.ts`):
  - It keeps a rotated refresh token if Google returns one.
  - `invalid_grant` means revoked, which marks the connection `reconnect_required`. `invalid_client` means "unavailable", which is recoverable.
  - Refresh runs 60 s before expiry, single-flight per connection, guarded by a durable lease row (`sdk_connection_refresh`).
  - After a 401 the SDK retries exactly once (`src/core.ts:1019-1060`, `1225-1257`).
- A reconnect must prove it reaches the same Google account: the UserInfo `sub` must match a stored identity that a unique index protects (`src/core.ts:103`).

**IMAP / iCloud.**
- The adapter uses `imapflow`, and nodemailer for SMTP. Endpoints are owned by the host (an iCloud preset plus configured presets). The browser can only pick a preset and supply an email and password. TLS 1.2+ is enforced and `rejectUnauthorized` cannot be turned off (`server/sdk/imap.ts:340-361`, `apps/local-host/src/providers.ts` `ICLOUD_PRESET`).
- The adapter accepts an `accessToken` (XOAUTH2-capable), but the host never wires up OAuth for IMAP.
- Passwords cannot be refreshed. The `refresh` hook throws `revoked` so background retries stop (`src/providers.ts`).
- iCloud quirks the author observed and documented (`imap-provider-review.md`): SMTP sends were not saved to Sent, so the preset appends to Sent once. iCloud lacked `MOVE`, so moves are COPY plus a targeted UID EXPUNGE that requires UIDPLUS. ENVELOPE can omit `In-Reply-To`. CONDSTORE/QRESYNC were advertised but not enabled in the session. A whole-mailbox CHANGEDSINCE scan took about 12 s.

**Outlook.**
- The Graph adapter uses `/messages/delta` per folder and always sends the immutable-ID `Prefer` header (`server/sdk/outlook.ts:228-262, 559-615`).
- The SDK has a generic Microsoft refresh (`credential-refresh.ts`), but the local host never registers an Outlook OAuth flow, so the UI shows "sign-in is not available in this host yet".

**Inbound.** It uses an API key. Mailbox selection is manual (domain or address views). The client paces itself at 110 ms per request. It has hard budgets: 10,000 records, 8 MiB, and 200 enumeration requests (`unified-inbox-decisions.md`).

**Where secrets live.**
- Credentials are encrypted per connection with **AES-256-GCM**. The AAD binds each ciphertext to `[owner, connectionId]`, and the envelope is versioned with a key ID so keys can rotate (`server/crypto.ts`).
- The data key lives in `runtime-secrets.json` (mode 0600, created with `O_EXCL|O_NOFOLLOW`). An HMAC "key proof" in `host.sqlite` makes the host **refuse to start, and never regenerate keys**, if the keys don't match (`apps/local-host/src/runtime.ts:44-80`).
- There is **no OS keychain**. The key sits next to the database, so encryption only protects against a leaked database file.
- Credentials never come back out through the API (`GET /v1/connections/:id/credentials` returns version metadata only).

### 3c. Sync algorithm [V unless noted]

**Model.** Sync state is kept per *source* (account) × *generation* × *checkpoint scope* × *lane*. The table is `sdk_checkpoints(account, generation, scope, lane, data)` (`src/core.ts:96`). There are two lanes:
- `latest` refreshes the head of the mailbox and then follows the provider's native history cursor.
- `backfill` walks older history with a durable page cursor.

Cursors are typed `{provider, kind: history|delta|uid|page, value, folder, metadata}` (`server/sdk/types.ts` `SyncCursor`). Providers return two things separately: a continuation `cursor`, and a `recentCursor` that serves as the history boundary for the next head poll.

**Per-page commit and resume.** `synchronizeSource` (`src/core.ts:2161-2331`) fetches one page, then commits that page's messages, deletions, the new checkpoint and the account coverage (`empty|partial|complete`) in **one SQLite transaction**. A crash therefore loses at most one page. Duplicate concurrent syncs for the same key share one promise. If the provider rejects a stored cursor with `INVALID_CURSOR` on the first batch, the SDK retries once from `null`. A cursor that does not advance is treated as a provider bug.

**The fence against stale overwrites.** This is clever.
- Before calling the provider, sync records the owner's current event sequence.
- When a page arrives, `persist` skips any message whose `last_mutation_seq` is newer than that fence. The idea is that the user changed the message after the request left, so the sync response is stale (`src/core.ts:1390`).
- The fence also stops deletions and folder removals from overriding fresh local intents (`2241-2259`).
- A **generation** number on each account and connection fences out work started before a reconnect or credential swap (`current(row)` checks throughout).

**Gmail specifics** (`server/sdk/gmail.ts:808-912`):
- **Initial.** It reads `historyId` from `/profile` **before** listing, lists one page, then fetches each message with `format=full` in groups of 5 (`hydrate`, line 573).
- **Incremental.** `history.list`. A 404 (expired history ID) falls back to a full sync. Changed IDs are re-fetched in full, and deleted IDs are tombstoned.
- **How much gets fetched.** On connect, Gmail only gets `latest` with limit 25 (`apps/web/src/ProviderConnections.tsx:113-116`). After that, `poll` follows history and **only resumes a backfill that was already started** (`src/core.ts:3311-3318`).
- [I] So a Gmail user gets about 25 recent messages plus new arrivals. Older mail is never imported. This is the opposite extreme from Aplos's 500-thread first sync: it cannot hit the 403, but search and history stay incomplete. The project admits the cache "is not a completeness claim" (`unified-inbox-decisions.md`).
- There is no `fields` mask, no batch endpoint and no quota-unit budget.

**IMAP specifics** (`server/sdk/imap.ts:751-860`):
- Each poll runs `UID SEARCH ALL` (inventory only, no bodies) and checks UIDVALIDITY.
- It reconciles vanished UIDs against the IDs the SDK already knows, which the core passes in as `knownMessageIds` / `knownMessageStates` (`src/core.ts:2199-2210`). So deletion detection works without trusting EXPUNGE history.
- A CONDSTORE `CHANGEDSINCE` flag fetch runs **only over UIDs already stored plus genuinely new arrivals**, and only if CONDSTORE was actually enabled.
- Pages are at most 25 messages. Bodies are fetched one per lock acquisition, so foreground operations can interleave. Message IDs encode `account:mailbox:uidValidity:uid`.

**Outlook:** Graph `deltaLink` / `nextLink` stored as a `delta` cursor.

**Push.** There is none. IMAP auto-IDLE is explicitly disabled with the comment "Polling is the SDK's delivery mechanism" (`imap.ts:353`). There are no Gmail Pub/Sub or Graph subscriptions. The README says outright that SSE does not make provider detection instant.

**Rate limits, retries and backoff.**
- *Classification.* `providerRequest` (`server/sdk/types.ts:484-545`) maps 401, 403, 404, 429, 400/422 and 5xx to normalized codes and parses `Retry-After` (either seconds or an HTTP date). For Gmail, a 403 whose `errors[].reason` is `rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded` or `quotaExceeded` becomes `RATE_LIMITED`. Other 403s become `AUTHORIZATION`, which is non-retryable.
- *Sync failures.* A failed sync writes an `sdk_cooldowns` row with `max(Retry-After, min(300 s, 1 s × 2^failures))`. Rate limits set a "hard" cooldown that blocks manual syncs too (`src/core.ts:2306-2313`, `2183-2184`). There is exactly **one retry layer**, the cooldown. Adapters do not retry internally.
- *Weakness.* Daily-quota reasons are treated like per-minute limits, so the SDK keeps probing every five minutes or less. That is the same problem the Aplos council flagged in its own `RATE_REASONS`.

**Offline outbox and operations.** All provider writes go through `sdk_operations` (`src/core.ts:94`, `1668-1991`):
- **Acceptance.** A client POST with an `Idempotency-Key` creates a `pending` row. The key is unique per owner and fingerprinted, so replaying a different intent with the same key returns 409 (`replay`, line 1675). Sends get `next_at = now + undoSendSeconds`. That hold period is the undo window. Cancel only works before dispatch.
- **Claiming.** `processDue` claims **at most one operation per account at a time**, up to `concurrency` across accounts. It will not claim a mutation that touches a message an earlier pending mutation also touches. Claims use a lease UUID and `lease_until`, refreshed by a heartbeat every `lease/3`.
- **Send safety.**
  - Before dispatch, the SDK re-checks the lease, the account generation and the allowed sending identities, and tags the message with `X-Inbox-Submission-ID`.
  - A placeholder Sent row (`submission:<opId>`) is later reconciled by RFC Message-ID.
  - A dead worker or an ambiguous post-dispatch error makes the send `uncertain`, which is **never** retried automatically. SMTP accepted but Sent copy unconfirmed counts as `partial`.
- **Mutation retries.** At most 5 attempts with exponential backoff. If the provider applied a change but the local commit failed, only the local part is retried.

**Conflict resolution.**
- Each message row stores both `confirmed` (the last provider truth) and `visible` (confirmed plus every still-pending mutation replayed on top, computed by `project()`, `src/core.ts:1345-1359`). Optimistic UI comes from the projection, and rollback happens automatically when an operation fails.
- Message `revision` plus `ifRevisions` on mutations, and ETag / `If-Match` on drafts, labels and mailboxes, give optimistic concurrency.
- Provider truth wins, except where the mutation fence applies.

### 3d. Local storage [V]

**Engine.** `bun:sqlite` in WAL mode with `busy_timeout=5000` and foreign keys on. Database files and directories are created 0600 / 0700 (`src/core.ts:70-78`).

**Main SDK tables** (`src/core.ts:77-114`). Most use JSON `data` blobs with only a few extracted columns.

| Table | Purpose / notable columns |
|---|---|
| `sdk_meta` | Key-value pairs: epoch, one-off migration markers, the preview-repair cursor |
| `sdk_connections` | Encrypted `credentials`, `credential_version`, `generation`, `status`, identity JSON (unique per issuer, subject and registration) |
| `sdk_accounts` | Sources: `generation`, `status`, `data` (sync coverage/problem), `native` |
| `sdk_source_connections` | Source ↔ connection grant, with a primary flag |
| `sdk_mailboxes`, `sdk_memberships` | Mailbox views (`selector` all/domain/address) and per-view Done/snooze state for each message |
| `sdk_messages` | `id` (a UUID, not the native ID), `account`, `generation`, `native_id`, `thread_id`, `confirmed`, `visible`, **`body` (raw HTML+text JSON)**, `local_labels`, `snoozed_until`, `revision`, `deleted` (0/1/2), `last_mutation_seq`, `received_at`, `folder`, `is_read`, `is_starred`, `subject`, `search_text` |
| `sdk_native_keys`, `sdk_thread_keys` | Native ID → stable SDK ID, per account generation |
| `sdk_folders`, `sdk_labels` | Provider folders/labels (role, kind, custom) and local labels |
| `sdk_blobs` | Attachment metadata; `content` BLOB filled lazily on download |
| `sdk_drafts` | Local drafts with revisions |
| `sdk_operations` | The outbox and mutation queue described above |
| `sdk_checkpoints`, `sdk_cooldowns` | Sync cursors per lane, and backoff state |
| `sdk_events`, `sdk_states` | Durable change journal, plus per-owner head and floor |
| `sdk_delivery_evidence` | Which address/domain a message was delivered to, for domain views |
| `sdk_media_cache` | Proxied image bytes (LRU, at most 64 MiB / 512 entries by default) |
| `sdk_oauth_attempts`, `sdk_connection_refresh` | OAuth attempt state; refresh lease |

**What else is stored and how it is managed.**
- **Bodies.** Full raw HTML and text are stored for every synced message. Sanitizing happens **when the message is read**, not when it is stored (`messagePresentation`, `src/core.ts:1330`). A sanitizer fix therefore applies to old mail without any migration. Attachment bytes load lazily.
- **Indexes.** Composite indexes cover keyset paging (`owner, account, deleted, received_at, id`). There is no FTS5.
- **Encryption at rest.** Only credentials and OAuth attempt secrets are encrypted. Mail is plaintext in a 0600 file.
- **Eviction.** Only the media cache and the event journal are evicted. The journal keeps 10,000 events per owner and then advances a `floor`, so clients behind the floor get `reset.required` (`src/core.ts:552-570`). Message bodies are never evicted.
- **Migrations.** There is no `user_version`. The code uses `CREATE … IF NOT EXISTS` plus idempotent data migrations recorded in `sdk_meta` keys, for example `connection-pilot-schema` and `mail-preview-v1`, a resumable newest-first background repair (`src/core.ts:115-161`). The host has its own `local_ai_migrations` table. Downgrades are explicitly unsupported (README, Docker section).
- **Host tables.** The host adds about 40 more `STRICT` tables to `host.sqlite`. Examples are `local_window_*` (inbox projections), `local_ai_*` (queue, decisions, cache, usage, feedback) and `local_zero_*` (`apps/local-host/src/*.ts`).

### 3e. API between UI and engine [V]

There are two tiers.

**1. The core SDK API (`/v1`, Hono, `src/http.ts`).**
- Resource-oriented REST with an OpenAPI 3 document at `/v1/openapi.json`. It covers connections, accounts, mailboxes, messages, threads, labels, blobs (multipart, range requests), drafts, operations, policy and changes.
- Lists are body-free. Message bodies come from a separate endpoint.
- Every JSON GET returns an owner-scoped ETag and honors `If-None-Match`. The TypeScript client keeps a small revalidating cache keyed by `cacheScope` (`src/client.ts:74-180`).
- Mutations need `Idempotency-Key`. Conditional writes need a strong `If-Match`.
- Pagination uses opaque, HMAC-signed, owner-bound cursors and state tokens (`token`/`decode`, `src/core.ts:528-545`). Big inventories stream as NDJSON (`/v1/mailbox-snapshot`).
- **Realtime.** `GET /v1/events` is SSE (`src/http.ts:865-963`):
  - It sends `ready {state}`, replays the journal from `Last-Event-ID` or `since`, and sends `reset.required` when history has expired.
  - Events are metadata only (`{id, type, entityId, change, reason}`). Clients refetch.
  - The server re-authenticates on every page, sends a heartbeat every 15 s, and caps each stream at 5 minutes and 4 per owner.
  - If the stream is down, the web client polls `/v1/changes` with jittered backoff (`apps/web/src/inbox.ts:1448-1515`).
  - This is effectively JMAP's `state` / `*/changes` model over HTTP+SSE.

**2. The host "BFF" (`/host/*`).**
- These are app-specific projections the browser cannot compute cheaply. `/host/inbox/query|page|counts|lookup|changes|sender|contacts|selection/*|zero/*` (`apps/shared/inbox-window.ts:22-39`) materialize scoped conversation windows in `local_window_*` tables and return 100 rows at a time.
- The response window is capped at 1,000 rows and 32 MiB, and each response at 4 MiB. Responses carry `{queryId, indexRevision, scopeState, sdkState, catchup}`.
- The host **imports the web app's own predicate and search code** (`apps/local-host/src/inbox-window.ts:13-16` imports `web/src/mail-model`, `mail-search`, `mail-view`). Client and server therefore filter the same way.
- The result is "demand-driven" loading: no endpoint ships the whole mailbox. `docs/ui-prs/demand-inbox/review.md` measures cached opens at about 28 ms, and E/W actions at about 40-50 ms, on 10k and 50k fixtures.

**Transport security (loopback mode)** (`apps/local-host/src/host.ts:156-243, 391-395`):
- Binds `127.0.0.1` only and checks `Host` against an allowlist, which defeats DNS rebinding.
- `POST /session` needs an exact allowed `Origin` plus `X-Superlocal: 1`, and returns an HttpOnly SameSite=Lax cookie (12 h by default). Only an HMAC of the cookie is kept.
- Non-GET requests need an exact allowed Origin. Cross-site requests are rejected.
- Raw SDK credential endpoints are blocked for browsers. Credentials only enter through declared onboarding fields.
- **Hosted mode** uses Better Auth Google login with an exact email allowlist and a private owner per person (`application-auth.ts`).

### 3f. Send, drafts, threading, labels, calendar, AI [V]

- **Send.** Drafts live in the SDK. A submit creates a held send operation (see 3c). Gmail builds MIME with nodemailer's stream transport and posts to `messages/send` with `threadId` (`gmail.ts` `send`). IMAP sends through SMTP and, depending on the preset, either appends to Sent or trusts the server to do it.
  - **Gmail drafts are not synced.** Neither are IMAP Drafts. Drafts are SDK-local, and browser storage keeps a recovery copy.
- **Threading.** Threads are per source. Gmail and Graph native thread IDs map through `sdk_thread_keys`. IMAP uses References/In-Reply-To grouping. Threads never merge across accounts, even when subject or Message-ID match (`unified-inbox-decisions.md`). Forwarded copies across mailboxes are detected separately and hidden (`src/forwarding.ts`).
- **Labels and folders.** Folders have roles (inbox, archive, sent, drafts, spam, trash). Provider labels are `Folder{kind:'label', custom}`. SDK-local labels are a separate namespace. "Done" and snooze are **local membership state, not upstream archive**. [I] That keeps upstream untouched, but the user's phone Gmail app will still show the message in Inbox.
- **Calendar and contacts.** Calendar has no provider integration. Contacts are only an aggregate over cached mail.
- **AI.**
  - *Configuration.* One configured endpoint using the OpenAI Responses protocol (`ai-inference.json`: endpoint, key, models, rate cards, reasoning effort default low, concurrency default 2).
  - *Off the sync path.* AI is a separate consumer of the change journal with its own cursor (`ai-triage.ts:426-441`). It **never sits on the sync path**.
  - *Queue.* There are two lanes, `incoming` and `history`, with caps (about 10k per owner and 20k globally), exponential backoff that respects `retryAfter`, and per-thread input hashing for cache reuse.
  - *Consent and cost.* Only new arrivals are processed by default. The source says a flag or restored historical membership is not consent to process history, so old mail needs an explicit job (`ai-triage.ts:487-492`). The host records cost and usage telemetry and diagnostics.
  - *Grounding.* The prompt demands exact quoted evidence (`ai-inference.ts:199`).
  - *Fallback.* A deterministic "attention" baseline uses header facts (List-Id, List-Unsubscribe, Precedence, Auto-Submitted, reply headers) plus keyword regexes, and classifies mail without any model (`apps/shared/mail-attention.ts`, `src/mail-facts.ts`).

---

## 4. Engineering quality

**Tests [V].** Six files in total.
- `packages/inbox-sdk/tests/api.test.ts` (14.7k lines, 344 tests) and `provider.test.ts` (4k lines, 93 tests). These are described as "TDD product contracts" covering isolation, persistence, workers, cache, SSE and fake upstream failures.
- Four web test files, about 90 tests, run with `node --test`.
- Live provider tests need exactly `INBOX_TEST_LIVE=true` plus dedicated credentials. Any other non-false value throws, so nobody can run them by accident (`provider.test.ts:2242-2247`).
- `imap-provider-review.md` has a good **qualification matrix**. Each capability is labeled D (deterministic test), R (live read), W (live write to test mail only), S (server-dependent) or N (not exercised). Mocked passing is never counted as live qualification.

**CI [V].** The only workflow publishes Docker images. **No tests run in CI.** `AGENTS.md` even forbids adding CI or new test files without approval.

**Organization.** The package boundaries are clean (SDK, host, web, mock, and `apps/shared` for logic that runs on both sides). Inside the files, the code is extremely dense. `src/core.ts` is one 3,345-line closure with 163 lines over 200 characters (the longest is 997). `host.ts` routes through one long `if` chain. `App.tsx` and `inbox.ts` each run over 3,000 lines. Validation is thorough: every input is bounded, and raw provider errors never reach the browser (`connectFailure`, `providers.ts`).

**Observability [V].** Content-free JSON event codes go to stdout. Browser timing samples go to a rotating `performance.jsonl` (2 MiB plus one backup; `apps/local-host/src/performance-log.ts`). AI diagnostics are stored in SQLite and shown in Settings. There is no crash reporter. Performance budgets are written down and measured: 100 ms cached open, 150 ms E/W, 1.5 s for 10k and 4 s for 50k navigation (`AGENTS.md`).

---

## 5. UI notes [V]

- **Framework.** React 19 plus Vite 7. There is no component library (`apps/web/src/components.tsx` has hand-rolled `Icon`, `IconButton`, `Key` and `Modal`) and no motion library. The only runtime dependency besides React is `modern-screenshot`, used by the issue reporter.
- **Motion.** CSS transitions in `apps/web/src/mail-motion.css` plus FLIP-style row reordering using the Web Animations API in `mail-motion.tsx`:
  - Row transform: 256 ms `cubic-bezier(0.19, 1, 0.22, 1)` (an expo-out curve).
  - Opacity: 160 ms on the same curve.
  - A variant at 254 ms `cubic-bezier(0.19, 0.5, 0.22, 1)`.
  - A 200 ms overshoot pop, `cubic-bezier(.525,.0825,.215,1.18)`, on restored rows.
  - The review notes also mention a 320 ms Undo motion.
  - There are explicit `transition: none` paths for instant and reduced-motion cases.
- **Keyboard.** A pure resolver `resolveMailShortcut(event, context) → typed action` (`apps/web/src/mail-shortcuts.ts`). Context covers mode (list, reader, composer, auxiliary), editing, modal and sequence state. Multi-key sequences such as g-i and gg are supported. It has 622 lines of tests. The bindings are an audited clone of **Superhuman's** published Mac shortcut sheet (`docs/qa/shortcuts/README.md`).
- **IP problem. Do not borrow this UI.**
  - `apps/web/scripts/extract-assets.mjs` downloads `@font-face` files from `mail.superhuman.com/~backend/build/` URLs found in a git-ignored `reference/source.css`.
  - `apps/web/public/assets/` ships the results: files named Adelle, Operator Mono, SuperMailSans and Consolas Email. Those are commercial typefaces licensed to another company.
  - `Snippets.tsx` contains Superhuman marketing text.
  - The look is a deliberate Superhuman clone. Aplos must not use any of these assets or the visual design. The keyboard *ideas* are generic and fine.

---

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **Keep a `confirmed` and a `visible` projection per message.** Store provider truth and "truth plus pending ops" separately, and recompute the projection whenever an op is accepted, settles or fails. Optimistic UI, rollback and offline queueing then all fall out of one function. This replaces Aplos's clone-the-mailbox-per-mutation approach.
2. **Use a mutation fence for sync.** Capture the journal sequence before each provider call, and never let a sync page overwrite a message that was mutated after that fence. Add **generation numbers** on accounts and connections so in-flight work from before a reconnect cannot commit.
3. **Commit sync per page, with explicit lanes.** Keep `latest` and `backfill` checkpoints separate. Commit each page's messages and cursor in one transaction. Capture the Gmail `historyId` before listing. Fall back once on `INVALID_CURSOR`. This directly fixes Aplos's all-or-nothing 500-thread first sync. Aplos should *not* copy Superlocal's "25 messages and never backfill" default. A budgeted, resumable backfill lane is the middle path.
4. **Keep one retry layer, via a durable cooldown table.** Have one `cooldowns(account, next_at, failures, hard)` row honoring `Retry-After`, and no retries inside adapters. Classify by Google's `reason` and not the HTTP status. Improve on Superlocal by treating `dailyLimitExceeded` / `quotaExceeded` as "stop until reset".
5. **Apply operation-queue discipline.** That means idempotency keys with intent fingerprints, one in-flight op per account, no reordering of ops on the same message, lease plus heartbeat, `uncertain` for any send whose outcome is unknown, a placeholder Sent row reconciled by Message-ID, and undo-send as a hold time on `next_at`. Aplos already has a durable op queue and duplicate-send protection. Compare it against this checklist.
6. **Add a durable change journal with opaque state tokens.** Use an `events(seq, owner, data)` table, signed `state` tokens, `changes(since)`, SSE with `Last-Event-ID`, and `reset.required` when the floor has moved. Events carry IDs only, and clients refetch. This is the cleanest base for both the Electron UI and a future phone client, and it replaces Aplos's in-memory `{epoch, rev}` diffs.
7. **Run AI as a change-feed consumer, never inside sync.** Give it its own cursor, queue lanes (incoming vs history), caps, backoff that honors `retryAfter`, input-hash caching, and a consent rule that history is never processed implicitly. Pair it with a deterministic header-facts baseline (List-Id, List-Unsubscribe, Precedence, Auto-Submitted, reply headers) so Home works with no AI at all. This addresses the council's weakness #4 almost exactly.
8. **Sanitize email at read time on the engine, render in a script-less sandbox, and proxy images.** Store raw bodies and sanitize when served, so sanitizer fixes apply to old mail. Render in a `srcdoc` iframe with no `allow-scripts`, its own strict CSP and `no-referrer`. Fetch remote images through an engine route with HMAC-bound URLs, DNS pinning, a private-range blocklist, size caps, tracker blocking and an LRU cache. This hides the user's IP and fixes the council's weakness #6.
9. **Treat key material as fail-closed.** Use AES-GCM with AAD bound to owner and connection, a versioned envelope with a key ID, and a stored HMAC "key proof" so mismatched keys refuse to start instead of silently regenerating. Keep Aplos's Keychain / safeStorage for the master key. Superlocal's plaintext key file is weaker.
10. **Use a provider contract with declared capabilities, normalized error codes and onboarding descriptors.** Pin IMAP endpoints and TLS in the engine so the UI cannot redirect credentials.
11. **Build demand-driven list windows.** Serve keyset pages of about 100 body-free rows, compute counts on the engine, and share one predicate/search module between engine and UI. This removes the in-memory mailbox ceiling.
12. **Make mock mode a real provider adapter** with its own data directory and keys, and adopt the **D/R/W/S/N qualification labels** so mocked evidence never passes as live evidence.
13. **Keep diagnostics content-free and bounded,** and measure written performance budgets on 10k/50k fixtures.

### Avoid

1. **Polling-only by design.** Aplos needs IMAP IDLE and JMAP push while the app is open (SYNTHESIS). Superlocal turned IDLE off on purpose.
2. **Never backfilling Gmail history.** Local-only search over about 25 messages is not a daily driver.
3. **`LIKE` search over a concatenated column.** Keep Aplos's FTS5.
4. **Local-only drafts and local-only Done.** Phone users see stale state. Aplos needs Gmail draft sync, and Done should archive upstream (or be a clear setting).
5. **Keys in a JSON file beside the database**, and plaintext mail with no Keychain use.
6. **Bun-specific runtime** (`bun:sqlite`, `Bun.serve`, `Bun.sleep`, Bun Workers). It does not drop into Electron/Node.
7. **Unreadable density**, meaning god-closures and 900-character lines, and an agent process (UIPR evidence, baseline rules) that consumed more effort than features. Also, no tests in CI.
8. **Commercial fonts and Superhuman text scraped into the repo.** This is a legal liability. Never look to it for assets.
9. **Two HTTP servers (Vite preview plus host) in production.** Serve the built UI from the engine/daemon, or from Electron's `file://`, instead.

---

## 7. "Local server" translation for Aplos

**Starting point.** Aplos already has most of the parts:
- a platform-free engine (`src/engine/`, ports for SQL, secure storage and sockets),
- a utilityProcess host,
- a dev-only HTTP server (`apps/desktop/src/main/server.ts`) with `POST /api/invoke` and SSE `/api/events`.

Superlocal shows what that server looks like when it becomes the *primary* interface.

### Target shape

```text
aplosd (engine; Node, not Bun)                    clients
├─ SQLite: mail, ops, checkpoints, journal        Electron renderer ─┐
├─ sync workers (lanes, cooldowns, IDLE/push)     Browser preview  ──┼─► HTTP+SSE (or JMAP-ish) API
├─ op queue (leases, idempotency, undo hold)      Phone (later)    ──┘   over loopback / UDS / pairing+TLS
├─ AI consumer (journal cursor, own queue)
├─ media proxy + server-side sanitizer
└─ API: /v1 core resources + /app projections + /events
```

**Concrete mapping**

| Superlocal piece | Aplos equivalent |
|---|---|
| `createInbox` core + `sdk_*` tables | `src/engine` moved to SQLite-first: `messages(confirmed, visible, body, revision, last_mutation_seq)`, `ops`, `checkpoints`, `cooldowns`, `events`. Drop the in-memory `AppState` as the source of truth. |
| `/v1` resources with ETag / Idempotency-Key / If-Match | A typed contract (one schema module generating both the TS client and the validators) replacing the 55 `invoke` string methods copied in 3 places. |
| `/v1/events` SSE with `ready` / `reset.required` and `/v1/changes` | Replace `{epoch, rev}` IPC diffs. Electron can carry the same journal over a MessagePort; HTTP clients use SSE. |
| `/host/inbox/*` windows | `app/threads.page`, `app/counts`, `app/sender`: engine-side projections with shared predicates. The renderer holds only about 100-1,000 rows. |
| Loopback session (exact Origin + custom header + HttpOnly cookie, Host allowlist) | For Electron, a per-launch random bearer token passed through preload, or a Unix domain socket with 0600 permissions. Keep the Host/Origin checks for browser preview. |
| Hosted Google-login mode | For a phone: device pairing (QR code with a one-time code), per-device tokens stored in Keychain on both ends, TLS with a pinned self-signed certificate, reached over Tailscale or a relay. Never reuse the loopback-cookie model across a network. |
| `runtime-secrets.json` + key proof | Master key in macOS Keychain (the daemon needs a native Keychain binding, since `safeStorage` is Electron-only), plus a key-proof row and fail-closed startup. |
| Mock mode (separate data directory and keys) | Aplos's browser-preview and demo state become a demo provider adapter behind the same daemon, in a separate profile directory. |

### Deployment options on macOS

- **(a) Keep the engine as an Electron `utilityProcess` that also listens on loopback or a UDS.** This is the cheapest option and keeps `safeStorage`. It only runs while the app is open.
- **(b) Run a launchd `LaunchAgent` daemon** (Node single-binary or Electron-as-Node) that the app starts and supervises. It keeps syncing after the window closes, but not while the Mac sleeps. It needs its own Keychain access, an update and version-skew protocol, and crash restarts.
- Start with (a) and the API boundary. Move to (b) only when phone access matters.

### Pros

- One engine serves desktop, browser preview, CLI or test harnesses, and later a phone.
- The renderer leaves the mail-data and HTML trust path.
- Heavy work leaves the UI process.
- Every feature becomes testable over HTTP with emulated providers.
- The journal and state tokens make reconnects and multiple windows correct by construction.
- It fits Aplos's existing ports design.

### Cons and risks

- A localhost server is a real attack surface: other local processes, DNS rebinding, CSRF, and browser extensions. Superlocal's checklist (Host allowlist, exact Origin, custom header, HttpOnly cookie, no CORS wildcard) is the minimum.
- Version skew between the daemon and the UI.
- launchd lifecycle and update complexity.
- The Mac sleeping means the phone sees stale data unless provider-side filters and push carry the load. A local daemon cannot match a hosted server's always-on automation (SYNTHESIS).
- Every response needs pagination and bounding, or the old memory ceiling simply moves into the daemon.

### Effort for one developer plus agents (estimates)

| Step | Effort |
|---|---|
| Typed contract plus journal (`events`, `changes`, SSE), with Electron consuming it over IPC | 1-2 weeks |
| SQLite-first message store with `confirmed`/`visible` projection, paged queries, and removal of the whole-mailbox clone | 2-3 weeks |
| Sync rework (lanes, page commits, cooldowns, fence) together with the Gmail first-sync fix | 1-2 weeks, overlapping the previous step |
| Media proxy, server-side sanitizer and sandboxed iframe | about 1 week |
| Loopback/UDS auth and serving the browser preview from the engine | 2-4 days |
| launchd daemon, Keychain binding and update/version handshake | 1-2 weeks |
| Phone access (pairing, TLS pinning, relay, mobile client) | 4+ weeks, and outside the 30-day plan |

The first five steps are worth doing anyway, because they fix known problems 2, 4, 6 and 9 from SYNTHESIS. The daemon and phone steps are optional, and should come after the engine speaks the API.

---

### Open questions

- Superlocal's design for Gmail historical backfill (when, how paced, how it interacts with quota) is not implemented. Aplos must design this itself. Inbox Zero's unused budget module is the better reference.
- Should "Done" in Aplos archive upstream, as Gmail users expect, or stay local, as Superlocal does? This affects phone and cross-device consistency.
- Should a future daemon be Node inside Electron (keeps `safeStorage`) or a standalone binary (survives closing the window)? It depends on how much background sync matters versus provider-side filters.
