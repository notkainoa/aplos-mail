/**
 * The shell on the stand-in engine, rendered with react-dom/server in node (no DOM, no effects).
 * Run: `cd apps/desktop && npx tsx --test src/renderer/shell/shell.test.ts`.
 *
 * Each test boots a fixture scenario behind the data layer, lets the singletons load, and renders `Shell` or one of its
 * hosts to static markup: sidebar groups and counts, the status slot's copy for each state, the reconnect line, the
 * toast stack and the FatalScreen.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFixtureEngine, defaultNow, type Scenario } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';
import { harnessClock } from '../data/clock';
import { connectDataLayer, type DataConnection } from '../data/connect';
import { HARNESS_NOW_MS, setClock } from '../data';
import { createManualScheduler, createManualTimers } from '../data/scheduler';
import { closeSheet, navigate, pushToast, dismissToast } from './index';
import { context } from '../commands/testing';
import { PaletteHost } from '../screens/palette';
import { NOTCH_W, paneHeader, Shell, ShellLayout, shellCommands } from './Shell';
import { failureReason, flowEnded, reconnectKey } from './SheetHost';
import { toSyncStatus } from './status-map';
import { StatusHost } from './StatusHost';
import { ToastHostView } from './ToastHost';
import { MAIL_PLACES, TOP_PLACES, placeCounts } from './nav';

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

interface Booted {
  readonly connection: DataConnection;
  readonly control: ReturnType<typeof fixtureControl>;
  settle(): Promise<void>;
  /** Lets a control change reach the layer: the fixture clock moves a moment, then frames apply. */
  changed(): Promise<void>;
}

let open: DataConnection | null = null;

afterEach(() => {
  closeSheet();
  navigate('home');
  open?.close();
  open = null;
});

/** Boots a scenario, loads the singletons the shell reads, and freezes both clocks at the harness's now. */
async function boot(scenario: Scenario): Promise<Booted> {
  const engine = createFixtureEngine({ scenario, clock: defaultNow });
  const scheduler = createManualScheduler();
  const connection = connectDataLayer({
    session: engine.connect(),
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  open = connection;
  setClock(harnessClock);
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await nextTask();
      scheduler.flush();
    }
  };
  for (const name of ['accounts', 'counts', 'settings', 'consent'] as const)
    connection.layer.session.want(name);
  await settle();
  const control = fixtureControl(engine);
  const changed = async () => {
    await control.advanceClock({ ms: 200 });
    await settle();
  };
  return { connection, control, settle, changed };
}

const render = () => renderToStaticMarkup(createElement(Shell));

test('the sidebar has its groups in order: places, the Mail label, Mail rows, then the footer', async () => {
  await boot('demo');
  const html = render();
  const order = [...TOP_PLACES, ...MAIL_PLACES].map(place => html.indexOf(`>${place.label}<`));
  assert.ok(
    order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)),
    `rows out of order: ${order}`,
  );
  assert.match(html, /ui-nav-head[^>]*>Mail</);
  for (const label of ['Places', 'Mail', 'App'])
    assert.match(html, new RegExp(`aria-label="${label}"`));
  assert.ok(
    html.indexOf('>Settings<') > html.indexOf('>Trash<'),
    'the footer follows the mail group',
  );
  assert.match(html, /Mail you finished\. Press H to move one back to Home\./);
  assert.match(html, /All accounts/);
  assert.match(html, /aria-current="page"[^>]*>(?:(?!<\/button>).)*Home/s);
});

test('counts show when the baseline is done and hide during first sync', async () => {
  const { connection } = await boot('demo');
  const session = connection.layer.session;
  const shown = placeCounts(session.counts!.all, false);
  assert.ok((shown.home ?? 0) > 0, 'Home shows Do now plus Important updates');
  assert.deepEqual(placeCounts(session.counts!.all, true), {});
  assert.match(render(), /ui-puck__count/);

  session.accounts = session.accounts.map(account => ({ ...account, baselineDoneAt: undefined }));
  connection.layer.emitter.emit();
  assert.doesNotMatch(render(), /ui-puck__count/, 'no count while an account is in its first sync');
});

test('the reconnect line shows within 24 hours of reconnectBy, with Reconnect now', async () => {
  const { control, changed, connection } = await boot('demo');
  const account = connection.layer.session.accounts[0]!;
  await control.setAccountStatus({
    accountId: account.id,
    status: { state: 'ok' },
    reasonCode: undefined,
    reconnectBy: HARNESS_NOW_MS + 3 * 3_600_000,
  });
  await changed();
  const html = renderToStaticMarkup(createElement(StatusHost));
  assert.match(html, /Gmail will ask you to reconnect (today|tomorrow) at /);
  assert.match(html, />Reconnect now</);
});

test('a reconnect more than a day away shows nothing', async () => {
  const { control, changed, connection } = await boot('demo');
  for (const account of connection.layer.session.accounts)
    await control.setAccountStatus({
      accountId: account.id,
      status: { state: 'ok' },
      reconnectBy: HARNESS_NOW_MS + 4 * 86_400_000,
    });
  await changed();
  assert.doesNotMatch(renderToStaticMarkup(createElement(StatusHost)), /reconnect/i);
});

test('status copy comes from the table and never from provider text', async () => {
  const { control, changed, connection } = await boot('demo');
  const account = connection.layer.session.accounts[0]!;
  const raw = 'invalid_grant: Token has been expired or revoked (provider detail 7731)';
  await control.setAccountStatus({
    accountId: account.id,
    status: { state: 'needsReauth', reason: raw },
    reasonCode: 'auth.expired',
  });
  await changed();
  const html = renderToStaticMarkup(createElement(StatusHost));
  assert.match(html, /Google needs you to sign in again\./);
  assert.match(html, />Reconnect</);
  assert.doesNotMatch(html, /invalid_grant|7731|revoked/);
  assert.doesNotMatch(render(), /invalid_grant|7731|revoked/);
});

test('a missing permission uses its own line', async () => {
  const { control, changed, connection } = await boot('demo');
  await control.setAccountStatus({
    accountId: connection.layer.session.accounts[0]!.id,
    status: { state: 'needsPermission', missingScopes: ['https://mail.google.com/'] },
    reasonCode: 'permission.mailModify',
  });
  await changed();
  const html = renderToStaticMarkup(createElement(StatusHost));
  assert.match(html, /Aplos needs permission to read your Gmail\./);
  assert.doesNotMatch(html, /mail\.google\.com/);
});

for (const [scenario, expected] of [
  ['offline', /Offline/],
  ['backfilling', /Importing 120 of 2,400/],
  ['rate-limited', /Google asked us to slow down\. Resuming at /],
] as const) {
  test(`the ${scenario} scenario fills the status slot`, async () => {
    await boot(scenario);
    assert.match(renderToStaticMarkup(createElement(StatusHost)), expected);
  });
}

test('the toast stack renders what was pushed, as the one ToastStack', async () => {
  await boot('demo');
  const id = pushToast({
    id: 'op-1',
    kind: 'done',
    message: 'Moved to Later',
    undoable: true,
    actions: [{ id: 'undo', label: 'Undo', commandId: 'app.undo' }],
  });
  try {
    const html = render();
    assert.match(html, /Moved to Later/);
    assert.match(html, />Undo</);
    assert.equal(html.split('ui-toast-stack').length - 1, 1, 'one stack');
  } finally {
    dismissToast(id);
  }
  const bare = renderToStaticMarkup(
    createElement(ToastHostView, {
      toasts: [],
      onAction: () => undefined,
      onDismiss: () => undefined,
    }),
  );
  assert.doesNotMatch(bare, /ui-toast"/);
});

test('other screens show a plain placeholder line, not another lane’s content', async () => {
  await boot('demo');
  navigate('later');
  assert.match(render(), /Nothing set aside for later/);
  navigate({ label: 'Search' });
  assert.match(render(), /Search isn’t in this build yet/);
});

test('the open reconnect sheet is hosted over the shell', async () => {
  const { connection } = await boot('demo');
  const account = connection.layer.session.accounts[0]!;
  const { openSheet } = await import('./index');
  openSheet('reconnect', { accountId: account.id, mode: 'grant' });
  const html = render();
  assert.match(html, /Grant access for /);
  assert.match(html, /Waiting for Google in your browser/);
});

test('the FatalScreen replaces the shell when the engine is parked', async () => {
  const { control, changed } = await boot('demo');
  await control.park({ reasonCode: 'crashLoop', message: 'The engine stopped (raw detail 4410).' });
  await changed();
  const html = render();
  assert.match(html, /Aplos can’t reach its mail engine\./);
  assert.match(html, />Try again</);
  assert.doesNotMatch(html, /4410/);
  assert.doesNotMatch(html, /aplos-sidebar/);
});

test('a daily-limit pause maps to its own line and failures map to plain words', async () => {
  const { connection } = await boot('rate-limited');
  const account = connection.layer.session.accounts[0]!;
  const base = {
    account,
    reasonCode: 'quota.daily' as const,
    reconnectSoon: false,
    demo: false,
  };
  const status = {
    state: 'paused' as const,
    until: 1,
    class: 'quota',
    reason: 'dailyLimitExceeded',
  };
  const daily = toSyncStatus({ ...base, status });
  assert.equal(daily.kind, 'paused');
  assert.equal(daily.kind === 'paused' && daily.reason, 'dailyLimit');
  const throttled = toSyncStatus({ ...base, status, reasonCode: 'rate.minute' });
  assert.equal(throttled.kind === 'paused' && throttled.reason, 'throttle');
  assert.match(failureReason('auth.wrongAccount'), /different account/);
  assert.doesNotMatch(failureReason('invalid_grant: raw provider text'), /invalid_grant|raw/);
});

test('a reconnect sheet is keyed by account and mode, so replacing it starts fresh state', () => {
  assert.notEqual(
    reconnectKey({ accountId: 'a1', mode: 'reconnect' }),
    reconnectKey({ accountId: 'a2', mode: 'reconnect' }),
  );
  assert.notEqual(
    reconnectKey({ accountId: 'a1', mode: 'reconnect' }),
    reconnectKey({ accountId: 'a1', mode: 'grant' }),
  );
});

test('a flow counts as ended only by the last frame of its own connect id', () => {
  assert.equal(flowEnded({ connectId: 'c1', state: 'failed' }, 'c1'), true);
  assert.equal(flowEnded({ connectId: 'c1', state: 'waiting' }, 'c1'), false);
  assert.equal(flowEnded({ connectId: 'c1', state: undefined }, 'c1'), false);
  // A retry starts c2 while the old failed frame (c1) is still the latest: c2 is not ended.
  assert.equal(flowEnded({ connectId: 'c1', state: 'failed' }, 'c2'), false);
});

test('the dock is closed on first run, opens beside the main pane, and ⌘K reaches the palette', async () => {
  await boot('demo');
  // First run: no second pane (DESIGN 7.7: closed until asked).
  assert.doesNotMatch(render(), /data-kind="dock"/);

  // The pane header's Ask action asks for the ask tab and shows pressed while open.
  const tabs: string[] = [];
  const header = paneHeader(
    'closed',
    tab => tabs.push(tab),
    {},
    () => undefined,
  );
  assert.equal(header.ask.pressed, false);
  header.ask.onPress();
  assert.deepEqual(tabs, ['ask']);
  assert.equal(
    paneHeader(
      'ask',
      () => undefined,
      {},
      () => undefined,
    ).ask.pressed,
    true,
  );

  // With dock content the layout draws the second pane after the main one.
  const docked = renderToStaticMarkup(
    createElement(ShellLayout, {
      screen: 'home',
      counts: {},
      minimised: false,
      chrome: { fullscreen: false, collapsed: false },
      mac: false,
      onNavigate: () => undefined,
      onCompose: () => undefined,
      onToggleSidebar: () => undefined,
      accountSwitcher: null,
      status: null,
      header: paneHeader(
        'ask',
        () => undefined,
        {},
        () => undefined,
      ),
      toasts: null,
      dock: createElement('div', null, 'dock body'),
      children: createElement('div', null, 'home body'),
    }),
  );
  const main = docked.indexOf('data-kind="main"');
  const dock = docked.indexOf('data-kind="dock"');
  assert.ok(main > 0 && dock > main, 'the dock pane sits beside the main pane');
  assert.match(docked, /dock body/);
  assert.match(docked, /data-kind="dock"[^>]*aria-label="Ask"/, 'the dock landmark is the Ask tab');

  // On the Today tab the landmark says so.
  const today = renderToStaticMarkup(
    createElement(ShellLayout, {
      screen: 'home',
      counts: {},
      minimised: false,
      chrome: { fullscreen: false, collapsed: false },
      mac: false,
      onNavigate: () => undefined,
      onCompose: () => undefined,
      onToggleSidebar: () => undefined,
      accountSwitcher: null,
      status: null,
      header: paneHeader(
        'today',
        () => undefined,
        {},
        () => undefined,
      ),
      toasts: null,
      dock: createElement('div', null, 'today body'),
      dockLabel: 'Today',
      children: createElement('div', null, 'home body'),
    }),
  );
  assert.match(today, /data-kind="dock"[^>]*aria-label="Today"/);

  // The shell's own table: ⌘K toggles the palette, the dock keys open and toggle it (a mounted host shadows them).
  const ctx = context(['global']);
  let palette = false;
  const opened: string[] = [];
  const commands = shellCommands({
    openTab: tab => opened.push(tab),
    toggleDock: () => opened.push('toggle'),
    togglePalette: () => {
      palette = !palette;
    },
    toggleSidebar: () => undefined,
  });
  commands['app.palette']!.run(ctx);
  assert.equal(palette, true, '⌘K opens the palette');
  commands['app.palette']!.run(ctx);
  assert.equal(palette, false, '⌘K again closes it');
  commands['ask.open']!.run(ctx);
  commands['nav.today']!.run(ctx);
  assert.deepEqual(opened, ['ask', 'today']);

  // Mounted in the overlay slot, the open palette draws its panel.
  const paletteHtml = renderToStaticMarkup(
    createElement(PaletteHost, { open: true, onClose: () => undefined }),
  );
  assert.match(paletteHtml, /ui-palette__panel/);
});

test('the collapsed strip is the sidebar region, so its toggle stays a region Tab stop', () => {
  const html = renderToStaticMarkup(
    createElement(ShellLayout, {
      screen: 'home',
      counts: {},
      minimised: false,
      chrome: { fullscreen: false, collapsed: true },
      mac: false,
      onNavigate: () => undefined,
      onCompose: () => undefined,
      onToggleSidebar: () => undefined,
      accountSwitcher: null,
      status: null,
      header: paneHeader(
        'closed',
        () => undefined,
        {},
        () => undefined,
      ),
      toasts: null,
      children: createElement('div', null, 'home body'),
    }),
  );
  assert.match(html, /aplos-shell__strip[^>]*data-region="sidebar"/);
  // The notch is inside the strip, hidden from assistive tech, and its fill and edge share the notch's width.
  assert.match(html, /aplos-shell__strip[\s\S]*aplos-shell__notch[^>]*aria-hidden="true"/);
  assert.match(html, new RegExp(`d="M0 0H${NOTCH_W}V8A10 10 0 0 0 124 18`));
});
