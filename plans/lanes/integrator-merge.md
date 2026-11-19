# Lane card: integrator-merge

Thread: integrator (Mac, Sonnet by default). Event-driven: act when a HANDOFF-READY, READY-FOR-OWNER or BLOCKED-ON line shows up in `sh plans/tools/watch.sh`; otherwise do nothing. No polling, no sweeps.

## Goal

Keep `revamp` green and the contract guarded. Merge dependency and infrastructure PRs after the checks, tag `contract-v1`, run the owner's review queue, send one daily digest. Own no product code. Never merge to main or PR #21; never force-push.

## Owned paths (plans/OWNERS.md lines 63-68, 69-82)

`plans/**` (except `plans/STATUS.md` appends by any thread, and the thread folders `plans/engine`, `providers`, `ui-core`, `ui-screens`, `platform`), `AGENTS.md`, `README.md`, `SPEC.md`, `VISION.md`, `MOBILE.md`, `.env.example`, `.github/**` not listed elsewhere, new top-level folders or `packages/` workspaces, root `vercel.json`. Includes `plans/lanes/**` and `plans/integrator/**`.

## Read (sections only)

- `plans/RESUME.md` lines 36-56: step 4 merge-order table (Integrator row), then the hard rules.
- `plans/STATUS.md` lines 17-32: "How a PR gets into revamp" (the merge checklist). Log lines since your last read only.
- `plans/00-roadmap.md` lines 333-388 (5.1a/5.1b lean mode), 411-428 (7: branch and merge strategy), 598-700 (12: feature review loop, 12.3 steps d-g, 12.5 who watches what).
- `plans/50-thread-briefs.md` lines 662-757 (Brief 6): sections 4 (Phase 1 merge rules), 7 (digest), 8 (branch rules), 12 (queue).
- `plans/FREEZE.md` lines 9-32 and 86-end: preconditions and exit, for the `contract-v1` tag.
- `plans/ARCHITECTURE.md` lines 519-553 (9: contract) only when judging a contract PR.

## Merge order now (RESUME step 4)

#44 (when green; UI-core fixes if red) then tag `contract-v1` and post FROZEN; then #43, #45, #46, #47, #40 one at a time; #38 after its guard fixes. Feature 14 (website) is merged by the web lane; verify afterwards.

## Per-PR checks (before each merge)

1. Owners check: PR touches only its lane's paths (`npm run owners:check`).
2. Merge current `revamp` into the PR head in a scratch worktree, then `npm run check` (includes typecheck and tests). Add `npm run test:engine` and `npm run check:sqlite` once #45 is merged.
3. Conformance on the stand-in engine once present; the real-engine expected-fail list may only shrink.
4. PR names the models that wrote the code. Free-model or Cursor code needs a Claude review of the full diff; Opus review only for contract, security, store-commit and send/live-run guard PRs.
5. Evidence attached to the PR, none committed. No keys, addresses or real mail anywhere.
6. Refuse contract, `ports.ts`, migrations or `methods/index.ts` changes from outside eng-contract or eng-store. `contract-change` PRs are merged by you, never by the author.

Squash merge; merge revamp into the next waiting branch after each merge. If `revamp` goes red, revert the culprit PR at once and post a REQUEST to its lane.

## Done criteria

- Every open PR is merged, closed or has a STATUS REQUEST naming what blocks it.
- `contract-v1` tagged on the #44 merge commit, FROZEN posted in STATUS.
- Every feature MERGED entry has an earlier READY-FOR-OWNER and APPROVED; otherwise revert.
- Daily digest (08:00, at most 10 plain sentences, one `python3 plans/tools/token-report.py` line). If Opus is above 25% of calls or average context above 120,000 tokens, tighten routing that day.

## STATUS.md merges as union

`plans/STATUS.md` is append-only: a correction is a new line, and existing lines are never edited in place. The root `.gitattributes` marks it `merge=union`, so two branches that both append merge with both sides kept and no conflict. If a plain merge ever conflicts on it anyway, keep both sides.

## Commands

`sh plans/tools/watch.sh`; `gh pr list --base revamp --state open`; `npm run owners:check`; `npm run check`; `node scripts/audit/owners-check.mjs`. STATUS.md and OWNERS.md commits go straight to `revamp` (`git pull --no-rebase` first). Commits are authored as Kainoa Newton <k@kainoa.me> and end with the Co-Authored-By line.
