# Google connectivity for Aplos Mail: Gmail, Google Calendar, OAuth and verification

2026-10-25. This report covers what Aplos needs to connect a desktop app to Gmail and Google Calendar reliably. It ends with an audit of `apps/desktop/src/main/google.ts` (repo `/Users/knewton/.t3/projects/aplos-mail`, `main` at `72095ff`, "Release v0.2.3"; the worktree copy is byte-identical).

**Evidence labels.**
- **[V]** I checked it against an official Google page (URL given, with its "last updated" date where shown) or an Aplos file and line.
- **[S]** A secondary source: vendor blog, forum thread or GitHub issue.
- **[I]** My inference.

No repositories were cloned for this report. Claims about other clients come from the sibling reports in `research/email-clients/arch/`, which record each project's license. No code is quoted. It builds on `research/inbox-zero/aplos-architecture.md` §3/§5 and `SYNTHESIS.md`, and corrects them where Google's numbers have changed.

---

## 0. Findings that change decisions

1. **Google cut Gmail quotas on 1 May 2026. This almost certainly explains the 403s.**
   - [V] Projects created on or after that date get **6,000 units per user per minute** (was 15,000).
   - `threads.get` now costs **40 units, or 120 with `format=full`**. `messages.get` costs **20, or 60 with `full`/`raw`** ([Gmail usage limits](https://developers.google.com/workspace/gmail/api/reference/quota), updated 2026-10-16).
   - Aplos's first sync is 500 × `threads.get?format=full`. That is about **60,000 units, ten minutes of per-user budget**, fetched four at a time, all-or-nothing.
   - The synthesis's "about 5,000 units" used the old prices. [I] Aplos's two-week-old Cloud project is on the new limits. The owner can confirm in Cloud console → Quotas → "Units per minute per user" = 6,000.
2. **Search-as-you-type spends about 12,000 units each time typing pauses.**
   - [V] `App.tsx:179` debounces 250 ms, then `service.ts:430` calls `google.search`.
   - That fetches 100 threads with `format=full` (`google.ts:333`), and errors are swallowed.
3. **Gmail now needs a design built around a quota budget.**
   - Fetch metadata first (20 to 40 units), bodies on demand.
   - Run every caller through one per-account budget, batches of 50 or fewer.
   - Apply history deltas instead of refetching threads.
   - Under the new quotas, this decides whether Gmail works at all.
4. **Push without a server.**
   - Polling `history.list` (2 units) is cheap.
   - IMAP IDLE is free and fast but needs the broadest scope, `https://mail.google.com/`.
   - Pulling Pub/Sub from the desktop is not viable without a privileged credential or a provisioning server.
5. **Verification is unavoidable, and CASA should be assumed.**
   - `gmail.modify` and `gmail.settings.basic` are both **restricted** [V].
   - CASA is officially tied to "store or transmit restricted scope data on servers" [V].
   - Aplos sends mail to Groq or another LLM by default.
   - In 2026 Google reportedly demanded CASA even from a local-only app [S].
6. **New AI-specific policy.** [V] The Workspace API user-data policy (2026-09-03):
   - approves "providing generative AI summaries";
   - requires restricted-scope apps to protect against prompt injection;
   - asks for per-invocation consent to agentic tool use;
   - forbids using data to train models.

   The Gemini API's unpaid tier trains on inputs [V], so it must not receive Gmail content.
7. **Field-breaking gaps in the code.**
   - Granted scopes are never checked, though Google's checkbox consent makes partial grants normal.
   - `invalid_grant` is not mapped to "reconnect", and Testing projects get 7-day refresh tokens.
   - Thread labels are unioned, so one trashed reply sends the whole conversation to Trash and phone drafts render as messages.

---

## 1. Gmail quotas and what Aplos spends

### 1.1 Current limits [V]

Sources: [usage limits](https://developers.google.com/workspace/gmail/api/reference/quota) (2026-10-16); [release notes](https://developers.google.com/workspace/gmail/release-notes), 1 May 2026; [Workspace tiering model](https://developers.google.com/workspace/tools-safety), which applies to the Gmail, Calendar and Drive APIs.

| Limit | Value |
|---|---|
| Per project per minute | 1,200,000 units |
| Per user per project per minute | 6,000 units, on a sliding window. Per-user limits "can't" be raised; the console caps the field at 6,000 [S: [mishmail #16](https://github.com/ronboger/mishmail/issues/16)] |
| Per project per day | 80,000,000 units. This is a **billing threshold**, not a hard cap, and can't be raised. Billing will be announced "later in 2026" with at least 90 days' notice |
| Grandfathering | Projects that used the API between November 2025 and April 2026 keep their old quotas. New projects get the new ones |

**Unit costs.** The old column is [S], from the GitHub issue above and Aplos's prior report.

| Method | New | Old |
|---|---|---|
| `getProfile`, `labels.list`, `settings.*.list` | 1 | 1 |
| `history.list` | 2 | 2 |
| `messages.list` / `threads.list` | 5 / 10 | 5 / 10 |
| `messages.get` minimal or metadata | 20 | 5 |
| `messages.get` full, raw or html | **60** | 5 |
| `threads.get` minimal or metadata | **40** | 10 |
| `threads.get` full | **120** | 10 |
| `messages.attachments.get` | 20 | 5 |
| `messages.modify` / `threads.modify` | 5 / 10 | same |
| `messages.batchModify` (up to 1,000 IDs) | 50 | 50 |
| `messages.trash` / `threads.trash` | 20 / 20 | 5 / 10 |
| `messages.insert` | 25 | 25 |
| `drafts.create` / `update` / `send` | 10 / 15 / 100 | same |
| `messages.send` | 100 | 100 |
| `settings.filters.create` / `list` | 5 / 1 | same |
| `watch` | 100 | 100 |

Only `full` (plus `raw`/`html` for messages) carries the higher price. `metadata` and `minimal` cost the base rate [V].

### 1.2 What the current adapter spends [V code, arithmetic]

| Flow | Calls (`google.ts`) | Units |
|---|---|---|
| First sync | `getProfile`, `threads.list`, 500 × `threads.get?format=full` (`:198-203`, `:179`), then serial body-part fetches (`:183-187`) | **≈60,011+**, about 10 minutes of budget |
| One search | `threads.list` + 100 × full (`:333`) | **≈12,010** |
| New reply in a known thread | `history.list` + full thread (`:228`) | 122 |
| Label change on a known thread | `history.list` + `format=minimal` (`:227`) | 42 |
| Label change on an unknown thread | full fetch, dropped unless now in the Inbox (`:225-232`) | 120 each |
| Reply send | thread metadata (`:356`) + `messages.send` | 140 |
| Workflow round with N copies | labels, list, N × (20 + 60), insert, N × trash | ≈ 31 + 100·N |

**Why the first sync never finishes.** [I, from the code and the documented limits]
- Four workers spend 6,000 units in about 5 to 10 s, roughly 50 threads.
- Each request then retries independently: 1, 2, 4, 8 and 16 s plus jitter, about 31 s in total (`:122-127`). The sliding window needs about 50 s to free budget, so the retries give up first.
- One thread exhausts its retries, `Promise.all` rejects, and nothing is committed (`:171-176`).
- The engine retries from zero 30 s later.
- On a new project, any mailbox with more than about 50 threads fails the same way every time.

---

## 2. Sync practice under the new quotas

### 2.1 What Google documents [V]

**Full and partial sync** ([sync guide](https://developers.google.com/workspace/gmail/api/guides/sync), 2026-09-15)
- Full sync is `messages.list`, then batched `messages.get`. The thread methods are "equivalent".
- Use `full`/`raw` the first time you show a message. Use `minimal` for messages you already cached, because "only the labelIds might change".
- Partial sync is `history.list` from a stored `startHistoryId`.

**`history.list`** ([reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list))
- `maxResults` defaults to 100, max 500. It accepts `labelId` and `historyTypes` filters.
- IDs "increase chronologically but are not contiguous". They are "typically valid for at least a week, but in some rare circumstances … only a few hours". A 404 means "perform a full sync".
- History messages "typically only have id and threadId fields populated".
- `labelsAdded`/`labelsRemoved` records carry their own `labelIds`. **Label deltas can therefore be applied without any fetch** if the client keeps per-message labels.

**Batching** ([batch guide](https://developers.google.com/workspace/gmail/api/guides/batch))
- At most 100 calls per batch, and 50 or fewer recommended ("larger batch sizes are likely to trigger rate limiting").
- *n* batched calls count as *n* requests. Batching saves round trips, not quota.

**Payload size** ([performance](https://developers.google.com/workspace/gmail/api/guides/performance))
- `fields` masks trim responses, for example `messages(id,threadId,labelIds,internalDate,payload/headers)`.
- Gzip needs `Accept-Encoding: gzip` and a User-Agent containing `gzip`.
- [I] Node's `fetch` sends its own User-Agent. Set one such as `AplosMail/x (gzip)` and measure the result.

### 2.2 Choosing a format [V costs, I trade-offs]

- `minimal` returns IDs, labels, `historyId` and size.
- `metadata` adds the headers you name and the snippet. It costs 20 per message, 40 per thread.
- `full` returns the parsed MIME tree. `raw` returns the RFC 822 bytes. Each costs 60 per message. Only `full` exists for threads, at 120.
- Rule of thumb: for one uncached message, `messages.get?format=raw` costs 60. For two or more, `threads.get?format=full` costs the same as two message fetches in one round trip.
- `raw` fits Aplos best [I]:
  - the IMAP adapter already parses RFC 822 with mailparser, so every provider shares one parsing path;
  - it preserves S/MIME and unusual charsets;
  - it can live as an `.eml` blob outside the in-memory model.

### 2.3 Recommended first sync [I, priced with §1.1]

1. **Cursor first.** Read `getProfile.historyId` (1 unit) before listing, as Aplos already does.
2. **List.** `messages.list?labelIds=INBOX&maxResults=500` costs 5 units a page. Do not set `includeSpamTrash`.
3. **Metadata.** For each thread, fetch only the newest message:
   - `messages.get?format=metadata` with `From, To, Cc, Subject, Date, Message-ID, List-Unsubscribe` and a `fields` mask, in batches of 50;
   - **20 units per thread**;
   - the first 50 Inbox threads cost about 1,000 units and appear in seconds;
   - 500 threads cost about 10,000 units, roughly 2.5 minutes at a 4,500-unit-per-minute budget.
4. **Commit per page.** Save each page and its `pageToken` in one SQLite transaction, so a 403 or crash costs one page.
5. **Bodies.** Fetch on open (60 to 120 units). A prefetch lane may use at most about 20% of the budget: unread Inbox first, then the newest 100 threads, then stop.
6. **Backfill.** Page `messages.list` at idle priority, metadata only. Deeper mail stays reachable through server search.
7. **Reconcile.** When backfill finishes or the cursor expires, tombstone anything in range that the host no longer lists. This is the missing `reset` handling.

### 2.4 Recommended incremental sync [I]

- **History.** `history.list` with all four `historyTypes` and `maxResults=500`.
- **Label changes.** Apply `labelsAdded`/`labelsRemoved` to stored per-message labels and recompute thread flags. This costs 0 units, versus 40 or 120 today.
- **Added messages.** Fetch only the new message (metadata, 20 units; body on demand). Skip messages labelled `DRAFT` unless they belong to a draft Aplos tracks (§6).
- **Deleted messages.** Delete locally. Drop the thread once it has no messages left.
- **Unknown threads.** Fetch one only when its `labelsAdded` includes `INBOX`. Ignore the rest, so a bulk archive in Gmail web costs nothing.
- **Cursor.** Advance it after each committed page, as EmailEngine does (`arch/emailengine.md`), so a failure replays nothing that already succeeded.

### 2.5 Pacing and backoff

**What Google says** [V]
- Truncated exponential backoff: 2^n s plus up to 1,000 ms random, capped at 32 to 64 s ([quota page](https://developers.google.com/workspace/gmail/api/reference/quota)).
- "Start retry periods at least one second after the error" ([errors guide](https://developers.google.com/workspace/gmail/api/guides/handle-errors)).
- A separate per-user **concurrency** cap returns 429 "Too many concurrent requests for user". Parallel requests, big batches and other clients on the same mailbox can all trip it.

**What Aplos needs** [I]
- One governor per account, priced in units, used by every caller: UI, search, sync, body lane, op queue, workflow sync and AI enrichment.
- A target of about 75% of 6,000 per minute. The quota is per user *per project*, so a future Aplos phone app on the same Cloud project shares it.
- Priority lanes, highest first: interactive, op flush, incremental, backfill, enrichment.
- At most 2 or 3 requests in flight per account.
- On a rate-limit 403/429, pause the whole account lane until the window frees: use `Retry-After`, or about 60 s. Abort sibling requests with an `AbortSignal`.

---

## 3. Error reasons and handling

Sources: [Gmail errors](https://developers.google.com/workspace/gmail/api/guides/handle-errors) (2026-09-15), [Calendar errors](https://developers.google.com/workspace/calendar/api/guides/errors) (2026-09-11), [OAuth overview](https://developers.google.com/identity/protocols/oauth2) (2026-10-16). The "Aplos today" column refers to `google.ts:110-133` and `service.ts:678`.

| Status / reason | Meaning [V] | Correct handling [I] | Aplos today |
|---|---|---|---|
| 403 `userRateLimitExceeded` | Per-user limit hit | Pause the account lane about 60 s; lower the budget | Retried 5× per request, then "Reconnect the account or try again" |
| 403/429 `rateLimitExceeded` | Maximum request rate. On Calendar, 403 and 429 are "functionally similar" | Same | Same |
| 429 "Too many concurrent requests for user" | Per-user concurrency cap | Drop to 1–2 in flight and retry | Retried; concurrency stays 4 |
| 429 "User-rate limit exceeded (Mail sending)" | Daily send limit, shared across all clients. "Can persist for hours". A 200 doesn't prove delivery | **Never auto-retry a send.** Show the retry time | `messages.send` retried 5× |
| 429 bandwidth | Per-user caps "equal to, but independent of, IMAP" | Pause for hours | Treated as a rate limit |
| 403 `dailyLimitExceeded` | "your project reaches its API limit" | Stop every account until reset; record it in diagnostics | "Google denied this request"; sync keeps retrying |
| 403 `quotaExceeded` | On Calendar: "Calendar usage limits exceeded", anti-abuse limits on events and invites | Back off for hours; tell the user | **Retried 5×** (`:110`) |
| 403 `insufficientPermissions` (`ACCESS_TOKEN_SCOPE_INSUFFICIENT`) | Token lacks the scope [I: standard Google error] | Mark the feature "needs permission". Reconnect with all scopes, because incremental auth "is not supported for installed apps" [V] | Generic denial; Calendar swallowed (`service.ts:604`) |
| 403 `accessNotConfigured` / `SERVICE_DISABLED` | API not enabled in Aplos's project [I] | Build or configuration fault: stop all accounts and say so | Generic denial |
| 403 `domainPolicy`; token-endpoint `admin_policy_enforced` | A Workspace admin blocks the app | "Ask your Workspace admin to allow Aplos" | Generic denial |
| 400 `invalid_grant` (token endpoint) | Refresh token revoked, expired (7 days in Testing, 6 months unused), password change with Gmail scopes, 100-token cap, time-based access ended, or account disabled [V] | `connected:false` plus a reason; stop polling and ops; show **Reconnect** | "Google request failed (400). Please retry."; stays connected |
| 401 `authError` | Access token expired or invalid | Force one refresh, retry once, then treat as `invalid_grant` | "Reconnect" immediately (`:129`) |
| 500 `backendError`, 502–504 | Transient | Retry idempotent calls; treat writes as uncertain | Never retried (`:132`) |
| 404 | Not found, or expired `startHistoryId` | Full resync and reconcile | Resyncs; `reset` ignored downstream |
| 410 `fullSyncRequired` (Calendar) | Sync token invalid | Wipe that calendar and resync | Not applicable (no sync tokens) |

---

## 4. Gmail over IMAP versus REST

### 4.1 Verified facts

- **Authentication.**
  - IMAP, POP and SMTP need `https://mail.google.com/` with SASL XOAUTH2 ([XOAUTH2](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)). `gmail.modify` does not grant IMAP.
  - Failures return a base64 JSON challenge (`status`, `schemes`, `scope`). The client must answer it with an empty response.
- **Gmail extensions** ([`X-GM-EXT-1`](https://developers.google.com/workspace/gmail/imap/imap-extensions)).
  - `X-GM-MSGID` is "the decimal equivalent for the ID hex string used in the web interface and the Gmail API", and `X-GM-THRID` is the same for threads. **IMAP and REST IDs therefore map exactly.**
  - Also available: `X-GM-LABELS` (read and store labels), `X-GM-RAW` (Gmail search syntax), SPECIAL-USE folders, and the `ID` command (recommended).
  - CONDSTORE and QRESYNC are not mentioned.
- **IMAP access.** Always on for personal accounts since January 2025 ([Gmail Help 7126229](https://support.google.com/mail/answer/7126229)). Workspace admins can disable it or restrict it to OAuth clients [S].
- **Limits** ([bandwidth limits](https://knowledge.workspace.google.com/admin/gmail/gmail-bandwidth-limits), 2026-10-22).
  - IMAP download is capped at 2,500 MB/day and upload at 500 MB/day. Exceeding either suspends access for 1 to 24 h.
  - **No per-request units.**
  - The often-cited 15-simultaneous-connection cap comes only from older help text and vendor pages [S].

### 4.2 Trade-offs

| | REST (`gmail.modify`) | IMAP (`mail.google.com/`) |
|---|---|---|
| Cost | 6,000 units/min/user | Bandwidth only |
| 10k-message header sync | ≈200k units, ~45 min at 75% budget | One `UID FETCH` on All Mail with `X-GM-MSGID/THRID/LABELS` and header fields: a few MB, seconds [I] |
| Change detection | `history.list`, semantic records, 2 units | CONDSTORE `CHANGEDSINCE`. Without QRESYNC, expunges need UID diffs. Gmail's published CAPABILITY dumps don't list QRESYNC [I, unverified] |
| Push | Needs Pub/Sub (§5) | IDLE, free |
| Labels | Native | Labels appear as folders. Sync All Mail only and read `X-GM-LABELS` (Mailspring, Nylas) |
| Drafts / filters / settings | REST | Drafts via APPEND. **No filters or settings** |
| Consent text | "Read, compose, and send" | Adds "**permanently delete** all your email". Google says to use this scope only for immediate permanent deletion [V scopes page] |
| Verification | Restricted | Restricted. Reviewers may question the broadest scope; many verified desktop clients justify it with IMAP [I] |

**What other clients do** (from the sibling reports): Mailspring and Nylas run IMAP on `mail.google.com/`, IDLE on All Mail and a wakeable background pass. EmailEngine supports both modes and pulls Gmail Pub/Sub with a service account. Zero asks for both scopes and gets push via Pub/Sub. Superlocal polls REST every 15 s. Inbox Zero proxies everything through its server.

[I] **Assessment.**
- Under 2026 quotas, IMAP is the much cheaper bulk transport, and IDLE is the only push that needs no server.
- The best design is a hybrid: IMAP for bulk headers, bodies and IDLE; REST for history, label writes, drafts and filters.
- The price: a second code path (Aplos already ships `imapflow`), the scariest consent line, and possible reviewer pushback.
- Ship REST with a quota budget first. Settle the scope choice **before** submitting for verification, because changing scopes later means verifying again.

---

## 5. Push and change signals without a server

**`users.watch` requirements** [V] ([push guide](https://developers.google.com/workspace/gmail/api/guides/push), 2026-09-15)
- A Pub/Sub topic with publish rights for `gmail-api-push@system.gserviceaccount.com`.
- Renewal at least every 7 days (daily recommended; 100 units each).
- At most 1 notification per second per user; the excess is dropped.
- Payload `{emailAddress, historyId}`, delivered by push (HTTPS POST) or pull (ack required).
- Notifications "might be delayed or dropped", so `history.list` polling is still needed as a fallback.

**A. Poll `history.list`. Recommended now.**
- Cadence [I]: 15 s focused, 60 s backgrounded, 5 min hidden or on battery, plus immediately on wake, network change and focus.
- Add ±25% jitter, as Google's [Calendar guidance](https://developers.google.com/workspace/calendar/api/guides/quota) recommends.
- Cost: 11,520 units/day per user at 15 s, 2,880 at 60 s.
- [I] Once billing applies above 80M units/day per project, cadence becomes a cost lever. The free tier then covers roughly 7,000 always-on users at 15 s, or 28,000 at 60 s. Back off when idle.

**B. IMAP IDLE as a wake signal only.**
- One XOAUTH2 connection on All Mail in IDLE. Any `EXISTS`, `EXPUNGE` or `FETCH` triggers `history.list`; data still goes through REST.
- Re-issue IDLE at least every 29 minutes (RFC 2177). Reconnect with a fresh token on drop.
- [unknown] Whether a session outlives the one-hour access token is undocumented.
- Nylas found IDLE misses some flag changes (`arch/nylas-sync-engine.md`), so keep a slow poll.
- Cost: 0 units, about 1 to 2 s latency, one connection, and the `mail.google.com/` scope.

**C. Pub/Sub pull from the desktop. Not viable.** [V facts, I conclusion]
- Filters match "attributes, but not … the data" ([filters](https://docs.cloud.google.com/pubsub/docs/subscription-message-filter)). Gmail puts the address only in `data`, so a shared subscription can't be split per user.
- Any credential shipped in the app could read and ack **every** user's notifications. That reveals who uses Aplos, shows when their mail arrives, and lets one client steal another's notifications.
- Per-user topics and subscriptions:
  - are capped at 10,000 per project, and the cap can't be raised ([Pub/Sub quotas](https://docs.cloud.google.com/pubsub/quotas));
  - need a privileged provisioner to create them and bind IAM roles, which means a server;
  - need a Pub/Sub scope on the user's token. That adds a Cloud consent line and, for Workspace users, Cloud session-control reauth (`invalid_rapt`) [V OAuth overview].
- EmailEngine's pull mode works because it *is* a server with a service account.

**D. A content-free push relay. Later.**
- This is the relay sketched in DECISIONS (line 151): Pub/Sub pushes to a tiny HTTPS function, which sends only a "poke" to the device socket mapped from an email hash.
- No tokens or mail content touch it, but it is still a server.
- [I] Whether `emailAddress` + `historyId` counts as restricted data for CASA is unclear. Ask Google during verification. Defer until there is a phone app.

---

## 6. Drafts and filters

### Drafts [V] ([drafts guide](https://developers.google.com/workspace/gmail/api/guides/drafts), 2026-09-10)

**How the API behaves**
- A draft holds an RFC 822 message, and `DRAFT` is the only label it can carry.
- `drafts.update` **replaces the whole message**. The draft ID stays stable, while the message ID "change[s] every time the message is replaced".
- `drafts.send` (100 units) deletes the draft and creates a `SENT` message.
- Scope: `gmail.modify` is enough (`mail.google.com/` and `gmail.compose` also work).
- Large bodies go through the `/upload/` endpoints: simple upload up to about 5 MB, resumable above that ([uploads](https://developers.google.com/workspace/gmail/api/guides/uploads)).
- Threading a reply needs `threadId`, RFC 2822 `In-Reply-To`/`References`, and a matching Subject ([sending](https://developers.google.com/workspace/gmail/api/guides/sending)).

**Proposed Aplos design** [I]
- The local draft, with a revision number, is the source of truth. Map it to a Gmail `draftId`.
- Upload after 5 to 10 s idle and on close (15 units). Large or attachment-heavy drafts go through `/upload/`, since every update resends the whole MIME.
- Detect remote edits through `DRAFT` history records for the tracked `draftId`. If the message ID differs from the one Aplos last wrote, raise a conflict.
- Send through `drafts.send`, so the copy on the phone disappears.
- Today, drafts made on the phone render inside threads as ordinary messages (§9, D9).

### Filters [V] ([guide](https://developers.google.com/workspace/gmail/api/guides/filter_settings); [filters.create](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters/create))

**How the API behaves**
- Criteria: `from`, `to`, `subject`, `query`, `negatedQuery`, `hasAttachment`, `size`. All criteria must match.
- Actions: add or remove labels (`INBOX` to archive, `UNREAD`, `SPAM`, `TRASH`, `IMPORTANT`, `STARRED`, or one user label), or forward to a verified address.
- Filters apply per message, not per thread.
- The **only** accepted scope is `gmail.settings.basic`. Maximum 1,000 filters. There is no update method; delete and recreate instead.

**Use in Aplos** [I]
- Filters act on incoming mail. Apply the same query to existing mail with `messages.list` plus `messages.batchModify` (50 units per 1,000 IDs).
- Block, "skip Inbox" and newsletter rules then keep running on Google's servers while the Mac sleeps. That is the escape hatch the synthesis recommended, and the reason to **keep** `gmail.settings.basic`.

---

## 7. Google Calendar

**Sync tokens** [V] ([sync guide](https://developers.google.com/workspace/calendar/api/guides/sync); [events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), 2026-09-11)
- `nextSyncToken` appears **only on the last page**. Nothing is missed between pages.
- An incremental sync may span several pages under the same `syncToken`.
- These parameters can't be combined with `syncToken`: `iCalUID`, `orderBy`, `privateExtendedProperty`, `q`, `sharedExtendedProperty`, `timeMin`, `timeMax`, `updatedMin`. All other parameters must match the initial request.
- Deleted (`cancelled`) events "will always be in the result set".
- 410 `fullSyncRequired` means wipe and resync.
- `maxResults` defaults to 250, max 2,500. The calendar list syncs the same way.

**Push** ([push guide](https://developers.google.com/workspace/calendar/api/guides/push))
- Needs an HTTPS webhook with a valid certificate (no self-signed).
- Channels expire and don't auto-renew. Notifications carry headers only (`X-Goog-Resource-State` `sync`/`exists`).
- **There is no Pub/Sub alternative**, so a serverless desktop can't receive Calendar push.

**Quotas** ([quota](https://developers.google.com/workspace/calendar/api/guides/quota))
- For projects created on or after 1 May 2026: 600 requests/min per user, 10,000/min per project, and a billing threshold of 1,000,000/day.
- Google calls "repeatedly poll[ing] every calendar" an anti-pattern. Vary periodic work by ±25%.

**Updates** ([events.update](https://developers.google.com/workspace/calendar/api/v3/reference/events/update))
- `update` "always updates the entire event resource". Use `patch`, or get-then-update with ETags.
- A stale ETag fails with 412 `conditionNotMet`.
- 403 `forbiddenForNonOrganizer` protects shared properties.

**Design** [I]
- Keep one `syncToken` per calendar.
- Initial sync: `singleEvents=true`, `timeMin` = now − 30 days, no `orderBy`. Later incremental results ignore any window, so filter locally.
- Polling cadence, all with jitter:
  - primary calendar every 2 to 5 min and on focus;
  - other calendars every 15 to 30 min;
  - the calendar list every 30 min.
- Save edits with `patch` and `If-Match`.
- Decide deliberately between `singleEvents` (simple, but expands unbounded series and makes series edits awkward) and syncing masters with local RRULE expansion (what most full clients do).

---

## 8. OAuth and verification

### 8.1 OAuth for installed apps [V]

Sources: [native-app guide](https://developers.google.com/identity/protocols/oauth2/native-app) (2026-10-16), [OAuth overview](https://developers.google.com/identity/protocols/oauth2), [granular permissions](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions).

**Redirect and PKCE**
- Loopback redirect on `127.0.0.1` or `[::1]` with a random port is the recommended method. `localhost` "may cause issues with client firewalls".
- The out-of-band flow is gone. Custom URI schemes are "no longer supported due to the risk of app impersonation".
- "Always use PKCE" (S256).
- Desktop apps "cannot keep secrets confidential", so `client_secret` is optional.

**Token response**
- `scope` lists the scopes actually *granted*.
- "Refresh tokens are always returned for installed applications".
- `refresh_token_expires_in` appears only when the user chose time-based access.

**Granular consent**
- A checkbox screen appears when an app asks for sign-in scopes plus another scope, or for two or more non-sign-in scopes. Aplos does both.
- Developers report the boxes start **unchecked** [S: [gapi #754](https://github.com/google/google-api-javascript-client/issues/754)].
- Apps "must verify which scopes were actually granted" and should disable the features that were denied.
- "Incremental authorization is not supported for installed apps", so a missing scope means a full re-consent.

**When refresh tokens die** (all surface as `invalid_grant`)
- The user revokes access.
- The token goes unused for 6 months.
- The user changes password while Gmail scopes are granted.
- The 100-tokens-per-account-per-client cap is reached; the oldest token dies silently.
- Time-based access ends.
- An admin restricts the service (`admin_policy_enforced`).
- **The project is external and in Testing: tokens last 7 days.**

### 8.2 Verification [V unless marked]

**Scopes**
- The [Gmail scopes page](https://developers.google.com/workspace/gmail/api/auth/scopes) (2026-09-10) lists as restricted: `mail.google.com/`, `gmail.readonly`, `compose`, `insert`, `modify`, `metadata`, `settings.basic` and `settings.sharing`.
- `gmail.send` is sensitive and `gmail.labels` is non-sensitive.
- [I] Aplos's Calendar scopes are generally classed as sensitive. The Calendar auth page doesn't show classes.

**Process** ([restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), 2026-08-19)
- Brand check takes 2 to 3 business days; restricted-scope review takes "several weeks".
- A privacy policy on the app's own domain.
- An unlisted English demo video showing the client ID in the consent URL and each scope's feature in use.
- A security assessment "at least every 12 months".
- Exceptions: personal use (only you or "a few users … known personally to you"), and development or testing, which keeps the user cap and short token lifetime.

**Is CASA required?**
- The official text says: "If you store or transmit restricted scope data on servers, then you need to complete a security assessment."
- The [Help Center](https://support.google.com/cloud/answer/13465431) drops the qualifier: restricted scopes "must undergo an annual security assessment".
- A local-only exemption is *implied*, never stated. In March 2026, Google's security team reportedly told a local-only iOS app the assessment "was now mandatory" [S: [Cloud Community](https://security.googlecloudcommunity.com/google-security-operations-2/what-happened-to-local-app-gmail-api-access-7138)].
- [I] Aplos sends message content to LLM servers by default. That is transmission to servers, whoever runs them. **Plan for CASA.** A local-AI-only build might support an exemption request, but don't count on it.

**CASA levels and cost**
- The App Defense Alliance now uses assurance levels AL1 and AL2. Both are lab-tested, **Google assigns the level**, and revalidation is yearly ([ADA](https://appdefensealliance.dev/casa/casa-tiering), 2026-06-27).
- [S] TAC Security charges about $540 to $1,800/yr for Tier 2/AL1 and about $4,500 for Tier 3/AL2 ([DeepStrike](https://deepstrike.io/blog/google-casa-security-assessment-2025), [Switch Labs](https://www.switchlabs.dev/post/casa-tier-2-tier-3-security-review-providers-pricing-and-the-cheapest-option)).

**Limited Use and LLMs**
- The [User Data Policy](https://developers.google.com/terms/api-services-user-data-policy) allows transfers only "to provide or improve … user-facing features … and only with the user's consent". It restricts humans reading the data.
- The [Workspace API policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) (2026-09-03):
  - bans using data "to create, train, or improve a machine learning or artificial intelligence model" (a user's own personalized model excepted);
  - approves "built-in and web email clients" and "providing generative AI summaries";
  - requires restricted-scope apps to protect against prompt injection ("Model Armor or other");
  - suggests per-invocation confirmation of agentic tools. Aplos's confirm cards already fit this.
- **Consequence:** every AI provider that receives mail must have no-training terms. The Gemini *unpaid* tier uses inputs "to … improve … machine learning technologies" and allows human review ([Gemini API terms](https://ai.google.dev/gemini-api/terms)), so it's out. [I] Check OpenRouter routes and Groq's terms the same way.

**User cap**
- Unverified apps get "100 new users in total" after the warning screen ([Help 7454865](https://support.google.com/cloud/answer/7454865)).
- Moving from Testing to Production while unverified ends the 7-day token expiry but keeps the warning and the cap.

---

## 9. Defects in `google.ts` and its engine callers

Priorities: **P0** blocks real use. **P1** fails in the field. **P2** is a correctness or efficiency bug. **P3** is minor. Line numbers refer to `google.ts` unless another file is named.

### P0: blocks real use

**D1. The first sync can never complete on a new project** (`:27`, `:179`, `:171-176`, `:122-127`)
- Cause: 500 full threads (about 60k units against 6k/min), concurrency 4, about 31 s of per-request retries, all-or-nothing, no sibling cancellation.
- Effect: 403 after about 50 threads, and the run restarts from zero forever.
- Fix: §2.3.

**D2. Every search pause costs about 12k units** (`:28`, `:333`; `service.ts:430`; `App.tsx:179`)
- Cause: a 250 ms debounce triggers 100 full fetches. Results are written into stored state, and errors are swallowed.
- Effect: one typed query exhausts about 2 minutes of quota and starves sync.
- Fix:
  - query the server only on Enter or an explicit "Search Gmail";
  - `messages.list?q=`, then batched metadata for about 25 threads (≈500 units);
  - bodies on open;
  - keep results in a transient cache.

**D3. Bulk changes elsewhere stall sync** (`:225-232`)
- Cause: every relabelled unknown thread gets a full fetch (120 units); known ones cost 40. The cursor only advances when the whole batch succeeds.
- Effect: archiving 2,000 old threads in Gmail web costs about 240k units. The fetch fails and replays every sync until history expires about a week later.
- Fix: label deltas from history records; fetch only threads that gained `INBOX`; commit the cursor per page.

**D4. `invalid_grant` is not treated as "reconnect"** (`:139-145` via `:132`; `service.ts:678`)
- Effect: a Testing project's 7-day token expiry turns into "Google request failed (400). Please retry." every 60 s. Op retries continue and the account still shows as connected.
- Fix:
  - map `invalid_grant`/`admin_policy_enforced` to `ReauthRequired`;
  - set `connected:false` with a reason, pause sync and ops, show Reconnect;
  - switch the project to Production (unverified) now.

### P1: fails in the field

**D5. Granted scopes are ignored** (`:310-321`)
- Cause: `scope` in the token response is never read, and `calendarConnected:true` is hard-coded.
- Effect:
  - unticked Gmail → every call fails with 403 `insufficientPermissions`;
  - unticked Calendar → fails silently (`service.ts:604`);
  - unticked settings → a misleading warning.
- Fix:
  - store the granted scopes;
  - refuse to connect without `gmail.modify` and explain why;
  - derive Calendar and filter capabilities from the grant;
  - offer "grant missing permissions".

**D6. Error classes are conflated** (`:110`, `:128-132`)
- `quotaExceeded` is retried 5 times.
- `dailyLimitExceeded`, `accessNotConfigured` and `domainPolicy` all read as "denied" plus "Reconnect".
- A 401 doesn't force a token refresh.
- 5xx errors aren't retried.
- An HTTP-date `Retry-After` isn't parsed.
- Fix: a typed taxonomy (§3) with per-account states.

**D7. Sends are retried on sending-limit 429s** (`:362` via `:122`)
- Effect: about 30 s of spinner for a limit that lasts hours, and Google's "retry after" time is lost.
- Fix: never retry sends on rate errors; show "until HH:MM".

**D8. One trashed message trashes the whole thread** (`:35-37`, `:66-67`)
- Cause: thread status comes from the union of all messages' labels, so one `TRASH` (or `SPAM`) message marks the thread trash.
- Effect: deleting one reply in Gmail removes the conversation from Home.
- Fix: keep per-message labels and derive status from messages that are not in Trash or Spam. [I] Gmail web keeps such a conversation in the Inbox and notes the deleted message.

**D9. Drafts render as messages** (`:58-65`, `:356`)
- Cause: `threads.get` includes `DRAFT` messages, so phone drafts show as the user's own mail and can supply the summary and date. `send` takes `In-Reply-To` from the last message, which may be a draft or a trashed message.
- Fix: exclude `DRAFT` messages; reply to the selected message.

**D10. `reset:true` is ignored** (engine; `:202`)
- Effect: after a cursor expiry, or more than 20 history pages, threads deleted at the host remain as ghosts.
- Fix: reconcile the window (§2.3 step 7).

**D11. Saving a calendar event wipes fields** (`:387`)
- Cause: an `events.update` PUT that sends only title, description, location, times and attendee emails.
- Effect:
  - clears Meet `conferenceData`, reminders, colour, `timeZone`, attachments and visibility;
  - resets attendees' RSVPs;
  - fails with `forbiddenForNonOrganizer` on other people's events;
  - no ETag, so concurrent edits are lost.
- Fix: `events.patch` with only the changed fields, plus `If-Match`.

**D12. Calendar is fully re-pulled every 10 min** (`:378-383`; `service.ts:599-605`)
- Cause: every calendar, including hidden ones, is fetched serially for −30 days to +1 year, inside the mail sync's staged transaction.
- Effect: one failing calendar silently drops every update.
- Fix: per-calendar sync tokens, decoupled from mail sync, with errors reported per calendar.

### P2: correctness or efficiency

- **D13.** Label-only changes cost 40 units per thread (`:190-194`, `:227`), even though history records already carry the label IDs. Fixed together with D3.
- **D14.** A new reply refetches the whole thread in full (`:228`). Fetch only the added message.
- **D15.** Body parts stored as attachments are fetched serially in each worker (`:183-187`). Fetch them lazily and in batches.
- **D16.** `includeSpamTrash=true` wastes the first window on junk mail (`:162`). Sync Inbox, then Sent.
- **D17.** The app-data history filter relies on `labelIds`, which history records "typically" don't include (`:213`). So every device does 120-unit full fetches on each workflow round. Skip by known app-data message IDs, and gate on `history.list?labelId=<app label>` (2 units).
- **D18.** Workflow rounds re-download every copy every 5 min: 80 units each and up to 3 MB raw. Only the first 50 copies are listed (`:256`, `:396-398`). Gate on D17's check and paginate.
- **D19.** No `fields` masks anywhere, and gzip may be inactive (§2.1).
- **D20.** Large sends go through JSON `raw` under a 45 s timeout (`:114`, `:362`). A 25 MB attachment becomes about 33 MB of JSON and turns "uncertain" on slow links. Use `/upload/…/messages/send` (`message/rfc822`, resumable above 5 MB).
- **D21.** Every connect uses `prompt=consent` (`:310`). Installed apps get refresh tokens without it, and it re-shows the checkbox screen every time. There is no `login_hint`, and `sub` isn't checked on reconnect, so a reconnect can silently attach a different account. Each reconnect also mints another refresh token toward the 100-per-client cap. Use `select_account` plus `login_hint`.

### P3: minor

- **D22.** Snippet entities such as `&#39;` and `&quot;` aren't decoded (`:54`, `:67`).
- **D23.** `close()` doesn't abort in-flight requests (`:114`, `:423`).
- **D24.** `listCalendars` ignores Google's `hidden`/`selected` flags (`:262`).
- **D25.** Any `getSendAs` failure is reported as a missing settings scope (`service.ts:601-603`).

### What is already right [V]

- `historyId` is read before listing.
- Uncertain writes are flagged, and sends are settled with `rfc822msgid:`.
- OAuth uses a `127.0.0.1` loopback, a 256-bit `state` and PKCE S256.
- Refreshes are deduplicated.
- The token vault is encrypted and written atomically, and rotated refresh tokens are saved.
- Disconnect revokes the grant.
- Alias senders are validated.

---

## 10. Recommended connectivity design

### 10.1 Shared shape: a local sync daemon [I]

- **What it is.** One long-lived process per Mac. It can start as the engine `utilityProcess` and later become a launchd agent.
- **What it owns.**
  - the OAuth vault;
  - all provider connections;
  - a **per-account governor** priced in each provider's unit: Gmail units, Graph's 4 concurrent requests per mailbox, IMAP connections;
  - the op queue;
  - SQLite, with metadata separate from bodies.
- **What it serves.** The Electron UI over a local API, and later a phone over the LAN or a relay.
- **Why it must own the quota.** Gmail's limit is per user *per project*, so every Aplos surface on the same Cloud project shares one 6,000-unit budget.
  - A phone that reads through the Mac avoids a second sync.
  - When the Mac sleeps, the phone needs its own budgeted direct path.
- **AI.** Enrichment is its own lane with its own budget, never inside sync.

### 10.2 Gmail

1. **Scope.** Decide before verification:
   - (a) `gmail.modify` + `gmail.settings.basic`, REST only; or
   - (b) `mail.google.com/` + `gmail.settings.basic`: IMAP for bulk and IDLE, REST for history, labels, drafts and filters.

   Ship (a) first. Option (b) is the quota-efficient end state.
2. **Initial sync.** §2.3: Inbox visible in seconds, 500 threads in about 2.5 min, idle backfill.
3. **Incremental sync.** §2.4 per-message deltas, with jittered polling (15 s / 60 s / 5 min) and a sync on wake.
4. **Bodies.** On open (`raw` or `full` by message count), plus a capped prefetch lane.
5. **Writes.**
   - `threads.modify` for single threads; `messages.batchModify` for bulk (50 units per 1,000);
   - `drafts.*` for drafts;
   - `settings.filters` for Block and rules;
   - `drafts.send`, or `/upload` `messages.send`, with Message-ID settlement.
6. **Errors.** The §3 taxonomy, with account states: rate-limited until, needs reconnect, needs admin, build misconfigured.
7. **Workflow sync.** Keep the hidden label, but gate it on a `history.list?labelId` check.

### 10.3 Google Calendar

- Per-calendar sync tokens.
- Poll the primary calendar every 2 to 5 min, the others every 15 to 30 min, and the calendar list's sync token on its own schedule.
- Save with `patch` and an ETag. Resync on 410.
- Make a deliberate recurrence choice (§7).
- No push until a relay exists.

### 10.4 Google identity

**Sign-in flow**
- Keep loopback plus PKCE. Use `prompt=select_account` with `login_hint`.
- Store the `scope` granted on every token response.
- Map `invalid_grant` and `admin_policy_enforced` to Reconnect.
- Honour `refresh_token_expires_in`.

**Verification, starting now**
- Move to Production (unverified).
- Start brand verification.
- Publish a privacy policy with the Limited Use statement.
- Record the demo video.
- Budget for CASA.

**AI and mail content**
- Send Gmail content only to no-training AI providers.
- Show a consent card before the first bulk AI pass.
- Document the prompt-injection defences.

### 10.5 Other providers (brief; see the sibling reports)

From `aplos-architecture.md` §3 and the arch reports [I]:
- **Microsoft Graph:**
  - delta per folder with `$batch`;
  - honour `Retry-After` (missing today);
  - no more than 4 concurrent requests per mailbox;
  - poll delta every 30 to 60 s, since webhooks need a public URL.
- **IMAP** (iCloud, Yahoo, generic):
  - IDLE on INBOX in a dedicated connection;
  - CONDSTORE, plus QRESYNC where the server advertises it;
  - headers first, with per-folder checkpoints.
- **JMAP** (Fastmail): EventSource push plus `/changes`.
- **CalDAV:** RFC 6578 `sync-collection`, falling back to ctag and etag.

---

## Open questions

- What `reason` did the 0.2.3 build actually show?
  - `rateLimitExceeded` or `userRateLimitExceeded` confirms the quota diagnosis.
  - `insufficientPermissions` points to unticked consent boxes.
- Will Google's reviewers accept `mail.google.com/` for a client that also uses REST, given the scope page's "only to permanently delete" wording?
- Would Google exempt a local-only build (no third-party AI) from CASA? If not, which assurance level would Gmail be assigned?
- What will Google charge above the 80M units/day project threshold? The answer sets the polling cadence at scale.
- Does a Gmail IMAP IDLE session outlive its access token, and does Gmail advertise QRESYNC today? Check with a live CAPABILITY dump.
