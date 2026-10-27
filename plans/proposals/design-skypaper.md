# Design direction proposal: Skypaper

Proposal 1 of 3 for the Aplos UI revamp. It develops and hardens the paper-on-sky direction in `research/email-clients/SYNTH-ui.md` section 2. Written 2026-10-27. Nothing here goes to main. Every contrast ratio is computed (WCAG 2.x) and every colour distance is CIEDE2000, using the audit's script (`/Users/knewton/.t3/aplos-research/tools/identity-audit/de2000.py`). Scratch scripts: `/tmp/skypaper/*.py`.

**Evidence key.** **[V]** verified in a file, screenshot or computation (path given). **[I]** my design judgement. References are proprietary or idea-only: no code, assets, wording, icons or layouts are copied.

## In plain English

Skypaper is a proposed look and feel for Aplos. It comes straight from your app icon: a letter carried on the wind over a green hill under a clear sky.

The idea is simple. The email you are handling right now is paper. Everything around it is sky. In light mode the sky is a calm daylight grey-blue. In dark mode it is a night blue instead of pure black. Only one thing at a time is paper: the email in focus, the one you are writing, or a dialog.

We drop the name "Airmail", because Airmail is a real, trademarked Mac mail app. The blue also changes, from bright blue to a deeper ink blue, like fountain-pen ink. That moves Aplos away from Avec's blue and from every other blue mail app we checked.

Several things that look like Avec today are removed. These are the bottom row of big buttons, the "Hold to talk" and "Swipe through them" wording, the pill-shaped Ask button, and the white card on a warm grey desk. The reader gets a new layout: the letter on the left, and a quiet margin on the right for dates, attachments and the reason the email is on Home.

Aplos's own voice, meaning summaries and Ask answers, is set in a letter-like serif font. That is how you can tell the AI is speaking. There is no sparkle, wand or star anywhere.

Motion stays calm and fast. Moving around is instant. Finishing an email has one signature move: the letter is carried off the way you sent it, and it speeds up when you go fast. Your next keypress never waits for any animation.

For you, this means a more distinctive app that is easier to read, with nine clear choices at the end.

---

## 1. Identity: Skypaper

### 1.1 Name and story

**Skypaper** is a codename for docs and tokens, not a product name. It is not a competitor term [V: `research/email-clients/gaps/identity-collision-audit.md` section 7 asks for a descriptive codename]. If it ever goes public, run a clearance search first; this audit did not cover it.

| Idea | In the icon | In the app |
|---|---|---|
| **Paper** | the white envelope | The email being handled. Only the focus letter, reader, composer and dialogs are paper. List rows are not. |
| **Sky** | blue field, clouds | The canvas, with a soft horizon at the top of the window. |
| **Hill** | the green hill | Ground you return to. Done is hill green. |
| **Post edge** | the striped border | A thin diagonal stripe, drawn only as a straight horizontal edge, in exactly two places in the app (section 12). |

Renames required by the audit [V: audit section 7]: "airmail blue" becomes **ink blue**; the stripe becomes **the post edge**; the website's `Airmail` component and `.airmail` classes (`apps/web/src/Chrome.tsx`, `apps/web/src/styles.css`, `apps/desktop/build/dmg-background.html`) become `PostEdge` and `.post-edge`. "Airmail" never appears in UI copy, release notes or the site.

### 1.2 The Avec overlap, and what replaces it [V: baseline `reader-light.png`, `home-light.png` vs `avec/desktop-preview/seg/t0176.3.png`; `ui/avec.md`]

| Avec-derived element in Aplos v0.2.3 | Skypaper replacement |
|---|---|
| Warm grey canvas with one white card | Cool sky canvas with a horizon. Paper is a left-aligned letter at reading width. |
| Floating bottom cluster: bookmark, Todo, big blue Reply pill with Space, Done, Undo circle | A **flap** attached to the paper's bottom edge (section 8.4). Not floating, no Undo circle. |
| Pill-shaped buttons everywhere | **8 px rectangles** for actions. Pills only for counts and chips. |
| Top-right "Ask, A, Hold to talk" pill | A labelled icon button with a speech-bubble glyph. No hint text. |
| "Hold to talk" (twice), "Swipe through them", "Hide all", "Todo/Todos" | Section 14 replaces each ("Go one by one", "Collapse", "Later"). |
| Whole-card colour flood plus 12 degree toss on commit | A coloured **edge tab** and a 2 degree lift (section 7.4). |

Kept, because they are the owner's model: one item at a time, Space runs the AI-suggested action, hold a key to dictate. Skypaper changes the look, shape and words around them.

### 1.3 Acceptance test: "this is not Avec"

Run on a screenshot in both themes. All must hold:
1. Cool blue-grey canvas with a horizon (Avec: warm grey).
2. Accent ink blue at ΔE00 13.8 from Avec's `#0050ff` (today 4.8) [V computed].
3. Done is moss green at ΔE00 21.6 from Avec's `#07aa04`.
4. A serif is visible in the main line (the summary).
5. No pill primary button, bottom cluster or card flood on commit.
6. None of the phrases in section 14.1 appear.
7. The reader has a right margin rail.

> **What this means:** Skypaper gets its identity from the icon: paper, sky, hill and a thin stripe. It keeps your behaviours but none of Avec's look, and seven yes-or-no questions let anyone check that.

---

## 2. Principles

Only the letter you hold is paper. Aplos speaks in a serif and everything else is sans. Input never waits. Navigation is instant and motion is for state changes. One accent and one filled button per screen. Say plainly what happened. Keep the stripe to two places and the sky to four moments.

> **What this means:** the look stays quiet so your mail and your keyboard are the stars, and the few decorative touches stay rare on purpose.

---

## 3. Colour

### 3.1 Tokens (light / dark "night")

| Token | Light | Dark | Role and contrast |
|---|---|---|---|
| `--canvas` | `#e9edf0` | `#0b1219` | The sky. Lists sit on it. Replaces pure `#000`. |
| `--horizon` | `#dce7f1` fading out over 320 px | `#112133` fading out | Soft top tint. Flat under Increase Contrast. |
| `--paper` | `#fefefc` | `#141c25` | Letter, composer, dialogs. In dark it is lighter than the canvas. |
| `--raised` | `#f3f5f7` | `#1b2530` | Inputs, low-importance bundle, keycaps. |
| `--sidebar` (web preview only) | `#e2e8ee` | `#0e1620` | Native macOS keeps vibrancy. Fallback is darker than canvas in dark. |
| `--ink` | `#121820` | `#e7ecf1` | 15.15 / 15.85 on canvas |
| `--ink-2` | `#2f3a46` | `#c4ccd5` | 9.83 / 11.61 |
| `--dim` | `#56616d` | `#97a3af` | **5.36** (today 4.07) / 7.33. Timestamps, metadata. |
| `--faint` | `#7d8792` | `#75818e` | 3.10 / 4.74. Placeholders and disabled only. |
| `--accent` (ink blue) | `#0b5394` | `#88aee0` | 7.76 on paper (light); 8.23 on canvas (dark). White on the light fill **7.84**; dark text `#08111a` on the dark fill **8.30**. |
| `--hill` (Done) | `#2f6f2a` | `#6cbf5a` | White on fill 6.13; dark text on fill 8.36 |
| `--dusk` (Later) | `#3e5878` | `#8fa9cc` | White on fill 7.31; dark text on fill 7.88 |
| `--stamp` (Trash, errors, recording) | `#c4302b` | `#ff7a6e` | White on fill 5.52; dark text 7.47. One red, not two. |
| `--stamp-ink` | `#a3221e` | `#ff7a6e` | Red text on a 10 % tint over canvas: 5.41 (plain `--stamp` there is 4.05) |
| `--sky` | `#9fd3ff` | `#11263d` | Tints and the sky moments. Ink on it 11.24. |
| `--post-red/blue` | `#d83237` / `#1f4fc8` | same at 85 % | The stripe only. |

Other edges: `--line` is ink at 14 % (light) or 12 % (dark) as a 0.75 px ring. `--control-edge` is ink at 50 % or 45 %, giving 3.39 and 3.95 on paper.

Dark `--accent` was chosen by search: my first guess `#6fb2f2` was only ΔE00 5.9 from Avec's sky, so it became `#88aee0` [V: `/tmp/skypaper/e.py`].

### 3.2 Rules

- **One accent per screen.** Hover is ink at 5 % and press 9 % (dark 6 % and 11 %). No raw hex in components; lint enforces it.
- **The Home fade steps down the colour ramp, not opacity:** focus letter `--ink`, next two rows `--ink-2`, the rest `--dim`. Every step stays at 5.36:1 or better. Today's 0.46 opacity floor reaches 1.76:1 [V: `ui/aplos-baseline.md` 6.5]. If opacity is ever used, never below 0.8 on `--ink-2` (5.61). This keeps the owner's "subtle fade".
- **Meaning never rides on colour alone.** Done is a check and the word; Later is a clock and the word.
- **Selection** is `--accent-wash` (accent at 10 % light, 16 % dark) plus a 2 px accent bar at the row's left edge. Dark commit fills are capped at 70 % opacity (dark text on the capped green is 4.82:1).

### 3.3 Collision check [V: audit sections 4 and 6; recomputed]

| Colour | Nearest references (ΔE00) | Result |
|---|---|---|
| Ink blue `#0b5394` | Missive hover `#1c42b1` 8.9; Mimestream link 10.4; Airmail band 12.6; Avec 13.8; Spark CTA 14.3 | Clears the audit's 8.9 floor |
| Dark `#88aee0` | Tatem dark link 9.4; Airmail Mac ring 10.2; Avec sky 10.8 | Low risk |
| Hill `#2f6f2a` | Missive green 11.0; HEY 14.9; Avec Done 21.6 | Moss, not a signal green |

Blue is a commodity, so the blue is not the identity; paper, sky, hill, the serif and the shape language together are [I]. A low-chroma blue can look less clickable, so primary buttons are filled.

### 3.4 Labels, accounts, calendars

Six icon-derived pairs (light / dark), assigned by hashing the name: Sky `#2f6fa3` / `#6aa5d6`, Hill `#2f6f2a` / `#6cbf5a`, Stamp `#c4302b` / `#ff7a6e`, Dusk `#3e5878` / `#8fa9cc`, Sand `#8a6320` / `#d9a65a`, Ember `#b4531f` / `#e08a5a`. All are marks with at least 4.25:1 (light) and 5.87:1 (dark) on every surface. Calendar events fill with the colour at 16 % (light) or 26 % (dark) with `--ink` text, 8.6:1 or better [V computed]. **Rainbow letter avatars are removed.** Rows have none; the reader gets one small neutral avatar.

> **What this means:** the palette is calmer than the icon but clearly its cousin. Every text colour passes accessibility, including the faded rows that fail today. The new blue is far enough from Avec and other blue mail apps to stand alone.

---

## 4. Type

### 4.1 Families

- **Sans: system SF Pro** for mail, controls and navigation. Aplos already tunes tracking to SF [V: baseline 3.2].
- **Serif: Newsreader** (variable, SIL Open Font License), only for "Aplos speaking": summaries, Ask answers, display lines. The website already ships it [V: `apps/web/package.json` per SYNTH-ui], so bundling is simple. Do not rely on `ui-serif` in Chromium [I].
- **Mono:** `ui-monospace` for addresses and code. `--font-mono` is used today but never defined [V: baseline 6.9 #9].

No audited mail client sets AI output in a serif [V: identity audit section 4]. A serif reads as "a letter written to you" and separates the AI's words from your mail with zero chrome.

**Risk and fallback [I].** A serif summary can feel editorial. Run a one-day look test of Newsreader 20/28 against SF 20/500 on real mail in both themes. If the serif loses, "Aplos speaking" moves to colour (`--ink-2` on a `--raised` card) and no token changes shape.

### 4.2 Scale

| Token | Size / line | Face | Used for |
|---|---|---|---|
| `caption` | 11/14 | SF 500, +0.06 px | Keycaps, chips. The floor: calendar hours rise from 10 to 11. |
| `small` | 12/16 | SF 400/500, tabular | Timestamps, metadata |
| `ui` | 13/18 | SF 400/500, -0.06 | Sidebar, menus, controls |
| `base` | 14/20 | SF 400, -0.12 | List rows, settings |
| `read` | 15/24 | SF 400, -0.1, max 68ch | Plain-text bodies |
| `title` | 16/22 | SF 600, -0.24 | View titles, settings headings |
| `summary` | 20/28 | Newsreader about 450, -0.15 | The one big summary, **identical** on Home and in the reader (today 18 vs 20 px) |
| `display` | 28/34 | Newsreader 450, -0.4 | Welcome, sync complete, Home empty |

Only weights 400, 500 and 600 in sans (today 19 literal sizes and four weights [V: baseline 3.2]). Tabular numerals wherever numbers align. Dark mode runs the serif near 420 against 450 in light because light-on-dark looks heavier [I, test first]. The font is bundled, with `size-adjust` fallbacks so nothing shifts.

> **What this means:** the system font stays for everything you read and click. A letter-style serif appears only when Aplos is speaking. If it looks too fancy in testing, colour carries the signal instead with no redesign.

---

## 5. Spacing, density, surfaces, icons

### 5.1 Grid and layout

- One 4 px grid via `--space-1..8`, lint-enforced (today 5 uses against about 660 literals [V: baseline 3.3]).
- **Four radii:** 6 (chips, keycaps), 8 (controls, rows), 14 (paper, menus), 20 (dialogs, onboarding card). Pill 999 only for counts and chips (today about 30 literals).
- **Control heights** 24, 28, 32, 40; hit targets at least 24.
- **At 1440 px:** list column about 820 px; reader paper content 720 px (68 ch) plus gutters; margin rail 240; Ask dock 360 (320 below 1080); Settings content 640 with a 200 nav. Under 1100 px the rail folds into a "Notes" disclosure.
- **Density:** Roomy 48 px rows, **Comfortable 40 (default)**, Compact 34.
- **Key hints** hide until hover, focus or holding Command. Space on the primary action is always visible (decision 6).

### 5.2 Surfaces

| Level | Use | Treatment |
|---|---|---|
| 0 | Canvas | Flat plus horizon |
| 1 | Paper letter | 0.75 px ring; two-layer shadow, wide about 4 %, tight about 2.5 % |
| 2 | Menus, popovers, toasts, palette | Paper at about 72 % with 16 to 24 px blur, ring, wider shadow |
| 3 | Dialogs, onboarding card | Opaque paper, larger shadow, dimmed canvas |

Glass only for floating surfaces, never a large scrolling area; Reduce Transparency makes it opaque. Three button idioms only: **filled** (one per screen), **text**, **icon**. The glass pill is removed [I, from SYNTH-ui principle 6].

### 5.3 Iconography

- SF Symbols with a Lucide fallback, as today [V: `DECISIONS.md:127` per SYNTH]. Monoline, 1.5 px at 16 and 20 px, `--dim` by default.
- **Every AI suggestion wears the icon of its action** (reply arrow, calendar, link, paperclip, cart, phone). Never a sparkle, wand, star or "AI" badge. The icon's label has stars, so they are not echoed in the UI [V: owner memory `no-ai-sparkle-icon`].
- **Ask gets a speech-bubble glyph** and the word "Ask", no longer borrowing the search magnifier [V: baseline 6.6]. Panels close with an X on the right [V: owner memory]. No icon-in-a-grey-circle empty states.

> **What this means:** four corner sizes, one spacing grid and one rule per kind of surface keep the app consistent. Icons say what will happen, never that "AI" is involved.

---

## 6. How the AI shows up, with no sparkle

| # | Rule | Replaces |
|---|---|---|
| 1 | **The voice is the mark.** Summaries and Ask prose are Newsreader. | Glimmer and badges |
| 2 | **Working** is the placeholder line breathing (opacity .55 to .85 over 1.6 s), stopping as text arrives. | Gradient sweep, pulsing dot, red breathing ring |
| 3 | **The reason is a disclosure.** One plain sentence quoting the thread ("In Home because Jordan asks for your preference by tomorrow"), with one-key corrections ("Not important", "Keep in Home") that write deterministic sender rules. No model names or scores (developer toggle). | Nothing |
| 4 | **Provenance on hover only**, for example "Summary, Groq, model". | Nothing |
| 5 | **Drafts are ordinary editable text.** Tab accepts, Esc discards, neutral controls. Polish shows a diff beside your text and never overwrites it. | n/a |
| 6 | **Streaming** is plain text arrival with one thin non-blinking caret. No per-character blur or typewriter. | Zero-style blur (not adopted) |
| 7 | **No key means no error.** The reader leads with the subject; one quiet line in the margin links to Settings. | "Couldn't summarize" [V: baseline 6.9 #10] |
| 8 | **Banned in every form:** sparkles, wands, stars, purple gradients, shimmer, rainbow glows, "magic" or "AI-powered" labels, animated borders. | n/a |

**States.** Working: the subject in `--dim` where the summary goes, breathing (no spinner or skeleton for local data). Ready: the serif summary fades in over 140 ms. Failed or no provider: the subject is the main line. Ask thinking: one steady line naming the real step ("Reading 14 emails from Jordan"), folding into an expandable step log with citations. Ask answer: serif prose with the decisive fact at weight 500. Proposal: a paper card with a consequence line and two key rows ("Add to calendar, Return"; "Not now, Esc"). Local models (Ollama, LM Studio) look identical; provenance says "on this Mac".

> **What this means:** you recognise Aplos speaking by its typeface and its plain "because" line, not by a glowing icon. If the AI is off, the app quietly falls back to the subject and never shows an error in the most important spot.

---

## 7. Motion

### 7.1 Rules

1. **Navigation is instant** (at most a 100 ms opacity change). Today every view switch rises 4 px over 200 ms [V: baseline 4].
2. **Motion is spent on state changes only:** triage, send, arrival, selection.
3. **Nothing blocks input** (section 7.3).
4. **Everything is interruptible** and retargets from where it is drawn (the calendar already does [V: `calendarMotion.ts` per baseline]).
5. **Transform and opacity only.** Today's row exits, Ask dock and tab indicator animate `height`, `width` or `padding` [V: baseline 4].
6. **Rapid mode:** triage keys under 300 ms apart halve `carry`, `flight` and `glide` durations. From the fourth key within 600 ms, skip the ghost and use a 60 ms fade.
7. **Reduced motion:** opacity only, at most 120 ms, no travel, flight or celebration. Spinners stay.
8. **Retire `--ease-spring`** (about 7 % overshoot) except the switch thumb.

### 7.2 Tokens

Easings: `--ease-out` `(.16,1,.3,1)` most entrances; `--ease-std` `(.2,.8,.2,1)` hover and colour; `--ease-in` `(.5,0,.75,0)` exits; `--ease-carry` `(.4,0,1,1)` departures; `--ease-inout` `(.65,0,.35,1)` loops.

Springs are written as stiffness, damping, mass and compiled to CSS `linear()` at build time so CSS and the Web Animations API share them. ζ = d / (2 √(k m)); overshoot = exp(−πζ / √(1−ζ²)) (computed):

| Spring | k / d / m | ζ | Overshoot | Settles |
|---|---|---|---|---|
| `spring-slide` | 400 / 32 / 1 | 0.80 | about 1.5 % | about 250 ms |
| `spring-snap` | 300 / 30 / 1 | 0.87 | about 0.4 % | about 270 ms |
| `spring-lift` | 500 / 40 / 1 | 0.89 | about 0.2 % | about 200 ms |
| `spring-follow` | 600 / 36 / 0.6 | 0.95 | under 0.1 % | about 130 ms |

`spring-slide` matches Tatem's measured selection spring, as an idea only [V: `ui/tatem.md` 5a].

| Token | Timing | What moves | Where |
|---|---|---|---|
| `press` | 80 down, 140 up, ease-out | scale .97 (icons .94) | Buttons, rows |
| `hover` | 100, ease-std | colour only, `(hover: hover)` | Rows, controls |
| `reveal` | 140 in, 100 out | opacity, 4 px, scale .98 to 1 | Menus, popovers, tooltips (first 140, then instant along a toolbar) |
| `settle` | 180 in, 120 out | opacity, 8 px rise, scale .98 **from its origin** | Dialogs, palette, composer, confirm cards |
| `glide` | 140, **0 on key repeat or pointer** | one shared cursor layer | List cursor (Home focus letter 160). Hover moves it instantly |
| `slide` | `spring-slide` | one shared puck | Sidebar selection, D/W/M, Ask/Today, Settings nav, Later chips |
| `carry` | 120 (60 rapid), ease-carry | ghost: 28 px sideways plus opacity | Any row leaving a list |
| `hold` | until 450 ms after last key, or pointer leaves (max 1.2 s) | rows below pinned via transform | Burst triage; new mail while active |
| `close` | 180, ease-out | FLIP of rows below | After `hold` |
| `flight` | 220 (120 rapid), ease-in; edge tab within 60 | translate out, lift 8 px, tilt 2 degrees | Done or Later on the letter |
| `post` | 260, ease-in, short arc | composer leaves up and right | Send |
| `swap` | 120, overlapping | opacity plus 12 px offset | Reader J/K, Later groups |
| `arrive` | 200, ease-out | opacity, 6 px drop, FLIP neighbours | New mail, sent message, Ask cards; deferred mid-burst |
| `dock` | 200 open, 140 close | panel transform only | Ask dock, sidebar |
| `follow` / `snap` | springs | transform | Drag follows pointer; swipe returns |
| `breathe` | 1.6 s loop | opacity .55 to .85 | Pending AI lines only |
| `status` | 1.5 s | 30 % segment in a 2 to 3 px track | Sync bar. Spinners only after 150 ms |
| `sunrise` | at most 400, skippable | opacity, scale 1.02 to 1 | Home empty (once per emptying), first sync done |

That is 18 named motions replacing 56 keyframes and about 30 loose timings [V: baseline 4]. **Dock note** [V: `DECISIONS.md:298` per SYNTH]: transforms were dropped once because a strip of window background showed. Fix the strip (paint the dock's final area on frame one, slide only the contents, FLIP the mail column) rather than animate width; if seams persist in the packaged app, measure width animation there.

### 7.3 Input never waits: engineering rules

1. **Commit first, draw second.** A key handler updates state synchronously; the engine call is optimistic and its receipt arrives later. Budget: key to next paint under 16.7 ms p95 with 10,000 threads.
2. **Animate a ghost, not the model.** Exits and flights draw on a detached clone with the Web Animations API, compositor-only. React does not re-render per frame.
3. **Focus moves synchronously**, before any animation. Keys pressed during a mount or transition are never dropped: a window-level capture queues them for one frame.
4. **Interrupt means finish or retarget.** A new key finishes a running ghost; a new gesture during a spring starts from its current value and velocity. At most three ghosts animate at once.
6. **Local reads never show a spinner or skeleton.** Remote work shows one only after 150 ms.
7. **Double-buffer the reader.** On J/K the previous letter stays until the next is laid out (1.5 s deadline). The engine keeps both neighbours warm; the renderer prefetches after 120 ms of hover.
8. **The list holds still:** rows pin under `hold` and close once. New mail never moves the row under the cursor.
9. **No layout work in handlers**, and `will-change` only during animation. Lists are virtualised with fixed row heights.
10. **No renderer task over 50 ms.** HTML sanitising, search and ranking run in the engine or a worker; IPC is batched per frame.

| Automated test (headless Electron, Event Timing API) | Budget |
|---|---|
| Triage key to next row painted | 1 frame p95; 50 ms hard cap |
| Open a cached letter | under 100 ms to first body paint |
| J/K with prefetched neighbour | under 50 ms |
| Ten E presses in 2 s, 10,000 threads | no dropped key, one `close`, no frame over 33 ms |
| Palette open | under 80 ms |
| Cold start to interactive Home | set after the first measurement [I] |

Enforcement: an `aplos-motion` skill that every UI agent loads (the method from `ui/redakt.md` 6.2 [V]); lint against literal durations, easings, spacing and hex, `transition: all` and layout-property transitions; every `@keyframes` covered by reduced motion; a CI contrast check over section 3.

### 7.4 The signature: being carried off

1. **Done (E or right arrow):** focus moves in the same frame. A 6 px hill-green **edge tab** with a check and "Done" appears on the leaving edge within 60 ms; the card body is not flooded. The letter `flight`s right and slightly up with a 2 degree lift, like a letter caught by wind (the icon's own tilt). Rows below `hold`, then `close`.
2. **Later (L or left arrow):** same with a `--dusk` tab, flying left and slightly down, set aside for the evening.
3. **Swipe** follows the finger. A coloured underlay with icon and verb fills in behind; at the threshold it turns solid and the icon pops with `snap`. On release the letter continues at release velocity, then holds the gap until the pointer leaves.
4. **Five quick E presses** leave at half duration and the list never shifts. **Send** uses `post`, the only place the wind arc appears.

This replaces the reader's 3D swing (`perspective(1400px) rotateY(±14deg)`) [V: baseline 4]. Flooding the whole card is deliberately avoided: it is Avec's signature [V: `ui/avec.md` 4].

> **What this means:** moving around is instant, and finishing an email has one memorable gesture that never makes you wait or moves the list under your hand. The rules are written as tests so fast stays fast.

---

## 8. Screens

### 8.1 Shell, sidebar, toolbar

Hidden-inset title bar, sidebar with native vibrancy, canvas with the horizon, optional dock on the right. **Sidebar:** Home, Later, Calendar | All mail, Drafts, Sent | Trash, Spam. The **minimized sidebar** option stays (a menu button top-left with the same items). Navigation never returns to the toolbar [V: owner memory]. **Footer slot:** sync state, Settings, Help. States: importing N of M, paused until a time, retrying, reconnect needed; never a banner that pushes the list. **Toolbar (48 px):** left a pencil Compose icon and the view **title**; right search (`/`), Ask, Today. Selection uses the `slide` puck.

### 8.2 Home

```
Home                                                    Search   Ask   Today
  New  3                                         Go one by one  S
  Jordan   Two layout directions ready, wants your preference   by tomorrow  10:00
  Maple Library   Two holds waiting at the front desk ...       by Wed  Yesterday
  [ Low importance  2 : Parcel Trail, Field Notes ]      (raised background)
  Due now  4                                                       Collapse
  +--- paper ----------------------------------------------------+
  | Drew Bell                                          Yesterday  |
  | October illustrations finished, approve the invoice to close  |
  | out                                     (Newsreader 20/28)    |
  | [ View invoice  Space ]                   Later   Done   ...  |
  +----------------------------------------------------------------+
  Leah   Pick a quiet lunch spot for six ...
  Waiting on others  1
```

- **The focus letter is the only paper.** Sender and relative date on a small line, the **serif summary as the one big line** (no subject, no todo line), one action row. The suggested action is a filled 8 px rectangle with its icon, a verb and the Space keycap. Later and Done are text buttons; bookmark and more are icons; their keys show on hover. No pills.
- **Sections:** New, Due now, Waiting on others, literal, `small`, `--dim`. Tab and Shift-Tab jump between them.
- **Low importance** keeps its own `--raised` background [V: owner memory], opens grouped by sender, with per-sender unsubscribe once supported.
- **Row (40 px):** 6 px accent unread dot, sender (500; 600 if unread), summary in `base`, right side due chip then relative date. No avatars.
- **New mail** during triage waits under `hold`, then `arrive`s, with "2 new" beside the label.
- **Done semantics:** Done on mail that needs a reply currently stays on Home [V: baseline 6.9 #4]. Recommended: Done always leaves, with a toast "Remind me if no reply, R" (decision 5).

### 8.3 Later, All mail and other mailboxes

**Later:** one name everywhere; groups **Overdue, Today, This week, Someday**; Bookmarks is a filter chip on the `slide` puck. Dragging onto a labelled group reschedules to that group's date. Date presets on keys 1 to 5. **All mail, Drafts, Sent, Trash, Spam:** the same list component and row, no focus letter, one cursor layer. The title stays in the toolbar even when empty. **Bulk select** (X, Shift-X, Command-A) replaces the title with a count and Done, Later, Trash, More; Esc clears.

### 8.4 Reader

```
 <  Home  3 of 8                                          Ask    Today
 +--- paper (content 720) --------------------------+   Margin rail (240)
 | Jordan Park                         Friday   ... |   Found here
 | Two layout directions ready, wants your          |    Due tomorrow  [Set]
 | preference by tomorrow     (Newsreader 20/28)    |    One attachment
 | A quieter home for our project   (subject, quiet)|   Why it is in Home
 | Hi Alex, ...                                     |    "Can you send me your
 |------------------------- flap -------------------|    preference by tomorrow?"
 | [ Reply  Space ]  Later  Done                ... |   Jordan: 14 letters
 +---------------------------------------------------+
```

- **Letterhead order:** sender (left) and relative date (right) form the first line; addresses only in a popover. Directly below, the **serif summary**, the same text as the Home row. Then the quiet subject (500, `--ink-2`), then the body at `read`. Today a 17/600 subject competes with a 20/500 summary [V: baseline 6.4]. This merges the owner's two notes (summary at the very top; sender and date at the top) into one band (decision 4).
- **The flap** is a 48 px action row attached to the paper's bottom edge, sticky while scrolling. Left: the suggested action with Space; if it is not a reply, a text "Reply, R" follows. Right: Later and Done. Bookmark, trash and more are icons top-right. Undo lives in toasts. This removes the three "Reply" controls and the 54 px pill [V: baseline 6.2].
- **Margin rail** (on canvas, `--dim`): (1) due date and todo controls kept visually separate [V: owner memory], plans found in mail with an add action (dashed outline kept), attachments; (2) **Why it is in Home** with its quote and two correction keys; (3) **the sender**: two-way thread count, first and last exchange, a 12-week dot row, labelled history not trust. It folds into "Notes" when the dock is open or the window is narrow.
- **Navigation:** J/K `swap` with the double buffer; Esc goes back.
- **HTML mail** renders in a sandboxed, script-less iframe on a light surface; in dark it keeps the mail's own background while plain text follows the theme. Remote images are off by default [I; see the HTML isolation report in `research/email-clients/gaps/`].

### 8.5 Compose and inline reply

- **New message:** a 680 px paper sheet that `settle`s from the Compose button, non-modal, with the **post edge** across its top. Footer: filled Send, attach, format, draft state.
- **Inline reply** opens inside the reader's paper above the flap so the thread stays visible [V: baseline 6.2], with the same edge. "Pop out" moves it to a sheet or window.
- **Draft state:** one line, "Saving, Saved, Couldn't save, Retry". After "Saved", Esc just closes [fixes V: baseline 6.9 #3].
- **Sending:** `post`, then the message `arrive`s in its thread with a tray: "Sending to Jordan in 8 s, Undo, Send now", the post edge draining as the bar. A new message with no visible thread gets a bottom-centre toast. **One notice per send**, not two [fixes V: baseline 6.9 #2]; the undo option shows the stored 8 s [fixes #1].
- **Dictation** shows a calm level meter in `--stamp`. A **blocked send** outlines the field and explains in one sentence; the shake is removed.

### 8.6 Ask dock

Docked on the right at 360 px, an X on the right, **closed by default on first run** (today it opens with three suggestions over about 700 px of blank panel [V: baseline 6.2]). Header: speech-bubble glyph, "Ask" and "Today" on a `slide` puck. Empty state: three plain suggestion rows and recent chats with times. **Layout:** your question is one `--ink-2` line with a 2 px left rule; Aplos's answer is serif prose directly on the dock, no bubbles; citation chips show the quoted sentence on hover. While answering: one steady line naming the real step, folding into a step log; follow-ups queue as small editable cards. **Proposals** are paper cards with two key rows. With no provider: one line and a link, no red error [V: baseline `ask-no-key-error`]. The **Today** tab (renamed from Calendar) is a compact agenda with free gaps and a now line, replacing the 6 AM to 11 PM grid holding one event.

### 8.7 Search and command palette

One overlay: **`/` searches, Command-K opens commands**, and typing `>` or `/` switches. Top-centre, 560 px, glass, `settle`. The palette shows a context line naming the email in focus, every command with its keycap (from the same registry as the shortcuts sheet), nested settings with breadcrumbs, and two-row confirmations ("Confirm, Return"; "Cancel, Esc"). Search turns plain words into removable tokens (`from:`, `after:`, `has:attachment`); local results appear as you type, and remote Gmail search runs only on Return to protect quota [V: `research/email-clients/protocols/proto-google.md`]. After Return, ordinary one-line rows. No-match: "No mail matches 'dentist'." with "Search all mail on Google, Return".

### 8.8 Calendar and Today

Fix first [V: baseline 6.9 #6, #7, #8]: overlapping events get a 44 px minimum column, an ellipsis and a stacked "+2"; day titles get the missing comma; Delete is hidden on unsaved events; hour labels are 11 px or more. Events use the section 3.4 colours; mail-found plans keep the dashed outline; today's column takes `--horizon`; the now line is `--stamp`. Day, Week and Month ride the `slide` puck; FLIP and pinch zoom stay.

### 8.9 Settings

Title "Settings" in the toolbar; nav aligned to the first group (it starts about 74 px too low today [V: baseline 6.2]). Sections: General, Mail, Calendar, AI, Notifications, Accounts, Keyboard, Help and about; all searchable from the palette. Each row: label, control, one line saying what the setting does. **AI:** a table of Ask, Summaries, Drafts, Plans, Voice, each with provider, model and a status dot. Keys are never shown, only "Key found in environment" or "No key". Groq is the default; local and custom servers show an address and a Test action. **Keyboard (new):** the registry with remap and the single-key switch. **Accounts** use one name everywhere [V: baseline 6.6].

### 8.10 Onboarding window and first sync

PR #21 is not merged and not touched here. These are design rules for its revamp, carrying over its bugs [V: `research/pr21-onboarding-review.md`].


- **Window:** 640 by 600, fixed, hidden-inset title bar, a paper card on full-bleed sky with the icon's envelope in flight. Steps: Welcome, Account (Google, Microsoft once it has a client ID, other mail), AI (skippable, never an error afterwards), Voice, shown as four short dashes.
- **Closing is always safe.** The footer says "Setup continues in the background." The engine must end setup cleanly, never leave AI paused, and still classify the first mail [V: PR21 findings 1 and 2]. 
- **First-sync loading** replaces the dead "Making room for your mail" screen with segmented progress tied to engine checkpoints: finding recent mail, reading it, summarising what matters. It shows real counts ("214 recent emails found"). **Open Aplos** is enabled once the first batch is in.
- **Rate limits told honestly.** The first real sync failed with a Google 403 from quota [V: CONTEXT], so the screen says: "Google is asking us to go slowly. Your newest mail is ready now; older mail will follow." Never a raw error.
- **Complete:** the segments collapse into a drawn check and the sky brightens once (`sunrise`); static under reduced motion. The same component serves "Account connected" and the sidebar's "importing N of M".

### 8.11 Toasts and notifications

**In-app:** bottom-centre stack of up to three; hover pauses timers; plain toasts 4 s, Undo toasts 8 to 10 s then a slow fade. Wording follows what the engine did: pending ("Archiving"), confirmed ("Done, Undo Z"), offline ("Saved here, will sync"). Glass level 2, the key on the action, one meaning each, announced politely. **macOS banners:** sender as title, summary as body, actions Reply, Later, Done; only for mail that reaches Home.

### 8.12 Empty and error states

Each is a plain sentence plus at most one action. No icon in a circle.

| State | Copy (draft) | Action |
|---|---|---|
| Home empty | The `sunrise` sky: "You handled 12 emails." plus the next event | none |
| Later empty | "Nothing set aside for later." | none |
| Search no match | "No mail matches 'dentist'." | Search all mail on Google |
| Drafts, Sent, Trash, Spam empty | "No drafts." (title stays) | none |
| Ask, no provider | "Ask needs a provider. Choose one in Settings." | Open Settings |
| Sign-in expired | "Google needs you to sign in again." | Reconnect |
| Rate-limited | "Google is limiting reads. Retrying at 2:14 PM." | Retry now |
| Send failed | "Couldn't send to Jordan. Your draft is saved." | Try again |
| Attachment failed | chip in `--stamp-ink`: "Couldn't download." | Try again |
| Engine unreachable | "Aplos can't reach its mail engine. Your mail is safe." | Try again, Copy details |
| Summary failed | Not an error: the subject takes its place | none |

Error copy says what happened, what is safe and what to do, with no exclamation marks.

### 8.13 The four sky moments

The sky is **drawn in code**: a `#67ccff` to `#2a9afd` gradient in light, a night gradient in dark, a thin wind arc and the hill silhouette in `--hill`. Never stock imagery or confetti. Moments: (1) the onboarding window; (2) first sync complete; (3) Home empty, with two facts (emails handled, next event); (4) the always-on 320 px horizon. Moments 2 and 3 run at most 400 ms, any key skips them, they are static under reduced motion, and moment 3 fires once per emptying.

> **What this means:** every screen keeps its structure and keys but follows the same rules: a title, quiet rows, one letter of paper, honest status, and plain sentences when something is empty or broken. The biggest changes are the reader's flap and margin, a real command palette, honest sending and the sky moments.

---

## 9. Keyboard map

**One meaning per key. Tap to act, hold the same key to say it. Space is always the AI-suggested action.** One registry feeds this map, the `?` sheet, the palette, tooltips and toast keycaps.

| Context | Keys |
|---|---|
| Global | **A** type in Ask, hold to dictate. **Command-J** Ask. **Shift-A** Today. **/** search. **Command-K** palette. **C** compose. **Command-,** settings. **[** sidebar. **?** shortcuts. **Z** undo. **Control-1 to 8** Home, Later, All mail, Drafts, Sent, Calendar, Trash, Spam. |
| Go (new) | **G** then **H**, **L**, **A**, **D**, **S**, **C**, within one second, with a small hint |
| Lists | **J/K or arrows** move. **Return or O** open. **Space** suggested action. **S** go one by one. **X** select, **Shift-X** range, **Command-A** all. **E** Done. **L** Later. **B** bookmark. **U** read. **#** trash. **R, Shift-R, F** reply, reply all, forward. **.** more. **Tab** next section. |
| Home letter and reader | As lists, plus **Right arrow Done**, **Left arrow Later** (decision 5), **hold R** dictate a reply, **Command-F** find, **Esc** back |
| Compose | **Command-Return** send. **Hold Space in an empty body** dictates. **Tab** accepts a proposed draft. **Esc** closes. |
| Ask | **Up/Down** suggestions. **Return** ask. **Command-Return** search all mail. **Command-N** new chat. **Esc** stops, clears, closes. |
| Calendar, palette, dates | Calendar keys unchanged. Palette: **Return** runs, **1 to 9** pick, **Esc** goes up a level. Date presets on **1 to 5**. |

Changes against today [V: baseline 5]: Space stops meaning four things (reply moves to R). Arrow triage applies only on the single-letter screens, so a slip in a multi-row list cannot archive mail. Command-K becomes a real palette. The sheet is generated from the registry, so it can no longer omit five keys.

> **What this means:** your keys mostly stay. Space does the AI action everywhere, R replies, holding a key speaks instead of types, and Command-K becomes a true command menu. The help sheet cannot go stale.

---

## 10. Accessibility

1. **Contrast:** all text at least 4.5:1 and non-text 3:1 in both themes, tested for every token pair. Colour is never the only signal.
2. **Focus:** a 2 px `--accent` ring with a 2 px paper gap (7.76:1 light, 8.23:1 dark). Never removed.
3. **VoiceOver:** lists are a listbox with `aria-activedescendant`; toasts are polite live regions; after a triage key the live region says what happened and what is next; the palette is a combobox; the reader exposes summary, body and margin as landmarks.
4. **Single-key shortcuts** can be switched off in Settings, leaving modifier shortcuts (WCAG 2.1.4); all are remappable.
5. **Reduced motion:** opacity only, at most 120 ms. **Reduce Transparency:** glass becomes opaque. **Increase Contrast:** stronger rings, `--faint` becomes `--dim`, flat horizon.
6. **Zoom** works across the window via `rem`; nothing below 11 px; targets at least 24 px. Dictation always has a typed equivalent.
7. **Checks:** an axe scan of every screen in both themes and a keyboard-only walkthrough at acceptance.

> **What this means:** the app passes the standard accessibility thresholds, every key can be remapped or switched off, and VoiceOver, reduced motion and high-contrast settings are honoured and tested.

---

## 11. The owner's taste list

| Taste [V: memory `aplos-ui-taste`, `no-ai-sparkle-icon`] | How Skypaper handles it |
|---|---|
| Docked Ask panel | Kept, 360 px on the right, X on the right, closed on first run (decision 7) |
| AI action on Space, never Later or Done | The one filled button on the letter and flap; reply moves to R |
| Big summaries; one big line on the Home card | `summary` token, serif 20/28, identical on Home and reader; sender line, one serif line, one action row |
| Sender-first reader | Sender and relative date are the first line of the paper; summary right below; addresses in a popover (decision 4) |
| No sparkle, wand or star | Banned in every form (section 6) |
| Tatem and Avec feel, but its own; keyboard-first and calm; cares about type and spacing | Instant navigation, one spring puck, one registry, `hold` so the list never jumps, one tracked type scale on a 4 px grid; own palette, serif, shapes, flap, margin and sky |
| Left sidebar, minimized option; no top-bar navigation, split view or needs-reply mailboxes | Sidebar kept; toolbar has a title only; reply work stays on Home |
| Subtle fade; low-importance has its own background | Colour-ramp fade at 5.36:1 or better; `--raised` bundle |
| Icon: sky, airmail envelope, green hill | Palette, sky moments, hill-green Done and the post edge |

> **What this means:** every note you gave us is kept. What changes is the look, shape and words around your behaviours, not the behaviours.

---

## 12. The post edge: exact rules

A 3 px straight horizontal edge of diagonal (-45 degree) segments: red 9 px, gap 7, blue 13, gap 7 (period 36). The uneven rhythm is meant to be more ownable than a classic even border; prototype it first [I, audit section 7]. **In the app, exactly two places:** the undo-send drain, and the top edge of the composer and inline reply. Also allowed: the website frame and the app icon. **Never:** a ring, circular progress, avatar or badge rim, an icon border, or decoration on lists, empty states or onboarding. A ring is Bloop's old geometry [V: audit section 3]. No par-avion labels, stars, planes or postmarks in UI.

> **What this means:** the stripe stays a rare signature in two places, always as a straight edge, so it never looks like another app's ring logo.

---

## 13. What not to copy from each reference

- **Tatem** (closed). Hold-Space peek (Space is the AI action); low-contrast text on gradients; translucent-everything on a native Mac. *Take:* instant lists, one selection puck, one key grammar across key, palette, menu and button.
- **Avec** (closed). Its look (warm canvas, white card, system blue, bottom pill cluster, solid flood, 12 degree toss); its words ("Hold to talk", "Swipe through them", "Hide all", "Todo", "Be here now"); sparkles; the default "Sent with" footer; the ocean video and sorting game. *Take:* speed that rises when you go fast, next-step toasts, drag-to-reschedule.
- **Zero** (MIT, ideas only). Sparkles, purple borders, endless shimmer, character blur; a summary behind a pill; saturated red and green Accept and Reject; overloaded letters; remote images and a signature on by default. *Take:* folding step logs, operator tokens, neighbour prefetch.
- **Redakt** (MIT, ideas only). The looping rainbow border beam; Generate replacing typed text; a fixed 1 s hold before the gap closes; width animation on the composer; a glossy orange Compose button. *Take:* the lighting-model idea, the undo tray under the sent message, UI rules agents must read.
- **Superlocal** (no licence, engineering ideas only). Anything visual: it ships scraped commercial fonts and icons, so no charcoal-and-lavender look, ink bar or "Get me to zero". No removed focus rings, no model internals in user text, no toast slot that silently replaces an Undo. *Take:* pinned rows during bursts, honest "Marking" states, the shortcut resolver as a tested pure function.
- **Inbox Zero Mail** (AGPL plus terms, ideas only). The Gmail-clone row (sender column plus chips); a list/split toggle; sparkle and wand glyphs; linear easing on panels; a compose window with no origin. *Take:* focus moves in the same frame as the action, the double-buffered reader, one registry for tooltips, help and toasts.
- **Aplos v0.2.3 itself.** Glimmer, rainbow avatars, icon-in-circle empty states, glass pills, assistant-voice microcopy, the 3D fling, layout animations, pure black dark mode, the 0.46 fade floor, key caps on every control, Space with four meanings.

> **What this means:** we borrow engineering and restraint from each app, never its look or words. The whole sparkle, glow and shimmer family is excluded.

---

## 14. Voice and microcopy

### 14.1 Replacements

| Today | Replace with | Why |
|---|---|---|
| "Hold to talk" (twice) | tooltip only: "Hold A to dictate" / "Hold R to dictate a reply" | Avec wording |
| "Swipe through them" | "Go one by one" | Avec wording |
| "Hide all" | "Collapse" | Avec wording |
| "Todo", "Todos", "Moved to Todo" | "Later", "Moved to Later" | One name [V: baseline 6.6] |
| "Ready when you are" / "No reply yet" | "Due now" / "Waiting on others" | Literal |
| "Ask me anything" | "Ask about your mail or calendar" | Says what it does |
| "A comfortable place for your mail." | "Light, dark, or match the system." | A setting states its effect |
| "Making room for your mail..." | "Opening your mail." | No assistant voice |
| "Aplos needs a moment." | "Aplos can't reach its mail engine. Your mail is safe." | Plain error |
| "Couldn't summarize this email" | Show the subject, no message | Not an error |
| "Calendar" (dock tab) | "Today" | One meaning per word |

### 14.2 Rules

Say what a thing does, not how it feels. One privacy explanation, in Settings, AI. No exclamation marks. Buttons carry verbs ("Send", "Reconnect"), not "OK". Summaries are third person with the action and date folded in ("Two layout directions ready, preference by tomorrow").

> **What this means:** every phrase that echoed Avec is replaced, and the app speaks plainly instead of in an assistant's voice.

---

## 15. Delivery order and acceptance

| Stage | Contents | Acceptance |
|---|---|---|
| 1. Trust fixes (days) | The ten baseline defects, Avec-derived words, contrast, fade ramp | Every string in 14.1 replaced; contrast test passes; each defect has a regression test |
| 2. Foundations (about 1 week) | Token files, `linear()` springs, lint, CI contrast check, `aplos-motion` skill, command registry | Lint rejects raw hex, literal durations and spacing; shortcuts sheet is generated |
| 3. Identity (1 to 2 weeks) | Palette, serif A/B, flap and margin rail, no avatars or glass pills, night canvas, post edge | Section 1.3 passes in both themes; serif decision recorded |
| 4. Motion signature (about 1 week) | `carry`, `hold`, `close`, `flight`, edge tabs, rapid mode, cursor layer, puck | Section 7.3 budgets pass on 10,000 threads in the packaged app |
| 5. Screens (2 to 3 weeks) | Palette, Later, Ask, Settings, onboarding, first sync, empty and error states, sky moments | Each row of section 8.12 has a test; closing onboarding mid-sync leaves AI intact |

Dependencies on the architecture work: sandboxed HTML, engine prefetch, op-queue states for honest toasts, sync-state events, first-sync checkpoints and the one-shot AI-deferral fix from the PR #21 review. Build against those contracts with mock states until they land.

> **What this means:** trust fixes ship first, then the foundations that stop drift, then the identity, then motion, then the remaining screens, each with a check you can verify.

---

## 16. Decisions for you

**1. Is "Skypaper" fine as an internal codename, and may "airmail" appear anywhere public?**
- Options: (a) Skypaper internal, no public "airmail"; (b) another codename; (c) use "airmail" publicly after a lawyer's clearance.
- Recommended: (a). It keeps the Bloop and Fichorga name conflict away from users [V: identity audit section 3].

**2. Move the blue to ink blue (`#0b5394`) on the app and website together?**
- Options: (a) ink blue; (b) keep `#0755dc`.
- Recommended: (a). The distance from Avec goes from 4.8 to 13.8 and white text gets 7.84:1. Under (b) the blue stays vivid but close to Avec, and distinctiveness rests entirely on the serif and paper.

**3. Use a serif (Newsreader) for summaries and Ask answers?**
- Options: (a) yes after a one-day look test against the system font; (b) yes, no test; (c) no, carry the voice with colour.
- Recommended: (a). (b) is faster but riskier; (c) is plainer and less memorable.

**4. In the reader, sender line above the big summary, or summary strictly first?**
- Options: (a) sender and date as the first small line, summary right below; (b) summary first.
- Recommended: (a). Your notes ask for both "summary at the very top" and "sender and date at the top"; (a) satisfies both. (b) is closer to today.

**5. Arrow keys and Done.**
- Arrows: (a) triage only on the Home letter and reader; (b) every screen as today; (c) behind a setting. Recommended: (a). A slip in a list then cannot archive mail.
- Done on mail that needs a reply: (a) leaves Home with a "remind me" toast; (b) stays under Waiting on others. Recommended: (a). Under (b) Done sometimes fails to remove the row, which reads as broken [V: baseline 6.9 #4].

**6. Hide key hints until hover, except Space on the main action?**
- Options: (a) hidden, with a "Show all key hints" setting; (b) always visible as today.
- Recommended: (a). Screens are calmer. You previously chose keys on controls on purpose, so the setting preserves that.

**7. Close the Ask dock on first run, and add the reader's margin rail?**
- Options: (a) both; (b) dock closed, no rail; (c) neither.
- Recommended: (a). The first screen is calm and the reader gets a quiet column. Under (b) those items sit under the summary; under (c) today's layout stays.

**8. Make Command-K a real command palette, with `/` for search?**
- Options: (a) yes; (b) keep Command-K as search only.
- Recommended: (a). Every command becomes reachable without memorising letters. It is an overlay, not toolbar navigation, so it does not repeat the top-bar mistake.

**9. Cool sky neutrals instead of the current warm greys?**
- Options: (a) cool; (b) keep warm neutrals but still change the accent, dark canvas and reader flap.
- Recommended: (a). Earlier decisions chose a calm warm palette, but Avec's warm grey is part of the overlap. Under (b) the two apps still share a warm look.

> **What this means:** if you only answer one question, answer 2 (the blue) and 3 (the serif), because they set how different Aplos looks from Avec at a glance.

---

## Evidence index

- **Studies:** `research/email-clients/SYNTH-ui.md`; `research/email-clients/ui/{aplos-baseline,tatem,avec,zero,redakt,superlocal,inbox-zero-mail}.md`; `research/email-clients/gaps/identity-collision-audit.md`; `research/pr21-onboarding-review.md`; `research/email-clients/protocols/proto-google.md`.
- **Screenshots viewed** (`/Users/knewton/.t3/aplos-research/ui/`): `aplos-baseline/{home-light,home-dark,reader-light,calendar-week-light,welcome-start-light}.png`, `tatem/{hero-mock-flat-gradient,sheet-releases-0}.png`, `avec/landing-desktop-light.png`, `redakt/inbox-desktop-dark.png`, `zero/home-desktop-light-fold.png`, `identity-audit/icon-compare.png`.
- **Owner memory:** `aplos-ui-taste.md`, `no-ai-sparkle-icon.md` (project memory folder).
- **Computed here:** `/tmp/skypaper/{c,d,e,f}.py` (contrast, tints, ΔE00; the audit's `de2000.py` reused).
