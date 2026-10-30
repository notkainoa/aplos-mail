/**
 * The lease's binding review on the Gmail channel (plan 20 PV3, ARCH 6.5): the clock gate's bracketed offset, and a
 * Mac the gate blocks keeping its own copies compacted without touching another device's. Synthetic data, test keys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { GovernedRequest } from '@aplos/engine/ports';
import { APP_LABEL } from '../../src/host/providers/google/workflow';
import { rig, type Rig } from './harness';
import { appLabel, device, plant, sealedCopy, type Device } from './workflow-rig';
import { ACCOUNT, Mac, MINUTE, boot, mailWorld, settle } from './gov-stack-rig';

/** The lease's clock gate limit (`LEASE_CLOCK_MAX_MS`). */
const CLOCK_MAX_MS = 5 * MINUTE;

/** Every `messages.insert` waits `ms` in the governor before it goes out (pacing a busy lane). */
function paceInserts(d: Device, r: Rig, ms: number): void {
  const run = d.governor.run.bind(d.governor);
  d.governor.run = (async (req: GovernedRequest, fn: Parameters<typeof run>[1]) => {
    if (req.method === 'gmail.messages.insert') await r.clock.sleep(ms);
    return run(req, fn);
  }) as typeof run;
}

const live = (r: Rig) =>
  r.emu.mailbox.select({ labelIds: [appLabel(r)], q: '', includeSpamTrash: false }).map(m => m.id);

test('the offset is bracketed by the insert: a pacing wait cannot hide a clock 6 minutes fast', async () => {
  const r = await rig();
  const fast = device(r, 'device-a', { skewMs: 6 * MINUTE });
  paceInserts(fast, r, 2 * MINUTE);
  const written = await fast.channel.write(
    [{ key: 'lease:device-a', value: { v: 1 } }],
    fast.ctx(),
  );
  const offset = written.clockOffset!;
  assert.ok(offset.lowMs > CLOCK_MAX_MS, `low end ${offset.lowMs}: the gate sees the clock is off`);
  assert.ok(offset.highMs - offset.lowMs <= MINUTE, 'a tight bracket');
});

test('the same pacing wait on a right clock still reads within the limit', async () => {
  const r = await rig();
  const fine = device(r, 'device-b');
  paceInserts(fine, r, 2 * MINUTE);
  const written = await fine.channel.write(
    [{ key: 'lease:device-b', value: { v: 1 } }],
    fine.ctx(),
  );
  const offset = written.clockOffset!;
  for (const end of [offset.lowMs, offset.highMs])
    assert.ok(Math.abs(end) <= 5_000, `measured ${end}`);
});

test('a slow upload widens the bracket, yet a right clock still reads wholly within the limit', async () => {
  const r = await rig();
  const slow = device(r, 'device-a', { slowInsertMs: 2 * MINUTE });
  const written = await slow.channel.write(
    [{ key: 'lease:device-a', value: { v: 1 } }],
    slow.ctx(),
  );
  const offset = written.clockOffset!;
  assert.ok(
    offset.highMs - offset.lowMs >= 2 * MINUTE,
    `bracket ${offset.lowMs}..${offset.highMs}`,
  );
  assert.ok(offset.lowMs >= -CLOCK_MAX_MS && offset.highMs <= CLOCK_MAX_MS, 'the gate reads ok');
});

test("an own-only compaction trashes this device's superseded copies, never another device's", async () => {
  const r = await rig();
  const a = device(r, 'device-a');
  const b = device(r, 'device-b');
  const a1 = (await a.channel.write([{ key: 'lease:device-a', value: { v: 1 } }], a.ctx()))
    .remoteId;
  await b.round();
  const b1 = (await b.channel.write([{ key: 'lease:device-b', value: { v: 1 } }], b.ctx()))
    .remoteId;
  await a.round();
  // A's next copy covers both A's first copy and B's: an own-only compaction still leaves B's alone.
  const a2 = (await a.channel.write([{ key: 'lease:device-a', value: { v: 2 } }], a.ctx()))
    .remoteId;
  assert.equal(await a.channel.compact(a.ctx(), { ownOnly: true }), 1);
  assert.deepEqual(live(r).sort(), [a2, b1].sort());
  assert.ok(!live(r).includes(a1));
  // The same device in a later process: copies it wrote before count as its own too.
  const again = device(r, 'device-a');
  await again.round();
  const a3 = (await again.channel.write([{ key: 'lease:device-a', value: { v: 3 } }], again.ctx()))
    .remoteId;
  assert.equal(await again.channel.compact(again.ctx(), { ownOnly: true }), 1);
  assert.deepEqual(live(r).sort(), [a3, b1].sort());
});

test('a Mac 3 days fast compacts its own copies (verified by their sealed payload), but never all copies', async () => {
  const r = await rig();
  const fast = device(r, 'device-a', { skewMs: 3 * 86_400_000 });
  const lease = (v: number) => [{ key: 'lease:device-a', value: { v } }];
  const first = (await fast.channel.write(lease(1), fast.ctx())).remoteId;
  const second = (await fast.channel.write(lease(2), fast.ctx())).remoteId;
  assert.equal(
    await fast.channel.compact(fast.ctx()),
    0,
    'its floor is not honoured for a full compaction',
  );
  const third = (await fast.channel.write(lease(3), fast.ctx())).remoteId;
  assert.equal(await fast.channel.compact(fast.ctx(), { ownOnly: true }), 2);
  assert.deepEqual(live(r), [third]);
  assert.ok(![first, second].some(id => live(r).includes(id)));
  assert.equal(await fast.channel.compact(fast.ctx()), 0, 'still no full compaction against it');
});

test('a Mac 30 days fast never trashes an own copy holding a settled record its new copy left out', async () => {
  const r = await rig();
  const day = 24 * 60 * MINUTE;
  // A copy this device wrote before its clock ran fast: Done on a thread, 170 days ago (true time).
  const old = sealedCopy(r, {
    v: 2,
    device: 'device-a',
    writtenAt: r.clock.now() - 170 * day,
    floor: 0,
    records: [
      {
        key: 'thread:t-old',
        stamp: { at: r.clock.now() - 170 * day, gen: 0, device: 'device-a' },
        value: { status: 'done' },
      },
    ],
  });
  const kept = plant(r, old.raw);
  const fast = device(r, 'device-a', { skewMs: 30 * day });
  await fast.round();
  const lease = (v: number) => [{ key: 'lease:device-a', value: { v } }];
  const first = (await fast.channel.write(lease(1), fast.ctx())).remoteId;
  // Its floor (180 days before a clock 30 days fast) leaves the Done record out of the new copies.
  const second = (await fast.channel.write(lease(2), fast.ctx())).remoteId;
  assert.equal(await fast.channel.compact(fast.ctx(), { ownOnly: true }), 1);
  assert.deepEqual(live(r).sort(), [kept, second].sort(), 'the copy holding Done stays');
  assert.ok(!live(r).includes(first));
  const reader = device(r, 'device-c');
  await reader.round();
  assert.deepEqual(
    reader.channel.view().find(x => x.key === 'thread:t-old')?.value,
    { status: 'done' },
    'a new device still reads Done',
  );
});

for (const [what, skewMs] of [
  ['45 minutes fast', 45 * MINUTE],
  ['12 minutes slow', -12 * MINUTE],
  ['3 days fast', 3 * 24 * 60 * MINUTE],
] as const) {
  test(`a lone Mac ${what} keeps its copies few over an idle hour and never becomes primary`, async () => {
    const mail = mailWorld(4);
    const a = new Mac(mail, 'mac-a');
    const engine = await boot(a, undefined, { workflow: true, skewMs });
    const label = () => mail.emu.mailbox.labelIdByName(APP_LABEL);
    const copies = () =>
      mail.emu.mailbox.select({ labelIds: [label()!], q: '', includeSpamTrash: false }).length;
    const inserts = () => a.sent.filter(s => s.url.pathname.endsWith('/messages/insert')).length;
    const roles: string[] = [];
    engine.host.subscribe((_account, status) => {
      if (status.lease?.role) roles.push(status.lease.role);
    });
    try {
      await engine.host.start(ACCOUNT);
      await mail.clock.advance(10 * MINUTE);
      assert.ok(label(), 'the channel was written');
      const before = inserts();
      await mail.clock.advance(60 * MINUTE);
      assert.ok(!roles.includes('primary'), 'never primary');
      assert.ok(inserts() - before <= 3, `${inserts() - before} copies written in an idle hour`);
      assert.ok(copies() <= 2, `${copies()} copies under the label`);
    } finally {
      await settle(mail.clock, engine.kill());
      a.cleanup();
    }
  });
}
