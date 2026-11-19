// The sealed frame's relayed keys (sealedKeys.ts, layers.ts) in node with fakes: the event shape, the three guards
// and the letter rule. The same cases run end to end in `browser/mailframe.browser.spec.ts`.
// Run: cd apps/desktop && npx tsx --test src/renderer/mailframe/sealedKeys.test.ts

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { MAIL_KEYS } from '../../shared/mail-keys';
import { addKeyLayer } from '../shell/store-keys';
import { hideSheet, showSheet } from '../shell/store-sheet';
import { isAboveReader, KEY_LAYER_ATTRIBUTE, layerAbove, layerAboveReader } from './layers';
import {
  bridgeSubscribe,
  listenSealedKeys,
  mailKeyOfEvent,
  SEALED_READER_KEYS,
  sealedMailKey,
  type BridgeEvent,
  type SealedKeyGate,
} from './sealedKeys';
import type { MailFrameKey } from './types';

const mailKey = (key: unknown, extra: object = {}): BridgeEvent => ({
  type: 'mail-key',
  payload: { key, ...extra },
});

/** An iframe stand-in: `closest('[inert]')` answers from `inert`. */
function fakeFrame(inert = false) {
  return { closest: (selector: string) => (selector === '[inert]' && inert ? {} : null) };
}

/** The open gate: the frame is shown and focused, nothing above the reader. Override one part per case. */
function gate(overrides: Partial<SealedKeyGate> = {}, frame: unknown = fakeFrame()): SealedKeyGate {
  return {
    frame: () => frame,
    shown: () => true,
    focused: () => frame,
    layerAbove: () => false,
    ...overrides,
  };
}

const J: MailFrameKey = { key: 'j', shift: false, alt: false };
const K: MailFrameKey = { key: 'k', shift: false, alt: false };

describe('mailKeyOfEvent', () => {
  test('reads a listed key from a mail-key event and nothing else', () => {
    for (const key of MAIL_KEYS) assert.equal(mailKeyOfEvent(mailKey(key)), key);
    for (const key of ['r', 'R', 'e', ' ', 'Enter', 'Tab', 'Delete', 'jj', '', 'Esc', 'arrowdown'])
      assert.equal(mailKeyOfEvent(mailKey(key)), null, key);
    assert.equal(mailKeyOfEvent({ type: 'command', payload: { key: 'j' } }), null);
    assert.equal(mailKeyOfEvent({ type: 'mail-key' }), null);
    assert.equal(mailKeyOfEvent({ type: 'mail-key', payload: 'j' }), null);
    assert.equal(mailKeyOfEvent(null), null);
    assert.equal(mailKeyOfEvent('mail-key'), null);
  });

  test('never runs a getter: a key behind an accessor is dropped', () => {
    const payload = Object.defineProperty({}, 'key', { get: () => 'j', enumerable: true });
    assert.equal(mailKeyOfEvent({ type: 'mail-key', payload }), null);
  });
});

describe('sealedMailKey', () => {
  test('a listed key with focus in the shown letter goes out as its letter, no shift', () => {
    assert.deepEqual(sealedMailKey(mailKey('j'), gate()), J);
    assert.deepEqual(sealedMailKey(mailKey('Escape'), gate()), {
      key: 'Escape',
      shift: false,
      alt: false,
    });
  });

  test('the reader-side allowlist: j k J K and Escape only; scrolling keys stay with the letter', () => {
    assert.deepEqual([...SEALED_READER_KEYS], ['j', 'k', 'J', 'K', 'Escape']);
    for (const key of MAIL_KEYS) {
      const routed = sealedMailKey(mailKey(key), gate());
      if ((SEALED_READER_KEYS as readonly string[]).includes(key)) assert.ok(routed, key);
      else assert.equal(routed, null, key);
    }
    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])
      assert.equal(sealedMailKey(mailKey(key), gate()), null, key);
  });

  test('Caps Lock J and Shift+J are j: the letter decides, never a shift flag', () => {
    assert.deepEqual(sealedMailKey(mailKey('J'), gate()), J);
    assert.deepEqual(sealedMailKey(mailKey('J', { shift: false }), gate()), J);
    assert.deepEqual(sealedMailKey(mailKey('J', { shift: true }), gate()), J);
    assert.deepEqual(sealedMailKey(mailKey('K', { shift: false }), gate()), K);
    assert.deepEqual(sealedMailKey(mailKey('k', { shift: true }), gate()), K);
  });

  test('guard (a): focus elsewhere, a pending slot, an off-paper (inert) letter or no frame: dropped', () => {
    assert.equal(sealedMailKey(mailKey('j'), gate({ focused: () => ({}) })), null);
    assert.equal(sealedMailKey(mailKey('j'), gate({ focused: () => null })), null);
    assert.equal(sealedMailKey(mailKey('j'), gate({ shown: () => false })), null);
    assert.equal(sealedMailKey(mailKey('j'), gate({}, fakeFrame(true))), null);
    assert.equal(
      sealedMailKey(mailKey('j'), gate({ frame: () => null, focused: () => null })),
      null,
    );
  });

  test('guard (c): a layer above the reader drops every key, Esc first', () => {
    for (const key of SEALED_READER_KEYS)
      assert.equal(sealedMailKey(mailKey(key), gate({ layerAbove: () => true })), null, key);
  });
});

describe('listenSealedKeys', () => {
  function bus() {
    const listeners = new Set<(event: BridgeEvent) => void>();
    return {
      listeners,
      subscribe: (listener: (event: BridgeEvent) => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      deliver: (event: BridgeEvent) => listeners.forEach(l => l(event)),
    };
  }

  test('of several mounted slots only the focused, shown one hears a key, once; unsubscribe removes it', () => {
    const b = bus();
    const shown = fakeFrame();
    const pending = fakeFrame();
    const other = fakeFrame();
    let focused: unknown = shown;
    const heard: string[] = [];
    const slot = (name: string, frame: unknown, isShown: boolean) =>
      listenSealedKeys(
        b.subscribe,
        gate({ shown: () => isShown, focused: () => focused }, frame),
        key => heard.push(`${name}:${key.key}`),
      );
    const stops = [
      slot('shown', shown, true),
      slot('pending', pending, false),
      slot('other', other, true),
    ];
    b.deliver(mailKey('j'));
    assert.deepEqual(heard, ['shown:j']);
    focused = pending;
    b.deliver(mailKey('k'));
    assert.deepEqual(heard, ['shown:j']);
    focused = other;
    b.deliver(mailKey('K'));
    assert.deepEqual(heard, ['shown:j', 'other:k']);
    for (const stop of stops) stop();
    assert.equal(b.listeners.size, 0);
  });

  test('a throwing onKey does not skip the next subscriber (preload loops over its listeners)', () => {
    const b = bus();
    const frame = fakeFrame();
    const heard: string[] = [];
    listenSealedKeys(b.subscribe, gate({}, frame), () => {
      throw new Error('slot failed');
    });
    listenSealedKeys(b.subscribe, gate({}, frame), key => heard.push(key.key));
    // preload's delivery: `for (const listener of listeners) listener(event)`, no try/catch of its own.
    const deliver = (event: BridgeEvent) => {
      for (const listener of b.listeners) listener(event);
    };
    assert.doesNotThrow(() => deliver(mailKey('j')));
    assert.deepEqual(heard, ['j']);
  });
});

describe('bridgeSubscribe', () => {
  const view = globalThis as { window?: unknown };
  afterEach(() => {
    delete view.window;
  });

  test('null without a window, without a bridge or with a bridge that has no subscribe', () => {
    assert.equal(bridgeSubscribe(), null);
    view.window = {};
    assert.equal(bridgeSubscribe(), null);
    view.window = { aplos: { secret: 'host-only' } };
    assert.equal(bridgeSubscribe(), null);
  });

  test("subscribes through the bridge's own subscribe and hands back its unsubscribe", () => {
    const calls: unknown[][] = [];
    const stop = () => undefined;
    view.window = {
      aplos: {
        subscribe: (...args: unknown[]) => {
          calls.push(args);
          return stop;
        },
      },
    };
    const listener = () => undefined;
    assert.equal(bridgeSubscribe()?.(listener), stop);
    // `only` keeps this hook off the queue of deep-link / command events held for the app's first general subscriber (#293).
    assert.deepEqual(calls, [[listener, { only: ['mail-key'] }]]);
  });
});

/** An element stand-in for the overlay scan: attributes and a parent. */
function el(attrs: Record<string, string>, parentElement: unknown = null) {
  return {
    parentElement,
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
  } as unknown as Element;
}

describe('layers above the reader', () => {
  test('modal transients, the composer and Ask sit above the reader; the screens do not', () => {
    for (const c of [
      'menu',
      'dialog',
      'palette',
      'sheet',
      'datePicker',
      'lowImportance',
      'compose',
      'ask',
    ] as const)
      assert.equal(isAboveReader(c), true, c);
    for (const c of ['global', 'list', 'home', 'done', 'reader', 'oneByOne', 'search'] as const)
      assert.equal(isAboveReader(c), false, c);
  });

  test('read from the key layers, the sheet and the open overlays', () => {
    const reader = { contexts: ['reader'] } as const;
    const quiet = {
      layers: [reader],
      sheetOpen: false,
      overlays: [el({ 'data-keyctx': 'reader' })],
    };
    assert.equal(layerAbove(quiet), false);
    assert.equal(layerAbove({ ...quiet, layers: [reader, { contexts: ['compose'] }] }), true);
    assert.equal(
      layerAbove({ ...quiet, layers: [{ contexts: ['list', 'dialog'] }, reader] }),
      true,
    );
    assert.equal(layerAbove({ ...quiet, sheetOpen: true }), true);
    assert.equal(layerAbove({ ...quiet, overlays: [el({ role: 'dialog' })] }), true);
    assert.equal(layerAbove({ ...quiet, overlays: [el({ role: 'menu' })] }), true);
    assert.equal(layerAbove({ ...quiet, overlays: [el({ 'aria-modal': 'true' })] }), true);
    assert.equal(layerAbove({ ...quiet, overlays: [el({ role: 'alertdialog' })] }), true);
    assert.equal(layerAbove({ ...quiet, overlays: [el({ 'aria-modal': 'false' })] }), false);
    const presets = el({ class: 'ui-date-presets' });
    assert.equal(layerAbove({ ...quiet, overlays: [el({ role: 'menu' }, presets)] }), true);
    assert.equal(layerAbove({ ...quiet, overlays: [el({ [KEY_LAYER_ATTRIBUTE]: 'find' })] }), true);
  });

  test('the live check follows the shell: a composer layer or a sheet, then neither', () => {
    const reader = addKeyLayer({ contexts: ['reader'] });
    assert.equal(layerAboveReader(), false);
    const compose = addKeyLayer({ contexts: ['compose'] });
    assert.equal(layerAboveReader(), true);
    compose();
    showSheet({ name: 'reconnect', args: {} } as Parameters<typeof showSheet>[0]);
    assert.equal(layerAboveReader(), true);
    hideSheet();
    assert.equal(layerAboveReader(), false);
    reader();
  });
});
