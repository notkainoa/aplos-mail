# Mailspring + Mailspring-Sync: architecture audit for the Aplos revamp

2026-10-25. This is a read-only review of two shallow clones in `/Users/knewton/.t3/aplos-research/src/`: `Mailspring` at `fed072c` (2026-10-23) and `Mailspring-Sync` at `1366c55` (2026-10-24). Nothing was built, installed or run. Paths start with `Mailspring/` (the Electron client) or `Mailspring-Sync/` (the C++ engine). **[V]** marks a fact verified in code or through the GitHub API. **[I]** marks my inference. Both repos are GPL-3.0, so everything below is ideas only. No code has been copied.

Prior research (`research/inbox-zero/*`) already covers Aplos's own architecture and the Gmail first-sync problem, so this report only compares against it.

---

## 1. Overview

**Purpose.** Mailspring is a multi-account desktop mail client for macOS, Windows and Linux, with calendar and contacts. It is the successor to Nylas Mail and is maintained by one of its original authors (Ben Gotow). The main architectural change from Nylas was replacing the JavaScript sync code, and Nylas's cloud sync, with a local C++ engine built on MailCore2/libetpan. That engine is spawned by the Electron app and runs on the user's machine (`Mailspring/README.md`). **[V]**

**License.** Both repos are GPL-3.0 (`LICENSE.md` in each; GitHub reports `GPL-3.0`). The backend at `id.getmailspring.com` is not open source. The Foundry376 org has no server repo. That backend handles identity, plugin-metadata sync, open/link tracking and crash reports. Two more details:
- `Mailspring-Theme-Starter` is MIT. `Mailspring-Plugin-Starter` has no license, which means all rights reserved. **[V]**
- Release builds of the engine exit with code 2 unless their own executable path contains the string "mailspring". The check hides that string by assembling it from slices of the usage text (`Mailspring-Sync/MailSync/main.cpp:1011-1021`). It is a deliberate guard against forks reusing the binary. **[V]**

**Activity and maturity.** **[V]** (GitHub API, 2026-10-25)

| | Mailspring (client) | Mailspring-Sync (engine) |
|---|---|---|
| Stars / forks | 17,940 / 1,064 | 167 / 70 |
| Created | 2016-10 | 2017-06 |
| Last push | 2026-10-23 | 2026-10-24 |
| Commits in last 12 months | 699 | 190 |
| Top contributors | bengotow 4,027; emorikawa 1,324; jstejada 1,134 (Nylas era) | bengotow 636 of about 680; 16 contributors total |
| Releases | 1.24.1 (Sep 15) to 1.26.2 (Oct 22, 2026): five releases in five weeks | Shipped inside the client |

Both repos have a `CLAUDE.md`, and an account named `claude` has 8 engine commits. The project is clearly AI-assisted now, much like Aplos. Size: the client is about 147k lines of TS/TSX across `app/src` and 53 `app/internal_packages`. The engine is about 24.6k lines of C++ in `MailSync/`, not counting vendored mailcore2/libetpan, plus a 7.7k-line Python test harness with 88 scenarios. **[V]**

**Target user.** People with several IMAP, Gmail or Office 365 accounts who want a fast, themeable desktop client. Mailspring Pro (a subscription) adds read receipts, link tracking, analytics and contact profiles, and the README says credentials never go to the cloud (`Mailspring/README.md`). **[V]**

## 2. Feature inventory

| Feature | Evidence | Maturity |
|---|---|---|
| Multi-account IMAP/SMTP, unified inbox | `Mailspring-Sync/MailSync/SyncWorker.cpp` | Mature (9 years, schema v13) |
| Gmail over IMAP (X-GM-LABELS, X-GM-THRID, X-GM-MSGID) | `SyncWorker.cpp:487-512`, `MailUtils.cpp:990-1004` | Mature |
| Office 365 / Outlook.com: IMAP XOAUTH2, plus sending through Graph | `CLAUDE.md` "Microsoft Graph Sending"; `TaskProcessor.cpp` `_sendViaGraph` | IMAP mature. Graph send landed Oct 2026 (#162, #165) |
| Provider quirks (iCloud QRESYNC off, Yahoo MESSAGELIMIT, NetEase UIDNEXT 0, Proton Bridge All Mail, Exchange late Sent copies) | `SyncWorker.cpp:410-418, 441-455, 1229-1240` | Mature and actively hardened |
| Local full-text search (FTS5) | `constants.h` `ThreadSearch`, `ContactSearch`, `EventSearch` | Mature. **Remote IMAP search is a TODO** (`internal_packages/thread-search/lib/search-query-subscription.ts:79`) |
| Snooze, send later, reminders | `internal_packages/thread-snooze`, `send-later`, `send-reminders`; `MetadataExpirationWorker.cpp` | Mature, but only fire **while the app runs** |
| Mail rules (client-side) | `app/src/mail-rules-processor.ts`; `rulesReady` delta | Mature |
| List-Unsubscribe (RFC 8058 one-click POST, mailto, https) | `internal_packages/list-unsubscribe/lib/unsubscribe-service.ts:57-93`; headers captured at `MailProcessor.cpp:510-520` | New |
| Templates, signatures, grammar check, translation | Various internal packages | Mature |
| Open/link tracking, Activity feed (Pro) | `open-tracking`, `link-tracking`, `activity`; per-recipient bodies in `performRemoteSendDraft` | Mature, depends on the cloud |
| Calendar (CalDAV including Google; iTIP RSVP, COUNTER; recurrence) | `DAVWorker.cpp` (2,468 lines), `main-calendar` | Under heavy work Sep-Oct 2026 (CHANGELOG 1.26.0 lists about 20 calendar fixes) |
| Contacts (CardDAV + Google People API) | `DAVWorker.cpp`, `GoogleContactsWorker.cpp` | Maturing (V13 migration repairs mangled names) |
| Microsoft calendar/contacts | No Graph calendar or contacts endpoints anywhere in either repo, though O365 sign-in asks for `Calendars.ReadWrite` (`onboarding-constants.ts`) | **[I]** Not implemented |
| Draft sync *up* to the server | `TaskProcessor.cpp:923-924`: the remote phase of the draft-save task does nothing | **Missing**, the same gap Aplos has |
| On-device AI (Apple Foundation Models, Qwen via node-llama-cpp) | `app/src/browser/local-ai-service.ts`, `local-model-provider.ts` | New in 2026 |
| "Views" (sandboxed, AI-authorable mini-apps) | `internal_packages/views`, `browser/view-sandbox-policy.ts` | Experimental |
| Built-in MCP server (localhost HTTP + stdio bridge) | `internal_packages/mcp-server` (3,086 lines) | New, but carefully built |
| Plugins and themes | `PLUGIN_SYSTEM_ARCHITECTURE.md` | Mature. No sandbox, no plugin manager (doc §"Current Limitations") |
| Keymap templates (Gmail, Outlook, Apple Mail, Inbox) | `app/keymaps/templates/*.json` | Mature |

## 3. Architecture deep dive

### 3a. Process and deployment topology

**[V]** The pieces, from the user's machine out to the cloud:

- **Electron main process** (`app/src/browser/`) owns windows, menus, auto-update, the tray, and the on-device AI service. AI runs one prompt at a time in an Electron `utilityProcess` (`local-ai-worker.js`). Answers are cached in their own SQLite file, keyed by item ID, prompt key and model (`local-ai-service.ts`, header comment).
- **Main-window renderer** is where the real orchestration happens:
  - `MailsyncBridge` (`app/src/flux/mailsync-bridge.ts`) runs only in the main window. It spawns **one `mailsync` child process per account** with `child_process.spawn` (`app/src/mailsync-process.ts:200-243`).
  - The renderer opens the database itself through `better-sqlite3` with `readonly: true` (`flux/stores/database-store.ts:53`). Heavy queries go to a forked Node "database agent" (`database-store.ts:354-395`).
  - The MCP HTTP server also lives in this renderer (`mcp-server/lib/main.ts:8-10`). That works because every Mailspring window has `nodeIntegration: true` and `contextIsolation: false` (`browser/mailspring-window.ts:126-129`) and uses `@electron/remote`.
- **Secondary windows** (composer, pop-outs) open their own read-only DB connection. They receive deltas that the main window rebroadcasts through the main process (`mailsync-bridge.ts:517`, the `mailsync-bridge-rebroadcast-to-all` message).
- **`mailsync` (one per account)** is a C++ process with about six threads (`main.cpp:1185-1215`):
  - *main*: reads stdin commands.
  - *background*: folder sync passes.
  - *foreground*: IDLE, body fetches and the remote phase of tasks. It starts only after the first background pass.
  - *calContacts*: CalDAV/CardDAV and Google People.
  - *metadata*: a streaming connection to the Mailspring cloud.
  - *metadataExpiration*: a local timer for snooze and send-later.

  Each thread opens its **own** SQLite connection to the shared `edgehill.db` (`MailStore.cpp:91`).
- **Cloud (`id.getmailspring.com`, closed source)** provides:
  - Mailspring ID sign-in, which is skippable (`onboarding/lib/page-authenticate.tsx`, `skipSupported`).
  - Plugin-metadata sync: a paged backfill, then a long-lived newline-delimited JSON stream with a cursor (`MetadataWorker.cpp`).
  - The crash-report endpoint (`app/src/error-logger.js:162-165`).
  - Tracking.

  Mail and credentials never pass through it. However, the metadata stream URL includes the account's IMAP host (`MetadataWorker.cpp`, `&ih=`). **[V]**

The key design idea is **CQRS across a process boundary**. The engine is the *only* writer. The UI reads SQLite directly and sends writes as "tasks". The engine streams every committed row change back so the UI can update its live queries (`Mailspring/CLAUDE.md`, "Observable Database Pattern"). **[V]**

The cost is many writers against one SQLite file: N accounts, each with about four writer threads. They rely on WAL, `BEGIN IMMEDIATE`, a 60 s busy timeout (`MailStore.cpp:104`), and two hacks. First, each process sleeps 0 to 4 s at start, chosen from the first character of the account ID (`Models/Account.cpp:32-39`). Second, bulk inserts sleep 50 ms after every 250 ms of work so they don't starve other connections (`SyncWorker.cpp:1249-1252`). **[V]** The client also retries "database is locked" with exponential backoff (`database-store.ts:270-300`). **[V]**

### 3b. Connectivity per provider

| Provider | Mail protocol | Auth | Notes |
|---|---|---|---|
| Gmail / Workspace | IMAP + SMTP, XOAUTH2 | OAuth with PKCE + `state`; loopback redirect `http://127.0.0.1:12141` | Scope `https://mail.google.com/` plus contacts, calendar and profile (`onboarding-constants.ts:30-36`). The client ID and secret ship in the app. The secret is lightly obfuscated, and the comment admits forks could reuse it. Calendar uses Google CalDAV (`DAVWorker.cpp:338`). Contacts use the People API (`GoogleContactsWorker.cpp:29`). |
| Office 365 / Outlook.com | IMAP + SMTP with XOAUTH2 (`outlook.office.com` audience). Sending goes through **Microsoft Graph** when `Mail.Send` was granted | OAuth with PKCE, redirect `http://localhost:12141/desktop` | One refresh token, with access tokens cached per audience (`XOAuth2TokenManager.cpp`, key `:graph`). Graph send works around tenants that disable SMTP AUTH (error `5.7.139`). |
| iCloud, Yahoo, Fastmail, generic IMAP | IMAP/SMTP with a password or app password | Server autodiscovery from bundled `mailcore-provider-settings.json` and `mailspring-provider-settings.json` | iCloud: QRESYNC deliberately disabled. Yahoo: RFC 9738 MESSAGELIMIT respected. |
| CalDAV / CardDAV | ctag check, then RFC 6578 sync-token, falling back to ETag listing | Same credentials or OAuth token | Calendars every 15 min, contacts every 75 min (`main.cpp:308-309`) |

**Token storage.** **[V]**
- IMAP/SMTP passwords and refresh tokens are kept in one JSON keyset, encrypted with Electron `safeStorage` (Keychain-backed on macOS) and stored as a blob in `config.json` (`app/src/key-manager.ts`).
- The keyset is decrypted in the renderer. Secrets are merged into the account JSON and **written to the engine's stdin in plaintext** on launch (`mailsync-process.ts:236-242`).
- When a provider rotates the refresh token, the engine sends it back on **stdout** as a `ProcessAccountSecretsUpdated` delta. The client then re-encrypts it (`DeltaStream.cpp`, `sendUpdatedSecrets`; `mailsync-bridge.ts:506-509`).
- Access tokens live only in engine memory, with a 60 s safety margin before expiry.
- Logs are redacted twice: by JSON key and by the literal secret value (`mailsync-process.ts:255-283`).
- A careful detail: when the keyring can't be read, the client fails fatally instead of treating it as an empty keyset. That avoids overwriting every saved password later (`key-manager.ts`, `_getKeyHash`).

### 3c. Sync algorithm (IMAP)

**Checkpoint state.** Each folder row has a `localStatus` JSON with `uidvalidity`, `uidnext`, `syncedMinUID`, `highestmodseq`, `lastShallow`, `lastDeep`, `bodiesPresent`/`bodiesWanted` and `busy` (`constants.h:36-53`). The UI reads the starred keys to show progress. **[V]**

**Initial sync is a resumable walk from newest to oldest.** **[V]** (`SyncWorker.cpp:567-605`)
1. Folders are processed in role order: inbox, sent, drafts, all, archive, trash, spam (`:429-434`).
2. On first sight of a folder, `syncedMinUID` is set to UIDNEXT. Each pass then fetches the next chunk below it: 750 UIDs on the first chunk, 1,024 after that. If the folder has fewer than 5,000 messages, it is fetched as one range.
3. Each chunk fetches **headers only**: ENVELOPE, internal date and flags, plus labels, thread ID and message ID on Gmail (`MailUtils.cpp:990-1004`).
4. Each chunk is committed, and `syncedMinUID` advances only as far as the fetch actually got. A truncated fetch records the lowest UID it reached (`:582-590`).
5. Progress therefore survives crashes and restarts. A first sync of a huge folder can take days without blocking anything. Every header in every folder eventually syncs down to UID 1.

**Bodies are a separate, lazy, bounded lane.** **[V]** (`SyncWorker.cpp:1512-1657`)
- Only messages from the **last 90 days** plus drafts are fetched (`maxAgeForBodySync`, still marked "TODO pref").
- **30 per pass**, newest first. Spam and Trash bodies are never cached.
- A placeholder row is inserted before each fetch so a message that always fails isn't retried forever, and so the two workers don't fetch the same body.
- New inbox mail gets its bodies fetched immediately (`:680-695`).
- The UI can ask for any body on demand with `need-bodies`, which is served by the foreground connection (`main.cpp:958-965`, `SyncWorker.cpp:119-160`).
- An hourly cleanup deletes bodies older than 90 days that were fetched more than 14 days ago. Attachments are **not** evicted, and there's an open TODO about it (`:1487-1508`). **[V]**

**Incremental sync.** **[V]**
- **CONDSTORE + QRESYNC:** `FETCH CHANGEDSINCE <modseq>` returns changes plus VANISHED. The set ends at UIDNEXT-1 to work around Cyrus. If the modseq jump is large (more than 4,000), the fetch is limited to the newest 12,000 UIDs and the modseq is not advanced. A **daily attributes-only "gap scan"** of the whole folder repairs messages that were never ingested (`:614-647`, `:1379-1468`).
- **Without QRESYNC:** new mail is found through UIDNEXT. A shallow scan of the top 400 UIDs runs every 2 min, and a deep flags-only scan of the whole range every 10 min. Deletions show up as UIDs that disappeared from a scanned range (`:648-715`, `:1349-1360`).
- **UIDVALIDITY change:** placements are reset to UID 0 silently, the folder is rebuilt, and messages are recognized again by their header-hash IDs (`:530-564`).

**Push.** **[V]** The foreground thread IDLEs on Inbox, or on All Mail for Gmail. After each IDLE it runs pending task remote phases, requested bodies and a CONDSTORE or shallow check of the inbox (`SyncWorker.cpp:119-330`). The background loop sleeps 120 s between passes, but can be woken: the client sends `wake-workers` on resume or when it comes back online (`main.cpp:291`, `:938-951`). There are no webhooks, no Gmail Pub/Sub and no JMAP.

**Rate limits, retries and backoff.** **[V]** This is coarse, and process-level.
- Retryable `SyncException`s (connection, parse and fetch errors, most curl errors) put the worker to sleep for 120 s.
- **Non-retryable exceptions call `abort()` and kill the whole process** (`main.cpp:199-293`).
- The client's `CrashTracker` relaunches the process. It gives up after 5 exits in 5 minutes, or 2 authentication failures in 30 minutes, and marks the account errored (`mailsync-bridge.ts:66-135`).
- A rejected login is retried after 30 s and then 120 s, with a fresh OAuth token. This covers Outlook.com's intermittent rejection of valid tokens (`main.cpp:146-197`).
- Gmail's own IMAP errors are classified ("bandwidth exceeded", "too many simultaneous connections", "IMAP not enabled"), but they are non-retryable, so they end up in the crash loop.
- Google API daily-quota errors suspend calendar sync for 4 h (`main.cpp:341-343`).
- The metadata stream backs off through a fixed table, 3 s up to 300 s.
- There is no token bucket. On IMAP Gmail doesn't charge per-request "quota units", so a bucket matters less there. **[I]**

**Conflict resolution.** **[V]** This is the most refined part (`Mailspring-Sync/CLAUDE.md`, "Message Identity and Placements").
- A message's ID is a **deterministic hash of its headers** (account, date, subject, sorted recipients, Message-ID), *not* of its folder (`MailUtils.cpp:648-700`). The same message therefore keeps its ID when it moves, and its plugin metadata (snooze, reminders, tracking) can follow it across devices.
- A `MessageFolder` "placement" row records each physical copy on the server. The message's `folders` snapshot and its unread/starred flags are derived from those rows, and a Python checker re-derives every layer after each test scenario (`test/harness/invariants.py`).
- While a task is in flight, a message-level `_sa` ("synced at") guard stops server scans from overwriting the optimistic local state for 24 h or until the task releases it. A move is recorded as a `pendingFolderId` on the placement.
- Messages with no copy left become "orphans". They are swept only after every folder that might hold the moved copy has been fully scanned, with a 24 h cap. That is how a move avoids looking like a delete followed by a create.

**Offline outbox.** **[V]**
- Tasks are persisted rows in a `Task` table with status `local`, `remote`, `complete` or `cancelled`.
- `performLocal` runs immediately on the stdin thread.
- `performRemote` runs in the foreground worker, which only reaches the task step after it has connected and logged in. Offline tasks therefore wait (`SyncWorker.cpp:198-226`).
- **A remote failure marks the task `complete` with an error. There is no retry or backoff per task** (`TaskProcessor.cpp:996-1022`). Only SQLite errors leave a task queued.
- Sending is guarded so it runs at most once (`_performRemoteRan`, `TaskProcessor.cpp:2430-2436`). Every retry is a new task the user triggers.
- After a 5xx or a dropped connection on a Graph send, the engine checks whether the draft was actually submitted before it reports failure (`Mailspring-Sync/CLAUDE.md`).
- At launch, tasks stuck in `local` are deleted because they probably crashed the engine (`TaskProcessor.cpp:726-736`).

### 3d. Local storage

**Engine.** One SQLite file, `edgehill.db` (the Nylas codename), in the config directory. WAL, `synchronous=NORMAL`, page size 4096, schema version in `PRAGMA user_version`, currently 13. A VACUUM runs every 30 days during `--mode migrate` (`MailStore.cpp:91-119, 212-295`). **[V]**

**Pattern: "fat rows".** Every model row has a `data` JSON column (the full object as the client sees it) plus a few indexed scalar columns for queries. This is the same idea as Aplos's `threads(data)` JSON rows, done at a finer grain. **[V]**

**Main tables** (`Mailspring-Sync/MailSync/constants.h`): **[V]**

| Table | Key columns besides `data` |
|---|---|
| `Thread` | id, accountId, version, gThrId, subject, snippet, unread, starred, first/last message timestamps (received, sent), inAllMail, isSearchIndexed, participants, hasAttachments. Partial indexes for unread and starred lists. |
| `ThreadCategory` | (thread id, folder/label id) plus denormalized inAllMail, unread and last received/sent timestamps. This join table makes "folder X sorted by date" an index scan (`ThreadListCategoryIndex`). |
| `ThreadCounts` | categoryId, unread, total (precomputed sidebar counts) |
| `ThreadReference` | (threadId, accountId, headerMessageId), used for References-based threading |
| `Message` | id, accountId, version, headerMessageId, gMsgId, gThrId, subject, date, draft, unread, starred, replyToHeaderMessageId, threadId |
| `MessageFolder` (V10) | accountId, messageId, folderId, remoteUID, unread, starred, draft, remoteXGMLabels, pendingFolderId. Unique on (account, folder, UID) when UID > 0. |
| `MessageOrphan` (V10) | messageId, accountId, since |
| `MessageBody` | id, value (HTML or text), fetchedAt. **Bodies are kept apart from message rows.** |
| `File` | Attachment metadata. The bytes live on disk under `files/<2>/<2>/<id>/<name>` (`MailUtils.cpp:447-460`). |
| `Folder`, `Label` | id, accountId, path, role, plus `localStatus` in `data` |
| `Contact`, `ContactBook`, `ContactGroup`, `ContactContactGroup`; `Calendar`; `Event` (etag, icsuid, recurrenceStart/End, recurrenceId) | |
| `Task` | id, accountId, status, data |
| `ModelPluginMetadata` (objectId, pluginId, value, **expiration**), `DetatchedPluginMetadata` | Plugin state and timers |
| FTS5: `ThreadSearch` (subject, to, from, categories, body), `ContactSearch`, `EventSearch` | Porter + unicode61 tokenizer |
| `_State` | Key/value: cursors, VACUUM time |

**What is stored.** Headers for every message in every synced folder; bodies for 90 days; attachments for any message whose body was fetched. The body fetch downloads the full RFC 822 message (`SyncWorker.cpp:1675`), and I found no size cap. **[V]** Search covers headers for everything and bodies only for messages that have been fetched. **[V]** There is **no encryption at rest**: no SQLCipher, and the `files/` directory is plaintext. **[V]**

**Migrations.** Additive `CREATE … IF NOT EXISTS` lists for each version, plus dedicated functions for heavy rebuilds (V10 rewrote `Message` and backfilled placements). The engine runs them in a separate `--mode migrate` process before sync starts. The client shows a "migrating" or "vacuuming" window by watching that process's stdout (`mailsync-process.ts:528-545`). Downgrading past V10 isn't supported. The documented fix is "Rebuild database", since the store is only an IMAP cache. **[V]**

### 3e. The API between UI and engine

**Transport.** Newline-delimited JSON over the child's stdin and stdout. stdin's buffer is raised to 1 MB because draft tasks can be large (`mailsync-process.ts:226-233`). **[V]**

**UI to engine** (`main.cpp:872-990`):
- `queue-task`: the full Task JSON, tagged with its class name.
- `cancel-task`
- `wake-workers`
- `need-bodies` with a list of IDs
- `sync-calendar`
- test-only crash commands

The first two lines on stdin are the account JSON (secrets included) and the identity JSON. **[V]**

**Engine to UI.** Every line is `{type: "persist"|"unpersist", modelClass, modelJSONs:[...]}`. **[V]**
- Saves within a transaction are buffered and released together on commit.
- Within a flush window, saves of the same object are **coalesced** by key-merge, so conditional fields like `body` or `rulesReady` aren't lost (`DeltaStream.cpp:70-97`).
- Flush delays depend on the source: 5 ms for changes caused by the UI's own tasks, 500 ms for sync (`main.cpp:876`, `SyncWorker.cpp:79`, `MailStore.cpp:97`).
- Pseudo-classes carry process state on the same channel: `ProcessState` (online or offline), `ProcessAccountSecretsUpdated` and `ProcessIdentityRefreshNeeded`.

**Realtime on the client.** `QuerySubscription` keeps the result set of a query and **patches it in memory** from each change record, using the model's own matchers (does this persisted thread still match `where unread=1`?). It falls back to re-running the query when it can't tell (`flux/models/query-subscription.ts:89-140`). Lists are windowed: `ObservableListDataSource` subscribes to a retained range so only visible rows are loaded (`flux/stores/observable-list-data-source.ts`). Pagination is plain SQL `LIMIT`/`OFFSET` over the indexed columns. **[V]**

**Weaknesses.** **[V]**
- Deltas carry **no sequence number, acknowledgement or replay**. The bridge says so outright: "the delta stream has no retry, so an abort would silently desync the UI" (`mailsync-bridge.ts:31-33`). Aplos's `{epoch, rev}` with gap detection is already stronger.
- The "API" only works because every reader shares the same file and the same model classes. A phone could not use it.

### 3f. Send, drafts, threading, labels, calendar, AI

- **Send** (`TaskProcessor.cpp:2425-2620`). The engine builds the MIME itself from the draft JSON and attachments on disk, then sends through SMTP or Graph. It can build a separate MIME per recipient, which is how Pro tracking pixels work. Afterwards it:
  - deletes the server draft copies,
  - polls Sent for the server's own copy (1-2 s backoffs, longer for servers known to file one; Exchange sometimes takes about 3 minutes),
  - or APPENDs its own copy and removes late duplicates later (`removeLateSentCopies`).
- **Drafts.** Drafts other clients put in the Drafts folder sync down. Mailspring's own drafts are **local only** (`TaskProcessor.cpp:923-924`). **[V]**
- **Threading.** Gmail uses X-GM-THRID. Everything else matches Message-ID and References against `ThreadReference`, looking at the first 50 references, never at subjects (`MailProcessor.cpp:158-205`). **[V]**
- **Labels and folders.** Separate `Folder` and `Label` models.
  - On Gmail only All Mail, Spam and Trash are synced as folders. Every other mailbox becomes a Label, read from X-GM-LABELS, and each message has exactly one placement (`SyncWorker.cpp:974-981`).
  - A thread's categories are stored in `ThreadCategory`.
  - Roles come from SPECIAL-USE flags, then from a multilingual table of folder names (`constants.h`, `COMMON_FOLDER_NAMES`). **[V]**
- **Calendar and contacts.** Covered in 3b. RSVP, COUNTER and recurring-exception handling are all active work.
- **AI.**
  - On-device only: Apple Foundation Models when the Mac has them, otherwise Qwen through node-llama-cpp in a utility process. Limits: 4 threads, 8K context, 200-600 output tokens, unloaded after 5 idle minutes. Results are cached per item and model.
  - It is used by "Views", for extract, summarize and generate.
  - External agents connect through the MCP server. It has an access level (read-only, read-write, or read-write-send), per-account and per-folder exclusions, and an audit log in memory (`mcp-server/lib/mcp-access-control.ts`, `app/src/services/mail-access/audit.ts`).
  - I found no cloud LLM in the core client. Views can be given a user's own API key for named hosts (`views/lib/credentials/credential-sheet.tsx`). **[V]**

## 4. Engineering quality

- **Tests: client.** 154 Jasmine spec files, run in CI under xvfb along with lint and typecheck (`.github/workflows/test.yaml`). 16 Playwright end-to-end specs, including visual snapshots (`playwright/tests`). These are **not** in CI. **[V]**
- **Tests: engine.** The standout is a black-box scenario harness (`Mailspring-Sync/test/README.md`):
  - It runs the real `mailsync` binary against a scriptable fake IMAP server with 14 **server "personalities"** (gmail, outlook, icloud, yahoo, proton-bridge, courier, hmailserver, …), each quirk citing a source. It also runs against real Dovecot and Cyrus in Docker.
  - 88 YAML scenarios declare the mailbox, server-side mutations and stdin tasks. Each asserts `db_matches_server`, counts, stability over N passes, and log lines that must *not* appear.
  - A conformance suite checks the fake against Dovecot.
  - An A/B tool compares recordings before and after a change.
  - **The engine's CI only builds**, runs `install-check`, verifies certificates and smoke-tests on Linux distros. The scenario suite isn't in any workflow (`.github/workflows/build.yml`). **[V]** C++ unit tests cover only vCard parsing. **[V]**
- **Code organization.** Clear naming conventions (`performLocalX`/`performRemoteX`). Comments cite the RFC, upstream issue or forum thread behind each provider quirk. Both CLAUDE.md files spell out invariants an agent must not break. Weaker spots:
  - `TaskProcessor.cpp` is 3,585 lines and `DAVWorker.cpp` 2,468.
  - The client still runs on Reflux, RxJS 4 (`rx-lite`), React 17, a forked Slate 0.45 and `@electron/remote` (`app/package.json`).
  - Five self-review files in `Mailspring-Sync/docs/CODE_REVIEW_*.md` list races and unbounded buffers. **[V]** I didn't check which are fixed.
- **Observability.** This is what Aplos most lacks today. **[V]**
  - A rotating log per account (`mailsync-<id>.log`, 5 MB × 3), with a thread name on every line.
  - A "verbose for 30 minutes" switch that logs all IMAP/SMTP traffic, then relaunches (`mailsync-bridge.ts:174-198`).
  - Fatal errors are sent to stderr. The client keeps only the last exception block (`lastLoggedException`).
  - Crashpad reports go to the Mailspring server (`error-logger.js:162`). Sentry is used for JS errors and grouped by the engine's error code (`mailsync-process.ts:357-368`).
  - Errors are classified as `isUserError` and `isNetworkError` so expected failures don't flood error tracking.
  - An `--mode test` run checks credentials during onboarding and returns the log it collected.

## 5. UI notes

- **Framework.** React 17 inside an Atom-style Electron shell: "sheets", a `ComponentRegistry` with named roles (`Composer:ActionButton`, `ThreadListIcon`), `InjectedComponent` slots and `ExtensionRegistry` hooks for the composer and message view. Every feature is an internal package declaring `windowTypes` (`PLUGIN_SYSTEM_ARCHITECTURE.md`). There is no third-party component library. A home-grown `mailspring-component-kit` and LESS themes (7 bundled) take its place, and RTL comes from running every stylesheet through `rtlcss`. **[V]**
- **Email rendering.** Sanitized with DOMPurify (`app/src/services/sanitize-transformer.ts`). The result is written with `document.write` into an iframe with `sandbox="allow-forms allow-same-origin"`. Scripts can't run inside it, but the parent can reach in. That parent window has `nodeIntegration: true` (`message-list/lib/email-frame.tsx:82-150, 237`). The window's meta CSP limits `script-src` to `'self'`. **[V]** Aplos should not copy this. Its planned opaque-origin `srcdoc` iframe is stronger.
- **Motion.** CSS transitions plus `react-transition-group`. The common values are 120-200 ms with `ease` or `ease-out`, a few 125-150 ms ease-in/ease-out pairs, and occasional `cubic-bezier(0.65,0.05,0.36,1)`, `(0.4,0,1,1)` and an overshoot of `(0.34,1.45,0.64,1)` (grep of `static/style` and `internal_packages/*/styles`). **[V]** Nothing worth borrowing.
- **Keyboard model.** Mousetrap with command IDs (`core:snooze-item: z`, `core:show-keybindings: ?`) arranged in three layers: base, then a template (Gmail, Outlook, Apple Mail, Inbox), then package keymaps. A template replaces the base bindings of each command it defines, and a spec fails if a template silently drops one. Unmodified shortcuts are suppressed in text inputs, while modifier shortcuts still work. Users can rebind in Preferences, and an empty list unbinds a command (`app/src/keymap-manager.ts`, `app/keymaps/`). **[V]** The "template replaces per command" rule plus a spec for dropped keystrokes is worth borrowing for Aplos's keyboard-first story.

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **Headers-first, resumable, newest-first initial sync with a checkpoint per folder.** This answers Aplos's Gmail 403 problem directly.
   - Mailspring commits each header chunk and advances a lowest-synced cursor only as far as it actually got. A failure costs one chunk, never the whole window.
   - The Gmail REST equivalent is `threads.list`/`messages.list` pages with `format=metadata` plus a `fields` mask, each page committed together with its `pageToken` and the lowest date reached.
   - Bodies move to their own lane: recent inbox first, a bounded number per pass, plus an immediate fetch when the user opens a message.
2. **Lazy bodies kept apart from metadata, with an age window and an eviction pass.** Use a `bodies(id, value, fetchedAt)` table and keep only metadata in thread/message rows. Fetch on open, fill in the last N days in the background, skip Spam and Trash, and evict old bodies after a grace period. Unlike Mailspring, evict attachments too. This also lifts Aplos's memory ceiling.
3. **Single writer, push-only change stream, queries served page by page.** UI windows never hold the mailbox. They subscribe to queries over a window of rows, and change records patch those results using the same predicate the query used. Keep Aplos's `{epoch, rev}` gap detection, which Mailspring lacks.
4. **Denormalized list-index table** (Mailspring's `ThreadCategory`): one row per (thread, mailbox) with sort date and unread state, so "Inbox, newest first, page 3" is an index scan. Add precomputed counts too (`ThreadCounts`).
5. **Stable IDs from a header hash**, independent of the provider's message ID. Aplos's cross-device workflow sync (the hidden Gmail label) and its Done/Later state should be keyed on something that survives moves, re-syncs and provider changes.
6. **Placements for IMAP/JMAP adapters.** Treat "message" and "copy in a folder" as separate things, keep a guard window while an optimistic task is in flight, and sweep deletions only after full coverage. The single-placement-per-message rule for Gmail is the bridge between the label and folder models. This is the clearest correctness model I've seen for multi-folder IMAP.
7. **One "new message is ready" hook that fires exactly once per message.** Mailspring sets `rulesReady` on the first save where the body is stored and a copy exists outside Sent, Drafts, Spam or Trash. Rules key off it, and Aplos's AI enrichment queue should too. That moves summaries out of the sync path without losing exactly-once behavior.
8. **A generic "metadata with expiration" primitive plus one timer that sleeps until the next deadline.** That one mechanism covers snooze, send-later, follow-up reminders and Later.
9. **IMAP IDLE in its own connection,** paired with a background pass that can be woken. The client sends `wake-workers` on resume or when the network comes back. That's push for iCloud, Fastmail and generic IMAP without any server. Consider **Gmail over IMAP** too: IDLE gives push without Pub/Sub, and there are no per-request quota units. The scope is restricted either way. Aplos could keep REST just for filters and settings. **[I]** Measure before switching.
10. **Observability from day one:** a rotating log per account with thread or lane names; a time-boxed verbose protocol log; redaction by both key and value; errors classified as user, network or bug; crash reports grouped by error code; and a credential test mode that returns the log it collected.
11. **A scenario test harness** with a fake IMAP server that has provider "personalities", mailbox fixtures in YAML, and a `db_matches_server` plus invariants check after each scenario. Put it in CI, which Mailspring doesn't.
12. **Hardening a local MCP or API server:** bind to 127.0.0.1 only, require a bearer token compared in constant time, allowlist the Host header against DNS rebinding, offer read-only, read-write and send levels, support per-folder exclusions, and keep an audit log the user can read (`mcp-server/lib/mcp-http-server.ts`, `mcp-access-control.ts`).
13. **Local AI result cache** keyed by (message ID, prompt key, model), held in its own SQLite file, with one-at-a-time execution and an idle unload.
14. **Correctness at send time:** a guard so a send runs at most once, a check of "was it actually submitted?" after an ambiguous failure, and the provider's own Sent copy reconciled against yours.

### Avoid

1. **One OS process per account with `abort()` as the error channel** and a crash counter as the policy. It turns quota and policy errors into restart loops, hides state, and costs a process per account.
2. **Many writer connections on one SQLite file.** Busy timeouts, random start delays and sleeps inside bulk inserts are symptoms of that design. Aplos's single-writer engine is the better base.
3. **A change stream with no sequence numbers or replay**, and an "API" that only works because both sides share the same file and model classes.
4. **Privileged renderers** (`nodeIntegration`, `contextIsolation: false`, `@electron/remote`), spawning children from the renderer, and email iframes with `allow-same-origin`.
5. **Passing secrets as plaintext JSON on stdin and echoing rotated tokens on stdout.** Have the daemon read the Keychain itself.
6. **Marking an op complete on its first remote failure.** Keep Aplos's per-account held queue with backoff.
7. **Leaving drafts local-only, and leaving remote search as a TODO.** Both are gaps Aplos should close.
8. **An unbounded attachment cache**, and plaintext caches with no option to encrypt at rest.

## 7. "Local server" translation

**What Mailspring proves.** A local sync daemon that owns storage and streams changes to the UI works well at scale on desktops. Mailspring has run this way for about 8 years. Its weak points are all at the boundary: stdio transport, no replay, credentials passed in, a writer per account, and a read path that depends on the file. A "local server" for Aplos is mostly a matter of fixing those points.

**Proposed mapping.**

| Mailspring piece | Aplos local daemon equivalent |
|---|---|
| `mailsync` per account | **One `aplosd` process** for all accounts, as a macOS LaunchAgent, or the existing Electron `utilityProcess` at first. It holds per-account sync lanes (metadata, bodies, push, ops) inside one process. |
| stdin `queue-task` | `POST /v1/ops` with typed, persisted ops (the current `ops` table), an idempotency key, and a response that includes the local-phase result and the new `rev` |
| stdin `need-bodies` | `GET /v1/messages/{id}/body`, which fetches on demand when missing (with a 202 plus a later change event, or by holding the request open) |
| stdin `wake-workers` | `POST /v1/sync/wake`, called by Electron on resume or `online`, and by the phone on foreground |
| Direct SQLite reads + `QuerySubscription` | `GET /v1/threads?mailbox=&after=<date,id>&limit=` (keyset paging, which `ThreadPage.next` already does) and `GET /v1/threads/{id}` |
| stdout deltas | `GET /v1/changes?since=<epoch:rev>` (JMAP-style catch-up) plus a WebSocket or SSE stream of `{epoch, rev, put[], remove[]}`. This needs a **changelog table** (rev → object type and ID) with retention. If the epoch has changed or `since` is older than the retained window, the server answers "resync", like JMAP's `cannotCalculateChanges`. |
| `ProcessState` pseudo-deltas | `GET /v1/status` plus `status` events on the stream (per-account connection, last error, progress, quota pauses) |
| MCP server in the renderer | The MCP server becomes **another client of the same API**, with the same scoped grants and audit log |
| Mailspring cloud metadata stream | Keep the provider as the only "server": the hidden-label workflow sync and provider-side filters. A relay comes later and carries only ciphertext. |

**Shape.** Use JMAP's *state* semantics without the full JMAP method grammar. A small typed REST plus change-stream API is enough for one owner. Define it once (a zod or TypeBox schema) and generate the Electron preload, the HTTP handlers and a future Swift or Kotlin client from it. That also removes the method allowlist currently copied in three places. **[I]**

**Transport and auth.**
- Electron: use a Unix domain socket in the app's container, or 127.0.0.1 with a random bearer token the daemon writes to a 0600 file or the Keychain. Copy the MCP hardening from §6 (Host allowlist, constant-time compare, no CORS wildcard).
- Phone, same network: don't open a LAN port. **[I]** Use pairing by QR code (exchange a device key) plus TLS with a pinned certificate. Better still, use a relay such as Tailscale, or one that only forwards end-to-end-encrypted frames, so the daemon never listens beyond loopback.
- The phone needs the same paged queries and the changes cursor. A body cache for offline phone reads is optional.

**Pros.**
- One writer and one mail cache shared by every window, the phone and agents. Today's in-memory mailbox copy disappears from main and from each window.
- Sync, IDLE, send-later and snooze timers keep running when no window is open (while the Mac is awake).
- The browser-preview server (`apps/desktop/src/main/server.ts`) becomes the production path instead of a dev-only fork, so there is one code path to test.
- The UI and backend workstreams can meet at one versioned contract.

**Cons.**
- Lifecycle complexity: launchd install and uninstall, keeping daemon and UI versions in step across auto-updates, single-instance locking, migrations run by the daemon.
- A larger attack surface: any local process can try the port. Phone access adds pairing and revocation.
- macOS sleep still caps "always on". Provider-side filters remain the only 24/7 automation.
- More moving parts to debug. Mailspring's experience is that the boundary is where silent desyncs happen.

**Effort (Aplos-specific, rough).** **[I]**
1. **About 1 week.** Typed contract. Ship `server.ts` behind token auth for the existing engine. Add `/changes?since` backed by a changelog table. Electron keeps IPC for now.
2. **1-2 weeks.** Split body storage, keyset-paged queries, body-on-demand, and remove whole-state cloning and `latestState` from main. This is the same work as Mailspring lessons 2-4.
3. **1-2 weeks.** Run the engine as a LaunchAgent outside Electron (a Node SEA or a bundled Node binary), with Keychain access inside the daemon and a version-handshake endpoint.
4. **2-4+ weeks.** Phone pairing, relay and an iOS client. Not on the 30-day plan.

Steps 1-2 pay off even if the phone never ships. Step 3 is only worth doing once the daily-driver and first-sync problems are fixed.
