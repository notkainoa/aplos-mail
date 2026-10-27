# Design direction: Instrument

**A precision-and-speed direction for the Aplos Mail revamp**
Status: proposal for owner decision. Planning only.

---

## In plain English

Aplos as a professional instrument: quiet, exact, immediately responsive. Mostly type and space. Hairlines instead of floating cards. One colour for focus, green for Done, steel blue for Later, red only for irreversible things. The palette comes from the app icon — sky, ink, hill, stamp — but not literally: no postcard decoration, no red-and-blue border everywhere. The one postal mark is a straight edge on the composer and the send countdown.

It is deliberately not Avec. Avec is a warm-grey room with a white card floating in it and a big blue pill at the bottom. Instrument is a flat working surface with a two-pixel rule that follows your keyboard, a dense one-line list, and actions at the edge of the page. No rainbow avatars, glass pills, sparkles, shimmer, or "Swipe through them".

Speed is the promise. Your next key never waits for an animation: state changes first, focus moves in the same frame, and only a detached copy of the row moves. Navigation is instant. Five quick archives never make the list jump. Opening a message is instant because the body was prefetched, and the previous message stays until the next is ready. Each is a test, not a hope.

AI is content, not decoration. The summary is the biggest line on the card and in the reader, in the same typeface, marked by a small "Summary" label and the rule. No sparkle, wand or star. Ask why or correct it in one key; a correction becomes a rule. With no API key the reader simply leads with sender and subject, with no error on top of the mail.

If you choose this direction, the app becomes calmer and faster at the same time, and it looks like nothing else in mail.

> **What this means:** Instrument is a complete visual and interaction direction, not a theme. It changes the palette, type, density, motion, keyboard behaviour and the shape of every screen. The rest of this document specifies those choices precisely enough to build and test.

---

## The direction in one page

**Internal name:** Instrument. It is the design system, not a product name; the product remains Aplos Mail. "Airmail" is avoided because the identity audit records a collision risk with an existing mail product (`research/email-clients/gaps/identity-collision-audit.md`).

**Tagline:** The inbox as an instrument.

**Five signatures.**

1. **The rule.** A 2 px ink-blue rule marks the focused row, card and open message. It is one shared object that moves between rows and becomes the commit bar when you press Done or Later. It is the only thing that moves on its own.
2. **Flat surfaces, drawn edges.** No card shadows in the workspace. Tone and a 1 px ring separate surfaces. Shadows only on overlays.
3. **Type as structure.** Sender, subject, summary and metadata are separated by size, weight and alignment, not boxes. The summary is 22/30 at 560; body is 15/24 at 400.
4. **Dense by default, calm by composition.** Rows are 32 px. The focus card is a fixed 168 px with fixed slots, so it never changes height or pushes the list.
5. **Actions at the edge.** Actions live on the row's right edge, the reader's right rail, or the composer's top edge. No floating bottom pill.

**Not:** dark-only, tiny type (body 15 px, text at 4.5:1), a command line, or Avec recoloured (grammar, density, radii, actions and motion all differ).

**Ancestry, honestly.** Speed and keyboard posture are informed by Tatem; commit clarity and list stability by Avec; flat surfaces and inspector metadata by Linear-style tools and Superlocal's latency notes. The postal restraint is Aplos's own. No visual identity, assets, wording or code is copied.

> **What this means:** Every screen should be recognisable as the same instrument. If a screen needs a new colour, radius, animation or floating pill, the screen is wrong, not the system.

---

## Decisions for you

Defaults below are what this document specifies.

**1. Direction and name.** "Instrument" internally, "Aplos Mail" as the product, and no more "Airmail".
Recommendation: Instrument; the postal direction pulls toward decoration. Consequence: cooler and flatter. For warmth, change paper temperature, not structure.

**2. A serif for AI.** None, or serif only in Ask answers.
Recommendation: none. One family, one voice. A serif creates a second "letter" voice and slows scanning. Consequence: less literary, more exact.

**3. Default density.** Compact 28 / Standard 32 / Comfortable 40 px.
Recommendation: Standard, with Compact as a setting and Comfortable for accessibility. Consequence: more mail on screen; the card stays 168 px.

**4. The 40 px title strip.** View name, count, sync and `⌘K`, or no strip.
Recommendation: keep it, outside navigation. Consequence: 40 px less height; one stable place for status.

**5. Command palette.** Overlay on `⌘K`, plus `/` inline search.
Recommendation: yes, the fourth door for every action. Consequence: one more surface to keep in sync with the registry.

**6. Arrow-key triage.** `↑`/`↓` as an alternative to `J`/`K`, behind a setting.
Recommendation: yes, off by default. It must not steal arrows from reader or calendar.

**7. Sidebar width.** 208 px with a 48 px rail, or the current 248 px.
Recommendation: 208 px; the list becomes dominant. Consequence: tighter labels with tooltips.

**8. AI label.** A small "Summary" label plus the rule, or unlabelled.
Recommendation: label plus rule. It makes generated content visible without glyphs. Consequence: 11 px of height and a clearer contract.

> **What this means:** Accept the defaults and the document is buildable. Changing 2, 3 or 7 touches only the token layer and the Home card; the interaction model stays.

---

## Colour: ink, paper and four signals

The palette derives from `AppIcon.icon`: sky `#9fd3ff`, dusk `#11263d`, hill green and stamp red, as `DECISIONS.md` requires. It is not a literal sample: sky becomes a tint, dusk ink, hill Done, stamp irreversible. The accent is ink blue `#0B5394`, recommended by the identity audit after checking distances from other mail palettes; it is not the generic `#2563EB`/`#3B82F6` and never a large decorative fill.

**The one filled object rule.** In light mode the primary button is solid ink with paper text, not blue. In dark mode it is paper with ink text. Ink blue is reserved for focus, selection, links, the unread dot and the rule. This prevents the interface becoming a wall of blue buttons, the strongest visual tell of the Avec/Zero school. Green, steel blue and red appear only as commit or state signals.

### Light tokens

| Token | Value | Role | Contrast |
|---|---|---|---|
| `--canvas` | `#E7EDEC` | app background, list field | paper 1.18:1 |
| `--paper` | `#FFFFFF` | reader, cards, composer | ink 19.2:1 |
| `--raised` | `#F4F7F6` | hovered rows, secondary panels | ink 17.8:1 |
| `--sunken` | `#DDE6E4` | fields, keycap wells | ink 15.1:1 |
| `--sidebar` | `#DCE5E3` | sidebar fallback | ink 15.0:1 |
| `--line` | `#D3DDDB` | hairlines, rings | non-text |
| `--line-strong` | `#748A84` | control borders, offsets | 3.1:1 canvas |
| `--ink` | `#0B0F14` | text, primary fill | 19.2:1 paper |
| `--ink-2` | `#303A44` | subject, secondary headings | 11.6:1 paper |
| `--dim` | `#5A6672` | metadata, labels | 5.87:1 paper, 4.95:1 canvas |
| `--faint` | `#7D8894` | disabled, icons | 3.86:1 paper, 3.26:1 canvas, non-text only |
| `--accent` | `#0B5394` | focus, selection, links, unread | 7.84:1 white, 7.21:1 canvas |
| `--accent-soft` | `#E1EDF7` | selection tint, citations | non-text |
| `--hill` | `#2F6F2A` | Done, success | white 6.13:1 |
| `--later` | `#3E5878` | Later, deferred | white 7.31:1 |
| `--stamp` | `#B3261E` | destructive, recording, errors | white 6.54:1 |
| `--sky` | `#DCEEF9` | today tint, first-run band | non-text |
| `--post-red` | `#C8322F` | post edge, decorative | never text |
| `--post-blue` | `#1F4FA8` | post edge, decorative | never text |

State layers: hover ink `.04`, press `.08`, selected accent `.08` (light); `.06`, `.10`, `.14` (dark).

### Dark tokens

| Token | Value | Role | Contrast |
|---|---|---|---|
| `--canvas` | `#0B1015` | app background | paper 1.19:1 |
| `--paper` | `#18222C` | reader, cards, composer | ink 14.4:1 |
| `--raised` | `#202C38` | hovered rows, popovers | ink 12.1:1 |
| `--sunken` | `#070C10` | fields, wells | ink 16.8:1 |
| `--sidebar` | `#070C10` | sidebar | ink 16.8:1 |
| `--line` | `#2A3742` | hairlines | non-text |
| `--line-strong` | `#5E7180` | control borders | 3.8:1 canvas |
| `--ink` | `#E8EEF2` | text | 13.8:1 canvas, 14.4:1 paper |
| `--ink-2` | `#BCC7CF` | subject, secondary | 11.0:1 canvas |
| `--dim` | `#8B98A3` | metadata | 6.43:1 canvas, 5.46:1 paper |
| `--faint` | `#66727D` | disabled, icons | 3.85:1 canvas, non-text only |
| `--accent` | `#7CC0F0` | focus, selection, links | 9.62:1 canvas |
| `--accent-soft` | `#122A3B` | selection tint, citations | non-text |
| `--accent-fill` | `#4FA3FF` | rare accent button | `#04111F` text 7.25:1 |
| `--hill` | `#6CBF5A` | Done | `#04110B` text 8.40:1 |
| `--later` | `#9DB6D6` | Later | `#08121C` text 9.18:1 |
| `--stamp` | `#FF8A7A` | destructive, recording | `#0B1015` text 8.34:1 |
| `--sky` | `#122736` | today tint, first-run | non-text |

Dark primary fill is `--ink` with `--canvas` text.

### Rules

- **No text on `faint`, no opacity-based text.** `faint` is for disabled controls and non-essential icons; placeholders use `dim`. Opacity fails unpredictably over tints.
- **One accent per screen.** Two blue things at once means one is wrong.
- **Commit colours are brief.** Hill, later and stamp fill an edge or 28 px control for 50 ms, then leave. Never large backgrounds.
- **Rings, not shadows, in the workspace.** Shadows only on overlays: `0 8px 28px rgba(11,15,20,.08)` light, `0 10px 32px rgba(0,0,0,.36)` dark, plus the ring.
- **Curated account colours.** Eight icon-family values with light/dark pairs, stable hash, an 8 px dot or hollow chip. Never a filled pastel row.
- **Six calendar colours.** 10% fill light, 18% dark, 1 px solid rule. Text always ink or paper.
- **The post edge is the only postal decoration.** A 3 px straight edge on composer and undo drain. Never a ring, avatar or animated stripe.

> **What this means:** The app reads as cool paper and dark ink, with one blue rule doing the pointing. Green, steel blue and red appear only when something was done, deferred or destroyed. Every text pair is measured, so implementation can be checked rather than argued about.

---

## Type: one family, eight jobs

**Families.** SF Pro via the system stack for all interface and mail text. `ui-monospace`/SF Mono only for key sequences, code, citation numbers and model provenance. No serif, no display face, no all-caps wordmark in the app.

The case against a serif: it would be a second brand voice, and it would make the summary look editorial rather than like the fastest description of a message. The rule and the summary size already provide the letter feeling. Newsreader is OFL and easy to bundle, but technical ease is not a reason to add a voice.

| Role | Size / line | Weight | Tracking | Use |
|---|---|---|---|---|
| `micro` | 11 / 14 | 500 | +0.06em, caps | "SUMMARY", keycaps, column labels |
| `meta` | 12 / 16 | 400/500 | 0 | address, time, counts, provenance |
| `ui` | 13 / 18 | 400/500 | -0.006em | rows, controls, sidebar |
| `base` | 14 / 20 | 400 | -0.01em | compose fields, settings rows |
| `read` | 15 / 24 | 400 | -0.008em | body, Ask prose |
| `title` | 17 / 24 | 600 | -0.02em | reader subject, sheet titles |
| `display` | 24 / 30 | 620 | -0.035em | view titles, onboarding |
| `brief` | 22 / 30 | 560 | -0.025em | AI summary |

- Tabular numerals on times, counts, dates and durations.
- Sender names: 13/18 at 600 in rows, 14/20 at 600 in the reader. Addresses 12/16 at 400, `dim`. Time 12/16 `dim`, right-aligned in 56 px.
- The summary clamps to two lines on Home because the card is fixed; it is unclamped in the reader and never hides behind a pill.
- `brief` at 560 is available on macOS; test in the packaged Electron build and fall back to 600 if the variable font is unavailable. Never fake weight with opacity.
- Uppercase only for `micro` labels, maximum four words. No centred body text; empty states may centre one line. Measure 66 characters for reader and Ask, 62 for settings.
- At 1.57× body, 22 px reads as a headline, not display type; two lines fit the fixed card.

> **What this means:** One typeface, eight fixed roles, no decorative weights and no second voice for AI. The biggest text is the summary; the smallest is a label. That hierarchy is the typographic identity.

---

## Space, density, surfaces and icons

**Grid.** 4 px base, with 2 px optical nudges only for icon centring. Spacing tokens: 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 56.

| Element | Size |
|---|---|
| Sidebar | 208 px; 48 px minimized rail |
| Title strip | 40 px |
| Mail/list column | 720 px, left-anchored, not centred |
| Reader | 720 px sheet, 660 px measure |
| Ask dock | 320 px, resizable 280–420 |
| Compose | 640 px |
| Settings | 200 / 640 px |
| Calendar rail | 180 px |
| Palette | 560 px |
| Toast | 360 px |

The content column is left-anchored, with space breathing right: a clear difference from Avec's centred card deck.

**Density.** Compact 28, Standard 32, Comfortable 40 px; Standard default. The Home card is 168 px at every density; only rows change. Sidebar items are 28 px at every density, so navigation never moves when the list does. Section headers are 28 px with 12/16 `dim` labels and counts.

**Surfaces.** Canvas, paper, raised, sunken. No gradients except a 2% dark-overlay sheen. The reader is a sheet on canvas with a 1 px ring, not a modal. The composer rises 4 px and fades; it does not fly. Ask is a panel separated by a line, not a shadow. Native vibrancy on the macOS sidebar with an opaque fallback. No blur behind scrolling mail; overlays only, 88% paper plus 12 px blur when reduced transparency is off.

**Radii.** 3 px chips/keycaps, 5 px small controls, 6 px buttons/fields, 8 px sheets/cards, 10 px maximum overlays. No pills. Elevation is tone first, shadow second.

**Icons.** SF Symbols monoline, 15 px, 1.5 weight, `dim`; active uses `ink` and a 2 px accent rule on the sidebar row, not a filled rectangle. Filled only for unread/selected. No illustrations in empty states. Ask is `text.bubble`, compose `square.and.pencil`, Done `checkmark`, Later `clock`, bookmark `bookmark`, trash `trash`. No sparkle, wand, star, magic or "AI" glyph in product or website.

**Keycaps.** 18 px, 3 px radius, 11 px `micro`, `sunken`, 1 px `line`. On hover, focus, and always on the card's primary action. Hints, not decoration.

**Window.** Inset title bar, traffic lights at 16/16, 40 px drag strip with view name, count, sync and `⌘K`. Not navigation, never tabs.

> **What this means:** The app is a left-anchored working surface with 32 px rows, flat paper, hairline edges and small radii. Big type lives in a fixed 168 px card, so the list never jumps. The only postal garnish is one straight edge.

---

## How AI appears without a glyph

AI is content, not a character: label, position, typography, provenance; no mascot, colour, shimmer, sparkle or serif.

**Summary.** The largest line on Home and in the reader: 22/30 at 560, `ink`, two lines on the card, full in the reader. Under a `micro` "Summary" label and a 2 px accent rule. The rule is the same object as the focus rule, connecting "this is what matters" with "this is where you are". The label is plain English, not a brand: no "Aplos Intelligence", "Magic" or "Brief".

**Why.** `I` opens the inspector. The first block is "Why this is here": one sentence, then the exact quoted sentence. Sender rules are named. Corrections are one key: "Not important" (`⌥↓`), "Always Home" (`⌥↑`), "This sender is not a plan" (`⌥⌫` in a plan proposal). Each is confirmed by a 4 s toast with `Z` and writes a deterministic sender rule, not an opaque preference.

**Drafts.** "Draft" is an ordinary action from `⌘K`, the compose toolbar and Ask. It inserts ghost text at the caret. `Tab` accepts, typing replaces, `Esc` dismisses. It never sends, rewrites silently or opens a modal. "Polish" shows an inline diff with Accept/Reject.

**Ask.** 320 px right dock, resizable, remembered. Closed first run, opened by the onboarding drill. Header: "Ask", `text.bubble`, `A`, Ask/Today segmented control, close. Answers 14/22, decisive fact 600. Citations `[1]` in mono open the source in the reader; sources sit under a rule. Model and latency are 12 px mono on hover/focus, never in the reading path.

**Working, not performing.** One steady line, "Reading 3 threads...", then a 12 px step log with citations. No shimmer, pulsing dot or typing animation. Input is never disabled; `⌘↵` queues a follow-up while the answer streams. Proposals are confirm rows with the consequence and `Enter`/`Esc`; nothing is applied without confirmation.

**Absence is quiet.** With no key, Home and the reader omit the summary; the reader leads with sender, subject and body. Settings > AI explains it in one sentence. No red banner, repeated toast or blocked action. Local and offline use remain first-class.

**Voice.** Hold `A` for Ask, `R` for reply dictation, `Space` in compose. Recording is a 2 px stamp-red edge on the active field and a 28 px level meter, not an overlay or breathing ring. Release commits; `Esc` cancels; the transcript stays editable.

> **What this means:** You always know what is generated because it has a plain label and a consistent rule, and you can ask why or correct it in one key. AI failures never take over the mail surface, and there is no glyph to hunt for.

---

## Motion: the rule travels

Instrument has one signature: **the rule travels**. The 2 px focus rule is a single shared layer. On `J`/`K` it moves instantly with no easing, because the eye should not wait for the cursor. On pointer hover it appears in place with no transition. On Done or Later the rule extends across the row, fills in the commit colour for 50 ms, and becomes the leading edge of departure. The row leaves in the commit direction (Done: right and slightly up; Later: left and slightly down), with no rotation. Five quick presses look like a machine indexing, not a card trick.

Unlike Avec's card toss or the tactile direction's "carried" motion, Instrument keeps the list still while one exact mark moves.

| Token | Duration | Curve | What it does |
|---|---|---|---|
| `tick` | 60 ms | out | Keycap and small state ticks |
| `press` | 80 down / 120 up | out | Button/row press, scale .98 |
| `hover` | 0 ms | none | Pointer hover; never animated |
| `rule` | 160 ms | out-expo | Focus rule on keyboard; 0 ms pointer |
| `reveal` | 120 / 90 ms | out-expo / in | Menus: opacity + 2 px + .99 |
| `settle` | 160 / 120 ms | out-expo | Compose, sheets, dock contents |
| `depart` | 100 ms (50 rapid) | in | Committed row's ghost leaving |
| `compact` | 120 ms | out-expo | Gap closure, FLIP only |
| `fly` | 160 ms (80 rapid) | in | Commit fill and short card move |
| `swap` | 100 ms | out-expo | Focus card and reader crossfade |
| `arrive` | 160 ms | out-expo | New content and neighbours |
| `dock` | 160 / 120 ms | out-expo | Ask panel and workspace reflow |
| `puck` | spring 520/46/1 | zeta 1.01 | Segmented selection |
| `follow` | spring 700/40/1 | zeta .76 | Drag while pointer moves |
| `snap` | spring 400/34/1 | zeta .85 | Drop, spring back, release |
| `breathe` | 1600 ms loop | sine | Skeleton opacity .55–.85 |
| `status` | 1500 ms loop | sine | Sync segment pulse, 30% range |
| `closure` | 300 ms once | out-expo | Empty-state horizon draw |

Springs are stiffness/damping/mass. No bouncy spring for navigation, selection or reading. `follow` is the only under-damped spring, so a dragged object trails the pointer.

Easings: `--e-out: cubic-bezier(.16,1,.3,1)`, `--e-in: cubic-bezier(.5,0,.75,0)`, `--e-standard: cubic-bezier(.2,0,0,1)`. Linear only for drains and loops.

### Input never waits

1. **Commit on keydown.** State changes synchronously before any animation. Key-to-state ≤ 8 ms; key-to-paint for focus ≤ 16.7 ms.
2. **Focus moves with state.** The next row is focused in the same event; never wait for `depart` or `compact`. Five `J` presses in 200 ms end five rows down with five correct commits.
3. **Animate a ghost.** Clone the row with fixed geometry, remove the real row immediately, animate the clone. The list is correct before the animation is visible.
4. **Hold slots in a burst.** Commits under 280 ms apart enter rapid mode: `depart`/`fly` halve, no `arrive` or `settle`, gap closure deferred. After 450 ms idle, one `compact` closes gaps. Scroll, pointer down, `Esc` or view change closes them at once.
5. **Never animate layout.** No height, width, padding or inset animation. The Home card is fixed at 168 px; rows close with FLIP transforms; the reader crossfades in a double buffer.
6. **Navigation is instant.** No transition on view, folder, account or mailbox change. There is no page-transition token.
7. **Focus is a prefetch trigger.** After 80 ms focus or 100 ms hover, prefetch the body and ±1 neighbour; cancel on a faster move. LRU of 12 bodies.
8. **Double-buffer the reader.** Render and measure offscreen, swap with a 100 ms crossfade. If the body misses 1.2 s, keep the previous message with a 12 px status line, never a blank sheet. Cached open < 100 ms; reader move < 50 ms.
9. **Optimistic writes are durable.** Triage, read state, bookmark and Later write to a durable queue and render immediately. Undo is the inverse operation, not a delayed commit. Rejection restores position with an inline error and Retry.
10. **No spinner under 150 ms.** None for cached or local reads. Network operations get a 12 px title-strip ring after 150 ms, not a modal.
11. **Suspend when hidden.** Pause loops, timers and animations when not visible; stop springs on `pointercancel`; cancel ghosts on focus loss.
12. **Reduced motion.** Travel, scale and springs become a 100 ms opacity change or nothing. The rule jumps. Closure is skipped. Spinners remain.
13. **One frame for theme changes.** Disable transitions for one frame so the app changes at once.
14. **Measure, do not assume.** Budgets become a packaged-build suite: key-to-paint, ten rapid commits, cached reader, palette open, 10k scroll. Regressions fail the build.

> **What this means:** The animation layer never owns the truth. The app commits, moves focus and updates the list first; motion is a short explanation of something that already happened. That is what makes it feel fast on a slow connection.

---

## The screens

### Home

720 px column. Title strip: "Home", count, sync, `⌘K`. The focus card is a 168 px paper sheet with a 2 px accent rule and fixed slots: meta row (sender 13/600, account dot, relative time, "Summary" label, optional plan chip); summary 22/30 at 560, two lines; facts (due, attachments, threads, "because...") at 12/16 `dim`; action row right-aligned with the suggested action as a 28 px button plus `Space`, then icon-only Later `L`, Done `E`, Bookmark `B`, More `.`. No floating cluster.

Below, the queue: 32 px rows, 5 px unread dot, 168 px sender, subject, 56 px time, up to two hollow chips. No avatars. Hierarchy is colour: focus `ink`, next two `ink-2`, rest `dim` sender and `ink-2` subject. Cap at 12 rows plus a "Low importance · 12 senders" row opening a 560 px sheet. New mail during triage is a 24 px "2 new" marker with `⇧N`; it never reorders under the user.

**Acceptance:** `Space` commits within one frame; card height never changes; five rapid commits leave the queue visually stable; summary visible when configured.

### Later

Title, count, then Overdue / Today / This week / Someday. Group headers 28 px, 12/16 `dim`, with counts. Rows use the Home grammar with due right-aligned and an overdue icon plus `stamp` text, not colour alone. A `puck` segmented control switches Later / Bookmarks; bookmarks are a filter, not a mailbox.

Due popover is 560 px: Today, Tomorrow, This weekend, Next week, Pick a date, Clear. `1`–`5` apply presets, `D` opens, `Enter` confirms, `Esc` closes. Drag shows presets as drop targets; keyboard never requires drag.

**Acceptance:** one key plus Enter reschedules; overdue has icon and text; empty groups do not render; rapid Done is stable.

### All mail, Drafts, Sent, Trash, Spam

One dense list. Columns: dot, 168 px sender, subject with an inline summary fragment when short, up to two chips, 56 px time. No avatars. Per-row actions appear on hover/focus as a right rail over the time column, never pushing the row.

Header: title, count, account scope, filter. In All mail `1`–`9` select accounts; in Later they select date presets. The header shows which meaning is active; the palette lists it. A digit never does two things in one view.

`X` selects, `⇧X` extends, `⌘A` selects visible, `Esc` clears. A non-empty selection replaces the title line in place with a 36 px bar: "3 selected", Done, Later, Move, More, Clear. Destructive bulk actions need a second `⌫` or the explicit Delete button and always produce an 8 s undo toast. Drafts show edited time; Sent shows recipients; Trash and Spam offer Restore.

**Acceptance:** rows never reflow on hover; rail is keyboard reachable; selection is announced; Trash and Spam are reversible.

### Reader

Order: sender block, summary, subject, body.

Sender block: 24 px neutral monogram, name 14/600, address 12/`dim`, date 12/`dim` tabular, Reply/Reply all text buttons. Clicking opens a 560 px popover: addresses, first/last exchange, 12-week activity, thread count, "Open all from this sender". History, not a trust score.

Summary 22/30 at 560 with the `micro` label and 2 px accent rule. With no AI key the block is absent and the subject moves up. Subject 17/24 at 600, `ink-2`. Body 15/24, 660 px measure, `ink`, directly on the sheet.

A 40 px right rail: Later, Done, Bookmark, Reply, More, with keycaps on hover. Below 900 px it becomes a full-width 36 px bar with a top rule.

Collapsed messages are 28 px one-liners; `↑`/`↓` moves between messages, `J`/`K` between threads. The open message has a 2 px accent rule. Quoted history is behind "Show quoted text"; `O` toggles. The previous message stays until the next is measured. `⌘F` opens a 28 px find bar. HTML renders sandboxed, scripts off, images blocked; "Load images from this sender" is remembered. Plain text uses the same tokens, never a black terminal.

**Acceptance:** cached open < 100 ms; `J`/`K` paint < 50 ms; no blank frame; no horizontal scroll at 320 px; rail fully keyed; sender first.

### Compose and reply

A 640 px sheet anchored to the compose button, with a 3 px straight post edge. It rises 4 px and fades; never flies. Inline reply uses the same sheet anchored to the message, with 12 px `dim` context above.

Fields: To chips at 28 px, Cc/Bcc, subject 14/20, body 15/24. Formatting appears on selection or `⌘/`, not as a permanent toolbar. Attachments are 28 px rows with name, size and a progress hairline.

Save state is one line: "Saving...", "Saved", "Couldn't save · Retry". Closing a saved draft does not prompt; unsaved content prompts once. `⌘↵` sends, `⌘⇧↵` sends and marks Done, hold `Space` dictates, `Tab` accepts AI text, `Esc` dismisses. After send, the sheet collapses into a 36 px tray under the compose button: "Sent · Undo Z", a drain and "Send now". Sending is optimistic; the durable queue owns delivery; quitting warns only if an operation is pending.

**Acceptance:** send never waits; one notice per send; save state never contradicts; undo survives navigation; no AI action sends without confirmation.

### Ask dock

320 px right, 280–420 resizable. Closed first run, then remembered. Header: "Ask", `text.bubble`, `A`, Ask/Today `puck`, close. Under a 1 px rule, the conversation.

Empty: "Ask about your mail" at 17/24, five example prompts grouped by Find / Summarize / Draft / Schedule as 28 px rows with keycaps, recent chats in `meta`.

Running: one steady line, then a 12 px step log with citations. Input stays enabled. Answers 14/22, decisive fact 600, `[1]` mono citations, source list under a rule, model provenance on hover/focus. Proposals are confirm rows with the exact consequence ("Add to Calendar · Thu 14:00–14:30 · Work"), `Enter` confirm, `Esc` dismiss. Follow-ups typed during streaming become queued cards with `⌘↵` send now and `⌫` dismiss. `⌘N` new chat, `⌘J` toggle, `A` open and focus, `Esc` clear then close.

**Acceptance:** typing never blocks on streaming; every answer cites or says "No source"; no tool names; missing key is quiet.

### Calendar and Today

A real page, not a mail sidebar. 11 px hour labels, 1 px hour rules, no shadows. Today's column has an 8% `sky` tint and a 1 px `stamp` now line with a 5 px cap. Events: 6 px radius, 1 px left rule, title 12/16 at 500, time 12/16 `dim`, 10%/18% fill. Overlap columns ≥ 44 px, "+2" opens the stack.

D/W/M with `puck`; 180 px left rail with mini month, calendar dots and account filter. Title is the real date ("Thursday, 29 October 2026"); "Today" is a button. `T` today, `D`/`W`/`M` view, `←`/`→` period, `N` create, `Enter` open, `E` edit, `⌫` delete with 8 s undo. Drag creates/moves/resizes; pinch or `⌘`-scroll zooms; two-finger pages. Keyboard creation focuses time.

Plans from mail are dashed 1 px outlines with a 12 px label before confirmation. Selecting one opens a 560 px proposal: title, time, calendar, clash, source. `Enter` add, `E` edit, `Esc` dismiss. Nothing is written silently. Today is a 320 px agenda: next event, two more, free/busy, "Open calendar"; `⇧A` or the sidebar.

**Acceptance:** no clipped titles at 1440; no "Invalid Date"; Delete only after persistence; event text 4.5:1; grid keyboard navigable; proposals show source and consequence.

### Search and command palette

`/` opens a 28 px inline field in the title strip. Local filtering is instant; server search runs on Enter, never per keystroke. Recognised operators (`from:`, `to:`, `subject:`, `has:attachment`, `before:`, `after:`, `in:`) become 11 px chips. Results are 32 px rows with the match in `ink` and context in `dim`. No result is one line plus "Search all mail" when the index is partial.

`⌘K` opens a 560 px overlay: 88% paper, 12 px blur, 1 px ring, shadow, 10 px radius. The first line is the context ("In: receipt from Northwind, 12 Oct"), so a command knows its target. Input 15 px. Groups: Actions, Go to, Search, Ask, Settings; keys right-aligned. Nested pages use a breadcrumb. Footer: `↑↓`, `↵`, `esc`. One action registry generates palette, keys, menus, tooltips and help. Scoring: exact, prefix, word boundary, subsequence; recents boost but never beat exact. `1`–`9` run the Nth result. `>` filters commands; a plain query shows mail and commands. Open < 50 ms; typing < 16 ms.

**Acceptance:** every action has four doors; no dead ends; the context line is truthful; `Esc` closes without navigating.

### Settings

200 px nav, 640 px content on canvas. Title 24/30. Rows 32 px: label 13/18, description 12/16 `dim`, control right-aligned. Descriptions are one line; longer text sits behind disclosure.

Sections: General, Mail, Calendar, AI, Notifications, Accounts, Shortcuts, Help & About. Settings is searchable from `⌘K`.

AI shows provider cards for Groq, OpenAI, Claude, Gemini, OpenRouter, OpenCode Go, Ollama, LM Studio and a custom OpenAI-compatible server: connected state, key last four characters only, masked field, Test, Remove. Per-feature pickers for Ask, Summaries, Drafts, Plans and Voice. Local servers show address fields with default ports. Keys are never printed, bundled or logged. Voice lists only speech-to-text providers.

Shortcuts is generated from the registry, grouped by context, searchable, conflicts marked. Remapping can be phase 2; accuracy cannot. Accounts uses one name per account everywhere and puts connection state and Reconnect on the row.

**Acceptance:** no misalignment at 200% zoom; every setting keyboard operable; secrets never shown in full; model change needs no restart; absence is explained without alarm.

### Onboarding and first sync

640 × 520 sheet, one left-aligned column, a 1 px progress line with three ticks:

1. **Account:** Google, Microsoft, IMAP, or demo mail. OAuth opens in the system browser; the sheet shows "Waiting for Google..." with Cancel; the account is confirmed on return.
2. **AI (optional):** Groq preselected, key field, Test, "Skip for now", one sentence.
3. **Keys:** a live drill on demo mail: `J`/`K`, `Space`, `E`, `A`, each 28 px with a keycap, skippable. The last step opens Ask for the first time.
4. **First sync:** segmented progress tied to engine checkpoints: account → recent mail (N) → bodies → summaries. A 2 px line and a count, not a fake percentage. ETA only when computable. A paused state names the reason ("Google rate limit, retrying in 40 s") and offers Retry; the same state lives in the sidebar footer, collapsed to a check.

Skeletons are exact 32 px rows with `breathe`, no shimmer. If summaries are unconfigured, the plan omits that segment rather than failing. Shell and account paint under 1 s; Home under 2.5 s for 10k threads with a local index.

**Acceptance:** onboarding keyboard-only; every step skippable; no fake percent; paused sync explains why and how to resume; no blank window.

### Notifications and toasts

macOS notifications are optional per account, off for low importance. One per important thread, grouped, sender and subject, no body preview unless enabled. No notification for mail kept out of Home.

Toasts are bottom-right, 360 px, 1 px ring, 8 px radius, 12/16, at most three, 4 s information / 8 s undo, paused on hover and focus, text actions with keycaps. Never for navigation, successful saves or every sync tick.

Send uses the tray, not a toast. Triage uses a toast naming object and destination ("Moved to Later · Undo Z"), not "Done". Offline is a 24 px title-strip line, then one toast when an operation queues; no repeated failures. One operation, one notice.

**Acceptance:** one send = one notice; undo survives navigation; timers pause; polite announcement; never steals focus.

### Empty, loading and error

**Home empty** is a closure: a single 1 px horizon line (300 ms once, skipped under reduced motion), "Home is clear." at 24/30, "18 handled · next event 14:00" at 12/16, and "Undo last `Z`" / "Open Later". No illustration or confetti.

Later: "Nothing deferred." plus "Press `E` in All mail to finish a thread." All mail: "No mail in this view." plus account filter. Search: one line and "Search all mail".

Inline errors are a 1 px `stamp` rule, a 13/18 cause, and Retry with its key, where the action happened; no modal unless destructive. Offline is a state: "Offline · queued 2" in the sidebar, draining on reconnect.

AI errors never appear on the mail surface. A summary failure removes the summary and records one line in Settings > AI. Ask shows an inline sentence with Retry and "Continue without AI".

Fatal: full-window canvas, "Aplos can't reach its engine." at 24/30, one sentence with the log path, Restart, Copy diagnostics. No stack trace.

**Acceptance:** every error names cause and action; AI failure is never the top element; no empty-state illustrations; loading is determinate or honestly indeterminate; no dead ends.

> **What this means:** Every screen is a variation of one grammar: left-anchored column, 32 px list, fixed focus object, edge action rail, plain language. The reader is the one place type gets large; empty and error states are deliberately quiet.

---

## The keyboard

The keyboard is the fast path, not a secret handshake. One meaning per key per context, one verb everywhere. `Space` always runs the suggested action; `E` finishes; `L` defers; `A` asks; `R` replies. Holding is a separate layer, documented in the same place.

| Context | Key | Action |
|---|---|---|
| Global | `⌘K` | Command palette |
| Global | `/` | Search |
| Global | `C` | Compose |
| Global | `A` | Ask (tap open/focus, hold talk) |
| Global | `⌘J` | Toggle Ask dock |
| Global | `⇧A` | Today |
| Global | `⌘1`–`⌘8` | Home, Later, All mail, Drafts, Sent, Calendar, Trash, Spam |
| Global | `⌘,` | Settings |
| Global | `?` | Keyboard help |
| Global | `Z` | Undo last action |
| Global | `[` | Collapse/expand sidebar |
| Global | `Esc` | Back, then close, then clear |
| Home/list | `J` / `K` or `↓` / `↑` | Next/previous row |
| Home/list | `Enter` or `O` | Open |
| Home/list | `Space` | Run suggested action |
| Home/list | `E` | Done |
| Home/list | `L` | Later |
| Home/list | `B` | Bookmark |
| Home/list | `U` | Read/unread |
| Home/list | `#` | Trash |
| Home/list | `X` / `⇧X` | Select / extend |
| Home/list | `⌘A` | Select visible |
| Home/list | `.` | More actions |
| Home/list | `R` / `⇧R` / `F` | Reply / Reply all / Forward |
| Home/list | `I` | Inspector / why |
| Home/list | `⌥↑` / `⌥↓` | Always Home / Not important |
| Home/list | `⌘F` | Find in view |
| Later | `1`–`5` | Today, Tomorrow, Weekend, Next week, Someday |
| Later | `D` | Due picker |
| Reader | `J` / `K` | Next/previous thread |
| Reader | `↑` / `↓` | Previous/next message |
| Reader | `O` | Toggle quoted text |
| Reader | `I` | Inspector |
| Reader | `Esc` | Back to list |
| Compose | `⌘↵` | Send |
| Compose | `⌘⇧↵` | Send and Done |
| Compose | Hold `Space` | Dictate at caret |
| Compose | `Tab` / `Esc` | Accept / dismiss AI suggestion |
| Compose | `⌘B` / `⌘I` / `⌘U` | Bold / italic / underline |
| Compose | `⌘⇧B` / `⌘⇧A` | Cc/Bcc / attach |
| Ask | `↑` / `↓` | Suggestions/history |
| Ask | `Enter` | Run |
| Ask | `⌘↵` | Search all mail |
| Ask | `⌘N` | New chat |
| Calendar | `T` | Today |
| Calendar | `D` / `W` / `M` | Day/week/month |
| Calendar | `←` / `→` | Previous/next period |
| Calendar | `N` | New event |
| Calendar | `E` / `⌫` | Edit / delete |
| Palette | `↑` / `↓`, `↵`, `Esc` | Navigate, run, close |
| Palette | `1`–`9` | Run Nth result |

- **Tap and hold differ.** `A` taps to open and holds to talk; `R` taps to reply and holds to dictate; `Space` taps to act and holds to dictate only in compose. Help shows both.
- **One registry.** Every action is declared once with id, label, icon, key, context, undo and confirmation. Keys, palette, menus, tooltips and help generate from it.
- **Scoped handlers.** A key is active only in its context. `J`/`K` never fire in an input. Arrow triage is a setting, off in reader and calendar.
- **IME and layouts.** Never intercept keydown during composition. Use `event.key`, not `keyCode`, with layout-aware keycaps. Caps Lock is ignored. Single-key shortcuts are off in fields.
- **Discoverability.** Keycaps show on hover for the first 10 sessions, then on `⌘`-hold, focus and tooltip. `?` is always one key away.
- **No two grammars.** No `g`-sequences. Places use `⌘`+number, verbs letters, the rest the palette.

> **What this means:** The map is small enough to learn in one sitting and consistent enough to trust. Every action is reachable by key, palette, visible control and help, and the app never eats a keystroke while you type.

---

## Accessibility

**Contrast.** Light: ink/paper 19.2:1, ink/canvas 17.0:1, ink-2/paper 11.6:1, dim/paper 5.87:1, dim/canvas 4.95:1, white/accent 7.84:1, accent/canvas 7.21:1, white/hill 6.13:1, white/later 7.31:1, white/stamp 6.54:1. Dark: ink/canvas 13.8:1, ink/paper 14.4:1, ink-2/canvas 11.0:1, dim/canvas 6.43:1, dim/paper 5.46:1, accent/canvas 9.62:1, `#04111F` on accent fill 7.25:1, hill 8.40:1, later 9.18:1, stamp 8.34:1. `faint` is 3.86:1 paper, 3.26:1 canvas, non-text only. Paper on canvas is 1.18:1 and relies on a 1 px ring, not contrast.

**Focus.** 2 px accent ring with 1 px paper offset, always visible for keyboard, never removed for programmatic focus. Focus is not lost on view change, commit or dock toggle; it moves to the next row, the reader back button or the palette input. Skip to list `⌘⌥L`; skip to reader `⌘⌥R`.

**Motion and transparency.** Reduced motion replaces travel, scale and springs with a 100 ms opacity change or nothing. The rule jumps; closure is skipped. No parallax or autoplay beyond skeleton/status pulses, which become static. Reduced transparency removes blur and vibrancy. More contrast strengthens rings and uses `--line-strong` where a hairline would vanish.

**Screen readers.** Rows are a listbox with `option` labels for sender, subject, unread, plan and due. Palette is a combobox with `aria-activedescendant`, groups and counts. Toasts are polite live regions; errors prefix "Error". Reader is an `article` with ordered headings; the sender block is a labelled group. Calendar is a grid with day, time and event labels and text equivalents. Icon-only buttons have `aria-label` and a tooltip.

**Targets and zoom.** 28 px minimum pointer target with 4 px separation; 44 px on touch. The 32 px row is the target; rail buttons get 8 px padding. All sizes in rem; 200% zoom, reflow at 320 px without horizontal scroll, reader measure capped, calendar becomes an agenda below 720 px.

**No colour-only meaning.** Unread = dot + weight. Done = check + label. Overdue = icon + text. Plan = dashed outline + label. Selection = tint + rule + `aria-selected`. Destructive = stamp + wording.

**Timing and testing.** No interaction timeout. Undo is 8 s triage, 10 s send, and durable in Activity after the toast. No flashing above 3 Hz. Automated: token contrast, focus-visible, axe per route, 200% zoom, 320 px reflow, reduced motion, keyboard-only paths for ten tasks. Manual: VoiceOver for Home, reader, compose, Ask, calendar; Japanese and Chinese IME; Caps Lock; high contrast.

> **What this means:** Precision is not an excuse for small grey text or hidden focus. The dense layout is built on tokens that pass, a focus ring that is always visible, and motion that can be turned off without losing information.

---

## The owner's taste list

| Your instruction | How Instrument answers it |
|---|---|
| Docked Ask | 320 px right dock, resizable, `A`, `⌘J` |
| `Space` runs the suggested action | Primary action everywhere; verb and keycap on the card |
| Big summaries | 22/30 at 560, largest on card and first in reader; never behind a pill |
| Sender-first reader | Sender, summary, subject, body |
| No sparkle, wand or star | Banned in product, site, icons and marketing; marked by "Summary" and the rule |
| Sidebar only, minimized | 208 px; 48 px rail; no top-bar navigation; `[` collapses |
| No split view, no reply mailboxes | Reader replaces the list; Later is one concept |
| Calm, not toy-like | Flat surfaces, hairlines, 32 px rows, fixed card, no confetti or bouncy navigation |
| Fast, keyboard-first | Instant navigation, commit-on-keydown, prefetch, double buffer, rapid mode |
| Own identity, not Avec | Cool paper, ink primary, small radii, edge actions, travelling rule, one straight edge |

Two departures: higher density, and sender before summary in the reader. The big summary remains; calm comes from a stable list, not empty space.

> **What this means:** The taste list is satisfied by structure, not decoration. The only taste item that changes a token is density, and it is a setting.

---

## What not to copy

**Tatem.** No scroll theatre, hold-`Space` peek, dark-only palette, low-contrast greys, or performance of restraint. Borrow speed and single-column focus; light is primary and contrast is measured.

**Avec.** No warm-grey field, floating white card, bottom pill cluster, rotating toss, ocean illustration, spoken phrasing ("Swipe through them", "Hold to talk"), or default signature. Our surfaces are flat, actions at the edge, commits without tilt, copy plain.

**Zero.** No purple, sparkle, shimmer, per-character blur, collapsed summary pill, or oversized centred command surface. MIT code may inform ideas; no visual identity or copy is reused.

**Redakt.** No rainbow beam, tab strip, one-second hold, or overwrite. Its calm is useful; its decoration is not. The skill pack's licence is unverified, so no code or assets are used.

**Superlocal.** No visual identity, cloned internals, removed focus rings, or hidden affordances. Latency and focus notes are ideas; the look is not.

**Inbox Zero.** No Gmail row, chip run, sparkle, blue tooltips, linear easing, or layout toggle. AGPL plus extra terms means ideas only. Our rows are columnar and avatar-free; chips are hollow and capped at two.

**Airmail.** Not public. The identity audit records a collision risk; the product is Aplos Mail, the system is Instrument.

> **What this means:** We can learn speed from Tatem, commit clarity from Avec and restraint from Redakt without inheriting their look, wording or assets. Every reference is an influence, not a template.

---

## Build order and acceptance gates

1. **Tokens and type.** Light/dark tables, eight roles, radii, spacing, contrast test. Gate: every text pair passes, no raw hex, 200% zoom.
2. **Action registry and keyboard.** One registry, keymap, palette, help. Gate: four doors per action; no context leaks; IME test.
3. **List, Home, reader.** 32 px row, fixed card, travelling rule, prefetch, double buffer, rapid mode. Gate: key-to-paint, five-commit stability, cached open, no blank frame.
4. **Compose and undo.** Sheet, durable queue, undo tray, save state. Gate: send never blocks, one notice, undo after navigation.
5. **Ask and AI states.** Dock, answers, citations, corrections, no-key, voice. Gate: typing during stream, citations, no AI error on mail, key never logged.
6. **Calendar and plans.** Grid, proposals, Today, keyboard. Gate: no clipping, no invalid dates, confirmation before write.
7. **Settings and onboarding.** Provider matrix, shortcuts, first sync, drill. Gate: keyboard-only onboarding, honest sync, secrets masked.
8. **Empty, error, accessibility.** Closure, inline errors, VoiceOver, reduced motion, high contrast, 320 px. Gate: automated and manual tests above.
9. **Measured performance.** Packaged: cold start to interactive < 1.5 s; Home < 2.5 s for 10k; palette < 50 ms; reader move < 50 ms; key-to-paint < 16.7 ms. Gate: recorded, not estimated.

**Done means:** side by side with Avec, a person can say what Aplos is for in ten seconds. A keyboard-only user never needs the mouse. Turning off motion, transparency or a provider still leaves the whole product.

> **What this means:** The direction is buildable in small stages, and each stage has a test that can fail. It is not accepted until performance and accessibility gates pass, not just screenshots.
