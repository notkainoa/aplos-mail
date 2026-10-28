# Integrator handoff (paused 2026-10-28 20:05 UTC)

Old thread: `mcp:6116799a-5bed-4b61-a845-873061513d92` (71 runs, snoozed). Read-only. The new thread works event-driven (roadmap 5.1a): no sweeps, Sonnet by default, Opus only for contract/security merge judgement.

## Lane state

| Worktree | Branch | HEAD | State |
|---|---|---|---|
| `rv-thread-integrator` | `rv/thread/integrator` | merged with `origin/revamp` e6b97cf | clean; this file is its only new content |
| `rv-integrator-freeze` | `integrator/f9-merge` (local only) | aed3782 | clean. Same SHA as #44's head `rv/ui-foundation/f9`; the merge of revamp into #44 (STATUS.md conflict, revamp's file taken). Disposable |
| `rv-integrator-check` | `rv/plat-release/integrator-check-40` (local only) | d9c6d67 | clean. #40 head 0dd8be1 merged with revamp for a check; result not recorded. Disposable, redo the check from the PR |

No uncommitted work in any of the three, so no `wip-pause-1028` branch was needed.

## Open PRs into `revamp` (all MERGEABLE; no CI check results posted yet)

| PR | Head | What it is | Blocker |
|---|---|---|---|
| #44 | aed3782 | ui-core F9 freeze artifacts + contract swap + ui-shell base (last freeze item) | integrator check was queued, never finished. On green: merge, tag `contract-v1`, post FROZEN (none posted yet) |
| #43 | 40735c4 | eng-host quit-race fix | not checked |
| #45 | 1029150 | plat-ci `test:engine` under Electron Node, SQLite floor check | not checked |
| #46 | 3e77eed | eng-contract runtime seam (contract-1); lane PRs after it carry squashed Phase 0 commits, so squash | not checked |
| #47 | 37df8f5 | eng-ai Home lanes | not checked; free-model code needs a Claude review |
| #40 | 0dd8be1 | plat-release Q2 hardening | security area: Opus final review; platform has review fixes pending |
| #38 | f302415 | prov-emu live-run guard (send-to-self) | security area: Opus review; RESUME says needs its review fixes |

## Next 5 actions, in order

1. Run the integrator check on #44 at head (merge with revamp, `npm run check`, owners check, conformance on the stand-in engine). If red, STATUS REQUEST to ui-core. If green: squash-merge, tag `contract-v1` on the merge commit, append FROZEN to `plans/STATUS.md` straight on `revamp`.
2. Merge #43, #45, #46, #47 one at a time in that order (critical lane #46 may go first), each: owners check, `npm run check`, a Sonnet review for non-Claude code, evidence on the PR, squash. Re-merge revamp into the next one after each merge.
3. #40: Opus review of the hardening diff, then merge after platform's fixes. #38: only after its guard fixes and an Opus review of the send and live-run guard.
4. Re-enable the 08:00 daily digest (max 10 plain sentences, plus one `plans/tools/token-report.py` line). Use `sh plans/tools/watch.sh`, not polling.
5. Check STATUS for MERGED entries without earlier READY-FOR-OWNER and APPROVED; revert and tell the thread if missing. Feature 14 (website) is owner-approved: web lane merges its own PR, then you verify.

## Gotchas

- Never merge to main. Never merge PR #21. Never force-push.
- Contract, `ports.ts`, migrations, `methods/index.ts` PRs from outside eng-contract/eng-store are refused.
- Platform REQUEST: eng-host test mode should quit on SIGTERM within seconds (open, with eng-host).
- Lane card: `plans/lanes/integrator-merge.md` (PR from `rv/lanes/integrator-cards`).
