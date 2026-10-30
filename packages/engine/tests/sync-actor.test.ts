import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlanInput, PlannedStep, StepResult, SyncLane } from '../src/ports';
import type { StorePort } from '../src/store';
import { opPayload } from '../src/sync/ops';
import {
  ACCOUNT,
  FakeAdapter,
  MINUTE,
  T0,
  accountRow,
  deferred,
  disk,
  fact,
  governed,
  messagesIn,
  settle,
  stateOf,
  until,
  world,
  type StepFn,
} from './sync-actor-helpers';

// The account actor and its host with a fake adapter and the real store (plan 20 PV2; prov-gov-T33, T34, T36).

const step = (
  scope: PlannedStep['scope'],
  lane: SyncLane,
  origin: PlannedStep['origin'],
  trigger: PlannedStep['trigger'],
  notBefore?: number,
): PlannedStep => ({
  scope,
  lane,
  origin,
  trigger,
  ...(notBefore !== undefined ? { notBefore } : {}),
});
const stateIn = (input: PlanInput, scope: string) => input.states.find(s => s.scope === scope);

/** Enqueues a provider op as `Thread/act` would: the local effect and the op row in one local commit. */
function enqueueArchive(store: StorePort, opId: string, remoteId: string) {
  store.commit({
    opId: `local-${opId}`,
    origin: 'local',
    writes: [
      {
        kind: 'op',
        opId,
        accountId: ACCOUNT,
        opKind: 'archive',
        targets: [`${ACCOUNT}:${remoteId}`],
        payload: opPayload(remoteId, { kind: 'folders', add: [], remove: ['INBOX'] }),
        effect: [{ kind: 'placements', target: { remoteId }, add: [], remove: ['INBOX'] }],
        scope: 'mail.write',
      },
    ],
  });
}

const openOps = (store: StorePort) =>
  store.read(q =>
    q.all<{ op_id: string; state: string; last_error: string | null; next_at: number | null }>(
      'SELECT op_id, state, last_error, next_at FROM ops ORDER BY seq',
    ),
  );

test('lane order: op flush first, then incremental, then backfill, then enrichment', async () => {
  const d = disk();
  const done =
    (_scope: string): StepFn =>
    async (s, _state, ctx) => {
      await governed(ctx, s, 5);
      return {
        nextStates: [{ scope: s.scope, generation: ctx.generation, updatedAt: 0, phase: 'done' }],
        done: true,
        costUnits: 5,
      };
    };
  const adapter = new FakeAdapter(
    input =>
      (['enrichment', 'backfill', 'incremental'] as const)
        .filter(lane => stateIn(input, `provider:${lane}`)?.phase !== 'done')
        .map(lane =>
          step(
            `provider:${lane}`,
            lane,
            lane === 'incremental' ? 'incremental' : 'backfill',
            input.trigger,
          ),
        ),
    {
      'provider:enrichment': done('e'),
      'provider:backfill': done('b'),
      'provider:incremental': done('i'),
    },
  );
  const w = world(d, () => adapter);
  try {
    w.store.commit({
      opId: 'seed',
      origin: 'sync',
      writes: [
        {
          kind: 'message',
          accountId: ACCOUNT,
          remoteId: 'm1',
          remoteThreadId: 't1',
          to: [],
          cc: [],
          date: T0,
          internalDate: T0,
          flags: { seen: false, flagged: false, draft: false, fromMe: false },
          folders: [{ folder: 'INBOX' }],
        },
      ],
    });
    enqueueArchive(w.store, 'op-1', 'm1');
    await w.host.start(ACCOUNT);
    await until(() => adapter.calls.length === 4, 'four calls');
    assert.deepEqual(adapter.calls, [
      'apply:op-1',
      'provider:incremental:',
      'provider:backfill:',
      'provider:enrichment:',
    ]);
    assert.deepEqual(openOps(w.store), [], 'the applied op is settled and gone');
  } finally {
    await w.kill();
    d.cleanup();
  }
});

/** A paged Inbox window: 5 pages of 2 messages, each page committing its token; page `hang` never answers. */
function pagedWindow(hang?: number, seen?: (page: number) => void): FakeAdapter {
  return new FakeAdapter(
    input => {
      const window = stateIn(input, 'window:inbox');
      return window?.phase === 'done'
        ? []
        : [step('window:inbox', 'incremental', 'baseline', input.trigger)];
    },
    {
      'window:inbox': async (s, state, ctx) => {
        const page = Number(state.pageToken ?? 0);
        seen?.(page);
        if (page === hang) await new Promise(() => {});
        await governed(ctx, s, 25);
        const last = page === 4;
        const result: StepResult = {
          upserts: [fact(`p${page}a`, page * 2), fact(`p${page}b`, page * 2 + 1)],
          nextStates: [
            {
              scope: 'window:inbox',
              generation: page === 0 ? ctx.generation : state.generation,
              updatedAt: 0,
              ...(last ? { phase: 'done' } : { pageToken: String(page + 1) }),
            },
          ],
          done: true,
          baselineReached: page === 0,
          progress: { read: 2, total: 10 },
          costUnits: 25,
        };
        return result;
      },
    },
  );
}

test('prov-gov-T33 each page commits with its resume token; a kill between steps resumes at the last committed page', async () => {
  const d = disk();
  const first = pagedWindow(3);
  const a = world(d, () => first);
  try {
    await a.host.start(ACCOUNT);
    await until(() => first.calls.includes('window:inbox:3'), 'page 3 to start');
    assert.equal(stateOf(a.store, 'window:inbox')?.page_token, '3');
    assert.equal(messagesIn(a.store, 'INBOX').length, 6);
    assert.ok(accountRow(a.store).baseline_done_at, 'the first page set baseline_done_at (AM-4)');
  } finally {
    await a.kill();
  }
  // Restart on the same database: the first request is page 3; no committed page is fetched again.
  const second = pagedWindow();
  const b = world(d, () => second, { clock: a.clock });
  try {
    await b.host.start(ACCOUNT);
    await until(() => stateOf(b.store, 'window:inbox')?.phase === 'done', 'the window to finish');
    assert.deepEqual(second.calls, ['window:inbox:3', 'window:inbox:4']);
    assert.equal(messagesIn(b.store, 'INBOX').length, 10);
    assert.equal(b.host.status(ACCOUNT)?.status.state, 'ok');
  } finally {
    await b.kill();
    d.cleanup();
  }
});

test('prov-gov-T33 a commit that fails leaves neither the page nor its token, and the page is fetched again', async () => {
  const d = disk();
  const adapter = pagedWindow();
  const w = world(d, () => adapter);
  // The store fails once, inside the transaction of page 2's commit: the page's rows and token are applied first, then
  // a write the store refuses rolls the whole transaction back.
  const commit = w.store.commit.bind(w.store);
  let failed = false;
  w.store.commit = input => {
    if (!failed && input.writes.some(x => x.kind === 'syncState' && x.pageToken === '3')) {
      failed = true;
      return commit({ ...input, writes: [...input.writes, { kind: 'noSuchWrite' } as never] });
    }
    return commit(input);
  };
  try {
    await w.host.start(ACCOUNT);
    await until(() => failed, 'the failing commit');
    await settle();
    assert.equal(stateOf(w.store, 'window:inbox')?.page_token, '2', 'the token did not move');
    assert.deepEqual(
      messagesIn(w.store, 'INBOX'),
      ['p0a', 'p0b', 'p1a', 'p1b'],
      'and no row of the page landed',
    );
    await w.clock.advance(MINUTE);
    await until(() => stateOf(w.store, 'window:inbox')?.phase === 'done', 'the window to finish');
    assert.equal(
      adapter.calls.filter(c => c === 'window:inbox:2').length,
      2,
      'page 2 fetched again, once',
    );
    assert.equal(adapter.calls.filter(c => c === 'window:inbox:1').length, 1);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('the mutation fence keeps a local edit made while the page was in flight', async () => {
  const d = disk();
  const gate = deferred();
  const adapter = new FakeAdapter(
    input =>
      stateIn(input, 'window:inbox')?.phase === 'done'
        ? []
        : [step('window:inbox', 'incremental', 'baseline', input.trigger)],
    {
      'window:inbox': async (s, _state, ctx) => {
        await governed(ctx, s, 5);
        await gate.promise;
        // The provider's page predates the user's edit: both messages unread, both in the Inbox.
        return {
          upserts: [fact('edited', 1), fact('untouched', 2)],
          nextStates: [
            { scope: 'window:inbox', generation: ctx.generation, updatedAt: 0, phase: 'done' },
          ],
          done: true,
          costUnits: 5,
        };
      },
    },
  );
  const w = world(d, () => adapter);
  try {
    // Both messages already stored, read at the provider.
    w.store.commit({
      opId: 'seed',
      origin: 'sync',
      writes: [fact('edited', 1), fact('untouched', 2)].map(f => ({
        kind: 'message' as const,
        accountId: ACCOUNT,
        remoteId: f.remoteId,
        remoteThreadId: f.remoteThreadId,
        to: f.to,
        cc: f.cc,
        date: f.date,
        internalDate: f.internalDate,
        flags: { ...f.flags, seen: true },
        folders: [{ folder: 'INBOX' }],
      })),
    });
    await w.host.start(ACCOUNT);
    await until(() => adapter.calls.length === 1, 'the page request');
    // The user marks one unread and archives it while the page is in flight.
    w.store.commit({
      opId: 'user-edit',
      origin: 'local',
      writes: [
        {
          kind: 'flags',
          accountId: ACCOUNT,
          target: { remoteId: 'edited' },
          seen: false,
          flagged: true,
        },
        {
          kind: 'placements',
          accountId: ACCOUNT,
          target: { remoteId: 'edited' },
          add: [],
          remove: ['INBOX'],
        },
      ],
    });
    gate.resolve();
    await until(() => stateOf(w.store, 'window:inbox')?.phase === 'done', 'the page commit');
    const flags = (id: string) =>
      w.store.read(q =>
        q.get<{ flags: number }>('SELECT flags FROM messages WHERE remote_id = ?', id),
      )!.flags;
    assert.equal(flags('edited') & 2, 2, 'the local star is kept');
    assert.deepEqual(
      messagesIn(w.store, 'INBOX'),
      ['untouched'],
      'the local archive is kept; the other message takes provider truth',
    );
    assert.equal(
      flags('untouched') & 1,
      0,
      'provider truth (unread) for the message nobody edited',
    );
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('prov-gov-T34 a bounded sweep removes only stale placements inside the covered bound, in the step commit', async () => {
  const d = disk();
  const at = (minutes: number) => T0 + minutes * MINUTE;
  const gate = deferred();
  const script: { step: PlannedStep; run: StepFn }[] = [
    // Round 1 lists a, b, c (stamped with its generation).
    {
      step: step('window:inbox', 'incremental', 'baseline', 'first'),
      run: async (s, _st, ctx) => {
        await governed(ctx, s, 5);
        return {
          upserts: [fact('a', 10), fact('b', 28), fact('c', 30)],
          nextStates: [
            { scope: 'window:inbox', generation: ctx.generation, updatedAt: 0, phase: 'done' },
          ],
          done: true,
          costUnits: 5,
        };
      },
    },
    // History adds h with no stamp (NULL is never swept).
    {
      step: step('history', 'incremental', 'incremental', 'poll'),
      run: async (s, _st, ctx) => {
        await governed(ctx, s, 2);
        return {
          upserts: [fact('h', 29)],
          nextStates: [{ scope: 'history', cursor: 'h-1', generation: 0, updatedAt: 0 }],
          done: true,
          costUnits: 2,
        };
      },
    },
    // A partial resync round must never sweep.
    {
      step: step('window:inbox', 'incremental', 'resync', 'reset'),
      run: async (s, _st, ctx) => {
        await governed(ctx, s, 5);
        return {
          upserts: [fact('c', 30)],
          nextStates: [
            { scope: 'window:inbox', generation: ctx.generation, updatedAt: 0, pageToken: 'more' },
          ],
          done: false,
          scopeCovered: {
            scope: 'window:inbox',
            generation: ctx.generation,
            bound: { folder: 'INBOX', since: at(25) },
          },
          costUnits: 5,
        };
      },
    },
    // A resync round lists c and d, from 25 minutes on: b (stale, inside) goes; a (outside) and h (unstamped) stay.
    {
      step: step('window:inbox', 'incremental', 'resync', 'reset'),
      run: async (s, _st, ctx) => {
        await gate.promise;
        await governed(ctx, s, 5);
        return {
          upserts: [fact('d', 40)],
          placements: [{ remoteId: 'c', folder: 'INBOX', present: true }],
          nextStates: [
            { scope: 'window:inbox', generation: ctx.generation, updatedAt: 0, phase: 'done' },
          ],
          done: true,
          scopeCovered: {
            scope: 'window:inbox',
            generation: ctx.generation,
            bound: { folder: 'INBOX', since: at(25) },
          },
          costUnits: 5,
        };
      },
    },
  ];
  const adapter = new FakeAdapter(() => (script.length ? [script[0].step] : []), {});
  adapter.syncStep = async (s, state, ctx) => {
    adapter.calls.push(s.scope);
    return script.shift()!.run(s, state, ctx);
  };
  const w = world(d, () => adapter);
  try {
    await w.host.start(ACCOUNT);
    await until(() => adapter.calls.length === 4, 'the partial round and the start of the next');
    assert.deepEqual(
      messagesIn(w.store, 'INBOX'),
      ['a', 'b', 'c', 'h'],
      'a partial answer sweeps nothing',
    );
    gate.resolve();
    await until(() => script.length === 0, 'the covering round');
    await until(() => messagesIn(w.store, 'INBOX').includes('d'), 'its commit');
    assert.deepEqual(messagesIn(w.store, 'INBOX'), ['a', 'c', 'd', 'h']);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('cadence: the timer runs the next poll at its notBefore, a focused window polls faster, and a manual request runs at once', async () => {
  const d = disk();
  const adapter = new FakeAdapter(
    input => {
      const history = stateIn(input, 'history');
      const interval = input.env.focused ? 15_000 : 60_000;
      const immediate = input.trigger !== 'poll';
      return [
        step(
          'history',
          'incremental',
          'incremental',
          input.trigger,
          immediate || !history ? input.env.now : history.updatedAt + interval,
        ),
      ];
    },
    {
      history: async (s, _state, ctx) => {
        await governed(ctx, s, 2);
        return {
          nextStates: [{ scope: 'history', cursor: 'c', generation: 0, updatedAt: 0 }],
          done: true,
          costUnits: 2,
        };
      },
    },
  );
  const w = world(d, () => adapter);
  try {
    await w.host.start(ACCOUNT);
    await until(() => adapter.calls.length === 1, 'the first pass');
    await settle();
    await w.clock.advance(59_999);
    assert.equal(adapter.calls.length, 1);
    await w.clock.advance(1);
    await until(() => adapter.calls.length === 2, 'the 60 s poll');
    assert.equal(adapter.plans.at(-1)!.trigger, 'poll');
    w.env.focused = true;
    await w.clock.advance(60_000);
    await until(() => adapter.calls.length === 3, 'the next 60 s poll');
    await w.clock.advance(15_000);
    await until(() => adapter.calls.length === 4, 'a 15 s poll once focused');
    // Manual: no waiting for the cadence.
    assert.deepEqual(w.host.request(ACCOUNT, { manual: true }), { ok: true });
    await until(() => adapter.calls.length === 5, 'the manual pass');
    assert.ok(adapter.plans.some(p => p.trigger === 'manual'));
    // A wake interrupts the sleep too (jitter 0 with this random source).
    w.host.wake('focus');
    await until(() => adapter.calls.length === 6, 'the wake pass');
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('a non-poll pass runs each due scope once: an always-due history poll cannot starve a lower lane', async () => {
  // Gmail's plan makes `history` due at once under any non-poll trigger; before the fix the actor re-picked it on every
  // turn of a manual or resume pass and never reached the backfill-lane scope (found by the Gmail e2e suite).
  const d = disk();
  let backfillPages = 0;
  const adapter = new FakeAdapter(
    input => [
      step(
        'history',
        'incremental',
        'incremental',
        input.trigger,
        input.trigger === 'poll' ? input.env.now + MINUTE : undefined,
      ),
      ...(backfillPages < 3 ? [step('sent:recent', 'backfill', 'backfill', input.trigger)] : []),
    ],
    {
      history: async (s, _state, ctx) => {
        await governed(ctx, s, 2);
        return {
          nextStates: [{ scope: 'history', generation: ctx.generation, updatedAt: 0, cursor: 'c' }],
          done: true,
          costUnits: 2,
        };
      },
      'sent:recent': async (s, _state, ctx) => {
        await governed(ctx, s, 5);
        backfillPages++;
        return {
          nextStates: [
            { scope: 'sent:recent', generation: ctx.generation, updatedAt: 0, phase: 'running' },
          ],
          done: true,
          costUnits: 5,
        };
      },
    },
  );
  const w = world(d, () => adapter);
  try {
    w.governor.setRole(ACCOUNT, 'primary');
    w.host.leaseChanged(ACCOUNT, { role: 'primary' });
    await w.host.start(ACCOUNT);
    await until(() => backfillPages === 3, 'three Sent pages');
    const histories = adapter.calls.filter(c => c.startsWith('history:')).length;
    assert.ok(histories <= 2, `history ran ${histories} times before Sent finished`);
    assert.deepEqual(w.host.request(ACCOUNT, { manual: true }), { ok: true });
    await until(
      () => adapter.calls.filter(c => c.startsWith('history:')).length === histories + 1,
      'the manual pass',
    );
    await settle();
    assert.equal(
      adapter.calls.filter(c => c.startsWith('history:')).length,
      histories + 1,
      'a manual pass polls history once',
    );
  } finally {
    await w.kill();
    d.cleanup();
  }
});
