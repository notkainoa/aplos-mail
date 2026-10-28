# UI-screens Phase 0 map: Settings (`ui-settings`)

Lane `ui-settings`, `renderer/screens/settings/**`. Written 2026-10-27 (day 1) against the planned contract, before the F1/F9 freeze. "Planned home" cites plan text only; nothing in `packages/contract` exists yet.

## Scope

Pages: `mockups/settings-appearance.html` (General; state `default`), `settings-accounts.html` (`default`, `reconnect`), `settings-ai.html` (`default`, `testing`), `settings-keyboard.html` (`default`, `recording`), shared `settings.js` / `settings.css`. Undrawn surfaces mapped from DESIGN §7.10, plan 30 U7 and §4.5 rows 2-3 and 8-9: Mail, Calendar, Notifications, Help & about, "Allow tools on this Mac" with connected tools, diagnostics export, the queue inspector, retention, the primary-device lease, consent re-review, the daily AI cap and `trainsOnInputs`. DESIGN sections: §7.10, §7.1 (status table, reconnect sheet), §7.15, §8, §9 rules 4, 5 and 7, §10, §11.4, plus §5, §6 and §11 generally. Plans: plan 30 §4.1, §4.2, §4.5, U7 (acceptance 2, 3, 8), §8.1 items 6, 8, 9, 11 and 13; plan 10 §4.1, E1.4, E3.6, E5.2-3 and 7, E6.2 and 6, E7.3-4 and 8; ARCH §2.2, §3.6, §6.4-6.5, §8.3-8.4, §9.1, §11, §12.2-12.3; plan 20 PV2, PV5; roadmap §1.2, §8.3; AGENTS.md. Legacy `Settings.tsx`, `AiSettings.tsx`, `ApiKey.tsx`, `DeviceSync.tsx` and `main/ai-keys.ts` were read only to learn what today's calls do (`ai.models`, `ai.key.test`, `ai.test`, `ai.cancel`, a saved key beating the env key, `last4` leaking). Nothing from them is copied.

## Element map

### Common: Settings frame, nav, rows (all four pages)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Route `settings/<section>`; ⌘, opens it; Esc goes back (mockup `data-esc="home.html"`) | §8 Global (⌘, settings; Esc ladder) | registry command `settings.open {section?}`; shell route | plan 30 §4.2 registry; U5 shell | COVERED |
| Nav: General, Mail, Calendar, AI, Notifications, Accounts, Keyboard, Help & about, with `slide` puck | §7.10 Sections; §6 `Puck` | `Puck` component; nav `aria-current` | DESIGN §6; F9 component list | COVERED |
| No page title or subtitle; nav aligned with the first group (mockup draws `page-title` + `page-sub`) | §7, §7.10 Layout | none (drop `S.page`) | DESIGN §7 | COVERED (see DESIGN vs mockup 1) |
| Group label (section-label rule), groups 32 px apart | §7.10; DESIGN-CHANGES §5.16 | `SectionHeader` variant without a count | DESIGN §6 `SectionHeader` | COVERED |
| `SettingRow` 40 px, or 48 px with a one-line `small --dim` hint; fixed control column (`--ctl-w` 208) | §7.10 Rows; NOTES 10 | `SettingRow` props `{id, label, hint?, control, section, keywords?}` | DESIGN §6 `SettingRow`; F9 frozen props | COVERED |
| Disclosure row (the long text opens beneath) | §7.10 "Longer text goes behind a disclosure" | `SettingRow` disclosure variant, `aria-expanded` | F9 | COVERED |
| Switch, segmented control, select (button + listbox `Menu`), text field | §6 `Switch`, `Puck`, `Menu`, `TextField` | F9 components | DESIGN §6 | COVERED |
| Every row findable from ⌘K ("Settings reach") | §7.10; plan 30 U7 acc. 2 | static settings index registered at boot (not on mount), breadcrumb "Settings › Mail", deep link that scrolls to and focuses the row | plan 30 §4.2 registry (dynamic entries not specified) | GAP-15 |
| Read and write every value | §7.10 | `Settings/get`, `Settings/set` (patch), validation errors as `{type, message}` | plan 10 §4.1 `Settings/*`; ARCH §9.1 envelope | COVERED |
| A value changed in another window (pop-out) or by a tool client shows up live | §5 rule 1 (no stale state) | `Settings` listed in the `state` frame's type map, or a `settings` frame | ARCH §9.2 `state` frame (types not listed) | UNCLEAR-14 |
| Write rejected → row returns to the old value with an inline `ErrorLine` + Retry | §5 rule 11; §7.15 "Write rejected" | `Settings/set` error → `ErrorLine` | plan 30 §4.1 `optimistic.ts` | COVERED |
| Unbuilt features show "Not available yet" | plan 30 U7 Depends on | `Session/get.capabilities` with named flags | plan 10 §4.1 / table row 9 (flags not named) | GAP-14 |
| Pane header: Ask (A) on the right | §7.1 Pane header | none | U5 shell | COVERED |

### General (`settings-appearance.html`, state `default`)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Theme: Light / Dark / System; hint "Light, dark, or match the system." | §7.10 Copy; §10 | `Settings.ui.theme: 'light'\|'dark'\|'system'`; main applies it through host frame `appearance {theme}` | plan 10 E3.6 `appearance`; plan 30 §8.1 item 8 lists ui fields without `theme` | GAP-9 |
| Density: Roomy / Comfortable / Compact (mockup says "Normal") | §4.4 Density table | `Settings.ui.density: 'roomy'\|'comfortable'\|'compact'` | plan 30 §8.1 item 8 "density" | COVERED |
| Show all key hints (switch; also on Keyboard) | §8 Discoverability; §5 rule 17 | `Settings.ui.keyHints: boolean`; one palette entry for both rows | plan 30 §8.1 item 8 "key hints" | COVERED |
| Swipe direction: "Right is Done" / "Left is Done" | §8 "sides follow the swipe-direction setting" | `Settings.ui.swipeDirection: 'rightDone'\|'leftDone'` | not in the plan 30 §8.1 item 8 list | GAP-9 |
| Minimised sidebar ("Hide the sidebar until you press [.") | §7.1 Minimised mode | `Settings.ui.sidebarMinimised: boolean` | not listed | GAP-9 |
| "Open Aplos when you log in." (switch) | §10 copy table; plan 30 §4.5 row 2 | read the real OS state (the user can remove the item in System Settings) and set it; capability off in browser preview and under `APLOS_TEST` | plan 10 E1.4 native `system.login` (set only; no read named) | GAP-11 |
| "Keep Aplos in the menu bar when the window closes" (switch) | plan 30 §4.5 row 2; ARCH §2.2, Decision 5 | `Settings.host.keepInMenuBar: boolean`, applied by `eng-host` | plan 10 §4.1 table row 8 "resident-mode toggles" (field unnamed) | COVERED (name it at freeze) |
| Developer details switch (model names, scores, schema) | §9 rule 4 "behind a developer toggle" | `Settings.ui.developerDetails: boolean` | none | GAP-9 |

### Accounts (`settings-accounts.html`, states `default`, `reconnect`)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Account list (live) | §7.10 Accounts | the accounts singleton, live | plan 30 §4.1 singletons "accounts" | COVERED |
| Row: colour mark + the one name + provider label | §7.10 "One name per account everywhere"; §4.2 | `account.name` (one name; the mockup uses the address), `account.address`, `account.provider: 'google'`, `account.colour: 'sky'\|'hill'\|'stamp'\|'dusk'\|'sand'\|'ember'` | `Account` type, ARCH §9.1 (fields not listed) | GAP-6 |
| Hint `default`: "Connected · synced 2 min ago" | §7.1 `ok` ("Synced 2 min ago") | `account.status.state='ok'`, `account.lastSyncedAt` | plan 30 §8.2 status `{state, reason, resumeAt, reconnectBy}` (no `lastSyncedAt`) | GAP-6 |
| Hint for other states: `syncing`, `backfilling (n of m)`, `paused (until, reason)`, `needsAdmin`, `misconfigured`, `offline`, `error`, the same copy as the status slot | §7.1 status table; §7.15 | `status.state`, `status.reason`, `status.resumeAt`, backfill `n`/`m`; shared copy catalog | ARCH §6.4; plan 20 Plan 30 handoff; plan 10 §7.2 "one catalog file" | COVERED |
| State `reconnect` (`needsReauth`): `alert` icon + "Google needs you to sign in again." + Reconnect | §7.10; §7.15 "Sign-in expired" | `status.state='needsReauth'` | ARCH §6.4; plan 20 PV5 | COVERED |
| `needsPermission`: "Aplos needs permission to read your Gmail." + Reconnect (a full re-consent) | §7.15 "Permission missing"; plan 20 PV5 granted scopes | `status.state='needsPermission'` and which feature is missing (`account.missingScopes` / features: mail, calendar, filters) to choose the copy; `Account/grantPermissions` | plan 20 PV5 "granted-scope facts" (not in the account row) | GAP-6 |
| Reconnect due: `reconnectBy` within 24 h → "Gmail will ask you to reconnect tomorrow at 9:00 AM." + "Reconnect now" | §7.10; §7.15 "Reconnect due"; plan 30 U7 acc. 8 | `account.status.reconnectBy` (ISO); a "now" that follows the fixture clock | plan 30 §8.1 item 13; plan 10 §4.1; ARCH §6.4 | COVERED (field); GAP-8 (clock) |
| Reconnect / Reconnect now opens `ui-onboard`'s `ReconnectSheet` (`login_hint`, "Waiting for Google in your browser…", Cancel, "Reconnected" toast, no resync) | §7.1 reconnect sheet | `Account/reconnect {accountId}` (and `Account/grantPermissions` for `needsPermission`); a way for `ui-settings` to open a sheet owned by `ui-onboard` | plan 20 PV5 item 3; DESIGN §6 `ReconnectSheet` (built by `ui-onboard`) | GAP-16 |
| Remove (real account): a destructive confirm that defaults to Cancel | §6 `Confirm`; §7.9 | `Account/remove {accountId}` (E5: "disconnect deletes the account's queued jobs") | plan 10 §4.1 "the rest of `Account/*`" (name not given) | GAP-6 |
| "Add an account" row → `ui-onboard`'s account component inline; round 1: Google only | §7.11 step 2; roadmap round 1 | `Account/connect`; the shared component | plan 30 U8 "Add account from Settings uses the same component inline" | COVERED |
| Per-account group: "Use this account's mail for AI" (mockup: "Use this mail for AI"; "Off means nothing from it is sent to a provider.") | ARCH §8.3; plan 30 §4.5 row 2 | `account.aiAllowed: boolean` + a setter | plan 10 §4.1 table row 6 "per-account `aiAllowed`" (setter unnamed) | GAP-6 |
| Per-account colour swatches (6, radio group); the change shows at once in the mark | §4.2 "manual override in Settings" | `Account/set {accountId, colour}` | none named | GAP-6 |
| "Background work runs on: MacBook Pro" + "Use this Mac" | plan 30 §4.5 row 2; ARCH §6.5 | `Account/lease` read `{holder: {deviceId, deviceName, isThisDevice}, until}` and take | plan 10 §4.1 `Account/lease`; ARCH §6.5 lease `{deviceId, until}` (no device name) | GAP-7 |
| Demo account row: Reset and Remove | §7.10 "The demo account has Reset and Remove"; §7.1 demo status "Demo mail. Remove it in Settings." | `account.isDemo: boolean`; `Demo/reset`, `Demo/remove` | plan 10 §4.1 `Demo/*`; E5.7 (no demo flag on the account) | GAP-6 |
| Mockup "Demo mail" group: Load / Reset / Remove with an Undo toast on Remove | plan 30 §4.5 row 8 | `Demo/load\|reset\|remove`; Undo for Remove has no engine inverse | plan 10 E5.7 | UNCLEAR-7 |
| Filled Reconnect when two accounts need it (one filled button per screen) | §3 principle 6 | UI rule | DESIGN §3 | UNCLEAR-13 |

### AI (`settings-ai.html`, states `default`, `testing`)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Features table first: Ask, Summaries, Drafts, Plans, Voice, each with a one-line hint, a provider select and a model select | §7.10 AI; AGENTS.md | `Settings.ai.features.{ask,summaries,drafts,plans,voice}.{provider, model}` | roadmap §1.2 F1 "per-feature AI provider and model"; plan 50 `eng-ai` | COVERED |
| Provider select lists usable providers; Voice lists only Groq and OpenAI | §7.10; AGENTS.md | per-provider `capabilities.speechToText`, `capabilities.chat`, readiness | "AI provider table with `trainsOnInputs`" (plan 30 U7 Depends on; no shape or method) | GAP-1 |
| Model select; changing the provider resets the model to that provider's first model; OpenRouter's catalogue is large; local and custom servers list what they have | §7.10 | `Ai/models {provider, query?}` → `{models: [{id, label, speech?, tools?}], discovered}`; a typed model name for custom servers | none (today's `ai.models`) | GAP-2 |
| Hosted providers: Groq ("Default" tag), OpenAI, Claude, Gemini, OpenRouter, OpenCode Go | §7.10 | provider rows `{id, name, group: 'hosted', isDefault}` | AGENTS.md list; GAP-1 shape | GAP-1 |
| Key source: "From environment: GROQ_API_KEY" / "Saved in Keychain" / "Not set · reads ANTHROPIC_API_KEY"; no key characters ever (today's `last4` must not survive) | §7.10 "Key characters are never shown"; plan 30 U7 acc. 3 | `provider.keySource: 'environment'\|'keychain'\|'none'\|'notNeeded'`, `provider.envVar`; no `last4` field in the schema | ARCH §12.2 (where keys live, not how they are reported) | GAP-1 |
| Status column: Ready / Needs a key (dot + word) | §11.1 colour plus a word | `provider.status` enum | none | GAP-1 |
| `testing`: "Testing…" (busy, Test disabled) → "Works · 0.4 s" or "Key refused"; cancel when leaving the page | §7.10 "Each has Test"; §5 rule 12 | `Ai/test {provider, model?}` → `{ok, ms, reasonCode}` with abort | none (today's `ai.key.test`, `ai.test`, `ai.cancel`) | GAP-4 |
| Refused key `ErrorLine`: "OpenRouter refused the saved key, so nothing was sent. Copy a fresh one from openrouter.ai/keys. Your other providers are not affected." + "Replace key" | §7.15 pattern; §10 | `reasonCode='keyRefused'`, `provider.keyHelpUrl` | none | GAP-1, GAP-4 |
| Add key → field (paste, Return saves, then Test runs); the renderer drops the value at once and never sees it again | §7.10 "Providers with no key show Add key" | write-only `Ai/setKey {provider, key}` → `{keySource}`; the argument tagged secret (redacted by the logger, never echoed, UI-only, not exposed to listener clients); a `secureKeys` capability (off in browser preview) | ARCH §12.2 (vault); nothing names a write path | GAP-3 |
| Remove (saved key): a confirm naming the features that will stop | §7.10; §6 `Confirm` | `Ai/removeKey {provider}`; feature ↔ provider map from Settings | none | GAP-3 |
| Remove disabled with tooltip "This key comes from GROQ_API_KEY in your environment. Remove it there." | §7.10; NOTES 10 | `keySource='environment'` (and whether a saved key also exists) | none | GAP-1; UNCLEAR-2 |
| "On this Mac and custom": Ollama (`http://localhost:11434`), LM Studio (`http://localhost:1234`), Custom server (placeholder `https://your-server.example/v1`), each with an editable address | §7.10; AGENTS.md | `Settings.ai.servers.{ollama,lmstudio,custom}.address` (empty = default); `provider.defaultAddress`; engine validates | AGENTS.md "address changeable in Settings" (no field in F1 list) | GAP-5 |
| Local rows: "running · no key needed" / "not running"; optional `OLLAMA_API_KEY`, `LM_STUDIO_API_KEY`, `CUSTOM_AI_API_KEY` | §7.10 (status and Test on every provider) | `provider.status` `running\|notRunning\|needsAddress`, `keyOptional: true`, keySource | none | GAP-1 |
| "How your mail is used" disclosure (the one privacy text) | §7.10; §10 | static copy | DESIGN §7.10 | COVERED |
| Consent re-review: `ErrorLine` "Background summaries are paused until you agree to the new provider." + filled "Review" (opens `ui-onboard`'s consent card) | plan 30 §4.5 row 1; ARCH §8.3 | `Consent/get` → `{scope, version, provider, model, grantedAt?, needsReview, reason}`, `Consent/grant`, `Consent/revoke` | plan 10 §4.1 table row 6 `Consent/*` (no shape) | GAP-12 |
| "Summarise in the background" switch ("Reads new mail as it arrives and sends it to Groq.") | not in DESIGN; ARCH Decision 13 "off until you ask" | consent revoke/grant, or `Settings.ai.background` | none | UNCLEAR-6 |
| Daily background cap (mockup "500 requests"; ARCH: 150,000 tokens) | ARCH §8.4, Decision 13; plan 30 §4.5 row 2 | `Settings.ai.dailyCapTokens: number\|null` | plan 10 §4.1 table row 6 "daily cap in Settings" (unit unnamed) | GAP-5; UNCLEAR-5 |
| "Paused for today. Resumes tomorrow." (Settings only) | plan 30 §4.5 row 2 | `Ai/usage` → `{backgroundTokensToday, cap, pausedUntil?, pauseReason}` | plan 10 E5.2 `ai_usage` table (no read method) | GAP-13 |
| A model's daily 429: "stops that model's queue until reset with a visible reason" | plan 10 E5.2; ARCH §8.4 | per-model `{provider, model, pausedUntil, reason}` | none | GAP-13 |
| Free-tier Gemini: a reason line and "This key is on a paid plan" switch; free Gemini cannot be picked for mail features | plan 10 E5.3 (Decision 8); ARCH §8.3 | `provider.trainsOnInputs`, `Settings.ai.providers.gemini.paidKey` | plan 30 U7 Depends on "`trainsOnInputs`" (field only) | GAP-1, GAP-5; UNCLEAR-4 |
| No provider: one line in Settings → AI, nothing on the mail surface | §9 rule 7; §7.15 "Summary failed / no provider" | computed from provider statuses + feature settings; copy not written | DESIGN §9 | COVERED (needs copy; GAP-1 data) |
| Feature whose provider lost its key or is refused: line under the feature row | §7.15 pattern | same | GAP-1 | GAP-1 |
| Microphone permission for Voice (denied → "Open System Settings") | §7.11 step 4; §11.4 typed equivalent | native permission status + open the pane | plan 40 §Q2 item 5 (permission handler only) | GAP-11 |
| Deep link from Ask's "Use another provider" (§7.15) to Settings → AI → Ask | §7.15 "Ask failed" | settings deep link | GAP-15 | GAP-15 |

### Keyboard (`settings-keyboard.html`, states `default`, `recording`)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| List generated from the registry, grouped by context (Lists and Home, Reader, Compose, Ask, Calendar, Places, Everywhere) | §7.10 Keyboard; §8 | `CommandRegistry` `{id, label, keys per context, contexts, group}` | plan 30 §4.2 | COVERED |
| Single-key shortcuts switch (WCAG 2.1.4); mockup hint "Off means they need ⌘." | §11.4; §8 | `Settings.ui.singleKeyShortcuts: boolean`; resolver reads it | plan 30 §4.2 "globally switchable" (no field) | GAP-9; UNCLEAR-1 |
| Show all key hints (same setting as General) | §8 | `ui.keyHints` | plan 30 §8.1 item 8 | COVERED |
| Hold threshold, default 250 ms (not drawn) | plan 30 §4.2 tap versus hold | `Settings.ui.holdThresholdMs` | plan 30 §8.1 item 8 "hold threshold" | COVERED |
| Keys button per row (tooltip "Click to change", label "Change the shortcut for Done. Now E") | §6 `Kbd`, `KeyRecorder` | `Kbd`, `Tooltip` | F9 | COVERED |
| `recording`: "Press the new keys · Esc to cancel", waiting keycap, Cancel; every key swallowed; modifier-only presses ignored; IME-safe | §5 rule 16; §6 `KeyRecorder` | `KeyRecorder` props; shared `chordFromEvent` / `formatChord`; a list of reserved chords (⌘Q, ⌘W, ⌘H, ⌘M, ⌘Tab, ⌘Space, Esc) | DESIGN §6 lists `KeyRecorder`; F9 freezes props (no chord utilities named) | GAP-17 |
| Conflict while recording: "Already used by Later" + Replace / Cancel | §7.10 conflict marks | a context-overlap rule (global overlaps all; lists and reader overlap) the resolver also uses | plan 30 §4.2 "a binding exists once per context" (no overlap API) | GAP-17 |
| Saved conflict mark: "Same keys as Toggle the Ask dock" | §7.10 | same | same | GAP-17 |
| Per-row Reset (only when changed) and "Reset all" (toast "Every shortcut is back to its default") | §7.10 remapping | `Settings.ui.keymap` stored as overrides only `{[commandId]: {[context]: string[]}}`, so new defaults still arrive | plan 30 §4.2 "bindings stored in the engine's settings object" (shape unnamed) | GAP-9 |
| Commit toast "Done is now L · Undo Z" | §7.13; §8 Z undo | an undo entry for a settings change (a local inverse, not `Operation/undo`) | plan 30 §4.1 `optimistic.ts`: undo = `Operation/undo` only | GAP-18 |
| Single-key off toast "Single-key shortcuts are off. Letters now need ⌘." | §7.13 | copy depends on UNCLEAR-1 | none | UNCLEAR-1 |
| Remapping a hold key (A, R, Space) | plan 30 §4.2 `holdRun` | the rule for holds after a remap | none | UNCLEAR-18 |
| Shortcut sheet and palette pick up remaps at once | §8; plan 30 §4.2 consistency test | the registry reads `ui.keymap` live | plan 30 §4.2 | COVERED |

### Mail (undrawn)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Undo send: 0, 5, 8, 10, 20, 30 s (default 8) | §7.10 Mail; §7.6; plan 30 U0 defect 1 | `Settings.undoSeconds` limited to those values | plan 10 E6.2 "Settings `undoSeconds`" | COVERED |
| Follow up nudge period (3 days default) | §7.2 Follow up; ARCH §8.2 "a setting" | `Settings.mail.followUpDays` (1, 2, 3, 5, 7); changes the `home` view spec | ARCH §8.2 (field unnamed) | GAP-10 |
| Remote images policy: "Block until allowed" (default) / load through the proxy | ARCH Decision 8; §7.5 | `Settings.mail.images: 'block'\|'proxy'` | roadmap §8.3 #20 (field unnamed) | GAP-10 |
| Per-sender image allow-list: list of senders with Remove | plan 30 §8.1 item 4; plan 10 §4.1 table row 4 | read the list and remove an entry (a Settings array or `SenderRule` of kind `images`) | plan 10 §4.1 "a per-sender image allow-list in Settings" | UNCLEAR-21 |
| Retention: "Keep message text for 90 days, plus anything opened, starred or unread, up to 2 GB" | plan 30 §4.5 row 2; ARCH §3.6, Decision 6 | `Settings.retention {bodyDays: number\|null, capBytes: number\|null}` | plan 10 §4.1 table row 8 "retention" | COVERED (editability UNCLEAR-22) |
| Swipe direction (mockup puts it in General) | §8 | GAP-9 field | GAP-9 | UNCLEAR-8 |

### Calendar (undrawn)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Calendars per account: show/hide, colour override | §4.2 "manual override in Settings"; §7.8 sidebar | `calendar.hidden`, `calendar.selected`, `calendar.colour`; a setter | plan 30 §8.2 "hidden and selected calendars, colours" (no setter named) | GAP-19 |
| Section contents (week start, default calendar for new events, default length) | none in DESIGN | `Settings.calendar {weekStart, defaultCalendarId, defaultEventMinutes}` | none | GAP-19; UNCLEAR-9 |
| Calendar permission missing (granted scopes) | plan 20 §2 item 8 "Calendar … capabilities follow the grant" | per-account `missingScopes` + Reconnect | plan 20 PV5 | GAP-6 |

### Notifications (undrawn)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| Show notifications (Do now and Important updates only; never Low importance) | §7.13 macOS banners | `Settings.notifications.enabled` | plan 10 E6.6 notification outbox (no preference fields) | GAP-11 |
| Per account | §7.13 "per account" | `Settings.notifications.accounts: Record<accountId, boolean>` or `account.notify` | none | GAP-11 |
| Optional reconnect reminder notification (off by default) | plan 20 PV5 item 6; roadmap decision 3 | `Settings.notifications.reconnectReminder: boolean` | plan 20 PV5 item 6 ("only if the owner picks it"; no field) | GAP-11 |
| macOS permission state ("Notifications are off for Aplos in System Settings." + Open System Settings) | §7.15 pattern | native permission read + open the pane | none | GAP-11 |

### Help & about (undrawn)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| "Version 0.3.0 · macOS" | §10 | `Session/get.appVersion` | ARCH §9.5 `Session/get` | COVERED |
| "See every shortcut." → `ShortcutSheet` | §10; §6 `ShortcutSheet` | registry command | plan 30 §4.2 | COVERED |
| "Show welcome" → opens the onboarding window beside the mail window, changing nothing | plan 30 §4.5 row 9; §7.11 | a main-process call to open the onboarding window | plan 30 §4.5 row 9 (`ui-onboard`'s patch; call unnamed) | UNCLEAR-16 |
| "Load demo mail" (no demo account) / "Reset demo mail" | plan 30 §4.5 row 8 | `Demo/load`, `Demo/reset`; `account.isDemo` to pick the label | plan 10 E5.7 | COVERED (flag in GAP-6) |
| "Export diagnostics" → `Dialog` previewing the content-free bundle → Save | plan 30 §4.5 row 3; ARCH §11 | `Diagnostics/preview` output shape; a save path (`Diagnostics/save` or native `file.save`) | plan 10 E7.8 (preview named, save not) | GAP-20 |
| Queue inspector: ops, jobs, submissions with Retry and Discard; live | plan 30 §4.5 row 3; ARCH §11 | `Queue/list` row shape, `Queue/retry\|discard {kind, id}`, updates | plan 10 E7.8 `Queue/list\|retry\|discard` (no row shape) | GAP-21 |
| Discard a submission (it stops a send) → destructive confirm | §6 `Confirm` | `kind='submission'` | plan 10 E6.1 | COVERED |
| Diagnostics or queue not built yet → "Not available yet" | plan 30 U7 | capability flags `diagnostics`, `queueInspector` | GAP-14 | GAP-14 |

### Tools on this Mac (undrawn; recommended under General, see UNCLEAR-8)

| Element / state | DESIGN § | Needs | Planned home | Status |
|---|---|---|---|---|
| "Allow tools on this Mac" switch (off by default in release builds) | plan 10 E7.4; ARCH §12.3 | `Listener/set {enabled}` and a read `Listener/get` → `{enabled, listening}` | plan 10 E7.4 `Listener/set` (no read) | GAP-22 |
| Connected tools list: name, kind, scopes (read / draft / send / admin), last seen, Revoke | ARCH §12.3 item 5; plan 10 E7.3 | `Clients/list` row `{id, name, kind, scopes, createdAt, lastSeenAt, connected}`, `Clients/revoke`, `Clients/setScopes` | plan 10 E7.4 `Clients/*` (no verbs or shapes) | GAP-23 |
| Add a tool: the token never reaches the renderer | ARCH §12.3 item 2 | `Clients/create {name, scopes}` → `{clientId, tokenFile}` (host writes a 0600 file) | ARCH §12.3 ("CLI token in a 0600 file"; no create flow) | GAP-23 |
| Audit: every send, delete and settings change by a non-UI client | ARCH §12.3 item 5 | `Clients/audit {clientId?, before?, limit}` → `[{at, clientId, method, outcome}]` | plan 10 E7.3 `audit_log` (no read) | GAP-23 |
| In-app confirmation for an MCP send | plan 10 E7.6 | a confirm-request frame and a dialog | plan 10 E7.6 ("the dialog is plan 30's"; lane unnamed) | UNCLEAR-25 |
| Revoke closes open connections within 1 s; the row leaves | plan 10 E7 acceptance | `Clients/revoke` receipt | plan 10 E7 | COVERED |

## Gaps

**GAP-1. AI provider table: method and row shape.**
- Needs: provider rows with status ("Ready", "Needs a key", running / "not running"), key source ("From environment: GROQ_API_KEY", "Saved in Keychain", "Not set · reads ANTHROPIC_API_KEY"), "Default" tag, Voice-eligible providers, `trainsOnInputs`, the refused-key help URL.
- Why uncovered: plan 30 U7 and the roadmap name "`eng-ai`'s provider table with `trainsOnInputs`", but no method or fields exist in plan 10 §4.1, and nothing says how key source is reported without key characters. Today's `AiKeyInfo` carries `last4`, which breaks DESIGN §7.10.
- Proposed shape: `Ai/providers` → `[{id: 'groq'|'openai'|'anthropic'|'gemini'|'openrouter'|'opencode'|'ollama'|'lmstudio'|'custom', name, group: 'hosted'|'local', isDefault, envVar, keySource: 'environment'|'keychain'|'none'|'notNeeded', alsoInEnvironment: boolean, keyOptional, status: 'ready'|'needsKey'|'running'|'notRunning'|'needsAddress'|'refused'|'unreachable', address?, defaultAddress?, trainsOnInputs, capabilities: {chat, speechToText, tools}, keyHelpUrl?, lastTest?: {ok, ms, at, reasonCode?}}]`, open string enums. Live through the `state` frame (type `AiProvider`). The schema has **no** field that can hold key text, and a schema lint forbids `key|secret|token|last4` output fields on this type.
- Addressed to: `eng-ai` (data), `eng-contract` (schema).
- Severity: blocks-freeze. The fixture must serve it on day 4, and the "no key characters" rule is a schema property.
- Stand-in: scenario `ai-providers-mixed` (below); knob `Fixture/control {aiProvider: {id, keySource, status}}`.

**GAP-2. Model lists per provider.**
- Needs: model selects for each feature, with speech models for Voice, OpenRouter's large catalogue, and models discovered on Ollama, LM Studio and custom servers (legacy: "No models that can use tools yet").
- Why uncovered: no planned method. Plan 30 U7 does not say where model lists come from.
- Proposed shape: `Ai/models {provider, kind: 'chat'|'speech', query?}` → `{models: [{id, label, description?, tools?, recommended?}], discovered: boolean, error?: {type, message}}`. The curated list for hosted providers lives in `packages/contract` so the browser preview works offline. Custom servers accept a typed id.
- Addressed to: `eng-ai`.
- Severity: additive-later, but wanted at C1 (WP7.3 starts on day 6).
- Stand-in: knob `aiProvider.models`, plus `ollama` running or not.

**GAP-3. Write-only key methods and the secret tag.**
- Needs: "Add key", "Replace key" and Remove, with the key never shown, the renderer not holding it after submit (plan 30 U7 acc. 3 canary scan), and keys in Keychain (DESIGN §7.10).
- Why uncovered: ARCH §12.2 says where keys live, not how one arrives. The thread brief (plan 50 line 497) even says "keys come from the backend environment", which contradicts DESIGN's "Add key" (UNCLEAR-2).
- Proposed shape:
  - `Ai/setKey {provider, key}` → `{keySource: 'keychain'}`.
  - `Ai/removeKey {provider}` → `{keySource}`, with errors `keyFromEnvironment` and `secureStorageUnavailable` (browser preview).
  - The registry gets a `sensitive` arg tag: the logger redacts it, the method is never exposed to listener, MCP or HTTP clients (UI port only, or `admin` plus UI), it is excluded from OpenAPI examples and from diagnostics ring buffers, and it never appears in an error `message`.
  - `Session/get.capabilities.secureKeys`.
  - The renderer clears the field synchronously on submit and keeps no copy in state.
- Addressed to: `eng-ai` (methods), `eng-contract` (registry tag, logger catalog), `eng-host` (vault lives in main/engine).
- Severity: blocks-freeze. The registry tag and its transport filtering are frozen in F1/F2.
- Stand-in: knob `secureKeys: false`. The canary test seeds a fake key string through `Ai/setKey` and the env presence knob.

**GAP-4. Provider and model test.**
- Needs: Test, "Testing…", "Works · 0.4 s", "Key refused" with an `ErrorLine`, and cancel on leaving the page.
- Why uncovered: `Ai/request` is a general interactive call. No test verb, result shape or reason codes are planned.
- Proposed shape: `Ai/test {provider, model?, requestId}` → `{ok, ms, reasonCode?: 'keyRefused'|'unreachable'|'notRunning'|'rateLimited'|'dailyLimit'|'modelMissing'|'noTools'|'timeout', message}`; cancel by `requestId` (`Ai/cancel`) or abort. The result is persisted into `provider.lastTest`.
- Addressed to: `eng-ai`.
- Severity: additive-later.
- Stand-in: knob `Fixture/control {aiTest: {provider, result, ms, delayMs}}`.

**GAP-5. `Settings.ai` fields beyond the per-feature pair.**
- Needs: local and custom server addresses (AGENTS.md: "address changeable in Settings"), the daily cap (ARCH §8.4: tokens, default 150,000), and the Gemini paid-key mark (plan 10 E5.3: "unless the owner marks the key paid").
- Why uncovered: the F1 list names only "per-feature AI provider and model".
- Proposed shape: `Settings.ai = {features: {ask|summaries|drafts|plans|voice: {provider, model}}, servers: {ollama: {address}, lmstudio: {address}, custom: {address}}, dailyCapTokens: number|null /* null = no limit, 0 = off */, providers: {gemini: {paidKey: boolean}}}`. Empty address means the default port.
- Addressed to: `eng-ai`, `eng-contract`.
- Severity: blocks-freeze (Settings schema shape in F1).
- Stand-in: none beyond `demo`.

**GAP-6. Account row fields and setters.**
- Needs:
  - "One name per account everywhere".
  - The provider label and the colour swatch override (§4.2).
  - "Connected · synced 2 min ago".
  - Which permission is missing ("Aplos needs permission to read your Gmail.", or calendar).
  - The demo account's Reset and Remove, and "Load" vs "Reset demo mail".
  - "Use this account's mail for AI".
  - Remove for a real account.
- Why uncovered: ARCH §9.1 lists the `Account` type without fields. Plan 30 §8.2 gives only `status {state, reason, resumeAt, reconnectBy}`. `aiAllowed` is named, but no setter is. Remove and colour have no verbs. Granted scopes stay inside `prov-gov`.
- Proposed shape:
  - The `Account` row gains `name`, `address`, `provider: 'google'` (open enum), `colour: 'sky'|'hill'|'stamp'|'dusk'|'sand'|'ember'`, `colourIsDefault`, `isDemo`, `aiAllowed`, `lastSyncedAt?`, `missingScopes: ('mail'|'calendar'|'filters')[]`, and `status {state, reason, resumeAt?, reconnectBy?, backfill?: {n, m}}`.
  - `Account/set {accountId, colour?, aiAllowed?, name?}`.
  - `Account/remove {accountId}` (real accounts; demo accounts use `Demo/remove`).
- Addressed to: `eng-contract`, `prov-gov` (scopes, lastSyncedAt).
- Severity: blocks-freeze for the row fields (every screen reads them); the setters are additive.
- Stand-in: scenarios `needs-reauth` and `needs-permission` (new); knob `Fixture/control {account: {id, patch}}`.

**GAP-7. Lease holder's device name.**
- Needs: "Background work runs on: MacBook Pro" with "Use this Mac".
- Why uncovered: ARCH §6.5 and plan 20 PV2 define the lease as `{deviceId, until}`. A device id is not a name, and the other device's name must travel in the workflow channel.
- Proposed shape: `Account/lease {accountId, take?: true}` → `{holder: {deviceId, deviceName, isThisDevice}, until, role: 'primary'|'secondary'}`. The workflow-channel lease record gains `deviceName` (the macOS computer name). The account row also carries `lease` so Settings needs no extra call.
- Addressed to: `prov-gov` (record), `eng-contract` (schema).
- Severity: additive-later, but before PV3 writes lease records.
- Stand-in: scenario `lease-elsewhere`; knob `Fixture/control {lease: {accountId, deviceName, isThisDevice}}`.

**GAP-8. A renderer clock that follows the fixture clock.**
- Needs: "`reconnectBy` within 24 hours", "tomorrow at 9:00 AM", "Paused for today. Resumes tomorrow.", "synced 2 min ago" and "Resuming at 2:14 PM", all stable under `APLOS_NOW` / `Fixture/control` set-clock (plan 30 U7 acc. 8 runs with `reconnectBy` inside 24 h).
- Why uncovered: the fixture's clock knob moves the engine's time, not `Date.now()` in the renderer, so the UI's 24-hour test and labels disagree with the engine.
- Proposed shape: `Session/get.now` plus a `clock {now}` frame emitted when the fixture clock is set (test builds only). F9 adds a `useNow(granularity)` hook that reads it and falls back to `Date.now()` in production. Alternatively the engine adds `status.reconnectSoon: boolean`, but labels still need the clock.
- Addressed to: `ui-foundation` (hook), `eng-contract` (frame).
- Severity: blocks-freeze (F9 hook signatures).
- Stand-in: knob set clock (exists).

**GAP-9. `Settings.ui` fields missing from the planned list.**
- Needs: theme, the swipe direction, the minimised sidebar, the single-key switch, the developer toggle (§9 rule 4), the one-time "Hold ⌘ to see keys." toast (§7.13), and the keymap shape.
- Why uncovered: plan 30 §8.1 item 8 lists only density, key hints, dock, keymap and hold threshold, and gives no keymap shape.
- Proposed shape: `Settings.ui = {theme: 'light'|'dark'|'system', density: 'roomy'|'comfortable'|'compact', keyHints: boolean, singleKeyShortcuts: boolean, holdThresholdMs: number /* 250 */, swipeDirection: 'rightDone'|'leftDone', sidebarMinimised: boolean, dock: {open: boolean, tab: 'ask'|'today'}, keymap: {[commandId]: {[context]: string[]}} /* overrides only */, developerDetails: boolean, seen: {holdCmdHint: boolean}}`. The chord string format is shared with GAP-17.
- Addressed to: `eng-contract` and `ui-foundation` (roadmap F1 consumes F9 for the `ui` object).
- Severity: blocks-freeze.
- Stand-in: none.

**GAP-10. Mail settings fields.**
- Needs: the Follow up nudge period ("3 days by default, a setting", ARCH §8.2) and the remote-image policy (Decision 8).
- Why uncovered: only `undoSeconds` is named (plan 10 E6.2).
- Proposed shape: `Settings.mail = {followUpDays: number /* 3 */, images: 'block'|'proxy'}`. `undoSeconds` stays top-level or moves to `Settings.mail.undoSeconds: 0|5|8|10|20|30` (decide once). The `home` view spec reads `followUpDays`.
- Addressed to: `eng-contract`, `eng-views` (Follow up), `eng-html` (images).
- Severity: blocks-freeze for field names; behaviour is additive.
- Stand-in: none.

**GAP-11. Host-level settings and OS permissions.**
- Needs: "Open Aplos when you log in." reflecting the real OS state; notification permission ("off in System Settings"); microphone permission for Voice; per-account notifications and Do now / Important updates only (§7.13); the optional reconnect notification (plan 20 PV5 item 6).
- Why uncovered: plan 10 E1.4 names only a set-style native `system.login`. No permission read is planned. Plan 10 E6.6's notification outbox has no preference fields.
- Proposed shape:
  - Native `system.loginItem.get|set` → `{enabled, openedAtLogin}`.
  - Native `system.permissions.get` → `{notifications, microphone: 'granted'|'denied'|'notDetermined'|'restricted'|'unknown'}`.
  - Native `system.openSettings {pane: 'notifications'|'microphone'|'loginItems'}`.
  - `Settings.notifications = {enabled, accounts: {[accountId]: boolean}, reconnectReminder: boolean}`; the outbox filters on them.
  - Capabilities `loginItem`, `notifications`, `menuBar`, all false in the browser preview and under `APLOS_TEST`.
- Addressed to: `eng-host` (native, main), `eng-time` (outbox filter), `eng-contract` (fields). `ui-onboard`'s permissions step needs the same reads.
- Severity: additive-later. The `Settings.notifications` field names are wanted at C1.
- Stand-in: knob `Fixture/control {permissions: {...}}` (preview fakes the native side).

**GAP-12. Consent shape.**
- Needs: "Background summaries are paused until you agree to the new provider." + "Review"; the consent card's provider and model; the background switch.
- Why uncovered: `Consent/*` is named (plan 10 §4.1 table row 6) without verbs or fields.
- Proposed shape: `Consent/get` → `{scope: 'background', version, provider, model, grantedAt?, needsReview: boolean, reason?: 'never'|'providerChanged'|'scopeChanged'|'revoked'}`; `Consent/grant {scope, version}`; `Consent/revoke {scope}`. Live through `state`.
- Addressed to: `eng-ai`. Shared with `ui-onboard`.
- Severity: blocks-freeze (two lanes bind to it).
- Stand-in: new scenario `consent-stale`; knob `Fixture/control {consent: {needsReview, reason}}`.

**GAP-13. AI usage and pause state.**
- Needs: "Paused for today. Resumes tomorrow." for the background cap (ARCH §8.4), and a visible reason when a model's daily 429 stops its queue (plan 10 E5.2).
- Why uncovered: the `ai_usage` table exists. No read method or pause fact reaches the UI.
- Proposed shape: `Ai/usage` → `{day, backgroundTokens, cap, backgroundPausedUntil?, pauseReason?: 'cap'|'consent'|'noProvider'|'providerDaily', models: [{provider, model, tokensToday, pausedUntil?, reason?}]}`. Live through `state`.
- Addressed to: `eng-ai`.
- Severity: additive-later.
- Stand-in: scenario `ai-budget-spent` (exists); knob `Fixture/control {aiUsage: {...}, modelPause: {...}}`.

**GAP-14. Named capability flags.**
- Needs: "Not available yet" per surface.
- Why uncovered: `Session/get.capabilities` is frozen in F1 without names.
- Proposed shape: `capabilities: {listener, clients, diagnostics, queueInspector, secureKeys, loginItem, menuBar, notifications, voice, calendar, lease, demo, localAi}` (booleans; unknown keys mean false).
- Addressed to: `eng-contract`.
- Severity: blocks-freeze.
- Stand-in: scenario `caps-off`; knob `Fixture/control {capabilities: {...}}`.

**GAP-15. Settings entries in the palette, and deep links.**
- Needs: "Every setting is searchable from ⌘K" and "every `SettingRow` registers a palette entry" (plan 30 U7 acc. 2), even while Settings is closed; Ask's "Use another provider" deep link.
- Why uncovered: the plan 30 §4.2 registry describes commands with `run`. Entries registered on mount would vanish when Settings is closed. No route-with-anchor or breadcrumb field is planned.
- Proposed shape: F9 registry accepts static entries from a `settings/index.ts` manifest, `{id: 'setting.mail.undoSeconds', label, keywords, group: 'Settings', breadcrumb: ['Settings', 'Mail'], run: navigate('settings/mail', {focus: 'undoSeconds'})}`. `SettingRow`'s `id` must match a manifest entry (a test enforces it). The route accepts `focus` and scrolls and focuses the row.
- Addressed to: `ui-foundation`.
- Severity: blocks-freeze (CommandRegistry interface, F9).
- Stand-in: none.

**GAP-16. Opening `ui-onboard`'s sheets from Settings.**
- Needs: "Reconnect … opens the reconnect sheet (§7.1)"; "Review" opens the consent card; "Add an account" opens the account component.
- Why uncovered: `ReconnectSheet` is built by `ui-onboard` (DESIGN §6), and lanes own disjoint folders. F9 lists components, not a sheet host or commands with arguments.
- Proposed shape: registry commands with args, `account.reconnect {accountId, mode: 'reconnect'|'grant'}` and `ai.reviewConsent`, run by a shell-level sheet host. Alternatively, F9 freezes `ReconnectSheet` props `{accountId, mode, onClose}` and exports it from `renderer/ui`.
- Addressed to: `ui-foundation`, `ui-onboard`, `ui-shell`.
- Severity: blocks-freeze (F9 interface).
- Stand-in: scenarios `needs-reauth`, `reconnect-soon`.

**GAP-17. Keymap utilities for remapping.**
- Needs: KeyRecorder, "Already used by Later", "Same keys as …", Replace, and refusing chords the system owns.
- Why uncovered: plan 30 §4.2 has a resolver and a duplicate test, but no exported overlap rule, chord format or reserved list. A conflict check written in Settings would drift from the resolver.
- Proposed shape: F9 exports `chordFromEvent(e): string|null` (IME-safe, Caps Lock ignored), `formatChord(chord)`, `contextsOverlap(a, b)`, `conflictsFor(commandId, context, chord, bindings)`, `RESERVED_CHORDS`, `defaultBindings`, and `KeyRecorder` props `{commandId, context, onCommit(chord), onCancel, onConflict(other)}`.
- Addressed to: `ui-foundation`.
- Severity: blocks-freeze (F9).
- Stand-in: none.

**GAP-18. Undo for UI-local settings changes.**
- Needs: "Done is now L · Undo Z" and Z undo after a remap or a setting change.
- Why uncovered: plan 30 §4.1 routes undo through `Operation/undo` (engine ops). Settings writes are not ops.
- Proposed shape: the F9 undo stack accepts `{label, undo: () => Promise<void>}` entries. Settings pushes "write the previous value".
- Addressed to: `ui-foundation`.
- Severity: blocks-freeze (F9 receipts and undo interface).
- Stand-in: none.

**GAP-19. Calendar settings.**
- Needs: the colour override for calendars (§4.2), show and hide (plan 30 §8.2), and the Calendar section's rows.
- Why uncovered: plan 30 §8.2 names the facts, but no setter. DESIGN draws nothing.
- Proposed shape: `Calendar/set {calendarId, hidden?, colour?}`; `Settings.calendar = {weekStart: 0|1|6, defaultCalendarId?, defaultEventMinutes: 30}`.
- Addressed to: `prov-cal`, `eng-contract`.
- Severity: additive-later.
- Stand-in: `demo` with two calendars.

**GAP-20. Saving the diagnostics bundle.**
- Needs: "Export diagnostics" opens a `Dialog` previewing the content-free bundle, then saves it (never uploaded).
- Why uncovered: only `Diagnostics/preview` is named. Its output shape and the save path are not.
- Proposed shape: `Diagnostics/preview` → `{sections: [{title, rows: [{label, value}]}], bytes, crashDumps: {count, dates}}`; `Diagnostics/save` → `{path}` (main shows the save panel; the bundle never passes through the renderer as a file).
- Addressed to: `eng-host`.
- Severity: additive-later.
- Stand-in: knob seeds statuses; the canary test greps the preview.

**GAP-21. Queue inspector rows.**
- Needs: the inspector lists ops, jobs and submissions with Retry and Discard (plan 30 §4.5 row 3).
- Why uncovered: plan 10 E7.8 names `Queue/list|retry|discard` without shapes or live updates.
- Proposed shape: `Queue/list {kind?}` → `[{kind: 'op'|'job'|'submission', id, accountId, threadId?, action /* 'archive', 'summary', 'send' … */, state, attempts, nextAt?, createdAt, lastError?: {class, message}}]`; `Queue/retry|discard {kind, id}` → receipt. Updates through `state` (type `Queue`) or `View/watch {spec: 'queue'}`. The UI may fetch the subject with `Thread/get`.
- Addressed to: `eng-ai`, `eng-time`, `eng-host`.
- Severity: additive-later.
- Stand-in: new scenario `queue-errors`; knob `Fixture/control {queue: [...]}`.

**GAP-22. Listener state read.**
- Needs: the switch must show the true state, and whether it is listening.
- Why uncovered: only `Listener/set` is named.
- Proposed shape: `Listener/get` → `{enabled, listening, error?}`.
- Addressed to: `eng-host`.
- Severity: additive-later.
- Stand-in: knob `listener`.

**GAP-23. Client verbs and shapes.**
- Needs: the connected tools list, scopes, revoke, audit, and adding a tool without the renderer seeing the token.
- Why uncovered: `Clients/*` is named in plan 10 E7.4 and plan 50 F1 without verbs. ARCH §12.3 forbids giving a token to the renderer, but there is no create flow.
- Proposed shape:
  - `Clients/list` → `[{id, name, kind: 'cli'|'mcp'|'http', scopes: ('read'|'draft'|'send'|'admin')[], createdAt, lastSeenAt?, connected}]`.
  - `Clients/create {name, scopes}` → `{clientId, tokenFile}`.
  - `Clients/setScopes {clientId, scopes}`.
  - `Clients/revoke {clientId}`.
  - `Clients/audit {clientId?, before?, limit}` → `[{at, clientId, method, outcome}]`.
- Addressed to: `eng-host`.
- Severity: additive-later (names wanted at C1).
- Stand-in: new scenario `tools-on`; knob seeds clients and audit rows.

**GAP-24. Stand-in scenarios and knobs for this screen.** They are listed in the harness section below.
- Addressed to: `eng-contract`.
- Severity: additive-later (Phase 1).
- Note: `reconnect-soon` and `needs-permission` are shared with `ui-onboard` and `ui-shell`.

## Unclear

1. **What the single-key switch does when off.** The mockup says "Off means they need ⌘." ⌘ collides with system and app chords: ⌘C copy (C compose), ⌘A select all (A Ask), ⌘Z, ⌘F, ⌘N, ⌘X, ⌘R, ⌘L, ⌘E. WCAG 2.1.4 allows turning off or remapping. **Recommend:** off means single-character bindings do nothing, and the palette and remapping remain. The hint becomes "Letters like E and L act on their own. Off turns them off; ⌘K still finds every action." Owner reads it at day 9.
2. **Adding keys in the app, and which key wins.** DESIGN §7.10 and the mockup have "Add key" and "Saved in Keychain". Plan 50 line 497 says "keys come from the backend environment". Today a saved key beats the env key. **Recommend:** DESIGN wins. A saved key wins. With both present, show "Saved in Keychain · GROQ_API_KEY is also set", and Remove removes the saved key and falls back to env. Env only: Remove disabled with the tooltip. Fix plan 50's line.
3. **Is "Saved in Keychain" literally true?** Keys live in an encrypted vault whose data key is Keychain-wrapped (ARCH §12.2). **Recommend:** keep the copy (the protection is Keychain's), or `eng-host` stores AI keys as real Keychain items. Decide at freeze.
4. **How far `trainsOnInputs` reaches.** ARCH §8.3 says "Background mail content never goes to a provider marked true". Plan 10 E5.3 says "mail content never goes" (interactive too). **Recommend:** the strict reading. Free Gemini is disabled in every mail feature's picker with the reason, and the "paid plan" switch enables it.
5. **Daily cap unit.** The mockup offers "100 / 250 / 500 / 1,000 requests / No limit". ARCH §8.4 and Decision 13 use tokens, default 150,000. **Recommend:** tokens, with options 50,000 / 150,000 (default) / 300,000 / No limit / Off ("Off" = no automatic summaries, Decision 13).
6. **The "Summarise in the background" switch** is in the mockup only. **Recommend:** keep it as the background-consent switch (on = `Consent/grant`, off = `Consent/revoke`). Its hint names the Summaries provider live ("sends it to Groq"). Re-review then shows when it is on and `needsReview`.
7. **Demo controls placement, and undo.** DESIGN §7.10 puts Reset and Remove on the demo account row. Plan 30 §4.5 row 8 puts "Load demo mail"/"Reset demo mail" under Help. The mockup has a "Demo mail" group in Accounts with Load, Reset and Remove, and an Undo toast on Remove. **Recommend:** the demo account row in Accounts has Reset and Remove. Help has "Load demo mail" only when no demo account exists. Remove uses a two-row confirm and has no Undo, because `Demo/remove` has no inverse.
8. **Undrawn rows: which section.** **Recommend:**
   - General: theme, density, key hints, swipe direction, minimised sidebar, login, menu bar, and "Tools on this Mac" (switch plus connected tools).
   - Mail: undo send, Follow up, images, allow-list, retention.
   - Accounts: per account AI, colour, lease, notifications link.
   - Help & about: version, shortcuts, "Show welcome", "Load demo mail", diagnostics, the queue inspector, developer details.
   - Note: the brief puts swipe direction in Mail; the mockup puts it in General. Either works, since the palette finds it.
9. **Calendar section contents** are undefined by DESIGN. **Recommend:** the calendars list (visibility, colour), week start and default calendar. Nothing else in round 1.
10. **Notifications section contents** are undefined. **Recommend:**
    - master switch, per-account switches and the permission line;
    - the optional "Remind me before Gmail asks to reconnect" (off);
    - no lane choice, since DESIGN fixes Do now + Important updates.
11. **The "one name" for an account.** The mockup shows the address. Legacy showed name and email. **Recommend:** the address is the name unless renamed (`Account/set {name}`). Rows, switcher and tooltips use `account.name`.
12. **Reconnect for `needsPermission`.** DESIGN routes it through the same sheet. Plan 20 calls it `Account/grantPermissions` (a full re-consent). **Recommend:** one sheet with `mode: 'reconnect'|'grant'` (GAP-16) and the same progress copy.
13. **One filled button with several Reconnect rows.** **Recommend:** only the first account needing action gets the filled Reconnect; the others get text Reconnect. "Reconnect now" (not yet expired) is always text.
14. **Live settings.** Is `Settings` in the `state` frame's type map? **Recommend:** yes. All JMAP-style types including `Settings`, `Account`, `AiProvider` and `Consent` are listed in the frame, so pop-outs pick up a remapped key or theme.
15. **Naming style.** Plan 10 uses `Clients/*`, `Queue/list` and `Listener/set`. ARCH §9.1 uses JMAP-style `get/changes/set/query` per singular type (`Client`). **Recommend:** keep plan 10's names as written and note the exception in the contract README.
16. **"Show welcome" call.** It opens the onboarding window "without changing anything" (plan 30 §4.5 row 9). No native method is named (`ui-onboard`'s main patch). **Recommend:** a native `window.openOnboarding {mode: 'review'}` in `main/windows.ts` that does not call `Setup/begin`.
17. **Legacy rows with no home in DESIGN:** the signature, the default mail app, the update check, export of local data, the sender-rules list, and "Remove old copy" of `aplos.db` (roadmap §8.3 #21). **Recommend:** none in round 1 except what the owner asks for. "Remove old copy" arrives in Help after the release is stable, with `Store/legacyCopy` and `Store/removeLegacyCopy` (additive later). Ask the owner about signatures.
18. **Holds after a remap.** If Ask moves from A to ⇧⌘A, does hold-to-dictate follow? **Recommend:** a hold follows only when the new binding is a single key without modifiers. Otherwise dictation stays reachable from the palette and the mic control.
19. **Local addresses with or without `/v1`.** The mockup shows `http://localhost:11434`. Legacy used `/v1`. **Recommend:** the engine normalises both. The UI shows what the user typed, with the default as placeholder.
20. **Where theme lives.** **Recommend:** `Settings.ui.theme` in the engine; the engine emits `appearance {theme}` (plan 10 E3.6) so main sets `nativeTheme.themeSource`. The renderer never sets it alone.
21. **Image allow-list storage.** A `Settings` array or `SenderRule` (ARCH §9.1 lists the type)? **Recommend:** `SenderRule {sender, kind: 'images'|'lane'}` with `SenderRule/query|set`, so lane rules can be listed later with no new store.
22. **Retention: editable or a statement?** **Recommend:** a select with Decision 6's three options, and current usage as the hint ("Using 840 MB"). That needs a size fact, from `Diagnostics/preview` or a new `Store/usage`.
23. **The listener in dev builds.** The preview has its own tokenised binding (plan 10 §4.1). **Recommend:** the switch reflects only the tools listener (E7), never the preview binding.
24. **Lease row per account or one row.** ARCH §6.5's lease is per account. **Recommend:** one row per account group. When every account has the same holder, a single General-level line suffices. Owner picks at review.
25. **Who draws the MCP send confirmation** (plan 10 E7.6)? **Recommend:** `ui-shell` (an app-level `Dialog`); Settings only lists grants.
26. **Auto-test after "Add key".** **Recommend:** yes, a Test runs right after save, as today.

## DESIGN vs mockup

| # | Mockup | DESIGN / plans | Wins | Behaviour change |
|---|---|---|---|---|
| 1 | Every page draws a page title and subtitle (`S.page`) | §7 "There are no page titles"; §7.10 "with no page title"; DESIGN-CHANGES (no big title, no subtitle) | DESIGN | Drop titles and subtitles; nav aligned with the first group. NOTES / DESIGN-CHANGES §5.16 "page title and subtitle" is superseded |
| 2 | Density "Normal" | §4.4 "Comfortable (default)" | DESIGN | Label only |
| 3 | "Open Aplos at login"; "Keep Aplos in the menu bar" | §10 "Open Aplos when you log in."; plan 30 §4.5 "…when the window closes" | DESIGN / plan | Copy only |
| 4 | "Use this mail for AI" (row and the "How your mail is used" text) | ARCH §8.3, plan 30 §4.5 "Use this account's mail for AI" | Plan | Copy, in two places |
| 5 | A Fastmail · IMAP account; "Add an account: Google, iCloud, Fastmail or any IMAP mailbox." | Roadmap round 1: Google only | Roadmap | Round 1 shows Google rows and "Add a Google account" |
| 6 | Accounts draws only `ok` and `needsReauth` | §7.10: Reconnect also for `needsPermission` and `reconnectBy` within 24 h; the lease row (plan 30 §4.5 row 2); the other status hints | DESIGN | Add the states; new harness states `reconnect-soon`, `needs-permission`, `lease` |
| 7 | "Demo mail" group with Load / Reset / Remove and an Undo toast on Remove | §7.10 demo account row; plan 30 §4.5 row 8 | DESIGN (UNCLEAR-7) | Remove gets a confirm, no Undo |
| 8 | Local rows have no status, key source or Test; custom says "key optional" | §7.10 "Each provider row shows its status and key source … Each has Test" | DESIGN | Local rows gain status, Test and an optional key |
| 9 | Daily limit in requests | ARCH §8.4 tokens, 150,000 | ARCH (UNCLEAR-5) | Unit and options change |
| 10 | No consent re-review line, cap pause line, `trainsOnInputs` line, no-provider line or model-pause line | plan 30 §4.5 rows 1-2; §9 rule 7; plan 10 E5.2-3 | Plans | Add five `ErrorLine` states; new harness states |
| 11 | "Summarise in the background" switch | not in DESIGN | Mockup kept (UNCLEAR-6) | Bound to consent |
| 12 | Keyboard "Off means they need ⌘." | §11.4 (turn off or remap) | UNCLEAR-1 | Probably copy and behaviour |
| 13 | No hold-threshold row | plan 30 §4.2 (250 ms setting) | Plan | Add the row |
| 14 | Segmented controls use `role="tablist"` without tab panels | §11.3 (correct roles) | DESIGN | Use `radiogroup` / `radio` |
| 15 | Swipe direction under General | Brief: Mail; DESIGN silent | Either (UNCLEAR-8) | None |
| 16 | Provider picker lists only ready providers | DESIGN silent | Mockup | Unready providers are omitted, and free Gemini is shown disabled with its reason (UNCLEAR-4) |

## Harness scenarios and test list

**Scenarios used.**
- Existing: `demo`, `empty`, `needs-reauth`, `offline`, `backfilling`, `rate-limited`, `ai-off`, `ai-budget-spent`, `parked`.
- Proposed new ones:
  - `reconnect-soon`: a Google account with `reconnectBy` = now + 20 h; shared with `ui-onboard` and `ui-shell`.
  - `needs-permission`: mail or calendar scope missing.
  - `ai-providers-mixed`: Groq env, OpenAI keychain, OpenRouter refused, Claude/Gemini/OpenCode none, Ollama running with 2 models, LM Studio not running, custom unset.
  - `consent-stale`: provider changed, `needsReview`.
  - `gemini-free`: Gemini key saved, not paid.
  - `lease-elsewhere`: holder "MacBook Air".
  - `tools-on`: listener on, 2 clients, audit rows.
  - `queue-errors`: a failed op, a dead job and a failed submission.
  - `caps-off`: every optional capability false.
  - `two-accounts-reconnect`: two accounts in `needsReauth`.

**`Fixture/control` knobs needed:**
- set the clock (exists);
- `account {id, patch}` (status, `reconnectBy`, `missingScopes`, `isDemo`, `lease`);
- `aiProvider {id, keySource, status, models}`;
- `aiTest {provider, result, ms, delayMs}`;
- `aiUsage` / `modelPause`;
- `consent {needsReview, reason}`;
- `capabilities {...}`;
- `secureKeys`;
- `permissions {notifications, microphone}`;
- `listener`;
- `clients` / `audit` seeds;
- `queue` seeds;
- fail the next `Settings/set` (exists as "fail the next write"; confirm it covers settings).

**Pending tests: behaviour and DOM**
- `settings.nav.sections` – eight sections in order; `aria-current` on the active one; no `h1`/page title or subtitle in any section.
- `settings.rows.height` – 40 px rows, 48 px with a hint, at every density.
- `settings.reach.palette` – every `SettingRow` id has a manifest entry, and ⌘K "undo send" lands on Mail with that row focused (U7 acc. 2).
- `settings.write.reject` – a failed `Settings/set` returns the control to its old value with an `ErrorLine` + Retry.
- `general.theme.system` – System follows `appearance`; Light and Dark persist across restart via `Settings.ui.theme`.
- `general.density` – three values; the Home focus letter is 196/180/164.
- `general.loginItem.capability` – in browser preview the row reads "Not available yet".
- `mail.undoSend.options` – exactly 0, 5, 8, 10, 20, 30 s, with 8 as default (U0 defect 1).
- `mail.followUp.days` – changing it changes which threads Home's Follow up lists (stand-in).
- `mail.images.allowList.remove` – removing a sender drops it from the list.
- `accounts.row.ok` – the name, provider and "Connected · synced 2 min ago" (fixed clock).
- `accounts.row.needsReauth` – "Google needs you to sign in again." + Reconnect opens `ReconnectSheet` (U7 acc. 8).
- `accounts.row.reconnectSoon` – at `reconnectBy` − 20 h, "Gmail will ask you to reconnect tomorrow at 9:00 AM." + "Reconnect now"; at −25 h no button (U7 acc. 8).
- `accounts.row.needsPermission` – the permission copy; the sheet opens in `grant` mode.
- `accounts.row.statusCopy` – each status in ARCH §6.4 shows the §7.1 copy (table test against the catalog).
- `accounts.aiAllowed` – the toggle writes `aiAllowed`; the copy is "Use this account's mail for AI".
- `accounts.colour` – choosing Hill changes the mark at once and sticks after reload.
- `accounts.lease` – "Background work runs on: MacBook Air" + "Use this Mac" calls `Account/lease {take}`; the row then reads "this Mac".
- `accounts.demo` – a demo row has Reset and Remove; Remove asks first (Cancel default) and calls `Demo/remove`; Help then offers "Load demo mail".
- `accounts.round1.googleOnly` – no Fastmail, iCloud, IMAP or Microsoft wording anywhere in Settings.
- `ai.features.voiceProviders` – Voice's provider list is exactly Groq and OpenAI.
- `ai.features.cascade` – changing a provider resets the model to that provider's first model and writes both fields.
- `ai.providers.groups` – hosted group order Groq (Default), OpenAI, Claude, Gemini, OpenRouter, OpenCode Go; local group Ollama, LM Studio, Custom server.
- `ai.keySource.copy` – "From environment: GROQ_API_KEY", "Saved in Keychain", "Not set · reads ANTHROPIC_API_KEY".
- `ai.remove.envDisabled` – env-only Remove is `aria-disabled` with the tooltip reason.
- `ai.addKey.writeOnly` – after Return the field is empty; React state and DOM hold no key; `Ai/setKey` is called once; Test runs.
- `ai.test.states` – Testing… (Test disabled) → "Works · 0.4 s"; refused → "Key refused" + the `ErrorLine` + Replace key; leaving the page cancels.
- `ai.local.address` – editing the Ollama address writes `servers.ollama.address`; an empty value means the default port; an invalid URL shows the engine's sentence.
- `ai.consent.review` – `consent-stale` shows "Background summaries are paused until you agree to the new provider." + Review, which opens the consent card.
- `ai.cap.paused` – `ai-budget-spent` shows "Paused for today. Resumes tomorrow." only in Settings → AI; the mail surface has no error.
- `ai.gemini.free` – Gemini is disabled in mail-feature pickers with its reason; "paid plan" on enables it.
- `ai.noProvider` – `ai-off` shows one line in Settings → AI and nothing on Home or in the reader.
- `ai.secrets.canary` – no element text, attribute, screenshot, console line or log in any harness state holds the canary or any `*_API_KEY` value (U7 acc. 3).
- `keyboard.generated` – every registry command with keys appears once, in its context group.
- `keyboard.persist` – a remap writes only the override to `ui.keymap`; Reset removes it; Reset all clears it.
- `keyboard.conflict.recording` – pressing L while remapping Done shows "Already used by Later"; Replace moves it; Cancel keeps both.
- `keyboard.conflict.saved` – a stored ⌘J on Not important shows "Same keys as Toggle the Ask dock" on both rows.
- `keyboard.reserved` – ⌘Q, ⌘W and ⌘H are refused with a reason.
- `keyboard.singleKey.off` – with the switch off, E does nothing in Home and ⌘K still runs Done (per UNCLEAR-1).
- `keyboard.holdThreshold` – changing it to 400 ms delays dictation on hold A in the resolver table test.
- `keyboard.sheetSync` – after a remap, the shortcut sheet, tooltips and palette show the new keys.
- `help.version` – "Version 0.3.0 · macOS" from `Session/get.appVersion`.
- `help.diagnostics.preview` – the dialog shows sections; a canary subject, address and token seeded in mail are absent; Save calls the save path.
- `help.queue.retryDiscard` – `queue-errors` lists three kinds; Retry and Discard call `Queue/*`; discarding a submission asks first.
- `help.showWelcome` – opens the onboarding window; `Setup/begin` is not called.
- `tools.listener` – the switch calls `Listener/set` and reflects `Listener/get`; `caps-off` shows "Not available yet".
- `tools.clients.revoke` – Revoke removes the row; the audit list shows the client's last send.
- `settings.capabilities.notAvailable` – each capability false renders "Not available yet" and no dead control.

**Pending tests: keyboard paths**
- `kbd.settings.open` – ⌘, opens Settings on the last section; Esc returns to the previous place, without closing the window.
- `kbd.settings.nav` – Tab order is visual; arrows move within the nav and segmented controls; Return opens selects; 1-9 pick in short menus.
- `kbd.select.escape` – Esc closes an open select menu first, then leaves Settings.
- `kbd.recorder.swallow` – while recording, every key, including E and Space, is swallowed; Esc cancels; modifier-only presses are ignored; `isComposing` presses are ignored.
- `kbd.palette.setting` – ⌘K → "density" → Return lands on General with the Density control focused.
- `kbd.reconnect` – Tab to Reconnect, Return opens the sheet, and Esc in the sheet returns focus to the row.
- `kbd.addKey` – Return in the key field saves; Esc cancels and clears the field.

**Pending tests: visual states (light and dark, every density)**
- `vis.general.default`
- `vis.accounts.default`, `vis.accounts.reconnect`, `vis.accounts.reconnectSoon`, `vis.accounts.needsPermission`, `vis.accounts.lease`, `vis.accounts.demo`
- `vis.ai.default`, `vis.ai.testing`, `vis.ai.refused`, `vis.ai.consentStale`, `vis.ai.capPaused`, `vis.ai.geminiFree`, `vis.ai.noProvider`
- `vis.keyboard.default`, `vis.keyboard.recording`, `vis.keyboard.conflict`
- `vis.mail.default`, `vis.calendar.default`, `vis.notifications.permissionOff`
- `vis.help.default`, `vis.help.diagnosticsDialog`, `vis.help.queue`
- `vis.tools.on`, `vis.capsOff`
- `break-ui` passes: a 40-character provider name, a 200-character address, a 120-character account address, 30 clients, a 500-row queue (plan 30 U7 Verify).

**Pending tests: accessibility**
- `a11y.axe.settings` – axe clean on every visual state, in both themes.
- `a11y.switch.roles` – switches are `role="switch"` with `aria-checked` and a label.
- `a11y.segmented.radiogroup` – segmented controls expose radiogroup/radio, not tablist.
- `a11y.disclosure` – "How your mail is used" has `aria-expanded` and `aria-controls`.
- `a11y.status.notColourOnly` – provider and account states pair a dot or icon with a word.
- `a11y.recorder.live` – the recording row announces politely; the conflict text is announced.
- `a11y.focus.ring` – a 2 px accent ring is visible on every control; focus is never lost after Remove or Revoke (it moves to the next row).
- `a11y.zoom200` – at 200 % zoom and a 900 px window, the control column does not clip and hints wrap without overlap.
- `a11y.disabledReason` – a disabled Remove is focusable, with the tooltip reason readable by VoiceOver.

**Pending tests: design checks**
- `design.bannedStrings` – no §10 ban-list phrases (and no "AI-powered", "smart", "magic", "Beta") in any Settings state.
- `design.bannedGlyphs` – no sparkle, wand, star, brain or robot icon names; the AI nav icon is the speech bubble.
- `design.oneFilled` – at most one `btn-filled` per state, including `two-accounts-reconnect` (UNCLEAR-13) and `consent-stale`.
- `design.hoverNeverShifts` – hovering each control moves no other box by more than 0.5 px; Reset links appear on change, never on hover.
- `design.contrast` – every text pair is at least 4.5:1, status dots and swatches at least 3:1, in both themes and under Increase Contrast.
- `design.noKeyChars` – the DOM never contains `••••`, a `last4` or any `sk-`/`gsk_` prefix.
- `design.noTitle` – no `page-title`/`page-sub` nodes.
- `design.round1` – no non-Google provider rows or copy in Accounts.
