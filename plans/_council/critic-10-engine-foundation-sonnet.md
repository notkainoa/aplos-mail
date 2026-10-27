# Critique of plan 10 (engine foundation, E0-E8), by sonnet

Checked against ARCHITECTURE.md, DESIGN.md, plans 20/30/40, the research, and main at 72095ff (read-only).

## Blockers

1. **blocker. The legacy write path has no owner.** E2 builds `assembleLegacyState` (reads only). But `service.ts` still mutates in-memory `AppState` and saves through `store.save(diff)` to `aplos.db`. IMAP, JMAP, Graph and CalDAV keep the legacy sync until plan 20's M7/M8 (weeks 7-9). 0.3.0 (ARCH M3, week 5) ships before that. Plan 20 line 452 assumes a "compatibility assembler" covers the Gmail rewrite. Nothing says how a legacy sync or a draft save reaches `mail.db`, how `{epoch, rev}` events are produced for the 0.2.x renderer, or what a threadLimit-capped legacy state does to `merge.ts` (a partial state could duplicate or drop threads). Fix: add a named "legacy bridge" (StoreDiff to `store.commit`, bodies, epoch/rev mapping, capped-state rules) with its own acceptance test, and re-estimate E2 (the 8-10 days are not credible with it).

2. **blocker. E0 cannot execute as written.** E0 creates `packages/engine/src/diag/log.ts` and `host/logsink.ts`, but E0 is cut from main (section 9), where neither `packages/engine` nor `host/` exists (E1 creates them). Fix: E0 lands in `apps/desktop/src/engine/diag/` and `src/main/logsink.ts`; E1's pure-rename commit moves them.

3. **blocker. The E1 move is under-specified and would break the build.** Checked on main:
   - The engine imports six `src/shared` files (`types`, `ask`, `mailbox`, `summary`, `version`, `live`).
   - `shared/version.ts` re-exports `apps/desktop/package.json`.
   - `shared/types.ts` imports `engine/provider`.
   - About 40 files outside the engine (`src/main`, tests, scripts, two renderer components) import `engine/*`.
   - `tests/portability.test.ts` reads the engine directory non-recursively and imports `src/main/store`, `groq` and `memory-stage`. Subfolders would be silently skipped.
   - `scripts/build-main.mjs` uses `packages:'external'`, so `@aplos/*` would be left unbundled and missing in the packaged app. Workspace-package dependencies would not reach electron-builder.
   The plan only says "legacy shared types move". Fix: list the shared-file move with re-export stubs, an import codemod, an engine-takes-version rule, a recursive portability test, and explicit build wiring (esbuild, tsx, vite, electron-builder).

## Majors

4. **major. Q1 ordering conflicts with plan 40.** Plan 40 puts the formatter first (before the engine move). Plan 10 section 9 orders move, then formatter, then codemod. Plan 30 waits for both. Fix: one sequence (merge main, Q1, move, contract package, codemod) with a stated fallback.

5. **major. The contract fixture is under-specified.** Its shape, scenarios, control channel (plan 30 section 8.1 needs a forced-status channel and `APLOS_NOW`), and transports are missing. The browser preview server needs a fixture mode in week 2, but E7's HTTP binding arrives in week 9. The handoff to plan 30 is scattered over three sections. Plan 30's nine asks (section 8.1) are not mapped to contract types. Fix: add a dedicated fixture section: shape, a C0 preview and C1 freeze, scenarios, transports, ask-to-type table.

6. **major. Schedule and E-to-M mapping.**
   - E3, E4 and E5 (24-30 days) all sit on the P thread in weeks 4-6 (15 working days).
   - E2 is S-thread, yet S must start plan 20's M3 in week 3.
   - E6 depends on E5, yet plan 20's PV4 needs drafts in weeks 5-7 and plan 30's U6 needs E4/E6 at week 7.
   - E3 and E4 both map to M4.
   - Plan 10 section 9 says 0.3.0 follows E3, but ARCH says 0.3.0 follows M3 (week 5).
   Fix: mapping table with owners, weeks and releases; split E2 into E2a (schema, hard date week 3) and E2b; move importer and bridge to P in week 3; make E6's dependency on E5 soft; state priorities and a slip rule.

7. **major. `service.ts` is one closure.** The WP1.2 plan has six agents split six seams in parallel. The seams share closure state (`state`, `listeners`, `timers`, `emit`, `account()`), so the agents will conflict. Fix: a serial first step that introduces a context object, then fan out.

8. **major. Adapter package locations are unsettled.** Plan 20 proposes `packages/providers` and `packages/emulators`; ARCH ADR-19 names three packages. Adapter dependencies (`imapflow`, `mailparser`, `nodemailer`) are declared in `apps/desktop/package.json` and the packager reads only that. Fix: settle adapters in `apps/desktop/src/host/providers/`, actors and governor in `packages/engine/src/sync`, and `packages/emulators` as test-support only, recorded as an ADR-19 amendment.

9. **major. Contract mismatches with plan 30.**
   - Plan 10 names the frame call `Html/render` returning a token; plan 30 expects `Mail/frame` returning `{url, expiresAt, ...}` plus a release call.
   - The `renderer` typed-client codemod is claimed by both plan 10 E1 and plan 30 U2.
   - Plan 30 says `setup.end`; the contract says `Setup/end`.
   - The `ui` settings object, per-sender image allow-list and `toggleQuotes` are not in the contract list.
   - E3 deletes `latestState` in weeks 4-6; plan 30 says U9 (week 11), and plan 30 flips to the real windows only then, so the real engine meets a real UI at week 11.
   Fix: adopt plan 30's names, assign the codemod to plan 10 with plan 30 building on it, and make the `latestState` removal stateless-relay based so it can land early. Record the plan 30 ask to flip earlier.

10. **major. Importer gaps.** Legacy messages created locally or by the demo account have `randomUUID` ids and no `remoteId`. Legacy `Attachment.data` is inline base64, which the plan never moves to files. The date-ordered id carry can collide with the next second's range. Pre-1970 dates are not clamped.

11. **major. Partial rows and the open-thread rule.** Thread rows built from one metadata message have `complete=0`; the contract row has no `partial` flag, so the UI would show "1 message" for a 12-message thread. ARCH 5.1 ("`threads.get` when two or more messages") cannot be applied before the count is known; plan 20 flags this. The engine port should be thread-granular so either rule works.

12. **major. `--selftest` versus fuses.** Plan 40 turns the RunAsNode fuse off, and plan 40's CI check uses `ELECTRON_RUN_AS_NODE`. A packaged `--selftest` must go through main and `utilityProcess`, not RunAsNode.

## Minors

13. **minor.** Counts are wrong: the engine has 16 files, not 17; there are 53 `invoke(` sites in 15 files, not "about 60".
14. **minor.** Section 4.0 has no closing "What this means". Section 4 as a whole does not either.
15. **minor.** Plan 20 uses E1-E8 for live experiments. The names clash with plan 10's milestones; say that other plans cite plan 10 by ARCH M-number.
16. **minor.** The browser preview server (`server.ts`) checks `Host` and `Origin` (`isTrustedRequest`) but has no token, so any local process, or any request without an `Origin`, can call `draft.send` while `npm run dev` runs. Dev-only; E1 should close it with a dev token.
17. **minor.** "Decisions for you" lacks the question the owner will actually face: what slips if the engine schedule runs long.
18. **minor.** Plan 40 expects a "seeded store generator" at M1; the plan builds it in E2 (`store-bench`). Say so.

## Owner readability

Good overall: "In plain English" is about 300 words, every E-section ends with "What this means", and the decisions have defaults. Gaps are items 14 and 17.

## Revision log

All edits are in `plans/10-engine-foundation.md`. Nothing was committed. Item numbers refer to the critique above.

- **1 (blocker, legacy writes).** New section 4.2, "The legacy bridge": read assembler plus `legacyStoreAdapter.save(diff)`, capped-working-set rules, epoch/rev mapping, lifetime, and a four-part acceptance list. E2 now splits into **E2a** (S thread, schema, `store.commit`, change log, hard date end of week 3) and **E2b** (P thread, bodies, FTS, retention, importer, bridge, benchmark). E2 estimate raised from 8-10 to 14-17 days. In-scope list, E2 deliverable 8, acceptance, adversarial list, risk 16, 7.1 and E8 shim removal all updated.
- **2 (blocker, E0 paths).** E0 now lands in `src/engine/diag/` and `src/main/logsink.ts` on main; E1's rename moves them. Section 9 matches.
- **3 (blocker, the move).** Section 2 records the real coupling. E1 item 1 now covers: the `shared/*` relocation to `packages/contract/src/legacy/` with re-export stubs, the provider-type move to avoid a cycle, the engine receiving `appVersion` through init, an import codemod script, a recursive portability test with a negative test, and build wiring (esbuild, tsx, Vite, electron-builder) proven by `npm run package` and `verify-release.mjs`. The commit is "rename plus import-specifier edits only". Risk 17 added.
- **4 (Q1 ordering).** E1 item 0 and section 9 now fix one order: merge main, plan 40's Q1, rename, contract skeleton, codemod, with a stated fallback and `.git-blame-ignore-revs`. 7.3 records it.
- **5 (fixture).** New section 4.1: shape, verbs, frames, scenarios, `Fixture/control` channel, three transports (including a dev-only token-protected preview host built in E1), conformance, C0 preview (day 5) and C1 freeze (day 10), the review gate, a table mapping plan 30's nine asks to contract homes, and the handoff. The `partial` flag on Thread rows is added.
- **6 (schedule and mapping).** Section 4.0 now has a table mapping E to ARCH M with thread, nominal and plan weeks, agent-days and releases; the reconciled release plan (0.3.0 = ARCH M3, withdrawing the earlier "after E3"); an honest load check (69-88 agent-days, P over-subscribed, slip up to 1.5 weeks, absorbed in ARCH's 9-14 range); and a priority and slip rule. E4 is declared the slack milestone; E6 no longer depends on E5; E3 may start on the E2a schema. Decisions 10 and 11 added; Decision 9 updated for C0 and C1.
- **7 (service.ts closure).** E1 item 2 and WP1.2a/b: a serial `RuntimeCtx` step first, then fan-out per seam.
- **8 (adapter locations).** Section 3 "Package locations (settled)": adapters in `apps/desktop/src/host/providers/`, actors and governor in `packages/engine/src/sync/`, `packages/emulators` as test-support, `packages/providers` rejected for now, recorded as an ADR-19 amendment. Ownership table updated.
- **9 (plan 30 mismatches).** Frame call renamed to `Mail/frame` with plan 30's shape (E4, 4.1, 7.2); codemod ownership assigned to plan 10 (4.1, 7.2); wire names for `Setup/*`, `Settings.ui`, `Account/lease` listed; `latestState` removal made stateless-relay based so it can land in E3 (E3 item 6, a legacy-renderer smoke test); a request that plan 30 flip to the real windows when E3 is green.
- **10 (importer).** Table rows for messages without provider ids and for inline-base64 attachments; id allocator carry rule, clamp and property test.
- **11 (partial rows, open-thread rule).** `ProviderPort.openThread` is thread-granular; plan 20's `threads.get` on open adopted in place of ARCH 5.1's untestable wording (recorded in DECISIONS.md at E2a); `partial:true` on Thread rows.
- **12 (selftest).** One `selftest.ts` with two launchers: CI inside Electron's Node, packaged as `Aplos Mail --selftest` through main and the utility process, not `ELECTRON_RUN_AS_NODE`.
- **13-18 (minors).** Counts fixed (16 files, 53 sites in 15 files); "What this means" added to 4.0, 4.1, 4.2; naming note about plan 20's E1-E8 experiments; preview-server token added in E1 (and the critique's own claim about `Origin` reflection corrected to "allowlisted but tokenless"); Decision 10 on what slips; seeded-store-generator timing stated in E2's dependencies.

### Remaining conflicts that need edits in other plans

- **Plan 30:** U2 deliverables and section 4.1 strangler step 1 say plan 30 migrates the 53 `invoke(` sites and removes the `engine/discover` and `engine/provider` imports before the move; plan 10 now does the codemod and import fix-ups in E1.
- **Plan 30:** use `Mail/frame` shape `{url, expiresAt, bodyKind, trackersRemoved, hasRemoteImages, quotedCount}` and wire name `Setup/end`; U9's "plan 10 removes `latestState` at the same time" is relaxed (E3 removes it earlier); flip dev builds to `engineWindows` when E3's conformance run is green (about week 6).
- **Plan 20:** section 3.1 should replace `packages/providers` with `apps/desktop/src/host/providers/` (adapters), keep `packages/emulators`, and state that adapter dependencies stay in `apps/desktop/package.json`.
- **Plan 20:** PV3's "behind plan 10's compatibility assembler" should say the bridge is read plus write, and IMAP, JMAP, Graph and CalDAV legacy sync keep running through it until M7 and M8. Plan 20's "plan 10 M10" and "M2 store" dependencies hold, but the schema deadline is E2a, end of week 3.
- **ARCHITECTURE.md:** section 5.1's "`threads.get` when two or more messages" should adopt plan 20's rule; ADR-19 should list the amendment (`contract-fixture`, `emulators`, adapters in the app).
- **Plan 40:** none blocking. Its Q1-first order is adopted; its CI SQLite job and the packaged `--selftest` share `selftest.ts`; its "seeded store generator at M1" is met by the fixture's generator (E1) and `bench/store-bench.ts` (E2b).
