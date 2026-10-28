import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../src/kit/clock';

test('auto mode fast-forwards an hour of sleeps in real milliseconds', async () => {
  const clock = new FakeClock();
  const start = clock.now(), real = Date.now();
  const order: string[] = [];
  await Promise.all([
    clock.sleep(3600_000).then(() => order.push('hour')),
    clock.sleep(60_000).then(() => order.push('minute')),
    (async () => { for (let i = 0; i < 5; i++) await clock.sleep(1000); order.push('five seconds'); })(),
  ]);
  assert.deepEqual(order, ['five seconds', 'minute', 'hour']);
  assert.equal(clock.now() - start, 3600_000);
  assert.ok(Date.now() - real < 2000);
});

test('manual mode only moves on advance, and abort cancels a sleep', async () => {
  const clock = new FakeClock({ auto: false });
  let woke = false;
  void clock.sleep(1000).then(() => { woke = true; });
  const controller = new AbortController();
  const aborted = clock.sleep(5000, controller.signal);
  await clock.advance(999);
  assert.equal(woke, false);
  await clock.advance(1);
  assert.equal(woke, true);
  controller.abort(new Error('stop'));
  await assert.rejects(aborted, /stop/);
  assert.equal(clock.pending, 0);
});
