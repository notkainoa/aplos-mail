// Pending tests for lane `ui-onboard` (UI-screens thread, Phase 0, drafted 2026-10-27).
// Source: plans/ui-screens/map-onboard.md (test list), plans/ui-screens/pr21-absorption.md section 3 (F1-F14 names) and plans/30-ui-revamp.md U8 acceptance.
// Each todo becomes a real test when the lane starts (day 5-6). Layer per group: node = pure logic (node:test),
// dom = Playwright on the browser preview with the stand-in engine, electron = hidden _electron, visual = harness screenshots in both themes.
// Stand-in scenarios used: empty, demo, needs-reauth, rate-limited, backfilling, offline, ai-off, ai-budget-spent, setup-partial, reconnect-due, first-sync, first-sync-multi, first-sync-small, setup-paused-early, setup-failed, oauth-pending, empty-skipped, ai-env-groq-local-ollama.
// Fixture/control knobs: advanceSetup, setFound, pauseAccount, failSetup, failAi, capAi, resolveConnect, setReconnectBy, queueLocalOps, requestLog, setClock (APLOS_NOW = 2026-10-29T10:00).
import {describe, test} from 'node:test';

describe('ui-onboard: Appendix C findings F1-F14 (dom / electron)', () => {
  test.todo(`F1 reopen via Show welcome, connect, close: Setup/end called, next sync classifies – dom on stand-in with contract log`);
  test.todo(`F2 close after first sync: Setup/end called once, backfill requested – dom on stand-in`);
  test.todo(`F3 second launch during startup opens no second window – electron`);
  test.todo(`F4 mail window shown only after ready-to-show, onboarding fades in the same callback – electron`);
  test.todo(`F5 Retry twice during a running pass: one run per click, no collision, counters never decrease – dom on setup-partial`);
  test.todo(`F7 two accounts connected: mail window opens on All accounts – dom on stand-in`);
  test.todo(`F8 failed screen: Esc continues to Aplos – dom`);
  test.todo(`F9 connect resolving after Esc or Back never navigates; list updates in place – dom with delayed connect (resolveConnect)`);
  test.todo(`F10 capped or failed sort never says Done; partial and failed copy shown – dom on setup-partial plus property test`);
  test.todo(`F11 exactly one live region; announces phases only; every bar labelled – dom plus axe`);
  test.todo(`F12 typed address + Return focuses Continue with Google; Return continues – dom`);
  test.todo(`F13 steps never clip their top at 640×520 with long content; Welcome uses safe center – visual plus dom`);
  test.todo(`F14 harness seeds or drives onboarding explicitly; capture never stalls – harness`);
});

describe('ui-onboard: close-at-any-moment matrix (dom, generated)', () => {
  test.todo(`close at step × connect state {idle, pending, connected, syncing, synced}: Setup/end called, no account deferred – 20 generated cases; later mail classified with mock AI (U8 acc. 2)`);
});

describe('ui-onboard: behaviour and DOM (dom)', () => {
  test.todo(`onb-fresh-install-zero-accounts – fresh APLOS_DATA_DIR: contract log has no Demo/load, Session/get.hasAccounts false, onboarding window only`);
  test.todo(`onb-demo-isolation – "Try demo mail" calls Demo/load once, handoff skips first sync, mail window shows the demo toast and "Demo mail" in the switcher`);
  test.todo(`onb-demo-existing-data-untouched – a 0.2.x data folder that already holds demo or real data is never seeded or wiped (U8 acc. 3; added, the map did not list it)`);
  test.todo(`onb-skip-setup-no-loop – Esc on Welcome → zero-accounts mail window; relaunch opens the mail window, not onboarding (GAP-7)`);
  test.todo(`onb-round1-google-only – Accounts step renders exactly one provider row, "Google"`);
  test.todo(`onb-discover-focus-F12 – type address, Return → focus on "Continue with Google"; Return starts connect`);
  test.todo(`onb-discover-unsupported – @icloud.com in round 1 shows the unsupported line, no connect call`);
  test.todo(`onb-oauth-cancel – waiting, Esc → Account/cancelConnect called, back to choose; late connected frame adds the row without navigating`);
  test.todo(`onb-late-resolve-F9 – connect pending, owner moves to AI step; resolveConnect → step unchanged, focus unchanged, list updated`);
  test.todo(`onb-close-matrix-F1-F2 – close at each step × connect {idle, pending, connected, syncing, synced} → Setup/end recorded once or more, later mail classified with mock AI`);
  test.todo(`onb-showwelcome-reopen-F1 – mail window open, Show welcome → connect → close → Setup/end called, new mail classified`);
  test.todo(`onb-ai-env-key – Groq row shows "Key found in the environment as GROQ_API_KEY"; DOM, attributes and screenshots contain no canary key`);
  test.todo(`onb-ai-test-latency – Test → "Works · 0.4 s" from latencyMs`);
  test.todo(`onb-consent-record – Allow → Consent/grant with provider, model and version shown on the card`);
  test.todo(`onb-skip-ai-no-errors – Skip for now → first sync has 3 segments, no error anywhere`);
  test.todo(`sync-found-estimate – with estimate "Found about 214 recent emails"; without, "Found recent mail" and indeterminate bar`);
  test.todo(`sync-small-mailbox – 12 threads: reaches ready, never shows "of 50"`);
  test.todo(`sync-never-backwards – property test over random frames: no counter decreases within a runId, no "Done" before true, none for capped (node)`);
  test.todo(`sync-paused-before-window – Esc enters; Home shows "Your first mail is on its way.", never inbox-zero`);
  test.todo(`sync-paused-after-window – Open Aplos enabled, no mailbox total shown, slot carries the pause after entering`);
  test.todo(`sync-no-autoenter-unless-clean – no handoff while paused, failed, partial or capped (UNCLEAR-2)`);
  test.todo(`sync-autoenter-clean – clean finish → drawn check → handoff on ready-to-show`);
  test.todo(`sync-retry-idempotent-F5 – Try again twice → one runId, no collision error`);
  test.todo(`sync-ai-failure-copy – failAi aiKeyRefused → "Couldn't sort with Groq: the key was refused. Mail is ready; sorting will retry." + Open Settings`);
  test.todo(`sync-not-connected-row – skipped account shows "Not connected · Try again"`);
  test.todo(`sync-multi-open-early – one of two accounts ready → Open Aplos enabled`);
  test.todo(`handoff-all-accounts-F7 – two accounts connected → mail window on All accounts`);
  test.todo(`drill-no-engine-calls – drill steps produce zero contract calls`);
  test.todo(`empty-no-accounts – zero accounts: one EmptyLine, Add an account opens onboarding at Accounts`);
  test.todo(`reconnect-due-line – reconnect-due: slot "Gmail will ask you to reconnect tomorrow at 9:00 AM." + Reconnect now`);
  test.todo(`reconnect-sheet-flow – every entry point (slot, Settings row, switcher row) opens the same sheet; Account/reconnect called with the account id; waiting → connected → toast "Reconnected", focus restored`);
  test.todo(`reconnect-login-hint – the reconnect request carries the account's login_hint (same account), progress is plain, and the sheet returns to the previous screen (U8 acc. 9; added, the map did not name login_hint)`);
  test.todo(`reconnect-no-resync – queueLocalOps 10 then reconnect → requestLog has zero full-sync requests and the 10 ops flushed`);
  test.todo(`reconnect-wrong-account – resolveConnect wrongAccount → plain sentence, status unchanged`);
});

describe('ui-onboard: keyboard paths (dom)', () => {
  test.todo(`keys-onb-return-each-step – Return activates each step's main action; focus lands on it after every internal state change`);
  test.todo(`keys-onb-esc-ladder – Esc: accounts waiting → cancel; choose → Welcome; Welcome → Skip setup; AI byok → groq; menu open → close menu first`);
  test.todo(`keys-sync-esc-every-state-F8 – Esc opens Aplos in progress, paused, ready, partial, failed and inside the drill`);
  test.todo(`keys-drill-letters – J/K, Space, E, A advance the drill; ⌘-chords and global commands do nothing`);
  test.todo(`keys-onb-globals-inert – ⌘K, ⌃1, C, A do nothing in the onboarding window`);
  test.todo(`keys-sheet-esc-cancels – Esc in the reconnect sheet calls Account/cancelConnect and restores focus`);
  test.todo(`keys-tab-order-visual – Tab order equals visual order on every step`);
});

describe('ui-onboard: visual states, light and dark, 640 × 600 and 640 × 520 (visual)', () => {
  test.todo(`welcome – Welcome step`);
  test.todo(`accounts – choose, typed, waiting, connected, unsupported`);
  test.todo(`ai – groq, groq-no-key, byok, local, consent, consent-gemini-free (plus the no-consent state)`);
  test.todo(`permissions – default, granted, denied`);
  test.todo(`sync progress – 1 and 2 accounts, found-no-estimate, paused (rate-limited before and after the first window), paused-daily, ready, partial, ai-failed, failed, not-connected, no-ai (3 segments), 5 accounts (scrolls, top not clipped [F13])`);
  test.todo(`drill – step1, step3, done`);
  test.todo(`mail window – no-accounts, first-mail, demo; slot reconnect-due, needs-reauth, needs-permission, quota`);
  test.todo(`reconnect sheet – waiting, failed (wrong account), reconnected toast (also reconnecting state)`);
  test.todo(`all onboarding and loading states exist in the harness in both themes – six steps, partial, failed, multi-account, no-AI, no-consent, complete, zero-accounts, demo, reconnect due/reconnecting/failed/reconnected (U8 acc. 6; added as a coverage check)`);
});

describe('ui-onboard: accessibility (dom)', () => {
  test.todo(`a11y-one-live-region-F11 – exactly one role="status" on the sync screen; it changes only on phase changes (≤ 5 announcements for a full run)`);
  test.todo(`a11y-bars-labelled – every progress bar has aria-label "<address> sync" and aria-valuetext`);
  test.todo(`a11y-axe-all-onb-states – axe, no serious violations, both themes`);
  test.todo(`a11y-reduced-motion – ready check static; drill E removal is opacity only; marker spinner stops`);
  test.todo(`a11y-strip-target-size – "Try demo mail" hit area ≥ 24 px, outside the drag region`);
});

describe('ui-onboard: design checks (dom / visual / electron)', () => {
  test.todo(`design-banned-strings-onb – no "Done" on capped or failed passes, no "Testing mode", "verification", "magic", "AI-powered", "Hold to talk", "Ask me anything", no "Aplos needs a moment.", no raw provider error text`);
  test.todo(`design-banned-glyphs-onb – no sparkle, wand, star, brain or robot icon on the AI step or consent card`);
  test.todo(`design-one-filled-button – exactly one filled button per step and per sync state (Open Aplos disabled still counts as the one)`);
  test.todo(`design-hover-never-shifts-onb – hover every interactive element on every onboarding state; no other box moves > 0.5 px`);
  test.todo(`design-contrast-onb – --stamp-ink failure icons, --dusk paused segment, --ink-2 done segment, dim text on paper pass 4.5:1 / 3:1 in both themes`);
  test.todo(`design-no-icon-no-sky – no app icon, gradient, backdrop-filter or page title in the onboarding window or the empties`);
  test.todo(`design-window-chrome – hidden _electron: 640 × 600, min 640 × 520, vertical resize, hidden-inset title bar, one window after a second launch [F3], no mail window before ready-to-show [F4]`);
});

describe('ui-onboard: live and hands-on acceptance (manual, owner-run)', () => {
  test.todo(`live-google-first-window – owner connects a real Google test user through the new onboarding: first window within about 15 s, Home opens while older mail keeps importing, slow-down message if Google asks (U8 acc. 7, days 14-16; mocked Google does not count)`);
  test.todo(`handson-traffic-lights-and-drag-region – traffic lights over the white strip and the drag region behave (U8 acc. 8, section 6.5 #9)`);
  test.todo(`handson-first-weekly-reconnect – the first real weekly reconnect inside the daily-use week succeeds (U8 acc. 9, section 6.5 #10)`);
});
