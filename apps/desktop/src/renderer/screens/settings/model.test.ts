// Run: npx tsx --test 'src/renderer/screens/settings/**/*.test.{ts,tsx}'   (from apps/desktop)
// The pure layer of Settings: the reconnect rule, the one filled button, key sources, consent, the cap, demo controls
// and the keyboard model. No DOM; the clock is the harness clock, passed in.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  accountRows,
  backgroundPlan,
  capNote,
  capPatch,
  capSelection,
  cascadeChoice,
  consentView,
  demoControls,
  featureRows,
  featurePatch,
  hostedRows,
  inversePatch,
  keySourceLine,
  leaseLine,
  localRows,
  mergePatch,
  navItems,
  notifyRows,
  queueRows,
  reconnectKind,
  removeDisabledReason,
  removeKeyConfirm,
  toKeySource,
  UNDO_SEND_SECONDS,
  versionLine,
  aiNotices,
} from './settings.model';
import { createAppRegistry, DEFAULT_KEY_PREFS, formatChord } from '../../commands';
import { applyRemap, judgeChord, resetKeys, shortcutGroups } from './keyboard.model';
import {
  account,
  ALEX,
  baseSettings,
  consent,
  DEMO,
  JORDAN,
  models,
  needsReauth,
  NOW,
  providers,
  queue,
  reconnectIn,
  usage,
} from './preview/fixtures';

const HOUR = 3_600_000;
const ui = (keymap = {}, swipeDirection: 'doneRight' | 'doneLeft' = 'doneRight') => ({
  keymap,
  singleKeys: true,
  holdMs: 250,
  swipeDirection,
});

describe('reconnect rule (DESIGN 7.10, U7 acceptance 8)', () => {
  test('needsReauth and needsPermission always offer Reconnect', () => {
    assert.equal(reconnectKind(needsReauth(ALEX), NOW), 'reauth');
    const perm = {
      ...ALEX,
      health: { status: { state: 'needsPermission' as const, missingScopes: [] } },
    };
    assert.equal(reconnectKind(perm, NOW), 'permission');
    assert.equal(accountRows([perm], NOW)[0].reconnect?.mode, 'grant');
  });

  test('reconnectBy inside 24 h shows "Reconnect now"; at 24 h exactly still shows; just past 24 h does not', () => {
    assert.equal(reconnectKind(reconnectIn(ALEX, 20 * HOUR), NOW), 'due');
    assert.equal(reconnectKind(reconnectIn(ALEX, 24 * HOUR), NOW), 'due');
    assert.equal(reconnectKind(reconnectIn(ALEX, 24 * HOUR + 1), NOW), null);
    assert.equal(reconnectKind(reconnectIn(ALEX, 25 * HOUR), NOW), null);
    const row = accountRows([reconnectIn(ALEX, 20 * HOUR)], NOW)[0];
    assert.equal(row.reconnect?.label, 'Reconnect now');
    assert.match(
      row.description,
      /^Gmail will ask you to reconnect (today|tomorrow) at \d{1,2}:\d{2} (AM|PM)\.$/,
    );
  });

  test('a deadline already past reads as an expired sign-in', () => {
    const row = accountRows([reconnectIn(ALEX, -HOUR)], NOW)[0];
    assert.equal(row.reconnect?.label, 'Reconnect');
    assert.equal(row.description, 'Google needs you to sign in again.');
    assert.equal(row.tone, 'attention');
  });

  test('the same rule moves with the clock it is given (harness clock, not Date.now)', () => {
    const a = reconnectIn(ALEX, 30 * HOUR);
    assert.equal(reconnectKind(a, NOW), null);
    assert.equal(reconnectKind(a, NOW + 7 * HOUR), 'due');
  });

  test('demo accounts never ask to reconnect', () => {
    assert.equal(
      reconnectKind({ ...DEMO, health: { ...DEMO.health, reconnectBy: NOW + HOUR } }, NOW),
      null,
    );
  });

  test('only the first account that needs a sign-in gets the filled button; "Reconnect now" is always text', () => {
    const two = accountRows([needsReauth(ALEX), needsReauth(JORDAN)], NOW);
    assert.deepEqual(
      two.map(r => r.reconnect?.filled),
      [true, false],
    );
    const mixed = accountRows([reconnectIn(ALEX, HOUR), needsReauth(JORDAN)], NOW);
    assert.deepEqual(
      mixed.map(r => r.reconnect?.filled),
      [false, true],
    );
    const due = accountRows([reconnectIn(ALEX, HOUR)], NOW);
    assert.equal(due[0].reconnect?.filled, false);
    assert.equal(accountRows([ALEX], NOW)[0].reconnect, undefined);
  });

  test('a healthy account says "Connected · synced 2 min ago"; a missing calendar permission has its own sentence', () => {
    assert.equal(accountRows([ALEX], NOW)[0].description, 'Connected · synced 2 min ago');
    const cal = {
      ...ALEX,
      health: {
        status: { state: 'needsPermission' as const, missingScopes: ['calendar'] },
        reasonCode: 'permission.calendar',
      },
    };
    assert.equal(
      accountRows([cal], NOW)[0].description,
      'Aplos needs permission to use your Google Calendar.',
    );
  });

  test('a needsPermission with reasonCode permission.calendarWrite has its own sentence', () => {
    const cal = {
      ...ALEX,
      health: {
        status: { state: 'needsPermission' as const, missingScopes: ['calendar.events'] },
        reasonCode: 'permission.calendarWrite',
      },
    };
    assert.equal(
      accountRows([cal], NOW)[0].description,
      'Aplos needs your permission to change events on your Google Calendar.',
    );
  });

  test('a refused write alone is not a needs-reconnect account: no Reconnect, no nag line', () => {
    const refused = {
      ...ALEX,
      missingPermissions: [
        { capability: 'calendarWrite' as const, reasonCode: 'permission.calendarWrite' as const },
      ],
    };
    const row = accountRows([refused], NOW)[0];
    assert.equal(row.reconnect, undefined);
    assert.equal(row.tone, 'default');
    assert.equal(row.description, 'Connected · synced 2 min ago');
  });

  test('one name per account, a provider word only for Google and demo', () => {
    const r = accountRows(
      [ALEX, DEMO, account({ id: 'x', address: 'a@example.com', provider: 'imap' })],
      NOW,
    );
    assert.deepEqual(
      r.map(x => x.meta),
      ['Google', 'Demo', ''],
    );
  });
});

describe('demo controls (gap list decision 9)', () => {
  test('a demo row has Reset and Remove; Help offers Load only with no demo account', () => {
    assert.deepEqual(demoControls([ALEX, DEMO]), {
      hasDemo: true,
      rowActions: ['reset', 'remove'],
      helpAction: null,
    });
    assert.deepEqual(demoControls([ALEX]), { hasDemo: false, rowActions: [], helpAction: 'load' });
  });
});

describe('background work lease', () => {
  test('names the holder and offers the one action that applies', () => {
    assert.deepEqual(leaseLine(ALEX, 'MacBook Pro'), { text: 'Syncs on this Mac', action: null });
    const away = { lease: { role: 'secondary' as const, holderDeviceName: 'MacBook Air' } };
    assert.deepEqual(leaseLine(away, 'MacBook Pro'), {
      text: 'Syncs on another Mac',
      action: 'use',
    });
    assert.equal(leaseLine(away, 'MacBook Pro', true).text, 'Syncs on another Mac · MacBook Air');
    assert.equal(leaseLine(ALEX, 'MacBook Pro', true).text, 'Syncs on this Mac · MacBook Pro');
    const pinned = { lease: { role: 'primary' as const, pinned: true } };
    assert.equal(leaseLine(pinned, 'MacBook Pro').action, 'auto');
  });
});

describe('AI: key source, Remove, providers', () => {
  const [groq, openai, claude] = providers();
  test('key source line never carries a key', () => {
    assert.equal(keySourceLine(groq), 'Key set on this Mac');
    assert.equal(keySourceLine(groq, true), 'Key set on this Mac · GROQ_API_KEY');
    assert.equal(keySourceLine(openai), 'Saved in Keychain');
    assert.equal(keySourceLine(claude), 'No key yet');
    assert.equal(keySourceLine(claude, true), 'No key yet · reads ANTHROPIC_API_KEY');
    const poisoned = { ...groq, apiKey: 'gsk_SECRET', last4: 'CRET' } as typeof groq;
    assert.doesNotMatch(
      JSON.stringify([keySourceLine(poisoned), toKeySource(poisoned)]),
      /SECRET|CRET/,
    );
  });

  test('Remove is disabled for a key from the environment, with the reason; a saved key can be removed', () => {
    assert.equal(
      removeDisabledReason(toKeySource(groq)),
      'This key is set outside Aplos, so it can only be removed where it was set.',
    );
    assert.equal(
      removeDisabledReason(toKeySource(groq, true)),
      'This key comes from GROQ_API_KEY in your environment. Remove it there.',
    );
    assert.equal(removeDisabledReason(toKeySource(openai)), undefined);
    assert.equal(removeDisabledReason(toKeySource(claude)), undefined);
  });

  test('hosted group order, Groq is the default; local group order', () => {
    const hosted = hostedRows(providers());
    assert.deepEqual(
      hosted.map(r => r.provider),
      ['groq', 'openai', 'anthropic', 'gemini', 'openrouter', 'opencode-go'],
    );
    assert.deepEqual(
      hosted.map(r => r.isDefault),
      [true, false, false, false, false, false],
    );
    assert.deepEqual(
      localRows(providers(), baseSettings()).map(r => r.provider),
      ['ollama', 'lmstudio', 'custom'],
    );
  });

  test('local rows: running or not, optional key only for a custom server, address is what was typed', () => {
    const rows = localRows(providers(), baseSettings());
    assert.equal(rows[0].keySource?.kind, 'local');
    // Not running is a quiet status until the owner presses Test; red follows a failed Test only.
    assert.equal(rows[1].status?.kind, 'notRunning');
    assert.equal(rows[2].keySource?.kind, 'none');
    assert.equal(rows[0].address, '');
    assert.equal(rows[0].defaultAddress, 'http://localhost:11434/v1');
  });

  test('a live test result replaces the engine status', () => {
    const rows = hostedRows(providers(), {
      openai: { kind: 'testing' },
      groq: { kind: 'works', latencyMs: 400 },
    });
    assert.equal(rows[0].status.kind, 'works');
    assert.equal(rows[1].status.kind, 'testing');
  });

  test('Voice lists exactly Groq and OpenAI; mail features never list a provider that trains on inputs', () => {
    const settings = baseSettings();
    const withGemini = providers().map(p =>
      p.id === 'gemini' ? { ...p, status: 'ready', keySource: 'keychain' } : p,
    );
    const rows = featureRows(settings, withGemini, models());
    const voice = rows.find(r => r.feature === 'voice')!;
    assert.deepEqual([...voice.providerOptions], ['groq', 'openai']);
    for (const r of rows.filter(r => r.feature !== 'voice'))
      assert.ok(!r.providerOptions.includes('gemini'));
    assert.ok(rows.find(r => r.feature === 'ask')!.providerOptions.includes('ollama'));
    assert.deepEqual([...voice.modelOptions], ['whisper-large-v3-turbo', 'whisper-large-v3']);
  });

  test('changing a provider resets the model to its first one and writes both fields; no model means no change', () => {
    const settings = baseSettings();
    const next = cascadeChoice(
      'ask',
      { provider: 'openai', model: 'ignored' },
      settings.ai.features.ask,
      models(),
    );
    assert.deepEqual(next, { provider: 'openai', model: 'gpt-5-mini' });
    const voice = cascadeChoice(
      'voice',
      { provider: 'openai', model: 'x' },
      settings.ai.features.voice,
      models(),
    );
    assert.equal(voice?.model, 'gpt-4o-transcribe');
    assert.equal(
      cascadeChoice(
        'ask',
        { provider: 'lmstudio', model: 'x' },
        settings.ai.features.ask,
        models(),
      ),
      null,
    );
    const patch = featurePatch(settings, 'ask', next!);
    assert.equal(patch.ai?.features?.ask.provider, 'openai');
    assert.equal(patch.ai?.features?.summaries.provider, 'groq');
  });

  test('notices: one quiet line when nothing can answer; none when something can', () => {
    assert.deepEqual(aiNotices(baseSettings(), providers()), []);
    const none = providers().map(p => ({ ...p, status: 'missingKey', running: false }));
    const notices = aiNotices(baseSettings(), none);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].id, 'noProvider');
  });

  test('notices: an empty provider list still gets the no-provider line', () => {
    const notices = aiNotices(baseSettings(), []);
    assert.deepEqual(
      notices.map(n => n.id),
      ['noProvider'],
    );
    assert.match(notices[0].text, /No AI provider is set up/);
  });

  test('an unknown stored provider id passes through to the picker instead of becoming Groq', () => {
    const settings = baseSettings();
    const weird = {
      ...settings,
      ai: {
        ...settings.ai,
        features: {
          ...settings.ai.features,
          ask: { provider: 'nimbus' as never, model: 'n-1' },
        },
      },
    };
    const row = featureRows(weird, providers(), models()).find(r => r.feature === 'ask')!;
    assert.equal(row.provider, 'nimbus');
  });

  test('removing a key names the features that will stop', () => {
    const c = removeKeyConfirm(baseSettings(), 'groq');
    assert.match(c.consequence, /Ask, Summaries, Drafts, Plans and Voice will stop/);
    assert.match(removeKeyConfirm(baseSettings(), 'openai').consequence, /^The key is deleted/);
  });
});

describe('consent re-review and the background switch', () => {
  test('a changed provider or model needs the card again; a withdrawn consent is off', () => {
    const s = baseSettings();
    assert.deepEqual(consentView(consent(), s), { state: 'granted' });
    assert.deepEqual(consentView(consent({ needsReconsent: true }), s), {
      state: 'review',
      provider: 'groq',
      model: 'openai/gpt-oss-20b',
    });
    assert.deepEqual(consentView(consent({ granted: false }), s), { state: 'off' });
  });

  test('turning the switch on needs the card unless consent stands; off also withdraws consent', () => {
    assert.deepEqual(backgroundPlan(consent(), true), ['enable']);
    assert.deepEqual(backgroundPlan(consent({ needsReconsent: true }), true), ['openCard']);
    assert.deepEqual(backgroundPlan(consent({ granted: false }), true), ['openCard']);
    assert.deepEqual(backgroundPlan(consent(), false), ['disable', 'revoke']);
  });
});

describe('daily cap (ARCH 8.4, Decision 13)', () => {
  test('tokens, 150,000 by default; "No limit" turns it off; the unit is never requests', () => {
    const s = baseSettings();
    assert.equal(capSelection(s.ai.dailyCap), '150000');
    assert.deepEqual(capPatch(s, 'none').ai?.dailyCap, { enabled: false, tokens: 150_000 });
    assert.deepEqual(capPatch(s, '300000').ai?.dailyCap, { enabled: true, tokens: 300_000 });
    assert.equal(capSelection({ enabled: false, tokens: 150_000 }), 'none');
  });

  test('"Paused for today. Resumes tomorrow." only when paused or spent', () => {
    assert.equal(capNote(usage(), NOW), undefined);
    assert.equal(
      capNote(usage({ pausedUntil: NOW + HOUR }), NOW),
      'Paused for today. Resumes tomorrow.',
    );
    assert.equal(
      capNote(usage({ backgroundTokens: 150_000 }), NOW),
      'Paused for today. Resumes tomorrow.',
    );
    assert.equal(capNote(usage({ pausedUntil: NOW - HOUR }), NOW), undefined);
  });
});

describe('patches, nav, copy', () => {
  test('mergePatch replaces fields per section; inversePatch puts them back', () => {
    const s = baseSettings();
    const patch = {
      mail: { undoSendSeconds: 20 },
      ui: { keymap: { 'mail.done': [{ chord: 'l' }] } },
    };
    const merged = mergePatch(s, patch);
    assert.equal(merged.mail.undoSendSeconds, 20);
    assert.equal(merged.mail.followUpDays, 3);
    assert.deepEqual(mergePatch(merged, inversePatch(s, patch)), s);
  });

  test('undo send options are exactly 0, 5, 8, 10, 20 and 30', () => {
    assert.deepEqual([...UNDO_SEND_SECONDS], [0, 5, 8, 10, 20, 30]);
  });

  test('eight sections in DESIGN order; AI is the speech bubble', () => {
    const items = navItems();
    assert.deepEqual(
      items.map(i => i.label),
      [
        'General',
        'Mail',
        'Calendar',
        'AI',
        'Notifications',
        'Accounts',
        'Keyboard',
        'Help & about',
      ],
    );
    assert.equal(items.find(i => i.id === 'ai')?.icon, 'bubble');
  });

  test('the version line names the channel and build; no git falls back to "dev"', () => {
    const build = { commit: 'abc1234', channel: 'revamp' };
    assert.equal(
      versionLine({ appVersion: '0.3.0' }, build),
      'Version 0.3.0-revamp (build abc1234) · macOS',
    );
    assert.equal(
      versionLine({ appVersion: '0.3.0' }, { commit: 'abc1234', channel: '' }),
      'Version 0.3.0 (build abc1234) · macOS',
    );
    assert.equal(versionLine({ appVersion: '0.3.0' }), 'Version 0.3.0 (build dev) · macOS');
    assert.equal(versionLine({} as never), 'macOS');
    assert.equal(versionLine(undefined), 'macOS');
  });

  test('an account has one colour in Accounts and Notifications (one index source)', () => {
    const untagged = [ALEX, DEMO, JORDAN].map(a => ({ ...a, colorTag: undefined }));
    const marks = new Map(accountRows(untagged, NOW).map(r => [r.id, r.mark]));
    for (const r of notifyRows(untagged)) {
      assert.equal(r.mark, marks.get(r.id), r.id);
    }
  });

  test('the queue shows reason sentences, never the item message', () => {
    const rows = queueRows(queue());
    assert.deepEqual(
      rows.map(r => r.kind),
      ['Change', 'AI job', 'Message'],
    );
    assert.equal(rows[0].problem, 'Google asked us to slow down.');
    assert.doesNotMatch(JSON.stringify(rows), /PROVIDER SAYS|example\.com/);
    assert.deepEqual(
      rows.map(r => r.confirmDiscard),
      [false, false, true],
    );
  });
});

describe('Keyboard model', () => {
  test('every command with a tap key appears once, in a group', () => {
    const rows = shortcutGroups(ui()).flatMap(g => g.rows);
    const ids = rows.map(r => r.commandId);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(rows.find(r => r.commandId === 'mail.done')!.chords.includes('e'));
    assert.deepEqual(
      shortcutGroups(ui())
        .map(g => g.group)
        .slice(0, 3),
      ['Lists and Home', 'Reader', 'Compose'],
    );
  });

  test('the quiet ⌘Z is not listed beside Z, and stays out of hints after a remap', () => {
    const undo = shortcutGroups(ui())
      .flatMap(g => g.rows)
      .find(r => r.commandId === 'app.undo')!;
    assert.deepEqual(undo.chords, ['z']);
    assert.equal(createAppRegistry().describeKeys('app.undo'), 'Z');
    const keymap = { 'app.undo': [{ chord: 'meta+z' }] };
    const registry = createAppRegistry();
    registry.configure({ ...DEFAULT_KEY_PREFS, keymap });
    assert.equal(registry.describeKeys('app.undo'), '', 'a quiet default stays quiet when stored');
  });

  test('pressing L while remapping Done shows "Already used by Later"; replace moves it; the store holds overrides only', () => {
    const verdict = judgeChord('mail.done', 'l', ui());
    assert.deepEqual(verdict, {
      kind: 'conflict',
      with: { commandId: 'mail.later', label: 'Later' },
    });
    const km = applyRemap(ui(), 'mail.done', 'l', { commandId: 'mail.later' });
    assert.deepEqual(Object.keys(km).sort(), ['mail.done', 'mail.later']);
    assert.deepEqual(
      km['mail.done'].map(b => b.chord),
      ['l', 'ArrowRight'],
    );
    assert.deepEqual(
      km['mail.later'].map(b => b.chord),
      ['ArrowLeft'],
    );
  });

  test('a free key is taken at once; a remap back to the default drops the override', () => {
    assert.equal(judgeChord('mail.done', 'meta+shift+9', ui()).kind, 'ok');
    const km = applyRemap(ui(), 'mail.done', 'meta+shift+9');
    assert.deepEqual(
      km['mail.done'].map(b => b.chord),
      ['meta+shift+9', 'ArrowRight'],
    );
    assert.deepEqual(applyRemap(ui(km), 'mail.done', 'e'), {});
  });

  test('with the triage arrows swapped, remapping Done stores the catalog chord and keeps the swapped arrow', () => {
    const swapped = ui({}, 'doneLeft');
    const row = shortcutGroups(swapped)
      .flatMap(g => g.rows)
      .find(r => r.commandId === 'mail.done')!;
    assert.deepEqual(row.chords, ['e', 'ArrowRight']);
    assert.deepEqual(row.shown, ['e', 'ArrowLeft']);
    assert.equal(judgeChord('mail.done', 'y', swapped).kind, 'ok');
    const km = applyRemap(swapped, 'mail.done', 'y');
    assert.deepEqual(
      km['mail.done'].map(b => b.chord),
      ['y', 'ArrowRight'],
    );
    const registry = createAppRegistry({
      ...DEFAULT_KEY_PREFS,
      swapTriageArrows: true,
      keymap: km,
    });
    assert.deepEqual(registry.keymapIssues, []);
    const keys = registry
      .keysFor('mail.done', ['global', 'list', 'home'])
      .map(b => formatChord(b.chord));
    assert.ok(keys.includes('←') && keys.includes('Y'), keys.join());
    const remapped = shortcutGroups(ui(km, 'doneLeft'))
      .flatMap(g => g.rows)
      .find(r => r.commandId === 'mail.done')!;
    assert.deepEqual(remapped.shown, ['y', 'ArrowLeft']);
    assert.deepEqual(applyRemap(ui(km, 'doneLeft'), 'mail.done', 'e'), {});
  });

  test('reserved chords are refused with a reason that never names a command id', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['meta+q', '⌘Q belongs to macOS, so it can’t be a shortcut. Press other keys.'],
      ['meta+c', '⌘C edits text, so it can’t be a shortcut. Press other keys.'],
      ['Tab', 'Tab moves focus between regions, so it can’t be a shortcut. Press other keys.'],
      ['meta+w', '⌘W belongs to macOS, so it can’t be a shortcut. Press other keys.'],
      ['meta+h', '⌘H belongs to macOS, so it can’t be a shortcut. Press other keys.'],
    ];
    for (const [chord, sentence] of cases) {
      const v = judgeChord('mail.done', chord, ui());
      assert.equal(v.kind, 'refused', chord);
      assert.equal((v as { text: string }).text, sentence, chord);
      assert.doesNotMatch((v as { text: string }).text, /\b[a-z]+\.[a-zA-Z]+\b/, chord);
    }
  });

  test('a stale reserved chord elsewhere in a saved remap never blames the key just pressed', () => {
    const stale = ui({ 'mail.done': [{ chord: 'meta+k' }, { chord: 'meta+c' }] });
    const v = judgeChord('mail.done', 'meta+j', stale);
    assert.equal(v.kind, 'refused');
    const text = (v as { text: string }).text;
    assert.equal(text, 'That shortcut holds a key that can’t be used. Reset it and try again.');
    assert.doesNotMatch(text, /⌘J|meta/);
  });

  test('a saved clash shows "Same keys as …" on the row; Reset removes one override, Reset all clears them', () => {
    const km = { 'mail.laneDown': [{ chord: 'meta+j' }] };
    const row = shortcutGroups(ui(km))
      .flatMap(g => g.rows)
      .find(r => r.commandId === 'mail.laneDown')!;
    assert.equal(row.changed, true);
    assert.deepEqual(row.chords, ['meta+j']);
    assert.equal(row.conflictWith?.commandId, 'ask.toggleDock');
    assert.deepEqual(resetKeys(km, 'mail.laneDown'), {});
    assert.deepEqual(resetKeys({ ...km, 'mail.done': [{ chord: 'l' }] }), {});
  });

  test('a hold-only command is not offered for remapping', () => {
    const ids = shortcutGroups(ui()).flatMap(g => g.rows.map(r => r.commandId));
    assert.ok(!ids.includes('mail.dictateReply'));
    assert.ok(!ids.includes('ask.dictate'));
  });
});
