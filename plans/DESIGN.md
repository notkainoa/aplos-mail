# Aplos design language and UX spec: Skypaper

Definitive design spec for the Aplos Mail revamp. Written 2026-10-27 by the design director, on branch `revamp`. This is a plan. It contains no code, nothing in it goes to main, and PR #21 stays unmerged.

**Inputs.** Three proposals: `plans/proposals/design-skypaper.md` (Skypaper), `design-tactile.md` (Carried) and `design-precision.md` (Instrument). The GLM judge scorecard is `plans/_council/judge-design-glm.md`. Research: `research/email-clients/SYNTH-ui.md`, `research/email-clients/ui/*.md`, `research/email-clients/gaps/identity-collision-audit.md` and `research/pr21-onboarding-review.md`. Screenshots are in `/Users/knewton/.t3/aplos-research/ui/`. I viewed `aplos-baseline/{home-light,home-dark,reader-light,welcome-start-light}`, `avec/desktop-preview/seg/{t0174.2,t0176.3}`, `avec/desktop-preview/dense-done-arrow`, `tatem/{hero-mock-flat-gradient,keyboard-overlays}`, `redakt/inbox-desktop-dark` and `identity-audit/icon-compare`. I re-read the source at `apps/desktop/src` (worktree at 27cf52f, the same renderer as v0.2.3) to give the file:line references in section 13.

**Evidence key.** **[V]** means verified in a file, a screenshot or a computation, with the path given. **[I]** means a design judgement. Contrast ratios and colour distances in this document were recomputed for the final tokens with `/tmp/design-director/{c,h,k}.py`, which reuse the audit's `de2000.py`. Spring curves were computed with `/tmp/design-director/s2.py`. All of these scripts are throwaway files outside the repo.

## In plain English

This is the final design plan for the new Aplos. It decides how the app looks, moves, speaks and responds to keys. It also sets rules that stop AI coding agents from drifting away from the design.

The design is called Skypaper, and it comes from your app icon. The open email is a sheet of paper on a sky background. The sky is blue-grey in light mode and deep night blue in dark mode. A new ink blue replaces today's bright blue, which is close to Avec's blue. Summaries and Ask answers use a serif typeface, so you can tell the AI is speaking without any sparkle icon.

The plan removes 17 things that look or read like Avec today, including the big blue Reply pill and the "Hold to talk" wording. Your next key press never waits for an animation, and the list never jumps. Finishing an email plays one signature motion that speeds up when you do.

The onboarding window and first-sync screen are redesigned and include every fix from the PR #21 review. Automatic checks keep the design from drifting.

You need to answer 12 questions below. Questions 2 and 3 matter most.

## Decisions for you

Each question has a recommended default. If you accept all of them, the spec is ready to build.

| # | Question | Options | Recommended | What happens |
|---|---|---|---|---|
| 1 | Adopt **Skypaper** as the design language? | (a) Skypaper, with ideas from the other two; (b) Carried's warm desk; (c) Instrument's flat look | **(a)** | (a) Aplos looks like its icon and unlike Avec. (b) stays close to Avec's warm greys. (c) loses the icon story and the serif voice. |
| 2 | Change the accent to **ink blue** `#0b5394` in the app and website? | (a) Ink blue; (b) keep `#0755dc` | **(a)** | (a) moves the blue far from Avec's and keeps white button text readable. (b) leaves the blue close to Avec's, so the serif and paper must carry the identity. |
| 3 | Set summaries and Ask answers in the **Newsreader** serif? | (a) Yes, after a one-day look test; (b) yes, with no test; (c) no, mark the AI by colour | **(a)** | (a) costs one day and gives the strongest sign that Aplos is speaking. (c) is plainer. Either way it is easy to change later. |
| 4 | Use **cool sky** greys instead of today's warm greys? | (a) Cool; (b) keep warm greys | **(a)** | Avec uses a warm grey, so keeping it leaves the two apps sharing a canvas colour. |
| 5 | What goes at the top of the reader? | (a) Sender and date, then the big summary, then the subject; (b) summary first | **(a)** | (a) matches both of your notes. (b) is closer to today. |
| 6 | Should Done on mail that still needs your reply leave Home? | (a) Yes, with a toast offering "Remind me if no reply, R"; (b) it stays on Home | **(a)** | Today the row stays and Done looks broken. |
| 7 | Where do the arrow keys triage? | (a) Only on Home, in the reader and one-by-one; (b) everywhere, as today; (c) only behind a setting | **(a)** | A slip in All mail or search cannot archive mail. |
| 8 | Hide key hints until hover or holding ⌘, except Space on the main action? | (a) Hidden, with a "Show all key hints" setting; (b) always visible | **(a)** | Screens get calmer, and the setting restores today's look. |
| 9 | Should the Ask dock start closed? | (a) Closed on first run, then remembered; (b) open on first run | **(a)** | The first screen is not 700 px of blank panel. After that it remembers your last choice. |
| 10 | Should ⌘K become a real command palette, with `/` for search? | (a) Yes; (b) keep ⌘K as search | **(a)** | Every command is reachable without memorising keys. |
| 11 | Should the Home focus letter have a fixed height, with the summary cut at two lines? | (a) Fixed (160 px); (b) auto height, as today | **(a)** | The list cannot jump when letters change. Summaries are cut only on Home, never in the reader. |
| 12 | Should the reader get a quiet **margin rail** on the right (due date, attachments, why it is on Home, sender history)? | (a) Yes; (b) no, keep those under the summary | **(a)** | The paper holds only the letter, and the 40% blank card goes away. |

> **What this means:** Answer 2 (the blue) and 3 (the serif) first. They decide most of how different Aplos looks from Avec.

---

## 1. Verdict

I scored the three proposals independently before reading the GLM judge's reasons in detail; Appendix A has my scores. Mine are **Skypaper 26, Instrument 22, Carried 21** out of 30. GLM had 27, 22 and 23. We agree on the winner and disagree on second place.

- **Skypaper wins on taste and identity.** It turns the icon into rules, follows the collision audit clause by clause, and sets AI text in a serif, which no audited mail client does (`gaps/identity-collision-audit.md` §4) [V]. Its flaws are fixable.
- **Instrument has the best engineering but the wrong look:** no serif, no icon story, dense rows and an AI-badge-like "SUMMARY" label. Its engineering is grafted wholesale.
- **Carried is the warmest,** but its warm canvas and full-card commit flood land on Avec's signatures. Its press feel and small pleasures are grafted.

Appendix B lists every graft.

> **What this means:** Skypaper is the base design. The best ideas from the other two proposals are added to it.

---

## 2. Identity: Skypaper

### 2.1 The name

**Skypaper** is the name of the design language: the tokens, the skill file and the docs. It is never a product name. The product stays **Aplos Mail**. The direction is never called "Airmail", which is Bloop's trademarked, award-winning mail client. Bloop has an Italian word mark in classes 9 and 42, and Fichorga and a UK company hold related marks (`gaps/identity-collision-audit.md` §0, §3) [V]. "Skypaper" is not a competitor's term. It appears nowhere user-visible, so it needs no clearance. If it ever goes public, run a clearance search first.

### 2.2 The story

The icon shows a white letter carried on the wind over a green hill under a clear sky [V: `identity-audit/icon-compare.png`]. Skypaper turns each part of that picture into a rule:

| Icon element | Design element | Rule |
|---|---|---|
| The letter | **Paper** | Only the thing you are handling is paper: the Home focus letter, the open email, the composer, a dialog. List rows are *not* paper. They sit directly on the sky. |
| The sky | **Sky** | The canvas around the paper, with a soft horizon tint at the top of the window. The full painted sky appears only in four "sky moments" (§7.16). |
| The hill | **Hill green** | Done, success, "you're back on solid ground". |
| Dusk | **Dusk blue** | Later, set aside for the evening. |
| The pen | **Ink blue** | The one action colour. It reads as fountain-pen ink on paper. |
| The striped border | **The post edge** | A straight horizontal stripe, used in exactly two places in the app (§2.4). |
| The wind | **Carried** | The one signature motion: a finished letter is carried off the way you sent it (§4.9). |
| Handwriting | **The serif voice** | Aplos's own words (summaries, Ask answers, a few display lines) are set in Newsreader. Everything else is the system sans. |

### 2.3 "This is not Avec": the acceptance test

These checks run automatically on the screenshot harness (§12.5) for Home and the reader in both themes. All seven must pass.

1. The canvas is cool: Lab b* is below 0, which is blue-ward. Avec's canvas and Aplos's current `#e5e4e1` are both warm.
2. The accent is at least ΔE00 10 from Avec's `#0050ff`. Ink blue is 13.8 [V: audit §7].
3. The Done colour is at least ΔE00 10 from Avec's greens (`#07aa04`, `#03ce4c`). Light hill is 21.6. The dark hill `#86b86a` is 11.6 and 12.9 [V: computed]; the proposal's `#6cbf5a` was only 6.8 from `#03ce4c`, so this spec changes it.
4. Serif text is present in the main line, meaning the summary.
5. No primary button has a radius above 8 px. There is no floating bottom action cluster and no full-card colour flood on commit.
6. None of the banned phrases in §10 appears anywhere in the DOM text.
7. The reader paper is left-aligned in its area, with the margin rail on the right whenever the workspace is at least 1060 px wide. It is never a centred deck.

### 2.4 The post edge

- **Shape.** A 3 px straight horizontal edge made of −45° diagonal segments: red 9 px, gap 7, blue 13, gap 7, repeating every 36 px. The uneven rhythm is Aplos's own; the classic lozenge is evenly spaced. Prototype it first.
- **Colours.** `--post-red` `#d83237` and `--post-blue` `#1f4fc8`, both at 85 % in dark. They are decoration only, never used for text.
- **Exactly two places in the app.** (1) The top edge of the composer and of the inline reply: "this is an outgoing letter". (2) The undo-send tray, where the edge drains away as the countdown. It may also appear on the website's frames and on the app icon.
- **Never** a ring, circular progress, avatar or badge rim, icon border, list decoration, empty-state ornament or onboarding ornament. The ring form is the geometry of Bloop's 2014 icon (audit §2, §7) [V]. No par-avion labels, postmarks, stamps, stars or plane silhouettes appear in the UI.

### 2.5 Renames this forces

- "Airmail blue" becomes **ink blue**, and "the airmail stripe" becomes **the post edge**.
- The website's `Airmail` component and `.airmail` classes become `PostEdge` and `.post-edge`. They live at `apps/web/src/Chrome.tsx:6`, `apps/web/src/styles.css:92` and `apps/desktop/build/dmg-background.html:21` [V: audit §2].
- `DECISIONS.md:15-17` and `PROGRESS.md:12` stop saying "airmail brand".
- Alt text may say "a striped letter".

> **What this means:** The identity comes from your own icon, so it cannot be mistaken for Avec or for Bloop's Airmail. Seven automatic checks enforce that.

---

## 3. Principles

1. **Only the letter you hold is paper.** Everything else is sky.
2. **Aplos speaks in a serif; everything else is sans.**
3. **Input never waits.** State commits on keydown, and animation draws afterwards on a copy (§5).
4. **Navigation is instant.** Motion is spent only on state changes: triage, send, arrival and selection.
5. **The list holds still under your hands.**
6. **One accent and one filled button per screen.**
7. **Meaning never rides on colour alone.** It always has an icon plus a word.
8. **Say plainly what happened, what is safe and what to do.**
9. **AI is content.** It has no glyph, badge or glow.
10. **Decoration is rare on purpose:** two post edges and four sky moments.

> **What this means:** These ten principles settle any design disagreement. A screen that needs a new colour, radius, motion or floating pill is wrong.

---
## 4. Tokens

All tokens live in one source file, `apps/desktop/src/renderer/ui/tokens.json`, written in the W3C design-token format. A build step generates `tokens.css`, `motion.ts` and the contrast-pair list from it (§12.1). Components only ever use `var(--…)` or the imports from `motion.ts`.

### 4.1 Colour

| Token | Light | Dark ("night") | Role |
|---|---|---|---|
| `--canvas` | `#e9edf0` | `#0b1219` | The sky. Lists sit directly on it. Replaces the warm `#e5e4e1` and the pure `#000`. |
| `--horizon` | `#dce7f1` fading to `--canvas` over 320 px | `#112133` fading out | A soft tint at the top of the window. Flat under Increase Contrast. |
| `--paper` | `#fefefc` | `#141c25` | The letter, the composer, dialogs. In dark it is *lighter* than the canvas (the Redakt lesson) [V: `redakt/inbox-desktop-dark.png`]. |
| `--raised` | `#f3f5f7` | `#1b2530` | Inputs, the low-importance band, hovered surfaces |
| `--sunken` | `#e1e6eb` | `#070c11` | Keycap wells, search field |
| `--sidebar` | `#e2e8ee` | `#080e14` | Fallback for the web preview only. On macOS the sidebar keeps native vibrancy. In dark the fallback is darker than the canvas (today it is a light `#484a4c` slab [V: baseline §6.5]). |
| `--ink` | `#121820` | `#e7ecf1` | Primary text |
| `--ink-2` | `#2f3a46` | `#c4ccd5` | Subjects, secondary text, rows near the focus |
| `--dim` | `#56616d` | `#97a3af` | Metadata, timestamps, section labels, placeholders |
| `--faint` | `#7d8792` | `#75818e` | **Non-text only:** disabled glyphs, dividers, inactive icons |
| `--line` | ink at 14 % | ink at 12 % | A 0.75 px ring on paper and floating surfaces |
| `--control-edge` | ink at 50 % | ink at 45 % | Borders of inputs, checkboxes and switches |
| `--accent` (ink blue) | `#0b5394` | `#88aee0` | Focus, selection, links, the unread dot, the one filled button |
| `--accent-ink` | `#ffffff` | `#08111a` | Text on an `--accent` fill |
| `--accent-wash` | accent at 10 % | accent at 16 % | The selected-row background |
| `--hill` (Done) | `#2f6f2a` | `#86b86a` | Done fills, success |
| `--dusk` (Later) | `#3e5878` | `#8fa9cc` | Later fills |
| `--stamp` (danger) | `#c4302b` | `#ff7a6e` | Trash, errors, the recording meter, the calendar now-line. One red only (today there are two [V: baseline §6.5]). |
| `--stamp-ink` | `#a3221e` | `#ff8d82` | Red *text* on tinted backgrounds |
| `--fill-ink` | `#ffffff` | `#08111a` | Text on hill, dusk and stamp fills |
| `--sky` | `#9fd3ff` | `#11263d` | Tints only: today's calendar column, sky moments |
| `--post-red` / `--post-blue` | `#d83237` / `#1f4fc8` | same, at 85 % | The post edge only |
| `--scrim` | ink at 24 % | `#000` at 48 % | Behind dialogs |
| `--shadow-ink` | `#121820` | `#000000` | The base colour for every shadow |

**Computed contrast, WCAG 2.x** [V: `/tmp/design-director/c.py`, `k.py`]

| Pair | Light | Dark |
|---|---|---|
| ink on canvas / paper / raised | 15.15 / 17.67 / 16.32 | 15.85 / 14.45 / 13.05 |
| ink-2 on canvas / paper | 9.83 / 11.46 | 11.61 / 10.59 |
| dim on canvas / paper / raised / sunken | **5.36** / 6.25 / 5.78 / 5.03 | 7.33 / 6.69 / 6.04 / 7.64 |
| dim on the selected row (accent-wash over canvas) | 4.62 | 5.59 |
| dim on glass (level-2 surface over canvas) | 5.99 | 6.82 |
| dim on the horizon | 5.03 | 6.34 |
| faint on canvas, non-text only (3:1 needed) | 3.10 | 4.74 |
| accent text on canvas / paper | 6.66 / 7.76 | 8.23 / 7.51 |
| accent-ink on accent fill | **7.84** (today 3.73) | 8.30 |
| fill-ink on hill / dusk / stamp | 6.13 / 7.31 / 5.52 | 8.21 / 7.88 / 7.47 |
| fill-ink on a 70 % fill over paper (dark swipe underlay) | n/a | hill 4.75, dusk 4.63, accent 4.81 |
| stamp-ink on a 10 % stamp tint | 5.49 | 6.92 (14 % tint) |
| control-edge on paper / canvas (3:1 needed) | 3.39 / 3.28 | 3.95 |
| focus ring (accent) on canvas | 6.66 | 8.23 |
| Home fade: ink-2 at opacity 0.8 on canvas | 5.61 (today's 0.46 floor gives 1.76 [V: baseline §6.5]) | |

**Rules**

- **No raw colour in components.** Lint enforces this (§12.2).
- **Hover and press** are ink at 5 % and 9 % (dark 6 % and 11 %), mixed with `color-mix` from tokens.
- **The Home distance fade steps down the ink ramp, not opacity.** The focus letter is `--ink`, the next two rows `--ink-2`, and the rest `--dim` sender with `--ink-2` summary. Every step stays at 5.36:1 or better. Opacity is never used for text.
- **Selection** is `--accent-wash` plus a 2 px accent bar on the row's leading edge.
- **Dark commit fills.** Small fills (the commit chip) are solid. Large fills (the swipe underlay) are capped at a 70 % mix over paper, which keeps text at 4.63:1 or better. A full-saturation flood at night is a known failure (`ui/avec.md` §6) [V].
- **Increase Contrast (macOS).** `--line` becomes `--control-edge`, `--faint` becomes `--dim`, the horizon goes flat, glass becomes opaque and the focus ring becomes 3 px.

**Identity distances, ΔE00** [V: audit `deltaE.txt` plus recomputation]. Light ink blue is 13.8 from Avec, 8.9 from Missive's hover shade and 10.4 from Mimestream's link. Dark `#88aee0` is 10.2 from Airmail's Mac ring and 10.8 from Avec's sky. The CI identity check holds every accent and commit colour at least ΔE 8.5 from the reference list (§12.4).

### 4.2 Accounts, labels and calendars

Six pairs derived from the icon, assigned by a stable hash of the name, with a manual override in Settings:

| Name | Light | Dark |
|---|---|---|
| Sky | `#2f6fa3` | `#6aa5d6` |
| Hill | `#2f6f2a` | `#86b86a` |
| Stamp | `#c4302b` | `#ff7a6e` |
| Dusk | `#3e5878` | `#8fa9cc` |
| Sand | `#8a6320` | `#d9a65a` |
| Ember | `#b4531f` | `#e08a5a` |

- **As marks** (8 px dots, chip outlines, 2 px calendar event rules), each colour is at least 4.25:1 on canvas in light and 6.50:1 in dark.
- **Calendar event fills** use the colour at 16 % (light) or 26 % (dark) with `--ink` text, which keeps text at 13.8:1 and 8.6:1 or better [V: computed].
- **Rainbow letter avatars are removed** (`renderer/bridge.ts:20` `avatarColor`) [V]. Rows have no avatars. The reader has one 24 px neutral monogram, ink on raised.

### 4.3 Type

**Families**

- **Sans:** the system font, SF Pro via `-apple-system`, used for mail, controls and navigation. The existing optical tracking is kept.
- **Serif:** **Newsreader** (variable, OFL), bundled as roman woff2 and preloaded with `font-display: block`. Its `size-adjust` fallback is `"New York", Georgia`, so nothing shifts on load. It is used only for "Aplos speaking". The website already ships it [V: SYNTH-ui §2.4].
- **Mono:** `ui-monospace, "SF Mono", Menlo`, for addresses in popovers, code and citation numbers. Today `--font-mono` is used but never defined [V: baseline §6.9 #9].

**Scale.** These ten roles are the only font sizes allowed. Lint rejects literal sizes.

| Token | Size / line | Face and weight | Tracking | Used for |
|---|---|---|---|---|
| `caption` | 11 / 14 | SF 500 | +0.06 px | Keycaps, chips, calendar hours. This is the floor; today's 7–10.5 px sizes are removed. |
| `small` | 12 / 16 | SF 400 / 500, tabular | 0 | Timestamps, metadata, section labels |
| `ui` | 13 / 18 | SF 400 / 500 | −0.06 px | Sidebar, menus, controls, buttons |
| `base` | 14 / 20 | SF 400 (500 for read senders, 600 for unread) | −0.12 px | List rows, settings rows, compose fields |
| `read` | 15 / 24 | SF 400, measure 68ch | −0.1 px | Plain-text bodies |
| `title` | 16 / 22 | SF 600 | −0.24 px | The toolbar view title, dialog titles |
| `heading` | 20 / 26 | SF 600 | −0.36 px | Settings page title, calendar month title |
| `summary` | 20 / 28 | Newsreader 440 (dark 420), opsz 20 | −0.15 px | **The one big line,** identical on the Home focus letter and the reader (today 18 vs 20 px [V: baseline §6.4]) |
| `answer` | 16 / 25 | Newsreader 400 (dark 390), opsz 16 | −0.05 px | Ask answer prose |
| `display` | 28 / 34 | Newsreader 450, opsz 28 | −0.4 px | Welcome, sync complete, Home empty |

**Rules**

- SF uses weights 400, 500 and 600 only.
- The reader subject is 16/22 at 500 in `--ink-2`, so it never outweighs the summary. Today a 17/600 subject competes with a 20/500 summary [V: baseline §6.4].
- Tabular numerals are used wherever numbers align.
- Use `text-wrap: pretty` for summaries and `balance` for display lines.
- Add +0.005 em tracking on non-Retina displays [V: SYNTH-ui §2.4].

**Serif gate.** Before Stage 3 ships (§15), run a one-day look test of Newsreader 20/28 against SF 20/500 on real mail in both themes. If the serif loses, the `summary` and `answer` tokens switch to SF 500 in `--ink`, set on a `--raised` band, and nothing else changes shape (decision 3).

### 4.4 Spacing, sizes and layout

**Spacing (4 px grid).** `--space-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-7` 32 · `-8` 40 · `-9` 48 · `-10` 64. `--space-half` (2 px) may only be used to nudge icons optically. Page gutters are fluid, `clamp(16px, 2.2vw, 32px)`, and are the only unit that is not on the grid.

**Control heights.** `--control-xs` 24 (chips), `-sm` 28, `-md` 32 (default), `-lg` 40 (onboarding primary). Every hit target is at least 24 × 24, and the default is 28.

**Density** (Settings → General):

| Density | Row | Home focus letter (fixed) |
|---|---|---|
| Roomy | 48 | 176 |
| **Comfortable (default)** | **40** | **160** |
| Compact | 34 | 144 |

**Layout at a 1440 × 900 window, sidebar open, dock closed**

| Region | Size |
|---|---|
| Sidebar | 240 px (216 px under 1280); minimised mode = ☰ menu button |
| Toolbar | 48 px |
| List column | `min(820px, 100% − 2 gutters)`, centred in the workspace (today 760 px) |
| Reader | paper with 680 px of content (68ch) + 40 px gutters = 760 px, a 32 px gap, then a 240 px margin rail. The group is centred. The rail folds into a "Notes" disclosure when the workspace is under 1060 px. |
| Ask dock | 360 px (320 px when the window is under 1180 px), resizable 300–440, remembered |
| Composer sheet | 680 px |
| Palette | 600 px, 18 vh from the top |
| Settings | 200 px nav + 640 px content |
| Toast | up to 420 px |
| Minimum window | 900 × 600 |

### 4.5 Radius

| Token | Value | Used for |
|---|---|---|
| `--radius-xs` | 4 | Keycaps, the commit chip's inner icon well |
| `--radius-sm` | 6 | Chips, small controls, calendar events, the commit chip |
| `--radius-md` | 8 | Buttons (including the one filled button), rows, fields, menu items |
| `--radius-lg` | 14 | Paper, menus, popovers, the palette, toasts, trays |
| `--radius-xl` | 20 | Dialogs, the onboarding card |
| `--radius-pill` | 999 | **Only** counts and search operator tokens. Never a button. |

Today there are about 30 literal radii and pill-shaped buttons everywhere [V: baseline §3.3]. Both go.

### 4.6 Elevation and material

| Level | Name | Light | Dark | Used for |
|---|---|---|---|---|
| 0 | `--elev-0` | canvas plus horizon, no shadow | same | Lists, sidebar area, calendar grid |
| 1 | `--elev-paper` | `--line` ring + `0 1px 2px` shadow-ink 5 % + `0 8px 24px` shadow-ink 4 % | ring + inset `0 1px 0` white 4 % (top sheen) + `0 8px 24px` black 35 % | The focus letter, reader paper, composer |
| 2 | `--elev-float` | paper at 72 % + `blur(20px) saturate(1.4)`, ring, `0 4px 12px` 6 % + `0 16px 40px` 10 % | paper at 80 %, same blur, top sheen, shadows at 45 % | Menus, popovers, tooltips, toasts, the palette, trays |
| 3 | `--elev-dialog` | opaque paper, ring, `0 2px 6px` 8 % + `0 24px 64px` 16 %, `--scrim` behind | opaque, top sheen, shadows at 55 % | Dialogs, confirmations, the onboarding card |
| lift | `--elev-lift` | level 1 plus `0 12px 32px` 10 % | plus 50 % | A dragged row or letter |

**Material rules**

- Glass is only for level 2. Large scrolling regions never blur.
- Reduce Transparency makes glass opaque paper.
- **Press feel** (from Carried): the filled button has a 1 px inset highlight at the top (white 18 %) and a 1 px inset shade at the bottom (shadow-ink 12 %). On `:active` they swap to a top inset shade, and the button scales 0.97 (icon buttons 0.94).
- **No paper or desk texture** (decision in Appendix B). Depth comes from light, not noise.

**Three button idioms only:** **filled** (one per screen), **text**, and **icon**. Today's glass pills are removed [V: baseline §6.8].

### 4.7 Iconography

- **Source.** SF Symbols through Aplos's Swift helper, with Lucide as the fallback [V: `DECISIONS.md:127`]. Icons are monoline, 1.5 px stroke, 16 px in rows and 18 px in the flap, in `--dim`. They take `--ink` when active.
- **AI suggestions wear their action's icon:** reply arrow, calendar, link, paperclip, cart, phone, file.
- **Ask** gets `text.bubble` plus the word "Ask". It stops borrowing the search magnifier (`Topbar.tsx:22`) [V].
- **Compose** is `square.and.pencil`, **Done** is `checkmark`, **Later** is `clock`, **Bookmark** is `bookmark`, **Trash** is `trash`.
- **Banned in every form:** `sparkle(s)`, `wand.and.stars`, `wand.and.rays`, `star`, `star.fill`, `apple.intelligence`, `brain`, `brain.head.profile`, and Lucide `Sparkles`, `Sparkle`, `Wand`, `WandSparkles`, `Stars`, `Star`, `Brain`, `Bot`. Lint enforces the list (§12.2). Bookmarks use `bookmark`, never a star.
- **No icon-in-a-grey-circle empty states** [V: baseline §6.8 #1].

> **What this means:** Every colour, size, gap, corner and shadow comes from one list, so screens stay consistent. All text colours pass contrast checks in both themes, including the faded rows that fail today.

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

**Named motions.** These 25 named motions (23 rows; lift, follow and snap share one) replace 56 `@keyframes` and about 30 literal timings [V: baseline §4]. "Rapid" applies when triage keys arrive less than 300 ms apart. "Reduced" applies under `prefers-reduced-motion`.

| Token | Duration | Curve | What moves (transform and opacity only) | Where | Rapid | Reduced |
|---|---|---|---|---|---|---|
| `nav` | **0** | n/a | nothing | View, mailbox, account and settings-tab switches | 0 | 0 |
| `press` | 80 down / 140 up | out | scale .97 (icons .94), inset swap | Buttons, rows, keycaps | same | colour only |
| `hover` | 100 | std | background and colour; `(hover: hover)` only | Rows, controls | same | same |
| `cursor` | 120 (Home focus 160); **0** on key repeat and pointer | out | one shared cursor layer | List cursor | 0 | 0 |
| `reveal` | 140 in / 100 out | out / in | opacity, 4 px from trigger, scale .98→1 | Menus, popovers, tooltips (instant for 600 ms after one closes) | same | opacity 100 |
| `settle` | 180 in / 120 out | out / in | opacity, 8 px rise, scale .98, from its anchor | Dialogs, palette, composer, proposal cards | same | opacity 120 |
| `slide` | 270 | `--spring-slide` | one shared puck (translate + scaleX) | Sidebar selection, D/W/M, Ask/Today, Settings nav, Later chips | same | 0 |
| `commit` | 60 | out | commit edge bar scaleY 0→1; commit chip opacity + scale .9→1 | Done / Later / Trash on the focus letter or reader | 30 | opacity 60 |
| `carry` | 120 | carry | ghost row: translateX ±28 px, opacity →0 | Any row leaving any list | 60 | opacity 80 |
| `flight` | 220 | carry | ghost paper: translate (±96 px, ∓12 px), rotate ±2°, opacity →0 from 40 % | Focus letter or reader paper on commit | 110; from the 4th key in 1 s, `carry` instead | opacity 120 |
| `deal` | 140 | out | next letter's content: opacity, 6 px rise inside the fixed slot | Home focus slot after a commit | 0 | 0 |
| `hold` | until 450 ms after the last key, or the pointer leaves the row (cap 1200) | n/a | rows below pinned via transform | Burst triage; new mail during activity | same | same |
| `close` | 180 | out | FLIP of rows below | After `hold` releases | same | 0 |
| `swap` | 120, overlapping | std | opacity + 12 px in the travel direction | Reader J/K (double-buffered), Later groups | 60 | opacity 100 |
| `arrive` | 200 | out | opacity + 6 px drop; neighbours FLIP | New mail, a sent message in its thread, Ask cards | deferred until `hold` ends | opacity 120 |
| `dock` | 200 open / 140 close | out / in | dock *contents* translateX 24 px + opacity; mail column FLIP | Ask dock, sidebar | same | 0 |
| `post` | 260 | carry (x), out (y) | composer translate (+40, −56) px, scale .96, opacity →0 | Send | same | opacity 120 |
| `drain` | the undo window (8 s default) | linear | post edge scaleX 1→0 from the right | Undo-send tray | same | static text countdown |
| `lift` / `follow` / `snap` | springs | spring | lift scale 1.02 and `--elev-lift`; follow the pointer; snap back or onto a drop target | Drag and swipe | same | 0 |
| `breathe` | 1600 loop | inout | opacity .55↔.85 | Pending AI lines only, at most 3 on screen | same | static at .7 |
| `status` | 1500 loop | inout | 30 % segment in a 2 px track | The sync bar; spinners only after 150 ms | same | static |
| `count` | 140 | out | old digit out 4 px up, new in from 4 px below | Sidebar counts | 0 | 0 |
| `sunrise` | 400, skippable by any key | out | sky opacity + scale 1.02→1 | Sky moments 2 and 3 (§7.16) | 0 | static |

**Theme switch.** Disable every transition for one frame, so the app changes all at once [V: SYNTH-ui §3.1 #8].

**The dock.** Transforms were tried before and dropped because a strip of window background showed during the slide, and width animation replaced them [V: `DECISIONS.md:298`]. The fix is to paint the dock's final area in the dock colour on frame one, slide only its contents, and FLIP the mail column. If seams still show *in the packaged app*, fall back to one-step resize plus content fade. Never animate `width`.

### 4.9 The signature: carried off

**Keyboard Done (E, Space when the suggestion is Done, or → on Home and in the reader):**

1. **Keydown, frame 0.** State commits, focus moves to the next item, and the screen-reader live region announces "Done. Next: Maple Library, two holds waiting".
2. **0–60 ms (`commit`).** A 4 px `--hill` edge bar grows on the leaving edge of the paper. A commit chip (28 px tall, solid hill, white check plus "Done", `--radius-sm`) appears in the paper's top-trailing corner. The body is **not** flooded; a whole-card flood is Avec's signature (`ui/avec.md` §4 row 4) [V].
3. **40–260 ms (`flight`).** A ghost copy of the paper flies right and slightly up with a 2° tilt, like a letter caught by wind. This is the icon's own tilt, and it replaces today's `perspective(1400px) rotateY(±14deg)` fling (`styles.css:352-358`) [V].
4. **On Home, the slot holds still.** The focus letter is a fixed-height slot. The next letter's content is *dealt* into it (`deal`). The next row's old 40 px line below empties under `hold`, then closes once you pause (`close`).

**Later** is the same move in `--dusk` with a clock, flying left and slightly down, as if set aside for the evening.

**Rapid mode.** Five quick E presses leave at half duration and nothing in the list shifts until you stop. From the fourth key in one second, the flight becomes a 60 ms `carry`.

**Swipe (two-finger trackpad or drag).** The paper follows the pointer (`follow`). An underlay behind it, not on it, reveals the solid action colour with its icon and verb. At the threshold (30 % of the width, or a velocity above 0.6 px/ms) the underlay icon scales 1→1.08→1 using `snap`. On release the paper continues *from its release velocity* into `flight`. Below the threshold it snaps back.

**Send** uses `post`, the only place the wind arc appears.

> **What this means:** About two dozen named motions replace dozens of one-offs. Moving around is instant, and finishing an email never makes you wait or moves the list under you.

---

## 5. Input never waits: engineering rules

These are requirements, not preferences. Each one has a test in the budget suite (§12.6).

1. **Commit on keydown.** The handler updates the store synchronously, then calls the engine optimistically. Key-to-state takes 8 ms or less (p95).
2. **Focus moves with state, in the same event.** Five J presses within 200 ms land five rows down. Five E presses make five correct commits.
3. **Animate a ghost, never the model.** Clone the leaving element with fixed geometry and remove the real one at once, then animate the clone with WAAPI on the compositor. React never re-renders per frame. At most three ghosts animate at once; a fourth finishes the oldest.
4. **Keys are never dropped.** A window-level capture listener queues keys that arrive during a mount or transition and replays them on the next frame.
5. **Interrupt means finish or retarget.** A new key finishes a running ghost. A new gesture during a spring starts from the drawn value and velocity.
6. **The list holds still.** `hold` pins rows during bursts and while the pointer is over the list. New mail never moves the row under the cursor; it waits under `hold`, then arrives.
7. **Never animate layout.** No `width`, `height`, `padding`, `margin`, `inset` or `font-size` transitions. The Home focus letter has a fixed height per density. Rows close with FLIP. The reader swaps with a double buffer.
8. **Navigation is instant.** There is no page-transition token.
9. **Prefetch on intent.** After 80 ms of keyboard focus or 120 ms of hover, prefetch the body and both neighbours, and cancel if you move on. The engine keeps an LRU of 12 rendered bodies [V: SYNTH-ui §1 #3; Instrument].
10. **Double-buffer the reader.** The previous letter stays until the next body is laid out and measured, with a 1.5 s deadline. After that, keep the previous letter and show a 12 px "Loading Maple Library…" line. Never show a blank sheet.
11. **Optimistic writes are durable.** Triage, read state, bookmarks and Later go to the engine's durable op queue. Undo is the *inverse operation*, not a delayed commit. If the engine rejects a write, the row returns to its place with an inline error and Retry.
12. **No spinner for local reads, and none under 150 ms** for remote ones. After 150 ms, show one quiet indicator in place (the status slot or a 12 px line), never a modal.
13. **Nothing over 50 ms on the renderer main thread.** HTML sanitising, search, ranking and diffing run in the engine or a worker. IPC is batched per animation frame.
14. **`will-change` only while animating,** removed on finish. Lists are virtualised with fixed row heights.
15. **Suspend when hidden.** Pause loops, timers and springs when the window is hidden or occluded. Stop springs on `pointercancel`.
16. **IME-safe.** Never intercept keydown while `isComposing`. Use `event.key`, not `keyCode`. Single-key shortcuts are off inside text fields. Caps Lock is ignored.

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

> **What this means:** The app acts first and animates second, so fast key presses never wait and a slow network never slows the keyboard. Every rule is an automatic test.

---
## 6. Component inventory

Every screen is built from these components in `src/renderer/ui/`. Screens never style their own controls (`DECISIONS.md:130`). **New** means the component doesn't exist today, **Rework** means it exists but changes, and **Remove** means it is deleted.

| Component | Status | Spec |
|---|---|---|
| `Button` | Rework | Three variants: `filled`, `text`, `icon`. Radius 8, heights 28 / 32 / 40, press inset. Glass and pill variants are deleted. |
| `Kbd` (keycap) | Rework | 18 px, radius 4, `caption`, `--sunken`. Shown on hover, on focus, while ⌘ is held, or with "Show all key hints". The one exception is Space on the primary action, which is always shown. |
| `Tooltip` | Keep | Label + keycap from the registry, `reveal`, level 2 |
| `Menu`, `Popover` | Rework | Level 2, radius 14, 32 px items. Number keys 1–9 pick in short menus. The double-blink on the chosen item is removed. |
| `Dialog` / `Confirm` | Rework | Level 3, `settle`. Confirmations are two key rows ("Delete, Return" / "Cancel, Esc"). |
| `Puck` (segmented / selection) | New | One shared indicator per group moved by `slide`. Used by the sidebar, D/W/M, Ask/Today, Settings nav and Later chips. Replaces the tab indicator that animates width and height (baseline §4). |
| `ListRow` | Rework | Fixed height per density. Unread dot (6 px accent), sender, summary or subject, due chip, date. No avatar. The cursor layer, `accent-wash` selection and swipe underlay live here. |
| `FocusSlot` / `FocusLetter` | New | A fixed-height paper slot on Home holding meta, a two-line summary and an action row; supports `deal` |
| `SectionHeader` | Rework | `small` `--dim` label + count + one optional text action. Tab / ⇧Tab target. |
| `LowBand` | Rework | The low-importance band on `--raised` (§7.2) |
| `Paper` | New | Level 1 surface; hosts the letterhead, body and flap |
| `Letterhead` | New | Sender (popover), relative date, summary, subject, top-trailing icon buttons |
| `Flap` | New | A 48 px sticky action row attached to the paper's bottom edge |
| `MarginRail` / `Notes` | New | The reader's right rail; folds into a "Notes" disclosure on narrow workspaces |
| `Summary` | New | Serif `summary` text with pending (`breathe`), ready, absent and provenance-on-hover states |
| `Why` | New | Disclosure: one sentence + a quote + two correction keys |
| `CommitChip` / `CommitEdge` | New | Solid hill / dusk / stamp chip and 4 px edge bar (§4.9) |
| `Chip` | Rework | Due, label and operator token. 24 px, radius 6; pill only for operator tokens. Hollow by default. |
| `Avatar` | Rework | Reader only, 24 px neutral monogram. The rainbow hash is removed. |
| `AskDock`, `AskTurn`, `StepLog`, `Citation`, `ProposalCard` | Rework | §7.7 |
| `Composer`, `RecipientField`, `DraftState`, `LevelMeter` | Rework | §7.6. LevelMeter is a calm `--stamp` bar meter; the breathing ring is removed. |
| `PostEdge` | New | The stripe (§2.4), with `static` and `drain` modes only |
| `UndoTray` | New | Sits under a sent message: "Sending to Jordan in 8 s · Undo Z · Send now" with the drain |
| `Toast` / `ToastStack` | Rework | §7.13 |
| `StatusSlot` | New | The sidebar footer's sync state; the only place sync status lives in the main window |
| `ProgressSegments` | New | Checkpoint progress for first sync, "Account connected" and "importing N of M" |
| `Palette` | New | §7.9 |
| `SearchField` + `OperatorToken` | Rework | §7.9 |
| `DatePresets` | Rework | Presets on 1–5, a calendar, Return to confirm |
| `CalendarGrid`, `EventBlock`, `PlanOutline`, `NowLine` | Rework | §7.8 |
| `SettingRow`, `ProviderTable`, `KeyRecorder` | New / Rework | §7.10 |
| `EmptyLine` | New | One plain sentence + at most one action. Replaces icon-in-circle `emptyFor` (`App.tsx:24-25, 490`). |
| `ErrorLine` / `FatalScreen` | New | §7.15 |
| `SkyScene` | New | The painted sky drawn in code: gradient + hill silhouette + one wind arc (§7.16) |
| `Switch`, `Checkbox`, `TextField`, `Spinner` | Keep | Re-tokenised. Spinner appears only after 150 ms. |
| `ShortcutSheet` | Rework | Generated from the command registry; fixed height; alternatives joined with "or" |
| `CommandRegistry` | New | One source of every action: id, label, icon, keys, context, undo, confirm. It feeds keys, the palette, menus, tooltips, the sheet and toast keycaps. |

> **What this means:** Screens are assembled from a fixed parts list, so agents cannot add a fourth button style or a new pill.

---

## 7. Screens

Every screen has a toolbar **title** in its left slot; today no view has one [V: baseline §6.2]. All screens follow §3. The states listed for each screen are required and are captured by the harness (§12.5).

### 7.1 Shell: sidebar, toolbar and status slot

- **Sidebar:** Home, Later, Calendar | All mail, Drafts, Sent | Trash, Spam. The account switcher is at the top, defaulting to **All accounts**. Calendar moves out of the footer. Selection uses the `slide` puck, and counts use `count`.
- **Minimised mode** (your setting) is a ☰ button top-left that opens a menu with the same items and puck. Navigation never moves into the toolbar.
- **Footer:** `StatusSlot`, then Settings and Help icons.
- **Toolbar (48 px):** on the left, Back (on deeper views), the view title, and for the reader a position marker ("Home · 3 of 8"). On the right: Compose (pencil icon, C on hover), Search (`/`), Ask (bubble + "Ask"), Today (calendar icon). The Ask pill with "A" and "Hold to talk" is removed.
- **Status slot states:**
  - Up to date: nothing, or "Synced 2 min ago" on hover.
  - "Importing 214 of 500"
  - "Google asked us to slow down · resuming 2:14 PM"
  - "Offline · 2 changes waiting"
  - "Reconnect Google" (a button)
  - These never appear as a banner that pushes the list [V: SYNTH-ui §4].

### 7.2 Home

```
Home                                               Compose  Search  Ask  Today
  New  3                                                     Go one by one  S
  • Jordan        Two layout directions ready, preference by tomorrow   10:00
  ┌ paper · fixed 160 ──────────────────────────────────────────────────────┐
  │ Drew Bell                                              ▮ Yesterday      │
  │ October illustrations finished, approve the invoice to close out        │
  │                                                    (Newsreader 20/28)   │
  │ [⌁ View invoice  Space]                         Later   Done   🔖  ⋯   │
  └─────────────────────────────────────────────────────────────────────────┘
    Leah          Pick a quiet lunch spot for six                     Friday
  ░ Low importance   Parcel Trail, Field Notes and 3 more              5  ░
  Due now  2                                               Clear from Home
  Waiting on others  1
```

- **The focus letter.** The first line holds the sender (`base` 600) and relative date. Below it is the **serif summary** as the one big line (two lines at most on Home). Below that is the action row: the suggested action as the one filled button (action icon + verb + Space keycap), then **text** buttons for Later and Done, then icon buttons for bookmark and more. Their keys show on hover. There is no subject, no todo line and no separate due badge when the summary already says "by tomorrow" [V: baseline §6.2].
- **Sections:**
  - **New** covers everything that matters, including mail that needs your reply; its Space action is then Reply.
  - **Due now** holds Later items whose date has arrived. Its action is "Clear from Home".
  - **Waiting on others** holds mail you sent that has had no reply after your nudge period.
  - Labels are literal. "Ready when you are", "Waiting on you" and "No reply yet" are gone (`App.tsx:510`). Tab and ⇧Tab jump between sections.
- **Rows.** The ink-ramp fade is described in §4.1.
- **Low-importance band.** It keeps its own `--raised` background (your rule). It reads as one line: the label "Low importance", up to three sender names in `--dim`, and the count as a plain number on the right. There is no count badge on the left; badge-plus-comma-list is Avec's layout (`App.tsx:510` `.low-line`; Avec `seg/t0174.2.png`) [V].
  - Return opens the Low-importance sheet. It is grouped by sender, with a hover preview, per-sender Unsubscribe once List-Unsubscribe lands, and **→ →** to mark everything done (the first press arms and the second commits) [Carried graft].
- **New mail** during activity waits under `hold`, then `arrive`s. Meanwhile a quiet "2 new" appears next to the New label.
- **Next-step toasts:** after Later, "Set a date · D". After Done on a thread that is waiting on someone, "Remind me if no reply · R".
- **States:**
  - Loading (local): never a skeleton; the cached list paints.
  - First sync: §7.12.
  - Empty: sky moment 3 (§7.16).
  - No AI provider: rows show the subject in place of the summary, the focus letter shows the subject in `summary` size in SF (not serif), and there is no error.
  - Offline: the status slot only.
  - Narrow (under 700 px of workspace): the action row drops its labels, keeping the Space verb.

### 7.3 Later

- **Naming.** One name everywhere: **Later**. "Todo" and "Todos" are removed (§13).
- **Groups:** Overdue (a clock icon + `--stamp-ink` text, so colour is never the only cue), Today, This week, Someday. Empty groups don't render.
- **Bookmarks** is a filter chip on a `Puck` (Later | Bookmarks), not a mailbox.
- **Rescheduling.**
  - **D** opens `DatePresets`: 1 Today evening, 2 Tomorrow, 3 This weekend, 4 Next week, 5 Someday, then Pick a date.
  - **Drag:** the row lifts (`lift`), every group becomes a labelled drop target ("Move to Tomorrow"), and the drop `snap`s and toasts with Undo.
  - The keyboard never requires dragging.
- **Empty:** "Nothing set aside for later."

### 7.4 All mail, Drafts, Sent, Trash and Spam

- **One list component, one row, no focus letter.** The cursor layer moves with `cursor`. Arrow keys only move the cursor here (decision 7).
- **Hover actions** appear as a small right-edge overlay above the date column and never reflow the row.
- **Bulk select:** X, ⇧X, ⌘A. The title is replaced in place by "3 selected · Done · Later · Trash · More · Esc". Destructive bulk actions confirm with a two-row confirm and give an 8 s undo.
- **Per-mailbox details:** Drafts shows the edited time. Sent shows the recipients. Trash and Spam have Restore as their only quick action.
- **Empty:** the title stays and one line appears ("No drafts.", "Spam is empty."). This fixes the inconsistency where only Spam kept its header [V: baseline §6.6].

### 7.5 Reader

```
←  Home · 3 of 8                                          Ask   Today
   ┌ paper (760) ─────────────────────────────── 🔖 🗑 ⋯ ┐   Notes (240)
   │ (J) Jordan Park                               Friday │   Due tomorrow   Set
   │ Two layout directions ready, wants your preference  │   1 attachment
   │ by tomorrow                     (Newsreader 20/28)  │   ─────────────
   │ A quieter home for our project   (16/500 ink-2)      │   Why it's in Home
   │ Hi Alex, …                       (read 15/24, 68ch)  │   "Can you send me your
   ├ flap ────────────────────────────────────────────────┤    preference by tomorrow?"
   │ [↩ Reply  Space]                        Later   Done │   Not important ⌥↓
   └──────────────────────────────────────────────────────┘   Jordan · 14 letters · ▪▪▫▪
```

- **Letterhead, in order:**
  1. A sender line: monogram, name (click for a popover with addresses and "How you know them"), and relative date. Bookmark, trash and more are icons top-right.
  2. The **serif summary**, the same text as the Home row.
  3. The subject, quiet.
  4. The body.
  - "Important ▾" leaves the header and moves into ⋯ and the Why disclosure (`Reader.tsx:149-150`).
- **The flap.**
  - On the left is the suggested action, filled, with Space. If the suggestion isn't a reply, a text "Reply" follows (R on hover).
  - On the right are Later and Done.
  - It is sticky at the bottom of the paper while you scroll, and attached to the paper, not floating.
  - Undo lives in toasts.
  - This removes the three "Reply" controls and the 54 px pill [V: baseline §6.2].
- **Margin rail** (on the canvas, `--dim`). Its three groups are separated by hairlines:
  1. **Found here:** due date and todo controls, kept visually apart from the summary (your note); plans found in mail (dashed outline, "Add to calendar"); attachments.
  2. **Why it's in Home:** one sentence + a quote + the corrections ⌥↓ "Not important" and ⌥↑ "Always Home", which write deterministic sender rules and toast with Undo.
  3. **The sender:** two-way thread count, first and last exchange, and a 12-week dot row. It is labelled as history, not trust.
- **Threads.** Messages collapse to 28 px one-liners. ↑/↓ moves between messages and a 3 px accent rail follows (`cursor`). J/K moves between threads with `swap` and the double buffer. "Show quoted text" toggles with O.
- **HTML mail** renders in a sandboxed iframe with no scripts, on a light surface that keeps the email's own background even in dark mode. Plain text follows the theme. Remote images are off by default, with "Load images from this sender" (`gaps/electron-email-html-isolation.md`).
- **States:**
  - Summary pending: `breathe` on the subject line in the summary slot.
  - No provider: the subject takes the summary slot in SF, and nothing else changes. "Couldn't summarize this email" is removed (`Reader.tsx:227`).
  - Body loading past 1.5 s: the previous letter stays, with a 12 px line.
  - Body failed: an `ErrorLine` in the paper ("Couldn't load this email · Try again").
  - Attachment failed: the chip goes `--stamp-ink`.
  - Narrow: the rail folds into a "Notes" disclosure under the letterhead.

### 7.6 Compose and inline reply

- **New message.** A 680 px paper sheet `settle`s from the Compose button. It is non-modal: the toolbar and the dock stay available. The post edge runs along its top. The footer holds filled Send, attach, format (or ⌘/) and the `DraftState` line.
- **Inline reply** opens inside the reader's paper, above the flap, with the same edge, so the thread stays visible. "Pop out" moves it to a sheet.
- **Draft state** is one line: "Saving…", "Saved", "Couldn't save · Retry". After "Saved", Esc just closes. That fixes "✓ Saved" followed by "Save this draft?" [V: baseline §6.9 #3].
- **Send.** The sheet `post`s away and the message `arrive`s in its thread with an `UndoTray` whose post edge drains.
  - **One notice per send** [fixes baseline §6.9 #2]. With no visible thread, it is a single toast instead.
  - The undo-send options include the stored default (8 s) [fixes #1].
  - ⌘⇧Return sends and marks the thread Done.
- **Dictation:** hold Space in an empty body, or hold R from the reader. A `LevelMeter` sits at the field edge. Release commits and Esc cancels. The text stays editable.
- **Blocked send** outlines the field and explains in one sentence. The shake is removed.
- **AI draft** inserts editable text at the caret. Tab accepts, Esc dismisses, and typing replaces it. **Polish** shows a diff beside your text and never overwrites it.

### 7.7 Ask dock and Today

- **Placement.** Docked right at 360 px, X on the right. It is **closed on first run** and remembered after that (decision 9).
- **Header:** bubble glyph, then "Ask | Today" on a `Puck`, then X.
- **Empty:** the field placeholder "Ask about your mail or calendar". Below it are three plain suggestions and recent chats with times.
- **Conversation:**
  - Your question is one `--ink-2` line with a 2 px left rule. There are no chat bubbles.
  - Aplos's answer is serif `answer` prose directly on the dock, with the decisive fact at weight 500.
  - Citations are mono `[1]` chips that show the quoted sentence on hover and open the source on click.
  - Every answer cites its sources or says "No source in your mail".
- **While working:**
  - One steady line names the real step ("Reading 14 emails from Jordan"), then folds into a dim step log.
  - Input is never disabled. Follow-ups typed during streaming queue as small editable cards (⌘Return sends now).
  - Streaming shows one thin non-blinking caret, with no typewriter or blur.
- **Proposals** are paper cards with a consequence line ("Add to Calendar · Thu 14:00–14:30 · Work") and two key rows ("Add, Return" / "Not now, Esc"). Nothing is applied without confirmation.
- **No provider:** "Ask needs a provider. Choose one in Settings." plus a link. No red error [V: `ask-no-key-error`].
- **Provider error:** an `ErrorLine` with Retry and "Use another provider".
- **Today tab.** A compact agenda: the next event, the following two, the free gaps, a now line and "Open Calendar". It replaces the 6 AM–11 PM grid that holds one event.

### 7.8 Calendar

- **Fixes first** [V: baseline §6.9 #6–8]:
  - Overlapping events get a 44 px minimum column, an ellipsis and a stacked "+2" that opens the stack.
  - Day titles get the comma ("Sunday, October 25, 2026").
  - Delete appears only on persisted events.
  - Hour labels use `caption` (11 px).
- **Visual.**
  - Events: radius 6, a 2 px leading rule in the calendar colour, a 16 % / 26 % fill, the title at `small` 500 and the time in `--dim`.
  - Plans found in mail use a dashed 1 px outline and a "From mail" label until confirmed.
  - Today's column is tinted `--sky` at 8 % (dark: `--horizon`). The now-line is a 1 px `--stamp` line with a 5 px cap.
- **Motion.** D/W/M ride a `Puck`, and the existing FLIP, period slide and pinch zoom are kept (`calendarMotion.ts`) [V]. Drag to create, move or resize uses `lift` and `snap`.
- **Keys** are unchanged (§8). The title is the real date; "Today" is a button.
- **Narrow** (workspace under 720 px): an agenda list.

### 7.9 Command palette and search

**One overlay, two entry points:**

- **`/` opens search.** Local results appear as you type. Recognised operators (`from:`, `to:`, `subject:`, `has:attachment`, `before:`, `after:`, `in:`) become removable pill tokens. Remote Gmail search runs **only on Return**, to protect quota (`protocols/proto-google.md`). Results are ordinary rows.
  - **No match:** "No mail matches 'dentist'." plus "Search all mail on Google · Return".
- **⌘K opens commands** (typing `>` switches).
  - It is 600 px wide, level 2, and `settle`s.
  - The first line is a **context line** naming the target ("For: Drew Bell · October illustrations"), so commands know what they act on.
  - Groups: Actions, Go to, Ask, Settings, each command with its keycap from the registry. Nested pages use breadcrumbs. 1–9 run the Nth result in short lists.
  - Scoring order: exact, prefix, word boundary, then subsequence. Recent commands get a boost but never beat an exact match.
  - Destructive commands confirm with two key rows.
  - Esc goes up one level, then closes.
- **Acceptance:** every registry action is reachable here, the context line is truthful, and Esc never navigates.

### 7.10 Settings

- **Layout.** The title "Settings" sits in the toolbar. The nav is aligned with the first group; today it starts 74 px low [V: baseline §6.2].
- **Sections:** General, Mail, Calendar, AI, Notifications, Accounts, Keyboard, Help & about. Every setting is searchable from ⌘K.
- **Rows** are 40 px: label (`ui`), one line saying what the setting *does* (`small` `--dim`), and the control on the right. Longer text goes behind a disclosure.
- **AI.**
  - A provider list: Groq (the default), OpenAI, Claude, Gemini, OpenRouter, OpenCode Go, Ollama, LM Studio and a custom OpenAI-compatible server.
  - Each row shows its status dot and its key source ("From environment: GROQ_API_KEY" or "Saved in Keychain"). **Key characters are never shown.** Each has Test and Remove.
  - Local and custom servers show an editable address with the default port.
  - A feature table: Ask, Summaries, Drafts, Plans, Voice, each with a provider and model picker. Voice lists only speech-to-text providers (Groq, OpenAI).
  - This is the one privacy explanation in the app.
- **Keyboard (new).** Generated from the registry, with remapping, conflict marks, the single-key switch (WCAG 2.1.4) and "Show all key hints".
- **Accounts.** One name per account everywhere [V: baseline §6.6]. The connection state and Reconnect sit on the row.
- **Mail.** Undo-send options are 0, 5, 8, 10, 20 and 30 s.
- **Copy.** Every line in the voice of §10. "A comfortable place for your mail." becomes "Light, dark, or match the system."

### 7.11 Onboarding window

The window that PR #21 introduces stays unmerged until it is reworked. This is its target design, and Appendix C maps every review finding to a rule here.

*Amended 2026-10-27 to match the owner's wishes, which win over the earlier text: a separate, smaller, full-bleed window; demo mail only from a small top-right button; a fresh install with zero accounts and no demo data (plan 30 U8).*

- **Window.** A separate window, smaller than the mail window, created by main on first run (no accounts) or from Settings → Help → "Show welcome"; the mail window does not exist until handoff. 640 × 600, with a minimum of 640 × 520, vertically resizable and a hidden-inset title bar. The sky is **full-bleed**: `SkyScene` (sky moment 1) fills the whole window, including under the traffic lights, and one paper sheet (level 3, radius 20) sits on it with a 16 px margin.
  - Content is **top-anchored** with `justify-content: safe center` and scrolls inside the card. It never clips its top [PR21 F13].
  - The 48 px drag region holds nothing interactive.
- **Steps,** shown as four short dashes:
  1. **Welcome.** The icon, the `display` line "Mail and calendar, one letter at a time." and one filled button, "Add an account". **Demo is a small text button, "Try demo mail", in the sheet's top-right corner** (a no-drag hit area of 24 px or more inside the drag strip). A fresh install has **zero accounts and no demo data**; demo mail is loaded only when that button is clicked (`Demo/load`), skips the first-sync screen, and can later be reset or removed in Settings.
  2. **Accounts.** Choices are Google, Microsoft (shown only once a client ID exists) and other IMAP mail. You can add more than one.
     - Typing an address + Return discovers the provider and **focuses the next primary control** ("Continue with Google") [F12].
     - OAuth shows "Waiting for Google in your browser…" with Cancel.
     - A connect that finishes after you've moved on **never pulls you back**. It quietly updates the accounts list [F9].
  3. **AI (optional).** Groq is preselected. The step shows the key source or a field, a Test button, "Skip for now" and one sentence. Skipping never produces an error later.
  4. **Voice (optional).** Explains holding A and holding R, offers the microphone permission now or later, and is skippable.
- **Keys.** Return continues and each step focuses its main action. Esc goes back a step; on Welcome it means "Skip setup". Tab order is visual order.
- **Closing is always safe.**
  - The footer says "Setup continues in the background."
  - Closing at any step, with or without a main window, ends the setup session in the engine, never leaves AI deferred, and backfills classification for mail already synced.
  - A connect that resolves after closing is classified normally [F1, F2, F5, F6]. These are engine contracts handed to the architecture plan as `Setup/end` and one-shot deferral; the UI must call `Setup/end` on every close.
- **Handoff to the mail window.** The mail window is created hidden and shown only on `ready-to-show`. The onboarding card fades out over 120 ms in the same callback, so there is no blank flash [F4]. With more than one account, the mail window opens on **All accounts** [F7]. A second app launch during startup never opens a second window [F3].

### 7.12 First-sync loading screen

This is the screen shown after setup, before the inbox (step 5 of the onboarding window), and also the screen for "Add account" from Settings.

*Amended 2026-10-27 to match the owner's wishes: after setup, a sync-loading screen with honest progress, and entering early always available. Under Gmail's quota it gates only on the newest mail (the first window, about 50 threads) and a time-capped sorting pass, never on the whole mailbox (plan 30 U8).*

```
  Getting your mail
  ▰▰▰▱▱  jordan@gmail.com
  ✓ Connected
  ✓ Found about 214 recent emails      (only when the provider gives an estimate)
  ◐ Reading your newest mail · 24 of 50
  ○ Sorting what matters
  Google is asking us to go slowly. Your newest mail is ready now;
  older mail will follow.      [Continue anyway  Esc]  [Open Aplos  Return]
```

- **Progress follows engine checkpoints, never a fake percentage.** The four segments are Connect → Find recent mail (a count only as "about N" when the provider gives an estimate, otherwise a quiet indeterminate bar) → Read your newest mail (n of the first window, never the mailbox total) → Sort what matters (summaries x of y, at most 40 and 60 seconds). The current segment uses `status`. Older mail (backfill) is never part of the screen; the status slot takes it over after entering.
  - With no AI provider, the "Sort" segment is omitted rather than failed.
  - With several accounts, each gets a row with its own `ProgressSegments`, labelled with its address.
- **"Open Aplos" is enabled once the newest batch is in** (the Home candidates). Mail can never be stuck behind summaries.
- **Entering early is always available.** "Continue anyway" (Esc) works from the moment of Connect; entering before any mail arrives opens Home with "Your first mail is on its way." and the status reason, never the all-clear sky. Aplos opens by itself only on a clean finish; any pause, failure or partial pass waits for you.
- **Honest outcomes [F10]:**
  - Partial: "Sorted 12 of 40. The rest continue in the background." The word "Done" never appears for a capped or failed pass.
  - AI failure: "Couldn't sort with Groq: the key was refused. Mail is ready; sorting will retry." plus "Open Settings".
  - An account that was skipped or isn't connected shows "Not connected · Try again", never an endless "Waiting".
- **Rate limits.** The first real Gmail sync hit a 403 from per-user quota (CONTEXT; `protocols/proto-google.md`). The screen says "Google is asking us to go slowly. Your newest mail is ready now; older mail will follow.", plus the resume time if known. A raw error is never shown.
- **While waiting (optional, from Instrument).** "Try the keys while your mail arrives": a 30-second drill on demo letters (J/K, Space, E, A), each step with its keycap. It is skippable and never blocks.
- **Failure.** "Some mail didn't come through" lists each account's plain reason with Try again. **Esc = "Continue to Aplos"** and it works, because the screen owns Esc on this step [F8]. Retry is idempotent: a second run never collides with the first [F5].
- **Accessibility [F11].** There is no `aria-live` on the list. One visually hidden `role="status"` announces only phase changes (connected, found, ready, failed). Every progress bar is labelled "jordan@gmail.com sync".
- **Complete.** The segments collapse into a drawn check and the sky brightens once (`sunrise`, sky moment 2). It is static under reduced motion. The same component serves "Account connected" and the status slot's "Importing N of M".

### 7.13 Toasts, trays and notifications

- **Stack.** Toasts stack bottom-centre of the *content column*, never under the dock, up to three. They are level 2, radius 14, 13 px. Hover or focus pauses them. Plain toasts last 4 s; Undo toasts last 8 s, then fade over 400 ms.
- **Wording follows the op queue:**
  - Pending: "Archiving…"
  - Confirmed: "Done · Undo Z"
  - Destination named: "Moved to Later · Set a date D · Undo Z"
  - Offline: "Saved here · will sync"
- **Rules.**
  - One operation, one notice.
  - An Undo toast is never silently replaced; new toasts stack.
  - Toasts never appear for navigation, successful saves or sync ticks.
  - They are announced politely and never steal focus.
- **Sends** use the `UndoTray` at the object, not a toast.
- **macOS banners:** the sender as title, the summary as body, and actions Reply / Later / Done. Only for mail that reaches Home; per account; never for Low importance.

### 7.14 Empty states

Each is one plain sentence plus at most one action. There is no icon in a circle.

| Where | Copy | Action |
|---|---|---|
| Home | Sky moment 3: "You handled 12 emails." + "Next: Design review at 2:00 PM" | Undo last (Z), shown for 8 s |
| Later | "Nothing set aside for later." | none |
| Bookmarks | "No bookmarks. Press B on any email." | none |
| Drafts / Sent / Trash / Spam | "No drafts." / "Nothing sent yet." / "Trash is empty." / "Spam is empty." | none |
| Search | "No mail matches 'dentist'." | Search all mail on Google · Return |
| Ask | Suggestions + recent chats | n/a |
| Calendar day | "Nothing scheduled." | New event · N |
| Low importance | "No low-importance mail." | Back to Home |

### 7.15 Error states

Every error says what happened, what is safe and what to do. There are no exclamation marks and no stack traces.

| State | Where | Copy | Action |
|---|---|---|---|
| Sign-in expired | Status slot + account row | "Google needs you to sign in again." | Reconnect |
| Rate-limited | Status slot | "Google asked us to slow down. Resuming at 2:14 PM." | Retry now |
| Offline | Status slot | "Offline · 2 changes waiting" | none (drains automatically) |
| Write rejected | Inline on the row, which returns to place | "Couldn't move to Later." | Retry |
| Send failed | Thread tray | "Couldn't send to Jordan. Your draft is saved." | Try again · Edit |
| Body failed | Reader paper | "Couldn't load this email." | Try again |
| Attachment failed | Chip | "Couldn't download." | Try again |
| Summary failed / no provider | Nowhere on the mail surface | The subject takes its place; one line in Settings → AI | n/a |
| Ask failed | Dock | "Groq didn't answer." | Retry · Use another provider |
| Engine unreachable (fatal) | Full window on canvas | `display`: "Aplos can't reach its mail engine." + "Your mail is safe on this Mac." | Restart engine · Copy diagnostics |

"Aplos needs a moment." and "Making room for your mail…" are retired (`App.tsx:472`). Startup with a local index shows the shell immediately, never a loading screen.

### 7.16 Sky moments

The sky is **drawn in code**: a gradient from `#67ccff` to `#2a9afd` in light (the icon's sampled sky [V: SYNTH-ui §2.3]), a night gradient from `#11263d` to `#0b1219` in dark, a hill silhouette in `--hill`, and one thin wind arc at 12 % white. No stock imagery, video or confetti.

There are four moments:

1. The onboarding window.
2. First sync complete (`sunrise`).
3. Home empty (`sunrise`, once per emptying), with two facts.
4. The always-on 320 px horizon tint.

Moments 2 and 3 can be skipped with any key and are static under reduced motion.

> **What this means:** Every screen keeps its job and your keys. The biggest visible changes are the reader's new layout, a real command palette, honest sending and an onboarding window that cannot get stuck.

---
## 8. Keyboard map

**Grammar.** Each key means one thing per context. Tap to act; hold the same key to say it. **Space is always the suggested action.** Places use ⌃ + a number, verbs are letters, and everything else is in the palette. There are no g-sequences: one grammar is calmer than two. Every binding is declared once in `CommandRegistry`.

| Context | Keys |
|---|---|
| **Global** | ⌘K palette · / search · C compose · A Ask (hold A: dictate to Ask) · ⌘J toggle dock · ⇧A Today · ⌘, settings · [ sidebar / minimised menu · ? shortcuts · Z undo · ⌃1–8 Home, Later, All mail, Drafts, Sent, Calendar, Trash, Spam · ⌘⌥L skip to list · ⌘⌥R skip to reader · Esc ladder: close transient → clear selection → back (never closes the window) |
| **Lists** (Home, Later, All mail, search) | J/K or ↓/↑ move · Return or O open · **Space suggested action** · E Done · L Later · D due date · B bookmark · U read/unread · # trash · R / ⇧R / F reply / reply all / forward (hold R: dictate a reply) · X / ⇧X / ⌘A select · . more · I why · ⌥↓ not important · ⌥↑ always Home · Tab / ⇧Tab next or previous section · S go one by one |
| **Home and one-by-one only** | → Done · ← Later (sides follow the swipe-direction setting) |
| **Reader** | Everything in Lists, plus → / ← triage · J/K next/previous thread · ↑/↓ previous/next message · O quoted text · ⌘F find · Esc back |
| **Compose** | ⌘Return send · ⌘⇧Return send and Done · hold Space in an empty body: dictate · Tab accept AI text · Esc dismiss AI text, then close (no prompt if saved) · ⌘B / ⌘I / ⌘U · ⌘⇧C Cc/Bcc · ⌘⇧A attach · ⌘/ format menu |
| **Ask** | Return ask · ⌘Return search all mail · ↑/↓ suggestions and history · ⌘N new chat · Return / Esc on proposals · Esc stop → clear → close |
| **Calendar** | T today · D / W / M views · J/→ and K/← period · N new · Return open · E edit · ⌫ delete (8 s undo) · ⌥-click solo calendar · pinch or ⌘-scroll zoom |
| **Palette, menus, date picker** | ↑/↓ · Return · 1–9 pick · Esc up a level, then close · date presets 1–5 |

**Changes from today** [V: baseline §5]:

- Space stops meaning four things. Reply moves to R everywhere, and the reader's Space runs the suggestion.
- Arrow triage is limited to the single-letter screens.
- ⌘K becomes a palette.
- The sheet is generated from the registry, so it can no longer omit ⌃5, ⌃7, ⌃8, ⌘K or ⌘/.
- The `keys.s` double assignment disappears.

**Discoverability.** Keycaps appear on hover, on focus, while ⌘ is held, and in tooltips, the palette and toasts. Space on the primary action is always shown.

> **What this means:** Most of your keys stay. Space does the smart action, R replies, and holding a key dictates. The help sheet always matches the real keys.

---

## 9. How AI appears

| # | Rule |
|---|---|
| 1 | **The voice is the mark.** Summaries and Ask prose are set in Newsreader. No glyph, badge, label, colour or glow says "AI". |
| 2 | **Suggestions wear their action's icon** (reply, calendar, link, paperclip, cart, phone). The verb is literal: "View invoice", "Reply with times", "Add to calendar". |
| 3 | **Working = breathing text.** The placeholder line breathes (`breathe`) and stops the instant text arrives. There is no gradient glimmer (`styles/reader.css:82-94`, `styles/focus.css:330`), no pulsing dot, no shimmer, no typewriter and no per-character blur. |
| 4 | **Reasons on request.** The Why disclosure gives one sentence and a quote from the mail, with one-key corrections that write deterministic sender rules and confirm with an Undo toast. Model names, scores and schema stay behind a developer toggle. |
| 5 | **Provenance on hover only:** "Summary · Groq · gpt-oss-120b"; local models say "on this Mac". |
| 6 | **Drafts are ordinary text.** They are editable, with Tab / Esc and neutral controls. Polish is a diff that never overwrites your text. Nothing sends or writes to the calendar without a confirmation row. |
| 7 | **Absence is quiet.** With no provider, the subject takes the summary's place, there is no error on the mail surface, and one line appears in Settings → AI. |
| 8 | **Banned in every form:** sparkles, wands, stars, the `apple.intelligence` glyph, brains and robots, purple gradients, rainbow or animated borders ("beams"), shimmer, and the words "magic", "AI-powered", "smart" as a label, "Copilot" and "Beta" badges. Enforced by lint on icon names and UI strings (§12.2). |

> **What this means:** Aplos speaks in a serif typeface and gives a plain "because" line for its suggestions, never a glowing icon. With AI off, nothing looks broken.

---

## 10. Voice and microcopy

**Rules.** Say what a thing does, not how it feels. Buttons are verbs ("Send", "Reconnect"), never "OK". No exclamation marks. Errors say what happened, what is safe and what to do. Summaries are third person with the action and date folded in. There is one privacy explanation, in Settings → AI.

| Today | Replace with |
|---|---|
| "Swipe through them" | "Go one by one" |
| "Hold to talk" (reader pill, Ask pill, compose) | Removed from controls; tooltips say "Hold A to dictate" / "Hold R to dictate a reply" |
| "Tap to write · hold to talk" | "Reply · R. Hold R to dictate" |
| "Todo", "Todos", "Moved to Todo", "Move to Todo", "keep it as a Todo" | "Later", "Moved to Later", "Press L to set an email aside" |
| "Hide all" | "Clear from Home" |
| "Ready when you are" / "Waiting on you" / "No reply yet" | "Due now" / (merged into New) / "Waiting on others" |
| "Ask me anything" | "Ask about your mail or calendar" |
| "Your day beside your mail" | "Today" |
| "All clear for now" | Sky moment: "You handled 12 emails." |
| "A comfortable place for your mail." | "Light, dark, or match the system." |
| "Aplos is ready when your day begins." | "Open Aplos when you log in." |
| "Make light work of your inbox." / "A few useful things" | "See every shortcut." / "Help" |
| "A little less inbox. A little more life." | "Version 0.3.0 · macOS" |
| "Making room for your mail…" / "Aplos needs a moment." | (no loading screen) / "Aplos can't reach its mail engine." |
| "Couldn't summarize this email · Groq isn't set up" | (nothing; the subject shows) |

These phrases are on the lint ban list (§12.2): "Swipe through them", "Hold to talk", "Hide all", "Todo", "Be here now", "Sent with", "Ask me anything", "magic", "AI-powered".

> **What this means:** Every phrase that echoed Avec is replaced, and the app uses plain wording instead of an assistant's voice.

---

## 11. Accessibility

1. **Contrast.** All text is 4.5:1 or better, and non-text 3:1, in both themes and in Increase Contrast. This is enforced by CI on every declared pair (§12.4). Colour is never the only signal: Done is a check plus a word, Later a clock plus a word, overdue an icon plus text, unread a dot plus weight, and a plan a dashed outline plus a label.
2. **Focus.** A 2 px `--accent` ring with a 2 px paper gap (6.66:1 light, 8.23:1 dark), 3 px under Increase Contrast. It is never removed. Focus is never lost on commit, view change or dock toggle; it moves to the next row, the reader's Back, or the palette input.
3. **VoiceOver.**
   - Lists are a `listbox` with `aria-activedescendant`, and the reader is an `article` with landmarks for summary, body and notes.
   - The palette is a `combobox`, and the calendar is a `grid` with text equivalents.
   - After a triage key, one polite announcement says what happened and what is next.
   - Toasts are polite and never steal focus. Progress announces phases only (§7.12).
   - Icon-only buttons have labels and tooltips.
4. **Keys.** Every pointer path has a key. Single-key shortcuts can be switched off (WCAG 2.1.4), and every key can be remapped. Dictation always has a typed equivalent. The IME rules are in §5 rule 16.
5. **Motion and transparency.** Reduced motion uses the "Reduced" column in §4.8 (opacity at most 120 ms, no travel, no sky animation; spinners stay). Reduce Transparency makes glass opaque. Nothing flashes more than 3 times a second.
6. **Size.** Everything is in `rem`, and 200 % zoom works down to the 900 px minimum window. Nothing is under 11 px. Targets are at least 24 px (28 px default).
7. **Checks.** An axe scan of every harness state in both themes, a keyboard-only walkthrough of ten core tasks, and manual VoiceOver passes for Home, the reader, compose, Ask, the calendar and onboarding. Japanese and Chinese IME tests.

> **What this means:** The calm look follows accessibility rules, and automatic checks enforce each one.

---

## 12. Enforcement

### 12.1 One source of truth

`ui/tokens.json` (W3C token format) generates `tokens.css` (light, dark and increase-contrast blocks), `motion.ts` (durations, easings and spring solvers, with each `linear()` string generated from its spring), and `contrast-pairs.json`. The generator is a small script in `apps/desktop/scripts/`. Hand edits to generated files fail CI.

### 12.2 Lint rules

These run in `npm run lint`, in pre-commit and in CI. Exempt files: the token sources and generated files only.

| Rule | Tool | Fails on |
|---|---|---|
| No raw colour | stylelint `color-no-hex`, `function-disallowed-list: rgb, rgba, hsl, hsla, oklch, lab`; ESLint `no-restricted-syntax` on string literals matching `/#[0-9a-f]{3,8}\b/i` or `rgb(`/`hsl(` in `.ts/.tsx` | any colour not written as `var(--…)` |
| No literal durations or easings | stylelint `declaration-strict-value` on `transition*`, `animation*`; ESLint rule on `.animate()` / `setTimeout`-driven motion requiring `motion.ts` imports | `ms`, `s` or `cubic-bezier(` outside tokens |
| No layout-property motion | stylelint `declaration-property-value-disallowed-list` for `transition`/`transition-property` containing `all`, `width`, `height`, `padding`, `margin`, `top`, `left`, `right`, `bottom`, `inset`, `flex-basis`, `grid-template`, `font-size`, `border-width`; a custom plugin that rejects those properties inside `@keyframes` and in WAAPI keyframe objects | any layout property animated |
| Reduced motion covered | custom stylelint plugin | a `@keyframes` or `animation` not neutralised by the generated reduced-motion block |
| No literal spacing, size, radius, shadow or z-index | `declaration-strict-value` on `padding*`, `margin*`, `gap`, `font-size`, `line-height`, `border-radius`, `box-shadow`, `z-index` (allows `0`, `1px` hairlines, `100%`, `auto`) | literals |
| No `will-change` in static CSS | stylelint `property-disallowed-list` | `will-change` in a stylesheet (only `motion.ts` sets it while animating) |
| Banned glyphs | ESLint `no-restricted-imports` / `no-restricted-syntax` for the icon names in §4.7 | any sparkle, wand, star or brain icon |
| Banned strings | ESLint rule over JSX text and string props, case-insensitive, for §10's list | any banned phrase |
| Button idioms | ESLint: `Button` `variant` ∈ {filled, text, icon}; at most one `filled` per route (a harness check, §12.5) | other variants |

### 12.3 The `aplos-design` skill

The path is `.claude/skills/aplos-design/SKILL.md`, with an `AGENTS.md` rule: "Before touching `apps/desktop/src/renderer` or `apps/web`, load `aplos-design`." This is the method Redakt uses for its agents [V: `ui/redakt.md` §6.2]. The T3 UI thread's brief repeats the rule. The skill contains:

1. The ten principles (§3) and the not-Avec test (§2.3).
2. A token cheat-sheet: the colour roles, the ten type roles, spacing, radius, elevation, and the 25 motion names with when to use each.
3. The 16 input rules (§5) and the budgets.
4. The component inventory (§6), with "compose, don't invent".
5. The AI rules (§9) and the voice rules with the replacement table (§10).
6. Forbidden patterns: every banned item in §4.7, §9, §10 and §14.
7. **A definition of done for a UI change:**
   - lint is clean;
   - `npm run test:visual` passes or its baselines are updated with a reason;
   - `npm run test:perf` passes for touched interactions;
   - contrast CI passes;
   - before and after screenshots, headless, both themes, are attached to the PR.
8. How to verify headlessly. Never drive a visible window (owner rule).

The skill is versioned with the tokens. A token change that doesn't touch the skill fails a CI check that compares the token names listed in the skill against `tokens.json`.

### 12.4 CI contrast and identity checks

- **Contrast.** `scripts/check-contrast.mjs` reads `contrast-pairs.json` (fg, bg, min, usage) for light, dark and increase-contrast. Translucent tokens are composited over their declared background. Every pair must meet its WCAG 2.x minimum (4.5 text, 3.0 large or non-text). APCA Lc is reported as advisory. The pairs in §4.1 are the initial set. A new token can't merge without declaring the pairs it's used in.
- **Identity.** The same script computes ΔE00 between `--accent`, `--hill`, `--dusk` and `--stamp` (both themes) and a reference list kept in the repo (Avec `#0050ff`, `#07aa04`, `#03ce4c`, `#36b7ff`; Spark, Missive, Mimestream, Airmail, Shortwave, Canary and Apple blues from `identity-collision-audit.md` §4). Any distance under 8.5 fails. The canvas must have Lab b* < 0 in both themes.

### 12.5 Headless screenshot regression harness

- **Driver.** Playwright. Use `_electron.launch` with the window created `show: false`, plus offscreen capture via `webContents.capturePage()`, for the desktop app. Use headless Chromium for the browser preview. Never use a visible window (owner rule).
- **Isolation.** Each run uses a temporary `APLOS_DATA_DIR` seeded with the original demo data, its own API and Vite ports, and no AI keys unless a scenario injects a mock provider.
- **Determinism.** A frozen clock (`2026-10-29T10:00`), bundled fonts, the locale fixed to en-US, the cursor hidden, and caret blink off.
- **Onboarding.** The harness handles the onboarding window explicitly, by seeding `onboardingDone` or driving it. This fixes the PR #21 lesson where the website capture script stalled on the new window [F14].
- **Matrix.** Each state in §7 (about 90 named states, listed in `tests/visual/states.ts`) × {light, dark} × {1440×900, 1100×760} × {default, Increase Contrast for a 20-state subset}.
- **Diffing.** Pixel diff with a ΔE > 2 threshold. A diff of more than 0.1 % of pixels fails, and failures are reported with an overlay image. Baselines are committed under `tests/visual/__baselines__` as an internal fixture; they are never attached to PRs as-is.
- **Motion filmstrips.** For the signature motions (`commit`+`flight`, `carry`+`hold`+`close`, `deal`, `post`+`drain`, `dock`, `slide`, `sunrise`), pause the document timeline and step `Animation.currentTime` to 0, 30, 60, 120, 220 and 400 ms. Capture each frame, then diff the strips.
- **DOM assertions alongside the pixels:**
  - the §2.3 not-Avec checks;
  - one filled button per route;
  - no element with a computed `transition-property` that includes a layout property;
  - no text under 11 px;
  - axe with no serious violations;
  - no banned strings or icons.
- **Commands:** `npm run test:visual` and `npm run test:visual -- --update` (requires a reason).

### 12.6 Performance budget suite

`npm run test:perf` runs in the **packaged** build. The renderer is driven by synthetic key events through CDP, against a 10k-thread fixture store. It measures with the Event Timing API and `PerformanceObserver` for long animation frames, and asserts the §5 budgets at p95 over 50 runs. Results are recorded to `tests/perf/history.json`. A slowdown of more than 10 % against the 7-day median fails.

> **What this means:** Lint rules block raw colours, literal timings and layout animation. Automatic contrast, Avec-distance and screenshot checks run before anything merges.

---

## 13. Avec-derived layouts and wording to remove

The root cause is that `DECISIONS.md:125` set "Visual parity (M14)" to reproduce "the reference's measurable look (layout sizes, spacing, radii, palette values, translucency…)", and `DECISIONS.md:129` set "Interaction parity (M16)" to follow its timings [V]. **Both decisions are superseded by this spec.** `DECISIONS.md:128` still claims matching phrases were rewritten; the items below show they weren't. Line numbers are from `apps/desktop/src` at 27cf52f [V: grep], with the Avec evidence beside each.

| # | Avec-derived element | Where in Aplos | Avec evidence | Replacement |
|---|---|---|---|---|
| 1 | "Swipe through them" pill next to the "New" header | `renderer/App.tsx:498` (used at :510) | `seg/t0174.2.png` (same pill, key N) | "Go one by one" as a text button with S on hover (§7.2) |
| 2 | Floating bottom cluster: bookmark · ← Todo · big blue Reply/Space/"Hold to talk" pill · Done → · Undo circle | `renderer/Reader.tsx:175-186` (also the binned variant), `:69` and `:84-89`; `styles/reader.css:313-321` (`.reader-dock`, `.dock-pill` 44 px, radius 28) | `seg/t0176.3.png` | The flap (§7.5); Undo in toasts |
| 3 | "Hold to talk" under Reply; "Tap to write · hold to talk" | `Reader.tsx:89`, `:84` | `seg/t0176.3.png` | Tooltip only: "Hold R to dictate a reply" |
| 4 | Top-right Ask pill with magnifier, "A" and "Hold to talk", plus a Calendar pill | `components/Topbar.tsx:22-23`; `styles/ask.css:10-28` | `seg/t0176.3.png` (same pill) | Icon button with bubble + "Ask"; Today icon (§7.1) |
| 5 | "Hold Space to talk" in compose | `renderer/Compose.tsx:417` | Avec voice drafting (`ui/avec.md` §5) | Hint only in the tooltip and the `?` sheet |
| 6 | "Todo / Todos" naming | `App.tsx:25`, `:40`, `:534`; `Reader.tsx:68-69`; `components/MailList.tsx:360`; `components/Overlays.tsx:26` | Avec's Todo pill and Todos tab (`ui/avec.md` §2) | "Later" everywhere |
| 7 | "Hide all" on the returned-todos section | `App.tsx:510` | `ui/avec.md` §2 ("Hide all") | "Clear from Home" |
| 8 | Two reply sections on Home ("Waiting on you", "No reply yet") mirroring Avec's needs-reply and awaiting-reply sections | `App.tsx:510`; `shared/mailbox.ts:15` | `seg/t0174.2.png` | New + Waiting on others (§7.2); Done leaves Home (decision 6) |
| 9 | Stack heading "Home 1 of 8" above a centred card with the **next card's sliver** behind it | `Reader.tsx:137-138`; `styles.css:331-332` (`.deck.has-next::before`) | `seg/t0176.3.png`; `ui/avec.md` §2, §7 | Position in the toolbar title; no deck, no sliver |
| 10 | "Important ▾" dropdown + ⋯ in the card's top-right header | `Reader.tsx:149-150` | `seg/t0176.3.png` | In ⋯ and the Why rail (§7.5) |
| 11 | Card toss with rotation (fling) and return-with-rotate | `styles.css:343-360` (`rotateY(±14deg) rotate(±4deg)`), `:333-336` | `ui/avec.md` §4 rows 1, 5 | `flight` with a 2° tilt and no 3D (§4.9) |
| 12 | Low-importance bundle as a count badge + comma-joined sender list | `App.tsx:510` (`.low-line`); `styles/focus.css:226-243` | `seg/t0174.2.png` | The band in §7.2 (count on the right, at most three names, "and N more") |
| 13 | Warm-grey canvas with white cards and a system-like blue | `ui/tokens.css:93-94` (`--canvas #e5e4e1`, `--card #fff`), `:108-112` (`--blue #0682fe`, `--green #0a9c0a`), dark `:161-179` | `ui/avec.md` §3; audit §4 | §4.1 tokens |
| 14 | Pill buttons with inline keycaps on every control (B, Later ←, Done →) | `components/MailList.tsx` card actions; `Button variant="pill"` (`App.tsx:498`) | `seg/t0174.2.png` hover pills | 8 px rectangles; keycaps on hover (decision 8) |
| 15 | The "armed" bar pill growing to 1.06 during a swipe | `styles.css:379-382` | Avec's gesture-button coupling (`ui/avec.md` §6 #3) | The *idea* is kept: the matching flap button takes the action colour while armed, with no scale and no pill |
| 16 | "Ask me anything" with a "Hold A to talk" hint in the field | `Ask.tsx:255-256`, `:261`; `App.tsx:549`; `components/Overlays.tsx:10` | `ui/avec.md` §2 (Ask empty state) | "Ask about your mail or calendar"; hint in the tooltip |
| 17 | Welcome copy teaching "Hold it to talk" | `components/Welcome.tsx:55`, `:122` | Same phrase family | §7.11 copy |

**Behaviours kept on purpose** (your model, with new looks and words): one letter at a time, Space runs the suggestion, hold to dictate, the docked Ask, the low-importance bundle with its own background, Later grouped by date, the D due-date toast, → → mark-all, and rapid-mode timing.

> **What this means:** These 17 items make today's screens look and read like Avec. All of them are fixed in the first stage, and an automatic check stops them returning.

---
## 14. What not to copy from each reference

| Reference (licence) | Never copy | What we take as an idea |
|---|---|---|
| **Avec** (proprietary) | Everything in §13. Also its warm canvas + white card + system blue; full-card colour floods; the 12° toss; the deck sliver; "Swipe through them", "Hold to talk", "Hide all", "Todo", "Be here now"; sparkles on Polish and Due; the default "Sent with" signature; the ocean video and sorting game; needs-reply mailboxes; split view | Rapid-mode timing, unmistakable commits, next-step toasts, → → confirmation by repetition, drag-to-reschedule, a visible learning loop |
| **Tatem** (proprietary) | Hold-Space peek (Space is ours); translucent-everything wallpaper in a native app; 35–55 % text on gradients; scroll theatre; abstract decorative scenes; raw shadcn defaults | Instant lists, one selection spring, four doors per action, key rows in confirmations, two-layer shadows |
| **Zero** (MIT, ideas only) | Sparkles, purple borders, shimmer, per-character blur, the summary behind a pill, a 40 % floating chat, red/green Accept-Reject, overloaded letters, remote images and a branded signature on by default | Folding step logs, operator tokens, neighbour prefetch, queued follow-ups |
| **Redakt** (MIT; skill pack licence unverified) | The rainbow border beam; Generate overwriting typed text; threads as tabs; a fixed 1 s hold; width/height composer animation; the glossy orange Compose; meaning-free rows | The lighting model (0.75 px rings, top sheen, pane lighter than shell), the undo tray under the sent message, agents loading a UI skill |
| **Superlocal** (no licence; engineering ideas only) | Any visual: it clones Superhuman and ships scraped fonts and icons (charcoal and lavender, ink bar, "Get me to zero", bolt glyph); removed focus rings; model internals in user text; a single toast slot that eats Undo | Pinned rows during bursts, honest "Marking…" states, spinners after 150 ms, a pure, table-tested shortcut resolver |
| **Inbox Zero Mail** (AGPL + terms, ideas only) | The Gmail-clone row with chip runs; a list/split toggle; sparkle and wand glyphs; solid blue tooltips; linear-eased panels; a compose window with no origin | Focus moving in the same frame as the action, the double-buffered reader, one registry feeding tooltips, help and toasts |
| **Airmail (Bloop)** | The name in any public use; the stripe as a ring; sky + planes + clouds line art | Nothing |
| **Aplos v0.2.3 itself** | Glimmer, rainbow avatars, icon-in-circle empties, glass pills, assistant-voice copy, view-switch rises, pure black, the 0.46 fade floor | Optical tracking, exits faster than entrances, the calendar's interruptible FLIP, sidebar hover hints |

The rejected parts of the losing proposals are listed in Appendix B.

> **What this means:** We borrow engineering and restraint from each reference app, never its look, wording or assets. Sparkle, glow and shimmer effects are excluded.

---

## 15. Delivery order and acceptance

For the T3 UI thread. Several steps depend on the architecture plan's contracts: sandboxed HTML, engine prefetch and LRU, op-queue states, sync-state events, first-sync checkpoints, and `Setup/end` with one-shot AI deferral. Until those land, build against mocked states. Mocked Google is never treated as live acceptance (AGENTS.md).

| Stage | Contents | Accepted when |
|---|---|---|
| 1. Trust and identity fixes (days) | §13 items 1–8, 16 and 17; §10 copy; the ten baseline defects (§6.9); the contrast and fade fixes | No banned string in the DOM; every defect has a regression test; contrast CI passes |
| 2. Foundations (~1 week) | `tokens.json` and its generator, `motion.ts` springs, lint rules, contrast and identity CI, `aplos-design` skill, `CommandRegistry`, the harness skeleton | Lint rejects raw hex, literal durations and layout transitions; the `?` sheet is generated; the harness captures 20 states |
| 3. Identity (1–2 weeks) | Palette, the serif gate, Paper / Letterhead / Flap / MarginRail, no avatars or pills, night canvas, post edge, buttons and radii | The §2.3 test passes in both themes; the serif decision is recorded in DECISIONS.md |
| 4. Motion signature (~1 week) | `commit`, `flight`, `deal`, `carry`, `hold`, `close`, rapid mode, the cursor layer, puck, dock fix | §5 budgets pass in the packaged app at 10k threads; filmstrips are baselined |
| 5. Screens (2–3 weeks) | Palette and search, Later, Ask, Settings, Calendar fixes, onboarding and first sync (§7.11–7.12, Appendix C), toasts, empty and error states, sky moments | Each §7 state is in the harness; every PR #21 finding has a test; closing onboarding at any step leaves AI working |

> **What this means:** Trust fixes ship first, then the checks that stop drift, then the new look, then motion, then the remaining screens. Each stage has a check you can see pass.

---

## Appendix A: independent judge scorecard

Scored 0–10 per lens before comparing with `judge-design-glm.md`.

| Lens | Skypaper | Carried | Instrument |
|---|---|---|---|
| Owner taste and beauty | **9** | 8 | 6 |
| Identity and independence (clearly not Avec) | **9** | 6 | 7 |
| Speed, craft and feasibility | 8 | 7 | **9** |
| **Total / 30** | **26** | 21 | 22 |
| GLM's total, for comparison | 27 | 23 | 22 |

- **Skypaper (26).**
  - *Taste 9.* Every taste item is mapped (its §11), sender-first and big-summary are reconciled, the docked Ask is kept, and Space is everywhere.
  - *Identity 9.* The icon becomes rules, ink blue is at ΔE 13.8, the serif voice is unique among mail clients, and there are seven yes-or-no checks.
  - *Craft 8.* The right engineering spine and the best enforcement story. It loses points for an auto-height focus card (list reflow stays possible), a slide-spring settle time that is off by about 110 ms (§4.8), a dark Done green only ΔE 6.8 from Avec's `#03ce4c`, and no cold-start budget.
- **Carried (21).** *Taste 8:* the warmest, with a lovely press feel. *Identity 6:* a warm canvas in Avec's family, a full-card stamp flood (Avec's signature), and an unverified ΔE claim for its dark accent. *Craft 7:* texture costs GPU on every frame, gates are thin, zoom is missing. Two of its signature elements land on Avec's, so I score it below GLM's 23.
- **Instrument (22).** *Taste 6:* no serif, no icon story, 32 px rows, an AI-badge-like "SUMMARY" label, no Space in the reader map, and a fourth reply affordance in the sender block. *Identity 7:* escapes Avec's grammar, but the travelling rule and ink-black button are generic. *Craft 9:* the best engineering (8 ms commit, inverse undo, LRU prefetch, fixed card, IME rules, skip links, packaged gates), but no agent-enforcement layer.

**Agreement with GLM:** same winner, same ten grafts, and no texture. **Disagreement:** I rank Instrument above Carried, because Carried's warm canvas and flood commit fail the not-Avec test, while Instrument's problems are taste, which grafting doesn't import.

## Appendix B: graft ledger

| Graft into Skypaper | From | Where |
|---|---|---|
| Fixed-height focus slot with `deal` | Instrument | §4.4, §4.9, §7.2 |
| Commit-on-keydown ≤ 8 ms, packaged-build gates, cold-start budget | Instrument | §5 |
| Durable op queue; Undo as an inverse operation; rejected writes return with Retry | Instrument | §5 rule 11 |
| IME-safe keys; skip links ⌘⌥L / ⌘⌥R; Esc ladder | Instrument | §5 rule 16, §8 |
| LRU-12 prefetch on 80 ms focus | Instrument | §5 rule 9 |
| "Try the keys" drill during first sync | Instrument (its onboarding drill, moved) | §7.12 |
| Citations or "No source" on every answer; follow-ups queue while streaming | Instrument | §7.7 |
| Press inset highlights swapping on `:active` | Carried | §4.6 |
| → → mark-all on low-importance sender groups | Carried | §7.2 |
| "Set a date · D" and "Remind me if no reply · R" toasts | Carried / SYNTH-ui | §7.2 |
| One-frame theme-switch freeze | Carried / Redakt | §4.8 |
| **Not grafted:** desk and paper noise texture; warm canvas; full-card stamp flood; uppercase AI label; ink-black primary; 32 px default rows; dropping the serif | n/a | Appendix A |
| **Corrected in Skypaper:** dark hill `#6cbf5a`→`#86b86a` (ΔE 6.8→11.6 from Avec); spring constants re-solved; dark sidebar made darker than canvas; commit chip replaces the ambiguous "edge tab with a label" | This spec | §2.3, §4.1, §4.8, §4.9 |

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
| F13 | Centred pages clip their top when content overflows the fixed window (low) | §7.11: `safe center`, top-anchored scrolling card, resizable window |
| F14 | The website screenshot script stalls on the new onboarding window (low) | §12.5: the harness seeds or drives onboarding explicitly |

## Evidence index

- **Proposals and judging:** `plans/proposals/design-{skypaper,tactile,precision}.md`; `plans/_council/judge-design-glm.md`; `plans/_council/CONTEXT.md`.
- **Research:** `research/email-clients/SYNTH-ui.md`; `research/email-clients/ui/{aplos-baseline,avec,tatem,zero,redakt,superlocal,inbox-zero-mail}.md`; `research/email-clients/gaps/{identity-collision-audit,electron-email-html-isolation}.md`; `research/email-clients/protocols/proto-google.md`; `research/pr21-onboarding-review.md`.
- **Screenshots viewed:** `/Users/knewton/.t3/aplos-research/ui/aplos-baseline/{home-light,home-dark,reader-light,welcome-start-light}.png`; `avec/desktop-preview/seg/{t0174.2,t0176.3}.png`; `avec/desktop-preview/dense-done-arrow.png`; `tatem/{hero-mock-flat-gradient,keyboard-overlays}.png`; `redakt/inbox-desktop-dark.png`; `identity-audit/icon-compare.png`.
- **Source lines:** `apps/desktop/src/renderer/{App.tsx,Reader.tsx,Compose.tsx,Ask.tsx,Settings.tsx,bridge.ts,styles.css,styles/{reader,focus,ask}.css,ui/tokens.css,components/{Topbar,MailList,Overlays,Welcome}.tsx}`, `apps/desktop/src/shared/mailbox.ts`, `DECISIONS.md:72,125-130,223,298`, at commit 27cf52f.
- **Owner taste:** project memory `aplos-ui-taste.md`, `no-ai-sparkle-icon.md`, `revamp-plan-phase.md`.
- **Computations:** `/tmp/design-director/c.py` (contrast, ΔE00), `h.py` (dark hill search), `k.py` (fills and surfaces), `s2.py` (springs to `linear()`), all reusing `/Users/knewton/.t3/aplos-research/tools/identity-audit/de2000.py`.
