# Answers to the Providers review of F3 and F4

The review is `plans/providers/f3-review.md` on `rv/thread/providers`. Paths below are under `packages/engine/src/` unless they start with `packages/`.

## Engine answer (2026-10-27)

**Objections**

1. BLOCKER, reconnect blocked by its own auth block: fixed. `ConnectContext.governor` ignores `auth` blocks and still honours cooldowns, daily stops and `config` (ports/provider.ts:`ConnectContext`, ports/governor.ts:`GovernorPort.run`, `BoundGovernor`, ports/engine.ts:`AccountActorHost.connect`). An auth block applies to every budget of the account, gmail, gcal and oauth (ports/governor.ts:`GovernorSnapshot`, ports/base.ts:`PausedError`). The walk's reconnect paragraph says the same.
2. BLOCKER, sweep generations collide across scopes: fixed. (a) Generations come from one monotonic source, the store `seq()` when a round starts, handed to adapters as `AdapterContext.generation` (ports/provider.ts:`SyncState.generation`, `AdapterContext.generation`). (b) `SweepBound.until` added. (c) The rule is `seen_gen IS NOT NULL AND seen_gen < generation` strictly inside the bound, and NULL means keep (ports/provider.ts:`SweepBound`). (d) A `sweep` write commits in the same transaction as the step (store/port.ts:`SweepWrite`, store/commit.ts:`CommitRun.sweep`). Also, a stamp only rises (store/commit.ts:`CommitRun.place`), so a late page of an older round cannot lower a newer stamp. Tests: tests/store/sweep.test.ts (first window at an earlier generation, then a backfill round: the window stays in Inbox; the unbounded sweep reproduces the reported loss).
3. Gmail resync sweep strips older thread messages from Inbox: fixed in text. A step that sets `scopeCovered` returns a `present: true` `PlacementDelta` for every listed id in the bound's folder, fetched or not (ports/provider.ts:`StepResult.scopeCovered`, ports.walk.md Gmail first sync).
4. Overdue rule catches `sending` rows: fixed. The overdue rule applies to `queued` rows only; a `sending` row found at start or wake becomes `uncertain` and runs `findSent(internetId, attempt_at)` before anything else, never suspended or re-sent (ports/engine.ts:`SendPort` and `AccountActorHost.start`, ports.walk.md send paragraph).
5. Errors raised before `fn` are classed as uncertain: fixed. For `kind: 'send'` anything thrown before `fn` runs is `PausedError` (blocks and pauses) or `NotSentError` (anything else) (ports/governor.ts:`GovernorPort.run`, ports/engine.ts:`SendPort`). Multi-request sends may let those escape only if no earlier request could have delivered the mail (ports/provider.ts:`ProviderAdapter.send`).
6. Shrinking the in-flight limit starves lanes: fixed in text. Reserve = min(`reservedInteractive`, `inFlightLimit` - 1); `slots` is clamped to the live limit and a clamped request runs alone; the limit grows by 1 per 10 quiet minutes up to `inFlight` (ports/governor.ts:`BudgetSpec.inFlight`, `GovernedRequest.slots`).
7. Gmail `laneShare` leaves out `enrichment`: fixed. Example now has enrichment 0.1, and the doc says every planned lane needs a share and the workflow round runs on a secondary device too (ports/governor.ts:`BudgetSpec.laneShare`).
8. `observe` cannot carry project scope: fixed. `observe(account, budget, error, scope?)` and `BoundGovernor.observe(budget, error, scope?)` (ports/governor.ts).
9. `FolderWrite.role` lacks `category.*`: fixed. `FolderRole` now lives beside `folders.role` and F3 re-exports it; `FolderWrite.role?: FolderRole | null` (store/port.ts:`FolderRole`, `FolderWrite`; ports/provider.ts re-export; store/SCHEMA.md `folders`). Test in tests/store/sweep.test.ts.
10. Calendar 410 resync cannot remove deleted events: fixed in schema and port. `events.seen_gen INTEGER` (store/migrations/0001_initial.ts), and `CalendarStepResult.scopeCovered.bound?: {from, to}` with the same sweep rule (ports/calendar.ts). The events sweep write itself ships with the event write kinds (`prov-cal`, additive), since F4 has no event writes yet.
11. Per-folder providers can't say placements are partial: fixed. `MessageFacts.placementsComplete?: boolean`, default true; false makes the actor write `PlacementsWrite` adds instead of `MessageWrite.folders` (ports/provider.ts:`MessageFacts`). The store already keeps other placements on that path; test in tests/store/sweep.test.ts. The walk says Graph and IMAP set it.
12. Step-origin enums don't match: fixed. `SyncStepOrigin` has `'workflow'` (store/port.ts).
13. Walk says `plan()` bumps the generation: fixed in text. The 404 step clears the history cursor in `nextStates`; the first resync window page writes its own state at `ctx.generation` (ports.walk.md Gmail incremental).
14. `knownCount` has no stored source: fixed. `threads.remote_count` and `ThreadWrite.remoteCount`, fed from `MessageFacts.threadSize`; `knownCount` is documented as the server-reported size, never `msg_count` (store/migrations/0001_initial.ts, store/port.ts:`ThreadWrite`, store/commit.ts:`CommitRun.thread`, ports/engine.ts:`ProviderPort.openThread`).
15. Default to secondary until the first workflow round: fixed in text (ports.walk.md lease paragraph).
16. `reconnectBy` text and `oauth_client` source: fixed. `reconnectBy` is min(grant + 7 days in Testing mode, `refresh_token_expires_in`) (packages/contract/src/status.ts:`AccountHealthSchema`, ports/provider.ts:`ConnectResult.grant`); `ConnectResult.grant.client` feeds `accounts.oauth_client`.
17. `ErrorProviderSchema` lacks the budget ids: fixed. Still open, now listing gmail, gcal, graph, imap, imapBytes, jmap, caldav, oauth plus google, microsoft, ai (packages/contract/src/errors.ts; `generated/openapi.json` regenerated).
18. `governor_state` has no `blocked_since`: fixed. Column `blocked_since INTEGER` (store/migrations/0001_initial.ts; ports/governor.ts:`GovernorSnapshot.blocked`).
19. `apply` says idempotent writes only: fixed in text. `apply` runs `idempotentWrite` where the provider has one and `write` for moves that are not (Graph `/move`, IMAP `UID MOVE`); a lost reply is `failed` with `error.uncertain`, held until the next incremental pass (ports/provider.ts:`ProviderAdapter.apply`, `OpOutcome.result`).
20. `observe` inside `fn`: fixed in text. Adapters call `observe` after `run` resolves (ports/governor.ts:`GovernorPort.observe`).
21. CalDAV overrides share a UID: fixed in text. An upsert of one `remoteId` is that resource's full row set; a removal removes every row of that id (ports/calendar.ts:`CalendarStepResult`).
22. `progress.found`: fixed (ports/provider.ts:`StepResult.progress`).
23. No normalized code beside the raw `reason`: already closed by contract v1, so no second field. `AccountHealth.reasonCode` (open `ReasonCodeSchema`) carries the copy key next to the raw `status.reason` (packages/contract/src/status.ts). Added the same key to the per-calendar rows (ports/engine.ts:`AccountRuntime.calendars[].reasonCode`). A `code` inside each status variant would duplicate it.
24. Drafts need the synced copy's Message-ID: fixed. Column `drafts.remote_internet_id` (store/migrations/0001_initial.ts, store/SCHEMA.md); a stored value beats a derivation that would tie the Message-ID format to the draft id.

**Findings with a gap**

- #1 (sweep): fixed through objections 2 and 3 above.
- #3 (send outcomes): fixed through objection 4 (and 5).
- #6 (governed connect): fixed through objection 1.
- #7 (scope on `ProviderError`): fixed through objection 8.
- #10 (`PlannedStep.origin`): fixed through nit 12.
- #22 (lanes after an in-flight drop): fixed through objection 6.
- #23 (`reconnectBy`): fixed through nit 16.
- #27 (normalized codes): `ErrorProviderSchema` per nit 17; the codes are `AccountHealth.reasonCode` and `ErrorBody.reasonCode` (nit 23).

**Also changed:** `EventFacts.masterRemoteId` no longer says it resolves to `master_id` lazily; it is stored as `master_remote_id` (ports/calendar.ts).

## Freeze review (2026-10-27, agent B: ports, dispatch and method runtime)

The findings are `plans/freeze/findings.md` on `revamp`. Ports commit 293f4a3, dispatch commit c76120e, both on `rv/eng-contract/freeze-fix-b`.

- **FR-2 (blocker, ports side): fixed.** The overdue rule covers every row waiting on `not_before`, `queued` and `scheduled` alike, never `sending` (ports/engine.ts:`SendPort`, `AccountActorHost.start`, `WAITING_SUBMISSION_STATES`, `OVERDUE_GRACE_MS`; ports/time.ts `outbox`). Test: tests/ports.test.ts "a send-later row that fell due...". Still needed from the store owner: `sub_due` must index `state IN ('queued','scheduled')`, and SCHEMA.md must say so.
- **FR-11: fixed.** `dispatch` denies by default before any handler runs (methods/index.ts:`refusal`): the method's scope must be in `caller.scopes`, `host` methods need `caller.kind 'host'`, a listener reaches only `listenerMethods` (so no uiOnly, secret or host method), and an MCP client (`Caller.via: 'mcp'`) only `mcpMethods`. It reads the zod-free `@aplos/contract/allowlists`. Assumption: `listenerMethods` is exactly "not uiOnly, not secret, not host" (the generator's `listenable`); a separate `uiOnlyMethods` table would change nothing. Transports must set `via: 'mcp'`, give a window every grantable scope and main `host`. Tests: tests/methods.test.ts.
- **FR-12: fixed.** `CalendarPort` {put, remove, rsvp} and `RulesPort` {list, create, delete} (ports/engine.ts). Handlers reach every port through `MethodContext.services` (methods/types.ts:`EngineServices`).
- **FR-18: fixed.** The class-by-class policy is in ports/governor.ts: `GOVERNOR_CLASS_POLICY` (exhaustive over `ErrorClass`, no `conflict` row) and the list above it.
- **FR-19: fixed.** `EventChange.notify` and `notify` on `remove`'s ref (ports/calendar.ts); absent means guests are not emailed.
- **FR-20: fixed (ports side).** `RECURRENCE_ID_FORMAT` (UTC `YYYYMMDDTHHMMSSZ`, all-day `YYYYMMDD`, floating `YYYYMMDDTHHMMSS`); CalDAV `remoteId` is the href with no `masterRemoteId`; `EventFacts.uid` and `EventFacts.instance` (ports/calendar.ts). Still needed from the store owner: SCHEMA.md `events` should say `master_remote_id` is GC `recurringEventId` / O `seriesMasterId` and empty for CalDAV, give the canonical `recurrence_id` form, and add a `uid` column in 0002. From the contract owner: F1 `Event` id doc `<seriesId>@<originalStartUtc>` should point to the same form (date for all-day, no `Z` for floating).
- **FR-24: fixed.** `AccountActorHost.request({ force })`, `GovernorPort.retryNow`, `AccountActorHost.releaseLease`, `AccountRuntime.lease.pinned`.
- **FR-25 (ports part): fixed.** `ConnectRequest.calendarSecretRef`; a reconnect carries the new `secretRef` (ports/provider.ts). Still needed from the contract owner: a secret, audited method (e.g. `Account/updateSecret {accountId, secret, calendarSecret?}`) that feeds `connect({ mode: 'reconnect', secretRef })`, and an optional second secret on `Account/connect` for Fastmail.
- **FR-26: fixed.** `DraftUpload.baseRemoteMessageId` and `baseChangeKey`, `DraftSaveResult` `conflict` (and `saved.changeKey`), `KnownLookup.draftsByMessageId`, and the `saveDraft` doc: the adapter picks the kind, and create-plus-destroy updates are `write` (ports/provider.ts). Still needed from the store owner: implement `draftsByMessageId` over `drafts.remote_message_id`; a `change_key` column for Graph in round 2.
- **FR-34 (ImageProxy only): fixed.** `ImageProxy`, `ProxiedImage`, `ImageRefusal`, `IMAGE_PROXY_LIMITS` with the address, redirect, port, size, type and per-token rules (ports/content.ts); `EngineServices.images`. The srcdoc and inner-CSP parts are other owners'.
- **FR-35 (ports side): fixed.** F3 `EventTime` is the F1 type; `Attendee.email` became `address` (plus `optional`); `AccountRuntime.missingPermissions[].reasonCode`; `Capabilities.importance`. Non-additive inside F3, which is not frozen yet. Still needed: store `AccountWrite.capabilities` should accept `threading` (`Record<string, boolean | string>`, or F3 `Capabilities`); the contract `Folder.role` doc should list the `category.*` roles.
- **FR-36 (test title): fixed.** tests/portability.test.ts names what it measures: the engine with contract types and zod-free tables, no zod. Measured on this branch: engine 96,216 bytes unminified and 63,150 minified; with the contract registry and `zod/mini`, 271,201 and 152,010 bytes. The `HttpAddress` half is the contract owner's.
