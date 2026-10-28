# `renderer/data`: the renderer data surface (F9)

This folder holds the one way the new screens read mail and send commands to the engine. It is part of Phase 0 artifact F9 and freezes with the contract (F1) on day 3 (2026-10-29), as one vocabulary. After the freeze, changes are **additive only**: members can be added, but nothing is renamed or removed. Lane `ui-shell` owns the folder and builds the real implementation in U2 (days 4-8). Plan 30 section 4.1 is the design.

| File | What it is |
|---|---|
| `index.ts` | The frozen public surface: hooks, `api`, receipts, holds, constants and the contract mapping. Screens import only from here. Until U2 lands, every hook and method throws `NotImplementedError` naming lane `ui-shell`. |
| `contract-shapes.ts` | The wire types, as type-only re-exports and thin aliases of `@aplos/contract`, under the contract's names. It declares no shape of its own. |
| `ui-types.ts` | The few UI-side types that are not wire types: Home's and Later's section keys, the thread-row specs a selector may target, the row cache map, the streams `useFrames` serves, the overlay's lifecycle. |
| `standin.ts` | `connectStandIn()`: the stand-in engine (F6) in-process behind the F2 typed client, for development (`renderer/main.tsx`) and tests only. Never part of a release. |
| `index.test.ts` | Compile-time usage examples in the contract's types (Home, the reader, the status slot, Ask streaming, the reconnect sheet, the clock, undo, consent), `Equals` checks that `api` is the client's surface, and runtime checks that every stub throws and every `api` method is a registered contract method of the same name. |
| `standin.test.ts` | Boots the stand-in and reads windows into the types the hooks expose (`ViewResult`, `RowForSpec`, `LowBandView`, `Receipt`), in node with no DOM. |

Run the tests with `cd apps/desktop && npx tsx --test 'src/renderer/data/*.test.ts'`. `npm test` does not pick them up yet, because the desktop test script only globs `tests/*.test.ts`; `ui-shell` widens it when Phase 0 ends. `npx tsc --noEmit -p apps/desktop/tsconfig.json` checks the examples, the `@ts-expect-error` lines and the mapping table.

## One vocabulary with the contract

Every type is the contract's. `contract-shapes.ts` re-exports `ThreadRow`, `Message`, `Draft`, `Submission`, `Account`, `Session`, `Settings`, `UiSettings`, `Consent`, `ViewSpec`, `WindowBody`, `WindowSection`, `ThreadAction`, `ThreadSelector`, `Receipt`, `State`, `Operation`, `ErrorBody`, `Frame` and the rest from `@aplos/contract` (types the contract exports only as zod schemas are inferred with `z.infer`). The thin aliases name what the contract leaves unnamed: `AccountId` and the other id aliases are `Id`, and `WindowFrame`, `StateFrame`, `ProgressFrame`, `ConnectFrame`, `ClockEvent`, `ParkedEvent` and `EngineEvent` are `Extract`s of `Frame`, `HostEvent` and `DesktopEvent`. Everything is type-only, so the surface costs the bundle no zod.

The hooks use the contract's names too: a window has `position` and `sections` (not `offset` and `groups`), state is `State` with its `seq`, errors are `ErrorBody`, a thread action is `{type: ...}`.

## The surface in plain words

**Lists are windows.** `useView(spec, {holdIds})` watches one view (`View/watch`). It returns the window as the contract shapes it: the ordered `ids` (at most 200), `position` (index of the first id), `total`, rows by id from the row cache, `sections` (Home sections, Later groups, Low senders), `held`, `rowType`, `state`, plus a `status` (`opening`, `live`, `reset`, `failed`), an `error` when it failed (`WindowBody.error`) and `move(range)`. The row type follows the spec: `thread` gives `Message`s, `drafts` gives `Draft`s, `scheduled` gives `Submission`s, `lowSenders` gives `SenderGroup`s, `events` gives `Event`s, `plans` gives `Plan`s, `conversations` gives `Conversation`s, and every other view gives `ThreadRow`s. The specs are the contract's 17 kinds, including `homeSection`, `oneByOne`, `mailbox` (by role) and `label` (by folder id) as two kinds, `done` for the Done place, and `search` with a structured `SearchQuery`.

**Home has a helper.** `useHome({accountId, holdIds})` turns the `home` window into what DESIGN 7.2 draws. The window's sections are `do`, `fromLater`, `update`, `low` and `follow`. Do now's count includes Back from Later, and `fromLater.count` is the block alone. A section emptied during a hold stays `visible` and shows 0 until the hold releases. `low` is count-only: the band's names come from its `senders`, and "and N more" from the `lowSenders` window's `total`. `state` is there so "Clear from Home" can send a selector `atState`.

**Rows are cached.** `useRow(type, id)` returns one row by contract type name (Thread, Message, Draft, Submission, Event, Plan, Conversation, SenderGroup, plus Account and Operation). It stays the same object while `rev` is unchanged. `useRowState` adds `loading`, `ready` or `notFound` (from `T/get`'s `notFound`).

**Commands act first.** `api.thread.act({ids | selector, action})` applies the optimistic overlay before it returns and gives `{opId, receipt}`. The data layer mints the `opId` when the caller gives none. A selector is `{spec, section?, atState}` over thread-row specs only (the type refuses the reader's message list). The overlay drops once a window's `state.seq` reaches `receipt.appliedState.seq` within one `dbEpoch`. `useOperation(opId)` reports `pending`, `confirmed` or `failed`, the provider-side `Operation.state`, `undoUntil`, and offers `retry()`. Undo is `api.operation.undo({opId})`, an inverse operation.

**Holding still, prefetch, bodies.** As before: `useHold(scope)` is the renderer half, `holdIds` the engine half (`View/hold`, repeated as the ping; `View/release`). `usePrefetchIntent()` sends `MessageBody/prefetch {threadIds}` after 80 ms focus or 120 ms hover and cancels with `{cancel: true}`. `useMessageBody(id)` loads one body and sets `slow` after 1.5 s.

**Session, status, counts, settings, consent.** `useSession()` is `Session/get`. `useConnection()` speaks the contract's `engine` vocabulary (`connecting`, `ready`, `unreachable`, `parked`) with `reason`, `reasonCode` and `canRetry`. `useAccounts()` returns `Account`s with `health`. `useStatus()` picks the one status line and gives its `reasonCode` (copy comes from the code, never from provider text). `useCounts()` gives the `CountsBlock` for the scope plus per-folder unread counts. `useAgenda({kind: 'events', from, to})` is an events window. `useSetupStatus()`, `useSettings()` and the new `useConsent()` read their singletons, re-read on `state` frames.

**Streams, clock, undo.** `useFrames('progress' | 'connect' | 'clock', filter)` serves the contract's `progress` and `connect` frames and the host clock event. A run is followed by the `runId` that `api.ask.run` returned, a connect flow by its `connectId`. `useNow`, `getNow`, `setClock` and the one undo stack are unchanged.

**Not here.** Transport selection (`renderer/bridge.ts`, U2). This folder never imports today's renderer, `shared/live`, `AppState` or `engine/*`.

## `api` is the F2 client

Each `api` member is the F2 typed client's method of the same name (`api.<type>.<verb>` for contract method `Type/verb`), and its type is the client's own (`Api` from `@aplos/contract/client`), so the two cannot drift. Three things differ, and only in the data layer's favour: fresh `opId`s and `requestId`s are optional (the data layer mints them), and the two overlay methods (`thread.act`, `operation.undo`) return an `ActResult` synchronously. Reads that have a hook (`View/*`, `T/get`, `Session/get`, `Counts/get`, `Setup/status`) are not on `api`.

`CONTRACT_METHODS` in `index.ts` is the mapping table. Its type rejects a method the registry does not have and checks `native` against the contract's host; the runtime test checks each name against the registry.

| `api` method | Contract method | Kind | Settled by (GAPS.md) |
|---|---|---|---|
| `thread.act` | `Thread/act` | overlay | F9-1, F9-2, F9-3 |
| `thread.why` | `Thread/why` | call | F9-4 |
| `operation.undo` | `Operation/undo` | overlay | F9-7 |
| `operation.retry` | `Operation/retry` | call | |
| `submission.set` | `Submission/set` | call | F9-8, F9-9 |
| `draft.set`, `draft.destroy`, `draft.resolve` | `Draft/set`, `Draft/destroy`, `Draft/resolve` | call | F9-10, F9-11, F9-40 |
| `messageBody.get`, `messageBody.prefetch` | `MessageBody/get`, `MessageBody/prefetch` | call | F9-12 |
| `mail.frame`, `mail.release`, `mail.toggleQuotes`, `mail.allowImages` | `Mail/frame`, `Mail/release`, `Mail/toggleQuotes`, `Mail/allowImages` | call | F9-13, F9-14 |
| `attachment.get` | `Attachment/get` | call | |
| `blob.put`, `blob.get` | `Blob/put`, `Blob/get` | call | F9-15, F9-22 |
| `sync.request` | `Sync/request` | call | F9-16 |
| `account.connect`, `account.reconnect`, `account.grantPermissions` | `Account/connect`, `Account/reconnect`, `Account/grantPermissions` | stream | F9-17 |
| `account.cancelConnect`, `account.set` | `Account/cancelConnect`, `Account/set` | call | F9-17, F9-18 |
| `setup.begin`, `setup.end`, `setup.retry` | `Setup/begin`, `Setup/end`, `Setup/retry` | call | F9-19 |
| `demo.load`, `demo.reset`, `demo.remove` | `Demo/load`, `Demo/reset`, `Demo/remove` | call | |
| `settings.get`, `settings.set` | `Settings/get`, `Settings/set` | call | F9-41, F9-42 |
| `ask.run`, `ask.cancel` | `Ask/run`, `Ask/cancel` | stream, call | F9-20 |
| `ai.request`, `ai.draft`, `ai.polish`, `ai.transcribe`, `ai.followup` | `Ai/request`, `Ai/draft`, `Ai/polish`, `Ai/transcribe`, `Ai/followup` | call | F9-5, F9-21, F9-22 |
| `unsubscribe.run` | `Unsubscribe/run` | call | F9-6 |
| `consent.get`, `consent.grant`, `consent.revoke` | `Consent/get`, `Consent/grant`, `Consent/revoke` | call | F9-23, F9-43 |
| `engine.restart` | `Engine/restart` | native | F9-24 |
| `diagnostics.preview`, `diagnostics.copy` | `Diagnostics/preview`, `Diagnostics/copy` | call, native | F9-25, F9-26 |

## What this surface asked of the contract, and the outcome

Every earlier ask (numbered F9-n in `packages/contract/GAPS.md` section 4, UI-n in section 5) now has an outcome.

| Ask | Outcome | Where it landed, or why |
|---|---|---|
| F9-1 selector target `{spec, group?, atState}` | closed | `ThreadSelector {spec, section?, atState}`; the type here narrows `spec` to thread-row views |
| F9-2 `setLane`, `laneUp`, `laneDown` | closed | `ThreadAction` `lane {lane, alsoForSender?}`, `laneStep {direction, alsoForSender?}` |
| F9-3 other action names | closed (already there) | `bookmark {on}`, `restore`, `due {date?}`, `reminder {at?, ifNoReply?}`, "Clear from Home" is `later` without `until` |
| F9-4 `Thread/why` | closed | `Thread/why` → `WhyItsHere` |
| F9-5 follow-up suggestion | closed (already there) | `Ai/followup` (`api.ai.followup`); `ThreadRow.follow.suggestion` |
| F9-6 unsubscribe | closed (already there) | `Unsubscribe/run` (`api.unsubscribe.run`), with `outcome` |
| F9-7 undo receipt is the inverse's | closed (already there) | `Operation/undo {opId, undoOpId}` |
| F9-8 send with Done, `queuedAt` | closed | `SubmissionAction.send.alsoDone`, `Submission.queuedAt` |
| F9-9 send now, reschedule | closed (already there) | `sendNow`, `reschedule`, `sendAnyway`, `retry` |
| F9-10, F9-40 draft source | closed (already there) | `DraftFields.mode` + `replyToMessageId`; `DraftAttachment.source` |
| F9-11 draft conflict | closed (already there) | `Draft.conflict`, `Draft/resolve`, `Draft/changed` frame |
| F9-12 prefetch by thread | closed | `MessageBody/prefetch.threadIds` |
| F9-13 quotes and the allow-list | closed (already there) | `Mail/frame.quotesOpen`, `Mail/toggleQuotes`, `mail.imageAllowList` |
| F9-14 allow images from a sender | closed | `Mail/allowImages {sender, allow}` |
| F9-15 attachment upload | closed (already there) | `Blob/put` |
| F9-16 Retry now on a pause | closed (already there) | `Sync/request.force` |
| F9-17 connect progress and cancel | closed (already there) | `connect` frame, `Account/cancelConnect` |
| F9-18 per-account AI toggle | closed (already there) | `Account/set.aiAllowed` |
| F9-19 per-account setup retry | closed | `Setup/retry` |
| F9-20 Ask `citation` and `proposal` frames | closed | `progress` kinds `citation`, `proposal` |
| F9-21 draft, polish, summary | closed; change ranges rejected | `Ai/draft`, `Ai/polish`, `Ai/request`. Rejected: polish works on HTML, so offsets would break on markup; the composer diffs `html` |
| F9-22 transcribe | closed (already there) | `Blob/put` then `Ai/transcribe {blobId}` |
| F9-23, F9-43 consent record | closed (already there) | `Consent/get|grant|revoke` and `useConsent`; consent is not a settings field |
| F9-24 engine restart | closed | `Engine/restart` (main) |
| F9-25 diagnostics copy with host fallback | closed | `Diagnostics/copy` → `{source}` (main) |
| F9-26 diagnostics preview as text | closed (already there) | `DiagnosticsBundle`; the renderer formats it |
| F9-27 `seq` on windows, frames and receipts | closed (already there) | `State.seq` in `WindowBody.state` and `Receipt.appliedState`; every frame's `seq` |
| F9-28 `drafts` view, failed windows | closed | `drafts` kind; `WindowBody.error` |
| F9-29 window offset | closed (already there) | `WindowBody.position` |
| F9-30 groups across the whole view | closed | `WindowBody.sections` (required), `WindowSection.label`, documented keys |
| F9-31 hold activity ping | closed (already there) | repeat `View/hold` |
| F9-32 operation remote state | closed (already there) | `Operation.state` |
| F9-33 session fields | closed (already there) | `Session` |
| F9-34 parked, sent by main when the engine cannot | closed | `HostEvent.parked.at`; `DesktopEvent` `engine` |
| F9-35 account extras | closed; `error.message` rejected | `demo`, `baselineDoneAt`, `colorTag`, `paused.{class, reason}`, `health.reasonCode`, `pendingChanges`. Rejected: copy comes from `reasonCode`, never provider text |
| F9-36 `handledToday`, hidden during first sync | closed | `CountsBlock.handledToday`; hiding is the renderer's, from `baselineDoneAt` |
| F9-37 agenda query | closed (already there) | the `events` view kind and `Event/get` |
| F9-38 setup `message` | rejected | copy comes from `reasonCode` (DESIGN 7.15) |
| F9-39 thread row fields | closed | `fromLater`, `SummaryRef.local`, required `unsubscribe`; the rest under contract names (`fromName`, `lastDate`, `workflow`, `rank`, `summary`, `follow`) |
| F9-41, F9-42, UI-1 to UI-13 the `ui` object and mail settings | closed | `UiSettings` field for field; `undoSendSeconds`, `followUpDays`, `imageAllowList` |
| F9-44 draft rows | closed (already there) | `drafts` kind, `RowType` `Draft` |

### Still open

These are new, small, and none blocks U2. Each has a stopgap that needs no contract change.

| Ask | What and why | Stopgap until then |
|---|---|---|
| new: `Settings.ui.seen.holdCommandHint` | The first-launch "Hold ⌘ to see keys." toast shows once (DESIGN 7.13); `UiSettings` strips unknown fields | The shell keeps the flag in its own local state |
| new: `progress` kind `paused {resumeAt}` | "Waiting for Groq, about 20 s" during a rate-limit wait; the open `kind` enum can take it additively | Ask shows its steady step line |
| new: clarify the `fromLater` count | The `WindowSection` comment says Back from Later's count "is the two together"; the stand-in counts the block alone and runs never overlap | `useHome` follows the stand-in: Do now's count is `do` plus `fromLater` |
| new: a sender key on thread rows | The Low sheet groups `homeSection: low` rows under `lowSenders` groups, but `ThreadRow` carries `fromName` and participants, not the newest sender's address, so the join is by name | The data layer joins on `fromName`, falling back to the participant with that name |

## Release rule

No release ships before the switch to the real engine (plan 30 4.1, build-order step 2). `renderer/main.tsx` boots the stand-in only in a development build; a production build loads today's renderer. The `srcdoc` mail frame (`MailFrame.srcdoc`, set by the stand-in only) is a development path, never a shipped fallback (ARCH 10).

## Changes against the F9 base (pre-freeze waiver)

The contract swap renamed or removed exported names. The freeze is day 3, so this is allowed once and recorded here. In this tree nothing outside `renderer/data`, `renderer/shell` and `ui/props.ts` imported the old names.

| Where | Before | Now | Why |
|---|---|---|---|
| data types | `AccountRow`, `MessageRow`, `DraftRow`, `SubmissionRow`, `OperationRow`, `EventRow`, `MailFrameRef`, `WindowGroup`, `StateToken`, `ContractError` (interface), `Person`, `AttachmentRef`, `ThreadSummary`, `AskProposal`, `AiProviderInfo`, `AiConsent`, `DiagnosticsPreview`, `IsoDay`, `UiKeymapEntry` | `Account`, `Message`, `Draft`, `Submission`, `Operation`, `Event`, `MailFrame`, `WindowSection`, `State`, `ErrorBody`, `Address`/`Participant`, `AttachmentMeta`, `SummaryRef`, `Proposal`, `AiProvider`, `Consent`, `DiagnosticsBundle`, `LocalDate`, `KeyBinding` | The contract's names (owner decision) |
| data types | `StateSeq`, `ContractErrorType`, `WorkflowStatus`, `SuggestedActionKind`, `BodyState`, `BodyKind`, `QuotedRange`, `ImagePolicy`, `MailFrameRequest`, `MailboxRole`, `MailboxRef`, `SearchOperator`, the eight `*ViewSpec`s, `StateFrameChange`, `OperationRemoteState`, `LaterAt`, `ThreadTarget`, `PausedReason`, `SetupAccountStatus`, `DraftSource`, `DraftInput`, `DraftSaveResult`, `SendOptions`, `AskRequest`, `AskFrame`, `AskAnswer`, `AiRequest`, `PolishChange`, `AiResult`, `Transcript`, `Density`, `UiDockSettings`, `AiFeatureChoice`, `AiConsentGrant`, `AgendaQuery`, `UiSettingsPatch`, `ConnectReasonCode`, `ProgressStep` | removed: use the contract type they stood for (`State['seq']`, `Input<'Mail/frame'>`, `ViewSpecOf<K>`, `SearchQuery`, `Operation['state']`, `SetupAccount`, `DraftFields`, `Output<'Draft/set'>`, `ProgressFrame`, `AskTurn`, `UiSettings['dock']`, `ModelRef`, `ReasonCode`, `AskStep`, ...) | Superseded by the contract |
| data UI-side | `HomeGroupKey`, `LaterBucket`, `RowType` (closed), `FrameMap`, `FrameKind`, `ClockFrame`, `ParkedFrame` | `HomeSectionKey` (adds `low`), `LaterSectionKey`, `CachedRowType` (`RowType` is now the contract's open enum), `StreamFrameMap`, `StreamKind`, `ClockEvent`, `ParkedEvent` | Contract vocabulary; the contract's `FrameKind` means every frame kind |
| data hooks | `ViewResult.offset`, `.groups`, `.state: string`, `.error: ContractError`; `useRow<RowType>`; `useAgenda({from, to})`; `CountsView.counts` flat; `StatusSlotState.account: AccountRow` | `position`, `sections`, `state: State`, `error: ErrorBody`, plus `held`, `rowType`; `useRow<CachedRowType>` (adds Plan, Conversation, SenderGroup); `useAgenda({kind: 'events', from, to})`; `counts: CountsBlock` plus `folders`; `account: Account` plus `reasonCode`. `HomeView.state`, `ConnectionView.reasonCode` and `.canRetry`, `OperationView.undoUntil` and `useConsent` are new | Hooks adopt the contract's names (owner decision) |
| data `api` | `thread.act(target, action)`, `thread.followup`, `thread.unsubscribe`, `operation.undoLast`, `submission.send/sendLater/undo/sendNow/reschedule`, `draft.save/discard/resolveConflict`, `body.*`, `mail.releaseFrame/allowImagesFrom`, `attachment.put`, `account.setAiAllowed`, `ai.setConsent`, handles `AccountFlow`, `AskRun`, `SubmissionReceipt` | `thread.act({ids | selector, action})`, `ai.followup`, `unsubscribe.run`, `undoStack.undoLast()`, `submission.set({action})`, `draft.set/destroy/resolve`, `messageBody.*`, `mail.release/allowImages`, `blob.put`, `account.set`, `consent.grant/revoke`; flows return `connectId` / `runId` and stream through `useFrames`. New: `operation.retry`, `mail.toggleQuotes`, `blob.get`, `account.grantPermissions`, `ask.cancel`, `ai.draft/polish/transcribe`, `consent.get` | `api` maps one to one onto the F2 client's method names |
| data `ContractMethodRef` | `{method, kind, source, needs}`, kind `local` | `{method, kind, gaps, notes}`; `method` checked against the registry | Every method now exists; the column records how each ask was settled |
| shell `SheetArgs.consent` | `{providerId?, model?}` | `{provider?, model?}` (`AiProviderId`) | The contract's names |
| `ui/props.ts` `Lane`, `DueSource` | closed literal unions | the contract's open enums, re-exported through `renderer/data` (wider, so additive for callers) | Screens pass `row.rank.lane` and `row.workflow.dueSource` straight through |

## Not yet in the surface (additive follow-ups)

- Calendar beyond the agenda: `Event/set`, `Event/rsvp`, `Calendar/get` and a `useCalendars` hook (`ui-calendar`).
- Ask history and proposals: `Ask/decide`, `Ask/suggestions`, `Conversation/destroy` (`ui-ask`); `conversations` and `Conversation` rows already work through `useView` and `useRow`.
- Settings extras: `Account/disconnect`, `Account/lease`, `Ai/providers|models|status|usage|setKey|testKey`, `Queue/*`, `Folder/get` (`ui-settings`).
- `Search/remote`, `Later/presets`, `Reminder/*`, `Thread/open`, `Outbox/pending` and the desktop window methods, each added to `api` under its client name when its screen lands.
