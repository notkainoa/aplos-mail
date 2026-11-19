# Geary: architecture audit for the Aplos revamp

2026-10-25. This is a read-only review of a shallow clone of `https://gitlab.gnome.org/GNOME/geary.git` at `fe4147c` (2026-10-23), stored in `/Users/knewton/.t3/aplos-research/src/geary`. Nothing was built, installed or run. All paths are relative to that clone unless they start with `aplos:` (meaning `/Users/knewton/.t3/projects/aplos-mail/apps/desktop/`).

**[V]** marks a fact verified in the code or through the GitLab/GitHub API. **[I]** marks my inference. Geary is LGPL-2.1-or-later, so everything below is ideas only. No code has been copied.

Prior research (`research/inbox-zero/*`) already covers Aplos's own architecture, the Gmail first-sync failure and the observability gap. This report only compares Geary against those findings.

---

## 1. Overview

**Purpose.** Geary is a GNOME desktop mail client built around conversations (`README.md`, `geary.doap`). It is an IMAP + SMTP client with a local SQLite cache. It has no calendar, no JMAP, no provider REST APIs and no AI. Its interest for Aplos is the engine: thirteen years of work on syncing, caching, offline queuing and failure handling for the most hostile protocol (IMAP), written by a small team.

**License.** **[V]**
- Code: LGPL-2.1-or-later (`COPYING`; `meson.build:3` declares `LGPL-2.1-or-later`).
- A few icons: CC-BY 3.0 (`COPYING.icons`).
- The GitHub mirror reports `NOASSERTION`. GitLab is canonical.

**Maturity and activity.** **[V]**

| Signal | Value |
|---|---|
| Version | 46.0 (`meson.build:2`), released 2024-05-20 (GitLab releases API). No feature release since. |
| Prior releases | 44.0 (2023-07), 44.1 (2023-08), 43.0 (2022-09) |
| Last commit | 2026-10-23 (a translation) |
| Commits in the last 12 months | 66 on the GitHub mirror. Nearly all are translations or build modernization (gcr-4, libpeas-2, meson 1.7, Flatpak CI). There is almost no engine work. |
| Stars / forks | GitLab 200 / 171. GitHub mirror 395 / 63. |
| Issues | 1,691 total, 303 open (GitLab `issues_statistics`) |
| Top contributors (mirror) | mjog (Michael Gratton) 3,366; jimbonator (Jim Nelson, Yorba) 892; eric-yorba 322; rschroll 202; chazomaticus 192 |
| Maintainers | Cédric Bellegarde and Niels De Graef (`geary.doap`) |
| Size | 439 Vala files, about 103k lines in `src/`. The engine is about 56k lines (`src/engine`). Tests: 80 files, about 14k lines. |

**History.** **[I]** Yorba started Geary around 2011. Michael Gratton wrote most of today's engine structure between 2017 and 2020. It is now in maintenance mode: mature and stable, but not evolving.

**Target user.** A Linux/GNOME user who wants a simple conversation view. It ships through Flathub and distro packages (`org.gnome.Geary.json`). It is Linux-only in practice, because it depends on GTK3, WebKitGTK, GNOME Online Accounts, libsecret, Folks and logind.

---

## 2. Feature inventory

| Feature | Maturity | Evidence |
|---|---|---|
| Generic IMAP + SMTP accounts | Mature | `src/engine/imap*`, `src/engine/smtp` |
| Gmail and Outlook.com over IMAP/SMTP, with OAuth via GNOME Online Accounts (GOA) | Mature, but needs GOA on the OS | `imap-engine/gmail/*`, `imap-engine/outlook/*`, `client/application/goa-mediator.vala` |
| Server autodiscovery (the domain's `autoconfig.` host, then Thunderbird's ISPDB) | Newer, simple | `client/accounts/accounts-autoconfig.vala` |
| Conversation (thread) view across folders | Mature | `engine/app/app-conversation-monitor.vala`, `conversation-monitor/app-conversation-set.vala` |
| Offline reading inside a configurable sync window (default 14 days) | Mature | `api/geary-account-information.vala:12` (`DEFAULT_PREFETCH_PERIOD_DAYS = 14`) |
| Local full-text search (FTS5, ICU tokenizer, query-side stemming) | Mature | `sql/version-030.sql`, `imap-db/imap-db-fts5-tokeniser.c`, `common/common-fts-search-query.vala` |
| Durable outbox with send-once protection | Mature | `outbox/outbox-folder.vala`, `smtp/smtp-client-service.vala` |
| Undo send (default 5 s delay) | Mature | `application-controller.vala:2459-2515`, gschema `undo-send-delay` |
| Undo for move, archive and trash (5 s commit delay) | Mature | `imap-engine/imap-engine-revokable-move.vala:17` |
| Drafts saved to the server's Drafts folder every 10 s | Mature | `engine/app/app-draft-manager.vala`, `client/composer/composer-widget.vala:577` |
| Remote images blocked by default, with a per-domain trust list | Mature | `client/web-process/web-process-extension.vala`, gschema `images-trusted-domains` |
| Contact harvesting with an importance rank, plus GNOME Folks | Mature | `common/common-contact-harvester.vala`, `sql/version-005.sql` |
| Plugins via libpeas: desktop notifications, badge, email templates, mail merge, folder highlight, special folders, sent sound | Moderate | `client/plugin/*` |
| Optional Gmail-style single-key shortcuts | Mature | `ui/single-key-shortcuts.css` |
| Run in background and autostart | Newer (2022) | `client/application/application-startup-manager.vala` |
| TLS certificate pinning prompt | Mature | `client/application/application-certificate-manager.vala` |
| In-app Inspector: log ring buffer, system info, save to file | Mature | `client/components/components-inspector*.vala` |
| Calendar, JMAP, Gmail API, Graph, rules, snooze, send-later, List-Unsubscribe, AI | **Absent** | `rg` for these terms finds nothing relevant |

---

## 3. Architecture deep dive

### 3a. Process and deployment topology

**One process, with an embedded engine library.** **[V]** `src/meson.build` builds the engine as a library and links it into the `geary` executable together with the GTK client. The UI talks to the engine through direct in-process calls: Vala async methods plus GObject signals. There is no IPC between UI and engine.

**Other processes:** **[V]**
- **WebKitGTK web processes** render bodies and the composer. Geary injects an extension library (`src/client/web-process/web-process-extension.vala`) that filters network requests and relays page messages.
- **GNOME Online Accounts** (`goa-daemon`, over D-Bus) owns OAuth flows and refresh tokens (`goa-mediator.vala`).
- **gnome-keyring / Secret Service** over D-Bus holds passwords (`secret-mediator.vala`).
- **Folks** aggregates address books (`application-controller.vala:151`).

**No server.** **[V]** Geary talks directly to IMAP and SMTP hosts. The only third-party lookup is the ISPDB autoconfig request during account setup (`accounts-autoconfig.vala`).

**Background mode is the closest thing to a daemon.** **[V]** With `run-in-background` enabled, the primary GApplication instance keeps running after its last window closes (`application-client.vala:183-187, 1266-1271`). It registers an autostart entry that launches `geary --gapplication-service`, either through the XDG Background portal under Flatpak or with a `~/.config/autostart` desktop file (`application-startup-manager.vala:69-145`). The engine keeps INBOX open with IDLE and posts desktop notifications through a plugin. Later launches of the app become *remote* GApplication instances that hand their arguments to the primary over D-Bus. So Geary is effectively "a headless engine that sometimes has windows". But the windows always live in the same process as the engine.

**Power management.** **[V]** Every `ClientService` subscribes to logind's `PrepareForSleep`. It stops before suspend and restarts on resume (`api/geary-client-service.vala:497-509`).

### 3b. Connectivity per mail provider

| Provider | Protocol | Auth | Where tokens live |
|---|---|---|---|
| Gmail | IMAP `imap.gmail.com:993` (implicit TLS) and SMTP `smtp.gmail.com` submission over TLS (`gmail-account.vala:24-37`) | XOAUTH2 via GOA, or a password (app password) through the "Other" path | Refresh token held by GOA in the keyring. Geary fetches a fresh access token per connection and keeps it only in memory (`goa-mediator.vala:45-101`). |
| Outlook.com | IMAP `imap-mail.outlook.com:993` and SMTP `smtp-mail.outlook.com:587` STARTTLS (`outlook-account.vala:16-29`) | XOAUTH2 via GOA's `windows_live` provider | Same as Gmail |
| Everything else | IMAP and SMTP from manual entry or autoconfig | PLAIN/LOGIN with a password. XOAUTH2 is used if GOA supplies an OAuth account. | libsecret, keyed by `(proto, host, login)` (`secret-mediator.vala:7-16, 166-174`) |

Notes:
- **Geary has no OAuth code of its own.** **[V]** Choosing Gmail or Outlook goes straight to GOA (`accounts-editor-add-pane.vala:553-558`). The engine only knows a `Credentials{method, user, token}` triple and builds the XOAUTH2 SASL string (`imap/command/imap-authenticate-command.vala:18-19`, `smtp/smtp-oauth2-authenticator.vala`). The `CredentialsMediator` interface (`load_token`, `update_token`, `clear_token`) is the seam: the engine never stores secrets.
- **Auth failures.** For GOA accounts, the controller calls GOA's `EnsureCredentials` and retries, up to `MAX_AUTH_ATTEMPTS = 3`. For password accounts it shows a password dialog (`application-controller.vala:20, 1170-1240`). **[V]**
- **Outlook host is legacy.** **[I]** `imap-mail.outlook.com` is an old consumer hostname. Current guidance is `outlook.office365.com`. This is one sign of reduced maintenance.
- **Gmail is plain IMAP.** **[V]** Geary does not use the `X-GM-EXT-1` extensions. `rg -i 'x-gm'` finds only quirk comments. Labels appear as folders, archive is a MOVE to All Mail (`gmail-folder.vala`, `archive_email_async`), and the same message in several labels is collapsed through duplicate detection (§3d).
- **Encryption at rest.** **[V]** There is none for mail: `geary.db` is plain SQLite and attachments are plain files. Secrets rely on the keyring being encrypted with the login password.

### 3c. Sync algorithm

Geary's sync is built from four cooperating pieces.

**1. A per-account serial operation queue: the `AccountProcessor`.** **[V]** (`imap-engine/imap-engine-account-processor.vala`)
- Every background job (load folders, update remote folders, full or refresh sync of a folder, GC, search-index population) is an `AccountOperation`, and jobs run **one at a time per account**.
- The queue rejects duplicates by `equal_to`. Asking to "sync INBOX" while one is queued is a no-op (`enqueue`, `allow_duplicates = false`).
- An op that fails with `ImapError.NOT_CONNECTED` is retried once (`MAX_NETWORK_ERRORS = 1`). Any other error is reported, and the queue moves on.
- This structure is why Geary never floods a server: concurrency is bounded by design, not by tuning.

**2. Folder sync via the `AccountSynchronizer`.** **[V]** (`imap-engine/imap-engine-account-synchronizer.vala`)
- **On connect or folder discovery:** a `FullFolderSync` is queued for every selectable folder (`folders_discovered`, `send_all(..., FULL_SYNC)`).
- **Initial or backfill sync:**
  - Find the oldest message stored locally.
  - Walk backwards from it in **3-month steps** (`next_epoch.add_months(-3)`) until reaching the window edge, which is `now − prefetch_period_days`. Each step runs an IMAP `SEARCH SINCE <date>` (`find_earliest_email_async`, `minimal-folder.vala:1489-1532`). That pulls the matching UIDs into the local vector as stubs with no fields, and then waits for the prefetcher.
  - Because each step is committed and the next run starts from "oldest local", **resume is implicit**. A crash halfway through just continues from where the DB ends. No cursor bookkeeping is needed.
- **Window shrink:** messages older than the window are *detached* (the location row is removed) and later reaped by GC (`detach_emails_before_timestamp`).
- **Refresh:** a `RefreshFolderSync` simply opens the folder, which triggers normalization (below).

**3. Normalization when a folder opens.** **[V]** (`imap-engine/imap-engine-minimal-folder.vala:380-737`) This is classic RFC 3501 sync without CONDSTORE:
- **UIDVALIDITY changed:** detach every message (contents are kept so duplicate detection can relink them) and start over.
- **UIDNEXT unchanged, message count unchanged and no leftover "remove markers":** nothing to do.
- **UIDNEXT delta equals the count delta:** pure append. Fetch UIDs above the local maximum.
- **Otherwise:** list UIDs over the local range on both sides and diff them in a background thread to find appended, inserted and removed messages.
- **Flags:** after opening, `update_flags` re-fetches FLAGS for *every* local message in chunks that grow from 20 to 100. A comment there notes CONDSTORE `CHANGEDSINCE` would replace this, but **CONDSTORE and QRESYNC are not implemented** (`rg -i condstore` hits only that comment, line 1582).

**4. Body prefetching by the `EmailPrefetcher`.** **[V]** (`imap-engine/imap-engine-email-prefetcher.vala`)
- After a folder opens, every message that is not yet complete is queued, **ordered newest first** (`compare_recv_date_descending`).
- Messages are fetched in **512 KB byte-budgeted batches** (`PREFETCH_CHUNK_BYTES`), with a **200 ms sleep between batches**.
- A message bigger than the budget is fetched on its own. Messages of unknown size go last, one at a time.
- The fetch asks for every field (`PREFETCH_FIELDS = ALL`). So every message inside the window ends up with its full body cached.

**Push and polling.** **[V]**
- **Only INBOX is held open** by the controller (`application-controller.vala:1350-1356`), with IMAP IDLE when supported (`imap-client-session.vala:1209-1222`). The folder being viewed also IDLEs while open.
- Every other folder is checked **every 15 minutes** with LIST + STATUS (`REFRESH_FOLDER_LIST_SEC`). Folders whose STATUS changed get a refresh sync (`generic-account.vala:1380-1470`).
- Keepalives are about 9.5 min on unselected or IDLE sessions, and a NOOP every 2 min on selected sessions without IDLE (`imap-client-session.vala:36-75`). The pool keeps at least 2 sessions per account (`IMAP_MIN_POOL_SIZE`).

**Rate limits, retries and backoff.** **[V]**
- There is no explicit quota model. Pacing comes from the structure: serial account ops, byte-budgeted prefetch with sleeps, one IDLE folder, and 15-minute STATUS polling.
- Retries are minimal: one retry for not-connected in the account processor, and `MAX_OP_RETRIES = 1` for replay ops (`imap-engine-replay-queue.vala:23`). The SMTP path has `MAX_RETRIES = 3` for one step (`smtp-client-service.vala:450`).
- Reconnection is driven by **connectivity events**, not timers:
  - `ConnectivityManager` reacts to `NetworkMonitor` changes and runs a reachability probe. It re-probes every 60 s anyway (`CHECK_QUIESCENCE`).
  - `ClientService` debounces: 1 s to mark a service unreachable, 3 s before reconnecting once reachable again (`geary-client-service.vala:21-26`).
- **Status taxonomy** (`geary-client-service.vala:38-136`): `UNKNOWN, UNREACHABLE, CONNECTED, CONNECTION_FAILED, AUTHENTICATION_FAILED, TLS_VALIDATION_FAILED, UNRECOVERABLE_ERROR`. Only the first four reconnect automatically (`automatically_reconnect()`). Auth, TLS and unrecoverable errors stop and wait for the user. That rule is exactly right.

**Offline operations and conflicts: the `ReplayQueue`.** **[V]** (`imap-engine-replay-queue.vala`, `imap-engine-replay-operation.vala`, `replay-ops/*`)
- Each open folder has a replay queue. User operations (mark, move, copy, remove, create) are `ReplayOperation`s with three steps:
  - `replay_local_async`: apply to SQLite now and update the UI optimistically.
  - `replay_remote_async`: apply to the server once a session exists.
  - `backout_local_async`: undo the local change if the remote step fails. For example, `MarkEmail` stores the original flags and restores them (`replay-ops/imap-engine-mark-email.vala`).
- Server notifications (EXISTS, EXPUNGE, FETCH) go through the same queue. Because unsolicited responses address messages by sequence number, the queue **holds notifications for 1 s after the last one arrives** before applying them (`NOTIFICATION_QUEUE_WAIT_MSEC = 1000`). It also renumbers queued ops when an expunge shifts positions.
- **Conflict policy:** the local change wins until the remote step runs. Unread counts from the server are adjusted by the pending local delta (`pending_unread_change`, used in `generic-account.vala:1395-1402`). There is no merge logic beyond that.
- **Big caveat: the replay queue is in memory only.** `close_async(flush_pending=false)` *backs out* every op that ran locally but not yet remotely (lines 360-385). There is no persisted op table in the schema (§3d). An offline flag change survives only as long as the folder stays open. **[V]** for the code. **[I]** for the practical effect: quitting while offline loses the change on the server side, and the next normalization may revert it locally.
- **Moves are "revokable":** the source hides the messages through a `remove_marker` column, and the real IMAP MOVE is committed after 5 s or when the folder closes. Leftover markers make the next normalization treat the folder as "dirty" (`minimal-folder.vala:448-465`).

**Outbox.** See §3f. It *is* durable (SQLite), unlike the replay queue.

### 3d. Local storage

**Engine and layout.** **[V]**
- One SQLite database per account at `$XDG_DATA_HOME/geary/<account_id>/geary.db`, plus an `attachments/` directory (`imap-db-account.vala:12-13, 64-65`).
- Account configuration is kept separately in `$XDG_CONFIG_HOME/geary/<account_id>/geary.ini` (`accounts-manager.vala:28`).
- Pragmas (`imap-db-database.vala:620-686`): `foreign_keys=on`, `recursive_triggers=on`, `synchronous=NORMAL`, a 60 s busy timeout, and a temp store under the cache dir. **WAL is not set**, so the default rollback journal is used (`rg journal_mode` finds nothing).
- Async transactions run on a 4-thread pool (`db/db-database.vala`, `DEFAULT_MAX_CONCURRENCY = 4`).
- A corruption check runs at open (`check_for_corruption`).

**Schema** (after 30 migrations in `sql/version-001..030.sql`):

| Table | Main columns | Purpose |
|---|---|---|
| `FolderTable` | `id, name, parent_id, last_seen_total, last_seen_status_total, uid_validity, uid_next, attributes, unread_count` | Folder tree and IMAP sync state |
| `MessageTable` | `id, fields` (bitmask), `date_field, date_time_t, from_field, sender, reply_to, to_field, cc, bcc, message_id, in_reply_to, reference_ids, subject, header, body, preview, flags, internaldate, internaldate_time_t, rfc822_size` | **One row per unique message, shared across folders** |
| `MessageLocationTable` | `id, message_id → MessageTable, folder_id → FolderTable, ordering` (the IMAP UID), `remove_marker` | Many-to-many link: which folder holds which message at which UID |
| `MessageAttachmentTable` | `id, message_id, filename, mime_type, filesize, disposition, content_id, description` | Metadata. The bytes live in files. |
| `MessageSearchTable` | FTS5 over `body, attachments, subject, from, receivers, cc, bcc, flags`, using `tokenize=geary_tokeniser`, `prefix=2,4,6,8,10` | Search |
| `ContactTable` | `normalized_email, real_name, email, highest_importance, flags` | Autocomplete ranking |
| `SmtpOutboxTable` | `id, ordering, message` (full RFC 822 text), `sent` | Durable outbox |
| `DeleteAttachmentFileTable` | `filename` | Two-phase file deletion |
| `GarbageCollectionTable` | `last_reap_time_t, last_vacuum_time_t, reaped_messages_since_last_vacuum, last_cleanup_time_t` | GC bookkeeping |

**Key design ideas:**
- **Partial rows and a field bitmask.** **[V]** `MessageTable.fields` records which parts of the message are present: DATE, ORIGINATORS, RECEIVERS, REFERENCES, SUBJECT, HEADER, BODY, PROPERTIES, PREVIEW and FLAGS (`api/geary-email.vala:64-111`, "THESE VALUES ARE PERSISTED"). Every list call names the fields it needs. The engine serves complete rows from SQLite and fetches only the missing pieces (`ListFlags.LOCAL_ONLY`, `FORCE_UPDATE`, `PARTIAL_OK`). This one abstraction is what lets envelopes arrive first and bodies later without separate code paths.
- **Cross-folder deduplication.** **[V]** When a new location is written, the engine looks for an existing row with the same `internaldate + rfc822_size` (plus `message_id` when present) and links it instead of inserting a duplicate (`imap-db-folder.vala:1475-1530`, `do_create_or_merge_email`). This is how Gmail's labels-as-folders avoid N copies.
- **Bodies and attachments.** **[V]** The body is fetched as `BODY.PEEK[TEXT]` (`imap-folder-session.vala:447-452`) and stored in `MessageTable.body`. Attachments are decoded into files under `attachments/` (`imap-db-attachment.vala:150-215`). **[I]** So attachment bytes are stored twice: encoded inside `body` and decoded on disk. Every message in the window is prefetched in full, so the disk cost is roughly the full size of the window's mail.
- **Search.** **[V]**
  - FTS5 with a custom ICU-based tokenizer that handles CJK and Thai word boundaries (`imap-db-fts5-tokeniser.c`), plus a `geary_matches()` function for highlighting.
  - The index is *not* stemmed. Instead, the query side adds stemmed prefix terms with Snowball, with heuristics to keep it from over-matching (`common-fts-search-query.vala:165-200`).
  - The index is filled in background batches with 50 ms sleeps (`imap-db-account.vala:772-851`).
  - Search covers local mail only. Server SEARCH is used internally, only to find window edges.
- **Eviction and GC.** **[V]** (`imap-db/imap-db-gc.vala`)
  - Messages outside the window are detached.
  - Messages with no location for 30 days are reaped (`UNLINKED_DAYS = 30`) at most every 10 days.
  - Reaping paces itself: a 15 ms sleep every 10 DB ops.
  - Attachment files are deleted through `DeleteAttachmentFileTable`, so a failed transaction never leaves dangling or missing files.
  - VACUUM runs only when at least 30 days have passed and 10k messages were reaped or 500 MB can be reclaimed. It runs only when the app has been backgrounded for a while (`IdleGarbageCollection`, `application-controller.vala:149`), and it stops IMAP and SMTP while it runs.
- **Migrations.** **[V]** Numbered SQL files run by `Db.VersionedDatabase`. Code migrations (re-encoding folder names, fixing dates, rebuilding attachments) hook in through `post_upgrade(version)` for placeholder versions such as 6, 15 and 22 (`imap-db-database.vala:251-290`), with a progress monitor.

### 3e. The API between UI and engine

**Shape.** **[V]** In-process object API, with no wire protocol:
- `Geary.Engine` holds the accounts (`api/geary-engine.vala`).
- `Geary.Account` exposes the folder list, `local_search_message_id_async`, special folders, a contact store and `report_problem`.
- `Geary.Folder` exposes `open_async(OpenFlags)` and `list_email_by_id_async(initial_id, count, fields, ListFlags)` (`api/geary-folder.vala:690`). It has sparse-ID variants and optional capabilities as interfaces (`FolderSupport.Archive / Copy / Create / Empty / Mark / Move / Remove`). Each capability returns a `Revokable` for undo.
- `App.ConversationMonitor` runs **in the client process**. It turns a folder into a live set of conversations. It loads windows of 5 to 20 messages at a time (`app-fill-window-operation.vala`, `MAX_FILL_COUNT = 20`), first locally and then from the server if needed. It pulls in each message's thread "closure" across folders through the Message-ID index.

**Realtime propagation.** **[V]** GObject signals:
- On `Folder`: `email_appended`, `email_inserted`, `email_removed`, `email_flags_changed`, `email_locally_complete`, `email_count_changed` and `use_changed` (`geary-folder.vala:335-459`).
- Account-level aggregates of those, plus `folders_available_unavailable`.
- A "locally" variant of each event separates "the cache changed" from "the server told us".

**Pagination.** **[V]** Cursor-based by email ID, with a field mask and flags (`OLDEST_TO_NEWEST`, `INCLUDING_ID`, `LOCAL_ONLY`, `FORCE_UPDATE`, `NO_UNREAD_UPDATE`).

**Serializable IDs and a plugin facade.** **[V]** Email IDs serialize to `(rowid, uid)` and folder paths to `(sas)` GVariants (`imap-db-email-identifier.vala:12`, `geary-folder-path.vala:22`). `client/plugin/plugin-*.vala` exposes a narrow surface (`EmailStore.get_email(ids)`, `FolderStore.get_folders`, `email_sent` / `email_displayed` signals, `Email.load_body_as(type)`) and never hands plugins engine objects. **[I]** This is the closest Geary gets to a client API, and a good template for a local-server API.

### 3f. Send, drafts, threading, labels, contacts, calendar, AI

**Send pipeline.** **[V]** (`smtp/smtp-client-service.vala`)
1. `save_email` builds the RFC 822 message, using 8BITMIME if the server advertises it (a short SMTP connection probes this). It generates the Message-ID and inserts the message into `SmtpOutboxTable`.
2. `queue_email` hands the ID to the in-memory "postie" queue. On start, `fill_outbox_queue` re-queues every row still in the table, so a crash or quit never loses mail.
3. The postie runs only while SMTP is reachable (`became_reachable` / `became_unreachable`). For each message it:
   - refreshes credentials;
   - sends;
   - **immediately sets `OUTBOX_SENT`** on the row, without honoring cancellation, so a later failure can never cause a resend;
   - saves the message to Sent, or for Gmail and Outlook (`save_sent = false`) syncs Sent to pick up the provider's copy;
   - deletes the row.
4. Errors map onto the status taxonomy: auth → `AUTHENTICATION_FAILED`, network → `CONNECTION_FAILED`, protocol → `UNRECOVERABLE_ERROR`.
5. **Undo send:** the message is saved to the outbox but queued only after `undo-send-delay` seconds (default 5). Undo deletes the row and reopens the composer (`SendComposerCommand`). **[I]** If Geary quits during that window, the row is still there and is sent on the next start. That is safe, but it may surprise the user.

**Drafts.** **[V]** (`app/app-draft-manager.vala`)
- One `DraftManager` per composer, with a single-worker queue.
- A new save **drops any older save still waiting in the queue**, so only the latest version is uploaded (`submit_push`).
- A save APPENDs the new draft to the server's Drafts folder and then removes the previous one. On Gmail, removal goes through Trash to really delete (`gmail-drafts-folder.vala`).
- States: `NOT_STORED, STORING, STORED, ERROR`. The composer shows "Saved".
- The composer autosaves 10 s after the last edit (`composer-widget.vala:577`).

**Threading.** **[V]**
- Pure header-based threading: a message's "ancestors" are its Message-ID, References and In-Reply-To (`geary-email.vala:558-574`).
- `ConversationSet` maps every *logical* Message-ID, including ancestors it has never seen, to exactly one conversation. It merges conversations when a new message bridges two of them (`app-conversation-set.vala`, `add_all_emails`).
- **Nothing about threads is persisted.** Conversations are recomputed in the client, per monitored folder, using `MessageTable` indexes on `message_id` and `in_reply_to`.
- No provider thread IDs are used (no X-GM-THRID).

**Labels and folders.** **[V]**
- Strictly folders. Special-use roles come from SPECIAL-USE or XLIST (`api/geary-folder.vala`, `Folder.SpecialUse`).
- Gmail labels are folders, deduplicated through the shared `MessageTable`.
- Archive means MOVE to All Mail on Gmail, and a configured Archive folder elsewhere.

**Contacts, calendar, AI.** **[V]** Contacts are harvested from mail and ranked (sent-to above received-from above seen, `api/geary-contact.vala:15-19`), then merged with Folks. There is no CardDAV, calendar or AI.

---

## 4. Engineering quality

**Tests.** **[V]**
- 80 test files (`test/`) cover the engine (IMAP parser, deserializer, client session and connection, ImapDB account, folder and attachment, account processor, generic account, conversation monitor and set, RFC 822, FTS query), the client (accounts manager, certificate manager, composer, web views) and JavaScript page-state logic.
- `test/test-server.vala` is a **scripted fake server**: the test adds "send line", "expect line" and "disconnect" steps and asserts the transcript. That gives deterministic protocol tests with no real server.
- Integration tests against real servers exist (`test/integration/imap|smtp`) but are manual and need credentials (`test/README.md`).
- **Gaps** **[V]**: there are no tests for `MinimalFolder` normalization, the `ReplayQueue`, the `AccountSynchronizer` or the `EmailPrefetcher`. These are the most complex and most bug-prone parts.

**CI.** **[V]** `.gitlab-ci.yml` builds on a Fedora container and runs `meson test` under `xvfb-run` and `dbus-run-session` with `-t 10` (slow disks). It also builds a Flatpak bundle and uses the GNOME release service. Flatpak builds block merges again as of 2025-11.

**Code organization.** **[V]** `src/engine` has strict layers: `api` (public types); `imap`, `smtp`, `rfc822` and `mime` (protocols); `imap-db` (storage); `imap-engine` (sync policy, with Gmail, Outlook and Other subclasses); `app` (conversations, drafts); `nonblocking` (async mutex, semaphore, queue); and `state` (an FSM helper for the IMAP session). The client is a separate tree. The comments explain *why*, not just what.

**Observability.** **[V]**
- Structured GLib logging goes into an **in-memory ring buffer of 4,096 records** (`util/util-logging.vala:35`).
- Every engine object can implement `Logging.Source`, giving it a log domain, a parent (folder → account) and a state snapshot. Records therefore carry account and folder context automatically.
- `ProblemReport` **copies the ring buffer at the moment an error happens** (`api/geary-problem-report.vala`). The UI shows an info bar whose "Details" opens the Inspector at that snapshot. The Inspector can search logs, show system info and save everything to a file (`components-inspector.vala:143-160`).
- Error contexts include native backtraces via libunwind (`util-error-context.vala`).
- Logs go to stdout only with `--debug` (`application-client.vala:324-325`). Otherwise nothing is written to disk, and there is no crash reporter.

---

## 5. UI notes

- **Toolkit.** **[V]** GTK 3.24 with libhandy 1 (Leaflet, HeaderBar, StatusPage, ActionRow, Avatar). Bodies and composer use WebKitGTK 4.1, with a bundled `ui/darkreader.js` for dark mode.
- **Conversation list.** **[V]** Rewritten in 44.0 as `Gtk.ListBox` rows over a model that grows the `ConversationMonitor` window as you scroll (`conversation-list-model.vala:68`).
- **Motion.** **[V]** Minimal and mostly GTK defaults:
  - The `.ui` files set transition *types* only (`crossfade`, `slide-up`, `slide-down`, `over`, `slide-left-right`), with no explicit durations. GTK's defaults apply (about 200-250 ms) **[I]**.
  - The CSS has two border transitions (0.25 s and 4 s) in `ui/geary.css:200, 234`.
  - In-app toasts stay for 5 s (`components-in-app-notification.vala`, `DEFAULT_DURATION = 5`).
  - There is no spring or easing library.
- **Keyboard model.** **[V]**
  - Standard Ctrl accelerators.
  - An opt-in **single-key mode** implemented as a GTK CSS key-binding set on the main window (`ui/single-key-shortcuts.css`): `r/a/f` reply, reply-all and forward; `e` archive; `!` junk; `#` delete; `s` star; `Shift+I` / `Shift+U` read and unread; `l` / `v` label (copy) and move menus; `/` find; `j/k` navigation.
  - Gmail-style mnemonics, off by default (gschema `single-key-shortcuts`).
- **Email HTML rendering.** **[V]** (`components-web-view.vala:335-353`, `web-process-extension.vala`)
  - Bodies render in WebKit's separate web process.
  - JavaScript is on for Geary's own injected scripts, but `enable_javascript_markup = false` stops `<script>` tags and inline handlers in the email from running **[I, from WebKitGTK's documented setting semantics]**.
  - The web extension's `send_request` hook **blocks every load except `cid:`, `geary:`, `data:` and `blob:`** unless the user allowed remote content for that message or its domain.
  - `cid:` parts are served from memory through a registered URI scheme.
  - Navigation is intercepted (`on_decide_policy`).
  - Hardware acceleration is off. HTML5 storage, plugins, media and fullscreen are disabled.

---

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **A serial, deduplicating job queue per account for all background sync.** Geary never runs two sync jobs for the same account at once, and "sync X" while X is already queued is a no-op. This alone would have prevented the burst behind Aplos's 403s (500 `threads.get` at concurrency 4). Aplos should allow one in-flight background job per account. User actions keep their own lane.
2. **A small default window, walked backwards in committed slices, with resume derived from the data.** Geary defaults to 14 days and steps back in 3-month slices from "oldest local". Each slice is committed, so a crash resumes for free. For Gmail, the same idea means a narrow first window (for example 14-30 days of Inbox and Sent), `messages.list` pages committed one at a time, and the next page derived from what is already stored, so no fragile cursor is needed.
3. **Envelope first, bodies later, under a byte or quota budget, newest first, with pauses.** Geary's prefetcher uses 512 KB batches with 200 ms sleeps, newest first. Aplos should fetch `format=metadata` (or the IMAP envelope) for the window, show the list immediately, and then prefetch bodies newest first under a quota-unit token bucket. Bodies the user opens jump the queue.
4. **A persisted "which fields are present" bitmask on each message row.** This lets "complete enough for the list" and "complete enough to read" share one table and one code path. Lazy bodies, eviction and partial failures all become natural. Aplos's JSON-blob thread rows cannot express this today.
5. **One message row shared across folders or labels, with a location table.** This is Geary's `MessageTable` + `MessageLocationTable`. It fits Gmail labels, IMAP copies and Outlook categories, and it stops the same mail from being stored many times.
6. **A status taxonomy that decides retry policy.** Use Geary's states: unknown, unreachable, connected, connection-failed, auth-failed, TLS-failed, unrecoverable. Reconnect automatically only for the transient ones. Map Google's `reason` values into these: `invalid_grant` → auth-failed (Reconnect), `quotaExceeded` → unrecoverable until tomorrow, `rateLimitExceeded` → transient with backoff. Show the state per account in Settings.
7. **Connectivity-driven reconnection with debounce, plus suspend and resume hooks.** React to network changes (wait 1 s before declaring offline, 3 s before reconnecting) and re-check every 60 s. Stop services before sleep and restart after wake. In Electron, use `net.isOnline` / `powerMonitor` `suspend`, `resume` and `lock-screen`. Don't rely on a fixed 60 s poll.
8. **A log ring buffer with context, snapshotted into every surfaced error.** Every engine object tags its records with account and folder. When an error reaches the UI, attach the last N records to it. Add a "Details / Copy diagnostics" action. Do better than Geary by also writing a rotating, redacted log file.
9. **The send-once outbox protocol.** Persist the message, send it, set a durable "sent" flag right away (ignoring cancellation), then file it in Sent, then delete the row. Skip the save-to-Sent step for providers that file sent mail themselves (Gmail API, Graph). Aplos's duplicate-send guard is already strong, so check that it marks "sent" before any follow-up step that might fail.
10. **Draft saves that coalesce.** Use one worker per draft and drop older saves still waiting in the queue, so only the latest version uploads. Show four visible states (not stored, saving, saved, error). Autosave about 10 s after the last edit. This is the shape Gmail draft sync (`drafts.create` / `drafts.update`) should take.
11. **Undo through a short commit delay.** Hide moved or archived items locally, commit to the server after about 5 s, and run the same machinery for undo send. Aplos's op queue can carry a `notBefore` timestamp to get this for free.
12. **Email HTML in an isolated renderer with markup scripts off and network loads denied by default.** The Electron version of Geary's model:
    - Render in a sandboxed `<iframe srcdoc>` with an opaque origin, or in a separate `WebContentsView` with JavaScript disabled.
    - Use a session-level `webRequest` filter that allows only `cid:` and `data:` until the user trusts the sender or domain.
    - Serve `cid:` through `protocol.handle`.
    - Keep this content out of the window that holds `window.aplos`.
13. **Paced, crash-safe GC:** detach, reap after a grace period, delete files in two phases, and VACUUM only while idle with sync paused.
14. **Multilingual search:** FTS5 with an ICU-aware tokenizer, query-side stemming, and background indexing in small batches.
15. **Transcript-style fake-server tests** ("expect", "send", "disconnect") that cover the paths Geary never tested: normalization, replay and prefetch.

### Avoid

1. **An offline op queue that lives only in memory.** Geary backs out any unflushed operation when a folder closes. Aplos's durable SQLite op queue is better. Keep it, and make sure every user mutation goes through it.
2. **Re-fetching all flags on every open.** Without CONDSTORE, Geary re-reads flags for every local message on every folder open. Aplos's IMAP adapter already uses CONDSTORE `changedSince` (`aplos:src/main/imap.ts:287-288`). Go further with QRESYNC/VANISHED for deletions, and keep Gmail on `history.list`.
3. **Prefetching every message's full body inside the window, and storing raw MIME plus decoded attachments.** That roughly doubles attachment storage and costs bandwidth or quota for mail nobody opens. Aplos should cache parsed text and HTML parts, fetch attachments lazily, and set a byte budget per account.
4. **Delegating OAuth to an OS service.** GOA doesn't exist on macOS, and it puts token lifecycle outside your diagnostics. Keep Aplos's own OAuth. Copy only the *seam*: an engine-side credentials provider interface where the engine never persists secrets.
5. **Using Gmail over plain IMAP** to escape API quotas. The IMAP scope (`https://mail.google.com/`) is also restricted, so CASA still applies **[I]**. You also lose labels-as-labels, thread IDs and `history` deltas. Geary's labels-as-folders plus dedupe model is a workaround, not a goal.
6. **Computing threads only in the client.** Geary rebuilds conversations in the UI process for each folder view. That works for one in-process UI. It fails for a local server with several clients, where each client would have to re-run the closure. Persist a thread table in the engine.
7. **A single retry and no backoff.** Geary relies on IMAP being cheap and on connectivity events. HTTP APIs with quotas need exponential backoff with jitter, `Retry-After` / "Retry after <date>" parsing, and a stop-for-today state.
8. **Rollback journal with a 60 s busy timeout,** which lets a long write stall reads **[I]**. Keep Aplos's WAL and short transactions.
9. **Logs that never reach disk and no crash reporter.**

---

## 7. "Local server" translation

**What Geary already proves.** Geary's "run in background" mode is a one-process daemon. The engine keeps running with INBOX on IDLE, and windows come and go. Its layering (engine API, signals, serializable IDs, the narrow plugin facade) already separates *what the UI may ask* from *how sync works*. What Geary never did is put a process boundary or network boundary between the two. Aplos has already taken half of that step: its engine runs in a `utilityProcess`, receives its host services through ports (`aplos:src/engine/ports.ts`), and the dev server exposes `POST /api/invoke` + SSE `/api/events` with `{epoch, rev}` change stamps (`aplos:src/main/server.ts`, `src/shared/live.ts`).

**Proposed mapping (Geary concept → Aplos local daemon):**

| Geary concept | Aplos daemon equivalent |
|---|---|
| `Engine` / `Account` / `Folder` objects | REST resources: `/accounts`, `/accounts/:id/mailboxes`, `/threads`, `/messages/:id` |
| `list_email_by_id_async(initial_id, count, fields, flags)` | `GET /mailboxes/:id/threads?after=<cursor>&limit=50&fields=envelope,flags,preview&source=local\|remote` (a field mask, as in JMAP's `properties`) |
| `Email.Field` bitmask on each row | `completeness` column. The API answers "partial" and the client asks for `fields=body` on open. |
| GObject signals (`email_appended`, `email_flags_changed`, …) | One WebSocket (or SSE) stream per client: `{account, seq, type, ids}` with a monotonic per-account `seq`. A client reconnecting with `since=<seq>` gets deltas or a "resync" event (JMAP `state` / `Email/changes` semantics). Aplos's `{epoch, rev}` already does this for one window. |
| `ConversationMonitor` in the client | Server-side thread table plus `GET /threads/:id` returning the whole conversation. Clients never compute closures. |
| `ReplayQueue` local → remote → backout | `POST /ops` (mark, move, archive, send, snooze) answered with `202 {opId}`. The op is applied locally and announced on the stream, and remote completion or backout is announced later. Keep Aplos's durable op table. Add a `notBefore` field for undo. |
| `AccountProcessor` | Daemon-internal scheduler: one background lane per account, deduplicated jobs, quota token bucket |
| `ClientService.Status` + `ProblemReport` | `GET /accounts/:id/status` (state, last error with Google `reason`, granted scopes, token expiry) and `GET /diagnostics` (log snapshot, redacted) |
| `--gapplication-service` + autostart | A macOS LaunchAgent registered through `SMAppService` (Electron: a login-item helper). The Electron UI connects to it, and the daemon keeps IDLE and push running when windows are closed. |
| `logind PrepareForSleep` | `powerMonitor` suspend/resume (Electron host), or `NSWorkspace` sleep and wake notifications in a native helper |
| WebKit web process + `send_request` filter | The daemon serves `GET /messages/:id/body?mode=safe` with sanitized HTML and rewritten `cid:` URLs, plus `GET /proxy/image?u=…` for remote images the user trusts. The UI (Electron or phone) renders in a sandboxed frame with JavaScript off. |

**Transport and security.**
- Bind to `127.0.0.1` on a random port. Write the port and a per-boot bearer token to a 0600 file, or pass them to the Electron UI over a Unix-domain socket.
- Keep the existing Host and Origin checks.
- For a phone on the LAN: pair with a QR code that carries a long-lived device key, then use TLS with a pinned self-signed certificate.
- Through a relay: end-to-end encrypt with the device key, so the relay only sees ciphertext. That way the "your mail never touches our servers" claim survives.

**Pros.**
- **One owner of SQLite and sync.** No `latestState` copy in main, no whole-mailbox clones, and memory bounded by query results rather than mailbox size (Geary's DB-first model).
- **Sync, IDLE, `history` polling, the outbox and notifications keep running with the UI closed,** as in Geary's background mode.
- **The phone becomes just another API consumer,** with no second sync engine.
- **Crash isolation:** a UI crash never interrupts a send.
- **The API is the test seam** for Playwright and the eval.

**Cons and risks.**
- **Keychain access outside Electron.** `safeStorage` is Electron-only, so either add a Keychain native module or run the daemon as a headless Electron binary. Signing and notarizing the helper add work.
- **Daemon/UI version skew after updates** needs an API version handshake, a restart path, and migrations that run with no UI attached.
- **Attack surface:** other local processes, and DNS rebinding if Host checks regress. Token auth is mandatory.
- **The Mac still sleeps,** so provider-side filters remain the only always-on automation (see SYNTHESIS).
- **No Geary precedent for multi-client conflicts.** Order ops by daemon receive time and use client-generated `opId`s as idempotency keys.

**Effort (one developer plus agents).** **[I]**
1. Promote today's dev HTTP server into the real UI transport inside the existing `utilityProcess`: typed contract, token auth, WebSocket deltas with `since=<seq>`, paged queries instead of `clone(state)`. **2-3 weeks.** This mostly overlaps with weakness 9 in SYNTHESIS.
2. Schema move to message, location and thread tables with a completeness bitmask, and lazy bodies. **2-3 weeks**, plus migration testing on the 10k fixture.
3. Detach the engine into a LaunchAgent helper, with Keychain, signing, update coordination and a reconnecting UI. **1-2 weeks.**
4. LAN pairing for a phone, then a relay with end-to-end encryption. **3-6 weeks**, and it shouldn't start before the desktop app has real users.

**Verdict.** **[I]** Geary's design is the right *storage and sync* model for Aplos's IMAP, iCloud and Fastmail wedge: a DB-first, field-masked, job-serialized, connectivity-aware engine. It also shows that a "background engine with optional windows" works for a desktop mail app. Its weak points (in-memory replay, no CONDSTORE, full prefetch, client-side threading, logs only in memory) are exactly where Aplos should go its own way. Build the local server as a re-plumbing of the existing engine: steps 1-2 above. Start with the HTTP and WebSocket contract inside the current process, and move to a separate LaunchAgent only once the contract is stable.
