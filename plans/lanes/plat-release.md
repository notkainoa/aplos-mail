# Lane card: plat-release (PR #40, Q2 Electron hardening, then park)

**Goal.** Get #40 merged: fuses, macOS 13 minimum, ad-hoc entitlements, one webContents guard, release-only debug refusal (exit 78), production CSP, verify-before-upload in `release-build.mjs` and `release.yml`. Then park.

**State.** PR https://github.com/notkainoa/aplos-mail/pull/40, branch `rv/plat-release/q2-hardening` at `0dd8be1`, mergeable, no inline review comments (CodeRabbit auto review is off). Built by three Opus packages, each adversarially reviewed, merged branch re-reviewed: no must-fix. In the Integrator's queue after #44 and #43. Worktree: `rv-plat-release-q2`. Separately, uncommitted Q0 notices work is preserved on `rv/plat-release/wip-pause-1028` (`b6fd7b9`): do not build on it until the orchestrator resumes Q0.

**Owned paths** (`plans/OWNERS.md` row `plat-release`, line 60): `apps/desktop/build/**` (except `dmg-background.html`), `apps/desktop/src/main/{security,updater}.ts`, `.github/workflows/release.yml`, `scripts/release.mjs`, `apps/desktop/scripts/{verify-release,release-build,...}.mjs`, `verify-hardening*.mjs`, `apps/desktop/tests/plat-release/**`, `RELEASING.md`, `THIRD_PARTY_NOTICES*`, `LICENSE`, `docs/release-checklist.md`. Other files need a REQUEST to their owner. `apps/desktop/package.json` needs the `lane-approved:plat-ci` label.

**Read, and only these.**
- `plans/40-platform-quality.md` Q2, lines 263-309 (hardening items and acceptance); Q0, lines 221-262 and Q7, lines 539-588 only if asked.
- `plans/00-roadmap.md` 5.1a, lines 333-380 (Opus only for the final security review of #40).

**Fixes to make (review fixes).**
1. `git merge origin/revamp` into the PR branch (it will touch `apps/desktop/package.json` and `plans/STATUS.md` neighbours); resolve, re-verify.
2. Answer anything the Integrator or an automated reviewer posts on #40; batch fixes, request at most one re-review.
3. Confirm eng-host landed the three edits requested at STATUS 08:14 (`windows.ts` devTools and the Toggle Developer Tools menu item gated on `!releaseBuild`; `APLOS_TEST` and `APLOS_DATA_DIR` ignored in release builds). #43 is the related quit fix. If missing, add a row to `verify-hardening` and re-REQUEST; do not edit their files.
4. Keep `security.ts` imported first in `lifecycle.ts` (the debug guard runs on import).

**Done when.** #40 merged by the Integrator, or an Integrator decision recorded; `LANE-DONE | plat-release` posted. Then park.

**Tests** (repo root).
- `npm run typecheck`; `npm test`; `npm run check` (format, lint, owners, typecheck, tests).
- `npm run verify:hardening -w @aplos/desktop` and `npm run verify:release -w @aplos/desktop` against a packaged build (`npm run package`); tests in `apps/desktop/tests/plat-release/`.
- Headless only; a packaged `APLOS_TEST=1` run uses a temp `APLOS_DATA_DIR`; never print keys.
