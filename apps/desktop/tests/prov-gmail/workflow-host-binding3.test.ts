/**
 * Compacting forgotten own copies (plan 20 PV3, ARCH 6.5): a copy whose re-read fails is skipped, never the batch, and
 * other devices' copies on the label are left alone. Synthetic data, test keys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowRecord } from '../../src/host/providers/google/workflow-merge';
import { rig, type Rig } from './harness';
import { appLabel, device, plant, sealedCopy } from './workflow-rig';

const DAY = 24 * 60 * 60_000;

const live = (r: Rig) =>
  r.emu.mailbox.select({ labelIds: [appLabel(r)], q: '', includeSpamTrash: false }).map(m => m.id);

/** Ten copies of device-a (three records each, so two keep a digest and eight are forgotten), three of device-c (one record each). */
async function forgottenRig(failGets?: { status: number; times: number; skip?: number }) {
  const r = await rig();
  const now = r.clock.now();
  const records = (device: string, i: number): WorkflowRecord[] =>
    [`lease:${device}`, `thread:${device}-1`, `thread:${device}-2`]
      .slice(0, device === 'device-a' ? 3 : 1)
      .map((key, gen) => ({
        key,
        stamp: { at: now - 100 + i, gen, device },
        value: { i },
      }));
  const plantFor = (id: string, i: number) => {
    const payload = { v: 2 as const, device: id, writtenAt: now - 100 + i, floor: 0 };
    return plant(r, sealedCopy(r, { ...payload, records: records(id, i) }).raw);
  };
  const own = Array.from({ length: 10 }, (_, i) => plantFor('device-a', i));
  const others = Array.from({ length: 3 }, (_, i) => plantFor('device-c', i));
  // A clock 30 days fast: the new copy's floor is not one readers honour, so each forgotten copy is matched by a download.
  const a = device(r, 'device-a', {
    maxRecords: 4,
    skewMs: 30 * DAY,
    ...(failGets ? { failGets } : {}),
  });
  await a.round();
  const written = await a.channel.write([{ key: 'lease:device-a', value: { v: 1 } }], a.ctx());
  return { r, a, own, others, written };
}

async function drain(a: Awaited<ReturnType<typeof forgottenRig>>['a']): Promise<number[]> {
  const counts: number[] = [];
  for (let n = await a.channel.compact(a.ctx(), { ownOnly: true }); n;) {
    counts.push(n);
    n = await a.channel.compact(a.ctx(), { ownOnly: true });
  }
  return counts;
}

test('a forgotten copy whose re-read fails (500) is skipped: the rest of the batch is trashed, it is tried again later', async () => {
  // The first download is the new copy's read-back; the next one (the first forgotten copy's) fails once.
  const { r, a, others, written } = await forgottenRig({ status: 500, times: 1, skip: 1 });
  const first = await a.channel.compact(a.ctx(), { ownOnly: true });
  assert.ok(first >= 3, `${first} trashed with one re-read failing`);
  const total = first + (await drain(a)).reduce((sum, n) => sum + n, 0);
  assert.equal(total, 10, 'the skipped copy was tried again and trashed');
  assert.deepEqual(live(r).sort(), [written.remoteId, ...others].sort(), 'device-c is untouched');
});

test('a forgotten copy that is gone (404) stays where it is; the others are trashed, and device-c copies never are', async () => {
  const { r, a, others, written } = await forgottenRig({ status: 404, times: 1, skip: 1 });
  const since = a.governor.calls.length;
  const total = await drain(a);
  const trashed = total.reduce((sum, n) => sum + n, 0);
  assert.equal(trashed, 9, 'every other own copy');
  const left = live(r);
  assert.equal(left.length, 1 + 1 + others.length, 'the new copy, the 404 one and device-c');
  assert.ok(others.every(id => left.includes(id)));
  assert.ok(left.includes(written.remoteId));
  const gets = a.methods(since).filter(m => m === 'gmail.messages.get').length;
  assert.ok(gets <= 10, `${gets} downloads: device-c copies are never downloaded again`);
});

test('a data key that is locked while re-reading skips the copy, trashing what needs no download', async () => {
  const { r, a, written } = await forgottenRig();
  a.keys.off = true;
  const since = a.governor.calls.length;
  const n = await a.channel.compact(a.ctx(), { ownOnly: true });
  assert.ok(n <= 2, `${n} trashed without a key`);
  assert.equal(a.methods(since).filter(m => m === 'gmail.messages.get').length, 0);
  assert.ok(live(r).includes(written.remoteId));
});
