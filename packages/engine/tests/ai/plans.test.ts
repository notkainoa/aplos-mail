import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { type AiChatRequest, type AiTransport } from '../../src/ai/host';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { manualClock } from '../runtime.helpers';

function stubTransport(answer: string): AiTransport & { calls: AiChatRequest[] } {
  const calls: AiChatRequest[] = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      return { content: answer, toolCalls: [], usage: { prompt: 10, completion: 10 } };
    },
    transcribe: () => Promise.resolve({ text: '' }),
    models: () => Promise.resolve({ list: [], live: false }),
    check: () => Promise.resolve(),
    setKey: () => Promise.resolve('keychain' as const),
    removeKey: () => Promise.resolve('none' as const),
    keySource: () => 'env' as const,
  };
}

async function world(transport: AiTransport, ports?: { calendar: unknown }) {
  const file = tempDb();
  const clock = manualClock();
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  const log = createLogger({ sink: { write: () => undefined }, salt: 's', clock });
  const engine = await createEngine({
    store,
    clock,
    log,
    host: {
      appVersion: '9.9.9',
      device: { id: 'd', name: 'd' },
      resident: true,
      capabilities: { desktop: true },
    },
    ...(ports ? { ports: ports as never } : {}),
  });
  engine.services.ai.useTransport(transport);
  const window = engine.connect();
  const call = <M extends EngineMethodName>(m: M, a: Input<M>) =>
    window.call(m, a) as Promise<Output<M>>;
  return { store, engine, call, clock, file };
}

const EVENT_ANSWER =
  '{"events":[{"title":"Garden day","start":"2026-11-14T10:00:00Z","end":"2026-11-14T11:00:00Z","allDay":false,"location":"Community garden","quote":"this Saturday at 10 am"}]}';

const seed = (w: Awaited<ReturnType<typeof world>>, spam = false) =>
  w.store.commit({
    opId: 'seed',
    origin: 'sync',
    writes: [
      { ...accountWrite, aiAllowed: true },
      ...folderWrites.map(f => ({ ...f })),
      ...(spam
        ? [
            {
              kind: 'folder' as const,
              accountId: ACCOUNT,
              remoteId: 'SPAM',
              name: 'Spam',
              role: 'spam' as const,
              folderKind: 'system' as const,
            },
          ]
        : []),
      msg('m1', 'T-plans', 5, {
        subject: 'Garden day',
        snippet: 'We are gathering this Saturday at 10 am.',
        ...(spam ? { folders: [{ folder: 'INBOX' }, { folder: 'SPAM' }] } : {}),
      }),
    ],
  });

const consentNow = async (w: Awaited<ReturnType<typeof world>>) => {
  await w.call('Settings/set', { opId: 'bg', patch: { ai: { background: true } } });
  const got = await w.call('Consent/get', {});
  return w.call('Consent/grant', {
    scope: 'background',
    version: got.currentVersion ?? got.version,
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
  });
};

test('Event/extract: gated mail becomes open plans; a second call returns them (no new call)', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  assert.equal(out.plans.length, 1);
  assert.equal(out.plans[0].title, 'Garden day');
  assert.equal(out.plans[0].state, 'open');
  assert.equal(t.calls.length, 1, 'one metered provider call');
  const again = await w.call('Event/extract', { opId: 'x2', threadId: 'acct-1:T-plans' });
  assert.equal(again.plans.length, 1);
  assert.equal(t.calls.length, 1, 'existing open plans win without a second call');
  // Plan/get and Plan/dismiss round-trip the row.
  const got = await w.call('Plan/get', { ids: [out.plans[0].id] });
  assert.equal(got.list.length, 1);
  await w.call('Plan/dismiss', { opId: 'd1', ids: [out.plans[0].id] });
  const gone = await w.call('Plan/get', { ids: [out.plans[0].id] });
  assert.equal(gone.list[0].state, 'dismissed');
  w.file.cleanup();
});

test('Event/extract: no consent and a Spam thread mean no provider call', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w, true);
  await assert.rejects(
    () => w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' }),
    (e: unknown) => (e as { type?: string }).type === 'forbidden',
  );
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x2', threadId: 'acct-1:T-plans' });
  assert.equal(out.plans.length, 0, 'Spam mail is never read for the model');
  assert.equal(t.calls.length, 0);
  w.file.cleanup();
});

test('the plans window lists open proposals; a foreign-account wire id cannot dismiss; confirm refuses settled plans', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  assert.equal(out.plans.length, 1);
  const win = await w.call('View/watch', { spec: { kind: 'plans' } });
  assert.deepEqual(win.ids, ['acct-1:plan-1'], 'the open plan appears in the plans window');
  // A wire id with another account's prefix never settles this row.
  await w.call('Plan/dismiss', { opId: 'd1', ids: ['acct-2:plan-1'] });
  const still = await w.call('Plan/get', { ids: ['acct-1:plan-1'] });
  assert.equal(still.list[0].state, 'open');
  // The real dismiss works, and confirming a settled plan is a conflict — no provider call.
  await w.call('Plan/dismiss', { opId: 'd2', ids: ['acct-1:plan-1'] });
  await assert.rejects(
    () => w.call('Plan/confirm', { opId: 'c1', id: 'acct-1:plan-1' }),
    (e: unknown) => (e as { type?: string }).type === 'conflict',
  );
  const win2 = await w.call('View/watch', { spec: { kind: 'plans' } });
  assert.deepEqual(win2.ids, [], 'dismissed plans leave the window');
  w.file.cleanup();
});

test('Plan/confirm: put lands once, a repeated opId replays the stored eventId, bad dates never reach the table', async () => {
  const puts: Array<{ remoteId?: string }> = [];
  const calendar = {
    put: async (_account: string, req: { remoteId?: string }) => {
      assert.equal(req.remoteId, undefined, 'a create carries no remoteId (it is not a PATCH)');
      puts.push(req);
      return { kind: 'saved' as const, upserts: [{ remoteId: 'ev-1' }], removals: [] };
    },
  };
  const t = stubTransport(
    JSON.stringify({
      events: [
        {
          title: 'Garden day',
          start: '2026-11-14T10:00:00Z',
          end: '2026-11-14T11:00:00Z',
          allDay: false,
        },
        { title: 'Zero day', start: '2026-11-14', end: '2026-11-14', allDay: true },
        { title: 'Bad date', start: '2026-13-45', end: '2026-13-46', allDay: true },
        { title: 'Fuzzy', start: 'Nov 14', end: 'Nov 14', allDay: false },
        {
          title: 'No zone',
          start: '2026-11-14T10:00:00',
          end: '2026-11-14T11:00:00',
          allDay: false,
        },
        {
          title: 'Ancient',
          start: '2001-03-04T10:00:00Z',
          end: '2001-03-04T11:00:00Z',
          allDay: false,
        },
      ],
    }),
  );
  const w = await world(t, { calendar });
  seed(w);
  w.store.commit({
    opId: 'cal',
    origin: 'sync',
    writes: [
      {
        kind: 'calendar',
        accountId: 'acct-1',
        remoteId: 'primary',
        name: 'Primary',
        hidden: false,
        readOnly: false,
        primary: true,
      },
    ],
  });
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  // Invalid dates are dropped at parse time; the zero-length all-day plan keeps start+1d.
  assert.equal(out.plans.length, 2);
  assert.equal(out.plans[0].title, 'Garden day');
  assert.equal(out.plans[1].title, 'Zero day');
  assert.deepEqual(out.plans[1].end, { type: 'date', date: '2026-11-15' });
  const confirmed = await w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id });
  assert.equal(puts.length, 1);
  assert.match(confirmed.eventId, /^acct-1:primary\/ev-1$/);
  const again = await w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id });
  // The replay answers from the stored row — no second provider call.
  assert.equal(again.eventId, confirmed.eventId);
  assert.equal(puts.length, 1);
  w.file.cleanup();
});

test('Event/extract: a dismissed proposal is not re-created on the next extract (no provider call)', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  await w.call('Plan/dismiss', { opId: 'd1', ids: [out.plans[0].id] });
  const again = await w.call('Event/extract', { opId: 'x2', threadId: 'acct-1:T-plans' });
  assert.equal(again.plans.length, 1);
  assert.equal(
    again.plans[0].state,
    'dismissed',
    'the stored dismissed plan is returned, not re-extracted',
  );
  assert.equal(t.calls.length, 1, 'the model ran once');
  w.file.cleanup();
});

test('Plan/confirm: a refused put releases the claim; a second opId can then confirm', async () => {
  const calls: Array<unknown> = [];
  const calendar = {
    put: async (_a: string, req: unknown) => {
      calls.push(req);
      if (calls.length === 1)
        throw new ContractError({ type: 'permission', message: 'Enable editing first.' });
      return { kind: 'saved' as const, upserts: [{ remoteId: 'ev-1' }], removals: [] };
    },
  };
  const w = await world(stubTransport(EVENT_ANSWER), { calendar });
  seed(w);
  w.store.commit({
    opId: 'cal',
    origin: 'sync',
    writes: [
      {
        kind: 'calendar',
        accountId: 'acct-1',
        remoteId: 'primary',
        name: 'Primary',
        hidden: false,
        readOnly: false,
        primary: true,
      },
    ],
  });
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  await assert.rejects(() => w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id }));
  // The refusal released the claim — a fresh opId proceeds instead of "being confirmed elsewhere".
  const again = await w.call('Plan/confirm', { opId: 'c2', id: out.plans[0].id });
  assert.equal(again.eventId, 'acct-1:primary/ev-1');
  w.file.cleanup();
});

test('Event/extract: concurrent calls share one provider call; the mail budget keeps the newest message', async () => {
  const calls: AiTransport extends { chat: (r: infer R) => unknown } ? Array<R> : never = [];
  const t: AiTransport & { calls: typeof calls } = {
    calls,
    async chat(req) {
      calls.push(req);
      return {
        content: EVENT_ANSWER,
        toolCalls: [],
        usage: { prompt: 10, completion: 10 },
      };
    },
    transcribe: () => Promise.resolve({ text: '' }),
    models: () => Promise.resolve({ list: [], live: false }),
    check: () => Promise.resolve(),
    setKey: () => Promise.resolve('keychain' as const),
    removeKey: () => Promise.resolve('none' as const),
    keySource: () => 'env' as const,
  };
  const w = await world(t);
  seed(w);
  // Second message pushes the thread over the 12k budget — the newest text must survive the cut.
  w.store.commit({
    opId: 'big',
    origin: 'sync',
    writes: [
      msg('m-big', 'T-plans', 9, { snippet: `this Saturday at 10 am ${'x'.repeat(12_100)}` }),
    ],
  });
  await consentNow(w);
  const [a, b] = await Promise.all([
    w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' }),
    w.call('Event/extract', { opId: 'x2', threadId: 'acct-1:T-plans' }),
  ]);
  assert.equal(t.calls.length, 1, 'two callers shared the in-flight extraction');
  assert.equal(a.plans.length, b.plans.length);
  const userMsg = t.calls[0].messages[t.calls[0].messages.length - 1].content!;
  assert.ok(userMsg.includes('Saturday'), 'the newest message is inside the budget, not cut');
  assert.ok(
    !userMsg.includes('We are gathering'),
    'the oldest message is what the budget dropped (newest-first fill)',
  );
  w.file.cleanup();
});

test('a plan settle write never accepts open, and never confirms without an eventId', () => {
  const file = tempDb();
  const clock = manualClock();
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  store.commit({
    opId: 'seed',
    origin: 'sync',
    writes: [
      { ...accountWrite, aiAllowed: true },
      ...folderWrites.map(f => ({ ...f })),
      msg('m1', 'T-p', 5),
      {
        kind: 'plan',
        action: 'put',
        accountId: 'acct-1',
        remoteThreadId: 'T-p',
        inputHash: 'h',
        title: 'x',
        startUtc: 1,
        endUtc: 2,
        allDay: false,
        model: 'm',
      } as never,
    ],
  });
  for (const w of [
    { kind: 'plan', action: 'settle', id: 1, accountId: 'acct-1', state: 'open' },
    { kind: 'plan', action: 'settle', id: 1, accountId: 'acct-1', state: 'confirmed' },
  ])
    assert.throws(() =>
      store.commit({ opId: `b${Math.random()}`, origin: 'local', writes: [w as never] }),
    );
  file.cleanup();
});

test('Plan/confirm: a second opId cannot take a claimed plan; thread delete purges replydraft/followup meta', async () => {
  const w = await world(stubTransport(EVENT_ANSWER), {
    calendar: {
      put: async () => ({ kind: 'saved' as const, upserts: [{ remoteId: 'ev-9' }], removals: [] }),
    },
  });
  seed(w);
  w.store.commit({
    opId: 'cal',
    origin: 'sync',
    writes: [
      {
        kind: 'calendar',
        accountId: 'acct-1',
        remoteId: 'primary',
        name: 'P',
        hidden: false,
        readOnly: false,
        primary: true,
      },
    ],
  });
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  const done = await w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id });
  await assert.rejects(
    () => w.call('Plan/confirm', { opId: 'c2', id: out.plans[0].id }),
    (e: unknown) => (e as { type?: string }).type === 'conflict',
  );
  assert.equal(done.eventId, 'acct-1:primary/ev-9');
  // meta purge on threadDelete
  w.store.commit({
    opId: 'm1',
    origin: 'local',
    writes: [
      { kind: 'meta', key: 'replydraft:acct-1:T-plans', value: 'x' } as never,
      { kind: 'meta', key: 'replydraft:acct-1:other', value: 'y' } as never,
    ],
  });
  w.store.commit({
    opId: 'td',
    origin: 'local',
    writes: [{ kind: 'threadDelete', accountId: 'acct-1', remoteThreadId: 'T-plans' } as never],
  });
  const keys = w.store.read(q => q.all<{ k: string }>('SELECT key AS k FROM meta').map(r => r.k));
  assert.ok(!keys.includes('replydraft:acct-1:T-plans'), 'the thread replydraft row is gone');
  assert.ok(keys.includes('replydraft:acct-1:other'), 'another thread row survives');
  w.file.cleanup();
});
