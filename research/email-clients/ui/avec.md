# Avec: UI, motion and feel (for the Aplos UI revamp)

Prepared 2026-10-25. Target: Avec (https://www.avec.ai), by Nearly Extraterrestrial Technology, Inc. Proprietary: no public source, no license, all rights reserved. Nothing here is copied into Aplos; values below are observations written in my own words.

## In plain English

- **What makes Avec feel good:** the email behaves like a physical card. When you mark it done, it gets tossed away and flooded with one bold colour plus a word. The move is fast, about a quarter of a second, and it gets even faster when you're going quickly. Every action has a key, the main button has a "hold" version for talking, and each finished task ends with a small reward moment.
- **Where Aplos already matches it:** the keys, hold-to-talk, the docked Ask panel, the card deck, undo toasts with keys, the low-importance bundle, Later grouped by due date, and very similar colours and timing.
- **Where Aplos chose to differ, on purpose:** the AI summary is the main line of each email. There's no split view and no Needs reply or Awaiting reply mailboxes. Space runs the AI-suggested action. Aplos works with many providers and has a real calendar.
- **Where Aplos falls short:**
  - Its swipe feedback is faint.
  - Its motion doesn't speed up when you go fast.
  - It has nothing like Avec's toast that offers the obvious next step, and no drag-to-reschedule.
  - It doesn't learn from the importance corrections you make.
  - Its "inbox done" moment is plain text.
- **The biggest warning:** Aplos's palette and layout are now very close to Avec's desktop app. The spec asks for an independent visual identity, so the revamp should make Aplos look clearly like itself.

## Method and evidence

- **Prior work read first, not redone:** `/Users/knewton/.t3/projects/aplos-mail/SPEC.md` (its reference sections record the earlier read-only inspection of Avec) and the five files in `research/inbox-zero/`. I also read Aplos's renderer tokens and motion code (`apps/desktop/src/renderer/ui/tokens.css`, `ui/motion.ts`, `ui/useSwipe.ts`, `styles.css`, `styles/focus.css`) to compare.
- **Public website:** captured with headless Chromium through Playwright at 1440x900 and 390x844, in light and dark colour schemes. I paged through all 13 sections, hovered the section dots and the download button, and played the site's keyboard demo. I also read the site's public CSS and JS bundles (Next.js + Tailwind v4) for motion values. Screenshots are in `/Users/knewton/.t3/aplos-research/ui/avec/`.
- **Public media:**
  - The site's videos: `hero-triage.mp4` (an iPhone triage loop) and `phone-demo.webm`. Frames are in `ui/avec/frames/`.
  - The App Store listing (iTunes lookup API: v1.2.19 released 2026-10-25, 4.94 stars from 444 ratings, iOS 17+), with six screenshots in `ui/avec/appstore/`.
  - Avec's YouTube channel. The most valuable source was **"Avec Desktop Early Preview!"** (`nG7DkWmyF6A`, 11:37, 2026-09-24): a founder walkthrough of the Mac alpha. I sampled it every 2 s (`ui/avec/desktop-preview/seg/`, sheets `sheet-01..16.png`). I re-captured five moments at quarter speed for frame timing (`desktop-preview/dense/` and `dense-*.png`). Video timings are ±1 frame, about 33–40 ms.
  - Also sampled: "Avec - Email app demo" (`yt-demo-sheet.png`) and the calendar promo (`yt-calendar-sheet.png`, brand film only, little UI).
- **Not done, per the hard rule:** I did not open `/Applications/Avec.app` or read its bundle. **One incident:** probing `https://www.avec.ai/mac` with `curl -L` silently redirected to a signed-URL download of the Mac DMG. I deleted the file immediately, unopened and unread.
- **Code reading:** I read site bundles only as observation, not to reuse. The site's stack demo is the team's own web re-creation of the app's card motion. It's strong evidence of their intended motion, but it isn't the app's code.

Verified facts carry a path or URL. Anything marked *inference* is my reading.

## 1. Overall feel

- **Calm, serious and quick, with a little play.** The desktop app is a quiet light-grey canvas holding one white card at a time. A single saturated blue primary button sits at the bottom, and almost nothing else has colour until you act (`desktop-preview/seg/t0176.3.png`).
- **The play is in the commits.** A Done floods the card with solid green and tosses it. The website goes further, with a timed "sort the stack" game and full-bleed colour blocks per section (`site-sections-sheet.png`).
- **Who it's for:** people who dislike email and want it finished, not managed. It's Gmail-only today (App Store description) and phone-first. Desktop is in early-access alpha and is framed as the place to finish what you deferred on the phone (video description). Reviews praise smoothness and speed above features.
- **Density:** medium-low. The list view is ordinary two-line rows; the stack view is very sparse.

## 2. Layout and information architecture

### Desktop app (observed in the public video)

- **Window.** There's a translucent vibrancy sidebar on the left; the wallpaper tints it lavender in some frames (`seg/t0556.6.png`). It holds an account switcher at the top, then Home and Later with counts, then All Mail, Drafts and Sent. A second group has Needs reply and Awaiting reply with counts, then Trash and Spam (Spam shows an outbound arrow, which suggests it opens Gmail; *inference*). The footer has Settings, Send feedback, Contact support and a public Desktop Roadmap link.
- **Toolbar** (top right):
  - Two toggle icons for **stack** (one card) and **split** (list plus reader).
  - Compose.
  - A white **Ask** pill showing its key, `A`, and a "hold to talk" hint.
  - No search field. Ask replaces search.
- **Home in list mode** (`seg/t0174.2.png`):
  - The header shows "New" with a count, a pill that enters the stack with key `N`, and a sort control.
  - Rows are two lines: sender · subject, then a grey AI one-liner, with the time on the right.
  - Hovering a row tints it light blue and shows inline action pills, each with its key: bookmark `B`, a Todo pill with `←`, a Done pill with `✓ →`, and a "⋯" menu.
  - Below the rows come:
    - a **low-importance bundle** card: a count badge plus a comma list of senders;
    - "New todos without a specific date" with **Hide all**;
    - sections for threads that have needed your reply for 2+ business days, and threads where you've been waiting 2+ business days, each with **Hide**.
- **Stack mode** (`seg/t0176.3.png`):
  - One centred card at about 540 px wide. A sliver of the next card shows above its top edge.
  - The card header has the subject, an importance dropdown and "⋯".
  - The bottom bar: bookmark, Todo with `←`, a large blue **Reply** pill with a `Space` keycap and a "hold to talk" sub-label, Done with `→`, and Undo.
- **Split mode** (`seg/t0315.4.png`): the list sits on the left at about 250 px and the reader on the right. The reader has a due chip, the importance dropdown, "⋯" and a close **X** at the right. A floating blue Reply pill sits bottom-right.
- **Later** (`seg/t0430.1.png`): **Todos | Bookmarks** tabs. Todos are grouped Tomorrow / This week / Upcoming / No specific due date, and each row shows its due date on the right.
- **Ask sidebar** (`seg/t0414.4.png`, `t0446.2.png`):
  - It docks on the right at about 250 px, alongside the stack or reader rather than over it.
  - The empty state is an input with a "Hold A to talk" hint and a list of recent chats (title, first line, time).
  - In a conversation: a history button, a "+", a **Beta** pill and a close X. Your question sits right-aligned in a bubble. The answer is plain prose with the key fact in **bold**. The follow-up input is pinned to the bottom.
- **Low-importance sheet** (`seg/t0583.7.png`):
  - A centred modal card with a key hint (`↑ ↓` to move between sender groups) and a sort toggle.
  - Rows are grouped under sender headers with avatars; each row is the subject followed by a grey summary, then the time.
  - Hovering a row shows a preview popover to its right.
  - A green pill at the bottom does **Mark all N done**, with a `→ →` double-press hint.
- **Phone** (App Store, demo videos):
  - The same stack with a bottom bar plus a tab row (stack, later, sort, compose, search, avatar).
  - A "Switch to List" toggle.
  - Swipe down blocks a sender.
  - The low-importance sheet adds an **Unsubscribe** link on each sender group and a "Break out" button (`yt-demo-sheet.png`).

### Website

- **One page, 13 full-height sections**, each snapping into place (CSS scroll snap: mandatory, softened to proximity for fine pointers). You can page with `↑ ↓` or a rail of dots on the right.
- **Dot previews:** hovering a dot shows a thumbnail of that section (`states-sheet.png`).
- **Header:** the wordmark, then two buttons for iOS download and notify. The site hides a Mac variant behind a flag (`desktopLaunch: false` in the page payload).

## 3. Visual language

### Typography

- **Site (verified from CSS and computed styles, `computed-styles.json`):**
  - **Display face:** a licensed variable grotesk (GT Standard VF) with an optical-size axis. Inter is used inside the product mock-ups.
  - **Tracking tightens as size grows:**

    | Use | Size / line height | Weight | Tracking | Optical size |
    |---|---|---|---|---|
    | H1 | 64/64 px | 500 | −0.025em | 30 |
    | Section copy | 28/33.6 px | 400 | −0.02em | 20 |
    | Body | 20/30 px | 400 | about −0.03em | 16 |
    | Small labels | 12–14 px | 500 | −0.025 to −0.035em | — |
    | Mock email body (Inter) | 14/20 px | **440** | −0.01em | — |
    | Mock subject | 18 px | 500 | — | — |

  - The body is a hair heavier than regular for screen legibility.
- **Desktop app (from video):** it looks like the macOS system font at about 13 px for rows and body. Weights are mostly regular, with medium for sender and subject. The design moves the eye with grey levels rather than with size.

### Colour

- **Site tokens** (`main.css`): background #f7f6f4 (a warm off-white), foreground #171717, brand blue #0050ff, accent green #03ce4c, red #f73c1d, sky #36b7ff, surface #e5e2dc.
  - Sections use full-bleed colour plates (brand blue, green, sky, amber, red, taupe).
  - **No dark mode.** There's no `prefers-color-scheme` rule; the dark captures (`landing-desktop-dark.png`) are identical to the light ones.
- **App:**
  - A light warm-grey canvas, white cards, a system-ish blue for the primary button and selected rows, light-blue hover rows.
  - Toasts are near-black.
  - Commit colours are a saturated green (the site demo uses #07AA04) and a neutral grey (#858482) for Todo/Later.
  - The SPEC's earlier inspection records dark surfaces in the app. The public video shows only light.

### Density, iconography, surfaces and radius

- **Spacing and shapes:**
  - The site uses Tailwind's 4 px spacing scale. Section plates and the phone use 20–32 px radii, and the notification card is rounded about 24–28 px.
  - In the app, cards are rounded about 10–12 px and buttons are fully rounded pills.
  - Every keycap is a small light-grey rounded square inline in the label.
- **Icons:** thin monoline icons. The **Polish** button and the AI-detected **Due** chip both carry a small sparkle (`seg/t0222.3.png`, `t0446.2.png`). The Aplos owner bans that glyph.
- **Depth:**
  - App cards sit on the canvas with almost no shadow.
  - The site uses translucent white glass (`bg-white/55`, `backdrop-blur-md`, a long soft drop shadow) for floating notification cards over video.
  - Dot previews get `shadow-lg` plus a 5% black ring.

## 4. Motion

**Source key:** **S** = verified in the website's CSS or JS. **V** = measured from the public desktop video at quarter-speed playback. **P** = seen in phone videos.

| # | What | Property | Duration and easing | Purpose | Src |
|---|---|---|---|---|---|
| 1 | Card toss (keyboard) | translateX(±200%) and rotate(±12°) | 300 ms. Cards leaving with a key accelerate: cubic-bezier(.1,.3,1,0). After a drag the curve turns into a deceleration, (0,0,.58,1) | Physical "thrown away" exit | S |
| 2 | **Rapid mode** | Same as row 1 | Drops to **150 ms** when the previous press was under 300 ms ago | Motion never lags a fast hand | S |
| 3 | Cards behind | translateY(−8 px × depth) and scale(1 − 0.1 × depth); hidden past depth 2 | 300/150 ms, cubic-bezier(.4,0,.2,1), **delayed 6%** of the duration | The deck steps forward a beat after the toss | S |
| 4 | Commit overlay | Opacity of a full-card colour fill (green with left-aligned check and Done; grey with a clock and Later, right-aligned) | 50 ms ease-out (20 ms in rapid mode). The scroll-driven version ramps between 5% and 10% progress | Immediate, unambiguous confirmation | S |
| 5 | Desktop Done with `→` | Card slides right with about 3–5° rotation and a green overlay, then fades | Overlay fully opaque by about 90 ms. Card gone by about **270 ms**. The next card is already in place, with no rise | Same toss on desktop, shorter travel | V (`dense-done-arrow.png`) |
| 6 | Trackpad two-finger swipe | Card follows the fingers and rotates around a low pivot. The tint grows with distance; the centred label appears when the overlay goes opaque (threshold) | About 300 ms from start of movement to label. Left is grey "Todo" with a clock | Direct manipulation; you can see the threshold | V (`dense-trackpad-a/b.png`) |
| 7 | Split-view swipe | Overlay on the reader pane, crossfade to the next email | About 250 ms, then a toast | Same verb in a different layout | V (`dense-split-swipe.png`) |
| 8 | Bulk mark all done | The whole sheet tints green and tosses right | About 250 ms, then the empty state and toast | One big toss for a big action | V (`dense-markall.png`) |
| 9 | "Be here now" reward | A rectangle playing an ocean video grows from the centre and sharpens to fill the pane | About 350 ms. The site has a matching keyframe: opacity 0, blur 32 px, scale .75 to 1 over 800 ms, cubic-bezier(.16,1,.3,1) | Closure / reward | V, S (`dense-beach.png`) |
| 10 | Phone swipe | Opaque green card with a check and Done in the leading corner; the **bottom Done button fills green at the same time** | About 0.5 s for a finger swipe | The gesture teaches the button | P (`frames/hero-detail-a.png`) |
| 11 | Dot preview | Opacity 0 to 1, scale .75 to 1, blur 16 px to 0 | 120 ms; ease-out on enter, ease-in on exit | Quick, soft peek | S |
| 12 | Section scenes | Phone transform; clip-path and background of the card viewport; headline translateY 12–24 px plus opacity | Phone 500–600 ms with cubic-bezier(.645,.045,.355,1); clip-path 500 ms with (.4,0,.2,1); text 200–500 ms staggered 75/100/200 ms; video crossfade 1000 ms | Storytelling | S |
| 13 | Game feedback | Red background flash (opacity 0→1→0); "+1/−1" particles rise 40 px with random drift and rotation; countdown pop (scale .5→1, hold, →.8) | Flash 500 ms ease-out; particles 1 s cubic-bezier(0,0,0,1); countdown 900 ms | Arcade fun | S (`game-states-sheet.png`) |
| 14 | Success fill | Background brand → green, height 50% → 100% | 250 ms, cubic-bezier(.22,1,.36,1) | Satisfying confirm | S |
| 15 | Scroll hint | translateY ±2 px | 2 s ease-in-out, infinite | Gentle invitation | S |
| 16 | Defaults | Colour and background on hover | 150 ms (.4,0,.2,1); colour 120 ms | Hover and press | S |
| 17 | Reduced motion | All durations forced to 0.01 ms | — | Accessibility | S |

**Not resolvable from video:**

- **Toasts:** dark, top-centre, overlapping the toolbar, with a secondary line and key-labelled actions. Their entry motion is too fast to measure.
- **Drag-to-reschedule in Later** (`seg/t0501.4.png`): the dragged row lifts into a floating pill, each date group becomes a labelled drop zone, the hovered zone fills light blue with a "set due on …" label, and the other groups blur.
- **Voice recording:** a red pill with a moving waveform. The body placeholder turns red with "release to generate / esc to cancel".

**The release notes for 1.2.19** mention "smoother list animations". Motion gets ongoing attention.

**Why the motion works:**

- **Commits are instant.** The overlay appears in 20–90 ms.
- **Exits are short and accelerating,** so the card leaves rather than lingers.
- **The deck moves a beat late** (the 6% stagger), which reads as weight.
- **Timing adapts to how fast you type.**
- **Big gestures happen only at closure moments.**

## 5. Interaction model

- **Keys seen** (desktop video and site):

  | Key | Action |
  |---|---|
  | `→` | Done |
  | `←` | Todo/Later |
  | `Space` | Reply; hold to dictate a draft |
  | `A` | Ask; hold to talk |
  | `N` | Swipe through the list as a stack |
  | `B` | Bookmark; also "Be here now" on the empty state |
  | `D` | Add a due date, offered inside the post-Todo toast |
  | `↑ ↓` | Move between sender groups in the low-importance sheet |
  | `→ →` | Mark all low-importance mail done |
  | `Esc` | Cancel a recording |

  SPEC.md lists the fuller set from the earlier inspection.
- **Triage flow:**
  1. Home is importance-sorted. Importance is learned per sender, and you can override it in the reader header. Changing it shows a toast saying the app is learning, with a link to learn more (`seg/t0556.6.png`).
  2. `N` enters the stack. You handle cards with arrows or swipes.
  3. A Todo produces a toast offering a due date (`D`) plus Undo. Due dates are auto-detected and shown as a chip.
  4. The low-importance bundle is cleared in bulk.
  5. The empty state offers the reward, a way home, and undo.
- **Compose:**
  - Replies open inline at the bottom of the card, with From, To and Subject.
  - Holding Space records. Releasing generates a full draft in your style.
  - There's a Polish button and a standard formatting toolbar.
  - On the phone you can hold again to describe changes by voice.
  - Drafts end with a promotional "Sent with Avec" footer **by default** (`seg/t0222.3.png`).
- **AI surfaces:**
  - Ordering and importance (mostly invisible).
  - The grey summary line in rows.
  - Due-date detection.
  - Voice drafting and revising.
  - The Ask sidebar, which acts as search.
  - Summarising notifications.
  - Adding events to Google Calendar.
  - Login-code autofill (App Store).
  - Ask itself has no AI glyph; it uses a magnifier and the word.
- **Onboarding:** not observable in public material for desktop, which is invite-only alpha. The App Store says it's free and Gmail-only, with multiple Gmail accounts handled as one.
- **Empty states:** desktop shows a short line, a blue "Be here now" button with its key, a go-home link with the Today count, and Undo. The phone shows a soft blue radial glow behind a short line, then the ocean scene with "swipe down to exit" (`yt-demo-sheet.png`).

## 6. What is distinctive, and what is generic or bad

### Worth learning from

1. **Commit feedback is binary and bold.** At the threshold the whole card becomes a colour plus a word. That's legible at a glance and with peripheral vision.
2. **Input-rate-aware timing.** Durations halve when you press fast. Motion becomes free for experts.
3. **Gesture ↔ button coupling.** The bar button lights up while you swipe, which teaches the key and button mapping without a tutorial.
4. **Contextual follow-up in the toast.** "You deferred this; want a date? (`D`)" is the next-best action, offered once.
5. **Repetition as confirmation** for bulk actions (`→ →`) instead of a modal.
6. **Drag between date groups** to reschedule.
7. **A closure moment** that changes the space, not just the text.
8. **An importance learning loop that's visible.** It tells you it's learning.
9. **Perceived speed beyond animation:**
   - The founder claims an enrichment pipeline that delivers new mail within about 10 s, Linear-style sync between phone and desktop, and "a dozen or so" LLMs (YouTube description of `nG7DkWmyF6A`).
   - The demo shows a swipe on the phone disappearing on the desktop at once.
   - *Inference:* much of the "smooth" feel is state that is already there.
   - This is server-side infrastructure, which matters for Aplos's planned local daemon.

### Generic or weak

- **The desktop list is ordinary** Gmail-style rows; the stack is where the identity lives.
- **The sidebar duplicates Home:** Needs reply and Awaiting reply are both mailboxes and Home sections.
- **The sparkle glyph** on Polish and Due is the cliché the Aplos owner rejects.
- **The default promotional signature** spends user trust for growth.
- **The low-importance sheet** is dense grey-on-grey 12 px text.
- **The stock ocean video** is pleasant but generic, and the site's 31 MB background video (`wave_desktop.webm`) is heavy.
- **The site has no dark mode** even though the app has one.
- **Ask is still labelled Beta.**
- **Gmail only.**
- *Inference:* a saturated green flood would be harsh on a dark canvas at night unless it's toned down.

## 7. Suggestions for Aplos, in Aplos's own terms

### Where Aplos stands today (from code and prior research)

| | Aplos today | vs Avec |
|---|---|---|
| Keys on every control, hold-to-talk on `Space` and `A`, docked Ask on `A` | Yes | Matches |
| Deck sliver behind the open card (`.deck.has-next`), card fling with rotation | Yes (`styles.css` 331–368) | Matches |
| Toasts with keyed actions and undo | Yes (`ui/Toast.tsx`) | Matches |
| Low-importance bundle with its own background; Mark all done | Yes (`App.tsx`) | Matches; Avec adds sender grouping, preview and unsubscribe |
| Later grouped by due date; a reminder returns mail to Home | Yes | Matches; Avec adds drag-to-reschedule |
| Optical tracking scale; durations 60–200 ms; triage exits 240–270 ms | Yes (`tokens.css`) | Matches Avec's tempo |
| Palette: canvas #e5e4e1, white cards, blue #0682fe, green #0a9c0a | Yes | **Too close** to Avec's desktop look |
| AI summary as the primary line and atop the reader; Space runs the AI-suggested action; no split view; no reply mailboxes | Owner's choices | **Diverged on purpose** (Avec: subject first, Space is Reply, split view, reply mailboxes) |
| Multi-provider, real calendar, confirm-only AI | Yes | Aplos ahead |
| Commit tint | 14–22% wash (`.fling-done`) | **Falls short:** weak signal |
| Rapid-mode timing, gesture-to-button coupling, follow-up toasts, drag reschedule, learning feedback, closure moment | No | **Falls short** |
| Triage exits animate `height` (`focus.css` `card-out-*`) | Yes | **Perf risk:** layout work every frame |
| Cross-device state appears instantly | No: 60 s polling | **Falls short;** an architecture issue |

### Concrete suggestions (original; no Avec assets, copy, icons or branding)

1. **Make commits unmistakable, but in Aplos's calm voice.**
   - Keep the wash proportional to drag progress.
   - When the existing `data-armed` attribute flips, switch to a solid fill in a **deeper, less saturated** Aplos tone, with the action's own SF Symbol and verb in the direction of travel.
   - In dark mode cap the fill near 70% opacity over the card so it doesn't flash.
   - Overlay-in should take ≤60 ms; exit about 220 ms and accelerating.
2. **Rapid mode.**
   - Track the time since the last triage key. Under about 300 ms, cut the fling and deck transitions roughly in half (≈120–140 ms) and drop the deck stagger.
   - Commit the queue immediately and never make a key wait for an animation.
   - Add a `--dur-rapid` token beside the existing `--dur-*` set.
3. **Give the deck weight.** After a fling, let the next card settle from about 98.5% scale and 4 px down, with a 15–20 ms delay. Aplos already has a `frame-in` scale of .985. Skip this in rapid mode.
4. **Couple gestures to the bar.** While a swipe is armed, the matching bottom-bar button takes on the same tint, so the mouse user learns the key.
5. **Next-best-action toasts.** One per action, always with a key. Two triggers to start, both clear rather than AI-guessed:
   - After Later: "Set a date? `D`".
   - After Done on a thread that's waiting on someone else: "Remind me if no reply? `R`".
6. **Confirm by repetition** for destructive or bulk actions in the low-importance bundle: the first press arms and shows "press again", the second commits. Replace the button-only path.
7. **Drag to reschedule in Later.** While dragging, date groups become labelled targets. Snap to the group's date and show a toast with Undo.
8. **A closure moment of Aplos's own.**
   - When Home empties, run a ≤400 ms, skippable, reduced-motion-safe transition into a quiet full-pane scene: a slow generative sky gradient from the Aplos icon palette.
   - Add one or two facts that are actually useful: how many emails were handled, and the next calendar event.
   - No stock video, no gamification noise.
9. **Visible learning.** When the owner changes importance, show a toast saying Aplos will treat this sender this way from now on, with Undo. Store it as a deterministic sender rule ahead of any model call; this matches the learning-loop recommendation in `SYNTHESIS.md`.
10. **Group the low-importance bundle by sender** with a hover preview and an unsubscribe action per group, once `List-Unsubscribe` lands (a known Aplos gap).
11. **No sparkle glyphs:**
    - The due-date chip uses a calendar or clock symbol.
    - Polish uses a text or pen symbol.
    - AI content is shown as well-set text, as the owner's memory notes require.
12. **Perf hygiene.** Replace the `height`-collapsing exits in `focus.css` with transform/opacity plus a FLIP for siblings, or collapse after the animation ends.
13. **Identity.** Before polishing further, move away from Avec's look:
    - Pick a distinct primary hue rather than system blue, and a distinct commit pair.
    - Consider a characterful display face for the few large moments (summary line, empty state) while keeping SF for the UI.
    - Try a slightly heavier body weight (about 450 if SF's variable weights render well in Electron; test first).
    - Avec's site shows the value of size-scaled negative tracking; Aplos already has it, so extend it to any new display face.
14. **Ask polish.** In the empty Ask state, list recent chats with the time. Bold the one decisive fact (date, amount, name) in answers. Keep the confirm cards; they're Aplos's trust advantage.
15. **Speed is architecture too.** The "everything's already there" feel comes from push and local state. For the local-daemon revamp, the UI should get diffs pushed from the daemon (no polling round trip). Every triage should be optimistic. Phone and desktop should share the daemon's state, so a swipe on one shows on the other within a second while both are on the same network.
16. **Website.** Aplos's site already uses live demos. Add keyboard paging only if it stays light, and keep video assets small. Don't recreate a timed sorting game; that's Avec's signature.

## Evidence index

Paths are under `/Users/knewton/.t3/aplos-research/ui/avec/`.

- **Site:**
  - Landing: `landing-{desktop,mobile}-{light,dark}{,-full}.png`.
  - Sections: `section-desktop-01..13.png`, `site-sections-sheet.png`, `site-sections-sheet-2.png`.
  - Interaction states: `states-sheet.png`, `state-get-notified.png`, `game-states-sheet.png`, `game/`.
  - Text and styles: `landing-text.txt`, `computed-styles.json`.
- **Site motion source:** `/Users/knewton/.t3/aplos-research/avec-raw/main.css`, `js_15ucqt0rvivnm.js` (stack demo), `js_18kvxp0bgfa8m.js` (scenes). These are downloaded public bundles, kept outside the repo.
- **Desktop app (public video):** `desktop-preview/sheet-01..16.png`, key frames `desktop-preview/seg/t0174.2.png`, `t0176.3.png`, `t0216.5.png`, `t0222.3.png`, `t0235.8.png`, `t0263.7.png`, `t0315.4.png`, `t0414.4.png`, `t0430.1.png`, `t0446.2.png`, `t0501.4.png`, `t0556.6.png`, `t0583.7.png`, `t0601.0.png`, `t0605.7.png`. Motion sheets: `desktop-preview/dense-*.png`.
- **Phone:** `frames/hero-sheet-1..4.png`, `frames/hero-detail-a..c.png`, `frames/phone-demo-*.png`, `yt-demo-sheet.png`, `appstore-sheet.png`.
- **Scripts:** `/Users/knewton/.t3/aplos-research/tools/avec-scripts/` (headless only).
