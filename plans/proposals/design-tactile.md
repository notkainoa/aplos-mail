# Design direction: Carried (tactile)

Independent proposal for the Aplos UI revamp. Angle: physical craft from the icon — letters, paper, wind, hills — with depth, texture and restrained motion. Fast and keyboard-first. Fully independent of Avec.

Evidence draws on `research/email-clients/SYNTH-ui.md`, `research/email-clients/ui/*.md`, `research/email-clients/gaps/identity-collision-audit.md`, and screenshots under `/Users/knewton/.t3/aplos-research/ui/` (aplos-baseline, tatem, avec, redakt, zero, identity-audit). **[V]** = verified in those sources. **[I]** = design judgement.

---

## In plain English

This proposal gives Aplos a body you can almost feel. Today the app looks like a careful grey utility, while the icon is a painted letter flying over a green hill. The two do not match. Carried fixes that by treating mail as paper on a soft desk, not as flat cards on a warm Avec-like canvas.

When you open Home, emails sit like letters on felt. The one you are working on lifts a little, as if you picked it up. When you finish it, the letter is carried off by a short wind motion in the direction you sent it — Done to the right toward the hill, Later to the left into evening. Your next key never waits for that motion. The list stays still under your fingers while you work quickly.

Aplos speaking — summaries and Ask answers — uses a quiet letter-like serif. That is the only AI mark. No sparkles, wands or stars. The primary action still lives on Space. Ask still docks on the side. The reader stays sender-first with a big summary on top.

The colours come from the icon but stay calm enough for all-day reading: cream paper, soft desk grey-beige, deep ink blue for actions, moss green for Done, dusk blue for Later. Dark mode is a warm night desk, not pure black. A thin red-and-blue edge stripe appears only when something is leaving (send undo, outgoing compose). We do not call any of this “Airmail”; that name belongs to another Mac mail app.

What changes for you: the product finally looks like its own icon, stops looking like Avec, and keeps the calm keyboard speed you already like. What changes for users: mail feels physical and finished, without becoming slow or decorative.

---

## 1. Identity: unmistakably Aplos, not Avec

### 1.1 The problem

Side-by-side, Aplos Home and reader still share Avec’s desktop grammar [V: `ui/avec.md` §1–2; `aplos-baseline/home-light.png`, `reader-light.png`; Avec `desktop-preview/seg/t0176.3.png`]: warm-grey canvas, one white card, large blue primary pill, bottom action cluster, “Hold to talk”, and “Swipe through them”. `DECISIONS.md` already required independent wording; those phrases remain [V: `ui/aplos-baseline.md` §6.1, §6.8]. The interaction model (one focus card, Space, hold-to-talk, docked Ask) can stay. The *look and words* cannot.

### 1.2 The Carried story

The icon is a letter in flight over a hill under sky [V: `identity-audit/icon-compare.png`, `apps/desktop/assets/icon-256.png`]. Carried maps that story into materials, not into a flat “sky brand”:

| Metaphor | Material in the UI | Where it appears |
|---|---|---|
| **Desk** | Soft warm felt canvas | App chrome, gutters, sidebar-adjacent ground |
| **Letterstock** | Cream paper with quiet fiber | Mail cards, composer, reader body |
| **Ink** | Deep fountain-pen blue | Primary actions, links, focus |
| **Hill** | Moss green | Done commits and Done fills |
| **Evening** | Dusk blue-grey | Later commits |
| **Wind** | Short travel + thin drawn arc | Triage flight, send flight, empty Home |
| **Post edge** | Straight red/blue stripe | Send undo bar; composer top edge only |

Codename **Carried** (internal only). Public name stays **Aplos Mail**. Never use “Airmail” in UI, onboarding, release notes or App Store keywords [V: `gaps/identity-collision-audit.md` §0, §7]. Call the accent **ink blue**, the mark **post edge**, not “airmail blue / airmail stripe”.

### 1.3 How this is not Avec

| Avec (observed) | Carried |
|---|---|
| Warm utility grey + system blue `#0050ff` | Warm *desk* + deeper ink `#0b5394` (ΔE ≥ 10 from Avec primary [V: identity audit §4]) |
| Floating bottom pill cluster | Actions live on the letter’s bottom flap |
| Solid saturated green flood | Moss hill fill + soft *stamp* press, then wind carry |
| “Swipe through them”, “Hold to talk” | Literal labels: “One at a time · S”, “Hold R to dictate” |
| Stock ocean empty state | Quiet generated hill + wind arc, once per emptying |
| Sparkles on polish / due chips | Banned family: sparkle, wand, star, purple shimmer, rainbow beam |

### 1.4 How this differs from a cool “paper on sky” read

Carried still uses sky *tints* and the hill, but the daily workspace is a **desk**, not a full-bleed sky field. Sky appears as atmosphere in three earned moments (welcome, first-sync complete, Home empty). Day-to-day chrome stays tactile and warm so Aplos does not become another cyan mail brand (Spark / Canary / Bloop marketing skies [V: identity audit §1, §4]).

### 1.5 Post edge rules (collision-safe)

- Straight horizontal edges only [V: identity audit §7].
- Never a ring, avatar rim, circular progress, or icon border (Bloop’s 2014 geometry).
- Two places in-app: undo-send drain; composer top edge (3 px).
- Site can keep top/bottom frames; rename CSS away from `.airmail` when implementation starts.

> **What this means:** Aplos keeps its calm triage model but gets its own materials — desk, paper, ink, hill, wind — so a screenshot cannot be mistaken for Avec or for Bloop’s Airmail.

---

## 2. Colour tokens (light and dark)

Every ratio below was computed with the WCAG relative-luminance formula (same method as SYNTH-ui / identity audit). Targets: body and UI text ≥ 4.5:1; large/display ≥ 3:1; non-text UI components ≥ 3:1.

### 2.1 Core surfaces and ink

| Token | Light | Dark (“night desk”) | Role | Contrast notes |
|---|---|---|---|---|
| `--canvas` (desk) | `#ebe6df` | `#12100e` | App ground; warm, soft | Replaces cold utility grey and pure `#000` [V: baseline §3.1, §6.5] |
| `--paper` | `#faf6ef` | `#1f1b17` | Letters, composer, reader card | Dark: pane lighter than shell (Redakt lesson [V: `ui/redakt.md` §3; `inbox-desktop-dark.png`]) |
| `--raised` | `#e3ddd4` | `#2a251f` | Summary nest, low-importance bundle, inputs | |
| `--ink` | `#1a1612` | `#f3eee6` | Primary text | 14.5:1 / 14.8:1 on canvas/paper light; 16.4:1 night |
| `--ink-2` | `#3d3832` | `#cfc7bb` | Secondary text, subjects | ≥ 9.3:1 light |
| `--dim` | `#5c564e` | `#a39b8f` | Timestamps, section labels | **5.8:1** on canvas light (up from baseline 4.07:1 [V]) |
| `--faint` | `#8a8378` | `#7a746a` | Placeholders, disabled, icons only | ~3.0:1; never body copy |
| `--line` | `#d4cec4` @ 1 px / 0.5–0.75 px ring | `#3a342c` | Hairline rings, not heavy borders | |

### 2.2 Action and meaning colours

| Token | Light | Dark | Role | Contrast |
|---|---|---|---|---|
| `--accent` (ink blue) | `#0b5394` | `#6eb0ff` | Primary buttons, links, focus ring | White on light fill **7.8:1**; dark text `#0e0c0a` on dark fill **8.7:1**. Clears Avec `#0050ff` by ≥ ΔE 10 [V: identity audit §7] |
| `--sky` | `#8ec8f0` @ ≤ 18% fill | `#1a2a3a` | Selection wash, focus halo, sky moments | Tint only |
| `--hill` (Done) | `#2f6f2a` | `#6cbf5a` | Done fill / stamp | White on light **6.1:1**; dark ink on dark fill **8.6:1** |
| `--dusk` (Later) | `#3e5878` | `#8fa9cc` | Later fill | White on light **7.3:1** |
| `--stamp` (danger / record) | `#b52e28` | `#ff7a6e` | Trash, errors, dictation meter | White on light **6.2:1**. One red only (baseline had two [V]) |
| `--stripe-red` / `--stripe-blue` | `#d83237` / `#1f4fc8` | same @ 85% | Post edge decoration | Not for text |

### 2.3 Rules

1. One accent per screen. Hover = ink 5%; press = ink 9% (`color-mix`).
2. No raw hex in components; lint enforced (Redakt/agent pattern [V: SYNTH-ui §1 #10]).
3. **Home distance:** step the *ink ramp* (focus `ink` → next `ink-2` → rest `dim`), do not multiply opacity below 0.8. Fixes the 1.76:1 fade floor [V: baseline §6.5].
4. Account/label colours: curated set from icon (sky, hill, stamp, dusk, bridge orange, cloud sand), hashed like Inbox Zero, with dark pairs from day one [V: SYNTH-ui §2.3].
5. Drop rainbow HSL letter avatars in lists [V: baseline §6.8; Tatem 2025 dropped avatars [V: `ui/tatem.md` §2]]. One small neutral avatar (ink on raised) beside the sender in the reader only.

### 2.4 Acceptance

- Automated contrast check for every token pair used for text, light and dark, in CI.
- Screenshot diff of Home/reader against Avec desktop frames must show different canvas hue family and no bottom floating pill bar.

> **What this means:** colours come from the icon, stay readable all day, and the blue is deep ink — not Avec’s electric blue — so identity and accessibility move together.

---

## 3. Type

**Rule:** the system sans is your mail and your controls; the serif is Aplos speaking as a letter.

| Token | Size / LH | Face | Use |
|---|---|---|---|
| `caption` | 11/14 | SF 500, +0.06 px | Keycaps, chips. Floor: nothing smaller (calendar hours today 10–10.5 [V: baseline §3.2]) |
| `small` | 12/16 | SF 400/500 | Timestamps, metadata, tabular nums |
| `ui` | 13/18 | SF 400/500, −0.06 | Sidebar, menus, controls |
| `base` | 14/20 | SF 400, −0.12 | List rows, settings |
| `read` | 15/24 | SF 400, −0.1, max 68ch | Plain-text bodies (Redakt/Inbox Zero measure [V]) |
| `title` | 16/22 | SF 600, −0.24 | View titles; subject at 500 in `ink-2` |
| `summary` | 20/28 | **Newsreader** ~460, opsz ~20, −0.15 | One-line AI summary on Home *and* reader (same object; today 18 vs 20 [V]) |
| `display` | 28/34 | Newsreader 450, −0.4 | Welcome, closure, first-sync complete |

**Why the serif stays in Carried.** A tactile letter metaphor wants a letter voice. No audited mail client sets AI text in a serif [V: identity audit §4]. Newsreader is OFL and already on the website [V: SYNTH-ui §2.4]. Ask answers: serif prose, SF for citations and controls.

**Weights:** SF 400 / 500 / 600 only; 600 for view titles and unread senders. Prototype SF 450 in Electron before adopting [I]. Tabular numerals everywhere. Define `--font-mono`. Optional +0.005 em tracking on non-Retina (Superlocal [V: SYNTH-ui §2.4]).

**Risk gate.** A/B Newsreader 20 vs SF 20/500 on real mail in both themes for one week of daily use. If serif loses, keep “Aplos speaking” via `ink-2` on `--raised` paper nest — still no sparkle.

> **What this means:** you read mail in a clear Mac sans; you recognise Aplos’s own words by a quiet letter serif, so AI never needs a magic icon.

---

## 4. Spacing, density, surfaces, iconography

### 4.1 Density and layout

- Rows: 40 px default; compact 34–36 px; focus card auto-height [V: baseline §3.3].
- At 1440: Home/list column ~820 px (from 760). Reader paper sized to measure (~720 px content + gutters), not a 960 px card with empty right 40% [V: baseline §6.3].
- 4 px spacing grid via `--space-*`, linted (today ~5 token uses vs ~660 literals [V]).
- Fluid gutter 10–18 px by width for large monitors only.
- Keycaps hidden until hover, focus, or ⌘ held. Only always-visible keycap: **Space** on the suggested action.

### 4.2 Surfaces and texture (the tactile core)

**Lighting model (tokens):**

1. **Ring:** 0.5–0.75 px instead of 1 px borders (Redakt [V]).
2. **Elevation:** two-layer shadow per level — wide ~3–5% ink, tight ~2–3% (Tatem [V: `ui/tatem.md` §3]).
3. **Letter lift:** focus card and open reader use `--elev-letter` (about 0 1px 2px / 0 8px 24px). Peers stay flat on the desk.
4. **Press inset:** primary and icon buttons use a 1 px inset bottom highlight that swaps to top inset on `:active`, scale 0.97 (icons 0.94) — rubber-stamp feel without cartoon bounce.
5. **Dark sheen:** inset top highlight on raised surfaces in dark only.
6. **Fixed-distance highlight** (~56 px) on raised controls so small and large buttons share the same top edge light (Redakt [V]).

**Texture (performance-safe):**

- `--texture-desk`: SVG noise at 3–4% opacity, `background-blend-mode: multiply`, pointer-events none; applied to canvas and sidebar fill, never to scrolling row text.
- `--texture-paper`: finer fiber at 2% on `--paper` cards only.
- Both disabled under `prefers-reduced-transparency` and when GPU frame budget fails a packaged-app probe (`DECISIONS.md` performance judged in packaged app [V: SYNTH-ui §3.2]).
- No large-region `backdrop-filter` on scrolling mail. Glass only for floating: popovers, tooltips, toasts, ⌘K (~65% paper, 16–24 px blur).

**macOS sidebar:** keep native vibrancy [V]. Browser preview gets opaque `--sidebar` *darker* than canvas in dark (not today’s lighter `#484a4c` slab [V: baseline §3.1]).

**Button idioms (three only):** filled (one per screen), plain text, icon. Remove glass pills from secondary controls [V: baseline §6.8].

### 4.3 Iconography

- SF Symbols via existing helper + Lucide fallback [V: DECISIONS]. Monoline in `--dim`. No filled colour except state dots.
- Every AI suggestion uses the *action* icon: reply, calendar, link, paperclip, cart, phone — never sparkle/wand/star. Do not reuse the icon’s starry stamp label in UI [V: identity audit §5; owner taste].
- Ask: `text.bubble` + word “Ask” (stop borrowing search magnifier [V: baseline §6.6]).
- Empty states: plain specific line, no icon-in-grey-circle [V: `empty-home-light.png`].

> **What this means:** the app feels like paper on a desk you can press, not like frosted glass pills floating on grey — and icons stay quiet so colour and motion carry meaning.

---

## 5. How AI shows up (no sparkle glyphs)

1. **Voice is the mark.** Summaries and Ask prose in Newsreader. Nothing else announces “AI”.
2. **Working:** slow opacity `breathe` on the placeholder line (0.55↔0.85 over 1.6 s). Stop the instant text arrives. Remove gradient “glimmer”, Ask pulsing blue dot, and red breathing record ring [V: baseline §4; Zero failures in SYNTH-ui §1 #9].
3. **Reason on request:** quiet “why” under focus card / summary, plain words + one quoted sentence from the thread; one-key corrections that write sender rules (Superlocal / Redakt / Avec learning pattern [V]). No confidence meters or model names in the main UI; provenance on hover (“Summary · Groq · …”).
4. **Drafts are ordinary text.** Insert editable; Tab accept; Esc discard; neutral controls. Polish as a side-by-side diff, never overwrite typed text (Redakt Smart Compose failure [V]).
5. **No key, no error banner.** Without a provider, reader leads with subject; one quiet Settings → AI line explains why (fixes “Couldn’t summarize” dominance [V: baseline §6.9 #10]).

> **What this means:** AI feels like a well-written letter sitting on the desk, not like a chatbot sticker. Space still does the smart action; the typeface does the branding.

---

## 6. Motion-token system and “input never waits”

### 6.1 Engineering rules (non-negotiable)

1. **State commits first.** Animation plays on a ghost or overlay. Focus moves to the next row in the same frame as triage (Inbox Zero [V: `ui/inbox-zero-mail.md`]; SYNTH-ui §1 #1).
2. **List holds still.** Rows below a removed row stay pinned during a burst; compact once after pause (Superlocal hold [V]; Redakt pointer hold — shorten for keys).
3. **Navigation is instant.** View switches ≤ 100 ms opacity or none. Drop baseline’s 4 px rise on every mailbox [V: baseline §4].
4. **Transform + opacity only.** No height/width/padding animation (today: triage exits, Ask dock width, tab indicator [V]).
5. **Interruptible / retargetable** from current drawn position (calendar already [V: `calendarMotion.ts`]).
6. **Rapid mode:** triage keys &lt; 300 ms apart → multiply `depart` / `fly` / `travel` by 0.5; skip staggers (Avec [V]).
7. **Reduced motion:** opacity ≤ 120 ms; no travel, flight, celebrate. Spinners stay.
8. **Theme switch:** disable transitions one frame (Redakt [V]).

### 6.2 Named tokens

Base scale kept: `--dur-instant` 60, `fast` 120, `base` 160, `slow` 200. Springs as (stiffness, damping, mass) → CSS `linear()` at build for CSS + WAAPI parity.

| Token | Timing | Curve | What | Where |
|---|---|---|---|---|
| `press` | 80 down / 140 up | out-strong | scale 0.97 (icons 0.94) + inset swap | Buttons, keycaps, rows |
| `hover` | 100 | `--ease` | bg/colour only; `(hover: hover)` | Rows, controls |
| `reveal` | 140 in / 100 out | out-strong / ease-in | opacity, 4 px from trigger, 0.98→1 | Menus, peeks; tooltips 140 first then instant while moving (Tatem) |
| `settle` | 180 in / 120 out | out-strong / ease-in | opacity, 8 px, 0.98, from anchor | Dialogs, ⌘K, composer from Compose button |
| `travel` | 140; **0** on key-repeat/pointer | out-strong | shared cursor layer | List cursor; Home focus glide 160; hover instant |
| `select` | spring 400/32/1 (~250 ms, ~1.5% OS) | spring | shared puck translate+scaleX | Sidebar, D/W/M, Ask/Today, Later groups, Settings nav (Tatem spring [V]) |
| `depart` | 120 (60 rapid) | cubic-bezier(.4,0,1,1) | ghost: translateX 28 px + opacity | Row leaving any list |
| `hold` | until 450 ms after last key, or pointer leaves (≤ 1.2 s) | none | pin rows below with transforms | Burst triage; arrivals while active |
| `close-gap` | 180 | out-strong | FLIP rows below | After hold |
| `fly` | 220 (120 rapid); commit fill ≤ 60 ms | ease-in (.5,0,.75,0) | card translate in action direction, lift 8 px, tilt **1.5–2°** (not 14°) | Done/Later/Bookmark; sent letter |
| `stamp` | 90 ms overlay | out-strong | solid `--hill`/`--dusk` wash + verb to ~70% in dark | Commit readability (Avec opaque flood lesson [V]; Aplos wash was 14–22% [V]) |
| `wind` | optional 180 ms | out-strong | single thin SVG arc, 12% opacity, once | Accompanies `fly` on Home empty path and send; skipped in rapid mode |
| `swap` | 120 overlapping | `--ease` | opacity + 12 px | Reader J/K double-buffer; Later groups |
| `arrive` | 200 | out-strong | opacity + 6 px drop; FLIP neighbours | New mail, sent in thread; deferred mid-burst |
| `dock` | 200 open / 140 close | out-strong / ease-in | **contents** transform after painting final dock colour; FLIP mail column | Ask/Today (fix strip-of-window bug without width animation [V: DECISIONS / SYNTH-ui §3.2]) |
| `follow` | spring 600/36/0.6 | spring | transform | Dragged row/card |
| `snap` | spring 300/30/1 | spring | transform | Sub-threshold swipe return; drop target 1.02 |
| `breathe` | 1.6 s loop | ease-in-out | opacity 0.55↔0.85 | Pending AI only |
| `status` | 1.5 s | ease-in-out | 30% segment in 2–3 px track | Sync bar; spinner only after 150 ms |
| `celebrate` | ≤ 400 ms, skippable | out-strong | sky opacity + scale 1.02→1 | Home empty, once per emptying |

Retire visible `--ease-spring` (~7% overshoot) except switch thumbs [V: baseline §4].

**Signature sequence — keyboard Done (E or →) on Home:**

1. Next item focuses **same frame**.
2. `stamp` hill fill + “Done” ≤ 60 ms.
3. Card `fly`s right and slightly up (icon tilt); optional `wind` arc.
4. Rows `hold`, then `close-gap` on pause.

Later: dusk stamp, fly left and slightly down. Pointer triage follows velocity into `fly`. Five quick E presses: half duration, list frozen, one tidy glide.

### 6.3 Budgets (tests)

- Triage key → focus change ≤ 1 frame.
- Cached open &lt; 100 ms.
- J/K buffered paint &lt; 50 ms.
- 10k-thread startup remains smooth (Superlocal-style gates [V]).

### 6.4 Enforcement

`aplos-motion` agent skill + lint: no literal durations/easings; no `transition: all`; no width/height/padding transitions; every `@keyframes` has reduced-motion; no raw hex.

> **What this means:** about eighteen named motions replace dozens of one-offs. Finishing mail feels like a letter caught by wind — memorable — while your fingers never wait and the list never jumps.

---

## 7. Screen-by-screen

### 7.1 Shell, sidebar, toolbar

- Every view gets a toolbar title (`title` token). Compose = pencil icon; `C` on hover.
- Sidebar order: Home, Later, Calendar | All mail, Drafts, Sent | Trash, Spam. Calendar leaves the footer; dock tab = **Today**.
- Footer status slot: sync states (discovering, importing N of M, paused, retrying, reconnect) — never a banner that pushes the list (Superlocal [V]).
- Sidebar selection = `select` puck; counts use a non-bouncy digit swap.
- Keep minimized sidebar; same puck in its menu.

### 7.2 Home

- Focus card: sender + relative date (no rainbow avatar); **serif summary** as the big line; Space action (verb + action icon + Space); icon-only Later, Done, ⋯ with keycaps on hover.
- Remove duplicate due badge when summary already says the due [V].
- Low importance: `--raised` bundle; sender groups; hover preview; unsubscribe when List-Unsubscribe lands; `→ →` mark-all-done (Avec behaviour, Aplos visuals [V]).
- Sections: Tab / ⇧Tab between New, Later-due, Waiting (Inbox Zero split cycling [V]). Literal labels in `--dim`.
- New mail during triage waits under `hold`, then `arrive`; quiet “2 new” on the New label.
- Fix Done-on-needs-reply staying on Home [V: baseline §6.9 #4] — see Decisions.
- Next-step toasts with keys: after Later “Set a date · D”; after Done awaiting reply “Remind me if no reply · R”.
- Guided clear-Home session (Superlocal two-phase idea [V]) with an original name — not Superlocal’s.

### 7.3 Later

- Name **Later** everywhere; remove Todo/Todos [V: baseline §6.6].
- Groups: Overdue, Today, This week, Someday; Bookmarks filter chip.
- Drag between groups to reschedule; labelled drop targets; snap to group date (Avec/Redakt [V]).
- Date picker presets on 1–5.

### 7.4 All mail (and Drafts / Sent / Trash / Spam)

- One-line rows at `base`; unread sender 600; read `ink-2`.
- Shared cursor `travel`; triage uses same `depart`/`hold`/`close-gap`.
- Bulk bar: plain verbs + keys; no second visual system.
- Empty: one literal sentence (“No drafts”) — no grey circle icon.

### 7.5 Reader

Order top → bottom:

1. Serif summary  
2. Sender (popover) + relative date  
3. Subject `title` 500 `ink-2`  
4. Body `read` in measure-wide paper  

Actions on the **paper’s bottom flap** (envelope metaphor): left = suggested Space action; right = Later ←, Done →, ⋯. Reply = **R**; hold R dictates. Undo → toasts/trays. Removes three “Reply” affordances and the 54 px Avec-like pill [V: baseline §6.2].

- J/K `swap` with double buffer; previous stays until next measured; 1.5 s deadline (Inbox Zero [V]); neighbours warm (Zero [V]).
- Wide back gutter with faint hover gradient (Superlocal [V]).
- HTML mail: sandboxed scriptless iframe on light paper; email’s own bg tint even in dark; plain text follows theme; remote images off by default [V: gaps HTML isolation; SYNTH-ui §4].
- Threads: collapsed one-liners + 3 px accent rail that `travel`s.
- “How you know them” history popover (local stats; labelled history not trust [V]).
- Importance + why → ⋯ / disclosure.

### 7.6 Compose

- New: paper `settle`s from Compose; post-edge top stripe.
- Replies: inline under thread by default (full Compose hides context [V]).
- Honest draft line: “Saving… / Saved / Couldn’t save · Retry”. Esc after Saved closes — fixes Saved-then-prompt [V: §6.9 #3].
- Send: composer `fly`s on a small arc (`wind`); thread gets tucked tray “Sending in 8 s · Undo · Send now” with stripe drain (Redakt placement [V]); **one** notice (fix duplicate toasts [V: §6.9 #2]); fix undo-send “Choose…” [V: §6.9 #1].
- Dictation: calm `--stamp` level meter at field edge.

### 7.7 Ask dock

- Closed by default on first run (today opens ~700 px blank [V]).
- Header: speech-bubble + “Ask | Today” on `select` puck; empty = recent chats with times (Avec behaviour, new chrome [V]).
- Answering: one steady step line → expandable dim step log with citations (Zero [V]); follow-ups queue as editable cards.
- Answers: serif prose; decisive fact medium weight.
- Proposals: Tatem-style key rows — consequence + “Add ↩” / “Not now esc” [V].

### 7.8 Calendar and Today

- Fix overlapping titles (min column, ellipsis, “+2”); add missing comma in day titles; no Delete on unsaved [V: §6.9 #6–8].
- Hour labels ≥ 11 px.
- `select` puck for D/W/M; keep FLIP and pinch.
- Event tints from icon-derived set; dashed outline for plans found in mail.

### 7.9 Search and ⌘K

- `/` = search. **⌘K = command palette** (overlay): context line for targeted mail; every command with keycap; nested settings breadcrumbs; number keys in short submenus (Tatem [V]).
- NL queries → removable operator tokens; server Gmail search on Enter only.
- Results: one-line rows; focus card only on targeted row.

### 7.10 Settings

- Page title; nav aligned with content (fix 74 px offset [V]).
- Descriptions state the effect in one line; longer copy behind disclosure.
- Destructive confirms = two-row key list.
- Plain voice: replace comfort marketing lines [V: baseline §6.8].

### 7.11 Onboarding window and first sync

- Welcome: one full-bleed generated sky (icon palette `#67ccff`→`#2a9afd`) with hill silhouette; paper card floating on desk-shadow — not Avec ocean, not stock video.
- First sync: segmented progress tied to engine checkpoints (recent listed, bodies, summaries); segments collapse to a drawn check (Tatem success idea, Aplos form [V]). Same component for “Account connected” and sidebar “importing N of M”.
- PR #21 onboarding is not merged and must not be merged by planners [V: CONTEXT]; this proposal specifies the *target* look for whichever window ships.

### 7.12 Notifications / toasts

- Bottom-centre stack ≤ 3; hover pauses. Plain 4 s; Undo 8–10 s then slow fade (Superlocal [V]).
- Wording follows op queue: pending / confirmed / offline.
- Undo at object for sends (tray); toast for triage.
- One meaning per notice.

### 7.13 Empty and error states

- Home empty: quiet generated sky + thin wind arc + hill; ≤ 400 ms; skippable; static if reduced motion; show count handled + next event; once per emptying. Not a 44 px grey tick [V: `empty-home-light.png`].
- Other empties: one specific sentence.
- Fatal / offline: paper card on desk with Retry; no assistant poetry.
- Sync errors live in the status slot.

> **What this means:** almost every screen keeps its job; the big visible changes are the reader flap (goodbye Avec bar), honest send/save, triage that does not jump, and three sky moments that finally match the icon.

---

## 8. Keyboard map

**One command registry** feeds `?`, ⌘K, tooltips, menus, toast keycaps.

| Area | Binding | Meaning |
|---|---|---|
| Global | A tap / hold | Open Ask type / dictate Ask |
| | ⌘J | Toggle Ask dock |
| | ⇧A | Today in dock |
| | / | Search |
| | ⌘K | Command palette |
| | C | Compose |
| | ⌘, | Settings |
| | [ | Sidebar |
| | ? | Shortcut sheet |
| | Z | Undo |
| | ⌃1…8 | Home, Later, All mail, Drafts, Sent, Calendar, Trash, Spam |
| Lists | J/K or ↑↓ | Move |
| | ↵ / O | Open |
| | **Space** | Suggested AI action |
| | E or → | Done |
| | L or ← | Later (←/→ behind setting — see Decisions) |
| | B | Bookmark |
| | R / hold R | Reply / dictate reply |
| | # | Trash |
| | X / ⇧X / ⌘A | Select |
| | . | More |
| | S | One-at-a-time stack from top |
| | Tab / ⇧Tab | Jump Home sections |
| Reader | J/K | Next/prev (buffered) |
| | Space | Same suggested action as lists |
| | R / hold R | Reply / dictate |
| Compose | ⌘↵ | Send |
| | hold Space (empty body) | Dictate |
| | Tab | Accept suggestion chip |
| Calendar | T / D W M / N / … | Existing map; keep |

**Grammar:** tap to act, hold the same key to speak it (A Ask, R reply). Space is never “reply” in the reader.

**Help sheet:** fixed height; alternatives joined with “or”; generated from the registry so it cannot omit ⌃5/7/8 again [V: §6.9 #5].

> **What this means:** every key means one thing everywhere, Space always does the smart action, and the help sheet cannot drift from the real bindings.

---

## 9. Accessibility

- All text token pairs meet AA as in §2; CI contrast gate.
- Distance fade never below 5.4:1 equivalent (ramp, not opacity floor).
- Focus rings: 2 px `--accent` outside controls; never removed for cosmetics (Superlocal anti-pattern [V: SYNTH-ui §5]).
- Hit targets ≥ 28 px; compact density still ≥ 24 px with enlarged hover.
- `prefers-reduced-motion` and `prefers-reduced-transparency` wired to tokens.
- Ask and summary announce via live regions when text arrives; breathe animation is decorative only.
- Colour is never the only Done/Later cue: verb label always present in `stamp`.
- Keyboard complete for every pointer path (Tatem four doors [V]).
- HTML iframe: title, no scripts, user font zoom respected where sandbox allows.

> **What this means:** the tactile look never trades away readable type, focus, or reduced-motion — beauty sits on top of those rules, not instead of them.

---

## 10. Owner taste checklist

| Taste | How Carried handles it |
|---|---|
| Docked Ask | Kept; closed by default; speech-bubble identity; serif answers |
| AI primary on Space | Space = suggested action on Home, lists, and reader |
| Big summaries | `summary` 20/28 Newsreader, identical on Home and reader |
| Sender-first reader | Sender + date above subject; subject demoted vs summary |
| Never sparkle/wand/star | Banned set + action icons only; no icon-label stars in UI |
| Loves Tatem / Avec feel | Borrow Tatem restraint + spring puck + ⌘K; borrow Avec commit clarity + rapid mode — **not** their look, words, or ocean |
| Own identity | Desk + letterstock + ink blue + hill + wind; post edge limited |
| Keyboard-first, calm | Instant nav; motion only on commits; one registry |
| Icon as brand | Materials and three sky moments from icon palette |

> **What this means:** every item on your taste list is preserved or strengthened; the only things removed are Avec lookalikes and generic AI chrome.

---

## 11. What NOT to copy

**Tatem** — Hold-Space peek (Space is AI here; use hold ⌥ if peek is wanted). Scroll-scrubbed hero theatrics without reduced motion; 160 px animated blur; abstract bars/dots/grids as empty art. Low-contrast text on gradients. Translucent-everything wallpaper inside a native Mac app (vibrancy already covers sidebar; glass = floating only). shadcn defaults left raw.

**Avec** — Warm-grey + white card + system blue + bottom pill cluster. Wording “Swipe through them”, “Hold to talk”. Sparkles. Default “Sent with” signature. Full-sat green floods on dark. Stock ocean video and sorting game. Needs-reply mailboxes and split view (already rejected). Marketing video weight and no dark mode on site.

**Zero** — Sparkles, purple borders, endless shimmer, pastel gradients, character-by-character blur drafts, summary behind a pill, floating translucent chat, red/green Accept-Reject, opt-in motion, toast-only undo, overloaded r/a, three colour systems, remote images on by default.

**Redakt** — Rainbow border beam; Generate overwriting typed text; every thread as a tab; fixed 1 s gap hold (too slow for keys); width/height composer animation; candy-orange loud compose; meaning-free rows; remote images on by default.

**Superlocal** — Any visual clone of Superhuman (charcoal/lavender, ink bar, “Get me to zero”, bolt glyph). Scraped fonts/icons. Contrast-filter instead of focus rings. Model/schema/score in user explanations. Single toast slot that eats Undo. Empty permanent right sidebar.

**Inbox Zero Mail** — Gmail-clone fixed sender column + chip run; list/split toggle; sparkle/wand on every AI entry; solid blue tooltips; stock dialog scale/slide; light-only chips; concept coloured two ways.

**Aplos baseline to drop** — Glimmer; rainbow avatars; icon-circle empties; glass pills everywhere; assistant microcopy; 3D reader fling; height/width/padding motion; view-rise transitions; pure-black dark; `--dim` 4.07:1 and 0.46 fade; keycaps always on; Space with four meanings; Todo/Later naming split; Ask-as-search icon.

**Naming** — Never public “Airmail”; never stripe-as-ring [V: identity audit].

> **What this means:** steal engineering discipline and restraint; leave every reference’s costume on the rack — especially Avec’s and the whole sparkle family.

---

## 12. Acceptance criteria (for later UI threads)

1. Side-by-side with Avec desktop frames: no shared bottom pill cluster; canvas hue family differs; no matching microcopy.
2. Token file defines §2 colours; CI contrast script passes; zero raw hex in `renderer/` components.
3. Newsreader (or documented fallback) on Home + reader summaries; no sparkle/wand/star in icon map tests.
4. Motion uses only named tokens; triage focus ≤ 1 frame; rapid mode halves fly/depart; reduced-motion path covered.
5. Reader actions sit on paper flap; Space = suggested action; R = reply.
6. `/` search ≠ ⌘K palette; registry drives `?` sheet with no missing ⌃ bindings.
7. Send produces one undo surface; draft Esc after Saved does not re-prompt; Home empty shows generated sky once.
8. Texture and glass pass packaged-app frame budget or auto-disable.

---

## Decisions for you

1. **Warm desk vs cool sky as the daily canvas?**  
   - **A (recommended):** warm desk `#ebe6df` / cream paper (this proposal). Sky only in welcome, sync-done, empty Home.  
   - **B:** cool cloud canvas daily (closer to website sky).  
   - *A feels more tactile and less like Spark/Canary skies; B matches the marketing site more literally.*

2. **Ink blue `#0b5394` or keep website `#0755dc`?**  
   - **A (recommended):** `#0b5394` in app and site together (clears Avec [V]).  
   - **B:** keep `#0755dc` and lean harder on paper/serif/hill for distinctiveness (medium Avec proximity).  

3. **Newsreader for AI voice?**  
   - **A (recommended):** ship with a one-week SF A/B toggle.  
   - **B:** SF only; “Aplos speaking” = raised paper nest.  
   - **C:** Newsreader with no A/B.  

4. **Done on mail that still needs a reply?**  
   - **A (recommended):** leaves Home; toast “Remind me if no reply · R”.  
   - **B:** stays under “Waiting on you” (current engine behaviour that feels broken [V]).  

5. **Arrow keys triage?**  
   - **A (recommended):** behind a setting, default off for new installs; E/L remain.  
   - **B:** keep ←/→ as today for swipe parity.  

6. **⌘K as overlay command palette?**  
   - **A (recommended):** yes; `/` stays search. Overlay ≠ toolbar nav.  
   - **B:** keep ⌘K as search alias only.  

7. **Reply keys?**  
   - **A (recommended):** R reply, hold-R dictate, Space = suggested action everywhere including reader.  
   - **B:** keep reader Space = reply (conflicts with your Space rule).  

8. **Naming: Later + Today?**  
   - **A (recommended):** “Later” everywhere; dock tab “Today”; Calendar = page only.  
   - **B:** keep Todo wording somewhere.  

9. **Texture on by default?**  
   - **A (recommended):** desk/paper noise on, with reduced-transparency and perf kill switches.  
   - **B:** flat colour only; elevation from shadow alone.  

10. **Public use of the word “airmail”?**  
   - **A (recommended):** never in UI/marketing; descriptive alt text only (“striped letter”). Get counsel if you want otherwise [V: identity audit §8].  

> **What this means:** the defaults above give you a tactile Aplos that clears Avec and Airmail collisions, keeps Space/Ask/summaries, and stays fast; any alternate still works if you prefer cooler chrome or less texture.

---

## Evidence index

- `research/email-clients/SYNTH-ui.md`; `research/email-clients/gaps/identity-collision-audit.md`
- `research/email-clients/ui/{aplos-baseline,tatem,avec,zero,redakt,superlocal,inbox-zero-mail}.md`
- Screenshots: `/Users/knewton/.t3/aplos-research/ui/aplos-baseline/{home,reader,empty-home,compose,toast-*,welcome-*}-*.png`; `tatem/hero-mock-flat-gradient.png`; `redakt/inbox-desktop-dark.png`; `avec/desktop-preview/`; `identity-audit/{icon-compare,icon-sheet}.png`
- Owner taste and overrides: `plans/_council/CONTEXT.md`
