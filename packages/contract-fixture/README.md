# @aplos/contract-fixture

The stand-in engine (plan 10 section 4.1, Phase 0 artifact F6). It answers the whole v1 contract of `@aplos/contract`
on in-memory data, behind the same `EngineConnection` the real engine's transports implement, so the UI can be built
from day 4 and switched to the real engine with one flag. It has no Node or Electron imports: it runs in Electron, the
browser preview and a plain test. It is test support. Nothing from it ships in the app, and its size never counts
against the engine's 400,000-byte budget.

```ts
import { createFixtureEngine } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';
import { createClient } from '@aplos/contract/client';

const engine = createFixtureEngine({ scenario: 'demo' });   // seed: 1, a fake clock at 2026-10-27 16:00 UTC
const session = engine.connect();
const { api, subscribe } = createClient(session);
const control = fixtureControl(session);

const home = await api.view.watch({ spec: { kind: 'home' } });
await api.thread.act({ opId: 'o1', ids: [home.ids[0]], action: { type: 'done' } });
await control.advanceClock({ ms: 250 });                    // frames due by then have arrived
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `scenario` | required | One of the scenarios below |
| `seed` | `1` | Same seed, same `dbEpoch`, tokens and ids |
| `clock` | fake, at `defaultNow` | A number starts a fake clock there (`APLOS_NOW`). `'real'` ticks with the wall clock, for the browser preview, where nobody advances time. A `FixtureClock` shares one clock between engines |
| `timeZone` | `America/Los_Angeles` | The zone that due bands, Later presets and demo events are computed in |
| `checkResults` | `true` | Every result passes the registry's `checkResult`, so a fixture bug fails loudly |

With the fake clock, time moves only through `control.advanceClock` or `control.setClock`. Timers, coalescing,
`progress` runs, sends and setup progress all wait for it.

## Verbs

Every engine method in the registry (118 at C1) is answered on `empty` and `demo`. `methods/index.ts` is typed against
the registry, so a new contract method fails the typecheck until it has a handler here. Arguments go through
`parseArgs` and replies through real `{id, ok, result | error}` envelopes, so errors arrive as `ContractError` with
their `type` and sentence, exactly as over a transport.

| Area | What the stand-in does |
|---|---|
| `Session/get`, `Session/changes` | Handshake with `hasAccounts`, the clock and capability flags. A change log with a floor. A state from another `dbEpoch`, below the floor, or from the future gets `cannotCalculateChanges` |
| `View/*` | An in-memory sort per spec (Home sections, Later groups, mailbox roles, labels, search with operators, the reader, events in at most 62 days, plans, conversations, Low senders). Windows push ID-only `window` frames at most 4 per second (every 250 ms) on the engine clock. A held row (`holdIds`, `View/hold`) stays at its index until it is released or 2 s pass with no activity, even after it leaves the view. `changed` lists rows whose `rev` moved. Home's Low band is a count-only section with up to three sender names. Its rows are not in `ids` (open `homeSection: low` or `lowSenders` for them) |
| Commands | Each one commits once (one `seq`) and returns `{opId, appliedState}`. A replayed `opId` answers the same reply and applies nothing. Provider-bound writes (`Thread/act`, events, rules) go `queued`, then `synced` 600 ms later as an `operation` frame. `Operation/undo` writes back the before-images as a new commit, so revisions still move forward |
| `Thread/act` | Every action. Done and Later follow `doneAction` and `laterAction`. A Later item whose date has arrived is Back from Later at the bottom of Do now |
| Mail | Bodies as plain text, `Mail/frame` tokens served by `Mail/serve`, attachments and the original as blobs, `Blob/*` up to 25 MB |
| `Draft/*`, `Submission/*` | Compare-and-set on `revision`. Sends go `queued` for `undoSendSeconds`, then `sending`, then `sent` 400 ms later (the reply joins its thread and the draft goes). `scheduled` with `notBefore`. Undo, send now, reschedule, send anyway and retry, each refused from the wrong state |
| Calendar | Calendars, the week's demo events, an invitation to answer, a plan to confirm. `following` scope is refused with a plain reason |
| AI | No request leaves the fixture, and it never holds a key (`Ai/setKey` keeps only the last four characters). `Ai/request` runs a job (queued, running, done) and writes a summary after about 1 s. `Ask/run` returns at once, then streams `progress` frames (step, step, text, text, done) and writes the answer with citations `{n, messageId, quote}` into the Conversation. Groq reads as configured "from the environment" unless the scenario is `ai-off` |
| `Account/*`, `Setup/*` | On any scenario, `Account/connect` creates a practice Google account: `connect` frames `waiting`, then `connected` 800 ms later. Its first sync then runs on the clock (connecting, finding, reading six threads a tick, sorting with consent, ready), and the demo mailbox lands in it. `reconnectBy` is grant time plus 7 days. `Setup/status` has the plan 10 shape |
| `Sync/request` | Refused while an account is paused, unless `force`, and also when offline or `needsReauth`. Otherwise the account shows `syncing`, then `ok` 500 ms later |
| `Demo/*` | Idempotent, and they touch only demo accounts. `empty` never seeds demo data |
| Admin | Queue inspector, content-free diagnostics, listener and client records, data export. All in memory |

Desktop methods (`Window/*`, `File/*` and the rest of `native`) belong to main, not the engine. The stand-in refuses them
with `unsupported`, as the real engine does. Route them with `routeByHost`.

## Scenarios

| Scenario | State at C1 |
|---|---|
| `empty` | No accounts, no demo, no consent. Groq is configured. Onboarding opens |
| `demo` | Aplos's own demo mailbox (`packages/engine/src/legacy/demo.ts`, adapted to v1): two demo accounts, 18 threads across every section and place, a draft, a follow-up nudge, six calendars, the week's events, an invitation and a plan. Consent is granted |
| `offline` | `demo`, with both accounts `offline` |
| `needs-reauth` | `demo`, with the work account at `needsReauth` (`auth.testingModeExpiry`) |
| `backfilling` | `demo`, with both accounts `backfilling` 120 of 2,400 |
| `rate-limited` | `demo`, with the work account paused for 60 s (`rate.minute`) |
| `partial-threads` | `demo`, with four rows `partial: true` until `Thread/open` |
| `send-uncertain`, `send-suspended` | `demo`, with the welcome draft's send in that state |
| `ai-off` | `demo`, with no Groq key, background AI off, no consent and no summaries |
| `ai-budget-spent` | `demo`, with today's background tokens at the cap and AI paused until midnight |
| `setup-partial` | `demo`, with the work account's first sync paused partway and errors listed |
| `parked` | `demo`, with the engine parked. Only `Session/get`, `Setup/status` and `Diagnostics/*` answer. Others get `unavailable`, and a `parked` host event arrives on connect |
| `small-10k`, `large-100k` | Throw "arrives in Phase 1". They share the seeded generator with `bench/store-bench.ts` (E2) |

## The control channel

`Fixture/control` is test-only. It is a call on the same session as every other method, so a harness can drive a
fixture behind a MessagePort or the preview's HTTP binding exactly as it drives one in-process. It is not in the
registry, the generated allowlists or OpenAPI (a test checks this), and a real engine refuses it with `unsupported`.
Use the typed client `fixtureControl(sessionOrConnection)` from `@aplos/contract-fixture/control`:

| Knob | What it forces |
|---|---|
| `setAccountStatus({accountId, status, reasonCode?, reconnectBy?})` | Any ARCH 6.4 status |
| `pauseAccount({accountId, forMs, class?, reason?, reasonCode?})` | A governor pause. Resumes by itself |
| `failNextWrite({mode?, type?, message?, reasonCode?, afterMs?})` | `afterReceipt` (default): the receipt arrives, then a `failed` `operation` frame, and the rows go back. `reject`: the call itself fails |
| `setSubmissionState({submissionId, state, problem?})`, `nextSendOutcome({outcome})` | Any state of the send machine |
| `advanceSetup({accountId?, steps?, to?, reasonCode?})` | First-sync progress |
| `setClock({now})`, `advanceClock({ms})` | The clock (`APLOS_NOW`). Due timers fire in order, and `setClock` sends the `clock` host event |
| `setOrdering({ordering: {mode, delayMs?}})` | Where a command's frames land relative to its reply: `receiptFirst` (reply, then frames a task later, the default), `frameFirst` (frames, then the reply a task later) or `together` (same task). `delayMs` puts that gap on the engine clock |
| `replay({frames})` | Push any frames, stamped with the current `{dbEpoch, seq}` |
| `reset({reason})` | Void every window with a `reset` frame. `dbEpoch` and `restore` also start a new epoch |
| `compactLog()` | Raise the change-log floor, so older states get `cannotCalculateChanges` |
| `park(...)`, `unpark()`, `hostEvent({event})` | The parked engine, and any host-channel event |
| `draftChanged({draftId, conflict})` | A `Draft/changed` frame from another window or device |
| `deliverMail({...})`, `rerank({...})`, `setUsage({...})` | New mail (with a `notify` host event), a background re-rank (the case `holdIds` exists for), the AI budget |
| `snapshot()` | The clock, epoch, seq, floor and open windows |

## Conformance

`packages/contract/tests/conformance/` holds one suite that any `EngineConnection` must pass (envelopes and error types,
every method on the demo data, window ordering, `holdIds`, coalescing, receipts in each ordering, `cannotCalculateChanges`,
`reset`, `Setup/status`, undo). `npm test -w @aplos/contract` runs it against this package. The suite imports only the
contract. Engines plug in through `ConformanceTarget` (`target.ts`): `advance(ms)`, plus the optional `compactLog`,
`reset` and `orderings`, and tests that need a missing ability are skipped. Each engine has
`expected-fail.<name>.json`. The stand-in's list is empty. The real engine adds `engine.test.ts` with a shrinking list,
and a listed test that starts passing fails the run until it is removed.

## Switching to the real engine

The renderer's `windows.ts` (plan 30 section 4.1, WP5.6, built by `ui-shell`) reads one flag. With it, `client.ts` connects to the fixture
(`createFixtureEngine(...).connect()` in-process, or the dev host serving it). Without it, `client.ts` uses the real
engine's MessagePort. Both are `EngineConnection`s and pass the same suite, so nothing else changes. `ui-shell` flips the
flag with the Integrator on days 11 to 13, once the real engine's conformance run is green.

## Changing it

The fixture follows the contract and never leads it. A contract change (CONTRACT-CHANGE-PROPOSED in `plans/STATUS.md`,
made by `eng-contract`) lands with its handler here in the same PR, and with a conformance test when it changes
behaviour. UI lanes add scenarios or knobs by PR to this package (plan 10 section 3 ownership). A knob may force a state
but never invent a behaviour the real engine will not have. Run `npm test -w @aplos/contract-fixture`,
`npm test -w @aplos/contract` and `npm run typecheck`.
