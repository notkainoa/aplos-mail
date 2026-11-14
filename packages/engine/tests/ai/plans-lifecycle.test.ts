import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { type AiChatRequest, type AiTransport } from '../../src/ai/host';
import '../../src/ai/impl/ai-writes';
import { extractThread, writePlans, type Extracted } from '../../src/ai/impl/plans';
import { accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { manualClock, silentDeadlines } from '../runtime.helpers';

/**
 * Confirm/extract lifecycle pins: claim replay after a refused put, a mid-flight dismiss, the
 * write-level claim/release/settle guards, the writePlans stale-input fence, and the per-hash
 * "nothing found" record. Each test fails if the guard it names is removed.
 */
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
    // The queue's own deadline never fires on its own here: tests drive it with explicit `runJobs` calls.
    ports: { deadlines: silentDeadlines(), ...(ports ?? {}) } as never,
  });
  engine.services.ai.useTransport(transport);
  const window = engine.connect();
  const call = <M extends EngineMethodName>(m: M, a: Input<M>) =>
    window.call(m, a) as Promise<Output<M>>;
  return { store, engine, call, clock, file };
}

const EVENT_ANSWER =
  '{"events":[{"title":"Garden day","start":"2026-11-14T10:00:00Z","end":"2026-11-14T11:00:00Z","allDay":false,"location":"Community garden","quote":"this Saturday at 10 am"}]}';

const seed = (w: Awaited<ReturnType<typeof world>>) =>
  w.store.commit({
    opId: 'seed',
    origin: 'sync',
    writes: [
      { ...accountWrite, aiAllowed: true },
      ...folderWrites.map(f => ({ ...f })),
      msg('m1', 'T-plans', 5, {
        subject: 'Garden day',
        snippet: 'We are gathering this Saturday at 10 am.',
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

test('Plan/confirm: a refused put retried under the SAME opId confirms — one event, row confirmed', async () => {
  const puts: { newRemoteId?: string }[] = [];
  let refused = true;
  const w = await world(stubTransport(EVENT_ANSWER), {
    calendar: {
      put: async (_a: string, c: { newRemoteId?: string }) => {
        puts.push(c);
        if (refused) {
          refused = false;
          throw new ContractError({ type: 'permission', message: 'Enable editing first.' });
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
    ] as never[],
  });
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  await assert.rejects(
    () => w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id }),
    (e: unknown) => (e as { type?: string }).type === 'permission',
  );
  // The refusal released the claim; the SAME opId must be able to claim again — its claim commit
  // carries a unique suffix so the retry is not replayed away as a duplicate op.
  const done = await w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id });
  assert.equal(puts.length, 2);
  const row = w.store.read(q =>
    q.get<{ state: string; op_id: string | null; event_id: string | null }>(
      'SELECT state, op_id, event_id FROM plans WHERE id = 1',
    ),
  )!;
  assert.equal(row.state, 'confirmed', 'the retried confirm settles, not a silent open row');
  assert.equal(row.op_id, 'c1');
  const replay = await w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id });
  assert.equal(replay.eventId, done.eventId);
  assert.equal(puts.length, 2, 'the confirmed row replays without a provider call');
  await assert.rejects(
    () => w.call('Plan/confirm', { opId: 'c9', id: out.plans[0].id }),
    (e: unknown) => (e as { type?: string }).type === 'conflict',
    'a new opId cannot confirm over the settled plan',
  );
  w.file.cleanup();
});

test('Plan/confirm: two refused puts under the same opId release the claim every time', async () => {
  let refuse = true;
  const w = await world(stubTransport(EVENT_ANSWER), {
    calendar: {
      put: async (_a: string, c: { newRemoteId?: string }) => {
        if (refuse)
          throw new ContractError({ type: 'permission', message: 'Enable editing first.' });
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
  const row = () =>
    w.store.read(q =>
      q.get<{ state: string; op_id: string | null }>('SELECT state, op_id FROM plans WHERE id = 1'),
    )!;
  for (const attempt of [1, 2]) {
    await assert.rejects(
      () => w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id }),
      (e: unknown) => (e as { type?: string }).type === 'permission',
    );
    // The release commit carries a unique suffix: a replayed `c1:release` would leave the second
    // refusal's claim stuck `confirming` forever.
    assert.equal(row().state, 'open', `refusal ${attempt} hands the plan back`);
    assert.equal(row().op_id, null);
  }
  refuse = false;
  const done = await w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id });
  assert.match(done.eventId, /^acct-1:primary\//, 'a later retry under the same op still confirms');
  w.file.cleanup();
});

test('Plan/confirm: a dismiss that lands while the put is in flight refuses the confirm', async () => {
  const puts: { newRemoteId?: string }[] = [];
  const removes: { remoteId?: string }[] = [];
  const w = await world(stubTransport(EVENT_ANSWER), {
    calendar: {
      put: async (_a: string, c: { newRemoteId?: string }) => {
        puts.push(c);
        await w.call('Plan/dismiss', { opId: 'd-mid', ids: ['acct-1:plan-1'] });
        return { kind: 'saved' as const, upserts: [{ remoteId: c.newRemoteId }], removals: [] };
      },
      remove: async (_a: string, ref: { remoteId?: string }) => {
        removes.push(ref);
        return { kind: 'saved' as const, upserts: [], removals: [{ remoteId: ref.remoteId }] };
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
  await assert.rejects(
    () => w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id }),
    (e: unknown) => (e as { type?: string }).type === 'conflict',
    'a settle that cannot land must not answer ok',
  );
  const row = w.store.read(q => q.get<{ state: string }>('SELECT state FROM plans WHERE id = 1'))!;
  assert.equal(row.state, 'dismissed', 'the mid-flight dismiss stands');
  assert.equal(removes.length, 1, 'the orphaned event is deleted — no plan can ever point at it');
  assert.equal(removes[0].remoteId, puts[0].newRemoteId, 'the event the put created is removed');
  w.file.cleanup();
});

test('plan claim/settle writes: the open-state lock holds and only the claiming op may release', () => {
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
  const row = () =>
    store.read(q =>
      q.get<{ state: string; op_id: string | null; event_id: string | null }>(
        'SELECT state, op_id, event_id FROM plans WHERE id = 1',
      ),
    )!;
  const claim = (opId: string, commitOp: string) =>
    store.commit({
      opId: commitOp,
      origin: 'local',
      writes: [
        {
          kind: 'plan',
          action: 'claim',
          id: 1,
          accountId: 'acct-1',
          opId,
          calendarId: 'acct-1:primary',
        } as never,
      ],
    });
  claim('opA', 'c-a');
  assert.equal(row().state, 'confirming');
  assert.equal(row().op_id, 'opA');
  // The AND state='open' lock: a second claim on the claimed row throws conflict.
  assert.throws(
    () => claim('opB', 'c-b'),
    (e: unknown) => (e as { type?: string }).type === 'conflict',
  );
  // Only the claiming op may release it.
  store.commit({
    opId: 'r-b',
    origin: 'local',
    writes: [
      {
        kind: 'plan',
        action: 'release',
        id: 1,
        accountId: 'acct-1',
        opId: 'opB',
      } as never,
    ],
  });
  assert.equal(row().state, 'confirming', 'another op cannot release the claim');
  assert.equal(row().op_id, 'opA');
  // A confirmed settle on a confirming row needs its event id and lands; but on an OPEN row it no-ops.
  store.commit({
    opId: 'r-a',
    origin: 'local',
    writes: [{ kind: 'plan', action: 'release', id: 1, accountId: 'acct-1', opId: 'opA' } as never],
  });
  assert.equal(row().state, 'open');
  assert.equal(row().op_id, null);
  store.commit({
    opId: 's-open',
    origin: 'local',
    writes: [
      {
        kind: 'plan',
        action: 'settle',
        id: 1,
        accountId: 'acct-1',
        state: 'confirmed',
        eventId: 'acct-1:primary/ev',
      } as never,
    ],
  });
  assert.equal(row().state, 'open', 'a confirmed settle cannot bypass the claim');
  assert.equal(row().event_id, null);
  file.cleanup();
});

test('writePlans: mail that moved between extract and write drops the stale set entirely', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  const x = await extractThread(w.engine.services, 'acct-1', 'T-plans', 'UTC');
  assert.notEqual(x, 'empty');
  // The thread changed while the model answered — the input hash no longer matches.
  w.store.commit({
    opId: 'm2',
    origin: 'sync',
    writes: [
      msg('m2', 'T-plans', 6, { subject: 'Re: Garden day', snippet: 'and bring tools Sunday' }),
    ],
  });
  const list = writePlans(w.engine.services, 'acct-1', 'T-plans', x as Extracted);
  assert.equal(list.length, 0, 'nothing is written under a stale input hash');
  assert.equal(
    w.store.read(q => q.all<{ id: number }>('SELECT id FROM plans')).length,
    0,
    'no plan rows landed',
  );
  w.file.cleanup();
});

test('Event/extract: open plans from older mail do not stop the nothing-found record', async () => {
  const t = stubTransport([EVENT_ANSWER, '{"events":[]}']);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  const first = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  assert.equal(first.plans.length, 1);
  // New mail moves the input hash; the open proposal from the older input stays listed.
  w.store.commit({
    opId: 'm2',
    origin: 'sync',
    writes: [
      msg('m2', 'T-plans', 6, { subject: 'Re: Garden day', snippet: 'and bring tools Sunday' }),
    ],
  });
  const second = await w.call('Event/extract', { opId: 'x2', threadId: 'acct-1:T-plans' });
  assert.equal(t.calls.length, 2, 'the new input was extracted once');
  assert.equal(second.plans.length, 1, 'the older open plan is still returned');
  // The marker is per input hash — a third extract must NOT call the model even though the thread's
  // open plan list was never empty. Its answer mirrors the extract that recorded the marker: the
  // thread's open proposals, so the marker hit is the same list the second call returned.
  const third = await w.call('Event/extract', { opId: 'x3', threadId: 'acct-1:T-plans' });
  assert.equal(third.plans.length, 1, 'a recorded empty answer still returns the open plans');
  assert.equal(third.plans[0].id, second.plans[0].id);
  assert.equal(t.calls.length, 2, 'the recorded empty answer for THIS hash skips the model');
  w.file.cleanup();
});

test('Event/extract: a date-filter empty with an older open plan answers the same list every call', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  const first = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  assert.equal(first.plans.length, 1);
  // The dated message disappears; an undated reply remains — the date filter keeps this off the model.
  w.store.commit({
    opId: 'm2',
    origin: 'sync',
    writes: [
      { kind: 'messageDelete', accountId: 'acct-1', remoteId: 'm1' } as never,
      msg('m2', 'T-plans', 6, { subject: 'Re: plans', snippet: 'sounds good, see you there' }),
    ],
  });
  const second = await w.call('Event/extract', { opId: 'x2', threadId: 'acct-1:T-plans' });
  assert.equal(second.plans.length, 1, 'the filter-empty path answers like the write path did');
  assert.equal(second.plans[0].id, first.plans[0].id);
  assert.equal(t.calls.length, 1, 'undated mail never reaches the model');
  const third = await w.call('Event/extract', { opId: 'x3', threadId: 'acct-1:T-plans' });
  assert.deepEqual(
    third.plans.map(p => p.id),
    second.plans.map(p => p.id),
    'a marker replay returns the same answer — identical mail, identical list',
  );
  assert.equal(t.calls.length, 1);
  w.file.cleanup();
});

test('Plan/confirm: a row still confirming keeps the event for its same-opId retry (no sweep)', async () => {
  const removes: { remoteId?: string }[] = [];
  const w = await world(stubTransport(EVENT_ANSWER), {
    calendar: {
      put: async (_a: string, c: { newRemoteId?: string }) => ({
        kind: 'saved' as const,
        upserts: [{ remoteId: c.newRemoteId, inserted: true }],
        removals: [],
      }),
      remove: async (_a: string, ref: { remoteId?: string }) => {
        removes.push(ref);
        return { kind: 'saved' as const, upserts: [], removals: [] };
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
  // The settle commit's opId IS the caller's opId: a commit already recorded under 'c1' replays the
  // settle away, leaving the row `confirming` — its event must stay for the retry to settle.
  w.store.commit({
    opId: 'c1',
    origin: 'local',
    writes: [{ kind: 'meta', key: 'some-key', value: 'v' } as never],
  });
  await assert.rejects(
    () => w.call('Plan/confirm', { opId: 'c1', id: out.plans[0].id }),
    (e: unknown) => (e as { type?: string }).type === 'conflict',
  );
  const row = w.store.read(q =>
    q.get<{ state: string; op_id: string | null }>('SELECT state, op_id FROM plans WHERE id = 1'),
  )!;
  assert.equal(row.state, 'confirming', 'the claim stands for a retry');
  assert.equal(removes.length, 0, 'a still-confirming row is never swept');
  w.file.cleanup();
});

test('Plan/confirm: a shared opId cannot collide with an Event/set id; a read-back is never swept', async () => {
  const puts: { newRemoteId?: string }[] = [];
  const removes: { remoteId?: string; etag?: string }[] = [];
  const w = await world(stubTransport(EVENT_ANSWER), {
    calendar: {
      put: async (_a: string, c: { newRemoteId?: string }) => {
        puts.push(c);
        // The second put (the confirm's) is dismissed mid-flight and answers as a 409 read-back of
        // the namespaced id — only `inserted: false` says it was NOT this call's insert.
        if (puts.length === 2) {
          await w.call('Plan/dismiss', { opId: 'd-mid', ids: ['acct-1:plan-1'] });
          return {
            kind: 'saved' as const,
            upserts: [{ remoteId: c.newRemoteId, inserted: false, etag: 'e-foreign' }],
            removals: [],
          };
        }
        return { kind: 'saved' as const, upserts: [{ remoteId: c.newRemoteId }], removals: [] };
      },
      remove: async (_a: string, ref: { remoteId?: string; etag?: string }) => {
        removes.push(ref);
        return { kind: 'saved' as const, upserts: [], removals: [] };
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
  // An Event/set under opId 'op-1' names its event from the bare op; a Plan/confirm under the same
  // opId must name a DIFFERENT remote id (the `plan:` prefix), or a sweep could hit the owner's event.
  await w.call('Event/set', {
    opId: 'op-1',
    change: {
      type: 'create',
      calendarId: 'acct-1:primary',
      fields: {
        title: 'Owner event',
        start: { type: 'utc', utc: 1_800_000_000_000 },
        end: { type: 'utc', utc: 1_800_003_600_000 },
        allDay: false,
      },
    },
  });
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  await assert.rejects(
    () => w.call('Plan/confirm', { opId: 'op-1', id: out.plans[0].id }),
    (e: unknown) => (e as { type?: string }).type === 'conflict',
    'the mid-flight dismiss still refuses the confirm',
  );
  const { eventIdForOp } = await import('../../src/calendar/event-id');
  assert.equal(
    puts[0].newRemoteId,
    await eventIdForOp('acct-1', 'op-1'),
    'Event/set names the event from the bare opId',
  );
  assert.equal(
    puts[1].newRemoteId,
    await eventIdForOp('acct-1', 'plan:op-1'),
    'Plan/confirm names its event in its own id space',
  );
  assert.equal(removes.length, 0, 'a provider read-back of a pre-existing event is never swept');
  w.file.cleanup();
});

// Opus's end-to-end probe: an Event/set and a Plan/confirm that share an opId, a mid-flight dismiss,
// and a provider-style 409 read-back. On the un-namespaced id this deleted the owner's event.
test('PROBE: Plan/confirm reusing an Event/set opId + mid-flight dismiss must not delete the owner event', async () => {
  const events = new Map<string, string>();
  const removed: string[] = [];
  let dismissDuringPlanPut = false;
  const w = await world(stubTransport(EVENT_ANSWER), {
    calendar: {
      put: async (_a: string, c: { newRemoteId?: string; fields?: { title?: string } }) => {
        const id = c.newRemoteId!;
        if (dismissDuringPlanPut)
          await w.call('Plan/dismiss', { opId: 'd-mid', ids: ['acct-1:plan-1'] });
        // Google 409 → the adapter reads back the existing event and answers saved.
        if (!events.has(id)) events.set(id, c.fields?.title ?? '?');
        return { kind: 'saved' as const, upserts: [{ remoteId: id, etag: 'e1' }], removals: [] };
      },
      remove: async (_a: string, ref: { remoteId?: string }) => {
        removed.push(ref.remoteId!);
        events.delete(ref.remoteId!);
        return {
          kind: 'saved' as const,
          upserts: [],
          removals: [{ remoteId: ref.remoteId! }],
        };
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
  await w.call('Event/set', {
    opId: 'X',
    change: {
      type: 'create',
      calendarId: 'acct-1:primary',
      fields: {
        title: 'Owner event',
        start: { type: 'utc', utc: 1_800_000_000_000 },
        end: { type: 'utc', utc: 1_800_003_600_000 },
        allDay: false,
      },
    },
  } as never);
  assert.equal(events.size, 1);
  const ownerId = [...events.keys()][0];
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  dismissDuringPlanPut = true;
  await assert.rejects(() => w.call('Plan/confirm', { opId: 'X', id: out.plans[0].id }));
  assert.ok(events.has(ownerId), `owner event E must survive; removed=${JSON.stringify(removed)}`);
  assert.equal(removed.length, 1, 'the orphaned plan event is still swept');
  assert.notEqual(removed[0], ownerId, 'the sweep names only the plan-namespaced event');
  w.file.cleanup();
});
