import test from 'node:test';
import assert from 'node:assert/strict';
import { Governor } from '../src/sync/governor';
import type { SyncLane as Lane } from '../src/ports';
import { ACCOUNT, FakeClock, MINUTE, maxWindow, refusal, req } from './sync-governor-helpers';

/** A stand-in for Google's per-user meter: 6,000 units in any 60 s, shared by every device. */
class SharedMeter {
  readonly calls: { at: number; units: number; device: string }[] = [];
  refusals = 0;
  constructor(
    private readonly clock: FakeClock,
    private readonly ceiling = 6_000,
  ) {}

  spend(device: string, units: number): void {
    const now = this.clock.now();
    const used = this.calls.filter(c => now - c.at < MINUTE).reduce((sum, c) => sum + c.units, 0);
    if (used + units > this.ceiling) {
      this.refusals++;
      throw refusal('throttle', { status: 429 });
    }
    this.calls.push({ at: now, units, device });
  }
}

test('a primary at 4,500 and a secondary at 1,500 share one 6,000 meter without a refusal', async () => {
  const clock = new FakeClock();
  const meter = new SharedMeter(clock);
  const devices = [
    {
      name: 'pro',
      governor: new Governor({ clock, role: 'primary' }),
      lanes: ['interactive', 'opFlush', 'incremental', 'backfill'] as Lane[],
      count: 400,
    },
    {
      name: 'air',
      governor: new Governor({ clock, role: 'secondary' }),
      lanes: ['interactive', 'incremental'] as Lane[],
      count: 200,
    },
  ];
  const runs = devices.flatMap(device =>
    Array.from({ length: device.count }, (_, i) => {
      const cost = [40, 120, 20, 5][i % 4];
      return device.governor.run(
        ACCOUNT,
        req(device.lanes[i % device.lanes.length], cost),
        async () => {
          meter.spend(device.name, cost);
          await clock.sleep(250);
        },
      );
    }),
  );
  await Promise.all(runs);
  assert.equal(meter.refusals, 0);
  const peak = maxWindow(meter.calls);
  assert.ok(peak <= 6_000, `combined peak ${peak}`);
  assert.ok(peak > 5_500, `the flood should use most of the meter, peak ${peak}`);
  assert.ok(maxWindow(meter.calls.filter(c => c.device === 'pro')) <= 4_500);
  assert.ok(maxWindow(meter.calls.filter(c => c.device === 'air')) <= 1_500);
});
