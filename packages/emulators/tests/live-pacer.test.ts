import test from 'node:test';
import assert from 'node:assert/strict';
import { costOf, GMAIL_UNIT_COSTS } from '../src/index';
import { GUARD_API_METHODS } from '../../../apps/desktop/scripts/live/guard';
import {
  createPacedFetch,
  GMAIL_COST_TABLE_KEYS,
  RUN_UNIT_BUDGET,
  unitCost,
  UnitPacer,
  WINDOW_MS,
} from '../../../apps/desktop/scripts/live/pacer';

/** A virtual clock: sleeping just moves time forward. */
function virtualTime() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => void (t += ms),
    advance: (ms: number) => void (t += ms),
  };
}

test("the unit table agrees with the emulator's table, and every Gmail call the guard can send has a price", () => {
  for (const key of GMAIL_COST_TABLE_KEYS) {
    if (!(key in GMAIL_UNIT_COSTS)) continue;
    assert.equal(unitCost(key, 'minimal'), costOf(key, 'minimal'), key);
    assert.equal(unitCost(key, 'full'), costOf(key, 'full'), key);
    assert.equal(
      unitCost(key, null),
      costOf(key, null),
      `${key} without a format is priced as full`,
    );
  }
  for (const api of GUARD_API_METHODS.filter(name => name.startsWith('gmail.')))
    assert.ok(GMAIL_COST_TABLE_KEYS.includes(api), `${api} has no unit cost`);
  assert.equal(unitCost('calendar.events.list', null), 0);
  assert.equal(unitCost('oauth.token', null), 0);
});

test('stays under 3,000 units in every 60 s window while firing a thousand thread reads', async () => {
  const time = virtualTime();
  const pacer = new UnitPacer({ now: time.now, sleep: time.sleep });
  const sentAt: number[] = [];
  const paced = createPacedFetch(async () => {
    sentAt.push(time.now());
    return new Response('{}');
  }, pacer);

  for (let i = 0; i < 1000; i++)
    await paced(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${i.toString(16)}?format=metadata`,
    );
  assert.equal(sentAt.length, 1000);

  // Independent check from the send times: any window (t - 60 s, t] holds under 3,000 units.
  const cost = 40;
  let worst = 0;
  for (const t of sentAt) {
    const inWindow = sentAt.filter(at => at <= t && at > t - WINDOW_MS).length * cost;
    worst = Math.max(worst, inWindow);
  }
  assert.ok(worst < 3000, `window held ${worst} units`);
  assert.ok(worst > 2000, 'the pacer should use most of its budget, not crawl');
  assert.equal(pacer.peakWindow(), worst);
  assert.ok(pacer.peakWindow() <= RUN_UNIT_BUDGET);
  const series = pacer.series();
  assert.equal(
    series.reduce((a, b) => a + b, 0),
    1000 * cost,
  );
  assert.ok(series.length >= 13, 'forty thousand units cannot fit in fewer minutes');
});

test('parallel callers share one budget', async () => {
  const time = virtualTime();
  const pacer = new UnitPacer({ now: time.now, sleep: time.sleep });
  const charges: number[] = [];
  await Promise.all(
    Array.from({ length: 300 }, async () => {
      await pacer.acquire(120);
      charges.push(time.now());
    }),
  );
  for (const t of charges) {
    const inWindow = charges.filter(at => at <= t && at > t - WINDOW_MS).length * 120;
    assert.ok(inWindow < 3000, `window held ${inWindow}`);
  }
});

test('a quiet probe reports its own series, and a request larger than the budget is refused', async () => {
  const time = virtualTime();
  const pacer = new UnitPacer({ now: time.now, sleep: time.sleep });
  await pacer.acquire(10);
  const mark = pacer.mark();
  time.advance(2 * WINDOW_MS);
  await pacer.acquire(5);
  time.advance(WINDOW_MS);
  await pacer.acquire(7);
  assert.deepEqual(pacer.series(), [10, 0, 5, 7]);
  assert.deepEqual(pacer.series(mark), [5, 7]);
  await assert.rejects(pacer.acquire(RUN_UNIT_BUDGET + 1));
});
