/**
 * The `api` members added for the settings, calendar, Ask and shell screens, on the stand-in engine: queries go straight
 * to the client, commands mint their `opId` and join the operations and the one undo stack when the receipt can be
 * undone, and main's native methods are answered by the stand-in's stub. Node, no DOM:
 * `cd apps/desktop && npx tsx --test src/renderer/data/api-gaps.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getMethod } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { createHarness, type Harness } from './harness';
import { CONTRACT_METHODS, HARNESS_NOW_MS, OperationFailedError } from './index';

const DAY = 86_400_000;
import { isNativeStubbed } from './native-stub';

async function withHarness(run: (h: Harness) => Promise<void>) {
  const h = createHarness();
  try {
    await h.settle();
    await run(h);
  } finally {
    h.close();
  }
}

async function openPlan(h: Harness): Promise<string> {
  const { ids } = await h.truth.api.view.query({ spec: { kind: 'plans' } });
  assert.ok(ids[0], 'the demo has an open plan');
  return ids[0];
}

async function planState(h: Harness, id: string): Promise<string | undefined> {
  return (await h.truth.api.plan.get({ ids: [id] })).list[0]?.state;
}

test('queries go straight to the client, one call each', async () => {
  await withHarness(async h => {
    const { api } = h.layer;
    h.clearCalls();
    const providers = await api.ai.providers();
    assert.ok(providers.list.length > 0);
    assert.equal(h.callsOf('Ai/providers').length, 1);
    assert.deepEqual(h.callsOf('Ai/providers')[0]!.args, {});

    const models = await api.ai.models({ provider: 'groq' });
    assert.deepEqual(h.callsOf('Ai/models')[0]!.args, { provider: 'groq' });
    assert.equal(typeof models.live, 'boolean');

    assert.ok((await api.ai.status()).features.length > 0);
    assert.equal(typeof (await api.ai.usage()), 'object');
    assert.equal((await api.ask.suggestions()).list.length, 3);
    assert.ok((await api.calendar.get()).list.length > 0);
    assert.equal(typeof (await api.listener.get()).enabled, 'boolean');
    assert.ok(Array.isArray((await api.clients.list()).list));
    assert.ok(Array.isArray((await api.queue.list({})).list));
    const discovered = await api.account.discover({ address: 'someone@gmail.com' });
    assert.equal(discovered.provider, 'google');
    assert.ok((await api.account.lease({ pin: false })).leases.length > 0);
    // Queries are not operations: no opId was minted for any of them.
    assert.equal(h.layer.operations.all().length, 0);
  });
});

test('account discover goes to the client with the input untouched and answers how the account can connect', async () => {
  await withHarness(async h => {
    const { api } = h.layer;
    h.clearCalls();
    const discovered = await api.account.discover({ address: 'someone@gmail.com' });
    assert.deepEqual(discovered, { provider: 'google', preset: 'gmail' });
    assert.equal(h.callsOf('Account/discover').length, 1);
    // `Account/discover` takes {address | domain} and nothing else: no opId and no requestId to mint.
    assert.deepEqual(h.callsOf('Account/discover')[0]!.args, { address: 'someone@gmail.com' });

    const byDomain = await api.account.discover({ domain: 'fastmail.com' });
    assert.equal(byDomain.provider, 'fastmail');
    assert.deepEqual(h.callsOf('Account/discover')[1]!.args, { domain: 'fastmail.com' });
    assert.equal(h.layer.operations.all().length, 0, 'discover is a query, not an operation');

    // Neither address nor domain: the engine's refusal reaches the caller as its ContractError, unchanged.
    await assert.rejects(
      () => api.account.discover({}),
      (error: unknown) =>
        error instanceof ContractError &&
        error.type === 'validation' &&
        error.message === 'Enter a valid email address.',
    );
  });
});

test('a key is saved, tested and removed through the vault calls, and the table never carries it', async () => {
  await withHarness(async h => {
    const { api } = h.layer;
    const saved = await api.ai.setKey({ provider: 'openai', key: 'sk-test-not-a-real-key' });
    assert.equal(saved.keySource, 'keychain');
    const table = await api.ai.providers();
    assert.ok(!JSON.stringify(table).includes('sk-test-not-a-real-key'));
    assert.equal((await api.ai.testKey({ provider: 'openai' })).ok, true);
    assert.equal((await api.ai.removeKey({ provider: 'openai' })).keySource, 'none');
  });
});

test('a command mints its opId, joins the operations and the undo stack, and Z reverses it', async () => {
  await withHarness(async h => {
    const { api, operations, undoStack } = h.layer;
    const id = await openPlan(h);
    assert.equal(await planState(h, id), 'open');

    const result = await api.plan.dismiss({ ids: [id] });
    assert.equal(h.callsOf('Plan/dismiss').length, 1);
    const sent = h.callsOf('Plan/dismiss')[0]!.args as { opId: string };
    assert.match(sent.opId, /^op-t\d+$/, 'the data layer minted the opId');
    assert.equal(result.opId, sent.opId, 'the receipt is for the operation it minted');
    assert.equal(await planState(h, id), 'dismissed');

    const view = operations.view(sent.opId)!;
    assert.equal(view.state, 'confirmed');
    assert.equal(view.undoable, true);
    assert.deepEqual(undoStack.peek(), { kind: 'operation', id: 'undo-t2', opId: sent.opId });

    const outcome = undoStack.undoLast();
    assert.equal(outcome?.kind, 'operation');
    if (outcome?.kind === 'operation') await outcome.result.receipt;
    assert.equal(h.callsOf('Operation/undo').length, 1);
    assert.equal(await planState(h, id), 'open', 'the engine put the plan back');
    assert.equal(undoStack.peek(), null);
  });
});

test('a caller-supplied opId is kept, and a confirm returns its event and can be undone', async () => {
  await withHarness(async h => {
    const { api, undoStack } = h.layer;
    const id = await openPlan(h);
    const confirmed = await api.plan.confirm({ id, opId: 'op-mine' });
    assert.equal(confirmed.receipt.opId, 'op-mine');
    assert.equal((h.callsOf('Plan/confirm')[0]!.args as { opId: string }).opId, 'op-mine');
    assert.equal((await h.truth.api.event.get({ ids: [confirmed.eventId] })).list.length, 1);
    assert.equal(undoStack.peek()?.kind, 'operation');
    const outcome = undoStack.undoLast();
    if (outcome?.kind === 'operation') await outcome.result.receipt;
    assert.equal(await planState(h, id), 'open');
  });
});

test('a calendar toggle, an RSVP and an event edit are operations too', async () => {
  await withHarness(async h => {
    const { api, operations } = h.layer;
    const [calendar] = (await api.calendar.get()).list;
    assert.ok(calendar);
    const set = await api.calendar.set({ id: calendar.id, shown: !calendar.shown });
    assert.equal(set.calendar.shown, !calendar.shown);
    assert.equal(operations.view(set.receipt.opId)?.state, 'confirmed');
    const undone = h.layer.undoStack.undoLast();
    if (undone?.kind === 'operation') await undone.result.receipt;
    assert.equal(
      (await h.truth.api.calendar.get({})).list.find(c => c.id === calendar.id)?.shown,
      calendar.shown,
    );

    const window = await h.truth.api.view.query({
      spec: { kind: 'events', from: HARNESS_NOW_MS - 7 * DAY, to: HARNESS_NOW_MS + 14 * DAY },
    });
    const events = (await h.truth.api.event.get({ ids: window.ids.slice(0, 200) })).list;
    const invite = events.find(e => e.can.rsvp);
    const mine = events.find(e => e.can.edit);
    assert.ok(invite, 'the demo week has an event to answer');
    assert.ok(mine, 'the demo week has an event to edit');

    const answered = await api.event.rsvp({
      id: invite.id,
      response: 'accepted',
      scope: 'occurrence',
    });
    assert.equal(operations.view(answered.opId)?.state, 'confirmed');
    assert.deepEqual(
      { ...h.layer.undoStack.peek(), id: '' },
      { kind: 'operation', id: '', opId: answered.opId },
    );

    const edited = await api.event.set({
      change: { type: 'update', id: mine.id, scope: 'series', fields: { title: 'Renamed' } },
      notify: false,
    });
    assert.equal(operations.view(edited.receipt.opId)?.state, 'confirmed');
    assert.deepEqual(
      { ...h.layer.undoStack.peek(), id: '' },
      { kind: 'operation', id: '', opId: edited.receipt.opId },
    );
    const back = h.layer.undoStack.undoLast();
    if (back?.kind === 'operation') await back.result.receipt;
    assert.equal(
      (await h.truth.api.event.get({ ids: [mine.id] })).list[0]?.title,
      mine.title,
      'Z put the event back',
    );
    assert.deepEqual(
      { ...h.layer.undoStack.peek(), id: '' },
      { kind: 'operation', id: '', opId: answered.opId },
      'the RSVP is next on the stack',
    );
  });
});

test('a refused command rejects with OperationFailedError, marks the operation failed, and retry sends a fresh opId', async () => {
  await withHarness(async h => {
    const { api, operations, undoStack } = h.layer;
    await assert.rejects(
      () => api.plan.confirm({ id: 'no-such-plan', opId: 'op-bad' }),
      (error: unknown) =>
        error instanceof OperationFailedError &&
        error.opId === 'op-bad' &&
        error.error.type === 'notFound',
    );
    const view = operations.view('op-bad')!;
    assert.equal(view.state, 'failed');
    assert.equal(view.error?.type, 'notFound');
    assert.equal(undoStack.peek(), null, 'a refused write is not undoable');

    const again = view.retry();
    assert.notEqual(again.opId, 'op-bad');
    await assert.rejects(() => again.receipt);
    assert.equal(operations.view(again.opId)?.state, 'failed');
    assert.equal(h.callsOf('Plan/confirm').length, 2);
  });
});

test('disconnecting an account is an operation that cannot be undone', async () => {
  await withHarness(async h => {
    const { api, operations, undoStack } = h.layer;
    const accounts = (await h.truth.api.account.get({})).list;
    const target = accounts.at(-1)!;
    const receipt = await api.account.disconnect({ accountId: target.id });
    assert.equal(receipt.undoable, false);
    assert.equal(operations.view(receipt.opId)?.state, 'confirmed');
    assert.equal(operations.view(receipt.opId)?.undoable, false);
    assert.equal(undoStack.peek(), null);
    await h.settle();
    assert.ok(!(await h.truth.api.account.get({})).list.some(a => a.id === target.id));
  });
});

test('Ask: a conversation is deleted as an undoable operation', async () => {
  await withHarness(async h => {
    const { api, undoStack } = h.layer;
    const run = await api.ask.run({ question: 'What needs my reply today?' });
    await h.settle();
    const before = await h.truth.api.conversation.get({ ids: [run.conversationId] });
    assert.equal(before.list.length, 1);
    const receipt = await api.conversation.destroy({ id: run.conversationId });
    assert.equal(
      (await h.truth.api.conversation.get({ ids: [run.conversationId] })).list.length,
      0,
    );
    assert.equal(undoStack.peek()?.kind, 'operation');
    const outcome = undoStack.undoLast();
    if (outcome?.kind === 'operation') await outcome.result.receipt;
    assert.equal(
      (await h.truth.api.conversation.get({ ids: [run.conversationId] })).list.length,
      1,
    );
    assert.ok(receipt.opId);
  });
});

test('main-served methods are native in the table and answered by the stand-in stub', async () => {
  await withHarness(async h => {
    const { api } = h.layer;
    const nativeNames = [
      'window.openOnboarding',
      'window.finishOnboarding',
      'system.login',
      'system.defaultMail',
      'system.microphone',
      'system.notifications',
      'system.openSettings',
      'shell.open',
      'notification.test',
    ] as const;
    for (const name of nativeNames) {
      const ref = CONTRACT_METHODS[name];
      assert.equal(ref.kind, 'native', `${name} is served by main`);
      assert.equal(getMethod(ref.method).host, 'desktop');
      assert.ok(isNativeStubbed(ref.method), `${ref.method} has a stand-in stub`);
    }
    h.clearCalls();
    assert.deepEqual(await api.window.openOnboarding({ mode: 'review' }), { ok: true });
    assert.deepEqual(await api.window.finishOnboarding(), { ok: true });
    assert.deepEqual(await api.notification.test(), { ok: true });
    assert.deepEqual(await api.system.openSettings({ pane: 'microphone' }), { ok: true });
    assert.deepEqual(await api.shell.open({ url: 'https://meet.example.com/abc' }), { ok: true });
    assert.deepEqual(await api.system.login({ enabled: true }), { enabled: true });
    assert.deepEqual(await api.system.login({}), { enabled: false });
    assert.deepEqual(await api.system.microphone({ check: true }), {
      granted: false,
      status: 'notDetermined',
    });
    assert.deepEqual(await api.system.notifications(), { status: 'unknown' });
    assert.deepEqual(await api.system.defaultMail(), { success: false });
    assert.deepEqual(h.callsOf('Window/openOnboarding')[0]!.args, { mode: 'review' });
    assert.equal(h.layer.operations.all().length, 0, 'native calls are not operations');
  });
});

test('a command is on the undo stack while its receipt is in flight, in issue order, and undoing marks it undone at once', async () => {
  await withHarness(async h => {
    const { api, operations, undoStack } = h.layer;
    const [calendar] = (await api.calendar.get()).list;
    assert.ok(calendar);
    const id = await openPlan(h);
    const first = api.plan.dismiss({ ids: [id], opId: 'op-first' });
    const mid = undoStack.peek();
    assert.equal(
      mid?.kind === 'operation' ? mid.opId : null,
      'op-first',
      'on the stack before the receipt',
    );
    assert.equal(operations.view('op-first')?.state, 'pending');
    assert.equal(operations.view('op-first')?.undoable, true);
    const second = api.calendar.set({ id: calendar.id, shown: !calendar.shown, opId: 'op-second' });
    const top = undoStack.peek();
    assert.equal(
      top?.kind === 'operation' ? top.opId : null,
      'op-second',
      'newest issued is on top',
    );
    await Promise.all([first, second]);
    const after = undoStack.peek();
    assert.equal(after?.kind === 'operation' ? after.opId : null, 'op-second');

    // Z: the view is not undoable the moment Operation/undo is issued, so a toast cannot send it twice.
    const outcome = undoStack.undoLast();
    assert.equal(operations.view('op-second')?.undoable, false);
    assert.equal(operations.view('op-first')?.undoable, true);
    if (outcome?.kind === 'operation') await outcome.result.receipt;
    assert.equal(operations.view('op-second')?.undoable, false);
    const next = undoStack.peek();
    assert.equal(next?.kind === 'operation' ? next.opId : null, 'op-first');
  });
});

test('a receipt that cannot be undone takes the command off the undo stack again', async () => {
  await withHarness(async h => {
    const { api, undoStack } = h.layer;
    const target = (await h.truth.api.account.get({})).list.at(-1)!;
    const pending = api.account.disconnect({ accountId: target.id, opId: 'op-gone' });
    const top = undoStack.peek();
    assert.equal(
      top?.kind === 'operation' ? top.opId : null,
      'op-gone',
      'on the stack when issued',
    );
    await pending;
    assert.equal(undoStack.peek(), null, 'and off it once the receipt says undoable: false');
  });
});

test('Ask: accepting a proposal makes its draft and can be undone; dismissing makes nothing', async () => {
  await withHarness(async h => {
    const { api, operations, undoStack } = h.layer;
    const threads = await h.truth.api.view.query({ spec: { kind: 'homeSection', section: 'do' } });
    const threadId = threads.ids[0];
    assert.ok(threadId, 'the demo inbox has a thread to reply to');
    async function proposal() {
      const run = await api.ask.run({
        question: 'Write back to this',
        context: { threadId },
      });
      await h.control.advanceClock({ ms: 2_000 });
      await h.settle();
      const conversation = (await h.truth.api.conversation.get({ ids: [run.conversationId] }))
        .list[0]!;
      const turn = conversation.turns.at(-1)!;
      const found = turn.proposals[0];
      assert.ok(found, 'Ask proposed a reply');
      return { conversationId: conversation.id, turnId: turn.id, proposalId: found.id };
    }

    const accepted = await proposal();
    const result = await api.ask.decide({ ...accepted, accept: true });
    assert.ok(result.draftId, 'accepting a reply makes a draft');
    assert.equal(operations.view(result.receipt.opId)?.state, 'confirmed');
    const top = undoStack.peek();
    assert.equal(top?.kind === 'operation' ? top.opId : null, result.receipt.opId);
    assert.equal((await h.truth.api.draft.get({ ids: [result.draftId] })).list.length, 1);
    const outcome = undoStack.undoLast();
    if (outcome?.kind === 'operation') await outcome.result.receipt;
    assert.equal((await h.truth.api.draft.get({ ids: [result.draftId] })).list.length, 0);

    const declined = await proposal();
    const dismissed = await api.ask.decide({ ...declined, accept: false });
    assert.equal(dismissed.draftId, undefined);
    assert.equal(dismissed.eventId, undefined);
    assert.equal(operations.view(dismissed.receipt.opId)?.state, 'confirmed');
    // A decided proposal cannot be decided again: the refusal is an OperationFailedError.
    await assert.rejects(
      () => api.ask.decide({ ...declined, accept: true }),
      (error: unknown) => error instanceof OperationFailedError && error.error.type === 'conflict',
    );
  });
});

test('the native stub refuses what main would refuse under the contract schema', async () => {
  await withHarness(async h => {
    const { api } = h.layer;
    await assert.rejects(
      () => api.system.openSettings({ pane: 'nonsense' } as never),
      (error: { body?: { type?: string }; type?: string }) =>
        (error.body?.type ?? error.type) === 'validation',
    );
    assert.deepEqual(await api.system.openSettings({ pane: 'microphone' }), { ok: true });
    await assert.rejects(
      () => api.shell.open({ url: 'x'.repeat(4_001) }),
      (error: { body?: { type?: string }; type?: string }) =>
        (error.body?.type ?? error.type) === 'validation',
    );
  });
});
