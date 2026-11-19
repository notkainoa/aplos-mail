# Pimalaya (email-lib, Himalaya, Neverest, pimdir, ortie): architecture audit for the Aplos revamp

Date: 2026-10-25. Sources: shallow clones in `/Users/knewton/.t3/aplos-research/src/`: `pimalaya-core` (email-lib v1, `b3a9640`, 2026-03-01), `himalaya` (`4df380b`, 2026-10-17), plus `pimalaya-neverest`, `pimalaya-io-pimdir`, `pimalaya-pimdir`, `pimalaya-ortie`, `pimalaya-io-oauth`, `pimalaya-carillon`, `pimalaya-sirup`, `pimalaya-io-gmail`, `pimalaya-io-imap`, `pimalaya-io-jmap`, `pimalaya-io-msgraph` and `pimalaya-android` (all 2026-08 to 2026-10). The org-wide `ARCHITECTURE.md` was read with `gh api` from `pimalaya/.github`. I only read files. Nothing was built, installed or run. Paths are relative to `/Users/knewton/.t3/aplos-research/src/`.

**Licenses.** `pimalaya/core` (email-lib) is **MIT** (`pimalaya-core/LICENSE`). Himalaya, Neverest, io-pimdir, the pimdir spec, ortie, carillon, sirup and the Android app are dual **MIT OR Apache-2.0** (`LICENSE-MIT` plus `LICENSE-APACHE`; `license =` in each `Cargo.toml`). A few side repos (`m2m`, the archived `mimosa`) are AGPL-3.0. Everything below describes ideas in my own words. Aplos's rule still applies: copy no code, schema text or prose.

Evidence labels: **[V]** I verified it at the path given. **[I]** inference. **[C]** the project's own claim, which I did not verify (for example measured quota numbers).

---

## 0. The headline: the target brief is out of date

The brief describes email-lib as "a backend abstraction across IMAP, Maildir, notmuch, SMTP and sendmail, OAuth 2.0 handling, and sync between backends". That was **v1**. The author has since thrown most of it away, and wrote down why. This is the most useful finding for Aplos.

- `himalaya/MIGRATION.md` (v1 to v2, released 2026-07-26) lists the v1 problems in the maintainer's own words [V]. The unified backend trait was "overkill", a maintenance tax. The shared API forced lossy shortcuts on every protocol. OAuth refresh was painful. Native keyring integration was "hazardous" (silent failures, locked sessions). Every command opened a fresh IMAP session.
- v2 dropped the backend abstraction, notmuch and sendmail. It moved OAuth out to **ortie**, keyring access out to shell commands, composing out to **mml**, and session reuse out to **sirup**. Everything was rebuilt on "I/O-free" (sans-I/O) coroutine libraries (`io-imap`, `io-gmail`, `io-msgraph`, `io-jmap`, `io-smtp`, ...).
- Sync left Himalaya in v1.0.0 (2024-12-09). It went to **Neverest** (`himalaya/CHANGELOG.md:507-511`) [V]. Neverest v0.2.0 (2026-09-07) is "a full rewrite" on io-* plus a new on-disk standard, **pimdir** (`pimalaya-neverest/MIGRATION.md`) [V].
- email-lib's last release was 0.26.4 on 2025-01-11 (`pimalaya-core/email/CHANGELOG.md`). Its last commit is an outside PR from 2026-03-01 [V]. It is legacy code.

So this report covers both generations. **v1** (email-lib) shows what a naive multi-backend design looks like and why it failed. **v2** (pimdir + Neverest + io-*) is a carefully specified local-replica design. It maps unusually well onto Aplos's known problems and onto the "local daemon" question.

---

## 1. Overview

**Purpose.** Pimalaya is a family of Rust tools and libraries for personal information management: mail, contacts, calendars. It is funded by NLnet/NGI grants from 2022 through 2027 (`himalaya/README.md`, Sponsoring). The current grant is literally "Pimalaya-pimdir" [V].

**Activity (via `gh api`, 2026-10-25) [V].**

| Repo | Stars | Created | Last push | Contributors | Notes |
|---|---|---|---|---|---|
| himalaya | 7,529 | 2020-12 | 2026-10-17 | 66 (soywod 1,137 commits, next 26) | v2.0.0 07-26, v2.1.0 08-16, v2.2.1 10-02; 100+ commits since 07-25 |
| core (email-lib) | 44 | 2024-08 | 2026-03-01 | 13 (soywod 791) | legacy |
| neverest | 321 | — | 2026-10-19 | 3 (soywod 186) | v0.3.0 10-02, "expect breaking changes" |
| io-pimdir / pimdir spec | 1 / 4 | — | 2026-10-14 | 1 each | spec status "draft" |
| ortie | 74 | 2025-05 | 2026-10-16 | 2 | OAuth token CLI |

**Bus factor is one.** Clément Douin (soywod) writes nearly everything. The repos carry `CLAUDE.md`/`AGENTS.md` and an AI policy, and they follow a "Cairn" convention: a living spec, change proposals and a dated, immutable log under `cairn/` (`himalaya/AGENTS.md`). So the setup looks like Aplos's: one developer plus agents [V/I].

**Target user.** Terminal power users who script their mail (`--json` on every command, stdout for data, stderr for logs, exit codes as the only success signal). They are also editor-plugin authors (Vim, Emacs, Raycast) and agent frameworks (an OpenClaw skill is listed in `himalaya/README.md`). The Android app (`pimalaya-android/README.md`) is a closed alpha for ordinary users.

---

## 2. Feature inventory with maturity

| Feature | Where | Maturity |
|---|---|---|
| IMAP, SMTP, JMAP, Gmail REST, Microsoft Graph, ManageSieve clients | io-* crates; himalaya v2 | Shipped in himalaya v2.x; manual provider test reports in `himalaya/cairn/spec/testing/` (gmail, imap-icloud, jmap-fastmail, msgraph...) [V] |
| Maildir, m2dir, mbox, pimdir local backends | himalaya v2 | Shipped |
| notmuch, sendmail | email-lib v1 only | **Removed** in v2 ("may come back") [V] |
| Account discovery (PACC, Thunderbird autoconfig, RFC 6186 SRV, JMAP well-known, WWW-Authenticate probe) | io-pim-discovery | Shipped, parallel probes (`himalaya/README.md` FAQ) |
| OAuth 2.0 | v1: inside email-lib + keyring. v2: **ortie** / io-oauth | v1 legacy. ortie shipped: auth code + PKCE, device code, client credentials, dynamic client registration, RFC 8414 metadata |
| Offline sync | v1: email-lib `sync` (4-way diff). v2: Neverest + io-pimdir | v1 legacy. v2 v0.x, very actively developed |
| Push / watch | v1: `envelope watch` (IMAP IDLE). v2: **carillon** | carillon v0.x: IMAP IDLE (QRESYNC deltas), JMAP EventSource, 60 s polling for Gmail/Graph/DAV |
| Search | v1: query DSL. v2: shared DSL plus pimdir SEARCH spec (FTS5) | DSL shipped. pimdir search layer specified, "has none yet" as an implementation (`pimalaya-pimdir/README.md`) [V] |
| Threading | v1: petgraph over In-Reply-To. pimdir SEARCH §9 | v1 shipped. v2 moved thread commands to protocol-specific APIs |
| Send | SMTP, Graph, Gmail; queued `submit` intent in Neverest | Shipped; at-most-once with an "uncertain" park |
| Drafts | Plain messages appended to the drafts role, flag `\Draft` | Basic, no draft sync engine |
| Server-side rules | ManageSieve (`himalaya sieve put/activate/check`) | Shipped |
| Calendar, contacts | calendula, cardamum, Neverest DAV/Graph/Google sources | Active |
| AI | None in the mail path | n/a |
| GUI | himalaya-tui (in development), Android (Java Views + Rust over JNI) | Alpha |

---

## 3. Architecture deep dive

### 3a. Process and deployment topology

**v1 (email-lib) [V].** One process. The CLI linked email-lib, which ran a Tokio runtime and held a dynamic `Backend` struct with one optional slot per feature (`add_folder`, `list_envelopes`, `send_message`, ...; `pimalaya-core/email/src/backend/mod.rs`). Undefined features failed at runtime. `BackendPool` held several contexts for parallel calls. The IMAP pool size defaulted to 1 (`imap/config.rs:64-69`). Sync and watch ran in the same process from a command.

**v2: many small single-purpose processes, no server, no cloud [V].**

- `himalaya`: stateless per invocation. Each command opens TCP+TLS+SASL afresh unless pointed at sirup.
- `sirup`: a **long-running daemon** that authenticates once and exposes the live IMAP/SMTP/ManageSieve session on a Unix socket per protocol (`<socks-dir>/sirup/<account>-<protocol>.sock`). Clients see a PREAUTH greeting and never hold credentials. It binds nothing until every session is up, and the first session to fail ends the whole daemon so a supervisor sees it (`pimalaya-sirup/README.md`).
- `neverest`: the sync engine, run per invocation (cron/systemd/hook). It is the **single owner** of the pimdir store.
- `carillon`: a long-running watcher. It fires hooks (a desktop notification or a shell command, for example `neverest sync`) on changes. It reconnects with backoff from 2 s to 300 s, reset after a healthy session (`pimalaya-carillon/src/watch.rs:66-73`).
- `ortie`: the OAuth token broker. Other tools get a token by running `ortie token show` as a "secret command".
- Frontends (himalaya, calendula, cardamum, himalaya-tui) open the pimdir store **read-only** and append writes to its queue.
- **Android** is different. It embeds the whole engine on the phone. Java owns sockets, SQLite and the scheduler (JobScheduler, `android/app/src/main/java/org/pimalaya/sync/BackgroundCheck.java`). Rust does no I/O: every yield crosses JNI as a JSON envelope, with HTTP-style status codes that Java branches on (401 renews a token, 412 retries, 404 converges) (`pimalaya-android/rust/src/lib.rs`).

The glue between processes is the **filesystem**: a SQLite database in WAL mode plus lock files. There is no RPC. Section 7 explains why that matters.

### 3b. Connectivity per provider

| Provider | v2 path | Auth | Evidence |
|---|---|---|---|
| Gmail | REST (io-gmail) or IMAP | REST: bearer only. IMAP: app password or XOAUTH2 | `himalaya/README.md` Gmail; `cairn/spec/provider-quirks.md` |
| Outlook / M365 | Graph (sending through Graph too) or IMAP/SMTP | Bearer / XOAUTH2. Basic auth is retired | same |
| Fastmail | JMAP (bearer: API token or OAuth with dynamic registration and an RFC 8707 resource indicator) or IMAP with an app password | | `pimalaya-ortie/README.md` Fastmail |
| iCloud | IMAP/SMTP, app-specific password; the IMAP login is the bare name and the SMTP login is the full address | | `himalaya/README.md` iCloud |
| Proton | Through Proton Bridge on localhost | | same |
| Generic IMAP | SASL PLAIN, LOGIN, XOAUTH2, OAUTHBEARER, SCRAM-SHA-256, ANONYMOUS; STARTTLS/implicit TLS; SOCKS5/HTTP proxy | | `himalaya/README.md` Features |

**Provider quirks are written down as requirements** (`himalaya/cairn/spec/provider-quirks.md`) [V]. Examples: XOAUTH2/OAUTHBEARER must carry the login. JMAP blob downloads may come from another host, so open a new connection there. IMAP special-use roles are missing (only INBOX is detected) until the codec supports `LIST RETURN (SPECIAL-USE)`. Some servers need the RFC 2971 `ID` command right after login. Coremail (163.com) falsely advertises SASL-IR.

**OAuth, v1 [V].** `account/config/oauth2.rs`: authorization code grant with optional PKCE. The redirect goes to a loopback server on the first free port in 49152-65535. The access token, refresh token and client secret go into the OS keyring under names like `<account>-imap-oauth2-access-token`, using the `keyring` crate with `apple-native` on macOS (`pimalaya-core/keyring/Cargo.toml`). Refresh is **reactive only**: try the stored token, and if authentication fails, refresh and retry once (`imap/mod.rs:1239-1280`). It stores a rotated refresh token when one comes back, which is correct (Inbox Zero's Outlook path drops it). There is no expiry tracking. The URL prints to stdout.

**OAuth, v2 (ortie / io-oauth) [V].** RFC 6749 auth code with PKCE S256 by default, RFC 8628 device code, client credentials (secret or JWT assertion), RFC 7591 dynamic client registration, RFC 8414 metadata discovery, and "manual completion" when the loopback can't bind. Tokens refresh on read when within 60 s of expiry (`src/token/show.rs:24-26,105`). **ortie never stores tokens itself.** It reads and writes them through user-configured shell commands (`pass`, `secret-tool`, `security`), so encryption at rest is delegated to the user's password manager (`src/main.rs` header). A `repl` mode unlocks the secret store once per session.

**One anti-pattern for Aplos.** ortie's README recommends **Thunderbird's public OAuth client IDs** for Google and Microsoft, and the PowerShell client ID for Graph (`pimalaya-ortie/README.md`, Google/Microsoft sections) [V]. Aplos's rules forbid reusing another application's OAuth configuration. Never do this.

### 3c. Sync algorithm

#### v1: stateless four-way diff keyed by Message-ID [V]

`pimalaya-core/email/src/sync/mod.rs` and `email/sync/patch.rs`:

1. Take two exclusive advisory lock files, one per side, in the runtime dir.
2. For each side, keep a **cache Maildir** (`$XDG_CACHE_HOME/.../<hash-of-backend-config>`). Each cached "message" is a stub holding only `Message-ID` and `Date` plus its flags (`envelope/mod.rs:230-234`).
3. For every folder, list **all** envelopes from four places at once with `page_size: 0`: left cache, left, right cache, right.
4. For each Message-ID, match on presence in the four sets (16 cases) and emit hunks: `CopyThenCache`, `Uncache`, `Delete`, `UpdateFlags`, `UpdateCachedFlags`. Ambiguous cases favor keeping data. When a message exists remotely but not locally, it is copied back rather than deleted.
5. Apply hunks concurrently. Per-hunk errors are **collected into the report and not retried**.

Optional knobs: folder include/exclude, `before`/`after` date filters, and per-side create/delete permissions (`folder/sync/config.rs`, `envelope/sync/config.rs`).

**Critique.** The design is simple, provider-agnostic and safe-ish. But every run costs O(mailbox) on both servers, with no CONDSTORE, history ID or delta. Duplicate Message-IDs collide. A missing Message-ID breaks it. And v1's IDLE watch re-fetched **all** envelopes after every notification and diffed them (`email/envelope/watch/imap.rs:58-70`). The retry layer was three attempts on a fixed 30 s timeout, with reconnect and reselect when the stream closed (`email/src/retry.rs`, `imap/mod.rs:155-200`). Nothing handled rate limits.

#### v2: pimdir SYNC (normative spec) plus io-pimdir engine plus Neverest connectors [V]

The spec is `pimalaya-pimdir/SYNC.md`, with an informative summary in `OVERVIEW.md` §5-9. The essentials:

- **Three-way merge per item, per source**: local state, the *base* (what this source last agreed to, stored per binding), and what the remote reports now. Flags merge element by element and **never conflict**. Mail bodies are immutable, so mail never takes the content-conflict path. Contacts and events use revision (ETag) gated pushes and conflict policies `Manual`, `PreferRemote` or `PreferLocal` (§5).
- **Connector seam with three requests** (§4). **Enumerate** returns a page: members with handle, flags and the *summary meta*; vanished handles; `complete`/`last` markers; an opaque resume cursor; and a checkpoint. **Fetch** takes a tier (`Meta` or `Full`) for a batch of handles. **Push** takes a batch of changes and returns an outcome per change. "Members arrive named": the listing already carries the header fields the summary needs, so nothing enters the store as an unnamed ID.
- **Rounds and pages.** A full listing (a "round") arrives newest first, one page per write. Each page is committed with its resume cursor, so the first page of a huge mailbox shows within seconds and an interrupted run resumes. Default pages: IMAP 500 UIDs, Graph 1,000, Gmail 100 IDs with metadata read in batches, JMAP 500 capped by `maxObjectsInGet`, DAV 64 bodies (§4 table).
- **Checkpoints.** IMAP stores `(UIDVALIDITY, HIGHESTMODSEQ)` and uses a QRESYNC `SELECT ... CHANGEDSINCE` delta (`pimalaya-neverest/src/imap/backend.rs:116-238, 1307-1330`). Without QRESYNC it lists a full round instead. Gmail uses `historyId`, JMAP its state string, Graph its delta link, DAV a sync-token. The checkpoint is **taken at the start of the round** and handed over with the first page, so changes made during the round are caught later.
- **Heads.** A first Gmail sync paced by quota can take many runs ("a quarter of an hour", SYNC §5). So each resumed run first lists a *head*: a delta since the round's checkpoint. New mail therefore appears during a long first sync (`pimalaya-neverest/CHANGELOG.md:13`).
- **Scope.** An optional `[since, until)` window on the `Date` header, with a 2-day margin on provider date filters. **Absence means deleted only inside the scope, and only when the round's last page lands.** A deletion the source states explicitly (VANISHED, history delete, `@removed`, `destroyed`) applies at any date.
- **Safety invariant.** "A sync never deletes on the server on its own account." A remote `Remove` may come only from a tombstone the user staged, never from absence, a narrowed scope or an interrupted round (§5).
- **Restart vs rekey.** An expired cursor or history ID (Gmail 404, Graph 410, JMAP `cannotCalculateChanges`) **restarts the round**: a relisting without refetching. A `UIDVALIDITY` change triggers a **rekey**, which carries local state across to the new handles by link ID (§8).
- **Idempotency key** on every push: a deterministic hash over collection, handle, kind and payload. A replay after a crash then applies once (§4).
- **Lazy bodies.** The **upgrade** verb raises chosen items from `Meta` to `Full`. If the same body is already stored (a second Gmail label, an IMAP copy), it is linked by content hash instead of fetched (§6).

**Rate limits and backoff (Neverest) [V], numbers [C].** `pimalaya-neverest/src/throttle.rs` and `src/gmail/{run,batch}.rs`:

- One `Throttle` per source, shared by all its connections. It combines a per-second token bucket with a sliding 60 s budget in **quota units**. Gmail defaults: 200 units/s, 6,000 units/min. A `messages.get` counts as 5 units, "measured on 2026-10-10" from refusal texts. The 6,000 figure was read from the project's Google console.
- Gmail metadata and raw reads go through the **HTTP batch endpoint**: 10 reads per batch, **one batch in flight**. Their measurement: batches of 10 drew 0 refusals in 2,250 reads, batches of 25 drew 1.2 %, batches of 50 drew 19 % (`run.rs` constants). Batch size adapts: halve on a refusal, double back after a clean full batch (credited to lieer's approach). Raw batches are capped at about 8 MiB by known sizes, and messages over 5 MiB are read alone (`batch.rs`).
- Refusals are classified **by Google's reason and wording, not by HTTP status** (`throttle.rs:331-374`):
  - *burst* (429, 503, 403 `rateLimitExceeded`): wait a second or two;
  - *per-minute quota* (the text names "per minute"): wait 2-5 s, then the next minute;
  - *daily quota*: give the source up until **midnight Pacific**.
- Otherwise the backoff is exponential with jitter (1, 2, 4, 8, 16 s, at most 5 retries). A stated `Retry-After` over 120 s makes the source give up for the run. Every other connection then stops sending too, and the report lists `throttled: [{source, until}]` with exit code 3.
- `CHANGELOG.md:87` records a bug that matters directly to Aplos's 403. Gmail's per-minute "Total Query Cost" refusal carries only `rateLimitExceeded` in `errors[]`, so code that reads the reason alone mistakes a quota refusal for a concurrency burst.

**Push.** carillon holds IMAP IDLE, using QRESYNC deltas when available. It uses JMAP EventSource, and polls Gmail `history.list` and Graph delta every 60 s (`pimalaya-carillon/src/gmail.rs:44`, `msgraph.rs`). io-gmail implements `users.watch` but deliberately leaves it unwired, because Pub/Sub needs a server (`pimalaya-io-gmail/src/lib.rs:96-103`) [V].

**Offline outbox.** All writes go through the **action queue**, covered in 3d and 3e.

### 3d. Local storage

**v1.** Mail lived in the user's own Maildir/notmuch tree. Sync state lived in the stub cache Maildirs above. There was no database.

**v2: the pimdir store** (`pimalaya-pimdir/STORAGE.md`; canonical DDL in `migrations/storage/0001_init.sql`, 599 lines) [V]. The layout:

- `pimdir.db`: SQLite in WAL mode, `STRICT` tables;
- `objects/ab/cd/<hash>`: **content-addressed bodies** (BLAKE3, base32), written atomically with temp file, fsync, rename and directory fsync;
- `owner.lock` and `objects.lock`;
- an optional, droppable `index.db` for search.

Main tables, with key columns:

- `store_meta`: format, version, hash_algo, `next_seq`, `next_change`, `purges`.
- `collections`: id, account, kind (a media type), name, parent, role (inbox/sent/drafts/trash/junk/archive/all...), conflict policy, generation, `changed`.
- `sources`: per collection and source. Holds the opaque `checkpoint`, the coverage window, and the open round's scope, cursor, checkpoint and start time.
- `items`: (collection, link_id) primary key. `seq` is the public ID. Also flags (JSON), `object_hash` (NULL until hydrated), `sort_key`, `level` (1 meta, 2 full), `deleted`, `retained_at`, `conflicted`, and the `changed` stamp.
- `bindings`: per source. Handle (UID or remote ID), base flags/object/revision, conflict state, and the `round` stamp.
- `objects`: hash, size, refcount.
- Per-kind summary tables: `mail_summary` (message_id, in_reply_to, subject, sender, date, size, attachment, invitation), `contact_summary`, `event_summary`, `task_summary`, `journal_summary`, `file_summary`.
- `item_address`: role, position, address, name, across all kinds, so "everything about this person" is one indexed seek.
- `item_reference`: cross-kind links (attachment, invitation, sender, related).
- `queue`: id, producer, collection, action, versioned JSON payload, `object_hash`, attempts, `error` (non-NULL means parked). Plus `receipts`, `capabilities` and `performers`.

**Change feed.** Triggers stamp every visible row change from one monotonic counter. Consumers keep a `(stamp, purges)` cursor and ask for what moved since. They reconcile deletions only when `purges` moved (§4.5). **Full bodies are stored** when hydrated. Attachments are extracted as "stand-in" file items that point at the message's part and hold no separate bytes (§14.3).

**Retention and eviction.** Nothing is hard-deleted on sync. An item whose last binding vanishes is *retained*: hidden, listed in a trash view, and kept until `purge-after`. Two eviction tools exist. `collect_before(date)` drops old items locally without telling any server. `release_before(date)` **drops bodies but keeps headers**: the mail stays listed and searchable and is refetched when opened (§11.3-11.4). A refcounted garbage collector runs on demand.

**Search** (`SEARCH.md`, `migrations/search/0001_init.sql`). This is a separate FTS5 DB (`unicode61 remove_diacritics 2`, prefix indexes) that folds the change feed. Each body is indexed **once per hash**, and items without a body are indexed from their summary. It also holds calendar occurrences and a thread table built from In-Reply-To/References, with cycle breaking. It is derived and droppable.

**Migrations.** Forward-only, numbered SQL with `PRAGMA user_version`. A newer or corrupt store may be rebuilt from blobs plus a resync. **But while the spec is in draft, schema changes are folded into `0001` and old stores are simply refused with "delete and resync"** (`STORAGE.md` §6; `himalaya/CHANGELOG.md:158`) [V]. That is a real stability warning.

**Encryption at rest: none.** The spec doesn't mention it. Protection comes from the filesystem [V by absence].

### 3e. The API between UI and engine

There is **no network API**. The store itself is the interface, through three roles (`STORAGE.md` §8, §14-15) [V]:

- **Owner.** Exactly one process, holding an exclusive advisory lock that it never waits for. It is the only thing that mutates items, bindings and objects.
- **Readers.** Any number. They open SQLite read-only, get consistent WAL snapshots, and take no lock. They notice changes with `PRAGMA data_version` or the change feed. They list from summary tables with **keyset pagination** on `(sort_key, seq[, collection])`, so a page costs the same at any depth. A missing body reads as "not fetched", never as an error.
- **Producers.** They append to `queue` in one transaction (blob first, pinned against the GC), then get a row ID back. Later they read `load_action` (pending or parked with error) or `load_receipt` (applied, plus the `seq` it created). A reader may **overlay pending actions** for read-your-writes. Before enqueuing, a producer must check the `capabilities` table, so the UI refuses an unsupported action up front instead of failing at sync.

The owner applies actions in append order. Each one is applied and its row deleted in a single transaction with no network I/O. Retries are bounded and failures are parked, never silently dropped (§15.2).

Himalaya v2 is exactly such a reader plus producer (`himalaya/src/pimdir/mod.rs`; `cairn/spec/backends.md`: "pimdir is a reader and a producer, never the owner").

**Realtime propagation** is pull-based: the change-feed cursor and `data_version`. There are no subscriptions. Android uses a JNI JSON envelope instead. The Android Java UI calls Rust exports and also serves the engine's storage yields.

### 3f. Send, drafts, threading, labels, calendar, AI

- **Send.** v1 sent over SMTP or sendmail, then appended a copy to Sent (`email/message/send/mod.rs`). v2/Neverest queues a `submit` **intent**, with the raw body pinned in the blob store and only the envelope in the payload (`pimalaya-neverest/src/offline/submit.rs`). Delivery is **at-most-once**. A marker file is written *before the first byte leaves*. If a run dies mid-send, the next run parks that intent as `uncertain:` and never resends it. Only a person can resend. A sent copy is filed via a queued `add`, except on Gmail and Graph, which file it themselves (`CHANGELOG.md:36`) [V].
- **Drafts.** Drafts are messages appended to the drafts-role mailbox with `\Draft`. Gmail uses `messages.insert` and Graph refuses `add_message` (`cairn/spec/backends.md:247`). No compose-time draft sync.
- **Threading.** v1 built a petgraph over In-Reply-To (`envelope/thread/mod.rs`). pimdir SEARCH §9 defines thread rows: parent is the first In-Reply-To, else the last References. Placeholder rows hold missing parents, cycles are broken, and the thread ID is the earliest member.
- **Labels and folders.** Gmail labels are *collections*. A message on several labels is several placements sharing one stored body, and is read once per run (`src/gmail/run.rs` header). Roles are always read from the server (SPECIAL-USE, Graph well-known folders, Gmail system labels), "never guessed from a name" (`CHANGELOG.md:27,70`).
- **Calendar and contacts.** These are first-class in the same store (event/task/contact summaries, `item_address` across kinds, invitation-to-event references).
- **AI.** None.
- **List-Unsubscribe.** The header is only parsed and shown (`himalaya/src/shared/message/read.rs:196`). Nothing acts on it.

---

## 4. Engineering quality

- **Tests [V].** email-lib has about 82 tests, including integration tests against an embedded Stalwart server (`pimalaya-core/email-testing-server/Cargo.toml` pulls Stalwart crates). Neverest has about 383 unit tests and about 25 integration suites (`tests/*.rs`: deletes, moves, heads, scope, submit, duplicates, google, msgraph...) run against **real Stalwart (IMAP/JMAP) and Radicale (DAV) containers** (`tests/stalwart.sh`, `radicale.sh`). io-pimdir has about 307 tests. The pimdir spec ships **74 normative JSON test vectors** (`vectors/`) plus checker scripts, so independent engines must agree on pushes, rows and idempotency keys.
- **CI.** A reusable Nix workflow (`.github/workflows/tests.yml` delegates to `pimalaya/nix`), plus `cargo deny` audits and release workflows. `core` has no workflows in-repo.
- **Organization.** Strict layering: an I/O-free `no_std` core, an optional blocking `std` client, then an optional CLI (`.github` `ARCHITECTURE.md` §3-4). Every crate's `main.rs`/`lib.rs` opens with an architecture header. Provider quirks and manual test reports live under `cairn/spec/`.
- **Observability.** `--log-level` (off..trace), `RUST_LOG` targets, `--log-file`, and stderr only for logs. Low-level libraries log only at `trace` and never log secrets (ARCHITECTURE §5, §11). Exit codes form a taxonomy: 0 done, 1 failed, **2 reconciled but something needs a person** (a conflict, a duplicate, a refused write), **3 partial and will resume** (an unreachable source, throttling) (`pimalaya-neverest/README.md` Conflicts). There is no crash reporting or telemetry, by design ("no analytics", Android README).
- **Weaknesses [I].** The spec prose is extremely dense and hard to audit. Breaking churn is frequent (v1 to v2, `io-replica` archived and folded into `io-pimdir`, pimdir stores refused across drafts). The bus factor is one. Duplicate `Message-ID`s are refused rather than resolved (`neverest/README.md`, "Duplicated identities"), which a consumer GUI could not get away with.

---

## 5. UI notes

There is no desktop GUI. Himalaya is a clap CLI with tables and `--json`. Its keyboard model is shell commands, and `--help` is the canonical documentation. himalaya-tui (crossterm) is in development. The Android app uses plain Java Views with minimal AndroidX (`drawerlayout`, `swiperefreshlayout`; `android/app/build.gradle.kts`) and no motion libraries. The only UI lesson is a product pattern: show **coverage** ("mail since <date>") and **queue state** (pending, parked with reason, uncertain send) to the user.

---

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **Reshape `MailProvider` into enumerate-page / fetch-tier / push-batch.** Aplos's seam is one call, `sync(cursor) → {threads (fully normalized), flags, removed, cursor, reset}` (`apps/desktop/src/engine/provider.ts`). That shape forces all-or-nothing, full-body syncs. A paged listing with summaries, a separate body fetch by tier, and per-change push outcomes makes metadata-first sync, resume and lazy bodies fall out naturally.
2. **First Gmail sync as a resumable round.** Capture `historyId` at round start. List newest first, 100 IDs at a time, with metadata (only the summary headers) in small HTTP batches. Commit each page with its page token. Run a **head** (history since the round's checkpoint) before each resumed page, so new mail shows during a long backfill. Hydrate bodies afterward, recent and inbox first.
3. **One throttle per account, in quota units.** It needs a per-second bucket plus a sliding-minute budget, and one batch in flight. Batch size should adapt (halve on refusal, double on success). Classify Google refusals by reason **and** message text: burst, per-minute (wait seconds) or daily (stop until Pacific midnight). Neverest's measured numbers (5 units per `messages.get`, 6,000 units/min/user, batches of 10 clean) are a good starting configuration to verify against Aplos's own project console. This directly fixes the 0.2.3 bug of retrying `quotaExceeded` five times.
4. **"A sync never deletes on the server on its own account"**, and **"absence means deleted only in scope, at the end of a complete round"**. This is the correct fix for Aplos's ignored `reset` (ghost threads): treat reset as *restart the round*, and infer deletions only once the round completes.
5. **Store layout.** Metadata rows (summary columns, not JSON blobs) for lists. **Content-addressed bodies on disk** (deduplicated across Gmail labels and IMAP folders). A `level` column (meta/full). **Keyset pages.** This removes the need to hold the mailbox in memory or `structuredClone` it per mutation.
6. **A trigger-maintained monotonic change stamp** on every row. The UI and the FTS indexer then fold "changed since N" instead of Aplos re-stringifying every thread on every commit.
7. **FTS as a separate, droppable index** fed from the change feed and keyed per body hash. This fixes the `DELETE ... WHERE id=?` scan on an `UNINDEXED` column.
8. **Eviction by date.** "Release bodies below date X, keep headers", with refetch on open. Plus **retention**: an item removed upstream goes to a local trash view until purge, not silently away.
9. **The action queue with receipts and parking.** Each queued op returns an ID the UI can follow (pending, parked with reason, applied with result). Unknown kinds are skipped, not failed. Failures are never silently dropped. Aplos already has an ops queue; add receipts, parking and a visible "needs you" state.
10. **At-most-once send with an in-flight marker written before the first byte**, and an explicit "uncertain" state that only the user can resend. Compare with Aplos's `findSent` dedup and keep whichever is stricter.
11. **A capabilities table consulted before enqueueing**, so actions a provider can't perform are greyed out up front. Aplos's `ProviderCapabilities` is the seed.
12. **Status taxonomy per account**: synced / needs a decision / incomplete and will resume / throttled until T. Plus **coverage** ("mail since ...") in the UI.
13. **Observability conventions.** Levelled logs with per-module targets, a log file, protocol layers logging at trace only, secrets never logged.
14. **ManageSieve and provider-side filters** as the "rules while the Mac sleeps" path for Fastmail and other Sieve hosts. This matches the synthesis's escape-hatch recommendation.
15. **Real-server integration tests.** Run Stalwart (IMAP+JMAP) and Radicale (CalDAV) in containers in CI instead of only fakes. Keep **per-provider manual test reports** in the repo as live-verification evidence, which fits Aplos's "check off with evidence" rule.
16. **Read special-use roles from the server** (SPECIAL-USE, Graph well-known names, Gmail system labels), never from folder names.

### Avoid

1. A **lowest-common-denominator unified backend trait** that hides provider capabilities. Pimalaya's own post-mortem says it cost more than it saved. Keep a thin shared core plus provider-specific extensions.
2. **v1-style full-scan sync** (listing every envelope on every run) and **IDLE handlers that refetch everything**. Use QRESYNC/CONDSTORE, history and delta.
3. **Reactive-only token refresh.** Refresh ahead of expiry, keep the rotated refresh token, and map `invalid_grant` to a "Reconnect" state.
4. **Borrowing Thunderbird's or PowerShell's OAuth client IDs**, as ortie's README suggests. This is forbidden for Aplos.
5. **Delegating secret storage to user shell commands.** That's fine for CLI power users and wrong for a consumer Mac app. Aplos's Keychain/safeStorage approach is right.
6. **The "filesystem is the IPC" topology** (several processes sharing one SQLite store with lock files) as Aplos's client protocol. It works only on one host. A phone can't open a WAL file (section 7).
7. **Refusing duplicate Message-IDs.** A GUI must cope, for example by keying on provider ID and treating Message-ID as a hint.
8. **Draft-spec churn.** Don't adopt pimdir's format as Aplos's on-disk format while it is a one-maintainer draft that refuses older stores. Borrow the design and keep your own migrations.

### How each known Aplos problem maps

| Aplos problem | What Pimalaya shows |
|---|---|
| Gmail 403 on first sync | Paced batches of 10, one in flight, a quota-unit budget, refusals read from their text, a round with heads (3c). Note that a per-minute quota refusal can arrive labelled only `rateLimitExceeded`. |
| No logging or crash reporting | Log levels and targets plus a log file; exit and status taxonomy. Crash reporting is out of their scope, so Aplos needs `crashReporter` separately. |
| Memory ceiling | Summaries in SQLite, bodies on disk, keyset pages, change feed (3d, 3e). |
| Email HTML in the privileged renderer | **Not addressed.** The CLI renders nothing, and v2 `read` hands rendering to external tools. Content-addressed bodies do make a separate-origin body server easy (section 7). |
| No rules, draft sync or List-Unsubscribe | Sieve rules only. Drafts are plain appends. List-Unsubscribe is only parsed. Little to learn here. |

---

## 7. "Local server" translation

**What Pimalaya actually does.** Its "server" is the store plus a single-owner rule. Owner, readers and producers coordinate through SQLite WAL snapshots, an action queue and lock files, all on one host (`STORAGE.md` §8 forbids network filesystems). Sessions can be shared through sirup's Unix sockets. Background behavior comes from separate long-running processes (carillon for push, a scheduler for Neverest). For the phone, Pimalaya **did not** build a remote client. It **embedded the engine on Android**, with Java owning I/O and SQLite. That choice is evidence that phone-to-desktop-daemon is not the only, or obviously best, mobile architecture.

**Mapping onto an Aplos daemon (`aplosd`).** The idea is to keep the semantics and add the network API Pimalaya never needed.

1. **Owner = the engine daemon.** Today's `src/engine` is already platform-free behind `ports.ts`. Host it in a Node process that holds an exclusive lock on the store directory. Start with the Electron `utilityProcess`. Later, run it as a LaunchAgent registered through `SMAppService`, so it outlives the window. It is the only writer to SQLite and blobs, and it owns sync, the throttle, the outbox and AI enrichment.
2. **Reads = JMAP-shaped methods over localhost.** Keep the existing `POST /api/invoke` + SSE shape from `server.ts`, and make the methods mirror pimdir's reader statements:
   - `threads.page({mailbox, after: [sortKey, seq], limit})` for keyset pages;
   - `thread.get(id)` for summaries plus body *state*;
   - `counts`;
   - `coverage`;
   - `search` against the FTS DB.
   The Electron main process could even read SQLite read-only directly for zero-copy lists, as a pimdir reader does. A phone must use the API.
3. **Realtime = the change feed over the wire.** The SSE or WebSocket channel pushes only `{stamp}` (like a JMAP `StateChange`). The client calls `changes.since(stamp)` and gets changed IDs plus a `purges` counter, then refetches the visible window. This replaces shipping `clone(state)` across two IPC hops, and reconnecting after sleep is a cursor resume.
4. **Writes = the queue.** `actions.enqueue(kind, payload)` returns a queue ID. The daemon applies actions in order. Clients overlay pending actions for instant UI, and `actions.status(id)` or a pushed event reports applied, parked (with reason) or uncertain. Send is an intent with at-most-once semantics. Pre-check capabilities before enqueueing.
5. **Bodies = a separate origin.** List responses never include bodies. `GET /body/<hash>` serves sanitized HTML from a **different origin** (another port or a custom protocol) for a sandboxed `iframe`. Not fetched yet means 202 plus a hydrate action and an event when ready. Content addressing makes caching and ETags trivial. This also takes email HTML out of the privileged renderer.
6. **Auth and transport.** Localhost requires a per-client bearer token, minted by Electron main, alongside the existing Host/Origin checks. For a phone on the LAN: TLS with a self-signed certificate pinned through a QR pairing code (token plus fingerprint), and revocable device tokens. A relay comes later and only end-to-end encrypted. Otherwise it contradicts the "no vendor server" pitch.

**Pros.** A single writer removes Aplos's clone-the-world mutation model and the copies of `AppState` held in several places. Sync, IDLE and the outbox survive window closes and renderer crashes. A CLI, an MCP agent or a phone can drive the same engine. Paging and change feeds bound memory. The protocol is testable without UI.

**Cons.**
- Two processes to ship, sign, update in lockstep and supervise. A daemon that outlives the app needs version negotiation.
- `SMAppService` login-item approval UX.
- Battery and network use while "closed".
- **Still nothing runs while the Mac sleeps**, so a phone through a relay sees stale mail, which is the reason Pimalaya embedded its engine on Android.
- LAN exposure is a real attack surface: pairing, revocation, TLS.
- Two OAuth token holders if the phone ever talks to providers directly.

**Effort (one developer plus agents) [I].**
- (a) Store reshape (summaries, blob bodies, change stamps, keyset pages, separate FTS): **2-3 weeks**. It is needed anyway for the memory ceiling.
- (b) Provider seam reshape plus Gmail round, heads and throttle: **1-2 weeks**. It is needed anyway for the 403.
- (c) Queue receipts, parking and capabilities: **3-5 days**.
- (d) JMAP-shaped localhost API with change-feed push and an auth token, reusing `server.ts`: **1 week**.
- (e) Moving the engine into a LaunchAgent with lifecycle and update coordination: **1-2 weeks**.
- (f) Phone over LAN with pairing and TLS: **2-4 weeks** plus a client app. A relay is a separate project.

Do (a) to (d) in-process first. They pay off immediately and make (e) and (f) optional.

---

## Open questions

- Which reason and message did Aplos's 0.2.3 build actually log for the 403? If it reads `rateLimitExceeded` with "per minute per user" text, it matches Neverest's per-minute quota diagnosis.
- Should Aplos's mobile story embed the engine on the phone (the Pimalaya Android path) or be a client of the Mac daemon? Sleep and staleness argue for embedding. The development cost of two engines argues for the daemon.
- Is pimdir worth tracking as a future *interop* format (for example exporting to it so himalaya and Neverest can read Aplos's replica), once it leaves draft?
