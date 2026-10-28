# Providers: port gaps found while building on the freeze head (day 2)

Found on 2026-10-28 while building the account actor, the governor on the F3 ports and the Gmail adapter against `rv/thread/engine@f510762` (code on `origin/rv/prov-gov/actor`). Each item names its owner and whether it is additive. None blocks Providers work: each has a local stand-in, listed here so it does not quietly become permanent.

## In plain English

While wiring Gmail sync end to end, we found a handful of small things the shared rules don't say yet: who supplies a few settings, and the shape of some data that passes between lanes. All of them are additions, not changes, and Gmail sync works today with stand-ins.

> **What this means:** These are small follow-ups for the Engine thread, not problems with the freeze.

## For eng-contract (ports; additive)

| # | Gap | Stand-in today | Ask |
|---|---|---|---|
| G1 | `GovernorPort` cannot give the connect-mode governor that ignores auth blocks (agreed in B1) | `Governor.bindConnect(account)` | Add `GovernorPort.bindConnect(account): BoundGovernor` |
| G2 | `GovernorPort` has no way to receive `ProviderFactory.budgets()` output | `Governor.setBudgets(account, specs)` | Add `setBudgets(account, specs)` |
| G3 | No `BudgetSpec` for the `oauth` budget | default 30 req/min, 1 in flight | State that each factory's `budgets()` includes `oauth`, or name the default in the port |
| G4 | `AccountActorDeps.tokens` has no path into the governor, which owns the forced refresh | token source passed to the `Governor` constructor | Say the governor is built with `TokenSource` (constructor contract), or add `GovernorPort.setTokens` |
| G5 | Lease input has no port field | `ActorHost.leaseChanged(account, lease)` | Add it to `AccountActorHost` |
| G6 | `Sync/request.scope` does not say whether it narrows the pass | accepted, full pass run | Say "hint only" or "narrow to that scope" |
| G7 | `StepResult`/`MessageFacts` cannot tell "newly arrived" from "moved back into the Inbox" (Gmail history knows: `messagesAdded` vs `labelsAdded INBOX`) | none; eng-time can only compare dates with `baseline_done_at` | Add an optional `arrival: 'new' \| 'moved'` per upsert, so notifications never fire for old mail moved back |
| G8 | `AdapterContext` does not expose `baselineDoneAt` | the Gmail adapter keeps its own memory key | Add `baselineDoneAt?` to `AdapterAccount` |
| G9 | `GovernorSnapshot` has no field for "Retry now already used in this cooldown" | lost on restart | Add `retryUsedFor?: number` |
| G10 | `StepResult.progress.read`: per-step increment or running total? | actor sums; Gmail reports a running total (over-counts) | Say which; Providers aligns the other side |

## For eng-store

| # | Gap | Stand-in today | Ask |
|---|---|---|---|
| S-a | No `KnownLookup` implementation; `AccountActorDeps` has no lookup field | `storeLookup` in `sync/lookup.ts` reading the store directly | Own it in the store (with the day-1 asks `messageDates`, `messagePlacements`, `knownFolders`, `partialThreads`) or confirm Providers keeps `sync/lookup.ts` |
| S-b | `ConnectResult.credentialRef` has no column in `accounts` | not stored on reconnect | Add `accounts.credential_ref TEXT` |

## For eng-views (data shape)

| # | Gap | Ask |
|---|---|---|
| V-a | `ops.payload` is opaque in the ports | `Thread/act` writes ops with `payload = OpPayload { remoteId, change }` as defined in `packages/engine/src/sync/ops.ts` on `rv/prov-gov/actor`; a malformed payload settles as `failed` / `invalidPayload` |

## For eng-time

| # | Gap | Ask |
|---|---|---|
| T-a | Remote-draft writes in `commitStep` need eng-time's commit extension registered, or the step commit fails | Register the drafts extension before the actor runs; until then the actor skips `drafts` facts in tests |
| T-b | Notifications: see G7 | Use `arrival` once added |

## Providers' own follow-ups (no ask)

- Test plan prov-gov-T18 said the in-flight cap returns straight to 3 after 10 quiet minutes; the frozen port says +1 per 10 minutes. The port wins; T18 is corrected below.
- Two Macs both acting as primary are absorbed by AIMD today (combined peak 4,490 against 4,500); the lease (`sync/lease.ts`) makes it exact. Its attack test is held as `todo`.
