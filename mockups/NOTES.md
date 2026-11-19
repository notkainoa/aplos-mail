# Aplos mockups: notes

## In plain English

These are clickable pictures of the new Aplos, made so you can judge the look before any code is written. This is revision 2, made after your review. It is calmer and roomier. The background is gray, the content sits on one white panel, and colour only appears where it means something. The sky and the airmail stripe are gone.

Double-click `mockups/index.html`, or open https://aplos-mockups.vercel.app. The switch at the top right of the gallery sets light or dark, and every screen remembers it. Click a picture to open a screen at its real window size. The small bar at the bottom right of each screen switches state and theme.

On Home, try J and K to move, E for Done, L for Later and Z to undo. ⌘K opens commands, / opens Search, ? shows every key and Esc goes back. Hold ⌘ to see small key badges.

Start with three screens: Home, the reader and Compose. Then open the onboarding window. `DESIGN-CHANGES.md` lists every change to the design document. Section 11 records your answers: no app icon, no page titles, the calendar button back, the name "Paper" and account dots with two or more accounts.

## How this is built

- `tokens.css` holds every value. Pages use only its variables.
- `shell.css` and `shell.js` hold the gray shell, the white panes, the sidebar, the shared parts, the theme, the J/K lists, toasts and key routing.
- `home-view.js` draws Home, both on its own and behind overlays.
- `cal.css`/`cal.js` and `settings.css`/`settings.js` are shared by the calendar and settings pages.
- `node mockups/shoot.cjs [pages]` takes headless screenshots of every state in both themes, into the gitignored `mockups/_shots/`. It then checks each one for:
  - JavaScript errors
  - banned words and icons
  - more than one filled button
  - text under 11 px
  - text contrast under 4.5:1
- `HOVER=1` adds the layout-shift check: it hovers each control and fails if anything else moves.
- The last full run covered 30 pages, 82 states, 164 screenshots. It found 0 issues, including 0 layout shifts. I reviewed every state myself on light/dark contact sheets.
- Revision 2 was built in two steps. I rebuilt the tokens, the shell and the sidebar, Home, the reader, the inline reply and Compose. Four Sonnet subagents then brought the other pages up to those anchors, and I reviewed and fixed the result.

## What each screen exercises

| Screen (file) | States | What it shows (DESIGN-CHANGES.md section) |
|---|---|---|
| Welcome (`onboarding-welcome.html`) | – | Full-bleed paper window, one sans display line and one button, no icon, demo as a small top-right button (5.12, 11.1) |
| Connect an account (`onboarding-accounts.html`) | choose, typed, waiting, connected, icloud | Quiet provider rows with Microsoft shown, discovery, browser wait, iCloud app password (5.12) |
| AI provider (`onboarding-ai.html`) | groq, byok, local, consent | Groq by default, own key, a model on this Mac behind "More options", the consent card as the only card (5.12) |
| Permissions (`onboarding-permissions.html`) | default, granted | Microphone, notifications and log-in as quiet rows (5.12) |
| Try the keys (`onboarding-drill.html`) | step1, step3, done | The drill as a mode of the sync screen, with progress still visible (5.13) |
| Getting your mail (`onboarding-sync.html`) | progress, paused, ready, partial, failed | Neutral progress, honest Google slow-down, "Esc opens Aplos", calm ready check (5.13) |
| Home (`home.html`) | default, no-ai | Do now (ordered by due date and importance, Back from Later at its bottom), Important updates, Follow up, Low importance; 180 px focus card (12) |
| All mail (`inbox.html`) | default, bulk | Neutral cursor, no account dots, bulk bar in the pane header (5.4) |
| Later (`later.html`) | later, bookmarks, drag | Puck in the page head, drop targets named by time (9 #11) |
| Done (`done.html`) | – | The new Done place, H to move one back (5.11) |
| Later picker (`later-picker.html`) | default, calendar | Presets 1–5 always visible, date picker |
| Demo (`demo.html`) | – | Home with the demo account switcher |
| Reader (`reader.html`) | default, earlier, pending, no-ai | Sender line, big serif summary, one action row, the message, reply field. No rail (5.5) |
| Inline reply (`reply.html`) | reply, reply-all, dictating, sent | One reply card, the level meter, the neutral undo-send line (5.6, 5.7) |
| Compose (`compose.html`) | new, ai-draft, polish, follow-up | A page, not a sheet: To, a title-sized subject, the text, Send (5.8) |
| Ask (`ask.html`) | answer, empty, working, no-provider, today | The dock as a second pane, serif answers, one proposal card (5.9) |
| Palette (`palette.html`) | commands, filtered, confirm | Opaque ⌘K, Suggested and Go to first, Cancel as the default (5.10) |
| Search (`search.html`) | results, no-match | Search as a page with a heading-size field (5.10) |
| Shortcuts (`shortcuts.html`) | default, filtered | A calm three-column key list (6.2) |
| Empty states (`empty.html`) | inbox-zero, first-mail, no-accounts, drafts, trash, spam | Inbox zero with no sky, counts hidden during first sync (5.14) |
| Errors (`errors.html`) | reconnect, quota, offline, row-error, send-failed | The status slot, an inline row error, send failure in the new reader |
| Fatal (`fatal.html`) | – | Sans display error (3.2) |
| Toasts (`toasts.html`) | stack, pending, remind, offline | Opaque toasts |
| Calendar week, day, event (`calendar-*.html`) | default, overlap / default, empty / detail, rsvp | Big month title, mini month and calendar list in the sidebar, the "+N" stack, RSVP with nothing chosen (5.15) |
| Settings General, Accounts, AI, Keyboard (`settings-*.html`) | – / default, reconnect / default, testing / default, recording | Section titles, 48 px rows with descriptions, AI features first (5.16) |

## Revision 2 findings: what looked wrong once drawn, with fixes

1. **Fields are below 3:1 at rest.** Calm fields use a `--line-strong` ring (ink 14 %), which is about 1.4:1 against white. WCAG 1.4.11 asks for 3:1 on boundaries you need to see a control. The fields stay identifiable through their label, placeholder and hover step, and checkboxes, radios and switches keep 3:1. **Recommend:** accept this at rest, and switch fields to `--control-edge` under Increase Contrast, which tokens.css already does.
2. **Tooltip-only key hints are less discoverable.** Hiding hints until a 0.5 s tooltip costs some discovery. Holding ⌘ to show badges and the "Show all key hints" setting make up for it. **Recommend:** show a one-time "Hold ⌘ to see keys" toast on first launch.
3. **Inline reply scrolls the summary away.** Writing a reply scrolls the summary out of view. The pane header still says "Home 1 of 9". **Recommend:** once the summary is out of view, show the subject in the header crumb.
4. **The shortcut sheet can't fit 75 shortcuts at 28 px.** It scrolls about 90 px. Either accept that or add a fourth column.
5. **Onboarding headings jumped between states.** Vertically centring each step made headings jump when the content height changed. Steps are top-anchored now, and only Welcome is centred. Amend §7.11's `safe center` rule to say so.
6. **Dark calendar event times failed contrast.** `--dim` on the dark event tint was 4.4:1, so event times use `--ink-2` in dark. Mini-month days outside the month use `--dim`, because `--faint` failed.
7. **The calendar now-line crosses event text.** At 10:00 it runs over the Northwind Dental time. Notion does the same thing, and hiding the line behind events made it nearly invisible. Kept as drawn.
8. **"Reconnect" appears twice.** In the reconnect state it shows in both the status slot and the account menu. Each is a real place you'd look, so I kept both.
9. **The palette centres on the window, not the pane.** Notion does the same. On a 1440 px window the visual centre sits 116 px left of the pane's centre. Either is fine. Centring on the pane would feel slightly more anchored.
10. **The search field has no focus ring.** The Search page's heading-size field shows only a caret, because a ring around 24 px text looked heavy. **Recommend:** a 2 px accent underline under the field while focused, to keep a visible focus indicator.
11. **Done's hover action had to move.** The Done list keeps the "Done 9:41 AM" stamp in a fixed column and puts the hover action to its left, so the stamp is never covered. Add a stamp-column option to `ListRow`.
12. **Revision 1 finding 13 is still open.** Section headers on Home still vanish the moment their last row leaves. They should stay, showing 0, until `hold` releases.
13. **Notion Mail no longer exists.** Notion Mail shut down on September 22, 2026, so its principles came from Notion, Notion Calendar's desktop shot and Redakt. Nothing was copied.

### Revision 1 findings (kept for the record; DESIGN-CHANGES.md section 9 says what happened to each)

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

DESIGN.md never gave these values. Revision 2 changed many of them on purpose, and DESIGN-CHANGES.md sections 2–4 give the old and new values.

| Value | Where | Why |
|---|---|---|
| The neutral palette (`--shell`, `--canvas`, `--paper`, `--raised`, `--sunken`, ink ramp, dark equivalents) | tokens.css | The new direction; each text pair was checked numerically and headless |
| `--line` 9 %, `--line-strong` 14 %, `--hover` 4 %, `--press` 8 %, `--puck` 6 % (and dark steps) | tokens.css | Calmer hairlines and fills |
| Type scale line-heights and the 24 px heading, 30 px display, 21/31 summary | tokens.css | Room and hierarchy |
| `--shell-pad` 8, `--list-w` 720, `--reader-w` 640, `--sidebar-w` 232, `--gutter` 40, `--group-gap` 32, `--focus-letter` 180 | tokens.css | Layout |
| `--elev-pane`, `--elev-card`, opaque `--elev-float` | tokens.css | Light without glass |
| `--today-tint`, `--event-fill` 12 % / 20 % | tokens.css | Calendar |
| `--sender-w` 152, `--sender-w-home` 148, `--menu-min` 220, `--palette-max` 420, `--seg-h` 3, `--app-icon` 64, switch 30 × 18 | tokens.css | Sizes DESIGN doesn't give |
| `--hour` 56 px (8 AM–8 PM fits) | cal.css | Grid density |
| `--ctl-w` 208, `--prov-status-w` 128, `--prov-act-w` 128, `--addr-w` 256 | settings.css | Settings columns |
| `--sheet-w`, `--sheet-h`, `--keys-w` (from tokens) | shortcuts.html | Shortcut sheet size |
| `--check-size` 40 | onboarding-sync.html | The ready check |
| `--stamp-w` (from tokens) | done.html | The Done stamp column |
| RSVP keys Y/M/N, "Move to Home" key H | calendar-event.html, done.html | Not in DESIGN §8 |
| App icon colours (`--icon-*`) | tokens.css | Stand-in drawing of the current icon (an open decision) |
