# `renderer/data`: the renderer data surface (F9)

This folder holds the one way the new screens read mail and send commands to the engine. It is part of Phase 0 artifact F9 and freezes on day 3 (2026-10-29). After the freeze, changes are **additive only**: members can be added, but nothing is renamed or removed. Lane `ui-shell` owns the folder and builds the real implementation in U2 (days 4-8). Plan 30 section 4.1 is the design.

| File | What it is |
|---|---|
| `index.ts` | The frozen public surface: hooks, `api`, receipts, holds, constants and the contract mapping. Screens import only from here. Until U2 lands, every hook and method throws `NotImplementedError` naming lane `ui-shell`. |
| `contract-shapes.ts` | Provisional wire types (rows, view specs, frames, status, settings). They are re-exported from `index.ts`. |
| `index.test.ts` | Compile-time usage examples for Home, the reader and the status slot, plus runtime checks that every stub throws and every `api` method has a contract mapping. |

Run the tests with `npx tsx --test apps/desktop/src/renderer/data/index.test.ts`. `npm test` does not pick them up yet, because it only globs `apps/desktop/tests`. `npx tsc --noEmit -p apps/desktop/tsconfig.json` checks the examples and the `@ts-expect-error` lines.

## The surface in plain words

**Lists are windows.** `useView(spec, {holdIds})` watches one view in the engine. It returns the ordered ids in the current window (at most 200), the window's offset, the total, rows by id from the row cache, groups with counts (Home sections, Later buckets, Low senders), the window state, a status (`opening`, `live`, `reset`) and `move(range)` for scrolling. The renderer never holds a whole mailbox.

**Home has a helper.** `useHome({accountId, holdIds})` turns the `home` and `home.low` views into what DESIGN 7.2 draws: Do now (with Back from Later at its bottom), Important updates and Follow up, always in that order, each with its ids, count, start index and a `visible` flag. A section emptied during a hold stays `visible` and shows 0 until the hold releases (DESIGN 5 rule 6). Rows that arrive during a hold are counted in `waiting` ("2 new"). The Low importance band gives the count, up to three sender names and "and N more".

**Rows are cached.** `useRow(type, id)` returns one row (Thread, Message, Account, Draft, Submission or Operation). The object stays the same while its `rev` is unchanged, so it is safe in memo dependencies.

**Commands act first.** `api.thread.act(ids, action)` applies the optimistic overlay before it returns, so key-to-state stays within 8 ms (DESIGN 5 rule 1). It returns `{opId, receipt}`. `useOperation(opId)` reports `pending`, `confirmed` or `failed` and offers `retry()`. A rejected write puts the row back in its place with an inline error and Retry (DESIGN 5 rule 11), which list screens read from `failures`. Undo is an inverse operation (`api.operation.undo`, or `undoLast` for Z), never a delayed commit.

**Holding still has two halves.** `useHold(scope)` is the renderer half. `begin(reason, ids)` starts on a triage key or pointer rest, `extend()` pushes the release back, and `release()` ends it. It releases 450 ms after the last key, never later than 1,200 ms. `onRelease` is where the motion lane runs `close` (FLIP). The engine half is `heldIds`, passed to `useView` or `useHome` as `holdIds`, so an AI re-rank cannot move the rows around the cursor.

**Prefetch on intent.** `usePrefetchIntent()` prefetches the body and both neighbours after 80 ms of keyboard focus or 120 ms of hover, and cancels on move (DESIGN 5 rule 9). `api.body.prefetch(ids)` is the raw call. `useMessageBody(id)` loads one body and sets `slow` after 1.5 s, so the reader can show its 12 px line while it keeps the previous letter (DESIGN 5 rule 10).

**Session and status.** `useSession()` returns the API version, capability flags and `hasAccounts`. `useAccounts()` returns each account with its status (ARCH 6.4) and the `reconnectBy` fact. `useStatus()` picks the single line the status slot shows, most urgent first. `useCounts()` gives the sidebar counts (Home is Do now plus Important updates, Later is what is due now, plus Drafts) with `hidden` set during first sync. `useSetupStatus()` drives the first-sync screen, and `useSettings()` reads the settings, including the `ui` object.

**The rest of `api`.** Submissions (send, send later, undo, send now, reschedule), drafts (save, discard, resolve a conflict), bodies and the mail frame, attachments as blobs, sync requests, account connect and reconnect (with cancel), setup begin and end, demo mail, settings, Ask with progress frames, and interactive AI (draft, polish, summary, transcribe).

**Not here.** Transport selection (a MessagePort in Electron, the tokenised HTTP and SSE binding in the browser preview) belongs in `renderer/bridge.ts`, which `ui-shell` reduces to that job in U2. This folder never imports today's renderer, `shared/live`, `AppState` or `engine/*`.

## Provisional types

The Engine thread is writing the real contract (F1, `packages/contract`) and its typed client (F2) in parallel. Until they freeze, `contract-shapes.ts` declares stand-ins that mirror ARCH 9, plan 10 (4.1, E3-E6) and plan 30 (4.1, 8.1), using the field names those plans already use. Each one carries the comment `provisional: replaced by import from @aplos/contract at the freeze`.

The swap is mechanical. Delete each declaration and re-export the contract type under the same name. Where F1 chooses a different field name, the data layer adapts it inside `ui-shell`, and screens keep the names in this folder. The F2 client sits under `api`: each `api` method maps onto one contract method, listed in `CONTRACT_METHODS` in `index.ts` and checked complete at compile time.

## Release rule

No release ships before the switch to the real engine (plan 30 4.1, build-order step 2). Screens that run only on the stand-in engine are development builds. Nothing the owner installs for daily use may show stand-in data in place of real mail. The `srcdoc` mail frame is a development path for the stand-in engine and is never a shipped fallback (ARCH 10).

## What this surface asks of the contract (F1)

The Engine thread and the day-3 freeze reviewer should check F1 against this list. **Planned** means plan 10 or ARCH already names it, and the surface only needs the shape shown. **Ask** means this surface needs something the plans do not yet state, or state differently.

### Methods behind `api`

| `api` method | Contract method or frame | Source | Needs |
|---|---|---|---|
| `thread.act` | `Thread/act` | planned | `{opId, ids, action}` for every `ThreadAction` kind below; returns `receipt {opId, appliedState}` |
| `thread.why` | `Thread/why` (name is eng-contract's call) | ask | `{threadId}` → `{sentence, quote, rankSource}` (DESIGN 9 rule 4) |
| `thread.followup` | `Thread/followup` (name is eng-contract's call) | ask | `{threadId}` → `{threadId, text}` or null; the output of eng-ai's `followup` job |
| `thread.unsubscribe` | `Unsubscribe/run` | planned | `{threadId}` → receipt |
| `operation.undo` | `Operation/undo` | planned | `{opId}` → a receipt whose `opId` is the inverse operation's |
| `operation.undoLast` | `Operation/undo` | planned | The data layer tracks the last undoable `opId` |
| `submission.send` | `Submission/set` | planned | `{action: send, draftId}` → `{submissionId, receipt}`; `notBefore` = now + `undoSeconds` |
| `submission.sendLater` | `Submission/set` | planned | `{action: send, draftId, notBefore}` |
| `submission.undo` | `Submission/set` | planned | `{action: undo, submissionId}` |
| `submission.sendNow` | `Submission/set` | ask | `{action: sendNow, submissionId}`, valid for queued, suspended ("Send now"), uncertain ("Send anyway") and failed ("Try again") |
| `submission.reschedule` | `Submission/set` | ask | `{action: reschedule, submissionId, notBefore}` for suspended ("Reschedule") and queued sends |
| `draft.save` | `Draft/set` | planned | Create, or update with `baseRevision` (compare-and-set); `stateMismatch` on conflict |
| `draft.discard` | `Draft/set` | planned | Destroy |
| `draft.resolveConflict` | `Draft/set` + `Draft/changed` frame | ask | `{draftId, resolve: keepMine, takeTheirs or keepBoth}`; the frame sets `changedElsewhere` on the row |
| `body.get` | `MessageBody/get` | planned | `{messageId}` → `{bodyKind, text, quotedRanges}` |
| `body.prefetch` | `MessageBody/prefetch` | planned | `{ids}` with a way to cancel |
| `mail.frame` | `Mail/frame` | planned | `{messageId, imagePolicy, findQuery}` → `{url, expiresAt, bodyKind, trackersRemoved, hasRemoteImages, quotedCount}`; ask: the stand-in also returns `srcdoc` for the development frame, and the real engine never does |
| `mail.releaseFrame` | `Mail/frame.release` | planned | `{url}` |
| `attachment.get` | blob route (`GET /v1/blob/:id`, transferable `ArrayBuffer` on MessagePort) | planned | Never base64 |
| `sync.request` | `Sync/request` | planned | `{accountId?}`; also ends a throttle pause, for "Retry now" |
| `account.connect` | `Account/connect` | planned | `{provider, loginHint?}` → request id, progress, cancel |
| `account.reconnect` | `Account/reconnect` | planned | `{accountId}` with `login_hint`, no resync, queued changes kept; ask: a cancel for the sheet's Cancel |
| `setup.begin`, `setup.end` | `Setup/begin`, `Setup/end` | planned | `end` is idempotent; the UI calls it on every window close |
| `demo.load`, `demo.reset`, `demo.remove` | `Demo/load`, `Demo/reset`, `Demo/remove` | planned | Idempotent; they touch only demo accounts |
| `settings.get`, `settings.set` | `Settings/get`, `Settings/set` | planned | `Settings` with the `ui` object (below); `set` merges a partial update |
| `ask.run` | `Ask/run` + `progress` frames | planned | Frames `step`, `text`, `citation {n, messageId, quote}`, `proposal`; cancel |
| `ai.request` | `Ai/request` | planned | Kinds `draft`, `polish` (returns changes, never applied by themselves), `summary` |
| `ai.transcribe` | `Blob/put` + `Ai/request {kind: transcribe, blobId}` | ask | Audio as a transferable buffer; returns `{text}` |

### What the hooks need

| Hook | Contract method or frame | Source | Needs |
|---|---|---|---|
| `useView` | `View/watch`, `View/move`, `View/unwatch`, `window` and `reset` frames, `Thread/get`, `Message/get` | planned | `View/watch {spec, holdIds?}`; the spec union below; `window {windowId, state, ids, total, changed}` |
| `useView` | `window.offset` | ask | Index of `ids[0]` in the whole view (approximate under keyset), so a virtualised list can place the window |
| `useView`, `useHome` | `window.groups` | ask | `[{key, label?, count, start}]` across the whole view, not just the window: Home sections `do`, `fromLater`, `update`, `follow`; Later buckets `overdue`, `today`, `week`, `someday`; Low senders (key = address, label = name) |
| `useHold` | `View/hold {windowId, ids}`, `View/release`, or `holdIds` on `View/watch` | planned | Held rows keep their positions until released or about 2 s after the last activity |
| `useRow` | `T/get {ids}` and `state` frames per type | planned | Types Thread, Message, Account, Draft, Submission and Operation |
| `useOperation` | receipts, `Operation` rows in `state` frames | planned | `Operation.remote` (queued, syncing, synced, failed, conflict) for "Saved here · will sync" |
| `usePrefetchIntent`, `useMessageBody` | `MessageBody/prefetch`, `MessageBody/get` | planned | As above |
| `useSession` | `Session/get` | planned | `{apiVersion, appVersion, schemaVersion, dbEpoch, capabilities, hasAccounts}` |
| `useAccounts`, `useStatus` | Account rows and `state` frames | planned / ask | Status per ARCH 6.4 and `reconnectBy` (planned); ask: `isDemo`, `baselineDoneAt`, `colorIndex`, `paused.reason`, `offline.changesWaiting`, `backfilling.firstWindow` and `error.message` on the row |
| `useCounts` | A counts singleton in `state` frames | ask | `{unread, home, laterDue, drafts}` per account scope; plan 30 4.1 names the counts but not their carrier |
| `useSetupStatus` | `Setup/status` | planned | The plan 10 4.1 shape, pushed while setup runs; ask: a plain `message` beside `reasonCode` |
| `useSettings` | `Settings/get` and `state` frames | planned | As above |

### Shapes the contract must carry

- **View specs** (plan 30 4.1): `home`, `home.low` (grouped by sender), `later`, `bookmarks`, `mailbox` (by role or label id, including `done`), `search` (query, parsed operators, `local` or `remote`) and `thread`. Each takes an optional account id; absent means All accounts.
- **Thread row** (ask for the fields not yet in plan 10): `id`, `rev`, `accountId`, `subject`, `summary {text, by, onThisMac}` or null, `summaryPending`, `from`, `participants`, `unread`, `lane`, `importance`, `dueDate`, `dueSource`, `rankSource`, `status`, `fromLater`, `suggestedAction {kind, label, icon}`, `partial`, `messageCount`, `lastMessageAt`, `labels`, `bookmarked`, `laterAt`, `doneAt`, `waitingSince`, `hasNudge`, `hasAttachments` and `canUnsubscribe`. There is no snippet on the thread row.
- **Thread actions** (ask for everything past done, later, trash, read and bookmark): `done`, `later {at or null for Someday}`, `trash`, `spam`, `read`, `unread`, `bookmark`, `unbookmark`, `laneUp` and `laneDown {alsoForSender}`, `restore`, `moveToHome`, `setDue {date or null}`, `remindIfNoReply {at or null}` and `clearFromHome`.
- **Status vocabulary** (ARCH 6.4): `starting`, `ok`, `syncing`, `backfilling (n of m)`, `paused (until, reason)`, `needsReauth`, `needsPermission`, `needsAdmin`, `misconfigured`, `offline (changesWaiting)`, `error`, plus the account fact `reconnectBy`.
- **Submission states** (ARCH 7.1): queued, sending, sent, uncertain, failed, cancelled, suspended, with the engine's sentence and `errorUntil` for send limits.
- **The `ui` settings object** (plan 30 8.1 item 8; the Engine thread takes this as its input): `density`, `appearance`, `showAllKeyHints`, `singleKeyShortcuts`, `dockOpen`, `dockTab`, `sidebarMinimised`, `holdThresholdMs`, `swipeDirection` and `keymap` (command id to keys). Also `mail.undoSeconds`, `mail.nudgeDays`, the per-feature AI provider and model, the provider list with key source (never key characters) and `trainsOnInputs`, and the daily token cap.

### Plan 30's asks (section 8.1) and where this surface uses them

| # | Ask | Used here by |
|---|---|---|
| 1 | Stand-in engine and `Fixture/control` | U2 builds every hook on F6; tests force statuses and orderings through the control channel |
| 2 | View specs | `useView`, `useHome` |
| 3 | `Thread/act`, `Operation/undo`, receipts, `holdIds`, state tokens | `api.thread.act`, `api.operation.*`, `useOperation`, `useHold` |
| 4 | Mail frame | `api.mail.frame`, `api.mail.releaseFrame` |
| 5 | Submissions and a draft-changed-elsewhere signal | `api.submission.*`, `api.draft.resolveConflict`, `useRow('Submission')` |
| 6 | Setup and AI governance | `api.setup.*`, `useSetupStatus`, `AccountRow.aiAllowed` |
| 7 | `Ask/run` with citations | `api.ask.run` |
| 8 | The `ui` settings object, retention and resident-mode toggles | `useSettings`, `api.settings.*` (retention and resident mode are additive later) |
| 9 | Diagnostics, queue inspector, parked event, capability flags | `useSession().capabilities` now; diagnostics and the inspector are additive later |
| 10 | `APLOS_TEST=1` | Not a data concern |
| 11 | Empty start and demo on request | `api.demo.*`, `Session.hasAccounts` |
| 12 | `Setup/status` shape | `useSetupStatus` |
| 13 | Weekly reconnect | `AccountRow.reconnectBy`, `useStatus().reconnectSoon`, `api.account.reconnect` |

## Not yet in the surface (additive follow-ups)

These belong to lanes that start later. Each one adds members and renames nothing.

- Calendar: `Event/query` by range and calendars, `Event/set`, `Event/rsvp`, and the Today agenda (`ui-calendar`, `ui-ask`).
- Settings extras: removing an account, the per-account AI toggle, provider Test, retention and resident-mode toggles, and the diagnostics preview and queue inspector (`ui-settings`).
- Conversations (Ask history) and Ask proposal confirmation (`ui-ask`).
- Pop-out windows use the same hooks on their own port; that needs no new member.
