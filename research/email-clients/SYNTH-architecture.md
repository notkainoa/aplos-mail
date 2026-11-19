# Email-client architecture: cross-project synthesis for the Aplos backend revamp

2026-10-25. Built from 18 architecture audits (`arch/*.md`), two protocol reports (`protocols/*.md`) and the earlier Inbox Zero research (`research/inbox-zero/*`). I re-read the key Aplos files at `72095ff`: `server.ts`, `shared/live.ts`, `engine/provider.ts`, `DECISIONS.md` (2026-10-15 and 10-16) and `MOBILE.md`. I also checked Google's Gmail quota page, last updated 2026-10-16.

**Evidence labels.** **[V]** means a sibling report verified the claim against code or official docs (the citation is given), or I checked it myself. **[I]** means inference. **[C]** means a project's own claim that nobody here has verified. Report paths below are relative to `research/email-clients/`.

**Licensing.** Ideas only; no code enters Aplos. Licenses range from MIT through GPL/AGPL to commercial (EmailEngine) and none at all (Superlocal); see §12.

---

## 0. The ten findings that should shape the plans

1. **The Gmail quota makes the current first sync impossible.** [V; I checked Google's page myself] Since 1 May 2026, new Cloud projects get **6,000 units per user per project per minute**. `threads.get` costs 40 units, or 120 with `format=full`. `messages.get` costs 20, or 60 when full or raw. `history.list` costs 2. Aplos's first sync is 500 full `threads.get` calls, about 60,000 units: ten minutes of budget, run 4 at a time and committed all-or-nothing. That explains the 403s. The earlier "about 5,000 units" estimate used the old prices. **Bodies must load lazily, and every caller must share one budget per account.** A future phone app on the same Cloud project would share the same 6,000 units.
2. **Every robust engine fetches metadata and bodies separately and commits page by page. Every engine that failed bulk-fetched full bodies in a single all-or-nothing pass.** Robust: Mailspring, Geary, Flectar/comail, Pimalaya, Mustang, Nylas. Failed: Aplos, Inbox Zero's live bootstrap, Velo, Zero's backfill. This is the most consistent pattern in the whole set.
3. **The desktop half of the "local server" idea is proven. The phone half is not.** On the desktop, Mailspring (about 8 years), Delta Chat (stdio, FFI and WS), Nylas Mail's `local-api` and Superlocal all run the engine as a server with the UI as a client. But **no studied project serves a phone from a desktop daemon.** Phones either embed the engine (Pimalaya, Flectar, Mustang, Delta Chat, probably Inbox Zero's iPhone app, and Aplos's own `MOBILE.md` plan) or talk to a hosted server (Redakt, Tuta, Inbox Zero). [V per project; I for "none"]
4. **About 6-10 weeks of foundation work is the same whatever the topology:** a durable change log, a normalized store with lazy bodies, a per-account governor, a typed contract, AI moved onto a job queue, HTML isolation and logging. Every report's local-server plan does this first [I, consensus]. So the choice of topology can wait until this foundation exists.
5. **The change log must persist, and every state bump must carry its diff.** Aplos's `epoch` resets on every engine run, so every window re-snapshots after a restart. Bulwark shipped a bug where IDLE bumped state without a diff, and clients missed new mail (`arch/extra-bulwark-legacy-proxy.md`, PR #35).
6. **Exactly one process may own provider I/O and quota.** Redakt documents its per-process gate as a weakness. The limits that punish uncoordinated clients: Gmail's quota is per user per project, Graph allows 4 concurrent requests per mailbox, and iCloud allows few connections.
7. **Push needs no server for IMAP and JMAP, and has no serverless option for Gmail, Graph or Google Calendar.** Polling Gmail `history.list` costs 2 units per call, so it is cheap (`protocols/proto-google.md` §5). A relay would only buy lower latency and phone wake-ups.
8. **A sleeping Mac is the ceiling for any local design.** Only provider-side rules (Gmail filters, Graph `messageRules`, Sieve) or a hosted component act while the lid is shut.
9. **Most clients retry daily quota as if it were a burst limit:** Aplos 0.2.3, Redakt, Flectar, Superlocal. Bulwark, EmailEngine and Neverest get it right: one retry layer, classification by reason (and, in Neverest, message text), and stop until the quota resets. Zero has the one-layer governor but no explicit daily-quota rule. Gmail's per-minute refusal can carry only `rateLimitExceeded`, so the reason field alone is not enough (`arch/pimalaya.md`).
10. **Local listeners are where projects most often fail on security.** Nylas uses the account ID as the credential and reflects CORS. Bulwark listens on `0.0.0.0`. Mustang exposes raw `fs`, sockets and SQL. Tuta sends raw SQL over IPC. Aplos's `server.ts` has no token. The good templates are Mailspring's and comail's MCP servers and Superlocal's loopback session (§10).

---

## 1. What Aplos already does better than most

So the revamp keeps them (all [V], `research/inbox-zero/aplos-architecture.md`):
- **An engine in its own `utilityProcess`, platform-free behind `src/engine/ports.ts`, with crash restarts.** Velo and Mustang sync in the UI; Tuta's SQL crosses four hops.
- **A durable per-account op queue written in the same transaction as the edit.** Geary's queue is memory-only; Mustang and Tuta have none.
- **Idempotent send** with a stable Message-ID, `sendAttemptAt` and `rfc822msgid:` reconciliation. comail, Velo, Nylas and Zero can double-send.
- **Staged provider memory committed with threads and cursor** (`memory-stage.ts`).
- **A Keychain-wrapped data key.** Velo and Superlocal keep the key beside the database, Mustang uses a constant, and Zero stores tokens in plaintext.
- **Already correct:** Graph immutable IDs, JMAP `/changes`, and `historyId` captured before listing.

---

## 2. Process topology: where the engine lives

| Topology | Who | What it buys | What it costs |
|---|---|---|---|
| **T1. Engine inside the UI process** | Velo, Mustang, Tuta (a worker per window) | Fastest path to features | Sync dies with the window; jank; SQLITE_BUSY (Velo #240). **Anti-pattern** |
| **T2. In-process library core with a resident app** | Geary (background mode), comail and Flectar (tray, single-instance lock), Tuta's main process (alarms and push only) | One process, no IPC cost; keeps syncing with no window open | UI and engine share a fate. No network API without extra work |
| **T3. Engine in its own local process; UI over IPC** | **Aplos** (`utilityProcess`), Inbox Zero desktop (`utilityProcess`), Mailspring (one C++ child per account over stdio), Delta Chat Desktop (`deltachat-rpc-server` over stdio) | Crash isolation; one writer; platform-free core | `utilityProcess` dies with Electron main. Mailspring shows the risks of process-per-account (`abort()` as error handling) and many SQLite writers |
| **T4. Local server with a network API** | Superlocal (REST+SSE on 127.0.0.1), Delta Chat browser target, Nylas Mail `local-api`, Mustang, Mailspring and comail MCP servers | Any client can use the engine | Attack surface, tokens, version skew |
| **T5. Several processes share one store file** | Pimalaya v2 (one owner plus read-only readers plus producers appending to a queue, through SQLite WAL and lock files) | Zero-copy reads; no protocol to design | Works on one host only. A phone can't open a WAL file [V `arch/pimalaya.md` §7] |
| **T6. Hosted server engine with thin clients** | Zero (Cloudflare Durable Object per mailbox), Redakt, Nylas sync-engine, EmailEngine (gateway), Bulwark (JMAP gateway), Tuta (server is the truth) | Always on; webhooks; one quota owner; trivial phone | Mail passes through a vendor; CASA; uptime; cost. Contradicts Aplos SPEC ("no Aplos server stores user data") |
| **T7. Replica engines on each device plus a thin cloud** | Inbox Zero (server as adapter, plus durable send and snooze), Nylas Mail (cloud workers for send-later and snooze), Delta Chat (relays plus push proxy) | Local speed plus always-on scheduled work | Two systems to run; Inbox Zero's server holds tokens |

**What the evidence says.**
- **Topology decides lifecycle and who can be a client, not sync quality.** Sync quality comes from the data model and the governor, which work the same in T2, T3 or T4. T2 and T4 apps keep running with no window (Geary's background service, comail/Flectar/Tuta tray). Aplos's engine dies when Electron quits.
- **The most relevant precedent is a lineage.** The Nylas team moved sync from their server (T6) onto the desktop behind a localhost API with the same shape (T4), keeping a cloud only for send-later, snooze and reminders (T7). Mailspring then replaced that JavaScript engine with a C++ child process (T3) (`arch/nylas-sync-engine.md` §1, `arch/mailspring.md` §1).
- **Mobile** [V per report]: Pimalaya embeds its Rust engine on Android. Flectar and Mustang run their whole core on the phone; Mustang needed nodejs-mobile and repackaged native modules. Delta Chat exposes an FFI. Redakt's iOS app is a thin client of its hosted server. Tuta phones are replicas of Tuta's server. Inbox Zero's iPhone app most likely runs the shared engine against its server. **Nobody has a phone talk to the user's Mac** [I: the Mac sleeps, iOS push needs a server-held APNs key, and LAN access needs pairing and TLS].

---

## 3. Provider connectivity

### 3.1 What each project uses

| Provider | Aplos | Others |
|---|---|---|
| **Gmail** | REST, `gmail.modify` + `settings.basic`, polled | **REST:** Zero, Redakt, Inbox Zero (all three with Pub/Sub), Superlocal, Flectar, Velo, Bulwark, EmailEngine. **IMAP + XOAUTH2:** Mailspring, Nylas, comail, Mustang, Geary. Delta Chat lost its Gmail OAuth client |
| **Outlook / M365** | Graph | **Graph:** Inbox Zero, EmailEngine (Superlocal and Zero have no working sign-in). **IMAP + XOAUTH2:** comail, Flectar, Mailspring, Geary, Velo |
| **iCloud** | IMAP, app password, no IDLE | Every IMAP client; Mailspring and Superlocal document the quirks |
| **Fastmail** | JMAP token, no push | Mustang, Flectar and Pimalaya use JMAP with EventSource |
| **CalDAV** | Full 13-month query every 10 min | Mailspring (ctag, then sync-token, then ETag), Flectar, comail |

### 3.2 Gmail

**[V] Facts** (`protocols/proto-google.md`):
- Quotas as in finding 1. Batch requests save round trips, not quota.
- Google recommends batches of 50 or fewer. Neverest measured refusal rates of 0% at batch size 10, 1.2% at 25 and 19% at 50 [C] (`arch/pimalaya.md`).
- `history.list` label records carry their own label IDs, so label deltas can be applied with no fetch.
- Pub/Sub can't be split per user from a desktop without a privileged credential, so it is not viable without a server.
- Both Aplos scopes are restricted. Plan for CASA, especially because mail goes to LLM servers.

**The scope decision is the one irreversible Gmail choice**, and it must be made *before* verification:

| Choice | Pros | Cons |
|---|---|---|
| (a) `gmail.modify` + `settings.basic`, REST only | No new permission screen; filters, drafts and labels are native | Quota-bound: a 10k-message header backfill costs about 200k units, roughly 45 min at 75% of budget |
| (b) Add `https://mail.google.com/` | IMAP for bulk headers and bodies (bandwidth limits only, no units) plus IDLE as a free "doorbell" | A second code path. The consent screen says "permanently delete all your email". Reviewers may object |

Both are restricted scopes, so verification cost is about the same [V]. Mailspring, Nylas, comail and Zero chose (b). The Google report recommends shipping (a) with a governor first.

### 3.3 Microsoft Graph

[V] (`protocols/proto-others.md` §1): 4 concurrent requests and 10,000 per 10 minutes per app and mailbox. An unordered `$batch` runs 4 sub-requests at once, and each can return its own 429. Delta is per folder. Query options are baked into the `deltaLink` [I: so Aplos's `receivedDateTime` filter probably hides older mail moved back into the Inbox]. Push needs a webhook, Event Hubs or Event Grid. One sign-in can mint tokens for both Graph and IMAP.

Aplos peaks at about 12 requests in flight, and one 429 fails the whole sync: the Gmail failure pattern again. Most native clients use IMAP+XOAUTH2 for Outlook *mail*; Aplos, Inbox Zero and EmailEngine use Graph. Graph remains the better choice: it gives delta, immutable IDs and `messageRules`, and Outlook IMAP reportedly lacks CONDSTORE [S].

### 3.4 IMAP (iCloud, Yahoo, generic)

**Consensus design** (Mailspring, EmailEngine, Mustang, comail/Flectar, Bulwark, Nylas, Zero):
- **Two or three connections, each with one job:** one IDLEs on INBOX, one runs a priority command queue (user actions and outbox first), and optionally one does bulk fetch. comail's six per account would risk iCloud's cap.
- **Re-issue IDLE every 5-25 min, tuned per host** (Yahoo about every 3 min). Gate reconnect backoff on how long the connection survived (EmailEngine).
- **Choose the incremental path from server capabilities:** QRESYNC, then CONDSTORE plus a bounded expunge check, then windowed flag scans. Skip unchanged folders with STATUS. EmailEngine's per-folder tree is the most complete: skip, append-only, CHANGEDSINCE, or a full compare at most every 30 min.
- **Fetch in tiers:** envelope plus BODYSTRUCTURE first, text parts later, attachments only when opened.
- **Respect RFC 9738 `MESSAGELIMIT`** (Yahoo advertises 1000). Never infer a deletion from a partial answer.
- **iCloud:** no QRESYNC (Mailspring disables it; the evidence dates from 2021), at most 2 connections, and append your own Sent copy.
- **imapflow:** upgrade from 2.4.3 to 2.9.x and stop swallowing its `error` event.

### 3.5 JMAP, CalDAV and cross-provider rules

- **JMAP:** push is free via `eventSourceUrl`. Mustang's loop is the model: a watchdog after two missed pings, a reconnect throttle, `Retry-After`, wait-for-online and reconnect-on-wake. Use `preview` for lists. Fastmail requires OAuth registration for apps given to others [V].
- **CalDAV:** home PROPFIND for ctag/sync-token, then `sync-collection` and `multiget`. Expand recurrences on the client. Never forward Basic credentials across origins (Aplos defect C3).
- **For every provider:**
  - Classify errors by the provider's reason. `invalid_grant` parks the account until the user reconnects (Flectar, Zero, EmailEngine). Token-endpoint 408/429/5xx are transient (EmailEngine). Keep the refresh token on network failures (Mustang). Check granted scopes at exchange (Bulwark, Redakt).
  - Store the refresh token and its issuing client ID as one Keychain bundle, and serialize refreshes per account (Flectar).
  - Declare capabilities per provider (Redakt, Superlocal). Read folder roles from the server, never from names (Pimalaya).

---

## 4. Sync algorithms

### 4.1 Initial sync: three families

| Family | Who | Verdict |
|---|---|---|
| **Bulk full bodies** | Aplos (500 full threads), Inbox Zero's live path (whole mailbox, 50-way fan-out), Velo (365 days, concurrency 10), Zero's backfill, Tuta's indexer | Breaks under the 2026 quota. Velo silently drops threads; Aplos and Inbox Zero restart from zero |
| **Metadata first, lazy bodies, page commits** | Mailspring (newest first, per-folder cursor, 90 days of bodies), Geary (14-day window, 3-month slices), Flectar (metadata batches of 10, generation stamp), Pimalaya (rounds with "heads"), Mustang, comail, Nylas | **Consensus target** |
| **No history** | Delta Chat, Superlocal (about 25 messages), EmailEngine (baseline only), Redakt (proxy) | Fine for a messenger or gateway, not a mail client |

**Rules that recur across the metadata-first family:**
1. **Capture the incremental cursor before listing** (`historyId`, delta link, UIDNEXT or JMAP state). Aplos already does this for Gmail and JMAP.
2. **Commit each page in one transaction together with its resume token**, so a crash costs one page. Resume from a stored page token (Flectar, Zero), from the oldest stored item (Geary, Mailspring), or by remote-minus-local set difference (Nylas). The last two need no cursor.
3. **Infer deletions only after a complete round, and only within its scope.** Pimalaya's scope rule, Flectar's generation sweep, Zero's verify jobs and Inbox Zero's post-scan tombstones all do this. This is the fix for the ignored `reset:true`.
4. **Show new mail during a long backfill:** Pimalaya runs a "head" catch-up before each resumed page; Nylas runs a new-mail poller alongside.
5. **Leave Spam and Trash out of the first pass. Run one backfill per account, with live import ahead of it** (Nylas, Zero, Geary).
6. **Treat the first sync as a silent baseline.** Notifications and AI apply only to later arrivals (EmailEngine `notifyFrom`, comail/Flectar `first_live_uid`).

**Gmail costs** [I, at verified prices]: the first 50 Inbox threads cost about 1,000 units (newest message, `format=metadata`). 500 threads cost about 10,000 units, roughly 2.5 min at a 4,500 units/min target. Opening a thread costs 60-120 units. Server search on Enter costs about 500 units for 25 results; today's search-as-you-type costs about 12,000 per pause.

### 4.2 Incremental sync

- **Gmail:** apply `history.list` label deltas to per-message labels at no quota cost. Fetch added messages as metadata only. Fetch an unknown thread only if it gained `INBOX`. Today, a 2,000-thread archive done in Gmail web would cost about 240k units (`protocols/proto-google.md` D3). Key body freshness on content, not `historyId`, which Gmail bumps on label changes [I, Inbox Zero].
- **The cursor moves only inside the sync loop, and only together with the changes it covers.** Redakt's watch renewal overwrote it. Velo advanced it past threads skipped for pending ops. Reading all history before the commit (Bulwark) and committing per page with the changes (EmailEngine, Flectar) are both correct.
- **Quarantine poison items** with attempt counts and `next_retry_at` instead of failing the run (comail/Flectar `sync_failures`, EmailEngine's in-flight marker).

### 4.3 Push and polling with no server

| Provider | Server-free push | Fallback | Needs a relay |
|---|---|---|---|
| IMAP | IDLE on INBOX (plus Sent) | STATUS sweep every 2-15 min; Yahoo also needs a periodic resync (its IDLE omits expunges) | No |
| JMAP | EventSource (or WebSocket if offered) | `/changes` every 60 s | No |
| Gmail | None with `gmail.modify`; an IMAP IDLE doorbell needs the `mail.google.com` scope | `history.list` at 15 s focused, 60 s background, 5 min hidden, and on wake | Pub/Sub |
| Graph | Optional IMAP IDLE doorbell (extra scope; tenants may disable IMAP) | Delta every 30-60 s focused, 2-5 min background | Webhooks |
| Calendars | None | Sync tokens and ctag, polled with jitter | Google Calendar webhooks |

Zero runs IDLE only while the user is present (2-minute slices inside 10-minute sessions, minute polling as a safety net), the most battery-aware variant [V `arch/zero.md`]. Every push signal should be a data-free hint that triggers the normal checkpointed pull, coalesced over about 1-1.5 s, with a slow safety poll (Inbox Zero, Bulwark, Stalwart).

### 4.4 Quota and rate budgeting

Each project implements a per-account governor:

| Project | Mechanism | Retry layers |
|---|---|---|
| Zero | Unit reservations over a rolling minute; lanes may use 100% (foreground), 90% (sync) or 70% (backfill); a denied request is deferred, never sent; cooldowns persist | One (SDK retries off); rate limits back off 60 s up to 1 h |
| Bulwark | 200 units/s, 12 in flight, one shared cooldown; fails fast if `Retry-After` exceeds 10 s | Up to 2; writes never retried |
| Neverest | Per-second bucket plus sliding 6,000/min; one batch of 10 in flight, halved on refusal; refusals read from reason and text; daily quota waits until Pacific midnight | One |
| Flectar | Fixed 22 s sleep per page (about 91% of budget), not shared with the reader | Daily quota retried (bug) |
| Redakt | Gate per process: 6 concurrent, 8 s wait budget, pauses the whole mailbox | `quotaExceeded` retried (bug) |
| EmailEngine | 3 retries, waits capped at 5 s each and 8 s total, no token bucket | One (two layers once turned one call into 24 requests) |
| Aplos 0.2.3 | Four workers, each retrying 5×, plus gate backoff | Two; `quotaExceeded` retried |

**Converged design** [I]: one governor per account, priced in each provider's unit (Gmail units; Graph's 4 in flight and 10k per 10 min; IMAP connections, `MESSAGELIMIT` and a daily byte budget; JMAP `maxConcurrentRequests`). Priority lanes: interactive, op flush, incremental, body prefetch, backfill, AI. Target about 75% of Gmail's per-user budget. A pause stops the whole account and aborts sibling requests. Cooldowns persist across restarts. One retry layer. Daily quota means stop until reset.

**Conflict to settle in the Cloud console:** Neverest measured 5 units per `messages.get` [C], while Google publishes 20 [V]. The likely reason [I] is that Neverest's project is grandfathered; Aplos's two-week-old project should be on the new prices.

### 4.5 Making sync and local edits agree

| Pattern | Who | Notes |
|---|---|---|
| **Confirmed vs effective state**, with pending ops replayed over provider truth in the same transaction | Inbox Zero, Superlocal | Replaces Aplos's per-mutation clone and `touched` heuristics; rollback for free |
| **Mutation fence**: drop page items changed after the pre-call journal sequence | Superlocal | Cheap; pairs with Aplos's generation number |
| **Compare-and-set pages** against the stored checkpoint | Inbox Zero | Rejects late and out-of-order pages |
| **Intent outbox per (message, label)**, overlay held until history confirms | Zero | No "UI flips back"; batches into `batchModify` |
| **Desired-state reconcile** (`target` column, pending-flag tables) | Delta Chat | Idempotent; suits IMAP and JMAP moves and flags |
| **Placements plus a guard window**; orphans swept after full coverage | Mailspring, Nylas | Most rigorous multi-folder model |

---

## 5. Local storage

**Schema shape.** Today's designs are document blobs (Aplos's JSON thread rows holding every body, Tuta's CBOR), "fat rows" with a JSON `data` column (Mailspring, Superlocal), normalized columns (Inbox Zero, Velo, comail/Flectar, Nylas, Geary, Mustang) or KV subspaces (Stalwart). Every report recommends three things for Aplos:
- normalized message rows with indexed columns;
- thread rollups recomputed by a SQL aggregate (Velo's bug took them from the incoming batch only);
- a separate label or location table. Examples: Geary's message-location table, Mailspring's placements with a `ThreadCategory` sort index and precomputed counts, Nylas's provider-neutral message row with a separate UID map, Stalwart's `mailboxIds` set.

**Three tiers per message** (Stalwart, Pimalaya's `level`, Geary's field bitmask):
1. a small mutable record (labels, flags, thread, change ID);
2. an immutable parsed-metadata record (headers, preview, MIME tree);
3. a lazily fetched body.

A "which parts are present" marker lets lazy bodies, eviction and partial failure share one code path.

**Where bodies live:**

| Option | Who | Trade-off |
|---|---|---|
| Column in the message table | Velo, Mustang, Geary | Simple; the database grows with the mailbox |
| Separate table of compressed BLOBs | Inbox Zero, comail | Small hot tables; one file to back up |
| Content-addressed files used as a refetchable cache | Nylas (sha256), Stalwart and Pimalaya (BLAKE3 with link records and GC), Delta Chat (attachments) | Deduplicates across labels; easy eviction; easy to serve from a separate origin |

Stalwart's report suggests **raw MIME as the one stored format for every provider** [I]: Gmail `format=raw`, IMAP RFC 822, Graph `$value`, JMAP blobs, all parsed by one local parser. Aplos already parses RFC 822 for IMAP.

**Search.** The options are contentless FTS5 with `contentless_delete=1` sharing the message rowid (Inbox Zero, Tuta, comail, Flectar), external-content FTS5 maintained by triggers (Velo), or a separate FTS database that can be dropped, fed from the change feed and indexed once per body hash (Pimalaya). Each fixes Aplos's full scan on the `UNINDEXED` delete. Every report rejects `LIKE` search. With lazy bodies, keep a server-search fallback on Enter; Flectar dropped it.

**Eviction.** Good examples: Mailspring keeps 90 days of bodies; Pimalaya's `release_before(date)` keeps headers and drops bodies; Nylas and Bulwark use size-capped LRU with refetch; Geary detaches mail outside its window and garbage-collects at a paced rate. Bad examples: Inbox Zero deletes every body and the whole FTS index under disk pressure, and Tuta, Zero, comail and Velo never evict.

**Encryption at rest is a split decision.** Tuta uses SQLCipher with a raw key wrapped by Keychain and an integrity check on open (`better-sqlite3-multiple-ciphers` is an MIT alternative). Delta Chat deprecated SQLCipher in favour of disk encryption, because blobs stay plaintext anyway. Most projects have none. For credentials there is consensus: Keychain or `safeStorage`, never a key beside the data. Superlocal adds a fail-closed "key proof".

**SQLite discipline.** One writer behind a mutex, a few read-only connections, WAL with `synchronous=NORMAL`, and a daily `wal_checkpoint(TRUNCATE)` (Delta Chat saw WAL files over 200 MB without it). Use strict `user_version` migrations; Inbox Zero's swallow `ALTER TABLE` errors. Avoid many writers: Mailspring needs random start delays, and Velo hits SQLITE_BUSY.

**The change log is the spine of every design that serves a remote client:**
- Nylas: rows appended in the same transaction by an ORM hook, compacted on read.
- Stalwart: a per-account counter plus an ID-only log capped at 10k entries, with a truncation marker that yields `cannotCalculateChanges`.
- Pimalaya: trigger stamps plus a `purges` counter.
- Superlocal: a 10k-event journal with a `floor`, below which clients get `reset.required`.
- Tuta: 44-day replay, then purge and resync.

Aplos's `{epoch, rev}` is the in-memory version of these. Making it durable is the one change that enables restarts, multiple windows and any second client.

---

## 6. UI-to-engine API styles

| Style | Example | Resumes after restart? | Several clients? | Typed? | Phone-ready? | Notes |
|---|---|---|---|---|---|---|
| **stdio JSON deltas; UI reads SQLite directly (CQRS)** | Mailspring | No sequence numbers; a lost delta silently desyncs the UI | Main window rebroadcasts | Shared classes | No (needs the shared file) | Proves a separate writer process works |
| **JSON-RPC 2.0, schema-first** | Delta Chat (188 methods, generated TS client) | 10k ring buffer with an overflow event | **No**: one shared emitter splits events between clients | Generated | stdio, FFI and WS | IDs first, then batch-load by ID; events are invalidations |
| **REST + webhooks** | EmailEngine (OpenAPI generated from validators) | No message-level change feed | Yes | Golden-file tested | Assumes a backend that keeps its own database | Hashed, scoped tokens; suits a gateway, not a UI |
| **JMAP** | Stalwart, Bulwark, Fastmail | State strings, `/changes`, `/queryChanges` | Yes | Capabilities in the session | By design | Batches with back-references, an EventSource doorbell, blob routes. Stalwart runs its admin config as private JMAP types; Bulwark carries 43 allow-listed compliance failures |
| **Resource REST + SSE journal** | Superlocal | `Last-Event-ID` replay, `reset.required`, HMAC state tokens | Yes | OpenAPI, ETag, Idempotency-Key | Any HTTP client | Host-side windows of about 100 body-free rows |
| **Live queries** (observe/submit) | Inbox Zero `mail-core` | `{epoch, sequence}`; queries re-run on commit | Per subscription | Zod envelope | On-device only | Simplest to consume |
| **In-process calls + ID-only events** | comail, Flectar, Geary | A lagged subscriber refetches everything | Broadcast bus | comail's TS mirror is hand-written | Needs a wire format | Events coalesced over 100 ms |
| **Transparent object RPC** | Mustang JPC | No | — | No | No | Getter round trips; binary sent as JSON arrays. **Anti-pattern** |
| **Generated IPC with raw SQL** | Tuta (TS, Kotlin and Swift generated from JSON schemas) | Server event log | — | Yes | — | Copy the codegen, not the raw SQL |
| **Aplos today** | `invoke` with an allowlist copied 3 times, `{epoch, rev}` diffs, dev-only `server.ts` (74 lines, no token) | No (epoch resets) | Via main | Payloads untyped | No | Close to IDs-then-batch once `threads.page` replaces cloning |

**Near-unanimous** [I]:
- one schema-first contract that generates the client, validators and allowlist;
- a persisted change log behind opaque state tokens;
- a push channel carrying only IDs or state, coalesced over 100 ms to 1 s;
- keyset paging on `(sort_key, id)`, never offset or a bare timestamp (Zero skips rows at page boundaries);
- blobs on their own routes;
- idempotent commands keyed by a client ID;
- one cursor per client.

**Split:** a JMAP-shaped envelope with batches, back-references and per-type state (Stalwart, Nylas, Bulwark, Mustang, Zero) versus resource REST with a JMAP-style state/changes pair (Redakt, comail, Mailspring, Superlocal, Velo). Nobody recommends full RFC 8621 compliance. Because JMAP is message-centric and Aplos is thread-centric, thread workflow state and summaries need custom objects either way.

---

## 7. Outbox, send safety, drafts, scheduled work, notifications

**Send safety, ranked by rigour:**

| Approach | Who |
|---|---|
| Durable intent written before the network call; failures sorted into "provably not sent" (released) and "uncertain" (never replayed) | Bulwark, Inbox Zero (mutation-ID ledger), Superlocal (`uncertain` state plus a placeholder Sent row), Pimalaya (marker written before the first byte) |
| Stable Message-ID, an attempt marker, then a Sent search | **Aplos**, Flectar (`rfc822msgid:` check before `drafts.send`) |
| Mark "sent" as soon as the provider accepts | Geary; Delta Chat also records which recipients were sent to |
| Unsafe | comail (new Message-ID on retry), Velo (retries after timeouts), Nylas (blind SMTP retry), Zero (no idempotency) |

**Undo-send and send-later should be one mechanism:** a `not_before` time on the queued send (comail, Flectar, Superlocal, Stalwart). Holds kept only in browser memory lose the message or send it early (Redakt's `sendBeacon`, Zero's 5 s toast). Bulwark's scheduled-send rule fits a laptop: pin the draft by hash, re-validate before sending, and *suspend* rather than send late if the due time passed while the machine was off.

**Drafts.**
- **Gmail:** debounced autosave, a fingerprint to skip unchanged saves, serialized saves (Redakt, Geary), `drafts.send`, and a mapping from the original draft ID to its current one (Bulwark).
- **IMAP:** UIDPLUS `APPENDUID` so the previous copy can be deleted (Velo piles up duplicates).
- **Nylas:** a deterministic Message-ID per revision so server copies reconcile back to the local draft.

Aplos, Mailspring, comail and Superlocal keep drafts local-only, and every report counts that as a daily-driver gap.

**Notifications and timers.** Use a durable notification outbox keyed by message, which clients can *claim* once there are several (comail, Flectar). Run one timer that sleeps until the next deadline over a "metadata with expiration" table covering snooze, send-later and reminders (Mailspring). Timers fire only while their owner process is alive. That is the main thing a resident or daemon process buys.

---

## 8. Multi-device

There are four ways to keep devices consistent:
1. **The provider is the sync bus**, with a side channel for app-only metadata. Aplos uses a hidden Gmail label holding an encrypted, last-writer-wins log; device clocks decide conflicts and old copies pile up in Trash. Delta Chat uses hidden self-messages with an explicit tie-break and a forward-compatible `Unknown` variant.
2. **A server is the hub:** Tuta, Redakt, Inbox Zero.
3. **The desktop is the hub.** No production example in this set.
4. **Leader election for side effects:** Tuta's server picks one client to run rules, so they don't run twice.

**Favouring one hub per mailbox** [V]: Gmail's quota is per user per project. Graph allows 4 concurrent requests per mailbox. iCloud's connection cap is low. AI summaries are paid for again on each device.

**Against the Mac as hub:** it sleeps. iOS push needs a server-held APNs key. There's the iOS Local Network prompt. LAN access needs pairing and TLS. Off-LAN access needs Tailscale (which the owner already uses) or an end-to-end-encrypted relay.

Whichever topology wins, app-owned metadata (workflow state, AI results, rules) should be its own cursor-paged feed, separate from mailbox facts (Inbox Zero's `assistant_entries`).

---

## 9. Observability (Aplos has none)

- **Logs:** a rotating file written continuously, with redaction on the root logger (EmailEngine). Add a ring buffer tagged by account and folder, snapshotted into every error shown in the UI (Geary), and a time-boxed verbose protocol log (Mailspring). Avoid writing logs only at exit (Tuta) or calling `tracing` with no subscriber installed (Flectar). Stalwart's typed event catalog with stable IDs is the long-term model.
- **A status vocabulary per account** that both drives retry policy and appears in the UI. Geary: only unreachable or connection-failed reconnect automatically; auth, TLS and unrecoverable failures wait for the user. Zero: discovering, importing N of M, paused until a time, retrying, blocked.
- **Diagnostics and watchdogs:** Inbox Zero's content-free diagnostics bundle, queue inspector and scrubbed Sentry; Delta Chat's deduplicated user-actionable "device messages"; an event-loop delay monitor plus per-account heartbeats (Nylas, EmailEngine, Inbox Zero). These matter more once the engine runs with no window.

---

## 10. Securing any local listener

This is distilled from Mailspring's MCP server, comail's MCP server, Superlocal's loopback session, Mustang's secret handoff and Stalwart's tokens, and from what went wrong in Nylas, Bulwark, Mustang and Tuta.

1. **Bind to loopback or a 0600 Unix socket.** Never `0.0.0.0` by default.
2. **Require a per-client token on every request.** Hand it to the UI out of band (Mustang puts it in the URL hash, then scrubs it). Send it in a header. Compare in constant time.
3. **Allowlist Host and require an exact Origin.** Never reflect CORS. Aplos's `server.ts` echoes the origin after its trust check: safe today, but fragile.
4. **Expose typed, scoped operations only.** No paths, sockets, SQL or protocol objects.
5. **Scope tokens** (read, draft, send), list devices with a revoke action, and audit-log remote sends and deletes.
6. **For a phone:** QR pairing with a key fingerprint and one-time token, TLS pinned at pairing, and Bonjour only on opt-in. Stalwart-style AEAD tokens carrying a credential version make revocation a single counter bump.
7. **The daemon reads the Keychain itself.** Don't pass secrets on stdin as Mailspring does. `safeStorage` is Electron-only, so a standalone daemon needs a native Keychain helper or a headless Electron helper in the same signed bundle. Not `ELECTRON_RUN_AS_NODE`, whose fuse should be off.
8. **Serve email HTML from a separate origin** into an opaque-origin, script-less sandboxed iframe with `default-src 'none'` and an image proxy.

---

## 11. Candidate target architectures

### 11.0 The shared foundation (F)

Every candidate needs this work, and it fixes the known problems by itself. Estimates aggregate the reports' own, which vary widely [I]. Because F fixes the known problems in every case, the comparison below leaves that row out.

| Work item | Fixes | Estimate |
|---|---|---|
| F1. Gmail sync rework: metadata first, page commits, generation sweep for `reset`, governor in quota units with lanes, one retry layer, Spam/Trash excluded, search only on Enter | 403s, ghosts, search quota | 1-2 weeks |
| F2. Normalized store: message and thread rows, label/location table, bodies lazy (separate table or blob files) with eviction, contentless FTS, keyset queries; remove the whole-mailbox clone and main's `latestState` | Memory ceiling, FTS scan | 2-3 weeks |
| F3. Persisted change log, opaque state tokens, `changes(since)` with a truncation signal, ID-only coalesced events; the UI moves to query windows | Restart resnapshots; prerequisite for any second client | 1-2 weeks (overlaps F2) |
| F4. Schema-first typed contract that generates the preload, main and `server.ts` allowlists | Allowlist copied 3 times, untyped IPC | 3-5 days |
| F5. Durable job table (singleton keys, backoff, dead letter); AI enrichment, FTS indexing and calendar sync as jobs; silent baseline on first sync; header heuristics before AI | AI on the sync path, consent | 0.5-1 week |
| F6. Per-account actors: IMAP IDLE plus a command connection, JMAP EventSource, Graph scheduler (4 in flight), CalDAV sync-token | Polling only, IMAP blocking | 1-2 weeks |
| F7. Sanitize HTML in the engine and render it in a sandboxed separate-origin iframe with an image proxy; fuses; CSP | Email HTML in the privileged renderer | ~1 week |
| F8. Rotating redacted log, crash reporter, per-account status and diagnostics bundle | No observability | 3-5 days |

**Total: about 6-10 weeks** for one developer with agents, with heavy overlap [I]. Writing code is not the bottleneck (169 commits in 11 days). **Live verification** is: no real mailbox has fully synced yet, and Google, Microsoft and Fastmail each have external prerequisites.

### Candidate A: local daemon or server ("aplosd") with a network API

**Shape.** The engine becomes a long-lived process. It owns `aplos.db`, the blobs, every provider connection, the governor, the op queue, timers and AI, with a lock file to guarantee one owner. It serves one typed API, either JMAP-shaped (session, `[method, args, callId]` batches, per-type state, `get`/`query`/`changes`/`set`, private `urn:aplos` types) or resource REST with a JMAP-style state/changes pair. Either way the API has an SSE or WebSocket doorbell, `GET /blob/:id`, and a separate-origin HTML route. It is reached over a Unix socket or over loopback with per-client tokens. Electron, browser preview, a CLI or MCP agent, and later a phone are all clients.

**Stages.**
- **A0:** the listener runs inside today's `utilityProcess`, and the app stays resident (menu bar or login item). Sync, IDLE and timers run with no window open, and `safeStorage` keeps working. 1-2 weeks after F.
- **A1:** a LaunchAgent helper registered through `SMAppService`, so sync survives quitting the UI. It needs a Keychain path, a version handshake, restart on update, and migrations that run with no UI attached. 1-3 weeks after F, plus ongoing signing and notarization work [I; report estimates range from 1-2 weeks (Mailspring, Delta Chat, Inbox Zero) to 3-5 (Zero, EmailEngine)].
- **A2:** LAN or Tailscale pairing with pinned TLS (2-4 weeks plus a security review), then a phone client (months).

**Pros.**
- One quota and connection owner for every surface.
- Mail goes only to the provider and the chosen LLM.
- One code path for preview, tests and production.
- A natural home for scoped agent and MCP access.
- A phone gets AI, rules and summaries without keys or OAuth of its own.

**Cons.**
- New attack surface.
- Two lifecycles and version skew from A1 onward.
- A phone sees nothing while the Mac sleeps.
- **No phone-to-desktop-daemon precedent** in the studied set.

**Risks.** Listener security mistakes are the most common failure (§10). Getting `changes` exactly right is subtle: Bulwark shipped two delta bugs that surfaced only once a client relied on them, so budget for replay tests. A1 packaging work competes with daily-driver features.

**Strength of evidence.**
- A0: high (Mailspring, Delta Chat, Nylas Mail and Superlocal use this topology).
- A1: medium (Geary's background mode and comail/Flectar's tray mode, but no separate macOS LaunchAgent in this set).
- A2: low (no precedent).

### Candidate B: evolve the `utilityProcess` engine (no network API)

**Shape.** Build F inside today's topology: per-account actors with lanes, a normalized store, and a typed contract over MessagePort IPC. Electron main stays resident in the menu bar, as in Tuta, comail and Geary. `server.ts` stays dev-only but speaks the same contract. The phone question is deferred, or handed to D.

**Pros.**
- The least new surface.
- Keeps `safeStorage`, fuses and the crash guard.
- All effort goes into sync correctness.
- Fully reversible: A0 is a transport added on top of B.

**Cons.**
- No client beyond Electron windows, so no CLI or agent access.
- Sync stops when the app quits, though not when a window closes.
- If B is the end state, the "local server" goal is not met.

**Effort.** F plus 3-5 days for resident mode.

**Risks.** Low. The main risk is building F without the persisted change log and typed contract, which would make A, C and D expensive later. Those two items are the insurance policy.

**Strength of evidence.** High. This is effectively what Mailspring, comail, Flectar, Geary and the Inbox Zero desktop are.

### Candidate C: hybrid with an optional tiny cloud relay

**Shape.** B or A on the Mac, plus a small stateless hosted relay the user opts into. It has three possible roles:
1. **Content-free pokes from Gmail Pub/Sub, Graph webhooks and Calendar watch.** The Mac calls `watch` with the user's token. The relay holds Aplos's Pub/Sub subscription, answers Graph's validation handshake, and forwards only "mailbox X changed" over WebSocket or APNs. It stores only push-token ↔ mailbox-ID mappings, as recorded in DECISIONS 2026-10-15.
2. **APNs for a phone**, whose signing key can't ship inside the app.
3. **(Out of bounds today) always-on automation** such as scheduled send, snooze and rules while the Mac sleeps. This needs provider tokens on the server, which turns Aplos into a hosted mail service. It contradicts SPEC, widens the CASA scope, and copies Inbox Zero. Provider-side filters (Gmail `settings.filters`, Graph `messageRules`, Sieve) are the server-free substitute and should come first.

**Pros.**
- Real push for Gmail, Graph and Calendar.
- Phone alerts while the Mac sleeps.
- Cheap to run if serverless [I].

**Cons.**
- Aplos becomes an operator: uptime, abuse handling and cost.
- **CASA and Limited Use questions are unresolved.** Whether `emailAddress` plus `historyId` counts as restricted data is unknown (`protocols/proto-google.md` §5D).
- Without hashing, the relay learns who uses Aplos and when their mail arrives.
- For the desktop, the latency gain over 15-60 s polling is modest.
- Watches and subscriptions expire every 7 days or less.

**Effort.** 2-4 weeks [I], plus ongoing operations and a conversation with Google.

**Risks.** Scope creep from role 1 to role 3. A relay outage must degrade to polling, never break sync.

**Strength of evidence.** Medium. Inbox Zero, Delta Chat and Bulwark all push content-free pokes, but Inbox Zero's server also holds tokens.

### Candidate D: portable engine on every device

**Shape.** Each device runs the same platform-free engine directly against the providers. Devices coordinate through provider state (labels, drafts, filters) plus an encrypted metadata channel, today the hidden Gmail label. This is the intent already recorded in DECISIONS 2026-10-15 and `MOBILE.md`. Pimalaya (Android), Flectar, Mustang, Delta Chat and probably Inbox Zero's iPhone app work this way.

**Pros.**
- The phone works while the Mac sleeps.
- No listener and no relay.
- Half-proven already: the engine runs in JavaScriptCore (`MOBILE.md`).
- The privacy pitch holds.

**Cons.**
- **All devices share the Gmail quota of 6,000 units/min per user per project.**
- iCloud's connection cap is shared across devices.
- The phone needs native TLS sockets for IMAP, its own OAuth, and App Store review of mail scopes.
- AI work and API keys are duplicated on every device.
- iOS background limits mean timely phone mail needs C anyway.
- The hidden-label channel needs the fixes listed in the earlier synthesis.

**Effort.** Months for the phone app [I]. Little desktop work beyond F.

**Risks.** Devices competing for quota and connections. Two engines to debug in the field.

**Strength of evidence.** High that the approach works (five projects ship it). Medium that it holds up for Gmail REST under the 2026 quotas: none of the five is a Gmail-REST engine on a new Cloud project.

### 11.5 Comparison

| | A (daemon + API) | B (evolved utilityProcess) | C (hybrid + relay) | D (engine per device) |
|---|---|---|---|---|
| Sync with window closed | A0: yes (app resident). A1: yes even after quit | Yes if resident | Same as its base | Mac: like B |
| Acts while the Mac sleeps | No | No | Pokes only (no actions unless tokens go to the server) | Phone acts independently |
| Phone support | Thin client, only while the Mac is awake and reachable | None | Adds phone wake-ups to A or D | Full, offline-capable |
| One quota and connection owner per mailbox | Yes | Yes (single device) | Same as base | No: devices share the budget |
| New attack surface | Listener, pairing, LAN | None | Public endpoint | Phone credential storage |
| Release and ops burden | A1: second binary, version skew | Lowest | Hosted service | Second app and store review |
| Reversibility | A0 adds cleanly onto B; A1/A2 are hard to undo once a phone depends on them | Fully | Relay can be switched off, but CASA disclosures persist | The phone protocol becomes a compatibility commitment |
| Precedent in this set | Desktop side strong; phone side none | Strong | Medium (content-free pokes) | Strong (5 projects) |
| Effort beyond F | A0 1-2 wk; A1 +1-3 wk; A2 +2-4 wk + client | ~0.5 wk | 2-4 wk + ops | Phone: months |

**How they relate.** B → A0 → A1 is additive, and each step reuses the previous one. C layers onto either A or D. D is the phone answer that doesn't need A. A2 and D compete as phone strategies, and could combine: a phone with its own engine that prefers the Mac's API when reachable. That combination is untested and the most complex option [I].

**Decisions that don't depend on topology.** Settle these first: the Gmail scope (§3.2, before verification); whether Done archives upstream; where bodies are stored and whether they're encrypted; and whether the contract is a JMAP envelope or resource REST.

---

## 12. Ranking the evidence

### 12.1 Sources by weight

| Tier | Source | Why it carries weight | Caveats | License |
|---|---|---|---|---|
| **1: official facts** | Google quota page (I re-checked it) and sync/push/batch/error guides; Graph throttling, delta and batching docs; RFCs 2177, 7162, 8620/8621, 9738, 6578 | Primary specifications | Live servers can differ | n/a |
| **1: production-proven designs** | Mailspring (about 8 years), Nylas (at scale; archived 2017), Geary (13 years), EmailEngine, Tuta, Delta Chat (cut down to chat in 2026), Stalwart | Survived real users | Each solves a different problem | GPL-3.0; AGPL-3.0; LGPL-2.1+; commercial; GPL-3.0; MPL-2.0; AGPL/SEL |
| **2: careful but young** | Inbox Zero client (1 month; plan and code have drifted), Pimalaya v2 (spec with 74 test vectors; draft), Zero's new sync (**not deployed**), Superlocal (6 days; inactive), comail/Flectar (one author each), Bulwark (v0.2; open delta bugs) | Closest to Aplos's problems | Unproven at scale; mostly written by agents | AGPL+terms; MIT/Apache; MIT; none; AGPL; AGPL; AGPL |
| **3: cautionary** | Velo (stalled after 2.5 weeks), Mustang (capability-level RPC), Redakt (server proxy; idle) | Show failure modes clearly | Not models to copy | Apache-2.0; EUPL/proprietary; MIT |

### 12.2 Claims by confidence

- **Consensus, high confidence** (10 or more reports agree, several of them Tier 1):
  - metadata first with lazy bodies;
  - page commits with the cursor captured first;
  - one governor per account and one retry layer;
  - a persisted change log with ID-only push;
  - keyset paging;
  - a single SQLite writer with WAL;
  - sandboxed email HTML;
  - AI as a job that runs after commit;
  - a schema-first contract;
  - Keychain for secrets;
  - IMAP IDLE plus a command connection;
  - JMAP EventSource;
  - a durable op queue with idempotent send;
  - observability from day one.
- **Contested:**
  - a JMAP envelope vs resource REST;
  - a LaunchAgent vs a resident app;
  - Gmail over IMAP vs REST;
  - bodies in SQLite vs blob files;
  - SQLCipher (Tuta) vs disk encryption (Delta Chat);
  - a phone as client of the Mac vs an engine on the phone;
  - IDLE always on (EmailEngine) vs only while the user is present (Zero).
- **Unknown, verify live before building:**
  - the actual reason in the 0.2.3 403;
  - whether Aplos's project is on the 6,000-unit quota;
  - whether Graph's filtered deltaLink hides re-entering mail;
  - Gmail's QRESYNC support and whether IDLE outlives the access token;
  - iCloud's QRESYNC behaviour and connection cap;
  - Yahoo's MESSAGELIMIT;
  - whether Fastmail offers WebSocket push;
  - CASA for a local-AI-only build;
  - whether a push relay counts as transmitting restricted data.
- **Conflicts found:**
  - Neverest's measured 5 units per `messages.get` vs Google's published 20 (§4.4).
  - The prior synthesis's estimate of about 5,000 units was based on old prices.
  - Docs drift from code: Bulwark's README on pacer limits and cache encryption, Zero's AGENT.md on its stack.
- **Effort estimates** are inferences that disagree by up to 3× (a LaunchAgent at 1-2 vs 3-5 weeks). Use them for ordering, not scheduling.

---

## 13. Open questions for the owner

1. Is a phone actually on the roadmap within 6 months? If not, candidate B plus F covers every known problem, and A0 can be added when an agent or CLI client appears.
2. If there is a phone: should it work while the Mac sleeps? If yes, D (perhaps with C) is the evidence-backed path; A alone can't do it.
3. Gmail scope, before verification: stay on `gmail.modify` or add `mail.google.com` for IMAP bulk sync and IDLE?
4. Is a hosted relay acceptable at all, given SPEC's "no Aplos server stores user data"? Even a stateless poke relay would hold push-token ↔ mailbox mappings.
5. What scope for the first sync: Inbox and Sent for 30 days, the newest 500 threads, or 14 days (Geary)? This sets the quota timeline.
6. Body retention: keep everything (Tuta), keep 90 days (Mailspring), or use a size-capped LRU? Encrypt `aplos.db`, or rely on FileVault?
