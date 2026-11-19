# Lane card: prov-gmail (Providers thread, Linux)

**Goal.** Gmail connector on the real store: Inbox in seconds, quiet backfill, local edits that never flip back, a workflow channel (plan 20 PV3 with the old PV0 pacing folded in). Critical path for feature 1.

**State (pushed to origin).** `rv/prov-gmail/adapter` at `b1d4141`, stacked on `rv/prov-gov/engine-sync` (`7f55ebb` merge base): classifier, paced client, P0-P5 first-sync window, history, AM-1 open, search on Enter, ops; tests in `apps/desktop/tests/prov-gmail/` (109 pass, 2 todo). Runs on the governor and a stand-in store. Not usable: `rv/prov-gmail/core`, `rv/prov-gov/actor`, `wip-pause-1028` branches. Handoff: `plans/providers/HANDOFF.md`.

**Owned paths** (`plans/OWNERS.md` row `prov-gmail`): `apps/desktop/src/host/providers/google/{client,sync,history,bodies,search,workflow,classify}.ts` and any other file in `google/` not owned by `prov-gmail-write` or `prov-cal`; `packages/engine/src/methods/workflow.ts`; `apps/desktop/src/main/google.ts` until it moves. Tests under `apps/desktop/tests/prov-gmail/`. Not yours: send/drafts/filters/unsubscribe, calendar, `sync/**` (prov-gov).

**Read, and only this** (`plans/20-providers-sync.md`):
- 97-188: ground truth, adapter port, error mapping.
- 215-255: Gmail pacing and error handling.
- 308-333: PV3 deliverables and the acceptance list.
- 464-513: test rules, live-runner contract, live experiments register.
- 538-562: interfaces with other workstreams.
Also `plans/providers/port-gaps-day2.md` and roadmap 5.1a (lines 333-380).

**Jobs, in order.**
1. After prov-gov's PR exists: in a worktree of `origin/rv/prov-gmail/adapter`, `git merge origin/rv/prov-gov/engine-sync`, `git merge origin/revamp`, run the checks, open a dependency PR (base `revamp`, or prov-gov's branch until it merges).
2. Move onto the real store (`packages/engine/src/store/`, `store.commit` with replay and fence). Confirm in STATUS that the Engine thread has landed the commit path; if not, stay on the stand-in.
3. Finish PV3: `workflow.ts` (D17, D18; the lease rides on it), P4 prefetch through `openThread(..., 'prefetch')`, Logger catalog wiring, G10 once eng-contract answers.

**Done when** (emulator gate; live evidence comes later from the Mac via the Integrator). First 50 threads in under 15 s and 500 in about 3 min with zero refusals; engine killed mid-backfill resumes from the stored page; a 2,000-thread archive costs under 100 sync units; deleting one reply in Gmail web keeps the thread in Inbox; a phone draft never lands inside the thread; two simulated devices share one lease; the units-per-minute series is saved as evidence. Defect tests start with their defect id. Mocked Google never counts as live acceptance.

**Test commands.**
- `npx tsx --test 'apps/desktop/tests/prov-gmail/*.test.ts'` (e2e files take about 45 s each)
- `npx tsx --test packages/emulators/tests/*.test.ts` (emulator side)
- `npm run typecheck`; `npx eslint apps/desktop/src/host/providers/google`
- `npm run check` after merging `origin/revamp`.

**Models.** Sonnet for work and review; Opus only for sync correctness and auth/token code; lint of sync code on Claude. Live runs: post `REQUEST | prov-emu | to integrator: live-run` in STATUS (Mac only).
