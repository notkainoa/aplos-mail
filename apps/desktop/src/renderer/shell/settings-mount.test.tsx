// Settings in the shell: the host pieces, the route flow from `openRoute` to the container, and leaving the screen.
// Run: cd apps/desktop && npx tsx --test src/renderer/shell/settings-mount.test.tsx   (server render, no DOM)
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFixtureEngine, defaultNow, type Scenario } from '@aplos/contract-fixture';
import { harnessClock } from '../data/clock';
import { connectDataLayer, type DataConnection } from '../data/connect';
import { setClock } from '../data';
import { createManualScheduler, createManualTimers } from '../data/scheduler';
import { createAppRegistry, parseSettingRoute, settingId, SETTING_SECTIONS } from '../commands';
import { context } from '../commands/testing';
import { SETTING_ROWS } from '../screens/settings/paletteEntries';
import { renderScreen } from '../App';
import {
  closeSheet,
  navigate,
  openRoute,
  pushToast,
  updateToast,
  type PushedToast,
  type RouteTarget,
} from './index';
import { Shell } from './Shell';
import { getRoute, consumeRoute } from './store-route';
import { getPaneHeaderPart } from './store-pane';
import { getSidebarSlot } from './store-sidebar';
import { getToasts, resetToasts, runToastAction } from './store-toast';
import {
  createSettingsHost,
  NO_ROUTE,
  routeChosen,
  routeFor,
  type SettingsHostDeps,
} from './settingsHost';

let open: DataConnection | null = null;

afterEach(() => {
  closeSheet();
  resetToasts();
  const pending = getRoute();
  if (pending) consumeRoute(pending.seq);
  navigate('home');
  open?.close();
  open = null;
});

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

async function boot(scenario: Scenario = 'demo') {
  const engine = createFixtureEngine({ scenario, clock: defaultNow });
  const scheduler = createManualScheduler();
  const connection = connectDataLayer({
    session: engine.connect(),
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  open = connection;
  setClock(harnessClock);
  for (const name of ['accounts', 'counts', 'settings', 'consent'] as const)
    connection.layer.session.want(name);
  for (let i = 0; i < 20; i++) {
    await nextTask();
    scheduler.flush();
  }
  return connection;
}

const target = (route: RouteTarget['route'], seq: number): RouteTarget => {
  const [section, row] = route.slice('settings/'.length).split('#');
  return { route, section: section as RouteTarget['section'], row, seq };
};

/** The host with every shell call recorded. */
function recorded() {
  const calls: string[] = [];
  const toasts: PushedToast[] = [];
  let welcome: 'opened' | 'navigated' | 'failed' = 'opened';
  const deps: SettingsHostDeps = {
    pushToast: toast => {
      toasts.push(toast);
      return toast.id;
    },
    updateToast: (id, patch) => {
      const at = toasts.findIndex(t => t.id === id);
      if (at >= 0) toasts[at] = { ...toasts[at]!, ...patch };
    },
    openReconnect: (accountId, mode) => void calls.push(`reconnect ${accountId} ${mode}`),
    openAddAccount: () => void calls.push('addAccount'),
    showWelcome: async () => welcome,
  };
  return {
    host: createSettingsHost(deps),
    calls,
    toasts,
    failWelcome: () => void (welcome = 'failed'),
  };
}

function handOff(node: unknown): { open(): void; onClose(): void } {
  assert.ok(isValidElement(node));
  return (node as ReactElement<{ open(): void; onClose(): void }>).props;
}

test('the reconnect row opens the shell reconnect sheet with its account and mode, then clears its own flag', () => {
  const { host, calls } = recorded();
  let closed = 0;
  const piece = handOff(host.renderReconnect?.('acct-1', 'grant', () => void (closed += 1)));
  piece.open();
  piece.onClose();
  assert.deepEqual(calls, ['reconnect acct-1 grant']);
  assert.equal(closed, 1);
});

test('Add an account opens the shell dialog instead of drawing its own', () => {
  const { host, calls } = recorded();
  let closed = 0;
  const piece = handOff(host.renderAddAccount?.(() => void (closed += 1)));
  piece.open();
  piece.onClose();
  assert.deepEqual(calls, ['addAccount']);
  assert.equal(closed, 1);
});

test('toast pushes a plain info toast; an undo for the change just toasted rides on that toast', () => {
  const { host, toasts } = recorded();
  let undone = 0;
  host.toast?.('Done is now L');
  host.pushUndo?.({ label: 'Done is now L', undo: () => void (undone += 1) });
  assert.equal(toasts.length, 1, 'one toast, not two');
  const [toast] = toasts;
  assert.equal(toast?.kind, 'info');
  assert.equal(toast?.undoable, true);
  assert.deepEqual(toast?.actions, [{ id: 'undo', label: 'Undo' }]);
  toast?.onAction?.('undo');
  assert.equal(undone, 1);
});

test('an undo with no matching toast gets its own toast', () => {
  const { host, toasts } = recorded();
  host.pushUndo?.({ label: 'Shortcuts reset', undo: () => {} });
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0]?.message, 'Shortcuts reset');
  assert.equal(toasts[0]?.undoable, true);
});

test('the undo action on the real toast stack runs the undo and closes the toast', () => {
  const host = createSettingsHost({
    pushToast,
    updateToast,
    openReconnect: () => {},
    openAddAccount: () => {},
    showWelcome: async () => 'opened',
  });
  let undone = 0;
  host.toast?.('Done is now L');
  host.pushUndo?.({ label: 'Done is now L', undo: () => void (undone += 1) });
  const [toast] = getToasts();
  assert.ok(toast);
  runToastAction(toast.id, 'undo');
  assert.equal(undone, 1);
  assert.equal(getToasts().length, 0);
});

test('Show welcome says so in words when the setup window could not open, and stays quiet otherwise', async () => {
  const quiet = recorded();
  quiet.host.showWelcome?.();
  await nextTask();
  assert.equal(quiet.toasts.length, 0);
  const failed = recorded();
  failed.failWelcome();
  failed.host.showWelcome?.();
  await nextTask();
  assert.equal(failed.toasts.length, 1);
  assert.match(failed.toasts[0]?.message ?? '', /couldn.t open the setup window/);
});

test('the shortcut sheet and live region have no shell home yet, so the host leaves them out', () => {
  const { host } = recorded();
  assert.equal(host.openShortcuts, undefined);
  assert.equal(host.announce, undefined);
});

test('a new pending target becomes the route; the same route again restarts the container; an old one changes nothing', () => {
  const first = routeFor(NO_ROUTE, target('settings/ai#provider', 1));
  assert.equal(first.route, 'settings/ai#provider');
  assert.equal(first.nonce, 0);
  assert.equal(routeFor(first, null), first, 'consuming the target keeps the route');
  assert.equal(routeFor(first, target('settings/ai#provider', 1)), first);
  const again = routeFor(first, target('settings/ai#provider', 2));
  assert.equal(again.route, 'settings/ai#provider');
  assert.equal(again.nonce, 1);
  const other = routeFor(again, target('settings/mail#undoSeconds', 3));
  assert.equal(other.nonce, 1, 'another row moves the same container');
});

test("choosing a section in Settings' own nav moves the route and drops the row", () => {
  const held = routeFor(NO_ROUTE, target('settings/ai#provider', 1));
  const chosen = routeChosen(held, 'settings/mail');
  assert.equal(chosen.route, 'settings/mail');
  assert.equal(chosen.seq, held.seq);
  assert.equal(routeChosen(chosen, 'settings/mail'), chosen);
});

const settingsShell = (client: Parameters<typeof renderScreen>[0]) =>
  renderToStaticMarkup(createElement(Shell, { renderScreen: s => renderScreen(client, s) }));

test('every Settings section opens through a route the palette produces', async () => {
  await boot();
  const client = {} as Parameters<typeof renderScreen>[0];
  for (const { id } of SETTING_SECTIONS) {
    openRoute(`settings/${id}`);
    const html = settingsShell(client);
    assert.match(html, /settings-screen/, `${id}: the real screen is mounted`);
    consumeRoute(getRoute()?.seq ?? 0);
    navigate('home');
  }
});

test('every palette Settings row runs to a route that becomes the container route with that section and row', () => {
  const registry = createAppRegistry();
  let seq = 0;
  for (const spec of SETTING_ROWS) {
    const result = registry.run(
      settingId(spec.section, spec.anchor),
      context(['global', 'palette']),
    );
    assert.equal(result.status, 'navigate', `${spec.section}.${spec.anchor}`);
    if (result.status !== 'navigate') continue;
    openRoute(result.route);
    const pending = getRoute();
    assert.ok(pending);
    seq += 1;
    const held = routeFor(NO_ROUTE, pending);
    assert.deepEqual(parseSettingRoute(held.route ?? ''), {
      section: spec.section,
      row: spec.anchor,
    });
    consumeRoute(pending.seq);
  }
  assert.ok(seq > 30, 'the whole manifest was walked');
});

test('a palette row route reaches the container: the section opens and the row is drawn', async () => {
  await boot();
  const client = {} as Parameters<typeof renderScreen>[0];
  openRoute('settings/mail#undoSend');
  const html = settingsShell(client);
  assert.match(html, /data-setting-section="mail"/);
  assert.match(html, /data-setting-anchor="undoSend"/);
  assert.doesNotMatch(html, /data-setting-section="general"/);
});

test('the Settings sidebar row and the app.settings key show the real screen; leaving clears the header part and sidebar slot', async () => {
  await boot();
  const client = {} as Parameters<typeof renderScreen>[0];
  navigate('settings');
  assert.match(settingsShell(client), /settings-screen/);
  assert.match(settingsShell(client), /data-setting-section="general"/);
  navigate('home');
  assert.doesNotMatch(settingsShell(client), /settings-screen/);
  assert.deepEqual(getPaneHeaderPart(), {});
  assert.equal(getSidebarSlot(), null);
});
