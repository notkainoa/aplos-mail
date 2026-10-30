# Integrator handoff (written 2026-10-30 ~08:10 local; replaces the 2026-10-28 one)

The old threads are `mcp:6116799a-5bed-4b61-a845-873061513d92` (snoozed, never wake it) and this one (past 400k average context: a fresh thread continues). Routing is roadmap 5.1a: Sonnet default, Opus only for contract, security (send guard, auth/tokens, vault, hardening), store commit path and sync correctness, SWE-2 for volume.

## State of revamp

`contract-v1` tagged at 9544e97 and FROZEN. About 97 PRs merged. Merged since the last handoff: the whole UI stack F2 (shell, #97) and F3 (Home, #98) after the owner's APPROVED (STATUS 18:30 Oct 29), the send state machine (#105/#107), the draft engine (#119/#120/#121), the timer loop (#89/#106/#113/#117), the lease and Gmail workflow channel (#73/#75/#90/#100), Google sign-in (#69/#72/#78/#81/#86/#91/#92), the vault (#95/#111), the live-run guard (#38/#67), hill-climb tooling (#99/#104/#108/#109/#110/#112/#115). Open: #122 (ui-foundation UI scorers; REQUEST to ui-core: env allow-list for the claude and Vite children, scope Read, cap findings) and #123 (plat-ci per-worktree node_modules; REQUEST: real `.bin` dir, fail-closed link-set check, removeWorktree containment; SWE-2 is fixing).

## How I check a PR

Two check worktrees: `rv-integrator-check` (scripts `check-pr.sh <pr> <lane> <sha> <approved>` and `check-multi.sh <pr> <lane> <sha> <acting-lanes> <approved-lanes>`) and `rv-integrator-check2` (`check-pr2.sh`, `check-multi2.sh`), all in `~/.cache/aplos-integrator/`. Each writes `/tmp/aplos-integrator/pr<N>.txt` (merge/install/check/owners/build exit codes) and `pr<N>-check.log`. Use `check-multi*` when a PR needs cross-lane approvals (it runs each step separately; `npm run check` stops at the first failing step, so a failing owners step hides typecheck and tests). Start background jobs with plain `nohup ... &` (macOS has NO `setsid`; I lost hours to that), one chain at a time per worktree, and wait with a bash `until grep -q "^build=" ...` loop. A stacked PR conflicts after its base is squash-merged: ask the lane to merge revamp, or resolve DECISIONS.md/OWNERS-only conflicts yourself in a scratch worktree with an ABSOLUTE path and a Python marker-stripper (never `sed -e`; I once pushed conflict markers). Squash merge: `gh pr merge N --squash --subject ... --body ...`, verify `gh pr view N --json state`, then append MERGED to `plans/STATUS.md` (pull first, push `HEAD:revamp`). Settle this thread with `t3_thread_organize settle` when parked; unsettle when working.

## Known flakes (load-sensitive, all reported)

`htmlToText` linear tests (fixed by #118), vault-rollback hung-rename (fixed by #111), hill-climb SIGTERM/lock tests (fixed by #109/#112), calendar-recurrence bounds (#102). The Mac's load can reach 100+ from other projects; a check can take an hour.

## BINDING items still open on other lanes (listed in my MERGED lines)

- Providers: run `sendPortContract` on the real Gmail (`in:sent`, never DRAFT) and Microsoft (`sentitems`) adapters and the emulator fake; `payloadOf` sends pinned bytes without `remoteDraftId` once a row has had an attempt; lease D1 (unproven device writes a copy every 5 min and never compacts), D2, D3; vault load-read timeout and the never-settling temp name in the `writing` set (low); revoke only with a store-backed `knownSubject`; composition root for `createGoogleHostConnect` (eng-host).
- Engine/eng-time: provider draft sync must not be switched on until a remote draft's body is delivered; client must switch to the returned id after a fork; `Engine.wake()` host hook.
- Platform: hill-climb follow-ups; lock/ref items are closed.

## Next actions

1. Wait for new heads of #122 and #123, run the check, a short Sonnet re-check of the fix diff, merge.
2. Live runs: none requested yet; follow `plans/LIVE-RUNS.md` (tier R first, only after reconnectBy is more than a day away; weekly reconnect Mon 2026-11-02).
3. Keep the owner's 08:00 digest (`scheduled-task:1c252312-eb43-405b-a4da-15163f3e17cb`); features waiting on the owner: none.
4. Owner decisions on record: bundled Desktop OAuth client secret allowed (DECISIONS.md #59); Demo/* window-only.
