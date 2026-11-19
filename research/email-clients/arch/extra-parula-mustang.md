# Parula / Mustang: architecture audit for the Aplos revamp (lighter pass)

2026-10-25. This is a read-only review of a shallow clone at `/Users/knewton/.t3/aplos-research/src/parula-mustang`, commit `d38ccc4` (2026-10-25). Nothing was installed, built or run. **[V]** marks a fact verified in the code or through the GitHub API. **[I]** marks my inference. Paths are relative to the repo root. No code was copied. One line is quoted where the exact text is the evidence.

The brief asked for focus on §3, §6 and §7. The prior research in `research/inbox-zero/` already covers Aplos's own architecture, so I only compare against it here.

---

## 1. Overview

- **What it is.** Parula, codenamed Mustang, is a TypeScript desktop client for mail, calendar, contacts, chat, video meetings and files. It runs on Electron for desktop and Capacitor for Android and iOS (`README.md`). Data stays local and does not pass through a vendor server, except for whatever mail server you choose. **[V]**
- **License.** The core is EUPL-1.2. The Exchange-family code (`app/logic/Mail/{EWS,OWA,ActiveSync,Graph}`), `app/logic/WebMail/` and Meet are proprietary (`LICENSE`), and GitHub reports `NOASSERTION`. I treated the proprietary directories as off limits: I only looked at file names and a couple of grep hits for "delta". **[V]**
- **Activity** (GitHub API, 2026-10-25). **[V]**
  - 127 stars and 20 forks. The repo was created 2017-04-10 and last pushed today. About 5,527 commits in total, with 1,860 in the last 52 weeks.
  - Releases are weekly or faster: v0.9.41 shipped 2026-10-24, v0.9.40 on 10-19 and v0.9.39 on 09-10.
  - Contributors: benbucksch 4,599 commits, NeilRashbrook 381, jermy-c 260. Everyone else has fewer than 110.
  - Of the last 100 commits, 83 are authored as "Ben Bucksch Coder". A live-server test documents fixtures under `/home/claude/...` (`app/test/logic/Mail/POP3/liveServers.test.ts:21`). **[I]** Like Aplos, it is now heavily agent-assisted.
- **Size.** About 137k lines of TS and Svelte across `app/logic` and `app/frontend`. **[V]**
- **Target user.** People who would otherwise use Thunderbird or Outlook, including Exchange and corporate users. It also targets companies, through paid Exchange support and a hosted WebMail build (`LICENSE` rationale). **[V]**

## 2. Feature inventory (brief)

| Feature | Evidence | Maturity |
|---|---|---|
| IMAP (CONDSTORE, IDLE, ACL, SPECIAL-USE) | `app/logic/Mail/IMAP/*` (1.7k lines) | Mature |
| JMAP mail, contacts, calendar, sharing, push | `Mail/JMAP/JMAPAccount.ts` (1,253 lines) | Mature, actively hardened |
| POP3 | `Mail/POP3/*`, README says "alpha" | Alpha |
| Graph, EWS, OWA, ActiveSync | Proprietary directories | Claimed mature (not audited) |
| SMTP send (nodemailer, in the backend) | `desktop/backend/backend.ts` `sendMailNodemailer` | Mature |
| CalDAV/CardDAV (tsdav), JMAP and Exchange calendars, recurrence, invitations | `app/logic/Calendar/*` | Mature |
| Filter rules and smart folders (saved searches) | `Mail/FilterRules/FilterRuleAction.ts`, `Mail/Virtual/SavedSearchFolder.ts` | Working, client-side only |
| PGP and S/MIME | `Mail/Encryption/*`, `openpgp` dependency | Working |
| Autoconfig, ISPDB, AutoDiscover | `Mail/AutoConfig/*` | Mature (the author helped create Autoconfig) |
| Local search | `Mail/SQL/SQLSearchEMail.ts:57`: `LIKE '%…%'` over subject and plaintext | Weak: no FTS index |
| List-Unsubscribe, AI, snooze, send-later, offline outbox | No hits in `app/logic` | **Absent** |
| Mobile (Capacitor plus nodejs-mobile backend) | `mobile/backend/backend.ts`, `.github/workflows/installer-{ios,android}-*.yml` | Shipping installers. iOS needed Node 18 and native modules repackaged as frameworks (`mobile/docs/structure.md`) |

## 3. Architecture deep dive

### 3a. Process and deployment topology

**[V]** The pieces are less separated than the README's "logic vs UI" pitch suggests:

1. **The Electron main process hosts the "backend".** `desktop/src/main/index.ts:1` imports `desktop/backend/backend.ts` and calls `startupBackend()` inside `createWindow()`. The backend is a module inside the main process, not a utilityProcess or child process. It opens a **JPC WebSocket server on `127.0.0.1:5455`** (port 5453 in dev) (`backend.ts:35-38`, `lib/jpc-ws/protocol.js:99-114`).
2. **The renderer holds both the UI and the entire "logic" layer.** Sync orchestration, MIME parsing (`postal-mime`, `EMail.ts:28,361`), SQL query building, OAuth and filter rules all run there. It connects back to the backend as a WebSocket client (`app/logic/startup.ts:66-74`).
   - The main window uses `sandbox:false` and `webviewTag:true` (`index.ts:27-31`).
   - The main process strips Origin and Referer from every renderer request and injects `Access-Control-Allow-Origin: *` on every response, so the renderer can call any HTTP API directly (`allowCrossDomainRequestsFromFrontend`, `index.ts:254-298`). JMAP and Graph HTTP calls are therefore made from the renderer.
3. **Auth for the local socket.**
   - Main creates a 256-bit random secret (`createJPCSecret`, `backend.ts:46-55`) and passes it to the renderer in the URL hash (`#jpcSecret=`).
   - The renderer reads it and immediately scrubs it with `history.replaceState`, so iframes and error reports can't see it (`startup.ts:24-36`).
   - The client sends `jpc-<secret>` as the WebSocket subprotocol. The server checks that value plus an Origin allowlist (`file://`, `null`, the two localhost Vite ports, and Capacitor's `https://localhost`) (`lib/jpc-ws/protocol.js:282-300`).
4. **What the backend actually exposes is capabilities, not a mail API.** The start object (`createSharedAppObject`, `backend.ts:57-120`) includes:
   - an `ImapFlow` constructor and a SQLite `Database` handle, which accepts any absolute path (`backend.ts:579-592`)
   - raw TCP sockets plus `startTLS`, Node `WebSocket`, the whole `fs/promises` module, `readFile`/`writeFile` on arbitrary paths, a `ky` HTTP client, nodemailer, a tsdav client and an HTTP server
   - OS integration: tray, badge, notifications, `openExternal`, the updater

   In terms of `docs/arch/backend.md`, they effectively chose **Option 2 ("expose protocol libs")** over **Option 1 ("full backend")**, carried over **2.1 (JPC)**. That doc says it "will choose one", but it never records a decision. The code is the decision.
5. **Mobile runs its own backend.** The same backend runs on the phone inside nodejs-mobile, listening on the same localhost port. The secret comes over the Capacitor bridge (`mobile/backend/backend.ts:27`, `startup.ts:42-56`). **The phone never talks to the desktop.** Each device syncs independently with the providers. **[V]**
6. **The hosted WebMail build** (proprietary) replaces `appGlobal.remoteApp` with a different backend object (`app/logic/WebMail/startup.ts:19`). The logic layer is portable across "local Node backend" and "something else that provides the same capability surface". **[V]** I didn't audit what WebMailBackend implements.
7. **Lifecycle.** When the main window closes, the main process shuts the backend down (`index.ts:48`). On macOS the app stays alive with no window, but sync lives in the renderer, so **no sync runs without a window**. **[V]/[I]**
8. **Sleep and wake.** `powerMonitor` suspend and resume events are published as an observable `computerOn` (`backend.ts:497-509`). On wake, the logic reconnects accounts, retries twice with 4 s between tries for VPNs, and calls `getNewMessages()` on each inbox (`startup.ts:120-149`). **[V]**

### 3b. Connectivity and auth per provider

- **Gmail uses IMAP and SMTP with XOAUTH2, not the Gmail API.**
  - The scope is `https://mail.google.com/` plus CardDAV, Calendar and Drive.
  - It uses PKCE, and the Google client ID and secret are hardcoded in `app/logic/Auth/OAuth2URLs.ts:40-50`.
  - Labels arrive as IMAP folders. The schema says explicitly that a message lives in exactly one folder ("Greetings to Gmail", `Mail/SQL/createDatabase.ts:40`), so a Gmail message with three labels is stored three times. **[V]**
- **Microsoft has two entries in `OAuth2URLs.ts`:**
  - one for Outlook/EWS/IMAP/POP/SMTP scopes
  - one for Graph, with `Mail.*`, `Calendars.*`, `Contacts.*`, `Files.*` and so on

  Both are public clients without PKCE (`doPKCE:false`). Yahoo and AOL use OAuth with PKCE. **[V]**
- **JMAP** discovers the session and uses `eventSourceUrl` for push (`JMAPAccount.ts:174,763`). **[V]**
- **OAuth UI** has several strategies (`Auth/UI/`): an in-app tab or window, the system browser, and a **localhost redirect** served by a backend `HTTPServer` at `/login-success` (`Auth/UI/OAuth2Localhost.ts:25-43`). **[V]**
- **Token handling.** A refresh failure that is *transient* (network or VPN down) is rethrown and the refresh token is **kept**. Only a non-transient failure deletes it (`Auth/OAuth2.ts:106-121`). **[V]** This is the right behavior, and it matches the `invalid_grant` handling Aplos is missing.
- **Credential storage is not real encryption.** Passwords go into the accounts DB `json` column, and refresh tokens go into **renderer `localStorage`**. Both pass through `passwordEncrypt()`, which uses the `password-salt` library with a hardcoded constant passphrase: `const secret = 'anything';` (`Auth/passwordEncrypt.ts:4`, `passwordLocalStorage.ts:4-16`, `Mail/SQL/Account/SQLAccount.ts:11,57`). **[V]** Anyone who can read the profile directory can decrypt every credential. There is no Keychain or `safeStorage`.

### 3c. Sync algorithm

**IMAP** (`Mail/IMAP/IMAPFolder.ts`, `IMAPAccount.ts`). **[V]**
- **Three connections per account, by purpose** (`ConnectionPurpose`, `IMAPAccount.ts:575-580`):
  - *Main* stays in IDLE on INBOX.
  - *Fetch* does bulk body downloads.
  - *Display* is for whatever the user just opened.

  Non-main connections have auto-IDLE off and an 11-minute socket timeout, and are recreated on demand (`IMAPAccount.ts:136-143`). After any command, Main debounces back to IDLE on INBOX (`IMAPFolder.ts:93-106`). IDLE is renewed every 5 minutes because Gmail drops quiet connections at about 10 minutes (`kIDLERenewalSeconds`, `IMAPAccount.ts:582-585`).
- **Incremental sync.** If the server has CONDSTORE and a stored modseq, it fetches with `changedSince` (`IMAPFolder.ts:122-124,193-207`). The highest modseq is saved per folder in `folder.syncState` (`updateModSeq`, `:475-484`). There is no QRESYNC, so expunges are found by diffing the full UID list (`listAllUnknownMessages`, `:137-174`, which has a TODO about refetching that list every time).
- **Initial sync.**
  - Headers come in batches of 200 UIDs, newest first, with each batch persisted before the next.
  - Bodies are fetched separately as full RFC822 source, in batches of 50, on the *Fetch* connection. Per-message errors are reported and the loop continues (`:367-433`).
  - **[I]** Saving each batch works as a natural checkpoint. Nothing records a "resume from UID X" cursor, but the next run's UID diff skips what is already stored.
- **Polling.** Folders other than INBOX are polled every 10 minutes by default (`pollIntervalMinutes = 10`, `IMAPAccount.ts:33`; `IMAPFolder.ts:486-519`). Server events (`exists`, `flags`, `expunge`) are handled live (`IMAPAccount.ts:202-240`). Because sync logic runs in the renderer, those event callbacks cross the WebSocket as JPC function references.

**JMAP** (`Mail/JMAP/JMAPFolder.ts`, `JMAPAccount.ts`). **[V]**
- **Initial listing** pages through `Email/query` and back-references `Email/get` in the same request, asking only for list properties. It honors a lower `limit` if the server imposes one, and retries each page on transient errors.
- **The `state` from the *first* page is the one saved.** Changes that happen during backfill are therefore picked up later by `/changes`. This is the "capture the cursor before backfill" rule that Aplos's Gmail path needs for `historyId`.
- **Deltas** use `Email/changes` with `maxChanges: 500`. `cannotCalculateChanges` triggers a full re-list. When `hasMoreChanges` is set, the intermediate state is saved, "so an interrupted sync continues here" (`JMAPAccount.ts:490-512`).
- **State is tracked per object type** (Mailbox, Email, Identity, ContactCard, Calendar, CalendarEvent, ShareNotification) behind one `stateLock` (`:47-48`).
- **Push** (`startPushListener`, `:761-858`):
  - It uses EventSource over `fetch`, with `closeafter=no` and a 60 s ping.
  - A **watchdog aborts the stream after two missed pings**, which catches half-open VPN tunnels.
  - Reconnects go through `Throttle(1, 10)`, honor `Retry-After`, and wait for the network to come back online.
  - A new login aborts the previous listener.
  - A `state` event calls `sync(type, newState)` for each changed type, including accounts shared with the user.

**Rate limiting.** **[V]**
- Each JMAP account has a `Throttle(50, 1)` (50 requests per second) and a request semaphore (`JMAPAccount.ts:54,395-417`).
- On 408, 429, 502, 503 or 504 (`isTransientError`, `util/netUtil.ts:76-77`), it pushes the throttle's next slot out by `Retry-After`, capped at 20 s (`:426-434`).
- The backend's `HTTPFetchError` carries `retryAfterSeconds` across JPC as a plain property (`backend.ts:228-260`).
- There is no daily-quota concept.

**Graph** (proprietary, file names and grep only): it stores `@odata.deltaLink` per folder as the folder's sync state (`Mail/Graph/GraphFolder.ts:32-35,104`). **[V]**

**Conflict resolution and offline outbox.** **[V]**
- There is no outbox and no durable op queue.
- `ComposeActions.send()` shows the message optimistically at the top of Sent, lets the composer close right away, awaits `account.send()`, then removes the placeholder and waits for the real copy on the next sync (`Mail/ComposeActions.ts:321-381`; tested by `app/test/logic/Mail/sendInBackground.test.ts`).
- Offline, the send just fails.
- Local changes such as flags are written straight to the server. I found no queued replay. **[I]**

### 3d. Local storage

**[V]**
- **Engine.** SQLite through `better-sqlite3`, wrapped by `@radically-straightforward/sqlite`, running in the **main process**. The renderer composes queries with an `sql` template tag (`lib/rs-sqlite/index.ts`, a types-only shim) and runs them over JPC, so every `db.get` and `db.all` is a WebSocket round trip. WAL mode and foreign keys are on (`Mail/SQL/SQLDatabase.ts:13-17`).
- **Multiple database files:**
  - `mail.db` (`Mail/SQL/createDatabase.ts`)
  - a separate MIME source DB with table `emailMIME(emailID, messageID, mime)` (`SQL/Source/createSourceDatabase.ts`)
  - an accounts DB with `account(idStr, type, protocol, mainAccountIDStr, json)`
  - separate DBs for calendar, contacts, chat, files and meet
- **Main tables in `mail.db`:**
  - `email(id AUTOINCREMENT, folderID, pID, messageID, parentMsgID, threadID, size, dateSent, dateReceived, outgoing, contactEmail, contactName, subject, plaintext, html, isRead, isStarred, isReplied, isForwarded, isImportant, isDraft, isSpam, downloadComplete, json)`, indexed on `(folderID, dateSent DESC)`
  - `emailPerson(emailAddress, name, personID)` and `emailPersonRel(emailID, emailPersonID, recipientType)`
  - `emailAttachment(emailID, contentID, filename, filepathLocal, mimeType, size, disposition, related, json)`
  - `emailTag(emailID, tagName)`
  - `folder(accountID, name, path, parent, countTotal, countUnread, countNewArrived, specialUse, syncState ANY, json)`
  - `emailAccount(idStr, protocol)`
- **Bodies and attachments.** Bodies are stored in full: parsed text and HTML in `email`, raw MIME in the source DB. Attachments are written as files under `~/Library/Mustang`-style directories with mode 0400 (`Mail/Store/RawFilesAttachment.ts:58-62`). POP3 accounts also keep a Maildir backup (`Store/setStorage.ts:33-36`).
- **The source DB is matched by the mail DB's row ID.** The code admits the ID can be reused across databases, so it guards by also comparing `messageID` (`SQLSourceEMail.ts:41-44`). **[V]** This is fragile cross-database referential integrity.
- **Search** uses `LIKE` scans and has no FTS (`SQLSearchEMail.ts:57`).
- **Encryption at rest:** none.
- **Eviction:** none found.
- **Migrations** use `db.migrate(...)` with appended steps (`SQLDatabase.ts:14`, `SQLEMailMigrate.ts`).
- **In-memory model.** Opening a folder loads the "main properties" (no bodies) of *every* message in it into an observable `ArrayColl`: the first 200, then the rest (`Folder.ts:64-87`, `SQLEMail.ts:609-633`). That is the same memory ceiling Aplos has, scoped per folder rather than per mailbox.

### 3e. API between UI and engine

**[V]**
- **JPC** (`lib/jpc/PROTOCOL.md`, `obj.js`) is transparent object RPC. The server sends class descriptions. The client builds stubs where every method and getter becomes `await`, and setters become `setX()`.
- Objects are referenced by ID and released through `FinalizationRegistry` (`obj.js:104-118`). Without it, the docs say, "this will leak everything".
- Local functions and observables can be passed across. An object with `subscribe()` is observed remotely (`obj.js:657`), which is how backend observables like `computerOn` reach the UI.
- **Binary data is encoded as JSON arrays of numbers** (`{uint8array: Array.from(obj)}`, marked "TODO inefficient", `obj.js:560-571`). Every MIME source, attachment and SQLite blob that crosses the boundary inflates roughly 3 to 4 times as JSON text. **[I]**
- The UI itself binds directly to logic-layer observables (`svelte-collections`) in the same renderer, so there's no UI-to-engine API to page through. The lists are virtualized (`frontend/Shared/FastList.svelte`).
- `docs/arch/backend.md` predicted these exact costs: chattiness, getter round trips, "JPC is not finished".

### 3f. Send, drafts, threading, rules, calendar, AI

- **Send** builds MIME in the backend with nodemailer (`sendMailNodemailer`), or uses the protocol's native send for JMAP and Graph. **[V]**
- **Unlicensed users get a promotional "Sent by Parula" footer appended to every outgoing HTML mail** (`ComposeActions.ts:330-333`). **[V]**
- **Drafts** are saved with `draftFolder.addMessage()` (IMAP APPEND or the protocol equivalent), which replaces earlier drafts (`ComposeActions.ts:384-402`). Drafts therefore sync to the server, which Aplos's Gmail path doesn't do yet. **[V]**
- **Threading.** `threadID` is the top message's Message-ID. IMAP uses the server's thread ID when OBJECTID or X-GM-EXT-1 is available (`IMAPEMail.ts:80`). **[V]**
- **Rules.** A rule is a `SearchEMail` criteria object plus actions (move, copy, tag, star, delete or spam), run at a *moment*: incoming before spam, incoming after spam, or outgoing (`FilterRules/*`). Smart folders reuse the same search object. Rules are client-side only and run only while the app syncs. **[V]**
- **AI:** none. **[V]**

## 4. Engineering quality (brief)

- **Tests.** 260 vitest files under `app/test/`. Provider tests mostly subclass an account and override the transport method, for example `TestJMAPAccount.makeSingleCall` (`app/test/logic/Mail/folderSync.test.ts:20-31`). Some live-server POP3 and Dovecot tests are opt-in. **[V]**
- **CI.** `.github/workflows/` only has installers for each platform and brand (mustang, parula, lookout) plus auto-translate. **No workflow runs the tests.** **[V]**
- **Observability.**
  - Errors fall into four kinds: `logErrorToServer`, `minorError`, `dataError` and `internalError` (`app/logic/util/error.ts`).
  - The account name is deliberately kept out of `ex.message` so the error server can group errors and doesn't deanonymize users (`startup.ts:160-177`).
  - Production sends errors to Sentry (`frontend/Util/error.ts`).
  - IMAP has a per-account command log (`account.log`).
  - **[V]**
- **Code organization.** There is a clean abstract model (`Account`, `Folder`, `EMail`, `SearchEMail`) with protocol subclasses, and storage is pluggable (`MailAccountStorage`, `MailContentStorage`). A Thunderbird-style keyboard map lives in `frontend/Mail/Message/MessageKeyboard.ts`. **[V]**

## 5. UI notes (brief)

Svelte 4-style components with `svelte-collections` observables, TipTap for compose, `lucide-svelte` icons, and four mail layouts (vertical, table, 3-pane, chat). Email HTML is rendered in an Electron `<webview>` guest. `will-attach-webview` strips the preload and forces `nodeIntegration:false`, `contextIsolation:true` and `webSecurity:true` (`desktop/src/main/index.ts:315-329`, `frontend/Shared/WebView.svelte`). Mobile and webmail builds use a sandboxed opaque-origin iframe instead. Motion is minimal: one Svelte file uses transitions. Shortcuts are single keys modeled on Thunderbird and Outlook (`m`, `s`, `j`, `r`, `f`, `Delete`). **[V]**

---

## 6. Lessons for Aplos

### Adopt (ideas only)

1. **The JMAP push loop design, for any long-lived push connection** (JMAP EventSource now, IMAP IDLE next):
   - a watchdog that kills the stream after two missed pings
   - a reconnect throttle
   - `Retry-After` honored
   - `waitUntilOnline()` before reconnecting
   - the old listener aborted on re-login
   - wake-from-sleep reconnects followed by an explicit "check for new mail"

   Together these directly replace Aplos's 60 s poll for JMAP and IMAP accounts.
2. **Purpose-split IMAP connections** (idle, bulk fetch, user display). A user click never waits behind a 500-message backfill. IDLE renewal every 5 minutes is the right default for Gmail and iCloud.
3. **Capture the sync cursor before backfill and persist intermediate cursors.** Mustang saves JMAP `state` from page 1 and keeps the intermediate state when `hasMoreChanges` is set. For Aplos Gmail, record `historyId` before the first `threads.list` page and commit each page with a resume cursor. This is the checkpoint fix the synthesis calls for.
4. **Metadata first, bodies second, in separate small batches on a separate lane.** Mustang uses 200 headers, then 50 bodies at a time, newest first, with per-message errors that don't abort the batch. This is the answer to Aplos's all-or-nothing `format=full` first sync.
5. **One retry layer with a per-account throttle and semaphore**, driven by a transient-error classifier (408/429/5xx plus network error codes). Transient refresh failures keep the refresh token. Add what Mustang lacks: Google `reason` parsing and a daily-quota "stop for today".
6. **Normalized hot columns, JSON only for extras.** Flags, `threadID`, `dateSent` and contact fields are real columns with a `(folderID, dateSent DESC)` index. Raw MIME goes in a separate DB file and attachments as files. Aplos's JSON thread blob should move toward this shape: list views read narrow columns, and bodies are lazy.
7. **A rule is a saved search plus actions plus a moment.** One criteria object powers search, smart folders and rules. It's a simple, testable model for Aplos's missing rules. Aplos should compile what it can into provider-side filters so rules run while the Mac sleeps.
8. **An error taxonomy and log hygiene.** Distinguish internal, data, minor and user errors. Keep account and user identifiers out of messages that are grouped or uploaded. Aplos should start with a local rotating log and add opt-in crash upload.
9. **Optimistic send UX.** The composer closes immediately and a "sending" row appears at the top of Sent. Aplos's durable op queue already does the hard part (see Avoid 6).
10. **Draft sync through the provider's draft primitive**, replacing the previous draft on each save.
11. **Render mail HTML in an isolated guest** (a webview with no preload, forced isolation, or an opaque-origin sandboxed iframe), with remote images blocked by default. This closes Aplos's "email HTML in the privileged renderer" problem.

### Avoid

1. **Constant-key "encryption" of credentials** (`'anything'`) and refresh tokens in renderer `localStorage`. Aplos must keep secrets in Keychain or `safeStorage`, inside the engine only, and never in the renderer.
2. **Exposing raw capabilities to the UI.** That means fs on arbitrary paths, raw TCP, a SQLite handle that opens any file, and IMAP library objects. With `sandbox:false` and a global CORS bypass, one renderer XSS becomes full local compromise and mailbox theft. Aplos's narrow typed `invoke` allowlist is the better boundary. Keep it and tighten it.
3. **Transparent object RPC (JPC style).** Getters become round trips, garbage collection depends on `FinalizationRegistry`, and callbacks cross the wire. It can't be versioned, rate-limited or audited, and it is useless to a phone or third-party client. Use a coarse, typed, versioned, data-shaped API.
4. **Binary as JSON number arrays.** Send bodies and attachments as streamed or binary frames, or as file handles or URLs, never inline JSON.
5. **Sync in the renderer, backend in the main process.** Sync stops when the window closes, and synchronous `better-sqlite3` calls run on the Electron main thread. Aplos's utilityProcess engine is already the better shape. Keep it, and let it outlive windows.
6. **No outbox or op queue.** Offline sends fail and flag changes don't replay. Aplos's durable `ops` queue is a real advantage, so don't regress it in the rewrite.
7. **"One message, one folder" for Gmail.** It duplicates multi-label mail. Aplos should model Gmail as threads with label sets and map IMAP folders onto that model, not the reverse.
8. **`LIKE '%x%'` search.** Keep FTS5.
9. **Loading every row of a folder into memory.** Page from SQLite instead. Mustang has the same ceiling as Aplos.
10. **Cross-database row-ID joins guarded by Message-ID.** If Aplos splits bodies into a second DB, key them by a stable ID it generates itself.
11. **Tests without CI.** 260 test files that nobody runs per commit will rot. Aplos should run its suite in CI from day one of the revamp.
12. **Injecting promotional footers into users' outgoing mail.**

---

## 7. "Local server" translation

### What Mustang already shows

**[V]** Mustang *is* a localhost server architecture: a WebSocket server on `127.0.0.1` behind a per-launch 256-bit secret and an Origin allowlist, with the UI as a client. Three things make it the wrong template for Aplos's phone goal, and one part of it is worth keeping.

- **The boundary sits too low.** The server exposes IMAP sockets, a SQL handle and the filesystem. A remote client would need the whole logic layer and would make one network round trip per SQL query and per IMAP command. Their own doc lists this as Option 2's main cost and Option 1's main benefit ("a mail goes directly from IMAP fetch to database to file", `docs/arch/backend.md`). For a phone, **Option 1, a full backend behind a high-level API, is the only workable choice.**
- **The listener has a `0.0.0.0` switch** (`openPublic` in `jpc-ws/protocol.js:103`). On a LAN, though, a secret sent as a WebSocket subprotocol over plain `ws://` would be in cleartext. There is no TLS, no device pairing and no per-client scope.
- **Their mobile answer is "run the whole backend on the phone"** (nodejs-mobile). It works, at a real cost: Node 18 on iOS, native modules converted into frameworks, no WASM JIT, credentials on every device, and duplicate sync.
- **Worth keeping:** the startup secret handoff. The token is generated by the host process, passed to the trusted UI out-of-band (URL hash, then scrubbed), sent in a header and never in a URL, and checked together with the Origin.

### How it maps onto Aplos

Aplos is closer to "Option 1" than Mustang is. The engine already owns SQLite, sync, adapters, the op queue and AI, and it exposes about 55 `invoke` methods plus `{epoch, rev}`-stamped change events. `server.ts` already proves the HTTP shape: `POST /api/invoke` with SSE, and Host and Origin checks. The translation:

1. **Make the engine the daemon.** Keep it as an Electron `utilityProcess`, but stop tying its life to windows: menu-bar mode plus a login item. Later it could become a standalone `launchd` agent running Electron's Node with `ELECTRON_RUN_AS_NODE` disabled by fuse (that means a separate signed helper). One process owns SQLite and the provider connections. The Electron UI, a CLI and a phone are all clients.
2. **Move the HTTP and WebSocket listener *into the engine*, not main.**
   - Bind `127.0.0.1` on an ephemeral port.
   - Write `{port, token}` to a 0600 file in the app's data directory, which is how the UI and CLI discover it. This avoids Mustang's fixed-port 5455 collisions.
   - Keep the Electron UI on MessagePort IPC if latency matters. The same typed contract can serve both transports.
3. **Replace "invoke anything" with a JMAP-shaped data API.**
   - `Thread/query` with position or anchor paging, `Thread/get` with a property list, `Message/get` (bodies on demand), `Thread/set` (operations go through the existing op queue), and `Thread/changes {sinceState}`.
   - Aplos's `rev` becomes the JMAP `state`. Push sends `{type: newState}` over WebSocket or SSE. Clients call `/changes`, and on `cannotCalculateChanges` they resnapshot. Aplos's gap-detect-and-resnapshot logic already exists.
   - Blobs are served from `GET /blob/:id` with streaming and range support, never inline JSON.
   - Version the contract (`/v1`), and generate TypeScript types from one schema to kill the three copied allowlists.
4. **Phone access, in stages.**
   - *LAN:* Bonjour advertisement. A QR pairing code shown on the Mac carries a per-device token and the daemon's self-signed TLS certificate fingerprint. The phone pins the certificate. Each device token has a scope (read, act, send) and can be revoked.
   - *Remote:* Tailscale works today for the owner. A product-grade relay needs end-to-end encryption between phone and daemon, so the relay only sees ciphertext.
   - AI and rules stay on the Mac, so the phone gets Aplos's brain without its own credentials.
5. **Security floor.**
   - The token goes in a header and never in a URL. Check Origin.
   - No filesystem or socket primitives on the API.
   - Rate-limit auth failures.
   - Bind to LAN only when the user opts in.
   - Audit-log every send and delete issued from a remote client.

### Pros

- One sync engine and one database for every client. Phone, CLI and a future MCP or agent all see the same state and the same AI output.
- Fixes the "window closed means no sync" problem.
- A clean, typed boundary makes the HTML-isolation and IPC-allowlist cleanup easier.
- JMAP-shaped `state` and `/changes` is a solved design that Aplos can mostly derive from its existing `rev` events.
- The phone needs no OAuth verification, no keys and no provider SDKs.

### Cons

- The phone only works while the Mac is awake and reachable. Sleeping laptops are the norm, and Power Nap doesn't keep a daemon serving. The phone needs a degraded read-only cache, or a direct-to-provider fallback, which is Mustang's model.
- A LAN-reachable mail daemon is a new attack surface. Pairing, TLS and token management are real work and need careful review.
- macOS Local Network permission prompts and iOS background limits complicate the experience.
- Daemon and client versions will drift apart, so the API must be versioned.

### Effort

These are rough estimates for one developer plus agents. **[I]**

| Stage | Work | Estimate |
|---|---|---|
| A. Typed contract | One schema, generated types, remove the three copied allowlists | 3-5 days |
| B. Engine-hosted localhost API | Ephemeral port, token file, `/v1` query/get/set/changes, WebSocket push, blob endpoint | 1-2 weeks |
| C. Daemon lifecycle | Menu-bar mode, login item, survives window close, crash restart | 3-5 days |
| D. LAN phone pairing | Bonjour, QR pairing, TLS pinning, scoped tokens, revoke UI | 2-3 weeks plus a security review |
| E. Phone client | Separate project | Months |

**Recommendation.** Do A through C as part of the backend revamp. They pay off right away in robustness, clean IPC and sync without a window. Defer D and E until after the 30-day plan in `SYNTHESIS.md`.
