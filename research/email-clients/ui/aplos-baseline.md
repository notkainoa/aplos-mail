# Aplos Mail: current UI baseline audit for the revamp

2026-10-25. Source: worktree `t3-446a2f0a` at `72095ff Release v0.2.3`, the same commit as `/Users/knewton/.t3/projects/aplos-mail` (that repo was not touched). License: MIT (`apps/desktop/package.json`). I read `apps/desktop/src/renderer` (App.tsx, `ui/` primitives and tokens, `styles.css`, `styles/*.css`, `components/*`, Reader, Compose, Ask, Calendar, Settings). Then I ran the browser preview from the worktree (`npm run dev` with `APLOS_API_PORT=47317`, `APLOS_VITE_PORT=47173`, `APLOS_DATA_DIR` pointing at a throwaway `/tmp` folder, and every AI key variable unset). I drove it with headless Playwright at 1440x900 and captured each state in light and dark by switching `prefers-color-scheme` on the same page. The 156 screenshots are in `/Users/knewton/.t3/aplos-research/ui/aplos-baseline/` and the scripts are in `/Users/knewton/.t3/aplos-research/tools/aplos-baseline/`. I looked at every screenshot. The server is stopped and the data folder deleted.

**Evidence key:** **[V]** means I verified it in a file or a screenshot. **[I]** means it is my inference or opinion.

**Caveats**
- The browser preview is not the desktop app. On macOS desktop the sidebar is transparent and shows the native window material (`ui/tokens.css`). In the preview it paints `--sidebar-fill`, which in dark mode is a light grey slab (#484a4c).
- With no AI key, I could not show a streamed Ask answer, Ask cards or a live summary. Demo threads ship with written summaries, and Ask motion is described from CSS.
- All data is the built-in demo (Work and Personal, 17 threads, 6 calendars).

---

## 1. Verdict in one paragraph

Aplos already looks like a careful, restrained macOS utility, and the craft is real. It has optical tracking per size, exits that run faster than entrances, a registered `@property` to keep swipe frames cheap, reduced-motion handling, and good keyboard coverage. It does not yet look like *Aplos*. The icon is a bright, illustrated airmail envelope flying over a green hill under a blue sky. The app is warm grey with an electric iOS-style blue. Nothing in the UI comes from the icon. The parts that read as generic are the ones a model or a component kit would produce by default: an icon in a grey circle for every empty state, rainbow letter avatars, shimmering gradient text while AI works, glassy pills everywhere, and soft marketing microcopy ("A comfortable place for your mail."). The biggest product-level UI problems are:
- no sense of place, because no view has a title;
- key-cap noise on every control;
- overloaded meanings for Space, "Later", and "Calendar";
- low contrast created by the Home distance fade;
- a token system that exists but is mostly bypassed.

There are also ten concrete defects, listed in section 6.9.

---

## 2. Screens and dialogs

| Surface | How to reach it | Screenshot stem (`-light`/`-dark`.png) |
|---|---|---|
| Loading ("Making room for your mail…") | first paint | `loading` |
| Fatal ("Aplos needs a moment." + Try again) | API unreachable | `fatal` |
| Welcome: start, add account, AI key, microphone, "You're set" | first run per data folder | `welcome-start`, `welcome-add-account(-typed)`, `welcome-ai`, `welcome-mic`, `welcome-done` |
| Home (New, Low-importance line, Ready when you are, Waiting on you, No reply yet) | ⌃1 | `home`, `home-no-dock`, `home-dock-open`, `home-focus-third`, `home-row-hover` |
| Low importance | click the bundle line | `low-importance` |
| Later: Todos and Bookmarks tabs | ⌃2 | `later-todos`, `later-bookmarks` |
| All mail, Drafts, Sent, Trash, Spam | ⌃3, ⌃4, ⌃5, ⌃7, ⌃8 | `all-mail`, `drafts`, `sent`, `trash`, `spam` |
| Search (blank, results, no match) | `/` or ⌘K | `search-empty`, `search-results`, `search-no-match` |
| Reader, stack reader (S), find, sender card, more menu, attachment, plan | ↵ / O / S | `reader*`, `reader-stack-S` |
| Inline reply inside the reader | R | `reader-inline-reply` |
| Compose takeover, recipient suggestions, "Save this draft?" confirm | C, Esc | `compose-new`, `compose-recipient-suggest`, `compose-filled`, `after-compose-close` |
| Ask dock: suggestions, typing, no-key error | A / ⌘J | `home-dock-open`, `ask-typing`, `ask-no-key-error` |
| Dock "Calendar" tab (Today) | ⇧A | `dock-today` |
| Calendar week, week with dock, day, month, event card, quick new event, full editor | ⌃6, D/W/M, N | `calendar-*` |
| Settings: General, Mail, Calendar, AI, Notifications, Accounts, Help & about | ⌘, | `settings-*` |
| Keyboard shortcuts sheet (6 tabs) | ? | `shortcuts-*` |
| Menus: accounts, row "more" | sidebar, `.` | `menu-accounts`, `menu-row-more` |
| Bulk selection bar | X, ⌘A | `bulk-select`, `bulk-select-all` |
| Toasts: done, todo + due prompt, due set, undo, trash, stacked, undo-send | E, L, Z, #, ⌘↵ | `toast-*` |
| Empty states: Home, Later, Spam | after clearing | `empty-home`, `empty-later`, `empty-spam` |
| Tooltip | hover | `tooltip-ask-pill` |
| Mid-motion frame after E | 120 ms after Done | `motion-done-midflight-light` |

Not captured: pop-out windows, the attachment preview dialog, the Ask conversation and its cards (they need a key), the minimized-sidebar style, and narrow widths.

---

## 3. Design tokens (from `renderer/ui/tokens.css`, [V])

### 3.1 Colour

| Token | Light | Dark | Note |
|---|---|---|---|
| `--canvas` | #e5e4e1 | #000000 | Page background. Dark is pure black. |
| `--card` | #ffffff | #181716 | |
| `--raised` | #f3f3f2 | #222120 | Dark focus card uses this. |
| `--sunken` | #e5e4e1 | #2f2e2d | Used once. |
| `--line` / `--line-soft` | #d6d5d2 / #ebeae7 | #2f2e2d / #242322 | |
| `--ink` | #100f0f | #e6e4d9 | |
| `--ink-2` | #3f3e3d | #cecdc3 | |
| `--dim` | #6e6d6a | #878580 | |
| `--faint` | #9c9b99 | #6f6e69 | |
| `--sidebar-fill` | #e2e1de | #484a4c | Light is almost identical to canvas (1.03:1). Dark is lighter than the content. |
| `--blue` / `--blue-fill` | #0682fe / #0682fe | #3e9efe / #245aa6 | Dark primary buttons go dull navy. |
| `--green` / `--red` / `--amber` | #0a9c0a / #d33a2c / #ad8301 | #4fcf4f / #ff6b5e / #dfb431 | |
| `--ask-record` (ask.css) | #d6392c | same | Almost the same as `--red`, but a second token. |
| Hover / press | ink 5% / 10% | ink 6% / 11% | Built with `color-mix`, which appears 137 times in the CSS. |

The dark ink and neutral ramp (#100f0f, #e6e4d9, #cecdc3, #878580, #6f6e69) match the published Flexoki base values exactly. Flexoki is MIT. This is an observation; why they match is my inference. The neutrals are warm, and the one accent is an iOS-system-like blue. Calendar colours are a separate muted set in `engine/demo.ts` (#5b7fa6, #8a74b0, #4f9488, #c07a5a, #bf9638, #5f9a62), tinted 18% in light and 30% in dark (`styles/calendar.css`). Avatars are generated as `hsl(h 58% 42%)` over 13 hues (`renderer/bridge.ts`, `avatarColor`).

### 3.2 Type

- **Font:** system SF Pro (`-apple-system…`). There is no brand face and no monospace token: `--font-mono` is referenced twice and never defined.
- **Scale tokens:** xs 11/14, sm 12/16, md 13/18, base 14/20, lg 16/22, xl 18/24, 2xl 22/28. Tracking runs from +0.06 px at 11 down to −0.42 px at 22.
- **Weights in use:** 400 (19 times), 450 (2), 500 (74), 600 (39).
- **Adherence:** 156 font-size declarations use tokens. 31 literal declarations add 19 more sizes: 7, 8, 9, 10, 10.5, 11, 11.5, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22 and 28 px, plus 7 `font: 500 12px` shorthands.
- **Key real sizes:**
  - Focus-card summary: 18/24, weight 500.
  - Reader summary: 20/28, weight 500, −0.3 px.
  - Reader subject: 17/24, weight 600.
  - Body: 14 at 1.6 line height, max 70ch.
  - Welcome h1: 28/34, weight 600.
  - Calendar hour labels: 10–10.5 px.

### 3.3 Spacing, radius, size, layers

- **Spacing:** a 4 px grid, `--space-1..8`. It is almost entirely unused: 5 references against about 660 literal px values for padding, margin and gap. **[V]**
- **Radii:**
  - Tokens: xs 5, sm 6, control 8, md 10, card 12, sheet 16, pill 999. There are also `--item-radius` 7 and `--card-radius` 14 (focus card).
  - About 30 literal radii (1, 2, 3, 4, 11, 13, 17, 18, 20, 27, 28 px…).
- **Control heights:** `--control-sm/md/lg` (26/30/36) have 0 uses. Buttons are hard-coded at 28/30/32/34/36/38/40/44/54 px.
- **Layout:**
  - Sidebar 248 px (220 px under 1080).
  - Ask dock 360 px (320 px).
  - Toolbar 48 px.
  - Home and list column max 760 px. Reader card max 960 px. Settings 880 px. Composer clamps between 640 and 800 px.
  - List rows 40 px. The focus card has auto height.
- **Layers:** `--z-*` tokens exist, but most z-index values are literals: 0–7, 19, 20, 30, 60, 64, 65 and 115.

### 3.4 Elevation and material

The house material is "glass", built as stacked box-shadows:
- `--glass`: a 0.5 px ring, two soft drops, a bright inner top rim and a faint inner bottom edge.
- `--glass-raised`: deeper drops at 16 and 48 px.
- `--glass-primary`: a blue drop with inner highlights.
- `--card-edge`: a hairline plus a 1–2 px drop.

Floating surfaces use 84% card colour, `blur(16px) saturate(1.7)`, 12 px corners, a 5 px inset and 32 px items. Dialogs are opaque. There are 92 `box-shadow` declarations and 7 `backdrop-filter`s. The toolbar and the raised reader bar blur what scrolls under them.

---

## 4. Motion catalogue ([V] unless marked)

**Tokens:** `--dur-instant` 60, `--dur-fast` 120, `--dur-base` 160, `--dur-slow` 200, `--dur-dock` 200 ms. Easings:

| Name | Curve |
|---|---|
| `--ease` | (.2,.8,.2,1) |
| `--ease-out-strong` | (.16,1,.3,1) |
| `--ease-in-out` | (.65,0,.35,1) |
| `--ease-in` | (.5,0,.75,0) |
| `--ease-spring` | (.34,1.36,.64,1), about 7% overshoot |
| `--ease-release` | (.3,.7,.4,1) |

`ui/motion.ts` mirrors the durations for JS. Its comment says the tokens live in `ui.css`; they are in `tokens.css`.

**Inventory:**
- 56 `@keyframes` across about 3,000 lines of CSS.
- About 30 distinct literal durations beside the 5 tokens: 70, 90, 100, 140, 170, 180, 220, 240, 260, 270, 280, 300, 320 and 500 ms, plus loops of 0.8, 1, 1.2, 1.3, 1.4 and 1.8 s.

**Reduced motion:** every animation and transition is forced to 1 ms. Spinners are exempt.

| Area | What moves | Duration and easing |
|---|---|---|
| Buttons | Background, colour and shadow; press shrinks to .97 (icon buttons .92, round close .9) | 120 ms `--ease` |
| Tooltip | Fade + 3 px rise + scale from .97 | 120 ms out-strong |
| Popover and menu | Scale-in from .96 / scale-out to .97; chosen item blinks twice | 120 in, 100 out (ease-in); blink 90 ms in steps |
| Dialog | Backdrop fade; sheet rises 8 px from scale .97; closing fade and scale | 160 / 180 out-strong / 120 ease-in |
| Tabs | Sliding indicator (transform **plus width and height**) | 240 ms out-strong |
| Switch, checkbox | Thumb springs, and widens on press; check stroke draws | 160 spring; 160 + 30 ms delay |
| Counts | New digit drops in | 260 ms spring |
| Toasts | Rise 18 px from .96; stacked depth (−9 px, −4.5% per layer); leave 10 px down | 240 in / 200 restack / 160 out. Auto-dismiss 4.2 s, or 7 s with an action |
| Sidebar | Slides; the workspace FLIPs with WAAPI | 200 ms (.16,1,.3,1) |
| Ask dock | **Animates `width`** | Open 200 out-strong, close 120 ease-in |
| View switch | Every mailbox and tab fades up 4 px | 200 ms out-strong |
| Home focus | Card frame scales in from .985; actions follow with a 70 ms delay; FLIP glide between rows; boundary bump of 5 px | 220 / 260 / 300 ms (.2,.85,.25,1), 170 ms on key repeat / 320 ms |
| Distance fade | Row opacity steps .07 per row away from focus, floor .46 | 200 ms |
| Triage exit | Row slides 24% and fades by 55%, **then height collapses**; focus card goes 22% at 270 ms; swiped rows 220 ms; new rows open their height first | 200 ms ease-in-out |
| Swipe | Follows the pointer through registered `--swipe-x/p/f`; settles; flings; "armed" badge springs | 220 out-strong / 180 release / 260 spring |
| Reader | Card rises 8 px; returns from left, right or below; **fling out with `perspective(1400px) rotateY(±14°) rotate(±4°)`**; tinted overlay by action; hold-to-talk squeezes Reply to .94 | 220 / 170 / 200–240 ms ease-in / 300 ms |
| AI pending | Gradient light sweeps through summary text ("glimmer"); results fade up 4 px | 1.8 s linear loop / 200 ms |
| Ask | Step lines rise; the running step shimmers; blue dot pulses; streaming caret blinks; the recording field "breathes" a red ring; cards rise 6 px | 200 / 1.8 s / 1.4 s / 1 s steps / 1.8 s |
| Compose | Layer fades, card rises; closing fade; **shake on a blocked send**; "Saved" appears after a 200 ms delay; red glow while dictating | 180 / 220 / 150 / 500 ms / 160 / 320 ms |
| Undo send | 2 px bar drains linearly over the remaining delay | Linear |
| Calendar | View cross-scales (.985 in, 1.01 out); period slide and settle; FLIP of events; drag ghost lifts to 1.03; pinch zoom of hour height | 200/160 / 260 / 90 ghost / 120 lift |
| Settings, onboarding | Content rises 6 px; onboarding dots stretch | 200 / 160 ms |

### Motion critique [I]

- **Good:** exits are faster than entrances; swipe frames avoid style recalculation; the calendar's FLIP is transform-only and can be interrupted (`calendarMotion.ts`); keyboard repeat shortens the glide to 170 ms.
- **Too much, too uniformly soft.** Every ⌃-number view switch, reader open and settings tab spends about 200 ms rising into place. A keyboard-first app should make navigation feel instant and spend motion only on state change: triage, send, arrival.
- **Layout-property animation.** Triage exits collapse `height` and `padding`, the Ask dock animates `width`, and the tab indicator animates width and height. These are the likeliest sources of jank on a 10k-thread mailbox.
- **The reader fling is a card-game metaphor.** A 3D swing with a 14° rotation fits a dating app. Aplos's brief is "calm", and an airmail envelope would *fly off* rather than swing.
- **Contradictory motion after Done.** In `motion-done-midflight-light.png`, the next card glides up while the email just marked Done fades back into "Waiting on you" lower down. One gesture produces two motions that mean opposite things.
- **AI shimmer is the generic AI loading trope** (Zero does the same; see `zero.md`). A slow opacity breathe, or the subject in `--faint`, says "working" without the cliché.
- **Token bypass.** About 30 literal durations against 5 tokens means the app's tempo can't be retuned in one place.

---

## 5. Keyboard map ([V], `App.tsx` `keyboard()`, `components/Overlays.tsx`, Ask, Compose, Calendar)

| Context | Keys |
|---|---|
| Global | **A** tap to type in Ask / hold to talk; **⌘J** toggles Ask; **⇧A** opens Today in the dock; **/** and **⌘K** search; **C** compose; **⌘,** settings; **[** toggles the sidebar (or opens the menu when the sidebar is minimized); **?** and **⌘/** open the guide; **Z** undo; **⌃1** Home, **⌃2** Later, **⌃3** All mail, **⌃4** Drafts, **⌃5** Sent, **⌃6** Calendar, **⌃7** Trash, **⌃8** Spam |
| Lists | **J/↓ K/↑** move; **↵/O** open; **Space** runs the suggested action; **S** opens the stack from the top; **X** selects (**⇧X** range); **⌘A** selects all; **Esc** clears; **.** opens the more menu; **E** or **→** Done; **L** or **←** Later (direction can be swapped); **B** bookmark; **U** read/unread; **#** trash; **R / ⇧R / F** reply, reply all, forward |
| Reader | **J/K** next and previous; **Space** tap to reply / hold to dictate a reply; **←/→** triage; E, L, B, U, #, R, ⇧R, F as in lists; **⌘F** find; **Esc** back |
| Compose | **⌘↵** send; **hold Space** in an empty body to dictate; **Tab** accepts the suggested-reply chip; **⌘B / ⌘I**; **Esc** closes and asks "Save this draft?" |
| Ask | **↑↓** suggestions; **↵** ask or open; **⌘↵** searches all mail; **⌘N** new chat; **Esc** stops, then clears, then closes |
| Calendar | **T** today; **D/W/M** views; **J/→ K/←** period; **N** new; **↵** open; **E** edit; **⌫** delete; **Esc** cancels; **⌥-click** shows only that calendar; pinch or **⌘-scroll** zooms; two-finger swipe pages |
| Today dock | **←/→** step days; **T** today; **↵** adds the found plan; **Esc** "not now" |

**Problems**
- **Space has four meanings.** In a list it runs the AI action. In the reader, a tap replies and a hold dictates. In Compose it dictates. Onboarding teaches it as "Do what the email asks", but in the reader it does not do that. The owner wants Space to be the AI action in the list, so make the reader agree: Space runs the same suggested action there, and reply gets R.
- **Arrow keys are destructive.** ← and → triage in lists and in the reader, right next to the ↑ and ↓ that only move. One slip archives mail.
- **⌘K is not a command palette.** It is a second binding for search. A keyboard-first app with no palette pushes everything into memorised single letters and the help sheet.
- **The guide is incomplete.** It omits ⌃5, ⌃7, ⌃8, ⌘K and ⌘/, which the sidebar reveals on hover. Combos like "A ⌘ J" have no "or" between alternatives, so they read as a three-key chord (`shortcuts-general-light.png`). The sheet's height jumps between tabs.
- **No remapping and no g-sequences.** The `keys.s` assignment is also written twice in the handler.

---

## 6. Critique

### 6.1 Brand: the icon and the app disagree [V for visuals, I for judgement]

**The icon** (`apps/desktop/assets/icon-256.png`) is cerulean sky, cumulus clouds, white wind swirls, a white airmail envelope with a red-and-blue chevron border and a stamp, and a sunlit green hill. It is saturated, painterly, optimistic and nostalgic. Its source layers are named `Firefly (1).png`, `Firefly (3).png` and `Firefly_RemoveBackground.png` (`assets/AppIcon.icon/Assets/`), which suggests Adobe Firefly generation. I infer that from the filenames only.

**The app** is warm grey (#e5e4e1) or pure black, white cards, SF Pro, and one electric blue (#0682fe). None of the icon's ideas appear:
- no sky gradient;
- no airmail stripe;
- no green other than a saturated checkmark green (#0a9c0a);
- no clouds, paper or stamp.

The icon appears only on loading, welcome and About, at 72 px. The blue reads as "iOS system control", not "sky". The result is a competent but anonymous Mac utility wearing a children's-book icon.

**Moments where the brand is missing:**
- **Empty Home ("All clear for now").** The emotional peak of a triage app is a 44 px grey circle with a check (`empty-home-*.png`). This is the obvious place for a quiet sky.
- **Sending.** A generic toast with a 2 px blue bar, where the airmail chevron would make a natural progress motif.
- **Dark mode.** Pure #000 with warm greys. A night-sky blue-black would tie it to the icon, and pure black also hides the glass shadows.

### 6.2 Hierarchy and sense of place

- **No view has a title.** The top-left of the content area shows a ghost "Compose C" button. Your location comes only from the sidebar highlight and a 13 px section header ("New 3", "All mail", "Spam"). Settings has no "Settings" heading. The Calendar's "October 2026" is the only large title in the app.
- **The Ask dock is open by default** (`localStorage` decides; first run means open). It takes 360 px with three suggestions and about 700 px of blank panel (`home-dock-open-light.png`). The Today variant is a 6 AM–11 PM grid holding one event. Default it closed, or fill it.
- **Duplicate cues on the focus card.** The "by tomorrow" badge repeats the summary's own "by tomorrow". Each card row carries five controls and four key caps (Reply Space, B, Later ←, Done →, ⋯).
- **The reader shows "Reply" three times:** in the AI card, the 54 px dock pill (the largest element on screen) and the inline composer. "Hold to talk" appears twice in the inline reply. "Important ▾" sits top right where a title would be and reads like a heading, not a control.
- **Compose replaces the whole workspace** with canvas and a card. You lose sight of the thread you are writing about unless you use the inline reply.
- **Settings misalignment.** The nav column starts about 74 px lower than the first group (sticky `margin-top: 32px`, `settings-general-light.png`).

### 6.3 Density and space

At 1440 px the list column is 760 px, centred in about 1,190 px of workspace, so about 215 px of each side is empty. Home shows 9 items and roughly 250 px of empty canvas below. The reader card is 960 px wide, but the body stops at 70ch (about 600 px), so the right 40% of the card is blank. That calmness is intentional and the owner likes it. But at 1440x900, Aplos shows less mail per screen than Apple Mail or Superhuman while also wasting width. Better: a slightly wider column plus a narrower, centred reader card that matches the 70ch measure.

### 6.4 Typography

- **Good:**
  - Tracking tokens are tuned to SF Pro.
  - Tabular figures are used for times and counts.
  - `text-wrap: pretty/balance` is used.
  - The focus summary is one big line, as the owner asked.
- **Competing weights.** The reader's summary is 20/500 and the subject below it is 17/**600**. The heavier small line competes with the larger light one. The same summary is 18 px on Home and 20 px in the reader: close enough to look like a mistake, too far to look like the same object.
- **Size sprawl.** 19 literal sizes, including 7–10.5 px. Calendar hour labels, mini-month weekday letters and event times sit at 10–11.5 px in `--faint`. That is fragile on non-Retina external displays.
- **No typographic identity.** Everything is SF Pro at weight 500. One deliberate typographic voice for the AI summary, such as Apple's system serif (New York, `ui-serif`) at summary size, would give the "letter" feel the airmail icon promises without a glyph. This is an idea, not a finding.

### 6.5 Colour, contrast and dark mode (contrast computed from tokens)

- **Light `--dim` (#6e6d6a) on canvas: 4.07:1.** Below WCAG AA for body text even at full opacity, yet it is the summary colour of every read row.
- **The Home distance fade makes it worse.** It multiplies opacity down to .46: a read summary falls to **1.76:1** and an unread `--ink-2` summary to 2.28:1. The owner asked for the fade to be "subtle". A .46 floor is not subtle.
- **`--faint` (#9c9b99) on canvas: 2.18:1.** It is used for timestamps, hints, placeholders and footnotes.
- **White on primary blue #0682fe: 3.73:1.** That fails AA for the 13–14 px labels on Reply, Send and Start.
- **Light sidebar and canvas differ by 1.03:1**, so the sidebar edge depends on a 0.5 px shadow.
- **Dark mode:**
  - Pure black canvas.
  - Primary fill drops to a dull #245aa6, so buttons lose the energy they have in light.
  - In the preview, the sidebar is a #484a4c slab lighter than the content (`home-dark.png`).
  - The search highlight (amber at 28%) turns muddy.
- **Two reds** (`--red` #d33a2c and `--ask-record` #d6392c). One `--row-hover` token is defined but never used.

### 6.6 Consistency and naming

- **Later / Todo / Todos.**
  - The sidebar says "Later".
  - The tab says "Todos".
  - The reader dock says "Todo".
  - The toast says "Moved to Todo".
  - The bulk bar says "Todo".
  - The key is L.
- **"Calendar" means three things.** It is the sidebar footer link (the full page). It is the dock tab, which is really "Today" (the shortcut sheet says "Today in the dock", and the panel header says "Today"). It is also the top-right icon pill, whose tooltip reads "Your day beside your mail".
- **The Ask pill uses a magnifying-glass icon** (`Topbar.tsx`), the same icon as Search, which is a different feature.
- **Accounts have different names in different places.** The sidebar says "Work" and "Personal" (`accountName()` special-cases demo accounts), while Settings → Accounts, Calendar access and Notifications list "Alex Morgan" twice.
- **Empty-state headers are inconsistent.** Spam keeps its "Spam" header when empty; Home and Later drop theirs.
- **Three button idioms** (glass pills, flat ghost buttons, tinted chips) sit side by side with no rule for which to use when.

### 6.7 Motion quality

See section 4.

### 6.8 What reads as AI-generated or generic [I]

1. An icon in a grey circle with a title and a muted sentence, used for **every** empty state (Home, Later, Spam, Search, Bookmarks).
2. Letter avatars in a 13-hue HSL rainbow. On Home this makes a confetti column down the left of the focus card.
3. Gradient light sweeping through text while AI works (summaries, Ask steps).
4. Glass pills with inner top highlights on nearly every secondary control: an imitation of Apple's Liquid Glass applied without hierarchy.
5. Sonner-style stacked toasts at the bottom centre.
6. **Microcopy written in an assistant's voice:**
   - "A comfortable place for your mail."
   - "Aplos is ready when your day begins."
   - "Make light work of your inbox."
   - "A little less inbox. A little more life."
   - "Ready when you are"
   - "A few useful things"
   - "Making room for your mail…"

   Each is fine alone. Together they sound like an LLM wrote them. Settings descriptions should say what the setting does, not how it feels.
7. Trust disclaimers repeated as footnotes on the calendar rail, Settings → AI, Help & about, onboarding and Ask.
8. Key caps on every button rather than revealed on demand (the sidebar gets this right with hover hints; the cards don't).
9. A generated illustration as the app icon, paired with an off-the-shelf neutral UI.

### 6.9 Bugs and defects found

1. **Undo send shows "Choose…".** The default `undoSeconds` is 8 (`engine/demo.ts`), but the options are 0, 5, 10, 20 and 30 (`Settings.tsx`) (`settings-mail-*.png`). [V]
2. **Two toasts announce one send:** "Sending 'Saturday planting' in 8s · Undo send", plus a second toast, "Sending in 8 seconds. You can undo from the inbox." (`toast-pending-send-*.png`). [V]
3. **Compose shows "✓ Saved" and then asks "Save this draft?"** when you press Esc, with Delete, Keep editing and Save draft (`after-compose-close-light.png`). [V]
4. **Marking Done does not leave Home** when the email needs a reply. It moves to "Waiting on you", and the Home count drops by one but the row stays. Reaching the "All clear" state required "Clear Needs reply" from the ⋯ menu. [V]
5. **The shortcut guide is missing ⌃5, ⌃7, ⌃8, ⌘K and ⌘/.** [V]
6. **Calendar week: overlapping events become unreadable** ("1:1 …", "Dent…", "Layo…", "Write the" clipped without an ellipsis) at 1440 px, and worse with the dock open (`calendar-week-with-dock-light.png`). [V]
7. **The day-view title has no comma before the year:** "Sunday, October 25 2026". [V]
8. **The full event editor offers "Delete event"** for an event that was never saved (`calendar-event-editor-light.png`). [V for the visual; whether a draft record exists is unverified]
9. **`--font-mono` is used but never defined.** [V]
10. **Without an AI key, every newly synced message shows "Couldn't summarize this email · Groq isn't set up"** as the reader's top element (`reader-with-ask-dock-light.png`). For anyone who skips the key step, the most prominent element in the reader is an error. Show the subject and a quiet setup hint instead. [V]

---

## 7. Keep these

- The one-big-line focus card and the sender-first reader (owner taste, and they work).
- Exits faster than entrances, interruptible FLIP, and reduced-motion support.
- Calendar mechanics: pinch zoom, period swipe, drag to create, and the dashed outline for a plan found in mail.
- Ask proposals as cards that need a click.
- Sidebar key hints that appear on hover, a pattern worth extending.
- One shared material for floating surfaces, with opaque dialogs.
- No sparkle glyph anywhere (the owner's rule).

---

## 8. Recommendations for the UI workstream (ordered)

1. **Fix the bugs in 6.9 first.** They are cheap, and several (duplicate send toasts, the save prompt after "Saved", Done not leaving Home) undermine trust in the triage model itself.
2. **Make the icon the source of the palette.** Use a sky-blue accent, with a deeper sky for filled primaries so white text passes 4.5:1; hill green for Done; airmail red and blue only as a signature stripe in at most two places (the undo-send bar, the compose card's edge); paler, cloud-white light surfaces; night-sky blue-black instead of #000. Ship it as tokens and lint out raw hex.
3. **Give every view a title** in the toolbar's left slot, and move Compose to an icon.
4. **Fix contrast.** Raise the fade floor to about .7. Darken `--dim` to 4.5:1 and `--faint` to 3:1. Add a computed-contrast check for both themes to CI.
5. **Unify the vocabulary.** Pick Later *or* Todo, rename the dock tab "Today", give Ask its own non-sparkle icon, and name accounts the same everywhere.
6. **One meaning per key.** Space runs the suggested action everywhere and R replies. Put arrow triage behind a setting. Add a real ⌘K command palette, and generate the shortcut sheet from the same command table so it can't drift.
7. **Hide key caps until asked** (hover, focus, or while ⌘ is held). Keep one visible cap: Space on the primary action.
8. **Retime motion.** Make navigation instant or ≤120 ms opacity, and spend motion on triage, send and arrival. Replace the 3D fling with a short flight that suits an envelope. Move height and width animation to transforms. Fold the literal durations into the tokens, using the motion grammar `redakt.md` proposes.
9. **Brand the empty and success states.** Give "All clear" a quiet sky made in-house, not generated. Drop the icon-in-circle pattern elsewhere in favour of plain, specific copy.
10. **Rewrite microcopy plainly.** Settings descriptions should state the effect. Keep one privacy explanation, in Settings → AI.
11. **Typography pass.** Collapse to the 7 token sizes and drop everything under 11 px. Try a system serif for the AI summary only. Make the reader subject lighter than the summary.
12. **Density.** Widen the list column to about 840 px at 1440 px, centre a reader card sized to the 70ch measure, and default the dock closed on first run.

---

## 9. Open questions

- Should "Done but still needs a reply" stay on Home? The current behaviour is coherent in the engine but reads as broken in the UI. Separately, does the owner want "Waiting on you" at all, given they asked for no Needs-reply mailbox?
- Is the Firefly-generated icon final? If it changes, the palette work in recommendation 1 should follow the new icon.
- Should dark mode follow the desktop's vibrant sidebar on non-Mac targets (web preview, a future phone client), or get its own opaque sidebar token?
- Keep arrow-key triage for swipe parity, or move it behind a setting?
- Is a command palette acceptable to the owner, given they rejected toolbar navigation? A palette is an overlay, not navigation chrome.
