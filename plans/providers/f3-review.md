# Providers review of the drafted F3 ports and F4 schema

Written 2026-10-27 (day 1) by the Providers thread, as its freeze-review input on `origin/rv/thread/engine` (ports drafted from `port-proposal.md` v2). Paths below are on that branch.

## In plain English

The Engine thread turned our proposal into real code. It is close. Two things would break: the weekly Gmail reconnect could never finish, because the block it is meant to lift also stops the reconnect itself; and a clean-up after one sync round could hide the newest Inbox mail. Both have small fixes. The rest are clarifications.

> **What this means:** With two small fixes the shared rules for Gmail and Calendar can freeze on day 3.

VERDICT: Freeze F3 and F4 after two blocker fixes: reconnect deadlocks on its own auth block, and sweep generations collide across scopes. Nine should-fixes and twelve nits are text edits or optional fields. Of the 27 v2 findings, 25 are satisfied or changed in an acceptable way; #1 and #22 have new gaps.

Paths are on origin/rv/thread/engine. Short names used below: base/gov/prov/cal/eng/time = packages/engine/src/ports/{base,governor,provider,calendar,engine,time}.ts; sport = store/port.ts; commit = store/commit.ts; 0001 = store/migrations/0001_initial.ts; walk = src/ports.walk.md; errors/status = packages/contract/src/{errors,status}.ts.

**OBJECTIONS**

1. **BLOCKER: reconnect is blocked by the auth block it is meant to clear.**
   - `governor.run` throws `PausedError` before any I/O, token calls included, while an account is auth-blocked (base:48-51, gov:79-82).
   - `AccountActorHost.connect` runs connect "under the governor" with the same account id (eng:53-54, prov:276-277).
   - Failure: `invalid_grant` blocks the account. `Account/reconnect` then exchanges its code on the `oauth` budget, gets `PausedError`, and fails. Only `clear()` lifts the block, and only `reconnected()` calls it, so the weekly reconnect can never succeed.
   - Fix (gov doc and the `ConnectContext` comment): "`ConnectContext.governor` ignores `auth` blocks but still honours cooldown, daily and config." Also state that an auth block applies to every budget of the account (gmail, gcal, oauth), because snapshots are per budget.

2. **BLOCKER: sweep generations collide across scopes.**
   - `seen_gen` is one column per placement (0001:54), but `SyncState.generation` is per scope (prov:134), and `SweepBound` has no upper bound (prov:169).
   - Failure: the first-sync `window:inbox` round (gen 0) stamps the top 50 INBOX placements with `seen_gen=0`. A `backfill:inbox` round at gen 1 then sets `scopeCovered {folder:'INBOX', since: oldest on page}`. The sweep removes every newer INBOX placement with `seen_gen < 1`, so the whole first window drops out of the local Inbox. History never re-adds it. IMAP chunked rounds hit the same bug.
   - Fix:
     - (a) Take generation values from one monotonic per-account source (the store `seq` at round start); document this on `SyncState.generation`.
     - (b) Add `until?: number` to `SweepBound`.
     - (c) Define the sweep as `seen_gen IS NOT NULL AND seen_gen < generation` inside the bound. NULL means keep, so placements written by history during a resync survive.
     - (d) Add a `sweep` StoreWrite kind so the sweep commits in the same transaction as the step that set `scopeCovered`. The union at sport:69-73 has none.

3. **should-fix: a Gmail resync sweep strips INBOX from older messages in a thread.**
   - walk:19 allows a 20-unit `messages.get` of the newest message only. The older INBOX messages of a listed thread are then never stamped and get swept.
   - Failure: PV3's "delete one reply in Gmail web" (or archiving the newest message) drops the conversation out of Inbox.
   - Fix (walk text): a window step that sets `scopeCovered` returns `PlacementDelta {remoteId, folder:'INBOX', present:true}` for every id `messages.list` returned, fetched or not. Alternatively use `threads.get` metadata.

4. **should-fix: the overdue rule catches `sending` rows (double send).**
   - eng:94-95 says "dispatched more than 5 minutes past `not_before`, for any reason, becomes `suspended`", and `start()` applies the rule (eng:55).
   - Failure: the app is killed after the marker and relaunched more than 5 minutes later. The `sending` row becomes `suspended`, the user taps "Send now", and the mail goes out twice.
   - Fix: the overdue rule applies to `queued` only. A `sending` row at start becomes `uncertain`, and `findSent(internetId, attempt_at)` runs before anything else.

5. **should-fix: errors raised before `fn` runs are classed as uncertain.**
   - The governor refreshes the token inside `run` before a send (eng:84).
   - Failure: a refresh network error or `invalid_grant` is thrown as `ProviderError`, so SendPort treats it as uncertain (eng:93). The user gets a false "could not confirm" prompt, and `findSent` runs while the account is blocked.
   - Fix (gov:79-83): for `kind:'send'`, anything thrown before `fn` is invoked becomes `PausedError` (for blocks) or `NotSentError` (for anything else).
   - Also add to prov:446: `send` may let `PausedError` or `NotSentError` escape only if no earlier request in the same call could have delivered the mail (for example iCloud SMTP followed by an APPEND).

6. **should-fix: shrinking the in-flight limit starves lanes.**
   - A concurrency refusal drops in-flight to 1 (errors:32). Gmail reserves 1 slot for interactive and opFlush (gov:23-25), so incremental and backfill get 0 slots.
   - A Graph `$batch` takes 4 slots, which is more than a limit of 1 (gov:39-40), so it is never admitted. Finding 22 comes back.
   - Nothing says how `inFlightLimit` grows back.
   - Fix (doc): reserved = min(reservedInteractive, inFlightLimit − 1); `slots` is clamped to the current limit (a clamped batch runs alone); `inFlightLimit` grows by 1 per 10 quiet minutes up to the spec.

7. **should-fix: the Gmail `laneShare` example leaves out `enrichment`** (gov:21), and "a lane left out may use none."
   - Failure: workflow rounds never run, so the lease is never renewed and Done/Later never sync.
   - Fix: add `enrichment` to the example and to the spec. The workflow round must also run on a secondary device.

8. **should-fix: `observe` cannot carry project scope.**
   - Scope moved from `ClassifiedError` to `ProviderError` (base:43-46), but `observe` takes only a `ClassifiedError` (gov:86, 105).
   - Failure: a `dailyLimitExceeded` inside a Gmail batch part blocks only that account; the other accounts keep sending requests that get refused.
   - Fix: `observe(budget, error, scope?: 'account'|'project')`.

9. **should-fix: `FolderWrite.role` lacks the `category.*` roles** (sport:109). The port's `FolderRole` has them (prov:93-95) and `laneFor` reads them (content:73-74).
   - Failure: Gmail tabs can't be stored, so Home loses Promotions and Social.
   - Fix: `role?: FolderRole | null`, and update SCHEMA.md:11.

10. **should-fix: a calendar 410 resync cannot remove deleted events.**
    - `CalendarStepResult.scopeCovered` (cal:92) implies a sweep, but `events` has no `seen_gen` (0001:154-157).
    - Failure: an event deleted while the sync token was invalid stays forever as a ghost meeting.
    - Fix: add `events.seen_gen INTEGER` to 0001 now. Add `bound?: {from, to}` to the calendar `scopeCovered` so round 2's Graph `calendarView` window sweep doesn't delete events outside the window.

11. **should-fix: per-folder providers can't say their placements are partial.**
    - `MessageFacts.placements` means "every folder" (prov:64-68). It maps to `MessageWrite.folders`, which replaces stored placements (sport:120-123, 149).
    - Failure (round 2): an IMAP or Graph per-folder step knows one folder, so a message that is in two folders loses the other placement.
    - Fix now: `placementsComplete?: boolean`, default true. When false, the actor writes `PlacementsWrite` add instead.

12. **nit:** step-origin enums don't match. `StepOrigin` has `'workflow'` (prov:149) and `SyncStepOrigin` has `'search'` (sport:42). Add `'workflow'` to the store's enum.

13. **nit:** walk:21 says the next `plan()` bumps the window generation, but `plan` is pure. Correct text: the 404 step clears the history cursor in `nextStates`; the first resync window page (origin `'resync'`, no `pageToken`) writes its own state at the new generation.

14. **nit:** `knownCount` must be the server's count, and nothing stores it (no column, so `threadSize` is dropped).
    - Failure: a caller passes `threads.msg_count = 1` for a 5-message thread, and opening it fetches 1 message.
    - Fix: document "server-reported size only" or add `threads.remote_count`.

15. **nit:** default to secondary until the first workflow round (ARCH 6.5). walk:15 doesn't say.

16. **nit:** status:30-31 says "grant + 7 days"; align it with prov:286-289, min(grant + 7 d, `refresh_token_expires_in`). The `oauth_client` column (0001:27) has no source in `ConnectResult`.

17. **nit:** `ErrorProviderSchema` uses `'google'` and `'ai'`, not `BudgetId` (errors:12), which finding 27 asked for.

18. **nit:** `governor_state` has no column for `blocked.since` (gov:66). Reuse `last_refusal_at` or add one.

19. **nit:** prov:440 says `apply` takes "idempotent writes only", but walk:51 sends a Graph `/move` as a `write`. `OpOutcome` has no uncertain outcome. Say which request kinds `apply` may use.

20. **nit:** the governor can't tell the caller from its siblings if `observe` runs inside `fn` (gov:85). Say adapters call `observe` after `run` resolves.

21. **nit:** CalDAV overrides share a UID, so `removals: string[]` can't remove one override. State the store rule: a resource upsert is the full row set for that `remote_id`.

22. **nit:** add `found?` to `StepResult.progress`, which feeds `firstWindow.found` (eng:39).

23. **nit:** status:16-24 carries the provider's raw `reason` with no normalized code (finding 27). The UI then needs copy per provider. Add an optional open `code`.

24. **nit:** for round 2 IMAP, the drafts table needs the synced copy's Message-ID. Make it derivable from the draft id and `synced_revision`, or add a column.

**FINDINGS 1-27 (does F3/F4 still satisfy each?)**

| # | Verdict | Where |
|---|---|---|
| 1 | changed-but-fine, with objections 2 and 3 | prov:169, 190-191; 0001:54; sport:151, 164 |
| 2 | yes | gov:43-48, 81-82; prov:252-253 |
| 3 | changed-but-fine (no `deferUntil`; `NotSentError` → failed), with objection 4 | eng:88-103; base:48-66 |
| 4 | yes | prov:136-137, 188-190; gov:85-86; 0001:129 |
| 5 | changed-but-fine (`LeasePort` → `claimLease` + `deviceId`) | prov:396-407; eng:69-70, 124 |
| 6 | yes, but see objection 1 | gov:41-42, 80-81; eng:76-86 |
| 7 | changed-but-fine (scope on `ProviderError`; no `conflict` class), with objection 8 | errors:7; base:29-46; gov:63-66, 95-96; eng:43-44 |
| 8 | yes | gov:53-55, 91-92; 0001:137 |
| 9 | changed-but-fine (body and search writes are additive later) | eng:20-29 |
| 10 | yes (moved to `PlannedStep.origin`), see nit 12 | prov:149-157; sport:48 |
| 11 | yes | prov:171, 186-187, 192 |
| 12 | yes | prov:141, 160-166, 429 |
| 13 | yes | prov:65-67, 81 |
| 14 | changed-but-fine (`memory` instead of budgets) | prov:292-293, 465-470; gov:38; base:27 |
| 15 | yes | prov:108-118, 234; 0001:109 |
| 16 | yes | prov:83-90 |
| 17 | yes (plus `KnownLookup.placements`) | prov:185, 216-217, 237-239, 345-346 |
| 18 | changed-but-fine (conflict is a result) | cal:35-51, 98-121 |
| 19 | yes | 0001:155-157 |
| 20 | yes | eng:35-36 |
| 21 | yes | gov:56-58; 0001:138 |
| 22 | no: regresses after an in-flight drop (objection 6) | gov:23-25, 39-40 |
| 23 | changed-but-fine (host folds in the arithmetic), see nit 16 | prov:276-289 |
| 24 | yes | prov:381-392; errors:34-35; 0001:116 |
| 25 | yes | gov:79-82; walk:11 |
| 26 | yes | prov:72; walk:19 |
| 27 | changed: target, `requestAll` and the open union are fine; normalized codes dropped (nit 23) | gov:18; eng:65; status:16-24 |

**ACCEPTED Engine changes**
- `ProviderFactory.open(account)`: one adapter per account (prov:465-471).
- Conflicts as results, with no `conflict` error class (cal:98-104, prov:363-366).
- No `UncertainSendError`. Treating anything that isn't proven not-sent as uncertain is the safe default, provided objections 4 and 5 are fixed.
- One `placements[]` field, with objection 11.
- `Removal` means server-stated deletion only; `VANISHED` and `@removed` become `PlacementDelta` (prov:83-90).
- `TokenSource` as `cached()` plus `refresh(io)` inside `governor.run` on the `oauth` budget (eng:81-86), with objection 1 for connect.
- The host turns `refreshExpiresAt` into `reconnectBy`, with nit 16.
- `findSent(internetId, since)`.
- `SyncLane` and `HomeLane` as separate names.
- `PlannedStep.origin`, `ConnectResult.memory`, `CalendarAdapter.plan`, `DraftUpload.internetId`, `KnownLookup.placements`.
- `master_remote_id` replacing `master_id`: the join on (calendar_id, master_remote_id) uses index `events_master`. It works for Google (`recurringEventId`) and CalDAV (UID, master at `recurrence_id ''`) and avoids lazy resolution.

**CASES**

Pass:
- **Gmail first sync to `baseline_done_at`:** P0 captures the cursor and folders, `window:inbox` runs with origin baseline, and `baselineReached` sets `AccountWrite.baselineDoneAt`. No notifications before then.
- **History 404:** passes once B2, objection 3 and nit 13 are fixed.
- **`quotaExceeded` plus a manual sync:** Gmail `quotaExceeded` maps to `daily`; `request()` returns `Admission` with no I/O (eng:63-65).
- **Concurrency 429 inside an HTTP batch:** `observe`, with the unfetched ids in `pending`. Passes with objection 6.
- **Send killed after the marker:** goes to `findSent` with a 60 s recheck. Passes only with objection 4.
- **Weekly reconnect:** `login_hint` and `expectedSubject` reach connect (prov:263-268), the account id is resolved from the `id_token`, and ops and drafts are kept. **Fails until B1 is fixed.**
- **Two devices and the lease:** passes with objection 7 and nit 15.
- **Lazy `openThread`:** passes (nit 14).
- **Search on Enter:** rows commit with `origin='search'` and are kept out of `thread_folders` (commit:400).
- **IMAP `MESSAGELIMIT` and `VANISHED`:** `MESSAGELIMIT` never sets `scopeCovered` (prov:190); `VANISHED` becomes a `PlacementDelta`. A store target by folder and UID is an additive write kind later.
- **Graph `$batch` sub-response 429:** passes with objection 6.
- **Google Calendar override edit:** the instance id is derived from the master and `recurrenceId`; the `saved` upserts carry `masterRemoteId`.
- **RSVP:** passes (cal:121).
- **Google Calendar 410:** passes only with objection 10.

**SCHEMA 0001: S1-S11**

All present.
- S1 token_granted_at, refresh_expires_at, S2 remote_subject, S3 primary_lease_device and primary_lease_until, S4 oauth_client: 0001:27-28
- S5: 0001:155-159
- S6: 0001:152
- S7 seen_gen plus the unique partial index mf_uid: 0001:54-57 (mf_folder is kept, non-unique, for scans by folder)
- S8: all columns at 0001:135-139, with no foreign key, so `'*'` rows are allowed
- S9: 0001:129
- S10: 0001:109
- S11: 0001:116

Gaps:
- `events.seen_gen` is missing (objection 10).
- `blocked_since` is missing (nit 18).
- The `master_id` → `master_remote_id` change is accepted, as above.