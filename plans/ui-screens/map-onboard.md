# UI-screens Phase 0 contract map: `ui-onboard`

Lane `ui-onboard` (plan 30 U8). Written 2026-10-27 (day 1) against the PLANNED contract. None of `packages/contract`, F9 or the stand-in exists yet.

## Scope

Covers the onboarding window (`onboarding-welcome.html`; `onboarding-accounts.html` choose, typed, waiting, connected, icloud; `onboarding-ai.html` groq, byok, local, consent; `onboarding-permissions.html` default, granted), the first-sync screen (`onboarding-sync.html` progress, paused, ready, partial, failed), the "Try the keys" drill (`onboarding-drill.html` step1, step3, done), the zero-accounts and first-mail empties (`empty.html` no-accounts, first-mail), demo mail (`demo.html`, plus the demo row of `settings-accounts.html`), "Show welcome", and the weekly Gmail reconnect: the status-slot lines (`errors.html` reconnect, quota), the Settings account row, the account-switcher row and the **reconnect sheet** (no mockup). DESIGN §7.11, §7.12, §7.1 (status slot table, reconnect sheet paragraph), §7.14 (no accounts, first sync), §7.15 (reconnect rows), Appendix C F1-F14; plan 30 U8, §4.5 rows 1, 8, 9, 10, 11, §8.1 items 6, 10, 11, 12, 13; plan 10 §4.1 `Setup/status`, E5 items 3, 5, 7; ARCH §6.4, §8.3, §12.5; `research/pr21-onboarding-review.md`. Round 1 offers **Google only** (roadmap §1 "Gmail first", line 183; DESIGN §7.11 step 2). Microsoft, iCloud, IMAP and Fastmail states in the mockups are round 2 and listed as such.

Abbreviations: P10 = `plans/10-engine-foundation.md`, P20 = `plans/20-providers-sync.md`, P30 = `plans/30-ui-revamp.md`, RM = `plans/00-roadmap.md`, D = `plans/DESIGN.md`, A = `plans/ARCHITECTURE.md`.

## Element map

### A. Onboarding window itself (main process; no single mockup, every `onboarding-*.html` has `data-window="onboarding"`)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Main picks onboarding vs mail window at start | 7.11 Window | `Session/get.hasAccounts` read by main before any window | P10 §4.1 verbs, E5 item 7; P30 §8.1 item 11 | COVERED |
| "Setup not done" half of the rule (P30 U8: "no accounts, setup not done"); Skip setup with zero accounts, then relaunch | 7.11; 12.5 ("seeding `onboardingDone`") | A persisted setup-completed fact; `hasAccounts` must say whether demo-only counts | none: `hasAccounts` only; D §12.5 names an `onboardingDone` nobody defines | GAP-7 |
| Launch at login with no accounts stays windowless | 7.11 (P30 U8 wish table) | `wasOpenedAtLogin` in main | P10 E1 item 4 | COVERED |
| 640 × 600, min 640 × 520, vertical resize, hidden-inset title bar, 48 px strip, traffic lights | 7.11 Window | `BrowserWindow` options in `main/windows/onboarding.ts` | P30 U8 Ownership; P10 E1 item 2 (`windows.ts` split) | COVERED |
| Onboarding window gets its own engine port | 7.11 | `MessageChannelMain` per window | P10 E3 item 5 | COVERED |
| Renderer asks main to hand off to the mail window (Open Aplos, Esc, Continue anyway, auto-enter, Skip setup, Try demo mail) | 7.11 Handoff; 7.12 | Desktop method, e.g. `window.finishOnboarding {account:'all', notice?:'demoLoaded'}` | none: ARCH §9.4 lists `window.*` only as a namespace; legacy `onboarding.finish` is not carried over by name | GAP-8 |
| Mail window created hidden, shown on `ready-to-show`; onboarding fades 120 ms in the same callback [F4] | 7.11 Handoff | Main-side sequencing; fade done by main or by a host event to the onboarding renderer | P30 U8 (F3/F4 row); P10 §8.1 item 10 hidden windows | UNCLEAR-15 |
| Mail window opens on All accounts [F7] | 7.11 Handoff | Engine never changes account selection on connect; handoff passes `account:'all'` | P30 U8 F7 row ("eng-ai stops selecting"); selection storage not defined | UNCLEAR-21 |
| Second launch during startup never opens a second window [F3] | 7.11 | `second-instance` guarded by `started` | P30 U8 F3 row; P10 E1 item 4 | COVERED |
| Closing at any step ends the setup session [F1, F2, F5, F6] | 7.11 Closing | `Setup/end` called on every close, including red button / ⌘W where the renderer may not run | P10 E5 item 5; P10 §7.2; main's own engine connection exists (P10 E3 item 6) | UNCLEAR-7 |
| What `Setup/begin` takes and returns; how a connect is tied to the session; which accounts `Setup/status` reports (Show welcome must not list old accounts) | 7.11, 7.12 | `setupId`; `Account/connect {setupId?}`; `Setup/status {setupId}` | P10 §4.1 names only `Setup/begin|end|status` | GAP-2 |
| Show welcome from Settings → Help opens onboarding beside the mail window "without changing anything" | 7.11 Window; P30 §4.5 row 9 | Desktop method `window.openOnboarding {step?}` callable from the mail window | none | GAP-8 |
| Global keys (⌘K, ⌃1-8, A, C) inert in the onboarding window; Return / Esc per step; Tab order = visual order | 7.11 Keys; 8 | `CommandRegistry` context `onboarding` (and `firstSync`, `drill`, `sheet`) | P30 §4.2 context list: global, list, home, reader, compose, ask, calendar, palette | GAP-17 |
| Browser-preview route `?onboarding=1` | 12.5 [F14] | Route in `renderer/main.tsx` (REQUEST to `ui-shell`); native methods absent in preview | P30 U8 Deliverables "Taken" | COVERED |
| Harness seeds or drives onboarding [F14] | 12.5 Onboarding | Seed for "setup done" or a scenario that starts in the mail window | D §12.5 (`onboardingDone`), undefined in contract | GAP-7 |
| Step dashes, "Setup continues in the background.", footer buttons | 7.11 Window | Component for dashes and the strip/footer frame | D §6 inventory has no `StepDashes` or onboarding frame | GAP-16 |
| Steps top-anchored, scroll inside window, Welcome `safe center` [F13] | 7.11 | CSS only | D §7.11 | COVERED |

### B. `onboarding-welcome.html` (one state)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| `display` "Mail and calendar, one letter at a time." + lede + filled "Add an account · Return", no icon | 7.11 step 1 | Static copy; `Button filled`, `Kbd` | D §6 | COVERED |
| "Try demo mail" text button, top-right strip, no-drag, ≥24 px, tooltip "Load sample mail to look around. Remove it any time in Settings." | 7.11 Window | `Demo/load` then handoff, skipping first sync; mail window shows "Demo mail loaded. Remove it any time in Settings." (`demo.html` toast) | P10 E5 item 7; P30 §8.1 item 11 | COVERED (call); handoff notice: GAP-8 |
| `Demo/load` must resolve only after demo rows are committed, and say which accounts it made | 7.11 step 1 | `Demo/load → {accountIds}` | P10 §4.1 names only | GAP-6 |
| Footer "Skip setup · Esc" → mail window with zero accounts (`empty.html?state=no-accounts`) | 7.11 Keys ("on Welcome it means Skip setup") | `Setup/end {reason:'skipped'}` + handoff with no accounts; persisted "skipped" so relaunch does not loop | GAP-7, GAP-8 | GAP-7 |
| Step dashes "Step 1 of 4" | 7.11 | `StepDashes` | none | GAP-16 |

### C. `onboarding-accounts.html` (choose, typed, waiting, connected, icloud)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| choose: heading "Add your mail", lede "Type your address and Aplos finds the right sign-in. Aplos reads your mail on this Mac." | 7.11 step 2 | Static copy | D §7.11 | COVERED |
| choose: provider rows Google / Microsoft / iCloud / Other mail (IMAP) | 7.11 step 2 | Round 1: Google row only; others round 2 | RM line 183; D §7.11 step 2 | COVERED (as Google-only; see DESIGN vs mockup 1) |
| typed: address + Return → discovery (incl. Google Workspace custom domains via MX) → "Found" row "Google · You sign in on Google's own page in your browser…" | 7.11 step 2 [F12] | `Account/discover {address} → {provider, auth, supported, displayName?}`; DNS runs in the engine host, not the renderer | P30 §2 table and P10 §7.2 say discovery moves behind `Account/discover`; P10 §4.1 only says "the rest of `Account/*`"; no shape | GAP-5 |
| typed, round 1: address on a non-Google provider | 7.11 step 2 (round 1 Google only) | `supported:false` + copy ("Aplos works with Google accounts in this version.") | none | GAP-5 |
| typed: Return focuses "Continue with Google" [F12] | 7.11 step 2 | Renderer focus rule | D Appendix C F12 | COVERED |
| waiting: "Waiting for Google in your browser…", lede, indeterminate track, Cancel · Esc | 7.11 step 2 | Pending connect that can be cancelled; browser opened by main | `Account/connect` named (P10 §4.1); no pending state, no cancel; browser open via host event `openExternal` (P10 E3 item 6) | GAP-4 |
| waiting: Google consent closed or abandoned (timeout), user presses Cancel on Google's page (`access_denied`), wrong scopes unticked (no `gmail.modify`, P20 PV3 item 8) | 7.11 step 2; 10 | Connect failure `reasonCode` + copy | P20 PV3 item 8 ("refused … in a plain sentence"); codes not listed | GAP-13 |
| waiting copy "Aplos only asks to read and send your mail and calendar" | 10 | Must match the scope manifest (`gmail.modify`, `gmail.settings.basic` filters, calendar) | P20 PV5 scope manifest | UNCLEAR-22 |
| Late resolve after the owner moved on never navigates; list updates in place [F9] | 7.11 step 2 | Account list pushed live to the onboarding window; connect outcome as an event not a stale promise | Singletons in P30 §4.1; `state` frame P10 E3 item 4 (content per type unspecified) | GAP-4 |
| connected: "Your accounts" rows: dot, address, "Google", "Connected" | 7.11 step 2 | `Account` row `{id, address, provider, color, status}` | A §3.2 `accounts` (address, provider, status); colour by hash D §4.2; no `color` field | GAP-6 |
| connected: account dot shown with one account | 4.2 decision 16 | | | UNCLEAR-20 |
| connected: "Continue · Return", "Add another account" | 7.11 step 2 | Renderer | D §7.11 | COVERED |
| icloud: app-specific password form | 7.11 step 2 (round 2) | `Account/connect {provider:'imap', password}` | P30 §4.5 row 7: round 2 | COVERED (out of round 1) |
| Back · Esc: waiting → cancel; choose/connected → Welcome | 7.11 Keys | Cancel call | GAP-4 | GAP-4 |

### D. `onboarding-ai.html` (groq, byok, local, consent)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| groq: Groq preselected, "Default", "Key found in the environment as `GROQ_API_KEY`" | 7.11 step 3; 7.10 AI | Provider entry `{id, keySource:'env'|'keychain'|'none', envVar}` | P30 U7 depends on "`eng-ai` … the AI provider table with `trainsOnInputs`"; no method or field list | GAP-10 |
| groq: Test → "Works · 0.4 s" | 7.11 step 3 | `AiProvider/test {id} → {ok, latencyMs, reasonCode?}`; result never contains the key | none | GAP-10 |
| groq with no env key: "a field" | 7.11 step 3 | `AiProvider/setKey {id, key}` write-only | none | GAP-10 |
| More options → "Use another provider", "Run on this Mac" | 7.11 step 3 | Renderer disclosure | D §7.11 | COVERED |
| byok: provider menu OpenAI, Claude, Gemini, OpenRouter, OpenCode Go, Custom server; key field; "Saved in Keychain on this Mac. Never shown again." | 7.11; AGENTS.md | `AiProvider/list`, `AiProvider/setKey`; custom needs `baseUrl` + optional key | AGENTS.md provider list; no contract | GAP-10 |
| byok Gemini on a free key: mail never goes to a `trainsOnInputs` provider | 8.3 (A) | `trainsOnInputs`, "key is paid" flag, plain refusal copy on the consent card | P10 E5 item 3; A §8.3; no UI field named | GAP-10 |
| local: Ollama "Found at localhost:11434" (status dot), model menu "llama3.2:3b"; LM Studio "Not running", "Check again"; address field behind More options | 7.11; AGENTS.md | Reachability probe, local model list, `Settings.ai.providers.{ollama,lmstudio}.baseUrl` | none beyond "address changeable in Settings" (AGENTS.md) | GAP-10 |
| Which model the step picks, and what the choice writes to `Settings.ai.features.{ask,summaries,drafts,plans,voice}.{provider,model}`; Voice when the provider has no speech-to-text | 7.10 AI; AGENTS.md | Default model per feature per provider; onboarding write rule | RM F1 "per-feature AI provider and model" (fields only) | UNCLEAR-9 |
| consent card: Provider "Groq", Model "llama-3.3-70b-versatile", What is sent "The sender, subject and text of each new email, and your question when you use Ask. Attachments are not sent."; "Ollama and LM Studio keep all of this on your Mac."; Allow · Return / Not now | 7.11 step 3; P30 §4.5 row 1; A §8.3 | `Consent/get` and `Consent/grant {scope, version, provider, model}`; the stored record must name the model | P10 §4.1 table row 6 `Consent/*` (no shape); A §3.2 `consent(scope, version, provider, granted_at)` has no model | GAP-11 |
| Consent covers Ask too? (card text mentions Ask) | 8.3 | Scope values | none | UNCLEAR-8 |
| Skip for now / Not now: no error later; Sort segment omitted | 7.11 step 3; 7.12 | `Setup/status.ai` absent without consent | P10 §4.1 ("`ai` appears only with stored consent and a provider") | COVERED |
| Re-consent after provider change: Settings → AI `ErrorLine` "Background summaries are paused until you agree to the new provider." + Review | P30 §4.5 row 1 | `Consent/get.needsReconsent` | P10 E5 item 3 (version bump pauses) | GAP-11 |
| One card on the step; one filled button | 7.11; 12.5 | `Pane`/card | D §6 | COVERED |
| Radio rows, select trigger | 6 | `Radio`, `Select` in `ui/` | D §6 has neither | GAP-16 |

### E. `onboarding-permissions.html` (default, granted)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Microphone "Allow…" → macOS prompt → "Allowed"; line "Hold A to dictate to Ask, or R to dictate a reply. Speech goes to Groq or OpenAI to become text." | 7.11 step 4 | `system.permission.get|request {kind:'microphone'}` (Electron `getMediaAccessStatus` / `askForMediaAccess`) | ARCH §9.4 `system.*` namespace only; P40 Q fact 5 keeps the trusted-window mic rule | GAP-9 |
| Microphone denied earlier: open System Settings | 7.11 step 4 | `system.openPrivacySettings {pane}` + copy | none; state not drawn | GAP-9 |
| Notifications "Allow…" → "Allowed"; "Only for mail that reaches Home." | 7.11 step 4; 7.13 | Notification authorization status and request | none; Electron has no documented request API on macOS | UNCLEAR-13 |
| "Open Aplos when you log in" switch | 7.11 step 4; 10 | `system.login` set + get | P10 E1 item 4 ("existing `system.login` method"); read-back not named | UNCLEAR-23 |
| Speech line names the real STT provider | 7.10 AI | `Settings.ai.features.voice.provider` | RM F1 | COVERED |
| "Finish setup · Return" → first-sync screen | 7.11 | Renderer | D §7.11 | COVERED |

### F. `onboarding-sync.html` (progress, paused, ready, partial, failed)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Live updates of every count below without polling | 7.12; 5 rule 12 | Push path for `Setup/status` (frame or `state` type) | P10 §4.1 frames `state, window, progress, reset, host`; `Setup/status` is a call only | GAP-1 |
| Per-account row: dot (account colour), address, right-side status ("Reading 24 of 50", "Paused until 2:14 PM", "Sorting", "Ready") | 7.12 | `Account.{address,color}`; `Setup/status[].state` enum | `state` present, values unspecified (P10 §4.1) | GAP-3 |
| Segment 1 Connect ✓ "Connected" | 7.12 | `state ≥ connected` | P20 §551 checkpoint "connected" | COVERED |
| Segment 2 "Found about 214 recent emails" only with an estimate; else "Found recent mail" + quiet indeterminate bar | 7.12; P30 U8 | `firstWindow.found?`; a "finding" phase so the bar can be indeterminate | P10 §4.1 `firstWindow.found?` | COVERED (count); phase: GAP-3 |
| Segment 3 "Reading your newest mail · 24 of 50" | 7.12 | `firstWindow.read`, `.total` | P10 §4.1 | COVERED |
| Small mailbox (12 threads): "12 of 50" must not hang | 7.12 ("never a fake percentage") | `firstWindow.done` and `total` = min(target, available) once known | P10 §4.1: "complete when plan 20 sets `baseline_done_at`" but no field exposes it | GAP-3 |
| Segment 4 "Sort what matters · 8 of 40"; omitted with no provider/consent | 7.12 | `ai.sorted`, `ai.total`, `ai` absent | P10 §4.1 | COVERED |
| partial: "Sorted 12 of 40. The rest continue in the background." Never "Done" [F10] | 7.12 Honest outcomes | `ai.capped` | P10 §4.1 | COVERED |
| AI failure: "Couldn't sort with Groq: the key was refused. Mail is ready; sorting will retry." + "Open Settings" | 7.12 Honest outcomes | `ai.provider`, `ai.reasonCode` (failed is only a count today) | P10 §4.1 `ai.failed` count | GAP-3 |
| paused: lede "Google asked us to slow down. Resuming at 2:14 PM. Your newest mail will appear first."; marker static pause icon; `--dusk` segment | 7.12 Rate limits | `pausedUntil`, pause class (throttle vs daily), provider name | P10 §4.1 `pausedUntil?`, `reasonCode`; A §3.2 calls it `resume_at`; P30 §8.2 `resumeAt` | UNCLEAR-1 |
| paused (daily limit) wording | 7.1 table | Pause class distinct from throttle | P20 PV3 item 3 ("throttle or daily class sets paused(until, reason)") | GAP-13 |
| failed: "Some mail didn't come through" / "Nothing was lost. Aplos keeps trying in the background."; per-account reason sentence ("Google did not answer after three tries. Your mail is safe.") in ink with `--stamp-ink` icon | 7.12 Failure | `errors[] {accountId, phase, reasonCode, at}` | P10 E5 item 5 "collects errors" (no shape) | GAP-3 |
| failed: per-account "Try again", idempotent, never collides [F5] | 7.12 Failure | `Setup/retry {setupId, accountId} → {runId}` | P10 E5 item 5 (per-job ids) names no retry method; `Sync/request` refuses while paused (P20 PV3 item 3) | GAP-12 |
| Counters never move backwards, but a Retry may restart them | 7.12; P30 U8 acceptance 4c | `runId` on each account entry | none | GAP-3 |
| "Not connected · Try again" for a skipped or never-connected account, never endless "Waiting" | 7.12 Honest outcomes | `state:'notConnected'`; Try again re-runs connect | none | GAP-3 |
| "Open Aplos · Return" enabled once newest batch is in (any one account ready) | 7.12; P30 U8 | `firstWindow.done` per account | GAP-3 | GAP-3 |
| "Continue anyway" text button from Connect (P30 U8, mockup) | P30 U8 | Renderer | not in D §7.12 | UNCLEAR-4 |
| Footer "Esc opens Aplos"; screen owns Esc in every state [F8] | 7.12 | `firstSync` key context owning Esc | GAP-17 | GAP-17 |
| Entering before any mail → Home "Your first mail is on its way." + status reason | 7.12; 7.14 | See section H | P30 §4.5 row 10 | COVERED |
| ready: drawn 40 px check, "Your mail is ready", "Aplos opens by itself in a moment.", "Open now · Return"; rows "Newest 50 read · sorted 40 of 40" | 7.12 Ready | Clean-finish rule from status fields | P30 U8 "Auto-enter only on a clean finish" | COVERED |
| Clean finish when the AI pass was capped | 7.12 vs P30 U8 | | conflict | UNCLEAR-2 |
| Auto-enter delay (mockup 3.2 s) | 7.12 | Renderer constant | none | UNCLEAR-10 |
| One visually hidden `role="status"`, phases only; bars labelled "<address> sync" with `aria-valuetext` [F11] | 7.12 Accessibility; 11 | Phase transitions derivable from `state` | GAP-3 | GAP-3 |
| Segments neutral: done `--ink-2`, paused `--dusk`, failed `--stamp`; motion on the marker | 7.12 | `ProgressSegments` props (4 or 3 segments, part %, indeterminate, paused, failed, compact) | D §6 names `ProgressSegments`, no props | GAP-16 |
| "Try the keys while you wait" link | 7.12 | Renderer mode switch | D §7.12 | COVERED |
| Multi-account: a row each; window can open when one is ready | 7.12; P30 U8 | Per-account entries keyed by `accountId` | P10 §4.1 "per account" | COVERED |
| Failed-state second account "Fastmail refused the app password…" | 7.12 | Round 2 | RM line 183 | COVERED (out of round 1) |
| Same component for Settings "Add account" and the status slot's "Importing N of M" | 7.12 Ready; P30 U8 | `Setup/status` readable from the mail window | GAP-1, GAP-2 | UNCLEAR-12 |

### G. `onboarding-drill.html` (step1, step3, done)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Compact progress per account (spinner marker, "Reading 24 of 50", labelled bar) above the drill | 7.12 Try the keys | Same `Setup/status` feed | GAP-1 | GAP-1 |
| "Try the keys while you wait" / "Practice letters. Nothing real changes."; three invented practice letters, listbox, cursor row, tiny focus letter with serif summary and Space suggestion | 7.12 | Renderer-only constants (no engine call, no demo account); `ListRow` and `FocusLetter` accept plain row objects | D §6 `ListRow` (props not frozen) | UNCLEAR-18 |
| Steps J/K, Space, E, A with keycaps; "n of 4" | 7.12 | Keycaps read from `CommandRegistry` bindings (remaps) | P30 §4.2 | COVERED |
| E removes the row with `carry`; reduced motion → opacity | 7.12; 4.8 | Motion runtime `ghost.ts` | P30 §4.3 | COVERED |
| Single letters belong to the drill (not app commands); Esc still opens Aplos | 7.12 | `drill` key context | GAP-17 | GAP-17 |
| done: "That is the whole loop. Press ? in Aplos any time to see every key."; "Back to progress · Return" | 7.12 | Renderer | D §7.12 | COVERED |
| Clean finish while the drill is open | 7.12 ("never blocks") | Rule | none | UNCLEAR-10 |

### H. `empty.html` (no-accounts, first-mail) and the zero-accounts mail window

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| no-accounts: `EmptyLine` "Add an account to bring in your mail." + filled "Add an account" + text "Try demo mail" | 7.14 | `Session/get.hasAccounts` false; "Add an account" opens onboarding at the Accounts step; "Try demo mail" → `Demo/load` in place | P30 §4.5 row 8; GAP-8 for opening onboarding | COVERED (data) / GAP-8 (window) |
| no-accounts sidebar: switcher "No accounts", no status, counts 0 | 7.1 | Account list empty | P30 §4.1 singletons | COVERED |
| first-mail: `EmptyLine` "Your first mail is on its way." with the status reason; never inbox-zero while backfilling, paused, or before baseline | 7.14; P30 §4.5 row 10 | Per-account `baselineDone`/`firstWindow.done` and status, visible to the mail window | `baseline_done_at` (A §3.2) not on the `Account` contract type | GAP-6 |
| first-mail status slot: "Reading your newest mail / 24 of 50" with track (shell.js `firstmail`) | 7.1 table (no such row) | First-window progress in the slot | Status vocabulary has no first-window state (A §6.4) | UNCLEAR-16 |
| Sidebar counts hide during first sync | 7.1; 7.14 | "Any account with first window not done" | GAP-1/GAP-6 | GAP-6 |

### I. `demo.html` and demo controls

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Fresh install: zero accounts, zero demo; nothing seeded or wiped before the click | 7.11 step 1 | Engine rule | P10 E5 item 7; P30 §8.1 item 11 | COVERED |
| Switcher "Demo mail" (mono D); status slot "Demo mail. Remove it in Settings." | 7.1 table | `Account.demo: boolean` (or `provider:'demo'`) | A §3.2 `accounts` has no demo flag; P10 says `Demo/*` "touch only demo accounts" | GAP-6 |
| Toast after handoff "Demo mail loaded. Remove it any time in Settings." | 7.13 | Handoff notice | GAP-8 | GAP-8 |
| Demo + real account together: status slot copy | 7.1 | Rule | none | UNCLEAR-11 |
| Settings demo row Load / Reset / Remove (toasts "Demo mail loaded", "Demo mail reset", "Demo mail removed" + Undo Z) | 7.10 Accounts; P30 §4.5 row 8 | `Demo/load|reset|remove`; Load vs Reset enabled from `Account.demo` | P10 §4.1; location disagrees (P30: Help; D: Accounts; mockup: Accounts) | UNCLEAR-11 |
| Undo on "Demo mail removed" | 7.13 | Inverse op for `Demo/remove` | none (P10 E5 item 7) | DESIGN vs mockup 7 |
| Demo account skips first sync | 7.11 step 1 | `Demo/load` result complete on return | GAP-6 | GAP-6 |

### J. Reconnect: status slot lines, account rows, the sheet (`errors.html` reconnect, quota; no sheet mockup)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| `ok` + `reconnectBy` within 24 h: "Gmail will ask you to reconnect tomorrow at 9:00 AM." + Reconnect now | 7.1 table; 7.15 | `reconnectBy` on account status | P10 §4.1, §7.1; P20 PV5 item 1; A §6.4 | COVERED (line built by `ui-shell`; not drawn) |
| `needsReauth`: "Google needs you to sign in again." + Reconnect (`btn-danger` text) | 7.1; 7.15 | `status.state` | A §6.4 | COVERED |
| `needsPermission`: "Aplos needs permission to read your Gmail." + Reconnect | 7.1; 7.15 | `status.state`; which method the sheet calls | P20 PV5 (`Account/grantPermissions` = full re-consent) vs D (one sheet) | UNCLEAR-6 |
| Account switcher menu row: address, "Google needs you to sign in again.", Reconnect (4th entry point, NOTES.md item 8) | 7.1 (lists 3 entry points) | Same sheet | mockups/NOTES.md item 8 | COVERED (extra entry, same flow) |
| Settings account row filled "Reconnect" (needsReauth, needsPermission, `reconnectBy` < 24 h) | 7.10 Accounts | Same sheet, built here, opened by `ui-settings` | P30 U7 acceptance 8 | COVERED |
| Sheet (`--elev-dialog`, `Dialog`) opens Google in the browser with the address prefilled, in one click | 7.1 sheet | `Account/reconnect {accountId}` using the stored address as `login_hint`; browser via main | P20 PV5 item 3; P30 §8.1 item 13; `openExternal` host event P10 E3 item 6 | COVERED (call) |
| "Waiting for Google in your browser…" + Cancel (Esc) | 7.1 sheet | Pending state + cancel | none | GAP-4 |
| Wrong Google account chosen (`sub` mismatch), consent denied, scope unticked, timeout | 7.1 sheet; 10 | Failure `reasonCode`s + copy (not drawn) | P20 PV5 item 3 ("refused with a plain reason") | GAP-14 |
| Success: sheet closes, toast "Reconnected"; nothing resyncs; local changes kept; focus returns where the owner was | 7.1 sheet; 7.13 | Status back to `ok` pushed; no resync | P20 PV5 item 4; A §6.4 | COVERED |
| In-sheet "Reconnected. Your mail is up to date." (P30 U8) vs toast "Reconnected" (D) | 7.1 | | conflict | UNCLEAR-5 |
| Which account the sheet names; two accounts due at once | 7.1 | Account address in sheet copy; slot priority | none | UNCLEAR-17 |
| quota (status slot): "Google asked us to slow down. Resuming at 2:14 PM." + Retry now | 7.1; 7.15 | `paused` + `resumeAt`; Retry now = `Sync/request` (refused while paused, P20 PV3 item 3) | A §6.4; P20 PV3 | UNCLEAR-24 |
| Stand-in scenario with `reconnectBy` inside 24 h | P30 U8 ("asks for it in the Phase 0 gap list") | Scenario `reconnect-due` | P10 §4.1 scenario list lacks it | GAP-15 |
| Copy never mentions Testing mode, verification or cost | P30 U8 | Banned-string list | P30 U8 | COVERED |

### K. Undrawn surfaces DESIGN requires

| Surface | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Reconnect sheet (all states: waiting, failed, reconnected) | 7.1; P30 U8 | Copy + `ReconnectSheet` (in D §6, built by `ui-onboard`) | D §6 | GAP-14 (failure codes) |
| "Show welcome" row in Settings → Help | P30 §4.5 row 9 | Native open method | settings mockups lack it | GAP-8 |
| AI-failure line on the sync screen + "Open Settings" | 7.12 | Needs `ai.reasonCode` | GAP-3 | GAP-3 |
| "Not connected · Try again" row | 7.12 | `state:'notConnected'` | GAP-3 | GAP-3 |
| Indeterminate "Find recent mail" bar | 7.12 | `ProgressSegments` indeterminate | GAP-16 | GAP-16 |
| Microphone denied, notifications denied | 7.11 step 4 | Native status | GAP-9 | GAP-9 |
| Non-Google typed address in round 1 | 7.11 step 2 | `Account/discover.supported` | GAP-5 | GAP-5 |
| Connect failures (cancelled, timeout, scope missing) on the Accounts step | 7.11 step 2 | reason codes | GAP-13 | GAP-13 |

## Gaps

**GAP-1. A push path for `Setup/status`.**
- Needs: §7.12 "Progress follows engine checkpoints"; "Reading your newest mail · 24 of 50" moving live; §5 rule 12 (no polling spinners). Also the drill's compact progress, sidebar counts hiding, the status slot.
- Why uncovered: P10 §4.1 makes `Setup/status` a call; frames are `state`, `window`, `progress`, `reset`, host events. `state` "coalesces over 50-250 ms" (P10 E3 item 4) but its payload (which types) is not defined, and `progress` is Ask's.
- Proposal: `state` frame carries a per-type state map that includes `Setup` and `Account` (`{types: {Setup: 's12', Account: 's40'}}`); a client re-calls `Setup/status` when `Setup` changes. Or `Setup/watch {setupId}` emitting `setup {setupId, accounts:[…]}` frames at ≤4/s.
- To: `eng-contract`. Severity: blocks-freeze (frame shapes freeze at C1). Stand-in: `Fixture/control advanceSetup` must emit the frame.

**GAP-2. Setup session identity and scope.**
- Needs: §7.11 "Closing … ends the setup session"; "A connect that resolves after closing is classified normally"; Show welcome must show only accounts added in that session; F1 reopen path.
- Why uncovered: P10 §4.1 / E5 item 5 name `Setup/begin|end|status` with no arguments or results. Legacy used `account.connect {setup:true}`.
- Proposal: `Setup/begin {origin:'onboarding'|'settings'} → {setupId}`; `Account/connect {provider, loginHint?, setupId?}`; `Setup/status {setupId?} → {setupId, accounts:[…]}` (no id = every account still in first sync, for the mail window); `Setup/end {setupId, reason:'finished'|'closed'|'skipped'|'demo'}` idempotent, unknown or ended ids are a no-op success.
- To: `eng-ai` with `eng-contract`. Severity: blocks-freeze (method schemas freeze at C1). Stand-in: `setup-partial` plus a knob to end a session from main.

**GAP-3. `Setup/status` per-account fields beyond P10 §4.1.**
- Needs: §7.12 segments, "Not connected · Try again", AI-failure sentence naming Groq and the reason, Open Aplos enable rule, honest counters after Retry, phase-only `role="status"`.
- Why uncovered: P10 §4.1 gives `{state, firstWindow:{found?, read, total}, ai:{sorted, total, capped, failed}, backfill, pausedUntil?, reconnectBy?, reasonCode}`. `state` has no values; nothing says when the first window is done (a 12-thread inbox reads "12 of 50" forever); `ai.failed` is a count without provider or reason; errors have no shape; no run id.
- Proposal (additive to the frozen shape): `accountId`; `state: 'connecting'|'finding'|'reading'|'sorting'|'ready'|'paused'|'failed'|'notConnected'` (open enum); `firstWindow.done: boolean`, and `total` defined as min(target, threads available) once known; `ai.state: 'running'|'done'|'capped'|'failed'|'paused'`, `ai.provider`, `ai.model`, `ai.reasonCode?`; `pause?: {until, class:'throttle'|'daily'}`; `runId`; `errors: [{phase:'connect'|'find'|'read'|'sort', reasonCode, at}]`. Counters monotonic within a `runId`.
- To: `eng-ai` (aggregation), `prov-gov` (checkpoint facts). Severity: blocks-freeze (`state` values and the meaning of `total` are semantics the UI tests encode). Stand-in: knobs in GAP-15.

**GAP-4. OAuth connect and reconnect lifecycle: pending, cancel, late resolve.**
- Needs: "OAuth shows 'Waiting for Google in your browser…' with Cancel"; "A connect that finishes after you've moved on never pulls you back" [F9]; the sheet's waiting + Cancel; PR #21's late-resolve leak.
- Why uncovered: `Account/connect|reconnect|grantPermissions` are named (P10 §4.1, P20 §544) with no pending state and no cancel; a minutes-long RPC is fragile over the HTTP preview binding and gives a stale-promise path for F9.
- Proposal: `Account/connect {provider, loginHint?, setupId?} → {connectId}` returns at once; `Account/reconnect {accountId} → {connectId}`; `Account/cancelConnect {connectId}` idempotent; frame `connect {connectId, kind:'connect'|'reconnect', state:'waiting'|'connected'|'failed'|'cancelled', accountId?, address?, reasonCode?}`; the browser opens through the `openExternal` host event (P10 E3 item 6) with `{url, purpose:'oauth'}`. A connect resolving after `Setup/end` still emits `connected` and the account is classified normally.
- To: `prov-gov` (behaviour), `eng-contract` (shape). Severity: blocks-freeze (changing `Account/connect`'s result later breaks callers). Stand-in: `Fixture/control resolveConnect {connectId, outcome, delayMs}`.

**GAP-5. `Account/discover` shape and round-1 behaviour.**
- Needs: "Typing an address + Return discovers the provider" [F12]; Google Workspace on a custom domain; round 1 offers only Google.
- Why uncovered: named in P30 §2 and P10 §7.2 only; the C1 list says "the rest of `Account/*`".
- Proposal: `Account/discover {address} → {provider:'google'|'microsoft'|'icloud'|'fastmail'|'imap'|'unknown', auth:'oauth'|'appPassword'|'password', supported:boolean, reasonCode?}`; DNS/MX in the engine host; `supported` false for every non-Google result in round 1.
- To: `prov-gov`. Severity: blocks-freeze (P10 §4.1: names and schemas of plan 20 methods freeze at C1). Stand-in: canned answers per domain.

**GAP-6. `Account` contract row fields.**
- Needs: account dot colour (D §4.2 hash + override), "Demo mail" switcher label and status line, demo Reset/Remove enablement, first-sync honesty in the mail window (§4.5 row 10), "Found" provider label.
- Why uncovered: A §3.2 `accounts` has `provider, address, display_name, status, status_reason, resume_at, baseline_done_at` but no demo flag or colour; P10/P30 never list the contract `Account` type's fields; `baseline_done_at` is engine-internal.
- Proposal: `Account {id, address, displayName?, provider, demo:boolean, color?:'sky'|'hill'|'stamp'|'dusk'|'sand'|'ember' (override only), status:{state, reasonCode?, resumeAt?, reconnectBy?}, firstWindowDone:boolean, aiAllowed:boolean}`; `Demo/load → {accountIds}` resolving after commit.
- To: `eng-contract`, `prov-gov`. Severity: additive-later (optional fields), cheap now. Stand-in: `demo` scenario marks its account `demo:true`.

**GAP-7. What "first run" means to main and the harness.**
- Needs: P30 U8 "first run (no accounts, setup not done)"; Skip setup leaves zero accounts; D §12.5 "seeding `onboardingDone`"; a demo-only install must open the mail window.
- Why uncovered: only `Session/get.hasAccounts` is planned (P10 §4.1, E5 item 7); `onboardingDone` exists only in legacy settings.
- Proposal: `Session/get` gains `setup: {completedAt?: number, skippedAt?: number}` and `hasAccounts` counts demo accounts; `Setup/end {reason}` writes it. Main opens onboarding only when `!hasAccounts && !completedAt && !skippedAt`; the harness seeds `completedAt`.
- To: `eng-contract`, `eng-ai`. Severity: blocks-freeze (the meaning of `hasAccounts` is used by main from C1). Stand-in: `empty` = no setup record; new `empty-skipped`.

**GAP-8. Desktop (native) methods for the onboarding window.**
- Needs: handoff on Open Aplos / Esc / Continue anyway / auto-enter / Skip setup / Try demo mail; Show welcome from Settings → Help; "Add an account" from the zero-accounts mail window; demo-loaded toast after handoff; open on All accounts.
- Why uncovered: ARCH §9.4 and P10 E3 item 6 list only the `window.*` namespace; P30 U8 owns `main/windows/onboarding.ts` but no method names; legacy `onboarding.open/finish` are not in any plan.
- Proposal (registry `host: desktop`): `window.openOnboarding {step?:'welcome'|'accounts'}` (focuses the existing one, never a second); `window.finishOnboarding {account:'all', notice?:'demoLoaded'}` (main calls `Setup/end` too, see UNCLEAR-7); the mail window reads the notice once from its launch params.
- To: `eng-host` (registry entries and preload allowlist), built by `ui-onboard` in `main/windows/onboarding.ts`. Severity: additive-later (registry is additive), but needed for the day-5 start. Stand-in: n/a (preview fakes it with routes).

**GAP-9. Native permission methods.**
- Needs: Microphone "Allow…" → "Allowed", a denied state, open at login read-back.
- Why uncovered: only `system.login` is named (P10 E1 item 4).
- Proposal: `system.permission.get {kind:'microphone'|'notifications'} → 'notDetermined'|'granted'|'denied'|'restricted'`; `system.permission.request {kind}`; `system.openPrivacySettings {pane:'microphone'|'notifications'}`; `system.login.get → {enabled}`.
- To: `eng-host`. Severity: additive-later. Stand-in: preview capability flag "Not available yet".

**GAP-10. AI provider table methods (shared with `ui-settings`).**
- Needs: "Key found in the environment as `GROQ_API_KEY`", Test → "Works · 0.4 s", Add key to Keychain, provider menu, Ollama found / LM Studio not running / Check again, local model menu, editable addresses, Gemini free-tier refusal, Voice lists STT providers only.
- Why uncovered: P30 U7 depends on "the AI provider table with `trainsOnInputs`"; RM F1 freezes only per-feature `{provider, model}` in Settings. No methods.
- Proposal: `AiProvider/list → [{id, label, group:'hosted'|'local'|'custom', keySource:'env'|'keychain'|'none', envVar?, baseUrl?, reachable?, trainsOnInputs, paidKey?, capabilities:{chat, stt}, defaultModels:{ask, summaries, drafts, plans, voice?}}]`; `AiProvider/test {id} → {ok, latencyMs?, reasonCode?}`; `AiProvider/setKey {id, key}` (write-only, never echoed or logged; refused for env keys); `AiProvider/removeKey {id}`; `AiProvider/models {id} → [{id, label}]`; `Settings.ai.providers.{ollama,lmstudio,custom}.baseUrl`.
- To: `eng-ai`. Severity: additive-later, needed by day 5. Stand-in: `ai-off` plus a scenario where Groq is from env and Ollama reachable.

**GAP-11. `Consent/*` shape and the record's model.**
- Needs: card naming provider, model, what is sent; re-consent `ErrorLine`; "Not now".
- Why uncovered: P10 §4.1 says `Consent/*`; A §3.2 `consent(scope, version, provider, granted_at)` stores no model; scope values are unnamed.
- Proposal: `Consent/get {scope:'background'} → {scope, version, granted:boolean, provider?, model?, needsReconsent:boolean}`; `Consent/grant {scope, version, provider, model}` (version mismatch → `stateMismatch`); `Consent/decline {scope}`. Add `model` to the `consent` table. "What is sent" copy is the UI catalog's, versioned with `version`.
- To: `eng-ai`, `eng-store` (schema 0001). Severity: blocks-freeze (schema 0001 and method schemas). Stand-in: `ai-off` = no consent; knob to bump version.

**GAP-12. Idempotent per-account Retry on the first-sync screen.**
- Needs: "Some mail didn't come through … Try again"; "Retry is idempotent: a second run never collides with the first" [F5].
- Why uncovered: P10 E5 item 5 gives per-job ids but no retry entry point; `Sync/request` refuses while paused.
- Proposal: `Setup/retry {setupId, accountId} → {runId}`; a second call while a run is active returns the same `runId`.
- To: `eng-ai`. Severity: additive-later. Stand-in: `Fixture/control failNextSetupPhase`.

**GAP-13. `reasonCode` values the onboarding copy keys on.**
- Needs: plain sentences for every failure (§7.12, §7.15, §10 "a raw error is never shown").
- Why uncovered: P20 §551 promises "error reason codes mapped to DESIGN §7.15 copy keys" but lists none.
- Proposal (open string enum, initial set): `throttle`, `dailyLimit`, `providerUnavailable` (3 transient tries), `offline`, `authExpired`, `authRevoked`, `scopeMissing`, `adminBlocked`, `misconfigured`, `wrongAccount`, `cancelled`, `denied`, `timeout`, `unsupportedProvider`, `aiKeyRefused`, `aiRateLimited`, `aiDailyCap`, `aiTrainsOnInputs`, `aiUnreachable`, `appPasswordRefused` (round 2).
- To: `prov-gov`, `eng-ai`, `eng-contract`. Severity: additive-later (open enum), but the initial list should land at C1 so tests can assert copy.

**GAP-14. Reconnect result and failure semantics.**
- Needs: sheet states waiting / failed / reconnected; one sheet for `needsReauth`, `needsPermission` and `reconnectBy`.
- Why uncovered: P20 PV5 item 3 defines behaviour ("a different account is refused with a plain reason") but no result shape; `needsPermission` maps to `Account/grantPermissions` in P20 PV5.
- Proposal: reconnect goes through GAP-4's `connect` frame (`kind:'reconnect'`) with `reasonCode` in {`wrongAccount`, `scopeMissing`, `denied`, `timeout`, `cancelled`}; `Account/reconnect {accountId, fullConsent?:boolean}` where the engine sets full consent itself for `needsPermission`, so the sheet never chooses a method.
- To: `prov-gov`. Severity: blocks-freeze (method schema at C1). Stand-in: `needs-reauth`, new `reconnect-due`, knob `resolveConnect`.

**GAP-15. Stand-in scenarios and `Fixture/control` knobs for this lane.**
- Needs: P30 U8 acceptance 2, 4, 6, 9.
- Why uncovered: P10 §4.1 lists 15 scenarios, none with `reconnectBy` near; knobs are named generically ("advance setup progress").
- Proposal: scenarios `reconnect-due`, `first-sync` (one account mid first window), `first-sync-multi`, `first-sync-small` (12 threads), `setup-paused-early` (paused before any batch), `setup-failed`, `oauth-pending`, `empty-skipped`. Knobs: `advanceSetup {accountId, phase, read?, sorted?}`, `setFound {accountId, estimate|null}`, `pauseAccount {accountId, until, class}`, `failSetup {accountId, phase, reasonCode}`, `failAi {reasonCode}`, `capAi {sorted, total}`, `resolveConnect {connectId, outcome, delayMs}`, `setReconnectBy {accountId, at}`, `queueLocalOps {accountId, n}`, `requestLog` (to assert zero resync calls).
- To: `eng-contract`. Severity: blocks-freeze for knob signatures (F6 freezes `Fixture/control` signatures, RM line 129); scenarios additive in Phase 1.

**GAP-16. F9 components and props this lane needs.**
- Needs: `ProgressSegments` in five shapes (4 or 3 segments; part %; indeterminate; paused; failed; compact one-line; status-slot "Importing N of M"; drawn ready check), radio rows, select trigger, step dashes, the onboarding frame (48 px no-drag strip, 64 px margins, footer).
- Why uncovered: D §6 lists `ProgressSegments` and `ReconnectSheet` without props and has no `Radio`, `Select`, `StepDashes`; "screens never style their own controls".
- Proposal: `ProgressSegments {segments: Array<{state:'done'|'current'|'paused'|'failed'|'pending', fraction?:number, indeterminate?:boolean}>, label, valueText, variant:'full'|'compact'|'slot'}`; `Radio {checked, label}`; `Select {value, options, onChange}` over `Menu`; `StepDashes {count, current}`; `OnboardingFrame {strip, footer}` (owned by `ui-onboard` if UI-core prefers).
- To: `ui-foundation`. Severity: blocks-freeze (F9 freezes props).

**GAP-17. `CommandRegistry` contexts for onboarding, first sync, drill and the sheet.**
- Needs: Return continues, Esc backs a step and is Skip setup on Welcome; first-sync owns Esc in every state [F8]; the drill takes single letters; global commands inert in the onboarding window; the sheet's Esc cancels.
- Why uncovered: P30 §4.2 context stack is global, list, home, reader, compose, ask, calendar, palette.
- Proposal: contexts `onboarding`, `firstSync`, `drill`, `sheet`; a per-window registry filter (`window:'onboarding'` exposes only these).
- To: `ui-foundation`. Severity: blocks-freeze if contexts are a closed union in F9, else additive-later.

## Unclear

1. **`pausedUntil` vs `resumeAt` vs `resume_at`.** P10 §4.1 `Setup/status.pausedUntil`; P20 §551 and P30 §8.2 `resumeAt`; A §3.2 `resume_at`. Recommend one name, `resumeAt`, on both `Account.status` and `Setup/status`.
2. **Is a capped AI pass a clean finish?** P30 U8 auto-enters when step 4 is "done, capped or omitted"; D §7.12 says "any pause, failure or partial pass waits for you", and the partial mockup says "Aplos waits for you." D wins: capped waits.
3. **Paused copy.** D §7.12: "Google is asking us to go slowly. Your newest mail is ready now; older mail will follow." P30 U8 and the mockup: "Google asked us to slow down. Resuming at 2:14 PM. Your newest mail will appear first." Recommend the mockup's line (it matches the §7.1 slot copy) and fixing D §7.12 at the day-9 review; until then D wins for tests.
4. **"Continue anyway".** In P30 U8 and the mockup, not in D §7.12. Recommend keeping it (it gives a pointer path to Esc's behaviour, §11 item 4) and adding it to D.
5. **Reconnect success.** D §7.1: the sheet closes with a "Reconnected" toast. P30 U8: "Reconnected. Your mail is up to date." D wins (toast).
6. **`needsPermission` → which method?** See GAP-14. Recommend the engine decides; the sheet always calls `Account/reconnect`.
7. **Who calls `Setup/end` on close?** D §7.11 says "the UI must call `Setup/end` on every close"; a red-button close may not run renderer code. P10 E3 item 6 gives main its own engine connection. Recommend main calls `Setup/end {setupId, reason:'closed'}` in the onboarding window's `closed` handler, and the renderer also calls it on every handoff; idempotence makes double calls safe.
8. **Consent scope.** The card says the question "when you use Ask" is sent. Recommend one `background` scope for jobs; Ask is consented by asking, and the card's Ask clause stays as disclosure.
9. **What the AI step writes.** Recommend: the chosen provider and its `defaultModels` for Ask, Summaries, Drafts, Plans; Voice set to Groq if a Groq key exists, else OpenAI if present, else unset. "Skip for now" writes nothing.
10. **Auto-enter timing and the drill.** The mockup waits 3.2 s on "Your mail is ready". Recommend no auto-enter while the drill is open (the clean finish shows as "Your mail is ready" in the compact progress, and Esc or "Back to progress" continues), and pin the delay in DESIGN.
11. **Demo controls and copy.** P30 §4.5 row 8: Settings → Help "Load demo mail" / "Reset demo mail", empty copy "No mail yet."; D §7.10: the demo account has Reset and Remove in Accounts; D §7.14 and the mockup: "Add an account to bring in your mail."; mockup puts Load/Reset/Remove in Accounts. D wins: Accounts, D §7.14 copy. Demo plus a real account: recommend the slot shows the real account's status and no demo line.
12. **Settings "Add account" and the switcher's "Add an account".** D §7.12 says the first-sync screen also serves "Add account" from Settings; P30 U8 says "inline … never gates anything". Recommend: Settings and the switcher open the onboarding window at the Accounts step (GAP-8), which already owns OAuth wait, Cancel and first sync; the Settings row then shows `ProgressSegments` inline from `Setup/status` with no gate.
13. **Notification permission on macOS.** Electron exposes no documented authorization request. Recommend `eng-host` spikes it; fallback copy "Aplos asks the first time it has something to tell you." with no button.
14. **`openExternal` host event.** Listed in P10 E3 item 6, missing from P10 §4.1's host-channel list (`notify`, `badge`, `appearance`, `reminder`). Recommend adding it to §4.1 with `{url, purpose}`, URL limited to `https://accounts.google.com/` for `oauth`.
15. **Handoff fade.** Recommend main shows the mail window on `ready-to-show`, then sends a host event `windowHandoff` to the onboarding renderer, which runs a 120 ms opacity fade and closes itself; main force-closes after 300 ms.
16. **Status slot during the first window.** shell.js `firstmail` ("Reading your newest mail / 24 of 50") has no row in the D §7.1 table and no status value (A §6.4). Recommend the slot reads `Setup/status` while any account has `firstWindowDone:false`, with copy added to the D §7.1 table.
17. **Two accounts needing reconnect.** Recommend the slot shows the earliest `reconnectBy` or any `needsReauth` first, names the address only when two or more accounts exist, and the sheet title names the address ("Reconnect alex.moreno@gmail.com").
18. **Drill rows.** Recommend `ListRow` and `FocusLetter` accept a plain row object (not only an id resolved by `useRow`), so the drill uses no engine data.
19. **Show welcome with accounts present.** Recommend it opens on Welcome, calls `Setup/begin`, and the Accounts step lists existing accounts under "Your accounts" read-only.
20. **Account dot with one account.** The connected state draws a dot with one account; D decision 16 hides dots on rows with one account. Recommend no dot in onboarding with one account.
21. **Where the selected account lives.** Legacy kept `selectedAccountId` in engine state (F7). Recommend renderer state persisted in `Settings.ui.lastAccount`, written only by the switcher, and the handoff forcing `all`.
22. **Waiting-screen scope sentence.** "read and send your mail and calendar" omits filters (`gmail.settings.basic`). Recommend generating it from the P20 PV5 scope manifest.
23. **`system.login` read-back.** Recommend GAP-9's `system.login.get`.
24. **"Retry now" while paused.** P20 PV3 item 3: `Sync/request` refuses manual runs during a pause, but the slot offers "Retry now". Recommend `Sync/request {accountId, force:true}` allowed once per pause for throttle only. This belongs to `ui-shell`'s map; it's listed here because the quota state is in scope.

## DESIGN vs mockup

| # | Mockup | DESIGN / roadmap | Winner | Behaviour change |
|---|---|---|---|---|
| 1 | Accounts: Microsoft, iCloud, Other (IMAP) rows and the `icloud` state | D §7.11 step 2 + RM: Google only in round 1 | DESIGN | Yes: Google row only; the iCloud state is not built in round 1 |
| 2 | Sync failed state: `alex@fernworks.studio` "Fastmail refused the app password…" | Round 2 | DESIGN | Fixtures use two Google accounts |
| 3 | `empty.html`, `demo.html`, `errors.html` show an `h1.page-title` "Home" and a page-sub ("No accounts yet", "Thursday, October 29 · 9 to handle") | D §7: "There are no page titles" | DESIGN | Yes: no title or sub-line |
| 4 | Paused lede (see UNCLEAR-3) | D §7.12 sample | DESIGN for now | Copy only |
| 5 | Slot "Google asked Aplos to slow down" / "Offline. 2 changes waiting." | D §7.1 "asked us" / "Offline · 2 changes waiting" | DESIGN | Copy only |
| 6 | Slot `firstmail` line | Not in D §7.1 table | DESIGN silent → UNCLEAR-16 | Adds a slot state |
| 7 | Settings demo "Remove" toast with Undo Z | No inverse op for `Demo/remove` (P10 E5 item 7); D §7.13 forbids silent replacement but is silent here | DESIGN (no undo promised) | Drop Undo; use a two-row confirm defaulting to Cancel (D §6 `Confirm`) |
| 8 | Reconnect also in the account switcher menu | D §7.1 lists three entry points | Both (NOTES.md item 8 kept it) | Extra entry, same sheet |
| 9 | "Continue anyway" on the sync screen | Not in D §7.12 | UNCLEAR-4 | — |
| 10 | Ready: "Aplos opens by itself in a moment." + "Open now" after 3.2 s | D §7.12 silent on delay | DESIGN silent → UNCLEAR-10 | — |
| 11 | byok "Custom server": one field "Paste the server address and key" | AGENTS.md: address in Settings, optional `CUSTOM_AI_API_KEY` | DESIGN/AGENTS | Two fields: address, optional key |
| 12 | `settings-accounts.html` hint "Google, iCloud, Fastmail or any IMAP mailbox." | Round 1 Google only | Roadmap | Copy "Google accounts." (ui-settings) |
| 13 | Plan 30 §4.5 row 8 "No mail yet." | D §7.14 + mockup "Add an account to bring in your mail." | DESIGN | — |
| 14 | No AI-failure line, no "Not connected · Try again", no indeterminate Find bar, no denied permissions, no reconnect sheet drawn | D §7.12, §7.11, §7.1 require them | DESIGN | Built from D copy; owner reads at day-9 review |
| 15 | Connected list shows the account dot with one account | D decision 16 | DESIGN | No dot with one account (UNCLEAR-20) |

## Harness scenarios and test list

**Scenarios used.** Existing (P10 §4.1): `empty`, `demo`, `needs-reauth`, `rate-limited`, `backfilling`, `offline`, `ai-off`, `ai-budget-spent`, `setup-partial`. New (GAP-15): `reconnect-due`, `first-sync`, `first-sync-multi`, `first-sync-small`, `setup-paused-early`, `setup-failed`, `oauth-pending`, `empty-skipped`, `ai-env-groq-local-ollama`.

**`Fixture/control` knobs.** `advanceSetup`, `setFound`, `pauseAccount`, `failSetup`, `failAi`, `capAi`, `resolveConnect`, `setReconnectBy`, `queueLocalOps`, `requestLog`, `setClock` (`APLOS_NOW` = 2026-10-29T10:00).

**Behaviour / DOM**
- `onb-fresh-install-zero-accounts` – fresh `APLOS_DATA_DIR`: contract log has no `Demo/load`, `Session/get.hasAccounts` false, onboarding window only.
- `onb-demo-isolation` – "Try demo mail" calls `Demo/load` once, handoff skips first sync, mail window shows the demo toast and "Demo mail" in the switcher.
- `onb-skip-setup-no-loop` – Esc on Welcome → zero-accounts mail window; relaunch opens the mail window, not onboarding (GAP-7).
- `onb-round1-google-only` – Accounts step renders exactly one provider row, "Google".
- `onb-discover-focus-F12` – type address, Return → focus on "Continue with Google"; Return starts connect.
- `onb-discover-unsupported` – `@icloud.com` in round 1 shows the unsupported line, no connect call.
- `onb-oauth-cancel` – waiting, Esc → `Account/cancelConnect` called, back to choose; late `connected` frame adds the row without navigating.
- `onb-late-resolve-F9` – connect pending, owner moves to AI step; `resolveConnect` → step unchanged, focus unchanged, list updated.
- `onb-close-matrix-F1-F2` – close at each step × connect {idle, pending, connected, syncing, synced} → `Setup/end` recorded once or more, later mail classified with mock AI.
- `onb-showwelcome-reopen-F1` – mail window open, Show welcome → connect → close → `Setup/end` called, new mail classified.
- `onb-ai-env-key` – Groq row shows "Key found in the environment as GROQ_API_KEY"; DOM, attributes and screenshots contain no canary key.
- `onb-ai-test-latency` – Test → "Works · 0.4 s" from `latencyMs`.
- `onb-consent-record` – Allow → `Consent/grant` with provider, model and version shown on the card.
- `onb-skip-ai-no-errors` – Skip for now → first sync has 3 segments, no error anywhere.
- `sync-found-estimate` – with estimate "Found about 214 recent emails"; without, "Found recent mail" and indeterminate bar.
- `sync-small-mailbox` – 12 threads: reaches ready, never shows "of 50".
- `sync-never-backwards` – property test over random frames: no counter decreases within a `runId`, no "Done" before true, none for capped.
- `sync-paused-before-window` – Esc enters; Home shows "Your first mail is on its way.", never inbox-zero.
- `sync-paused-after-window` – Open Aplos enabled, no mailbox total shown, slot carries the pause after entering.
- `sync-no-autoenter-unless-clean` – no handoff while paused, failed, partial or capped (UNCLEAR-2).
- `sync-autoenter-clean` – clean finish → drawn check → handoff on `ready-to-show`.
- `sync-retry-idempotent-F5` – Try again twice → one `runId`, no collision error.
- `sync-ai-failure-copy` – `failAi aiKeyRefused` → "Couldn't sort with Groq: the key was refused. Mail is ready; sorting will retry." + Open Settings.
- `sync-not-connected-row` – skipped account shows "Not connected · Try again".
- `sync-multi-open-early` – one of two accounts ready → Open Aplos enabled.
- `handoff-all-accounts-F7` – two accounts connected → mail window on All accounts.
- `drill-no-engine-calls` – drill steps produce zero contract calls.
- `empty-no-accounts` – zero accounts: one `EmptyLine`, Add an account opens onboarding at Accounts.
- `reconnect-due-line` – `reconnect-due`: slot "Gmail will ask you to reconnect tomorrow at 9:00 AM." + Reconnect now.
- `reconnect-sheet-flow` – every entry point (slot, Settings row, switcher row) opens the same sheet; `Account/reconnect` called with the account id; waiting → `connected` → toast "Reconnected", focus restored.
- `reconnect-no-resync` – `queueLocalOps 10` then reconnect → `requestLog` has zero full-sync requests and the 10 ops flushed.
- `reconnect-wrong-account` – `resolveConnect wrongAccount` → plain sentence, status unchanged.

**Keyboard paths**
- `keys-onb-return-each-step` – Return activates each step's main action; focus lands on it after every internal state change.
- `keys-onb-esc-ladder` – Esc: accounts waiting → cancel; choose → Welcome; Welcome → Skip setup; AI byok → groq; menu open → close menu first.
- `keys-sync-esc-every-state-F8` – Esc opens Aplos in progress, paused, ready, partial, failed and inside the drill.
- `keys-drill-letters` – J/K, Space, E, A advance the drill; ⌘-chords and global commands do nothing.
- `keys-onb-globals-inert` – ⌘K, ⌃1, C, A do nothing in the onboarding window.
- `keys-sheet-esc-cancels` – Esc in the reconnect sheet calls `Account/cancelConnect` and restores focus.
- `keys-tab-order-visual` – Tab order equals visual order on every step.

**Visual states (light and dark, 640 × 600 and 640 × 520)**
- Welcome; accounts choose, typed, waiting, connected, unsupported; AI groq, groq-no-key, byok, local, consent, consent-gemini-free; permissions default, granted, denied.
- Sync progress (1 and 2 accounts), found-no-estimate, paused, paused-daily, ready, partial, ai-failed, failed, not-connected, no-ai (3 segments), 5 accounts (scrolls, top not clipped [F13]).
- Drill step1, step3, done.
- Mail window: no-accounts, first-mail, demo; slot reconnect-due, needs-reauth, needs-permission, quota.
- Reconnect sheet waiting, failed (wrong account), reconnected toast.

**Accessibility**
- `a11y-one-live-region-F11` – exactly one `role="status"` on the sync screen; it changes only on phase changes (≤ 5 announcements for a full run).
- `a11y-bars-labelled` – every progress bar has `aria-label "<address> sync"` and `aria-valuetext`.
- `a11y-axe-all-onb-states` – axe, no serious violations, both themes.
- `a11y-reduced-motion` – ready check static; drill E removal is opacity only; marker spinner stops.
- `a11y-strip-target-size` – "Try demo mail" hit area ≥ 24 px, outside the drag region.

**Design checks**
- `design-banned-strings-onb` – no "Done" on capped or failed passes, no "Testing mode", "verification", "magic", "AI-powered", "Hold to talk", "Ask me anything", no "Aplos needs a moment.", no raw provider error text.
- `design-banned-glyphs-onb` – no sparkle, wand, star, brain or robot icon on the AI step or consent card.
- `design-one-filled-button` – exactly one filled button per step and per sync state (Open Aplos disabled still counts as the one).
- `design-hover-never-shifts-onb` – hover every interactive element on every onboarding state; no other box moves > 0.5 px.
- `design-contrast-onb` – `--stamp-ink` failure icons, `--dusk` paused segment, `--ink-2` done segment, dim text on paper pass 4.5:1 / 3:1 in both themes.
- `design-no-icon-no-sky` – no app icon, gradient, `backdrop-filter` or page title in the onboarding window or the empties.
- `design-window-chrome` (hidden `_electron`) – 640 × 600, min 640 × 520, vertical resize, hidden-inset title bar, one window after a second launch [F3], no mail window before `ready-to-show` [F4].
