// Pending tests for lane `ui-settings` (UI-screens thread, Phase 0, drafted 2026-10-27).
// Source: plans/ui-screens/map-settings.md (test list) and plans/30-ui-revamp.md U7 acceptance (items 2, 3, 8 touch this lane).
// Each todo becomes a real test when the lane starts (day 5-6). Layer per group: node = pure logic (node:test),
// dom = Playwright on the browser preview with the stand-in engine, electron = hidden _electron, visual = harness screenshots in both themes.
// Stand-in scenarios used: demo, empty, needs-reauth, offline, backfilling, rate-limited, ai-off, ai-budget-spent, parked, reconnect-soon, needs-permission, ai-providers-mixed, consent-stale, gemini-free, lease-elsewhere, tools-on, queue-errors, caps-off, two-accounts-reconnect.
// Fixture/control knobs: setClock, account {id, patch}, aiProvider {id, keySource, status, models}, aiTest {provider, result, ms, delayMs}, aiUsage/modelPause, consent {needsReview, reason}, capabilities {...}, secureKeys, permissions {notifications, microphone}, listener, clients/audit seeds, queue seeds, fail the next Settings/set.
import {describe, test} from 'node:test';

describe('ui-settings: behaviour and DOM (dom)', () => {
  test.todo(`settings.nav.sections – eight sections in order; aria-current on the active one; no h1/page title or subtitle in any section`);
  test.todo(`settings.rows.height – 40 px rows, 48 px with a hint, at every density`);
  test.todo(`settings.reach.palette – every SettingRow id has a manifest entry, and ⌘K "undo send" lands on Mail with that row focused (U7 acc. 2)`);
  test.todo(`settings.write.reject – a failed Settings/set returns the control to its old value with an ErrorLine + Retry`);
  test.todo(`general.theme.system – System follows appearance; Light and Dark persist across restart via Settings.ui.theme`);
  test.todo(`general.density – three values; the Home focus letter is 196/180/164`);
  test.todo(`general.loginItem.capability – in browser preview the row reads "Not available yet"`);
  test.todo(`mail.undoSend.options – exactly 0, 5, 8, 10, 20, 30 s, with 8 as default (U0 defect 1)`);
  test.todo(`mail.followUp.days – changing it changes which threads Home's Follow up lists (stand-in)`);
  test.todo(`mail.images.allowList.remove – removing a sender drops it from the list`);
  test.todo(`accounts.row.ok – the name, provider and "Connected · synced 2 min ago" (fixed clock)`);
  test.todo(`accounts.row.needsReauth – "Google needs you to sign in again." + Reconnect opens ReconnectSheet (U7 acc. 8)`);
  test.todo(`accounts.row.reconnectSoon – at reconnectBy − 20 h, "Gmail will ask you to reconnect tomorrow at 9:00 AM." + "Reconnect now"; at −25 h no button (U7 acc. 8)`);
  test.todo(`accounts.row.needsPermission – the permission copy; the sheet opens in grant mode`);
  test.todo(`accounts.row.statusCopy – each status in ARCH section 6.4 shows the section 7.1 copy (table test against the catalog)`);
  test.todo(`accounts.aiAllowed – the toggle writes aiAllowed; the copy is "Use this account's mail for AI"`);
  test.todo(`accounts.colour – choosing Hill changes the mark at once and sticks after reload`);
  test.todo(`accounts.lease – "Background work runs on: MacBook Air" + "Use this Mac" calls Account/lease {take}; the row then reads "this Mac"`);
  test.todo(`accounts.demo – a demo row has Reset and Remove; Remove asks first (Cancel default) and calls Demo/remove; Help then offers "Load demo mail" (U8 acc. 3: Load, Reset and Remove demo mail)`);
  test.todo(`accounts.round1.googleOnly – no Fastmail, iCloud, IMAP or Microsoft wording anywhere in Settings`);
  test.todo(`ai.features.voiceProviders – Voice's provider list is exactly Groq and OpenAI`);
  test.todo(`ai.features.cascade – changing a provider resets the model to that provider's first model and writes both fields`);
  test.todo(`ai.providers.groups – hosted group order Groq (Default), OpenAI, Claude, Gemini, OpenRouter, OpenCode Go; local group Ollama, LM Studio, Custom server`);
  test.todo(`ai.keySource.copy – "From environment: GROQ_API_KEY", "Saved in Keychain", "Not set · reads ANTHROPIC_API_KEY"`);
  test.todo(`ai.remove.envDisabled – env-only Remove is aria-disabled with the tooltip reason`);
  test.todo(`ai.addKey.writeOnly – after Return the field is empty; React state and DOM hold no key; Ai/setKey is called once; Test runs`);
  test.todo(`ai.test.states – Testing… (Test disabled) → "Works · 0.4 s"; refused → "Key refused" + the ErrorLine + Replace key; leaving the page cancels`);
  test.todo(`ai.local.address – editing the Ollama address writes servers.ollama.address; an empty value means the default port; an invalid URL shows the engine's sentence`);
  test.todo(`ai.consent.review – consent-stale shows "Background summaries are paused until you agree to the new provider." + Review, which opens the consent card`);
  test.todo(`ai.cap.paused – ai-budget-spent shows "Paused for today. Resumes tomorrow." only in Settings → AI; the mail surface has no error`);
  test.todo(`ai.gemini.free – Gemini is disabled in mail-feature pickers with its reason; "paid plan" on enables it`);
  test.todo(`ai.noProvider – ai-off shows one line in Settings → AI and nothing on Home or in the reader`);
  test.todo(`ai.secrets.canary – no element text, attribute, screenshot, console line or log in any harness state holds the canary or any *_API_KEY value (U7 acc. 3)`);
  test.todo(`keyboard.generated – every registry command with keys appears once, in its context group`);
  test.todo(`keyboard.persist – a remap writes only the override to ui.keymap; Reset removes it; Reset all clears it`);
  test.todo(`keyboard.conflict.recording – pressing L while remapping Done shows "Already used by Later"; Replace moves it; Cancel keeps both`);
  test.todo(`keyboard.conflict.saved – a stored ⌘J on Not important shows "Same keys as Toggle the Ask dock" on both rows`);
  test.todo(`keyboard.reserved – ⌘Q, ⌘W and ⌘H are refused with a reason`);
  test.todo(`keyboard.singleKey.off – with the switch off, E does nothing in Home and ⌘K still runs Done (per UNCLEAR-1)`);
  test.todo(`keyboard.holdThreshold – changing it to 400 ms delays dictation on hold A in the resolver table test (node)`);
  test.todo(`keyboard.sheetSync – after a remap, the shortcut sheet, tooltips and palette show the new keys`);
  test.todo(`help.version – "Version 0.3.0 · macOS" from Session/get.appVersion`);
  test.todo(`help.diagnostics.preview – the dialog shows sections; a canary subject, address and token seeded in mail are absent; Save calls the save path`);
  test.todo(`help.queue.retryDiscard – queue-errors lists three kinds; Retry and Discard call Queue/*; discarding a submission asks first`);
  test.todo(`help.showWelcome – opens the onboarding window; Setup/begin is not called`);
  test.todo(`tools.listener – the switch calls Listener/set and reflects Listener/get; caps-off shows "Not available yet"`);
  test.todo(`tools.clients.revoke – Revoke removes the row; the audit list shows the client's last send`);
  test.todo(`settings.capabilities.notAvailable – each capability false renders "Not available yet" and no dead control`);
});

describe('ui-settings: keyboard paths (dom)', () => {
  test.todo(`kbd.settings.open – ⌘, opens Settings on the last section; Esc returns to the previous place, without closing the window`);
  test.todo(`kbd.settings.nav – Tab order is visual; arrows move within the nav and segmented controls; Return opens selects; 1-9 pick in short menus`);
  test.todo(`kbd.select.escape – Esc closes an open select menu first, then leaves Settings`);
  test.todo(`kbd.recorder.swallow – while recording, every key, including E and Space, is swallowed; Esc cancels; modifier-only presses are ignored; isComposing presses are ignored`);
  test.todo(`kbd.palette.setting – ⌘K → "density" → Return lands on General with the Density control focused`);
  test.todo(`kbd.reconnect – Tab to Reconnect, Return opens the sheet, and Esc in the sheet returns focus to the row`);
  test.todo(`kbd.addKey – Return in the key field saves; Esc cancels and clears the field`);
});

describe('ui-settings: visual states, light and dark, every density (visual)', () => {
  test.todo(`vis.general.default`);
  test.todo(`vis.accounts.default`);
  test.todo(`vis.accounts.reconnect`);
  test.todo(`vis.accounts.reconnectSoon`);
  test.todo(`vis.accounts.needsPermission`);
  test.todo(`vis.accounts.lease`);
  test.todo(`vis.accounts.demo`);
  test.todo(`vis.ai.default`);
  test.todo(`vis.ai.testing`);
  test.todo(`vis.ai.refused`);
  test.todo(`vis.ai.consentStale`);
  test.todo(`vis.ai.capPaused`);
  test.todo(`vis.ai.geminiFree`);
  test.todo(`vis.ai.noProvider`);
  test.todo(`vis.keyboard.default`);
  test.todo(`vis.keyboard.recording`);
  test.todo(`vis.keyboard.conflict`);
  test.todo(`vis.mail.default`);
  test.todo(`vis.calendar.default`);
  test.todo(`vis.notifications.permissionOff`);
  test.todo(`vis.help.default`);
  test.todo(`vis.help.diagnosticsDialog`);
  test.todo(`vis.help.queue`);
  test.todo(`vis.tools.on`);
  test.todo(`vis.capsOff`);
  test.todo(`break-ui passes – a 40-character provider name, a 200-character address, a 120-character account address, 30 clients, a 500-row queue (plan 30 U7 Verify)`);
});

describe('ui-settings: accessibility (dom)', () => {
  test.todo(`a11y.axe.settings – axe clean on every visual state, in both themes`);
  test.todo(`a11y.switch.roles – switches are role="switch" with aria-checked and a label`);
  test.todo(`a11y.segmented.radiogroup – segmented controls expose radiogroup/radio, not tablist`);
  test.todo(`a11y.disclosure – "How your mail is used" has aria-expanded and aria-controls`);
  test.todo(`a11y.status.notColourOnly – provider and account states pair a dot or icon with a word`);
  test.todo(`a11y.recorder.live – the recording row announces politely; the conflict text is announced`);
  test.todo(`a11y.focus.ring – a 2 px accent ring is visible on every control; focus is never lost after Remove or Revoke (it moves to the next row)`);
  test.todo(`a11y.zoom200 – at 200 % zoom and a 900 px window, the control column does not clip and hints wrap without overlap`);
  test.todo(`a11y.disabledReason – a disabled Remove is focusable, with the tooltip reason readable by VoiceOver`);
});

describe('ui-settings: design checks (dom / visual)', () => {
  test.todo(`design.bannedStrings – no section 10 ban-list phrases (and no "AI-powered", "smart", "magic", "Beta") in any Settings state`);
  test.todo(`design.bannedGlyphs – no sparkle, wand, star, brain or robot icon names; the AI nav icon is the speech bubble`);
  test.todo(`design.oneFilled – at most one btn-filled per state, including two-accounts-reconnect (UNCLEAR-13) and consent-stale`);
  test.todo(`design.hoverNeverShifts – hovering each control moves no other box by more than 0.5 px; Reset links appear on change, never on hover`);
  test.todo(`design.contrast – every text pair is at least 4.5:1, status dots and swatches at least 3:1, in both themes and under Increase Contrast`);
  test.todo(`design.noKeyChars – the DOM never contains ••••, a last4 or any sk-/gsk_ prefix`);
  test.todo(`design.noTitle – no page-title/page-sub nodes`);
  test.todo(`design.round1 – no non-Google provider rows or copy in Accounts`);
});
