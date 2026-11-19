# Tuta (Tutanota) desktop client: offline storage, encryption at rest, and search

**Scope.** I did a read-only review of `tutao/tutanota`, shallow-cloned to `/Users/knewton/.t3/aplos-research/src/tutanota` at HEAD `afba914` (2026-10-21, "do not load plugins for external users"). Nothing was installed, built or run. Paths below are relative to the repo root. Tuta's server is proprietary, so everything about the server comes from how the client uses it. Inferences are marked **(inference)**. Everything else is backed by a file path.

**License.** GPL-3.0 (`LICENSE.txt`, `package.json`). Two of the key dependencies are **AGPL-3.0**: the SQLCipher Node binding (`@signalapp/sqlcipher`, used through Tuta's fork `tutao/node-sqlcipher`) and Signal's FTS5 tokenizer extension. I checked both with `gh api`. This report describes ideas only. No Tuta code is reproduced.

---

## 1. Overview

**Purpose.** Tuta Mail is a hosted, end-to-end encrypted mail and calendar service. This repo holds every client (web, Electron desktop, Android, iOS, plus the Calendar and Drive apps), but not the server. The desktop app is the web app running inside Electron, plus native "facades" in the Electron main process. It only talks to Tuta's own server. Other providers' mail can come in only through a desktop-only **IMAP import/sync** feature that copies it *into* a Tuta mailbox.

**Maturity and activity** (GitHub API, 2026-10-25):

| Metric | Value |
|---|---|
| Created | 2014-07-28 |
| Stars / forks | 8,044 / 650 |
| Open issues | 959 |
| Commits on default branch | ~14,400 |
| Commits in the last 52 weeks | 2,309 |
| Contributors | ≥100 (API page cap). Top: charlag 3,082, ganthern 1,577, armhub 1,057, johnbotris 650, mpfau 591 |
| Latest release | `tutanota-desktop-release-362.261023.2` (2026-10-23); several releases a week |
| Electron | 44.9.3 (`package.json`) |
| Size | 1,591 TS files / ~361k lines in `src`; desktop main-process code ~14k lines (`src/applications/common/desktop`); ~100k lines of tests |

This is a mature product with a paid team. The README forbids LLM-assisted contributions, so nobody on the Aplos side should file issues or PRs there.

**Target user.** Privacy-focused consumers and businesses on Tuta's own encrypted service. The desktop app adds offline access, OS notifications, a tray mode, mailto handling, export, and IMAP import.

---

## 2. Feature inventory (desktop-relevant)

| Feature | Evidence | Maturity |
|---|---|---|
| Offline mode: login from cache, read mail offline | `platform-kit/base/facades/LoginFacade.ts:544-582` (comments describe "async login" from cache with later retry; offline login since 3.96.4) | Mature |
| Encrypted local DB (SQLCipher, one per user) | `src/applications/common/desktop/db/DesktopSqlCipher.ts` | Mature |
| Offline full-text search on SQLite FTS5 | `src/applications/mail-app/workerUtils/index/OfflineStoragePersistence.ts`, `OfflineStorageSearchFacade.ts` | New (2025-26). It replaced an encrypted IndexedDB index, which the web app still uses (`IndexedDbIndexer.ts`, `doc/search.md`) |
| Full-archive mail download for indexing | `OfflineMailIndexer.ts` | New. The user-set "offline range" was removed in June 2026 (commits `7a99586a32`, `0bace9d19c`) |
| In-worker fast cache in front of the DB | `src/app-kit/local-store/CachingOfflineStorage.ts`, commit `078c40cc4c` (2026-07-15) | Very new |
| Real-time sync: WebSocket event bus with replay of missed events | `src/app-kit/local-store/event/EventBusClient.ts`, `doc/events.md` | Mature |
| Notifications while no window is open (SSE in the main process) | `desktop/sse/SseClient.ts`, `TutaSseFacade.ts`, `doc/notifications.md` | Mature |
| Calendar alarms scheduled in the main process | `desktop/sse/DesktopAlarmScheduler.ts`, `DesktopAlarmStorage.ts` | Mature |
| Inbox rules and spam filtering **on the client**, with server-elected "leader" client | `mail/model/ProcessInboxHandler.ts`, `EventBusClient.ts` (LeaderStatus message) | Mature (rules); new (ML spam) |
| Local ML spam classifier (TensorFlow.js) | `workerUtils/spamClassification/SpamClassifier.ts` (incremental retrain every 10 min, full retrain weekly) | New |
| IMAP import/sync into Tuta (Gmail and Outlook via OAuth, others via password) | `desktop/imapimport/**`, `workerUtils/imapimport/ImapImporter.ts`, `ImapKnownConfigs.ts` | Beta. The Outlook config says "still under test" and Yahoo is disabled |
| Local draft autosave (a single "current" draft) | `api/worker/facades/lazy/OfflineStorageAutosaveFacade.ts` | Mature, minimal |
| Send later (server-side scheduled folder), undo send | `mail/editor/MailEditor.ts:852-907,1323`, `MailSetKind.SCHEDULED` | Mature |
| Mailbox export | `desktop/export/*` | Mature |
| App-password protection of local credentials (Argon2id) | `desktop/credentials/AppPassHandler.ts` | Mature |
| Signed auto-update (own key plus OS signature) | `desktop/ElectronUpdater.ts:100-193`, `buildSrc/electron-package-json-template.js` | Mature |
| LLM / AI features | none found (`rg` for openai/anthropic/llm/ollama) | n/a |
| Offline outbox (queued sends) | none found. `SendMailModel.ts` has no offline path, and writes always go to the server (`DefaultEntityRestCache.ts` class doc) | Absent |

---

## 3. Architecture deep dive

### 3a. Process and deployment topology

**What runs where (verified):**

1. **Server (proprietary).** It is the single source of truth. It keeps a per-group **entity event log** of batches that expire after about 45 days (`EventBusClient.ts`, `ENTITY_EVENT_BATCH_EXPIRE_MS` = 44 days). It also runs a WebSocket endpoint `/event`, an SSE endpoint `/sse` for push, REST, and blob archives.
2. **Renderer main thread.** The Mithril UI and view models (`MailListModel`, `MailViewerViewModel`).
3. **Web Worker inside the renderer.** This is the real "engine": crypto, the REST client, the entity cache (`DefaultEntityRestCache`), the WebSocket event bus, the indexer, and the spam classifier. It is wired up in `src/applications/mail-app/workerUtils/worker/WorkerLocator.ts`, and `WorkerClient.ts:45` creates one worker per window.
4. **Electron main process.** "Native facades", dispatched by a code-generated `DesktopGlobalDispatcher` (`DesktopMain.ts:380-420`). They cover:
   - the SQLCipher DB host
   - the credentials DB and keychain
   - the SSE push client
   - the alarm scheduler, tray, updater and notifications
   - IMAP sync (imapflow)
   - the OAuth window, file IO and export
5. **One Node `worker_thread` per open user DB** (`desktop/sqlworker.ts`, `desktop/db/WorkerSqlCipher.ts`). It holds the SQLCipher connection, so blocking SQLite calls stay off the main process's event loop. `OfflineDbRefCounter.ts` ensures each DB file has exactly one connection, even when several windows share it.

**An SQL query takes four hops each way.** The path is:

```
web worker → renderer main thread (execNative)
  → Electron IPC ("to-main", preload.js)
  → main (RemoteBridge → PerWindowSqlCipherFacade)
  → node worker_thread (DesktopSqlCipher)
```

Sources: `WorkerClient.ts:80`, `desktop/preload.js`, `desktop/ipc/RemoteBridge.ts`.

Tuta's own commit `078c40cc4c` says this IPC is "very expensive" and "massively degrading the performance". Their fix was an in-memory `EphemeralCacheStorage` "fast cache" inside the worker, coordinated by `CachingOfflineStorage`. During online catch-up, reads hit the fast cache and then the server. After sync is done, they hit the fast cache, then SQLite, then the server.

**Background presence.** `runAsTrayApp` is on by default (`electron-package-json-template.js`, `defaultDesktopConfig`). When every window is closed, the main process keeps running for the SSE notification stream and calendar alarms, but the web worker (the sync engine) is gone. So **mail sync stops when no window is open; only notifications and alarms continue**. This is an inference from the topology: the worker lives in a window.

**Multi-window.** Each window runs its own web app, its own worker and its own WebSocket. They share one DB connection through the ref-counter, and invalidations are broadcast to other windows (`ipc/DesktopInterWindowEventFacade.ts`).

**Admin socket.** The `-s` flag opens a Unix socket at `/tmp/tutadb.sock` for an internal admin tool (`Socketeer.ts`). It isn't user-facing, but it is the only "local server" in the app.

### 3b. Connectivity per provider, auth and token storage

**Tuta service.**
- Auth uses a session `accessToken`. Persistent sessions get a random access key (`LoginFacade.ts:300-312`).
- The WebSocket authenticates with the access token in the query string, along with model versions and `groupsToLastEventBatchIds` (`EventBusClient.ts:connect`).
- Mail metadata for SSE notifications is fetched from the main process using decrypted stored credentials (`TutaNotificationHandler.ts:downloadMailMetadata`).

**IMAP import (desktop only).** It uses imapflow in the main process (`ImapSyncSession.ts`).
- **Gmail and Outlook use OAuth2 / XOAUTH2.** imapflow is given `accessToken`, which it prefers over the password.
- The OAuth client uses `openid-client` with PKCE and `state` (`settings/imapimport/oauth/OAuthHandler.ts:31-81`).
- The **Google client secret is never bundled**. It's fetched at runtime from a Tuta server service (`ImapOauthConfigService`, `OAuthHandler.ts:34-41`).
- Scopes: Gmail requests full `https://mail.google.com/`; Outlook requests `IMAP.AccessAsUser.All` (`ImapKnownConfigs.ts`).
- The consent page opens in a sandboxed Electron `BrowserWindow` with its own partition. The redirect is caught with `webRequest.onBeforeRequest` (`DesktopOauthWindowFacade.ts`), so no loopback server is used. **(Inference)** Google's policy forbids OAuth in embedded user agents, so this is fragile. Aplos's system-browser loopback flow is the policy-compliant choice.
- Token refresh **keeps the old refresh token when the refresh response omits one** (`ImapErrorHandler.ts:145-160`). Inbox Zero gets this wrong.
- IMAP credentials and token responses are stored as Tuta entities (`ImapAccount.oAuthTokenEndpointResponse`), so they are E2E-encrypted on Tuta's server, not on the device.
- Gmail sync uses only the `\All` mailbox (`ImapSyncSession.ts:runSyncSession`).

**Local key hierarchy (desktop).**
1. **OS secret store → two AES-256 keys.** Electron `safeStorage` (Keychain on macOS) encrypts two random keys, stored as files under `userData/safe_storage/`:
   - the **device key**, for config, alarms and push session keys
   - the **credentials key**

   Sources: `DesktopKeyStoreFacade.ts`, `sse/SecretStorage.ts`. On Linux, `basic_text` is detected and a warning tells the user to set an app password.
2. **`credentials.sqlite`.** It holds:
   - a single-row `credentialEncryptionKey`, wrapped by the credentials key and, in APP_PASSWORD mode, further wrapped by an Argon2id-derived key (`KeychainEncryption.ts`, `AppPassHandler.ts`)
   - `credentials` rows (`login, userId, type, accessToken, databaseKey, encryptedPassword, …`), with `accessToken` and `databaseKey` AES-encrypted under that key (`db/DesktopCredentialsStorage.ts`, `DesktopNativeCredentialsFacade.ts`)
3. **Offline DB key.** `databaseKey` is a random key generated in the worker at persistent login (`LoginFacade.ts:309-312`, `DatabaseKeyFactory.ts`). It is passed over IPC to open `offline_<userId>.sqlite`.

The background notification handler degrades by mode. In APP_PASSWORD mode, the main process can't decrypt credentials without a prompt, so it shows "new mail" without sender or subject (`TutaNotificationHandler.ts:onMailNotification`).

### 3c. Sync algorithm

**Event-log replication (Tuta service).**
- **Checkpoint.** `lastUpdateBatchIdPerGroupId(groupId, batchId)`, stored in the offline DB. A group with no checkpoint starts at "now minus 5 s" (`EventBusClient.ts:updateLastEntityEventIds`).
- **Reconnect.** The client sends its checkpoints. The server replays missed batches over the same socket, plus `initialSyncWorkEstimate` (drives a progress bar; fewer than 100 counts as "few updates") and `initialSyncDone`.
- **Backlog vs live.** Missed batches are bulk-applied with `putMultiple`/`deleteMultiple` every 500 queued batches (`MAX_EVENT_QUEUE_LENGTH_BEFORE_FLUSHING`). Live batches go through a per-event path (`DefaultEntityRestCache.onEntityUpdatesReceived`).
- **Commit ordering.** A batch's ID is written **only after every update in the batch, and the custom handlers such as indexing, have run** (`DefaultEntityRestCache.ts:690-692`). Writes are idempotent `INSERT OR REPLACE`, so a crash means re-delivery.
- **Ordering.** A strict FIFO `EventQueue` plus a serial promise chain for socket messages (`EventQueue.ts`, `EventBusClient.onMessage`).
- **Patches.** Updates carry patches (`PatchMerger`). If a patch fails, the client re-downloads the entity.
- **Out-of-sync.** If the last sync is older than 44 days, the client throws `OutOfSyncError`, **purges the cache and makes the user log in again** (`EventBusClient.initEntityEvents`, `DefaultEntityRestCache.isOutOfSync`). If the DB schema is newer than the client, or the metadata is inconsistent, the DB file is deleted and rebuilt (`OfflineStorageMigrator.ts`, `OfflineStorage.recreateDbFile`).
- **Retries.**
  - `ServiceUnavailableError` (503) retries the same batch after 30 s.
  - WebSocket reconnects use jittered tiers: 5-10 s, then 20-40 s, then 60-120 s. A 429 or a normal server shutdown jumps straight to the largest tier.
  - A sleep detector forces a reconnect after the machine wakes.
- **Rate limiting is global.** `SuspensionHandler` (`platform-kit/rest-client/SuspensionHandler.ts`, `RestClient.ts:65-147`): any 429 or 503 carrying `Retry-After`/`Suspension-Time` suspends **all** REST requests. They queue up and are replayed one after another when the suspension ends.

**Partial replica with "ranges".** `DefaultEntityRestCache` is a read-through cache (its class doc is the best summary).
- Every list, such as a folder's entries, has **one contiguous cached range** (`ranges(type, listId, lower, upper)`).
- Reads inside the range are served locally. Reads that extend past the edge fetch only the missing part, in chunks of at least 40.
- A **create** event is stored only if its ID falls inside a cached range.
- An **update** is applied only if the item is cached.
- A **delete** is always applied.

This is how Tuta keeps a partial copy correct without reconciling the whole mailbox.

**Bulk first sync, for search only.**
- Message lists load lazily as the UI pages through them.
- Separately, `OfflineMailIndexer` **waits for `OnlineSyncDone`** (`MailIndexerPostLoginAction.ts`). It then downloads whole encrypted "MailDetails" blob **archives** in bulk and parks them in a temporary encrypted table.
- It walks every mail bag newest-first in chunks of 1,000, decrypting 10 at a time (concurrency 10), and writes FTS rows.
- After each chunk it checkpoints `lastIndexedEntityListId/ElementId` per mailbox. Progress is reported, and the job is abortable through an `AbortController` and resumes from the checkpoint (`OfflineMailIndexer.ts:indexMailbox/indexMailbag`).
- Downloaded archives are recorded so a re-index doesn't fetch them again.

**IMAP sync algorithm (import).**
- One mailbox at a time. Order is by fewest failures, then importance (`ImapSyncSession.startNextMailboxSync`).
- Each mailbox is opened read-only. A UID diff is computed by fetching UIDs in sequence batches of 2,500. Messages are fetched with full source in batches of 125, with UID sets compressed to at most 25 ranges per FETCH (`DifferentialUidLoader.ts`).
- QRESYNC is supported but **off by default** (`ImapSync.ts`). Without it, deletes are detected by set difference.
- An interrupted mailbox resumes from `lastFetchedMailSeq`.
- After two failures on every mailbox, or a `NO [LIMIT]` response, the whole session is postponed for **25 hours**. Other errors use a shorter postponement.
- There's no IDLE: the import is batch, not live.

**Conflict resolution.** The server is authoritative. Client writes go straight to the server, and local state changes only when the resulting event arrives. There are no optimistic local mutations in the cache layer. **No offline write queue was found.** The only offline write is the single autosaved draft.

### 3d. Local storage

**Engine.** SQLCipher, via `@signalapp/sqlcipher` (AGPL) from Tuta's fork. Settings (`DesktopSqlCipher.ts:initSqlcipher`):
- a raw 256-bit key in hex, not a passphrase, so no KDF runs
- `cipher_memory_security = ON`
- `cipher_integrity_check` (per-page HMAC-SHA512) on every open
- `auto_vacuum = incremental`, with `incremental_vacuum` run on close
- Signal's `signal_tokenizer`, registered after keying

**No WAL pragma and no explicit transactions** were found in `local-store`, `desktop/db` or the indexer, so each statement autocommits. They lean on 1,000-row multi-value INSERTs (`OfflineStorage.putMultiple`) and on idempotent replay.

**Main tables** (`app-kit/local-store/OfflineStorage.ts`, `TableDefinitions`):

| Table | Columns | Notes |
|---|---|---|
| `list_entities` | `type, listId, elementId, ownerGroup, entity BLOB` | PK `(type, listId, elementId)`. Mails, folder entries, contacts and so on |
| `element_entities` | `type, elementId, ownerGroup, entity BLOB` | Singletons such as user and mailbox |
| `blob_element_entities` | `type, listId, elementId, ownerGroup, entity BLOB` | **Mail bodies** (MailDetailsBlob) |
| `ranges` | `type, listId, lower, upper` | One contiguous cached range per list |
| `lastUpdateBatchIdPerGroupId` | `groupId, batchId` | Sync checkpoints |
| `metadata` | `key, value BLOB` | CBOR. `lastUpdateTime`, `offline-version`, spam-training timestamps |

Every entity is stored as **CBOR of the decrypted, parsed instance**, with dates as CBOR tag 100. This is a generic document store keyed by type and ID, not normalized columns. Tables are flagged `purgedWithCache`: derived tables are dropped on out-of-sync, while user-owned tables survive.

**Search and other tables** (`OfflineStoragePersistence.ts:SearchTableDefinitions` and friends):
- **`mail_index`**: FTS5 over subject, to, cc, bcc, sender, body and attachment names. It's **contentless** (`content=''`), uses `contentless_delete=1`, and **shares its `rowid` with the `list_entities` row**. The text is HTML converted to plain text (`htmlToText`).
- `content_mail_index(receivedDate, sets)`: unindexed filter columns joined on rowid.
- `contact_index`: a normal FTS5 table, so results can be sorted by name.
- `search_group_data`: per-mailbox index checkpoint.
- `search_metadata`.
- `encrypted_mail_details_blobs` / `cached_mail_details_archives`: a temporary staging area for archives.
- `import_mail_queue`.
- `autosave_drafts`: not purged with the cache.
- `spam_classification_model(ownerGroup, model BLOB)`.
- An identity-key trust table.

**Query shape** (`OfflineStorageSearchFacade.searchMails`):
- MATCH on the FTS table, joined by rowid to the entity and content tables.
- Folder filtering uses `instr(sets, folderId)`.
- Results are filtered by date range and sorted by received date, newest first.
- All matching IDs are fetched up front and paged in memory. Query tokens are split by the same tokenizer (`tokenize()`), which handles CJK, and get prefix `*` unless quoted.

**Bodies and attachments.** **Full bodies are stored**, now for the entire archive, because the offline-range setting was removed in favour of full-archive indexing. **Attachment bytes are not in the DB.** They download on demand into an app temp directory, still encrypted, and are cleared on quit (`files/DesktopFileFacade.ts:78-104`, `TempFs`, `DesktopMain.ts` `will-quit`).

**Eviction.** None remains for mail. `updateRangeForList` is no longer called anywhere (verified with `rg`). **(Inference)** Disk use now grows with the whole mailbox.

**Migrations.** Numbered files `migrations/offline-vN.ts` (currently v17). Several just drop or reset derived tables or ranges, for example v12 and v16. Column adds are written to be re-runnable (v14). A DB with a newer schema than the client is deleted and rebuilt.

### 3e. The UI ↔ engine API

- **UI ↔ worker.** Typed facades over `postMessage`, proxied with `exposeRemote`/`exposeLocal` (`api/common/WorkerProxy.ts`).
- **Pagination.** ID cursors: load a range from a start ID with a count and direction (`EntityClient.loadRange`). Folder entries use custom IDs that embed `receivedDate >> 10` plus the mail ID (`platform-kit/meta/EntityUtils.ts:constructMailSetEntryId`), so ID order *is* date order and range scans give date-sorted pages.
- **Realtime.** The worker forwards filtered entity-update batches to the main thread's `EventController`. Listeners run in priority order, and the `UserController` always runs first (`api/main/EventController.ts`). View models patch themselves from these events. When the connection comes back, five main view models force a reload (commit `078c40cc4c`).
- **Worker/main ↔ Electron.** JSON5 schemas in `ipc-schema/` are compiled by Tuta's own `licc` tool (`buildSrc/licc/`) into TypeScript, Kotlin and Swift interfaces with send and receive dispatchers. The same contract therefore drives desktop, Android and iOS.
- **Raw SQL over IPC.** `SqlCipherFacade` accepts **raw SQL strings plus tagged params** (`ipc-schema/facades/SqlCipherFacade.json`). The renderer side can run any query against the user's DB.

### 3f. Send, drafts, threading, folders, calendar, contacts, AI

- **Send and drafts.** Drafts are server entities. Locally, only one "current" draft is autosaved for crash recovery (`AutosaveFacade.ts`, `LOCAL_DRAFT_KEY`). Sending is a server call with no offline queue. Send-later uses the server-side `SCHEDULED` folder.
- **Threading.** Server-maintained conversation entries with `messageId` links (`SendMailModel.ts:527`).
- **Folders and labels.**
  - A single "MailSet" model with kinds: custom, inbox, sent, trash, archive, spam, draft, all, label, imported, scheduled (`entities/tutanota/Utils.ts:MailSetKind`).
  - Each set owns an entry list sorted by date-prefixed ID, and a mail records the sets it belongs to.
  - Labels and folders are the same mechanism, which suits Gmail-style labels.
- **Calendar.** Server events. External ICS URLs are fetched from the main process (`ipc/DesktopExternalCalendarFacade.ts`). Alarms are encrypted with the device key and scheduled in the main process. A 30-day missed-notification TTL forces all alarms to be rescheduled.
- **Contacts.** Server entities with a local FTS index.
- **Rules, spam and "AI".**
  - E2E encryption means the server can't read mail, so **inbox rules and spam prediction run on a client**.
  - The server elects one connected client as **leader** (`LeaderStatus` on the WebSocket), and only the leader calls `ProcessInboxService`. Other clients still filter their view (`ProcessInboxHandler.ts`, `MailSetListModel.applyInboxRulesAndSpamPrediction`).
  - The spam model is a small TF.js dense network over hashed features, trained per mailbox on the client and stored in the offline DB.
  - There are no LLM features.

---

## 4. Engineering quality

**Tests and CI.**
- **Tests.** 323 `*Test.ts` files, 40 of them under `test/tests/desktop`. They use Tuta's own `@tutao/otest` runner and testdouble. Coverage includes `OfflineStorageTest`, `OfflineStorageMigratorTest`, `CachingOfflineStorageTest`, `EventBusClientTest`, `OfflineMailIndexerTest`, `SseClientTest`, `TutaSseFacadeTest`, `OAuthHandlerTest` and the IMAP facade.
- **GitHub Actions** (`.github/workflows/test.yml`):
  - Prettier and ESLint (`npm run check`)
  - a FIXME ban
  - Node and browser test runs
  - Kotlin, Swift and Rust test workflows
- **Jenkins** (`ci/*.Jenkinsfile`) builds, signs and publishes.

**Supply chain.** `buildSrc/review/reviewed.json` records who reviewed each imported `node_modules` file, when, and its hash, enforced by an import-tracing hook (`npm run trace-imports`). This is unusually rigorous. Native dependencies are pinned to commit SHAs of Tuta's own forks.

**Hardening.**
- Electron fuses (`electron-package-json-template.js`): `runAsNode` off, `NODE_OPTIONS` off, CLI inspect off, embedded asar integrity on, only-load-from-asar on.
- Hardened runtime and notarization.
- Update payloads must carry a signature from Tuta's own RSA key, checked separately from OS code signing (`ElectronUpdater.ts:183`).
- Strict window `webPreferences` (`ApplicationWindow.ts:349`).
- Production CSP: `script-src 'self' 'wasm-unsafe-eval'` with **no `unsafe-inline`**, `frame-src 'none'`, and `style-src 'unsafe-inline'` (`buildSrc/LaunchHtml.js:72-88`).
- Their entitlements are as broad as Aplos's (`mac-entitlements.plist`: JIT, unsigned executable memory, library validation disabled).

**Observability.** Minimal, but it exists.
- Console calls go into a **1,000-entry in-memory ring buffer**. It is written to `userData/logs/tutanota_desktop.log`, with one rotated old copy, **only on process exit** (`DesktopMonkeyPatch.ts`, `api/common/Logger.ts`). A crash or kill therefore loses it **(inference)**.
- Uncaught errors show a dialog that offers to send an error report or write `lasterror.log` and restart (`DesktopErrorHandler.ts`).
- SQL worker logs are piped back to the main logger.
- No Sentry or `crashReporter`. Dev-only timing metrics (`SyncMetrics`) and opt-in usage tests exist.

**Organization and smells.**
- The code is cleanly layered (`platform-kit` → `app-kit` → `applications`) and dependency-injected (`DesktopMain.createComponents`).
- `src/TODO.md` admits `platform-kit` is coupled to mail entities.
- There are leftovers:
  - `OfflineDbRefCounter.listIdLocks` is dead state.
  - `PerWindowSqlCipherFacade`'s doc still describes range locks that are gone.
  - `OfflineStorageSettingsModel.ts` is an empty file.
  - `MailIndexerPostLoginAction` still computes an index range that the offline indexer ignores.

---

## 5. UI notes

- **Framework.** Mithril 2.2.2 with an in-house component library (`src/ui/base`). The editor is Squire (`squire-rte`).
- **Motion.** A small hand-written animation module (`src/ui/animation/Animations.ts`, `Easing.ts`). The default duration is **200 ms**. Easings are cubic `in` (t³), `out` and `inOut`, plus `linear`, which is the default. There's no spring or motion library.
- **Mail rendering.** Mail HTML is sanitized with DOMPurify (`common/misc/HtmlSanitizer.ts`, external content blocked by default) and rendered into an **open shadow root** in the main document (`MailViewer.ts:499`). That keeps the mail's own styles intact. The shadow root stops keydown propagation so forms inside mail don't trigger shortcuts. The shadow DOM isolates styles, not scripts. Script safety relies on the sanitizer plus the strict CSP.
- **Keyboard.**
  - A global `KeyManager` (`src/ui/utils/KeyManager.ts`). Each view registers shortcut arrays with help labels.
  - Shortcuts registered by a modal take precedence.
  - F1 opens the generated shortcut help.
  - J/K list navigation lives in `ui/base/ListUtils.ts`.

---

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **Encrypt `aplos.db` at rest with a random 256-bit key wrapped by Keychain** (Aplos already has `engine-key.bin` via safeStorage).
   - Pass the raw key, not a passphrase.
   - Turn on memory security and run an integrity check on open.
   - Use incremental auto-vacuum.
   - Use a **permissively licensed** engine. `better-sqlite3-multiple-ciphers` and SQLite3MultipleCiphers are both MIT (checked via `gh api`). Tuta's binding and tokenizer are AGPL, so avoid them unless Aplos chooses AGPL.
   - `node:sqlite` has no encryption, so this also retires the pre-stable-API risk.
2. **Replace the per-thread JSON rows with per-message rows plus a contentless FTS5 table that shares the message rowid.**
   - Use `contentless_delete=1`, and keep filter columns in a separate rowid-joined table.
   - This directly fixes the full-table-scan `DELETE … WHERE id=?` on an `UNINDEXED` FTS column.
   - It also lets bodies be loaded on demand instead of living in memory.
3. **Keep "ranges" per folder or label.**
   - Store what is known-complete locally (newest-first, down to some lower bound).
   - Drop incoming creates outside the range, always apply deletes, and apply updates only to cached items.
   - This is the missing reconciliation model behind Aplos's ignored `reset:true` and its 500-thread window.
4. **Treat the cache as disposable.**
   - Flag tables as derived (purged on reset) or owned (drafts, settings, AI conversations, op queue).
   - When a cursor expires (Gmail history 404, Graph 410, JMAP `cannotCalculateChanges`), purge the derived data for that account and rebuild ranges. Don't merge into stale state.
5. **Checkpoint semantics.** Write the cursor only after the whole batch, including its derived writes, has committed. Make every write an idempotent upsert. Aplos already commits cursor and threads in one SQLite transaction; keep that, and adopt the idempotency rule for replays.
6. **One suspension gate per provider account.** On 429 or rate-limit 403 with `Retry-After`, pause *every* request for that account, then drain the queue serially. This replaces the four independent per-worker retry loops in `google.ts`.
7. **Run enrichment in its own queue after sync is done.** Tuta's indexer waits for `OnlineSyncDone`, runs separately from the cache queue (`doc/events.md`), is abortable, checkpoints per mailbox, and reports progress. Aplos's AI summaries and classification should follow the same rule.
8. **Split first sync into two parts.** Fetch list metadata lazily or in pages for the UI. Run the bulk body/index backfill as a separate, resumable, low-priority job with a persistent checkpoint (Tuta: `search_group_data.lastIndexed*`).
9. **Add a cheap local classifier before any LLM.** Tuta's per-mailbox TF.js spam model is the precedent. For Aplos, use header heuristics or a tiny local model to rank Home when AI is unavailable or not consented.
10. **Keep one IPC contract and generate the rest.** Tuta's JSON schemas compile into TypeScript, Kotlin and Swift dispatchers. Aplos should define one typed method schema shared by `preload.ts`, `electron.ts` and `server.ts` (ending the three-copy allowlist), and could later emit a Swift client for a phone.
11. **Copy the hardening Aplos lacks.**
    - Fuses (`runAsNode` off and the rest).
    - An update signature separate from the code signature.
    - A CSP with no `unsafe-inline` scripts.
    - For mail HTML, keep styles the way Tuta's shadow root does, but put the content in a sandboxed opaque-origin iframe (see Avoid #6).
12. **Logging.** Keep a ring buffer *and* append to a rotating file continuously. Add `lasterror.log` on fatal errors and a consented "send report" path. Tuta's file is written only on exit; improve on that.
13. **Background presence with graceful degradation.**
    - The main process stays alive in the menu bar after the last window closes.
    - Push/IDLE has heartbeat supervision: reconnect after 1.2× the advertised timeout, with exponential backoff capped at about 40 min.
    - Notification detail degrades when keys need a user prompt.
14. **IMAP specifics worth copying.**
    - Gmail over IMAP syncs only `\All`.
    - UID diffs run in sequence windows.
    - Fetches use compressed UID sets in small batches.
    - Each mailbox gets a failure count, and the whole session is postponed after a provider `NO [LIMIT]`.
    - OAuth refresh keeps the old refresh token when the response omits one.

### Avoid

1. **Don't put the engine in the renderer behind a multi-hop DB IPC.** Tuta had to add an in-memory cache layer to recover from it. Aplos's `utilityProcess` owning SQLite is the better topology. Keep queries coarse: view-model pages, not entity lookups.
2. **Never expose raw SQL (or any generic "run query") across a process or network boundary.** Tuta's `SqlCipherFacade` does this towards the renderer. A local server reachable from a phone must expose typed, scoped endpoints only.
3. **Don't run one sync engine per window.** Tuta opens N WebSockets and N writers. Aplos's single engine fanning out to windows is correct.
4. **Don't keep the whole mailbox with no eviction.** Tuta dropped its range setting once it indexed the full archive. For 15 GB Gmail accounts, Aplos needs a body budget: least-recently-read eviction, keeping FTS rows but evicting body blobs.
5. **Don't autocommit each statement without WAL.** Aplos already uses WAL plus transactions; keep them.
6. **A shadow DOM is not a sandbox.** It isolates CSS only. An iframe sandbox is still required for untrusted HTML.
7. **Don't use embedded-window OAuth for Google.** Keep the loopback flow in the system browser. **(Inference** about Google's enforcement.)
8. **Don't send all traffic to the server first.** Tuta has no offline outbox because the server owns every write. Aplos's durable op queue is a real advantage. Keep it and extend it to drafts.

---

## 7. "Local server" translation

**Core mapping.** Tuta's server plays three roles:
1. It **normalizes the world into entities**.
2. It keeps a **per-group, append-only event log with batch IDs and a retention window**.
3. It **elects a single leader client** for inbox processing.

An Aplos daemon on the Mac can play all three for its own clients. The UIs (Electron windows, later a phone) become Tuta-style replicas.

**Proposed shape.** Building on `server.ts`, which already serves `POST /api/invoke` and SSE `/api/events`:

- **Daemon process.** At first, the existing engine `utilityProcess`, kept alive by a menu-bar main process (Tuta's tray model). Later, a separate launchd agent so sync survives the UI quitting.
  - The daemon owns the providers: Gmail history, Graph delta, IMAP CONDSTORE/QRESYNC with **IDLE**, JMAP with **EventSource**, and CalDAV.
  - It owns the encrypted SQLite file and the op queue.
- **Change log.** Add a table `changes(seq INTEGER PRIMARY KEY, account_id, entity_type, entity_id, op, patch, at)`, appended in the *same transaction* as each mutation from sync or user ops. `seq` is the batch ID. Keep about 30 days or N rows. If a client's checkpoint is older than the oldest kept row, the daemon answers "out of sync" and the client purges and refetches its ranges, exactly like Tuta's `OutOfSyncError`.
- **API.**
  - REST for reads, range-paged by a date-prefixed sort key. This is the trick in Tuta's `constructMailSetEntryId`, giving pages like `GET /v1/folders/{id}/entries?before=<key>&limit=50`.
  - Typed command endpoints for writes, such as `POST /v1/threads/{id}:archive`, which enqueue ops.
  - One WebSocket (or SSE) at `/v1/events?since=<seq>`. It replays missed changes, sends a work-estimate message and a sync-done message, then streams live changes.
  - Heartbeats: the server announces the interval and the client reconnects after 1.2× it (Tuta's SSE pattern).
- **Clients.**
  - **Electron.** Keeps an in-memory view cache. It no longer needs `latestState` copies or whole-state snapshots; the existing `{epoch, rev}` diffing in `shared/live.ts` becomes `seq`.
  - **Phone.** Gets a SQLite replica with Tuta-style ranges, checkpoints and a "purge when out of sync" path.
- **Leader rule.** The Mac daemon is the only component that talks to providers, runs rules and spends AI budget. A phone never syncs providers directly while paired. This avoids the duplicate enrichment and quota use that Tuta solves with server-side leader election.
- **Security.**
  - localhost only, with a per-install bearer token handed to Electron through the existing secure IPC (not a static string).
  - For the phone: QR-code pairing that exchanges a device key, TLS with a pinned self-signed certificate on the LAN, and for off-LAN use, a relay that only forwards end-to-end-encrypted frames. Tuta's E2E posture is the model; the relay must never see plaintext.
  - Keys: the daemon needs the DB key without UI, so use the Keychain item accessible after first unlock. An optional app password (Tuta's Argon2id mode) would stop background sync until unlocked, so make that trade-off explicit in Settings.

**Pros.**
- One sync engine and one quota budget per account.
- IDLE and EventSource push become natural, because the daemon is long-lived.
- A UI crash or reload no longer interrupts sync.
- Memory is bounded: UIs hold only pages.
- The phone becomes a thin client with no provider OAuth, no Google verification surface on mobile, and no duplicate AI cost.
- Reconnect and resync semantics are proven by Tuta at scale.

**Cons and risks.**
- It still only works while the Mac is awake and online (same ceiling as now).
- Daemon lifecycle and upgrades: the UI and daemon versions can drift. Tuta handles this by sending model versions on connect and rebuilding the DB when the schema is newer, so add an API version and capability handshake.
- Shipping a launchd helper adds code-signing and Keychain access-group work.
- A network-reachable service turns local bugs into remote ones (Avoid #2).
- Debugging a third process needs the logging improvements first.

**Effort** (one developer plus agents; rough):

| Phase | Work | Estimate |
|---|---|---|
| 0 | Change log table, `since=` replay, auth token on the existing server, typed method schema | ~1-2 weeks |
| 1 | Per-message schema with rowid-shared contentless FTS, ranges, purge-on-reset, SQLCipher-compatible encryption with migration from plaintext | ~2-4 weeks. Highest value; also fixes the memory ceiling |
| 2 | Menu-bar persistence plus IMAP IDLE / JMAP EventSource in the engine | ~1-2 weeks |
| 3 | Standalone launchd daemon and a UI-to-daemon version handshake | ~2-4 weeks |
| 4 | Phone pairing, LAN TLS, relay | ≥4-8 weeks. Defer until desktop is a daily driver |

---

## Open questions

- Does Google currently accept Tuta's embedded-window OAuth for `https://mail.google.com/`, or does it depend on a user-agent override? Not visible in the client.
- How large do Tuta offline DBs get on big mailboxes now that the range setting is gone, and how long does the integrity check on open take at multi-GB sizes? There's no in-repo evidence; issues or forum threads would tell.
- Do they keep autocommit without WAL on purpose (perhaps for SQLCipher or mobile parity), or by accident? Worth checking before assuming WAL plus SQLCipher is free on macOS.
