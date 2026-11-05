// The F8 follow-ups: Reconnect reaches the shell's sheet through `openReconnect`, Account/set writes are
// optimistic per account, and conditional rows carry a live `available` so the palette stops offering rows that
// are not drawn. Run: npx tsx --test 'src/renderer/screens/settings/**/*.test.{ts,tsx}' (from apps/desktop)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppRegistry } from '../../commands';
import type { Account, AiProvider } from '../../data';
import { clearAvailability, publishAvailability, rowAvailable } from './availability';
import { createController } from './controller';
import { entryFor, isConditional, SETTING_ROWS } from './paletteEntries';
import type { SettingsApiPort, SettingsData, SettingsHost } from './ports';
import { accountRows, mergeAccounts, reconnectPress, type AccountWrite } from './settings.model';
import { INITIAL_VIEW, type SettingsView } from './view';
import {
  ALEX,
  account,
  baseSettings,
  consent,
  JORDAN,
  models,
  needsReauth,
  NOW,
  providers,
  queue,
  session,
  usage,
} from './preview/fixtures';
import { HOST, STATES, staticScreen } from './preview/states';

const dataAt = (over: Partial<SettingsData> = {}): SettingsData => ({
  settings: baseSettings(),
  accounts: [ALEX],
  session: session(),
  consent: consent(),
  now: NOW,
  providers: providers(),
  models: models(),
  usage: usage(),
  listener: { enabled: false },
  clients: [],
  queue: queue(),
  ...over,
});

function harness(
  over: {
    ports?: Partial<SettingsApiPort>;
    data?: Partial<SettingsData>;
    host?: SettingsHost;
  } = {},
) {
  let view: SettingsView = { ...INITIAL_VIEW };
  let data: SettingsData = dataAt(over.data);
  const accountOverlays: (Readonly<Record<string, AccountWrite>> | null)[] = [];
  const failures: ({ op: string; retry(): void; dismiss(): void } | null)[] = [];
  const actions = createController({
    ports: (over.ports ?? {}) as SettingsApiPort,
    host: over.host ?? {},
    data: () => data,
    view: () => view,
    setView: patch => {
      view = { ...view, ...patch };
    },
    setData: patch => {
      data = { ...data, ...patch };
    },
    overlay: () => {},
    accountOverlay: patch => void accountOverlays.push(patch),
    fail: failure => void failures.push(failure),
  });
  return {
    actions,
    view: () => view,
    data: () => data,
    accountOverlays,
    failures,
  };
}

describe('Reconnect reaches the shell sheet', () => {
  test('pressing Reconnect calls openReconnect: reconnect for needsReauth, grant for needsPermission', () => {
    const calls: [string, string][] = [];
    const host: SettingsHost = {
      openReconnect: (accountId, mode) => void calls.push([accountId, mode]),
    };
    const reauth = accountRows([needsReauth(ALEX)], NOW)[0]!;
    const perm = accountRows(
      [
        account({
          id: 'perm',
          address: 'perm@example.com',
          health: {
            status: { state: 'needsPermission', missingScopes: ['calendar'] },
            reasonCode: 'permission.calendar',
          },
        }),
      ],
      NOW,
    )[0]!;
    const press = reconnectPress(host)!;
    press(reauth.id, reauth.reconnect!.mode, { startReconnect: () => assert.fail('inline path') });
    press(perm.id, perm.reconnect!.mode, { startReconnect: () => assert.fail('inline path') });
    assert.deepEqual(calls, [
      [ALEX.id, 'reconnect'],
      ['perm', 'grant'],
    ]);
  });

  test('without openReconnect the preview path stays: startReconnect opens the inline flow', () => {
    const started: [string, string][] = [];
    const press = reconnectPress({ renderReconnect: () => null })!;
    press(ALEX.id, 'reconnect', {
      startReconnect: (id, mode) => void started.push([id, mode]),
    });
    assert.deepEqual(started, [[ALEX.id, 'reconnect']]);
    assert.equal(reconnectPress({}), undefined, 'no host method, no dead button');
  });

  test('the row draws the button when the host offers openReconnect', () => {
    const markup = renderToStaticMarkup(
      staticScreen(STATES['accounts-reconnect'], {
        ...HOST,
        renderReconnect: undefined,
        openReconnect: () => {},
      }),
    );
    assert.match(markup, />Reconnect</);
  });
});

describe('optimistic Account/set', () => {
  test('overlapping writes to two accounts each hold their own patch until they settle', async () => {
    const finish = new Map<string, () => void>();
    const h = harness({
      ports: {
        accountSet: id =>
          new Promise<void>(resolve => {
            finish.set(id, resolve);
          }),
      },
    });
    const first = h.actions.setAccount(ALEX.id, { colorTag: 'hill' });
    const second = h.actions.setAccount(JORDAN.id, { aiAllowed: false });
    assert.deepEqual(h.accountOverlays.at(-1), {
      [ALEX.id]: { colorTag: 'hill' },
      [JORDAN.id]: { aiAllowed: false },
    });
    const merged = mergeAccounts(dataAt().accounts, h.accountOverlays.at(-1));
    assert.equal(merged.find(a => a.id === ALEX.id)?.colorTag, 'hill');
    // The first write settling drops only its own overlay; the second is still optimistic.
    finish.get(ALEX.id)!();
    await first;
    assert.deepEqual(h.accountOverlays.at(-1), { [JORDAN.id]: { aiAllowed: false } });
    finish.get(JORDAN.id)!();
    await second;
    assert.equal(h.accountOverlays.at(-1), null);
  });

  test('a rejected write drops the overlay and its Retry re-pushes it for a fresh write', async () => {
    const calls: unknown[] = [];
    let attempts = 0;
    const h = harness({
      ports: {
        accountSet: async (id, patch) => {
          calls.push(patch);
          if (++attempts === 1) throw new Error('rejected');
        },
      },
    });
    assert.equal(await h.actions.setAccount(ALEX.id, { aiAllowed: false }), false);
    assert.deepEqual(h.accountOverlays, [{ [ALEX.id]: { aiAllowed: false } }, null]);
    const failure = h.failures.at(-1);
    assert.equal(failure?.op, 'save that account setting');
    failure!.retry();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(calls.length, 2);
    assert.deepEqual(h.accountOverlays.at(-1), null);
    assert.equal(h.failures.at(-1), null);
  });
});

describe('conditional rows and palette availability', () => {
  const ctx = {
    stack: ['global'],
    target: null,
    selection: [],
    conditions: {},
    focus: 'none',
    prefs: undefined,
  } as never;

  const paletteIds = () =>
    createAppRegistry()
      .commandsForPalette(ctx)
      .filter(e => e.group === 'Settings')
      .map(e => e.id);

  const gemini = (keySource: AiProvider['keySource']): AiProvider[] =>
    providers().map(p => (p.id === 'gemini' ? { ...p, keySource } : p));

  test('only the conditional rows carry available; the rest are always offered', () => {
    const conditional = SETTING_ROWS.filter(isConditional);
    assert.ok(conditional.length > 0);
    for (const spec of SETTING_ROWS) {
      const entry = entryFor(spec);
      assert.equal(entry.available !== undefined, isConditional(spec), `${entry.id} availability`);
    }
  });

  test('with no Gemini key the paid-plan entry is not offered; with a key it is', () => {
    try {
      publishAvailability({
        accounts: [ALEX],
        providers: gemini('none'),
        session: session(),
      });
      assert.equal(rowAvailable('ai', 'geminiPaid'), false);
      assert.ok(!paletteIds().includes('setting.ai.geminiPaid'));
      publishAvailability({
        accounts: [ALEX],
        providers: gemini('keychain'),
        session: session(),
      });
      assert.equal(rowAvailable('ai', 'geminiPaid'), true);
      assert.ok(paletteIds().includes('setting.ai.geminiPaid'));
    } finally {
      clearAvailability();
    }
  });

  test('a provider row is hidden when Ai/providers does not list it; unknown providers stay offered', () => {
    try {
      publishAvailability({
        accounts: [ALEX],
        providers: providers().filter(p => p.id !== 'openai' && p.id !== 'ollama'),
        session: session(),
      });
      assert.equal(rowAvailable('ai', 'provider-openai'), false);
      assert.equal(rowAvailable('ai', 'server-ollama'), false);
      assert.equal(rowAvailable('ai', 'provider-groq'), true);
      assert.ok(!paletteIds().includes('setting.ai.provider-openai'));
      publishAvailability({ accounts: [ALEX], providers: undefined, session: session() });
      assert.equal(rowAvailable('ai', 'provider-openai'), true, 'still loading stays offered');
    } finally {
      clearAvailability();
    }
  });

  test('account and demo rows follow the account list; every row is offered with nothing published', () => {
    try {
      clearAvailability();
      for (const spec of SETTING_ROWS)
        assert.equal(rowAvailable(spec.section, spec.anchor), true, spec.anchor);
      const demo = account({ id: 'demo', address: 'demo@example.com', demo: true });
      publishAvailability({ accounts: [demo], providers: providers(), session: session() });
      assert.equal(
        rowAvailable('accounts', 'accountAi'),
        false,
        'demo-only has no per-account rows',
      );
      assert.equal(rowAvailable('accounts', 'lease'), false);
      assert.equal(rowAvailable('notifications', 'perAccount'), false);
      assert.equal(rowAvailable('help', 'demoLoad'), false, 'a demo account hides Load');
      assert.equal(rowAvailable('calendar', 'calendarPermission'), false);
      const missing: Account = account({
        id: 'mp',
        address: 'mp@example.com',
        missingPermissions: [{ capability: 'calendar', reasonCode: 'permission.calendar' }],
      });
      publishAvailability({ accounts: [missing], providers: providers(), session: session() });
      assert.equal(rowAvailable('calendar', 'calendarPermission'), true);
      assert.equal(rowAvailable('help', 'demoLoad'), true);
      assert.equal(rowAvailable('accounts', 'accountColour'), true);
    } finally {
      clearAvailability();
    }
  });
});
