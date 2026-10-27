# Workstream plan 10: Engine foundation and local server

Written 2026-10-27 on branch `revamp`. Planning only: nothing here is implemented, nothing goes to main without the owner, and PR #21 stays unmerged.

**Binding inputs.** `plans/ARCHITECTURE.md` (ARCH, by section) and `plans/DESIGN.md` (DESIGN). Where research and `plans/_council/CONTEXT.md` disagree, CONTEXT wins: releases are Developer ID signed and notarized; provisioning profiles do not exist; the repo is private; Google OAuth is in Testing mode; Microsoft has no client ID; the first real Gmail sync failed with 403.

**Conventions.** `RC/` is `research/email-clients/`. Labels as in ARCH: **[V]** verified in a file I read, **[M]** measured in a research report, **[I]** inference, **[U]** unverified, to be checked live. "Today" is Aplos main at `72095ff` (v0.2.3). Paths are relative to the repo root. Milestones are **E0 to E8** to avoid clashing with ARCH's M0 to M10 (full mapping in 4.0). Other plans cite plan 10's work by these E-numbers, with ARCH's M-number in brackets where useful. Plan 20's live experiments are named EX1 to EX11, a different thing. The master schedule, threads and branch rules are in `plans/00-roadmap.md`.

## In plain English

The engine holds your mail, talks to providers, remembers what you did and tells the screens what to show. Today it keeps the whole mailbox in memory, forgets changes when it restarts, and stops when you close the window.

This plan rebuilds the engine in nine small steps. Your mail moves into a proper database that opens in milliseconds at any size, and the old file is never touched, so you can go back. Screens load small windows of rows, so a 100,000-message mailbox feels like a 100-message one. Emails display in an isolated frame. AI work runs in a queue that starts only after you agree and never slows syncing. Scheduled sends, undo send, reminders and Later run on one clock that survives restarts. Last, a locked local connection lets tools and a future phone app use the same engine.

What changes for you. Mail keeps working with the window closed, an archived email stays archived, and a stalled sync can be explained. Screen work starts in week two against a stand-in engine. Today's screens keep working throughout.

Nothing here reaches main until you say so. You need to answer 11 questions below.

## Decisions for you

Each question has a recommended default. The plan uses the defaults unless you say otherwise. Architecture decisions 5, 6, 7, 9, 13 and 14 also apply. Decisions 9 and 10 change the schedule most.

| # | Question | Options | Recommended | What happens |
|---|---|---|---|---|
| 1 | When the last window closes, should the Dock icon go and Aplos live in the menu bar? | (a) Menu bar only; (b) keep the Dock icon | **(a)** | (a) shows Aplos is still working, and ⌘Q still quits fully. (b) feels normal but leaves people unsure whether mail is syncing. |
| 2 | Warn on ⌘Q when scheduled sends or reminders are waiting? | (a) Warn, with the count; (b) quit silently | **(a)** | (a) costs one click and stops a send from missing its time. |
| 3 | A reminder came due while the Mac slept. What happens on wake? | (a) Fire at once, "was due 9:00"; (b) wait until you open Aplos | **(a)** | (a) never loses a reminder. (b) can leave one unseen for hours. Sends ask first instead (architecture decision 9). |
| 4 | What happens to the old `aplos.db` after the move? | (a) Keep it until 0.4.0 is stable, then offer "Remove old copy"; (b) delete it after 30 days; (c) keep it forever | **(a)** | (a) keeps the way back and never deletes without you. (b) removes the backup on a timer. (c) wastes disk. Going back loses only what you did locally after the move. |
| 5 | Is the local connection for tools on by default in the shipped app? | (a) Off until you switch on "Allow tools on this Mac"; (b) on, with a key per tool | **(a)** | (a) exposes nothing on a fresh install. (b) runs a listener you did not ask for. Developer builds have it on. |
| 6 | If the mail database is damaged, what happens? | (a) Stop, keep the damaged file, and offer Export report, Restore backup or Rebuild from your provider; (b) rebuild automatically | **(a)** | (a) protects drafts and scheduled sends that exist only on this Mac. (b) can lose them silently. |
| 7 | Ask 0.2.x users for AI consent again on upgrade? | (a) Ask once, naming provider and model; (b) treat today's use as consent | **(a)** | (a) is one card and makes later AI use provably consented. (b) skips the card but leaves consent unproven. |
| 8 | Free Gemini keys may train on what you send. How should Aplos treat a Gemini key? | (a) Never use it for mail until you tick "this is a paid key"; (b) trust it | **(a)** | (a) is safe, and Ask still works on non-mail content. (b) may send mail to a provider that trains on it. |
| 9 | When may the UI thread start building against the planned engine commands? | (a) From a preview at about day 5, against a stand-in engine, then switch to the real one; (b) wait for the real store (about week 5) | **(a)** | (a) overlaps UI and engine work. (b) idles the UI for about three weeks. |
| 10 | If engine work runs long, which piece waits? | (a) The isolated email frame (E4); (b) the AI queue (E5); (c) everything shifts later | **(a)** | (a) keeps sending, storage and live lists on time, because today's frame is safe enough for one user. (b) leaves Home without budgeted AI. (c) delays Gmail and the other providers. |
| 11 | Run an extra architecture thread for the email frame (E4) and the local connection (E7)? | (a) No, keep two architecture threads and revisit at week 4; (b) yes, from the start | **(a)** | (a) keeps your review load low. (b) finishes those pieces about two weeks sooner but risks colliding edits. |

## 1. Scope and non-goals

**In scope (the whole engine core).** (1) The normalized store, migrations and import (ARCH 3). (2) The change log and live windows (ARCH 3.5, 9.2). (3) The typed contract and registry in `packages/contract` (ARCH 9). (4) Transports: direct `MessagePort`, Unix socket, loopback HTTP, with the A2 phone binding only as a reserved extension point. (5) The AI queue, budget, consent, heuristic buckets and `Setup/*` replacing `deferAI` (ARCH 8). (6) Timed features: outbox, undo and send later, Later and reminders, one timer loop, notification outbox (ARCH 7). (7) Lifecycle: resident menu-bar engine, lock, wake, crash parking, watchdogs (ARCH 2). (8) Diagnostics: redacted logs, event catalog, content-free bundle, queue inspector (ARCH 11). (9) Engine-side HTML: sanitizer, render tokens, image proxy, headers (ARCH 10). (10) A demo-data fixture engine implementing the whole v1 contract (4.1). (11) The temporary legacy bridge that keeps today's screens and the not-yet-rewritten providers working on the new store (4.2).

**Non-goals.**
- Per-provider protocol code, the governor's implementation, account-actor sync logic, OAuth, provider-side drafts, filters, calendar sync (plan 20). This plan defines the ports they implement (7.1).
- Any UI: menu-bar artwork, Settings panes, consent card, frame React code, shortcut registry (plan 30).
- Fuses, `LSMinimumSystemVersion`, entitlements, host-page CSP, signing, update feed, CI platform, formatter, licence and secret-history audit (plan 40). This plan verifies them in the packaged app.
- A1 (LaunchAgent) and A2 (phone host, LAN, pairing): deferred with ARCH's triggers (2.6, 13.2).
- SQLCipher, raw-MIME archives, telemetry or crash upload, JMAP batching or `queryChanges`, Windows or Linux.
- Reference-project code, assets or wording. Only ideas enter Aplos (ARCH 14.1); every brief repeats this.

> **What this means:** The whole engine core is in scope: storage, change feed, contract, doorways, AI queue, clocks, lifecycle, diagnostics and safe email display. Provider code and screens belong to the other plans.

## 2. Ground truth today

All **[V]** against main at `72095ff`.

- **Layout.** `apps/desktop/src/engine/` has 16 files, led by `service.ts` (961 lines, one `createService` closure sharing `state`, `listeners`, `timers`, `emit`); `packages/` is empty. The engine bundles for `platform:'neutral'` under 400,000 bytes (`tests/portability.test.ts`, which reads the engine folder non-recursively and also imports `src/main/store`, `groq` and `memory-stage`; 146,544 bytes per `MOBILE.md`).
- **Coupling that the move must untangle.** The engine imports six files from `src/shared` (`types`, `ask`, `mailbox`, `summary`, `version`, `live`); `shared/version.ts` re-exports `apps/desktop/package.json`; `shared/types.ts` imports `engine/provider`; about 40 files outside the engine (`src/main`, `tests`, `scripts`, `AddAccount.tsx`, `DomainCheck.tsx`) import `engine/*`; `scripts/build-main.mjs` bundles with `packages:'external'`; adapter dependencies (`imapflow`, `mailparser`, `nodemailer`, `fast-xml-parser`, the SDKs) are declared only in `apps/desktop/package.json`.
- **Store.** `aplos.db` is schema version 3 (`src/engine/store.ts:5-35`): `threads(id, account_id, date, status, data JSON)` holds whole threads with every message and its HTML; small collections are `(id, pos, data JSON)`; plus `ops`, `sync_cursors`, `provider_memory`, `meta` and an inline FTS5 table. Everything loads into one `AppState`, diffed by serialised signature.
- **Change feed.** `epoch=randomUUID()` per start and an in-memory `rev` (`service.ts:232`): every restart forces a re-snapshot (`RC/gaps/engine-contract-rpc-stack.md` §1).
- **Contract.** `invoke(method, payload)` plus events; the allowlist exists three times with different contents (66 in `preload.ts`, 47+18 in `electron.ts`, 47+15 in `server.ts`). Validation is hand-written in `service.ts:58-130`; its human sentences are what the UI shows.
- **Transport and mirror.** Renderer, preload, main, utility process (`electron.ts:224-290`); main mirrors state in `latestState` (`:38, :207`) for notifications, appearance, validating `window.compose` (`:183`) and re-sending state on `did-finish-load` (`:110`); the renderer also calls `state.get {threadLimit:400}` on mount (`App.tsx:107`).
- **Timers and sends.** A 30 s reminder `setInterval` (`service.ts:957`), a 60 s auto-sync interval, per-draft `setTimeout` sends; send state lives in `Draft.pendingSendAt`, `sendAttemptAt`, `resendConfirmed`.
- **Lifecycle, AI, observability.** No resident mode, `powerMonitor` or lock file; a crash guard of 3 exits in 60 s (`electron.ts:243-250`). `deferAI` is an in-memory set whose leaks PR #21's review found six times (`research/pr21-onboarding-review.md`); no job queue or consent record. No logs. Email HTML renders through `dangerouslySetInnerHTML` (`renderer/Reader.tsx:169`). The preview server (`npm run dev`, `src/main/server.ts`) checks `Host` and `Origin` against an allowlist (`isTrustedRequest`, `:21`) but has no token, so any local process, or any request without an `Origin`, can call every method including `draft.send`.

> **What this means:** Today's engine works but holds everything in memory, forgets everything on restart, and can only be reached through the app's window. Each fact has a milestone below.

## 3. Target layout and ownership

```
packages/contract/          zod schemas, registry, generated files, typed client, WindowStore        [10]
  src/schemas/, src/registry.ts (~500 lines), src/client/, generated/ (methods.generated.ts, openapi.json),
  src/legacy/ (today's shared/{types,ask,mailbox,summary,live}.ts, moved in E1, deleted in E8)
packages/engine/            neutral core, no Node or Electron                     [10; 20 owns sync/** and calendar/**]
  src/{store,views,outbox,ai,runtime,methods,diag}/, src/ports.ts (ProviderAdapter, Provider, Governor,
  Send, DraftSync, Clock, KeyProvider, MailHtml ports), src/sync/**, src/calendar/** (recurrence), bench/, tests/
packages/mail-html/         sanitizer: pure JS, no DOM, no Node, bundled separately                   [10]
packages/contract-fixture/  stand-in engine on demo data; same conformance suite as the real engine   [10]
packages/emulators/         provider emulators, fault kit, fake clock; test-support only, never bundled [20; 10 and 40 consume]
apps/desktop/src/host/      Node adapters: sqlite.ts, transports/{port,socket,http}.ts, protocol/,
                            lifecycle.ts, menu-bar.ts, power.ts, lock.ts, logsink.ts, crash.ts, mcp/, cli/,
                            providers/{google,microsoft,imap,jmap,caldav,shared}/                     [10; providers/ is 20]
apps/desktop/src/shared/    one-line re-export stubs of the moved legacy files, so renderer and main imports
                            keep working; removed in E8
apps/desktop/src/main/      electron.ts is split in E1 into windows.ts, lifecycle.ts, protocol.ts,
                            menu-bar.ts, native-methods.ts
```

**Package locations (settled).** ARCH ADR-19 names three packages (`contract`, `engine`, `mail-html`). This plan adds two test-support packages and decides where adapters live, as an amendment to ADR-19 (recorded in ARCH's amendments section on 2026-10-27, and in DECISIONS.md at E1). Plan 20 section 3.1 uses the same paths:
- `packages/contract-fixture`: added because the UI thread and CI share it and its demo data must stay out of the 400 KB core budget (4.1).
- **Provider adapters stay in the app**, at `apps/desktop/src/host/providers/<name>/` (plan 20 proposed `packages/providers`; rejected for now). Adapters need Node (`imapflow`, `net`, `fetch`), so they cannot sit in the neutral `packages/engine`, and ARCH names no fourth shipping package. Their dependencies are declared in `apps/desktop/package.json`, which is the only manifest electron-builder reads, so keeping them there avoids a packaging break. Actors, governor, lanes and the status machine are neutral and live in `packages/engine/src/sync/**`, reaching adapters only through the ports in `packages/engine/src/ports.ts`. Promotion to a `packages/providers` workspace is a later mechanical move, allowed only when a second consumer (a CLI, or A1's SEA engine) needs the adapters.
- E1 creates the empty `host/providers/` folder and its lint boundary. The existing adapters (`google.ts`, `imap*.ts`, `jmap.ts`, `microsoft.ts`, `caldav.ts`, `ical.ts`) stay in `src/main/` and are moved by plan 20 inside each provider's rewrite PR, so the E1 window moves no provider code.
- `packages/emulators` is shared by plans 10, 20 and 40, is test-only and is never bundled into the app. It does not count against ADR-19's "shared code" rule because nothing ships from it.
- The framework-neutral client lives at `@aplos/contract/client`, not in a fifth package, so `packages/contract` keeps zod as its only runtime dependency.

**Build and packaging wiring (E1, a deliverable not an assumption).** Workspace packages are **internal source packages**: `exports` point at TypeScript source, no separate build step. `scripts/build-main.mjs` uses `packages:'external'`, which would leave `@aplos/*` unbundled and missing from the packaged app, so the build marks only third-party packages external (an `external` list or a plugin that bundles `@aplos/*`) **[U: esbuild may apply tsconfig paths before the external check; the packaged `verify-release.mjs` run settles it]**. `tsx` resolves workspace packages through the npm symlinks; Vite gets an alias for the renderer; `tsconfig` gains `paths` and `references`. Third-party dependencies of package code (zod) are declared once in the package's own manifest and checked by `verify-release.mjs` to be present in `app.asar`; adapter dependencies stay in `apps/desktop/package.json`.

| Path | Plan 10 | Plan 20 | Plan 30 | Plan 40 |
|---|---|---|---|---|
| `packages/contract/**` | owns | adds provider schemas by PR | consumes; proposes by PR | golden tests in CI |
| `packages/contract-fixture/**` | owns | adds scenarios by PR | adds UI scenarios by PR | uses in E2E |
| `packages/engine/src/{store,views,outbox,ai,runtime,methods,diag}` | owns | consumes | none | lint rules |
| `packages/engine/src/sync/**`, `packages/engine/src/calendar/**`, `host/providers/**`, provider files in `src/main` (until each moves) | defines ports | owns | none | none |
| `packages/emulators/**` | consumes (kill-point harness) | owns | none | consumes in CI |
| `main/electron.ts` split modules | lifecycle, protocol, menu-bar, native methods | none | window creation, onboarding window | fuses, permission handlers, updater |
| `renderer/**` | the typed-client codemod and import fix-ups in E1 only | none | owns | none |
| `PROGRESS.md`, `DECISIONS.md`, `TODO.md` | append per milestone | append | append | append |

**Engine-bundle budget.** The neutral engine stays under 400,000 bytes. No report measured zod plus the engine [I]; E1 does. If over: `zod/mini` and tree-shaking; validate at the host boundary only; then a measured, recorded budget increase. A failing portability test is never silenced.

> **What this means:** Each folder has one owner, and the places where plans meet are named in advance. The engine core stays portable so a phone version remains possible.

## 4. Milestones

### 4.0 Overview and mapping to ARCH's M-milestones

| Milestone | ARCH M | Goal | Thread | ARCH nominal weeks | Plan weeks | Agent-days | Release |
|---|---|---|---|---|---|---|---|
| E0 | M0 (logging only) | Redacted log and error-record shape | P | 0-1 | 0-1 | 2-3 | 0.2.4 if ready (joins PV0's train; PV0 never waits) |
| E1 | M1 | Packages, registry, resident mode, fixture engine, contract preview C0 and freeze C1 | P (S joins after WP1.1) | 1-2 | 1-2 (C0 day 5, C1 day 10) | 9-12 | with plan 40's fuses |
| E2a | M2 | Schema, migrations, ids, `store.commit`, rollups, change log | S | 2-3 | 1.5-3 (hard date: end of week 3) | 5-6 | |
| E2b | M2 | Importer, legacy bridge, bodies, paced FTS, retention, benchmark | P | 2-3 | 2.5-4.5 | 9-11 | **0.3.0** with plan 20's M3 |
| E3 | M4 (engine half) | Live windows, direct MessagePort, main out of the data path | P | 4-6 | 4-6.5 | 10-12 | 0.3.x, when the owner approves |
| E4 | M4 (HTML half) | Engine-side HTML: sanitizer, tokens, image proxy | P | 4-6 | 4-7.5 (slack: needed by plan 30's U6 at week 7) | 8-10 | 0.3.x or 0.4.0 |
| E5 | M5 | AI queue, budget, consent, heuristic Home, `Setup/*` | P | 5-6 | 5.5-7.5 | 6-8 | |
| E6 | M6 | Outbox, drafts, one timer loop, notification outbox | P | 6-7 | 6-8 | 7-9 | |
| E7 | M9 | Local listener, OpenAPI, MCP, diagnostics bundle | P | 9-10 | 9-10.5 | 8-10 | |
| E8 | M10 (engine half) | Hardening, soak, fault injection, shim removal | P with S and plan 20 | 10-11 | 10-11.5 (release soak on the shared candidate, weeks 12.5-13.5) | 5-7 plus 7-day soak | **0.4.0** (about week 14, with plan 30's U9) |

The rest of ARCH's list is not plan 10's: M0's Gmail patch (plan 20), M3, M7 and M8 (plan 20, S thread), the UI (plan 30), fuses and CI (plan 40). ARCH M4 is two milestones here because the work splits cleanly: E3 is data and transport, E4 is email display.

**Releases, reconciled with ARCH section 15 and `plans/00-roadmap.md`.** 0.2.4 is ARCH's M0: plan 20's PV0 on one `hotfix/0.2.4` branch cut from main, which E0 (and plan 30's `srcdoc` stopgap and plan 40's Q0-main and Q5A-main) join only if ready; PV0 never waits for them. **0.3.0 is ARCH's M3 at about week 5-6: E1, E2a, E2b and plan 20's PV3.** The renderer stays on the legacy state through the bridge (4.2) and the new engine ships underneath it; E3 to E6 are not required for 0.3.0. They reach the owner on beta tags cut from `revamp` as each passes its acceptance; a stable 0.3.x is cut only if the owner asks. **0.4.0 is M10 plus plan 30's U9, about week 14:** the engine's own E8 work ends around week 11.5, and the release soak runs on the one release candidate the UI's dogfood week also uses (plan 30 Decision 12; ARCH amendment of 2026-10-27). Stable releases are tagged from main after the owner merges `revamp`; only betas are tagged from `revamp`. (An earlier draft of this plan tied 0.3.0 to E3; that disagreed with ARCH and is withdrawn.)

**Effort and load.** About **69-88 agent-days** across both engine threads (ARCH 15: **S** owns store and sync, **P** owns platform, contract, HTML, AI, outbox, listener). Only E2a is S-thread work, because S must start plan 20's M3 in week 3; the importer, bridge, bodies, FTS and benchmark (E2b) go to P. Effort is working-day equivalents with several agents in parallel; live verification and the owner's review, not coding, are the constraint (ARCH 15). Honest load check: P carries about 63-81 agent-days over roughly 55 working days, so it works only with two to four agents in parallel per milestone and the plan expects E3 to E6 to finish up to about 1.5 weeks after ARCH's nominal dates. That sits inside ARCH's 9-14 week range, and P is free in weeks 8-9 (M7 and M8 belong to S), which is where slack lands.

**Priority and slip rule.** Consumers set the order: plan 20's drafts work needs E6's `submissions` and drafts table in weeks 5-7; plan 30's U6 needs E4 and E6 from week 7.5; U8 builds on the fixture from week 7 and needs E5's real `Setup/*`, consent and `Demo/*` by about week 9. If P falls behind, drop work in this order, last first: E4's tail (it has a safe stopgap in M0's `srcdoc` frame, Decision 10), E5, then E7's MCP/CLI and Swift spike. E3 and E6 are never slipped for E4. E6's timer loop does not wait for E5 (6.1), so E6 may run before E5.

"Adversarial" means a different agent, given the code and acceptance criteria but not the author's conclusions, briefed to make a named check fail.

> **What this means:** Nine steps, each tied to one of the architecture's milestones, with 0.3.0 arriving around week five or six. The engine's own work ends around week eleven, and 0.4.0 ships around week fourteen, once the new screens are finished and tested together with it. The plan is honest that one engine thread is stretched in weeks 4 to 8 and says what waits first if it runs long.

### 4.1 The contract fixture: shape, milestone and handoff

This is the piece that lets plan 30 start in week 2. It is explicit here because three plans depend on it.

**What it is.** `packages/contract-fixture` exports `createFixtureEngine({scenario, seed, clock})`. It implements the whole v1 contract of `packages/contract` against demo data held in memory, behind the same `EngineConnection` interface the real engine's transports implement (`connect(): {call(method,args), subscribe(frames), close()}`). It has no Node or Electron imports, so it runs in Electron, in the browser preview and in a plain test. It is test-support: nothing from it is bundled into the shipped app, and its demo data never enters the 400,000-byte engine budget.

**Shape.**
- **Verbs implemented:** every method in the registry, including `Session/get` (with a `hasAccounts` flag so main chooses the onboarding window or the mail window), `View/watch|move|unwatch|hold|release|query`, `Thread/get|act`, `Operation/undo`, `MessageBody/get|prefetch`, `Mail/frame` and its release, `Draft/*`, `Submission/set`, `Outbox/pending`, `Setup/begin|end|status`, `Ai/request`, `Ask/run` with `progress` frames, `Settings/*` including the `ui` object, `Account/connect|reconnect|grantPermissions|lease` and the rest of `Account/*`, `Sync/request` with fake statuses, `Unsubscribe/run` (today's `thread.unsubscribe`), `Event/set {scope: occurrence|series|following}`, `Event/rsvp`, `Demo/load|reset|remove`, `Queue/list`, `Diagnostics/preview`. Names and schemas of the plan 20 methods (`Account/*`, `Unsubscribe/run`, `Event/*`) are frozen at C1; their real behaviour arrives with PV3 (accounts), PV4 (unsubscribe) and PV8-PV9 (events and RSVP).
- **`Setup/status` shape** (plan 30 section 8.1 item 12): per account `{state, firstWindow: {found?, read, total}, ai: {sorted, total, capped, failed}, backfill: {read, target}, pausedUntil?, reasonCode}`. `firstWindow.found` is an optional estimate, present only when the provider gives one; `firstWindow.total` is the first-window target (about 50 threads), never the mailbox size; `firstWindow` is complete when plan 20 sets `baseline_done_at`; `ai` appears only with stored consent and a provider; `backfill` never gates anything.
- **Frames:** `state`, `window`, `progress`, `reset`, host-channel events (`notify`, `badge`, `appearance`, `reminder`), with `{dbEpoch, seq}` tokens and receipts that arrive before, after or with the frame (the orderings plan 30's overlay must survive).
- **Windows** run over an in-memory sort with real `holdIds` behaviour and the 4-per-second coalescing, so UI timing is realistic.
- **Scenarios:** `empty`, `demo` (today's demo data), `small-10k`, `large-100k` (seeded generator, shared with `bench/store-bench.ts` in E2), `offline`, `needs-reauth`, `backfilling`, `rate-limited`, `partial-threads` (rows with `partial:true`), `send-uncertain`, `send-suspended`, `ai-off`, `ai-budget-spent`, `setup-partial`, `parked`.
- **Test-only control channel** `Fixture/control` (compiled out of production, absent from the registry and OpenAPI): force a status or rate-limit pause, fail the next write, set a submission state, advance setup progress, set the clock (`APLOS_NOW`), replay a frame ordering. This is what plan 30's harness (`plans/30-ui-revamp.md` section 8.1 item 1) asked for.
- **Transports:** (1) in-process for tests; (2) a `MessagePort` pair in Electron dev, so plan 30's typed client is exercised on the same path production uses; (3) a **dev-only loopback HTTP and SSE binding for the browser preview**, built in E1 by turning `src/main/server.ts` into a thin host that serves either the fixture or the real engine. It already requires a random per-run token that the Vite dev proxy adds server-side, closing today's gap (the preview has a `Host` and `Origin` allowlist but no token). E7 later hardens it with the full request matrix; it does not introduce it.
- **Conformance:** `packages/contract/tests/conformance/` runs one suite against any `EngineConnection`: ordering, `holdIds`, coalescing, receipts, error types, `cannotCalculateChanges`, `reset`. The fixture passes at C1; the real engine passes the same file in E3. A fixture-only assertion fails CI, so the two cannot drift.

**Milestones.**
- **C0 preview, E1 day 5.** The registry's method names with zod schemas, the typed client skeleton, the generated allowlists and the fixture serving `Session/get`, `View/watch` and `Thread/get` on the `demo` scenario. Plan 30's U2 can start its data layer against it. Everything is marked provisional.
- **C1 freeze, targeted for E1 day 10 (end of week 2; E1's remaining splits and lifecycle work may run to day 12 without moving C1).** The full list above, the conformance suite green, and the review gate below passed.
- After C1, changes are additive within `v:1`, through a contract PR both threads approve. A needed breaking change bumps `v` and is a plan 30 conversation, not a quiet edit.

**Review gate for C1.** A reviewer briefed from DESIGN section 5 and ARCH 9.2 asks "which UI behaviour cannot be expressed in this contract?", and plan 30's owner signs the freeze. The gate also checks plan 30's twelve asks (`plans/30-ui-revamp.md` section 8.1) against the contract:

| Plan 30 ask | Contract home | Notes |
|---|---|---|
| 1 fixture and control channel | this section | |
| 2 view specs | `View/watch` spec union (E3) | |
| 3 `Thread/act`, `Operation/undo`, receipts, `holdIds`, state tokens | E3 | |
| 4 mail frame | `Mail/frame {messageId, imagePolicy, findQuery}` returning `{url, expiresAt, bodyKind, trackersRemoved, hasRemoteImages, quotedCount}`, plus `Mail/frame.release`, `toggleQuotes` and a per-sender image allow-list in Settings | Plan 10 adopts plan 30's name; E4 builds it. The frame token is the URL's path segment |
| 5 submissions and a draft-changed-elsewhere signal | E6; `Draft/changed` frame | |
| 6 setup and AI governance | `Setup/begin|end|status` (wire name `Setup/end`; DESIGN 7.11's old `setup.end` spelling is retired), `Consent/*`, per-account `aiAllowed`, daily cap in Settings; the primary-device lease and override are plan 20's, exposed as `Account/lease` | |
| 7 `Ask/run` citations `{n, messageId, quote}` | E5 | |
| 8 `ui` settings object, retention and resident-mode toggles | `Settings` schema in E1 (fields), behaviour in E1 and E2b | |
| 9 diagnostics, queue inspector, parked event, capability flags | E7; the `parked` event and `Session/get` capabilities in E1 | |
| 10 `APLOS_TEST=1` in main | E1 lifecycle work (isolated userData, no single-instance lock, Dock icon, menu-bar item or login item; windows created `show:false`) | Plan 40 consumes it in E2E |
| 11 empty start and demo on request | `Demo/load|reset|remove` and `Session/get.hasAccounts` in the registry at C1; real behaviour in E5 item 7 | The fixture honours it from C1 |
| 12 `Setup/status` shape | Shape above; real counts in E5 from plan 20's checkpoints | |

The contract's **Thread row** also carries `partial: boolean` (true while a row was built from one metadata message and its message count is unknown, ARCH 5.1, plan 20 section 2), so the UI never shows "1 message" for a twelve-message thread.

**Handoff.** (1) A README in the package listing verbs, scenarios and the control channel. (2) The conformance suite. (3) The change process above. (4) The typed-client codemod over the 53 renderer `invoke(` sites in 15 files is **plan 10's, run in E1's freeze window, and is the only mechanical rewrite of renderer call sites**; plan 30's U2 verifies and completes it and builds `renderer/data/` on top (plan 30 section 4.1 step 1 and U2 agree). (5) After E3, the flip from fixture to real is a flag; plan 30 flips dev builds to `engineWindows` in its WP5.6 as soon as E3's conformance run is green (about week 6), not at U9, so the real engine meets the real UI weeks earlier (7.2).

> **What this means:** The stand-in engine is a complete, test-checked copy of the engine's behaviour on demo data. The screens team gets a preview on day five and a frozen version on day ten, with knobs to force every awkward situation, and later switches to the real engine with one flag.

### 4.2 The legacy bridge: keeping 0.2.x screens and non-Gmail providers working (E2b to E8)

The migration is only safe if every legacy path keeps working while storage changes underneath it. Until plan 30 flips the renderer to real windows (its WP5.6, right after E3, about week 6-7) and plan 20 rewrites IMAP, JMAP, Graph and CalDAV (PV6-PV10, ARCH M7 and M8, weeks 6-10), the legacy `createService` runs on top of `mail.db`. Release and beta builds cut before the flip keep the renderer's legacy loader on this bridge.

**Design.**
- **Reads.** `assembleLegacyState(limit)` builds `AppState` from SQL: the newest `limit` threads (400 for the renderer's `state.get {threadLimit:400}`, up to 2,000 for the service's own working set), body-less rows; the Reader fetches text through `MessageBody/get`. `{dbEpoch, seq}` is mapped to the legacy `{epoch, rev}` so a restart no longer forces a re-snapshot, and legacy `changes` events are produced from the commit's change set.
- **Writes.** Today the service calls `store.save(diff)` with a `StoreDiff` (changed and removed threads, drafts, accounts, settings, conversations). In the bridge that call is replaced by `legacyStoreAdapter.save(diff)`, which translates one `StoreDiff` into one `store.commit` (upserting threads, messages, bodies and workflow state by natural key, writing `changes`). Drafts, settings and conversations map to their tables. `service.ts` stays unaware of SQL.
- **Capped working set.** The legacy sync merge (`engine/merge.ts`) must never treat "absent from the capped state" as "deleted on the server". The adapter therefore applies deletions only for ids the provider reports as removed, and a sync that returns threads outside the working set is upserted by natural key, not appended. Legacy providers that rely on a full list for deletion (IMAP, JMAP) run in `full-list` mode: the adapter reads the account's remote ids from SQL for that comparison.
- **Gmail.** Until plan 20's M3 lands, the legacy Gmail sync (with M0's thin first window) writes through the same adapter. M3 replaces it by writing through `store.commit` directly.
- **Lifetime.** Created in E2b, shrinks as plan 20 replaces each provider and plan 30 reaches windows, and is deleted in E8 (`assembleLegacyState`, the adapter, `contract/src/legacy`, the legacy op kind).

**Acceptance (E2b).**
- The full existing node test suite (`tests/service.test.ts`, `sync-safety`, `queue`, `workflow`, `scale`) passes against `mail.db` through the bridge with no test deleted.
- IMAP and JMAP emulator runs of a 5,000-thread mailbox with a 2,000-thread working set produce no duplicate, no false deletion and the same final state as the legacy store.
- A 0.2.x renderer build runs against the bridge: it lists, triages, saves a draft and reconnects after an engine kill without a full re-snapshot.
- Kill the engine mid-save: the next start shows the pre-save or the post-save state, never half.

> **What this means:** For about five weeks the old screens and the older providers run on top of the new database through a translator. It is temporary, it is tested like everything else, and it is what lets you keep using Aplos while the foundation changes.

### E0. Observability stopgap (ARCH M0)

**Goal.** Make the next real Gmail failure explain itself. Today a rate-limit 403 is retried and swallowed and no log exists (`RC/protocols/proto-google.md` §1; ARCH 11).

**Deliverables.**
- **Where it lands.** E0 is cut from main, where `packages/` is empty and `host/` does not exist. The logger goes in `apps/desktop/src/engine/diag/log.ts` and the sink in `apps/desktop/src/main/logsink.ts`; E1's pure-rename commit moves them to `packages/engine/src/diag/` and `apps/desktop/src/host/`. Nothing in E0 may import from a path E1 creates.
- `Logger` port and `diag/log.ts`: `event(id, fields)` with `id` from a typed catalog (`sync.gmail.request_refused`, `governor.paused`, `send.uncertain`) and a zod schema per event, so an unlisted field cannot be logged.
- Host sink `logsink.ts`: JSON lines in `~/Library/Logs/Aplos Mail/`, 10 MB x 5 rotation, files 0600, directory 0700.
- Root redaction by allowlist: no tokens, keys, `Authorization`, bodies, subjects or snippets; addresses as salted hashes (per-install salt in `meta`); provider error text passes a redactor that hashes anything address-shaped and truncates to 300 characters.
- The classified-error record `{class, reason, status, code, retryAfterMs, providerMessage}` as a contract type, so plan 20's governor fills the same shape later.

**Ownership and dependencies.** Plan 10 writes logger, sink, catalog; plan 20's PV0 adds the Gmail call-site log lines, coded against E0's `Logger` interface. If E0 is not ready when PV0 is, PV0 binds that interface to a minimal redacted stub and E0 follows later; PV0 never waits. Branch off main (section 9). The classified-error record is defined in the logger module on main and moves to `packages/contract` at E1 with the rename.

**Acceptance.**
- A unit test pushes a fake 403 `{reason:"rateLimitExceeded", message:"User-rate limit exceeded"}` through a stub call site and asserts one line with that reason and status 403 and no address, token or subject.
- Canary test: fixtures with `CANARY-xxxx` in subjects, bodies and tokens drive sync, send and error paths; grep over the log directory finds zero.
- File modes and rotation at a small injected cap are asserted. Output pasted into PROGRESS.md.

**Estimate.** 2-3 days.

**Work packages.** WP0.1 (one agent): catalog, schemas, logger, redactor. WP0.2 (one agent): sink and rotation. Adversarial: a second agent writes ten hostile log calls (token inside an error message, address inside a URL, subject inside a thrown error's `cause`, nested bodies) and must make any appear in a file.

> **What this means:** Aplos learns to keep a private, safe diary of what Google actually said. It holds no email content, so it can be shared.

### E1. Groundwork: packages, registry, resident mode, fixture engine (ARCH M1)

**Goal.** Create the structure everything builds on, keep every commit launchable, and give the UI thread a contract preview by day 5 and a frozen contract plus a stand-in engine by the end of week 2 (Decision 9; 4.1).

**Deliverables.**
0. **Day-1 sequence (the freeze window, section 9).** In order, each its own commit, plans 20, 30 and 40 rebasing after each: **step 0, merge main into `revamp`** (0.2.4 if it has merged, otherwise whatever main holds by day 5; a late hotfix slice comes in afterwards through plan 40's `format-merge.mjs`); (a) this plan's rename-and-imports commit (item 1); (b) **plan 40's Q1a format commit** over the post-move tree; (c) the `packages/contract` skeleton; (d) the typed-client codemod (item 3), on formatted code; (e) plan 40's Q1b (lint, suppressions on final paths, hook); then the `service.ts` split (item 2) begins. `.git-blame-ignore-revs` lists (b). Q1a is path-agnostic, so if it is ready before the move the two may swap; what must never happen is Q1b before the move or the format commit after the codemod. Plan 40 states the same order (its Q1 freeze-window table and section 5, point 1).
1. **Mechanical move (days 1-2), one commit that is a rename plus import-specifier edits only; no other content change.**
   - `git mv apps/desktop/src/engine packages/engine/src`; workspaces `@aplos/engine`, `@aplos/contract` as internal source packages; tsconfig `paths` and Vite alias.
   - The engine's `src/shared` dependencies move with it: `types`, `ask`, `mailbox`, `summary`, `live` go to `packages/contract/src/legacy/`, and `apps/desktop/src/shared/<name>.ts` becomes a one-line re-export stub so renderer and main imports compile unchanged. The provider types that `shared/types.ts` takes from `engine/provider` (`AccountPreset`, `ProviderCapabilities`, `ProviderKind`, `ServerSettings`) move to `contract/src/legacy/provider-types.ts` and `engine/provider.ts` re-exports them, which prevents a contract-to-engine cycle.
   - `shared/version.ts` stays in the app (it re-exports `apps/desktop/package.json`); the engine receives `appVersion` through `EngineInit`, a one-line change at `service.ts:4`.
   - A checked-in script (`scripts/codemod-imports.mjs`) rewrites the roughly 40 importers (`src/main`, `tests`, `scripts`, and the renderer's `AddAccount.tsx` and `DomainCheck.tsx`, which import `engine/discover` and move to `@aplos/engine/discover` until plan 30's U2 puts them behind `Account/discover`).
   - `tests/portability.test.ts` moves to `packages/engine/tests/`, **walks `src/` recursively from one `src/index.ts` entry** (today it lists the folder's top-level files, so subfolders would be silently skipped), forbids `electron` and `node:` imports, and gets a negative test that plants a `node:fs` import in a subfolder and expects failure. Its checks of `src/main/store`, `groq` and `memory-stage` stay in `apps/desktop/tests/engine-host.test.ts`.
   - Build wiring as section 3 describes (esbuild bundling `@aplos/*`, tsx, Vite, electron-builder dependencies), proven by `npm run package` and `verify-release.mjs`.
2. **Split `service.ts` along its seams, tests green per commit.** First, serially, a `RuntimeCtx` (state, publish and emit, listeners, timers, requests, store, clock, id source, `account()`, options) is introduced inside the existing closure and the seam functions are rewritten to take it, with no file moves (the seams share closure variables, so they cannot be cut out in parallel). Then one agent per seam moves its code, merged in order. Seams [V]: validation (`:58-130`); state, publish, epoch (`:225-267`); op flush and sync (about `:290-340`); drafts, send, timers (`:339-410`, `:758-790`, `:953-959`); Ask and AI (`:479-560`, `:816-916`); calendar (`:916-950`). Target: `runtime/` plus `methods/<area>.ts`, no module over about 300 lines.
3. **Registry steps 1 and 2** (`RC/gaps/engine-contract-rpc-stack.md` §7): zod input schemas for the 47 engine and 19 desktop methods; `host: engine|desktop`; generated `methods.generated.ts` imported by preload (which never imports zod); `electron.ts` and `server.ts` sets derived from it; a host-agreement test; a typed client (`api.thread.update(...)`) and the codemod over the **53 renderer `invoke(` sites in 15 files**, which is this plan's work and not plan 30's U2 (4.1). Hand-written validators are replaced one method at a time keeping their human sentences. `z.config({jitless:true})` in the renderer (CSP forbids eval).
4. **Resident mode and lifecycle** (`RC/gaps/macos-daemon-lifecycle.md` §9; ARCH 2.2-2.4):
   - closing the last window keeps main and engine alive; accessory activation policy with no window (Decision 1); menu-bar item with sync state, Open Aplos, Pause sync for 1 hour, Quit Aplos completely; ⌘Q is a full quit with the pending-work warning (Decision 2); `wasOpenedAtLogin` starts windowless (the login item is registered through the existing `system.login` method);
   - `powerMonitor` `resume` and `unlock-screen` call `engine.wake()`; a wall-clock jump over 30 s between 1 s ticks is the fallback;
   - `run/aplos.lock` (pid and start time; dead-pid locks reclaimed) so a second engine on the same data refuses to start; the browser preview keeps its own data directory (AGENTS.md);
   - states `starting | ready | parked`; 3 s drain on quit or update; the 3-exits-in-60-s guard extended to `parked` with "Export diagnostics / Try again" (the report arrives in E7; until then it reveals the log folder); the `parked` event and `Session/get` capabilities are in the contract from C1;
   - event-loop-delay monitor (log p99 over 500 ms) and an actor-heartbeat supervisor that restarts a silent actor alone after 2 minutes (plan 20 builds actors).
5. **SQL port and self-test:** `Uint8Array` values and `iterate()`. One function, `packages/engine/src/selftest.ts`, asserts `sqlite_version()` at least 3.43, FTS5 present and `contentless_delete` working, because `node:sqlite` follows Electron's SQLite (`RC/gaps/storage-engine-benchmark.md` §7). It has two launchers: CI runs it inside Electron's own Node (plan 40's `ELECTRON_RUN_AS_NODE=1` job, unpackaged), and the packaged app runs it as `Aplos Mail --selftest`, a main-process flag that forks the engine `utilityProcess`, prints JSON and exits. The packaged launcher must not use `ELECTRON_RUN_AS_NODE`, because plan 40's fuses turn that off. A **`KeyProvider` port** carries the data key (today `EngineInit.key`), keeping A1 cheap.
6. **Fixture engine, preview host and freeze (4.1).** `packages/contract-fixture`, the conformance suite, `src/main/server.ts` reduced to a thin host serving the fixture or the real engine with a per-run token, contract preview **C0 on day 5** and freeze **C1 on day 10**.
7. **Records.** The ADR-19 amendment (section 3), the frozen list and C1 are written to DECISIONS.md.

**Ownership.** Plan 10 owns `packages/*`, `host/*` and the split `main` modules. Plan 40 writes fuses and plist. Plan 30 is touched only by the codemod and import fix-ups, and supplies the menu-bar glyph; E1 ships a plain-letter placeholder, never a sparkle, wand or star.

**Dependencies.** Plan 40's Q1a and Q1b inside the freeze window (item 0) and its fuses and macOS 13 for the packaged resident-mode check; the rest proceeds without them.

**Acceptance.**
- `typecheck` and `test` pass at every split commit; no test deleted without a replacement.
- `npm run package` builds, `verify-release.mjs` finds `@aplos/*` code and zod in the packaged bundles, and the packaged app starts and lists demo mail (the build-wiring proof).
- Host-agreement test: preload, `electron.ts` and `server.ts` equal the generated set (66/47/47 drift gone).
- Portability test passes recursively, fails on the planted subfolder import, and engine plus zod size is recorded against 400,000 bytes.
- Packaged app: a hidden-start launch (`--start-hidden`, no visible window driven), closing the only window leaves main and the engine alive, and a reminder due in 60 s fires with no window (`scripts/verify-resident.mjs`, output attached). `Aplos Mail --selftest` prints a passing JSON report.
- A second engine on the same data exits with a clear message; a stale lock is reclaimed. A fake clock jump of 31 s triggers one `engine.wake()`; the real `powerMonitor` path is checked once by the owner closing the lid for a minute.
- The browser preview refuses a request without the dev token and serves the fixture's `demo` scenario headlessly through the typed client.
- Conformance suite green on the fixture; C0 and C1 and the frozen list recorded in DECISIONS.md.

**Estimate.** 9-12 days.

**Work packages.**
- WP1.1 (one agent, first, serial): move, shared-file relocation, import codemod, portability test, build wiring. Adversarial: confirm the rename (`git diff -M --stat`), that the non-rename diff touches only import and export specifier lines, `git log --follow` on five files, and that `npm run package` and `verify-release.mjs` pass.
- WP1.2a (one agent, serial, after WP1.1): the `RuntimeCtx` introduction. WP1.2b (fan out, one agent per seam, own worktrees, merged in order): the six seams, no behaviour change. Adversarial: a differential test runs old and new service over `tests/service.test.ts` and the demo scenario and asserts identical state transitions.
- WP1.3 (fan out by method area): schemas, generator, agreement test, typed client and codemod. Adversarial: fuzz each schema with invalid inputs and compare error sentences with today's; any changed UI-visible sentence fails.
- WP1.4 (two agents): lifecycle, lock, menu bar, quit flow. Adversarial: kill the engine at each startup step; the next launch must recover.
- WP1.5 (one agent): SQL port, selftest and CI checks, run against Electron's own SQLite.
- WP1.6 (two agents plus a reviewer): fixture, control channel, conformance suite, preview host. The reviewer asks "which UI behaviour cannot be expressed in this contract?" and checks the table in 4.1; every gap is fixed before C1. S thread joins after WP1.1 to start E2a.

> **What this means:** Week 2 ends with a tidy layout, Aplos alive in the menu bar, one list of allowed commands instead of three, and a stand-in engine so screen work can begin. Behaviour stays the same; structure changes.

### E2. The new store: E2a and E2b (ARCH M2)

**Goal.** Replace the in-memory mailbox with the normalized `mail.db` of ARCH 3.2, import today's data safely, and persist the change log, so restarts stop forcing re-snapshots and a 200,000-message mailbox opens in milliseconds.

**Two halves, two threads.** **E2a (S thread, hard date end of week 3)** is deliverables 1 to 5: migrations, the `mail.db` schema, ids, `store.commit` with rollups, and the change log, so plan 20 can start its M3 on a stable store API. **E2b (P thread, weeks 2.5-4.5)** is deliverables 6 to 11 plus the legacy bridge (4.2): bodies, paced FTS, retention, the benchmark, the importer and the bridge. Splitting keeps S free for plan 20 and uses P's idle week 3. 0.3.0 needs both halves.

**Deliverables.**
1. **Migration framework.** `packages/engine/src/store/migrations/NNNN_name.ts`, `PRAGMA user_version`, a checksum row per applied migration to catch edited history, engine-only (ARCH 2.6), a failed migration parks the engine (ARCH 3.7), `mail.db.pre-<version>` copies before later migrations (last two kept). A newer schema refuses to open with today's sentence (`store.ts:13`).
2. **`mail.db` creation:** `STRICT` tables; pragmas `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `journal_size_limit=67108864`, `temp_store=MEMORY`; `auto_vacuum=INCREMENTAL` at creation, since it cannot be added later without a full `VACUUM`. The schema is ARCH 3.2; plan 20 reviews it before E2 merges.
3. **Date-ordered message ids:** `seconds x 4096 + n`, with seconds clamped to the range 0 to 2^32 (pre-1970 and absurd dates sort at the ends, never go negative). The allocator takes the highest existing id at or above `seconds x 4096`; if that second's 4,096 slots are full it carries into the next second's range and **continues from the highest id found there**, so a carried id can never equal one already issued. A property test fills seconds past capacity out of order. The maximum, about 7.4e12 for 2026 and about 1.8e13 at the 2^32 clamp, is inside the safe-integer range [I]. Provider internal date, never the `Date:` header (`RC/gaps/storage-engine-benchmark.md` §7). Contract ids stay strings (`accountId:remoteId`) (ARCH 3.1).
4. **One write path.** `store.commit(fn)` is the only way to write: one transaction that runs `fn`, recomputes touched threads' rollups as a SQL aggregate over their messages (never from the incoming batch; drafts excluded; folder membership from messages not in Trash or Spam), writes `changes`, bumps `seq`. One writer connection, short reads (ARCH 3.7).
5. **Change log.** `changes(seq, type, id, op)` in the same transaction as every write; one coarse `*` entry per backfill page; compaction at 50,000 entries or 30 days with a recorded floor; opaque `{dbEpoch, seq}` tokens with an HMAC for network clients; `dbEpoch` changes only on creation, reset or restore. `T/changes` returns `{oldState, newState, hasMore, upserted[], destroyed[]}` or `cannotCalculateChanges` below the floor (`RC/gaps/engine-contract-rpc-stack.md` §5.2, §7 step 3).
6. **Bodies and attachments** (ARCH 3.3): one record `{text, html, cidMap, quotedRanges}` of the provider's original content, codec 1 zstd-3, 2 gzip, 0 raw, with a runtime probe falling back to gzip (zstd is experimental in Node 24 [V storage §6]). Attachments are files under `attachments/.noindex/`, never base64 over IPC. Content-addressed body files are rejected (32% more disk, 4.5x slower opens [M storage §0.4]).
7. **Paced FTS.** One contentless FTS5 table in the main file, `detail=full`, no prefix index, body capped at 16 KB, subject and people in full. An idle loop indexes 100 messages per batch for messages lacking the `fts` bit (a partial index makes the backlog free and restart-proof), inserting FTS rows last in each transaction (1.5-1.8x faster [M storage §5.1]) and pausing while a sync commit or interactive call is in flight. Newest-first local search is `ORDER BY rowid DESC` (0.05 ms against 32-40 ms [M storage §0.5]).
8. **Legacy bridge** (4.2): `assembleLegacyState(limit)` for reads and `legacyStoreAdapter.save(diff)` for writes, so the 0.2.x renderer, the legacy service and the non-Gmail providers keep working on `mail.db` until plan 30 reaches windows and plan 20's M7 and M8 land; E8 deletes it. The open-thread rule is behind a thread-granular port: `ProviderPort.openThread(account, remoteThreadId, {knownCount?})` returns all of a thread's messages and bodies, and the adapter picks `threads.get` or `messages.get` (plan 20 section 2: `threads.get?format=full` on open unless the engine already knows the thread has one message). The engine neither knows nor cares which call is made, so ARCH 5.1's two-or-more-messages wording, which cannot be evaluated before a count exists, is replaced by plan 20's rule in DECISIONS.md at E2a. Rows with `complete=0` surface as `partial:true` (4.1).
9. **Retention** (ARCH 3.6, Decision 6): bodies kept 90 days plus anything opened, starred or unread, 2 GB cap evicted by `last_read_at`; eviction never runs during backfill, then paced `incremental_vacuum`; a WAL supervisor checkpoints when idle and flags WAL over 256 MB (a busy reader grew it to 104-938 MB in 2.5 s [M storage §4.4]).
10. **`bench/store-bench.ts`**: an original generator of 50,000 threads and 200,000 messages; real-mailbox counts and sizes (no content) calibrate caps (`RC/gaps/storage-engine-benchmark.md` §8).
11. **The importer** (below).

#### The import

Source: `aplos.db` opened read-only, never written or renamed. A pre-SQLite `state.json` is first imported into `aplos.db` by today's code.

| Legacy | New |
|---|---|
| `accounts(data)` | `accounts` (status from `connected`/`error`; `ai_allowed` starts 0, see E5) |
| `meta.settings`, `blockedSenders` | `settings`; `sender_rules` (action `block`) |
| `drafts(data)` | `drafts`; a draft with `pendingSendAt` becomes a `queued` submission with `not_before`; one with `sendAttemptAt` and a `messageId` and no confirmation becomes `uncertain` and queues a Sent check |
| `conversations`, `provider_memory` | unchanged |
| `events(data)` | `calendars`, `events` best-effort; the next calendar sync (plan 20) restores truth |
| `ops(data)` | `ops` with `kind='legacy.thread.patch'`, drained or translated by plan 20's M3 before 0.3.0 |
| `sync_cursors` | `sync_state(scope='history')` with `phase='needs_reconcile'` and `generation` bumped, so Gmail runs a generation sweep instead of trusting an old cursor (ARCH 4.2 rule 3) |
| `threads(data)` | `threads`, `messages`, `message_folders` (from `labels`), `thread_folders`, `bodies`, `attachments`, `thread_workflow` (status, bookmark, reply status, due, reminder, todo, hidden; importance to `rank_bucket`), `summaries` (`input_hash` from message ids and text hash) |
| `thread_text` FTS | not copied; the paced job rebuilds it |
| Messages without a provider id (demo account, locally sent messages, legacy `randomUUID` ids) | `remote_id` = the legacy id, `origin='local'`, internal date from `date`; the thread's `remote_id` likewise falls back to the legacy thread id, so natural-key upserts stay unique and a later sync can adopt them |
| `Attachment.data` (inline base64 in the legacy JSON) | written to `attachments/.noindex/` as a file with `state='present'` and its path; never kept in the row or sent over IPC |

One transaction per table family, then per 500 threads, with `meta.import_state={family,lastKey}` written inside each, so a kill resumes at the next unit; writes are keyed by natural ids so re-running a unit is harmless. At the end `meta.imported_from`, `import_done` and a fresh `dbEpoch`. The engine reports `starting` with a progress object (copy "Moving your mail, n of N" is plan 30's). Gmail accounts then reconcile with a generation sweep (plan 20).

**Ownership.** Plan 10: E2a on the S thread, E2b on the P thread. Plan 20 reviews the schema before E2a merges and consumes `store.commit`, `sync_state`, `governor_state`, `sync_failures`, `provider_memory`.

**Dependencies.** E1's WP1.1 (the move) for both halves; E1's ports for the bridge. Plan 20 needs the schema, `store.commit` and the change log at the start of its M3 (week 3); that is E2a's hard deadline, and if E2a slips the slip is reported the same day because M3 is the critical path. Plan 40: CI runs the SQLite check and the benchmark gate. Plan 40's expectation of a seeded store generator "at M1" is met by `bench/store-bench.ts` in E2b and by the fixture's generator in E1 (4.1), which share one seeded source.

**Acceptance.** E2a closes on the replay property test, the restart-keeps-`dbEpoch` check, the rollup checks and the id allocator test; E2b on everything else.
- `bench/store-bench.ts` on the owner's Mac at 200,000 messages, numbers in PROGRESS.md, against targets set from `RC/gaps/storage-engine-benchmark.md` §0 (research value in brackets): first 50-row page p50 under 1 ms [0.04-0.07]; all unread counts under 10 ms [5]; label-change commit p50 under 1 ms [0.2]; page commits with FTS deferred at least 3,000 msgs/s [11,469 without FTS; this schema adds rollups and `changes`, so the first run recalibrates]; cold open to first rows under 50 ms [about 10]; engine RSS after the first page under 120 MB [65]; local newest-50 search under 5 ms.
- Replay property test: a seeded generator applies upserts, deletes, label moves and rollups (seed printed on failure) and asserts `snapshot(seq0)+changes == snapshot(seqN)` over 1,000 sequences, including coarse entries and the below-floor case (Bulwark shipped two delta bugs, `RC/arch/extra-bulwark-legacy-proxy.md`).
- Restart keeps `dbEpoch`, and `T/changes` from the old token returns only the delta.
- Kill-mid-import: an engine child is killed at 20 seeded points in a 50,000-thread import; each restart resumes and the final counts and a content hash of sampled threads equal an uninterrupted import.
- Rollback drill: a test opens the untouched `aplos.db` with a frozen copy of main's `createMailStore` (`tests/fixtures/legacy-store.ts`) and asserts `load()` equals the original; the owner repeats it once on a copy of the real data with a v0.2.3 build (counts only).
- Bridge acceptance as listed in 4.2 (existing suite green through the bridge; IMAP and JMAP emulator runs with a capped working set; a 0.2.x renderer build works; a kill mid-save leaves a whole state).
- Import edge cases: messages with no provider id, inline-base64 attachments written to files, and 1970 and 2099 dates all import; the id allocator never repeats an id across 10,000 out-of-order inserts.
- Rollups: a trashed reply does not trash the conversation; drafts do not change counts; counts equal an independent slow query. Eviction refetches through a stub provider and never runs while an actor reports `backfilling`.

**Estimate.** E2a 5-6 days; E2b 9-11 days (the bridge is about 4-5 of those); total 14-17 days, up from the 8-10 an earlier draft gave before the bridge was counted.

**Work packages.** E2a, S thread: WP2.1 (one senior agent): migrations, schema, ids, `store.commit`, rollups (the costliest-mistake part). WP2.2: change log, tokens, replay test. E2b, P thread: WP2.3: bodies, FTS job, retention. WP2.4 (two agents, by table family): importer. WP2.5 (one agent, then a reviewer): the legacy bridge, reads and writes. WP2.6: benchmark and CI gate.
Adversarial: (a) an agent corrupts the importer's input (missing messages, duplicate ids, 3,000-message threads, dangling labels, dates in 1970 and 2099) and must get a clean import or a clear error, never a crash or silent loss; (b) an agent feeds rollups out-of-order batches and compares to a slow reference; (c) a reviewer reads `store.commit` for any write outside the transaction; (d) for the bridge, an agent replays recorded legacy `StoreDiff` streams from the existing sync tests into `mail.db` and compares `assembleLegacyState` with the legacy store's own load, field by field.

> **What this means:** Your mail moves into a database built for speed. It opens in milliseconds at any size, restarts remember where they left off, and the old file stays untouched as a way back.

### E3. Live windows, direct MessagePort, main out of the data path (ARCH M4, engine half)

**Goal.** Give screens windows of rows that update in place and take main out of the data path, so a 100,000-thread mailbox costs the same as a small one.

**Deliverables.**
1. **View specs and compiler:** `home`, `later`, `all`, `drafts`, `sent`, `needs-reply`, `awaiting-reply`, `trash`, `spam`, `low`, `label:<id>`, `search:<q>`, each with an optional account filter. Today's `threadInView` and `isHomeNew` (`shared/mailbox.ts`) become SQL over `thread_folders`, `thread_workflow` and the `home` index. Keyset paging, never `OFFSET`.
2. **Window engine.** `View/watch {spec, holdIds?}` returns a first `window {windowId, state, ids, total, changed}` of at most 200 body-free rows. After each commit the engine maps the change set to candidate windows and re-runs their keyset queries at most 4 times a second per window, coalesced and gated by account and type, pushing ID-only frames; clients `Thread/get` only unknown or stale rows (ARCH 9.2). Backfill's coarse entries cause one re-run per page (the storm risk, `RC/gaps/engine-contract-rpc-stack.md` §8). `View/move`, `View/unwatch`, and `View/query` for one-shot reads (CLI, MCP, search).
3. **Holds** (DESIGN section 5 rule 6): `View/hold {windowId, ids}` and `View/release`; held rows keep their positions until released or about 2 s after the client's last activity signal, so an AI re-rank never moves the row being triaged. Rank is a bucket, not a score (ARCH 8.2).
4. **Commands and receipts.** `Thread/act {opId, ids, action}` applies inside one commit, enqueues the provider op (replay model, ARCH 4.3) and returns `receipt {opId, appliedState}`; the client drops its overlay once a window reaches that state. `Operation/undo` enqueues the inverse operation, never a delayed commit (DESIGN rule 11). `Session/get` returns `{apiVersion, appVersion, schemaVersion, dbEpoch, capabilities}`. `state` frames coalesce over 50-250 ms; `progress` is ephemeral and never logged; `reset {reason}` re-opens windows.
5. **Direct MessagePort.** Main creates a `MessageChannelMain` per window, transfers one port to the engine and one through preload; preload checks the generated allowlist; ports go only to a window's trusted main frame (mail frames fail `assertCaller` by design) (ARCH 9.4, 12.1). Binary data moves as transferable `ArrayBuffer`, never base64, which removes the 25 MB base64 `ai.transcribe` payload.
6. **Main leaves the data path.** `latestState` is deleted. Main keeps native methods (`window.*`, `file.*`, `system.*`, `update.*`) and receives typed **host-channel** events from the engine: `notify`, `badge {count}`, `appearance {theme}`, `openExternal`, `reminder`. `window.compose` validates its draft through main's own engine connection (`Draft/get`) instead of the mirror (`electron.ts:183`). **The legacy renderer keeps working without the mirror:** main relays legacy `state` and `changes` events statelessly, and the `did-finish-load` re-send (`electron.ts:110`) goes because the renderer already calls `state.get` on mount (`App.tsx:107`) **[V on main; re-checked by the legacy-renderer test below]**. So the mirror can go in E3, weeks before plan 30's U9 cutover; plan 30's U9 note that plan 10 removes it "at the same time" is relaxed (7.2).
7. **Client runtime** in `@aplos/contract/client`: connection with `since` resume (and `Last-Event-ID` over HTTP), row cache, `WindowStore` replacing `shared/live.ts`. Plan 30 wraps it in React hooks. `MessageBody/prefetch {ids}` with cancel serves DESIGN rule 9.
8. The real engine passes E1's conformance suite; the UI flips from fixture to real by flag, and plan 30 is asked to flip its dev builds to `engineWindows` as soon as that suite is green (7.2).

**Ownership.** Plan 10: views, client runtime, port wiring, host channel. Plan 30: React side and window creation. Plan 40 reviews `assertCaller` and port handoff.

**Dependencies.** E2a for the compiler and window queries (WP3.1 can start on the E2a schema while E2b finishes); E2b for the bridge; E1's freeze. Plan 30 migrates in parallel against the fixture. Plan 20 supplies account status and backfill state for gating (the status vocabulary of ARCH 6.4 is a contract type defined here).

**Acceptance.**
- Conformance suite passes on the real engine with the fixture's assertions.
- At 100,000 threads: window re-run p95 under 1 ms [0.12 ms, `RC/gaps/engine-contract-rpc-stack.md` §3.2]; `View/move` p95 under 5 ms; `Thread/act` plus receipt p95 under 4 ms (inside DESIGN's 8 ms key-to-state budget); window open at most 200 rows and under 150 KB.
- Burst: 10 `Thread/act` in 2 s return 10 receipts, at most one window update per 250 ms, no held row moves.
- A grep test fails if `latestState` or a whole-state mirror exists in `src/main`; a payload test fails on any engine-to-renderer message over 256 KB outside blob routes.
- A legacy-renderer smoke test (the 0.2.x screens through the bridge) lists, triages and reconnects after an engine kill with `latestState` gone.
- Kill the engine: windows reconnect and resume with the same `dbEpoch`, no re-snapshot. A second window gets its own port; closing one leaves the other's windows and holds untouched.

**Estimate.** 10-12 days.

**Work packages.** WP3.1 (senior agent): compiler, keyset queries, `EXPLAIN QUERY PLAN` assertions. WP3.2: window engine, coalescing, holds. WP3.3: commands, receipts, undo, session, frames. WP3.4: port wiring, preload, host channel, `latestState` removal. WP3.5: client runtime and migration notes for plan 30.
Adversarial: (a) a "storm" agent runs a 100,000-message backfill with three windows open, measuring CPU and frames; (b) a "stale overlay" agent replays random command and frame interleavings against a model; (c) a "port hijack" agent tries to get a port from a mail frame, a devtools page or another origin, and must fail.

> **What this means:** Lists load a small window at a time and change in place. The whole mailbox never goes to the screen, so Aplos feels the same at 100 or 100,000 messages.

### E4. Engine-side HTML: sanitizer, tokens, image proxy (ARCH M4, HTML half)

**Goal.** Serve each email from the engine into the sealed `aplos-mail://` frame so a message cannot reach the app, files or network, and sanitizer fixes reach old mail without spending provider quota (ARCH 10; `RC/gaps/electron-email-html-isolation.md` §7).

**Deliverables.**
1. **`packages/mail-html`:** a parser-based allowlist sanitizer, pure JS, no DOM or Node imports, bundled separately. Keeps `<style>` and `style`; removes `script`, `meta`, `link` (DNS prefetch escapes CSP [V isolation §5]), `base`, forms, `iframe`, `object`, `embed`, SVG `foreignObject`, remote `@import`/`@font-face` and every `url()` that is not a rewritten cid or proxy URL; makes links `target=_blank rel="noopener noreferrer"` and drops other schemes; removes tracking pixels ("N trackers removed"); wraps quoted history in `<details>`; injects find `<mark>`s and reading CSS. Plain-text mail returns as text for the host to escape, no frame. A one-day spike (WP4.1) picks the parser and CSS tokenizer by measured size and corpus correctness (library **[U]** until then; target under 150 KB; fallback a small in-house tokenizer for `url()` and `@import`).
2. **Render pipeline:** `Mail/frame {messageId, imagePolicy, findQuery}` (the name and shape plan 30 asked for, section 8.1 item 4) reads the stored original (E2), sanitizes on every read (sanitizer version is part of the cache key) and returns `{url, expiresAt, bodyKind, trackersRemoved, hasRemoteImages, quotedCount}`, where `url` is `aplos-mail://m/<token>`; `Mail/frame.release {url}` frees the token. `toggleQuotes` and a per-sender image allow-list (a `Settings` field) are part of the same contract. An LRU of 12 rendered bodies serves prefetch (DESIGN rule 9).
3. **Tokens:** 128-bit random, single-render, mapping to `{accountId, messageId, imagePolicy, findQuery}`; at most 64 live; dropped when the reader replaces them. "Load images" re-renders with a new token (the control lives outside the frame, plan 30). One mail origin, `aplos-mail://m/<token>`, never one per thread (+18 MB each, isolation §2).
4. **Protocol relay:** main registers `aplos-mail` as `{standard:true, secure:true}` only and forwards `{token, path}` to the engine over its control connection. The engine builds the whole response, including **all headers** (custom-scheme frames do not inherit the host CSP [V isolation §8]): body, `…/<token>/cid/<n>` from attachment files, `…/<token>/img/<n>` through the proxy. Main adds nothing.
5. **Headers** exactly as ARCH 10 (`default-src 'none'`, `script-src 'sha256-<reporter>'`, `sandbox allow-scripts allow-popups`, `nosniff`, `no-referrer`, `no-store`, and the rest listed there). The reporter script is a static asset whose hash is computed at build time and recomputed by a test from the shipped file; it posts `{token, h, w, bg, ready, marks}` and nothing else.
6. **Image proxy** (host adapter, never in the neutral core): resolve DNS once and connect to the resolved address with the original name as SNI and `Host`; refuse loopback, private, link-local, CGNAT (100.64/10), ULA, multicast, unspecified, benchmarking (198.18/15), and IPv4-mapped or NAT64 forms of any of those; follow redirects manually (at most 3, each revalidated); ports 80 and 443; size and pixel caps with dimensions read from the header; PNG, JPEG, GIF and WebP only (no SVG); no cookies or `Referer`; timeouts; a per-token request budget. Images load on view only; remote fonts never load.
7. **Main-side glue:** a session `webRequest` backstop cancelling any http, https, ws or wss request whose initiator is `'null'` or whose frame URL starts with `aplos-mail:` (one listener per event **[U]**, so plan 40 and plan 10 share one handler module); `setWindowOpenHandler` and `will-frame-navigate` per ARCH 10; pop-out and print in a `WebContentsView` with `javascript:false`; the `before-input-event` key relay for focus inside a mail frame. Whether that fires for out-of-process frames is **[U]** and is hand-checked in the packaged app before E4 closes; the fallback is a non-destructive relay from the frame script (J/K, scroll, Esc; never E, Space or R). The shortcut registry is plan 30's.

**Ownership.** Plan 10: `packages/mail-html`, `host/protocol/`, render and proxy code, `main/protocol.ts`. Plan 30: frame element, host chrome. Plan 40: reviews headers and the `webRequest` handler, and edits the host-page CSP (ARCH 12.1) once the frame exists. The M0 `srcdoc` stopgap is plan 30's; this replaces it.

**Dependencies.** E2 (stored originals) and E3 (control connection) for the render pipeline and relay. The parser spike, sanitizer, hostile corpus, leak harness and SSRF classifier (WP4.1 to WP4.3 and WP4.5) need neither, and are started in weeks 3-4 as agents free up, which is what makes E4's slack real. **E4 is the milestone that slips first (4.0, Decision 10)**; plan 30's U6 needs the real frame at week 7, and until then the M0 `srcdoc` stopgap stands.

**Acceptance.**
- **Hostile corpus**, at least 60 original messages: inline scripts and handlers, `javascript:` and `data:` URLs, meta refresh, `<link>` prefetch, preconnect, CSS `url()`, `@import`, `@font-face`, `image-set()`, `<base>`, SVG script and `foreignObject`, auto-submit forms, nested iframes, `object` and `embed`, mXSS mutation payloads, 100,000-element nesting, 5 MB single lines, malformed encodings, 1x1 and hidden pixels, open-redirect image URLs.
- **Leak test:** a headless, `show:false` Electron driven by Playwright's Electron support (never a visible window) loads the corpus through the real protocol handler; a canary HTTP server on a random loopback port, a DNS canary and the Chromium net log are inspected. Images off: zero requests and zero canary DNS lookups. Images on: only the engine's proxy connects, and every SSRF case is refused (127.0.0.1, `[::1]`, `::ffff:127.0.0.1`, 10/8, 169.254.169.254, decimal, octal and hex IP forms, a resolver answering public then private, a redirect to a private address, port 8080).
- The shipped reporter's SHA-256 equals the CSP value; an email's inline script never runs.
- Sanitizer median under 5 ms and p99 under 40 ms per message on the corpus and a realistic sample (calibrate on first run); bundle size recorded.
- Old-mail test: change a rule, bump the version, re-open a stored message with no provider call. The 13th render evicts the oldest.
- Keyboard-relay hand-check in the packaged app recorded in PROGRESS.md (owner step, or a background Cua-driver run on the exact window that never raises it); if neither is possible, the fallback relay ships and the gap is recorded.

**Estimate.** 8-10 days.

**Work packages.** WP4.1: parser spike. WP4.2: sanitizer. WP4.3: corpus and leak harness. WP4.4: render pipeline, tokens, LRU, relay. WP4.5: image proxy and SSRF classifier with table-driven tests.
Adversarial: a time-boxed "bypass" agent, given only the allowlist and headers, tries any script execution, outbound request or storage write from a corpus message (each success becomes a corpus entry and a fix); another audits the SSRF classifier against RFC 6890 and the IPv6 special-use registry.

> **What this means:** Each email is cleaned by the engine and shown in a sealed box that cannot send anything, reach your files, or tell the sender you opened it. Images load only when you allow them, through a guard that refuses internal addresses.

### E5. AI queue, budget, consent, heuristic Home, `Setup/*` (ARCH M5)

**Goal.** Move background AI into one durable, budgeted, consent-gated queue that never touches a sync transaction, make Home sensible with AI off, and fix the PR #21 engine findings structurally.

**Deliverables.**
1. **Jobs:** the `jobs` runner with singleton key `summary:<thread>:<input_hash>` (content-keyed: a label change does not invalidate it, a new reply does), priority (visible Home, then unread Inbox newest first; never Spam, Trash or a baseline account), backoff, dead letter after 5 attempts, 1-2 concurrent jobs per provider, `running` returns to `queued` on restart (ARCH 2.3). Kinds: `summary`, `classify`, `plan`, `suggest-action`. Background jobs run with **no tools**, mail wrapped as quoted untrusted text, output validated against preset `SuggestedAction` kinds (ARCH 8.5).
2. **AI governor and budget:** per provider and model, RPM, TPM and TPD learned from response headers, `Retry-After` honoured; a daily-token 429 stops that model's queue until reset with a visible reason; `ai_usage` per day, provider, model, lane; a background cap of 150,000 tokens a day by default (ARCH decision 13); interactive Ask, draft, polish and transcribe are never starved. All SDKs run with `maxRetries: 0` (Anthropic and OpenAI SDKs retry by default; `main/anthropic.ts` changes), so this governor is the single AI retry layer. Provider transports stay in `main/groq.ts`, `llm.ts`, `ollama.ts`, `anthropic.ts` and gain a response-header callback.
3. **Consent:** `consent(scope, version, provider, granted_at)` plus per-account `ai_allowed`; enqueueing checks stored consent; changing provider or scope bumps the version and pauses background AI until re-consent. Each provider carries `trainsOnInputs`; mail content never goes to one marked true; free-tier Gemini is true unless the owner marks the key paid (Decision 8); Ollama and LM Studio are local. 0.2.x installs see the card once (Decision 7).
4. **Heuristic Home** (ARCH 8.2): pure `bucketFor(headers, labels, correspondents, invite)` in `ai/buckets.ts` using `List-Unsubscribe`, `Precedence: bulk`, `Auto-Submitted`, no-reply senders, Gmail `CATEGORY_*` and `IMPORTANT`, direct versus cc, known correspondent, an existing user reply, invitations. Plan 20's ingest calls it inside the sync commit and stores `rank_source='heuristic'`; AI may later set `'ai'`; user and rule choices win. A thread is never held back for AI.
5. **`Setup/begin|end|status`** replacing `deferAI` (DESIGN 7.11-7.12, Appendix C): deferral is the account's silent baseline (`baseline_done_at` null) plus consent, not an in-memory set. `Setup/end` is idempotent and always enqueues a one-shot backfill of unsummarised threads (visible Home first, including reply refresh); every job has its own id and singleton key so Retry cannot collide; disconnect deletes the account's queued jobs; a connect resolving after `Setup/end` is classified normally. `Setup/status` returns the per-account shape of 4.1 (first window found as an optional estimate, read and total; AI sorted, capped and failed; backfill; `pausedUntil`; a reason code) and collects errors, so "Done" can say "partly done".
6. **Interactive path:** `Ai/request`, `Ask/run` with `progress` frames and cancel, `Blob/put` for audio so transcription stops carrying base64.
7. **Empty start and demo on request** (owner wish, DESIGN 7.11 as amended; plan 30 section 8.1 item 11): a fresh install, and an import of an empty or absent store, creates **zero accounts and no demo data** (today `service.ts:195` seeds `createDemo` whenever the store is empty). `Demo/load|reset|remove` are idempotent and touch only demo accounts; saved demo or real data is never seeded over or wiped. `Session/get.hasAccounts` lets main open the onboarding window or the mail window.

**Ownership.** Plan 10. Plan 20 calls `bucketFor` and supplies the headers (ARCH 5.1's field mask already lists them). Plan 30 builds the consent card, onboarding and Settings → AI.

**Dependencies.** E1, E2 and the E3 contract surface; plan 20's `baseline_done_at` (a stub actor until PV3). Plan 30's U8 builds on the fixture from week 7 and needs the real `Setup/*`, consent and `Demo/*` by about week 9, so E5 may run after E6 only if it still lands by then (4.0).

**Acceptance.**
- With the AI transport rejecting or never answering, Home orders by bucket and date and rows appear without waiting.
- Property test over random event sequences (connect, sync batch, close, reopen, consent change, disconnect): no job without stored consent, none for a baseline account.
- PR #21 scenarios as engine tests (DESIGN Appendix C): reopen, connect, close, new mail classified (F1); sync, close, every thread classified (F2); Retry during a running pass does not collide (F5); a reply during deferral is re-summarised (F6); capped or failed passes report partial or failed with errors (F10). PR #21 stays unmerged; tests target `Setup/*`.
- A daily-token 429 pauses that model's queue with a reason while Ask on another model answers; a fake clock past reset resumes it. The 150,000 cap stops enrichment and leaves interactive calls working.
- Background provider calls have `tools` undefined; a malicious summary yields only text or a preset action. A free-tier Gemini mail job is refused with a plain reason.
- Every SDK client is built with retries off; a stub returning 500 counts exactly one attempt.

**Estimate.** 6-8 days.

**Work packages.** WP5.1 jobs. WP5.2 AI governor and usage, fake-clock tests. WP5.3 consent and `trainsOnInputs`. WP5.4 buckets with a 60-case header table. WP5.5 `Setup/*` and the PR #21 tests. WP5.6 interactive path and blobs.
Adversarial: one agent tries the worst orderings of close, reopen, retry, disconnect and reconnect to leave a consented account with no AI; another tries to get mail text to a `trainsOnInputs` provider by switching providers mid-queue.

> **What this means:** Home sorts sensibly even with AI off. Summaries arrive afterwards, within a daily budget you control, only after you agreed to what is sent where. Closing setup at any moment can no longer leave an account without AI.

### E6. Outbox, drafts, timers, notifications (ARCH M6)

**Goal.** Make sending double-send safe and every timed feature durable, with one clock that survives restarts and speaks honestly after the Mac slept.

**Deliverables.**
1. **Submissions** `queued → sending → sent | uncertain | failed`, plus `cancelled` and `suspended` (ARCH 7.1). Today's `pendingSendAt`, `sendAttemptAt`, `resendConfirmed` become rows (E2 already imports them). The Message-ID is generated once. The attempt marker (`state='sending'`, `attempt_at`) is committed **before the first byte leaves**. Adapter contract, agreed with plan 20: `send(mime, signal)` resolves `{accepted, remoteId?}` or throws `NotSentError` for provably-not-sent cases (no connection, DNS failure, 4xx before acceptance, send-limit 429); any other error is `uncertain`. Uncertain is never replayed: the engine calls `findSent(internetId)` (`rfc822msgid:` on Gmail, `HEADER Message-ID` on IMAP, `internetMessageId` on Graph, `Email/query` on JMAP), settles `sent` on a match, else surfaces "We could not confirm this was sent. Check Sent, or Send anyway." Exact MIME is kept until `sent` is confirmed.
2. **Undo send and send later are one mechanism:** `not_before` is now plus the undo window (Settings `undoSeconds`) or the chosen time; `Submission/set` covers send, undo and schedule.
3. **Overdue:** a queued submission more than 5 minutes past `not_before` at launch or wake becomes `suspended` ("Missed its time while your Mac was off. Send now or Reschedule", ARCH 7.3); an undo-window send interrupted by a quit and relaunched inside the grace sends normally.
4. **Drafts:** local draft with `revision` is truth; compare-and-set saves; content fingerprint skips unchanged uploads; per-draft serialised sync through a `DraftSyncPort` plan 20 implements (Gmail upload after 5 s idle and on close, IMAP `APPEND` then delete the previous copy by `APPENDUID`, JMAP and Graph native). The engine owns scheduling and the "keep mine, take theirs, or keep both" conflict state; other devices' drafts show in Drafts, never in threads (ARCH 7.4).
5. **One timer loop** sleeping until the earliest deadline across registered **deadline sources**: `submissions.not_before`, `reminder_at`, `later_until`, plus `jobs.next_at`, `ops.next_at`, governor `cooldown_until` and plan 20's next-poll times, registered by their modules. It recomputes after any commit touching those columns, at launch and on wake, replacing the 30 s reminder interval and ad-hoc send timers. Late reminders and Later returns fire with "was due 9:00" (Decision 3). The clock is an injected `Clock` port.
6. **Notification outbox:** `notifications(message_id, state, created_at, claimed_by)` written in the sync commit for new inbound Inbox mail after the silent baseline; main claims and posts through the host channel and marks `posted` after the system shows it; the Dock badge comes from engine counters (ARCH 7.6).
7. **`Outbox/pending`** returns `{scheduledSends, reminders, uncertain}` for the ⌘Q warning.

**Ownership.** Plan 10; plan 20 implements `send`, `findSent`, `DraftSyncPort`; plan 30 writes the copy for suspended, uncertain and failed states from the engine's sentences.

**Dependencies.** E2 and E3's contract surface. **Not** E5: the timer loop has a registry, and `jobs.next_at` registers itself when E5 lands, so E6 can run first (plan 20's PV4 needs `submissions` and the drafts table in weeks 5-7). Plan 20's emulated providers with fault injection.

**Acceptance.**
- **Kill-point matrix:** the engine child is killed at four named points per provider emulator (before the marker; after it and before bytes; after bytes and before acknowledgement; after acceptance and before the local commit). On restart there is never a duplicate delivery (the emulator counts) and never a silent loss: each ends `sent`, `failed` with a visible reason, or `uncertain` with the prompt. Kill points exist only in test builds; a release-bundle grep asserts their strings are absent.
- One real send to an owner-controlled address on Gmail and one on iCloud, the owner killing the engine once mid-send (owner step; Sent folder counts and log events are the evidence; mocked Google never counts, AGENTS.md).
- Overdue: a fake-clock jump for the automated case; for the owner, a send scheduled 2 minutes out and the lid closed 10 minutes: on opening, the prompt appears and nothing went late.
- Timer loop on a fake clock: earliest-deadline order, recompute after commit, 20 overdue items caught up in order, wake-ups per hour capped.
- Notifications: 50 simulated syncs with a crash between written and posted yield exactly one notification per message.
- Draft CAS: two saves with the same base, one wins and the other gets `stateMismatch`; a remote edit raises the three-way choice.

**Estimate.** 7-9 days.

**Work packages.** WP6.1 (senior agent): state machine, marker, uncertain and `findSent`. WP6.2: timer loop and deadline sources. WP6.3: drafts CAS and port scheduling. WP6.4: notification outbox. WP6.5: kill-point harness shared with plan 20's emulators.
Adversarial: a "double send" agent tries to produce two deliveries (kill points, retries, undo racing send, clocks jumping, two engines); a "lost mail" agent hunts any path ending with no state and no message to the user.

> **What this means:** Sending stays safe against double-sends, and undo, scheduled sends, reminders and Later survive restarts. If the Mac was off when a send was due, Aplos asks instead of sending hours late, and a notification is never shown twice.

### E7. Local listener, OpenAPI, MCP, diagnostics (ARCH M9)

**Goal.** Open the locked local doorway for tools, agents and the browser preview, publish the contract as OpenAPI, and make any stall explainable with a safe report.

**Deliverables.**
1. **Unix socket** `run/engine.sock`, mode 0600 in a 0700 directory, NDJSON frames, token and `{apiVersion, appVersion}` in the hello; an incompatible major gets `unsupported` with an upgrade message (ARCH 9.5). The path stays under 104 bytes (`sun_path`); a longer data directory falls back to `/tmp/aplos-<uid>/engine.sock`, created 0700 and checked to be owned by the current user [I].
2. **Loopback HTTP** on `127.0.0.1` only: `POST /v1/call/<Type>/<verb>` (`Idempotency-Key` from `opId`), `GET /v1/events` (SSE with `id: <seq>`, `Last-Event-ID`, `reset`), `GET /v1/blob/:id`, `PUT /v1/blob` (25 MB cap), `GET /v1/openapi.json`. Exact `Host` allowlist (`127.0.0.1:<port>`, `localhost:<port>`), exact `Origin`, no reflected CORS, `no-store`, size caps, header and body timeouts, a connection cap.
3. **Clients and scopes** (ARCH 12.3): 256-bit tokens stored only as SHA-256 hashes in `clients`, compared with `timingSafeEqual`, sent in `Authorization`, never given to a renderer; scopes `read`, `draft`, `send`, `admin` as a registry tag per method; a device list with immediate revoke (open connections close); an `audit_log` row for every send, delete and settings change by a non-UI client; the CLI token in a 0600 file. Typed operations only: no paths, sockets, SQL or protocol objects.
4. **Listener switch:** off in release builds until "Allow tools on this Mac" is on (Decision 5); `Listener/set` and `Clients/*` back the pane plan 30 builds.
5. **OpenAPI:** `z.toJSONSchema` into `packages/contract/generated/openapi.json` with a golden-file CI diff (EmailEngine's discipline, `RC/SYNTH-architecture.md` §6) and a schema lint for the wire rules (discriminated unions of named objects, no tuples, `Date`, `Map` or `BigInt`, no transforms, open string enums).
6. **MCP adapter and CLI** in `host/mcp/`, `host/cli/` (a stdio server over the socket): tools generated from methods tagged `read` or `draft`; `send` and destructive actions need an explicit grant and an in-app confirmation (the engine emits the request; the dialog is plan 30's).
7. **Browser preview** on the hardened binding: E1 already made `server.ts` a thin host with a per-run token added by the Vite dev proxy; E7 swaps it onto the real loopback listener (item 2), reads the token from a 0600 file, and puts it through the request matrix below. The browser never holds the token. Preview keeps its own data directory (AGENTS.md).
8. **Diagnostics** (ARCH 11): complete event catalog; ring buffers of 500 events per account and folder snapshotted into every UI error; a verbose protocol log (headers only, `Authorization` and `Cookie` removed, no bodies) that switches itself off after 15 minutes; the **bundle**, where a zod `.strict()` schema is the only way anything enters (versions, per-account status and cursor ages, governor targets and pauses, units per minute, queue depths, recent classified errors, event-loop delay, DB, WAL and FTS-backlog sizes), previewed before saving and never uploaded; a **queue inspector** (`Queue/list|retry|discard` for ops, jobs, submissions); `crashReporter.start({uploadToServer:false})` with dumps staying local (the bundle lists count and dates only).
9. **Swift spike** (1-2 days, outside the product): a client generated by `swift-openapi-generator` calls `View/query`, consumes SSE, and records how unknown string-enum values decode (`RC/gaps/engine-contract-rpc-stack.md` §9); the result goes in DECISIONS.md before any phone is scheduled.

**Ownership.** Plan 10. Plan 30 builds Settings panes and the diagnostics preview. Plan 40 reviews the listener against ARCH 12.3 and runs the OpenAPI diff in CI; any LAN exposure is A2 and not here.

**Dependencies.** E3 (scopes, frames), E5 (jobs), E6 (submissions); plan 20's status data for the bundle.

**Acceptance.**
- Automated request matrix, every case refused with the right status and nothing executed: no token, wrong token, revoked token, wrong `Host` (including `evil.com` and a rebinding simulation), wrong `Origin`, hostile `OPTIONS`, duplicate `Host` headers, blob path traversal, oversized body, malformed JSON, slowloris.
- Revocation disconnects a client within 1 s. Socket and directory modes and path length asserted; a deliberate breaking change turns the OpenAPI golden test red.
- Scope: a `read` client lists threads but cannot call `Submission/set`; `draft` can save but not send; `send` needs a grant and raises a confirmation request.
- **Stalled-sync drill:** a stub provider returning throttle, auth and offline failures in turn yields a bundle showing quota, auth or network correctly; a canary test seeds subjects, bodies, addresses and tokens and greps the bundle: zero hits.
- Preview works headlessly through the tokenised binding and the token never appears in the page, console or network log. The Swift spike compiles and prints the first window.

**Estimate.** 8-10 days.

**Work packages.** WP7.1 (senior agent): socket and HTTP with the security matrix. WP7.2: clients, scopes, audit, revocation. WP7.3: OpenAPI, lint, golden test. WP7.4: MCP and CLI. WP7.5: bundle, ring buffers, protocol log. WP7.6: queue inspector and preview. WP7.7: Swift spike.
Adversarial: a "break in" agent, given only the listener source and ARCH 12.3, must make an unauthenticated, cross-origin or wrong-scope call; a "leak" agent tries to get a canary into a bundle through any field.

> **What this means:** Tools and a future phone app can use Aplos through a locked door that is off by default, needs a revocable key per tool, and logs anything risky. When something sticks, you can export a report containing none of your email.

### E8. Hardening, soak and clean-up (ARCH M10, engine half)

**Goal.** Prove the engine survives real life (sleep, battery, bad networks, quota storms, full disks, damaged files) and remove the temporary shims.

**Deliverables.**
1. **Soak harness** (`scripts/soak.ts`): a rehearsal run in weeks 10-11.5, then the release soak on the one 0.4.0 release candidate that plan 30's U9 dogfood week also uses (weeks 12.5-13.5): seven days with a stub provider and, in parallel, the owner's real accounts through plan 20's actors; scheduled sleep and wake and battery cycles on the owner's Mac (an owner step); RSS, WAL size, event-loop p99 and units per minute sampled each minute to a CSV.
2. **Fault injection** (shared with plan 20): drops, 403 and 429 storms, a corrupt provider page, disk full (a size-limited disk image from `hdiutil`), a flipped byte in a copy of `mail.db`, history 404, clock moved backward.
3. **Damaged-database path** (Decision 6): `SQLITE_CORRUPT` or a failed `integrity_check` at open parks the engine, copies the damaged file aside, and offers Export report, Restore a pre-migration backup, or Rebuild from your provider, first listing what exists only on this Mac (drafts, scheduled sends, local workflow edits).
4. **Shim removal:** the legacy bridge (`assembleLegacyState` and `legacyStoreAdapter`, 4.2), legacy `state.get`/`threads.page`, `packages/contract/src/legacy/`, the `apps/desktop/src/shared` re-export stubs and the legacy op kind go once plan 30 reports the renderer on windows (at its WP5.6 flip right after E3, about week 6-7; not at U9) and plan 20 reports legacy ops drained and IMAP, JMAP, Graph and CalDAV off the legacy sync (after PV6-PV10).
5. **A1 readiness verified, not built** (ARCH 2.6): the import lint test, lock, `KeyProvider`, engine-only migrations, a version handshake.
6. **Second-Mac update test** 0.3.x to 0.4.0 (needed anyway for plan 40's Developer ID check), including import on a second machine's data, an update interrupted during migration, and a rollback.

**Ownership.** Plan 10, with plans 20 and 40 as required participants. **Dependencies.** Everything above; plan 40's release pipeline.

**Acceptance.**
- Seven-day soak: zero duplicate sends; zero ghost threads after a forced cursor expiry; RSS slope under 2 MB an hour after a 30-minute warm-up and under 50 MB net over 24 hours (ARCH's "flat memory"); WAL never above 256 MB; no event-loop p99 above 500 ms for more than a minute running. CSV and chart attached.
- Disk full: the engine parks with a clear message, `integrity_check` is `ok` once space returns, nothing lost. Corruption: parked, damaged copy kept, restore and rebuild each work from a clean start.
- Clean 0.3.x to 0.4.0 update on the second Mac; rollback to 0.3.x opens the untouched data. Portability test passes with shims gone.

**Estimate.** 5-7 days plus the soak in the background.

**Work packages.** WP8.1 harness. WP8.2 fault scenarios, one agent each. WP8.3 damaged-database path. WP8.4 shim removal after the two readiness reports. WP8.5 update test with the owner.
Adversarial: a "murphy" agent runs the fault scenarios in random combinations and order for 24 hours with a fixed seed and must find one violated invariant (duplicate, lost message, stuck status) or report that it could not.

> **What this means:** Before 0.4.0 the engine is run hard for a week through sleep, bad networks, full disks and damaged files, and anything that breaks is fixed. The temporary bridges to the old structure are then removed.

## 5. Test strategy

**Principles.** Mocked Google never counts as live acceptance (AGENTS.md). Agents run headless only; checks needing a visible window are owner steps or a background Cua-driver run on one exact window that never takes the foreground. A milestone is checked off only with evidence in PROGRESS.md.

| Layer | Proves | Where |
|---|---|---|
| Unit (node:test via tsx, as today) | Registry, ids, tokens, buckets, redactor, SSRF classifier, timer loop on a fake clock | `packages/*/tests`, `apps/desktop/tests` |
| Property (seeded, seed printed) | Change-log replay, rollups vs a slow reference, consent gating, client overlay vs engine truth | `packages/engine/tests/property` |
| Conformance | Fixture and real engine behave identically | `packages/contract/tests/conformance` |
| Bridge differential | Legacy service on `mail.db` equals the legacy store, field by field | `packages/engine/tests/bridge` |
| Benchmarks with budgets | E2-E4 numbers; CI gates at 3x margin (shared runners are noisy); exact numbers recorded from the owner's Mac | `packages/engine/bench` |
| Kill-point and fault injection | No duplicate send, no silent loss, resumable import | child-process engine, test-only build flag |
| Security matrices | Listener, hostile HTML and leak test, SSRF table | E4, E7 |
| Packaged-app scripts | Fuses (plan 40), resident mode, `--selftest`, no kill-point strings in release | `verify-release.mjs`, `verify-resident.mjs` |
| Owner-run live checks | Sleep and wake, one real send per provider, keyboard relay, rollback on real data | PROGRESS.md |

**Calibration rule.** Targets marked "calibrate" are set from the first measured run on the owner's Mac and written to DECISIONS.md; afterwards a regression fails CI. Research numbers come from synthetic data (`RC/gaps/storage-engine-benchmark.md` §7): targets to beat, not facts about Aplos.

**Fixtures** are original and seeded (50,000-thread mailbox, hostile-HTML corpus, legacy-v3 `aplos.db`, demo data); none holds a real address, subject or token.

> **What this means:** Every promise has a test or real-account check, written to fail if the promise breaks. Nothing counts as done on mocks alone.

## 6. Risks and mitigations

| # | Risk (likelihood / impact) | Mitigation |
|---|---|---|
| 1 | Change-log or window bugs show stale or missing rows; Bulwark shipped two (M / H) | Replay property test; shared conformance suite; coarse entries in backfill; `cannotCalculateChanges` and `reset` as safe fallbacks |
| 2 | Window re-run storms during backfill (M / M) | Coalescing at 4 a second, gating, one coarse entry per page, storm test |
| 3 | Import corrupts or loses data (L / H) | Read-only source never renamed; resumable units; kill-mid-import test; content hash; rollback drill |
| 4 | Threads collide on the same files (H / M) | E1 moves and the `electron.ts` split first; ownership by file; freeze C1; 24-hour window (section 9) |
| 5 | Contract freeze is wrong and UI work is wasted (M / M) | Fixture plus conformance expose gaps early; plan 30's reviewer attacks the contract before C1; `v:1` with capability flags |
| 6 | Zod plus engine busts 400 KB, or zod JIT breaks under CSP (M / L) | Measure in E1; `zod/mini`, boundary validation or a recorded budget; `jitless`; oRPC only per ARCH 9.3 |
| 7 | `node:sqlite` follows Electron's SQLite; a bump changes version or options (M / M) | CI and packaged `--selftest` assert 3.43+, FTS5, `contentless_delete`; better-sqlite3 is a one-file switch |
| 8 | WAL growth from always-on readers (M / M) | Short reads, idle `wal_checkpoint(TRUNCATE)`, `journal_size_limit`, 256 MB flag, soak assertion |
| 9 | Out-of-process frames never fire `before-input-event` **[U]** (M / M) | Packaged-app hand-check before E4 closes; non-destructive frame-script relay as fallback |
| 10 | Sanitizer bypass (M / H) | CSP header as second wall, sandbox without `allow-same-origin`, no frame network, bypass agent, growing corpus, sanitize on read |
| 11 | Image-proxy SSRF (L / H) | Resolve once and connect to the address, full special-use table, revalidated redirects, table tests, RFC 6890 audit |
| 12 | Listener exposed by mistake (L / H) | Off by default, loopback and socket only, request matrix, plan 40 review; no `0.0.0.0` path until A2 |
| 13 | Adapters misreport `uncertain` vs `failed` (L / H) | Narrow `NotSentError`, everything else uncertain; kill-point matrix per provider; real sends in E6 |
| 14 | Live verification lags: owner time, Google Testing mode (H / M) | Emulators for development; short owner checklists written ahead; evidence recorded as gathered |
| 15 | PR #21 touches the file E1 splits (M / L) | Not merged; engine side reimplemented as `Setup/*`; plan 30 absorbs its UI; dropped in the rebase if merged first |
| 16 | The legacy bridge loses, duplicates or resurrects threads, especially for IMAP and JMAP on a capped working set (M / H) | Natural-key upserts, deletions only for provider-reported ids, full-list mode, differential replay of recorded `StoreDiff` streams, emulator runs (4.2) |
| 17 | The E1 move breaks the packaged app: `@aplos/*` left unbundled, package dependencies missing from the asar (M / H) | Build wiring is a deliverable; `npm run package` and `verify-release.mjs` in E1 acceptance; adapter dependencies stay in `apps/desktop/package.json` |
| 18 | The P thread is over-subscribed in weeks 4-8, so E3 to E6 slip and block plan 20's drafts and plan 30's U6 (H / M) | Priority and slip rule (4.0), E4 as slack, E6 before E5 if needed, E2b's work on P in week 3, optional third engine thread (Decision 11) |
| 19 | The contract fixture and the real engine drift, so the UI is built against behaviour that does not exist (M / M) | One conformance suite for both, a fixture-only assertion fails CI, plan 30 flips dev builds to the real windows once E3 is green |
| 20 | E2a slips past week 3 and delays plan 20's M3, the Gmail daily-driver gate (M / H) | E2a is five to six days of S-thread work only; same-day escalation; the schema is reviewed by plan 20 before it merges |

Resident-mode confusion and rollback losing local-only edits are covered by Decisions 1 and 4.

> **What this means:** The biggest dangers are quiet bugs in the change feed and the import, and two threads editing the same files. Both are met by tests that try to break them and by doing the file moves first.

## 7. Interfaces and contracts with the other workstreams

### 7.1 Plan 20 (providers and sync)

Plan 10 defines these in `packages/engine/src/ports.ts` and `packages/contract`; plan 20 implements them. Changes are additive via contract PR.

| Port or artifact | Meaning |
|---|---|
| `store.commit(fn)`, page commits | The only write path; a page, its resume token and its `changes` commit together; replay of pending ops inside the commit is a store service (ARCH 4.3) |
| `sync_state`, `sync_failures`, `governor_state`, `provider_memory`, `accounts.status*`, `baseline_done_at` | Plan 10 owns tables, plan 20 owns semantics; plan 20 reviews the schema before E2a merges. `baseline_done_at` marks the end of the **first window** (the newest ~50 Inbox threads, ARCH 5.1 P1), never the end of backfill; backfill pages never create notifications |
| `ProviderAdapter` (plan 20 section 3.2: `connect`, `syncStep`, `fetchBody`, `apply`, `saveDraft`, `send`, `findSent`, `search`, `watch`, `calendar`) | The one port every adapter implements, in `ports.ts` and frozen with C1. `SendPort` and `DraftSyncPort` are its engine-side callers (`send`, `saveDraft`, `findSent`). Adapters never retry, never write the store and never pace; everything goes through `GovernorPort` |
| Contract methods backed by plan 20 | `Account/connect|reconnect|grantPermissions` (granted-scope handling, D5), `Account/lease`, `Unsubscribe/run`, `Event/set {scope: occurrence|series|following}`, `Event/rsvp`: names and schemas frozen at C1, behaviour from PV3, PV4, PV8 and PV9 |
| `AccountActorHost` | Start, stop, pause, wake, heartbeat, status; the supervisor restarts a silent actor alone |
| `GovernorPort.run(account, {budget, lane, cost, kind, signal}, fn)` and the classified-error record | Plan 20 implements, plan 10 specifies the type; E0's log shape is the same record |
| Status vocabulary (`starting`, `ok`, `syncing`, `backfilling (n of m)`, `paused`, `needsReauth`, `needsPermission`, `needsAdmin`, `misconfigured`, `offline`, `error`) | Defined in contract (ARCH 6.4) |
| `bucketFor` and the header field mask | Plan 10 provides the function, plan 20 supplies inputs at ingest |
| `ProviderPort.openThread(account, remoteThreadId, {knownCount?})` | Thread-granular open; plan 20's adapter picks `threads.get?format=full` (120 units) unless a single message is known (plan 20 section 2). This replaces ARCH 5.1's "two or more messages" test, which cannot be evaluated before a count exists; recorded in DECISIONS.md at E2a. Plan 10 does not depend on which call is made |
| Where adapters live | `apps/desktop/src/host/providers/<name>/` (not `packages/providers`, not `packages/engine/src/providers`); actors and governor in `packages/engine/src/sync/**`, the recurrence module in `packages/engine/src/calendar/**`; `packages/emulators` is plan 20's and test-only (section 3). Dependencies stay in `apps/desktop/package.json`. The portability rule needs no path exception, because no adapter lives in `packages/engine` |
| The legacy bridge (4.2) | Reads and writes. Until plan 20's PV6-PV10 (ARCH M7 and M8), IMAP, JMAP, Graph and CalDAV sync through the legacy service and `legacyStoreAdapter`; plan 20 must keep them working there and may rely on the adapter's natural-key upsert. It is not a place for new features |
| `SendPort.send`, `NotSentError`, `findSent`; `DraftSyncPort` | Plan 20 implements (E6) |
| `legacy.thread.patch` op kind | Created at import; plan 20 drains or translates before 0.3.0 |
| Deadline-source registration | Plan 20 registers next-poll and cooldowns, giving one clock |
| Emulators with fault injection | Plan 20 owns; shared by E6 and E8 |

Timing: logger (E0) alongside plan 20's PV0 (PV0 never waits for it); schema, `store.commit` and change log (E2a) at the start of its M3 (week 3); `submissions` and the drafts table (E6) in weeks 5-7 for plan 20's drafts work; kill-point harness shared by week 6.

### 7.2 Plan 30 (UI)

| Artifact | Meaning |
|---|---|
| Fixture engine, contract preview C0 (E1 day 5) and freeze C1 (E1 day 10) | The UI builds against it from week 2 (Decision 9); shape, scenarios, control channel, transports and the table of plan 30's twelve asks are in 4.1 |
| Typed-client codemod | **Plan 10 runs it in E1's freeze window** over the 53 `invoke(` sites in 15 files; plan 30's U2 (its section 4.1 strangler step 1 and U2 deliverables) builds `renderer/data/` on the result and does not migrate the sites again |
| Moving `engine/discover` and `engine/provider` imports out of the renderer | Not a precondition of the move: E1 rewrites those imports to `@aplos/engine/discover` and the contract's legacy types; plan 30's U2 later moves them behind `Account/discover` |
| Flip to real windows | Plan 30's WP5.6 flips dev builds to `engineWindows` when E3's conformance suite is green (about week 6), keeping `compatWindows` only as a contingency, instead of waiting for U9. Its "renderer on windows" report at the flip unblocks E8's shim removal. Plan 10's removal of `latestState` does not wait for U9 either (E3 item 6) |
| `@aplos/contract/client` | Plan 30 wraps `WindowStore` in React hooks; `shared/live.ts` retires |
| Window and hold semantics | E3; DESIGN section 5 rules 6, 9, 10, 11 are the requirements |
| `Setup/begin|end|status` | DESIGN 7.11-7.12 and Appendix C (F1, F2, F5, F6, F10); the UI calls `Setup/end` on every close |
| Human error sentences | The engine's `message` is shown as written; wording follows DESIGN section 10; all user-facing strings live in one catalog file so plan 30's voice review is one diff |
| Frame protocol (E4) | `Mail/frame {messageId, imagePolicy, findQuery}` returning `{url, expiresAt, bodyKind, trackersRemoved, hasRemoteImages, quotedCount}` and `Mail/frame.release`, plan 30's names (its section 8.1 item 4); plan 30 builds the frame and host chrome ("Load images" outside the frame); main relays keys |
| Names | The wire names are `Setup/begin|end|status`, `Mail/frame`, `Demo/load|reset|remove`, `Session/get.hasAccounts`, `Settings` with a `ui` object, `Account/lease` for plan 20's lease override |
| Empty start, demo, `Setup/status` | E5 items 5 and 7; shape in 4.1; the fixture honours both from C1 |

### 7.3 Plan 40 (platform, security, distribution, quality)

| Artifact | Meaning |
|---|---|
| Fuses, macOS 13, entitlements | Needed before E1's resident check; plan 40 writes, plan 10 verifies in the packaged app |
| Formatter and linter adoption | Inside E1's freeze window: main merged, then this plan's rename-and-imports commit, then **plan 40's Q1a format commit**, then the contract skeleton and codemod, then Q1b (section 9, E1 item 0). Branches cut from main before the format commit come back through plan 40's `format-merge.mjs` |
| CI jobs | SQLite check, OpenAPI diff, portability test, benchmark gates, secret scan: plan 10 supplies tests, plan 40 the runners |
| `assertCaller`, port handoff, permission handler, `webRequest` backstop | Reviewed by plan 40; one shared `webRequest` handler module **[U]** |
| Host-page CSP changes | Plan 40 edits `index.html` once E4's frame exists |
| Release verification | `verify-release.mjs` gains the packaged `Aplos Mail --selftest` check (a main-process flag, not `ELECTRON_RUN_AS_NODE`, which plan 40's fuses disable) and a check that `@aplos/*` code and zod are in the bundle. Plan 40's CI runs the same `selftest.ts` inside Electron's Node |
| Updater and open-source readiness | Update drain uses E1's drain hook; `packages/contract` is a public API (ARCH 14.5); no secrets in logs or fixtures |

> **What this means:** The seams between plans are written down as named interfaces with owners and dates, so each team can work without waiting and nothing falls between them.

## 8. What to read first

1. `plans/ARCHITECTURE.md` (sections 3, 7-12, 15) and `plans/DESIGN.md` (sections 5, 7.11-7.12, 15, Appendix C).
2. `AGENTS.md`, `DECISIONS.md` (2026-10-15, 10-16 M26 and M29, 10-21, 10-23), `PROGRESS.md`, `TODO.md`, `MOBILE.md` on main.
3. By milestone, the research named in that milestone's deliverables (the five `RC/gaps/` reports, `RC/protocols/proto-google.md` §1, `research/pr21-onboarding-review.md`, `RC/arch/extra-bulwark-legacy-proxy.md`) and the main-branch files it replaces (`service.ts`, `electron.ts`, `preload.ts`, `server.ts`, `engine/store.ts`).
4. `plans/_council/CONTEXT.md` for the facts that override the research.

Provenance rule for every brief: the corpus contains GPL, AGPL, commercial and unlicensed code; read it for ideas, never copy code, assets, branding or wording (ARCH 14.1).

> **What this means:** Start with the two decision documents, then only the research for the step you are on. Reference projects are for ideas, never for code.

## 9. PR and branch strategy within the revamp

**Nothing goes to main without the owner.** The long-lived branch is `revamp`, cut from main at `72095ff` (v0.2.3); its first commits are the research and planning documents. All plan 10 work merges into `revamp`. PR #21 is not merged by this workstream.

- **Branches.** Git cannot hold `revamp/...` refs next to a `revamp` branch, so work branches are `rv/<workstream>/<slug>` (`plans/00-roadmap.md` section 4). This plan runs on the Engine thread: `rv/engine/e<N>-<slug>` per milestone (`rv/engine/e1-move`, `rv/engine/e2b-import`; E2a runs on the Providers & Sync thread as `rv/providers/e2a-store`) and `rv/engine/e<N>-wp<N.M>-<slug>` per work package, each in its own git worktree. A branch name is never a folder of another (no `rv/engine/e1` beside `rv/engine/e1/...`). Work-package PRs target their milestone branch; the milestone branch PRs into `revamp` once its evidence is attached.
- **Merge style.** E1's move commits use merge commits so `git log --follow` survives; everything else squashes, with a message naming the work package and evidence.
- **The E1 freeze window.** On day 1 of week 1 the owner (or orchestrating thread) announces a 24-hour window. In order, each its own commit: step 0, main merged into `revamp`; plan 10's rename-and-imports commit; **plan 40's Q1a format commit**; the `packages/contract` skeleton; plan 10's typed-client codemod; plan 40's Q1b. Plans 20 and 30 rebase after each. No other PR touches `src/engine`, `src/main`, `src/shared` or renderer call sites during the window. This matches plan 40's Q1 table and section 5 and plan 30's day-zero gate.
- **E0 may reach main.** The 0.2.4 train is one branch, `hotfix/0.2.4`, cut from main and owned by plan 20's PV0. E0 is developed on `hotfix/0.2.4-log`, with files at today's paths (`src/engine/diag/`, `src/main/logsink.ts`), and joins the train by PR into `hotfix/0.2.4` only if it is ready when PV0 is; PV0 never waits for it. The owner merges the train to main. Either way E0's commits reach `revamp` before E1's rename (through main at step 0, or through `format-merge.mjs` if late).
- **Evidence on every PR:** test output, benchmark numbers, corpus and leak-test results, and screenshots where a UI is involved (attached with `gh pr create --attach`, never committed).
- **Records.** Each milestone PR appends to `PROGRESS.md` (what and evidence) and `DECISIONS.md` (calibrated numbers, the freeze, the zod bundle result, the Swift spike result) and ticks `TODO.md` only with evidence (AGENTS.md).
- **Review.** Every PR is reviewed by an agent that did not write it, briefed with the acceptance criteria; E4 and E7 also get plan 40's reviewer.
- **Releases.** 0.2.4 is ARCH's M0, tagged from main. **0.3.0 is ARCH's M3 (about week 5-6): E1, E2a, E2b and plan 20's PV3**, with the renderer on the legacy bridge. E3 to E6 reach the owner on beta tags as each passes its acceptance; a stable 0.3.x only if the owner asks. 0.4.0 is ARCH's M10 plus plan 30's U9, about week 14. **Stable releases are tagged from main** after the owner merges `revamp` into it; **beta tags** (`vX.Y.Z-beta.N`) may be cut from `revamp` with `scripts/release.mjs --allow-branch` and published as prereleases on the owner's go-ahead (plan 40 section 9 item 5). `aplos.db` stays until 0.4.0 is stable (Decision 4).
- **Commits** are authored as Kainoa Newton <k@kainoa.me>; flag any other `git config user.email` before committing.

> **What this means:** Everything lands on `revamp` in small reviewed pieces with proof attached. The risky file moves happen first, in one short window. Main changes only when you decide.

## Evidence index

`plans/ARCHITECTURE.md`, `plans/DESIGN.md`, `plans/_council/CONTEXT.md`, `plans/proposals/arch-evolve.md`; `RC/SYNTH-architecture.md`; the five `RC/gaps/` reports named above; `RC/protocols/proto-google.md`; `RC/arch/extra-bulwark-legacy-proxy.md`; `research/pr21-onboarding-review.md`; `research/inbox-zero/SYNTHESIS.md`; Aplos main at `72095ff` (`apps/desktop/src/engine`, `src/main`, `src/shared`, `tests/portability.test.ts`, `MOBILE.md`, `DECISIONS.md`, `AGENTS.md`).
