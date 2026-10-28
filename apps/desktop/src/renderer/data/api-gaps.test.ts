/**
 * The `api` members added for the settings, calendar, Ask and shell screens, on the stand-in engine: queries go straight
 * to the client, commands mint their `opId` and join the operations and the one undo stack when the receipt can be
 * undone, and main's native methods are answered by the stand-in's stub. Node, no DOM:
 * `cd apps/desktop && npx tsx --test src/renderer/data/api-gaps.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getMethod } from '@aplos/contract';
import { createHarness, type Harness } from './harness';
import { CONTRACT_METHODS, HARNESS_NOW_MS } from './index';

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
    if (invite) {
      const receipt = await api.event.rsvp({
        id: invite.id,
        response: 'accepted',
        scope: 'occurrence',
      });
      assert.equal(operations.view(receipt.opId)?.state, 'confirmed');
    }
    if (mine) {
      const edited = await api.event.set({
        change: { type: 'update', id: mine.id, scope: 'series', fields: { title: 'Renamed' } },
        notify: false,
      });
      assert.equal(operations.view(edited.receipt.opId)?.state, 'confirmed');
    }
    assert.ok(invite || mine, 'the demo week has events to answer or edit');
  });
});

test('a refused command rejects with the engine error, marks the operation failed, and retry sends a fresh opId', async () => {
  await withHarness(async h => {
    const { api, operations, undoStack } = h.layer;
    await assert.rejects(
      () => api.plan.confirm({ id: 'no-such-plan', opId: 'op-bad' }),
      (error: { body?: { type?: string } }) => error.body?.type === 'notFound',
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
