# Engine thread, Phase 1: the seven lanes as work packages

Written 2026-10-27 (day 1, for day 4 = 2026-10-30) on `rv/thread/engine-p1plan`, from Engine thread commit `2a71e7f` (every Phase 0 artifact, F1 to F8). This is the starting plan for each lane's Claude Code workflow (brief 1, section 9, step a). It turns plan 10 E2 to E7 into work packages and checks them against the code Phase 0 actually wrote. Where the code and the plan text differ, this file follows the code and says so.

## In plain English

From Friday (day 4) the Engine thread builds the real engine behind the rules that froze on day 3. It works in seven parallel lanes. Each lane is a small team of AI agents with its own folders.

- **The database lane** (`eng-store`) finishes the mail database. It has to land first, by day 6, because the Gmail work and the live lists are waiting on it.
- **The live-lists lane** (`eng-views`) makes the inbox lists update in place.
- **The clock lane** (`eng-time`) makes sending safe: undo, scheduled sends, reminders, and recovery after a crash, with no double sends.
- **The AI lane** (`eng-ai`) builds the AI queue, its daily budget, the "may I use your mail" consent, and sensible Home sorting with AI off.
- **The safety-frame lane** (`eng-html`) cleans each email and shows it in a sealed box that cannot track you.
- **The menu-bar lane** (`eng-host`) keeps Aplos running in the menu bar and opens the locked door for tools.
- **The rules lane** (`eng-contract`) wires all of these together. It also keeps the stand-in engine and the shared test suite.

Every work package below lists the files only it may touch, what "done" means, the test that proves it, which AI model does it, and one named attack a separate reviewer agent must try. Cheap free models do the simple, checkable work. Claude Opus does the risky parts (database, live lists, sending, the safety frame, the tool door) and every review.

By day 11 the real engine should pass the stand-in's shared test suite, so the screens can switch to it. You will see three features from this thread: menu-bar mode (around day 8), the email safety frame (around day 11) and sending with undo (around day 12). Nothing here needs a decision from you.

## Contents

0. Ground truth at the freeze
1. Rules every lane workflow follows
2. Seams decided at kickoff
3. `eng-contract`
4. `eng-store`
5. `eng-views`
6. `eng-time`
7. `eng-ai`
8. `eng-html`
9. `eng-host`
10. Conformance burn-down
11. Day-by-day schedule and peak agents
12. Requests to post on day 4
13. Decisions for you

## 0. Ground truth at the freeze

What Phase 0 built, read from the code at `2a71e7f`, and what each fact changes in plan 10's lane content.

| Fact in the code | Where | Consequence for Phase 1 |
|---|---|---|
| `store.commit` is already more than "minimal". It has date-ordered ids with second carry, rollups recomputed from messages, `thread_folders`, the mutation fence (`local_seq`), coarse `*` rows, the bounded generation sweep, idempotent `opId` replay (`commits` table), and `changesSince` that refuses seqs below the floor. Tests: `commit.test.ts`, `sweep.test.ts`, `migrate.test.ts`. | `packages/engine/src/store/commit.ts` (697 lines), `index.ts` | Most of plan 10 WP2.1 is done. `eng-store`'s day-6 slice is narrower: compaction, the replay property proof, extension points for the other lanes' tables, the `laneFor` hook, correspondents and `KnownLookup`. |
| The `StoreWrite` union covers accounts, folders, messages, placements, flags, threads, workflow, sync state, sweep and meta only. Bodies, attachments, drafts, submissions, jobs, consent, notifications, ops, summaries, sender rules, settings, clients and audit have no write kind. | `store/port.ts` | Every lane except `eng-html` writes a table `commit` cannot write today. Seam 2 (section 2) settles how. It is the first thing `eng-store` ships. |
| No compression or file port exists. The schema has `bodies.codec` (0 raw, 1 zstd-3, 2 gzip) and `attachments.state`, but the neutral engine cannot call `node:zlib` or `node:fs`. | `store/migrations/0001_initial.ts:67`, `ports/*.ts` | `eng-store` adds a synchronous `BodyCodec` and an `AttachmentFiles` port in `store/port.ts` (its own file, additive), implemented in the host. The host file paths need an owner (section 2, seam 4). |
| `MethodContext` holds only `{caller, signal}`. No engine runtime exists: nothing composes the store, clock, logger and lane services, and `packages/engine/src/runtime/` and `src/index.ts` do not exist. | `methods/types.ts` | Seam 1: `eng-contract` builds the runtime on day 4, before any lane can serve a real call. |
| Main still runs today's engine. `engine-process.ts` starts the legacy `createService`; `engine-host.ts` keeps the `latestState` mirror. | `apps/desktop/src/main/engine-{process,host}.ts` | The real engine is reachable in Electron only after `contract-4` (behind `APLOS_ENGINE=real`). `eng-host`'s day-7 resident check proves main's residency on today's engine and is re-run on the real engine after the switch (days 11 to 13). |
| The contract has 147 methods: 121 engine methods in 29 area files, and 26 desktop methods served by main. The engine core imports contract types only; transports validate with `parseArgs` (DECIDED 19:00). | `packages/contract/src/api/*.ts`, `methods/*.ts` | Handlers receive already-validated input and must not import zod. Anything that needs a runtime schema check (the diagnostics bundle) is checked at the host boundary with the registry's `checkResult`. |
| OpenAPI is already generated by `npm run generate -w @aplos/contract`. | `packages/contract/generated/openapi.json` | E7 item 5 shrinks to a golden test and a wire-rule lint. Both live under `packages/contract/**`, so they move from `eng-host` to `eng-contract` (`contract-6`). |
| The conformance suite has one `method/<Name>` check per engine method (121), plus 25 scenario checks: `envelope/*` (5), `methods/coverage`, `session/handshake`, `frames/stamped-and-ordered`, `window/*` (6), `receipts/natural-order`, `receipts/{receiptFirst,frameFirst,together}` (skipped on an engine without `orderings`), `changes/{catch-up,foreign-epoch,below-floor}`, `reset/void-windows`, `setup/status-shape`, `act/selector`, `undo/restores-thread`. The suite discovers every id through the contract, starting from `Account/get` and `Session/get`. | `packages/contract/tests/conformance/{suite,samples,target}.ts` | The real engine's starting expected-fail list is about 140 ids. 25 of the 121 methods belong to Providers lanes (`account`, `sync`, `workflow`, `unsubscribe`, `event` areas). `Account/get` (`prov-gov`) gates most samples (section 10). |
| The fixture's demo data may not be imported by `packages/engine` (README rule). | `packages/contract-fixture/README.md` | The real engine needs its own original demo data (`ai-2`, `Demo/load`) before the conformance runner can do anything useful. That puts `ai-2` on the day-11 path. |
| The platform freeze security review (STATUS 22:11) raised S1 to S14 against the contract. None is closed in this tree. | `rv/plat-release/freeze-review:plans/platform/freeze-security-review.md` | Any still open at FROZEN becomes a named check in the owning work package below (marked "carry-over"). |
| No Playwright config exists in this tree yet (plat-ci owns `tests/e2e/playwright.config.ts`). | repo root | `html-2`'s leak harness and every headless capture wait on plat-ci's base. Until then they use `_electron.launch` from a lane test file with `APLOS_TEST=1`. |

> **What this means:** Phase 0 delivered more of the database than planned, but nothing yet ties the engine's parts together. Day 4 starts with that wiring, so every lane can plug in.

## 1. Rules every lane workflow follows

**Workflow shape (brief 1, section 9).** For each work package (WP): (a) this plan is the plan; (b) one implementer per WP, each in its own worktree on `rv/<lane>/<wp-slug>`, merging into the lane branch; (c) an adversarial reviewer, a different agent given the code and the "Done" and "Check" lines but not the author's reasoning, tries to break the named check; (d) a verifier runs the WP's test command, `npm run typecheck`, the portability test and, where the WP flips conformance ids, the real-engine conformance run; (e) fix, re-verify, then the PR. Read `origin/revamp:plans/STATUS.md` before each WP and each PR.

**Model tiers (roadmap 5.1a).** Free means OpenCode Zen free models (`opencode/glm-5.3-flash-free`, `opencode/deepseek-v4.1-flash-free`, `opencode/mimo-v2.6-flash-free`, `opencode/beam-free`, `opencode/flint-40b-free`; never `nemotron-3-ultra-free`). Free models see code and demo data only, never keys, `.env` or test-account mail. Their output counts only after the tests run and a Claude agent reviews the diff. If a free model fails twice or stalls for 10 minutes, move up a tier. Grok through Cursor is tried for well-scoped coding; on "usage limit" or "unavailable on Free", fall through without retrying. Sonnet does scoped features. **Opus** does the contract and runtime, the store, views, outbox and send safety, the sanitizer, the frame pipeline, the image proxy, the doorway, and **every adversarial review**. Test runs and their summaries go to the free tier in every lane.

**Every WP's verify step also runs:** `npm run typecheck` and `npx tsx --test packages/engine/tests/portability.test.ts`. A WP that adds neutral-engine code records its bundle bytes (esbuild `bundle:true, platform:'neutral', format:'esm'`, unminified and minified) against the engine budget (450,000 minified bytes since 2026-11-03; it was 400,000 before, see DECISIONS.md).

**Test commands** use quoted globs, which Node 24's runner expands: `npx tsx --test 'packages/engine/tests/views/**/*.test.ts'`. The real-engine conformance run is `npx tsx --test packages/contract/tests/conformance/engine.test.ts` (from `contract-2`).

**Where tests live.** Inside the lane's paths: `packages/engine/tests/<folder>/**` beside the code's folder (`store`, `views`, `clock`, `outbox`, `ai`, `runtime`), `packages/mail-html/tests/**`, or `apps/desktop/tests/<lane>/**`.

**PRs.** One WP per PR, ideally under 500 changed lines without generated files. `eng-contract`, `eng-store` and `eng-views` PRs are dependency PRs that the Integrator merges. Feature lanes (`eng-time`, `eng-html`, `eng-host`, and `eng-ai` as a contributor) merge dependency WPs the same way and keep owner-visible work on the feature branch until approval (section 14 of the brief).

**Throttle order under a Claude usage limit.** Pause in this order and shift queued low-judgment work to the free tier: `host-7` and `host-8`, `contract-7`, `contract-8`, `ai-6`, `ai-7`, `html-2` bulk variants, `store-7`. Never pause `contract-1`, `store-1`, `store-2`, `views-1` to `views-3`, `time-2`, `html-3`, `html-4` or `host-4`.

> **What this means:** Each piece of work has its own files, a clear finish line, a test and a named attack. Free models do the checkable chores, and Claude does the risky parts and every review.

## 2. Seams decided at kickoff

Four cross-lane seams have to exist before lanes can work in disjoint files. The Engine thread decides them in the day-4 kickoff, as proposed here.

**Seam 1: the engine runtime and lane modules (`contract-1`, day 4).** `packages/engine/src/runtime/services.ts` declares `interface EngineServices { store; clock; deadlines; log; frames; keys; settings; actors?; mailHtml? }`. Each lane extends it from its own `module.ts` by TypeScript declaration merging (`declare module '../runtime/services' { interface EngineServices { views: ViewEngine } }`) and exports `createModule(services)`. `MethodContext` gains `engine: EngineServices`. `packages/engine/src/index.ts` (the composition root, `eng-contract`) imports the four lane modules from fixed paths: `views/module.ts`, `clock/module.ts`, `outbox/module.ts`, `ai/module.ts`. `contract-1` creates those four files as empty stubs in one cross-lane PR, with each owning lane's written approval on the PR. Everyone is in this thread, so approval is immediate. After that, no lane needs `eng-contract` to wire anything. Hosts inject `MailHtml`, `KeyProvider`, the codec and file ports and the actor host when they build the engine.

**Seam 2: commit extensions (`store-2`, types by day 5, working by day 6).** `store.commit` stays the only write path. `store/port.ts` gains `CommitExtension { kinds: string[]; apply(tx, write, run): Change[] }` and in-transaction `IngestHooks` (`laneFor` on message ingest, a notification hook, correspondents). Lanes register them when the store opens (`openStore({extensions})`). Each lane writes its own tables from its own files (`outbox/store.ts`, `ai/store.ts`, `views/ops.ts`, `runtime/settings.ts`, the `clients` writer in `methods/clients.ts`) inside the same transaction, `changes` rows and one `seq` bump included. This keeps ARCH 3.7's single writer while files stay disjoint. The write union grows only by registration, so `CommitInput` does not change.

**Seam 3: expected-fail list edits.** The suite fails a test that passes while still listed, so a lane PR that makes an id pass must remove it from `packages/contract/tests/conformance/expected-fail.engine.json` (an `eng-contract` path). Proposal: `eng-contract` posts a standing written approval (DECIDED in STATUS.md on day 4) for **removal-only** edits to that file by any engine lane. Additions need `eng-contract`'s review, and the list may only shrink (brief 1, section 10).

**Seam 4: ownership gaps.** These paths are touched by Phase 0 or by this plan, but `plans/OWNERS.md` does not list them. Post one REQUEST to the integrator on day 4:

| Path | Proposed lane | Why |
|---|---|---|
| `packages/engine/src/ports/**` (OWNERS lists only `ports.ts`) | `eng-contract` | F3's port files; additive port changes go through `eng-contract` |
| `packages/engine/src/methods/types.ts` | `eng-contract` | `MethodContext` (seam 1) |
| `packages/engine/src/ports.walk.md`, `ports.review-answers.md` | `eng-contract` | F3 records |
| `apps/desktop/src/main/test-mode.ts` | `eng-host` | F8; read by lifecycle and windows |
| `apps/desktop/scripts/verify-resident.mjs` | `eng-host` | E1 item 4's packaged check |
| `apps/desktop/src/host/{codec,files}.ts` | `eng-store` | the host halves of the body codec and attachment files |
| `apps/desktop/src/host/transports/auth.ts` | `eng-host` | the token hash and compare shared by socket and HTTP |
| `packages/mail-html/` as a new workspace | integrator creates it, then `eng-html` owns `packages/mail-html/**` | OWNERS: new workspaces are the integrator's |

> **What this means:** Four small agreements on day 4 let seven teams work at once without editing each other's files.

## 3. `eng-contract`

**Scope.** Wires the real engine together (runtime, dispatch with scope checks, frames, Session, Settings, Blob), runs the real-engine conformance burn-down, and moves the transport to direct MessagePorts with main out of the data path. It also deepens the stand-in engine, builds the preview host and answers contract changes.

**Owned paths (OWNERS.md):** `packages/contract/**`, `packages/contract-fixture/**`, `packages/engine/package.json`, `packages/engine/tsconfig*.json`, `packages/engine/src/runtime/**`, `packages/engine/src/ports.ts`, `packages/engine/src/methods/index.ts`, `packages/engine/src/methods/{session,settings,blob}.ts`, `packages/engine/src/diag/**` (except `diag/bundle/**`), `packages/engine/src/index.ts`, `apps/desktop/src/host/transports/port.ts`, `apps/desktop/src/host/logsink.ts`, `apps/desktop/src/main/{engine-host,engine-process,server,preload}.ts`, `apps/desktop/scripts/codemod-imports.mjs`, `packages/engine/tests/portability.test.ts`, `apps/desktop/src/shared/**`. Plus the seam-4 additions.

**Needs.** Nothing to start. `store-2`'s extension API by day 6 (settings writes), `time-1`'s fake clock by day 6 (the runner's `advance`), `ai-2`'s `Demo/load` by day 6 (the runner's data), `host-4`'s listener by day 11 (the preview swap). From other threads: plat-ci for the Vite dev-proxy token (`apps/desktop/vite.config.ts`) by day 8, and ui-shell on the client runtime split by day 5.

**Feeds.** Every lane (the runtime, day 4 to 5), `ui-shell` (the `APLOS_ENGINE` flag and the MessagePort path, day 10), the Integrator (the burn-down count, daily).

### Work packages

**contract-1 · Runtime seam and scoped dispatch.** Opus · day 4 · first, serial, blocks every lane's handler wiring.
- Files: `packages/engine/src/runtime/{engine,services,frames,connection}.ts`, `packages/engine/src/index.ts`, `packages/engine/src/methods/types.ts` (seam 4), the four stub `module.ts` files of seam 1 (one-time, with written approval), `packages/engine/tests/runtime/*.test.ts`.
- Done: `createEngine({store, clock, log, keys, randomBytes, ...})` returns an in-process `EngineConnection` (`connect(): {call, subscribe, close}`), the same interface the fixture implements. Dispatch passes `MethodContext {caller, signal, engine}` and refuses a method whose registry scope the caller lacks (carry-over S8). A frame bus stamps every frame with `{dbEpoch, seq}`, coalesces `state` over 50 to 250 ms and emits `reset {reason}`. `progress` frames are ephemeral and never logged. A handler's non-`ContractError` throw becomes a classified internal error with no stack and no provider text. Engine bundle bytes recorded.
- Check, "caller bypass": a `read` caller reaches a `triage`, `send` or `admin` method through any entry (dispatch, a batched call, `Operation/retry` re-dispatch); a frame leaves without `{dbEpoch, seq}`; an internal error leaks a stack or a raw provider message.
- Test: `npx tsx --test 'packages/engine/tests/runtime/**/*.test.ts' packages/engine/tests/methods.test.ts`

**contract-2 · Real-engine conformance runner and burn-down.** Sonnet (Free for runs) · days 4-5 · parallel with contract-1 and lands after it.
- Files: `packages/contract/tests/conformance/engine.test.ts`, `packages/contract/tests/conformance/expected-fail.engine.json`, `packages/contract/scripts/burndown.ts`.
- Done: the runner builds `createEngine` over an in-memory `node:sqlite` store (the runner may import Node; the suite may not, per `rules.test.ts`), loads demo data through `Demo/load` once `ai-2` lands (a seeded `store.commit` until then), and implements `advance` on the injected fake clock, `compactLog` via `store.compact` and `reset`. The first expected-fail list is the exact set failing on day 5. `burndown.ts` prints remaining ids per lane (method, area file, OWNERS lane) for the Integrator's daily digest. Seam 3's DECIDED entry is posted.
- Check, "no fixture-only path": the reviewer confirms the runner uses only `EngineUnderTest` abilities, no assertion differs between `fixture.test.ts` and `engine.test.ts`, and a deliberately broken handler turns its id red rather than being silently expected.
- Test: `npx tsx --test packages/contract/tests/conformance/engine.test.ts packages/contract/tests/conformance/fixture.test.ts packages/contract/tests/conformance/rules.test.ts`

**contract-3 · Session, Settings, Blob and change tokens.** Opus · days 5-6 · after contract-1, uses store-2's extension API from day 6.
- Files: `packages/engine/src/methods/{session,settings,blob}.ts`, `packages/engine/src/runtime/{settings,blobs,tokens}.ts`, `packages/engine/tests/runtime/{session,settings,blobs}.test.ts`.
- Done: `Session/get` returns `{apiVersion, appVersion, schemaVersion, dbEpoch, capabilities, hasAccounts, now, setup}`. `Session/changes` maps `store.changesSince` to `{oldState, newState, hasMore, upserted, destroyed}`, and to `cannotCalculateChanges` below the floor or for a foreign `dbEpoch`. Opaque `{dbEpoch, seq}` tokens carry an HMAC for network clients (E2 item 5). `Settings/get|set` keeps one JSON document in `settings` through a registered commit extension, merges sections one level deep and honours `ifInState`. Blob handles are bound to their principal (`principalOf` in `@aplos/contract/access`: every window and main are one principal, the app; each listener client is its own), never to a session, with a size cap; a blob referenced by a draft or a live submission survives until that submission settles and is never released on disconnect (freeze R2B-6, FR-7).
- Check, "foreign state": a token from another `dbEpoch`, a forged or replayed HMAC token, a seq below the floor, and a blob id used by another principal must each give the contract's error, never data; a held send's attachment survives every window and tool disconnecting.
- Test: `npx tsx --test 'packages/engine/tests/runtime/**/*.test.ts'` plus the conformance run.

**contract-4 · Direct MessagePort, main out of the data path.** Opus · days 7-10 · after contract-1 and contract-3.
- Files: `apps/desktop/src/host/transports/port.ts`, `apps/desktop/src/main/{engine-host,engine-process,preload}.ts`, `apps/desktop/tests/eng-contract/{port,payload,real-path}.test.ts`.
- Done: behind `APLOS_ENGINE=real` (legacy stays the default until the switch on days 11 to 13), main creates a `MessageChannelMain` per window, transfers one end to the engine utility process and one through preload. Preload checks the generated allowlist, and ports go only to a window's trusted main frame (`assertCaller`). Binary moves as transferable `ArrayBuffer`. Main keeps native methods and receives typed host-channel events (`notify`, `badge`, `appearance`, `openExternal`, `reminder`). `window.compose` validates through main's own engine connection (`Draft/get`). On the real path there is no `latestState`: the grep test covers the real-path modules now and all of `src/main` once Phase 2 deletes the legacy code. A payload test fails on any engine-to-renderer message over 256 KB outside blob routes. Killing the engine reconnects windows on the same `dbEpoch` with no re-snapshot, and a second window gets its own port.
- Check, "port hijack" (plan 10 E3 (c)): get a port from a mail frame, a devtools page or another origin; make a closed window's port keep receiving frames.
- Test: `npx tsx --test 'apps/desktop/tests/eng-contract/**/*.test.ts'`, plus one headless `APLOS_TEST=1 APLOS_ENGINE=real` launch by exec'ing the binary (never `open`).

**contract-5 · Stand-in scenarios, knobs and the shared generator.** Free (data) plus Sonnet (knobs) · days 4-8 · independent.
- Files: `packages/contract-fixture/src/**`, `packages/contract-fixture/tests/**`, `packages/contract-fixture/README.md`.
- Done: `small-10k` and `large-100k` from a seeded generator in `src/data/generate.ts`, which `store-7`'s bench imports (shared source, plan 10 E2), ready by day 7. UI-screens' 22:07 proposal is answered item by item: knobs `setFound`, `failSetupPhase`, `capAi`, `resolveConnect`, `setReconnectBy`, `queueLocalOps`, `calendarChange`, `ask.script`, `ai.failNext`, `search.remote.result|failNext`, `transcribe.result`, a call log; scenarios `reconnect-due`, `empty-skipped`, `calendar-dense`, `ask-scripted`, `today-busy`, `ai-env-groq`, `two-accounts`. Each lands or is rejected with a reason in the PR, recorded as CONTRACT-CHANGE-DONE because the knobs freeze with F6.
- Check, "fixture drift": a new knob makes the fixture behave in a way the real engine cannot express through the contract, or a scenario fails `checkResults`; the fixture still passes the whole suite on `demo`.
- Test: `npx tsx --test 'packages/contract-fixture/tests/**/*.test.ts' packages/contract/tests/conformance/fixture.test.ts`

**contract-6 · OpenAPI golden test and wire-rule lint.** Free plus Sonnet review · day 8 · independent (moved from E7 item 5, see section 0).
- Files: `packages/contract/tests/{openapi-golden,wire-lint}.test.ts`.
- Done: `generated/openapi.json` is compared with a regenerated copy; a deliberate breaking change turns it red. The lint walks every schema for ARCH 9.3: discriminated unions of named objects, no tuples, no `Date`, `Map`, `Set` or `BigInt`, no transforms or data-changing defaults, open string enums where a newer engine may extend.
- Check, "planted violation": the reviewer plants a tuple, a transform, a closed enum on an extensible field and a `Date`, and each must fail.
- Test: `npx tsx --test packages/contract/tests/openapi-golden.test.ts packages/contract/tests/wire-lint.test.ts`

**contract-7 · Preview host with a per-run token.** Sonnet, Opus review · days 9-10, swap on day 12 · the swap waits on host-4.
- Files: `apps/desktop/src/main/server.ts`, `apps/desktop/tests/eng-contract/preview.test.ts`.
- Done: `server.ts` is a thin host serving the fixture or the real engine through the registry. It requires a random per-run token that the Vite dev proxy adds server-side (REQUEST to plat-ci for `vite.config.ts`). The token sits in a 0600 file and never reaches the browser. On day 12 it moves onto `host-4`'s hardened loopback listener (E7 item 7). The preview keeps its own data directory.
- Check, "token exposure": a headless browser finds the token in the page, console or network log, or gets an answer without it.
- Test: `npx tsx --test apps/desktop/tests/eng-contract/preview.test.ts`

**contract-8 · Client runtime (row cache, window store, resume).** Opus · days 6-8 · scope set with ui-shell on day 5.
- Files: `packages/contract/src/client/{connection,rows,windows}.ts`, `packages/contract/tests/client/*.test.ts`.
- Done: E3 item 7. The connection resumes with `since` (and `Last-Event-ID` over HTTP). A row cache fetches only unknown or stale rows with `Thread/get`, and a `WindowStore` applies ID-only window frames. The receipt overlay is dropped once a window reaches `appliedState`. If F9's `renderer/data` already holds the row cache, this WP shrinks to the connection's resume and reconnect, and the decision is recorded in STATUS.md.
- Check, "stale overlay" (shared with views-3): random interleavings of receipts and frames against a model; the client shows a state the engine never had, or keeps an overlay after the window reached its state.
- Test: `npx tsx --test 'packages/contract/tests/client/**/*.test.ts'`

**Standing duty · Contract-change desk.** Opus on demand · days 4-13 (not a work package). Each CONTRACT-CHANGE-PROPOSED is answered within half a day. Accepted changes are small additive PRs reviewed by an agent that did not write them, labelled `contract-change`, merged by the Integrator, then CONTRACT-CHANGE-DONE and a DECISIONS.md line. Expected requests: new `ChangeType` names (`Draft`, `Submission`, `Job`), the store's codec and file ports re-exported from `ports.ts`, and any still-open S1 to S14 items (S1 and S3 `Plan/confirm` and `Ask/decide` scopes, S2 admin clients and consent or settings redirection, S9 and S12 a token field in the hello).

**Order.** contract-1 → contract-3 → contract-4 on the Opus track. contract-2 → contract-8 → contract-7 on the second track. contract-5 and contract-6 run beside them on the free tier.

### Methods and conformance ids

Implements `core.ts`'s `Session/get`, `Session/changes`, `Settings/get`, `Settings/set` and `mail.ts`'s `Blob/put`, `Blob/get`, `Blob/release` (7 `method/*` ids). Flips `envelope/unknown-method`, `envelope/desktop-method`, `envelope/validation` (contract-1); `session/handshake`, `changes/catch-up`, `changes/foreign-epoch` (contract-3); `changes/below-floor` (contract-3 with store-1's compaction); `frames/stamped-and-ordered` (contract-1 with views-2); `reset/void-windows` (with views-2).

### Owner review

None (dependency lane). Gated by the conformance suite, adversarial reviews and the Integrator.

### Risks and cuts

contract-1 late means every lane's handlers wait. Mitigation: it is the first agent started on day 4, scoped to the seam only; handlers are coded against `EngineServices` types from the stub PR even before it merges. contract-8 may be absorbed by ui-shell. contract-7's swap onto the hardened listener moves to Phase 2 if host-4 slips. Nothing in this lane is on the brief's cut list.

> **What this means:** This lane plugs every part of the engine into one place, checks who is allowed to call what, and keeps score of how close the real engine is to the stand-in.

## 4. `eng-store`

**Scope.** Finishes the real `store.commit` (extension points, `laneFor` hook, correspondents, compaction, a property proof) by day 6. Then bodies and attachments, paced full-text search and retention by day 9, and the importer and benchmark by day 10.

**Owned paths (OWNERS.md):** `packages/engine/src/store/**` (including `store/migrations/**` and `store/import/**`), `packages/engine/src/methods/data.ts`, `packages/engine/bench/**`, `apps/desktop/src/host/sqlite.ts`, `apps/desktop/scripts/{mailbox-benchmark.ts,verify-large-mailbox.mjs}`. Plus seam 4's `apps/desktop/src/host/{codec,files}.ts`.

**Needs.** Nothing to start (F4 is in the tree). The `LaneFor` type (frozen, F3) now, with `ai-1`'s real `ai/lanes.ts` injected from day 7 (a stub returning `{lane:'update', importance:'normal'}` until then). `contract-5`'s generator by day 7 (store-7). `prov-gov`'s review of the legacy-op mapping by day 9 (store-6a). Seam 4's host paths by day 6.

**Feeds (critical path).** Real commit, ids and change log by **day 6** to `prov-gmail`, `eng-views`, `eng-time`, `eng-ai` and `contract-3`. Body storage by day 7, with the full milestone "bodies, search and retention" by **day 9**, to `eng-html` and `prov-gov`'s `openThread`. Importer by **day 10**. A slip is posted as SLIP the same day.

### Work packages

**store-1 · Commit proof and compaction.** Opus · days 4-5 · parallel with store-2.
- Files: `packages/engine/src/store/compact.ts`, `packages/engine/tests/store/property/{replay,rollups}.test.ts`, `packages/engine/tests/store/compact.test.ts`.
- Done: `compactChanges(db, {maxRows: 50_000, maxAgeMs: 30 days, now})` raises `change_floor_seq` and deletes below it, in one transaction. Replay property test: a seeded generator (seed printed on failure) applies upserts, deletes, label moves, flags, sweeps, coarse pages and compaction and asserts `snapshot(seq0) + changes == snapshot(seqN)` over 1,000 sequences, including the below-floor case. Rollup property test: out-of-order batches against an independent slow reference query (counts, unread, `thread_folders`, D8's trashed reply, drafts excluded). Restart keeps `dbEpoch`, and `changesSince` from the old token returns only the delta.
- Check, "out-of-order rollups" (plan 10 E2 (b)): the reviewer feeds batches in adversarial orders (reply before parent, delete before insert, a label move racing a sweep) and finds a rollup that differs from the slow reference.
- Test: `npx tsx --test 'packages/engine/tests/store/**/*.test.ts'`

**store-2 · Commit extensions, ingest hooks, correspondents, `KnownLookup`.** Opus · days 4-6 · types published day 5, merged day 6.
- Files: `packages/engine/src/store/{port,commit,index,extend,correspondents,known}.ts`, `packages/engine/tests/store/{extend,known,hooks}.test.ts`.
- Done: seam 2. `CommitExtension` and `IngestHooks` are in `port.ts`, applied inside the commit transaction. The `BodyWrite` and `AttachmentWrite` kinds and the `BodyCodec` and `AttachmentFiles` port types are declared on day 5 so `prov-gov` and store-3 can code against them. `laneFor` runs on message ingest and after a body arrives, stores `rank_source='heuristic'` and never overrides `rule` or `user`. A notification hook point exists for `eng-time` (time-5). `correspondents` counts sent-to and received-from inside the commit. `KnownLookup` (F3, `provider.ts:313`) is implemented read-only over `StorePort`. `StorePort.compact()` is wired to store-1's function.
- Check, "write outside the transaction" (plan 10 E2 (c)): the reviewer reads `commit.ts` and `extend.ts` for any write outside `transaction()`; a test makes an extension throw mid-commit and asserts no row, no `changes` row and no `seq` bump persisted; an extension that writes `changes` for another lane's type is refused.
- Test: `npx tsx --test 'packages/engine/tests/store/**/*.test.ts'`

**store-3 · Bodies and attachments.** Sonnet, Opus review · days 6-7 · after store-2.
- Files: `packages/engine/src/store/{bodies,attachments}.ts`, `apps/desktop/src/host/{codec,files}.ts` (seam 4), `packages/engine/tests/store/bodies.test.ts`, `apps/desktop/tests/eng-store/codec.test.ts`.
- Done: ARCH 3.3. One record `{text, html, cidMap, quotedRanges}` of the provider's original content, codec 1 zstd-3 with a runtime probe falling back to 2 gzip (zstd is experimental in Node 24), 0 raw for tiny bodies. Encoding is synchronous in the host, so the commit stays synchronous. Attachments are files under `attachments/.noindex/` with `state` absent, fetching, present or evicted, never base64 in a row or over IPC. `messages.parts` bits are kept true.
- Check, "base64 creep": a 5 MB attachment and an inline-base64 legacy part; the reviewer finds any string column, log line or IPC payload carrying the bytes, or a body that does not round-trip under each codec.
- Test: `npx tsx --test packages/engine/tests/store/bodies.test.ts apps/desktop/tests/eng-store/codec.test.ts`

**store-4 · Paced FTS and local search.** Sonnet, Opus review · day 8 · after store-3.
- Files: `packages/engine/src/store/{fts,search}.ts`, `packages/engine/tests/store/{fts,search}.test.ts`.
- Done: an idle loop indexes 100 messages per batch from `messages_unindexed` (the `fts` bit, so the backlog is free and restart-proof), body capped at 16 KB, FTS rows inserted last in each transaction. It pauses while a sync commit or an interactive call is in flight (a `busy()` signal from the runtime). Deletes remove FTS rows (`contentless_delete`). `search(q, {accountId, limit})` returns newest first by `rowid DESC`, for `eng-views`' `search:<q>` spec.
- Check, "FTS starvation": the reviewer runs the loop against a storm of 500-message sync commits and shows either sync latency regressing past the bench budget or the backlog never draining; a deleted message still matches.
- Test: `npx tsx --test packages/engine/tests/store/fts.test.ts packages/engine/tests/store/search.test.ts`

**store-5 · Retention and WAL supervisor.** Sonnet, Opus review · day 9 · after store-4.
- Files: `packages/engine/src/store/{retention,wal}.ts`, `packages/engine/tests/store/retention.test.ts`.
- Done: ARCH 3.6. Bodies kept 90 days plus anything opened, starred or unread, a 2 GB cap evicted by `last_read_at`, never while any actor reports `backfilling`, then paced `incremental_vacuum`. An evicted body refetches through a stub `ProviderPort`. The WAL is checkpointed when idle and flagged over 256 MB. Retention reads its numbers from `Settings`.
- Check, "evict the wrong body": the reviewer gets an unread, starred or recently opened body evicted, or any eviction during backfill.
- Test: `npx tsx --test packages/engine/tests/store/retention.test.ts`

**store-6a · Importer: accounts, settings, drafts to submissions, ops, cursors.** Opus · days 7-10 · after store-2 · parallel with store-6b.
- Files: `packages/engine/src/store/import/{index,accounts,drafts,ops,cursors,report}.ts`, `packages/engine/tests/store/import/{drafts,ops,resume}.test.ts`.
- Done: plan 10 "The import". `aplos.db` opened read-only through `host/sqlite.ts` (`readOnly`). A draft with `pendingSendAt` becomes a `queued` submission with `not_before`; one with `sendAttemptAt` and a `messageId` and no confirmation becomes `uncertain` and queues a Sent check (never re-sent). Pending `ops` translate to native ops, and untranslatable ones are counted in the content-free report. `sync_cursors` become `sync_state(scope='history', phase='needs_reconcile')` with `generation` bumped. One transaction per table family, then per 500 threads, with `meta.import_state`, so a kill resumes. `meta.imported_from`, `import_done` and a fresh `dbEpoch` are written at the end. A fresh install or an empty store creates zero accounts (E5 item 7).
- Check, "corrupt input" (plan 10 E2 (a)): missing messages, duplicate ids, 3,000-message threads, dangling labels, 1970 and 2099 dates and a draft mid-send each give a clean import or a clear error, never a crash, a silent loss or a re-send.
- Test: `npx tsx --test 'packages/engine/tests/store/import/**/*.test.ts'`

**store-6b · Importer: threads, messages, bodies, attachments, workflow, summaries, events.** Sonnet, Opus review · days 7-10 · parallel with store-6a.
- Files: `packages/engine/src/store/import/{threads,bodies,workflow,events}.ts`, `packages/engine/tests/store/import/{threads,edge,kill,rollback}.test.ts`, `packages/engine/tests/store/import/fixtures/{make-legacy,legacy-store}.ts`.
- Done: threads, messages, `message_folders`, `thread_folders`, bodies, attachments (inline base64 written to files, `state='present'`), `thread_workflow` (importance to `lane` and `importance`, then re-checked by `laneFor`), `summaries` (`input_hash` from message ids and text hash), events best-effort. Messages without a provider id use `remote_id` = the legacy id, `origin='local'`. Kill-mid-import at 20 seeded points in a 50,000-thread legacy fixture resumes to the same counts and content hash. Rollback drill: the untouched `aplos.db` opens with a frozen copy of main's `createMailStore` and `load()` equals the original.
- Check, "kill and resume": the reviewer kills the import child between any two units and finds a duplicate row, a missing thread or a changed content hash.
- Test: `npx tsx --test 'packages/engine/tests/store/import/**/*.test.ts'`

**store-7 · Benchmark and gate (with `Data/export`).** Sonnet (Free for runs and summaries) · days 9-10 · needs contract-5's generator.
- Files: `packages/engine/bench/{store-bench.ts,README.md,gate.test.ts}`, `apps/desktop/scripts/mailbox-benchmark.ts`, `packages/engine/src/methods/data.ts`, `packages/engine/tests/store/data-export.test.ts`.
- Done: 50,000 threads and 200,000 messages written through `store.commit`. The E2 targets are measured on the owner's Mac (first 50-row page p50 under 1 ms; all unread counts under 10 ms; label-change commit p50 under 1 ms; page commits with FTS deferred at least 3,000 msgs/s, recalibrated on first run; cold open to first rows under 50 ms in a new process; RSS after first page under 120 MB; local newest-50 search under 5 ms). Numbers go to PROGRESS.md, calibrated targets to DECISIONS.md, and the CI gate sits at 3x margin. `EXPLAIN QUERY PLAN` is asserted for each view query views-1 hands over. `Data/export` writes a blob with accounts, settings, workflow, drafts and conversations, never credentials, for a `uiOnly` `admin` caller only.
- Check, "benchmark honesty": the reviewer shows a number measured by bypassing `store.commit`, a warm cache passed off as cold open, or a view query doing a full scan; `Data/export` answers a `read` or listener caller (carry-over S5).
- Test: `npx tsx packages/engine/bench/store-bench.ts --threads 50000` and `npx tsx --test packages/engine/bench/gate.test.ts packages/engine/tests/store/data-export.test.ts`

**Order.** store-1 ∥ store-2 (days 4-6) → store-3 (6-7) → store-4 (8) → store-5 (9). store-6a ∥ store-6b (7-10) after store-2. store-7 (9-10). At most three store agents run at once on days 7 and 8, and four on day 9.

### Methods and conformance ids

Implements `admin.ts`'s `Data/export` (`method/Data/export`). Its larger effect is enabling: `changes/below-floor` (compaction), and every `window/*`, `act/*` and `undo/*` id once views run on it.

### Owner review

None (dependency lane). Gated by the 100k-thread benchmark, the property tests and adversarial review. The owner later runs the importer rehearsal on a copy of `aplos.db` in Phase 2 (counts only).

### Risks and cuts

Day 6 is the hardest date in the thread. store-2 is the only blocker for `prov-gmail`, so it publishes types on day 5 and lands the extension before the hooks if time is short. The hooks can follow on day 7, because `laneFor` injection does not change the commit input. zstd may be unavailable in Electron's Node, in which case gzip ships and the probe result is recorded. Not on the brief's cut list. If late, add a third Opus agent rather than cut.

> **What this means:** The database is already half built. This lane finishes it by day 6 so the Gmail team can start writing real mail into it, then adds saved message bodies, fast search, tidy-up rules and the move of your existing mail.

## 5. `eng-views`

**Scope.** Compiles view specs to keyset SQL, runs the live-window engine (ID-only frames, coalescing, holds), applies commands with receipts and inverse-op undo, and serves sender rules. Goal: conformance green on the real engine by **day 11**.

**Owned paths (OWNERS.md):** `packages/engine/src/views/**`, `packages/engine/src/methods/{view,thread,operation,sender}.ts`.

**Needs.** `contract-1` (day 4 to 5). F4's commit works today, so views-1 starts on day 4. `store-2`'s extension API (the `ops` and `sender_rules` writers) by day 6. `store-4`'s `search()` by day 8. `time-1`'s `DeadlineRegistry` by day 6 (hold expiry as a `holds` source). `ai-2`'s demo data by day 6 (for conformance). From Providers: `AccountActorHost.opsChanged` and `ProviderPort.openThread` and `search` (stubbed until `prov-gov` lands), and `Account/get` by day 9 (section 10).

**Feeds.** `ui-shell` and the switch (day 11), `eng-ai` (Home spec), `eng-host` (`View/query` for MCP and CLI), `prov-gmail-write` and `prov-gov` (ops rows).

### Work packages

**views-1 · View specs and compiler.** Opus · days 4-5 · first.
- Files: `packages/engine/src/views/{specs,compile,sections,registry}.ts`, `packages/engine/tests/views/{compile,explain}.test.ts`.
- Done: every `ViewSpec` kind in `schemas/mail.ts` compiles to keyset SQL over `thread_folders`, `thread_workflow` and the `home` index, with an optional account filter and never `OFFSET`: `home` (sections `do`, `fromLater`, `update`, `low`, `follow`, Follow up computed from user-sent-last plus `mail.followUpDays`), `later` (groups), `all`, `drafts`, `sent`, `needs-reply`, `awaiting-reply`, `trash`, `spam`, `low`, `lowSenders`, `label:<id>`, `search:<q>`, `thread`. A spec registry lets `prov-cal` (`events`, `plans`) and `eng-ai` (`conversations`) register their kinds from their own modules. The query list goes to store-7 for the bench gate.
- Check, "EXPLAIN QUERY PLAN": at 100k threads every compiled spec uses an index with no scan of `threads` or `messages`; for pathological specs (an empty label, FTS operators, an account filter, a Later group at a DST boundary) the result differs from a slow reference query.
- Test: `npx tsx --test 'packages/engine/tests/views/**/*.test.ts'`

**views-2 · Window engine, coalescing, holds.** Opus · days 5-8 · after views-1's spec types.
- Files: `packages/engine/src/views/{windows,fanout,holds,counts}.ts`, `packages/engine/src/methods/view.ts`, `packages/engine/tests/views/{windows,holds,storm}.test.ts`.
- Done: `View/watch {spec, holdIds?}` returns at most 200 body-free rows and under 150 KB. After each commit the change set maps to candidate windows, which re-run their keyset query at most 4 times a second, coalesced and gated by account and type. Coarse rows cause one re-run per page. Frames are ID-only. `View/move|unwatch|hold|release|query`, `Folder/get`, `Counts/get` (with `handledToday`), `SenderGroup/get`, and `Search/remote` (through `ProviderPort.search`; the results join the `search` window, failure as `WindowBody.error`). Held rows keep position until released or 2 s after the last hold. At 100k: re-run p95 under 1 ms, `View/move` p95 under 5 ms.
- Check, "storm" (plan 10 E3 (a)): a 100,000-message backfill with three windows open; the reviewer shows more than 4 frames a second per window, CPU pegged, or a held row moving.
- Test: `npx tsx --test 'packages/engine/tests/views/**/*.test.ts'` plus the conformance run.

**views-3 · Commands, receipts, undo.** Opus · days 6-8 · after store-2's extension API.
- Files: `packages/engine/src/views/{act,ops,undo,why}.ts`, `packages/engine/src/methods/{thread,operation}.ts`, `packages/engine/tests/views/{act,undo,overlay.property}.test.ts`.
- Done: `Thread/act {opId, ids | selector, action}` applies inside one commit, resolves a selector at `atState`, enqueues the provider op (`ops` rows through a registered extension, then `opsChanged`) and returns `{opId, appliedState}`. `Operation/undo` enqueues the inverse operation, never a delayed commit (DESIGN rule 11), and cancels while still queued. `Operation/get|retry`. `Thread/get` returns rows with `partial`. `Thread/open` serves a complete local thread without a provider call and otherwise calls `ProviderPort.openThread` with `knownCount` from `remote_count`. `Thread/why` returns `{sentence, quote?, messageId?, lane, rankSource}`. Burst: 10 acts in 2 s give 10 receipts and at most one window update per 250 ms. `Thread/act` plus receipt p95 under 4 ms.
- Check, "stale overlay" (plan 10 E3 (b)) and "scope bypass" (carry-over S4): random command and frame interleavings against a model show a state the engine never had; a `read` caller undoes or retries a `triage` operation; undo after the op synced does not reach the provider as an inverse.
- Test: `npx tsx --test 'packages/engine/tests/views/**/*.test.ts'` plus the conformance run.

**views-4 · Sender rules.** Sonnet, Opus review · day 9 · after views-3.
- Files: `packages/engine/src/views/senders.ts`, `packages/engine/src/methods/sender.ts`, `packages/engine/tests/views/senders.test.ts`.
- Done: `SenderRule/get|set|destroy|block|unblock` write `sender_rules` (the `remote_filter_id` stays for `prov-gmail-write` to sync). A rule applies to new mail through the ingest hook and to existing threads as one `Thread/act`-style commit with a receipt.
- Check, "rule precedence": a sender rule overrides a user's lane choice, or a block deletes mail instead of hiding it.
- Test: `npx tsx --test packages/engine/tests/views/senders.test.ts`

**views-5 · Real-engine burn-down and E3 budgets.** Opus (Free for runs) · days 9-11 · after views-2 and views-3.
- Files: fixes in this lane's own files only; removal-only edits to `expected-fail.engine.json` (seam 3); `packages/engine/tests/views/budgets.test.ts`.
- Done: every engine-owned id in section 10 that depends on views passes on the real engine; the E3 budgets are measured at 100k threads and recorded; a kill-and-resume test reconnects windows on the same `dbEpoch`.
- Check, "fixture parity": the reviewer finds a behaviour where fixture and real engine give different answers to the same contract call that the suite does not catch, and adds the case to the suite through `eng-contract`.
- Test: `npx tsx --test packages/contract/tests/conformance/engine.test.ts 'packages/engine/tests/views/**/*.test.ts'`

**Order.** views-1 → views-3 → views-5 on the first track; views-2 → views-4 on the second. Two agents at once.

### Methods and conformance ids

Implements `mail.ts`'s `View/watch|move|unwatch|hold|release|query`, `Folder/get`, `Counts/get`, `SenderGroup/get`, `Search/remote`, `Thread/get|act|why|open`, `Operation/undo|get|retry` and `admin.ts`'s `SenderRule/get|set|destroy|block|unblock` (22 `method/*` ids). Flips `window/first-answer`, `window/frame-after-change`, `window/move-and-unwatch`, `window/holdIds-keep-place`, `window/hold-then-release`, `window/coalescing` (views-2); `receipts/natural-order`, `act/selector`, `undo/restores-thread`, `envelope/not-found`, `envelope/idempotent-opId` (views-3); `frames/stamped-and-ordered` and `reset/void-windows` (views-2 with contract-1).

### Owner review

None (dependency lane). The owner sees it through features 2 and 3.

### Risks and cuts

The day-11 gate depends on `ai-2`'s demo data and on Providers' `Account/get` (section 10). The storm risk (coarse rows re-running windows) is tested from day 8, not at the end. Never cut (brief 1, section 3).

> **What this means:** Lists load a small window of rows and change in place, and your actions get a receipt at once. This is what lets the screens switch from the stand-in engine to the real one on day 11.

## 6. `eng-time`

**Scope.** Builds the one clock and timer loop, and the send state machine that commits its marker before the first byte (uncertain sends settled by `findSent`, never replayed). Also undo and send-later as one mechanism, the overdue rule, drafts with compare-and-set and remote sync scheduling, reminders and Later, and the notification outbox.

**Owned paths (OWNERS.md):** `packages/engine/src/{outbox,clock}/**`, `packages/engine/src/methods/{submission,draft,outbox,later,reminder,notification}.ts`.

**Needs.** `contract-1` (day 4 to 5). `store-2`'s extension API by day 6 (submissions, drafts and notifications writers; code against the day-5 types first). The frozen `SendPort`, `DraftSyncPort` and `Clock` ports (F3; stubs until `prov-gov`). `prov-emu`'s Gmail emulator with send fault injection by day 9 (time-6; an in-repo counting fake `SendPort` until then). `prov-gmail-write` (starts day 6 on the frozen ports) for feature 12's real Gmail send.

**Feeds.** `Clock` and `DeadlineRegistry` by **day 6** to `eng-views` (holds), `eng-ai` (`jobs`, `dueBand`), `eng-store` (FTS idle pacing) and `prov-gov` (`ops`, `governor`, `sync:*`). Send states to `ui-reader` (feature 4). `Outbox/pending` to `eng-host`'s quit warning.

### Work packages

**time-1 · Clock and the one timer loop.** Sonnet, Opus review · days 4-5 · first.
- Files: `packages/engine/src/clock/{system,fake,loop,module}.ts`, `packages/engine/tests/clock/loop.test.ts`.
- Done: `clock/system.ts` over `Date.now` and `setTimeout`, re-arming when early. `clock/fake.ts` is the engine's test clock (`advance`, `set`), also used by contract-2's runner. `clock/loop.ts` implements `DeadlineRegistry` (F3 `ports/time.ts`): it sleeps until the earliest `next()`, fires that source, and recomputes after `changed`, at launch and on `wake()`. A source that does not move its deadline backs off 1 s and logs. Wake-ups per hour are capped. 20 overdue items catch up in order.
- Check, "spin and starve": a stuck source spins the loop above 1 fire a second, or a slow source delays another source's due deadline beyond its own run time.
- Test: `npx tsx --test 'packages/engine/tests/clock/**/*.test.ts'`

**time-2 · Submission state machine.** Opus · days 5-8 · senior.
- Files: `packages/engine/src/outbox/{submissions,start,mime,store,module}.ts`, `packages/engine/src/methods/{submission,outbox}.ts`, `packages/engine/tests/outbox/{machine,start-rules,mime}.test.ts`.
- Done: ARCH 7.1 states `queued → sending → sent | uncertain | failed`, plus `scheduled`, `cancelled` and `suspended`. The Message-ID is generated once and the exact MIME is kept until `sent` is confirmed. `SendPort.admission` comes first; the `sending` marker (state and `attempt_at`) is committed before `send`. `NotSentError` (and `PausedError` with `cls:'send_limit'`) gives `failed` with Retry, never auto-retried. Other `PausedError`s stay `queued` until `until`. Anything else is `uncertain`: `findSent(internetId, attempt_at)`, once more after 60 s, then the user's prompt. Start rule: a `sending` row found at start or wake becomes `uncertain` and runs `findSent` before any other send of that account, never suspended or re-sent. Overdue rule (freeze FR-2): every row waiting on `not_before`, `queued` and `scheduled` alike (`WAITING_SUBMISSION_STATES` in `@aplos/contract/rules`), that would leave more than `OVERDUE_GRACE_MS` (5 minutes) late becomes `suspended`; never a `sending` row. The bytes that leave are the pinned revision (freeze FR-7): the kept MIME, unless the remote draft is provably that revision (`SubmissionPayload.baseRemoteMessageId`). Undo and send-later are one `not_before` (`Submission/set`: send with `undoSendSeconds`, `sendNow`, `reschedule`, `sendAnyway`, `retry`, cancel). `Outbox/pending` returns `{scheduledSends, reminders, uncertain}`. Registers the `outbox` deadline source.
- Check, "double send" (plan 10 E6): kill points, retries, undo racing send, the clock jumping both ways, and two engines on one store; the counting fake `SendPort` must never see two deliveries of one Message-ID.
- Test: `npx tsx --test 'packages/engine/tests/outbox/**/*.test.ts'`

**time-3 · Drafts.** Sonnet, Opus review · days 7-8 · after store-2.
- Files: `packages/engine/src/outbox/{drafts,draft-sync}.ts`, `packages/engine/src/methods/draft.ts`, `packages/engine/tests/outbox/drafts.test.ts`.
- Done: ARCH 7.4. The local draft with `revision` is the truth. Compare-and-set saves return `stateMismatch` to the loser. A content fingerprint skips unchanged uploads. Per-draft serialized sync goes through `DraftSyncPort` (upload after 5 s idle and on close, via the `drafts` deadline source; `PausedError` reschedules). Conflict state with `Draft/resolve` ("keep mine, take theirs, or keep both") and the `Draft/changed` frame. Other devices' drafts show in Drafts, never in threads.
- Check, "lost draft": two saves on one base both "win"; a remote edit overwrites a local edit without the three-way choice; a paused upload drops the draft.
- Test: `npx tsx --test packages/engine/tests/outbox/drafts.test.ts`

**time-4 · Reminders and Later.** Sonnet, Opus review · day 6 · after time-1.
- Files: `packages/engine/src/clock/sources/{reminders,later}.ts`, `packages/engine/src/methods/{reminder,later}.ts`, `packages/engine/tests/clock/sources.test.ts`.
- Done: `reminders` and `later` deadline sources over `thread_workflow.reminder_at` and `later_until`. A late fire carries "was due 9:00" (Decision 3). `Reminder/list|ack` and `Later/presets` in the configured time zone, with a `reminder` host event.
- Check, "late fires once": the clock jumps three days and across a DST change; each reminder fires exactly once with its was-due time, and Later returns at the right local time.
- Test: `npx tsx --test packages/engine/tests/clock/sources.test.ts`

**time-5 · Notification outbox.** Sonnet, Opus review · days 9-10 · after store-2's hook point.
- Files: `packages/engine/src/outbox/notifications.ts`, `packages/engine/src/methods/notification.ts`, `packages/engine/tests/outbox/notifications.test.ts`.
- Done: ARCH 7.6. `notifications` rows are written in the sync commit (store-2's hook) for new inbound Inbox mail after the silent baseline, never for backfill, search, Spam or a baseline account. `Notification/claim|ack` let main claim, post through the host channel and mark `posted`. The Dock badge comes from engine counters.
- Check, "exactly once": 50 simulated syncs with a crash between written and posted give exactly one notification per message and none for backfill or Spam.
- Test: `npx tsx --test packages/engine/tests/outbox/notifications.test.ts`

**time-6 · Kill-point harness and matrix.** Opus · days 9-10 · after time-2.
- Files: `packages/engine/src/outbox/killpoints.ts`, `packages/engine/tests/outbox/{killpoint,release-grep}.test.ts`.
- Done: four named kill points (before the marker; after it and before bytes; after bytes and before acknowledgement; after acceptance and before the local commit) exist only in test builds. A child-process engine is killed at each against the counting fake and, once `prov-emu` hands over, the Gmail emulator. On restart there is never a duplicate delivery and never a silent loss: each ends `sent`, `failed` with a reason, or `uncertain` with the prompt. A release-bundle grep asserts the kill-point strings are absent. The harness is shared with `prov-emu` (HANDOFF-READY to Providers).
- Check, "lost mail" (plan 10 E6): any path that ends with no state and no message to the user, including a kill during `findSent` itself.
- Test: `npx tsx --test packages/engine/tests/outbox/killpoint.test.ts packages/engine/tests/outbox/release-grep.test.ts`

**Order.** time-1 → time-4 → time-3 → time-5 on the Sonnet track; time-2 → time-6 on the Opus track. Two agents at once.

### Methods and conformance ids

Implements `compose.ts`'s `Draft/get|set|destroy|resolve`, `Submission/get|set`, `core.ts`'s `Outbox/pending`, `mail.ts`'s `Later/presets`, `Reminder/list|ack` and `admin.ts`'s `Notification/claim|ack` (12 `method/*` ids). No scenario id depends on this lane alone.

### Owner review: feature 12 (lead), sending, undo, scheduled send and Later

Built with `prov-gmail-write`. The "ready to look at" post, around day 12 once screens run on the real engine:

1. Reply to a demo thread and press Send. "Sending in 5 seconds, Undo" appears; press Undo and the draft comes back.
2. Send again and let it go. It shows Sent once, and the emulator's delivery count reads 1.
3. Schedule a send two minutes out. It appears under scheduled sends and goes at its time.
4. Set Later on a thread for "this evening" and a reminder for one minute. The thread leaves Home and returns, and the reminder fires.
5. Kill the engine mid-send (test build). After relaunch the message is Sent exactly once, or shows "We could not confirm this was sent. Check Sent, or Send anyway."

Data: original demo mail on the real engine over `prov-emu`'s Gmail emulator, `APLOS_TEST=1` with an isolated `APLOS_DATA_DIR`. Plus a plain readout: a timeline of each submission's states and the emulator's delivery counter. Live acceptance stays pending until the owner's one real send with a mid-send kill (days 14 to 16).

### Risks and cuts

`prov-emu`'s emulator date is not fixed; time-6 runs on the counting fake meanwhile and repeats on the emulator. Feature 12's post depends on `prov-gmail-write` and the switch. The outbox is never cut.

> **What this means:** Sending can never go out twice. Undo, scheduled sends, reminders and Later survive restarts. If the Mac was off when a send was due, Aplos asks instead of sending late.

## 7. `eng-ai`

**Scope.** Builds the durable, consent-gated AI job queue with its own governor and daily budget, and the heuristic Home lanes. Also `Setup/*` replacing `deferAI` (the PR #21 findings), `Demo/*` with an empty start, the interactive `Ai/*` and `Ask/*` path, and the per-feature provider and model table. Moves the host AI transports into `host/ai/` with retries off.

**Owned paths (OWNERS.md):** `packages/engine/src/ai/**`, `packages/engine/src/methods/{ai,ask,setup,demo,consent,queue}.ts`, `apps/desktop/src/host/ai/**`, today's `apps/desktop/src/main/{groq,llm,ollama,anthropic,ai-keys}.ts` until they move into `host/ai/`, `apps/desktop/scripts/{evaluate-groq.ts,ask-live.ts}`, `apps/desktop/scripts/quality/**`.

**Needs.** `contract-1` (day 4 to 5). `store-2`'s extension API by day 6 (`jobs`, `consent`, `ai_usage`, `summaries`, `conversations` writers). `time-1`'s registry by day 6 (`jobs`, `dueBand`). `views-1`'s Home spec (the Follow up section reads what `ai-*` writes). `prov-gov`'s governor base class (`sync/governor.ts`) by day 7, falling back to a standalone AI governor behind the same `BudgetSpec`. `prov-gov`'s `baseline_done_at` and `AccountRuntime` (stub actor until then). UI-screens hands over `tests/onboarding.test.ts` (the PR #21 F tests) on day 5.

**Feeds.** `laneFor` to `store-2`'s ingest hook and `prov-gmail` by day 7. Demo data to the conformance runner by **day 6**. `Setup/*`, consent and `Demo/*` to `ui-onboard` (feature 5), the provider table to `ui-settings` (feature 8), Ask and summaries to `ui-ask` (feature 7).

### Work packages

**ai-1 · Heuristic Home lanes.** Sonnet, Opus review · days 4-5 · first, pure, no dependencies.
- Files: `packages/engine/src/ai/{lanes,lanes.table}.ts`, `packages/engine/tests/ai/lanes.test.ts`.
- Done: `laneFor(input): {lane, importance, due?}` (F3 `LaneFor`) from `List-Unsubscribe`, `Precedence: bulk`, `Auto-Submitted`, no-reply senders, Gmail `CATEGORY_*` and `IMPORTANT`, direct versus cc, known correspondent, a user reply, invitations and structured delivery, reservation and bill markup when a body is present. A 60-case table covers the Update cases (deliveries, scheduled payments, FYI from people) and the security-notice cases. Pure and deterministic.
- Check, "lane spoofing": with header-only tricks (spoofed `List-Unsubscribe` on a personal mail, no-reply variants, cc-only to self, a bill markup in a newsletter) the reviewer pushes a direct personal message into Low or bulk mail into Do now.
- Test: `npx tsx --test packages/engine/tests/ai/lanes.test.ts`

**ai-2 · `Demo/*` and the empty start.** Sonnet · days 5-6 · on the conformance path.
- Files: `packages/engine/src/ai/demo/{data,load}.ts`, `packages/engine/src/methods/demo.ts`, `packages/engine/tests/ai/demo.test.ts`.
- Done: original demo data (two demo accounts, about 18 threads across every place, a draft, `.example` domains only, no reference-app wording) committed through `store.commit` with `demo` accounts. `Demo/load|reset|remove` are idempotent and touch only demo accounts. A fresh install creates zero accounts and no demo data. `Session/get.hasAccounts` counts demo accounts.
- Check, "demo touches real data": with a real account present, `Demo/remove` and `Demo/reset` leave every real row byte-identical (content hash), and `Demo/load` twice yields one copy.
- Test: `npx tsx --test packages/engine/tests/ai/demo.test.ts`

**ai-3 · Jobs runner and consent.** Sonnet, Opus review · days 6-8 · after store-2 and time-1.
- Files: `packages/engine/src/ai/{jobs,consent,store,module}.ts`, `packages/engine/src/methods/{consent,queue}.ts`, `packages/engine/tests/ai/{jobs,consent.property}.test.ts`.
- Done: ARCH 8.1 and 8.3, E5 items 1 and 3. Singleton keys (`summary:<thread>:<input_hash>`), priority (visible Home, then unread Inbox newest first; never Spam, Trash or a baseline account), backoff, dead letter after 5, 1 to 2 concurrent per provider, `running` back to `queued` on restart. The `jobs` deadline source. Background jobs run with tools undefined, mail wrapped as quoted untrusted text, output validated against preset `SuggestedAction` kinds. Consent `(scope, version, provider, model)` plus per-account `ai_allowed`; enqueue checks stored consent; changing provider or scope bumps the version and pauses background AI. Mail never goes to a `trainsOnInputs` provider, and free-tier Gemini counts as true until marked paid. `Queue/list|retry|discard` cover ops, jobs and submissions; retry re-checks the original method's scope (carry-over S4).
- Check, "consent bypass" (plan 10 E5): switching providers mid-queue gets mail text to a `trainsOnInputs` provider; random sequences (connect, sync batch, close, reopen, consent change, disconnect) produce a job without stored consent or one for a baseline account.
- Test: `npx tsx --test 'packages/engine/tests/ai/**/*.test.ts'`

**ai-4 · AI governor, budget and host transports.** Sonnet (Free for the file move), Opus review · days 7-9 · after ai-3's store writers.
- Files: `packages/engine/src/ai/{governor,usage,providers}.ts`, `apps/desktop/src/host/ai/**`, `apps/desktop/src/main/{groq,llm,ollama,anthropic,ai-keys}.ts` (become one-line re-exports so the legacy code keeps building), `packages/engine/tests/ai/governor.test.ts`, `apps/desktop/tests/eng-ai/transports.test.ts`.
- Done: per provider and model RPM, TPM and TPD learned from response headers, `Retry-After` honoured. A daily-token 429 stops only that model's queue until reset, with a reason. `ai_usage` per day, provider, model and lane. A 150,000-token background cap by default, with interactive calls never starved. Every SDK client is built with `maxRetries: 0`, so this is the single AI retry layer. Providers: Groq (default for every feature, including transcription, `GROQ_API_KEY`), OpenAI, Claude (official Anthropic SDK), Gemini, OpenRouter, OpenCode Go, Ollama and LM Studio on default local ports (address changeable), and a custom OpenAI-compatible server, each reading its key from the backend environment or the Keychain vault. The per-feature table (Ask, Summaries, Drafts, Plans, Voice) comes from `Settings.ai.features`; Voice requires a speech-to-text provider (Groq or OpenAI).
- Check, "retry and key leak": a stub returning 500 counts more than one attempt for any SDK; a daily 429 on one model pauses another; a canary key appears in a log line, an error, a `Ai/providers` output or a diagnostics field.
- Test: `npx tsx --test packages/engine/tests/ai/governor.test.ts apps/desktop/tests/eng-ai/transports.test.ts`

**ai-5 · `Setup/*` and the PR #21 scenarios.** Sonnet, Opus review · days 9-10 · after ai-3.
- Files: `packages/engine/src/ai/setup.ts`, `packages/engine/src/methods/setup.ts`, `packages/engine/tests/ai/setup.test.ts` (absorbing the handed-over `tests/onboarding.test.ts` cases).
- Done: E5 item 5. Deferral is the account's silent baseline plus consent, not an in-memory set. `Setup/end` is idempotent and always enqueues a one-shot backfill of unsummarized threads (visible Home first). Every job has its own id and singleton key. Disconnect deletes the account's queued jobs. `Setup/status` returns the per-account shape (`firstWindow`, `ai`, `backfill`, `pausedUntil`, `reasonCode`, `errors`). `Setup/retry` per account. Tests F1, F2, F5, F6 and F10 of DESIGN Appendix C pass against `Setup/*`. PR #21 stays unmerged.
- Check, "orphaned account" (plan 10 E5): the worst orderings of close, reopen, retry, disconnect and reconnect leave a consented account with no AI, or a capped pass reports done instead of partly done.
- Test: `npx tsx --test packages/engine/tests/ai/setup.test.ts`

**ai-6 · Interactive `Ai/*` and `Ask/*`.** Sonnet, Opus review · days 10-11 · after ai-4.
- Files: `packages/engine/src/ai/{interactive,ask,prompts}.ts`, `packages/engine/src/methods/{ai,ask}.ts`, `packages/engine/tests/ai/{ask,interactive}.test.ts`.
- Done: `Ai/request|draft|polish|transcribe|cancel|providers|models|status|usage|setKey|removeKey|testKey|test` and `Ask/run` with `progress` frames (`step`, `text`, `citation`, `proposal`, `done`), cancel, `Ask/decide` (returns a receipt; a guest-notifying proposal needs its proper scope, carry-over S1 and S3), `Ask/suggestions`, `Conversation/get|destroy`. Transcription takes a `blobId` from `Blob/put`, never base64. Ask reads only accounts with "Use this account's mail for AI" on and never a `trainsOnInputs` provider. Keys are write-only: `Ai/setKey` stores into the vault and nothing returns key characters.
- Check, "prompt injection": a hostile demo email that asks the assistant to send, forward or change settings yields only text or a preset proposal waiting for the user; a background call carries tools.
- Test: `npx tsx --test 'packages/engine/tests/ai/**/*.test.ts'`

**ai-7 · Home freshness and follow-ups (queue extras).** Sonnet · day 11 · cut first in this lane.
- Files: `packages/engine/src/ai/{dueband,followup}.ts`, `packages/engine/tests/ai/{dueband,followup}.test.ts`.
- Done: the `dueBand` deadline source refreshes `due_band` at local midnight (this part is kept if the rest is cut). `followup` jobs (singleton `followup:<thread>:<last_sent_hash>`, after summaries in priority) keep a short nudge as a local suggestion, never a synced draft. `Ai/followup|dismissFollowup|jobs`. No follow-up job without consent or past the cap, and a new reply retires the suggestion.
- Check, "nudge without consent": a follow-up enqueues without stored consent, past the daily cap, or survives a new reply.
- Test: `npx tsx --test packages/engine/tests/ai/dueband.test.ts packages/engine/tests/ai/followup.test.ts`

**Order.** ai-1 → ai-3 → ai-5 → ai-7 on one track; ai-2 → ai-4 → ai-6 on the other. Two agents, plus a free-tier agent for ai-4's file move.

### Methods and conformance ids

Implements `ai.ts`'s `Ai/*` (16), `Ask/run|cancel|decide|suggestions`, `Conversation/get|destroy`, `Setup/begin|end|retry|status`, `Demo/load|reset|remove`, `Consent/get|grant|revoke` and `admin.ts`'s `Queue/list|retry|discard` (35 `method/*` ids). Flips `setup/status-shape` (ai-5). `Demo/load` (ai-2) unblocks the runner's data for every other id.

### Owner review

No feature of its own. It contributes to feature 7 (UI-screens leads): HANDOFF-READY to `ui-ask` around day 11 with Ask answering with citations on demo mail through Groq, summaries arriving after consent, and the budget readout (`Ai/usage` against the 150,000 cap). It also contributes to feature 3 (Home ranks with AI off, day 7), feature 5 (`Setup/*`, consent and `Demo/*`, day 10) and feature 8 (the provider and model table, day 9). Runs steps d to g for its own PR.

### Risks and cuts

The governor base class from `prov-gov` may be late (fallback above). Cut order inside this lane per brief 1, section 3: ai-7's follow-ups first, then `suggest-action` and `plan` job kinds. Never cut consent, the cap or `Setup/*`.

> **What this means:** Home sorts sensibly with AI off. Summaries come later, within a daily budget, and only after you agree to what is sent where. Finishing setup at any moment can no longer leave an account without AI.

## 8. `eng-html`

**Scope.** Builds the parser-based allowlist sanitizer package and the `Mail/frame` pipeline (single-render tokens, an LRU of 12, every response header built by the engine). Also the protocol relay with main adding nothing, the image proxy with an SSRF classifier, the main-side backstops, and the hostile corpus with its leak harness.

**Owned paths (OWNERS.md):** `packages/mail-html/**`, `apps/desktop/src/host/{protocol,proxy}/**`, `apps/desktop/src/main/protocol.ts`, `packages/engine/src/methods/mail.ts`. The token registry and LRU are pure JS and live in `packages/mail-html/src/frame/`, so no new engine path is needed. The handler in `methods/mail.ts` stays thin.

**Needs.** The integrator creates the `packages/mail-html` workspace on day 4 (seam 4). `store-3`'s bodies by day 7 (the full store milestone by day 9). `contract-4`'s control connection for the relay by day 9. plat-ci's Playwright base (or a lane-local `_electron.launch`) for the leak harness. plat-release's agreement on one shared `webRequest` handler module (`main/security.ts` is theirs) by day 8. `eng-host` adds `setWindowOpenHandler` and `will-frame-navigate` in `main/windows.ts` (same thread) by day 9.

**Feeds.** `ui-reader`'s `MailFrame` switches from the stand-in's `srcdoc` to the real `url` around day 10 (feature 4).

### Work packages

**html-1 · Parser spike.** Sonnet, Opus decides · day 4 · first.
- Files: `packages/mail-html/package.json`, `packages/mail-html/spike/**` (deleted when html-3 lands); the choice goes in DECISIONS.md.
- Done: an HTML parser and CSS tokenizer are chosen by measured bundle size (target under 150 KB for the package) and correctness on the first 20 corpus messages. The licence is MIT, BSD or Apache, never GPL or AGPL. The fallback is a small in-house tokenizer for `url()` and `@import`.
- Check, "size and licence": the reviewer re-measures the bundle and reads the licence of every transitive dependency.
- Test: `node packages/mail-html/spike/measure.mjs` (prints bytes and pass counts).

**html-2 · Hostile corpus and leak harness.** Sonnet (Free for bulk variants, each reviewed) · days 4-7 · grades html-3 to html-6.
- Files: `packages/mail-html/corpus/**`, `apps/desktop/tests/eng-html/{leak.e2e,canary}.ts`.
- Done: at least 60 original messages covering inline scripts and handlers, `javascript:` and `data:` URLs, meta refresh, `<link>` prefetch and preconnect, CSS `url()`, `@import`, `@font-face`, `image-set()`, `<base>`, SVG script and `foreignObject`, auto-submit forms, nested iframes, `object` and `embed`, mXSS mutations, 100,000-element nesting, 5 MB single lines, malformed encodings, 1x1 and hidden pixels, and open-redirect image URLs. The harness launches a hidden Electron (`show:false`, `APLOS_TEST=1`, an isolated data dir, the binary exec'd directly) through the real protocol handler, with a canary HTTP server on a random loopback port, a DNS canary and the Chromium net log.
- Check, "corpus gap": the reviewer names an attack class from the list above, or from the RFC and HTML spec, that has no corpus entry.
- Test: `APLOS_TEST=1 npx playwright test apps/desktop/tests/eng-html/leak.e2e.ts` (through plat-ci's config once it lands).

**html-3 · Sanitizer.** Opus · days 5-7 · after html-1.
- Files: `packages/mail-html/src/{index,sanitize,css,links,trackers,quotes,find,reading-css}.ts`, `packages/mail-html/tests/{sanitize,css,perf}.test.ts`.
- Done: implements `MailHtml` (F3 `ports/content.ts`): pure, synchronous, versioned. Keeps `<style>` and `style`. Removes `script`, `meta`, `link`, `base`, forms, `iframe`, `object`, `embed`, SVG `foreignObject`, remote `@import` and `@font-face`, and every `url()` that is not a rewritten `cid/<n>` or `img/<n>`. Links get `target=_blank rel="noopener noreferrer"` and other schemes are dropped. Tracking pixels are removed and counted. Quoted history is wrapped in `<details>`. Find `<mark>`s and reading CSS are injected. Plain text returns as `bodyKind:'text'`. Median under 5 ms and p99 under 40 ms per message on the corpus. Bundle bytes recorded.
- Check, "bypass" (plan 10 E4): a time-boxed agent given only the allowlist and the headers achieves any script execution, outbound request or storage write from a message. Each success becomes a corpus entry and a fix.
- Test: `npx tsx --test 'packages/mail-html/tests/**/*.test.ts'`

**html-4 · Frame pipeline, tokens, LRU, `methods/mail.ts`.** Opus · days 8-10 · after html-3 and store-3.
- Files: `packages/mail-html/src/frame/{tokens,lru,pipeline,headers,reporter}.ts`, `packages/mail-html/assets/reporter.js`, `packages/engine/src/methods/mail.ts`, `packages/mail-html/tests/frame.test.ts`, `packages/engine/tests/mail/frame.test.ts`.
- Done: `Mail/frame {messageId, imagePolicy, findQuery, quotesOpen}` reads the stored original, sanitizes on every read (sanitizer version in the cache key) and returns `{url, expiresAt, bodyKind, trackersRemoved, hasRemoteImages, quotedCount}`, where `url` is `aplos-mail://m/<token>`. Tokens are 128-bit, single-render, at most 64 live, and dropped on `Mail/release` or replacement. The 13th render evicts the oldest. `Mail/serve` (host scope only) builds the whole response, every header included, exactly as ARCH 10 (`default-src 'none'`, `script-src 'sha256-<reporter>'`, `sandbox allow-scripts allow-popups`, `nosniff`, `no-referrer`, `no-store`, and the rest). The reporter's hash is recomputed by a test from the shipped file; it posts only `{token, h, w, bg, ready, marks}`. `Mail/allowImages` edits `mail.imageAllowList`. `Mail/toggleQuotes`, `Message/get`, `MessageBody/get|prefetch` (prefetch fills the LRU, with cancel), `Attachment/get` (blob, from files), `Message/original`. Old-mail test: change a rule, bump the version, re-open with no provider call.
- Check, "token abuse": a reused, guessed, expired or released token; a token from another window; path traversal in `…/<token>/cid/<n>`; more than 64 live; `Mail/serve` from a non-host caller (carry-over S5 handle binding). Each must be refused.
- Test: `npx tsx --test 'packages/mail-html/tests/**/*.test.ts' packages/engine/tests/mail/frame.test.ts` plus the conformance run.

**html-5 · Protocol relay and main-side glue.** Opus · days 8-10 · after contract-4's control connection (day 9) · parallel with html-4.
- Files: `apps/desktop/src/main/protocol.ts`, `apps/desktop/src/host/protocol/{relay,keys}.ts`, `apps/desktop/tests/eng-html/{relay,keys}.test.ts`.
- Done: main registers `aplos-mail` as `{standard:true, secure:true}` only and forwards `{token, path}` to the engine over its control connection, adding no header. The shared `webRequest` backstop (one module agreed with plat-release) cancels any http, https, ws or wss request whose initiator is `'null'` or whose frame URL starts with `aplos-mail:`. Pop-out and print run in a `WebContentsView` with `javascript:false`. A `before-input-event` key relay works with focus inside a mail frame; if it does not fire for out-of-process frames, a non-destructive frame-script relay ships (J, K, scroll, Esc; never E, Space or R) and the gap is recorded. The packaged hand-check is an owner step or a background Cua-driver run on the exact window.
- Check, "frame escape": from a corpus message, navigate the top frame, `window.open` a `javascript:` URL, post a form, reach `opener`, or open devtools; or get the key relay to forward E, Space or R.
- Test: `npx tsx --test 'apps/desktop/tests/eng-html/**/*.test.ts'` plus the leak harness.

**html-6 · Image proxy and SSRF classifier.** Opus · days 5-7 · independent of the store.
- Files: `apps/desktop/src/host/proxy/{classify,resolve,fetch,limits}.ts`, `apps/desktop/tests/eng-html/ssrf.test.ts`.
- Done: DNS is resolved once and the connection goes to the resolved address with the original name as SNI and `Host`. Refused: loopback, private, link-local, CGNAT 100.64/10, ULA, multicast, unspecified, benchmarking 198.18/15, and IPv4-mapped or NAT64 forms of any of them. Redirects are followed manually (at most 3, each revalidated). Ports 80 and 443 only. Size and pixel caps read from the header. PNG, JPEG, GIF and WebP only (no SVG). No cookies or `Referer`. Timeouts and a per-token request budget. Images load on view only, and remote fonts never load. Table-driven tests.
- Check, "SSRF audit" (plan 10 E4): against RFC 6890 and the IPv6 special-use registry, with decimal, octal and hex IP forms, `[::1]`, `::ffff:127.0.0.1`, 169.254.169.254, a resolver answering public then private, a redirect to a private address and port 8080, the reviewer gets one request through.
- Test: `npx tsx --test apps/desktop/tests/eng-html/ssrf.test.ts`

**Order.** html-1 → html-3 → html-4 on the first Opus track; html-6 → html-5 on the second; html-2 runs alongside from day 4. Three agents at most.

### Methods and conformance ids

Implements `mail.ts`'s `Message/get`, `MessageBody/get|prefetch`, `Mail/frame|allowImages|release|toggleQuotes|serve`, `Attachment/get`, `Message/original` (10 `method/*` ids).

### Owner review: feature 13 (lead), the email safety frame

The "ready to look at" post, around day 11:

1. Open "A message that tries to track you" in the practice inbox. It reads normally and says "3 trackers removed".
2. Images show as quiet placeholders. Press "Load images": they appear, fetched through Aplos, and the sender is not told your address.
3. Click a link in the message. It opens in your browser, not inside Aplos.
4. Open "A message that tries to run code". Nothing happens, and the readout shows zero outbound requests.
5. With focus inside the message, press J and K: you move between messages. E, Space and R do nothing until focus leaves the message.

Data: the original hostile corpus loaded as a practice account in an isolated test store, shown in `ui-reader`'s frame on the real engine (or the preview host). Plus a plain readout from the leak harness: requests seen by the canary server (0 with images off; only the proxy with images on).

### Risks and cuts

The key relay for out-of-process frames is unknown until the packaged check (fallback named above). html-4 depends on bodies; it starts on in-memory bodies on day 8 if store-3 slips. The sealed frame is never cut.

> **What this means:** Each email is cleaned by the engine and shown in a sealed box that cannot run code, reach your files or tell the sender you opened it. Images load only when you allow them, through a guard that refuses internal addresses.

## 9. `eng-host`

**Scope.** Resident mode (close the window and Aplos stays in the menu bar; lock, wake, parked state, self-test) by day 7, plus the window hooks onboarding needs. Then the tool doorway by day 12: socket, loopback HTTP, clients and scopes, revocation, the diagnostics bundle, and the MCP and CLI extras.

**Owned paths (OWNERS.md):** `apps/desktop/src/main/{lifecycle,menu-bar,windows,native-methods,electron}.ts`, `apps/desktop/src/host/{lifecycle,menu-bar,power,lock,crash}.ts`, `apps/desktop/src/host/transports/{socket,http}.ts`, `apps/desktop/src/host/{mcp,cli}/**`, `packages/engine/src/selftest.ts`, `packages/engine/src/diag/bundle/**`, `packages/engine/src/methods/{diagnostics,listener,clients}.ts`, `apps/desktop/native/**`, `API.md`. Plus seam 4's `main/test-mode.ts`, `scripts/verify-resident.mjs` and `host/transports/auth.ts`.

**Needs.** plat-release's fuses and macOS 13 minimum for the packaged resident check (day 7). `contract-1` and `contract-4` (the engine connection the transports serve; day 8). `ui-onboard`'s `main/windows/onboarding.ts` (UI-screens) plugs into host-1's hooks from day 5. `eng-ai`'s `Queue/*` and `prov-gov`'s status data for the bundle (day 10). `time-2`'s `Outbox/pending` for the quit warning (day 8; today's engine's pending list until then).

**Feeds.** `ui-onboard` (window hooks, day 5, answering UI-screens' 18:14 REQUEST). `ui-settings` (listener, clients and diagnostics panes, feature 8, day 11). `plat-release` (the packaged resident and self-test checks).

### Work packages

**host-1 · Onboarding hooks and window lifecycle.** Sonnet, Opus review · days 4-5 · first.
- Files: `apps/desktop/src/main/{windows,native-methods}.ts`, `apps/desktop/tests/eng-host/windows.test.ts`.
- Done: UI-screens' 18:14 request. First run opens the onboarding window (`hasAccounts` false: today's engine's account list until the switch, then `Session/get`). A second-instance guard (PR #21 F3). The mail window is created `show:false` and handed over on ready-to-show with the `desktop` frame's `shown` event (F4). Main calls `Setup/end {reason:'closed'}` when onboarding closes (UI-screens DECIDED 18:11). `Window/openOnboarding|finishOnboarding` and `System/openSettings` are served. `setWindowOpenHandler` and `will-frame-navigate` follow ARCH 10 for `eng-html`. Test mode keeps every window hidden.
- Check, "window race": quit during the handoff, a second instance during onboarding, or closing onboarding before the renderer loads leaves two windows, no window with the app still in the Dock, or no `Setup/end`.
- Test: `npx tsx --test 'apps/desktop/tests/eng-host/**/*.test.ts'`

**host-2 · Resident mode, menu bar, lock, wake, parked.** Sonnet, Opus review · days 4-7 · `host/*` files first, then `main/lifecycle.ts` after host-1 lands.
- Files: `apps/desktop/src/main/{lifecycle,menu-bar}.ts`, `apps/desktop/src/host/{lifecycle,menu-bar,power,lock,crash}.ts`, `apps/desktop/scripts/verify-resident.mjs`, `apps/desktop/tests/eng-host/{lifecycle,lock,power}.test.ts`.
- Done: E1 item 4. Closing the last window keeps main and the engine alive with the accessory activation policy. The menu-bar item shows sync state, Open Aplos, Pause sync for 1 hour and Quit Aplos completely. It uses a plain-letter placeholder glyph, never a sparkle, wand or star. ⌘Q is a full quit with the pending-work warning from `Outbox/pending`. `wasOpenedAtLogin` starts windowless. `powerMonitor` `resume` and `unlock-screen` call `engine.wake()`, with a 30 s wall-clock-jump fallback. `run/aplos.lock` holds the pid and start time (a dead pid is reclaimed). States `starting | ready | parked`, a 3 s drain on quit, and the 3-exits-in-60-s guard leading to parked with "Export diagnostics / Try again". An event-loop delay monitor and an actor heartbeat supervisor (restart a silent actor after 2 minutes, via `AccountActorHost.lastHeartbeat`). `crashReporter.start({uploadToServer:false})`. `verify-resident.mjs` runs on the packaged app: a hidden start, close the only window, a reminder due in 60 s fires with no window.
- Check, "kill at startup" (plan 10 WP1.4): the engine is killed at each startup step and the next launch fails to recover; a second engine opens the same data; a 31 s fake clock jump triggers zero or two `wake()` calls.
- Test: `npx tsx --test 'apps/desktop/tests/eng-host/**/*.test.ts'` and `APLOS_TEST=1 APLOS_DATA_DIR=<abs tmp> node apps/desktop/scripts/verify-resident.mjs` on the packaged build.

**host-3 · Engine self-test.** Sonnet · day 6 · after host-2's launcher hook.
- Files: `packages/engine/src/selftest.ts`, `packages/engine/tests/selftest.test.ts`.
- Done: one function asserts `sqlite_version()` is at least 3.43, FTS5 is present and `contentless_delete` works, and returns JSON. host-2's `--selftest` flag forks the engine utility process, prints the report and exits (never through `ELECTRON_RUN_AS_NODE`, which the fuses turn off). plat-ci's CI job runs the same function inside Electron's Node.
- Check, "false pass": the reviewer gets a passing report on a build whose SQLite lacks `contentless_delete`, by stubbing the version string.
- Test: `npx tsx --test packages/engine/tests/selftest.test.ts`

**host-4 · Doorway transports and the security matrix.** Opus · days 8-10 · after contract-4's connection shape.
- Files: `apps/desktop/src/host/transports/{socket,http,auth}.ts`, `apps/desktop/tests/eng-host/{listener-matrix,socket}.test.ts`.
- Done: E7 items 1 and 2. A Unix socket at `run/engine.sock` (0600 in a 0700 directory, path under 104 bytes, else `/tmp/aplos-<uid>/engine.sock` checked for ownership), NDJSON, with a hello carrying the token and `{apiVersion, appVersion}` (an incompatible major gets `unsupported`). Loopback HTTP on `127.0.0.1` only: `POST /v1/call/<Type>/<verb>` (`Idempotency-Key` from `opId`), `GET /v1/events` (SSE, `id: <seq>`, `Last-Event-ID`, `reset`), `GET /v1/blob/:id`, `PUT /v1/blob` (25 MB), `GET /v1/openapi.json`. An exact `Host` allowlist and exact `Origin`, no reflected CORS, `no-store`, size caps, header and body timeouts, a connection cap. Only `listenerMethods` (no `secret` or `uiOnly` methods) are reachable.
- Check, "break in" (plan 10 E7): given only the listener source and ARCH 12.3, the reviewer makes an unauthenticated, cross-origin or wrong-scope call: no or wrong or revoked token, `evil.com` `Host`, a DNS rebinding simulation, wrong `Origin`, hostile `OPTIONS`, duplicate `Host` headers, blob path traversal, an oversized body, malformed JSON, slowloris.
- Test: `npx tsx --test 'apps/desktop/tests/eng-host/**/*.test.ts'`

**host-5 · Clients, scopes, audit, revocation, the listener switch.** Opus · days 9-11 · after host-4's auth module.
- Files: `packages/engine/src/methods/{clients,listener}.ts`, `packages/engine/tests/host/clients.test.ts`.
- Done: E7 items 3 and 4. 256-bit tokens stored only as SHA-256 hashes in `clients` (written through a registered commit extension), compared with `timingSafeEqual` in `auth.ts`, sent in `Authorization`, never given to a renderer. Scopes are registry tags per method. `Clients/list|grant|revoke|audit`: revoke closes open connections within 1 s. An `audit_log` row is written for every send, delete and settings change by a non-UI client. The CLI token sits in a 0600 file. `Listener/get|set` keeps the listener off in release builds until "Allow tools on this Mac" is on. A listener admin client cannot grant consent or redirect AI providers or addresses (carry-over S2).
- Check, "scope escalation": a `read` client calls `Submission/set`, a `draft` client sends, a revoked client's open SSE stream keeps receiving, or an admin client changes `Settings.ai` or `Consent/*`.
- Test: `npx tsx --test packages/engine/tests/host/clients.test.ts 'apps/desktop/tests/eng-host/**/*.test.ts'`

**host-6 · Diagnostics bundle, ring buffers, protocol log.** Sonnet, Opus review · days 11-12 · after host-4.
- Files: `packages/engine/src/diag/bundle/**`, `packages/engine/src/methods/diagnostics.ts`, `packages/engine/tests/host/bundle.test.ts`.
- Done: E7 item 8. Ring buffers of 500 events per account and folder, snapshotted into every UI error. A verbose protocol log (headers only, `Authorization` and `Cookie` removed, no bodies) that switches itself off after 15 minutes. The bundle holds versions, per-account status and cursor ages, governor targets and pauses, units a minute, queue depths, recent classified errors (redacted, carry-over S14), event-loop delay, and DB, WAL and FTS-backlog sizes. It is checked against the contract's `DiagnosticsBundle` schema at the host boundary (the engine core bundles no zod), previewed before saving, never uploaded, and lists crash dumps by count and date only. `Diagnostics/preview|export|verbose`.
- Check, "leak" (plan 10 E7): a canary seeded into subjects, bodies, addresses, tokens and provider error text reaches the bundle through any field. Plus the stalled-sync drill: throttle, auth and offline failures in turn must each show as quota, auth or network.
- Test: `npx tsx --test packages/engine/tests/host/bundle.test.ts`

**host-7 · MCP adapter and CLI.** Sonnet, Opus review · day 12 · cut first.
- Files: `apps/desktop/src/host/{mcp,cli}/**`, `apps/desktop/tests/eng-host/mcp.test.ts`.
- Done: a stdio MCP server and a CLI over the socket. Tools are generated from methods tagged `read` or `draft`. `send` and destructive actions need an explicit grant and an in-app confirmation (the engine emits the request; the dialog is `ui-settings`').
- Check, "tool overreach": an MCP tool sends, deletes or reads a `secret` method without a grant and a confirmation.
- Test: `npx tsx --test apps/desktop/tests/eng-host/mcp.test.ts`

**host-8 · Swift spike.** Sonnet · days 12-13 · cut second · outside the product (a scratch directory outside the repo; the result goes in DECISIONS.md).
- Done: a client generated by `swift-openapi-generator` from `generated/openapi.json` calls `View/query`, consumes SSE, and records how unknown string-enum values decode.
- Check: the reviewer confirms the decode behaviour claim by adding an unknown enum value to a response.

**Order.** host-1 → host-3 → feature-11 readiness (day 7 to 8) → host-5 → host-7 on one track; host-2 → host-4 → host-6 → host-8 on the other. Two agents at once.

### Methods and conformance ids

Implements `admin.ts`'s `Diagnostics/preview|export|verbose`, `Listener/get|set`, `Clients/list|grant|revoke|audit` (9 `method/*` ids). Desktop methods it serves in main (`Window/*`, `System/*`, `App/info`) are outside the engine suite. The host-agreement test covers them.

### Owner review: feature 11 (lead), menu-bar mode and background sync

The "ready to look at" post, around day 8:

1. Close the Aplos window. Aplos stays in the menu bar and the Dock icon goes away.
2. Open the menu-bar item: it shows the sync state, Open Aplos, Pause sync for 1 hour and Quit Aplos completely.
3. With no window open, a reminder set for one minute from now still appears.
4. Schedule a send, then press ⌘Q. A warning lists the scheduled send before quitting.
5. Close the lid for a minute and open it. The status line says it caught up.

Data: demo mail in an isolated test data directory. Test mode hides the menu-bar item, so the post shows the app's own windows plus a plain readout: the menu's items read from main through Playwright's Electron `evaluate`, the log lines for close, wake and reminder fired, and the `verify-resident.mjs` output. The menu-bar glance and the one-minute lid close stay owner hand-checks (days 14 to 16). The reminder on the real engine is re-checked after the switch. Feature 8: HANDOFF-READY to `ui-settings` around day 11 for the listener, clients and diagnostics panes.

### Risks and cuts

The packaged resident check needs plat-release's fuses on day 7. Menu-bar visuals cannot be captured headlessly (readout above). Brief 1's cut order applies here first: host-7 (MCP and CLI extras), then host-8 (Swift spike). Resident mode and the doorway's security matrix are never cut.

> **What this means:** Aplos keeps running in the menu bar with sync, reminders and scheduled sends working after you close the window. Tools get a locked door that is off until you turn it on.

## 10. Conformance burn-down

The real engine runs the same suite as the stand-in from day 5 (`contract-2`). The starting list is about 140 ids: 121 `method/*` plus the failing scenario ids. The exact list is recorded on day 5. It only shrinks.

| Owner | `method/*` ids | Scenario ids | Expected off the list by |
|---|---|---|---|
| `eng-contract` | 7 | `envelope/unknown-method`, `envelope/desktop-method`, `envelope/validation`, `session/handshake`, `changes/catch-up`, `changes/foreign-epoch`, `changes/below-floor` | day 7 |
| `eng-store` | 1 (`Data/export`) | (enables `changes/below-floor`) | day 10 |
| `eng-views` | 22 | `window/*` (6), `receipts/natural-order`, `act/selector`, `undo/restores-thread`, `envelope/not-found`, `envelope/idempotent-opId`, `frames/stamped-and-ordered`, `reset/void-windows` | day 11 |
| `eng-time` | 12 | none | day 10 |
| `eng-ai` | 35 | `setup/status-shape` | day 11 |
| `eng-html` | 10 | none | day 10 |
| `eng-host` | 9 | none | day 11 |
| Providers (`prov-gov` 10, `prov-gmail` 4, `prov-gmail-write` 2, `prov-cal` 9) | 25 | none | when those lanes land |

Day-by-day target (ids left): day 5 about 140; day 7 about 120; day 9 about 70; day 10 about 40; **day 11: 25 or fewer, all Providers-owned.** `methods/coverage` passes from day 4. The `receipts/<mode>` ids skip on an engine without forced orderings.

**Two dependencies to settle on day 4.** (1) `SampleContext` finds ids through `Account/get` (`prov-gov`'s `methods/account.ts`). Without it most samples fail, whatever their lane. REQUEST to `prov-gov`: a store-backed `Account/get` by day 9. If that is not possible, `eng-views` writes it with `prov-gov`'s written approval on the PR. (2) The day-11 gate ("conformance green on the real engine") is read as **every engine-owned id passes and only Providers-owned `method/*` ids remain listed**. The Integrator confirms this reading in a DECIDED entry, so the switch on days 11 to 13 is not held by Providers' dates.

> **What this means:** A daily count shows how close the real engine is to the stand-in. By day 11, everything the Engine thread owns passes; only the Gmail and calendar team's methods may still be pending.

## 11. Day-by-day schedule and peak agents

Day 4 is Friday 2026-10-30; day 13 is Sunday 2026-11-08. Cells list the WPs running that day; **R** marks the day's adversarial reviews (Opus, short, staggered). Start order on day 4: `contract-1`, `store-1`, `store-2`, `views-1` first thing, then `contract-2`, `time-1`, `html-1`, `ai-1`, `host-1`, `host-2`, `html-2`, then `contract-5` on the free tier.

| Day | `eng-contract` | `eng-store` | `eng-views` | `eng-time` | `eng-ai` | `eng-html` | `eng-host` | Agents (Claude impl + free + reviewers) |
|---|---|---|---|---|---|---|---|---|
| 4 (Fri 10-30) | c1, c2, c5(free); R c1 | s1, s2 | v1 | t1 | a1 | x1 spike, x2 | h1, h2 | 11 + 1 + 1 = 13 |
| 5 (Sat 10-31) | c3, c2, c5(free); R c2 | s1, s2; R s1 | v1, v2; R v1 | t1, t2; R t1 | a1, a2; R a1 | x3, x6, x2 | h1, h2; R h1 | 15 + 1 + 3 = 19 |
| 6 (Sun 11-01) | c3, c8, c5(free); R c3 | s2, s3; R s2 | v3, v2 | t4, t2 | a3, a2; R a2 | x3, x6, x2 | h3, h2; R h3 | 15 + 1 + 3 = 19 |
| 7 (Mon 11-02) | c4, c8, c5(free) | s3, s6a, s6b; R s3 | v3, v2 | t3, t2; R t4 | a3, a4(+free move) | x3, x6, x2; R x3, x6 | readiness, h2; R h2 | 16 + 2 + 3 = 21 |
| 8 (Tue 11-03) | c4, c8, c6(free); R c8 | s4, s6a, s6b; R s4 | v3, v2; R v2, v3 | t3, t2; R t2, t3 | a3, a4; R a3 | x4, x5 | readiness, h4 | 15 + 1 + 3 = 19 |
| 9 (Wed 11-04) | c4, c7 | s5, s6a, s6b, s7; R s5 | v5, v4; R v4 | t5, t6 | a5, a4; R a4 | x4, x5 | h5, h4 | 16 + 0 + 3 = 19 |
| 10 (Thu 11-05) | c4, c7; R c4, c7 | s6a, s6b, s7; R s6a, s6b, s7 | v5, v5-perf | t5, t6; R t5, t6 | a5, a6; R a5 | x4, x5; R x4, x5 | h5, h4; R h4 | 15 + 0 + 4 = 19 |
| 11 (Fri 11-06) | desk, burn-down | fixes | v5; R v5 | fixes, feature-12 prep | a6, a7; R a6, a7 | feature-13 post | h5, h6; R h5 | 8 + 1 + 3 = 12 |
| 12 (Sat 11-07) | c7 swap onto host-4; R | none | switch support | feature-12 post | HANDOFF to ui-ask | feedback | h7, h6; R h6, h7 | 5 + 0 + 2 = 7 |
| 13 (Sun 11-08) | desk | none | switch support | feedback | none | feedback | h8 (cut-able) | 3 + 0 + 1 = 4 |

Short names: `c` = contract, `s` = store, `v` = views, `t` = time, `a` = ai, `x` = html, `h` = host; "readiness" = feature 11's capture and readout.

**Peak.** Seven lane workflows run at once (roadmap 5.1). The peak is **21 concurrent agents on day 7**: 16 Claude implementers, 2 free-tier agents and 3 adversarial reviewers. The implementers are 8 on Opus (c4, c8, s6a, v2, v3, t2, x3, x6) and 8 on Sonnet, and reviews are staggered so at most 3 run together. Days 5, 6 and 8 to 10 sit at 19. If Claude's 5-hour limit hits, apply section 1's throttle order. The critical tracks (`store`, `views`, `time-2`, the sealed frame, `contract-1` and `contract-4`) keep running.

**Milestones in this table.** Day 5: the runtime merged, extension types published. **Day 6: the real commit with extensions, `Clock` and the timer loop, demo data (critical path).** Day 7: `laneFor` live in ingest, bodies stored. Day 8: feature 11 ready to look at. **Day 9: bodies, paced FTS, retention.** **Day 10: importer and benchmark; `eng-time`, `eng-html`, `eng-contract` lane work complete.** **Day 11: conformance green on the real engine (section 10's reading); `eng-ai` and `eng-views` complete; feature 13 ready.** Day 12: doorway complete, feature 12 ready (with `prov-gmail-write`).

> **What this means:** Most of the work runs on days 4 to 10 with about 19 to 21 agents at a time. The busiest day is day 7. By day 11 the real engine is ready for the screens.

## 12. Requests to post on day 4

| To | Request | Needed by |
|---|---|---|
| integrator | Seam 4's ownership additions; seam 3's standing approval (DECIDED); the day-11 gate reading (section 10); create the `packages/mail-html` workspace | day 4 |
| `prov-gov` | A store-backed `Account/get` for conformance; the governor base-class date for `eng-ai`; review of the legacy-op mapping for the importer (store-6a) | day 9; day 7; day 9 |
| `prov-emu` | Gmail emulator with send fault injection and delivery counting for time-6's kill-point matrix; agree the shared harness and fake clock | day 9 |
| `prov-gmail`, `prov-gmail-write` | Use the day-5 extension types (`BodyWrite`, `AttachmentWrite`) and `KnownLookup`; `send`, `findSent` and `DraftSyncPort` against the frozen ports | day 5 to 6 |
| plat-ci | Vite dev-proxy token for the preview host (`vite.config.ts`); run `apps/desktop/tests/<lane>/**` in `npm test`; the Playwright base for the leak harness; the self-test job inside Electron's Node | day 8; day 5; day 6; day 7 |
| plat-release | One shared `webRequest` handler module in `main/security.ts` for the mail-frame backstop; fuses and macOS 13 for the packaged resident check | day 8; day 7 |
| ui-shell | Who owns the row cache and window store (contract-8's scope); wire `APLOS_ENGINE=fixture|real` | day 5; day 10 |
| ui-reader | Switch `MailFrame` from the stand-in's `srcdoc` to `url` when html-4 lands | day 10 |
| ui-onboard | host-1's hooks are ready to plug `main/windows/onboarding.ts` into; hand over `tests/onboarding.test.ts` to `eng-ai` | day 5 |

> **What this means:** A handful of small asks to other teams go out on day one, so no lane waits on another by surprise.

## 13. Decisions for you

None. Every choice in this plan follows the roadmap, plan 10 or a decision already recorded. The open items (the four seams, the reading of the day-11 gate, ownership of a few unlisted files) are coordination questions for the Engine thread and the Integrator, posted in STATUS.md on day 4. Nothing here needs your accounts, money or a change to the design.

> **What this means:** You don't need to do anything for this plan. You will hear from this thread when menu-bar mode, the safety frame and sending are ready to look at.
