# Zero (0.email): UI, motion and feel study for the Aplos revamp

2026-10-25. Source: a shallow clone of `Mail-0/Zero` at commit `8c170b8` (2026-10-24) in `/Users/knewton/.t3/aplos-research/src/zero`. I only read files and ran nothing from the repo. Screens come from headless Chromium against the public site (`/`, `/login`, `/pricing`, `/about`) at 1440x900 and 390x844 with light and dark emulation, plus frames from the three public onboarding GIFs on `assets.0.email`. All captures are in `/Users/knewton/.t3/aplos-research/ui/zero/`. Repo paths below are relative to the Zero repo root. This report adds to `research/email-clients/arch/zero.md` and does not repeat it.

**License:** MIT (`LICENSE`, "Copyright (c) 2025 Zero Email"). Aplos's rules still apply: take ideas only, no code, assets, copy or branding.

**Evidence key:** **[V]** means I verified it in source or in a screenshot I looked at. **[I]** means it is my inference.

**Caveat: three different Zeros.** I could not see the signed-in app because the login page offers only Google sign-in (`states/login-desktop-light-fold.png`), and the rules forbid running their code. So the app UI below comes from reading the source, and the visible material shows older layouts:
- The **landing mock** is a three-pane app with a full left sidebar (`home-desktop-light-fold.png`). [V]
- The **onboarding GIFs** are from about May 2025 (the dates in them say so). They show an icon rail, a list, a reader and a docked chat (`frames/onboarding-step*-sheet.png`). [V]
- The **current code** has no sidebar. It uses a top-bar "Zen" layout where the list and the reader replace each other (`apps/mail/components/mail/mail.tsx`). `AppSidebar` still exists in `components/ui/app-sidebar.tsx`, but nothing mounts it. [V]

The marketing material lags the product by more than a year.

---

## 1. Overall feel

Zero is a **dark, dense, developer-flavoured Gmail client with an AI chat attached**. It reads as Vercel and shadcn rather than Apple:
- Geist type and a zinc grey palette.
- Small 13-14 px rows and lots of 28 px icon buttons.
- One saturated blue (`#006FFE`) for unread and selection, and purple to mean "AI".

It feels **serious and utilitarian, not calm**. The list is a single-line Gmail-style row: dot, sender, avatar, subject, snippet and date, separated by hairline dividers. The reader is a narrow centred column with a vertical rail of icon buttons. Personality comes almost entirely from the AI surfaces: a shimmering "Summary" label, a per-character blur reveal on AI drafts, a cycling list of thinking verbs, and a purple accent.

The intended user is a Gmail power user who lives in the browser, likes `⌘K`, and wants to chat with the inbox. The public pages are dark only and push hard on "AI-native" and speed (`home-desktop-dark-full.png`). [V for visuals, I for audience]

The overall impression is **competent shadcn with the rough edges left in**. There are hard-coded hex colours everywhere, two token systems side by side, and dead variants and commented-out features (shortcut remapping, spam, mute, saved searches). The list's performance engineering is far more careful than its motion design. [V]

---

## 2. Layout and information architecture

**Current app shell** (`components/mail/mail.tsx`, `zen-navigation.tsx`) [V]:
- **No left sidebar.** Everything sits in a sticky top bar inside a rounded panel (`md:rounded-2xl`, white or `#1a1a1a`) on a slightly darker app background. The bar is a three-column grid:
  - **Left:** a compact account avatar menu (`NavUser compact`).
  - **Centre:** a grey segmented "pill". It holds a compose icon, then a divider, then a **folder dropdown** (Inbox, Drafts, Sent, Archive, Bin and so on, all in one menu), then a divider, then **category toggles** (Important, All Mail, Personal, Updates, Promotions, Unread). The toggles are icon-only, multi-select, and fill with a per-category colour when active.
  - **Right:** a full-width "Search" button with a `⌘K` key cap. It opens the command palette.
- When rows are bulk-selected, the search button is replaced by a "N selected" label, an `esc` chip, and four icon actions (read, star, archive, bin).
- **List or reader, never both.** Opening a thread sets `?threadId=` in the URL. The list panel then becomes `absolute`, `opacity-0`, `pointer-events-none` and `inert`, and the reader panel takes the full width. The resizable-panel scaffolding is still there, but its handle is commented out. This is the same "one email at a time" decision the Aplos owner made on 2026-10-21. Zero got there too, while its marketing still shows a split view.
- **Reader** (`components/mail/thread-display.tsx`): the content is a centred column, `w-[calc(100%-112px)]`, capped at 650 px (700 px on large screens). On desktop the actions form a **vertical floating rail at the top left**: close, previous and next (up and down chevrons), reply all, notes, star, archive, and a more menu. On mobile the rail becomes a horizontal sticky bar.
- **AI chat** (`components/ui/ai-sidebar.tsx`) has three modes, remembered in localStorage and the URL:
  - a **docked right panel** fixed at 24% width;
  - a **floating popup**, 400 px wide by 600 px tall, at the bottom right;
  - **fullscreen**.

  A 48 px square launcher sits fixed at the bottom right (`components/ai-toggle-button.tsx`), and `⌘0` toggles the chat.
- **Command palette** (`components/context/command-palette-context.tsx`, about 1,900 lines): a cmdk dialog with views for commands, search, filter and a filter builder. It has recent searches, "quick results" from loaded threads, operator suggestions (`from:`, `after:`, a date range), and a group of natural-language examples. Natural-language queries are rewritten by AI into a filter, which appears as an active filter labelled with the original query. Saved searches and the filter builder are commented out of the menu.
- **Compose** is a **full-screen dialog** (`components/mail/compose-dialog.tsx`, `h-screen w-screen`, `#FAFAFA` or `#141414`). Replies are inline, docked under the thread (`reply-composer.tsx`).
- **How the inbox is framed:** a filtered list (Gmail categories plus "Important") with AI layered on top. There is no "home", no focus queue and no done state. Archive is the triage verb and Inbox is the destination.

**For comparison** [V]: the landing mock is three panes (a sidebar with counts, a list with pinned and primary groups, and a reader with a summary card). The May 2025 GIFs swap the sidebar for a 40 px icon rail and dock the chat on the right (`frames/onboarding-step2-sheet.png`).

---

## 3. Visual language

**Typography** [V]:
- **Geist Variable** for the UI and **Geist Mono Variable** for code, loaded through fontsource (`apps/mail/app/globals.css`).
- In the app, rows use `text-sm` (14 px), weight 600 for unread senders and 500 for read ones. The 20 px avatar sits after the sender, not before. Snippets are `text-sm` in `#8C8C8C`, and dates are `text-xs`.
- On the landing page, measured with computed styles (`inspect/inspect-home.json`):
  - The hero H1 is 60 px, weight 500, line-height 60 px (1.0), with **normal letter-spacing**.
  - Section eyebrows are 20 px, weight 300, at 40% white.
  - Body is 18 px/28 px, weight 500, `#B7B7B7`. Feature copy is 14/20, weight 300, `#979797`.
- There are no tracking tokens anywhere. Large Geist with no negative tracking looks loose next to Aplos's SF-style optical tracking. [I]
- A two-tone headline pattern repeats: a white line, then the same size at 40% white. [V]

**Colour** [V]:
- **Three overlapping systems:** stock shadcn zinc HSL tokens (`globals.css`); a second set of static colours (`--panelDark #1a1a1a`, `--darkBackground #141414`, `--mainBlue #437dfb`, `--skyBlue #0066ff`…); and chat tokens ported from another product, "Orchid" (`surface`, `neutral-subtle`, `bg-ai: purple-500`, in `apps/mail/app/ai-chat.css`). Components also hard-code dozens of raw hex values (`#313131`, `#9D9D9D`, `#8C8C8C`…).
- **Category colours:** Important is violet `#8B5CF6`, Personal green `#39ae4a`, Promotions rose `#F43F5E`, Updates amber `#F59E0D`, Unread orange `#FF4800`, and the default is blue `#006FFE`.
- **Purple means AI:** the summary border, the Generate button border, the AI dot, and the pricing "Pro" card.
- **Dark mode** comes from next-themes with Light, Dark and System options, and dark tokens are tuned per surface. The marketing pages are **dark regardless of system scheme**: the home page forces `class="dark"`, and `/login` and `/pricing` report `class="light"` but still render dark (`states/login-desktop-light-fold.png`). On first navigation the page paints **plain white** before it turns dark (`states/hero-entrance-strip.png`), which is a flash of the wrong theme.

**Density and spacing** [V]:
- Desktop rows are 40 px minimum (`min-h-10`, `py-2`, `my-1`), so the pitch is about 48 px. The virtualizer estimate is 64 px.
- Gaps are 16 px between row segments, and each segment is split by 1 px by 16 px vertical dividers.
- Mobile rows are two lines with 32 px round avatars. The reader rail takes 56 px of padding on each side.

**Iconography** [V]: a custom filled icon set (`components/icons/icons.tsx`) mixed with Lucide strokes (`lucide-react`). Fills are mostly grey (`fill-[#9D9D9D]`), and stars are yellow. **AI is marked with a four-point sparkle:**
- the landing summary card uses `star.svg` (`inspect/home-2x-section-02.png`);
- the reader's empty state uses a `Sparkles` icon to open the chat (`thread-display.tsx`);
- the GIF's "Generate" button has sparkles (`frames/crop-ai-draft-preview.png`).

**Surfaces, depth and radius** [V]:
- Base `--radius` is 0.5 rem. Panels are `rounded-2xl` (16 px), rows `rounded-lg`, and toasts, popovers and the palette `rounded-xl`. The AI popup is `rounded-2xl`.
- Depth comes mostly from **tonal layering**: app background, then panel, then a card that is `#202020` to `#2C2C2C` in dark mode. Shadows are minimal (`shadow-sm` on the hover bar, `shadow-md` on tooltips, `shadow-lg` on the popup).
- Blur appears in two places: `backdrop-blur-sm` behind the AI popup, and a `bg-black/80` overlay on sheets.
- The landing page uses a dithered pixel background, a floating rounded nav bar (`inspect/home-2x-section-01.png`), and a purple-to-amber gradient CTA band.

---

## 4. Motion

**Headline:** Zero has very little bespoke motion in the mail app. Most of what moves is stock `tailwindcss-animate` on Radix primitives. The one mail-specific transition, the thread-to-thread slide, is **off by default**: `settings.animations` defaults to `false` in `apps/server/src/lib/schemas.ts` and is read by `apps/mail/hooks/use-animations.ts`. Motion respects reduced-motion globally through `<MotionConfig reducedMotion="user">` (`providers/client-providers.tsx`). [V]

Nothing was animating on the landing page at rest. `document.getAnimations()` was empty after load and after scrolling. [V]

| # | What moves | Property | Duration / curve | Purpose | Evidence |
|---|---|---|---|---|---|
| 1 | Thread to thread (next/prev) | opacity 0 to 1, x ±25 px by direction | 80 ms exit, then 80 ms enter (`AnimatePresence mode="wait"`, so about 160 ms in total), `cubic-bezier(0.4,0,0.2,1)` | Spatial continuity when stepping through mail. **Opt-in only.** | `thread-display.tsx` ~L1101-1130 [V] |
| 2 | List row hover and selection | background to `primary/5`, opacity of read rows 70% to 100% | Tailwind `transition-all` default, 150 ms `cubic-bezier(0.4,0,0.2,1)` (the same default shows on the live site's buttons) | Hover feedback | `mail-list.tsx`; computed transition in `inspect-home.json` [V] |
| 3 | Row hover action bar (star, important, archive, bin) | Mounted on `mouseenter` | **No transition**, it pops in instantly | Quick actions | `mail-list.tsx` `ThreadHoverActions` [V] |
| 4 | Row leaving after archive or delete | none | **Instant.** The row returns `null` and the list closes the gap with no exit or reflow animation. | n/a | `mail-list.tsx` (`optimisticState.shouldHide`) [V] |
| 5 | Keyboard focus moving off-screen | scroll | `scrollIntoView({block:'nearest', behavior:'smooth'})`. The first jump uses `auto`. | Keep the focused row visible | `hooks/use-mail-navigation.ts` [V] |
| 6 | Dropdown, context menu, popover, tooltip | fade 0 to 1, zoom 95% to 100%, 8 px slide from the anchor side; mirrored on exit | Plugin default duration (about 150 ms [I]) | Anchored disclosure | `components/ui/{dropdown-menu,popover,tooltip,context-menu}.tsx` [V classes] |
| 7 | Dialog (command palette, full-screen compose, onboarding) | fade, zoom 95% to 100% | 200 ms | Modal entry | `components/ui/dialog.tsx` [V] |
| 8 | Sheet | slide in from an edge, plus a `black/80` overlay fade | **500 ms open, 300 ms close**, ease-in-out | Side panels and mobile | `components/ui/sheet.tsx` [V] |
| 9 | Accordion (attachments, settings) | height to the Radix content height | 200 ms ease-out | Disclosure | `globals.css` [V] |
| 10 | Toasts | Sonner's own enter, swipe-out keyframes, fade plus scale 0.8 | Sonner defaults. Bottom centre, 384 px wide, `rounded-xl`, icon on the left, buttons on the right. | Undo, status | `components/ui/toast.tsx`; Sonner keyframes in `inspect-home.json` [V] |
| 11 | Undo window | none (time only) | Triage toasts last **5 s**. Undo-send waits 5 s and its toast lasts 5.5 s. | Deferred commit | `hooks/use-optimistic-actions.ts` ~L176-195, `reply-composer.tsx` [V] |
| 12 | AI popup chat at rest | opacity **40%**, 100% on hover or focus (large screens) | 150 ms | Keep the chat visible but "out of the way" | `ai-sidebar.tsx` L571 [V] |
| 13 | Chat empty state | 3 blocks fade up, y 8-10 px | 400 ms easeOut, staggered 0 / 100 / 200 ms | Welcome | `components/create/ai-chat.tsx` [V] |
| 14 | "Thinking" label | Crossfade with y +6 to 0 to −6 (`popLayout`) as the verb changes. Verbs cycle through about 7 thinking and 6 writing variants. | 200 ms easeOut | Signals progress | `components/ai-chat/thinking.tsx` [V] |
| 15 | Thinking step list | expands through `grid-template-rows`, chevron rotates | 200 ms ease-out | Collapses to a "Thought" summary you can open later | `thinking.tsx` [V] |
| 16 | AI status dot | scale 1 to 0.5 to 1, looping | 800 ms `cubic-bezier(1,0,0,1)` | Live indicator | `ai-chat.css` `pulseSize` [V] |
| 17 | Queued chat messages | Fanned card stack: each card `scale(1−0.05·i)` and lifted 8 px (13 px on peek). A "+N" badge rises from y 8 px at scale 0.5. | **700 ms ease-out-expo** `cubic-bezier(0.19,1,0.22,1)`, 40 ms stagger per card; the badge takes 500 ms | Shows follow-ups typed mid-answer | `components/ai-chat/queued-message-stack.tsx` [V] |
| 18 | AI draft preview card in compose | Enter: opacity 0 to 1, y 10 to −10, scale 0.95 to 1. Exit: back to y 10, scale 0.95. | 300 ms in, 200 ms out | Accept/Reject proposal | `email-composer.tsx` ~L1966-2070 (only the `card` variant is used; four other variants are dead code) [V] |
| 19 | AI draft text reveal | **Per character**: opacity 0 to 1 and `blur(12px)` to 0 | 300 ms per character, 10 ms stagger (0.03 s ÷ speed 3). A 600-character draft takes about 6 s. | "Typing" effect | `motion-primitives/text-effect.tsx` (`blur` preset); seen mid-reveal in `frames/crop-ai-draft-preview.png` [V; the 6 s figure is I] |
| 20 | Shimmering text labels ("Summary", "Thinking…") | background-position sweep | 2 s linear, **infinite** (1 s for Thinking) | "AI-ness". It keeps sweeping even after the summary has loaded. | `components/ui/text-shimmer.tsx`, `mail-display.tsx` L144, L352 [V] |
| 21 | Spinners | rotate 360° plus arc length 0.2 to 0.8 | 1 s linear, looping | Loading | `components/ui/spinner.tsx` [V] |
| 22 | Skeletons | `animate-pulse` on text-shaped blocks; the row skeleton matches the real row height | Tailwind pulse | Stable layout while loading | `globals.css` `.skeleton`, `mail-list.tsx` [V] |
| 23 | Theme switch | **View Transition** that wipes the new theme down with `clip-path: inset(0 0 100% 0)` to `inset(0)` | 650 ms `cubic-bezier(0.65,0,0.35,1)`, gated on reduced-motion | Delight | `globals.css`, `app/(routes)/settings/appearance/page.tsx` [V] |
| 24 | Compose AI loading | pastel three-stop gradient pan | 8 s ease, looping | Ambient "working" | `globals.css` `.compose-gradient-animated` [V] |
| 25 | Landing and login entrance | opacity 0 to 1, y 20 to 0 | 500 ms (Motion default curve), staggered in 0.1-0.2 s steps | Page reveal | `components/home/HomeContent.tsx`, `app/(auth)/login/login-client.tsx` [V] |
| 26 | Animated theme icons | sun rays stagger in, moon rocks | 0.3 s with 0.1 s × i delay; 1.2 s | Toggle polish | `components/icons/animated/{sun,moon}.tsx` [V] |

**What's missing:**
- No list enter or exit animation, and no reflow when a row leaves.
- No swipe or drag triage at all. A search for swipe, pan and drag finds nothing in `components/`, `hooks/` or `lib/`.
- No press or scale feedback on buttons.
- No transition between the list and the reader. The list is hidden with opacity and `inert`, without a transition.
- No spring motion anywhere in the mail flow.

[V]

---

## 5. Interaction model

**Keyboard** (`apps/mail/config/shortcuts.ts`, `lib/hotkeys/*`) [V]:
- **Global:** `c` compose, `⌘K` palette, `⌘Z` undo the last action, `v` voice, `⌘⇧F` clear filters, `⌘0` AI chat.
- **Navigation:** Gmail-style `g` sequences (`g i`, `g d`, `g t`, `g a`, `g b`, `g s`), and `?` for help.
- **List scope:** `e` archive, `r` mark read, `u` unread, `i` important, `s` star, `d` delete, `a` archive, `⌘A` select all, `esc` exit selection, and **`1`-`6` toggle the category filters**.
- **Reader scope:** `r` reply, `a` reply all, `f` forward, `⌘⌫` bin, `esc` close, `↑`/`↓` previous and next.
- `j`/`k` and the arrow keys move focus, and **moving focus opens the thread** (`useMailNavigation.moveFocus` calls `navigateToThread`). In the current single-pane layout, pressing `↓` in the list therefore replaces the list with the reader. That behaviour suits a preview pane and now feels like a leftover from the split view. [V code; I effect]
- Scopes are toggled by whether a thread is open (`mail.tsx`), so **the same letter means different things**: `r` is "read" in the list and "reply" in the reader, and `a` is "archive" in the list and "reply all" in the reader. **`e` (archive) is not bound in the reader scope** at all, so you can't archive the open email from the keyboard. [V code; not run]
- **Hover targets the keyboard.** Rows dispatch a window `emailHover` event, and single-key actions apply to the hovered row when nothing is bulk-selected. Aplos does the same.
- Ctrl/⌘-click multi-selects and Alt-Shift-click selects everything below. Shift range selection is logged as "not fully implemented" (`mail-list.tsx`).
- Key caps are shown for non-QWERTY layouts through a keyboard-layout mapper (`utils/keyboard-layout-map`). **Remapping is commented out** (`settings/shortcuts/page.tsx`).
- Visible key hints in the app are rare. `<kbd>` appears once in `mail.tsx` (the `⌘K` cap) and a few times in the palette.

**Triage flow** [V]: hover a row, then click an icon or press a key. The change is applied optimistically and the row vanishes instantly. A toast offers **Undo for 5 s**, and the server call is **deferred until that toast closes or is dismissed** (`use-optimistic-actions.ts`). Nothing flushes on `beforeunload` or `pagehide` (the only `beforeunload` hooks are in the composers). Closing the tab inside the 5 s window silently drops the archive. [V code; I consequence]

Archiving the open thread moves to the neighbour that takes its place (`rowActions.moveTo`). Snooze is a bare date-and-time form with no presets and no shortcut (`snooze-dialog.tsx`). Each thread can carry **private notes** that are colour-coded, pinnable and reorderable by drag (`note-panel.tsx`, dnd-kit).

**Compose** [V]:
- Full-screen dialog with a TipTap editor, ghost-text autocomplete (`components/create/ghost-text.css`, a suggestion panel sliding 10 px down over 200 ms), and templates.
- `⌘↵` sends and `esc` closes.
- Replies are inline and undo-send waits 5 s.
- AI writing: a **Generate** button produces a draft in a floating card above the composer, with red **Reject** and green **Accept** buttons (`frames/crop-ai-draft-preview.png`). Tone and length chips appear in the landing mock and the GIF.
- The landing mock shows a key-hint footer under the composer (`inspect/home-2x-section-02.png`).
- A **branded signature is on by default** (`zeroSignature: true` in `apps/server/src/lib/schemas.ts`).

**AI surfaces** [V]:
1. **Chat:** a launcher button, `⌘0`, or the "Zero chat" button in the reader's empty state. Messages stream in. A thinking group cycles its verbs, then collapses to "Thought" with an expandable step list. Results render inline as thread cards and label chips (`ai-chat/tool-results.tsx`). Follow-ups sent while it is answering go into the queued stack. Suggested prompts show when the chat is empty. In the May 2025 GIF, the chat listed **raw tool names** ("Used tool: createLabel…") and **acted without confirmation**, labelling three emails after one sentence (`frames/crop-chat-toolcalls.png`).
2. **Reader summary:** a purple-bordered pill labelled with shimmering "Summary" text, **collapsed by default**. A click reveals 15 px markdown (`mail-display.tsx` L331-366). The summary is hidden when AI is off, even if a cached copy exists.
3. **Search:** natural language is rewritten into a filter in the palette.
4. **Compose:** Generate, Accept or Reject, plus autocomplete.
5. **Voice:** `v`, using ElevenLabs.
6. **Categories:** auto-labels drive the 1-6 toggles.

**Onboarding** (`components/onboarding.tsx`) [V]: a five-step, 690 px modal. Each step has a GIF (**10-19 MB each**, about 1,700x1,080, 16-22 s long), a 36 px title and Next/Back. One step is a "coming soon" placeholder, and confetti plays at the end.

**Empty states** [V]:
- The list shows a 200 px illustration, a "nothing here" line and a "clear filters" link.
- The reader's no-selection state shows the same illustration with buttons for chat and compose.
- The chat's empty state shows the logo, a two-tone prompt and suggested queries.

**Defaults that shape the feel** (`apps/server/src/lib/schemas.ts`) [V]: `externalImages: true` (remote images load by default), `autoRead: true`, `animations: false`, `zeroSignature: true`, `colorTheme: 'system'`.

---

## 6. What's distinctive and worth learning, and what's generic or bad

### Worth learning

- **Perceived speed comes from engineering, not animation** (`mail-list.tsx`) [V]. The list is virtualized (`virtua`, overscan 3) with memoized rows and written rules about which hooks a row must never subscribe to. A thread **prefetches after 120 ms of hover intent** (pointer-down on touch), and **both neighbours of the open thread prefetch** so `j`/`k` hit the cache. Skeletons have the real row height, the next page loads 20 rows early, and deep pages are trimmed on return to the top. This is the most transferable part of Zero.
- **The AI "thinking" display that collapses into a log.** While a turn runs, a short label changes. When it finishes, the label collapses to one quiet line you can expand to see the steps. It is honest without being noisy. The raw tool names in the old GIF were the failure mode of the same idea.
- **The queued follow-up stack.** You can keep typing while the assistant answers. Each queued item can be edited, sent now or dismissed. This fits any Ask surface with voice input well.
- **Natural-language search shown as a filter chip.** The AI rewrite becomes a visible, removable filter instead of a hidden query.
- **Category toggles on the number keys.** Single digits flip filters in the list, and the toggles are multi-select. It's fast and you can see the state.
- **A narrow reader with a floating vertical rail.** It keeps line length comfortable on wide screens, and the actions stay in a fixed place.
- **Neighbour-advance after archive.**
- **Theme switching with a View Transition wipe.** It's cheap and reduced-motion-safe.

### Generic or bad

- **The sparkle and purple AI vocabulary**: a sparkle glyph, a purple border, shimmering text, a pastel gradient, and per-character blur. These are the clichés the Aplos owner explicitly rejects.
- **Shimmer that never stops.** "Summary" sweeps forever after it has loaded, so it reads as loading when it isn't.
- **A per-character blur reveal on a whole email draft.** It makes reading wait for decoration (about 6 s for a long draft), and animating `filter: blur` on hundreds of spans is expensive. [I]
- **A summary that hides by default.** Zero treats the summary as a garnish behind a click.
- **Saturated red and green Accept/Reject buttons.** They are loud and judgemental for a draft proposal.
- **A popup chat at 40% opacity when idle.** Translucent content over mail hurts legibility in both layers.
- **Opt-in motion, and only for one transition.** It looks like a team that didn't trust its motion to be fast enough to leave on. Rows also vanish without any exit, so triage feels abrupt.
- **Undo implemented as a delayed commit with no flush.** It can lose actions.
- **Overloaded single keys and a missing archive key in the reader.**
- **Arrow keys that open threads** in a single-pane layout.
- **Token sprawl**: shadcn, static hex, Orchid tokens, and inline hex. Hover and tooltip colours are set per component (`dark:bg-[#313131]`), so they drift.
- **Untracked display type, dark-only marketing with a white flash, and marketing more than a year behind the product.**
- **Onboarding that ships about 48 MB of GIFs**, with a "coming soon" step and confetti.
- **Privacy-unfriendly defaults**: remote images on, and a branded signature on.

---

## 7. Suggestions for Aplos, in Aplos's own terms

These are original adaptations. Aplos already has motion tokens (`--dur-fast` 120 ms, `--dur-base` 160 ms, `--ease` `cubic-bezier(.2,.8,.2,1)`, `--ease-out-strong`, exit hints in `renderer/ui/motion.ts`), SF Pro optical tracking (`renderer/ui/tokens.css`), and swipe triage. On motion craft, Aplos is **already ahead of Zero**. The lessons are mostly about speed, keyboard rigour and AI presentation.

1. **Make opening an email feel instant before making it move.** Warm a thread's body when the Home focus lands on it or after about 120 ms of hover, and keep the previous and next threads warm while the reader is open. In Aplos this is a cheap engine call (`thread.prefetch(id)`, SQLite into a small LRU cache), not a renderer fetch. It is also what makes the planned "bodies on demand" storage feel local.
2. **Ship the directional reader step on by default, and keep it short.** For next and previous, cross-fade with a 12-16 px offset in the direction of travel over `--dur-fast` with `--ease`. **Overlap** exit and enter rather than sequencing them (Zero's wait mode costs about 160 ms per step). Use opacity only under reduced motion. No settings toggle is needed if it never adds latency.
3. **Undo should be a reversible operation, not a delayed one.** Commit Done, Later and archive to the durable op queue immediately, with a stored `notBefore` about 5 s ahead so the host push waits out the undo window and quitting never drops the action. `Z` removes the pending op, or queues its inverse if it was already pushed. Zero's toast timer shows what goes wrong otherwise.
4. **Add an exit to every row that leaves the list.** Zero's rows blink out. Aplos already has `hintExit` and `useListPresence`; make sure keyboard triage on Home *and* in All mail exits in the Done or Later direction (about 160-200 ms, `--ease-out-strong`), then close the gap with a short height collapse so the next row slides into the focus slot. That arrival is the reward of triage.
5. **Ask: collapse the work into one quiet line.** While Ask runs, show one steady plain-language status that names the real step (for example, reading three threads). Don't cycle synonyms, and never show tool identifiers. When it finishes, fold the steps into one dim, expandable line with citations. Keep the confirm cards as the only path to action; Zero's old chat labelled mail from a single sentence.
6. **Ask: queue follow-ups visibly.** When the user types or holds `A` to dictate while an answer is streaming, show the pending question as a small card under the input that they can send now, edit or drop. Hold-to-talk users speak in bursts, so this prevents lost or overlapping turns.
7. **Show search's interpretation as tokens you can edit.** When a natural-language query (or Ask) becomes FTS operators (`from:`, `after:`, `has:attachment`), render each operator as a removable token in the search field, with the original sentence available in a tooltip. Users learn the operators, and a wrong AI guess costs one backspace.
8. **Don't use opacity for read state.** Zero dims read rows to 60-70%. Aplos already uses opacity for Home's distance fade, so reusing it for "read" would make the two meanings collide. Use weight plus a small unread mark instead, and keep opacity for distance only.
9. **Give the reader a measure.** Cap the message column at about 640-720 px (about 70 characters at 14 px), centred, with the big summary above the subject at the same width so they align. Keep the action row fixed (Aplos uses an X on the right, per the owner's preference) so it doesn't move between emails.
10. **Present AI content as content.** Summaries stay plain, large text with no glyph, border colour or shimmer (Aplos is already right; Zero is the counter-example). Shimmer only while something is pending, and stop the moment text arrives. In Compose, insert AI drafts as ordinary selectable text with a subtle tint; `Tab` accepts and `Esc` discards, with neutral buttons and no per-character reveal.
11. **Keep keys unambiguous across views.** One letter should mean one verb everywhere (Aplos already uses `E` for Done everywhere). Audit the revamp so the reader and the lists share the triage keys. Make "open" an explicit `Enter`/`O` (Aplos's current rule), never a side effect of arrow movement.
12. **Number keys for account scope.** In All mail, the digits could switch the account filter: 1 for all accounts, 2 onward for each account in sidebar order. Each switch shows briefly as a chip. This is the multi-account equivalent of Zero's category digits. Check it for conflicts with the existing `⌃1`-`⌃6` view keys.
13. **Footer hints only when the mode changes.** While an AI suggestion or a recipient picker is open, show a one-line legend of the 2-3 keys that apply right now (accept, discard, cycle) at the bottom of the composer, and hide it otherwise.
14. **Keep the defaults private and quiet.** Keep remote images off by default, never add a branded signature, and keep the marketing site light/dark-aware with no theme flash. Use small demo loops or real interactive demos (which Aplos's site already has) instead of megabyte GIFs.
15. **One token system.** The revamp should forbid raw hex in components and add `--tracking-*` for display sizes on the website. Zero's three overlapping colour systems show what happens within a year without that rule.

**Don't copy:** Zero's sparkle, purple and AI shimmer vocabulary; the floating translucent chat; the per-character blur; the opt-in-only motion; the collapsed summary; the overloaded keys; or the deferred-commit undo.

---

### Screenshot index

All paths are under `/Users/knewton/.t3/aplos-research/ui/zero/`.

- **Landing:** `home-{desktop,mobile}-{light,dark}-{fold,full}.png`. Light and dark look identical because the page is forced dark. Plus `inspect/home-2x-section-00…06.png` (2x crops) and `inspect/inspect-home.json` (computed type, keyframes, transitions).
- **States:** `states/state-company-open.png`, `states/state-resources-open.png`, `states/state-cta-hover.png`, `states/hero-entrance-strip.png` (white first paint).
- **Pages:** `states/{login,pricing,about}-desktop-{light,dark}-{fold,full}.png` and `states/*-mobile-dark-fold.png`.
- **Onboarding GIF frames:** `frames/onboarding-step{1,2,3}-sheet.png`, plus individual frames and the crops `frames/crop-ai-draft-preview.png` and `frames/crop-chat-toolcalls.png`. The raw GIFs are in `media-raw/`.
- **Capture scripts** (headless only): `/Users/knewton/.t3/aplos-research/tools/zero-{shots,inspect,states}.mjs` and `tools/scripts/{gif_frames,hstack}.py`.
