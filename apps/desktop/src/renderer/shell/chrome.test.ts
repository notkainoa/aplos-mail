/**
 * Window chrome state (chrome.ts): the fullscreen signal, the persisted sidebar collapse and the macOS
 * traffic-light check, plus the `app.sidebar` wiring and the Help row's Settings route.
 * Run: `cd apps/desktop && npx tsx --test src/renderer/shell/chrome.test.ts`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMANDS } from '../commands/catalog';
import {
  getChrome,
  isMacChrome,
  listenFullscreen,
  readCollapsed,
  setCollapsed,
  setFullscreen,
  SIDEBAR_COLLAPSED_KEY,
  toggleCollapsed,
  writeCollapsed,
  type ChromeBridge,
  type ChromeStorage,
} from './chrome';
import { placeRoute, placeScreen } from './nav';
import { DEFAULT_HANDLERS, placeHandlers } from './ShellRegistry';
import { closeShortcuts, getShortcutsOpenForTest } from './store-shortcuts';
import { getRoute, getScreen, setScreen } from './store-route';
import { shellCommands } from './Shell';
import { context } from '../commands/testing';

function fakeStorage(): ChromeStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

function fakeBridge() {
  const listeners = new Set<Parameters<ChromeBridge['subscribe']>[0]>();
  const options: unknown[] = [];
  const bridge: ChromeBridge = {
    subscribe(listener, opts) {
      listeners.add(listener);
      options.push(opts);
      return () => listeners.delete(listener);
    },
  };
  return {
    bridge,
    options,
    send: (event: { type: string; payload?: unknown }) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

test('isMacChrome: only macOS reserves the traffic-light row', () => {
  assert.equal(isMacChrome('MacIntel', undefined), true);
  assert.equal(isMacChrome('MacPPC', undefined), true);
  assert.equal(isMacChrome('Win32', undefined), false);
  assert.equal(isMacChrome('Linux x86_64', undefined), false);
  // Platform is missing on some surfaces: the user agent is the fallback.
  assert.equal(isMacChrome(undefined, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), true);
  assert.equal(isMacChrome(undefined, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), false);
  assert.equal(isMacChrome(undefined, undefined), false);
});

test('collapsed state persists under aplos.sidebar.collapsed and reads back guarded', () => {
  const storage = fakeStorage();
  assert.equal(readCollapsed(storage), false, 'absent key is expanded');
  writeCollapsed(true, storage);
  assert.equal(storage.data.get(SIDEBAR_COLLAPSED_KEY), 'true');
  assert.equal(readCollapsed(storage), true);
  writeCollapsed(false, storage);
  assert.equal(readCollapsed(storage), false);
  // A throwing or absent storage reads as expanded instead of failing.
  assert.equal(readCollapsed(undefined), false);
  const denied: ChromeStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  };
  assert.equal(readCollapsed(denied), false);
  assert.doesNotThrow(() => writeCollapsed(true, denied));
});

test('the fullscreen bridge event drives the chrome store, typed and guarded', () => {
  const was = getChrome().fullscreen;
  try {
    const fake = fakeBridge();
    const stop = listenFullscreen(fake.bridge);
    assert.deepEqual(fake.options, [{ only: ['fullscreen'] }]);
    fake.send({ type: 'fullscreen', payload: { fullscreen: true } });
    assert.equal(getChrome().fullscreen, true);
    fake.send({ type: 'fullscreen', payload: { fullscreen: false } });
    assert.equal(getChrome().fullscreen, false);
    // Malformed events and other types are ignored.
    fake.send({ type: 'fullscreen' });
    fake.send({ type: 'fullscreen', payload: { fullscreen: 'yes' } });
    fake.send({ type: 'command', payload: { fullscreen: true } });
    assert.equal(getChrome().fullscreen, false);
    stop();
    fake.send({ type: 'fullscreen', payload: { fullscreen: true } });
    assert.equal(getChrome().fullscreen, false, 'unsubscribed');
  } finally {
    setFullscreen(was);
  }
});

test('no bridge (the browser preview) leaves the default windowed state and unsubscribes safely', () => {
  assert.doesNotThrow(() => listenFullscreen(undefined)());
});

test('toggleCollapsed flips the store and writes the persisted flag', () => {
  const storage = fakeStorage();
  const was = getChrome().collapsed;
  try {
    setCollapsed(true, storage);
    assert.equal(getChrome().collapsed, true);
    assert.equal(storage.data.get(SIDEBAR_COLLAPSED_KEY), 'true');
    toggleCollapsed(storage);
    assert.equal(getChrome().collapsed, false);
    assert.equal(storage.data.get(SIDEBAR_COLLAPSED_KEY), 'false');
    toggleCollapsed(storage);
    assert.equal(getChrome().collapsed, true);
  } finally {
    setCollapsed(was, storage);
  }
});

test('shellCommands registers app.sidebar: the key, palette entry and button share the toggle', () => {
  let toggled = 0;
  const commands = shellCommands({
    openTab: () => undefined,
    toggleDock: () => undefined,
    togglePalette: () => undefined,
    toggleSidebar: () => void (toggled += 1),
  });
  commands['app.sidebar']!.run(context(['global']));
  assert.equal(toggled, 1);
  commands['app.sidebar']!.run(context(['global']));
  assert.equal(toggled, 2);
});

test('app.sidebar binds [ and ⌘S, and nothing else binds ⌘S outside a text field', () => {
  const spec = COMMANDS.find(c => c.id === 'app.sidebar');
  assert.ok(spec, 'app.sidebar is in the catalog');
  assert.deepEqual(spec!.keys, ['[', 'meta+s']);
  const others = COMMANDS.filter(
    c =>
      c.id !== 'app.sidebar' &&
      c.keys.some(k =>
        typeof k === 'string' ? k === 'meta+s' : k.chord === 'meta+s' && k.inTextField !== true,
      ),
  );
  assert.deepEqual(
    others.map(c => c.id),
    [],
    'no other command may take ⌘S outside a text-field binding',
  );
});

test('the Help place opens Settings at its help section: screen settings, route settings/help', () => {
  assert.equal(placeScreen('help'), 'settings');
  assert.equal(placeRoute('help'), 'settings/help');
  assert.equal(placeRoute('home'), null);
});

test('the Help place handler deep-links settings/help (the shell’s own app.shortcuts, ?, opens the sheet instead)', () => {
  setScreen('home');
  const handlers = placeHandlers();
  handlers['app.shortcuts']!.run(context(['global']));
  assert.equal(getScreen(), 'settings');
  assert.equal(getRoute()?.route, 'settings/help');
  assert.equal(getRoute()?.section, 'help');
  setScreen('home'); // drops the pending route
  assert.equal(getRoute(), null);
});

test('? opens the shortcut sheet, and the sidebar Help row still goes to Help & about', () => {
  closeShortcuts();
  assert.equal(getShortcutsOpenForTest(), false);
  DEFAULT_HANDLERS['app.shortcuts']!.run(context(['global']));
  assert.equal(getShortcutsOpenForTest(), true);
  closeShortcuts();
  assert.equal(placeRoute('help'), 'settings/help');
});
