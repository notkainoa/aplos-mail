import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../src/kit/clock';

test('auto mode fast-forwards an hour of sleeps in real milliseconds', async () => {
  const clock = new FakeClock();
  const start = clock.now(),
    real = Date.now();
  const order: string[] = [];
  await Promise.all([
    clock.sleep(3600_000).then(() => order.push('hour')),
    clock.sleep(60_000).then(() => order.push('minute')),
    (async () => {
      for (let i = 0; i < 5; i++) await clock.sleep(1000);
      order.push('five seconds');
    })(),
  ]);
  assert.deepEqual(order, ['five seconds', 'minute', 'hour']);
  assert.equal(clock.now() - start, 3600_000);
  assert.ok(Date.now() - real < 2000);
});

test('manual mode only moves on advance, and abort cancels a sleep', async () => {
  const clock = new FakeClock({ auto: false });
  let woke = false;
  void clock.sleep(1000).then(() => {
    woke = true;
  });
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

test('a worker that writes a file between sleeps is not stamped late (auto mode and advance)', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'emu-clock-'));
  try {
    // Two workers: one only sleeps, the other persists a file after each wake-up, as a token store would.
    const run = async (clock: FakeClock, drive: (work: Promise<unknown>) => Promise<unknown>) => {
      const start = clock.now();
      const stamps: number[] = [];
      const writer = (async () => {
        for (let i = 0; i < 3; i++) {
          await clock.sleep(100);
          stamps.push(clock.now() - start);
          for (let n = 0; n < 3; n++)
            await writeFile(join(dir, `state-${n}.json`), JSON.stringify({ i, n }));
        }
      })();
      const ticker = (async () => {
        for (let i = 0; i < 6; i++) await clock.sleep(50);
      })();
      // A real-time guard only, so a regression fails the assertion instead of hanging the file.
      await Promise.race([
        drive(Promise.all([writer, ticker])),
        new Promise(resolve => setTimeout(resolve, 5000).unref()),
      ]);
      return stamps;
    };
    assert.deepEqual(await run(new FakeClock(), work => work), [100, 200, 300], 'auto mode');
    const manual = new FakeClock({ auto: false });
    assert.deepEqual(
      await run(manual, async work => {
        await manual.runUntilIdle();
        await work;
      }),
      [100, 200, 300],
      'advance',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
