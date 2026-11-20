# Provider leaks: where the shared code assumes Gmail

Job 1, Part A (`plans/next/01-provider-test-bar.md`). This is an inventory only: no code changed. Each fix is a proposal for a later job.

## How this was made

- **Searched:** `packages/engine/src` (without `legacy/`), `packages/contract/src` (without `legacy/`) and `apps/desktop/src/renderer` (without `legacy/`, tests, specs, `preview/` and fixtures). The engine has no provider folder; the Google adapter lives in `apps/desktop/src/host/providers/google/`, outside the search.
- **Pattern:** `grep -rniE "gmail|google|\bINBOX\b|CATEGORY_"` on `.ts`/`.tsx`, then a read of each hit and of the code around the real ones. Gmail-shaped code without those words (labels versus folders, `category.*` roles, Gmail search syntax, scope URLs) is listed under the file where the search found it.
- **One row per file:** every hit line is listed, and the row's sentence covers them. Files whose hits are only comments, icon names or the Inbox role say so.
- **Classes:** `fine` (an enumeration, a comment, a role every provider has, or Google-only by design), `behind a capability` (a `Capabilities` flag or an absent role already turns it off), `leak` (another provider would get Gmail behaviour or Gmail copy).

Totals: 114 fine, 8 behind a capability, 37 leak files.

## The leaks, shortest list

1. **Connect is Google-only in the engine:** `sync/account-connect.ts`, `sync/account-discover.ts`, `sync/scopes.ts`. Fix: look the factory up by kind; each factory owns its domains and required scope.
2. **Google scope URLs outside the adapter:** `sync/actor.ts`, `calendar/write-port.ts`, `calendar/write-scope.ts`, renderer `screens/calendar/accountCalendarState.ts`. Fix: the adapter reports missing permissions; the engine and renderer read that fact.
3. **Gmail search syntax in the engine:** `views/remote-text.ts`. Fix: send the structured query; each adapter renders it.
4. **Literal `gmail` provider ids:** `outbox/runner.ts` (send-limit error), `sync/actor.ts` `family()` fallback, contract `log/events.ts` owners. Fix: use the account's own family.
5. **Add-account UI offers only Google:** `onboarding/connect.ts`, `onboarding/steps/Accounts.tsx`, `shell/AddAccountHost.tsx`, `shell/add-account-controller.ts`. Fix: choices from `Session` kinds.
6. **Copy that says Google or Gmail for generic states:** engine calendar errors and many renderer files. Fix: one `providerName(kind)` helper and templated copy.
7. **Provider names typed as Google/Microsoft only:** `ui/props/status.ts`, `ui/status/ReconnectSheet.tsx`, `settings.model.ts` `providerLabel`. Fix: use `ProviderKind` and name every kind.

## Engine (`packages/engine/src`)

| File | Lines | Assumption | Class | Smallest fix |
|---|---|---|---|---|
| `packages/engine/src/ai/demo/data.ts` | 49, 335, 401, 405, 407 | Demo data models placements as Gmail labels (`INBOX`); only the demo account uses it. | fine | — |
| `packages/engine/src/ai/impl/ask-recency.ts` | 20 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/ai/impl/ask.ts` | 570 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/ai/impl/backfill.ts` | 18 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/ai/impl/execute.ts` | 116 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/ai/impl/jobs.ts` | 14, 124, 154, 160 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/ai/impl/plans.ts` | 265 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/ai/lanes.ts` | 13, 89, 226, 227 | Gmail tabs (`category.*` roles) and the `important` role feed lane choice; on other providers the roles are absent and the rule falls back to headers (`importance` flag). | behind a capability | — |
| `packages/engine/src/calendar/event-id.ts` | 5 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/calendar/holds.ts` | 194, 324, 334, 436, 456, 493, 508, 541, 549 | User-facing hold messages say "Google Calendar"; the logic is neutral. | leak | Same `providerName(kind)` template. |
| `packages/engine/src/calendar/project.ts` | 27, 43, 93, 94, 140, 266 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/calendar/recurrence/index.ts` | 23 | Re-exports `googleInstanceId`. | fine | — |
| `packages/engine/src/calendar/recurrence/keys.ts` | 3, 12, 31, 32, 33, 35, 38 | `googleInstanceId` helper for Google’s instance-id form; not called from engine code outside tests. | fine | — |
| `packages/engine/src/calendar/recurrence/series.ts` | 57, 116 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/calendar/recurrence/time.ts` | 41, 85 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/calendar/recurrence/types.ts` | 12 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/calendar/write-errors.ts` | 18, 25, 31, 44, 50, 55 | User-facing write errors say "Google" / "Google Calendar" for every account. | leak | Template the provider’s display name from the account (one `providerName(kind)` helper). |
| `packages/engine/src/calendar/write-port.ts` | 20, 28, 58, 86, 87, 88, 95, 144 | Write permission is checked only for `provider === 'google'` against a Google scope URL. | leak | Ask the calendar half (or `Capabilities`) whether writes are allowed and drop the provider branch. |
| `packages/engine/src/calendar/write-scope.ts` | 1, 3, 4, 13, 14 | Google calendar scope URLs live in the engine and are read by the actor’s gate. | leak | Move them into the Google adapter; see `sync/actor.ts`. |
| `packages/engine/src/diag/redact.ts` | 123 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/methods/account.ts` | 60, 61, 62 | Password-change refusal says "Aplos can add Gmail accounts for now" to any non-Google account. | leak | Word it per kind, or say the account kind has no password here. |
| `packages/engine/src/methods/event.ts` | 181, 319, 513 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/methods/session.ts` | 12, 14 | Lists the account kinds and which are available; Google is the only available one. | fine | — |
| `packages/engine/src/methods/unsubscribe.ts` | 12, 15, 137 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/methods/workflow.ts` | 7, 8 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/outbox/draft-proof.ts` | 26 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/outbox/draft-sync.ts` | 192 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/outbox/draft-writes.ts` | 690, 699, 706 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/outbox/killpoints.ts` | 74 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/outbox/notifications.ts` | 16, 85, 162, 170, 257, 363, 364, 369, 370 | Banners and badge use the `inbox` folder role, which every provider has. | fine | — |
| `packages/engine/src/outbox/runner.ts` | 410 | A send-limit failure is recorded with `provider: 'gmail'` whatever the account is. | leak | Use the account’s budget family (the same value `actor.family()` computes) instead of the literal. |
| `packages/engine/src/ports/base.ts` | 9, 29, 31, 41 | Enumerations of provider kinds and budget ids, Gmail among them. | fine | — |
| `packages/engine/src/ports/calendar.ts` | 5, 41, 43, 45, 51, 67, 110, 116, 121, 162, 170, 199 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/ports/content.ts` | 175 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/ports/engine.ts` | 63, 131, 153, 250, 281 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/ports/governor.ts` | 7, 13, 15, 17, 19, 23, 28, 35, 44, 68, 99, 103, … (13 hits) | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/ports/provider.ts` | 61, 75, 77, 99, 100, 113, 120, 148, 153, 186, 198, 199, … (43 hits) | Port types: `window:inbox`/`backfill:inbox` scopes are role-based; `preset` lists `gmail` with other presets; comments use Gmail as an example. | fine | — |
| `packages/engine/src/store/calendar.ts` | 142 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/store/migrations/0001_initial.ts` | 9, 23, 30, 53, 80, 96, 109, 132 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/store/port.ts` | 210, 212, 269, 318, 327, 533 | `category.*` roles are Gmail tabs, read only by `laneFor`; placement and flag deltas name Gmail as one example among IMAP/JMAP/Graph. | behind a capability | — |
| `packages/engine/src/sync/account-connect.ts` | 10, 13, 15, 16, 26, 28, 29, 32, 41, 64, 78, 86, … (19 hits) | Connect and reconnect refuse any provider but `google`, and build the account row with `kind`/`provider` `google` and preset `gmail` hard-coded. | leak | Take the kind from the request (or the stored row) and look the `ProviderFactory` up by kind; keep the "not yet" message as the factory-missing case. |
| `packages/engine/src/sync/account-discover.ts` | 5, 8, 9, 13, 18 | Offline discovery knows only `gmail.com`/`googlemail.com` and answers Gmail-only copy for everything else. | leak | Let each factory contribute its own domain list (`ProviderFactory.domains`), and word the miss without naming Gmail. |
| `packages/engine/src/sync/actor.ts` | 34, 51, 56, 57, 58, 364, 857, 896, 974, 978 | The calendar half checks Google calendar scope URLs (`GOOGLE_CALENDAR_SCOPES`, `GOOGLE_CALENDAR_WRITE_SCOPE`) and `family()` falls back to `gmail` for any unknown provider. | leak | Have the factory (or `Capabilities`) report the scopes it needs and its budget family; the actor compares against those. |
| `packages/engine/src/sync/budgets.ts` | 27, 32, 33, 52, 75, 89 | Gmail, Google Calendar and OAuth budget numbers; used only as defaults when the host passes no budgets. | fine | — |
| `packages/engine/src/sync/calendar-facts.ts` | 69 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/sync/facts.ts` | 299 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/sync/governor-math.ts` | 12 | Comment citing Gmail’s regrow rate as the example. | fine | — |
| `packages/engine/src/sync/governor-meter.ts` | 24, 27 | Comments naming Google Calendar `quotaExceeded` and Google send limits as examples of generic error classes. | fine | — |
| `packages/engine/src/sync/governor.ts` | 803 | Comment: Gmail’s project-wide daily limit blocks every account; the code acts on the generic `scope: project`. | fine | — |
| `packages/engine/src/sync/host-read.ts` | 27, 41 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/sync/host.ts` | 68, 294 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/sync/lease.ts` | 49, 71, 72, 77 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/sync/pacific.ts` | 21, 22 | Pacific-midnight helper for daily quota resets; the caller picks it, it assumes nothing about the account. | fine | — |
| `packages/engine/src/sync/scopes.ts` | 4, 5, 8, 11 | Every connect result is checked for the Gmail `gmail.modify` scope URL, so another provider can never pass. | leak | Move the required-scope check into the Google factory (it refuses its own connect), or have `ConnectResult` say `missingRequired`. |
| `packages/engine/src/sync/status.ts` | 18 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/views/act.ts` | 27, 49, 60, 65, 163, 165, 166, 168, 169, 185, 187, 203, … (14 hits) | Labels versus folders: moves keep other labels only when `labels` is true, and fall back to the Archive role for folder accounts. | behind a capability | — |
| `packages/engine/src/views/counts.ts` | 19, 23, 24, 28 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/views/folder-fetch.ts` | 13, 49, 52 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/views/lists.ts` | 89, 102, 105 | Archive is the Archive folder where one exists, else "outside Inbox" (the label model). | behind a capability | — |
| `packages/engine/src/views/registry.ts` | 119, 122, 133 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/views/remote-text.ts` | 4 | Server search is sent as a Gmail search string (`is:starred`, `has:attachment`, `after:YYYY/MM/DD`). | leak | Pass the structured `SearchQuery` to `ServerSearch` and let each adapter render its own syntax; the Google adapter keeps this function. |
| `packages/engine/src/views/remote.ts` | 26, 249 | Comments: Gmail rate limits as the reason for batching; code is provider-neutral. | fine | — |
| `packages/engine/src/views/search.ts` | 24, 27, 84 | Searches by mailbox role; Starred is read as a flag, which is true of IMAP/JMAP too. | fine | — |
| `packages/engine/src/views/sections.ts` | 36 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/views/sender-ops.ts` | 106, 109, 186 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `packages/engine/src/views/senders.ts` | 6, 10 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |

## Contract (`packages/contract/src`)

| File | Lines | Assumption | Class | Smallest fix |
|---|---|---|---|---|
| `packages/contract/src/api/account.ts` | 35, 43, 67, 71, 86 | Provider and preset enumerations; descriptions note round 1 connects Google only. | fine | — |
| `packages/contract/src/api/admin.ts` | 177 | "skip-Inbox rules" names an Aplos feature, not a label id. | fine | — |
| `packages/contract/src/errors.ts` | 6, 25, 27, 31, 39, 54, 62 | Enumerations of providers and budgets (Gmail among them); comment examples. | fine | — |
| `packages/contract/src/log/events.ts` | 93, 94, 140, 143, 199, 205, 250, 275, 282, 288, 298 | Generic send and draft events (`send.sent`, `send.failed`, `draft.sync_failed`, `auth.reconnect_needed`) list only the `prov-gmail*` lanes as owners. | leak | Add the other providers’ lanes when they land, or name a neutral provider owner for these events. |
| `packages/contract/src/schemas/account.ts` | 6, 7, 9, 20, 23, 26, 31, 37, 41, 108, 110, 132 | The `Capabilities` schema itself, with Gmail as the example of each flag; `inbox` is a role. | behind a capability | — |
| `packages/contract/src/schemas/calendar.ts` | 94 | Comment on Google’s read-only calendar list scope. | fine | — |
| `packages/contract/src/schemas/mail.ts` | 163, 213, 336, 339, 452 | Mailbox roles include `important`/`starred`, which exist only where `importance` or flags allow. | behind a capability | — |
| `packages/contract/src/schemas/session.ts` | 68, 126 | Rules are mirrored to provider filters where `filters` is true. | behind a capability | — |
| `packages/contract/src/schemas/settings.ts` | 96, 119 | Weekly-reconnect notice and "events from Gmail" settings only apply to Google accounts; descriptions name Google. | behind a capability | — |
| `packages/contract/src/status.ts` | 91 | Comments only. | fine | — |

## Renderer (`apps/desktop/src/renderer`)

| File | Lines | Assumption | Class | Smallest fix |
|---|---|---|---|---|
| `apps/desktop/src/renderer/App.tsx` | 124, 214, 249, 257 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/commands/catalog/global.ts` | 129 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/commands/catalog/search.ts` | 8, 12 | Command "Search all mail on Google". | leak | Same as `search.model.ts`. |
| `apps/desktop/src/renderer/commands/resolver.table.ts` | 621, 623 | Test-table entry name repeating the command label. | fine | — |
| `apps/desktop/src/renderer/data/bodies.ts` | 52, 111 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/data/contract-shapes.ts` | 139 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/data/data-api.ts` | 125 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/data/index.ts` | 407, 584, 610, 693 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/data/layer.ts` | 706 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/data/optimistic.ts` | 117, 147 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/data/windows.ts` | 72, 132 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/onboarding/OnboardingApp.tsx` | 450 | Adding an account offers only a "Continue with Google" choice and always connects `provider: 'google'`. | leak | Build the choices from `Session` kinds (`methods/session.ts`) and pass the chosen kind to connect. |
| `apps/desktop/src/renderer/onboarding/connect.ts` | 2, 25, 27, 68, 160, 283, 301, 361, 381 | Adding an account offers only a "Continue with Google" choice and always connects `provider: 'google'`. | leak | Build the choices from `Session` kinds (`methods/session.ts`) and pass the chosen kind to connect. |
| `apps/desktop/src/renderer/onboarding/copy.ts` | 7, 14, 24, 25, 26, 27, 28, 29, 30, 31, 35, 37, … (22 hits) | User-facing text names Google or Gmail for a generic state (rate limit, sign-in, quota, server down, search, rebuild). | leak | One `providerName(account)` helper; template the copy with it. |
| `apps/desktop/src/renderer/onboarding/demo.ts` | 150 | User-facing text names Google or Gmail for a generic state (rate limit, sign-in, quota, server down, search, rebuild). | leak | One `providerName(account)` helper; template the copy with it. |
| `apps/desktop/src/renderer/onboarding/firstSync/model.ts` | 6, 64, 175, 256, 269, 287, 293 | User-facing text names Google or Gmail for a generic state (rate limit, sign-in, quota, server down, search, rebuild). | leak | One `providerName(account)` helper; template the copy with it. |
| `apps/desktop/src/renderer/onboarding/firstSync/states.tsx` | 132, 229, 267, 353 | Preview states and fixtures for the design gallery; fake `example.com` Google accounts. | fine | — |
| `apps/desktop/src/renderer/onboarding/reconnect/ReconnectFlow.tsx` | 7, 11 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/onboarding/reconnect/reconnect.model.ts` | 18, 23, 96, 252 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/onboarding/reconnect/states.tsx` | 110, 153, 162, 166, 190, 194 | Preview states and fixtures for the design gallery; fake `example.com` Google accounts. | fine | — |
| `apps/desktop/src/renderer/onboarding/steps/Accounts.tsx` | 3, 25, 38, 59, 60, 74, 87, 93, 95, 181, 184, 190, … (23 hits) | Adding an account offers only a "Continue with Google" choice and always connects `provider: 'google'`. | leak | Build the choices from `Session` kinds (`methods/session.ts`) and pass the chosen kind to connect. |
| `apps/desktop/src/renderer/onboarding/steps/states.tsx` | 68, 295, 298, 311 | Preview states and fixtures for the design gallery; fake `example.com` Google accounts. | fine | — |
| `apps/desktop/src/renderer/screens/calendar/CalendarAccounts.tsx` | 35 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/screens/calendar/CalendarStates.tsx` | 85, 86, 90, 119, 121, 125, 129, 132, 135, 666, 681, 824 | Preview states and fixtures for the design gallery; fake `example.com` Google accounts. | fine | — |
| `apps/desktop/src/renderer/screens/calendar/FailedHolds.tsx` | 58, 386 | User-facing text names Google or Gmail for a generic state (rate limit, sign-in, quota, server down, search, rebuild). | leak | One `providerName(account)` helper; template the copy with it. |
| `apps/desktop/src/renderer/screens/calendar/accountCalendarState.ts` | 5, 43, 48, 105, 116, 151, 154, 177, 185, 189, 191, 211, … (14 hits) | Calendar state only for `provider === 'google'`, judged against Google calendar scope URLs held in the renderer. | leak | Use `capabilities.calendar` and a missing-permission fact from the engine instead of scope URLs. |
| `apps/desktop/src/renderer/screens/calendar/effects.ts` | 196 | User-facing text names Google or Gmail for a generic state (rate limit, sign-in, quota, server down, search, rebuild). | leak | One `providerName(account)` helper; template the copy with it. |
| `apps/desktop/src/renderer/screens/calendar/holdEffects.ts` | 44, 85 | Matches the engine’s "on its way to Google" message text to recognise a state. | leak | Match an error code instead of message text. |
| `apps/desktop/src/renderer/screens/calendar/model/editor.ts` | 226 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/screens/calendar/model/entries.ts` | 166 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/screens/calendar/model/rsvp.ts` | 9, 75 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/screens/calendar/model/times.ts` | 52 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/screens/calendar/sidebar.ts` | 71 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/screens/calendar/writeErrors.ts` | 79, 82, 108, 111, 189, 194, 206, 210 | User-facing text names Google or Gmail for a generic state (rate limit, sign-in, quota, server down, search, rebuild). | leak | One `providerName(account)` helper; template the copy with it. |
| `apps/desktop/src/renderer/screens/compose/model/forwardSeed.ts` | 23 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/screens/compose/model/replySeed.ts` | 57 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/screens/compose/runtime/sendNotices.ts` | 65 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/screens/home/HomeScreen.tsx` | 162 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/screens/home/HomeStates.tsx` | 2, 3 | Preview states and fixtures for the design gallery; fake `example.com` Google accounts. | fine | — |
| `apps/desktop/src/renderer/screens/home/OneByOneStates.tsx` | 2 | Preview states and fixtures for the design gallery; fake `example.com` Google accounts. | fine | — |
| `apps/desktop/src/renderer/screens/lists/ListStates.tsx` | 56 | User-facing text names Google or Gmail for a generic state (rate limit, sign-in, quota, server down, search, rebuild). | leak | One `providerName(account)` helper; template the copy with it. |
| `apps/desktop/src/renderer/screens/lists/useBulkBar.ts` | 16 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/screens/reader/ReaderLetter.tsx` | 341 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/screens/reader/readerActions.ts` | 73, 76 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/screens/reader/readerRows.ts` | 157 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/screens/search/SearchPage.tsx` | 3, 4, 17, 32, 90, 114, 150, 188 | Labels "From Google" and the Google search offer. | leak | Same as `search.model.ts`. |
| `apps/desktop/src/renderer/screens/search/SearchScreen.tsx` | 208 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/screens/search/parse.ts` | 10, 66 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/screens/search/search.model.ts` | 4, 6, 25, 45, 136, 250, 262, 285, 288, 290, 292, 310, … (29 hits) | The server-search offer and its results say "on Google" ("Search all mail on Google", "From Google"). | leak | Gate on `serverSearch` (already) and template the name with `providerName`. |
| `apps/desktop/src/renderer/screens/settings/availability.ts` | 53 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/screens/settings/paletteEntries.ts` | 72, 73, 83, 102, 109, 110, 119 | Search keywords for Settings rows (`google`, `gmail`). | fine | — |
| `apps/desktop/src/renderer/screens/settings/sections/calendar.tsx` | 41, 127, 171, 172, 175 | "Events from Gmail" shows whenever a calendar exists; nothing hides it for providers that add no events from mail. | leak | Gate the row on a capability the provider reports (a new `eventsFromMail` flag, or the calendar half saying so), and template the name. |
| `apps/desktop/src/renderer/screens/settings/sections/notifications.tsx` | 50, 53 | "Remind me before Gmail asks to reconnect" shows for every account; nothing hides it when no account has a weekly reconnect. | leak | Show the row only when an account reports a reconnect date (`reconnectBy`), and name its provider with `providerName`. |
| `apps/desktop/src/renderer/screens/settings/settings.model.ts` | 237, 239, 302, 329, 331, 332, 333, 499 | `providerLabel` names only Google and Demo (others get an empty label); permission copy names Gmail/Google. | leak | A label for every `ProviderKind`, and copy through `providerName`. |
| `apps/desktop/src/renderer/screens/settings/settings.queue.model.ts` | 8, 9, 10, 11, 14 | User-facing text names Google or Gmail for a generic state (rate limit, sign-in, quota, server down, search, rebuild). | leak | One `providerName(account)` helper; template the copy with it. |
| `apps/desktop/src/renderer/shell/AddAccountHost.tsx` | 3, 33, 52, 54, 55, 73, 77, 111, 172 | Adding an account offers only a "Continue with Google" choice and always connects `provider: 'google'`. | leak | Build the choices from `Session` kinds (`methods/session.ts`) and pass the chosen kind to connect. |
| `apps/desktop/src/renderer/shell/add-account-controller.ts` | 38, 63, 64, 122 | Adding an account offers only a "Continue with Google" choice and always connects `provider: 'google'`. | leak | Build the choices from `Session` kinds (`methods/session.ts`) and pass the chosen kind to connect. |
| `apps/desktop/src/renderer/shell/index.ts` | 103 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/shell/states.tsx` | 43 | Preview states and fixtures for the design gallery; fake `example.com` Google accounts. | fine | — |
| `apps/desktop/src/renderer/ui/ask/SearchField.tsx` | 36 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/ui/buttons-keys/Icon.tsx` | 44, 98 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/compose/icons.tsx` | 41, 92 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/list/EmptyLine.tsx` | 11 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/list/ListBox.tsx` | 1 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/list/ListGroup.tsx` | 1 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/list/ListRow.tsx` | 1 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/list/LowBand.tsx` | 31 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/list/SectionHeader.tsx` | 1 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/list/internal/Icon.tsx` | 40, 89 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/onboarding/ChoiceRow.tsx` | 30, 71 | Comments or docs that use Gmail/Google as an example; no runtime assumption. | fine | — |
| `apps/desktop/src/renderer/ui/onboarding/icons.tsx` | 41, 90 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/props/ask.ts` | 281, 291 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/props/calendar.ts` | 128 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/props/controls.ts` | 22 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/props/list.ts` | 38, 100, 112, 120, 352, 360 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/props/onboarding.ts` | 33, 43, 53, 59, 67 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/props/settings.ts` | 20 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/props/status.ts` | 27, 39, 47, 51, 59, 109, 115, 116, 125, 226, 247, 283 | Status `provider` is typed `'google' | 'microsoft'`. | leak | Use the contract `ProviderKind`. |
| `apps/desktop/src/renderer/ui/props/surfaces.ts` | 30, 145, 193 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
| `apps/desktop/src/renderer/ui/status/FatalScreen.tsx` | 9, 22, 29, 40, 41, 68, 95, 118 | User-facing text names Google or Gmail for a generic state (rate limit, sign-in, quota, server down, search, rebuild). | leak | One `providerName(account)` helper; template the copy with it. |
| `apps/desktop/src/renderer/ui/status/ReconnectSheet.tsx` | 2, 3, 8, 9, 18, 19, 24 | Provider names exist for Google and Microsoft only, and the default is `google`. | leak | Name every `ProviderKind` and make `provider` required. |
| `apps/desktop/src/renderer/ui/status/StatusSlot.tsx` | 52, 55, 61, 76, 88, 89, 96, 103, 116 | User-facing text names Google or Gmail for a generic state (rate limit, sign-in, quota, server down, search, rebuild). | leak | One `providerName(account)` helper; template the copy with it. |
| `apps/desktop/src/renderer/ui/surfaces/parts.tsx` | 43, 109 | Inbox as a mailbox role, an icon name or "inbox zero" wording; not a Gmail label id. | fine | — |
