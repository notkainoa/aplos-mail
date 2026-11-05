/**
 * Esc on the Search page (owner decision, F7): the screen's own keydown handler clears the field's text and tokens
 * and prevents the key from reaching the registry, so that Esc never navigates; on the already empty field Esc
 * falls through to `nav.back`, which the screen's attached handler sends to Home. Without a `nav.back` handler Esc
 * resolves to nothing — that is why it used to be swallowed. Real registry, fake DOM, like
 * screens/ask/ask.keys.test.ts.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/search/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppRegistry, type ContextName } from '../../commands';
import { dispatchShellKey, shellKeyContext, type ShellKeyState } from '../../shell/keys-dispatch';
import { shellRegistryFor } from '../../shell/ShellRegistry';

type Fake = Partial<Omit<KeyboardEvent, 'target'>> & { key: string; target?: unknown };

function key(init: Fake): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    isComposing: false,
    repeat: false,
    ...init,
  } as unknown as KeyboardEvent;
}

/** An element with the attributes it carries in the DOM, optionally under a parent. */
function el(attrs: Record<string, string>, parent?: unknown) {
  return {
    tagName: attrs.tagName ?? 'DIV',
    parentElement: parent ?? null,
    getAttribute: (name: string) => attrs[name] ?? null,
  };
}

/** The screen's `data-keyctx="search,list"` wrapper and the SearchField input inside it, as rendered. */
const SCREEN_ROOT = el({ 'data-keyctx': 'search,list', class: 'aplos-screen-fill' });
const FIELD = el({ tagName: 'INPUT', class: 'ui-search-field__input' }, SCREEN_ROOT);
/** A results row under the same screen. */
const ROW = el({ tagName: 'BUTTON', class: 'ui-list-row' }, SCREEN_ROOT);

const SEARCH: ShellKeyState = {
  stack: ['global', 'search', 'list'] as readonly ContextName[],
  target: null,
  conditions: {},
};

function setup() {
  const shell = shellRegistryFor(createAppRegistry());
  const calls: string[] = [];
  shell.register({ 'nav.back': { run: () => void calls.push('nav.back') } });
  const resolve = (event: KeyboardEvent) =>
    shell.registry.resolve(event, shellKeyContext(SEARCH, event.target));
  return { shell, calls, resolve };
}

test('Esc in the field resolves to nav.back once the screen attaches its handler', () => {
  const { shell, calls, resolve } = setup();
  const event = key({ key: 'Escape', target: FIELD });
  assert.equal(resolve(event)?.commandId, 'nav.back');
  assert.equal(dispatchShellKey(shell.registry, SEARCH, event), true);
  assert.deepEqual(calls, ['nav.back']);
});

test('Esc on a results row goes back the same way — no field to clear outside it', () => {
  const { resolve } = setup();
  assert.equal(resolve(key({ key: 'Escape', target: ROW }))?.commandId, 'nav.back');
});

test('without a nav.back handler Esc resolves to nothing, which is how it was swallowed', () => {
  const shell = shellRegistryFor(createAppRegistry());
  const event = key({ key: 'Escape', target: FIELD });
  assert.equal(shell.registry.resolve(event, shellKeyContext(SEARCH, FIELD)), null);
  assert.equal(dispatchShellKey(shell.registry, SEARCH, event), false);
});

test('the Esc that cleared the field is already prevented, so it never reaches nav.back', () => {
  const { shell, calls } = setup();
  const prevented = key({ key: 'Escape', target: FIELD, defaultPrevented: true });
  assert.equal(dispatchShellKey(shell.registry, SEARCH, prevented), false);
  assert.deepEqual(calls, []);
});
