# Plan 30: UI revamp (workstream plan)

Workstream plan for the T3 UI thread, 2026-10-27, branch `revamp`. Planning only: nothing here goes to main and PR #21 stays unmerged. It implements `plans/DESIGN.md` (Skypaper) in the renderer on the contract in `plans/ARCHITECTURE.md`; both are binding, and "DESIGN §x" or "ARCH §x" points into them. `RC/` means `research/email-clients/`. **Milestone names:** this plan uses plan 10's **E-numbers** (E0-E8) for engine work and plan 20's **PV-numbers**; ARCH's M-numbers appear only in brackets (ARCH M4 is E3 plus E4, M9 is E7, M5 is E5, M6 is E6). Plan 40's milestones are **Q-numbers**.

**Evidence labels.** **[V]** verified by me in a file or by a command on Aplos main at `72095ff` (path or command given). **[C]** a claim in a project or document I did not re-verify. **[I]** my judgement. **[U]** unverified, to be checked live. Counts marked [V] come from `grep` over `apps/desktop/src/renderer` on main.

## In plain English

This is the plan for rebuilding how Aplos looks, moves and responds, from the screens you see to the rules that stop AI coding agents from wandering away from the design. It follows the Skypaper design and the engine plan, which are already decided.

Today the screen code is about 8,500 dense lines. It holds your whole mailbox in memory, has 56 one-off animations and about 70 hard-coded colours, and nothing checks automatically that a screen follows the design. So the first job is guard-rails, and the second is screens built on top of them.

The work runs in ten steps. First come a few days of trust fixes: every word and layout that echoes Avec goes (all seventeen items on the design's list), and ten known bugs are fixed. Then come the foundations: one file that defines every colour, size and motion, checks that fail when someone breaks the rules, and a robot that photographs about ninety screens with no visible window. Then come the new look, the signature "carried off" motion, and each screen in turn.

Onboarding is the PR #21 work reshaped to your wishes: its own small window with the sky edge to edge, a tiny "Try demo mail" button in the top-right corner that loads demo mail only when you click it, and, after setup, a loading screen that fetches your newest mail and sorts it before Aplos opens. Gmail lets an app read only so much per minute. So that screen fetches the newest mail first, tells the truth about progress, and lets you walk in early while older mail keeps arriving.

What changes for you. The trust fixes arrive in about two weeks and the new look around week six. The whole revamp takes about 13 to 14 weeks, or up to 17 if reviews and live checks run slow. That is two to three weeks after the engine plan's eleven. The screens start on a stand-in engine in week two and switch to the real one around week six, so your Gmail days are not disturbed. Four things only you can do: judge the serif font, feel the motion, connect a real Google account through the new onboarding, and try VoiceOver. Nothing goes to main without you.

> **What this means:** One steady path from "looks and reads a bit like Avec" to "clearly Aplos", with a safety net first, a visible check at the end of every step, and your hands-on judgement asked for exactly where a machine cannot give it.

## Decisions for you

Each has a recommended default; the plan proceeds on the defaults unless you say otherwise. Answers to 1, 4 and 10 matter soonest.

| # | Question | Options | Recommended | What happens |
|---|---|---|---|---|
| 1 | Ship the trust fixes (step U0) to main early? | (a) Yes, with 0.3.0; (b) yes, plus a three-colour interim palette (ink blue, moss green, cool canvas) so the early release already looks less like Avec; (c) hold everything for the big release | **(a)** | (a) You get the plain wording and ten bug fixes in about two weeks, at the cost of a small merge. (b) changes the look early but half-changed screens may feel odd. (c) leaves the old wording for months. |
| 2 | Who picks the serif, and when? | (a) You, from a one-page look test at the start of U3; (b) Newsreader without a test | **(a); no answer in two days means Newsreader** (DESIGN decision 3) | The test costs a day. Skipping risks a look you dislike, though changing it later is a one-token edit. |
| 3 | When do the screens switch from the stand-in engine to the real one? | (a) As soon as the real engine's live lists pass the same tests as the stand-in (about week 6-7); (b) at the very end (the earlier plan) | **(a)** | (a) lets the engine team finish its clean-up on time and shows you real mail in the new screens sooner. (b) delays the engine's last step and the 0.4.0 release by weeks. |
| 4 | What happens to PR #21? | (a) Absorb its screens and you close it as superseded; (b) merge it first, then rework; (c) discard it | **(a)** | (a) keeps its work and avoids a throwaway merge; its engine half is rebuilt by the engine plan. (b) puts a screen on main that is rewritten weeks later. (c) loses working code. |
| 5 | Where do visual baselines live? | (a) A small golden set in the repository plus same-machine comparison against the base branch; (b) every baseline committed (DESIGN 12.5) | **(a)** | The repository stays small and immune to macOS font updates. (b) adds tens of megabytes per refresh to a repository that may go public. |
| 6 | May the UI thread design the small missing surfaces in section 4.5? | (a) Yes, inside Skypaper's parts, you read the copy at the U7 and U8 reviews; (b) stop and ask each time | **(a)** | Asking would stall small items; the risk is wording, which you will see. |
| 7 | Tap versus hold on R and A. | (a) R opens the reply instantly and holding adds dictation, one 250 ms threshold replacing today's three; (b) keep tap-on-release | **(a)** | (a) removes the small wait the design forbids. Today's way delays every tap by the threshold. |
| 8 | How do you try each milestone? | (a) A local packaged build; (b) the dev server only | **(a)** | It shows real fonts, vibrancy and windowing, where surprises hide. |
| 9 | A seven-day dogfood week before anything is proposed for main? | (a) Yes; (b) no | **(a)** | A week of real mail finds what a harness cannot. Skipping saves a week and risks a surprise. |
| 10 | How does the onboarding window look? | (a) The sky fills the whole window including under the title bar, and one paper sheet sits on it with a 16 px margin; (b) text straight on the sky, no sheet; (c) the design's original smaller card with sky around it | **(a)** | (a) gives the Arc, Dia and Zen full-bleed feel and keeps text on a solid background. (b) puts text on a gradient, which DESIGN section 14 warns against. (c) is calmer but not full-bleed. |
| 11 | After setup, does Aplos open by itself? | (a) Yes, about one second after your newest mail is in and sorting finished or hit its 60 second limit, but it waits for you whenever something went wrong (Google slowing down, a failure, partial sorting); (b) always wait for Return | **(a)** | (a) matches "loading screen, then inbox" and never hides a problem. (b) is more predictable but adds a click on every happy path. You can always enter early either way. |
| 12 | When is 0.4.0 released? | (a) Once the engine's seven-day soak and the UI's dogfood week pass together on one release candidate (about week 14); (b) the engine at week 11 with unfinished screens | **(a)** | (a) ships one coherent release and uses one week for both checks. (b) is earlier but ships a half-new look. |

> **What this means:** If you say nothing, the plan follows every default above. The three new questions (10 to 12) are about the onboarding look, whether Aplos opens itself after setup, and when the release lands.

## 1. Scope and non-goals

**In scope** (everything in `apps/desktop/src/renderer`, plus the few non-renderer files named in §5):

1. **Tokens and theming:** `tokens.json`, its generator, light, dark and Increase Contrast, density, and the bridge from the old variables (DESIGN §4, §12.1).
2. **The motion system and its enforcement:** runtime, lint rules, the `aplos-design` skill, filmstrip tests (DESIGN §4.8, §5, §12).
3. **The component library** (DESIGN §6), **every screen** (§7), the `CommandRegistry`, palette and search (§7.9, §8).
4. **Migration from whole-`AppState` to live windows:** typed client, a final-shaped data layer, a temporary adapter, cutover.
5. **The email HTML frame, UI side** (ARCH §10).
6. **Onboarding and the first-sync loading screen:** absorb PR #21's screens (not its engine half) and fix its 14 findings (DESIGN §7.11-7.12, Appendix C), shaped to the owner's wishes (§5 U8).
7. **Removing every Avec-derived layout, phrase and decision** (all 17 items of DESIGN §13, accounted one by one in U0), **accessibility** (§11), and the **visual and performance harnesses** (§12.5-12.6).

**Non-goals.**

- No change to what the engine stores, syncs or sends. Needs from the engine are stated in §8; plans 10 and 20 deliver them.
- No redesign: DESIGN.md is binding. Gaps (§4.5) are filled inside Skypaper's grammar and flagged.
- No Windows, Linux or phone UI, no new AI features, no telemetry.
- No release engineering, CI provisioning or website copy (plan 40). `apps/web` is touched only for the accent and the Airmail-to-PostEdge rename (DESIGN §2.5).
- No merge of PR #21 and nothing to main. No reference code, assets, branding or wording (DESIGN §14); reference colours appear only as numbers in the identity check.

> **What this means:** This plan builds the app's face and hands. It asks the engine team for specific things and does not reach into their files. It also does not decide the look again, because that is settled.

## 2. Starting point (measured)

All [V] unless marked, on main `72095ff`, `apps/desktop/src/renderer`.

| Fact | Value | Why it matters |
|---|---|---|
| Size | 8,534 lines, about 375 KB; `App.tsx` 63 KB with 76 lines over 200 characters | Dense one-liners resist mechanical edits; plan 40's formatter commit lands first (§10) |
| Engine calls | 53 `invoke(` sites in 15 files; `bridge.ts` is a hand-rolled fetch fallback with no token | The typed client replaces them (U2) |
| Mailbox model | `App.tsx` loads 400 threads, then pages of 2,000 until all are in memory; `shared/live.ts` re-snapshots on a gap (`RC/gaps/engine-contract-rpc-stack.md` §1) | Becomes windows (flip in U5's WP5.6; scaffolding deleted in U9) |
| Engine imports | Renderer imports `engine/discover` (2) and `engine/provider` (1) | Plan 10 E1's import codemod rewrites them during the move; U2 puts them behind `Account/discover` |
| Literals | 70 hex, 57 `rgba(`/`hsl(`, 56 `@keyframes`, 62 `setTimeout`, 41 radius px, 60 font-size px (token files included) | Lint ratchet baseline (U1) |
| Banned phrases | 18 source lines ("Todo", "Hold to talk", "Swipe through", "Hide all", "Ask me anything") | U0 |
| Hold timings | 300 ms (`App.tsx:379`), 250 (`Compose.tsx:15`), 220 (`Ask.tsx:16`) | The registry unifies them (§4.2) |
| Tests | 36 `node --test` files, engine and pure logic only; **no renderer test, no Playwright, no `lint` script** | U0 and U1 build all UI test infrastructure |

The tap-versus-hold logic is the one place where today's code makes input wait: in the reader Space acts only on keyup (`App.tsx:396`), and in Ask's field the typed letter is held back (`Ask.tsx`). DESIGN §5 rule 1 forbids that; §4.2 resolves it.

> **What this means:** The current screens work, but they are one dense block with no automatic checks and no UI tests. The first two steps therefore build the safety net, and the rest rides on it.

## 3. Shape of the work

### 3.1 Principles for this workstream

1. **Safety net before screens.** Tokens, lint, the harness and the registry exist before any screen is rebuilt (U1).
2. **Build against the final data shape.** Screens use `useView`, `useRow`, `api.*` and receipts, first against the fixture engine, then the real one after the flip (§4.1).
3. **One review packet per milestone:** headless screenshots in both themes, a filmstrip where motion changed, test output paths, open questions. Evidence goes in `PROGRESS.md`; TODO items are checked only with evidence (AGENTS.md).
4. **Headless only** (owner rule), and **two stages where the engine lags:** the UI ships first behind an interface with a labelled interim path, then flips (U6's `srcdoc` frame, U8's onboarding engine calls, and the data flip in U5).

### 3.2 Timeline and critical path

Weeks are nominal elapsed time for one UI thread orchestrating parallel workflows, counted from the day the `revamp` integration branch accepts implementation work, on the same clock as ARCH §15 (M0 week 0-1 ... M10 week 10-11), plan 10 (E0-E8, about 11 weeks), plan 20 (PV0-PV11) and plan 40 (Q-numbers). Numbers run U0-U9 but **U8 runs before U6 and U7**, because onboarding needs only U3, U4 and E5, and it is the screen that makes the first real Gmail sync honest.

| Milestone | What | Weeks | Needs from other plans (E = plan 10, PV = plan 20, Q = plan 40) | Estimate (working days) |
|---|---|---|---|---|
| U0 | Trust and identity fixes on today's renderer | 1-2.5 | **E1's 24-hour freeze window finished** (main with 0.2.4 merged, rename, Q1a format, contract skeleton, typed-client codemod, Q1b), the first days of week 1 (plan 10 §9) | 3-5 |
| U1 | Foundations: tokens, lint, skill, registry, harness | 1.5-3.5 | Q1 lint baseline (U1 adds its rules in `tools/lint/`) and Q3's pinned Playwright base. No engine need | 7-10 |
| U2 | Typed client and the data seam | 2.5-4 | **E1 complete: contract frozen (gate C1), `packages/contract-fixture` serving windows, conformance suite, codemod merged** (end of week 2) | 4-6 |
| U3 | Identity: palette, serif, paper, components | 3.5-5.5 | U1; serif decision. No engine need | 8-12 |
| U4 | Motion signature | 5.5-7 | U2, U3. No engine need (fixture) | 6-9 |
| U5 | Shell, Home, Later, lists, toasts, states, **flip to the real engine** | 6-8.5 | U4. Screens use the fixture. **WP5.6 flip needs E3 acceptance** (real windows, conformance green, week 6) and PV2 status values | 9-11 |
| U8 | Onboarding, first sync, consent, sky moments | 7-9 | U3 and U4; the fixture's `Setup/*` and `Demo/*` from week 7; **E5** (real `Setup/*`, consent, empty start, `Demo/*`; weeks 5.5-7.5, needed by about week 9); **PV3** first-sync checkpoint facts (weeks 3-6); PR #21 | 6-9 |
| U6 | Reader, mail frame, compose, outbox UI | 7.5-10 | U5; **E4** for the real frame (weeks 4-7.5, `srcdoc` stopgap until then); **E6** for submissions (weeks 6-8) | 8-12 |
| U7 | Palette, search, Ask, Settings, Calendar | 9-11.5 | U5; E5 (provider table, Ask frames, settings fields), **E7** diagnostics methods (weeks 9-10, behind a capability flag), PV9 calendar fields (weeks 8-9) | 8-12 |
| U9 | Cleanup, accessibility, performance, release candidate | 11.5-13.5 | **E7** (HTTP binding), E3 flip done; Q3 CI and a packaged build; PV11 live providers for the dogfood week | 7-10 |
| **Total** | | **13-14 weeks nominal** (pessimistic 17) | | **66-96 days** |

**Reconciliation with the other timelines.**

- **DESIGN §15 (5.5-8 weeks)** counts design delivery only. Its five stages map to U0 (stage 1), U1 (stage 2), U3 (stage 3), U4 (stage 4) and U5-U8 (stage 5). This plan adds the typed client and data layer (U2), the engine-dependent states, the live flip, accessibility and the performance suite [I].
- **ARCH §15 (about 11 weeks, M0-M10)** is the engine. The UI trails it by two to three weeks. The **Gmail daily-driver gate (ARCH M3, week 5)** lands before the new look, so the owner runs the old UI, plus U0's fixes if shipped (Decision 1), during weeks 3-8; from the flip (about week 6-7) the owner can try the new screens on real mail.
- **Honest range.** The day estimates sum to 66-96 days, which is 13-19 weeks if done in a row; 13-14 calendar weeks needs real fan-out in U3, U5, U6 and U7 and prompt owner reviews. The pessimistic 17 weeks assumes review waits of about two days per milestone, one failed live check, and a serif or motion rework [I].
- **One release.** The engine's release soak (E8; a rehearsal runs in weeks 10-11) and the UI's dogfood week (U9) run on the same release candidate in weeks 12.5-13.5, so 0.4.0 (ARCH M10) moves from week 11 to about week 14 (Decision 12; recorded as an ARCH amendment on 2026-10-27; the master schedule is `plans/00-roadmap.md`). E8's shim removal (`assembleLegacyState`, legacy `state.get`) is unblocked by the flip in U5, not by U9.

**Critical path.** Q1 and E1 (end of week 2) gate U2; E3 gates the flip (WP5.6); E5 gates U8; E4 and E6 gate the real parts of U6; E7 gates the last of U9. U1's four packages (tokens, lint, registry, harness) are independent; U3 fans out per component family; U5-U8 fan out per screen once U4 lands. The UI can start real screen work in week 2 against the fixture; if C1 slips, U0, U1 and U3 (about 4 of the first 6 weeks) proceed without the engine.

### 3.3 How a work package is written

Each milestone below lists **work packages (WPs)**. A WP is one Claude Code workflow node: a brief, files it may touch, a definition of done, and an adversarial verifier.

- **Fan out:** separate agents on disjoint files, one integrator. **Verify adversarially:** a separate agent with no sight of the author's reasoning tries to break the result and reports evidence.
- **Models** follow the owner's rule: Claude models for UI. Opus 5.5 for complex or high-visibility work (data layer, reader, mail frame, motion, Home, Calendar layout); Sonnet 5.5 for routine screens and mechanical migration; Haiku 5.5 for greps, test runs and summaries.
- Every UI WP loads `aplos-design` once it exists (U1), `DESIGN.md` §3-§5 before then. The installed `emil-design-eng`, `animate` and `break-ui` skills are reviewer aids, not substitutes.

> **What this means:** About 13 to 14 weeks end to end (up to 17 if things run slow), finishing two to three weeks after the engine work. Your real Gmail work is not blocked in the meantime, and each step is small enough to review and reverse.

## 4. Technical designs that cross milestones

### 4.1 The renderer data layer and the move from `AppState` to windows

**Target.** The renderer holds no mailbox: an ID-keyed row cache per type, watched windows of at most 200 body-free rows, small singletons (`Session`, accounts, folders with counts, settings, calendars) and an optimistic overlay (ARCH §9.2). Opening a window costs 0.1-0.5 ms in the engine at 100k threads [V `RC/gaps/engine-contract-rpc-stack.md` §3.2].

**Modules** (all under `renderer/data/`, owned by this plan):

| Module | Job |
|---|---|
| `client.ts` | Wraps the generated typed client. Transport: a `MessagePort` from preload in Electron, the tokenised HTTP and SSE binding in the browser preview. Sets `z.config({jitless:true})` (the CSP forbids eval, ARCH §9.3). Replaces `bridge.ts`'s `invoke`. |
| `rows.ts` | Row cache by type and id, reference-counted by windows and components; an unchanged `rev` keeps object identity. |
| `windows.ts` | `useView(spec, {holdIds})` returns `{ids, total, rows, move, state}` over a `WindowSource` interface with one implementation, `engineWindows` (`View/watch`, `View/move`, `View/unwatch`), which talks to the fixture engine until the flip (WP5.6) and to the real engine after. A second implementation, `compatWindows`, exists only as a contingency (see `compat.ts`). Reopens on `reset` or `cannotCalculateChanges`; fetches only unknown or stale rows. |
| `optimistic.ts` | Overlay entries `{opId, targets, patch, originalPosition}` applied synchronously; dropped when a window reaches `receipt.appliedState`; on failure the row returns with an inline error and Retry (DESIGN §5 rule 11). Undo calls `Operation/undo`, an inverse operation. |
| `session.ts` | `Session/get`, `apiVersion` check, capability flags, status vocabulary (ARCH §6.4). |
| `compat.ts` (contingency) | Builds windows from today's `state.get`, `threads.page` and events. **Not built by default**: plan 10 E1 deliverable 6 ships a fixture engine that already serves windows, so screens use `useView` over the fixture from week 2. It is written only if E3 slips more than two weeks past week 6 and the owner wants new screens on real mail meanwhile (Risk 1). |

**Strangler order.**

1. **U2.** Plan 10 E1 runs the mechanical codemod from `invoke('x')` to the typed `api.*` over the renderer call sites inside its 24-hour freeze window (plan 10 §9, E1 deliverable 3); **U2 does not repeat it**. U2 verifies the result (the `grep` below), fixes what the codemod could not type, moves the renderer's `engine/discover` and `engine/provider` uses (which E1's import codemod already rewrote to `@aplos/engine/discover` and the contract's legacy types) behind `Account/discover`, and builds `data/`. Nothing in U0 touches an `invoke(` call site.
2. **U5-U8.** Every screen uses `useView`, `useRow` and `api.*` over the fixture. An ESLint `no-restricted-imports` rule (added in U2) forbids `AppState` and `shared/live` in screens. The old UI keeps running on the engine's legacy bridge (E2b) for the owner's daily driving. **Release rule:** until the flip, screens that run only on the fixture are reachable only behind a development flag; any beta or stable build cut from `revamp` before the flip (0.3.0 included) uses the legacy loader on the bridge, so a release never shows demo data in place of real mail.
3. **The flip (WP5.6), right after E3 acceptance (about week 6-7).** `WindowSource` switches from the fixture to the real engine by one flag; the same conformance expectations hold because both engines pass plan 10's suite. Plan 10 deletes `latestState` in E3 itself (weeks 4-6), not at the end of this plan. After the flip, plan 10's E8 may remove `assembleLegacyState` and legacy `state.get`, so the UI reports "fully on windows" at the flip, not at U9.
4. **U9.** Delete the `refresh()` loader in `App.tsx`, `bridge.ts`'s web fallback, the renderer's use of `shared/live`, `legacy.css` and (if written) `compat.ts`.

**View specs the UI requires** (plan 10 owns the SQL; the UI states the need). Today's `threadInView` and `isHomeNew` in `shared/mailbox.ts` become these:

| Spec | Used by |
|---|---|
| `home` sections `new`, `due`, `waiting`, ordered by rank bucket (`important`, `normal`, `low`) then date, account `all` or one id. **Done on mail that still needs a reply leaves Home** (DESIGN decision 6), so `shared/mailbox.ts` changes in U0 and the SQL spec follows | Home |
| `home.low` grouped by sender (per-sender counts, latest names for the band's "up to three") | Low-importance band and sheet |
| `later` by overdue, today, week, someday; `bookmarks` | Later |
| `mailbox` by role or label id (keyset) | Lists |
| `search` with parsed operators, `local` or `remote` (remote only on Return, ARCH §3.4) | Search |
| `thread` messages and `MessageBody/get` | Reader |
| Folder counts: unread threads, Home New, Later due now | Sidebar |
| `Event/query` by range and calendars; today agenda; conversations | Calendar, Today, Ask |

**Holding still, in two halves.** DESIGN's `hold` (rows pinned by transform for up to 1,200 ms) is the renderer half; the contract's `holdIds` is the engine half. During a hold the renderer queues incoming frames and renders the held order, then reconciles with FLIP (`close`). It sends `holdIds` for the rows around the cursor so an AI re-rank cannot reorder them [I]. Frame arrival never moves the row under the cursor (DESIGN §5 rule 6).

**Pop-out windows** (`?thread=` and `?draft=` today, `App.tsx:38`) get their own port and the same hooks. **Binary data** (attachments, audio) moves as a transferable `ArrayBuffer` or blob route, never base64; `useVoice.ts` follows, with a shim until the contract supports it.

**Acceptance for the seam.** A property test applies random sequences of optimistic commands, receipts, window frames, `reset`s and undo, and asserts the cache converges to engine truth with no duplicate or lost row. It covers receipt-before-frame, frame-before-receipt, reset mid-overlay, and two windows holding the same row.

### 4.2 `CommandRegistry` and the input pipeline

**Registry.** One table, `renderer/commands/registry.ts`. Each command has `id`, `label`, `icon`, `keys` (per context, remappable), `contexts`, `when(ctx)`, `run(ctx)`, `holdRun?(ctx)`, `undo?`, `confirm?` and a palette `group`. It is the only source for: the key handler (replacing `keyboard()`, `App.tsx:362`), the palette, menus, tooltips, the shortcut sheet and toast keycaps (DESIGN §6 `CommandRegistry`).

**Resolver.** A pure function `resolve(event, contextStack, bindings, prefs)` returns `{command, phase}` or nothing. It is table-tested (Superlocal's idea, `RC/ui/superlocal.md`). Rules, all from DESIGN §5 rule 16 and §8:

- Never act while `isComposing`; use `event.key`; ignore Caps Lock. Single-key shortcuts are off in text fields (globally switchable, WCAG 2.1.4).
- The context stack comes from `data-keyctx` attributes on the focused element's ancestors plus the route: global, list, home, reader, compose, ask, calendar, palette.
- A binding exists once per context; a test fails on a duplicate (this finds today's `keys.s` double assignment, DESIGN §8).
- A capture-phase queue replays keys that arrive during a mount or transition on the next frame (DESIGN §5 rule 4).

**Tap versus hold without waiting** (the one place this plan interprets DESIGN rather than copying it [I]).

- DESIGN §8 says "tap to act; hold to say it" and §5 rule 1 says state commits on keydown. They agree if the tap action starts on keydown and a hold *upgrades* it.
- **R:** keydown opens and focuses the inline reply; a hold past the threshold starts dictation into it. **A:** keydown opens and focuses Ask; a hold dictates. **Space** in a list or the reader is the suggested action on keydown and is not a hold key; in an empty compose body, hold Space dictates.
- In Ask's own field the letter is inserted on keydown and removed if the hold completes, so typing never waits (today's code holds the letter back).
- One threshold setting, default 250 ms, replaces today's 300, 250 and 220 [V]. The design lead confirms the default at the U4 review.

**Remapping and the sheet.** Settings → Keyboard (U7) edits bindings stored in the engine's settings object (§8). The shortcut sheet is generated from the registry; a test asserts every command is in the palette and the sheet.

### 4.3 The motion runtime

`ui/motion.ts` is generated from `tokens.json` (durations, easings, springs with their `linear()` strings) plus hand-written runtime modules next to it:

- **`ghost.ts`.** Clones the leaving element with fixed geometry, removes the real one, animates the clone with WAAPI (`transform`, `opacity`). At most three ghosts; a fourth finishes the oldest. Reduced motion maps `flight` and `carry` to an 80-120 ms fade.
- **`holdGate.ts`.** Starts on a triage key, releases 450 ms after the last key or when the pointer leaves the list (cap 1,200 ms); rows below are pinned by transform. Release runs `close`, a FLIP computed from **fixed row heights**, so no measuring and virtualisation does not matter.
- **`rapid.ts`.** Rapid mode starts when triage keys arrive under 300 ms apart; from the fourth key in a second, `flight` becomes a 60 ms `carry`.
- **`spring.ts`.** A JS solver keeping value and velocity so a gesture retargets mid-flight; compiles each spring to its `linear()` string; stops on `pointercancel`, pauses when hidden.
- **`cursor.ts`.** One shared cursor layer moved by transform; 0 ms on key repeat and pointer moves.

**React stays out of the frame loop.** The list cursor and selection live in a small external store read with `useSyncExternalStore`. The cursor layer moves imperatively. Triage commits the overlay synchronously and re-renders only the virtualised window of roughly 30 rows. This is what makes "key to state 8 ms or less" credible [I]; U4 measures it.

**Enforcement.** The lint rules (DESIGN §12.2) reject literal durations, easings and layout-property animation. A harness assertion walks `document.getAnimations()` during every filmstrip and fails if any animation's keyframes touch anything but `transform`, `opacity` and the hover colour properties.

### 4.4 The email HTML frame on the UI side

The engine's `packages/mail-html` sanitises; main serves `aplos-mail://m/<token>` with headers; the UI owns the host component (`renderer/mail/MailFrame.tsx`). The design is `RC/gaps/electron-email-html-isolation.md` §7 and §9, adopted by ARCH §10.

**Component contract** (`MailFrame` props: `messageId`, `imagePolicy`, `findQuery`, `onReady({height, bg})`, `onKey`). It supports two sources behind one interface.

1. `srcdoc`, the M0 stopgap: a same-origin frame with no scripts and an inner meta CSP (ARCH §10 "Stopgap"). Height is read synchronously. This ships first so the reader is complete without plan 10's E4 (ARCH M4, HTML half).
2. `aplos-mail`, the final form: sandboxed `allow-scripts allow-popups`, no `allow-same-origin`, no preload, one hash-pinned reporter script.

**Host duties** (from `RC/gaps/electron-email-html-isolation.md` §9):

- **The double buffer completes on a message, not a layout read.** Expect 15-70 ms; 1.5 s is a ceiling only. Mount the pending frame at the final width and ignore reports of another width. The previous letter stays until the new one reports; after 1.5 s show the 12 px "Loading Maple Library…" line (DESIGN §5 rule 10).
- **Accept a message only when** `event.source` is the frame's `contentWindow`, `origin === 'null'`, the token matches, and `h` is finite and clamped to 1-200,000. Parse `bg` strictly. A unit test feeds spoofed messages.
- **The paper tint arrives with the height.** HTML mail sits on a light paper (`color-scheme: light`); plain text follows the theme and renders as escaped host DOM, no frame. Keep one hidden warm frame so J/K never pays the roughly 65 ms cold start. Never animate frame height.
- **Key relay.** Main's `before-input-event` sends `mail-key` events to the registry (ARCH §10); arrows, Space and Page keys scroll the reader; Esc returns focus. Whether it fires for out-of-process frames is **[U]**, hand-checked in the packaged app before U6 closes (§6.5). The fallback relays J/K, scrolling and Esc only, never E, Space or R.
- **Chrome stays outside the frame:** "Load images from this sender" and "N trackers removed"; changing policy or find query re-renders with a new token through the same buffer.
- **Quoted text.** The `<details>` toggle is in the document. For the O key, either re-render with a new token or let the one hash-pinned reporter accept a verified `{token, toggleQuotes}` message. The second is smoother and needs plan 10's approval (§8) [I]. Pop-out and print use a `WebContentsView` with `javascript:false` (main).

### 4.5 Surfaces the architecture implies and DESIGN does not draw

ARCH adds behaviour that needs a screen DESIGN §7 does not draw. Each is named here with a treatment built from existing Skypaper parts (no new colour, radius, button style or glyph); the design lead should glance at the copy.

| # | Surface (source) | Treatment | When |
|---|---|---|---|
| 1 | **Consent card** before background AI (ARCH §8.3) | A `Paper` card in the onboarding AI step: provider, model, what is sent, a note that Ollama and LM Studio stay on the Mac, filled "Allow", text "Not now". A provider change shows an `ErrorLine` in Settings → AI ("Background summaries are paused until you agree to the new provider.", filled "Review"). Nothing on the mail surface. | U8 |
| 2 | **Settings rows:** per-account "Use this account's mail for AI" (ARCH §8.3); "Background work runs on: MacBook Pro" with "Use this Mac" (§6.5); retention "Keep message text for 90 days, plus anything opened, starred or unread, up to 2 GB" (§3.6); daily AI cap with "Paused for today. Resumes tomorrow." in Settings only (§8.4); "Keep Aplos in the menu bar when the window closes" and "Open Aplos when you log in" (§2.2) | Plain `SettingRow`s; the menu-bar menu and quit prompt are native | U7 |
| 3 | Diagnostics and queue inspector (ARCH §11) | Help: "Export diagnostics" opens a `Dialog` previewing the content-free bundle; an inspector page lists ops, jobs and submissions with Retry and Discard; the parked engine is a `FatalScreen` ("Try again", "Export diagnostics") | U5, U7 |
| 4 | Submission states (ARCH §6.3, §7.1, §7.3) | In the `UndoTray` slot: "We could not confirm this was sent. Check Sent, or Send anyway." / "Missed its time while your Mac was off. Send now or Reschedule." / "Couldn't send until 2:14 PM. Your draft is saved." | U6 |
| 5 | Draft edited elsewhere (ARCH §7.4) | Inline card: "This draft changed on another device." with "Keep mine", "Take theirs", "Keep both" | U6 |
| 6 | Status vocabulary (ARCH §6.4) | StatusSlot copy per state (table in U5) | U5 |
| 7 | iCloud and Fastmail add-account presets (`RC/protocols/proto-others.md` §5) | Preset copy for app-specific passwords and username rules | U8 |
| 8 | **Zero-accounts state and demo controls** (PR #21 "start empty, demo only on request") | With no accounts the mail window shows one `EmptyLine`: "No mail yet." with filled "Add an account" and text "Try demo mail". Settings → Help gets "Load demo mail" or "Reset demo mail", and demo accounts can be removed like any account. Never shown while a first sync is running | U8 |
| 9 | **Show welcome again** (today's Settings entry; the F1 and F9 reproductions need it) | Settings → Help, "Show welcome": opens the onboarding window beside the mail window without changing anything | U8 |
| 10 | **First-sync honesty rules** (ARCH §5.1, §6.4; plan 20 `baseline_done_at`) | While an account is backfilling or paused, an empty Home shows `EmptyLine` "Your first mail is on its way." with the status slot's reason, never the "all clear" sky moment (DESIGN §7.16 moment 3 fires only with status `ok` and the baseline done) | U5, U8 |

> **What this means:** The data layer, the key system, the motion code and the email frame are each designed once, up front, so ten milestones do not invent ten versions. Ten small groups of screens that the engine plan or PR #21 imply and nobody drew now have a stated home.

## 5. Milestones

Every milestone has the same fields: goal, deliverables, ownership, dependencies, acceptance evidence, estimate, work packages. "Owns" means this plan edits the path freely; "touches" means a small, reviewed edit coordinated with the owning plan.

### U0. Trust and identity fixes on today's renderer (3-5 days, weeks 1-2.5)

**Goal.** Remove everything that makes today's screenshots read like Avec, retire the decisions that told agents to copy it, and fix the ten known defects, without changing the architecture. Aplos needs its own identity from the first release it ships. U0 is shippable on its own (Decision 1).

**The 17 Avec-derived items of DESIGN §13, accounted one by one.** Line numbers in DESIGN §13 are from before plan 40's format commit and **will shift**; locate each by its string (the ban test and the DOM scan find them), not by line. "Interim" means a smaller change now that U3 or U6 finishes.

| # | Item (DESIGN §13) | Done in | What U0 does |
|---|---|---|---|
| 1 | "Swipe through them" pill beside "New" (`App.tsx:498`, used at `:510`) | **U0** | Text "Go one by one", S on hover; `Button variant="pill"` stops being used here |
| 2 | Floating bottom cluster: bookmark, Todo, big Reply/Space pill, Done, Undo circle (`Reader.tsx:175-186`, `reader.css:313-321`, `.dock-pill`) | **U0 interim, U6 final** | Reply pill becomes an 8 px filled button with the Space keycap; Undo circle removed (Undo lives in toasts); the flap replaces the cluster in U6 |
| 3 | "Hold to talk" under Reply; "Tap to write · hold to talk" (`Reader.tsx:84, 89`) | **U0** | Tooltip only: "Hold R to dictate a reply" |
| 4 | Top-right Ask pill with magnifier, "A", "Hold to talk"; Calendar pill (`Topbar.tsx:22-23`, `ask.css:10-28`) | **U0 interim, U5 final** | Icon button with the speech-bubble glyph and "Ask"; hint to the tooltip |
| 5 | "Hold Space to talk" in compose (`Compose.tsx:417`; `focus.css:295` comment; `Overlays.tsx:15` row) | **U0** | Hint only in the tooltip and the `?` sheet |
| 6 | "Todo / Todos" (`App.tsx:25, 40, 534`, `Reader.tsx:68-69`, `MailList.tsx:360`, `Overlays.tsx:26`) | **U0** | "Later" everywhere, including `aria-label` and `title` |
| 7 | "Hide all" (`App.tsx:510`) | **U0** | "Clear from Home" |
| 8 | Two reply sections "Waiting on you" and "No reply yet" (`App.tsx:510`, `shared/mailbox.ts:15`) | **U0** | One New section plus "Waiting on others"; Done leaves Home for mail needing a reply (decision 6) |
| 9 | "Home 1 of 8" heading and the next-card sliver (`Reader.tsx:137-138`, `styles.css:331-332`, `.deck.has-next::before`) | **U3** | Position moves to the toolbar title; no deck |
| 10 | "Important ▾" dropdown and ⋯ in the card header (`Reader.tsx:149-150`) | **U3** | Moves into ⋯ and the Why rail |
| 11 | Card toss with `rotateY(±14deg) rotate(±4deg)` (`styles.css:343-360`, `:333-336`) | **U3, rebuilt in U4** | Removed in U3; `flight` with a 2 degree tilt arrives in U4 |
| 12 | Low-importance count badge plus comma-joined senders (`.low-line`, `focus.css:226-243`) | **U3, final in U5** | The `LowBand` replaces it |
| 13 | Warm-grey canvas, white cards, system blue and green (`tokens.css:93-94, 108-112, 161-179`) | **U3** (interim in U0 only if Decision 1 is (b)) | Interim: `--blue`, `--green`, canvas to the ink blue, moss and cool canvas of DESIGN §4.1, three variables |
| 14 | Pill buttons with inline keycaps on every control (`MailList.tsx` card actions) | **U3, final in U5** | 8 px rectangles, keycaps on hover |
| 15 | "Armed" bar scaling to 1.06 (`styles.css:379-382`) | **U3, rebuilt in U4** | Matching flap button takes the action colour, no scale |
| 16 | "Ask me anything" with "Hold A to talk" hint (`Ask.tsx:255-261`, `App.tsx:549`, `Overlays.tsx:10`) | **U0** | "Ask about your mail or calendar"; hint in the tooltip |
| 17 | Welcome copy "Hold it to talk" (`Welcome.tsx:55, 122`) | **U0 copy, replaced wholesale in U8** | Strings changed now; the file is superseded by the absorbed PR #21 version |

Items 9-15 are CSS and layout and stay until U3 (week 5.5), so **an early release (Decision 1, option a) still has Avec-like colours and cards** even though no Avec phrase remains; Decision 1 option (b) is the cheap interim palette.

**Deliverables.**

- The table above for items marked U0, plus the **copy table of DESIGN §10** applied to every string it lists, checked in `aria-label`, `title`, `placeholder` and tooltips.
- **Retire the decisions that told agents to copy.** In `DECISIONS.md`, supersede "Visual parity (M14)" (`:125`) and "Interaction parity (M16)" (`:129`) and correct the false claim at `:128`; add to `AGENTS.md` one rule: "The reference apps are ideas only; DESIGN.md is binding; load `aplos-design` before renderer work" (the skill itself arrives in U1, the rule links to DESIGN.md until then). This is done in U0, not U9, so no agent reads "match the reference" during U1-U8.
- The ten defects of `RC/ui/aplos-baseline.md` §6.9: undo-send gains 8 s; one notice per send; no "Save this draft?" after "Saved"; **Done leaves Home for mail that still needs a reply**, with "Remind me if no reply · R" (decision 6); the sheet gains ⌃5, ⌃7, ⌃8, ⌘K, ⌘/; overlapping events get an ellipsis and a 44 px minimum column; day titles get the comma; "Delete event" only on saved events; `--font-mono` defined; with no AI provider the reader shows the subject, not an error.
- Interim contrast and fade in today's `tokens.css`: `--dim` at 4.5:1 and `--faint` at 3:1 on every background in both themes; Home fade floor 0.46 to 0.8 (U3 replaces opacity with the ink ramp).
- A stopgap banned-string test (`tests/ui-copy.test.ts`) that also greps for the Avec-specific **class names and constants** of the table (`dock-pill`, `deck.has-next`, `low-line`, `rotateY(`, the Avec hex values of `lint/identity-references.json` once U1 adds it), feeding plan 40's provenance gate; replaced by ESLint in U1. The first Playwright specs (`tests/ui/`) run against the demo or emulated dev server with an isolated `APLOS_DATA_DIR`, on the Playwright version plan 40 pins (Q3), adopting its base config when it lands.

**Ownership.** Owns the renderer files named above. Touches `shared/mailbox.ts` (the `isHomeNew` change; plan 10 must reproduce it as a SQL view spec, §8), `DECISIONS.md`, `AGENTS.md`, and the `Welcome.tsx` copy (replaced wholesale in U8; resolve by taking the absorbed PR #21 file and applying DESIGN §7.11 copy).

**Depends on.** E1's freeze window (plan 10 §9, including Q1a and Q1b) is done on `revamp` first, so U0 starts at about week 1.2. The 0.2.4 train changes `Reader.tsx` (PV0's `thread.open` call and, if it joined, this plan's `srcdoc` slice), and main is merged into `revamp` at the window's step 0, before U0 starts; if a slice lands later it comes in through plan 40's `format-merge.mjs`, and the UI thread wins every conflict except those lines. U0 never edits an `invoke(` call site (the codemod owns them). If the freeze window slips, U0 waits; it must not start on the unformatted tree.

**Acceptance (evidence).**

1. All 17 rows of the table have a screenshot or grep result: rows marked U0 are gone; rows marked U3 are listed as pending with their milestone. The ban test and a DOM text scan over the demo app's main routes find none of the §10 phrases (output path in `PROGRESS.md`).
2. Each of the ten defects has a regression test: node tests for the pure ones (undo options, `isHomeNew`, `dateLabel`, the overlap layout in `calendarLayout.ts`, sheet versus keys), Playwright for the DOM ones (single send notice, no save prompt after "Saved", Delete hidden on unsaved events, no-provider reader).
3. A script prints computed contrast for `--dim` and `--faint` on every background in both themes: 4.5 and 3.0 met.
4. `DECISIONS.md` no longer instructs parity with a reference app; `AGENTS.md` carries the rule.
5. `npm test`, `npm run typecheck` and (from Q1) `npm run check` pass.

**Work packages.**

- *WP0.1 Copy and structure* (Sonnet, fan out by file group). **Verify:** a Haiku agent greps rendered DOM text from every route, including `aria-label` and `title`, which a source grep misses.
- *WP0.2 Ten defects* (Sonnet, one agent each, tests first). **Verify:** a reviewer re-runs the original reproduction from `aplos-baseline.md` §6.9, not the new test.
- *WP0.3 Interim contrast and fade; WP0.4 Playwright skeleton and ban test* (Sonnet). *WP0.5 Decisions and AGENTS.md; optional interim palette (Decision 1b)* (Sonnet; the palette variables are checked with the ΔE00 script once U1 exists, by eye before).

### U1. Foundations: tokens, lint, skill, registry, harness (7-10 days, weeks 1.5-3.5)

**Goal.** Make drift impossible before any screen is rebuilt: one token source, rules that fail on violation, a rulebook agents must load, one command table, and a headless camera.

**Deliverables.**

- `renderer/ui/tokens.json` (W3C format) and `scripts/design/build-tokens.mjs` emitting `tokens.css` (light, dark, Increase Contrast), `motion.ts` and `contrast-pairs.json` (DESIGN §12.1); a generated `legacy.css` mapping old variables to new tokens so screens migrate one at a time; CI regenerates and fails on any diff.
- The lint rules of DESIGN §12.2 as ESLint and stylelint plugins in the **`tools/lint/` extension point plan 40 Q1 creates** (not `apps/desktop/lint/`), each with a failing and a passing fixture, plus a ratchet file `tools/lint/baseline.json` of today's violations per file: no file may gain violations. U9 deletes the baseline.
- `scripts/check-contrast.mjs`: every declared pair in three modes (translucent tokens composited over their background; WCAG 2.x pass or fail, APCA advisory), the ΔE00 identity check against `tools/lint/identity-references.json` (Avec's four colours and the audit list, `RC/gaps/identity-collision-audit.md` §4) and the canvas Lab b* check. Colour maths with `culori`.
- The `aplos-design` skill (`.claude/skills/aplos-design/SKILL.md`), an AGENTS.md rule to load it before touching `apps/desktop/src/renderer` or `apps/web`, and a CI check that its token names match `tokens.json` (DESIGN §12.3).
- Bundled fonts: Newsreader variable roman woff2 (OFL, licence included, preloaded, `size-adjust` fallback) and a bundled open sans used **only in test mode**, so baselines do not drift with macOS (§6.2).
- `CommandRegistry`, the pure resolver (§4.2) and the generated shortcut sheet.
- The harness (`tests/visual/`): the first 20 states, frozen clock (2026-10-29T10:00), per-run `APLOS_DATA_DIR` seeded with original demo data, own ports, no AI keys unless a scenario injects a mock provider (DESIGN §12.5); A/B baselines plus a small golden set (§6.2); onboarding seeded explicitly (F14).
- A one-day **timing-validity spike**: does a hidden (`show:false`, `backgroundThrottling:false`) Electron window give trustworthy `requestAnimationFrame` and long-animation-frame data, and does `page.screenshot` return real pixels from it (the onboarding window and glass checks depend on it)? The answer decides where `test:perf` runs (§6.4) and is recorded in `DECISIONS.md`.

**Ownership.** Owns `renderer/ui/tokens.*`, `scripts/design/`, the design plugins and fixtures under `tools/lint/` (plan 40 owns the rest of that folder), `tests/visual/`, `tests/perf/`, `renderer/commands/`, `.claude/skills/aplos-design/`, fonts. **Plan 40 owns root devDependencies and the one pinned Playwright base (`tests/e2e/playwright.config.ts`)**: U1 asks for stylelint plugins, axe-core and culori by a small PR to plan 40, and `tests/visual` extends that base. Plan 40 reserves CI slots named `check:tokens`, `check:contrast`, `check:identity`, `test:visual` and `test:perf`; U1 delivers a script under exactly those five names (plus `lint`).

**Depends on.** Plan 40 Q1 (the formatter and linter infrastructure commit, day 1) and Q3 (the Playwright base and a macOS CI runner for the harness, growing to week 6). If Q3 is late, U1 runs the harness locally and the CI job shows as pending; the design rules live in separate files so they stay additive. No engine dependency.

**Acceptance (evidence).**

1. **Tokens reproduce the spec:** the script prints DESIGN §4.1's numbers within 0.02 (dim on canvas 5.36 light and 7.33 dark; accent-ink on accent 7.84). An independent recomputation with the audit's `de2000.py` (`/Users/knewton/.t3/aplos-research/tools/identity-audit/`) agrees on every ΔE within 0.05.
2. **Springs reproduce the spec:** `motion.ts` generates the five `linear()` strings of DESIGN §4.8 within 0.002 per sample, with settle times 270, 250, 240, 210 and 310 ms.
3. **Lint rejects:** each rule fails its bad fixture and passes its good one: raw hex, `rgb()`, literal `ms`, `cubic-bezier(`, `transition: all`, `width` in a keyframe, a literal radius, CSS `will-change`, a banned icon, a banned JSX string, a non-allowed `Button variant`.
4. **Generated files are protected:** touching `tokens.css` fails CI.
5. **Registry consistency:** a test fails on a duplicate binding in one context, a command missing from the palette, or a sheet key with no handler.
6. **Harness determinism:** two runs over 20 states in both themes differ by zero pixels; a deliberately changed token fails exactly the affected states, with overlays.
7. **The timing spike is recorded with data.**

**Work packages.**

- *WP1.1 Tokens, generator, contrast, identity CI* (Opus). **Verify:** an agent recomputes every ratio and ΔE with a different library and `de2000.py`, and tries to add a token without declaring its pairs.
- *WP1.2 Motion tokens and spring solver* (Opus). **Verify:** fuzz retargeting at random times and velocities; value and velocity stay continuous.
- *WP1.3 Lint plugins* (Sonnet; fan out stylelint, ESLint, ratchet). **Verify (adversarial):** a "rule breaker" agent writes violations meant to evade each rule: hex in a template literal, `color-mix` with a literal, `style={{transition:'all 120ms'}}`, `padding: 0 7px` through a shorthand, a duration in an inline custom property, `setTimeout`-driven motion. The WP closes when no evasion a reviewer would call a violation remains.
- *WP1.4 Registry and resolver* (Opus). **Verify:** property test over random key sequences, contexts, IME composition and text-field focus against an oracle table.
- *WP1.5 Harness, A/B tool, fonts, timing spike* (Sonnet; Opus reviews the spike).
- *WP1.6 Skill* (Opus, last). **Verify:** a fresh agent given only the skill and "add a toast with Undo" produces lint-clean code with no questions.

### U2. Typed client and the data seam (4-6 days, weeks 2.5-4)

**Goal.** The renderer talks to the engine only through the typed client and the final-shaped data layer (§4.1), running on the fixture engine, with `AppState` gone from screens.

**Deliverables.** The `renderer/data/` modules of §4.1; **verification and completion of plan 10 E1's codemod** (all 53 `invoke(` sites on `api.*`; U2 does not redo the mechanical rewrite); `bridge.ts` reduced to transport selection; `useVoice` on the binary path; the renderer's engine imports moved behind `Account/discover`; an ESLint rule that forbids importing `AppState`, `shared/live` and `engine/*` anywhere in screens; the UI running against plan 10's fixture engine in the browser preview and in Electron dev; a UI scenario control for the harness (§8).

**Ownership.** Owns `renderer/data/`, `renderer/bridge.ts`. Touches `shared/types.ts` only through plan 10's contract package.

**Depends on.** Plan 10 E1 (ARCH M1): `packages/contract` with today's method names, the typed client, generated allowlists, the codemod, and the frozen contract with `packages/contract-fixture` serving windows (gate C1, end of week 2). If C1 slips, U2 stays on the `invoke` shim until it lands and U0, U1 and U3 proceed without it.

**Acceptance (evidence).**

1. `grep -rn "invoke(" apps/desktop/src/renderer` returns only `data/`. `npm run typecheck` passes with no `any` on engine results.
2. The existing 36 node test files still pass; the harness's 20 states are unchanged except for intended diffs.
3. The overlay property test of §4.1 passes over at least 10,000 random sequences, including receipt before frame, reset mid-overlay and undo of an undone operation.
4. Window cache test: a frame with unknown ids triggers exactly one `Thread/get` for the unknown ids; a `reset` reopens windows; window order equals the fixture's order.
5. The app starts, lists mail, triages and composes against the fixture engine in both transports. The real engine is not required.

**Work packages.**

- *WP2.1 Data-layer core* (Opus). **Verify:** a skeptic agent writes the race scenarios as failing tests first, then tries to find a sequence the property test misses.
- *WP2.2 Codemod verification and call-site completion* (Sonnet, fan out by file group: Settings, AiSettings, ApiKey, AddAccount, DeviceSync; Ask, AskAnswer, AskEvent, useVoice; Compose; Reader; App and MailList; Calendar), fixing only what the codemod left untyped. **Verify:** diff review that the human error strings the UI shows today are preserved (the contract keeps them, `RC/gaps/engine-contract-rpc-stack.md` §5.1).
- *WP2.3 Pop-out windows and browser-preview transport* (Sonnet).

### U3. Identity: palette, serif, paper, components (8-12 days, weeks 3.5-5.5)

**Goal.** The app looks like Skypaper and passes the seven not-Avec checks (DESIGN §2.3) on Home and the reader in both themes.

**Deliverables.**

- **The serif gate, first:** a one-day look test of Newsreader 20/28 against SF 20/500 on 12 realistic summaries in both themes, as a review sheet; the result goes in `DECISIONS.md` (DESIGN decision 3). If SF wins, `summary` and `answer` switch to SF 500 on a `--raised` band.
- The live palette (cool canvas, ink blue, hill, dusk, stamp, night, horizon, six account colours), the ten type roles with nothing under 11 px, spacing, radius and elevation tokens, the density setting, "Show all key hints", Increase Contrast and Reduce Transparency, and the post-edge prototype.
- Components: every DESIGN §6 row marked New or Rework that is not screen-specific (`Button` with three variants, `Kbd`, `Tooltip`, `Menu`, `Popover`, `Dialog`, `Chip`, `Avatar` as the reader monogram only with `avatarColor` deleted, `Paper`, `Letterhead`, `Flap`, `MarginRail`, `Summary`, `Why`, static `CommitChip`, `PostEdge`, `ListRow`, static `FocusSlot`, `SectionHeader`, `LowBand`, `EmptyLine`, `ErrorLine`, controls, `Spinner`). Screen-specific ones arrive with their screens.
- DESIGN §13 items 9-15 (the U0 table assigns each): no deck sliver, no "Important ▾" header, no 3D toss, no count-badge low line, no warm canvas, no pill buttons, no armed-bar scale. After U3 all 17 items are gone, which is what plan 40's provenance gate needs.
- **The menu-bar glyph** plan 10 E1 asks for: a monochrome template image (18 px at 1x and 2x) of an envelope flap, no sparkle, wand or star; E1 ships a plain-letter placeholder until then.
- Website, only these files: accent to ink blue and `Airmail` to `PostEdge` (`apps/web/src/Chrome.tsx:6`, `apps/web/src/styles.css:92`, `apps/desktop/build/dmg-background.html:21`), plus the `DECISIONS.md` and `PROGRESS.md` wording (DESIGN §2.5).
- The legacy bridge reaches zero uses of old colour, radius and type variables.

**Ownership.** Owns `renderer/ui/**`, the component families, the screens' styling. Touches `apps/web` styles and component names and `build/dmg-background.html` (plan 40 reviews).

**Depends on.** U1; the owner's serif decision (or the one-day test default). U2 for data. The reader's HTML stays on the M0 stopgap until U6.

**Acceptance (evidence).**

1. The harness runs DESIGN §2.3's seven checks on Home and the reader in both themes: Lab b* below 0; accent and Done at least ΔE00 10 from Avec; serif in the summary line; no primary button radius above 8 px; no floating bottom cluster or full-card flood; none of the §10 phrases; paper left-aligned with the rail at 1060 px or wider.
2. Contrast CI is green for every declared pair in light, dark and Increase Contrast.
3. The lint ratchet shows zero hex, `rgb()`, `hsl()`, literal `border-radius` and literal `font-size` outside the token files, across the renderer.
4. No element in the harness DOM has a computed font size under 11 px or a rainbow avatar.
5. The review packet: Home, reader, compose, a menu and a dialog in both themes, plus the serif sheet.

**Work packages.**

- *WP3.1 Serif look test* (Sonnet builds the sheet; the owner decides). *WP3.2 Palette, type, elevation tokens* (Opus). *WP3.3 Components* (one agent per family: buttons and keys; surfaces and overlays; list parts; reader parts; controls; Opus for `Paper`, `Letterhead`, `Flap`, `FocusSlot`, Sonnet for the rest), each shipping harness states and an a11y assertion. *WP3.4 §13 removals and website rename* (Sonnet).
- **Verify adversarially:** (a) a reviewer who has not read DESIGN.md sees the Home and reader screenshots next to Avec's reference stills and names every element that looks borrowed; each is a defect. (b) The `break-ui` method on every component: 300-character subjects, unbreakable emails, one-letter names, counts of 0 and 9,999, CJK, RTL, emoji. (c) Glass over native vibrancy, which the script cannot compute, is hand-checked (§6.5).

### U4. Motion signature (6-9 days, weeks 5.5-7)

**Goal.** Finishing an email feels like the letter is carried off, input never waits, and the list holds still. The budgets of DESIGN §5 pass.

**Deliverables.** The runtime of §4.3; every named motion of DESIGN §4.8 as WAAPI or generated CSS; the swipe rewrite on springs that continues from release velocity; the dock fix (paint the final area in dock colour on frame one, slide contents, FLIP the column; fall back to a one-step resize with a content fade if seams show in the packaged app); the theme-switch freeze; a reduced-motion variant of every motion; the key queue; retirement of today's 56 `@keyframes` (every one that remains is generated from tokens and covered by the reduced-motion lint rule, expected 12 or fewer [I]).

**Ownership.** Owns `ui/motion*`, `ui/ghost.ts` and friends, `useSwipe.ts`, `ui.css` motion parts, `styles/*.css` keyframes. Touches `calendarMotion.ts` (kept; re-tokenised only).

**Depends on.** U2 (overlay for synchronous commit) and U3 (`ListRow`, `FocusSlot`, `Paper`). No engine dependency: it runs on the fixture engine.

**Acceptance (evidence).** On a 10,000-thread fixture, with the machine idle and its load recorded:

1. Triage key to store state 8 ms or less p95; key to next paint with focus moved 16.7 ms or less p95, 50 ms hard cap (Event Timing API and long-animation-frame observer; DESIGN §5).
2. Ten E presses in 2 s: no dropped key, exactly one `close`, no frame over 33 ms.
3. **Filmstrips** for `commit`+`flight`, `carry`+`hold`+`close`, `deal`, `post`+`drain`, `dock`, `slide`, `sunrise` at 0, 30, 60, 120, 220 and 400 ms, normal and reduced, as the golden set.
4. The animated-properties assertion (§4.3) passes in every filmstrip.
5. A swipe interrupted at 50% retargets from the drawn value and velocity with no jump.
6. Packaged-app numbers recorded in `PROGRESS.md` if the U1 spike validated hidden-window timing; otherwise the packaged check becomes an owner hands-on item.
7. **Owner feel check** (§6.5): triage 20 emails with E and L at normal and rapid speed. Does it feel instant, and does the letter feel carried?

**Work packages.**

- *WP4.1 Ghost, flight, commit, deal, carry; WP4.2 Hold, close, rapid, key queue; WP4.3 Swipe and springs* (Opus). *WP4.4 Dock, puck, count, theme freeze, reduced motion; WP4.5 Budget tests and filmstrip tooling* (Sonnet).
- **Verify adversarially, the button masher:** a fuzz agent drives random J, K, E, L, Z and arrow sequences at random 0-400 ms gaps with window blur and focus, a list update mid-flight and a theme switch, and asserts: the focused row id equals the model's; no stuck or duplicate ghost two seconds after the last key; `document.getAnimations()` is empty after settle; no `will-change` remains; row positions equal layout truth after `close`. A second agent bisects any frame over 33 ms.

### U5. Shell, Home, Later, lists, toasts, states, and the flip to the real engine (9-11 days, weeks 6-8.5)

**Goal.** The daily-driver triage surfaces in the new look and motion, on `useView`, and then the switch from the fixture engine to the real one.

**Deliverables.**

- **Shell** (DESIGN §7.1): sidebar with account switcher defaulting to **All accounts**, Calendar moved out of the footer, `slide` puck and `count`; toolbar titles with the reader position marker; minimised ☰ mode; `StatusSlot` with the full status vocabulary:

| Status (ARCH §6.4) | Copy (proposed) | Action |
|---|---|---|
| `starting`, `syncing` | "Starting…", "Syncing…" only after 150 ms | none |
| `ok` | nothing; "Synced 2 min ago" on hover | none |
| `backfilling (n of m)` | "Importing 214 of 500" | none |
| `paused` (throttle) | "Google asked us to slow down. Resuming at 2:14 PM." | Retry now |
| `paused` (daily limit) | "Google's daily limit is reached. Resuming tomorrow." | none |
| `needsReauth` | "Google needs you to sign in again." | Reconnect |
| `needsPermission` | "Aplos needs permission to read your Gmail." | Reconnect |
| `needsAdmin` | "Your organisation has blocked Aplos. Ask your administrator." | none |
| `misconfigured` | "Google sign-in isn't set up in this build." | Copy diagnostics |
| `offline` | "Offline · 2 changes waiting" | none |
| `error` | "Sync hit a problem." | View details |

- **Home** (DESIGN §7.2): fixed 160 px `FocusSlot` with `deal`; New, Due now and Waiting on others with Tab and Shift-Tab; ink-ramp fade; `LowBand` and the Low-importance sheet grouped by sender with the armed → → mark-all; "2 new" under `hold`; next-step toasts; "Go one by one" on S; Home-empty as a plain `EmptyLine` until U8, **and never the "all clear" sky moment while an account is backfilling or paused** (§4.5 row 10).
- **Later** (§7.3): groups, Bookmarks filter on a `Puck`, `DatePresets`, drag to reschedule with `lift` and `snap`. **Lists** (§7.4): one component for All mail, Drafts, Sent, Trash, Spam; arrows move the cursor only (decision 7); bulk select with the in-place title; hover actions as a non-reflowing overlay.
- **Toasts** (§7.13): content-column stack, op-queue wording, one operation one notice, Undo toasts never replaced, update-ready toast restyled. **Errors** (§7.15): inline `ErrorLine` on rows; `FatalScreen` including the parked engine ("Try again", "Export diagnostics").

- **The flip (WP5.6).** One flag moves `WindowSource` from the fixture to the real engine once plan 10 E3 passes the conformance suite (about week 6-7). Deliverable: the harness runs the P0 states against both engines with the same assertions; the owner opens the packaged app on real mail. After this, plan 10 may delete the legacy assembler.

**Ownership.** Owns `App.tsx` (shell and routing, split into route modules), `components/{Sidebar,Topbar,MailList,Overlays}.tsx`, `ui/Toast.tsx`, new route files.

**Depends on.** U4. The `home`, `later`, `mailbox`, `home.low` view specs and folder counts (§4.1), served by the fixture until the flip; the rank-bucket field (ARCH M5, plan 10 E5) is emulated by the fixture. Plan 20 PV2 for status values (until then the fixture engine emits each one). **WP5.6 needs plan 10 E3 acceptance.**

**Acceptance (evidence).**

1. About 35 named states from §7.1-7.4, §7.13-7.15 in the harness, both themes, two sizes, each with an axe scan that has no serious violation.
2. Behaviour tests: Done on mail needing a reply leaves Home and offers the Remind toast; arrow keys on All mail move the cursor and archive nothing; Tab and Shift-Tab jump sections; hover on any row leaves every row's bounding box unchanged; a cached list paints with no skeleton; each status in the table renders from the fixture engine.
3. Fuzz: new mail arriving during a triage burst never moves the row under the cursor (the button-masher agent from U4, extended).
4. Keyboard-only walkthrough of "triage 10 emails, defer one, bulk-trash three, undo" is scripted and passes.
5. **Flip:** the P0 states and the walkthrough pass on both the fixture and the real engine; a `grep` finds no `latestState` consumer in the renderer; plan 10 is told in writing that the renderer is on windows (unblocking E8 shim removal).

**Work packages.** *WP5.1 Home and Low sheet* (Opus); *WP5.2 Shell, sidebar, status slot; WP5.3 Later, DatePresets, drag; WP5.4 Lists and bulk; WP5.5 Toasts, errors, empties* (Sonnet); *WP5.6 Flip to the real engine* (Opus, after E3). **Verify:** `break-ui` worst-case data on every list; a fresh-eyes agent runs the keyboard-only walkthrough without reading the code and reports every lost focus.

### U6. Reader, mail frame, compose and outbox UI (8-12 days, weeks 7.5-10)

**Goal.** The reader and composer in the new design, with the real sandboxed frame once the engine provides it, and honest send states.

**Deliverables.**

- **Reader** (DESIGN §7.5): `Letterhead` (sender, serif summary, quiet subject, body), sticky `Flap`, `MarginRail` or `Notes` (found here; why it's in Home with ⌥↓ and ⌥↑ writing deterministic sender rules; the sender's history), 28 px message one-liners with ↑/↓, J/K `swap`, O for quoted text, ⌘F find, every §7.5 state.
- **`MailFrame`** (§4.4): `srcdoc` source first, `aplos-mail` when plan 10 E4 lands; image chrome and "N trackers removed"; plain-text path; attachments with failure state; prefetch on intent (80 ms focus, 120 ms hover, cancel on move) against the engine's LRU of 12.
- **Compose and inline reply** (§7.6): 680 px non-modal sheet with `PostEdge`, the `DraftState` line, inline reply in the paper, dictation with `LevelMeter`, AI draft with Tab and Esc, Polish as a diff, ⌘⇧Return send and Done. **Send** with `post` and `UndoTray` with `drain`, one notice per send, the submission states and draft-conflict card of §4.5 rows 4-5.

**Ownership.** Owns `Reader.tsx`, `Compose.tsx`, `renderer/mail/`, `LevelMeter.tsx`, `useVoice.ts`. Touches the reporter protocol document with plan 10.

**Depends on.** U4, U5. Plan 10 E4 (ARCH M4, HTML half, weeks 4-6) for the real frame (ship against `srcdoc` first behind the same props). Plan 10 E6 (ARCH M6, week 6-7) for `Submission` states; until then the fixture emits them. Plan 10's `MessageBody/get` (E2 and E3).

**Acceptance (evidence).**

1. Every §7.5-7.6 state in the harness, both themes, both sizes.
2. **No blank sheet:** a fuzz of 500 J/K moves with body latency random in 0-2.5 s never shows an empty paper; after 1.5 s the 12 px loading line appears.
3. **Frame host tests:** spoofed `postMessage` (wrong source, origin or token; `h` of NaN, negative or 1e9) is rejected; height clamps; a `bg` parse failure falls back to light paper.
4. **Hostile-HTML corpus** (the vectors in `RC/gaps/electron-email-html-isolation.md` §1: inline script, `onerror`, meta refresh, `<link>` prefetch, `url()` trackers, forms): zero outbound requests in the Playwright log, and the frame cannot reach `window.aplos`.
5. **Keys with focus inside the frame** work for J/K, E, L, Space, R and `/` in the packaged app (§6.5 check 4). The result and the chosen relay path are recorded before U6 closes. **[U] today.**
6. Each submission state renders its sentence and actions from the fixture engine and survives a reload; the kill-resume e2e belongs to plan 10 E6.
7. A live check: one real send to an owner-controlled address from the new composer in the packaged app, owner present.

**Work packages.** *WP6.1 Letterhead, flap, rail, threads; WP6.2 MailFrame and key relay* (Opus, security-sensitive); *WP6.3 Compose family* (Opus composer, Sonnet the rest); *WP6.4 UndoTray and send states* (Sonnet); *WP6.5 Prefetch and double buffer* (Opus). **Verify adversarially:** a "hostile sender" agent writes new email-HTML attacks (CSS `@import`, SVG `<use>`, `<base>`, `<meta http-equiv>`, `javascript:` links, giant tables, deeply nested divs) and runs them through sanitiser and host; a spoofing agent forges the reporter message from another frame; a fuzzer interleaves send, undo and fixture-engine restart and asserts no duplicate tray and no lost draft.

### U7. Palette, search, Ask, Today, Settings, Calendar (8-12 days, weeks 9-11.5)

**Goal.** The remaining screens, every command reachable by name, and the gap surfaces of §4.5.

**Deliverables.**

- **Palette and search** (§7.9): ⌘K with the truthful context line, groups, breadcrumbs, 1-9, the scoring order of §7.9, two-row destructive confirms; `/` search with local results as you type, operator tokens, remote only on Return.
- **Ask and Today** (§7.7): dock closed on first run, serif answers with citations, step log, queued follow-ups, `ProposalCard`, no-provider and provider-error states, hold A to dictate, the Today agenda.
- **Settings** (§7.10): eight sections, 40 px rows; AI providers (status dot, key source, never key characters, Test, Remove, editable local addresses) and the feature table with speech-to-text providers for Voice; Keyboard with remapping, conflicts, the single-key switch and "Show all key hints"; Accounts with one name and Reconnect on the row; Mail with undo-send 0, 5, 8, 10, 20, 30 s; the gap rows of §4.5 rows 2-3. Every setting searchable from ⌘K.
- **Calendar** (§7.8): the four baseline fixes, Skypaper visuals, narrow agenda; existing FLIP, period slide and pinch zoom kept. `ShortcutSheet` from the registry.

**Ownership.** Owns `Ask*.tsx`, `Settings.tsx`, `components/{AiSettings,ApiKey,AddAccount,DeviceSync}.tsx`, `Calendar.tsx` and its helpers, the palette.

**Depends on.** U5. Plan 10: `Ask/run` progress frames carrying citations, the settings fields in §8, the AI provider table with `trainsOnInputs` (E5), diagnostics methods (E7, ARCH M9; the pages ship behind a capability flag and show "Not available yet" until then). Plan 20 PV9 (weeks 8-9): calendar edit-scope fields (this event or all events) and RSVP.

**Acceptance (evidence).**

1. **Palette reach:** every registry command is reachable in the palette; the context line is truthful across 30 contexts (property test); Esc never navigates.
2. **Settings reach:** every `SettingRow` registers a palette entry.
3. **Secrets:** no element text, attribute, screenshot or log in any harness state contains a canary key value or any `*_API_KEY` value; a scanner agent seeds the canary.
4. **Ask invariants over 20 fixture answers:** a citation or "No source in your mail"; input never disabled while streaming; queued follow-ups as editable cards.
5. **Live provider:** one real Groq Ask round trip in Electron dev, key read from the backend environment only and never printed (AGENTS.md; `npm run eval:ask` exists). A mocked provider does not count.
6. **Calendar:** five overlapping events at 44 px or wider with "+N"; comma in day titles; no Delete on an unsaved event.
7. **Search:** typing never calls the remote path; Return calls it exactly once.

**Work packages.** *WP7.1 Palette and search; WP7.2 Ask dock and Today* (Opus); *WP7.3 Settings: AI and Keyboard; WP7.4 Settings: the rest* (Sonnet); *WP7.5 Calendar* (Opus for layout and motion, Sonnet for the rest). **Verify:** palette scoring fuzzed against an oracle written by a second agent; the secret scanner; `break-ui` on Settings with a 40-character provider name and a 200-character address.

### U8. Onboarding, first sync, consent, sky moments (6-9 days, weeks 7-9)

**Goal.** An onboarding window that cannot get stuck, a first-sync screen that tells the truth under Gmail's quota, the owner's three onboarding wishes, and all 14 PR #21 findings closed by tests. U8 runs before U6 and U7 (§3.2).

**The owner's wishes, made testable.** Where a wish differs from DESIGN §7.11-7.12, the wish wins; DESIGN §7.11-7.12 was amended on 2026-10-27 to match, and U8 records the result in `DECISIONS.md`.

| Wish | What it means here | Differs from DESIGN? |
|---|---|---|
| **A separate, smaller, full-bleed window** (Arc, Dia, Zen) | Created by main on first run (no accounts, setup not done) or from Settings → Help → "Show welcome". 640 × 600, minimum 640 × 520, vertically resizable, hidden-inset title bar. `SkyScene` fills the whole window including under the traffic lights; one paper sheet sits on it with a 16 px margin (Decision 10). Nothing else opens; the mail window does not exist until handoff. Launch at login with no accounts stays windowless until the owner clicks the Dock or menu-bar item. | Partly: DESIGN §7.11 specified a card with sky around it |
| **Demo is a small top-right button and loads only when clicked** | A text button "Try demo mail" in the sheet's top-right corner (a no-drag region inside the 48 px drag strip, 24 px or larger hit area). **A fresh install starts with zero accounts and zero mail**; clicking calls the contract's `Demo/load` (§8.1 item 11); nothing demo is seeded, loaded or wiped before that. Demo skips the first-sync screen. | Yes: DESIGN §7.11 step 1 made it a second Welcome button, "Look around with demo mail" |
| **After onboarding, a loading screen that syncs and runs the AI pass before the inbox** | §7.12's screen as refined below: it gates only on the newest mail and a time-capped AI pass, never on the whole mailbox, and the owner can enter early. | Refines §7.12 |

**What "ready" means (consistent with Gmail's quota).** Gmail allows about 6,000 units a minute per user; the first sync is metadata-first and paced (ARCH §5.1: newest threads first as `format=metadata`, committed per 50, backfill in the background; `baseline_done_at` is set when that first window completes, plan 20 PV3).

1. **Connect.** The account is saved.
2. **Find recent mail.** The first window only (about 50 newest threads). A count appears as "about N" only when the provider gives an estimate; otherwise a quiet indeterminate bar. The screen never states or implies the mailbox total.
3. **Read your newest mail, n of N.** N is the first window, not the mailbox. When it completes the account is **ready**; Home is already ordered by the heuristic buckets (ARCH §8.2), so ready never waits for AI.
4. **Sort what matters.** The AI summary pass for the visible Home candidates only (at most 40, at most 60 seconds, as PR #21 did; the engine owns the cap). It needs stored consent and a provider, and is omitted otherwise. **Only this step may time out**, and it says so: "Sorted 12 of 40. The rest continue in the background."

Rules that keep it honest:

- **Backfill is never in the gate.** Older mail (90 days, hundreds of threads, minutes at Gmail's pace) continues after Home opens; the status slot takes over with "Importing 214 of 500" (§5, U5).
- **Enter early, always.** "Open Aplos" (Return) is enabled once the account is ready. A quiet text button "Continue anyway" (Esc, F8) is enabled from the moment of Connect. Entering before any mail has arrived opens Home with the `EmptyLine` "Your first mail is on its way." and the status reason (§4.5 row 10), never the "all clear" sky.
- **Rate limits are shown, not hidden.** On `paused` with `resumeAt` the screen says "Google asked us to slow down. Resuming at 2:14 PM. Your newest mail will appear first." The paused segment shows a static mark, not a spinner. A raw Google error is never shown.
- **Numbers never move backwards, never claim completion early.** No segment shows 100% or "Done" until it is, and "Done" never appears for a capped, failed or paused step (F10).
- **Auto-enter only on a clean finish** (Decision 11): steps 3 and 4 done, capped or omitted, no error and no pause; the segments become a drawn check, `sunrise` plays once (skippable, static under reduced motion), then handoff on `ready-to-show` (F4). Any problem waits for the owner.
- **Several accounts:** a row per account; the window can open as soon as one account is ready, and the others keep going. "Add account" from Settings uses the same component inline and never gates anything.
- Copy corrections to DESIGN §7.12's sample: "Found about 214 recent emails" only with an estimate, and "Reading your newest mail · 24 of 50" instead of "120 of 214".

**Deliverables.**

- **Absorb PR #21's screens, not its engine half.** Branch `rv/ui/u8-pr21-absorb` takes files from the PR head (`2d88846` when reviewed; re-pin at U8 start) **by path**, never by merging the head, because the PR touches 46 files including `engine/service.ts` (+90 lines), `engine/demo.ts`, `engine/ports.ts`, `engine/provider.ts`, `main/google.ts`, `main/engine-host.ts`, `main/service.ts`, `main/server.ts`, `main/preload.ts`, `shared/types.ts` and a dozen test edits, all of which collide with plan 10's `service.ts` split and `Setup/*` and with plan 20's Google work.
  - **Taken:** `renderer/components/Welcome.tsx`, `components/AddAccount.tsx`, `renderer/main.tsx` (the `?onboarding=1` browser-preview route), the onboarding rules in `styles.css`, and the window-creation part of `main/electron.ts` as a small patch handed to plan 10 (§8.1).
  - **Handed over:** `tests/onboarding.test.ts` (193 lines) to plan 10 E5 as the starting scenario list for `Setup/*`; `scripts/dev-emulated.ts` flags (`--fail-sync`, `--fake-ai`) to plan 20's emulators; `apps/web/scripts/capture-screenshots.mjs` (F14) to plan 40.
  - The PR itself is never merged; the owner may close it as superseded (Decision 4).
- **Window and steps** (DESIGN §7.11, table above): Welcome (icon, the `display` line, filled "Add an account", top-right "Try demo mail"), Accounts, AI (with the consent card, §4.5 row 1), Voice; Return continues, Esc goes back; "Setup continues in the background."
- **First-sync screen** (§7.12 as refined above): `ProgressSegments` following engine checkpoints, per-account rows, the optional 30-second "Try the keys" drill, one `role="status"` for phases only, labelled bars.
- **Zero-accounts empty state, demo controls and "Show welcome"** (§4.5 rows 8 and 9).
- **`SkyScene`** in code (gradient, hill, one wind arc), `sunrise` on completion, the Home-empty sky moment with its two facts (only at status `ok`); iCloud and Fastmail preset copy (§4.5 row 7); onboarding seeded or driven by the harness (F14).

**The 14 findings.** DESIGN Appendix C maps F1-F14 to rules. Division of labour:

| Findings | Fixed in | Test lives in |
|---|---|---|
| F1, F2, F5, F6 (`deferAI`, no backfill, fixed request ids, replies not re-summarised) | Engine: `Setup/end`, one-shot deferral, per-run ids, backfill with reply refresh (plan 10 E5; ARCH §8.3) | Plan 10 engine tests; U8 adds the UI end-to-end that every close calls `Setup/end`, including the reopen path from "Show welcome" that F1's reproduction needs |
| F3, F4 (two windows; blank flash) | `src/main/electron.ts` (plan 10 owns it, plan 40 adds the `show` handling; this plan supplies a small patch and the test) | `_electron` hidden-window test |
| F7 (filtered to the last account) | Engine stops selecting the account on setup connects; UI opens on All accounts | Harness |
| F8, F9, F11, F12, F13, F14 | Renderer (this plan) | Harness |
| F10 (honest outcomes) | Engine reports partial and failed counts; UI wording | Harness with fixture states |

**Ownership.** Owns `components/Welcome*`, `AddAccount.tsx`, the onboarding window renderer, `SkyScene`. Touches `src/main/electron.ts` through plan 10.

**Depends on.** U3 (components) and U4 (`sunrise`; a static fallback is acceptable if U4 slips). Plan 10 E5 (`Setup/*`, consent, one-shot deferral, **fresh install starts empty, `Demo/load`**). Plan 20 PV3 (real first-window checkpoints, `resumeAt`); until then the fixture engine scripts each scenario. PR #21 itself, as a source of files.

**Acceptance (evidence).**

1. Each of F1-F14 has a test named for its finding, built from the original reproduction in `research/pr21-onboarding-review.md`; all pass.
2. **Close-at-any-moment matrix:** close the onboarding window at each step, with connect in states idle, pending, connected, syncing and synced; afterwards a later sync of the same account classifies new mail with a mock AI provider and no account is left deferred. This is the property that the review kept finding broken.
3. **Demo isolation:** on a fresh `APLOS_DATA_DIR` the contract log shows no `Demo/load` and zero accounts until "Try demo mail" is clicked; after the click demo accounts exist and the first-sync screen is skipped; Settings can Load, Reset and Remove demo mail; a 0.2.x data folder that already holds demo or real data is never seeded or wiped.
4. **Quota honesty,** with fixture scenarios: (a) first window arrives, then backfill pauses 120 s: the screen reaches ready, "Open Aplos" works, no mailbox total is shown, and the status slot carries the pause after entering; (b) paused before any batch: Esc enters, Home shows "Your first mail is on its way." and never the all-clear sky; (c) a property test over random frame sequences: no counter decreases, no 100% or "Done" before true, no "Done" for a capped step; (d) the screen never auto-enters while paused, failed or partial.
5. **Window chrome:** a hidden `_electron` test asserts 640 × 600, minimum 640 × 520, vertical resize, hidden-inset title bar, exactly one window at startup including a second launch (F3), and no mail window before `ready-to-show` (F4).
6. All onboarding and loading states in the harness, both themes: six steps, plus partial, failed, rate-limited before and after the first window, multi-account, no-AI, no-consent, complete, zero-accounts, demo.
7. **Live (owner-run):** the owner connects a real Google account (a Testing-mode test user) through the new onboarding and watches honest progress: the first window within about the 15 seconds ARCH M3 promises, then Home opening while older mail keeps importing, and a slow-down message if Google asks for one. Mocked Google is not live acceptance (AGENTS.md).
8. A screen-reader scan shows exactly one live region and labelled bars (F11). The traffic lights over the scene and the drag region are a hands-on check (§6.5 #9).

**Work packages.** *WP8.1 Absorb by path and rebase; WP8.2 Steps, consent card, focus and keys; WP8.5 Main-process patch and `_electron` tests* (Sonnet; plan 10 reviews the patch); *WP8.3 First-sync screen and quota scenarios; WP8.4 SkyScene and sunrise* (Opus); *WP8.6 Zero-accounts state, demo controls, Show welcome* (Sonnet). **Verify adversarially:** re-run the five-lens review workflow behind `research/pr21-onboarding-review.md` on the new code; every original finding must fail to reproduce, and any new finding is fixed before U8 closes. A second agent plays "Google throttles me" by scripting `paused`, `resumeAt` and slow batches and tries to make the screen lie (a wrong total, an early "Done", a stuck Esc).

### U9. Cleanup, accessibility, performance, release candidate (7-10 days, weeks 11.5-13.5)

**Goal.** The flip to real windows already happened in U5 (WP5.6). U9 deletes the scaffolding, proves the budgets and accessibility on the packaged app, and produces the release candidate that the engine soak and the dogfood week share.

**Deliverables.**

- **Cleanup after the flip:** delete the `refresh()` loader in `App.tsx`, `bridge.ts`'s web fallback, the renderer's use of `shared/live`, `legacy.css` and, if it was ever written, `compat.ts`; browser preview on the tokenised HTTP binding (plan 10 E7) with a dev token injected by the harness; lint ratchet to zero and `tools/lint/baseline.json` deleted.
- **Accessibility** (DESIGN §11): axe over every state in both themes; ten core tasks keyboard-only; ARIA snapshot tests for list, reader, palette and calendar; a live-region log asserting triage announcements ("Done. Next: Maple Library, two holds waiting"); Increase Contrast over 20 states; reduced motion; Reduce Transparency; 200% zoom at the 900 px minimum.
- **Performance:** DESIGN §12.6 over the 10k fixture and plan 10's 100k fixture (bounded windows, flat renderer heap over a scripted 30 minutes); cold start recorded and budgets recalibrated once, with the reason written down.
- Docs: `PROGRESS.md`, `TODO.md` and the skill brought up to date (the M14 and M16 supersession was done in U0); a release-candidate branch and final screenshots. The release candidate is the **same build** the engine's seven-day soak (E8) runs on (Decision 12).

**Ownership.** Owns all of the above. Touches `apps/web/scripts/capture-screenshots.mjs` only to adopt the harness's onboarding seed (plan 40 owns the website).

**Depends on.** The U5 flip (plan 10 E3 done) and plan 10 E7 (ARCH M9, HTTP binding); plan 40 Q3 CI runner and a packaged build; plan 20 PV11 live providers for the dogfood week.

**Acceptance (evidence).**

1. `grep` finds no `AppState`, `createLiveState` or `invoke(` outside the typed client; typecheck, lint (zero baseline), unit, harness and axe all pass.
2. The DESIGN §5 budget table passes in the packaged build at 10k threads (or in headless Chromium plus an owner hand check if the spike said so), p95 over 50 runs. A 100k-thread fixture opens Home in under 200 ms to first rows and scrolls with no frame over 16.7 ms p95.
3. Axe: no serious violation in about 90 states by two themes. Ten keyboard-only tasks pass.
4. **Owner-run:** a VoiceOver pass over Home, reader, compose, Ask, calendar and onboarding, and one Japanese or Chinese IME check in compose and search. A scripted CDP IME test (composition events) runs first. A seven-day dogfood week on a release-candidate build with the owner's accounts.
5. All 17 items of DESIGN §13 are checked off with screenshot evidence (the U0 table, now complete), and a fresh grep of the Avec-specific strings, class names and constants is clean for plan 40's provenance gate.

**Work packages.** *WP9.1 Cleanup after the flip* (Opus); *WP9.2 Accessibility suite; WP9.3 Performance suite* (Sonnet, Opus reviews); *WP9.4 Cleanup and docs* (Haiku, Sonnet). **Verify adversarially:** a **fresh-eyes auditor** that has seen only DESIGN.md and the built app hunts deviations (a wrong radius, a literal duration, an off-ramp colour, a §10 phrase, a Space meaning that differs from §8) and reports each with a screenshot. Lint and harness must have caught every one; each miss becomes a new rule.

> **What this means:** Ten steps, each ending with something you can see or hold, and each with a machine trying to break it before you do. The riskiest hand-offs (the email frame, onboarding closing, the switch to the real engine) ship the interface first and flip the engine part later.

## 6. Test strategy

### 6.1 Layers

| Layer | Tool | Proves | Runs |
|---|---|---|---|
| 1. Pure logic | `node --test` (the repo's runner) | Tokens, contrast and ΔE, springs, resolver, hold gate, ghost scheduler, optimistic reducer, window cache, palette scoring, operator parser | Every commit |
| 2. Lint fixtures | `node --test` driving ESLint and stylelint | Each rule rejects its bad fixture and accepts its good one | Every commit |
| 3. Behaviour and DOM | Playwright, headless Chromium, browser preview, fixture engine | Keys, flows, DOM assertions (one filled button per route, no layout-property animation, no text under 11 px, no banned strings), axe, fuzz | Per work package (core 30 states); full at milestone close |
| 4. Visual | Playwright screenshots | Look unchanged unless intended; motion filmstrips | Same |
| 5. Hidden Electron | `_electron.launch`, `show:false`, isolated userData | The `aplos-mail://` frame, key relay, onboarding lifecycle (F3, F4), packaged timing | U6, U8, U9 close |
| 6. Live | Real accounts and providers | What mocks cannot prove (AGENTS.md) | Named in acceptance |

### 6.2 Visual method

- **A/B against the base ref on the same machine:** the tool renders the base and head commits in two worktrees and diffs them, so no stored image drifts with macOS and nothing large lands in git.
- **A small committed golden set:** about 40 hero states by two themes at 1440 × 900 plus the filmstrips, roughly 100 optimised images, updated only at milestone close with a reason in the commit message. The **full matrix** (about 90 states by two themes by two sizes, 360 images, plus Increase Contrast for 20) is generated and compared, not committed.
- **Why this departs from DESIGN §12.5**, which commits all baselines: each refresh of 360 PNGs adds tens of megabytes to history, and the repository may go public (ARCH §14). Decision 5 lets the owner overrule.
- **Determinism** as DESIGN §12.5: frozen clock, en-US, bundled fonts (an open sans in test mode so SF updates cannot shift baselines), pixel ratio 1, hidden cursor, no caret blink. ΔE above 2 on more than 0.1% of pixels fails, with an overlay. Real SF appears only in review packets and hands-on checks.

### 6.3 Frequency

Layers 1-2 run on every commit, the 30-state core harness on every work package, the full matrix, axe and budgets at each milestone close. Performance runs only when the machine is idle and its load is recorded (agents share each Mac).

### 6.4 Performance

DESIGN §12.6 drives synthetic key events through CDP against the 10k fixture and asserts p95 over 50 runs, with a 10% regression rule against the seven-day median. Whether the packaged build can be timed headlessly is the U1 spike's job. If a hidden window throttles rendering, frame metrics run in headless Chromium, the packaged build supplies key-to-state and IPC timings only, and an owner hand check covers the rest [U].

### 6.5 Hands-on checks (the only ones a machine cannot do)

| # | Check | Milestone | Who |
|---|---|---|---|
| 1 | Serif look test: Newsreader or SF | U3 | Owner |
| 2 | Glass over native vibrancy contrast, both themes | U3 | Owner or agent with a screen capture of the packaged app |
| 3 | Motion feel at normal and rapid speed | U4 | Owner |
| 4 | Keys with focus inside the mail frame, packaged app | U6 | Agent with a hidden-window script if it works, else owner |
| 5 | Real Groq Ask round trip, key from the backend environment | U7 | Agent, key never printed |
| 6 | Real Google account through the new onboarding | U8 | Owner (Testing-mode test user) |
| 7 | VoiceOver on six screens; real IME in compose and search | U9 | Owner |
| 8 | Seven-day dogfood on a release-candidate build, run together with the engine soak (E8) | U9 | Owner |
| 9 | Onboarding window chrome: traffic lights over the sky, drag region, vertical resize, the "Try demo mail" corner button, glass over vibrancy (a browser-preview harness cannot see native chrome; `page.screenshot` of a hidden Electron window only if the U1 spike says it is real pixels) | U8 | Owner |

### 6.6 What counts as evidence

Each checked item in `TODO.md` and `PROGRESS.md` carries a test output path or headless screenshot path. Screenshots use original demo data only. Mocked Google or providers never close an item that says "live".

> **What this means:** Most checks are automatic and run with no window on screen. A handful need your eyes or hands, listed by name so none is forgotten.

## 7. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | Plan 10's contract freeze (C1, end of week 2) or live windows (E3, week 6) slip | Screens use `useView` over the fixture engine, so C1 slipping delays only U2; if E3 slips more than two weeks, write `compat.ts` (a renderer-side window emulator) so the owner can try new screens on real mail, otherwise do not. The flip is one flag (WP5.6). U0, U1 and U3 (about 4 of the first 6 weeks) need no engine. |
| 2 | The typed client is awkward for real screens | U2 migrates 53 real call sites first and files change requests to `packages/contract` before the freeze hardens. |
| 3 | Hidden-window timing is untrustworthy | The U1 spike decides early; fallback in §6.4. |
| 4 | 8 ms key-to-state is unrealistic in React | External store, imperative cursor, a virtualised window of about 30 rows; recalibrate once after the first measurement (DESIGN §5 allows it). |
| 5 | Agents drift despite the rules | Skill, lint, a U9 fresh-eyes audit; each miss becomes a rule; lint evasion attacked in U1. |
| 6 | The serif looks wrong | The gate comes first in U3; one token is the fallback. |
| 7 | Dock seams return (`DECISIONS.md:298`) | Fix as designed, test packaged, fall back to a one-step resize. Never animate width. |
| 8 | Out-of-process frame keys do not arrive [U] | Hand check before U6 closes; a limited non-destructive relay is the fallback (ARCH §10). |
| 9 | Merge conflicts with E0 (ARCH M0), plan 40's formatter, plan 10's E1 freeze window, `electron.ts` and engine move | U0 starts only after the freeze window; sequencing and the reformat-on-conflict rule (§10). |
| 10 | PR #21 moves while U8 waits | Re-pin to its head at U8 start. |
| 11 | About 90 states is too many to polish equally | P0 states (Home, reader, compose, palette, onboarding, status, toasts) must pass fully; P1 (rare errors and empties) need the harness check and a lighter review. |
| 12 | Screenshots leak real mail | Original demo data only; a scanner greps harness output for real addresses before anything is attached. |
| 13 | The first-sync screen promises more than Gmail's quota allows, or lies under a pause | The gate is the first window only; backfill is never in it; the quota scenarios and property test of U8 acceptance 4 |
| 14 | PR #21 absorption drags engine files in | Take files by path, never merge the head; engine tests go to plan 10 E5 (U8) |
| 15 | The UI finishes after the engine and 0.4.0 slips | One release candidate shared by the soak and the dogfood week (Decision 12); the flip happens at E3, not at the end |

> **What this means:** The biggest risks are the engine arriving late, the keyboard path into the email box, and agents quietly drifting. Each has an early check or a fallback that is already written down.

## 8. Interfaces and contracts with the other workstreams

### 8.1 From plan 10 (engine foundation)

1. **`packages/contract`**, typed client and generated allowlists, frozen at E1 (gate C1, ARCH M1), plus a **fixture engine** (`packages/contract-fixture`) serving `View/watch` windows, receipts, statuses and scripted scenarios, with a test-only control channel (compiled out of production) to force a status, rate-limit pause, failed write, submission state or setup progress and to set the clock (`APLOS_NOW`).
2. **View specs** of §4.1, including Done leaving Home for mail needing a reply.
3. **`Thread/act`, `Operation/undo`, receipts, `holdIds`** and opaque state tokens (ARCH §9.2).
4. **Mail frame:** `Mail/frame {messageId, imagePolicy, findQuery}` returning `{url, expiresAt, bodyKind, trackersRemoved, hasRemoteImages, quotedCount}` plus `Mail/frame.release` (plan 10 E4 and §4.1 use the same shape); the reporter message schema; optional `toggleQuotes`; the `mail-key` relay; a per-sender image allow-list.
5. **Submissions** (queued, sending, sent, uncertain, failed, cancelled, suspended) and a draft-changed-elsewhere signal.
6. **Setup and AI governance:** `Setup/begin|end|status` (plan 10's names; the UI calls `Setup/end` on every window close), one-shot deferral, per-run ids, backfill including reply refresh, a versioned consent record, `trainsOnInputs`, the daily cap, the per-account AI toggle, the primary-device lease and override.
7. **`Ask/run`** progress frames with citations `{n, messageId, quote}`.
8. A **`ui` settings object** (density, key hints, dock, keymap, hold threshold), retention and resident-mode toggles.
9. **Diagnostics** export preview, queue-inspector methods, the parked-engine event, and `Session/get` capability flags so the UI can say "Not available yet".
10. **`APLOS_TEST=1`** in main (a hard dependency of every hidden-Electron test): isolated userData, no single-instance lock, Dock icon, menu-bar item or login item; the onboarding and mail windows are created `show:false` under test.
11. **Empty start and demo on request (owner wish; PR #21's M42):** a fresh install, and the E2 import of an empty or absent store, creates **zero accounts and no demo data** (today `service.ts:195` seeds `createDemo` whenever the store is empty). New contract calls `Demo/load`, `Demo/reset` and `Demo/remove`, idempotent, touching only demo accounts; saved demo or real data is never seeded over or wiped; the fixture engine honours the same rule. A `Session/get` field says whether any account exists so main can choose onboarding or the mail window.
12. **`Setup/status` shape for the first-sync screen:** per account `{state, firstWindow: {found?: estimate, read, total}, ai: {sorted, total, capped, failed}, backfill: {read, target}, pausedUntil?, reasonCode}`; `firstWindow.total` is the window target (about 50), never the mailbox size; `ai` appears only with stored consent and a provider.

The UI gives plan 10 the view-spec list, the frame host behaviour, the F3, F4 and F7 patches and tests (the onboarding window creation and handoff patch of U8), the menu-bar glyph (U3), the "renderer is on windows" report at the flip (unblocking E8 shim removal), `tests/onboarding.test.ts` as E5's starting scenarios, and early contract-ergonomics change requests (U2). Plan 10 E1's codemod is the only mechanical rewrite of renderer call sites.

### 8.2 From plan 20 (providers and sync)

- Account status `{state, reason, resumeAt}` in the ARCH §6.4 vocabulary, and first-sync checkpoint facts (connected, found as an **estimate when the provider gives one**, read n of the first-window total, `resumeAt`, reason code), set when the first window completes (`baseline_done_at`), aggregated by plan 10's `Setup/status` (§8.1 item 12) for U8's honest progress. The UI never needs a mailbox total.
- Calendar fields for "this event or all events", RSVP, hidden and selected calendars, colours.
- Preset copy for iCloud app-specific passwords and Fastmail tokens (`RC/protocols/proto-others.md` §5), and provider errors mapped to the plain copy of U5, so the UI never shows a raw error.

The UI gives plan 20 the status copy table, the harness scenarios for every status, and the live onboarding check (U8) as an acceptance vehicle.

### 8.3 From plan 40 (platform, security, distribution, quality)

- The **formatter and linter commit** (Q1) before U0 and U1; the `tools/lint/` extension point where the design plugins live; the one pinned Playwright base (`tests/e2e/playwright.config.ts`); root devDependency changes by small PR to plan 40; a macOS CI runner for the harness (Q3); packaged builds on demand for U4, U6, U9. Plan 40 adds the window `show` handling in `electron.ts` that U8's patch relies on (F4).
- **Provenance gate:** plan 40's gate needs all 17 Avec-derived items gone, which is true only **after U3** (U0 removes items 1-8, 16, 17; the U0 table lists the rest), plus the banned-strings test of U0.
- The CSP changes of ARCH §12.1 (no `'unsafe-inline'` in `script-src`, no `https:` in `img-src`, `frame-src aplos-mail:`) happen **after** the UI confirms it has no inline scripts or eval. The UI ships `font-src 'self'` for the bundled fonts.
- Website: U3 does the rename and accent in the three named files; copy truthfulness stays with plan 40.
- The UI gives plan 40 `npm run lint`, `check:tokens`, `check:contrast`, `check:identity`, `test:visual`, `test:perf` (the five slot names plan 40 reserves), `tokens.json` for the website, and the skill.

### 8.4 Contract change process

A change to `packages/contract` is a small PR reviewed by plan 10's thread. The UI never edits `shared/types.ts`, `preload.ts` or `electron.ts` beyond the small, flagged patches named above.

> **What this means:** The UI depends on the engine team for a handful of specific things, all listed here with the milestone that first needs them. In return it hands them the checks, the copy and the early feedback.

## 9. What to read first

For the T3 UI thread, in this order:

1. `plans/DESIGN.md` in full, especially §2.3, §4, §5, §7, §8, §12, §13, Appendix C.
2. `plans/ARCHITECTURE.md` §3.5, §6.4, §7, §8, §9, §10, §15.
3. This plan's §4 and the milestone you are on.
4. `RC/ui/aplos-baseline.md` §4, §5, §6.9 (the motion catalogue, key map and defects).
5. `RC/gaps/engine-contract-rpc-stack.md` §3, §5, §7, and `RC/gaps/electron-email-html-isolation.md` §7, §9.
6. `research/pr21-onboarding-review.md` before U8.
7. `AGENTS.md`, `SPEC.md`, `DECISIONS.md`, `PROGRESS.md`, `TODO.md` on main, and owner memory notes on AI glyphs, Aplos UI taste and review budget.
8. Once it exists: `.claude/skills/aplos-design/SKILL.md`.

> **What this means:** The two binding documents come first, then this plan's shared designs, then only the research for the milestone in hand.

## 10. PR and branch strategy within the revamp

- **Nothing goes to main without the owner.** `revamp` is the integration branch; only the owner merges it, or anything from it, to main. Agents never merge PR #21.
- **The UI thread works on `rv/ui/<slug>` branches** (Git cannot hold `revamp/...` refs next to the `revamp` branch; `plans/00-roadmap.md` §4): one branch per milestone (`rv/ui/u3-identity`, and so on). Work packages are commits or short sibling branches (`rv/ui/u3-wp3.2-buttons`, never a folder under a milestone branch) merged by the orchestrator.
- **One pull request per milestone**, into `revamp`, after self-verification, with headless before and after screenshots in both themes attached through `gh --attach` and never committed (except the golden set). Review is requested once per milestone after the batch is verified, not after every fix.
- **Staying current:** `revamp` absorbs main whenever main ships a release (through plan 40's `format-merge.mjs` for anything cut from main before the format commit); merge `revamp` into the open `rv/ui/...` branch at each milestone start and after each such merge. Merges, not rebases.
- **Day-zero gate:** plan 40's Q1 format commit (day 1) and plan 10's E1 freeze window (rename of `src/engine` to `packages/engine`, then format, then the typed-client codemod, 24 hours, plan 10 §9) land on `revamp` before U0 branches; U0 starts at about week 1.2 and U1 may start alongside because it touches new files. **U0 never starts on the unformatted tree**, because the one-liners in `App.tsx` would be reformatted under it.
- **Main-bound slice.** The only UI work authored against main is the optional ARCH M0 `srcdoc` stopgap (§4.4 source 1), on `hotfix/0.2.4-srcdoc`, which joins PV0's `hotfix/0.2.4` train only if ready (PV0 never waits) and returns to `revamp` through `format-merge.mjs` if it lands after the format commit. U0 itself is authored on the formatted `revamp` tree and reaches main with 0.3.0, when the owner merges `revamp`; it is not ported to main separately. If the window slips, U0 waits and U1 and U3 planning proceed. Conflicts in reformatted files take the incoming version, then the formatter is re-run. `[mechanical]` commits are listed in `.git-blame-ignore-revs` (plan 40).
- **Shared hotspots** (`electron.ts`, `preload.ts`, `shared/types.ts`, `package.json`, `AGENTS.md`, `DECISIONS.md`): small isolated commits, merged early, reviewed by the owning thread.
- **Commits** are authored as Kainoa Newton (`k@kainoa.me`); any other `user.email` is flagged first. No keys, `.env` or real mailbox data in a commit or screenshot.
- **Reaching the owner:** a local packaged build (`npm run package`), a review packet and a short question list at each milestone close. U0 reaches main with 0.3.0 at the owner's word (Decision 1); the in-progress screens reach the owner on beta tags from `revamp`; the rest is proposed for main after the U9 dogfood week, as the single 0.4.0 release candidate shared with the engine soak (Decision 12). Stable releases are tagged from main; betas from `revamp`.

> **What this means:** Everything happens on side branches, one reviewed pull request per step, with main untouched until you say so.

## Evidence index

- **Binding documents:** `plans/DESIGN.md` (§2.3-§15, Appendix C); `plans/ARCHITECTURE.md` (§2.2, §3.5, §4.1, §5.1, §6.3-6.5, §7-§12, §14, §15); `plans/_council/CONTEXT.md`; `plans/_council/task-plan-30-ui-revamp.md`.
- **Research:** `RC/gaps/engine-contract-rpc-stack.md` (§1, §3, §5-§8); `RC/gaps/electron-email-html-isolation.md` (§1, §7-§10); `RC/ui/aplos-baseline.md` (§3-§6.9, §8); `RC/ui/superlocal.md` and `RC/ui/redakt.md` (resolver, skill method); `RC/gaps/identity-collision-audit.md` (§4); `RC/protocols/proto-others.md` (§5); `RC/SYNTH-ui.md` (§6); `research/pr21-onboarding-review.md` (all 14 findings).
- **Measured on Aplos main `72095ff`** (`apps/desktop`): `grep -c` counts in `src/renderer`, `wc` sizes, hold thresholds (`App.tsx:379`, `Compose.tsx:15`, `Ask.tsx:16`), `package.json` scripts, the `tests/` listing, renderer imports of `engine/*` and `shared/*`.
- **Cross-plan facts used in this revision:** plan 10 §4.0 (E-numbers, weeks), E1 deliverables 3 and 6 and §9 (codemod, fixture, 24-hour freeze window), E3 items 6 and 8 (`latestState` deleted, flip by flag), E5 item 5 (`Setup/*`), E8 item 4 (shim removal waits for the renderer on windows); plan 20 §4 (PV table, `baseline_done_at` at the end of P2, checkpoint facts in the plan 30 hand-over); plan 40 Q1 (`tools/lint/`, format commit day 1), Q3 (one Playwright base, CI slots `check:tokens`, `check:contrast`, `check:identity`, `test:visual`, `test:perf`) and the provenance gate (line 447).
- **PR #21 facts** [V by `gh pr view 21`]: head `2d8884662ee6`, 46 files changed (engine, main, shared, renderer, tests, web script), title "First run: onboarding in its own window, demo only on request"; its body describes the empty start, the corner demo link, the loading screen with a 60-second AI cap, and a fixed 720 x 560 window (DESIGN §7.11 replaces that with 640 x 600, resizable). Today's demo seeding: `src/engine/service.ts:195` (`store.read()||createDemo(now())`) [V]. `DECISIONS.md:125, :128, :129` quoted in U0 [V].
- **Not re-verified:** DESIGN's colour, contrast and spring numbers (U1 recomputes them); OOPIF keyboard routing ([U], U6); hidden-window timing validity ([U], U1).

> **What this means:** Every number in this plan is either measured on the current code, taken from the binding documents, or marked as a judgement or an open check.
