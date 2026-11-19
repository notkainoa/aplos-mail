import test from 'node:test';
import assert from 'node:assert/strict';
import type { Output, ThreadAction } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { Caller } from '../../src/methods/types';
import type { MessageWrite, StoreWrite } from '../../src/store';
import { facts, nextOp, openOps, rowOf } from './acts';
import { incoming, patch, worldEngine } from './harness';

/*
 * views-4's sender rules: the `sender_rules` writer, the ingest hook that applies a rule inside the commit that stores
 * the mail, and the one-commit application to existing threads. The attack is rule precedence: a rule must not
 * overwrite a lane the user set, and a block must hide mail, never delete it.
 */

const ADA = 'ada@news.example';
const BEN = 'ben@news.example';
const isType = (type: string) => (e: unknown) => e instanceof ContractError && e.type === type;

type Engine = Awaited<ReturnType<typeof worldEngine>>;
const empty = () => worldEngine(3, 0);

function from(thread: string, address: string, extra: Parameters<typeof incoming>[1] = {}) {
  const m: MessageWrite = incoming(thread, extra);
  return { ...m, from: { address, name: address } };
}

/** Stores one inbox thread from `address` the way a sync does. */
function arrive(t: Engine, thread: string, address: string, account = 'acct-1') {
  t.commit([from(thread, address, { accountId: account })], 'sync');
  return `${account}:${thread}`;
}

const rank = async (t: Engine, id: string) => (await rowOf(t, id)).rank;
const messages = (t: Engine) =>
  t.store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM messages')!.n);

const listener = (...scopes: Caller['scopes'][number][]): Caller => ({
  kind: 'listener',
  via: 'socket',
  clientId: 'tool-1',
  scopes,
});

const setLane = (t: Engine, match: string, lane: 'do' | 'update' | 'low', accountId?: string) =>
  t.call('SenderRule/set', {
    opId: nextOp('rule'),
    match,
    action: 'lane',
    lane,
    ...(accountId ? { accountId } : {}),
  });

const act = (t: Engine, ids: string[], action: ThreadAction) =>
  t.call('Thread/act', { opId: nextOp('act'), ids, action });

test('set, get and destroy round trip; a rule needs its lane and an existing target', async () => {
  const t = await empty();
  try {
    assert.deepEqual((await t.call('SenderRule/get', {})).list, []);
    const made = await setLane(t, ADA.toUpperCase(), 'low');
    assert.equal(made.rule.match, ADA, 'matched lower-case');
    assert.equal(made.rule.action, 'lane');
    assert.equal(made.rule.lane, 'low');
    assert.equal(made.rule.atProvider, false);
    assert.ok(made.rule.createdAt > 0 && made.rule.rev > 0);
    assert.equal(made.receipt.undoable, true);

    // The same match again changes the rule, it does not add a second one.
    const again = await setLane(t, ADA, 'do');
    assert.equal(again.rule.id, made.rule.id);
    assert.equal(again.rule.lane, 'do');
    assert.ok(again.rule.rev > made.rule.rev);
    const edited = await t.call('SenderRule/set', {
      opId: nextOp('rule'),
      id: made.rule.id,
      match: '@news.example',
      action: 'skipInbox',
    });
    assert.equal(edited.rule.match, '@news.example');
    assert.equal(edited.rule.lane, undefined);
    assert.equal((await t.call('SenderRule/get', {})).list.length, 1);

    await assert.rejects(
      t.call('SenderRule/set', { opId: nextOp('rule'), match: BEN, action: 'lane' }),
      isType('validation'),
    );
    await assert.rejects(
      t.call('SenderRule/set', { opId: nextOp('rule'), id: '999', match: BEN, action: 'block' }),
      isType('notFound'),
    );
    await assert.rejects(
      t.call('SenderRule/set', {
        opId: nextOp('rule'),
        match: BEN,
        action: 'block',
        accountId: 'nobody',
      }),
      isType('notFound'),
    );
    const other = await setLane(t, BEN, 'update');
    await assert.rejects(
      t.call('SenderRule/set', {
        opId: nextOp('rule'),
        id: other.rule.id,
        match: '@news.example',
        action: 'block',
      }),
      isType('conflict'),
    );

    await t.call('SenderRule/destroy', { opId: nextOp('rule'), id: made.rule.id });
    const left = await t.call('SenderRule/get', {});
    assert.deepEqual(
      left.list.map(r => r.id),
      [other.rule.id],
    );
    await assert.rejects(
      t.call('SenderRule/destroy', { opId: nextOp('rule'), id: made.rule.id }),
      isType('notFound'),
    );
  } finally {
    await t.close();
  }
});

test('a replayed opId applies once and answers the same receipt', async () => {
  const t = await empty();
  try {
    const opId = nextOp('rule');
    const args = { opId, match: ADA, action: 'lane', lane: 'low' } as const;
    const first = await t.call('SenderRule/set', args);
    const seq = t.store.seq();
    const second = await t.call('SenderRule/set', args);
    assert.equal(t.store.seq(), seq);
    assert.deepEqual(second.receipt, first.receipt);
    assert.equal(second.rule.id, first.rule.id);
  } finally {
    await t.close();
  }
});

test('the ingest hook applies a rule to new mail inside the commit that stores it', async () => {
  const t = await empty();
  try {
    await setLane(t, ADA, 'low');
    const before = t.store.seq();
    const id = arrive(t, 'n1', ADA);
    assert.equal(t.store.seq(), before + 1, 'one commit: the mail and its lane');
    const r = await rowOf(t, id);
    assert.equal(r.rank.lane, 'low');
    assert.equal(r.rank.source, 'rule');
    // Mail from someone else keeps its heuristic rank; so does the owner's own mail, a search hit and a local commit.
    assert.equal((await rank(t, arrive(t, 'n2', BEN))).source, 'heuristic');
    t.commit([{ ...from('n3', ADA, { remoteId: 'n3-s' }), origin: 'search' as const }], 'sync');
    assert.equal((await rank(t, 'acct-1:n3')).source, 'heuristic', 'a search hit');
    t.commit([from('n4', ADA)], 'local');
    assert.equal((await rank(t, 'acct-1:n4')).source, 'heuristic', 'a local commit');
    // A rule for one account does not touch another's mail.
    await setLane(t, BEN, 'do', 'acct-1');
    assert.equal((await rank(t, arrive(t, 'n5', BEN, 'imap:2'))).source, 'heuristic');
  } finally {
    await t.close();
  }
});

test('the ingest hook never overrides a lane the user set, and a later mail follows the rule', async () => {
  const t = await empty();
  try {
    const id = arrive(t, 'u1', ADA);
    await act(t, [id], { type: 'lane', lane: 'do' });
    await setLane(t, ADA, 'low');
    t.commit([from('u1', ADA, { remoteId: 'u1-b' })], 'sync');
    const r = await rank(t, id);
    assert.deepEqual([r.lane, r.source], ['do', 'user']);
    const fresh = arrive(t, 'u2', ADA);
    assert.deepEqual([(await rank(t, fresh)).lane, (await rank(t, fresh)).source], ['low', 'rule']);
  } finally {
    await t.close();
  }
});

test('a rule applied to existing threads is one commit with a receipt, and undo puts everything back', async () => {
  const t = await empty();
  try {
    const mine = [arrive(t, 'e1', ADA), arrive(t, 'e2', ADA), arrive(t, 'e3', ADA)];
    const elsewhere = arrive(t, 'e4', ADA, 'imap:2');
    const stranger = arrive(t, 'e5', BEN);
    const before = new Map<string, ReturnType<typeof facts>>();
    for (const id of [...mine, elsewhere, stranger]) before.set(id, facts(await rowOf(t, id)));

    const seq = t.store.seq();
    const { rule, receipt } = await setLane(t, ADA, 'low', 'acct-1');
    assert.equal(receipt.appliedState.seq, seq + 1, 'exactly one commit');
    assert.equal(t.store.seq(), seq + 1);
    assert.equal(receipt.undoable, true);
    for (const id of mine) assert.equal((await rank(t, id)).source, 'rule');
    for (const id of [elsewhere, stranger])
      assert.deepEqual(facts(await rowOf(t, id)), before.get(id), 'not the rule account or sender');
    const op = (await t.call('Operation/get', { opIds: [receipt.opId] })).list[0]!;
    assert.deepEqual(op.targets.sort(), [...mine].sort());
    assert.equal(op.scope, 'triage');

    await t.call('Operation/undo', { opId: receipt.opId, undoOpId: nextOp('undo') });
    for (const id of mine) assert.deepEqual(facts(await rowOf(t, id)), before.get(id));
    assert.deepEqual((await t.call('SenderRule/get', {})).list, [], `rule ${rule.id} is gone`);
  } finally {
    await t.close();
  }
});

test('undo of a rule edit and of a destroy brings the earlier rule back', async () => {
  const t = await empty();
  try {
    const { rule } = await setLane(t, ADA, 'low');
    const edit = await t.call('SenderRule/set', {
      opId: nextOp('rule'),
      id: rule.id,
      match: ADA,
      action: 'skipInbox',
    });
    await t.call('Operation/undo', { opId: edit.receipt.opId, undoOpId: nextOp('undo') });
    const [back] = (await t.call('SenderRule/get', {})).list;
    assert.deepEqual([back.id, back.action, back.lane], [rule.id, 'lane', 'low']);
    const gone = nextOp('rule');
    await t.call('SenderRule/destroy', { opId: gone, id: rule.id });
    assert.equal((await t.call('SenderRule/get', {})).list.length, 0);
    await t.call('Operation/undo', { opId: gone, undoOpId: nextOp('undo') });
    assert.equal((await t.call('SenderRule/get', {})).list[0]?.id, rule.id);
  } finally {
    await t.close();
  }
});

test('precedence: a rule beats a heuristic or AI lane, never a lane the user set', async () => {
  const t = await empty();
  try {
    const heuristic = arrive(t, 'p1', ADA);
    const ai = arrive(t, 'p2', ADA);
    const user = arrive(t, 'p3', ADA);
    const older = arrive(t, 'p4', ADA);
    t.commit([patch(ai, { lane: 'do', rankSource: 'ai' })]);
    t.commit([patch(older, { lane: 'do', rankSource: 'rule' })]);
    await act(t, [user], { type: 'lane', lane: 'do' });

    await setLane(t, ADA, 'low');
    for (const id of [heuristic, ai, older])
      assert.deepEqual([(await rank(t, id)).lane, (await rank(t, id)).source], ['low', 'rule']);
    const kept = await rank(t, user);
    assert.deepEqual([kept.lane, kept.source], ['do', 'user'], 'the user lane stands');
    // Changing the rule moves the rule-ranked threads and still leaves the user one.
    await setLane(t, ADA, 'update');
    assert.equal((await rank(t, heuristic)).lane, 'update');
    assert.equal((await rank(t, user)).lane, 'do');
  } finally {
    await t.close();
  }
});

test('"Always do this for [sender]" saves the rule in the same commit and moves the sender\'s other threads', async () => {
  const t = await empty();
  try {
    const chosen = arrive(t, 'a1', ADA);
    const other = arrive(t, 'a2', ADA);
    const mine = arrive(t, 'a3', ADA);
    const stranger = arrive(t, 'a4', BEN);
    await act(t, [mine], { type: 'lane', lane: 'do' });
    const seq = t.store.seq();
    const receipt = await act(t, [chosen], { type: 'lane', lane: 'low', alsoForSender: true });
    assert.equal(t.store.seq(), seq + 1, 'the lane and the rule are one commit');
    const rules = (await t.call('SenderRule/get', {})).list;
    assert.deepEqual(
      rules.map(r => [r.match, r.accountId, r.action, r.lane]),
      [[ADA, 'acct-1', 'lane', 'low']],
    );
    assert.deepEqual(
      [(await rank(t, chosen)).lane, (await rank(t, chosen)).source],
      ['low', 'user'],
    );
    assert.deepEqual([(await rank(t, other)).lane, (await rank(t, other)).source], ['low', 'rule']);
    assert.deepEqual([(await rank(t, mine)).lane, (await rank(t, mine)).source], ['do', 'user']);
    assert.equal((await rank(t, stranger)).source, 'heuristic');
    await t.call('Operation/undo', { opId: receipt.opId, undoOpId: nextOp('undo') });
    assert.deepEqual((await t.call('SenderRule/get', {})).list, []);
    assert.equal((await rank(t, other)).source, 'heuristic');

    // laneStep asks the same way.
    await act(t, [chosen], { type: 'laneStep', direction: 'up', alsoForSender: true });
    const [step] = (await t.call('SenderRule/get', {})).list;
    assert.equal(step.lane, (await rank(t, chosen)).lane);
  } finally {
    await t.close();
  }
});

test('"Always do this" leaves a block rule as it is', async () => {
  const t = await empty();
  try {
    const id = arrive(t, 'k1', ADA);
    await t.call('SenderRule/block', { opId: nextOp('block'), address: ADA });
    await act(t, [id], { type: 'lane', lane: 'do', alsoForSender: true });
    const [rule] = (await t.call('SenderRule/get', {})).list;
    assert.equal(rule.action, 'block');
  } finally {
    await t.close();
  }
});

test('a block hides mail, never deletes it, and unblock brings it back', async () => {
  const t = await empty();
  try {
    const mine = [arrive(t, 'b1', ADA), arrive(t, 'b2', ADA)];
    const stranger = arrive(t, 'b3', BEN);
    const elsewhere = arrive(t, 'b4', ADA, 'imap:2');
    const total = messages(t);
    const seq = t.store.seq();
    const { rule, receipt } = await t.call('SenderRule/block', {
      opId: nextOp('block'),
      address: ADA,
      accountId: 'acct-1',
    });
    assert.equal(receipt.appliedState.seq, seq + 1, 'one commit');
    assert.equal(rule.action, 'block');
    assert.equal(messages(t), total, 'no message row was deleted');
    for (const id of mine) {
      const r = await rowOf(t, id);
      assert.ok(r.labels.includes('acct-1:SPAM') && !r.labels.includes('acct-1:INBOX'));
      assert.equal(r.workflow.hiddenFromHome, true);
    }
    for (const id of [stranger, elsewhere]) {
      const r = await rowOf(t, id);
      assert.ok(r.labels.some(l => l.endsWith(':INBOX')) && !r.workflow.hiddenFromHome);
    }
    const ops = openOps(t.store);
    assert.equal(ops.length, 2, 'the provider is told to move each message to Spam');
    assert.ok(ops.every(o => o.scope === 'triage'));
    const home = await t.call('View/query', { spec: { kind: 'home' }, limit: 50 });
    assert.ok(
      mine.every(id => !home.ids.includes(id)),
      'out of Home',
    );

    // New mail from a blocked sender is hidden in the commit that stores it.
    const fresh = arrive(t, 'b5', ADA);
    assert.equal((await rowOf(t, fresh)).workflow.hiddenFromHome, true);

    const back = await t.call('SenderRule/unblock', { opId: nextOp('unblock'), address: ADA });
    assert.equal(back.undoable, true);
    assert.deepEqual((await t.call('SenderRule/get', {})).list, []);
    for (const id of mine) {
      const r = await rowOf(t, id);
      assert.ok(r.labels.includes('acct-1:INBOX') && !r.labels.includes('acct-1:SPAM'), id);
      assert.equal(r.workflow.hiddenFromHome, false);
    }
    // New mail was only hidden (it never moved to Spam), and nothing tells that from a thread the owner hid: it stays.
    assert.equal((await rowOf(t, fresh)).workflow.hiddenFromHome, true);
    assert.equal(messages(t), total + 1, 'still every message');
  } finally {
    await t.close();
  }
});

test('undo of a block puts the threads back; unblock leaves threads another block rule covers', async () => {
  const t = await empty();
  try {
    const id = arrive(t, 'c1', ADA);
    const before = facts(await rowOf(t, id));
    const { receipt } = await t.call('SenderRule/block', { opId: nextOp('block'), address: ADA });
    await t.call('Operation/undo', { opId: receipt.opId, undoOpId: nextOp('undo') });
    assert.deepEqual(facts(await rowOf(t, id)), before);
    assert.deepEqual((await t.call('SenderRule/get', {})).list, []);

    await t.call('SenderRule/block', { opId: nextOp('block'), address: ADA });
    await t.call('SenderRule/block', { opId: nextOp('block'), address: '@news.example' });
    await t.call('SenderRule/unblock', { opId: nextOp('unblock'), address: ADA });
    assert.equal(
      (await rowOf(t, id)).workflow.hiddenFromHome,
      true,
      'the domain block still holds',
    );
    // Unblocking someone who is not blocked changes nothing.
    await t.call('SenderRule/unblock', { opId: nextOp('unblock'), address: BEN });
  } finally {
    await t.close();
  }
});

test('destroying a block rule restores the sender like unblock; a skip-Inbox rule archives', async () => {
  const t = await empty();
  try {
    const id = arrive(t, 'd1', ADA);
    const { rule } = await t.call('SenderRule/block', { opId: nextOp('block'), address: ADA });
    await t.call('SenderRule/destroy', { opId: nextOp('rule'), id: rule.id });
    assert.ok((await rowOf(t, id)).labels.includes('acct-1:INBOX'));

    const quiet = arrive(t, 'd2', BEN);
    await t.call('SenderRule/set', { opId: nextOp('rule'), match: BEN, action: 'skipInbox' });
    const r = await rowOf(t, quiet);
    assert.ok(!r.labels.includes('acct-1:INBOX'), 'out of the Inbox');
    assert.equal(r.workflow.hiddenFromHome, true);
    assert.equal(messages(t), 2);
  } finally {
    await t.close();
  }
});

test('scopes: the rule commands need triage, reading rules needs read', async () => {
  const t = await empty();
  try {
    const { rule } = await setLane(t, ADA, 'low');
    const reader = t.engine.connect(listener('read'));
    const listed = (await reader.call('SenderRule/get', {})) as Output<'SenderRule/get'>;
    assert.equal(listed.list.length, 1);
    const seq = t.store.seq();
    const calls: [string, object][] = [
      ['SenderRule/set', { opId: nextOp('x'), match: BEN, action: 'block' }],
      ['SenderRule/destroy', { opId: nextOp('x'), id: rule.id }],
      ['SenderRule/block', { opId: nextOp('x'), address: BEN }],
      ['SenderRule/unblock', { opId: nextOp('x'), address: ADA }],
    ];
    for (const [method, args] of calls)
      await assert.rejects(
        (reader.call as (m: string, a: object) => Promise<unknown>)(method, args),
        isType('forbidden'),
        method,
      );
    assert.equal(t.store.seq(), seq, 'nothing was written');
    const tool = t.engine.connect(listener('read', 'triage'));
    await tool.call('SenderRule/block', { opId: nextOp('x'), address: BEN });
    assert.equal((await t.call('SenderRule/get', {})).list.length, 2);
  } finally {
    await t.close();
  }
});

test('get filters by account: an account sees its own rules and the global ones', async () => {
  const t = await empty();
  try {
    await setLane(t, ADA, 'low', 'acct-1');
    await setLane(t, BEN, 'low', 'imap:2');
    await setLane(t, '@all.example', 'low');
    const one = await t.call('SenderRule/get', { accountId: 'acct-1' });
    assert.deepEqual(
      one.list.map(r => r.match),
      [ADA, '@all.example'],
    );
    assert.equal((await t.call('SenderRule/get', {})).list.length, 3);
    assert.equal(one.state.dbEpoch, t.store.dbEpoch);
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------ review fixes

/** Writes a rule row the way another lane would: no application to threads, no journal. */
const rawRule = (t: Engine, rule: Record<string, unknown>) =>
  t.commit([{ kind: 'senderRule', op: 'put', accountId: null, ...rule } as StoreWrite]);

const block = (t: Engine, address: string, accountId?: string) =>
  t.call('SenderRule/block', {
    opId: nextOp('block'),
    address,
    ...(accountId ? { accountId } : {}),
  });

const where = async (t: Engine, id: string) => {
  const r = await rowOf(t, id);
  return {
    hidden: r.workflow.hiddenFromHome === true,
    inbox: r.labels.includes('acct-1:INBOX'),
    spam: r.labels.includes('acct-1:SPAM'),
  };
};

test('a more specific rule governs: a domain or global rule leaves a thread it does not govern', async () => {
  const t = await empty();
  try {
    const ada = arrive(t, 'g1', ADA);
    const ben = arrive(t, 'g2', BEN);
    await setLane(t, ADA, 'do', 'acct-1');
    await setLane(t, '@news.example', 'low');
    assert.equal((await rank(t, ada)).lane, 'do', 'the exact address wins over its domain');
    assert.equal((await rank(t, ben)).lane, 'low');
    assert.equal((await rank(t, arrive(t, 'g4', ADA))).lane, 'do', 'as new mail does');

    const cy = arrive(t, 'g3', 'cy@other.example');
    await setLane(t, 'cy@other.example', 'do', 'acct-1');
    await setLane(t, 'cy@other.example', 'low');
    assert.equal((await rank(t, cy)).lane, 'do', "an account's own rule wins over a global one");

    await block(t, '@news.example');
    assert.deepEqual(await where(t, ada), { hidden: false, inbox: true, spam: false });
    assert.equal((await where(t, ben)).hidden, true);
  } finally {
    await t.close();
  }
});

test('unblock plans a thread once when two block rules cover it', async () => {
  const t = await empty();
  try {
    const id = arrive(t, 'q1', ADA);
    await block(t, ADA, 'acct-1');
    await block(t, ADA);
    const opened = openOps(t.store).length;
    const { opId } = await t.call('SenderRule/unblock', {
      opId: nextOp('unblock'),
      address: ADA,
    });
    assert.equal(openOps(t.store).length, opened + 1, 'one restore op');
    const op = (await t.call('Operation/get', { opIds: [opId] })).list[0]!;
    assert.deepEqual(op.targets, [id]);
    assert.deepEqual(await where(t, id), { hidden: false, inbox: true, spam: false });
  } finally {
    await t.close();
  }
});

test('unblock leaves a thread the block did not hide itself', async () => {
  const t = await empty();
  try {
    // Hidden by the owner before a block that arrived later, from the block's journal.
    const early = arrive(t, 'h1', BEN);
    await act(t, [early], { type: 'home', hidden: true });
    await block(t, BEN);
    assert.deepEqual(await where(t, early), { hidden: true, inbox: false, spam: true });
    await t.call('SenderRule/unblock', { opId: nextOp('unblock'), address: BEN });
    assert.deepEqual(await where(t, early), { hidden: true, inbox: true, spam: false });
  } finally {
    await t.close();
  }
});

test('without a journal, unblock restores only threads that are in Spam and hidden', async () => {
  const t = await empty();
  try {
    const byHand = arrive(t, 'j1', ADA);
    const junk = arrive(t, 'j2', ADA);
    t.commit([from('j2', ADA, { folder: 'SPAM', remoteId: 'j2-s' })]);
    rawRule(t, { match: ADA, action: 'block' });
    await act(t, [byHand], { type: 'home', hidden: true });
    t.commit([patch(junk, { hiddenFromHome: true })]);
    await t.call('SenderRule/unblock', { opId: nextOp('unblock'), address: ADA });
    assert.equal((await where(t, byHand)).hidden, true, 'hidden by hand stays hidden');
    assert.equal((await where(t, junk)).hidden, false);
    assert.equal((await where(t, junk)).spam, false);
  } finally {
    await t.close();
  }
});

test('removing a block keeps what another remaining rule still asks for', async () => {
  const t = await empty();
  try {
    const id = arrive(t, 'r1', ADA);
    const { rule } = await block(t, ADA);
    await t.call('SenderRule/set', {
      opId: nextOp('rule'),
      match: '@news.example',
      action: 'skipInbox',
    });
    await t.call('SenderRule/destroy', { opId: nextOp('rule'), id: rule.id });
    assert.deepEqual(
      await where(t, id),
      { hidden: true, inbox: false, spam: false },
      'skip-Inbox holds',
    );

    // A remaining domain block holds even when an exact lane rule is the first rule that covers the sender.
    const other = arrive(t, 'r2', 'zed@zed.example');
    await block(t, '@zed.example');
    await setLane(t, 'zed@zed.example', 'do', 'acct-1');
    await block(t, 'zed@zed.example');
    await t.call('SenderRule/unblock', { opId: nextOp('unblock'), address: 'zed@zed.example' });
    assert.deepEqual(await where(t, other), { hidden: true, inbox: false, spam: true });
  } finally {
    await t.close();
  }
});

test('malformed rule rows are ignored, and the ingest hook never throws', async () => {
  const t = await empty();
  try {
    rawRule(t, { match: ADA, action: 'lane', lane: 'bogus' });
    rawRule(t, { match: BEN, action: 'frobnicate' });
    assert.deepEqual((await t.call('SenderRule/get', {})).list, []);
    const a = arrive(t, 'm1', ADA);
    const b = arrive(t, 'm2', BEN);
    for (const id of [a, b]) {
      assert.equal((await rank(t, id)).source, 'heuristic', id);
      assert.equal((await where(t, id)).hidden, false, id);
    }
    await setLane(t, '@news.example', 'low');
    assert.equal((await rank(t, arrive(t, 'm3', ADA))).lane, 'low', 'a good rule still applies');
  } finally {
    await t.close();
  }
});

test('the ingest hook picks the exact address over its domain and an account rule over a global one', async () => {
  const t = await empty();
  try {
    await setLane(t, '@news.example', 'low');
    await setLane(t, ADA, 'do');
    await setLane(t, BEN, 'update');
    await setLane(t, BEN, 'low', 'acct-1');
    t.commit(
      [
        from('i1', ADA),
        from('i2', BEN),
        from('i3', 'cy@news.example'),
        from('i4', BEN, { accountId: 'imap:2' }),
      ],
      'sync',
    );
    const lanes = await Promise.all(
      ['acct-1:i1', 'acct-1:i2', 'acct-1:i3', 'imap:2:i4'].map(
        async id => (await rank(t, id)).lane,
      ),
    );
    assert.deepEqual(lanes, ['do', 'low', 'low', 'update']);
  } finally {
    await t.close();
  }
});
