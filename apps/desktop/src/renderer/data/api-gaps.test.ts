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
import type { Api as ClientApi } from '@aplos/contract/client';
import { createHarness, type Harness } from './harness';
import { CONTRACT_METHODS, HARNESS_NOW_MS, OperationFailedError } from './index';
import type { CommandArgs, ContractMethodOf, DataApi } from './index';

const DAY = 86_400_000;
import { isNativeStubbed } from './native-stub';

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** `api.event.hide` is the client's `Event/hide` call, with `opId` minted by the data layer when absent. */
const eventHideSignature: [
  Equals<ReturnType<DataApi['event']['hide']>, ReturnType<ClientApi['event']['hide']>>,
  Equals<Parameters<DataApi['event']['hide']>[0], CommandArgs<'Event/hide'>>,
  Equals<ContractMethodOf<'event.hide'>, 'Event/hide'>,
] = [true, true, true];

/** The settings members are the client's own call types, so they cannot drift; `account.disconnect` mints its `opId` like `event.hide`. */
const settingsSignatures: [
  Equals<DataApi['ai']['providers'], ClientApi['ai']['providers']>,
  Equals<DataApi['ai']['models'], ClientApi['ai']['models']>,
  Equals<DataApi['ai']['usage'], ClientApi['ai']['usage']>,
  Equals<DataApi['ai']['setKey'], ClientApi['ai']['setKey']>,
  Equals<DataApi['ai']['removeKey'], ClientApi['ai']['removeKey']>,
  Equals<DataApi['ai']['testKey'], ClientApi['ai']['testKey']>,
  Equals<DataApi['account']['discover'], ClientApi['account']['discover']>,
  Equals<DataApi['account']['lease'], ClientApi['account']['lease']>,
  Equals<
    ReturnType<DataApi['account']['disconnect']>,
    ReturnType<ClientApi['account']['disconnect']>
  >,
  Equals<Parameters<DataApi['account']['disconnect']>[0], CommandArgs<'Account/disconnect'>>,
  Equals<ContractMethodOf<'account.disconnect'>, 'Account/disconnect'>,
  Equals<DataApi['listener']['get'], ClientApi['listener']['get']>,
  Equals<DataApi['listener']['set'], ClientApi['listener']['set']>,
  Equals<DataApi['clients']['list'], ClientApi['clients']['list']>,
  Equals<DataApi['clients']['grant'], ClientApi['clients']['grant']>,
  Equals<DataApi['clients']['revoke'], ClientApi['clients']['revoke']>,
  Equals<DataApi['clients']['audit'], ClientApi['clients']['audit']>,
  Equals<DataApi['queue']['list'], ClientApi['queue']['list']>,
  Equals<DataApi['queue']['retry'], ClientApi['queue']['retry']>,
  Equals<DataApi['queue']['discard'], ClientApi['queue']['discard']>,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];

/** Compile-only: `Event/hide`'s input is `{ids, hidden}` plus an `opId` the data layer may mint; never run. */
export function hideSignature(api: DataApi) {
  void api.event.hide({ ids: ['e1', 'e2'], hidden: true });
  void api.event.hide({ ids: ['e1'], hidden: false, opId: 'op-mine' });
  // @ts-expect-error: `hidden` says hide or show again; it is required.
  void api.event.hide({ ids: ['e1'] });
  // @ts-expect-error: `ids` is required.
  void api.event.hide({ hidden: true });
}

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
    assert.deepEqual(h.callsOf('Ai/status')[0]!.args, {});
    assert.equal(typeof (await api.ai.usage()), 'object');
    assert.deepEqual(h.callsOf('Ai/usage')[0]!.args, {});
    assert.equal((await api.ask.suggestions()).list.length, 3);
    assert.ok((await api.calendar.get()).list.length > 0);
    assert.equal(typeof (await api.listener.get()).enabled, 'boolean');
    assert.deepEqual(h.callsOf('Listener/get')[0]!.args, {});
    assert.ok(Array.isArray((await api.clients.list()).list));
    assert.deepEqual(h.callsOf('Clients/list')[0]!.args, {});
    assert.ok(Array.isArray((await api.queue.list({})).list));
    assert.deepEqual(h.callsOf('Queue/list')[0]!.args, {});
    const discovered = await api.account.discover({ address: 'someone@gmail.com' });
    assert.equal(discovered.provider, 'google');
    assert.deepEqual(h.callsOf('Account/discover')[0]!.args, { address: 'someone@gmail.com' });
    assert.ok((await api.account.lease({ pin: false })).leases.length > 0);
    assert.deepEqual(h.callsOf('Account/lease')[0]!.args, { pin: false });
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
    assert.deepEqual(h.callsOf('Ai/setKey')[0]!.args, {
      provider: 'openai',
      key: 'sk-test-not-a-real-key',
    });
    const table = await api.ai.providers();
    assert.ok(!JSON.stringify(table).includes('sk-test-not-a-real-key'));
    assert.equal((await api.ai.testKey({ provider: 'openai' })).ok, true);
    assert.deepEqual(h.callsOf('Ai/testKey')[0]!.args, { provider: 'openai' });
    assert.equal((await api.ai.removeKey({ provider: 'openai' })).keySource, 'none');
    assert.deepEqual(h.callsOf('Ai/removeKey')[0]!.args, { provider: 'openai' });
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

test('event.hide mints its opId, forwards the input unchanged, and hides in Aplos only', async () => {
  await withHarness(async h => {
    const { api, operations, undoStack } = h.layer;
    assert.ok(eventHideSignature.every(Boolean));
    const window = await h.truth.api.view.query({
      spec: { kind: 'events', from: HARNESS_NOW_MS - 7 * DAY, to: HARNESS_NOW_MS + 14 * DAY },
    });
    const id = window.ids[0];
    assert.ok(id, 'the demo week has an event');
    h.clearCalls();

    const receipt = await api.event.hide({ ids: [id], hidden: true });
    assert.equal(h.callsOf('Event/hide').length, 1);
    const sent = h.callsOf('Event/hide')[0]!.args as {
      opId: string;
      ids: string[];
      hidden: boolean;
    };
    assert.match(sent.opId, /^op-t\d+$/, 'the data layer minted the opId');
    assert.deepEqual(
      { ...sent, opId: '' },
      { opId: '', ids: [id], hidden: true },
      'the input went to the client unchanged but for the minted opId',
    );
    assert.equal(receipt.opId, sent.opId, "the contract output is the minted operation's receipt");
    assert.equal(operations.view(sent.opId)?.state, 'confirmed');
    assert.equal((await h.truth.api.event.get({ ids: [id] })).list[0]?.hidden, true);
    assert.equal(undoStack.peek()?.kind, 'operation');

    const shown = await api.event.hide({ ids: [id], hidden: false, opId: 'op-show' });
    assert.equal(shown.opId, 'op-show', 'a caller-supplied opId is kept');
    assert.equal((await h.truth.api.event.get({ ids: [id] })).list[0]?.hidden, undefined);

    await assert.rejects(
      () => api.event.hide({ ids: ['no-such-event'], hidden: true, opId: 'op-bad' }),
      (error: unknown) =>
        error instanceof OperationFailedError &&
        error.opId === 'op-bad' &&
        error.error.type === 'notFound' &&
        error.error.message === 'This event is no longer available.',
    );
    assert.equal(operations.view('op-bad')?.state, 'failed');
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

test('the tools and queue members forward their input unchanged and return the contract output', async () => {
  await withHarness(async h => {
    const { api } = h.layer;
    assert.ok(settingsSignatures.every(Boolean));
    h.clearCalls();

    const on = await api.listener.set({ enabled: true });
    assert.deepEqual(h.callsOf('Listener/set')[0]!.args, { enabled: true });
    assert.equal(on.enabled, true);
    assert.equal((await api.listener.get()).enabled, true);
    assert.equal((await api.listener.set({ enabled: false })).enabled, false);

    const grant = await api.clients.grant({
      name: 't3-code',
      kind: 'cli',
      scopes: ['read', 'triage'],
    });
    assert.deepEqual(h.callsOf('Clients/grant')[0]!.args, {
      name: 't3-code',
      kind: 'cli',
      scopes: ['read', 'triage'],
    });
    assert.equal(grant.client.name, 't3-code');
    assert.ok((await api.clients.list()).list.some(c => c.id === grant.client.id));

    const audit = await api.clients.audit({ clientId: grant.client.id, limit: 10 });
    assert.deepEqual(h.callsOf('Clients/audit')[0]!.args, {
      clientId: grant.client.id,
      limit: 10,
    });
    assert.deepEqual(audit, { list: [] });

    assert.deepEqual(await api.clients.revoke({ id: grant.client.id }), { ok: true });
    assert.deepEqual(h.callsOf('Clients/revoke')[0]!.args, { id: grant.client.id });
    assert.ok(
      (await api.clients.list()).list.find(c => c.id === grant.client.id)?.revokedAt,
      'the tool shows as revoked',
    );

    // A queued AI job is a queue item; retry and discard take it by id.
    const threads = await h.truth.api.view.query({
      spec: { kind: 'homeSection', section: 'do' },
    });
    await api.ai.request({ kind: 'classify', threadId: threads.ids[0]! });
    await h.settle();
    const job = (await api.queue.list({ kinds: ['job'] })).list[0];
    assert.ok(job, 'the request queued a job');
    assert.equal(job.kind, 'job');

    assert.deepEqual(await api.queue.retry({ id: job.id }), { ok: true });
    assert.deepEqual(h.callsOf('Queue/retry')[0]!.args, { id: job.id });
    assert.deepEqual(await api.queue.discard({ id: job.id }), { ok: true });
    assert.deepEqual(h.callsOf('Queue/discard')[0]!.args, { id: job.id });
    assert.ok(!(await api.queue.list({})).list.some(item => item.id === job.id));
  });
});

test('a settings refusal surfaces the engine error as a ContractError, unchanged', async () => {
  await withHarness(async h => {
    const { api } = h.layer;
    const refused = (p: Promise<unknown>, type: string, message?: string) =>
      assert.rejects(p, (error: unknown) => {
        assert.ok(error instanceof ContractError, 'a plain call surfaces the ContractError');
        assert.equal(error.type, type);
        if (message) assert.equal(error.message, message);
        return true;
      });

    await refused(api.listener.get('x' as never), 'validation');
    await refused(api.listener.set({ enabled: 'yes' } as never), 'validation');
    await refused(api.clients.list('x' as never), 'validation');
    await refused(api.clients.grant({ name: 'x', kind: 'cli', scopes: [] }), 'validation');
    await refused(
      api.clients.revoke({ id: 'no-such-tool' }),
      'notFound',
      'This tool is no longer allowed.',
    );
    await refused(api.clients.audit({ limit: 0 }), 'validation');
    await refused(api.queue.list({ kinds: ['nope'] } as never), 'validation');
    await refused(api.queue.retry({ id: 'no-such-item' }), 'notFound');
    await refused(api.queue.discard({ id: 'no-such-item' }), 'notFound');
    await refused(api.ai.providers('x' as never), 'validation');
    await refused(api.ai.models({ provider: 'nope' } as never), 'validation');
    await refused(api.ai.usage('x' as never), 'validation');
    await refused(api.ai.testKey({ provider: 'nope' } as never), 'validation');
    await refused(
      api.ai.removeKey({ provider: 'groq' }),
      'unsupported',
      'This key comes from the backend environment. Remove it there.',
    );
    await refused(api.account.lease({ accountId: 'no-such-account', pin: true }), 'notFound');
    await refused(api.account.discover({ address: 'not-an-email' } as never), 'validation');

    // A refused command surfaces the same body inside OperationFailedError.
    await assert.rejects(
      api.account.disconnect({ accountId: 'no-such-account' }),
      (error: unknown) =>
        error instanceof OperationFailedError &&
        typeof error.opId === 'string' &&
        error.error.type === 'notFound',
    );
    assert.equal(h.layer.operations.all().length, 1, 'only the refused disconnect was recorded');
    assert.equal(h.layer.undoStack.peek(), null, 'no plain call reaches the undo stack');
  });
});

test('a provider key reaches the engine once and the layer retains none of it', async () => {
  await withHarness(async h => {
    const { api, operations, undoStack } = h.layer;
    const key = 'sk-fixture-9f3a-secret';
    h.clearCalls();

    const saved = await api.ai.setKey({ provider: 'openai', key });
    assert.equal(saved.keySource, 'keychain');
    assert.deepEqual(
      h.callsOf('Ai/setKey')[0]!.args,
      { provider: 'openai', key },
      'the input went to the client unchanged, key and all',
    );

    const kept = () => JSON.stringify({ operations: operations.all(), undo: undoStack.peek() });
    assert.equal(operations.all().length, 0, 'a key call is not an operation');
    assert.equal(undoStack.peek(), null, 'a key call is not on the undo stack');
    assert.ok(!kept().includes(key), 'the layer keeps none of the key');
    assert.ok(
      !(await api.ai.providers()).list.some(p => JSON.stringify(p).includes(key)),
      'the providers table never carries the key',
    );

    // A refused secret call surfaces the engine's error only — the key is in neither the error nor the layer.
    await assert.rejects(api.ai.setKey({ provider: 'nope' as never, key }), (error: unknown) => {
      assert.ok(error instanceof ContractError);
      assert.ok(!JSON.stringify(error).includes(key), 'the error body has none of the key');
      assert.ok(!String(error).includes(key), 'the error message has none of the key');
      return true;
    });
    assert.equal(operations.all().length, 0);
    assert.equal(undoStack.peek(), null);
    assert.ok(!kept().includes(key));
  });
});
