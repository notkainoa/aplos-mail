# Redakt: UI, motion and feel study for the Aplos revamp

2026-10-25. Sources:

- **Code.** A read-only clone at `/Users/knewton/.t3/aplos-research/src/redakt` (HEAD `92d310c`, 2026-09-28). Paths below are relative to that clone.
- **Live production site.** `https://redakt.app`, which shows the login and the onboarding wizard. I created no account and submitted nothing.
- **Live public demo.** `https://demo.redakt.app` runs `DEMO_MODE` plus `DEMO_SANDBOX_MODE` (`.railway/railway.ts`). Every visitor gets an isolated sandbox user with fixture mail. Sandboxes are capped at 128 and expire after 6 h idle (`packages/core/src/demo/sandbox-retention.ts`). Its send is an in-memory fixture write (`packages/core/src/demo/provider.ts`). Even so, the one reply I queued was undone inside the 30 s window. I reset the sandbox when I finished.

I drove both sites with headless Chromium only, at 1440×900 and 390×844, in light and dark. Screenshots, contact sheets and three WebM recordings are in `/Users/knewton/.t3/aplos-research/ui/redakt/`. Below, `ui/` means that folder. Labels: **[V]** means I verified it in code or on the live site, and **[I]** means it is my inference.

**License.** The repo is MIT (`LICENSE`) [V]. Redakt's UI work is steered by a vendored agent "skills" pack, `jakubkrehel/skills` (`skills-lock.json`, `.agents/skills/*`). The clone doesn't include that pack's license, so I treat it as unverified. Nothing below copies code, assets or copy text. I record values as observations.

The architecture is covered separately in `research/email-clients/arch/redakt.md`. That report's motion notes were partly wrong: the "sidebar indicator spring" is really a scale-up on the drop target during a drag (see §4).

---

## 1. Overall feel

Redakt is **calm, serious and quiet**, with a few concentrated moments of delight.

- **Restrained base.** Neutrals have zero chroma. There is one warm orange accent, and the only other colors are small folder-category hues. The type is 13 px Inter at weight 450, with wide gutters and almost no chrome in the reader (`ui/inbox-desktop-light.png`, `ui/thread-light.png`).
- **Where the fun lives.** Almost all the playfulness is in direct manipulation. Dragging a selection makes a little stack of cards that follows the cursor on a spring and arcs into a folder whose icon "opens." Archiving a row fades it and leaves a gap for a beat before the list closes up.
- **Audience.** It's for design-literate individuals who want a nicer Gmail, or mail on their own domain, without operating a server. It's a lean-back reading client more than a power-triage tool.
- **AI.** It sits in two clearly fenced places, Focus and Smart Compose. Both are opt-in, with a consent switch.

The overall impression is "Linear/Vercel-style web app applied to mail." It's handsome and coherent. In daily use it would feel thinner than its polish suggests, because keyboard and triage depth are minimal.

## 2. Layout and information architecture

**Shell** [V] (`apps/web/components/shell/app-shell.tsx`, `sidebar.tsx`, `workspace-tabs.tsx`; `ui/detail-sidebar-light.png`):

- **Window chrome.** A light-gray shell (`oklch 0.967`) holds a fixed **216 px left sidebar** and one white **pane** with a 14 px radius and a soft shadow. The shell has 8 px of padding around everything, so the pane floats like a sheet on a desk.
- **Sidebar, top to bottom:**
  - An account/mailbox switcher (globe icon plus address).
  - A glossy orange **New email** button with its `⌥N` hint printed inside.
  - An **Emails** group: Focus (only when AI Focus is on), Inbox, Unread, Sent, Archived.
  - A **Folders** group with counts, a `+` and colored two-tone folder icons.
  - Both groups collapse.
- **Workspace tabs.** Above the pane sits a browser-like tab strip. The **active tab merges into the pane** through SVG-clipped 19 px fillets at its bottom corners, like Chrome tabs (`apps/web/components/ui/tabs.tsx`).
  - The pane drops its top-left radius when the first tab is active.
  - Tabs come in four kinds: folder, thread, compose and settings. They persist (30 max) and reorder by drag or `⌥←/→`, with a screen-reader announcement.
  - A context menu offers bulk close: others, all, to the right, and *read* tabs (`packages/core/src/mail/workspace-tabs.ts`).
  - Settings is pinned as a tab (`ui/settings-light.png`).

**List** [V] (`components/mail/thread-list.tsx`; `ui/row-hover-light.png`, `ui/detail-rows-light.png`):

- **Rows.** Full-width single-line rows, 40 px tall with a 10 px radius. Left to right: checkbox, unread dot, sender (120 px column), subject + " — " + snippet, and a right-aligned date in 12 px tabular figures.
- **Read state.** It's carried by weight and ink: unread is 600 at full ink, read is 450 in muted gray.
- **Hover.** A 5%-ink background, and the date swaps for three quiet icon actions: mark read, archive, more.
- **Density.** Compact rows are 34 px. A two-line preview mode is 52 px, or 44 px compact.
- **Selection.** Selected rows **fuse into one continuous block**: adjacent selected rows drop their touching corner radii (`ui/inbox-selected-light.png`). The toolbar swaps its search icon for bulk actions.
- **Virtualization.** Lists above a threshold are virtualized, and those rows don't animate (`VIRTUAL_LIST_THRESHOLD`).

**Toolbar.** On the left: a select-all checkbox with a "choose which to select" chevron, then a search icon that expands inline into a pill and highlights matches in the list (`ui/inbox-search-light.png`). On the right: Filter (all, unread, with files) and Sort (newest, oldest, sender, subject) menus (`ui/menu-filter-light.png`).

**Reader** [V] (`components/mail/thread-view.tsx`, `message-card.tsx`; `ui/thread-light.png`, `ui/thread-welcome-full-light.png`):

- **No split view.** Opening a thread opens a **new tab**.
- **Header row.** The subject (15 px/600, −0.3 px tracking, measured), then Reply, Reply all and Forward as text-plus-icon buttons, archive, move, more, an "N messages" count, and previous/next arrows.
- **Message cards.** Messages stack as cards with a 24 px radius in a centered **720 px column**, grouped under centered date captions.
- **Body.** The body renders in a sandboxed iframe at 15/24 px with a 68ch measure (measured: 15 px, 24 px line height).
- **Reply area.** A segmented Reply / Reply all / Forward control sits under the last card. The reply composer opens inline beneath it (`ui/thread-reply-light.png`).
- **Old messages.** Earlier messages in a thread are not collapsed.

**Command palette.** None. I found no `⌘K`, no palette and no shortcut overlay anywhere in `apps/web` [V by search].

**Mobile, 640 px and under** [V] (`ui/mobile-inbox-light.png`, `ui/mobile-nav-dark.png`). The sidebar becomes a dropdown from an inbox glyph beside the tab strip. The pane goes edge to edge, and hit areas grow to 44 px. The tab strip stays, which is cramped at 390 px.

**How the inbox is framed.** The inbox is "a folder you browse," not "a queue you clear." The queue-like view is **Focus**: an AI grouping into five sections (needs my reply, has a deadline, waiting on someone else, informational, probably low priority). Each item is a card with a one-line *reason*, a 3-bar confidence meter with a percentage, a follow-up nudge ("no reply for N days") and a "reply ready" chip when a prepared draft exists (`components/focus/focus-view.tsx`; `ui/focus-light.png`).

## 3. Visual language

**Typography** [V] (`apps/web/theme/tokens.stylex.ts`, `src/styles/globals.css`; computed on the live demo):

- **Family and base.** *Inter Variable*, with Avenir Next and system fallbacks. The root font size is 13 px (81.25%) and the body weight is **450**, a deliberate half-step above regular.
- **Scale:**

  | Role | Size | Detail |
  |---|---|---|
  | Micro | 11 px | +0.04em; used uppercase for the wordmark |
  | Caption | 12 px | +0.01em |
  | UI and body | 13 px | line heights 1.45 and 1.55 |
  | Reading and title | 15 px | 1.6 |
  | Display | 22 px | −0.03em on the login headline |

- **Weights in use:** 450, 500, 550, 600.
- Dates and counts use tabular numerals.
- `text-wrap: balance/pretty` is applied to headings and lead text.

**Color** [V] (`globals.css`):

- **Neutrals.** A nine-step **hueless OKLCH ramp** (chroma 0). Light mode runs from ink at 0.141 to a white card at 1.0, on a shell of 0.967.
- **Dark mode** is not an inversion. The shell is 0.141 and the card 0.191, so the pane is *lighter* than the shell, and muted text lifts to 0.78.
- **Accent.** A single orange, `oklch(0.65 0.22 45)`, used for the compose button, checkboxes, focus rings and selection.
- **Unread** uses a separate blue dot.
- **Folders.** Six pastel category hues (rose, amber, green, blue, violet, neutral) with slightly dimmer dark variants.
- **Status colors.** Positive green and danger red get text, soft and solid variants.
- **Theming.** Dark is `prefers-color-scheme` with a `data-theme` override from Settings → Appearance (System/Light/Dark) (`ui/settings-appearance-full-light.png`).

**Surfaces and depth.** This is the most distinctive part of the system. It's a small lighting model in tokens [V]:

- **Rings, not borders.** A 0.75 px "ring" shadow replaces 1 px borders, so edges are hairline and antialiased.
- **Cast shadows.** Four alpha steps of shadow ink, near-transparent on light and near-black on dark.
- **Sheen for dark depth.** An inset top **sheen** highlight gives raised surfaces depth on dark, where cast shadows vanish. The CSS comments say this explicitly.
- **Raised fill.** A gradient that falls off over a *fixed 56 px* rather than a percentage, so a dialog and a 32 px button get the same top edge.
- **Elevation levels:** control, panel (ringless on purpose, so the tab join has no seam), card and overlay. There are also "lift" recipes for pressable pills.
- **Glassy controls.** The active sidebar item and the checkboxes are glassy lifted pills.
- **The compose button** is a glossy orange "candy" with seven stacked inset shadows (`ui/detail-sidebar-light.png`).
- **Filled black buttons** carry a subtle top highlight and bottom refraction.
- **Overlays.** Menus and popovers are glass: 96% surface, `blur(16px)`, 20 px radius (`ui/menu-row-more-light.png`).

**Radius scale:** 6, 8, 10, 14, 20, 24, full. **Spacing scale:** 4, 8, 12, 16, 20, 32, 48 [V].

**Iconography** [V]. Hugeicons free set at 15 px, stroke 1.5 (`components/ui/icons.tsx`). Custom **two-tone gradient folder icons** each carry a tiny glyph badge (`components/mail/folder-mark.tsx`). Avatars are blobs with two dot "eyes." **The web UI uses no sparkle:** Focus is an *eye*, and a wand icon is defined but unused (`aiWrite`). The iOS app does ship sparkle and wand glyphs. **On the web, AI is marked by an animated rainbow "border beam"** instead (§4).

**Density.** It's medium, and roomier than Gmail at the same 13 px. The list is information-sparse: one line per row, and nothing semantic (no summaries, no due chips) outside Focus.

## 4. Motion

**Underlying system** [V]:

- **Default transition.** Nearly every CSS transition is **150 ms `ease-out`**, applied only to named properties and gated behind `prefers-reduced-motion: no-preference`.
- **Structural curve.** Panels and "structural" changes use **`cubic-bezier(0.2, 0, 0, 1)`**, a strongly front-loaded deceleration.
- **Springs.** JavaScript springs come from `motion` v13. Several use "no-bounce" springs defined by duration.
- **Source of the values.** They match the vendored `better-ui` skill (`.agents/skills/better-ui/SKILL.md`). It prescribes exact numbers: press scale 0.96, icon swap scale 0.25→1 with a 4 px blur, spring duration 0.3 with bounce 0, a softer translate on exit than on enter, and suppressing transitions on theme switch. **The polish is a codified ruleset that the AI agents follow** (`AGENTS.md` "Interface skills").

| # | Animation | Properties and values | Purpose | Evidence |
|---|---|---|---|---|
| 1 | Login card deck | 10 small mail cards rise from y+64, rotated (final+6°), opacity 0 → final tilt. Spring 0.3 s, bounce 0. Delays come from a **random shuffle** spread over 2 s (~0.22 s apart). Hidden under 720 px. | Ambient "mail arriving" texture behind a sparse login | `components/shell/login-screen.tsx`; `ui/sheet-login-deck.png` shows cards popping in one by one from ~1.0 s to ~3.1 s |
| 2 | Press feedback | `scale(0.96)` on `:active`, with transform, background and color at 150 ms ease-out. Applies to buttons, icon buttons, tabs, close buttons, settings checkboxes. | Tactile click | `components/ui/button.tsx`, `icon-button.tsx`, `tabs.tsx` |
| 3 | Hover | 5% ink overlay on the background (8% when active). Solid buttons fade to opacity 0.88. 150 ms ease-out. Gated by `(hover: hover)`. | Affordance without movement | `button.tsx`, `thread-list.tsx` |
| 4 | Menus and popovers | Enter from opacity 0 and **translateY 8 px**; exit to **4 px**. 150 ms ease-out. | Light, directional appearance; exit softer than enter | `components/ui/menu.tsx`, `popover.tsx`; `ui/sheet-menu.png` shows a 3–4 frame entrance |
| 5 | Dialog | Backdrop opacity 150 ms. Panel enters from +8 px and exits to +6 px, 150 ms ease-out. | Modal arrival | `components/ui/dialog.tsx`; `ui/dialog-create-folder-light.png` |
| 6 | Compose modal | Opacity, transform, **width and height** at **180 ms `cubic-bezier(0.2,0,0,1)`**; +8 px in, +6 px out. Expand grows 640×560 to 960 px × full height by animating width and height. | Composer arrival and expand | `components/shell/standalone-composer.tsx`; `ui/sheet-compose.png` shows it settled within about 2 frames |
| 7 | **Row departure** (archive, move, trash) | Phase 1: opacity→0 and scale→0.985, **180 ms easeOut**. Phase 2: **gap held for 1.0 s**, then height→0 over **280 ms (0.2,0,0,1)**. `AnimatePresence initial={false}`. Off for virtualized lists. | Keep the next row from jumping under the cursor; show where the mail was | `thread-list.tsx` (`ROW_HIDE_DURATION`, `ROW_REFLOW_DELAY`); `ui/sheet-archive.png`: faded by ~0.24 s, gap until ~1.1 s, closed by ~1.4 s |
| 8 | Drag lift | Only **selected** rows drag, by mouse, after a 6 px threshold. A stack of up to 4 mini-cards (248×116) appears from scale 0.9 and opacity 0 on a spring (560/28/0.6). Cards sit offset 0, 7, 14, 21 px. A count badge pops from scale 0.6 (spring 520/25/0.65). The stack follows the pointer through a spring (**stiffness 760, damping 30, mass 0.55**). | Physical "picked up a pile" metaphor | `components/mail/thread-drag.tsx`, `thread-list.tsx` `prepareThreadDrag`; `ui/sheet-drag-drop.png` |
| 9 | Drop targets | During a drag **every valid sidebar target gets a background**. The hovered one scales to **1.025** (spring 560/27/0.65). The stack shrinks to 0.97, the pile compresses to 35% of its offsets, and the top card grows to 1.015. | Show where you can drop; confirm acceptance | `components/shell/sidebar.tsx` `SidebarDropNavItem`; `ui/sheet-drag-drop.png` (Finance, People, Personal and Projects all lit) |
| 10 | **Drop flight** | Quadratic Bézier **arc** from the pointer to the target center. The bulge is 22% of the distance, clamped to 32–72 px, and always arcs upward. It is sampled at 9 keyframes and played linearly over **420 ms**. Scale runs to **0.08** on a no-bounce spring; opacity holds until 76% of the flight, then fades. Escape cancels, and the move is announced to screen readers. | "Mail flies into the folder" | `thread-drag.tsx` (`dropFlightBetween`, `dropTransition`); `ui/sheet-drag-drop.png` frames #52–#56 |
| 11 | Folder-icon flap | The front flap scales on Y to **0.88** on hover and **0.76** when the folder is a live drop target; the badge drops 1 px. 150 ms (0.2,0,0,1). | Folder "opens" to receive | `components/mail/folder-mark.tsx`, `ui/nav-item.tsx`, `ui/menu.tsx` |
| 12 | Checkmark | The mark goes from scale **0.25 → 1**, opacity 0 → 1 and **blur 4 px → 0** in 150 ms (0.2,0,0,1). The box presses to 0.96. | Contextual icon swap | `components/settings/settings-ui.tsx` |
| 13 | Loading skeleton | Bones "breathe" in opacity **0.48 ↔ 0.8**, 1600 ms ease-in-out, looping. The shell paints immediately and the real shell replaces it with no double frame (`:has()` rule). | Calm loading with no shimmer sweep | `components/mail/loading-state.tsx`, `globals.css` |
| 14 | **AI border beam** | Third-party `border-beam` component, "colorful" variant on a 5 s loop at strength 0.35–0.7. It shows on the **active Focus nav item**, on the **Smart Compose trigger whenever it's idle**, around the composer while AI writes, and on the Focus setup illustration. | Marks AI surfaces | `focus-view.tsx`, `sidebar.tsx`, `components/mail/smart-compose.tsx`; `ui/sheet-beam-nav.png` shows a pastel pink/cyan/peach glow circling the pill |
| 15 | Focus setup illustration | Placeholder rows loop opacity 0.52→1→0.52 and x 4→0→4 over **6.4 s**, staggered 1.05 s, easeInOut with held keyframes. | Explains Focus before opt-in | `focus-view.tsx` `FocusSetupIllustration`; `ui/focus-setup-light.png` |
| 16 | Smart Compose ghost text | Gray inline completion fades in 150 ms. A request fires 220 ms after typing stops, or 100 ms after Enter. Tab accepts and Esc dismisses. | Inline continuation | `smart-compose.tsx`; `ui/smart-inline-light.png` |
| 17 | Undo-send tray | A "second sheet" tucked 20 px under the sent card, showing a countdown, Undo and Send now. Background and color transition 150 ms and turn green when sent. The window is **30 s**. | Undo without a toast | `components/mail/pending-send.tsx`, `packages/core/src/mail/use-pending-send.ts`; `ui/undo-tray-light.png` |
| 18 | Theme switch | All transitions are disabled for one frame while the theme flips. | No "smear" of 100 color transitions | `components/ui/theme-transitions.tsx` |
| 19 | Navigation | Hovering a link for **50 ms** preloads the route (`defaultPreload: "intent"`). On navigation, focus moves to the route's `h1`. There are no page transitions on web. | Perceived speed | `src/router.tsx`, `app-shell.tsx` |
| 20 | iOS (reference) | A named `Motion` enum: press (0.16 s, bounce 0.25), snappy (0.26 s), bar (0.34 s, 0.22), drawer (0.36 s, 0.1), entrance (0.5 s, 0.12), reflow (0.3 s, 0). Screens change with a **blur-fade** (10 px blur + fade), not a slide. Press scale is 0.9. | Purpose-named springs | `apps/ios/Redakt/Design/Motion.swift` |

**Reduced motion** [V]. A global CSS clamp sets every duration to 0.01 ms. JavaScript animations receive `{duration: 0}`, the drag skips its flight, and the beam is set inactive.

**Gaps** [V by search]. There's no web swipe triage, and no enter animation for new mail. There are no toasts; feedback comes from inline trays and live regions. There's no list-to-reader transition. Tab reorder doesn't animate; the dragged tab just dims to 0.55.

## 5. Interaction model

**Keyboard** [V] (`app-shell.tsx` ~L860–885, ~L1447–1470, ~L1762–1800; `workspace-tabs.tsx`):

- **The full set:**
  - `⌥N` composes.
  - `c` composes.
  - `⌘W` closes the tab.
  - In the list, `j`/`k` open the *first* or *last* thread. There is no list cursor.
  - In a thread, `j`/`k` go to the next or previous thread and `r` replies.
  - `⌥←/→` reorder tabs. `Esc` cancels a drag.
  - In the composer: `⌘↩` sends, `⌘B/I/U` and `⌘⇧S` format, and Tab accepts a suggestion.
- **Settings.** Single-key shortcuts can be switched off.
- **Missing.** No archive key, no command palette, no help overlay. Hover actions and drag are the primary triage paths.
- **Accessibility is thorough.**
  - Live regions announce selection, moves and tab reorders.
  - An input-modality flag hides focus rings after pointer use and restores them on keyboard use (`globals.css`, `components/ui/input-modality.tsx`).
  - There is a skip link, `aria-keyshortcuts` attributes, and 44 px targets on touch.

**Triage flow** [V]. Hover a row, then archive, mark read or open more. Alternatively, select rows (they fuse into a block) and drag them to a folder, or use the bulk toolbar. A departure plays animation #7. Opening a thread spawns a tab; tabs pile up fast (I had six after a short session, `ui/undo-tray-light.png`), and closing read tabs is a manual bulk action.

**Compose** [V]:

- **Shape.** A centered modal (640×560) that expands to almost full screen, plus an inline reply under the thread.
- **Fields.** Recipient chips, a Lexical rich-text editor, and a B/I/U/S/attach row.
- **Drafts** autosave about 900 ms after you stop typing (`standalone-composer.tsx`, per the arch report).
- **Send.** Sends wait in a 30 s undo window, and the undo tray tucks under the new message.
- **Footer.** A "sent from" promotional footer is **on by default** (Settings → Appearance & reading).

**AI surfaces** [V]:

- **Focus.**
  - It lives in the sidebar and appears only when enabled.
  - It shows grouped cards, each with a reason, a confidence meter, follow-up days and "reply ready."
  - Refresh is manual.
  - A red "Sample data ×" pill toggles demo results.
  - Before opt-in there is a setup screen. It promises no mail is processed until you opt in (`ui/focus-setup-light.png`).
- **Smart Compose.**
  - A ghost-text continuation, plus a menu with tones (draft) and refinements (improve, shorten, expand, fix grammar) (`ui/crop-smart-menu.png`).
  - Generating **replaces the whole draft**, including what you typed, and announces "review before sending" (`ui/smart-generated-light.png`, which shows my typed sentence was overwritten).
  - Without consent, the menu explains the requirement and links to Settings → AI (`ui/compose-smart-menu-light.png`).
- **Prepared replies** are drafted in the background and appear as the "reply ready" chip.
- **Settings → AI** has three switches: Focus, Smart Compose, and, in the demo, "simulated results" (`ui/settings-ai-full-light.png`).

**Onboarding** [V]. Login is a centered 360 px form over the card deck (`ui/landing-desktop-light.png`). Sign-up is a sparse **4-step wizard** (domain, mailbox, DNS records, verify) with one question per screen and a step counter (`ui/onboarding-light.png`, `components/shell/onboarding.tsx`). The fixture inbox opens with a welcome email that tells the user what to do next.

**Empty states** [V]. Lists show a plain title plus one hint (`thread-list.tsx` ~L586). Focus has clear and error states. The only illustration is Focus setup.

**Public demo as onboarding** [V]. The demo needs no sign-up, gives a fresh sandbox per visitor and has a **Reset demo** item in the account menu (`ui/menu-account-light.png`). That's an excellent way to let strangers "feel" the product.

## 6. What is distinctive, and what is generic or bad

**Worth learning**

1. **A lighting model in tokens.** Hairline rings, a top sheen and a fixed-distance raised gradient give consistent depth in both themes. Dark mode especially reads as layered rather than flat gray. The reasoning is written into comments (`globals.css`).
2. **One small motion vocabulary, enforced by agents.** 150 ms ease-out, a front-loaded structural curve, 0.96 press and asymmetric enter and exit. A one-developer-plus-agents team gets consistency because the agents load a rules skill before touching UI (`AGENTS.md`). This is the single most transferable idea.
3. **Departure that respects the pointer.** Fading first and holding the gap means the row under your cursor doesn't change identity mid-click. It's a real usability fix disguised as an animation.
4. **A physical metaphor for moving mail.** The card stack, every target lighting up, the arc flight and the folder flap opening add up to a complete, coherent drag story. Each part has a role.
5. **Undo as a tucked second sheet** under the message instead of a floating toast. It's spatially tied to what it undoes.
6. **Honest AI framing in Focus.** Each item carries a reason line and an explicit confidence (bars plus percent). The setup screen states plainly that no mail is processed before opt-in.
7. **Accessibility discipline**: live regions, focus management, modality-aware focus rings, reduced-motion fallbacks for every JavaScript animation.
8. **A frictionless public demo** with per-visitor sandboxes and reset.

**Generic or bad**

1. **The list is a plain Gmail one-liner.** There's no summary, no importance signal and no due date outside Focus. The "design-first" care went into chrome and motion more than into helping you decide [I].
2. **Thin keyboard model.** No list cursor, no archive key, no palette, no help overlay. It isn't keyboard-first.
3. **The AI rainbow beam is a cliché** of 2025-era "AI glow." It loops forever on the idle Smart Compose trigger, which pulls the eye during writing for no reason. It also breaks the otherwise hueless palette.
4. **Overwrite-on-generate.** Smart Compose replaced my typed text with a generic draft. Even with an announcement, that's hostile to the user's words.
5. **Tabs accumulate.** Every opened thread becomes a tab, so the strip turns into a to-do list you didn't ask for. On mobile it's cramped and truncated (`ui/mobile-thread-light.png`).
6. **Mobile web row bug** [V]. On 390 px the always-visible "more" icon overlaps the truncated subject (`ui/mobile-inbox-light.png`).
7. **Visual weight imbalance.** The glossy orange candy button is the loudest object on screen in a product that promises quiet.
8. **Defaults that leak.** The promotional footer and remote images are both on by default (`ui/settings-appearance-full-light.png`).
9. **Minor issues.** Composer expand animates width and height (layout properties). The 1 s gap hold would drag under rapid keyboard triage [I]. Right-click on a row selects text instead of opening a menu (`ui/menu-context-light.png`). The Focus setup heading overlaps its illustration (`ui/focus-setup-light.png`). Sample-mode Focus reasons are boilerplate.

## 7. Suggestions for Aplos

These are written in Aplos's own terms. Aplos already has motion tokens (`--dur-instant` 60 ms through `--dur-dock` 200 ms, `--ease`, `--ease-out-strong`, `--ease-spring`, in `apps/desktop/src/renderer/ui/tokens.css`), row-departure keyframes with a mid-animation hold (`styles.css`, `row-out-*`), swipe with spring-back (`ui/useSwipe.ts`), a docked Ask panel and a Space-bar AI action. The ideas below build on those. None borrows Redakt assets, copy or values wholesale.

1. **Write an Aplos motion grammar and make agents load it.**
   - One short doc names each motion by purpose: *press, reveal, settle, depart, return, travel*. Each gets one Aplos token pair and an interrupt rule.
   - Add a review checklist that agents must run on any UI diff. Redakt shows this is how a one-person-plus-agents team keeps polish consistent.
   - Aplos has the tokens but no enforcement. The renderer mixes token use with literals: `90ms`, `300ms`, and several 220–320 ms values found in the CSS.
2. **Make departures pointer-aware, not uniformly delayed.**
   - Keyboard triage (`→`/`E`, `←`/`L`): collapse quickly so the next email arrives under the key.
   - Pointer or swipe triage: hold the gap until the pointer leaves the row region or the next action starts.
   - This is Redakt's insight without its fixed 1 s lag.
3. **Show *where* mail went with a tiny "travel" cue.**
   - On Done or Later, a faint copy of the one-line summary moves a short arc toward the Later or Done count in the sidebar, and the count ticks.
   - Keep it under about 250 ms, with no bounce and no scale-down to a dot.
   - Skip it when reduced motion is on, and on repeats faster than about 2 per 600 ms, so power users never wait.
4. **Light up every valid destination during any drag.** This covers dragging mail onto Later, Done, a calendar day or a folder. The hovered target gets a small scale and its icon makes a meaningful micro-move: a clock hand ticks for Later, a check draws for Done.
5. **Give AI a content-first identity, with no glyph and no glow.** The owner rejects sparkles, and Redakt's beam is the same idea in another costume. Instead:
   - Set AI text in its own *typographic* register: summary weight and size, plus a quiet "why" line on demand.
   - Show provenance as a text label only on hover or focus ("summary · Groq", "local model").
   - Show "working" state as a slow opacity breathe on the placeholder summary line, similar to Redakt's calm skeleton rhythm. Don't add color.
6. **Expose confidence and reasons in Home in words, not meters.** For example, "Probably needs a reply: they asked a direct question Tuesday." Pair it with a one-key correction, which feeds the deterministic heuristics the synthesis report recommends.
7. **Never overwrite the user's words with AI.**
   - Drafts and polish should arrive as a proposal next to the user's text, or as a diff to accept.
   - Ghost-text continuation (Tab to accept) is a good keyboard pattern. It suits a local model, and it should stay opt-in per feature in Settings → AI.
8. **Tie undo to its object.** Aplos's undo-send drain bar and any Done/Later undo can sit as a tucked tray under the reader card or the departed row's gap, rather than a global toast. One spatial rule: undo appears where the thing was.
9. **Steal the lighting *method*, not the look.**
   - Add hairline-ring and top-sheen tokens so dark surfaces separate without heavier borders.
   - Measure them on the actual sidebar fill and translucent Mac window background Aplos uses.
   - Keep accents rare; one glossy object per screen at most.
10. **Free polish.** Fuse adjacent selected rows. Use a modality flag so focus rings hide after clicks and return on keyboard use. Kill transitions for one frame on theme change. Use tabular figures for dates and counts. Test SF Pro at weight ~450 against 400 at 13 px.
11. **Don't adopt thread tabs.** The owner rejected toolbar navigation and wants one email at a time. If quick switching is needed, a keyboard-only "recent threads" switcher gives the benefit without permanent chrome.
12. **Ship a public demo the Redakt way.** Aplos's browser-preview mode with demo mail could run as a stateless per-visitor sandbox on the website, with an obvious "Reset demo." That lets strangers feel Home, triage and Ask before downloading. Keep it explicitly fixture-only and offline-AI ("simulated results").

**Pitfalls to avoid.** Looping decorative AI animation. Animating panel width and height. Uniform long departure holds. Leaky defaults. Chrome polish outrunning content. Skipping a 390 px check.
