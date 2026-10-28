// ui-ask: the pending list turned into covered markers, real node tests and remaining todos.
// Todos kept per plan: dom/visual/browser checks wait for the Playwright harness, media for Electron,
// one round trip for live, parser parity for the engine. Nothing here edits source.
import { describe, test } from 'node:test';

describe('ui-ask: Ask dock (dom)', () => {
  // covered: ask.test.ts: "<script.name>: cites or says "No source in your mail"; input never disabled; follow-ups queue" (20 scripted answers)
  test.todo(`ask answer cites or says no source – every one of 20 fixture answers shows ≥ 1 [n] chip or "No source in your mail" (U7 acc. 4) [waits: Playwright base]`);

  // covered: ask.test.ts: "ask decisive span single – the first emphasised range stays, later ones are plain"
  test.todo(`ask decisive span single – each answer has at most one weight-500 span [waits: Playwright base]`);

  // The quote, source name and date already come from the model (ask.test.ts, "ask citation hover data and open target");
  // what is left, popover on hover/focus, needs the rendered dock.
  test.todo(`ask citation hover shows quote and source – hover/focus [1] shows the quote and "Mina Cho · Oct 27 · Hollow Creek review" [waits: Playwright base]`);

  // covered: ask.test.ts: "ask citation hover data and open target"
  test.todo(`ask citation click opens thread at message – click [1] opens the reader on threadId scrolled to messageId [waits: Playwright base]`);

  // covered: ask.test.ts: "ask working step line names the real step, then folds into "Read 14 emails from Jordan · 3 steps""
  test.todo(`ask working step line names real step – first step frame renders "Reading 14 emails from Jordan" as one line; folds into a step log "Read 14 emails from Jordan · 3 steps" [waits: Playwright base]`);

  // covered: ask.test.ts: "<script.name>: cites or says "No source in your mail"; input never disabled; follow-ups queue"
  test.todo(`ask input never disabled while streaming – field accepts text during every streaming frame (over the 20 fixture answers, U7 acc. 4) [waits: Playwright base]`);

  // covered: ask.test.ts: "a queued follow-up runs after the final frame, in order"
  test.todo(`ask follow-up queues as editable card – Return during a run adds a "Queued" card; it runs after the final frame (U7 acc. 4) [waits: Playwright base]`);

  // covered: ask.test.ts: "ask proposal accept applies once – Return on an empty field accepts; the card shows its receipt; Undo restores it"
  test.todo(`ask proposal accept applies once – Add creates one event, shows "Added to Calendar · …", toast with Undo; Z removes the event and restores the card [waits: Playwright base]`);

  // covered: ask.test.ts: "ask proposal dismiss persists – Not now hides the card, and the stored dismissal keeps it hidden"
  test.todo(`ask proposal dismiss persists – Not now hides the card; reopening the conversation keeps it dismissed [waits: Playwright base]`);

  // covered: ask.test.ts: "ask proposal nothing applied without confirm – no decide effect until Add or Return; a refusal reverts the card"
  test.todo(`ask proposal nothing applied without confirm – no Event/set or Thread/act call before Add [waits: Playwright base]`);

  // covered: ask.test.ts: "ask no provider before asking – not ready shows the no-provider state, not an error"
  test.todo(`ask no provider before asking – ai-off: dock shows "Ask needs a provider. Choose one in Settings." and the link; no red text [waits: Playwright base]`);

  // covered: ask.test.ts: "ask provider error line – "Groq didn't answer." with Retry and Use another provider; Retry re-runs once"
  test.todo(`ask provider error line – ask.failNext(aiProvider groq): "Groq didn't answer." with Retry and "Use another provider"; Retry re-runs once [waits: Playwright base]`);

  // covered: ask.test.ts: "ask use another provider lists ready providers other than the failing one"
  test.todo(`ask use another provider lists configured chat providers – the menu excludes the failing and unconfigured providers [waits: Playwright base]`);

  // covered: ask.test.ts: "ask provenance on hover – "Answer by Groq"; a local model says "on this Mac""
  test.todo(`ask provenance on hover – hovering the answer shows "Answer by Groq"; Ollama shows "on this Mac"; nothing shows at rest [waits: Playwright base]`);

  // The recents' relative times are drawn from the demo data in the preview, not from these model files.
  test.todo(`ask recents with times – demo shows three recents with "9:42 AM", "Yesterday", "Mon" [waits: Playwright base]`);

  // covered: ask.test.ts: "ask new chat – ⌘N clears to the empty state and the next question starts a new conversation"
  test.todo(`ask new chat – ⌘N clears to the empty state and the next question creates a new conversation [waits: Playwright base]`);

  // The scenario needs the stand-in harness state ai-budget-spent; no model here settles it.
  test.todo(`ask works under ai-budget-spent – the scenario answers a question normally [waits: Playwright base]`);

  // Needs a held key, level meter and stored audio: the hidden Electron window's keypresses and mic.
  test.todo(`dictate to ask – hold A 300 ms: level meter shows; release puts transcribe.result text in the field; audio goes through Blob/put, never base64 [waits: Electron]`);

  // npm run eval:ask with a real Groq key read only from the backend environment (U7 acc. 5, plan 30 6.5 #5).
  test.todo(`ask live Groq round trip – one real Groq Ask in Electron dev, key read from the backend environment only and never printed; npm run eval:ask; a mocked provider does not count (U7 acc. 5; added, the map did not list it; agent-run live check per plan 30 6.5 #5, days 12-13) [waits: live]`);
});

describe('ui-ask: Today (dom)', () => {
  // covered: today.test.ts: "today agenda – headline, past dimmed, next marked, gaps from now to the last event"
  test.todo(`today agenda – today-busy: heading, "4 events · next at 11:00 AM", past dimmed, next bold, now line at 10:00, gaps "Free for 2 h 45 min" and "Free for 3 h"`);

  // covered: today.test.ts: "today updates on clock – past 11:15 the next event is the 2:00 PM review"
  test.todo(`today updates on clock – advancing the clock past 11:15 moves "next" to the 2:00 PM event`);
});

describe('ui-ask: Palette (dom / node)', () => {
  // covered: palette.test.ts: "palette first open groups – only Suggested and Go to, at most nine rows, numbered in order"
  test.todo(`palette first open groups – shows only Suggested and Go to, numbered 1-9`);

  // covered: palette.test.ts: "palette reach – every catalog command is reachable in the palette by its label (U7 acc. 1)"
  test.todo(`palette reach – every registry command with palette !== false is reachable by its label (U7 acc. 1)`);

  // covered: palette.test.ts: "palette settings reach – a registered Settings row is a palette entry that opens its route"
  test.todo(`palette settings reach – every SettingRow registers a palette entry (U7 acc. 2)`);

  // covered: palette.test.ts: "palette context line truthful – over 30 contexts the line names the target the commands get, or is absent"
  test.todo(`palette context line truthful – property test over 30 contexts: the line names the focused target or is absent (node)`);

  // covered: palette.test.ts: "palette scoring oracle – fuzzed against an independent oracle (2000 queries)"
  test.todo(`palette scoring oracle – fuzzed against a second agent's oracle: exact > prefix > word boundary > subsequence; recents never beat exact (node)`);

  // covered: palette.test.ts: "palette nested page breadcrumb – "Move to label…" shows a trail and the labels; Esc returns one level"
  test.todo(`palette nested page breadcrumb – "Move to label…" shows a breadcrumb and the labels list; Esc returns one level`);

  // covered: palette.test.ts: "palette destructive defaults to cancel – Return cancels, ⇧Return confirms; the live region says so"
  test.todo(`palette destructive defaults to cancel – Return cancels, ⇧Return confirms; the live region announces the choice`);

  // covered: palette.test.ts: "palette esc never navigates – over random walks, Esc only goes up a level or closes (U7 acc. 1)"
  test.todo(`palette esc never navigates – Esc closes or goes up a level and never changes the route (U7 acc. 1)`);

  // Neither palette.model.ts nor its file comment states a timing budget, and "large-100k" names app state, not this list.
  test.todo(`palette budgets – open < 50 ms, filter one keystroke < 16 ms at large-100k [waits: Playwright base; DESIGN 5 budget, measured by the perf suite]`);
});

describe('ui-ask: Search (dom / node)', () => {
  // The token parse is covered by search.test.ts ("search operators become tokens – from:, to:, …"); the pill drawing
  // and Backspace removal live in the page, beyond the model's exports.
  test.todo(`search operators become tokens – typing from:jordan makes a pill; Backspace on an empty field removes it [waits: Playwright base]`);

  // Parity asks the engine side of the same specification; there is no engine module in this lane to compare with.
  test.todo(`search parser parity – the renderer's pills and the engine spec come from the same parseSearch for 100 fuzzed queries (node) [waits: engine]`);

  // covered: search.test.ts: "search local as you type – typing never asks Google"
  test.todo(`search local as you type – each keystroke updates the window; zero remote calls (U7 acc. 7, spy)`);

  // covered: search.test.ts: "typing never calls remote; Return calls it exactly once, including across a reset (U7 acc. 7, fuzzed)"
  test.todo(`search remote exactly once – Return calls Search/remote once; a second Return with unchanged text calls nothing; reset does not re-call`);

  // covered: search.test.ts: "search remote merge – "From Google" lists only threads that joined the window after Return"
  test.todo(`search remote merge – "From Google" lists only hits absent from "In your mail"`);

  // covered: search.test.ts: "search remote paused – Return while paused shows the pause line with the resume time and asks nothing"
  test.todo(`search remote paused – rate-limited: Return shows the plain pause line with the resume time and no Google call`);

  // covered: search.test.ts: "search no match – "No mail matches 'dentist'." with the Google offer on the line itself"
  test.todo(`search no match – "No mail matches 'dentist'." plus "Search all mail on Google · Return"`);

  // covered: search.test.ts: "search to palette – ">" first opens the palette with the rest; the field keeps its text"
  test.todo(`search to palette – typing > opens the palette`);
});

describe('ui-ask: keyboard paths (dom)', () => {
  test.todo(`A tap focuses ask – A opens the dock (if closed) and focuses the field on keydown [waits: Playwright base]`);

  // The window's real keypress timing and the mic harness are not reachable from the browser preview page alone.
  test.todo(`A hold dictates – hold past 250 ms starts dictation; inside the field the typed "a" is removed when the hold completes [waits: Electron]`);

  test.todo(`cmd J toggles dock focus safe – ⌘J toggles; focus moves to the field or back to the list, never lost [waits: Playwright base]`);

  test.todo(`shift A opens today – ⇧A opens the dock on Today; the calendar button is pressed [waits: Playwright base]`);

  // covered: ask.test.ts: "ask esc ladder – Esc stops a run, then clears text, then dismisses a pending proposal, then closes; never navigates"
  test.todo(`ask esc ladder – Esc stops a run, then clears text, then dismisses a pending proposal, then closes the dock; never navigates`);

  // covered: ask.test.ts: "ask cmd return search all – ⌘Return asks with searchAllMail; while streaming it sends the queue now"
  test.todo(`ask cmd return search all – ⌘Return in the field sends searchAllMail: true`);

  // covered: ask.test.ts: "ask cmd return in queued card – sends that card now and stops the running answer, keeping its text"
  test.todo(`ask cmd return in queued card – sends that card now (cancels the current run)`);

  // covered: ask.test.ts: "ask recents with times, suggestions, and ↑/↓ through them; Return asks the one under the cursor"
  test.todo(`ask arrows through suggestions – ↑/↓ moves through suggestions and recents; Return asks`);

  // covered: ask.test.ts: "ask proposal accept applies once – Return on an empty field accepts; the card shows its receipt; Undo restores it"
  test.todo(`ask return on proposal – Return with a pending proposal and an empty field accepts it`);

  // covered: palette.test.ts: "palette 1-9 only when empty – a digit picks a row only while the field is empty"
  test.todo(`palette 1-9 only when empty – digits type into a non-empty field`);

  // covered: palette.test.ts: "palette nested page breadcrumb – "Move to label…" shows a trail and the labels; Esc returns one level"
  test.todo(`palette esc up then close – Esc in a nested page goes up; at top level closes; ⌘K toggles`);

  test.todo(`search arrows hand off to list – ↓ from the field puts the cursor on the first row; J/K, E, L, X work; arrow triage off (decision 7) [waits: Playwright base]`);

  test.todo(`keys never dropped while dock animates – 5 J presses during the dock open land five rows down (section 5 rule 4) [waits: Playwright base]`);

  test.todo(`ime safe in ask and search – no shortcut fires while isComposing (Japanese and Chinese IME) [waits: Playwright base]`);
});

describe('ui-ask: visual states, light and dark (visual)', () => {
  test.todo(`ask × {answer, empty, working, no-provider, provider-error, no-source, stopped, dictating, today} × {light, dark} [waits: Playwright base]`);
  test.todo(`palette × {commands, filtered, nested, confirm, no-match} × {light, dark} [waits: Playwright base]`);
  test.todo(`search × {results, results+remote, remote-busy, remote-none, remote-paused, no-match} × {light, dark} [waits: Playwright base]`);
  test.todo(`shortcuts × {default, filtered} × {light, dark} [waits: Playwright base]`);
  test.todo(`Increase Contrast pass for each of the above; reduced motion: dock and settle become opacity ≤ 120 ms [waits: Playwright base]`);
});

describe('ui-ask: accessibility (dom)', () => {
  test.todo(`axe ask palette search – axe clean in every harness state, both themes [waits: Playwright base]`);
  test.todo(`palette combobox pattern – role=combobox, aria-expanded, aria-controls, aria-activedescendant tracks the active option [waits: Playwright base]`);
  test.todo(`ask live region phases only – the working pane announces step lines, not tokens [waits: Playwright base]`);
  test.todo(`citation accessible name – chips read "Source 1, Mina Cho, October 27"; popover reachable by focus [waits: Playwright base]`);
  test.todo(`today now line labelled – separator "Now, 10:00 AM"; events have text equivalents (time, title, calendar) [waits: Playwright base]`);
  test.todo(`search results listbox – results role=listbox with aria-activedescendant; live "N results in your mail." [waits: Playwright base]`);
  test.todo(`dictation typed equivalent – every dictation path has a typed path (section 11.4) [waits: Playwright base]`);
  test.todo(`icon buttons labelled – close, send, citation, token remove all have labels and tooltips [waits: Playwright base]`);
});

describe('ui-ask: design checks (dom / visual)', () => {
  test.todo(`banned strings – no "Ask me anything", "Hold to talk", "magic", "AI-powered", "smart", "Copilot", "Beta" in any state [waits: Playwright base]`);
  test.todo(`banned glyphs – no sparkle, wand, star, brain, robot icon names in ask, today, palette, search [waits: Playwright base]`);
  test.todo(`one filled button – Ask: only the proposal's Add is filled; with the palette open, Home's suggestion is demoted; Search: none [waits: Playwright base]`);
  test.todo(`hover never shifts – hover every interactive element in all states; no other box moves > 0.5 px (step-log summary, citations, recents, remote row, palette rows) [waits: Playwright base]`);
  test.todo(`no spinner under 150 ms – remote "Searching Google…" and Ask working line absent when the response arrives in < 150 ms [waits: Playwright base]`);
  test.todo(`contrast pairs – dim step log, quote popover source line, gap lines, now-line label (--stamp-ink), destructive key row: ≥ 4.5:1 in both themes [waits: Playwright base]`);
  test.todo(`serif only for Ask prose – Newsreader only on answer text and the quote popover; the question line is sans [waits: Playwright base]`);
  test.todo(`no secrets – no canary key or *_API_KEY value in any Ask, palette or search DOM, attribute or screenshot (U7 acc. 3) [waits: Playwright base]`);
});
