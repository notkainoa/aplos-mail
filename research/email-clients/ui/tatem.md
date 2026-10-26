# Tatem: UI, motion and feel

Researched 2026-10-25 for the Aplos UI revamp. Tatem is closed source and proprietary (© Tatem Inc., all rights reserved). This report describes what I observed and measured. It contains no Tatem code, assets or copy beyond a few short quoted labels.

**How I studied it.** I drove https://tatem.com and the public sign-in page at https://app.tatem.com in headless Chromium at 1440x900 and 390x844, in both color schemes. I recorded deterministic scroll-frame sequences and timestamped CDP screencasts of hover and step transitions. I read the site's public CSS and JS, and the app's CSS and JS bundles, as text only. I also pulled 56 archived release notes (2023-2024) with their images from the Wayback Machine, plus the eight images on the current changelog.

**Evidence locations.**
- Screenshots and frames: `/Users/knewton/.t3/aplos-research/ui/tatem/`
- Raw HTML, CSS and JS: `/Users/knewton/.t3/aplos-research/tatem-raw/`

**Labels.** **[V]** marks facts verified from a file, URL or measurement. **[I]** marks inference.

**Status caveat.** The current site was rebuilt in May 2025, and its last changelog entry is 0.1.7 on 2025-09-08 [V]. An independent review archived 2026-06 says the team was acqui-hired by Wander and the product is probably unmaintained [V: Wayback copy of efficient.app/apps/tatem]. Treat Tatem as a design reference, not a competitor.

---

## 1. Overall feel

Tatem is calm, quiet and serious, with a little play reserved for easter eggs (the logo spins on hover, a terminal page for "Story", a blurred "Story" link in the footer). It is a "Superhuman-lite" for Gmail on the web: a sender-first, single-line list, split-inbox tabs, ⌘K, and Superhuman's key letters (E for done).

The defining trait is restraint:
- **One type weight.** Everything uses a single Inter weight. Hierarchy comes almost entirely from text opacity.
- **Few colors.** There is near-zero color except a blue unread dot and small tinted chips.
- **Short motion.** Motion is brief in the app. The website carries the spectacle.

It is built for keyboard-literate knowledge workers who want Gmail to feel like Linear. It is not for people who want automation or AI. The current product shows no AI anywhere (section 5).

The "feel" the owner likes is mostly the **marketing site's** motion system: scroll-chosen discrete states animated by stiff springs, plus a tilted app mock that settles flat as you scroll. That system is translatable to aplos.email. The **app** contributes a disciplined token system (translucent surfaces on a wallpaper gradient, layered soft shadows, 150-200 ms fade-and-scale menus) and an unusually consistent keyboard grammar.

## 2. Layout and information architecture

### The app, as of 2025 (from the hero mock)

The hero's SVG mock is a 1352x900 rendering of the app. I re-rendered it flat: `hero-mock-flat-gradient.png`, `hero-mock-flat-dark.png`, and 2x crops in `hero-mock-2x-left.png` and `hero-mock-2x-right.png`. Measured from its geometry [V]:

- **Two panes, no reading pane.**
  - A left sidebar 224 px wide, separated by a 1 px line at white 6%.
  - A full-width thread list. Opening a thread replaces the list; it is not a split view [I, consistent with the 2024 release notes: "open lands on the last message", "Esc back"].
- **Sidebar, top to bottom.**
  - An avatar plus a chevron (the account menu), with search and compose icon buttons on the right.
  - Views: Inbox 32, Starred, Sent 7, Draft, Done, More…
  - The wordmark sits at the bottom left. A 2023 release moved the logo there and put the account at the top.
  - The selected view is a 200x32 pill, radius 6, filled white 6%. Item pitch is 36 px.
- **Split-inbox tabs across the top of the list.** "Inbox 32 · Team 15 · Calendar 7 · Attachment 3", then a sliders icon (view options).
  - The selected tab is a 32 px pill, radius 6, filled #FCFCFC at 16%, with a two-layer shadow (0 .5 1 at 5%, 0 2 4 at 3%).
  - Counts are dimmed, at 40% opacity.
- **Rows.** A 48 px pitch, no dividers, no avatars. Each row has these parts:
  - A 6 px unread dot (#386CF4).
  - The sender at x=270, in a fixed column about 260 px wide; the thread count follows at 40%.
  - The subject (95%) followed inline by the preview (65%), truncated with an ellipsis.
  - Right-aligned chips before the date:
    - **Label chips**: 24 px, hollow, with a 1 px white-6% border and an 8 px colored dot (orange #FFAD47, green #43D692).
    - **A detected-date chip**: a calendar glyph plus "Sep 20" in #007EED on #0072D3 at 12%.
    - **A 24x24 attachment chip**: filled white 6%.
  - The date sits flush right at 65%, with a 28 px margin.
- **The app's own CSS confirms the rows** [V]. Rows are virtualized at a fixed 48 px height, absolutely positioned with `translateY`. The focused row is filled `bg-tertiary` (black 3% in light, white 4% in dark), and multi-select has its own fill.

### Older surfaces (2023-2024 release images)

The release images (`sheet-releases-*.png`) also show:
- a sender "heads-up" right sidebar, hidden by default and toggled with `]` (`[` hides the left one);
- a message-details drawer (⌘⇧O);
- a custom file viewer with a floating page and zoom pill;
- full-page compose;
- a help center opened with `?`.

The 2024 list had avatars and row dividers (`sheet-themes.png`); the 2025 mock dropped both [V].

### The command menu

The command menu is the spine of the app [V: release "upgraded-command-menu", image in `sheet-releases-5.png`]:
- A context line at the top shows the subject of the selected thread.
- A large input sits below it.
- Grouped results follow. Nested commands are searchable directly and render as a breadcrumb, for example "Account Settings › Profile".

### The marketing site

- **Banner and nav.** A fixed 40 px banner ("Join 10,000+…", white 4% fill) sits above a 60 px nav.
- **Hero.** A full-viewport sticky hero on a slate-to-sage gradient.
- **Feature scenes.** Six sticky scroll "scenes", then a sign-up block and a five-column footer.
- **Container.** The content width is 69.5rem (1112 px).

## 3. Visual language

### Typography [V]

**Family.** Everything is Inter (variable). The writing style guide says "we exclusively use the Inter family". The app loads it as `InterFont` with the full 100-900 axis and sets **normal weight = 450**. The site has a single face declared at 450.

**Site sizes.** Weight is 400/450 everywhere; no bold appears on the marketing pages. Line heights are `normal` except where noted.

| Role | Size | Tracking or line height | Color |
|---|---|---|---|
| Title-large | 40 px | — | — |
| Title | 30 px | — | — |
| Title-small | 20 px | — | — |
| Body | 16 px | −0.12 px tracking | — |
| Body-long | 16 px | 24 px line height | — |
| Support | 14 px | −0.1 px tracking | — |
| Caption | 13 px | — | — |
| Hero H1 | 40 px, weight 400 | — | white 95% |
| Eyebrow | 16 px | — | white 35% |
| Section label | 16 px, uppercase | — | white 70% |

**App sizes.** List text is about 14 px; I derived this from the 10.2 px cap height in the mock. The app's Tailwind scale runs 12, 14, 16, 18, 20, 24 and 30 px, with `tracking-tight` at −0.025em.

**Hierarchy is opacity, not weight.**
- Site text ramp: white at 95, 70, 55, 35 and 20% (`--color-primary` … `--color-muted`).
- App text ramp, dark: white at 95, 80, 65, 40 and 20%.
- App text ramp, light: black at 90, 75, 60, 35 and 18%.

### Color and themes [V: app.css `.light` / `.dark`]

**Brand.**
- The brand page lists Onyx #0A0A0A and Azul #3B82F4.
- The site's button and link blue is #386CF4, with #2660F3 on hover.
- The app's link blue is #2A63F4 in light and #648EF7 in dark.

**The light theme's surface is a gradient, not a color.** It runs 180° from #E2E0E0 to #EAE7E2 (36.5%) to #E2D1D1: warm grey into a faint rose. You can see it on the sign-in page (`app-signin-1440-light.png`). Everything on it is translucent:
- cards: #FCFCFC at 55%;
- modals, tooltips and toasts: #FCFCFC at 65%;
- the selected tab: #FCFCFC at 40%;
- input fills: black 2%.

The pricing page lists "Multiple themes" and "Custom wallpaper". The hero mock (white 12% panes on a blue gradient) shows the wallpaper idea: the app floats as glass over an image or gradient.

**Dark theme.**
- Surface #151515.
- Cards #5F5F5F at 22%.
- Modals #474747 at 40%.
- Tooltips #404040 at 40%.
- Toasts #383838 at 80%.
- Borders white 20, 12 and 8%.

**Named hues.** Each theme has a five-step ramp (300-700) for red, orange, yellow, green, blue and purple, plus pink in dark. The dark ramps are lifted slightly.

**Detected-date chip.** It uses #0072D3 at 12%, rising to 20% on hover, in both themes.

**Dark-mode handling.**
- The **site is dark-only.** `prefers-color-scheme` has zero matches in its CSS, and the light and dark screenshots are pixel-identical (`home-1440-light-fold.png`).
- The **app** has light, dark and system themes. The sign-in page rendered light even under `prefers-color-scheme: dark`, because the `<html>` element carries the class `light` [V]. So the theme is chosen by the app, not by the media query, at least before login.

### Surfaces, depth, blur and radius [V: app.css]

**Shadows are two-layer and very soft.**

| Layer | Shadow values |
|---|---|
| Modal and command menu | `0 1px 40px` black 5% + `0 3px 12px` 3% |
| Dropdown | `0 1px 16px` 5% + `0 2px 8px` 3% |
| Tooltip and toast | `0 1px 10px` 5% + `0 2px 6px` 3% |
| Card | `0 1px 20px` 3% + `0 3px 8px` 2% |

In dark, dropdowns add a 1 px white-12% ring.

**Focus ring.** A 4 px halo of link-blue at 30% plus a 1 px edge at 90%. The 2024 confirm dialogs show this on the primary row.

**Backdrop blur.**
- tooltips: 24 px;
- confirm dialogs: 16 px;
- some modals and buttons: 40 px;
- the site's hero button: 40 px.

**Radius.**
- App base: 5 px (`--radius: .3125rem`); menus `rounded-lg`.
- Site base: 10 px.
- Mock pills and chips: 6 px.

**Iconography.** Thin 1.5-2 px stroke icons; the site uses Lucide. There are no filled glyphs and no AI glyph anywhere.

**Density.** Medium. The 48 px rows are tighter than Aplos's 56 px. Generous horizontal gutters (about 28 px) and the absence of dividers make it read airy.

## 4. Motion

All values below are read from the source or measured. The springs are framer-motion `{type:"spring", stiffness, damping}` with mass 1. For each I computed the damping ratio ζ = d / (2√k) and checked it against the frames.

### Marketing site (tatem.com)

| # | What | Properties | Timing and curve | Purpose |
|---|---|---|---|---|
| 1 | Hero app-mock flies in | `perspective(5408px)`; scale .1875→.25 (×4 inner = .75→1.0); translateX 120vw→0; translateY 300vh→80vh (desktop, inside the scaled space); rotateX 5→0°, rotateY −9→0°, rotateZ −32→0°, skewX 22→0° | **Scroll-scrubbed** over the first 450 px; progress mapped through easeInOutCubic; rAF-throttled passive listener; `will-change: transform, filter` | Product reveal: the app settles from a tilted "on the desk" pose into a flat screen. `sheet-hero-desktop.png`, `frames/d-hero-*.png` |
| 1m | Same on mobile | scale .15→.2, translateX 600vw→0, then **blur 0→160 px** over the last 10% | Same | Decorative streak; expensive |
| 2 | Hero mock load fade | opacity 0→1 | 800 ms, 200 ms delay, `cubic-bezier(.645,.045,.355,1)`. Measured: change begins about 900 ms after navigation and ends about 1.5 s (`cast/load/`) | Lets the SSR headline land first |
| 3 | Hero copy exit | opacity 1→0, blur 0→5 px; `user-select: none` past 50% | Scroll-scrubbed with easeInOutCubic | Headline dissolves as the product takes over |
| 4 | Nav background | transparent → #0A0A0A | 200 ms color transition, triggered by an IntersectionObserver on the hero (−40 px root margin) | Legibility after the hero |
| 5 | **Feature scenes** (×6) | A sticky 400/460 px card (radius 10, white 6%) inside a section vh+800 px tall (vh+400 on mobile). Progress = scroll over 800 px (400 on mobile), **quantized to the nearest of 4-10 snap points** | Each discrete state change animates on its own clock (below) | The key idea: **scroll picks the state and a spring animates it**, so motion never lags the wheel and never feels scrubbed |
| 5a | Split-inbox tab pill | a shared highlight's x and width, measured from the DOM | Spring **k=400, d=32** (ζ=0.80, about 1.5% overshoot). Measured: 123 px move reaches 97% in about 230 ms, overshoots 2 px, settles about 400 ms (`cast/split-pill/`). Label color 200 ms | Selection moving between peers |
| 5b | Text-editor scene | text revealed proportionally from 0 to 0.8 progress; at 0.9 a selection highlight (#0072D3 at 40%) fades in; at 0.98 the floating toolbar fades in | 300 ms opacity each | Typing, selection, then format toolbar (`sheet-s1-modern-text-editor.png`) |
| 5c | Speed scene | 10 bars skewed −15° (40×180 px, 12 px gap); one highlighted bar steps | A spring is declared, but the transform is set inline, so it **jumps** [I from code; frames agree] | Pure decoration |
| 5d | Theme scene | 8 dots at white .04…95; the active dot grows 36→52 px; a white overlay on the card goes 0→.75 | Dot: spring 400/32. Overlay: 400 ms easeInOut | Dark-to-light sweep (`sheet-s3-seamless-design.png`) |
| 5e | Shortcuts scene | key overlays light ⌘K, E, R, C at progress .2/.4/.6/.8; a label chip swaps text | First and last overlays 500 ms ease-in-out; middle ones 100 ms ease-out; chip color 55%→95% in 300 ms | Teaches four keys (`keyboard-overlays.png`, `sheet-s4-shortcuts.png`) |
| 5f | Security scene | three 4×4 grids of 32 px squares (radius 6, gap 6) reshuffle | Layout spring **k=300, d=30** (ζ=0.87, about 0.4% overshoot); fill 300 ms easeInOut | Abstract "encryption" shimmer |
| 6 | Logo hover | rotate 360° | 500 ms, `cubic-bezier(.4,0,.2,1)` | Easter egg; the same rule exists in the app sidebar (`state-logo-midspin.png`) |
| 7 | Links | color 55%→70% | 150 ms `(.4,0,.2,1)` | Hover |
| 8 | Buttons | background #FCFCFC 8%→12% | 150 ms | Hover; 40 px tall, radius 8, 40 px backdrop blur |
| 9 | Mobile menu | overlay opacity 0→1; icon rotates 90° while two bars translate ±3.5 px and rotate ±45° | Overlay 300 ms ease-out; icon 300 ms; bars 200 ms. Midway it reads as "+" (`state-mobile-menu-120ms.png`) | Open and close; body scroll is locked |
| 10 | Route change | `main` fades in | 700 ms opacity; skipped on first load | Page transition |
| 11 | Contact form and accordions | form height collapses; the submit button's width morphs while its text blurs 2 px; success text de-blurs from 4 px; accordion height plus opacity | 800 ms, 200 ms, 1 s and 500 ms, all easeInOutCubic | Form states; generic |

**What is missing on the site:** there is no `prefers-reduced-motion` handling anywhere in its CSS or JS [V: zero matches].

### App (app.tatem.com bundle)

The app uses **no** framer-motion [V: no spring configs in 139 chunks]. All motion is CSS: Tailwind 4 plus enter/exit keyframes keyed to Radix `data-state`, Sonner for toasts, and Tippy for some tooltips.

| What | Values | Notes |
|---|---|---|
| Menus, popovers, right-click, view options | opacity 0→1, scale .95→1, plus an 8 px slide **from the trigger side** (`slide-in-from-top-2` when opening downward); exit mirrors it | Default `animate-in` duration is 150 ms |
| Tooltips | same fade + zoom .95, translucent, 24 px backdrop blur, max width 300 px | The 2023 release note says tooltips appear and disappear instantly; the 150 ms enter is the only motion |
| Confirm dialog | 368 px wide, fade + zoom .95, 200 ms, 16 px backdrop blur | Unsubscribe, block and similar |
| Modal overlay | open 200 ms, close 150 ms | Exits faster than entries |
| Side sheet | open 500 ms, close 300 ms, ease-in-out | Rare |
| Sidebar toggle | list rows and header animate `padding` over 250 ms ease-in-out | Content re-indents smoothly instead of jumping |
| Sticky list header | the bottom border appears only once scrolled | Quiet depth cue |
| Loader → success | A ring of short pill ticks (10×4 px, radius 20 px) steps on an interval. On success the ticks turn green, blur to 4 px and fade over 1.2-1.5 s with `cubic-bezier(.34,1.56,.64,1)` and a 200 ms delay; a checkmark then draws via `stroke-dashoffset` over 800 ms ease-in-out; the container fades over 800 ms on the same back-out curve | "Connected." step in onboarding (`changelog/cl-4-…-dark.png`) |
| Onboarding text | opacity 0→1 with blur 4 px→0 over 0.8 s, back-out curve | Welcome copy |
| "Press Enter to continue" hint | fade up 10 px, 0.5 s ease-out after 0.3 s; fixed bottom-centre pill | Teaches keyboard-first from the first screen |
| Global default | 150 ms `cubic-bezier(.4,0,.2,1)` | Hover and color |

There is no list enter/exit or swipe motion in the app CSS [V]. Triage is instant. Speed is the feel.

## 5. Interaction model

### Keyboard [V: app bundle shortcut table plus release notes]

| Area | Keys |
|---|---|
| Navigation | J/K or ↑/↓; ←/→; ⌘↑/⌘↓ jump to top or bottom; Esc goes back; Tab moves to the next split |
| Triage | **E mark done** (⇧E undo); U toggles read; S star; P spam (⇧P undo); ⌫ trash (⇧⌫ restore); X select; ⇧↑/↓ extend selection; L add label; ⇧L remove label; H remind me and ⇧M mute (in 2024 menus) |
| Messages | R reply; Enter reply all; F forward; C compose; ⌘Enter send; ⌘⇧B shows Cc/Bcc; ⌘⇧U upload; ⌃⇧F expand compose to full page; Tab cycles compose fields |
| Universal | **O opens anything**: a thread, a collapsed message, or trimmed quoted history |
| Copying | ⌘⇧' subject; ⌘⇧. sender address; ⌘. sender name; ⌘⇧, thread URL |
| Chrome | ⌘K command menu; / search; V view options; [ and ] sidebars; ? help center; ⌘U unsubscribe |

Two more rules:
- Key labels adapt to the OS (January 2024).
- Caps Lock no longer affects shortcuts (August 2024).

### "Every action, four doors"

Each action is reachable by key, command menu, right-click menu and the ⋯ menu. All four show identical labels with keycaps. Dropdowns are fully keyboard-navigable: arrows, Enter, and →/← into and out of submenus. Submenu options carry number keys; for example, Group by lists Default 1, Day 2, Week 3, Month 4, None 5 (`sheet-releases-6.png`). Tooltips on nearly every button show name plus keycaps ("Archive [E]").

### Confirmations are keyboard lists, not button rows

The Unsubscribe and Block dialogs show:
- a title ("Unsubscribe?") and a one-line consequence;
- two full-width rows: the primary action with "Enter" right-aligned, focused with the blue ring, and "Cancel" with "Esc".

See `sheet-releases-0.png` and `sheet-releases-5.png`. Unsubscribe offers three choices: unsubscribe, unsubscribe and archive all, or unsubscribe and delete all.

### Peek

Quick Look (January 2024): **holding Space** shows a floating preview of the focused thread that disappears on release, and a **tap** pins it. It is for deciding "is this worth opening?" without opening it.

### Selection and bulk actions

A floating pill reads "23 Selected" with archive, trash and ⌘K icon buttons. Toasts give past-tense confirmations ("Message Starred"); hovering reveals a close ×, and some toasts embed a link.

### Compose

**Shape.**
- A centred modal that can expand to a full page.
- Recipient chips drag between To, Cc and Bcc.
- Suggested contacts highlight the typed prefix at full opacity and dim the rest (`changelog/cl-2-…-dark.png`).
- Opening R or F from the list lands the scroll on the draft.

**Editor (TipTap/ProseMirror) [V: bundle].** It has:
- Markdown shortcuts and `/` slash commands that list key hints;
- a `:` emoji picker;
- arrows from `->`;
- a floating selection toolbar: B, I, U, S, link | bullets, numbers, quote | highlight, color, size | clear (`keyboard-overlays.png` bottom, `sheet-releases-5.png`);
- color, highlight and size submenus navigable by keyboard.

### Reading

- Opening a thread lands on the last message, or on the first draft if there is one.
- Trimmed history toggles with O.
- A tag ("Archived", "Spam", "Trash") appears with a matching restore button when you open a thread from those states.
- The error state is a full-bleed brand-blue panel with "Restart" and "Sign out" (`sheet-releases-1.png`).

### Onboarding

- **Sign-in page.** "Welcome back" over the warm gradient, then "Continue with Google". Gmail is the only provider (pricing page).
- **First run.** Workspace creation, a role/size/referral survey, and the "Connected." tick-ring success.
- **Hints.** Persistent "Press Enter to continue" pills.
- **History.** In 2024 every user needed an onboarding call; self-serve began 2025-07-01.

### Empty states

I could not observe them. The app requires an account and I did not create one [unknown].

### AI

There is **no AI on any current user surface** [V: no AI on the marketing site, changelog or pricing]. Two older or hidden traces exist:
- The 2024 Webflow site (tatem.webflow.io) advertised "Tatem AI": rules and automations, smart labels, an AI editor, and "intelligent replies" with tone presets.
- The 2025 bundle contains summary, structured summary (keyPoints, tone, urgency, actionItems) and natural-language search endpoints. They sit next to SQL-console and mutation-queue tools under `/_auth/developer/*` routes. That reads as internal tooling, not a shipped surface [I].

### Speed

The app's <50 ms feel is architectural [V: bundle, I: interpretation]:
- a SQLite database in a dedicated worker, persisted to OPFS;
- a local mutation queue plus a remote-mutation worker;
- `/api/mail` with SSE/WebSocket push of Gmail `historyId` updates.

The UI reads locally and writes optimistically. This is the same shape the owner wants for Aplos, with Tatem's server remote instead of local.

## 6. What is distinctive, and what is generic or bad

### Worth learning

1. **Hierarchy by opacity with a single weight.** The calm comes from removing bold and color. A five-step alpha ramp per theme does all the work and composes on any background, wallpaper included.
2. **Glass on a wallpaper.** The light theme's surface is a gradient and every layer is translucent with two-layer, low-alpha shadows. That gives depth without borders.
3. **"Scroll chooses, spring animates."** Quantizing scroll progress into discrete states and letting a stiff, slightly underdamped spring (ζ≈0.8, settle about 250 ms) animate between them feels crisp and alive. It avoids the mushy lag of scrubbed animation, and it is the single most transferable motion idea here.
4. **A single selection highlight that travels.** The split-tab pill is one element that springs to the measured x and width of the target. It is not a per-item background.
5. **A keyboard grammar applied everywhere.** Four doors per action, identical keycaps, instant tooltips, number-key submenus, and confirmations as Enter/Esc rows. Users learn shortcuts by using the mouse.
6. **Short, asymmetric app motion.** Enter 150-200 ms, exit 150 ms, a fade plus 5% scale plus a small slide from the trigger side. Nothing in the list animates. Speed reads as quality.
7. **Peek on hold.** A cheap, high-value triage tool.

### Generic or bad

1. **The spectacle is on the website, not the product.**
   - Six sticky scenes cost about 13,000 px of scroll for six claims.
   - Three scenes (speed bars, theme dots, security grid) are abstract shapes that say nothing about email.
   - The speed bars' declared spring is dead: the bar jumps.
2. **No reduced-motion support** on the site, and a 160 px blur on the mobile hero. Both are accessibility and performance misses.
3. **Low contrast.** The 35% white eyebrow and 55% body on the mid-blue gradient fall well under WCAG AA [I from computed colors].
4. **The site is dark-only** while selling "Light mode. Dark mode."
5. **Contradictory claims.** The homepage says <50 ms interactions; the pricing page says <100 ms. "We don't store any of your emails" also sits awkwardly beside a server that proxies Gmail (`/api/mail/threads`) and a local OPFS database.
6. **A thin product.** Gmail only, web only, and shortcut depth a reviewer called "not as in-depth or as polished as it could be". It is likely abandoned.
7. **Boilerplate defaults left in.** Some shadcn defaults remain in the bundle: a `bg-black/80` overlay, a `stone-100` dialog, sidebar tokens in zinc.

## 7. Suggestions for Aplos (original, in Aplos's terms)

Aplos already has a real motion system:
- tokens `--dur-instant` 60 to `--dur-slow` 200, `--ease-spring`, `--ease-release`;
- `usePresence`, `useListPresence` with exit hints, and `hintExit`;
- SF Pro at 14 px, 56 px rows, vibrancy sidebar, Space as the AI primary action.

These suggestions build on that. None reuse Tatem assets, copy or keys verbatim.

1. **Ink alpha ramp alongside the solid inks.**
   - Add `--ink-a1…a5`, black or white at roughly 92, 74, 58, 38 and 18%.
   - Use them for text on vibrancy, on the Ask dock, and on any future wallpaper.
   - Keep solid `--ink`/`--dim` where contrast must be guaranteed, and check every pair against AA.
   - Use weight for one thing only: unread sender. Everything else steps through the ramp.
2. **One "puck" for segmented selection.** A single absolutely positioned highlight that springs to the measured rect of the active item. Use it for:
   - the sidebar views (Home, Later, All mail, Drafts, Calendar);
   - the calendar Day/Week/Month switch;
   - Settings tabs;
   - Ask modes.

   Approximate a ζ≈0.8 spring with a 240 ms `--ease-spring`, or use a small spring helper in `ui/motion.ts`. **Do not** animate the J/K row cursor: Tatem's instant row focus is part of why it feels fast, and Aplos's hover-retargets-keyboard behavior needs the same instant feedback.
3. **Confirm cards as two-row key lists.**
   - Aplos's AI confirm cards and destructive actions (unsubscribe, block, delete forever, discard draft, cancel a scheduled send) become a consequence line plus two full-width rows: "[Action] · ↩" focused with the focus ring, and "Cancel · esc".
   - Unsubscribe offers a third row: "Unsubscribe and archive past mail".
   - This is a natural fit for the List-Unsubscribe work already on the roadmap.
4. **Peek without stealing Space.** Space is Aplos's AI action, and holding Space dictates in the composer, so copying hold-Space would collide.
   - Use **hold ⌥ over a targeted row** to float a read-only peek: the sanitized body inside the planned sandboxed iframe, plus the Aplos summary on top.
   - Release dismisses it; ⌥-tap pins it.
   - The peek card enters with the existing 160 ms fade and scale .97→1, anchored to the row.
5. **Number keys in every short menu.**
   - Later/snooze presets 1-5, view density 1-3, calendar view 1-3.
   - Show the digit as a right-aligned `Kbd`.
6. **Command palette context line.**
   - Show the targeted thread's sender and subject above the input.
   - Make nested settings directly searchable with breadcrumb results ("Settings › AI › Summaries model").
7. **Detected-plan chip in the row.** Aplos already extracts plans.
   - Render a small tinted date chip (blue-soft fill, blue ink, calendar glyph) before the date when a thread contains a plan.
   - Make it the visible cue for what Space will do on that row.
   - This turns an invisible AI decision into a quiet, inspectable affordance, with no sparkle needed.
8. **Hollow label chips.** A 1 px `--line-soft` border with an 8 px colored dot, instead of filled pills. This keeps colorful labels from shouting in a summary-heavy list.
9. **A compact density option.** Keep 56 px summary rows as the default. Add a 44-48 px single-line density (sender column, subject then dimmed summary inline, chips, date) for heavy triage days.
10. **Smooth re-indent when chrome changes.** Animate list `padding-inline` over `--dur-slow` with `--ease-in-out` when the sidebar or Ask dock toggles, instead of reflowing instantly. The sticky toolbar gets its bottom hairline only once the list is scrolled.
11. **An honest progress-to-success moment for first sync.**
    - Replace a spinner with segmented progress tied to real checkpoints: metadata pages committed, then bodies, then summaries.
    - When done, the segments collapse into a drawn check (`stroke-dashoffset`, about 600 ms) and the copy blurs in.
    - Reuse it for "Account connected".
    - It pairs with the planned resumable first-sync work, so the UI and the engine tell the same story.
12. **Translucency budget.** Popovers, tooltips and toasts use about 65% `--card` with 16-24 px backdrop blur and the two-layer shadow recipe (one wide, low-alpha 40 px blur plus one tight 8-12 px). Keep Aplos's own glass rim. Do not blur large scrolling regions in Electron; that costs GPU.
13. **For aplos.email: scroll-quantized scenes with real components.** The site already runs live demos of the real interactions. Wrap three of them (Space → suggested action, E/L triage with directional row exits, week-calendar drag) in sticky scenes:
    - each scene about vh+400 px;
    - progress snapped to 3-5 states;
    - each state change plays the real component's own transition.

    Requirements:
    - a static `prefers-reduced-motion` fallback that shows the end state;
    - legible contrast;
    - light and dark;
    - at most one modest 3D settle on the hero (rotateX ≤ 8°, no skew, no blur over 8 px).
14. **Keep motion asymmetric and short in the app.** Enter `--dur-base`, exit `--dur-fast`, slide 4-8 px from the trigger side, no list choreography during triage except Aplos's existing directional exit hints.
15. **Keep AI quiet.** Tatem shows that a product can feel premium with zero AI chrome. Aplos's AI should surface as text, chips and the Space key affordance. The owner bans sparkle, wand and star glyphs, and none are needed.

## Evidence index

Under `/Users/knewton/.t3/aplos-research/`: site captures `ui/tatem/home-*.png` and `*-1440-full.png`; app mock `ui/tatem/hero-mock-*.png`; motion `ui/tatem/sheet-hero-desktop.png`, `sheet-s0…s5-*.png`, `frames/`, timestamped `cast/*/`, `sheet-states.png`, `sheet-mobile.png`, `keyboard-overlays.png`; app UI `ui/tatem/changelog/sheet-changelog.png` (2025), `sheet-releases-0…6.png` and `releases/` (2023-2024), `sheet-themes.png`, `app-signin-*.png`. Raw text, read only: `tatem-raw/assets/`, `tatem-raw/app/`, `tatem-raw/wb/`, `tatem-raw/hero-mock.svg`.

Sources: https://tatem.com (and /changelog, /pricing, /brand, /writing, /about, /story, /careers), https://app.tatem.com/sign-in, https://tatem.webflow.io, and Wayback Machine copies of `tatem.com/releases/*` (2023-2024) and efficient.app/apps/tatem (2026-06-06).
