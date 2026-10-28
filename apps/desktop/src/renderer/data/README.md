# `renderer/data`: the renderer data surface (F9)

This folder holds the one way the new screens read mail and send commands to the engine. It is part of Phase 0 artifact F9 and freezes on day 3 (2026-10-29). After the freeze, changes are **additive only**: members can be added, but nothing is renamed or removed. Lane `ui-shell` owns the folder and builds the real implementation in U2 (days 4-8). Plan 30 section 4.1 is the design.

| File | What it is |
|---|---|
| `index.ts` | The frozen public surface: hooks, `api`, receipts, holds, constants and the contract mapping. Screens import only from here. Until U2 lands, every hook and method throws `NotImplementedError` naming lane `ui-shell`. |
| `contract-shapes.ts` | Provisional wire types (rows, view specs, frames, status, settings). They are re-exported from `index.ts`. |
| `index.test.ts` | Compile-time usage examples for Home, the reader and the status slot, plus runtime checks that every stub throws and every `api` method has a contract mapping. |

Run the tests with `npx tsx --test apps/desktop/src/renderer/data/index.test.ts`. `npm test` does not pick them up yet, because the desktop test script only globs `tests/*.test.ts`. Phase 0 forbids this package from editing `package.json` or writing outside this folder, so `ui-shell` widens the glob to `src/**/*.test.ts` (or moves the file) when Phase 0 ends. `npx tsc --noEmit -p apps/desktop/tsconfig.json` checks the examples and the `@ts-expect-error` lines.

## The surface in plain words

**Lists are windows.** `useView(spec, {holdIds})` watches one view in the engine. It returns the ordered ids in the current window (at most 200), the window's offset, the total, rows by id from the row cache, groups with counts (Home sections, Later buckets, Low senders), the window state, a status (`opening`, `live`, `reset`, `failed`), an `error` when it failed, and `move(range)` for scrolling. The renderer never holds a whole mailbox. A failed view (remote search paused or unavailable, a thread that is gone) shows `error.message` as an ErrorLine instead of spinning. The thread view yields message rows, the `drafts` view yields draft rows (drafts are not threads, so `drafts` is not a mailbox role), and every other view yields thread rows.

**Home has a helper.** `useHome({accountId, holdIds})` turns the `home` and `home.low` views into what DESIGN 7.2 draws: Do now (with Back from Later at its bottom), Important updates and Follow up, always in that order, each with its ids, count, start index and a `visible` flag. Do now's count includes Back from Later, and `fromLater.count` is the block alone; the sidebar's Home count includes it too. A section emptied during a hold stays `visible` and shows 0 until the hold releases (DESIGN 5 rule 6). Rows that arrive during a hold are counted in `waiting` ("2 new"). The Low importance band gives the count, up to three sender names and "and N more".

**Rows are cached.** `useRow(type, id)` returns one row (Thread, Message, Account, Draft, Submission, Operation or Event). The object stays the same while its `rev` is unchanged, so it is safe in memo dependencies. `useRowState(type, id)` adds a status (`loading`, `ready`, `notFound`) so the reader can say a thread is gone instead of waiting forever.

**Commands act first.** `api.thread.act(target, action)` applies the optimistic overlay before it returns, so key-to-state stays within 8 ms (DESIGN 5 rule 1). The target is a list of ids, or a selector `{spec, group?}` for a whole view or one group past the 200-row window (the Low sheet's "mark everything done", "Clear from Home", ⌘A). Lane corrections are relative (`laneUp`, `laneDown`); the toast's "Always do this for [sender]" sends the absolute `setLane` with the lane the thread already moved to, so it never moves a second lane. It returns `{opId, receipt}`. The overlay drops once a window frame's `seq` reaches the receipt's `appliedSeq`: frames are coalesced and can skip states, so the comparison is ordered, never token equality. `useOperation(opId)` reports `pending`, `confirmed` or `failed` and offers `retry()`. A rejected write puts the row back in its place with an inline error and Retry (DESIGN 5 rule 11), which list screens read from `failures`. Undo is an inverse operation (`api.operation.undo`, or `undoLast` for Z), never a delayed commit.

**Holding still has two halves.** `useHold(scope)` is the renderer half. `begin(reason, ids)` starts on a triage key or pointer rest, `extend()` pushes the release back, and `release()` ends it. It releases 450 ms after the last key, never later than 1,200 ms. `onRelease` is where the motion lane runs `close` (FLIP). The engine half is `heldIds`, passed to `useView` or `useHome` as `holdIds`, so an AI re-rank cannot move the rows around the cursor. A `holdIds` change never re-watches: the data layer sends `View/hold` and `View/release` on the open window and pings activity while held, so the window stays `live` and keeps its offset.

**Prefetch on intent.** `usePrefetchIntent()` prefetches the body and both neighbours after 80 ms of keyboard focus or 120 ms of hover (both take the neighbours), and cancels on move (DESIGN 5 rule 9). `api.body.prefetch(threadIds)` is the raw call; it takes thread ids because list rows carry thread ids and body prefetch is thread-granular (ARCH AM-1). `useMessageBody(id)` loads one body and sets `slow` after 1.5 s, so the reader can show its 12 px line while it keeps the previous letter (DESIGN 5 rule 10).

**Session and status.** `useSession()` returns the API version, capability flags and `hasAccounts`. `useConnection()` says whether the engine is `connecting`, `ready`, `unreachable` or `parked`, with a reason, so the FatalScreen can show "Aplos can't reach its mail engine." with Restart engine (`api.engine.restart`) and Copy diagnostics (`api.diagnostics.copy`), both served by main when the engine cannot answer. `useAccounts()` returns each account with its status (ARCH 6.4) and the `reconnectBy` fact. `useStatus()` picks the single line the status slot shows, most urgent first. `useCounts()` gives the sidebar counts (Home is Do now with Back from Later plus Important updates, Later is what is due now, plus Drafts) with `hidden` set during first sync, and `handledToday` for inbox zero's "You handled 12 emails." `useAgenda({from, to, calendarIds?})` gives the events for Today and inbox zero's "Next:" line. `useSetupStatus()` drives the first-sync screen, and `useSettings()` reads the settings, including the `ui` object.

**The rest of `api`.** Submissions (send, send later, undo, send now, reschedule; send and send later take `{markDone}` for ⌘⇧Return, one operation and one notice), drafts (save with an optional `source {messageId, mode}` for reply, reply all and forward, discard, resolve a conflict), bodies and the mail frame (with `showQuotes` for O, and `allowImagesFrom` for "Load images from this sender"), attachments as blobs both ways (`get`, and `put` for Attach a file), sync requests, account connect, reconnect (with cancel) and the per-account AI toggle, setup begin, end and per-account retry, demo mail, settings, Ask with progress frames, interactive AI (draft, polish, summary, transcribe) and the versioned AI consent record (`setConsent`), the engine restart, and the diagnostics preview and copy.

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
| `thread.act` | `Thread/act` | planned / ask | `{opId, ids, action}` for every `ThreadAction` kind below; returns `receipt {opId, appliedState, appliedSeq}`; ask: a `query {spec, group?, atState}` target in place of `ids`, resolved at the state the owner saw, and the `setLane` action |
| `thread.why` | `Thread/why` (name is eng-contract's call) | ask | `{threadId}` → `{sentence, quote, rankSource}` (DESIGN 9 rule 4) |
| `thread.followup` | `Thread/followup` (name is eng-contract's call) | ask | `{threadId}` → `{threadId, text}` or null; the output of eng-ai's `followup` job |
| `thread.unsubscribe` | `Unsubscribe/run` | planned | `{threadId}` → receipt |
| `operation.undo` | `Operation/undo` | planned | `{opId}` → a receipt whose `opId` is the inverse operation's |
| `operation.undoLast` | `Operation/undo` | planned | The data layer tracks the last undoable `opId` |
| `submission.send` | `Submission/set` | planned / ask | `{action: send, draftId}` → `{submissionId, receipt}`; `notBefore` = now + `undoSeconds`; ask: `markDone` in the same operation, and `queuedAt` on the row |
| `submission.sendLater` | `Submission/set` | planned / ask | `{action: send, draftId, notBefore, markDone?}` |
| `submission.undo` | `Submission/set` | planned | `{action: undo, submissionId}` |
| `submission.sendNow` | `Submission/set` | ask | `{action: sendNow, submissionId}`, valid for queued, suspended ("Send now"), uncertain ("Send anyway") and failed ("Try again") |
| `submission.reschedule` | `Submission/set` | ask | `{action: reschedule, submissionId, notBefore}` for suspended ("Reschedule") and queued sends |
| `draft.save` | `Draft/set` | planned / ask | Create, or update with `baseRevision` (compare-and-set); `stateMismatch` on conflict; ask: `source {messageId, mode: reply, replyAll or forward}` on create, and forward copies the source's attachments |
| `draft.discard` | `Draft/set` | planned | Destroy |
| `draft.resolveConflict` | `Draft/set` + `Draft/changed` frame | ask | `{draftId, resolve: keepMine, takeTheirs or keepBoth}`; the frame sets `changedElsewhere` on the row |
| `body.get` | `MessageBody/get` | planned | `{messageId}` → `{bodyKind, text, quotedRanges}` |
| `body.prefetch` | `MessageBody/prefetch` | ask | `{threadIds}` (thread-granular, ARCH AM-1) with a way to cancel |
| `mail.frame` | `Mail/frame` | planned / ask | `{messageId, imagePolicy, findQuery}` → `{url, expiresAt, bodyKind, trackersRemoved, hasRemoteImages, quotedCount}`; ask: `showQuotes` (plan 30 8.1 item 4 `toggleQuotes`), honouring `Settings.mail.imageAllowSenders`, and `srcdoc` from the stand-in only for the development frame |
| `mail.releaseFrame` | `Mail/frame.release` | planned | `{url}` |
| `mail.allowImagesFrom` | `Mail/allowImagesFrom` (name is eng-contract's call) | ask | `{address}` → receipt; appends to `Settings.mail.imageAllowSenders` (plan 30 8.1 item 4, per-sender image allow-list) |
| `attachment.get` | blob route (`GET /v1/blob/:id`, transferable `ArrayBuffer` on MessagePort) | planned | Never base64 |
| `attachment.put` | `Blob/put` (`PUT /v1/blob`, transferable on MessagePort) | ask | `{data, name, mime}` → `AttachmentRef`; 25 MB cap; never base64 |
| `sync.request` | `Sync/request` | planned | `{accountId?}`; also ends a throttle pause, for "Retry now" |
| `account.connect` | `Account/connect` | planned | `{provider, loginHint?}` → request id, progress, cancel |
| `account.reconnect` | `Account/reconnect` | planned | `{accountId}` with `login_hint`, no resync, queued changes kept; ask: a cancel for the sheet's Cancel |
| `account.setAiAllowed` | `Account/set` (verb is eng-contract's call) | ask | `{accountId, aiAllowed}` → receipt (plan 30 8.1 item 6, the per-account AI toggle) |
| `setup.begin`, `setup.end` | `Setup/begin`, `Setup/end` | planned | `end` is idempotent; the UI calls it on every window close |
| `setup.retry` | `Setup/retry` (name is eng-contract's call) | ask | `{accountId}`; first sync's "Try again" and "Not connected · Try again" (DESIGN 7.12); idempotent, resumes from the checkpoint |
| `demo.load`, `demo.reset`, `demo.remove` | `Demo/load`, `Demo/reset`, `Demo/remove` | planned | Idempotent; they touch only demo accounts |
| `settings.get`, `settings.set` | `Settings/get`, `Settings/set` | planned | `Settings` with the `ui` object (below); `set` merges a partial update |
| `ask.run` | `Ask/run` + `progress` frames | planned | Frames `step`, `text`, `citation {n, messageId, quote}`, `proposal`; cancel |
| `ai.request` | `Ai/request` | planned | Kinds `draft`, `polish` (returns changes, never applied by themselves), `summary` |
| `ai.transcribe` | `Blob/put` + `Ai/request {kind: transcribe, blobId}` | ask | Audio as a transferable buffer; returns `{text}` |
| `ai.setConsent` | `Consent/set` (plan 10 row 6 names `Consent/*`; the verb is eng-contract's call) | planned | `{providerId, model, version}` or null to revoke → receipt; `Settings.ai.consent {providerId, model, version, grantedAt}` and `Settings.ai.consentVersion` carry the record |
| `engine.restart` | native method through main (`native-methods.ts`) | ask | Restarts the engine, or un-parks it ("Try again"); works when the engine cannot answer |
| `diagnostics.preview` | `Diagnostics/preview` | planned | `{}` → `{text, generatedAt}`, content-free |
| `diagnostics.copy` | `Diagnostics/preview`, native fallback through main | ask | Copies the bundle; main builds a host-only bundle when the engine is unreachable or parked |

### What the hooks need

| Hook | Contract method or frame | Source | Needs |
|---|---|---|---|
| `useView` | `View/watch`, `View/move`, `View/unwatch`, `window` and `reset` frames, `Thread/get`, `Message/get`, `Draft/get` | planned | `View/watch {spec, holdIds?}`; the spec union below; `window {windowId, state, ids, total, changed}` |
| `useView` | `window.seq`, `receipt.appliedSeq`, `state.seq` | ask | The `seq` half of each state token as a plain number, ordered within one `dbEpoch`, so an overlay drops at `seq >= appliedSeq` even when coalesced frames skip the exact state |
| `useView` | `drafts` spec, failed windows | ask | A `drafts` view whose rows are `Draft` rows; a window that cannot open or stops (remote search `quotaPaused` or `unavailable`, a deleted thread) reports a `ContractError` instead of never answering |
| `useView` | `window.offset` | ask | Index of `ids[0]` in the whole view (approximate under keyset), so a virtualised list can place the window |
| `useView`, `useHome` | `window.groups` | ask | `[{key, label?, count, start}]` across the whole view, not just the window: Home sections `do`, `fromLater`, `update`, `follow`; Later buckets `overdue`, `today`, `week`, `someday`; Low senders (key = address, label = name) |
| `useHold` | `View/hold {windowId, ids}`, `View/release {windowId}`, an activity ping | planned | Required, not optional: holds change on every triage key and must never re-watch. Held rows keep their positions until released or about 2 s after the last activity (plan 10 E3 item 3) |
| `useRow`, `useRowState` | `T/get {ids}` and `state` frames per type | planned | Types Thread, Message, Account, Draft, Submission, Operation and Event; `notFound` ids and destroyed rows report `notFound` |
| `useOperation` | receipts, `Operation` rows in `state` frames | planned | `Operation.remote` (queued, syncing, synced, failed, conflict) for "Saved here · will sync" |
| `usePrefetchIntent`, `useMessageBody` | `MessageBody/prefetch`, `MessageBody/get` | planned | As above |
| `useSession` | `Session/get` | planned | `{apiVersion, appVersion, schemaVersion, dbEpoch, capabilities, hasAccounts}` |
| `useConnection` | `parked` frame `{reason, since}` | planned / ask | Plan 10 E1 item 4 names the parked event; ask: main sends it when the engine cannot, with a plain `reason` |
| `useAccounts`, `useStatus` | Account rows and `state` frames | planned / ask | Status per ARCH 6.4 and `reconnectBy` (planned); ask: `isDemo`, `baselineDoneAt`, `colorIndex`, `paused.reason`, `offline.changesWaiting`, `backfilling.firstWindow` and `error.message` on the row |
| `useCounts` | A counts singleton in `state` frames | ask | `{unread, home, laterDue, drafts, handledToday}` per account scope; `home` includes Back from Later; plan 30 4.1 names the counts but not their carrier |
| `useAgenda` | `Event/query` and `state` frames for type Event | planned / ask | `{from, to, calendarIds?}` → minimal `EventRow {id, rev, accountId, calendarId, title, start, end, allDay, location, response}`; plan 30 4.1 lists the spec, plan 10 freezes the `Event/*` names at C1 |
| `useSetupStatus` | `Setup/status` | planned | The plan 10 4.1 shape, pushed while setup runs; ask: a plain `message` beside `reasonCode` |
| `useSettings` | `Settings/get` and `state` frames | planned | As above |

### Shapes the contract must carry

- **View specs** (plan 30 4.1): `home`, `home.low` (grouped by sender), `later`, `bookmarks`, `mailbox` (by role or label id, including `done`; `drafts` is not a role), `search` (query, parsed operators, `local` or `remote`), `drafts` (Draft rows, ask) and `thread`. Each list spec takes an optional account id; absent means All accounts.
- **Thread row** (ask for the fields not yet in plan 10): `id`, `rev`, `accountId`, `subject`, `summary {text, by, onThisMac}` or null, `summaryPending`, `from`, `participants`, `unread`, `lane`, `importance`, `dueDate`, `dueSource`, `rankSource`, `status`, `fromLater`, `suggestedAction {kind, label, icon}`, `partial`, `messageCount`, `lastMessageAt`, `labels`, `bookmarked`, `laterAt`, `doneAt`, `waitingSince`, `hasNudge`, `hasAttachments` and `canUnsubscribe`. There is no snippet on the thread row.
- **Thread actions** (ask for everything past done, later, trash, read and bookmark): `done`, `later {at or null for Someday}`, `trash`, `spam`, `read`, `unread`, `bookmark`, `unbookmark`, `laneUp` and `laneDown {alsoForSender}`, `setLane {lane, alsoForSender}`, `restore`, `moveToHome`, `setDue {date or null}`, `remindIfNoReply {at or null}` and `clearFromHome`.
- **Status vocabulary** (ARCH 6.4): `starting`, `ok`, `syncing`, `backfilling (n of m)`, `paused (until, reason)`, `needsReauth`, `needsPermission`, `needsAdmin`, `misconfigured`, `offline (changesWaiting)`, `error`, plus the account fact `reconnectBy`.
- **Submission states** (ARCH 7.1): queued, sending, sent, uncertain, failed, cancelled, suspended, with the engine's sentence and `errorUntil` for send limits, and `queuedAt` beside `notBefore` for the UndoTray drain bar (ask).
- **Draft rows** (ask): `source {messageId, mode}` or null.
- **Push frames**: `window` and `state` carry `seq`; `parked {reason, since}`.
- **The `ui` settings object** (plan 30 8.1 item 8; the Engine thread takes this as its input): `density`, `appearance`, `showAllKeyHints`, `singleKeyShortcuts`, `dockOpen`, `dockTab`, `sidebarMinimised`, `holdThresholdMs`, `swipeDirection` and `keymap` (command id to keys). Also `mail.undoSeconds`, `mail.nudgeDays`, `mail.imageAllowSenders`, the per-feature AI provider and model, the provider list with key source (never key characters) and `trainsOnInputs`, the daily token cap, and `ai.consent` with `ai.consentVersion`.

### Plan 30's asks (section 8.1) and where this surface uses them

| # | Ask | Used here by |
|---|---|---|
| 1 | Stand-in engine and `Fixture/control` | U2 builds every hook on F6; tests force statuses and orderings through the control channel |
| 2 | View specs | `useView`, `useHome` |
| 3 | `Thread/act`, `Operation/undo`, receipts, `holdIds`, state tokens | `api.thread.act` (ids or selector), `api.operation.*`, `useOperation`, `useHold` (`View/hold`, `View/release`, activity ping), ordered `seq` on frames and receipts |
| 4 | Mail frame, `toggleQuotes`, per-sender image allow-list | `api.mail.frame` (`showQuotes`), `api.mail.releaseFrame`, `api.mail.allowImagesFrom`, `Settings.mail.imageAllowSenders` |
| 5 | Submissions and a draft-changed-elsewhere signal | `api.submission.*`, `api.draft.resolveConflict`, `useRow('Submission')` |
| 6 | Setup and AI governance | `api.setup.*` (including `retry`), `useSetupStatus`, `AccountRow.aiAllowed`, `api.account.setAiAllowed`, `Settings.ai.consent`, `api.ai.setConsent` |
| 7 | `Ask/run` with citations | `api.ask.run` |
| 8 | The `ui` settings object, retention and resident-mode toggles | `useSettings`, `api.settings.*` (retention and resident mode are additive later) |
| 9 | Diagnostics, queue inspector, parked event, capability flags | `useSession().capabilities`, `useConnection()` (the `parked` event), `api.engine.restart`, `api.diagnostics.preview` and `copy`; the queue inspector is additive later |
| 10 | `APLOS_TEST=1` | Not a data concern |
| 11 | Empty start and demo on request | `api.demo.*`, `Session.hasAccounts` |
| 12 | `Setup/status` shape | `useSetupStatus` |
| 13 | Weekly reconnect | `AccountRow.reconnectBy`, `useStatus().reconnectSoon`, `api.account.reconnect` |

## Not yet in the surface (additive follow-ups)

These belong to lanes that start later. Each one adds members and renames nothing.

- Calendar beyond the agenda: `Event/set`, `Event/rsvp`, the grid, and more `EventRow` fields (`ui-calendar`). `useAgenda` and the minimal `EventRow` are frozen now so Home and Today have a shape.
- Settings extras: removing an account, provider Test, retention and resident-mode toggles, and the queue inspector (`ui-settings`).
- Conversations (Ask history) and Ask proposal confirmation (`ui-ask`).
- Pop-out windows use the same hooks on their own port; that needs no new member.
