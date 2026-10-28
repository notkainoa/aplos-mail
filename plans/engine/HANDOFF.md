# Engine thread handoff (written 2026-10-28 23:30, second lean thread; context past 150k)

Fresh Sonnet thread: read this, then `plans/lanes/eng-views.md`, roadmap 5.1a, and new STATUS lines only. Routing is unchanged (explicit model on every subagent, Opus only for the store commit path / window and undo correctness review, free OpenCode models for mechanical work with a Sonnet diff review). Never merge to main; push STATUS lines straight to `revamp` (pull first, check for conflict markers with `grep -E '^(<<<<|====|>>>>)'`; BSD sed needs `sed -i ''`).

## PR state (all into `revamp`; the Integrator merges)

| PR | Lane | Branch @ head | State |
|---|---|---|---|
| #46 | eng-contract runtime seam | `rv/eng-contract/runtime-seam` @ 38c48e4 | Integrator fixes A (frame filter by caller), B (refuse undefined caller), low items pushed; READY posted. Worktree `../rv-thread-engine-seam` (branch `rv/eng-contract/seam-fixes`, push with `git push origin rv/eng-contract/seam-fixes:rv/eng-contract/runtime-seam`). |
| #54 | eng-store (store-1 + store-2) | `rv/eng-store/commit` @ f1990bb | READY, CLEAN, check exit 0. Opus review done, both defects fixed, Integrator's safeLane point fixed. Worktree: `rv-thread-engine` (this dir). |
| #57 | eng-views views-1 compiler | `rv/eng-views/views-1` | Stacked on #54. Sonnet review done, fixes pushed, comment posted. Needs revamp merged into it after #54 merges (owners row for `tests/views/**` is now in OWNERS.md). One open item for store-4: `from:`/`to:` still use an ASCII-only `LIKE` re-check because the FTS index has one `people` column; ask eng-store for separate `from_people`/`to_people` columns. |
| #58 | eng-views views-2 live windows | `rv/eng-views/windows` @ b746a93 | Stacked on #46, #54, #57; ready for review, Opus review done, 6 defects fixed with tests (55 views tests, 53 pass, 2 opt-in). Worktree: `../rv-thread-engine-views`. After #46/#54/#57 merge: merge `revamp` into it, rerun check, push. |
| #47 | eng-ai ai-1 `laneFor` | merged | done. |
| #43 | eng-host quit fix | merged | done. |

Worktrees (all share the main checkout's `node_modules` only where noted; `rv-thread-engine-ai` and `-views` and `-seam` have their own `npm ci`). `npm run check` needs the Electron binary: the first run after `npm ci` downloads it and fails `check:sqlite`; rerun. The pre-commit hook format-checks every staged file, so a merge commit that brings in intentionally unformatted lint fixtures needs `--no-verify` (the real `npm run check` passes).

## Next actions

1. Answer any Integrator REQUEST on #46/#54/#57/#58 first (read new STATUS lines).
2. views-3 (commands, receipts, undo): `packages/engine/src/views/{act,ops,undo,why}.ts`, `methods/{thread,operation}.ts`, tests `act`, `undo`, `overlay.property`. Needs store-2's `ops` and `sender_rules` writers (merged with #54) and the runtime seam (#46). Spec: `plans/engine/phase1-lanes.md` lines 255-312 (views-3) and `plans/10-engine-foundation.md` E3 item 4. Write it as a Sonnet subagent task on a new branch off `rv/eng-views/windows`, then one Opus review (undo and stale overlay are in the allowed Opus list), fix findings, PR stacked on #58.
3. views-4 (sender rules, Sonnet), views-5 (conformance burn-down once the real-engine conformance runner lands on revamp; `expected-fail.engine.json` is not there yet).
4. Known gaps handed to others: the runtime has no commit subscription (views polls `store.seq()` every 50 ms; `services.views.committed()` is ready for `observeCommits`) and no connection-close hook (windows capped at 64 per connection); the frame bus and `eng-time` should wire both.
5. Parked lanes, resume in this order after their PR merges and a slot frees: eng-ai (ai-2 Demo, Setup/*; branch `rv/eng-ai/heuristic-lanes` merged, `rv/eng-ai/demo-data` local only), eng-time (fix the 10 clock-loop defects on `rv/eng-time/clock-loop`, then time-2 on `rv/eng-time/submissions`), eng-html (finish the sanitizer on `rv/eng-html/wip-pause-1028`, Opus security review), eng-host (host-1 to host-3; PRs on `rv/eng-host/*`). See the 2026-10-28 handoff table in git history (`git show 59e6470:plans/engine/HANDOFF.md`) for those SHAs.
6. Optional follow-ups from reviews, not blocking: raise the replay property test default from 80 to 1000 sequences if the CI budget allows (22 s); `lowSenders` sections can pass 150 KB near 2,000 senders; `events` view range validation is latent until prov-cal registers it.
