# Lane card: eng-views (engine thread, second job)

**Goal.** Compile view specs to keyset SQL, run the live-window engine (ID-only frames, coalescing, holds), apply commands with receipts and inverse-op undo, and serve sender rules. Conformance green on the real engine is the day-11 gate for the UI switch from the stand-in.

**Owned paths** (`plans/OWNERS.md` row `eng-views`): `packages/engine/src/views/**`, `packages/engine/src/methods/{view,thread,operation,sender}.ts`, plus its tests under `packages/engine/tests/views/**`. Removal-only edits to `packages/contract/tests/conformance/expected-fail.engine.json` are allowed (seam 3).

**Read only these:**
- `plans/engine/HANDOFF.md`
- `plans/engine/phase1-lanes.md` lines 58-100 (rules, seams 1 to 3) and 255-312 (the lane: views-1 to views-5)
- `plans/10-engine-foundation.md` lines 349-380 (E3 live windows)
- `plans/ARCHITECTURE.md` section 9.2 (starts at line 529)

**Start here.** `rv/eng-views/compiler` @ 91cfaf9 plus `rv/eng-views/wip-pause-1028` @ dae3de4 (views-1: specs, compile, sections, lists, search). The WIP commit was made with `--no-verify`: `populate` in `tests/views/big.ts` has complexity 36 (max 25) and `reference.ts` fails prettier. Fix those first, do not build on it blind. Needs `eng-contract`'s runtime seam (PR #46) and eng-store's extension API before views-2/views-3.

**Done (views-1).** Every `ViewSpec` kind in `schemas/mail.ts` compiles to keyset SQL (never `OFFSET`) over `thread_folders`, `thread_workflow` and the `home` index; a spec registry lets other lanes register kinds; `EXPLAIN QUERY PLAN` shows an index and no scan of `threads` or `messages` at 100k threads; pathological specs (empty label, FTS operators, account filter, Later group at a DST boundary) match a slow reference query. Later: views-2 windows (at most 4 re-runs a second per window), views-3 commands and undo, views-4 sender rules, views-5 burn-down.

**Models.** Opus for views-1 to views-3 core logic is allowed by the plan, but lean mode says Sonnet by default; use Opus only for the window and undo correctness review. Sonnet for views-4. Free models for test runs.

**Tests.**
- `npx tsx --test 'packages/engine/tests/views/**/*.test.ts'`
- `npx tsx --test packages/contract/tests/conformance/engine.test.ts` (views-5)
- `npm run check` before every commit
