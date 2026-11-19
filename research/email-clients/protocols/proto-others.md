# Provider connectivity beyond Gmail: Microsoft Graph, IMAP, JMAP, CalDAV/CardDAV, iCloud

2026-10-25. Research for the Aplos Mail backend overhaul. This report covers how a desktop app (and later a local daemon on the user's Mac) should connect robustly to Outlook/Microsoft 365, generic IMAP, iCloud, Yahoo/AOL, Fastmail (JMAP) and CalDAV/CardDAV servers. It then audits Aplos's adapters against that and ends with a prioritized defect list and a recommended connectivity design per provider.

**Scope and method.**
- I read the prior research first and did not redo it. That includes the Aplos audit (`research/inbox-zero/aplos-architecture.md`), the council synthesis, and the client reports in `research/email-clients/arch/` (Mailspring, Nylas, Geary, Delta Chat, EmailEngine).
- I read the Aplos adapters in full at `/Users/knewton/.t3/projects/aplos-mail` (main, `72095ff`): `apps/desktop/src/main/{microsoft,imap,imap-session,imap-index,jmap,caldav}.ts`, plus `engine/gate.ts` and the sync loop in `engine/service.ts`. Paths below are relative to `apps/desktop/src/` unless noted.
- I read the installed `imapflow` package (2.4.3, MIT) to confirm what it supports.
- Official docs and RFCs are cited by URL.
- Third-party code was read, never run: Mailspring-Sync (GPL-3.0), Nylas sync-engine (AGPL-3.0), and the python-caldav server-compatibility table (Apache-2.0). It is cited for ideas only. Nothing is copied.

**Evidence labels.** **[V]** means verified in code or in an official doc, with a path or URL. **[D]** means stated by official docs but not tested live. **[S]** means a secondary source (forum, third-party project). **[I]** means my inference.

---

## 0. The ten things that matter most

1. **The Outlook adapter will probably hit Microsoft's concurrency limit on its first real sync. Every 429 fails the whole run.** Outlook allows **4 concurrent requests per app per mailbox** [D]. Graph runs up to 4 sub-requests of an unordered `$batch` at once [D]. Aplos runs 3 batches concurrently, plus page-following pools of 4 on top (`main/microsoft.ts:189, 220, 224`), and it never retries a sub-request 429. This is the same failure shape as the Gmail 403.
2. **The Graph delta cutoff filter is permanent.** Aplos starts each folder's delta with `$filter=receivedDateTime ge <cutoff>` (`microsoft.ts:263-266`). Graph encodes query options into the `deltaLink` [D]. So older mail that later moves into Inbox (unarchived on the phone, restored from Deleted Items, moved by a rule) is likely never reported [I].
3. **Graph push needs a public HTTPS endpoint (webhook), Event Hubs or Event Grid** [D]. None of these fits a desktop app without a relay. The right desktop design is adaptive delta polling. An optional IMAP IDLE "doorbell" over XOAUTH2 can sit on top of it.
4. **IMAP has no IDLE and only one connection per account.** That connection is serialized and closed after 60 s idle (`main/imap-session.ts:71`, `main/imap.ts:132-167`). A long sync blocks archive, flag and send. The standard design is two connections: one IDLEs on INBOX, one runs commands.
5. **IMAP first sync and catch-up are unbounded and download whole messages.** Every message up to 1 MB is fetched as full RFC 822 source at sync time (`imap.ts:239-243`). Catch-up fetches `uidNext:*` with no cap (`imap.ts:283`). There is no checkpoint.
6. **QRESYNC is unused.** imapflow supports it (`qresync: true`). But it must stay off for iCloud, whose QRESYNC was reported broken [S]. Yahoo advertises `MESSAGELIMIT=1000` (RFC 9738) [D]. Aplos's "UIDs not returned are deleted" logic (`imap.ts:289-298`) would turn a partial answer into false deletions.
7. **JMAP has push built in, and Aplos ignores it.** The session's `eventSourceUrl` is never read (`main/jmap.ts:139-148`). Fastmail also says API tokens are for testing and personal projects. Apps for other people should use OAuth, which requires contacting Fastmail [D].
8. **CalDAV has no sync-token or ctag.** It re-runs an expanded `calendar-query` across every calendar every 10 minutes, all in parallel (`main/caldav.ts:165-177`). Recurrence depends entirely on server-side `<C:expand>`, which servers handle inconsistently. It also forwards Basic credentials across cross-origin redirects (`caldav.ts:45-53`).
9. **Outlook.com has had no Basic auth (app passwords) for IMAP/POP/SMTP since 16 Sep 2024** [S]. Exchange Online SMTP AUTH Basic will be disabled by default at the end of December 2026 [S]. So no generic IMAP preset with a password will work for Microsoft accounts. The IMAP adapter has no XOAUTH2 path, even though imapflow supports `accessToken`.
10. **For the local daemon, connection budgets are per account across all devices.** Gmail allows about 15 clients [D]. iCloud's limit is undocumented (around 5 by one secondary source [S]). The daemon should hold 2 IMAP connections per account at most. A phone should reach mail through the Mac daemon, not open its own IMAP sessions.

---

## 1. Microsoft Graph (Outlook.com and Microsoft 365)

### 1.1 Incremental sync: per-folder delta

- **Facts [D]** ([delta-query-messages](https://learn.microsoft.com/en-us/graph/delta-query-messages)):
  - Message delta is **per folder**. To track a hierarchy, you track each folder separately.
  - A round is a chain of `@odata.nextLink`s ending in an `@odata.deltaLink`, and you persist the deltaLink.
  - Supported options are `$select`, `$top` and `$expand`. The only `$filter` allowed is `receivedDateTime ge|gt <value>`, and **"Applying `$filter` in a delta query returns only up to 5,000 messages."** The only `$orderby` is `receivedDateTime desc`. `$search` is not supported.
  - The optional `changeType=created|updated|deleted` narrows a round.
  - Page size is set with `Prefer: odata.maxpagesize`.
  - Graph **encodes the OData and custom query options into the nextLink/deltaLink**. Removals arrive as `@removed: {reason}`.
- **Implication [I].** A filter applied in the first round keeps applying in later rounds. A message older than the cutoff that moves into a tracked folder is outside the filtered collection, so it should not appear as an addition. This is the mechanism behind defect M2.
- **Calendar.** `/me/calendars/{id}/calendarView/delta?startDateTime&endDateTime` is v1.0. It is per calendar, `$select` is not supported, and the tokens encode the window ([delta-query-events](https://learn.microsoft.com/en-us/graph/delta-query-events)) [D]. Calendar delta without a date range is beta only.

### 1.2 Change notifications, and what a desktop app can do instead

- **Facts [D]** ([change-notifications-overview](https://learn.microsoft.com/en-us/graph/change-notifications-overview)):
  - Delivery is only by **webhooks, Azure Event Hubs, or Azure Event Grid**.
  - Outlook message, event and contact subscriptions last up to **10,080 minutes** (under 7 days), or **1,440 minutes** with resource data. Each mailbox allows at most 1,000 active subscriptions across all apps.
  - Message notification latency is under 1 minute on average and up to 3 minutes.
  - Lifecycle notifications warn about missed changes.
- **What this means for Aplos [I].**
  - A webhook needs a public HTTPS URL that answers Microsoft's validation handshake. A Mac behind NAT can't provide one unless it uses a relay, such as a tunnel or a tiny stateless forwarder. Even then, notifications only say "something changed", and the client still has to run delta.
  - Event Hubs and Event Grid need an Azure subscription per deployment, which is not viable per user.
  - **Recommended:** adaptive delta polling.
    - Inbox delta every 30-60 s while the window is focused, every 2-5 min in the background, and the other folders every 5-15 min.
    - An idle delta call is one request. The budget is 10,000 requests per 10 minutes per mailbox (about 16/s), so polling is cheap.
  - **Optional doorbell:** hold one IMAP connection to `outlook.office365.com` authenticated with XOAUTH2, IDLE on INBOX, and run Graph delta on `EXISTS`.
    - This needs the additional delegated scope `https://outlook.office.com/IMAP.AccessAsUser.All` ([Exchange OAuth for IMAP](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)) [D].
    - Refresh tokens are "bound to a combination of user and client, but aren't tied to a resource" ([refresh-tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)) [D]. So one sign-in can mint both Graph and Outlook IMAP access tokens, once the user has consented to both.
    - Admins can disable IMAP per user, and tenants with security defaults have IMAP off ([POP3 and IMAP4 in Exchange Online](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/pop3-and-imap4/pop3-and-imap4)) [D]. The doorbell must therefore be best-effort, with polling as the floor.

### 1.3 Throttling and batching

- **Facts [D]** ([throttling-limits, Outlook section](https://learn.microsoft.com/en-us/graph/throttling-limits)):
  - Limits apply **per app ID + mailbox**: **10,000 requests per 10 minutes**, **4 concurrent requests**, and **150 MB upload per 5 minutes**.
  - For JSON batches, Graph sends Outlook "up to four individual requests from the batch at a time". With `dependsOn`, it sends them one at a time.
  - Microsoft's guidance for parallel batches to the same mailbox is either one unordered batch at a time, or sequential (`dependsOn`) batches with up to four of them concurrently.
  - Batch limits ([json-batching](https://learn.microsoft.com/en-us/graph/json-batching)): **20 requests per batch**. Each request is evaluated separately against throttling and can fail with its own **429**. A 200 on the batch says nothing about the sub-responses.
  - Throttled responses carry `Retry-After`, and clients must wait at least that long ([throttling](https://learn.microsoft.com/en-us/graph/throttling)).
- **Design rule [I].** Model each mailbox as a semaphore of 4. An unordered batch counts as 4. Retry only the failed sub-requests, after the largest `Retry-After` among them. Put one global per-mailbox token bucket in front of every call: sync, actions, attachments and app-data.

### 1.4 Immutable IDs

- Send `Prefer: IdType="ImmutableId"` on **every** request, including delta and subscriptions. IDs then survive moves within the mailbox. They change only on a move to an archive mailbox or an export and re-import. Containers such as folders and calendars already have stable IDs ([outlook-immutable-id](https://learn.microsoft.com/en-us/graph/outlook-immutable-id)) [D].
- Delta links accept both ID formats.
- Aplos does this correctly (`microsoft.ts:161`, `:169`, `:190`) [V].

### 1.5 Public-client OAuth for desktop

- **Facts [D]** ([reply-url](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)):
  - Register under "Mobile and desktop applications", which is the platform Microsoft names for Electron.
  - `http://localhost` redirect URIs **ignore the port**.
  - `[::1]` is **not** supported as a redirect URI.
  - Microsoft prefers `127.0.0.1` to `localhost`, but an http `127.0.0.1` URI can only be added through the app manifest (`replyUrlsWithType`).
  - Apps that also sign in personal accounts can't put query parameters in the redirect URI.
- **Refresh tokens** ([refresh-tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)) [D]:
  - They last **90 days** for non-SPA apps and "replace themselves with a fresh token upon every use". Clients should store the new one and delete the old.
  - They can be revoked by a password change, by the user or admin revoking tokens, and so on.
- **MSAL Node** is Microsoft's library for Electron main processes. It runs `acquireTokenInteractive` with a loopback listener, uses a cache plugin (msal-node-extensions) for persistence, and keeps refresh tokens internal [D].
  - A third-party report (Azure SDK issue #40441) says MSAL Node v6+ defaults the loopback response to `form_post`. If so, the code stays out of the URL [S].
  - Hand-rolled PKCE, as Aplos does it, is acceptable [I]. Note that Aplos's loopback listener uses `response_mode=query` (`microsoft.ts:433`).
- **Publisher verification** ([publisher-verification-overview](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)) [D]:
  - When risk-based step-up consent is on, users can't consent to multitenant apps registered after 8 Nov 2020 that request more than basic profile scopes and are **not publisher-verified**.
  - Verification needs a Microsoft AI Cloud Partner Program account and an app registered in an Entra work tenant with a custom publisher domain.
  - This is an external prerequisite for "works for strangers' work accounts".

### 1.6 Personal (MSA) vs work (Entra) accounts

- **Tenant.** Use the `common` authority for both. `consumers` is MSA only, and `organizations` is work only. Aplos defaults to `common` (`microsoft.ts:107`) [V].
- **Identity.** On MSA, `mail` can be null, so falling back to `userPrincipalName` is correct (`microsoft.ts:439`) [V].
- **Subscriptions.** Graph change notifications for `user` are not supported for personal accounts. Message and event subscriptions are fine for both [D].
- **Consent.** Work tenants may disable user consent entirely. Then the user sees an "admin approval required" screen, and Aplos should explain that instead of a generic failure [I].
- **IMAP.** Work tenants can disable IMAP per user. Outlook.com can't [D].

### 1.7 Outlook IMAP/SMTP with XOAUTH2 as an alternative

- **Hosts and scopes [D]:**
  - IMAP: `outlook.office365.com:993`. SMTP: `smtp.office365.com:587` STARTTLS ([EXO POP/IMAP](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/pop3-and-imap4/pop3-and-imap4)). Outlook.com also uses `smtp-mail.outlook.com:587` [S].
  - Scopes are `https://outlook.office.com/IMAP.AccessAsUser.All` and `.../SMTP.Send`, with SASL XOAUTH2. Microsoft says these are "available for both Microsoft 365 ... and Outlook.com users" ([Exchange OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)).
- **Basic auth status:**
  - Outlook.com personal accounts lost Basic auth (and therefore app passwords) for IMAP/POP/SMTP on **16 Sep 2024** ([BleepingComputer](https://www.bleepingcomputer.com/news/security/microsoft-new-outlook-security-changes-coming-to-personal-accounts/), [Slipstick](https://www.slipstick.com/outlook/outlook-com-modern-authentication-questions/)) [S].
  - Exchange Online SMTP AUTH Basic: the March-April 2026 retirement was cancelled. Basic will be **disabled by default at the end of December 2026**, admins can re-enable it, and the final date will be announced in 2027 ([MC786329 mirror](https://mc.merill.net/message/MC786329), [office365itpros](https://office365itpros.com/2026/01/29/smtp-auth-basic-retirement/)) [S]. Only OAuth is safe.
- **Exchange IMAP capabilities.**
  - It reportedly advertises **no CONDSTORE/QRESYNC** ([warmbly #346](https://github.com/warmbly/warmbly/issues/346)) [S, verify live].
  - Exchange Online can take seconds to minutes to file its own Sent copy after an SMTP send. Mailspring's sync engine documents 0.5-3.5 s typically and up to ~3 min (`Mailspring-Sync/MailSync/TaskProcessor.cpp:2600-2602`, GPL-3.0) [S].
- **Verdict [I].** Graph stays the primary Outlook path: it has delta, immutable IDs, categories, rules, calendar, and a single token family. Outlook IMAP is useful only as a doorbell (§1.2), or as a fallback when a tenant blocks Graph consent but allows IMAP, which is rare.

---

## 2. IMAP: extensions, limits and a multi-folder scheduler

### 2.1 Extensions that matter, and what imapflow 2.4.3 does with them

| Extension | What it buys | imapflow 2.4.3 (`node_modules/imapflow/dist/cjs`) [V] | Aplos today |
|---|---|---|---|
| **IDLE** (RFC 2177, part of IMAP4rev2) | Push for the **selected** mailbox. Clients should re-issue IDLE "at least every 29 minutes" ([RFC 2177](https://www.rfc-editor.org/rfc/rfc2177.html)). | Auto-IDLE after `autoIdleDelay` (15 s). `maxIdleTime` restarts IDLE. `missingIdleCommand` NOOP/SELECT/STATUS fallback. | Disabled: `disableAutoIdle:true` (`imap-session.ts:71`). |
| **NOTIFY** (RFC 5465) | One connection gets events for many mailboxes. Non-selected mailboxes report via unsolicited STATUS ([RFC 5465](https://www.rfc-editor.org/rfc/rfc5465.html)). | **Not implemented** (no NOTIFY in commands). | Not used. |
| **CONDSTORE** (RFC 7162) | `HIGHESTMODSEQ` plus `FETCH ... (CHANGEDSINCE m)` gives flag deltas. | Auto-ENABLEd with UTF8=ACCEPT (`imap-flow.js:1355`). `changedSince` on fetch. | Used for flags. Expunges are still found by `UID SEARCH UID <all known>` (`imap.ts:287-289`). |
| **QRESYNC** (RFC 7162) | `SELECT ... (QRESYNC (uidvalidity modseq known-uids))` returns flag changes **and** `VANISHED (EARLIER)` in one round trip ([RFC 7162](https://www.rfc-editor.org/rfc/rfc7162.html)). Requires `ENABLE QRESYNC`. | Opt-in `qresync: true`. `getMailboxLock({changedSince, uidValidity})` emits `flags`/`expunge` events with UIDs. | Not enabled. |
| **COMPRESS=DEFLATE** (RFC 4978) | Much less traffic on text-heavy header and body fetches (no measured figure here). | Automatic unless `disableCompression` (`imap-flow.js:1342`). | On by default [V]. |
| **MOVE / UIDPLUS** (RFC 6851 / 4315) | Atomic move, COPYUID/APPENDUID, safe `UID EXPUNGE`. | Supported. | Used correctly. Falls back to COPY + `\Deleted` without expunging other clients' deletions (`imap-session.ts:108-121`). |
| **SPECIAL-USE** (RFC 6154) | Role folders (`\Sent \Trash \Junk \Archive \All \Drafts`). | Parsed, with localized-name hints. | Used, with English/iCloud name fallbacks (`imap.ts:169-180`). Drafts are not mapped. |
| **ESEARCH / PARTIAL** (RFC 4731 / 9394) | Counts, min/max and paged results without huge UID lists. | `returnOptions` incl. `partial`. | Not used. |
| **OBJECTID** (RFC 8474) | Stable EMAILID/THREADID across moves (Fastmail, Yahoo). | `emailId`/`threadId` when advertised. | Not used. Aplos re-finds moved mail by Message-ID search. |
| **LIST-STATUS** (RFC 5819) | STATUS for all folders in one LIST. | `statusQuery` option. | Not used. |
| **MESSAGELIMIT** (RFC 9738) | The server caps messages per command. Results above the cap are partial, highest UIDs first, with `[MESSAGELIMIT N lastUID]` ([RFC 9738](https://www.rfc-editor.org/rfc/rfc9738.html)). | Not specifically handled [I]. | Not handled (see defect I5). |
| **XOAUTH2 / OAUTHBEARER** | OAuth login. | `auth.accessToken`, preferring OAUTHBEARER (`commands/authenticate.js:40-66`). | Password only (`imap-session.ts:70`). |
| **Throttling hints** | The Office 365 BAD "Request is throttled. Suggested Backoff Time" message, `ETHROTTLE`. | Parsed and waited out, capped at 5 min (`imap-flow.js:1086-1091`, `:69`). | `ETHROTTLE` mapped to a 429 message (`imap.ts:96`). |

**Version note [V].** The installed imapflow is 2.4.3 (2026-10-15). The latest on npm is **2.9.1** (2026-10-22). The EmailEngine report recommends 2.9.x for bounded hostile-server buffering and IDLE lifecycle fixes (`research/email-clients/arch/emailengine.md:277`).

### 2.2 Provider facts relevant to connections

| Provider | Hosts / auth | Connection and bandwidth limits | Notable quirks |
|---|---|---|---|
| **Gmail (IMAP)** | `imap.gmail.com`, OAuth or app password | "up to 15 email clients at a time per account" ([Gmail Help](https://support.google.com/mail/answer/7126229)). IMAP download **2,500 MB/day**, upload 500 MB/day, suspension 1-24 h ([bandwidth limits](https://support.google.com/a/answer/1071518)). [D] | Not Aplos's Gmail path (Aplos uses REST). The full-mail scope is restricted anyway (Delta Chat report). |
| **iCloud** | `imap.mail.me.com:993` TLS. `smtp.mail.me.com:587` STARTTLS. **App-specific password** ([Apple 102525](https://support.apple.com/en-us/102525)) [D] | Not documented. One secondary source says about 5 connections [S]. Some users see "too many connections" as timeouts [S]. | IMAP login is "usually" the name part only, with the full address as fallback. SMTP login must be the full address [D]. No POP [D]. QRESYNC reported broken: no `* ENABLED`, and FETCH with sequence -1 after `SELECT (QRESYNC ...)` ([Apple forum 694251](https://developer.apple.com/forums/thread/694251), Thunderbird maintainer, 2021). Mailspring still disables it for iCloud (`SyncWorker.cpp:409-416`) [S]. `UID FETCH n:*` returns nothing when n > max UID, against RFC 3501 [S]. SMTP sends are **not** filed in Sent [S]. Aplos appends correctly (`imap.ts:505-513`). |
| **Yahoo / AOL** | `imap.mail.yahoo.com`/`imap.aol.com`. App password, or OAUTHBEARER with Yahoo's approval process ([Yahoo IMAP docs](https://senders.yahooinc.com/developer/documentation/)) [D] | Not documented. `MESSAGELIMIT=1000` in the doc example. An older Yahoo PDF also shows 500 [D/S]. | Default "Limited Mode" exposes only a partial view of large folders. `ENABLE UIDONLY` unlocks full access but makes sequence-number requests fail. **"IDLE responses include only new messages and updates. Message deletes or EXPUNGE will not be available."** Advertises CONDSTORE, QRESYNC, OBJECTID and an experimental All Mail folder [D]. EmailEngine uses a 3-minute IDLE restart for Yahoo (prior report) [S]. |
| **Fastmail** | `imap.fastmail.com:993`, `smtp.fastmail.com:465` (587 STARTTLS). **App password**. Basic plans have no IMAP/SMTP/DAV ([Fastmail server names](https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports)) [D] | Not documented. | Prefer JMAP (§3). Does not file SMTP sends in Sent by default (Mailspring note) [S]. |
| **Outlook / M365 (IMAP)** | XOAUTH2 only for Outlook.com. Tenant-dependent for M365 (§1.7). | Not documented here [I]. | No CONDSTORE [S]. Late Sent copies [S]. |

### 2.3 Best practice for a multi-folder IMAP scheduler

This builds on the prior Mailspring, Geary, Delta Chat and EmailEngine reports; their design points are not repeated here.

1. **Two connections per account, three at most.**
   - Connection A sits on INBOX in IDLE. Restart IDLE every 25 min by default, or sooner per host (Yahoo about 3 min) via imapflow `maxIdleTime`.
   - Connection B runs a **priority queue**: user actions and outbox first, then incremental folder sync, then backfill and bodies.
   - Never hold B for a whole multi-folder sync. Release between folders so a user action can jump in.
   - With a phone also on the account, three connections per device risks iCloud's undocumented cap [I].
2. **Detect "nothing changed" cheaply.**
   - For non-INBOX folders, compare `STATUS (UIDNEXT UIDVALIDITY MESSAGES HIGHESTMODSEQ)`, or a single `LIST ... RETURN (STATUS ...)` where LIST-STATUS exists.
   - Only SELECT folders whose numbers moved. Don't STATUS the currently selected mailbox (RFC 3501 advice) [I].
   - NOTIFY would be better, but imapflow lacks it [V].
3. **Pick the incremental path by capability.**
   - **QRESYNC** (except iCloud) gives one SELECT with known UIDs, which returns changed flags plus VANISHED.
   - Else **CONDSTORE** uses `CHANGEDSINCE` for flags plus a *bounded* expunge check: `UID SEARCH` over the cached window in chunks below `MESSAGELIMIT`, or ESEARCH COUNT/MIN to skip unchanged ranges.
   - Else a windowed flag scan over the newest N UIDs, plus a slower deep scan. Mailspring scans the top 400 UIDs every 2 min and does a deep scan every 10 min, per the prior report.
4. **Bound every range by count and bytes.**
   - New-mail catch-up after a long offline gap should fetch envelopes for the newest K UIDs first, record a "gap" cursor, and backfill the rest in the background.
   - Never fetch `BODY[]` for list display. Fetch `ENVELOPE BODYSTRUCTURE FLAGS INTERNALDATE RFC822.SIZE` plus selected headers (List-Unsubscribe, References), then text parts on demand or for a recent-window prefetch, and attachments only on open.
5. **Respect `MESSAGELIMIT`.** Read it after authentication and chunk every SEARCH/FETCH/STORE below it. Treat `[MESSAGELIMIT ...]` as "partial", never as "absent" ([RFC 9738](https://www.rfc-editor.org/rfc/rfc9738.html)).
6. **Use a per-account byte budget.** Gmail's 2,500 MB/day download is a useful conservative reference [D]. Size first sync and prefetch to stay far below it.
7. **Checkpoint per folder per batch.** A failure resumes from the last committed UID, not from zero (council weakness 2).
8. **Handle wake and network changes.** On macOS resume or a network change, drop sockets, reconnect with jitter, re-SELECT with QRESYNC/CONDSTORE and restart IDLE. Delta Chat's interrupt channel is the model (prior report).
9. **Separate errors by class.**
   - **Auth:** stop and show reconnect.
   - **Throttle:** honor the server hint (imapflow already parses Office 365's), otherwise back off exponentially with jitter.
   - **Transient network:** back off.
   - **Permanent:** surface the server text.

---

## 3. JMAP (RFC 8620/8621) and Fastmail

### 3.1 Protocol facts [D]

- **Session object** ([RFC 8620 §2](https://www.rfc-editor.org/rfc/rfc8620.html)):
  - It carries `apiUrl`, `downloadUrl` (template with `accountId`, `blobId`, `type`, `name`), `uploadUrl` and `eventSourceUrl` (template with `types`, `closeafter`, `ping`).
  - It also carries limits: `maxConcurrentRequests` (suggested min 4), `maxCallsInRequest` (16), `maxObjectsInGet` (500) and `maxConcurrentUpload` (4).
  - A response's `sessionState` that differs from the cached one means the session should be refetched.
- **/changes** (§5.2):
  - `maxChanges` caps the number of IDs returned. `hasMoreChanges` means call again with `newState`.
  - On `cannotCalculateChanges` the client **MUST invalidate** its cache.
  - Servers SHOULD keep 30 days of change history.
- **/queryChanges** (§5.6) updates a cached query result (`added`/`removed` with indexes; `upToId` limits work). Support depends on the query (`canCalculateChanges`). It is what makes a "window of the newest N threads" maintainable without refetching.
- **Push** (§7):
  - A `StateChange` maps account ID to `{TypeName: state}`.
  - EventSource is `GET eventSourceUrl` with `types=*` or a list, `closeafter=state|no` and `ping=<seconds>` (servers must accept 30-300). Dropped events are harmless, because the client then calls /changes.
  - **WebSocket** ([RFC 8887](https://www.rfc-editor.org/rfc/rfc8887.html)) is the `urn:ietf:params:jmap:websocket` capability with `url` and `supportsPush`. `WebSocketPushEnable{dataTypes, pushState}` multiplexes API calls and push on one authenticated connection.
- **Blob download** (§6.2) is immutable and cacheable for a year. **Mail-specific** ([RFC 8621](https://www.rfc-editor.org/rfc/rfc8621.html)):
  - `header:List-Unsubscribe:asURLs` returns parsed unsubscribe URLs.
  - `maxBodyValueBytes` truncates body values to valid UTF-8 and sets `isTruncated`.
  - `preview` (256 characters or fewer) is the fast list-view property. Body properties are slower, and clients "SHOULD take care" fetching them.
  - `Mailbox/changes` `updatedProperties` signals count-only changes.

### 3.2 Fastmail specifics [D]

- **Session URL:** `https://api.fastmail.com/jmap/session` ([fastmail.com/dev](https://www.fastmail.com/dev/)).
- **Auth:** API tokens are for testing and personal projects. "If you are building an app to distribute to others, you should implement OAuth". That is Authorization Code + PKCE (S256), with client registration done manually by contacting Fastmail, and "You can use OAuth with all of our supported protocols".
- **Scopes:** core, mail, submission, contacts, vacation response and masked email.
- **Calendars** are **not** in JMAP yet; use CalDAV at `https://caldav.fastmail.com/`. CardDAV is at `https://carddav.fastmail.com/`, or use JMAP Contacts.
- **Push:** published session examples show `eventSourceUrl: https://api.fastmail.com/jmap/event/` and no websocket capability ([JMAP crash course](https://jmap.io/crash-course/)) [S]. Check the live session for `urn:ietf:params:jmap:websocket` before relying on either.

---

## 4. CalDAV / CardDAV

### 4.1 Efficient sync [D]

- **WebDAV Sync** ([RFC 6578](https://www.rfc-editor.org/rfc/rfc6578.html)):
  - Send a `REPORT` with `DAV:sync-collection` (`sync-token`, `sync-level` 1, `prop` getetag) and Depth 0. An empty token means a full listing.
  - Changed members come back with propstat 200, and removed members with a single `404` status.
  - The server may truncate with **507 on the request-URI** plus a valid token for paging.
  - An invalid token triggers the `DAV:valid-sync-token` precondition. The client then re-syncs with an empty token, but needn't re-download resources whose ETags are unchanged.
  - The collection's `DAV:sync-token` property can be read by PROPFIND.
- **CTag** (`CS:getctag`, Apple CalendarServer namespace `http://calendarserver.org/ns/`) is the older "has anything changed" property. One Depth-1 PROPFIND on the calendar home returns every calendar's ctag or sync-token, so a quiet account costs one request per poll [I, widely used pattern].
- **Steady-state loop [I]:**
  1. PROPFIND the home (ctag and sync-token per calendar).
  2. For changed calendars, run sync-collection.
  3. Run `calendar-multiget` for the changed hrefs.
  4. Store whole resources (master plus overrides) keyed by href and ETag.
  5. **Expand recurrences on the client** for the visible range.
  6. Servers without sync-token fall back to `calendar-query` with getetag only, plus multiget of changed ETags.

### 4.2 Server quirks

- **iCloud** (python-caldav compatibility table, measured 2026-10-14, Apache-2.0) [S]:
  - Discovery starts at `caldav.icloud.com`.
  - `propfind.principal-depth-1` is unsupported (HTTP 400), so use Depth 0 for the principal.
  - `If-Match: *` behaves backwards.
  - `DAV:limit` on sync-collection is ignored. That implies sync-token itself works.
  - An event PUT without DTEND is refused with 404/403.
  - Tasks need their own calendar.
  - There is no Schedule-Tag.
  - Its recurrence note says recurring events were "found and expanded". A different third-party project reports iCloud returning unexpanded series ([icloud-calendar-mcp PR #2](https://github.com/retogo/icloud-calendar-mcp/pull/2)) [S].
  - Treat server expansion as unreliable [I]. The principal and home URLs live on partition hosts such as `pNN-caldav.icloud.com` [I, from memory, consistent with Aplos following hrefs].
- **Fastmail** uses CalDAV/CardDAV with an app password, or OAuth for registered apps [D]. python-caldav's historical notes list a Fastmail date-search bug with no expansion (commented out, so possibly stale) [S].
- **General:** python-caldav 2.0+ expands on the client by default because "many server[s]" don't honor expand [S].

---

## 5. iCloud Mail summary

- **IMAP only (no POP, no JMAP, no OAuth for third parties). Use an app-specific password, which requires two-factor authentication on the Apple Account** [D].
- **Usernames:**
  - IMAP login: "usually the name part", with the full address as fallback.
  - SMTP login: the full address [D].
  - Custom-domain iCloud+ users sign in with their Apple ID mail address rather than the custom alias [I, consistent with Apple's "name part of your iCloud Mail address" guidance]. Aplos's preset form should say so.
- **Folders:** Sent Messages, Deleted Messages, Junk and Archive. Aplos's name fallbacks cover them (`imap.ts:176`) [V].
- **Capability strategy:** CONDSTORE, not QRESYNC [S]. Tolerate the `UID FETCH n:*` deviation; Aplos already filters `u >= n` (`imap.ts:283`) [V]. IDLE is supported.
- **Sent copies:** append your own after SMTP, which Aplos already does with no delay for iCloud (`imap.ts:505-513`) [V].
- **Connections:** keep 2 or fewer per account [I].
- **Calendar and contacts:** CalDAV via `caldav.icloud.com` and CardDAV via `contacts.icloud.com` [I], using the same app-specific password.

---

## 6. Audit of the Aplos adapters

### 6.1 `main/microsoft.ts` (Graph)

**What's right [V]:**
- Immutable IDs on every call (`:161`).
- Per-folder delta with `odata.maxpagesize` (`:250`).
- Refresh-token rotation is preserved (`:155-156`), and refresh calls are de-duplicated per account (`:150-159`).
- A cross-host credential guard (`:162-165`).
- An idempotent send: the MIME Message-ID is used as `internetMessageId`, and `findSent` checks it afterwards (`:504-513`).
- Folder status from well-known folders.
- A loopback listener on both 127.0.0.1 and ::1, with a `localhost` redirect (`:425-430`).
- Delta 410 (`syncStateNotFound`) falls back to a fresh window (`:120`, `:454`).

**Defects and gaps:**

- **M1. Concurrency and 429.**
  - `batch()` runs chunks through `pool(chunks, 3, ...)` (`:189`). Each unordered chunk runs up to 4 sub-requests in parallel on Microsoft's side [D]. Separately, `pool(responses, 4, ...)` follows `@odata.nextLink`s (`:220`, `:224`).
  - Peak in-flight load is about 12 or more against a 4-per-mailbox limit.
  - Any sub-request 429 or 5xx makes `ok()` throw (`:198`, `:238`). The whole sync fails, the index is not saved, and the gate retries from scratch after 30 s (`engine/gate.ts:30`).
  - `Retry-After` is only formatted into the message (`:125`).
  - First sync touches roughly 500 messages, about 300 conversation queries, plus attachment listings and inline bodies. That is plenty to trip the limit [I].
- **M2. Filtered delta.** `freshWindow` starts each folder's delta with `receivedDateTime ge cutoff` (`:263-266`). Because Graph bakes options into the deltaLink [D], older messages entering Inbox later are likely invisible until the next reset [I]. A real mailbox will hit this quickly (unarchive or restore on another device).
- **M3. Only 5 folders are tracked** (`:36`). Mail that server rules file into custom folders never appears. A message moved from Inbox to a custom folder shows as "done" (folder `''`). This may be acceptable as a product choice, but it should be explicit [I].
- **M4. No checkpointing.**
  - `freshWindow` must finish every folder plus `fullThreads` in one run. Anything over 50 delta pages per folder throws "more mail than expected" (`:267`).
  - Incremental runs return `undefined` after 50 pages, which forces a full fresh window (`:290`).
- **M5. Bodies, attachment lists and inline images are fetched for every conversation at sync time** (`:217-246`) rather than lazily. The list view only needs `bodyPreview`.
- **M6. Auth diagnostics.**
  - `tokenRequest` turns every 400 or 401 into "authorization expired" (`:142-143`). That discards the AADSTS code: consent required, interaction required (Conditional Access or MFA), and so on.
  - The granted `scope` in the token response is never checked.
  - There is no handling for "admin approval required".
  - Publisher verification is an external prerequisite for work tenants [D].
- **M7. Send size.** Messages are capped at about 3 MB raw by refusing anything over 3.9 MB base64 (`:30`, `:508`). Graph supports up to 150 MB per attachment via draft + `createUploadSession` + send [D] ([outlook-large-attachments](https://learn.microsoft.com/en-us/graph/outlook-large-attachments)). A 150 MB-per-5-minute upload budget also applies [D].
- **M8. Calendar** re-reads every calendar's `calendarView` across −30 to +365 days each time (`:523-531`) instead of `calendarView/delta` per calendar [D].
- **M9. Missing capabilities:**
  - Drafts are dropped from sync (`:70`, `:269`), and there is no Outlook draft round-trip.
  - No `internetMessageHeaders` / List-Unsubscribe.
  - No `messageRules` (server-side rules that run while the Mac sleeps; noted in the prior synthesis).
  - No categories, no Focused Inbox write-back, and no shared mailboxes.
- **M10. Minor:**
  - `response_mode=query` (`:433`). `form_post` keeps the code out of URLs and logs [I].
  - The whole message index is one JSON key, re-parsed on every action (`:96-97`, `:202`; already noted in the prior audit).

### 6.2 `main/imap.ts`, `imap-session.ts`, `imap-index.ts`

**What's right [V]:**
- UIDVALIDITY handling (`:277-282`).
- CONDSTORE `changedSince` (`:287-288`).
- MOVE/UIDPLUS with a careful non-UIDPLUS fallback that never runs a bare EXPUNGE (`imap-session.ts:108-121`).
- SPECIAL-USE plus localized fallbacks.
- SMTP error classes that separate "definitely not sent" from "uncertain" (`imap.ts:104-113`).
- The Sent-copy append with duplicate check.
- Large messages are read part by part (`:222-229`).
- Hidden app-data folder marked by header.

**Defects and gaps:**

- **I1. No push, one serialized connection.**
  - `disableAutoIdle: true` (`imap-session.ts:71`).
  - All work is chained through `locked()` (`imap.ts:143`), and `sync` holds the lock for all 5 folders plus `build` (`:418-436`). So archive, flag, attachment open and the Sent-copy append wait behind a first sync.
  - The 60 s idle close (`:132`) equals the 60 s poll (`engine/service.ts:958`). Whether the socket survives between polls depends on timing, so TLS + LOGIN may repeat every minute [I].
- **I2. Whole-message download at sync time.** `build` fetches `BODY[]` for every message of 1 MB or less in 50-UID batches (`:239-242`). A first sync covers up to 500 inbox + 250 sent + 250 archive + 100 trash + 100 junk = 1,200 messages, so it can download hundreds of MB before showing anything [I].
- **I3. Unbounded catch-up.** `metas(... \`${previous.n}:*\`)` (`:283`) fetches headers for every new UID since the last cursor, then `build` downloads them all. A week offline on a busy account means one huge, all-or-nothing round. There is no per-batch checkpoint.
- **I4. Expunge detection is O(known UIDs) every poll.**
  - The CONDSTORE path sends `UID SEARCH UID <all known>` per folder (`:289`).
  - Without CONDSTORE, it sends `FETCH FLAGS` for all known UIDs (`:290`).
  - QRESYNC would make this one round trip [D].
  - The folder UID map is re-parsed and re-stringified per write (`imap-index.ts:51-55`, `:63-67`). That is O(n²) per sync (prior audit, re-confirmed).
- **I5. False-deletion risk under MESSAGELIMIT.** Any UID absent from the SEARCH or FETCH answer is dropped (`:298`). On a server returning partial results per RFC 9738 (Yahoo advertises 1000; one Yahoo doc shows 500), the oldest copies would be removed from Aplos as deleted [I]. The current windows (≤500 per folder) keep this latent, but search, backfill and larger windows would expose it.
- **I6. No OAuth.**
  - `auth: {user, pass}` only (`imap-session.ts:70`), though imapflow supports `accessToken` [V].
  - This rules out Outlook IMAP (Basic auth gone, §1.7), Yahoo/AOL OAuth, and Fastmail OAuth over IMAP or DAV.
- **I7. iCloud preset.** It uses the full address for IMAP and SMTP (`:138`). That is fine, since Apple allows it as a fallback. But the help text doesn't tell custom-domain users which address to use (`:28`).
- **I8. Yahoo-specific:**
  - IDLE won't report expunges [D], so a periodic CONDSTORE/QRESYNC resync is required even after IDLE is added.
  - Limited Mode means large folders are partially visible. The first inbox window by sequence (`:270`) is fine.
- **I9. Missing capabilities:**
  - No `\Answered`/`$Forwarded` on reply or forward.
  - No `$Junk`/`$NotJunk` keywords.
  - No Drafts APPEND (drafts invisible to other clients).
  - No List-Unsubscribe header fetch: `HEADER_FIELDS` lacks it (`imap-session.ts:58`).
  - No OBJECTID use. Search covers Inbox and Archive only (`imap.ts:441`).
  - No ESEARCH or LIST-STATUS.
- **I10. Outdated library.** imapflow 2.4.3, while 2.9.1 is current [V].

### 6.3 `main/jmap.ts`

**What's right [V]:**
- Proper `Email/changes` + `Thread/changes` paging with `cannotCalculateChanges` → fresh window (`:273-288`).
- States captured **before** the first window query and replayed (`:251-255`, `:263-271`).
- Idempotent submission via Message-ID lookup plus `EmailSubmission/set` with `onSuccessUpdateEmail` (`:459-503`).
- `sessionState` change marks the session stale (`:162`).
- Cross-origin redirects drop `Authorization` (`:118-121`).
- Identities, aliases and signatures (`:322-335`).

**Defects and gaps:**

- **J1. No push.** `loadSession` reads `apiUrl`, `downloadUrl` and `uploadUrl` but not `eventSourceUrl` or the websocket capability (`:139-148`). Fastmail push is free and needs no server.
- **J2. Rate limits.**
  - HTTP 429 is turned into a message with no `Retry-After` (`:128`).
  - `maxConcurrentRequests` is ignored. The concurrency of 3 in `each` (`:60-64`) is under the RFC's suggested minimum of 4, so this is minor today, but it should come from the session.
  - `rateLimit` SetErrors are not retried.
- **J3. Heavy first sync.** Up to 500 threads are fetched with full `textBody`/`htmlBody`/`bodyValues` up to 1 MB each for **every email in every thread** (`:43-44`, `:227-231`, `:264`). `preview` exists for this purpose [D]. Bodies should be lazy or limited to recent mail.
- **J4. No `Email/queryChanges`.** The "newest 500" window is not maintained as a query. New threads are only added via `/changes` when they're in the inbox (`:302`, `:313`), which is acceptable, but older threads that become relevant are never discovered [I].
- **J5. Auth for distribution.** API tokens are documented as for personal and testing use [D]. Distributing Aplos to Fastmail users needs a Fastmail OAuth client (an external prerequisite: contact Fastmail).
- **J6. Calendar and contacts.** `calendar: false` (`:23`) is correct for API tokens. With OAuth, Fastmail CalDAV and CardDAV (or JMAP Contacts) become reachable under one grant [D].
- **J7. Missing:** `header:List-Unsubscribe:asURLs`, draft sync (drafts are hidden by `visible`, `:194`), `Mailbox/changes`, and blob caching.

### 6.4 `main/caldav.ts`

**What's right [V]:**
- RFC 6764-style discovery with a `.well-known` fallback (`:91-97`), with home and principal hrefs resolved against the answering host (iCloud partition hosts).
- HTTPS-only credential sends.
- `If-None-Match: *` on create and `If-Match` on update (`:186`, `:192`).
- It refuses to edit recurring series and scheduled meetings rather than corrupting them (`:146-160`).
- Apple `calendar-color` support.
- Writable detection from `current-user-privilege-set`.

**Defects and gaps:**

- **C1. No incremental sync.** No sync-token, no ctag. Every 10 minutes (`engine/service.ts:23`, `:599-604`) it runs a full expanded `calendar-query` over 13 months for every calendar, all in parallel through `Promise.all` (`caldav.ts:169`).
- **C2. Recurrence relies on server `<C:expand>`** (`:168`). `ical.ts` has no RRULE expansion for events: the only RRULE handling is for VTIMEZONE observances (`ical.ts:121`). On servers that ignore expand [S], recurring events show only at their master DTSTART [I].
- **C3. Credentials forwarded across origins.** `request()` follows 301/302/307/308 to any HTTPS URL with the same `Authorization: Basic` header (`:45-53`). The JMAP adapter strips auth cross-origin; this one doesn't. A compromised or misconfigured CalDAV host could redirect the app password elsewhere. Restrict it to the same registrable domain, or re-prompt [I].
- **C4. Missing:** CardDAV (contacts), VTODO, RSVP/scheduling, alarms, free/busy (`freebusy-query` 400 on iCloud [S]), and recurring-series edits.

### 6.5 Cross-cutting (engine)

- **X1.** The gate's backoff (30 s doubling to 15 min, `engine/gate.ts:15`, `:30`) ignores provider `Retry-After` hints for Graph, JMAP and IMAP.
- **X2.** Accounts sync serially (`engine/service.ts:676`). One slow IMAP first sync delays every other account's 60 s poll (prior audit).
- **X3.** There is no per-provider request scheduler (priority, budget, in-flight cap) shared by sync and user actions. Each adapter invents its own pools.

---

## 7. Prioritized defect list for the Aplos adapters

Severity: **P0** = will break or corrupt on real mailboxes. **P1** = serious reliability or performance problem. **P2** = missing capability or hardening.

| # | Sev | Adapter | Defect | Fix |
|---|---|---|---|---|
| 1 | P0 | Graph | M1: about 12 or more concurrent requests against a 4-per-mailbox limit. Sub-request 429/5xx fails the whole sync, and `Retry-After` is ignored. | A per-mailbox scheduler: ≤4 in flight, an unordered batch counts as 4 (or use `dependsOn` batches). Retry failed sub-requests after the max `Retry-After`. Add a token bucket against 10k per 10 min. |
| 2 | P0 | Graph | M2: delta started with `$filter receivedDateTime ge cutoff`, so older mail re-entering folders is likely never seen. | Fetch the visible window with a normal list query. Run an **unfiltered**, light-`$select` delta per folder in the background with persisted nextLink checkpoints. Verify live (open question 1). |
| 3 | P0 | IMAP | I1: one serialized connection, no IDLE. Actions and sends block behind sync. | Connection A on INBOX with imapflow auto-IDLE (`maxIdleTime` ≤25 min, host table). Connection B as a priority command queue that releases between folders. |
| 4 | P0 | IMAP | I2/I3: whole `BODY[]` at sync, unbounded `uidNext:*` catch-up, no checkpoint. | Envelope + BODYSTRUCTURE first. Text parts for a recent window, the rest on open. Cap catch-up to the newest K with a gap cursor. Commit per batch. |
| 5 | P1 | IMAP | I5: missing UIDs treated as deleted; unsafe under RFC 9738 MESSAGELIMIT (Yahoo). | Read MESSAGELIMIT. Chunk below it. Detect `[MESSAGELIMIT]` and never infer deletion from a partial answer. Prefer QRESYNC VANISHED (not on iCloud). |
| 6 | P1 | IMAP | I4: O(n) expunge scan every poll; O(n²) index writes. | Enable `qresync` where it's sound (not iCloud). STATUS/LIST-STATUS to skip unchanged folders. Index the folder map as rows, not one JSON blob. |
| 7 | P1 | JMAP | J1/J3: no EventSource/WebSocket push; full bodies for 500 threads on first sync. | One EventSource per account (`types=Email,Mailbox,Thread,EmailDelivery`, `closeafter=no`, ping ≤60 s) → `/changes`. Fetch `preview` for lists; bodies lazy or recent-only. |
| 8 | P1 | CalDAV | C1/C2: full 13-month expanded query of every calendar every 10 min, in parallel; recurrence depends on server expand. | Home PROPFIND (ctag/sync-token) → sync-collection → multiget. Store master resources. Expand RRULE/EXDATE/overrides client-side. Limit concurrency to 2. |
| 9 | P1 | CalDAV | C3: Basic credentials follow cross-origin redirects. | Same-registrable-domain redirects only (allows `caldav.icloud.com` → `pNN-caldav.icloud.com`); otherwise fail with an explanation. |
| 10 | P1 | Graph | M4/M5: no checkpoints; full bodies, attachment lists and inline images fetched at sync. | Persist delta nextLinks mid-round. Metadata first. Bodies and attachments on open plus a recent prefetch. |
| 11 | P1 | Graph | M6: AADSTS reasons discarded; scopes unchecked; publisher verification pending. | Log and display `error`/`error_description` codes. Compare granted `scope`. Map `interaction_required` and consent-required to specific UI. Start CPP publisher verification. |
| 12 | P1 | Engine | X1/X2/X3: Retry-After ignored by the gate; serial accounts; no shared scheduler. | A per-account actor with priority lanes and a provider budget. Accounts run concurrently. The gate respects server hints. |
| 13 | P2 | IMAP | I6: no XOAUTH2/OAUTHBEARER. | Pass `accessToken` through `ImapLogin`. Needed for the Outlook doorbell, Yahoo/AOL OAuth and Fastmail OAuth. |
| 14 | P2 | JMAP | J5: API tokens only. | Apply for a Fastmail OAuth client. Keep the token path as a power-user option. |
| 15 | P2 | Graph | M7/M8: 3 MB send cap; calendar re-read in full. | Draft + upload sessions (≤150 MB, ≤4 MB chunks). `calendarView/delta` per calendar with a rolling window. |
| 16 | P2 | All | No List-Unsubscribe headers; no draft round-trip; no `\Answered`; no server-side rules; no CardDAV. | Graph `internetMessageHeaders`; IMAP header fetch; JMAP `header:List-Unsubscribe:asURLs`. Drafts folder APPEND / JMAP `$draft` / Graph drafts. Graph `messageRules`, JMAP Sieve. CardDAV / JMAP Contacts. |
| 17 | P2 | IMAP | I7/I8: iCloud custom-domain username hint; Yahoo IDLE lacks expunges. | Update the preset copy. Run a periodic resync for Yahoo even with IDLE. |
| 18 | P2 | IMAP | I10: imapflow 2.4.3 vs 2.9.1. | Upgrade, after reading the changelog for IDLE and lock behavior changes. |

---

## 8. Recommended connectivity design per provider

This assumes the planned **local daemon** (headless engine on the Mac, Electron UI and later a phone as clients). The daemon owns every provider connection. Clients never talk to providers directly. That keeps the per-account connection budget fixed however many UIs are attached [I].

**Common core [I].** Each account is an actor with:

- **Lanes, in priority order:**
  1. user actions and outbox
  2. push-triggered incremental sync
  3. scheduled incremental sync
  4. body and attachment prefetch
  5. backfill
  6. AI enrichment, in its own budgeted queue, off the sync path
- **A provider budget object.** Graph: 4 in flight and 10k/10 min. IMAP: 2 connections, MESSAGELIMIT and a daily byte budget. JMAP: `maxConcurrentRequests`. CalDAV: 2 in flight.
- **Persisted cursors and checkpoints per folder or collection.**
- **Error classes:** auth, throttle (honor hints), transient (jittered backoff) and permanent.
- **Wake and network handling:** OS resume or a network change interrupts every wait and reconnects.

| Provider | Auth | Mail sync | Change signal | Calendar / contacts | Notes |
|---|---|---|---|---|---|
| **Outlook.com / M365** | Entra public client, PKCE, loopback `http://localhost` (or manifest-added `127.0.0.1`), `common` authority. Store every rotated RT. Scopes as today, plus optional `IMAP.AccessAsUser.All` for the doorbell. Get publisher verification. | Graph per-folder delta, unfiltered, light `$select`, resumable. Window via a list query. Immutable IDs. Bodies lazy. Batches ≤20 with ≤4 in flight. | Adaptive delta polling: inbox every 30-60 s when focused, 2-5 min in the background. Optional XOAUTH2 IMAP IDLE doorbell on INBOX. Webhooks only behind a future relay; subscriptions expire in under 7 days. | `calendarView/delta` per calendar (rolling 13 months). Contacts via Graph `/me/contacts` delta (future). | Server-side automation via `messageRules`. Large attachments via upload sessions. |
| **iCloud** | App-specific password. Same secret for IMAP, SMTP, CalDAV and CardDAV. Clear username guidance. | IMAP with CONDSTORE (QRESYNC off). Envelope-first, bounded windows, STATUS skip for non-INBOX folders. | Connection A: IDLE on INBOX (restart ≤25 min). Connection B: commands and folder rotation every 2-5 min. | CalDAV sync-collection with client-side expansion. CardDAV for contacts. | Append Sent copies after SMTP (keep). Stay at 2 or fewer connections. Tolerate `n:*` quirks. |
| **Fastmail** | OAuth (register with Fastmail) or an API token for the owner. CalDAV/CardDAV via OAuth, or an app password with tokens. | JMAP `/changes` + `Email/queryChanges` for the window. `preview` for lists. Bodies lazy. | EventSource on `eventSourceUrl`, or RFC 8887 WebSocket if the live session advertises it. Poll `/changes` every 60 s as a floor. | CalDAV `caldav.fastmail.com` (calendars not in JMAP yet). JMAP Contacts or CardDAV. | Masked Email and Sieve are possible later. |
| **Yahoo / AOL** | App password (OAuth needs Yahoo approval). | IMAP with QRESYNC/CONDSTORE as advertised. Every command chunked below MESSAGELIMIT. Consider OBJECTID for move tracking. | IDLE on INBOX (restart about 3 min). Periodic resync, because IDLE omits expunges. | None offered via standard DAV in Aplos today. | Limited Mode means large folders are partial. Don't ENABLE UIDONLY without testing. |
| **Generic IMAP / SMTP** | Password or app password. XOAUTH2/OAUTHBEARER where the host supports it. | Capability-driven: QRESYNC > CONDSTORE > windowed flag scans. COMPRESS automatic. MOVE/UIDPLUS. SPECIAL-USE plus name fallbacks. | IDLE on INBOX; NOOP or STATUS polling if absent. NOTIFY would be ideal, but imapflow lacks it. | CalDAV/CardDAV from autoconfig or `.well-known` if provided. | Learn the IDLE timeout per host (EmailEngine pattern). Detect late server Sent copies before appending. |
| **Outlook via IMAP (fallback only)** | XOAUTH2 tokens from the same Entra app. | Windowed flag scans (no CONDSTORE [S]). | IDLE. | Use Graph. | Exchange files Sent copies late (up to about 3 min [S]), so don't double-append. SMTP Basic is going away. |

**Local server and phone [I].**

- The daemon can keep IMAP IDLE, JMAP EventSource and Graph polling alive while windows are closed and the Mac is awake. It can't while the Mac sleeps. Only a server can, and that's what Graph webhooks and Gmail Pub/Sub assume.
- A phone on the LAN, or through a relay, should read from the daemon's store and send commands through the daemon's outbox. Then iCloud and Yahoo connection caps and Graph's 4-concurrency budget aren't split across devices.
- If phone-while-Mac-asleep matters, the only no-server mitigations are provider-side rules (Graph `messageRules`, Fastmail Sieve) and letting the phone fall back to direct provider access with its own small budget.

---

## 9. Open questions

1. Does Graph message delta accept a "start from now" token, or must the first unfiltered round enumerate the whole folder? This decides how expensive the M2 fix is for 50k-message inboxes. **Test live.**
2. Does a filtered message deltaLink really suppress older items moved into the folder? This is inferred from Microsoft's "options are encoded" statement. **Verify with a test mailbox before building the fix.**
3. What are iCloud's real IMAP connection cap and its current QRESYNC behavior? The Apple forum evidence is from 2021, and Mailspring still disables QRESYNC.
4. Is Yahoo's production MESSAGELIMIT 500 or 1000, and is it enforced or soft?
5. Does Fastmail's live session advertise `urn:ietf:params:jmap:websocket`? How long does Fastmail OAuth client registration take?
6. Does iCloud CalDAV honor `<C:expand>` today? The two secondary sources disagree. Client-side expansion makes the question moot.
7. Can the owner obtain Microsoft publisher verification? It needs a CPP account and an Entra work tenant with a custom domain. Without it, many work tenants can't consent.
8. Exact Exchange Online IMAP capability string (CONDSTORE absence comes from a secondary source).
