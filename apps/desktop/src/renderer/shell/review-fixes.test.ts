/**
 * Review fixes: place shortcuts navigate, a toast's Undo undoes its own operation, the shell menus take an active row,
 * and a reconnect is never requested for an account known to be missing. Pure logic and server rendering, no DOM.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createAppRegistry } from '../commands';
import { Menu } from '../ui/surfaces';
import type { MenuEntry } from '../ui/props';
import { dispatchShellKey } from './keys-dispatch';
import { accountEntries } from './AccountMenu';
import { firstEnabledId, resolveActive } from './menu-active';
import { minimisedEntries } from './MinimisedNav';
import { shellRegistryFor } from './ShellRegistry';
import { canStartFlow } from './SheetHost';
import { getScreen, setScreen } from './store-route';
import { getToasts, resetToasts } from './store-toast';
import { pushToast, runToastAction, setToastCommandRunner, setToastUndoRunner } from './index';
import type { PushedToast } from './index';

function ctrl(digit: string): KeyboardEvent {
  return {
    key: digit,
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    isComposing: false,
  } as unknown as KeyboardEvent;
}

const homeState = { stack: ['global', 'home'] as const, target: null, conditions: {} };

test('Ctrl+1..8 through the key dispatcher open the sidebar places', () => {
  const shell = shellRegistryFor(createAppRegistry());
  const expected = ['home', 'later', 'all', 'drafts', 'sent', 'calendar', 'trash', 'spam'];
  expected.forEach((screen, index) => {
    setScreen('settings');
    assert.equal(dispatchShellKey(shell.registry, homeState, ctrl(String(index + 1))), true);
    assert.equal(getScreen(), screen, `Ctrl+${index + 1}`);
  });
});

test('the Settings and Done place commands run through the registry too', () => {
  const shell = shellRegistryFor(createAppRegistry());
  const context = {
    stack: ['global'],
    target: null,
    selection: [],
    conditions: {},
    focus: 'none',
  } as never;
  setScreen('home');
  assert.equal(shell.registry.run('nav.done', context).status, 'ran');
  assert.equal(getScreen(), 'done');
  assert.equal(shell.registry.run('app.settings', context).status, 'ran');
  assert.equal(getScreen(), 'settings');
  setScreen('home');
});

const undoToast = (id: string): PushedToast => ({
  id,
  kind: 'bookmark',
  message: id,
  undoable: true,
  actions: [{ id: 'undo', label: 'Undo', commandId: 'app.undo' }],
});

beforeEach(() => resetToasts());

test('Undo on an older toast undoes that toast only and closes only it', () => {
  const undone: string[] = [];
  const commands: string[] = [];
  setToastUndoRunner(opId => {
    undone.push(opId);
    return true;
  });
  setToastCommandRunner(commandId => {
    commands.push(commandId);
    return { status: 'ran' };
  });
  pushToast(undoToast('op-a'));
  pushToast(undoToast('op-b'));
  runToastAction('op-a', 'undo');
  assert.deepEqual(undone, ['op-a']);
  assert.deepEqual(commands, [], 'the newest-change command is not used');
  assert.deepEqual(
    getToasts().map(t => t.id),
    ['op-b'],
  );
});

test('a refused targeted undo keeps its toast', () => {
  setToastUndoRunner(() => false);
  pushToast(undoToast('op-a'));
  runToastAction('op-a', 'undo');
  assert.deepEqual(
    getToasts().map(t => t.id),
    ['op-a'],
  );
});

const ENTRIES: readonly MenuEntry[] = [
  { kind: 'label', label: 'Places' },
  { kind: 'item', id: 'first', label: 'First', disabled: true },
  { kind: 'item', id: 'second', label: 'Second' },
  { kind: 'separator' },
  { kind: 'item', id: 'third', label: 'Third' },
];

test('the active row starts on the first enabled item and follows the owner while it stays valid', () => {
  assert.equal(firstEnabledId(ENTRIES), 'second');
  assert.equal(firstEnabledId([{ kind: 'separator' }]), undefined);
  assert.equal(resolveActive(ENTRIES, undefined), 'second');
  assert.equal(resolveActive(ENTRIES, 'third'), 'third');
  assert.equal(resolveActive(ENTRIES, 'first'), 'second', 'a disabled row cannot be active');
  assert.equal(resolveActive(ENTRIES, 'gone'), 'second');
});

function openMenu(entries: readonly MenuEntry[]): string {
  return renderToString(
    createElement(Menu, {
      open: true,
      anchor: null,
      label: 'Test',
      entries,
      activeId: resolveActive(entries, undefined),
      onActiveChange: () => undefined,
      onSelect: () => undefined,
      onClose: () => undefined,
    }),
  );
}

test('an open shell menu marks its first enabled row active, so Return can choose it', () => {
  const places = openMenu(minimisedEntries({}));
  assert.match(places, /aria-activedescendant="[^"]+-search"/);
  assert.equal((places.match(/data-active="true"/g) ?? []).length, 1);
  const accounts = openMenu(accountEntries([], () => undefined));
  assert.match(accounts, /aria-activedescendant="[^"]+-all-accounts"/);
});

test('a reconnect starts only once accounts are loaded and the account exists', () => {
  const accounts = [{ id: 'a1' }];
  assert.equal(canStartFlow(false, [], 'a1'), false, 'not before the list loads');
  assert.equal(canStartFlow(true, [], 'a1'), false, 'not for a missing account');
  assert.equal(canStartFlow(true, accounts, 'gone'), false);
  assert.equal(canStartFlow(true, accounts, 'a1'), true);
});
