# Amendments to plans/DESIGN.md, revision 2

These amendments come from the owner's review of the revision 1 mockups. They are drawn in `mockups/` (open `mockups/index.html`). Where an amendment conflicts with DESIGN.md, the amendment wins. Section numbers refer to DESIGN.md.

## In plain English

You liked the design system but said it needed to feel more beautiful. This pass makes Aplos quieter and roomier. The look now leans on Notion, Notion Calendar and Redakt. They share a few habits. The background is a light gray. The content sits on one white panel. Titles are big and simple, and very little else is on screen.

The blue sky backgrounds are gone everywhere. The only sky left is inside the app icon, which you see once on the welcome screen. The red and blue airmail stripe is gone from the whole app. Nothing replaces it. The type and the white space now give Aplos its look.

Colour is now rare. Ink blue marks the one main button, the selected row and unread mail. Green means Done, dusk blue means Later and red means a problem. Everything else is gray, black or white.

The text is larger, with more space between lines and between groups. There are fewer sizes and weights. AI summaries and Ask answers still use the letter-like serif. In the calmer layout the serif stands out even more, so we kept it.

The email reader shows four things. You see who it's from, the big summary, one row of buttons with Space on the main action, then the message. The side column of notes is gone. Replying opens a plain box under the message. Writing a new email opens a clean page with no stripe. The less common actions now sit behind the "⋯" button or in the ⌘K menu.

The sidebar has clear groups. The main places are at the top, mail folders sit under a quiet "Mail" label, and Settings is at the bottom. There is a new "Done" place. Hovering over a button never moves anything any more. An automatic test checks every screen for this.

Four things are still yours to decide. They are the app icon, the website stripe, the design system's name, and whether rows show which account they came from. Section 10 has the options.

---

## 1. Direction

1.1. **Replace the visual direction.** Skypaper's "paper on sky" becomes **"quiet paper"**: a neutral gray window shell, one white content pane floating 8 px inside it, and cards only for the thing in hand. The look takes its principles from Notion, Notion Calendar and Redakt. It borrows neutral surfaces, generous whitespace, strong typographic hierarchy, quiet chrome and few elements on screen. It never copies their assets, wording or layouts. (Notion Mail itself shut down on September 22, 2026, so only Notion and Notion Calendar were studied live.)

1.2. **Rewrite §2.2 (the story).** The icon still holds the story, but the UI no longer illustrates it. Remove the rows **Sky**, **The striped border** and **The wind** from the table. **Paper**, **Hill green** (Done), **Dusk blue** (Later), **Ink blue** (the one action colour) and **the serif voice** stay.

1.3. **Remove §2.4 (the post edge) completely.** The post edge never appears in the app: not on the composer, the inline reply or the undo-send tray. No other pattern replaces it. Delete the `PostEdge` component, the `--post-red` and `--post-blue` tokens, and the `post` and `drain` motions (see 6.3). The website is out of scope here and is decision 10.2.

1.4. **Rewrite §7.16 (sky moments).** All four sky moments are removed:
- the onboarding sky
- first-sync `sunrise`
- the Home-empty sky
- the 320 px horizon tint

Delete `SkyScene`, `--horizon` and `--sky`. **What stays:** the app icon on the onboarding Welcome step is the only sky in the product. That is one small, deliberate moment.

1.5. **Rewrite §3 (principles):**
- Principle 1 becomes "Content sits on one white pane. Cards are only for the thing in hand."
- Principle 10 becomes "No decoration. Type and space carry the identity."
- Add principle 11: "Hovering never moves anything."
- Add principle 12: "Fewer things on screen. Secondary actions live in ⋯ and ⌘K."

1.6. **Update §2.3 (the not-Avec test).**
- Check 1 stays: the shell `#f5f5f6` and night shell `#121314` both have Lab b* slightly below 0.
- Check 5 gains "no decorative pattern (stripes, gradients, illustrated scenes) anywhere in the app UI".
- Checks 2–4 and 6–7 are unchanged. For check 7, replace "margin rail on the right" with "single reading column".

## 2. Colour tokens (§4.1), old → new

| Token | Light old → new | Dark old → new | Note |
|---|---|---|---|
| `--shell` (new) | → `#f5f5f6` | → `#121314` | Window background; the sidebar sits on it |
| `--canvas` | `#e9edf0` → `#ffffff` | `#0b1219` → `#191a1c` | Now the white pane that lists, the reader and settings sit on |
| `--paper` | `#fefefc` → `#ffffff` | `#141c25` → `#1f2023` | Cards on the pane (focus letter, dialogs, menus, composer card) |
| `--raised` | `#f3f5f7` → `#f6f6f7` | `#1b2530` → `#212225` | Quiet fills: low-importance band, chips, attachments |
| `--sunken` | `#e1e6eb` → `#efeff1` | `#070c11` → `#0e0f10` | Keycaps, segmented tracks |
| `--sidebar` | `#e2e8ee` → removed | `#080e14` → removed | The sidebar is transparent on `--shell` |
| `--horizon`, `--sky` | removed | removed | No sky (1.4) |
| `--ink` | `#121820` → `#1d1e21` | `#e7ecf1` → `#ececed` | Hueless instead of blue-tinted |
| `--ink-2` | `#2f3a46` → `#46484d` | `#c4ccd5` → `#c4c5c9` | |
| `--dim` | `#56616d` → `#63666c` | `#97a3af` → `#9a9da4` | ≥ 5.0:1 on every light surface, ≥ 5.1:1 dark |
| `--faint` | `#7d8792` → `#8f9298` | `#75818e` → `#6f7278` | Non-text only |
| `--line` | ink 14 % → ink 9 % | ink 12 % → ink 8 % | Calmer hairlines |
| `--line-strong` (new) | → ink 14 % | → ink 12 % | Card and field rings |
| `--control-edge` | ink 50 % → ink 48 % | ink 45 % → ink 40 % | Checkbox, radio, switch-off only; fields use `--line-strong` with a hover step |
| `--accent` | `#0b5394` (same) | `#88aee0` (same) | Used for: the one filled button, focus ring, cursor bar, unread dot, links |
| `--accent-wash` | accent 10 % → 8 % | accent 16 % → 12 % | Bulk-picked rows only; the keyboard cursor is now neutral (5.4) |
| `--hill`, `--dusk`, `--stamp`, `--stamp-ink` | unchanged | unchanged | |
| `--stamp-tint` | 10 % → 8 % | 14 % → 12 % | |
| `--hover` / `--press` | ink 5 / 9 % → 4 / 8 % | 6 / 11 % → 5 / 10 % | |
| `--puck` | ink 8 % → 6 % | 9 % → 8 % | Sidebar selection and keyboard cursor |
| `--scrim` | ink 24 % → 18 % | black 48 % → 50 % | |
| `--today-tint` (new) | → accent 4 % | → accent 6 % | Calendar's today column |
| `--event-fill` | 16 % → 12 % | 26 % → 20 % | Composited over `--canvas`, never transparent |
| `--post-red`, `--post-blue` | removed | removed | 1.3 |

Contrast was rechecked headless on every screen (82 states × 2 themes), and every text pair passes 4.5:1. Two fixes were needed beyond the table above: calendar event times in dark use `--ink-2`, and the mini month's out-of-month days use `--dim`.

## 3. Type (§4.3), old → new

| Role | Old | New | Use |
|---|---|---|---|
| `caption` | 11/14 500 | **11/16** 500 | Keycaps, chips |
| `small` | 12/16 | **12/18** | Metadata, section labels (always `--dim`) |
| `ui` | 13/18 | **13/20** | Sidebar, buttons, menus |
| `base` | 14/20 | **14/22** | Rows, settings, fields |
| `read` | 15/24, 68ch | **15/26, 64ch** | Message bodies |
| `title` | 16/22 600 | **15/22 600** | Card and dialog titles, the reader's sender |
| `heading` | 20/26 600 | **24/32 600**, −0.5 px | **Page titles, now inside the content** ("Home", "All mail", "October 2026", "AI") |
| `display` | 28/34 **Newsreader** | **30/38 SF 600**, −0.7 px | Onboarding, inbox zero, fatal error. **Sans now.** |
| `summary` | 20/28 Newsreader 440 | **21/31** Newsreader 430 (dark 410) | The big summary on Home and in the reader |
| `answer` | 16/25 Newsreader | **16/27** Newsreader | Ask answers |

3.1. **Rules:**
- **Weights:** SF uses 400, 500 and 600 only. Read rows are 400; unread senders are 600.
- **Metadata:** always `small` + `--dim`.
- **Group spacing:** `--group-gap` 32 px between list sections and settings groups.

3.2. **Serif decision: keep it, only for AI-written text** (summaries and Ask answers). In the calmer neutral layout the serif is the clearest identity mark and reads well at 21/31. `display` moves to sans, which resolves revision 1 finding 8. The serif gate (one-day look test) still applies.

3.3. **Removed:** the Home "ink-ramp" distance fade (§4.1 rule). Hierarchy now comes from read/unread weight and colour. Revision 1 found the fade inverted the hierarchy.

## 4. Spacing, layout, radius, elevation (§4.4–4.6)

4.1. **Layout at 1440 × 900:**

| Region | Old | New |
|---|---|---|
| Sidebar | 240 | 232, transparent on `--shell` |
| Pane | n/a | Inset 8 px (`--shell-pad`) on top, right and bottom; radius 12; `--elev-pane` |
| Pane header (was toolbar) | 48 | 48. Holds only back/close, a quiet crumb, two or three icon tools, and Ask |
| Page title block | none | `.page-head`: 24 px top padding, title, a `small --dim` subtitle, 24 px below |
| List column | 820 | **720** (`--list-w`) |
| Reader | 760 paper + 32 + 240 rail | **640 single column** (`--reader-w`), no paper card, no rail |
| Composer | 680 sheet | 640 column, as a page in the pane |
| Ask dock | 360 column | 360 **second pane**, 8 px from the main pane |
| Settings | 200 nav + 640 | 180 nav + 600 |
| Gutter | clamp(16, 2.2vw, 32) | 40 |
| Focus letter (default density) | 160 | **180** (roomy 196, compact 164) |

4.2. **Radius:** `lg` 14 → **12**, `xl` 20 → **16**. `xs` 4, `sm` 6 and `md` 8 are unchanged. No other radii.

4.3. **Elevation:**
- **Glass:** removed. Menus, popovers, toasts and the palette are opaque `--paper` with `--elev-float`. Reduce Transparency no longer changes anything.
- **New levels:** `--elev-pane` (hairline plus a 1 px shadow) and `--elev-card` (a stronger ring and a soft 20 px shadow).
- **Dark mode:** keeps the 4 % top sheen on cards.

4.4. **Icons:** 16 px everywhere, 14 px in chips and status lines, 1.5 px stroke. Section 4.7's banned-glyph list is unchanged.

## 5. Structure

5.1. **Shell (§7.1).**
- The gray shell holds the sidebar and one or two white panes.
- **Compose, Search and Today leave the toolbar.**
  - Compose is the pencil next to the account switcher.
  - Search is the first sidebar item.
  - Today lives in the Ask dock.
- Pane header: on deeper views, back or close plus a crumb, for example "Home 1 of 9". On the right, at most three icon tools, then Ask.
- The header gains a hairline only after content scrolls under it.

5.2. **Sidebar, regrouped:**
- Top: the account switcher (a monogram plus name) and the compose pencil.
- First group, no header: **Search, Home, Later, Calendar**.
- A quiet `small --dim` header **"Mail"**: **All mail, Done, Drafts, Sent, Spam, Trash**.
- Footer: the status slot, **Settings** and **Help** as normal rows.
- On Calendar, a mini month and a **"Calendars"** group with colour swatches appear under the groups. This fixes revision 1's missing calendar legend.
- Rows are 28 px with no gaps between them, and groups are 20 px apart.
- There are no "Needs reply" or "Awaiting reply" places. Reply work lives on Home.
- Counts: Home 9, Later 9, Drafts 1. They hide during first sync.

5.3. **Home (§7.2).**
- Page title "Home" with "Thursday, October 29 · 9 to handle".
- Focus letter actions:
  - the filled suggestion with its Space key
  - Later and Done as text buttons
  - one ⋯ for bookmark, trash and why it's here
- The bookmark icon button is gone from the card.
- "Go one by one" and "Clear from Home" are quiet `--dim` text buttons.

5.4. **Lists (§7.4).**
- Read rows are a 400 `--ink-2` sender and a `--dim` summary. Unread rows are a 600 `--ink` sender and an `--ink-2` summary, plus the dot.
- **The keyboard cursor is neutral.** It is a `--puck` fill plus the 2 px accent bar. `--accent-wash` is only for bulk-picked rows.
- **Rows don't show the account colour dot.** Colour stays rare, and the account appears in the row tooltip and the reader. This is open decision 10.4.
- Page titles: "All mail" with "214 emails · 4 unread".

5.5. **Reader (§7.5), simplified. This reverses decision 12 (margin rail).** One 640 px column, top to bottom:
1. **Sender line.** The name in `title`, "to you and Mina Cho" in dim, and on the right a due chip, if any, plus the time. There is no monogram. Hovering the name shows the address and the history.
2. **The big serif summary.** Hovering it shows "Summary by Groq".
3. **One action row.** The filled suggestion (`Reply · Space`), then Later and Done as text buttons.
4. **The thread.**
   - A dim line with the subject and message count.
   - Earlier messages collapse into one line ("3 earlier messages from Jordan, you and Mina"); O expands it.
   - The latest message has its header and a 15/26 body, then attachments.
5. **A quiet "Reply to Jordan…" field** with an R keycap.

Removed from the reader:
- the margin rail (due date, plan, attachments count, Why, sender history)
- the flap
- the top-right bookmark and trash icons
- the "Important" control

These move to ⋯ (bookmark, trash, forward, why it's here) and ⌘K. "Add to calendar" for a plan becomes the Space suggestion when it's the right next step. The pane header shows previous/next, ⋯ and Ask.

5.6. **Inline reply (§7.6).** A single card under the message, with:
- the To line and its recipients, plus Cc and Pop out on the right
- the text in `read`
- Send with ⌘↩, "Draft saved", and attach and ⋯ on the right

There is no post edge. While the reply is open, the composer owns the filled button and the summary's Reply becomes a text button. Dictation shows a small `--stamp` level meter and one line, "Listening. Release R to keep, Esc to cancel."

5.7. **Undo send (§6 `UndoTray`).** A `--raised` line under the sent message: "Sending to Jordan in 8 s · Undo Z · Send now". A neutral 2 px bar drains along its bottom, and it is static under reduced motion. This replaces the draining post edge.

5.8. **Compose (§7.6).** A page in the pane, not a floating sheet:
- **Header:** close (Esc), "New message", then ⋯ (send from, schedule, discard) and Ask.
- **Body:** a To row, then the subject as a 24/32 title-sized field, then the text in `read`.
- **Footer:** a hairline, Send with ⌘↩, "Draft saved", then attach and format.

The From row is removed (it's in ⋯). Nothing decorates the top. The AI draft is dim text, with the line "The grey sentence is a suggestion. Tab keep, Esc dismiss." Polish is a quiet bar ("Polish suggests 3 changes. Yours stays until you choose.") with an inline diff.

5.9. **Ask (§7.7).**
- The dock is a second pane with an Ask | Today segmented control and a close button. There is no glyph in the header.
- Questions are `base` 500 with no rule bar.
- Answers are serif. The proposal card is the one card and owns the filled button.

5.10. **Search and palette (§7.9).**
- **Search is a page, not an overlay.** It has its own sidebar item, the field is the page title (heading size), operator tokens sit below it, and results are ordinary rows with "Search all mail on Google · Return" under them.
- **⌘K is the only overlay.** It is opaque, centred, and has a light scrim. On first open it shows Suggested and Go to; everything else appears as you type.
- 1–9 picks work only while the field is empty.
- The destructive confirm defaults to Cancel: Return cancels, ⇧Return deletes.

5.11. **Done (new place).** Its page title is "Done", with the subtitle "Mail you finished. Press H to move one back to Home."
- Rows show "Done 9:41 AM".
- The only hover action is an icon-only "Move to Home" (H) that never covers the stamp.
- E and L are inactive on done rows.
- Add the `in:done` operator to §7.9 and "Move to Home, H" to §8.

5.12. **Onboarding (§7.11, plan 30 decision 10).**
- The window is full-bleed white paper: no sheet, no sky, no hills.
- The 48 px top strip holds the traffic lights and "Try demo mail".
- Steps sit top-anchored in a 64 px side margin. Welcome alone is centred.
- Footer: step dashes, "Setup continues in the background.", then buttons.
- Step titles are sans `heading`, and Welcome uses sans `display` plus the app icon.
- More than about six controls on a step go behind "More options".

5.13. **First sync (§7.12).**
- Segments are neutral: done is `--ink-2`, paused is `--dusk`, failed is `--stamp`.
- When a step shows "n of 50", the motion sits on the checklist marker, not the bar.
- The screen says "Esc opens Aplos", and Esc always enters Aplos from this screen.
- The key drill is a mode of this screen, so the progress stays visible.
- Ready is a drawn check and "Your mail is ready". There is no sunrise.
- Failure reasons show the icon in `--stamp-ink` and the sentence in ink.

5.14. **Empty and error states (§7.14–7.15).**
- Inbox zero is a calm centred block in the pane: the display line "You handled 12 emails.", then "Next: Design review at 2:00 PM" in dim, then "Undo last · Z".
- The fatal error uses sans `display`.
- Sidebar counts hide while first sync runs.

5.15. **Calendar (§7.8).**
- The page title is "October 2026" with the day range under it. Today, previous/next and D | W | M sit on the right of the title row.
- The grid uses `--line` hairlines. Today's column gets `--today-tint` and a filled accent date badge.
- Events under 30 minutes are one line, title only.
- Three or more overlapping events show the first lane plus a "+N" stack.
- RSVP starts with nothing chosen, and "Send reply" stays disabled until you choose. Y/M/N only work while the invite is open.

5.16. **Settings (§7.10).**
- Each section has a page title and subtitle, and groups are 32 px apart.
- Rows are 40 px, or 48 px with a one-line description, with hairline separators and a fixed control column.
- On the AI page, the Features table (Ask, Summaries, Drafts, Plans, Voice) comes first. Providers are split into hosted and "On this Mac and custom".
- Env-sourced keys show Remove as disabled, with the reason in a tooltip. Unset providers show "Add key".
- The privacy text sits behind a "How your mail is used" disclosure.

## 6. Interaction and motion

6.1. **New rule: hovering never changes layout** (add to §5 and §11).
- Hover never reveals an inline keycap. Key hints appear in the tooltip (label plus keys, an overlay), and holding ⌘ overlays small key badges.
- The "Show all key hints" setting shows hints inline permanently. It's a mode, so the layout stays stable while you work.
- Row hover actions overlay the date column and never reflow the row.
- **Enforced:** `HOVER=1 node mockups/shoot.cjs` hovers up to 90 interactive elements per page and fails if any other box moves by more than 0.5 px. Add the same check to the §12.5 harness. It passes on all 30 pages.

6.2. **Decision 8 amended.** Keycaps no longer appear "on hover". They appear in tooltips, as ⌘-held badges, or with the setting. Primary actions still show their key: Space in the mail window, Return in onboarding and dialogs, ⌘↩ on Send.

6.3. **Motions.**
- Remove `post` and `drain` (post edge), `sunrise`, `breathe`'s `--dim` variant, and `slide` for D/W/M if it moves width.
- Add `undo-send` (8 s linear drain of a neutral bar).
- `breathe` is now `--ink-2` at .75↔1, static at .85 (revision 1 finding 2).
- Sending shows the composer closing, then the message `arrive`s in its thread.
- `flight` and `commit` are unchanged, including the carried-off signature on Home and in the reader.

6.4. **One filled button per screen, and the topmost surface owns it.** Add this to §4.6. With a composer, palette, dialog or proposal card up, the screen behind it demotes its suggestion to a text button.

## 7. Components (§6)

7.1. **Removed:**
- `PostEdge`, `SkyScene`, `MarginRail`/`Notes`, `Flap`
- the glass `--elev-float` material
- the reader's `Avatar` monogram
- `Letterhead` (replaced by `ReaderHead`)

7.2. **New:**
- `Pane` (white surface with `--elev-pane`)
- `PageHead` (title, subtitle, actions)
- `ReaderHead` (sender line, summary, action row)
- `EarlierMessages` (one collapsed line)
- `ReplyStub` (the quiet "Reply to …" field)
- `MiniMonth` and `CalendarList` (sidebar on Calendar)
- `NavHead` (quiet sidebar group label)

7.3. **Changed:**
- `Toast`, `Menu`, `Popover` and `Palette` are opaque.
- `UndoTray` uses the neutral drain.
- `Kbd` is no longer revealed on hover.
- `Chip` has a `--raised` fill instead of a ring; overdue chips use `--stamp-tint`.

## 8. Lint and CI (§12)

8.1. **Ban list (§12.2):** add `repeating-linear-gradient` and `linear-gradient` in app CSS (the website is excluded until 10.2 is decided), `backdrop-filter`, and the class names `post-edge`, `airmail`, `skyscene`.

8.2. **Harness (§12.5):** add the hover-shift check from 6.1. Replace the "Not-Avec" margin-rail assertion with "single reading column".

8.3. **Contrast pairs (§12.4):** regenerate from section 2. Add `--dim` on `--accent-wash`, `--dim` on dark event tint (use `--ink-2` there), and mini-month out-of-month days.

## 9. Revision 1 findings (mockups/NOTES.md) and what happened to each

| # | Finding | Outcome |
|---|---|---|
| 1 | Sky moments too loud | **Superseded and applied harder:** all sky removed (1.4) |
| 2 | Three contrast failures (breathe, disabled text, ramp fade) | **Applied:** breathe on `--ink-2`, disabled text `--dim`, fade removed (3.3) |
| 3 | Search is both overlay and list; palette digits; destructive Return | **Applied** (5.10) |
| 4 | Onboarding geometry; sync Esc; drill placement; status motion | **Superseded** by full-bleed paper (5.12); sync rules **applied** (5.13) |
| 5 | Filled-button collisions; composer elevation; reply crowding | **Applied:** topmost owns the filled button (6.4); compose is a page (5.8); reply is one card (5.6) |
| 6 | No Done view | **Applied:** Done place (5.11) |
| 7 | No split view | **Kept:** list and reader stay separate (§14 bans the split) |
| 8 | Serif used for non-AI lines | **Applied:** display is sans (3.2) |
| 9 | Calendar numbers (lanes, fills, short events, legend, RSVP keys) | **Applied** (5.15, 5.2) |
| 10 | Settings (env keys, row height) | **Applied** (5.16) |
| 11 | Later drag targets and picker digits | **Applied:** targets named by time, Overdue not a target, digits always visible |
| 12 | Status copy in two short lines; counts during sync | **Applied** (5.2, 5.14) |
| 13 | Section headers vanish during `hold` | **Not yet drawn.** Still recommended: keep headers, showing 0, until `hold` releases |
| 14 | Smaller items | Dock surface → second pane (5.9). Puck colour → `--puck`. Microsoft shown. Dawn glow → removed. Failure text → icon only in red (5.13). Post-edge rhythm → moot (1.3) |

## 10. Decisions for the owner

| # | Question | Options | Recommended | What happens |
|---|---|---|---|---|
| 10.1 | **The app icon** still shows a striped airmail envelope in a sky. | (a) Keep the icon as is; (b) keep the sky and the hill but make the letter a plain white sheet with no stripes; (c) a new, quieter icon: a white letter on a soft neutral or ink-blue square, no scene | **(b)** | (a) The icon and the app now tell different stories, and the stripe you dislike stays on your Dock. (b) Keeps the icon you know and its sky, drops the stripe, and matches the app. (c) Fully matches the new calm look but loses the icon's recognition and story. |
| 10.2 | **The website** uses the stripe: `apps/web/src/Chrome.tsx:5-7` (`Airmail`, used at `:40`), `Landing.tsx:2,20`, `Download.tsx:3,63`, `Privacy.tsx:1,8`, and `styles.css:91-99` (the scrolling stripe) plus `:461`. The DMG background has it too: `apps/desktop/build/dmg-background.html:21`. The Landing hero alt text says "an airmail envelope" (`Landing.tsx:34`). | (a) Remove the stripe from the site and the DMG now; (b) leave the site until the icon decision | **(a)** | (a) The site matches the app and the "checker" look goes everywhere at once. (b) The site keeps the look you said you hate. |
| 10.3 | **The design system's name.** "Skypaper" no longer fits now the sky is gone. | (a) Rename to "Paper"; (b) keep "Skypaper" internally | **(a)** | It's never user-visible either way; (a) just stops the name from pulling agents back toward a sky. |
| 10.4 | **Account colour on rows.** Rows no longer show a coloured dot for the account. | (a) Hidden; the account shows in the tooltip and reader; (b) show the dot only when two or more accounts are connected | **(a)** | (a) is calmest. (b) helps if you often need to tell accounts apart at a glance. |

## 11. Revision 2b: the owner's answers and follow-ups (these win over sections 1–10)

11.1. **The app icon is dropped from the app** (decision 10.1). The owner dislikes the current icon. It no longer appears anywhere in the UI, including onboarding Welcome. There is no sky left in the product at all. A new logo comes later. Until then, Welcome is one line, one sentence and one button.

11.2. **The website will be fully redesigned later** with the new logo (decision 10.2). For now, leave `apps/web` and `apps/desktop/build/dmg-background.html` alone. The stripe list in 10.2 is the starting inventory for that redesign.

11.3. **The design system is named "Paper"** (decision 10.3). Rename Skypaper in DESIGN.md, the `aplos-design` skill and the token comments. "Quiet paper" in 1.1 is just a description.

11.4. **Account dots show on rows when two or more accounts are connected** (decision 10.4, option b). This replaces 5.4's "rows don't show the account colour dot". With one account they're hidden.

11.5. **No page titles.** This replaces the page-title parts of 3 (the `heading` role's use), 4.1 ("Page title block"), 5.3, 5.4, 5.11 and 5.16.
- Home, lists, Later, Done, Search, Settings and the rest have no big title and no subtitle. The sidebar already says where you are, and the reader's pane header keeps its small crumb ("Home 1 of 9").
- **The section labels do the job instead.** "New", "Due now", "Waiting on others", the date groups in All mail and Done, and the settings group labels are now `ui` 13/20 at 600 in `--ink`, with the count in `--dim`. Before, they were `small` 12 at 500 in `--dim`.
- Groups stay 32 px apart, and the first label sits 12 px below the pane header.
- Page-level controls stay where the title used to be, on the right: Later's Later | Bookmarks switch, Search's field, and the calendar's Today, previous/next and D | W | M.
- The calendar keeps its date ("October 2026") as a small `title` label (15/22, 600), because there it is information, not a heading.
- The `heading` role (24/32) is now only used for the compose subject and the search field. `.page-head` keeps its name as the row for page controls.

11.6. **The calendar button is back** at the top right of the main pane, after Ask. It shows a calendar icon, and its tooltip reads "Today, ⇧A". It opens the Today tab of the Ask dock. This replaces the "Today leaves the toolbar" line in 5.1.

11.7. **Home ordering.** Replaced by section 12.

## 12. Home, revision 3: Do now, Important updates, Follow up (the owner's design; replaces §7.2's sections and ARCH §8.2's ordering)

### In plain English

Home now sorts mail by what it asks of you.

**Do now** is mail that needs you to do something, like reply, decide, sign, pay or reschedule. It's sorted by how soon it's due, and the more important one goes first when two are due on the same day. Things you set aside with Later come back at the bottom of Do now once their day arrives.

**Important updates** is mail you should see but don't have to act on, like "your package was delivered". If an email has a clear action, such as "your dinner reservation was canceled, reschedule?", it goes to Do now instead.

**Follow up** (the old "Waiting on others") is mail you sent that hasn't had a reply. Aplos drafts a short follow-up for each one, so pressing Space opens a reply that's already written. You read it, change it if you want, and send.

Everything else, including newsletters, receipts and routine alerts such as Google's "new sign-in" emails, stays folded into the Low importance line. Follow up comes last, under it.

The test for each email is simple. If you'd want to respond, it's Do now. If you only need to see it, it's Important updates. If you don't need to see it at all, it's Low importance. The number next to Home counts Do now and Important updates.

### 12.1 Sections, top to bottom

| Section | What goes in it | Space does | Order inside |
|---|---|---|---|
| **Do now** | New mail with a clear action for you: a direct question or request, a decision, something to sign, pay, approve, confirm, book or reschedule, an invitation to answer. Example: "Your Saturday table was canceled. Pick another night." | The suggested action (Reply, View invoice, Reschedule, Add to calendar…) | 12.2 |
| ↳ **Back from Later** (sub-label inside Do now) | Later items whose date has arrived (was "Due now"). Always at the bottom of Do now. Its label carries "Clear from Home". | The item's suggested action | 12.2, within this block |
| **Important updates** | Mail worth seeing with no clear action: a delivery that arrived, a person sharing something "for your information", a decision that affects you, a payment that will happen by itself | Done (it's read and handled) | Important first, then newest |
| **Low importance** (the one-line band) | Newsletters, promotions, receipts, routine notifications, security alerts such as "New sign-in on your Mac", shipping progress ("on its way"), and replies that only close a conversation ("Of course!" after your thanks) | Return opens the sheet | Unchanged |
| **Follow up** (last) | Mail you sent with no reply after the nudge period (3 days default) (was "Waiting on others") | **Reply with a nudge**: opens the reply with an AI-drafted follow-up as an editable suggestion (Tab keep, Esc dismiss) | Longest wait first |

- The focus letter starts on the first item of Do now. Tab and ⇧Tab move between Do now, Important updates and Follow up.
- Section order: Do now, Important updates, Low importance, Follow up.
- Done on a Follow up item offers "Remind me if no reply · R" (decision 6 is unchanged).
- The sidebar count on Home is **Do now plus Important updates** (14 in the mockup).
- If a section is empty it doesn't render. If Do now is empty and the rest isn't, Home starts at Important updates.

### 12.2 Ordering inside Do now

1. **Due band:** overdue or due today, then due tomorrow, then due within 7 days, then due later or no due date.
2. **Within a band:** important before normal.
3. **Then** the soonest due date.
4. **Then** the newest received.

The "Back from Later" block uses the same order, below the new items. Rows in Do now show their due date as a quiet chip ("Tomorrow", "Sat", "Nov 4"), so the order is readable. Overdue chips use `--stamp-ink`. Undated rows show no chip.

The order stays still under the cursor (holds, §5 rule 6). New mail and re-ranks wait under `hold`, then `arrive`.

### 12.3 How mail is sorted into sections

**The owner's rule decides every case.** If the user should respond, it goes in Do now. If they need to see it, it goes in Important updates. If it's rhetoric they don't need to see, it goes in Low importance. That makes the decision about the conversation, not the sender:
- "Thanks for covering Saturday" sent to you goes in **Do now**, because you'd reply "of course".
- If you thanked them and they answered "Of course!" with nothing else to answer, it goes in **Low importance**.
- A person's mail is never sent to Low just for being from a person, or kept out of it just for being from a person.


- Each thread gets a **lane** (`do`, `update`, `low`) and keeps its **importance** (`important`, `normal`) for ordering. Follow up is computed, not stored: you sent the last message, and there's been no reply for the nudge period.
- **Without AI, at ingest** (ARCH §8.2's signals, re-aimed):
  - **Low:** List-Unsubscribe, bulk or auto-submitted, no-reply senders, Gmail Promotions and Social, account and security notices.
  - **Update:** transactional mail with a final state, for example "delivered", "your payment is scheduled", "minutes posted". Use sender patterns and Gmail Updates, where structured delivery markup exists.
  - **Do:** direct-to-me mail from people, especially known correspondents; mail that asks a question or names a deadline; calendar invitations; bills and documents with a due date.
  - When unsure, a person's mail goes to Do and automated mail goes to Low. That's a safe default until AI (or you) can apply the rule above. A reply that only closes a thread you ended (thanks, of course, sounds good, with no question) can be caught without AI by length and the absence of a question, and sent to Low.
- **With AI:** the summary job also returns the lane, a due date it found in the text ("by tomorrow", "until Saturday"), and the suggested action. It may move a thread between lanes. Rules and your corrections always win.
- **Corrections are one key each.** ⌥↓ moves a thread down a lane (Do now → Important updates → Low importance). ⌥↑ moves it up. Both offer "Always do this for [sender]" and toast with Undo. This replaces "Not important" and "Always Home" (§7.5, §8).
- **Due dates on Do now items come from three places.** In order of trust, they are your own date (D), dates in structured data (invites, bills), and an AI-extracted date. An extracted date shows as "Due tomorrow" with "from the email" on hover, so it's never mistaken for one you set.

### 12.4 The follow-up draft

- Follow up sits last on Home, below the Low importance line.
- When a thread enters Follow up, a background job writes a short, polite nudge in the user's voice, referring to the last message. It's a local suggestion, not a synced draft, until you keep it. Consent and the daily AI cap apply as usual (ARCH §8.3–8.4).
- Space opens the reply with the suggestion in the body (dim, "Aplos drafted this follow-up from your last email. Tab keep, Esc dismiss").
- With AI off or not consented, Space opens an empty reply with "Re:" filled in, and there's no error.
- **Drawn in:** `compose.html?state=follow-up`. In the app this opens as the inline reply in the thread (5.6). The mockup uses the compose page as a stand-in.

### 12.5 Changes this needs in the other plans (for the plan threads)

- **ARCHITECTURE §3 schema:** `thread_workflow.rank_bucket` becomes `lane` (`do|update|low`) plus `importance` (`important|normal`) and `rank_source`. `due_date` gains `due_source` (`user|structured|ai`). The `home` index becomes `(status, lane, due_band, importance, due_date, last_date DESC)`.
- **ARCHITECTURE §8.2 and plan 10 E5:** `bucketFor` becomes `laneFor`, returning `{lane, importance, due?}`. The planned 60-case header table gains Update cases (deliveries, scheduled payments, FYI from people) and the security-notice → Low cases.
- **ARCHITECTURE §8.1:** add a background job, `followup:<thread>:<last_sent_hash>`, after summaries in priority.
- **Plan 30 §4.1 view spec:** `home` sections become `do` (with a `fromLater` flag), `update`, `home.low`, then `follow`, ordered as 12.2. The Home folder count is `do` plus `update`.
- **DESIGN §7.2, §7.5 (Why rail text), §8 (⌥↑/⌥↓), §10 (labels):** add "Do now", "Back from Later", "Important updates", "Follow up" and "Reply with a nudge". Remove "New", "Due now" and "Waiting on others".

### 12.6 Settled by the owner

1. **Section order:** Do now, Important updates, Low importance, then Follow up last.
2. **A person's mail with no action:** use the respond, see or skip rule in 12.3. A thank-you you'd answer goes in Do now. A reply that only closes the conversation goes in Low.
3. **The Home count:** Do now plus Important updates.
