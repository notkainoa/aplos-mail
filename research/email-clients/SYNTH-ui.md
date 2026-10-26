# Aplos UI synthesis: feel, identity and motion for the revamp

2026-10-25. This synthesizes six UI studies (Tatem, Avec, Zero, Redakt, Superlocal, Inbox Zero Mail) against the Aplos v0.2.3 baseline audit. I read all seven reports in full (`research/email-clients/ui/*.md`) and the earlier `research/inbox-zero/SYNTHESIS.md`. I also looked at about 40 of the captured screenshots and frame sheets under `/Users/knewton/.t3/aplos-research/ui/`, the app icon and its source layers (`apps/desktop/assets/`), the website tokens (`apps/web/src/styles.css`), the renderer tokens (`apps/desktop/src/renderer/ui/tokens.css`) and `DECISIONS.md`. Icon colors were sampled with a throwaway script, and every contrast ratio below was computed, not estimated.

**Evidence key.** **[V]** means verified in a file, a screenshot or a computation, with the path given. **[I]** means my inference or a design judgement. Each reference's values come from its own report. I re-checked visual claims against the screenshots wherever a screenshot existed.

**Licenses (ideas only, nothing copied).**

| Reference | License | What that allows |
|---|---|---|
| Tatem | Proprietary, closed | Observations only |
| Avec | Proprietary, closed | Observations only |
| Zero | MIT | Ideas only (Aplos rule) |
| Redakt | MIT; its vendored agent skill pack's license is unverified | Ideas only |
| Superlocal | No license (all rights reserved), and it ships scraped commercial fonts and icons | Engineering ideas only, no visuals |
| Inbox Zero Mail | AGPL-3.0 plus extra terms | Ideas only |

---

## 0. In plain English

- **What makes the best ones feel great is mostly not animation.** Your next keypress never waits. The list doesn't move under your hand. Mail is already loaded before you open it. And there are only a few motions, each of which tells you where something went.
- **Aplos already has good craft, but it doesn't look like Aplos yet.** Today the reader and Home are close to a copy of Avec's desktop app: the same grey canvas, white card, blue pill, bottom button cluster, and even the same button words ("Swipe through them", "Hold to talk"). Fixing this comes first. It is a spec rule (independent identity, no copied wording), not a matter of taste.
- **The proposed look, "Airmail", is paper on sky.** Your mail is paper. The app around it is a clear daylight sky in light mode and a night sky in dark mode. Airmail blue is the one action color, hill green means Done, dusk blue means Later, and the red-and-blue airmail stripe appears in exactly two places. Aplos's own voice (summaries, Ask answers) is set in a letter-like serif, Newsreader, which the website already uses. That serif is how you can tell the AI is speaking, so no sparkle icon is ever needed.
- **The proposed motion is calm and fast.** Navigation is instant. Triage gets one signature move: the email is carried off in the direction you sent it, and it gets quicker when you go quicker. A small set of named motion tokens replaces the 30 or so one-off timings.
- **Several screens need changes.** These are listed screen by screen in section 4, along with a list of what not to borrow from each app.

---

## 1. Design principles behind the references that feel great

Each principle names where it's done best, what Aplos does today, and what to change.

**1. Input never waits for animation.**
- Inbox Zero moves focus to the next row *in the same frame* as an archive, while a detached "ghost" of the row slides 32 px and fades over 80 ms (`ui/inbox-zero-mail.md` §4 #1) [V].
- Avec halves its toss from 300 to 150 ms when presses come less than 300 ms apart (`ui/avec.md` §4 #2) [V].
- Tatem animates nothing in the list at all (`ui/tatem.md` §4) [V].
- *Aplos:* partly there. Exits are faster than entrances and key repeat shortens the glide to 170 ms. But triage exits collapse `height`, and nothing speeds up for fast hands (`ui/aplos-baseline.md` §4).

**2. The list holds still under your hand.**
- Superlocal pins the rows below a removed row in place during a burst of E-E-E presses, then compacts once, 550 ms after the last press (`ui/superlocal.md` §4 #5) [V].
- Redakt holds the gap after a *pointer* archive so the row under the cursor doesn't change identity mid-click (`ui/redakt.md` §4 #7) [V]. Its fixed 1 s hold is too long for keyboard use.
- *Aplos:* missing. In `motion-done-midflight-light.png`, one Done produces two contradictory motions: the next card glides up while the finished email fades into "Waiting on you" [V].

**3. Speed is engineered before it is animated.**
- Zero prefetches a thread after 120 ms of hover and keeps both neighbours of the open thread warm (`ui/zero.md` §6) [V].
- Inbox Zero double-buffers the reader: the previous email stays on screen until the next one's iframe has been measured, with a 2 s deadline. It also never shows a spinner for local reads (`ui/inbox-zero-mail.md` §4 #8, #10) [V].
- Tatem's under-50 ms feel comes from local SQLite plus a mutation queue (`ui/tatem.md` §5) [V].
- Avec's founder credits server enrichment and cross-device sync for its smoothness (`ui/avec.md` §6) [V, the founder's claim].
- *Aplos:* this depends on the architecture work (bodies on demand, an engine-side LRU, pushed diffs). The UI should plan for buffering from the start.

**4. Commits are unmistakable.**
- At the swipe threshold Avec floods the whole card with one solid colour plus the action's verb, opaque by about 90 ms (`avec/desktop-preview/dense-done-arrow.png`) [V].
- *Aplos:* uses a faint 14–22 % wash, so you can't read the commit at a glance (`ui/avec.md` §7 table).

**5. Hierarchy comes from restraint.**
- Tatem uses a single Inter weight and builds hierarchy from a five-step text-opacity ramp (`ui/tatem.md` §3) [V].
- Redakt uses hueless neutrals and exactly one accent (`ui/redakt.md` §3) [V].
- *Aplos:* uses 19 literal font sizes, key caps on every control, rainbow avatars and glass pills everywhere, so everything competes (`ui/aplos-baseline.md` §6).

**6. Depth comes from light, not borders.**
- Redakt's token "lighting model" gives it 0.75 px rings, an inset top sheen for dark mode, and a dark *pane* that is lighter than the *shell* (`redakt/inbox-desktop-dark.png`) [V].
- Tatem uses soft two-layer shadows: one wide, one tight (`ui/tatem.md` §3) [V].
- *Aplos:* the dark canvas is pure #000, which hides its own glass shadows, and the light sidebar differs from the canvas by only 1.03:1 (`ui/aplos-baseline.md` §6.5).

**7. One key grammar on every surface.**
- Tatem puts every action behind "four doors" (key, ⌘K, right-click, ⋯) with identical labels and keycaps, number keys in submenus, and Enter/Esc confirmation rows (`tatem/sheet-releases-0.png`, Block sender) [V].
- Inbox Zero drives tooltips, the help sheet and toasts from one registry [V].
- Superlocal's shortcut resolver is a pure, table-tested function [V].
- *Aplos:* Space has four meanings, arrow keys triage mail, ⌘K is just a second binding for search, and the help sheet is missing five bindings (`ui/aplos-baseline.md` §5).

**8. State is honest.**
- Superlocal shows "Marking…" until the durable receipt arrives, then "Marked · Undo". A sent reply sits in the thread labelled "Queued" during the undo hold (`superlocal/frames/optimistic-sheet.png`) [V].
- Redakt tucks an undo-send tray under the sent card itself (`redakt/undo-tray-light.png`) [V].
- *Aplos:* one send produces two toasts that say different things (`aplos-baseline/toast-pending-send-light.png`) [V], and Compose says "Saved" and then asks "Save this draft?" [V].

**9. AI is content, and its reasons appear only when you ask.**
- Inbox Zero's best AI surface is drafts that look like ordinary drafts [V].
- Tatem proves a product can feel premium with no AI chrome at all [V].
- Superlocal's "Why?" quotes the email itself [V].
- The failures are just as clear:
  - Zero's shimmer, purple borders, sparkles and character-by-character blur (`zero/frames/crop-ai-draft-preview.png`) [V];
  - Redakt's looping rainbow "border beam" [V];
  - Redakt's Smart Compose overwriting typed text [V].
- *Aplos:* already right to put the summary first, but it still uses a "glimmer" gradient sweep while AI works.

**10. Polish is written down and enforced.**
- Redakt's agents must load a UI rules skill before touching UI (`AGENTS.md` there; `ui/redakt.md` §6.2) [V]. That is how one developer working with agents keeps 150 ms ease-out and a 0.96 press scale consistent.
- *Aplos:* has tokens but no enforcement: about 30 literal durations against 5 tokens, and 5 uses of the spacing tokens against about 660 literal values (`ui/aplos-baseline.md` §3–4) [V].

**11. Closure is rare and earned.**
- Avec turns an empty inbox into an ocean scene that grows from the centre in about 350 ms (`avec/desktop-preview/dense-beach.png`) [V].
- Inbox Zero shows a static sunrise [V].
- *Aplos:* the emotional peak of the app is a 44 px grey circle with a tick (`aplos-baseline/empty-home-light.png`) [V].

> **What this means:** the references feel great because of engineering discipline (no waiting, no jumping, no spinners), plus a very small, consistent vocabulary of looks and motions. Aplos has the raw craft. It needs the discipline written into tokens and agent rules, and an identity of its own.

---

## 2. Proposed design direction: "Airmail"

### 2.1 The identity problem to solve first

Comparing Avec's Mac alpha (`avec/desktop-preview/seg/t0176.3.png`, `t0174.2.png`) with Aplos (`aplos-baseline/reader-light.png`, `home-light.png`), I verified these overlaps [V]:
- the same warm-grey canvas with one white card;
- the same bottom cluster: bookmark, "← Todo", a large blue "Reply · Space · Hold to talk" pill, "Done →" and undo;
- the same top-right "Ask · A · Hold to talk" pill;
- the same Home pill, "Swipe through them" (Aplos `App.tsx:498` with key S; Avec with key N).

`DECISIONS.md:128` says reference phrases that matched word for word were rewritten. These were missed (`Reader.tsx:89`, `Topbar.tsx:22`) [V]. The owner chose the interaction model on purpose (one card, keys on controls, hold to talk), and that can stay. The *look and words* must change.

### 2.2 The concept

The app icon tells a story: a white airmail letter carried on the wind over a green hill under a clear sky. The direction maps that story onto the interface:

- **Paper:** every piece of mail and everything you write.
- **Sky:** the space around the paper, which is the app's chrome and canvas.
- **The hill:** the ground you return to, meaning Done.
- **The airmail stripe:** the only decoration, used when something is being sent.

The website already took this step on 2026-10-24: sky `#9fd3ff`, dusk `#11263d`, an airmail-blue primary, the stripe as a frame, and Newsreader headings (`DECISIONS.md:15–18`, `apps/web/src/styles.css`) [V]. The app should now catch up so the site and the product are one brand [I].

### 2.3 Colour

I sampled the icon's background layer, `AppIcon.icon/Assets/Firefly (1).png` [V]:
- sky from `#2a9afd` (top) to `#67ccff` (horizon);
- sunlit hill crest `#d6d04f`, hill body `#38521a`, shade `#182f18`;
- chevron red `#d83237`, chevron blue `#1c43a0`–`#285adc`;
- envelope paper `#f3f4f7`, cloud `#faf5ef`.

These are too saturated to use directly in a UI. The tokens below are calmer derivatives. Every ratio is computed with the WCAG formula [V: `/tmp/aplos-synth-tools/contrast.py`].

| Token | Light | Dark ("night") | Role and check |
|---|---|---|---|
| `--canvas` (sky) | `#e9edf0`, a cool cloud-grey | `#0b1219`, a night blue-black (replaces `#000`) | App ground. Cool rather than warm, which is the main move away from Avec's warm grey |
| `--paper` | `#fefefc` | `#141c25` | Mail cards and the composer. In dark, the pane is lighter than the canvas (the Redakt lesson) |
| `--raised` | `#f4f6f7` | `#1b2530` | Summary card, low-importance bundle, inputs |
| `--ink` | `#121820` | `#e7ecf1` | 15.2:1 / 15.9:1 on canvas |
| `--ink-2` | `#2f3a46` | `#c4ccd5` | 9.8:1 / 11.6:1 |
| `--dim` | `#56616d` | `#97a3af` | **5.4:1** on canvas in light, up from today's 4.07:1. Timestamps and secondary text |
| `--faint` | `#7d8792` | `#75818e` | 3.1:1 in light, so placeholders, disabled items and icons only, never body text |
| `--accent` (airmail blue) | `#0755dc`, the website's accent | `#4fa3ff` with `#04111f` text | White on the light fill is **6.3:1** (today's `#0682fe` is 3.73:1). Dark text on the dark fill is 7.3:1 |
| `--sky` | `#9fd3ff` | `#11263d` | Tints only: selection, focus-card halo, the closure scene |
| `--hill` (Done) | `#2f6f2a` | `#6cbf5a` | White on the fill is 6.1:1. A moss green rather than a signal green |
| `--dusk` (Later) | `#3e5878` | `#8fa9cc` | 7.3:1. Later becomes "evening" instead of Avec's neutral grey |
| `--stamp` (Trash, errors, recording) | `#c4302b` | `#ff7a6e` | One red token (today there are two) |
| `--stripe-red` / `--stripe-blue` | `#d83237` / `#1f4fc8` | same, at 85 % | Decoration only, in two places (2.6) |

Rules:
- One accent per screen. Hover is ink at 5 % and press is ink at 9 %.
- No raw hex in components, enforced by lint.
- **Home distance fade:** fade by stepping down the colour ramp (focus card in ink, the next two rows in ink-2, the rest in dim) instead of multiplying opacity. Every step then stays at 5.4:1 or better, against the 1.76:1 the current 0.46 opacity floor reaches. If opacity is kept at all, never go below 0.8 on ink-2, which is 5.6:1 [V, computed].
- **Account and label colours** come from a curated set drawn from the icon: sky, hill, stamp red, dusk, the bridge's orange and the cloud's warm sand. Each colour is a light/dark pair and is assigned by hashing the name, the way Inbox Zero does, but with dark tints from day one.
- **Drop the rainbow HSL letter avatars** in rows. Tatem's 2025 list dropped avatars entirely [V]. Keep one small neutral avatar, ink on raised, beside the sender in the reader.

### 2.4 Type

**The rule: the system sans is your mail and your controls; the serif is Aplos speaking.**

| Token | Size / line height | Face, weight, tracking | Used for |
|---|---|---|---|
| `caption` | 11/14 | SF 500, +0.06 px | Keycaps, chips. This is the floor: nothing smaller, including calendar hour labels, which are 10–10.5 px today |
| `small` | 12/16 | SF 400/500, 0 | Timestamps, metadata, tabular numerals |
| `ui` | 13/18 | SF 400/500, −0.06 px | Sidebar, menus, controls |
| `base` | 14/20 | SF 400, −0.12 px | List rows ("Sender: summary"), settings |
| `read` | 15/24 | SF 400, −0.1 px, max 68ch | Plain-text mail bodies (Redakt 15/24, Inbox Zero 14.5/1.65) |
| `title` | 16/22 | SF 600, −0.24 px | View titles in the toolbar, the reader subject (subject at 500 in ink-2) |
| `summary` | 20/28 | **Newsreader** about 460, optical size about 20, −0.15 px | The one-line AI summary, *identical* on the Home focus card and at the top of the reader (today they differ, 18 vs 20 px) |
| `display` | 28/34 | Newsreader 450, −0.4 px | Welcome, closure, first-sync complete |

Notes:
- **Newsreader** is OFL and already an app dependency of the website (`apps/web/package.json`: `@fontsource-variable/newsreader`) [V]. Bundling it in Electron is simple. Chromium's support for `ui-serif` and access to the hidden New York face are uncertain, so don't rely on them [I, test first].
- **Ask answers** use the serif for prose and SF for citations and controls.
- **Weights:** only 400, 500 and 600 in SF, with 600 reserved for view titles and unread senders. Test whether SF's 450 renders in Electron before adopting it, as both the Redakt and Avec reports suggest [I].
- **Small details:**
  - Tabular numerals everywhere.
  - Superlocal-style +0.005 em tracking on non-Retina displays.
  - Define `--font-mono`, which is used today but undefined.
- **Risk** [I]: a serif summary can read as "editorial". Prototype the serif against SF 20/500 on real mail in both themes before committing. If the serif loses, the "Aplos speaking" rule can move to colour (ink-2 on a `--raised` card) instead.

### 2.5 Density and layout

- **Rows:** one-line rows stay at 40 px. Add a compact density (34–36 px) and keep the auto-height focus card. A 44–48 px single-line density, as Tatem suggests, is the same idea [V].
- **Widths:** at 1440 px, widen the Home and list column from 760 to about 820 px. Size the reader's paper card to its measure: about 720 px of content (68ch at 15 px) plus gutters, instead of a 960 px card with an empty right 40 % (`ui/aplos-baseline.md` §6.3) [V].
- **Spacing:** use one 4 px grid through the `--space-*` tokens, enforced by lint. Add Superlocal's fluid layout unit only for page gutters (10–18 px by width), so big monitors breathe without changing structure.
- **Keycaps:** hide them until hover, focus or holding ⌘. The only always-visible keycap is Space on the primary suggested action.

### 2.6 Surfaces, material and the brand marks

- **Lighting model, as tokens:**
  - a 0.5–0.75 px ring instead of borders;
  - one two-layer shadow per elevation: a wide layer at about 3–5 % plus a tight one at about 2–3 %;
  - an inset top sheen on raised surfaces in dark mode only;
  - a fixed-distance (about 56 px) highlight gradient on raised controls, so a dialog and a small button get the same top edge (Redakt's trick) [V].
- **Glass only for floating things:** popovers, tooltips, toasts and the command palette, at about 65 % paper with 16–24 px blur. Remove the glass pills from secondary controls. That leaves three button idioms: filled (one per screen), plain text and icon. Never blur large scrolling regions.
- **The macOS sidebar** keeps native vibrancy, which Inbox Zero lacks [V]. The browser preview gets an opaque `--sidebar` token that is *darker* than the canvas in dark mode, not today's lighter `#484a4c` slab.
- **The airmail stripe** (thin red/blue chevrons) appears in exactly two places:
  1. the undo-send progress bar, which drains as a stripe;
  2. a 3 px top edge on the composer card, meaning "this is an outgoing letter".

  Nowhere else, so it stays special. The website's stripe frame is the marketing version of the same mark [V].
- **Sky** appears in three places: welcome, first-sync complete and Home empty (section 4). It is always generated in code from the icon palette and never a stock image. The current UI also lacks the icon's wind swirls; a single thin drawn arc can serve as the "carried" motif in the closure scene and the send flight [I].

### 2.7 Iconography

- Keep SF Symbols, drawn by Aplos's helper with a Lucide fallback (`DECISIONS.md:127`) [V], as monoline icons in `--dim`. No filled or coloured icons except state dots.
- **Every AI suggestion carries the icon of its action:** reply arrow, calendar, link, paperclip, cart, phone. Never a sparkle, wand or star. The icon's airmail label has stars, so don't reuse that motif either [I].
- **Ask gets its own glyph,** a speech bubble (`text.bubble`) with the word "Ask". It stops borrowing the search magnifier (`Topbar.tsx:22`) [V].
- **Empty states** drop the icon-in-a-grey-circle pattern and use a plain, specific line.

### 2.8 AI presence without sparkle

1. **The voice is the mark.** Summaries and Ask prose are set in the serif. Nothing else needs to say "AI".
2. **Working state:** a slow opacity breathe on the placeholder line (0.55↔0.85 over 1.6 s, as in Redakt's skeleton), stopping the instant text arrives. Remove the gradient "glimmer" sweep, Ask's pulsing blue dot and the red "breathing" ring while recording.
3. **The reason is a disclosure, not a badge.** Add a quiet "why" under the focus card or summary, written in plain words with one quoted sentence from the thread, for example: "In Home because Jordan asks for your preference by tomorrow". It comes with one-key corrections ("Not important", "Keep in Home") that write deterministic sender rules (Superlocal, Redakt, Avec's visible learning) [V]. No confidence meters, model names or schema details; those go behind a developer toggle.
4. **Provenance on hover only:** for example, "Summary · Groq · gpt-oss-120b".
5. **Drafts are ordinary text.** Insert them editable, accept with Tab and discard with Esc, using neutral controls (not Zero's red/green). Polish appears as a diff beside your text and never replaces it.
6. **No key, no error.** Without a provider, the reader leads with the subject, and one quiet line in Settings → AI explains why. That fixes the baseline's "Couldn't summarize" defect [V].

### 2.9 Voice

Settings text says what a setting does, not how it feels. Replace "A comfortable place for your mail." with "Light, dark, or match the system." Keep one privacy explanation, in Settings → AI. Rename "Ready when you are" to something literal ("Later, due now" or similar) [I].

> **What this means:** Aplos keeps its calm, one-card interaction but stops looking like Avec. It gets cooler sky neutrals, airmail-blue actions, green for Done, dusk for Later, and a serif "letter voice" for everything the AI writes. The result is readable (every text colour passes accessibility checks), clearly Aplos, and needs no AI icon.

---

## 3. Motion system

### 3.1 Rules

1. **Navigation is instant.** Switching views, opening Settings and changing mailboxes use no motion, or at most a 100 ms opacity change. The baseline animates every view switch with a 4 px rise over 200 ms [V]. Remove it.
2. **Motion is spent on state changes only:** triage, send, arrival, and selection moving between peers.
3. **Nothing ever blocks input.** The state commits first and the animation plays on a ghost or a layer.
4. **Everything can be interrupted and retargeted** from where it is currently drawn. The calendar already does this (`calendarMotion.ts`) [V], and every motion should.
5. **Transform and opacity only.** No `height`, `width` or `padding` animation. Today these are used for row exits, the Ask dock and the tab indicator [V].
6. **Rapid mode:** when triage keys arrive less than 300 ms apart, multiply `depart`, `fly` and `travel` durations by 0.5 and skip staggers and settles (Avec) [V].
7. **Reduced motion:** opacity only, at most 120 ms, with no travel, flight or celebration. Spinners stay.
8. **Theme switch:** disable transitions for one frame (Redakt) [V].

### 3.2 Tokens

The existing scale (`--dur-instant` 60, `fast` 120, `base` 160, `slow` 200) stays as the base. Purpose tokens alias it. Springs are written as (stiffness, damping, mass) and compiled into CSS `linear()` easings at build time, so the same spring works in CSS and in the Web Animations API (`ui/motion.ts`). Chromium has supported `linear()` since version 113, well before Electron 44 [I].

| Token | Timing | Curve | What moves | Where |
|---|---|---|---|---|
| `press` | 80 ms down, 140 ms up | `--ease-out-strong` | scale 0.97 (icon buttons 0.94) | Buttons, keycaps, clickable rows |
| `hover` | 100 ms | `--ease` | background and colour only, gated on `(hover: hover)` | Rows, controls |
| `reveal` | 140 ms in, 100 ms out | out-strong in, `--ease-in` out | opacity, 4 px from the trigger side, scale 0.98→1 | Menus, popovers, the peek card. Tooltips: 140 ms the first time, instant while moving between controls (Tatem) |
| `settle` | 180 ms in, 120 ms out | out-strong / ease-in | opacity, 8 px rise, scale 0.98, *from its anchor* | Dialogs, ⌘K, the composer (grows from the Compose button or reply row), confirm cards |
| `travel` | 140 ms, **0** on key repeat or pointer | out-strong | transform of one shared cursor layer | List cursor in mailbox views. The Home focus card keeps its glide at 160 ms. Hover moves it instantly (the owner's rule) |
| `select` | spring 400 / 32 / 1 (ζ ≈ 0.80, about 1.5 % overshoot, settles in about 250 ms) | spring | one shared "puck" (translate plus scaleX) | Sidebar selection, Day/Week/Month, Ask/Today switch, Later groups, Settings nav. This is Tatem's measured spring [V] |
| `depart` | 120 ms (60 in rapid mode) | `cubic-bezier(.4,0,1,1)`, accelerating | a ghost row: translateX 28 px in the action's direction, plus opacity | Any row leaving any list |
| `hold` | until 450 ms after the last key, or until the pointer leaves the row (at most 1.2 s) | none | rows below are pinned in place with transforms | Burst triage, and new mail arriving while the user is active |
| `close-gap` | 180 ms | out-strong | FLIP transform of the rows below | After `hold` releases |
| `fly` | 220 ms (120 in rapid mode); commit fill within 60 ms | `--ease-in` (.5,0,.75,0) | the card translates out in the action's direction, lifts 8 px and tilts 2–3° | Done, Later or Bookmark on the focus card and in the reader; a sent letter leaving the composer |
| `swap` | 120 ms, exit and enter overlapping | `--ease` | opacity plus a 12 px offset in the direction of travel | Reader J/K (double-buffered), Later date groups |
| `arrive` | 200 ms | out-strong | opacity plus a 6 px drop-in; FLIP for neighbours | New mail rows, a sent message appearing in its thread, Ask cards. Deferred while the user is mid-burst |
| `dock` | 200 ms open, 140 ms close | out-strong / ease-in | panel transform | Ask/Today dock, sidebar (see the note below) |
| `follow` | spring 600 / 36 / 0.6 (ζ ≈ 0.95, settles in about 130 ms) | spring | transform | A dragged row or card following the pointer |
| `snap` | spring 300 / 30 / 1 (ζ ≈ 0.87, about 0.4 % overshoot) | spring | transform | A swipe springing back below the threshold; a drop target growing to 1.02 |
| `breathe` | 1.6 s loop | ease-in-out | opacity 0.55↔0.85 | Pending AI lines only. Stops as soon as content arrives |
| `status` | 1.5 s, alternating | ease-in-out | a 30 % segment sliding in a 2–3 px track | The sync bar. Spinners appear only after 150 ms (Superlocal) [V] |
| `celebrate` | ≤ 400 ms, skippable | out-strong | opacity, scale 1.02→1 of the sky | Home becomes empty, at most once per emptying |

Retire `--ease-spring` (about 7 % overshoot, `ui/aplos-baseline.md` §4) for everything except the switch thumb. No other motion in a calm app should bounce visibly.

**The dock note** [V: `DECISIONS.md:298`]. Animating the dock with transforms was tried and dropped, because a strip of window background showed during the slide. It was replaced with width animation, which costs a layout on every frame. Fix the strip instead:
1. paint the dock's final area in the dock colour on the first frame;
2. slide only the panel's *contents* in;
3. FLIP the mail column.

If that still shows seams in the packaged app, keep width animation on the virtualized list and measure it there. Performance is judged in the packaged app, not the preview (`DECISIONS.md:137`).

### 3.3 The signature: being carried off

Everything above composes into one recognizable behaviour [I]:

1. **Keyboard Done (E or →) on Home:**
   - the next item takes focus in the same frame;
   - the focus card gets a solid `--hill` fill with a check and the word "Done" within 60 ms, capped at about 70 % opacity in dark mode;
   - the card `fly`s right and slightly up, like a letter caught by the wind, which is also the icon's tilt;
   - the rows below `hold`, then `close-gap` once you pause.
2. **Later (L or ←)** does the same in `--dusk`, flying left and slightly down, as if set aside for the evening.
3. **Pointer or swipe triage** follows the finger. On release it continues from the release velocity rather than restarting, then holds the gap until the pointer leaves.
4. **Five quick E presses in a row:** each card leaves at half duration, the list never shifts, and one glide tidies everything when you stop.

This replaces the reader's 3D card swing (`perspective(1400px) rotateY(±14°)`, `ui/aplos-baseline.md` §4), which reads as a dating app, and Avec's toss with a 12° rotation [V]. Avec's `→ →` double-press for bulk Done is worth borrowing, with Aplos's own visuals.

### 3.4 Enforcement

- **An `aplos-motion` skill and checklist** that every UI agent loads, the method Redakt uses [V]. It names the tokens above, the eight rules and the forbidden patterns.
- **Lint rules:**
  - no literal durations or easings;
  - no `transition: all`;
  - no transitions on `width`, `height` or `padding`;
  - every `@keyframes` covered by reduced motion;
  - no raw hex.
- **Budgets as tests** (Superlocal's acceptance gates) [V]:
  - a triage key moves focus within one frame;
  - a cached open is under 100 ms;
  - a J/K step paints buffered content in under 50 ms;
  - startup with 10,000 threads stays smooth.

> **What this means:** about 18 named motions replace about 56 keyframes and 30 one-off timings. Moving around is instant. Finishing an email has one memorable, fast gesture (the letter flies off the way you sent it) that never makes you wait and never moves the list under your fingers.

---

## 4. Screen-by-screen revamp

### Window shell, sidebar and toolbar
- **Titles and Compose:** give every view a title in the toolbar's left slot (`title` token). Compose becomes a pencil icon button whose `C` appears on hover.
- **Sidebar order:** Home, Later, Calendar | All mail, Drafts, Sent | Trash, Spam. Calendar moves out of the footer, and "Calendar" then means only the page; the dock tab becomes "Today".
- **Sidebar footer:** a fixed status slot showing sync state, Settings and Help.
- **Sync states** come from the architecture plan: discovering, importing N of M, paused until a time, retrying, reconnect needed. They render in that fixed slot, never as a banner that pushes the list down (Superlocal) [V].
- **Motion:** the sidebar selection uses the `select` puck, and counts change with a quick, non-bouncy digit swap.
- **Minimized sidebar:** keep it (owner decision), and give its menu the same puck.

### Home
- **Focus card:**
  - sender plus a relative date on the first line, with no rainbow avatar;
  - the **serif summary** as the one big line;
  - a second row with the Space action (verb plus action icon plus Space keycap), then icon-only Later, Done and ⋯ whose keycaps appear on hover.
  - Remove the duplicate due badge when the summary already says "by tomorrow" [V].
- **Low importance:** keep its own `--raised` background. It opens grouped by sender, with a hover preview, per-sender **unsubscribe** once List-Unsubscribe lands, and `→ →` to mark everything done (Avec) [V].
- **Sections:** use Tab and ⇧Tab to jump between New, Later-due and Waiting (Inbox Zero's split cycling, adapted) [V]. Section labels are literal, small caps-free, in `--dim`.
- **New mail during triage** never shifts the focus card. It waits under `hold`, then `arrive`s, with a quiet "2 new" marker on the New label meanwhile.
- **Fix the Done semantics bug,** where Done on needs-reply mail stays on Home [V]. See the open questions.
- **Next-best-action toasts,** one per action, always with a key (Avec) [V]:
  - after Later, "Set a date · D";
  - after Done on a thread awaiting someone else's reply, "Remind me if no reply · R".
- **Guided "clear Home" session** (Superlocal's two-phase idea) [V]: first a checklist of no-action mail, confirmed once, then one card at a time. It needs an original name; not Superlocal's.

### Reader
- **Order, top to bottom:**
  1. the serif summary;
  2. the sender (popover with addresses) and relative date;
  3. the subject in `title` at 500 in ink-2;
  4. the body at `read` size inside a measure-wide paper card.

  This fixes the weights: today a 17/600 subject competes with a 20/500 summary [V].
- **Actions without the Avec cluster:**
  - Replace the floating bottom pill bar with an **action row on the paper card's bottom edge**, like the flap of the envelope. On the left is the suggested action (Space); on the right are Later ←, Done → and ⋯.
  - Reply becomes **R**, and **holding R** dictates a reply. Undo moves to toasts and trays.
  - This removes the three "Reply" affordances the baseline counted [V] and the 54 px pill.
- **Space** means the suggested action here too (the owner's rule applied everywhere).
- **Navigation:**
  - J/K `swap` with a double buffer, so the previous email stays until the next body is measured, with a 1.5 s deadline (Inbox Zero) [V];
  - the engine keeps neighbours warm (Zero) [V];
  - a wide back gutter fills the empty margin left of the card, with a faint gradient on hover (Superlocal) [V].
- **HTML mail** renders in a sandboxed, script-less iframe on a light paper card. The card is tinted with the email's own background colour even in dark mode, while plain-text mail follows the theme (Superlocal, Inbox Zero) [V]. Remote images are off by default, with a "Load images from this sender" line. This follows the architecture plan's HTML-isolation work.
- **Multi-message threads:** collapsed one-liners, plus a 3 px accent rail that `travel`s between messages when you use the arrow keys.
- **"How you know them"** popover on the sender, computed locally: first and last exchange, two-way thread count, a 12-week rhythm drawn as a dot row, and recent threads. It is labelled as history, not trust (Superlocal's idea) [V].
- **Importance:** "Important ▾" moves into ⋯ and the "why" disclosure.

### Compose and inline reply
- **New messages:** a paper card that `settle`s from the Compose button, with the stripe top edge. **Replies** stay inline under the thread by default, so the thread stays visible (the baseline flagged that full Compose hides it) [V].
- **Draft state:** one honest line, "Saving… / Saved / Couldn't save · Retry". Esc after "Saved" just closes, which fixes the baseline's contradiction [V].
- **Hints:** a key legend appears only while a temporary mode is open, such as an AI proposal or the recipient picker (Zero's footer idea) [V].
- **Sending:**
  - The composer `fly`s up and away along a small arc, the one place the "wind" motif appears.
  - The sent message `arrive`s in the thread with a tucked tray: "Sending in 8 s · Undo · Send now", with the stripe draining as the bar (Redakt's placement) [V].
  - One notice, not two. Also fix the undo-send setting that shows "Choose…" [V].
- **Dictation:** a calm level meter in `--stamp` at the field edge, instead of a pulsing ring.

### Ask dock
- **Closed by default on first run.** Today it opens with three suggestions over about 700 px of blank panel [V].
- **Header and empty state:** the speech-bubble icon, "Ask | Today" on the `select` puck, and recent chats with times in the empty state (Avec) [V].
- **While answering:** one steady line naming the real step, which folds into a dim, expandable step log with citations (Zero) [V]. Typed or held-A follow-ups queue as small editable cards (Zero) [V].
- **Answers:** serif prose with the decisive fact in medium weight.
- **Proposals:** confirm cards become Tatem-style key rows, a consequence line plus "Add ↩" and "Not now esc" [V].

### Search and the ⌘K command palette
- **Split the bindings:** `/` searches and **⌘K becomes a real command palette.** It shows a context line naming the targeted email, every command with its keycap, nested settings with breadcrumbs, and number keys in short submenus (Tatem) [V]. It is an overlay, not navigation chrome, so it fits the owner's rejection of a top bar [I].
- **Natural-language queries** turn into removable operator tokens (`from:`, `after:`, `has:attachment`) in the field (Zero) [V]. Server-side Gmail search runs only on Enter (see the protocols report).
- **Results** are one-line rows; the focus card appears only on the targeted row.

### Later
- **Name:** pick **Later** everywhere and remove "Todo" and "Todos" (`ui/aplos-baseline.md` §6.6) [V].
- **Grouping:** Overdue, Today, This week, Someday, with Bookmarks as a filter chip.
- **Dragging:** drag between groups to reschedule. Every group lights up as a labelled target and the drop snaps to that group's date (Avec, Redakt) [V].
- **Presets:** the date picker offers presets on 1–5.

### Calendar and Today
- **Fix the readability bugs:**
  - overlapping events lose their titles, so add minimum column widths, an ellipsis, and a stacked "+2" when columns get too narrow;
  - add the missing comma in day titles;
  - don't show Delete on an unsaved event.
- **Type:** hour labels at 11 px or more.
- **Motion:** use the `select` puck for D/W/M; keep the existing FLIP and pinch.
- **Colour:** event tints come from the icon-derived calendar set; keep the dashed outline for plans found in mail.

### Settings
- **Layout:** a page title, aligned navigation (today the nav starts 74 px lower than the content [V]), and settings searchable from ⌘K.
- **Copy:** each description states the effect in a single line, with longer explanations behind a disclosure.
- **Confirmations:** destructive confirmations use the two-row key list.

### Welcome and first sync
- **Welcome** is the one full-bleed sky screen: a generated gradient from `#67ccff` to `#2a9afd` with a hill line, and the paper card floating on it.
- **First sync** shows honest, segmented progress tied to engine checkpoints (recent mail listed, bodies, summaries). The segments collapse into a drawn check when done (Tatem's success ring, in Aplos's own form) [V]. The same component shows "Account connected" and the sidebar's "importing N of M".

### Home empty (closure)
- A quiet sky fills the pane, made in code: the icon palette, a thin wind arc and the hill silhouette. It runs at most 400 ms, is skippable and is static under reduced motion. It shows only two useful facts: how many emails you handled, and your next event.
- No stock video and no confetti. Fire it once per emptying.

### Toasts and undo
- A bottom-centre stack of **up to three**. Hover pauses the timers. Plain toasts last 4 s; Undo toasts last 8–10 s and then fade slowly (Superlocal) [V].
- **Wording follows the op queue:** pending ("Archiving…"), confirmed ("Done · Undo Z"), offline ("Saved here · will sync").
- **Undo lives where the object was** for sends (the tray) and in the toast for triage.
- One meaning per notice, which removes today's duplicate send toasts.

### Keyboard and help
- **One command registry** feeds the `?` sheet, ⌘K, tooltips, menus and toast keycaps.
- **One meaning per key:**
  - Space is the suggested action;
  - R replies, and holding R dictates;
  - holding A asks.

  The rule: **tap to act, hold the same key to say it**.
- **Arrow-key triage** moves behind a setting (an open question for the owner).
- **The `?` sheet** has a fixed height and lists alternatives with "or".

> **What this means:** most screens keep their structure. The biggest changes are the reader's action row (so it stops looking like Avec), a real ⌘K palette, honest sending and saving states, triage that never jumps, and three "sky" moments: first run, first sync done, and Home empty.

---

## 5. What not to copy

**Tatem**
- Hold-Space for peek: Space is Aplos's AI action. If peek is wanted, use hold ⌥ on a targeted row.
- Scroll-scrubbed hero theatrics with no reduced-motion path; a 160 px animated blur; abstract decorative scenes (bars, dots, grids).
- Low-contrast 35–55 % text on gradients; a dark-only site selling light mode.
- shadcn defaults left inside a custom system (black overlays, stone dialogs).
- Its translucent-everything wallpaper look in a native Mac app. Aplos already has vibrancy, and glass is for floating surfaces only.

**Avec**
- Its look: warm-grey canvas, white card, system blue, the bottom pill cluster. Also its wording ("Swipe through them", "Hold to talk"), which Aplos must remove now.
- Sparkle glyphs on Polish and on due chips.
- The default "Sent with" signature.
- Full-saturation green floods on dark surfaces.
- Its signature moments: the stock ocean video and the timed sorting game.
- Reply mailboxes duplicating Home, and split view (both already rejected by the owner).
- A 31 MB marketing video and a site without dark mode.

**Zero**
- The AI vocabulary: sparkles, purple borders, endless shimmer, pastel gradients.
- Character-by-character blur reveals of drafts.
- A summary collapsed behind a pill.
- A floating chat at 40 % opacity.
- Saturated red/green Accept and Reject buttons.
- Opt-in, off-by-default motion.
- Undo as a toast timer with no durable flush.
- Overloaded letters (r and a change meaning by view), and arrow keys that open threads.
- Three colour systems plus raw hex.
- Dark marketing that flashes white; about 48 MB of onboarding GIFs.
- Remote images and a branded signature on by default.

**Redakt**
- The looping rainbow "border beam" on AI, including on the idle Smart Compose button.
- Generate replacing the user's typed text.
- Every thread opening as a tab.
- A fixed 1 s hold before the gap closes (too slow for keyboard triage).
- Width/height animation on the composer.
- A glossy candy-orange compose button as the loudest object on screen.
- A plain, meaning-free list row.
- A promotional footer and remote images on by default.
- Untested 390 px layouts.

**Superlocal**
- Anything visual. It clones Superhuman and ships scraped commercial fonts and probably icons: the charcoal-and-lavender look, the ink bar, 36 px bold-sender rows, "Get me to zero", "Remind me", Important/Other naming, the bolt-as-command glyph.
- Focus rings removed in favour of a contrast filter.
- Model, schema and score internals in user-facing explanations.
- Placeholder dates left in pickers.
- A single toast slot that silently replaces an Undo.
- A permanently empty right sidebar.
- Walls of caveat text in Settings.

**Inbox Zero Mail**
- The Gmail-clone row: fixed sender column plus a run of chips.
- A list/split layout toggle.
- Sparkle and wand glyphs on every AI entry point.
- Solid blue tooltips.
- Linear easing on side panels; a compose window that appears with no origin.
- The stock 95 % scale and 48 % slide dialog entry.
- A light-only chip palette and a forced light native theme.
- One concept in two colours (Draft is blue in one place, green in another).
- Slate primitives clashing with warm tokens.
- Marketing art that has drifted from the product.

**Aplos's own baseline (drop these)**
- The gradient "glimmer"; rainbow HSL avatars; icon-in-circle empty states; glass pills on every control; microcopy in an assistant's voice; trust disclaimers repeated on five surfaces.
- The 3D reader fling; height, width and padding animations; every view switch rising into place.
- Pure-black dark mode; `--dim` at 4.07:1 and the 0.46 fade floor.
- Key caps on every control; Space with four meanings.

> **What this means:** borrow the engineering and the restraint, never the look. The sparkle family (sparkles, wands, stars, purple, shimmer, rainbow glows) is banned in every form, not just as an icon.

---

## 6. Suggested order for the UI workstream

1. **Trust fixes (days).** The ten baseline bugs, the Avec-matching wording, the contrast tokens and the fade floor. These are cheap and visible.
2. **Foundations (about 1 week).** New tokens (colour, type, space, motion and springs via `linear()`), lint, a CI contrast check, the `aplos-motion` skill, and one command registry. Visuals don't change much yet; drift stops.
3. **Identity (about 1–2 weeks).** Palette, Newsreader summary (A/B against SF first), the reader's action row, removing avatars and glass pills, dark night-sky surfaces, and the stripe in its two places.
4. **Motion signature (about 1 week).** `depart`/`hold`/`close-gap`, `fly` with commit fills, rapid mode, the cursor layer and the `select` puck, with budgets as tests.
5. **Screens.** ⌘K, Later rework, Ask polish, Settings, closure and welcome skies. Several pieces depend on the architecture work: sandboxed iframe HTML and double-buffering, prefetch, op-queue states for honest toasts, sync states for the status slot, first-sync checkpoints for the progress component.

Estimates are rough [I] and assume agents working from the skill and lint rules.

## 7. Open questions for the owner

1. **Cooler neutrals.** Earlier decisions kept "the calm warm palette" (`DECISIONS.md:72, 223`). Is moving to cool sky neutrals acceptable, given the website already took the icon's sky? If not, keep warm neutrals but still change the accent, the dark canvas and the reader action row.
2. **Serif summaries.** Newsreader for summaries and Ask prose: yes, or prototype it against SF first?
3. **Done semantics.** Should Done on mail that still needs a reply leave Home (with a "remind me" toast), or stay under "Waiting on you"?
4. **Arrow-key triage.** Keep ←/→ as triage keys, or put them behind a setting?
5. **Command palette.** Is ⌘K acceptable as an overlay, given the earlier rejection of toolbar navigation?
6. **Reply keys.** Reply becomes R, hold-R dictates, and Space is the suggested action everywhere, including the reader. Agreed?
7. **Naming.** "Later" everywhere, and "Today" for the dock tab?

## Evidence index

- **Reports:** `research/email-clients/ui/{aplos-baseline,tatem,avec,zero,redakt,superlocal,inbox-zero-mail}.md`; `research/inbox-zero/SYNTHESIS.md`.
- **Screenshots viewed** (under `/Users/knewton/.t3/aplos-research/ui/`): every file cited inline above, plus `aplos-baseline/{home-dark,reader-dark,reader-plan-light,compose-filled-light,calendar-week-dark,welcome-start-light,settings-general-light,later-todos-light,search-results-light}`, `tatem/{hero-mock-flat-gradient,app-signin-1440-light,sheet-s0-split-inbox}`, `redakt/{inbox-desktop-light,thread-light,sheet-archive,sheet-drag-drop,focus-light}`, `superlocal/{readme/conversation,frames/demo-sheet-done}`, `inbox-zero-mail/video-frames/{home-t1,home-archive-exit-sequence}`, `zero/home-desktop-light-fold`, `avec/landing-desktop-light`.
- **Aplos sources:**
  - `apps/desktop/assets/icon.png` and `AppIcon.icon/Assets/Firefly (1).png` (colour sampling);
  - `apps/web/public/og.png`, `apps/web/src/styles.css`, `apps/web/package.json`;
  - `apps/desktop/src/renderer/ui/tokens.css`;
  - `App.tsx:498`, `Reader.tsx:89`, `components/Topbar.tsx:22`;
  - `DECISIONS.md` (lines 15–20, 72, 125–137, 223, 298).
- **Scripts** (throwaway, outside the repo): `/tmp/aplos-synth-tools/sample*.py`, `contrast.py`.
