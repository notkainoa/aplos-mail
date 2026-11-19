import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type AdapterContext,
  type FindSentResult,
  type SendReceipt,
  type SubmissionPayload,
} from '../src/ports';
import { NotSentError, PausedError } from '../src/ports/base';
import type { BudgetId } from '../src/ports/base';
import type { GovernorPort } from '../src/ports/governor';
import { sendPortOf } from '../src/sync/host-send';
import { ACCOUNT, ADDRESS, FakeAdapter, disk, world, type World } from './sync-actor-helpers';

/**
 * `ActorHost` as the engine's `SendPort` (plan 20 PV4): `send` and `findSent` reach the named account's adapter
 * under that account's actor context on the `interactive` lane, `admission` is the mail budget's `send` admission,
 * and a call for an account that is not started is a `transient` refusal that provably wrote nothing.
 */

const OTHER = 'acct-2';

interface Seen {
  ctx: AdapterContext;
  what: string;
}

class SendAdapter extends FakeAdapter {
  readonly seen: Seen[] = [];
  bodyRuns = 0;
  result: SendReceipt = { remoteMessageId: 'm-9', acceptedAt: 123 };
  found: FindSentResult = { kind: 'found', remoteMessageId: 'm-9' };

  constructor() {
    super(() => [], {});
  }

  override async send(submission: SubmissionPayload, ctx: AdapterContext): Promise<SendReceipt> {
    this.seen.push({ ctx, what: `send:${submission.submissionId}` });
    return ctx.governor.run(
      { budget: 'gmail', lane: 'interactive', kind: 'send', method: 'fake.send', cost: 10 },
      async () => {
        this.bodyRuns++;
        return this.result;
      },
    );
  }

  override async findSent(
    internetId: string,
    since: number,
    ctx: AdapterContext,
  ): Promise<FindSentResult> {
    this.seen.push({ ctx, what: `find:${internetId}:${since}` });
    return this.found;
  }
}

const submission = (submissionId = 'sub-1'): SubmissionPayload => ({
  submissionId,
  internetId: '<x@example.test>',
  mime: new Uint8Array([1, 2, 3]),
  envelope: { from: ADDRESS, rcpt: ['to@example.test'] },
});

function addAccount(w: World, id: string): void {
  w.store.commit({
    opId: `setup-${id}`,
    origin: 'system',
    writes: [
      {
        kind: 'account',
        id,
        provider: 'google',
        address: `${id}@example.test`,
        capabilities: { labels: true, drafts: true, threading: 'native' },
        status: { state: 'ok' },
      },
    ],
  });
}

function rig(adapters: Record<string, FakeAdapter>) {
  const d = disk();
  const w = world(d, account => adapters[account.id]!);
  addAccount(w, OTHER);
  return {
    w,
    done: async () => {
      await w.kill();
      d.cleanup();
    },
  };
}

const isNotStarted = (error: unknown) =>
  error instanceof PausedError && error.cls === 'transient' && error.reason === 'accountNotStarted';

test('send routes to the named account adapter with its actor context and returns the result unchanged', async () => {
  const a = new SendAdapter();
  const b = new SendAdapter();
  const { w, done } = rig({ [ACCOUNT]: a, [OTHER]: b });
  try {
    await w.host.start(ACCOUNT);
    await w.host.start(OTHER);
    const receipt = await w.host.sendPort.send(OTHER, submission());
    assert.deepEqual(receipt, { remoteMessageId: 'm-9', acceptedAt: 123 });
    assert.equal(a.seen.length, 0, 'the other account was never asked');
    assert.deepEqual(
      b.seen.map(s => s.what),
      ['send:sub-1'],
    );
    assert.equal(b.seen[0]!.ctx.account.id, OTHER);
    assert.equal(b.seen[0]!.ctx.account.address, `${OTHER}@example.test`);
    await w.host.sendPort.send(ACCOUNT, submission('sub-2'));
    assert.equal(a.seen[0]!.ctx.account.id, ACCOUNT);
    assert.equal(a.seen[0]!.ctx.account.address, ADDRESS);
    assert.equal(b.seen.length, 1, 'still one: the call for acct-1 never reached acct-2');
  } finally {
    await done();
  }
});

test('send and findSent for an account that is not started pause transiently, so the outbox re-asks', async () => {
  const a = new SendAdapter();
  const { w, done } = rig({ [ACCOUNT]: a, [OTHER]: new SendAdapter() });
  try {
    await assert.rejects(w.host.sendPort.send(ACCOUNT, submission()), isNotStarted);
    await assert.rejects(w.host.sendPort.findSent(ACCOUNT, '<x@example.test>', 0), isNotStarted);
    assert.equal(a.seen.length, 0);
  } finally {
    await done();
  }
});

test('findSent passes internetId and since through and returns the adapter answer', async () => {
  const a = new SendAdapter();
  const { w, done } = rig({ [ACCOUNT]: a, [OTHER]: new SendAdapter() });
  try {
    await w.host.start(ACCOUNT);
    const found = await w.host.sendPort.findSent(ACCOUNT, '<mid@example.test>', 999);
    assert.deepEqual(found, { kind: 'found', remoteMessageId: 'm-9' });
    assert.deepEqual(
      a.seen.map(s => s.what),
      ['find:<mid@example.test>:999'],
    );
  } finally {
    await done();
  }
});

test('admission answers the mail budget send admission and refuses transiently when not started', async () => {
  const a = new SendAdapter();
  const { w, done } = rig({ [ACCOUNT]: a, [OTHER]: new SendAdapter() });
  try {
    assert.deepEqual(w.host.sendPort.admission(ACCOUNT), {
      ok: false,
      cls: 'transient',
      reason: 'accountNotStarted',
    });
    await w.host.start(ACCOUNT);
    const answer = w.host.sendPort.admission(ACCOUNT);
    assert.equal(answer.ok, true, `expected an open budget, got ${JSON.stringify(answer)}`);
    // The refusal is the governor's own, asked with kind 'send': a send_limit holds only the send kind, so a port
    // that skipped the governor or dropped the kind would answer ok here.
    w.governor.observe(ACCOUNT, 'gmail', {
      class: 'send_limit',
      provider: 'google',
      method: 'gmail.users.messages.send',
      reason: 'userRateLimitExceeded',
      status: 429,
    });
    const refused = w.host.sendPort.admission(ACCOUNT);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.cls, 'send_limit');
  } finally {
    await done();
  }
});

test('a context naming another account is a permanent NotSentError, and nothing is sent', async () => {
  const a = new SendAdapter();
  const otherCtx = { account: { id: OTHER, address: `${OTHER}@example.test` } } as AdapterContext;
  const port = sendPortOf(
    () => ({ admission: () => ({ ok: true }) }) as unknown as GovernorPort,
    new Map([
      [
        ACCOUNT,
        {
          adapter: a,
          budget: 'gmail' as BudgetId,
          actor: { context: () => otherCtx },
        },
      ],
    ]),
  );
  const isMismatch = (e: unknown) =>
    e instanceof NotSentError &&
    e.error.class === 'permanent' &&
    e.error.reason === 'accountMismatch';
  await assert.rejects(port.send(ACCOUNT, submission()), isMismatch);
  await assert.rejects(port.findSent(ACCOUNT, '<x@example.test>', 0), isMismatch);
  assert.equal(a.seen.length, 0, 'the mismatched adapter was never called');
});
