# Platform thread handoff (2026-10-28, paused at 20:05 UTC; lean mode)

Old thread: `mcp:9789bacb-42b3-433f-8a2e-87c022420498` (read-only). Coordination branch `rv/thread/platform`. Fresh thread: Sonnet, Mac, headless. Read roadmap 5.1a and 12 first.

## First and only first job: feature 14, the website (roadmap 12 steps d-g)

The owner APPROVED it on 2026-10-28 (STATUS 13:41, `APPROVED | web`). Approved branch: `rv/web/q5-truth` at **c84e327** (pushed; it already contains `rv/web/q5-checks` 69dbec2 and the stripe-free DMG background 2012346). Diff vs `revamp`: 26 files, `apps/web/**` plus `apps/desktop/build/dmg-background.html`. The branch carries ~144 old commits that #28 squashed, so open the PR and squash-merge. Approved screenshots and walkthrough: `/tmp/aplos-web-review/{after,before}/` (light and dark landing, download, privacy, `walkthrough-light.webm`) and `capture.cjs`/`frames.cjs` there. The step-d snapshot is NOT yet taken.
`rv/web/vercel-branches` (5f4fe79) is already merged as #26; ignore it. Lane card: `plans/lanes/web-site.md`.

Steps: (d) copy the screenshots and capture script to `~/Library/Application Support/Aplos Mail Review/F14/c84e327/`, post `APPROVED` with the SHA (the orchestrator's entry has no SHA); one Sonnet review of the diff; (e) `gh pr create --base revamp --attach`; (g) re-run the capture, image-diff against the snapshot, list string/behavior diffs; if none are material and checks pass, `gh pr merge --squash`, post `MERGED`. Material change means stop and ask the owner. Known trap: production builds of the site fail on unproven claims (decision 2026-10-27 23:04); that is intended, preview builds only warn. Do not touch Vercel settings. The new logo is a later follow-up, not part of this.

## Second job: PR #40 (plat-release Q2 hardening)

Head `rv/plat-release/q2-hardening` 0dd8be1, mergeable, no inline review comments; CodeRabbit skipped (auto review off). Integrator queue lists it after #44 and #43. "Review fixes" means: merge `revamp`, rerun `npm run check`, apply any Integrator comments, and confirm eng-host landed the three edits requested at STATUS 08:14 (devTools and the Toggle Developer Tools menu gated on `!releaseBuild`; APLOS_TEST and APLOS_DATA_DIR ignored in release builds). Then park. Lane card: `plans/lanes/plat-release.md`. Opus is allowed only for the final security review of #40.

## State

- Open: #40 (above), #45 plat-ci `rv/plat-ci/test-engine` 1029150 (test:engine under Electron's Node, SQLite floor check, contract-fixture devDependency; waiting for the Integrator). The design-slot wiring `rv/plat-ci/design-slots` 8d1c781 is built on #44 and gets its PR only after #44 merges.
- Preserved uncommitted work: worktree `rv-plat-release-notices` (notices wiring: `apps/desktop/package.json`, `scripts/notices.mjs`, new `docs/release-checklist.md`) committed to `rv/plat-release/wip-pause-1028` **b6fd7b9**, pushed, not reviewed or built on. It was verified by the old thread (86 packages, Chromium licence included, notices outside app.asar) but needs a commit review, `npm run check` and a PR when the owner resumes Q0.
- All other `rv-plat-*` and `rv-web-*` worktrees were clean at the pause.
- The Vercel production branch is still an open owner task (the Integrator's digest carries it).

## Next 5 actions

1. Feature 14 steps d-g as above (snapshot, APPROVED line with SHA, one Sonnet diff review, PR, merge per 12.3).
2. Post `MERGED | web` with the PR link; then #40: merge `revamp`, rerun the check, answer the Integrator.
3. If the Integrator asks, open the PR for `rv/plat-ci/design-slots` once #44 has merged.
4. Park. Do not restart Q0 notices, E2E or evals without the orchestrator.
5. When resumed: review `wip-pause-1028` (b6fd7b9) and finish Q0 (notices plus release checklist).
