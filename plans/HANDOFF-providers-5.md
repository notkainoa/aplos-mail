# HANDOFF — providers-5 (calendar sync, lean)

Thread: Revamp: Providers 5 calendar sync (lean). Worktree: `rv-thread-providers-5`. Goal: real Google
Calendar sync on the owner's Gmail account (round-one scope, no cuts). Providers-4's handoff is on
`origin/rv/prov-gmail/cal-sync` (fetched to `/tmp/handoff-p4.md` in-thread; re-fetch if needed).

## Where it stands

**PR-A — scopes + re-consent: OPEN as https://github.com/notkainoa/aplos-mail/pull/345** (branch
`rv/prov-gov/calendar-scopes`, head e78a3b56, base revamp). Done and test-green:

- `connect.ts`: `Capabilities.calendar` = calendarList **and** calendarEvents; `optionalScopes` may
  return `undefined` to keep the mode default.
- `scopes.ts`: `scopesForFeatures()`.
- `compose.ts`: `grantedScopes` wired from `accounts.granted_scopes` (fixes silent optional-scope drop
  on reconnect); `optionalScopes` answers the two calendar scopes for `mode:'new'` only (onboarding
  copy already says "mail and calendar"). Plain reconnect never widens.
- `sync/actor.ts` + `sync/host.ts`: `runtime.missingPermissions` producer (`permission.calendar`,
  never `needsPermission`); `reconnected` now accepts `capabilities` and refreshes the row. Settings
  → Calendar already renders the row + Reconnect(grant) — no UI change.
- Tests: 7 new in `tests/prov-gov/oauth-flow.test.ts` (34/34 green) + new
  `packages/engine/tests/sync-missing-permissions.test.ts` (3/3 green).

**PR-B — the syncer: OPEN as https://github.com/notkainoa/aplos-mail/pull/346** (branch
`rv/prov-cal/calendar-sync`, head 6c19e866, **stacked on PR-A** so its diff is clean; GitHub retargets
base to revamp when PR-A merges). Done and test-green:

- `google/gcal-client.ts` + `GCAL_COSTS` (costs.ts): gcal-budget request layer, fields-masked reads.
- `google/calendar.ts`: `CalendarAdapter` — capability-gated `plan` (list 30 min; primary 2–5 min,
  others 15–30 min, id-jittered; first sync backfill), `listCalendars`, `syncStep` paged
  `events.list singleEvents=false showDeleted`, **inline 410 resync** (drops the dead token — bug
  found and fixed in-thread — emits `reset:'syncTokenInvalid'` + `scopeCovered` for the generation
  sweep). Canonical `recurrenceId` (UTC/all-day/floating), `masterRemoteId`, `raw` JSON.
  `put`/`remove`/`rsvp` → `NotImplementedError`.
- `adapter.ts`: `calendar` slot always constructed (missingPermissions can tell missing grant from
  no provider); `GCAL_BUDGET` (600/min, mirrors engine `gcalBudget`); `plan` merges calendar steps.
- `client.ts`: `networkKind` exported.
- `sync/calendar-facts.ts`: facts → StoreWrites (`calendar`, `calendarDelete`, `event` with
  `seenGen=nextState.generation`, `eventDelete`, `eventSweep`, `syncState`, `syncFailure`, and
  `provider_memory['cal.sync']` = JSON `[{id,primary}]` — the engine-owned sync set `plan` reads,
  because sync_state rows can't be deleted to say "stop").
- `sync/actor-calendar.ts` (extracted because actor.ts hit the 800-line max): `runCalendarStep` +
  `calendarStepFailed`/`backoffCalendar` via a `CalendarActor` seam interface; several actor members
  relaxed from `private` (deps, stopped, log, backoff, forced, calendarScopeGap, tick, holdScope,
  setTrigger, refreshMissingPermissions, markCalendar, calendarsOk). Per-calendar pause/error lives
  in `runtime.calendars`; `permission` class → `missingPermissions` + that scope's backoff=Infinity.
- Tests: `tests/prov-gmail/calendar.test.ts` 5/5 green (plan gating, list→rows+token+sync set,
  masters/overrides/all-day/incremental, 410 resync, scope refusal→`permission`+`missingScopes`).
  Rig note: `FakeClock()` auto default; `close()` does `clock.auto(false)+stopper.abort()+store.close()`.
  `event` writes need the `calendars` row first or they're dropped (`s.missing`).

## Still to do (next session)

1. **Lane approvals**: owners-check fails until `lane-approved:` labels land. Needed:
   - PR #345: `lane-approved:eng-host` (compose.ts).
   - PR #346: `lane-approved:prov-gmail` (adapter/client/costs/calendar.test), `lane-approved:prov-gov`
     (actor/host/actor-calendar/calendar-facts/tests). Post STATUS REQUEST lines or ask integrator-3.
2. **Review ladder per PR** (rules: 2 SWE-2 passes + 1 Sonnet pass, one fix round max; `delegate_task`
   for each, review their findings, don't trust blindly). PR-A also requests **integrator-3's Opus
   pass on connect.ts in the READY line** — we do not run Opus ourselves.
3. `scripts/local-ci.sh` before each READY.
4. Append READY lines to `plans/STATUS.md`: `date | providers | READY | integrator | text`.
   For PR-A include "request Opus pass on connect.ts (auth path)".
5. **PR-C** (after both merge): recorded/scrubbed `events.list` fixture tests + guarded live run on
   the spare account per `plans/LIVE-RUNS.md` (Mac only, read-only except spare's own calendar; never
   send mail to anyone else). If Google Cloud consent screen (Testing) lacks a scope, tell the
   orchestrator exactly which scope+where once, then `READY-FOR-OWNER` + `~/.config/aplos-owner-ping.sh
   ready ...` (never print the webhook key).
6. Owner still needs to **approve the re-consent in-app** after merge (Settings → Calendar row does it).

## Pitfalls learned

- `gh pr create --body` with backticks inside double-quoted heredoc = shell eats it — use `--body-file`.
- Emulator scope checks: `CAL_SCOPES_FOR` in `gcal/routes.ts` — grants without calendar scopes → 403
  `insufficientPermissions` → class `permission` + `missingScopes`.
- 410 on `events.list` → `ProviderError` `permanent`/reason `fullSyncRequired`, `error.status===410`.
- Cancelled tombstones DO re-list under `showDeleted` without a token (they upsert as `cancelled`
  rows, not swept) — the sweep only kills rows never re-listed.
- `npm run check` > 5 min; run backgrounded or with a long timeout.
- eslint `max-lines` 800 counted lines is what broke actor.ts — that's why actor-calendar.ts exists.
- Log field registry is strict: `sync.gcal.cursor_reset` allows only `{reset}` (no `scope`).
