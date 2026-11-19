# Inbox Zero Mail: UI, motion and feel

*Researched 2026-10-25 for the Aplos Mail UI revamp. Sources: the marketing site (getinboxzero.com `/`, `/email-client`, `/download`), the docs changelog (docs.getinboxzero.com/changelog), two launch videos hosted on Mux, and the client UI code in a shallow clone of `elie222/inbox-zero` at `9946df5` (2026-10-25), at `/tmp/iz-compare/src/inbox-zero`. I only read files; nothing was installed, built or run. Signing in needs a real Google or Microsoft account, so product observations come from code plus the screen recordings in the launch videos. Paths below are relative to the repo root, and `mail/` means `apps/web/app/(app)/[emailAccountId]/mail/`.*

**License.** The license is AGPL-3.0 with "Additional Terms for Inbox Zero" (root `LICENSE`, lines 9-23). Those terms forbid monetizing the software and require an enterprise license for organizations with 5 or more users, and `apps/web/ee/` carries its own commercial license. Ideas only: this report describes values in my own words and copies no code, assets or copy.

**Builds on.** This report builds on `research/inbox-zero/inbox-zero-product.md`, which had marked the new client's look as "unverified", and on `research/email-clients/arch/inbox-zero-client.md` §5, which listed four motion constants. This one verifies the look and expands the motion inventory.

**Tags.** **[V]** means verified from code or a primary page, with a path or URL. **[O]** means observed in a screenshot or video frame. **[I]** means my inference.

**Screenshots** are in `/Users/knewton/.t3/aplos-research/ui/inbox-zero-mail/`, called `ui/` below. The key ones:

| File | What it shows |
|---|---|
| `ui/video-frames/home-t1.jpg` | Full desktop window, list layout |
| `ui/product-shot-inbox-zero-mail.png` | Hero image from the download page: desktop plus iPhone |
| `ui/video-frames/home-t9.2.jpg` | Focused row and the Tab key moving between splits |
| `ui/video-frames/home-t10.5.jpg` | Split layout with an inline draft |
| `ui/video-frames/client-t17.5.jpg` | Team comments |
| `ui/video-frames/client-t21.jpg` | Account switcher |
| `ui/video-frames/client-t23.jpg` | Unified inbox |
| `ui/video-frames/client-t25.5.jpg` | iPhone app |
| `ui/video-frames/client-t28.5.jpg` | Bulk unsubscribe |
| `ui/video-frames/home-keyboard-sequence-5.6-7.9s.png` | Contact sheet at 10 frames per second: J, E, then ⌘K |
| `ui/video-frames/home-archive-exit-sequence.png` | Archive exit frames |
| `ui/email-client-desktop-*-{fold,full}.png`, `ui/home-*`, `ui/download-*`, `ui/docs-changelog-*` | Marketing and docs pages at 1440×900 and 390×844, light and dark |
| `ui/interaction-*.png` | Open nav menu, CTA hover, video modal |

Transcripts and storyboards are in `ui/raw/video/`.

---

## 1. Overall feel

Inbox Zero Mail is a **calm, light, serious Gmail-literate client**. It is moderately dense and has almost no playfulness. It reads as "Gmail with Superhuman's keyboard and tabs", built from shadcn/ui parts and then deliberately quietened. Recent commit titles are about calming the list chrome (prior report). [O: `ui/video-frames/home-t1.jpg`]

It targets Gmail and Outlook power users and small teams who already think in labels, and who may later pay for the AI layer. Its motion is minimal and fast, 80-200 ms. Almost every animation explains where something went. None of it is decorative.

Its real craft is **perceived speed** rather than visual identity:
- focus moves on the same frame as an archive;
- the reader is double-buffered, so it never shows a blank frame;
- the conversations next to the open one are pre-loaded for J/K;
- local reads never flash a spinner.

The one moment of whimsy is a static sunrise illustration when a view is empty.

---

## 2. Layout and information architecture

**Frame.** On macOS the window uses a hidden-inset title bar. The traffic lights sit at (16, 18), the left drag region is 52 px tall and 78 px wide, and the sidebar toggle is lifted into the title-bar row (`apps/desktop/src/desktop.ts`, lines 280-360). The window defaults to 1280×840 and has a minimum of 900×640 (`apps/desktop/src/windows.ts`). The window background is white. The desktop app forces the native theme to light (`apps/desktop/src/main.ts:139`). [V]

**Left sidebar** (`mail/MailSidebar.tsx`, `mail/MailShellSidebar.tsx`, `mail/panel-widths.ts`) [V]
- **Size.** 256 px by default, resizable from 180 to 440 px, with the width stored in a cookie. It collapses to an icon rail at 1024 px and wider; below that it becomes a sheet.
- **Order from top to bottom:**
  - a back link to the rest of Inbox Zero;
  - an outlined Compose button with a blue pen icon and a `C` key cap (the marketing images still show an older filled blue-gradient button, `ui/product-shot-inbox-zero-mail.png`);
  - Inbox, with an unread count shown as a blue pill;
  - team items (Shared with me, Activity);
  - a collapsible "Mail" group (Drafts, Sent, Archived, Starred, Scheduled, Spam, Trash);
  - "Categories" (Gmail categories);
  - Labels, each with a pastel color dot and a count;
  - Settings;
  - the account switcher pinned at the bottom.
- **Account switcher.** A popover with "All accounts" at the top, then each account. In the unified view, each row gains a 20 px account-initial avatar. [O: `ui/video-frames/client-t21.jpg`, `client-t23.jpg`]

**List column** (`mail/ListToolbar.tsx`, `mail/MailSplitTabs.tsx`, `mail/SplitTabs.tsx`) [V]
- **Toolbar.** A 32 px tall search field in a muted fill, with a chevron that opens advanced search, followed by three 32 px icon buttons:
  - preview length (one line or expanded);
  - list or split layout;
  - the assistant.
  - When anything is selected, the toolbar turns into a selection bar: "N selected", archive, read, star, delete, label, clear.
- **Split tabs.** Text tabs with counts (All, Unread, To Reply, Newsletter, Calendar, Receipt, Notification, Other, and a `+` to add one). The active tab is marked by a 2 px blue underline. The rule under the tabs shows only once the list has scrolled under it. Splits are saved queries, and the AI can create one from a plain description. Tab cycles through them.
- **Date groups.** Rows are grouped by date: Today, Yesterday, Last 7 days, Earlier this month, then month names (`apps/web/utils/date.ts:58-64`).
- **No virtualization.** Older mail loads by paging.

**Two layouts** (`mail/MailListPanel.tsx`, `packages/mail-ui/src/MailReaderSurface.tsx`; the default is set by `mailLayout @default(LIST)` in `prisma/schema.prisma:194`) [V]
- **List** is the default. The list fills the pane, and opening a thread replaces it with the reader, centered at a maximum width of 48 rem (768 px). Escape returns to the list.
- **Split** (Shift+V). The list defaults to `clamp(258px, 32vw, 400px)` and can be resized from 258 to 720 px. The reader keeps at least 360 px. [O: `ui/video-frames/home-t10.5.jpg`]

**Reader**
- **Canvas.** The reader sits on a muted gray background (#F6F6F6) with white message cards.
- **Subject.** Set in the title face at 24 px, medium weight, slightly tight tracking.
- **Messages.** Collapsed messages become one-line rows (avatar, sender in a fixed 96-112 px column, snippet, date), so the snippets align down the thread.
- **Selection.** A 4 px blue rail on the left marks the selected message, and arrow keys move it.
- **Replies** open inline beneath the last message as a quiet "Draft to …" line that expands into the editor. [V: `apps/web/components/email-list/EmailMessage.tsx`, `EmailThread.tsx`; O: `ui/video-frames/client-t11.jpg`]

**Floating and secondary surfaces** [V]
- **Compose** for a new message is a non-modal floating window anchored bottom-right. It is 38 rem (608 px) wide and up to `min(42rem, 100dvh - 1.5rem)` tall, with 12 px corners, `shadow-2xl` and a header button that expands it to the full window (`apps/web/providers/ComposeModalProvider.tsx`). A reply can pop out into its own OS window (⌘⇧P).
- **Assistant.** A right-hand chat panel that slides over the content. It is 450 px by default, resizable from 360 to 900 px, and opens with ⌘J (`apps/web/components/SidebarRight.tsx`, `chat-sidebar-width.ts`).
- **Command palette** (⌘K, cmdk) with sub-pages for natural-language snooze and accounts. Labels count the selection, and it works while composing (`apps/web/components/CommandK.tsx`, `mail/mail-command-palette.ts`).
- **Sender context.** A pane beside the reader, or a sheet on narrow windows, showing public information about the sender (`mail/SenderContextPanel.tsx`).
- **Settings** open as a dialog from anywhere, including from ⌘K (changelog, Sep 8).

---

## 3. Visual language

**Typography** [V unless marked]
- **Families.**
  - Interface: Geist, loaded through `next/font` (`apps/web/app/layout.tsx:45`).
  - Display: Aeonik Medium (`styles/aeonik-medium.woff`), used for "title" text (reader subject, empty-state headline, marketing headings) when a build flag enables it. Otherwise it falls back to Geist (`layout.tsx:39, 210`). The live marketing page computes `aeonikFont 40px 400` for section headings [V, computed style].
  - Email bodies: the **system** font stack, not Geist, at **14.5 px / 1.65** inside the iframe (`packages/mail-ui/src/MailBody.tsx:15-16`). On a Mac, reading text is SF Pro while the chrome is Geist, a split that works well.
- **Ligatures** are turned off globally (`styles/globals.css`, end of file).
- **Sizes and weights.**
  - Rows: 14 px. Sender and subject are regular, or semibold when unread.
  - Snippet: 14 px in the muted color.
  - Dates and counts: 12 px.
  - Chips: 12 px on a 16 px line.
  - Key caps: 10-11 px.
  - Sidebar section headers: 12 px muted.
  - Group headers: 14 px muted.
- **Tracking** is the default everywhere except title text (`tracking-tight`). The marketing H1 is Aeonik at about 60 px with tight tracking [O: `ui/email-client-desktop-light-fold.png`].

**Color** (`styles/globals.css`, lines 7-190) [V]
- **The Mail palette is scoped** with `data-theme="mail"` on the root element (`mail/MailThemeScope.tsx`), so the rest of the app keeps its cooler slate tokens.
- **Light theme (warm neutrals):**

| Token | Value |
|---|---|
| Background | #FDFDFD |
| Text | #242424 |
| Muted text | #848484 |
| Muted fill | #F6F6F6 |
| Hairline border | #EFEFEF |
| Strong border (column dividers, fields) | #E6E6E6 |
| Sidebar | #FBFBFB |
| Primary | #2563EB |

- **Dark theme.**
  - Surfaces are charcoal rather than black: background #26282C, cards and popovers #2D2F34, border #35373B.
  - The primary is lifted to #60A5FA with dark text on it so both fill and text pass WCAG AA.
  - Plain-text emails are themed dark. "Designed" HTML emails stay on white paper, and the email's own dark-mode media queries are neutralized (`MailBody.tsx:250-310, 660-725`).
- **Brand gradient.** A blue gradient (#2965EC to #5C89F8, top to bottom) with a 1 px #5989F0 border and a soft blue glow. It is used for marketing CTAs and Send; the CTA uses 13 px corners. [V tokens; V computed style on the live site]
- **Tooltips** are **solid blue-600 with white text**, and key caps inside them are translucent white (`components/ui/tooltip.tsx:49`, `components/ShortcutTooltipContent.tsx`).
- **Label chips** (`mail/MailLabelChip.tsx`):
  - Eight hues, each a 50-tint fill, a 150-tint border and a 600-tint text.
  - System labels have fixed colors: To Reply blue, Notification green, Receipt orange, Cold Email red, Newsletter purple, Awaiting Reply cyan, Calendar yellow.
  - User labels get a stable color from a djb2 hash of the lowercased name. Provider colors win when they exist.
  - The source admits the chip palette "has no dark variant".

**Density and spacing** (`packages/mail-ui/src/MailThreadRow.tsx`, `MailSidebarRow.tsx`) [V]
- **Wide row.** 10 px vertical padding, 12 px left and 20 px right, 10 px gaps. That makes a row about 41 px.
  - The sender column is fixed at 256 px and the date column at 64 px.
  - The subject is capped at 46% of the remaining width, and the snippet fills the rest.
  - Up to 3 chips in the wide list and 2 in narrow layouts.
- **Narrow (split) row.** Three stacked lines: sender plus date, subject, snippet, with chips below.
- **Sidebar rows.** 6 px × 10 px padding, 8 px corners, 1 px gaps.
- **Unread and starred** are 6 px dots: blue for unread, yellow for starred.
- **Focused row.** A 5% primary tint plus a 2 px rounded blue bar inset 4 px top and bottom on the left edge.
- **Selected row.** A 10% primary tint.
- **Hover.** Muted at 50%. [O: `ui/video-frames/home-t9.2.jpg` shows the focus bar]

**Iconography** [V]
- **Library and sizes.** Lucide line icons at their default stroke, 14 px in toolbars and 16 px in the sidebar.
- **The sparkle glyph marks AI everywhere:**
  - the toolbar assistant button (`ListToolbar.tsx:320`), drawn as a filled blue square in marketing renders;
  - "Describe it" when creating a split;
  - the "Matched reason" submenu;
  - the sender-context empty state;
  - a wand-and-sparkles icon for "Create rule for sender";
  - a four-point star on iPhone [O: `client-t25.5.jpg`];
  - an amber sparkle on "Select N suggested" in Bulk Unsubscribe [O: `client-t28.5.jpg`].

**Surfaces, depth and radius** [V]
- **Mostly flat.** Rows are separated by a 40%-opacity hairline. Column dividers use the stronger border.
- **Shadows** appear only on floating things:

| Element | Shadow |
|---|---|
| Compose window | `shadow-2xl` |
| Toasts | `shadow-lg` |
| Dialogs | `shadow-lg` |
| Popovers | `shadow-md` |

- **No blur or vibrancy** anywhere in the app chrome. The one exception is the sheet overlay, which uses a small backdrop blur. The dialog overlay is 50% black.
- **Radius.** The base is 8 px. Rows are square. Chips are 6 px, key caps 5 px, the Compose button and window 12 px, and the search field 8 px.

---

## 4. Motion

Exact values below come from code. "Library default" means the class is in the repo but its timing comes from a dependency I could not read because nothing was installed [I].

| # | Animation | Property | Duration / curve | Purpose | Evidence |
|---|---|---|---|---|---|
| 1 | **Archive exit, single thread** | Focus jumps to the next row on the same frame. A cloned "ghost" of the row is pinned over the old position on an opaque backing, and its content moves 0 → -32 px on X while fading 1 → 0. | 80 ms, `cubic-bezier(0.2, 0, 0, 1)` | Shows where the row went without delaying the next keystroke. | `mail/use-optimistic-archive.ts:83-128` [V] |
| 2 | **Gap close after archive** | Rows below are measured before and after the change, then animated from their old Y to 0 (FLIP). | 100 ms hold, then 100 ms, same curve, `fill: backwards`. Rows off screen are skipped. | Holds the empty slot briefly so the eye sees what disappeared, then closes it. | same file, 23-55 [V] |
| 3 | Archive in the promo video | The row slides **right** and fades while the next row already carries the focus bar. The gap is held for a beat. | Not measurable; the video is edited. | Evidence of the same pattern in an earlier build, in the opposite direction from the current code. | `ui/video-frames/home-archive-exit-sequence.png` [O] |
| 4 | Split-tab active underline | Shared-layout slide of a 2 px bar between tabs | 200 ms ease-out; 0 under reduced motion | Spatial continuity when switching tabs with Tab | `mail/SplitTabs.tsx:275-281, 353` [V] |
| 5 | Split-tab reordering | Tabs animate to their new position while dragging. The dragged tab drops to 40% opacity, and a floating pill with a grip handle follows the pointer. | 150 ms ease-out; dragging starts after 4 px of movement | Direct manipulation | `SplitTabs.tsx:238, 290-315, 351-352` [V] |
| 6 | Tab rule on scroll | The rule's border color appears only once the list scrolls under it | 150 ms, Tailwind's default transition (`cubic-bezier(0.4, 0, 0.2, 1)`) | Calm chrome at rest, separation only when needed | `MailSplitTabs.tsx:245`, `MailShell.tsx:1545` [V] |
| 7 | **Reader message rail** | A 4 px blue bar's translateY and height follow the selected message. It jumps with no animation on resize, and the slide runs only when the selection changes. | 200 ms ease-out | Shows which message the arrow keys address | `components/email-list/EmailThread.tsx:690-737` [V] |
| 8 | **Reader swap** | No transition. The next thread renders hidden while the previous one stays visible, until its data has arrived *and* every email iframe reports it has been measured, or 2 s pass. | 2,000 ms deadline, checked every animation frame | Avoids blank or reflowing frames during J/K | `mail/BufferedThreadReader.tsx` [V] |
| 9 | Neighbor warming | Not visual: the threads around the open one are kept observed by the engine | n/a | J/K lands on content that is already loaded | `mail/use-warm-neighbour-threads.ts` [V] |
| 10 | List loading | Fast local reads deliberately show *nothing*, with no spinner flash. During sync the list shows a mini spinner with a short "syncing" line. The reader shows a loading line only when there is no previous thread to keep. | Spinners use the default 1 s linear spin | Avoids flicker | `MailShell.tsx:454-473`, `BufferedThreadReader.tsx:94-101` [V] |
| 11 | Sidebar group expand and collapse | Height, using the measured content height | 150 ms ease-out | Disclosure | `tailwind.config.js` (collapsible keyframes), `MailSidebar.tsx:770` [V] |
| 12 | Disclosure chevron | Rotates 90° | 150 ms default | Shows state | `MailSidebar.tsx:784` [V] |
| 13 | Sidebar to icon rail | Width transition | 200 ms **linear** | Collapse | `components/ui/sidebar.tsx:287, 297` [V] |
| 14 | Panel resizing | While dragging, **every** transition is disabled and the cursor is forced to the resize cursor. Double-click resets the width. | n/a | Edges track the pointer exactly | `styles/globals.css` (`body[data-resizing]`), `MailListPanel.tsx` [V] |
| 15 | Assistant panel | translateX 100% → 0, over the content | 200 ms **linear** | Opening a side panel | `components/SidebarRight.tsx:32-34` [V] |
| 16 | Dialogs (settings, label picker, new split, shortcuts, ⌘K) | Overlay fades in to 50% black. Content fades, scales from 95% and slides in from the stock shadcn offset of 48%. | 200 ms; curve is a library default | Modal entry | `components/ui/dialog.tsx:24, 50` [V] |
| 17 | Menus, popovers, context menus, selects, hover cards | Fade, scale from 95%, and an 8 px slide from the trigger side | Library default (about 150 ms) [I] | Anchored entry | `components/ui/dropdown-menu.tsx`, `popover.tsx:24` [V] |
| 18 | Tooltips | Same as menus, with a 200 ms open delay | Library default | Key hints | `components/Tooltip.tsx`, `ui/tooltip.tsx:49` [V] |
| 19 | **Compose window** | **No animation.** The dialog is marked unstyled, so the stock entry classes are dropped. Expanding to full window and restoring are instant. | 0 | (none) | `providers/ComposeModalProvider.tsx:134-160` [V] |
| 20 | Sheets (narrow sender pane, mobile sidebar) | Slide from the edge, plus an overlay fade with a small blur | 500 ms in, 300 ms out, ease-in-out | Mobile and narrow layouts | `components/ui/sheet.tsx:29, 40` [V] |
| 21 | Toasts (Sonner) | Library enter and exit plus swipe-to-dismiss. Bottom-left, 8 px gap, close button, a 3 px colored rail on the left (blue, red or amber), no success icon. Undo toasts show a `Z` key cap. Errors stay 10 s. | Library defaults (the `sonner-fade-in`, `swipe-out-*` keyframes appear in the live CSS) | Confirmation and undo | `components/Toast.tsx` [V]; computed keyframes on the live site [V] |
| 22 | Row hover and checkbox reveal | The row background changes with no transition. Checkboxes fade in on hover or focus, and stay visible once anything is selected. | Instant; opacity 150 ms | Low-noise affordance | `ThreadRow.tsx:150-160`, `MailThreadRow.tsx` [V] |
| 23 | Removable label chip | The chip's background grows to the right to reveal an ×, which fades in | 150 ms default | Shows a hidden action | `MailLabelChip.tsx:38, 59` [V] |
| 24 | Chat | Stick-to-bottom smooth scrolling. The jump-to-bottom button fades and scales from 0.8 to 1. | 150 ms | Streaming answers | `components/ai-elements/conversation.tsx:84-108` [V] |
| 25 | Bulk-action floating bar (Bulk Unsubscribe) | Fades and rises 8 px | 150 ms ease-out | Selection actions | `bulk-unsubscribe/BulkActions.tsx:224-231` [V] |
| 26 | Reduced motion | A global rule clamps every animation and transition to 0.01 ms, and the JS paths check the media query too | n/a | Accessibility | `styles/globals.css` (`prefers-reduced-motion`), `use-optimistic-archive.ts:88`, `SplitTabs.tsx:71` [V] |
| 27 | Marketing only | Hero text rises 6 px while a 6 px blur clears (400/600 ms ease-out). Scroll-in uses a "blur fade" (600 ms, 6 px). A logo marquee scrolls. Buttons transition over 150 ms. | as stated | Landing polish | `tailwind.config.js:46-70`, `components/new-landing/common/BlurFade.tsx:35-40` [V]; computed transitions on the live site [V] |

**What the video adds** (`ui/video-frames/home-keyboard-sequence-5.6-7.9s.png`) [O]. J moves the focus bar one row per press. After E, focus is on the next row in the very next sampled frame. ⌘K dims the list and centers the palette, whose first action shows its key cap. The camera moves, 3D tilt and blur crossfades between scenes (`home-t24.jpg`, `client-t30.jpg`) are video editing, not product motion.

**Assessment.** The motion that *carries information* is excellent and very short: items 1, 2, 4 and 7, all 80-200 ms with strong ease-out curves. Everything else is stock shadcn, and two choices are weak:
- the assistant panel and sidebar slide with **linear** easing;
- the compose window has **no** origin at all.

The code also mixes the `motion` and `framer-motion` packages, a sign of drift.

---

## 5. Interaction model

**Keyboard.** One registry of about 45 shortcuts with groups, scopes and key sequences (`apps/web/lib/shortcuts/registry.ts`) [V]:

| Group | Keys |
|---|---|
| Navigate | `j`/`k` or the arrow keys, Enter to open, Esc to go back, Tab for the next split, `/` to search, ⌘K, ⌘1-9 to pick an account and ⌘0 for all accounts, `g` then `a` (back to the app), `g` then `g` (open in Gmail or Outlook) |
| Triage | `e` archive, `s` star, `l` label, `u` unread, `v` move, `h` snooze, `r`/`a`/`f` reply, reply all, forward, `.` more actions, `z` undo, `x` select, ⇧J/⇧K extend the selection, ⌘A select all, `#` trash, `!` spam, ⇧U unsubscribe or block, ⇧E auto-archive the sender |
| View | `m` comments, ⇧T translate, ⇧V layout, ⇧P preview length, `?` help |
| Compose | `c` new message, ⌘↩ send, ⌘⇧↩ send and mark done, ⌘⇧L send later, ⌘⇧H remind me, ⌘⇧U attach, ⌘⇧P pop out, ⌘⇧, discard |
| Assistant | ⌘J |

Tooltips read their key caps from the registry, and buttons show key-cap hints too: Compose shows `C`, and undo toasts show `Z`.

**Triage flow**
1. A focused row shows the accent bar.
2. A key acts on that row, and focus advances instantly while the ghost animates out.
3. After snooze, trash, spam or move, the reader moves on to the next thread, as it already did for archive (changelog, Oct 9).
4. `z` or the toast undoes the action.
5. Multi-select uses `x` and Shift ranges. The toolbar becomes a selection bar.
6. Tab cycles through splits, so "go clear To Reply" is a single key.

There is no swipe on desktop. The iPhone app is closed source; the video shows a floating bottom tab bar, a floating pill selector for splits, and round icon buttons at the top (`ui/video-frames/client-t25.5.jpg`) [O].

**Compose**
- Replies are inline: a quiet summary line labeled "Draft" (in green) followed by "to …" expands into the editor, with recipients hidden until asked for.
- Below the editor, Send uses the blue gradient and Send later and Remind me are text buttons. On the right sit a `{ }` snippets button (snippets are inserted by typing `/`), attach, inline image and discard. [O: `client-t11.jpg`; V: `compose/ComposeHeaderFields.tsx:216-240`]
- New messages open the floating window described above.
- Undo send holds a message for 10 s (changelog, Oct 10). After sending, a toast offers to view the sent message.

**AI surfaces**
1. **Drafts written ahead of time.** Server-side rules draft replies, and those drafts appear as *plain drafts*: "Draft" plus a count in blue next to the sender in the list, and an editable "Draft" inline in the thread. There is no AI badge. [O: `home-t1.jpg`, `client-t11.jpg`]
2. **AI labels** become chips and splits.
3. **Assistant chat** in the right panel (⌘J, sparkle button).
4. **"Describe it"** to create a split from a description.
5. **Translate** on demand (⇧T), with "Show original".
6. **"Matched reason"**, a submenu explaining why a rule labeled the message.
7. **Sender public context** pane.
8. **"Create rule for sender".**

The AI is never shown as an inline summary of a message, which is a large difference from Aplos.

**Onboarding.**
- Users first choose the AI assistant, the email app, or both (`onboarding/StepIntent.tsx`).
- The email-app-only path has **one** further step: the launch video plus a short tagline, then the inbox (`onboarding/StepMailApp.tsx`, `onboardingFlow.ts:49`).
- New inboxes come with default splits already created.

**Empty states.**
- An empty view shows a static SVG sunrise (sky, sun, water, reflection bars, three birds) with a one-line headline in the title face. The headline says you have reached inbox zero, or "All clear" in a split (`mail/InboxZeroCelebration.tsx`).
- Search and reader empty states are one plain line each. The sunrise has a dark version and no animation.

---

## 6. What is distinctive, and what is generic or bad

**Worth learning**
1. **Perceived speed is engineered, not animated.** The ghost-row exit decouples the animation from the state change, so the next keystroke never waits. The double-buffered reader never shows a half-loaded email. Neighbor warming makes J/K instant. Fast local reads show no spinner.
2. **Motion as spatial evidence only.** Each meaningful animation answers "where did it go?" or "where am I?": the archive slide, the gap close, the tab underline, the message rail. All are 80-200 ms with strong ease-out curves.
3. **Calm chrome.** Rules appear only after scrolling, checkboxes only on hover or selection, chips are capped per row, the sidebar groups the rarely used folders, and the Compose button was recently toned down from a gradient to an outline.
4. **Stable label colors:** fixed semantic hues, hashed user labels.
5. **Two-tier email rendering.** Designed newsletters stay on white paper even in dark mode, while plain mail takes on the theme at a readable 14.5/1.65 in the system font.
6. **AI drafts look like ordinary drafts.** The best AI presentation in the product is the one with no AI chrome.
7. **Key hints from one registry,** including in toasts.

**Generic or bad**
1. **Layout.**
   - Gmail-clone row anatomy: a fixed sender column, a run of chips, then subject and snippet. It is competent but has no point of view. The only real opinion is splits.
   - Chips plus subject plus snippet get noisy. With 3 chips the subject is pushed hard to the right (`client-t6.jpg`).
2. **Visual polish.**
   - Stock shadcn leftovers. Dialogs scale up from 95% with the default 48% slide, and the primitives still hard-code slate colors (`border-slate-200`, `text-slate-950`) that clash slightly with the warm Mail palette.
   - **Linear** easing on the assistant panel and the sidebar collapse.
   - **Blue tooltips** are loud for something you hover a hundred times a day.
   - Sparkle glyphs mark every AI entry point.
3. **Consistency and completeness.**
   - The compose window appears with **no motion or origin**.
   - "Draft" is blue in the list and green in the composer.
   - Dark mode is half finished. The chip palette is light-only, and the desktop app forces the native theme to light.
4. **Marketing drift.**
   - The `/email-client` hero still shows an older Gmail-lookalike illustration (`ui/email-client-desktop-light-fold.png`), while `/download` shows the real app.
   - The marketing site ignores dark mode. The light and dark captures are identical, though the Mintlify docs do switch (`ui/docs-changelog-desktop-dark-fold.png`).

---

## 7. Suggestions for Aplos, in Aplos's terms

These are original adaptations. Do not copy their icons, illustrations, copy, palette or code.

1. **Done and Later exits that never block the next key.**
   - When a Home row is triaged, move keyboard focus to the next item in the *same frame*.
   - Animate a detached copy of the row in the direction of the action. Use Aplos's configurable Done and Later directions, so a keyboard Done and a swipe Done move the same way.
   - Use `--dur-fast` (120 ms) with `--ease-out-strong`. Hold the gap for about 60-80 ms, then close the rows below it over `--dur-base` (160 ms).
   - If the action came from `useSwipe`, carry on from the release velocity instead of restarting from 0.
2. **Double-buffer the Reader once email HTML moves into a sandboxed iframe.** That security fix makes body height asynchronous. Keep the previous email visible until the next one's body reports it has been measured, with a deadline of about 1.5 s. In the engine, keep two threads on either side of the focus pre-loaded, with bodies.
3. **No spinners for local reads.** Show sync state as one quiet line at the bottom of Home or the list. Never put a spinner in place of content that is already cached.
4. **AI as typography, not badges.** Keep the large summary line, the Space suggested action and drafts as plain, well-set text. Use icons that name the action (reply arrow, calendar, link, paperclip) and never a sparkle, wand or star. Add a plain-language "why" disclosure under the summary, for example "important: you've replied to this sender 4 times", in place of an AI-labeled menu.
5. **Every animation from the existing tokens.** Aplos already defines 60/120/160/200 ms and five easing curves (`renderer/ui/tokens.css:68-79`). Ban linear easing for movement. The docked Ask panel should push the content aside, because it is docked. Use `--dur-dock` with `--ease-out-strong`.
6. **Give compose an origin.** The compose window or pop-out should grow from its anchor: start at scale 0.98 and 8 px lower, and reach full size over 160 ms. Inbox Zero's instant appearance is the one place its feel breaks.
7. **A message rail for multi-message threads.** When the arrow keys move between messages in Reader, slide a thin accent rail (about 3 px) with `--dur-base`, and jump without animating when the layout resizes.
8. **Calm chrome rules.**
   - Show the header hairline only after scrolling.
   - Show row affordances (checkbox, inline actions) only on hover or focus.
   - Cap metadata on a Home row at one quiet element after "Sender: summary".
   - Keep tooltips neutral, not brand-colored.
9. **Hashed, stable colors with dark tints from day one.** Fix hues for Aplos's own states (Later, Bookmark, due) and accounts. Hash user labels into a curated set. Ship each hue as a light and a dark pair; Inbox Zero's light-only chips are the warning.
10. **Two-tier HTML.** In dark mode, show designed newsletters on a slightly inset light "paper" card with Aplos's radius, and theme plain mail at about 14.5-15 px / 1.6 in SF Pro.
11. **One key registry feeding the `?` guide, tooltips, menus and toasts.** For example, an Undo toast that shows `Z`. Aplos has `?` already; make tooltips and toasts read from the same source.
12. **Freeze panel transitions while resizing,** with double-click to reset.
13. **Use the Mac chrome Inbox Zero does not.** It has no vibrancy at all. A native sidebar material in Aplos's minimized and full sidebars would set Aplos apart immediately on macOS.
14. **Tab through Home's sections** (New → Waiting on you → Follow-ups) instead of copying split tabs. The owner has rejected reply mailboxes and split view, so keep one reader and no layout picker.
15. **An original empty Home moment** that is quiet and static, does not reuse the sunrise idea, and respects reduced motion.

**Do not copy:**
- the Gmail-style row with a chip run;
- the list/split toggle;
- sparkle icons;
- blue tooltips;
- linear panel slides;
- the stock 95%-scale dialog entry. For Aplos dialogs, prefer about 98% scale with a 4-6 px rise over 160 ms.
