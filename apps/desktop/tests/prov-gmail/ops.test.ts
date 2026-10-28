/**
 * prov-gmail ops: how local edits become Gmail calls (`coalesce`) and what comes back (`apply`). Pure tables for the
 * grouping, a replay property for the ordering, and the Gmail emulator for cost, 404s, a partial batch and refusals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaultInjector } from '@aplos/emulators';
import type { CoalescedOp, OpChange, OpOutcome, PendingOp } from '@aplos/engine/ports';
import { GMAIL_COSTS, GMAIL_COSTS_GRANDFATHERED } from '../../src/host/providers/google/costs';
import { coalesceOps, type GmailOpBody } from '../../src/host/providers/google/ops';
import { gmailLog, rig, type Rig } from './harness';

let nextSeq = 0;
const op = (remoteId: string, change: OpChange, seq = ++nextSeq): PendingOp => ({
  opId: `op${seq}`,
  seq,
  remoteId,
  change,
});
const archive = (id: string, seq?: number) =>
  op(id, { kind: 'folders', add: [], remove: ['INBOX'] }, seq);
const ids = (n: number, prefix = 'm') =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);
const body = (c: CoalescedOp) => c.body as GmailOpBody;
const total = (cs: CoalescedOp[]) => cs.reduce((sum, c) => sum + c.cost, 0);
const summary = (cs: CoalescedOp[]) =>
  cs.map(c => `${c.method.replace('gmail.messages.', '')}:${body(c).targets.length}`);

// ---- coalescing ----

test('prov-gmail-T50 ops coalesce into the cheapest Gmail calls (the grouping table)', () => {
  const table: { name: string; ops: () => PendingOp[]; calls: string[]; units: number }[] = [
    {
      name: '10 archives are one batchModify',
      ops: () => ids(10).map(id => archive(id)),
      calls: ['batchModify:10'],
      units: 50,
    },
    {
      name: '9 archives are cheaper as 9 modifies',
      ops: () => ids(9).map(id => archive(id)),
      calls: Array(9).fill('modify:1'),
      units: 45,
    },
    {
      name: '1 archive is one messages.modify',
      ops: () => [archive('only')],
      calls: ['modify:1'],
      units: 5,
    },
    {
      name: '1,200 with one change are 1,000 + 200',
      ops: () => ids(1_200).map(id => archive(id)),
      calls: ['batchModify:1000', 'batchModify:200'],
      units: 100,
    },
    {
      name: '1,001 leave the last one to a modify',
      ops: () => ids(1_001).map(id => archive(id)),
      calls: ['batchModify:1000', 'modify:1'],
      units: 55,
    },
    {
      name: 'different label sets are different calls, and a set merges whatever order it was queued in',
      ops: () => [
        ...ids(10, 'a').map(id => archive(id)),
        ...ids(10, 'b').map(id => op(id, { kind: 'folders', add: ['Label_7'], remove: ['INBOX'] })),
        ...ids(10, 'c').map(id => archive(id)),
      ],
      calls: ['batchModify:20', 'batchModify:10'],
      units: 100,
    },
    {
      name: 'flags are labels: seen removes UNREAD, flagged adds STARRED',
      ops: () => [
        ...ids(10, 'r').map(id => op(id, { kind: 'flags', seen: true })),
        ...ids(10, 's').map(id => op(id, { kind: 'flags', flagged: true, seen: false })),
      ],
      calls: ['batchModify:10', 'batchModify:10'],
      units: 100,
    },
    {
      name: 'trash and untrash are one call per message, never batched',
      ops: () => [
        ...ids(12, 't').map(id => op(id, { kind: 'trash' })),
        op('u', { kind: 'untrash' }),
      ],
      calls: [...Array(12).fill('trash:1'), 'untrash:1'],
      units: 13 * 20,
    },
    {
      name: 'an answered flag has no Gmail label: applied without a call, free',
      ops: () => [op('x', { kind: 'flags', answered: true })],
      calls: ['none:1'],
      units: 0,
    },
  ];
  for (const row of table) {
    const out = coalesceOps(row.ops(), GMAIL_COSTS);
    assert.deepEqual(
      summary(out).map(s => s.replace(/^gmail\./, '')),
      row.calls,
      row.name,
    );
    assert.equal(total(out), row.units, `${row.name}: units`);
  }
});

test('prov-gmail-T50 the call bodies carry sorted label sets, and a message keeps one entry per op chain', () => {
  const out = coalesceOps(
    [
      ...ids(12).map(id =>
        op(id, { kind: 'folders', add: ['Label_2', 'Label_1'], remove: ['INBOX'] }),
      ),
      op('m0000', { kind: 'flags', flagged: true }),
    ],
    GMAIL_COSTS,
  );
  const batch = body(out.find(c => c.method === 'gmail.messages.batchModify')!);
  assert.deepEqual(batch.addLabelIds, ['Label_1', 'Label_2']);
  assert.deepEqual(batch.removeLabelIds, ['INBOX']);
  // m0000's archive and its star fold into one change, carried by one call that names both op ids.
  const folded = out.find(c =>
    body(c).targets.some(t => t.id === 'm0000' && t.opIds.length === 2),
  )!;
  assert.deepEqual(body(folded).addLabelIds, ['Label_1', 'Label_2', 'STARRED']);
  assert.equal(out.flatMap(c => c.opIds).length, 13, 'every op id is in exactly one call');
});

test('prov-gmail-T50 a later op on the same label wins, as if they had run in order', () => {
  const out = coalesceOps(
    [
      op('a', { kind: 'folders', add: ['Label_1'], remove: ['INBOX'] }),
      op('a', { kind: 'folders', add: ['INBOX'], remove: ['Label_1'] }),
      op('a', { kind: 'folders', add: [], remove: ['INBOX'] }),
    ],
    GMAIL_COSTS,
  );
  assert.equal(out.length, 1);
  assert.deepEqual(
    [body(out[0]).addLabelIds, body(out[0]).removeLabelIds],
    [[], ['INBOX', 'Label_1']],
  );
  assert.deepEqual(out[0].opIds.length, 3);
});

test('prov-gmail-T50 input order does not matter: ops are taken by seq', () => {
  const ops = [
    op('a', { kind: 'trash' }, 3),
    op('a', { kind: 'untrash' }, 5),
    op('a', { kind: 'folders', add: [], remove: ['INBOX'] }, 1),
  ];
  const forward = coalesceOps(ops, GMAIL_COSTS).map(c => c.method);
  assert.deepEqual(forward, [
    'gmail.messages.modify',
    'gmail.messages.trash',
    'gmail.messages.untrash',
  ]);
  assert.deepEqual(
    coalesceOps([...ops].reverse(), GMAIL_COSTS).map(c => c.method),
    forward,
  );
});

test('prov-gmail-T50 the grandfathered price list changes the cost and nothing else', () => {
  const ops = [...ids(10).map(id => op(id, { kind: 'trash' }))];
  const now = coalesceOps(ops, GMAIL_COSTS);
  const old = coalesceOps(ops, GMAIL_COSTS_GRANDFATHERED);
  assert.deepEqual(summary(old), summary(now));
  assert.equal(total(now), 200);
  assert.equal(total(old), 50);
});

// A model of the mailbox that the ops act on, to prove the coalesced calls end where the queued ops would have.
type Labels = Map<string, Set<string>>;
function replay(ops: PendingOp[]): Labels {
  const state: Labels = new Map();
  const labels = (id: string) =>
    state.get(id) ?? state.set(id, new Set(['INBOX', 'UNREAD'])).get(id)!;
  for (const o of [...ops].sort((a, b) => a.seq - b.seq)) {
    const set = labels(o.remoteId);
    const c = o.change;
    if (c.kind === 'folders') {
      c.add.forEach(l => set.add(l));
      c.remove.forEach(l => set.delete(l));
    } else if (c.kind === 'flags') {
      if (c.seen === true) set.delete('UNREAD');
      else if (c.seen === false) set.add('UNREAD');
      if (c.flagged === true) set.add('STARRED');
      else if (c.flagged === false) set.delete('STARRED');
    } else if (c.kind === 'trash') {
      set.add('TRASH');
      set.delete('INBOX');
    } else {
      set.delete('TRASH');
      set.add('INBOX');
    }
  }
  return state;
}
function replayCalls(calls: CoalescedOp[], start: string[]): Labels {
  const state: Labels = new Map(start.map(id => [id, new Set(['INBOX', 'UNREAD'])]));
  for (const c of calls) {
    const b = body(c);
    for (const t of b.targets) {
      const set = state.get(t.id)!;
      if (b.call === 'trash') {
        set.add('TRASH');
        set.delete('INBOX');
      } else if (b.call === 'untrash') {
        set.delete('TRASH');
        set.add('INBOX');
      } else {
        b.addLabelIds.forEach(l => set.add(l));
        b.removeLabelIds.forEach(l => set.delete(l));
      }
    }
  }
  return state;
}

test('prov-gmail-T50 property: the coalesced calls in order end in the state the queued ops would (300 random queues)', () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff), seed % n);
  const labels = ['INBOX', 'Label_1', 'Label_2', 'STARRED'];
  for (let round = 0; round < 300; round++) {
    const messages = ids(1 + rand(25));
    const ops: PendingOp[] = [];
    for (let i = 0, n = 1 + rand(60); i < n; i++) {
      const id = messages[rand(messages.length)];
      const pick = rand(6);
      const change: OpChange =
        pick === 0
          ? { kind: 'trash' }
          : pick === 1
            ? { kind: 'untrash' }
            : pick === 2
              ? {
                  kind: 'flags',
                  seen: rand(2) === 0,
                  ...(rand(2) ? { flagged: rand(2) === 0 } : {}),
                }
              : {
                  kind: 'folders',
                  add: [labels[rand(4)]].filter(l => l !== 'STARRED'),
                  remove: [labels[rand(4)]].filter(l => l !== 'STARRED'),
                };
      if (change.kind === 'folders' && change.add[0] === change.remove[0]) change.remove = [];
      ops.push(op(id, change, round * 1_000 + i));
    }
    const calls = coalesceOps(ops, GMAIL_COSTS);
    assert.deepEqual(
      calls.flatMap(c => c.opIds).sort(),
      ops.map(o => o.opId).sort(),
      `round ${round}: each op id once`,
    );
    const want = replay(ops);
    const got = replayCalls(calls, messages);
    for (const [id, set] of want)
      assert.deepEqual([...got.get(id)!].sort(), [...set].sort(), `round ${round}: ${id}`);
  }
});

// ---- apply on the emulator ----

const messageIds = (r: Rig, n: number): string[] =>
  r.emu.mailbox
    .select({})
    .slice(0, n)
    .map(m => m.id);
const lines = (r: Rig) =>
  gmailLog(r.emu).filter(e => /\.(modify|batchModify|trash|untrash|delete)$/.test(e.apiMethod));
const outcomesOf = async (r: Rig, ops: PendingOp[]): Promise<Map<string, OpOutcome>> => {
  const out = new Map<string, OpOutcome>();
  for (const call of r.adapter.coalesce(ops))
    for (const o of await r.adapter.apply(call, r.ctx())) out.set(o.opId, o);
  return out;
};
const labelsOf = (r: Rig, id: string) => r.emu.mailbox.getMessage(id)!.labelIds;

test('prov-gmail-T50 10 queued archives are applied with one batchModify on the opFlush lane, with no retry', async () => {
  const r = await rig({ threads: 60 });
  const inbox = r.emu.mailbox
    .select({ labelIds: ['INBOX'] })
    .slice(0, 10)
    .map(m => m.id);
  const out = await outcomesOf(
    r,
    inbox.map(id => archive(id)),
  );
  assert.deepEqual(
    [...out.values()].map(o => o.result),
    Array(10).fill('applied'),
  );
  const sent = lines(r);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].apiMethod, 'gmail.users.messages.batchModify');
  assert.equal(sent[0].units, 50);
  const calls = r.governor.sentCalls().filter(c => c.method !== 'oauth.token');
  assert.deepEqual(
    calls.map(c => [c.method, c.lane, c.kind, c.cost]),
    [['gmail.messages.batchModify', 'opFlush', 'idempotentWrite', 50]],
  );
  for (const id of inbox) assert.ok(!labelsOf(r, id).includes('INBOX'));
});

test('prov-gmail-T50 T68 1,200 messages with one change cost two batchModify calls and 100 units, as the emulator counts them', async () => {
  const r = await rig({ threads: 1_000 });
  const targets = messageIds(r, 1_200);
  assert.equal(targets.length, 1_200);
  const out = await outcomesOf(
    r,
    targets.map(id => op(id, { kind: 'folders', add: ['STARRED'], remove: [] })),
  );
  assert.ok([...out.values()].every(o => o.result === 'applied'));
  assert.deepEqual(
    lines(r).map(e => [e.apiMethod, e.units]),
    [
      ['gmail.users.messages.batchModify', 50],
      ['gmail.users.messages.batchModify', 50],
    ],
  );
  assert.ok(targets.every(id => labelsOf(r, id).includes('STARRED')));
});

test('prov-gmail-T50 a single message is one messages.modify at 5 units', async () => {
  const r = await rig({ threads: 30 });
  const [id] = r.emu.mailbox.select({ labelIds: ['INBOX'] }).map(m => m.id);
  const out = await outcomesOf(r, [archive(id)]);
  assert.equal(out.size, 1);
  assert.equal([...out.values()][0].result, 'applied');
  assert.deepEqual(
    lines(r).map(e => [e.apiMethod, e.units]),
    [['gmail.users.messages.modify', 5]],
  );
});

test('prov-gmail-T50 a message Gmail no longer has is notFound and the op is dropped; the others still apply', async () => {
  const r = await rig({ threads: 30 });
  const [gone, kept] = r.emu.mailbox.select({ labelIds: ['INBOX'] }).map(m => m.id);
  r.emu.mailbox.deleteMessage(gone);
  const a = archive(gone);
  const b = archive(kept);
  const t = op(gone, { kind: 'trash' });
  const out = await outcomesOf(r, [a, b, t]);
  assert.equal(out.get(a.opId)!.result, 'notFound');
  assert.equal(out.get(b.opId)!.result, 'applied');
  assert.equal(out.get(t.opId)!.result, 'notFound');
  assert.equal(out.get(a.opId)!.error, undefined, 'a dropped op is not an error');
  assert.ok(!labelsOf(r, kept).includes('INBOX'));
});

test('prov-gmail-T50 a partial batch: one missing id fails the batch whole, so the ids are halved and only that op is dropped', async () => {
  const r = await rig({ threads: 300 });
  const targets = r.emu.mailbox
    .select({ labelIds: ['INBOX'] })
    .slice(0, 100)
    .map(m => m.id);
  const missing = targets[37];
  r.emu.mailbox.deleteMessage(missing);
  const queued = targets.map(id => archive(id));
  const out = await outcomesOf(r, queued);
  for (const o of queued) {
    const outcome = out.get(o.opId)!;
    if (o.remoteId === missing) assert.equal(outcome.result, 'notFound');
    else {
      assert.equal(outcome.result, 'applied', o.remoteId);
      assert.ok(!labelsOf(r, o.remoteId).includes('INBOX'));
    }
  }
  const units = lines(r).reduce((sum, e) => sum + e.units, 0);
  assert.ok(units < 100 * 5, `${units} units is under a modify per message`);
  assert.equal(
    lines(r).filter(e => e.status === 400).length > 0,
    true,
    'the failing batches are in the log',
  );
});

test('prov-gmail-T50 trash and untrash are per message and never a permanent delete', async () => {
  const r = await rig({ threads: 30 });
  const [id] = r.emu.mailbox.select({ labelIds: ['INBOX'] }).map(m => m.id);
  const out = await outcomesOf(r, [op(id, { kind: 'trash' })]);
  assert.equal([...out.values()][0].result, 'applied');
  assert.ok(labelsOf(r, id).includes('TRASH') && !labelsOf(r, id).includes('INBOX'));
  await outcomesOf(r, [op(id, { kind: 'untrash' })]);
  assert.ok(!labelsOf(r, id).includes('TRASH') && labelsOf(r, id).includes('INBOX'));
  assert.deepEqual(
    lines(r).map(e => [e.apiMethod, e.units]),
    [
      ['gmail.users.messages.trash', 20],
      ['gmail.users.messages.untrash', 20],
    ],
  );
  assert.ok(!lines(r).some(e => /delete/.test(e.apiMethod)));
  assert.ok(r.emu.mailbox.hasMessage(id));
});

test('prov-gmail-T50 a throttle comes back as a classified failure on every op, after one request, and the pause stops the next call', async () => {
  const faults = createFaultInjector();
  const r = await rig({ threads: 60, emulator: { faults } });
  faults.failNext(
    { apiMethod: 'gmail.users.messages.batchModify' },
    { status: 429, reason: 'rateLimitExceeded' },
  );
  const targets = r.emu.mailbox
    .select({ labelIds: ['INBOX'] })
    .slice(0, 12)
    .map(m => m.id);
  const queued = targets.map(id => archive(id));
  const out = await outcomesOf(r, queued);
  assert.ok(queued.every(o => out.get(o.opId)!.result === 'failed'));
  assert.equal(out.get(queued[0].opId)!.error!.class, 'throttle');
  assert.equal(lines(r).length, 1, 'one request, no retry in the adapter');
  assert.ok(
    targets.every(id => labelsOf(r, id).includes('INBOX')),
    'nothing changed',
  );
  // The stub governor is paused now: the next apply sends nothing and says why.
  const again = await outcomesOf(
    r,
    queued.map(o => ({ ...o, opId: `${o.opId}b`, seq: o.seq + 1_000 })),
  );
  assert.ok([...again.values()].every(o => o.result === 'failed' && o.error!.class === 'throttle'));
  assert.equal(lines(r).length, 1, 'the pause sent nothing');
});

test('prov-gmail-T50 T28 a 503 is one attempt and a transient failure; a bad label is permanent and costs one request', async () => {
  const faults = createFaultInjector();
  const r = await rig({ threads: 60, emulator: { faults } });
  const [a, b] = r.emu.mailbox.select({ labelIds: ['INBOX'] }).map(m => m.id);
  faults.failNext(
    { apiMethod: 'gmail.users.messages.modify' },
    { status: 503, reason: 'backendError' },
  );
  const first = archive(a);
  const out = await outcomesOf(r, [first]);
  assert.equal(out.get(first.opId)!.result, 'failed');
  assert.equal(out.get(first.opId)!.error!.class, 'transient');
  assert.equal(lines(r).length, 1);

  const bad = op(b, { kind: 'folders', add: ['Label_999'], remove: [] });
  const permanent = await outcomesOf(r, [bad]);
  assert.equal(permanent.get(bad.opId)!.result, 'failed');
  assert.equal(permanent.get(bad.opId)!.error!.class, 'permanent');
  assert.equal(lines(r).length, 2);
});

test('prov-gmail-T50 an answered flag needs no request', async () => {
  const r = await rig({ threads: 10 });
  const answered = op('anything', { kind: 'flags', answered: true });
  const out = await outcomesOf(r, [answered]);
  assert.equal(out.get(answered.opId)!.result, 'applied');
  assert.equal(r.fetches.length, 0);
});
