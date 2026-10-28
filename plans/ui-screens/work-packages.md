# UI-screens work packages (draft for days 5-13)

Written 2026-10-27 (day 1) by the UI-screens thread, step (a) of each lane workflow (brief 4 §9). It splits each lane into work packages with disjoint files, a definition of done and the named adversarial check each must survive. File names are provisional until F9 freezes component props and the hook signatures (day 3). Where F9 names a part, these packages use it and never restyle it.

## In plain English

This is the to-do list for building our four screen areas, cut into pieces that agents can build at the same time without touching each other's files. Each piece says what "done" means and which attack a second agent will try against it. Onboarding starts first, on day 5. Calendar, Settings and Ask start on day 6.

> **What this means:** When the shared rules freeze, each screen can start building at once, several pieces in parallel, each checked by an agent that didn't write it.

## Common definition of done (every package)

- Its todos in `apps/desktop/tests/<lane>/pending.test.ts` become real tests, and they pass.
- `npm run typecheck`, the targeted tests and `npm run check` (once `plat-ci` lands it) pass.
- Headless screenshots exist for every state the package draws, in light and dark, next to the matching mockup. An agent reads them.
- The contrast, banned-string, banned-glyph, one-filled-button and hover-never-shifts checks pass.
- Keyboard paths are covered by tests, and reduced motion is respected.
- No raw provider error appears anywhere. Every string follows DESIGN §10, and reason codes map to DESIGN §7.15 copy.
- Every UI agent loads the `aplos-design` skill first. UI work goes to Claude only, never an open-weight model.

## `ui-onboard` (feature 5, plus the first-sync slice of feature 1), from day 5

Paths: `apps/desktop/src/renderer/onboarding/**`, `apps/desktop/src/main/windows/onboarding.ts`, `apps/desktop/tests/ui-onboard/**`.

| WP | Model | Files (disjoint) | Done when | Named adversarial check |
|---|---|---|---|---|
| 8.1 Absorb by path | Sonnet | `onboarding/_ref/**` (PR #21 copies, reference only, deleted by 8.2's end) | Re-pinned head recorded; nothing imports `_ref` | n/a |
| 8.2 Steps, consent, focus, keys | Sonnet | `OnboardingWindow.tsx` (step router), `steps/{Welcome,Accounts,Ai,Permissions}.tsx`, `ConsentCard.tsx`, `connect.ts`, `keys.ts`, `onboarding.css` | Four steps match the mockups and DESIGN §7.11. The only account row is Google. "Try demo mail" sits in the strip. Return continues and Esc goes back. Each step focuses its main action. | **Stuck on any step:** close, Esc and late connect at every step (F9, F12, F13, close-at-any-moment matrix) |
| 8.3 First-sync screen and drill | **Opus** | `FirstSync.tsx`, `firstSync/model.ts` (pure: `Setup/status` → segments and copy), `Drill.tsx` | U8 acceptance 4(a-d) holds: no total, no early "Done", "Esc opens Aplos", auto-open only on a clean finish. One `role="status"`. | **"Google throttles me":** scripted `paused`, `resumeAt` and slow batches try to make it lie (a wrong total, an early Done, a stuck Esc). Property test: counters never decrease (F5, F8, F10, F11) |
| 8.4 Reconnect sheet | Sonnet | `ReconnectSheet.tsx`, `reconnect.ts` | Works on `needs-reauth` and `reconnect-due`. Sends `login_hint`. Shows "Waiting for Google in your browser…", Cancel, failure reasons and the "Reconnected" toast. Returns to where the owner was. No `Sync/request`. | **A connect resolving after Cancel or close** changes nothing on screen; a wrong account is refused in plain words |
| 8.5 Window patch | Sonnet (`eng-host` reviews) | `main/windows/onboarding.ts`, `tests/ui-onboard/electron/**` | 640 × 600, minimum 640 × 520, vertical resize, hidden inset, one window on a second launch, handoff on `ready-to-show` with a 120 ms fade, `Setup/end` on close | **Second launch, and a close during handoff** (F3, F4) |
| 8.6 Zero accounts, demo, Show welcome | Sonnet | `ZeroAccounts.tsx`, `demo.ts`, `showWelcome.ts` | Fresh `APLOS_DATA_DIR` makes no `Demo/load` call. Demo skips first sync. Show welcome changes nothing. | **Demo isolation:** existing 0.2.x demo or real data is never seeded or wiped |

Order: 8.1, then 8.2, 8.3 and 8.5 in parallel, then 8.4 and 8.6. The first-sync screens on `rate-limited`, `backfilling` and `needs-reauth` go to the Providers lead for feature 1 when asked.

## `ui-calendar` (feature 6), from day 6

Paths: `apps/desktop/src/renderer/screens/calendar/**`, `apps/desktop/tests/ui-calendar/**`.

| WP | Model | Files | Done when | Named adversarial check |
|---|---|---|---|---|
| C.1 Layout engine | **Opus** | `layout/{lanes,geometry,time}.ts` (pure) | Overlaps: the first lane plus "+N" at 44 px or wider, decided by width. All-day strip. DST and time-zone correct. One clock (`useNow`). | **Worst-case data:** 12 overlapping events, 0-minute and 36-hour events, a DST day, a 200-character title, a non-Latin title |
| C.2 Week, day, month and agenda views | **Opus** | `views/{Week,Day,Month,Agenda}.tsx`, `CalendarScreen.tsx`, `calendar.css` | Today tint and badge, now line, 24-hour scroll opening at 8 AM, narrow agenda under 720 px. D/W/M on a `Puck` with no width animation. Period slide and pinch zoom kept. | **Hover never shifts layout; D/W/M never animates width** |
| C.3 Detail, RSVP, repeat scopes | Sonnet | `detail/{EventDetail,Rsvp,ScopeDialog}.tsx` | RSVP starts with nothing chosen and "Send reply" stays disabled until a choice. Y/M/N work only on an open unanswered invite. "This event" / "all events". Undo during the 8 s hold. | **RSVP and delete undo inside 8 s make no provider call** (contract log) |
| C.4 Create, edit, drag | **Opus** | `edit/{Editor,drag}.ts(x)` | N creates; drag creates, moves and resizes with `lift`/`snap`. No Delete on an unsaved event. Locked events refuse a drag with a reason. | **Rapid drags plus Esc mid-drag; key-to-state ≤ 8 ms** |
| C.5 Sidebar data and commands | Sonnet | `sidebar/{useMiniMonth,useCalendarList}.ts`, `commands.ts` | `ui-shell` places them. Click toggles, ⌥-click solos. Every calendar key is in the registry and the palette. | **A palette command with no handler; a key that maps to two commands** |

Order: C.1 first (half a day), then C.2-C.5 in parallel.

## `ui-settings` (feature 8), from day 6

Paths: `apps/desktop/src/renderer/screens/settings/**`, `apps/desktop/tests/ui-settings/**`.

| WP | Model | Files | Done when | Named adversarial check |
|---|---|---|---|---|
| S.1 Frame and registration | Sonnet | `SettingsScreen.tsx`, `nav.ts`, `registry.ts` (`registerSetting` entries for every row), `settings.css` | 180 px nav, 600 px column, nav aligned with the first group, 32 px group gap, 40/48 px rows. Every row reachable from ⌘K with a deep link. | **Settings reach:** every `SettingRow` has a palette entry (U7 acceptance 2) |
| S.2 AI | Sonnet | `sections/ai/**` | Features table first (Voice lists Groq and OpenAI only). Hosted and local groups. Key source line, never key characters. Test, Add key, Remove disabled for env keys with a tooltip reason. Local addresses. Consent re-review. Daily cap in tokens. | **Secret scanner:** a canary key is never in the DOM, an attribute, a screenshot or a log (U7 acceptance 3); `break-ui` with a 40-character provider name |
| S.3 Keyboard | Sonnet | `sections/keyboard/**` | Generated from the registry. Remapping with the KeyRecorder, conflict marks, reserved chords refused, single-key switch, "Show all key hints", hold threshold. | **A remap that collides, a reserved chord, a hold key moved to a chord** |
| S.4 Accounts | Sonnet | `sections/accounts/**` | One name per account. Status on the row. Reconnect for `needsReauth`, `needsPermission` and `reconnectBy` within 24 h, opening the sheet. Demo Reset and Remove. Per-account AI. Background-work device. | **Reconnect row** on `needs-reauth` and `reconnect-due` (U7 acceptance 8); a 200-character address |
| S.5 General, Mail, Calendar, Notifications | Sonnet | `sections/{general,mail,calendar,notifications}/**` | Appearance copy "Light, dark, or match the system." Undo send 0/5/8/10/20/30 s. Follow-up days. Images. Retention. Menu bar and login. | **A string that breaks DESIGN §10** (banned-phrase scan, one filled button) |
| S.6 Help, tools, diagnostics | Sonnet | `sections/{help,tools}/**` | Show welcome, Load demo mail, version line, "Allow tools on this Mac", clients with revoke, diagnostics preview, queue inspector. "Not available yet" behind capability flags. | **The diagnostics preview leaks nothing** (canary subject and address seeded) |

Order: S.1 first, then S.2-S.6 in parallel.

## `ui-ask` (feature 7), from day 6

Paths: `apps/desktop/src/renderer/screens/{ask,today,palette,search}/**`, `apps/desktop/tests/ui-ask/**`.

| WP | Model | Files | Done when | Named adversarial check |
|---|---|---|---|---|
| A.1 Palette | **Opus** | `palette/**` | Opaque, 600 px, context line, Suggested and Go to first, groups, breadcrumbs, scoring order, 1-9 only with an empty field, destructive confirm defaulting to Cancel, Esc up then close | **Palette reach:** every registry command reachable; context line truthful in 30 contexts; Esc never navigates; scoring fuzzed against a second agent's oracle |
| A.2 Search page | Sonnet | `search/**` | Field at `heading` size, operator tokens incl. `in:done`, local rows as you type, "Search all mail on Google · Return", no-match line, `>` opens the palette | **Typing never calls remote; Return calls it exactly once** (U7 acceptance 7), across `reset` |
| A.3 Ask dock | **Opus** | `ask/**` | 360 px second pane, closed on first run then remembered. Serif answers, citations with hover and click, step log, queued follow-ups, proposal card, no-provider and error states, hold A to dictate. | **Ask invariants over 20 fixture answers:** a citation or "No source in your mail"; input never disabled while streaming (U7 acceptance 4) |
| A.4 Today | Sonnet | `today/**` | Next event, the following two, free gaps of 30 minutes or more, now line, "Open Calendar", the ⇧A / calendar button | **Clock and gaps agree with `APLOS_NOW`;** declined and free events don't block |

Order: all four in parallel. A.3 waits for `eng-ai`'s Ask frames on the stand-in.

## Hands-on and live (not agent-closable)

- ui-onboard: a real Google onboarding by the owner (days 14-16); window chrome check (day 15); the first real weekly reconnect (daily-use week).
- ui-ask: one real Groq Ask round trip in Electron dev, run by an agent with the key from the backend environment and never printed (days 12-13).
