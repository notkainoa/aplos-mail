/**
 * Behaviour, accessibility and security fixes from review: overlay key contexts, the default Undo, command target
 * precedence, scope reset, sheet guards, failure toasts and the paused status. Pure logic, no DOM.
 */
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAppRegistry } from '../commands';
import { failedText, noAccountsKnown } from '../App';
import { dispatchShellKey, openOverlays, overlayContexts, shellKeyContext } from './keys-dispatch';
import { DEFAULT_HANDLERS, shellRegistryFor } from './ShellRegistry';
import { scopeIsStale } from './Shell';
import { accountGone, ownFrame, reconnectDefault } from './SheetHost';
import { runStatusAction } from './StatusHost';
import { toSyncStatus } from './status-map';
import { addTargetSlot, getTarget } from './store-target';
import { closeSheet, openSheet } from './index';
import { getToasts, resetToasts } from './store-toast';
import { DIAGNOSTICS_FAILED_COPY, RECONNECT_FAILED_COPY } from './failure-copy';
import type { StatusSlotState } from '../data';

type FakeEl = {
  parentElement: FakeEl | null;
  getAttribute(name: string): string | null;
  contains?(node: unknown): boolean;
};

/** A fake element chain: each entry is the attributes of one ancestor, innermost first. */
function chain(...levels: Record<string, string>[]): FakeEl {
  let parent: FakeEl | null = null;
  for (const attrs of [...levels].reverse())
    parent = { parentElement: parent, getAttribute: name => attrs[name] ?? null };
  return parent as FakeEl;
}

function key(init: { key: string; target?: unknown }): KeyboardEvent {
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

beforeEach(() => resetToasts());
afterEach(() => {
  closeSheet();
  Reflect.deleteProperty(globalThis, 'document');
});

// ---- 3: overlay contexts -------------------------------------------------------------------------------------

test('overlay contexts come from menu, dialog, palette, date picker roles and data-keyctx, outer to inner', () => {
  assert.deepEqual(overlayContexts(chain({ role: 'menuitem' }, { role: 'menu' }, {})), ['menu']);
  assert.deepEqual(overlayContexts(chain({}, { role: 'dialog', 'aria-modal': 'true' })), [
    'dialog',
  ]);
  assert.deepEqual(
    overlayContexts(chain({ role: 'option' }, { role: 'dialog', class: 'ui-palette__panel' })),
    ['palette'],
  );
  assert.deepEqual(
    overlayContexts(chain({ role: 'menuitem' }, { role: 'menu' }, { class: 'ui-date-presets' })),
    ['datePicker'],
  );
  assert.deepEqual(overlayContexts(chain({ 'data-keyctx': 'dialog, menu' })), ['dialog', 'menu']);
  assert.deepEqual(overlayContexts(chain({ role: 'menu' }, { role: 'dialog' })), [
    'dialog',
    'menu',
  ]);
  assert.deepEqual(overlayContexts(null), []);
  assert.deepEqual(overlayContexts(chain({}, {})), []);
});

test('a letter typed inside an open menu, dialog or popover does not reach the commands behind it', () => {
  const shell = shellRegistryFor(createAppRegistry());
  const calls: string[] = [];
  shell.register({ 'list.down': { run: () => void calls.push('down') } });
  const state = { stack: ['global', 'home'] as const, target: null, conditions: {} };
  const outside = chain({ tabindex: '0' });
  assert.equal(dispatchShellKey(shell.registry, state, key({ key: 'j', target: outside })), true);
  for (const around of [
    chain({ role: 'menuitem' }, { role: 'menu' }),
    chain({ role: 'button' }, { role: 'dialog', 'aria-modal': 'true' }),
    chain({}, { role: 'dialog', class: 'ui-palette__panel' }),
  ])
    assert.equal(dispatchShellKey(shell.registry, state, key({ key: 'j', target: around })), false);
  assert.deepEqual(calls, ['down']);
  const context = shellKeyContext(state, chain({ role: 'menuitem' }, { role: 'menu' }));
  assert.deepEqual(context.stack, ['global', 'list', 'home', 'menu']);
});

test('the focused element counts as well as the event target', () => {
  const menu = chain({ role: 'menu' });
  Object.assign(globalThis, { document: { activeElement: menu } });
  const context = shellKeyContext({ stack: ['global', 'home'], target: null, conditions: {} }, {});
  assert.ok(context.stack.includes('menu'));
});

// ---- 2: default app.undo -------------------------------------------------------------------------------------

test('the shell registry has an app.undo handler by default, and a screen can shadow it', () => {
  assert.ok(DEFAULT_HANDLERS['app.undo']);
  const shell = shellRegistryFor(createAppRegistry());
  const context = shellKeyContext(
    { stack: ['global', 'home'], target: null, conditions: {} },
    null,
  );
  // Without a connected data layer the default runs and its undo stack refuses: 'failed', not 'unhandled'.
  const log = console.error;
  console.error = () => undefined;
  try {
    assert.equal(shell.registry.run('app.undo', context).status, 'failed');
    const off = shell.register({ 'app.undo': { run: () => undefined } });
    assert.equal(shell.registry.run('app.undo', context).status, 'ran');
    off();
    assert.equal(shell.registry.run('app.undo', context).status, 'failed');
  } finally {
    console.error = log;
  }
});

test('a failing command logs its id and the error name, never the error itself', () => {
  const shell = shellRegistryFor(createAppRegistry());
  const logged: unknown[][] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    shell.register({
      'app.undo': {
        run: () => {
          throw new RangeError('subject: secret plans');
        },
      },
    });
    const context = shellKeyContext({ stack: ['global'], target: null, conditions: {} }, null);
    shell.registry.run('app.undo', context);
  } finally {
    console.error = log;
  }
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.length, 1);
  assert.match(String(logged[0]?.[0]), /app\.undo/);
  assert.match(String(logged[0]?.[0]), /RangeError/);
  assert.doesNotMatch(String(logged[0]?.[0]), /secret/);
});

// ---- 6: command target precedence ----------------------------------------------------------------------------

interface FakeRegion {
  name: string;
  parent?: FakeRegion;
  contains(node: unknown): boolean;
}

function region(name: string, parent?: FakeRegion): FakeRegion {
  const el: FakeRegion = {
    name,
    parent,
    contains(node: unknown): boolean {
      for (let n = node as { parent?: unknown } | undefined; n; n = n.parent as typeof n)
        if (n === el) return true;
      return false;
    },
  };
  return el;
}

test('the innermost focused setter wins, whatever the mount order; without focus the latest-mounted wins', () => {
  const outerEl = region('outer');
  const innerEl = region('inner', outerEl);
  const elsewhere = region('elsewhere');
  // React mounts a child's effects first: the nested setter registers before its parent.
  const inner = addTargetSlot({ current: innerEl });
  inner.set({ kind: 'event', id: 'inner', title: 'Inner' });
  const outer = addTargetSlot({ current: outerEl });
  outer.set({ kind: 'thread', id: 'outer', title: 'Outer' });
  Object.assign(globalThis, { document: { activeElement: elsewhere } });
  inner.set({ kind: 'event', id: 'inner', title: 'Inner', detail: 'x' });
  assert.equal(getTarget()?.id, 'outer', 'no focus inside any region: latest-mounted');
  Object.assign(globalThis, { document: { activeElement: innerEl } });
  inner.set({ kind: 'event', id: 'inner', title: 'Inner' });
  assert.equal(getTarget()?.id, 'inner', 'focus in the inner region');
  Object.assign(globalThis, { document: { activeElement: outerEl } });
  outer.set({ kind: 'thread', id: 'outer', title: 'Outer' });
  assert.equal(getTarget()?.id, 'outer', 'focus in the outer region only');
  inner.remove();
  outer.remove();
  assert.equal(getTarget(), null);
});

// ---- 7, 8, 13: scope, no-accounts gate, failure text ---------------------------------------------------------

test('a scope whose account is gone resets once accounts have loaded, including an empty list', () => {
  assert.equal(scopeIsStale('a1', [], false), false, 'not loaded yet');
  assert.equal(scopeIsStale('a1', [], true), true, 'no accounts left');
  assert.equal(scopeIsStale('a1', [{ id: 'a2' }], true), true);
  assert.equal(scopeIsStale('a1', [{ id: 'a1' }], true), false);
  assert.equal(scopeIsStale(null, [], true), false);
});

test('"no accounts" is a fact only once accounts loaded and the engine is not connecting', () => {
  assert.equal(noAccountsKnown(false, 'ready'), false);
  assert.equal(noAccountsKnown(true, 'connecting'), false);
  assert.equal(noAccountsKnown(true, 'ready'), true);
});

test('a failed Home read shows our sentence by error type, never the engine message', () => {
  assert.equal(failedText({ type: 'unavailable' }), 'Aplos can’t reach its mail engine.');
  assert.equal(failedText({ type: 'internal' }), 'Couldn’t load this list.');
  assert.equal(failedText({ type: 'validation' }), 'Couldn’t load this list.');
});

// ---- 15: sheet guards ----------------------------------------------------------------------------------------

test('a connect frame for another account is ignored; one without an account id is kept', () => {
  const frame = { connectId: 'c1', state: 'connected', accountId: 'other' };
  assert.equal(ownFrame(frame, 'a1'), undefined);
  assert.equal(ownFrame({ ...frame, accountId: 'a1' }, 'a1')?.state, 'connected');
  assert.equal(ownFrame({ connectId: 'c1', state: 'connected' }, 'a1')?.state, 'connected');
  assert.equal(ownFrame(undefined, 'a1'), undefined);
});

test('the sheet closes only when accounts have loaded and its account is gone', () => {
  assert.equal(accountGone(false, [], 'a1'), false);
  assert.equal(accountGone(true, [], 'a1'), true);
  assert.equal(accountGone(true, [{ id: 'a1' }], 'a1'), false);
});

// ---- 9: sheet.default ----------------------------------------------------------------------------------------

test('Return in the reconnect sheet tries again only when the flow failed', () => {
  let tries = 0;
  const retry = () => void (tries += 1);
  reconnectDefault(false, retry)();
  assert.equal(tries, 0);
  reconnectDefault(true, retry)();
  assert.equal(tries, 1);
});

// ---- 10: focus fallback --------------------------------------------------------------------------------------

test('when the opener unmounted, focus goes to the account switcher, else the main pane', () => {
  const focused: string[] = [];
  const el = (name: string) => ({
    focus: () => focused.push(name),
    hasAttribute: () => true,
    setAttribute: () => undefined,
  });
  let switcher: ReturnType<typeof el> | null = el('switcher');
  const doc = {
    activeElement: { focus: () => focused.push('opener'), isConnected: false },
    body: {},
    querySelector: (selector: string) =>
      selector === '.ui-account-switcher' ? switcher : el('pane'),
  };
  Object.assign(globalThis, { document: doc });
  openSheet('consent');
  closeSheet();
  switcher = null;
  openSheet('consent');
  closeSheet();
  assert.deepEqual(focused, ['switcher', 'pane']);
});

test('a failing cancel hook logs the sheet name and error name only', async () => {
  const { registerSheetCancel } = await import('./index');
  const off = registerSheetCancel(() => {
    throw new TypeError('token=abc');
  });
  const logged: unknown[][] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    openSheet('consent');
    openSheet('reconnect', { accountId: 'a1', mode: 'grant' });
  } finally {
    console.error = log;
    off();
  }
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0], ['sheet consent cancel hook failed (TypeError)']);
});

// ---- 11: failure toasts --------------------------------------------------------------------------------------

test('Retry now and Copy diagnostics say so when they fail', async () => {
  const state = { account: null, status: { state: 'offline' } } as unknown as StatusSlotState;
  runStatusAction('retry', state);
  runStatusAction('copyDiagnostics', state);
  await new Promise(resolve => setTimeout(resolve, 5));
  const messages = getToasts().map(t => t.message);
  assert.ok(messages.includes(RECONNECT_FAILED_COPY));
  assert.ok(messages.includes(DIAGNOSTICS_FAILED_COPY));
});

// ---- 12: paused without a time -------------------------------------------------------------------------------

test('a paused account with a missing or NaN until has no resume time', () => {
  const paused = (until: unknown) =>
    toSyncStatus({
      account: null,
      status: { state: 'paused', until, class: 'rate', reason: 'rate' },
      reasonCode: null,
      reconnectSoon: false,
      demo: false,
    } as unknown as StatusSlotState);
  assert.equal('resumeAt' in paused(undefined), false);
  assert.equal('resumeAt' in paused(Number.NaN), false);
  const ok = paused(Date.UTC(2026, 9, 29, 12));
  assert.ok('resumeAt' in ok && typeof ok.resumeAt === 'string');
});

// ---- round 3: dock open-tick, focus return, hold-A dictate fallback -------------------------------------

test('the dock opens only on an openTick change after mount, never on the stored value', async () => {
  const { dockRequest } = await import('./Shell');
  const { askStore } = await import('../screens/ask/askStore');
  // The engine went away and came back: a remounted frame sees the same tick and must not open.
  assert.equal(dockRequest(3, 3), undefined);
  assert.equal(dockRequest(0, 0), undefined);
  askStore.open('today');
  const now = askStore.get().openTick;
  assert.equal(dockRequest(now, now), undefined);
  assert.equal(dockRequest(now - 1, now), 'today');
});

test('focusDockButton matches the label element or aria-label, never the button text with a keycap', async () => {
  const { focusDockButton } = await import('./Shell');
  const focused: string[] = [];
  const button = (labelEl: string | null, aria: string | null, name: string) => ({
    textContent: `${labelEl ?? ''}A`,
    getAttribute: (attr: string) => (attr === 'aria-label' ? aria : null),
    querySelector: () => (labelEl === null ? null : { textContent: labelEl }),
    focus: () => focused.push(name),
  });
  const doc = {
    querySelectorAll: () => [
      button('Ask', null, 'ask'), // labelVisible Ask plus an inline "A" keycap in its textContent
      button(null, 'Today', 'today'),
    ],
  };
  Object.assign(globalThis, { document: doc });
  focusDockButton('ask');
  focusDockButton('today');
  assert.deepEqual(focused, ['ask', 'today']);
});

test('the shell ask.dictate fallback opens the dock and flags pending dictation for the host', async () => {
  const { shellCommands } = await import('./Shell');
  const { askStore } = await import('../screens/ask/askStore');
  const opened: string[] = [];
  const commands = shellCommands({
    openTab: tab => opened.push(tab),
    toggleDock: () => undefined,
    togglePalette: () => undefined,
    toggleSidebar: () => undefined,
  });
  askStore.update(s => ({ ...s, pendingDictation: undefined }));
  commands['ask.dictate']!.run({} as never);
  assert.deepEqual(opened, ['ask']);
  assert.equal(askStore.get().pendingDictation, true, 'the host will start listening on mount');
  // The hold ended before the host consumed the flag: the fallback's release drops it.
  commands['ask.dictate']!.release?.({} as never, {} as never);
  assert.equal(askStore.get().pendingDictation, undefined);
});

// ---- round 4: dock memory, focus-return guard, dock landmark -------------------------------------

test('the dock restores the remembered tab only when settings say it was open', async () => {
  const { dockSeed } = await import('./Shell');
  assert.equal(dockSeed({ open: false, tab: 'ask' }), 'closed', 'first run stays closed');
  assert.equal(dockSeed({ open: false, tab: 'today' }), 'closed');
  assert.equal(dockSeed({ open: true, tab: 'ask' }), 'ask');
  assert.equal(dockSeed({ open: true, tab: 'today' }), 'today', 'the remembered tab reopens');
});

test('the remembered {open, tab} patch keeps the last shown tab when closing', async () => {
  const { dockPersistPatch } = await import('./Shell');
  assert.deepEqual(dockPersistPatch('ask', 'ask'), { open: true, tab: 'ask' });
  assert.deepEqual(dockPersistPatch('today', 'ask'), { open: true, tab: 'today' });
  assert.deepEqual(
    dockPersistPatch('closed', 'today'),
    { open: false, tab: 'today' },
    'closing Today reopens Today next launch',
  );
});

test('closing the dock hands focus back only when the dock had it or nowhere did', async () => {
  const { dockFocusOrphaned } = await import('./Shell');
  const inDock = { closest: (s: string) => (s === '.ui-pane[data-kind="dock"]' ? {} : null) };
  const listRow = { closest: () => null };
  const body = {};
  Object.assign(globalThis, { document: { activeElement: inDock, body } });
  assert.equal(dockFocusOrphaned(), true, 'focus inside the dock pane');
  Object.assign(globalThis.document, { activeElement: body });
  assert.equal(dockFocusOrphaned(), true, 'the unmounted dock left body focused');
  Object.assign(globalThis.document, { activeElement: listRow });
  assert.equal(dockFocusOrphaned(), false, 'focus in the mail list keeps its place');
  Object.assign(globalThis.document, { activeElement: null });
  assert.equal(dockFocusOrphaned(), true, 'nothing focused');
});

test('the dock pane landmark names its tab', async () => {
  const { dockLabel } = await import('./Shell');
  assert.equal(dockLabel('ask'), 'Ask');
  assert.equal(dockLabel('today'), 'Today');
});

// ---- round 5: collapse focus handoff, modal-only overlay gate ---------------------------------

test('collapsing the sidebar hands focus to the strip toggle; expanding back lands on the region', async () => {
  const { sidebarCollapseFocus } = await import('./Shell');
  const { resetRegionFocus } = await import('./regions');
  resetRegionFocus();
  const focused: string[] = [];
  const mkEl = (name: string) => ({
    focus: () => focused.push(name),
    hasAttribute: () => true,
    setAttribute: () => undefined,
    getAttribute: (attr: string) => (attr === 'data-region' ? 'sidebar' : null),
    contains: () => false,
    querySelector: () => mkEl('row'),
    querySelectorAll: () => [],
  });
  const strip = mkEl('strip-toggle');
  const region = mkEl('sidebar');
  const body = {};
  const doc = {
    activeElement: body as unknown,
    body,
    documentElement: {},
    querySelector: (selector: string) =>
      selector === '.aplos-shell__strip button'
        ? strip
        : selector === '[data-region="sidebar"]'
          ? region
          : null,
  };
  Object.assign(globalThis, { document: doc });
  sidebarCollapseFocus(true);
  assert.deepEqual(focused, ['strip-toggle'], 'collapsed with the page shell focused');
  sidebarCollapseFocus(false);
  assert.equal(focused[1], 'row', 'expanding lands on the region target');
  // Focus kept somewhere else stays put on either direction.
  doc.activeElement = { listRow: true };
  focused.length = 0;
  sidebarCollapseFocus(true);
  sidebarCollapseFocus(false);
  assert.deepEqual(focused, [], 'a focused control keeps its place');
});

test('openOverlays counts real overlays only: a screen data-keyctx (reader, search, ask) is not one', () => {
  assert.deepEqual(openOverlays(chain({}, { 'data-keyctx': 'reader' })), []);
  assert.deepEqual(openOverlays(chain({}, { 'data-keyctx': 'search,list' })), []);
  assert.deepEqual(openOverlays(chain({}, { 'data-keyctx': 'ask' })), []);
  assert.deepEqual(openOverlays(chain({ role: 'menuitem' }, { role: 'menu' })), ['menu']);
  assert.deepEqual(openOverlays(chain({}, { role: 'dialog' }, { 'data-keyctx': 'reader' })), [
    'dialog',
  ]);
  assert.deepEqual(
    openOverlays(chain({ role: 'option' }, { role: 'dialog', class: 'ui-palette__panel' })),
    ['palette'],
  );
  assert.deepEqual(openOverlays(chain({}, { class: 'ui-date-presets' })), ['datePicker']);
  assert.deepEqual(openOverlays(null), []);
});
