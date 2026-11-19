# Delta Chat core (chatmail/core): architecture audit for the Aplos revamp

2026-10-25. This is a read-only review of a shallow clone of `chatmail/core` at `4ad5332` (2026-10-24, version `2.66.0-dev`) in `/Users/knewton/.t3/aplos-research/src/deltachat-core`. A second shallow checkout of tag `v2.49.0` (`dab7ca1`, 2026-04-13) is in `/Users/knewton/.t3/aplos-research/src/deltachat-core-v2.49`. I needed it because the features this audit was asked about (OAuth, the provider database, multi-folder watching) were **deleted from the core between May and September 2026**. A few facts about the Delta Chat Desktop UI come from the GitHub API, without cloning. Nothing was built or run.

**[V]** means verified in code, in the changelog or through the GitHub API. **[I]** means inference. Paths without a prefix are relative to the HEAD clone. `v2.49:` marks the old tag. The core is **MPL-2.0** (`LICENSE`; GitHub reports `NOASSERTION` because of the custom preamble). MPL is file-level copyleft. Delta Chat Desktop is **GPL-3.0**. Everything below is ideas only, and no code has been copied.

Prior research (`research/inbox-zero/*`, `research/email-clients/arch/*`) covers Aplos itself, so this report only compares against it.

---

## 0. The headline: the brief's premise is out of date

The brief describes Delta Chat core as a general IMAP engine with "multiple folders, OAuth for Gmail/Outlook IMAP, [and a] provider database". That was true of older releases. In 2026 the project renamed itself "chatmail core" and deliberately cut itself down to a **chat-over-email engine optimised for its own "chatmail" relay servers**. **[V]** (CHANGELOG):

| Release | Date | Removed |
|---|---|---|
| 2.50.0 | 2026-05-22 | The "DeltaChat" move-folder. **Each transport now watches exactly one folder.** Also the `show_emails` and `delete_server_after` options |
| 2.54.0 | 2026-07-20 | `sync_seen_flags()`, the CONDSTORE flag sync |
| 2.56.0 | 2026-07-21 | **All OAuth2 support** (module, FFI, JSON-RPC fields) |
| 2.57.0 | 2026-07-25 | **The provider database** and lookup APIs, plus heartbeat push |
| 2.62.0 | 2026-09-22 | All code that moves messages between IMAP folders |

Gmail and Outlook IMAP were already dead before the purge:
- In `v2.49:src/oauth2.rs` only one OAuth authorizer is left (Yandex). Its test says verbatim: "Delta Chat does not have working Gmail client ID anymore."
- The v2.49 provider DB lists Gmail as `Preparation` with an app-password hint, and Outlook.com as `Broken`: "Outlook does not allow using passwords anymore, per-app-passwords are currently not working" (`v2.49:src/provider/data.rs:558-583, 1195-1220`).

**What this means for Aplos.** A mature, seven-year-old IMAP project could not keep a Gmail OAuth client alive and gave up on Outlook IMAP. That's strong evidence for Aplos's current choice: native Gmail REST and Microsoft Graph with Aplos's own verified OAuth client. "Just use IMAP with XOAUTH2" doesn't get around Google's restricted-scope review, because the full `https://mail.google.com/` scope is restricted too. **[I]** It also means Delta Chat is now a weak reference for Gmail and Outlook connectivity, and for everything else that's mailbox-shaped (folders, labels, history, drafts, flags). It is still a **very strong reference** for the parts it optimised hard for mobile networks: connection management, IDLE loops, the outbox, crash-safe checkpoints, the SQLite discipline, the event and RPC boundary, and the stdio, FFI and WebSocket packaging of a headless engine.

---

## 1. Overview

**Purpose.** A Rust library that implements messaging over SMTP/IMAP: Autocrypt/OpenPGP end-to-end encryption, groups, reactions, webxdc mini-apps, calls, and P2P multi-device sync over iroh. It powers the Delta Chat apps and bots (`README.md`) and is exposed three ways:
- a C FFI (`deltachat-ffi/deltachat.h`, 7,300 lines);
- a JSON-RPC 2.0 API (`deltachat-jsonrpc`);
- a static `deltachat-rpc-server` binary that speaks JSON Lines over stdio.

**[V]**

**Activity and maturity.** **[V]** (GitHub API, 2026-10-25)
- 940 stars, 151 forks. Created 2019-04 as the Rust rewrite of the earlier C core.
- Last push 2026-10-25. 1,214 commits in the last 12 months.
- 55 listed contributors. Top: link2xt 3,335; r10s 1,436; dependabot 1,300; hpk42 782; iequidoo 571; Hocuri 565.
- 2.0.0 shipped 2025-07-09, and 2.65.0 shipped 2026-10-22: 65 minor releases in 15 months, roughly one a week.
- About 104k lines of Rust in `src/`, of which about 35k are test modules.
- SQL schema migration number 169 (`src/sql/migrations.rs`).

The 2026 changelog marks dozens of changes `[**breaking**]`.

**Target user.** Messenger users and bot authors. Since mid-2026 the core mainly targets chatmail relays: Postfix/Dovecot servers the team runs, which add push, TURN and iroh relay metadata through IMAP METADATA (`src/imap.rs` `update_metadata`). Classic email servers still work for chat with app passwords, but only for the one watched folder, and with no history backfill. **[V]**

## 2. Feature inventory

| Feature | Evidence | Maturity (HEAD) |
|---|---|---|
| IMAP fetch over IDLE, one folder per transport | `src/scheduler.rs` `inbox_loop`, `src/imap/idle.rs` | Mature, hardened on bad networks |
| Multiple transports (relays) per account, fetched in parallel | `src/scheduler.rs:723-741`, `src/transport.rs` | Mature (2025-26) |
| SMTP outbox with retry and partial-send tracking | `src/smtp.rs`, `src/smtp/queue.rs`, table `smtp2` | Mature |
| Autoconfig (Mozilla ISPDB, `.well-known`, Outlook Autodiscover) | `src/configure.rs:591-670` | Mature |
| DNS cache, staggered parallel connect, TLS resumption, SPKI pinning, SOCKS5/Shadowsocks proxy | `src/net/*.rs` | Mature, unusually deep |
| IMAP QUOTA monitoring with warn and error thresholds | `src/quota.rs` (80% and 95%) | Mature |
| Large-message deferral (download later, on demand) | `src/download.rs`, table `download` | Mature |
| Multi-device settings sync through hidden self-messages | `src/sync.rs`, table `multi_device_sync` | Mature |
| Device-to-device backup transfer by QR over QUIC (iroh) | `src/imex/transfer.rs` | Mature |
| APNs/FCM push via encrypted device token in IMAP METADATA | `src/push.rs`, `src/imap.rs` `register_token` | Mature, but **chatmail relays only** |
| Background fetch with a deadline (mobile wake-ups) | `src/accounts.rs:380-470`, `src/scheduler.rs:299-345` | Mature |
| OAuth2 (Gmail, Yandex) | Removed in 2.56.0 | **Gone** (Gmail broken before that) |
| Provider DB (74 providers in v2.49) | Removed in 2.57.0 | **Gone** (one hard-coded legacy entry left, `src/provider.rs`) |
| Multi-folder watch, move to a "DeltaChat" folder, CONDSTORE flag sync | `v2.49:src/scheduler.rs`, `v2.49:src/imap.rs:1193-1290` | **Gone** (2.50, 2.54, 2.62) |
| Search | `src/context.rs` (`LIKE` on normalised text, capped at 1,000) | Basic; no FTS |
| Drafts | Local only: `msgs.state = OutDraft` (`src/chat.rs:751-864`) | No IMAP draft sync, ever |
| Labels and folder model, rules, List-Unsubscribe, calendar, AI | None. `List-Id` is used only to group mailing lists into chats (`src/receive_imf.rs:3490+`) | Not applicable |
| SQLCipher database encryption | `src/sql.rs:78-290`; deprecated 2025-11 (`src/context.rs:134-141`) | Deprecated |

## 3. Architecture deep dive

### 3a. Process and deployment topology

**[V]** There are no servers of its own in the mail path, apart from optional chatmail relays and a push-notification proxy. Everything else runs on the device:

1. **The library** (`deltachat` crate) holds an `Accounts` manager (`src/accounts.rs`) and one `Context` per account (`src/context.rs`). Each account lives in its own directory: a SQLite file plus a sibling `-blobs` directory. They're indexed by `accounts.toml`.
2. **An exclusive lock file** (`accounts.lock`, `src/accounts.rs:587-672`) guarantees that only one process owns a profile. A second process fails with "already running". iOS is the exception: its notification extension shares the database, so iOS uses a 60 s SQLite busy timeout instead (`src/sql.rs:713-727`).
3. **Per-account I/O scheduler** (`src/scheduler.rs`). These are Tokio tasks:
   - one IMAP loop per transport;
   - one SMTP loop;
   - an ephemeral-message loop, a location loop and a "recently seen" loop.

   Each loop gets a stop token and a bounded(1) "interrupt" channel. Start, stop and pause are explicit. `pause()` returns an RAII guard that restarts I/O when dropped, and backup import/export uses it (`src/scheduler.rs:136-204`).
4. **The packaging layer** has three faces over the same `CommandApi`:
   - **C FFI** for the Android and iOS apps.
   - **`deltachat-rpc-server`**, a roughly 190-line binary that reads JSON-RPC requests line by line from stdin, spawns a task per request, writes responses to stdout, and sends logs to stderr (`deltachat-rpc-server/src/main.rs`).
   - **Delta Chat Desktop** (separate repo, GPL-3.0), which ships three targets: Electron, Tauri and a browser target. The **Electron target spawns `deltachat-rpc-server` as a child process** and pipes JSON Lines through it (`deltachat-desktop: packages/target-electron/src/deltachat/stdio_server.ts`, via the GitHub API). The **browser target** is a Node server that exposes the same JSON-RPC over `/ws/dc` (WebSocket), blob files at `/blobs/:accountId/:filename`, a runtime channel at `/ws/backend`, and password login at `/authenticate`, over HTTPS with a self-signed cert (`packages/target-browser/Architecture.md`, `Readme.md`). Its README describes it as development-only and says it could become a home-server web client.

**Implication.** This is the "engine as a local server" shape the owner wants, already shipped over three transports.

### 3b. Connectivity per mail provider

**HEAD [V].**
- **Protocols.** Plain IMAP and SMTP only. There's no JMAP, Gmail API or Graph.
- **Login.** IMAP `LOGIN` with a password (`src/imap.rs:347-348`).
- **Configuration.** Autoconfig tries these URLs in order: `autoconfig.<domain>`, then `<domain>/.well-known/autoconfig`, then Outlook Autodiscover on two hosts, then Thunderbird's ISPDB (`src/configure.rs:591-670`). If all fail, it guesses host and port combinations (`server_params.rs`).
- **Candidate ordering.** Every working combination is saved as a candidate list. On each connect, the list is re-sorted by the timestamp of the last successful connection (`src/transport.rs:138-157`, table `connection_history`).
- **Credential storage.** Passwords are stored in plaintext JSON in `transports.configured_param` inside the account database (`src/transport.rs:162-216`). The project's position is that database encryption is pointless: "Db encryption does nothing with blobs, so fs/disk encryption is recommended. Isolation from other apps is needed anyway" (`src/context.rs:134-141`).
- **Redaction.** Diagnostics hide the local part of the address (`***@domain`) and never print passwords (`src/transport.rs:223-256`).

**Historical OAuth (v2.49) [V].**
- `v2.49:src/oauth2.rs` holds a per-provider table of `{client_id, auth URL, token URL, refresh URL, userinfo URL}` templates. The UI opened the auth URL with a redirect URI, the core exchanged the code, and the access token, refresh token and expiry were stored as raw config keys in SQLite. A mutex serialised refreshes, and tokens were refreshed 5 s before expiry. IMAP used SASL XOAUTH2 (`v2.49:src/imap.rs:150-156`).
- By v2.49 the only entry left was Yandex, and that entry embedded a client secret in source. **Do not replicate this.** Aplos is right to keep Google client secrets out of the bundle wherever PKCE allows.

**Network robustness [V].** This is the most transferable part.
- **Staggered parallel connection attempts.** The first attempt starts right away, and more start at 300 ms, 1 s, 5 s and 10 s, up to 5 in flight (`src/net.rs` `run_connection_attempts`).
- **Two-layer DNS cache.** An in-memory stale-while-revalidate layer sits on top of a persistent `dns_cache` table. The persistent layer is ranked by the last *successful* connection per IP, and there's a built-in preload list as a last resort (`src/net/dns.rs:1-40, 875-910`).
- **Timeouts.** TCP_NODELAY, and 60 s read, write and connect timeouts (`src/net.rs` `TIMEOUT`).
- **TLS.** TLS 1.3 session resumption. SPKI hash pinning lets a connection go through when the certificate has expired but the key hasn't changed (`src/net/tls/spki.rs`).
- **Compression.** IMAP `COMPRESS=DEFLATE` when the server offers it.
- **Proxies.** SOCKS5, HTTP CONNECT and Shadowsocks (`src/net/proxy.rs`).
- **Login throttling.** Two layers:
  - an exponential backoff from 2 s to 80 s with jitter;
  - a token bucket of 1 successful connection per minute with a burst of 2, so a server that accepts the login and then drops the connection can't cause a busy loop (`src/imap.rs:243, 255-310`).

  Both can be skipped by an interrupt (the network came back, or the user did something).

### 3c. Sync algorithm

**Initial sync.** There's no backfill. The first time a folder is selected (or after UIDVALIDITY changes), `uid_next` is set to the server's current UIDNEXT, so only mail that arrives afterwards is fetched (`src/imap/select_folder.rs:103-112, 205-232`). A bots-only "fetch existing messages" option existed and was removed (CHANGELOG lines 2872, 6362).

**Incremental sync.** It's UIDNEXT-based and append-only. **[V]**
1. **Prefetch.** `SELECT` and compare UIDNEXT. If it changed, `UID FETCH uid_next:uid_next+499` gets `RFC822.SIZE` plus about 9 header fields (`PREFETCH_FLAGS`, `src/imap/session.rs:19-29`).
2. **Record locations first.** For each UID, upsert an `imap` row `(transport_id, rfc724_mid, folder, uid, uidvalidity, target)` *before* deciding whether to download it (`src/imap.rs:604-625`).
3. **Decide per message** from headers alone (`prefetch_should_download`, `src/imap.rs:1533+`): skip if already seen by Message-ID or if the sender is blocked. Messages over the download limit go to the `download` queue "so that large messages don't delay receiving small messages" (`src/imap.rs:640-660`).
4. **Fetch bodies** with `BODY.PEEK[]`, using UID sets chunked to about 990 characters (`build_sequence_sets`, `src/imap.rs:1677+`). A message whose processing fails becomes a visible "Failed to receive" device message instead of aborting the batch (`src/imap.rs:1130-1145`).
5. **Checkpoint even on partial failure.** Results stream through a channel while bodies download, and the largest processed UID is persisted as the new `uid_next` before the fetch error is re-raised (`src/imap.rs:668-735`). A dropped connection mid-batch therefore never re-downloads what it already processed, and never skips what it didn't.
6. A single `fetch_msgs_mutex` serialises message processing across transports so Message-ID deduplication can't race (`src/imap.rs:549`).

**Consistency repairs.**
- If UIDVALIDITY changes, old `imap` rows are garbage-collected and a full UID↔Message-ID resync runs (`UID FETCH 1:* (Message-ID)`, `resync_uids_with_server`, `src/imap.rs:772-850`).
- The same resync runs if the server "illegally" lowers UIDNEXT (`select_folder.rs:180-190`).
- If SELECT doesn't return UIDNEXT, it falls back to `STATUS` (with notes on Winmail Pro and mail.163.com quirks).
- **Tombstones.** Locally deleted messages are kept as rows in a hidden trash chat for 2 days, so they aren't downloaded again (`prune_tombstones`, `src/sql.rs:1190-1204`).

**Local → server changes use a desired-state table, not an op log.** **[V]**
- `imap.target` holds where a message *should* be. An empty string means "delete".
- The loop reconciles every row where `target != folder` by setting `\Deleted` on grouped UID ranges, then `CLOSE` instead of `EXPUNGE`, because CLOSE is cheaper (`src/imap.rs:867-913`, `select_folder.rs:30-48`).
- "Mark as read" inserts into `imap_markseen`. Before every IDLE, the loop flushes it as `+FLAGS \Seen` on grouped UID sets, and failures stay queued (`store_seen_flags_on_imap`, `src/imap.rs:916-990`).
- Local actions wake the loop through the interrupt channel (`src/message.rs:1763`, `src/download.rs:87`).
- This is idempotent by construction. Replaying the reconcile can never apply an action twice.

**Flag sync from the server.** Gone at HEAD. In v2.49 it used CONDSTORE: `UID FETCH 1:* (FLAGS) (CHANGEDSINCE modseq)` with a per-folder `modseq` in `imap_sync`, and an unsolicited FETCH during the sweep forced another round instead of IDLE (`v2.49:src/imap.rs:1193-1290`). Aplos already does CONDSTORE (`apps/desktop/src/main/imap-session.ts:96-123`), so on flag sync Aplos is ahead of current Delta Chat.

**Push while running.** **[V]**
- IMAP IDLE runs in a loop per transport. The order is: fetch → reconcile → enter IDLE → wake on server data, a local interrupt or a 5-minute timeout → `DONE` with a 15 s timeout → set `new_mail = true` → fetch again (`src/imap/idle.rs`).
- IDLE is skipped if unsolicited responses already signalled EXISTS, or if an interrupt is pending.
- Servers without IDLE get "fake idle": a 60 s wait that an interrupt can cut short (`idle.rs` `fake_idle`).
- **Multiple folders (v2.49)** each had their own connection and loop (`simple_imap_loop`), because IDLE is per selected mailbox.

**Push while backgrounded (mobile).**
- **Wake-ups.** The app gives the account manager an APNs/FCM device token. The token is padded to 512 bytes so iOS and Android are indistinguishable, OpenPGP-encrypted to the notifier's public key, and written to IMAP METADATA `/private/devicetoken` on relays that advertise support (`src/push.rs`, `src/imap.rs:1350-1400`). The relay then pings a notification proxy, which wakes the app.
- **The fetch.** `background_fetch(timeout)` pauses the scheduler and fetches every transport in parallel on fresh connections. It returns as soon as any transport receives mail, cancels the others and emits `AccountsBackgroundFetchDone` (`src/scheduler.rs:292-345`, `src/accounts.rs:380-500`).
- **Limit.** This depends on server cooperation that Gmail, iCloud and Fastmail won't give. **[I]**

**Rate limits and quota.**
- **Sending.** A token bucket of 3 messages per 3 s (`src/context.rs:495`).
- **IMAP connections.** The connection limiter above.
- **Quota.** IMAP `QUOTA` is polled at most once a minute and shown at 80% and 95% (`src/quota.rs`, `scheduler.rs:476-484`).
- There's no provider HTTP quota handling, because there are no HTTP providers.

**Outbox.** **[V]** (`src/smtp.rs:447-620`, `src/smtp/queue.rs`)
- **Atomic enqueue.** Sending renders MIME once and inserts a `smtp2` row in the *same transaction* as its side effects. For example, the multi-device sync items carried by the message are deleted from `multi_device_sync` only when the mail is actually queued (`SideEffects.sync_ids_to_delete`).
- **Retry counting.** `retries` is incremented *before* each attempt, so a poison message can't loop forever. After 6 attempts the message is marked failed.
- **Partial sends.** Recipients are sent in chunks of the server's `RCPT TO` limit, and `sent_to` is persisted after each chunk. A crash mid-send never mails anyone twice.
- **Error classification.** 4xx means retry. 5xx means fail, except the `5.5.0` misconfigured-Postfix case, which is treated as transient. Transient 4.1.2 "domain not found" was once treated as permanent and then reverted (`smtp.rs:313-382`).
- **Backoff.** The SMTP loop backs off exponentially with jitter starting at 30 s, and new sends wake it.

**Conflict resolution.** The server holds the messages and the local database holds everything derived from them. Multi-device settings use timestamped sync items, with a stated rule that removal wins a tie (`src/sync.rs` `SyncData::Transports`). Unknown future item types deserialize into an `Unknown(serde_json::Value)` variant and are ignored, which keeps the format forward-compatible (`SyncDataOrUnknown`).

### 3d. Local storage

**Engine and connection discipline.** **[V]** (`src/sql.rs`, `src/sql/pool.rs`)
- rusqlite with bundled SQLCipher.
- **The pool.** 3 connections. The pool is a LIFO stack, so the warmest page cache is reused. There's **exactly one writer**, enforced by an async mutex instead of SQLite's busy loop, and `busy_timeout` is 0 except on iOS. The module docs explain this rationale at length.
- **PRAGMAs.**
  - `journal_mode=WAL` and `synchronous=NORMAL`;
  - `auto_vacuum=INCREMENTAL` and `secure_delete=on`;
  - `foreign_keys=on`, `soft_heap_limit=8 MiB` and `temp_store=memory`;
  - double-quoted string literals disabled.
- **Daily housekeeping** (`HOUSEKEEPING_PERIOD = 24 h`): unused blob GC, tombstone pruning, incremental vacuum, an explicit **WAL checkpoint with truncate** (they saw WAL files over 200 MB from checkpoint starvation), HTTP cache cleanup and orphan cleanup (`src/sql.rs:784-870`). It holds a try-lock so it can't run twice, and it sets its "last run" timestamp *before* running so a crash can't trigger an endless loop.

**Main tables.** **[V]** (`src/sql/tables.sql` plus `migrations.rs`)
- **Messages and chats:**
  - `msgs`: id, rfc724_mid, chat_id, from_id, timestamps, state, `txt`, `param`, `mime_headers` (a compressed raw MIME blob, kept only when the message was simplified or is HTML, `src/receive_imf.rs:1991-2255`), `mime_in_reply_to`, `mime_references`, download_state, `pinned`.
  - `chats`, `chats_contacts`, `contacts`, `public_keys`, `keypairs`.
- **IMAP state:**
  - `imap(id, transport_id, rfc724_mid, folder, uid, uidvalidity, target)`: the server location of each message, separate from the logical message.
  - `imap_sync(transport_id, folder, uidvalidity, uid_next, modseq)`: the cursor.
  - `imap_markseen(id → imap.id)`: pending `\Seen` flags.
  - `download(rfc724_mid, msg_id)` and `available_post_msgs`: deferred bodies.
- **Outbox and sync:**
  - `smtp2(id, rfc724_mid, mime, recipients, sent_to, msg_id, retries, …)`: the outbox.
  - `multi_device_sync(id, item)`: sync items waiting to be sent.
  - `transports(id, addr, entered_param, configured_param, …)` and `removed_transports`.
- **Network caches:** `dns_cache`, `connection_history`, `tls_spki` and `http_cache`.
- **Key-value config:** `config(keyname, value)`, with an in-memory cache.

The schema is documented in `docs/schema.sql`, and a CI test fails if that file drifts from the real schema (`deltachat-rpc-client/tests/test_sql_schema_docs.py`).

**Bodies and attachments.**
- **Attachments.** Stored as files in a content-addressed blob directory, named by the first 31 hex characters of a BLAKE3 hash, which deduplicates by content (`src/blob.rs:48-110`). Housekeeping deletes unreferenced blobs.
- **Message text.** The simplified text goes in `msgs.txt`. Full HTML is rebuilt on demand from the compressed raw MIME (`src/html.rs`, `MsgId::get_html`). The UI fetches it through a separate call (`get_message_html`).

**Search.** `LIKE` over normalised text, capped at 1,000 results for global search (`src/context.rs:1182-1215`). There's no FTS. That's fine for chat but too weak for a mail client.

**Encryption at rest.** SQLCipher is available (`PRAGMA key`, `rekey`, `sqlcipher_export` on import) but **deprecated since 2025-11** in favour of OS disk encryption. Aplos's FileVault-only stance matches theirs.

**Eviction.** Only ephemeral timers and "delete device after N" (`src/ephemeral.rs`). There's no LRU body cache, because nothing is ever loaded into memory wholesale.

**Migrations.** A base schema (`tables.sql`, at version 68) plus numbered forward-only migrations up to 169. Each migration runs in its own transaction that bumps `dbversion` and checks the version strictly increases (`execute_migration_transaction`, `migrations.rs:742-775`). Some migrations do real data transformation, such as the key-contacts migration. A test hook (`STOP_MIGRATIONS_AT`) builds databases at intermediate versions. If a migration fails, the database stays open, so the user can still export a backup, and a "send this to developers" message is shown (`src/sql.rs:191-210`).

### 3e. API between UI and engine

**Shape.** JSON-RPC 2.0, defined once in Rust (`deltachat-jsonrpc/src/api.rs`, 188 async methods) with `yerpc`.
- TypeScript types and a client are **generated** (`deltachat-jsonrpc-bindings/build.rs`), along with Qt bindings and an OpenRPC spec (`deltachat-rpc-server --openrpc`).
- Payload types are camelCase serde structs.

**Pagination is "IDs, then batch-load by ID".**
- `get_chatlist_entries` returns ordered chat IDs, and `get_chatlist_items_by_entries(ids)` loads only the rows on screen.
- Messages work the same way: `get_message_ids` or `get_message_list_items`, then `get_messages(ids)`, which returns per-ID success or error.
- Search is `search_messages`, then `message_ids_to_search_results(ids)`.

Delta Chat Desktop pairs this with `react-window` and `react-window-infinite-loader` (frontend `package.json`, GitHub API). **[V]**

**Realtime changes.**
- **Producer.** An `async_broadcast` ring buffer of 10,000 events. Overflow drops the oldest and delivers `EventChannelOverflow { n }` (`src/events.rs:27-140`).
- **Consumers** **long-poll** with `get_next_event_batch`, which returns at least 1 and up to about 100 events. The TypeScript client runs that loop and re-emits events by kind and by account (`typescript/src/client.ts`).
- **Events are invalidations, not data:** `MsgsChanged {chat_id, msg_id}`, `ChatlistItemChanged {chat_id}`, `ChatlistChanged`, `IncomingMsg`, `ConnectivityChanged` and so on (`src/events/payload.rs`). A zero or `None` ID means "reload everything you have cached" (`src/events/chatlist_events.rs`). The UI re-fetches by ID.
- **Logs ride the same channel.** `Info`, `Warning` and `Error` events carry `file:line` (`src/log.rs`).
- **Limit.** `CommandApi` holds **one shared `EventEmitter`** (`api.rs:91-118`), so two clients long-polling the same server would *split* the event stream between them. **[V for the shared emitter; I for the consequence.]**

**Connectivity as an API.**
- There are 4 coarse states (NotConnected, Connecting, Working, Connected), derived from a detailed per-connection state that includes an error string. The worst state wins (`src/scheduler/connectivity.rs`).
- `get_connectivity_html` renders a full per-transport report with quota bars.
- `maybe_network()` and `maybe_network_lost()` let the UI pass OS reachability hints, which interrupt every IDLE and backoff.

### 3f. Send pipeline, drafts, threading, folders, calendar, AI

**Sending.** Render MIME (encrypted with Autocrypt keys when it can be), store it in `smtp2`, interrupt SMTP, and send as in 3c. The SMTP connection is kept warm. Sent mail is *not* appended to a Sent folder. Instead, `bcc_self` delivers a copy to your own inbox, where other devices pick it up (`smtp.rs:510-525`). That avoids APPEND but pollutes INBOX. It's a chat-specific trade-off and wrong for an email client.

**Drafts.** A single local draft per chat (`chat.rs` `OutDraft`). No IMAP Drafts sync, so this isn't a source for Aplos's missing Gmail draft sync.

**Threading.** Messages are grouped into *chats*, not RFC threads:
- by `Chat-Group-ID` when present;
- otherwise as a reply to a known parent via `In-Reply-To`/`References`, with guards: a private reply stays private, a 1:1 chat that gains recipients becomes an ad-hoc group, and unencrypted replies never join encrypted chats (`lookup_chat_by_reply`, `src/receive_imf.rs:2629-2672`);
- otherwise as an ad-hoc group keyed by the member set;
- mailing lists become their own chats, keyed by `List-Id`.

**Folders and labels (v2.49).**
- Folder roles came from RFC 6154 SPECIAL-USE attributes first, then a localised-name fallback list (`get_folder_meaning_by_attrs`/`_by_name`, `v2.49:src/imap.rs:2045-2110`).
- Gmail's `\All`, `\Important` and `\Flagged` were deliberately ignored as "virtual", because moves and deletes through them are ambiguous.
- Spam was never downloaded directly.

**Not present:** calendar, contacts sync (vCard import only), AI.

## 4. Engineering quality

**Tests.** **[V]**
- About 1,190 Rust `#[test]`/`#[tokio::test]` functions. A `TestContext`/`TestContextManager` harness simulates multiple accounts exchanging messages in-process (`src/test_utils.rs`, 1,989 lines).
- Migration tests start from intermediate schema versions.
- `proptest-regressions/`.
- Fuzz targets for MIME parsing, date parsing and format=flowed (`fuzz/`).
- Criterion benchmarks for receive, chatlist, search and events (`benches/`).
- **The Python integration suite drives the real `deltachat-rpc-server` over stdio against live chatmail test servers** (`deltachat-rpc-client/tests/*`, `CHATMAIL_DOMAIN`). It covers multi-device, multi-transport, folders and calls.
- One test reads `/proc/<pid>/smaps_rollup` and fails if the server keeps more than 64 MiB after two 20 MiB attachments (`test_memory.py`). That's a memory regression test at the process boundary.

**CI** (`.github/workflows/ci.yml`):
- `cargo fmt --check`, clippy, `cargo deny` (licences and advisories), docs, and `nextest` on several OSes;
- C library build, RPC server build plus Python tests, and a `zizmor` workflow security scan;
- Nix reproducible builds and Dependabot.

**Code organisation.**
- One module per concern (`imap`, `smtp`, `scheduler`, `sql`, `net`, `receive_imf`, `mimefactory`).
- Long doc comments explain *why*, with server names and dates (e.g. "mail.163.com as of 2023-11-26"). `STYLE.md` covers error and SQL conventions.

**Observability.**
- All logs are events with `file:line`.
- The rpc-server sends `tracing` output to stderr. Desktop captures it to a log file and shows the last 800 characters of stderr in its fatal-error dialog (`stdio_server.ts`).
- `get_info()` gives a redacted diagnostic dump.
- **Device messages** surface user-actionable problems in a dedicated "Device" chat: clock skew, an outdated app, quota, receive failures (`src/tools.rs:195-230`). They're deduplicated by a label such as `bad-time-warning-YYYY-MM-DD`.
- There's no crash reporter in core, and no telemetry other than an opt-in stats module (`src/stats.rs`).

**Criticisms.**
- The 2026 removals (OAuth, multi-folder, flag sync) dropped features users relied on, and downstream apps must track weekly breaking changes.
- Watching one folder means classic-email users miss mail that server-side filters move out of INBOX.
- The shared event emitter isn't built for more than one consumer, and search has no FTS.

## 5. UI notes

The core has no UI. Delta Chat Desktop (GPL-3.0, 1,628 stars) is **React 19** with `react-window` virtualisation, `moment`, `emoji-mart` and `react-zoom-pan-pinch`. Its frontend dependencies include **no motion library** (`packages/frontend/package.json`, via the GitHub API), so there are no easing constants to report. The keyboard model wasn't audited.

The UI-side part that does matter for Aplos is **HTML email rendering** (`packages/target-electron/src/windows/html_email.ts`, via the GitHub API):
- **Separate window and session.** Mail opens in a separate `WebContentsView` with `nodeIntegration:false`, `contextIsolation:true`, `javascript:false`, and a **fresh throwaway session partition** per window.
- **Strict CSP.** Content loads from a custom `email://` protocol under a CSP that starts with `default-src 'none'` and includes the `sandbox` directive.
- **Remote content off by default.** The session's `http`/`https` handlers refuse requests, and a bogus fixed proxy acts as a fail-safe.
- **When the user allows remote content,** fetches are **routed through the core** (`getHttpResponse`, `deltachat-jsonrpc/src/api.rs:2399`), so they use the core's DNS, proxy and HTTP cache.
- **Links** are handed off to the main app.

Aplos's renderer currently injects sanitised HTML into the privileged document. This is a proven, simple model to copy (as an idea).

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **Desired-state reconciliation tables instead of only an op log.**
   - Keep a `server_location(account, folder, uid, uidvalidity, message_key, target)` table, plus small "pending flag" tables.
   - Triage writes the target, and a per-account reconciler converges it in batched UID sets.
   - Aplos's ordered `ops` queue is still right for Gmail and Graph calls that aren't idempotent, but IMAP and JMAP moves and flags become replay-safe.
2. **Checkpoint per batch, even on failure.** Stream results out of the fetch, persist the cursor (UID, Gmail page token or historyId) up to the last processed item, and *then* re-raise the error. This directly fixes the "all-or-nothing, restart from zero" first-sync problem behind the 403 incident.
3. **Prefetch headers, then decide, then fetch bodies.** Use small header batches (Delta uses 500 UIDs). Classify cheaply. Fetch full bodies only for what's needed. Push big ones into a `download` queue so they never block small ones. For Gmail this is `format=metadata` pages first, with bodies lazy and budgeted.
4. **Two-layer connection throttling per account.** Use jittered exponential backoff (2 s to 80 s) plus a token bucket on *successful* logins (about 1/min, burst 2). Let both be cut short by an interrupt for "network is back" or "user acted". Rank server candidates and IPs by the last successful connection.
5. **IMAP IDLE loops with a bounded(1) interrupt channel.** Fetch → reconcile → IDLE (re-issue every 5 min) → DONE with a timeout. Use 60 s fake-idle polling only when IDLE isn't available. Run one connection per watched folder (INBOX plus Sent at minimum), with an explicit start/stop/pause state machine and an RAII pause guard for export, import and migrations.
6. **Single-writer SQLite discipline.** One write connection behind an async mutex, a few LIFO-ordered read connections, WAL with NORMAL, incremental auto-vacuum, a daily housekeeping job that explicitly runs `wal_checkpoint(TRUNCATE)`, and a "last run" stamp written first.
7. **Content-addressed blob directory** for attachments and inline images, with GC of unreferenced files. Store raw MIME compressed only when needed, and rebuild HTML on demand behind a separate `message.html(id)` call.
8. **IDs-then-batch API plus invalidation events.**
   - List calls return ordered IDs, and `get(ids)` returns per-ID results.
   - Events carry only `{account, thread|message id}` or "unknown, reload visible".
   - An explicit overflow event forces a resnapshot, which Aplos already does on an `{epoch, rev}` gap.
   - This replaces cloning and shipping the whole mailbox.
9. **One schema-first contract** that generates the TypeScript client types and an allowlist, with no hand-copied method sets. Add a CI check that the docs and schema match the code, and a coverage report of RPC methods the tests never call.
10. **Observability as a product feature.**
    - Every log line as an event with `file:line`, written to a rotating file by the host.
    - A redacted `diagnostics.get` that masks local parts.
    - Connectivity with coarse and detailed per-account states and the *error cause* shown in the UI.
    - Deduplicated "device messages" for actionable problems: clock skew, outdated app, quota near full, a message that failed to parse.
11. **Error-class rules for sending.** Count the retry before the attempt, cap attempts, persist per-recipient progress, and keep a short documented allowlist of permanent codes that are really transient.
12. **Sandboxed HTML viewer.**
    - Its own `WebContentsView` or iframe with an opaque origin, `javascript:false` and `default-src 'none'; sandbox`.
    - Remote content blocked at the session level by default and proxied through the engine when the user allows it.
13. **Workflow-sync items.** Timestamp each item, keep an `Unknown` variant for forward compatibility, state the tie-break rule, and dequeue items in the same transaction as the message that carries them.
14. **Headless E2E tests through the real engine process,** as Delta's Python suite does over stdio. Aplos can drive its engine through `server.ts` against fake IMAP/Gmail servers in CI, plus an RSS-after-large-attachment check.

### Avoid

1. **Don't bet on IMAP+XOAUTH2 for Gmail or Outlook as a way around verification.** Delta lost Gmail OAuth and marked Outlook broken. Keep native APIs with Aplos's own client.
2. **Don't embed client secrets** in the bundle (v2.49 did for Yandex).
3. **Don't take the "no history" first sync literally.** It works for a messenger, but an email client needs a bounded, resumable backfill window.
4. **Don't watch only INBOX.** Server-side rules move mail out of it, and Delta's 2026 single-folder change is a regression for email users.
5. **Don't use `bcc_self` instead of Sent.** It pollutes the inbox.
6. **Don't treat `LIKE` as search.** Keep FTS5, but fix the `UNINDEXED` delete scan the earlier audit flagged.
7. **Don't expose one shared event cursor to several clients.** Each client needs its own cursor.
8. **Don't add database encryption theatre.** Delta deprecated SQLCipher because blobs stay unencrypted anyway. Rely on FileVault plus file modes, and put the effort into HTML isolation instead.
9. **Don't make weekly breaking changes to an API once a phone client depends on it.** Version the RPC contract and handshake versions at connect.

## 7. "Local server" translation

### What Delta proves

A mail engine can be one headless process that owns the database, the network loops and the lock file, behind a JSON-RPC surface that is transport-agnostic. It ships over stdio (Electron child process), FFI (mobile) and WebSocket (browser target) without changing the API. Aplos already has most of the pieces:
- a platform-free engine (`src/engine/` with ports);
- a utilityProcess host;
- `{epoch, rev}` change diffs;
- a dev-only `server.ts` (`POST /api/invoke`, SSE `/api/events`, Host and Origin checks, no auth).

### Concrete mapping to an `aplosd` on the Mac

| Delta Chat piece | Aplos daemon equivalent |
|---|---|
| `accounts.lock` single owner | An `flock` on `~/Library/Application Support/Aplos/aplos.lock`. The daemon owns `aplos.db`. Electron never opens the DB. |
| `deltachat-rpc-server` spawned by Electron over stdio | **Phase 1:** keep the engine as a utilityProcess or child. **Phase 2:** a LaunchAgent-managed Node binary inside the signed app bundle. Electron connects over a **Unix domain socket** (mode 0600) using JSON-RPC 2.0. |
| `CommandApi` (188 methods, generated TypeScript) | A single `contract.ts` (zod or similar) generating client types, a server-side validator and the method allowlist. Version handshake: `server.hello → {apiVersion, engineVersion, epoch}`. |
| IDs-then-batch pagination | `threads.list({view, cursor, limit}) → {ids, nextCursor}`, then `threads.get(ids)` (headers only) and `message.body(id)` / `message.html(id)` on demand. |
| Shared long-poll `get_next_event_batch` | **Per-connection** subscriptions over WebSocket. Each event has a daemon-wide monotonically increasing `seq`, kept in a ring buffer of about 10k with an overflow → `resnapshot` event. Clients reconnect with `since=seq`. |
| `/blobs/:accountId/:filename` | `GET /blob/:hash`, gated by session capability tokens. HTML at `GET /html/:messageId` from a **separate origin** (a different port or custom scheme) under a strict CSP. `GET /proxy?url=` for user-allowed remote images. |
| Browser target's `/authenticate` password over self-signed HTTPS | For a **LAN phone**: listen on 127.0.0.1 by default and bind LAN only when the user opts in. Pair by QR containing `{daemon public key fingerprint, one-time token, addresses}`, modelled on Delta's iroh backup handshake (`src/imex/transfer.rs`). Issue revocable per-device tokens and pin TLS. |
| iroh relay for P2P | For **off-LAN**: Tailscale (the owner already runs it) or an E2E-encrypted relay. The relay never sees mail plaintext. |
| Scheduler loops and connectivity | Per account: IDLE loops (IMAP/JMAP push), a Gmail History poller with a quota budget, an SMTP/outbox loop, and a separate **AI enrichment loop** with its own queue table. `connectivity.get` and `diagnostics.get` exposed over RPC. |
| `background_fetch(timeout)` | `sync.now({deadline})` for "the phone opened the app", or "the Mac woke from sleep" through `powerMonitor` → `maybe_network`. |

### Pros

- **One owner.** One owner of the DB and the network means no duplicate sync and no memory copies in main, renderer and engine. The renderer holds only visible rows, which fixes the memory ceiling.
- **Lifetime.** The daemon survives window close and renderer crashes. A LaunchAgent can keep IDLE alive while the app is closed (not while the Mac sleeps).
- **Testability.** One API serves Electron, browser preview, a CLI or MCP tool, and a phone, and headless E2E tests come naturally.
- **Security.** Mail HTML naturally moves out of the privileged renderer.

### Cons and risks

- **Version skew.** UI and daemon versions can drift apart, so the protocol needs a handshake and the daemon needs restart-on-update. electron-updater replaces the bundle, but a running daemon has to be told to exit. **[I]**
- **Keychain.** A non-GUI helper needs the same team ID and access group, or every launch prompts. **[I]**
- **Security surface.** A LAN listener is a new attack surface. Not binding by default, QR pairing, token revocation and Host/Origin checks are mandatory.
- **Sleep.** A sleeping MacBook serves no phone. Delta needed chatmail relays plus an APNs/FCM proxy for mobile push, and Aplos would need either its own push relay (a server, which is against the no-server pitch) or a phone that syncs directly with the provider when the Mac is away. **[I]**
- **Fan-out.** Delta's single shared emitter would break with two clients, so Aplos needs per-client cursors from day one.

### Effort (one developer plus agents)

1. **Typed contract, per-connection events with `seq`, IDs-then-batch reads, log file, diagnostics:** about 1-2 weeks. This is worth doing even with no daemon.
2. **Reconciler tables, per-batch checkpoints, IDLE loops with an interrupt channel, AI loop off the sync path:** about 2-3 weeks.
3. **Standalone daemon with a lock file, socket transport, LaunchAgent, update handshake:** about 1-2 weeks.
4. **LAN phone access** (pairing, TLS, tokens, blob and HTML endpoints): about 2-3 weeks, plus the phone client itself.
5. **Off-LAN through Tailscale:** days. With a custom relay: weeks.

**Recommendation.** Do steps 1 and 2 inside the current utilityProcess first. They fix the known problems (403s, memory, observability, AI in the sync path) and are exactly the boundary a daemon needs. Treat steps 3 to 5 as a later, separate decision, made once there's a phone client to justify them.
