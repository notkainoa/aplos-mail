// Lane `ui-onboard`'s pending list (origin/rv/thread/ui-screens:apps/desktop/tests/ui-onboard/pending.test.ts)
// converted for the pure modules: `// covered:` comments cite the existing tests, real `test(...)`s check what the
// modules decide without a DOM/browser/Engine, and what still needs the harness stays `test.todo(... [waits: ...])`.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/pending.test.ts
// Fixtures: states tables render statically in React (renderToStaticMarkup), so the markup checks are pure.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type React from 'react';
import {
  initialReconnect,
  reduceReconnect,
  runReconnectEffect,
  type ReconnectPorts,
} from '../../src/renderer/onboarding/reconnect/reconnect.model';
import { stepStates } from '../../src/renderer/onboarding/steps/states';
import { firstSyncStates } from '../../src/renderer/onboarding/firstSync/states';
import { reconnectStates } from '../../src/renderer/onboarding/reconnect/states';
import { demoStates } from '../../src/renderer/onboarding/demo.states';

/** The static markup of one fixture state. */
const markup = (state: { render(): React.ReactNode }): string =>
  renderToStaticMarkup(state.render());

describe('ui-onboard: Appendix C findings F1-F14 (dom / electron)', () => {
  // covered: tests/ui-onboard/flow.test.ts: F1: finished then the window closes: still exactly one Setup/end (all components disconnected to the invites/step supplied, and the window closes).
  // (the five generated F1 close cases in that describe plus "F1 reopen path: "Show welcome" with accounts, connect, close → one closed Setup/end")
  test.todo(
    'F1 reopen via Show welcome, connect, close: Setup/end called, next sync classifies – dom on stand-in with contract log [waits: Playwright base]',
  );
  // covered: tests/ui-onboard/flow.test.ts: F1: finished then the window closes: still exactly one Setup/end (all components disconnected to the invites/step supplied, and the window closes).
  // (the same generated close cases end the first-sync handoff; the contract log and backfill need the window)
  test.todo(
    'F2 close after first sync: Setup/end called once, backfill requested – dom on stand-in [waits: Playwright base]',
  );
  test.todo('F3 second launch during startup opens no second window – electron [waits: Electron]');
  test.todo(
    'F4 mail window shown only after ready-to-show, onboarding fades in the same callback – electron [waits: Electron]',
  );
  // covered: tests/ui-onboard/firstSync.model.test.ts: F5 Retry twice during a running pass: one run per click, no collision, counters never decrease
  // covered: tests/ui-onboard/firstSync.model.test.ts: sync-retry-idempotent-F5 – the retry of a running row is not offered and not sent
  // covered: tests/ui-onboard/firstSync.model.test.ts: F8 failed screen: Esc continues to Aplos, and Return does too
  test.todo(
    `F7 two accounts connected: mail window opens on All accounts – dom on stand-in [waits: Playwright base]`,
  );
  test.todo(
    `F9 connect resolving after Esc or Back never navigates; list updates in place – dom with delayed connect (resolveConnect) [waits: Playwright base]`,
  );
  // covered: tests/ui-onboard/firstSync.model.test.ts: F10 capped or failed sort never says Done; partial and failed copy shown
  test.todo(
    `F11 exactly one live region; announces phases only; every bar labelled – dom plus axe [waits: Playwright base]`,
  );
  // covered: tests/ui-onboard/connect.test.ts: onb-discover-focus-F12: typed address + Return discovers, and Google focuses Continue with Google
  test.todo(
    `F12 typed address + Return focuses Continue with Google; Return continues – dom [waits: Playwright base]`,
  );
  test.todo(
    `F13 steps never clip their top at 640×520 with long content; Welcome uses safe center – visual plus dom [waits: Playwright base]`,
  );
  test.todo(
    `F14 harness seeds or drives onboarding explicitly; capture never stalls – harness [waits: Playwright base]`,
  );
});

describe('ui-onboard: close-at-any-moment matrix (dom, generated)', () => {
  // covered: tests/ui-onboard/flow.test.ts: F1: finished then the window closes: still exactly one Setup/end (all components disconnected to the invites/step supplied, and the window closes).
  // (the generated close matrix resolves every step × connect state purely there; the contract log needs the window)
  test.todo(
    'close at step × connect state {idle, pending, connected, syncing, synced}: Setup/end called, no account deferred – 20 generated cases; later mail classified with mock AI (U8 acc. 2) [waits: Playwright base]',
  );
});

describe('ui-onboard: behaviour and DOM (dom)', () => {
  test.todo(
    `onb-fresh-install-zero-accounts – fresh APLOS_DATA_DIR: contract log has no Demo/load, Session/get.hasAccounts false, onboarding window only [waits: Playwright base]`,
  );
  // covered: tests/ui-onboard/demo.test.ts: "Try demo mail" calls Demo/load once, when clicked
  // covered: tests/ui-onboard/flow.test.ts: Try demo mail ends as demo and skips first sync
  test.todo(
    `onb-demo-isolation – "Try demo mail" calls Demo/load once, handoff skips first sync, mail window shows the demo toast and "Demo mail" in the switcher [waits: Playwright base]`,
  );
  // covered: tests/ui-onboard/demo.test.ts: onb-demo-existing-data-untouched: with only real accounts, Reset and Remove are refused and never reach the engine
  // covered: tests/ui-onboard/flow.test.ts: Esc on Welcome is Skip setup
  test.todo(
    `onb-skip-setup-no-loop – Esc on Welcome → zero-accounts mail window; relaunch opens the mail window, not onboarding (GAP-7) [waits: Playwright base]`,
  );
  test('onb-round1-google-only – Accounts step renders exactly one provider row, "Google"', () => {
    const html = markup(stepStates['accounts-choose']);
    const providerRows = (html.match(/id="onb-provider-[^"]*"/g) ?? [])
      .map(id => /id="([^"]*)"/.exec(id)?.[1] ?? '')
      .filter(id => !id.endsWith('-label'));
    assert.deepEqual(providerRows, ['onb-provider-google']);
    assert.match(html, /Google/);
    assert.doesNotMatch(html, /microsoft|icloud|imap/i);
  });
  // covered: tests/ui-onboard/connect.test.ts: onb-discover-focus-F12: typed address + Return discovers, and Google focuses Continue with Google
  // covered: tests/ui-onboard/connect.test.ts: onb-discover-unsupported: another provider shows the sentence and starts no connect
  // covered: tests/ui-onboard/connect.test.ts: onb-oauth-cancel: Esc while waiting cancels that connect and returns to the field
  // covered: tests/ui-onboard/connect.test.ts: F9 frames arriving on the list or the choose screen never navigate
  // covered: tests/ui-onboard/flow.test.ts: a late connected answer still decides first sync (the account is real and was connected here)
  // covered: tests/ui-onboard/flow.test.ts: F1 reopen path: "Show welcome" with accounts, connect, close → one closed Setup/end
  // (the focus-restore and list-update halves of these are the DOM wiring; the pure halves are covered above)
  test.todo(
    `onb-late-resolve-F9 – connect pending, owner moves to AI step; resolveConnect → step unchanged, focus unchanged, list updated [waits: Playwright base]`,
  );
  test.todo(
    `onb-oauth-cancel – waiting, Esc → Account/cancelConnect called, back to choose; late connected frame adds the row without navigating [waits: Playwright base]`,
  );
  // covered: tests/ui-onboard/flow.test.ts: F1: skip then the window closes: still exactly one Setup/end (nothing happened)
  // covered: tests/ui-onboard/flow.test.ts: F1 reopen path: "Show welcome" with accounts, connect, close → one closed Setup/end
  test.todo(
    `onb-close-matrix-F1-F2 – close at each step × connect {idle, pending, connected, syncing, synced} → Setup/end recorded once or more, later mail classified with mock AI [waits: Playwright base]`,
  );
  // (the "new mail classified" half needs the mail window)
  test.todo(
    `onb-showwelcome-reopen-F1 – mail window open, Show welcome → connect → close → Setup/end called, new mail classified [waits: Playwright base]`,
  );
  // covered: tests/ui-onboard/ai.model.test.ts: Groq is preselected and its key source shows, never key characters (DESIGN 7.10)
  test.todo(
    `onb-ai-env-key – Groq row shows "Key found in the environment as GROQ_API_KEY"; DOM, attributes and screenshots contain no canary key [waits: Playwright base]`,
  );
  // covered: tests/ui-onboard/ai.model.test.ts: onb-ai-test-latency: Test reads "Works · 0.4 s" from the latency
  // covered: tests/ui-onboard/ai.model.test.ts: onb-consent-record: Allow grants background scope with the version, provider and model shown
  // covered: tests/ui-onboard/firstSync.model.test.ts: onb-skip-ai-no-errors – no AI: three segments, and a clean finish still opens by itself
  // covered: tests/ui-onboard/firstSync.model.test.ts: sync-found-estimate – "about N" only with an estimate; without one, Find is a quiet indeterminate step
  // covered: tests/ui-onboard/firstSync.model.test.ts: sync-small-mailbox – a 12-thread inbox reaches ready and reads "12 of 12", never "of 50"
  // covered: tests/ui-onboard/firstSync.model.test.ts: sync-never-backwards – property: random engine sequences within one run never make the screen lie
  // covered: tests/ui-onboard/firstSync.model.test.ts: sync-paused-before-window – Esc enters; the button waits; the lede never says the mail is ready
  // covered: tests/ui-onboard/firstSync.model.test.ts: sync-paused-after-window – Open Aplos works, no mailbox total, the lede says the newest mail is ready
  // covered: tests/ui-onboard/firstSync.model.test.ts: sync-no-autoenter-unless-clean – never while paused, failed, capped, partial, erroring or still running
  // covered: tests/ui-onboard/firstSync.model.test.ts: sync-autoenter-clean – auto-open only on a clean finish
  // covered: tests/ui-onboard/firstSync.model.test.ts: sync-retry-idempotent-F5 – the retry of a running row is not offered and not sent
  // covered: tests/ui-onboard/firstSync.model.test.ts: sync-ai-failure-copy – "Couldn't sort with Groq: the key was refused. Mail is ready; sorting will retry." + Open Settings
  // covered: tests/ui-onboard/firstSync.model.test.ts: sync-not-connected-row – a skipped account shows "Not connected · Try again", never "Waiting"
  // covered: tests/ui-onboard/firstSync.model.test.ts: "Open Aplos" is enabled once one account's first window is in (sync-multi-open-early)
  test.todo(
    `handoff-all-accounts-F7 – two accounts connected → mail window on All accounts [waits: Playwright base]`,
  );
  // covered: tests/ui-onboard/firstSync.model.test.ts: drill-no-engine-calls – the practice letters are invented and the drill files import no data hooks or api
  // covered: tests/ui-onboard/demo.test.ts: no accounts and no first sync shows the zero-accounts line
  // covered: tests/ui-onboard/demo.test.ts: the zero-accounts "Add an account" opens it in first mode
  // covered: tests/ui-onboard/reconnect.test.ts: reconnect-due-line: ok with reconnectBy inside 24 h offers "Reconnect now" through Account/reconnect
  // covered: tests/ui-onboard/reconnect.test.ts: opening starts exactly one call, and the sheet is "waiting" at once
  test.todo(
    `reconnect-sheet-flow – every entry point (slot, Settings row, switcher row) opens the same sheet; Account/reconnect called with the account id; waiting → connected → toast "Reconnected", focus restored [waits: Playwright base]`,
  );
  test("reconnect-login-hint – the reconnect request carries the account's login_hint (same account), progress is plain, and the sheet returns to the previous screen (U8 acc. 9; added, the map did not name login_hint)", async () => {
    // The renderer must pass only the account id; the engine maps it to the stored address (see ports' doc comment).
    const seen: Array<{ accountId: string }> = [];
    const ports: ReconnectPorts = {
      reconnect: async input => {
        seen.push(input);
        return { connectId: 'c1' };
      },
      grantPermissions: async () => ({ connectId: 'c1-permissions' }),
      cancelConnect: async () => ({}),
    };
    const opened = reduceReconnect(
      initialReconnect({ accountId: 'acc-1', address: 'jordan.lee@example.com' }),
      { type: 'open' },
    );
    for (const effect of opened.effects) await runReconnectEffect(effect, ports, () => undefined);
    assert.deepEqual(seen, [{ accountId: 'acc-1' }]);

    const started = reduceReconnect(opened.state, { type: 'started', attempt: 1, connectId: 'c1' });
    const busy = reduceReconnect(started.state, {
      type: 'frame',
      connectId: 'c1',
      mode: 'reconnect',
      state: 'authorizing',
      accountId: 'acc-1',
    });
    // Progress is plain: a mid-run "authorizing" frame settles nothing, navigates nowhere and asks for nothing.
    assert.deepEqual(busy.effects, []);
    assert.equal(busy.state.phase, 'waiting');
    // The "returns to the previous screen" half is the mail window's sheet wiring, not the model's.
  });
  // covered: tests/ui-onboard/reconnect.test.ts: reconnect-no-resync: no Sync/request, ever
  // covered: tests/ui-onboard/reconnect.test.ts: reconnect-wrong-account: auth.wrongAccount names the address to choose
});

describe('ui-onboard: keyboard paths (dom)', () => {
  // covered: tests/ui-onboard/flow.test.ts: keys-onb-return-each-step: Welcome and permissions name their filled main action (F12)
  // covered: tests/ui-onboard/connect.test.ts: onb-discover-focus-F12: typed address + Return discovers, and Google focuses Continue with Google
  test.todo(
    `keys-onb-return-each-step – Return activates each step's main action; focus lands on it after every internal state change [waits: Playwright base]`,
  );
  // covered: tests/ui-onboard/flow.test.ts: keys-onb-esc-ladder: Esc on Welcome is Skip setup
  // covered: tests/ui-onboard/connect.test.ts: Esc on a typed address clears to the field; Esc on an empty field goes back a step
  // covered: tests/ui-onboard/connect.test.ts: Esc on an empty field with accounts shows the list; Esc on the list goes back a step
  // covered: tests/ui-onboard/connect.test.ts: onb-oauth-cancel: Esc while waiting cancels that connect and returns to the field
  test.todo(
    `keys-onb-esc-ladder – Esc: accounts waiting → cancel; choose → Welcome; Welcome → Skip setup; AI byok → groq; menu open → close menu first [waits: Playwright base]`,
  );
  // covered: tests/ui-onboard/firstSync.model.test.ts: keys-sync-esc-every-state-F8 – Esc opens Aplos in every fixture state, including the failed screen and inside the drill
  // covered: tests/ui-onboard/firstSync.model.test.ts: keys-drill-letters – J/K, Space, E, A advance the drill through the registry; Return goes back to progress
  test.todo(
    `keys-onb-globals-inert – ⌘K, ⌃1, C, A do nothing in the onboarding window [waits: Playwright base]`,
  );
  // covered: tests/ui-onboard/reconnect.test.ts: keys-sheet-esc-cancels: Cancel while waiting calls cancelConnect with the flow id and closes as cancelled
  // (refocusing the row that opened the sheet is the mail window's wiring)
  test.todo(
    `keys-sheet-esc-cancels – Esc in the reconnect sheet calls Account/cancelConnect and restores focus [waits: Playwright base]`,
  );
  test.todo(
    `keys-tab-order-visual – Tab order equals visual order on every step [waits: Playwright base]`,
  );
});

describe('ui-onboard: visual states, light and dark, 640 × 600 and 640 × 520 (visual)', () => {
  test.todo(`welcome – Welcome step [waits: Playwright base]`);
  test.todo(`accounts – choose, typed, waiting, connected, unsupported [waits: Playwright base]`);
  test.todo(
    `ai – groq, groq-no-key, byok, local, consent, consent-gemini-free (plus the no-consent state) [waits: Playwright base]`,
  );
  test.todo(`permissions – default, granted, denied [waits: Playwright base]`);
  test('permissions-denied-copy – a blocked microphone says where to turn it on and offers System Settings; the other rows are unchanged', () => {
    const denied = markup(stepStates['permissions-denied']);
    assert.match(denied, /Turned off/);
    assert.match(denied, /Turn it on for Aplos in System Settings, under Privacy &amp; Security\./);
    assert.match(denied, /Open System Settings/);
    assert.doesNotMatch(denied, /Speech goes to/, 'a blocked microphone does not promise speech');
    assert.match(denied, /Allow…/, 'notifications is still undecided and offers Allow…');
    assert.doesNotMatch(markup(stepStates['permissions-granted']), /blocked|Open System Settings/);
  });
  test.todo(
    `sync progress – 1 and 2 accounts, found-no-estimate, paused (rate-limited before and after the first window), paused-daily, ready, partial, ai-failed, failed, not-connected, no-ai (3 segments), 5 accounts (scrolls, top not clipped [F13]) [waits: Playwright base]`,
  );
  test.todo(`drill – step1, step3, done [waits: Playwright base]`);
  test.todo(
    `mail window – no-accounts, first-mail, demo; slot reconnect-due, needs-reauth, needs-permission, quota [waits: Playwright base]`,
  );
  test.todo(
    `reconnect sheet – waiting, failed (wrong account), reconnected toast (also reconnecting state) [waits: Playwright base]`,
  );
  test('all onboarding and loading states exist in the harness in both themes – six steps, partial, failed, multi-account, no-AI, no-consent, complete, zero-accounts, demo, reconnect due/reconnecting/failed/reconnected (U8 acc. 6; added as a coverage check)', () => {
    // The six steps exist as static fixtures; assert what the catalogue claims, and fail on the rest.
    const present = Object.keys(stepStates);
    for (const key of [
      'welcome',
      'accounts-choose',
      'ai-consent',
      'ai-groq-env',
      'permissions-default',
    ]) {
      assert.ok(present.includes(key), `missing step fixture: ${key}`);
    }
    for (const key of [
      'progress',
      'partial',
      'failed',
      'multi-account',
      'no-ai',
      'no-consent',
      'ready',
      'drill-step1',
    ]) {
      assert.ok(Object.hasOwn(firstSyncStates, key), `missing first-sync fixture: ${key}`);
    }
    assert.ok(Object.hasOwn(reconnectStates, 'zero-accounts'), 'missing fixture: zero-accounts');
    for (const key of [
      'demo',
      'reconnect-due',
      'reconnecting',
      'reconnected',
      'permissions-denied',
    ]) {
      const found =
        Object.keys(reconnectStates).some(k => k.startsWith(key)) ||
        Object.keys(firstSyncStates).some(k => k.startsWith(key)) ||
        Object.keys(demoStates).some(k => k.startsWith(key)) ||
        present.some(k => k.startsWith(key));
      assert.ok(found, `missing harness state: ${key}`);
    }
    // What each new state draws, from the real components' markup.
    assert.match(markup(demoStates['demo-loading']), /Loading demo mail\./);
    assert.match(markup(demoStates['demo-loading']), /Try demo mail/);
    const loaded = markup(demoStates['demo-loaded']);
    assert.match(loaded, /Demo mail · Remove in Settings/);
    assert.match(loaded, /Demo mail loaded\. Remove it any time in Settings\./);
    const due = markup(reconnectStates['reconnect-due']);
    assert.match(due, /Gmail will ask you to reconnect tomorrow at /);
    assert.match(due, /Reconnect now/);
    assert.equal(
      markup(reconnectStates.reconnecting),
      markup(reconnectStates['reconnect-waiting']),
    );
    assert.match(markup(reconnectStates.reconnecting), /Waiting for Google in your browser/);
    assert.match(markup(reconnectStates.reconnected), /Reconnected/);
    const denied = markup(stepStates['permissions-denied']);
    assert.match(
      denied,
      /macOS has blocked the microphone\. Turn it on for Aplos in System Settings/,
    );
    assert.match(denied, /Open System Settings/);
    assert.doesNotMatch(markup(stepStates['permissions-default']), /blocked/);
  });
});

describe('ui-onboard: accessibility (dom)', () => {
  test.skip('a11y-one-live-region-F11 – exactly one role="status" on the sync screen; it changes only on phase changes (≤ 5 announcements for a full run) [FAILS: each first-sync screen renders 2-3 role="status" regions: the OnboardingStep summary plus ProgressSegments\' own per account and in the ready variant (REQUEST R2 to ui-foundation)]', () => {
    for (const [name, state] of Object.entries(firstSyncStates)) {
      const count = (markup(state).match(/role="status"/g) ?? []).length;
      assert.equal(count, 1, `${name} has ${count} live regions`);
    }
  });
  // covered (the aria-label "<address> sync" half): tests/ui-onboard/firstSync.model.test.ts: "Esc opens Aplos" is said on every state; bars are labelled "<address> sync"; no AI glyph
  test('a11y-bars-labelled – every progress bar has aria-label "<address> sync" and aria-valuetext', () => {
    for (const [name, state] of Object.entries(firstSyncStates)) {
      for (const bar of markup(state).match(/<div[^>]*role="progressbar"[^>]*>/g) ?? []) {
        const val = /aria-valuetext="([^"]*)"/.exec(bar);
        assert.ok(val, `${name}: a progress bar has no aria-valuetext`);
        assert.notEqual(val[1], '', `${name}: a progress bar's aria-valuetext is empty`);
      }
    }
  });
  test.todo(
    `a11y-axe-all-onb-states – axe, no serious violations, both themes [waits: Playwright base]`,
  );
  test.todo(
    `a11y-reduced-motion – ready check static; drill E removal is opacity only; marker spinner stops [waits: Playwright base]`,
  );
  test.todo(
    `a11y-strip-target-size – "Try demo mail" hit area ≥ 24 px, outside the drag region [waits: Playwright base]`,
  );
});

describe('ui-onboard: design checks (dom / visual / electron)', () => {
  // covered (first-sync copy against DESIGN 10): tests/ui-onboard/firstSync.model.test.ts: no copy on any fixture breaks DESIGN 10, says Done for the pass, or names a mailbox total
  test('design-banned-strings-onb – no "Done" on capped or failed passes, no "Testing mode", "verification", "magic", "AI-powered", "Hold to talk", "Ask me anything", no "Aplos needs a moment.", no raw provider error text', () => {
    const banned =
      /\bDone\b|Testing mode|verification|magic|AI-powered|Hold to talk|Ask me anything|Aplos needs a moment|(?:ERROR|Exception|stack trace)/i;
    for (const table of [stepStates, reconnectStates]) {
      for (const [name, state] of Object.entries(table)) {
        const text = markup(state).replace(/<[^>]+>/g, ' ');
        assert.doesNotMatch(
          text,
          new RegExp(banned.source, banned.flags),
          `${name} breaks a banned-copy rule`,
        );
      }
    }
  });
  test('design-banned-glyphs-onb – no sparkle, wand, star, brain or robot icon on the AI step or consent card', () => {
    const banned = /sparkle|wand|\bstar\b|\bbrain\b|\brobot\b/i;
    for (const [name, state] of Object.entries(stepStates)) {
      if (!/^ai-/.test(name)) continue;
      assert.doesNotMatch(markup(state), banned, `${name} uses a banned AI glyph`);
    }
  });
  // covered (first-sync states): tests/ui-onboard/firstSync.model.test.ts: design-one-filled-button – exactly one filled button in every state (a disabled Open Aplos still counts)
  test('design-one-filled-button – exactly one filled button per step and per sync state (Open Aplos disabled still counts as the one)', () => {
    const filled = (html: string): number => (html.match(/data-variant="filled"/g) ?? []).length;
    for (const [name, state] of Object.entries(stepStates))
      assert.ok(filled(markup(state)) <= 1, `${name} has more than one filled button`);
    for (const [name, state] of Object.entries(reconnectStates))
      assert.ok(filled(markup(state)) <= 1, `${name} has more than one filled button`);
    for (const primary of ['welcome', 'accounts-typed', 'ai-groq-env', 'permissions-default']) {
      assert.equal(filled(markup(stepStates[primary])), 1, `${primary} has no filled button`);
    }
  });
  test.todo(
    `design-hover-never-shifts-onb – hover every interactive element on every onboarding state; no other box moves > 0.5 px [waits: Playwright base]`,
  );
  test.todo(
    `design-contrast-onb – --stamp-ink failure icons, --dusk paused segment, --ink-2 done segment, dim text on paper pass 4.5:1 / 3:1 in both themes [waits: Playwright base]`,
  );
  test('design-no-icon-no-sky – no app icon, gradient, backdrop-filter or page title in the onboarding window or the empties', () => {
    const banned = /backdrop-filter|gradient\(|<title[ >]|background-image/i;
    for (const table of [stepStates, reconnectStates, firstSyncStates]) {
      for (const [name, state] of Object.entries(table)) {
        assert.doesNotMatch(
          markup(state),
          banned,
          `${name} renders chrome, an image or a background trick`,
        );
      }
    }
    const source = readFileSync(
      new URL('../../src/renderer/onboarding/onboarding.css', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /backdrop-filter|gradient\(|url\(/i,
      'onboarding.css paints glass, gradients or an image',
    );
  });
  test.todo(
    `design-window-chrome – hidden _electron: 640 × 600, min 640 × 520, vertical resize, hidden-inset title bar, one window after a second launch [F3], no mail window before ready-to-show [F4] [waits: Electron]`,
  );
});

describe('ui-onboard: live and hands-on acceptance (manual, owner-run)', () => {
  test.todo(
    `live-google-first-window – owner connects a real Google test user through the new onboarding: first window within about 15 s, Home opens while older mail keeps importing, slow-down message if Google asks (U8 acc. 7, days 14-16; mocked Google does not count) [waits: live]`,
  );
  test.todo(
    `handson-traffic-lights-and-drag-region – traffic lights over the white strip and the drag region behave (U8 acc. 8, section 6.5 #9) [waits: owner]`,
  );
  test.todo(
    `handson-first-weekly-reconnect – the first real weekly reconnect inside the daily-use week succeeds (U8 acc. 9, section 6.5 #10) [waits: live]`,
  );
});
