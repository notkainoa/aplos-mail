import test from 'node:test';
import assert from 'node:assert/strict';
import { checkResult, ContractError, isMethod, type Frame } from '@aplos/contract';
import { createClient } from '@aplos/contract/client';
import { engineMethods, listenerMethods } from '@aplos/contract/allowlists';
import openapi from '@aplos/contract/generated/openapi.json' with { type: 'json' };
import { createFixtureEngine, scenarios, type Scenario } from '../src/index';
import { fixtureControl } from '../src/control';

/** The stand-in's own behaviour: scenarios, the control channel and the orderings it promises. The shared contract assertions live in the conformance suite. */
function start(scenario: Scenario, seed?: number) {
  const engine = createFixtureEngine({ scenario, seed });
  const session = engine.connect();
  const frames: Frame[] = [];
  session.subscribe(f => frames.push(f));
  return { engine, session, frames, api: createClient(session).api, control: fixtureControl(session) };
}

test('every scenario builds and answers the handshake, except the generated ones still due in Phase 1', async () => {
  for (const scenario of scenarios) {
    if (scenario === 'small-10k' || scenario === 'large-100k') { assert.throws(() => createFixtureEngine({ scenario }), /Phase 1/); continue; }
    const { api } = start(scenario);
    checkResult('Session/get', await api.session.get());
    checkResult('Setup/status', await api.setup.status());
    if (scenario !== 'parked') checkResult('Account/get', await api.account.get());
  }
});

test('Fixture/control is not part of the contract', () => {
  assert.equal(isMethod('Fixture/control'), false);
  assert.ok(!(engineMethods as readonly string[]).includes('Fixture/control') && !(listenerMethods as readonly string[]).includes('Fixture/control'));
  assert.doesNotMatch(JSON.stringify(openapi), /Fixture/);
});

test('the same seed gives the same engine', async () => {
  const a = start('demo', 7), b = start('demo', 7), c = start('demo', 8);
  assert.deepEqual(await a.api.session.get(), await b.api.session.get());
  assert.deepEqual(await a.api.view.watch({ spec: { kind: 'home' } }), await b.api.view.watch({ spec: { kind: 'home' } }));
  assert.notEqual((await a.api.session.get()).dbEpoch, (await c.api.session.get()).dbEpoch);
});

test('empty starts with no accounts; a practice account connects and its first sync runs on the clock', async () => {
  const { api, control, frames } = start('empty');
  const session = await api.session.get();
  assert.equal(session.hasAccounts, false);
  assert.deepEqual(session.setup, {});
  const { connectId } = await api.account.connect({ provider: 'google', loginHint: 'me@practice.example' });
  await control.advanceClock({ ms: 1_000 });
  const connects = frames.filter(f => f.frame === 'connect' && f.connectId === connectId).map(f => f.frame === 'connect' && f.state);
  assert.deepEqual(connects, ['waiting', 'connected']);
  const [account] = (await api.account.get()).list;
  assert.equal(account!.address, 'me@practice.example');
  assert.ok(account!.health.reconnectBy! > session.now, 'Testing-mode accounts carry reconnectBy');
  let status = await api.setup.status();
  assert.equal(status.done, false);
  await control.advanceSetup({ steps: 10 });
  status = await api.setup.status();
  assert.equal(status.accounts[0]!.state, 'ready');
  assert.equal(status.accounts[0]!.firstWindow.total, 50, 'the first-window target, never the mailbox size');
  assert.equal(status.accounts[0]!.ai, undefined, 'no AI block without consent');
  assert.ok((await api.view.query({ spec: { kind: 'mailbox', role: 'inbox' } })).total > 0, 'the practice mailbox landed');
  // Demo on request, idempotent, beside the practice account.
  const first = await api.demo.load();
  const again = await api.demo.load();
  assert.deepEqual(again.accountIds, first.accountIds);
  assert.equal((await api.account.get()).list.length, 3);
  await api.demo.remove();
  assert.deepEqual((await api.account.get()).list.map(a => a.id), [account!.id], 'removing the demo never touches a real account');
});

test('setOrdering releases frames before, after or with the reply', async () => {
  const order = async (mode: 'receiptFirst' | 'frameFirst' | 'together') => {
    const { api, session, control } = start('demo');
    await control.setOrdering({ ordering: { mode } });
    const win = await api.view.watch({ spec: { kind: 'mailbox', role: 'inbox' } });
    const marks: string[] = [];
    session.subscribe(f => { if (f.frame === 'window') marks.push('frame'); });
    setTimeout(() => marks.push('task'), 0);
    await api.thread.act({ opId: `o-${mode}`, ids: [win.ids[0]!], action: { type: 'trash' } });
    marks.push('reply');
    await new Promise(r => setTimeout(r, 5));
    return marks.join(' ');
  };
  assert.equal(await order('receiptFirst'), 'reply task frame');
  assert.equal(await order('frameFirst'), 'frame task reply');
  assert.equal(await order('together'), 'frame reply task');
});

test('a failed write returns the row with the error, and Retry puts the change back', async () => {
  const { api, control, frames } = start('demo');
  const inbox = await api.view.watch({ spec: { kind: 'mailbox', role: 'inbox' } });
  const id = inbox.ids[0]!;
  await control.failNextWrite({ reasonCode: 'rate.minute' });
  await api.thread.act({ opId: 'o1', ids: [id], action: { type: 'trash' } });
  await control.advanceClock({ ms: 300 });
  assert.ok(!frames.filter(f => f.frame === 'window').at(-1)!.ids.includes(id), 'optimistically applied');
  await control.advanceClock({ ms: 600 });
  const failed = frames.find(f => f.frame === 'operation' && f.operation.state === 'failed');
  assert.ok(failed && failed.frame === 'operation' && failed.operation.error?.reasonCode === 'rate.minute');
  assert.ok(frames.filter(f => f.frame === 'window').at(-1)!.ids.includes(id), 'the row returned to its place');
  await api.operation.retry({ opId: 'o1' });
  await control.advanceClock({ ms: 1_000 });
  assert.equal((await api.operation.get({ opIds: ['o1'] })).list[0]!.state, 'synced');
  await control.failNextWrite({ mode: 'reject' });
  await assert.rejects(api.thread.act({ opId: 'o2', ids: [id], action: { type: 'done' } }), (e: unknown) => e instanceof ContractError && e.type === 'providerError');
});

test('sends move through the state machine on the clock, and an uncertain send is never replayed by itself', async () => {
  const { api, control } = start('demo');
  const [draftId] = (await api.view.query({ spec: { kind: 'drafts' } })).ids;
  const draft = (await api.draft.get({ ids: [draftId!] })).list[0]!;
  await control.nextSendOutcome({ outcome: 'uncertain' });
  const { submission } = await api.submission.set({ opId: 's1', action: { type: 'send', draftId: draft.id, revision: draft.revision } });
  assert.equal(submission.state, 'queued');
  await control.advanceClock({ ms: 8_000 + 500 });
  const uncertain = (await api.submission.get({ ids: [submission.id] })).list[0]!;
  assert.equal(uncertain.state, 'uncertain');
  assert.match(uncertain.problem!.message!, /could not confirm/);
  await control.advanceClock({ ms: 60_000 });
  assert.equal((await api.submission.get({ ids: [submission.id] })).list[0]!.state, 'uncertain');
  await api.submission.set({ opId: 's2', action: { type: 'sendAnyway', submissionId: submission.id } });
  await control.advanceClock({ ms: 1_000 });
  assert.equal((await api.submission.get({ ids: [submission.id] })).list[0]!.state, 'sent');
  assert.deepEqual((await api.draft.get({ ids: [draft.id] })).notFound, [draft.id], 'a sent draft is gone');
  assert.equal((await api.view.query({ spec: { kind: 'thread', threadId: draft.threadId! } })).total, 2, 'and the reply is in its thread');
});

test('Ask streams progress frames, then the answer lands with citations', async () => {
  const { api, control, frames } = start('demo');
  const { runId, conversationId } = await api.ask.run({ question: 'What did Jordan ask about the layout?' });
  await control.advanceClock({ ms: 1_000 });
  const progress = frames.filter(f => f.frame === 'progress' && f.runId === runId).map(f => f.frame === 'progress' && f.kind);
  assert.deepEqual(progress, ['step', 'step', 'text', 'text', 'done']);
  const turn = (await api.conversation.get({ ids: [conversationId] })).list[0]!.turns[0]!;
  assert.ok(turn.answer!.blocks.length > 0);
  const cite = turn.citations[0]!;
  assert.ok(cite.kind === 'message' && cite.n === 1 && cite.messageId && cite.quote.length > 0);
});

test('control knobs force statuses, pauses, parking and draft changes', async () => {
  const { api, control, frames } = start('demo');
  await control.pauseAccount({ accountId: 'demo-work', forMs: 60_000 });
  const refused = (await api.sync.request({ accountId: 'demo-work' })).accounts[0]!;
  assert.equal(refused.accepted, false);
  assert.equal(refused.reasonCode, 'rate.minute');
  await control.advanceClock({ ms: 60_000 });
  assert.equal((await api.account.get({ ids: ['demo-work'] })).list[0]!.health.status.state, 'ok', 'a pause resumes by itself');
  await control.setAccountStatus({ accountId: 'demo-personal', status: { state: 'needsReauth', reason: 'invalid_grant' }, reasonCode: 'auth.expired' });
  assert.equal((await api.account.get({ ids: ['demo-personal'] })).list[0]!.health.reasonCode, 'auth.expired');
  const [draftId] = (await api.view.query({ spec: { kind: 'drafts' } })).ids;
  await control.draftChanged({ draftId: draftId!, conflict: true });
  assert.ok(frames.some(f => f.frame === 'Draft/changed' && f.conflict));
  await control.park({ reasonCode: 'crashLoop', message: 'Aplos stopped after repeated crashes.' });
  await assert.rejects(api.thread.get({ ids: ['x'] }), (e: unknown) => e instanceof ContractError && e.type === 'unavailable');
  assert.equal((await api.session.get()).engine.state, 'parked');
  await control.unpark();
  const snap = await control.snapshot();
  assert.equal(snap.dbEpoch, (await api.session.get()).dbEpoch);
});
