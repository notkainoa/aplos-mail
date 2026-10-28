# Engine thread handoff (written 2026-10-28 for the 2026-10-29 restart)

> **What this means:** the old Engine thread was paused by the owner on 2026-10-28 (Claude usage limit, then lean mode). Phase 1 got through the runtime seam, the first store proofs, and early work in every other lane. Nothing is merged yet except Phase 0. Fresh Sonnet thread: read this, `plans/lanes/<lane>.md`, roadmap 5.1a. Do not read the old thread. All branch SHAs are on origin.

Old thread: `mcp:aa00aa53-b513-42d2-96d1-ecb158cd11f0` (read-only). Rules: no leads of leads, at most 4 subagents, one Sonnet review per PR, Opus only for the store commit path and contract changes. Lane PRs carry Phase 0 history that #28 squashed, so ask the Integrator to squash-merge them.

## Lane state (tips on origin; none has green `npm run check` evidence unless noted)

| Lane | Branch @ SHA | State |
|---|---|---|
| eng-contract | `rv/eng-contract/runtime-seam` @ 3e77eed | PR #46 open, CLEAN (contract-1: runtime seam, scoped dispatch). Every lane plugs into it. |
| eng-contract | `rv/eng-contract/voice-notify` @ 315f12c | WIP, no PR: Voice may be unset; `System/notifications {request:true}` (UI-screens' two contract additions). Contract change: Opus review. |
| eng-store | `rv/eng-store/commit-extensions` @ 42c1b0c | store-2 work: ingest hooks (`laneFor`), correspondents, `KnownLookup`, schema 0002. No PR. |
| eng-store | `rv/eng-store/commit-proof` @ d6ce06f | store-1 work: `compact.ts`, replay and rollup property tests (935 lines). No PR. Does NOT contain commit-extensions; the two must be combined. |
| eng-views | `rv/eng-views/compiler` @ 91cfaf9 | views-1 WIP (compiler, specs, lists, sections, search). |
| eng-time | `rv/eng-time/clock-loop` @ 84de2d4 | time-1 done; an Opus review confirmed 10 defects not yet fixed. |
| eng-time | `rv/eng-time/reminders-later` @ 4d1da61 | time-4, 10 of 10 tests pass. |
| eng-time | `rv/eng-time/submissions` @ b756418 | time-2 send state machine, WIP, unverified. |
| eng-ai | `rv/eng-ai/heuristic-lanes` @ 37df8f5 | PR #47 open, CLEAN (ai-1 `laneFor`). ai-2 (Demo) not started; local branch `rv/eng-ai/demo-data` is the same SHA. |
| eng-html | `rv/eng-html/{parser-spike 8ee97ab, corpus c42e51a, image-proxy 7f2600e, sanitizer d748899}` | html-1, html-2 (128 messages), html-6 done in branches; html-3 sanitizer WIP. No PRs. |
| eng-host | `rv/eng-host/quit-race` @ 40735c4 | PR #43 open, CLEAN (quit during startup no longer hangs). |
| eng-host | `{onboarding-hooks 0b2fd28, resident-mode 2a26bef, selftest 1cef858, doorway-transports bca4026}` | host-1 to host-4 WIP; host-1 smoke spec never ran green; doorway is a committed WIP. |

## Preserved uncommitted work (pushed as WIP, never reviewed, fails or skips hooks where noted)

- `rv/eng-views/wip-pause-1028` @ dae3de4 (on top of compiler; split `populate` in `tests/views/big.ts`, complexity 36 > 25; prettier fails; committed with `--no-verify`).
- `rv/eng-html/wip-pause-1028` @ 36851fa (bounds a quadratic slowdown in `quotes.ts` quote detection; `no-control-regex` lint error; `tmpbench.ts` deleted; `--no-verify`).
- `rv/eng-contract/wip-pause-1028-r3-a` @ e22a402, `...-f34-review-fixes-2` @ ef5f8ce, `...-f6-fixture` @ 2d3b215 (old Phase 0 worktrees: one test edit each, plus a fixture README and two tests; likely stale, check against `revamp` before using).
- Nothing secret or large was found.

## Open PRs touching this thread

#43 eng-host quit fix, #46 eng-contract runtime seam, #47 eng-ai Home lanes. Also open, not ours: #45 (test:engine under Electron Node), #44 (UI-core F9, last freeze item), #40, #38.

## Next 5 actions

1. `eng-store` first (critical path, day-6 target slipped by the pause): merge commit-proof into commit-extensions, run `npx tsx --test 'packages/engine/tests/store/**/*.test.ts'` and `npm run check`, open one PR for the real `store.commit` plus change log, compaction and hooks. Opus reviews the commit path only. Post HANDOFF-READY.
2. `eng-views` second: rebase compiler plus its WIP onto the store branch (or revamp), finish views-1 (lint: split `populate`, prettier), EXPLAIN QUERY PLAN test, then PR.
3. Ask the Integrator (STATUS REQUEST) to merge #46 then #47 then #43, squash. Rebase lane branches on `revamp` after each.
4. Post a STATUS NOTICE that the engine thread restarted fresh with two building lanes (store, views); eng-ai, eng-time, eng-html, eng-host are parked.
5. Parked, resume in this order after their PR merges and a slot frees: eng-ai (ai-2 Demo, needed for conformance), eng-time (fix the 10 clock-loop defects, then time-2), eng-host (finish host-1 to host-3, then PR), eng-html (finish the sanitizer, Opus review, security area).

Test everything with `npx tsx --test <paths>` per the lane card. Seams 1 to 4 are in `plans/engine/phase1-lanes.md` lines 76 to 100.
