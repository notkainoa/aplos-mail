# @aplos/contract-fixture

The stand-in engine (plan 10 section 4.1, Phase 0 artifact F6): the whole v1 contract of `@aplos/contract` on in-memory
data, behind the same `EngineConnection` the real engine's transports implement. The UI builds against it from day 4,
the conformance suite holds it and the real engine to the same assertions, and E2E journeys run on it.

It is test support. Nothing in `packages/engine` or `packages/contract` imports it, its demo data never counts toward the
400,000-byte engine budget, and no release ships before the screens switch to the real engine. It has no Node, Electron
or DOM-only imports (`tests/portability.test.ts`), so it runs in Electron, the browser preview and a plain test.

## Use

```ts
import { createClient } from '@aplos/contract/client';
import { createFixtureEngine } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';

const engine = createFixtureEngine({ scenario: 'demo' });   // seed 1, fake clock at 2026-10-27 16:00 UTC
const session = engine.connect();
const { api, subscribe } = createClient(session);
const control = fixtureControl(session);                    // test-only knobs, same session

const home = await api.view.watch({ spec: { kind: 'home' } });
await control.advanceClock({ ms: 250 });                    // timers, coalescing and canned AI run on this clock
```

`createFixtureEngine({scenario, seed?, clock?, timeZone?, checkResults?})`:

| Option | Default | Meaning |
|---|---|---|
| `scenario` | (required) | One of the scenarios below |
| `seed` | `1` | Same seed, same `dbEpoch`, ids and fake statuses |
| `clock` | fake, at `defaultNow` | A start time for a fake clock, `'real'` for wall time (the browser preview, where nobody advances time), or a `FixtureClock` to share between engines |
| `timeZone` | `America/Los_Angeles` | The zone due bands, Later presets and demo events are computed in |
| `checkResults` | `true` | Every result passes the registry's `checkResult`, so a fixture bug fails loudly |

Every call goes through `parseArgs` and a real reply envelope (`toReply`/`fromReply`), so errors are `ContractError`s
with the contract's types and sentences. Each `connect()` is one session with its own windows and frame stream; all
sessions of one engine share its data, as windows of the app share one engine.

## Verbs

Every engine-host method in the registry has a handler (`src/methods/*.ts`, one file per area; `methods/index.ts` fails
the typecheck if one is missing). Where real behaviour is out of scope the answer is schema-valid and plausible:

- **Session and settings.** `Session/get` (with `hasAccounts`, capabilities, `now`), `Session/changes` with
  `cannotCalculateChanges` for another `dbEpoch` or a `since` below the change-log floor, `Settings/get|set` (sections
  merge one level; `ifInState`), `Outbox/pending`, `Later/presets`.
- **Live windows.** `View/watch|move|unwatch|hold|release|query` over in-memory sorts (`src/views.ts`): Home's sections
  `do`, `fromLater`, `update`, `low` (count-only band) and `follow`; Later's groups; one section per sender on
  `lowSenders`; `sections: []` elsewhere. Held rows (`holdIds`, `View/hold`) stay where they were last sent until
  released or 2 s after the last hold call. Window frames are ID-only, sent only when the visible window or a row's
  revision changed, at most one per 250 ms per window. `state` frames coalesce over 100 ms. Every frame carries
  `{dbEpoch, seq}`.
- **Writes.** Every command commits once (one `seq`), returns `{opId, appliedState}`, and is idempotent by `opId`.
  `Thread/act` takes `ids` or a `ThreadSelector` (resolved at `atState`: rows created later are left alone).
  Provider-bound writes are `queued`, count in the account's `pendingChanges`, and sync 600 ms later (an `operation`
  frame). `Operation/undo` restores the before-images (revisions still move forward); undo while queued cancels the
  provider write. `Operation/retry` re-applies a failed one.
- **Mail.** `Thread/get|open|why`, `Message/get`, `MessageBody/get|prefetch`, `Mail/frame|release|toggleQuotes|serve`
  (`aplos-mail://m/<token>` URLs; `Mail/serve` answers the frame's HTML), `Mail/allowImages`, attachments, `Blob/*`,
  `Message/original`, `Unsubscribe/get|run`, `SenderRule/*`, `Search/remote` (progress frames, no results).
- **Compose.** `Draft/*`, and `Submission/set` running the ARCH 7.1 send machine on the clock: queued (until
  `undoSendSeconds`) or scheduled, then sending, then sent (a Sent message lands in the thread) or whatever
  `nextSendOutcome` says.
- **Calendar.** `Calendar/*`, `Event/get|set|rsvp` (`following` scope refused with `unsupported`, as
  `capabilities.eventFollowingScope` says), `Event/extract`, `Plan/*`. Events written here are `sync: 'pending'` until
  their operation syncs.
- **AI, all canned, no request leaves the fixture.** `Ai/request` (a summary 1 s later), `Ai/draft|polish|transcribe`,
  `Ask/run` (`progress` frames: `step`, `text`, `citation`, `proposal`, `done`; the turn lands in the `Conversation`),
  `Ask/cancel|decide`, `Consent/*`, `Ai/providers|models|status|usage|testKey|test`. Groq reports `keySource: 'env'`;
  `Ai/setKey` records only that a key is in the keychain and never keeps any of it.
- **Accounts and setup.** `Account/connect` creates a practice Google account (the demo mailbox under one address)
  through `connect` frames, then first sync ticks every 400 ms: connecting, finding, reading (six threads a tick),
  sorting (with consent), ready. `Setup/begin|end|status|retry`, `Account/reconnect|grantPermissions|cancelConnect|set|
  lease|disconnect`, `Account/discover`, `Sync/request` (refused while paused, offline or needing reauth; otherwise
  syncing then ok), `Demo/load|reset|remove`.
- **Admin.** `Queue/*`, `Diagnostics/*`, `Listener/*`, `Clients/*`, `Workflow/*`, `Notification/claim|ack`,
  `Reminder/*`, `Data/export`.

**Desktop methods** (`File/save`, `Window/*`, `System/*` and the rest of the desktop host) are main's, not the engine's.
The fixture refuses them with `unsupported`, as it does any unknown method. A UI harness routes them with
`routeByHost({engine: fixtureSession, desktop: yourStub})`.

## Scenarios

| Scenario | State |
|---|---|
| `empty` | No accounts, no consent, Groq key from the environment. `Account/connect` or `Demo/load` from here |
| `demo` | Aplos's own demo mailbox: two accounts (work and personal), 18 threads across every place, a week of events, an invitation, a plan, a draft. All `.example` domains |
| `offline` | `demo`, every account offline |
| `needs-reauth` | `demo`, the work account past its weekly reconnect |
| `backfilling` | `demo`, both accounts backfilling 120 of 2,400 |
| `rate-limited` | `demo`, the work account paused for a minute (`rate.minute`) |
| `partial-threads` | `demo`, four rows `partial: true` until opened |
| `send-uncertain` / `send-suspended` | `demo` with one submission in that state |
| `ai-off` | `demo`, no key, no consent, no summaries |
| `ai-budget-spent` | `demo`, today's background budget spent until local midnight |
| `setup-partial` | `demo`, first sync unfinished: the work account paused at 6 threads, one AI failure |
| `parked` | The engine is parked (`crashLoop`); calls other than `Session/get`, `Setup/status` and `Diagnostics/*` answer `unavailable` |
| `small-10k`, `large-100k` | Declared; throw "arrives in Phase 1". The seeded generator is shared with E2's store bench |

The scenarios beyond `empty` and `demo` are minimal at C1; `eng-contract` deepens them in Phase 1.

## The control channel

`Fixture/control` is a call on the same session as every method, so it works over any transport the fixture is served
on (in-process, a MessagePort, the preview's HTTP binding). It is not in the registry, the generated allowlists or
OpenAPI, and a real engine refuses it with `unsupported`. `fixtureControl(sessionOrConnection)` gives one typed function
per knob (`src/control-types.ts`):

| Knob | Does |
|---|---|
| `setAccountStatus {accountId, status, reasonCode?, reconnectBy?}` | Force any ARCH 6.4 status |
| `pauseAccount {accountId, forMs, class?, reason?, reasonCode?}` | A governor pause (rate limit), back to ok after `forMs` |
| `failNextWrite {mode?, type?, message?, reasonCode?, afterMs?}` | `reject` fails the next command; `afterReceipt` (default) returns the receipt, then fails the operation and puts the rows back |
| `setSubmissionState {submissionId, state, problem?}` | Put a submission in any send state |
| `nextSendOutcome {outcome}` | How the next send attempt ends: `sent`, `uncertain` or `failed` |
| `advanceSetup {accountId?, steps?, to?, reasonCode?}` | Move first sync on by ticks, or straight to a state |
| `setClock {now}` / `advanceClock {ms}` | Set the clock (`APLOS_NOW`) or move it; due timers fire in order on the way |
| `setOrdering {ordering}` | Where a command's frames land relative to its reply: `receiptFirst`, `frameFirst` or `together`, optionally `delayMs` apart on the clock |
| `replay {frames}` | Push frames exactly as given, stamped with the current state |
| `reset {reason}` | Void every window (`dbEpoch` and `restore` also start a new epoch) |
| `compactLog` | Raise the change-log floor to now, so older states get `cannotCalculateChanges` |
| `park {reasonCode, message, canRetry?}` / `unpark` | Park the engine (a `parked` host event) or bring it back |
| `hostEvent {event}` | Send any host event (`notify`, `badge`, `appearance`, `reminder`, `clock`, ...) |
| `draftChanged {draftId, conflict}` | Another device changed a draft (`Draft/changed`) |
| `deliverMail {accountId, threadId?, fromName, from, subject, body, lane?}` | New mail arrives |
| `rerank {threadId, lane?, importance?}` | A background re-rank, the case `holdIds` exists for |
| `setUsage {backgroundTokens}` | Today's background AI use; at the cap, background AI pauses until midnight |
| `snapshot` | The clock, `dbEpoch`, `seq`, log floor and open windows |

Control calls first release any reply or frame an ordering held back, so time never jumps past them.

## Switching to the real engine

The UI talks to an `EngineConnection` and nothing else. Which one is a single flag in the dev harness (proposed name
`APLOS_ENGINE=fixture|real`, read where the window's connection is made): `fixture` builds
`createFixtureEngine({scenario})`, `real` uses the engine's MessagePort. Screens, hooks and `api.*` calls do not change.
`ui-shell` flips it with the Integrator on days 11-13, once the real engine's conformance run is green.

## Conformance

`packages/contract/tests/conformance/` holds one suite (`suite.ts`) parameterised by a `ConformanceTarget`
(`target.ts`): envelopes and error types, every method on `demo`, window order, `holdIds`, coalescing, receipts before,
after and with frames, `Session/changes` and `cannotCalculateChanges`, `reset`, `Setup/status`, `Thread/act` on ids
and selectors, then `Operation/undo`. `fixture.test.ts` runs it against this package under `npm test -w
@aplos/contract`. The real engine adds `engine.test.ts` with `expected-fail.engine.json`; a listed test that starts
passing fails the run until it is taken off the list. `expected-fail.fixture.json` stays empty. `rules.test.ts`
enforces that the suite imports only the contract and Node's test tools, so there are no fixture-only assertions.

This package's own tests (`npm test -w @aplos/contract-fixture`) cover what only a stand-in has: scenarios, knobs,
determinism, the `empty` scenario and portability.

## Changing it

- A contract change (CONTRACT-CHANGE-PROPOSED, lane `eng-contract`) lands with its fixture handler and, where it adds
  behaviour, a conformance test, in the same PR. The handler table's type fails the typecheck until the fixture answers
  a new method.
- New scenarios and knobs are additive: add the name to `scenarios` or `ControlArgs`, implement it, test it here. UI
  lanes add UI scenarios by PR (plan 10 section 3).
- Behaviour that both engines must share goes in the conformance suite, never in this package's tests.
