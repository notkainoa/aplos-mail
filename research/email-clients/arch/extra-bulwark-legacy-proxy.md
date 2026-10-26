# Bulwark legacy-proxy: architecture audit for the Aplos revamp

2026-10-25. This is a read-only review of `bulwarkmail/legacy-proxy` at commit `3858a71` (2026-10-15, "fix(gmail): send under a fresh Message-ID…"), shallow-cloned to `/Users/knewton/.t3/aplos-research/src/bulwark-legacy-proxy`. No code was installed, built or run. Paths are relative to that clone unless they start with `apps/desktop/`, which means the Aplos repo. As the brief asked, this is a lighter audit that concentrates on §3, §6 and §7.

**License warning.** The repo is AGPL-3.0-only (`LICENSE`, `package.json` `"license": "AGPL-3.0-only"`). Aplos may borrow ideas from it but no code. The companion `bulwarkmail/webmail` repo shows as `NOASSERTION` in the GitHub API, so its license should be treated as unverified until someone reads its LICENSE file.

---

## 1. Overview

- **What it is.** A single Node 22 / Fastify service that presents a JMAP for Mail server (RFC 8620/8621) to clients. Behind that it uses IMAP (imapflow), SMTP (nodemailer), ManageSieve and CardDAV. Mail stays on the upstream server; the proxy translates each JMAP method into upstream operations (README "About").
- **A second, opt-in backend** talks to the Gmail REST API instead of IMAP (`src/gmail/*`, about 5,000 lines). Despite the repo's name, this is the most useful part for Aplos.
- **Maturity.** Version 0.2.0, labelled "Pre-1.0 … no third-party security audit" (README header). GitHub stats: 27 stars, 12 forks, created 2026-04-29, last push 2026-10-15. Contributors by commits: rathlinus 78, lucamzanon 34, marcfischer 13, plus two with one commit each (`gh api …/contributors`). Seven PRs are open. Three of them (#35, #36, #37, opened 2026-10-19 and still unmerged) fix real correctness and security bugs, covered in §6.
- **Target user.** Someone who self-hosts Bulwark webmail and wants it in front of any IMAP provider. It ships as a Docker image (`.github/workflows/docker.yml`) and is meant to run behind a TLS reverse proxy (README "TLS").

## 2. Feature inventory (condensed)

| Area | State | Evidence |
|---|---|---|
| JMAP core: result references, call limits, capability gating | Solid | `src/jmap/router.ts`, `src/jmap/refs.ts` |
| Mailbox, Email, Thread, Identity, EmailSubmission over IMAP | Works. 43 known compliance failures are allow-listed | `test/compliance/known-failures.txt` |
| `*/changes` | Only partly real (in-memory log, details in §3c) | `src/state/store.ts:244-283` |
| Push: EventSource plus RFC 8620 PushSubscription; IMAP IDLE | Works, with gaps | `src/push/*`, `src/jmap/eventsource.ts` |
| Vacation over ManageSieve; contacts over CardDAV↔JSContact | Works | `src/sieve/*`, `src/carddav/*` |
| Gmail API backend: OAuth, cache-through reads, history sync, label writes, native drafts, `drafts.send`, aliases, scheduled send, Pub/Sub push | Behind feature flags, described as "experimental", well unit-tested | `src/gmail/*`, README "Experimental Gmail API connection" |
| Gmail over IMAP: draft and sent collision fix | Merged, but not live-tested according to PR #29 | `src/jmap/methods/submission.ts:152-165,342` |
| WebSocket transport, calendar, AI, local full-text search | Not present | README "Not implemented" |

## 3. Architecture deep dive

### 3a. Process and deployment topology

There is one process (`src/server.ts`) containing:
- the Fastify HTTP front (`/jmap`, `/jmap/session`, `/jmap/eventsource`, `/jmap/download|upload`, `/api/login`, `/healthz`, and the Gmail OAuth and Pub/Sub routes);
- an IMAP connection pool;
- a per-account IDLE manager;
- a push dispatcher;
- the Gmail backend, with its own store and pacer.

State lives in two SQLite files under `DATA_DIR`: `proxy.db` for the IMAP side and `gmail.sqlite3` for the Gmail side (`src/state/store.ts`, `src/gmail/store.ts:44-50`).

There are no worker processes. Background work runs on timers inside the process:
- IDLE refresh, every 25 minutes;
- Gmail watch renewal, checked hourly and renewed after 24 hours;
- a scheduled-send worker that ticks every 5 seconds;
- a 5-minute safety resync for Gmail accounts that have an open EventSource stream (`src/gmail/push.ts:9-12`).

Two external pieces complete the picture:
- Google Cloud Pub/Sub, which POSTs to `/gmail/push`;
- the "Bulwark relay", which receives `StateChange` POSTs and forwards them to Web Push or FCM for clients that are offline. The proxy does not encrypt Web Push payloads itself; the relay re-encrypts them with its own VAPID key (README "Not implemented").

The most important point about the design is that **this is a gateway, not a sync engine.** The IMAP side keeps no mirror of mailbox contents. Every `Email/query` turns into a live `UID SEARCH`, and every `Email/get` turns into a live FETCH, backed by caches of immutable data. The Gmail side works the same way: a "cache-through" reader that never downloads the whole account (README "Incremental sync and recovery": "there is no full-account body download").

### 3b. Connectivity per provider: auth and token storage

**Generic IMAP, SMTP, Sieve and CardDAV.**
- Login mechanisms are PLAIN, LOGIN or XOAUTH2 (`providers.example.json`).
- XOAUTH2 means the caller brings its own access token. `src/imap/client.ts:13-15` and `src/smtp/submit.ts:27-28` pass `accessToken` through, but nothing on the IMAP side refreshes it. I infer that an IMAP OAuth session breaks once the token expires, which is about an hour for Google.
- The README recommends a Gmail App Password over IMAP as the default way to connect Gmail.
- Providers are chosen by an explicit key or by the email domain (`src/auth/providers.ts`). This is a server-side form of autodiscovery.

**Gmail API backend** (`src/gmail/connection.ts`, `src/gmail/routes.ts`):
- Web-application OAuth with PKCE S256 and a single-use `state` that expires in 10 minutes, bound to the browser by an HttpOnly cookie.
- Requests `gmail.readonly` by default, or `gmail.modify` when writes are enabled.
- **It checks the scopes that were actually granted** when it exchanges the code (`connection.ts:123-131`). It also **refuses a grant that came without a refresh token** (`connection.ts:107`).
- Token refresh is coalesced, and a rotated refresh token is written back to storage (`src/gmail/api.ts:213-239`).
- 401 and `invalid_grant` errors become a sanitised "reconnect" message, and library errors are scrubbed so Authorization headers never leak (`api.ts`, function `sanitize` at the end of the file).
- An allowlist (`GMAIL_ALLOWED_EMAILS`) is checked against the profile Google returns, not against anything the user typed.
- The bridge can also act as its own OAuth authorization server for mail clients. It issues `gmat_`/`gmrt_` tokens and stores only their SHA-256 hashes (README "Sign in with Google from a mail client").

**Encryption at rest.**
- Credentials are sealed with AES-256-GCM in a `[12-byte nonce | 16-byte tag | ciphertext]` layout (`src/auth/credentials.ts`). There is no associated data, so a sealed blob is not bound to the account that owns it.
- One `VAULT_KEY` is read from `.env`.
- Front-end session tokens are HMAC-SHA-256 signed JSON with a 7-day lifetime and no revocation list (`src/auth/session.ts:42`).
- Gmail cache rows are sealed with the same key (`src/gmail/store.ts:363,388`). The README still says that cache is "plaintext", so it is out of date.
- The IMAP-side `email_cache` and `blob_cache` are plaintext.

### 3c. Sync algorithm

**IMAP side: no mirror, and only weak change tracking.**
- **No CONDSTORE `CHANGEDSINCE` and no QRESYNC.** A grep for either returns nothing. `HIGHESTMODSEQ` from STATUS is used only as a cache-validity key (`src/jmap/methods/email.ts:513-518`).
- **The thread index** is the clever part (`src/jmap/methods/threads.ts:1-9`). Each folder's last `(uidvalidity, uidnext, messages)` triple is stored in `mailbox_scan`. A rebuild does one LIST/STATUS and then SELECTs only the folders whose triple moved, fetching thread headers only for new UIDs. Threading metadata goes into `email_cache`, keyed by `(mailbox, uidvalidity, uid)`, which never changes, so the full header scan happens "exactly once per account lifetime". Flags are deliberately not cached because they change.
- **JMAP state** is a monotonic counter per `(account, kind)` in `state_log`. The `created/updated/destroyed` change log lives **only in memory**: 1,024 entries per kind, and it is lost on restart (`store.ts:232-283`). If the log can't cover the gap, the answer is `cannotCalculateChanges` and the client reloads.
- **Push.** One dedicated IDLE socket per account watches **INBOX only**, separate from the request pool. It starts **only for accounts that have a verified Web Push subscription** (`store.ts:487-495`, `src/push/idle.ts:52-68`). Clients that only listen on EventSource never get IMAP IDLE.
  - `EXISTS` growth bumps `EmailDelivery`, `Email` and `Mailbox`. `EXPUNGE` bumps `Email` and `Mailbox`. FLAGS bumps `Email`.
  - Reconnects back off from 1 s up to 60 s, and IDLE is refreshed with a NOOP every 25 minutes (`idle.ts:27-32`).
- **A verified bug, fixed only in open PR #35.** IDLE calls `bumpState`, which moves the state without writing any log entries. If the log still holds older entries (sending one email is enough), `Email/changes` answers with the new state and **an empty diff**, so a delta-syncing client never sees the new mail. I confirmed this by reading `idle.ts:131-151` against `_shared.ts` `changesFromLog`. PR #35's author hit it in production after Bulwark webmail 1.15 switched to `Email/changes`.
- **A second bug, in PR #36.** A pooled connection that already had a folder selected ran `UID SEARCH` without a NOOP, saw a stale message list, and cached it for 30 s.

**Gmail side: history-driven cache invalidation** (`src/gmail/history.ts`, `src/gmail/mail.ts`):
- **The JMAP state is the provider cursor.** Email state is `g<historyId>` plus `r<localRevision>` (`mail.ts:378-382`). `Email/changes` replays `users.history.list` starting from the client's own historyId and folds the records into created/updated/destroyed (`mail.ts:1254-1306`, `history.ts` `emailDelta`). No local change log is needed for Gmail.
- **History is read completely before the cursor moves.** All pages are read before the new cursor is published, with limits of 100 pages and 50,000 records. A repeated page token, or going over a limit, gives `cannotCalculateChanges`. A history 404 gives `cannotCalculateChanges` plus a full cache invalidation (`history.ts:20-67`, `mail.ts:290-345`).
- **The cursor only moves forward.** A stale profile response cannot move it back (`mail.ts:298-305`, and the `BigInt` check at `store.ts:301`).
- **Invalidation is targeted.** A checkpoint bumps a per-account `revision`, deletes cached list and query pages, and deletes only the message and thread entries that history touched. Unchanged bodies and attachment bytes stay cached (`store.ts:292-322`).
- **No stale write-backs.** A read that began before a revision bump is not allowed to repopulate the cache, and identical in-flight reads are deduplicated, up to 100 per account (`mail.ts:264-288`). This plays the same role as Aplos's `StaleSync`.
- **Pacing and rate limits** (`src/gmail/api.ts`) are exactly the piece Aplos is missing:
  - A per-account pacer reserves time in proportion to Google's quota cost for each call, at 200 units/s against Google's 250 (`:23`, `:250`).
  - Up to 12 requests in flight, a waiting queue capped at 200 (`:26`, `:190`), and one shared `blockedUntil` cooldown that sibling requests respect.
  - It honours `Retry-After` and retries at most twice. Any delay over 10 s fails fast with "retry later" (`:373`).
  - `dailyLimitExceeded` and permission 403s are not retried (`:350-359`).
  - **Writes are never retried automatically.**
  - Reads go through Gmail's batch endpoint, up to 100 per request (`:29`, `:120-183`). If every part of a batch comes back 429 or 403, that counts as a rate limit and trips the cooldown (`:165`).
  - The README's "four concurrent requests, 4,800 units per minute" figure is out of date.
- **Push.** Pub/Sub notifications are authenticated (OIDC or a shared token), stored before they are acknowledged, and coalesced for 1.5 s per account into one incremental run. Watches are renewed daily. Accounts with open streams also get a 5-minute safety resync (`push.ts:9-12`, README "Push notifications").

**Offline outbox and conflicts.** There is no offline outbox, because it's a server. Gmail writes are serialised per account through an `exclusive` lock, with at most 20 objects per `set` and partial failures reported per ID (`mail.ts:1052-1060`). Writes whose outcome is ambiguous are reported to the user rather than retried.

### 3d. Local storage

Both databases use better-sqlite3 with WAL and `synchronous=NORMAL`, and memoise prepared statements (`store.ts:31-37,180-200`).

**`proxy.db` (IMAP)** has these tables:
- `account` (slug, kind, host, username, sealed `vault`)
- `mailbox` (name, parent, role, uidvalidity, highest_modseq, counts)
- `email_cache` (mailbox, uidvalidity, uid, thread_id, internaldate, envelope, bodystructure, raw headers, preview)
- `mailbox_scan`
- `state_log`
- `blob_cache`
- `upload`
- `identity_settings`
- `mailbox_sort_order`
- `push_subscription`

**`gmail.sqlite3`** has these tables:
- `gmail_connection` (sealed credentials and profile snapshot)
- `gmail_cursor`
- `gmail_revision`
- `gmail_cache` (sealed key/value with `expires`, `touched`, `size`)
- `gmail_draft` (original → current draft mapping)
- `gmail_submission` (send ledger)
- `gmail_schedule`
- `gmail_watch`
- `gmail_push`
- `gmail_push_sub`
- `gmail_token`
- `gmail_password`
- `gmail_upload`
- `gmail_mailbox_snapshot`

**Bodies and eviction.**
- The IMAP side caches downloaded parts of 2 MB or less, up to 256 MB in total, with a 7-day TTL. When over budget it evicts the oldest quarter (`server.ts:192-194`, `store.ts` `pruneBlobCache`).
- The Gmail cache holds up to 256 MiB of logical data per account. It evicts least-recently-used entries first, and updates `touched` at most once a minute to avoid a write on every read (`gmail/store.ts:43,372-420`).

**Other storage notes.**
- **Search.** There is no FTS. Search is delegated to IMAP SEARCH or to Gmail's `q`, and `SearchSnippet/get` returns null snippets.
- **Migrations.** These are ad hoc: `CREATE IF NOT EXISTS`, column checks with `PRAGMA table_info`, and dropping caches whose format changed (`gmail/store.ts:95-119`). There is no `user_version`.

### 3e. API between client and engine

- **Request shape.** JMAP over `POST /jmap`: an envelope of `[method, args, callId]` triples with back-references to earlier results.
- **Parallelism.** The dispatcher runs consecutive read-only calls that don't reference each other **in parallel**. Mutating calls act as barriers (`router.ts:72-90`). This lets a request that touches IMAP, CardDAV and Sieve pay the latency of the slowest backend rather than the sum of all three.
- **Realtime.** `GET /jmap/eventsource` takes `types`, `closeafter=state` and a clamped `ping`, and sends only state strings (`src/jmap/eventsource.ts`). The client then calls `*/changes`.
- **Pagination.** `position`, or `anchor` plus `anchorOffset` (`email.ts:41-67`). A `receivedAt` sort is answered from UID order without any per-message FETCH.
- **Blobs.** Downloads are streamed through a Transform that copies small parts into the cache on the way through. Uploads are kept for 24 h. Responses are compressed.
- **Security defaults** that Aplos should not copy:
  - CORS reflects any origin (`server.ts:65`), and the SSE hub sends `Access-Control-Allow-Credentials: true` for whatever origin asked (`eventsource.ts:41-45`).
  - It listens on `0.0.0.0` by default (`server.ts:491`).
  - Basic auth creates an account for any IMAP login that succeeds.

### 3f. Send, drafts, threading, labels, contacts

**Sending over IMAP and SMTP.**
- Submission goes through nodemailer, with Bcc removed from the MIME body.
- On Gmail it **resends under a fresh Message-ID and then deletes the draft** rather than filing it to Sent (`submission.ts:152-165,342`). The reason: Gmail keeps one message per Message-ID, so the copy in Sent merged with the draft and got stuck in Drafts (PR #29, issue #25). PR #29 states this has not been tested against a real Gmail account yet.

**Gmail API drafts and sending.**
- Drafts are native Gmail drafts. Editing a draft creates a replacement, and `gmail_draft` maps the original ID to the current one so the JMAP ID stays stable.
- `drafts.send` writes a durable intent first, keyed by a fingerprint of the submission (`compose.ts:521-560`):
  - A send that Google provably never received (a `GmailNotSent` error: 4xx, auth or rate limit, or a failure before dispatch) releases the intent, so the user can retry.
  - A timeout, reset or 5xx marks the send "uncertain". It is **never replayed**, even after a restart, and the user is told to check Sent.
- Scheduled send leases due rows. Before sending, it re-checks the identity, whether the draft still exists, and the draft's MIME hash. An entry that falls due after more than 900 s of downtime is *suspended* rather than sent late (README "Set `GMAIL_SCHEDULE_ENABLED`").

**Threading.**
- IMAP threads are computed from Message-ID, In-Reply-To and References headers.
- Gmail uses its native `threadId`. When composing a reply, the native thread ID is attached only if the parent's Message-ID and normalised subject both match (README).

**Labels and folders.**
- On IMAP an email lives in exactly one folder, and its **ID encodes `(mailbox, uidvalidity, uid)`, so moving it changes the ID** (`src/mapping/ids.ts`; listed in the compliance allowlist).
- On Gmail, labels become mailboxes and "All mail" takes the `archive` role.

**Other features.** Contacts use CardDAV with vCard 4.0 and keep properties they don't model. Vacation goes through Sieve. There is no calendar and no AI.

## 4. Engineering quality (brief)

**Tests.**
- 48 unit spec files with about 394 test cases (`test/unit`).
- An integration suite against Stalwart in Docker (`compose.test.yml`).
- The official `jmapio/jmap-test-suite` with an allowlist of known failures (`scripts/run-compliance.mjs`).
- **CI never runs the tests.** The only workflow builds multi-arch Docker images, and its only check is `tsc` inside the Dockerfile.

**Observability.**
- pino logging with field redaction (`src/util/log.ts`).
- `/healthz` counters for push and the scheduled-send queue.
- No metrics or crash reporting.
- `uncaughtException` and `unhandledRejection` are logged "and continuing" (`server.ts:515-518`), which can leave the process half-broken.

**Code and docs.** The comments are excellent and nearly every constant explains why it has its value. The README has drifted from the code in at least two places: the pacer limits and whether the cache is plaintext.

## 5. UI notes

There is no UI. A small Bulwark webmail plugin (`webmail-plugin/`) turns Gmail labels into tags and categories into tabs.

---

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **A pacer per account, weighted by quota cost, with one shared cooldown.** This is the direct fix for the first-sync 403s.
   - Reserve time in proportion to each call's unit cost, at about 200 units/s.
   - Cap requests in flight and cap the waiting queue.
   - Use one `blockedUntil` that every worker respects.
   - Fail fast when Retry-After is longer than about 10 s.
   - Never retry `dailyLimitExceeded`.

   Today Aplos runs four independent workers, each with its own retries (`apps/desktop/src/main/google.ts:110-133`), which is the anti-pattern this replaces.
2. **Use the Gmail batch endpoint for metadata reads,** and treat a batch where every part came back 429/403 as a rate limit, not 100 cache misses.
3. **Read history completely before committing the cursor.** Keep the cursor monotonic, cap the page count, and treat a 404 as "reset and reload what's being viewed".
4. **Load bodies lazily, invalidate caches by revision, and cache by keys that never change.** Bodies and parts keyed by Gmail message ID or IMAP `(uidvalidity, uid)` never go stale, so cache them with a size budget and evict them freely. This is how to lift Aplos's in-memory mailbox ceiling.
5. **Classify write failures as "provably not sent" or "uncertain",** and record a durable send intent before touching the network. Aplos already protects against duplicate sends. The extra lesson is to surface "uncertain" to the user rather than retry.
6. **Validate OAuth grants at exchange time.** Check the scopes actually granted, reject a grant with no refresh token, persist rotated refresh tokens, and turn 401/`invalid_grant` into a sanitised "Reconnect" state. These are all gaps in Aplos's audit.
7. **Sync Gmail drafts as native drafts,** with a mapping from the original ID to the current one so the UI's draft ID survives replacement. This closes the "drafts never reach Gmail" gap.
8. **A cheap "did this folder change" check for IMAP:** compare the `(uidvalidity, uidnext, messages)` triple across folders before selecting any of them. Aplos should still add QRESYNC where the server supports it.
9. **Separate IMAP connections by role:** one for interactive work, one for bulk work (first sync, downloads) and one for IDLE. Aplos's single serialised connection lets a first sync block archive and send.
10. **Coalesce push events** (about 1.5 s per account) and add a slow safety resync. For IDLE, back off reconnects from 1 s to 60 s and refresh before the server's 29-minute timeout.
11. **On Gmail over IMAP, send with a fresh Message-ID** so the copy in Sent doesn't merge with the draft. This idea isn't live-verified.
12. **Scheduled send that re-validates and suspends:** pin the approved draft by hash, and if the due time passes while the app is closed, suspend the send instead of sending late. This is exactly the right shape for Aplos's send-later on a Mac that sleeps.

### Avoid

1. **State moves that carry no diff** (PR #35). Aplos's `{epoch, rev}` protocol in `apps/desktop/src/shared/live.ts` relies on the same rule: every `rev` must carry its changes, or the receiver must be forced to resync. Add a test that breaks if any code path bumps `rev` without a diff.
2. **Stale views on pooled connections** (PR #36). On a reused IMAP connection that already has a folder selected, send a NOOP before `UID SEARCH`.
3. **A change log that lives only in memory.** If every restart answers `cannotCalculateChanges`, every client does a full reload after every restart. For a daemon that serves a phone, the change log must be persisted.
4. **IDLE that depends on having push subscribers, or watches only INBOX.** Aplos should run IDLE whenever the engine is running.
5. **IDs derived from folder plus UID.** They change on every move. Aplos should keep its own stable IDs.
6. **Network defaults built for a hosted service:** listening on `0.0.0.0`, reflecting CORS for any origin with credentials, Basic auth that creates accounts, and push URLs with no SSRF check (PR #37). Also avoid a single vault key read from `.env`. On a Mac, use the Keychain or safeStorage.
7. **Logging uncaught exceptions and carrying on.** Crash, record a report, and let the supervisor restart the process. Aplos's engine already restarts on crash, so keep that.
8. **Docs that drift from code, and CI that doesn't run tests.**
9. **Making JMAP compliance the goal.** The 43 allow-listed failures (multi-mailbox membership, Thread destroy, Sieve) show how much mismatch comes from forcing other models into strict JMAP.
10. **A pure pass-through design.** It suits webmail but not Aplos. Instant keyboard triage, offline work, local AI and FTS all need a local mirror. Copy the cache and sync discipline, not the gateway topology.

---

## 7. "Local server" translation: an Aplos engine as a daemon on the Mac

### How legacy-proxy's parts map to Aplos

| legacy-proxy | Aplos local daemon |
|---|---|
| Fastify `POST /jmap` with method envelopes | `POST /api` on `127.0.0.1` or a Unix socket, accepting `[method, args, callId]` batches with back-references. Types: `Account`, `Thread`, `Message`, `Label`, `Draft`, `Submission`, `Event`, `AiJob`. Verbs: `get/query/changes/set`. This replaces the method-name allowlist copied in three places with one typed contract. |
| `state_log` counters plus an in-memory log | A **persisted** `change_log(account, type, state, id, action)` table written in the same SQLite transaction as the mutation. One state string per type per account. Trim by age, and answer `cannotCalculateChanges` → snapshot only when trimmed. |
| Gmail state = `g<historyId>r<rev>` | Not directly applicable. Aplos merges several providers and owns workflow state (Done/Later), so its state should be **its own revision**, with each provider's cursor kept private to its adapter. The idea worth taking is "history fully read → one transaction → one state bump". |
| `/jmap/eventsource` with `types` and `closeafter` | `GET /events` streaming small `StateChange` frames (state strings only). The UI then calls `changes`. `closeafter=state` suits a phone that wakes briefly. |
| `/jmap/download` stream plus blob cache | `GET /blob/{id}` streamed from SQLite or the provider, which is also the route the sandboxed email-HTML iframe would use to load inline images. |
| `PushSubscription` plus relay | Pushing to a phone needs APNs, which needs a server-side key. That means a relay, like Bulwark's, which never sees content (payloads are just state strings). |
| IDLE manager, Gmail pacer, Pub/Sub | Sync workers inside the daemon: IDLE per IMAP account; a polling `history.list` for Gmail every 30–60 s through the pacer (no Pub/Sub, which needs a public endpoint); delta polling for Graph. |
| AES-GCM vault with an env key | Keychain-held key (or Electron `safeStorage` while it's still in-process). Per-device tokens for clients. |

### Hosting path, cheapest first

1. **Keep the `utilityProcess`, change the contract (about 1–1.5 weeks).** Add the typed method table, per-type states and a persisted change log. The renderer switches from whole-state snapshots to `query` pages plus `changes`. This fixes the problem of shipping the whole mailbox across two IPC hops and is useful whatever comes later.
2. **Add the HTTP and SSE transport (about 1 week).** Make the existing preview server (`apps/desktop/src/main/server.ts`) speak the same envelope.
   - Bind only to loopback or a Unix socket with 0600 permissions.
   - Require a per-launch bearer token handed to Electron at startup.
   - Keep the Host/Origin checks it already has, and never reflect CORS for arbitrary origins.
   - Electron can keep using a MessagePort for speed, but both transports use one contract, so browser preview tests the production code path.
3. **Promote the engine to a launchd agent (about 2–3 weeks).** This needs a single-writer lock on `aplos.db`, a version handshake (`/session` reports the API version and capabilities, as JMAP's Session resource does), a migration story for when the UI and daemon versions differ, crash logs and a supervisor. The gain: sync and IDLE keep running with every window closed, and notifications still arrive.
4. **Phone access (3–6+ weeks).** Pair with a QR code that exchanges device keys. Transport is either Tailscale/LAN with mutual TLS or an end-to-end encrypted relay. APNs needs a small relay. The phone client could be a thin JMAP-shaped client of the daemon.

### Pros

- One engine with one typed API serves the Electron UI, browser preview, tests and later a phone. JMAP gives proven semantics for `changes`, `queryChanges`, blobs and push, so Aplos doesn't have to invent them.
- Sync, IDLE and send-later keep running with the UI closed, as long as the Mac is awake.
- Paged queries plus `changes` replace whole-mailbox cloning across IPC, which helps the memory ceiling.
- A typed contract lets the team run contract tests against a fake engine, much as legacy-proxy runs jmap-test-suite.

### Cons and risks

- **The Mac still sleeps.** A daemon doesn't add automation that runs while you're away. Provider-side filters do (SYNTHESIS).
- **A localhost server is attack surface.** Other local processes, DNS rebinding, and browser CSRF all become concerns. legacy-proxy's own defaults (CORS reflection, `0.0.0.0`, SSRF in push) show how easily this goes wrong.
- **Getting `changes` right is subtle.** legacy-proxy shipped two delta bugs that only showed up once a client relied on `Email/changes` (PRs #35 and #36). Budget for property-based or replay tests.
- **A launchd daemon brings operational work:** updates, version skew, and orphaned processes holding the database lock.
- **AGPL.** Nothing can be reused as code.

**Recommendation.** Do the sync rework first (adopt items 1–4 and 6), because it's needed whatever the topology. Then do step 1 above (contract, persisted change log, paged API) inside the current process. Make the launchd or phone decision only after a real mailbox has synced cleanly. Adopt JMAP's *shape* without aiming for compliance: method envelopes, per-type states, `changes`, EventSource with state strings, and blob routes.

Open questions:
- Should a launchd agent be signed and installed through `SMAppService`?
- Is Tailscale an acceptable dependency for phone access?
- Should Aplos's existing `jmap.ts` adapter be tested against a self-hosted legacy-proxy in Docker as an IMAP fixture? It would run as a separate program over the network, so AGPL should not attach, but someone should confirm that before relying on it.
