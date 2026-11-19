# Inbox Zero Mail (the client): sync, storage and topology audit

*Audited 2026-10-25 from a shallow clone of `elie222/inbox-zero` `main` at `9946df5` (2026-10-25 17:15 +0100), at `/tmp/iz-compare/src/inbox-zero`. I only read files. Nothing was installed, built or run. Paths are relative to the repo root, and `web/` means `apps/web/`. "Verified" means I read the code or an API response myself. "(inference)" marks a conclusion I drew but did not run.*

This report builds on `research/inbox-zero/inbox-zero-architecture.md`, which covers the assistant, rules, AI pipeline, Postgres schema, webhooks and token storage. I don't repeat that material here. This report covers the **new client**: the `mail-core` and `mail-sqlite` engine, the `/api/mail/v1` protocol, the Electron engine host, the browser host, the iPhone surface, and the client UI.

---

## 1. Overview

**What it is.** A keyboard-first Gmail and Outlook client for web, macOS and Windows, plus a closed-source iPhone app, launched 2026-10-18. Every surface shares one portable TypeScript engine (`packages/mail-core`) and one SQLite schema (`packages/mail-sqlite`) holding a local replica. The engine does **not** talk to Gmail or Graph. It syncs through the company's server over a versioned HTTP protocol (`/api/mail/v1`), and that server holds the OAuth tokens.

**License.** The root `LICENSE` is AGPL-3.0 with extra terms (verified). You may not monetize the program or a derivative ("selling access ... offering it as a paid service ... incorporating it into a commercial product"), and organizations with five or more business users need an enterprise license. GitHub reports the license as `NOASSERTION`. `apps/web/ee/` has a separate commercial license. The mail packages say "SEE LICENSE IN ../../LICENSE", and CI publishes them publicly to npm (`.github/workflows/mail-packages-release.yml`). Treat all of it as copyleft with a commercial restriction. Ideas only; never copy code.

**Activity and maturity** (verified with `gh api` on 2026-10-25):

| Metric | Value |
|---|---|
| Stars / forks / open issues | 12,807 / 1,632 / 142 |
| Created / last push | 2023-07-12 / 2026-10-25 |
| Contributors | About 90 repo-wide (prior report). In practice it is one maintainer: `elie222` wrote 33 of 34 `packages/mail-core` commits and all 59 `apps/desktop` commits. |
| Engine birth | PR #3793, "Mail engine: SQLite mailbox with engine-owned web lists". Merged 2026-09-22 after 4 days: +54,148 / −49,623 lines, 583 files, 9 commits. The PR body mentions removing "the agent diary", which suggests heavy AI-agent authorship. |
| Desktop releases | `desktop-v0.1.12` (2026-09-24) to `desktop-v0.1.21` (2026-10-21): 10 releases in 4 weeks |
| Design doc | `docs/plans/mail-engine-plan.md`, 1,573 lines. It covers contracts, invariants, stages and validation gates. |

**Size (non-test / test lines):**

| Package | Non-test | Test |
|---|---|---|
| `mail-core` | 5.0k | 2.2k |
| `mail-sqlite` | 6.5k | 10.5k (`store.ts` alone is 3.4k) |
| `mail-ui` | 2.9k | 0.7k |
| `mail-react` | 0.4k | none |
| `apps/desktop` | 5.0k | 4.2k |
| Next.js mail route `web/app/(app)/[emailAccountId]/mail` | about 14k | not counted |

The web route also leans on `web/utils/mail-engine` (31 test files) and `web/utils/mail-api` (5.5k lines including tests).

**Maturity verdict.** The architecture is carefully specified and tested, but the client is one month old, and sync correctness fixes are still landing (#4293 "Keep new mail syncing and stop searches paging the whole mailbox", #4201, #4200).

**Target user.** Gmail and Outlook users who want a Superhuman-style client and may pay for the AI assistant layer (prior product report). Nobody on IMAP, iCloud or Fastmail is served.

---

## 2. Feature inventory (client side)

| Feature | Maturity | Evidence |
|---|---|---|
| Unified multi-account inbox | Solid | Queries accept up to 50 `accountIds` (`packages/mail-core/src/queries.ts`). The account switcher has `mod+0` for all accounts (`web/lib/shortcuts/registry.ts`). |
| Split inbox (tabs defined by saved queries) | Moderate | `/api/mail/v1/accounts/[accountId]/splits` (+ reorder, presets). `docs/mail-api-splits.md`. Splits compile to the shared predicate AST. |
| Local full-text search + paged provider search | Moderate | Contentless FTS5 (`mail-sqlite/src/message-search-index.ts`). The engine fetches one provider-search page per page the user has scrolled to (`engine.ts` `requestRemoteSearchPages`). |
| Keyboard model | Solid | 45 registered shortcuts with scopes and key sequences (`web/lib/shortcuts/registry.ts`, 754 lines, with tests) |
| Command palette | Solid | `cmdk`, plus `mail-command-palette.ts` and `snooze-command-palette.ts` |
| Archive / read / star / label / move / spam / trash | Solid | `MetadataChange` union (`mail-core/src/commands.ts`), with per-target outcomes |
| Snooze | Solid but server-dependent | `snooze` change kind. Waking a thread needs a server cron (`web/utils/snooze/*`, `/api/cron/scheduled-actions` runs every minute). |
| Undo send / send later / remind me | Solid but server-dependent | Short undo holds live on the server (`ScheduledEmail`, `heldForUndo`). Long holds wait on the device (`mail-sqlite/src/store.ts` around line 1104). |
| Send-as, reply from the address a message was sent to | Moderate | `from` on drafts and sends; commit #4135 |
| Drafts synced to the provider | Moderate | The engine keeps revisioned local drafts. Autosave also writes a Gmail or Outlook draft through `/api/user/drafts`. Attachments live only on that provider draft (`docs/mail-packages.md`). |
| Contact autocomplete | Moderate | Built from the local cache: `contact_interactions`, `contact_stats` and `contact_tokens` (`mail-sqlite/src/contact-suggestions.ts`). |
| Desktop notifications and Dock badge | Moderate | Alerts never show sender or subject. They are suppressed for mail older than 5 minutes. They follow sync, not a push channel (`apps/desktop/README.md`). |
| Multi-window | Moderate | Up to `MAX_DESKTOP_WINDOWS`, with restored bounds (`apps/desktop/src/windows.ts`) |
| Offline start | Moderate | A Serwist service worker precaches the mail shell (`web/app/sw.ts`); `offline-loading.spec.ts` |
| Diagnostics | Strong | Help → Record Diagnostics (Chromium trace plus content-free JSON), Sentry, engine health metrics, a `debug/mail-queue` page |
| Unsubscribe | Server-side, premium credits | `use-unsubscribe-sender.ts` calls server actions and `decrementUnsubscribeCreditAction` |
| AI in the client | Thin | Assistant panel (`mod+j`), translation through a server action, rule results streamed as "assistant state" |
| Calendar | None in the client | Only meeting-invitation detection (`isMeetingInvitation` on bodies) |
| IMAP / JMAP / CalDAV | None | `providerSchema` is `google` or `microsoft` only (`mail-core/src/identities.ts`) |
| Linux desktop | Not shipped | `electron-builder.yml` builds a `dir` target only |
| iPhone | Closed source | See §3a |

---

## 3. Architecture deep dive

### 3a. Process and deployment topology

There are four runtimes, and **all mail goes through Inbox Zero's server**.

**1. Desktop (Electron 44, `apps/desktop`).**

- **Main process** (`src/main.ts`, 980 lines). It owns:
  - windows and the session partition `persist:inbox-zero`;
  - sign-in through the system browser, which returns via `inboxzero://` with a one-time verifier exchanged at `/api/mobile-auth/exchange-code` (lines ~740-790);
  - notifications, the updater (electron-updater with a generic GitHub-release feed), Sentry, and a context menu.
- **Mail engine.** An Electron `utilityProcess` named "Inbox Zero Mail Engine" (`main.ts` ~line 862, `src/mail-engine/utility-child.ts`).
  - It owns `node:sqlite` at `userData/mailbox.sqlite` and runs the `mail-core` engine loop: `runUntil(now+2s)`, then a 250 ms pause, repeated (`src/mail-engine/owner.ts`).
  - Its only network peer is the Inbox Zero origin. It asks the main process for a fresh cookie header on each request (`cookieHeaderRequest` / `cookieHeader` messages), so it never stores cookies.
  - Main restarts a crashed child with backoff from 1 s up to 60 s, and resets the backoff after 60 s of stable uptime (`utility-host.ts`).
- **Renderer.** This is the surprise: **by default the window loads the hosted web app**, `https://www.getinboxzero.com/welcome-redirect?mode=mail` (`src/desktop.ts:6, 29-31`).
  - The preload exposes `mailEngine`, `mailEngineSubscribe` and `onMailEngineSnapshot` to that remote origin (`src/preload.ts`). `isTrustedDesktopEvent` accepts IPC from the app origin (`main.ts:622-631`).
  - A locally bundled renderer (`src/renderer/main.tsx`, using `mail-ui`'s `MailApp`) runs only when `INBOX_ZERO_LOCAL_MAIL=1`.
  - Their own plan says the opposite: "Mail UI/assets must boot locally after an installed launch without downloading a hosted Next document" (`docs/plans/mail-engine-plan.md` §8). Today the UI code ships through web deploys and the engine ships through desktop releases, so a versioned IPC envelope is their only guard against skew between the two.
- **Hardening.** Windows use `contextIsolation`, `sandbox`, `nodeIntegration:false`, a hardened runtime and notarization. There are no Electron fuses (`rg` found none). The entitlements include `allow-jit` and `allow-unsigned-executable-memory`.

**2. Browser (`web/utils/mail-engine/*`).**
- The same engine runs in a Web Worker on SQLite WASM, persisted to OPFS through the SAH-pool VFS (`wasm-sqlite.ts`).
- One tab owns the database through a Web Lock (`owner-lock.ts`). Other tabs are followers over `BroadcastChannel` (`tab-channel.ts`).
- Without OPFS and Worker support, the runtime mode is `unavailable` (`runtime-mode.ts`). There is deliberately no IndexedDB fallback.

**3. Server (Next.js on Vercel or Docker).**
- `/api/mail/v1/accounts/[accountId]/{capabilities, scopes, bootstrap, enumeration, changes, changes/batch, hydration, conversation-membership, search, attachment-content, operations/[commandId], assistant-state, splits}` plus `/api/mail/v1/devices` (`web/app/api/mail/v1/**`).
- These routes are almost **stateless adapters**. Enumeration tokens and sync cursors are opaque JSON or base64 strings that the client holds (`web/utils/mail-api/source.ts`, `BootstrapToken`).
- The server keeps durable state only where it owns execution:
  - the send ledger (`EmailSendOperation`, keyed by a client mutation ID);
  - held and scheduled sends (`ScheduledEmail`);
  - snoozes (`SnoozedThread`);
  - rule results (`ExecutedRule`).

  Crons drive these (`web/vercel.json`).
- Gmail Pub/Sub and Graph webhooks trigger a push hint (§3c).

**4. iPhone.** It is closed source, and the evidence conflicts:
- The `README.md:55` says "a native Swift app".
- `docs/mail-packages.md` says "The Expo adapter stays in the mobile app. Mobile depends on the published versions" of `mail-core`, `mail-sqlite` and `mail-react`.

What the repo does show is the server side:
- `/api/mobile/mailbox-sync`: a simpler window-plus-cursor sync contract that POSTs `{after|cursor, limit≤100}` and returns provider pages;
- `/api/mobile/threads/batch`, `/api/mobile/all-inboxes`, `/api/mobile/push-token` and `/api/mail/v1/devices` (APNs and FCM token registration);
- background APNs pushes carrying only `{emailAccountId, hint:"mailbox"}` (`web/utils/mailbox-push.ts`);
- Better Auth's Expo plugin for mobile login (`web/utils/auth.ts:50, 284`).

(Inference) The phone probably runs the shared engine against `/api/mail/v1` or the mobile sync route, woken by APNs hints.

### 3b. Connectivity per provider

| | Gmail | Outlook / Microsoft 365 |
|---|---|---|
| API | Gmail REST through `@googleapis/gmail`, plus a hand-built batch caller (`web/utils/gmail/batch.ts`) | Microsoft Graph, with `Prefer: IdType="ImmutableId"` and `odata.maxpagesize` (`web/utils/outlook/mailbox-sync.ts`) |
| Sync strategy | One account-wide stream, `primary`, driven by `history.list` | One stream per mail folder through `/mailFolders/{id}/messages/delta` (`source.ts` `flattenFolderScopes`). System folders are high priority; custom folders are low priority. |
| Push | Pub/Sub `users.watch` → `/api/google/webhook` | Graph subscriptions → `/api/outlook/webhook` |
| Page size served | 50 | 20. Graph allows 4 concurrent requests per mailbox, so batched folder reads run at concurrency 3 (`source.ts:31-33`). |

**Auth model.**
- The user signs in to *Inbox Zero* (Better Auth with Google or Microsoft OAuth). The server stores provider access and refresh tokens, encrypted with AES-256-GCM (prior report, `web/utils/encryption.ts`).
- Clients never see a provider token. The desktop and browser engines send the Inbox Zero session cookie plus an `X-Email-Account-ID` header (`apps/desktop/src/mail-engine/request.ts`).
- The plan names this boundary as the seam for a future direct route. "A later native `MailboxSource` can fetch Gmail/Graph directly while preserving the same product account, engine, SQLite model, and UI contracts", but they chose not to build it yet (`mail-engine-plan.md` §1).

**On-device secrets.** Only the session cookie, held in Chromium's cookie store for the partition. Whether Electron's cookie encryption fuse is on is unverified, since no fuses are configured.

**Mail at rest.** `mailbox.sqlite` is **plaintext**: `node:sqlite` with no cipher (`mail-sqlite/src/node-sqlite.ts`). The plan explicitly defers encryption to "threat model/platform" (§10).

**No IMAP, XOAUTH2 or app passwords** anywhere in the client path.

### 3c. Sync algorithm

The engine (`packages/mail-core/src/engine.ts`, 1,437 lines) talks to five ports:
- `MailboxSource`: describe, discoverScopes, beginBootstrap, enumerate, hydrate, readChanges, an optional readChangesBatch, readConversationMembership, search and readAttachment (`ports/mailbox-source.ts`);
- `OperationExecutor`: execute, inspect and an optional cancel;
- `AssistantStateSource`;
- `MailStore`;
- `HostRuntime`: clock, IDs, sha256 and `storagePressure`.

Every read returns one of three outcomes: `ok`, `paused{retryAfterMs, reason}` or `blocked_auth`. Provider errors never escape as exceptions.

**Scheduling.** Each account gets its own "sync lane", so one slow account never blocks another or the command loop. Lanes time out after 2 min and back off from 1 s to 60 s. Idle catch-up runs every 60 s for high-priority streams and every 10 min for low-priority streams and folder discovery. A push hint or tab focus can pull a low-priority check forward only if it hasn't run in 2 minutes, so a burst of hints stays cheap. The loop yields with `setTimeout(0)` between transactions so the synchronous SQLite driver never starves readers.

**Initial sync (bootstrap).**
1. `beginBootstrap` first captures a catch-up checkpoint: Gmail's current `historyId` (via a 1-message `getMailboxSyncPage`, falling back to `getProfile`) or Outlook's delta link. Only then does enumeration start, so changes that happen during enumeration are replayed afterwards (`source.ts` `catchUpCheckpoint`, `toGmailDeltaCursor`).
2. `enumerate` pages through the mailbox. The scan state is persisted in `bootstrap_scans` (page token, from-checkpoint, catch-up checkpoint, `next_attempt_at_ms`, `error_code`), so a restart resumes mid-scan.
3. `bootstrap_seen_messages` and `bootstrap_existing_messages` record which messages the scan saw. Unseen local messages are tombstoned only after a full enumeration of that scope (`store.ts` `tombstoneUnseen`, `snapshotBootstrapExistingMessages`).
4. A cursor that comes back unchanged is detected and deferred for 60 s.
5. Each lane pass gets a 2 s bootstrap slice and at most 25 pages per run.

**The weak spot (verified).**
- The engine always requests `afterMs: null` (`engine.ts` ~line 704). The server turns that into 0 and never passes a date to the provider, so bootstrap covers the **entire mailbox**.
- For Gmail, each 50-message page is `messages.list`, then `Promise.all` over 50 `messages.get?format=full` calls (`web/utils/email/google.ts:1457-1470`). Each call carries its own 5-try `withGmailRetry` (`web/utils/gmail/message.ts:118-132`).
- Full bodies arrive with every page and are stored for the whole mailbox.
- Any error except an explicit rate-limit-mode flag becomes `paused` with **1 s** retry (`source.ts` `mapProviderError`).
- Their own plan said to do the opposite: "Fetch current inbox metadata first ... Request bodies for visible/selected and nearby conversations at higher priority than historical body backfill" (§1).
- `web/utils/email/local-mail-sync-budget.ts` is a Redis Lua token bucket in quota units, with per-account and per-app in-flight leases. It still has **no production caller**: `syncLocalMail` is defined in `google.ts:1652` and `microsoft.ts:1716` and called only from tests.

**Incremental sync.** A stream position is `{streamId, generation, checkpoint}` (`mail-core/src/sync.ts`).
- **Gmail** (`web/utils/gmail/mailbox-sync.ts`):
  1. Calls `history.list` with `messageAdded`, `messageDeleted`, `labelAdded` and `labelRemoved`. The comment notes that archive is a label event, not a deletion.
  2. Fetches the touched messages with the batch endpoint (100 IDs per batch, with a single-message fallback where only a confirmed 404 counts as a deletion).
  3. Strips the bodies.
  4. Returns metadata patches plus `requiredHydration` keys.
- **Expired cursors.** A Gmail `historyId` 404 restarts a snapshot. A Graph 410 does the same. Messages that fall outside the time window are reported as deleted.
- **Hydration.** Bodies come from separate `/hydration` jobs (20 keys each), which the server fetches **sequentially** (`source.ts` `hydrate`).
- **Re-download on label changes (inference).** A Gmail message's version is its `historyId` (`web/utils/mail-api/observations.ts:99`). The store re-hydrates whenever the stored body's version is older than the message's (`store.ts` `contentCoversMessageVersion`). Gmail bumps a message's `historyId` on label changes. So a read or archive done in another client probably re-downloads that message's full body, on top of the batch metadata fetch.

**Applying pages.** `applySyncPage` refuses a page as `stale` unless the account generation and the stream's stored checkpoint exactly equal the page's `from` (`store.ts:669-741`). If they match, the changes, the body inserts, the hydration jobs, the new checkpoint and a revision bump all commit in **one transaction**. This compare-and-set rejects late, duplicate and out-of-order responses, which is the property the plan lists as guarantee 5.

**Push.** The design is "poke, then pull": push never carries mail.
1. Webhooks call `notifyMailboxChanged` before processing history (`web/app/api/google/webhook/route.ts:83-90`).
2. It publishes on Redis channel `local-mail:{account}`, but only if a client has shown interest in the last 75 s, and with a 2 s cooldown.
3. It also sends APNs or FCM background pushes, with a 20 s cooldown (`web/utils/redis/local-mail-hints.ts`, `web/utils/mailbox-push.ts`).
4. Clients hold an SSE connection to `/api/mail-stream` (`web/app/api/mail-stream/route.ts`):
   - `ready` on connect, `mailbox-change` on hints, `heartbeat` every 25 s, and the server closes the stream after 270 s;
   - every reconnect's `ready` is treated as "something changed".
5. On each hint the desktop engine calls `requestSync` for that account. It reconnects with backoff from 1 s up to 30 s and rescans its account list every 5 s (`apps/desktop/src/mail-engine/mailbox-signals.ts`). The browser drops SSE in hidden tabs (`web/utils/mail-engine/follow-mailbox-changes.ts`).
6. If no hint arrives, the 60 s idle catch-up still runs.

**Rate limits, retries and backoff.** There are four layers:
- Gmail per-call retries (`withGmailRetry`, prior report);
- the server's `paused` mapping (1 s, or 15 s in rate-limit mode, or 30 s for unstructured HTTP errors in `backend-adapter.ts`);
- engine lane backoff (1 to 60 s);
- operation retries, which use the server's `retryAfterMs` or **1 s** with no exponential growth (`store.ts` `settleAttempt`).

None of these layers budgets in quota units.

**Conflict resolution.**
- Provider state lives in `messages`, as "confirmed" data. User intent lives in `operations`.
- `effective_messages` is derived by replaying pending operations over the confirmed state (`mail-core/src/effective-state.ts` `deriveEffectiveMessage`) and recomputed in the same transaction whenever either side changes (`store.ts` `recomputeTargets`).
- Later operations on the same message wait for earlier ones (`hasUnsatisfiedDependency`).
- A completed archive is not a standing rule. If the conversation later returns to the inbox, that is accepted as provider truth (plan §5).
- Conversation-level commands first enter a `preparing` state. The engine pages through the server's `conversation-membership` to freeze the exact target message IDs, so it never treats a partially loaded thread as the whole thread.

**Offline outbox.**
- The `operations` table holds up to 5,000 entries (`MAX_QUEUE`).
- Operations move through 12 states, from `preparing` and `queued` through `uncertain`, `needs_attention`, `succeeded` and `superseded` (`mail-core/src/operations.ts`).
- Claims use 30 s leases. A lost lease never re-sends a send: it moves to `inspect`, which asks the server ledger what happened (`store.ts` `claimWork`).
- Sends are idempotent through a deterministic UUID derived from the operation ID (`web/utils/mail-api/operations.ts` `sendMutationId`):
  - the server ledger rejects a reused ID that comes with a different payload hash;
  - a `PROCESSING` row whose lease expired becomes `UNCERTAIN` rather than being retried (`web/utils/email/durable-email-send.ts`).
- Undo windows under 1 hour are handed to the server immediately, "so the undo period survives the client going away". Longer connectivity holds stay on the device until `requestSync` releases them (`store.ts:1104-1110`).

### 3d. Local storage

**Engine and connections.**
- Desktop and Node use `node:sqlite` with WAL and `synchronous=NORMAL`. A separate **read-only reader connection** means reads never queue behind writes, and each connection runs its transactions in order (`node-sqlite.ts`).
- The browser uses SQLite WASM on OPFS with one serialized chain.
- A shared driver contract checks commit and rollback, serialized writes, read consistency, blobs, savepoints and close/reopen (`mail-sqlite/test-support/driver-contract.ts`).

**Schema** (`mail-sqlite/src/migrations.ts`, plus index modules):

| Table | Purpose and key columns |
|---|---|
| `profile_state` | Singleton `database_epoch`, a monotonic `sequence` (the revision) and `owner_fence` |
| `accounts` | `account_id`, `provider`, `generation`, `assistant_cursor`, `connection` |
| `messages` | Confirmed provider facts, stored as normalized columns rather than JSON: subject, preview, from, to/cc/bcc JSON, `received_at_ms`, read, starred, `folder_id`, `inbox_section` (Focused/Other), label/category/role JSON, `in_inbox`/`in_sent`/`in_draft`/`in_trash`/`in_spam` flags, `has_attachments`, `snoozed_until_ms`, `version`, `deleted`. Primary key `(account_id, message_id)`. |
| `message_content` | `html` and `text` as **raw-deflate BLOBs behind a 1-byte format marker** (HTML messages keep no text copy), plus `attachments_json`, `is_meeting_invitation` and `version` (`message-body-codec.ts`) |
| `effective_messages` | The derived view (confirmed plus pending), with `pending_operation_ids_json`. Indexed on `(account_id, in_inbox, received_at_ms DESC, …)`. |
| `effective_role_conversations`, `effective_message_memberships` | Conversation summaries and label membership, maintained by **SQL triggers** (`conversation-index.ts`) |
| `operations`, `operation_targets`, `operation_conversations` | The durable command queue with hashes, receipts, leases, attempts and per-target outcomes |
| `drafts` | `(account_id, draft_id, revision, content_json, frozen, updated_at_ms)`. Saves use compare-and-set on `expectedRevision`. |
| `sync_streams`, `sync_jobs`, `bootstrap_scans`, `bootstrap_seen_messages`, `bootstrap_existing_messages`, `coverage`, `conversation_completeness` | Sync progress, durable hydration and search jobs, and explicit per-scope `metadata`/`content`/`indexed_content` completeness |
| `message_fts` (FTS5) | A **contentless** index (`content=''`, `contentless_delete=1`, which needs SQLite 3.43+) over subject, preview, from and visible body text, with `message_fts_keys` mapping rowids. It is filled in engine-paced batches of 100 (`indexSearchBacklog`). |
| `contact_*` | Recipient suggestions |
| `assistant_entries` | The server's rule results, keyed by entry and revision |

**What is stored.** Full bodies for everything enumerated. **No attachment bytes**: they stream from `/attachment-content`, and compose attachments live on the provider draft.

**Eviction.** It is crude. When free disk drops below 64 MiB (`apps/desktop/src/mail-engine/storage-pressure.ts`), the engine deletes **every** body and clears the whole FTS index once, then marks coverage partial (`mail-sqlite/src/maintenance.ts`). There is no LRU and no age-based cap.

**Migrations.**
- One idempotent `CREATE TABLE IF NOT EXISTS` script.
- About 15 `ALTER TABLE ... ADD COLUMN` statements, each wrapped in `try {} catch {}` that swallows *any* error.
- Numbered data migrations recorded in `schema_migrations` (ids 1-9).
- The body-compression migration (0008) converts existing rows in batches when the store opens.

**Corruption.** On SQLITE_CORRUPT or NOTADB the files are renamed `*.corrupt-<ts>` and the mailbox is rebuilt from the server (`openOrQuarantineNodeMailbox`).

**Scale testing.** A 10k-conversation regression runs in the normal suite, and larger runs are opt-in with `SCALE_TESTS=1` (`mail-sqlite/README.md`). There are also query and body-compression benchmark scripts.

### 3e. The API between UI and engine

**Shape.** UIs only ever see `MailClient` (`engine.ts:116-155`):
- *Observations* return a `QueryHandle {getSnapshot, subscribe, close}`: `observeMailbox`, `observeMailboxCounts`, `observeMailboxWindow` (with `loadMore`), `observeConversation` and `observeOperation`.
- *Commands* return an `Admission`: `submitMetadata`, `submitConversations`, `submitSend`, `cancelOperation`.
- *Drafts*: `saveDraft` (compare-and-set) and `readDraft`.
- *Work hints*: `requestSync`, `ensureMessageContent`.
- *Maintenance*: `getDiagnostics`, `purgeAccount`, `retainAccounts`.

Every snapshot carries a `revision {databaseEpoch, sequence}`, a `status`, a `refreshing` flag and explicit `coverage`. "Empty local results never prove that the provider mailbox is empty" (plan §2).

**Transport.**
- Every request is an envelope of `{protocolVersion, requestId, method, payload}`, validated by a Zod discriminated union (`mail-core/src/protocol/mail-ipc.ts`).
- On desktop, `ipcRenderer.invoke('mail-engine')` reaches main, main forwards to the utility child, and observations use `mail-engine-subscribe`, with pushed `mail-engine-snapshot` events (`apps/desktop/src/mail-engine/push-ipc.ts`).
- In the browser, the same client talks to the worker via `postMessage`, and followers reach the owner over `BroadcastChannel`.

**Realtime propagation.** It is deliberately simple.
- After any committed write, the engine calls `refreshAll()`, which **re-runs every open query** against SQLite.
- It then compares each result's JSON with what it last published and pushes the full snapshot only if it changed (`mail-core/src/subscriptions.ts`).
- A follow-up load coalesces requests that arrive while a load is in flight.
- No diffs are sent. React reads snapshots through `useSyncExternalStore` (`packages/mail-react/src/use-query-snapshot.ts`).
- `use-warm-neighbour-threads.ts` keeps the conversations next to the open one subscribed, so `j`/`k` lands on data that is already loaded.

**Pagination.**
- Lists use keyset cursors on `(latest_at_ms, account_id, conversation_id)` (`mailbox-view-readers.ts`).
- Windows grow by page, capped at 40 pages (`MAX_MAILBOX_WINDOW_PAGES`).
- The thread list is not virtualized and uses a "load more" button, even though `@tanstack/react-virtual` is a dependency.

### 3f. Send, drafts, threading, labels, calendar, AI

- **Send.**
  1. The draft revision is frozen and a `send` operation is admitted with `to`/`cc`/`bcc`, HTML, quoted HTML and an optional `providerDraftId`.
  2. The server executes it through `executeDurableEmailSend`, so the provider builds the MIME and sends it from the mailbox draft that holds the attachments.
  3. The sent copy is observed and linked through `operations.sent_message_id`.
  4. The UI offers "view sent email" in the toast (commit #4142).
- **Drafts.** There are two layers:
  - **Engine drafts** are local, revisioned and compare-and-set.
  - **Provider drafts** are autosaved through `/api/user/drafts`. A code comment notes that Gmail rebuilds the whole message on every save.
  - If the provider draft disappears (a definite `DRAFT_NOT_FOUND`), the local copy is cleared, but an unreachable mailbox keeps the user's text (`web/utils/mail-engine/reply-drafts.ts`). Your phone sees drafts because they live in Gmail.
- **Threading.** Uses the provider's own conversation IDs (Gmail `threadId`, Graph `conversationId`). Conversation actions resolve the thread's membership on the server before execution (§3c).
- **Labels and folders.** One normalized model covers both:
  - roles (`inbox`, `sent`, `draft`, `trash`, `spam`), plus `folderId`, `labelIds`, `categoryIds` and `inboxSection`;
  - `container_upsert` and `container_removed` changes;
  - a `move` change for folders and a `set_membership` change for labels and categories (`mail-core/src/commands.ts`, `messages.ts`).
- **Calendar and contacts.** No calendar UI. Contacts are suggestions only.
- **AI.** Entirely server-side. The client receives rule outcomes as a separate cursor-paged feed: `ExecutedRule` rows keyset-paged by `(updatedAt, id)` (`web/utils/mail-api/assistant-state.ts`), stored in `assistant_entries`. The plan rule: "A suggestion is not a confirmed mailbox mutation" (§8).

---

## 4. Engineering quality

**Tests** (verified counts of test files and approximate `it(` cases):

| Area | Files | Cases | Notable coverage |
|---|---|---|---|
| `mail-core` | 9 | ~64 | |
| `mail-sqlite` | 22 | ~174 | Bootstrap, retention, send hold, purge, search, and a 523-line query corpus. `store.test.ts` checks the store against a reference model (`mail-core/test-support/reference-model.ts`). |
| `apps/desktop` | 26 | ~144 | Packaged-renderer and hosted-Electron tests run under `xvfb-run` in CI (`.github/workflows/test.yml` `electron` job) |
| `web/utils/mail-engine` | 31 | ~162 | |
| `web/utils/mail-api` | 5 | ~81 | |
| Mail UI route | 32 | ~191 | |
| Emulated-provider Playwright | 51 specs | | `web/__tests__/playwright/emulated/mail/`, including `archive-reconciliation`, `draft-send-recovery`, `hosted-electron-send`, `offline-loading` and `mail-engine-startup` |

**CI.**
- `test.yml` runs package tests and the Electron job.
- `desktop-release.yml` handles signed, notarized macOS and Windows builds and publishes the update feed to a `desktop-updates` release.
- `mail-packages-release.yml` publishes to npm with `--provenance`.

**Organization.**
- Ports and adapters with written import bans. `mail-core` may not import React, the DOM, Electron, Expo, Next, Prisma, Redis or Node modules, and `scripts/check-imports.mjs` enforces this.
- The schemas are shared between the IPC and HTTP protocols.

**Observability. This is the strongest area to learn from.**
- Desktop Sentry runs with `sendDefaultPii:false`, strips URL query strings, and drops console breadcrumbs because they "can include mail content" (`apps/desktop/src/sentry.ts`).
- The engine child reports event-loop delay, SQLite read and write durations measured from the call (so queue wait counts), and command latency (`utility-child.ts`).
- `getDiagnostics(accountId)` returns connection state, coverage, pending and uncertain operation counts, and the command list. A `debug/mail-queue` page shows the queue.
- Help → Record Diagnostics writes a 30 s Chromium trace plus a content-free `diagnostics.json` (`apps/desktop/README.md`).

**Weaknesses.** Plan and implementation have drifted apart (no metadata-first bootstrap, no locally booted UI by default, an unused Redis budget). Migrations swallow `ALTER TABLE` errors, retries are a fixed 1 s, and `store.ts` is 3.4k lines. The engine landed as one 583-file, mostly agent-written PR, and commit #4260 "Remove low-value unit tests" admits that some tests just restated the code.

---

## 5. UI notes

**Stack** (verified from `web/package.json`):
- Next.js 16 App Router, React 19, Tailwind;
- Radix/shadcn primitives, `cmdk`, `sonner` toasts;
- both `motion` and `framer-motion` 14.4;
- Jotai and SWR, `react-hotkeys-hook` 5.3.

The desktop forces a light native theme (`nativeTheme.themeSource = "light"`, `main.ts`).

**Motion constants** (verified):

| Animation | Timing | Details |
|---|---|---|
| Archive exit | 80 ms, `cubic-bezier(0.2, 0, 0, 1)` | The archived row is cloned into a fixed-position ghost, so focus and the live list can advance at once. The ghost slides 32 px left and fades out over an opaque backing (`web/app/(app)/[emailAccountId]/mail/use-optimistic-archive.ts`). |
| Rows below close the gap | 100 ms delay, then 100 ms, same curve | FLIP-style measurement. Skipped under `prefers-reduced-motion`. |
| Split tabs, tab move | 150 ms `easeOut` | `SplitTabs.tsx:352-353`, `LayoutGroup`; duration 0 under reduced motion |
| Split tabs, underline | 200 ms `easeOut` | Same file |

Motion elsewhere in the mail UI is minimal. Recent commits are about calming the chrome ("Calm the list chrome", #4330).

**Keyboard model.**
- One registry of 45 shortcuts with `global` and `mail` scopes, groups, labels and key sequences written `g>a` (`web/lib/shortcuts/registry.ts`, `useShortcuts.ts`).
- Gmail and Superhuman muscle memory: `j/k`, `enter`, `esc`, `x`, `shift+j/k` to extend the selection, `e`, `s`, `l`, `u`, `v`, `h` (snooze), `#`, `!`, `r/a/f`, `z` (undo), `c`, `/`, `.` (more), `mod+k` (palette), `mod+j` (assistant), `mod+shift+l` (send later).
- A shortcuts dialog renders from the same registry, and tooltips show each command's key.

**Email HTML.**
- `DOMPurify` runs first, then tracking pixels (1 px or smaller) are removed and plain links are linkified (`packages/mail-ui/src/sanitize-html.ts`).
- The result renders in an `<iframe srcdoc>` with `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"` and **no `allow-scripts`**.
- An injected CSP meta tag sets `default-src 'none'`, `script-src 'none'`, `connect-src 'none'` and `form-action 'none'`. Images are limited to `data:`/`blob:` plus either the image-proxy origin or `https:` when the user allows remote images (`MailBody.tsx:330-361`).
- Dark mode is applied as a transform when appropriate.

---

## 6. Lessons for Aplos

**Adopt (ideas only):**

1. **One engine contract, many hosts.** Aplos already has `src/engine/ports.ts`. Go further, the way IZ did: one `MailboxSource`-style interface with `paused` and `blocked_auth` results instead of thrown errors, one `OperationExecutor`, one store port and one runtime port. Then Gmail, Graph, IMAP and JMAP are four sources behind one engine, and the engine can run in a utility process, a daemon or a test.
2. **Confirmed vs. effective state.** Store provider truth in normalized columns. Store user intent as durable operations. Derive what the UI shows in the same transaction. This replaces Aplos's `touched` and merge heuristics, and its `structuredClone(state)` on every change, with something that scales and that tests can check.
3. **Live queries instead of shipping state.** Snapshot handles with a revision, re-run on commit, unchanged results suppressed by JSON comparison. Lists are paged by keyset cursor. This directly removes Aplos's O(mailbox) clone-and-IPC per click.
4. **Bootstrap done right, in shape.** Capture the checkpoint (`historyId` or delta link) *before* enumerating. Persist the scan page by page. Compare-and-set every page against the stored checkpoint. Tombstone unseen messages only after a complete scan of that scope. This fixes Aplos's ignored `reset:true` ghosts.
5. **Coverage is explicit.** Track metadata, content and indexed-content completeness per scope, so the UI can say "not synced yet" instead of showing an empty inbox.
6. **Poison-message isolation.** Clamp sender-controlled fields to fit, and drop only the one message that still can't be represented, so a single bad message can't stall an account's sync forever (`observations.ts:129-147`).
7. **Push is a hint, never data.** One "something changed" signal with a cooldown and an interest TTL, after which the engine pulls from its checkpoint. For Aplos without a server: IMAP IDLE and JMAP EventSource feed the same `requestSync` path.
8. **App-owned metadata gets its own cursor feed,** separate from mailbox facts. This is the clean version of Aplos's hidden-label workflow sync, and exactly what a local daemon can serve to a phone.
9. **Send safety.** A deterministic mutation ID per send, a ledger that rejects a reused ID with a different payload, and "uncertain → inspect, never resend".
10. **Observability as a feature.** Per-account `getDiagnostics`, a queue inspector, a Record Diagnostics bundle without content, Sentry with PII scrubbing, and SQLite and event-loop timing. Aplos has none of these today.
11. **Email HTML in a script-less sandboxed iframe with a strict CSP meta tag.** Styles can stay intact inside it. This closes Aplos's biggest security hole.
12. **Storage choices.** Compressed body BLOBs in their own table, a contentless FTS5 index, a read-only WAL reader connection, a driver contract test, and checking the SQL against a reference model.
13. **A single shortcut registry** that feeds handlers, the help dialog and tooltips.

**Avoid:**

1. **Whole-mailbox, full-body bootstrap with a 50-way fan-out and 1 s retries.** This is exactly Aplos's 403 problem, only bigger. Bootstrap the inbox's metadata first with a date window, fetch bodies lazily for visible and nearby threads, and run one paced request queue per account, budgeted in quota units.
2. **A message version that changes on label-only edits** (inference, Gmail `historyId`). If Aplos keys body freshness on a version, use one that only changes when the content does.
3. **Evict-everything under disk pressure.** Prefer age- or size-capped body retention with on-demand re-hydration.
4. **Swallowed `ALTER TABLE` errors.** Keep Aplos's strict `user_version` migrations.
5. **Loading the UI from a remote origin inside the desktop shell.** It brings version skew, an offline dependency on a service worker, and a remote origin trusted with local engine IPC.
6. **Putting a server between the user and their mail.** IZ chose this for login reuse and assistant control. It costs privacy and restricted-scope verification, and it makes the server a hard dependency for reading mail. Aplos's direct-to-provider path is its differentiator; keep it.
7. **Fixed-interval retries without backoff and jitter on the operation queue.** Aplos's 30 s to 15 min backoff is better. Keep it.
8. **Over-engineering for a team of one.** IZ has 12 operation states, preparation phases, leases and owner fences across tabs. Aplos has one process owner and no browser tabs, so it can use about half of that machinery.

---

## 7. "Local server" translation

**What IZ's design actually is.** IZ's "server" splits into three parts:
- **(a)** a nearly stateless *provider adapter API*. Cursors and scan tokens are opaque values the client holds; the server just executes one page at a time.
- **(b)** *durable work the server owns*: the send ledger, undo and scheduled sends, snooze wake-ups, rule execution and webhooks.
- **(c)** a *hint channel*: SSE for desktop and browser, APNs for the phone.

Every client then runs its own **full replica engine** in local SQLite and syncs it against (a).

**Two ways to map this onto an Aplos daemon:**

| | A. "IZ shape": daemon = adapter + durable work, clients = replicas | B. "Engine as server": daemon = engine + replica, clients = views (JMAP-like) |
|---|---|---|
| What runs in the daemon | Provider adapters, Keychain tokens, send ledger, scheduled work, IDLE/EventSource/poll hints | Everything in A, **plus** the SQLite replica, live queries and the op queue |
| Electron UI | Its own engine and SQLite, so two copies on one Mac | A thin client: `observe*`/`submit*` over IPC or a socket |
| Phone | Its own replica, syncing via `/changes?cursor` against the daemon | Can be thin (online only) or keep a small replica fed by a revision-ordered change log |
| Fits Aplos today | Poorly: duplicates storage on the Mac | Well: Aplos's engine already runs in a utility process with `{epoch, rev}` events (`src/shared/live.ts`) |

**Recommendation: B for the Mac, with an IZ-style replica feed for the phone.** The daemon is the only engine and the only holder of tokens. It exposes two API families, both versioned with shared Zod schemas, using the same `{protocolVersion, requestId, method, payload}` envelope idea:

1. **View API, for the Electron renderer and browser preview.**
   - Methods: `observeMailbox`, `observeConversation`, `observeCounts`, `observeOperation` (subscribe, then receive snapshots), `submit*` commands, `saveDraft` with an expected revision, `requestSync`, `ensureContent`, `diagnostics`.
   - Transport: inside the app, Electron `MessagePort` (as today). Outside it, WebSocket for observations and HTTP for commands on `127.0.0.1`.
2. **Replica API, for the phone.**
   - `GET /changes?since=<epoch:seq>` returns normalized message patches, tombstones, op outcomes and app-metadata entries, ordered by the daemon's local revision. A mismatched epoch means "reset", the same way IZ uses `databaseEpoch`.
   - `/bodies?ids=…` and `/attachments/:id` stream content on demand.
   - Commands use the same operation IDs, so retries are idempotent through the daemon's ledger.
   - Wake-ups: while the phone app is foregrounded, a held SSE or WebSocket "poke". In the background, APNs requires an Apple push key, which belongs in a relay rather than shipped in the Mac app. Until then, the phone syncs when opened.

**Process and transport details for macOS:**
- **Lifecycle.**
  - **Start:** keep the engine as an Electron `utilityProcess` while the app runs, and offer "keep syncing when the window is closed" (the IZ desktop does this by hiding the last window).
  - **Later:** a separate LaunchAgent registered with `SMAppService`, so the engine survives the UI quitting.

  The second step means a separately signed helper, an update handshake between helper and app versions, and a single-instance lock.
- **Local transport security.**
  - For the Electron UI: a Unix domain socket in the app's container directory with mode 0600, or simply keep `MessagePort`. No TCP needed.
  - For browser preview: the existing `server.ts` approach (127.0.0.1, Host and Origin checks) **plus** a per-launch bearer token. Today any local process can drive it.
- **Phone transport.** Bind to Tailscale or a LAN interface only after a device-pairing step: a QR code carrying the daemon's public key, with per-device keys you can revoke. Use mutual auth such as Noise or TLS with pinned keys. A relay for off-network access must be end-to-end encrypted so it never sees mail.

**Pros:**
- **One replica, one per-account request queue and quota budget.** This is the structural fix for the 403s: every surface's demand is paced in one place.
- Tokens live in one Keychain-backed process. UI crashes are isolated, and browser preview becomes the same API instead of a dev-only fork.
- IDLE and JMAP push, scheduled sends, snooze wake-ups and rules can run while the Mac is awake, with no window open.
- The phone gets a path without Aplos becoming a hosted service.

**Cons and risks:**
- It still isn't 24/7. A sleeping Mac sends no scheduled mail, so provider-side filters remain the only always-on automation.
- A listening service adds attack surface (DNS rebinding, local malware, LAN exposure). Two binaries mean signing, notarization and update coordination.
- The phone is useless when the Mac is off unless it keeps its own replica and can fall back to the provider directly, which reopens OAuth on the phone. APNs needs a relay someone has to run.

**Effort (one developer plus agents; inference):**

| Stage | Work | Estimate |
|---|---|---|
| 1 | Normalized schema, live queries and the effective-state model behind a typed protocol. Needed regardless, to fix memory and clone costs. | 2-3 weeks |
| 2 | Run the view API over `MessagePort` and a token-protected localhost WebSocket. Delete the duplicate allowlists. | ~1 week |
| 3 | Background mode in the utility process, plus IMAP IDLE and JMAP push into `requestSync` | ~1 week |
| 4 | A LaunchAgent helper with update handshake | 1-2 weeks, optional |
| 5 | Phone: pairing, replica API, a minimal iOS client | 4-8+ weeks |
| 6 | Relay and APNs | Later |

**The single most useful thing to copy from IZ's design** is not the server. It is the **contract**: opaque checkpoints, per-page compare-and-set commits, confirmed vs. effective state, operations with receipts, and live queries with revisions. Those carry over unchanged whether the engine lives in a utility process, a LaunchAgent, or someday a phone.
