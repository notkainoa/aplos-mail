// Tiny fakes of every F3 port, proving the types compose; the runtime checks pin the few rules the types carry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { errorClasses, type ClassifiedError } from '@aplos/contract';
import * as rules from '@aplos/contract/rules';
import {
  GOVERNOR_CLASS_POLICY,
  IMAGE_PROXY_LIMITS,
  NotSentError,
  OVERDUE_GRACE_MS,
  RECURRENCE_ID_FORMAT,
  sendsRemoteDraft,
  WAITING_SUBMISSION_STATES,
  PausedError,
  PROJECT,
  ProviderError,
  type AccountActorDeps,
  type AccountActorHost,
  type AccountRuntime,
  type AdapterAccount,
  type AdapterContext,
  type Admission,
  type BoundGovernor,
  type BudgetSpec,
  type CalendarAdapter,
  type CalendarPort,
  type Clock,
  type DeadlineRegistry,
  type DeadlineSource,
  type DraftSyncPort,
  type GovernedRequest,
  type GovernorPort,
  type ImageProxy,
  type KeyProvider,
  type KnownLookup,
  type LaneFor,
  type MailHtml,
  type MessageFacts,
  type ProviderAdapter,
  type ProviderFactory,
  type RequestIo,
  type RulesPort,
  type SendPort,
  type StepResult,
  type SyncState,
  type Timer,
  type TokenSource,
} from '../src/ports';
import type { Logger } from '../src/diag/log';
import type { StorePort } from '../src/store/port';

const log = {} as Logger;
const err = (
  cls: string,
  reason: string,
  extra: Partial<ClassifiedError> = {},
): ClassifiedError => ({ class: cls, provider: 'google', method: 'gmail.test', reason, ...extra });

/** A fake clock: timers fire when `advance` passes them. */
function fakeClock(start = 1_000_000): Clock & { advance(ms: number): void } {
  let now = start;
  const timers: { at: number; fire: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    sleep: ms =>
      new Promise(resolve => {
        timers.push({ at: now + ms, fire: resolve, live: true });
      }),
    timer(at, fire): Timer {
      const t = { at, fire, live: true };
      timers.push(t);
      return {
        cancel: () => {
          t.live = false;
        },
      };
    },
    advance(ms) {
      now += ms;
      for (const t of timers)
        if (t.live && t.at <= now) {
          t.live = false;
          t.fire();
        }
    },
  };
}

/** A governor whose budget is paused until `pausedUntil`: refuses before I/O, as the port requires. */
function pausedGovernor(clock: Clock, pausedUntil: number): GovernorPort {
  const admission = (): Admission =>
    clock.now() < pausedUntil
      ? { ok: false, cls: 'throttle', reason: 'rateLimitExceeded', until: pausedUntil }
      : { ok: true };
  return {
    async run<T>(account: string, req: GovernedRequest, fn: (io: RequestIo) => Promise<T>) {
      const a = admission();
      if (!a.ok) throw new PausedError(account, req.budget, a.cls, a.reason, a.until);
      return fn({ signal: req.signal ?? new AbortController().signal, accessToken: 'fake-token' });
    },
    observe() {},
    charge() {},
    admission,
    batchSize: () => 10,
    retryNow: admission,
    setRole() {},
    clear() {},
    snapshot: () => [],
    restore() {},
    onChange: () => () => {},
  };
}

const bind = (g: GovernorPort, account: string): BoundGovernor => ({
  run: (req, fn) => g.run(account, req, fn),
  observe: (b, e) => g.observe(account, b, e),
  charge: (b, n) => g.charge(account, b, n),
  batchSize: b => g.batchSize(account, b),
});

const capabilities = {
  labels: true,
  folders: false,
  drafts: true,
  serverSearch: true,
  calendar: true,
  filters: true,
  push: false,
  sendAs: true,
  unsubscribeHeaders: true,
  threading: 'native',
} as const;
const account: AdapterAccount = {
  id: 'acct-1',
  provider: 'google',
  address: 'owner@mail.example',
  grantedScopes: ['gmail.modify'],
  capabilities,
};

const lookup: KnownLookup = {
  knownThreads: async () => new Set(),
  knownMessages: async () => new Set(),
  trackedDraftIds: async () => new Set(),
  draftsByMessageId: async () => new Map(),
  threadMessages: async () => [],
  placements: async () => new Map(),
  folderUids: async () => [],
  eventEtags: async () => new Map(),
};

const message = (id: string): MessageFacts => ({
  remoteId: id,
  remoteThreadId: `t-${id}`,
  to: [{ address: 'owner@mail.example' }],
  cc: [],
  from: { address: 'sender@news.example' },
  date: 1,
  internalDate: 1,
  flags: { seen: false, flagged: false, draft: false, fromMe: false },
  placements: [{ folder: 'INBOX' }],
  list: { listUnsubscribe: '<https://news.example/u>' },
  partial: true,
});

/** A Gmail-like adapter: the first window fetches message metadata one id at a time through the governor. */
function gmailLike(): ProviderAdapter {
  return {
    kind: 'google',
    plan: ({ states, env }) =>
      states.length
        ? []
        : [
            {
              scope: 'window:inbox',
              lane: 'incremental',
              origin: 'baseline',
              trigger: 'first',
              notBefore: env.now,
            },
          ],
    async syncStep(step, state, ctx): Promise<StepResult> {
      const ids = state.pending ?? ['m1', 'm2', 'm3'];
      const upserts: MessageFacts[] = [];
      for (const [i, id] of ids.entries()) {
        try {
          upserts.push(
            await ctx.governor.run(
              {
                budget: 'gmail',
                lane: step.lane,
                kind: 'read',
                method: 'gmail.messages.get',
                cost: 20,
              },
              async () => message(id),
            ),
          );
        } catch (e) {
          if (!(e instanceof PausedError)) throw e;
          return {
            upserts,
            nextStates: [{ ...state, pending: ids.slice(i), updatedAt: ctx.clock.now() }],
            done: false,
            costUnits: upserts.length * 20,
          };
        }
      }
      return {
        upserts,
        done: true,
        baselineReached: true,
        costUnits: upserts.length * 20,
        nextStates: [
          { ...state, pending: undefined, phase: 'done', updatedAt: ctx.clock.now() },
          { scope: 'backfill:inbox', generation: state.generation, updatedAt: ctx.clock.now() },
        ],
        scopeCovered: {
          scope: step.scope,
          generation: state.generation,
          bound: { folder: 'INBOX', since: 0 },
        },
      };
    },
    openThread: async () => ({
      messages: [{ ...message('m1'), partial: false, body: { text: 'hello', cidMap: {} } }],
      costUnits: 120,
    }),
    fetchAttachment: async () =>
      (async function* () {
        yield new Uint8Array([1]);
      })(),
    coalesce: ops => [
      {
        opIds: ops.map(o => o.opId),
        method: 'gmail.messages.batchModify',
        cost: 50,
        body: ops.map(o => o.remoteId),
      },
    ],
    apply: async op => op.opIds.map(opId => ({ opId, result: 'applied' as const })),
    async send(sub, ctx) {
      if (sub.mime.length > 35_000_000) throw new NotSentError(err('permanent', 'tooLarge'));
      return ctx.governor.run(
        {
          budget: 'gmail',
          lane: 'interactive',
          kind: 'send',
          method: 'gmail.messages.send',
          cost: 100,
        },
        async () => ({ remoteMessageId: 'sent-1', acceptedAt: ctx.clock.now() }),
      );
    },
    findSent: async (_id, _since, ctx) => ({ kind: 'absent', checkedAt: ctx.clock.now() }),
    close: async () => {},
  };
}

const gmailBudget: BudgetSpec = {
  id: 'gmail',
  unit: 'units',
  windowMs: 60_000,
  ceiling: 6_000,
  target: { primary: 4_500, secondary: 1_500 },
  floor: 1_000,
  laneShare: { interactive: 1, opFlush: 1, incremental: 0.9, prefetch: 0.2, backfill: 0.75 },
  inFlight: 3,
  reservedInteractive: 1,
  batch: { start: 10, min: 1, max: 25, growBy: 5 },
};

const factory: ProviderFactory = {
  kind: 'google',
  connect: async () => ({
    identity: { subject: 'sub-1', address: 'owner@mail.example' },
    grantedScopes: ['gmail.modify'],
    capabilities,
    grant: { grantedAt: 0, refreshExpiresAt: 7 * 86_400_000 },
    credentialRef: 'vault:google:acct-1',
  }),
  budgets: () => [
    gmailBudget,
    {
      ...gmailBudget,
      id: 'gcal',
      unit: 'requests',
      ceiling: 600,
      target: { primary: 300, secondary: 300 },
      batch: undefined,
      inFlight: 2,
      reservedInteractive: 0,
    },
  ],
  open: () => gmailLike(),
};

const ctxFor = (clock: Clock, governor: GovernorPort): AdapterContext => ({
  account,
  governor: bind(governor, account.id),
  clock,
  log,
  signal: new AbortController().signal,
  lookup,
  memory: new Map(),
  generation: 0,
});

test('a governor that is paused refuses before any I/O', async () => {
  const clock = fakeClock();
  const governor = pausedGovernor(clock, clock.now() + 60_000);
  let called = false;
  await assert.rejects(
    governor.run(
      'acct-1',
      { budget: 'gmail', lane: 'backfill', kind: 'read', method: 'gmail.messages.list', cost: 5 },
      async () => {
        called = true;
      },
    ),
    (e: unknown) =>
      e instanceof PausedError && e.until === clock.now() + 60_000 && e.cls === 'throttle',
  );
  assert.equal(called, false);
  assert.deepEqual(governor.admission('acct-1', 'gmail', 'interactive', 'send'), {
    ok: false,
    cls: 'throttle',
    reason: 'rateLimitExceeded',
    until: clock.now() + 60_000,
  });
});

test('a paused step returns partial facts with the rest pending, and resumes from them', async () => {
  const clock = fakeClock();
  // The first request is admitted, then a refusal elsewhere on the budget pauses it.
  let calls = 0;
  const governor = pausedGovernor(clock, Infinity);
  const g: GovernorPort = {
    ...governor,
    run: (a, req, fn) =>
      calls++ < 1 ? fn({ signal: new AbortController().signal }) : governor.run(a, req, fn),
  };
  const adapter = factory.open(account);
  const [step] = adapter.plan({
    account,
    states: [],
    trigger: 'first',
    env: { now: clock.now(), focused: true, windowVisible: true, onBattery: false },
    memory: new Map(),
  });
  const state: SyncState = { scope: step.scope, generation: 1, updatedAt: 0 };
  const partial = await adapter.syncStep(step, state, ctxFor(clock, g));
  assert.equal(partial.done, false);
  assert.equal(partial.scopeCovered, undefined, 'a partial answer never licenses a sweep');
  assert.deepEqual(
    partial.upserts?.map(m => m.remoteId),
    ['m1'],
  );
  assert.deepEqual(partial.nextStates[0].pending, ['m2', 'm3']);
  const rest = await adapter.syncStep(
    step,
    partial.nextStates[0],
    ctxFor(clock, pausedGovernor(clock, 0)),
  );
  assert.deepEqual(
    rest.upserts?.map(m => m.remoteId),
    ['m2', 'm3'],
  );
  assert.equal(rest.done, true);
  assert.deepEqual(
    rest.nextStates.map(s => s.scope),
    ['window:inbox', 'backfill:inbox'],
  );
});

/** How `eng-time` reads a send outcome: the rule `SendPort` documents. */
function outboxState(error: unknown): 'failed' | 'queued' | 'uncertain' {
  if (error instanceof PausedError) return error.cls === 'send_limit' ? 'failed' : 'queued';
  if (error instanceof NotSentError) return 'failed';
  return 'uncertain';
}

test('only proof of not-sent fails or requeues a submission; everything else is uncertain', async () => {
  const clock = fakeClock();
  const adapter = gmailLike();
  const sub = {
    submissionId: 's1',
    internetId: '<s1@mail.example>',
    mime: new Uint8Array(10),
    envelope: { from: 'owner@mail.example', rcpt: ['friend@mail.example'] },
  };
  const outcome = (governor: GovernorPort) =>
    adapter.send(sub, ctxFor(clock, governor)).then(() => 'sent', outboxState);
  assert.equal(await outcome(pausedGovernor(clock, 0)), 'sent');
  assert.equal(await outcome(pausedGovernor(clock, Infinity)), 'queued');
  const sendLimited: GovernorPort = {
    ...pausedGovernor(clock, 0),
    run: async (a, req) => {
      throw new PausedError(
        a,
        req.budget,
        'send_limit',
        'dailySendingLimit',
        clock.now() + 3_600_000,
      );
    },
  };
  assert.equal(await outcome(sendLimited), 'failed');
  const timedOut: GovernorPort = {
    ...pausedGovernor(clock, 0),
    run: async () => {
      throw new ProviderError(err('transient', 'timeout', { uncertain: true }));
    },
  };
  assert.equal(await outcome(timedOut), 'uncertain');
  assert.equal(
    await adapter
      .send({ ...sub, mime: new Uint8Array(36_000_000) }, ctxFor(clock, pausedGovernor(clock, 0)))
      .then(() => 'sent', outboxState),
    'failed',
  );
});

test('deadline sources compose with one timer on the injected clock', async () => {
  const clock = fakeClock();
  const sources = new Map<string, DeadlineSource>();
  const fired: string[] = [];
  let timer: Timer | undefined;
  const registry: DeadlineRegistry = {
    register(source) {
      sources.set(source.id, source);
      void this.changed(source.id);
      return () => {
        sources.delete(source.id);
      };
    },
    changed() {
      void Promise.all([...sources.values()].map(async s => ({ s, at: await s.next() }))).then(
        all => {
          timer?.cancel();
          const due = all.filter(x => x.at !== undefined).sort((a, b) => a.at! - b.at!)[0];
          if (due)
            timer = clock.timer(
              due.at!,
              () => void due.s.fire(clock.now()).then(() => this.changed(due.s.id)),
            );
        },
      );
    },
  };
  let reminderAt: number | undefined = clock.now() + 5_000;
  registry.register({
    id: 'reminders',
    next: async () => reminderAt,
    fire: async now => {
      fired.push(`reminder late ${now - reminderAt!} ms`);
      reminderAt = undefined;
    },
  });
  await new Promise(r => setImmediate(r));
  clock.advance(6_000);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(fired, ['reminder late 1000 ms']);
});

test('the remaining ports accept small fakes', async () => {
  const keys: KeyProvider = {
    dataKey: async () => ({ kind: 'unavailable', reason: 'keychainLocked' }),
  };
  const html: MailHtml = {
    version: 'fake-1',
    render: input => ({
      bodyKind: 'text',
      text: input.text ?? '',
      remoteImages: [],
      hasRemoteImages: false,
      trackersRemoved: 0,
      quotedCount: 0,
      marks: 0,
    }),
  };
  const laneFor: LaneFor = ({ message, knownCorrespondent }) =>
    message.list.listUnsubscribe || message.roles.includes('category.promotions')
      ? { lane: 'low', importance: 'normal' }
      : { lane: 'do', importance: knownCorrespondent ? 'important' : 'normal' };
  const calendar: CalendarAdapter = {
    budget: 'gcal',
    plan: () => [],
    listCalendars: async (_s, ctx) => ({
      calendars: [],
      removed: [],
      nextState: { scope: 'calendars', generation: 0, updatedAt: ctx.clock.now() },
      costUnits: 1,
    }),
    syncStep: async (id, state) => ({
      upserts: [],
      removals: [],
      nextState: { ...state, scope: `cal:${id}` },
      done: true,
      costUnits: 1,
    }),
    put: async () => ({ kind: 'conflict' }),
    remove: async () => ({ kind: 'saved', upserts: [], removals: [] }),
    rsvp: async () => ({ kind: 'saved', upserts: [], removals: [] }),
  };
  const tokens: TokenSource = {
    cached: () => undefined,
    refresh: async (_a, io) => ({ token: io.signal.aborted ? '' : 'fresh', expiresAt: 0 }),
  };
  const send: SendPort = {
    admission: () => ({ ok: true }),
    send: async () => ({ acceptedAt: 0 }),
    findSent: async () => ({ kind: 'found', remoteMessageId: 'x' }),
  };
  const drafts: DraftSyncPort = {
    save: async (_a, d) => ({
      kind: 'saved',
      remoteDraftId: 'r1',
      remoteMessageId: 'rm1',
      revision: d.revision,
    }),
    remove: async () => {},
  };
  const runtime: AccountRuntime = {
    status: { state: 'ok' },
    reconnectBy: 7 * 86_400_000,
    grantedScopes: [],
    capabilities,
    firstWindow: { read: 50, total: 50 },
    baselineDoneAt: 1,
  };
  const host: AccountActorHost = {
    connect: async (_a, _k, req) =>
      factory.connect(req, {
        accountId: 'acct-1',
        governor: bind(pausedGovernor(fakeClock(), 0), 'acct-1'),
        clock: fakeClock(),
        log,
        signal: new AbortController().signal,
      }),
    start: async () => {},
    stop: async () => {},
    reconnected: async () => {},
    request: () => ({ ok: true }),
    requestAll: () => ({}),
    wake() {},
    opsChanged() {},
    claimLease: async () => {},
    releaseLease: async () => {},
    status: () => runtime,
    lastHeartbeat: () => 0,
    subscribe: () => () => {},
    openThread: async () => ({ messages: [], costUnits: 0 }),
    search: async () => ({ remoteThreadIds: [] }),
    attachment: async () => (async function* () {})(),
  };
  const deps: AccountActorDeps = {
    store: {} as StorePort,
    governor: pausedGovernor(fakeClock(), 0),
    providers: [factory],
    tokens,
    clock: fakeClock(),
    log,
    deadlines: { register: () => () => {}, changed() {} },
    deviceId: 'mac-1',
    env: () => ({ now: 0, focused: false, windowVisible: false, onBattery: true }),
  };
  assert.deepEqual(await keys.dataKey(), { kind: 'unavailable', reason: 'keychainLocked' });
  assert.equal(html.render({ text: 'hi', cids: [], imagePolicy: 'block' }).bodyKind, 'text');
  assert.equal(
    laneFor({
      message: { ...message('m'), roles: [] },
      self: [],
      knownCorrespondent: false,
      userReplied: false,
      userEndedThread: false,
    }).lane,
    'low',
  );
  assert.equal(
    (
      await calendar.put(
        {
          calendarRemoteId: 'primary',
          remoteId: 'e1',
          scope: 'occurrence',
          fields: { summary: 'x' },
        },
        ctxFor(fakeClock(), deps.governor),
      )
    ).kind,
    'conflict',
  );
  assert.equal(
    (
      await host.connect('acct-1', 'google', {
        mode: 'reconnect',
        loginHint: 'owner@mail.example',
        expectedSubject: 'sub-1',
      })
    ).identity.subject,
    'sub-1',
  );
  assert.equal(
    (
      await drafts.save('acct-1', {
        draftId: 'd1',
        revision: 3,
        fingerprint: 'f',
        internetId: '<d1.3@mail.example>',
        mime: new Uint8Array(),
      })
    ).kind,
    'saved',
  );
  assert.equal((await send.findSent('acct-1', '<s1@mail.example>', 0)).kind, 'found');
  assert.equal(PROJECT, '*');
  assert.equal(new ProviderError(err('config', 'accessNotConfigured'), 'project').scope, 'project');
});

/** How `eng-time`'s outbox wakes: the overdue rule `SendPort` freezes, applied to every waiting row. */
function wakeOutbox(rows: { id: string; state: string; notBefore: number }[], now: number) {
  return rows.map(r =>
    (WAITING_SUBMISSION_STATES as readonly string[]).includes(r.state) &&
    now - r.notBefore > OVERDUE_GRACE_MS
      ? { ...r, state: 'suspended' }
      : r,
  );
}

test('a send-later row that fell due while the Mac was off is suspended, like a queued one; a sending row is not', () => {
  const now = 10 * 86_400_000;
  const woke = wakeOutbox(
    [
      { id: 'later', state: 'scheduled', notBefore: now - 2 * 86_400_000 },
      { id: 'undo', state: 'queued', notBefore: now - 6 * 60_000 },
      { id: 'fresh', state: 'queued', notBefore: now - 60_000 },
      { id: 'lost', state: 'sending', notBefore: now - 86_400_000 },
    ],
    now,
  );
  assert.deepEqual(
    woke.map(r => `${r.id}:${r.state}`),
    ['later:suspended', 'undo:suspended', 'fresh:queued', 'lost:sending'],
  );
});

test('the ports re-export the one definition of the waiting states and the grace', () => {
  assert.equal(
    WAITING_SUBMISSION_STATES,
    rules.WAITING_SUBMISSION_STATES,
    'the same array, not a copy',
  );
  assert.equal(OVERDUE_GRACE_MS, rules.OVERDUE_GRACE_MS);
  assert.deepEqual([...WAITING_SUBMISSION_STATES], ['queued', 'scheduled']);
});

test('a remote draft edited during the hold never leaves: the pinned mime does', async () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  // Gmail's view of the synced draft; `drafts.send` sends whatever it holds now.
  const remote = { id: 'r1', message: { id: 'rm-pinned', raw: 'pinned' } };
  const left: string[] = [];
  const adapter: Pick<ProviderAdapter, 'send'> = {
    send: async s => {
      const current =
        remote.id === s.remoteDraftId ? { remoteMessageId: remote.message.id } : undefined;
      if (sendsRemoteDraft(s, current)) {
        left.push(remote.message.raw);
        return { acceptedAt: 1, draftConsumed: true };
      }
      left.push(text(s.mime));
      return { acceptedAt: 1 };
    },
  };
  const pinned = {
    submissionId: 's1',
    internetId: '<s1@mail.example>',
    mime: bytes('pinned'),
    envelope: { from: 'me@mail.example', rcpt: ['you@mail.example'] },
    remoteDraftId: 'r1',
  };
  const ctx = {} as AdapterContext;
  assert.equal(
    (await adapter.send({ ...pinned, baseRemoteMessageId: 'rm-pinned' }, ctx)).draftConsumed,
    true,
  );
  remote.message = { id: 'rm-phone', raw: 'phone edit' };
  await adapter.send({ ...pinned, baseRemoteMessageId: 'rm-pinned' }, ctx);
  await adapter.send(pinned, ctx);
  assert.deepEqual(left, ['pinned', 'pinned', 'pinned'], 'the phone edit never leaves');
  // Graph keeps the id on edit, so the change key decides.
  const graph = { ...pinned, baseRemoteMessageId: 'm1', baseChangeKey: 'ck1' };
  assert.equal(sendsRemoteDraft(graph, { remoteMessageId: 'm1', changeKey: 'ck2' }), false);
  assert.equal(sendsRemoteDraft(graph, { remoteMessageId: 'm1', changeKey: 'ck1' }), true);
  assert.equal(sendsRemoteDraft(graph, undefined), false, 'a gone draft');
});

test('the governor policy has one row per F1 error class', () => {
  assert.deepEqual(Object.keys(GOVERNOR_CLASS_POLICY).sort(), [...errorClasses].sort());
  assert.equal(GOVERNOR_CLASS_POLICY.send_limit.pauses, 'sends');
  assert.equal(GOVERNOR_CLASS_POLICY.config.pauses, 'project');
  assert.equal(GOVERNOR_CLASS_POLICY.transient.resend, 'readAndIdempotentWrite');
  assert.ok(!('conflict' in GOVERNOR_CLASS_POLICY), 'an edit conflict is a result, not a class');
});

test('recurrence ids have one canonical form', () => {
  for (const ok of ['20261027T160000Z', '20261027', '20261027T090000'])
    assert.match(ok, RECURRENCE_ID_FORMAT);
  for (const bad of ['2026-10-27T09:00:00+02:00', '2026-10-27', '20261027T090000+0200', ''])
    assert.doesNotMatch(bad, RECURRENCE_ID_FORMAT);
});

test('calendar writes, filters, draft conflicts and the image proxy reach their ports', async () => {
  const notified: (boolean | undefined)[] = [];
  const calendar: CalendarPort = {
    put: async (_a, change) => (
      notified.push(change.notify),
      { kind: 'saved', upserts: [], removals: [] }
    ),
    remove: async (_a, ref) => (
      notified.push(ref.notify),
      { kind: 'saved', upserts: [], removals: [] }
    ),
    rsvp: async (_a, _r, _resp, opts) => (notified.push(opts.notify), { kind: 'conflict' }),
  };
  const ref = { calendarRemoteId: 'primary', remoteId: 'e1', recurrenceId: '20261027T160000Z' };
  await calendar.put('acct-1', { ...ref, scope: 'occurrence', fields: { summary: 'x' } });
  await calendar.remove('acct-1', { ...ref, scope: 'series', notify: true });
  await calendar.rsvp('acct-1', { ...ref, scope: 'occurrence' }, 'accepted', { notify: false });
  assert.deepEqual(
    notified,
    [undefined, true, false],
    'absent notify reaches the adapter as absent: no email',
  );

  const remote = new Map<string, string>();
  const rules: RulesPort = {
    list: async () =>
      [...remote].map(([remoteId, addressOrDomain]) => ({
        remoteId,
        addressOrDomain,
        action: 'block',
      })),
    create: async (_a, rule) => (remote.set('f1', rule.addressOrDomain), 'f1'),
    delete: async (_a, id) => void remote.delete(id),
  };
  assert.equal(
    await rules.create('acct-1', { addressOrDomain: 'spam.example', action: 'block' }),
    'f1',
  );
  assert.equal((await rules.list('acct-1')).length, 1);

  // The phone edited the draft after our last sync: the save is refused, never overwritten.
  const server = { remoteMessageId: 'rm-phone' };
  const drafts: DraftSyncPort = {
    save: async (_a, d) =>
      d.baseRemoteMessageId !== server.remoteMessageId
        ? { kind: 'conflict', remoteMessageId: server.remoteMessageId }
        : { kind: 'saved', remoteDraftId: 'r1', remoteMessageId: 'rm2', revision: d.revision },
    remove: async () => {},
  };
  const upload = {
    draftId: 'd1',
    revision: 4,
    fingerprint: 'f',
    internetId: '<d1.4@mail.example>',
    mime: new Uint8Array(),
    remoteDraftId: 'r1',
  };
  assert.equal(
    (await drafts.save('acct-1', { ...upload, baseRemoteMessageId: 'rm1' })).kind,
    'conflict',
  );
  assert.equal(
    (await drafts.save('acct-1', { ...upload, baseRemoteMessageId: 'rm-phone' })).kind,
    'saved',
  );

  const images: ImageProxy = {
    fetch: async url =>
      /^https?:\/\/(127\.|10\.|\[::1\])/.test(url)
        ? { kind: 'refused', reason: 'address' }
        : { kind: 'image', mime: 'image/png', bytes: new Uint8Array(8) },
  };
  const signal = new AbortController().signal;
  assert.deepEqual(await images.fetch('http://127.0.0.1/pixel.png', { token: 't', signal }), {
    kind: 'refused',
    reason: 'address',
  });
  assert.deepEqual(IMAGE_PROXY_LIMITS.ports, [80, 443]);
});
