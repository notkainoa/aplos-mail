import test from 'node:test';
import assert from 'node:assert/strict';
import { createKillSwitch, isKilled, KilledError } from '../src/kit/killpoints';

test('an unarmed checkpoint only counts hits', () => {
  const kill = createKillSwitch();
  kill.checkpoint('before-send-marker');
  kill.checkpoint('before-send-marker');
  assert.deepEqual({ ...kill.hits }, { 'before-send-marker': 2 });
});

test('armed checkpoint throws KilledError once, then the point is quiet again', () => {
  const kill = createKillSwitch();
  kill.arm('after-api-send');
  kill.checkpoint('other');
  assert.throws(
    () => kill.checkpoint('after-api-send'),
    (e: unknown) => isKilled(e, 'after-api-send') && e instanceof KilledError,
  );
  kill.checkpoint('after-api-send');
  assert.deepEqual([...kill.kills], ['after-api-send']);
  assert.equal(kill.hits['after-api-send'], 2);
});

test('after: N lets N passes go by and kills on the next', () => {
  const kill = createKillSwitch();
  kill.arm('step', { after: 2 });
  kill.checkpoint('step');
  kill.checkpoint('step');
  assert.throws(() => kill.checkpoint('step'), isKilled);
  kill.checkpoint('step');
});

test('disarm cancels one name or all', () => {
  const kill = createKillSwitch();
  kill.arm('a');
  kill.arm('b');
  kill.disarm('a');
  kill.checkpoint('a');
  assert.throws(() => kill.checkpoint('b'), isKilled);
  kill.arm('a');
  kill.arm('b');
  kill.disarm();
  kill.checkpoint('a');
  kill.checkpoint('b');
});

test('isKilled rejects other errors and other points; checkpoint works as a bare hook', () => {
  assert.equal(isKilled(new Error('x')), false);
  assert.equal(isKilled(new KilledError('a'), 'b'), false);
  const kill = createKillSwitch();
  const hook = kill.checkpoint;
  kill.arm('p');
  assert.throws(() => hook('p'), isKilled);
});
