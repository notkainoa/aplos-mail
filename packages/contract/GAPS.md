# Contract gaps: how F1 answers the UI threads

Written 2026-10-27 (day 2) on `rv/eng-contract/f1-gaps`, before the day-3 freeze. One row per gap or ask from:

- **E, P, U**: the UI-screens gap list (`rv/thread/ui-screens:plans/ui-screens/gap-list.md`). Its 70 ids, with the map ids
  they merge (`O`, `C`, `S`, `A`) in brackets.
- **F9-n**: UI-core's asks in `rv/ui-foundation/f9:apps/desktop/src/renderer/data/README.md` ("What this surface asks of
  the contract") and `contract-shapes.ts`, numbered here in the order they appear there.
- **UI-n**: UI-core's `Settings.ui` freeze request (STATUS.md, 18:54).
- **PV-n**: a consistency check against the Providers port proposal v2 (section 5 and the `Account/*`, `Sync/request`,
  `Event/*` and `Unsubscribe/run` paths) and the F3 ports in `packages/engine/src/ports/`.

Outcomes: **closed** (this branch changed the contract), **already there** (the contract had it, sometimes under another
name, given in the row), **rejected** (with the reason). Paths are relative to `packages/contract/src/`. Where F1's names
differ from a request, UI-core's README says the data layer adapts them inside `ui-shell` and screens keep their names.

## In plain English

Every screen need the UI threads listed now has an answer in the contract or a stated reason why not. Most were already
in contract v1 under a slightly different name. About thirty small additions close the rest: a few new methods ("Why
it's here", per-account "Try again", "Load images from this sender", restarting the engine from the fatal screen), a few
row fields screens rely on (Back from Later, changes waiting, when a send was queued, an event's sync state), and a way
for main to tell a window the engine is down. The rejected items are renderer-only matters or would put provider wording
or behaviour into the contract.

## Non-additive changes (allowed only because v1 is not tagged yet)

| Change | Why |
|---|---|
| `last4` removed from `AiProvider`, `Ai/setKey`, `Ai/removeKey`, `Ai/pasteKey` | Plan 30 section 4.5 and the gap list (E23): key source only, "never key characters". Outputs strip unknown keys, so an old producer still parses |
| `Settings.ui.sidebar {shown, minimised}` → `sidebarMinimised` | UI-core's freeze list; DESIGN 4.6 has one sidebar fact (☰ minimised or not) |
| `Settings.ui.paletteRecents` → `palette.recents`; `Settings.ui.weekStart` → `calendar.weekStart` | UI-core's freeze list names them so |
| `Settings.ui.keymap` values: a chord string → a list of `{chord, phase?}` | F9's `Keymap` (commands/types.ts): several keys per command and hold bindings |
| `Settings.ui.holdMs` range 0-5,000 → 100-2,000 | 0 makes every press a hold; F9's property test uses 150-450 |
| Required output fields added: `Account.pendingChanges`, `ThreadRow.fromLater`, `ThreadRow.unsubscribe` (was optional), `Submission.queuedAt`, `Event.sync`, `WindowBody.sections` (was optional), `NotificationSettings.reconnectReminder`, `HostEvent.parked.at` | Screens rely on them from day 4, so they are not left optional (brief rule). The stand-in engine must fill them |
| `Thread/act.ids` and `MessageBody/prefetch.ids` became optional (exactly one of `ids` or `selector`; at least one of `ids` or `threadIds`) | Inputs only get wider; every existing call still parses |

## 1. Engine thread items (gap list section 1)

| Gap | Outcome | Where, or why |
|---|---|---|
| E1 `state` frame names the types that changed (O1) | already there | `wire.ts:Frame` `state.types` (type → newest `seq`); `wire.ts:ChangeType` lists Setup, Account, Settings, Consent, AiProvider, Calendar, Counts |
| E2 `openExternal` host event | already there | `wire.ts:HostEvent` `openExternal {url, purpose:'oauth'}` |
| E3 one clock: `Session.now` + `clock` event (S8) | already there | `schemas/session.ts:Session.now`; `wire.ts:HostEvent` `clock {now}` |
| E4 first-run meaning (O7) | already there | `Session.setup {completedAt?, skippedAt?}`, `Session.hasAccounts` counts demo; `Setup/end {reason}` (`api/ai.ts`) |
| E5 named capability flags (S14) | already there | `schemas/session.ts:capabilityKeys` (all ten asked, plus more); `Session.capabilities` is an open map |
| E6 `secret` registry tag (S3) | already there | `registry/define.ts:MethodSpec.secret`; generated `secretMethods`, and `listenerMethods`/`mcpMethods` exclude it. Log redaction is F7's catalog |
| E7 undo of guest-notifying writes (C7) | already there | `schemas/common.ts:Receipt.undoUntil`; `Operation/undo` cancels while held, inverse after (`api/mail.ts`) |
| E8 wire type for times (C3) | already there | `schemas/calendar.ts:EventTime` `{type:'utc'}`, `{type:'date'}`, `{type:'floating'}` (discriminated, ARCH 9.3), `Event.allDay`, `Event.timeZone` |
| E9 thread row display fields | already there | `schemas/mail.ts:ThreadRow.fromName`, `participants`, `accountId` |
| E10 `Fixture/control` knobs | rejected | Belongs to F6 (`packages/contract-fixture`), which another agent is building; forwarded there |
| E11 stand-in scenarios | rejected | F6, as E10 |
| E12 error types the UI keys on (C12, A6) | already there | `errors.ts:errorTypes` has `conflict`, `rangeTooLarge`, `notConfigured`, `providerError`, `stateMismatch`; open on the wire |
| E13 one name, `resumeAt` | rejected | Decided by the Engine thread: `Setup/status` keeps `pausedUntil`; an account's pause is `status.until` (port proposal name); error replies use `resumeAt`. Each is one name in its own type |
| E20 `Setup/begin|end|status` arguments (O2) | already there | `api/ai.ts` `Setup/begin {origin}` → `{setupId}`; `Setup/end {setupId?, reason}` idempotent; `Setup/status {setupId?}` |
| E21 `Setup/status` per-account fields (O3, O12) | already there | `schemas/session.ts:SetupAccount`: `accountId`, open `state`, `firstWindow.done`, `ai.{model, reasonCode}`, `pausedUntil`, `reasonCode`, `runId`; `SetupStatus.errors[{phase, reasonCode, at}]`. The pause class is in `reasonCode` (`rate.minute` vs `quota.daily`). Clarified: `firstWindow.total` is min(target, threads available) once known |
| E22 `Consent/*` verbs and record (O11, S12) | already there | `api/ai.ts` `Consent/get|grant|revoke`; `schemas/ai.ts:Consent` with `provider`, `model`, `needsReconsent`. The `consent.model` column is F4's |
| E23 AI provider table, no key characters (S1, O10) | closed | `schemas/ai.ts:AiProvider` (`keySource`, `envVar`, `trainsOnInputs`, `sttCapable`, `lastTest`, ...); `last4` removed |
| E24 write-only key methods (S3) | already there | `api/ai.ts` `Ai/setKey`, `Ai/removeKey` (refused for env keys), `api/native.ts` `Ai/pasteKey`; outputs now carry `keySource` only |
| E25 `Settings.ai` (S5) | already there | `schemas/settings.ts:AiSettings`: `features.{ask,summaries,drafts,plans,voice}`, `providers[id].{address, paid}` (local addresses, Gemini paid), `dailyCap {enabled, tokens}` (150,000) |
| E26 `Ask/run` input, run id, cancel (A1) | already there | `api/ai.ts` `Ask/run` → `{runId, conversationId}`; `scope.accountIds` absent = all; `Ask/cancel {runId}` |
| E27 Ask `progress` payload (A2) | closed | `wire.ts:Frame` `progress`: `step`, `delta`, `turnId`, and new kinds `citation` and `proposal` with their payloads (also F9-20) |
| E28 answer turn (A3) | already there | `schemas/ai.ts:AskTurn` (`answer.blocks[{text, strong}]`, `citations`, `noSource`, `model`, `stopped`, `proposals`, `steps`) |
| E29 citation union (A4) | already there | `schemas/ai.ts:Citation` `message` / `event` |
| E30 proposals and decide (A5) | already there | `schemas/ai.ts:Proposal` (`reply`, `addEvent`, `triage`; `state`); `Ask/decide` → receipt |
| E31 conversations (A7) | already there | `schemas/ai.ts:Conversation`; `ViewSpec` `conversations`; `Conversation/get|destroy` |
| E32 `Blob/put` for dictation (A8) | already there | `api/mail.ts` `Blob/put {bytes: Uint8Array}` (its buffer is transferred); `Ai/transcribe {requestId, blobId}` |
| E33 model lists (S2) | already there | `Ai/models {provider}` → `AiModel[]` (`stt` flag), `live` |
| E34 provider and model test (S4) | already there | `Ai/testKey {provider}`, `Ai/test {model}` |
| E35 AI readiness (A6) | already there | `Ai/status` → `AiFeatureStatus[]` |
| E36 usage and pause (S13) | already there | `Ai/usage` → `AiUsage` (`backgroundTokens`, `cap`, `pausedUntil`, `byModel`) |
| E37 Ask suggestions (A16) | already there | `Ask/suggestions` |
| E38 queue rows (S21) | already there | `schemas/session.ts:QueueItem`; `Queue/list|retry|discard` |
| E40 onboarding window methods, handoff event (O8) | closed | `Window/openOnboarding`, `Window/finishOnboarding` were there; new `wire.ts:DesktopEvent` `shown` (ready-to-show) on the new `desktop` frame |
| E41 native permission reads and requests (O9, S11) | closed | `System/microphone` (check or ask), `System/notifications` (read), `System/login` were there; new `System/openSettings {pane}`. A notification request is `Notification/test` (the first post prompts) |
| E42 host settings and notifications (S11) | closed | `HostSettings.{menuBar, openAtLogin}`, `NotificationSettings.{enabled, perAccount}` were there; new `reconnectReminder`. Lanes are fixed (Do now and Important updates only, DESIGN 7.13), so no field |
| E43 listener and clients (S22, S23) | already there | `Listener/get|set`, `Clients/list|grant|revoke|audit` (`lastSeenAt`) |
| E44 diagnostics preview and save (S20) | already there | `Diagnostics/preview` → `DiagnosticsBundle`; `Diagnostics/export` → blob for `File/save` |
| E50 event reads (C1, A9) | already there | `ViewSpec` `events {from, to, calendarIds?, includeDeclined?, includePlans?}` (≤ 62 days, no 200 cap, else `rangeTooLarge`); `View/move {range}`; `Event/get`; `View/query` |
| E51 search spec and one parser (A10) | already there / rejected | `schemas/mail.ts:SearchQuery` is structured (`in:done` included). A shared parser is rejected: the contract holds no behaviour, and with operators structured on the wire only the search field parses text |
| E52 remote search once per Return (A11) | already there | `Search/remote {opId, query}` → `{runId, receipt}`; results join the `search` window; failure arrives as `WindowBody.error` (new) |
| E53 plans from mail (C9) | already there | `schemas/calendar.ts:Plan`; `Plan/get|confirm|dismiss`; `ViewSpec` `plans` |
| E54 mail settings, image allow-list (S10) | closed | `MailSettings.{undoSendSeconds, followUpDays, remoteImages, imageAllowList}` and `ui.swipeDirection` were there; new `Mail/allowImages {sender, allow}` edits the list. A `SenderRule` kind `images` is rejected: one list, in settings, avoids two stores for one fact |
| E55 retention size (S22) | already there | `DiagnosticsBundle.storage` (`dbBytes`, `bodyBytes`, `attachmentBytes`, ...) |

## 2. Providers items (gap list section 2)

| Gap | Outcome | Where, or why |
|---|---|---|
| P1 connect lifecycle (O4) | already there | `Account/connect {provider, loginHint?, setupId?}` → `{connectId}`; `Account/reconnect`, `Account/grantPermissions`, `Account/cancelConnect`; `connect` frame `{connectId, mode, state, accountId?, reasonCode?}` |
| P2 reconnect results (O14) | already there | `status.ts:reasonCodes` `auth.wrongAccount`, `auth.denied`, `auth.timeout`, `auth.cancelled`, `permission.*` on the `connect` frame |
| P3 `Account/discover` (O5) | already there | `api/account.ts` `Account/discover {address}` → `{provider, reasonCode?}` (open enum incl. `unsupported`) |
| P4 account row (O6, S6) | closed | `schemas/account.ts:Account` (`name`, `colorTag`, `demo`, `health.status`, `health.reasonCode`, `health.reconnectBy`, `health.lastSyncAt`, `missingPermissions`, `aiAllowed`); `resumeAt` is `status.until`; new `pendingChanges`. Setters: `Account/set`, `Account/disconnect` |
| P5 occurrence identity (C2) | already there | `Event.id` = `<seriesId>@<originalStartUtc>`, `seriesId`, `originalStart`, `recurring`, `exception`, `rev`; writes take the `id` |
| P6 `Event/rsvp` input (C6) | already there | `{opId, id, response, scope:'occurrence'|'series', notify?}` → `Receipt` with `undoUntil` |
| P7 `Event/set` shape (C3, C4) | already there | One `EventChange` per call (`create`, `update {id, scope}`, `destroy {id, scope}`), `scope` incl. `following` (refused with a reason until built). A JMAP batch is not needed: the calendar edits one event at a time |
| P8 editability (C4) | closed | `Event.can`, `lockedReason`, `htmlLink` were there; new required `Event.sync` (`localOnly` has no Delete). `isOrganizer` is `organizer.self` |
| P9 detail fields (C5) | already there | `Event.location`, `description`, `conference`, `organizer`, `attendees`, `myResponse`, `transparency`, `status` |
| P10 calendars list (C8) | already there | `Calendar/get` → `Calendar {shown, providerHidden, colorTag, readOnly, primary}`; `Calendar/set` local only |
| P11 `reasonCode` list (O13) | already there | `status.ts:reasonCodes` (open); the code-to-copy table is the UI's (DESIGN 7.15) |
| P12 lease device name (S7) | already there | `schemas/account.ts:Lease.holderDeviceName` |
| P13 Retry now while paused | already there | `Sync/request {force}` (once per throttle pause) |
| P14 invite ↔ email (C10) | already there | `Event.invite {threadId, messageId, fromName}` |
| P15 recurrence text (C11) | already there | `Event.recurrence {rrule?, text}` |
| P16 calendar status and settings (C13, C14, S19) | already there / closed | `Calendar.status {state, until, reasonCode}` per calendar (D12); `CalendarSettings.defaultCalendarId`; week start is `ui.calendar.weekStart` (UI-1) |

## 3. UI-core items (gap list section 3)

| Gap | Outcome | Where, or why |
|---|---|---|
| U1 palette target | rejected | Renderer-only (F9 `CommandRegistry`); the contract only supplies `ThreadRow.fromName`/`subject` |
| U2 registry fields | rejected | Renderer-only (F9) |
| U3 settings in the palette, deep links | rejected | Renderer-only (F9) |
| U4 keyboard contexts | rejected | Renderer-only (F9 `ContextName`) |
| U5 sheet host | rejected | Renderer-only (F9 shell) |
| U6 keymap utilities | rejected | Renderer-only (F9 `formatChord` etc.); the contract stores the keymap (UI-7) |
| U7 undo for settings | rejected | Renderer-only; `Settings/set` returns a receipt the stack can hold |
| U8 frame-subscription hook | rejected | Renderer-only; the contract side is `Client.subscribe` and the frame union |
| U9 `useNow()` | rejected | Renderer-only; its contract half is E3 |
| U10 component props | rejected | Renderer-only (F9 props.ts) |
| U11 `Settings.ui` fields (S9, A14, A15, C14) | closed | See UI-1 to UI-13 |

## 4. UI-core's F9 asks

| Ask | Outcome | Where, or why |
|---|---|---|
| F9-1 `Thread/act` on a selector `{spec, group?, atState}` | closed | `schemas/mail.ts:ThreadSelector {spec, section?, atState}`; `Thread/act.selector` (exactly one of `ids`, `selector`) |
| F9-2 `setLane`, `laneUp`, `laneDown` with `alsoForSender` | closed | `ThreadAction` `lane {lane, alsoForSender?}` (absolute) and `laneStep {direction, alsoForSender?}` |
| F9-3 other action names (`unbookmark`, `moveToHome`, `setDue`, `remindIfNoReply`, `clearFromHome`) | already there | `bookmark {on}`, `restore`, `due {date?}`, `reminder {at?, ifNoReply}` (no `at` = after `mail.followUpDays`, now documented), `later` with no `until` |
| F9-4 `Thread/why` | closed | `api/mail.ts` `Thread/why {threadId}` → `schemas/mail.ts:WhyItsHere {sentence, quote?, messageId?, lane, rankSource}` |
| F9-5 `Thread/followup` | already there | `Ai/followup {threadId}` → `FollowupSuggestion`; `ThreadRow.follow.suggestion` says one is ready |
| F9-6 `Unsubscribe/run` | already there | `api/account.ts` |
| F9-7 `Operation/undo` receipt is the inverse's | already there | `Operation/undo {opId, undoOpId}`: the receipt's `opId` is the inverse's |
| F9-8 send with `markDone`, `queuedAt` | closed | `SubmissionAction.send.alsoDone` was there; new `Submission.queuedAt` |
| F9-9 `sendNow`, `reschedule` | already there | `SubmissionAction` `sendNow`, `reschedule`, plus `sendAnyway` (uncertain) and `retry` (failed) |
| F9-10 draft `source {messageId, mode}`, forward copies attachments | already there | `DraftFields.mode` + `replyToMessageId`; `DraftAttachment.source` |
| F9-11 draft conflict | already there | `Draft.conflict`, `Draft/resolve {choice}`, `Draft/changed` frame |
| F9-12 body prefetch by thread | closed | `MessageBody/prefetch.threadIds` |
| F9-13 `Mail/frame` `showQuotes`, honouring the allow-list | already there | `Mail/frame.quotesOpen`, `Mail/toggleQuotes`; the engine applies `mail.imageAllowList` |
| F9-14 `Mail/allowImagesFrom` | closed | `Mail/allowImages {opId, sender, allow}` |
| F9-15 `attachment.put` | already there | `Blob/put` |
| F9-16 sync request ends a throttle pause | already there | `Sync/request.force` |
| F9-17 connect progress and cancel, reconnect cancel | already there | `connect` frame; `Account/cancelConnect {connectId}` serves both |
| F9-18 `setAiAllowed` | already there | `Account/set.aiAllowed` |
| F9-19 `Setup/retry` | closed | `api/ai.ts` `Setup/retry {accountId, setupId?}` → `Ok` |
| F9-20 Ask frames `citation`, `proposal` | closed | `wire.ts:Frame` `progress` kinds `citation`, `proposal` with `citation`, `proposal` |
| F9-21 `Ai/request` kinds `draft`, `polish`, `summary`; polish as change ranges | already there / rejected | `Ai/draft`, `Ai/polish`, `Ai/request {kind:'summary'}`. Change ranges are rejected: polish works on HTML, so offsets would break on markup; the composer diffs `html` against its own |
| F9-22 transcribe | already there | `Ai/transcribe {blobId}` |
| F9-23 `Consent/set`, `Settings.ai.consent` | already there | `Consent/grant|revoke|get`; the record is `Consent`, not a settings field |
| F9-24 `engine.restart` | closed | `api/native.ts` `Engine/restart` (desktop, served by main) |
| F9-25 `diagnostics.copy`, host-only fallback | closed | `api/native.ts` `Diagnostics/copy` → `{source:'engine'|'host'}` |
| F9-26 `Diagnostics/preview` as text | already there | Returns `DiagnosticsBundle`; the renderer formats it |
| F9-27 `seq` on window, state and receipt | already there | `State.seq` in `WindowBody.state`, `Receipt.appliedState`, every frame's `seq` |
| F9-28 `drafts` view; failed windows | closed | `ViewSpec` `drafts` was there; new `WindowBody.error` (the window stopped) |
| F9-29 `window.offset` | already there | `WindowBody.position` (now documented as the index of `ids[0]`) |
| F9-30 `window.groups` across the whole view | closed | `WindowBody.sections` now required, `WindowSection.label` added, keys documented (`do`, `fromLater`, `update`, `low`, `follow`; Later buckets; sender address) |
| F9-31 hold activity ping | already there | Repeat `View/hold` (documented) |
| F9-32 `Operation.remote` | already there | `Operation.state` (`queued`, `syncing`, `synced`, `failed`, `conflict`) |
| F9-33 `Session` fields | already there | `schemas/session.ts:Session` |
| F9-34 `parked {reason, since}`, sent by main when the engine cannot | closed | `HostEvent.parked.at`; new `wire.ts:DesktopEvent` `engine {state, reasonCode?, message?, canRetry?, at}` on the `desktop` frame, which `routeByHost` merges |
| F9-35 account extras (`isDemo`, `baselineDoneAt`, `colorIndex`, `paused.reason`, `offline.changesWaiting`, `backfilling.firstWindow`, `error.message`) | closed / already there / rejected | `demo`, `baselineDoneAt`, `colorTag`, `status.paused.{class, reason}` and `health.reasonCode` were there; `firstWindow` is `baselineDoneAt` absent; new `Account.pendingChanges` for changes waiting. `error.message` is rejected: the UI maps `reasonCode` to DESIGN 7.15 copy and provider text never reaches the screen |
| F9-36 counts `handledToday`, hidden during first sync | closed | New `CountsBlock.handledToday`; hiding is the renderer's, from `baselineDoneAt` |
| F9-37 `Event/query` for the agenda | already there | `View/query {spec:{kind:'events'}}` + `Event/get` |
| F9-38 `Setup/status` `message` beside `reasonCode` | rejected | Copy comes from `reasonCode` (DESIGN 7.15), as everywhere |
| F9-39 thread row fields | closed | New `ThreadRow.fromLater`, `SummaryRef.local` (on this Mac); `unsubscribe` now required. Already there: `summary` (`SummaryRef`, `state:'pending'`), `fromName`, `participants`, `rank.{lane, importance, source}`, `workflow.{dueDate, dueSource, status, laterUntil, doneAt, bookmarked}`, `follow.{since, suggestion}`, `partial`, `messageCount`, `lastDate`, `labels`, `hasAttachments`, `summary.action` (icon from `kind`) |
| F9-40 draft `source` | already there | As F9-10 |
| F9-41 the `ui` settings object | closed | UI-1 to UI-13 |
| F9-42 `mail.undoSeconds`, `nudgeDays`, `imageAllowSenders` | already there | `mail.undoSendSeconds`, `followUpDays`, `imageAllowList` |
| F9-43 AI providers and consent in settings | already there | `Ai/providers` (never keys), `Consent/get`; settings hold only per-feature choices and non-secret provider settings |
| F9-44 `drafts` view of `Draft` rows | already there | `ViewSpec` `drafts`, `RowType` `Draft` |

## 5. `Settings.ui` (UI-core's freeze list)

All in `schemas/settings.ts:UiSettings`; defaults are in the field comments.

| Field | Outcome | Shape and default |
|---|---|---|
| UI-1 `theme` | already there | `light | dark | system`, default `system` |
| UI-2 `density` | already there | `compact | default | roomy`, default `default` |
| UI-3 `keyHints` | already there | `tooltip | always`, default `tooltip` |
| UI-4 `singleKeys` | already there | boolean, default true |
| UI-5 `holdMs` | closed | int 100-2,000, default 250 |
| UI-6 `dock` | already there | `{open, tab: ask | today, width?}`, default `{open: false, tab: 'ask'}` |
| UI-7 `keymap` | closed | command id → `{chord, phase?: tap | hold}[]` (≤ 8), default `{}` |
| UI-8 `sidebarMinimised` | closed | boolean, default false |
| UI-9 `swipeDirection` | already there | `doneRight | doneLeft`, default `doneRight` (F9's `swapTriageArrows` is `doneLeft`) |
| UI-10 `devDetails` | already there | boolean, default false |
| UI-11 `lastAccount` | already there | `all` or an account id, default `all` |
| UI-12 `palette.recents` | closed | command ids, newest first, ≤ 50, default `[]` |
| UI-13 `calendar.weekStart` | closed | int 0-6 or absent (follow the macOS locale), default absent |

## 6. Providers port proposal v2 and F3 ports

| Check | Outcome | Where, or why |
|---|---|---|
| PV-1 status vocabulary | already there | Same eleven states (`status.ts:AccountStatusSchema`). Field names follow the F1 seed, which F3 already imports: `paused.{until, class, reason}`, `backfilling.{done, of?}`, `needsPermission.missingScopes`, and the copy key as `AccountHealth.reasonCode` beside the status rather than inside each state. Same facts, mapped one to one |
| PV-2 `ReasonCode` | already there | `status.ts:reasonCodes` is the proposal's list plus `auth.denied|cancelled|timeout` and `ai.*` |
| PV-3 account facts | closed | `reconnectBy`, `sendBlockedUntil`, `baselineDoneAt`, `lease`, per-calendar status (`Calendar.status`) were there; `missingPermissions[].missingScopes` added to match F3 `AccountRuntime`. `firstWindow` lives in `SetupAccount` |
| PV-4 capabilities | closed | `AccountCapabilities.threading` added (F3 `Capabilities.threading`); other names already match |
| PV-5 `Account/*` and `ConnectRequest` | already there | `mode` is the method (`connect`, `reconnect`, `grantPermissions`) and the `connect` frame's `mode`; `loginHint`; `expectedSubject` is engine-side from the stored account; `preset`, `server` |
| PV-6 `Sync/request` | already there | Refused with `accepted:false`, `reasonCode`, `resumeAt` and no network call while paused (`governor.admission`); `force` |
| PV-7 `Event/*` | already there | `EditScope` matches F3; `Event/rsvp` offers `occurrence | series` (F3 also takes `following`); an edit conflict is F3 `CalendarWriteResult.conflict`, and reaches the UI as `Operation.state:'conflict'` or error type `conflict`, never an error class |
| PV-8 `Unsubscribe/run` | already there | Built on `HeaderFacts` (List-Unsubscribe, -Post) and `capabilities.unsubscribeHeaders` |
