# HANDOFF — providers-4: Google Calendar read-sync (DECIDED 2026-11-05)

Orchestrator DECIDED: Google Calendar sync on the real account is round-one scope (no feature cuts). Owner: providers-4, lane `prov-cal/prov-gmail` (prov-cal lane free — its #330 merged 18:44). Deadline: READY within ~a day; owner wants real Gmail use ~Nov 8–9.

## Scope (from orchestrator)

1. Calendar syncer on the Gmail account actor per `packages/engine/src/ports.walk.md` "Google Calendar (round 1)" (lines 33–43): `calendarList` + `events.list` `singleEvents=false` with sync tokens on the `gcal` budget; recurring masters/overrides, all-day, floating/tz, cancelled, deletions; writes the `calendars`/`events` tables the views (#315, merged) already read.
2. Enable calendar scopes in `apps/desktop/src/host/providers/oauth/connect.ts` (`calendar.calendarlist.readonly` + `calendar.events`, already in the manifest as optional with consent strings) + re-consent path for gmail.modify-only grants (Settings → Accounts "Allow calendar access" + onboarding for new accounts). Never silently widen.
3. Tests incl. a recorded-fixture test of real `events.list` shapes.
4. Guarded live run on the spare account (`plans/LIVE-RUNS.md`; read-only except one event on the spare's own calendar allowed; `scripts/live/guard.ts` already has `calendarRunId`).

Review ladder: connect.ts is an auth path → short Opus pass via Integrator 3; rest = 2 SWE-2 passes + Sonnet. Small PRs into `revamp`. `Lane-Approved:` trailers are NOT approvals — use `lane-approved:<lane>` PR labels for cross-lane files. STATUS is append-only (union merge). If the Cloud consent screen (Testing mode) lacks the scopes, tell the orchestrator exactly which scope and where, once.

## Implementation map (verified on revamp)

### A. Port (complete, no changes needed)

`packages/engine/src/ports/calendar.ts` — `CalendarAdapter` (162–194): `budget`, `plan(PlanInput)`, `listCalendars(state, ctx)`, `syncStep(calendarRemoteId, state, lane, ctx)`, `put`, `remove`, `rsvp`. Facts: `CalendarFacts` (81–91), `EventFacts` (93–122: start/end `EventTime`, `masterRemoteId`, `recurrenceId` per `RECURRENCE_ID_FORMAT` 48 — UTC `YYYYMMDDTHHMMSSZ`, all-day `YYYYMMDD`, floating `YYYYMMDDTHHMMSS`; `rrule/rdate/exdate` masters only; `status`; `raw` = provider JSON → `events.data`), `CalendarStepResult` (124–147: `upserts` = full row-set per remoteId, `removals`, `nextState`, `done`, `scopeCovered` for 410-resync sweep, `reset: 'syncTokenInvalid'`, `costUnits`). `ProviderAdapter.calendar?: CalendarAdapter` slot already exists (`ports/provider.ts:803`); `ScopeId` includes `'calendars'` + `` `cal:${string}` `` (196–206). Writes (put/remove/rsvp) are out of round-1 scope → implement as explicit `notImplemented`/`unavailable` ProviderError (RSVP is out of the hand-check).

### B. Adapter + actor gaps (the bulk of the work)

- `apps/desktop/src/host/providers/google/adapter.ts`: `GmailAdapter` declares NO `calendar` (comment 50–53); `createGoogleProvider().budgets()` returns `[GMAIL_BUDGET]` only (330–332) — must add `GCAL_BUDGET`; `syncStep` (238–255) throws `NotInThisLaneError` on unknown scopes — route `calendars`→`listCalendars`, `cal:*`→`calendar.syncStep` (like `workflow` scope at `sync/actor.ts:404-407`), OR keep gmail-only and let the actor call `adapter.calendar` directly — pick whichever the actor dispatch prefers.
- `packages/engine/src/sync/budgets.ts:53-70` — `gcalBudget` EXISTS (id `gcal`, 600/min, inFlight 2) in `defaultBudgets` (89). `sync/host.ts:339-341` already calls `factory.budgets()` + `governor.setBudgets`.
- `packages/engine/src/sync/actor.ts` — `runStep` (393–459) commits via `stepWrites` (`sync/facts.ts:381`) which only translates MAIL facts. Needs: calendar branch — `calendars` scope → `adapter.calendar.listCalendars` → `calendar`/`calendarDelete` writes; `cal:<id>` → `adapter.calendar.syncStep` → `event`/`eventDelete`/`eventSweep`/`syncState`/`providerMemory` writes (`syncStateWrite` at facts.ts:314 reusable); `reset`/`scopeCovered`/410 semantics per port doc; populate `AccountRuntime.calendars[]` (`ports/engine.ts:93-100`, currently nothing writes it; `runtime` init at actor.ts:141-149) and `runtime.missingPermissions` (read at `account-read.ts:229-236`, no producer today — per `ports/governor.ts:107` a `permission` class on a non-core scope records missingPermissions, NOT needsPermission).
- New provider files: `google/calendar.ts` (CalendarAdapter impl: pure `plan` — cadence primary 2–5 min / others 15–30 / list 30 min jittered per ports.walk.md:37; `listCalendars` → `calendarList.calendarList.list`; `syncStep` → `events.list` `singleEvents=false`, `showDeleted`, syncToken in `SyncState.cursor`, 410 → `reset:'syncTokenInvalid'` resync with `scopeCovered`; facts mapping incl. recurrenceId canonicalization, `raw` = full event JSON), `google/gcal-client.ts` (mirror `client.ts:134-205` with base `https://www.googleapis.com/calendar/v3`, `budget:'gcal'`, `kind:'read'`, fields mask policy), gcal entries in `costs.ts` (throws on unknown method — new `GCAL_COSTS` table required; unit = requests, ~`base:1` each).
- `classify.ts` already maps `gcal.*` methods → `'gcal'` budget (148–152), `quotaExceeded` → `anti_abuse` (312–315), `insufficientPermissions`/`WWW-Authenticate` → `permission` + `missingScopes` (341–354).
- Schema/writes (`store/port.ts:589-674`, `store/calendar.ts`): `CalendarWrite`, `CalendarDeleteWrite`, `EventWrite{calendarRemoteId, remoteId, rows: EventRow[], seenGen?}` (one resource's full row set; stored rows not in `rows` deleted — matches `upserts` semantics), `EventDeleteWrite`, `EventSweepWrite{calendarRemoteId, generation, from?, to?}`, `EventHiddenWrite`. `events.recurrence_id` DEFAULT '' (masters/singles = ''); views JOIN events×calendars + event_hidden (`calendar/views.ts:34-43`).

### C. OAuth/scope enablement (small; Opus on connect.ts)

- `connect.ts:104`: `calendar: false` → `features.has('calendarList') && features.has('calendarEvents')` (both needed for sync; update the 94–95 comment).
- `host/compose.ts:192-214`: `createGoogleHostConnect` currently passes NEITHER `optionalScopes` NOR `grantedScopes` — new connects ask gmail.modify only AND a plain reconnect silently drops held optional scopes (`scopesFor` connect.ts:147-154 keeps held scopes only via `deps.grantedScopes`). Wire `grantedScopes: id => <account row's granted_scopes from store>` (fix real bug) and decide `optionalScopes` for `new` (the "onboarding path for new accounts": consent strings must be shown — find where `ScopeEntry.consent` is rendered in onboarding before deciding; simplest compliant option is including calendar scopes for new connects since the consent copy exists, but check what the reconnect/settings UI shows).
- `grantPermissions` mode already asks ALL optional scopes (connect.ts:152) — `Account/grantPermissions` → `methods/account.ts:186` → `sync/account-connect.ts:181-212` → host connect → `reconnected()` stores grantedScopes+capabilities, `governor.clear(account,'auth')` (sync/host.ts:458-497).
- Re-consent UI ALREADY EXISTS: `renderer/screens/settings/sections/calendar.tsx:22-25,74-93` renders "Aplos needs permission to use your Google Calendar" → `actions.startReconnect(a.id,'grant')` → SheetHost → `onboarding/reconnect` → `api.account.grantPermissions`; `settings.model.ts:248-255,340` offers `mode:'grant'` on `needsPermission`. Gate it on the account missing calendar features (check what drives that row today — likely `missingPermissions` or capability; reasonCode may need `missingCalendarScope` per ports doc vs `'permission.calendar'` in preview fixtures).
- `missingPermissions` producer needed (see B): when `grantedFeatures` lacks calendar features (or on `permission` refusal with calendar missingScopes), record `runtime.missingPermissions` so the Settings row shows; never `needsPermission` (that's core-mail-scope only per governor.ts:107).

### D. Tests

- `@aplos/emulators` has a FULL gcal emulator: `packages/emulators/src/gcal/` (`hub.ts` `CalendarHub`, `routes.ts`, `lists.ts` — real `events.list` semantics: syncToken incl. 410 via `expireSyncTokens`, `singleEvents`, `showDeleted`, `orderBy`, timeMin/Max, paging+`nextSyncToken`). Served by `createGmailEmulator` on the same `emu.fetch` (path prefix `/calendar/v3/`, `service:'gcal'`, scope-checked via `CAL_SCOPES_FOR` — so scope-refusal tests work).
- Harness: `apps/desktop/tests/prov-gmail/harness.ts` (`rig()`, `StubGovernor`, `TokenStub`, `RigStore`, `drive()` runs plan→syncStep→commit; 497–499 already special-cases `workflow` scope — same dispatch point cal scopes need). Suggest new `apps/desktop/tests/prov-cal/` dir or `prov-gmail/calendar*.test.ts`.
- No recorded-API-JSON fixture replay exists; recurrence oracle corpus is at `packages/engine/tests/fixtures/calendar/*.json` (different purpose). For "recorded-fixture test of real events.list shapes": record real `events.list` responses (from the guarded live run or hand-written realistic JSON per Google API docs), place under a new `tests/fixtures/` dir, feed through the emulator/facts-mapping path.
- Engine-side: sync writes can be tested via `packages/engine/tests/` with the actor dispatch + RigStore-style store.

### E. Suggested PR split (small PRs into revamp)

1. **PR-A (scopes + re-consent)**: connect.ts capability flip, compose.ts `grantedScopes`+`optionalScopes` wiring, missingPermissions producer, Settings/Accounts row gate + tests. Auth path → Opus on connect.ts.
2. **PR-B (syncer)**: gcal client + costs + `google/calendar.ts` adapter half + adapter.ts wiring + `budgets()` + actor calendar dispatch + facts translation + runtime.calendars + store writes + emulator tests.
3. **PR-C**: recorded-fixture events.list tests + any fixes; then the guarded live run on the spare (needs `scripts/live/guard.ts` calendar tier; read `plans/LIVE-RUNS.md` first — owner authorization flow may be required; spare grant expires Nov 10).

### F. Gotchas

- `scopesFor` bug today: reconnect without `deps.grantedScopes` drops held optional scopes — wiring it in compose fixes re-consent correctness; verify with a test.
- Calendar sync on a gmail.modify-only grant must fail CLOSED-but-honest: first gcal call → 403 `insufficientPermissions` → `permission` class → `missingPermissions` (not needsPermission, not a crash); the Settings grant row is the path out. Also consider: if `grantedFeatures` lacks calendar features, the adapter `plan()` should emit NO cal steps at all (cleaner: capability absent → plan skips calendars; emulator `CAL_SCOPES_FOR` still covers the refusal test).
- `calendar: true` in Capabilities must require BOTH scopes (list + events) — a grant with only `calendarlist.readonly` is not usable.
- Actor commit: `CalendarStepResult` ≠ mail `StepResult` — needs its own translate+commit path (facts.ts or new `sync/calendar-facts.ts`); keep `sync/host.ts` under the 800-line lint limit (host-read.ts precedent exists).
- `EventWrite.rows` per-remoteId full row set: group adapter `upserts` by `remoteId` (master + its overrides share... NO — Google overrides have their OWN event remoteId `<recurringEventId>_<recurrenceId>`? Recheck: port doc says Google override's `remoteId` is its event id and `masterRemoteId` is `recurringEventId`; Google returns overrides as separate items in events.list. So upserts→EventWrite is 1:1 per remoteId; `removals`→EventDeleteWrite by remoteId).
- Don't copy legacy `main/google.ts` calendar code — shape reference only.
- prov-cal's views (#315/#330) already read NULL start_utc safely and expect `recurrence_id=''` for non-overrides.

## State at handoff

- `rv/prov-gmail/cal-sync` branch created off origin/revamp, clean, no commits yet.
- Open PRs waiting on integrator: #325 (search-throttle tests, 28c1bd97, CI 3/3, 2 SWE-2 MERGE), #339 + #341 (STATUS-only lines).
- Stash `stash@{0}` = `lowspr-leftover` (pre-existing engine WIP, not mine — leave it).
- Git identity must be `Kainoa Newton <k@kainoa.me>`. `npm run check` before every commit. No live Google calls without `plans/LIVE-RUNS.md` guarded runner.
