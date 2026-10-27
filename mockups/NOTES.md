# Skypaper mockups: notes

## In plain English

These are pictures of the new Aplos that you can click through. Nothing in them is the real app. They exist so you can judge the planned look before anyone writes code. They follow `plans/DESIGN.md` (Skypaper).

**How to open them.** Double-click `mockups/index.html`. It opens in your browser, with no install and no server. The gallery groups every screen: onboarding, Home and lists, reading and writing, Ask and search, empty and error states, calendar, and settings. The switch in the top right sets light or dark, and every screen remembers it. Click a picture to open that screen at its real window size. The small bar at the bottom right of each screen switches theme and state. It also has a keyboard button that shows every key hint. The serif font loads from Google Fonts, so open the gallery while online the first time.

**What to try.** On Home, press J and K to move, E for Done, L for Later and Z to undo. Watch the letter get carried off and the next one slide into the same spot. ⌘K opens commands, / searches, ? shows every key, A focuses Ask, ⌘J opens and closes the Ask dock, and Esc goes back. Hold ⌘ to see the key hints.

**What to judge.**
1. The serif summaries. Do you like Newsreader as Aplos's voice?
2. The ink-blue accent: is it calm enough?
3. The onboarding window with the sky behind it.
4. The "You handled 12 emails" sky. It is the loudest thing in the app, and I think it needs toning down (finding 1 below).

**The findings below are the useful part.** They cover the places where the design document was unclear or looked wrong once drawn, each with a fix.

## How this is built

- **Shared files:**
  - `tokens.css` holds every value in DESIGN §4, and pages use only these variables.
  - `shell.css` holds the window chrome and the §6 component parts.
  - `shell.js` handles the theme, states, icons, sidebar, tooltips, the J/K list, toasts, key routing and the drawn sky.
  - Helper files: `cal.css`/`cal.js`, `settings.css`/`settings.js`, `home-view.js` and `home-backdrop.js`. The last two both draw the Home list behind overlays. They are near-duplicates written in parallel; fold them into one if these mockups live on.
- **States:** each page lists its states in `<html data-states>` and reads `?state=`. `?theme=dark` and `?shot=1` (no mockup bar) also work.
- **Screenshots:** `node mockups/shoot.cjs [page.html …]` runs headless Chromium. It shoots every state in both themes into `mockups/_shots/` (gitignored), then audits the page for:
  - JS errors
  - banned words and icons
  - more than one filled button
  - text under 11 px
  - text contrast under 4.5:1

  The final run covers 82 states × 2 themes (164 screenshots) and finds 0 issues. I reviewed every shot myself on light/dark contact sheets.
- **Sizes:** main window 1440 × 900. Onboarding window 640 × 600.
- **Data:** all invented: Alex Moreno, the Hollow Creek site, Fernworks Studio, and a separate bakery world for demo mode.

## What each screen exercises

| Screen (file) | States | DESIGN.md decisions and sections |
|---|---|---|
| Welcome (`onboarding-welcome.html`) | – | §7.11 window and steps, sky moment 1 (§7.16), `display` serif, demo only as a small top-right text button (owner wish), Return/Esc |
| Connect account (`onboarding-accounts.html`) | choose, typed, waiting, connected, icloud | §7.11 step 2: discovery moves focus (F12), "Waiting for Google in your browser…", a late connect never pulls you back (F9), iCloud preset copy (plan 30 §4.5 row 7) |
| AI provider (`onboarding-ai.html`) | groq, byok, local, consent | §7.11 step 3: Groq preselected with its key source shown, key characters never shown; Ollama/LM Studio addresses; the consent card (plan 30 §4.5 row 1) |
| Permissions (`onboarding-permissions.html`) | default, granted | §7.11 step 4 "Voice", widened to the owner's "permissions explained"; hold A / hold R keycaps |
| Try the keys (`onboarding-drill.html`) | step1, step3, done | §7.12 "Try the keys while your mail arrives" (the Instrument graft); a quiet sync line stays visible |
| Getting your mail (`onboarding-sync.html`) | progress, paused, ready, partial, failed | §7.12 + plan 30 U8: checkpoint `ProgressSegments`, "about N" only with an estimate, "n of 50" not the mailbox, Google slow-down copy with resume time, enter early (Esc), auto-enter only on a clean finish, `sunrise`, honest partial wording (F10), failed + Esc continues (F8), one `role=status` (F11) |
| Home (`home.html`) | default, no-ai | §7.2: the fixed 160 px focus letter, serif `summary`, one filled button with an always-shown Space, sections New / Due now / Waiting on others, low-importance band, ink-ramp fade; §4.9 commit chip + edge + `flight` + `deal` + `hold`/`close`; no-provider shows the subject in SF |
| All mail (`inbox.html`) | default, bulk | §7.4: one list, accent-wash + 2 px bar selection, hover actions that overlay the date, X / ⇧X bulk with the title replaced in place; decision 7 (arrows only move here) |
| Later (`later.html`) | later, bookmarks, drag | §7.3: groups, overdue as clock + `--stamp-ink`, Later \| Bookmarks puck, drag with `lift` and labelled targets |
| Done (`done.html`) | – | Not in DESIGN (finding 6): All mail filtered by an `in:done` operator token |
| Later picker (`later-picker.html`) | default, calendar | §6 `DatePresets`: 1–5, Pick a date, Return; `reveal` |
| Demo mode (`demo.html`) | – | plan 30 §4.5 row 8; demo account switcher and status slot |
| Reader (`reader.html`) | default, pending, no-ai | §7.5 and decision 5: sender line → big serif summary → quiet subject → thread (28 px one-liners, 3 px rail) → body at 68ch; the flap; the margin rail (decision 12) with Why + ⌥↓/⌥↑; provenance on hover (§9.5) |
| Inline reply (`reply.html`) | reply, reply-all, dictating, sent | §7.6: reply inside the paper with the post edge, `LevelMeter`, `UndoTray` with a draining post edge, one notice per send |
| Compose (`compose.html`) | new, ai-draft, polish | §7.6: 680 px non-modal sheet, post edge, DraftState, AI draft as plain editable text (Tab/Esc), Polish as a diff that never overwrites (§9.6) |
| Ask dock (`ask.html`) | answer, empty, working, no-provider, today | §7.7 and decision 9: question line with a rule, serif `answer`, mono citations, folded step log, proposal card with two key rows, queued follow-up, calm no-provider line, the Today agenda |
| Palette (`palette.html`) | commands, filtered, confirm | §7.9 and decision 10: context line, groups, keycaps, scoring, destructive two-row confirm |
| Search (`search.html`) | results, no-match | §7.9: operator tokens, remote search only on Return, results as ordinary rows |
| Shortcuts (`shortcuts.html`) | default, filtered | §8, generated from one registry array; level-3 dialog |
| Empty (`empty.html`) | inbox-zero, first-mail, no-accounts, drafts, trash, spam | §7.14, sky moment 3, plan 30 §4.5 rows 8 and 10 ("Your first mail is on its way", never the all-clear sky while syncing) |
| Errors (`errors.html`) | reconnect, quota, offline, row-error, send-failed | §7.15 and §7.1 status slot: never a banner that pushes the list |
| Fatal (`fatal.html`) | – | §7.15 `FatalScreen` |
| Toasts (`toasts.html`) | stack, pending, remind, offline | §7.13: stack of three, op-queue wording, next-step toasts (decision 6) |
| Calendar week / day / event (`calendar-*.html`) | default, overlap / default, empty / detail, rsvp | §7.8: real-date title, D/W/M puck, today tint, now-line with cap, event rule + fill, "From mail" dashed plan, 44 px lanes with "+N" stack, comma in day titles; §4.2 colours |
| Settings General (`settings-appearance.html`) | – | §7.10 layout (200 + 640, 40 px rows); "Light, dark, or match the system." (§10) |
| Settings Accounts (`settings-accounts.html`) | default, reconnect | §7.10: connection state and Reconnect on the row; per-account AI switch and demo controls (plan 30 §4.5 rows 2 and 8) |
| Settings AI (`settings-ai.html`) | default, testing | §7.10: nine providers with key source (never characters), Test, local addresses; the feature table for Ask, Summaries, Drafts, Plans and Voice (Voice limited to Groq/OpenAI); the one privacy explanation |
| Settings Keyboard (`settings-keyboard.html`) | default, recording | §7.10 / §8: registry-generated list, remapping, conflict marks, single-key switch, "Show all key hints" |

Across all pages:
- **Banned items:** none of the §13 Avec-derived elements appear, and no sparkle, wand, star or brain glyph does either. The audit checks the banned words and icons on every state.
- **Buttons:** one filled button per screen at most.
- **Key hints:** keycaps stay hidden until hover, except the primary action's key.

## Where DESIGN.md was ambiguous or looked wrong, with recommended changes

Ranked by how much they matter.

1. **The sky moments are far too loud inside the app (§7.16).**
   - *Light:* the icon's sky (`#2a9afd`→`#67ccff`) fills the whole Home workspace when it empties. It is the most saturated surface in the app by a wide margin, next to a pale sidebar, and it reads as a different product.
   - *The hill:* `--hill` `#2f6f2a` paints a dark forest, not the icon's sunny grass.
   - *Dark:* `--hill` `#86b86a` would look like a floodlit lawn at night. I darkened it toward the night sky (an invented value).
   - **Recommend:**
     - Keep the full icon sky only in the onboarding window.
     - Inside the main window, use a softened sky (the icon sky mixed about 50% toward `--horizon`) and a lighter scene hill.
     - Add dedicated `--scene-hill` tokens per theme instead of reusing the Done colour.
     - Extend the sky behind the toolbar on Home-empty. Stopping at the toolbar leaves a hard seam.
2. **Three rules fail the document's own 4.5:1 contrast rule.**
   - `breathe` (opacity .55↔.85 on `--dim`) measures 3.1:1 in light and 3.9:1 in dark. **Recommend** breathing `--ink-2` between .75 and 1, which these mockups use.
   - The pending line shows the *subject*, so set it in SF. Swap to the serif only when the real summary lands, otherwise the "AI voice" is speaking words the AI didn't write.
   - `--faint` is "non-text only", yet disabled buttons need a text colour. **Recommend** disabled text in `--dim` with `--faint` icons.
   - **Home's ink-ramp fade inverts the hierarchy.** Far rows get a `--dim` sender with an `--ink-2` summary, so the summary out-shouts the name and it looks like a bug. The near/far difference is also barely visible. **Recommend** far rows as an `--ink-2` sender with a `--dim` summary, or drop the fade.
3. **Search is described as both an overlay and a list (§7.9 vs §8).** "One overlay, two entry points" conflicts with "results are ordinary rows" and with the Lists keymap applying to search. **Recommend:**
   - `/` puts a search field in the toolbar's title slot, with results as a normal list where J/K, E and L work. That is how these mockups do it.
   - ⌘K stays the only overlay.
   - The palette's "1–9 picks" collides with typing digits. Allow it only while the field is empty, or use ⌘1–9.
   - The destructive confirm should default to Cancel or require ⇧Return. A stray Return deleting forever is too easy.
4. **The onboarding geometry needs pinning down (§7.11, plan 30 decision 10).**
   - A sheet with a 16 px margin on every side hides the sky almost entirely, leaving a 16 px blue frame.
   - The traffic lights, at their default spot, straddle the sheet's 20 px corner.
   - **Recommend:**
     - A 48 px strip of sky at the top that holds the traffic lights and "Try demo mail" (ink on the icon sky is about 5.9:1).
     - 16 px side margins, and a sheet that is as tall as its content, so the hills show below on short steps.
   - On the sync screen:
     - State once that "Esc always enters Aplos".
     - Make the key drill a mode of the sync screen rather than a separate step, so the progress stays in view.
     - Say which marker carries the `status` motion when a segment also shows "n of 50". One bar can't be both a fill and a runner.
5. **One filled button collides with overlays.**
   - With the composer or palette open over Home, Home's Space button and Send both want to be the one filled button. **Recommend** the rule "the topmost surface owns the filled button". Home demotes its action to a text button while a composer or palette is up.
   - The composer is listed as elevation level 1, but floating non-modally over the list it needs dialog-level shadow to read as lifted.
   - The inline reply can't fit with the summary, the thread and the flap. The letterhead scrolls out of view. **Recommend:**
     - Cap the reply box at about 3 lines before it scrolls.
     - Keep a compact sender + summary line pinned.
     - Let the flap's filled button become Send while replying, as drawn.
6. **There is no Done view, but you asked for one.** DESIGN archives on Done and offers no way to look back. **Recommend:**
   - An `in:done` search operator.
   - A "Done" place reachable from ⌘K (or under All mail in the sidebar).
   - A "Move to Home" restore action (H).
   - Hide E and L on done rows.
   - Make hover actions icon-only, so they don't cover the "Done 9:41 AM" stamp that is the row's whole point.
7. **"Inbox list with the reader open" doesn't exist in DESIGN.** Split view is on the never-copy list (Avec, §14), so the list and the reader are separate places and Return opens the letter. If you want a split, that's a new decision against §14. I drew it DESIGN's way.
8. **The serif rule blurs.** "Serif = Aplos speaking" is clean for summaries and answers. But the `display` serif is also used for the welcome line, "You handled 12 emails" and "Aplos can't reach its mail engine". **Recommend** keeping the serif for welcome and sky moments (Aplos talking to you) and setting the fatal error in SF `heading`. An error is not a moment.
9. **The calendar rules need numbers (§7.8).**
   - "44 px minimum lanes" at the week view's ~153 px day width means three lanes of about 51 px, which are unreadable. **Recommend** that three or more concurrent events show the first lane plus a "+N" stack.
   - Event fills must be composited over the canvas (not transparent), or grid lines cross the text.
   - Events under 30 minutes need a one-line rule (title only).
   - DESIGN has no calendar legend or visibility toggles, so calendar colour is explained nowhere.
   - RSVP keys Y/M/N collide with M (Month). The mockups give Y/M/N priority only while an unanswered invite is open.
10. **Settings rules need small amendments (§7.10).**
    - "Each provider has Test and Remove": a key read from `GROQ_API_KEY` can't be removed in the app. Show Remove disabled with the reason, and "Add key" for providers that aren't set.
    - The 40 px rows only fit if every hint is one line. Say so.
11. **Later details (§7.3).**
    - Overdue can't be a drop target, since you can't reschedule into the past.
    - "This week" is not a time, so targets should name the time they resolve to ("Move to Tomorrow").
    - The picker's 1–5 digits are labels, not hover hints, and must always show.
12. **Status slot copy must be written for 2 short lines.** The 240 px sidebar fits about 28 characters per line. "Reading your newest mail · 24 of 50" wrapped mid-number until I split it. Sidebar counts should hide until the first window has synced.
13. **Hold only covers rows (§4.8).** When the last row of a section leaves, the section header disappears and everything below jumps. **Recommend** keeping headers (showing 0) until `hold` releases.
14. **Smaller items.**
    - DESIGN never says what surface the Ask dock is. I used the sky (canvas + hairline), following "only the letter is paper".
    - The sidebar puck colour is unspecified. I used ink at 8%, keeping the accent for list selection.
    - Microsoft is shown in onboarding, as you asked, though DESIGN hides it until a client ID exists.
    - The dark "sunrise" glow reads as fog; dark needs its own dawn tint.
    - Failure reasons set wholly in `--stamp-ink` are loud. Put the icon in stamp and the sentence in ink.
    - The post edge's "repeating every 36 px" is ambiguous: along the stripe or horizontally? I repeated it along the 45° axis.

## Values I had to invent

All of these are marked `INVENTED` in the source.

| Value | Where | Why |
|---|---|---|
| `--puck` ink 8 % (dark 9 %) | tokens.css | Sidebar selection colour; DESIGN names the puck, not its fill |
| Sky gradient direction: deep `#2a9afd` on top, `#67ccff` at the horizon | tokens.css | DESIGN gives the two colours, not the direction |
| `--skyscene-hill-far` (hill + 30 % white) and dark scene hills (hill mixed into the night sky) | tokens.css | A second hill for depth; the dark `--hill` read as a lit lawn |
| App icon colours (`--icon-*`) | tokens.css | Drawn in SVG for the mockups; a stand-in for the real icon asset |
| `--breathe-lo/hi/static` .75 / 1 / .85 on `--ink-2` | tokens.css | Replaces DESIGN's .55↔.85, which fails contrast (finding 2) |
| Sender columns 152 px (lists) and 140 px (Home); collapsed-message sender 136 px | tokens.css | Not given |
| Menu min-width 220, palette max-height 420, chip icon 14, small icon 12 | tokens.css | Not given |
| Status track 2 px (from §4.8 `status`), ProgressSegments bar 4 px | tokens.css | The segment bar height is not given |
| Switch 32 × 20 with a 16 px thumb, radio dot 5 px, app icon 72 px | tokens.css | Not given |
| Sidebar top 52 px; traffic lights at 20 / 18 px, 12 px | tokens.css | macOS hidden-inset geometry |
| Window corner 12 px, OS desktop backdrop, traffic-light colours | tokens.css | OS chrome, not app tokens |
| Dark `--elev-float` / `--elev-dialog` split as 30 % + 45 % and 40 % + 55 % | tokens.css | DESIGN says "shadows at 45 % / 55 %" without saying which layer |
| Dark `--press-lo` black 20 % | tokens.css | DESIGN gives the light press shade only |
| Motion distances (`--move-*`, `--flight-*`, `--post-*`) | tokens.css | Transcribed from the §4.8 table into tokens |
| `--hour` 60 px of grid per hour; grid shows 8 AM–8 PM | cal.css | Not given |
| `--today-tint` = `--sky` 8 % light / `--horizon` dark | cal.css | From §7.8, made a token |
| Provider status column 192, action column 128, address field 256 | settings.css | Not given |
| `--sheet-w` / `--sheet-h` for the ? sheet (three columns, fixed height) | shortcuts.html | DESIGN says "fixed height", no size |
| `--dawn` glow for the sync-complete sunrise | onboarding-sync.html | DESIGN says "the sky brightens once" |
| RSVP keys Y / M / N; "Move to Home" key H | calendar-event.html, done.html | Not in §8 |
| Date groups in All mail (Today, Yesterday, Earlier this week, Earlier in October) | inbox.html | DESIGN doesn't say whether lists are grouped by date |
