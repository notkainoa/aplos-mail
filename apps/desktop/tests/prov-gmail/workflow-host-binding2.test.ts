/**
 * The lease's follow-ups after #100 on the Gmail channel (plan 20 PV3, ARCH 6.5): a Mac whose clock checks always
 * fail keeps its copies few over an idle day (D1), and own copies are remembered by a bounded digest that still
 * drives the matching rule (D3). Synthetic data, test keys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_LABEL } from '../../src/host/providers/google/workflow';
import {
  digestCovers,
  digestOf,
  OwnDigests,
} from '../../src/host/providers/google/workflow-digest';
import type { WorkflowRecord } from '../../src/host/providers/google/workflow-merge';
import { rig, type Rig } from './harness';
import { appLabel, device, plant, sealedCopy } from './workflow-rig';
import { ACCOUNT, Mac, HOUR, boot, mailWorld, settle } from './gov-stack-rig';

const DAY = 24 * HOUR;

/** Gmail answers every receive-time check (a minimal get) with 404: the clock gate never measures anything. */
function failClockChecks(mac: Mac): void {
  const inner = mac.fetch;
  (mac as { fetch: typeof fetch }).fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (/\/messages\/[^/]+$/.test(url.pathname) && url.searchParams.get('format') === 'minimal')
      return Promise.resolve(new Response('{"error":{"code":404}}', { status: 404 }));
    return inner(input, init);
  };
}

test('a lone Mac whose clock checks always fail writes about 50 copies an idle day and keeps 3 at most', async () => {
  const mail = mailWorld(4);
  const a = new Mac(mail, 'mac-a');
  failClockChecks(a);
  const engine = await boot(a, undefined, { workflow: true, leaseTickMs: 5_000 });
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
    let most = 0;
    for (let hour = 0; hour < 24; hour++) {
      await mail.clock.advance(HOUR);
      most = Math.max(most, copies());
    }
    assert.ok(label(), 'the channel was written');
    assert.ok(!roles.includes('primary'), 'never primary on an unproven clock');
    assert.ok(inserts() <= 52, `${inserts()} copies written in an idle day`);
    assert.ok(most <= 3, `${most} copies under the label at most`);
  } finally {
    await settle(mail.clock, engine.kill());
    a.cleanup();
  }
});

const live = (r: Rig) =>
  r.emu.mailbox.select({ labelIds: [appLabel(r)], q: '', includeSpamTrash: false }).map(m => m.id);

/** The channel's own-copy memory (a private field: the structure is what this test bounds). */
const ownOf = (channel: unknown) => (channel as { own: unknown }).own;

const lease = (at: number, v: number): WorkflowRecord => ({
  key: 'lease:device-a',
  stamp: { at, gen: v, device: 'device-a' },
  value: { v, pad: 'x'.repeat(2_000) },
});

test('300 own copies: digests only, at most 256 remembered, and the matching rule still keeps a Done copy', async () => {
  const r = await rig();
  const now = r.clock.now();
  // 300 copies this device wrote earlier (each with a 2 KB value); the newest also holds Done from 170 days ago.
  const done: WorkflowRecord = {
    key: 'thread:t-old',
    stamp: { at: now - 170 * DAY, gen: 0, device: 'device-a' },
    value: { status: 'done' },
  };
  const planted: string[] = [];
  for (let i = 0; i < 300; i++) {
    const records = i === 299 ? [lease(now - 300 + i, i), done] : [lease(now - 300 + i, i)];
    const copy = sealedCopy(r, {
      v: 2,
      device: 'device-a',
      writtenAt: now - 300 + i,
      floor: 0,
      records: records.sort((x, y) => (x.key < y.key ? -1 : 1)),
    });
    planted.push(plant(r, copy.raw));
  }
  const keeper = planted[299];
  // The same device, its clock now 30 days fast: its new copies' floor leaves Done out.
  const fast = device(r, 'device-a', { skewMs: 30 * DAY });
  // A round downloads at most 200 copies: two rounds read them all.
  await fast.round();
  await fast.round();
  const own = ownOf(fast.channel);
  assert.ok(own instanceof OwnDigests, 'own copies are kept as digests');
  assert.equal(own.size, 256, 'at most 256 copies remembered');
  assert.ok(own.entries <= 257, `${own.entries} records remembered`);
  const digest = own.get(keeper)!;
  assert.ok(digest && !JSON.stringify([...digest]).includes('xxxx'), 'no record values kept');
  await fast.channel.write([{ key: 'lease:device-a', value: { v: 1000 } }], fast.ctx());
  let trashed = 0;
  for (let n = await fast.channel.compact(fast.ctx(), { ownOnly: true }); n;) {
    trashed += n;
    n = await fast.channel.compact(fast.ctx(), { ownOnly: true });
  }
  assert.equal(
    trashed,
    254,
    'every remembered copy the new one covers, never the one holding Done',
  );
  assert.ok(live(r).includes(keeper), 'the copy holding Done stays');
  // Left: the 44 copies past the cap, the one the new copy's own digest pushed out, the Done copy and the new one.
  assert.equal(live(r).length, 300 - 254 + 1, 'copies no digest remembers are never trashed');
  assert.ok(own.size <= 2, `${own.size} copies remembered after compacting`);
  const reader = device(r, 'device-c');
  await reader.round();
  assert.deepEqual(reader.channel.view().find(x => x.key === 'thread:t-old')?.value, {
    status: 'done',
  });
});

test('own digests: bounded in records too, the newest kept; an equal stamp with another value never covers', () => {
  const own = new OwnDigests(256, 10);
  const copy = (n: number, v = 0) =>
    digestOf(
      Array.from({ length: 4 }, (_, i) => ({
        key: `k${i}`,
        stamp: { at: n, gen: i, device: 'device-a' },
        value: { v },
      })),
    );
  for (let n = 1; n <= 5; n++) own.remember(`copy-${n}`, copy(n));
  assert.deepEqual([own.size, own.entries], [2, 8]);
  assert.ok(own.get('copy-5') && own.get('copy-4') && !own.get('copy-3'));
  assert.ok(digestCovers(copy(6), copy(5)), 'later stamps cover');
  assert.ok(digestCovers(copy(5), copy(5)), 'the same records cover');
  assert.ok(!digestCovers(copy(5, 1), copy(5)), 'an equal stamp with another value does not');
  assert.ok(!digestCovers(copy(4), copy(5)), 'older stamps do not');
});
