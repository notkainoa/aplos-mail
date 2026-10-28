# PR #21 absorption plan (lane `ui-onboard`)

Written 2026-10-27 (day 1) by the UI-screens thread. PR #21 head reviewed: `2d88846` ("Move onboarding into its own window that ends with the first sync"). Re-pin at the lane's start on day 5 (plan 30 risk 10). PR #21 is never merged; the owner closes it as superseded (roadmap §7, plan 30 D4).

## In plain English

PR #21 built the first version of the separate onboarding window. Its ideas are good, but its code is written for today's engine, which the revamp replaces. So we take its screens apart and rebuild them in the new design, file by file, instead of merging the PR. Its engine half goes to the engine team as test scenarios, and each of the 14 problems the review found gets its own test, so none can come back.

> **What this means:** Nothing from PR #21 is merged as-is. Its screens are rebuilt on the new design, and each of its 14 review findings becomes a named test.

## 1. What the PR touches (46 files) and where each goes

| PR #21 path (today's tree) | Disposition | New home / receiver |
|---|---|---|
| `renderer/components/Welcome.tsx` (`Onboarding`, `SyncStep`, `AiStep`, `MicStep`, `useSetupState`) | **Taken by path, rewritten** on F9 components, `api.*` and the Paper tokens. Keep the step machine, the per-step autofocus (`data-autofocus` + rAF), the Esc ladder and the "Retry focuses itself" idea. Drop `AppIcon`, the "Your accounts" title page, `aria-live` on the list (F11), the 700 ms auto-finish without a clean-finish check, the raw `error.message` lines, `invoke(...)` and the `AppState` poll. | `renderer/onboarding/{OnboardingWindow,steps/Welcome,steps/Accounts,steps/Ai,steps/Permissions,FirstSync,Drill}.tsx` |
| `renderer/components/AddAccount.tsx` (`AddAccountForm`, `setup` flag) | **Taken by path, rewritten.** Round 1 shows the Google row only (roadmap §2.2). Discovery moves behind `Account/discover` (plan 10 §7.2). Keep "typed address + Return discovers and focuses the next primary control" (F12). The connect promise must never navigate on a late resolve (F9). | `renderer/onboarding/steps/Accounts.tsx`, `renderer/onboarding/connect.ts` |
| `renderer/main.tsx` (`?onboarding` route) | **REQUEST to `ui-shell`** (owns `main.tsx`): a route that mounts `renderer/onboarding` for `?onboarding=1`, in Electron and in the browser preview. | `ui-shell` |
| `renderer/styles.css` (onboarding rules, +50/−22) | **Not copied.** Rewritten on tokens in the lane's own CSS module. | `renderer/onboarding/onboarding.css` |
| `renderer/Settings.tsx` ("Show welcome", "Load demo mail") | **Not taken.** `ui-settings` (this thread) builds Help → "Show welcome" and the demo rows, calling `ui-onboard`'s exported `showWelcome()` and `Demo/*`. | `renderer/screens/settings/**` |
| `renderer/App.tsx`, `components/Sidebar.tsx` (empty-start Home, demo button) | **Not taken.** The zero-accounts `EmptyLine` is plan 30 §4.5 row 8 (built by `ui-onboard` as a component, mounted by `ui-home`/`ui-shell`). | `renderer/onboarding/ZeroAccounts.tsx` + REQUEST to `ui-home` |
| `main/electron.ts` (`openOnboarding`, `finishOnboarding`, `onboardingWindow`, `onboarding.open/finish` native methods) | **Rebuilt, not copied.** Window creation moves to `main/windows/onboarding.ts` (this lane). Size changes to 640 × 600, min 640 × 520, vertically resizable (PR: 720 × 560, not resizable: F13). No `icon`. `show:false` + `ready-to-show` for the mail window, then fade the onboarding window (F4). Closing calls `Setup/end` always (F1; the PR only finished when no main window existed). Second instance guarded (F3). Hooks into `main/windows.ts` and `lifecycle.ts` by REQUEST to `eng-host`. | `main/windows/onboarding.ts` + REQUEST to `eng-host` |
| `main/preload.ts`, `main/server.ts`, `main/engine-host.ts`, `main/service.ts`, `main/google.ts` | **Not taken.** Allowlists are generated from the registry (F2). The two native methods become contract/native-method entries (see gap list). Google `login_hint` and connect are `prov-gov`'s. | `eng-contract`, `prov-gov` |
| `engine/service.ts` (+90: `setup.run`, `setup.status`, `deferAI`), `engine/demo.ts`, `engine/ports.ts`, `engine/provider.ts`, `shared/types.ts` (`SetupProgress`) | **Handed over, not taken.** Replaced by `Setup/begin|end|status` and `Demo/load|reset|remove` (plan 10 E5 items 5, 7). The `deferAI` set is the root of F1/F2/F6 and is not reproduced. | `eng-ai` |
| `tests/onboarding.test.ts` (193 lines) | **Handed over** to `eng-ai` as its starting scenario list for `Setup/*` (plan 30 U8). | `eng-ai` |
| `scripts/dev-emulated.ts`, `scripts/emulation/{providers,session}.ts` (`--fail-sync`, `--fake-ai`) | **Handed over** to `prov-emu`. The UI uses stand-in scenarios instead (`setup-partial`, `rate-limited`, …). | `prov-emu` |
| `apps/web/scripts/capture-screenshots.mjs` (F14) | **Handed over** to `web`. | `web` |
| `scripts/verify-release.mjs` | Handed over to `plat-release` if still relevant after the restructure. | `plat-release` |
| Other test edits (`accounts`, `ai-keys`, `ask-*`, `calendar`, `devices`, `engine`, `live`, `portability`, `queue`, `service`, `sync-safety`) | Mechanical edits for the PR's engine change. **Dropped.** | – |
| Docs (`API.md`, `DECISIONS.md`, `PROGRESS.md`, `README.md`, `SPEC.md`, `TODO.md`, `.env.example`, `package.json`s) | **Dropped.** `ui-onboard` records its own decisions and progress in its PR. | – |

## 2. PR #21 steps → DESIGN §7.11-7.12 steps

| PR #21 step (`Step`) | New step | Changes |
|---|---|---|
| `start` (no accounts): icon, "Welcome to Aplos.", "Add an account", footnote listing providers | **1 Welcome** | No icon. `display` "Mail and calendar, one letter at a time.", one sentence, filled "Add an account" (Return). No provider footnote (round 1 is Google only). "Try demo mail" stays in the top-right strip. |
| `start` (with accounts): "Your accounts" list + Add another / Continue | **2 Accounts** (list state) | Becomes the Accounts step's "connected" state; no page title in the PR's sense, the step title is sans `heading`. |
| `account` (full `AddAccountForm`) | **2 Accounts** (choose, typed, waiting) | Google row only in round 1. "Waiting for Google in your browser…" with Cancel. |
| `ai` (`AiStep`: provider select + key field) | **3 AI** | Groq preselected; key source line or a field; Test; "Skip for now"; own key and local model behind "More options"; the **consent card** naming provider and model (plan 30 §4.5 row 1). The PR's silent "move text features to the other provider" becomes explicit copy in the consent card. |
| `mic` (`MicStep`) | **4 Voice and permissions** | Microphone, notifications and open at login as quiet rows; hold A / hold R explained in one line each (PR said "hold Space in a reply", superseded by DESIGN §8: hold R). |
| `sync` (`SyncStep`) | **First-sync screen** (§7.12) + optional **Try the keys** drill mode | Checkpoint segments, never a percentage of the mailbox; "Esc opens Aplos" from Connect; auto-open only on a clean finish; partial and failed wording; one `role="status"`; labelled bars. |

## 3. Appendix C findings → tests

Test names are fixed now so the review can grep for them. Engine-side tests live in `eng-ai`; `ui-onboard` adds the UI end-to-end for each.

| ID | Test name (`ui-onboard`) | Layer | Engine-side counterpart |
|---|---|---|---|
| F1 | `F1 reopen via Show welcome, connect, close: Setup/end called, next sync classifies` | Playwright on stand-in + contract log | `eng-ai`: reopen → connect → close → new mail classified |
| F2 | `F2 close after first sync: Setup/end called once, backfill requested` | Playwright on stand-in | `eng-ai`: sync → close → all classified |
| F3 | `F3 second launch during startup opens no second window` | hidden `_electron` | – |
| F4 | `F4 mail window shown only after ready-to-show, onboarding fades in the same callback` | hidden `_electron` | – |
| F5 | `F5 Retry twice during a running pass: one run per click, no collision, counters never decrease` | Playwright on stand-in (`setup-partial`) | `eng-ai`: per-run ids |
| F6 | (UI has nothing to show) `F6 reply during deferral re-summarised` is engine-only | – | `eng-ai` |
| F7 | `F7 two accounts connected: mail window opens on All accounts` | Playwright on stand-in | `eng-ai` stops selecting the account |
| F8 | `F8 failed screen: Esc continues to Aplos` | Playwright | – |
| F9 | `F9 connect resolving after Esc or Back never navigates; list updates in place` | Playwright with `Fixture/control` delayed connect | – |
| F10 | `F10 capped or failed sort never says Done; partial and failed copy shown` | Playwright on `setup-partial` + property test | `eng-ai` reports partial/failed |
| F11 | `F11 exactly one live region; announces phases only; every bar labelled` | Playwright + axe | – |
| F12 | `F12 typed address + Return focuses Continue with Google; Return continues` | Playwright | – |
| F13 | `F13 steps never clip their top at 640×520 with long content; Welcome uses safe center` | Playwright visual + DOM | – |
| F14 | `F14 harness seeds or drives onboarding explicitly; capture never stalls` | Harness | `web` lane fixes its capture script |

Plus plan 30 U8 acceptance 2, the **close-at-any-moment matrix**: `close at step × connect state {idle, pending, connected, syncing, synced}: Setup/end called, no account deferred` (20 cases, generated).

## 4. Order of work (day 5 onward)

1. Re-pin PR #21's head; branch `rv/ui-onboard/pr21-absorb` from `revamp`; copy `Welcome.tsx` and `AddAccount.tsx` into `renderer/onboarding/` **as reference only** (deleted from the branch once rewritten; nothing imports them).
2. WP8.2 steps, consent card, focus and keys (Sonnet) and WP8.5 window patch and `_electron` tests (Sonnet, `eng-host` reviews).
3. WP8.3 first-sync screen and quota scenarios (Opus).
4. WP8.4 reconnect sheet (Sonnet), WP8.6 zero-accounts, demo controls, Show welcome (Sonnet).
5. Adversarial pass: re-run the five-lens review behind `research/pr21-onboarding-review.md` on the new code; every original finding must fail to reproduce.

> **What this means:** The rebuild starts on day 5 from a pinned copy of PR #21, and every original problem is checked again at the end by the same kind of review that found it.
