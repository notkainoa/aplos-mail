# Resuming the revamp in lean mode (started early, on 2026-10-28 at the owner's request)

> **What this means:** tomorrow the revamp restarts with fresh, cheaper threads. There are three building threads plus the Integrator, Sonnet by default, and every rule in roadmap §5.1a applies. Everything paused tonight is either pushed, or still on disk in its worktree, so nothing is lost.

The owner paused everything on 2026-10-28 at 20:05 UTC and approved lean mode (roadmap §5.1a). The old threads are snoozed and stay paused, because their contexts are too large to keep using. Fresh threads replace them.

## State at the pause

- Merged on `revamp`: restructure steps 1–4, #28 (contract and freeze artifacts F1–F8), #29–#37, #39, #41, #42.
- Open PRs:
  - #44, UI-core F9 plus the base. It is the last freeze item; `contract-v1` isn't tagged yet.
  - #46 eng-contract runtime seam.
  - #47 eng-ai Home lanes.
  - #45 plat-ci engine tests under Electron's Node.
  - #43 eng-host quit fix.
  - #40 plat-release hardening.
  - #38 live-run guard, which needs the security-review fixes.
- Threads interrupted mid-task may have uncommitted work in their worktrees (`/Users/knewton/.t3/worktrees/aplos-mail/rv-*`). UI-screens' handoff is at `plans/ui-screens/HANDOFF.md` on `rv/thread/ui-screens`.
- Old thread ids, readable with `t3_thread_read` (small reads only):
  - Integrator `mcp:6116799a-5bed-4b61-a845-873061513d92`
  - Engine `mcp:aa00aa53-b513-42d2-96d1-ecb158cd11f0`
  - Providers `mcp:3cc38f80-9a34-4d39-a8d0-e53827aeb18d`
  - UI-core `mcp:aa2b408f-0841-47bb-a530-5ee96e45cf80`
  - Platform `mcp:9789bacb-42b3-433f-8a2e-87c022420498`
  - UI-screens (Linux) `mcp:4d66213e-f763-4cf7-85c2-729e1498dcd6`, on the Linux T3 server
- The owner's feature-14 website review is still waiting in the old Platform thread. Its screenshots are in `/tmp/aplos-web-review/` on the Mac.

## Steps (orchestrator, kept short; delegate everything)

1. **Measure.** Run `python3 plans/tools/token-report.py --since "2026-10-28 13:00"` and keep the totals as the baseline.
2. **Salvage and handoffs.** Start one Sonnet subagent per old thread: Integrator, Engine, Providers, UI-core, Platform. Each one:
   - runs `git status` in that thread's worktree, and commits any uncommitted work to `rv/<lane>/wip-pause-1028`, then pushes it, without building on it;
   - reads only the old thread's last 3 assistant messages;
   - writes `plans/<thread>/HANDOFF.md` (at most one page: per-lane state with SHAs, open PRs, the next 5 actions) on `rv/thread/<thread>`.
3. **Lane cards.** The same subagents write `plans/lanes/<lane>.md` for that thread's active lanes, at most one page each: goal, owned paths, the exact plan sections with line ranges to read, done criteria and test commands. Then they open one small PR into `revamp` for `plans/lanes/**`.
4. **Start the fresh threads** with `t3_thread_launch` and `modelSelection {instanceId: "claudeAgent", model: "claude-sonnet-5-5"}`. Each brief is under 60 lines: point at its brief in `plans/50-thread-briefs.md`, its HANDOFF, its lane cards, roadmap §5.1a, §5.1b and §12. Don't paste plans.

   | Thread | Machine | First jobs | Opus allowed for |
   |---|---|---|---|
   | Integrator | Mac | Merge #44 when it's green (UI-core fixes it if needed), tag `contract-v1`, post FROZEN; then #43, #45, #46, #47 and #40 one at a time; #38 after its fixes. Event-driven, no sweeps | Merge judgement on contract or security PRs only |
   | Engine | Mac | `eng-store`'s real `store.commit` and change log (critical path), then `eng-views` | The commit path and the store's correctness review |
   | Providers | Linux | The #38 guard fixes, then `prov-gov`, then `prov-gmail` on the real store | The send and live-run guard, governor correctness |
   | UI-core | Linux | Any #44 fixes, then `ui-shell` and `ui-home` on the stand-in engine | High-visibility screen calls the owner will judge |

   Platform also restarts, as a fresh Sonnet thread on the Mac with one small job: the owner APPROVED feature 14 (the website) on 2026-10-28. It runs the §12 steps d–g: an approval snapshot, one Sonnet review of the diff, a PR into `revamp`, then the merge. After that it handles #40's review fixes and stays parked. The new logo is a known follow-up for later. UI-screens stays parked until UI-core's base has merged. The parked lanes from Engine are `eng-ai`, `eng-time`, `eng-html` and `eng-host`; each resumes after its open PR merges and a building slot frees up.
5. **Watching.** Create one scheduled task with `bindToCurrentThread: false` (a fresh small thread each run), every 60 minutes. Its prompt: run `sh plans/tools/watch.sh` in the Mac worktree. On NOTHING NEW, reply in one line and stop. Otherwise route each new line to the thread that should act, and nudge idle threads. Re-enable the Integrator's 08:00 daily digest with one added line from `token-report.py`.
6. **Check after 3 hours.** Run the token report again. If Opus is above 25% of calls, or the average context is above 120,000 tokens, find the cause and fix the routing the same day.

## Rules that don't change

- Never merge to main, publish, send external mail, change repo visibility or rotate credentials.
- Commits are authored as Kainoa Newton <k@kainoa.me>.
- Never print keys.
- Headless only.
- PR visuals use demo data only.
- The owner reviews per feature (roadmap §12).
