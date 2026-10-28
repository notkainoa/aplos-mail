// Pending tests for lane `ui-ask` (UI-screens thread, Phase 0, drafted 2026-10-27).
// Source: plans/ui-screens/map-ask.md (test list) and plans/30-ui-revamp.md U7 acceptance (items 1, 2, 3, 4, 5, 7 touch this lane).
// Each todo becomes a real test when the lane starts (day 5-6). Layer per group: node = pure logic (node:test),
// dom = Playwright on the browser preview with the stand-in engine, electron = hidden _electron, visual = harness screenshots in both themes.
// Stand-in scenarios used: demo, empty, ai-off, ai-budget-spent, rate-limited, offline, needs-reauth, small-10k, large-100k, partial-threads, ask-scripted, today-busy.
// Fixture/control knobs: setClock, ask.script(name), ask.stepDelayMs, ask.tokenDelayMs, ask.failNext({type, provider, resetAt?}), ai.providers([...]), transcribe.result(text), transcribe.failNext, search.remote.result(rows), search.remote.failNext({type:'throttle', retryAfterMs}), search.remote.callCount() (spy), failNextWrite.
import {describe, test} from 'node:test';

describe('ui-ask: Ask dock (dom)', () => {
  test.todo(`ask answer cites or says no source – every one of 20 fixture answers shows ≥ 1 [n] chip or "No source in your mail" (U7 acc. 4)`);
  test.todo(`ask decisive span single – each answer has at most one weight-500 span`);
  test.todo(`ask citation hover shows quote and source – hover/focus [1] shows the quote and "Mina Cho · Oct 27 · Hollow Creek review"`);
  test.todo(`ask citation click opens thread at message – click [1] opens the reader on threadId scrolled to messageId`);
  test.todo(`ask working step line names real step – first step frame renders "Reading 14 emails from Jordan" as one line; folds into a step log "Read 14 emails from Jordan · 3 steps"`);
  test.todo(`ask input never disabled while streaming – field accepts text during every streaming frame (over the 20 fixture answers, U7 acc. 4)`);
  test.todo(`ask follow-up queues as editable card – Return during a run adds a "Queued" card; it runs after the final frame (U7 acc. 4)`);
  test.todo(`ask proposal accept applies once – Add creates one event, shows "Added to Calendar · …", toast with Undo; Z removes the event and restores the card`);
  test.todo(`ask proposal dismiss persists – Not now hides the card; reopening the conversation keeps it dismissed`);
  test.todo(`ask proposal nothing applied without confirm – no Event/set or Thread/act call before Add`);
  test.todo(`ask no provider before asking – ai-off: dock shows "Ask needs a provider. Choose one in Settings." and the link; no red text`);
  test.todo(`ask provider error line – ask.failNext(aiProvider groq): "Groq didn't answer." with Retry and "Use another provider"; Retry re-runs once`);
  test.todo(`ask use another provider lists configured chat providers – the menu excludes the failing and unconfigured providers`);
  test.todo(`ask provenance on hover – hovering the answer shows "Answer by Groq"; Ollama shows "on this Mac"; nothing shows at rest`);
  test.todo(`ask recents with times – demo shows three recents with "9:42 AM", "Yesterday", "Mon"`);
  test.todo(`ask new chat – ⌘N clears to the empty state and the next question creates a new conversation`);
  test.todo(`ask works under ai-budget-spent – the scenario answers a question normally`);
  test.todo(`dictate to ask – hold A 300 ms: level meter shows; release puts transcribe.result text in the field; audio goes through Blob/put, never base64`);
  test.todo(`ask live Groq round trip – one real Groq Ask in Electron dev, key read from the backend environment only and never printed; npm run eval:ask; a mocked provider does not count (U7 acc. 5; added, the map did not list it; agent-run live check per plan 30 6.5 #5, days 12-13)`);
});

describe('ui-ask: Today (dom)', () => {
  test.todo(`today agenda – today-busy: heading, "4 events · next at 11:00 AM", past dimmed, next bold, now line at 10:00, gaps "Free for 2 h 45 min" and "Free for 3 h"`);
  test.todo(`today updates on clock – advancing the clock past 11:15 moves "next" to the 2:00 PM event`);
});

describe('ui-ask: Palette (dom / node)', () => {
  test.todo(`palette first open groups – shows only Suggested and Go to, numbered 1-9`);
  test.todo(`palette reach – every registry command with palette !== false is reachable by its label (U7 acc. 1)`);
  test.todo(`palette settings reach – every SettingRow registers a palette entry (U7 acc. 2)`);
  test.todo(`palette context line truthful – property test over 30 contexts: the line names the focused target or is absent (node)`);
  test.todo(`palette scoring oracle – fuzzed against a second agent's oracle: exact > prefix > word boundary > subsequence; recents never beat exact (node)`);
  test.todo(`palette nested page breadcrumb – "Move to label…" shows a breadcrumb and the labels list; Esc returns one level`);
  test.todo(`palette destructive defaults to cancel – Return cancels, ⇧Return confirms; the live region announces the choice`);
  test.todo(`palette esc never navigates – Esc closes or goes up a level and never changes the route (U7 acc. 1)`);
  test.todo(`palette budgets – open < 50 ms, filter one keystroke < 16 ms at large-100k`);
});

describe('ui-ask: Search (dom / node)', () => {
  test.todo(`search operators become tokens – typing from:jordan makes a pill; Backspace on an empty field removes it`);
  test.todo(`search parser parity – the renderer's pills and the engine spec come from the same parseSearch for 100 fuzzed queries (node)`);
  test.todo(`search local as you type – each keystroke updates the window; zero remote calls (U7 acc. 7, spy)`);
  test.todo(`search remote exactly once – Return calls Search/remote once; a second Return with unchanged text calls nothing; reset does not re-call`);
  test.todo(`search remote merge – "From Google" lists only hits absent from "In your mail"`);
  test.todo(`search remote paused – rate-limited: Return shows the plain pause line with the resume time and no Google call`);
  test.todo(`search no match – "No mail matches ‘dentist’." plus "Search all mail on Google · Return"`);
  test.todo(`search to palette – typing > opens the palette`);
});

describe('ui-ask: keyboard paths (dom)', () => {
  test.todo(`A tap focuses ask – A opens the dock (if closed) and focuses the field on keydown`);
  test.todo(`A hold dictates – hold past 250 ms starts dictation; inside the field the typed "a" is removed when the hold completes`);
  test.todo(`cmd J toggles dock focus safe – ⌘J toggles; focus moves to the field or back to the list, never lost`);
  test.todo(`shift A opens today – ⇧A opens the dock on Today; the calendar button is pressed`);
  test.todo(`ask esc ladder – Esc stops a run, then clears text, then dismisses a pending proposal, then closes the dock; never navigates`);
  test.todo(`ask cmd return search all – ⌘Return in the field sends searchAllMail: true`);
  test.todo(`ask cmd return in queued card – sends that card now (cancels the current run)`);
  test.todo(`ask arrows through suggestions – ↑/↓ moves through suggestions and recents; Return asks`);
  test.todo(`ask return on proposal – Return with a pending proposal and an empty field accepts it`);
  test.todo(`palette 1-9 only when empty – digits type into a non-empty field`);
  test.todo(`palette esc up then close – Esc in a nested page goes up; at top level closes; ⌘K toggles`);
  test.todo(`search arrows hand off to list – ↓ from the field puts the cursor on the first row; J/K, E, L, X work; arrow triage off (decision 7)`);
  test.todo(`keys never dropped while dock animates – 5 J presses during the dock open land five rows down (section 5 rule 4)`);
  test.todo(`ime safe in ask and search – no shortcut fires while isComposing (Japanese and Chinese IME)`);
});

describe('ui-ask: visual states, light and dark (visual)', () => {
  test.todo(`ask × {answer, empty, working, no-provider, provider-error, no-source, stopped, dictating, today} × {light, dark}`);
  test.todo(`palette × {commands, filtered, nested, confirm, no-match} × {light, dark}`);
  test.todo(`search × {results, results+remote, remote-busy, remote-none, remote-paused, no-match} × {light, dark}`);
  test.todo(`shortcuts × {default, filtered} × {light, dark}`);
  test.todo(`Increase Contrast pass for each of the above; reduced motion: dock and settle become opacity ≤ 120 ms`);
});

describe('ui-ask: accessibility (dom)', () => {
  test.todo(`axe ask palette search – axe clean in every harness state, both themes`);
  test.todo(`palette combobox pattern – role=combobox, aria-expanded, aria-controls, aria-activedescendant tracks the active option`);
  test.todo(`ask live region phases only – the working pane announces step lines, not tokens`);
  test.todo(`citation accessible name – chips read "Source 1, Mina Cho, October 27"; popover reachable by focus`);
  test.todo(`today now line labelled – separator "Now, 10:00 AM"; events have text equivalents (time, title, calendar)`);
  test.todo(`search results listbox – results role=listbox with aria-activedescendant; live "N results in your mail."`);
  test.todo(`dictation typed equivalent – every dictation path has a typed path (section 11.4)`);
  test.todo(`icon buttons labelled – close, send, citation, token remove all have labels and tooltips`);
});

describe('ui-ask: design checks (dom / visual)', () => {
  test.todo(`banned strings – no "Ask me anything", "Hold to talk", "magic", "AI-powered", "smart", "Copilot", "Beta" in any state`);
  test.todo(`banned glyphs – no sparkle, wand, star, brain, robot icon names in ask, today, palette, search`);
  test.todo(`one filled button – Ask: only the proposal's Add is filled; with the palette open, Home's suggestion is demoted; Search: none`);
  test.todo(`hover never shifts – hover every interactive element in all states; no other box moves > 0.5 px (step-log summary, citations, recents, remote row, palette rows)`);
  test.todo(`no spinner under 150 ms – remote "Searching Google…" and Ask working line absent when the response arrives in < 150 ms`);
  test.todo(`contrast pairs – dim step log, quote popover source line, gap lines, now-line label (--stamp-ink), destructive key row: ≥ 4.5:1 in both themes`);
  test.todo(`serif only for Ask prose – Newsreader only on answer text and the quote popover; the question line is sans`);
  test.todo(`no secrets – no canary key or *_API_KEY value in any Ask, palette or search DOM, attribute or screenshot (U7 acc. 3)`);
});
