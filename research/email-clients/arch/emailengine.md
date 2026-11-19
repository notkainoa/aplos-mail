# EmailEngine (Postal Systems): architecture audit for the Aplos revamp

2026-10-25. Source: `github.com/postalsys/emailengine` at `c701cd7` (release v2.86.0, 2026-10-23), shallow-cloned to `/Users/knewton/.t3/aplos-research/src/emailengine`. I only read files. Nothing was installed, built or run. Paths below are relative to that clone unless they start with `apps/desktop/` (Aplos). **The license is commercial and source-available. Nothing here may be copied into Aplos.** This report describes ideas in my own words and quotes no more than a short phrase.

Labels: **[V]** means I verified it against a file or URL, cited inline. **[I]** means it is my inference.

---

## 1. Overview

**What it is.** EmailEngine is a self-hosted Node.js server. It puts one REST API and one webhook stream in front of IMAP/SMTP, the Gmail API and Microsoft Graph [V `CLAUDE.md` "Project Overview"]. An integrator (a CRM, helpdesk or SaaS backend) registers mailboxes once. From then on it reads, searches, sends and receives `messageNew`/`messageDeleted`/... webhooks without touching mail protocols. It is the clearest working example of "one server that connects to every mail service". It is a **gateway, not a mail client and not a mail store**. That distinction drives most of the lessons below.

**License.** The "EmailEngine License Agreement" v2.1 [V `LICENSE_EMAILENGINE.txt`] gives a 14-day trial, after which a paid key is required. Source may be viewed and modified only for internal use, and tampering with license checks is prohibited. GitHub reports `NOASSERTION`. Treat it as all rights reserved for Aplos's purposes. Its IMAP library **imapflow**, by the same author, is MIT-style: the license text in `node_modules/imapflow/LICENSE.txt` is the permissive MIT grant without the notice clause, and its `package.json` says MIT. Aplos already depends on it legitimately.

**Maturity and activity** [V `gh api`]:
- Created 2020-02-28. 2,244 stars, 228 forks, 2 open issues.
- About 3,750 commits. `andris9` (Andris Reinman, author of Nodemailer and imapflow) wrote 3,528 of them. Release automation is next with 191. Fewer than 20 humans have ever contributed, so this is effectively a one-person codebase.
- Releases v2.84.0 through v2.86.0 shipped between 2026-10-15 and 2026-10-23.
- The weekly participation series ends with 187 commits in the most recent week.
- It is extremely active and heavily agent-assisted: `CLAUDE.md`, 30 KB of path-scoped `.claude/rules/*.md`, and `claude-code-review.yml` and `claude.yml` workflows. That is the same development style as Aplos.

**Size** [V `wc`]: about 112K lines of runtime JavaScript (`lib/`, `workers/`, `server.js`, excluding the vendored IMAP server core) and about 94K lines of tests.

**Target user.** A backend developer or operator who runs one instance for many mailboxes (hundreds to tens of thousands). Docs size Redis at 1-2 MiB per account and recommend 8 GB RAM and 4 cores as a production minimum [V learn.emailengine.app "Performance Tuning" and "Deployment Overview", found via search]. It is not aimed at a single person on a laptop. It does, however, ship as a single-file macOS binary that binds `127.0.0.1:3000` by default [V `CLAUDE.md` env list, `package.json` `pkg.targets`, `entitlements.mac.plist`], which makes it a concrete reference for "a mail daemon on a Mac".

---

## 2. Feature inventory

| Feature | Maturity | Evidence |
|---|---|---|
| IMAP/SMTP accounts (password and XOAUTH2) | Very mature; many server quirks handled | `lib/email-client/imap-client.js` (3.4K lines), `imap/mailbox.js` (3.4K) |
| Gmail via REST API (`gmail.modify`) or via IMAP (`https://mail.google.com/`) | Mature | `lib/oauth/gmail.js:84-88` scope presets; `gmail-client.js` (3.5K) |
| Microsoft Graph (delegated, app-only, shared mailboxes, GCC/DoD/China clouds) | Mature, still actively patched | `outlook-client.js` (5K lines); `oauth2-apps.js:225-260` |
| Push: IMAP IDLE, Gmail Pub/Sub (pull), Graph subscriptions | Mature, with fallback pollers | `workers.md` "IMAP Worker" |
| Webhooks (about 24 event types, retries, HMAC, custom JS filter/map routes) | Mature | `lib/consts.js:13-82`; `lib/webhooks.js` |
| Outbox: queued, scheduled (send-later), retried sending; idempotency keys | Mature | `base-client.js:2702-2800`; `lib/outbox.js` |
| Hosted OAuth/IMAP setup form, autodiscovery (MX, SRV, autoconfig, ISPDB, Exchange) | Mature; the Exchange path was fixed only in 2026-09 | `CLAUDE.md` "Email autodiscovery" |
| Export (NDJSON, optional encryption) | Newer | `workers/export.js`, `lib/export.js` |
| IMAP proxy (legacy clients reach OAuth mailboxes) and SMTP submission server | Mature | `lib/imapproxy/`, `workers/smtp.js` |
| AI summary of new inbox mail (OpenAI-compatible) | Narrowed recently | `lib/llm-pre-process.js`; server.js `commandGenerateSummary` |
| "Document Store" (Elasticsearch copy, unified search, chat with email, embeddings) | **Removed in 2.82.0 (2026-10-01)** | `CHANGELOG.md:263`; commit `56df159` |
| MCP endpoint (`POST /mcp`, token-scoped tools) | Quiet beta, off by default | `CLAUDE.md` "MCP endpoint" |
| Admin UI (accounts, queues, TLS/ACME, tokens, logs) | Mature | `views/`, `lib/ui-routes/` |
| Calendar or contacts sync | **None.** It only extracts ICS attachments into webhook payloads | `base-client.js:3182-3187` |
| Local threading for plain IMAP | **None since 2.82.** It relies on provider thread IDs | commit `56df159` message ("the thread and bounce lookups in the IMAP sync" were removed) |

---

## 3. Architecture deep dive

### 3a. Process and deployment topology

There is one Node process with **worker threads**, coordinated by the main thread in `server.js` (4K lines) over `postMessage` [V `workers.md` intro]:

- **api** (`workers/api.js`): a Hapi server for `/v1/*` REST, `/admin/*` UI, `/metrics`, `/mcp` and SSE feeds. It owns no mail connections.
- **imap** (default 4, `EENGINE_WORKERS`): each worker runs a `ConnectionHandler` that holds *many* accounts in one event loop [V `workers/imap.js`]. Despite the name, this worker also runs Gmail API and Graph accounts.
- **submit**, **webhooks**, **export**: BullMQ consumers.
- **smtp** and **imapProxy**: optional listeners.
- **Redis** is required and is the only datastore. BullMQ queues live in it too.

**Account placement.** The main thread assigns each account to the least-loaded sync worker. When a worker dies, its accounts move back to "unassigned" and are reassigned. This is pure bookkeeping, isolated for testing in `lib/account-assignment.js`. Workers send heartbeats, and the main thread marks a worker unhealthy after 30 s of silence and restarts it after 60 s [V `server.js:880-883`].

**Request routing.** The API worker never talks to a mailbox. For `listMessages`, `getMessage`, `submitMessage`, `updateMessage`, `moveMessage`, `uploadMessage`, `getAttachment` and similar calls, it sends an RPC to the main thread. The main thread forwards it to the sync worker that owns the account, which uses its live connection [V `server.js:3177-3233` `COMMAND_HANDLERS`]. The live, stateful connection is the unit of ownership, and everything else is stateless. RPC errors cross thread boundaries through an explicit field list (`lib/worker-rpc-error.js`), because a field that is dropped in transit has silently changed send-failure classification before [V `workers.md` "RPC envelope"].

**Reads are pass-through.** `Mailbox.listMessages` takes a mailbox lock and runs IMAP `SEARCH`/`FETCH` against the server for each page request [V `imap/mailbox.js:3174-3290`]. Gmail listing calls `messages.list` and then fetches each message on the page (`format: 'full'` by default, `minimal` optionally) [V `gmail-client.js:768-965`]. **EmailEngine does not store message bodies.** Redis holds only what change detection needs.

**Packaging constraints the author imposes** [V `CLAUDE.md` "Pure JavaScript only"]:
- No native addons, no WASM, no shelling out at runtime, CommonJS only.
- This lets one `pkg` binary run on Linux, macOS and Windows.

### 3b. Connectivity per provider: auth and token storage

**IMAP/SMTP** uses a password or XOAUTH2. Every ImapFlow client is created through one factory, `lib/create-imap-client.js`, and a guardrail test forbids constructing ImapFlow anywhere else. That factory:
- caps line, literal and response sizes so one hostile server can't exhaust a worker that serves many accounts;
- forces STARTTLS on non-TLS ports unless the account explicitly opts out;
- picks a FIPS-safe ID hash.

**Gmail** comes in three OAuth app "base scopes": `imap` (full `mail.google.com` scope, XOAUTH2 over IMAP/SMTP), `api` (`gmail.modify`, REST) and `pubsub` (a service app that only pulls notifications) [V `lib/oauth/gmail.js:84-88`]. Consent uses `access_type=offline` and `prompt=consent` [V `gmail.js:336,346`]. Workspace service accounts with domain-wide delegation and GCP metadata-server identities are also supported.

**Microsoft** offers delegated or app-only Graph, or IMAP/SMTP with XOAUTH2. Sovereign clouds are handled.

**Token renewal** (`lib/account.js:2495-2600`) [V]:
- It renews when fewer than 30 s remain.
- It takes a per-account distributed lock, then re-checks inside the lock whether someone else already renewed.
- It persists a rotated refresh token and the granted `scope` list.
- The write is **compare-and-set on the refresh token that was used**. A re-authorization that lands mid-renewal is therefore not overwritten by the older grant.
- A cached access token that the provider rejects is invalidated and renewed exactly once per request (`renewRejectedAccessToken`).

**Credential errors are classified carefully** (`lib/email-client/credential-errors.js`) [V]:
- Network errors, 408, 429 and 5xx from a token endpoint count as **transient**: retry and stay connected.
- Only a 4xx is a **refusal**, which sets `authenticationError`, sends a webhook and waits for a human.
- `invalid_grant` becomes a stored "user flag" with plain-language help, which explicitly mentions the 7-day refresh-token expiry for unverified Google apps [V `gmail.js:183-200`].
- Accounts that keep failing auth for 3 days are "parked" (sync disabled, with a resumable marker) instead of hammering the provider [V `workers.md` "Error handling"].
- IMAP logins rejected with RFC 5530 `[UNAVAILABLE]`/`[SERVERBUG]`/`[INUSE]`/`[LIMIT]` count as connect errors, not auth errors.

**Storage and encryption at rest.** Secrets live in the Redis account hash. Encrypted fields are passwords, access tokens, refresh tokens, webhook URLs and headers, and proxy URLs [V `lib/account.js:52-70`].
- Each value is sealed with AES-256-GCM using a random 96-bit IV per value.
- The key is derived with PBKDF2-SHA256 (600,000 iterations) from the `EENGINE_SECRET` environment variable, plus a per-process random salt, with an LRU cache of derived keys [V `lib/encrypt.js` header].
- **If no secret is configured, credentials are stored in cleartext** [V `encrypt.js:328-331`].
- API tokens are stored as SHA-256 hashes [V `lib/tokens.js:33,80`].
- Mail content is not stored, so the question of encrypting it at rest mostly doesn't arise. Only the index and outbound messages are held.

### 3c. Sync algorithm

**IMAP: two connections plus optional extras per account** [V `imap-client.js:364-424`, `workers.md`]:
- A **primary** connection stays in the main mailbox (INBOX) under ImapFlow auto-IDLE.
- A **command connection** is opened lazily for API operations while the primary is busy syncing. It closes after 60 s of inactivity (`imap/idle-settings.js`).
- Optional **subconnections** IDLE on other folders (Sent, Junk).
- Every operation runs under ImapFlow's mailbox lock. Releasing the lock re-arms a timer that sends the primary back to INBOX, which is what keeps IDLE alive.

**Per-folder decision tree** (`imap/sync-operations.js:57-150`) [V]. The stored folder status is UIDVALIDITY, UIDNEXT, message count, HIGHESTMODSEQ and last full-sync time. It is compared with a fresh SELECT/STATUS:
1. **UIDVALIDITY changed**: rebuild the folder's index silently and emit one `mailboxReset` event so consumers can reconcile.
2. **Same count, same UIDNEXT, full sync within 30 min**: skip.
3. **CONDSTORE and HIGHESTMODSEQ moved, and only appends happened**: `FETCH ... CHANGEDSINCE <modseq>`.
4. **Only appends** (UIDNEXT delta equals count delta): fetch `uidNext:*`.
5. **Otherwise run a full sync.** It fetches UID, flags, modseq, emailId, labels and internal date in batches (`DEFAULT_FETCH_BATCH_SIZE` 1000, `lib/consts.js:428`), compares them against the index 500 at a time, and expunges missing UIDs in chunks.

QRESYNC/VANISHED is parsed but not used to drive sync [I: the only reference is a comment at `mailbox.js:1270`].

**Two indexer modes.** The **full** indexer keeps a Redis sorted set per folder, scored by UID, holding a msgpack'd `{uid, flags, modseq, emailId, labels, internalDate}`. It detects new, changed and deleted messages. The **fast** indexer only remembers UIDNEXT, so it detects new mail only. That's one value per folder against one entry per message [V `mailbox.js:520-560,689-711`; learn.emailengine.app "IMAP Indexers"].

**Recovering a lost index.** If an account has connected before but a folder's state hash is missing (for example, Redis evicted it), the folder is re-seeded *without* announcing every message as new [V `sync-operations.js:126-150`]. Docs require `maxmemory-policy noeviction` for this reason.

**"New" is not the same as "synced."** New messages are written to a per-folder **arrivals queue** (a Redis sorted set) in the same transaction as the index write. A drain loop peeks, processes and only then removes each entry, so a crash or disconnect leaves unprocessed arrivals for the next pass [V `mailbox.js:2240-2290`]. ETHROTTLE responses are retried a bounded number of times, and poison entries are dropped with an error log. `notifyFrom` suppresses "new" events for mail older than the connect date, so a first sync never floods consumers.

**Resilience details worth knowing** [V `workers.md`]:
- **Reconnect backoff.** It is 2 s up to 10 min for setup. For dropped connections it is 2-30 s, gated on how long the connection survived (5 min counts as stable) rather than reset by a successful login. This fixed a loop of about 17 logins per second.
- **Adaptive IDLE.** The restart interval is learned per server host from IDLE sessions that drop, with a provider table: Yahoo 3 min, Rambler 55 s, 163.com uses STATUS as keepalive (`imap/idle-settings.js`).
- **Stale-view detection.** It can detect a server that keeps the session alive but stops updating the selected mailbox.
- **Phantom folders.** A folder that fails SELECT repeatedly is parked.
- **Periodic resync.** Every 15 min (`imap-client.js:53`), non-INBOX folders are swept.

**Gmail API mode has no initial sync at all** [V `gmail-client.js:329-520`]:
- On first connect it calls `users.getProfile`, stores `historyId` and starts watching.
- Listing is served live. Change detection is `history.list` in pages of 500 from the stored cursor.
- **The cursor advances after each history entry**, not after each run.
- An "in-flight" marker records which entry is being processed and how many attempts it has had. After 3 attempts that killed the worker, the entry is skipped with a `syncWarning` event that names the lost message IDs [V `gmail-client.js:3223-3395`, `consts.js:275`].
- Message fetch failures are **deferred and retried individually** instead of failing the run.
- A history 404 emits `syncWarning` and resets to the current historyId.
- Notifications that arrive during a run are coalesced into one pending historyId (`triggerSync`, `:2979-3011`).

**Push without a public URL.** Gmail push uses a Pub/Sub **pull** subscription: a long-poll of `:pull` (up to 100 messages) followed by batch ACK, with ACK skipped on processing failure so the message is redelivered [V `lib/oauth/pubsub/google.js:200-295`]. A self-hosted box behind NAT can therefore receive Gmail push. It needs a GCP project and a service account with Pub/Sub rights. Watches are checked hourly and renewed when less than a day remains. A **10-minute fallback poll** runs from the stored cursor if no notification has arrived [V `gmail-client.js:105-109,2152-2186`].

**Graph push needs a public HTTPS URL.** Subscriptions are delivered to the instance's `serviceUrl` and renewed on a 3-day schedule. A 10-minute "missed-notification recovery" listing runs because Graph drops notifications silently. Folder structure uses `mailFolders/delta`. `$batch` items that return 429 or 5xx are retried using the largest Retry-After in the batch [V `outlook-client.js:3280-3330,3862-3912`; `outlook/graph-api.js:247-291`].

**Retry policy: one layer only** (`lib/email-client/api-retry.js`) [V]:
- At most 3 retries, 1 s base doubling, 0-500 ms jitter.
- Each wait is capped at 5 s (Retry-After is capped too), and all waits for one request together at 8 s, so the request stays inside the 10 s RPC timeout.
- A read that hits 5xx is retried once. A write that hits 5xx or a socket error is **never** re-sent.
- Throttling is detected by Google's `reason` (`rateLimitExceeded`, `userRateLimitExceeded`) or by HTTP 429. `quotaExceeded` is not retried.
- The module header says that two retry layers once turned one throttled call into up to 24 requests.
- There is **no per-account token bucket** [I: none found]. EmailEngine mostly serves small interactive calls and incremental history, never a 500-thread bulk download.

**Offline outbox and conflicts.** As a server, EmailEngine has no offline client state, so conflict resolution is simply "the provider is authoritative." The outbox is covered in 3f.

### 3d. Local storage

**Engine:** Redis 6.2+ only (Cluster and ElastiCache are not supported). It needs latency under 5 ms because sync issues a Redis command per message. Lua scripts in `lib/lua/` provide atomic index operations (`z-set`, `z-expunge`, `h-set-bigger` and others).

**Main keys** [V, from code]:

| Key | Type | Contents |
|---|---|---|
| `iad:<account>` (account hash) | hash | config, encrypted credentials, `state`, `googleHistoryId`, Graph delta URLs, counters |
| `iam:<account>:l:<folder>` | sorted set | full-indexer message index (score = UID) |
| mailbox status key | hash | UIDVALIDITY, UIDNEXT, count, HIGHESTMODSEQ, last full sync |
| `iam:<account>:n:<folder>` | sorted set | arrivals queue awaiting "new message" processing |
| `iam:<account>:g` | list | per-account log ring buffer, downloadable via `GET /v1/logs/{account}` |
| `iar:s:<account>` | HyperLogLog | seen-message estimate |
| `iaq:<account>` / `iaqf` | hash | outbound message bodies / retained failed bodies |
| `oapp:*` | hashes/sets | OAuth apps, email→account mapping for Pub/Sub routing |
| BullMQ keys | | submit, notify, export queues |

**What it doesn't store:** bodies and attachments, except outbound mail and webhook payloads in flight. It has no search index, since search is delegated to IMAP SEARCH and Gmail/Graph query syntax, and no thread table.

**Migrations:** none in the SQL sense. Schema-less Redis values are versioned by tolerant readers, with one-off startup backfills such as `lib/account/auth-failure-backfill.js`. Cache eviction is forbidden rather than managed.

**The Document Store episode** [V `CHANGELOG.md:263,769,986`; commits `8790f75`, `56df159`, `f4ddd90`]. Until 2026, EmailEngine could mirror mail into Elasticsearch. That powered unified search, threading for plain IMAP, "chat with your emails" and embeddings. It was gated off by default on 2026-06-13 and **deleted entirely in 2.82.0 on 2026-10-01**, together with embeddings generation. No public rationale was found. [I] The likely reasons are that keeping a second, synced content store correct (threading, deletions, re-indexing, ES operations) cost more than it earned for a gateway product. **For Aplos, whose product *is* the local content store, this is a warning about where the engineering cost concentrates, not a reason to avoid it.**

### 3e. API between consumers and engine

- **Transport.** HTTP REST with JSON, 103 `/v1` routes [V `test/api-routes-table-test.js`]. The OpenAPI document is generated from the Joi validators (`lib/openapi/`) and pinned by a golden-file test.
- **Shape.** It is resource-oriented and account-scoped: `/v1/account/{account}/messages`, `/message/{id}`, `/search`, `/mailboxes`, `/submit`, `/outbox`, `/text/{textId}`, `/attachment/{id}`. Message IDs and attachment IDs are opaque base64url packings of folder and UID, plus MIME part (`mailbox.js:2029-2105`). The client never builds them.
- **Pagination.** An opaque page cursor (`nextPageCursor`/`prevPageCursor`) is page-number based for IMAP and wraps Gmail `pageToken` [V `mailbox.js:3355-3391`; `gmail-client.js:149-280`].
- **Auth.** Bearer tokens (hashed at rest) with scopes and per-route permission groups, optionally bound to one account [V `lib/api-routes/permission-map.js`].
- **Realtime.** Webhooks (HTTP POST, queued, retried) carry *message* events. `GET /v1/changes` is an SSE stream of **account state** changes only (`state`, `syncWarning` and similar), with 90 s keep-alives. Clients that stop reading are dropped at 2 MB buffered [V `lib/response-stream.js:18-30`; `tools.js:2033`]. **There is no resumable message-level change feed for a UI client.** The design assumes a backend that receives webhooks and keeps its own database.
- **MCP.** `POST /mcp` exposes REST routes as MCP tools by re-dispatching through the HTTP stack with the caller's own token, so every REST permission check still applies [V `CLAUDE.md` "MCP endpoint"].

### 3f. Send pipeline, drafts, threading, labels, calendar, AI

**Send** [V `base-client.js:2702-2800`; `workers.md` "Submit Worker"]:
- A submit builds raw RFC 822 and writes the content to the account's outbox hash. A BullMQ job that points to it is created in one step (`outbox.enqueue`).
- The queue ID is time-prefixed so jobs order by send time. `sendAt` makes it a delayed job, which is how **send-later** works.
- Defaults: 10 attempts, exponential backoff from 5 s with 20% jitter.
- **Permanence is decided by provenance.** Only a real SMTP reply code can mark a failure permanent (5xx except 503). HTTP-ish `statusCode` values from RPC timeouts or API passthroughs never do. This rule exists because a 504 RPC timeout once silently discarded good mail.
- Idempotency keys (24-48 h window) deduplicate submissions.
- After sending: IMAP accounts upload to Sent (Gmail doesn't need this) and set `\Answered`/`$Forwarded` on the referenced message.
- Content for failed messages is retained, within count and size bounds, so a send can be retried from the queue browser.

**Drafts.**
- IMAP drafts are APPENDs to Drafts.
- On Gmail, an upload is `messages.insert` with the target label and an optional `threadId` [V `gmail-client.js:1552-1610`].
- Sending a stored draft verifies the DRAFT label, finds the draft resource ID by `rfc822msgid:` and uses `drafts.send` (`:1628-1680`).
- There is no draft *editing* sync, since this is a gateway.

**Threading.** It passes through provider thread IDs: Gmail `threadId`/`X-GM-THRID`, IMAP `THREADID` where offered, Graph `conversationId`. Generic IMAP gets no threads after the Document Store removal.

**Labels and folders.** There is one "mailbox path" model. Gmail system labels map to IMAP special-use flags (`\Inbox`, `\Sent`, `\Junk`, `\Trash`, `\Drafts`), and messages carry a `labels` array. A move on Gmail is a label change, and `batchModify` is capped at 1,000 IDs [V `gmail-client.js:44-80`].

**Calendar and contacts.** None. ICS attachments are parsed into webhook payloads.

**AI.** An optional OpenAI-compatible summary is generated **only for newly arrived INBOX mail**, in the main thread, with a 2-minute deadline [V `llm-pre-process.js:245-275`; `base-client.js:3190-3203`]:
- An operator-written code filter decides whether the model sees a message at all.
- Only the receiving provider's own `Authentication-Results` header is trusted, and it is passed to the model as an authenticity signal for phishing risk (`authenticationTrust`).
- If the summary fails, the error is recorded for the settings page and the message is still delivered without a summary.
- Embeddings and chat were removed.

**Email HTML.** It is converted server-side to "web-safe HTML" (`lib/web-safe-html.js`). Quoted history is folded into an unstyled `<details>` marker, and `cid:` images are embedded as data URIs. Style *attributes* survive because sanitized mail arrives with inlined CSS. The admin CSP allows `style-src-attr 'unsafe-inline'` for exactly that reason [V `CLAUDE.md` "Security headers"].

---

## 4. Engineering quality

**Tests** [V `.claude/rules/testing.md`, `.github/workflows/test.yml`]:
- Uses the built-in `node:test` runner.
- **Unit tier:** Redis db 13, parallel.
- **Integration tier:** boots a real server and talks to *live* Gmail and Graph using secrets from `.env`. Sections are skipped with a stated reason when secrets are absent.
- **Hermetic Dovecot tier:** a real IMAP4rev2 server in Docker, run in CI.
- **Playwright E2E** on the admin UI.
- **Mutation testing** on pure decision modules: adaptive IDLE, lock wrapper, tracking flags.
- **Golden files** for the route table, OpenAPI and the MCP tool manifest.
- **Source-scanning "guardrail" tests**, for example: no `new ImapFlow(` outside the factory, no bare `===` between folder paths, every `/v1` route declares token auth, and every documented environment variable is actually read.
- A stall-watchdog reporter names a test file that blocks its event loop.

**CI matrix:** Node 20.19 and 24, Redis 7 and Valkey 8, a require(ESM) leg, a macOS job, a Windows binary build, and Claude code review.

**Organization.** Logic buried in classes is pulled out into small pure modules so it can be tested (`listing-diff.js`, `stale-view.js`, `adaptive-idle.js`, `delivery-error.js`). Comments are long and explain *why*, often naming the incident. That is the same strength Aplos has, in a formatted code style: Prettier and ESLint are enforced.

**Observability:**
- Pino structured logs with redaction configured on the root logger, so every worker inherits it.
- Sentry for real bugs, with network errors filtered out.
- Prometheus `/metrics`: connection states, API calls, AI tokens, queue counts.
- Per-account logs in Redis that you can download.
- Worker heartbeats with event-loop-delay and heap diagnostics.
- An in-house queue browser.

**Weak spots:**
- Custom webhook JS runs in Node `vm`, which the docs admit is not a sandbox.
- Huge files (`outlook-client.js` is 5K lines; `base-client.js` and `server.js` are each about 4K).
- The bus factor is one person.

---

## 5. UI notes

The only UI is an **admin console**:
- Server-rendered Handlebars, Tailwind v4 and FlyonUI. There is no SPA framework and no jQuery.
- Nonce-based CSP. Live state badges are fed by the SSE change feed through a `ee:change` DOM event [V `.claude/rules/admin-ui.md:10-30`].
- Public pages are deliberately framework-free so operators can restyle them.
- The message browser is a bundled widget (`@postalsys/ee-client`).

There are no motion constants, no mail-reading keyboard model and nothing for Aplos's UI workstream to borrow.

---

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **Count a message as "new" only after it arrives, never because it was backfilled.** EmailEngine records a first sync or a recovered index as a silent baseline. Enrichment and notification run only for arrivals after that point, through a durable arrivals queue: peek, process, then remove. This directly fixes Aplos's `classifyIncoming` on first sync. First sync writes metadata only. AI enrichment becomes a separate, budgeted queue keyed by thread, so a crash leaves it resumable.
2. **Advance the cursor per unit of work, mark items in flight, and skip poison items.** For Gmail history (and for Aplos's first-sync pages), commit the cursor after each entry or page. Record an in-flight marker with an attempt count. After N failures, skip the item and show a visible warning. Defer single-message fetch failures to a retry list instead of rejecting the whole run. This is the opposite of Aplos's all-or-nothing `Promise.all` in `freshWindow`.
3. **Use exactly one retry layer, keep the budget small, and never re-send writes.** Allow 3 attempts with jitter, cap any single wait and the total wait, honour Retry-After within the cap, and detect throttling by Google's `reason`. Retry reads once on 5xx. Never retry a POST after a socket error or 5xx, because Aplos's `findSent` reconciliation exists precisely for that case. Remove the per-worker retries plus gate backoff stacking in `google.ts`. Add the token bucket EmailEngine doesn't need but a bulk-downloading client does.
4. **Split "credential refused" from "token service having a bad minute."** 408, 429, 5xx and network errors are transient. A 4xx is a refusal. `invalid_grant` becomes a stored, human-readable "Reconnect" state. Record the granted `scope` on every token response, save rotated refresh tokens, and make the token write compare-and-set against the refresh token that was used. Park an account after repeated refusals instead of retrying forever.
5. **Treat a cursor reset as a first-class event.** EmailEngine emits `mailboxReset` and rebuilds silently on UIDVALIDITY change or a lost index. Aplos must stop ignoring `reset:true` and reconcile its window.
6. **Run IMAP the imapflow author's way.** Specifically:
   - Build every client in one factory: cap line, literal and response sizes, force STARTTLS, upgrade from 2.4.3 to 2.9.x. Releases since 2.5.1 bound hostile-server buffering, and 2.6-2.9 fix `fetch()` returning nothing without a selected mailbox, `search()` result parsing, and IDLE lifecycle.
   - Keep a **long-lived primary connection on INBOX with auto-IDLE**. Aplos currently sets `disableAutoIdle: true` and closes after 60 s idle.
   - Use a **separate command connection** for user actions so a long sync never blocks archive or send. Aplos's single serialized connection does block them today.
   - Release mailbox locks in `finally` and return to INBOX afterwards.
   - Apply a per-host `maxIdleTime` table (Yahoo 3 min) and use `closedByClient`/`idlingAtClose` to learn IDLE timeouts.
   - Gate reconnect backoff on how long the connection survived.
   - Never swallow the `error` event silently. Aplos's `client.on('error',()=>{})` should at least log.
   - Use the `exists`/`flags`/`expunge` events to trigger CONDSTORE partial syncs instead of polling.
7. **Use EmailEngine's per-folder sync decision tree as the IMAP incremental algorithm:** skip, CHANGEDSINCE, append-only and full-compare in chunks. Aplos already has CONDSTORE. Add the append-only shortcut and the "full sync at most every 30 min" guard.
8. **Build observability in from day one.** Use pino-style structured JSON logs with redaction on the *root* logger, a per-account log ring buffer that the UI can export ("Copy diagnostics"), and per-account state (`connecting`/`syncing`/`connected`/`authenticationError`/`connectError` plus the last error text) streamed to the UI. Add a heartbeat or watchdog for the engine process.
9. **Decide whether a failure is permanent from where it came from.** Only a real SMTP reply or a specific provider error can discard an outbound message. Generic status codes from Aplos's own RPC or timeouts must mean "retry or unknown."
10. **Sanitize HTML in the engine, not in the renderer.** Fold quoted history into a marker, embed `cid:` images, keep inline style attributes, and let the UI render the result in a sandboxed iframe. The desktop and a future phone then get identical, safe HTML.
11. **Pass the AI only the receiving provider's own `Authentication-Results`, and run a code gate before AI reads mail.** Together these give a deterministic "is this sender who they claim to be" signal for Home ordering and a phishing badge.
12. **Pin contracts with guardrail tests.** Use one IPC/API method table and a test that scans for drift (Aplos's allowlist is copied in three places), golden-file the API schema, and add a hermetic Dovecot tier for IMAP plus a Stalwart or Cyrus tier for JMAP.

### Avoid

- **Don't copy the gateway's "no local store" model for reading.** EmailEngine's listing is a live provider call. Aplos needs offline use, instant search and AI, so it must own a local store. Take the *sync* discipline, not the *storage* stance.
- **Don't adopt Redis or BullMQ for a desktop app.** SQLite (WAL) with job tables gives the same durability (outbox, arrivals, enrichment and ops queues) without a second daemon.
- **Don't build Gmail Pub/Sub into the consumer app.** Pull needs a service-account credential on every Mac, and all users would share one topic. Leaking that credential exposes notification metadata for every user. Keep cheap `history.list` polling, which costs 2 quota units per call, and consider BYO-GCP Pub/Sub only as a power-user option.
- **Don't run user-authored filter or rule code in `vm`** if Aplos ever adds scriptable rules. Use a declarative rule language.
- **Don't let AI summaries block delivery or sync.** Even EmailEngine runs them inline (bounded at 2 min). Aplos should go further and use an asynchronous queue.
- **Don't build a mirrored full-text or embedding store as a side feature.** The Document Store's removal shows how much it costs. If Aplos builds one, it is core and needs owned migrations, eviction and reconciliation.

---

## 7. "Local server" translation: Aplos as a daemon on the Mac

### Mapping EmailEngine's parts to an Aplos daemon

| EmailEngine | Aplos local equivalent |
|---|---|
| Main thread supervisor, account assignment, heartbeats | A daemon process supervising one long-lived **AccountRunner** per account. A single event loop is enough for 1-10 accounts. Put CPU-heavy work (MIME parsing, HTML sanitizing, FTS indexing) on one `worker_thread`. |
| Per-account client classes with a state machine | Today's adapters (`google.ts`, `microsoft.ts`, `imap.ts`, `jmap.ts`, `caldav.ts`) become stateful runners with the states in §6 item 4, park and resume, and a per-account log. |
| Redis index, plus BullMQ | SQLite: normalized `messages`, `threads`, `labels`, `bodies` (lazy, evictable) and FTS5, plus tables for `jobs` (outbox with `run_at` for send-later, enrichment, ops) and an **append-only `changes(rev, entity, id, op)` log**. |
| Webhooks | An internal event bus feeding deterministic local rules, notifications, and the change log. Outbound webhooks to `localhost` tools could be an opt-in extra. |
| `/v1` REST plus `/v1/changes` SSE | The same RPC methods Aplos has now, exposed as a typed HTTP API on `127.0.0.1`. Use **JMAP-style state tokens**: every list or query returns `state`, `GET /changes?since=` returns created, updated and destroyed IDs or `cannotCalculateChanges`, and an SSE or WebSocket stream pushes "state advanced" pings. |
| Hashed bearer tokens with scopes | Per-client tokens: Electron UI full access, phone paired with read/triage/send, an MCP agent with read and propose-only. Keep Aplos's Host and Origin checks from `server.ts`. |
| `/mcp` routed through the REST stack with the caller's token | A local MCP endpoint that reuses the same routes, so Claude Desktop or other agents get Ask-like read tools behind the same authorization. Optional, later. |

Aplos is closer to this than it looks:
- `apps/desktop/src/main/server.ts` already serves `POST /api/invoke` and SSE `/api/events` on `127.0.0.1:4317` with Host and Origin checks.
- `src/engine/` is already platform-free behind ports.
- Change events already carry `{epoch, rev}` (`src/shared/live.ts`).

What's missing is (a) a **durable, resumable** change log instead of in-memory diffs, (b) **paged queries from SQLite** instead of the whole mailbox in memory, (c) **auth tokens** and (d) a lifecycle that doesn't depend on a window being open.

### Hosting options, from cheapest to most capable

1. **Engine stays an Electron `utilityProcess` but listens on loopback** with a token (1-1.5 weeks).
   - The UI switches from IPC to the HTTP client, or keeps IPC with the same typed contract.
   - The app keeps running as a menu-bar or login item (Aplos already has `system.login`), so IDLE, JMAP push, send-later and reminders work while windows are closed.
   - Keychain access through `safeStorage` stays unchanged. This is the recommended first step.
2. **A separate headless daemon** registered as a LaunchAgent through `SMAppService` and bundled inside the `.app` (3-5 weeks).
   - It survives UI crashes and quits, and the UI becomes a pure client.
   - Costs:
     - It needs its own signed and notarized binary with the same Team ID.
     - Electron's `safeStorage` is unavailable outside Electron. Either use a small Swift Keychain helper (Aplos already ships `native/symbols.swift`) or run the daemon as an Electron helper app.
     - Version skew between UI and daemon during auto-update.
     - Schema migrations while a client is connected.
   - EmailEngine's "pure JS, no native addons" rule shows the packaging pain that comes with a standalone binary. Aplos relies on `node:sqlite`, which is built into Node, so the daemon needs a Node runtime of the same version.
3. **Phone access** (4-8+ weeks on top of 1 or 2, excluding the mobile app itself).
   - On the LAN or tailnet: bind to the Tailscale interface or LAN with TLS (a self-signed cert pinned at pairing) and a QR-code pairing that issues a scoped token.
   - Off-network: a relay. Options are a Tailscale or Cloudflare tunnel, or an Aplos relay that only forwards end-to-end-encrypted frames.
   - The phone renders from the daemon's API (sanitized HTML, AI results, workflow state) and needs no provider credentials, which removes the per-device sync and AI duplication noted in prior research.

### Pros

- One engine and one API contract for desktop, phone and agents. This fixes the triple allowlist and makes HTTP-level Playwright and contract tests natural.
- Push while the UI is closed. IMAP IDLE and JMAP EventSource need no cloud, and Gmail `history.list` and Graph delta polling can run more often because they are cheap.
- Durable job tables give send-later, snooze wake-ups and reminders with no hosted server.
- The memory fix (paged SQLite queries, lazy bodies) is a *prerequisite* for any remote client, so the revamp's data-layer work pays twice.
- Privacy stays intact. Mail never leaves the Mac except to the provider and the chosen LLM.

### Cons and limits

- **A sleeping Mac is still a hard ceiling.** No local daemon matches Inbox Zero's always-on automation. Provider-side filters (Gmail `settings.filters`, Graph `messageRules`, Sieve) remain the only automation that runs around the clock.
- **Graph webhooks and Gmail Pub/Sub push need public infrastructure.** The daemon polls those providers (EmailEngine itself polls as a fallback every 10 minutes).
- A localhost server is reachable by any local process, so tokens, Host and Origin checks, and narrow scopes are mandatory. Exposing it to a phone adds TLS, pairing, token revocation and relay security work that Aplos doesn't have today.
- Lifecycle complexity: launchd registration, update ordering, crash loops (keep Aplos's 3-exits-in-60-s guard), and diagnosing a process with no window.
- Battery and network cost from persistent connections. Mitigate with one primary IDLE per account (EmailEngine's model) and no extra subconnections by default.

### Recommended sequence

1. **Data layer:** normalized SQLite, lazy bodies, a durable change log with `state` tokens, and paged queries.
2. **Sync rework** using §6 items 1-7, with metadata-first Gmail backfill under a token bucket.
3. **Typed loopback API with tokens.** Electron consumes it, and the engine stays in the `utilityProcess` and keeps running as a login item.
4. **IMAP auto-IDLE with a command connection, and JMAP push.**
5. Only then **a separate LaunchAgent** if crash isolation or UI-less operation proves necessary.
6. **Phone pairing over the tailnet or LAN**, and a relay later.

Steps 1-4 are about 5-8 weeks for one developer with agents, and most of that is work the known problems already require.
