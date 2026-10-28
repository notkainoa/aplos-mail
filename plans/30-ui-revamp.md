# Plan 30: UI revamp (workstream plan)

Workstream plan for the UI-core and UI-screens threads, 2026-10-27, branch `revamp`. Planning only: nothing here goes to main and PR #21 stays unmerged. **Aligned to `plans/00-roadmap.md` on 2026-10-27.** The roadmap is the source of truth for lanes, days, branch names and the release plan; where this plan disagrees with it, the roadmap wins. This plan implements `plans/DESIGN.md` and `plans/ARCHITECTURE.md`, both binding, and "DESIGN §x" or "ARCH §x" points into them. The design was revised after the owner reviewed the HTML mockups, and DESIGN.md now describes the revised design, named **Paper** (2026-10-27). The mockups in `mockups/` are the visual target, and each DESIGN §7 section names its mockup. `mockups/DESIGN-CHANGES.md` is the history of that revision; cite DESIGN.md instead. `RC/` means `research/email-clients/`. **Milestone names:** U1-U9 are kept as citations, and the roadmap re-cuts them into the eight `ui-*` lanes (see "Lanes and phases"). Engine work uses plan 10's **E-numbers** and the `eng-*` lanes, providers use plan 20's **PV-numbers** and the `prov-*` lanes, and plan 40's **Q-numbers** map to `plat-ci`, `plat-release` and `web`. ARCH's M-numbers appear only in brackets.

**Evidence labels.** **[V]** verified by me in a file or by a command on Aplos main at `72095ff` (path or command given). **[C]** a claim in a project or document I did not re-verify. **[I]** my judgement. **[U]** unverified, to be checked live. Counts marked [V] come from `grep` over `apps/desktop/src/renderer` on main.

## In plain English

This plan covers how the screens look, move and respond.

Today the screen code is about 8,500 dense lines, with 56 one-off animations and about 70 hard-coded colours. Nothing checks that a screen follows the design. So the rules and checks come first, and the screens second.

There is no early fix release, so the old screens are not patched. Their checks move into the new design system, and each known bug gets a test in the screen that replaces it.

Eight lanes in two threads build the screens. In days 1 to 3 the first thread writes the colours, style rules, component list and data hooks. Main screens run on demo mail by day 9 and switch to the real engine on days 11 to 13. Days 15 to 18 cover accessibility, speed and the release candidate.

The look is quiet gray and white, with ink blue for the main action and a serif for AI text. There are no sky backgrounds and no margin column. Hovering never moves anything.

Gmail needs a weekly reconnect, so the screens get a reminder line, a reconnect sheet and a Settings button.

You review once per phase and judge look and feel. You also try VoiceOver and connect a real Google account through onboarding.

## Decisions for you

Each question keeps its number. Answered or superseded ones carry the date; the others use their default unless you say otherwise. The master list is `plans/00-roadmap.md` §8, and its numbers for the same questions are in brackets. Only decision 4 still needs a look, and silence keeps every default.

| # | Question | Status | Answer or default | What happens now |
|---|---|---|---|---|
| 1 | Ship the trust fixes (old step U0) to main early? | Moot, 2026-10-27 | No 0.2.4 and no interim release (roadmap old #1 and #43) | U0 is dropped as a milestone. Its checks and fixes go into `ui-foundation` and the new screens. |
| 2 | Who picks the serif, and when? | Answered, 2026-10-27 | Yes to a serif for AI text (roadmap old #10); Newsreader | A one-page look sheet joins the day-9 review to confirm size and weight. `summary` and `answer` can switch to SF by changing one token. |
| 3 | When do the screens switch from the stand-in engine to the real one? | Answered, 2026-10-27 | Days 11-13, by one flag, once `eng-views` passes conformance on the real engine (roadmap §2.6) | One redesigned release. Nothing the owner installs for daily use shows stand-in data. |
| 4 | What happens to PR #21? | Open, default applies | (a) `ui-onboard` absorbs its screens by path and the owner closes the PR as superseded [44] | (a) keeps its work without a throwaway merge. (b) would put a screen on main that gets rewritten. (c) loses working code. |
| 5 | Where are the reference screenshots stored? | Open, default applies | (a) A small golden set in the repository plus same-machine comparison [45] | (b) would add tens of megabytes per refresh. |
| 6 | May the UI lanes design the small missing screens in section 4.5? | Open, default applies | (a) Yes, inside DESIGN; the owner reads the copy at the day-9 and day-15 reviews [46] | Asking each time would stall small items. |
| 7 | Tap versus hold on R and A? | Open, default applies | (a) R opens the reply instantly and holding adds dictation, one 250 ms threshold [47] | Removes a small wait on every tap. |
| 8 | How does the owner try builds? | Revised, 2026-10-27 | Per phase: the browser preview on days 9-10, local packaged builds from day 15 [48] | Replaces "a build per milestone". |
| 9 | A seven-day week of using it on real mail before anything goes to main? | Open, default applies | (a) Yes, Phase 3, days 18-25 [49] | Finds problems tests miss. |
| 10 | How does the onboarding window look? | Superseded, 2026-10-27 | Full-bleed white paper with no sheet, no sky and no app icon (DESIGN §7.11) | Roadmap §8.3 #50 still says the app icon on Welcome is the only sky, but the owner later dropped the icon (DESIGN decision 13). This plan follows DESIGN. |
| 11 | After setup, does Aplos open by itself? | Open, default applies | (a) Yes, only on a clean finish [51]; Esc always opens Aplos from the first-sync screen (DESIGN §7.12) | Any problem waits for the owner. |
| 12 | When is 0.4.0 released? | Answered, 2026-10-27 | One redesigned release, proposed 0.3.0; there is no 0.4.0 (roadmap old #9) | The release candidate (days 17-18) is shared by the daily-use week and the engine soak. |

The design thread's questions are answered in DESIGN's Decisions (2026-10-27): the app icon is dropped from the app (decision 13), the design system is named Paper (15), account dots show on rows only with two or more connected accounts (16), and Home's sections, order and count are settled (17-19, DESIGN §7.2). Its answer on the website (14) defers the site redesign until a new logo exists, while roadmap §2.5 has the `web` lane remove the stripe now. That conflict belongs to the Integrator and the owner, and this plan does not touch `apps/web`. The weekly Gmail reconnect (roadmap N3) shapes U5, U7 and U8.

## Lanes and phases

Roadmap §2.3, §2.4 and §2.6 cut this plan's milestones into eight lanes. U-numbers stay as citations. Day 1 is the owner's go. Phase 0 is days 1-3, Phase 1 days 4-13, Phase 2 days 11-18 and Phase 3 days 18-25. Each lane owns its paths exclusively.

| Lane (thread) | Work from this plan | Phase | Days |
|---|---|---|---|
| `ui-foundation` (UI-core) | F9 on days 1-3 (tokens, lint rules, `aplos-design` skill v1, component list with frozen props, `CommandRegistry` interface, data-hook signatures). U1 (registry and resolver, harness with the hover-never-shifts check, contrast and identity CI, fonts, timing spike). U3 (components as revised). The checks of the old U0 (banned strings, identity, the AGENTS.md rule, retiring "match the reference"). | 0, then 1 | 1-3, then 4-9 |
| `ui-shell` (UI-core) | U2 (data layer and typed client on the stand-in engine). U4 (motion as revised). U5's shell (regrouped sidebar, pane header, status slot with the weekly reconnect line, toasts, trays, error states). WP5.6, the switch to the real engine. | 1, then 2 | 4-11; switch 11-13 |
| `ui-home` (UI-core) | U5's screens: Home, Later, All mail, Drafts, Sent, Trash, Spam, labels, Done, one-by-one, empty states | 1 | 5-12 |
| `ui-reader` (UI-core) | U6: reader, mail frame host, inline reply, compose, outbox and undo tray | 1 | 5-13 |
| `ui-onboard` (UI-screens) | U8: onboarding window, first-sync screen, consent, demo on request, PR #21 absorbed by path, Appendix C findings, and the weekly reconnect sheet | 1 | 5-12 |
| `ui-calendar` (UI-screens) | U7's Calendar | 1 | 6-12 |
| `ui-settings` (UI-screens) | U7's Settings, including the account Reconnect row | 1 | 6-12 |
| `ui-ask` (UI-screens) | U7's command palette, search page, Ask dock and Today | 1 | 6-13 |
| After Phase 1 | U9: deleting the legacy renderer (Integrator with each lane); accessibility, performance and the release candidate (`ui-foundation`, `plat-release`, Integrator); the daily-use week | 2, then 3 | 14-17; 15-18; 18-25 |

**U0 is not a milestone.** Its content went to `ui-foundation` (the checks), to the new screens (the 17 Avec-derived items and the ten defects, each mapped to a lane and a test in the U0 section) and to nowhere else, because today's renderer is read-only reference until it is deleted. **Owner touchpoints for these lanes:** the day-3 freeze note (the UI reviewer lists what the contract cannot express), the day-9 and day-10 look review (Home, reader and compose on demo mail, the serif sheet, motion feel), days 14-16 (real onboarding with a Google account, one send to yourself, keys with focus inside an email), day 15 (an hour on real mail), and days 18-25 (daily use with VoiceOver and input-method checks, which includes the first real weekly reconnect).

## 1. Scope and non-goals

**In scope** (everything in `apps/desktop/src/renderer`, plus the few non-renderer files named in §5):

1. **Tokens and theming:** `tokens.json`, its generator, light, dark and Increase Contrast, and density (DESIGN §4 as revised, §12.1). There is no bridge from the old variables, because the old screens are not migrated.
2. **The motion system and its enforcement:** runtime, lint rules, the `aplos-design` skill, filmstrip tests (DESIGN §4.8, §5, §12).
3. **The component library** (DESIGN §6), **every screen** (§7), the `CommandRegistry`, palette and search (§7.9, §8).
4. **Live windows instead of whole-`AppState`:** the typed client, a final-shaped data layer on the stand-in engine, and the switch to the real engine (WP5.6). There is no adapter and no legacy bridge.
5. **The email HTML frame, UI side** (ARCH §10).
6. **Onboarding and the first-sync loading screen:** absorb PR #21's screens (not its engine half) and fix its 14 findings (DESIGN §7.11-7.12, Appendix C), shaped to the owner's wishes (§5 U8).
7. **Removing every Avec-derived layout, phrase and decision** (all 17 items of DESIGN §13, accounted one by one in the U0 section and enforced by `ui-foundation`'s tests), **accessibility** (§11), and the **visual and performance harnesses** (§12.5-12.6).
8. **The weekly Gmail reconnect surfaces** (roadmap N3): the status-slot line, the reconnect sheet and the Settings account row (U5, U7, U8).

**Non-goals.**

- No change to what the engine stores, syncs or sends. Needs from the engine are stated in §8; plans 10 and 20 deliver them.
- No redesign: DESIGN.md is binding. Gaps (§4.5) are filled inside Paper's grammar and flagged.
- No Windows, Linux or phone UI, no new AI features, no telemetry.
- No release engineering, CI provisioning or website work. `apps/web` belongs to the `web` lane (roadmap §2.5), and this plan does not touch it.
- No merge of PR #21 and nothing to main. No reference code, assets, branding or wording (DESIGN §14); reference colours appear only as numbers in the identity check.

> **What this means:** This plan builds the app's face and hands. It asks the engine team for specific things and does not reach into their files. It also does not decide the look again, because that is settled.

## 2. Starting point (measured)

All [V] unless marked, on main `72095ff`, `apps/desktop/src/renderer`.

| Fact | Value | Why it matters |
|---|---|---|
| Size | 8,534 lines, about 375 KB; `App.tsx` 63 KB with 76 lines over 200 characters | Dense one-liners resist mechanical edits, so the new renderer is written fresh and today's is read-only reference under `renderer/legacy/` |
| Engine calls | 53 `invoke(` sites in 15 files; `bridge.ts` is a hand-rolled fetch fallback with no token | The new renderer uses the typed client from day 4 (U2). There is no codemod, and legacy keeps its sites until it is deleted |
| Mailbox model | `App.tsx` loads 400 threads, then pages of 2,000 until all are in memory; `shared/live.ts` re-snapshots on a gap (`RC/gaps/engine-contract-rpc-stack.md` §1) | The new renderer uses windows from the start (switch to the real engine in WP5.6, days 11-13); the legacy loader is deleted in Phase 2 |
| Engine imports | Renderer imports `engine/discover` (2) and `engine/provider` (1) | The new renderer imports no engine code; discovery goes through `Account/discover` |
| Literals | 70 hex, 57 `rgba(`/`hsl(`, 56 `@keyframes`, 62 `setTimeout`, 41 radius px, 60 font-size px (token files included) | The reason for the lint rules (U1). The new tree starts at zero and `legacy/` is excluded until it is deleted |
| Banned phrases | 18 source lines ("Todo", "Hold to talk", "Swipe through", "Hide all", "Ask me anything") | `ui-foundation`'s banned-string test (the old U0) |
| Hold timings | 300 ms (`App.tsx:379`), 250 (`Compose.tsx:15`), 220 (`Ask.tsx:16`) | The registry unifies them (§4.2) |
| Tests | 36 `node --test` files, engine and pure logic only; **no renderer test, no Playwright, no `lint` script** | `ui-foundation` (U1) builds all UI test infrastructure on F8's pinned Playwright base |

The tap-versus-hold logic is the one place where today's code makes input wait: in the reader Space acts only on keyup (`App.tsx:396`), and in Ask's field the typed letter is held back (`Ask.tsx`). DESIGN §5 rule 1 forbids that; §4.2 resolves it.

> **What this means:** The current screens work, but they are one dense block with no automatic checks and no UI tests. `ui-foundation` therefore builds the safety net in days 1 to 9, and the screens build on it.

## 3. Shape of the work

### 3.1 Principles for this workstream

1. **Safety net before screens.** Tokens, lint, the harness and the registry exist before any screen is rebuilt (U1).
2. **Build against the final data shape.** Screens use `useView`, `useRow`, `api.*` and receipts, first against the stand-in engine (`packages/contract-fixture`, also called the fixture), then the real one after the switch (§4.1).
3. **One review packet per lane milestone:** headless screenshots in both themes, a filmstrip where motion changed, test output paths, open questions. Evidence goes in `PROGRESS.md`; TODO items are checked only with evidence (AGENTS.md).
4. **Headless only** (owner rule), and **two stages where the engine lags:** the UI ships first behind an interface with a labelled interim path, then switches (U6's `srcdoc` frame on the stand-in engine, U8's `Setup/*` calls on the stand-in, and the data switch in WP5.6).

### 3.2 Timeline and critical path

Days are calendar days from the owner's go, on the roadmap's clock (roadmap §4). The "Lanes and phases" section near the top maps each milestone to its lane and days. This table adds what each milestone needs and its effort. Effort is working days of agent work inside the lane, so it can exceed the lane's day range when the lane fans out agents. U8's lane starts first among the screen lanes, because onboarding needs only F9 and the stand-in `Setup/*`, and it is the screen that makes the first real Gmail sync honest.

| Milestone | Lane | Needs (F = frozen artifact; `eng-`, `prov-`, `plat-` = lanes) | Effort (working days) |
|---|---|---|---|
| U1 | `ui-foundation` | Phase 0 restructure steps 2 and 4 (format, lint config) so `tools/lint/` exists; F8's pinned Playwright base. No engine need | 7-10 |
| U2 | `ui-shell` | F1, F2 and F6 (day 3) | 4-6 |
| U3 | `ui-foundation` | U1 and F9. No engine need | 8-12 |
| U4 | `ui-shell` | U2 and U3. Stand-in engine only | 6-9 |
| U5 | `ui-shell`, `ui-home` | U4; stand-in views. **WP5.6 needs `eng-views` conformance green on the real engine (day 11)** and `prov-gov` status values | 9-11 |
| U6 | `ui-reader` | U5; **`eng-html`** for the real frame (days 4-10, `srcdoc` against the stand-in until then); **`eng-time`** for submissions (days 4-10) | 8-12 |
| U7 | `ui-ask`, `ui-settings`, `ui-calendar` | U5; `eng-ai` (provider table, Ask frames, settings fields), `eng-host` (listener and diagnostics methods), `prov-cal` fields (frozen in F1) | 8-12 |
| U8 | `ui-onboard` | F9 components; stand-in `Setup/*` and `Demo/*`; **`eng-ai`** real `Setup/*` and consent for Phase 2; **`prov-gov`** status and reconnect facts; PR #21 | 6-9 |
| U9 | `ui-foundation`, Integrator, `plat-release` | The switch (WP5.6); `eng-host`'s HTTP binding; `plat-ci`; live providers for the daily-use week | 7-10 |
| **Total** | | | **63-91 days of effort, fanned out over eight lanes** |

**Reconciliation with the other schedules.**

- **DESIGN §15's delivery order** is replaced by the lane mapping (roadmap §10). Its five stages become the old U0 checks and U1 (stage 1 and 2, `ui-foundation`), U3 (stage 3), U4 (stage 4) and U5-U8 (stage 5) [I].
- **ARCH §15's phases** run in days on the roadmap's clock. The UI no longer trails the engine. Every lane codes against the stand-in engine from day 4, and the switch on days 11-13 closes the gap.
- **Range** (roadmap §4.2). Best case: a daily-use build on day 15 and the finished version on day 22. Likely: day 17-18 and day 25, with one contract addition, one Gmail live fix and a day of review wait per phase. Slow: day 25 and day 35, where a design rework is one of the named causes.
- **One release.** The redesigned release (proposed 0.3.0) comes from one release candidate on days 17-18. The daily-use week (days 18-25) and the engine's soak run on that same candidate (Decision 12).

**Critical path** (roadmap §4.1 item 2). F9 on day 3, then components and data hooks (days 4-8), then screens on the stand-in engine (days 5-13). `eng-views` passes conformance on the real engine on day 11, the switch follows (days 11-13), then end-to-end runs on emulators (days 12-15) and the owner's look check on real mail (day 15). The chain meets the Gmail chain at the release candidate. `ui-reader` is near-critical because it needs `eng-html` and `eng-time`. U1's four packages (tokens, lint, registry, harness) are independent, U3 fans out per component family, and the screen lanes fan out once F9 is frozen. If F9 slips, tokens and components still proceed and the screen lanes start on plain components.

### 3.3 How a work package is written

Each milestone below lists **work packages (WPs)**. A WP is one Claude Code workflow node: a brief, files it may touch, a definition of done, and an adversarial verifier.

- **Fan out:** separate agents on disjoint files, one integrator. **Verify adversarially:** a separate agent with no sight of the author's reasoning tries to break the result and reports evidence.
- **Models** follow the owner's rule: Claude models for UI. Opus 5.5 for complex or high-visibility work (data layer, reader, mail frame, motion, Home, Calendar layout); Sonnet 5.5 for routine screens and mechanical migration; Haiku 5.5 for greps, test runs and summaries.
- Every UI WP loads `aplos-design` once it exists (U1), `DESIGN.md` §3-§5 before then. The installed `emil-design-eng`, `animate` and `break-ui` skills are reviewer aids, not substitutes.

> **What this means:** The eight lanes finish their first versions around days 12 to 13, the switch to the real engine happens on days 11 to 13, and the release candidate is ready on days 17 to 18. Each pull request is small enough to review and reverse.

## 4. Technical designs that cross milestones

### 4.1 The renderer data layer and the move from `AppState` to windows

**Target.** The renderer holds no mailbox: an ID-keyed row cache per type, watched windows of at most 200 body-free rows, small singletons (`Session`, accounts, folders with counts, settings, calendars) and an optimistic overlay (ARCH §9.2). Opening a window costs 0.1-0.5 ms in the engine at 100k threads [V `RC/gaps/engine-contract-rpc-stack.md` §3.2].

**Modules** (all under `renderer/data/`, owned by this plan):

| Module | Job |
|---|---|
| `client.ts` | Wraps the generated typed client. Transport: a `MessagePort` from preload in Electron, the tokenised HTTP and SSE binding in the browser preview. Sets `z.config({jitless:true})` (the CSP forbids eval, ARCH §9.3). Replaces `bridge.ts`'s `invoke`. |
| `rows.ts` | Row cache by type and id, reference-counted by windows and components; an unchanged `rev` keeps object identity. |
| `windows.ts` | `useView(spec, {holdIds})` returns `{ids, total, rows, move, state}` over a `WindowSource` interface with one implementation, `engineWindows` (`View/watch`, `View/move`, `View/unwatch`), which talks to the stand-in engine until the switch (WP5.6) and to the real engine after. Reopens on `reset` or `cannotCalculateChanges`; fetches only unknown or stale rows. |
| `optimistic.ts` | Overlay entries `{opId, targets, patch, originalPosition}` applied synchronously; dropped when a window reaches `receipt.appliedState`; on failure the row returns with an inline error and Retry (DESIGN §5 rule 11). Undo calls `Operation/undo`, an inverse operation. |
| `session.ts` | `Session/get`, `apiVersion` check, capability flags, status vocabulary (ARCH §6.4). |

**Build order (no strangler, no legacy bridge).**

1. **U2 (`ui-shell`, days 4-8).** Build `renderer/data/` to its final shape on F1, F2 and F6, with the hook signatures frozen in F9 on day 3. The new renderer starts at `renderer/main.tsx` and boots on the stand-in engine. Today's renderer sits in `renderer/legacy/` (Phase 0 restructure step 1) behind a development flag. There is no codemod over today's 53 `invoke(` sites and no adapter, because no release ships today's screens on the new engine. An ESLint `no-restricted-imports` rule forbids `AppState`, `shared/live`, `engine/*` and `renderer/legacy/**` in the new tree.
2. **The lanes (days 5-13).** Every screen uses `useView`, `useRow` and `api.*` over the stand-in engine. **Release rule:** no release ships before the switch. Screens that run only on the stand-in engine are development builds, and nothing the owner installs for daily use shows stand-in data in place of real mail. Local or private draft builds (`v0.3.0-beta.N`) come after the switch.
3. **The switch (WP5.6, `ui-shell` with the Integrator, days 11-13).** `WindowSource` moves from the stand-in engine to the real one by one flag, once `eng-views` passes the conformance suite on the real engine (day 11). The same expectations hold because both engines run the same suite.
4. **Phase 2 deletion (days 14-17).** The Integrator, with each owning lane, deletes `renderer/legacy/` (today's `App.tsx` loader, `bridge.ts`'s web fallback, the use of `shared/live`, any `legacy.css`). Roadmap §2.6 lists this step, and U9 covers it.

**View specs the UI requires** (plan 10 owns the SQL; the UI states the need). Today's `threadInView` and `isHomeNew` in `shared/mailbox.ts` become these:

| Spec | Used by |
|---|---|
| `home` sections, in order: `do` (with a `fromLater` flag for Later items whose date has arrived, which sit at its bottom), `update`, then `follow` (the user sent the last message and no reply came within the nudge period; longest wait first). `do` orders by due band, importance, due date, then newest; `update` by importance, then newest (DESIGN §7.2, ARCH §8.2). Rows carry `lane`, `importance`, `due_date` and `due_source`. Account `all` or one id. **Done on mail that still needs a reply leaves Home** (DESIGN decision 6). `eng-views` writes the SQL, and `shared/mailbox.ts` is legacy | Home |
| `home.low` grouped by sender (per-sender counts, latest names for the band's "up to three") | Low-importance band and sheet |
| The follow-up suggestion for a `follow` thread (`eng-ai`'s `followup` job; absent with AI off or without consent) | Home's Follow up, inline reply |
| `later` by overdue, today, week, someday; `bookmarks` | Later |
| `mailbox` by role or label id (keyset); the Done place is a `mailbox` view with `in:done` | Lists, Done |
| `search` with parsed operators, `local` or `remote` (remote only on Return, ARCH §3.4) | Search |
| `thread` messages and `MessageBody/get` | Reader |
| Folder counts: unread threads, Home (`do` plus `update`), Later due now, Drafts | Sidebar |
| `Event/query` by range and calendars; today agenda; conversations | Calendar, Today, Ask |

**Holding still, in two halves.** DESIGN's `hold` (rows pinned by transform for up to 1,200 ms) is the renderer half; the contract's `holdIds` is the engine half. During a hold the renderer queues incoming frames and renders the held order, then reconciles with FLIP (`close`). It sends `holdIds` for the rows around the cursor so an AI re-rank cannot reorder them [I]. Frame arrival never moves the row under the cursor (DESIGN §5 rule 6).

**Pop-out windows** (`?thread=` and `?draft=` today, `App.tsx:38`) get their own port and the same hooks. **Binary data** (attachments, audio) moves as a transferable `ArrayBuffer` or blob route, never base64; `useVoice.ts` follows, with a shim until the contract supports it.

**Acceptance for the seam.** A property test applies random sequences of optimistic commands, receipts, window frames, `reset`s and undo, and asserts the cache converges to engine truth with no duplicate or lost row. It covers receipt-before-frame, frame-before-receipt, reset mid-overlay, and two windows holding the same row.

### 4.2 `CommandRegistry` and the input pipeline

**Registry.** One table, `renderer/commands/registry.ts`. Each command has `id`, `label`, `icon`, `keys` (per context, remappable), `contexts`, `when(ctx)`, `run(ctx)`, `holdRun?(ctx)`, `undo?`, `confirm?` and a palette `group`. It is the only source for: the key handler (replacing the legacy `keyboard()`, `App.tsx:362`), the palette, menus, tooltips, the shortcut sheet and toast keycaps (DESIGN §6 `CommandRegistry`).

**Resolver.** A pure function `resolve(event, contextStack, bindings, prefs)` returns `{command, phase}` or nothing. It is table-tested (Superlocal's idea, `RC/ui/superlocal.md`). Rules, all from DESIGN §5 rule 16 and §8:

- Never act while `isComposing`; use `event.key`; ignore Caps Lock. Single-key shortcuts are off in text fields (globally switchable, WCAG 2.1.4).
- The context stack comes from `data-keyctx` attributes on the focused element's ancestors plus the route: global, list, home, reader, compose, ask, calendar, palette.
- A binding exists once per context; a test fails on a duplicate (this finds today's `keys.s` double assignment, DESIGN §8).
- A capture-phase queue replays keys that arrive during a mount or transition on the next frame (DESIGN §5 rule 4).

**Tap versus hold without waiting** (the one place this plan interprets DESIGN rather than copying it [I]).

- DESIGN §8 says "tap to act; hold to say it" and §5 rule 1 says state commits on keydown. They agree if the tap action starts on keydown and a hold *upgrades* it.
- **R:** keydown opens and focuses the inline reply; a hold past the threshold starts dictation into it. **A:** keydown opens and focuses Ask; a hold dictates. **Space** in a list or the reader is the suggested action on keydown and is not a hold key; in an empty compose body, hold Space dictates.
- In Ask's own field the letter is inserted on keydown and removed if the hold completes, so typing never waits (today's code holds the letter back).
- One threshold setting, default 250 ms, replaces today's 300, 250 and 220 [V]. The owner confirms the default at the day-9 review.

**Remapping and the sheet.** Settings → Keyboard (U7) edits bindings stored in the engine's settings object (§8). The shortcut sheet is generated from the registry; a test asserts every command is in the palette and the sheet.

### 4.3 The motion runtime

`ui/motion.ts` is generated from `tokens.json` (durations, easings, springs with their `linear()` strings) plus hand-written runtime modules next to it:

- **`ghost.ts`.** Clones the leaving element with fixed geometry, removes the real one, animates the clone with WAAPI (`transform`, `opacity`). At most three ghosts; a fourth finishes the oldest. Reduced motion maps `flight` and `carry` to an 80-120 ms fade.
- **The hold controller (`renderer/data/holds.ts`, one controller for data and motion; planned as `motion/holdGate.ts`).** Starts on a triage key, releases 450 ms after the last key or when the pointer leaves the list (cap 1,200 ms past the last key, ui-shell DECIDED 2026-10-28 03:03); rows below are pinned by transform. Release runs `close`, a FLIP computed from **fixed row heights**, so no measuring and virtualisation does not matter.
- **`rapid.ts`.** Rapid mode starts when triage keys arrive under 300 ms apart; from the fourth key in a second, `flight` becomes a 60 ms `carry`.
- **`spring.ts`.** A JS solver keeping value and velocity so a gesture retargets mid-flight; compiles each spring to its `linear()` string; stops on `pointercancel`, pauses when hidden.
- **`cursor.ts`.** One shared cursor layer moved by transform; 0 ms on key repeat and pointer moves.

**React stays out of the frame loop.** The list cursor and selection live in a small external store read with `useSyncExternalStore`. The cursor layer moves imperatively. Triage commits the overlay synchronously and re-renders only the virtualised window of roughly 30 rows. This is what makes "key to state 8 ms or less" credible [I]; U4 measures it.

**Enforcement.** The lint rules (DESIGN §12.2) reject literal durations, easings and layout-property animation. A harness assertion walks `document.getAnimations()` during every filmstrip and fails if any animation's keyframes touch anything but `transform`, `opacity` and the hover colour properties.

### 4.4 The email HTML frame on the UI side

The engine's `packages/mail-html` sanitises; main serves `aplos-mail://m/<token>` with headers; `ui-reader` owns the host component (`renderer/mailframe/MailFrame.tsx`). The design is `RC/gaps/electron-email-html-isolation.md` §7 and §9, adopted by ARCH §10.

**Component contract** (`MailFrame` props: `messageId`, `imagePolicy`, `findQuery`, `onReady({height, bg})`, `onKey`). It supports two sources behind one interface.

1. `srcdoc` against the stand-in engine: a same-origin frame with no scripts and an inner meta CSP. Height is read synchronously. `ui-reader` builds against this until `eng-html` lands (days 4-10), so the reader is complete before the real frame exists. It is a development path, never a shipped fallback, and builds the owner installs use the second source.
2. `aplos-mail`, the final form: sandboxed `allow-scripts allow-popups`, no `allow-same-origin`, no preload, one hash-pinned reporter script.

**Host duties** (from `RC/gaps/electron-email-html-isolation.md` §9):

- **The double buffer completes on a message, not a layout read.** Expect 15-70 ms; 1.5 s is a ceiling only. Mount the pending frame at the final width and ignore reports of another width. The previous letter stays until the new one reports; after 1.5 s show the 12 px "Loading Maple Library…" line (DESIGN §5 rule 10).
- **Accept a message only when** `event.source` is the frame's `contentWindow`, `origin === 'null'`, the token matches, and `h` is finite and clamped to 1-200,000. Parse `bg` strictly. A unit test feeds spoofed messages.
- **The paper tint arrives with the height.** HTML mail sits on a light paper (`color-scheme: light`); plain text follows the theme and renders as escaped host DOM, no frame. Keep one hidden warm frame so J/K never pays the roughly 65 ms cold start. Never animate frame height.
- **Key relay.** Main's `before-input-event` sends `mail-key` events to the registry (ARCH §10); arrows, Space and Page keys scroll the reader; Esc returns focus. Whether it fires for out-of-process frames is **[U]**, hand-checked in the packaged app on days 14-16 (§6.5). The fallback relays J/K, scrolling and Esc only, never E, Space or R.
- **Chrome stays outside the frame:** "Load images from this sender" and "N trackers removed"; changing policy or find query re-renders with a new token through the same buffer.
- **Quoted text.** The `<details>` toggle is in the document. For the O key, either re-render with a new token or let the one hash-pinned reporter accept a verified `{token, toggleQuotes}` message. The second is smoother and needs `eng-html`'s approval (§8) [I]. Pop-out and print use a `WebContentsView` with `javascript:false` (main).

### 4.5 Surfaces the architecture implies and DESIGN does not draw

ARCH adds behaviour that needs a screen DESIGN §7 does not draw. Each is named here with a treatment built from existing Paper parts (no new colour, radius, button style or glyph); the owner reads the copy at the day-9 and day-15 reviews.

| # | Surface (source) | Treatment | When |
|---|---|---|---|
| 1 | **Consent card** before background AI (ARCH §8.3) | A card (`--elev-card`) in the onboarding AI step: provider, model, what is sent, a note that Ollama and LM Studio stay on the Mac, filled "Allow", text "Not now". A provider change shows an `ErrorLine` in Settings → AI ("Background summaries are paused until you agree to the new provider.", filled "Review"). Nothing on the mail surface. | `ui-onboard` |
| 2 | **Settings rows:** per-account "Use this account's mail for AI" (ARCH §8.3); "Background work runs on: MacBook Pro" with "Use this Mac" (§6.5); retention "Keep message text for 90 days, plus anything opened, starred or unread, up to 2 GB" (§3.6); daily AI cap with "Paused for today. Resumes tomorrow." in Settings only (§8.4); "Keep Aplos in the menu bar when the window closes" and "Open Aplos when you log in" (§2.2) | Plain `SettingRow`s; the menu-bar menu and quit prompt are native | `ui-settings` |
| 3 | Diagnostics and queue inspector (ARCH §11) | Help: "Export diagnostics" opens a `Dialog` previewing the content-free bundle; an inspector page lists ops, jobs and submissions with Retry and Discard; the parked engine is a `FatalScreen` ("Try again", "Export diagnostics") | `ui-shell` (`FatalScreen`), `ui-settings` (inspector) |
| 4 | Submission states (ARCH §6.3, §7.1, §7.3) | In the `UndoTray` slot: "We could not confirm this was sent. Check Sent, or Send anyway." / "Missed its time while your Mac was off. Send now or Reschedule." / "Couldn't send until 2:14 PM. Your draft is saved." | `ui-reader` |
| 5 | Draft edited elsewhere (ARCH §7.4) | Inline card: "This draft changed on another device." with "Keep mine", "Take theirs", "Keep both" | `ui-reader` |
| 6 | Status vocabulary (ARCH §6.4) | StatusSlot copy per state (table in U5) | `ui-shell` |
| 7 | iCloud and Fastmail add-account presets (`RC/protocols/proto-others.md` §5), round 2 | Preset copy for app-specific passwords and username rules. In round 1 the account step offers Google only | `ui-onboard` |
| 8 | **Zero-accounts state and demo controls** (PR #21 "start empty, demo only on request") | With no accounts the mail window shows one `EmptyLine`: "No mail yet." with filled "Add an account" and text "Try demo mail". Settings → Help gets "Load demo mail" or "Reset demo mail", and demo accounts can be removed like any account. Never shown while a first sync is running | `ui-onboard` |
| 9 | **Show welcome again** (today's Settings entry; the F1 and F9 reproductions need it) | Settings → Help, "Show welcome": opens the onboarding window beside the mail window without changing anything | `ui-onboard` |
| 10 | **First-sync honesty rules** (ARCH §5.1, §6.4; plan 20 `baseline_done_at`) | While an account is backfilling or paused, an empty Home shows `EmptyLine` "Your first mail is on its way." with the status slot's reason, never the inbox-zero block, which shows only with status `ok` and the baseline done (DESIGN §7.2, §7.14) | `ui-home`, `ui-onboard` |
| 11 | **Weekly Gmail reconnect** (roadmap N3) | A status-slot line a day before `reconnectBy` with "Reconnect now"; a reconnect sheet (`login_hint`, plain progress, no resync); a Reconnect row on the Settings account | `ui-shell`, `ui-onboard`, `ui-settings` |

> **What this means:** The data layer, the key system, the motion code and the email frame are each designed once, up front, so eight lanes do not invent eight versions. Eleven small surfaces that the engine plan, PR #21 or the weekly reconnect imply and nobody drew now have a stated home.

## 5. Milestones

Every milestone has the same fields: goal, deliverables, ownership, dependencies, acceptance evidence, estimate, work packages. Each names its lane (see "Lanes and phases"), and paths are the lane's exclusive paths from roadmap §2. "Owns" means this plan edits the path freely; "touches" means a small, reviewed edit coordinated with the owning plan.

### U0. Trust and identity fixes (dropped as a milestone)

**Status.** Dropped on 2026-10-27 (roadmap §10, plan 30 item 2). There is no 0.2.4 and no interim release (Decision 1 is moot). Today's renderer moves to `renderer/legacy/` in the Phase 0 restructure, stays as read-only reference, and is deleted in Phase 2, so nothing patches those screens. What U0 was for moves into the lanes:

- **`ui-foundation`, days 1-3, with F9.** The banned-string test, extended to the Avec-specific class names and constants listed below (`dock-pill`, `deck.has-next`, `low-line`, `rotateY(`, and the Avec hex values of `lint/identity-references.json`). It runs on the new tree and excludes `renderer/legacy/` until that folder is deleted. The identity check against Avec's colours lands with it. A stopgap `tests/ui-copy.test.ts` is not needed, because the ESLint rule exists from day 3.
- **Retire the decisions that told agents to copy.** In `DECISIONS.md`, supersede "Visual parity (M14)" (`:125`) and "Interaction parity (M16)" (`:129`) and correct the false claim at `:128`. Add to `AGENTS.md` one rule: "The reference apps are ideas only; DESIGN.md is binding; load `aplos-design` before renderer work" (the rule links to DESIGN.md until the skill lands in F9). This goes in `ui-foundation`'s first PR, so no agent reads "match the reference" during the build.
- **The copy table of DESIGN §10** applies to every string in every new screen, checked in `aria-label`, `title`, `placeholder` and tooltips by the harness's DOM text scan. Every lane owns its own strings.
- **Dropped.** The interim contrast and fade fixes in today's `tokens.css`, the optional interim palette and the stopgap Playwright skeleton are not built. The new tokens carry their own contrast pairs (DESIGN §4.1 and §12.4), the Home distance fade is gone (DESIGN §4.1), and F8's pinned Playwright base plus the U1 harness replace the skeleton.

**The 17 Avec-derived items of DESIGN §13, accounted one by one.** The locations are in today's code (now legacy) and are kept so the ban test can find each string. The new screens never contain these items. Each row names the lane that owns the replacement and what the revised design draws instead.

| # | Item (DESIGN §13) | Lane | What the new screen does |
|---|---|---|---|
| 1 | "Swipe through them" pill beside "New" (`App.tsx:498`, used at `:510`) | `ui-home` | "Go one by one" as a quiet dim text button on the Do now label, key S (DESIGN §7.2); no pill |
| 2 | Floating bottom cluster: bookmark, Todo, big Reply/Space pill, Done, Undo circle (`Reader.tsx:175-186`, `reader.css:313-321`, `.dock-pill`) | `ui-reader` | One action row under the summary: the filled suggestion with Space, then Later and Done as text buttons; bookmark and trash in ⋯; Undo in toasts and the tray (DESIGN §7.5). The class `dock-pill` is banned |
| 3 | "Hold to talk" under Reply; "Tap to write · hold to talk" (`Reader.tsx:84, 89`) | `ui-reader` | Tooltip only: "Hold R to dictate a reply" |
| 4 | Top-right Ask pill with magnifier, "A", "Hold to talk"; Calendar pill (`Topbar.tsx:22-23`, `ask.css:10-28`) | `ui-shell` | Pane header with at most three icon tools, then an Ask icon button (speech-bubble glyph) and the calendar button, whose tooltip reads "Today, ⇧A" (DESIGN §7.1); hints live in tooltips |
| 5 | "Hold Space to talk" in compose (`Compose.tsx:417`; `focus.css:295` comment; `Overlays.tsx:15` row) | `ui-reader` | Hint only in the tooltip and the `?` sheet |
| 6 | "Todo / Todos" (`App.tsx:25, 40, 534`, `Reader.tsx:68-69`, `MailList.tsx:360`, `Overlays.tsx:26`) | every lane, `ui-home` leads | "Later" everywhere, including `aria-label` and `title`; "Todo" is a banned string |
| 7 | "Hide all" (`App.tsx:510`) | `ui-home` | "Clear from Home" as a quiet dim text button |
| 8 | Two reply sections "Waiting on you" and "No reply yet" (`App.tsx:510`, `shared/mailbox.ts:15`) | `ui-home` | Do now (with Back from Later), Important updates and Follow up (DESIGN §7.2); Done leaves Home for mail needing a reply (decision 6) |
| 9 | "Home 1 of 8" heading and the next-card sliver (`Reader.tsx:137-138`, `styles.css:331-332`, `.deck.has-next::before`) | `ui-shell`, `ui-reader` | The position sits in the pane header's crumb ("Home 1 of 9"); no deck |
| 10 | "Important ▾" dropdown and ⋯ in the card header (`Reader.tsx:149-150`) | `ui-reader` | No "Important" control; ⋯ holds bookmark, trash, forward and why it's here |
| 11 | Card toss with `rotateY(±14deg) rotate(±4deg)` (`styles.css:343-360`, `:333-336`) | `ui-shell`, `ui-home` | No toss; `flight` with a 2 degree tilt is unchanged by the revision |
| 12 | Low-importance count badge plus comma-joined senders (`.low-line`, `focus.css:226-243`) | `ui-home` | `LowBand` and the by-sender sheet |
| 13 | Warm-grey canvas, white cards, system blue and green (`tokens.css:93-94, 108-112, 161-179`) | `ui-foundation` | The new tokens: gray shell, white pane, ink blue, hill green (DESIGN §4.1), checked by the Lab b* and ΔE00 identity checks |
| 14 | Pill buttons with inline keycaps on every control (`MailList.tsx` card actions) | `ui-foundation` | 8 px rectangles. A keycap never appears on hover (tooltip, ⌘ held, or the "Show all key hints" setting); primary actions keep their key (DESIGN decision 8, §5 rule 17) |
| 15 | "Armed" bar scaling to 1.06 (`styles.css:379-382`) | `ui-foundation`, `ui-shell` | No scale; the matching button takes the action colour |
| 16 | "Ask me anything" with "Hold A to talk" hint (`Ask.tsx:255-261`, `App.tsx:549`, `Overlays.tsx:10`) | `ui-ask` | "Ask about your mail or calendar"; hint in the tooltip |
| 17 | Welcome copy "Hold it to talk" (`Welcome.tsx:55, 122`) | `ui-onboard` | Welcome is one line, one sentence and one button (DESIGN §7.11) |

**The ten known defects** of `RC/ui/aplos-baseline.md` §6.9 become regression tests in the screens that replace the old ones. Each is checked against the original reproduction, not only the new test.

| # | Defect | Lane | Test in the new screen |
|---|---|---|---|
| 1 | Undo-send needs an 8 s option | `ui-settings`, `ui-reader` | Node test on the options 0, 5, 8, 10, 20 and 30 s |
| 2 | More than one notice per send | `ui-reader`, `ui-shell` | Playwright: exactly one tray per send |
| 3 | "Save this draft?" appears after "Saved" | `ui-reader` | Playwright |
| 4 | Done must leave Home for mail that still needs a reply, with "Remind me if no reply · R" (decision 6) | `ui-home` (spec from `eng-views`) | Behaviour test on both engines |
| 5 | The shortcut sheet lacks ⌃5, ⌃7, ⌃8, ⌘K and ⌘/ | `ui-foundation` | The sheet is generated from the registry; the consistency test of §4.2 |
| 6 | Overlapping events need an ellipsis and a 44 px minimum column | `ui-calendar` | Node test on the layout helper |
| 7 | Day titles lack the comma | `ui-calendar` | `dateLabel` test |
| 8 | "Delete event" shows on unsaved events | `ui-calendar` | Playwright |
| 9 | `--font-mono` is undefined | `ui-foundation` | Token test |
| 10 | With no AI provider the reader shows an error instead of the subject | `ui-reader` | Playwright on the `ai-off` scenario |

**Acceptance (evidence).**

1. The ban test and a DOM text scan over every harness state find none of the §10 phrases or Avec class names in the new tree (output path in `PROGRESS.md`). U9 checks off the 17 rows with screenshots.
2. Each of the ten defects has its regression test in the owning lane.
3. `DECISIONS.md` no longer instructs parity with a reference app, and `AGENTS.md` carries the rule (checked when F9 merges).
4. `npm test`, `npm run typecheck` and `npm run check` pass.

### U1. Foundations: tokens, lint, skill, registry, harness (`ui-foundation`, F9 on days 1-3 then days 4-9; 7-10 working days)

**Goal.** Make drift impossible before any screen is rebuilt: one token source, rules that fail on violation, a rulebook agents must load, one command table, and a headless camera.

**Deliverables.**

- `renderer/ui/tokens.json` (W3C format) and `scripts/design/build-tokens.mjs` emitting `tokens.css` (light, dark, Increase Contrast), `motion.ts` and `contrast-pairs.json` (DESIGN §4 and §12.1); CI regenerates and fails on any diff. There is no `legacy.css`, because the old screens are not migrated. The website reads the same `tokens.json`.
- The lint rules of DESIGN §12.2 as ESLint and stylelint plugins in `tools/lint/design/`, the extension point that Phase 0 restructure step 4 creates (not `apps/desktop/lint/`), each with a failing and a passing fixture. The new tree starts at zero violations and `renderer/legacy/` is excluded until it is deleted, so no ratchet file is needed. The ban list includes `repeating-linear-gradient` and `linear-gradient` in app CSS, `backdrop-filter`, and the class names `post-edge`, `airmail` and `skyscene` (DESIGN §12.2).
- `scripts/check-contrast.mjs`: every declared pair in three modes (translucent tokens composited over their background; WCAG 2.x pass or fail, APCA advisory), the ΔE00 identity check against `tools/lint/identity-references.json` (Avec's four colours and the audit list, `RC/gaps/identity-collision-audit.md` §4) and the canvas Lab b* check. Colour maths with `culori`.
- The `aplos-design` skill (`.claude/skills/aplos-design/SKILL.md`), an AGENTS.md rule to load it before touching `apps/desktop/src/renderer` or `apps/web`, and a CI check that its token names match `tokens.json` (DESIGN §12.3).
- Bundled fonts: Newsreader variable roman woff2 (OFL, licence included, preloaded, `size-adjust` fallback) and a bundled open sans used **only in test mode**, so baselines do not drift with macOS (§6.2).
- `CommandRegistry`, the pure resolver (§4.2) and the generated shortcut sheet.
- The harness (`tests/visual/`): the first 20 states, frozen clock (2026-10-29T10:00), per-run `APLOS_DATA_DIR` seeded with original demo data, own ports, no AI keys unless a scenario injects a mock provider (DESIGN §12.5); A/B baselines plus a small golden set (§6.2); onboarding seeded explicitly (F14); and the **hover-never-shifts check** (DESIGN §5 rule 17, §12.5), which hovers up to 90 interactive elements per state and fails if any other box moves by more than 0.5 px.
- A one-day **timing-validity spike**: does a hidden (`show:false`, `backgroundThrottling:false`) Electron window give trustworthy `requestAnimationFrame` and long-animation-frame data, and does `page.screenshot` return real pixels from it (the onboarding window checks depend on it)? The answer decides where `test:perf` runs (§6.4) and is recorded in `DECISIONS.md`.
- **The checks of the old U0** (see the U0 section): the banned-string and banned-class test, the identity check, the AGENTS.md rule and the retirement of the "match the reference" decisions.

**Ownership.** Owns `renderer/ui/tokens.*`, `scripts/design/`, the design plugins and fixtures under `tools/lint/design/` (`plat-ci` owns the rest of that folder), `tests/visual/`, `tests/perf/`, `renderer/commands/`, `.claude/skills/aplos-design/`, fonts. **`plat-ci` owns root devDependencies and the one pinned Playwright base (`tests/e2e/playwright.config.ts`)**: U1 asks for stylelint plugins, axe-core and culori by a small PR to `plat-ci`, and `tests/visual` extends that base. `plat-ci` reserves CI slots named `check:tokens`, `check:contrast`, `check:identity`, `test:visual` and `test:perf`; U1 delivers a script under exactly those five names (plus `lint`).

**Depends on.** Phase 0 restructure steps 2 and 4 (the format and lint commits) so `tools/lint/` exists, and F8's pinned Playwright base. CI runs on Linux for pushes to `revamp` and macOS jobs run on demand (roadmap §6), so the harness runs locally and its CI job may show as pending. The design rules live in separate files so they stay additive. No engine dependency.

**Acceptance (evidence).**

1. **Tokens reproduce the spec:** the script prints DESIGN §4.1's numbers within 0.02 (`--dim` at least 5.0:1 on every light surface and 5.1:1 in dark, and the accent-ink pair as DESIGN states it). An independent recomputation with the audit's `de2000.py` (`/Users/knewton/.t3/aplos-research/tools/identity-audit/`) agrees on every ΔE within 0.05.
2. **Springs reproduce the spec:** `motion.ts` generates the `linear()` strings of the springs that DESIGN §4.8 keeps after the revision, within 0.002 per sample, with the settle times DESIGN states (270, 250, 240, 210 and 310 ms before the revision).
3. **Lint rejects:** each rule fails its bad fixture and passes its good one: raw hex, `rgb()`, literal `ms`, `cubic-bezier(`, `transition: all`, `width` in a keyframe, a literal radius, CSS `will-change`, a banned icon (including any sparkle, wand or star), a banned JSX string, a non-allowed `Button variant`, a gradient, `backdrop-filter` and a banned class name.
4. **Generated files are protected:** touching `tokens.css` fails CI.
5. **Registry consistency:** a test fails on a duplicate binding in one context, a command missing from the palette, or a sheet key with no handler.
6. **Harness determinism:** two runs over 20 states in both themes differ by zero pixels; a deliberately changed token fails exactly the affected states, with overlays; and hovering any interactive element in any state moves no other box by more than 0.5 px.
7. **The timing spike is recorded with data.**

**Work packages.**

- *WP1.1 Tokens, generator, contrast, identity CI* (Opus). **Verify:** an agent recomputes every ratio and ΔE with a different library and `de2000.py`, and tries to add a token without declaring its pairs.
- *WP1.2 Motion tokens and spring solver* (Opus). **Verify:** fuzz retargeting at random times and velocities; value and velocity stay continuous.
- *WP1.3 Lint plugins* (Sonnet; fan out stylelint, ESLint, ratchet). **Verify (adversarial):** a "rule breaker" agent writes violations meant to evade each rule: hex in a template literal, `color-mix` with a literal, `style={{transition:'all 120ms'}}`, `padding: 0 7px` through a shorthand, a duration in an inline custom property, `setTimeout`-driven motion. The WP closes when no evasion a reviewer would call a violation remains.
- *WP1.4 Registry and resolver* (Opus). **Verify:** property test over random key sequences, contexts, IME composition and text-field focus against an oracle table.
- *WP1.5 Harness, A/B tool, fonts, timing spike* (Sonnet; Opus reviews the spike).
- *WP1.6 Skill* (Opus, last). **Verify:** a fresh agent given only the skill and "add a toast with Undo" produces lint-clean code with no questions.
- *WP1.7 The old U0's checks* (Sonnet). **Verify:** a reviewer plants each banned string, class name and Avec hex value in a new component and confirms the test fails.

### U2. Data layer and typed client (`ui-shell`, days 4-8; 4-6 working days)

**Goal.** The new renderer talks to the engine only through the typed client and the final-shaped data layer (§4.1), running on the stand-in engine, with `AppState` absent from the new tree.

**Deliverables.** The `renderer/data/` modules of §4.1, with their hook signatures frozen in F9 on day 3. `bridge.ts` reduced to transport selection. The binary path for audio and attachments (a transferable `ArrayBuffer` or blob route, never base64) that `ui-reader` and `ui-ask` build voice on. An ESLint rule that forbids importing `AppState`, `shared/live`, `engine/*` and anything under `renderer/legacy/` from the new tree. The new renderer booting on the stand-in engine in the browser preview and in Electron dev. A UI scenario control for the harness (`Fixture/control`, §8). There is no codemod: today's 53 `invoke(` sites stay in `renderer/legacy/`, and the new renderer never calls `invoke`.

**Ownership.** `ui-shell` owns `renderer/data/` and `renderer/bridge.ts`. It touches contract types only through `eng-contract`.

**Depends on.** F1, F2 and F6 (day 3): the contract with its typed client and generated allowlists, and the stand-in engine serving windows. If F6 slips, `ui-shell` codes against the F9 signatures with a local stub.

**Acceptance (evidence).**

1. `grep -rn "invoke(" apps/desktop/src/renderer --exclude-dir=legacy` returns only `data/`. `npm run typecheck` passes with no `any` on engine results.
2. The existing 36 node test files still pass; the harness's 20 states are unchanged except for intended diffs.
3. The overlay property test of §4.1 passes over at least 10,000 random sequences, including receipt before frame, reset mid-overlay and undo of an undone operation.
4. Window cache test: a frame with unknown ids triggers exactly one `Thread/get` for the unknown ids; a `reset` reopens windows; window order equals the stand-in engine's order.
5. The new renderer starts, lists mail, triages and composes against the stand-in engine in both transports (a `MessagePort` in Electron, the tokenised HTTP and SSE binding in the browser preview). The real engine is not required.

**Work packages.**

- *WP2.1 Data-layer core* (Opus). **Verify:** a skeptic agent writes the race scenarios as failing tests first, then tries to find a sequence the property test misses.
- *WP2.2 Pop-out windows and browser-preview transport* (Sonnet). The codemod verification that earlier drafts listed here is dropped.

### U3. Identity: palette, serif, components (`ui-foundation`, days 4-9; 8-12 working days)

**Goal.** The app looks like Paper ("quiet paper") and passes the seven not-Avec checks (DESIGN §2.3) on Home and the reader in both themes. The mockups in `mockups/` are the visual target.

**Deliverables.**

- **The serif.** The owner decided on 2026-10-27 that AI-written text (summaries and Ask answers) is set in Newsreader. A one-page look sheet (Newsreader 21/31 against SF 21/500 on 12 realistic summaries in both themes) joins the day-9 review packet to confirm size and weight. If the owner prefers SF, `summary` and `answer` switch by one token.
- **The live palette and scale** from DESIGN §4: the gray `--shell`, the white `--canvas` pane, `--paper` cards, raised and sunken fills, hueless ink, the ink-blue `--accent` for the one main action, and `--hill`, `--dusk` and `--stamp`. The revised type roles: `heading` (24/32) is used only for the compose subject, the search field and onboarding step titles (DESIGN §4.3), `display` is sans, and nothing is under 11 px. Spacing, radius (`lg` 12, `xl` 16), elevation (`--elev-pane`, `--elev-card`, an opaque `--elev-float` and no glass), the density setting, "Show all key hints" and Increase Contrast. There is no sky, horizon, post-red or post-blue token.
- **Components** from DESIGN §6. Each has its frozen props from F9 and a plain first implementation by day 3, which U3 refines behind the same props: `Pane`, `PageHead` (the row for page-level controls), `ReaderHead`, `EarlierMessages`, `ReplyStub`, `MiniMonth`, `CalendarList`, `NavHead`, `Button` with three variants, `Kbd` (never revealed on hover), `Tooltip`, `Menu`, `Popover`, `Dialog`, `Chip` (raised fill), `FocusLetter`, `Summary`, `Why`, static `CommitChip`, `ListRow`, static `FocusSlot`, `SectionHeader`, `LowBand`, `EmptyLine`, `ErrorLine`, controls, `Spinner`, and `UndoTray` with the neutral drain. There is no `PostEdge`, `SkyScene`, `MarginRail`, `Flap`, `Letterhead` or reader `Avatar`. Screen-specific components arrive with their lanes.
- **DESIGN §13 items 9-15.** The new tree never contains them, and the banned-string and class-name checks of the U0 section keep it that way.
- **The menu-bar glyph** that `eng-host` needs: a plain monochrome template image (18 px at 1x and 2x), with no sparkle, wand or star. A plain-letter placeholder stands in until then.
- **Website.** Not in this plan. The `web` lane owns `apps/web` and `apps/desktop/build/dmg-background.html` (roadmap §2.5). DESIGN decision 14 defers the site redesign until the new logo, while the roadmap has the lane remove the airmail stripe now. The Integrator resolves that conflict (see Decisions).

**Ownership.** `ui-foundation` owns `renderer/ui/**` and the component families.

**Depends on.** U1 and F9 (day 3). The reader's HTML stays on the `srcdoc` path against the stand-in engine until `eng-html` lands.

**Acceptance (evidence).**

1. The harness runs DESIGN §2.3's seven checks on Home and the reader in both themes: Lab b* below 0 for the shell and the night shell; accent and Done at least ΔE00 10 from Avec; serif in the summary line; no primary button radius above 8 px; no floating bottom cluster or full-card flood, and no decorative pattern (airmail motif, gradients, illustrated scenes) anywhere; none of the §10 phrases; a single 640 px reading column.
2. Contrast CI is green for every declared pair in light, dark and Increase Contrast.
3. The lint reports zero hex, `rgb()`, `hsl()`, literal `border-radius` and literal `font-size` outside the token files, across the new renderer tree.
4. No element in the harness DOM has a computed font size under 11 px or a rainbow avatar.
5. Hover never shifts layout on any component state in the harness.
6. The review packet: Home, reader, compose, a menu and a dialog in both themes, each next to its mockup, plus the serif sheet.

**Work packages.**

- *WP3.1 Serif look sheet* (Sonnet builds the sheet; the owner decides at the day-9 review). *WP3.2 Palette, type, elevation tokens* (Opus). *WP3.3 Components* (one agent per family: buttons and keys; surfaces and overlays; list parts; reader parts; controls; Opus for `Pane`, `ReaderHead` and `FocusSlot`, Sonnet for the rest), each shipping harness states and an a11y assertion. *WP3.4 Banned-string and class-name checks on the new tree* (Sonnet).
- **Verify adversarially:** (a) a reviewer who has not read DESIGN.md sees the Home and reader screenshots next to Avec's reference stills and names every element that looks borrowed; each is a defect. (b) The `break-ui` method on every component: 300-character subjects, unbreakable emails, one-letter names, counts of 0 and 9,999, CJK, RTL, emoji. (c) A hover agent hovers every interactive element in every state and reports any box that moves.

### U4. Motion signature (`ui-shell`, days 5-11; 6-9 working days)

**Goal.** Finishing an email feels like the letter is carried off, input never waits, and the list holds still. The budgets of DESIGN §5 pass.

**Deliverables.** The runtime of §4.3; every named motion of DESIGN §4.8, as WAAPI or generated CSS (including `undo-send`, an 8 s linear drain of a neutral bar that is static under reduced motion); the swipe rewrite on springs that continues from release velocity; the dock fix (paint the final area in dock colour on frame one, slide contents, FLIP the column; fall back to a one-step resize with a content fade if seams show in the packaged app); the theme-switch freeze; a reduced-motion variant of every motion; the key queue; no hand-written `@keyframes` in the new tree (every one that exists is generated from tokens and covered by the reduced-motion lint rule, expected 12 or fewer [I]).

**Ownership.** `ui-shell` owns `renderer/motion/**` (the runtime of §4.3) and the swipe hook. `ui-foundation` owns the generated `ui/motion.ts`. `calendarMotion.ts` moves with `ui-calendar` and is re-tokenised only.

**Depends on.** U2 (overlay for synchronous commit) and U3 (`ListRow`, `FocusSlot`, `Pane`). No engine dependency: it runs on the stand-in engine.

**Acceptance (evidence).** On a 10,000-thread fixture, with the machine idle and its load recorded:

1. Triage key to store state 8 ms or less p95; key to next paint with focus moved 16.7 ms or less p95, 50 ms hard cap (Event Timing API and long-animation-frame observer; DESIGN §5).
2. Ten E presses in 2 s: no dropped key, exactly one `close`, no frame over 33 ms.
3. **Filmstrips** for `commit`+`flight`, `carry`+`hold`+`close`, `deal`, `undo-send`, `dock` and `slide` at 0, 30, 60, 120, 220 and 400 ms, normal and reduced, as the golden set.
4. The animated-properties assertion (§4.3) passes in every filmstrip.
5. A swipe interrupted at 50% retargets from the drawn value and velocity with no jump.
6. Packaged-app numbers recorded in `PROGRESS.md` if the U1 spike validated hidden-window timing; otherwise the packaged check becomes an owner hands-on item.
7. **Owner feel check** (§6.5, day-9 review): triage 20 emails with E and L at normal and rapid speed. Does it feel instant, and does the letter feel carried?

**Work packages.**

- *WP4.1 Ghost, flight, commit, deal, carry; WP4.2 Hold, close, rapid, key queue; WP4.3 Swipe and springs* (Opus). *WP4.4 Dock, puck, count, theme freeze, reduced motion; WP4.5 Budget tests and filmstrip tooling* (Sonnet).
- **Verify adversarially, the button masher:** a fuzz agent drives random J, K, E, L, Z and arrow sequences at random 0-400 ms gaps with window blur and focus, a list update mid-flight and a theme switch, and asserts: the focused row id equals the model's; no stuck or duplicate ghost two seconds after the last key; `document.getAnimations()` is empty after settle; no `will-change` remains; row positions equal layout truth after `close`. A second agent bisects any frame over 33 ms.

### U5. Shell, Home, Later, lists, Done, toasts, states, and the switch to the real engine (`ui-shell` and `ui-home`, days 4-12, switch on days 11-13; 9-11 working days)

**Goal.** The daily-driver triage surfaces in the new look and motion, on `useView`, and then the switch from the stand-in engine to the real one.

**Deliverables.**

- **Shell** (`ui-shell`; DESIGN §7.1). A gray shell holds the sidebar and one or two white panes. The sidebar is regrouped. At the top are the account switcher (defaulting to **All accounts**) and the compose pencil. The first group has no header and holds Search, Home, Later and Calendar. A quiet "Mail" label sits over All mail, Done, Drafts, Sent, Spam and Trash. The footer holds the status slot, Settings and Help. Counts hide during first sync. The pane header holds back or close with a crumb (for example "Home 1 of 9"), at most three icon tools, then Ask and the calendar button (tooltip "Today, ⇧A", which opens the Today tab). Pages carry no big title (DESIGN §7); the section labels do that job. Also in the shell: the `slide` puck and `count`, the minimised ☰ mode, and `StatusSlot` with the full status vocabulary:

| Status (ARCH §6.4) | Copy (proposed) | Action |
|---|---|---|
| `starting`, `syncing` | "Starting…", "Syncing…" only after 150 ms | none |
| `ok` | nothing; "Synced 2 min ago" on hover | none |
| `ok` with `reconnectBy` within 24 hours | "Gmail will ask you to reconnect tomorrow at 9:00 AM." | Reconnect now |
| `backfilling (n of m)` | "Importing 214 of 500" | none |
| `paused` (throttle) | "Google asked us to slow down. Resuming at 2:14 PM." | Retry now |
| `paused` (daily limit) | "Google's daily limit is reached. Resuming tomorrow." | none |
| `needsReauth` | "Google needs you to sign in again." | Reconnect |
| `needsPermission` | "Aplos needs permission to read your Gmail." | Reconnect |
| `needsAdmin` | "Your organisation has blocked Aplos. Ask your administrator." | none |
| `misconfigured` | "Google sign-in isn't set up in this build." | Copy diagnostics |
| `offline` | "Offline · 2 changes waiting" | none |
| `error` | "Sync hit a problem." | View details |

  Both Reconnect actions open the reconnect sheet that `ui-onboard` builds (U8).

- **Home** (`ui-home`; DESIGN §7.2). Sections in order: Do now (with Back from Later at its bottom under a quiet sub-label that carries "Clear from Home"), Important updates, the Low importance band, then Follow up last. Empty sections don't render, and Tab and Shift-Tab jump between Do now, Important updates and Follow up. Do now orders by due band, importance, due date, then newest, with quiet due chips ("from the email" on hover for a date the AI found). A fixed 180 px `FocusSlot` (roomy 196, compact 164) with `deal`. Its actions are the filled suggestion with Space, Later and Done as text buttons, and one ⋯ for bookmark, trash and why it's here. ⌥↓ and ⌥↑ move a thread down or up a lane, offer "Always do this for [sender]" and toast with Undo. Space on a Follow up row opens the inline reply with the AI-drafted nudge as an editable suggestion, or an empty reply with AI off. Section labels are `ui` 600 with the count in dim, and a label stays, showing 0, until `hold` releases. There is no distance fade; hierarchy comes from read and unread weight. `LowBand` and the Low-importance sheet group mail by sender, with the armed → → mark-all. "2 new" shows under `hold`, next-step toasts follow, and "Go one by one" (S) and "Clear from Home" are quiet dim text buttons. Home-empty is the calm inbox-zero block: "You handled 12 emails." in sans `display`, "Next: Design review at 2:00 PM" in dim, and "Undo last · Z". It is **never shown while an account is backfilling or paused** (§4.5 row 10). The sidebar count is Do now plus Important updates.
- **Later and lists** (`ui-home`; §7.3-7.4). Later has groups, a Later | Bookmarks switch on the right of the first row, `DatePresets`, and drag to reschedule with `lift` and `snap`. Drop targets are named by time, and Overdue is never a target. Lists use one component for All mail, Drafts, Sent, Trash and Spam. Arrows move the cursor only (decision 7). The keyboard cursor is a neutral `--puck` fill plus the 2 px accent bar, and bulk-picked rows use the accent wash. The account colour dot shows only with two or more connected accounts (DESIGN §4.2). Hover actions overlay the date column and never reflow the row.
- **Done** (`ui-home`; DESIGN §7.4). The place for mail you finished. Rows read "Done 9:41 AM", the one hover action is an icon-only "Move to Home" on H, and E and L are inactive there. It needs the `done` view spec and the `in:done` operator.
- **Toasts** (§7.13). A content-column stack, op-queue wording, one operation one notice, Undo toasts never replaced, opaque `--paper` with `--elev-float`, and a restyled update-ready toast. **Errors** (§7.15). Inline `ErrorLine` on rows, and `FatalScreen`, including the parked engine ("Try again", "Export diagnostics"), in sans `display`.
- **The switch (WP5.6, `ui-shell` with the Integrator, days 11-13).** One flag moves `WindowSource` from the stand-in engine to the real one once `eng-views` passes the conformance suite on the real engine (day 11). Deliverable: the harness runs the P0 states against both engines with the same assertions, and the owner opens a local packaged build on real mail on day 15. After the switch the Integrator can delete `renderer/legacy/` (days 14-17).

**Ownership.** `ui-shell` owns `renderer/{data,shell,motion}/**`, `renderer/App.tsx`, `renderer/main.tsx` and `renderer/bridge.ts`. `ui-home` owns `renderer/screens/{home,later,lists,done}/**` (roadmap §2.3).

**Depends on.** U4. The `home`, `later`, `done`, `mailbox` and `home.low` view specs and folder counts (§4.1), served by the stand-in engine until the switch. The `lane`, `importance`, due band and follow-up suggestion come from `eng-ai`'s heuristic Home and `followup` job, and the stand-in emulates them. `prov-gov` supplies status values and `reconnectBy`; until then the stand-in emits each one through `Fixture/control`. **WP5.6 needs `eng-views` conformance green on the real engine.**

**Acceptance (evidence).**

1. About 35 named states from §7.1-7.4, §7.13-7.15, the Done place and the reconnect states in the harness, both themes, two sizes, each with an axe scan that has no serious violation.
2. Behaviour tests: Done on mail needing a reply leaves Home and offers the Remind toast; arrow keys on All mail move the cursor and archive nothing; Home's fixtures render Do now, Important updates, the Low importance band and Follow up in that order, with Do now sorted as DESIGN §7.2 and Back from Later at its bottom; ⌥↓ and ⌥↑ move a thread one lane with Undo; Space on a Follow up row opens the drafted nudge, or an empty reply with AI off; Tab and Shift-Tab jump sections; hover on any row leaves every row's bounding box unchanged; a cached list paints with no skeleton; each status in the table, including the reconnect line, renders from the stand-in engine; the Done place shows "Done 9:41 AM" rows with one Move to Home action, and E and L do nothing there.
3. Fuzz: new mail arriving during a triage burst never moves the row under the cursor (the button-masher agent from U4, extended).
4. Keyboard-only walkthrough of "triage 10 emails, defer one, bulk-trash three, undo" is scripted and passes.
5. **Switch:** the P0 states and the walkthrough pass on both the stand-in and the real engine, and the Integrator posts in `plans/STATUS.md` that the renderer is on the real engine, which unblocks deleting `renderer/legacy/` (days 14-17).

**Work packages.** *WP5.1 Home and Low sheet* (Opus); *WP5.2 Shell, sidebar, status slot; WP5.3 Later, DatePresets, drag; WP5.4 Lists, bulk and the Done place; WP5.5 Toasts, errors, empties* (Sonnet); *WP5.6 Switch to the real engine* (Opus, after `eng-views` conformance is green on the real engine). **Verify:** `break-ui` worst-case data on every list; a fresh-eyes agent runs the keyboard-only walkthrough without reading the code and reports every lost focus.

### U6. Reader, mail frame, compose and outbox UI (`ui-reader`, days 5-13; 8-12 working days)

**Goal.** The reader and composer in the new design, with the real sandboxed frame once the engine provides it, and honest send states.

**Deliverables.**

- **Reader** (DESIGN §7.5). One 640 px column with no paper card. Top to bottom: `ReaderHead` (the sender line with the due chip and time, the big serif summary with "Summary by Groq" on hover, and one action row with the filled suggestion and its Space key, then Later and Done as text buttons), then the thread (a dim line with the subject and message count, `EarlierMessages` collapsed into one line that O expands, the latest message with its header and a 15/26 body, then attachments), then `ReplyStub` ("Reply to Jordan…" with an R keycap). Bookmark, trash, forward and why it's here live in ⋯ and ⌘K. The pane header shows previous and next, ⋯ and Ask. J/K `swap`, ⌘F find, and every §7.5 state.
- **`MailFrame`** (§4.4). The `srcdoc` source against the stand-in engine first, and `aplos-mail` once `eng-html` lands. Image chrome and "N trackers removed", the plain-text path, attachments with a failure state, and prefetch on intent (80 ms focus, 120 ms hover, cancel on move) against the engine's LRU of 12.
- **Compose and inline reply** (DESIGN §7.6). Compose is a 640 px page in the pane: a header with close (Esc), "New message", ⋯ (send from, schedule, discard) and Ask; a To row, then the subject as a 24/32 field, then the text in `read`; and a footer with Send (⌘↩), "Draft saved", attach and format. The inline reply is one card under the message, with the To line (Cc and Pop out on the right), the text, Send (⌘↩), "Draft saved", attach and ⋯. While a composer is open it owns the filled button, and the summary's Reply becomes a text button (DESIGN §4.6). Dictation shows a small `--stamp` level meter and one line, "Listening. Release R to keep, Esc to cancel." The AI draft is dim text with Tab to keep and Esc to dismiss, and Polish is an inline diff. On send the composer closes and the message `arrive`s in its thread. `UndoTray` is a `--raised` line, "Sending to Jordan in 8 s · Undo Z · Send now", with a neutral 2 px bar that drains over 8 s (`undo-send`) and is static under reduced motion. There is one notice per send, plus the submission states and the draft-conflict card of §4.5 rows 4-5. Space on a Home Follow up row opens this inline reply with the drafted nudge as the suggestion (DESIGN §7.2).

**Ownership.** `ui-reader` owns `renderer/screens/{reader,compose}/**` and `renderer/mailframe/**`, including `LevelMeter` and the dictation hook. It touches the reporter protocol document with `eng-html`.

**Depends on.** U4 and U5 (shell and data hooks). `eng-html` (days 4-10) for the real frame, with `srcdoc` against the stand-in until then behind the same props. `eng-time` (days 4-10) for `Submission` states; until then the stand-in emits them. `MessageBody/get` from `eng-store` and `eng-views`.

**Acceptance (evidence).**

1. Every §7.5-7.6 state in the harness, both themes, both sizes. The reader shows its four parts in order (sender line, summary, action row, thread) and no margin column.
2. **No blank sheet:** a fuzz of 500 J/K moves with body latency random in 0-2.5 s never shows an empty paper; after 1.5 s the 12 px loading line appears.
3. **Frame host tests:** spoofed `postMessage` (wrong source, origin or token; `h` of NaN, negative or 1e9) is rejected; height clamps; a `bg` parse failure falls back to light paper.
4. **Hostile-HTML corpus** (the vectors in `RC/gaps/electron-email-html-isolation.md` §1: inline script, `onerror`, meta refresh, `<link>` prefetch, `url()` trackers, forms): zero outbound requests in the Playwright log, and the frame cannot reach `window.aplos`.
5. **Keys with focus inside the frame** work for J/K, E, L, Space, R and `/` in the packaged app (§6.5 check 4). The result and the chosen relay path are recorded before `ui-reader` closes (days 14-16). **[U] today.**
6. Each submission state renders its sentence and actions from the stand-in engine and survives a reload; the kill-resume e2e belongs to `eng-time`.
7. A live check: one real send to an owner-controlled address from the new composer in the packaged app, owner present (days 14-16).

**Work packages.** *WP6.1 `ReaderHead`, `EarlierMessages`, `ReplyStub`, threads; WP6.2 MailFrame and key relay* (Opus, security-sensitive); *WP6.3 Compose family* (Opus composer, Sonnet the rest); *WP6.4 UndoTray and send states* (Sonnet); *WP6.5 Prefetch and double buffer* (Opus). **Verify adversarially:** a "hostile sender" agent writes new email-HTML attacks (CSS `@import`, SVG `<use>`, `<base>`, `<meta http-equiv>`, `javascript:` links, giant tables, deeply nested divs) and runs them through sanitiser and host; a spoofing agent forges the reporter message from another frame; a fuzzer interleaves send, undo and fixture-engine restart and asserts no duplicate tray and no lost draft.

### U7. Palette, search, Ask, Today, Settings, Calendar (`ui-ask`, `ui-settings`, `ui-calendar`, days 6-13; 8-12 working days)

**Goal.** The remaining screens, every command reachable by name, and the gap surfaces of §4.5.

**Deliverables.**

- **Palette and search** (`ui-ask`; §7.9). ⌘K is the only overlay: opaque, centred, with a light scrim. On first open it shows Suggested and Go to, and everything else appears as you type, with the truthful context line, groups, breadcrumbs, the scoring order of §7.9 and two-row destructive confirms that default to Cancel. 1-9 picks work only while the field is empty. Search (`/`) is a page, not an overlay: a sidebar item, the field at heading size, operator tokens beneath it (including `in:done`), local results as you type as ordinary rows, and "Search all mail on Google · Return" under them. Remote runs only on Return.
- **Ask and Today** (`ui-ask`; §7.7). The dock is a second pane, 360 px wide and 8 px from the main pane, with an Ask | Today segmented control and a close button, and no glyph in the header. It is closed on first run. Questions are `base` 500, answers are serif with citations, and there is a step log, queued follow-ups, a `ProposalCard` that owns the filled button, no-provider and provider-error states, hold A to dictate, and the Today agenda. The calendar button in the pane header opens the Today tab.
- **Settings** (`ui-settings`; §7.10). Eight sections, a 180 px nav and a 600 px column, groups 32 px apart, rows 40 px (48 px with a one-line description) with hairline separators and a fixed control column. The AI page leads with the Features table (Ask, Summaries, Drafts, Plans, Voice, with speech-to-text providers for Voice), then providers split into hosted and "On this Mac and custom" (status dot, key source, never key characters, Test, Remove, editable local addresses). Keys that come from the environment show Remove as disabled with the reason in a tooltip, and unset providers show "Add key". The privacy text sits behind "How your mail is used". Keyboard has remapping, conflicts, the single-key switch and "Show all key hints". Accounts have one name and **Reconnect on the row**, driven by `reconnectBy` and `needsReauth`, which opens `ui-onboard`'s reconnect sheet. Mail has undo-send 0, 5, 8, 10, 20 and 30 s, and the gap rows of §4.5 rows 2-3. Every setting is searchable from ⌘K.
- **Calendar** (`ui-calendar`; §7.8). The four baseline fixes, the revised visuals (today's column on `--today-tint` with a filled accent date badge, events under 30 minutes on one line, three or more overlapping events as the first lane plus a "+N" stack, and RSVP starting with nothing chosen), and the narrow agenda. The existing FLIP, period slide and pinch zoom are kept, and `slide` for D, W and M must not move width. Its date ("October 2026") is a small `title` label, not a page heading (DESIGN §7.8). `ui-shell` places `MiniMonth` and `CalendarList` in the sidebar on the Calendar route, and this lane supplies their data. `ShortcutSheet` is generated from the registry.

**Ownership.** `ui-ask` owns `renderer/screens/{ask,today,palette,search}/**`, `ui-settings` owns `renderer/screens/settings/**`, and `ui-calendar` owns `renderer/screens/calendar/**`.

**Depends on.** U5 (shell and hooks). `eng-ai`: `Ask/run` progress frames carrying citations, the settings fields in §8, and the AI provider table with `trainsOnInputs`. `eng-host`: diagnostics and listener methods (the pages show "Not available yet" behind a capability flag until then). `prov-cal`: calendar edit-scope fields (this event or all events) and RSVP, frozen in F1. `prov-gov`: `reconnectBy` for the account row.

**Acceptance (evidence).**

1. **Palette reach:** every registry command is reachable in the palette; the context line is truthful across 30 contexts (property test); Esc never navigates.
2. **Settings reach:** every `SettingRow` registers a palette entry.
3. **Secrets:** no element text, attribute, screenshot or log in any harness state contains a canary key value or any `*_API_KEY` value; a scanner agent seeds the canary.
4. **Ask invariants over 20 fixture answers:** a citation or "No source in your mail"; input never disabled while streaming; queued follow-ups as editable cards.
5. **Live provider:** one real Groq Ask round trip in Electron dev, key read from the backend environment only and never printed (AGENTS.md; `npm run eval:ask` exists). A mocked provider does not count.
6. **Calendar:** three or more overlapping events show the first lane plus a "+N" stack at 44 px or wider (DESIGN §7.8); comma in day titles; no Delete on an unsaved event; RSVP starts with nothing chosen and "Send reply" stays disabled until you choose.
7. **Search:** typing never calls the remote path; Return calls it exactly once.
8. **Reconnect row:** with the `needs-reauth` scenario and with `reconnectBy` inside 24 hours, the Settings account row shows Reconnect and opens `ui-onboard`'s sheet.

**Work packages.** *WP7.1 Palette and search; WP7.2 Ask dock and Today* (Opus); *WP7.3 Settings: AI and Keyboard; WP7.4 Settings: the rest* (Sonnet); *WP7.5 Calendar* (Opus for layout and motion, Sonnet for the rest). **Verify:** palette scoring fuzzed against an oracle written by a second agent; the secret scanner; `break-ui` on Settings with a 40-character provider name and a 200-character address.

### U8. Onboarding, first sync, consent, weekly reconnect (`ui-onboard`, days 5-12; 6-9 working days)

**Goal.** An onboarding window that cannot get stuck, a first-sync screen that tells the truth under Gmail's quota, the owner's three onboarding wishes, all 14 PR #21 findings closed by tests, and the weekly reconnect sheet. `ui-onboard` starts first among the screen lanes (day 5).

**The owner's wishes, made testable.** DESIGN §7.11-7.12 now include these wishes and the revised look; where a detail below differs, the wish wins. `ui-onboard` records the result in `DECISIONS.md`.

| Wish | What it means here | Differs from DESIGN? |
|---|---|---|
| **A separate, smaller window** (Arc, Dia, Zen) | Created by main on first run (no accounts, setup not done) or from Settings → Help → "Show welcome". 640 × 600, minimum 640 × 520, vertically resizable, hidden-inset title bar. **Full-bleed white paper:** no sheet, no sky, no hills and no icon (DESIGN §7.11). A 48 px top strip holds the traffic lights and "Try demo mail". Steps sit top-anchored in a 64 px side margin, and Welcome alone is centred, as one line, one sentence and one button. Nothing else opens; the mail window does not exist until handoff. Launch at login with no accounts stays windowless until the owner clicks the Dock or menu-bar item. | No: DESIGN §7.11 now specifies it |
| **Demo is a small top-right button and loads only when clicked** | A text button "Try demo mail" in the top-right corner of the 48 px strip (a no-drag region, 24 px or larger hit area). **A fresh install starts with zero accounts and zero mail**; clicking calls the contract's `Demo/load` (§8.1 item 11); nothing demo is seeded, loaded or wiped before that. Demo skips the first-sync screen. | No: DESIGN §7.11 now matches (it was a second Welcome button) |
| **After onboarding, a loading screen that syncs and runs the AI pass before the inbox** | §7.12's screen as refined below: it gates only on the newest mail and a time-capped AI pass, never on the whole mailbox, and the owner can enter early. | Refines §7.12 |

**What "ready" means (consistent with Gmail's quota).** Gmail allows about 6,000 units a minute per user; the first sync is metadata-first and paced (ARCH §5.1: newest threads first as `format=metadata`, committed per 50, backfill in the background; `baseline_done_at` is set when that first window completes, plan 20 PV3).

1. **Connect.** The account is saved.
2. **Find recent mail.** The first window only (about 50 newest threads). A count appears as "about N" only when the provider gives an estimate; otherwise a quiet indeterminate bar. The screen never states or implies the mailbox total.
3. **Read your newest mail, n of N.** N is the first window, not the mailbox. When it completes the account is **ready**; Home is already ordered by the heuristic buckets (ARCH §8.2), so ready never waits for AI.
4. **Sort what matters.** The AI summary pass for the visible Home candidates only (at most 40, at most 60 seconds, as PR #21 did; the engine owns the cap). It needs stored consent and a provider, and is omitted otherwise. **Only this step may time out**, and it says so: "Sorted 12 of 40. The rest continue in the background."

Rules that keep it honest:

- **Backfill is never in the gate.** Older mail (90 days, hundreds of threads, minutes at Gmail's pace) continues after Home opens; the status slot takes over with "Importing 214 of 500" (§5, U5).
- **Enter early, always.** Esc always opens Aplos from this screen, and the screen says so ("Esc opens Aplos"). "Open Aplos" (Return) is enabled once the account is ready, and a quiet text button "Continue anyway" (F8) is enabled from the moment of Connect. Entering before any mail has arrived opens Home with the `EmptyLine` "Your first mail is on its way." and the status reason (§4.5 row 10), never the inbox-zero block.
- **Rate limits are shown, not hidden.** On `paused` with `resumeAt` the screen says "Google asked us to slow down. Resuming at 2:14 PM. Your newest mail will appear first." The paused segment shows a static mark, not a spinner. A raw Google error is never shown.
- **Numbers never move backwards, never claim completion early.** No segment shows 100% or "Done" until it is, and "Done" never appears for a capped, failed or paused step (F10).
- **Auto-enter only on a clean finish** (Decision 11): steps 3 and 4 done, capped or omitted, no error and no pause. The checklist ends in a drawn check and "Your mail is ready", then handoff on `ready-to-show` (F4). Any problem waits for the owner.
- **Several accounts:** a row per account; the window can open as soon as one account is ready, and the others keep going. "Add account" from Settings uses the same component inline and never gates anything.
- Copy corrections to DESIGN §7.12's sample: "Found about 214 recent emails" only with an estimate, and "Reading your newest mail · 24 of 50" instead of "120 of 214".

**Deliverables.**

- **Absorb PR #21's screens, not its engine half.** Branch `rv/ui-onboard/pr21-absorb` takes files from the PR head (`2d88846` when reviewed; re-pin at the lane's start on day 5) **by path**, never by merging the head, because the PR touches 46 files including `engine/service.ts` (+90 lines), `engine/demo.ts`, `engine/ports.ts`, `engine/provider.ts`, `main/google.ts`, `main/engine-host.ts`, `main/service.ts`, `main/server.ts`, `main/preload.ts`, `shared/types.ts` and a dozen test edits. All of them collide with the new `packages/engine` and `packages/contract` that the `eng-*` lanes and `prov-gov` own.
  - **Taken:** `components/Welcome.tsx` and `components/AddAccount.tsx` into `renderer/onboarding/` (restyled on the Paper tokens, with the one-line Welcome); `renderer/main.tsx`'s `?onboarding=1` browser-preview route (a REQUEST to `ui-shell`, which owns `main.tsx`); the onboarding rules in `styles.css` (rewritten on tokens, not copied); and the window-creation part of `main/electron.ts`, rebuilt as `main/windows/onboarding.ts`, which this lane owns (hooks in `main/windows.ts` by REQUEST to `eng-host`).
  - **Handed over:** `tests/onboarding.test.ts` (193 lines) to `eng-ai` as the starting scenario list for `Setup/*`; `scripts/dev-emulated.ts` flags (`--fail-sync`, `--fake-ai`) to `prov-emu`; `apps/web/scripts/capture-screenshots.mjs` (F14) to the `web` lane.
  - The PR itself is never merged; the owner may close it as superseded (Decision 4).
- **Window and steps** (DESIGN §7.11 as revised, table above). Welcome (one line, one sentence, the filled "Add an account" and the top-right "Try demo mail"), Accounts, AI (with the consent card, §4.5 row 1) and Voice. More than about six controls on a step go behind "More options". The footer holds step dashes, "Setup continues in the background." and the buttons. Return continues and Esc goes back.
- **First-sync screen** (§7.12 as refined above). `ProgressSegments` are neutral (done `--ink-2`, paused `--dusk`, failed `--stamp`), and when a step shows "n of 50" the motion sits on the checklist marker, not the bar. There is a row per account. The optional 30-second "Try the keys" drill is a mode of this same screen, so progress stays visible. One `role="status"` announces phases only, and bars are labelled. Failure reasons show the icon in `--stamp-ink` and the sentence in ink.
- **Zero-accounts empty state, demo controls and "Show welcome"** (§4.5 rows 8 and 9).
- **Weekly reconnect** (roadmap N3). Gmail asks for a reconnect every 7 days because the Google project stays in Testing mode. Three surfaces share one flow: the status-slot line a day ahead (`ui-shell`, U5), this lane's **reconnect sheet**, and the Settings account row (`ui-settings`, U7). The sheet opens Google's sign-in for the same account with `login_hint` in one click, shows plain progress ("Waiting for Google…", "Reconnected. Your mail is up to date."), and returns the owner to where they were. It does not resync and keeps queued local changes. Its copy never mentions Testing mode, verification or cost. Besides `needs-reauth`, the stand-in engine needs a scenario with `reconnectBy` inside 24 hours; `ui-onboard` asks for it in the Phase 0 gap list.
- **Also:** onboarding seeded or driven by the harness (F14).

**The 14 findings.** DESIGN Appendix C maps F1-F14 to rules. Division of labour:

| Findings | Fixed in | Test lives in |
|---|---|---|
| F1, F2, F5, F6 (`deferAI`, no backfill, fixed request ids, replies not re-summarised) | `eng-ai`: `Setup/end`, one-shot deferral, per-run ids, backfill with reply refresh (plan 10 E5; ARCH §8.3) | `eng-ai` engine tests; `ui-onboard` adds the UI end-to-end that every close calls `Setup/end`, including the reopen path from "Show welcome" that F1's reproduction needs |
| F3, F4 (two windows; blank flash) | `main/windows/onboarding.ts` (this lane), with `eng-host`'s `windows.ts` and `lifecycle.ts` and F8's hidden windows under test | `_electron` hidden-window test |
| F7 (filtered to the last account) | `eng-ai` stops selecting the account on setup connects; the UI opens on All accounts | Harness |
| F8, F9, F11, F12, F13, F14 | Renderer (this lane) | Harness |
| F10 (honest outcomes) | `eng-ai` reports partial and failed counts; UI wording | Harness with stand-in states |

**Ownership.** `ui-onboard` owns `renderer/onboarding/**` and `main/windows/onboarding.ts`. It touches `main/windows.ts` through `eng-host`.

**Depends on.** F9 components (and `Pane` and `Button` from `ui-foundation`). `eng-ai`'s `Setup/*` (consent, one-shot deferral, **fresh install starts empty, `Demo/load`**) for Phase 2; until then the stand-in engine's `Setup/*` and `Demo/*` script each scenario. `prov-gov` for real first-window checkpoints, `resumeAt` and `reconnectBy`. PR #21 itself, as a source of files.

**Acceptance (evidence).**

1. Each of F1-F14 has a test named for its finding, built from the original reproduction in `research/pr21-onboarding-review.md`; all pass.
2. **Close-at-any-moment matrix:** close the onboarding window at each step, with connect in states idle, pending, connected, syncing and synced; afterwards a later sync of the same account classifies new mail with a mock AI provider and no account is left deferred. This is the property that the review kept finding broken.
3. **Demo isolation:** on a fresh `APLOS_DATA_DIR` the contract log shows no `Demo/load` and zero accounts until "Try demo mail" is clicked; after the click demo accounts exist and the first-sync screen is skipped; Settings can Load, Reset and Remove demo mail; a 0.2.x data folder that already holds demo or real data is never seeded or wiped.
4. **Quota honesty,** with fixture scenarios: (a) first window arrives, then backfill pauses 120 s: the screen reaches ready, "Open Aplos" works, no mailbox total is shown, and the status slot carries the pause after entering; (b) paused before any batch: Esc enters, Home shows "Your first mail is on its way." and never the inbox-zero block; (c) a property test over random frame sequences: no counter decreases, no 100% or "Done" before true, no "Done" for a capped step; (d) the screen never auto-enters while paused, failed or partial.
5. **Window chrome:** a hidden `_electron` test asserts 640 × 600, minimum 640 × 520, vertical resize, hidden-inset title bar, exactly one window at startup including a second launch (F3), and no mail window before `ready-to-show` (F4).
6. All onboarding and loading states in the harness, both themes: six steps, plus partial, failed, rate-limited before and after the first window, multi-account, no-AI, no-consent, complete, zero-accounts, demo, and the reconnect states (due, reconnecting, failed, reconnected).
7. **Live (owner-run, days 14-16):** the owner connects a real Google account (a Testing-mode test user) through the new onboarding and watches honest progress: the first window within about the 15 seconds ARCH M3 promises, then Home opening while older mail keeps importing, and a slow-down message if Google asks for one. Mocked Google is not live acceptance (AGENTS.md).
8. A screen-reader scan shows exactly one live region and labelled bars (F11). The traffic lights over the white strip and the drag region are a hands-on check (§6.5 #9).
9. **Reconnect:** against the stand-in engine's `needs-reauth` and near-expiry scenarios, the sheet reconnects the same account with `login_hint`, shows plain progress, returns to the previous screen, triggers no resync and keeps queued local changes. The first real weekly reconnect inside the daily-use week (§6.5 #10) is the live acceptance.

**Work packages.** *WP8.1 Absorb by path and rebase; WP8.2 Steps, consent card, focus and keys; WP8.5 Window patch and `_electron` tests* (Sonnet; `eng-host` reviews the patch); *WP8.3 First-sync screen and quota scenarios* (Opus); *WP8.4 Reconnect sheet and status-line copy* (Sonnet); *WP8.6 Zero-accounts state, demo controls, Show welcome* (Sonnet). **Verify adversarially:** re-run the five-lens review workflow behind `research/pr21-onboarding-review.md` on the new code; every original finding must fail to reproduce, and any new finding is fixed before U8 closes. A second agent plays "Google throttles me" by scripting `paused`, `resumeAt` and slow batches and tries to make the screen lie (a wrong total, an early "Done", a stuck Esc).

### U9. Cleanup, accessibility, performance, release candidate (Phases 2 and 3, days 14-25; 7-10 working days)

**Goal.** The switch to the real engine already happened in WP5.6 (days 11-13). U9 deletes the legacy renderer, proves the budgets and accessibility on the packaged app, and produces the release candidate (days 17-18) that the daily-use week (days 18-25) and the engine's soak share.

**Deliverables.**

- **Cleanup after the switch** (the Integrator with each owning lane, days 14-17). Delete `renderer/legacy/` (today's renderer, its `refresh()` loader, `bridge.ts`'s web fallback, its use of `shared/live`, and any `legacy.css`). Move the browser preview to the tokenised HTTP binding (`eng-host`, by day 12) with a dev token injected by the harness. The design lint reports zero violations across the whole renderer.
- **Accessibility** (DESIGN §11; `ui-foundation`, days 15-18). Axe over every state in both themes; ten core tasks keyboard-only; ARIA snapshot tests for list, reader, palette and calendar; a live-region log asserting triage announcements ("Done. Next: Maple Library, two holds waiting"); Increase Contrast over 20 states; reduced motion; 200% zoom at the 900 px minimum. Reduce Transparency no longer changes anything (DESIGN §4.6).
- **Performance.** DESIGN §12.6 over the 10k fixture and the engine's 100k fixture (bounded windows, flat renderer heap over a scripted 30 minutes). Cold start recorded and budgets recalibrated once, with the reason written down.
- Docs: `PROGRESS.md`, `TODO.md` and the skill brought up to date, a release-candidate branch and final screenshots. The release candidate is the **same build** the engine's soak runs on (the redesigned release, proposed 0.3.0).

**Ownership.** `ui-foundation` owns the accessibility and performance suites. The Integrator coordinates the deletion with each lane, and `plat-release` owns the packaged build. `apps/web/scripts/capture-screenshots.mjs` belongs to the `web` lane.

**Depends on.** The switch (WP5.6, with `eng-views` conformance green); `eng-host`'s HTTP binding; `plat-ci` and a packaged build; live providers (`prov-*`) for the daily-use week.

**Acceptance (evidence).**

1. `grep` finds no `AppState`, `createLiveState` or `invoke(` outside the typed client, and `renderer/legacy/` no longer exists. Typecheck, lint, unit, harness and axe all pass.
2. The DESIGN §5 budget table passes in the packaged build at 10k threads (or in headless Chromium plus an owner hand check if the spike said so), p95 over 50 runs. A 100k-thread fixture opens Home in under 200 ms to first rows and scrolls with no frame over 16.7 ms p95.
3. Axe: no serious violation in about 90 states by two themes. Ten keyboard-only tasks pass.
4. **Owner-run:** a VoiceOver pass over Home, reader, compose, Ask, calendar and onboarding, and one Japanese or Chinese IME check in compose and search. A scripted CDP IME test (composition events) runs first. A seven-day daily-use week (Phase 3, days 18-25) on the release-candidate build with the owner's accounts, which also holds the first real weekly Gmail reconnect.
5. All 17 items of DESIGN §13 are checked off with screenshot evidence (the U0 table, now complete), and a fresh grep of the Avec-specific strings, class names and constants is clean for plan 40's provenance gate, which runs once `renderer/legacy/` is deleted.

**Work packages.** *WP9.1 Cleanup after the switch* (Opus); *WP9.2 Accessibility suite; WP9.3 Performance suite* (Sonnet, Opus reviews); *WP9.4 Cleanup and docs* (Haiku, Sonnet). **Verify adversarially:** a **fresh-eyes auditor** that has seen only DESIGN.md and the built app hunts deviations (a wrong radius, a literal duration, an off-ramp colour, a §10 phrase, a Space meaning that differs from §8) and reports each with a screenshot. Lint and harness must have caught every one; each miss becomes a new rule.

> **What this means:** Nine milestones remain as citations, now cut into eight lanes. Each ends with something you can see or hold, and each has a machine trying to break it before you do. The riskiest hand-offs (the email frame, onboarding closing, the switch to the real engine) build the interface first on the stand-in engine and switch the engine part later.

## 6. Test strategy

### 6.1 Layers

| Layer | Tool | Proves | Runs |
|---|---|---|---|
| 1. Pure logic | `node --test` (the repo's runner) | Tokens, contrast and ΔE, springs, resolver, hold gate, ghost scheduler, optimistic reducer, window cache, palette scoring, operator parser | Every commit |
| 2. Lint fixtures | `node --test` driving ESLint and stylelint | Each rule rejects its bad fixture and accepts its good one | Every commit |
| 3. Behaviour and DOM | Playwright, headless Chromium, browser preview, stand-in engine | Keys, flows, DOM assertions (one filled button per route, no layout-property animation, no text under 11 px, no banned strings), axe, fuzz | Per work package (core 30 states); full at each lane's milestone |
| 4. Visual | Playwright screenshots | Look unchanged unless intended; motion filmstrips | Same |
| 5. Hidden Electron | `_electron.launch`, `show:false`, isolated userData | The `aplos-mail://` frame, key relay, onboarding lifecycle (F3, F4), packaged timing | `ui-reader` and `ui-onboard` milestones, and U9 |
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

| # | Check | When | Who |
|---|---|---|---|
| 1 | Serif look sheet: Newsreader or SF (the serif itself is decided) | Day-9 review | Owner |
| 2 | Dropped on 2026-10-27. The glass material is gone, so there is no vibrancy contrast check (DESIGN §4.6) | n/a | n/a |
| 3 | Motion feel at normal and rapid speed | Day-9 review in the browser preview; packaged build on day 15 | Owner |
| 4 | Keys with focus inside the mail frame, packaged app | `ui-reader`, days 14-16 | Agent with a hidden-window script if it works, else owner |
| 5 | Real Groq Ask round trip, key from the backend environment | `ui-ask`, days 12-13 | Agent, key never printed |
| 6 | Real Google account through the new onboarding | Days 14-16 | Owner (Testing-mode test user) |
| 7 | VoiceOver on six screens; real IME in compose and search | Daily-use week, days 18-25 | Owner |
| 8 | Daily-use week on the release candidate, run together with the engine soak | Phase 3, days 18-25 | Owner |
| 9 | Onboarding window chrome: traffic lights over the white strip, drag region, vertical resize, the "Try demo mail" corner button (a browser-preview harness cannot see native chrome; `page.screenshot` of a hidden Electron window only if the U1 spike says it is real pixels) | Day 15 | Owner |
| 10 | The first real weekly Gmail reconnect, through the status line and the sheet | Inside the daily-use week (roadmap: reconnects on days 7, 14 and 21) | Owner |

### 6.6 What counts as evidence

Each checked item in `TODO.md` and `PROGRESS.md` carries a test output path or headless screenshot path. Screenshots use original demo data only. Mocked Google or providers never close an item that says "live".

> **What this means:** Most checks are automatic and run with no window on screen. A handful need your eyes or hands, listed by name so none is forgotten.

## 7. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | The contract freeze (day 3) slips, or `eng-views` conformance on the real engine (day 11) slips | Screens use `useView` over the stand-in engine, so a freeze slip delays only the final hook signatures, and `ui-foundation` still produces tokens and plain components. If `eng-views` slips more than two days, the switch (WP5.6) moves with it. There is no `compat.ts` fallback because there is no legacy bridge. The switch is one flag. |
| 2 | The typed client is awkward for real screens | The UI reviewer in the day-3 freeze review walks every mockup screen against the contract and the data hooks; later changes are additive through `eng-contract`. |
| 3 | Hidden-window timing is untrustworthy | The U1 spike decides early; fallback in §6.4. |
| 4 | 8 ms key-to-state is unrealistic in React | External store, imperative cursor, a virtualised window of about 30 rows; recalibrate once after the first measurement (DESIGN §5 allows it). |
| 5 | Agents drift despite the rules | Skill, lint, a U9 fresh-eyes audit; each miss becomes a rule; lint evasion attacked in U1. |
| 6 | The serif looks wrong | The look sheet is in the day-9 review; one token is the fallback. |
| 7 | Dock seams return (`DECISIONS.md:298`) | Fix as designed, test packaged, fall back to a one-step resize. Never animate width. |
| 8 | Out-of-process frame keys do not arrive [U] | Hand check on days 14-16; a limited non-destructive relay is the fallback (ARCH §10). |
| 9 | Merge conflicts with the Phase 0 restructure chain (rename, format, `electron.ts` split, lint) | `ui-foundation` works in its own worktree on new files and merges F9 after step 4; the other lanes start on day 5; `renderer/legacy/` is read-only. |
| 10 | PR #21 moves while `ui-onboard` waits | Re-pin to its head at the lane's start (day 5). |
| 11 | About 90 states is too many to polish equally | P0 states (Home, reader, compose, palette, onboarding, status, toasts) must pass fully; P1 (rare errors and empties) need the harness check and a lighter review. |
| 12 | Screenshots leak real mail | Original demo data only; a scanner greps harness output for real addresses before anything is attached. |
| 13 | The first-sync screen promises more than Gmail's quota allows, or lies under a pause | The gate is the first window only; backfill is never in it; the quota scenarios and property test of U8 acceptance 4 |
| 14 | PR #21 absorption drags engine files in | Take files by path, never merge the head; engine tests go to `eng-ai` (U8) |
| 15 | A UI lane finishes late and the release candidate slips | The switch happens on days 11-13, not at the end. `ui-reader` and `ui-ask` are the near-critical lanes and start first, and P1 states (risk 11) may follow in Phase 3. |
| 16 | The weekly Gmail reconnect surprises the owner or loses work | The status line appears a day ahead, the sheet reconnects in one click with `login_hint` and no resync, queued local changes are kept, and the first real reconnect inside the daily-use week is the acceptance test (§6.5 #10). |

> **What this means:** The biggest risks are the engine arriving late, the keyboard path into the email box, and agents quietly drifting. Each has an early check or a fallback that is already written down.

## 8. Interfaces and contracts with the other workstreams

### 8.1 From plan 10 (the Engine thread)

1. **`packages/contract`**, typed client and generated allowlists, frozen on day 3 as F1 and F2, plus the **stand-in engine** (F6, `packages/contract-fixture`; every method on the `demo` and `empty` scenarios at the freeze, the other scenarios during Phase 1) serving `View/watch` windows, receipts, statuses and scripted scenarios, with a test-only control channel (compiled out of production) to force a status, rate-limit pause, failed write, submission state or setup progress and to set the clock (`APLOS_NOW`).
2. **View specs** of §4.1, including Done leaving Home for mail needing a reply.
3. **`Thread/act`, `Operation/undo`, receipts, `holdIds`** and opaque state tokens (ARCH §9.2).
4. **Mail frame:** `Mail/frame {messageId, imagePolicy, findQuery}` returning `{url, expiresAt, bodyKind, trackersRemoved, hasRemoteImages, quotedCount}` plus `Mail/frame.release` (plan 10 E4 and §4.1 use the same shape); the reporter message schema; optional `toggleQuotes`; the `mail-key` relay; a per-sender image allow-list.
5. **Submissions** (queued, sending, sent, uncertain, failed, cancelled, suspended) and a draft-changed-elsewhere signal.
6. **Setup and AI governance:** `Setup/begin|end|status` (plan 10's names; the UI calls `Setup/end` on every window close), one-shot deferral, per-run ids, backfill including reply refresh, a versioned consent record, `trainsOnInputs`, the daily cap, the per-account AI toggle, the primary-device lease and override.
7. **`Ask/run`** progress frames with citations `{n, messageId, quote}`.
8. A **`ui` settings object** (density, key hints, dock, keymap, hold threshold), retention and resident-mode toggles.
9. **Diagnostics** export preview, queue-inspector methods, the parked-engine event, and `Session/get` capability flags so the UI can say "Not available yet".
10. **`APLOS_TEST=1`** in main (a hard dependency of every hidden-Electron test): isolated userData, no single-instance lock, Dock icon, menu-bar item or login item; the onboarding and mail windows are created `show:false` under test.
11. **Empty start and demo on request (owner wish; PR #21's M42):** a fresh install, and the E2 import of an empty or absent store, creates **zero accounts and no demo data** (today `service.ts:195` seeds `createDemo` whenever the store is empty). New contract calls `Demo/load`, `Demo/reset` and `Demo/remove`, idempotent, touching only demo accounts; saved demo or real data is never seeded over or wiped; the stand-in engine honours the same rule. A `Session/get` field says whether any account exists so main can choose onboarding or the mail window.
12. **`Setup/status` shape for the first-sync screen:** per account `{state, firstWindow: {found?: estimate, read, total}, ai: {sorted, total, capped, failed}, backfill: {read, target}, pausedUntil?, reconnectBy?, reasonCode}`; `firstWindow.total` is the window target (about 50), never the mailbox size; `ai` appears only with stored consent and a provider.
13. **Weekly reconnect:** the account fact `reconnectBy` (the grant time plus 7 days) in `Setup/status` and in account status, `Account/reconnect` taking `login_hint`, reconnect without resync, and queued local changes kept (roadmap N3; F1).

The UI gives the Engine thread the view-spec list, the frame host behaviour, the F3, F4 and F7 patches and tests (the onboarding window creation and handoff patch of U8), the menu-bar glyph (U3), the "renderer is on the real engine" report at the switch (which unblocks deleting the legacy folders), `tests/onboarding.test.ts` as `eng-ai`'s starting scenarios, and contract-ergonomics change requests through the day-3 freeze review.

### 8.2 From plan 20 (the Providers thread)

- Account status `{state, reason, resumeAt, reconnectBy}` in the ARCH §6.4 vocabulary, and first-sync checkpoint facts (connected, found as an **estimate when the provider gives one**, read n of the first-window total, `resumeAt`, reason code), set when the first window completes (`baseline_done_at`), aggregated by plan 10's `Setup/status` (§8.1 item 12) for U8's honest progress. The UI never needs a mailbox total.
- Calendar fields for "this event or all events", RSVP, hidden and selected calendars, colours.
- Provider errors mapped to the plain copy of U5, so the UI never shows a raw error.

The UI gives plan 20 the status copy table, the harness scenarios for every status, and the live onboarding check (U8) as an acceptance vehicle.

### 8.3 From plan 40 (the Platform and website thread)

- Phase 0 restructure steps 2 and 4 (the format and lint commits) before F9 merges; the `tools/lint/design/` extension point where the design plugins live; the one pinned Playwright base (`tests/e2e/playwright.config.ts`, F8); root devDependency changes by small PR to `plat-ci`. CI runs on Linux for pushes to `revamp`, and macOS jobs, including the harness's, run on demand (roadmap §6). The hidden-window handling that F4 needs comes from `eng-host` and F8.
- **Provenance gate:** plan 40's gate needs all 17 Avec-derived items gone. The new screens never contain them (the U0 table assigns each to a lane), and the gate's grep excludes `renderer/legacy/` until the Integrator deletes it (days 14-17).
- The CSP changes of ARCH §12.1 (no `'unsafe-inline'` in `script-src`, no `https:` in `img-src`, `frame-src aplos-mail:`) happen **after** the UI confirms it has no inline scripts or eval. The UI ships `font-src 'self'` for the bundled fonts.
- Website: not in this plan. The `web` lane owns `apps/web`, reads the tokens from F9, and owns copy truthfulness. The open conflict with DESIGN decision 14 is recorded in Decisions.
- The UI gives plan 40 `npm run lint`, `check:tokens`, `check:contrast`, `check:identity`, `test:visual`, `test:perf` (the five slot names plan 40 reserves), `tokens.json` for the website, and the skill.

### 8.4 Contract change process

A change to `packages/contract` goes through `eng-contract`: propose it with CONTRACT-CHANGE-PROPOSED, and it lands as a small PR labelled `contract-change`, additive within `v:1`. The UI never edits `preload.ts`, `main/windows.ts` or other `eng-*` paths beyond the small, flagged patches named above.

> **What this means:** The UI depends on the engine team for a handful of specific things, all listed here with the milestone that first needs them. In return it hands them the checks, the copy and the early feedback.

## 9. What to read first

For the T3 UI thread, in this order:

1. `plans/00-roadmap.md` (reference sections 1, 2.3, 2.4, 4, 6, 7, 10), then `plans/DESIGN.md` in full (especially §2.3, §4, §5, §7, §8, §12, §13, Appendix C), then `mockups/index.html`.
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
- **Branches follow roadmap §7.** Lane branches are `rv/<lane>/<slug>` (for example `rv/ui-home/triage`, `rv/ui-reader/inline-reply`), one git worktree each. The coordination branches are `rv/thread/ui-core` and `rv/thread/ui-screens`. No branch name is a folder of another, so there is never a branch named exactly `rv/<lane>`. `rv/ui/mockups` stays as the design thread's branch and nobody else commits to it; its `mockups/` folder is merged into `revamp` at launch as read-only visual reference.
- **Small pull requests into `revamp`:** one work package each, ideally under 500 changed lines excluding generated files. The Integrator merges them after typecheck, tests, `npm run check`, the owners check and the conformance run pass, and a lane never merges its own PR. Review is batched per lane milestone, and nobody re-triggers Cubic after every fix.
- **Evidence** (headless before and after screenshots in both themes, test output, numbers) goes in the PR with `gh pr create --attach` and is never committed, except the small golden screenshot set (§6.2).
- **Staying current:** lanes merge `revamp` into their branch before each PR (merges, not rebases, and no force-push of a shared branch). Phase 0's mechanical commits are listed in `.git-blame-ignore-revs`. Everything else squashes, naming the lane and work package.
- **Phase 0 gate:** `ui-foundation` works in its own worktree on new files and merges F9 after restructure step 4 (lint) lands, because `tools/lint/` is created there. The other UI lanes start on day 5 against the frozen F9 props and hooks. Nobody edits `renderer/legacy/`.
- **Shared hotspots** (`preload.ts`, `package.json`, `AGENTS.md`, `DECISIONS.md`): small isolated commits, merged early, reviewed by the owning lane. Contract changes go only through `eng-contract` (label `contract-change`, additive within `v:1`).
- **Commits** are authored as Kainoa Newton (`k@kainoa.me`); any other `user.email` is flagged first. No keys, `.env` or real mailbox data in a commit or screenshot.
- **Reaching the owner:** the browser preview for the day-9 and day-10 look review, local packaged builds from day 15, and `v0.3.0-beta.N` draft releases in this private repo on the owner's go-ahead. Each lane's LANE-DONE note and the Integrator's daily digest carry the plain-English summary. Stable releases are tagged from main after the owner merges `revamp` (proposed 0.3.0), following the daily-use week (days 18-25).

> **What this means:** Everything happens on side branches, one reviewed pull request per work package, with main untouched until you say so.

## Evidence index

- **Binding documents:** `plans/00-roadmap.md` (sequencing); `plans/DESIGN.md` (§2.3-§15, Appendix C), with `mockups/` as the visual target; `plans/ARCHITECTURE.md` (§2.2, §3.5, §4.1, §5.1, §6.3-6.5, §7-§12, §14, §15); `plans/_council/CONTEXT.md`; `plans/_council/task-plan-30-ui-revamp.md`.
- **Research:** `RC/gaps/engine-contract-rpc-stack.md` (§1, §3, §5-§8); `RC/gaps/electron-email-html-isolation.md` (§1, §7-§10); `RC/ui/aplos-baseline.md` (§3-§6.9, §8); `RC/ui/superlocal.md` and `RC/ui/redakt.md` (resolver, skill method); `RC/gaps/identity-collision-audit.md` (§4); `RC/protocols/proto-others.md` (§5); `RC/SYNTH-ui.md` (§6); `research/pr21-onboarding-review.md` (all 14 findings).
- **Measured on Aplos main `72095ff`** (`apps/desktop`): `grep -c` counts in `src/renderer`, `wc` sizes, hold thresholds (`App.tsx:379`, `Compose.tsx:15`, `Ask.tsx:16`), `package.json` scripts, the `tests/` listing, renderer imports of `engine/*` and `shared/*`.
- **Cross-plan facts used in this alignment (2026-10-27):** `plans/00-roadmap.md` §1 (F1-F10), §2.3-§2.6, §4, §7, §8 and §10 (plan 30 items 1-7); `mockups/DESIGN-CHANGES.md` (§1-§12, folded into DESIGN.md on 2026-10-27); plan 10 E3 (view specs, conformance, holds), E4 (`Mail/frame`) and E5 (`Setup/*`); plan 20 §4 (`baseline_done_at`, checkpoint facts) and the weekly-reconnect fields; plan 40 Q1 (`tools/lint/`), Q3 (one Playwright base, CI slots `check:tokens`, `check:contrast`, `check:identity`, `test:visual`, `test:perf`) and the provenance gate (line 447).
- **PR #21 facts** [V by `gh pr view 21`]: head `2d8884662ee6`, 46 files changed (engine, main, shared, renderer, tests, web script), title "First run: onboarding in its own window, demo only on request"; its body describes the empty start, the corner demo link, the loading screen with a 60-second AI cap, and a fixed 720 x 560 window (DESIGN §7.11 replaces that with 640 x 600, resizable). Today's demo seeding: `src/engine/service.ts:195` (`store.read()||createDemo(now())`) [V]. `DECISIONS.md:125, :128, :129` quoted in the U0 section [V].
- **Not re-verified:** DESIGN's colour, contrast and spring numbers (U1 recomputes them); OOPIF keyboard routing ([U], U6); hidden-window timing validity ([U], U1).

> **What this means:** Every number in this plan is either measured on the current code, taken from the binding documents, or marked as a judgement or an open check.
