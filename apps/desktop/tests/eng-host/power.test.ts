import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchPowerResume } from '../../src/host/power';

function setup(wake: () => void = () => {}) {
  const power = new EventEmitter();
  let wakes = 0;
  const unsubscribe = watchPowerResume(power, {
    wake: () => {
      wakes++;
      wake();
    },
  });
  return { power, unsubscribe, wakes: () => wakes };
}

test('resume calls wake once', () => {
  const { power, wakes } = setup();
  power.emit('resume');
  assert.equal(wakes(), 1);
});

test('unlock-screen calls wake', () => {
  const { power, wakes } = setup();
  power.emit('unlock-screen');
  assert.equal(wakes(), 1);
});

test('other power events do not wake the engine', () => {
  const { power, wakes } = setup();
  for (const event of ['suspend', 'lock-screen', 'on-ac', 'on-battery', 'shutdown'])
    power.emit(event);
  assert.equal(wakes(), 0);
});

test('unsubscribe stops wakes and removes the listeners', () => {
  const { power, unsubscribe, wakes } = setup();
  unsubscribe();
  power.emit('resume');
  power.emit('unlock-screen');
  assert.equal(wakes(), 0);
  assert.equal(power.listenerCount('resume') + power.listenerCount('unlock-screen'), 0);
});

test('a throwing wake does not throw out of the emitter', () => {
  const { power, wakes } = setup(() => {
    throw new Error('engine closed');
  });
  assert.doesNotThrow(() => power.emit('resume'));
  assert.doesNotThrow(() => power.emit('unlock-screen'));
  assert.equal(wakes(), 2);
});
