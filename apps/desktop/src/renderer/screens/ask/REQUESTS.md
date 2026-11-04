# REQUESTS (ui-ask package A → other lanes)

Changes the Ask dock and Today tab need in files this package does not own. Each is additive; until it lands the
host degrades quietly as noted.

## ui-shell

- **Dock slot.** Mount `<AskDockHost tab={dock.tab} onTab={open(tab)} onClose={close} />` as the 360 px second pane,
  8 px from the main pane (`--shell-pad`, `--elev-pane`, `dock` motion — slide the contents, FLIP the pane, never
  animate width). Closed on first run (`Settings.ui.dock.open`, default false); remember open/tab/width in
  `Settings.ui.dock` (the host persists `width` itself). The pane-header Ask button runs `ask.open` (icon
  `text.bubble`, pressed state while open, ⌘J keycap); the calendar button runs `nav.today`. `askStore.open(tab)`
  / `askStore.ask(question)` already record the request and bump `openTick` — subscribing to `useDock()` is the
  simplest wiring. Until then the dock never mounts.
- **Ask key context.** The dock root already carries `data-keyctx="ask"`; the shell's key stack picks it up when
  focus is inside. `ask.open`/`ask.toggleDock`/`nav.today`/`ask.dictate` are global commands and work today.
- **Target for "Ask about this email".** `useCurrentTarget()` already feeds `Ask/run`'s `context.threadId`. No ask.
- **Thread deep link.** A message citation opens its thread via `openThread(threadId)`; the citation knows the
  `messageId` too, but `OpenThreadOptions` has no `messageId` field yet — add one so the reader can scroll to the
  quoted message. Until then the citation opens the thread at its top.
- **Event deep link.** An event citation and Today's event `onOpen` only `navigate('calendar')` — there is no
  `openEvent` route. Add one (screen + event id) when the calendar screen lands.

## ui-calendar

- **`calendar.newEvent` handler.** Today's empty-day "New event · N" action currently navigates to the Calendar
  screen; attach `calendar.newEvent` there so it opens the create flow on today.
- **`useCalendars` hook or `Calendar` state frames.** Today fetches `Calendar/get` once per mount; a watched hook
  would keep names/colours live.
- **`AgendaView` 'today' re-derives `behind` and the gaps.** `screens/today/today.model.ts` now picks `behind` as the
  most recently ENDED event and each gap from the running `free` cursor, but `ui/calendar/AgendaView.tsx`
  `TodayAgenda` computes its own from start-sorted rows: `behind` is the latest-STARTED ended event, and each gap is
  measured from the previous shown event's end rather than the latest end so far, so a long overlapping event yields
  a wrong or missing "Free for …" line. Until it lands the model is right but the agenda the Today tab draws can
  disagree.

## engine/contract (already frozen — confirm only)

- `Ask/run` progress carries `turnId` from the first frame; `ai.dailyCap` reason code → the dock's "Paused for
  today. Resumes tomorrow." line (no `ai.dailyLimit`/`ai.paused` codes are emitted today — they are tolerated).
- Interactive Ask has no consent gate of its own; the consent line reuses the background `Consent` record
  (`useConsent`, `Consent/grant`), shown before first use when ungranted or `needsReconsent`, naming the Ask
  feature's provider and model.

## palette (package B — same lane)

- The palette's Ask row calls `askStore.ask(question)` (exported from `screens/ask`): it records the question,
  bumps `openTick` and the host runs it once mounted.
