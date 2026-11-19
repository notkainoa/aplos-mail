// inputIntent: the real-input tracking that gates key-hint tooltips. Run from the repo root:
// npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/buttons-keys/inputIntent.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  realKeySeen,
  realPointerOf,
  realPointerSeen,
  resetInputIntent,
  watchInputIntent,
  type IntentSource,
} from './inputIntent';

/** A fake event source: captures the listeners and fires plain objects at them. */
function fakeSource() {
  const listeners = new Map<string, ((event: never) => void)[]>();
  const source: IntentSource = {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  const fire = (type: string, event: object) => {
    for (const listener of listeners.get(type) ?? []) listener(event as never);
  };
  return { source, fire };
}

test('realPointerOf: only a nonzero delta is real movement', () => {
  assert.equal(realPointerOf({ movementX: 0, movementY: 0 }), false);
  assert.equal(realPointerOf({ movementX: 1, movementY: 0 }), true);
  assert.equal(realPointerOf({ movementX: 0, movementY: -1 }), true);
  assert.equal(realPointerOf({}), false);
});

test('watchInputIntent: a keydown marks the keyboard real; a resting cursor does not mark the pointer', () => {
  resetInputIntent();
  const { source, fire } = fakeSource();
  watchInputIntent(source);
  assert.equal(realKeySeen(), false);
  assert.equal(realPointerSeen(), false);
  // A stationary launch cursor produces a zero-delta move at most: never real.
  fire('pointermove', { movementX: 0, movementY: 0 });
  assert.equal(realPointerSeen(), false);
  fire('keydown', {});
  assert.equal(realKeySeen(), true);
  assert.equal(realPointerSeen(), false);
  fire('pointermove', { movementX: 4, movementY: 1 });
  assert.equal(realPointerSeen(), true);
});

test('watchInputIntent: a pointer press is real too; the same source binds once', () => {
  resetInputIntent();
  const { source, fire } = fakeSource();
  watchInputIntent(source);
  watchInputIntent(source);
  fire('pointerdown', {});
  assert.equal(realPointerSeen(), true);
});
