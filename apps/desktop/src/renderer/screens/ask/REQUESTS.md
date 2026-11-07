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
- **`AgendaView` 'today' shows only what is left now** (owner decision, F7 — we edited it, needs
  lane-approved:ui-calendar): finished timed events fold into one quiet "N earlier" line where the dimmed rows
  were, the header counts what is left ("N left today" · next at …, or "Nothing left today" beside the earlier
  count), and the now-line draws only while a timed event remains; the model's `behind` rule is gone.

## ui-reader

- **`openDraftAccount()`** (we edited it, needs lane-approved:ui-reader): exported from
  `screens/compose/runtime/useComposeSession.ts` (and `screens/compose/index.ts`), it reads the mounted
  composers' `liveSessions` and returns the account the newest open composer is writing in. The dock calls it at
  `Ask/run` start so `context.draft.accountId` names the draft's account — and a run fired after the composer
  closed carries none.

## ui-foundation

- **AskTurn `'excluded'` state** (we edited it, needs lane-approved:ui-foundation): `ui/props/ask.ts` adds
  `'excluded'` to `AskTurnProps.state` and an `onOpenSettings` action; `ui/ask/AskTurn.tsx` draws the quiet line
  "This account is turned off for AI. Turn it on in Settings, or ask from another account." with an Open
  Settings text button, styled by the shared dim-line rule in `ui/ask/ask.css`. The model maps an
  `ai.accountExcluded` refusal (or error frame) to it instead of the generic "didn't answer" line.

## engine/contract (already frozen — confirm only)

- `Ask/run` progress carries `turnId` from the first frame; `ai.dailyCap` reason code → the dock's "Paused for
  today. Resumes tomorrow." line (no `ai.dailyLimit`/`ai.paused` codes are emitted today — they are tolerated).
- Interactive Ask has no consent gate of its own; the consent line reuses the background `Consent` record
  (`useConsent`, `Consent/grant`), shown before first use when ungranted or `needsReconsent`, naming the Ask
  feature's provider and model.

## palette (package B — same lane)

- The palette's Ask row calls `askStore.ask(question)` (exported from `screens/ask`): it records the question,
  bumps `openTick` and the host runs it once mounted.
