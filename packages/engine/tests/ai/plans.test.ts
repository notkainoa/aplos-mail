import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { type AiChatRequest, type AiTransport } from '../../src/ai/host';
import type { Caller } from '../../src/methods/types';
import '../../src/ai/impl/ai-writes';
import { extractThread, writePlans, type Extracted } from '../../src/ai/impl/plans';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { manualClock } from '../runtime.helpers';

function stubTransport(answer: string | string[]): AiTransport & { calls: AiChatRequest[] } {
  const calls: AiChatRequest[] = [];
  const queue = [...(Array.isArray(answer) ? answer : [answer])];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      return {
        content: queue.length > 1 ? queue.shift()! : (queue[0] ?? ''),
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
  assert.match(
    t.calls[0].messages[0].content!,
    /offset/i,
    'the system prompt asks the model for a UTC offset (or zone)',
  );
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
    put: async (_account: string, req: { remoteId?: string; newRemoteId?: string }) => {
      assert.equal(req.remoteId, undefined, 'a create carries no remoteId (it is not a PATCH)');
      assert.match(
        req.newRemoteId ?? '',
        /^[a-v0-9]{26}$/,
        'the create names the remote event through newRemoteId',
      );
      puts.push(req);
      return { kind: 'saved' as const, upserts: [{ remoteId: req.newRemoteId }], removals: [] };
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
        {
          title: 'Ancient',
          start: '2001-03-04T10:00:00Z',
          end: '2001-03-04T11:00:00Z',
          allDay: false,
        },
        {
          title: 'No zone',
          start: '2026-11-14T10:00:00',
          end: '2026-11-14T11:00:00',
          allDay: false,
        },
        { title: 'Bad date', start: '2026-13-45', end: '2026-13-46', allDay: true },
        { title: 'Fuzzy', start: 'Nov 14', end: 'Nov 14', allDay: false },
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
  const out = await w.call('Event/extract', {
    opId: 'x1',
    threadId: 'acct-1:T-plans',
    timeZone: 'Europe/Oslo',
  });
  // 'Ancient' (third of five the parser sees) is dropped by the window clamp, 'Bad date' and 'Fuzzy' by the
  // parser; 'No zone' lands because a bare local time reads in the owner's zone — Oslo is UTC+1 in November.
  assert.equal(out.plans.length, 3);
  assert.equal(out.plans[0].title, 'Garden day');
  assert.equal(out.plans[1].title, 'Zero day');
  assert.deepEqual(out.plans[1].end, { type: 'date', date: '2026-11-15' });
  assert.equal(out.plans[2].title, 'No zone');
  assert.deepEqual(out.plans[2].start, {
    type: 'utc',
    utc: Date.parse('2026-11-14T09:00:00Z'),
  });
  const confirmed = await w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id });
  assert.equal(puts.length, 1);
  assert.match(confirmed.eventId, /^acct-1:primary\/[a-v0-9]{26}$/);
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
      const r = req as { newRemoteId?: string };
      return { kind: 'saved' as const, upserts: [{ remoteId: r.newRemoteId }], removals: [] };
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
  assert.match(again.eventId, /^acct-1:primary\/[a-v0-9]{26}$/);
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
      put: async (_a: string, c: { newRemoteId?: string }) => ({
        kind: 'saved' as const,
        upserts: [{ remoteId: c.newRemoteId }],
        removals: [],
      }),
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
  assert.match(done.eventId, /^acct-1:primary\/[a-v0-9]{26}$/);
  // meta purge on threadDelete
  w.store.commit({
    opId: 'm1',
    origin: 'local',
    writes: [
      { kind: 'meta', key: 'replydraft:acct-1:T-plans', value: 'x' } as never,
      { kind: 'meta', key: 'plans-empty:acct-1:T-plans', value: 'h' } as never,
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
  assert.ok(!keys.includes('plans-empty:acct-1:T-plans'), 'the empty-extraction marker is gone');
  assert.ok(keys.includes('replydraft:acct-1:other'), 'another thread row survives');
  w.file.cleanup();
});

test('Plan/confirm: an uncertain put keeps the claim; any retry replays the stored op and calendar', async () => {
  const puts: { newRemoteId?: string; calendarRemoteId?: string }[] = [];
  let failOnce = true;
  const w = await world(stubTransport(EVENT_ANSWER), {
    calendar: {
      put: async (_a: string, c: { newRemoteId?: string; calendarRemoteId?: string }) => {
        puts.push(c);
        if (failOnce) {
          failOnce = false;
          throw new ContractError({ type: 'unavailable', message: 'the answer was lost' });
        }
        return { kind: 'saved' as const, upserts: [{ remoteId: c.newRemoteId }], removals: [] };
      },
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
      {
        kind: 'calendar',
        accountId: 'acct-1',
        remoteId: 'second',
        name: 'S',
        hidden: false,
        readOnly: false,
        primary: false,
      },
    ] as never[],
  });
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  await assert.rejects(
    () => w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id, calendarId: 'acct-1:primary' }),
    (e: unknown) => (e as { type?: string }).type === 'unavailable',
    'the uncertain put propagates and leaves the plan claimed',
  );
  // A NEW opId retrying a different calendar still replays the claimed remote id into the claimed calendar.
  const done = await w.call('Plan/confirm', {
    opId: 'c2',
    id: out.plans[0].id,
    calendarId: 'acct-1:second',
  });
  assert.equal(puts.length, 2);
  assert.equal(
    puts[1].newRemoteId,
    puts[0].newRemoteId,
    'a retry names the claimed remote event id',
  );
  assert.equal(puts[1].calendarRemoteId, 'primary', 'a changed calendarId cannot redirect a claim');
  assert.match(done.eventId, /^acct-1:primary\//);
  // The completing opId owns the confirmed row — its retry replays the stored event, no third put.
  const replay = await w.call('Plan/confirm', { opId: 'c2', id: out.plans[0].id });
  assert.equal(replay.eventId, done.eventId, 'the completing op replays the stored event');
  assert.equal(puts.length, 2, 'a replay never calls the provider');
  w.file.cleanup();
});

test('Plan/confirm: concurrent confirms create exactly one event', async () => {
  const puts: { newRemoteId?: string }[] = [];
  const w = await world(stubTransport(EVENT_ANSWER), {
    calendar: {
      put: async (_a: string, c: { newRemoteId?: string }) => {
        puts.push(c);
        return { kind: 'saved' as const, upserts: [{ remoteId: c.newRemoteId }], removals: [] };
      },
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
    ] as never[],
  });
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  const results = await Promise.allSettled([
    w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id }),
    w.call('Plan/confirm', { opId: 'c2', id: out.plans[0].id }),
  ]);
  const ids = results.flatMap(r => (r.status === 'fulfilled' ? [r.value.eventId] : []));
  assert.ok(ids.length >= 1, 'at least one confirm succeeds');
  // Whichever of the loser-cases happened (claim race conflict, or the same remote id replayed), the
  // claim lock plus the stable remote id mean exactly one event exists.
  assert.equal(new Set(ids).size, 1, 'every success names the same event');
  assert.equal(
    new Set(puts.map(p => p.newRemoteId)).size,
    1,
    'one remote event, however many puts',
  );
  w.file.cleanup();
});

test('Plan/dismiss settles a plan left confirming by an uncertain put', async () => {
  const w = await world(stubTransport(EVENT_ANSWER), {
    calendar: {
      put: async () => {
        throw new ContractError({ type: 'unavailable', message: 'the answer was lost' });
      },
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
    ] as never[],
  });
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  await assert.rejects(() => w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id }));
  await w.call('Plan/dismiss', { opId: 'd1', ids: [out.plans[0].id] });
  const got = await w.call('Plan/get', { ids: [out.plans[0].id] });
  assert.equal(got.list[0].state, 'dismissed', 'a confirming plan can be dismissed');
  await assert.rejects(
    () => w.call('Plan/confirm', { opId: 'c2', id: out.plans[0].id }),
    (e: unknown) => (e as { type?: string }).type === 'conflict',
    'a dismissed plan stays dismissed',
  );
  w.file.cleanup();
});

test('Event/extract: an empty answer is remembered per input — the model is not called again', async () => {
  const t = stubTransport('{"events":[]}');
  const w = await world(t);
  seed(w);
  await consentNow(w);
  const first = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  assert.equal(first.plans.length, 0);
  assert.equal(t.calls.length, 1);
  const again = await w.call('Event/extract', { opId: 'x2', threadId: 'acct-1:T-plans' });
  assert.equal(again.plans.length, 0);
  assert.equal(t.calls.length, 1, 'the recorded empty answer skips the model');
  // New mail is a new input — the marker no longer matches, so the model runs once more.
  w.store.commit({
    opId: 'm2',
    origin: 'sync',
    writes: [
      msg('m2', 'T-plans', 6, { subject: 'Re: Garden day', snippet: 'and bring tools Sunday' }),
    ],
  });
  await w.call('Event/extract', { opId: 'x3', threadId: 'acct-1:T-plans' });
  assert.equal(t.calls.length, 2, 'a changed input is extracted again');
  w.file.cleanup();
});

test('writePlans: a set committed for this hash first wins — a concurrent writer inserts nothing', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  const x = await extractThread(w.engine.services, 'acct-1', 'T-plans', 'UTC');
  assert.notEqual(x, 'empty');
  const a = writePlans(w.engine.services, 'acct-1', 'T-plans', x as Extracted);
  const b = writePlans(w.engine.services, 'acct-1', 'T-plans', x as Extracted);
  assert.deepEqual(b, a, 'the second writer returns the first set');
  const rows = w.store.read(q => q.all<{ id: number }>('SELECT id FROM plans'));
  assert.equal(rows.length, 1, 'one plan, not a duplicated set');
  w.file.cleanup();
});

test('Plan/confirm: title, description and location overrides each need the send scope', async () => {
  const w = await world(stubTransport(EVENT_ANSWER), {
    calendar: {
      put: async (_a: string, c: { newRemoteId?: string }) => ({
        kind: 'saved' as const,
        upserts: [{ remoteId: c.newRemoteId }],
        removals: [],
      }),
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
    ] as never[],
  });
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  const triage: Caller = { kind: 'window', scopes: ['read', 'triage', 'ai'] };
  const triageWin = w.engine.connect(triage);
  for (const fields of [
    { title: 'Renamed' },
    { description: 'Mail text as the event body' },
    { location: 'Somewhere else' },
  ])
    await assert.rejects(
      () => triageWin.call('Plan/confirm', { opId: `t-${fields}`, id: out.plans[0].id, fields }),
      (e: unknown) => (e as { type?: string }).type === 'forbidden',
      `a triage caller cannot override ${Object.keys(fields)}`,
    );
  // Without overrides the same caller confirms fine — the plan stays open until it does.
  const done = (await triageWin.call('Plan/confirm', {
    opId: 't-ok',
    id: out.plans[0].id,
  })) as Output<'Plan/confirm'>;
  assert.match(done.eventId, /^acct-1:primary\//);
  w.file.cleanup();
});

test('accountRemove purges the plan-side meta rows (replydraft, plans-empty)', () => {
  const file = tempDb();
  const clock = manualClock();
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  store.commit({
    opId: 'seed',
    origin: 'sync',
    writes: [
      { ...accountWrite, aiAllowed: true },
      ...folderWrites.map(f => ({ ...f })),
      msg('m1', 'T-plans', 5, { subject: 'Garden day', snippet: 'this Saturday at 10 am' }),
      {
        kind: 'plan',
        action: 'put',
        accountId: 'acct-1',
        remoteThreadId: 'T-plans',
        inputHash: 'h',
        title: 'x',
        startUtc: 1,
        endUtc: 2,
        allDay: false,
        model: 'm',
      } as never,
      { kind: 'meta', key: 'replydraft:acct-1:T-plans', value: 'x' } as never,
      { kind: 'meta', key: 'plans-empty:acct-1:T-plans', value: 'h' } as never,
      { kind: 'meta', key: 'replydraft:acct-2:other', value: 'y' } as never,
    ],
  });
  store.commit({
    opId: 'rm',
    origin: 'local',
    writes: [{ kind: 'accountRemove', accountId: 'acct-1' } as never],
  });
  const keys = store.read(q => q.all<{ k: string }>('SELECT key AS k FROM meta').map(r => r.k));
  assert.ok(!keys.includes('replydraft:acct-1:T-plans'), 'the account replydraft row is gone');
  assert.ok(!keys.includes('plans-empty:acct-1:T-plans'), 'the empty-extraction marker is gone');
  assert.ok(keys.includes('replydraft:acct-2:other'), 'another account row survives');
  assert.equal(store.read(q => q.all('SELECT id FROM plans')).length, 0, 'the plan rows cascade');
  file.cleanup();
});
