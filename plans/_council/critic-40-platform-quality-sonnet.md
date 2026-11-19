# Critique of plan 40 (platform, security, distribution, quality), Sonnet

Checked against ARCHITECTURE.md, DESIGN.md, plans 10, 20 and 30, `research/email-clients/{protocols/proto-google.md,gaps/*}` and the repo on main (`/Users/knewton/.t3/projects/aplos-mail`, 72095ff: `package.json`, `apps/desktop/package.json` build block, `.github/workflows/*`, `RELEASING.md`, `scripts/release.mjs`, `apps/web/vercel.json`).

1. **blocker. Q1 contradicts plan 10 on order, and bundles things that cannot move together.** Plan 40 says "format commit, then engine move" (Q1, section 5.1, section 9.3). Plan 10 section 9 and 7.3 say the freeze window runs "pure rename, then formatter, then typed-client codemod". Q1 also ships `eslint-suppressions.json`, which is keyed by file path, plus boundary rules naming `packages/engine`, before that package exists, so the suppressions break on the `git mv`. Fix: split Q1 into Q1a (format commit only, path-agnostic, runs inside plan 10's window) and Q1b (ESLint, stylelint, suppressions, hook, CI `static`, written after the move). Adopt plan 10's order; make the equivalence script follow renames; state the window sequence in both directions.

2. **blocker. Main-bound work is not handled.** PV0 (0.2.4), E0 and, in effect, the Q0 feed switch and the Q5A website copy must reach main, but plan 40 allows only a vague "may be cherry-picked" (section 9.5). After the format commit, merging main into `revamp` conflicts in every dense file (`google.ts`, `gate.ts`, `service.ts`, `Reader.tsx`). Nothing says PV0 may ship through the old pipeline to the private repo without waiting for Q0, nor that 0.2.4 built with the old `build.publish` will have the private feed baked in and so cannot self-update. Fix: a "main-bound slices" rule (author against main, tiny, unformatted), a `format-merge` helper for merges after Q1a, an explicit "PV0 never waits on Q" statement, and a Q0-main slice sized at about a day.

3. **blocker. Google verification and CASA owner actions have no schedule.** The plan only lists "move to Production" plus a CASA evidence pack at Q6 week 4. Per `proto-google.md` section 8.2, the privacy policy must sit on a domain the owner owns, the brand check takes 2-3 business days, the restricted-scope review takes weeks, and CASA is yearly. The plan finishes the privacy page in Q5B (week 9) and has no domain decision, and Vercel deploys from main [U]. Fix: a timeline table of owner actions with lead times; pull the privacy page, Limited Use text and domain into Q5A (week 1); make the evidence pack its own early deliverable; add domain and "invite-only until verified" decisions.

4. **major. The public-flip section gets the Google client secret wrong and omits the bundled-client implications.** "Rotate the Google client secret before the first public release" does nothing, because the secret is inlined in every DMG (RELEASING.md), and disabling the old secret strands every installed copy. Missing: Actions artifacts of a flipped repo (the DMGs) become public; the feed URL baked into installed apps makes the releases repo permanent; the private repo must be renamed before a fresh-history repo takes `aplos-mail`; the Vercel link must move; forks must not use the official client. Fix: a new section 6.9.

5. **major. Tests may run against the wrong SQLite.** The `unit` job runs on Linux under system Node; only `electron-checks` asserts the version inside Electron. `storage-engine-benchmark.md` section 0 shows Homebrew Node linking a shared `libsqlite3` (3.54.0) while Electron bundles 3.53.4. Store, FTS and migration tests (plan 10 E2 onward) must run under Electron's Node. Fix: `test:engine` runs under `ELECTRON_RUN_AS_NODE=1`, inside `check` and CI, with a self-test that fails on a floor mismatch.

6. **major. Q7 lands after 0.3.0.** Q7 starts week 7, but plan 10 ships 0.3.0 after E3 and PV3 (about week 6) through `release.yml` v1, which has no hardening verification. "Ships with ARCH M1" is also wrong: M1 is not a release. Beta tags cut from `revamp` conflict with plan 10 section 9 ("releases cut from revamp only after merge to main"); `scripts/release.mjs` refuses non-main branches unless `--allow-branch`. Fix: Q2 wires `verify-hardening` into release v1; Q7a (workflow v2, matrix rows) moves ahead of 0.3.0; beta tags from `revamp` are explicit.

7. **major. The E2E build variant and the fuses collide.** Playwright's Electron driver needs `EnableNodeCliInspectArguments`, so the E2E variant cannot carry the release fuses. Fix: name the variant's fuse set and keep it unpackaged or unsigned, never uploaded.

8. **major. Public downloads before Production.** With Google in Testing, a stranger who downloads the DMG cannot sign in to Gmail unless listed as a tester (up to 100). README, download page and claims must say so. Fix: Q0 README text, Q5A copy and a decision.

9. **major. Performance budgets are thin and noisy.** Plan 40 only tracks app size and CI time, and applies DESIGN section 12.6's 10% gate on shared macOS runners; plan 10 section 5 says CI gates at 3x margin because runners are noisy. Cold start, idle CPU and RSS of resident mode, and the 100k fixture are unowned. Fix: a budget register (`budgets.json`) with owner, environment and gate type.

10. **major. Live smoke in CI contradicts plan 20.** Plan 20 section 7 says "live runs stay local" and section 5.4 describes `scripts/live/` with `verification/live/*.md` evidence; Q4 runs nightly CI smoke in `scripts/smoke/` with a different output. Fix: Q4 wraps plan 20's harness (one evidence format) and decision G covers the conflict; plan 20 must edit one line.

11. **minor. Format proof gaps.** `esbuild --minify` ignores comments and the byte-identical `dist` claim fails if sourcemaps or line numbers are embedded. Fix: compare comments separately and build with sourcemaps off.

12. **minor. Licence by path is missing** (`packages/mail-html`, `contract-fixture`, `apps/web`). Fix: a table under 6.3.

13. **minor. Owner readability.** In plain English omits the Google timing and the main/private split; decisions miss domain and the order of public steps; Q4 text says "SQLite", "cassettes" and "OOPIF" unexplained. Fix: add plain wording and two decisions.

14. **minor. Fact 9 says "all 600 commits"**; main has 169 commits, 606 across all refs. Fix the wording.

## Revision log

Edited only `plans/40-platform-quality.md` and this file. Plan 40 grew about 800 words; no technical section was shortened.

- **Item 1 (blocker).** Q1 split into Q1a (format commit plus a `format-merge.mjs` helper) and Q1b (ESLint, stylelint, suppressions, hook, `static` job). Added an explicit freeze-window table: main merged into `revamp`, then plan 10's pure `git mv`, Q1a, plan 10's codemod, Q1b, the `service.ts` split. Plan 40 now adopts plan 10's order (it was the cheaper side to concede: formatting after a pure move keeps blame and `--follow` clean, and suppressions are generated on final paths). Q1a is path-agnostic (globs cover `apps/*/src` and `packages/*/src`; equivalence follows renames), so a swap would not break it. Section 5 and section 9 item 3 rewritten to match; "first commit" language removed.
- **Item 2 (blocker).** Added ADR 40-10 (four main-bound slices: PV0, E0, Q0-main, Q5A-main, authored against main), the first-week order rule, a "PV0 never waits" statement, the private-draft fallback and the bridge cost for a 0.2.4 built before Q0-main. Added fact 19 (`release.mjs` main-only, `release.yml` contents) and the `--allow-branch` beta rule.
- **Item 3 (blocker).** New section 4A: a 12-row owner-action calendar for domain, Search Console, Production switch, branding, brand check, video, restricted-scope submission, CASA lab, fixes, approval and renewal, with lead times and the rules they impose. Privacy page and Limited Use text moved from Q5B to Q5A; new decisions M (domain) and N (invite-only downloads); CASA pack moved first in Q6 with a generating command.
- **Item 4.** ADR 40-11 and Q6.9: no ritual secret rotation (it ships in every DMG), staged add-second-secret procedure if a leak is found, lookalike-app risk, forks and the official-build guard, old Actions artifacts, permanent releases repo, rename-private-first, Vercel reconnect, one signed tag proof, verification stays with the Google project. Q6.2 bullet corrected.
- **Item 5.** ADR 40-4, Q3 deliverable 1 and Q3.2: `test:engine` runs SQLite-touching suites under `ELECTRON_RUN_AS_NODE=1`, a floor self-test, `.node-version` pinned to Electron's embedded Node, `npm run check` includes it.
- **Item 6.** Q7 split into Q7a (before 0.3.0) and Q7b; `verify-hardening` wired into release v1 inside Q2; Q2's "ships with M1" replaced by beta tags; section 9 item 5 defines beta tags from `revamp`.
- **Item 7.** Fact 21; ADR 40-6 and Q2 deliverable 6: the E2E variant is unfused and never uploaded; hardening evidence comes only from the real fused artifact.
- **Item 8.** Q0 README, Q5A copy and decision N state the Gmail tester limit.
- **Item 9.** ADR 40-12 and a `budgets.json` register in Q3 with owner, environment and gate per row; `check:budgets`; 3x gate on shared runners and the 10% trend on the owner's Mac and at release.
- **Item 10.** Q4 Layer 2 is now a CI runner over plan 20's section 5.4 harness; decision G adds a "local only" option.
- **Item 11.** Q1a acceptance adds a comment multiset check and sourcemaps-off builds.
- **Item 12.** Licence-by-path table in Q6.3, with `UNLICENSED` until decision C.
- **Item 13.** Plain-English rewritten (340 words) for the new items; decisions A, B, G reworded, M and N added; "cassettes" and "out-of-process iframe" explained; a closing "What this means" added to section 4.
- **Item 14.** Fact 9 wording corrected (606 commits across refs, 169 on main).

Questions left open in the plan as [U]: which branch Vercel publishes; whether Electron-as-Node runs `--test` with the tsx loader; whether Google allows two active secrets on a Desktop client; whether electron-updater 6.8.9 treats `-beta.N` as prerelease-allowed.
