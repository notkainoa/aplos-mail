/**
 * The provider conformance suite: what every mail provider must do, checked through the public provider port only.
 * A binding calls `runProviderConformance(make)` with a function that builds the factory under test and a handle on
 * the fake server it talks to (`types.ts`). A check a provider cannot pass yet is named in `options.todo` with the
 * reason, so it still runs and reports, without failing the run.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PausedError,
  ProviderError,
  type AdapterAccount,
  type AdapterContext,
  type BoundGovernor,
  type Capabilities,
  type CoalescedOp,
  type Logger,
  type OpOutcome,
  type PendingOp,
  type PlanTrigger,
  type ProviderAdapter,
  type SubmissionPayload,
} from '@aplos/engine/ports';
import { SuiteStore } from './store';
import type { ConformanceRig, MakeRig, ServerMessage } from './types';

export type CheckId =
  | 'connect-first-sync'
  | 'incremental'
  | 'open-thread'
  | 'ops'
  | 'send'
  | 'errors'
  | 'isolation'
  | `capabilities:${keyof Capabilities}`;

export interface ConformanceOptions {
  /** Checks this provider cannot pass yet, with the reason. */
  todo?: Partial<Record<CheckId, string>>;
}

const ACCOUNT_ID = 'acct-conformance';
const MINUTE = 60_000;

const quietLog: Logger = { event() {}, with: () => quietLog, enabled: () => false };

/** One connected account: the adapter, the engine's store and the loop the actor would run. */
class Session {
  adapter: ProviderAdapter;
  readonly store: SuiteStore;
  /** The error class of every call the adapter reported as failed, in order. */
  readonly reported: string[] = [];
  private readonly governor: BoundGovernor;
  private readonly stopper = new AbortController();

  constructor(
    readonly rig: ConformanceRig,
    readonly account: AdapterAccount,
    memory: Record<string, string> = {},
  ) {
    this.adapter = rig.factory.open(account);
    this.store = new SuiteStore(account, () => rig.clock.now(), memory);
    this.governor = recording(rig.governor(account), this.reported);
  }

  ctx(): AdapterContext {
    return {
      account: this.account,
      governor: this.governor,
      clock: this.rig.clock,
      log: quietLog,
      signal: this.stopper.signal,
      lookup: this.store.lookup,
      memory: this.store.memory,
      generation: this.store.seq,
    };
  }

  /** Runs every step that is due, as the actor does, and commits each; returns how many ran. */
  async drive(trigger: PlanTrigger, maxSteps = 300): Promise<number> {
    let ran = 0;
    let current = trigger;
    for (; ran < maxSteps; ran++) {
      const step = this.dueStep(current);
      if (!step) break;
      const fence = this.store.seq;
      const result = await this.adapter.syncStep(step, this.store.state(step.scope), this.ctx());
      this.store.commit(step, result, fence);
      current = 'poll';
    }
    return ran;
  }

  /** A stop and a fresh start: the same account and store, a new adapter. */
  async reopen(): Promise<void> {
    await this.adapter.close();
    this.adapter = this.rig.factory.open(this.account);
  }

  async close(): Promise<void> {
    this.stopper.abort();
    await this.adapter.close();
    this.store.close();
    await this.rig.close();
  }

  private dueStep(trigger: PlanTrigger) {
    const now = this.rig.clock.now();
    const steps = this.adapter.plan({
      account: this.account,
      states: this.store.states(),
      trigger,
      env: { now, focused: true, windowVisible: true, onBattery: false },
      memory: this.store.memory,
    });
    return steps.find(s => (s.notBefore ?? 0) <= now);
  }
}

/** The governor as given, with every failure the adapter reports through it recorded by class. */
function recording(inner: BoundGovernor, reported: string[]): BoundGovernor {
  const run: BoundGovernor['run'] = (req, fn) =>
    inner.run(req, async io => {
      try {
        return await fn(io);
      } catch (error) {
        reported.push(classOf(error) ?? 'unclassified');
        throw error;
      }
    });
  return new Proxy(inner, {
    get: (target, key, receiver) =>
      key === 'run' ? run : (Reflect.get(target, key, receiver) as unknown),
  });
}

async function settle(promise: Promise<unknown>): Promise<{ error?: unknown }> {
  try {
    await promise;
    return {};
  } catch (error) {
    return { error };
  }
}

/** Polls every ten minutes, as the app would, until `done` holds or two hours pass. */
async function eventually(session: Session, done: () => boolean): Promise<boolean> {
  for (let round = 0; round < 12 && !done(); round++) {
    await session.rig.clock.advance(10 * MINUTE);
    await session.drive('poll');
  }
  return done();
}

async function connect(rig: ConformanceRig): Promise<Session> {
  const result = await rig.factory.connect(
    { mode: 'new', loginHint: rig.server.address },
    rig.connectContext(ACCOUNT_ID),
  );
  assert.equal(result.identity.address.toLowerCase(), rig.server.address.toLowerCase());
  assert.ok(result.credentialRef, 'connect names where the credential is kept');
  const account: AdapterAccount = {
    id: ACCOUNT_ID,
    provider: rig.factory.kind,
    address: result.identity.address,
    grantedScopes: result.grantedScopes,
    capabilities: result.capabilities,
  };
  return new Session(rig, account, result.memory);
}

/** A connected session whose first sync has finished. */
async function synced(make: MakeRig, threads: number): Promise<Session> {
  const session = await connect(await make({ threads }));
  await session.drive('first');
  return session;
}

function classOf(error: unknown): string | undefined {
  if (error instanceof ProviderError) return error.error.class;
  if (error instanceof PausedError) return error.cls;
  return undefined;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail('expected a rejection');
}

let opSeq = 0;
const op = (remoteId: string, change: PendingOp['change']): PendingOp => ({
  opId: `op-${++opSeq}`,
  seq: opSeq,
  remoteId,
  change,
});

/** Applies coalesced calls and returns every outcome; a call that throws counts as failed with its class. */
async function applyAll(session: Session, calls: CoalescedOp[]): Promise<OpOutcome[]> {
  const out: OpOutcome[] = [];
  for (const call of calls) {
    try {
      out.push(...(await session.adapter.apply(call, session.ctx())));
    } catch (error) {
      const cls = classOf(error) ?? 'thrown';
      for (const opId of call.opIds) out.push(failedOutcome(opId, cls));
    }
  }
  return out;
}

function failedOutcome(opId: string, cls: string): OpOutcome {
  return {
    opId,
    result: 'failed',
    error: { class: cls, provider: 'conformance', method: 'apply', reason: cls },
  };
}

const outcomeClass = (o: OpOutcome) => o.error?.class;

/** Inbox messages on the server, unread and unflagged, so each change is visible. */
function freshInbox(session: Session, count: number): ServerMessage[] {
  const picked = session.rig.server.inbox().slice(0, count);
  for (const m of picked) session.rig.server.setFlags(m.remoteId, { seen: false, flagged: false });
  return picked.map(m => session.rig.server.message(m.remoteId)!);
}

let mailSeq = 0;
function submission(address: string): SubmissionPayload {
  const internetId = `<conformance-${++mailSeq}-${'cd'.repeat(6)}@example.test>`;
  const mime = [
    `From: <${address}>`,
    'To: <friend@example.test>',
    `Subject: Conformance ${mailSeq}`,
    `Message-ID: ${internetId}`,
    'Date: Tue, 27 Oct 2026 16:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello from the conformance suite.',
    '',
  ].join('\r\n');
  return {
    submissionId: `sub-${mailSeq}`,
    internetId,
    mime: new TextEncoder().encode(mime),
    envelope: { from: address, rcpt: ['friend@example.test'] },
  };
}

function check(
  id: CheckId,
  name: string,
  options: ConformanceOptions,
  fn: () => Promise<void>,
): void {
  const todo = options.todo?.[id];
  test(`${id}: ${name}`, todo ? { todo } : {}, fn);
}

// ---- the checks ----

function connectAndFirstSync(make: MakeRig, options: ConformanceOptions): void {
  check(
    'connect-first-sync',
    'connect, page the first sync, resume after a stop',
    options,
    async () => {
      const full = await connect(await make({ threads: 120 }));
      const fullSteps = await full.drive('first');
      const stored = full.store.messages();
      assert.ok(fullSteps > 1, `the first sync pages (${fullSteps} steps)`);
      for (const m of full.rig.server.inbox())
        assert.ok(stored.has(m.remoteId), `inbox ${m.remoteId}`);
      await full.close();

      const stopped = await connect(await make({ threads: 120 }));
      const before = await stopped.drive('first', 2);
      await stopped.reopen();
      const after = await stopped.drive('resume');
      const resumed = stopped.store.messages();
      for (const m of stopped.rig.server.inbox())
        assert.ok(resumed.has(m.remoteId), `inbox ${m.remoteId}`);
      assert.ok(
        after < fullSteps,
        `the resumed sync carries on (${before} + ${after} vs ${fullSteps})`,
      );
      await stopped.close();
    },
  );
}

function incremental(make: MakeRig, options: ConformanceOptions): void {
  check('incremental', 'new mail, a flag change and a removal arrive', options, async () => {
    const session = await synced(make, 20);
    const { server } = session.rig;
    const [changed, removed] = freshInbox(session, 2);
    await session.rig.clock.advance(5 * MINUTE);
    await session.drive('poll');
    const fresh = server.deliver({ subject: 'Fresh', text: 'Just arrived.' });
    server.setFlags(changed.remoteId, { seen: true, flagged: true });
    server.remove(removed.remoteId);
    await session.rig.clock.advance(5 * MINUTE);
    await session.drive('poll');
    const stored = session.store.messages();
    assert.ok(stored.has(fresh.remoteId), 'the new mail is stored');
    assert.equal(stored.get(changed.remoteId)?.seen, true, 'seen arrived');
    assert.equal(stored.get(changed.remoteId)?.flagged, true, 'flagged arrived');
    assert.equal(stored.has(removed.remoteId), false, 'the removal arrived');
    await session.close();
  });
}

function openThread(make: MakeRig, options: ConformanceOptions): void {
  check('open-thread', 'opening a thread returns every message and its body', options, async () => {
    const rig = await make({ threads: 5 });
    const texts = ['First body alpha.', 'Second body beta.', 'Third body gamma.'];
    const first = rig.server.deliver({ subject: 'Plan', text: texts[0] });
    const second = rig.server.deliver({
      subject: 'Re: Plan',
      text: texts[1],
      inReplyTo: first.remoteId,
    });
    rig.server.deliver({ subject: 'Re: Plan', text: texts[2], inReplyTo: second.remoteId });
    const session = await connect(rig);
    await session.drive('first');
    const opened = await session.adapter.openThread(
      { remoteThreadId: first.remoteThreadId },
      'interactive',
      session.ctx(),
    );
    assert.equal(opened.messages.length, 3, 'every message of the thread');
    const bodies = opened.messages.map(m => `${m.body.text ?? ''} ${m.body.html ?? ''}`).join('\n');
    for (const text of texts) assert.ok(bodies.includes(text), `body "${text}"`);
    await session.close();
  });
}

function ops(make: MakeRig, options: ConformanceOptions): void {
  check(
    'ops',
    'a flag change and a move reach the server once and survive a retry',
    options,
    async () => {
      const session = await synced(make, 10);
      const { server } = session.rig;
      const [read, moved, retried] = freshInbox(session, 3);
      const writesBefore = server.writes();
      const calls = session.adapter.coalesce([
        op(read.remoteId, { kind: 'flags', seen: true }),
        op(moved.remoteId, { kind: 'trash' }),
      ]);
      const outcomes = await applyAll(session, calls);
      assert.deepEqual(
        outcomes.map(o => o.result),
        ['applied', 'applied'],
      );
      assert.equal(server.writes() - writesBefore, calls.length, 'one server write per call');
      assert.equal(server.message(read.remoteId)?.seen, true);
      assert.equal(server.message(moved.remoteId)?.trashed, true);

      const count = server.inbox().length;
      const retry = session.adapter.coalesce([
        op(retried.remoteId, { kind: 'flags', flagged: true }),
      ]);
      server.fail('write', 'lostAnswer');
      const lost = await applyAll(session, retry);
      // The retry may happen inside the adapter's call (an idempotent write) or as a second apply.
      const again = lost[0]?.result === 'applied' ? lost : await applyAll(session, retry);
      assert.equal(again[0]?.result, 'applied', 'the retry applies');
      assert.equal(server.message(retried.remoteId)?.flagged, true);
      assert.equal(server.inbox().length, count, 'the retry changed nothing else');

      await session.rig.clock.advance(5 * MINUTE);
      await session.drive('poll');
      assert.equal(session.store.messages().get(read.remoteId)?.seen, true, 'the store agrees');
      await session.close();
    },
  );
}

function send(make: MakeRig, options: ConformanceOptions): void {
  check(
    'send',
    'a send is delivered once; an interrupted send is found, not repeated',
    options,
    async () => {
      const session = await connect(await make({ threads: 2 }));
      const { server } = session.rig;
      const since = session.rig.clock.now() - MINUTE;
      const plain = submission(session.account.address);
      await session.adapter.send(plain, session.ctx());
      assert.equal(server.delivered(plain.internetId), 1, 'delivered once');

      const lost = submission(session.account.address);
      server.fail('send', 'lostAnswer');
      await rejection(session.adapter.send(lost, session.ctx()));
      const found = await session.adapter.findSent(lost.internetId, since, session.ctx());
      assert.equal(found.kind, 'found', 'the accepted send is found again');
      assert.equal(server.delivered(lost.internetId), 1, 'and not sent twice');

      const unsent = submission(session.account.address);
      server.fail('send', 'notSent');
      await rejection(session.adapter.send(unsent, session.ctx()));
      const absent = await session.adapter.findSent(unsent.internetId, since, session.ctx());
      assert.equal(absent.kind, 'absent', 'a send the server never saw is absent');
      await session.adapter.send(unsent, session.ctx());
      assert.equal(server.delivered(unsent.internetId), 1, 'so it is sent once');
      await session.close();
    },
  );
}

function errors(make: MakeRig, options: ConformanceOptions): void {
  check(
    'errors',
    'throttled and failed requests report their class and lose nothing',
    options,
    async () => {
      const session = await synced(make, 10);
      const { server, clock } = session.rig;
      for (const [kind, cls] of [
        ['throttle', 'throttle'],
        ['unavailable', 'transient'],
      ] as const) {
        await clock.advance(5 * MINUTE);
        const before = session.store.messages();
        const states = session.store.states();
        const reported = session.reported.length;
        const mail = server.deliver({ subject: `During ${kind}`, text: 'Must not be lost.' });
        server.fail('sync', kind);
        const { error } = await settle(session.drive('poll'));
        assert.deepEqual(
          session.reported.slice(reported, reported + 1),
          [cls],
          `${kind} is reported as ${cls}`,
        );
        if (error !== undefined) {
          assert.equal(classOf(error), cls, `the step fails as ${cls}`);
          assert.deepEqual(session.store.messages(), before, 'nothing half-stored');
          assert.deepEqual(session.store.states(), states, 'the cursor did not move');
        }
        assert.ok(
          await eventually(session, () => session.store.messages().has(mail.remoteId)),
          'the mail arrives once the server answers again',
        );
      }

      await clock.advance(10 * MINUTE);
      const [target] = freshInbox(session, 1);
      const calls = session.adapter.coalesce([op(target.remoteId, { kind: 'flags', seen: true })]);
      const reported = session.reported.length;
      server.fail('write', 'throttle');
      const refused = await applyAll(session, calls);
      assert.deepEqual(
        session.reported.slice(reported, reported + 1),
        ['throttle'],
        'a refused write says throttle',
      );
      if (refused[0]?.result !== 'applied') {
        assert.equal(outcomeClass(refused[0]!), 'throttle', 'the outcome says throttle');
        assert.equal(server.message(target.remoteId)?.seen, false, 'and changed nothing');
        await clock.advance(10 * MINUTE);
        const retried = await applyAll(session, calls);
        assert.equal(retried[0]?.result, 'applied');
      }
      assert.equal(server.message(target.remoteId)?.seen, true, 'the change lands once allowed');
      await session.close();
    },
  );
}

function isolation(make: MakeRig, options: ConformanceOptions): void {
  check(
    'isolation',
    'the adapter touches only the account it was opened for',
    options,
    async () => {
      const rig = await make({ threads: 10 });
      const theirs = [1, 2, 3].map(n =>
        rig.server.other.deliver({ subject: `Theirs ${n}`, text: 'Private.' }),
      );
      const session = await connect(rig);
      await session.drive('first');
      const [mine] = freshInbox(session, 1);
      await session.adapter.openThread(
        { remoteThreadId: mine.remoteThreadId },
        'interactive',
        session.ctx(),
      );
      const foreign = theirs.filter(m => !rig.server.message(m.remoteId));
      const calls = session.adapter.coalesce([
        op(mine.remoteId, { kind: 'flags', seen: true }),
        ...foreign.map(m => op(m.remoteId, { kind: 'flags', seen: true })),
      ]);
      await applyAll(session, calls);
      for (const m of theirs)
        assert.equal(rig.server.other.message(m.remoteId)?.seen, false, 'theirs unread');
      const stored = session.store.messages();
      for (const m of foreign) assert.equal(stored.has(m.remoteId), false, 'theirs not stored');
      assert.deepEqual(rig.server.touched(), [rig.server.address.toLowerCase()]);
      await session.close();
    },
  );
}

/** Each optional area of the port and the flag that turns it off. */
const AREAS = [
  { flag: 'drafts', member: 'saveDraft' },
  { flag: 'serverSearch', member: 'search' },
  { flag: 'filters', member: 'rules' },
  { flag: 'push', member: 'watch' },
  { flag: 'calendar', member: 'calendar' },
] as const;

/** Calls the area once; resolves when it is absent or refuses with a plain error, never a crash. */
async function refusesCleanly(
  adapter: ProviderAdapter,
  area: (typeof AREAS)[number],
  ctx: AdapterContext,
) {
  const calls: Record<(typeof AREAS)[number]['member'], () => Promise<unknown> | undefined> = {
    saveDraft: () => adapter.saveDraft?.(draftUpload(), ctx),
    search: () => adapter.search?.({ text: 'anything', limit: 5 }, ctx),
    rules: () => adapter.rules?.list(ctx),
    watch: () => firstHint(adapter, ctx),
    calendar: () => (adapter.calendar ? adapter.calendar.listCalendars(undefined, ctx) : undefined),
  };
  const pending = calls[area.member]();
  if (pending === undefined) return;
  const settled = await settle(
    pending.then(value =>
      assert.ok(
        area.member === 'watch' && value === undefined,
        `${area.member} answered with the area off`,
      ),
    ),
  );
  const { error } = settled;
  if (error === undefined) return;
  if (error instanceof assert.AssertionError) throw error;
  assert.ok(
    error instanceof Error && !(error instanceof TypeError),
    `${area.member} refuses: ${String(error)}`,
  );
}

async function firstHint(adapter: ProviderAdapter, ctx: AdapterContext): Promise<unknown> {
  if (!adapter.watch) return undefined;
  for await (const hint of adapter.watch(ctx)) return hint;
  return undefined;
}

function draftUpload() {
  return {
    draftId: 'draft-conformance',
    revision: 1,
    fingerprint: 'f1',
    internetId: '<draft-conformance@example.test>',
    mime: new TextEncoder().encode('Subject: Draft\r\n\r\nNot yet.\r\n'),
  };
}

function capabilities(make: MakeRig, options: ConformanceOptions): void {
  for (const area of AREAS) {
    check(
      `capabilities:${area.flag}`,
      `with ${area.flag} off the area is skipped and refused`,
      options,
      async () => {
        const connected = await connect(await make({ threads: 3 }));
        const account: AdapterAccount = {
          ...connected.account,
          capabilities: { ...connected.account.capabilities, [area.flag]: false },
        };
        const session = new Session(connected.rig, account);
        const now = session.rig.clock.now();
        const planned = session.adapter.plan({
          account,
          states: [],
          trigger: 'first',
          env: { now, focused: true, windowVisible: true, onBattery: false },
          memory: new Map(),
        });
        if (area.flag === 'calendar')
          assert.deepEqual(
            planned.filter(s => s.scope.startsWith('calendar')),
            [],
            'no calendar steps',
          );
        await refusesCleanly(session.adapter, area, session.ctx());
        await session.close();
        await connected.adapter.close();
      },
    );
  }
}

/** Registers the eight checks against `make`'s provider. */
export function runProviderConformance(make: MakeRig, options: ConformanceOptions = {}): void {
  describe('provider conformance', () => {
    connectAndFirstSync(make, options);
    incremental(make, options);
    openThread(make, options);
    ops(make, options);
    send(make, options);
    errors(make, options);
    isolation(make, options);
    capabilities(make, options);
  });
}
