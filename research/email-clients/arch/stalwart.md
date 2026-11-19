# Stalwart (stalwartlabs/stalwart): architecture audit for the Aplos revamp

Date: 2026-10-25. Source: shallow clone of `https://github.com/stalwartlabs/stalwart` at `aa47d8e` ("Pin WebUI to 1.x", 2026-10-18, version 0.16.27), in `/Users/knewton/.t3/aplos-research/src/stalwart`. I only read files. Nothing was installed, built or run. Paths are relative to that clone unless they say otherwise. Aplos paths are relative to `apps/desktop/` in the Aplos repo.

**License: `AGPL-3.0-only OR LicenseRef-SEL`** (`crates/main/Cargo.toml:9`, `LICENSES/`). The core mail, JMAP, IMAP and store code is dual-licensed: AGPL, or the Stalwart Enterprise License (SELv2, a paid subscription priced per mailbox, `LICENSES/LicenseRef-SEL.txt` §1.7, §2.2). 52 source files are SEL-only in their header. They cover SCIM, `common/src/enterprise/*`, composite stores, the LLM spam analyser and some admin mappings. Another 122 `SPDX-SnippetBegin` blocks inside dual-licensed files are SEL-only. The default build enables the `enterprise` feature (`crates/main/Cargo.toml:53`). **Do not copy any code into Aplos.** This report describes ideas in my own words.

Evidence labels: **[V]** means I verified it at the path given. **[I]** means it is my inference.

---

## 1. Overview

**What it is [V].** Stalwart is a single-binary mail and collaboration *server* written in Rust. It speaks JMAP (core, mail, submission, WebSocket, blob, quota, sieve, contacts, calendars, file nodes, sharing, Web Push, email push), IMAP4rev2/rev1, POP3, SMTP in and out, LMTP, ManageSieve, CalDAV, CardDAV and WebDAV (`README.md`; capability list in `crates/jmap-proto/src/request/capability.rs:317-336`). It also has a full MTA, with DKIM, SPF, DMARC, ARC, DANE, MTA-STS and an outbound queue. It has a spam filter, an OAuth/OIDC authorization server, multi-tenancy and clustering. **It is not a mail client, and it does not connect to other mail providers.** Section 3b covers that.

**Maturity and activity [V]** (via `gh api`, 2026-10-25):
- 15,296 stars, 1,016 forks, 54 open issues. The repo was created 2023-03-06 and last pushed 2026-10-20.
- It is still pre-1.0 at **v0.16.27**. 30 releases shipped in 2026, roughly one a week (v0.16.23 to v0.16.27 came between 2026-09-21 and 2026-10-18). The last 12 weeks had 194 commits.
- 57 contributors including anonymous ones, but **one maintainer (mdecimus) wrote 1,741 of 1,852 counted contributions (94%)**. That is an extreme bus factor.
- `AGENTS.md` says outside PRs and issues are closed automatically, LLM-generated contributions are not accepted, and bugs go to `support.stalw.art`. Aplos agents must never open issues or PRs there.
- Size: about 380k lines of Rust under `crates/`. The largest crate is `registry` at 87k lines, auto-generated from a schema (`crates/registry/src/schema/structs_impl.rs:7`). The `tests` crate adds another 83k lines, and `Cargo.lock` lists 941 crates.
- Release binaries for macOS (aarch64 and x86_64) are 36-39 MB compressed and signed with sigstore (`gh api .../releases/tags/v0.16.27`). They are built with `sqlite postgres mysql rocks s3 redis azure nats enterprise` (`.github/workflows/ci.yml:360`).

**Target user.** Self-hosters, ISPs, hosting providers and enterprises that run their own mail domain. The README's selling points are scale ("thousands of nodes"), fault tolerance, Kubernetes, multi-tenancy and SCIM. Nothing targets a single user's desktop.

---

## 2. Feature inventory and maturity

| Feature | State | Evidence |
|---|---|---|
| JMAP core and mail (RFC 8620/8621): get, set, query, changes, queryChanges, import, parse, copy, search snippets | Mature; the reference-grade open-source JMAP server | `crates/jmap/src/email/*`, `crates/jmap/src/changes/*`, `tests/src/jmap/mail/*` |
| JMAP push: EventSource, WebSocket (RFC 8887), PushSubscription and Web Push (VAPID + ECE), "emailpush" | Mature | `crates/jmap/src/api/event_source.rs`, `crates/jmap/src/websocket/`, `crates/services/src/state_manager/{push,ece,http,email_push}.rs` |
| JMAP Calendars (draft), Contacts (RFC 9610), FileNode, Sharing, Principals/availability | Working; drafts are still moving | `crates/jmap/src/calendar_event/set.rs` (1,779 lines), `crates/groupware` |
| IMAP4rev2 with CONDSTORE, QRESYNC, IDLE, UIDONLY | Mature | `crates/imap/src/op/{select,fetch,idle}.rs`, `tests/src/imap/*` |
| CalDAV/CardDAV/WebDAV, iTIP/iMIP scheduling | Mature, still getting interop fixes (latest changelog has an Apple Calendar TZID fix) | `crates/dav`, `CHANGELOG.md` 0.16.27 |
| SMTP MTA (in and out), queue, DSN, send-later (FUTURERELEASE), undo while pending | Mature | `crates/smtp/src/queue/*`, `crates/jmap/src/submission/set.rs:92-129,215-225,643-646` |
| Sieve filtering at delivery (JMAP Sieve, ManageSieve, vacation) | Mature | `crates/email/src/sieve/ingest.rs`, `crates/email/src/message/delivery.rs:196-205` |
| Full-text search, built in or external (Meili, Elastic/OpenSearch, PG, MySQL) | Working, 17 languages | `crates/store/src/search/*`, `crates/nlp/src/*` |
| Spam filter: rules, statistical classifier, DNSBL, Pyzor | Mature | `crates/spam-filter`, `crates/nlp/src/classifier/*` |
| LLM spam and message analysis, plus a Sieve `llm_prompt` function | **Enterprise (SEL) only** | `crates/spam-filter/src/analysis/llm.rs` (SEL header), `crates/common/src/scripts/plugins/llm_prompt.rs:20` |
| Encryption at rest (S/MIME or OpenPGP to the user's public key) | Working | `crates/email/src/message/crypto.rs` |
| OAuth 2.0 server (authorization code, device flow, dynamic registration), OIDC, LDAP, SQL, app passwords, TOTP | Mature | `crates/http/src/auth/oauth/*`, `crates/common/src/auth/oauth/token.rs` |
| Observability: typed events, log file, journald, OpenTelemetry, Prometheus, webhooks, live tracing | Mature | `crates/trc/src/event/enums.rs`, `crates/common/src/telemetry/*` |
| **Pull or sync from an upstream Gmail, Outlook or IMAP account** | **Absent** | No IMAP/Gmail/Graph client code or crate anywhere (§3b) |

---

## 3. Architecture deep dive

### 3a. Process and deployment topology [V]

- **One process, one binary.** `crates/main/src/main.rs` installs the rustls provider and boots config through `BootManager::init`. It runs database migrations (`migration::try_migrate`) and starts services: the task manager, the SMTP queue manager, the state/push manager and the broadcast subscriber. It then spawns one tokio listener per configured protocol: SMTP/LMTP, HTTP, IMAP, POP3 and ManageSieve (`main.rs` "Spawn servers"). Memory is managed by jemalloc.
- **HTTP carries JMAP, DAV, OAuth, the admin API and the web UI.** The admin web UI lives in a separate repo (`stalwartlabs/webui`, React). The server downloads it as a zip from GitHub releases and serves it (`crates/common/src/manager/defaults.rs:30-32`).
- **Pluggable storage, four roles** (`crates/store/src/lib.rs`, enums `Store`, `BlobStore`, `SearchStore`, `InMemoryStore`):
  - The data store is RocksDB (the source default), SQLite, PostgreSQL, MySQL or FoundationDB.
  - The blob store is the data store itself, a filesystem tree, S3 or Azure.
  - The search store is the built-in index on the data store, Meilisearch, or Elasticsearch/OpenSearch.
  - The in-memory store is the data store, Redis or HTTP lists.
- **Clustering.** Nodes coordinate peer-to-peer or over NATS, Kafka, Redpanda, Redis or Zenoh (`crates/coordinator`, `crates/services/src/broadcast/*`). Push notifications and cache invalidations are broadcast between nodes.
- **Configuration lives in the database** (the "registry"). It is administered **through JMAP itself**, under a private capability `urn:stalwart:jmap`: `crates/jmap/src/registry/{get,set,query}.rs`, with method dispatch in `crates/jmap/src/api/request.rs`. The REST surface is small: login, account introspection, the config schema and SSE telemetry. The OpenAPI file says outright that most management happens via JMAP (`api/v1/openapi.yml:4-9`). **This is a strong existence proof that JMAP's get/set/query/changes framework generalizes beyond mail objects.**

### 3b. Connectivity per mail provider [V unless noted]

**Stalwart is the provider. It has no client side for other providers.**
- Searching the crates for an IMAP client, Gmail, Graph or fetchmail-style code finds nothing. The only hits for "gmail" are test fixtures in `spam-filter/src/modules/pyzor.rs` and a domain list in `store/src/backend/http/lookup.rs:51`.
- None of the `Cargo.toml` files depends on an IMAP client library.
- **It cannot proxy or sync Gmail, Outlook or upstream IMAP natively.** Mail enters a Stalwart account only through:
  - SMTP/LMTP delivery, which needs MX records pointing at the box;
  - JMAP `Email/import` of an uploaded blob (`crates/jmap/src/email/import.rs`);
  - IMAP `APPEND`.
- **Outbound relay through a smarthost is supported**, including SASL XOAUTH2 and OAUTHBEARER (`crates/smtp/src/outbound/client.rs:49,663`). But the relay credential is a static value in `RelayConfig.auth` (`crates/common/src/config/smtp/queue.rs:181-188`), and nothing refreshes Google tokens. A one-hour Google access token would therefore break, so relaying through Gmail SMTP would only work with an app password [I].
- **Auth for its own clients:**
  - Basic auth, an OAuth 2.0 server (authorization code with PKCE, device flow, dynamic client registration with loopback redirect URIs; see the 0.16.27 changelog), OIDC, LDAP, SQL, app passwords and TOTP.
  - IMAP, POP3 and SMTP accept XOAUTH2 and OAUTHBEARER from clients (`crates/pop3/src/protocol/request.rs:308-310`).
  - **Access tokens are stateless.** The server serializes a compact payload: account, grant type, issued-at, expiry, a credential version and optional claims. It seals the payload with an AEAD under a server key, binds the account name as associated data, and base64url-encodes the result (`crates/common/src/auth/oauth/token.rs:43-74,128-146`).
  - Validation checks expiry and grant type. For long-lived tokens it also compares the credential version against the account's current version, so **bumping one counter revokes every token** (`token.rs:78-111`).
- **Mail at rest** can optionally be encrypted with the user's own S/MIME or OpenPGP public key when it is ingested (`crates/email/src/message/crypto.rs`; the `is_encrypted` branch at `ingest.rs:508,565`). The server then cannot read those bodies [I: so it cannot index them either; `ingest.rs:627` gates indexing on `!is_encrypted`].

### 3c. Sync algorithm (the server side of JMAP and IMAP sync) [V]

Stalwart has no upstream sync. It is, however, the best open reference for the *server* half of incremental sync, which is the half an Aplos daemon would expose to its own UI and to a phone.

1. **One change counter per account, bumped in the same transaction as the data.**
   - The SQLite backend opens an `IMMEDIATE` transaction. For each account in the batch it increments a counter row and reads the new value with a single upsert-returning statement (`crates/store/src/backend/sqlite/write.rs:25-47`).
   - It then writes the object rows and a change-log row keyed by account, collection and change id, all in the same transaction.
   - The counter never goes backwards, document IDs come from a separate monotonic counter and are never reused (`crates/store/src/dispatch/store.rs:197-209`), and one change ID serves JMAP state, IMAP MODSEQ and DAV sync tokens [I for DAV].
2. **The change log stores IDs, not diffs.**
   - Each log entry records counts and IDs of container (mailbox, calendar) and item (email, event) inserts, updates, property-only updates and deletes (`crates/store/src/query/log.rs:17-26,240+`).
   - Clients re-fetch the objects that changed. For mailboxes, an update that only changed counts is reported through `updatedProperties`, limited to `totalEmails`, `unreadEmails`, `totalThreads` and `unreadThreads` (`crates/jmap/src/changes/get.rs` tail). This saves the client from re-fetching the whole mailbox.
   - A separate "vanished" log supports IMAP QRESYNC `VANISHED` (`log.rs:136-185`).
3. **State strings encode the change ID** (`crates/jmap-proto/src/types/state.rs`). There are three forms:
   - `n` means initial.
   - `s` plus a base32-encoded variable-length integer means an exact change ID.
   - `r` plus (from, to, items sent) is an *intermediate* state. When `maxChanges` cuts a response short, the client gets `hasMoreChanges:true` and an `r…` state that resumes in the middle of the same range (`changes/get.rs` tail). The server stores no cursor; the state string is the cursor.
4. **Retention and resets.**
   - The log keeps at most `maxChangesHistory` entries per collection, 10,000 by default (`crates/registry/src/schema/structs_impl.rs:6614`).
   - When the purge job trims the log, it writes an empty-valued marker row (`crates/common/src/storage/transaction.rs`, `delete_changes`). Any reader that hits the marker gets `cannotCalculateChanges` with the reason "Change log is truncated" (`changes/get.rs`). The client must then resync.
   - The server's own in-memory cache also rebuilds from scratch when it sees the marker (`crates/email/src/cache/mod.rs`, the `is_truncated` branch).
5. **`queryChanges` is recomputed, not stored.** Stalwart computes `/changes` since the old state, re-runs the query, and diffs the result to produce `removed` and `added` with indexes (`crates/jmap/src/changes/query.rs`). If neither the filter nor the sort depends on mutable fields, it can shortcut.
6. **Push is a doorbell, not a payload.**
   - `commit_batch` (`crates/common/src/storage/transaction.rs:19-60`) runs after every committed write. It builds a `StateChange`: the account, a bitmap of changed data types and the new change ID. It then broadcasts it.
   - The state manager fans it out to every subscriber:
     - **EventSource** (`crates/jmap/src/api/event_source.rs`): filter by `types`, optional `closeafter=state`, and a `ping` interval with a 30 s minimum. State changes are coalesced per account and type, and sent at most once per `event_source_throttle`, default 1 s (`structs_impl.rs:23300`).
     - **WebSocket** (`crates/jmap/src/websocket/stream.rs`): request/response JMAP over one socket plus `PushEnable` by type. There is a 1 s throttle, a 60 s heartbeat and a 10 min idle timeout (`structs_impl.rs:23308-23310`). `pushState` is parsed (`jmap-proto/src/request/websocket.rs:56`) but the handler ignores it. After a reconnect the client calls `/changes` and does not replay missed pushes.
     - **Web Push** to a `PushSubscription` URL: the subscription is verified with a code, payloads are encrypted (aes128gcm), and VAPID is supported. Delivery gets 3 attempts with backoff and a 1 s throttle, and payloads are capped at 4 KB (`state_manager/{push,ece,http}.rs`; defaults at `structs_impl.rs:23301-23314`).
     - **"emailpush"** puts selected email fields in the push payload itself, for notification previews (`state_manager/email_push.rs`).
   - The same push channel carries **calendar alerts** (`event_source.rs`, `PushNotification::CalendarAlert`).
7. **Concurrency control is optimistic.** Stored values are versioned archives tagged with a change ID and hash (`crates/store/src/write/mod.rs:44`). A write batch can assert that a value hasn't changed, and fails with `AssertValueFailed` if it has (`sqlite/write.rs:247-269`). JMAP `ifInState` is built on this. Background jobs such as thread merges retry when an assert fails (`crates/services/src/task_manager/merge_threads.rs`, `continue 'retry`).
8. **A durable background task queue.**
   - Tasks are written into the database **in the same write batch** as the data that caused them. Ingesting a message, for example, schedules `IndexDocument`, and `MergeThreads` when needed (`crates/email/src/message/ingest.rs:650-695`).
   - A due-time index orders tasks. Each task type has its own worker channel, tasks are locked with expiry, and retries use fixed-delay or exponential-backoff strategies with a maximum attempt count (`crates/services/src/task_manager/{mod,manager}.rs`, lines 517-650).
   - Task types include FTS indexing, thread merging, spam-classifier training, calendar alarms, iMIP, DKIM rotation, ACME and account destruction.
9. **Rate limiting is applied *to* clients**, not to upstream providers. Defaults (`structs_impl.rs:23281-23315`):

   | Limit | Default |
   |---|---|
   | Concurrent requests | 4 |
   | Method calls per request | 16 |
   | Request size | 10 MB |
   | Objects per get / per set | 500 / 500 |
   | Changes per response | 5,000 |
   | Query results | 5,000 |
   | Upload size / upload quota | 50 MB / 50 MB |
   | Upload TTL | 1 h |

   The only upstream-style retry logic is SMTP delivery (retry, notify and expire schedules per recipient, `crates/smtp/src/queue/mod.rs:139-141`) and Web Push delivery.
10. **Outbox.** `EmailSubmission/set` puts the message into the persistent SMTP queue. It supports send-later (`hold_for`/`hold_until` → `sendAt`) and undo while `undoStatus` is `pending`, which removes the queued message (`submission/set.rs:92-129,215-225,643-646`).

### 3d. Local storage [V]

**Engine.** Every backend is a sorted key-value store, and even SQLite is used that way. `SqliteStore::create_tables` makes one table per *subspace*, named by a single letter. Most have the shape `k BLOB PRIMARY KEY, v BLOB`; the index tables are key-only, and the counter tables hold an integer `v` (`crates/store/src/backend/sqlite/main.rs:62-120`). Pragmas: WAL, `synchronous=NORMAL`, in-memory temp store, 30 s busy timeout. An r2d2 pool runs on a rayon worker pool.

**Subspaces** (`crates/store/src/lib.rs:100-127`):

| Letter | Contents |
|---|---|
| `p` | Object properties |
| `i` | Secondary indexes |
| `l` | Change logs |
| `t` / `k` | Blobs / blob links |
| `n` | Counters (change ID, document ID) |
| `u` | Quotas |
| `f` | Task queue |
| `z` | Search index |
| `a` | ACLs |
| `e` / `q` | SMTP queue messages / queue events |
| `o` / `x` | Telemetry spans / metrics |
| `s` / `b` / `g` | Registry (config) |
| `j` | Deleted-item archive |
| `w` | Spam samples |

**Keys** are big-endian `(account_id u32, collection u8, document_id u32, field u8, …)`. Values are **rkyv zero-copy archives**, which can be read without a parse step.

**Per-email records** (`crates/types/src/field.rs:40-45`, `crates/email/src/message/metadata.rs:26-50`):
- **Archive (mutable, small):** mailbox memberships with each mailbox's IMAP UID, keywords, thread ID and size. This is the only part that changes when the user archives, flags or reads.
- **Metadata (immutable):**
  - the parsed MIME part tree with byte offsets into the raw message;
  - decoded header values;
  - the raw header bytes;
  - a precomputed **preview**;
  - the blob hash and the offset where the body starts;
  - a received/attachment bitfield.
- **Threading index:** hash(normalized subject) → (thread ID, list of message-ID hashes) (`ingest.rs:1003-1013`).
- **The raw RFC 822 message is the source of truth.** It is stored once in the blob store, content-addressed by **BLAKE3** (`crates/types/src/blob_hash.rs:33-35`).

`Email/get` only reads the blob when the client asks for body parts, body values or the body structure. Lists of senders, subjects, previews, keywords and mailbox IDs are served from Metadata plus the cache (`crates/jmap/src/email/get.rs:136-200`).

**Blobs.**
- Compression is optional LZ4, with a one-byte marker (`crates/store/src/dispatch/blob.rs:107-135`).
- The filesystem backend fans files out by hash prefix up to 5 levels deep (`crates/store/src/backend/fs/mod.rs`).
- A blob is kept alive by *link* records (`crates/store/src/write/mod.rs:364-374`): one per owning document, *temporary* reservations with an expiry (uploads live 1 h), and links to registry objects.
- A mark-and-sweep purge runs over 256 hash shards. It deletes blobs with no live link and their keys (`crates/store/src/write/blob.rs`, `purge_blobs`). Identical attachments and messages are therefore stored once per server.

**Hot in-memory index** (`crates/common/src/lib.rs:211-250`, `crates/email/src/cache/mod.rs`):
- Each account gets an immutable snapshot holding one small record per message: document ID, (mailbox, UID) pairs, a **128-bit keyword bitset** plus a per-account keyword name table, thread ID, change ID and size. Mailboxes are cached the same way.
- Nothing else is held: no bodies, no headers.
- On access, the server reads the change log since the cache's last change ID. It applies only the changed items, then publishes a new snapshot behind an update lock. If the log was truncated, it rebuilds from scratch.
- All accounts share a weighted LRU, 50 MB by default (`structs_impl.rs:4412`), and the server warns when one account doesn't fit. All default cache budgets add up to about 190 MB, which is a ceiling rather than resident memory.
- [I] At roughly 80-100 bytes per message, the 50 MB default covers about half a million messages.

**Search.**
- The built-in engine stores an inverted index in the KV store. Terms are hashed, and each term carries a bitmask of the fields it appears in (from, to, cc, bcc, subject, body, attachment, headers).
- Stemmed forms are indexed alongside exact words, the language is detected automatically, and there are separate tokenizers for Chinese and Japanese (`crates/store/src/search/term.rs`, `crates/nlp/src/{language,tokenizers}`).
- Query evaluation combines roaring bitmaps from the search index with bitmaps computed from the in-memory cache (mailbox membership, keywords, thread-level keyword rules) (`crates/jmap/src/email/query.rs`).
- Indexing is **asynchronous** through the task queue, so search is eventually consistent.

**Migrations.** A `migration` crate runs at startup and aborts boot if it fails (`main.rs`; `crates/migration/src/v016.rs`). Breaking upgrades are documented in `UPGRADING/`. The source still carries "remove in v1.0" legacy subspaces (`lib.rs:129-131`).

### 3e. The API between UI and engine [V]

The "UI API" is JMAP over HTTP (`crates/http/src/request.rs:98-230`):

| Route | Purpose |
|---|---|
| `POST /jmap/` | A batch of method calls with **back-references** (`#ids` result references, `#creationId`), resolved in order by `response.resolve_references` (`crates/jmap/src/api/request.rs`). Each call is checked against the `using` capability list. |
| `POST /jmap/upload/{accountId}` | Returns a temporary `blobId` |
| `GET /jmap/download/{accountId}/{blobId}/{name}?accept=<type>` | Downloads a blob as the content type the client asks for |
| `GET /jmap/eventsource` | Push over SSE |
| `GET /jmap/ws` | JMAP over WebSocket |
| `/.well-known/jmap` | Redirects to the session resource |

Some responses are served with unrestricted CORS (`with_cors_unrestricted`).

**Pagination** uses JMAP query semantics: `position` or `anchor` + `anchorOffset`, `limit`, `collapseThreads` and `calculateTotal`. A query returns only IDs and a `queryState`, and the client follows up with `get` for the properties it needs (`email/query.rs`). **Realtime updates** are the state-change doorbell plus `/changes` (§3c).

### 3f. Send, drafts, threading, labels, calendar, contacts, AI [V]

- **Send.** `EmailSubmission/set` puts the message in Stalwart's own SMTP queue, which delivers directly to MX or through a relay. `onSuccessUpdateEmail`/`onSuccessDestroyEmail` atomically move the email from Drafts to Sent and drop `$draft` (CHANGELOG 0.16.26 fixes a bug in exactly this path). Send-later and undo are covered in §3c.
- **Drafts** are ordinary Emails with the `$draft` keyword in the mailbox whose role is `drafts`. There is no separate draft object.
- **Threading** (`crates/email/src/message/ingest.rs:163-205,736-829`):
  - A message joins a thread only if it has the same **normalized subject** *and* shares at least one Message-ID / In-Reply-To / References / Resent-Message-ID hash with it.
  - When a new message connects several threads, Stalwart picks a surviving thread ID and schedules a durable `MergeThreads` task. The task moves the emails, logs the deleted threads, and retries on concurrent modification (`crates/services/src/task_manager/merge_threads.rs`).
  - Email IDs are `(thread_id << 32) | document_id`, but lookups use only the low 32 bits (`crates/types/src/id.rs:123-140`; `email/get.rs`).
  - **Consequence for Aplos [I]:** if Gmail mail were imported, Stalwart would recompute threads with this rule. `Email/import` doesn't accept a `threadId` (`crates/jmap-proto/src/method/import.rs:34-39`), so Aplos's threads would drift from Gmail's.
- **Labels and folders.** JMAP `mailboxIds` is a set, so one email can sit in several mailboxes. That maps naturally onto Gmail labels. Mailboxes have roles (inbox, drafts, sent, junk, trash, archive). Keywords cover `$seen`, `$flagged`, `$draft` and custom ones.
- **Calendar and contacts.** JMAP Calendars and CalDAV with iTIP/iMIP scheduling. Alarms run as durable tasks and are pushed as `calendarAlert` events (`crates/services/src/task_manager/alarm.rs`, `event_source.rs`). JMAP Contacts (RFC 9610) and CardDAV.
- **Rules.** User Sieve scripts run on *delivery* only, meaning SMTP/LMTP (`crates/email/src/message/delivery.rs:196-205`), not on `Email/import` [I from code path].
- **AI.** In the enterprise edition an LLM classifies spam. The prompt is configured, the body is sent with the subject, and the model's delimited reply is parsed into category, confidence and a 255-character explanation (`crates/spam-filter/src/analysis/llm.rs`, SEL-only). Sieve also has an enterprise `llm_prompt` extension. The open (AGPL) part is a statistical classifier (FTRL/Adam/SGD, `crates/nlp/src/classifier/*`) that trains continuously from user moves to and from Junk.

---

## 4. Engineering quality [V]

- **Tests.**
  - 466 `#[test]`/`#[tokio::test]` functions inside crates.
  - 96 test entry points in the `tests` crate. Each drives a large protocol scenario: JMAP mail `changes`, `query_changes`, `thread_merge`, `submission`, `event_source`, `websocket`, `push_subscription`; IMAP `condstore`, `idle`, `thread`; plus SMTP, DAV, directory and store tests (`tests/src/jmap/*`, `tests/src/imap/*`).
  - The suite needs external services (OpenLDAP, Keycloak, PostgreSQL, MySQL, Redis, NATS, per `.github/workflows/test.yml`).
- **CI.**
  - `test.yml` (fmt check, then protocol tests on RocksDB) runs **only on manual dispatch**.
  - `ci.yml` runs on version tags. It builds a large target matrix and Docker images, signs with cosign, and attaches build-provenance attestations.
  - Trivy and OpenSSF Scorecard workflows exist.
  - There is no per-push test gate in public CI. The maintainer presumably runs tests locally [I].
- **Code organization.**
  - Wire-format crates (`jmap-proto`, `imap-proto`, `dav-proto`, `http-proto`, `scim-proto`) are separate from behaviour crates.
  - `store` is a backend-neutral KV abstraction. `email`/`groupware` hold the domain logic, `services` holds background work, and `common` holds the server core and configuration.
  - The large config surface is generated from a schema (`registry`).
  - Lints include `clippy::large_futures` and cast-truncation lints (`crates/main/src/main.rs:6-9`).
- **Observability** (the standout).
  - The `trc` crate defines one typed event taxonomy: 43 categories (`Jmap`, `Store`, `MessageIngest`, `PushSubscription`, `TaskManager`, `Ai`, …), each an enum with **stable numeric IDs** (`crates/trc/src/event/enums.rs:13-57`).
  - Errors *are* events. They carry key/value context and a `caused_by(trc::location!())` chain, which acts as a cheap stack trace through async code.
  - Events go to configurable sinks: a log file, stdout, journald, OpenTelemetry, webhooks, and a store for live tracing in the admin UI (`crates/common/src/telemetry/tracers/*`). Prometheus metrics are also available.
  - Hot paths emit timed events, for example cache hit/miss/stale with elapsed time and item counts (`crates/email/src/cache/mod.rs`).
- **Governance risk.** One maintainer, closed contributions, and breaking changes in point releases on a 0.x line (for example, the 0.16.26 x86-64-v2 CPU requirement).

---

## 5. UI notes

Stalwart has **no end-user mail UI**. Its admin web UI (`stalwartlabs/webui`, AGPL/SEL) is React 19 + Vite, Radix, Tailwind 4 with `tw-animate-css`, TanStack Query, zustand and `cmdk` (its `package.json`, via `gh api`). It has no motion library and no keyboard model worth studying. Nothing here informs the UI workstream.

---

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **A persistent, per-account change counter, committed in the same SQLite transaction as every data write**, plus a change-log table of (collection, change ID, created/updated/destroyed IDs).
   - This replaces Aplos's per-run `{epoch, rev}` (`src/shared/live.ts`). The epoch resets whenever the engine restarts, which forces every window to resnapshot.
   - A persisted counter lets any client, including a phone that was offline for a day, catch up with one `changes` call.
2. **Opaque state strings with an "intermediate" form**, so a capped `changes` response can resume mid-range without server-side cursors. Expose a hard per-call cap, since Stalwart uses 5,000.
3. **Bounded change-log retention with an explicit truncation marker that forces `cannotCalculateChanges`.** This is the honest version of the `reset:true` signal Aplos's adapters already emit and the engine ignores. Make "full resync" a first-class code path for the engine (towards providers) *and* for its own clients.
4. **Push as a doorbell.** Send `{account → {type → newState}}`, coalesce per type, throttle to about 1 s, and let clients pull. This keeps the push channel tiny, ordering-agnostic and safe to drop. It is the right shape for SSE to the Electron renderer and later Web Push or APNs to a phone.
5. **Split each message into three tiers:**
   - a tiny mutable record (labels/mailboxes, flags, thread, size);
   - an immutable parsed-metadata record (headers, preview, MIME tree with byte offsets);
   - a raw RFC 822 blob, content-addressed on disk.

   List views never touch blobs. This directly answers Aplos's memory ceiling and the "JSON blob per thread" design.
6. **A small in-memory hot index** of about 100 bytes per message (id, thread, mailbox set, keyword bitset, date, change ID), rebuilt incrementally from the change log and kept separate from bodies. Filters and counts come from this index, and everything else is fetched by ID.
7. **Content-addressed blobs with link records and periodic garbage collection.** One file per hash. Links come from owning messages, plus "temporary" links with an expiry for uploads and compose attachments. A sweep deletes anything unlinked. This gives deduplication, safe concurrent writes, and an obvious eviction story: drop bodies of old mail and re-fetch on demand.
8. **Raw MIME as the normalized storage format across providers** [I]. IMAP gives RFC 822, Gmail gives `messages.get?format=raw`, Graph gives `$value`, and JMAP gives a blob download. One local MIME parser then produces the metadata tier, which removes per-provider body-shape bugs. Fetch raw lazily, on open or in a low-priority lane, after a metadata-first pass.
9. **A durable task queue written in the same transaction as the data that caused it**, with per-type workers, due times, locks and exponential retry. Aplos needs exactly this to move AI summaries, FTS indexing, unsubscribe probing and calendar extraction off the sync path (SYNTHESIS weakness 4).
10. **Query returns IDs plus `queryState`; get returns properties; `queryChanges` is computed by re-running the query and diffing.** Don't store query results. This fixes Aplos's "page in every thread to the renderer".
11. **Batched method calls with back-references**, for example query → get thread → get emails in one round trip. This matters once the UI is a network client (phone, browser preview) rather than an IPC client.
12. **Optimistic concurrency** (`ifInState`, or a version per object) for multi-client writes. The Mac UI and the phone will both edit workflow state.
13. **A typed event catalog for observability.** Use stable event IDs, structured context, a "caused by" location chain, and pluggable sinks starting with a rotating, redacted log file. This is the most transferable engineering pattern here and it addresses Aplos's "no logging" gap directly.
14. **Stateless, AEAD-sealed bearer tokens with a credential version for revocation** when the daemon starts accepting a phone: pair once, mint a token, and revoke every token by bumping one counter.
15. **Mailbox counts as "property-only" changes**, so clients don't refetch mailboxes on every flag change.
16. **Use a real Stalwart instance as a development and test fixture** [I]. Running it in Docker *outside* the shipped app avoids AGPL distribution concerns. It gives Aplos a real IMAP+CONDSTORE/QRESYNC/IDLE, JMAP+EventSource, CalDAV and CardDAV server to test `imap.ts`, `jmap.ts` and `caldav.ts` against, beyond fakes. This is still not live acceptance for iCloud or Fastmail.

### Avoid

1. **Don't embed Stalwart as Aplos's mailbox store** (see §7, Option A). It cannot sync upstream, it would re-thread Gmail mail differently from Gmail, its send path is an MTA rather than "send via Gmail", and it adds a 36-40 MB AGPL/SEL Rust server, plus its config registry, to a two-week-old Electron app.
2. **Don't copy the server's attack surface.** An Aplos daemon should not expose SMTP, IMAP or POP3 listeners, an ACME client, or DNS management. It should bind loopback by default and expose one authenticated HTTP endpoint.
3. **Don't push payloads by default.** Stalwart's "emailpush" exists for mobile previews, but full-object push breaks ordering and resync guarantees. Keep content push as an opt-in notification feature only.
4. **Don't compute threads locally for Gmail or Graph.** Use the provider's thread ID where one exists. Stalwart's subject-plus-references rule (with a merge task) is a reasonable fallback for IMAP only.
5. **Don't treat `pushState` as replay.** Even Stalwart ignores it. After any reconnect, call `changes`.
6. **Don't rely on Sieve-at-delivery for rules.** In Aplos's world mail arrives by sync, not SMTP, so local rules must run in the sync or ingest path, or better as provider-side filters.
7. **Don't run full RFC 8621 compliance as a goal.** Header forms, `Email/parse`, body-structure fidelity and per-method ACLs are a lot of surface for one developer. Borrow the method framework and semantics, not the whole spec (§7).
8. **Don't imitate the governance.** A 94% single-maintainer project with manual-dispatch tests is not a model. Aplos already has better per-push CI.

---

## 7. "Local server" translation for Aplos

There are three ways Stalwart could map onto an Aplos engine running as a local daemon. They are ranked worst to best for Aplos.

### Option A: run Stalwart locally as Aplos's store (not recommended)

**Shape.**
- Ship the Stalwart binary inside the app (or as a launchd agent) with SQLite, bound to `127.0.0.1`, and with every listener off except HTTP.
- Aplos's existing adapters (`google.ts`, `microsoft.ts`, `imap.ts`, `jmap.ts`) become an "import bridge". They upload raw messages, call `Email/import` with mailbox IDs and keywords, and map labels to mailboxes.
- The bridge watches Stalwart's `Email/changes` and replays user actions upstream.
- The UI and the phone speak standard JMAP to Stalwart.

**Why it fails for Aplos:**
- **No upstream sync.** Every hard problem stays in Aplos's adapters, and now it is a *two-hop* sync: provider ↔ bridge ↔ Stalwart.
  - The bridge needs an id-mapping table and loop suppression, because Stalwart's change log doesn't record *who* made a change.
  - It also has to resolve conflicts across two change logs.
- **Thread drift.** Imported mail is re-threaded by Stalwart's subject-and-references rule, and Gmail's `threadId` cannot be imposed (§3f).
- **Send.** `EmailSubmission` delivers through Stalwart's MTA. For Gmail and Outlook that is wrong: Sent copies, DKIM and SPF alignment, and OAuth token refresh (`RelayConfig` credentials are static) all break. Aplos would have to bypass submission and reimplement sending outside Stalwart anyway.
- **AI, workflow state (Done/Later), summaries, and Ask** have no home except custom JMAP objects. That would mean modifying Stalwart, with AGPL §13 obligations once a phone talks to it over a network [I; get legal advice].
- **Footprint and ops.** A second runtime (Rust), another 36-40 MB compressed, its own migrations on a fast-moving 0.x line, a config registry, and the enterprise build flag question. All of this is for a server whose best features (MTA, spam, DKIM, multi-tenancy, clustering) Aplos would switch off.
- **Effort:** 4-8 weeks just to reach parity, with a permanently more complex failure surface [I]. **Verdict: no.**

### Option B: a JMAP-shaped Aplos engine API, without Stalwart (recommended)

Keep Aplos's TypeScript engine and adapters. Re-cut its *outward* API and its storage along Stalwart's lines.

**Wire shape** (served by the engine on `127.0.0.1:<port>`; the same routes back the Electron renderer, the browser preview and later a phone):
- `GET /session`: accounts, capabilities, the upload/download/push URL templates, and an overall session state. Mirror JMAP's session object.
- `POST /api`: `{using, methodCalls:[[name, args, callId]…]}` with JMAP-style result references.
  - Standard methods: `Mailbox/get|changes`, `Thread/get|changes`, `Email/get|query|queryChanges|changes|set`, `EmailSubmission/set` (which calls the provider's send API), `Identity/get`, `CalendarEvent/*`.
  - Aplos-private objects under an `urn:aplos:*` capability: `ThreadState` (Done/Later/snooze/to-do), `Summary`, `AiJob`, `Rule`, `Setting`, `SyncStatus`. This is how Stalwart exposes its config (§3a).
- `POST /upload`, and `GET /download/{account}/{blob}/{name}?accept=`. Serving email HTML and inline images from this origin lets the reader put the message in a sandboxed `<iframe>` with no access to `window.aplos`. That addresses the HTML-in-privileged-renderer risk [I].
- `GET /events` (SSE, for the renderer) and `GET /ws` (WebSocket, for the phone). Both send coalesced `{account: {Type: state}}` doorbells, throttled to 1 s, with pings.

**Engine internals that make it work:**
- **SQLite tables (columns, not JSON blobs):**

  | Table | Columns |
  |---|---|
  | `account` | — |
  | `change_counter` | account, value |
  | `change_log` | account, collection, change_id, created[], updated[], destroyed[] |
  | `mailbox` | — |
  | `message` | local_id, account, provider_id, thread_id, received_at, size, keyword bits/labels, change_id |
  | `message_meta` | parsed headers, preview, part tree with byte offsets, blob_hash |
  | `thread` | local_id, provider_thread_id |
  | `thread_state` | — |
  | `blob_link` | hash, owner or `temp_until` |
  | `task` | id, type, due, attempts, payload, lock |
  | `provider_cursor` | — |
  | FTS5 | indexed by integer rowid, which also fixes the `UNINDEXED` delete scan |

- **Every engine write** (local action or provider sync) runs in one transaction. It bumps `change_counter`, appends `change_log`, and enqueues tasks. After commit, the engine rings the doorbell. Aplos's existing staged-memory transaction (`memory-stage.ts`) already has the right instinct.
- **Raw bodies** go in `~/Library/Application Support/Aplos Mail/blobs/ab/cd/<hash>`, fetched lazily, with eviction by age or size and re-fetch on open.
- **The hot index** (the `message` rows without meta) can stay in memory. The renderer holds only the query window it is displaying.

**The phone.**
- **LAN:** advertise over Bonjour, pair by QR code to mint an AEAD-sealed token carrying a credential version (Stalwart's token scheme, §3b), and serve TLS with a self-signed certificate pinned at pairing.
- **Away from home:** a relay (Tailscale, or a dumb encrypted relay) carries the same JMAP-shaped traffic.
- **Notifications** need APNs from somewhere that is awake. That is a product decision Stalwart can't answer, because its Web Push assumes the server is reachable and always on.

**Pros:**
- One API for the renderer, the browser preview and the phone.
- Restart-proof incremental sync for every client.
- A natural home for lazy bodies, eviction and paging.
- Push stays tiny and lossy-safe.
- Aplos's `jmap.ts` adapter becomes close to a pass-through for Fastmail and other JMAP providers.
- Off-the-shelf JMAP client libraries and tools work for debugging.
- There's a credible future path to "any JMAP client can read your Aplos mailbox".

**Cons:**
- JMAP is message-centric while Aplos's UI is thread-centric. Thread-level workflow state and summaries need custom objects, and Home ordering needs a custom query.
- `queryChanges` by re-running queries is O(result set) per call, which is fine locally.
- The method-call envelope is more ceremony than plain `invoke(method,payload)` for a solo developer.
- An authenticated localhost server is new attack surface. Electron's IPC currently has no network exposure.

**Effort** for one developer plus agents (rough [I]):

| Step | Estimate |
|---|---|
| Persistent change counter + change log + state strings + `X/changes` for threads and mailboxes, plus resync on truncation and on provider `reset` | 4-6 days |
| Storage split (message/meta/blob tiers, lazy raw fetch, eviction), replacing JSON thread rows and the whole-mailbox clone. Overlaps the already-planned memory fix | 2-3 weeks |
| Durable task queue with AI and FTS moved onto it | 3-5 days |
| `Email/query` + `get` + paging, and rewiring the renderer to fetch query windows (UI workstream) | 1-2 weeks |
| SSE doorbell, then WebSocket | 2-4 days |
| Daemon packaging (keep `utilityProcess` for now, or a launchd agent), token auth, pairing, LAN TLS | 1-2 weeks, can wait for the phone |
| **Total** | **about 6-9 weeks**, most of which is already on the roadmap as the memory and sync rework |

### Option C: Stalwart as a test double only (recommended alongside B)

Run Stalwart in Docker in CI or on the developer's Mac, as a *real* IMAP, JMAP, CalDAV and CardDAV server for adapter integration tests, seeded with original demo mail. This exercises CONDSTORE/QRESYNC, IDLE, `Email/changes` with `maxChanges` and truncation, EventSource and CalDAV sync against a spec-faithful implementation. It costs nothing to ship because it never ships. **Effort:** 2-4 days for a compose file, a seed script and a test lane [I]. Because Stalwart is AGPL, keep it out of the app bundle. Remember it is not live acceptance for any commercial provider.

---

## Open questions

- Should Aplos's API be strictly JMAP-compatible (so third-party JMAP clients work) or only JMAP-shaped? Strict compatibility costs RFC 8621 body/header fidelity work. JMAP-shaped is cheaper but gives up ecosystem reuse.
- Is `Email` or `Thread` the primary query object for Aplos's Home and Inbox? JMAP's `collapseThreads` over Emails works, but Aplos's thread-level workflow state may make a custom `Thread/query` simpler.
- Should the daemon stay an Electron `utilityProcess`, or become a launchd agent that runs while the window is closed (sync, reminders, IDLE)? The second is closer to the "local server" goal but changes lifecycle, updates and Keychain access.
- How does a phone get notifications when the Mac is asleep? This needs APNs plus an always-on component, which is the same limit SYNTHESIS calls Aplos's hard ceiling.
- AGPL: if a future Aplos ever bundled any Stalwart component, what are the network-use obligations once a phone connects? Get legal advice. Option B avoids the question.
