/**
 * The dock's keys stay inside the dock: the host's key layer contributes only the resolver's conditions, and the
 * 'ask' context comes from the dock root's `data-keyctx="ask"` — while the dock is open, its commands answer only
 * while focus is inside it, never in the mail list, a compose field or Settings (review finding 1). A held A in
 * the dock's field dictates because the field carries `data-dictation="body"` (finding 3). Real registry, fake
 * DOM and clock, like shell/hold-keys.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppRegistry, createHoldTracker, type HoldRelease } from '../../commands';
import type { ContextName } from '../../commands';
import {
  dispatchShellKey,
  overlayContexts,
  shellKeyContext,
  type ShellHold,
  type ShellKeyState,
} from '../../shell/keys-dispatch';
import { shellRegistryFor } from '../../shell/ShellRegistry';
import { askKeyLayer, dockView, initialAsk, type AskInputs } from './ask.model';

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

/** The dock root's `data-keyctx="ask"` wrapper and the Ask field inside it, as rendered. */
const DOCK_ROOT = el({ 'data-keyctx': 'ask', class: 'ask-screen' });
const ASK_FIELD = el(
  { tagName: 'TEXTAREA', class: 'ui-ask-dock__input', 'data-dictation': 'body' },
  DOCK_ROOT,
);
/** A field outside the dock (a search or settings field, the compose body). */
const OUTSIDE_FIELD = el({ tagName: 'TEXTAREA', class: 'ui-search-field__input' });
/** A dock control that is not a text field: Esc there still runs the ask ladder. */
const DOCK_BUTTON = el({ tagName: 'BUTTON', class: 'ui-ask-dock__tab' }, DOCK_ROOT);

const HOME: ShellKeyState = {
  stack: ['global', 'home'] as readonly ContextName[],
  target: null,
  conditions: {},
};

/** A command only resolves while it has an attached handler (the host's `useRegisterCommands`). */
const HANDLED = [
  'ask.previousSuggestion',
  'ask.nextSuggestion',
  'ask.submit',
  'ask.searchAllMail',
  'ask.sendNow',
  'ask.newChat',
  'ask.stop',
  'ask.clear',
  'ask.close',
  'ask.declineProposal',
  'ask.acceptProposal',
  'nav.back',
  'list.up',
  'list.down',
  'mail.open',
] as const;

function setup() {
  const shell = shellRegistryFor(createAppRegistry());
  const calls: string[] = [];
  shell.register(Object.fromEntries(HANDLED.map(id => [id, { run: () => void calls.push(id) }])));
  const resolve = (event: KeyboardEvent, state: ShellKeyState = HOME) =>
    shell.registry.resolve(event, shellKeyContext(state, event.target));
  return { shell, calls, resolve };
}

test('the mounted dock contributes only conditions to the key stack — never the ask context', () => {
  const view = dockView(
    { ...initialAsk, field: 'q', queued: [{ id: 'q1', text: 'f?', searchAll: false }] },
    {
      frames: [],
      providers: [],
      askReady: true,
      calendars: new Map(),
      suggestions: [],
      recents: [],
    } as AskInputs,
  );
  const layer = askKeyLayer(view, true);
  assert.equal('contexts' in layer, false, 'the layer must not hold the ask context on the stack');
  assert.equal(layer.conditions.askText, true);
  assert.equal(layer.conditions.queued, true);
});

test('inside the dock the ask commands resolve', () => {
  const { resolve } = setup();
  const inside = [
    [key({ key: 'ArrowUp', target: ASK_FIELD }), 'ask.previousSuggestion'],
    [key({ key: 'ArrowDown', target: ASK_FIELD }), 'ask.nextSuggestion'],
    [key({ key: 'Enter', target: ASK_FIELD }), 'ask.submit'],
    [key({ key: 'Enter', metaKey: true, target: ASK_FIELD }), 'ask.searchAllMail'],
    [key({ key: 'n', metaKey: true, target: ASK_FIELD }), 'ask.newChat'],
    [key({ key: 'Escape', target: ASK_FIELD }), 'ask.close'],
    [key({ key: 'Escape', target: DOCK_BUTTON }), 'ask.close'],
  ] as const;
  for (const [event, commandId] of inside) {
    assert.equal(resolve(event)?.commandId, commandId, `${event.key} inside the dock`);
  }
});

test('⌘Return with a queued card resolves ask.sendNow before ask.searchAllMail', () => {
  const { resolve } = setup();
  const state: ShellKeyState = { ...HOME, conditions: { queued: true } };
  const event = key({ key: 'Enter', metaKey: true, target: ASK_FIELD });
  assert.equal(resolve(event, state)?.commandId, 'ask.sendNow');
});

test('outside the dock, the same keys never resolve an ask command', () => {
  const { resolve } = setup();
  const outside = [
    key({ key: 'ArrowUp', target: OUTSIDE_FIELD }),
    key({ key: 'ArrowDown', target: OUTSIDE_FIELD }),
    key({ key: 'Enter', target: OUTSIDE_FIELD }),
    key({ key: 'Enter', metaKey: true, target: OUTSIDE_FIELD }),
    key({ key: 'n', metaKey: true, target: OUTSIDE_FIELD }),
    key({ key: 'Escape', target: OUTSIDE_FIELD }),
  ];
  for (const event of outside) {
    const commandId = resolve(event)?.commandId;
    assert.ok(
      commandId === undefined || !commandId.startsWith('ask.'),
      `${event.key} outside the dock resolved ${commandId}`,
    );
  }
  // Esc outside still navigates back; the ask ladder belongs to the dock.
  assert.equal(resolve(key({ key: 'Escape', target: OUTSIDE_FIELD }))?.commandId, 'nav.back');
});

test('the dock root declares the ask context for the DOM scan, not a mounted layer', () => {
  assert.deepEqual(overlayContexts(ASK_FIELD), ['ask']);
  assert.deepEqual(overlayContexts(OUTSIDE_FIELD), []);
});

/* ── hold-A dictation (finding 3) ── */

interface Timer {
  readonly at: number;
  readonly run: () => void;
  cancelled: boolean;
}

function holdSetup() {
  const shell = shellRegistryFor(createAppRegistry());
  const calls: string[] = [];
  const releases: HoldRelease[] = [];
  shell.register({
    'ask.dictate': {
      run: () => void calls.push('ask.dictate'),
      release: (_ctx: unknown, release: HoldRelease) => void releases.push(release),
    },
  });
  let now = 0;
  const timers: Timer[] = [];
  let removed = 0;
  const hold: ShellHold = {
    tracker: createHoldTracker(250),
    now: () => now,
    schedule(ms, run) {
      const timer: Timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    readState: () => HOME,
    focused: () => ASK_FIELD,
    removeTyped: () => {
      removed++;
    },
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const timer of timers.splice(0)) {
      if (timer.cancelled) continue;
      if (timer.at <= now) timer.run();
      else timers.push(timer);
    }
  };
  const down = (event: KeyboardEvent) => dispatchShellKey(shell.registry, HOME, event, hold);
  return { calls, releases, advance, down, removed: () => removed };
}

test('a held A in the Ask field dictates; the typed a is removed', () => {
  const kit = holdSetup();
  assert.equal(
    kit.down(key({ key: 'a', code: 'KeyA', target: ASK_FIELD })),
    false,
    'the keydown types the a',
  );
  kit.advance(250);
  assert.deepEqual(kit.calls, ['ask.dictate']);
  assert.equal(kit.removed(), 1, 'the typed a is deleted once dictation starts');
});

test('a held A in a field without data-dictation just types', () => {
  const kit = holdSetup();
  const other = el({ tagName: 'TEXTAREA' }, DOCK_ROOT);
  assert.equal(kit.down(key({ key: 'a', code: 'KeyA', target: other })), false);
  kit.advance(500);
  assert.deepEqual(kit.calls, []);
  assert.equal(kit.removed(), 0);
});
