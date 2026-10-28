# Lane card: eng-store (engine thread, critical path)

**Goal.** Finish the real `store.commit` (extension points, `laneFor` hook, correspondents, compaction, property proof) so Providers, views, time and AI can write real mail into it. Then bodies and attachments, paced full-text search, retention, the importer and the benchmark. Gmail and Google Calendar only this round.

**Owned paths** (`plans/OWNERS.md` row `eng-store`): `packages/engine/src/store/**` (including `migrations/**`, `import/**`), `packages/engine/src/methods/data.ts`, `packages/engine/tests/store/**`, `packages/engine/bench/**`, `apps/desktop/src/host/{sqlite,codec,files}.ts`, `apps/desktop/scripts/{mailbox-benchmark.ts,verify-large-mailbox.mjs}`. Touch nothing else.

**Read only these** (never whole plans):
- `plans/engine/HANDOFF.md` (state and SHAs)
- `plans/engine/phase1-lanes.md` lines 58-100 (rules, seams 2 and 4) and 179-254 (the lane: store-1 to store-7)
- `plans/10-engine-foundation.md` lines 290-348 (E2 and the import)
- `plans/ARCHITECTURE.md` lines 130-302 (section 3; 3.3 bodies at 273, 3.5 change log at 283, 3.6 retention at 287, 3.7 SQLite discipline at 291)

**Start here.** Two unmerged branches hold the first jobs: `rv/eng-store/commit-extensions` @ 42c1b0c (store-2: hooks, correspondents, `KnownLookup`, schema 0002) and `rv/eng-store/commit-proof` @ d6ce06f (store-1: compaction, replay and rollup property tests). Neither contains the other. Combine them, then open one PR.

**Done (first PR).** `store.commit` is the only write path; extensions and ingest hooks run inside the transaction; an extension that throws leaves no row, no `changes` row and no `seq` bump; `laneFor` never overrides `rank_source` `rule` or `user`; `compactChanges` raises `change_floor_seq`; the replay property test (1,000 seeded sequences) and the rollup property test against a slow reference pass. Types for `BodyWrite`, `AttachmentWrite`, `BodyCodec`, `AttachmentFiles` are published so Providers and store-3 can code against them. Then post HANDOFF-READY. Later packages: store-3 bodies, store-4 FTS, store-5 retention, store-6a/6b importer, store-7 bench (see the plan).

**Models.** Opus for the commit path and its correctness review (store-1, store-2, store-6a). Sonnet for the rest, free models for test runs and summaries. One Sonnet review of every non-Opus diff.

**Tests.**
- `npx tsx --test 'packages/engine/tests/store/**/*.test.ts'`
- `npm run test:engine` (under Electron's Node, once #45 has merged) and `npm run check:sqlite`
- `npm run check` before every commit
