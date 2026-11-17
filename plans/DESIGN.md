# Aplos design language and UX spec: Paper

Definitive design spec for the Aplos Mail revamp, on branch `revamp`. Written 2026-10-27 by the design director and revised the same day to fold in the owner's review of the HTML mockups (revisions 2, 2b and 3). This document describes the current design and is the single source of truth for it. This is a plan. It contains no code, nothing in it goes to main, and PR #21 stays unmerged.

**Visual reference.** The HTML mockups in `mockups/` are the visual target for every screen. Open `mockups/index.html`; `mockups/NOTES.md` explains the pages and the headless checks (`node mockups/shoot.cjs`, plus `HOVER=1` for the layout-shift check). Each screen in §7 names its mockup files and states. This document wins on rules, numbers and copy. The mockups win on arrangement and feel wherever this document is silent. `mockups/tokens.css` matches §4, apart from three leftovers that `tokens.json` must not carry over: the `--app-icon` and `--icon-*` values (the icon is not in the app), the unused `--dur-send`, and the comment that still calls `heading` the page-title role.

**Inputs.** Three proposals: `plans/proposals/design-skypaper.md`, `design-tactile.md` (Carried) and `design-precision.md` (Instrument). The GLM judge scorecard is `plans/_council/judge-design-glm.md`. The owner's review of the mockups: `mockups/DESIGN-CHANGES.md` (the change list for revisions 2, 2b and 3, now folded in here and kept only as history) and `mockups/NOTES.md` (what looked wrong once drawn). Research: `research/email-clients/SYNTH-ui.md`, `research/email-clients/ui/*.md`, `research/email-clients/gaps/identity-collision-audit.md` and `research/pr21-onboarding-review.md`. Screenshots are in `/Users/knewton/.t3/aplos-research/ui/`. I viewed `aplos-baseline/{home-light,home-dark,reader-light,welcome-start-light}`, `avec/desktop-preview/seg/{t0174.2,t0176.3}`, `avec/desktop-preview/dense-done-arrow`, `tatem/{hero-mock-flat-gradient,keyboard-overlays}`, `redakt/inbox-desktop-dark` and `identity-audit/icon-compare`. I re-read the source at `apps/desktop/src` (worktree at 27cf52f, the same renderer as v0.2.3) to give the file:line references in section 13.

**Evidence key.** **[V]** means verified in a file, a screenshot or a computation, with the path given. **[I]** means a design judgement. Contrast ratios and Lab values for the Paper tokens were computed with `/tmp/paper-design/c.py` and agree with the mockups' headless check (82 states in both themes, no text pair under 4.5:1, `mockups/NOTES.md`). Colour distances (ΔE00) for the accent and status colours were computed for revision 1 with `/tmp/design-director/{c,h,k}.py`, which reuse the audit's `de2000.py`; those colours did not change. Spring curves were computed with `/tmp/design-director/s2.py`. All of these scripts are throwaway files outside the repo.

## In plain English

This is the design plan for the new Aplos. It sets how the app looks, moves, speaks and responds to keys. It also sets the automatic checks that stop AI coding agents from drifting away from it.

The design is called Paper. The window is light gray and your mail sits on one white panel. Colour is rare. Ink blue marks the one main button, the selected row and unread mail. Green means Done, dusk blue means Later and red means a problem. Summaries and Ask answers use a serif typeface, so you can tell Aplos is speaking without a sparkle icon. There is no sky, no airmail stripe and no app icon inside the app.

Home sorts mail by what it asks of you. Do now comes first, then Important updates, then the Low importance line, then Follow up, where Aplos drafts a nudge for you. The reader shows the sender, the big summary, one row of buttons and the message.

Hovering never moves anything. Your next key never waits for an animation. The 17 things that copied Avec are gone.

The questions you were asked are answered. Six older ones and one new accessibility question keep their defaults.

## Decisions for you

Answered questions carry the date. Open ones use their default unless you say otherwise; questions 6 to 11 match roadmap §8.3 #36 to #41.

| # | Question | Status | Answer or default | What happens |
|---|---|---|---|---|
| 1 | Which design language? | Answered 2026-10-27 | **Paper**: a gray window, one white pane, ink blue, the serif for AI text (§2) | Paper replaced the earlier Skypaper look after your mockup review (History). |
| 2 | Change the accent to **ink blue** `#0b5394`? | Answered 2026-10-27 | Yes, inside the revised look (roadmap #10) | The blue sits far from Avec's, and white button text passes at 7.84:1. |
| 3 | Set summaries and Ask answers in the **Newsreader** serif? | Answered 2026-10-27 | Yes. A one-page look sheet at the first Home and reader review confirms size and weight | `summary` and `answer` switch to SF by changing one token if the sheet disappoints. |
| 4 | Cool or warm greys? | Answered 2026-10-27 | Neutral greys that sit just on the cool side (§2.3 check 1) | No sky tint, and still not Avec's warm canvas. |
| 5 | What goes at the top of the reader? | Answered 2026-10-27 | The sender line, the big summary, one action row, then the message (§7.5) | Matches both of your notes and the mockup. |
| 6 | Should Done on mail that still needs your reply leave Home? | Open, default applies | (a) Yes, with a toast offering "Remind me if no reply · R" | Today the row stays and Done looks broken. |
| 7 | Where do the arrow keys triage? | Open, default applies | (a) Only on Home, in the reader and one by one | A slip in All mail or Search cannot archive mail. |
| 8 | How do key hints appear? | Open, default applies (revised 2026-10-27) | (a) In tooltips, as badges while ⌘ is held, or always with the "Show all key hints" setting. Main actions always show their key. Hover never reveals a keycap | Screens stay calm and nothing moves on hover. |
| 9 | Should the Ask dock start closed? | Open, default applies | (a) Closed on first run, then remembered | The first screen is not a large blank panel. |
| 10 | Should ⌘K become a real command palette, with `/` for search? | Open, default applies | (a) Yes | Every command is reachable without memorising keys. |
| 11 | Should the Home focus letter have a fixed height, with the summary cut at two lines? | Open, default applies; amended 2026-11-13 | (a) Fixed, 180 px at the default density, except that a card with no summary coming fits its content | The list cannot jump while a summary is shown or being made. Summaries are cut only on Home, never in the reader. |
| 12 | A margin rail beside the reader? | Answered 2026-10-27 | No. One reading column; the rail's contents live in ⋯ and ⌘K | The reader shows four things and nothing beside them. |
| 13 | The app icon inside the app? | Answered 2026-10-27 | Dropped everywhere, including Welcome. A new logo comes later | No sky is left in the product. |
| 14 | The website and its stripe? | Answered 2026-10-27 | The full site redesign waits for the new logo (§2.4) | This spec covers the app only. |
| 15 | The design system's name? | Answered 2026-10-27 | Paper | Never user-visible; it stops agents drifting back toward a sky. |
| 16 | Account colour on rows? | Answered 2026-10-27; superseded 2026-11-13 | A dot showed only when two or more accounts were connected. The owner removed it: no row carries an account dot or an unread dot | The account colour stays in the account picker and Settings → Accounts; the row tooltip names the account. |
| 17 | Home's section order? | Answered 2026-10-27 | Do now, Important updates, Low importance, then Follow up last (§7.2) | |
| 18 | Where does a person's mail with nothing to act on go? | Answered 2026-10-27 | The respond, see or skip rule (§7.2): a thank-you you'd answer is Do now; a reply that only closes the conversation is Low | |
| 19 | What does Home's sidebar count show? | Answered 2026-10-27 | Do now plus Important updates | |
| 20 | Text fields at rest have a faint ring (about 1.3:1) instead of WCAG's 3:1 boundary | Open, default applies | (a) Keep the calm ring. Fields stay identifiable by their label, placeholder and hover step, and Increase Contrast switches them to the 3:1 edge; (b) use the 3:1 edge always | (a) keeps forms calm. (b) meets WCAG 1.4.11 strictly, but every field gets a dark outline. |

> **What this means:** Nothing blocks building. Question 20 is the only new one, and its default keeps the calm look.

---

## 1. Basis

I scored the three proposals independently before reading the GLM judge's reasons; Appendix A has the scores. The Skypaper proposal won on taste and identity, Instrument had the best engineering, and Carried had the warmest feel. The first version of this spec took the Skypaper proposal as its base and grafted in the best of the other two (Appendix B).

The owner then reviewed that version as HTML mockups and asked for something calmer and more beautiful. That review replaced the visual direction with **Paper** and redesigned the reader, compose, the sidebar and Home. History, near the end, records what changed and why. Everything else in this document describes Paper as it stands.

What carried through unchanged: ink blue, the serif voice for AI text, the Done and Later colours, the "carried off" motion signature, the input rules and budgets from Instrument, the press feel and next-step toasts from Carried, and the whole enforcement layer.

> **What this means:** One design, Paper, built on the winning proposal's engineering and checks, with the look you chose in the mockup review.

---

## 2. Identity: Paper

### 2.1 The name

**Paper** is the name of the design language: the tokens, the `aplos-design` skill and the docs. It is never a product name. The product stays **Aplos Mail**. The direction is never called "Airmail", which is Bloop's trademarked mail client; Bloop has an Italian word mark in classes 9 and 42, and Fichorga and a UK company hold related marks (`gaps/identity-collision-audit.md` §0, §3) [V]. Several products already use the word "Paper", so it stays internal and appears nowhere user-visible. If it ever goes public, run a clearance search first.

### 2.2 The look

Paper takes its principles from Notion, Notion Calendar and Redakt: neutral surfaces, generous white space, a strong typographic hierarchy, quiet chrome and few elements on screen. It never copies their assets, wording or layouts (§14). Notion Mail shut down on September 22, 2026, so only Notion and Notion Calendar were studied live (`mockups/NOTES.md` finding 13).

| Element | Rule |
|---|---|
| **The shell** | The window background, `--shell`, a light neutral gray (night: near-black). The sidebar sits directly on it with no fill of its own. |
| **The pane** | One white surface, `--canvas`, floating 8 px inside the window with a 12 px radius. Lists, the reader, compose and settings sit on it. The Ask dock is a second pane beside it. |
| **Cards** | Only the thing in your hand is a card: the Home focus letter, the inline reply, an Ask proposal, a dialog, a menu. List rows and the reader are not cards. |
| **Ink blue** | The one action colour: the one filled button, the focus ring, the cursor bar and links. |
| **Hill green, dusk blue, stamp red** | Done, Later and danger. They appear only where they carry that meaning. |
| **The serif voice** | Aplos's own words (summaries and Ask answers) are set in Newsreader. Everything else, including display lines, is the system sans. |
| **Type and space** | Roomy type, generous space and few elements carry the identity. There is no decoration. |
| **Carried** | The one signature motion: a finished letter is carried off the way you sent it (§4.9). |

### 2.3 "This is not Avec": the acceptance test

These checks run automatically on the screenshot harness (§12.5) for Home and the reader in both themes. All seven must pass.

1. The shell is cool-neutral: Lab b* is below 0 in both themes. The light shell `#f5f5f6` is −0.49 and the night shell `#121314` is −0.74 [V: `c.py`]. Avec's canvas and Aplos's current `#e5e4e1` are both warm.
2. The accent is at least ΔE00 10 from Avec's `#0050ff`. Ink blue is 13.8 [V: audit §7].
3. The Done colour is at least ΔE00 10 from Avec's greens (`#07aa04`, `#03ce4c`). Light hill is 21.6. The dark hill `#86b86a` is 11.6 and 12.9 [V: computed]; the proposal's `#6cbf5a` was only 6.8 from `#03ce4c`, so this spec changed it.
4. Serif text is present in the main line, meaning the summary.
5. No primary button has a radius above 8 px. There is no floating bottom action cluster, no full-card colour flood on commit, and no decorative pattern (stripes, gradients, illustrated scenes) anywhere in the app UI.
6. None of the banned phrases in §10 appears anywhere in the DOM text.
7. The reader is a single reading column, left-aligned in its pane. It is never a centred card deck with the next card's sliver behind it.

### 2.4 No decoration

- The app has no stripe, gradient, illustrated scene, sky, hill, wind arc, par-avion label, postmark, stamp, star or plane silhouette. Lint bans gradients and the old decorative class names in app CSS (§12.2).
- **The app icon appears nowhere in the UI** (decision 13). Welcome is one line, one sentence and one button. A new logo comes later, and a design pass then decides where, if anywhere, it appears in the app.
- **The website and the DMG background** are outside this spec until they are redesigned with the new logo (decision 14). They still carry the old airmail stripe. The starting inventory for that redesign: `apps/web/src/Chrome.tsx:5-7` (`Airmail`, used at `:40`), `Landing.tsx:2,20` and the hero alt text "an airmail envelope" at `:34`, `Download.tsx:3,63`, `Privacy.tsx:1,8`, `styles.css:91-99` (the scrolling stripe) and `:461`, and `apps/desktop/build/dmg-background.html:21`. Any interim change to the site belongs to the roadmap's `web` lane (roadmap §2.5).

### 2.5 Renames this forces

- "Airmail blue" becomes **ink blue**.
- "Skypaper" becomes **Paper** in the `aplos-design` skill, the `tokens.json` comments and the docs.
- `DECISIONS.md:15-17` and `PROGRESS.md:12` stop saying "airmail brand".
- The website's `Airmail` component and `.airmail` classes go with the website redesign. Nothing in the app may use those names (§12.2).

> **What this means:** The identity comes from calm type, space and one blue, so it cannot be mistaken for Avec or for Bloop's Airmail. Seven automatic checks enforce that.

---

## 3. Principles

1. **Content sits on one white pane. Cards are only for the thing in hand.**
2. **Aplos speaks in a serif; everything else is sans.**
3. **Input never waits.** State commits on keydown, and animation draws afterwards on a copy (§5).
4. **Navigation is instant.** Motion is spent only on state changes: triage, send, arrival and selection.
5. **The list holds still under your hands.**
6. **One accent and one filled button per screen.** The topmost surface owns the filled button.
7. **Meaning never rides on colour alone.** It always has an icon plus a word.
8. **Say plainly what happened, what is safe and what to do.**
9. **AI is content.** It has no glyph, badge or glow.
10. **No decoration.** Type and space carry the identity.
11. **Hovering never moves anything.**
12. **Fewer things on screen.** Secondary actions live in ⋯ and ⌘K.

> **What this means:** These twelve principles settle any design disagreement. A screen that needs a new colour, radius, motion, floating pill or ornament is wrong.

---

## 4. Tokens

All tokens live in one source file, `apps/desktop/src/renderer/ui/tokens.json`, written in the W3C design-token format. A build step generates `tokens.css`, `motion.ts` and the contrast-pair list from it (§12.1). Components only ever use `var(--…)` or the imports from `motion.ts`. `mockups/tokens.css` is the reference transcription.

### 4.1 Colour

| Token | Light | Dark ("night") | Role |
|---|---|---|---|
| `--shell` | `#f5f5f6` | `#121314` | The window background. The sidebar sits on it, transparent. |
| `--canvas` | `#ffffff` | `#191a1c` | The pane that lists, the reader, compose and settings sit on |
| `--paper` | `#ffffff` | `#242528` | Cards on the pane: the focus letter, the inline reply, proposal cards. In dark it is *lighter* than the pane (the Redakt lesson) [V: `redakt/inbox-desktop-dark.png`], a perceptible step (`#242528` over `#191a1c`, council 2 round 3: the focus card, the reader card and the inline reply were melting into the pane). |
| `--float` | `#ffffff` | ink 8 % over `--paper` (opaque) | Floating surfaces: dialogs, menus, popovers, tooltips, toasts, the palette, the selected segment. White by day; at night one clear step lighter than a card, so a floating surface never melts into what is under it (UI council 2, round 2). |
| `--raised` | `#f6f6f7` | `#2b2c30` | Quiet fills: the low-importance band, chips, attachments, the undo-send line. At night one step above `--paper`, so a chip on a card still shows. |
| `--sunken` | `#efeff1` | `#0e0f10` | Segmented tracks, fields |
| `--keycap` | `#efeff1` | ink 8 % over `--paper` | A keycap's plate. By day the sunken step; at night one step lighter than whatever it sits on (the near-black slab was the heaviest mark on the card and the bar, council 2 round 4). Always with a 1 px `--line` edge, so it survives a highlighted row in both themes. |
| `--keycap-ink` | `--dim` | `--ink-2` | A keycap's letter. At night the secondary ink, so the letter is not much quieter than its label (council 2 round 7); 4.5:1 or better on the plate in both themes. |
| `--dim-on-float` | `--dim` | `--ink-2` | Metadata on a floating surface (`--float` or lighter: menus, popovers, dialogs, the palette, sheets, toasts) and on a hovered or cursor row there. Raw `--dim` is 4.5, 3.9 and 3.6:1 on `--float`, hover over it and the cursor row over it at night, so inside those surfaces `--dim` is re-pointed at this token (one rule in `surfaces.css`) and every dim line follows; by day it is `--dim`, unchanged. Council 2, 2026-11-17. |
| `--dim-inactive` | `--dim` | `--dim` | Disabled text on a floating surface: keeps the dim step, so a disabled control stays quieter than an enabled one (exempt from the 4.5:1 minimum; WCAG 1.4.3). |
| `--ink` | `#1d1e21` | `#ececed` | Primary text, unread senders |
| `--ink-2` | `#46484d` | `#c4c5c9` | Read senders, subjects, unread summaries, secondary text |
| `--dim` | `#63666c` | `#9a9da4` | Metadata, timestamps, counts, placeholders, read summaries, disabled text |
| `--faint` | `#8f9298` | `#6f7278` | **Non-text only, on the pane:** disabled icons, dividers. On the shell use `--dim`. |
| `--line` | ink at 9 % | ink at 8 % | Hairlines: the pane edge, separators, the calendar grid |
| `--line-strong` | ink at 14 % | ink at 12 % | Card and field rings |
| `--control-edge` | ink at 48 % | ink at 40 % | Checkbox, radio and switch-off edges only |
| `--accent` (ink blue) | `#0b5394` | `#88aee0` | The one filled button, the focus ring, the cursor bar, links, today's date badge |
| `--accent-ink` | `#ffffff` | `#08111a` | Text on an `--accent` fill |
| `--accent-wash` | accent at 8 % | accent at 12 % | Bulk-picked rows only |
| `--hill` (Done) | `#2f6f2a` | `#86b86a` | Done fills, success |
| `--dusk` (Later) | `#3e5878` | `#8fa9cc` | Later fills, paused sync segments |
| `--stamp` (danger) | `#c4302b` | `#ff7a6e` | Trash, errors, the recording meter, the calendar now-line, failed segments. One red only (today there are two [V: baseline §6.5]). |
| `--stamp-ink` | `#a3221e` | `#ff8d82` | Red *text* and failure icons |
| `--stamp-tint` | stamp at 8 % | stamp at 12 % | Overdue chips |
| `--fill-ink` | `#ffffff` | `#08111a` | Text on hill, dusk and stamp fills |
| `--hover` / `--press` | ink at 4 % / 8 % | ink at 5 % / 10 % | Hover and press fills |
| `--puck` | ink at 6 % | ink at 8 % | Sidebar selection, the keyboard cursor, segmented thumbs |
| `--today-tint` | accent at 4 % | accent at 6 % | The calendar's today column |
| `--scrim` | ink at 18 % | `#000` at 50 % | Behind dialogs and the palette |
| `--shadow-ink` | `#1d1e21` | `#000000` | The base colour for every shadow |
| `--sheen` | none | white at 4 % | The 1 px top sheen on dark panes and cards |

**Computed contrast, WCAG 2.x** [V: `/tmp/paper-design/c.py`; the `--float` rows were added 2026-11-17 and computed by `apps/desktop/scripts/design/check-contrast.mjs`]. Translucent tokens are composited over the surface named. `--float` at night is `#343538` computed (a browser rounds it to `#353639`, which is why axe reads 4.44 where the script reads 4.52); hover over it is `#3d3e41` and the keyboard cursor row (`--puck`) over it is `#434446`.

| Pair | Light | Dark |
|---|---|---|
| ink on pane / shell / paper / raised / sunken | 16.67 / 15.30 / 16.67 / 15.43 / 14.51 | 14.75 / 15.76 / 12.98 / 11.81 / 16.25 |
| ink-2 on pane / shell / raised | 9.15 / 8.40 / 8.47 | 10.10 / 10.79 / 8.09 |
| dim on pane / shell / paper / raised / sunken | **5.76** / 5.28 / 5.76 / 5.33 / **5.01** | 6.41 / 6.85 / 5.64 / **5.14** / 7.07 |
| dim on --float / on hover over --float / on the cursor row (puck) over --float | 5.76 / 5.33 / 5.12 | **4.52** (axe 4.44) / **3.93** / **3.61** (axe 3.59) |
| ink-2 on --float / on hover over --float / on the cursor row (puck) over --float | 9.15 / 8.47 / 8.14 | 7.12 / 6.19 / 5.68 |
| `--dim-on-float` (dim by day, ink-2 at night) on --float / hover / cursor row over --float | 5.76 / 5.33 / 5.12 | 7.12 / 6.19 / 5.68 |
| dim on a bulk-picked row (accent-wash) | 5.07 | 5.19 |
| dim on the keyboard cursor (puck over pane) / a sidebar count (puck over shell) | 5.12 / 4.71 | 5.23 / 5.70 |
| dim on hover / on today-tint | 5.33 / 5.41 | 5.68 / 5.80 |
| faint on pane, non-text only (3:1 needed) | 3.12 | 3.61 |
| accent text on pane / shell | 7.84 / 7.19 | 7.61 / 8.13 |
| accent-ink on the accent fill | **7.84** (today 3.73) | 8.30 |
| fill-ink on hill / dusk / stamp | 6.13 / 7.31 / 5.52 | 8.21 / 7.88 / 7.47 |
| fill-ink on a 70 % fill over paper (dark swipe underlay) | n/a (light fills are solid) | hill 4.95, dusk 4.80, accent 5.01 |
| stamp-ink on stamp-tint | 6.63 | 6.48 |
| control-edge on pane / paper (3:1 needed) | 3.07 / 3.07 | 3.41 / 3.19 |
| line-strong field ring at rest (decision 20) | 1.33 | 1.38 |
| focus ring (accent) on pane | 7.84 | 7.61 |
| ink / ink-2 / dim on the weakest calendar event fill | 13.86 / 7.61 / 4.79 | 10.03 / 6.87 / **4.36, so dark event times use ink-2** |

**Rules**

- **No raw colour in components.** Lint enforces this (§12.2).
- **Colour is rare.** The accent appears only in the roles above. Hill, dusk and stamp appear only where they mean Done, Later or danger. Everything else is gray, black or white.
- **Hover and press** are ink at 4 % and 8 % (dark 5 % and 10 %), mixed with `color-mix` from tokens.
- **Rows.** Every list row shows the email's subject, then, when an AI summary exists (ready or stale), the summary after it in `--dim` as a muted " · summary" that ends in an ellipsis; the summary never replaces the subject (owner decision 2026-11-16, DECISIONS). A read row is a 400 `--ink-2` sender and a 400 subject; an unread row is a 600 `--ink` sender and a 500 subject, with no dot (owner decision 2026-11-13: rows carry no unread dot and no account dot; screen readers still hear "Unread"). There is no distance fade; hierarchy comes from read and unread weight and colour. Opacity is never used for text.
- **The keyboard cursor is neutral:** a `--puck` fill plus a 2 px accent bar on the row's leading edge. `--accent-wash` is only for bulk-picked rows.
- **Disabled** text is `--dim` and disabled icons are `--faint`.
- **Dark commit fills.** Small fills (the commit chip) are solid. Large fills (the swipe underlay) are capped at a 70 % mix over paper, which keeps text at 4.70:1 or better. A full-saturation flood at night is a known failure (`ui/avec.md` §6) [V].
- **Increase Contrast (macOS).** `--line` and `--line-strong` become `--control-edge`, `--faint` becomes `--dim`, and the focus ring becomes 3 px.

**Identity distances, ΔE00** [V: audit `deltaE.txt` plus recomputation]. Light ink blue is 13.8 from Avec, 8.9 from Missive's hover shade and 10.4 from Mimestream's link. Dark `#88aee0` is 10.2 from Airmail's Mac ring and 10.8 from Avec's sky blue. The CI identity check holds every accent and commit colour at least ΔE 8.5 from the reference list (§12.4).

### 4.2 Accounts, labels and calendars

Six pairs, assigned by a stable hash of the name, with a manual override in Settings:

| Name | Light | Dark |
|---|---|---|
| Sky (`--tag-sky`) | `#2f6fa3` | `#6aa5d6` |
| Hill | `#2f6f2a` | `#86b86a` |
| Stamp | `#c4302b` | `#ff7a6e` |
| Dusk | `#3e5878` | `#8fa9cc` |
| Sand | `#8a6320` | `#d9a65a` |
| Ember | `#b4531f` | `#e08a5a` |

- **As marks** (8 px dots, chip outlines, 2 px calendar event rules, sidebar calendar swatches), each colour is at least 5.00:1 on the pane in light (4.59 on the shell) and 6.59:1 in dark [V: `c.py`].
- **Account colour never marks a row** (owner decision 2026-11-13, replacing decision 16's row dot). The account's colour stays in the account picker and Settings → Accounts; with two or more accounts the account name is in the row tooltip and on hover over the reader's sender line.
- **Calendar event fills** use the colour at 12 % (light) or 20 % (dark), composited over `--canvas` and never transparent, so grid lines never cross the text. Titles are `--ink`. Times are `--dim` in light and `--ink-2` in dark.
- **No avatars in mail** (except the reader card's calm sender mark, a monogram until photos exist, owner override 2026-11-10 amended 2026-11-12, §16). Rainbow letter avatars are removed (`renderer/bridge.ts:20` `avatarColor`) [V], and no mail row shows one. The only other monogram is the account switcher's, ink on `--raised`.

### 4.3 Type

**Families**

- **Sans:** the system font, SF Pro via `-apple-system`, used for mail, controls, navigation and display lines. The existing optical tracking is kept.
- **Serif:** **Newsreader** (variable, OFL), bundled as roman woff2 and preloaded with `font-display: block`. Its `size-adjust` fallback is `"New York", Georgia`, so nothing shifts on load. It is used only for words Aplos wrote: summaries and Ask answers. The website already ships it [V: SYNTH-ui §2.4].
- **Mono:** `ui-monospace, "SF Mono", Menlo`, for addresses in popovers, code and citation numbers. Today `--font-mono` is used but never defined [V: baseline §6.9 #9].

**Scale.** These ten roles are the only font sizes allowed. Lint rejects literal sizes.

| Token | Size / line | Face and weight | Tracking | Used for |
|---|---|---|---|---|
| `caption` | 11.5 / 16 | SF 500 | +0.04 px | Keycaps, chips, calendar hours. This is the floor; today's 7–10.5 px sizes are removed. |
| `small` | 12 / 18 | SF 400 / 500, tabular | 0 | Metadata, timestamps, counts, sub-labels such as "Back from Later". Always `--dim`. |
| `ui` | 13 / 20 | SF 400 / 500; 600 for section labels | −0.04 px | Sidebar, menus, controls, buttons; section labels at 600 in `--ink` |
| `base` | 14 / 22 | SF 400 (600 for unread senders) | −0.1 px | List rows, settings rows, fields |
| `read` | 15 / 26 | SF 400, measure 64ch | −0.12 px | Message bodies and the text you write |
| `title` | 15 / 22 | SF 600 | −0.16 px | Card and dialog titles, the reader's sender, the calendar's date label |
| `heading` | 24 / 32 | SF 600 | −0.5 px | Only the compose subject field, the search field and onboarding step titles |
| `display` | 30 / 38 | SF 600 | −0.7 px | Welcome, inbox zero, the fatal error |
| `summary` | 21 / 31 | Newsreader 430 (dark 410), opsz 21 | −0.1 px | **The one big line,** identical on the Home focus letter and the reader (today 18 vs 20 px [V: baseline §6.4]) |
| `answer` | 16 / 27 | Newsreader 400 (dark 390), opsz 16 | −0.05 px | Ask answer prose |

**Rules**

- SF uses weights 400, 500 and 600 only. Read rows are 400; unread senders are 600.
- Metadata is always `small` in `--dim`.
- **There are no page titles** (§7). Section labels are `ui` 600 in `--ink` with their count in `--dim`. Groups are 32 px apart (`--group-gap`), and the first label sits 12 px below the pane header.
- The serif is only for words Aplos wrote. A pending summary shows the subject in SF, and the serif appears only when the real summary lands.
- The reader's subject line is `small` in `--dim`, so it never outweighs the summary. Today a 17/600 subject competes with a 20/500 summary [V: baseline §6.4].
- Tabular numerals are used wherever numbers align.
- Use `text-wrap: pretty` for summaries and `balance` for display lines and headings.
- Add +0.005 em tracking on non-Retina displays [V: SYNTH-ui §2.4].

**Serif gate** (decision 3). The first Home and reader review includes a one-page look sheet of Newsreader 21/31 against SF on real mail in both themes. It confirms size and weight. If the serif loses, the `summary` and `answer` tokens switch to SF 500 in `--ink`, and nothing else changes shape.

### 4.4 Spacing, sizes and layout

**Spacing (4 px grid).** `--space-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-7` 32 · `-8` 40 · `-9` 48 · `-10` 64. `--space-half` (2 px) may only be used to nudge icons optically. The page gutter is 40 px (`--gutter`), and groups are 32 px apart (`--group-gap`).

**Control heights.** `--control-xs` 24 (chips), `-sm` 28, `-md` 32 (default), `-lg` 40 (onboarding primary). Keycaps are 18 px. Every hit target is at least 24 × 24, and the default is 28.

**Density** (Settings → General):

| Density | Row | Home focus letter (fixed) |
|---|---|---|
| Roomy | 48 | 196 |
| **Comfortable (default)** | **40** | **180** |
| Compact | 34 | 164 |

**Layout at a 1440 × 900 window, sidebar open, dock closed**

| Region | Size |
|---|---|
| Window | `--shell` background; macOS window radius 12 |
| Sidebar | 232 px, transparent on the shell. Minimised mode is a ☰ menu button. |
| Pane | Inset 8 px (`--shell-pad`) on top, right and bottom; radius 12; `--elev-pane` |
| Pane header | 48 px. Back or close plus a crumb on the left; at most three icon tools, then Ask and the calendar button, on the right. A hairline appears only after content scrolls under it. |
| Page controls row (`PageHead`) | Only on pages with page-level controls, which sit on the right: Later's Later \| Bookmarks switch, the search field, the calendar's date label with Today, previous/next and D \| W \| M |
| List column | `min(720px, 100% − 2 gutters)` (`--list-w`), centred in the pane. Sender column 136 px, then one always-reserved chip slot (120 px), then the subject: the subject starts at one x in every list, Home included. |
| Reader | One 640 px column (`--reader-w`), no card |
| One-by-one card | A centred reading column: `min(100% − 2 × clamp(16 px, 3 %, 24 px), --card-w)` — `--card-w` is 680 px. Shrinks with the pane, keeps a 16–24 px side margin, never wider; a rich email's frame uses the full card width and only a plain body is held to `--measure-read` (§16 amendment 2026-11-11). |
| Composer | A 640 px page in the pane (`--composer-w`) |
| Collapsed message | 36 px |
| Ask dock | A 360 px second pane, 8 px from the main pane (320 px when the window is under 1180 px), resizable 300–440, remembered |
| Palette | 600 px wide, 16 vh from the top, results at most 420 px tall |
| Settings | 180 px nav + 600 px content |
| Toast | 440 px, growing to fit its words up to 560 px |
| Minimum window | 900 × 600 |
| Onboarding window | 640 × 600, minimum 640 × 520 |

### 4.5 Radius

| Token | Value | Used for |
|---|---|---|
| `--radius-xs` | 4 | Keycaps, the commit chip's inner icon well |
| `--radius-sm` | 6 | Chips, small controls, calendar events, the commit chip |
| `--radius-md` | 8 | Buttons (including the one filled button), rows, fields, menu items |
| `--radius-lg` | 12 | The pane, the Ask dock, cards, menus, popovers, the palette, toasts |
| `--radius-xl` | 16 | Dialogs |
| `--radius-pill` | 999 | **Only** counts and search operator tokens. Never a button. |

No other radii. Today there are about 30 literal radii and pill-shaped buttons everywhere [V: baseline §3.3]. Both go.

### 4.6 Elevation and material

Light comes from hairline rings and soft shadows. There is no glass.

| Name | Light | Dark | Used for |
|---|---|---|---|
| shell | no shadow | no shadow | The window background and the sidebar |
| `--elev-pane` | `--line-strong` ring + `0 1px 2px` shadow-ink 5 % | ring + inset `0 1px 0` `--sheen` | The pane, the Ask dock, the reader's message cards |
| `--elev-card` | `--line-strong` ring + `0 1px 2px` 6 % + `0 6px 20px` 8 % | ring + sheen + `0 8px 24px` black 30 % | The focus letter, the inline reply card, proposal cards |
| `--elev-float` | `--line-strong` ring + `0 4px 12px` 6 % + `0 16px 40px` 10 %, on opaque `--float` | ring + sheen + black 30 % / 40 % | Menus, popovers, tooltips, toasts, the palette |
| `--elev-dialog` | `--line-strong` ring + `0 8px 24px` 8 % + `0 32px 72px` 14 %, `--scrim` behind | ring + sheen + black 40 % / 50 % | Dialogs and confirmations |
| `--elev-lift` | `--elev-card` + `0 12px 32px` 10 % | + black 45 % | A dragged row or letter |
| `--elev-puck` | `--line-strong` ring + `0 1px 2px` 6 % | ring + sheen | The thumb of a segmented control |

**Material rules**

- **No glass.** No surface uses `backdrop-filter` or translucency. Every floating surface is opaque `--float`, so Reduce Transparency changes nothing.
- **Press feel** (from Carried): the filled button has a 1 px inset highlight at the top (white 16 %) and a 1 px inset shade at the bottom (shadow-ink 14 %, dark black 22 %). On `:active` they swap, and the button scales 0.97 (icon buttons 0.94).
- **No paper or desk texture** (Appendix B). Depth comes from light, not noise.
- **Three button idioms only:** **filled**, **text** and **icon**. Today's glass pills are removed [V: baseline §6.8].
- **One filled button per screen, and the topmost surface owns it.** With a composer, the palette, a dialog or a proposal card up, the screen behind it demotes its suggestion to a text button.

### 4.7 Iconography

- **Source.** SF Symbols through Aplos's Swift helper, with Lucide as the fallback [V: `DECISIONS.md:127`]. Icons are monoline with a 1.5 px stroke: 16 px everywhere, 14 px in chips and status lines, 12 px for the smallest marks. They are `--dim`, and `--ink` when active.
- **AI suggestions wear their action's icon:** reply arrow, calendar, link, paperclip, cart, phone, file.
- **Ask** is a speech bubble (`text.bubble`) plus the word "Ask" in the pane header. It stops borrowing the search magnifier (`Topbar.tsx:22`) [V]. The magnifier belongs to Search alone.
- **Compose** is `square.and.pencil` beside the account switcher, **Done** is `checkmark` (the Done place uses `checkmark.circle`), **Later** is `clock`, **Bookmark** is `bookmark`, **Trash** is `trash`, and the calendar button is `calendar`.
- **Banned in every form:** `sparkle(s)`, `wand.and.stars`, `wand.and.rays`, `star`, `star.fill`, `apple.intelligence`, `brain`, `brain.head.profile`, and Lucide `Sparkles`, `Sparkle`, `Wand`, `WandSparkles`, `Stars`, `Star`, `Brain`, `Bot`. Lint enforces the list (§12.2). Bookmarks use `bookmark`, never a star.
- **No icon-in-a-grey-circle empty states** [V: baseline §6.8 #1].

> **What this means:** Every colour, size, gap, corner and shadow comes from one list, so screens stay consistent. Every text colour passes contrast checks in both themes.

---

### 4.8 Motion tokens

**Easings**

| Token | Curve | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(.16,1,.3,1)` | Entrances, settles |
| `--ease-std` | `cubic-bezier(.2,.8,.2,1)` | Colour, hover, swaps |
| `--ease-in` | `cubic-bezier(.5,0,.75,0)` | Overlay exits |
| `--ease-carry` | `cubic-bezier(.4,0,1,1)` | Departures, which accelerate away |
| `--ease-inout` | `cubic-bezier(.65,0,.35,1)` | Loops (breathe, status) |
| `--ease-linear` | `linear` | Countdown drains only |

**Springs.** Each spring is defined once as stiffness / damping / mass. It is compiled two ways: to a CSS `linear()` curve for fire-and-forget CSS and WAAPI, and to a JS solver in `motion.ts` for anything that can be interrupted. The JS solver keeps the current value and velocity, so motion can be retargeted mid-flight. Durations below are the 0.5 % settle time. The curves are 18 evenly spaced samples [V: `/tmp/design-director/s2.py`].

| Spring | k / d / m | ζ | Overshoot | Duration | `linear()` |
|---|---|---|---|---|---|
| `--spring-slide` | 600 / 42 / 1 | 0.86 | 0.5 % | 270 ms | `linear(0, 0.059, 0.189, 0.343, 0.492, 0.624, 0.732, 0.816, 0.88, 0.925, 0.957, 0.978, 0.991, 0.999, 1.003, 1.005, 1.005, 1)` |
| `--spring-snap` | 420 / 36 / 1 | 0.88 | 0.3 % | 250 ms | `linear(0, 0.038, 0.126, 0.239, 0.358, 0.473, 0.577, 0.668, 0.745, 0.808, 0.858, 0.898, 0.928, 0.951, 0.968, 0.981, 0.989, 1)` |
| `--spring-lift` | 500 / 40 / 1 | 0.89 | 0.2 % | 240 ms | `linear(0, 0.041, 0.137, 0.257, 0.381, 0.498, 0.603, 0.692, 0.766, 0.826, 0.873, 0.91, 0.937, 0.958, 0.972, 0.983, 0.99, 1)` |
| `--spring-follow` | 700 / 48 / 1 | 0.91 | 0.1 % | 210 ms (JS, per frame) | `linear(0, 0.044, 0.146, 0.271, 0.399, 0.518, 0.622, 0.71, 0.782, 0.839, 0.884, 0.918, 0.943, 0.961, 0.975, 0.984, 0.991, 1)` |
| `--spring-thumb` | 500 / 30 / 1 | 0.67 | 5.8 % | 310 ms | `linear(0, 0.067, 0.221, 0.407, 0.588, 0.745, 0.868, 0.955, 1.012, 1.044, 1.057, 1.057, 1.051, 1.041, 1.03, 1.02, 1.011, 1)` (switch thumb only) |

The proposal's slide spring (400 / 32 / 1) actually settles in 361 ms at 0.5 %, not about 250 ms. It is stiffened here so the selection puck finishes within one keystroke rhythm. Today's `--ease-spring` (`ui/tokens.css:77`, about 7 % overshoot) is retired; only the switch thumb may visibly bounce.

**Named motions.** These 23 named motions (21 rows; lift, follow and snap share one) replace 56 `@keyframes` and about 30 literal timings [V: baseline §4]. "Rapid" applies when triage keys arrive less than 300 ms apart. "Reduced" applies under `prefers-reduced-motion`.

| Token | Duration | Curve | What moves (transform and opacity only) | Where | Rapid | Reduced |
|---|---|---|---|---|---|---|
| `nav` | **0** | n/a | nothing | View, mailbox, account and settings-section switches | 0 | 0 |
| `press` | 80 down / 140 up | out | scale .97 (icons .94), inset swap | Buttons, rows, keycaps | same | colour only |
| `hover` | 100 | std | background and colour only; `(hover: hover)` only | Rows, controls | same | same |
| `cursor` | 120 (Home focus 160); **0** on key repeat and pointer | out | one shared cursor layer | List cursor | 0 | 0 |
| `reveal` | 140 in / 100 out | out / in | opacity, 4 px from trigger, scale .98→1 | Menus, popovers, tooltips (instant for 600 ms after one closes) | same | opacity 100 |
| `settle` | 180 in / 120 out | out / in | opacity, 8 px rise, scale .98, from its anchor | Dialogs, the palette, proposal cards, the inline reply card (in on open, out on send) | same | opacity 120 |
| `slide` | 270 | `--spring-slide` | one shared puck (translate + scaleX), never width | Sidebar selection, D/W/M, Ask/Today, Settings nav, Later \| Bookmarks | same | 0 |
| `commit` | 60 | out | commit edge scaleY 0→1; commit chip opacity + scale .9→1 | Done / Later / Trash on the focus letter or in the reader | 30 | opacity 60 |
| `carry` | 120 | carry | ghost row: translateX ±28 px, opacity →0 | Any row leaving any list | 60 | opacity 80 |
| `flight` | 220 | carry | ghost letter: translate (±96 px, ∓12 px), rotate ±2°, opacity →0 from 40 % | The focus letter or the reader column on commit | 110; from the 4th key in 1 s, `carry` instead | opacity 120 |
| `deal` | 140 | out | next letter's content: opacity, 6 px rise inside the fixed slot | Home focus slot after a commit | 0 | 0 |
| `hold` | until 450 ms after the last key, or the pointer leaves the row (cap 1200) | n/a | rows and section labels below pinned via transform | Burst triage; new mail during activity | same | same |
| `close` | 180 | out | FLIP of rows below | After `hold` releases | same | 0 |
| `swap` | 120, overlapping | std | opacity + 12 px in the travel direction | Reader J/K (double-buffered), Later groups | 60 | opacity 100 |
| `arrive` | 200 | out | opacity + 6 px drop; neighbours FLIP | New mail, a sent message in its thread, Ask cards | deferred until `hold` ends | opacity 120 |
| `dock` | 200 open / 140 close | out / in | dock *contents* translateX 24 px + opacity; main pane FLIP | Ask dock, sidebar | same | 0 |
| `undo-send` | the undo window (8 s default) | linear | a neutral 2 px bar, scaleX 1→0 | The undo-send line under a sent message | same | static, with a text countdown |
| `lift` / `follow` / `snap` | springs | spring | lift scale 1.02 and `--elev-lift`; follow the pointer; snap back or onto a drop target | Drag and swipe | same | 0 |
| `breathe` | 1600 loop | inout | `--ink-2` text at opacity .75↔1 | Pending AI lines only, at most 3 on screen | same | static at .85 |
| `status` | 1500 loop | inout | 30 % segment in a 2 px track, or the checklist marker | The current first-sync step; spinners only after 150 ms | same | static |
| `count` | 140 | out | old digit out 4 px up, new in from 4 px below | Sidebar counts | 0 | 0 |

**Theme switch.** Disable every transition for one frame, so the app changes all at once [V: SYNTH-ui §3.1 #8].

**The dock.** Transforms were tried before and dropped because a strip of window background showed during the slide, and width animation replaced them [V: `DECISIONS.md:298`]. The fix is to paint the dock's final area in its pane colour on frame one, slide only its contents, and FLIP the main pane. If seams still show *in the packaged app*, fall back to one-step resize plus content fade. Never animate `width`.

### 4.9 The signature: carried off

**Keyboard Done (E, Space when the suggestion is Done, or → on Home and in the reader):**

1. **Keydown, frame 0.** State commits, focus moves to the next item, and the screen-reader live region announces "Done. Next: Maple Library, items ready for pickup".
2. **0–60 ms (`commit`).** A 3 px `--hill` edge grows on the leaving edge of the letter. A commit chip (26 px tall, solid hill, a white check plus "Done", `--radius-sm`) appears in its top-trailing corner. The body is **not** flooded; a whole-card flood is Avec's signature (`ui/avec.md` §4 row 4) [V].
3. **40–260 ms (`flight`).** A ghost copy of the letter (the focus letter on Home, the reader column in the reader) flies right and slightly up with a 2° tilt, like a letter caught by wind. It replaces today's `perspective(1400px) rotateY(±14deg)` fling (`styles.css:352-358`) [V].
4. **On Home, the slot holds still.** The focus letter is a fixed-height slot (except a card with no summary coming, which fits its content, 2026-11-13). The next letter's content is *dealt* into it (`deal`). The next row's old 40 px line below empties under `hold`, then closes once you pause (`close`).

**Later** is the same move in `--dusk` with a clock, flying left and slightly down, as if set aside for the evening.

**Rapid mode.** Five quick E presses leave at half duration and nothing in the list shifts until you stop. From the fourth key in one second, the flight becomes a 60 ms `carry`.

**Swipe (two-finger trackpad or drag).** The letter follows the pointer (`follow`). An underlay behind it, not on it, reveals the solid action colour with its icon and verb. At the threshold (30 % of the width, or a velocity above 0.6 px/ms) the underlay icon scales 1→1.08→1 using `snap`, and the matching action-row button takes the action colour while armed. On release the letter continues *from its release velocity* into `flight`. Below the threshold it snaps back.

**Send** has no flight. The composer closes (`settle` out), and the message `arrive`s in its thread with the undo-send line (§7.6).

> **What this means:** About two dozen named motions replace dozens of one-offs. Moving around is instant, and finishing an email never makes you wait or moves the list under you.

---

## 5. Input never waits: engineering rules

These are requirements, not preferences. Each one has a test in the budget suite (§12.6) or the harness (§12.5).

1. **Commit on keydown.** The handler updates the store synchronously, then calls the engine optimistically. Key-to-state takes 8 ms or less (p95).
2. **Focus moves with state, in the same event.** Five J presses within 200 ms land five rows down. Five E presses make five correct commits.
3. **Animate a ghost, never the model.** Clone the leaving element with fixed geometry and remove the real one at once, then animate the clone with WAAPI on the compositor. React never re-renders per frame. At most three ghosts animate at once; a fourth finishes the oldest.
4. **Keys are never dropped.** A window-level capture listener queues keys that arrive during a mount or transition and replays them on the next frame.
5. **Interrupt means finish or retarget.** A new key finishes a running ghost. A new gesture during a spring starts from the drawn value and velocity.
6. **The list holds still.** `hold` pins rows during bursts and while the pointer is over the list. New mail never moves the row under the cursor; it waits under `hold`, then arrives. A section label stays in place, showing 0, until `hold` releases, so emptying a section never makes the rest jump.
7. **Never animate layout.** No `width`, `height`, `padding`, `margin`, `inset` or `font-size` transitions. The Home focus letter has a fixed height per density (a card with no summary coming fits its content). Rows close with FLIP. The reader swaps with a double buffer.
8. **Navigation is instant.** There is no page-transition token.
9. **Prefetch on intent.** After 80 ms of keyboard focus or 120 ms of hover, prefetch the body and both neighbours, and cancel if you move on. The engine keeps an LRU of 12 rendered bodies [V: SYNTH-ui §1 #3; Instrument].
10. **Double-buffer the reader.** The previous letter stays until the next body is laid out and measured, with a 1.5 s deadline. After that, keep the previous letter and show a 12 px "Loading Maple Library…" line. Never show a blank pane.
11. **Optimistic writes are durable.** Triage, read state, bookmarks, Later and lane corrections go to the engine's durable op queue. Undo is the *inverse operation*, not a delayed commit. If the engine rejects a write, the row returns to its place with an inline error and Retry.
12. **No spinner for local reads, and none under 150 ms** for remote ones. After 150 ms, show one quiet indicator in place (the status slot or a 12 px line), never a modal.
13. **Nothing over 50 ms on the renderer main thread.** HTML sanitising, search, ranking and diffing run in the engine or a worker. IPC is batched per animation frame.
14. **`will-change` only while animating,** removed on finish. Lists are virtualised with fixed row heights.
15. **Suspend when hidden.** Pause loops, timers and springs when the window is hidden or occluded. Stop springs on `pointercancel`.
16. **IME-safe.** Never intercept keydown while `isComposing`. Use `event.key`, not `keyCode`. Single-key shortcuts are off inside text fields. Caps Lock is ignored.
17. **Hover never changes layout.** Hover may change colour and fill, nothing else. It never reveals an inline keycap, never reflows a row and never moves a neighbour. Row hover actions overlay the date column. Key hints live in tooltips (an overlay), in badges while ⌘ is held, and in the "Show all key hints" setting, which is a mode, so layout stays fixed while you work. The harness hovers every interactive element and fails if any other box moves by more than 0.5 px (§12.5).

**Budgets.** Measured in the packaged, signed build on the owner's Mac, with 10,000 threads. A regression fails CI.

| Interaction | Budget |
|---|---|
| Triage key → state | ≤ 8 ms p95 |
| Triage key → next paint, focus moved | ≤ 16.7 ms p95; 50 ms hard cap |
| 10 E presses in 2 s | no dropped key, one `close`, no frame over 33 ms |
| Open a cached letter | < 100 ms to first body paint |
| J/K with a prefetched neighbour | < 50 ms |
| Palette open / filter one keystroke | < 50 ms / < 16 ms |
| Cold start → shell painted / Home interactive | < 800 ms / < 1.5 s (local index). Initial targets, recalibrated after the first measurement. |
| Scroll 10k rows | no frame over 16.7 ms p95 |

> **What this means:** The app acts first and animates second, so fast key presses never wait, a slow network never slows the keyboard, and the mouse never shuffles the screen. Every rule is an automatic test.

---

## 6. Component inventory

Every screen is built from these components in `src/renderer/ui/`. Screens never style their own controls (`DECISIONS.md:130`). **New** means the component doesn't exist today, **Rework** means it exists but changes, and **Keep** means it is only re-tokenised.

| Component | Status | Spec |
|---|---|---|
| `Pane` | New | The white surface with `--elev-pane`; the main pane and the Ask dock |
| `PageHead` | New | The row for page-level controls, right-aligned. It never holds a title or subtitle (§7). |
| `NavHead` | New | A quiet sidebar group label ("Mail", "Calendars"), `small` `--dim` |
| `Button` | Rework | Three variants: `filled`, `text`, `icon`. Radius 8, heights 28 / 32 / 40, press inset. Glass and pill variants are deleted. |
| `Kbd` (keycap) | Rework | 18 px, radius 4, `caption`, `--keycap` with a 1 px `--line` edge. Shown in tooltips, as badges while ⌘ is held, with "Show all key hints", and always on main actions (Space in the mail window, Return in onboarding and dialogs, ⌘↩ on Send). Never revealed by hover. |
| `Tooltip` | Keep | Label + keycaps from the registry, `reveal`, `--elev-float`. This is where key hints live. |
| `Menu`, `Popover` | Rework | Opaque `--float`, `--elev-float`, radius 12, 32 px items, at least 220 px wide. Number keys 1–9 pick in short menus. The double-blink on the chosen item is removed. A menu opens below its trigger from the trigger's start edge, for icon triggers (⋯) too, and lines up with the end edge only when the window has no room (owner review of #548, 2026-11-17: the end-edge anchoring for icon triggers was rejected). |
| `Dialog` / `Confirm` | Rework | `--elev-dialog`, `settle`. Confirmations are two key rows; destructive ones default to Cancel (§7.9). |
| `Puck` (segmented / selection) | New | One shared indicator per group, moved by `slide`. Used by the sidebar, D/W/M, Ask/Today, Settings nav and Later \| Bookmarks. Replaces the tab indicator that animates width and height (baseline §4). |
| `ListRow` | Rework | Fixed height per density. Sender, subject with the muted summary after it when one exists, due chip, date; unread is weight alone (no dot) and no account dot (owner decision 2026-11-13). No avatar. Hosts the cursor layer, bulk-pick wash, swipe underlay and hover actions that overlay the date column. Option: a fixed stamp column ("Done 9:41 AM") with the hover action to its left. |
| `SectionHeader` | Rework | `ui` 600 `--ink` label + `--dim` count + one optional quiet text action. A sub-label variant (`small` 500 `--dim`) for "Back from Later". Tab / ⇧Tab target. Stays, showing 0, until `hold` releases. |
| `FocusSlot` / `FocusLetter` | New | A fixed-height card on Home (`--elev-card`): meta line, a two-line summary or its placeholder and an action row; fits its content when no summary is coming; supports `deal` |
| `LowBand` | Rework | The low-importance band on `--raised` (§7.2) |
| `ReaderHead` | New | The reader's sender line, summary and action row (§7.5) |
| `EarlierMessages` | New | One collapsed line for earlier messages ("3 earlier messages from Jordan, you and Mina"); O expands |
| `ReplyStub` | New | The quiet "Reply to Jordan…" field with an R keycap |
| `Summary` | New | Serif `summary` text with pending (`breathe`, subject in SF), ready, absent and provenance-on-hover states. The Home focus card draws its pending state as `SummaryPlaceholder` instead (owner decision 2026-11-13). |
| `Why` | New | Opened from ⋯ as "Why it's here": one sentence + a quote + the two lane-correction keys (⌥↑ / ⌥↓) |
| `CommitChip` / `CommitEdge` | New | Solid hill / dusk / stamp chip (26 px) and 3 px edge (§4.9) |
| `Chip` | Rework | Due, label and operator token. 24 px, radius 6, `--raised` fill; overdue chips use `--stamp-tint` with `--stamp-ink`; pill only for operator tokens. A due date found by AI says "from the email" on hover. |
| `AskDock`, `AskTurn`, `StepLog`, `Citation`, `ProposalCard` | Rework | §7.7. The proposal card is the dock's one card and owns the filled button. |
| `Composer`, `InlineReply`, `RecipientField`, `DraftState`, `Suggestion`, `LevelMeter` | Rework | §7.6. `Suggestion` is dim, editable AI text with Tab to keep and Esc to dismiss; it carries AI drafts and the follow-up nudge. `LevelMeter` is a small `--stamp` bar meter; the breathing ring is removed. |
| `UndoTray` | New | A `--raised` line under a sent message: "Sending to Jordan in 8 s · Undo Z · Send now", with the neutral `undo-send` drain |
| `Toast` / `ToastStack` | Rework | Opaque, §7.13 |
| `StatusSlot` | New | The sidebar footer's sync state; the only place sync status lives in the main window. Copy fits two short lines. |
| `ReconnectSheet` | New | The weekly Gmail reconnect (§7.1), built by `ui-onboard` |
| `ProgressSegments` | New | Checkpoint progress for first sync, "Account connected" and "Importing N of M"; neutral colours |
| `Palette` | New | §7.9. Opaque. |
| `SearchField` + `OperatorToken` | Rework | §7.9. A page field at `heading` size with a 2 px accent underline while focused. |
| `DatePresets` | Rework | Presets 1–5 with their digits always visible, a calendar, Return to confirm |
| `MiniMonth`, `CalendarList` | New | In the sidebar on Calendar: a small month and the calendars with colour swatches |
| `CalendarGrid`, `EventBlock`, `PlanOutline`, `NowLine` | Rework | §7.8 |
| `SettingRow`, `ProviderTable`, `KeyRecorder` | New / Rework | §7.10 |
| `EmptyLine` | New | One plain sentence + at most one action. Replaces icon-in-circle `emptyFor` (`App.tsx:24-25, 490`). |
| `ErrorLine` / `FatalScreen` | New | §7.15 |
| `Switch`, `Checkbox`, `TextField`, `Spinner` | Keep | Re-tokenised. Spinner appears only after 150 ms. Switch 30 × 18 with the `--spring-thumb`: a round (pill) track and a round `--paper` thumb in both themes. Owner review of #548, 2026-11-17: the square track and the light night thumb tried in UI council 2 were rejected; the original switch stays everywhere. |
| `ShortcutSheet` | Rework | Generated from the command registry; three columns at a fixed height that scrolls when needed; alternatives joined with "or" |
| `CommandRegistry` | New | One source of every action: id, label, icon, keys, context, undo, confirm. It feeds keys, the palette, menus, tooltips, the sheet and toast keycaps. |

> **What this means:** Screens are assembled from a fixed parts list, so agents cannot add a fourth button style, a new pill or an ornament.

---

## 7. Screens

**There are no page titles.** The sidebar already says where you are. Section labels name what is in the pane, and deeper views (the reader, compose) show a small crumb in the pane header. Page-level controls sit on the right of a `PageHead` row. Every screen follows §3. The states listed for each screen are required and captured by the harness (§12.5). Each section names its mockup in `mockups/`, which is the visual target.

### 7.1 Shell: sidebar, pane header and status slot

*Mockups: every page; `errors.html` (reconnect, quota, offline) for the status slot; `demo.html` for the demo account.*

- **Layout.** The gray shell holds the sidebar and one or two white panes: the main pane and, when open, the Ask dock.
- **Sidebar, top to bottom:**
  - The account switcher (a monogram and name, defaulting to **All accounts**) and the compose pencil (C).
  - A first group with no label: **Search** (/), **Home** (⌃1), **Later** (⌃2), **Calendar** (⌃6).
  - A quiet "Mail" label (`NavHead`) over **All mail** (⌃3), **Done**, **Drafts** (⌃4), **Sent** (⌃5), **Spam** (⌃8) and **Trash** (⌃7).
  - On Calendar only, a `MiniMonth` and a "Calendars" group with colour swatches appear under the groups. This is the calendar legend; ⌥-click shows one calendar alone.
  - The footer: `StatusSlot`, then **Settings** (⌘,) and **Help** (?) as normal rows.
  - Rows are 28 px with no gaps between them, and groups are 20 px apart. Selection uses the `slide` puck, and counts use `count`.
  - Counts: Home shows Do now plus Important updates; Later shows items whose date has arrived; Drafts shows the number of drafts. Counts hide during first sync.
  - There are no "Needs reply" or "Awaiting reply" places. Reply work lives on Home.
- **Collapsed sidebar** (macOS, windowed): the pane rises to the top edge and a notch wraps the window buttons, the sidebar toggle and New message. The two buttons sit 4 px after the last window button (x 79 for buttons ending at 75), with no other blank space before them (owner review of #548, 2026-11-17).
- **Minimised mode** (your setting) is a ☰ button top-left that opens a menu with the same items and puck. Navigation never moves into the pane header.
- **Pane header (48 px).**
  - Left: on deeper views, back or close plus a quiet crumb, for example "Home 1 of 9". In the reader, once the summary has scrolled out of view, the crumb shows the subject instead.
  - Right: at most three icon tools for the view, then **Ask** (speech bubble + "Ask", A), then the **calendar button** (a calendar icon, tooltip "Today, ⇧A"), which opens the Today tab of the Ask dock. The Ask pill with "A" and "Hold to talk" is removed.
  - Bulk selection replaces the left side with "3 selected · Done · Later · Trash · More · Esc".
  - The header gains a hairline only after content scrolls under it.
- **Status slot.** Copy is written for two short lines of about 28 characters. It never becomes a banner that pushes the list [V: SYNTH-ui §4].

| Status (ARCH §6.4) | Copy | Action |
|---|---|---|
| `starting`, `syncing` | "Starting…", "Syncing…", only after 150 ms | none |
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
| demo account | "Demo mail · Remove in Settings" | The line itself opens Settings → Accounts |

- **The reconnect sheet** (roadmap N3). Google's Testing mode makes Gmail ask for sign-in every 7 days. Reconnect now, Reconnect and the Settings account row all open one small sheet (`--elev-dialog`) that opens Google in the browser with the address filled in (`login_hint`). It shows "Waiting for Google in your browser…" with Cancel, then closes with a "Reconnected" toast. Nothing resyncs, and local changes are kept.

### 7.2 Home

*Mockups: `home.html` (default, no-ai), `demo.html`, `compose.html?state=follow-up` for the follow-up draft.*

Home sorts mail by what it asks of you.

```
                                                          Ask   [calendar]
  Do now  6                                                 Go one by one
  ┌ focus letter · card · fixed 180 ────────────────────────────────────────┐
  │ Jordan Park                                     ◷ Tomorrow    Friday    │
  │ Two layout directions are ready. Jordan wants your preference by        │
  │ tomorrow.                                         (Newsreader 21/31)    │
  │ [↩ Reply  Space]    Later    Done    ⋯                                  │
  └─────────────────────────────────────────────────────────────────────────┘
  • Leah Okafor    ◷ Tomorrow  Lunch for six tomorrow. Pick somewhere quiet  Tuesday
    Harbor Table   Your Saturday table was canceled. Pick another night.     Monday
    Back from Later  2                                       Clear from Home
    Priya Raman    ◷ Due today  Priya needs the revised deck today            Oct 23
  Important updates  4
    Parcel Trail   Your package was delivered to the front porch at 9:12 AM.  Today
  ░ Low importance   Field Notes, Cedar Market, Google and 3 more           6 ░
  Follow up  2
    Owen Park      You asked Owen whether dinner is still at 7. No reply in six days.
```

**Sections, top to bottom**

| Section | What goes in it | Space does | Order inside |
|---|---|---|---|
| **Do now** | New mail with a clear action for you: a direct question or request, a decision, something to sign, pay, approve, confirm, book or reschedule, an invitation to answer. Example: "Your Saturday table was canceled. Pick another night." | The suggested action (Reply, View invoice, Reschedule, Add to calendar…) | The Do now order below |
| ↳ **Back from Later** (a sub-label inside Do now) | Later items whose date has arrived. Always at the bottom of Do now. Its label carries "Clear from Home", which sends them back to Later. | The item's suggested action | The same order, within this block |
| **Important updates** | Mail worth seeing with no clear action: a delivery that arrived, a person sharing something "for your information", a decision that affects you, a payment that will happen by itself | Done (it's read and handled) | Important first, then newest |
| **Low importance** (the one-line band) | Newsletters, promotions, receipts, routine notifications, security alerts such as "New sign-in on your Mac", shipping progress ("on its way"), and replies that only close a conversation ("Of course!" after your thanks) | Return opens the sheet | By sender |
| **Follow up** (last) | Mail you sent with no reply after the nudge period (3 days by default) | **Reply with a nudge**: opens the reply with an AI-drafted follow-up as an editable suggestion | Longest wait first |

- The focus letter starts on the first item of Do now. If Do now is empty and the rest isn't, Home starts at Important updates. Tab and ⇧Tab move between Do now, Important updates and Follow up.
- An empty section doesn't render, except that a label emptied during a burst stays, showing 0, until `hold` releases (§5 rule 6).
- The sidebar count on Home is **Do now plus Important updates** (decision 19).
- Labels are literal. "Ready when you are", "Waiting on you" and "No reply yet" are gone (`App.tsx:510`), and so are the earlier "New", "Due now" and "Waiting on others".

**The order inside Do now**

1. **Due band:** overdue or due today, then due tomorrow, then due within 7 days, then due later or with no due date.
2. **Within a band:** important before normal.
3. **Then** the soonest due date.
4. **Then** the newest received.

The Back from Later block uses the same order, below the new items. Rows in Do now show their due date as a quiet chip ("Tomorrow", "Sat", "Nov 4"), so the order is readable. Overdue chips use `--stamp-ink` on `--stamp-tint` with a clock icon. Undated rows show no chip. The order stays still under the cursor (§5 rule 6): new mail and re-ranks wait under `hold`, then `arrive`.

**How mail is sorted into sections** (the engine's side is ARCH §8.2)

- **The owner's rule decides every case.** If you'd want to respond, it's Do now. If you only need to see it, it's Important updates. If you don't need to see it, it's Low importance. The decision is about the conversation, not the sender:
  - "Thanks for covering Saturday" sent to you is **Do now**, because you'd reply "of course".
  - If you thanked them and they answered "Of course!" with nothing else to answer, it's **Low importance**.
  - A person's mail is never sent to Low just for being from a person, or kept out of it for that reason.
- Each thread has a **lane** (`do`, `update`, `low`) and an **importance** (`important`, `normal`) for ordering. Follow up is computed, not stored: you sent the last message, and no reply came within the nudge period.
- **Without AI**, the engine sorts at ingest from headers, labels and correspondents. When unsure, a person's mail goes to Do and automated mail goes to Low. Home with AI off is useful, never empty or wrong-looking.
- **With AI**, the summary job also returns the lane, a due date found in the text ("by tomorrow", "until Saturday") and the suggested action, and may move a thread between lanes. Rules and your corrections always win.
- **Corrections are one key each.** ⌥↓ moves a thread down a lane (Do now → Important updates → Low importance), and ⌥↑ moves it up. Both offer "Always do this for [sender]" and toast with Undo. They also live in ⋯ → "Why it's here".
- **Due dates come from three places.** In order of trust: your own date (D), dates in structured data (invites, bills), and a date the AI found. A found date shows as "Due tomorrow" with "from the email" on hover, so it's never mistaken for one you set.

**The follow-up draft**

- When a thread enters Follow up, a background job writes a short, polite nudge in your voice that refers to your last message. It stays a local suggestion, not a synced draft, until you keep it. Consent and the daily AI cap apply as usual (ARCH §8.3–8.4).
- Space opens the inline reply in the thread (§7.6) with the nudge as a dim suggestion and the line "Aplos drafted this follow-up from your last email. Tab keep, Esc dismiss."
- With AI off or not consented, Space opens an empty reply with "Re:" filled in, and there's no error.
- Done on a Follow up item offers "Remind me if no reply · R" (decision 6).

**The focus letter**

- A card (`--elev-card`) with a fixed height: 180 px by default (roomy 196, compact 164).
- The meta line holds the sender (`base` 600) and the relative date. The due chip, if any, leads the summary line, inline before the words, where a list row puts it before the subject (it follows the placeholder and the collapsed subject line the same way); it is the same 24 px chip as in rows (orchestrator's hands-on test, round 4, 2026-11-13).
- Below it is the **serif summary**, the one big line, two lines at most on Home. While it is being written (a provider is set, the account is allowed for AI, a job is queued or running) the same space holds a quiet placeholder: two soft lines about 90 % and 65 % wide and a small muted "Summarizing…", never moving the buttons; the summary replaces it in place with a short opacity fade. The placeholder holds for as long as the work is live or queued — no timeout collapses it. With no summary coming (no provider, Summaries off, the account excluded from AI, or generation failed) the space collapses entirely: the card is the meta line, the subject in SF, then the buttons, with no placeholder and no error (owner decisions 2026-11-13 and 2026-11-16).
- The action row: the suggestion as the one filled button (action icon + verb + Space keycap), then Later and Done as text buttons (Done is omitted when the suggestion is Done), then one ⋯ (.) for bookmark, trash and "Why it's here". Their keys show in tooltips.
- There is no subject (except as the collapsed card's one line above), no todo line and no bookmark icon on the card [V: baseline §6.2].
- **Every list key works on the card, whatever its suggestion is** (owner decision 2026-11-13). The button is lane-specific (Reply on Do now, Done on Important updates, the nudge on Follow up), but → and E are Done, ← and L are Later, R is Reply, ⇧R is Reply all, hold R dictates, D, B, #, U, ⌥↑ / ⌥↓ and the rest act on the card's thread, and Space runs the suggestion the button shows. The same holds one by one and in the reader, for the keys each has (the reader has no D). The buttons keep their own key hints; the filled one keeps "Space".

**Rows, the band and the rest**

- Rows follow §4.1's read and unread rules. Hover shows Later and Done icon buttons over the date column.
- **Low-importance band.** It keeps its own `--raised` background (your rule). It reads as one line: the label "Low importance", up to three sender names in `--dim` with "and N more", and the count as a plain number on the right. There is no count badge on the left; badge-plus-comma-list is Avec's layout (`App.tsx:510` `.low-line`; Avec `seg/t0174.2.png`) [V].
  - Return opens the Low-importance sheet. It is grouped by sender, with a hover preview, per-sender Unsubscribe once List-Unsubscribe lands, a tap of **→** marks the highlighted row done like every list, and **holding →** (about 600 ms; the "Mark all N done" button fills while held) marks everything done (owner, 2026-11-15) [Carried graft]. On the button, "Hold" and its → keycap sit apart from "Mark all N done" behind a hairline divider and 8 px of air, so "Hold" never reads as part of the sentence (owner review of #548, 2026-11-17).
- **"Go one by one"** (S) is a quiet `--dim` text button on the Do now label. It opens each item in turn in the reader.
- **New mail** during activity waits under `hold`, then `arrive`s. Meanwhile a quiet "2 new" appears next to the Do now label.
- **Next-step toasts:** after Later, "Set a date · D". After Done on a Follow up item or a thread waiting on someone, "Remind me if no reply · R".
- **States:**
  - Loading (local): never a skeleton; the cached list paints.
  - First sync: §7.12. While an account is backfilling or paused, an empty Home shows "Your first mail is on its way." with the status slot's reason, never inbox zero.
  - Empty: the inbox-zero block (§7.14).
  - Cleared (Do now, Important updates and Follow up are empty, only the Low band is left): one small `--dim` line, "Nothing to do right now", exactly where the Do now label sits, then the band; no headline and no second line (owner review of #548, 2026-11-17).
  - No AI provider: rows show the subject alone (no summary after it), the focus letter shows the subject at `summary` size in SF (not serif), lanes come from the heuristics alone, and there is no error.
  - Offline: the status slot only.
  - Narrow (under 700 px of pane): the action row drops its labels, keeping the Space verb.

### 7.3 Later

*Mockups: `later.html` (later, bookmarks, drag), `later-picker.html` (default, calendar).*

- **Naming.** One name everywhere: **Later**. "Todo" and "Todos" are removed (§13).
- **Groups:** Overdue (a clock icon + `--stamp-ink` text, so colour is never the only cue), Today, This week, Someday. Group labels follow the section-label rule. Empty groups don't render.
- **Bookmarks** is the other half of a Later | Bookmarks `Puck` on the right of the `PageHead` row, not a mailbox.
- **Rescheduling.**
  - **D** opens `DatePresets`: 1 Today evening, 2 Tomorrow, 3 This weekend, 4 Next week, 5 Someday, then Pick a date. The digits are labels and always show.
  - **Drag:** the row lifts (`lift`), and each group becomes a drop target named by the time it resolves to ("Move to Tomorrow"). Overdue is never a target, because you can't reschedule into the past. The drop `snap`s and toasts with Undo.
  - The keyboard never requires dragging.
- **Empty:** "Nothing set aside for later."

### 7.4 All mail, Done, Drafts, Sent, Trash and Spam

*Mockups: `inbox.html` (default, bulk), `done.html`, `empty.html` (drafts, trash, spam).*

- **One list component, one row, no focus letter.** The cursor layer moves with `cursor`. Arrow keys only move the cursor here (decision 7).
- **Rows** follow §4.1's read and unread rules and the neutral keyboard cursor. No row carries an unread dot or an account dot (owner decision 2026-11-13).
- **Date groups** in All mail and Done use section labels.
- **Hover actions** overlay the date column and never reflow the row.
- **Bulk select:** X, ⇧X, ⌘A. The pane header shows "3 selected · Done · Later · Trash · More · Esc". Bulk-picked rows take `--accent-wash`. Destructive bulk actions use a two-row confirm and give an 8 s undo.
- **Per-mailbox details:** Drafts shows the edited time. Sent shows the recipients. Trash and Spam have Restore as their only quick action.
- **Empty:** one line in the pane ("No drafts.", "Nothing sent yet.", "Trash is empty.", "Spam is empty."). Drafts adds one quiet text action under its line, "Write a message" (C), in `--dim`; the line itself is `--ink` (owner review of #548, 2026-11-17). This fixes the inconsistency where only Spam kept its header [V: baseline §6.6].
- **Done** is the place for mail you finished.
  - Rows show a fixed stamp column: a quiet check named "Done" and the date as every other list writes it (time today, Yesterday, a weekday, then Oct 23), not "Done 9:41 AM" (2026-11-12 owner pass, #503; the real engine has no `done_at` yet, so the date is the last message date until it does). Rows group under the same date labels as All mail, and Drafts and Sent get date groups too. The only hover action is an icon-only "Move to Home" (H), placed to the left of the stamp so it never covers it.
  - E and L do nothing on done rows.
  - The sidebar item's tooltip says "Mail you finished. Press H to move one back to Home."
  - Search reaches it with `in:done`.

### 7.5 Reader

*Mockups: `reader.html` (default, earlier, pending, no-ai); `errors.html` (send-failed).*

```
‹  Home 1 of 9                                         ↑  ↓   ⋯   Ask   [calendar]
   Jordan Park  to you and Mina Cho                         ◷ Tomorrow   Friday
   Two layout directions are ready. Jordan wants your
   preference by tomorrow.                             (Newsreader 21/31)
   [↩ Reply  Space]    Later    Done
   A quieter home for the Hollow Creek site · 4 messages             (small, dim)
   3 earlier messages from Jordan, you and Mina                               O
   Jordan Park                                                         10:02 AM
   Hi Alex, …                                        (read 15/26, 64ch)
   [layouts.pdf]
   ┌ Reply to Jordan…                                                       R ┐
```

One 640 px column, top to bottom, with no card and nothing beside it (superseded for the email itself by the owner override of 2026-11-10 in §16: the email sits in one card):

1. **Sender line** (the reader card header keeps this order and adds the sender's monogram mark plus a "to …" recipients line by owner override, §16). The name in `title`, "to you and Mina Cho" in `--dim`, and on the right a due chip, if any, plus the time. There is no monogram. Hovering the name shows the address, the account, and the history with this sender (labelled as history, not trust).
2. **The big serif summary**, the same text as on Home. Hovering it shows "Summary by Groq".
3. **One action row.** The suggestion as the filled button (`Reply · Space`, or "Add to calendar" when a plan is the right next step), then Later and Done as text buttons. If the suggestion isn't a reply, R still replies. This removes the three "Reply" controls and the 54 px pill [V: baseline §6.2].
4. **The thread.**
   - A `--dim` line with the subject and message count.
   - Earlier messages collapse into one line ("3 earlier messages from Jordan, you and Mina"); O expands them, and O also shows quoted text.
   - Expanded messages are 36 px one-liners until opened. ↑/↓ moves between messages, and a 2 px accent rail follows (`cursor`).
   - The latest message has its header and a `read` body, then attachments.
5. **A quiet "Reply to Jordan…" field** (`ReplyStub`) with an R keycap.

- **Elsewhere:** bookmark, trash, forward and "Why it's here" live in ⋯ and ⌘K. "Why it's here" is one sentence, a quote from the mail, and the ⌥↑ / ⌥↓ lane corrections. "Important ▾" is gone from the header (`Reader.tsx:149-150`), except the reader card's Importance menu the owner asked for on 2026-11-10 (§16). The pane header shows previous/next, ⋯, Ask and the calendar button.
- **Threads.** J/K moves between threads with `swap` and the double buffer. ⌘F finds in the message.
- **HTML mail** renders in a sandboxed iframe with no scripts, on a light surface that keeps the email's own background even in dark mode. Plain text follows the theme. Remote images are off by default, with "Load images from this sender" (`gaps/electron-email-html-isolation.md`).
- **States:**
  - Summary pending: the subject in SF in the summary slot, breathing (`breathe`), until the summary lands in serif. (On Home's focus card the owner replaced this on 2026-11-13 with the quiet placeholder described in §7.2.)
  - No provider: the subject takes the summary slot in SF, and nothing else changes. "Couldn't summarize this email" is removed (`Reader.tsx:227`).
  - Body loading past 1.5 s: the previous letter stays, with a 12 px line.
  - Body failed: an `ErrorLine` in the column ("Couldn't load this email · Try again").
  - Attachment failed: the chip turns `--stamp-ink`.
  - Narrow: the column narrows to the pane; nothing folds, because nothing sits beside it.

### 7.6 Compose and inline reply

*Mockups: `reply.html` (reply, reply-all, dictating, sent), `compose.html` (new, ai-draft, polish, follow-up).*

- **Inline reply.** R, the `ReplyStub`, or Space on a reply suggestion opens one card (`--elev-card`, `settle`) under the message, so the thread stays visible:
  - the To line with its recipients, plus Cc and Pop out on the right;
  - the From account as a menu, only with two or more accounts: the reply starts in the thread's account and can switch to another (owner, 2026-11-16; it was plain text with no menu, 2026-11-13, #511);
  - the text in `read`;
  - Send (⌘↩), "Draft saved", and attach and ⋯ on the right.
  - While it is open, the composer owns the filled button, and the summary's suggestion becomes a text button.
  - Pop out moves the reply to the compose page.
- **New message** is a page in the pane, not a floating sheet. It is non-modal: the sidebar and the dock stay available.
  - **Header:** close (Esc), "New message", then ⋯ (schedule, discard) and Ask. **From** is a visible row under the header, only with two or more accounts; a new message starts in the current account, a reply or forward in the thread's, and each can switch (owner, 2026-11-16); it is no longer in the ⋯ menu (2026-11-12 owner pass, #500; changing it moves the draft to the other account and the old copy is removed only after the new one is saved).
  - **Body:** a To row, then the subject as a `heading`-sized field, then the text in `read`. Nothing decorates the top.
  - **Footer:** a hairline, then Send (⌘↩), "Draft saved", attach and format (⌘/).
- **Draft state** is one line: "Saving…", "Draft saved", "Couldn't save · Retry". After "Draft saved", Esc just closes. That fixes "✓ Saved" followed by "Save this draft?" [V: baseline §6.9 #3].
- **Send.** The composer closes (`settle` out), and the message `arrive`s in its thread with the `UndoTray`: a `--raised` line, "Sending to Jordan in 8 s · Undo Z · Send now", with a neutral 2 px bar that drains along its bottom (`undo-send`) and a static text countdown under reduced motion.
  - **One notice per send** [fixes baseline §6.9 #2]. With no visible thread, it is a single toast with the same words.
  - The undo-send options include the stored default (8 s) [fixes #1].
  - ⌘⇧Return sends and marks the thread Done.
- **Dictation:** hold Space in an empty body, or hold R from the reader. A small `--stamp` `LevelMeter` and one line appear: "Listening. Release R to keep, Esc to cancel." The text stays editable.
- **Blocked send** outlines the field and explains in one sentence. The shake is removed.
- **AI draft** is dim suggestion text at the caret, with the line "The gray sentence is a suggestion. Tab keep, Esc dismiss." Typing replaces it.
- **Polish** is a quiet bar, "Polish suggests 3 changes. Yours stays until you choose.", with an inline diff. It never overwrites your text.
- **Follow-up nudge** (§7.2): the same suggestion, with "Aplos drafted this follow-up from your last email. Tab keep, Esc dismiss." The mockup draws it on the compose page as a stand-in; in the app it opens as the inline reply.

### 7.7 Ask dock and Today

*Mockup: `ask.html` (answer, empty, working, no-provider, today).*

- **Placement.** A second pane, 360 px wide and 8 px from the main pane. It is **closed on first run** and remembered after that (decision 9). A, the Ask button or ⌘J opens it.
- **Header:** an Ask | Today segmented control on a `Puck`, then a close button. There is no glyph.
- **Empty:** the field placeholder "Ask about your mail or calendar". Below it are three plain suggestions and recent chats with times.
- **Conversation:**
  - Your question is one `base` 500 line, with no rule bar and no chat bubble.
  - Aplos's answer is serif `answer` prose directly on the pane, with the decisive fact at weight 500.
  - Citations are mono `[1]` chips that show the quoted sentence on hover and open the source on click.
  - Every answer cites its sources or says "No source in your mail".
- **While working:**
  - One steady line names the real step ("Reading 14 emails from Jordan"), then folds into a dim step log.
  - Input is never disabled. Follow-ups typed during streaming queue as small editable cards (⌘Return sends now).
  - Streaming shows one thin non-blinking caret, with no typewriter or blur.
- **Proposals** are the dock's one card and own the filled button. Each has a consequence line ("Add to Calendar · Thu 14:00–14:30 · Work") and two key rows ("Add, Return" / "Not now, Esc"). Nothing is applied without confirmation.
- **No provider:** "Ask needs a provider. Choose one in Settings." plus a link. No red error [V: `ask-no-key-error`].
- **Provider error:** an `ErrorLine` with Retry and "Use another provider".
- **Today tab** (the calendar button or ⇧A). A compact agenda: the next event, the following two, the free gaps, a now line and "Open Calendar". It replaces the 6 AM–11 PM grid that holds one event.

### 7.8 Calendar

*Mockups: `calendar-week.html` (default, overlap), `calendar-day.html` (default, empty), `calendar-event.html` (detail, rsvp).*

- **Top row.** The date ("October 2026") is a small `title` label with the day range beside it, because here it is information, not a heading. Today, previous/next and D | W | M sit on the right of the `PageHead` row. "Today" is a button.
- **Sidebar.** A `MiniMonth` and the "Calendars" list with colour swatches (§7.1). Out-of-month days use `--dim`.
- **Grid.** `--line` hairlines; 56 px per hour, so 8 AM to 8 PM fits. Today's column gets `--today-tint` and a filled accent date badge. The now-line is a 1 px `--stamp` line with a 5 px cap; it may cross event text, as Notion's does, because hiding it behind events made it nearly invisible.
- **Events.** Radius 6, a 2 px leading rule in the calendar colour, the fill from §4.2, the title at `small` 500 and the time in `--dim` (dark `--ink-2`).
  - Events under 30 minutes are one line, title only.
  - Three or more overlapping events show the first lane plus a "+N" stack that opens the stack. Lanes are never under 44 px.
  - Plans found in mail use a dashed 1 px outline and a "From mail" label until confirmed.
- **Fixes** [V: baseline §6.9 #6–8]: day titles get the comma ("Sunday, October 25, 2026"); Delete appears only on persisted events; hour labels use `caption` (11.5 px).
- **RSVP** starts with nothing chosen, and "Send reply" stays disabled until you choose. Y/M/N answer only while an unanswered invite is open; otherwise M means Month.
- **Motion.** D/W/M ride a `Puck` with transforms only. The existing FLIP, period slide and pinch zoom are kept (`calendarMotion.ts`) [V]. Drag to create, move or resize uses `lift` and `snap`.
- **Keys** are unchanged (§8).
- **Narrow** (pane under 720 px): an agenda list.

### 7.9 Command palette and search

*Mockups: `palette.html` (commands, filtered, confirm), `search.html` (results, no-match).*

- **Search is a page, not an overlay.** It has its own sidebar item and opens with `/`.
  - The field sits in the `PageHead` row at `heading` size, with a 2 px accent underline while focused.
  - Recognised operators (`from:`, `to:`, `subject:`, `has:attachment`, `before:`, `after:`, `in:`, including `in:done`) become removable pill tokens under the field.
  - Local results appear as you type, as ordinary rows; the Lists keymap applies. "Search all mail on Google · Return" sits under them. Remote Gmail search runs **only on Return**, to protect quota (`protocols/proto-google.md`).
  - **No match:** "No mail matches 'dentist'." plus "Search all mail on Google · Return". Without the Google offer the one action is "Clear search", a quiet text button in `--dim`. The line keeps the earlier no-match layout (the magnifier above one sentence, no hint) with the sentence in `--ink` (owner review of #548, 2026-11-17).
- **⌘K is the only overlay.** It is opaque `--float` with `--elev-float`, 600 px wide, centred on the window, with a light scrim, and it `settle`s. Typing `>` in Search switches to it.
  - The first line is a **context line** naming the target ("For: Drew Bell · October illustrations"), so commands know what they act on.
  - On first open it shows Suggested and Go to; everything else appears as you type, in Actions, Go to, Ask and Settings, each command with its keycap from the registry. Nested pages use breadcrumbs.
  - 1–9 run the Nth result, only while the field is empty.
  - Scoring order: exact, prefix, word boundary, then subsequence. Recent commands get a boost but never beat an exact match.
  - **Destructive commands default to Cancel:** Return cancels and ⇧Return deletes.
  - Esc goes up one level, then closes.
- **Acceptance:** every registry action is reachable here, the context line is truthful, and Esc never navigates.

### 7.10 Settings

*Mockups: `settings-appearance.html`, `settings-accounts.html` (default, reconnect), `settings-ai.html` (default, testing), `settings-keyboard.html` (default, recording).*

- **Layout.** A 180 px nav and a 600 px column, with no page title. The nav is aligned with the first group; today it starts 74 px low [V: baseline §6.2]. Group labels follow the section-label rule, and groups are 32 px apart.
- **Sections:** General, Mail, Calendar, AI, Notifications, Accounts, Keyboard, Help & about. Every setting is searchable from ⌘K.
- **Rows** are 40 px, or 48 px with a one-line description of what the setting *does* (`small` `--dim`). Hairline separators and a fixed control column on the right. Longer text goes behind a disclosure.
- **AI.**
  - The Features table comes first: Ask, Summaries, Drafts, Plans and Voice, each with a provider and model picker. Voice lists only speech-to-text providers (Groq, OpenAI).
  - Providers follow, in two groups: hosted (Groq, the default; OpenAI; Claude; Gemini; OpenRouter; OpenCode Go) and "On this Mac and custom" (Ollama, LM Studio, a custom OpenAI-compatible server, each with an editable address and its default port).
  - Each provider row shows its status and key source ("Key found in the environment as `GROQ_API_KEY`", the variable in mono, or "Saved in Keychain"; the onboarding AI step reads the same way). **Key characters are never shown.** Each has Test. A key from the environment shows Remove disabled, with the reason in a tooltip. Providers with no key show "Add key".
  - The privacy text sits behind a "How your mail is used" disclosure. It is the one privacy explanation in the app.
- **Keyboard.** Generated from the registry, with remapping, conflict marks, the single-key switch (WCAG 2.1.4) and "Show all key hints".
- **Accounts.** One name per account everywhere [V: baseline §6.6]. The connection state sits on the row. **Reconnect** appears on the row for `needsReauth`, `needsPermission` and when `reconnectBy` is within 24 hours, and opens the reconnect sheet (§7.1). The demo account has Reset and Remove.
- **Mail.** Undo-send options are 0, 5, 8, 10, 20 and 30 s.
- **Copy.** Every line in the voice of §10. "A comfortable place for your mail." becomes "Light, dark, or match the system."

### 7.11 Onboarding window

*Mockups: `onboarding-welcome.html`, `onboarding-accounts.html` (choose, typed, waiting, connected, icloud), `onboarding-ai.html` (groq, byok, local, consent), `onboarding-permissions.html` (default, granted).*

The window that PR #21 introduces stays unmerged until it is reworked. This is its target design. It includes the owner's wishes (a separate, smaller window; demo mail only from a small button; a fresh install with zero accounts and no demo data; plan 30 U8), and Appendix C maps every review finding to a rule here.

- **Window.** A separate window, smaller than the mail window, created by main on first run (no accounts) or from Settings → Help → "Show welcome". The mail window does not exist until handoff. 640 × 600, minimum 640 × 520, vertically resizable, with a hidden-inset title bar.
  - The whole window is white paper, full-bleed: no sheet, no card, no image.
  - The 48 px top strip holds the traffic lights and a small text button, "Try demo mail", on the right (a no-drag hit area of 24 px or more). Nothing else in the strip is interactive.
  - Steps are top-anchored inside a 64 px side margin and scroll inside the window. They never clip their top [PR21 F13], and headings never jump between states. Welcome alone is centred, with `justify-content: safe center`.
  - The footer holds the step dashes, "Setup continues in the background.", then the step's buttons.
  - Step titles are sans `heading`. More than about six controls on one step go behind "More options".
- **Steps,** shown as short dashes:
  1. **Welcome.** One `display` line, "Mail and calendar, one letter at a time.", one sentence, "Aplos puts the email that needs you on top, sums each one up in a line, and keeps every action on a key.", and one filled button, "Add an account" (Return). There is no icon. A fresh install has **zero accounts and no demo data**; demo mail loads only from "Try demo mail" (`Demo/load`), skips the first-sync screen, and can later be reset or removed in Settings.
  2. **Accounts.** Quiet rows for Google, Microsoft and other mail (IMAP, with iCloud's app-password path). You can add more than one. Round 1 (owner, 2026-10-27) shows only the Google row; the others return in round 2.
     - Typing an address + Return discovers the provider and **focuses the next primary control** ("Continue with Google") [F12].
     - OAuth shows "Waiting for Google in your browser…" with Cancel.
     - A connect that finishes after you've moved on **never pulls you back**. It quietly updates the accounts list [F9].
  3. **AI (optional).** Groq is preselected. The step shows the key source or a field, a Test button, "Skip for now" and one sentence. Your own key and a model on this Mac sit behind "More options". The consent card is the step's one card. Skipping never produces an error later.
  4. **Voice and permissions (optional).** Microphone, notifications and open at login as quiet rows, with holding A and holding R explained in one line each. Skippable.
- **Keys.** Return continues and each step focuses its main action. Esc goes back a step; on Welcome it means "Skip setup". Tab order is visual order.
- **Closing is always safe.**
  - Closing at any step, with or without a main window, ends the setup session in the engine, never leaves AI deferred, and backfills classification for mail already synced.
  - A connect that resolves after closing is classified normally [F1, F2, F5, F6]. These are engine contracts handed to the architecture plan as `Setup/end` and one-shot deferral; the UI must call `Setup/end` on every close.
- **Handoff to the mail window.** The mail window is created hidden and shown only on `ready-to-show`. The onboarding window fades out over 120 ms in the same callback, so there is no blank flash [F4]. With more than one account, the mail window opens on **All accounts** [F7]. A second app launch during startup never opens a second window [F3].

### 7.12 First-sync loading screen

*Mockups: `onboarding-sync.html` (progress, paused, ready, partial, failed), `onboarding-drill.html` (step1, step3, done).*

This is the screen shown after setup, before the inbox (the last step of the onboarding window), and also the screen for "Add account" from Settings. Under Gmail's quota it gates only on the newest mail (the first window, about 50 threads) and a time-capped sorting pass, never on the whole mailbox (plan 30 U8).

```
  Getting your mail
  ▰▰▰▱▱  jordan@gmail.com
  ✓ Connected
  ✓ Found about 214 recent emails      (only when the provider gives an estimate)
  ◐ Reading your newest mail · 24 of 50
  ○ Sorting what matters
  Google is asking us to go slowly. Your newest mail is ready now;
  older mail will follow.            Esc opens Aplos       [Open Aplos  Return]
```

- **Progress follows engine checkpoints, never a fake percentage.** The four segments are Connect → Find recent mail (a count only as "about N" when the provider gives an estimate, otherwise a quiet indeterminate bar) → Read your newest mail (n of the first window, never the mailbox total) → Sort what matters (summaries x of y, at most 40 and 60 seconds). Backfill is never part of the screen; the status slot takes it over after entering.
  - Segments are neutral: done is `--ink-2`, paused is `--dusk`, failed is `--stamp`.
  - The current step uses `status`. When a step shows "n of 50", the motion sits on the checklist marker, not the bar.
  - With no AI provider, the "Sort" segment is omitted rather than failed.
  - With several accounts, each gets a row with its own `ProgressSegments`, labelled with its address.
- **"Open Aplos" is enabled once the newest batch is in** (the Home candidates). Mail can never be stuck behind summaries.
- **Esc always opens Aplos,** and the screen says so ("Esc opens Aplos"). It works from the moment of Connect. Entering before any mail arrives opens Home with "Your first mail is on its way." and the status reason. Aplos opens by itself only on a clean finish; any pause, failure or partial pass waits for you.
- **Honest outcomes [F10]:**
  - Partial: "Sorted 12 of 40. The rest continue in the background." The word "Done" never appears for a capped or failed pass.
  - AI failure: "Couldn't sort with Groq: the key was refused. Mail is ready; sorting will retry." plus "Open Settings".
  - An account that was skipped or isn't connected shows "Not connected · Try again", never an endless "Waiting".
- **Rate limits.** The first real Gmail sync hit a 403 from per-user quota (CONTEXT; `protocols/proto-google.md`). The screen says "Google is asking us to go slowly. Your newest mail is ready now; older mail will follow.", plus the resume time if known. A raw error is never shown.
- **Try the keys (optional, from Instrument).** "Try the keys while you wait": a 30-second drill on demo letters (J/K, Space, E, A), each step with its keycap. It is a mode of this screen, so the progress stays visible. It is skippable and never blocks.
- **Failure.** "Some mail didn't come through" lists each account's plain reason with Try again. Each reason shows its icon in `--stamp-ink` and the sentence in ink. **Esc = "Continue to Aplos"** and it works, because the screen owns Esc on this step [F8]. Retry is idempotent: a second run never collides with the first [F5].
- **Accessibility [F11].** There is no `aria-live` on the list. One visually hidden `role="status"` announces only phase changes (connected, found, ready, failed). Every progress bar is labelled "jordan@gmail.com sync".
- **Ready.** The segments collapse into a drawn 40 px check and "Your mail is ready". It is static under reduced motion. The same component serves "Account connected" and the status slot's "Importing N of M".

### 7.13 Toasts, trays and notifications

*Mockup: `toasts.html` (stack, pending, remind, offline).*

- **Stack.** Toasts stack bottom-centre of the *main pane*, never under the dock, up to three. They are opaque `--float` with `--elev-float`, radius 12, `ui` text, 440 px wide and growing to fit their words up to 560 px (a sender's name is never cut while it fits). Hover or focus pauses them. Plain toasts last 4 s; Undo toasts last 8 s, then fade over 400 ms.
- **Deck** (owner review of #548, 2026-11-17). The stack is a deck: the newest toast in front at the bottom, the older ones peeking 12 px above it each, a little smaller (5 % a step), at most two peeking; their words show only when the deck opens. Pointer over the deck or keyboard focus inside it fans it out into the full list (the `close` motion; under reduced motion it switches between the folded and open states with no animation) and holds every toast's clock while it is open. Each toast otherwise leaves on its own timer, measured from when it appeared, one by one; the cards behind close up as it goes. The fan is the one place hover moves something: an owner exception to §3 principle 11 and §5 rule 17, and it moves only the toasts (transform and opacity), never the pane under them.
- **Wording follows the op queue:**
  - Pending: "Archiving…"
  - Confirmed: "Done · Undo Z"
  - Destination named: "Moved to Later · Set a date D · Undo Z"
  - Lane correction: "Moved to Important updates · Always do this for Parcel Trail · Undo Z"
  - Offline: "Saved here · will sync"
- **Rules.**
  - One operation, one notice.
  - An Undo toast is never silently replaced; new toasts stack, Done, Later and Trash included (the one-slot triage toast tried in UI council 2 was rejected in the owner review of #548, 2026-11-17). Triage toasts name the sender ("Done · Jordan Park"), and Z undoes the newest operation first, then the one before.
  - Toasts never appear for navigation, successful saves or sync ticks.
  - They are announced politely and never steal focus.
- **First launch** shows one toast, once: "Hold ⌘ to see keys." It makes up for key hints living in tooltips.
- **Sends** use the `UndoTray` at the message, not a toast, unless no thread is visible.
- **macOS banners:** the sender as title, the summary as body, and actions Reply / Later / Done. Only for Do now and Important updates; per account; never for Low importance.

### 7.14 Empty states

*Mockup: `empty.html` (inbox-zero, first-mail, no-accounts, drafts, trash, spam).*

Each is one plain sentence plus at most one action. There is no icon in a circle and no illustration.

| Where | Copy | Action |
|---|---|---|
| Home (inbox zero) | A calm block centred in the pane: `display` "You handled 12 emails.", then "Next: Design review at 2:00 PM" in `--dim` | Undo last · Z, shown for 8 s |
| Home during first sync | "Your first mail is on its way." with the status reason | none |
| No accounts | "Add an account to bring in your mail." | Add an account · Try demo mail |
| Later | "Nothing set aside for later." | none |
| Bookmarks | "No bookmarks. Press B on any email." | none |
| Done | "Nothing done yet." | none |
| Drafts / Sent / Trash / Spam | "No drafts." / "Nothing sent yet." / "Trash is empty." / "Spam is empty." | Drafts: a quiet Write a message · C; the others none |
| Search | "No mail matches 'dentist'." | Search all mail on Google · Return; without the offer, a quiet Clear search |
| Ask | Suggestions + recent chats | n/a |
| Calendar day | "Nothing scheduled." | New event · N |
| Low importance | "No low-importance mail." | Back to Home |

Sidebar counts hide while first sync runs.

### 7.15 Error states

*Mockups: `errors.html` (reconnect, quota, offline, row-error, send-failed), `fatal.html`.*

Every error says what happened, what is safe and what to do. There are no exclamation marks and no stack traces.

| State | Where | Copy | Action |
|---|---|---|---|
| Reconnect due | Status slot + account row | "Gmail will ask you to reconnect tomorrow at 9:00 AM." | Reconnect now |
| Sign-in expired | Status slot + account row | "Google needs you to sign in again." | Reconnect |
| Permission missing | Status slot + account row | "Aplos needs permission to read your Gmail." | Reconnect |
| Rate-limited | Status slot | "Google asked us to slow down. Resuming at 2:14 PM." | Retry now |
| Offline | Status slot | "Offline · 2 changes waiting" | none (drains automatically) |
| Write rejected | Inline on the row, which returns to place | "Couldn't move to Later." | Retry |
| Send failed | Under the message in the reader | "Couldn't send to Jordan. Your draft is saved." | Try again · Edit |
| Body failed | Reader column | "Couldn't load this email." | Try again |
| Attachment failed | Chip | "Couldn't download." | Try again |
| Summary failed / no provider | Nowhere on the mail surface | The subject takes its place; one line in Settings → AI | n/a |
| Ask failed | Dock | "Groq didn't answer." | Retry · Use another provider |
| Engine unreachable (fatal) | The whole pane | Sans `display`: "Aplos can't reach its mail engine." + "Your mail is safe on this Mac." | Restart engine · Copy diagnostics |

Both Reconnect actions open the reconnect sheet (§7.1). "Aplos needs a moment." and "Making room for your mail…" are retired (`App.tsx:472`). Startup with a local index shows the shell immediately, never a loading screen.

> **What this means:** Every screen keeps its job and your keys. The biggest visible changes are Home's new sections, the simpler reader, reply and compose, a real command palette, honest sending and an onboarding window that cannot get stuck.

---

## 8. Keyboard map

**Grammar.** Each key means one thing per context. Tap to act; hold the same key to say it. **Space is always the suggested action.** Places use ⌃ + a number, verbs are letters, and everything else is in the palette. There are no g-sequences: one grammar is calmer than two. Every binding is declared once in `CommandRegistry`.

| Context | Keys |
|---|---|
| **Global** | ⌘K palette · / search · C compose · A Ask (hold A: dictate to Ask) · ⌘J toggle dock · ⇧A Today · ⌘, settings · [ sidebar / minimised menu · ? shortcuts · Z undo · ⌃1–8 Home, Later, All mail, Drafts, Sent, Calendar, Trash, Spam · ⌘⌥L skip to list · ⌘⌥R skip to reader · Esc ladder: close transient → clear selection → back (never closes the window) |
| **Lists** (Home, Later, All mail, Done, search) | J/K or ↓/↑ move · Return or O open · **Space suggested action** · E Done · L Later · D due date · B bookmark · U read/unread · # trash · R / ⇧R / F reply / reply all / forward (hold R: dictate a reply) · X / ⇧X / ⌘A select · . more · I why it's here · ⌥↓ move down a lane · ⌥↑ move up a lane · Tab / ⇧Tab next or previous section · S go one by one |
| **Home and one by one only** | → Done · ← Later (sides follow the swipe-direction setting) |
| **Done place** | H move to Home (E and L do nothing) |
| **Reader** | Everything in Lists, plus → / ← triage · J/K next/previous thread · ↑/↓ previous/next message · O earlier messages and quoted text · ⌘F find · Esc back |
| **Compose** | ⌘Return send · ⌘⇧Return send and Done · hold Space in an empty body: dictate · Tab keep the suggestion · Esc dismiss the suggestion, then close (no prompt if saved) · ⌘B / ⌘I / ⌘U · ⌘⇧C Cc/Bcc · ⌘⇧A attach · ⌘/ format menu |
| **Ask** | Return ask · ⌘Return search all mail · ↑/↓ suggestions and history · ⌘N new chat · Return / Esc on proposals · Esc stop → clear → close |
| **Calendar** | T today · D / W / M views · J/→ and K/← period · N new · Return open · E edit · ⌫ delete (8 s undo) · Y / M / N answer an open invite · ⌥-click solo calendar · pinch or ⌘-scroll zoom |
| **Palette, menus, date picker** | ↑/↓ · Return · 1–9 pick (palette: only while the field is empty) · ⇧Return confirm a destructive command · Esc up a level, then close · date presets 1–5 |

**Changes from today** [V: baseline §5]:

- Space stops meaning four things. Reply moves to R everywhere, and the reader's Space runs the suggestion.
- Arrow triage is limited to the single-letter screens.
- ⌘K becomes a palette, and Search becomes a page.
- "Not important" and "Always Home" become one lane step down or up (⌥↓ / ⌥↑).
- The sheet is generated from the registry, so it can no longer omit ⌃5, ⌃7, ⌃8, ⌘K or ⌘/. It has three columns and scrolls when it must.
- The `keys.s` double assignment disappears.

**Discoverability** (decision 8). Keycaps appear in tooltips (label plus keys), as small badges while ⌘ is held, in the palette and in toasts, and inline everywhere with "Show all key hints". Hover never reveals one. Main actions always show their key: Space in the mail window, Return in onboarding and dialogs, ⌘↩ on Send.

> **What this means:** Most of your keys stay. Space does the smart action, R replies, holding a key dictates, and ⌥↑ / ⌥↓ fix where Home put something. The help sheet always matches the real keys.

---

## 9. How AI appears

| # | Rule |
|---|---|
| 1 | **The voice is the mark.** Summaries and Ask prose are set in Newsreader. No glyph, badge, label, colour or glow says "AI". |
| 2 | **Suggestions wear their action's icon** (reply, calendar, link, paperclip, cart, phone). The verb is literal: "View invoice", "Reply with times", "Add to calendar", "Reply with a nudge". |
| 3 | **Working = breathing text.** The pending line shows the subject in SF and breathes (`breathe`, `--ink-2`) until the summary lands (on Home's focus card, from 2026-11-13, a quiet two-line placeholder with "Summarizing…" instead). There is no gradient glimmer (`styles/reader.css:82-94`, `styles/focus.css:330`), no pulsing dot, no shimmer, no typewriter and no per-character blur. |
| 4 | **Reasons on request.** "Why it's here" (⋯ or I) gives one sentence and a quote from the mail, with ⌥↑ / ⌥↓ lane corrections that write deterministic sender rules and confirm with an Undo toast. Model names, scores and schema stay behind a developer toggle. |
| 5 | **Provenance on hover only:** "Summary by Groq"; local models say "on this Mac". A due date the AI found says "from the email". |
| 6 | **Drafts are ordinary text.** AI drafts and follow-up nudges are dim, editable suggestions with Tab / Esc and neutral controls. Polish is a diff that never overwrites your text. Nothing sends or writes to the calendar without a confirmation row. |
| 7 | **Absence is quiet.** With no provider, the subject takes the summary's place, Home sorts by heuristics, follow-ups open an empty reply, there is no error on the mail surface, and one line appears in Settings → AI. |
| 8 | **Banned in every form:** sparkles, wands, stars, the `apple.intelligence` glyph, brains and robots, purple gradients, rainbow or animated borders ("beams"), shimmer, and the words "magic", "AI-powered", "smart" as a label, "Copilot" and "Beta" badges. Enforced by lint on icon names and UI strings (§12.2). |

> **What this means:** Aplos speaks in a serif typeface and gives a plain "because" line for its suggestions, never a glowing icon. With AI off, nothing looks broken.

---

## 10. Voice and microcopy

**Rules.** Say what a thing does, not how it feels. Buttons are verbs ("Send", "Reconnect"), never "OK". No exclamation marks. Errors say what happened, what is safe and what to do. Summaries are third person with the action and date folded in. There is one privacy explanation, in Settings → AI.

**Home's labels:** "Do now", "Back from Later", "Important updates", "Low importance", "Follow up", and the action "Reply with a nudge".

| Today | Replace with |
|---|---|
| "Swipe through them" | "Go one by one" |
| "Hold to talk" (reader pill, Ask pill, compose) | Removed from controls; tooltips say "Hold A to dictate" / "Hold R to dictate a reply" |
| "Tap to write · hold to talk" | "Reply · R. Hold R to dictate" |
| "Todo", "Todos", "Moved to Todo", "Move to Todo", "keep it as a Todo" | "Later", "Moved to Later", "Press L to set an email aside" |
| "Hide all" | "Clear from Home" |
| "Ready when you are" / "Waiting on you" / "No reply yet" | "Back from Later" / "Do now" / "Follow up" |
| "Ask me anything" | "Ask about your mail or calendar" |
| "Your day beside your mail" | "Today" |
| "All clear for now" | "You handled 12 emails." |
| "A comfortable place for your mail." | "Light, dark, or match the system." |
| "Aplos is ready when your day begins." | "Open Aplos when you log in." |
| "Make light work of your inbox." / "A few useful things" | "See every shortcut." / "Help" |
| "A little less inbox. A little more life." | "Version 0.3.0 · macOS" |
| "Making room for your mail…" / "Aplos needs a moment." | (no loading screen) / "Aplos can't reach its mail engine." |
| "Couldn't summarize this email · Groq isn't set up" | (nothing; the subject shows) |

These phrases are on the lint ban list (§12.2): "Swipe through them", "Hold to talk", "Hide all", "Todo", "Be here now", "Sent with", "Ask me anything", "magic", "AI-powered".

> **What this means:** Every phrase that echoed Avec is replaced, and the app uses plain wording instead of an assistant's voice.

**Shell and screens wording (owner OK'd 2026-10-29 with the ui-shell and ui-home approval; the strings are already in the code, see `shell/states.tsx`, `shell/failure-copy.ts`, `shell/SheetHost.tsx` and `screens/**`).**

| Where | Wording |
|---|---|
| List could not load | "Couldn’t load this list." with "Try again" |
| A write was refused | "Couldn’t " + the action: "mark it done", "move to Later", "move to Trash", "move it"; also "Couldn’t save that. Nothing changed." and "Couldn’t move it." |
| Delete or discard refused | "Couldn’t delete that. It is still here." / "Couldn’t discard the draft. It is still saved." |
| Engine unreachable | "Aplos can’t reach its mail engine." / "Couldn’t restart. Your mail is safe on this Mac." |
| Diagnostics | "Diagnostics copied" / "Diagnostics copied. They hold no mail." / "Diagnostics exported" / "Couldn’t get the diagnostics." |
| Reconnect sheet failures | "That was a different account. Sign in with the same one.", "Sign-in was canceled. Nothing changed.", "Sign-in timed out. Nothing changed.", "Couldn’t reconnect. Your mail is safe here and local changes are kept." |
| Confirms | "Delete this email forever?" (button "Delete forever"); "Discard this draft?" (button "Discard") |
| Toasts | "Bookmarked", "Bookmark removed", "Reminder set", "Restored", "Deleted forever", "Draft discarded", "Moved to Home", "Account added" (after Add an account connects) |
| Spam quick action | "Not spam" (this replaces "Restore" for Spam) |
| Fallbacks | "No sender", "No recipient", "No subject", "No mail here yet." |
| Later row action | "Change date" |
| Places not built yet | "<Place> isn’t in this build yet." (temporary; remove once every place exists) |

A wording change to any of these is a visible change: re-show the owner.

---

## 11. Accessibility

1. **Contrast.** All text is 4.5:1 or better, and non-text 3:1, in both themes and in Increase Contrast, with one exception at rest: text-field rings (decision 20), which switch to the 3:1 edge under Increase Contrast. This is enforced by CI on every declared pair (§12.4). Colour is never the only signal: Done is a check plus a word, Later a clock plus a word, overdue an icon plus text, unread weight and ink (and the words "Unread" for screen readers; no dot since 2026-11-13), a plan a dashed outline plus a label, and a found due date a hover note.
2. **Focus.** A 2 px `--accent` ring with a 2 px gap (7.84:1 light, 7.61:1 dark), 3 px under Increase Contrast. It is never removed; the search field shows its focus as a 2 px accent underline. Focus is never lost on commit, view change or dock toggle; it moves to the next row, the reader's back button, or the palette input.
3. **VoiceOver.**
   - Lists are a `listbox` with `aria-activedescendant`, and the reader is an `article` with landmarks for the summary and the message.
   - Home's section labels are group headings.
   - The palette is a `combobox`, and the calendar is a `grid` with text equivalents.
   - After a triage key, one polite announcement says what happened and what is next.
   - Toasts are polite and never steal focus. Progress announces phases only (§7.12).
   - Icon-only buttons have labels and tooltips.
4. **Keys.** Every pointer path has a key. Single-key shortcuts can be switched off (WCAG 2.1.4), and every key can be remapped. Dictation always has a typed equivalent. The IME rules are in §5 rule 16.
5. **Motion.** Reduced motion uses the "Reduced" column in §4.8 (opacity at most 120 ms, no travel; spinners stay). (Reading the two together: the `status` runner, the 30 % segment sliding in its track, goes static under reduced motion and rests as a centred 30 % bar; the small `Spinner` glyph keeps turning, because it is the only sign that work is running and it travels nowhere.) Nothing flashes more than 3 times a second. Hover never moves layout (§5 rule 17).
6. **Size.** Everything is in `rem`, and 200 % zoom works down to the 900 px minimum window. Nothing is under 11 px. Targets are at least 24 px (28 px default).
7. **Checks.** An axe scan of every harness state in both themes, a keyboard-only walkthrough of ten core tasks, and manual VoiceOver passes for Home, the reader, compose, Ask, the calendar and onboarding. Japanese and Chinese IME tests.

> **What this means:** The calm look follows accessibility rules, and automatic checks enforce each one. The one exception, faint field outlines, is your call in question 20.

---

## 12. Enforcement

### 12.1 One source of truth

`ui/tokens.json` (W3C token format) generates `tokens.css` (light, dark and increase-contrast blocks), `motion.ts` (durations, easings and spring solvers, with each `linear()` string generated from its spring), and `contrast-pairs.json`. The generator is a small script in `apps/desktop/scripts/`. Hand edits to generated files fail CI.

### 12.2 Lint rules

These run in `npm run lint`, in pre-commit and in CI. Exempt files: the token sources and generated files only.

| Rule | Tool | Fails on |
|---|---|---|
| No raw colour | stylelint `color-no-hex`, `function-disallowed-list: rgb, rgba, hsl, hsla, oklch, lab`; ESLint `no-restricted-syntax` on string literals matching `/#[0-9a-f]{3,8}\b/i` or `rgb(`/`hsl(` in `.ts/.tsx` | any colour not written as `var(--…)` |
| No decoration or glass | stylelint `function-disallowed-list` for `linear-gradient` and `repeating-linear-gradient`, `property-disallowed-list` for `backdrop-filter`, and `selector-class-pattern` rejecting `post-edge`, `airmail` and `skyscene`, in app CSS (`apps/web` is excluded until its redesign) | any gradient, blur or old decorative class |
| No literal durations or easings | stylelint `declaration-strict-value` on `transition*`, `animation*`; ESLint rule on `.animate()` / `setTimeout`-driven motion requiring `motion.ts` imports | `ms`, `s` or `cubic-bezier(` outside tokens |
| No layout-property motion | stylelint `declaration-property-value-disallowed-list` for `transition`/`transition-property` containing `all`, `width`, `height`, `padding`, `margin`, `top`, `left`, `right`, `bottom`, `inset`, `flex-basis`, `grid-template`, `font-size`, `border-width`; a custom plugin that rejects those properties inside `@keyframes` and in WAAPI keyframe objects | any layout property animated |
| Reduced motion covered | custom stylelint plugin | a `@keyframes` or `animation` not neutralised by the generated reduced-motion block |
| No literal spacing, size, radius, shadow or z-index | `declaration-strict-value` on `padding*`, `margin*`, `gap`, `font-size`, `line-height`, `border-radius`, `box-shadow`, `z-index` (allows `0`, `1px` hairlines, `100%`, `auto`) | literals |
| No `will-change` in static CSS | stylelint `property-disallowed-list` | `will-change` in a stylesheet (only `motion.ts` sets it while animating) |
| Banned glyphs | ESLint `no-restricted-imports` / `no-restricted-syntax` for the icon names in §4.7 | any sparkle, wand, star or brain icon |
| Banned strings | ESLint rule over JSX text and string props, case-insensitive, for §10's list | any banned phrase |
| Button idioms | ESLint: `Button` `variant` ∈ {filled, text, icon}; at most one `filled` per route (a harness check, §12.5) | other variants |

### 12.3 The `aplos-design` skill

The path is `.claude/skills/aplos-design/SKILL.md`, with an `AGENTS.md` rule: "Before touching `apps/desktop/src/renderer` or `apps/web`, load `aplos-design`." This is the method Redakt uses for its agents [V: `ui/redakt.md` §6.2]. The T3 UI threads' briefs repeat the rule. The skill contains:

1. The twelve principles (§3) and the not-Avec test (§2.3).
2. A token cheat-sheet: the colour roles, the ten type roles, spacing, layout, radius, elevation, and the 23 motion names with when to use each.
3. The 17 input rules (§5) and the budgets.
4. The component inventory (§6), with "compose, don't invent".
5. Home's sections and ordering (§7.2), the AI rules (§9), and the voice rules with the replacement table (§10).
6. Forbidden patterns: every banned item in §2.4, §4.7, §9, §10 and §14.
7. Where to look: `mockups/` is the visual target, and each §7 section names its mockup.
8. **A definition of done for a UI change:**
   - lint is clean;
   - `npm run test:visual` passes, including the hover-shift check, or its baselines are updated with a reason;
   - `npm run test:perf` passes for touched interactions;
   - contrast CI passes;
   - before and after screenshots, headless, both themes, are attached to the PR.
9. How to verify headlessly. Never drive a visible window (owner rule).

The skill is versioned with the tokens. A token change that doesn't touch the skill fails a CI check that compares the token names listed in the skill against `tokens.json`.

### 12.4 CI contrast and identity checks

- **Contrast.** `scripts/check-contrast.mjs` reads `contrast-pairs.json` (fg, bg, min, usage) for light, dark and increase-contrast. Translucent tokens are composited over their declared background. Every pair must meet its WCAG 2.x minimum (4.5 text, 3.0 large or non-text). APCA Lc is reported as advisory. The pairs in §4.1 are the initial set, including `--dim` on `--accent-wash`, the dark event fill (where times use `--ink-2`) and the mini month's out-of-month days. A new token can't merge without declaring the pairs it's used in. The field ring at rest is declared as an accepted exception (decision 20).
- **Identity.** The same script computes ΔE00 between `--accent`, `--hill`, `--dusk` and `--stamp` (both themes) and a reference list kept in the repo (Avec `#0050ff`, `#07aa04`, `#03ce4c`, `#36b7ff`; Spark, Missive, Mimestream, Airmail, Shortwave, Canary and Apple blues from `identity-collision-audit.md` §4). Any distance under 8.5 fails. The shell must have Lab b* < 0 in both themes.

### 12.5 Headless screenshot regression harness

- **Driver.** Playwright. Use `_electron.launch` with the window created `show: false`, plus offscreen capture via `webContents.capturePage()`, for the desktop app. Use headless Chromium for the browser preview. Never use a visible window (owner rule). `mockups/shoot.cjs` is the working prototype of these checks.
- **Isolation.** Each run uses a temporary `APLOS_DATA_DIR` seeded with the original demo data, its own API and Vite ports, and no AI keys unless a scenario injects a mock provider.
- **Determinism.** A frozen clock (`2026-10-29T10:00`), bundled fonts, the locale fixed to en-US, the cursor hidden, and caret blink off.
- **Onboarding.** The harness handles the onboarding window explicitly, by seeding `onboardingDone` or driving it. This fixes the PR #21 lesson where the website capture script stalled on the new window [F14].
- **Matrix.** Each state in §7 (about 90 named states, listed in `tests/visual/states.ts`) × {light, dark} × {1440×900, 1100×760} × {default, Increase Contrast for a 20-state subset}.
- **Diffing.** Pixel diff with a ΔE > 2 threshold. A diff of more than 0.1 % of pixels fails, and failures are reported with an overlay image. Baselines are committed under `tests/visual/__baselines__` as an internal fixture; they are never attached to PRs as-is.
- **Hover-shift check.** On every state, hover up to 90 interactive elements one at a time and fail if any other element's box moves by more than 0.5 px (§5 rule 17).
- **Motion filmstrips.** For the signature motions (`commit`+`flight`, `carry`+`hold`+`close`, `deal`, `undo-send`, `dock`, `slide`), pause the document timeline and step `Animation.currentTime` to 0, 30, 60, 120, 220 and 400 ms. Capture each frame, then diff the strips.
- **DOM assertions alongside the pixels:**
  - the §2.3 not-Avec checks, including "single reading column";
  - one filled button per route;
  - no element with a computed `transition-property` that includes a layout property;
  - no element with a gradient background or `backdrop-filter`;
  - no text under 11 px;
  - axe with no serious violations;
  - no banned strings or icons.
- **Commands:** `npm run test:visual` and `npm run test:visual -- --update` (requires a reason).

### 12.6 Performance budget suite

`npm run test:perf` runs in the **packaged** build. The renderer is driven by synthetic key events through CDP, against a 10k-thread fixture store. It measures with the Event Timing API and `PerformanceObserver` for long animation frames, and asserts the §5 budgets at p95 over 50 runs. Results are recorded to `tests/perf/history.json`. A slowdown of more than 10 % against the 7-day median fails.

> **What this means:** Lint rules block raw colours, gradients, literal timings and layout animation. Automatic contrast, Avec-distance, hover-shift and screenshot checks run before anything merges.

---

## 13. Avec-derived layouts and wording to remove

The root cause is that `DECISIONS.md:125` set "Visual parity (M14)" to reproduce "the reference's measurable look (layout sizes, spacing, radii, palette values, translucency…)", and `DECISIONS.md:129` set "Interaction parity (M16)" to follow its timings [V]. **Both decisions are superseded by this spec.** `DECISIONS.md:128` still claims matching phrases were rewritten; the items below show they weren't. Line numbers are from `apps/desktop/src` at 27cf52f [V: grep], with the Avec evidence beside each.

| # | Avec-derived element | Where in Aplos | Avec evidence | Replacement |
|---|---|---|---|---|
| 1 | "Swipe through them" pill next to the "New" header | `renderer/App.tsx:498` (used at :510) | `seg/t0174.2.png` (same pill, key N) | "Go one by one", a quiet `--dim` text button on the Do now label, key S (§7.2) |
| 2 | Floating bottom cluster: bookmark · ← Todo · big blue Reply/Space/"Hold to talk" pill · Done → · Undo circle | `renderer/Reader.tsx:175-186` (also the binned variant), `:69` and `:84-89`; `styles/reader.css:313-321` (`.reader-dock`, `.dock-pill` 44 px, radius 28) | `seg/t0176.3.png` | The reader's one action row under the summary (§7.5); bookmark in ⋯; Undo in toasts |
| 3 | "Hold to talk" under Reply; "Tap to write · hold to talk" | `Reader.tsx:89`, `:84` | `seg/t0176.3.png` | Tooltip only: "Hold R to dictate a reply" |
| 4 | Top-right Ask pill with magnifier, "A" and "Hold to talk", plus a Calendar pill | `components/Topbar.tsx:22-23`; `styles/ask.css:10-28` | `seg/t0176.3.png` (same pill) | Pane header buttons: speech bubble + "Ask", and the calendar icon button (§7.1) |
| 5 | "Hold Space to talk" in compose | `renderer/Compose.tsx:417` | Avec voice drafting (`ui/avec.md` §5) | Hint only in the tooltip and the `?` sheet |
| 6 | "Todo / Todos" naming | `App.tsx:25`, `:40`, `:534`; `Reader.tsx:68-69`; `components/MailList.tsx:360`; `components/Overlays.tsx:26` | Avec's Todo pill and Todos tab (`ui/avec.md` §2) | "Later" everywhere |
| 7 | "Hide all" on the returned-todos section | `App.tsx:510` | `ui/avec.md` §2 ("Hide all") | "Clear from Home" on the Back from Later label |
| 8 | Two reply sections on Home ("Waiting on you", "No reply yet") mirroring Avec's needs-reply and awaiting-reply sections | `App.tsx:510`; `shared/mailbox.ts:15` | `seg/t0174.2.png` | Do now, Important updates and Follow up, sorted by what the mail asks of you (§7.2); Done leaves Home (decision 6) |
| 9 | Stack heading "Home 1 of 8" above a centred card with the **next card's sliver** behind it | `Reader.tsx:137-138`; `styles.css:331-332` (`.deck.has-next::before`) | `seg/t0176.3.png`; `ui/avec.md` §2, §7 | A small crumb in the pane header; one reading column, no deck, no sliver |
| 10 | "Important ▾" dropdown + ⋯ in the card's top-right header | `Reader.tsx:149-150` | `seg/t0176.3.png` | ⋯ → "Why it's here", with ⌥↑ / ⌥↓ lane corrections (§7.5) |
| 11 | Card toss with rotation (fling) and return-with-rotate | `styles.css:343-360` (`rotateY(±14deg) rotate(±4deg)`), `:333-336` | `ui/avec.md` §4 rows 1, 5 | `flight` with a 2° tilt and no 3D (§4.9) |
| 12 | Low-importance bundle as a count badge + comma-joined sender list | `App.tsx:510` (`.low-line`); `styles/focus.css:226-243` | `seg/t0174.2.png` | The band in §7.2 (count on the right, at most three names, "and N more") |
| 13 | Warm-grey canvas with white cards and a system-like blue | `ui/tokens.css:93-94` (`--canvas #e5e4e1`, `--card #fff`), `:108-112` (`--blue #0682fe`, `--green #0a9c0a`), dark `:161-179` | `ui/avec.md` §3; audit §4 | §4.1 tokens: a cool-neutral shell, one white pane, ink blue |
| 14 | Pill buttons with inline keycaps on every control (B, Later ←, Done →) | `components/MailList.tsx` card actions; `Button variant="pill"` (`App.tsx:498`) | `seg/t0174.2.png` hover pills | 8 px rectangles; keycaps in tooltips, ⌘-held badges or the setting, never on hover (decision 8) |
| 15 | The "armed" bar pill growing to 1.06 during a swipe | `styles.css:379-382` | Avec's gesture-button coupling (`ui/avec.md` §6 #3) | The *idea* is kept: the matching action-row button takes the action colour while armed, with no scale and no pill |
| 16 | "Ask me anything" with a "Hold A to talk" hint in the field | `Ask.tsx:255-256`, `:261`; `App.tsx:549`; `components/Overlays.tsx:10` | `ui/avec.md` §2 (Ask empty state) | "Ask about your mail or calendar"; hint in the tooltip |
| 17 | Welcome copy teaching "Hold it to talk" | `components/Welcome.tsx:55`, `:122` | Same phrase family | Welcome is one line, one sentence and one button (§7.11) |

**Behaviours kept on purpose** (your model, with new looks and words): one letter at a time, Space runs the suggestion, hold to dictate, the docked Ask, the big summary, sender first, the low-importance bundle with its own background, Later grouped by date, the D due-date toast, hold → to mark all, and rapid-mode timing.

> **What this means:** These 17 items make today's screens look and read like Avec. All of them go in the first build of each screen, and an automatic check stops them returning.

---

## 14. What not to copy from each reference

| Reference (licence) | Never copy | What we take as an idea |
|---|---|---|
| **Avec** (proprietary) | Everything in §13. Also its warm canvas + white card + system blue; full-card colour floods; the 12° toss; the deck sliver; "Swipe through them", "Hold to talk", "Hide all", "Todo", "Be here now"; sparkles on Polish and Due; the default "Sent with" signature; the ocean video and sorting game; needs-reply mailboxes; split view | Rapid-mode timing, unmistakable commits, next-step toasts, → → confirmation by repetition, drag-to-reschedule, a visible learning loop |
| **Notion and Notion Calendar** (proprietary) | Any asset, icon, illustration, wording or exact layout; their page-title-and-cover pattern; their emoji page icons | A neutral gray shell with one white page, generous white space, strong type hierarchy, quiet chrome, secondary actions behind ⋯, a mini month and calendar list in the sidebar |
| **Tatem** (proprietary) | Hold-Space peek (Space is ours); translucent-everything wallpaper in a native app; 35–55 % text on gradients; scroll theatre; abstract decorative scenes; raw shadcn defaults | Instant lists, one selection spring, four doors per action, key rows in confirmations, two-layer shadows |
| **Zero** (MIT, ideas only) | Sparkles, purple borders, shimmer, per-character blur, the summary behind a pill, a 40 % floating chat, red/green Accept-Reject, overloaded letters, remote images and a branded signature on by default | Folding step logs, operator tokens, neighbour prefetch, queued follow-ups |
| **Redakt** (MIT; skill pack licence unverified) | The rainbow border beam; Generate overwriting typed text; threads as tabs; a fixed 1 s hold; width/height composer animation; the glossy orange Compose; meaning-free rows | The lighting model (0.75 px rings, top sheen, pane lighter than shell), the undo line under the sent message, agents loading a UI skill |
| **Superlocal** (no licence; engineering ideas only) | Any visual: it clones Superhuman and ships scraped fonts and icons (charcoal and lavender, ink bar, "Get me to zero", bolt glyph); removed focus rings; model internals in user text; a single toast slot that eats Undo | Pinned rows during bursts, honest "Marking…" states, spinners after 150 ms, a pure, table-tested shortcut resolver |
| **Inbox Zero Mail** (AGPL + terms, ideas only) | The Gmail-clone row with chip runs; a list/split toggle; sparkle and wand glyphs; solid blue tooltips; linear-eased panels; a compose window with no origin | Focus moving in the same frame as the action, the double-buffered reader, one registry feeding tooltips, help and toasts |
| **Airmail (Bloop)** | The name in any public use; the airmail stripe in any form; sky + planes + clouds line art | Nothing |
| **Aplos v0.2.3 itself** | Glimmer, rainbow avatars, icon-in-circle empties, glass pills, assistant-voice copy, view-switch rises, pure black, the 0.46 fade floor, the airmail stripe | Optical tracking, exits faster than entrances, the calendar's interruptible FLIP, sidebar hover hints |

The rejected parts of the losing proposals are listed in Appendix B.

> **What this means:** We borrow engineering and restraint from each reference app, never its look, wording or assets. Sparkle, glow and shimmer effects are excluded.

---

## 15. Delivery by lane and acceptance

The roadmap (`plans/00-roadmap.md` §2.3–§2.6) owns lanes, days and branches; plan 30 holds the detail. This table maps each UI lane to the parts of this document it builds. Several lanes depend on the architecture plan's contracts: sandboxed HTML, engine prefetch and LRU, op-queue states, sync-state events and `reconnectBy`, first-sync checkpoints, `Setup/end` with one-shot AI deferral, and Home's lanes. Until those land, lanes build against the stand-in engine. Mocked Google is never treated as live acceptance (AGENTS.md).

| Lane | Builds (this document) | Accepted when |
|---|---|---|
| `ui-foundation` (days 1-3, then 4-9) | §4 tokens and generator, §12 lint, contrast and identity CI, the harness with the hover-shift check, the `aplos-design` skill, §6 components, `CommandRegistry`; the checks for §13 and §10 | Lint rejects raw hex, gradients, literal durations and layout transitions; the `?` sheet is generated; the §2.3 test passes on the stand-in; no banned string in the DOM |
| `ui-shell` (days 4-11; switch 11-13) | §4.8–4.9 motion runtime, §5 input rules, §7.1 shell, sidebar, pane header, status slot, §7.13 toasts, §7.15 errors | §5 budgets pass in the packaged app at 10k threads; filmstrips are baselined; each status renders from the stand-in |
| `ui-home` (days 5-12) | §7.2 Home, §7.3 Later, §7.4 lists and Done, §7.14 empty states | Home's sections and Do now order match §7.2 on fixtures; Tab cycles sections; ⌥↑ / ⌥↓ move lanes with Undo; hover never shifts a row |
| `ui-reader` (days 5-13) | §7.5 reader, §7.6 inline reply, compose, undo-send and the follow-up draft | The reader shows its four parts in order with nothing beside them; one notice per send; the follow-up suggestion opens on Space |
| `ui-onboard` (days 5-12) | §7.11–7.12, Appendix C, the reconnect sheet | Every PR #21 finding has a test; closing onboarding at any step leaves AI working |
| `ui-calendar` (days 6-12) | §7.8 | Overlaps, short events, RSVP and the mini month match the mockups |
| `ui-settings` (days 6-12) | §7.10 | Env keys can't be removed; Reconnect appears for the three account states |
| `ui-ask` (days 6-13) | §7.7 Ask and Today, §7.9 palette and search | Every registry action is reachable; Search is a page; destructive commands default to Cancel |

Every lane's states are in the harness in both themes, and the owner reviews each feature on demo mail as it lands (roadmap §12), starting with Home, the reader and compose.

> **What this means:** Each lane knows which sections it builds and what passing looks like, and the shared checks come first.

---

## 16. History

The first version of this spec, written earlier on 2026-10-27, used the **Skypaper** direction from the winning proposal. It put the open letter on a blue sky, used a red-and-blue airmail "post edge" on the composer and the undo tray, showed four painted "sky moments" (onboarding, first-sync sunrise, Home empty, a horizon tint), and gave the reader a margin rail and a sticky action flap.

The owner reviewed those screens as HTML mockups and asked for a calmer, more beautiful app. Drawn at full size, the sky was the loudest surface in the product and read as a different app (`mockups/NOTES.md`, revision 1 finding 1), and the owner disliked the stripe. Revision 2 replaced the look with Paper: a neutral gray shell, one white pane, roomier type, no decoration, a simpler reader, reply and compose, a regrouped sidebar and the hover rule. Revision 2b recorded the owner's answers: no app icon in the app, no page titles, the calendar button back, the name Paper, account dots only with two or more accounts, and the website redesign deferred to a new logo. Revision 3 is the owner's own design for Home's sections.

The change list for those revisions is `mockups/DESIGN-CHANGES.md`. It is history now; this document is the spec. Appendices A and B record the original proposal scoring and grafts under the proposal's own name.

**2026-11-10 owner override (reader card, one by one).** The owner asked, by name and with three reference images, for a "go one by one" card redesign. It knowingly supersedes three lines above for the reader and the one-by-one view only: (1) "no avatars or monograms in mail" (§3/§13): the card header may show calm monogram circles for sender and recipients (`--raised` fill, `--ink-2` letter, `--paper` ring), never a remote avatar URL or photo; (2) "Important ▾ in the reader header" is gone (§7.5, §13 row 10): the reader header may carry an Importance menu (Important / Low importance via the existing lane action, "Always do this for [sender]", Undo toast), a notification bell and ⋯, because the owner asked for them; (3) "the reader has no card" (§7.5): the email now sits in one card (subject on top, hairline, header row, body through MailFrame, attachments), while the summary stays big above it. Everything else stays binding: Space/Reply/Done/Later, the pinned action bar and the docked Ask are unchanged, and the owner skipped the "New 6" counter, left tick-marks and the "Full email" button. The bell shows what the engine reports through `Message.notification` (bell = notified, slashed = did not notify) and is not drawn when the engine did not say (field merged in #397, bell wired in #409). ui-reader adds the matching DECISIONS line in its PR 1.

**2026-11-11 amendment (owner's second sketch, df6a1482; DECISIONS.md "the one-by-one card follows the owner's second sketch").** The owner's later sketch overrides the section 16 paragraph above on five points, for the reader card and the one-by-one card only: (1) the summary headline and the due chip are off the card, and the subject is not on it (the `data-cards='off'` column keeps the summary head); (2) the sender mark is a rounded square, not a circle (the recipient circles after "To" stay circles); (3) the header order is bell, Importance, then ⋯; (4) no cursor rail: ↑/↓ gives the card a quiet accent edge; (5) a plain email is drawn on the card in the app's own colours in both themes, so 7.5's "HTML mail on light paper in both themes (rich mail only: a plain email is drawn on the card in the app's own colours, §16 amendment 2026-11-11)" now holds only for rich mail (plainness comes only from the sanitiser's marker, never from a colour the mail chooses). Go one by one also shows the card at full width with no Reply stub. Where the sketch and an earlier decision conflict, follow the sketch.

**2026-11-12 amendment (owner's hands-on pass; integrator-ui, delegated by ui-foundation).** The recipient monogram circles after "To" are gone: the owner found the one-letter circles carried no meaning, so the header line is the recipients in words — "to me", "to Mina Cho, Kim and 3 more" — as one button that opens the details popover (shipped in #498; a narrow header may clip the names but never the "and N more" tail, #505). The sender mark keeps the 2026-11-11 rounded square, still a monogram until photos exist. Everything else in the two paragraphs above holds.

**2026-11-17 amendment (owner review of #548).** The recipients details popover (From, Date, To) is styled like every other popover and menu: the Popover's `--float` surface, radius 12, ring and elevation and its 16 px padding with no second inset inside it; rows 8 px apart on a `--line` hairline; labels in the menu label's role (`small` 500, `--dim`), names and the date in `ui`, addresses in `small` `--dim`.

**2026-11-11 amendment (owner's round-3 feedback; DECISIONS.md "the one-by-one card is a reading column at most 680 px wide").** The one-by-one card no longer fills the pane: it is a centred reading column `min(100% − 2 × clamp(16 px, 3 %, 24 px), --card-w)` — new token `--card-w` = 680 px (§4.4) — that shrinks with the window, keeps a 16–24 px side margin and never grows wider, so a wide window leaves margins, not long lines. The header, its hairline and the pinned bar are the column's own. A plain body keeps `--measure-read` (64 ch) inside the card; a rich email's paper frame uses the card's full width (images already scale to it), so only plain bodies are capped at the measure. This supersedes "Go one by one also shows the card at full width" in the amendment above; the no-Reply-stub part stands.

---

## Appendix A: independent judge scorecard

Scored 0–10 per lens before comparing with `judge-design-glm.md`. These are the original proposals as written; Paper later replaced the winning proposal's look (§16).

| Lens | Skypaper proposal | Carried | Instrument |
|---|---|---|---|
| Owner taste and beauty | **9** | 8 | 6 |
| Identity and independence (clearly not Avec) | **9** | 6 | 7 |
| Speed, craft and feasibility | 8 | 7 | **9** |
| **Total / 30** | **26** | 21 | 22 |
| GLM's total, for comparison | 27 | 23 | 22 |

- **Skypaper proposal (26).**
  - *Taste 9.* Every taste item is mapped (its §11), sender-first and big-summary are reconciled, the docked Ask is kept, and Space is everywhere.
  - *Identity 9.* The icon becomes rules, ink blue is at ΔE 13.8, the serif voice is unique among mail clients, and there are seven yes-or-no checks.
  - *Craft 8.* The right engineering spine and the best enforcement story. It loses points for an auto-height focus card (list reflow stays possible), a slide-spring settle time that is off by about 110 ms (§4.8), a dark Done green only ΔE 6.8 from Avec's `#03ce4c`, and no cold-start budget.
- **Carried (21).** *Taste 8:* the warmest, with a lovely press feel. *Identity 6:* a warm canvas in Avec's family, a full-card stamp flood (Avec's signature), and an unverified ΔE claim for its dark accent. *Craft 7:* texture costs GPU on every frame, gates are thin, zoom is missing. Two of its signature elements land on Avec's, so I score it below GLM's 23.
- **Instrument (22).** *Taste 6:* no serif, no icon story, 32 px rows, an AI-badge-like "SUMMARY" label, no Space in the reader map, and a fourth reply affordance in the sender block. *Identity 7:* escapes Avec's grammar, but the travelling rule and ink-black button are generic. *Craft 9:* the best engineering (8 ms commit, inverse undo, LRU prefetch, fixed card, IME rules, skip links, packaged gates), but no agent-enforcement layer.

**Agreement with GLM:** same winner, same ten grafts, and no texture. **Disagreement:** I rank Instrument above Carried, because Carried's warm canvas and flood commit fail the not-Avec test, while Instrument's problems are taste, which grafting doesn't import.

## Appendix B: graft ledger

| Graft into the base design | From | Where |
|---|---|---|
| Fixed-height focus slot with `deal` | Instrument | §4.4, §4.9, §7.2 |
| Commit-on-keydown ≤ 8 ms, packaged-build gates, cold-start budget | Instrument | §5 |
| Durable op queue; Undo as an inverse operation; rejected writes return with Retry | Instrument | §5 rule 11 |
| IME-safe keys; skip links ⌘⌥L / ⌘⌥R; Esc ladder | Instrument | §5 rule 16, §8 |
| LRU-12 prefetch on 80 ms focus | Instrument | §5 rule 9 |
| "Try the keys" drill during first sync | Instrument (its onboarding drill, moved) | §7.12 |
| Citations or "No source" on every answer; follow-ups queue while streaming | Instrument | §7.7 |
| Press inset highlights swapping on `:active` | Carried | §4.6 |
| Hold → to mark all done on low-importance sender groups | Carried | §7.2 |
| "Set a date · D" and "Remind me if no reply · R" toasts | Carried / SYNTH-ui | §7.2 |
| One-frame theme-switch freeze | Carried / Redakt | §4.8 |
| **Not grafted:** desk and paper noise texture; warm canvas; full-card stamp flood; uppercase AI label; ink-black primary; 32 px default rows; dropping the serif | n/a | Appendix A |
| **Corrected in this spec:** dark hill `#6cbf5a`→`#86b86a` (ΔE 6.8→11.6 from Avec); spring constants re-solved; commit chip replaces the ambiguous "edge tab with a label" | This spec | §2.3, §4.1, §4.8, §4.9 |

## Appendix C: PR #21 review findings → design rules

Finding IDs follow the order of the unique findings in `research/pr21-onboarding-review.md`. Engine fixes belong to the architecture plan; the UI must call them and test them.

| ID | Finding (severity) | Rule here |
|---|---|---|
| F1 | Closing a reopened welcome after connecting leaves `deferAI` set; that account gets no AI for the session (medium, reported 6×) | §7.11: every close calls `Setup/end`; deferral is one-shot; disconnect clears it. Test: reopen → connect → close → new mail gets classified. |
| F2 | Closing after the first sync finishes means the initial mail never gets the AI pass (medium, 3×) | §7.11: `Setup/end` backfills unsummarised threads in the background. Test: sync → close → all classified. |
| F3 | A second instance during startup opens two windows (low) | §7.11: one window at a time; `second-instance` is guarded |
| F4 | The mail window is shown before it paints (blank flash) (low) | §7.11 handoff: show on `ready-to-show`, then fade the onboarding window out |
| F5 | Retry collides with a running pass because of fixed request ids (low) | §7.12: Retry is idempotent; per-run ids |
| F6 | Replies during deferral are never re-summarised (low) | §7.11: the deferral covers only the first connect-time sync; the backfill includes reply refresh |
| F7 | Several accounts → the window opens filtered to the last one (medium, 2×) | §7.11: open on **All accounts** |
| F8 | Esc does nothing on the failed loading screen despite its esc hint (medium) | §7.12: the step owns Esc = "Continue to Aplos". Test. |
| F9 | A connect resolving after Esc yanks the user back to step one (low) | §7.11: never navigate on a late resolve; update the list in place |
| F10 | "Summaries ✓ Done" when the pass was capped or failed; errors lost (low) | §7.12: partial and failed wording; errors collected into setup state |
| F11 | `aria-live` announces every 120 ms tick; unlabelled bars (low) | §7.12: one `role="status"` for phases; labelled bars |
| F12 | Return does nothing after discovery because focus is lost (low) | §7.11: focus the next primary control on every internal step change |
| F13 | Centred pages clip their top when content overflows the fixed window (low) | §7.11: steps are top-anchored and scroll inside the window; only Welcome is centred, with `safe center`; the window is resizable |
| F14 | The website screenshot script stalls on the new onboarding window (low) | §12.5: the harness seeds or drives onboarding explicitly |

## Evidence index

- **Visual reference:** `mockups/index.html` and the pages it links; `mockups/tokens.css`, `shell.css`, `shell.js`, `home-view.js`; `mockups/shoot.cjs` (headless checks, `HOVER=1` for layout shift); `mockups/NOTES.md`; `mockups/DESIGN-CHANGES.md` (history of revisions 2, 2b and 3).
- **Proposals and judging:** `plans/proposals/design-{skypaper,tactile,precision}.md`; `plans/_council/judge-design-glm.md`; `plans/_council/CONTEXT.md`.
- **Research:** `research/email-clients/SYNTH-ui.md`; `research/email-clients/ui/{aplos-baseline,avec,tatem,zero,redakt,superlocal,inbox-zero-mail}.md`; `research/email-clients/gaps/{identity-collision-audit,electron-email-html-isolation}.md`; `research/email-clients/protocols/proto-google.md`; `research/pr21-onboarding-review.md`.
- **Screenshots viewed:** `/Users/knewton/.t3/aplos-research/ui/aplos-baseline/{home-light,home-dark,reader-light,welcome-start-light}.png`; `avec/desktop-preview/seg/{t0174.2,t0176.3}.png`; `avec/desktop-preview/dense-done-arrow.png`; `tatem/{hero-mock-flat-gradient,keyboard-overlays}.png`; `redakt/inbox-desktop-dark.png`; `identity-audit/icon-compare.png`.
- **Source lines:** `apps/desktop/src/renderer/{App.tsx,Reader.tsx,Compose.tsx,Ask.tsx,Settings.tsx,bridge.ts,styles.css,styles/{reader,focus,ask}.css,ui/tokens.css,components/{Topbar,MailList,Overlays,Welcome}.tsx}`, `apps/desktop/src/shared/mailbox.ts`, `DECISIONS.md:72,125-130,223,298`, at commit 27cf52f.
- **Owner taste:** project memory `aplos-ui-taste.md`, `no-ai-sparkle-icon.md`, `revamp-plan-phase.md`.
- **Computations:** `/tmp/paper-design/c.py` (Paper contrast and Lab b*); `/tmp/design-director/c.py` (contrast, ΔE00), `h.py` (dark hill search), `k.py` (fills and surfaces), `s2.py` (springs to `linear()`), all reusing `/Users/knewton/.t3/aplos-research/tools/identity-audit/de2000.py`.
