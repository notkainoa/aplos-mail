# Superlocal: UI, motion and feel study for the Aplos revamp

Date: 2026-10-25. Source: shallow clone of `https://github.com/R44VC0RP/superlocal` at `d3725bc`, in `/Users/knewton/.t3/aplos-research/src/superlocal`. I only read files and decoded the repo's own media. I did not install, build or run anything. Paths are relative to that clone unless they say otherwise. The architecture audit lives in `research/email-clients/arch/superlocal.md`. This report covers only the UI and doesn't repeat the architecture work.

**License: none.** There's no LICENSE file and no `license` field in any `package.json`, so treat the project as all rights reserved. Nothing below is code. Values such as durations and curves are written down as observations.

**Provenance warning (read first).** The visual layer is a deliberate clone of Superhuman:
- `apps/web/scripts/extract-assets.mjs` fetches `@font-face` files from another product's build URLs into `apps/web/public/assets/`. The declared families include proprietary faces (Adelle, Operator Mono, a "SuperMailSans" family and others).
- `apps/web/src/icons.json` keys its 32 SVGs with names that look like DOM class names from another product, for example names that reference an "AISidebar" and a "LabelSwitcher". [I] They were probably lifted from a live page.
- `docs/qa/shortcuts/README.md` audits the keymap against Superhuman's published Mac shortcut PDF.
- The palette, the 36 px rows, the lavender "ink" bar, the Important/Other split and the bolt-shaped command button all follow the same reference.

So Superlocal is useful as a study of *engineering of feel*: how a list holds still, how a cursor glides, how state is acknowledged. It isn't a source of visual identity, and Aplos must not borrow its look, fonts, icons, copy or names.

**How I studied it.** No public site exists (super.local is a local hostname), and running their code is off-limits, so there was nothing to drive headlessly. I used these sources instead:
- The README media: `docs/screenshots/*.png`, plus the 19 s, 12 fps demo GIF.
- The shortcut QA GIFs in `docs/qa/shortcuts/`.
- About 60 before/after screenshots and H.264 recordings under `docs/ui-prs/`, decoded to frames with my own AVFoundation script, because Playwright's ffmpeg build cannot decode GIF or H.264.
- The client source in `apps/web/src`.

Saved media is in `/Users/knewton/.t3/aplos-research/ui/superlocal/` (`readme/`, `uiprs/`, `frames/`). One privacy note: the demo GIF appears to show the author's real inbox, not the fictional mock data the README describes. I haven't reproduced any of its content here.

Evidence labels: **[V]** means verified in source or media at the cited path. **[I]** means inference.

---

## 1. Overall feel

Superlocal is **dense, dark, serious and fast**. It's built for one person who processes a lot of mail by keyboard, across many mailboxes and domains. The default screen is a wall of single-line rows (`readme/unified-inbox.png`, `frames/demo/demo-000.png`), with almost no chrome and no color except a lavender accent, sky-blue unread dots and hue-coded label chips. There is no playfulness. The one decorative moment is a full-bleed photo at Inbox Zero.

The feel comes less from visuals than from **restraint in motion**:
- A single highlight glides between rows.
- Triaged rows slide out without the list jumping under the cursor.
- Every action is acknowledged first as pending and then as confirmed.

The audience is technical: real providers are set up by editing a JSON file (`README.md`, "Connect real providers"). The AI parts read like an engineer's audit log rather than an assistant.

## 2. Layout and information architecture

**Shell [V]** (`apps/web/src/App.tsx` around lines 2110-2700, `style.css`). There are three columns:
- **App rail (40 px).** A circular bolt button at the top opens the ⌘K command palette. Below it, a pill-shaped switcher toggles Mail and Calendar. Settings and the sidebar toggle appear only on narrow screens.
- **Mail workspace (flex, min 520 px).** It holds either the list or the reader, never both. There is no split view.
- **Right sidebar (clamped 260-423 px).** Context-dependent: "Recent Opens" or a mini calendar in the list, search tips while searching, sender context in a reader, your own profile in a draft. A footer holds help, calendar and settings icons plus sync status.

**Inbox framing [V].** The 76 px header contains:
- a hamburger that opens a **folder drawer** sliding over the list from the left (`frames/qa-sheet.png`, top right);
- a **mailbox switcher** ("Unified inbox ⌄", with Ctrl+0 for unified and Ctrl+1-9 for pinned mailboxes);
- **split tabs** with counts, for example Important 80 · Github · Inbound · Calendar · Other. Splits are user-defined search-syntax rules (`Settings.tsx`, "Split Inbox" editor), and Tab / Shift+Tab cycles them;
- a "Get me to zero" text button, refresh, compose and search on the right.

Rows group under 60 px date headings such as "Yesterday" or "September 5th".

**Row anatomy [V]** (`MailRow.tsx`, `style.css` `.mail-row`). Rows are 36 px (30 compact, 44 mobile): hidden select square, 6 px unread dot, bold sender capped at 22.5% width with a muted thread count, subject then muted snippet, one hue-coded label chip, a "To:" column showing which of your addresses received it (useful in a unified inbox), then icons and a tabular-numeral time. On the highlighted row, the metadata is *replaced* by three action icons: Done, Remind and Command.

**Reader [V]** (`message.css`, `ThreadView.tsx`, `readme/conversation.png`, `frames/demo/demo-034.png`).
- The header holds a 21 px subject, a muted sender line, and icon actions on the right (done, remind, command, previous and next).
- Collapsed older messages are one-liners. Expanded messages are cards. The newest message gets a 4 px accent bar on its left edge.
- Received HTML is always drawn on a light "paper" card, even in dark mode. The card's background takes the email's own canvas color (`MessageBody.tsx` `canvasColor`, used as `--message-canvas`), so a grey newsletter gets a grey card (`frames/demo-sheet-b.png`, "Link" frame).
- The inline reply attaches to the bottom of the final card and continues its accent bar (`uiprs/reply-footer-quoted-history_after-expanded.png`).
- A pinned "Add a local comment…" bar sits at the bottom.
- The left quarter of the reader gutter is a **giant back button** that shows a soft gradient on hover (`message.css` `.thread-back-gutter`).

**Command palette [V]** (`MailCommandDialog.tsx`). It is one 680 px dialog with five modes: commands, remind (snooze), label/move, mailboxes, and "teach AI". About 30 commands are filtered by plain substring match with no fuzzy ranking, and the list shrinks when you're inside settings or on a read-only host. A footer explains ↑↓, ↵ and esc. The backdrop is almost transparent (8% black), so the inbox stays readable behind it.

**Other surfaces [V].** Settings is a full-page tabbed document (`uiprs/unified-settings_after-settings.png`); Calendar is a week grid with a mini month (`frames/qa-sheet.png`), backed only by browser storage; floating compose is a 700 px bottom-right card and pop-out a centered dialog (`uiprs/reply-footer-quoted-history_after-popout.png`).

## 3. Visual language

**Typography [V]** (`style.css` `:root`).
- The UI font stack leads with the scraped proprietary sans, with "Helvetica Neue" as the fallback. A "Classic" style swaps in a slab serif.
- The root size is 15 px, but most UI text is small:
  - rows, sidebar and toasts: 12 px;
  - tabs and sidebar titles: 16 px;
  - reader subject: 21 px;
  - kbd caps: 11 px.
- Weights stay low: headings are 400 throughout, and only the sender column and some sidebar names are bold (700/600).
- On 1x displays every size gets 1 px larger with 0.005 em tracking. Times use tabular numerals, and several elements carry ±1 px optical baseline nudges.
- Rendered email defaults to 15 px/1.6 Helvetica Neue on white inside the iframe.

**Spacing rhythm [V].** A fluid `--layout-unit` steps down by viewport width: 18 px above 1680, then 17, 15, 13.5, 12, and 10 px below 1024. Row and header padding are multiples of it (3.5 units on the left, 2 on the right). The reader column is 640 px plus 4 units. A comment in `message.css` says spare width is split between the left action gutter and the reader at roughly 5.25 : 1. The result is that the layout breathes on large monitors without changing structure.

**Color [V].** Dark mode (the default) is warm charcoal: bg `#292827`, sidebar `#1f1e1d`, panel `#383735`, hover/border `#474543`; text white, muted `#bfbcb6`, icons `#8d8a86`. Semantic hues are few: lavender accent `#bea1f5`, sky-blue unread `#72c0ea`, steel-blue multi-selection `#446c85`, plus tiny one-offs for star, reminder and draft. Label chips use OKLCH with a per-label hue (a fixed map for common categories, a string hash otherwise; L 0.88/C 0.08 text on L 0.38/C 0.10 in dark, inverted in light), so a label is the same color everywhere. Light mode is warm paper (`#fcfaf7`) with a deeper purple accent (`uiprs/clear-mail-sync_after-light.png`). Theme (System/Light/Dark), density and font size are separate settings.

**Iconography [V/I].** Icons are 20-unit stroke icons in a muted grey that brighten to the text color on hover. There are no filled icons and no colored icons, apart from stars. Some are hand-drawn paths in `components.tsx`, and the rest come from the suspect `icons.json` [I]. The bolt glyph means "command". It is reused for "Teach AI", so there is no AI-specific glyph at all.

**Surfaces, depth and radius [V].** The base layer is flat, with 1 px borders in the hover color between rail, sidebar and drawer. Shadows appear only on floating things (drawer 8 px 0 24 px at 20% black; toast 0 6 px 30 px; modals 0 12 px 40 px; the palette a heavy 0 15 px 45 px 18 px at 53% black). Blur is essentially unused (1 px on modal backdrops). Radii are small and squarish: 3 px kbd/chips, 4 px rows/cards/toasts, 7 px primary buttons, 8 px modals, 12 px palette. Adjacent selected rows merge by flattening their touching corners.

## 4. Motion

Superlocal has no motion library. Everything is CSS transitions and keyframes plus the Web Animations API in `mail-motion.tsx`. Page-level changes (list→reader, j/k between conversations, opening a modal) are **instant cuts**, which is a deliberate speed choice [I]. The motion system is small but carefully engineered.

| # | What | Property / mechanism | Duration and curve | Purpose | Evidence |
|---|---|---|---|---|---|
| 1 | **Keyboard cursor glide.** One shared highlight layer (a hover-colored background plus a 4 px accent "ink" bar) moves to the active row. | `transform: translateY` on an absolutely positioned layer; opacity | 256 ms `cubic-bezier(0.19, 1, 0.22, 1)` (expo-out); opacity 160 ms on the same curve | Your eye follows one object instead of watching backgrounds blink on and off | `mail-motion.css`, `mail-motion.tsx` `syncHighlight` [V] |
| 2 | **Pointer snaps, keyboard glides.** When the pointer sets the highlight, the transition is skipped. | transition `none` | 0 ms | Hover must feel immediate; only keyboard moves animate | `App.tsx` `instantHighlight: pointerHighlight…` [V] |
| 3 | **Ink re-entry on return from the reader.** The accent bar starts 30 px to the right at 80% height and slides in. | `translateX(30px) scaleY(.8)` → identity; opacity 0→1 | 254 ms `cubic-bezier(0.19, 0.5, 0.22, 1)`; opacity 160 ms | Re-orients you to where you left off, with no page transition | `mail-motion.css` `.mail-motion-bar-ink`, `syncHighlight(…, returning)` [V] |
| 4 | **Triage exit ("ghost").** The removed row is cloned into a fixed, clipped overlay and slides left off the list. | WAAPI `translateX(0 → -100%)` | 200 ms `cubic-bezier(.525, .0825, .215, 1.18)`: slow start, fast finish, slight overshoot hidden by the clip | Shows *where* the mail went, without layout work on real rows | `mail-motion.tsx` `retain` [V]; `frames/demo/demo-101.png` [V] |
| 5 | **Held slots during a triage burst.** Rows below a removed row are pinned in place by injected `translate … !important` rules. The empty slot stays while the cursor moves into it. | `translate` holds; per-batch timer | Each batch releases after **550 ms**. A later batch's offsets include earlier removals, so the gap grows during a burst and the list compacts only after you pause [I from code; the GIF shows a multi-row gap persisting during repeated Done, `frames/demo-sheet-done.png`] | The list never moves under your next keystroke | `mail-motion.tsx` `applyHolds`, `release` [V] |
| 6 | **Compaction.** When holds release, rows jump to their new positions with no transition. The cursor layer glides there over 256 ms. | Rows: `transition: none`; cursor: #1 | Instant rows, 256 ms cursor | Cheap, with no row-level layout animation [I: the jump is masked by the moving cursor] | `.animated-mail-list > .mail-row { transition: none }` [V] |
| 7 | **Motion cancel.** Any scroll, resize or reduced-motion change cancels all holds and ghosts and snaps the cursor. | — | — | Prevents stale holds from fighting a moving scroll position | `mail-motion.tsx` scene setup [V] |
| 8 | **Newest-message accent grows.** The 4 px bar on the latest expanded message grows down from the top. | `scaleY(0→1)` + opacity | 254 ms expo-out `cubic-bezier(0.19,1,0.22,1)`; opacity 128 ms linear; color changes 66 ms linear | Marks the message a reply would answer | `message.css` `mail-focus-grow`, `mail-focus-enter` [V] |
| 9 | **Reader back button appears.** | opacity | 100 ms `ease` | Softens the instant view swap | `message.css` `mail-back-enter` [V] |
| 10 | **Back-gutter hover and press.** | Gradient overlay opacity; arrow background; press scale 0.96 | 160 ms ease-out; 150 ms ease-out; 120 ms ease-out | Makes a huge, invisible hit target discoverable | `message.css` `.thread-back-gutter` [V] |
| 11 | **Folder drawer.** | `translateX(-100%→0)`, opacity, width; visibility delayed on close | 200 ms `ease` | Spatial: the drawer comes from the hamburger side | `style.css` `.folder-panel` [V] |
| 12 | **Toast lifecycle.** No entrance animation. Lifetime is 4 s, or 10 s with Undo or an action. Then it fades out. Hovering pauses the timers and restores it; the shadow deepens on hover. | opacity; box-shadow | Fade-out 2 s `ease-in`; hover restore 200 ms; shadow 400 ms `cubic-bezier(0.25,0.46,0.45,0.94)` | A long, slow fade gives Undo a grace period you can see | `style.css` `.toast`, `App.tsx` ~line 706 [V] |
| 13 | **Pending → confirmed acknowledgment.** "Marking Done…" turns into "Marked as Done · Undo" about 1.5 s later, when the durable receipt arrives. | Text swap | — | Honest about optimistic state | `frames/optimistic-sheet.png` [V] |
| 14 | **Undo-send hold.** The sent reply appears in the thread at once with a "Queued · time" header label. After about 10 s it becomes a plain time with a check mark, the Sent counter increments and Undo leaves the toast. | Text swap | Hold default 10 s, max 120 s | Shows the message as sent while it is still recallable | `frames/send-sheet.png`; `App.tsx` ~line 690 [V] |
| 15 | **Refresh spinner.** | `rotate` | 900 ms linear, infinite, **150 ms start delay** | Quick refreshes never flash a spinner | `inbox.css` [V] |
| 16 | **Background sync bar.** A 3 px track with a 30%-wide segment that ping-pongs. When paused or between batches the segment is stationary at 50% opacity. | `translateX(-100%→333%)` | 1.5 s `ease-in-out` infinite alternate | An ambient "working" signal with no layout shift; determinate `<progress>` is used for the AI backfill | `mail-sync-status.css`, `AiSortingStatus.tsx`; `uiprs/mailbox-sync-progress_after-sidebar.png` [V] |
| 17 | **Inbox Zero reveal.** A full-bleed photo fades in, then settles. | opacity; `scale(1.1→1)` | 180 ms ease-out, then 1200 ms `cubic-bezier(0.22,1,0.36,1)` | The one celebratory moment | `style.css` `inbox-zero-reveal`, `inbox-zero-settle` [V] |
| 18 | **Small controls.** | Toggle knob translate; login button background | 120 ms ease; 120 ms ease-out | Feedback | `style.css`, `application-auth.css` [V] |
| 19 | **Reduced motion.** Global 0.01 ms durations, plus explicit checks in the motion engine. Ghosts and holds are disabled entirely. | — | — | Accessibility | `style.css` end, `mail-motion.css` end [V] |

Not animated: modal and palette open/close, list↔reader, j/k in the reader, compose open, selection, and the hover action icons (a display swap). `docs/ui-prs/demand-inbox/review.md` mentions a "320 ms Undo motion", but I couldn't find an `undo` motion path wired up in `App.tsx`. Restored rows appear to just reappear [I].

## 5. Interaction model

**Keyboard [V]** (`mail-shortcuts.ts`, `shortcuts.ts`, 622 lines of tests in `tests/mail-shortcuts.test.ts`). A pure function maps `(key event, context)` to a typed action. The context includes:
- mode: list, reader, composer or auxiliary;
- editing, modal, drawer, settings and search state;
- whether a "g" sequence is pending.

It ignores IME composition and auto-repeat where that matters. The bindings are a Superhuman-compatible set:
- triage: E done, H remind, W done plus "not important to me", Shift+E undo done, Z undo;
- navigation and selection: gg and Shift+G jumps, g-sequences to folders, Tab between splits, Shift+U/S/I/R filters, X select, Shift+J/K extend selection, V move, L label;
- reader: Enter is reply-all, R reply, F forward;
- global: C compose, / search, ⌘K command, Ctrl+0-9 mailboxes.

In the list, → opens the highlighted conversation and ← opens the folder drawer. Done in the reader advances straight to the next conversation.

**Triage flow [V].** Done and snooze are *local* mailbox workflows, not provider archive. Each action follows the same sequence:
1. The row ghosts out (motion #4).
2. The cursor glides to the next row.
3. A toast says the action is pending, then confirmed, with Undo.

Bulk selection turns the header into an action bar ("2 selected" plus icons) and tints the rows steel blue (`frames/qa-sheet.png`, bottom left). The project tracked UI budgets as acceptance gates in `docs/ui-prs/*/review.md`:
- cached open under 100 ms;
- E/W handler-to-frame under 150 ms;
- 10k-thread startup under 1.5 s.

**Compose [V].** Reply happens inline under the newest card. A text-button row (Send · Send later · Remind me) sits on the left and formatting, calendar, snippet, attach, emoji and discard icons sit on the right. There is a draft label in green. Undo send, send later and "send plus done" are all available. The snooze ("remind") picker in the palette shows **hard-coded example dates** next to its relative options (`MailCommandDialog.tsx`), which looks like leftover prototype content.

**AI surfaces [V].** All AI is optional triage into Important/Other. There is no chat, no summaries and no drafting.
1. **Reader subline.** A quiet "AI: Other ⌄" sits next to the sender under the subject (`uiprs/optional-ai-triage_after-assessment.png`, behind the modal).
2. **"Why?" dialog.** Clicking the subline opens a "Conversation triage" dialog (`ConversationTriage.tsx`, `uiprs/continuous-ai_after-reader.png`). It shows:
   - a one-sentence reason;
   - structured fields: type, reply needed, task, actions, timing, topics, risk, certainty;
   - supporting quoted excerpts;
   - a decision record with policy and schema versions;
   - numeric score contributors;
   - Important / Other / Use automatic buttons and a private feedback note.
3. **Teach AI.** A palette mode takes a free-text rule.
4. **W key.** Triages and records negative feedback in one keystroke.
5. **Get me to zero** (`GuidedZero.tsx`, `uiprs/guided-zero_after-current-batch.png`, `frames/mobile-sheet.png` right). It's a resumable session with a "N handled · M left" counter that runs in two phases:
   - first, a checkbox batch of AI-assessed "no outstanding work" mail, where you uncheck exceptions and confirm in a modal;
   - then one-at-a-time review with **Handle now / Later / Done / Other**.
6. **Sidebar status.** A sorting line shows determinate progress.

There are Preview and Apply modes, so the AI can propose without acting.

**Onboarding and empty states [V].**
- There is no in-app onboarding. First run boots two fictional mailboxes. Real accounts need JSON edits, then Settings → Add Accounts, where forms are rendered from provider descriptors.
- Inbox Zero hides all text and shows only the photo backdrop.
- Other empty states are a single muted, left-aligned 13 px line ("No conversations found here.").
- The list view's right sidebar ("Recent Opens") is **usually empty** in the evidence (`uiprs/guided-zero_after-current-inbox.png`, `frames/demo/demo-000.png`), which wastes about 25% of the window.

## 6. What's distinctive and worth learning, and what's generic or bad

**Worth learning (ideas, not the look):**
1. **Held slots during triage bursts** (#5). This is the most transferable idea. A keyboard user firing E-E-E never sees the target row move; the list catches up when they pause. Most clients either collapse each row (the target drifts) or animate every row (expensive, and it fights rapid input).
2. **One cursor object** (#1-#3): a shared, transform-only highlight layer, with glide for keys, snap for the pointer, and a small re-entry cue after leaving the reader. It's cheap, coherent and calm.
3. **Pending versus confirmed honesty** (#13, #14): "Marking…" → "Marked · Undo", and the in-thread "Queued" label during the undo-send hold. The UI never claims a durable outcome before the store has one.
4. **Hover-paused, slow-fading toasts** (#12). Undo windows feel generous rather than nervous.
5. **The 150 ms spinner delay** (#15) and **an ambient 3 px activity bar in a fixed slot** (#16): status without layout shift. The team even documented a fix that removed a banner that pushed the list down (`docs/ui-prs/demand-inbox/review.md`).
6. **Sender relationship panel** (`SenderContext.tsx`). It shows a 1-5 "exchange level" based on counts of two-way conversations, received and sent totals, a 12-week sent/received bar chart, and recent threads. It explicitly says that this measures history, not trust. It's original relative to its reference, it's computed locally, and it's genuinely useful when deciding what to do with mail.
7. **Explainable, reversible AI.** It shows the verdict as a quiet subline, has a "Why?" with quoted evidence, keeps a Preview mode, offers one-key "done + teach", and uses a batch-then-individual cleanup session.
8. **Email as paper.** The sandboxed, script-less, CSP-locked iframe renders on a light card whose color follows the email's own background. This avoids the ugly "force dark mode on HTML mail" problem and fits the request to keep email HTML out of the privileged renderer.
9. **Typographic care.** Tabular times, small-size tracking compensation on 1x displays, a fluid layout unit, and an OKLCH label hue system that reads consistently in both themes.
10. **A big back gutter** (#10): a Fitts's-law win for mouse users.

**Generic or bad:**
- **Borrowed identity.** The fonts and probably the icons were scraped, and the look, terms and keymap are cloned. That's a legal liability, and it means there's little original visual thinking to learn from.
- **Focus outlines were removed on purpose.** A "quiet focus" PR (`docs/ui-prs/quiet-focus/review.md`) replaced visible rings with a `contrast(1.2)` filter. That's an accessibility regression. Only the guided-zero screens keep real outlines.
- **Explanations leak internals.** The AI explanation dialog shows schema, policy and score internals, and Settings is a wall of caveat text (`uiprs/unified-settings_after-settings.png`). The result reads like an audit log, not a product.
- **Placeholder content shipped.** Remind-me dates are hard-coded, the sidebar mini calendar has a fixed month header, and a profile panel with bio and location fields appears when drafting.
- **Mobile is broken.** At 390 px the rows cram three lines into 44 px and the text overlaps (`uiprs/demand-inbox_mobile-after.png`).
- **Toasts are thin.** They have no entrance motion, and there is a single slot, so a new toast replaces the previous one, Undo included [I from the `setNotice` usage].
- **Search is plain.** The palette uses substring matching with no ranking.
- **An empty sidebar wastes space** on the main screen.

## 7. Concrete suggestions for Aplos (original, in Aplos's terms)

Aplos already has motion tokens (`apps/desktop/src/renderer/ui/tokens.css`: `--dur-fast` 120, `--dur-base` 160, `--dur-slow` 200, `--ease-out-strong`, `--ease-release`), list presence with FLIP glides and swipe (`ui/motion.ts`, `components/MailList.tsx`, row exit 280 ms), a focus card on Home, Done/Later/Bookmark, Space as the AI primary action, and a docked Ask. The suggestions build on that. None of them copy Superlocal's look, words or assets.

1. **Burst-stable triage on Home and All mail.**
   - When E, L or B fire within about 500 ms of each other, let each row leave with Aplos's existing exit, but **defer the collapse of the rows below**. Keep them pinned (transform only) so the focus card or keyboard target lands on the next row in place.
   - Once input has been idle for about 450-550 ms, compact everything in one FLIP glide using `--ease-out-strong`.
   - Cancel immediately on scroll, resize, pointer movement into the list, or reduced motion.
   - This fixes rows sliding under a fast keyboard user without slowing a single action. Add a test that fires three triage keys within 300 ms and asserts that the targeted IDs are the three visible rows in order.
2. **One keyboard target object for one-line rows.** Below the focus card, draw the keyboard target as a single absolutely positioned layer that glides with transforms (about 200 ms, `--ease-out-strong`) instead of toggling per-row backgrounds. Pointer hover should move it instantly, because the owner's rule is that hover retargets the keyboard. When the user returns from the reader, give it a tiny re-entry cue: a 4-6 px slide plus a fade over `--dur-slow`. That tells them "you were here" without a page transition.
3. **Make the offline op queue visible and honest.** Tie toasts to queue state, for example "Archiving…" → "Done · Undo" once the op is durable locally, and "Couldn't reach Gmail · will retry" when it's queued offline. After sending, show the sent message in the thread immediately with an inline "Sending in 7 s · Undo" countdown, so the undo window is visible where the user is looking. Pause toast timers on hover, and give Undo toasts at least 8-10 s plus a slow fade. Keep a short stack of up to three toasts rather than a single slot, so one Undo never erases another.
4. **Calm status for the new paced sync.** The planned sync rebuild (paced backfill, partial failure) needs a fixed-position status line, perhaps in the sidebar footer. It should show a determinate count for backfill ("Older mail · 1,240 of about 8,000"), a 2-3 px indeterminate bar for incremental polls, and a stationary bar with a reason when paused or rate-limited. Delay every spinner by about 150 ms, and never insert banners that push the list down.
5. **A "How you know them" sender panel** inside Aplos's sender-first reader, as a popover or inline block. Compute it from the local SQLite/FTS5 store:
   - first and last exchange;
   - two-way thread count;
   - a small 12-week sent and received rhythm, drawn in Aplos's own style (a dot row, say, not bars);
   - the last three threads.
   Label it as history, not trust. It feeds Ask too: "you've never replied to this sender."
6. **Explainable AI without the audit log.** Keep Aplos's big summaries, and add a one-line *reason* under the Home card or subject ("in Home because they ask you to confirm by Fri"). Add a "Why" popover showing one or two quoted sentences from the thread, reusing Ask's citation-chip treatment, plus "Not important" and "Keep in Home" buttons. Put model, schema and score details behind a developer toggle. Add a single key that both triages and teaches, so there is no separate feedback step. Use a plain word or Aplos's own non-sparkle mark (a small monogram or a dot), never a sparkle, wand or star.
7. **A guided "Clear Home" session.** The owner wants a Home you can finish, and this gives it a structured path:
   - **Step one:** a checklist of mail the AI judged to need no action, with summaries visible. Unchecking an item keeps it for review, and one confirm moves the rest to Done.
   - **Step two:** one card at a time with Done / Later / Reply (Space keeps meaning "suggested action").
   Show a "handled · left" counter, make the session resumable, and undo the whole batch from the toast.
8. **Paper cards for HTML mail in the sandbox.** As email HTML moves out of the privileged renderer into a script-less, CSP-locked iframe, render it on a light card. Sample the email's body background so the card edges match the mail instead of a white box with a grey email inside. Leave Aplos's own plain-text and summary surfaces themed.
9. **A wide back target in the reader.** Make the empty margin left of the reading column a back target, with a faint gradient on hover and a 0.96 press scale on the arrow. This is cheap and very discoverable.
10. **Encode feel as budgets.** Aplos has no logging yet. Add dev telemetry for the time from a triage key to the next frame (target under 50 ms in the handler and under 150 ms to the frame), for cached open (under 100 ms) and for cold start at 10k threads. Treat regressions as test failures, the way Superlocal's PR reviews did.
11. **Small polish.** Use tabular numerals for every time and count, add about 0.005 em of tracking for small text on non-Retina displays, and keep the shortcut resolver a pure, table-tested `(event, context) → action` function covering g-sequences, IME, repeat and typing guards.

What *not* to take: the lavender ink-bar and charcoal look, the Important/Other split naming, "Get me to zero", "Remind me", the bolt-as-command glyph, the removal of focus rings (keep Aplos's `--focus-ring`), a permanently empty sidebar, model internals in user-facing UI, and any of the scraped fonts or icons.
