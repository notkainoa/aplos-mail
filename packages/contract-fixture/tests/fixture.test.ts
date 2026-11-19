import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkResult,
  ContractError,
  ErrorBodySchema,
  Frame,
  type EngineMethodName,
  type Input,
  type Output,
} from '@aplos/contract';
import { createFixtureEngine, scenarios, type Scenario } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';
import { SampleContext, samples } from '../../contract/tests/conformance/samples';

/**
 * The stand-in's own behaviour: its scenarios and control knobs. Contract-level behaviour (windows, holds, receipts,
 * undo) is the conformance suite's, which runs against this engine under `npm test -w @aplos/contract`.
 */

function start(scenario: Scenario = 'demo', seed?: number) {
  const engine = createFixtureEngine({ scenario, ...(seed === undefined ? {} : { seed }) });
  const session = engine.connect();
  const control = fixtureControl(session);
  const frames: Frame[] = [];
  const order: string[] = [];
  session.subscribe(f => {
    frames.push(f);
    order.push(`frame:${f.frame}`);
  });
  const call = async <M extends EngineMethodName>(
    method: M,
    args: Input<M>,
  ): Promise<Output<M>> => {
    const result = checkResult(method, await session.call(method, args));
    order.push(`reply:${method}`);
    return result;
  };
  return { engine, session, control, frames, order, call };
}
let n = 0;
const opId = () => `fx-test-${++n}`;
const fails = async (promise: Promise<unknown>, type: string) => {
  await assert.rejects(
    promise,
    (e: unknown) =>
      e instanceof ContractError && e.type === type && ErrorBodySchema.safeParse(e.body).success,
  );
};

test('the same seed gives the same engine', async () => {
  const a = start('demo', 7),
    b = start('demo', 7),
    c = start('demo', 8);
  const [sa, sb, sc] = await Promise.all([
    a.call('Session/get', {}),
    b.call('Session/get', {}),
    c.call('Session/get', {}),
  ]);
  assert.equal(sa.dbEpoch, sb.dbEpoch);
  assert.notEqual(sa.dbEpoch, sc.dbEpoch);
  assert.deepEqual(
    (await a.call('View/watch', { spec: { kind: 'home' } })).ids,
    (await b.call('View/watch', { spec: { kind: 'home' } })).ids,
  );
  assert.equal(sa.now, Date.UTC(2026, 9, 27, 16), 'a fixed APLOS_NOW-style clock by default');
});

test('every declared scenario starts, or says it arrives in Phase 1', async () => {
  for (const scenario of scenarios) {
    if (scenario === 'small-10k' || scenario === 'large-100k') {
      assert.throws(() => createFixtureEngine({ scenario }), /Phase 1/);
      continue;
    }
    const { call } = start(scenario);
    const s = await call('Session/get', {});
    assert.equal(s.hasAccounts, scenario !== 'empty', scenario);
    if (scenario === 'parked') {
      assert.equal(s.engine.state, 'parked');
      continue;
    }
    const accounts = (await call('Account/get', {})).list;
    const states = accounts.map(a => a.health.status.state);
    if (scenario === 'offline') assert.ok(states.every(st => st === 'offline'));
    if (scenario === 'needs-reauth') assert.ok(states.includes('needsReauth'));
    if (scenario === 'rate-limited') assert.ok(states.includes('paused'));
    if (scenario === 'backfilling') assert.ok(states.every(st => st === 'backfilling'));
    if (scenario === 'send-uncertain')
      assert.equal((await call('Outbox/pending', {})).uncertain, 1);
    if (scenario === 'ai-budget-spent') assert.ok((await call('Ai/usage', {})).pausedUntil);
    if (scenario === 'setup-partial') assert.equal((await call('Setup/status', {})).partial, true);
    if (scenario === 'partial-threads')
      assert.ok(
        (
          await call('Thread/get', {
            ids: (await call('View/query', { spec: { kind: 'mailbox', role: 'all' } })).ids,
          })
        ).list.some(t => t.partial),
      );
  }
});

test('on empty, every engine method answers schema-valid output or a typed error, never a crash', async () => {
  const { session, control, call } = start('empty');
  assert.equal((await call('Session/get', {})).hasAccounts, false);
  const ctx = new SampleContext(session, async ms => {
    await control.advanceClock({ ms });
  });
  for (const method of Object.keys(samples) as EngineMethodName[]) {
    let args: unknown;
    try {
      args = await (samples[method].args as (c: SampleContext) => unknown)(ctx);
    } catch {
      args = {};
    }
    try {
      checkResult(method, await session.call(method, args));
    } catch (error) {
      assert.ok(error instanceof ContractError, `${method}: ${String(error)}`);
      assert.ok(ErrorBodySchema.safeParse(error.body).success, method);
    }
  }
});

test('Account/connect on empty creates a practice account and first sync runs to ready', async () => {
  const { control, frames, call } = start('empty');
  const { connectId } = await call('Account/connect', {
    provider: 'google',
    loginHint: 'practice@fixture.example',
  });
  await control.advanceClock({ ms: 1_000 });
  const connected = frames.find(
    f => f.frame === 'connect' && f.connectId === connectId && f.state === 'connected',
  );
  assert.ok(connected && connected.frame === 'connect' && connected.accountId);
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const s = (await call('Setup/status', {})).accounts[0]!;
    seen.add(s.state);
    assert.equal(s.firstWindow.total, 50, 'the first-window target, never the mailbox size');
    if (s.state === 'ready') break;
    await control.advanceClock({ ms: 400 });
  }
  assert.ok(seen.has('reading') && seen.has('ready'), [...seen].join(', '));
  const account = (await call('Account/get', {})).list[0]!;
  assert.ok(
    account.baselineDoneAt && account.health.reconnectBy,
    'Google accounts carry the weekly reconnect',
  );
  assert.ok((await call('View/query', { spec: { kind: 'mailbox', role: 'inbox' } })).total > 0);
});

test('failNextWrite: the receipt comes back, then the operation fails and the row is put back', async () => {
  const { control, frames, call } = start();
  const thread = (await call('View/query', { spec: { kind: 'mailbox', role: 'inbox' } })).ids[0]!;
  await control.failNextWrite({ mode: 'afterReceipt', afterMs: 300 });
  const receipt = await call('Thread/act', {
    opId: opId(),
    ids: [thread],
    action: { type: 'done' },
  });
  assert.equal(
    (await call('Thread/get', { ids: [thread] })).list[0]!.workflow.status,
    'done',
    'optimistic until the provider answers',
  );
  await control.advanceClock({ ms: 400 });
  const op = frames.find(f => f.frame === 'operation' && f.operation.opId === receipt.opId);
  assert.ok(
    op &&
      op.frame === 'operation' &&
      op.operation.state === 'failed' &&
      op.operation.error?.type === 'providerError',
  );
  assert.equal((await call('Thread/get', { ids: [thread] })).list[0]!.workflow.status, 'new');
  await control.failNextWrite({
    mode: 'reject',
    type: 'paused',
    message: 'Gmail asked us to slow down.',
  });
  await fails(
    call('Thread/act', { opId: opId(), ids: [thread], action: { type: 'done' } }),
    'paused',
  );
});

test('a queued write counts in pendingChanges until it syncs', async () => {
  const { control, call } = start();
  const thread = (
    await call('Thread/get', {
      ids: [(await call('View/query', { spec: { kind: 'mailbox', role: 'inbox' } })).ids[0]!],
    })
  ).list[0]!;
  const pending = async () =>
    (await call('Account/get', { ids: [thread.accountId] })).list[0]!.pendingChanges;
  assert.equal(await pending(), 0);
  const act = opId();
  await call('Thread/act', { opId: act, ids: [thread.id], action: { type: 'flag', on: true } });
  assert.equal(await pending(), 1);
  await call('Operation/undo', { opId: act, undoOpId: opId() });
  assert.equal(await pending(), 0, 'undo while queued cancels the provider write');
  await call('Thread/act', { opId: opId(), ids: [thread.id], action: { type: 'flag', on: true } });
  await control.advanceClock({ ms: 700 });
  assert.equal(await pending(), 0);
});

test('a Later item comes back at its time, at the bottom of Do now', async () => {
  const { control, call } = start();
  const now = (await call('Session/get', {})).now;
  const home = await call('View/watch', { spec: { kind: 'home' } });
  const thread = home.ids[0]!;
  await call('Thread/act', {
    opId: opId(),
    ids: [thread],
    action: { type: 'later', until: now + 3_600_000 },
  });
  await control.advanceClock({ ms: 300 });
  assert.ok(!(await call('View/query', { spec: { kind: 'home' } })).ids.includes(thread));
  await control.advanceClock({ ms: 3_600_000 });
  const row = (await call('Thread/get', { ids: [thread] })).list[0]!;
  assert.equal(row.fromLater, true);
  const back = await call('View/query', { spec: { kind: 'home' } });
  const section = back.sections.find(s => s.key === 'fromLater')!;
  assert.ok(back.ids.slice(section.start, section.start + section.count).includes(thread));
  assert.ok((await call('Counts/get', {})).all.laterDue >= 1);
  await call('Thread/act', { opId: opId(), ids: [thread], action: { type: 'done' } });
  assert.equal(
    (await call('Thread/get', { ids: [thread] })).list[0]!.fromLater,
    false,
    'acting on it moves it on',
  );
  assert.ok((await call('Counts/get', {})).all.handledToday >= 1);
});

test('Thread/act on a selector takes the section the owner saw, not mail that arrived later', async () => {
  const { control, call } = start();
  const home = await call('View/query', { spec: { kind: 'home' } });
  const update = home.sections.find(s => s.key === 'update')!;
  const seen = home.ids.slice(update.start, update.start + update.count);
  const account = (await call('Account/get', {})).list[0]!.id;
  const { threadId } = await control.deliverMail({
    accountId: account,
    fromName: 'Late Sender',
    from: 'late@fixture.example',
    subject: 'Arrived later',
    body: 'Hello.',
    lane: 'update',
  });
  await call('Thread/act', {
    opId: opId(),
    selector: { spec: { kind: 'home' }, section: 'update', atState: home.state },
    action: { type: 'done' },
  });
  const rows = (await call('Thread/get', { ids: [...seen, threadId] })).list;
  assert.ok(rows.filter(r => seen.includes(r.id)).every(r => r.workflow.status === 'done'));
  assert.equal(rows.find(r => r.id === threadId)!.workflow.status, 'new');
  await fails(
    call('Thread/act', {
      opId: opId(),
      selector: { spec: { kind: 'drafts' }, atState: home.state },
      action: { type: 'done' },
    }),
    'unsupported',
  );
});

test('a send can be forced uncertain, and a submission into any state', async () => {
  const { control, call } = start();
  const draft = (await call('View/query', { spec: { kind: 'drafts' } })).ids[0]!;
  const d = (await call('Draft/get', { ids: [draft] })).list[0]!;
  await control.nextSendOutcome({ outcome: 'uncertain' });
  const { submission } = await call('Submission/set', {
    opId: opId(),
    action: { type: 'send', draftId: d.id, revision: d.revision },
  });
  assert.ok(submission.queuedAt <= submission.notBefore);
  await control.advanceClock({ ms: 10_000 });
  assert.equal(
    (await call('Submission/get', { ids: [submission.id] })).list[0]!.state,
    'uncertain',
  );
  await control.setSubmissionState({
    submissionId: submission.id,
    state: 'suspended',
    problem: { reasonCode: 'unknown', message: 'This was due while your Mac was off.' },
  });
  const s = (await call('Submission/get', { ids: [submission.id] })).list[0]!;
  assert.equal(s.state, 'suspended');
  assert.equal(s.problem?.message, 'This was due while your Mac was off.');
});

test('setOrdering puts frames before, after or with the reply', async () => {
  for (const [mode, first] of [
    ['frameFirst', 'frame'],
    ['receiptFirst', 'reply'],
    ['together', 'frame'],
  ] as const) {
    const { control, order, call } = start();
    const win = await call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } });
    await control.advanceClock({ ms: 1_000 });
    await control.setOrdering({ ordering: { mode } });
    order.length = 0;
    await call('Thread/act', { opId: opId(), ids: [win.ids[0]!], action: { type: 'trash' } });
    await control.advanceClock({ ms: 300 });
    assert.ok(order.includes('frame:window'), mode);
    assert.equal(order[0]!.split(':')[0], first, `${mode}: ${order.join(', ')}`);
  }
});

test('the control channel parks the engine and forces account states; desktop methods are refused', async () => {
  const { session, control, frames, call } = start();
  const account = (await call('Account/get', {})).list[0]!.id;
  await control.pauseAccount({ accountId: account, forMs: 60_000 });
  const sync = (await call('Sync/request', { accountId: account })).accounts[0]!;
  assert.equal(sync.accepted, false);
  assert.ok(sync.resumeAt);
  await control.advanceClock({ ms: 60_000 });
  assert.equal((await call('Account/get', { ids: [account] })).list[0]!.health.status.state, 'ok');
  await control.setAccountStatus({
    accountId: account,
    status: { state: 'needsReauth', reason: 'invalid_grant' },
    reasonCode: 'auth.expired',
  });
  assert.equal(
    (await call('Account/get', { ids: [account] })).list[0]!.health.status.state,
    'needsReauth',
  );
  await control.park({ reasonCode: 'diskFull', message: 'Your disk is full.' });
  assert.ok(frames.some(f => f.frame === 'host' && f.event.type === 'parked' && f.event.at > 0));
  await fails(call('Thread/get', { ids: ['x'] }), 'unavailable');
  assert.equal((await call('Session/get', {})).engine.state, 'parked');
  await control.unpark();
  await fails(session.call('Window/openOnboarding', {}), 'unsupported');
  await fails(session.call('Fixture/nope', {}), 'unsupported');
});

test('Thread/why for every Do now thread with a to-do reads as asked-something and never says "waiting on you"', async () => {
  const { call } = start('demo');
  const home = await call('View/watch', { spec: { kind: 'home' } });
  const sentences: string[] = [];
  for (const id of home.ids) {
    const why = await call('Thread/why', { threadId: id });
    if (why.lane === 'do' && why.rankSource !== 'user' && why.rankSource !== 'rule')
      sentences.push(why.sentence);
    assert.doesNotMatch(why.sentence, /waiting on you/i, 'DESIGN section 10 bans the phrase');
  }
  assert.ok(
    sentences.some(sentence => / asked you something: /.test(sentence)),
    'the demo shows a Do now Why with its to-do',
  );
});
