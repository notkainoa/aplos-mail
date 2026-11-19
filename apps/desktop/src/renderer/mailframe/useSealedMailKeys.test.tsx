// The sealed slot hook (useSealedMailKeys.ts) mounted for real with react-dom and a bare container (the component
// renders nothing, so no DOM is needed): a key reaches `onKey` while mounted and never after unmount. The browser spec
// covers the same unsubscribe in a real page.
// Run: cd apps/desktop && npx tsx --test src/renderer/mailframe/useSealedMailKeys.test.tsx

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { act, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import type { BridgeEvent, MailKeySubscribe } from './sealedKeys';
import type { MailFrameKey } from './types';
import { useSealedMailKeys } from './useSealedMailKeys';

const glob = globalThis as {
  document?: unknown;
  window?: unknown;
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const frame = { closest: () => null };
const frameRef = { current: frame } as unknown as RefObject<Element | null>;
let savedDocument: unknown;
let savedWindow: unknown;

beforeEach(() => {
  savedDocument = glob.document;
  savedWindow = glob.window;
  glob.window = { HTMLIFrameElement: class {} };
  glob.document = { activeElement: frame };
  glob.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  glob.document = savedDocument;
  glob.window = savedWindow;
});

/** A relay with the listener set a test can inspect: `send` calls every listener still subscribed. */
function fakeRelay() {
  const listeners = new Set<(event: BridgeEvent) => void>();
  const subscribe: MailKeySubscribe = listener => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const send = (key: string) => {
    for (const listener of [...listeners]) listener({ type: 'mail-key', payload: { key } });
  };
  return { subscribe, send, count: () => listeners.size };
}

function mount(subscribe: MailKeySubscribe, onKey: (key: MailFrameKey) => void) {
  function Slot() {
    useSealedMailKeys(frameRef, { shown: true, onKey, subscribe, layerAbove: () => false });
    return null;
  }
  const doc = {
    nodeType: 9,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const container = {
    ...doc,
    nodeType: 1,
    tagName: 'DIV',
    textContent: '',
    ownerDocument: doc,
  } as unknown as Element;
  const root = createRoot(container);
  act(() => root.render(<Slot />));
  return () => act(() => root.unmount());
}

describe('useSealedMailKeys', () => {
  test('hands an accepted key to onKey while mounted and nothing once unmounted', () => {
    const relay = fakeRelay();
    const seen: string[] = [];
    const unmount = mount(relay.subscribe, key => seen.push(key.key));
    assert.equal(relay.count(), 1);
    relay.send('j');
    assert.deepEqual(seen, ['j']);
    unmount();
    assert.equal(relay.count(), 0);
    relay.send('j');
    relay.send('Escape');
    assert.deepEqual(seen, ['j']);
  });
});
