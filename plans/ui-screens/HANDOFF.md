# UI-screens thread handoff (Mac → kainoas-linux-mba)

Written 2026-10-28 09:15 PDT, day 2, by the UI-screens thread on the MacBook Pro. The owner decided to move the thread to the Linux box. Same lanes, same branches, same brief: brief 4 in `plans/50-thread-briefs.md`, plus roadmap §5.1a model routing.

## In plain English

All four screen areas are built and run in their own preview galleries on demo data: onboarding with first sync and the weekly reconnect, Calendar, Settings, and Ask with Today, the palette and search. None of them runs against the real engine yet, because UI-core's data hooks are still being built. An adversarial review found real bugs in onboarding (5) and Calendar (13). Fixes were half done when Claude's usage limit stopped every agent at about 08:00. That half-done work is saved on separate "wip" branches, so the main lane branches stay green. The Ask and Settings reviews were cut off before they reported. Nothing has reached the owner yet. Nothing is merged, and nothing is lost.

> **What this means:** Pick up the two WIP fix branches, re-run the two cut-off reviews, then rebase on `revamp` once contract-v1 and F9 (#44) are in.

## 1. Lane state (all pushed; SHAs at handoff)

| Lane | Branch | SHA | State |
|---|---|---|---|
| ui-onboard | `rv/ui-onboard/onboarding` | `abaaee9` | Green: 184 pass, 0 fail, 1 skipped (F11, a ui-foundation fix), plus todos. Window, steps, connect flow, first sync and drill, reconnect flow, zero accounts, demo, Show welcome, gallery and capture script, and the extra gallery states. Not yet linted or Prettier-formatted (30 files to format, 8 lint errors before review fixes) |
| ui-onboard | `rv/ui-onboard/wp-window` | `27c7e46` | Green: 39 tests. WP8.5, the main-process window (`main/windows/onboarding{,.policy}.ts`), `onboarding.patch.md` (a REQUEST to eng-host) and a draft hidden-Electron spec (`// @ts-nocheck` until the e2e base is on the branch). **Not yet merged into `rv/ui-onboard/onboarding`**: merge it after the WIP fixes land |
| ui-onboard | `rv/ui-onboard/wip-review1` | `161b46c` | **Not green.** Review-1 fixes, partial (261 tests, 207 pass, 2 fail; tsc 1 error). Based on `abaaee9` |
| ui-calendar | `rv/ui-calendar/calendar` | `e99d324` | Green: 59 pass, 1 skipped (stack `aria-expanded`, a ui-foundation fix), plus todos. Week, day, month and agenda; detail; RSVP; scope chooser; editor; drag; gallery. Not linted (9 errors, 9 files to format) |
| ui-calendar | `rv/ui-calendar/wip-review1` | `bee5d4c` | **Not green.** Review-1 fixes, partial (84 tests, 58 pass, 1 fail; tsc not checked). The model is being split into `model/`, `keys.ts`, `writes.ts` |
| ui-settings | `rv/ui-settings/settings` | `cd92f1d` | Green: 79 pass, plus todos. All eight sections, a palette entry per row, write-only keys, canary test. ESLint and Prettier clean against revamp's config. Review not done |
| ui-ask | `rv/ui-ask/ask` | `3d52cff` | Green: 90 pass, plus 73 todos. Ask dock, Today, palette, Search. ESLint and Prettier clean. Review not done |
| coordination | `rv/thread/ui-screens` | this commit | Plans: `gap-list.md` (§4 DECIDED, §6 reconciliation with Engine's GAPS.md), the four `map-*.md`, `pr21-absorption.md`, `work-packages.md`, `contract-reliance.md`, `handoff/` (below) |

Fully merged helper branches (kept for history only): `rv/ui-onboard/wp-firstsync`, `wp-steps`, `wp-reconnect`, `wp-states`.

All lane branches are based on UI-core's `rv/ui-shell/contract-swap@1da5496` merged with PR #28's head `9ec6518`. They do not contain `revamp`'s step 4. A trial merge of `revamp` conflicted only in `package-lock.json` and `tools/lint/design/README.md`, which belong to other lanes. PR #28 has since merged, and F9 is PR #44.

## 2. Stopped workflows and how to resume

Every agent stopped at about 08:00 PDT on Claude's usage limit, which reset at 08:00. None of them can be resumed from the Linux box, so start fresh agents with these inputs:

1. **ui-onboard review-1 fixes (Opus).** Check out `rv/ui-onboard/wip-review1`. Findings: `plans/ui-screens/handoff/review1-ui-onboard.md`. The agent had added `WindowNotice.tsx` and `tests/ui-onboard/review1.test.ts` and touched about 20 files. It was about to rework `OnboardingApp.tsx` (the window root: the handoff retry and passing status into the first-sync slot, mounting `ReconnectFlow` for first sync's Reconnect, focus on entering first sync). Run the tests to see which two fail. Finish every finding with a `review1:` regression test, then lint and format the lane (`handoff/uis-lint.sh onboard`), then merge `rv/ui-onboard/wp-window`, then fast-forward `rv/ui-onboard/onboarding`.
2. **ui-calendar review-1 fixes (Opus).** Check out `rv/ui-calendar/wip-review1`. Findings and decisions: `plans/ui-screens/handoff/review1-ui-calendar.md`. It was mid-split (`model/`, `keys.ts`, `writes.ts`) and about to rework `CalendarContainer.tsx` (per-toast undo by opId is finding 3). Finish, add tests, lint and format, then fast-forward `rv/ui-calendar/calendar`.
3. **ui-ask adversarial review (Opus).** Cut off before reporting, with no output saved. Re-run it read-only on `rv/ui-ask/ask`. The brief was the same shape as the Calendar one: checks 1-7 for Ask frames, palette, search exactly-once, Today, keys, copy and glyphs, and layout. See `handoff/brief-screen-lanes.md` for context. Then fix the findings (Opus).
4. **ui-settings adversarial review (Opus).** Same: re-run it read-only on `rv/ui-settings/settings` (checks: secrets, reconnect 24 h rule, AI features and trainsOnInputs, palette reach, remapping, write races, copy). Also confirm the known bug from the converted tests: a provider Test result that lands after leaving the AI page reappears, because `controller.testProvider` has no generation guard. Then fix (Sonnet or Opus).

The free-model test conversions are all finished and committed (ui-ask GLM, ui-calendar DeepSeek, ui-onboard GLM, ui-settings DeepSeek after MiMo stalled).

## 3. Open requests

**From us, still open** (STATUS.md has the full text):
- **ui-foundation** (two batches, 04:20 and later): native-control resets, ProgressSegments' extra live regions (F11), the account dot with one account, the ready label slot, the row action label, ChoiceGroup, ChoiceRow keySource copy, autoFocus without scrolling, the Dialog transform offset, the 24 h TimeGrid, the EventBlock locked flag, EventDetail multi-day times, ReconnectSheet `mode`, the SettingRow anchor, AskTurn (provenance, "Stopped.", a daily-limit line, citation number), Citation empty parts, truncating the palette context line, catalog icons, a hold-release hook, ErrorLine Review rendering filled, the stack `aria-expanded`, day view "+N" for 3+ overlaps (DECIDED), zero-minute overlaps, drag length for midnight-crossing events, RSVP bold width, focus-scoped arrows, a calendar Escape command, and OnboardingStep `demoBusy`.
  - **UI-core status:** fixing these on `rv/ui-foundation/screens-req-{a,b}` (05:22 NOTICE). Resets now live in `ui/base.css`, so our scoped stopgaps in `onboarding.css`, `settings.css` and the galleries can be removed after rebasing.
- **ui-shell:** api gaps. Item (1) is done on `origin/rv/ui-shell/api-gaps@794a9cb` (06:05). Still open: the live registry and context for screens, routes (onboarding window, `settings/<section>#<row>`, open a thread at a message, event, draft, search), a sidebar slot for Calendar's MiniMonth and Calendars list, dock layout, mounting our containers and CSS, and the onboarding route. Our containers reach all of these through ports today, so swap in the real `api` once it lands.
- **eng-contract:** the F6 knobs and scenarios (CONTRACT-CHANGE-PROPOSED); `voice` nullable and `System/notifications {request:true}` (accepted 03:41, landing as the first CONTRACT-CHANGE after v1); a one-off `Ask/run` provider choice, a remote-search row flag, `Window/openOnboarding {step}`, UTF-16 offsets (no answer yet); and the series-scope move semantics question from the Calendar review.
- **eng-host:** apply `onboarding.patch.md` from `rv/ui-onboard/wp-window`, Window methods in the generated table and preload, the `shown` desktop frame, and `menu-bar.ts` calling `focusMain`. Accepted (08:41) for their first PRs.
- **plat-ci:** the test glob for `apps/desktop/tests/<lane>/**`, and e2e pickup of lane specs. The latter is done in PR #42 (08:21); check that it merged.

**To us:** none outstanding. Every "to ui-screens" entry so far is an answer to our own requests.

## 4. Decisions in flight

- **Open for the owner** (only at feature review, never blocking):
  - Lease row per account or one row.
  - Auto-open the mail window after a red-button close of onboarding with accounts connected (WP8.5 doesn't; PR #21 did).
  - Whether Y/M/N should answer while an unanswered invite sits in the Day rail (the review found this harmful; current reading: only after the user selects or opens it).
- **Recorded as DECIDED in STATUS.md:** gap-list §4 items 1-18; the reconnect sheet ownership split; UI lint fixes go to Claude and formatting is a plain tool; the day view "+N" follows DESIGN.
- **For the post-freeze diff:** `contract-reliance.md` lists the contract names we use.

## 5. Next actions, in order

1. Set up worktrees on Linux for each lane branch and run `npm install` once per lane. On the Mac, each extra worktree symlinked `node_modules` to `rv-ui-onboard/node_modules`.
2. Finish the ui-onboard WIP fixes (§2.1), merge `wp-window`, then lint and format.
3. Finish the ui-calendar WIP fixes (§2.2), then lint and format.
4. Re-run the ui-ask and ui-settings adversarial reviews (§2.3, §2.4) and fix the findings.
5. When contract-v1 is tagged and #44 (F9 and the ui-core base) is on `revamp`: merge `revamp` into each lane branch, resolve, run typecheck, and diff `contract-reliance.md`. Then drop the scoped CSS reset stopgaps, swap the ports for real `api` members, and remove the e2e spec's `@ts-nocheck`.
6. Turn the "waits: Playwright base" todos into browser specs (`apps/desktop/tests/<lane>/*.browser.spec.ts`, picked up by #42).
7. When ui-shell's hooks run on the stand-in engine, render each lane in the real shell and re-capture.
8. **Feature loop step b:** a READY-FOR-OWNER post for feature 5 (onboarding and reconnect) first, then 6, 8 and 7. Each needs plain steps, light and dark screenshots of every state (headless), and a recording under 90 s. Give the Providers lead the first-sync screens on `rate-limited`, `backfilling` and `needs-reauth` when asked (feature 1).
9. Keep the free tier for test conversion and mechanical work (roadmap §5.1a). Beam failed because the OpenCode environment sends more than 128 tools, and MiMo stalled, so GLM and DeepSeek have been reliable.

## 6. Previews, tests and gotchas

- **Tests:**
  - Always run from `apps/desktop`: `npx tsx --test tests/ui-<lane>/*.test.ts` (add `*.test.tsx` for calendar and settings). Running from the repo root fails path-relative tests.
  - Calendar tests need `TZ=America/Los_Angeles`. The harness clock is `HARNESS_NOW_MS` (2026-10-29 10:00 PDT).
  - `npm test` doesn't glob lane folders yet (REQUEST to plat-ci).
- **Typecheck:** `npx tsc --noEmit -p .` from `apps/desktop`, about 2-4 minutes.
- **Lint:** `plans/ui-screens/handoff/uis-lint.sh <lane>` (zsh). It copies a lane's working tree onto a scratch `revamp` checkout at `$WT/rv-ui-lintcheck`, which needs its own `npm install`, then runs revamp's ESLint and Prettier. To format: `<lintcheck>/node_modules/.bin/prettier --config <lintcheck>/.prettierrc --write <lane paths>`. `handoff/prettierrc.copy` is the config at handoff time.
- **Galleries** (Vite dev server, from `apps/desktop`: `APLOS_VITE_PORT=<port> npx vite`):

  | Gallery | URL | Ports used |
  |---|---|---|
  | onboarding | `/src/renderer/onboarding/preview/index.html?state=<name>&theme=light\|dark` | 5282 (steps), 5283, 5287, 5288 |
  | calendar | `/src/renderer/screens/calendar/preview/index.html` | 5284, 5289 |
  | settings | `/src/renderer/screens/settings/preview/index.html` | 5285 |
  | ask | `/src/renderer/screens/ask/preview/index.html` | 5286 |

- **Capture:**
  - Run `node <gallery>/shoot.mjs <outDir> --base http://127.0.0.1:<port>`. Add `HOVER=1` for the hover-shift check and `SELFTEST=1` to prove the checks catch planted faults.
  - Playwright is loaded from `PLAYWRIGHT` (default `/Users/knewton/.t3/aplos-research/tools/node_modules/playwright`, which is Mac only). **On Linux, set `PLAYWRIGHT` to a local install** (e.g. `npm i playwright` in a tools folder outside the repo, plus `npx playwright install chromium`). It is always headless.
- **Gotchas:**
  - Stop a dev server only by its port: `kill $(lsof -tiTCP:<port> -sTCP:LISTEN)`. Never `pkill -f vite`; we killed other threads' servers that way once.
  - A fast-forward merge plus `--amend` rewrites the merged commit. Never amend after a merge without checking it made a merge commit.
  - Shell `cd` doesn't persist between calls; use absolute paths.
  - In zsh, `"$F:apps"` is a modifier; write `"${F}:apps"`.
  - Screenshots stay in `/tmp` and are never committed. Every image is looked at before posting. Demo data only.
- **Agent briefs used** (in `handoff/`): `brief-ui-onboard.md` (onboarding UI agents), `brief-screen-lanes.md` (Calendar, Settings, Ask), `brief-test-conversion.md` (free-model test conversion). Every UI agent loads `.claude/skills/aplos-design/SKILL.md` first.

## 7. Local-only files

Nothing unpushed remains:
- **Lane work:** every lane and WIP branch is pushed (§1). `rv-ui-lintcheck` is a scratch copy of `revamp`, nothing to save.
- **Briefs, reviews, scripts:** the review findings, briefs and lint script from `/tmp` are copied into `plans/ui-screens/handoff/`.
- **Screenshots:** only screenshots stay local (`/tmp/uionb-shots/`, `/tmp/uiset-shots/`). They are regenerated by the capture scripts and are never committed.
