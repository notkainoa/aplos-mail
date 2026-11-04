# Workstream plan 10: Engine foundation and local server

Written 2026-10-27 on branch `revamp`. Planning only: nothing here is implemented, nothing goes to main without the owner, and PR #21 stays unmerged.

**Binding inputs.** `plans/ARCHITECTURE.md` (ARCH, by section) and `plans/DESIGN.md` (DESIGN). Where research and `plans/_council/CONTEXT.md` disagree, CONTEXT wins: releases are Developer ID signed and notarized; provisioning profiles do not exist; the repo is private; Google OAuth is in Testing mode; Microsoft has no client ID; the first real Gmail sync failed with 403.

**Conventions.** `RC/` is `research/email-clients/`. Labels as in ARCH: **[V]** verified in a file I read, **[M]** measured in a research report, **[I]** inference, **[U]** unverified, to be checked live. "Today" is Aplos main at `72095ff` (v0.2.3). Paths are relative to the repo root. Milestones are **E0 to E8** to avoid clashing with ARCH's M0 to M10 (full mapping in 4.0). Other plans cite plan 10's work by these E-numbers, with ARCH's M-number in brackets where useful. Plan 20's live experiments are named EX1 to EX11, a different thing. The master schedule, threads and branch rules are in `plans/00-roadmap.md`.

## In plain English

The engine holds your mail, talks to providers, remembers what you did and tells the screens what to show. Today it keeps the whole mailbox in memory, forgets changes when it restarts, and stops when you close the window.

This plan rebuilds the engine in nine pieces, built by seven lanes of work in parallel. Your mail moves into a database that opens in milliseconds at any size, and the old file is never touched, so you can go back. Screens load small windows of rows, so a 100,000-message mailbox feels small. Emails show in a sealed frame. AI work runs in a queue that starts only after you agree. Scheduled sends, undo send, reminders and Later share one clock that survives restarts. A locked local connection lets tools use the same engine.

What changes for you. In the first three days the Engine thread writes the shared rules and a stand-in engine, so screen work starts on day 4. The real engine passes the same tests by day 11. There is no quick fix and no bridge for today's screens. The new screens replace them. Nothing costs money, and nothing reaches main until you say so.

## Decisions for you

Each question has a recommended default. The plan uses the defaults unless you say otherwise. Architecture decisions 5, 6, 7, 9, 13 and 14 also apply. The roadmap settles decisions 9, 10 and 11 (marked below), so eight questions stay open.

| # | Question | Options | Recommended | What happens |
|---|---|---|---|---|
| 1 | When the last window closes, should the Dock icon go and Aplos live in the menu bar? | (a) Menu bar only; (b) keep the Dock icon | **(a)** | (a) shows Aplos is still working, and ⌘Q still quits fully. (b) feels normal but leaves people unsure whether mail is syncing. |
| 2 | Warn on ⌘Q when scheduled sends or reminders are waiting? | (a) Warn, with the count; (b) quit silently | **(a)** | (a) costs one click and stops a send from missing its time. |
| 3 | A reminder came due while the Mac slept. What happens on wake? | (a) Fire at once, "was due 9:00"; (b) wait until you open Aplos | **(a)** | (a) never loses a reminder. (b) can leave one unseen for hours. Sends ask first instead (architecture decision 9). |
| 4 | What happens to the old `aplos.db` after the move? | (a) Keep it until the redesigned release is stable, then offer "Remove old copy"; (b) delete it after 30 days; (c) keep it forever | **(a)** | (a) keeps the way back and never deletes without you. (b) removes the backup on a timer. (c) wastes disk. Going back loses only what you did locally after the move. |
| 5 | Is the local connection for tools on by default in the shipped app? | (a) Off until you switch on "Allow tools on this Mac"; (b) on, with a key per tool | **(a)** | (a) exposes nothing on a fresh install. (b) runs a listener you did not ask for. Developer builds have it on. |
| 6 | If the mail database is damaged, what happens? | (a) Stop, keep the damaged file, and offer Export report, Restore backup or Rebuild from your provider; (b) rebuild automatically | **(a)** | (a) protects drafts and scheduled sends that exist only on this Mac. (b) can lose them silently. |
| 7 | Ask 0.2.x users for AI consent again on upgrade? | (a) Ask once, naming provider and model; (b) treat today's use as consent | **(a)** | (a) is one card and makes later AI use provably consented. (b) skips the card but leaves consent unproven. |
| 8 | Free Gemini keys may train on what you send. How should Aplos treat a Gemini key? | (a) Never use it for mail until you tick "this is a paid key"; (b) trust it | **(a)** | (a) is safe, and Ask still works on non-mail content. (b) may send mail to a provider that trains on it. |
| 9 | When may the UI thread start building against the planned engine commands? | (a) From day 4, against the stand-in engine that Phase 0 freezes on day 3, then switch to the real one; (b) wait for the real engine (day 11) | **(a)** | Settled by the roadmap, 2026-10-27: (a). The UI starts on day 4, and the switch to the real engine happens on days 11 to 13. (b) would idle the UI until day 11. |
| 10 | If engine work runs long, which piece waits? | (a) The doorway's MCP and CLI extras (E7), then the AI queue's extras (E5); (b) the isolated email frame (E4); (c) everything shifts later | **(a)** | Settled by the roadmap, 2026-10-27, and revised: (a). It keeps sending, storage, live lists and the sealed frame on time, and the sealed frame, outbox and views never wait. (b) leaves email in today's weaker frame. (c) delays Gmail and the other providers. |
| 11 | Run an extra architecture thread for the email frame (E4) and the local connection (E7)? | Replaced by the roadmap's decision N1, how many threads | Six threads | Settled by the roadmap, 2026-10-27: Engine, Providers, UI-core, UI-screens, Platform and website, and the Integrator. The Engine thread runs seven lanes. |

## Lanes and phases

`plans/00-roadmap.md` is the source of truth for sequencing. Where this plan's older week numbers, release steps or branch names disagree with it, the roadmap wins. Day 1 is the owner's "go", and days are calendar days. The milestones E0 to E8 stay as citations. Each one now runs as part of the Phase 0 freeze or as one of the seven `eng-*` lanes of the Engine thread (roadmap 1 and 2.1).

| Milestone | Content | Lane or artifact | Phase and days |
|---|---|---|---|
| E0 | Logger, redacting sink, classified-error record, event catalog | Phase 0 artifact F7 | Phase 0, days 2-3 |
| E1 items 0-1 | Restructure chain and the rename-and-imports commit | Engine thread, steps 0 to 4 | Phase 0, day 1 |
| E1 items 2, 3, 6, 7 | `electron.ts` split, registry and typed client, stand-in engine, conformance suite, freeze C1 | Phase 0 step 3 and F1, F2, F5, F6; then `eng-contract` | Phase 0, days 1-3; other scenarios, control channel and preview host on days 4-10 |
| E1 items 4-5 | Resident mode, lock, wake, parked state, self-test | `eng-host` | days 4-7 |
| E2 | Schema 0001 and a minimal working `store.commit` | Phase 0 artifact F4 | Phase 0, days 2-3 |
| E2 | Real commit, ids, change log; bodies, search, retention; importer, benchmark | `eng-store` | days 4-10 (commit by 6, bodies and retention by 9, importer by 10) |
| E3 | View specs, window engine, holds, receipts, `Thread/act`, `Operation/undo` | `eng-views` | days 4-11 (conformance green on the real engine by 11) |
| E3 | Direct `MessagePort`, main out of the data path, host channel | `eng-contract` | days 4-10 |
| E4 | Sanitizer, `Mail/frame`, tokens, image proxy | `eng-html` | days 4-10 |
| E5 | Jobs, AI governor and budget, consent, heuristic Home, `Setup/*`, `Demo/*` | `eng-ai` | days 4-11 |
| E6 | Submissions, undo and send later, drafts, one timer loop, notification outbox | `eng-time` | days 4-10 |
| E7 | Socket, loopback HTTP, clients and scopes, OpenAPI, MCP, diagnostics | `eng-host` | days 4-12 (doorway by 12) |
| E8 | Legacy deletion, fault injection, hardening, seven-day soak | Integrator with each lane; Engine thread | Phase 2 (deletion days 14-17, hardening and rehearsal days 15-18); soak in the background in Phase 3 (days 18-25) |

Plan 10 writes F1 to F8 (the Platform thread shares F8). The Integrator and Platform write F10, the ownership map. F1 includes the `reconnectBy` account fact, the `Setup/status` shape and the `Settings` schema with its `ui` object and a provider and model per AI feature. Three reviewers attack F1 to F9 on day 3 (4.1), and then the Integrator tags `contract-v1`.

## 1. Scope and non-goals

**In scope (the whole engine core).** (1) The normalized store, migrations and import (ARCH 3). (2) The change log and live windows (ARCH 3.5, 9.2). (3) The typed contract and registry in `packages/contract` (ARCH 9). (4) Transports: direct `MessagePort`, Unix socket, loopback HTTP, with the A2 phone binding only as a reserved extension point. (5) The AI queue, budget, consent, heuristic Home lanes and `Setup/*` replacing `deferAI` (ARCH 8). (6) Timed features: outbox, undo and send later, Later and reminders, one timer loop, notification outbox (ARCH 7). (7) Lifecycle: resident menu-bar engine, lock, wake, crash parking, watchdogs (ARCH 2). (8) Diagnostics: redacted logs, event catalog, content-free bundle, queue inspector (ARCH 11). (9) Engine-side HTML: sanitizer, render tokens, image proxy, headers (ARCH 10). (10) A demo-data fixture engine implementing the whole v1 contract (4.1). (11) The Phase 0 restructure, which moves today's engine, shared files and renderer into `legacy/` folders as read-only reference until Phase 2 deletes them (4.2).

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
  src/legacy/ (today's shared/{types,ask,mailbox,summary,live}.ts, moved in Phase 0 step 1, deleted in Phase 2)
packages/engine/            neutral core, no Node or Electron                     [10; 20 owns sync/** and calendar/**]
  src/{store,views,outbox,ai,runtime,methods,diag}/, src/legacy/ (today's engine, read-only), src/ports.ts (ProviderAdapter, Provider, Governor,
  Send, DraftSync, Clock, KeyProvider, MailHtml ports), src/sync/**, src/calendar/** (recurrence), bench/, tests/
packages/mail-html/         sanitizer: pure JS, no DOM, no Node, bundled separately                   [10]
packages/contract-fixture/  stand-in engine on demo data; same conformance suite as the real engine   [10]
packages/emulators/         provider emulators, fault kit, fake clock; test-support only, never bundled [20; 10 and 40 consume]
apps/desktop/src/host/      Node adapters: sqlite.ts, transports/{port,socket,http}.ts, protocol/,
                            lifecycle.ts, menu-bar.ts, power.ts, lock.ts, logsink.ts, crash.ts, mcp/, cli/,
                            providers/{google,microsoft,imap,jmap,caldav,shared}/                     [10; providers/ is 20]
apps/desktop/src/shared/    one-line re-export stubs of the moved legacy files, so renderer and main imports
                            keep working; removed in Phase 2
apps/desktop/src/main/      electron.ts is split in Phase 0 step 3 into windows.ts, lifecycle.ts, protocol.ts,
                            menu-bar.ts, native-methods.ts, security.ts, updater.ts, engine-host.ts
apps/desktop/src/renderer/legacy/   today's renderer, read-only until Phase 2
```

**Package locations (settled).** ARCH ADR-19 names three packages (`contract`, `engine`, `mail-html`). This plan adds two test-support packages and decides where adapters live, as an amendment to ADR-19 (recorded in ARCH's amendments section on 2026-10-27, and in DECISIONS.md in Phase 0). Plan 20 section 3.1 uses the same paths:
- `packages/contract-fixture`: added because the UI thread and CI share it and its demo data must stay out of the 450 KB core budget (4.1; raised from 400 KB, see the dated note in 4.1).
- **Provider adapters stay in the app**, at `apps/desktop/src/host/providers/<name>/` (plan 20 proposed `packages/providers`; rejected for now). Adapters need Node (`imapflow`, `net`, `fetch`), so they cannot sit in the neutral `packages/engine`, and ARCH names no fourth shipping package. Their dependencies are declared in `apps/desktop/package.json`, which is the only manifest electron-builder reads, so keeping them there avoids a packaging break. Actors, governor, lanes and the status machine are neutral and live in `packages/engine/src/sync/**`, reaching adapters only through the ports in `packages/engine/src/ports.ts`. Promotion to a `packages/providers` workspace is a later mechanical move, allowed only when a second consumer (a CLI, or A1's SEA engine) needs the adapters.
- Phase 0 creates the empty `host/providers/` folder and its lint boundary. The existing adapters (`google.ts`, `imap*.ts`, `jmap.ts`, `microsoft.ts`, `caldav.ts`, `ical.ts`) stay in `src/main/`, so the restructure moves no provider code. Each `prov-*` lane moves its adapters inside its own rewrite, and Phase 2 deletes the old files.
- `packages/emulators` is shared by plans 10, 20 and 40, is test-only and is never bundled into the app. It does not count against ADR-19's "shared code" rule because nothing ships from it.
- The framework-neutral client lives at `@aplos/contract/client`, not in a fifth package, so `packages/contract` keeps zod as its only runtime dependency.

**Build and packaging wiring (Phase 0 step 1, a deliverable not an assumption).** Workspace packages are **internal source packages**: `exports` point at TypeScript source, no separate build step. `scripts/build-main.mjs` uses `packages:'external'`, which would leave `@aplos/*` unbundled and missing from the packaged app, so the build marks only third-party packages external (an `external` list or a plugin that bundles `@aplos/*`) **[U: esbuild may apply tsconfig paths before the external check; the packaged `verify-release.mjs` run settles it]**. `tsx` resolves workspace packages through the npm symlinks; Vite gets an alias for the renderer; `tsconfig` gains `paths` and `references`. Third-party dependencies of package code (zod) are declared once in the package's own manifest and checked by `verify-release.mjs` to be present in `app.asar`; adapter dependencies stay in `apps/desktop/package.json`.

| Path | Plan 10 | Plan 20 | Plan 30 | Plan 40 |
|---|---|---|---|---|
| `packages/contract/**` | owns | adds provider schemas by PR | consumes; proposes by PR | golden tests in CI |
| `packages/contract-fixture/**` | owns | adds scenarios by PR | adds UI scenarios by PR | uses in E2E |
| `packages/engine/src/{store,views,outbox,ai,runtime,methods,diag}` | owns | consumes | none | lint rules |
| `packages/engine/src/sync/**`, `packages/engine/src/calendar/**`, `host/providers/**`, provider files in `src/main` (until each moves) | defines ports | owns | none | none |
| `packages/emulators/**` | consumes (kill-point harness) | owns | none | consumes in CI |
| `main/electron.ts` split modules (Phase 0 step 3) | `eng-host` (lifecycle, windows, menu-bar, native-methods), `eng-contract` (engine-host, server), `eng-html` (protocol) | none | onboarding window | `plat-release` (security, updater) |
| `renderer/**` | the move to `renderer/legacy/` in Phase 0 step 1 only | none | owns | none |
| `PROGRESS.md`, `DECISIONS.md`, `TODO.md` | append per milestone | append | append | append |

**Engine-bundle budget.** The neutral engine stays under 400,000 bytes. No report measured zod plus the engine [I]; the freeze review does. If over: `zod/mini` and tree-shaking; validate at the host boundary only; then a measured, recorded budget increase. A failing portability test is never silenced. **Update 2026-11-03:** the owner raised the budget to 450,000 bytes minified (DECISIONS.md 2026-11-03; STATUS DECIDED 2026-11-04 20:00), and the demo dataset (`ai/demo/data.ts`, 11 KB) is a lazy chunk the budget does not count. 450,000 is the last raise without a new decision.

> **What this means:** Each folder has one owner, and the places where plans meet are named in advance. The engine core stays portable so a phone version remains possible.

## 4. Milestones

### 4.0 Overview and mapping to ARCH's M-milestones

| Milestone | ARCH M | Goal | Lane or artifact | Phase and days | Agent-days |
|---|---|---|---|---|---|
| E0 | M0 (logging only) | Redacted log and error-record shape | F7 | Phase 0, days 2-3 | 2-3 |
| E1 | M1 | Restructure, registry, stand-in engine and freeze C1; then resident mode and self-test | Phase 0 chain, F1-F8; then `eng-host`, `eng-contract` | days 1-3; resident mode by day 7 | re-estimated at the freeze (the `service.ts` split and the codemod are gone) |
| E2 | M2 | Schema, migrations, ids, `store.commit`, rollups, change log, bodies, paced FTS, retention, importer, benchmark | F4, then `eng-store` | schema in Phase 0; days 4-10 | 10-12 |
| E3 | M4 (engine half) | Live windows, direct MessagePort, main out of the data path | `eng-views`, `eng-contract` | days 4-11 | 10-12 |
| E4 | M4 (HTML half) | Engine-side HTML: sanitizer, tokens, image proxy | `eng-html` | days 4-10 | 8-10 |
| E5 | M5 | AI queue, budget, consent, heuristic Home, `Setup/*` | `eng-ai` | days 4-11 | 6-8 |
| E6 | M6 | Outbox, drafts, one timer loop, notification outbox | `eng-time` | days 4-10 | 7-9 |
| E7 | M9 | Local listener, OpenAPI, MCP, diagnostics bundle | `eng-host` | days 4-12 | 8-10 |
| E8 | M10 (engine half) | Hardening, soak, fault injection, deleting the legacy code | Integrator with each lane; Engine thread | Phases 2-3, days 14-25 (soak in the background in Phase 3) | 5-7 plus a 7-day soak |

The rest of ARCH's list is not plan 10's: the Gmail fix, which now lives in M3 (plan 20, `prov-gmail` and `prov-gov`), M7 and M8 (plan 20), the UI (plan 30), fuses and CI (plan 40). ARCH M4 is two milestones here because the work splits cleanly: E3 is data and transport, E4 is email display.

**One release.** There is no 0.2.4 hotfix, no 0.3.0 on the old screens and no 0.4.0. The engine ships inside one redesigned release, proposed as 0.3.0, together with plans 20, 30 and 40 (ARCH amendment AM-5; roadmap 7). Builds before it are local packaged builds or `v0.3.0-beta.N` draft releases in this private repo, installed by hand on the owner's go-ahead. The stable release is tagged from main after the owner merges `revamp`.

**Effort and load.** The earlier estimate was 69-88 agent-days. Dropping the `service.ts` split, the typed-client codemod and the legacy bridge (4-5 days on its own) removes part of it, and the lanes re-estimate at the freeze. Effort is working-day equivalents with several agents in parallel. Live verification and the owner's review, not coding, are the constraint (ARCH 15). Seven lanes run in parallel under one thread, which keeps at most about eight workflows in view (roadmap 5.2). The critical lanes start first (`eng-store`, then `eng-views`) and the others start staggered, to stay inside agent rate limits.

**Priority and slip rule.** Consumers set the order. `prov-gmail` and `eng-views` need `eng-store`'s real `store.commit`, ids and change log by day 6. `ui-reader` needs `eng-html` and `eng-time` for real frames and send states. `ui-onboard` builds on the stand-in engine and needs `eng-ai`'s real `Setup/*`, consent and `Demo/*` in Phase 2. If the Engine thread falls behind, work waits in this order, first item first: the MCP and CLI extras of E7, then the extras of E5's queue (Decision 10, revised). The sealed frame (E4), the outbox (E6) and the views (E3) never wait. E6's timer loop does not wait for E5 (6.1), so `eng-time` can run before `eng-ai`.

"Adversarial" means a different agent, given the code and acceptance criteria but not the author's conclusions, briefed to make a named check fail.

> **What this means:** Nine steps, each tied to one of the architecture's milestones. A three-day freeze comes first, and seven lanes then build in parallel on days 4 to 12. If the work runs long, the doorway's extras wait first. The sealed frame, outbox and views never do.

### 4.1 The contract fixture: shape, milestone and handoff

This is the piece that lets plan 30 start on day 4. It is explicit here because three plans depend on it.

**What it is.** `packages/contract-fixture` exports `createFixtureEngine({scenario, seed, clock})`. It implements the whole v1 contract of `packages/contract` against demo data held in memory, behind the same `EngineConnection` interface the real engine's transports implement (`connect(): {call(method,args), subscribe(frames), close()}`). It has no Node or Electron imports, so it runs in Electron, in the browser preview and in a plain test. It is test-support: nothing from it is bundled into the shipped app, and its demo data never enters the 400,000-byte engine budget.

**Shape.**
- **Verbs implemented:** every method in the registry, including `Session/get` (with a `hasAccounts` flag so main chooses the onboarding window or the mail window), `View/watch|move|unwatch|hold|release|query`, `Thread/get|act`, `Operation/undo`, `MessageBody/get|prefetch`, `Mail/frame` and its release, `Draft/*`, `Submission/set`, `Outbox/pending`, `Setup/begin|end|status`, `Ai/request`, `Ask/run` with `progress` frames, `Settings/*` including the `ui` object, `Account/connect|reconnect|grantPermissions|lease` and the rest of `Account/*`, `Sync/request` with fake statuses, `Unsubscribe/run` (today's `thread.unsubscribe`), `Event/set {scope: occurrence|series|following}`, `Event/rsvp`, `Demo/load|reset|remove`, `Queue/list`, `Diagnostics/preview`. Names and schemas of the plan 20 methods (`Account/*`, `Unsubscribe/run`, `Event/*`) are frozen at C1; their real behaviour arrives with PV3 (accounts), PV4 (unsubscribe) and PV8-PV9 (events and RSVP).
- **`Setup/status` shape** (plan 30 section 8.1 item 12): per account `{state, firstWindow: {found?, read, total}, ai: {sorted, total, capped, failed}, backfill: {read, target}, pausedUntil?, reconnectBy?, reasonCode}`. `firstWindow.found` is an optional estimate, present only when the provider gives one; `firstWindow.total` is the first-window target (about 50 threads), never the mailbox size; `firstWindow` is complete when plan 20 sets `baseline_done_at`; `ai` appears only with stored consent and a provider; `backfill` never gates anything. `reconnectBy` is the account's token grant time plus 7 days while the Google project is in Testing mode, and is absent for other providers, so the UI can warn a day ahead (ARCH 6.4; roadmap N3).
- **Frames:** `state`, `window`, `progress`, `reset`, host-channel events (`notify`, `badge`, `appearance`, `reminder`), with `{dbEpoch, seq}` tokens and receipts that arrive before, after or with the frame (the orderings plan 30's overlay must survive).
- **Windows** run over an in-memory sort with real `holdIds` behaviour and the 4-per-second coalescing, so UI timing is realistic.
- **Scenarios:** the stand-in answers `empty` and `demo` at the freeze, and `eng-contract` adds the rest in Phase 1 (days 4-10). The full list is `empty`, `demo` (today's demo data), `small-10k`, `large-100k` (seeded generator, shared with `bench/store-bench.ts` in E2), `offline`, `needs-reauth`, `backfilling`, `rate-limited`, `partial-threads` (rows with `partial:true`), `send-uncertain`, `send-suspended`, `ai-off`, `ai-budget-spent`, `setup-partial`, `parked`.
- **Test-only control channel** `Fixture/control` (compiled out of production, absent from the registry and OpenAPI): force a status or rate-limit pause, fail the next write, set a submission state, advance setup progress, set the clock (`APLOS_NOW`), replay a frame ordering. This is what plan 30's harness (`plans/30-ui-revamp.md` section 8.1 item 1) asked for.
- **Transports:** (1) in-process for tests; (2) a `MessagePort` pair in Electron dev, so plan 30's typed client is exercised on the same path production uses; (3) a **dev-only loopback HTTP and SSE binding for the browser preview**, built by `eng-contract` in Phase 1 (the registry already drives `server.ts` at F2) by turning `src/main/server.ts` into a thin host that serves either the fixture or the real engine. It already requires a random per-run token that the Vite dev proxy adds server-side, closing today's gap (the preview has a `Host` and `Origin` allowlist but no token). E7 later hardens it with the full request matrix; it does not introduce it.
- **Conformance:** `packages/contract/tests/conformance/` runs one suite against any `EngineConnection`: ordering, `holdIds`, coalescing, receipts, error types, `cannotCalculateChanges`, `reset`. The stand-in passes at the freeze (C1); the real engine runs the same file from day 4 with a shrinking expected-fail list and passes it in E3 by day 11. A fixture-only assertion fails CI, so the two cannot drift.

**Milestone.** One freeze, **C1, at the end of Phase 0 (day 3)**, replaces the earlier C0 preview and day-10 freeze. At C1 the stand-in engine answers every method on `empty` and `demo`, the conformance suite is green on it, and the freeze review below has passed. The Integrator then tags `contract-v1`. After C1, changes are additive within `v:1`, proposed with CONTRACT-CHANGE-PROPOSED and made only by `eng-contract`. A needed breaking change bumps `v` and is a conversation with the UI threads, not a quiet edit.

**Freeze review.** Three reviewers, each a fresh agent given the artifacts but not the authors' reasoning, run the gate (roadmap 1.3). The UI reviewer, briefed from DESIGN section 5 and ARCH 9.2, asks "which UI behaviour cannot be expressed in this contract?" and signs for plan 30. The Providers reviewer runs Gmail, IMAP, JMAP, Graph and CalDAV through `ProviderAdapter`, `GovernorPort` and schema 0001, including the weekly reconnect. The security and platform reviewer checks the registry tags and scopes, the transports, `Mail/frame`, the log catalog and the 400,000-byte budget. The gate also checks plan 30's twelve asks (`plans/30-ui-revamp.md` section 8.1) against the contract:

| Plan 30 ask | Contract home | Notes |
|---|---|---|
| 1 fixture and control channel | this section | |
| 2 view specs | `View/watch` spec union (E3) | |
| 3 `Thread/act`, `Operation/undo`, receipts, `holdIds`, state tokens | E3 | |
| 4 mail frame | `Mail/frame {messageId, imagePolicy, findQuery}` returning `{url, expiresAt, bodyKind, trackersRemoved, hasRemoteImages, quotedCount}`, plus `Mail/frame.release`, `toggleQuotes` and a per-sender image allow-list in Settings | Plan 10 adopts plan 30's name; E4 builds it. The frame token is the URL's path segment |
| 5 submissions and a draft-changed-elsewhere signal | E6; `Draft/changed` frame | |
| 6 setup and AI governance | `Setup/begin|end|status` (wire name `Setup/end`; DESIGN 7.11's old `setup.end` spelling is retired), `Consent/*`, per-account `aiAllowed`, daily cap in Settings; the primary-device lease and override are plan 20's, exposed as `Account/lease` | |
| 7 `Ask/run` citations `{n, messageId, quote}` | E5 | |
| 8 `ui` settings object, retention and resident-mode toggles | `Settings` schema in F1 (fields), behaviour in `eng-host` and `eng-store` | |
| 9 diagnostics, queue inspector, parked event, capability flags | E7; the `parked` event and `Session/get` capabilities in F1 | |
| 10 `APLOS_TEST=1` in main | F8 in Phase 0 (isolated userData, no single-instance lock, Dock icon, menu-bar item or login item; windows created `show:false`) | Plan 40 consumes it in E2E |
| 11 empty start and demo on request | `Demo/load|reset|remove` and `Session/get.hasAccounts` in the registry at C1; real behaviour in E5 item 7 | The fixture honours it from C1 |
| 12 `Setup/status` shape | Shape above; real counts in E5 from plan 20's checkpoints | |

The contract's **Thread row** also carries `partial: boolean` (true while a row was built from one metadata message and its message count is unknown, ARCH 5.1, plan 20 section 2), so the UI never shows "1 message" for a twelve-message thread.

**Handoff.** (1) A README in the package listing verbs, scenarios and the control channel. (2) The conformance suite. (3) The change process above. (4) There is no typed-client codemod over today's 53 renderer `invoke(` sites. Plan 30's new screens call `api.*` from F2, and the old renderer stays read-only in `renderer/legacy/` until Phase 2 deletes it. (5) After E3, the switch from stand-in to real is a flag. `ui-shell` runs it with the Integrator on days 11 to 13, as soon as the real engine's conformance run is green (7.2).

> **What this means:** The stand-in engine is a complete, test-checked copy of the engine's behaviour on demo data. The screens team gets a frozen version on day three, with knobs to force every awkward situation, and later switches to the real engine with one flag.

### 4.2 The legacy bridge: dropped

An earlier draft kept today's screens and the not-yet-rewritten providers running on `mail.db` through a translator (`assembleLegacyState`, `legacyStoreAdapter`, a legacy op kind and a split of `service.ts`). The roadmap deletes all of it, because no release ships today's screens on the new engine.

- Today's engine files sit in `packages/engine/src/legacy/`, the shared files in `packages/contract/src/legacy/` and today's renderer in `apps/desktop/src/renderer/legacy/`. They keep building and their tests stay green, and they are read-only reference.
- The new lanes write straight to `store.commit`. `prov-*` lanes replace each provider, and `ui-shell` switches the new screens to the real engine on days 11 to 13.
- Phase 2 deletes the legacy folders and the old provider files (E8 item 4).

> **What this means:** There is no temporary translator. The old code stays beside the new code as reference, and it is deleted once the new screens run on the real engine.

### E0. Logger and log sink (ARCH M0, Phase 0 artifact F7)

**Goal.** Make the next real Gmail failure explain itself. Today a rate-limit 403 is retried and swallowed and no log exists (`RC/protocols/proto-google.md` §1; ARCH 11).

**Deliverables.**
- **Where it lands.** Directly at final paths on `revamp` in Phase 0: the logger in `packages/engine/src/diag/log.ts` and the sink in `apps/desktop/src/host/logsink.ts`. There is no hotfix branch, and nothing goes to main.
- `Logger` port and `diag/log.ts`: `event(id, fields)` with `id` from a typed catalog (`sync.gmail.request_refused`, `governor.paused`, `send.uncertain`) and a zod schema per event, so an unlisted field cannot be logged.
- Host sink `logsink.ts`: JSON lines in `~/Library/Logs/Aplos Mail/`, 10 MB x 5 rotation, files 0600, directory 0700.
- Root redaction by allowlist: no tokens, keys, `Authorization`, bodies, subjects or snippets; addresses as salted hashes (per-install salt in `meta`); provider error text passes a redactor that hashes anything address-shaped and truncates to 300 characters.
- The classified-error record `{class, reason, status, code, retryAfterMs, providerMessage}` as a contract type, so plan 20's governor fills the same shape later.

**Ownership and dependencies.** Plan 10 writes the logger, sink and catalog. `prov-gmail` adds the Gmail call-site log lines against the frozen `Logger` port (F3) and logs Google's exact reason from its first day. The classified-error record is part of contract v1 (F1), so plan 20's governor fills the same shape.

**Acceptance.**
- A unit test pushes a fake 403 `{reason:"rateLimitExceeded", message:"User-rate limit exceeded"}` through a stub call site and asserts one line with that reason and status 403 and no address, token or subject.
- Canary test: fixtures with `CANARY-xxxx` in subjects, bodies and tokens drive sync, send and error paths; grep over the log directory finds zero.
- File modes and rotation at a small injected cap are asserted. Output pasted into PROGRESS.md.

**Estimate.** 2-3 agent-days, Phase 0 days 2-3, in parallel with F1.

**Work packages.** WP0.1 (one agent): catalog, schemas, logger, redactor. WP0.2 (one agent): sink and rotation. Adversarial: a second agent writes ten hostile log calls (token inside an error message, address inside a URL, subject inside a thrown error's `cause`, nested bodies) and must make any appear in a file.

> **What this means:** Aplos learns to keep a private, safe diary of what Google actually said. It holds no email content, so it can be shared.

### E1. Groundwork: restructure, registry, resident mode, stand-in engine (ARCH M1)

**Goal.** Create the structure everything builds on, keep every commit launchable, and hand the other threads a frozen contract plus a stand-in engine at the end of Phase 0 (day 3), so every lane starts on day 4 (Decision 9; 4.1).

**Deliverables.**
0. **Phase 0 restructure chain (day 1, serial; roadmap 1.1).** Nothing else touches existing files while it runs. Each step is its own commit, merged by merge commit and listed in `.git-blame-ignore-revs` where mechanical. Step 0 is a NOTICE in `plans/STATUS.md`. Step 1 is this plan's rename-and-imports commit (item 1). Step 2 is plan 40's Q1a format commit over the moved tree. Step 3 is the `electron.ts` split (item 2). Step 4 is plan 40's Q1b (lint, suppressions on final paths, hook). Main does not change, so there is no merge of main, no typed-client codemod and no `format-merge.mjs`. The `packages/contract` skeleton is part of F1, written in parallel on new files on days 2 to 3. Plan 40 states the same order.
1. **Mechanical move (step 1), one commit that is a rename plus import-specifier edits only; no other content change.**
   - `git mv apps/desktop/src/engine packages/engine/src/legacy`, so today's engine files sit under `packages/engine/src/legacy/`; workspaces `@aplos/engine`, `@aplos/contract` as internal source packages; tsconfig `paths` and Vite alias.
   - The engine's `src/shared` dependencies move with it: `types`, `ask`, `mailbox`, `summary`, `live` go to `packages/contract/src/legacy/`, and `apps/desktop/src/shared/<name>.ts` becomes a one-line re-export stub so renderer and main imports compile unchanged. The provider types that `shared/types.ts` takes from `engine/provider` (`AccountPreset`, `ProviderCapabilities`, `ProviderKind`, `ServerSettings`) move to `contract/src/legacy/provider-types.ts` and `engine/provider.ts` re-exports them, which prevents a contract-to-engine cycle.
   - Today's renderer moves to `apps/desktop/src/renderer/legacy/`.
   - `shared/version.ts` stays in the app (it re-exports `apps/desktop/package.json`); the engine receives `appVersion` through `EngineInit`, a one-line change at `service.ts:4`.
   - A checked-in script (`scripts/codemod-imports.mjs`) rewrites the roughly 40 importers (`src/main`, `tests`, `scripts`, and the renderer's `AddAccount.tsx` and `DomainCheck.tsx`, which import `engine/discover` and move to `@aplos/engine/discover` until the new onboarding screens put them behind `Account/discover`). It rewrites import specifiers only. It is not the typed-client codemod.
   - `tests/portability.test.ts` moves to `packages/engine/tests/`, **walks `src/` recursively from one `src/index.ts` entry** (today it lists the folder's top-level files, so subfolders would be silently skipped), forbids `electron` and `node:` imports, and gets a negative test that plants a `node:fs` import in a subfolder and expects failure. Its checks of `src/main/store`, `groq` and `memory-stage` stay in `apps/desktop/tests/engine-host.test.ts`.
   - Build wiring as section 3 describes (esbuild bundling `@aplos/*`, tsx, Vite, electron-builder dependencies), proven by `npm run package` and `verify-release.mjs`.
   - The legacy folders keep building and their tests stay green. They are read-only reference until Phase 2 deletes them (E8 item 4).
2. **Split `electron.ts` (step 3).** Split `apps/desktop/src/main/electron.ts` into `windows.ts`, `lifecycle.ts`, `protocol.ts`, `menu-bar.ts`, `native-methods.ts`, `security.ts`, `updater.ts` and `engine-host.ts`. Code moves only, and tests stay green. After the split each module belongs to one lane (roadmap 2.1 and 2.5). `service.ts` is not split. It stays whole in `packages/engine/src/legacy/`, and the lanes reimplement its behaviour against the ports. Its seams [V] show which lane takes each behaviour: validation (`:58-130`) goes to the registry in `eng-contract`; state, publish and epoch (`:225-267`) go to `eng-views` and `eng-store`; op flush and sync (about `:290-340`) go to `prov-gov`; drafts, send and timers (`:339-410`, `:758-790`, `:953-959`) go to `eng-time`; Ask and AI (`:479-560`, `:816-916`) go to `eng-ai`; calendar (`:916-950`) goes to `prov-cal`.
3. **Registry steps 1 and 2** (`RC/gaps/engine-contract-rpc-stack.md` §7; artifacts F1 and F2, `eng-contract`): zod input schemas for the 47 engine and 19 desktop methods; `host: engine|desktop`; generated `methods.generated.ts` imported by preload (which never imports zod); `engine-host.ts` and `server.ts` sets derived from it; a host-agreement test; a typed client (`api.thread.update(...)`). There is no codemod over today's 53 renderer `invoke(` sites. The new screens call `api.*`, and the old renderer stays in `renderer/legacy/`. The human sentences of today's hand-written validators carry over into the schemas, so UI-visible wording does not change. `z.config({jitless:true})` in the renderer (CSP forbids eval).
4. **Resident mode and lifecycle** (`eng-host`, days 4-7; `RC/gaps/macos-daemon-lifecycle.md` §9; ARCH 2.2-2.4):
   - closing the last window keeps main and engine alive; accessory activation policy with no window (Decision 1); menu-bar item with sync state, Open Aplos, Pause sync for 1 hour, Quit Aplos completely; ⌘Q is a full quit with the pending-work warning (Decision 2); `wasOpenedAtLogin` starts windowless (the login item is registered through the existing `system.login` method);
   - `powerMonitor` `resume` and `unlock-screen` call `engine.wake()`; a wall-clock jump over 30 s between 1 s ticks is the fallback;
   - `run/aplos.lock` (pid and start time; dead-pid locks reclaimed) so a second engine on the same data refuses to start; the browser preview keeps its own data directory (AGENTS.md);
   - states `starting | ready | parked`; 3 s drain on quit or update; the 3-exits-in-60-s guard extended to `parked` with "Export diagnostics / Try again" (the report arrives in E7; until then it reveals the log folder); the `parked` event and `Session/get` capabilities are in the contract from C1;
   - event-loop-delay monitor (log p99 over 500 ms) and an actor-heartbeat supervisor that restarts a silent actor alone after 2 minutes (plan 20 builds actors).
5. **SQL port and self-test** (`eng-host` for the self-test, `eng-store` for the port): `Uint8Array` values and `iterate()`. One function, `packages/engine/src/selftest.ts`, asserts `sqlite_version()` at least 3.43, FTS5 present and `contentless_delete` working, because `node:sqlite` follows Electron's SQLite (`RC/gaps/storage-engine-benchmark.md` §7). It has two launchers: CI runs it inside Electron's own Node (plan 40's `ELECTRON_RUN_AS_NODE=1` job, unpackaged), and the packaged app runs it as `Aplos Mail --selftest`, a main-process flag that forks the engine `utilityProcess`, prints JSON and exits. The packaged launcher must not use `ELECTRON_RUN_AS_NODE`, because plan 40's fuses turn that off. A **`KeyProvider` port** (F3) carries the data key (today `EngineInit.key`), keeping A1 cheap.
6. **Stand-in engine, preview host and freeze (4.1).** `packages/contract-fixture` (F6) and the conformance suite, plus `src/main/server.ts` as a thin host serving the stand-in or the real engine with a per-run token (`eng-contract`, Phase 1). The freeze C1 comes at the end of Phase 0 (day 3). There is no C0 preview.
7. **Records.** The ADR-19 amendment (section 3), the frozen list and C1 are written to DECISIONS.md in Phase 0.

**Ownership.** Plan 10 owns `packages/*`, `host/*` and the split `main` modules named in section 3. Plan 40 writes fuses and plist. Plan 30 is touched only by the legacy move in step 1, and it supplies the menu-bar glyph; E1 ships a plain-letter placeholder, never a sparkle, wand or star.

**Dependencies.** Plan 40's Q1a and Q1b land in their Phase 0 slots (steps 2 and 4). Its fuses and macOS 13 are needed for the packaged resident-mode check (day 7). The rest proceeds without them.

**Acceptance.** By the freeze (day 3):
- `typecheck` and `test` pass at every restructure commit; no test deleted without a replacement.
- `npm run package` builds, `verify-release.mjs` finds `@aplos/*` code and zod in the packaged bundles, and the packaged app starts and lists demo mail (the build-wiring proof).
- Host-agreement test: preload, `engine-host.ts` and `server.ts` equal the generated set (66/47/47 drift gone).
- Portability test passes recursively, fails on the planted subfolder import, and engine plus zod size is recorded against 400,000 bytes.
- Conformance suite green on the stand-in engine; the three-reviewer gate passed; C1 and the frozen list recorded in DECISIONS.md.

In Phase 1 (`eng-host` by day 7, `eng-contract` by day 10):
- Packaged app: a hidden-start launch (`--start-hidden`, no visible window driven), closing the only window leaves main and the engine alive, and a reminder due in 60 s fires with no window (`scripts/verify-resident.mjs`, output attached). `Aplos Mail --selftest` prints a passing JSON report.
- A second engine on the same data exits with a clear message; a stale lock is reclaimed. A fake clock jump of 31 s triggers one `engine.wake()`; the real `powerMonitor` path is checked once by the owner closing the lid for a minute.
- The browser preview refuses a request without the dev token and serves the stand-in's `demo` scenario headlessly through the typed client.

**Estimate.** Phase 0 is days 1 to 3, and `eng-host` finishes resident mode by day 7. The agent-days are re-estimated at the freeze, because the `service.ts` split and the codemod are gone.

**Work packages.**
- WP1.1 (one agent, first, serial): move, shared-file relocation, import rewrite, portability test, build wiring. Adversarial: confirm the rename (`git diff -M --stat`), that the non-rename diff touches only import and export specifier lines, `git log --follow` on five files, and that `npm run package` and `verify-release.mjs` pass.
- WP1.2 (one agent, serial, after WP1.1): the `electron.ts` split. Code moves only. Adversarial: the packaged app starts and lists demo mail, and the non-move diff is empty.
- WP1.3 (fan out by method area): schemas, generator, agreement test, typed client. Adversarial: fuzz each schema with invalid inputs and compare error sentences with today's; any changed UI-visible sentence fails.
- WP1.4 (two agents): lifecycle, lock, menu bar, quit flow. Adversarial: kill the engine at each startup step; the next launch must recover.
- WP1.5 (one agent): SQL port, selftest and CI checks, run against Electron's own SQLite.
- WP1.6 (two agents plus the three reviewers): stand-in engine, control channel, conformance suite, preview host. The reviewers check the table in 4.1, and every gap is fixed before C1.

> **What this means:** By day 3 there is a tidy layout, one list of allowed commands instead of three, and a stand-in engine, so screen work can begin on day 4. The old code stays beside the new code under `legacy/` folders. Aplos is alive in the menu bar by day 7.

### E2. The new store (ARCH M2)

**Goal.** Replace the in-memory mailbox with the normalized `mail.db` of ARCH 3.2, import today's data safely, and persist the change log, so restarts stop forcing re-snapshots and a 200,000-message mailbox opens in milliseconds.

**One lane.** `eng-store` owns all of E2, days 4-10. Schema 0001 and a minimal working `store.commit` are Phase 0 artifact F4, written by the Engine thread and reviewed by Providers. The real commit with rollups, ids and the change log is due on day 6, because `prov-gmail` and `eng-views` wait for it. Bodies, paced FTS and retention follow by day 9, and the importer and benchmark by day 10.

**Deliverables.**
1. **Migration framework.** `packages/engine/src/store/migrations/NNNN_name.ts`, `PRAGMA user_version`, a checksum row per applied migration to catch edited history, engine-only (ARCH 2.6), a failed migration parks the engine (ARCH 3.7), `mail.db.pre-<version>` copies before later migrations (last two kept). A newer schema refuses to open with today's sentence (`store.ts:13`).
2. **`mail.db` creation:** `STRICT` tables; pragmas `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `journal_size_limit=67108864`, `temp_store=MEMORY`; `auto_vacuum=INCREMENTAL` at creation, since it cannot be added later without a full `VACUUM`. The schema is ARCH 3.2; plan 20 reviews it before E2 merges.
3. **Date-ordered message ids:** `seconds x 4096 + n`, with seconds clamped to the range 0 to 2^32 (pre-1970 and absurd dates sort at the ends, never go negative). The allocator takes the highest existing id at or above `seconds x 4096`; if that second's 4,096 slots are full it carries into the next second's range and **continues from the highest id found there**, so a carried id can never equal one already issued. A property test fills seconds past capacity out of order. The maximum, about 7.4e12 for 2026 and about 1.8e13 at the 2^32 clamp, is inside the safe-integer range [I]. Provider internal date, never the `Date:` header (`RC/gaps/storage-engine-benchmark.md` §7). Contract ids stay strings (`accountId:remoteId`) (ARCH 3.1).
4. **One write path.** `store.commit(fn)` is the only way to write: one transaction that runs `fn`, recomputes touched threads' rollups as a SQL aggregate over their messages (never from the incoming batch; drafts excluded; folder membership from messages not in Trash or Spam), writes `changes`, bumps `seq`. One writer connection, short reads (ARCH 3.7).
5. **Change log.** `changes(seq, type, id, op)` in the same transaction as every write; one coarse `*` entry per backfill page; compaction at 50,000 entries or 30 days with a recorded floor; opaque `{dbEpoch, seq}` tokens with an HMAC for network clients; `dbEpoch` changes only on creation, reset or restore. `T/changes` returns `{oldState, newState, hasMore, upserted[], destroyed[]}` or `cannotCalculateChanges` below the floor (`RC/gaps/engine-contract-rpc-stack.md` §5.2, §7 step 3).
6. **Bodies and attachments** (ARCH 3.3): one record `{text, html, cidMap, quotedRanges}` of the provider's original content, codec 1 zstd-3, 2 gzip, 0 raw, with a runtime probe falling back to gzip (zstd is experimental in Node 24 [V storage §6]). Attachments are files under `attachments/.noindex/`, never base64 over IPC. Content-addressed body files are rejected (32% more disk, 4.5x slower opens [M storage §0.4]).
7. **Paced FTS.** One contentless FTS5 table in the main file, `detail=full`, no prefix index, body capped at 16 KB, subject and people in full. An idle loop indexes 100 messages per batch for messages lacking the `fts` bit (a partial index makes the backlog free and restart-proof), inserting FTS rows last in each transaction (1.5-1.8x faster [M storage §5.1]) and pausing while a sync commit or interactive call is in flight. Newest-first local search is `ORDER BY rowid DESC` (0.05 ms against 32-40 ms [M storage §0.5]).
8. **Open-thread port and partial rows.** The open-thread rule sits behind a thread-granular port: `ProviderPort.openThread(account, remoteThreadId, {knownCount?})` returns all of a thread's messages and bodies, and the adapter picks `threads.get` or `messages.get` (plan 20 section 2: `threads.get?format=full` on open unless the engine already knows the thread has one message). The engine neither knows nor cares which call is made, so ARCH 5.1's two-or-more-messages wording, which cannot be evaluated before a count exists, is replaced by plan 20's rule in DECISIONS.md in Phase 0 (ARCH amendment AM-1). Rows with `complete=0` surface as `partial:true` (4.1).
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
| `ops(data)` | native `ops` (ARCH 4.3's replay model); the importer translates each pending op, with `prov-gov` reviewing the mapping, and counts any it cannot translate in the content-free import report |
| `sync_cursors` | `sync_state(scope='history')` with `phase='needs_reconcile'` and `generation` bumped, so Gmail runs a generation sweep instead of trusting an old cursor (ARCH 4.2 rule 3) |
| `threads(data)` | `threads`, `messages`, `message_folders` (from `labels`), `thread_folders`, `bodies`, `attachments`, `thread_workflow` (status, bookmark, reply status, due, reminder, todo, hidden; importance to `lane` and `importance`, legacy low to `low`, then re-checked by `laneFor`), `summaries` (`input_hash` from message ids and text hash) |
| `thread_text` FTS | not copied; the paced job rebuilds it |
| Messages without a provider id (demo account, locally sent messages, legacy `randomUUID` ids) | `remote_id` = the legacy id, `origin='local'`, internal date from `date`; the thread's `remote_id` likewise falls back to the legacy thread id, so natural-key upserts stay unique and a later sync can adopt them |
| `Attachment.data` (inline base64 in the legacy JSON) | written to `attachments/.noindex/` as a file with `state='present'` and its path; never kept in the row or sent over IPC |

One transaction per table family, then per 500 threads, with `meta.import_state={family,lastKey}` written inside each, so a kill resumes at the next unit; writes are keyed by natural ids so re-running a unit is harmless. At the end `meta.imported_from`, `import_done` and a fresh `dbEpoch`. The engine reports `starting` with a progress object (copy "Moving your mail, n of N" is plan 30's). Gmail accounts then reconcile with a generation sweep (plan 20).

**Ownership.** Plan 10: `eng-store`. Plan 20 reviews the schema in Phase 0 (F4) and consumes `store.commit`, `sync_state`, `governor_state`, `sync_failures`, `provider_memory`.

**Dependencies.** F3 and F4 from Phase 0. `prov-gmail` and `eng-views` need the real `store.commit`, ids and change log by day 6. The Gmail chain is the critical path (roadmap 4.1), so a slip is reported the same day. Plan 40: CI runs the SQLite check and the benchmark gate. Plan 40's expectation of a seeded store generator "at M1" is met by `bench/store-bench.ts` and by the stand-in engine's generator (4.1), which share one seeded source.

**Acceptance.** The replay property test, the restart-keeps-`dbEpoch` check, the rollup checks and the id allocator test close by day 6 with the real commit. Everything else closes by day 10.
- `bench/store-bench.ts` on the owner's Mac at 200,000 messages, numbers in PROGRESS.md, against targets set from `RC/gaps/storage-engine-benchmark.md` §0 (research value in brackets): first 50-row page p50 under 1 ms [0.04-0.07]; all unread counts under 10 ms [5]; label-change commit p50 under 1 ms [0.2]; page commits with FTS deferred at least 3,000 msgs/s [11,469 without FTS; this schema adds rollups and `changes`, so the first run recalibrates]; cold open to first rows under 50 ms [about 10]; engine RSS after the first page under 120 MB [65]; local newest-50 search under 5 ms.
- Replay property test: a seeded generator applies upserts, deletes, label moves and rollups (seed printed on failure) and asserts `snapshot(seq0)+changes == snapshot(seqN)` over 1,000 sequences, including coarse entries and the below-floor case (Bulwark shipped two delta bugs, `RC/arch/extra-bulwark-legacy-proxy.md`).
- Restart keeps `dbEpoch`, and `T/changes` from the old token returns only the delta.
- Kill-mid-import: an engine child is killed at 20 seeded points in a 50,000-thread import; each restart resumes and the final counts and a content hash of sampled threads equal an uninterrupted import.
- Rollback drill: a test opens the untouched `aplos.db` with a frozen copy of main's `createMailStore` (`tests/fixtures/legacy-store.ts`) and asserts `load()` equals the original; the owner repeats it once on a copy of the real data with a v0.2.3 build (counts only).
- Import edge cases: messages with no provider id, inline-base64 attachments written to files, and 1970 and 2099 dates all import; the id allocator never repeats an id across 10,000 out-of-order inserts.
- Rollups: a trashed reply does not trash the conversation; drafts do not change counts; counts equal an independent slow query. Eviction refetches through a stub provider and never runs while an actor reports `backfilling`.

**Estimate.** 10-12 agent-days in one lane (14-17 before the bridge was dropped), days 4-10.

**Work packages.** WP2.1 (one senior agent): migrations, schema, ids, `store.commit`, rollups (the costliest-mistake part). WP2.2: change log, tokens, replay test. WP2.3: bodies, FTS job, retention. WP2.4 (two agents, by table family): importer. WP2.5: benchmark and CI gate.
Adversarial: (a) an agent corrupts the importer's input (missing messages, duplicate ids, 3,000-message threads, dangling labels, dates in 1970 and 2099) and must get a clean import or a clear error, never a crash or silent loss; (b) an agent feeds rollups out-of-order batches and compares to a slow reference; (c) a reviewer reads `store.commit` for any write outside the transaction.

> **What this means:** Your mail moves into a database built for speed. It opens in milliseconds at any size, restarts remember where they left off, and the old file stays untouched as a way back.

### E3. Live windows, direct MessagePort, main out of the data path (ARCH M4, engine half)

**Goal.** Give screens windows of rows that update in place and take main out of the data path, so a 100,000-thread mailbox costs the same as a small one.

**Deliverables.**
1. **View specs and compiler:** `home`, `later`, `all`, `drafts`, `sent`, `needs-reply`, `awaiting-reply`, `trash`, `spam`, `low`, `label:<id>`, `search:<q>`, each with an optional account filter. Today's `threadInView` and `isHomeNew` (`shared/mailbox.ts`) become SQL over `thread_folders`, `thread_workflow` and the `home` index. Keyset paging, never `OFFSET`.
2. **Window engine.** `View/watch {spec, holdIds?}` returns a first `window {windowId, state, ids, total, changed}` of at most 200 body-free rows. After each commit the engine maps the change set to candidate windows and re-runs their keyset queries at most 4 times a second per window, coalesced and gated by account and type, pushing ID-only frames; clients `Thread/get` only unknown or stale rows (ARCH 9.2). Backfill's coarse entries cause one re-run per page (the storm risk, `RC/gaps/engine-contract-rpc-stack.md` §8). `View/move`, `View/unwatch`, and `View/query` for one-shot reads (CLI, MCP, search).
3. **Holds** (DESIGN section 5 rule 6): `View/hold {windowId, ids}` and `View/release`; held rows keep their positions until released or about 2 s after the client's last activity signal, so an AI re-rank never moves the row being triaged. Rank is a lane and a due band, not a score (ARCH 8.2).
4. **Commands and receipts.** `Thread/act {opId, ids, action}` applies inside one commit, enqueues the provider op (replay model, ARCH 4.3) and returns `receipt {opId, appliedState}`; the client drops its overlay once a window reaches that state. `Operation/undo` enqueues the inverse operation, never a delayed commit (DESIGN rule 11). `Session/get` returns `{apiVersion, appVersion, schemaVersion, dbEpoch, capabilities}`. `state` frames coalesce over 50-250 ms; `progress` is ephemeral and never logged; `reset {reason}` re-opens windows.
5. **Direct MessagePort.** Main creates a `MessageChannelMain` per window, transfers one port to the engine and one through preload; preload checks the generated allowlist; ports go only to a window's trusted main frame (mail frames fail `assertCaller` by design) (ARCH 9.4, 12.1). Binary data moves as transferable `ArrayBuffer`, never base64, which removes the 25 MB base64 `ai.transcribe` payload.
6. **Main leaves the data path.** `latestState` is deleted. Main keeps native methods (`window.*`, `file.*`, `system.*`, `update.*`) and receives typed **host-channel** events from the engine: `notify`, `badge {count}`, `appearance {theme}`, `openExternal`, `reminder`. `window.compose` validates its draft through main's own engine connection (`Draft/get`) instead of the mirror (`electron.ts:183`). The `did-finish-load` re-send (`electron.ts:110`) goes with it, because the new renderer reads state through windows.
7. **Client runtime** in `@aplos/contract/client`: connection with `since` resume (and `Last-Event-ID` over HTTP), row cache, `WindowStore` replacing `shared/live.ts`. Plan 30 wraps it in React hooks. `MessageBody/prefetch {ids}` with cancel serves DESIGN rule 9.
8. The real engine passes E1's conformance suite; the UI switches from the stand-in engine to the real one by flag on days 11 to 13 (`ui-shell` with the Integrator; 7.2).

**Ownership.** Plan 10: views, client runtime, port wiring, host channel. Plan 30: React side and window creation. Plan 40 reviews `assertCaller` and port handoff.

**Dependencies.** Schema 0001 (F4) for the compiler, and `eng-store`'s real commit from day 6 (WP3.1 starts on the schema); the Phase 0 freeze. Plan 30 builds against the stand-in engine in parallel. Plan 20 supplies account status and backfill state for gating (the status vocabulary of ARCH 6.4 is a contract type defined here).

**Acceptance.**
- Conformance suite passes on the real engine with the fixture's assertions.
- At 100,000 threads: window re-run p95 under 1 ms [0.12 ms, `RC/gaps/engine-contract-rpc-stack.md` §3.2]; `View/move` p95 under 5 ms; `Thread/act` plus receipt p95 under 4 ms (inside DESIGN's 8 ms key-to-state budget); window open at most 200 rows and under 150 KB.
- Burst: 10 `Thread/act` in 2 s return 10 receipts, at most one window update per 250 ms, no held row moves.
- A grep test fails if `latestState` or a whole-state mirror exists in `src/main`; a payload test fails on any engine-to-renderer message over 256 KB outside blob routes.
- Kill the engine: windows reconnect and resume with the same `dbEpoch`, no re-snapshot. A second window gets its own port; closing one leaves the other's windows and holds untouched.

**Estimate.** 10-12 agent-days: `eng-views` on days 4-11, with `eng-contract` carrying the transport half to day 10.

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

**Ownership.** Plan 10: `packages/mail-html`, `host/protocol/`, render and proxy code, `main/protocol.ts`. Plan 30: frame element, host chrome. Plan 40: reviews headers and the `webRequest` handler, and edits the host-page CSP (ARCH 12.1) once the frame exists. The stand-in's `srcdoc` frame is plan 30's; this replaces it.

**Dependencies.** E2 (stored originals, bodies from `eng-store` by day 9) and E3 (control connection) for the render pipeline and relay. The parser spike, sanitizer, hostile corpus, leak harness and SSRF classifier (WP4.1 to WP4.3 and WP4.5) need neither, so `eng-html` starts them on day 4. E4 does not slip (Decision 10, revised). `ui-reader` uses the `srcdoc` frame on the stand-in engine until the real frame lands, around day 10.

**Acceptance.**
- **Hostile corpus**, at least 60 original messages: inline scripts and handlers, `javascript:` and `data:` URLs, meta refresh, `<link>` prefetch, preconnect, CSS `url()`, `@import`, `@font-face`, `image-set()`, `<base>`, SVG script and `foreignObject`, auto-submit forms, nested iframes, `object` and `embed`, mXSS mutation payloads, 100,000-element nesting, 5 MB single lines, malformed encodings, 1x1 and hidden pixels, open-redirect image URLs.
- **Leak test:** a headless, `show:false` Electron driven by Playwright's Electron support (never a visible window) loads the corpus through the real protocol handler; a canary HTTP server on a random loopback port, a DNS canary and the Chromium net log are inspected. Images off: zero requests and zero canary DNS lookups. Images on: only the engine's proxy connects, and every SSRF case is refused (127.0.0.1, `[::1]`, `::ffff:127.0.0.1`, 10/8, 169.254.169.254, decimal, octal and hex IP forms, a resolver answering public then private, a redirect to a private address, port 8080).
- The shipped reporter's SHA-256 equals the CSP value; an email's inline script never runs.
- Sanitizer median under 5 ms and p99 under 40 ms per message on the corpus and a realistic sample (calibrate on first run); bundle size recorded.
- Old-mail test: change a rule, bump the version, re-open a stored message with no provider call. The 13th render evicts the oldest.
- Keyboard-relay hand-check in the packaged app recorded in PROGRESS.md (owner step, or a background Cua-driver run on the exact window that never raises it); if neither is possible, the fallback relay ships and the gap is recorded.

**Estimate.** 8-10 agent-days in `eng-html`, days 4-10.

**Work packages.** WP4.1: parser spike. WP4.2: sanitizer. WP4.3: corpus and leak harness. WP4.4: render pipeline, tokens, LRU, relay. WP4.5: image proxy and SSRF classifier with table-driven tests.
Adversarial: a time-boxed "bypass" agent, given only the allowlist and headers, tries any script execution, outbound request or storage write from a corpus message (each success becomes a corpus entry and a fix); another audits the SSRF classifier against RFC 6890 and the IPv6 special-use registry.

> **What this means:** Each email is cleaned by the engine and shown in a sealed box that cannot send anything, reach your files, or tell the sender you opened it. Images load only when you allow them, through a guard that refuses internal addresses.

### E5. AI queue, budget, consent, heuristic Home, `Setup/*` (ARCH M5)

**Goal.** Move background AI into one durable, budgeted, consent-gated queue that never touches a sync transaction, make Home sensible with AI off, and fix the PR #21 engine findings structurally.

**Deliverables.**
1. **Jobs:** the `jobs` runner with singleton key `summary:<thread>:<input_hash>` (content-keyed: a label change does not invalidate it, a new reply does), priority (visible Home, then unread Inbox newest first; never Spam, Trash or a baseline account), backoff, dead letter after 5 attempts, 1-2 concurrent jobs per provider, `running` returns to `queued` on restart (ARCH 2.3). Kinds: `summary` (which also returns the Home lane, a due date found in the text and the suggested action), `classify`, `plan`, `suggest-action`, and `followup` (singleton key `followup:<thread>:<last_sent_hash>`, queued when a thread enters Home's Follow up, after summaries in priority; it writes a short nudge kept as a local suggestion, never a synced draft, until the user keeps it; ARCH 8.1, DESIGN §7.2). Background jobs run with **no tools**, mail wrapped as quoted untrusted text, output validated against preset `SuggestedAction` kinds (ARCH 8.5).
2. **AI governor and budget:** per provider and model, RPM, TPM and TPD learned from response headers, `Retry-After` honoured; a daily-token 429 stops that model's queue until reset with a visible reason; `ai_usage` per day, provider, model, lane; a background cap of 150,000 tokens a day by default (ARCH decision 13); interactive Ask, draft, polish and transcribe are never starved. All SDKs run with `maxRetries: 0` (Anthropic and OpenAI SDKs retry by default; `main/anthropic.ts` changes), so this governor is the single AI retry layer. Provider transports move to `apps/desktop/src/host/ai/` (today's `main/{groq,llm,ollama,anthropic,ai-keys}.ts`) and gain a response-header callback.
3. **Consent:** `consent(scope, version, provider, granted_at)` plus per-account `ai_allowed`; enqueueing checks stored consent; changing provider or scope bumps the version and pauses background AI until re-consent. Each provider carries `trainsOnInputs`; mail content never goes to one marked true; free-tier Gemini is true unless the owner marks the key paid (Decision 8); Ollama and LM Studio are local. 0.2.x installs see the card once (Decision 7).
4. **Heuristic Home** (ARCH 8.2, DESIGN §7.2): pure `laneFor(headers, labels, correspondents, invite, thread)` in `ai/lanes.ts` returning `{lane: do|update|low, importance: important|normal, due?}` from `List-Unsubscribe`, `Precedence: bulk`, `Auto-Submitted`, no-reply senders, Gmail `CATEGORY_*` and `IMPORTANT`, direct versus cc, known correspondent, an existing user reply, invitations, and structured delivery, reservation and bill markup when a body is present. Plan 20's ingest calls it inside the sync commit and stores `rank_source='heuristic'`; it runs again when a body is fetched; AI may later set `'ai'`; rule and user choices (⌥↑ / ⌥↓ through `Thread/act`) win. The `home` view spec computes Follow up (the user sent the last message, no reply within the nudge period) and keeps `due_band` fresh through the timer loop at local midnight. A thread is never held back for AI.
5. **`Setup/begin|end|status`** replacing `deferAI` (DESIGN 7.11-7.12, Appendix C): deferral is the account's silent baseline (`baseline_done_at` null) plus consent, not an in-memory set. `Setup/end` is idempotent and always enqueues a one-shot backfill of unsummarised threads (visible Home first, including reply refresh); every job has its own id and singleton key so Retry cannot collide; disconnect deletes the account's queued jobs; a connect resolving after `Setup/end` is classified normally. `Setup/status` returns the per-account shape of 4.1 (first window found as an optional estimate, read and total; AI sorted, capped and failed; backfill; `pausedUntil`; a reason code) and collects errors, so "Done" can say "partly done".
6. **Interactive path:** `Ai/request`, `Ask/run` with `progress` frames and cancel, `Blob/put` for audio so transcription stops carrying base64.
7. **Empty start and demo on request** (owner wish, DESIGN 7.11 as amended; plan 30 section 8.1 item 11): a fresh install, and an import of an empty or absent store, creates **zero accounts and no demo data** (today `service.ts:195` seeds `createDemo` whenever the store is empty). `Demo/load|reset|remove` are idempotent and touch only demo accounts; saved demo or real data is never seeded over or wiped. `Session/get.hasAccounts` lets main open the onboarding window or the mail window.

**Ownership.** Plan 10. Plan 20 calls `laneFor` and supplies the headers and labels (ARCH 5.1's field mask already lists them). Plan 30 builds the consent card, onboarding and Settings → AI.

**Dependencies.** F1 to F4 and `eng-store`'s real commit (day 6); `eng-views` for Home ranks; plan 20's `baseline_done_at` (a stub actor until `prov-gov` lands). `ui-onboard` builds on the stand-in engine and needs the real `Setup/*`, consent and `Demo/*` in Phase 2, so `eng-ai` (days 4-11) may run after `eng-time` if it still lands by then.

**Acceptance.**
- With the AI transport rejecting or never answering, Home orders by lane, due band, importance and date, Follow up still lists, and rows appear without waiting.
- No `followup` job enqueues without stored consent or past the daily cap; a new reply retires the old suggestion.
- Property test over random event sequences (connect, sync batch, close, reopen, consent change, disconnect): no job without stored consent, none for a baseline account.
- PR #21 scenarios as engine tests (DESIGN Appendix C): reopen, connect, close, new mail classified (F1); sync, close, every thread classified (F2); Retry during a running pass does not collide (F5); a reply during deferral is re-summarised (F6); capped or failed passes report partial or failed with errors (F10). PR #21 stays unmerged; tests target `Setup/*`.
- A daily-token 429 pauses that model's queue with a reason while Ask on another model answers; a fake clock past reset resumes it. The 150,000 cap stops enrichment and leaves interactive calls working.
- Background provider calls have `tools` undefined; a malicious summary yields only text or a preset action. A free-tier Gemini mail job is refused with a plain reason.
- Every SDK client is built with retries off; a stub returning 500 counts exactly one attempt.

**Estimate.** 6-8 agent-days in `eng-ai`, days 4-11.

**Work packages.** WP5.1 jobs. WP5.2 AI governor and usage, fake-clock tests. WP5.3 consent and `trainsOnInputs`. WP5.4 lanes with a 60-case header table, including Update cases (deliveries, scheduled payments, FYI from people) and security notices going to Low. WP5.5 `Setup/*` and the PR #21 tests. WP5.6 interactive path and blobs.
Adversarial: one agent tries the worst orderings of close, reopen, retry, disconnect and reconnect to leave a consented account with no AI; another tries to get mail text to a `trainsOnInputs` provider by switching providers mid-queue.

> **What this means:** Home sorts sensibly even with AI off. Summaries arrive afterwards, within a daily budget you control, only after you agreed to what is sent where. Closing setup at any moment can no longer leave an account without AI.

### E6. Outbox, drafts, timers, notifications (ARCH M6)

**Goal.** Make sending double-send safe and every timed feature durable, with one clock that survives restarts and speaks honestly after the Mac slept.

**Deliverables.**
1. **Submissions** `queued → sending → sent | uncertain | failed`, plus `cancelled` and `suspended` (ARCH 7.1). Today's `pendingSendAt`, `sendAttemptAt`, `resendConfirmed` become rows (E2 already imports them). The Message-ID is generated once. The attempt marker (`state='sending'`, `attempt_at`) is committed **before the first byte leaves**. Adapter contract, agreed with plan 20: `send(mime, signal)` resolves `{accepted, remoteId?}` or throws `NotSentError` for provably-not-sent cases (no connection, DNS failure, 4xx before acceptance, send-limit 429); any other error is `uncertain`. Uncertain is never replayed: the engine calls `findSent(internetId)` (`rfc822msgid:` on Gmail, `HEADER Message-ID` on IMAP, `internetMessageId` on Graph, `Email/query` on JMAP), settles `sent` on a match, else surfaces "We could not confirm this was sent. Check Sent, or Send anyway." Exact MIME is kept until `sent` is confirmed.
2. **Undo send and send later are one mechanism:** `not_before` is now plus the undo window (Settings `undoSeconds`) or the chosen time; `Submission/set` covers send, undo and schedule.
3. **Overdue:** a waiting submission (`queued`, or `scheduled` for send later; `WAITING_SUBMISSION_STATES` and `OVERDUE_GRACE_MS` in `@aplos/contract/rules`) more than 5 minutes past `not_before` at launch or wake becomes `suspended` ("Missed its time while your Mac was off. Send now or Reschedule", ARCH 7.3); an undo-window send interrupted by a quit and relaunched inside the grace sends normally.
4. **Drafts:** local draft with `revision` is truth; compare-and-set saves; content fingerprint skips unchanged uploads; per-draft serialised sync through a `DraftSyncPort` plan 20 implements (Gmail upload after 5 s idle and on close, IMAP `APPEND` then delete the previous copy by `APPENDUID`, JMAP and Graph native). The engine owns scheduling and the "keep mine, take theirs, or keep both" conflict state; other devices' drafts show in Drafts, never in threads (ARCH 7.4).
5. **One timer loop** sleeping until the earliest deadline across registered **deadline sources**: `submissions.not_before`, `reminder_at`, `later_until`, plus `jobs.next_at`, `ops.next_at`, governor `cooldown_until` and plan 20's next-poll times, registered by their modules. It recomputes after any commit touching those columns, at launch and on wake, replacing the 30 s reminder interval and ad-hoc send timers. Late reminders and Later returns fire with "was due 9:00" (Decision 3). The clock is an injected `Clock` port.
6. **Notification outbox:** `notifications(message_id, state, created_at, claimed_by)` written in the sync commit for new inbound Inbox mail after the silent baseline; main claims and posts through the host channel and marks `posted` after the system shows it; the Dock badge comes from engine counters (ARCH 7.6).
7. **`Outbox/pending`** returns `{scheduledSends, reminders, uncertain}` for the ⌘Q warning.

**Ownership.** Plan 10; plan 20 implements `send`, `findSent`, `DraftSyncPort`; plan 30 writes the copy for suspended, uncertain and failed states from the engine's sentences.

**Dependencies.** E2 and E3's contract surface. **Not** E5: the timer loop has a registry, and `jobs.next_at` registers itself when E5 lands, so E6 can run first (`prov-gmail-write` starts on day 6 against the frozen `SendPort` and `DraftSyncPort`). Plan 20's emulated providers with fault injection.

**Acceptance.**
- **Kill-point matrix:** the engine child is killed at four named points per provider emulator (before the marker; after it and before bytes; after bytes and before acknowledgement; after acceptance and before the local commit). On restart there is never a duplicate delivery (the emulator counts) and never a silent loss: each ends `sent`, `failed` with a visible reason, or `uncertain` with the prompt. Kill points exist only in test builds; a release-bundle grep asserts their strings are absent.
- One real send to an owner-controlled address on Gmail (iCloud joins in round 2), the owner killing the engine once mid-send (owner step; Sent folder counts and log events are the evidence; mocked Google never counts, AGENTS.md).
- Overdue: a fake-clock jump for the automated case; for the owner, a send scheduled 2 minutes out and the lid closed 10 minutes: on opening, the prompt appears and nothing went late.
- Timer loop on a fake clock: earliest-deadline order, recompute after commit, 20 overdue items caught up in order, wake-ups per hour capped.
- Notifications: 50 simulated syncs with a crash between written and posted yield exactly one notification per message.
- Draft CAS: two saves with the same base, one wins and the other gets `stateMismatch`; a remote edit raises the three-way choice.

**Estimate.** 7-9 agent-days in `eng-time`, days 4-10.

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
7. **Browser preview** on the hardened binding: `eng-contract` already made `server.ts` a thin host with a per-run token added by the Vite dev proxy; E7 swaps it onto the real loopback listener (item 2), reads the token from a 0600 file, and puts it through the request matrix below. The browser never holds the token. Preview keeps its own data directory (AGENTS.md).
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

**Estimate.** 8-10 agent-days in `eng-host`, days 4-12 (resident mode by day 7, doorway by day 12).

**Work packages.** WP7.1 (senior agent): socket and HTTP with the security matrix. WP7.2: clients, scopes, audit, revocation. WP7.3: OpenAPI, lint, golden test. WP7.4: MCP and CLI. WP7.5: bundle, ring buffers, protocol log. WP7.6: queue inspector and preview. WP7.7: Swift spike.
Adversarial: a "break in" agent, given only the listener source and ARCH 12.3, must make an unauthenticated, cross-origin or wrong-scope call; a "leak" agent tries to get a canary into a bundle through any field.

> **What this means:** Tools and a future phone app can use Aplos through a locked door that is off by default, needs a revocable key per tool, and logs anything risky. When something sticks, you can export a report containing none of your email.

### E8. Hardening, soak and clean-up (ARCH M10, engine half)

**Goal.** Prove the engine survives real life (sleep, battery, bad networks, quota storms, full disks, damaged files) and delete the legacy code.

**Deliverables.**
1. **Soak harness** (`scripts/soak.ts`): a rehearsal run on days 15 to 18, then the release soak in the background during Phase 3 (days 18 to 25) on the release candidate the owner uses daily: seven days with a stub provider and, in parallel, the owner's real accounts through plan 20's actors (the weekly Gmail reconnect falls inside the week and tests the reconnect flow); scheduled sleep and wake and battery cycles on the owner's Mac (an owner step); RSS, WAL size, event-loop p99 and units per minute sampled each minute to a CSV.
2. **Fault injection** (shared with plan 20): drops, 403 and 429 storms, a corrupt provider page, disk full (a size-limited disk image from `hdiutil`), a flipped byte in a copy of `mail.db`, history 404, clock moved backward.
3. **Damaged-database path** (Decision 6): `SQLITE_CORRUPT` or a failed `integrity_check` at open parks the engine, copies the damaged file aside, and offers Export report, Restore a pre-migration backup, or Rebuild from your provider, first listing what exists only on this Mac (drafts, scheduled sends, local workflow edits).
4. **Delete the legacy code** (days 14 to 17, the Integrator with each owning lane): `packages/engine/src/legacy/`, `packages/contract/src/legacy/`, `apps/desktop/src/renderer/legacy/`, the `apps/desktop/src/shared` re-export stubs and the old provider files in `src/main`. It starts once `ui-shell` reports the renderer on the real engine (the switch on days 11 to 13) and each provider lane reports its adapter replaced.
5. **A1 readiness verified, not built** (ARCH 2.6): the import lint test, lock, `KeyProvider`, engine-only migrations, a version handshake.
6. **Second-Mac update test** from 0.2.3 to the release candidate (needed anyway for plan 40's Developer ID check), including import on a second machine's data, an update interrupted during migration, and a rollback to 0.2.3.

**Ownership.** Plan 10, with plans 20 and 40 as required participants. **Dependencies.** Everything above; plan 40's release pipeline.

**Acceptance.**
- Seven-day soak: zero duplicate sends; zero ghost threads after a forced cursor expiry; RSS slope under 2 MB an hour after a 30-minute warm-up and under 50 MB net over 24 hours (ARCH's "flat memory"); WAL never above 256 MB; no event-loop p99 above 500 ms for more than a minute running. CSV and chart attached.
- Disk full: the engine parks with a clear message, `integrity_check` is `ok` once space returns, nothing lost. Corruption: parked, damaged copy kept, restore and rebuild each work from a clean start.
- Clean update from 0.2.3 on the second Mac; rollback to 0.2.3 opens the untouched `aplos.db`. The portability test passes with the legacy folders gone.

**Estimate.** 5-7 agent-days in Phases 2 and 3 (days 14-25), plus the soak in the background.

**Work packages.** WP8.1 harness. WP8.2 fault scenarios, one agent each. WP8.3 damaged-database path. WP8.4 legacy deletion after the two readiness reports. WP8.5 update test with the owner.
Adversarial: a "murphy" agent runs the fault scenarios in random combinations and order for 24 hours with a fixed seed and must find one violated invariant (duplicate, lost message, stuck status) or report that it could not.

> **What this means:** Before the release the engine is run hard for a week through sleep, bad networks, full disks and damaged files, and anything that breaks is fixed. The old code is then deleted.

## 5. Test strategy

**Principles.** Mocked Google never counts as live acceptance (AGENTS.md). Agents run headless only; checks needing a visible window are owner steps or a background Cua-driver run on one exact window that never takes the foreground. Automatic live checks use the agent test account only (the owner's spare Gmail; roadmap, "Decisions already made"); checks on the owner's own accounts are hand-run. A milestone is checked off only with evidence in PROGRESS.md.

| Layer | Proves | Where |
|---|---|---|
| Unit (node:test via tsx, as today) | Registry, ids, tokens, lanes, redactor, SSRF classifier, timer loop on a fake clock | `packages/*/tests`, `apps/desktop/tests` |
| Property (seeded, seed printed) | Change-log replay, rollups vs a slow reference, consent gating, client overlay vs engine truth | `packages/engine/tests/property` |
| Conformance | Fixture and real engine behave identically | `packages/contract/tests/conformance` |
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
| 4 | Threads collide on the same files (H / M) | the Phase 0 restructure first; exclusive paths enforced by `owners-check`; freeze C1 (section 9) |
| 5 | Contract freeze is wrong and UI work is wasted (M / M) | Fixture plus conformance expose gaps early; three reviewers attack the contract before C1; `v:1` with capability flags |
| 6 | Zod plus engine busts 400 KB, or zod JIT breaks under CSP (M / L) | Measure in E1; `zod/mini`, boundary validation or a recorded budget; `jitless`; oRPC only per ARCH 9.3 |
| 7 | `node:sqlite` follows Electron's SQLite; a bump changes version or options (M / M) | CI and packaged `--selftest` assert 3.43+, FTS5, `contentless_delete`; better-sqlite3 is a one-file switch |
| 8 | WAL growth from always-on readers (M / M) | Short reads, idle `wal_checkpoint(TRUNCATE)`, `journal_size_limit`, 256 MB flag, soak assertion |
| 9 | Out-of-process frames never fire `before-input-event` **[U]** (M / M) | Packaged-app hand-check before E4 closes; non-destructive frame-script relay as fallback |
| 10 | Sanitizer bypass (M / H) | CSP header as second wall, sandbox without `allow-same-origin`, no frame network, bypass agent, growing corpus, sanitize on read |
| 11 | Image-proxy SSRF (L / H) | Resolve once and connect to the address, full special-use table, revalidated redirects, table tests, RFC 6890 audit |
| 12 | Listener exposed by mistake (L / H) | Off by default, loopback and socket only, request matrix, plan 40 review; no `0.0.0.0` path until A2 |
| 13 | Adapters misreport `uncertain` vs `failed` (L / H) | Narrow `NotSentError`, everything else uncertain; kill-point matrix per provider; real sends in E6 |
| 14 | Live verification lags: owner time, Google Testing mode (H / M) | Emulators first; scheduled live runs on the agent test account that follow the weekly reconnect; short owner checklists written ahead; evidence recorded as gathered |
| 15 | PR #21 touches the file Phase 0 splits (M / L) | Not merged; engine side reimplemented as `Setup/*`; plan 30 absorbs its UI; dropped in the rebase if merged first |
| 16 | Old code lingers and confuses agents (M / M) | Legacy code sits in `legacy/` folders from day 1, read-only, and is deleted in Phase 2 (4.2) |
| 17 | The Phase 0 move breaks the packaged app: `@aplos/*` left unbundled, package dependencies missing from the asar (M / H) | Build wiring is a deliverable; `npm run package` and `verify-release.mjs` in Phase 0 acceptance (E1); adapter dependencies stay in `apps/desktop/package.json` |
| 18 | The Engine thread is over-subscribed across seven lanes, so E3 to E6 slip and block `prov-gmail-write` and `ui-reader` (H / M) | The priority and slip rule (4.0), critical lanes first (`eng-store`, `eng-views`), staggered starts for agent rate limits, E6 before E5 if needed |
| 19 | The contract fixture and the real engine drift, so the UI is built against behaviour that does not exist (M / M) | One conformance suite for both, a fixture-only assertion fails CI, `ui-shell` switches to the real engine on days 11 to 13 once the conformance suite is green |
| 20 | `eng-store`'s real commit slips past day 6 and delays `prov-gmail`, the Gmail daily-driver gate (M / H) | One lane, same-day escalation, the schema reviewed by Providers in Phase 0 (F4) |

Resident-mode confusion and rollback losing local-only edits are covered by Decisions 1 and 4.

> **What this means:** The biggest dangers are quiet bugs in the change feed and the import, and two threads editing the same files. Both are met by tests that try to break them and by doing the file moves first.

## 7. Interfaces and contracts with the other workstreams

### 7.1 Plan 20 (providers and sync)

Plan 10 defines these in `packages/engine/src/ports.ts` and `packages/contract`; plan 20 implements them. Changes are additive via contract PR.

| Port or artifact | Meaning |
|---|---|
| `store.commit(fn)`, page commits | The only write path; a page, its resume token and its `changes` commit together; replay of pending ops inside the commit is a store service (ARCH 4.3) |
| `sync_state`, `sync_failures`, `governor_state`, `provider_memory`, `accounts.status*`, `baseline_done_at` | Plan 10 owns tables, plan 20 owns semantics; plan 20 reviews the schema in Phase 0 (F4). `baseline_done_at` marks the end of the **first window** (the newest ~50 Inbox threads, ARCH 5.1 P1), never the end of backfill; backfill pages never create notifications |
| `ProviderAdapter` (plan 20 section 3.2: `connect`, `syncStep`, `fetchBody`, `apply`, `saveDraft`, `send`, `findSent`, `search`, `watch`, `calendar`) | The one port every adapter implements, in `ports.ts` and frozen with C1. `SendPort` and `DraftSyncPort` are its engine-side callers (`send`, `saveDraft`, `findSent`). Adapters never retry, never write the store and never pace; everything goes through `GovernorPort` |
| Contract methods backed by plan 20 | `Account/connect|reconnect|grantPermissions` (granted-scope handling, D5), `Account/lease`, `Unsubscribe/run`, `Event/set {scope: occurrence|series|following}`, `Event/rsvp`: names and schemas frozen at C1, behaviour from PV3, PV4, PV8 and PV9 |
| `AccountActorHost` | Start, stop, pause, wake, heartbeat, status; the supervisor restarts a silent actor alone |
| `GovernorPort.run(account, {budget, lane, cost, kind, signal}, fn)` and the classified-error record | Plan 20 implements, plan 10 specifies the type; E0's log shape is the same record |
| Status vocabulary (`starting`, `ok`, `syncing`, `backfilling (n of m)`, `paused`, `needsReauth`, `needsPermission`, `needsAdmin`, `misconfigured`, `offline`, `error`) and the `reconnectBy` account fact | Defined in contract (ARCH 6.4). `prov-gov` records the token grant time and sets `reconnectBy` (grant plus 7 days in Testing mode); plan 10 carries it in the account type and `Setup/status` (F1); `ui-shell` shows the note a day ahead |
| `laneFor` and the header field mask | Plan 10 provides the function, plan 20 supplies inputs at ingest |
| `ProviderPort.openThread(account, remoteThreadId, {knownCount?})` | Thread-granular open; plan 20's adapter picks `threads.get?format=full` (120 units) unless a single message is known (plan 20 section 2). This replaces ARCH 5.1's "two or more messages" test, which cannot be evaluated before a count exists; recorded in DECISIONS.md in Phase 0. Plan 10 does not depend on which call is made |
| Where adapters live | `apps/desktop/src/host/providers/<name>/` (not `packages/providers`, not `packages/engine/src/providers`); actors and governor in `packages/engine/src/sync/**`, the recurrence module in `packages/engine/src/calendar/**`; `packages/emulators` is plan 20's and test-only (section 3). Dependencies stay in `apps/desktop/package.json`. The portability rule needs no path exception, because no adapter lives in `packages/engine` |
| `SendPort.send`, `NotSentError`, `findSent`; `DraftSyncPort` | Plan 20 implements (E6) |
| Deadline-source registration | Plan 20 registers next-poll and cooldowns, giving one clock |
| Emulators with fault injection | Plan 20 owns; shared by E6 and E8 |

Timing: the logger (F7) lands in Phase 0, before plan 20's lanes start. Schema 0001 and a minimal `store.commit` (F4) freeze on day 3, and the real commit and change log arrive by day 6 for `prov-gmail`. `eng-time`'s `submissions` and drafts table land in its days 4 to 10, and `prov-gmail-write` starts on day 6 against the frozen ports. The kill-point harness is shared with `prov-emu` by day 9.

### 7.2 Plan 30 (UI)

| Artifact | Meaning |
|---|---|
| Stand-in engine and the freeze C1 (end of Phase 0, day 3) | The UI builds against it from day 4 (Decision 9, settled); shape, scenarios, control channel, transports and the table of plan 30's twelve asks are in 4.1 |
| Typed client `api.*` (F2) | Plan 30's new screens call it and build `renderer/data/` on it. There is no codemod over today's `invoke(` sites; the old renderer stays read-only in `renderer/legacy/` |
| Moving `engine/discover` and `engine/provider` imports out of the renderer | Not a precondition of the move: Phase 0 step 1 rewrites those imports to `@aplos/engine/discover` and the contract's legacy types; `ui-onboard` later moves them behind `Account/discover` |
| Switch to the real engine | Plan 30's WP5.6, run by `ui-shell` with the Integrator on days 11 to 13, once `eng-views` passes the conformance suite on the real engine (day 11). Its report that the renderer is on the real engine unblocks E8's deletion of the legacy folders. Removing `latestState` does not wait for it (E3 item 6) |
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
| Formatter and linter adoption | Inside Phase 0: this plan's rename-and-imports commit, then **plan 40's Q1a format commit**, then the `electron.ts` split, then Q1b (section 9, E1 item 0). There is no `format-merge.mjs` |
| CI jobs | SQLite check, OpenAPI diff, portability test, benchmark gates, secret scan: plan 10 supplies tests, plan 40 the runners |
| `assertCaller`, port handoff, permission handler, `webRequest` backstop | Reviewed by plan 40; one shared `webRequest` handler module **[U]** |
| Host-page CSP changes | Plan 40 edits `index.html` once E4's frame exists |
| Release verification | `verify-release.mjs` gains the packaged `Aplos Mail --selftest` check (a main-process flag, not `ELECTRON_RUN_AS_NODE`, which plan 40's fuses disable) and a check that `@aplos/*` code and zod are in the bundle. Plan 40's CI runs the same `selftest.ts` inside Electron's Node |
| Updater and open-source readiness | Update drain uses E1's drain hook; `packages/contract` is a public API (ARCH 14.5); no secrets in logs or fixtures |

> **What this means:** The seams between plans are written down as named interfaces with owners and dates, so each team can work without waiting and nothing falls between them.

## 8. What to read first

1. `plans/00-roadmap.md` (sections 1, 2.1, 4 and 7), `plans/ARCHITECTURE.md` (sections 3, 7-12, 15) and `plans/DESIGN.md` (sections 5, 7.11-7.12, 15, Appendix C).
2. `AGENTS.md`, `DECISIONS.md` (2026-10-15, 10-16 M26 and M29, 10-21, 10-23), `PROGRESS.md`, `TODO.md`, `MOBILE.md` on main.
3. By milestone, the research named in that milestone's deliverables (the five `RC/gaps/` reports, `RC/protocols/proto-google.md` §1, `research/pr21-onboarding-review.md`, `RC/arch/extra-bulwark-legacy-proxy.md`) and the main-branch files it replaces (`service.ts`, `electron.ts`, `preload.ts`, `server.ts`, `engine/store.ts`).
4. `plans/_council/CONTEXT.md` for the facts that override the research.

Provenance rule for every brief: the corpus contains GPL, AGPL, commercial and unlicensed code; read it for ideas, never copy code, assets, branding or wording (ARCH 14.1).

> **What this means:** Start with the two decision documents, then only the research for the step you are on. Reference projects are for ideas, never for code.

## 9. PR and branch strategy within the revamp

**Nothing goes to main without the owner.** The long-lived branch is `revamp`, cut from main at `72095ff` (v0.2.3); its first commits are the research and planning documents. Main does not change until the owner merges `revamp` for the redesigned release. PR #21 is not merged by this workstream.

- **Branches.** Git cannot hold refs under `revamp` next to a branch named `revamp`, so lane branches are `rv/<lane>/<slug>`, for example `rv/eng-store/commit` or `rv/eng-views/windows` (roadmap 7), each in its own git worktree. The Engine thread coordinates on `rv/thread/engine`. A branch name is never a folder of another (no `rv/eng-store` beside `rv/eng-store/commit`). Lane PRs target `revamp`.
- **Merge style.** Phase 0's mechanical commits merge by merge commit, so `git log --follow` survives, and go into `.git-blame-ignore-revs`. Everything else squashes, with a message naming the lane and work package. Long-lived branches take `revamp` by merge, never rebase, and nobody force-pushes a shared branch. Only the Integrator merges into `revamp`, after typecheck, tests, `npm run check`, the owners check and the conformance run pass.
- **The Phase 0 restructure chain.** On day 1 the Engine thread runs the steps in E1 item 0 serially, each its own commit: the NOTICE, the rename-and-imports commit, plan 40's Q1a format commit, the `electron.ts` split and plan 40's Q1b. Main is not merged in, because it does not change. The other threads work in their own worktrees on new files only, and no other PR touches `src/engine`, `src/main`, `src/shared` or renderer call sites while the chain runs (about a day).
- **Contract changes** go only through `eng-contract`, labelled `contract-change`, additive within `v:1`.
- **Evidence on every PR:** test output, benchmark numbers, corpus and leak-test results, and screenshots where a UI is involved (attached with `gh pr create --attach`, never committed).
- **Records.** Each milestone PR appends to `PROGRESS.md` (what and evidence) and `DECISIONS.md` (calibrated numbers, the freeze, the zod bundle result, the Swift spike result) and ticks `TODO.md` only with evidence (AGENTS.md).
- **Review.** Every PR is reviewed by an agent that did not write it, briefed with the acceptance criteria; E4 and E7 also get plan 40's reviewer.
- **Builds and release.** One redesigned release, proposed 0.3.0, covers E1 to E8 and plans 20 to 40. Before it, builds are local packaged builds or `v0.3.0-beta.N` draft releases in this private repo, published on the owner's go-ahead (`scripts/release.mjs --allow-branch`) and installed by hand. The stable release is tagged from main after the owner merges `revamp`. `aplos.db` stays until the release is stable (Decision 4).
- **Commits** are authored as Kainoa Newton <k@kainoa.me>; flag any other `git config user.email` before committing.

> **What this means:** Everything lands on `revamp` in small reviewed pieces with proof attached. The risky file moves happen first, in one short chain on day 1. Main changes only when you decide.

## Evidence index

`plans/ARCHITECTURE.md`, `plans/DESIGN.md`, `plans/_council/CONTEXT.md`, `plans/proposals/arch-evolve.md`; `RC/SYNTH-architecture.md`; the five `RC/gaps/` reports named above; `RC/protocols/proto-google.md`; `RC/arch/extra-bulwark-legacy-proxy.md`; `research/pr21-onboarding-review.md`; `research/inbox-zero/SYNTHESIS.md`; Aplos main at `72095ff` (`apps/desktop/src/engine`, `src/main`, `src/shared`, `tests/portability.test.ts`, `MOBILE.md`, `DECISIONS.md`, `AGENTS.md`).
