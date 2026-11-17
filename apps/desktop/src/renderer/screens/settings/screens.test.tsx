// Run: npx tsx --test 'src/renderer/screens/settings/**/*.test.{ts,tsx}'   (from apps/desktop)
// Every Settings state rendered once, as markup: the palette reaches every row (U7 acceptance 2), no key or provider
// text ever appears (U7 acceptance 3), copy and glyph rules, one filled button, and the write-only key flow.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SETTING_SECTIONS, createAppRegistry, settingId } from '../../commands';
import { APP_SETTINGS, copyProblem } from '../../commands/internal';
import { createController } from './controller';
import { anchorScroll, scrollWithoutTarget } from './SettingsScreen';
import { SETTING_ROWS } from './paletteEntries';
import type { SettingsApiPort, WriteFailure } from './ports';
import { AddKeyDialog } from './overlays';
import { CANARY, ALEX } from './preview/fixtures';
import { dataOf, HOST, STATES, staticScreen, withCanary } from './preview/states';
import { INITIAL_VIEW } from './view';

const render = (name: string, canary = false): string => {
  const spec = STATES[name];
  return renderToStaticMarkup(
    staticScreen(canary ? { ...spec, data: withCanary(spec.data) } : spec),
  );
};
const names = Object.keys(STATES);

const decode = (s: string) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
const lines = (markup: string): string[] => [
  ...[...markup.matchAll(/(?:aria-label|title|placeholder)="([^"]*)"/g)].map(m => decode(m[1])),
  ...markup
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map(t => decode(t.trim()))
    .filter(Boolean),
];
const anchorsIn = (markup: string): Set<string> => {
  const found = new Set<string>();
  for (const m of markup.matchAll(/data-setting-anchor="([^"]+)" data-setting-section="([^"]+)"/g))
    found.add(settingId(m[2] as never, m[1]));
  return found;
};

describe('every row is reachable from the palette (U7 acceptance 2)', () => {
  test('every rendered anchor has a registerSetting entry, in every state', () => {
    for (const name of names) {
      for (const id of anchorsIn(render(name)))
        assert.ok(APP_SETTINGS.get(id), `${name}: ${id} has no registerSetting entry`);
    }
  });

  test('no SettingRow is rendered outside an anchor (checked by walking the markup)', () => {
    for (const name of names) {
      const markup = render(name);
      const tokens = markup.split(/(<div[^>]*>|<\/div>)/);
      const stack: boolean[] = [];
      for (const t of tokens) {
        if (t.startsWith('<div')) stack.push(t.includes('data-setting-anchor='));
        else if (t === '</div>') stack.pop();
        if (t.startsWith('<div') && t.includes('class="ui-setting-row"')) {
          assert.ok(stack.some(Boolean), `${name}: a SettingRow has no palette anchor`);
        }
      }
    }
  });

  test('every manifest entry is rendered by at least one state, and every rendered anchor is in the manifest', () => {
    const rendered = new Set<string>();
    for (const name of names) for (const id of anchorsIn(render(name))) rendered.add(id);
    const manifest = new Set(SETTING_ROWS.map(r => settingId(r.section, r.anchor)));
    for (const id of manifest)
      assert.ok(rendered.has(id), `${id} is registered but no state draws it`);
    for (const id of rendered)
      assert.ok(manifest.has(id), `${id} is drawn but not in the manifest`);
  });

  test("the registry lists every row in the palette's Settings group with a deep link", () => {
    const registry = createAppRegistry();
    const listed = registry.settings();
    assert.equal(listed.length, SETTING_ROWS.length);
    const entry = listed.find(e => e.id === 'setting.mail.undoSend')!;
    assert.equal(entry.label, 'Undo send');
    const ctx = {
      stack: ['global'],
      target: null,
      selection: [],
      conditions: {},
      focus: 'none',
      prefs: undefined,
    } as never;
    const result = registry.run('setting.mail.undoSend', ctx);
    assert.deepEqual(result, { status: 'navigate', route: 'settings/mail#undoSend' });
  });

  test('every section has rows in the manifest', () => {
    for (const s of SETTING_SECTIONS)
      assert.ok(
        SETTING_ROWS.some(r => r.section === s.id),
        s.id,
      );
  });
});

describe('secrets never reach the screen (U7 acceptance 3)', () => {
  test('a canary planted in provider, account, settings and client data appears nowhere in any state', () => {
    for (const name of names) {
      const markup = render(name, true);
      assert.ok(!markup.includes(CANARY), `${name}: the canary key is in the markup`);
      assert.ok(!markup.includes('CANARY'), `${name}: part of the canary is in the markup`);
      assert.doesNotMatch(markup, /••••|last4|gsk_|\bsk-/i, name);
    }
  });

  test("a queue item's provider text and a diagnostics bundle hold nothing from mail", () => {
    for (const name of ['queue-inspector', 'diagnostics-preview', 'help']) {
      const markup = render(name);
      assert.doesNotMatch(markup, /PROVIDER SAYS|userRateLimitExceeded/, name);
    }
    const dialog = render('diagnostics-preview');
    assert.match(dialog, /Export diagnostics/);
    assert.match(dialog, />Copy report</);
    assert.match(dialog, /puts it on your clipboard/);
    assert.match(dialog, />Save report</);
    assert.match(dialog, /a1b2c3d4/); // the salted hash, short
    assert.doesNotMatch(dialog, /alex\.moreno@example\.com/);
  });

  test('a key goes to the engine once and is kept nowhere: not in view state, data, or any later markup', async () => {
    const calls: [string, string][] = [];
    let view = { ...INITIAL_VIEW };
    let data = dataOf();
    const states: unknown[] = [];
    const ports = {
      aiSetKey: async (p: string, k: string) => void calls.push([p, k]),
      aiTestKey: async () => ({ ok: true, ms: 400 }),
      aiProviders: async () => [],
    } as unknown as SettingsApiPort;
    const actions = createController({
      ports: { ...ports, loadProviders: async () => {} },
      host: HOST,
      data: () => data,
      view: () => view,
      setView: patch => {
        view = { ...view, ...patch };
        states.push(JSON.stringify(view));
      },
      setData: patch => {
        data = { ...data, ...patch };
        states.push(JSON.stringify(data));
      },
      overlay: () => {},
      accountOverlay: () => {},
      fail: () => {},
    });
    actions.openAddKey('anthropic');
    assert.equal(view.addKey?.provider, 'anthropic');
    await actions.submitKey('anthropic', CANARY);
    assert.deepEqual(calls, [['anthropic', CANARY]], 'Ai/setKey is called exactly once');
    assert.equal(view.addKey, null);
    assert.equal(view.testing.anthropic?.kind, 'works', 'a Test runs right after the key is saved');
    assert.ok(!JSON.stringify([view, data, states]).includes(CANARY));
    const markup = renderToStaticMarkup(
      <AddKeyDialog provider="anthropic" mode="add" onSave={() => {}} onCancel={() => {}} />,
    );
    assert.match(markup, /type="password"/);
    assert.ok(!markup.includes(CANARY));
  });

  test('a failed save puts one Retry line up and keeps no key', async () => {
    let failure = null as WriteFailure | null;
    const ports = {
      aiSetKey: async () => {
        throw new Error(`rejected ${CANARY}`);
      },
    } as unknown as SettingsApiPort;
    let view = { ...INITIAL_VIEW };
    const actions = createController({
      ports,
      host: HOST,
      data: () => dataOf(),
      view: () => view,
      setView: patch => void (view = { ...view, ...patch }),
      setData: () => {},
      overlay: () => {},
      accountOverlay: () => {},
      fail: f => void (failure = f),
    });
    const ok = await actions.submitKey('anthropic', CANARY);
    assert.equal(ok, false);
    assert.equal(failure!.op, 'save the Claude key');
    assert.ok(!JSON.stringify([view, failure!.op]).includes(CANARY));
  });
});

describe('write failure and destructive steps', () => {
  test('a rejected Settings/set drops the overlay and offers Retry for the same write', async () => {
    const calls: unknown[] = [];
    let attempts = 0;
    const overlays: unknown[] = [];
    let failure = null as WriteFailure | null;
    const ports = {
      settingsSet: async (p: unknown) => {
        calls.push(p);
        if (++attempts === 1) throw new Error('rejected');
      },
    } as unknown as SettingsApiPort;
    const actions = createController({
      ports,
      host: HOST,
      data: () => dataOf(),
      view: () => INITIAL_VIEW,
      setView: () => {},
      setData: () => {},
      overlay: o => void overlays.push(o),
      accountOverlay: () => {},
      fail: f => void (failure = f),
    });
    assert.equal(await actions.set({ mail: { undoSendSeconds: 20 } }, 'change undo send'), false);
    assert.deepEqual(overlays, [{ mail: { undoSendSeconds: 20 } }, null]);
    assert.equal(failure!.op, 'change undo send');
    failure!.retry?.();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(calls.length, 2);
  });

  test('Remove on an account, demo mail or a key asks first: nothing runs until runConfirm', async () => {
    const calls: string[] = [];
    let view = { ...INITIAL_VIEW };
    const ports = {
      accountDisconnect: async () => void calls.push('disconnect'),
      demoRemove: async () => void calls.push('demoRemove'),
    } as unknown as SettingsApiPort;
    const actions = createController({
      ports,
      host: HOST,
      data: () => dataOf({ accounts: [ALEX] }),
      view: () => view,
      setView: patch => void (view = { ...view, ...patch }),
      setData: () => {},
      overlay: () => {},
      accountOverlay: () => {},
      fail: () => {},
    });
    actions.askRemoveAccount(ALEX.id);
    actions.askRemoveDemo();
    assert.deepEqual(calls, []);
    assert.equal(view.confirm?.kind, 'removeDemo');
    await actions.runConfirm({ kind: 'removeAccount', accountId: ALEX.id, address: ALEX.address });
    assert.deepEqual(calls, ['disconnect']);
  });

  test('a key remap is toasted, put on the undo stack, and undone to the previous keymap', async () => {
    const writes: unknown[] = [];
    const toasts: string[] = [];
    let undo: (() => void | Promise<void>) | null = null;
    const ports = {
      settingsSet: async (p: unknown) => void writes.push(p),
    } as unknown as SettingsApiPort;
    const actions = createController({
      ports,
      host: { ...HOST, toast: m => void toasts.push(m), pushUndo: e => void (undo = e.undo) },
      data: () => dataOf(),
      view: () => INITIAL_VIEW,
      setView: () => {},
      setData: () => {},
      overlay: () => {},
      accountOverlay: () => {},
      fail: () => {},
    });
    await actions.commitRemap('mail.done', 'meta+shift+9');
    assert.deepEqual(toasts, ['Done is now ⌘⇧9']);
    await undo!();
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(writes[1], { ui: { keymap: {} } });
  });
});

describe('states, copy and design rules', () => {
  test('nav: eight sections in order with aria-current on the active one; no page title', () => {
    for (const name of names) {
      const markup = render(name);
      assert.equal((markup.match(/aria-current="page"/g) ?? []).length, 1, name);
      assert.doesNotMatch(markup, /<h1/, name);
      assert.doesNotMatch(markup, /page-title|page-sub|ui-page-head/, name);
    }
    const nav = render('general');
    const order = [
      'General',
      'Mail',
      'Calendar',
      'AI',
      'Notifications',
      'Accounts',
      'Keyboard',
      'Help &amp; about',
    ];
    let at = 0;
    for (const label of order) {
      const next = nav.indexOf(`>${label}<`, at);
      assert.ok(next >= at, label);
      at = next;
    }
  });

  test('no banned phrase, exclamation mark, glyph or round-2 provider appears in any state', () => {
    for (const name of names) {
      const markup = render(name);
      for (const line of lines(markup)) assert.equal(copyProblem(line), null, `${name}: ${line}`);
      assert.doesNotMatch(
        markup,
        /sparkle|wand|\bstars?\b|brain|robot|gradient|backdrop-filter/i,
        name,
      );
      assert.doesNotMatch(markup, /fastmail|icloud|\bimap\b|microsoft|outlook/i, name);
    }
  });

  test('at most one filled button in any state, and the page yields it to a dialog', () => {
    for (const name of names) {
      const filled = (render(name).match(/data-variant="filled"/g) ?? []).length;
      assert.ok(filled <= 1, `${name} has ${filled} filled buttons`);
    }
    assert.equal(
      (render('accounts-two-reconnect').match(/data-variant="filled"/g) ?? []).length,
      1,
    );
    assert.equal(
      (render('accounts-reconnect-due').match(/data-variant="filled"/g) ?? []).length,
      0,
    );
    assert.equal(
      (render('ai-consent-card').match(/data-variant="filled"/g) ?? []).length,
      1,
      "only the card's Allow, not the page's Review",
    );
  });

  test('Reconnect: the row says why; due rows read "Reconnect now"', () => {
    assert.match(render('accounts-reconnect'), /Google needs you to sign in again\./);
    assert.match(render('accounts-reconnect'), />Reconnect</);
    assert.match(
      render('accounts-reconnect-due'),
      /Gmail will ask you to reconnect (today|tomorrow) at \d/,
    );
    assert.match(render('accounts-reconnect-due'), />Reconnect now</);
    assert.doesNotMatch(render('accounts-default'), />Reconnect/);
    assert.match(render('accounts-permission'), /Aplos needs permission to read your Gmail\./);
  });

  test('Reconnect without renderReconnect: the row still says why, and there is no dead button', () => {
    const noSheet = renderToStaticMarkup(
      staticScreen(STATES['accounts-reconnect'], { ...HOST, renderReconnect: undefined }),
    );
    assert.match(noSheet, /Google needs you to sign in again\./);
    assert.doesNotMatch(noSheet, />Reconnect( now)?</);
    const noSheetDue = renderToStaticMarkup(
      staticScreen(STATES['accounts-reconnect-due'], { ...HOST, renderReconnect: undefined }),
    );
    assert.doesNotMatch(noSheetDue, />Reconnect( now)?</);
  });

  test('accounts: demo row has Reset and Remove, Help has no Load; the opposite without one', () => {
    const demo = render('accounts-demo');
    assert.match(demo, />Reset</);
    assert.match(demo, /Sample mail and events/);
    assert.doesNotMatch(render('help-no-demo-account'), /Load demo mail|>Load</);
    assert.match(render('help'), /Sample mail and events, so you can try Aplos/);
    assert.match(render('accounts-remove-demo'), /Remove the demo mail\?/);
  });

  test('AI: key sources, disabled Remove with a reason, Default tag, and local rows', () => {
    const ai = render('ai-default');
    assert.match(ai, /Key set on this Mac</);
    assert.match(ai, /Saved in Keychain/);
    assert.match(ai, /No key yet</);
    assert.match(ai, /This key is set outside Aplos, so it can only be removed where it was set\./);
    assert.doesNotMatch(
      ai,
      /GROQ_API_KEY|ANTHROPIC_API_KEY/,
      'variable names are developer details',
    );
    assert.match(ai, /Default/);
    assert.match(ai, /On this Mac · running · no key needed/);
    // A stopped local server says "Not running" once, in its status; the description does not repeat it.
    assert.match(ai, /On this Mac · no key needed/);
    assert.equal(ai.match(/not running/gi)?.length, 1);
    assert.match(ai, /Any OpenAI-compatible server · key optional/);
    assert.match(ai, /Daily limit/);
    assert.match(ai, /150,000 tokens/);
    assert.match(ai, /Reads new mail as it arrives and sends it to Groq\./);
  });

  test('AI: testing, refused, consent review, cap, no provider', () => {
    assert.match(render('ai-testing'), /Testing…/);
    assert.match(render('ai-testing'), /Works · 0\.4 s/);
    assert.match(render('ai-testing'), /Key refused/);
    assert.match(render('ai-testing'), /OpenRouter refused the saved key, so nothing was sent/);
    assert.match(
      render('ai-consent-review'),
      /Background summaries are paused until you agree to the new provider\./,
    );
    assert.match(render('ai-consent-review'), />Review</);
    assert.doesNotMatch(render('ai-default'), /paused until you agree/);
    assert.match(render('ai-cap-reached'), /Paused for today\. Resumes tomorrow\./);
    assert.doesNotMatch(render('ai-default'), /Paused for today/);
    assert.match(render('ai-no-provider'), /No AI provider is set up/);
    assert.match(render('ai-gemini-free'), /may learn from what it’s sent/);
  });

  test('AI: "How your mail is used" is a disclosure with aria-expanded and aria-controls', () => {
    assert.match(
      render('ai-default'),
      /aria-expanded="false"[^>]*aria-controls="set-ai-howMailIsUsed-content"|aria-controls="set-ai-howMailIsUsed-content"[^>]*aria-expanded="false"/,
    );
    assert.match(render('ai-cap-reached'), /What is sent\./);
  });

  test('AI: the account-mail row names off accounts, hides for all-on and demo-only', () => {
    assert.match(render('ai-account-mail'), /jordan\.lee@example\.com keeps its mail out of AI\./);
    assert.match(render('ai-account-mail'), /Turn on for existing accounts/);
    assert.match(render('ai-accounts-mail'), /2 accounts keep their mail out of AI\./);
    assert.doesNotMatch(render('ai-default'), /data-setting-anchor="accountMail"/);
    assert.doesNotMatch(render('ai-demo-only'), /data-setting-anchor="accountMail"/);
  });

  test('General, Mail, Calendar, Notifications copy', () => {
    assert.match(render('general'), /Light, dark, or match the system\./);
    assert.match(render('general'), /Open Aplos when you log in/);
    assert.match(render('mail'), /8 seconds/);
    assert.match(
      render('mail'),
      /Keeps full message text on this Mac; opened, bookmarked and unread mail is always kept\./,
    );
    assert.match(render('calendar'), /Calendar not allowed yet/);
    assert.match(render('calendar'), /Allow calendar access/);
    assert.match(render('notifications'), /Low importance never interrupts/);
  });

  test('theme and density are radiogroups, not tablists', () => {
    const general = render('general');
    assert.match(general, /role="radio"/);
    assert.doesNotMatch(general, /role="tab"/);
  });

  test('switches are role="switch" with a name from their row', () => {
    const general = render('general');
    assert.match(general, /role="switch"/);
    assert.match(general, /aria-labelledby="set-general-sidebarMinimised"/);
    assert.doesNotMatch(
      general,
      /Show all key hints/,
      'the key hints switch lives in Keyboard only',
    );
    assert.match(render('keyboard-default'), /aria-labelledby="set-keyboard-keyHints"/);
  });

  test('Help: version line, queue inspector rows, diagnostics preview, welcome', () => {
    assert.match(render('help'), /Version 0\.3\.0 \(build dev\) · macOS/);
    assert.match(render('help'), />Replay</);
    assert.match(render('help'), /Replay onboarding/);
    assert.match(
      render('help'),
      /Go through the onboarding again\. Your mail and settings stay as they are\./,
    );
    const q = render('queue-inspector');
    assert.match(q, /Archive 3 threads/);
    assert.match(q, />Retry</);
    assert.match(q, />Discard</);
    assert.match(render('queue-discard-confirm'), /Discard “Message to 1 person”\?/);
    assert.match(render('diagnostics-preview'), /It holds no mail, no addresses and no keys/);
    const copied = render('diagnostics-copied');
    assert.match(copied, />Copied\.</);
    assert.match(copied, />Close</);
    assert.doesNotMatch(copied, />Cancel</);
  });

  test('Tools: the switch, the connected list with Revoke; off shows nothing to revoke', () => {
    const on = render('tools-on');
    assert.match(on, /Terminal assistant/);
    assert.match(on, /Notes helper/);
    assert.equal((on.match(/>Revoke</g) ?? []).length, 2);
    assert.match(on, /read, draft/);
    assert.doesNotMatch(render('general'), />Revoke</);
  });

  test('every capability that is off reads "Not available yet" with no dead control', () => {
    const general = render('capabilities-off');
    assert.equal((general.match(/Not available yet/g) ?? []).length, 2);
    assert.doesNotMatch(
      general,
      /Tools on this Mac|Add a tool|Connected tools/,
      'unbuilt rows stay hidden',
    );
    assert.doesNotMatch(
      general,
      /role="switch"[^>]*aria-checked="true"[^>]*aria-labelledby="set-general-(allowTools|openAtLogin|menuBar)"/,
    );
    const help = render('capabilities-off-help');
    assert.equal((help.match(/Not available yet/g) ?? []).length, 2);
    assert.doesNotMatch(help, /Queue inspector/, 'unbuilt rows stay hidden');
    assert.doesNotMatch(help, />Preview<|>Open</);
    assert.doesNotMatch(help, /role="switch"[^>]*set-help-verboseLogging/);
  });

  test('Keyboard: the registry list, recording, conflict and refusal states', () => {
    const k = render('keyboard-default');
    assert.match(k, /Single-key shortcuts/);
    assert.match(k, /Letters like E and L act on their own/);
    assert.match(k, /Show all key hints/);
    assert.match(k, /Hold time/);
    assert.match(render('keyboard-recording'), /Press the new keys · Esc to cancel/);
    const conflict = render('keyboard-conflict');
    assert.match(conflict, /Already used by Later/);
    assert.match(conflict, />Replace</);
    assert.match(conflict, /Same keys as Show or hide the Ask pane/);
    assert.match(conflict, />Reset all</);
    assert.match(render('keyboard-reserved'), /belongs to macOS/);
  });

  test('worst case: a 40-character model name and a 200-character address render, ellipsised by the row', () => {
    const w = render('worst-case');
    assert.ok(w.includes('northwind-research-compute-cooperative-q'));
    assert.ok(w.includes('inference-gateway-'));
    const a = render('worst-case-accounts');
    assert.match(a, /a-very-long-local-part/);
  });

  test('a rejected write shows one inline line with Retry and a way to put it away', () => {
    const m = render('write-failed');
    assert.match(m, /Couldn[’']t change undo send\./);
    assert.match(m, />Retry</);
    assert.match(m, />Dismiss</);
  });
});

describe('accessibility in markup', () => {
  test('every DOM id on a page is unique', () => {
    for (const name of names) {
      const ids = [...render(name).matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
      const seen = new Set<string>();
      for (const id of ids) {
        assert.ok(!seen.has(id), `${name}: duplicate id "${id}"`);
        seen.add(id);
      }
    }
  });

  test('every aria-controls resolves, except the one on a closed select trigger', () => {
    for (const name of names) {
      const markup = render(name);
      const ids = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
      for (const m of markup.matchAll(/aria-controls="([^"]+)"/g)) {
        const tag = markup.slice(0, m.index).match(/<[^>]*$/)?.[0] ?? '';
        const closedMenu = /aria-expanded="false"/.test(tag) && /aria-haspopup="menu"/.test(tag);
        assert.ok(ids.has(m[1]) || closedMenu, `${name}: aria-controls "${m[1]}" resolves nowhere`);
      }
    }
  });

  test('a select trigger is named by its setting and its current value', () => {
    const mail = render('mail');
    assert.match(mail, /aria-label="Undo send: 8 seconds"[^>]*aria-haspopup="menu"/);
    assert.match(render('general'), /aria-label="Swipe direction: Right is Done"/);
    const calendar = render('calendar');
    assert.match(calendar, /aria-label="Week starts on: Follow the system"/);
  });

  test('a disabled Remove is focusable and its reason is read', () => {
    const ai = render('ai-default');
    const control = ai.match(
      /<button[^>]*aria-label="Remove key for Groq"[^>]*aria-describedby="([^"]+)"[^>]*>Remove<\/button>/,
    );
    assert.ok(control, 'the disabled Remove button');
    assert.doesNotMatch(control[0], /\sdisabled(=|>|\s)/, 'it stays focusable');
    const reason = new RegExp(`id="${control[1]}"[^>]*>This key is set outside Aplos`);
    assert.match(ai, reason, 'the reason is a describedby twin');
  });

  test('statuses pair a dot or icon with a word; account marks pair with a name', () => {
    for (const name of names) {
      const markup = render(name);
      const statuses = markup.match(/class="ui-provider-table__status"/g) ?? [];
      const words = markup.match(/ui-provider-table__status-text">[^<]+</g) ?? [];
      assert.equal(words.length, statuses.length, `${name}: a status with no word`);
      const marks = markup.match(/class="ui-setting-row__mark"/g) ?? [];
      const named =
        markup.match(
          /ui-setting-row__mark"[^>]*><\/span><span class="ui-setting-row__label"[^>]*>[^<]+</g,
        ) ?? [];
      assert.equal(named.length, marks.length, `${name}: a mark with no name`);
    }
  });

  test('the pane resets to the top only for a section change', () => {
    assert.equal(scrollWithoutTarget(null, 'general'), 'top');
    assert.equal(scrollWithoutTarget('general', 'mail'), 'top');
    assert.equal(scrollWithoutTarget('general', 'general'), 'stay');
  });

  test('the anchor effect moves only on a fresh navigation, a recording, or a row arriving', () => {
    const base = {
      recording: false,
      recordingChanged: false,
      linked: false,
      wasMissing: false,
      freshNav: false,
      consumed: false,
    };
    // A deep link on a drawn row scrolls and focuses it.
    assert.equal(anchorScroll({ ...base, linked: true, freshNav: true }), 'linked');
    // A conditional row appearing after the link landed resolves the miss and is scrolled to.
    assert.equal(anchorScroll({ ...base, linked: true, wasMissing: true }), 'linked');
    // A recording starting scrolls its own row only.
    assert.equal(
      anchorScroll({ ...base, recording: true, recordingChanged: true, linked: true }),
      'recording',
    );
    // A recording ending while an anchor stays set re-runs neither scroll nor focus.
    assert.equal(anchorScroll({ ...base, recordingChanged: true, linked: true }), 'none');
    // A data refresh under an already-drawn anchor keeps the pane and focus where they are.
    assert.equal(anchorScroll({ ...base, linked: true }), 'none');
    // A still-missing row never scrolls, whether the navigation is fresh or not.
    assert.equal(anchorScroll({ ...base, freshNav: true }), 'top');
    assert.equal(anchorScroll({ ...base, wasMissing: true }), 'none');
    // A spent link (the row drew once on this visit) moves nothing ever after: a vanish is not a
    // miss and a redraw does not steal scroll or focus back.
    assert.equal(anchorScroll({ ...base, consumed: true }), 'none');
    assert.equal(anchorScroll({ ...base, consumed: true, linked: true }), 'none');
    assert.equal(anchorScroll({ ...base, consumed: true, wasMissing: true, linked: true }), 'none');
    // A fresh navigation starts the visit over: the spent flag from the last one does not apply.
    assert.equal(anchorScroll({ ...base, consumed: true, linked: true, freshNav: true }), 'linked');
    // A plain re-render keeps everything still.
    assert.equal(anchorScroll(base), 'none');
  });
});
