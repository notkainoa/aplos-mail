# Revamp status log

This is the append-only coordination log for the six revamp threads (`engine`, `providers`, `ui-core`, `ui-screens`, `platform`, `integrator`). One entry per line, newest at the bottom, in the form `YYYY-MM-DD HH:MM | <thread> | <TYPE> | <lane> | text`, with local Mac time, the thread name in lower case as listed, and `-` as the lane when an entry is about the whole thread. TYPE is one of NOTICE, FROZEN, HANDOFF-READY, LANE-DONE, REQUEST, BLOCKED-ON, CONTRACT-CHANGE-PROPOSED, CONTRACT-CHANGE-DONE, SLIP, READY-FOR-OWNER, APPROVED, MERGED, DECIDED. Never edit or delete an entry, yours or anyone's; correct one by appending a new entry that says so. Read it before each work package and each PR (`git fetch origin revamp`, then `git show origin/revamp:plans/STATUS.md`). Add entries as tiny commits pushed straight to `revamp`: `git pull --no-rebase origin revamp`, append your line at the end of the log, commit, `git push origin HEAD:revamp`; if the push is refused, pull again and retry, never force. No secrets, tokens, real addresses or real mail in any entry. Path ownership is in [OWNERS.md](OWNERS.md); `node plans/tools/queue.mjs` prints the owner's review queue from this file and flags malformed entries; the schedule and the rules behind this file are in [00-roadmap.md](00-roadmap.md) sections 1, 4, 7 and 12.

## Entry text, by type

Keep entries to one line. Address a REQUEST or BLOCKED-ON to a thread or lane by starting the text with `to <thread or lane>:`.

- `DECIDED`: a question whose answer was clear or had a default in the plans, the answer, and a one-line reason. Use it instead of waiting for the owner (owner's standing instruction, 2026-10-27). Questions that need a sign-in click, money, a design taste call the specs don't settle, a feature approval or anything on the hard-rules list still go to the owner; block only that item.
- `SLIP`: what moved, from which day to which day, and what it moves downstream.
- `READY-FOR-OWNER`: `F<n> <feature name> | <link to the ready post in the T3 thread> | lanes: <lane>, <lane>`.
- `APPROVED`: `F<n> | <lane>@<sha>, <lane>@<sha> | snapshot saved`.
- `MERGED` (feature PRs): `F<n> | <PR URL> | nothing material changed since <sha> | owner told`. The Integrator checks that an earlier READY-FOR-OWNER and APPROVED exist for the same feature and reverts the merge if not.
- `MERGED` (dependency and infrastructure PRs, posted by the integrator): `<PR URL> | <one-line summary>`.
- `CONTRACT-CHANGE-PROPOSED`: what is added and why, and the PR URL once it exists.

## How a PR gets into `revamp`

Every lane opens its PR from `rv/<lane>/<slug>` into `revamp`, after merging `revamp` into its branch. Nobody merges into `main`, ever.

1. **Dependency and infrastructure PRs** (anything another lane's "Needs" column names, and every PR from `eng-contract`, `eng-store`, `eng-views`, `prov-emu`, `ui-foundation`, `plat-ci` and `plat-release`) are merged by the integrator only. Before merging, the integrator confirms:
   - the PR touches only its lane's paths (the owners check, `scripts/audit/owners-check.mjs` once it lands; by hand against OWNERS.md until then);
   - `npm run typecheck`, `npm test` and `npm run check` pass at the PR head merged with current `revamp` (`npm run check` once `plat-ci` adds it);
   - the conformance suite passes on the stand-in engine, and the real-engine run fails only on its expected-fail list, which may shrink and never grow (once the suite exists);
   - the evidence (test output, numbers, screenshots where relevant) is attached to the PR, never committed;
   - an agent that did not write the code has reviewed it.
   Small PRs merge in arrival order, critical lanes first when several wait (`eng-store`, `prov-gmail`, `eng-views`, `ui-shell`, `ui-reader`). Squash merge, except Phase 0's mechanical restructure commits, which merge by merge commit and go into `.git-blame-ignore-revs`.
2. **Feature PRs** follow the per-feature loop (roadmap 12.3): READY-FOR-OWNER, the owner's approval, APPROVED with SHAs, four deep review passes, the PR with `gh pr create --attach`, then the lead thread squash-merges it itself only if nothing material changed since the approval snapshot, and posts MERGED. After every feature merge the integrator runs the full suite, the conformance run and the owners check on `revamp`.
3. **Never self-merged:** any PR labelled `contract-change` (the integrator merges it), a PR that touches another lane's paths, and anything that would merge while `revamp` is red. Post a REQUEST to the integrator instead. A PR that touches `packages/contract/**`, `packages/engine/src/ports.ts`, `packages/engine/src/store/migrations/**` or `packages/engine/src/methods/index.ts` from any lane other than `eng-contract` (or `eng-store` for migrations) is refused. Contract changes are additive within `v:1`.
4. **Red `revamp`:** the integrator finds the PR that broke it and reverts that PR at once with a note to its lane. Nobody force-pushes a shared branch; fix forward or revert.

## Log

2026-10-27 17:58 | integrator | NOTICE | - | Integrator started (day 1). STATUS.md and OWNERS.md created. Identity checked in all six thread worktrees: Kainoa Newton <k@kainoa.me>. DESIGN.md is the Paper spec with the mockup revisions folded in, and mockups/ is on revamp, so the UI threads may start Phase 1 work when the freeze lands.
2026-10-27 18:00 | integrator | DECIDED | - | OWNERS.md: tooling paths the plans write without a base folder (scripts/audit, scripts/smoke, tools/lint, tests/e2e, tests/visual, tests/perf, scripts/design) are owned by the same lane at the repo root and under apps/desktop/. Reason: the plans are ambiguous and this way no lane's first PR fails on location.
2026-10-27 18:00 | integrator | DECIDED | - | OWNERS.md: files the roadmap leaves unassigned: host/sqlite.ts to eng-store, host/logsink.ts and packages/engine/src/diag/** to eng-contract (F7), build config and both package.json manifests to plat-ci (Engine edits them in restructure step 1), apps/desktop/assets to plat-release (fonts to ui-foundation), native/ and API.md to eng-host, main/electron.ts after the split to eng-host. Reason: closest owning lane in the plans.
2026-10-27 18:00 | integrator | DECIDED | - | Unlisted new paths fail the owners check until the integrator adds them to OWNERS.md. Restructure steps 1-4 are exempt. Reason: every path to exactly one lane (roadmap F10).
2026-10-27 18:00 | integrator | DECIDED | - | Daily owner digest posted at 08:00 Mac time in the integrator thread, starting 2026-10-28. Reason: one digest a day (brief 6 section 7); morning suits the owner's review time.
2026-10-27 18:00 | integrator | REQUEST | plat-ci | to plat-ci: please build scripts/audit/owners-check.mjs from plans/OWNERS.md (most specific glob wins, root and apps/desktop forms of tooling paths, unlisted paths fail, input = changed files of a PR against revamp) and wire it into npm run check. The integrator reviews it. Until it lands, the integrator checks ownership by hand.
2026-10-27 18:01 | integrator | NOTICE | - | Baseline on revamp at 5c3c791, before the restructure: npm run typecheck passes, npm test passes 228 of 228. Any later red run is measured against this.
2026-10-27 18:01 | integrator | NOTICE | - | Freeze checklist written at plans/FREEZE.md. The integrator runs it on day 3 (2026-10-29), or earlier once the engine thread posts that F1-F8 are on revamp. Providers: port proposal by the morning of day 2. UI-screens: gap list by day 2, as a STATUS entry with a link.
2026-10-27 18:01 | integrator | DECIDED | - | OWNERS.md: scripts/check-contrast.mjs and the stylelint config go to ui-foundation. Reason: DESIGN 12.2 and 12.4 make them design checks.
