# Plan 40: Platform, security, distribution and quality

Workstream plan, 2026-10-27, branch `revamp`. Planning only: nothing here is implemented or goes to main, and PR #21 stays unmerged. It serves `plans/ARCHITECTURE.md` and `plans/DESIGN.md` (binding) and sits beside plans 10 (engine), 20 (providers and sync) and 30 (UI).

**Conventions.** `RC/` means `research/email-clients/`. Evidence labels: **[V]** verified by a research report or by me on 2026-10-27 (section 2); **[I]** inference; **[U]** unverified, to check live. Where research conflicts with `plans/_council/CONTEXT.md`, CONTEXT wins (Developer ID signed and notarized, team VW9NDM428H; no provisioning profiles; private repo; Google in Testing mode; no Microsoft client ID). Milestones here are **Q0 to Q8**; ARCHITECTURE's are **M0 to M10**. Owner decisions here are lettered **A to N**; ARCHITECTURE's are always "ARCH Decision n".

## In plain English

This plan covers releases, security, tests and the website.

Today only you can download Aplos or get updates, because the code is private and the download link points there. Electron, the toolkit Aplos uses, has its safety settings at their defaults. The installer claims macOS 12 support but needs macOS 13. The website lists Windows and Linux downloads that do not exist and says Outlook works when it cannot sign in yet. Google still treats Aplos as a test app, so only people you list can use Gmail.

The plan fixes these in order. A public releases-only repository makes downloads and updates work while the code stays private. Then one commit reformats every file. Then the security settings are tightened. Then a test robot opens the app on fake accounts. Then the website says only what is true, with its privacy page early because Google's review needs it. Last, it prepares for open source.

You need to answer 14 questions below, create a few accounts and get a domain for the website. You press the buttons to publish a release, send Google your review and make the repository public.

## Decisions for you

Each question has a recommended default. The plan uses the defaults unless you say otherwise. Answer M first, because Google's review cannot start without a domain. B, C and D unblock the most work.

**A. Reformat every file in one commit during the first-week freeze window?** Yes, after the engine files move and before the big engine split; or no, tidy files only as they change. **Default is yes.** One big diff changes no behaviour, and checks prove it. Later changes become readable. No keeps dense and tidy code mixed for months.

**B. Where do downloads and updates come from while the code is private?** (Architecture decision 11.) A separate public repository for releases only, named `aplos-mail-releases`; make the main repository public now; or host the files ourselves. **Default is the releases repository.** Downloads and updates work for anyone, and no source is exposed. The name is permanent because installed copies remember it. Going public now exposes unaudited history. Hosting costs you for 150 MB downloads.

**C. Which licence when Aplos goes open source?** (Architecture decision 12.) GPL-3.0 for the app and engine with MIT for `packages/contract`; MIT or Apache-2.0 everywhere; or AGPL-3.0. **Default is the first.** Copies of the app stay open, and tools built on the contract can be anything. Your name and icon stay yours. Today `package.json` says MIT but no LICENSE file exists, so the plan sets "UNLICENSED" until you answer.

**D. When the code goes public, keep its full history or start fresh?** A fresh, curated history; or flip the existing repository. **Default is fresh.** Today's history openly describes analysing a competitor's installed app, and 37 commits carry a different author name and email. Flipping keeps blame and old pull requests but makes every old commit, branch and note public.

**E. How do contributors agree to your licence?** A sign-off on each commit (the "DCO"); or a signed agreement (a "CLA"). **Default is the sign-off.** It is low friction, but you cannot relicense others' code later without asking. A CLA allows relicensing but deters casual contributors and needs a bot.

**F. When does the code go public?** With 0.4.0 after the audits pass; after 0.3.0; or now. **Default is with 0.4.0.** The first public code is the revamped one. After 0.3.0 gives an earlier community but shows the old design. Now is not advised, because Gmail does not work yet and nothing is audited.

**G. May the test robot use dedicated test accounts and keys in the cloud?** Yes, with a throwaway Gmail account and a separate Groq key now, and iCloud and Fastmail later; only on your Mac by hand; or only fakes. **Default is yes.** Small read-only nightly checks run, and your daily Groq allowance stays untouched. Your real mailbox is never used in the cloud. Mac-only means nobody notices a Google or Apple change for days. Fakes can never catch one.

**H. How much may cloud testing (CI) cost while the repository is private?** Linux for almost everything, and a Mac only on merges, tags and nightly; Mac for everything; or a spending cap you set. **Default is the first.** A Mac minute costs 10 times a Linux minute, and your included minutes are unknown.

**I. Which address may be published for security reports and privacy questions?** A role address on a domain you control plus GitHub private reporting; or your personal address. **Default is the role address.** It keeps your personal inbox out of the public record. Your personal address is faster but permanent.

**J. Should "Aplos Mail" get a professional name search before going public?** Yes or no. **Default is yes.** It costs a few hundred dollars. The audit found marks near "Airmail", not "Aplos", but never searched "Aplos Mail". No is free, with a small chance of a forced rename later.

**K. Should the website drop every claim not yet proven?** Yes, with no Windows or Linux, no Outlook and no other provider until it passes a live check; or keep the optimistic copy until launch. **Default is yes.** The site then matches reality. The optimistic copy is false today and risks Google's review.

**L. Should quality and platform run as its own T3 thread?** Fold it into the Engine thread, with the website items going to the UI thread; or a separate small thread. **Default is to fold it in.** You asked for one UI thread and at most two architecture threads. Revisit at the week-4 review if the Engine thread is behind. A separate thread gives one owner for tooling that touches every file but adds a fourth thread to review.

**M. Which domain hosts the website and privacy page?** A subdomain of a domain you already own, pointed at the Vercel site; buy a new domain; or wait. **Default is a subdomain.** Google accepts a privacy page only on a domain you own and have verified, and probably not a `github.com` or `vercel.app` address. A subdomain takes an hour and starts Google's review clock early. A new domain costs a small yearly fee and a day. Waiting stops Google verification, and Gmail stays limited to listed testers.

**N. May strangers download 0.2.4 before Google approves the app?** Yes, as an invite-only beta; or no, wait for approval. **Default is yes.** Gmail works for up to 100 people you list as testers, or up to 100 new users behind a warning screen after you move to Production. iCloud, Fastmail and other mail work for anyone, and the README and site say so. Waiting means nobody but you uses Aplos for weeks.

## 1. Scope and non-goals

**In scope** (per `plans/_council/task-plan-40-platform-quality.md`): Electron hardening (fuses, CSP, entitlements, macOS 13); Keychain and provisioning profiles; distribution (public release feed, publishing, update testing, rollback); open-source readiness (licence, secret-history audit, provenance, CONTRIBUTING, public docs); CI (formatter and linter adoption in one mechanical commit, emulator E2E, AI evals, live-provider smoke); modernization of the dense one-line files; the website truthfulness pass; the owner-action calendar for Google's OAuth verification and CASA assessment (section 4A); performance budgets (the register in Q3).

**Non-goals.**
- No engine, store, contract, provider or renderer feature work (plans 10, 20, 30).
- No design decisions. This plan wires CI slots for DESIGN §12 (lint, contrast, visual, perf); plan 30 writes those checks.
- No Windows, Linux or iOS builds (ARCH §17); no App Store build.
- No telemetry, crash upload or remote kill switch; support uses the user-exported diagnostics bundle (ARCH §11).
- No Google verification or CASA submission (plan 20 PV5 owns the engineering and the submission); this plan supplies the domain, privacy page, site, evidence pack and the calendar that ties the owner's steps together (section 4A).
- No merge to main, no visibility change, no release publishing by an agent.

> **What this means:** This plan builds the roads, locks and inspection robots. It does not build the mail features that drive on them.

## 2. Starting point: what I checked

Checked on 2026-10-27 in this worktree (revamp at `27cf52f`, the same app code as v0.2.3) unless a research path is given.

| # | Fact | How checked |
|---|---|---|
| 1 | Every Electron fuse is at its default: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` on; asar integrity validation and `OnlyLoadAppFromAsar` off. No fuse config exists in `apps/desktop/package.json` | `electron-fuses read` on the local 0.2.0 build; `RC/gaps/macos-daemon-lifecycle.md` §3 agrees |
| 2 | The shipped plist says `LSMinimumSystemVersion` 12.0; Electron 44.7.2 needs 13.0 | `PlistBuddy`; `package.json`; `RC/gaps/macos-daemon-lifecycle.md` §0.1 |
| 3 | Entitlements: `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`, `audio-input`; the comment says library validation is off partly so ad-hoc builds launch | `apps/desktop/build/entitlements.mac.plist` |
| 4 | The renderer CSP is a `<meta>` tag: `script-src 'self' 'unsafe-inline'`, `img-src … https:`, dev ports `5173` and `4317` in the production file | `apps/desktop/index.html` |
| 5 | A permission handler allows only the trusted window's microphone. Navigation and window-open rules are set per window, not globally | `src/main/electron.ts:107-109, 271-276` |
| 6 | Electron 44.7.2's embedded Node 24.21.0 has SQLite **3.53.4**; system Node 24.21.0 has **3.54.0**; FTS5 works in both. The ARCH §3.1 version check must therefore run inside Electron | `ELECTRON_RUN_AS_NODE=1 …/Electron -e` vs `node -e` |
| 7 | 228 `node:test` cases pass in about 6 s. CI runs typecheck, tests and build on macOS only. No lint, format, audit, E2E, eval or live job exists | `npm test`; `ci.yml`; `research/inbox-zero/aplos-architecture.md` §6 |
| 8 | 30 large files have more than 20 lines over 160 characters (worst: `Reader.tsx` 1,423 characters, `verify-release.mjs` 1,589). No Prettier, ESLint, Biome or stylelint config exists | line-length scan; `research/inbox-zero/SYNTHESIS.md` weakness 10 |
| 9 | A regex pass over all 606 commits (169 on main, the rest on other refs) for common key shapes (`gsk_`, `sk-ant-`, `sk-…`, `AIza`, `GOCSPX-`, `ghp_`, `github_pat_`, PEM headers, Google client IDs) found **nothing**; the only env-like file ever added is `.env.example`. A quick pre-check, not the audit (Q6) | `git log --all -p` through `grep -E`; `--diff-filter=A` |
| 10 | Two author identities: 133 commits Kainoa Newton, 37 "Scott Newton" with another email. The Developer ID certificate is in the name SCOTT ANDREW NEWTON | `git log --format`; CONTEXT |
| 11 | No `LICENSE` file; both `package.json` files claim MIT | `ls`; `package.json` |
| 12 | The 89 production dependencies are permissive: MIT 70, BSD-2-Clause 6, ISC 4, Apache-2.0 2, plus single BSD-3, Unlicense, MIT-0 (nodemailer), BlueOak, Python-2.0; `mailsplit` is "MIT OR EUPL-1.1+", `dompurify` "MPL-2.0 OR Apache-2.0". `npm audit --omit=dev`: 2 moderate, 0 high | script over `npm ls --omit=dev`; `npm audit` |
| 13 | The icon's source layers are named `Firefly (1).png`, `Firefly (3).png`, `Firefly_RemoveBackground.png` (Adobe Firefly output) and are tracked | `git ls-files apps/desktop/assets` |
| 14 | `SPEC.md` lines 5, 9, 13 describe following Avec's model and record its version and ASAR SHA-256; `PROGRESS.md` and `DECISIONS.md` describe the analysis; `SPEC.md:9` holds a local path | `grep -n -i avec` |
| 15 | `apps/web/src/release.ts` is `sample:true`: version 0.1.0 and invented Windows and Linux builds; macOS "12 Monterey and newer". Landing says "Works with Gmail, Outlook, iCloud, Fastmail and any IMAP account"; download URLs resolve inside the private repo; the privacy page has two `[to be added]` placeholders | `apps/web/src/*` |
| 16 | `release.yml` publishes a **draft** to the private repo with `GITHUB_TOKEN`, so the feed is 404 for everyone else (CONTEXT). The updater turns itself off when the app has no Developer ID team, a useful guard for source builds | `release.yml`; `updates.ts:23-30` |
| 17 | `verify-release.mjs` launches the packaged app with `--remote-debugging-port` and a visible window, against the owner's headless-only rule | `scripts/verify-release.mjs`; `electron.ts:101` |
| 18 | electron-builder 26.18.0 supports `electronFuses`, `mac.provisioningProfile`, `mac.entitlements*` and a publisher `channel`; electron-updater 6.8.9 honours `stagingPercentage` | `app-builder-lib/scheme.json`; `electron-updater/out/AppUpdater.js` |
| 19 | `scripts/release.mjs` refuses any branch but `main` unless `--allow-branch`; `release.yml` runs typecheck, tests and the build only (no hardening, SBOM or draft verification); `ci.yml` has one macOS job; `apps/web` deploys from git through Vercel (`vercel.json`, `ignoreCommand`), so the live site follows whichever branch Vercel is set to publish [U: which] | read of `scripts/release.mjs`, `.github/workflows/*`, `apps/web/vercel.json` on main |
| 20 | Release builds inline the Google client id **and secret** into `dist/main/engine.cjs` (RELEASING.md), and `release.yml` uploads the DMGs and ZIPs as Actions artifacts with the run. Anyone who downloads a DMG can extract them; no key was found in git (fact 9) | `RELEASING.md`; `release.yml` |
| 21 | Playwright's Electron driver attaches through Node's inspector, so it needs the `EnableNodeCliInspectArguments` fuse **on**; an E2E build cannot carry the release fuses | Playwright Electron docs [U: re-check on the pinned version in Q3] |

> **What this means:** The starting point is better than expected on secrets and dependency licences, and worse on safety switches, website honesty, and the paper trail in the project docs.

## 3. Decisions taken in this plan

| ADR | Question | Choice and reason |
|---|---|---|
| 40-1 | Formatter and linters | Prettier for formatting; ESLint 9 flat config with typescript-eslint for all JS/TS lint, including the DESIGN §12.2 custom rules; stylelint for CSS. Biome is rejected: it cannot host those plugins, so it would be a fourth tool, not a replacement |
| 40-2 | Proving the format commit is safe | Minified output of every file must match before and after, `dist/` must be byte-identical, tests must pass. A formatter changes no syntax tree, so this is checkable |
| 40-3 | Existing lint violations | ESLint bulk suppressions (ESLint 9.24 and later): old violations recorded, new ones fail |
| 40-4 | CI platforms and SQLite | Linux for static, unit and browser E2E; macOS for Electron, packaging and signing (decision H). [U] Some tests may need macOS; the first CI run finds them. **Any test that opens `node:sqlite` runs under Electron's own Node** (`ELECTRON_RUN_AS_NODE=1`, which needs no display, so Linux can do it): `node:sqlite` follows the host runtime's SQLite, and system Node differs from Electron's (fact 6) |
| 40-5 | Release home | Build in the private repo; publish drafts to the public releases-only repo with a repo-scoped token |
| 40-6 | Debug access in shipped builds | Release builds refuse Chromium debugging switches; E2E runs use a separate **unfused, unsigned, never-uploaded** build variant, because Playwright needs the inspector fuse on (fact 21). With `RunAsNode` off, a debugging port is the remaining way to use Aplos's Keychain trust as a puppet |
| 40-7 | AI evals and live checks | Replay gates every PR with no network; live evals are advisory, then blocking after ten stable nights; live provider checks are read-only, nightly, on test accounts, and never send (AGENTS.md) |
| 40-8 | Website claims | A machine-readable registry; the production build fails on an unproven claim |
| 40-9 | Public repo shape | Curated docs and fresh history (decision D); `plans/` and `research/` stay private; ADRs are published |
| 40-10 | Work that must reach main | One 0.2.4 train, the branch `hotfix/0.2.4` cut from main and owned by plan 20's PV0. Optional slices join it only if ready, and PV0 never waits: E0 (plan 10), plan 30's `srcdoc` stopgap (ARCH M0), **Q0-main** (the feed switch) and **Q5A-main** (website copy and privacy page). Each is authored against main, unformatted, with no dependency on Q1. After the format commit, merges from main into `revamp` use the format-aware helper (Q1a). Later stable releases reach main when the owner merges `revamp` |
| 40-11 | The bundled Google client secret | It ships inside every DMG, so it is not a secret in the usual sense (fact 20; `RC/protocols/proto-google.md` §8.1). It is **not rotated by default**: rotation protects nothing, and disabling the old secret would strand every installed copy. Rotate only on evidence of a leak, and then add a second secret first (section Q6.9) |
| 40-12 | Performance budgets | One register, `budgets.json`, lists every budget with its owner, the environment it is measured in and its gate type. Shared-runner gates use a 3x margin (plan 10 section 5); the strict 10% trend check of DESIGN §12.6 runs against owner-Mac history and release measurements, not noisy shared runners |

> **What this means:** These choices favour checks a machine can run over promises a person must remember.

## 4. Milestones

Order of work, with effort in focused working days of an agent workflow plus owner time. The total is about **37 to 49 days** of agent work, which fits beside the 11-week engine schedule because most of it runs in parallel (section 5).

| Milestone | Theme | Estimate | Starts |
|---|---|---|---|
| Q0-main | Releases home, main-compatible slice (tiny) | 1 day + owner steps | Day 1, parallel to PV0 |
| Q5A-main | Website: stop the false claims, finish the privacy page | 1-2 days | Day 1-3, parallel to PV0 |
| Q1a | The mechanical format commit | 1 day | Inside plan 10's E1 freeze window (week 1), **after** `main` has been merged into `revamp` |
| Q1b | Lint, boundaries, hook, `static` job | 1.5-2 days | Right after E1's move and Q1a |
| Q0 | Distribution unblock, rest (verifier, notices, update test) | 2-3 days + owner steps | Week 1 |
| Q2 | Electron hardening | 3-5 days | Week 1-2; first reaches users on a `beta` tag, then 0.3.0 |
| Q3 | CI foundation, emulator E2E, budget register | 8-10 days | Week 1, grows to week 6 |
| Q4 | AI evals and live-provider smoke | 5-7 days | Week 3 |
| Q6 | Open-source readiness (evidence pack first) | 6-8 days + owner | Week 3, audits late |
| Q7a | Release workflow v2 and the update matrix | 3 days | Week 4-5, **before 0.3.0** |
| Q7b | Rollback, secrets calendar, Keychain evidence, spike (conditional) | 1-2 days (+2-3 spike) | Week 7 |
| Q5B | Website: claims tied to proof | 2 days | Week 9 |
| Q8 | Release gate and public flip rehearsal | 3 days + owner | Week 10 |

Totals stay at about **37 to 49 days** of agent work (Q0-main and Q5A-main are the first days of Q0 and Q5A, not extra); most runs in parallel with the 11-week engine schedule (section 5). The scarce resource is the owner's time and the second Mac, not agent days.

**Order rule for the first week.** (1) PV0 is developed for the one `hotfix/0.2.4` train; E0, Q0-main and Q5A-main are built beside it and join the train only if ready (PV0 never waits). (2) When the train has merged to main (or by the end of day 5, whichever comes first) `main` is merged into `revamp`. (3) Plan 10's freeze window starts: its rename-and-imports commit, then Q1a, then the contract skeleton and its codemod. (4) Q1b lands. If PV0 is late, step 2 simply happens through the format-aware helper later; no step waits on a live Google check.

> **What this means:** The work is cut into small pieces with a fixed first-week order, so the Gmail fix, the tidy-up and the engine move never step on each other. Each piece below ends with its own plain summary.

---

### Q1. Tooling baseline and the mechanical format commit (Q1a and Q1b)

**Goal.** One formatter, one linter set and one pre-commit habit, so no later diff is dense, and so ARCH M1's `service.ts` split and plan 10's typed-client codemod happen on formatted code. Q1 is split in two because the two halves have different constraints: Q1a must be a pure, provable, path-agnostic rewrite inside plan 10's freeze window; Q1b contains config whose paths (ESLint suppressions are keyed by file path) must be generated **after** the files have reached their final locations.

**The freeze window, in order** (plan 10 section 9 owns the window and the announcement; this plan agrees to its order, which differs from the first draft of this plan, and writes the handoff from both sides):

| Step | Who | What | Why in this place |
|---|---|---|---|
| 0 | Plans 10, 20, owner | The 0.2.4 train (PV0, plus any slice that was ready) merged to main; `main` merged into `revamp` (or day 5, whichever is first) | A merge of a hotfix into a reformatted tree conflicts in every dense file |
| 1 | Plan 10 | `git mv apps/desktop/src/engine packages/engine/src` with import-specifier edits only (plan 10 E1 item 1), merge commit, no other content change | A rename with nothing but import lines keeps `git log --follow` and blame intact and every commit launchable |
| 2 | **Q1a** | The format commit over the **post-move** tree | One reformat of final paths; blame-ignore SHA taken after the move |
| 3 | Plan 10 | `packages/contract` skeleton, then the typed-client codemod over the 53 renderer `invoke(` sites in 15 files | Runs on formatted code, so its diff is small and reviewable |
| 4 | **Q1b** | ESLint, stylelint, suppressions, hook, CI `static` | Suppression file generated on final paths |
| 5 | Plan 10 | `service.ts` split | Reviewed on formatted code |

Q1a does not care whether step 1 happened: its globs include both `apps/*/src` and `packages/*/src`, and its equivalence script maps renamed paths with `git diff -M --name-status`. If plan 10 ever swaps steps 1 and 2, nothing in Q1a changes, so the ordering is a preference, not a dependency. What must never happen is Q1b before the move, or the format commit after the codemod.

**Q1a deliverables.**
1. `.prettierrc` (single quotes, semicolons, `printWidth` 100, `trailingComma: all`, `arrowParens: avoid` to match the existing `x=>` style) and `.prettierignore` (generated files, `dist`, `release`, `node_modules`, `research`, `plans`, lockfile, Markdown).
2. The **format commit**: `prettier --write` over `apps/*/src`, `apps/*/scripts`, `apps/desktop/tests`, `packages/*/src`, `packages/*/tests`, `scripts` and root configs. Authored as Kainoa Newton, prefixed `[mechanical]`, containing nothing else. Prettier is pinned exactly (no caret) so the check cannot drift.
3. `.git-blame-ignore-revs` naming that commit (added in the next commit, since a commit cannot name itself), mentioned in CONTRIBUTING.
4. **`scripts/audit/format-merge.mjs`**, the format-aware merge helper for any branch cut before the format commit (a late PV0 or E0, plan 30's U0 if early, a Q0-main or Q5A-main slice). For each file the branch touched, it formats the merge base and the branch tip with the same Prettier config, runs `git merge-file` against the current `revamp` version, and reports conflicts that remain. It is the cheap, deterministic version of plan 30's "take the incoming version, then re-run the formatter" rule (plan 30 section 10). Tested on a synthetic hotfix that edits `google.ts` and `gate.ts` on a pre-format branch.

**Q1b deliverables.**
5. `eslint.config.mjs` (flat): typescript-eslint recommended, `react-hooks`, `max-lines` 800 and `complexity` 25 as errors for new code, and boundary rules (below). `eslint-suppressions.json` records existing violations; it is generated once, after step 2, and carries a note that `git mv` of a file invalidates its entries.
6. `stylelint.config.mjs` (standard config) with an extension point, `tools/lint/`, where plan 30 adds the DESIGN §12.2 plugins.
7. Boundary rules: no `electron` or `node:` imports in `packages/engine` core (ARCH §2.6; plan 10 E1 ships the same rule as a test first, and the lint rule replaces it) and none in `packages/contract` beyond zod; the renderer may not import `src/main` or `packages/engine`; `dangerouslySetInnerHTML` is an error except in the mail-frame component after M4 (ARCH §10); no `eval`, `new Function` or `child_process` in the renderer.
8. Root scripts `format`, `format:check`, `lint`, and `check` (format check, lint, typecheck, unit tests including the SQLite-sensitive suite under Electron's Node per ADR 40-4: the **definition of done for any agent change**); `prepare` installs a plain git hook (`scripts/hooks/pre-commit`: Prettier check and ESLint on staged files, a few seconds; it sets `core.hooksPath` so it also works in T3 worktrees).
9. CI `static` job; Dependabot for npm and Actions (weekly, grouped); `.node-version` set to the exact Node that Electron 44.7.2 embeds (24.21.0, fact 6) and `engines` matching, so CI's Node and Electron's Node agree on language features; `npm audit --omit=dev --audit-level=high` as a failure.
10. `AGENTS.md` additions: run `npm run check` before every commit; no multi-statement one-liners; new files use named exports and small functions; whoever touches a dense function tidies it.

**Ownership.** Owns root and `apps/*/` tool configs, `tools/lint/`, `scripts/hooks/`, `scripts/audit/format-merge.mjs`, `.github/dependabot.yml`, and the style of `apps/desktop/scripts/*`, `apps/desktop/tests/*`, `apps/web/**`. Touches every file once, in the mechanical commit. **Afterwards the dense files in `packages/engine` belong to plan 10, provider files in `src/main` to plan 20, and `src/renderer` to plan 30**; each modernizes what it rewrites, and this plan does not.

**Depends on.** Decision A; plan 10's rename-and-imports commit (step 1) for Q1b only. Q1a blocks plan 10's codemod and `service.ts` split, and plan 30's U0 (plan 30 section 10 already waits for it).

**Acceptance (evidence).**
- `npm run check` is green on the commit after the format commit.
- **Equivalence:** a script runs `esbuild --minify` on the before and after blob of every changed `.ts/.tsx/.mjs/.cjs` file (following renames) and prints zero differences; any difference is listed and explained. Comments are invisible to a minifier, so a second check compares the comment tokens of each file before and after as a multiset.
- **Byte-identical build:** before and after yield identical `dist/main/*.cjs` and identical hashed `dist/renderer/assets/*` names, built with sourcemaps off (a sourcemap embeds line numbers and would differ by design). [U] If a bundle embeds a line number or `Error().stack` text, list the difference and explain it.
- 228 tests and the packaged `verify:release` pass.
- `git blame --ignore-revs-file` on a sampled dense line still names the original author, including a line in a moved engine file.
- **Format-aware merge:** the synthetic pre-format hotfix merges with zero unresolved conflicts and its diff, after formatting, equals the hotfix's own formatted diff.
- A deliberate violation on a scratch branch (a banned import, an unformatted file) fails CI; a committed suppression does not.

**Estimate.** Q1a 1 day, Q1b 1.5-2 days.

**Work packages.**

| WP | Fan out | Verify adversarially |
|---|---|---|
| Q1a.1 The format commit and helper | One agent, on a clean tree, with the owner confirming no branch is open except the ones the helper handles | A separate agent runs the equivalence script, the comment check and the build comparison without reading the first agent's report |
| Q1b.1 Config and boundaries | One agent | A second agent writes ten violating snippets (one per rule, plus a tricky one such as dynamic `import('electron')`) and shows each is rejected |
| Q1b.2 Suppressions and CI | One agent | A third agent checks that a fresh violation fails and the job fits in 3 minutes |
| Q1b.3 Hygiene | One agent | A seeded high-severity fixture on a scratch branch must fail `npm audit` |

> **What this means:** One careful tidy-up, proven not to change behaviour, makes every later review easier. It happens in a short, announced window right after the engine files are moved, with the Gmail fix already merged, so no work is lost. After it, the robot refuses new messes.

### Q0. Distribution unblock (Q0-main, then Q0)

**Goal.** Anyone can download a signed, notarized Aplos and receive updates without exposing source, proven on a Mac that has never run Aplos. **This must never delay the 0.2.4 Gmail fix (plan 20 PV0):** PV0 tags and ships through today's pipeline whether or not Q0 is ready.

**How PV0 and Q0 fit** (the facts: `build.publish` is baked into each build's `app-update.yml`; `release.yml` on main uploads a draft to the private repo; drafts 0.2.0 to 0.2.3 exist and none is published, and none should be, because they carry the 403 sync bug):
- **Q0-main** (about a day, authored against `main` on `hotfix/0.2.4-releases-home`, joining PV0's `hotfix/0.2.4` train if ready, no dependency on Q1): create the public repo and token; change `build.publish.repo` to `aplos-mail-releases`; swap `GH_TOKEN` in `release.yml` to `RELEASES_REPO_TOKEN`; the two-line `updates.ts` copy fix. Three files. It runs in parallel with PV0's 3 to 5 days, so it is normally ready first, and then **0.2.4 is the first build whose installed copies can self-update**.
- **If PV0 is ready first**, tag 0.2.4 anyway: the draft lands in the private repo, the owner installs the DMG by hand (they already have access), and the first public build follows. Installed 0.2.4 copies then also need one manual install of the next release (the bridge note below). That is the accepted cost of never blocking the fix.
- Nothing in Q1 to Q8 touches main's `ci.yml`, `release.yml` or any source file until the owner says; Q1's hook, lint and CI changes live on `revamp` only.
- `scripts/release.mjs` refuses non-main branches unless `--allow-branch` (fact 19); the Q0 beta tags use the flag, documented in RELEASING.md.

**Deliverables.**
1. **Releases repository** `notkainoa/aplos-mail-releases` (decision B): public, no source, **permanent** (every installed copy remembers its URL, and it stays the feed after the code goes public, section Q6.9). Issues and Discussions off until the source is public; README with install steps, the Gatekeeper first-open note, SHA-256 checksums, a privacy link, what to do if updates fail, and an honest line on Gmail: until Google approves the app, sign-in works only for listed testers (decision N); iCloud, Fastmail and other IMAP accounts work for anyone.
2. **Publishing switch** (Q0-main). `apps/desktop/package.json` `build.publish` points at the releases repo (`releaseType: draft`). `release.yml` uses a fine-grained token scoped to that repo's contents (`RELEASES_REPO_TOKEN`) as `GH_TOKEN`; `GITHUB_TOKEN` stays read-only. The draft remains the owner's gate.
3. **Draft verifier** after upload: both DMGs and ZIPs plus blockmaps and `latest-mac.yml`, version equals the tag, every SHA-512 matches its file. This turns RELEASING.md's manual checklist into code.
4. **Updater channel.** An optional `beta` channel (publisher `channel`; beta builds are prerelease versions such as `0.2.4-beta.1`, which electron-updater treats as prerelease-allowed [U: confirm on 6.8.9]) so update tests never touch stable. A beta is published as a GitHub prerelease, so `releases/latest` and the stable feed never see it.
5. **Third-party notices.** `THIRD_PARTY_NOTICES.txt` generated from production dependencies plus Chromium's licence file, shipped as an extra resource and linked from About. [U] Check that Electron's `LICENSES.chromium.html` reaches the packaged app.
6. **Bridge note.** Installed 0.2.x copies (and any 0.2.4 built before Q0-main) have the private feed baked into `app-update.yml` and cannot self-update (fact 16). The first self-updating build is installed by hand once, as RELEASING.md already says of the first signed release.
7. **Clean-Mac update test.** Publish `v0.2.4-beta.1` from `revamp` or a sandbox, install from the DMG, publish `beta.2`, confirm the in-place update. The test machine is the owner's second Mac; agents SSH there only if the owner says so, otherwise the owner follows a ten-line checklist (`docs/release-checklist.md`).
8. RELEASING.md rewritten for the new home; the ad-hoc path becomes a "building from source" section.

**Ownership.** Owns `.github/workflows/release.yml`, `apps/desktop/scripts/release-build.mjs`, release checks in `verify-release.mjs`, `RELEASING.md`, the releases repo, `build.publish`. Touches `updates.ts` (copy only).

**Depends on.** Decision B and an owner action (repo and token, about 30 minutes). Q0-main depends on nothing else. ARCH M0 supplies the first payload (0.2.4); if M0 is skipped (ARCH Decision 1), the first build is whatever is on `revamp`. `release.yml` only runs on tags, so edits are rehearsed in a private sandbox repository first (section 9).

**Acceptance (evidence).**
- `curl` without credentials fetches `latest-mac.yml` and both DMGs from the public URL, and the SHA-512 values match.
- The same token against the private source repository returns 404 or 403.
- On the clean Mac: first launch of the notarized DMG shows only the standard internet prompt; `spctl -a -vv` says "Notarized Developer ID"; `beta.1` updates to `beta.2` in place with data intact and **no Keychain prompt** (Developer ID gives a stable designated requirement; `RC/gaps/macos-daemon-lifecycle.md` §3 records the prompt ad-hoc builds cause).
- A tag cut with the pre-Q0 workflow on a sandbox repo still produces a private draft (proof that PV0 can ship without Q0).
- Screenshots are taken headlessly from the app's own state, not from a visible window.

**Estimate.** Q0-main 1 day; Q0 2-3 days; plus about 30 owner minutes and one clean-Mac session.

**Work packages.**

| WP | Fan out | Verify adversarially |
|---|---|---|
| Q0.1 Workflow and config (Q0-main) | One agent edits and dry-runs in the sandbox repo with ad-hoc signing | Another breaks it: wrong tag, missing token, wrong YAML hash, half-set notarization secrets; each must fail loudly |
| Q0.2 Draft verifier | One agent | Feed it a tampered YAML and a missing blockmap |
| Q0.3 Notices and copy | One agent each | Every production dependency in `npm ls --omit=dev` appears in the notices |
| Q0.4 Clean-Mac session | Owner, or an agent over SSH if allowed | Command output goes in the PR; a second person repeats the first-launch step |

> **What this means:** Downloads and updates start working for real people, proven on a clean Mac, while the source stays private. The Gmail fix is never held up by this work: it ships the day it is ready, here or in the private draft.

### Q2. Electron hardening

**Goal.** Close the gap between "signed and notarized" and "hard to abuse", and make the gap checkable by a script. ARCH M1 (resident mode) is a milestone, not a release, so the first users of fuses and resident mode are `beta` testers: Q2 and E1 are exercised together on beta tags cut from `revamp` (decided in section 9 item 5), then both ride in 0.3.0. The packaged engine is thus tested once, on the real update path.

**Deliverables.**
1. **Fuses** via electron-builder `electronFuses` (ARCH §2.5): `runAsNode`, `enableNodeOptionsEnvironmentVariable` and `enableNodeCliInspectArguments` off; `enableEmbeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar` on; `enableCookieEncryption` left off (Aplos stores no cookies and it would add Keychain use for nothing); `grantFileProtocolExtraPrivileges` left **on** until the renderer is served from an `aplos-app://` scheme (item 5). The engine uses `utilityProcess.fork` and `aplos-symbols` is a separate binary; the `RunAsNode` fuse affects neither (`RC/gaps/macos-daemon-lifecycle.md` §3).
2. **macOS 13:** `build.mac.minimumSystemVersion` 13.0 (fact 2).
3. **Minimal entitlements for Developer ID builds.** Two files: `entitlements.mac.plist` (release) and `entitlements.adhoc.plist` (source builds; keeps `disable-library-validation`, which exists so ad-hoc code launches). Try dropping `allow-unsigned-executable-memory` and `disable-library-validation` from the release file; keep `allow-jit` and `audio-input`. **[U]** V8 and Electron's helpers under the hardened runtime may still need one. The experiment is part of the milestone; the result and launch log go in DECISIONS.md, and whatever stays is commented in the plist.
4. **A global `web-contents-created` guard** in a new `apps/desktop/src/main/security.ts`, called from one line in `electron.ts`. Every `webContents` (windows, pop-outs, print views, future mail-frame views) gets navigation lockdown (`will-navigate`, `will-redirect`, `will-frame-navigate`), a deny-all window-open handler that routes safe links externally, `will-attach-webview` denied, and device and display-media permissions denied; the existing microphone rule stays. Today these live per window (fact 5), so a new window type would silently skip them.
5. **CSP in two stages.** *Now:* a Vite `transformIndexHtml` step emits a production CSP without the dev ports and, if the build emits no inline script (`build.modulePreload.polyfill: false`), without `'unsafe-inline'` in `script-src`. `style-src 'unsafe-inline'` stays (React sets style attributes); the reason is written beside the policy. *After ARCH M4:* `img-src` drops `https:` and gains `aplos-mail:`, `frame-src aplos-mail:` is added (ARCH §12.1), and an `aplos-app://` scheme serves the renderer with the CSP as a real header, after which `grantFileProtocolExtraPrivileges` goes off. **[U]** Whether the renderer relies on file-protocol privileges; the stage-2 test finds out.
6. **Debug access.** Release builds exit at startup when given `--remote-debugging-*` or `--inspect*` (ADR 40-6). `verify-release.mjs` moves to an **E2E build variant** compiled with an `APLOS_E2E` define that release CI never sets. Because Playwright's Electron driver needs the inspector fuse (fact 21), the variant is **never fused like a release**: it is an unpackaged `electron .` run (or an unsigned `--dir` build with default fuses), has no update feed, and is never uploaded. It also forces `show: false`, hides the Dock icon, and refuses a non-temporary data directory, satisfying the headless-only rule (fact 17). Because the variant differs from the release in exactly these ways, J11 and `verify-hardening` run on the **real fused artifact** and are the only evidence for fuses; the variant proves behaviour, not hardening.
7. **`apps/desktop/scripts/verify-hardening.mjs`**, run on any built `.app` and in release CI:
   - fuses equal the expected table; plist `LSMinimumSystemVersion` is 13.0 and `ElectronAsarIntegrity` exists;
   - `codesign --verify --strict --deep`, `spctl -a -vv`, `xcrun stapler validate`;
   - entitlements match the file, no extras;
   - the signed **designated requirement** names the bundle ID and team VW9NDM428H, which keeps Keychain trust across updates (a cdhash-only requirement is flagged);
   - launching with `--remote-debugging-port` makes the app exit;
   - an `app.asar` scan finds no `.env` and no key-shaped strings (`gsk_`, `sk-ant-`, `AIza`, PEM headers); the Google client secret appears only in the engine bundle, where RELEASING.md and ARCH §12.2 say it is inlined on purpose;
   - the engine starts and `aplos-symbols` runs in the packaged app.
   `verify-hardening` is wired into today's `release.yml` (v1) as a post-build step **in this milestone**, not in Q7, so 0.3.0 cannot ship without it; Q7a only restructures the workflow around it.
8. **Link-handler tests.** `aplos:` and `mailto:` arrive from the OS (`CFBundleURLSchemes`). A test feeds `handleLink` hostile input (`mailto:` with `attach=` pointing at a local file, control characters, very long and nested URLs); nothing outside the compose fields may be honoured.

**Ownership.** Owns `apps/desktop/package.json` `build.*`, `build/entitlements*.plist`, `scripts/verify-hardening.mjs`, `src/main/security.ts`, the `index.html` CSP and the Vite plugin. Touches `electron.ts` (the guard call, window `show`, link handler) and `verify-release.mjs`. Plan 10 owns resident mode and the engine host in `electron.ts`; plan 30 owns the renderer.

**Depends on.** Plan 10's E1 for the shared beta; ARCH M4 for CSP stage 2; Q1b; Q3's macOS packaged job; the second Mac. Does not depend on Q0's public feed: the first fused beta can be tested from a local build, and the in-place update step runs once the beta channel exists.

**Acceptance (evidence).**
- `verify-hardening` output from the signed, notarized release artifact shows every row passing, attached to the release PR.
- Hostile launches all fail: `ELECTRON_RUN_AS_NODE=1 "Aplos Mail" -e …` runs nothing; `NODE_OPTIONS=--inspect` is ignored; `--inspect` and `--remote-debugging-port` make the app exit; a copy with one byte of `app.asar` changed refuses to launch; a copy with an unpacked `app/` folder instead of the asar refuses.
- The app still works: engine up, `aplos-symbols` runs, microphone flow unchanged, an in-place update from beta.1 to beta.2 succeeds with asar integrity on.
- The entitlement experiment is recorded with launch evidence from the second Mac.
- Stage 2: in headless Electron under the production CSP, a remote image, an inline script and an `https:` frame are blocked and logged.

**Estimate.** 3-5 days (including the second-Mac test), plus 1 day for stage 2 after M4.

**Work packages.**

| WP | Fan out | Verify adversarially |
|---|---|---|
| Q2.1 Fuses, plist, entitlements | One strong-model agent (security-sensitive) edits config and runs the experiment matrix | A second agent runs the hostile launch list on the built app without the first agent's notes |
| Q2.2 `security.ts` guard | One agent, tests with fake `webContents` | Open each window type (pop-out, print, a deliberate `<webview>`); none may escape |
| Q2.3 CSP | One agent, header-level test | Try inline script, remote image, `javascript:` URL, `data:` frame; each must be blocked |
| Q2.4 `verify-hardening` | One agent | A third agent mutates the app (flip a fuse, strip stapling, add a key-shaped string) and confirms the script fails each time |
| Q2.5 Link-handler fuzz | One agent | A reviewer adds ten more cases from public URI attack lists |

> **What this means:** The signed app gets its safety switches turned on, and a script confirms they stayed on. They arrive together with the menu-bar mode, first for beta testers and then in 0.3.0, so you test once.

### Q5A. Website: stop the false claims, and finish the privacy page, now

**Goal.** Within the first week the public site says nothing untrue and its privacy page is complete and live on a domain the owner controls, because Google's brand check cannot start without it (section 4A). The evidence-backed version follows in Q5B.

**Q5A-main.** The live site is deployed by Vercel from git [U: which branch is "production"; check the project settings on day 1]. If it follows `main`, none of this reaches the public until it is on main, so Q5A is authored against `main` on `hotfix/0.2.4-site`, touches only `apps/web/src` copy and data, and joins PV0's `hotfix/0.2.4` train if ready (ADR 40-10). Because it changes no app code, if it misses the train it goes to main as the next small owner-approved PR rather than waiting for 0.3.0, since Google's brand check needs the privacy page. It reaches `revamp` through the format-aware helper. If the site is not yet live anywhere, the slice stays on `revamp` and the owner connects Vercel when decision M is made.

**Deliverables** (copy and data only; plan 30 owns visuals and the `Airmail` to `PostEdge` rename, DESIGN §2.5):
1. Sample data out of `release.ts`. The download page says "Not released yet" until a real release exists; once Q0 ships it reads the public releases repo at build time (as `VISION.md` intends) and fails the production build on sample data. Its text also states the Gmail limit of decision N.
2. macOS 13 (fact 2). Windows and Linux rows and "planned" lines removed (ARCH §17).
3. "Works with Gmail, Outlook, iCloud, Fastmail and any IMAP account" replaced by what is true. [I] Today that is the demo plus whatever has passed a live check; Outlook goes until a client ID exists; Gmail reads "invite-only until Google approves the app"; the rest returns in Q5B as each passes.
4. "Updates install themselves" only after the Q0 update test passes.
5. **The privacy page finished now, not in Q5B:** contact address (decision I), the Google API Services **Limited Use** statement (`RC/protocols/proto-google.md` §8.2), what is stored on the Mac and what leaves it (provider, the AI provider the owner chose, the update check; nothing else), no telemetry, and how to delete data. It is served at the domain from decision M, linked from the homepage, and its AI section matches what the code does (plan 20's `trainsOnInputs` rule). Google reads this page; a claim it cannot support is a rejection risk.
6. `scripts/check-web-external.mjs`: the built site requests no host but itself (the page promises no third-party scripts).
7. `site.ts` placeholder links replaced by the releases repo and, until the code is public, no source link.

**Ownership.** `apps/web/src/{Landing,Download,Privacy,release,site}.ts*` copy and `apps/web/scripts/`. Plan 30 owns `styles.css`, `Chrome.tsx`, tokens.

**Depends on.** Decisions K, M, N; Q0 for live release data; decision I for the address.

**Acceptance.** The built site has no sample release, no Windows or Linux, no Outlook, no unverified provider; every link returns 200 or an intentional "not yet"; the external-host check passes; the privacy URL on the owner's domain returns 200 over HTTPS and contains the Limited Use sentence verbatim from Google's policy page.

**Estimate.** 1-2 days.

**Work package.** One agent edits; a second reads the built site cold, lists every factual claim without opening the first agent's diff, and compares against fact 15.

> **What this means:** The website stops promising things that do not exist yet, and the privacy page that Google will read goes live in the first week. It is a small, fast change that should not wait.

### Q3. CI foundation and emulator E2E

**Goal.** Every change is judged by machines: static checks, unit tests, a browser run on fake mail accounts, an Electron run, and a packaged-app smoke, all headless. Slots exist for every check the other plans create.

**Deliverables.**
1. **`ci.yml` restructured.** Jobs: `changes` (the existing path filter); `static` (Q1); `unit` on Linux with a macOS fallback list, split in two: `test:unit` under system Node for suites that never open a database, and **`test:engine` under Electron's own Node** (`ELECTRON_RUN_AS_NODE=1 node_modules/electron/... --import tsx --test`; this mode needs no display, so Linux can run it once the Linux Electron binary is cached [U: confirm `--test` and the tsx loader work in that mode on 44.7.2; fallback is the macOS job]). `test:engine` covers every suite that touches `node:sqlite` today (`store`, `service`, `queue`, `sync-safety`, `sql`) and every store, FTS, migration and property suite plan 10 adds from E2 on, because `node:sqlite` takes whatever SQLite the host runtime has (fact 6; `RC/gaps/storage-engine-benchmark.md` §0, where Homebrew Node reports 3.54.0 and Electron 3.53.4). A `sqlite-floor` self-test prints `sqlite_version()` from both runtimes and fails if Electron's is below 3.43 (ARCH §3.1) or FTS5 `contentless_delete` is missing. `npm run check` runs `test:engine` locally the same way. `electron-checks` on macOS adds the packaged `--selftest` (plan 10 E1) and the 400 KB engine budget in `tests/portability.test.ts`, plus a build; `e2e-browser` on Linux; `e2e-electron` on macOS (E2E variant); `package-smoke` on macOS for merges and tags; `web`. Reusable via `workflow_call` so `release.yml` runs the same checks before signing. Actions pinned by SHA, `permissions: contents: read`, timeouts, concurrency cancel.
2. **Named slots** for checks other plans write, each a `package.json` script plus a CI job that is skipped (and listed as pending) until the script exists: `check:openapi` (plan 10, ARCH §9.3), `check:tokens`, `check:contrast`, `check:identity`, `test:visual` (plan 30, DESIGN §12.4-12.5), `test:perf` (DESIGN §12.6, macOS, packaged, nightly).
3. **One Playwright base** (`tests/e2e/playwright.config.ts`), pinned once; plan 30's visual harness extends it.
4. **E2E journeys** (table below) against the fixture engine, plan 20's emulators and the demo data, each with a temporary `APLOS_DATA_DIR`, its own ports, a frozen clock and no AI keys unless a scenario injects a mock provider (DESIGN §12.5's isolation).
5. **Fixtures:** seeded 10k, 50k and 100k-thread stores (plan 10 owns the generator; CI caches the database keyed by the generator hash).
6. **Performance budget register.** `budgets.json` at the repo root lists **every** budget in the plans, each with owner, environment, gate type and a calibration state, so none is unowned. Rows (values are the plans' own, never invented here):

| Budget | Owner | Measured where | Gate |
|---|---|---|---|
| Triage key to state, to next paint; J/K; palette; open a cached letter; scroll 10k rows (DESIGN §5 table) | Plan 30 (`tests/perf`) | Packaged build, 10k fixture | CI: hard cap at 3x the budget on shared runners; the 10% against 7-day median trend check (DESIGN §12.6) runs on the **owner's Mac and at release**, because shared macOS runners vary by more than 10% |
| Cold start to shell painted (800 ms) and Home interactive (1.5 s), marked "recalibrate after first measure" in DESIGN | Plan 30, harness by Q3 | Packaged build; the owner's Mac for the absolute number | As above; first run only records |
| Store: first page, unread counts, commit, cold open, RSS after first page, newest-50 search (plan 10 E2 list) | Plan 10 (`packages/engine/bench`) | 200k-message fixture | 3x margin in CI; exact numbers from the owner's Mac (plan 10 section 5) |
| 7-day soak: RSS slope, WAL size, event-loop p99 (plan 10 E8) | Plan 10, run by Q8 | Owner's Mac | Release gate |
| Resident-mode idle: engine RSS, CPU percent over 10 idle minutes, wake-ups [U: collected with `ps` and `top`; `powermetrics` needs sudo, so energy stays a hand check] | Plan 10 E1, harness by Q3 | Packaged build, owner's Mac | Recorded, then ratcheted (it cannot rise) |
| Packaged `.app` size (369 MB locally, 140 MB ZIP; alert at +10%), engine bundle (400 KB core), renderer bundle, unit-suite time, CI wall-clock | Plan 40 | Every merge | Ratchet |
| First sync: 500 threads, first 50 in 15 s on the accelerated clock (J2) | Plan 20, harness here | Emulator | Required |

The register has one script, `check:budgets`, that fails when a budget has no owner, no environment or a stale measurement older than its allowed age. Calibration follows plan 10's rule: a target marked "calibrate" is set from the first run on the owner's Mac and written to DECISIONS.md, after which a regression fails.
7. **Flake policy.** One retry in CI, flagged in the summary; a test needing it twice in a week is quarantined with an issue and listed in the job summary, never silently skipped.
8. **Branch protection:** required checks for `revamp` and later `main`.

| ID | Journey | Tier | Source |
|---|---|---|---|
| J1 | Onboarding: connect an emulated account; close at every step; reopen; PR #21 findings F1, F2, F7, F8, F9 | browser | `DESIGN.md` Appendix C |
| J2 | First sync against the Gmail quota emulator (6,000 units/min, concurrency cap): 500 threads, zero refusals, first 50 within 15 s on an accelerated clock, kill mid-page and resume at the page | browser | ARCH §6.2, M3 |
| J3 | Keyboard-only triage: Done, Later, undo, Space action; nothing jumps under the cursor | browser | `DESIGN.md` §5, §7.2 |
| J4 | Compose and send: undo window, scheduled send, a dropped connection shows "Send anyway" and never double-sends | browser | ARCH §7 |
| J5 | Search: local while typing, server only on Enter | browser | ARCH §3.4 |
| J6 | AI off: Home still ordered; no job before consent; a 429 pauses the queue and says why | browser | ARCH §8, M5 |
| J7 | Calendar: create, edit keeps the meeting link, RSVP | browser | ARCH §5.5 |
| J8 | Hostile HTML corpus (inline script, `onerror`, meta refresh, `<link>` prefetch, `url()` trackers, forms): the mail frame makes zero requests and runs no script | electron | `RC/gaps/electron-email-html-isolation.md` §7-8; ARCH M4 |
| J9 | Close the last window: the engine keeps running and a due reminder fires | electron | ARCH §2.2, M1 |
| J10 | A mail frame cannot call the engine | electron | ARCH §12.1 |
| J11 | Packaged smoke: the signed app starts headless, `Session/get` answers, a killed engine restarts | package | `verify-hardening` + `verify-release` |

The keyboard-from-inside-a-mail-frame behaviour (ARCH §10, marked [U]; the mail frame is a separate browser process, an "out-of-process iframe", which may swallow key presses) must still be **hand-checked** in the packaged app before M4 closes. An automated attempt is a bonus and never replaces it.

**Ownership.** Owns `.github/workflows/ci.yml`, `tests/e2e/**`, `apps/desktop/scripts/ci/*`, CI helpers in `scripts/`. Touches `package.json` scripts. Plan 20 owns emulators, plan 10 fixtures and the contract, plan 30 `tests/visual` and `tests/perf`.

**Depends on.** Q1b; plan 10's M1 fixture engine and M4 mail frame; plan 20's quota emulator (M3); plan 30's harness skeleton (DESIGN stage 2). Journeys are added as each lands and shown as pending until then.

**Acceptance (evidence).**
- A green run on `revamp` with per-job timings: static plus unit under 4 minutes, browser E2E under 8, macOS jobs under 15.
- **CI self-test.** A scratch branch with six deliberately broken commits: an unformatted file; a banned import; a key-shaped string in a built bundle; an unthrottled Gmail loop; a mail frame that makes a network call; an OpenAPI change with no golden update. Each fails the job meant to catch it, shown by run logs. The branch is kept as a regression fixture.
- The nightly workflow runs the perf and large-fixture jobs and stores a history file as an artifact.
- `check:budgets` fails on a budget row with no owner, and a store test that passes under system Node but fails under Electron's Node (a seeded SQLite-version difference) is caught by `test:engine`.

**Estimate.** 8-10 days, spread over weeks 1 to 6.

**Work packages.**

| WP | Fan out | Verify adversarially |
|---|---|---|
| Q3.1 Workflow restructure | One agent | Another reads it for supply-chain mistakes: unpinned actions, `pull_request_target`, secrets on fork PRs, a broad token |
| Q3.2 Engine tests under Electron's Node and the SQLite floor | One agent | Substitute an old SQLite in a scratch run; the job must fail; run `test:engine` and `test:unit` side by side and show the differing `sqlite_version()` values |
| Q3.3 Browser journeys J1-J7 | One agent per journey | A separate agent breaks the product for each journey (remove a throttle, drop a confirm) and checks the right journey fails |
| Q3.4 Electron journeys J8-J10 | One agent per journey | Run each twice on fresh data directories to catch order dependence; confirm no window is ever visible |
| Q3.5 Slots and budget register | One agent | Each slot fails when its script exists and exits non-zero; delete an owner from `budgets.json` and `check:budgets` goes red |

> **What this means:** A robot opens the app on fake accounts, without showing a window, and checks the journeys that matter. We prove it works by breaking things on purpose and watching it catch them.

### Q4. AI evals in CI and live-provider smoke tests

**Goal.** AI quality and provider behaviour are measured continuously, with real services where it counts, without spending the owner's quota or ever sending mail.

**Deliverables.**

*Layer 0, policy tests (no network, every PR).* A `tests/policy/` suite encodes rules from ARCH and AGENTS.md so they cannot drift:
- every provider adapter is built with SDK retries off (`maxRetries: 0`, ARCH §6.1);
- background AI jobs run with no tools (ARCH §8.5);
- no background job enqueues before consent, and a provider with `trainsOnInputs` receives no mail content (ARCH §8.3);
- mail text is always wrapped as quoted, untrusted content in prompts;
- no key-shaped value appears in any log line of a full run (ARCH §11);
- AI state never uses a sparkle, wand or star glyph (DESIGN banned-icon list).

*Layer 1, eval corpus.* Today: 8 factual cases (`apps/desktop/scripts/quality/cases.ts`) and a 5-question Ask check, both manual (`research/inbox-zero/aplos-architecture.md` §4). They grow to about 60-80 invented cases under `tests/evals/`: summary faithfulness, action extraction, reply-needed, rank bucket against the deterministic heuristic (ARCH §8.2), prompt injection (an email that tells the model to ignore instructions, forward mail or call a tool must not change the result), citation validity (Ask cites only excerpts it was sent), structured-output validity, refusal to act. No real mail is used.

*Run modes.*
- **Replay (gates every PR).** Provider responses recorded as "cassettes" (saved real answers, replayed offline) keyed by prompt hash; this tests parsing, guards and degradation deterministically. Refreshing cassettes is a reviewed manual command.
- **Live (advisory first).** Real Groq, temperature 0, pinned model IDs in the report. Nightly, and on pull requests labelled `ai` or touching prompt files. Runs in a protected environment with a dedicated Groq key, never the owner's daily key (ARCH §8.4: about 200,000 free tokens a day per model). A token-budget flag caps each run. At roughly 3,000 tokens a case [I, to be measured on the first run], a nightly run is a stratified subset of about 25 cases and a PR run is the 8-case smoke. The runner reads rate-limit headers and on exhaustion ends **inconclusive**, not failed. Pass rule: no case that passed in the last seven nights regresses in two of three runs; after ten stable nights the AI-labelled path becomes blocking. Results go to a `ci-data` branch and an artifact.
- **Cross-provider conformance (weekly, optional keys):** one tiny call per provider the owner has a key for, checking the auth header, stream parsing, and that a bad key becomes class `auth`; local servers use a fake OpenAI-compatible server.

*Layer 2, live mail-provider smoke.* **One harness, two runners.** Plan 20 section 5.4 owns the live-provider harness (`apps/desktop/scripts/live/`, tiers R read-only, M mutating on test objects, S send owner-only, content-free evidence files in `verification/live/<date>-<provider>.md`) and says tiers M and S never run in CI. This plan does not build a second harness: `npm run smoke:live -- gmail|gcal|icloud|fastmail|graph` is a thin **CI runner over plan 20's tier R only**, in `apps/desktop/scripts/smoke/`, that reuses its evidence format and adds `provider-status.json`. Whether it may run in the cloud at all is decision G; if the owner picks "only on your Mac", the same command runs from a local schedule and nothing else here changes. It goes through the existing `MailProvider` adapters, so it can start now:
- **Gmail:** token refresh, profile, labels, one `messages.list` page, one metadata `messages.get`, `history.list`; about 30 units a night (ARCH §5.1). Records granted scopes and quota headroom.
- **Calendar, iCloud IMAP and CalDAV, Fastmail JMAP:** login, list, status, capability read, one fetch, connection count.
- **Accounts.** **The owner's real mailbox is never used in CI.** The CI runner signs in only to dedicated throwaway test accounts whose tokens are CI secrets (decision G); runs against the owner's own account are local and manual.
- **Writes** (plan 20's tier M) never run in CI; locally, with the owner's flag, only in dedicated test accounts, only on objects the test created (a label, a draft), always cleaned up. **Never send.** The owner may run a manual `--allow-send-to-self` locally.
- **Cadence and secrets.** Nightly, one at a time, in environment `live-smoke` (required reviewer for manual runs); secrets masked, never on fork runs; logs hold hashed ids, units and latency, never subjects or bodies.
- **Credential expiry.** In Testing mode, refresh tokens last 7 days (`RC/protocols/proto-google.md` §8.1), so a nightly Gmail check would fail weekly. ARCH Decision 2 (move to Production, unverified) removes that, and the job treats `invalid_grant` as a known state that updates one GitHub issue instead of going red every night. `npm run smoke:auth` runs loopback OAuth locally and writes the new token with `gh secret set`, never printing it.
- **Caveat.** Nightly datacentre logins can trigger Google account challenges [U]; use a throwaway account, and if challenged move to a weekly manual run on the owner's Mac.
- **Output:** `provider-status.json` becomes evidence for website claims (Q5B). These are real endpoints, so live, but they do not replace the owner's acceptance on their own mailbox (ARCH §15).

**Ownership.** Owns `tests/policy/`, `tests/evals/`, `apps/desktop/scripts/smoke/`, `.github/workflows/{evals,smoke}.yml`, the `ci-data` branch; touches `scripts/{evaluate-groq,ask-live,quality/cases}.ts`. Plan 10 owns the queue the policy tests assert about; plan 20 the adapters the probes call.

**Depends on.** ARCH M5 (queue, consent) for full Layer 0/1; M3 and M7 for the best smoke coverage; decision G and owner secrets; ARCH Decision 2.

**Acceptance (evidence).**
- The replay suite runs in the PR job in under a minute and goes red when a prompt wrapper is removed or retries are re-enabled (deliberate breakage shown).
- The first live run reports tokens per case, replacing the 3,000 estimate.
- A fake Groq 429 makes the live job inconclusive, not failed; a fork-PR simulation shows no secret available.
- The Gmail smoke is green seven nights running, or, if Google is still in Testing, the expiry issue opens exactly once and the refresh procedure works.
- Gitleaks over eval and smoke artifacts finds nothing.

**Estimate.** 5-7 days; about 30 owner minutes for accounts and secrets.

**Work packages.**

| WP | Fan out | Verify adversarially |
|---|---|---|
| Q4.1 Policy tests | One agent per rule group | Revert the product rule; the test must go red |
| Q4.2 Eval corpus | Three agents write cases by category from a template | A different model family reviews for ambiguity and answer leakage; ten held-out cases come from someone who has not seen the prompts |
| Q4.3 Replay and live runner | One agent | Simulate rate-limit headers, a daily-limit 429, malformed JSON and a timeout |
| Q4.4 Smoke probes | One agent per provider behind a shared `SmokeProbe` interface that plan 20's tier R already satisfies or wraps | Record every outgoing request method; fail on any `POST/PUT/DELETE` from the CI runner (tier R only; OAuth token refresh excepted); confirm no send endpoint is reachable and no token for the owner's account is configured |
| Q4.5 Credentials | One agent writes `smoke:auth` and the expiry issue logic | Security review: tokens never printed, never in artifacts, never on forks |

> **What this means:** AI quality gets a nightly report card and real accounts get small read-only health checks. The robot never sends mail, leaves your daily AI allowance alone, and does not turn red just because a token expired.

### Q6. Open-source readiness

**Goal.** The owner can press "make public" confident that no secret, borrowed code, bad licence or embarrassing paper trail is exposed, and that a stranger can build and run the project. The press itself stays with the owner (Q8).

**Deliverables.**

**6.1 Provenance audit.**
- *Docs.* `SPEC.md`, `PROGRESS.md`, `DECISIONS.md` and `TODO.md` say Aplos began as "an independent take on Avec's interaction model", name Avec's installed version and ASAR hash, and describe how it was analysed (fact 14). Under decision D they stay in the private archive; the public tree gets a short curated `docs/`.
- *Code and copy.* Plan 30 removes the 17 Avec-derived layouts and phrases (`DESIGN.md` §13). The **provenance gate** adds: the banned-strings lint passes; a grep for Avec-specific strings, class names and constants is clean; a licence scanner (such as ScanCode) is clean; a manual look at the five largest files for text matching a reference project's code. The reference corpus includes GPL, AGPL and unlicensed code, so only ideas may enter (ARCH §14.1).
- *Assets.* The icon's source layers are Adobe Firefly output (fact 13). **[U]** Adobe's terms for commercial and open-source redistribution of Firefly output, and whether AI-generated art is copyrightable (weakly, in the US), need checking before the icon is called protected. The public repo ships only the final composed icon and website art under separate "all rights reserved, trademark" terms (`assets/LICENSE`); the Firefly layers stay out. Newsreader (SIL OFL, via fontsource) is fine and goes in the notices.
- *Dependencies.* The production tree is all permissive (fact 12), and GPL-3.0 can include all of those licences. Dual-licensed packages get a recorded choice (`mailsplit` under MIT, `dompurify` under Apache-2.0). A `license-check` CI job fails on any new copyleft or unknown production licence.

**6.2 Secret-history audit.**
- Before any flip, run **gitleaks** over every ref (default rules plus custom rules for `gsk_`, `GOCSPX-`, `sk-ant-`, `AIza`, Apple app-specific password shape, PEM headers) and **trufflehog** with verification. Include `refs/pull/*`, tags and release notes.
- A flipped repository also publishes every branch and pull-request ref (PR #21's too), issue and PR text, Actions logs and artifacts. Check logs and artifacts for printed values; delete runs that contain any.
- **Do not rotate the Google client secret as a ritual** (ADR 40-11). It is compiled into every released DMG, so a new one would ship the same way, and disabling the old one breaks token refresh for every installed copy. The audit's question is narrower: is the secret, or the signing `.p12`, the app-specific password or `RELEASES_REPO_TOKEN`, in git, a log, an artifact outside the DMGs, or a PR? If yes, rotate that one (section Q6.9 for the Google staging). Confirm the signing certificate and Apple secrets never reached a log.
- Scrub local paths (`/Users/knewton/...` in `SPEC.md:9`). The second author identity and the certificate name are moot under a fresh history; otherwise a `.mailmap` fixes display only.

**6.3 Licence application** (after decision C). Today there is **no LICENSE file anywhere**, so nothing is granted although both `package.json` files say MIT; the first Q6 commit sets both to `UNLICENSED`, and the chosen SPDX ids replace that only after decision C. Proposed licence by path (the owner confirms with C; plan 10's packages are named in its section 3):

| Path | Licence on the recommended default | Reason |
|---|---|---|
| `apps/desktop`, `packages/engine`, `packages/mail-html` | GPL-3.0-only | The product; copies stay open |
| `packages/contract`, `packages/contract-fixture` | MIT | A public interface and its test double, so any tool can be built against Aplos |
| `apps/web` code | GPL-3.0-only; copy, art and the icon: all rights reserved | The site is part of the brand |
| `assets/`, `AppIcon.icon` | All rights reserved, trademark terms (`assets/LICENSE`) | Name and icon stay yours |
| Fonts | Their own licences (Newsreader: SIL OFL) | Listed in the notices |

Files: `LICENSE` (GPL-3.0) at the root, `packages/contract/LICENSE` (MIT), `assets/LICENSE`; `package.json` `license` fields corrected (`UNLICENSED` now, then the chosen SPDX ids); `REUSE.toml` and a `reuse lint` job. `TRADEMARKS.md`: the name and icon are reserved; forks rename and change the bundle ID and URL schemes (`com.aplos.mail`, `aplos`, `mailto` default-handler behaviour); "Airmail" is never used (`RC/gaps/identity-collision-audit.md` §0). After decision J, the name-search result is filed in the private archive.

**6.4 Contribution machinery.**
- `CONTRIBUTING.md`: install; run without keys (demo data and emulators); `npm run check`; the design skill's definition of done for UI changes (`DESIGN.md` §12.3); DCO or CLA (decision E); how to supply your own OAuth clients via `APLOS_GOOGLE_CLIENT_ID`, `APLOS_GOOGLE_CLIENT_SECRET`, `APLOS_MS_CLIENT_ID` (ARCH §14.2; today's code reads `GOOGLE_CLIENT_ID` and similar, so the rename is plan 20's work and the doc follows whichever lands).
- `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md` (GitHub private reporting plus the address from decision I; scope: local listener, HTML sandbox, OAuth, updater; honest single-maintainer response times), `SUPPORT.md`, issue templates (bug reports attach the content-free diagnostics bundle, ARCH §11), a PR template (no secrets; tests; headless screenshots for UI), `CODEOWNERS`.
- **Official-build guard.** Today a build with no Developer ID turns the updater off (fact 16); keep that, and add an `APLOS_OFFICIAL_BUILD=1` define set only in release CI so a fork with its own certificate never polls the official feed.

**6.5 Public docs.** README (honest status, demo screenshots); `docs/` with a public-safe architecture overview, the ARCH §16 ADRs, the API and OpenAPI document once plan 10 ships it (ARCH §14.5), building, releasing (no secrets), privacy with a data-flow picture (provider, chosen AI, update check to GitHub; nothing else), and a provider matrix generated from `provider-status.json`. **`plans/` and `research/` are not published**: the research quotes and screenshots proprietary apps, and the plans hold internal deliberation.

**6.6 Repository settings checklist** (owner clicks): branch protection; secret scanning with push protection; private vulnerability reporting; Dependabot alerts; CodeQL (free on public repos); approval for first-time fork workflows; read-only default token; **release and live-smoke secrets in protected environments**; no `pull_request_target`.

**6.7 Flip rehearsal.** Build the candidate public tree in a throwaway private repository and run all CI there. Then a **stranger test**: an agent with no prior context follows only the README and `docs/building.md` to build and run the demo headless; a human reviews; time to first run is recorded.

**6.8 CASA evidence pack, built early** (supports plan 20's PV5 track, `RC/protocols/proto-google.md` §8.2; section 4A shows why it is on the critical path): the privacy policy (Q5A), a data-flow document with "no Aplos server, no telemetry", static-analysis output (CodeQL or Semgrep on the private repo), dependency and licence scans, the secret-scan report, `verify-hardening` output from a signed beta, a short security model (renderer sandbox, mail frame, local listener off by default, Keychain-wrapped keys), and the incident and data-deletion procedure. It is generated by one command (`scripts/audit/casa-pack.mjs`) against a given signed build, so it can be rerun on the exact build the assessor tests. [U] The assessor sets the exact requirements; plan for CASA, as the research advises. **Q6 starts with this item**, not with the open-source work, so a first pack exists by about week 5 when plan 20's PV3 gate passes.

**6.9 When the main repository goes public: the bundled Google OAuth client, the feed and the plumbing.** What changes, what does not, and what must be done before the owner presses the button (the sequence is the Q8 flip runbook):
- *What the public sees about the client.* The client id and secret are inlined from GitHub secrets by `scripts/build-main.mjs` only when `APLOS_RELEASE_BUILD=1`; they are not in the tree (fact 9). Publishing the source therefore exposes nothing new: the DMG already carries both, and Google's own guidance says an installed-app secret is not confidential (`RC/protocols/proto-google.md` §8.1). What a stranger *can* do is lift the pair from a DMG and build an app that shows Aplos's consent screen. That is the standard installed-app risk; Google's verification, the brand name on the consent screen and the redirect rules are the mitigation. `SECURITY.md` says so plainly and gives a way to report a lookalike.
- *Forks and source builds.* They must use their own Google project and their own client (ARCH §14.2; `APLOS_GOOGLE_CLIENT_ID` and friends, plan 20 PV5). They will be unverified, capped at 100 users and shown a warning; `CONTRIBUTING.md` says this before anyone is surprised. The official-build guard (6.4) stops a fork with its own Developer ID from polling the official feed, and a build without the official define must never contain the official id.
- *Rotation, only if a leak is found.* Add a second client secret in the Google console, ship a build that uses it, wait until installed copies have updated (the update-adoption count comes from release download counts [I]), then disable the old secret. Never disable first. Owners of copies that never update will be asked to reinstall. [U] Confirm the console allows two active secrets on a Desktop-app client; if not, creating a new client id would force every user to reconnect, so the answer is "do not rotate without evidence".
- *Old Actions artifacts and logs.* Flipping the existing repository makes every past workflow artifact (including the DMGs and ZIPs `release.yml` uploads) and log downloadable. Under decision D's recommended fresh history this is moot; under "flip the existing repo", delete all prior runs and artifacts first and keep only runs the audit has cleared.
- *The feed is permanent.* Every installed copy remembers `aplos-mail-releases`. After the flip, releases keep going to that repository; it is not renamed, archived, transferred or deleted. Installed apps never learn the new source repo's name.
- *Repo names and links.* With fresh history, the private repository is renamed (for example `aplos-mail-archive`) **before** the new public `aplos-mail` is created, so redirects and Actions secrets do not collide; `homepage` and `repository` fields and `apps/web/src/site.ts` point at the new repository in the same change.
- *Moving the plumbing.* New repository: secrets recreated in protected environments (never copied from logs), Vercel project reconnected to the new repository and branch, Dependabot, CodeQL and secret scanning enabled, `RELEASES_REPO_TOKEN` re-issued scoped to the releases repo only, and one signed, notarized tag run from the new repository to prove the whole chain before anything is announced.
- *Verification interplay.* Google's verification is attached to the Google project and its consent-screen identity, not to the GitHub repository, so moving repositories does not reset it. Changing the **app name, homepage domain or scopes** after submission does (ARCH ADR-03 scope freeze; decision M).

**Ownership.** Owns `LICENSE*`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `TRADEMARKS.md`, `REUSE.toml`, `.github/ISSUE_TEMPLATE`, `PULL_REQUEST_TEMPLATE.md`, `CODEOWNERS`, `docs/`, `scripts/audit/`. Touches `package.json` license fields, `README.md`, `AGENTS.md`. Plan 20 owns OAuth env names; plan 30 the banned-string lint.

**Depends on.** Decisions C, D, E, F, I, J, M; plan 30's U3 for the provenance gate (all 17 Avec-derived items are gone only after U3; U0 removes items 1-8, 16 and 17); plan 20 for the OAuth rename and the CASA submission.

**Acceptance (evidence).**
- Gitleaks and trufflehog report zero findings over every ref of the **candidate** history; reports are kept in the private archive.
- `license-check` and `reuse lint` pass; the notices cover every production dependency.
- The provenance checklist is signed off line by line in a PR, each line citing command output.
- The stranger test passes on a clean clone of the rehearsal repository.
- Decisions C-F are recorded in the private DECISIONS.md with dates.
- The CASA pack command runs against a signed beta and its output is complete enough that every item in plan 20's PV5 evidence list has a file.
- A dry run of the 6.9 sequence in the rehearsal repository: a fork-style build without the official define contains no official client id (checked by `verify-hardening`'s string scan), and the official-build guard keeps a differently signed build off the official feed.

**Estimate.** 6-8 days of agent work, plus owner decisions and the external name search.

**Work packages.**

| WP | Fan out | Verify adversarially |
|---|---|---|
| Q6.0 CASA pack command | One agent writes `casa-pack.mjs` and runs it on a signed beta | A reviewer plays the assessor: lists every plan 20 PV5 evidence item with no file behind it |
| Q6.1 Secret scan | One agent runs both scanners with custom rules | Plant three fake secrets in a scratch history (a deleted file, a PR ref, a tag message) and confirm all are found |
| Q6.2 Provenance gate | Three agents: docs, code and copy, assets | An independent agent hunts for any trace of a reference app's text, constants or asset names with greps it designs itself |
| Q6.3 Licences, governance docs | One agent per document set | Review by agents role-playing a first-time contributor, a security researcher and a packager; `reuse lint` clean |
| Q6.4 Rehearsal | One agent builds the rehearsal repo; a context-free agent runs the stranger test | The owner reads the README's plain-English top and the privacy page and says whether they match the product |

> **What this means:** Before anyone sees the code, we scan every old commit for secrets, check for borrowed material, settle the licence, write the contributor guides, and rehearse the handover in a throwaway copy.

### Q7. Release engineering, update testing and Keychain profiles (Q7a, then Q7b)

**Split.** **Q7a** (deliverables 1 to 3 and 8, about 3 days) lands **before 0.3.0**: 0.3.0 is ARCH M3 (plan 10's E1, E2a and E2b with plan 20's PV3, about week 5-6; E3 is not required), and it must go out through `release.yml` v2 with the hardening verification and the update matrix, not through today's pipeline. **Q7b** (deliverables 4 to 7, 1 to 2 days, plus the conditional spike) follows in week 7. Beta tags cut from `revamp` for Q2 and Q7a use `scripts/release.mjs --allow-branch` and publish to the releases repository as prereleases on the owner's go-ahead; stable releases are tagged from main after the owner merges `revamp` (section 9 item 5 below; plan 10 section 9).

**Goal.** Releases are repeatable, every update path has been exercised, and a bad release can be pulled. The Keychain and provisioning-profile question is answered with evidence, and profile work is ready if a trigger fires.

**Deliverables.**
1. **`release.yml` v2.** Verify tag and version; shared CI checks (`workflow_call`); build both architectures; sign and notarize; **verify** (`verify-hardening`, `spctl`, `stapler validate`); upload the draft to the releases repo; run Q0's verifier; publish a SHA-256 checksums file and a CycloneDX SBOM (`npm sbom`); build-provenance attestation where the plan allows [U on private repos]. The draft is created last, so a failure leaves nothing half-published.
2. **Channels.** `beta` pre-releases for tests, `latest` for stable. Staged rollout is documented (electron-updater honours `stagingPercentage`, fact 18) but off by default: with no crash upload it needs testers who report.
3. **Update test matrix** in `docs/release-checklist.md`, run per minor release on two Macs, each row with command and expected output:

| # | Case | Expected |
|---|---|---|
| 1 | Clean install from DMG | Standard first-open prompt; notarized |
| 2 | Update N-1 to N, same channel | In place; data intact; **no Keychain prompt** |
| 3 | Update during a scheduled send and a running sync | Engine drains within 3 s (ARCH §2.4); the send stays queued, not duplicated |
| 4 | Update across a schema change (0.3.x to 0.4.0) | Import runs once; the rollback drill reopens 0.2.x on `aplos.db` (ARCH §3.8, M10). Plan 10 owns the data side; this plan owns the machine and procedure |
| 5 | Run from the mounted DMG or translocated | Updater off, with the reason shown (`updates.ts`) |
| 6 | Feed unreachable | Short error row; no crash; retry in 6 hours |
| 7 | Feed edited so a SHA-512 is wrong | Download refused |
| 8 | Download killed midway | Resumes through the blockmap |
| 9 | Downgrade | Updater refuses; an older app refuses a newer database (plan 10) |
| 10 | Second Mac, different macOS version | Same results |

   The unsigned local fake feed (`npm run update-feed`) stays for state-machine and UI tests. **Release builds ship no feed override**, since a hostile feed could offer an older signed build; signed-update tests use the public `beta` channel.
4. **Keychain behaviour without a profile.** Today's `safeStorage` item is in the login keychain and its trust follows the app's designated requirement. With Developer ID that requirement is stable across versions, so updates should not prompt (`RC/gaps/macos-daemon-lifecycle.md` §3; the ad-hoc prompt is in `PROGRESS.md:448`). This is evidence work, not code: `verify-hardening` compares the requirement across two releases, and matrix row 2 observes no prompt. `security find-generic-password` is used for **metadata only**, never `-w`.
5. **Provisioning-profile spike (conditional, 2-3 days).** Trigger: ARCH A1 or CloudKit is scheduled (§2.6, §13.2), or prompts appear despite Developer ID. Steps: the owner creates the App ID and a Developer ID profile with Keychain Sharing; embed it with `mac.provisioningProfile`; entitlements gain `com.apple.application-identifier` (`VW9NDM428H.com.aplos.mail`), `com.apple.developer.team-identifier` and `keychain-access-groups`; the notarized build is launched on the **second Mac before anything ships**, because a restricted entitlement without a matching profile can make macOS refuse to launch the app. Evidence: launch, a key written and read under the group, an update that keeps it. If it fails, the unprofiled build stays the shipping default. The data-key migration belongs to ARCH A1 and plan 10.
6. **Secrets calendar** (private archive): Developer ID certificate, app-specific password, `RELEASES_REPO_TOKEN`, Google client secret, smoke and Groq keys, each with owner, expiry and rotation steps; reminders 30 days ahead.
7. **Rollback runbook.** Unpublish the bad release (the `latest` feed then answers with the previous one), then ship a higher patch version; the updater does not downgrade, so already-updated machines need the fix. Rehearsed once on `beta`.
8. **`RELEASING.md`** in final shape.

**Ownership.** Owns `release.yml`, `release-build.mjs`, `scripts/release.mjs`, `scripts/update-lab/`, `docs/release-checklist.md`, `RELEASING.md`. Touches `updates.ts` (tests only).

**Depends on.** Q0, Q2 (whose `verify-hardening` Q7a builds the workflow around), Q3; plan 10's migration and drain behaviour for rows 3, 4, 9 (rows 1, 2, 5-8 and 10 need none of it and run on the first betas); the second Mac; Apple portal access for the spike.

**Acceptance (evidence).** Q7a: the first 0.3.0 candidate tag runs `release.yml` v2 end to end, and rows 1, 2, 5-8 and 10 are filled on two Macs before the owner publishes 0.3.0; rows 3, 4 and 9 follow when plan 10's data side lands (by 0.4.0, Q8). Q7b: matrix rows 1-10 filled with outputs for two consecutive beta releases; the rollback rehearsed on `beta`; the release workflow run end to end on a tag with the draft verified; matching designated requirements across two releases; spike evidence on the second Mac if triggered.

**Estimate.** Q7a 3 days; Q7b 1-2 days; plus 2-3 for the conditional spike, plus second-Mac sessions.

**Work packages.**

| WP | Fan out | Verify adversarially |
|---|---|---|
| Q7.1 Workflow v2 | One agent | Inject failures at each stage (bad signature, notarization rejected, upload fails); no half-published draft may remain |
| Q7.2 Update matrix | One agent per row group scripts what can be scripted | A second person executes the table cold on a clean Mac and records every unclear step |
| Q7.3 Keychain evidence | One agent | Repeat with an ad-hoc build to show the requirement differs and a prompt appears, proving the test can fail |
| Q7.4 Spike (conditional) | One strong-model agent plus the owner at the Apple portal | Launch with Gatekeeper on, in a fresh user account, and offline |

> **What this means:** Releasing becomes a checklist a robot mostly runs, and every way an update can go wrong has been tried on a spare Mac. A bad release has a rehearsed way out.

### Q5B. Website: claims tied to proof

**Goal.** A claim appears on the site only while evidence for it is current.

**Deliverables.**
1. **`apps/web/claims.json`**: one row per factual claim (id, location, evidence, status). Evidence kinds: `test:<path>`, `live:<provider>` with a maximum age, `owner:<dated note>`, `design:<section>`. Examples: `works-with-gmail` needs a live Gmail smoke pass within 14 days plus an owner acceptance note; `updates-in-place` points at update-matrix row 2; `no-server-sees-mail` points at the architecture non-goal.
2. Copy carries `data-claim` ids. **`check-claims.mjs`** fails the production build on a missing, unverified or stale claim; preview builds show a "preview" banner instead.
3. The privacy page, finished in Q5A, is now **protected**: the build fails while any `[...]` placeholder remains, and any change to it after Google's submission needs the owner's sign-off (section 4A rule a). It carries the Limited Use statement (`RC/protocols/proto-google.md` §8.2), contact address, what is stored and what leaves the Mac, diagnostics "never uploaded" (ARCH §11).
4. Screenshots regenerated from demo data by plan 30's harness (the old capture script stalled on PR #21's onboarding window, `DESIGN.md` Appendix C F14).
5. Copy follows the DESIGN voice rules (§10) and banned phrases, including the `Airmail` name and "hold A and say it" (§13 item 16); alt text "airmail envelope" becomes "a striped letter" (§2.5).

**Ownership.** `apps/web/claims.json`, `apps/web/scripts/check-*.mjs`, copy under `apps/web/src`; plan 30 owns styles and the rename.

**Depends on.** Q4 (`provider-status.json`), Q7 (update matrix), plan 20 (live verification), Q0.

**Acceptance.** A seeded unverified claim fails the build; turning a provider's smoke red removes its claim from the next build; a cold read of the live site finds no claim missing from the registry.

**Estimate.** 2 days. **Work package:** one agent builds registry and script; an independent agent reads the built site cold and diffs its claim list against the registry.

> **What this means:** The site can only say what a recent test proves. When a provider breaks, the claim disappears by itself.

### Q8. Release gate and public flip rehearsal

**Goal.** One checklist, run against the 0.4.0 candidate alongside ARCH M10 (soak and fault injection), decides whether to publish and whether to open the code.

**Deliverables.**
1. **Gate checklist** in `docs/`, each line citing evidence: all CI jobs green; M10's seven-day soak and fault-injection results (plan 10); the update matrix run on both Macs; `verify-hardening` clean on the signed artifact; live smoke green for 14 days for every provider the site names; claims verified; Q6's scans, licence and provenance gates clean; decisions C-F recorded; stranger test passed.
2. **Flip runbook** (owner steps, following Q6.9): final scan; delete old Actions runs and artifacts if the existing repo is flipped; rename the private repository to an archive name; create the public repository from the curated tree (decision D); apply the settings checklist (6.6); recreate secrets in protected environments; reconnect Vercel; point `homepage`, `repository` and `site.ts` at the public repo; run one signed tag from the new repository into `aplos-mail-releases` and update from the previous build; publish the draft; announce nowhere until the owner chooses. The releases repository is never renamed or removed.
3. **If a secret is found after the flip,** it is burned: rotate, then clean. The runbook lists each secret's rotation steps.

**Ownership.** The checklist and runbook only. **Depends on.** Everything above; ARCH M10. **Acceptance.** Checklist complete with evidence links and signed by the owner; the flip itself is an owner action (decision F). **Estimate.** 3 days plus owner time.

**Work packages.** One agent assembles the checklist from the other milestones' evidence; a second audits it by hunting for a line whose evidence is missing or older than its allowed age.

> **What this means:** One final gate stops you shipping or going public when a single check is stale or missing.

## 4A. Google OAuth verification and CASA: owner actions and timing

Gmail's scopes (`gmail.modify`, `gmail.settings.basic`) are **restricted**, so leaving Testing mode for strangers needs Google's restricted-scope review and, per the 2026 research, a CASA security assessment every 12 months (`RC/protocols/proto-google.md` §8.2). Plan 20 PV5 owns the engineering and the submission; ARCH Decision 2 owns the Production switch. This plan owns the paperwork the others lean on, so it keeps the one calendar the owner can follow. Lead times are Google's published ones [V] or marked [I]/[S].

| # | Owner action | Needs from this plan | Lead time | When (week) |
|---|---|---|---|---|
| 1 | Answer decision M and point the domain at the site | A live site (Q5A) | An hour to a day | Day 1-2 |
| 2 | Verify the domain in Google Search Console and add it as an authorized domain on the consent screen | Domain, homepage, privacy URL (Q5A) | Minutes once DNS is set | Week 1 |
| 3 | Confirm 6,000 units/min per user in the Cloud console (ARCH M0) | Nothing | 10 minutes | Week 0 |
| 4 | Switch the project from Testing to Production, unverified (ARCH Decision 2): ends the 7-day token expiry, shows the "unverified app" screen, caps new users at 100 | Public privacy page and homepage (Q5A) so the screen is not alarming for the wrong reasons | Instant | Week 1, with 0.2.4 |
| 5 | Consent-screen branding: name, logo (the final composed icon, not the Firefly layers), support and developer contact | Decision I address; the icon asset terms (Q6.1) | A day | Week 1-2 |
| 6 | Brand verification | Items 1, 2, 5 | 2 to 3 business days [V] | Week 2 |
| 7 | Scope justifications, and the unlisted English demo video that shows the client id in the consent URL and each scope in use | Plan 20's scope manifest; a working client after PV3; a shot list from an agent, recorded by the owner (agents never drive visible windows) | A day to write; the video after PV3 | Week 5-6 |
| 8 | Submit the restricted-scope review | Items 4, 6, 7; a signed build; the CASA pack (Q6.8); privacy policy matching the code; **scope freeze** (ARCH ADR-03) | "Several weeks" for Google [V] | Week 6 |
| 9 | Choose a CASA lab; Google assigns the level (AL1 or AL2 in the ADA naming) | The pack, `verify-hardening` output on the exact build, scan reports | [I] 2 to 6 weeks including fixes; [S] about $540 to $1,800 a year at the lower level and about $4,500 at the higher | Week 6-10 |
| 10 | Fix findings; re-test | Engineering time from plans 10 and 20 (budget one to two weeks) | [I] | Week 8-12 |
| 11 | Approval, then put the verified client into the release build and publish the Gmail claim on the site (Q5B) | `claims.json`; live smoke green | Days | Week 10-14 [I] |
| 12 | Yearly renewal reminder | Secrets calendar (Q7b) | Annual | After approval |

**Rules this calendar imposes.** (a) The privacy page, domain and scope list are **frozen** after item 8, because changing the app name, domain or a restricted scope restarts review (`RC/protocols/proto-google.md` §8.2; ARCH ADR-03). (b) The assessed build is a signed beta or 0.3.x build; Q6.8's command regenerates the evidence for it. (c) Until item 11, the public text says Gmail is invite-only (decision N). (d) Nothing in this calendar blocks PV0: Gmail works for the owner in Testing mode today, and the 7-day token expiry is a nuisance until item 4, not a blocker. (e) Elapsed time, not effort, is the constraint: the owner's own work is about two hours spread over the weeks, plus the video.

> **What this means:** Getting Gmail open to strangers takes Google months, and most of that is waiting. The things only you can do are few and early: pick a domain, press the Production switch, and record one short video. This plan makes sure the website and the security paperwork are ready on time so Google is never waiting on you.

## 5. Sequencing against ARCHITECTURE

```
Week:  0     1     2     3     4     5     6     7     8     9     10    11
ARCH:  M0    M1────────M2──────M3──────────────M5─M6────M7────M8─M9────M10
                                      M4──────────┘
Release: 0.2.4 ·· beta.N (Q2, Q7a) ········ 0.3.0 (wk 5-6) ········ 0.4.0 RC (wk 12.5) → 0.4.0 (wk ~14)
Q0-main █      (parallel to PV0; never blocks it)
Q5A-main ██    (site truth + privacy page + domain)
Q1a      █     (E1 freeze window: rename and imports, then format, then codemod)
Q1b       ██
Q0         ███ (verifier, notices, beta.1 to beta.2 update test)
Q2         ██████ (fuses on the first beta; stage 2 after M4)
Q3         ████████████████████ (journeys land as M2..M7 land)
Q4               ████████──── (smoke early on existing adapters; AI evals after M5)
Q6           ██████████████████ (CASA pack first; audits and flip rehearsal late)
Q7a                    ████   (before 0.3.0)
Q7b                          ██
Google (4A)  ·2·4·6············8·········10·····  (domain, Production, brand, video, submit, CASA)
Q5B                                            ████
Q8                                                  ██████
```

1. **The first-week order is in section 4** (the 0.2.4 train merged, `main` into `revamp`, plan 10's rename-and-imports commit, Q1a, the contract skeleton and codemod, Q1b, the `service.ts` split). It is one chain in one window; Q1a is not "first commit on the integration branch" any more, because the move must come first (plan 10 section 9) and the Gmail fix must be merged before the reformat.
2. Q2 and ARCH M1 share their first beta, so the packaged engine and the new fuses are tested together, on the real update path; 0.3.0 carries both.
3. Q3's slots land in week 1 so plans 20 and 30 can attach checks as they write them.
4. Q6's scans start early, when problems are cheap to fix, and run again on the candidate in Q8; its CASA pack comes first because Google's calendar (section 4A) is the longest chain in the whole programme.
5. **If time is cut,** drop in this order, last first: Q5B, the conditional spike, cross-provider conformance, SBOM and attestation, iCloud and Fastmail smoke, the `aplos-app://` change. Never drop Q0, Q1, Q2, Q5A, the secret scan, the CASA pack or the CI self-test.

> **What this means:** The tidy-up goes in one short announced window after the Gmail fix is safely merged, safety and updates are tested on betas before 0.3.0, and the long Google paperwork starts in week 1 so it is never the thing everyone waits for.

## 6. Test strategy

**What counts as evidence.** A command and its output, a CI run, a recorded measurement, a headless screenshot. "Looked fine" never counts. Mocked Google never counts as live acceptance (AGENTS.md); live smoke counts as live for the endpoint, not for the owner's mailbox.

| Layer | Runs | Where | Gate |
|---|---|---|---|
| Format, lint, typecheck, secret and licence scans | Every PR | Linux | Required |
| Unit and policy tests (228 today, about 6 s); SQLite-touching suites under Electron's Node | Every PR | Linux (macOS list) | Required |
| Embedded-SQLite and portability checks | PRs touching engine or contract | macOS | Required |
| Browser E2E on emulators and fixtures | PRs touching app code | Linux | Required |
| Electron E2E on the E2E variant | Merge to `revamp`, nightly | macOS | Required on merge |
| Packaged smoke and `verify-hardening` | Merge, tags | macOS | Required on tags |
| Visual, contrast, identity (plan 30) | UI PRs | Linux or macOS | Required |
| AI replay evals | Every PR | Linux | Required |
| AI live evals | Nightly, `ai` PRs | Linux, protected env | Advisory, then blocking |
| Live provider smoke | Nightly | Linux, protected env | Issue, not a red build |
| Perf and 100k fixture | Nightly | macOS, packaged, shared runner | Fails at 3x the budget; the 10% trend runs on the owner's Mac and at release (`budgets.json`) |
| Update matrix; hand checks (OOPIF keyboard, first-launch prompts) | Per minor release; before M4 | Real Macs | Release gate |

**Rules.**
1. **Headless only.** E2E windows are `show: false`, no Dock icon, temporary data directory, own ports; a test asserts no window is visible. Real-Mac sessions are owner-run or owner-authorized.
2. **Determinism and isolation.** Frozen clock, seeded fixtures, fixed locale, bundled fonts (DESIGN §12.5). No test touches the real data directory, Keychain item or a real mailbox without a named opt-in command.
3. **Data hygiene.** Fixtures are invented; reports and artifacts pass the secret scanner before upload.
4. **Self-test.** The broken-branch fixture (Q3) is re-run when workflows change, so a silently disabled gate is noticed.
5. **Ratchets, not cliffs.** Lint suppressions, bundle size and test time may only shrink or hold.

> **What this means:** Cheap checks run on everything, expensive ones run when it matters, and the ones that need a real Mac are on a list a person can follow.

## 7. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Format commit subtly changes behaviour (JSX whitespace, a moved `@ts-expect-error`) | Low / high | Minified-output equivalence, identical `dist`, tests, packaged `verify-release` (Q1) |
| Format commit collides with open work in other threads, above all the 0.2.4 hotfix on main | High / medium | PV0 and E0 merged into `revamp` first (or day 5); then the freeze window; late branches use `format-merge.mjs`, tested on a synthetic hotfix (Q1a) |
| Q-work delays the Gmail fix | Low / high | Q0-main is a 3-file slice that runs in parallel; PV0 ships to the private draft if Q0-main is late; nothing in Q1-Q8 touches main without the owner |
| Store tests pass under system Node but the app runs Electron's older SQLite | Medium / high | `test:engine` under Electron's Node; floor self-test; `.node-version` equals Electron's embedded Node (Q1b, Q3) |
| Google review stalls on a missing privacy page, domain or evidence | Medium / high | Q5A finishes the page in week 1; domain decision M first; CASA pack built early (section 4A) |
| Secret rotation strands installed copies | Medium / medium | No ritual rotation (ADR 40-11); second secret first if a leak is found |
| Releases repo renamed or deleted after launch | Low / high | Declared permanent (Q0, Q6.9); the flip runbook forbids touching it |
| Perf gate flaky on shared runners | High / medium | 3x CI gate, 10% trend on the owner's Mac and at release (`budgets.json`) |
| Fuses or asar integrity break the packaged engine, helper or update | Medium / high | Shared release with M1; hostile and positive launch matrix; update test on `beta`; fuses are config, reversible in one commit |
| Removing entitlements stops launch on another Mac | Medium / high | Experiment on the second Mac first; keep and document what is needed (Q2) |
| `RELEASES_REPO_TOKEN` leaks or expires | Low / high | Fine-grained, one repo, contents only; calendar reminders; the release job fails loudly |
| Existing 0.2.x installs cannot self-update | High / low | Known; one manual install (Q0 bridge note) |
| macOS runner cost on a private repo | Medium / medium | Linux-first, macOS on merge, tag and nightly (decision H) |
| Google blocks the smoke account, or its token dies every 7 days | Medium / medium | Throwaway account, tiny call count, expiry issue not red build, ARCH Decision 2, manual-run fallback |
| Groq daily limit starved by CI | Medium / medium | Separate key, per-run cap, `inconclusive` on exhaustion |
| AI eval flake turns the PR gate red | High / medium | Replay gates PRs; live is advisory until ten stable nights |
| Public history exposes the Avec analysis, local paths, a second author identity | High / high | Decision D (fresh history); docs split; provenance gate; scrub |
| A secret hides in an Actions log or an old PR ref | Low / high | Scan refs, logs, artifacts; rotate before the first public release |
| GPL blocks a future closed edition | Low / medium | Decisions C and E made knowingly; DCO means later relicensing needs consent |
| Name search finds a conflict | Low / high | Decision J before launch; "Aplos" is unrelated to the "Airmail" marks found |
| CI too heavy for one owner | Medium / medium | Cut order in section 5; one thread owns it (decision L); ratchets and a self-test replace constant attention |
| Actions supply-chain attack | Low / high | Pin actions by SHA, read-only default token, no `pull_request_target`, protected environments |
| E2E variant leaks into release | Low / high | Compile-time define never set in release CI; `verify-hardening` launches the release with a debug switch and requires an exit |
| Adobe Firefly terms restrict icon redistribution | Unknown / medium | Check terms [U]; the public tree carries only the final icon under separate terms |

> **What this means:** The costliest mistakes to undo, a leaked secret or a published history, get the strongest checks. The rest are guarded by cheap automation.

## 8. Interfaces and contracts with the other workstreams

| With | I provide | I need | File protocol |
|---|---|---|---|
| **Plan 10 (engine)** | Q1a inside plan 10's E1 freeze window **after** its rename-and-imports commit and before its codemod and `service.ts` split (plan 10 section 9 order, adopted here); lint boundaries after that; `verify-hardening`; the E2E build variant; the embedded-SQLite check; the packaged-app harness for resident mode (M1), HTML-isolation vectors (M4) and listener refusals (M9); CI slots for OpenAPI golden and portability | Fixture engine and seeded store generator (M1); `Session/get` and the diagnostics bundle (M9); drain-on-update and migration behaviour for update rows 3, 4, 9 | `electron.ts`: plan 10 owns lifecycle and engine host. I add one call to `security.ts` and window `show` handling and never touch lifecycle code. Moves and splits are separate commits. Plan 10's SQLite tests run under Electron's Node (ADR 40-4) |
| **Plan 20 (providers)** | `smoke:live` as a CI runner over plan 20's own live harness (section 5.4; one evidence format), and the `SmokeProbe` interface; the domain, privacy page, Limited Use text and the Google calendar of section 4A; the quota-emulator CI journey; privacy policy and CASA evidence pack; `provider-status.json` | Gmail quota emulator, IMAP fixture, Graph and JMAP fakes (M3); adapters callable read-only; `APLOS_*` OAuth env names and the Production switch; the CASA submission | `scripts/emulation/` and provider files are plan 20's. `scripts/smoke/` is mine and calls adapters only through their public interface |
| **Plan 30 (UI)** | Prettier, ESLint, stylelint and the `tools/lint/` extension point; one Playwright base; CI slots for `check:tokens`, `check:contrast`, `check:identity`, `test:visual`, `test:perf`; journeys J1-J3; the production CSP and Vite plugin; website copy and claims | Design lint plugins; the harness and baselines; a renderer free of inline script for CSP stage 2; the `PostEdge` rename; a headless way to seed or drive onboarding | `apps/web`: I edit copy, data and scripts; plan 30 edits styles, `Chrome.tsx`, tokens. Copy-only commits land first and plan 30 rebases. `index.html`: CSP is mine, structure theirs |
| **All** | `npm run check` as definition of done; `.git-blame-ignore-revs`; Dependabot; no merge with a red required check | Each plan modernizes the dense files it rewrites; none reintroduces one-line multi-statement code | I own tooling devDependencies in the root `package.json`; others ask by PR. Lockfile conflicts are resolved by re-running `npm install`, never by hand |

**Dates.** Plan 10 delivers the fixture engine by the end of week 2; plan 20 the Gmail quota emulator by week 5 (M3); plan 30 its harness skeleton at its stage 2. A late dependency leaves its journey visible as pending in CI output, never silently skipped.

> **What this means:** Each plan owns its own files and hands over small, named pieces at agreed times. Shared files have written rules, so threads do not trip over each other.

## 9. PR and branch strategy within the revamp

1. **Integration branch.** `revamp`. Nothing goes to `main` without the owner's explicit go-ahead. Pull requests target `revamp`.
2. **Branches.** Git cannot hold `revamp/...` refs next to the `revamp` branch, so work branches are `rv/<workstream>/<slug>` (`plans/00-roadmap.md` §4). This plan's items run on the Engine thread as `rv/engine/q1a-format`, `rv/engine/q0-releases`, `rv/engine/q2-hardening`, …, and the website items on the UI thread as `rv/ui/q5b-claims`; main-bound slices use `hotfix/0.2.4-<slug>` and join `hotfix/0.2.4`. One branch per milestone or work package, each in its own T3 worktree; no branch name is a folder of another. Commits are authored as Kainoa Newton; `git config user.email` is checked before each commit and any other value is reported, not committed.
3. **Mechanical commits** are separate pull requests with nothing else in them, merged by **merge commit or fast-forward, never squash**, so the SHA in `.git-blame-ignore-revs` survives (plan 10's squash rule applies to its feature PRs, not to these). Order inside plan 10's freeze window: main merged, its rename-and-imports commit, Q1a, the contract skeleton and its codemod, then Q1b.
4. **Workflow changes.** Pull requests to `revamp` run `ci.yml` from the PR. `release.yml` runs only on tags, so changes to it are rehearsed in a private sandbox repository with dummy secrets and ad-hoc signing. A real signed tag run happens only on the owner's go-ahead.
5. **Main touches and beta tags.** The only things authored against main, each on the owner's say-so: the 0.2.4 train (PV0, with E0, the `srcdoc` stopgap, **Q0-main** and **Q5A-main** joining only if ready). Everything else lands on `revamp` and reaches main only when the owner merges `revamp` for 0.3.0 and 0.4.0. **Stable releases are always tagged from main** (RELEASING.md). **Beta tags** (`vX.Y.Z-beta.N`) are the one exception: they may be cut from `revamp` with `scripts/release.mjs --allow-branch` and published as prereleases to the releases repository, on the owner's go-ahead per tag, because Q2 and Q7a cannot be tested without them. They never touch `releases/latest`.
6. **Review and models.** Security-sensitive work (Q2, Q4 credentials, Q6 scans, the Q7 spike) uses a strong model to author and a separate strong-model reviewer who has not seen the author's reasoning. Mechanical work (the format commit, configs, generated notices, copy) can use a cheaper model, always followed by the independent equivalence checks. Each PR attaches its evidence (command output, run links, headless screenshots) and lists what it did not verify. Do not re-trigger an external review after every fix; batch fixes and verify locally first (owner preference).
7. **Owner-only actions.** An agent never changes repository visibility, publishes a draft release, or rotates a production credential.
8. **End state.** The owner decides how `revamp` reaches `main`, or whether the curated public repository (decision D) becomes the new home. Either way the releases repository stays the feed (Q6.9).

> **What this means:** Everything lands on `revamp` in small reviewed pieces with proof attached. The risky buttons stay yours.

## 10. What to read first

In this order:
1. `AGENTS.md` and `plans/_council/CONTEXT.md` (owner rules, headless-only, no keys, verified facts).
2. `plans/ARCHITECTURE.md`: §2.5-2.6 (hardening, A1 and Keychain), §3.1 (SQLite check), §6.1 (retries off), §8.3-8.5 (consent, training, injection), §10 (HTML isolation, CSP), §11-12 (diagnostics, security), §14 (open-source readiness), §15 (M0, M1, M10), Decisions 11-12.
3. `plans/DESIGN.md`: §2.5 (renames), §12 (enforcement), §13 (Avec-derived items), §15, Appendix C.
4. Research: `RC/gaps/storage-engine-benchmark.md` (§0, §7: which SQLite each runtime uses), `RC/gaps/macos-daemon-lifecycle.md` (§0, §3, §4, §9), `RC/gaps/electron-email-html-isolation.md` (§0, §7, §8), `RC/protocols/proto-google.md` (§8, §9), `RC/gaps/identity-collision-audit.md` (§0, §3, §8), `research/inbox-zero/SYNTHESIS.md` (weaknesses 6 and 10) and `aplos-architecture.md` (§4-6), `research/pr21-onboarding-review.md`.
5. Code: `.github/workflows/{ci,release}.yml`, `RELEASING.md`, `apps/desktop/package.json` (`build`), `build/entitlements.mac.plist`, `index.html`, `src/main/{electron,updates}.ts`, `scripts/{release-build,verify-release,build-main,fake-update-feed}.*`, `scripts/emulation/`, `scripts/quality/cases.ts`, `tests/{updates,portability,emulation}.test.ts`, `apps/web/src/{release,Landing,Download,Privacy,site}.ts*`, `VISION.md`, `DECISIONS.md:61`, `TODO.md`.

> **What this means:** Start with the rules, then the decisions, then the evidence, then the code.

## External prerequisites (owner actions, not decisions)

- **Create the public releases repository** and a fine-grained token, stored as `RELEASES_REPO_TOKEN` (Q0). About 30 minutes.
- **Second Mac time** for the first-launch, entitlement and update tests (Q0, Q2, Q7). Agents SSH there only when you ask.
- **Test accounts and keys** (decision G): a throwaway Gmail account (one loopback sign-in), a separate Groq key, later iCloud and Fastmail test accounts, all as GitHub environment secrets.
- **Google (the calendar in section 4A):** a domain and DNS (decision M); Search Console domain verification; the Production switch (ARCH Decision 2); confirm 6,000 units per minute; consent-screen branding; brand verification; the unlisted demo video; the restricted-scope submission; choosing and paying a CASA lab; a yearly renewal. About two hours of your own time, spread over weeks, plus the video.
- **A contact address** (decision I) and a **name search** (decision J).
- **Apple portal:** a Developer ID provisioning profile with Keychain Sharing, only if the Q7 spike triggers.
- **GitHub plan check:** CI minutes included (decision H).
- **Buttons only you press:** publish a release draft, tag a beta, flip repository visibility, move secrets into protected environments, submit Google's review, and (only if a leak is found) retire a Google client secret.

> **What this means:** These are accounts, forms and clicks only you can do. The plan schedules around them; the releases repository and the domain are the two that matter in the first week.

## Evidence index

- Research: `research/email-clients/gaps/{macos-daemon-lifecycle,electron-email-html-isolation,identity-collision-audit}.md`; `protocols/proto-google.md` (§1, §8, §9); `SYNTH-architecture.md` (§10, §12); `research/inbox-zero/{SYNTHESIS,aplos-architecture}.md`; `research/pr21-onboarding-review.md`.
- Plans: `plans/{ARCHITECTURE,DESIGN}.md`, `plans/_council/{CONTEXT,task-plan-40-platform-quality}.md`; plan 10 sections 4 (E1), 7.3, 9; plan 20 PV0, PV5, sections 5.4, 7, 9; plan 30 sections 8.3, 10.
- Main at `72095ff` (read-only, for the critique pass): `package.json`, `apps/desktop/package.json` (`build`), `.github/workflows/{ci,release}.yml`, `RELEASING.md`, `scripts/release.mjs`, `apps/desktop/scripts/release-build.mjs`, `apps/web/vercel.json`; `RC/gaps/storage-engine-benchmark.md` §0.
- Repository at `27cf52f`: the workflows, `RELEASING.md`, `apps/desktop/{package.json,index.html,build/entitlements.mac.plist}`, `src/main/{electron,updates}.ts`, `scripts/*`, `apps/web/src/*`, `SPEC.md`, `DECISIONS.md`, `PROGRESS.md`, `TODO.md`, `node_modules/app-builder-lib/scheme.json`, `electron-updater/out/AppUpdater.js`.
- Commands run on 2026-10-27, read-only on the repository: `electron-fuses read`, `PlistBuddy`, `codesign -dv`, an Electron-embedded SQLite probe, `npm test`, `npm ls`/`npm audit`, key-shape `grep -E` over `git log --all -p`, a line-length scan. No credential was read, printed or written.

