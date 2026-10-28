# UI-screens Phase 0 map: `ui-ask` (Ask dock, Today, ⌘K palette, Search)

Day 1 (2026-10-27). Contract mapping for the freeze review (plan 10 §4.1 "Freeze review"; plan 30 §8.1). Planned contract only; nothing here exists yet.

## Scope

Pages: `mockups/ask.html` (answer, empty, working, no-provider, today), `palette.html` (commands, filtered, confirm), `search.html` (results, no-match), `shortcuts.html` (default, filtered; mapped briefly as a registry consumer), shared `shell.js` (keys, toolbar Today button, toasts, dock toggle). DESIGN §7.7, §7.9, §7.14 (Search, Ask rows), §7.15 (Ask failed), §5 rules 1, 4, 12, 13, 16, 17, §8 (Global, Ask, Palette rows), §9 (rules 1, 3, 5, 6, 8), §10, §11.3. Plan 30 U7 (Palette and search, Ask and Today; acceptance 1, 4, 5, 7), §4.1 view specs, §4.2 CommandRegistry, §8.1 items 7-8. Plan 10 §4.1 verb list and E5 item 6. ARCH §3.4, §8.1, §8.3-8.5, §9. Plan 20 PV3 item 7 (search on Enter). Undrawn surfaces DESIGN requires (provider error, no source, dictation into Ask, stopped answer, streaming answer, remote-search paused) get their own table. Legacy reference: `apps/desktop/src/renderer/Ask.tsx`, `AskAnswer.tsx`, `AskEvent.tsx`, `useVoice.ts`, `engine/ask.ts`, `engine/agent.ts`, `engine/service.ts` (facts only, nothing copied).

**What legacy does today (for comparison, verified):** `ai.ask {conversationId, message, accountId, draft, requestId, timeZone, context:{view, threadId?, selectedIds?}}` (`Ask.tsx:72`); `ai.progress` events `text | reset | cite {index, threadId} | step {id, tool, label, count?, status} | usage` (`service.ts:838`, `shared/types.ts:17`); answer `AskMessage {content with [^n], citations: threadId[], proposal?: Draft, event?: CalendarEvent, triage?, steps?, model?}` (`shared/types.ts:21`); no quote, no decisive mark, no "no source" rule beyond the prompt; tools `search_mail, read_thread, list_events, find_contact, current_context, propose_draft, propose_event, propose_triage` (`engine/ask.ts:114-207`), loop max 6 steps (`agent.ts:83`); cancel `ai.cancel {requestId}` (`Ask.tsx:93`); voice is base64 through `ai.transcribe` (`useVoice.ts:56-58`); conversations `{id, title, messages, updatedAt}` in AppState; suggestions hardcoded; the "palette" is 8 hardcoded commands inside the Ask field; search operators parsed in the engine (`service.ts:410-436`), remote search called by the agent at will.

## Element map

### `ask.html`: dock chrome (all states)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Dock as second pane, 360 px (320 under 1180 px), resizable 300-440, remembered | §7.7, §4.4 "Ask dock" | `Settings.ui.dock.{open, width, tab}` | plan 30 §8.1 item 8 (`ui` object lists "dock", no fields) | GAP-15 |
| Closed on first run, then remembered | §7.7, decision 9 | `Settings.ui.dock.open` default `false` | plan 30 §8.1 item 8 | GAP-15 |
| Open/close by A, Ask button, ⌘J; `dock` motion (contents translateX + opacity, main pane FLIP) | §7.7, §4.8 `dock`, §8 Global | registry commands `ask.focus` (A tap), `ask.toggleDock` (⌘J); `Pane`; motion runtime | plan 30 §4.2, §4.3; DESIGN §6 `Pane` | COVERED |
| Toolbar Ask button `aria-pressed` while open; tooltip "Ask about your mail" + key | §7.1 pane header, §6 `Tooltip` | registry label + keys for tooltip | plan 30 §4.2 (registry feeds tooltips) | COVERED |
| Toolbar calendar button, tooltip "Today, ⇧A", opens Today tab | §7.1, §7.7 | registry `ask.today` (⇧A) | plan 30 §4.2; U7 Ask bullet | COVERED |
| Header: Ask \| Today segmented control on `Puck` (`slide`, transform only), close button (⌘J tooltip), no glyph | §7.7, §6 `Puck`, §4.8 `slide` | `Puck` component, tablist semantics | DESIGN §6; plan 30 U3 | COVERED |
| Last tab remembered across reopen (mock keeps `lastAsk`) | §7.7 "remembered" | `Settings.ui.dock.tab`; open conversation id | plan 30 §8.1 item 8 | GAP-15 |
| Field placeholder "Ask about your mail or calendar"; input never disabled | §7.7, §10 | none (string catalog) | plan 30 U7 acceptance 4 | COVERED |
| Send button (arrow up, tooltip "Ask · Return") | §8 Ask | registry `ask.submit` | plan 30 §4.2 | COVERED |
| Banned: "Ask me anything", "Hold to talk", sparkle/wand/star glyph | §9 rule 8, §10 | lint | plan 30 U0 row 16, U3 WP3.4 | COVERED |
| Account scope of a question (follows the sidebar account switcher, "All accounts") | §7.1 sidebar | `Ask/run.accountScope: 'all' \| accountId` | not specified (plan 10 E5 item 6 names `Ask/run` only) | GAP-1 |

### `ask.html` state `answer`

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Question line "When is the Hollow Creek design review?" (`base` 500, no bubble) | §7.7 | turn `question` text | ARCH §9.1 `Conversation` type (shape unspecified) | GAP-7 |
| Step log, collapsed: "Read 14 emails from Jordan · 3 steps" (chevron, dim, `<details>`) | §7.7 "folds into a dim step log" | finished steps with past-tense text and a headline step; step count | plan 30 §8.1 item 7 (`progress` frames, payload unspecified) | GAP-2, UNCLEAR-12 |
| Step log expanded: "Searched mail for “design review”", "Read 14 emails from Jordan and Mina", "Checked your Work and Hollow Creek calendars" | §7.7 | `steps[] {stepId, state, text, doneText, count?}` persisted in the turn | plan 30 §8.1 item 7 | GAP-2, GAP-7 |
| Answer prose in serif `answer` (16/27 Newsreader) | §7.7, §9 rule 1, §4.3 | answer text | ARCH §9.1 `Ask/run` | COVERED |
| Decisive fact at weight 500 ("**Thursday, 2:00–2:30 PM**") | §7.7 | answer marks a decisive span; format of the answer body (spans, not free markdown) | nothing planned; legacy uses free `**bold**` (`AskAnswer.tsx:60-85`) | GAP-3 |
| Citation chips `[1]` `[2]` (mono, inline after the sentence) | §7.7 | inline citation positions in the answer body; `n` | plan 30 §8.1 item 7 `{n, messageId, quote}` | GAP-3 |
| Citation hover/focus popover: quote in serif + source line "Mina Cho · Oct 27 · Hollow Creek review" | §7.7 "show the quoted sentence on hover" | citation `quote`, `fromName`, `date`, `subject` | `{n, messageId, quote}` has no sender, date, subject | GAP-4 |
| Citation click opens the source (thread at that message) | §7.7 "open the source on click" | citation `threadId`, `accountId` (messageId alone needs an extra lookup no planned method gives) | `{n, messageId, quote}` | GAP-4 |
| Calendar source ("Checked your Work and Hollow Creek calendars" could cite an event) | §7.7 "Every answer cites its sources" | citation kind `event` with `eventId` | not planned | GAP-4 |
| "No source in your mail" when nothing is cited | §7.7, U7 acceptance 4 | `answer.noSource` or empty `citations` | derivable from empty citations; engine must guarantee one or the other | GAP-3 |
| Provenance on hover: "Answer by Groq" / "on this Mac" | §9 rule 5 | per-turn `{provider, providerLabel, model, local}` (the provider that actually answered, not the current setting; legacy shows the setting, `Ask.tsx:212`) | not planned | GAP-3 |
| Proposal card (the dock's one card, `settle`, owns the filled button): kicker "Add to Calendar", colour mark + title "Design review", when line "Thu 2:00–2:30 PM · Hollow Creek" | §7.7 "Proposals", §4.6 one filled button, §9 rule 6 | `proposals[] {proposalId, kind:'event', title, start, end, allDay, calendarId}` + calendar `{name, color}` | ARCH §8.5 (preset kinds, "need a keystroke"); no schema | GAP-5 |
| "Add · Return" (filled) | §7.7, §8 Ask "Return / Esc on proposals" | apply call returning a receipt | not planned (legacy calls `calendar.save` from the renderer, `AskEvent.tsx:36`) | GAP-5 |
| "Not now · Esc" (text) | §7.7 | dismiss call; dismissed state persisted in the conversation | not planned | GAP-5 |
| Done line "Added to Calendar · Thu 2:00–2:30 PM · Hollow Creek" (`arrive`), survives reload | §7.7, §4.8 `arrive` | proposal `state: accepted` + result ref (eventId) in the stored turn | not planned | GAP-5 |
| Toast "Added to Calendar" with Undo Z | §7.13, §5 rule 11 | receipt `{opId}`; `Operation/undo` reaches the created event | plan 10 §4.1 `Operation/undo`; whether `Event/set` emits receipts is unstated | GAP-5 |
| Other proposal kinds (draft, triage; legacy has all three, `shared/types.ts:21`) | §9 rule 6 "Nothing sends or writes to the calendar without a confirmation row" | kinds `draft` (opens composer with the draft) and `triage` (`Thread/act`) | ARCH §8.5 `SuggestedAction` presets (background kinds, not Ask's) | GAP-5 |

### `ask.html` state `working`

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| One steady line naming the real step: "Reading 14 emails from Jordan", then "Checking your calendars" | §7.7 | `progress` frame `step {runId, stepId, state:'running', text, count?}`; engine-authored text from the string catalog | plan 30 §8.1 item 7; plan 10 §7.2 "all user-facing strings live in one catalog" | GAP-2 |
| Thin non-blinking caret, no typewriter, no shimmer | §7.7, §9 rule 3 | token `delta` frames | plan 10 E5 item 6 ("`progress` frames"); ARCH §8.1 "streamed" | GAP-2 |
| Streamed answer text replacing the step line, then final answer | §7.7 | `delta`, `reset` (model restarts), final `answer` frame | plan 30 §8.1 item 7 | GAP-2 |
| Rate-limit wait inside a run ("Waiting for Groq, about 20 s"; legacy `agent.ts:112`) | §7.7 "names the real step" | a `step` frame with the wait text | plan 10 E5 item 2 (governor honours `Retry-After`) | GAP-2 |
| No spinner under 150 ms; nothing over 50 ms on the main thread while streaming | §5 rules 12-13 | frames batched per animation frame | ARCH §9.2; DESIGN §5 rule 13 | COVERED |
| Input never disabled; follow-ups typed while working queue as editable cards ("Queued · ⌘Return sends now", "And is Mina free then?") | §7.7, U7 acceptance 4 | renderer-held queue; serial `Ask/run` on the same conversation | not stated who queues | UNCLEAR-4 |
| ⌘Return in a queued card sends it now | §7.7 | cancel current run then `Ask/run`; or concurrent run | not stated | UNCLEAR-3, UNCLEAR-4 |
| Esc while working stops the run; partial answer stays | §8 Ask "Esc stop → clear → close" | `Ask/cancel {runId}`; final frame `stopped: true` with partial text and citations so far | plan 10 E5 item 6 ("cancel", no method name) | GAP-1, UNCLEAR-17 |
| `aria-live="polite"` on the working pane; announces phases, not tokens | §11.3 "Progress announces phases only" | step frames distinct from deltas | — | GAP-2 |

### `ask.html` state `empty`

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| "Try asking" + three plain suggestions: "What needs a reply from me today?", "When am I free tomorrow afternoon?", "Summarize this week’s mail from Jordan" | §7.7, §7.14 Ask row | static strings, or one personalised by top correspondent name | not planned (legacy: 2 static + 1 from a contact name, `Ask.tsx:171`) | GAP-16 |
| "Recent" chats with times ("9:42 AM", "Yesterday", "Mon") | §7.7 "recent chats with times" | conversations list `{id, title, updatedAt}`, newest first, live | plan 30 §4.1 view table "conversations" (no spec); ARCH §3.2 `conversations(...)` | GAP-7 |
| Picking a recent chat reopens that conversation (mock re-asks the text; DESIGN means reopen) | §7.7 | `Conversation/get {id}` → turns with steps, answer, citations, proposal states | not planned | GAP-7 |
| ↑/↓ moves a cursor through suggestions and recents (field empty); Return runs it | §8 Ask "↑/↓ suggestions and history" | renderer only | plan 30 §4.2 | COVERED |
| "History" on ↑ inside a conversation (recall earlier question?) | §8 Ask | unclear meaning | — | UNCLEAR-14 |
| ⌘N new chat (clears to empty state, focuses field) | §8 Ask | `Ask/run` without `conversationId` creates one | plan 10 E5 item 6 | GAP-1 |
| Delete a conversation (legacy `conversation.delete`, `service.ts:905`) | not in DESIGN | `Conversation/delete` | not planned | GAP-7 |

### `ask.html` state `no-provider`

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| "Ask needs a provider. Choose one in Settings." + link "Open Settings → AI"; no red | §7.7, §9 rule 7 | known before the first question: `Settings.ai.features.ask.{provider, model}` and that provider's `configured` status | roadmap F1 "`Settings` schema ... per-feature AI provider and model"; provider status table "eng-ai provider table" (no method named) | GAP-6 |
| Same state when a question is sent anyway | §7.7 | typed error `aiNotConfigured` on `Ask/run` | ARCH §9.1 envelope `{type, message}` (AI types not enumerated) | GAP-6 |
| `ai-off` scenario shows this, never an error on the mail surface | §9 rule 7 | scenario | plan 10 §4.1 `ai-off` | COVERED |

### `ask.html` state `today`

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Heading "Thursday, October 29" (`title`), sub "4 events · next at 11:00 AM" | §7.7 Today | today's events for visible calendars; clock | plan 30 §4.1 view table "`Event/query` by range and calendars; today agenda"; **absent from plan 10 §4.1 verb list** (only `Event/set`, `Event/rsvp`) | GAP-9 |
| Event rows: time left (`small` dim), colour mark, title ("Design review with Mina and Jordan"), sub line ("Next · Work · 15 min", "Hollow Creek · 30 min", "Personal") | §7.7 | event `{id, title, start, end, allDay, calendarId, status}`; calendar `{name, color}`; duration derived | ARCH §3.2 `events`, `calendars(name, color, hidden)`; method missing | GAP-9 |
| Past event dimmed (mark at 50 %); next event weight 600 | §7.7 | clock + event times | `Fixture/control` clock (plan 10 §4.1) | COVERED |
| Now line (`--stamp`, 5 px cap) with "10:00 AM", `role=separator` "Now, 10:00 AM" | §7.7, §7.8 now-line | renderer clock; suspend timer when hidden (§5 rule 15) | — | COVERED |
| Free gaps "Free for 2 h 45 min", "Free for 3 h" between consecutive upcoming events (none shown from now to the next event) | §7.7 "the free gaps" | computed in the renderer from ≤ 10 events (cheap) | nothing says who computes | UNCLEAR-7 |
| Which events: "the next event, the following two" (mock also shows a past one); all-day, declined, cancelled; after the last event | §7.7 | `event.allDay`, self `responseStatus`, `status` | plan 20 PV8-PV9 RSVP fields | UNCLEAR-7 |
| Live updates when an event changes or syncs | §5 rule 6 spirit | watched events window or a frame | not planned for events (windows are thread rows, ARCH §9.2) | GAP-9 |
| "Open Calendar ⌃6" text button | §7.7 | registry `go.calendar` | plan 30 §4.2 | COVERED |
| Field and queued card hidden in Today | mockup only | — | — | COVERED |
| Calendar colour → token (`--tag-sky`, `--tag-hill`, `--tag-ember`) | §4.2 | `calendars.color` mapped to the 8 tag tokens | DESIGN §4.2 (ui-calendar owns mapping) | COVERED |

### Undrawn Ask surfaces DESIGN requires

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Provider error: `ErrorLine` "Groq didn't answer." with Retry · Use another provider | §7.7, §7.15 "Ask failed" | error `aiProvider {provider, providerLabel, model, retryable}`; Retry re-runs the same turn | ARCH §9.1 envelope; plan 10 E5 item 2 | GAP-6 |
| "Use another provider": which providers, one-off or setting change | §7.15 | `Ai/providers` list `{id, label, local, configured, capabilities:['chat'\|'stt'], models}`; `Ask/run.providerOverride?` | eng-ai "provider table" (roadmap §2 `ui-settings` row; no method) | GAP-6 |
| Daily token limit on the Ask model ("Groq's daily limit for this model is reached. Resets at 5:00 PM.") | ARCH §8.4, §6.3 `daily` | error `aiDaily {resetAt}` | plan 10 E5 item 2 "a daily-token 429 stops that model's queue ... while Ask on another model answers" | GAP-6 |
| Mail not eligible (account AI toggle off, or provider `trainsOnInputs`) | ARCH §8.3 | error `aiNotEligible {reason}` or silently scoped | ARCH §8.3 is background-only | UNCLEAR-5 |
| Dictation into Ask (hold A): `LevelMeter` (`--stamp`) + one line (compose's analogue: "Listening. Release R to keep, Esc to cancel.") | §8 Global "hold A: dictate to Ask", §7.6 dictation, §6 `LevelMeter` | mic capture and level in the renderer; `Blob/put` audio; transcribe call; result inserted into the field | plan 10 E5 item 6 `Blob/put`; plan 30 §4.1 binary path; **transcribe method not named** | GAP-8 |
| Tap-vs-hold A: keydown opens and focuses Ask; hold past 250 ms dictates; in the field the letter is inserted and removed if the hold completes | §8, plan 30 §4.2 | registry `holdRun`; `Settings.ui.holdMs` | plan 30 §4.2, §8.1 item 8 | COVERED |
| Voice not configured ("Voice needs a speech-to-text provider. Choose one in Settings.") | AGENTS.md, §7.10 Voice row | `Settings.ai.features.voice` + `Ai/providers` stt capability; error `aiNotConfigured {feature:'voice'}` | roadmap F1 per-feature settings | GAP-6, GAP-8 |
| Stopped answer (Esc while streaming) | §8 Ask | final frame `stopped: true` | — | GAP-3, UNCLEAR-17 |
| "Ask about this email" (palette Ask group, key A with a selection) | palette mockup, §7.9 | `Ask/run.context {route, threadId?, selectedIds?, eventId?, draftId?}` | legacy `context` (`Ask.tsx:72`); not in plan | GAP-1 |
| ⌘Return in the field: search all mail | §8 Ask | `Ask/run.searchAllMail: true`; agent may call remote Gmail search only then (ARCH §3.4 quota rule) | not planned | GAP-1, UNCLEAR-3 |
| Long answers, lists inside answers (legacy supports bullets) | §7.7 | answer body block kinds `p`, `list` | — | GAP-3 |

### `palette.html` (commands, filtered, confirm)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| ⌘K opens; only overlay; opaque `--paper`, `--elev-float`, 600 px, 16 vh, results ≤ 420 px, light scrim, `settle`; ⌘K again closes | §7.9, §4.4, §4.6 | `Palette` component; registry `palette.open` | DESIGN §6 `Palette`; plan 30 U7 | COVERED |
| Field "Type a command", `role=combobox` with `aria-controls`, `aria-expanded` and `aria-activedescendant` | §11.3 | `Palette` props | DESIGN §11.3 (mock lacks `aria-activedescendant`) | COVERED |
| Context line "For: Drew Bell · October illustrations" | §7.9 | the focused screen's target: kind, ids, display label (sender display name + subject for a thread; "3 emails"; an event; a draft; none) | plan 30 §4.2 `when(ctx)`, `run(ctx)`, **ctx shape unspecified** | GAP-12 |
| Context line truthful across 30 contexts (property test) | U7 acceptance 1 | same | plan 30 U7 | GAP-12 |
| Sender display name for the context line | §7.9 | Thread row display sender (`participants` JSON has ≤ 6 names; which one is "the sender" is unstated) | ARCH §3.2 `threads.participants`; plan 10 §4.1 Thread row | UNCLEAR-18 |
| First open: "Suggested" (Reply, Done, Later, Ask about this email) and "Go to" (Home, Later, All mail, Drafts, Calendar) with 1-9 numbers | §7.9 | per-command `suggested?(ctx)`; "places you go most" usage counts; recents | registry fields `id, label, icon, keys, contexts, when, run, holdRun, undo, confirm, group` (no suggest/rank) | GAP-13, GAP-14 |
| Typing: groups Actions, Go to, Ask, Settings; each row icon, label with matched letters bold, group name, keycaps from the registry | §7.9 | registry `group`, `icon`, `keys` per context, `keywords` | plan 30 §4.2 (`keywords` absent) | GAP-13 |
| Scoring: exact, prefix, word boundary, subsequence; recents boosted, never above exact | §7.9 | pure scorer; recents list | plan 30 U7 "fuzzed against an oracle" | COVERED (scorer), GAP-14 (recents) |
| Scoring location: renderer main thread; < 16 ms per keystroke, < 50 ms open | §5 rule 13, §5 budgets | scorer over ~250 entries is well under 1 ms; keep it on the main thread with a perf test | DESIGN §5 budget table | COVERED |
| "No commands match “x”." | mock | — | — | COVERED |
| Fallback "Ask about “x”" when typing a question | §7.9 "Ask" group | registry dynamic row | not stated | UNCLEAR-15 |
| 1-9 run the Nth result only while the field is empty; ↑/↓ and ⌃N/⌃P move; Return chooses | §7.9, §8 Palette | resolver context `palette` | plan 30 §4.2 | COVERED |
| Nested pages with breadcrumbs ("Move to label…", "Later until…", "Set due date…", "Use another provider…") | §7.9 | registry `page?(ctx)` returning items or an argument picker (labels list, `DatePresets`); breadcrumb label | not in the registry field list | GAP-13 |
| Labels for "Move to label…" | §7.9 | folders singleton with `kind='label'` | plan 30 §4.1 singletons; ARCH §3.2 `folders` | COVERED |
| Destructive confirm: "Delete forever?", "“Invoice #0412 · October illustrations” will be removed from your account. This can’t be undone.", "Cancel · Return" (default), "Delete forever · ⇧Return" (stamp ink); field read-only; live region "Delete forever? Cancel is selected. Return cancels, Shift Return deletes." | §7.9, §6 `Confirm`, §8 Palette | registry `confirm?: {title, body(ctx), confirmLabel}` | plan 30 §4.2 `confirm?` (shape unspecified) | GAP-13 |
| "Delete forever" on Gmail | §7.9 example | `Thread/act` permanent delete; Gmail `messages.delete` needs the full `https://mail.google.com/` scope, which plan 20 bans (`50-thread-briefs.md:245`) | — | UNCLEAR-1 |
| Esc up one level, then close; Esc never navigates | §7.9, U7 acceptance 1 | renderer | plan 30 §4.2 | COVERED |
| Every registry action reachable here | §7.9, U7 acceptance 1, plan 30 §4.2 test | registry completeness; movement keys and gestures from the sheet cannot be palette rows | plan 30 §4.2 "a test asserts every command is in the palette and the sheet" | UNCLEAR-10 |
| Settings group: Open Settings (⌘,), AI providers, Keyboard shortcuts (?), Appearance, plus every `SettingRow` | §7.10 "Every setting is searchable from ⌘K", U7 acceptance 2 | runtime registration of SettingRow entries (`id`, label, section, row anchor, keywords), deep link to a row | registry is "one table" (static) | GAP-13 |
| Ask group: Ask about this email (A), Open Today (⇧A), Toggle the Ask dock (⌘J), New chat (⌘N) | §7.9, §8 | registry; `Ask/run.context` for "this email" | plan 30 §4.2 | COVERED (registry), GAP-1 (context) |
| Go to group includes every sidebar place incl. Done | §7.1, §7.9 | registry `go.*` | plan 30 §4.2 | COVERED |
| "Find related mail" (Actions) opens Search prefilled | mock | route param for Search | renderer | COVERED |
| Topmost surface owns the filled button (Home demotes while palette is up) | §4.6 | shell rule | DESIGN §4.6 | COVERED |

### `search.html` (results, no-match)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Search is a page with a sidebar item, opens with `/`; `/` again focuses and selects | §7.9, §7.1, §8 Global | route + registry `go.search` | plan 30 U7 | COVERED |
| Field in `PageHead` at `heading` size, placeholder "Search mail", 2 px accent underline while focused | §7.9, §11.2, §6 `SearchField` | `SearchField` props | DESIGN §6 | COVERED |
| Hint line when no tokens: "Narrow with from:, to:, subject:, has:attachment, before:, in:done" | mock only | string | — | COVERED |
| Operators `from:`, `to:`, `subject:`, `has:attachment`, `before:`, `after:`, `in:` (incl. `in:done`) become removable pill tokens on space; Backspace on empty field removes the last | §7.9, §6 `OperatorToken` | one shared pure parser (renderer pills and engine spec must agree): value grammar (quotes, dates, label names with spaces) | plan 30 §4.1 "`search` with parsed operators" (no shape, no parser owner); legacy parses in the engine (`service.ts:410-436`) | GAP-10 |
| Spec the tokens map to | §7.9 | `{kind:'search', account, text, from[], to[], subject[], has[], before?, after?, in?}` | plan 30 §4.1 view table | GAP-10 |
| `to:` distinct from `from:` | §7.9 | FTS `people` column mixes both; `to:` needs `messages.to_json`/`cc_json` filter | ARCH §3.2, §3.4 | GAP-10 |
| `in:done`, `in:later` (workflow states, not folders) and `in:<label>` | §7.9, §7.4 "Search reaches it with `in:done`" | spec `in` enum + labelId | plan 30 §4.1 "the Done place is a `mailbox` view with `in:done`" | GAP-10 |
| Scope chip "All accounts" (follows the account switcher) | mock | spec `account` | plan 30 §4.1 ("Account `all` or one id") | COVERED |
| Local results as you type, as ordinary rows; Lists keymap (J/K, E, L, X, Return); ↓ from the field hands the keyboard to the list | §7.9, §8 Lists | `useView({kind:'search', ...})` re-watched per keystroke (coalesced), live window | plan 30 §4.1 `useView`; ARCH §3.4, §9.2 | COVERED |
| Section head "In your mail" + count | mock | `window.total` | plan 30 §4.1 `useView` returns `total` | COVERED |
| Row: unread dot and weight, sender, subject (500), snippet, icons (replied, bookmark, paperclip), account dot with address tooltip (2+ accounts), date; hover actions Done, Later, Trash overlay the date | §6 `ListRow`, §5 rule 17 | Thread row `participants`, `subject`, `snippet`, `last_date`, `unread_count`, `has_attach`, bookmarked, replied, `account_id` → account address | ARCH §3.2 `threads`, `thread_workflow`; "replied" field unnamed | UNCLEAR-18 |
| Matched words bold in subject and snippet | mock | free-text terms after parsing; diacritic folding to match FTS `remove_diacritics 2` | not planned; contentless FTS5 cannot return `snippet()` | UNCLEAR-6 |
| Sort order (mock: newest first) | mock | spec sort `date` vs relevance | not stated | UNCLEAR-6 |
| "Search all mail on Google · Return" row under results (globe icon) | §7.9 | label from accounts with `capabilities.serverSearch` ("on Google" in round 1) | ARCH §3.2 `accounts.capabilities.serverSearch` | COVERED |
| Return in the field, or Return with no row cursor, runs remote search **exactly once**; typing never calls it | §7.9, U7 acceptance 7, ARCH §3.4 | an explicit command with exactly-once semantics, not a watched spec that re-runs on `reset` or `move` | plan 20 PV3 item 7 "search input carries `server: boolean`"; plan 30 §4.1 "`local` or `remote`" | GAP-11, UNCLEAR-2 |
| "Searching Google…" busy row (after 150 ms) | §5 rule 12 | remote progress `{searchId, state:'running'}` | ARCH §9.2 ephemeral `progress` (payload unspecified) | GAP-11 |
| "From Google" section + count, rows without hover actions; only hits not already local | mock | remote result window; dedupe against local hits; rows `origin='search'` | ARCH §3.2 note ("Search results from the server are ordinary rows with `origin='search'`"); plan 20 "10 results" | GAP-11, UNCLEAR-13 |
| "Nothing on Google either. Try fewer words." | mock | remote `done` with `found: 0` | — | GAP-11 |
| Remote search while the account is paused, offline or needs reauth ("Google asked us to slow down. Search again at 2:14 PM.") | §7.15 voice; ARCH §6.3 | error `throttle` with `retryAfterMs` / account status | ARCH §9.1 envelope `{type, message, retryAfterMs}`; status vocabulary §6.4 | GAP-11 |
| No match: "No mail matches ‘dentist’." + text button "Search all mail on Google · Return" | §7.9, §7.14 | `total = 0` | plan 30 §4.1 | COVERED |
| Live region "N results in your mail." / "No results." | §11.3 | — | — | COVERED |
| Typing `>` in Search switches to the palette | §7.9 | renderer; whether the text after `>` carries over | — | UNCLEAR-16 |
| Search ranking off the main thread | §5 rule 13 | FTS in the engine | ARCH §3.4 | COVERED |

### `shortcuts.html` (registry consumer, owned by `ui-foundation`'s `ShortcutSheet`)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Sheet generated from the registry: contexts Global, Lists, Home and one-by-one, Reader, Compose, Ask, Calendar, Palette; three fixed columns; alternatives joined with "or"; "hold" words | §6 `ShortcutSheet`, §8 | registry `keys` per context with alternatives and a hold flag; sheet label (sometimes differs from the palette label, e.g. "This sheet" vs "Keyboard shortcuts") | plan 30 §4.2 | COVERED |
| Ask rows: Return Ask; ⌘Return Search all mail; ↑/↓ Suggestions and history; ⌘N New chat; Return/Esc Accept or decline a proposal; Esc Stop, then clear, then close; Global: A, hold A, ⌘J, ⇧A | §8 | `ui-ask` registers these | plan 30 §4.2 | COVERED |
| Movement and gesture rows (J/K, 1-9, date presets 1-5, ⌥-click, pinch) are in the sheet but are not palette commands | §8, plan 30 §4.2 test | registry flag `palette: false` or sheet-only entries | — | UNCLEAR-10 |
| Filter "Filter shortcuts"; "N of M shortcuts"; "No shortcut matches ‘x’."; sub "Hold ⌘ on any screen to show its keys." | mock | — | — | COVERED |

### Cross-cutting hooks and components (F9)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Subscribing to Ask and remote-search `progress` frames by run id | §7.7 | a hook (`useProgress(runId)` or `api.subscribe`) | plan 30 §4.1 hooks: `useView`, `useRow`, `api`, receipts only | GAP-18 |
| `AskTurn`, `StepLog`, `Citation`, `ProposalCard`, `OperatorToken`, `Palette`, `LevelMeter`, `ErrorLine` props frozen at F9 must carry the fields above | §6 | props per GAP-2..GAP-6, GAP-10, GAP-12, GAP-13 | DESIGN §6 (Rework/New, no props) | GAP-17 |

## Gaps

**GAP-1. `Ask/run` input, run id and cancel.**
- Needs: account scope, "⌘Return search all mail", "Ask about this email", ⌘N new chat, "Esc stop", retry with another provider.
- Why uncovered: plan 10 §4.1 and E5 item 6 name `Ask/run` "with `progress` frames and cancel"; plan 30 §8.1 item 7 fixes only the citation shape. No input fields, no run id, no cancel method name.
- Shape: `Ask/run {question: string, conversationId?: string, accountScope: 'all' | accountId, searchAllMail: boolean, context: {route, threadId?, selectedIds?: string[], eventId?, draftId?}, timeZone: string, providerOverride?: {provider, model}, clientRunId}` → `{runId, conversationId, turnId}` (returns at once; the answer arrives as frames). `Ask/cancel {runId}` → `{ok}`; the final frame then carries `stopped: true`. `searchAllMail:false` means the agent never calls the provider's server search (ARCH §3.4 quota rule).
- To: `eng-ai`, `eng-contract`. Severity: blocks-freeze. Stand-in: `Ask/run` answers from scripted transcripts (see harness).

**GAP-2. Ask `progress` frame payload.**
- Needs: "One steady line names the real step ('Reading 14 emails from Jordan'), then folds into a dim step log"; summary "Read 14 emails from Jordan · 3 steps"; caret streaming; phase-only announcements (§11.3).
- Why uncovered: ARCH §9.2 calls `progress` "ephemeral" and gives no payload; legacy step labels are tool-shaped ("Searched mail for “x” from y", `AskAnswer.tsx:11-23`) and have no done/running pair.
- Shape: `progress {channel:'ask', runId, seq, event}` where `event` is one of `step {stepId, state:'running'|'done'|'error', text, doneText, count?, headline?: boolean}`, `delta {text}`, `reset {}`, `answer {turn}` (GAP-3), `error {error}` (GAP-6). `text` and `doneText` come from the engine string catalog (plan 10 §7.2) in DESIGN §10 voice. Steps are also stored on the turn so the log survives reload.
- To: `eng-ai`, `eng-contract`. Severity: blocks-freeze (F1 freezes "all frames"). Stand-in: scripted steps with timing knobs.

**GAP-3. Answer turn schema (decisive fact, citations inline, no source, provenance, stopped).**
- Needs: "the decisive fact at weight 500", "Citations are mono [1] chips", "Every answer cites its sources or says 'No source in your mail'", "Provenance on hover only ... 'on this Mac'" (§9 rule 5).
- Why uncovered: no answer schema is planned; legacy free markdown cannot guarantee a single decisive span, and the stored `model` is the setting, not the answering provider.
- Shape: `AskTurn {turnId, question, createdAt, steps: Step[], answer: {blocks: Array<{kind:'p'|'li', spans: Array<{text, decisive?: true} | {cite: n}>}>}, citations: Citation[], noSource: boolean, proposals: Proposal[], provenance: {provider, providerLabel, model, local: boolean}, stopped?: true, error?: AskError}`. Engine validates: at most one decisive span per answer; `noSource === (citations.length === 0)`.
- To: `eng-ai`, `eng-contract`. Severity: blocks-freeze. Stand-in: 20 fixture answers (U7 acceptance 4), including no-source ones.

**GAP-4. Citation shape beyond `{n, messageId, quote}`.**
- Needs: hover shows the quote **and** "Mina Cho · Oct 27 · Hollow Creek review"; click "open[s] the source".
- Why uncovered: plan 30 §8.1 item 7 and plan 10 §4.1 freeze `{n, messageId, quote}`; no planned call maps a message id to its thread and sender for an arbitrary message without opening the thread; calendar sources cannot be cited.
- Shape: `Citation = {n, kind:'message', messageId, threadId, accountId, quote, fromName, fromAddress, date, subject} | {n, kind:'event', eventId, calendarId, title, start, quote?}`.
- To: `eng-ai`, `eng-contract`. Severity: blocks-freeze (turning a plain object into a discriminated union later is breaking). Stand-in: fixture citations pointing at demo threads and events.

**GAP-5. Proposals: shape, accept/dismiss, receipt, persisted state.**
- Needs: "Each has a consequence line ('Add to Calendar · Thu 14:00–14:30 · Work') and two key rows ('Add, Return' / 'Not now, Esc'). Nothing is applied without confirmation"; done line and "Added to Calendar" toast with Undo Z.
- Why uncovered: ARCH §8.5 says proposals "need a keystroke" but no kinds, fields or apply method exist; legacy applies from the renderer (`calendar.save`, `thread.update`) and never records dismissal. Whether `Event/set` returns an undoable receipt is unstated.
- Shape: `Proposal = {proposalId, state:'pending'|'accepted'|'dismissed', result?: {eventId? | draftId? | opId?}} & ({kind:'event', title, start, end, allDay, calendarId, location?, attendees?: string[]} | {kind:'draft', draft: DraftInput} | {kind:'triage', action:'done'|'later'|'bookmark', threadIds, until?})`. `Ask/decide {conversationId, turnId, proposalId, decision:'accept'|'dismiss', edits?}` → `{receipt: {opId, appliedState}, result}`; Undo is `Operation/undo {opId}` and returns the proposal to `pending`. The renderer builds the consequence line from fields (time format is the renderer's).
- To: `eng-ai` (decide, state), `eng-contract`, `prov-cal` (event create receipt and undo). Severity: blocks-freeze. Stand-in: `Ask/decide` creates a fixture event; `Fixture/control` "fail next write" covers the rejected path.

**GAP-6. AI readiness, provider list and Ask error types.**
- Needs: no-provider state shown before any question; "Groq didn't answer." with "Retry · Use another provider" (§7.15); daily-limit and voice-not-configured cases.
- Why uncovered: roadmap F1 puts per-feature provider and model in `Settings`, and roadmap §2 says `eng-ai` supplies a "provider table", but no method lists providers with configured status and capabilities, and AI error types are not enumerated (ARCH §6.3 covers sync only).
- Shape: `Ai/providers {}` → `[{id, label, local: boolean, configured: boolean, keySource:'env'|'keychain'|'none', status:'ok'|'untested'|'failing', capabilities: ('chat'|'stt')[], models: string[], trainsOnInputs}]` (shared with `ui-settings`). Error types on `Ask/run` and transcribe: `aiNotConfigured {feature}`, `aiProvider {provider, providerLabel, model, retryable}`, `aiDaily {provider, model, resetAt}`, `aiNotEligible {reason:'accountOff'|'trainsOnInputs'}`. "Use another provider" lists `configured && capabilities includes 'chat'` minus the failing one and retries with `Ask/run.providerOverride`; it does not change the setting.
- To: `eng-ai`, `eng-contract`. Severity: additive-later (open string enums, ARCH §9.3; new method), needed by day 6. Stand-in: `ai-off` scenario; knob `ai.failNext {type, provider}`.

**GAP-7. Conversations read model.**
- Needs: "recent chats with times", reopening a chat with its steps, citations and proposal states.
- Why uncovered: plan 30 §4.1 lists "conversations" against `Event/query` with no spec; ARCH §3.2 has `conversations(...)` "imported unchanged"; ARCH §9.1 lists a private `Conversation` type with no shape.
- Shape: `View/watch {spec: {kind:'conversations'}}` rows `{id, title, updatedAt, turnCount}` newest first (or `Conversation/query`); `Conversation/get {id}` → `{id, title, turns: AskTurn[]}`; `Conversation/delete {id}`. Imported legacy turns map `citations: threadId[]` to `{kind:'message', threadId, quote: ''}` (UNCLEAR-11).
- To: `eng-ai`, `eng-contract`, `eng-store` (import). Severity: blocks-freeze for the `Conversation`/`AskTurn` type; the list spec is additive-later. Stand-in: demo has three recents ("9:42 AM", "Yesterday", "Mon").

**GAP-8. Dictation into Ask: `Blob/put` shape and the transcribe call.**
- Needs: "A Ask (hold A: dictate to Ask)"; `LevelMeter`; typed equivalent always (§11.4).
- Why uncovered: plan 10 E5 item 6 names `Blob/put` "for audio so transcription stops carrying base64" but no transcribe method, no blob shape, size cap or lifetime.
- Shape: `Blob/put {mime, size}` + transferable `ArrayBuffer` (HTTP: `POST /v1/blob`) → `{blobId, expiresAt}`, cap 25 MB, deleted after use or 10 min. `Ai/transcribe {blobId, language?}` → `{text}`, uses `Settings.ai.features.voice`, cancellable via `Ask/cancel`-style `runId` or `Ai/cancel {runId}`. Level meter stays in the renderer (`AnalyserNode`). Release inserts the transcript and asks (legacy behaviour) or leaves it in the field: owner choice at review.
- To: `eng-ai`, `eng-contract`; `ui-shell` for the binary path (plan 30 U2). Severity: blocks-freeze for `Blob/put` (it is in the C1 verb list); `Ai/transcribe` additive-later. Stand-in: `transcribe.result(text)` knob, fixed audio fixture.

**GAP-9. `Event/query` (and live updates) for Today.**
- Needs: "the next event, the following two, the free gaps, a now line" with titles, times, calendar names and colours.
- Why uncovered: plan 30 §4.1 lists "`Event/query` by range and calendars; today agenda", but plan 10 §4.1's verb list has only `Event/set` and `Event/rsvp`; windows are thread windows (ARCH §9.2).
- Shape: `Event/query {from, to, calendarIds?: 'visible' | id[]}` → `[{id, calendarId, title, start, end, allDay, location?, status:'confirmed'|'tentative'|'cancelled', selfResponse?: 'accepted'|'declined'|'tentative'|'needsAction', recurringEventId?, fromMail?: boolean}]` with occurrences expanded; plus a change signal (an `events` `state` frame or `View/watch {spec:{kind:'events', from, to}}`). Calendars come from the planned singleton (`calendars {id, name, color, hidden}`).
- To: `eng-contract`, `prov-cal`. Severity: blocks-freeze (absent from the verb list). Stand-in: demo day with past, next, two following events and two gaps; clock knob.

**GAP-10. Search spec shape and one shared operator parser.**
- Needs: "Recognised operators (`from:`, `to:`, `subject:`, `has:attachment`, `before:`, `after:`, `in:`, including `in:done`) become removable pill tokens".
- Why uncovered: plan 30 §4.1 says only "`search` with parsed operators"; nothing says who parses or what fields the spec has. Pills are drawn in the renderer and the query runs in the engine, so two parsers would drift.
- Shape: `packages/contract/src/search.ts` exports pure `parseSearch(text) → {tokens: [{key, value, start, end}], spec}`; spec `{kind:'search', account: 'all'|id, text: string, from: string[], to: string[], subject: string[], has: ('attachment')[], before?: 'YYYY-MM-DD', after?: 'YYYY-MM-DD', in?: 'inbox'|'sent'|'drafts'|'trash'|'spam'|'done'|'later'|{labelId}, sort: 'date'}`. Values: quoted strings allowed, dates as `YYYY-MM-DD` or `YYYY/MM/DD` in local time, label names quoted when they contain spaces. `to:` filters `messages.to_json`/`cc_json`, not FTS `people`.
- To: `eng-contract`, `eng-views`. Severity: blocks-freeze (spec union). Stand-in: fixture implements the same spec over demo rows.

**GAP-11. Remote search: exactly once, progress, merge, paused states.**
- Needs: "Remote Gmail search runs only on Return" (U7 acceptance 7: "Return calls it exactly once"), "Searching Google…", a "From Google" section with only new hits, "Nothing on Google either. Try fewer words.", and a plain line when Google has paused the account.
- Why uncovered: plan 20 PV3 item 7 puts `server: boolean` on "the search input"; plan 30 §4.1 says "`local` or `remote`". If remote is a watched spec, a `reset` or `cannotCalculateChanges` reopen (plan 30 §4.1 `windows.ts`) or a `View/move` would call Google again.
- Shape: `Search/remote {spec, accountIds?}` → `{searchId}`; `progress {channel:'search', searchId, state:'running'|'done'|'paused'|'failed', found, newCount, resumeAt?, reason?}`; results in `View/watch {spec:{kind:'searchResults', searchId}}`, holding only threads not in the local result (rows `origin='search'`, ARCH §3.2). One call per Return; repeated Returns with the same spec are no-ops until the text changes. Errors: `throttle {retryAfterMs}`, `offline`, `needsReauth`, `unsupported` (no `serverSearch`).
- To: `eng-contract`, `prov-gmail` (`search.ts`), `eng-views`. Severity: blocks-freeze (decides the plan 20 `server` flag). Stand-in: knobs `search.remote.result(rows)`, `search.remote.failNext({type, retryAfterMs})`; a call-count spy.

**GAP-12. CommandRegistry `ctx` target for the palette context line.**
- Needs: "a context line naming the target ('For: Drew Bell · October illustrations'), so commands know what they act on"; truthful across 30 contexts.
- Why uncovered: plan 30 §4.2 lists `when(ctx)` and `run(ctx)` with no `ctx` shape.
- Shape: `ctx.target = {kind:'thread'|'threads'|'event'|'draft'|'conversation'|'none', ids: string[], label: string}`, set by the focused screen through one shell API (`useCommandTarget(target)`); the palette reads `label` and hides the line for `none`.
- To: `ui-foundation`. Severity: blocks-freeze (F9 interface).

**GAP-13. CommandRegistry fields the palette and sheet need.**
- Needs: "Suggested" on first open, keywords ("archive" finds Done), nested pages with breadcrumbs, the two-row destructive confirm copy, every `SettingRow` registering an entry (U7 acceptance 2), sheet-only rows.
- Why uncovered: plan 30 §4.2's fields are `id, label, icon, keys, contexts, when, run, holdRun?, undo?, confirm?, group`; the registry is "one table" (static).
- Shape: optional `keywords: string[]`, `suggested?(ctx): boolean`, `page?(ctx): {title, items: Command[] | picker:'labels'|'date'|'providers'}`, `confirm?: {title, body(ctx), confirmLabel, destructive: true}`, `palette?: false` and `sheetOnly?: true`, `sheetLabel?`; `registry.register(source)` for runtime entries (settings rows, labels, accounts), and `SettingRow` props `{paletteLabel, keywords, anchor}`.
- To: `ui-foundation`. Severity: blocks-freeze (F9 interface and `SettingRow` props).

**GAP-14. Palette recents and "places you go most".**
- Needs: "Recent commands get a boost but never beat an exact match"; first-open Go to shows frequent places.
- Why uncovered: no storage named.
- Shape: `Settings.ui.palette {recent: commandId[] (≤ 20), placeCounts: Record<commandId, number>}` (synced, small), or renderer-local storage (browser preview keeps separate state anyway). Recommend `Settings.ui` so pop-out windows agree.
- To: `eng-contract` (Settings schema), `ui-foundation`. Severity: additive-later.

**GAP-15. `Settings.ui.dock` fields.**
- Needs: "closed on first run and remembered", width "resizable 300–440, remembered", last tab.
- Why uncovered: plan 30 §8.1 item 8 lists "dock" in the `ui` object with no fields.
- Shape: `Settings.ui.dock {open: boolean = false, width: number (300-440) = 360, tab: 'ask'|'today' = 'ask', conversationId?: string}`.
- To: `eng-contract`. Severity: additive-later if the `ui` object is open, blocks-freeze if it is strict. Stand-in: `Settings/*` in the fixture.

**GAP-16. Ask suggestions.**
- Needs: "three plain suggestions" including "Summarize this week’s mail from Jordan".
- Why uncovered: nothing provides a person's name; correspondents are engine-side (`correspondents`, ARCH §3.2).
- Shape: `Ask/suggestions {accountScope}` → `string[3]` (two static plus one from the top correspondent by `received_from` this week), or static strings only.
- To: `eng-ai`. Severity: additive-later.

**GAP-17. F9 component props for Ask, Palette and Search parts.**
- Needs: §6 lists `AskDock`, `AskTurn`, `StepLog`, `Citation`, `ProposalCard`, `Palette`, `SearchField`, `OperatorToken`, `LevelMeter`, `ErrorLine` as Rework/New "with frozen props", built by `ui-foundation` and used by `ui-ask`.
- Why uncovered: no props are drafted. If F9 freezes `Citation {n, onClick}` or `AskTurn {markdown}`, GAP-3 and GAP-4 cannot be rendered.
- Shape: `AskTurn {turn: AskTurn, live?: {stepText, streaming}}`, `Citation {citation: Citation, onOpen}` (popover with quote and source line), `StepLog {steps, headline}`, `ProposalCard {proposal, onAccept, onDismiss}` (owns the filled button), `OperatorToken {key, value, onRemove}`, `Palette {target, pages, items, onRun}`, `LevelMeter {level: () => number}`, `ErrorLine {text, actions}`. Alternatively, mark these components `ui-ask`-owned in F10 so props can evolve with the screen.
- To: `ui-foundation`. Severity: blocks-freeze (F9).

**GAP-18. A frame-subscription hook for `progress`.**
- Needs: streaming Ask, remote-search progress.
- Why uncovered: F9 freezes `useView`, `useRow`, `api`, receipts (plan 30 §4.1 and brief); none subscribes to `progress` frames.
- Shape: `useProgress(channel: 'ask'|'search', id) → {events, last}` over `connect().subscribe(frames)` (plan 10 §4.1 `EngineConnection`), batched per animation frame (§5 rule 13).
- To: `ui-foundation`, `ui-shell`. Severity: blocks-freeze (F9 hook list).

## Unclear

1. **"Delete forever" cannot work on Gmail in round 1.** Gmail's `messages.delete`/`batchDelete` need the full `https://mail.google.com/` scope, and plan 20 forbids asking for it (`50-thread-briefs.md:245`). The palette's only drawn destructive example is therefore not implementable. Recommend: keep the destructive-confirm pattern, demonstrate it with "Delete draft" (allowed under `gmail.modify`/compose) and "Remove account", and leave `deleteForever` out of `Thread/act` for Gmail. Owner sees the swap at review. Confirm the scope fact with `prov-gmail`.
2. **Remote search wiring.** Plan 20 PV3 item 7 (`server: boolean` on the search input) vs plan 30 §4.1 (`local` or `remote` spec) vs exactly-once (U7 acceptance 7). Recommend GAP-11's separate command, and that plan 20's flag becomes `Search/remote`.
3. **⌘Return has two meanings in Ask.** §8: "⌘Return search all mail"; §7.7: queued cards "⌘Return sends now". The mockup uses ⌘Return only for "send queued now" and normal ask. Recommend: focus in the field → ask with `searchAllMail: true`; focus in a queued card → send that card now.
4. **Who queues follow-ups, and does "send now" interrupt?** Recommend: the renderer holds the queue; queued items run in order after the current run's final frame; "send now" calls `Ask/cancel` (partial answer kept), then `Ask/run`. The engine rejects a second concurrent run on one conversation with `busy`.
5. **Does Ask honour per-account "Use this account's mail for AI" and `trainsOnInputs`?** ARCH §8.3 scopes both to background AI. Recommend: Ask honours `aiAllowed` (it leaves out those accounts and says so) and refuses mail content to a `trainsOnInputs` provider with `aiNotEligible`.
6. **Search highlighting, snippets and order.** The FTS table is contentless (ARCH §3.2), so `snippet()` is unavailable and deep body hits show the stored snippet without a highlight. Recommend: the renderer highlights the parsed free-text terms in subject and snippet with diacritic folding matching `remove_diacritics 2`; sort newest first (keyset-friendly).
7. **Today's rules.** Recommend: list all of today's timed events (past ones dimmed), mark the next, show "the following two" in full and fold later ones ("2 more"); gaps ≥ 30 min only between consecutive upcoming events, computed in the renderer; all-day events as one line under the heading; declined and cancelled hidden; after the last event, "Nothing else today." and tomorrow's first event.
8. **Hour format.** DESIGN writes "Thu 14:00–14:30"; mockups write "Thu 2:00–2:30 PM". Recommend: follow the macOS locale setting (passed in `Session/get` or read in the renderer); not a contract field.
9. **Context line subject.** The mockup shows "October illustrations" for the subject "Invoice #0412 · October illustrations". Recommend the full subject, ellipsized.
10. **Sheet vs palette completeness.** Plan 30 §4.2: "every command is in the palette and the sheet", but J/K, 1-9, date presets, ⌥-click and pinch cannot be palette rows. Recommend `palette: false` on movement keys and sheet-only gesture entries (GAP-13); the test covers every runnable command.
11. **Imported legacy conversations** have thread-id citations and no quotes. Recommend: show the subject and sender in the popover and no quote; do not re-run old questions.
12. **Step-log headline.** Which step becomes "Read 14 emails from Jordan · 3 steps"? Recommend the engine marks one `headline` step (the largest read); the renderer appends the step count.
13. **Remote rows' actions.** The mockup hides Done/Later/Trash on "From Google" rows; they are real Gmail threads (`origin='search'`). Recommend the same actions as local rows.
14. **"History" in Ask's ↑/↓.** Recommend: in an empty field inside a conversation, ↑ recalls this conversation's earlier questions (shell-style); in the empty state, ↑/↓ moves through suggestions and recents (as drawn).
15. **Palette "Ask about “x”" fallback.** DESIGN lists an Ask group; the mockup shows "No commands match". Recommend a last row "Ask about “x” · Return" that opens the dock and runs it.
16. **`>` in Search.** Recommend: `>` as the first character opens the palette with the rest of the text as its query; the Search field keeps its previous text.
17. **Stopped answers.** Recommend: keep the partial text and citations so far, with a dim "Stopped." line; no proposal from a stopped run.
18. **Thread row display fields** used by the palette context line and search rows: display sender (from `participants`), "replied", account address. Probably raised by `ui-home` too. Recommend the Thread row carries `fromName`, `fromAddress` (latest inbound sender), `replied: boolean`.

## DESIGN vs mockup

| # | Disagreement | Wins | Behaviour change |
|---|---|---|---|
| 1 | `ask.html` draws no provider-error, no-source, stopped, streaming-answer or dictation state; DESIGN requires them (§7.7, §7.15, §8) | DESIGN | Yes: five undrawn states, copy read at the owner review (plan 30 decision 6) |
| 2 | ⌘Return in the Ask field: mockup = normal ask; DESIGN §8 = "search all mail" | DESIGN | Yes (UNCLEAR-3) |
| 3 | Esc ladder: mockup inserts "dismiss pending proposal" between clear and close; DESIGN §8 says "stop → clear → close" and separately "Return / Esc on proposals" | Compatible; recommend stop → clear → dismiss proposal → close | Small |
| 4 | Proposal: DESIGN one consequence line "Add to Calendar · Thu 14:00–14:30 · Work" and two **key rows** ("Add, Return" / "Not now, Esc"); mockup has kicker + title + when line and buttons, Esc only in the tooltip | DESIGN for content (show the Esc keycap); mockup layout is fine | Small |
| 5 | Hour format 24 h (DESIGN) vs 12 h (mockups) | Locale (UNCLEAR-8) | No |
| 6 | Today "the next event, the following two"; mockup also shows a past event dimmed and a now line | Both (DESIGN lists a now line) | No |
| 7 | Today sub lines: "Climbing with Theo" shows "Personal" without a duration; others show duration | Mockup inconsistency; show duration for all timed events | No |
| 8 | Palette first-open Go to omits Done, Sent, Trash, Spam (shown only when typing); fine. The full Go to list omits **Done** | DESIGN §7.1 (Done is a place) | Yes: add "Done" |
| 9 | Palette mockup lacks `aria-activedescendant` on the combobox | DESIGN §11.3 | Yes (a11y) |
| 10 | Palette destructive example "Delete forever" | Neither: not implementable on Gmail (UNCLEAR-1) | Yes |
| 11 | Context line shortens the subject | DESIGN ("naming the target"); full subject (UNCLEAR-9) | Small |
| 12 | Search field: mockup has no focus underline; DESIGN §7.9, §11.2: 2 px accent underline | DESIGN | Yes (visual) |
| 13 | Search hint line "Narrow with from:, …" and remote copy "Searching Google…", "Nothing on Google either. Try fewer words." are mockup-only | Mockup copy adopted unless the owner objects | No |
| 14 | Remote rows without hover actions in the mockup | Recommend actions (UNCLEAR-13) | Small |
| 15 | Toolbar Ask tooltip key: `ask.html` shows ⌘J, other pages show A; DESIGN §7.1 "Ask ... A" | DESIGN (A; ⌘J belongs to the dock's close button) | No |
| 16 | Shortcut sheet mockup omits Done place "H move to Home" and Calendar "Y / M / N answer an open invite" (DESIGN §8) | DESIGN; the generated sheet includes them | No |
| 17 | `mockups/NOTES.md:139` says DESIGN doesn't name the dock surface; DESIGN §2.2/§6 now says it is a `Pane` | DESIGN | No |

## Harness scenarios and test list

**Scenarios used:** `demo` (Ask with scripted answers, Today day, search corpus), `empty` (no conversations, no events, palette with no target), `ai-off` (no-provider state; palette and search still work), `ai-budget-spent` (background cap reached; Ask still answers, ARCH §8.4), `rate-limited` (remote search paused with resume time), `offline` (remote search unavailable; local works), `needs-reauth` (remote search for that account refused), `small-10k` and `large-100k` (search typing latency, palette budget), `partial-threads` (search rows with `partial`).

**New scenarios proposed:** `ask-scripted` (the 20 fixture answers of U7 acceptance 4: cited, no-source, multi-step, with event/draft/triage proposals, stopped, provider error, daily limit, slow streaming); `today-busy` (fixed clock 10:00 with a past event, next, two following, two gaps, an all-day and a declined event).

**`Fixture/control` knobs needed:** `setClock` (exists); `ask.script(name)`; `ask.stepDelayMs`, `ask.tokenDelayMs`; `ask.failNext({type:'aiProvider'|'aiDaily'|'aiNotConfigured', provider, resetAt?})`; `ai.providers([...])` (configured set); `transcribe.result(text)` / `transcribe.failNext`; `search.remote.result(rows)`; `search.remote.failNext({type:'throttle', retryAfterMs})`; `search.remote.callCount()` (spy); `failNextWrite` (exists, for proposal accept).

**Behaviour / DOM**
- `ask answer cites or says no source` – every one of 20 fixture answers shows ≥ 1 `[n]` chip or "No source in your mail".
- `ask decisive span single` – each answer has at most one weight-500 span.
- `ask citation hover shows quote and source` – hover/focus `[1]` shows the quote and "Mina Cho · Oct 27 · Hollow Creek review".
- `ask citation click opens thread at message` – click `[1]` opens the reader on `threadId` scrolled to `messageId`.
- `ask working step line names real step` – first step frame renders "Reading 14 emails from Jordan" as one line; folds into a step log "Read 14 emails from Jordan · 3 steps".
- `ask input never disabled while streaming` – field accepts text during every streaming frame.
- `ask follow-up queues as editable card` – Return during a run adds a "Queued" card; it runs after the final frame.
- `ask proposal accept applies once` – Add creates one event, shows "Added to Calendar · …", toast with Undo; Z removes the event and restores the card.
- `ask proposal dismiss persists` – Not now hides the card; reopening the conversation keeps it dismissed.
- `ask proposal nothing applied without confirm` – no `Event/set`/`Thread/act` call before Add.
- `ask no provider before asking` – `ai-off`: dock shows "Ask needs a provider. Choose one in Settings." and the link; no red text.
- `ask provider error line` – `ask.failNext(aiProvider groq)`: "Groq didn't answer." with Retry and "Use another provider"; Retry re-runs once.
- `ask use another provider lists configured chat providers` – the menu excludes the failing and unconfigured providers.
- `ask provenance on hover` – hovering the answer shows "Answer by Groq"; Ollama shows "on this Mac"; nothing shows at rest.
- `ask recents with times` – demo shows three recents with "9:42 AM", "Yesterday", "Mon".
- `ask new chat` – ⌘N clears to the empty state and the next question creates a new conversation.
- `ask works under ai-budget-spent` – the scenario answers a question normally.
- `today agenda` – `today-busy`: heading, "4 events · next at 11:00 AM", past dimmed, next bold, now line at 10:00, gaps "Free for 2 h 45 min" and "Free for 3 h".
- `today updates on clock` – advancing the clock past 11:15 moves "next" to the 2:00 PM event.
- `palette first open groups` – shows only Suggested and Go to, numbered 1-9.
- `palette reach` – every registry command with `palette !== false` is reachable by its label (U7 acceptance 1).
- `palette settings reach` – every `SettingRow` registers a palette entry (U7 acceptance 2).
- `palette context line truthful` – property test over 30 contexts: the line names the focused target or is absent.
- `palette scoring oracle` – fuzzed against a second agent's oracle: exact > prefix > word boundary > subsequence; recents never beat exact.
- `palette nested page breadcrumb` – "Move to label…" shows a breadcrumb and the labels list; Esc returns one level.
- `palette destructive defaults to cancel` – Return cancels, ⇧Return confirms; the live region announces the choice.
- `search operators become tokens` – typing `from:jordan ` makes a pill; Backspace on an empty field removes it.
- `search parser parity` – the renderer's pills and the engine spec come from the same `parseSearch` for 100 fuzzed queries.
- `search local as you type` – each keystroke updates the window; zero remote calls (U7 acceptance 7, spy).
- `search remote exactly once` – Return calls `Search/remote` once; a second Return with unchanged text calls nothing; `reset` does not re-call.
- `search remote merge` – "From Google" lists only hits absent from "In your mail".
- `search remote paused` – `rate-limited`: Return shows the plain pause line with the resume time and no Google call.
- `search no match` – "No mail matches ‘dentist’." plus "Search all mail on Google · Return".
- `search to palette` – typing `>` opens the palette.
- `dictate to ask` – hold A 300 ms: level meter shows; release puts `transcribe.result` text in the field; audio goes through `Blob/put`, never base64.

**Keyboard paths**
- `A tap focuses ask` – A opens the dock (if closed) and focuses the field on keydown.
- `A hold dictates` – hold past 250 ms starts dictation; inside the field the typed "a" is removed when the hold completes.
- `cmd J toggles dock focus safe` – ⌘J toggles; focus moves to the field or back to the list, never lost.
- `shift A opens today` – ⇧A opens the dock on Today; the calendar button is pressed.
- `ask esc ladder` – Esc stops a run, then clears text, then dismisses a pending proposal, then closes the dock; never navigates.
- `ask cmd return search all` – ⌘Return in the field sends `searchAllMail: true`.
- `ask cmd return in queued card` – sends that card now (cancels the current run).
- `ask arrows through suggestions` – ↑/↓ moves through suggestions and recents; Return asks.
- `ask return on proposal` – Return with a pending proposal and an empty field accepts it.
- `palette 1-9 only when empty` – digits type into a non-empty field.
- `palette esc up then close` – Esc in a nested page goes up; at top level closes; ⌘K toggles.
- `search arrows hand off to list` – ↓ from the field puts the cursor on the first row; J/K, E, L, X work; arrow triage off (decision 7).
- `keys never dropped while dock animates` – 5 J presses during the dock open land five rows down (§5 rule 4).
- `ime safe in ask and search` – no shortcut fires while `isComposing` (Japanese and Chinese IME).

**Visual states (light and dark)**
- `ask` × {answer, empty, working, no-provider, provider-error, no-source, stopped, dictating, today} × {light, dark}.
- `palette` × {commands, filtered, nested, confirm, no-match} × {light, dark}.
- `search` × {results, results+remote, remote-busy, remote-none, remote-paused, no-match} × {light, dark}.
- `shortcuts` × {default, filtered} × {light, dark}.
- Increase Contrast pass for each of the above; reduced motion: dock and `settle` become opacity ≤ 120 ms.

**Accessibility**
- `axe ask palette search` – axe clean in every harness state, both themes.
- `palette combobox pattern` – `role=combobox`, `aria-expanded`, `aria-controls`, `aria-activedescendant` tracks the active option.
- `ask live region phases only` – the working pane announces step lines, not tokens.
- `citation accessible name` – chips read "Source 1, Mina Cho, October 27"; popover reachable by focus.
- `today now line labelled` – separator "Now, 10:00 AM"; events have text equivalents (time, title, calendar).
- `search results listbox` – results `role=listbox` with `aria-activedescendant`; live "N results in your mail."
- `dictation typed equivalent` – every dictation path has a typed path (§11.4).
- `icon buttons labelled` – close, send, citation, token remove all have labels and tooltips.

**Design checks**
- `banned strings` – no "Ask me anything", "Hold to talk", "magic", "AI-powered", "smart", "Copilot", "Beta" in any state.
- `banned glyphs` – no sparkle, wand, star, brain, robot icon names in `ask`, `today`, `palette`, `search`.
- `one filled button` – Ask: only the proposal's Add is filled; with the palette open, Home's suggestion is demoted; Search: none.
- `hover never shifts` – hover every interactive element in all states; no other box moves > 0.5 px (step-log summary, citations, recents, remote row, palette rows).
- `no spinner under 150 ms` – remote "Searching Google…" and Ask working line absent when the response arrives in < 150 ms.
- `contrast pairs` – dim step log, quote popover source line, gap lines, now-line label (`--stamp-ink`), destructive key row: ≥ 4.5:1 in both themes.
- `serif only for Ask prose` – Newsreader only on answer text and the quote popover; the question line is sans.
- `no secrets` – no canary key or `*_API_KEY` value in any Ask, palette or search DOM, attribute or screenshot (U7 acceptance 3).
- `palette budgets` – open < 50 ms, filter one keystroke < 16 ms at `large-100k`.
