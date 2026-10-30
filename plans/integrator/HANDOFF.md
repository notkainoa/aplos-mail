# Integrator handoff (rewritten 2026-10-30 ~14:00 local; replaces the 08:10 one)

The old threads are `mcp:6116799a-5bed-4b61-a845-873061513d92` (snoozed, never wake it) and this one (past 400k average context: a fresh thread continues). Routing is roadmap 5.1a: Sonnet default, Opus only for contract, security (send guard, auth/tokens, vault, hardening), store commit path and sync correctness, SWE-2 for volume.

## State of revamp

`contract-v1` tagged at 9544e97 and FROZEN. About 110 PRs merged. Merged since the 08:10 handoff: #124/#131/#137 (eng-time kill-point harness and release-grep), #122/#130 (UI scorers), #125/#126 (release syntax minify, SCORER_ISOLATED), #127 (lease D1-D3), #128 (Gmail filters), #129 (Gmail send + findSent), #132/#135 (vault temp name, load-proof tests), #134 (image proxy and SSRF classifier; I opened it from eng-html's parked branch and decided providers reuse it rather than copy). All five Opus-area PRs (send, lease, vault, SSRF, store hook) had an Opus review.

Open PRs, all waiting on their authors (my REQUESTs are in plans/STATUS.md, 2026-10-30 12:50):
- #123 (plat-ci, hill-climb per-worktree node_modules, head bbba37ef): FIX D1 (HIGH fail-open: audit-time re-snapshot adopts a swapped node_modules root, modulescan.mjs ~L131 / worktree.mjs ~L1042), D2 (dangling symlink refuses the worktree), D4 (ACCEPTED-RISK omissions). Re-run check-multi, then a short Sonnet re-check of the fix diff, then merge.
- #136 (prov-gmail-write, Gmail drafts API, my merge-of-revamp head d522eb2b): Opus FIX: deleteDraft has no version check (deletes a phone's newer edit), duplicate copies stay, uncertain create can resurrect a sent or deleted draft. Needs an additive port change via eng-contract (expected message id on remove). Re-check with Opus.
- #133 (prov-gmail-write, kill-point plug-in for the Gmail adapter, bb610628): Sonnet MERGE, but the check is red because the branch predates #131 (during-commit rows need their move in onMove). Waits for providers to merge revamp.
Not yet asked of me: providers' unsubscribe PR (reuses the #134 classifier; the executor must require https itself and refuse redirects); eng-contract UnsubscribePort seam (additive, Opus contract review).

## How I check a PR

Two check worktrees: `rv-integrator-check` (scripts `check-pr.sh <pr> <lane> <sha> <approved>` and `check-multi.sh <pr> <lane> <sha> <acting-lanes> <approved-lanes>`) and `rv-integrator-check2` (`check-pr2.sh`, `check-multi2.sh`), all in `~/.cache/aplos-integrator/`. Each writes `/tmp/aplos-integrator/pr<N>.txt` (merge/install/check/owners/build exit codes) and `pr<N>-check.log`. Use `check-multi*` when a PR needs cross-lane approvals (it runs each step separately; `npm run check` stops at the first failing step, so a failing owners step hides typecheck and tests). Start background jobs with plain `nohup ... &` (macOS has NO `setsid`; I lost hours to that), one chain at a time per worktree, and wait with a bash `until grep -q "^build=" ...` loop. A stacked PR conflicts after its base is squash-merged: ask the lane to merge revamp, or resolve DECISIONS.md/OWNERS-only conflicts yourself in a scratch worktree with an ABSOLUTE path and a Python marker-stripper (never `sed -e`; I once pushed conflict markers). Squash merge: `gh pr merge N --squash --subject ... --body ...`, verify `gh pr view N --json state`, then append MERGED to `plans/STATUS.md` (pull first, push `HEAD:revamp`). Settle this thread with `t3_thread_organize settle` when parked; unsettle when working.

## Known flakes (load-sensitive, all reported)

`htmlToText` linear tests (fixed by #118), vault-rollback hung-rename (fixed by #111), hill-climb SIGTERM/lock tests (fixed by #109/#112), calendar-recurrence bounds (#102). The Mac's load can reach 100+ from other projects; a check can take an hour.

## BINDING items still open on other lanes (listed in my MERGED lines)

- Providers: run `sendPortContract` on the real Gmail (`in:sent`, never DRAFT) and Microsoft (`sentitems`) adapters and the emulator fake; `payloadOf` sends pinned bytes without `remoteDraftId` once a row has had an attempt; lease D1 (unproven device writes a copy every 5 min and never compacts), D2, D3; vault load-read timeout and the never-settling temp name in the `writing` set (low); revoke only with a store-backed `knownSubject`; composition root for `createGoogleHostConnect` (eng-host).
- Engine/eng-time: provider draft sync must not be switched on until a remote draft's body is delivered; client must switch to the returned id after a fork; `Engine.wake()` host hook.
- Platform: hill-climb follow-ups; lock/ref items are closed.

## Next actions

1. Re-check #123, #133, #136 on their new heads when HANDOFF-READY lines appear (use SWE-2 only for mechanical review fixes, Sonnet for reviews, Opus for send/draft/store/vault/SSRF/contract areas).
2. eng-contract UnsubscribePort + HostPorts.unsubscribe: Opus contract review, then merge.
3. Live runs: none requested; follow `plans/LIVE-RUNS.md` (tier R first, only when reconnectBy is more than a day away; weekly reconnect Mon 2026-11-02).
4. Owner's 08:00 digest (`scheduled-task:1c252312-eb43-405b-a4da-15163f3e17cb`); features waiting on the owner: none.
5. Owner decisions on record: bundled Desktop OAuth client secret allowed (DECISIONS.md #59); Demo/* window-only.
6. Routing reminder (roadmap 5.1a): this thread delegated nothing to Devin SWE-2; a fresh thread should use `delegate_task` (providerInstanceId acpRegistry_devin, model swe-2-high) for well-specified non-UI code and review fixes.
