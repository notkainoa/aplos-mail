# Plan 40: Platform, security, distribution and quality

Workstream plan, 2026-10-27, branch `revamp`, aligned the same day with the master roadmap `plans/00-roadmap.md`, which is the source of truth for sequencing. Planning only: nothing here is implemented or goes to main, and PR #21 stays unmerged. It serves `plans/ARCHITECTURE.md` and `plans/DESIGN.md` (binding) and sits beside plans 10 (engine), 20 (providers and sync) and 30 (UI). Where this plan and the roadmap disagree, the roadmap wins.

**Conventions.** `RC/` means `research/email-clients/`. Evidence labels: **[V]** verified by a research report or by me on 2026-10-27 (section 2); **[I]** inference; **[U]** unverified, to check live. Where research conflicts with `plans/_council/CONTEXT.md`, CONTEXT wins (Developer ID signed and notarized, team VW9NDM428H; no provisioning profiles; private repo until the owner decides; Google in Testing mode). Milestones here are **Q0 to Q8**, kept as citation names; the roadmap re-cuts them into lanes (next section). ARCHITECTURE's are **M0 to M10**. Days are the roadmap's calendar days, and day 1 is the day the owner says go. Owner decisions here are lettered **A to N**; ARCHITECTURE's are always "ARCH Decision n".

## In plain English

This plan covers tests, safety settings, releases and the website. One thread runs it, in three lanes.

Today only you can reach the download link, since the code is private. Electron, the toolkit Aplos uses, has its safety switches at their defaults. The installer claims macOS 12 support but needs macOS 13. The website lists Windows and Linux downloads that do not exist and says Outlook works when it cannot sign in yet.

On day 1, one commit reformats every file, and a script proves nothing changed. Then come lint rules and a test robot that opens the app on fake accounts. The safety switches get tightened and a script checks them. Releases stay in this one repository as drafts you install by hand. If you make it public later, installed copies start updating themselves. The website drops every claim not yet proven, and its privacy page goes on aplos.email.

Nothing costs money. GitHub test runs use free Linux minutes. Mac runs happen on request. Live checks run on this Mac against your spare Gmail account. Google stays in Testing mode.

Five questions below have defaults, so you can stay silent. You publish drafts, tag betas and decide about going public.

## Lanes and phases

The roadmap gives the Platform and website thread three lanes: `plat-ci`, `plat-release` and `web`. Phase 0 is days 1-3, Phase 1 days 4-13, Phase 2 days 11-18 and Phase 3 days 18-25. Each Q milestone below belongs to one lane.

| Milestone | Lane | Phase | Days | Content |
|---|---|---|---|---|
| Q1a | `plat-ci` | 0 | 1 (restructure chain step 2) | Prettier format commit over the moved tree, proved by identical minified output |
| Q1b | `plat-ci` | 0 | 1 (step 4); owners check by day 3 | ESLint, stylelint, suppressions, boundaries, hook, `static` job, `owners-check.mjs` |
| Q3 | `plat-ci` | 0, 1, 2 | Slots 1-3; jobs 4-12; emulator journeys 12-16 with the Integrator | CI jobs, Playwright base, journeys, budget register |
| Q4 | `plat-ci` | 1, 2 | 4-12; live runs 12-16 | Policy tests, AI replay evals, live-smoke runner on the agent test account |
| Q0 | `plat-release` | 1 | 4-8 | Draft releases in this repo, draft verifier, notices, local signed feed for update tests |
| Q2 | `plat-release` | 1, 2 | 4-14; CSP stage 2 about 12-16 | Fuses, macOS 13, entitlements, security guard, CSP, `verify-hardening` |
| Q7a | `plat-release` | 1 | 8-14 | Release workflow v2 and the update matrix |
| Q7b | `plat-release` | 2 | 12-16 | Rollback, secrets calendar, Keychain evidence, conditional spike |
| Q8 | `plat-release` | 2, 3 | Release gate 15-18; flip checklist in Phase 3, optional | Release gate for the release candidate; checklist for a later public flip |
| Q6 | `plat-release` | 3 | 18-25 | Secret and history scan, provenance, notices, licence drafts, contributor docs |
| Q5A | `web` | 1 | 2-5 | Website truthfulness pass, privacy page on aplos.email, restyle |
| Q5B | `web` | 1, 2 | 5-8; claim rows fill in as live checks pass, 12-16 | Claims registry that fails the build on an unproven claim |

Removed by the owner's answers of 2026-10-27: Q0-main and Q5A-main (no 0.2.4), the releases repository and its token, the Google review calendar (old section 4A), the CASA pack (old Q6.8), the paid name search and `format-merge.mjs`. Added: `owners-check.mjs` (Q1b).

## Decisions for you

Silence means the default. The owner's answers of 2026-10-27 settled or voided nine of the original fourteen questions (B, D, F, G, H, J, L, M, N, with D left to flip time). Five remain open with defaults: A, C, E, I and K.

**A. Reformat every file in one commit during Phase 0?** Yes, on day 1 as step 2 of the restructure chain, right after the engine files move; or no, tidy files only as they change. **Default is yes** (roadmap decision 52). One big diff changes no behaviour, and checks prove it. Later changes become readable. No keeps dense and tidy code mixed for months.

**B. Where do downloads and updates come from?** (Architecture decision 11.) **Answered 2026-10-27: this repository.** There is no releases repository. While you build, you use local builds or private draft releases and install them by hand. When the redesign is ready, the main repository goes public at your call, after a secret and history scan and a LICENSE file. The updater keeps pointing at this same repository, so builds installed from drafts start updating themselves once it is public.

**C. Which licence when Aplos goes open source?** (Architecture decision 12.) GPL-3.0 for the app and engine with MIT for `packages/contract`; MIT or Apache-2.0 everywhere; or AGPL-3.0. **Default is the first** (roadmap decision 53). Copies of the app stay open, and tools built on the contract can be anything. Your name and icon stay yours. Today `package.json` says MIT but no LICENSE file exists, so the plan sets "UNLICENSED" and keeps drafts of the chosen licence files aside until you answer.

**D. When the code goes public, which history?** **Answered 2026-10-27, in part: one repository, so no second public repository.** Which history goes public is decided at flip time, with the scan report in front of you: flip this repository as is after the scan, or rewrite its history in place first. Today's history openly describes analysing a competitor's installed app, 37 commits carry a different author name and email, and `plans/` and `research/` sit in the tree. Flipping as is keeps blame and old pull requests but publishes all of that. There is no default.

**E. How do contributors agree to your licence?** A sign-off on each commit (the "DCO"); or a signed agreement (a "CLA"). **Default is the sign-off** (roadmap decision 55). It is low friction, but you cannot relicense others' code later without asking. A CLA allows relicensing but deters casual contributors and needs a bot. This matters only after the repository is public.

**F. When does the code go public?** **Answered 2026-10-27: when the redesigned version is ready, at your call, in this repository.** Not before the secret and history scan and a LICENSE file.

**G. May the test robot use test accounts and keys?** **Answered 2026-10-27: the agent test account.** Your spare Gmail account, approved for full reading and AI by agents, under the rules in the roadmap's "Decisions already made" (send only to itself, nothing permanent), and a separate free Groq key (created 2026-10-27, kept in this Mac's Keychain as `aplos-groq-test`); iCloud and Fastmail test accounts in round 2. Live checks run on this Mac at scheduled times by default (roadmap N4), so no Google token sits on GitHub. Your main mailbox is used only in hand checks you run yourself.

**H. How much may cloud testing (CI) cost?** **Answered 2026-10-27: nothing.** GitHub Actions stays inside the free minutes. Linux jobs run on pushes to `revamp`, and Mac jobs run on demand. A Mac minute bills as 10 Linux minutes on private repositories, so one 20-minute Mac run uses about 200 included minutes [U: check the account's allowance under Settings, Billing]. Lanes run their checks locally first.

**I. Which address may be published for security reports and privacy questions?** A free forwarding address on aplos.email plus GitHub private reporting once the repository is public; or your personal address. **Default is the forwarding address** (roadmap decision 58). It keeps your personal inbox out of the public record. Your personal address is faster but permanent.

**J. Should "Aplos Mail" get a professional name search before going public?** **Answered 2026-10-27: no, it costs money.** The audit found marks near "Airmail", not "Aplos", but never searched "Aplos Mail". Looking the name up in free trademark databases before going public is optional and yours.

**K. Should the website drop every claim not yet proven?** Yes, with no Windows or Linux, no Outlook and no other provider until it passes a live check, and Gmail described as available to invited testers; or keep the optimistic copy until launch. **Default is yes** (roadmap decision 60). The site then matches reality. The optimistic copy is false today.

**L. Should quality and platform run as its own T3 thread?** **Moot: replaced by roadmap decision N1.** Platform and website is one of six threads, with three lanes: `plat-ci`, `plat-release` and `web`.

**M. Which domain hosts the website and privacy page?** **Answered 2026-10-27: aplos.email,** already owned and already `apps/web` on Vercel. The privacy page goes there. You check Vercel's production branch on days 1-3.

**N. May strangers download 0.2.4?** **Moot: there is no 0.2.4.** The Gmail fix is part of the rebuild. Gmail works for up to 100 test users you list and asks them to reconnect every 7 days. Other accounts (iCloud, Fastmail, Outlook) arrive in round 2; until then the site names only Gmail and Google Calendar.

## 1. Scope and non-goals

**In scope** (per `plans/_council/task-plan-40-platform-quality.md`, as cut down by the roadmap): Electron hardening (fuses, CSP, entitlements, macOS 13); Keychain evidence and provisioning profiles (a spike only if triggered); release engineering from this one repository (draft releases, verifier, update testing, rollback); open-source readiness (licence drafts, secret-history audit, provenance, CONTRIBUTING, public docs), prepared in Phase 3 for the owner's later call; CI inside free minutes (formatter and linter adoption in one mechanical commit, the owners check, emulator E2E, AI evals, live-provider smoke on the agent test account); modernization of the dense one-line files; the website truthfulness pass and restyle; performance budgets (the register in Q3).

**Non-goals.**
- No engine, store, contract, provider or renderer feature work (plans 10, 20, 30).
- No design decisions. This plan wires CI slots for DESIGN §12 (lint, contrast, visual, perf); plan 30 writes those checks.
- No Windows, Linux or iOS builds (ARCH §17); no App Store build.
- No telemetry, crash upload or remote kill switch; support uses the user-exported diagnostics bundle (ARCH §11).
- Nothing that costs money: no Google restricted-scope review, no CASA assessment, no paid name search, no paid services, no new domains, and no CI beyond GitHub's free minutes. Opening Gmail beyond the 100 listed test users is "later, if ever" (section 4A). This plan still supplies the privacy page on aplos.email, the site and the no-telemetry evidence such a review would need.
- No merge to main, no visibility change, no release publishing by an agent. No releases repository.

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
| 19 | `scripts/release.mjs` refuses any branch but `main` unless `--allow-branch`; `release.yml` runs typecheck, tests and the build only (no hardening, SBOM or draft check); `ci.yml` has one macOS job; `apps/web` deploys from git through Vercel (`vercel.json`, `ignoreCommand`), so the live site follows whichever branch Vercel is set to publish [U: which] | read of `scripts/release.mjs`, `.github/workflows/*`, `apps/web/vercel.json` on main |
| 20 | Release builds inline the Google client id **and secret** into `dist/main/engine.cjs` (RELEASING.md), and `release.yml` uploads the DMGs and ZIPs as Actions artifacts with the run. Anyone who downloads a DMG can extract them; no key was found in git (fact 9) | `RELEASING.md`; `release.yml` |
| 21 | Playwright's Electron driver attaches through Node's inspector, so it needs the `EnableNodeCliInspectArguments` fuse **on**; an E2E build cannot carry the release fuses | Playwright Electron docs [U: re-check on the pinned version in Q3] |

> **What this means:** The starting point is better than expected on secrets and dependency licences, and worse on safety switches, website honesty, and the paper trail in the project docs.

## 3. Decisions taken in this plan

| ADR | Question | Choice and reason |
|---|---|---|
| 40-1 | Formatter and linters | Prettier for formatting; ESLint 9 flat config with typescript-eslint for all JS/TS lint, including the DESIGN §12.2 custom rules; stylelint for CSS. Biome is rejected: it cannot host those plugins, so it would be a fourth tool, not a replacement |
| 40-2 | Proving the format commit is safe | Minified output of every file must match before and after, `dist/` must be byte-identical, tests must pass. A formatter changes no syntax tree, so this is checkable |
| 40-3 | Existing lint violations | ESLint bulk suppressions (ESLint 9.24 and later): old violations recorded, new ones fail |
| 40-4 | CI platforms and SQLite | GitHub Actions stays inside free minutes (decision H). Linux jobs (static, unit, browser E2E) run on pushes to `revamp`; macOS jobs (Electron, packaging, signing) run on demand and on the release candidate. Lanes run their checks locally first, and the Integrator runs the full suite before each merge. [U] Some tests may need macOS; the first CI run finds them. **Any test that opens `node:sqlite` runs under Electron's own Node** (`ELECTRON_RUN_AS_NODE=1`, which needs no display, so Linux can do it): `node:sqlite` follows the host runtime's SQLite, and system Node differs from Electron's (fact 6) |
| 40-5 | Release home | Build and publish draft releases in this one repository (decision B), with `GITHUB_TOKEN` granted `contents: write` in the release job only. While the repository is private, only the owner sees drafts and installs them by hand. After the owner makes it public, the same repository is the update feed. No second repository and no extra token. Local builds on the owner's Mac are the default; the tagged workflow runs on the owner's go-ahead |
| 40-6 | Debug access in shipped builds | Release builds refuse Chromium debugging switches; E2E runs use a separate **unfused, unsigned, never-uploaded** build variant, because Playwright needs the inspector fuse on (fact 21). With `RunAsNode` off, a debugging port is the remaining way to use Aplos's Keychain trust as a puppet |
| 40-7 | AI evals and live checks | Replay runs offline in every lane's checks and on pushes to `revamp`; live evals are advisory, then required after ten stable nights; live provider checks are read-only (tier R), run on this Mac at scheduled times on the agent test account only (decision G), and never send (AGENTS.md) |
| 40-8 | Website claims | A machine-readable registry; the production build fails on an unproven claim |
| 40-9 | Public repo shape | One repository (decision B). Before the owner makes it public, `plans/`, `research/` and the provenance docs either leave the tree together with an in-place history rewrite, or are published knowingly (decision D, at flip time). A curated `docs/` and the ADRs are published either way. Licence drafts wait aside until decision C |
| 40-10 | Work that must reach main | None. There is no 0.2.4 train, no `hotfix/*` branch and no main-bound slice. Everything lands on `revamp` and reaches main when the owner merges it for the one redesigned release (proposed 0.3.0). The format commit runs once, in Phase 0, so no format-aware merge helper is needed |
| 40-11 | The bundled Google client secret | It ships inside every DMG, so it is not a secret in the usual sense (fact 20; `RC/protocols/proto-google.md` §8.1). It is **not rotated by default**: rotation protects nothing, and disabling the old secret would strand every installed copy. Rotate only on evidence of a leak, and then add a second secret first (section Q6.9) |
| 40-12 | Performance budgets | One register, `budgets.json`, lists every budget with its owner, the environment it is measured in and its gate type. Shared-runner gates use a 3x margin (plan 10 section 5); the strict 10% trend check of DESIGN §12.6 runs against owner-Mac history and release measurements, not noisy shared runners |
| 40-13 | Cost | Nothing in this plan costs money (owner, 2026-10-27): no Google restricted-scope review or CASA, no paid name search, no new domains, no paid CI minutes or runners, no paid hosting. Anything that would cost money is posted as BLOCKED-ON, never bought |

> **What this means:** These choices favour checks a machine can run over promises a person must remember.

## 4. Milestones

Order of work, with effort in focused working days of an agent workflow plus owner time. The total is about **35 to 47 days** of agent work [I]. It fits the roadmap's calendar because the three lanes run in parallel and each lane runs several workflows at once. Owner time is small. The scarce resources are the owner's review time and the second Mac.

| Milestone | Theme | Lane | Estimate | When (roadmap days) |
|---|---|---|---|---|
| Q1a | The mechanical format commit | `plat-ci` | 0.5-1 day | Day 1, step 2 of the restructure chain |
| Q1b | Lint, boundaries, hook, owners check, `static` job | `plat-ci` | 2-2.5 days | Day 1, step 4; owners check by day 3 |
| Q3 | CI foundation, emulator E2E, budget register | `plat-ci` | 8-10 days | Slots 1-3; jobs 4-12; emulator journeys 12-16 |
| Q4 | AI evals and live-provider smoke | `plat-ci` | 5-7 days | 4-12; live runs 12-16 |
| Q0 | Draft releases, verifier, notices, local update feed | `plat-release` | 1.5-2.5 days | 4-8 |
| Q2 | Electron hardening | `plat-release` | 3-5 days | 4-14; CSP stage 2 about 12-16 |
| Q7a | Release workflow v2 and the update matrix | `plat-release` | 3 days | 8-14, before the release candidate |
| Q7b | Rollback, secrets calendar, Keychain evidence, spike (conditional) | `plat-release` | 1-2 days (+2-3 spike) | 12-16 |
| Q8 | Release gate; optional flip checklist | `plat-release` | 2-3 days | Gate 15-18; checklist in Phase 3 |
| Q6 | Open-source readiness | `plat-release` | 5-6 days + owner | 18-25 |
| Q5A | Website: stop the false claims, privacy page, restyle | `web` | 2-3 days | 2-5 |
| Q5B | Website: claims tied to proof | `web` | 2 days | 5-8; claims fill in 12-16 |

**Order rule for Phase 0.** The roadmap's restructure chain (roadmap section 1.1) is one serial chain on day 1: (1) the Engine thread's rename-and-imports commit, with today's code moved into `legacy/` folders; (2) Q1a; (3) the Engine thread's split of `electron.ts` into owned modules, which creates `security.ts` and `updater.ts` for `plat-release`; (4) Q1b. Nothing else touches existing files while the chain runs. `plat-ci` prepares Q1a and Q1b in its own worktree and lands them in their slots, and the other threads write new files only. Q1a waits for nothing else: main does not change, so there is no earlier train to merge first.

> **What this means:** The work is cut into small pieces and three lanes. The tidy-up goes first, in a fixed order on day 1, so it never steps on the engine move. Each piece below ends with its own plain summary.

---


### Q1. Tooling baseline and the mechanical format commit (Q1a and Q1b)

**Goal.** One formatter, one linter set and one pre-commit habit, so no later diff is dense and every lane starts on formatted code. Q1 is split in two because the two halves have different constraints: Q1a must be a pure, provable rewrite of the moved tree, landing in its slot of the restructure chain; Q1b contains config whose paths (ESLint suppressions are keyed by file path) must be generated **after** the files have reached their final locations.

**The restructure chain, in order** (roadmap section 1.1 owns the chain and its announcement; this plan agrees to its order and writes the handoff from this side):

| Step | Who | What | Why in this place |
|---|---|---|---|
| 0 | Engine | NOTICE in `plans/STATUS.md`: restructure started | Every other thread holds off existing files |
| 1 | Engine | `git mv apps/desktop/src/engine packages/engine/src` with today's engine files under `legacy/` folders, import-specifier edits only, workspaces and aliases; `npm run package` and `verify-release.mjs` pass | A rename with nothing but import lines keeps `git log --follow` and blame intact and every commit launchable |
| 2 | **Q1a** | The format commit over the **post-move** tree | One reformat of final paths; the blame-ignore SHA is taken after the move |
| 3 | Engine | Split `electron.ts` into `windows.ts`, `lifecycle.ts`, `protocol.ts`, `menu-bar.ts`, `native-methods.ts`, `security.ts`, `updater.ts` and `engine-host.ts`; code moves only | Reviewed on formatted code; gives `plat-release` its files |
| 4 | **Q1b** | ESLint, stylelint, suppressions, hook, CI `static`, owners check | The suppression file is generated on final paths |

Q1a does not care whether step 1 happened: its globs include both `apps/*/src` and `packages/*/src`, and its equivalence script maps renamed paths with `git diff -M --name-status`. If the Engine thread ever swaps steps 1 and 2, nothing in Q1a changes, so the ordering is a preference, not a dependency. What must never happen is Q1b before the move, or Q1a after other lanes have started editing existing files. There is no typed-client codemod over today's 53 `invoke(` sites and no `service.ts` split in the revamp (roadmap section 10), so nothing else rewrites the formatted files before the lanes start.


**Q1a deliverables.**
1. `.prettierrc` (single quotes, semicolons, `printWidth` 100, `trailingComma: all`, `arrowParens: avoid` to match the existing `x=>` style) and `.prettierignore` (generated files, `dist`, `release`, `node_modules`, `research`, `plans`, lockfile, Markdown).
2. The **format commit**: `prettier --write` over `apps/*/src`, `apps/*/scripts`, `apps/desktop/tests`, `packages/*/src`, `packages/*/tests`, `scripts` and root configs. Authored as Kainoa Newton, prefixed `[mechanical]`, containing nothing else. Prettier is pinned exactly (no caret) so the check cannot drift.
3. `.git-blame-ignore-revs` naming that commit (added in the next commit, since a commit cannot name itself), mentioned in CONTRIBUTING.
4. **`scripts/audit/format-equivalence.mjs`**, which runs the checks of the acceptance list (minified-output equivalence following renames, the comment-token multiset, byte-identical `dist/`) so the proof is one command. It is written before the commit and rerun by a second agent.

**Q1b deliverables.**
5. `eslint.config.mjs` (flat): typescript-eslint recommended, `react-hooks`, `max-lines` 800 and `complexity` 25 as errors for new code, and boundary rules (below). `eslint-suppressions.json` records existing violations; it is generated once, after step 2, and carries a note that `git mv` of a file invalidates its entries.
6. `stylelint.config.mjs` (standard config) with an extension point, `tools/lint/`, where plan 30 adds the DESIGN §12.2 plugins.
7. Boundary rules: no `electron` or `node:` imports in `packages/engine` core (ARCH §2.6; the Engine thread ships the same rule as a test first, and the lint rule replaces it) and none in `packages/contract` beyond zod; the renderer may not import `src/main` or `packages/engine`; `legacy/` folders may be imported only by other legacy code (roadmap section 1.1); `dangerouslySetInnerHTML` is an error except in the mail-frame component (ARCH §10); no `eval`, `new Function` or `child_process` in the renderer.
8. Root scripts `format`, `format:check`, `lint`, and `check` (format check, lint, owners check, typecheck, unit tests including the SQLite-sensitive suite under Electron's Node per ADR 40-4: the **definition of done for any agent change**); `prepare` installs a plain git hook (`scripts/hooks/pre-commit`: Prettier check and ESLint on staged files, a few seconds; it sets `core.hooksPath` so it also works in T3 worktrees).
9. CI `static` job (Linux, on pushes to `revamp`); Dependabot for npm and Actions (weekly, grouped, `target-branch: revamp`); `.node-version` set to the exact Node that Electron 44.7.2 embeds (24.21.0, fact 6) and `engines` matching, so CI's Node and Electron's Node agree on language features; `npm audit --omit=dev --audit-level=high` as a failure.
10. `AGENTS.md` additions: run `npm run check` before every commit; no multi-statement one-liners; new files use named exports and small functions; whoever touches a dense function tidies it.
11. **`scripts/audit/owners-check.mjs`** (artifact F10, built with the Integrator). It reads `plans/OWNERS.md` and fails a change that touches paths outside its lane unless the owning lane approved it (a `lane-approved:<lane>` label or commit trailer that the Integrator checks [I]). It runs in the `static` job and in `npm run check`.

**Ownership.** Owns root and `apps/*/` tool configs, `tools/lint/` (except `design/`, which UI-core owns), `scripts/hooks/`, `scripts/audit/format-equivalence.mjs` and `owners-check.mjs`, `.github/dependabot.yml`, and the style of `apps/desktop/scripts/*`, `apps/desktop/tests/*`. Touches every file once, in the mechanical commit. **Afterwards the dense files in `packages/engine` belong to plan 10, provider files to plan 20, and `src/renderer` to plan 30**; each modernizes what it rewrites, and this plan does not.

**Depends on.** Decision A; the Engine thread's rename-and-imports commit (step 1) for Q1b only. Q1a blocks the `electron.ts` split (step 3) and every lane that edits existing files.

**Acceptance (evidence).**
- `npm run check` is green on the commit after the format commit.
- **Equivalence:** a script runs `esbuild --minify` on the before and after blob of every changed `.ts/.tsx/.mjs/.cjs` file (following renames) and prints zero differences; any difference is listed and explained. Comments are invisible to a minifier, so a second check compares the comment tokens of each file before and after as a multiset.
- **Byte-identical build:** before and after yield identical `dist/main/*.cjs` and identical hashed `dist/renderer/assets/*` names, built with sourcemaps off (a sourcemap embeds line numbers and would differ by design). [U] If a bundle embeds a line number or `Error().stack` text, list the difference and explain it.
- 228 tests and the packaged `verify:release` pass.
- `git blame --ignore-revs-file` on a sampled dense line still names the original author, including a line in a moved engine file.
- A deliberate violation on a scratch branch (a banned import, an unformatted file) fails CI; a committed suppression does not.
- `owners-check` fails a scratch change that touches another lane's path and passes it once the owning lane's approval is recorded.

**Estimate.** Q1a 0.5-1 day, Q1b 2-2.5 days.

**Work packages.**

| WP | Fan out | Verify adversarially |
|---|---|---|
| Q1a.1 The format commit and proof script | One agent, on a clean tree, in the chain's slot on day 1 | A separate agent runs the equivalence script, the comment check and the build comparison without reading the first agent's report |
| Q1b.1 Config and boundaries | One agent | A second agent writes ten violating snippets (one per rule, plus a tricky one such as dynamic `import('electron')`) and shows each is rejected |
| Q1b.2 Suppressions and CI | One agent | A third agent checks that a fresh violation fails and the job fits in 3 minutes |
| Q1b.3 Hygiene | One agent | A seeded high-severity fixture on a scratch branch must fail `npm audit` |
| Q1b.4 Owners check | One agent with the Integrator | A scratch change that touches another lane's path must fail; the same change with approval must pass |

> **What this means:** One careful tidy-up, proven not to change behaviour, makes every later review easier. It happens on day 1, right after the engine files move and before any lane starts, so no work is lost. After it, the robot refuses new messes and edits outside a lane.

### Q0. Release basics: drafts in this repository, verifier, notices, local update feed

**Goal.** The owner and invited testers can install a signed, notarized Aplos build from a draft release in this repository, proven on a Mac that has never run Aplos, and an update from one signed build to the next works in place. There is no separate releases repository and no public feed until the owner makes the repository public. No 0.2.4 ships: the Gmail fix is part of the rebuild.

**How releases work while the repository is private** (the facts: `build.publish` is baked into each build's `app-update.yml` and already points at this repository; `release.yml` uploads a draft with `GITHUB_TOKEN`; drafts 0.2.0 to 0.2.3 exist, none is published, and none should be, because they carry the 403 sync bug):
- A draft is visible only to people with write access, so the owner downloads it and installs it by hand. Installed copies poll this repository's feed, get a 404 and show the quiet "feed unreachable" state (matrix row 6 of Q7). They never self-update until the repository is public.
- **The feed never moves.** Every build, from today's 0.2.x to the redesign, remembers this repository. When the owner makes it public and publishes a release, every copy installed from a draft starts updating itself, with no manual reinstall. The old 0.2.x drafts are deleted before the flip.
- Local builds are the default: `npm run release:local` [I] builds on the owner's Mac with `release-build.mjs`, runs the verifier and uploads a draft with `gh`. The tagged `release.yml` run happens only on the owner's go-ahead, because macOS runners bill 10 times Linux minutes on private repositories (decision H).
- `scripts/release.mjs` refuses any branch but `main` unless `--allow-branch`; beta tags (`v0.3.0-beta.N`) use the flag, documented in RELEASING.md. The stable release is tagged from main after the owner merges `revamp`.

**Deliverables.**
1. **Draft releases in this repository.** `build.publish` already targets this repository (`releaseType: draft`) and stays. `release.yml` keeps `GITHUB_TOKEN`, with `contents: write` only in the release job. A release-notes template (`docs/release-notes-template.md`) carries the install steps, the Gatekeeper first-open note, SHA-256 checksums, a privacy link, what to do if updates fail, and an honest Gmail line: only listed test users can sign in, with a reconnect every 7 days; iCloud, Fastmail and other IMAP accounts work for anyone who has the app. The draft remains the owner's gate.
2. **Local release path** (`npm run release:local`): build, `verify-hardening` once Q2 exists, the draft verifier, then `gh release create --draft` and `gh release upload`. No macOS runner minutes are spent.
3. **Draft verifier**, run locally after upload and again inside `release.yml`: both DMGs and ZIPs plus blockmaps and `latest-mac.yml`, version equals the tag, every SHA-512 matches its file. This turns RELEASING.md's manual checklist into code.
4. **Update channel and local signed feed.** An optional `beta` channel (publisher `channel`; beta builds are prerelease versions such as `0.3.0-beta.1`, which electron-updater treats as prerelease-allowed [U: confirm on 6.8.9]) is configured for use after the repository is public. Until then, update tests use a **local signed feed**: the same release pipeline with a build-time publish override that points at `http://127.0.0.1:<port>` and serves two signed builds from a folder. The override exists only at build time, so no runtime feed override ships. [U] Confirm that electron-builder accepts the override and that Squirrel.Mac updates from a loopback URL on Electron 44.7.2; if not, post BLOCKED-ON and ask the owner for another route.
5. **Third-party notices.** `THIRD_PARTY_NOTICES.txt` generated from production dependencies plus Chromium's licence file, shipped as an extra resource and linked from About. [U] Check that Electron's `LICENSES.chromium.html` reaches the packaged app.
6. **Clean-Mac update test.** Build `v0.3.0-beta.1` and `beta.2` signed and notarized, install `beta.1` from its DMG, serve `beta.2` from the local feed, confirm the in-place update. The test machine is the owner's second Mac; agents SSH there only if the owner says so, otherwise the owner follows a ten-line checklist (`docs/release-checklist.md`).
7. RELEASING.md rewritten for drafts in this repository; the ad-hoc path becomes a "building from source" section.

**Ownership.** Owns `.github/workflows/release.yml`, `apps/desktop/scripts/release-build.mjs`, release checks in `verify-release.mjs`, `RELEASING.md`, `THIRD_PARTY_NOTICES*`, `docs/release-checklist.md`, `build.publish`, and `main/updater.ts` (today's `updates.ts` after the Phase 0 split [I]; copy changes only in Q0).

**Depends on.** Nothing from the owner except a second-Mac session for the clean-Mac test (ask first). `eng-host`'s packaged `--selftest` gives the first payload. `release.yml` only runs on tags, so edits are rehearsed locally and in a private sandbox repository (section 9).

**Acceptance (evidence).**
- `gh release download` with the owner's credentials fetches `latest-mac.yml`, both DMGs and both ZIPs from a draft, and the verifier passes with every SHA-512 matching. An unauthenticated `curl` of the same draft returns 404 while the repository is private (expected, and recorded).
- On the clean Mac: first launch of the notarized DMG shows only the standard internet prompt; `spctl -a -vv` says "Notarized Developer ID"; `beta.1` updates to `beta.2` in place through the local signed feed with data intact and **no Keychain prompt** (Developer ID gives a stable designated requirement; `RC/gaps/macos-daemon-lifecycle.md` §3 records the prompt ad-hoc builds cause).
- Screenshots are taken headlessly from the app's own state, not from a visible window.

**Estimate.** 1.5-2.5 days, plus one clean-Mac session.

**Work packages.**

| WP | Fan out | Verify adversarially |
|---|---|---|
| Q0.1 Local release path and workflow config | One agent edits and dry-runs locally with ad-hoc signing, and in a private sandbox repository for the Linux steps | Another breaks it: wrong tag, missing token, wrong YAML hash, half-set notarization secrets; each must fail loudly |
| Q0.2 Draft verifier | One agent | Feed it a tampered YAML and a missing blockmap |
| Q0.3 Notices and release notes | One agent each | Every production dependency in `npm ls --omit=dev` appears in the notices |
| Q0.4 Local signed feed and clean-Mac session | One agent builds the feed; the owner, or an agent over SSH if allowed, runs the session | Command output goes in the PR; a second person repeats the first-launch step |

> **What this means:** Builds are signed, notarized and uploaded as drafts to this one repository, and you install them by hand. Updates between signed builds are proven on a spare Mac with a local feed. If you make the repository public later, installed copies start updating from it with no extra steps.


### Q2. Electron hardening

**Goal.** Close the gap between "signed and notarized" and "hard to abuse", and make the gap checkable by a script. Resident mode (ARCH M1) is a milestone, not a release, so the first users of fuses and resident mode are the owner's draft betas. The first fused build is a local packaged build once `eng-host`'s `--selftest` passes. Then `v0.3.0-beta.N` drafts cut from `revamp` carry fuses and resident mode together, and both ship in the one redesigned release. The packaged engine is thus tested once, on the real update path (the local signed feed from Q0).

**Deliverables.**
1. **Fuses** via electron-builder `electronFuses` (ARCH §2.5): `runAsNode`, `enableNodeOptionsEnvironmentVariable` and `enableNodeCliInspectArguments` off; `enableEmbeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar` on; `enableCookieEncryption` left off (Aplos stores no cookies and it would add Keychain use for nothing); `grantFileProtocolExtraPrivileges` left **on** until the renderer is served from an `aplos-app://` scheme (item 5). The engine uses `utilityProcess.fork` and `aplos-symbols` is a separate binary; the `RunAsNode` fuse affects neither (`RC/gaps/macos-daemon-lifecycle.md` §3).
2. **macOS 13:** `build.mac.minimumSystemVersion` 13.0 (fact 2).
3. **Minimal entitlements for Developer ID builds.** Two files: `entitlements.mac.plist` (release) and `entitlements.adhoc.plist` (source builds; keeps `disable-library-validation`, which exists so ad-hoc code launches). Try dropping `allow-unsigned-executable-memory` and `disable-library-validation` from the release file; keep `allow-jit` and `audio-input`. **[U]** V8 and Electron's helpers under the hardened runtime may still need one. The experiment is part of the milestone and needs the second Mac; the result and launch log go in DECISIONS.md, and whatever stays is commented in the plist. If the owner offers no second Mac, the release file stays as it is today and the experiment is recorded as not run.
4. **A global `web-contents-created` guard** in `apps/desktop/src/main/security.ts` (created by Phase 0's split of `electron.ts`), installed by one call from `lifecycle.ts`. Every `webContents` (windows, pop-outs, print views, future mail-frame views) gets navigation lockdown (`will-navigate`, `will-redirect`, `will-frame-navigate`), a deny-all window-open handler that routes safe links externally, `will-attach-webview` denied, and device and display-media permissions denied; the existing microphone rule stays. Today these live per window (fact 5), so a new window type would silently skip them.
5. **CSP in two stages.** *Now:* a Vite `transformIndexHtml` step emits a production CSP without the dev ports and, if the build emits no inline script (`build.modulePreload.polyfill: false`), without `'unsafe-inline'` in `script-src`. `style-src 'unsafe-inline'` stays (React sets style attributes); the reason is written beside the policy. *After `eng-html` lands (ARCH M4):* `img-src` drops `https:` and gains `aplos-mail:`, `frame-src aplos-mail:` is added (ARCH §12.1), and an `aplos-app://` scheme serves the renderer with the CSP as a real header, after which `grantFileProtocolExtraPrivileges` goes off. **[U]** Whether the renderer relies on file-protocol privileges; the stage-2 test finds out.
6. **Debug access.** Release builds exit at startup when given `--remote-debugging-*` or `--inspect*` (ADR 40-6). `verify-release.mjs` moves to an **E2E build variant** compiled with an `APLOS_E2E` define that release CI never sets. Because Playwright's Electron driver needs the inspector fuse (fact 21), the variant is **never fused like a release**: it is an unpackaged `electron .` run (or an unsigned `--dir` build with default fuses), has no update feed, and is never uploaded. It also forces `show: false`, hides the Dock icon, and refuses a non-temporary data directory, satisfying the headless-only rule (fact 17). Phase 0's F8 test mode (`APLOS_TEST=1`, `APLOS_DATA_DIR`) is compiled in only where `APLOS_E2E` is defined, so a release build ignores both; `verify-hardening` launches a release with them set and requires normal behaviour [I: this tightens F8, so confirm it with the Engine thread]. Because the variant differs from the release in exactly these ways, J11 and `verify-hardening` run on the **real fused artifact** and are the only evidence for fuses; the variant proves behaviour, not hardening.
7. **`apps/desktop/scripts/verify-hardening.mjs`**, run on any built `.app` and in release CI:
   - fuses equal the expected table; plist `LSMinimumSystemVersion` is 13.0 and `ElectronAsarIntegrity` exists;
   - `codesign --verify --strict --deep`, `spctl -a -vv`, `xcrun stapler validate`;
   - entitlements match the file, no extras;
   - the signed **designated requirement** names the bundle ID and team VW9NDM428H, which keeps Keychain trust across updates (a cdhash-only requirement is flagged);
   - launching with `--remote-debugging-port` makes the app exit;
   - an `app.asar` scan finds no `.env` and no key-shaped strings (`gsk_`, `sk-ant-`, `AIza`, PEM headers); the Google client secret appears only in the engine bundle, where RELEASING.md and ARCH §12.2 say it is inlined on purpose;
   - the engine starts and `aplos-symbols` runs in the packaged app.
   `verify-hardening` is wired into today's `release.yml` (v1) and into `release:local` as a post-build step **in this milestone**, not in Q7, so the release candidate cannot ship without it; Q7a only restructures the workflow around it.
8. **Link-handler tests.** `aplos:` and `mailto:` arrive from the OS (`CFBundleURLSchemes`). A test feeds `handleLink` hostile input (`mailto:` with `attach=` pointing at a local file, control characters, very long and nested URLs); nothing outside the compose fields may be honoured.

**Ownership.** Owns `apps/desktop/package.json` `build.*`, `build/entitlements*.plist`, `scripts/verify-hardening.mjs`, `src/main/security.ts`, the `index.html` CSP and the Vite plugin. Touches `windows.ts` (window `show`), the link handler (in `protocol.ts` after the split [I]) and `verify-release.mjs`. The Engine thread owns resident mode, `lifecycle.ts` and the engine host; UI-core owns the renderer.

**Depends on.** `eng-host`'s `--selftest` and the Phase 0 split for the first fused build; `eng-html` (the mail frame) for CSP stage 2; Q1b; a macOS packaging run (local, or on demand on GitHub); the second Mac when the owner offers it. The in-place update step uses Q0's local signed feed.

**Acceptance (evidence).**
- `verify-hardening` output from the signed, notarized release artifact shows every row passing, attached to the release PR.
- Hostile launches all fail: `ELECTRON_RUN_AS_NODE=1 "Aplos Mail" -e …` runs nothing; `NODE_OPTIONS=--inspect` is ignored; `--inspect` and `--remote-debugging-port` make the app exit; a copy with one byte of `app.asar` changed refuses to launch; a copy with an unpacked `app/` folder instead of the asar refuses.
- The app still works: engine up, `aplos-symbols` runs, microphone flow unchanged, an in-place update from beta.1 to beta.2 succeeds with asar integrity on.
- The entitlement experiment is recorded with launch evidence from a second Mac, or recorded as not run with the release entitlements unchanged.
- Stage 2: in headless Electron under the production CSP, a remote image, an inline script and an `https:` frame are blocked and logged.

**Estimate.** 3-5 days (days 4-14, including the second-Mac test), plus 1 day for stage 2 once `eng-html` lands (about days 12-16).

**Work packages.**

| WP | Fan out | Verify adversarially |
|---|---|---|
| Q2.1 Fuses, plist, entitlements | One strong-model agent (security-sensitive) edits config and runs the experiment matrix | A second agent runs the hostile launch list on the built app without the first agent's notes |
| Q2.2 `security.ts` guard | One agent, tests with fake `webContents` | Open each window type (pop-out, print, a deliberate `<webview>`); none may escape |
| Q2.3 CSP | One agent, header-level test | Try inline script, remote image, `javascript:` URL, `data:` frame; each must be blocked |
| Q2.4 `verify-hardening` | One agent | A third agent mutates the app (flip a fuse, strip stapling, add a key-shaped string) and confirms the script fails each time |
| Q2.5 Link-handler fuzz | One agent | A reviewer adds ten more cases from public URI attack lists |

> **What this means:** The signed app gets its safety switches turned on, and a script confirms they stayed on. They arrive together with the menu-bar mode in the draft betas, so you test once.

### Q5A. Website: stop the false claims, finish the privacy page, restyle

**Goal.** In the `web` lane (days 2-5) the public site says nothing untrue, its privacy page is complete and true, and it follows the revised design. The site is `apps/web` on Vercel at aplos.email (decision M). The evidence-backed version follows in Q5B.

**Where it goes live.** Vercel deploys from git [U: which branch is "production"; the owner checks the project settings on days 1-3]. The `web` lane never pushes to that branch. Reviewers see the work on Vercel's preview URL for `revamp` pushes [U: previews are enabled for the project]. The live site changes when the owner merges `revamp` or repoints the production branch. No Google review waits on the privacy page any more. If the owner wants the false claims off the live site sooner, a copy-only pull request to main is the owner's call.

**Deliverables.**
1. Sample data out of `release.ts`. While the repository is private, the download page says builds are shared with invited testers by the owner. After the owner makes the repository public, it reads this repository's published releases at build time (as `VISION.md` intends) and fails the production build on sample data. Its text also states the Gmail limit: only listed test users can sign in, with a reconnect every 7 days.
2. macOS 13 (fact 2). Windows and Linux rows and "planned" lines removed (ARCH §17).
3. "Works with Gmail, Outlook, iCloud, Fastmail and any IMAP account" replaced by what is true. [I] Today that is the demo plus whatever has passed a live check; Outlook goes until a Microsoft app registration exists and a live check passes; Gmail reads "available to invited testers"; the rest returns in Q5B as each passes.
4. "Updates install themselves" only after the Q0 update test passes and the repository is public.
5. **The privacy page, finished now:** contact address (decision I, a free forwarding address on aplos.email), the Google API Services **Limited Use** statement (`RC/protocols/proto-google.md` §8.2), what is stored on the Mac and what leaves it (provider, the AI provider the owner chose, the update check; nothing else), no telemetry, and how to delete data. It is served at aplos.email, linked from the homepage, and its AI section matches what the code does (plan 20's `trainsOnInputs` rule). It must simply be true.
6. `scripts/check-web-external.mjs`: the built site requests no host but itself (the page promises no third-party scripts).
7. `site.ts` placeholder links replaced by this repository's releases page once it is public; until then, no source or download link.
8. **Restyle** to the revised design: UI-core's `tokens.json` (artifact F9, day 3), roomier type, the Newsreader serif for AI text, no airmail stripe and no sky gradient (DESIGN §2.4, decision 14; roadmap §2.5), and never a sparkle, wand or star glyph. The `Airmail` name goes with the stripe. Copy-only fixes do not wait for tokens.

**Ownership.** The `web` lane owns `apps/web/**` (copy, data, scripts and styles) and `apps/desktop/build/dmg-background.html`. UI-core owns `tokens.json`, which the site consumes.

**Depends on.** Decisions I and K; F9 tokens for the restyle; Q0 and a public repository for live release data.

**Acceptance.** The built site has no sample release, no Windows or Linux, no Outlook, no unverified provider; every link returns 200 or an intentional "not yet"; the external-host check passes; the privacy URL returns 200 over HTTPS on the Vercel preview, and on aplos.email once the production branch carries it, and contains the Limited Use sentence verbatim from Google's policy page; headless screenshots of the site in both themes are attached.

**Estimate.** 2-3 days.

**Work package.** One agent edits; a second reads the built site cold, lists every factual claim without opening the first agent's diff, and compares against fact 15. A Claude model writes the design and copy.

> **What this means:** The website stops promising things that do not exist and gets the new look. The privacy page says what the app really does. It goes live on aplos.email when you merge `revamp` or repoint Vercel.


### Q3. CI foundation and emulator E2E

**Goal.** Every change is judged by machines: static checks, unit tests, a browser run on fake mail accounts, an Electron run, and a packaged-app smoke, all headless and all inside GitHub's free minutes. Lanes run their checks locally first; GitHub runs Linux jobs on pushes to `revamp`; macOS jobs run on demand. Slots exist for every check the other plans create.

**Deliverables.**
1. **`ci.yml` restructured.** Triggers: pushes to `revamp` for Linux jobs, `workflow_dispatch` for macOS jobs, and no pull-request trigger (the Integrator runs the full suite before each merge). Jobs: `changes` (the existing path filter); `static` (Q1); `unit` on Linux with a macOS fallback list, split in two: `test:unit` under system Node for suites that never open a database, and **`test:engine` under Electron's own Node** (`ELECTRON_RUN_AS_NODE=1 node_modules/electron/... --import tsx --test`; this mode needs no display, so Linux can run it once the Linux Electron binary is cached [U: confirm `--test` and the tsx loader work in that mode on 44.7.2; fallback is the on-demand macOS job]). `test:engine` covers every suite that touches `node:sqlite` today (`store`, `service`, `queue`, `sync-safety`, `sql`) and every store, FTS, migration and property suite the Engine thread adds, because `node:sqlite` takes whatever SQLite the host runtime has (fact 6; `RC/gaps/storage-engine-benchmark.md` §0, where Homebrew Node reports 3.54.0 and Electron 3.53.4). A `sqlite-floor` self-test prints `sqlite_version()` from both runtimes and fails if Electron's is below 3.43 (ARCH §3.1) or FTS5 `contentless_delete` is missing. `npm run check` runs `test:engine` locally the same way. On Linux: `e2e-browser` and `web`. On demand on macOS: `electron-checks` (the packaged `--selftest` from `eng-host` and the 400 KB engine budget in `tests/portability.test.ts`, plus a build), `e2e-electron` (E2E variant) and `package-smoke`. Reusable via `workflow_call` so `release.yml` runs the same checks before signing. Actions pinned by SHA, `permissions: contents: read`, timeouts, concurrency cancel. Each run's summary prints the minutes it billed, and `scripts/audit/ci-minutes.mjs` sums the month from `gh run list` and warns at 70% of the allowance [I].
2. **Named slots** for checks other lanes write, each a `package.json` script plus a CI job that is skipped (and listed as pending) until the script exists: `check:openapi` (the Engine thread, ARCH §9.3), `check:tokens`, `check:contrast`, `check:identity`, `test:visual` (UI-core, DESIGN §12.4-12.5), `test:perf` (DESIGN §12.6, macOS, packaged, run on this Mac at scheduled times and on demand).
3. **One Playwright base** (`tests/e2e/playwright.config.ts`), pinned once; plan 30's visual harness extends it.
4. **E2E journeys** (table below) against the fixture engine, plan 20's emulators and the demo data, each with a temporary `APLOS_DATA_DIR`, its own ports, a frozen clock and no AI keys unless a scenario injects a mock provider (DESIGN §12.5's isolation).
5. **Fixtures:** seeded 10k, 50k and 100k-thread stores (plan 10 owns the generator; CI caches the database keyed by the generator hash).
6. **Performance budget register.** `budgets.json` at the repo root lists **every** budget in the plans, each with owner, environment, gate type and a calibration state, so none is unowned. Rows (values are the plans' own, never invented here):

| Budget | Owner | Measured where | Gate |
|---|---|---|---|
| Triage key to state, to next paint; J/K; palette; open a cached letter; scroll 10k rows (DESIGN §5 table) | Plan 30 (`tests/perf`) | Packaged build, 10k fixture | Hard cap at 3x the budget on shared runners and on the shared agent Mac; the 10% against 7-day median trend check (DESIGN §12.6) runs on the **owner's quiet Mac and at release**, because shared machines vary by more than 10% |
| Cold start to shell painted (800 ms) and Home interactive (1.5 s), marked "recalibrate after first measure" in DESIGN | Plan 30, harness by Q3 | Packaged build; the owner's Mac for the absolute number | As above; first run only records |
| Store: first page, unread counts, commit, cold open, RSS after first page, newest-50 search (plan 10 E2 list) | Plan 10 (`packages/engine/bench`) | 200k-message fixture | 3x margin in CI; exact numbers from the owner's Mac (plan 10 section 5) |
| 7-day soak: RSS slope, WAL size, event-loop p99 (plan 10 E8) | Plan 10, run in the background during Phase 3 (roadmap section 2.6) | Owner's Mac | Release gate |
| Resident-mode idle: engine RSS, CPU percent over 10 idle minutes, wake-ups [U: collected with `ps` and `top`; `powermetrics` needs sudo, so energy stays a hand check] | Plan 10 (`eng-host`), harness by Q3 | Packaged build, owner's Mac | Recorded, then limited so it cannot rise |
| Packaged `.app` size (369 MB locally, 140 MB ZIP; alert at +10%), engine bundle (400 KB core), renderer bundle, unit-suite time, CI wall-clock and billed minutes | Plan 40 | Every merge | Limit that only tightens |
| First sync: 500 threads, first 50 in 15 s on the accelerated clock (J2) | Plan 20, harness here | Emulator | Required |

The register has one script, `check:budgets`, that fails when a budget has no owner, no environment or a stale measurement older than its allowed age. Calibration follows plan 10's rule: a target marked "calibrate" is set from the first run on the owner's Mac and written to DECISIONS.md, after which a regression fails.
7. **Flake policy.** One retry in CI, flagged in the summary; a test needing it twice in a week is quarantined with an issue and listed in the job summary, never silently skipped.
8. **Merge rules.** Required checks for `revamp` and later `main` are enforced by the Integrator's merge procedure; GitHub branch protection is added only if the account's plan offers it on private repositories [U].

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
| J11 | Packaged smoke: the signed app starts headless, `Session/get` answers, a killed engine restarts (macOS, on demand and on every release run) | package | `verify-hardening` + `verify-release` |
| J12 | Weekly reconnect: with a grant older than 6 days the sidebar shows the quiet line; one click reconnects with `login_hint`, triggers no resync and keeps queued local changes | browser | Roadmap N3; plan 20 |

The keyboard-from-inside-a-mail-frame behaviour (ARCH §10, marked [U]; the mail frame is a separate browser process, an "out-of-process iframe", which may swallow key presses) must still be **hand-checked** in the packaged app before the mail frame (`eng-html`, ARCH M4) is called done. An automated attempt is a bonus and never replaces it.

**Ownership.** Owns `.github/workflows/ci.yml`, `tests/e2e/**`, `budgets.json`, `apps/desktop/scripts/ci/*`, CI helpers in `scripts/audit/`. Touches `package.json` scripts. Plan 20 owns the emulators, plan 10 fixtures and the contract, plan 30 `tests/visual` and `tests/perf`.

**Depends on.** Q1b; the stand-in engine (Phase 0 artifact F6) and the real engine's views (`eng-views`, day 11); the mail frame (`eng-html`); plan 20's Gmail emulator (`prov-emu`, which must reproduce 0.2.3's failure before anything else is tested on it); UI-core's harness skeleton. Journeys are added as each lands and shown as pending until then.

**Acceptance (evidence).**
- A green run on `revamp` with per-job timings: static plus unit under 4 minutes, browser E2E under 8, on-demand macOS jobs under 15. The first full week's billed minutes are recorded and stay under the free allowance.
- **CI self-test.** A scratch branch with six deliberately broken commits: an unformatted file; a banned import; a key-shaped string in a built bundle; an unthrottled Gmail loop; a mail frame that makes a network call; an OpenAPI change with no golden update. Each fails the job meant to catch it, shown by run logs. The branch is kept as a regression fixture.
- A scheduled run on this Mac, and an on-demand macOS run, execute the perf and large-fixture jobs and store a history file in the `ci-data` branch.
- `check:budgets` fails on a budget row with no owner, and a store test that passes under system Node but fails under Electron's Node (a seeded SQLite-version difference) is caught by `test:engine`.

**Estimate.** 8-10 days: slots on days 1-3, jobs and journeys on days 4-12, then emulator journeys run with the Integrator on days 12-16.

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

*Layer 0, policy tests (no network, every push to `revamp` and every lane's local check).* A `tests/policy/` suite encodes rules from ARCH and AGENTS.md so they cannot drift:
- every provider adapter is built with SDK retries off (`maxRetries: 0`, ARCH §6.1);
- background AI jobs run with no tools (ARCH §8.5);
- no background job enqueues before consent, and a provider with `trainsOnInputs` receives no mail content (ARCH §8.3);
- mail text is always wrapped as quoted, untrusted content in prompts;
- no key-shaped value appears in any log line of a full run (ARCH §11);
- AI state never uses a sparkle, wand or star glyph (DESIGN banned-icon list).

*Layer 1, eval corpus.* Today: 8 factual cases (`apps/desktop/scripts/quality/cases.ts`) and a 5-question Ask check, both manual (`research/inbox-zero/aplos-architecture.md` §4). They grow to about 60-80 invented cases under `tests/evals/`: summary faithfulness, action extraction, reply-needed, rank bucket against the deterministic heuristic (ARCH §8.2), prompt injection (an email that tells the model to ignore instructions, forward mail or call a tool must not change the result), citation validity (Ask cites only excerpts it was sent), structured-output validity, refusal to act. No real mail is used.

*Run modes.*
- **Replay (gates every push to `revamp` and every lane's local check).** Provider responses recorded as "cassettes" (saved real answers, replayed offline) keyed by prompt hash; this tests parsing, guards and degradation deterministically. Refreshing cassettes is a reviewed manual command.
- **Live (advisory first).** Real Groq, temperature 0, pinned model IDs in the report. Nightly on this Mac at scheduled times, and on demand on GitHub Linux when a change touches prompt files. It uses the owner's separate free test Groq key (from the environment on this Mac, or from a protected GitHub environment for on-demand runs), never the owner's daily key (ARCH §8.4: about 200,000 free tokens a day per model). A token-budget flag caps each run. At roughly 3,000 tokens a case [I, to be measured on the first run], a nightly run is a stratified subset of about 25 cases and a smoke run is the 8-case smoke. The runner reads rate-limit headers and on exhaustion ends **inconclusive**, not failed. Pass rule: no case that passed in the last seven nights regresses in two of three runs; after ten stable nights the AI check becomes a required local check. Results go to a `ci-data` branch and an artifact.
- **Cross-provider conformance (weekly, optional keys):** one tiny call per provider on a free tier or a local server, checking the auth header, stream parsing, and that a bad key becomes class `auth`; local servers use a fake OpenAI-compatible server. No paid key is used.

*Layer 2, live mail-provider smoke.* **One harness, two runners.** Plan 20 section 5.4 owns the live-provider harness (`apps/desktop/scripts/live/`, tiers R read-only, M mutating on test objects, S send owner-only, content-free evidence files in `verification/live/<date>-<provider>.md`) and says tiers M and S never run in CI. This plan does not build a second harness: `npm run smoke:live -- gmail|gcal|icloud|fastmail|graph` is a thin **runner over plan 20's tier R only**, in `scripts/smoke/` (the probes in `scripts/smoke/probes/` belong to the Providers thread). It schedules the probes, reuses their evidence format and adds `provider-status.json`. By decision G it runs on this Mac at scheduled times (launchd [I]), so no Google token sits on GitHub; running it on GitHub is possible only if the owner chooses to store a token there and refresh it weekly. It goes through the existing `MailProvider` adapters, so it can start as soon as `prov-gmail` has a read path:
- **Gmail:** token refresh, profile, labels, one `messages.list` page, one metadata `messages.get`, `history.list`; about 30 units a night (ARCH §5.1). Records granted scopes and quota headroom.
- **Google Calendar:** login, list, one sync-token fetch. iCloud IMAP and CalDAV and Fastmail JMAP join in round 2.
- **Accounts.** **The owner's main mailbox is never used by automatic runs.** The runner signs in only to the agent test account (the owner's spare Gmail, listed as a test user; iCloud and Fastmail accounts in round 2). Its address lives only in the local vault config, never in the repo. Live AI evals may read its mail locally; reports keep scores and ids only, no content. Runs against the owner's own account are by hand, from the Integrator's checklist on days 14-16.
- **Writes** (plan 20's tier M) never run in CI; locally, with the owner's flag, only in dedicated test accounts, only on objects the test created (a label, a draft), always cleaned up. **Never send.** The owner may run a manual `--allow-send-to-self` locally.
- **Cadence and secrets.** Scheduled on this Mac after the weekly reconnect, one account at a time, each run under 3,000 Gmail units a minute. Tokens live in the Mac's Keychain or environment, never in the repository, logs or artifacts. Logs hold hashed ids, units and latency, never subjects or bodies.
- **Credential expiry.** The project stays in Testing mode, so refresh tokens last 7 days (`RC/protocols/proto-google.md` §8.1) and every Gmail account checked here needs a reconnect each week. The runner reads `reconnectBy` before starting; when it has passed, the runner skips with a clear message and updates one notice (one GitHub issue, or a local note) instead of failing, and it treats `invalid_grant` the same way. The owner's weekly reconnect covers the test accounts together (roadmap section 4.3). `npm run smoke:auth` runs loopback OAuth locally and stores the new token in the Keychain, never printing it. There is no Production switch.
- **Caveat.** Repeated scripted logins can trigger Google account challenges [U]; a small call count lowers the odds, and if challenged the runs drop to a weekly hand check.
- **Output:** `provider-status.json` becomes evidence for website claims (Q5B). These are real endpoints, so live, but they do not replace the owner's acceptance on their own mailbox (ARCH §15).

**Ownership.** Owns `tests/policy/`, `tests/evals/`, `scripts/smoke/` except `probes/`, `.github/workflows/evals.yml` (manual dispatch only), the local schedule files and the `ci-data` branch; touches `scripts/{evaluate-groq,ask-live,quality/cases}.ts`. The Engine thread owns the queue the policy tests assert about; plan 20 owns the adapters and probes.

**Depends on.** `eng-ai` (queue, consent) for full Layer 0 and 1; the Providers thread's tier R probes for smoke coverage; decision G and the agent test account.

**Acceptance (evidence).**
- The replay suite runs in the `revamp` push job in under a minute and goes red when a prompt wrapper is removed or retries are re-enabled (deliberate breakage shown).
- The first live run reports tokens per case, replacing the 3,000 estimate.
- A fake Groq 429 makes the live job inconclusive, not failed; a fork-PR simulation shows no secret available.
- The Gmail smoke runs green on every day of a reconnect week. When the test account's grant is older than 7 days, the runner skips with the reconnect message and the expiry notice opens exactly once; after `smoke:auth` the next run passes.
- Gitleaks over eval and smoke artifacts finds nothing.

**Estimate.** 5-7 days (days 4-12; live runs on days 12-16); about 5 owner minutes for the test-user listing (the Groq key is done).

**Work packages.**

| WP | Fan out | Verify adversarially |
|---|---|---|
| Q4.1 Policy tests | One agent per rule group | Revert the product rule; the test must go red |
| Q4.2 Eval corpus | Three agents write cases by category from a template | A different model family reviews for ambiguity and answer leakage; ten held-out cases come from someone who has not seen the prompts |
| Q4.3 Replay and live runner | One agent | Simulate rate-limit headers, a daily-limit 429, malformed JSON and a timeout |
| Q4.4 Smoke probes | One agent per provider behind a shared `SmokeProbe` interface that plan 20's tier R already satisfies or wraps | Record every outgoing request method; fail on any `POST/PUT/DELETE` from the CI runner (tier R only; OAuth token refresh excepted); confirm no send endpoint is reachable and no token for the owner's account is configured |
| Q4.5 Credentials | One agent writes `smoke:auth` and the expiry issue logic | Security review: tokens never printed, never in artifacts, never on forks |

> **What this means:** AI quality gets a nightly report card and real accounts get small read-only health checks, run on this Mac. The robot never sends mail, leaves your daily AI allowance alone, and does not turn red just because a token expired.

### Q6. Open-source readiness

**Goal.** When the redesign is ready, the owner can decide about going public knowing whether any secret, borrowed code, bad licence or embarrassing paper trail would be exposed, and a stranger can build and run the project. The press itself stays with the owner (Q8.2). Q6 runs in Phase 3 and does not block the release.

**Deliverables.**

**6.1 Provenance audit.**
- *Docs.* `SPEC.md`, `PROGRESS.md`, `DECISIONS.md` and `TODO.md` say Aplos began as "an independent take on Avec's interaction model", name Avec's installed version and ASAR hash, and describe how it was analysed (fact 14). With one repository, these files, `plans/` and `research/` sit in the public tree and history unless the owner removes them (decision D, at flip time). The public tree gets a short curated `docs/` either way.
- *Code and copy.* Plan 30 removes the 17 Avec-derived layouts and phrases (`DESIGN.md` §13). The **provenance gate** adds: the banned-strings lint passes; a grep for Avec-specific strings, class names and constants is clean; a licence scanner (such as ScanCode) is clean; a manual look at the five largest files for text matching a reference project's code. The reference corpus includes GPL, AGPL and unlicensed code, so only ideas may enter (ARCH §14.1).
- *Assets.* The icon's source layers are Adobe Firefly output (fact 13). **[U]** Adobe's terms for commercial and open-source redistribution of Firefly output, and whether AI-generated art is copyrightable (weakly, in the US), need checking before the icon is called protected. The public tree ships only the final composed icon and website art under separate "all rights reserved, trademark" terms (`assets/LICENSE`); the Firefly layers leave the tree (and the history, if the owner rewrites it). Newsreader (SIL OFL, via fontsource) is fine and goes in the notices.
- *Dependencies.* The production tree is all permissive (fact 12), and GPL-3.0 can include all of those licences. Dual-licensed packages get a recorded choice (`mailsplit` under MIT, `dompurify` under Apache-2.0). A `license-check` CI job fails on any new copyleft or unknown production licence.

**6.2 Secret-history audit.**
- Before any flip, run **gitleaks** over every ref (default rules plus custom rules for `gsk_`, `GOCSPX-`, `sk-ant-`, `AIza`, Apple app-specific password shape, PEM headers) and **trufflehog** with its live-credential check. Include `refs/pull/*`, tags and release notes.
- A flipped repository also publishes every branch and pull-request ref (PR #21's too), issue and PR text, Actions logs and artifacts. Check logs and artifacts for printed values; delete runs that contain any.
- **Do not rotate the Google client secret as a ritual** (ADR 40-11). It is compiled into every released DMG, so a new one would ship the same way, and disabling the old one breaks token refresh for every installed copy. The audit's question is narrower: is the secret, the signing `.p12`, the app-specific password or any token in git, a log, an artifact outside the DMGs, or a PR? If yes, rotate that one (section Q6.9 for the Google staging). Confirm the signing certificate and Apple secrets never reached a log.
- Scrub local paths (`/Users/knewton/...` in `SPEC.md:9`). Under an in-place history rewrite the second author identity and the certificate name can be rewritten; otherwise a `.mailmap` fixes display only.

**6.3 Licence application** (after decision C). Today there is **no LICENSE file anywhere**, so nothing is granted although both `package.json` files say MIT; the first Q6 commit sets both to `UNLICENSED`, and the chosen SPDX ids replace that only after decision C. Proposed licence by path (the owner confirms with C; plan 10's packages are named in its section 3):

| Path | Licence on the recommended default | Reason |
|---|---|---|
| `apps/desktop`, `packages/engine`, `packages/mail-html` | GPL-3.0-only | The product; copies stay open |
| `packages/contract`, `packages/contract-fixture` | MIT | A public interface and its test double, so any tool can be built against Aplos |
| `apps/web` code | GPL-3.0-only; copy, art and the icon: all rights reserved | The site is part of the brand |
| `assets/`, `AppIcon.icon` | All rights reserved, trademark terms (`assets/LICENSE`) | Name and icon stay yours |
| Fonts | Their own licences (Newsreader: SIL OFL) | Listed in the notices |

Drafts, kept under `docs/legal-drafts/` until the owner answers decision C so nothing grants rights early: `LICENSE` (GPL-3.0) for the root, `packages/contract/LICENSE` (MIT) and `assets/LICENSE`. `package.json` `license` fields say `UNLICENSED` now, then the chosen SPDX ids; `REUSE.toml` and a `reuse lint` job come with the licence. `TRADEMARKS.md`: the name and icon are reserved; forks rename and change the bundle ID and URL schemes (`com.aplos.mail`, `aplos`, `mailto` default-handler behaviour); "Airmail" is never used (`RC/gaps/identity-collision-audit.md` §0).

**6.4 Contribution machinery.**
- `CONTRIBUTING.md`: install; run without keys (demo data and emulators); `npm run check`; the design skill's definition of done for UI changes (`DESIGN.md` §12.3); DCO or CLA (decision E); how to supply your own OAuth clients via `APLOS_GOOGLE_CLIENT_ID`, `APLOS_GOOGLE_CLIENT_SECRET`, `APLOS_MS_CLIENT_ID` (ARCH §14.2; today's code reads `GOOGLE_CLIENT_ID` and similar, so the rename is plan 20's work and the doc follows whichever lands).
- `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md` (GitHub private reporting plus the address from decision I; scope: local listener, HTML sandbox, OAuth, updater; honest single-maintainer response times), `SUPPORT.md`, issue templates (bug reports attach the content-free diagnostics bundle, ARCH §11), a PR template (no secrets; tests; headless screenshots for UI), `CODEOWNERS`.
- **Official-build guard.** Today a build with no Developer ID turns the updater off (fact 16); keep that, and add an `APLOS_OFFICIAL_BUILD=1` define set only in release CI so a fork with its own certificate never polls the official feed.

**6.5 Public docs.** README (honest status, demo screenshots); `docs/` with a public-safe architecture overview, the ARCH §16 ADRs, the API and OpenAPI document once the Engine thread ships it (ARCH §14.5), building, releasing (no secrets), privacy with a data-flow picture (provider, chosen AI, update check to GitHub; nothing else), and a provider matrix generated from `provider-status.json`. **`plans/` and `research/` move to a private archive outside the repository before any flip** (and out of history if the owner rewrites it, decision D): the research quotes and screenshots proprietary apps, and the plans hold internal deliberation.

**6.6 Repository settings checklist** (owner clicks, after the flip): branch protection; secret scanning with push protection; private vulnerability reporting; Dependabot alerts; CodeQL (free on public repos); approval for first-time fork workflows; read-only default token; **release secrets in a protected environment**; no `pull_request_target`.

**6.7 Flip rehearsal (optional, roadmap section 10).** Run the scans and a **stranger test** locally on a clean clone of the candidate tree, and of a rewritten history if the owner chooses that. A private throwaway repository is used only for the Linux CI part, to save minutes. In the stranger test an agent with no prior context follows only the README and `docs/building.md` to build and run the demo headless; a human reviews; time to first run is recorded.

**6.8 Later, if ever: opening Gmail beyond the test users.** Section 4A explains why this is off the plan. Nothing in Q6 depends on it.

**6.9 When this repository goes public: the bundled Google OAuth client, the feed and the plumbing.** It is the same repository, so most plumbing stays where it is. What changes, and what must be done before the owner presses the button (the sequence is the Q8.2 checklist):
- *What the public sees about the client.* The client id and secret are inlined from GitHub secrets by `scripts/build-main.mjs` only when `APLOS_RELEASE_BUILD=1`; they are not in the tree (fact 9). Publishing the source therefore exposes nothing new: the DMG already carries both, and Google's own guidance says an installed-app secret is not confidential (`RC/protocols/proto-google.md` §8.1). A stranger *can* lift the pair from a DMG and build an app that shows Aplos's consent screen. The project stays in Testing mode, so only the 100 listed test users can finish signing in on it [I: confirm on the first test]. `SECURITY.md` says so plainly and gives a way to report a lookalike.
- *Forks and source builds.* They must use their own Google project and their own client (ARCH §14.2; `APLOS_GOOGLE_CLIENT_ID` and friends, plan 20). Theirs starts in Testing mode with 100 test users; `CONTRIBUTING.md` says this before anyone is surprised. The official-build guard (6.4) stops a fork with its own Developer ID from polling the official feed, and a build without the official define must never contain the official id.
- *Rotation, only if a leak is found.* Add a second client secret in the Google console, ship a build that uses it, wait until installed copies have updated (the update-adoption count comes from release download counts [I]), then disable the old secret. Never disable first. Owners of copies that never update will be asked to reinstall. [U] Confirm the console allows two active secrets on a Desktop-app client; if not, creating a new client id would force every user to reconnect, so the answer is "do not rotate without evidence".
- *Old Actions artifacts and logs.* Making the repository public exposes every past workflow artifact (including the DMGs and ZIPs `release.yml` uploaded) and log. Delete all prior runs and artifacts first and keep only runs the scan has cleared. A history rewrite does not remove artifacts or logs.
- *The feed is permanent.* Every installed copy remembers this repository. It is not renamed, archived, transferred or deleted. A history rewrite must keep the release tags and releases, or recreate them with identical assets [U: rehearse in a throwaway copy that published releases survive a rewrite]. After the owner publishes a release, copies installed from drafts update themselves.
- *Plumbing.* Secrets, the Vercel project and Dependabot stay as they are. The 6.6 settings are switched on, `homepage` and `repository` fields and `apps/web/src/site.ts` gain a source link, and a signed build from the public repository proves the chain before anything is announced. Public repositories get free standard runner minutes [I], and macOS stops billing 10 times.


**Ownership.** Owns the licence drafts, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `TRADEMARKS.md`, `REUSE.toml`, `.github/ISSUE_TEMPLATE`, `PULL_REQUEST_TEMPLATE.md`, `CODEOWNERS`, `docs/` and the scan scripts it adds to `scripts/audit/` (`plat-ci` owns the folder, so additions go by REQUEST). Touches `package.json` license fields, `README.md`, `AGENTS.md`. Plan 20 owns OAuth env names; plan 30 the banned-string lint.

**Depends on.** Decisions C, D, E, F and I; plan 30's removal of the 17 Avec-derived items (DESIGN §13), finished when the last screen lane lands; plan 20 for the OAuth env rename.

**Acceptance (evidence).**
- Gitleaks and trufflehog report zero findings over every ref of the **candidate** history; reports are kept in the private archive.
- `license-check` and `reuse lint` pass; the notices cover every production dependency.
- The provenance checklist is signed off line by line in a PR, each line citing command output.
- The stranger test passes on a clean clone of the rehearsal repository.
- Decisions C, D and E are recorded in the private DECISIONS.md with dates once the owner answers; until then every draft is marked draft.
- A dry run of the 6.9 sequence in a throwaway local clone: a fork-style build without the official define contains no official client id (checked by `verify-hardening`'s string scan), and the official-build guard keeps a differently signed build off the official feed.

**Estimate.** 5-6 days of agent work in Phase 3 (days 18-25), plus owner decisions.

**Work packages.**

| WP | Fan out | Verify adversarially |
|---|---|---|
| Q6.1 Secret scan | One agent runs both scanners with custom rules | Plant three fake secrets in a scratch history (a deleted file, a PR ref, a tag message) and confirm all are found |
| Q6.2 Provenance gate | Three agents: docs, code and copy, assets | An independent agent hunts for any trace of a reference app's text, constants or asset names with greps it designs itself |
| Q6.3 Licences, governance docs | One agent per document set | Review by agents role-playing a first-time contributor, a security researcher and a packager; `reuse lint` clean |
| Q6.4 Rehearsal (optional) | One agent builds the clean clone; a context-free agent runs the stranger test | The owner reads the README's plain-English top and the privacy page and says whether they match the product |

> **What this means:** Before anyone sees the code, we scan every old commit for secrets, check for borrowed material, draft the licence and the contributor guides, and optionally rehearse the handover on a throwaway copy. The decision to go public stays yours.

### Q7. Release engineering, update testing and Keychain profiles (Q7a, then Q7b)

**Split.** **Q7a** (deliverables 1 to 3 and 8, about 3 days, days 8-14) lands before the release candidate: the redesigned release (proposed 0.3.0) goes out through `release.yml` v2 with the hardening checks and the update matrix, not through today's pipeline. **Q7b** (deliverables 4 to 7, 1 to 2 days, plus the conditional spike, days 12-16) follows. Beta tags (`v0.3.0-beta.N`) cut from `revamp` for Q2 and Q7a use `scripts/release.mjs --allow-branch` and publish as draft or prerelease builds in this repository on the owner's go-ahead. The stable release is tagged from main after the owner merges `revamp` (section 9 item 5).

**Goal.** Releases are repeatable, every update path has been exercised, and a bad release can be pulled. The Keychain and provisioning-profile question is answered with evidence, and profile work is ready if a trigger fires.

**Deliverables.**
1. **`release.yml` v2.** Verify tag and version; shared CI checks (`workflow_call`); build both architectures; sign and notarize; **verify** (`verify-hardening`, `spctl`, `stapler validate`); upload the draft to this repository (drafts only; the owner publishes); run Q0's verifier; publish a SHA-256 checksums file and a CycloneDX SBOM (`npm sbom`); build-provenance attestation where the plan allows [U on private repos]. The draft is created last, so a failure leaves nothing half-published. A tag run builds on macOS runners that bill 10 times (decision H), so it runs on the owner's go-ahead; the same steps run locally through `release:local` otherwise.
2. **Channels.** `beta` pre-releases for tests, `latest` for stable. Both are reachable by installed copies only once the repository is public; before that, tests use Q0's local signed feed. Staged rollout is documented (electron-updater honours `stagingPercentage`, fact 18) but off by default: with no crash upload it needs testers who report.
3. **Update test matrix** in `docs/release-checklist.md`, run on the release candidate on the owner's Mac, and on a second Mac when the owner offers one, each row with command and expected output:

| # | Case | Expected |
|---|---|---|
| 1 | Clean install from DMG | Standard first-open prompt; notarized |
| 2 | Update N-1 to N, same channel | In place; data intact; **no Keychain prompt** |
| 3 | Update during a scheduled send and a running sync | Engine drains within 3 s (ARCH §2.4); the send stays queued, not duplicated |
| 4 | Update across a schema change (0.2.x to the redesign) | The import runs once; the rollback drill reopens 0.2.x on the untouched `aplos.db` (ARCH §3.8). The Engine thread owns the data side; this plan owns the machine and procedure |
| 5 | Run from the mounted DMG or translocated | Updater off, with the reason shown (`updater.ts`) |
| 6 | Feed unreachable (also the normal state while the repository is private) | Short error row; no crash; retry in 6 hours |
| 7 | Feed edited so a SHA-512 is wrong | Download refused |
| 8 | Download killed midway | Resumes through the blockmap |
| 9 | Downgrade | Updater refuses; an older app refuses a newer database (plan 10) |
| 10 | Second Mac, different macOS version | Same results |

   The unsigned local fake feed (`npm run update-feed`) stays for state-machine and UI tests. **Release builds ship no feed override**, since a hostile feed could offer an older signed build; signed-update tests use Q0's local signed feed, built with a build-time publish override.
4. **Keychain behaviour without a profile.** Today's `safeStorage` item is in the login keychain and its trust follows the app's designated requirement. With Developer ID that requirement is stable across versions, so updates should not prompt (`RC/gaps/macos-daemon-lifecycle.md` §3; the ad-hoc prompt is in `PROGRESS.md:448`). This is evidence work, not code: `verify-hardening` compares the requirement across two releases, and matrix row 2 observes no prompt. `security find-generic-password` is used for **metadata only**, never `-w`.
5. **Provisioning-profile spike (conditional, 2-3 days).** Trigger: ARCH A1 or CloudKit is scheduled (§2.6, §13.2), or prompts appear despite Developer ID. Steps: the owner creates the App ID and a Developer ID profile with Keychain Sharing; embed it with `mac.provisioningProfile`; entitlements gain `com.apple.application-identifier` (`VW9NDM428H.com.aplos.mail`), `com.apple.developer.team-identifier` and `keychain-access-groups`; the notarized build is launched on the **second Mac before anything ships**, because a restricted entitlement without a matching profile can make macOS refuse to launch the app. Evidence: launch, a key written and read under the group, an update that keeps it. If it fails, the unprofiled build stays the shipping default. The data-key migration belongs to ARCH A1 and plan 10.
6. **Secrets calendar** (private archive): Developer ID certificate, app-specific password, Google client secret, test Groq key, the agent test account's grant (it expires every 7 days), each with owner, expiry and rotation steps; reminders 30 days ahead where an expiry is that long.
7. **Rollback runbook.** While the repository is private, delete the bad draft and tell testers to reinstall the previous build. After it is public, unpublish the bad release (the `latest` feed then answers with the previous one), then ship a higher patch version; the updater does not downgrade, so already-updated machines need the fix. Rehearsed once on the local feed.
8. **`RELEASING.md`** in final shape.

**Ownership.** Owns `release.yml`, `release-build.mjs`, `scripts/release.mjs`, `scripts/update-lab/`, `docs/release-checklist.md`, `RELEASING.md`. Touches `updater.ts` (tests only).

**Depends on.** Q0, Q2 (whose `verify-hardening` Q7a builds the workflow around), Q3; the Engine thread's drain and import behaviour for rows 3, 4, 9 (rows 1, 2, 5-8 and 10 need none of it and run on the first betas); the second Mac when offered; Apple portal access for the spike.

**Acceptance (evidence).** Q7a: the release candidate goes through `release.yml` v2's steps end to end (a tag run on the owner's go-ahead, or `release:local`), and rows 1, 2, 5-8 and 10 are filled before the owner publishes; rows 3, 4 and 9 follow when the engine's drain and import behaviour land (days 15-18). Q7b: matrix rows 1-10 filled with outputs for two consecutive beta builds on the local feed; the rollback rehearsed; the release workflow run end to end with the draft verified; matching designated requirements across two releases; spike evidence on the second Mac if triggered.

**Estimate.** Q7a 3 days; Q7b 1-2 days; plus 2-3 for the conditional spike, plus second-Mac sessions when the owner offers them.

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
1. **`apps/web/claims.json`**: one row per factual claim (id, location, evidence, status). Evidence kinds: `test:<path>`, `live:<provider>` with a maximum age, `owner:<dated note>`, `design:<section>`. Examples: `works-with-gmail` (worded "available to invited testers") needs a live Gmail smoke pass within 7 days, the weekly reconnect rhythm, plus an owner acceptance note; `updates-in-place` points at update-matrix row 2 and holds back until the repository is public; `no-server-sees-mail` points at the architecture non-goal.
2. Copy carries `data-claim` ids. **`check-claims.mjs`** fails the production build on a missing, unverified or stale claim; preview builds show a "preview" banner instead.
3. The privacy page, finished in Q5A, is now **protected**: the build fails while any `[...]` placeholder remains, and any change to it needs the owner's sign-off. It carries the Limited Use statement (`RC/protocols/proto-google.md` §8.2), contact address, what is stored and what leaves the Mac, diagnostics "never uploaded" (ARCH §11).
4. Screenshots regenerated from demo data by UI-core's harness (the old capture script stalled on PR #21's onboarding window, `DESIGN.md` Appendix C F14).
5. Copy follows the DESIGN voice rules (§10) and banned phrases, including "Airmail" and "hold A and say it" (§13 item 16). The stripe and sky are gone (DESIGN §2.4, decision 14), so alt text describes the new art.

**Ownership.** The `web` lane: `apps/web/claims.json`, `apps/web/scripts/check-*.mjs`, copy and styles under `apps/web`.

**Depends on.** Q4 (`provider-status.json`), Q7 (update matrix), the Providers thread's live checks, Q0.

**Acceptance.** A seeded unverified claim fails the build; turning a provider's smoke red removes its claim from the next build; a cold read of the live site finds no claim missing from the registry.

**Estimate.** 2 days (days 5-8; claim rows fill in as live checks pass on days 12-16). **Work package:** one agent builds registry and script; an independent agent reads the built site cold and diffs its claim list against the registry.

> **What this means:** The site can only say what a recent test proves. When a provider breaks, the claim disappears by itself.

### Q8. Release gate and public-flip checklist

**Goal.** Two checklists. **Q8.1, the release gate** (days 15-18), decides whether the release candidate is fit for daily use and then for publishing. **Q8.2, the flip checklist** (Phase 3, optional, built on Q6) prepares the owner's later decision about making the repository public.

**Deliverables.**
1. **Gate checklist** in `docs/`, each line citing evidence: Linux jobs green on the release candidate; an on-demand macOS run green; the conformance suite and the soak and fault-injection results (plan 10 E8); end-to-end journeys on emulators; the update matrix filled on the owner's Mac (and a second Mac if offered); `verify-hardening` clean on the signed artifact; a live smoke pass within 7 days for every provider the site names; claims verified; GitHub minutes used recorded against the free allowance.
2. **Flip checklist** (owner steps, following Q6.9; optional): final scan; delete old Actions runs and artifacts; decide the history (decision D) and move `plans/` and `research/` to a private archive; move the licence drafts into place (decision C); apply the settings checklist (6.6); optional stranger test; flip; publish a release so installed copies update; announce nowhere until the owner chooses. This repository is never renamed or removed.
3. **If a secret is found after the flip,** it is burned: rotate, then clean. The checklist lists each secret's rotation steps.

**Ownership.** The checklists only. **Depends on.** Everything above; the Integrator's release candidate. **Acceptance.** Q8.1 complete with evidence links and signed by the owner at the day-25 sign-off (roadmap section 4.3). Q8.2 is optional, and the flip itself is an owner action (decision F). **Estimate.** 2-3 days (the flip checklist is about 1 of them), plus owner time.

**Work packages.** One agent assembles the checklists from the other milestones' evidence; a second audits them by hunting for a line whose evidence is missing or older than its allowed age.

> **What this means:** One final gate stops you shipping when a single check is stale or missing. A second checklist, if you want it, makes going public safe.


## 4A. Google: Testing mode now, review later if ever

The Google project stays in Testing mode (owner, 2026-10-27). That means up to 100 listed test users, an "unverified app" warning on sign-in, and refresh tokens that expire after 7 days (`RC/protocols/proto-google.md` §8.1), so the app asks for a one-click reconnect each week (roadmap decision N3; plan 20 owns the behaviour). Opening Gmail to anyone else needs Google's restricted-scope review (`gmail.modify` and `gmail.settings.basic` are restricted scopes) and a yearly CASA security assessment, which costs money. It is off the plan (roadmap section 8.4), and nothing in the build prevents it later.

What this plan keeps in place so that later stays cheap: the privacy page on aplos.email with Google's Limited Use sentence (Q5A), the scope manifest and its test (plan 20), the no-telemetry rule, and `verify-hardening` output (Q2). The owner's actions are only these, on days 1-3: list the agent test account as a test user, confirm 6,000 units per user per minute in the Cloud console, and check Vercel's production branch.

> **What this means:** Gmail stays limited to people you list, with a weekly reconnect, and nothing here costs money. If you ever want Gmail open to everyone, the paperwork starts from a page and a scope list that are already true.


## 5. Sequencing against the roadmap

Days are the roadmap's calendar days. Phase 1 and Phase 2 overlap on days 11-13.

```
Day, last digit 1234567890123456789012345
Phase 0         ███                      
Phase 1            ██████████            
Phase 2                   ████████       
Phase 3                          ████████
Q1a, Q1b        █                        
Q3 slots, jobs  ████████████             
Q3 journeys                █████         
Q4 build           █████████             
Q4 live runs               █████         
Q0                 █████                 
Q2                 ███████████           
Q2 CSP stage 2             █████         
Q7a                    ███████           
Q7b                        █████         
Q8.1 gate                     ████       
Q6                               ████████
Q5A              ████                    
Q5B                 ████                 
Q5B claims                 █████         
Owner reviews     R     R     R          
Gmail reconnect       W      W      W    
Sign-off                                S
```

1. **The first-day order is the roadmap's restructure chain** (section 4): rename and imports, Q1a, the `electron.ts` split, Q1b. It is one serial chain on day 1, and nothing else touches existing files.
2. Q2 and `eng-host` share their first fused build, so the packaged engine and the new fuses are tested together and then on the local signed feed; the redesigned release carries both.
3. Q3's slots land on days 1-3 so the other lanes can attach checks as they write them.
4. Q6 runs in Phase 3 (days 18-25), after the release candidate, because going public is the owner's later call. It does not block the release.
5. **If time is cut,** drop in this order, last first: the Q6 rehearsal, Q5B, the conditional spike, cross-provider conformance, SBOM and attestation, the `aplos-app://` change. Never drop Q0, Q1, Q2, Q5A, the secret scan or the CI self-test.

> **What this means:** The tidy-up goes first, on day 1, in one serial chain. Safety, CI and release work run in Phase 1 and 2, and the open-source work waits until after the release candidate, because going public is your later call.


## 6. Test strategy

**What counts as evidence.** A command and its output, a CI run, a recorded measurement, a headless screenshot. "Looked fine" never counts. Mocked Google never counts as live acceptance (AGENTS.md); live smoke counts as live for the endpoint, not for the owner's mailbox.

| Layer | Runs | Where | Gate |
|---|---|---|---|
| Format, lint, owners check, typecheck, secret and licence scans | Locally in every lane; every push to `revamp` | Local, Linux | Required |
| Unit and policy tests (228 today, about 6 s); SQLite-touching suites under Electron's Node | Locally in every lane; every push to `revamp` | Local, Linux (macOS list on demand) | Required |
| Embedded-SQLite and portability checks | Changes to engine or contract; the release candidate | macOS, on demand | Required on the release candidate |
| Browser E2E on emulators and fixtures | Every push to `revamp` that touches app code; daily from day 12 | Linux | Required |
| Electron E2E on the E2E variant | On demand; the release candidate | macOS | Required on the release candidate |
| Packaged smoke and `verify-hardening` | Every release run, local or tag | macOS | Required on release runs |
| Visual, contrast, identity (plan 30) | UI changes | Linux or macOS | Required |
| AI replay evals | Every push to `revamp` | Linux | Required |
| AI live evals | Nightly on this Mac; on demand on GitHub | This Mac, GitHub Linux | Advisory, then required |
| Live provider smoke | Scheduled on this Mac, after the weekly reconnect | This Mac | Notice, not a red build |
| Perf and 100k fixture | Scheduled on this Mac and on demand | Packaged build; the shared Mac is noisy | Fails at 3x the budget; the 10% trend runs on the owner's quiet Mac and at release (`budgets.json`) |
| Update matrix; hand checks (OOPIF keyboard, first-launch prompts) | The release candidate; before the mail frame closes | Real Macs | Release gate |


**Rules.**
1. **Headless only.** E2E windows are `show: false`, no Dock icon, temporary data directory, own ports; a test asserts no window is visible. Real-Mac sessions are owner-run or owner-authorized.
2. **Determinism and isolation.** Frozen clock, seeded fixtures, fixed locale, bundled fonts (DESIGN §12.5). No test touches the real data directory, Keychain item or a real mailbox without a named opt-in command.
3. **Data hygiene.** Fixtures are invented; reports and artifacts pass the secret scanner before upload.
4. **Self-test.** The broken-branch fixture (Q3) is re-run when workflows change, so a silently disabled gate is noticed.
5. **Limits that only tighten.** Lint suppressions, bundle size and test time may only shrink or hold.

> **What this means:** Cheap checks run on everything, expensive ones run when it matters, and the ones that need a real Mac are on a list a person can follow.

## 7. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Format commit subtly changes behaviour (JSX whitespace, a moved `@ts-expect-error`) | Low / high | Minified-output equivalence, identical `dist`, tests, packaged `verify-release` (Q1) |
| Format commit collides with other threads' open work | Low / medium | It runs on day 1 in a serial chain while the other threads write new files only; the legacy folders stay read-only reference (Q1) |
| Free CI minutes run out | Medium / medium | Linux only on pushes to `revamp`, macOS on demand, minutes recorded in each PR, local runs first (decision H) |
| Store tests pass under system Node but the app runs Electron's older SQLite | Medium / high | `test:engine` under Electron's Node; floor self-test; `.node-version` equals Electron's embedded Node (Q1b, Q3) |
| The weekly Google reconnect breaks scheduled live checks | High / low | The runner reads `reconnectBy`, skips with a message and posts one notice; the owner's weekly reconnect covers the test accounts (Q4) |
| Secret rotation strands installed copies | Medium / medium | No ritual rotation (ADR 40-11); second secret first if a leak is found |
| This repository is renamed, transferred or deleted after builds are installed | Low / high | Declared permanent as the feed (Q0, Q6.9); the flip checklist forbids it; a history rewrite must keep tags and releases |
| Perf gate flaky on shared runners and the shared Mac | High / medium | 3x gate, 10% trend on the owner's quiet Mac and at release (`budgets.json`) |
| Fuses or asar integrity break the packaged engine, helper or update | Medium / high | Shared first build with resident mode; hostile and positive launch matrix; update test on the local signed feed; fuses are config, reversible in one commit |
| Removing entitlements stops launch on another Mac | Medium / high | Experiment on the second Mac first, and keep today's entitlements if no second Mac is offered (Q2) |
| Existing 0.2.x installs cannot self-update | High / low | Known; builds are installed by hand, and once the repository is public every copy updates itself (Q0) |
| Google blocks the smoke account | Medium / medium | Small call count, a notice instead of a red build, manual-run fallback |
| Groq daily limit starved by CI | Medium / medium | Separate free key, per-run cap, `inconclusive` on exhaustion |
| AI eval flake turns the push gate red | High / medium | Replay gates pushes; live is advisory until ten stable nights |
| Public history exposes the Avec analysis, local paths, a second author identity | High / high | Decision D at flip time, with the scan report in front of the owner: flip as is or rewrite in place; docs split; provenance gate; scrub |
| A secret hides in an Actions log or an old PR ref | Low / high | Scan refs, logs, artifacts; delete old runs and artifacts before any flip; rotate before the first public release |
| GPL blocks a future closed edition | Low / medium | Decisions C and E made knowingly; DCO means later relicensing needs consent |
| A name conflict appears after going public | Low / high | No paid search (owner, 2026-10-27). The research found marks near "Airmail", not "Aplos"; a free database look by the owner is optional |
| CI too heavy for one owner | Medium / medium | Cut order in section 5; the Platform and website thread owns it; size and lint limits that only tighten, the owners check and a self-test replace constant attention |
| The owners check blocks a legitimate cross-lane edit | Medium / low | The owning lane approves with a label the Integrator honours; the Integrator can waive in STATUS.md |
| Vercel's production branch is main, so site fixes wait for the merge | Medium / low | Preview URLs for review; the owner may repoint the production branch or approve a copy-only pull request to main (Q5A) |
| Actions supply-chain attack | Low / high | Pin actions by SHA, read-only default token, no `pull_request_target`, protected environments |
| E2E variant or F8 test mode leaks into a release | Low / high | Compile-time define never set in release CI; `verify-hardening` launches the release with a debug switch and with the test variables and requires normal behaviour |
| Adobe Firefly terms restrict icon redistribution | Unknown / medium | Check terms [U]; the public tree carries only the final icon under separate terms |


> **What this means:** The costliest mistakes to undo, a leaked secret or a published history, get the strongest checks. The rest are guarded by cheap automation.

## 8. Interfaces and contracts with the other workstreams

| With | I provide | I need | File protocol |
|---|---|---|---|
| **Plan 10 (engine)** | Q1a on day 1 as step 2 of the restructure chain, after the rename-and-imports commit; Q1b as step 4 (lint boundaries and the owners check); `verify-hardening`; the E2E build variant; the embedded-SQLite check; the packaged-app harness for resident mode, HTML-isolation vectors and listener refusals; CI slots for OpenAPI golden and portability | The stand-in engine and `Fixture/control` at the freeze (F6); `eng-views` and the seeded store generator; `Session/get` and the diagnostics bundle; the packaged `--selftest` (`eng-host`); drain-on-update and import behaviour for update rows 3, 4, 9 | After the Phase 0 split of `electron.ts`, `plat-release` owns `security.ts` and `updater.ts` and the Engine thread owns the other modules. I add call sites in `lifecycle.ts` and `windows.ts` by REQUEST and never touch lifecycle code. Moves and splits are separate commits. SQLite tests run under Electron's Node (ADR 40-4) |
| **Plan 20 (providers)** | `smoke:live` as a runner over plan 20's own live harness (section 5.4; one evidence format) and the `SmokeProbe` interface; the privacy page text and Limited Use text; the quota-emulator CI journey; `provider-status.json` | The Gmail quota emulator, IMAP fixture, Graph and JMAP fakes (`prov-emu`); adapters callable read-only; `APLOS_*` OAuth env names; the weekly-reconnect behaviour and the `reconnectBy` fact the runner reads | `packages/emulators/` and provider files are plan 20's. `scripts/smoke/` is mine, and its `probes/` folder is the Providers thread's; the runner calls adapters only through their public interface |
| **Plan 30 (UI)** | Prettier, ESLint, stylelint and the `tools/lint/` extension point (`design/` is UI-core's); one Playwright base; CI slots for `check:tokens`, `check:contrast`, `check:identity`, `test:visual`, `test:perf`; journeys J1-J3 and J12; the production CSP and Vite plugin | Design lint plugins; `tokens.json` (F9) for the site; the harness and baselines; a renderer free of inline script for CSP stage 2; a headless way to seed or drive onboarding | `apps/web`: the `web` lane owns it entirely, including styles; UI-core owns `tokens.json` and the site only consumes it. `index.html`: CSP is mine, structure theirs |
| **All** | `npm run check` as definition of done; `.git-blame-ignore-revs`; the owners check; Dependabot; no merge with a red required check | Each plan modernizes the dense files it rewrites; none reintroduces one-line multi-statement code | I own tooling devDependencies in the root `package.json`; others ask by REQUEST. Lockfile conflicts are resolved by re-running `npm install`, never by hand |

**Dates.** The stand-in engine answers every method at the freeze (day 3); `prov-emu` has a Gmail emulator that reproduces 0.2.3's failure during Phase 0, and the real engine passes the conformance suite on day 11; UI-core's tokens (F9) arrive on day 3 and its harness skeleton in Phase 1. A late dependency leaves its journey visible as pending in CI output, never silently skipped.

> **What this means:** Each plan owns its own files and hands over small, named pieces at agreed times. Shared files have written rules, so threads do not trip over each other.

## 9. PR and branch strategy within the revamp

1. **Integration branch.** `revamp`. Nothing goes to `main` without the owner's explicit go-ahead. Lanes open pull requests into `revamp`, and only the Integrator merges them, so this thread never merges its own pull requests.
2. **Branches.** Git cannot hold `revamp/...` refs next to the `revamp` branch, so work branches are `rv/<lane>/<slug>` (`plans/00-roadmap.md` section 7): `rv/plat-ci/q1a-format`, `rv/plat-ci/e2e-base`, `rv/plat-release/q2-hardening`, `rv/web/q5a-truth`, and so on. The coordination branch is `rv/thread/platform`. One branch per work package, each in its own T3 worktree; no branch name is a folder of another, so there is never a branch named exactly `rv/<lane>`. Commits are authored as Kainoa Newton; `git config user.email` is checked before each commit and any other value is reported, not committed.
3. **Mechanical commits** (Q1a) merge by merge commit, never squash, so the SHA in `.git-blame-ignore-revs` survives. Everything else squashes, naming the lane and work package. Order inside Phase 0: the Engine thread's rename and imports, Q1a, the `electron.ts` split, then Q1b.
4. **Workflow changes.** `ci.yml` runs from `revamp` pushes. `release.yml` runs only on tags or dispatch, so changes to it are rehearsed locally with ad-hoc signing and in a private sandbox repository for the Linux steps, with dummy secrets, to spend no macOS minutes. A real signed tag run happens only on the owner's go-ahead.
5. **Main touches and beta tags.** Nothing is authored against main. The redesigned release reaches main when the owner merges `revamp`, and **stable releases are always tagged from main** (RELEASING.md). **Beta tags** (`v0.3.0-beta.N`) are the one exception: they may be cut from `revamp` with `scripts/release.mjs --allow-branch` and published as drafts or prereleases in this repository, on the owner's go-ahead per tag, because Q2 and Q7a cannot be tested without them. They never touch `releases/latest`.
6. **Review and models.** Security-sensitive work (Q2, Q4 credentials, Q6 scans, the Q7 spike) uses a strong model to author and a separate strong-model reviewer who has not seen the author's reasoning. Mechanical work (the format commit, configs, generated notices) can use a cheaper model, always followed by the independent equivalence checks. Website design and copy use a Claude model. Each pull request attaches its evidence (command output, run links, headless screenshots) and lists what it did not verify. Do not re-trigger an external review after every fix; batch fixes and verify locally first (owner preference).
7. **Owner-only actions.** An agent never changes repository visibility, publishes a draft release, merges to main, moves secrets or rotates a production credential.
8. **End state.** The owner merges `revamp` into main and publishes. Later, at the owner's call, the same repository can go public (Q6, Q8.2); the feed never changes.

> **What this means:** Everything lands on `revamp` in small reviewed pieces with proof attached. The risky buttons stay yours.


## 10. What to read first

In this order:
1. `plans/00-roadmap.md` (the owner part, sections 1, 2.5, 2.6, 4, 7, 8 and 10) and Brief 5 in `plans/50-thread-briefs.md`, then `AGENTS.md` and `plans/_council/CONTEXT.md` (owner rules, headless-only, no keys, verified facts).
2. `plans/ARCHITECTURE.md`: §2.5-2.6 (hardening, A1 and Keychain), §3.1 (SQLite check), §6.1 (retries off), §8.3-8.5 (consent, training, injection), §10 (HTML isolation, CSP), §11-12 (diagnostics, security), §14 (open-source readiness), §15 (M0, M1, M10), Decisions 11-12.
3. `plans/DESIGN.md`: §2.5 (renames), §12 (enforcement), §13 (Avec-derived items), §15, Appendix C.
4. Research: `RC/gaps/storage-engine-benchmark.md` (§0, §7: which SQLite each runtime uses), `RC/gaps/macos-daemon-lifecycle.md` (§0, §3, §4, §9), `RC/gaps/electron-email-html-isolation.md` (§0, §7, §8), `RC/protocols/proto-google.md` (§8, §9), `RC/gaps/identity-collision-audit.md` (§0, §3, §8), `research/inbox-zero/SYNTHESIS.md` (weaknesses 6 and 10) and `aplos-architecture.md` (§4-6), `research/pr21-onboarding-review.md`.
5. Code: `.github/workflows/{ci,release}.yml`, `RELEASING.md`, `apps/desktop/package.json` (`build`), `build/entitlements.mac.plist`, `index.html`, `src/main/{electron,updates}.ts`, `scripts/{release-build,verify-release,build-main,fake-update-feed}.*`, `scripts/emulation/`, `scripts/quality/cases.ts`, `tests/{updates,portability,emulation}.test.ts`, `apps/web/src/{release,Landing,Download,Privacy,site}.ts*`, `VISION.md`, `DECISIONS.md:61`, `TODO.md`.

> **What this means:** Start with the rules, then the decisions, then the evidence, then the code.

## External prerequisites (owner actions, not decisions)

All free.

- **Done 2026-10-27:** 6,000 units per user per minute confirmed; the separate free Groq test key is in the Keychain as `aplos-groq-test`.
- **Days 1-3:** list your spare Gmail account as a test user in the Google project; check Vercel's production branch (Q5A); set up a free forwarding address on aplos.email (decision I) [U: the registrar's forwarding or Cloudflare Email Routing].
- **Second Mac time** for the first-launch, entitlement and update tests (Q0, Q2, Q7), when you offer it. Agents SSH there only when you ask.
- **Weekly:** reconnect Gmail for yourself and the test accounts, about two minutes (Q4).
- **GitHub plan check:** the included CI minutes (decision H).
- **Apple portal:** a Developer ID provisioning profile with Keychain Sharing, only if the Q7 spike triggers.
- **Buttons only you press:** publish a release draft, tag a beta, merge `revamp`, flip repository visibility if you choose to, move secrets into protected environments, and (only if a leak is found) retire a Google client secret.

> **What this means:** These are accounts, forms and clicks only you can do, and none costs money. The two that matter in the first days are the test accounts and the Vercel check.


## Evidence index

- Research: `research/email-clients/gaps/{macos-daemon-lifecycle,electron-email-html-isolation,identity-collision-audit}.md`; `protocols/proto-google.md` (§1, §8, §9); `SYNTH-architecture.md` (§10, §12); `research/inbox-zero/{SYNTHESIS,aplos-architecture}.md`; `research/pr21-onboarding-review.md`.
- Plans: `plans/{00-roadmap,50-thread-briefs,ARCHITECTURE,DESIGN}.md`, `plans/_council/{CONTEXT,task-plan-40-platform-quality}.md`; plan 10 sections 4 (E1), 7.3, 9; plan 20 sections 5.4, 7, 9; plan 30 sections 8.3, 10.
- Main at `72095ff` (read-only, for the critique pass): `package.json`, `apps/desktop/package.json` (`build`), `.github/workflows/{ci,release}.yml`, `RELEASING.md`, `scripts/release.mjs`, `apps/desktop/scripts/release-build.mjs`, `apps/web/vercel.json`; `RC/gaps/storage-engine-benchmark.md` §0.
- Repository at `27cf52f`: the workflows, `RELEASING.md`, `apps/desktop/{package.json,index.html,build/entitlements.mac.plist}`, `src/main/{electron,updates}.ts`, `scripts/*`, `apps/web/src/*`, `SPEC.md`, `DECISIONS.md`, `PROGRESS.md`, `TODO.md`, `node_modules/app-builder-lib/scheme.json`, `electron-updater/out/AppUpdater.js`.
- Commands run on 2026-10-27, read-only on the repository: `electron-fuses read`, `PlistBuddy`, `codesign -dv`, an Electron-embedded SQLite probe, `npm test`, `npm ls`/`npm audit`, key-shape `grep -E` over `git log --all -p`, a line-length scan. No credential was read, printed or written.

