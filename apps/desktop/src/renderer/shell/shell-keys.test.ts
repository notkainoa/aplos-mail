import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createAppRegistry } from '../commands';
import { dispatchShellKey, shellKeyContext } from './keys-dispatch';
import { shellRegistryFor } from './ShellRegistry';
import { addKeyLayer, layerConditions, shellStack } from './store-keys';
import { getScope, setScope } from './store-scope';
import { getScreen } from './store-route';
import { getOpenThread } from './store-thread';
import {
  closeThread,
  navigate,
  openThread,
  setAccountScope,
  useAccountScope,
  useHomeShellProps,
  useOpenThread,
  useShellRegistry,
} from './index';

type Fake = Partial<Omit<KeyboardEvent, 'target'>> & { key: string; target?: unknown };

function key(init: Fake): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    isComposing: false,
    ...init,
  } as unknown as KeyboardEvent;
}

function setup() {
  const shell = shellRegistryFor(createAppRegistry());
  const calls: string[] = [];
  const handlers = (tag: string) => ({ 'list.down': { run: () => void calls.push(tag) } });
  return { shell, calls, handlers };
}

const homeState = { stack: ['global', 'home'] as const, target: null, conditions: {} };

test('register attaches handlers; a later registration shadows until unregistered', () => {
  const { shell, calls, handlers } = setup();
  const off1 = shell.register(handlers('a'));
  const off2 = shell.register(handlers('b'));
  const event = key({ key: 'j' });
  assert.equal(dispatchShellKey(shell.registry, homeState, event), true);
  off2();
  dispatchShellKey(shell.registry, homeState, event);
  off1();
  assert.deepEqual(calls, ['b', 'a']);
  assert.equal(dispatchShellKey(shell.registry, homeState, event), false);
});

test('register with an unknown command id throws and attaches nothing', () => {
  const { shell, calls, handlers } = setup();
  assert.throws(() => shell.register({ ...handlers('a'), 'nope.nope': { run: () => undefined } }));
  assert.equal(dispatchShellKey(shell.registry, homeState, key({ key: 'j' })), false);
  assert.deepEqual(calls, []);
});

test('keys typed in a field, composing, or already handled are left alone', () => {
  const { shell, calls, handlers } = setup();
  shell.register(handlers('x'));
  const input = { tagName: 'INPUT', type: 'text' };
  assert.equal(
    dispatchShellKey(shell.registry, homeState, key({ key: 'j', target: input })),
    false,
  );
  assert.equal(
    dispatchShellKey(shell.registry, homeState, key({ key: 'j', isComposing: true })),
    false,
  );
  assert.equal(
    dispatchShellKey(shell.registry, homeState, key({ key: 'j', defaultPrevented: true })),
    false,
  );
  assert.deepEqual(calls, []);
});

test('the modal sheet context stops the screen behind it from answering', () => {
  const { shell, calls, handlers } = setup();
  shell.register(handlers('x'));
  const sheet = { ...homeState, stack: shellStack('home', true, []) };
  assert.equal(dispatchShellKey(shell.registry, sheet, key({ key: 'j' })), false);
  assert.deepEqual(calls, []);
});

test('the context carries the target, the conditions and the focus kind', () => {
  const target = { kind: 'thread' as const, id: 't1', title: 'Hi' };
  const context = shellKeyContext(
    { stack: ['global', 'reader'], target, conditions: { remindOffer: true } },
    { tagName: 'TEXTAREA' },
  );
  assert.equal(context.target, target);
  assert.equal(context.conditions.remindOffer, true);
  assert.equal(context.focus, 'text');
  assert.deepEqual(context.stack, ['global', 'list', 'reader']);
});

test('key layers add contexts and conditions, and leave when removed', () => {
  const layers: Parameters<typeof shellStack>[2] = [
    { contexts: ['lowImportance'], conditions: { remindOffer: true } },
  ];
  assert.deepEqual(shellStack('home', false, layers), ['global', 'home', 'lowImportance']);
  assert.deepEqual(shellStack('home', true, layers), ['global', 'home', 'lowImportance', 'sheet']);
  assert.equal(layerConditions(layers).remindOffer, true);
  const off = addKeyLayer({ contexts: ['dialog'] });
  off();
  off();
});

test('the account scope store: set, clear, read through the hook', () => {
  assert.equal(getScope(), null);
  setAccountScope('a1');
  assert.equal(getScope(), 'a1');
  assert.equal(renderToString(createElement(() => String(useAccountScope()))), 'a1');
  setScope(null);
  assert.equal(renderToString(createElement(() => String(useAccountScope()))), 'null');
});

test('openThread records the id and shows the thread screen; closeThread clears it', () => {
  openThread('th1');
  assert.equal(getOpenThread(), 'th1');
  assert.deepEqual(getScreen(), { label: 'thread' });
  assert.equal(renderToString(createElement(() => String(useOpenThread()))), 'th1');
  closeThread();
  assert.equal(getOpenThread(), null);
  navigate('home');
});

test('useHomeShellProps follows the scope and its openers navigate', () => {
  setAccountScope('a2');
  let props: ReturnType<typeof useHomeShellProps> | undefined;
  renderToString(
    createElement(() => {
      props = useHomeShellProps();
      return null;
    }),
  );
  assert.equal(props?.accountId, 'a2');
  props?.onOneByOne();
  assert.deepEqual(getScreen(), { label: 'one by one' });
  props?.onOpen('th9');
  assert.equal(getOpenThread(), 'th9');
  setScope(null);
  closeThread();
  navigate('home');
});

test('useShellRegistry outside a shell gives one shared registry', () => {
  const seen: unknown[] = [];
  renderToString(
    createElement(() => {
      seen.push(useShellRegistry(), useShellRegistry());
      return null;
    }),
  );
  assert.equal(seen[0], seen[1]);
});
