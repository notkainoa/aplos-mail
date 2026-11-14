---
name: aplos-design
description: The Aplos Mail design system ("Paper") as rules an agent can follow. Load it before touching anything in apps/desktop/src/renderer or apps/web, before writing a component, screen, style, motion, key binding or user-facing string, and before reviewing UI work. It covers the principles, tokens, motion, input rules, components, Home's sections, how AI appears, voice and microcopy, forbidden patterns, where the mockups are and the definition of done.
---

# aplos-design v1.1: Paper

Paper is the internal name of Aplos Mail's design language. It never appears in the product. The product is **Aplos Mail**.

**Sources of truth.**

- `plans/DESIGN.md` is binding on rules, numbers and copy.
- `mockups/*.html` are the visual target. They win on arrangement and feel wherever DESIGN.md is silent. Each section of DESIGN §7 names its mockup files and states.
- `apps/desktop/src/renderer/ui/tokens.json` is the only place raw values live. It generates `ui/generated/tokens.css`, `ui/generated/motion.ts` and `ui/generated/contrast-pairs.json`. Never edit a generated file; change `tokens.json` and run `node apps/desktop/scripts/design/build-tokens.mjs`.
- `apps/desktop/src/renderer/ui/props.ts` holds the frozen component props. `apps/desktop/src/renderer/commands/` holds the command registry.

If this skill and DESIGN.md disagree, DESIGN.md wins. Say so in your report so the skill gets fixed.

## 1. The twelve principles (DESIGN §3)

1. Content sits on one white pane. Cards are only for the thing in hand.
2. Aplos speaks in a serif. Everything else is sans.
3. Input never waits. State commits on keydown, and the animation draws afterwards on a copy.
4. Navigation is instant. Motion is spent only on state changes: triage, send, arrival and selection.
5. The list holds still under your hands.
6. One accent and one filled button per screen. The topmost surface owns the filled button.
7. Meaning never rides on colour alone. It always has an icon plus a word.
8. Say plainly what happened, what is safe and what to do.
9. AI is content. It has no glyph, badge or glow.
10. No decoration. Type and space carry the identity.
11. Hovering never moves anything.
12. Fewer things on screen. Secondary actions live in ⋯ and ⌘K.

A change that needs a new colour, radius, motion, floating pill or ornament is wrong. Use what exists.

**The not-Avec test (DESIGN §2.3).** These checks run automatically on Home and the reader in both themes:

- the shell is cool-neutral (Lab b* < 0);
- the accent and Done colours are at least ΔE00 10 from Avec's;
- the summary line is serif;
- no primary button has a radius over 8 px;
- there is no floating bottom action cluster, no full-card colour flood and no decorative pattern;
- no banned phrase appears;
- the reader is one left-aligned reading column, never a centred card deck.

## 2. Tokens cheat-sheet (DESIGN §4)

Use `var(--token)` in CSS and the imports from `ui/generated/motion.ts` in TS. Never write a hex, `rgb()`, `hsl()`, literal px size, radius, shadow, z-index, duration or easing.

**Units (DESIGN §11.6, everything is in rem).** `tokens.json` keeps px as the source of truth and the generator emits rem (px / 16: 11 px is `0.6875rem`) for type sizes and line heights, spacing, controls, `--kbd`, rows, focus letters, layout sizes, icons and radii. Hairlines (0.75 px, 1 px), the icon stroke, `--focus-width`, `--focus-gap`, `--commit-edge`, `--select-bar`, `--thread-rail`, `--track`, `--seg-h`, tracking and shadows stay px, and so do the moves in `motion.ts`. The numbers in these tables are px. `ui/styles.css` is the one stylesheet: it imports `ui/base.css` (tokens, fonts, focus ring, selection, text wrapping) and then each family's CSS.

### Colour roles

| Token | Role |
|---|---|
| `--shell` | The window background. The sidebar sits on it, transparent. |
| `--canvas` | The one white pane: lists, the reader, compose, settings |
| `--paper` | Cards on the pane: focus letter, inline reply, proposal card, dialogs, menus, toasts. Lighter than the pane in dark. |
| `--raised` | Quiet fills: the low-importance band, chips, attachments, the undo-send line |
| `--sunken` | Keycaps, segmented tracks, fields |
| `--ink` | Primary text, unread senders |
| `--ink-2` | Read senders, subjects, unread summaries, secondary text |
| `--dim` | Metadata, timestamps, counts, placeholders, read summaries, disabled text |
| `--faint` | Non-text only, on the pane: disabled icons, dividers. On the shell use `--dim`. |
| `--line` / `--line-strong` | Hairlines / card and field rings |
| `--control-edge` | Checkbox, radio and switch-off edges only |
| `--accent` (ink blue) | Only: the one filled button, focus ring, cursor bar, links, today's date badge |
| `--accent-ink` | Text on an accent fill |
| `--accent-wash` | Bulk-picked rows only |
| `--hill` | Done and success, only where it means Done |
| `--dusk` | Later and paused sync, only where it means Later |
| `--stamp` / `--stamp-ink` / `--stamp-tint` | Danger fills / red text and failure icons / overdue chips. One red only. |
| `--fill-ink` | Text on hill, dusk and stamp fills |
| `--hover` / `--press` | Hover and press fills |
| `--puck` | Sidebar selection, the keyboard cursor, segmented thumbs |
| `--today-tint` | The calendar's today column |
| `--selection` | Selected text (set once in `base.css`). Opaque, the accent mixed into the pane, so selected text turns `--ink` at full contrast on any surface or fill. |
| `--scrim` | Behind dialogs and the palette |
| `--shadow-ink` / `--sheen` | Shadow base / the 1 px top sheen on dark panes and cards |
| `--press-hi` / `--press-lo` | The filled button's top inset highlight / bottom inset shade |
| `--tag-sky`, `--tag-hill`, `--tag-stamp`, `--tag-dusk`, `--tag-sand`, `--tag-ember` | Accounts, labels and calendars, as marks only. No account dot on rows (owner, 2026-11-13); the colour shows in the account picker and Settings → Accounts. |
| `--event-fill` | A calendar event's fill: its tag colour at this percentage (12 %, dark 20 %) |

Rules:

- Colour is rare. Everything else is gray, black or white.
- A read row is a 400 `--ink-2` sender and a `--dim` summary. An unread row is a 600 `--ink` sender and a 500 `--ink-2` summary, with no dot (owner, 2026-11-13).
- The keyboard cursor is `--puck` plus a 2 px accent bar on the leading edge. Never use opacity for text.
- Disabled text is `--dim` and disabled icons are `--faint`.
- Dark-theme large fills (the swipe underlay) are capped at a 70 % mix over paper. Small commit chips are solid.
- No avatars or monograms in mail, ever. The account switcher's monogram is the only one. EXCEPTION (owner, 2026-11-10, DESIGN §16): the reader email card and the one-by-one card show calm recipient monogram circles (`--raised` fill, `--ink-2` letter, `--paper` ring), never a remote avatar URL or photo; no other screen gains them.

### Type: ten roles, nothing else

| Role | Size / line | Face | Use |
|---|---|---|---|
| `caption` | 11/16 | SF 500 | Keycaps, chips, calendar hours. The floor: nothing is smaller. |
| `small` | 12/18 | SF 400/500, tabular (`--num-small`) | Metadata, timestamps, counts, sub-labels. Always `--dim`. |
| `ui` | 13/20 | SF 400/500; 600 for section labels | Sidebar, menus, controls, buttons |
| `base` | 14/22 | SF 400; 600 unread senders | List rows, settings rows, fields |
| `read` | 15/26, 64ch | SF 400 | Message bodies and the text you write |
| `title` | 15/22 | SF 600 | Card and dialog titles, the reader's sender, the calendar's date label |
| `heading` | 24/32 | SF 600 | Only the compose subject field, the search field and onboarding step titles |
| `display` | 30/38 | SF 600 | Welcome, inbox zero, the fatal error |
| `summary` | 21/31 | Newsreader 430 (dark 410) | The one big line, the same on the Home focus letter and in the reader |
| `answer` | 16/27 | Newsreader 400 (dark 390) | Ask answer prose |

- Use `font: var(--type-<role>)` with `letter-spacing: var(--track-<role>)`. Each `--track-<role>` adds `--track-boost`, which `base.css` sets to `--track-boost-lowres` (+0.005 em) on non-Retina screens.
- **Tabular figures.** The `font` shorthand resets `font-variant-numeric`, so `font: var(--type-small)` is always followed by `font-variant-numeric: var(--num-small)` in the same rule. Anywhere else numbers line up (keycaps, calendar hours, a count in another role), write `font-variant-numeric: tabular-nums` after the `font`. `base.css` only covers unstyled `time`, `kbd` and `table`.
- The serif stack is Newsreader, then its metric-matched fallback faces (New York and Georgia with size-adjust, in `assets/fonts/fonts.css`), then plain New York and Georgia: `--font-serif`. Also `--font-sans` and `--font-mono`.
- SF weights are 400, 500 and 600 only.
- **There are no page titles.** Section labels are `ui` 600 `--ink` with the count in `--dim`.
- The serif is only for words Aplos wrote. A pending summary shows the subject in SF until the real summary lands.
- The reader's subject line is `small` `--dim`, so it never outweighs the summary.
- Summaries use `text-wrap: pretty`. Display lines and headings use `balance`. `base.css` sets both: pretty on `p`, `li` and `.ui-summary`; balance on `h1`–`h6`, Text's `display` and `heading` variants and the `.ui-display` and `.ui-heading` hooks. A display or heading line in any other element takes one of those hooks.

### Space, size, layout

- **Spacing** is a 4 px grid: `--space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-5` 20, `-6` 24, `-7` 32, `-8` 40, `-9` 48, `-10` 64. `--space-half` (2) is only for nudging icons optically. Also `--gutter` 40 and `--group-gap` 32.
- **Controls:** `--control-xs` 24 (chips), `-sm` 28, `-md` 32 (default), `-lg` 40 (onboarding primary). `--kbd` is 18. Every hit target is at least 24 × 24.
- **Density** (Settings → General): row 48/40/34 and focus letter 196/180/164 for roomy, comfortable (the default) and compact.
- **Layout:**
  - Sidebar 232, transparent on the shell.
  - Pane inset 8 (`--shell-pad`), radius 12.
  - Pane header 48.
  - List column `min(720px, 100% − 2 gutters)` (`--list-w`). Sender column 152 (148 on Home).
  - Reader column 640 (`--reader-w`). The email sits in one card (subject top line, hairline, header row, body, attachments) by owner request 2026-11-10 (DESIGN §16); the summary stays big above it.
  - Composer page 640.
  - Ask dock 360 (320 under a 1180 px window, resizable 300–440).
  - Palette 600 wide, 16vh from the top, results at most 420.
  - Settings 180 nav + 600 content.
  - Toast up to 440.
  - Minimum window 900 × 600.

### Radius: six steps, no others

| Token | Value | Use |
|---|---|---|
| `--radius-xs` | 4 | Keycaps, the commit chip's icon well |
| `--radius-sm` | 6 | Chips, small controls, events, the commit chip |
| `--radius-md` | 8 | Buttons (including the filled one), rows, fields, menu items |
| `--radius-lg` | 12 | The pane, the dock, cards, menus, popovers, the palette, toasts |
| `--radius-xl` | 16 | Dialogs |
| `--radius-pill` | 999 | **Only** counts and search operator tokens. Never a button. |

### Elevation: rings and soft light, no glass

| Token | Use |
|---|---|
| `--elev-pane` | The pane, the dock |
| `--elev-card` | Focus letter, inline reply, proposal cards |
| `--elev-float` | Menus, popovers, tooltips, toasts, the palette (opaque `--paper`) |
| `--elev-dialog` | Dialogs and confirmations, with `--scrim` behind |
| `--elev-lift` | A dragged row or letter |
| `--elev-puck` | A segmented control's thumb |
| `--elev-thumb` | The switch thumb's small shadow |

### Layers: the only z-index values

| Token | Value | Use |
|---|---|---|
| `--z-sticky` | 10 | The pane header over content scrolling under it |
| `--z-dock` | 20 | The Ask dock and the sidebar while they slide |
| `--z-menu` | 30 | Menus and popovers |
| `--z-toast` | 40 | The toast stack |
| `--z-dialog` | 50 | Dialogs and confirmations, with `--scrim` |
| `--z-palette` | 60 | The command palette |
| `--z-tooltip` | 70 | Tooltips, over everything |

- `0` and `auto` stay literal. In TS, `layers` from `ui/generated/motion.ts` holds the same numbers.

- No `backdrop-filter`. No translucent surfaces. No texture or noise.
- **Press feel:** the filled button has a top inset highlight and a bottom inset shade. On `:active` they swap, and the button scales `--press-scale` (.97, icons .94).
- **Three button idioms only:** `filled`, `text`, `icon`.

### Motion: 23 named motions (DESIGN §4.8)

Durations come from `--dur-*` / `motion.ts`, curves from `--ease-*` and `--spring-*`. Animate only `transform` and `opacity` (and colour for hover). Each motion has a rapid value (triage keys under 300 ms apart) and a reduced value, both generated, so tokens neutralise themselves under reduced motion.

| Motion | When to use it |
|---|---|
| `nav` | 0 ms. View, mailbox, account and settings switches. There is no page transition. |
| `press` | Buttons, rows, keycaps: scale down 80 ms, up 140 ms |
| `hover` | Background and colour only, 100 ms, only under `(hover: hover)` |
| `cursor` | The one shared list-cursor layer, 120 ms (Home focus 160); 0 on key repeat and pointer |
| `reveal` | Menus, popovers, tooltips: opacity + 4 px + scale .98. Instant for 600 ms after one closes. |
| `settle` | Dialogs, the palette, proposal cards, the inline reply card |
| `slide` | The one shared `Puck` per group: translate + scaleX, never width |
| `commit` | The commit edge and commit chip on Done, Later or Trash |
| `carry` | A ghost row leaving any list: ±28 px and fade |
| `flight` | A ghost focus letter or reader column on commit: ±96 px, ∓12 px, ±2° |
| `deal` | The next letter's content into the fixed Home focus slot |
| `hold` | Pins rows and section labels during bursts and while the pointer is over the list |
| `close` | The FLIP of rows below once `hold` releases |
| `swap` | Reader J/K (double-buffered), Later groups |
| `arrive` | New mail, a sent message in its thread, Ask cards (deferred while held) |
| `dock` | The Ask dock and sidebar: slide the contents, FLIP the main pane, never animate width |
| `undo-send` | The neutral 2 px drain under a sent message. Static text countdown under reduced motion. |
| `lift`, `follow`, `snap` | Drag and swipe springs |
| `thumb` | The switch thumb's spring, the only one that visibly bounces (a token extra, not one of DESIGN's 23) |
| `breathe` | Pending AI lines only, at most 3 on screen |
| `status` | The current first-sync step. Spinners only after 150 ms. |
| `count` | Sidebar count digits |

- **Signature, "carried off" (§4.9).** Keyboard Done commits at frame 0 and focus moves. Then a 3 px `--hill` edge grows and a solid "Done" chip appears (`commit`), and a ghost of the letter flies right and slightly up with a 2° tilt (`flight`). The body is never flooded with colour.
  - Later is the same move in `--dusk`, flying left and slightly down.
  - Rapid mode halves durations. From the fourth key in a second, the flight becomes a `carry`.
  - Send has no flight.
- **Theme switch:** disable every transition for one frame.

## 3. Input never waits: the 17 rules (DESIGN §5)

1. **Commit on keydown.** Update the store synchronously, then call the engine optimistically. Key-to-state ≤ 8 ms p95.
2. Focus moves with state, in the same event. Five J presses within 200 ms land five rows down.
3. **Animate a ghost, never the model.** Clone with fixed geometry, remove the real element at once, and animate the clone with WAAPI. React never re-renders per frame. At most three ghosts; a fourth finishes the oldest.
4. Keys are never dropped. A capture-phase queue replays keys that arrive during a mount or transition.
5. Interrupt means finish or retarget. A new key finishes a running ghost. A gesture continues from the drawn value and velocity.
6. **The list holds still.** New mail and re-ranks wait under `hold`, then `arrive`. An emptied section label stays, showing 0, until `hold` releases.
7. **Never animate layout:** no `width`, `height`, `padding`, `margin`, `inset` or `font-size`. The focus letter has a fixed height (a card with no summary coming fits its content, 2026-11-13). Rows close with FLIP. The reader double-buffers.
8. Navigation is instant.
9. Prefetch on intent: after 80 ms of keyboard focus or 120 ms of hover, prefetch the body and both neighbours. Cancel if you move on.
10. Double-buffer the reader. The previous letter stays until the next is laid out (1.5 s deadline), then a 12 px "Loading …" line appears. Never a blank pane.
11. Optimistic writes are durable. Undo is the inverse operation. A rejected write returns the row to its place with an inline error and Retry.
12. No spinner for local reads, and none under 150 ms for remote ones. After that, show one quiet indicator in place, never a modal.
13. Nothing over 50 ms on the renderer main thread. Batch IPC per frame.
14. `will-change` only while animating, set and removed by `motion.ts`. Lists are virtualised with fixed row heights.
15. Suspend loops, timers and springs when the window is hidden. Stop springs on `pointercancel`.
16. **IME-safe.** Never act while `isComposing`. Use `event.key`, not `keyCode`. Single-key shortcuts are off in text fields. Ignore Caps Lock.
17. **Hover never changes layout.** Hover may change colour and fill, nothing else.
    - It never reveals an inline keycap, never reflows a row and never moves a neighbour.
    - Row hover actions overlay the date column.
    - Key hints live in tooltips, in badges while ⌘ is held, and in the "Show all key hints" setting.

**Budgets** (packaged build, 10k threads):

| Interaction | Budget |
|---|---|
| Triage key → state | ≤ 8 ms p95 |
| Triage key → next paint | ≤ 16.7 ms p95 |
| 10 E presses in 2 s | No dropped key, one `close` |
| Cached letter → first body paint | < 100 ms |
| J/K with a prefetched neighbour | < 50 ms |
| Palette open / filter one keystroke | < 50 / < 16 ms |
| Cold start → shell painted / Home interactive | < 800 ms / < 1.5 s |
| Scroll 10k rows | No frame over 16.7 ms |

## 4. Components: compose, don't invent (DESIGN §6)

Every screen is built from the components in `src/renderer/ui/`, with the props frozen in `ui/props.ts`.

- Screens never style their own controls.
- If you need something that isn't there, use the closest component. If it truly doesn't exist, stop and raise it. Don't add a one-off.
- Variants are closed unions. There is no prop for a raw colour, size, radius or duration.

The parts list:

- **Surfaces:** `Pane`, `PageHead` (page-level controls on the right; never a title), `NavHead`, `Menu`, `Popover`, `Dialog`/`Confirm`, `Puck`, `Toast`/`ToastStack`.
- **Buttons and keys:** `Button` (`filled` | `text` | `icon`; 28/32/40), `Kbd`, `Tooltip` (label plus keycaps from the registry; this is where key hints live).
- **Lists:**
  - `ListRow`: fixed height per density, no avatar, hover actions over the date column, and a Done stamp-column option.
  - `SectionHeader`, `FocusSlot`/`FocusLetter`, `LowBand`.
  - `CommitChip`/`CommitEdge`, `Chip` (due, label, operator).
  - `EmptyLine`, `ErrorLine`.
- **Reader:** `ReaderHead`, `Summary`, `EarlierMessages`, `ReplyStub`, `Why`, `UndoTray`.
- **Compose:** `Composer`, `InlineReply`, `RecipientField`, `DraftState`, `Suggestion`, `LevelMeter`.
- **Ask, palette, search:** `AskDock`, `AskTurn`, `StepLog`, `Citation`, `ProposalCard`, `Palette`, `SearchField`, `OperatorToken`.
- **Calendar:** `MiniMonth`, `CalendarList`, `CalendarGrid`, `EventBlock`, `PlanOutline`, `NowLine`, `DatePresets`.
- **Settings:** `SettingRow`, `ProviderTable`, `KeyRecorder`.
- **Status:** `StatusSlot` (the only place sync status lives in the main window), `ReconnectSheet`, `ProgressSegments`, `FatalScreen`, `Spinner`.
- **Controls:** `Switch`, `Checkbox`, `TextField`, `ShortcutSheet` (generated from the registry).

These never exist: `PostEdge`, `SkyScene`, `MarginRail`, `Flap`, `Letterhead`, a reader avatar, glass or pill buttons, icon-in-a-grey-circle empty states.

**Commands.** Every action is declared once in the `CommandRegistry` (id, label, icon, keys per context, undo, confirm). Keys, the palette, menus, tooltips, the shortcut sheet and toast keycaps all read it. Never bind a key in a component. Never write a keycap string by hand where a command id exists.

- Places use ⌃ + a number.
- Verbs are letters.
- **Space is always the suggested action.**
- R replies, E is Done, L is Later, ⌥↑ / ⌥↓ move a thread up or down a lane, Z is undo.
- → / ← triage only on Home, one by one and the reader.
- Tap acts on keydown; holding R or A upgrades the tap to dictation (250 ms).

### Ownership: who does what

- **Components own their timing and focus.** `Toast` picks 4 s or 8 s (undoable) and its fade from `motion.ts`, `Tooltip` its delays, `Spinner` its 150 ms wait. A screen never passes a duration and never moves focus to a toast, tooltip or status line.
- **The shell owns the singletons.** It mounts the one `ToastStack`, the key-hint providers (`KeyHintsProvider`, `CommandKeysProvider`), the sheet host and the key listener. A screen never mounts its own `ToastStack`. It pushes `ToastData` with `pushToast` from `renderer/shell`.
- **The registry owns behaviour.** A key, a click and a palette run all go through the same command handler, so the handler raises the toast, not the click. `Button commandId=…` only shows the keycap.

### Command ids you will use most

| Id | Key | Use |
|---|---|---|
| `mail.suggested` | Space | The suggested action (the filled button) |
| `mail.reply` | R (hold: dictate) | Reply |
| `mail.done` | E, → on Home/one-by-one/reader | Done |
| `mail.later` | L, ← on Home/one-by-one/reader | Later |
| `mail.setDate` | D | Set a date |
| `mail.trash` | # | Trash |
| `mail.remindIfNoReply` | R while its toast shows | Remind me if no reply |
| `app.undo` | Z | Undo the newest operation or local change |
| `app.palette` | ⌘K | The palette |

The full list is `renderer/commands/catalog.ts`. Read a command's label and its `undo.label` (the confirmed toast text) from the registry; don't retype them.

### Recipe: a toast with Undo (DESIGN 7.13)

```tsx
// Inside the mail.later handler, after the optimistic write:
pushToast({
  id: opId,                                   // one operation, one notice
  kind: 'later',
  message: registry.get('mail.later').undo.label, // "Moved to Later"
  actions: [
    { id: 'setDate', label: 'Set a date', commandId: 'mail.setDate' },
    { id: 'undo', label: 'Undo', commandId: 'app.undo' },
  ],
  undoable: true,                             // 8 s life; Toast owns the timing
});
```

- The wording follows the op queue: "Archiving…" while pending, then "Done · Undo Z". With a destination it reads "Moved to Later · Set a date D · Undo Z". Offline it reads "Saved here · will sync".
- An Undo toast is never silently replaced. A second move adds a second toast; the stack holds three, oldest first out. Never filter out an earlier toast.
- No toast for navigation, successful saves or sync ticks. Sends use the `UndoTray` at the message, not a toast, unless no thread is visible.

## 5. Home, AI, voice

### Home (DESIGN §7.2)

The sections, top to bottom:

1. **Do now.** New mail with a clear action for you. **Back from Later** is a sub-label at its bottom, with "Clear from Home".
2. **Important updates.** Worth seeing, nothing to do. Space is Done.
3. **Low importance.** One `--raised` band: the label, up to three sender names in `--dim` with "and N more", and the count on the right. Return opens the sheet.
4. **Follow up** (last). Mail you sent with no reply after 3 days. Space is "Reply with a nudge".

How Home behaves:

- **Do now order:** the due band first (overdue or today, tomorrow, within 7 days, later or none), then important before normal, then the soonest due, then the newest.
- **Sorting rule:** respond → Do now; only need to see it → Important updates; don't need to see it → Low importance. It is decided by the conversation, never the sender.
- The focus letter is a fixed-height `--elev-card` (it fits its content when no summary is coming). It holds the meta line, the serif summary (two lines at most on Home; while it is being written, a quiet two-line placeholder with "Summarizing…") and the action row: the filled suggestion with its Space keycap, then Later and Done as text buttons, then ⋯. There is no subject.
- Empty sections don't render, except while held.
- The sidebar count is Do now plus Important updates.
- With no AI, rows show the subject, the focus letter shows the subject at `summary` size in SF, and there is no error.

### How AI appears (DESIGN §9)

- **The serif is the mark.** No glyph, badge, label, colour or glow says "AI".
- Suggestions wear their action's icon (reply, calendar, link, paperclip, cart, phone, file) and a literal verb: "View invoice", "Reply with times", "Add to calendar".
- **Working:** the subject in SF, breathing in `--ink-2`. No shimmer, glimmer, gradient, pulsing dot, typewriter or per-character blur.
- **Reasons on request:** "Why it's here" (⋯ or I) gives one sentence, a quote, and ⌥↑ / ⌥↓.
- **Provenance on hover only:** "Summary by Groq", "on this Mac", "from the email".
- **Drafts** are dim, editable suggestions (Tab keeps, Esc dismisses). Polish is a diff that never overwrites. Nothing sends or writes to the calendar without a confirmation row.
- **Absence is quiet.** No error on the mail surface; one line in Settings → AI.
- Groq is the default provider for every AI feature.

### Voice and microcopy (DESIGN §10)

- Say what a thing does, not how it feels.
- Buttons are verbs ("Send", "Reconnect"), never "OK".
- **No exclamation marks.**
- Errors say what happened, what is safe and what to do. They never show a raw provider error or a stack trace; map reason codes to DESIGN §7.15's copy.
- Summaries are third person, with the action and date folded in.
- This applies to every string, including `aria-label`, `title`, `placeholder` and tooltips.
- Home's labels are literal: "Do now", "Back from Later", "Important updates", "Low importance", "Follow up", "Reply with a nudge", "Go one by one", "Clear from Home".

| Never | Use |
|---|---|
| "Swipe through them" | "Go one by one" |
| "Hold to talk" | Tooltip "Hold R to dictate a reply" / "Hold A to dictate" |
| "Todo", "Todos", "Moved to Todo" | "Later", "Moved to Later" |
| "Hide all" | "Clear from Home" |
| "Ready when you are" / "Waiting on you" / "No reply yet" | "Back from Later" / "Do now" / "Follow up" |
| "Ask me anything" | "Ask about your mail or calendar" |
| "All clear for now" | "You handled 12 emails." |
| "Making room for your mail…" / "Aplos needs a moment." | No loading screen / "Aplos can't reach its mail engine." |
| "Couldn't summarize this email" | Nothing; the subject shows |

Other banned words: "Be here now", "Sent with", "magic", "AI-powered", "Copilot", "smart" as a label, "Beta" badges.

Empty states are one plain sentence plus at most one action (DESIGN §7.14). Error copy is in DESIGN §7.15. Status-slot copy is in DESIGN §7.1.

## 6. Forbidden, in every form

- **Glyphs:** sparkle(s), wand(s), star(s), `apple.intelligence`, brains, robots. That includes the Lucide `Sparkles`, `Sparkle`, `Wand`, `WandSparkles`, `Stars`, `Star`, `Brain` and `Bot`, emoji such as ✨⭐🪄🤖🧠, and anything for the menu-bar item. Bookmarks use `bookmark`. Ask uses a speech bubble, not the magnifier.
- **Decoration:**
  - the sky, sky gradient, hill or wind-arc art, the airmail stripe, par-avion labels, postmarks, stamps-as-art, planes;
  - any gradient or `backdrop-filter`;
  - texture, purple gradients, rainbow or animated borders, shimmer;
  - the app icon anywhere in the UI.
- **Avec patterns (DESIGN §13):**
  - the floating bottom action cluster and the big Reply pill;
  - the deck with the next card's sliver;
  - "Important ▾" as a bare dropdown in the reader header (the reader card's Importance menu with "Always do this for [sender]" and Undo is allowed by owner request 2026-11-10, DESIGN §16);
  - the 3D toss (`rotateY`);
  - full-card colour floods;
  - a count badge plus a comma list for low importance;
  - the warm canvas;
  - pill buttons with inline keycaps;
  - the armed bar growing;
  - the old classes `dock-pill`, `deck.has-next`, `low-line`, `post-edge`, `airmail`, `skyscene`.
- **Layout and motion:** page titles, hover that moves anything, keycaps revealed on hover, animated `width`/`height`/`padding`/`margin`/`inset`/`font-size`, `transition: all`, page transitions, skeleton loaders for local data, spinners before 150 ms, typewriter text.
- **References:** never copy code, assets, icons, illustrations, wording or exact layouts from Avec, Tatem, Notion, Notion Calendar, Redakt, Zero, Superlocal, Inbox Zero, Airmail or any other app. They inspire principles only.
- **Data:** no real mail, addresses, tokens or keys in fixtures, screenshots or PRs. Use original demo data.

## 7. Where to look

| Screen | DESIGN | Mockup |
|---|---|---|
| Shell, sidebar, status slot | §7.1 | every page; `errors.html`, `demo.html` |
| Home | §7.2 | `home.html` (default, no-ai), `demo.html` |
| Later | §7.3 | `later.html`, `later-picker.html` |
| Lists, Done | §7.4 | `inbox.html`, `done.html`, `empty.html` |
| Reader | §7.5 | `reader.html` (default, earlier, pending, no-ai) |
| Reply, compose | §7.6 | `reply.html`, `compose.html` |
| Ask, Today | §7.7 | `ask.html` |
| Calendar | §7.8 | `calendar-week.html`, `calendar-day.html`, `calendar-event.html` |
| Palette, search | §7.9 | `palette.html`, `search.html` |
| Settings | §7.10 | `settings-*.html` |
| Onboarding, first sync | §7.11-7.12 | `onboarding-*.html` |
| Toasts | §7.13 | `toasts.html` |
| Empty, errors | §7.14-7.15 | `empty.html`, `errors.html`, `fatal.html` |
| Keys | §8 | `shortcuts.html` |

To see a mockup headlessly, run `node mockups/shoot.cjs <page>`; add `HOVER=1` for the layout-shift check. Shots go to the gitignored `mockups/_shots/`.

## 8. Definition of done for a UI change

- [ ] The design lint is clean: `node tools/lint/design/run.mjs` (also part of `npm run lint` once wired). Only `tokens.json` and generated files are exempt.
- [ ] `node apps/desktop/scripts/design/build-tokens.mjs --check` and `node apps/desktop/scripts/design/check-contrast.mjs` pass if tokens changed. A new colour token declares its contrast pairs. A token change also updates this skill's token tables.
- [ ] `npm run test:visual` passes, including the hover-never-shifts check, or its baselines are updated with a written reason.
- [ ] `npm run test:perf` passes for the interactions you touched.
- [ ] Every new string passes DESIGN §10. There is one filled button per screen, and every icon button has a label.
- [ ] Keyboard paths have tests, and reduced motion is respected.
- [ ] Headless before-and-after screenshots in both themes, next to the matching mockup, are attached to the PR (`gh pr create --attach`), never committed. They use demo data only.
- [ ] `npm run typecheck`, `npm test` and `npm run check` are green.

## 9. Verify headlessly, never in a visible window

- Electron: Playwright's `_electron.launch` with `APLOS_TEST=1`, an isolated `APLOS_DATA_DIR`, windows created hidden, and `page.screenshot` / `recordVideo`.
- Browser preview: your own dev server on your own port with headless Chromium.
- Never move the real mouse, steal focus, raise a window or switch Spaces. If something truly needs the foreground, stop and ask.
- Capture the app's own window only. An agent looks at every image before it is posted.
