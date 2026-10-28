# UI-screens gap list for the contract freeze (HANDOFF-READY)

Written 2026-10-27 (day 1) by the UI-screens thread, for the Engine thread (`eng-contract`, `eng-ai`, `eng-host`, `eng-views`, `eng-time`, `eng-store`), the Providers thread (`prov-gov`, `prov-cal`, `prov-gmail`) and the UI-core thread (`ui-foundation`, `ui-shell`), and for the day-3 UI freeze reviewer. Each mockup element was mapped to its DESIGN section and to the planned contract (plan 10 §4.1, E5, E7; plan 30 §4.1-4.5, §8; ARCH §6, §8, §9, §12.3; plan 20). The detail, with the evidence for every line, is in four maps next to this file:

- `map-onboard.md`: onboarding, first sync, the drill, zero accounts and demo, the reconnect sheet (17 gaps)
- `map-calendar.md`: day, week and month, event detail, RSVP, repeat scopes, calendars, plans from mail (16 gaps)
- `map-settings.md`: all eight sections, AI providers and keys, accounts, keyboard, tools, diagnostics (24 gaps)
- `map-ask.md`: the Ask dock, Today, the ⌘K palette, the Search page, the shortcut sheet (18 gaps)

`pr21-absorption.md` covers how PR #21's screens are taken by path and which test closes each Appendix C finding.

## In plain English

Before the engine's "rules" freeze on day 3, we checked every screen we are building against those rules, looking for things the screens must show or do that the rules can't express yet. The four screen areas turned up 75 gaps. After merging duplicates, 70 remain.

43 of them matter before the freeze, because adding them later would break code that's already written. Examples:

- How "Waiting for Google in your browser…" and its Cancel button work.
- How the first-sync screen hears about progress.
- How one occurrence of a repeating meeting is named.
- What an Ask answer and its citations look like.
- How an AI key is saved without the screen ever holding it.

The rest can be added later without breaking anything.

We also settled 18 small questions where the plans disagreed. In each case we followed DESIGN or the plans' stated default. Nothing here needs the owner.

> **What this means:** The engine and UI-core teams get one list of what the screens need, sorted by urgency, with a proposed shape for each item, so they can fix it before the freeze.

## How to read this

- **Tier 1, freeze-shaping.** It changes the input, output or meaning of a method, frame or type that freezes at C1, or a UI-core interface frozen in F9. Fixing it later would break callers, so it must be in contract-v1.
- **Tier 2, wanted at the freeze.** Purely additive (a new method, an optional field, an open-enum value). Without it, the stand-in engine can't serve our screens when they start on days 5-6.
- **Tier 3, later.** Additive, needed by Phase 2. It can go through CONTRACT-CHANGE-PROPOSED.
- IDs: `O` = onboard, `C` = calendar, `S` = settings, `A` = ask. For example, `O4` is GAP-4 in `map-onboard.md`. Each item gives a one-line proposed shape; the map file has the full shape, the reasoning and the stand-in knob.

## 1. To the Engine thread

### 1.1 `eng-contract`: envelope, frames, session, fixture

| # | Tier | Need | Proposed shape (short) | From |
|---|---|---|---|---|
| E1 | 1 | `state` frame must say *which types* changed so screens re-read singletons (Setup, Account, Settings, Consent, AiProvider, Calendar) | `state {types: {Setup: 's12', Account: 's40', Settings: …}}`; a client re-gets a type when its token moves | O1, S-unclear 14 |
| E2 | 1 | `openExternal` host event for OAuth (named in plan 10 E3 item 6, missing from §4.1's host-channel list) | `openExternal {url, purpose:'oauth'}`, main allows only provider sign-in origins | O-unclear 14 |
| E3 | 1 | One clock in the renderer that follows the fixture's `APLOS_NOW` (reconnect-within-24 h, now line, Today, "Synced 2 min ago") | `Session/get.now` + a `clock` host event when `Fixture/control` sets the clock; UI reads only `useNow()` (E/UI-core pair with U5) | S8, C-unclear 12 |
| E4 | 1 | First-run meaning for main and the harness: `hasAccounts` alone reopens onboarding forever after "Skip setup" with zero accounts | `Session/get.setup: {completedAt?, skippedAt?}`; `hasAccounts` counts demo accounts; written by `Setup/end {reason}`; main opens onboarding only when none are set | O7 |
| E5 | 1 | Named capability flags so unbuilt features show "Not available yet" | `Session/get.capabilities: {listener, clients, diagnostics, queueInspector, calendarWrite, remoteSearch, transcribe, microphone, notifications, loginItem}` (open map of booleans) | S14 |
| E6 | 1 | A secret tag in the registry: methods that carry a key are never logged, never exposed over socket/HTTP/MCP, never echoed | registry tag `secret`; logger catalog redacts the input; transports refuse it except the Electron port | S3 |
| E7 | 1 | `Operation/undo` meaning for writes that notify other people (event delete, RSVP, series edits): an inverse emails guests twice | calendar ops queued with `notBefore = now + 8 s`; receipt gains `undoUntil?`; `Operation/undo` *cancels* a held op, inverse only afterwards | C7 |
| E8 | 1 | Wire type for times | event `start`/`end` as `{utc:number} \| {date:'YYYY-MM-DD'}`, `allDay`, `timeZone?` (IANA); never `Date` | C3 |
| E9 | 1 | Thread row display fields used by the palette context line and search rows | `fromName`, `participants[]` (names), `accountId`; probably also needed by `ui-home` | A-unclear 18 |
| E10 | 1 | `Fixture/control` signatures (frozen in F6) must include our knobs | `advanceSetup`, `resolveConnect {connectId, outcome, delayMs}`, `failNextSetupPhase`, `setReconnectBy`, `calendarChange {eventId, patch}`, `ask.script`, `ai.failNext {type, provider}`, `search.remote.result`, `search.remote.failNext`, `transcribe.result`, `clock {set\|advanceMs}`, `failNextWrite {type}` | O15, C16, A harness, S24 |
| E11 | 2 | New stand-in scenarios | `reconnect-due` (`reconnectBy` within 24 h), `empty-skipped`, `calendar-dense` (>200 occurrences a month), `ask-scripted`, `today-busy`, `ai-env-groq` (Groq from env, Ollama reachable), `two-accounts` | O15, C16, A, S24 |
| E12 | 2 | Error types the UI keys copy on | `conflict` (edit raced a remote change), `rangeTooLarge`, `notConfigured` (AI), `providerError`, `stateMismatch`; open enum | C12, A6 |
| E13 | 2 | One status-field name | `resumeAt` everywhere (`Setup/status`, `Account.status`), not `pausedUntil` | O-unclear 1 |

### 1.2 `eng-ai`: setup, consent, providers, Ask

| # | Tier | Need | Proposed shape (short) | From |
|---|---|---|---|---|
| E20 | 1 | `Setup/begin|end|status` have no arguments; "Show welcome" must see only its own session; close and late connects must be safe | `Setup/begin {origin:'onboarding'\|'settings'} → {setupId}`; `Setup/end {setupId, reason:'finished'\|'closed'\|'skipped'\|'demo'}` idempotent; `Setup/status {setupId?}` | O2 |
| E21 | 1 | `Setup/status` per-account fields: state values, first-window-done (a 12-thread inbox reads "12 of 50" forever), AI failure reason and provider, run id, error list | add `accountId`, `state` (open enum `connecting\|finding\|reading\|sorting\|ready\|paused\|failed\|notConnected`), `firstWindow.done`, `total = min(target, available)`, `ai.{state, provider, model, reasonCode}`, `pause {until, class}`, `runId`, `errors[{phase, reasonCode, at}]`; counters monotonic per `runId` | O3, O12 |
| E22 | 1 | `Consent/*` has no verbs, no model in the record, unnamed scope; shared by onboarding and Settings | `Consent/get {scope:'background'} → {version, granted, provider?, model?, needsReconsent}`; `Consent/grant {scope, version, provider, model}`; `Consent/revoke {scope}`; `consent` table gains `model` (schema 0001, with `eng-store`) | O11, S12 |
| E23 | 1 | AI provider table: no method, no row shape; status and key source without key characters | `Ai/providers → [{id, group:'hosted'\|'local', label, status, keySource:'env'\|'keychain'\|'none', envVar?, address?, defaultAddress?, trainsOnInputs, paidMarked?, sttCapable, lastTest?}]`; never a key or a suffix of one (today's code shows the last 4 characters) | S1, O10 |
| E24 | 1 | Write-only key methods (with E6's secret tag) | `Ai/setKey {provider, key}` → `{ok}` (never echoes); `Ai/removeKey {provider}` refused when `keySource:'env'` with a reason | S3 |
| E25 | 1 | `Settings.ai`: per-feature pair plus the rest | `features.{ask,summaries,drafts,plans,voice}.{provider, model}`; `localAddresses.{ollama, lmstudio, custom}`; `dailyCapTokens` (default 150,000, null = no limit); `gemini.paid` | S5 |
| E26 | 1 | `Ask/run` input, run id, cancel | `Ask/run {conversationId?, question, scope:{accountIds?\|'all', searchAllMail?}, context?:{threadId?, eventId?}} → {runId, conversationId}`; `Ask/cancel {runId}` (keeps the partial answer) | A1 |
| E27 | 1 | Ask `progress` frame payload | `progress {runId, kind:'step'\|'text'\|'done'\|'error', step?:{id, text, headline?, counts?}, delta?, turn?}` | A2 |
| E28 | 1 | Answer turn schema | `AskTurn {id, question, answer:{blocks:[{text, strong?:[range]}]}, citations, noSource:boolean, provider, model, stopped?, proposals[]}` | A3 |
| E29 | 1 | Citation must support hover and click and calendar sources (widening later is breaking) | discriminated union: `{n, kind:'message', messageId, threadId, quote, fromName, date, subject}` \| `{n, kind:'event', eventId, title, start}` | A4 |
| E30 | 1 | Proposals: shape, decide, receipt for Undo Z, persisted state | `Proposal {id, kind:'addEvent'\|'reply'\|…, consequence, payload, state:'open'\|'accepted'\|'dismissed'}`; `Ask/decide {opId, proposalId, accept} → receipt` (with `prov-cal` for events) | A5 |
| E31 | 1 | Conversation type (recents, history) | `Conversation {id, title, updatedAt, turns}`; list via `View/watch {kind:'conversations'}` (list spec Tier 2) | A7 |
| E32 | 1 | `Blob/put` shape for dictation | `Blob/put` takes a transferable `ArrayBuffer` → `{blobId}`; `Ai/transcribe {blobId, feature:'voice'} → {text}` (Tier 2) | A8 |
| E33 | 2 | Model lists per provider | `Ai/models {provider} → [{id, label, sttCapable}]`; local servers queried live | S2 |
| E34 | 2 | Provider and model Test | `Ai/test {provider, model?} → {ok, ms, reasonCode?}`; runs automatically after `Ai/setKey` | S4 |
| E35 | 2 | AI readiness for Ask's no-provider and error states | `Ai/ready {feature} → {ready, reasonCode?}` or a field on `Ai/providers` | A6 |
| E36 | 3 | Usage and pause state for Settings ("Paused for today. Resumes tomorrow.") | `Ai/usage → {today:{tokens, cap}, pausedUntil?, byModel[]}` | S13 |
| E37 | 3 | Ask suggestions (three plain lines) | `Ask/suggestions → string[]` (static list acceptable for round 1) | A16 |
| E38 | 3 | Queue inspector rows for jobs | rows `{id, kind, state, attempts, lastError?}` (with `eng-time`, `eng-host`) | S21 |

### 1.3 `eng-host`: native methods, listener, clients, diagnostics

| # | Tier | Need | Proposed shape (short) | From |
|---|---|---|---|---|
| E40 | 2 | Native window methods for onboarding (PR #21's `onboarding.open/finish` have no home) | `window.openOnboarding {mode:'first'\|'review'}`, `window.finishOnboarding`; host event `windowHandoff` so the onboarding renderer fades in the `ready-to-show` callback (F4); main calls `Setup/end {reason:'closed'}` itself on a red-button close | O8, O-unclear 7, 15 |
| E41 | 2 | Native permission reads and requests | `system.microphone.get\|request`, `system.notifications.get\|request` (spike: Electron has no documented authorization request), `system.login.get\|set` | O9, S11 |
| E42 | 2 | Host-level settings: menu-bar residency, open at login, notifications per account | `Settings.host.{menuBar, openAtLogin}`, `Settings.notifications.{enabled, perAccount, lanes}` field names at C1 | S11 |
| E43 | 3 | Listener state and clients | `Listener/get → {on, socketPath?, port?}`; `Clients/list\|revoke\|grant`, rows `{id, name, scopes[], createdAt, lastUsedAt}` | S22, S23 |
| E44 | 3 | Diagnostics save after preview | `Diagnostics/preview → {sections}`; `Diagnostics/save` through `file.save` | S20 |

### 1.4 `eng-views`, `eng-time`, `eng-store`

| # | Tier | Need | Proposed shape (short) | From |
|---|---|---|---|---|
| E50 | 1 | Event reads: plan 30 lists `Event/query` but plan 10's verb list has no read for events, and the `View/watch` union has no events member; a month can exceed 200 rows | `View/watch {spec:{kind:'events', from, to, calendarIds?, include?:{plans?, declined?}}}` with no 200 cap for this kind (range ≤ 62 days, else `rangeTooLarge`); `View/move {windowId, from, to}`; `Event/get {ids}`; `View/query` with the same spec for one-shot reads (Today, Home's "Next:") | C1, A9 |
| E51 | 1 | Search spec and one shared operator parser | `search {text, ops:{from?, to?, subject?, hasAttachment?, before?, after?, in?}}` (incl. `in:done`); one parser exported from `packages/contract` so the UI's tokens and the engine agree | A10 |
| E52 | 1 | Remote search exactly once per Return (a live view would re-call Google on `reset`) | separate command `Search/remote {opId, query} → receipt`; results merge into the local window with `origin:'remote'`; progress and paused states via `progress`; plan 20's `server` flag folds into it | A11 |
| E53 | 2 | Plans found in mail have a job but nowhere to live | type `Plan {id, threadId, messageId, fromName, quote, title, start, end, allDay, timeZone?, location?, state}`; `Plan/confirm {opId, id, calendarId?, edits?}`, `Plan/dismiss {opId, id}` (with `eng-ai`, `eng-store`) | C9 |
| E54 | 2 | Settings fields for Mail | `mail.undoSendSeconds` (0/5/8/10/20/30), `mail.followUpDays` (3), `mail.remoteImages` (`block`), `mail.swipeDirection`; per-sender image allow-list as `SenderRule {sender, kind:'images'\|'lane'}` with `SenderRule/query\|set` | S10, S-unclear 21 |
| E55 | 2 | Retention size fact | `Store/usage → {bytes}` or a field in `Diagnostics/preview` | S-unclear 22 |

## 2. To the Providers thread

| # | Tier | Need | Proposed shape (short) | From |
|---|---|---|---|---|
| P1 | 1 | OAuth connect lifecycle: no pending state, no Cancel, late resolve after `Setup/end` | `Account/connect {provider, loginHint?, setupId?} → {connectId}` at once; `Account/reconnect {accountId} → {connectId}`; `Account/cancelConnect {connectId}`; frame `connect {connectId, kind, state:'waiting'\|'connected'\|'failed'\|'cancelled', accountId?, reasonCode?}` | O4 |
| P2 | 1 | Reconnect result and failures; one sheet for `needsReauth`, `needsPermission` and `reconnectBy` | via P1's frame, `reasonCode` in {`wrongAccount`, `scopeMissing`, `denied`, `timeout`, `cancelled`}; the engine chooses full consent for `needsPermission`, so the sheet always calls `Account/reconnect` | O14 |
| P3 | 1 | `Account/discover` shape (round 1: Google only) | `Account/discover {address} → {provider:'google'\|'unsupported', reasonCode?}` | O5 |
| P4 | 1 | Account row fields every screen reads | `{id, name, address, provider, colorTag, demo, status, reason?, resumeAt?, reconnectBy?, lastSyncedAt?, missingScopes?, aiAllowed}`; setters `Account/set {name?, colorTag?, aiAllowed?}`, `Account/remove` | O6, S6 |
| P5 | 1 | Occurrence identity for repeating events | `Event.id = "<seriesId>@<originalStartUtc>"` for expanded occurrences; `seriesId?`, `originalStart?`, `recurring`, `exception`, `rev`; `Event/set` and `Event/rsvp` take `ref:{id}` | C2 |
| P6 | 1 | `Event/rsvp` input | `{opId, ref, response:'accepted'\|'tentative'\|'declined', scope:'occurrence'\|'series'} → receipt {undoUntil}` | C6 |
| P7 | 1 | `Event/set` shape | JMAP style `{create, update:{id:{patch, scope}}, destroy:[{id, scope}]}` with `scope: occurrence\|series\|following` (`following` refused with a plain reason until built) | C-unclear 3, 4 |
| P8 | 2 | Event editability | `can:{edit, move, delete, rsvp, editGuests}`, `lockedReason?`, `syncState`, `isOrganizer`, `htmlLink?` (acceptance 6: no Delete on an unsaved event) | C4 |
| P9 | 2 | Event detail fields | `location?`, `description?` (plain text), `conference?:{url, label?}`, `organizer?`, `attendees[{email, name?, response, self, organizer, optional}]`, `myResponse?`, `transparency`, `status` | C5 |
| P10 | 2 | Calendars list with Aplos-side visibility and colour (Google's list scope is read-only) | `Calendar/get → [{id, accountId, name, colorTag, primary, readOnly, shown, providerHidden}]`; `Calendar/set {id, shown?, colorTag?}` local only | C8 |
| P11 | 2 | `reasonCode` list the copy keys on (open enum, initial list at C1) | one table mapping each ARCH §6.3 class plus OAuth outcomes to a code; UI maps codes to DESIGN §7.15 copy | O13 |
| P12 | 2 | Lease holder's device name ("Background work runs on: MacBook Pro") | lease record gains `deviceName` | S7 |
| P13 | 2 | "Retry now" while paused: `Sync/request` refuses manual runs during a pause | `Sync/request {accountId, force:true}` allowed once per throttle pause | O-unclear 24 |
| P14 | 3 | Invite ↔ email link ("Invite from Priya Raman", O opens it) | `Event.invite?:{threadId, messageId, fromName}` matched by iCalUID | C10 |
| P15 | 3 | Recurrence rule for display and the editor | `recurrence?:{rrule, text}` ("Every Tuesday") | C11 |
| P16 | 3 | Calendar status and settings | calendar sync status on the account; `Settings.calendar.{weekStart?, defaultCalendarId?}` | C13, C14, S19 |

## 3. To the UI-core thread (F9)

| # | Tier | Need | Proposed shape (short) | From |
|---|---|---|---|---|
| U1 | 1 | `CommandRegistry` target for the palette context line | `ctx.target?: {kind:'thread'\|'event'\|'account', id, label}` set by the focused screen | A12 |
| U2 | 1 | Registry fields for the palette and the sheet | `keywords[]`, `group`, `suggested?`, `palette?:false` (movement keys), `confirm?:{title, confirmLabel}`, `children?` for nested pages with breadcrumbs | A13 |
| U3 | 1 | Settings entries in the palette even when Settings is closed, plus deep links | `registerSetting({id, label, section, keywords})` at module load; route `settings/<section>#<row>` | S15 |
| U4 | 1 | Keyboard contexts for our screens | `onboarding`, `firstSync`, `drill`, `sheet`, `ask`, `palette`, `search`, `calendar`, `settings` in the context union (or an open string) | O17 |
| U5 | 1 | Opening `ui-onboard`'s sheets from anywhere (status slot, Settings, Ask) | a sheet host in the shell: `openSheet('reconnect', {accountId, mode:'reconnect'\|'grant'})`, `openSheet('consent')` | S16 |
| U6 | 1 | Keymap utilities | `parseChord`, `formatChord`, `conflicts(keymap)`, `reservedChords` (⌘C, ⌘V, ⌘Q, …) exported with the registry | S17 |
| U7 | 1 | Undo for settings changes, not only engine operations | the undo stack accepts `{label, undo: () => void}` | S18 |
| U8 | 1 | Frame-subscription hook for streaming | `useFrames(kind, filter)` (Ask `progress`, `connect`, `Setup`) | A18 |
| U9 | 1 | `useNow()` clock hook (pairs with E3) | — | S8 |
| U10 | 1 | Component props we depend on | `ProgressSegments {segments[{label, state, value?}], label}`; `Radio`, `Select`, `StepDashes`; `ListRow`/`FocusLetter` accepting a plain row (the drill uses no engine data); `CalendarGrid`, `EventBlock {plan?, stacked?}`, `NowLine`, `MiniMonth {month, marks}`, `CalendarList`; `AskTurn`, `Citation`, `StepLog`, `ProposalCard`, `Palette`, `SearchField`, `OperatorToken`; `SettingRow {label, hint?, control, paletteId}`, `ProviderTable`, `KeyRecorder` | O16, C15, A17 |
| U11 | 2 | `Settings.ui` fields (frozen with the `ui` object) | `theme`, `density`, `keyHints:'tooltip'\|'always'`, `singleKeys:boolean`, `holdMs` (250), `dock:{open, tab, width?}`, `keymap`, `sidebarMinimised`, `swipeDirection`, `devDetails`, `lastAccount`, `palette.recents`, `calendar.weekStart?` | S9, A14, A15, C14 |

## 4. Small questions settled (DECIDED)

Each follows DESIGN, a plan default or the stricter safe reading. Each will also go into STATUS.md as DECIDED.

1. **A capped AI pass is not a clean finish.** Aplos opens by itself only when nothing was paused, failed or capped (DESIGN §7.12 wins over plan 30 U8).
2. **Daily background cap in tokens**, default 150,000 (ARCH D13), not the mockup's request counts.
3. **"Add key" stays.** It writes once to the Keychain-backed vault and the renderer never reads a key back (DESIGN §7.10). The brief's "keys come from the backend environment" is read as "keys are resolved in the backend, never in the screen". An env key wins and shows Remove disabled.
4. **`trainsOnInputs` is strict.** No mail content, background or Ask, goes to a provider marked true (plan 10 E5 item 3; roadmap #25).
5. **Ask honours each account's "Use this account's mail for AI"** and says when an account was left out.
6. **The single-key switch off means single-letter shortcuts are off.** Remapping can still add modifiers (DESIGN §11.4). The mockup's "Off means they need ⌘" is dropped because it collides with ⌘C, ⌘A, ⌘Z and others.
7. **"Delete forever" is not in round 1.** Gmail's permanent delete needs the full `mail.google.com` scope, which this plan does not request. The palette's destructive example becomes "Delete draft" or "Remove account".
8. **⌘Return in Ask depends on context.** While a run streams and follow-ups are queued, it sends the queue now. Otherwise it asks with "search all mail".
9. **Demo controls.** The demo account row has Reset and Remove (DESIGN §7.10). Help has "Load demo mail" only when no demo account exists. "Remove demo mail" has no Undo, so a two-row confirm defaults to Cancel.
10. **One status field name, `resumeAt`.**
11. **Reconnect success is a "Reconnected" toast** (DESIGN §7.1).
12. **Main calls `Setup/end {reason:'closed'}`** when the onboarding window closes, so a red-button close is safe even if the renderer is gone. The renderer also calls it, and both calls are idempotent.
13. **Calendar grid** shows 24 hours, scrolls, and opens at 8 AM. The month label is a small `title`, not a heading (DESIGN §7.8 over the mockup's `<h1>`).
14. **Calendar visibility and colour are Aplos-side.** Google's calendar-list scope is read-only. Colour comes from DESIGN §4.2's stable hash with an override.
15. **Hour format and week start follow the macOS locale.** Settings can override week start.
16. **Round 1 onboarding offers Google only.** The mockup's Microsoft, iCloud and Fastmail rows are round 2 (roadmap §2.2).
17. **No page titles on empty, demo and error screens,** even where a mockup draws one (DESIGN §7).
18. **The paused copy on the first-sync screen** uses DESIGN §7.15's status line ("Google asked us to slow down. Resuming at 2:14 PM.") plus "Your newest mail is ready now; older mail will follow." DESIGN §7.12's sentence is kept as the fallback when no resume time is known.

All other UNCLEAR items in the four maps carry a recommended reading. We apply those readings unless the freeze review says otherwise.

## 5. What happens next

- Day 2 morning: this list goes to the Engine, Providers and UI-core threads as a HANDOFF-READY entry in `plans/STATUS.md`, and to the UI freeze reviewer.
- Days 2-3: we answer the freeze authors' questions, and then check the frozen F1, F6 and F9 against this list. Anything still missing at C1 becomes a CONTRACT-CHANGE-PROPOSED or a REQUEST.
- Days 2-3: the pending test files for each lane are drafted from the maps' test lists. They go into our own folders and merge after restructure step 4.
