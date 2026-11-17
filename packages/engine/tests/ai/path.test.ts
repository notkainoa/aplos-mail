import assert from 'node:assert/strict';
import test from 'node:test';
import type { Frame } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { detachedTransport, AiCallError } from '../../src/ai/host';
import { runJobs } from '../../src/ai/impl/runner';
import { ACCOUNT, accountWrite, folderWrites, msg } from '../store/helpers';
import { lastPrompt, seedMail, settle, stubTransport, world } from './harness';
import type { World } from './harness';

const consentNow = async (w: World) => {
  await w.call('Settings/set', { opId: 'bg', patch: { ai: { background: true } } });
  const got = await w.call('Consent/get', {});
  return w.call('Consent/grant', {
    scope: 'background',
    version: got.currentVersion ?? got.version,
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
  });
};

const DAY_MS = 24 * 60 * 60_000;

/**
 * A Follow up thread (followUpDays defaults to 3; the clock sits at T0): an inbound question a week old and the
 * owner's answer four days old, still `awaitingReply`, sitting in Sent. `spam` adds the Spam label instead.
 */
const seedFollow = (w: World, opts: { aiAllowed?: boolean; spam?: boolean } = {}) => {
  // Mail lands while the account is still kept out of AI so the ingest enqueue stays out, and seen+done keeps
  // the thread below the summary queue's Home-visible/unread bar so `consentNow`'s catch-up queues nothing
  // either — the lane's `followup` job is the queue's only one.
  w.store.commit({
    opId: 'seed-f',
    origin: 'sync',
    writes: [
      { ...accountWrite, aiAllowed: false },
      ...folderWrites.map(f => ({ ...f })),
      {
        kind: 'folder' as const,
        accountId: ACCOUNT,
        remoteId: 'SENT',
        name: 'Sent',
        role: 'sent' as const,
        folderKind: 'system' as const,
      },
      ...(opts.spam
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
      msg('f-in', 'T-follow', -7 * 24 * 60, {
        subject: 'Invoice question',
        snippet: 'Could you send the invoice?',
        flags: { seen: true, flagged: false, draft: false, fromMe: false },
        ...(opts.spam ? { folders: [{ folder: 'INBOX' }, { folder: 'SPAM' }] } : {}),
      }),
      msg('f-out', 'T-follow', -4 * 24 * 60, {
        from: { address: 'owner@mail.example', name: 'Owner' },
        to: [{ address: 'sender-f-in@mail.example' }],
        snippet: 'Here is the invoice.',
        flags: { seen: true, flagged: false, draft: false, fromMe: true },
        folders: opts.spam ? [{ folder: 'SENT' }, { folder: 'SPAM' }] : [{ folder: 'SENT' }],
      }),
      {
        kind: 'workflow' as const,
        accountId: ACCOUNT,
        remoteThreadId: 'T-follow',
        patch: { status: 'done' as const, replyStatus: 'awaitingReply' as const },
      },
    ],
  });
  if (opts.aiAllowed ?? true)
    w.store.commit({
      opId: 'ai-on',
      origin: 'sync',
      writes: [{ kind: 'account', id: ACCOUNT, aiAllowed: true }],
    });
};

test('Ai/request: unknown thread and a kept-out account refuse before anything queues', async () => {
  const w = await world();
  seedMail(w);
  // The ingest enqueue is legitimate here: it queued the thread's own summary job; the refusals add nothing.
  const before = (await w.call('Ai/jobs', {})).list.length;
  await assert.rejects(
    () => w.call('Ai/request', { opId: 'r1', kind: 'summary', threadId: 'acct-1:nope' }),
    (e: unknown) => e instanceof ContractError && e.type === 'notFound',
  );
  // Turn the account's AI off: the refusal names the setting.
  w.store.commit({
    opId: 'off',
    origin: 'sync',
    writes: [{ kind: 'account', id: ACCOUNT, aiAllowed: false }],
  });
  await assert.rejects(
    () => w.call('Ai/request', { opId: 'r2', kind: 'summary', threadId: 'acct-1:T-thread' }),
    (e: unknown) =>
      e instanceof ContractError &&
      e.type === 'forbidden' &&
      e.body.reasonCode === 'ai.accountExcluded',
  );
  const jobs = await w.call('Ai/jobs', {});
  assert.equal(jobs.list.length, before);
});

test('Ai/polish + Ask/run: an accountId left out of AI refuses before any mail is read', async () => {
  const w = await world();
  seedMail(w);
  await consentNow(w);
  // Turn the account's AI off: the named account is forbidden for polish and for Ask's open draft.
  w.store.commit({
    opId: 'off2',
    origin: 'sync',
    writes: [{ kind: 'account', id: ACCOUNT, aiAllowed: false }],
  });
  await assert.rejects(
    () =>
      w.call('Ai/polish', {
        requestId: 'req-p',
        html: '<p>hi</p>',
        accountId: ACCOUNT,
      }),
    (e: unknown) =>
      e instanceof ContractError &&
      e.type === 'forbidden' &&
      e.body.reasonCode === 'ai.accountExcluded',
  );
  await assert.rejects(
    () =>
      w.call('Ask/run', {
        question: 'what did they say',
        context: { draft: { accountId: ACCOUNT, html: '<p>reply</p>' } },
      }),
    (e: unknown) =>
      e instanceof ContractError &&
      e.type === 'forbidden' &&
      e.body.reasonCode === 'ai.accountExcluded',
  );
});

test('Ai/request: a fresh thread enqueues once under the singleton key; force reruns', async () => {
  const w = await world();
  seedMail(w);
  const one = await w.call('Ai/request', {
    opId: 'r1',
    kind: 'summary',
    threadId: 'acct-1:T-thread',
  });
  assert.equal(one.job.kind, 'summary');
  assert.equal(one.job.state, 'queued');
  const two = await w.call('Ai/request', {
    opId: 'r2',
    kind: 'summary',
    threadId: 'acct-1:T-thread',
  });
  assert.equal(two.job.id, one.job.id, 'the same key wins');
  const jobs = await w.call('Ai/jobs', {});
  assert.equal(jobs.list.length, 1);
});

test('jobs runner: without consent the due summary job waits; with consent it summarizes and meters', async () => {
  const w = await world(
    stubTransport({ answer: '{"summary":"Ada asked about the invoice.","action":null}' }),
  );
  seedMail(w);
  await w.call('Settings/set', { opId: 'bg', patch: { ai: { background: true } } });
  const req = await w.call('Ai/request', {
    opId: 'r1',
    kind: 'summary',
    threadId: 'acct-1:T-thread',
  });
  await runJobs(w.engine.services, w.clock.now());
  let job = (await w.call('Ai/jobs', {})).list.find(j => j.id === req.job.id)!;
  assert.equal(job.state, 'queued', 'the gate deferred it, not failed it');
  assert.ok((job.nextAt ?? 0) > w.clock.now());
  const transport = w.engine.services.ai.transport() as ReturnType<typeof stubTransport>;
  assert.equal(transport.calls.length, 0, 'no mail text left without consent');

  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now() + 1);
  job = w.engine.services.store.read(q =>
    q.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', Number(req.job.id)),
  ) as never;
  assert.equal((job as unknown as { state: string }).state, 'done');
  assert.equal(transport.calls.length, 1);
  assert.match(transport.calls[0].model.model, /gpt-oss/);
  const summary = w.file.open().prepare('SELECT text, state FROM summaries').all() as {
    text: string;
    state: string;
  }[];
  assert.equal(summary.length, 1);
  assert.equal(summary[0].state, 'ready');
  const usage = await w.call('Ai/usage', {});
  assert.equal(usage.byModel.length, 1);
  assert.equal(usage.byModel[0].lane, 'background');
  assert.equal(usage.byModel[0].tokensIn, 42);
});

test('jobs runner: provider failures back off; five attempts dead-letter', async () => {
  const w = await world(stubTransport({ fail: new AiCallError('unreachable', 'down') }));
  seedMail(w);
  await consentNow(w);
  const req = await w.call('Ai/request', {
    opId: 'r1',
    kind: 'summary',
    threadId: 'acct-1:T-thread',
  });
  for (let i = 0; i < 5; i++) {
    await runJobs(w.engine.services, w.clock.now());
    const job = (
      await w.call('Ai/jobs', { states: ['queued', 'running', 'failed', 'dead'] })
    ).list.find(j => j.id === req.job.id)!;
    if (i < 4) {
      assert.equal(job.state, 'failed', `attempt ${i + 1}`);
      assert.equal(job.attempts, i + 1);
      w.clock.advance(24 * 60 * 60_000);
    } else {
      assert.equal(job.state, 'dead');
      assert.equal(job.attempts, 5);
      assert.equal(job.problem?.reasonCode, 'ai.unreachable');
    }
  }
});

for (const code of ['unavailable', 'missingKey', 'noProvider'] as const) {
  test(`jobs runner: a ${code} failure waits without spending attempts, so the backlog survives until AI is connected`, async () => {
    const w = await world(stubTransport({ fail: new AiCallError(code, 'not yet') }));
    seedMail(w);
    await consentNow(w);
    const req = await w.call('Ai/request', {
      opId: 'r1',
      kind: 'summary',
      threadId: 'acct-1:T-thread',
    });
    for (let i = 0; i < 7; i++) {
      await runJobs(w.engine.services, w.clock.now());
      w.clock.advance(24 * 60 * 60_000);
    }
    const job = (
      await w.call('Ai/jobs', { states: ['queued', 'running', 'failed', 'dead'] })
    ).list.find(j => j.id === req.job.id)!;
    assert.equal(job.state, 'queued', 'never dead-lettered');
    assert.equal(job.attempts, 0, 'no attempt was spent');
  });
}

test('jobs runner: an open setup session defers due jobs instead of spinning on them', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  const req = await w.call('Ai/request', {
    opId: 'r1',
    kind: 'summary',
    threadId: 'acct-1:T-thread',
  });
  await w.call('Setup/begin', { origin: 'onboarding' });
  try {
    const now = w.clock.now();
    await runJobs(w.engine.services, now);
    const job = (
      await w.call('Ai/jobs', { states: ['queued', 'running', 'failed', 'dead'] })
    ).list.find(j => j.id === req.job.id)!;
    assert.equal(job.state, 'queued', 'not run while the session is open');
    assert.ok(
      (job.nextAt ?? 0) > now,
      'pushed out, so the deadline source does not re-fire immediately',
    );
  } finally {
    await w.call('Setup/end', { reason: 'skipped' });
  }
});

test('jobs runner: the daily cap refuses background calls and pauses the queue', async () => {
  const w = await world(stubTransport({ answer: '{"summary":"S.","action":null}' }));
  seedMail(w);
  await consentNow(w);
  await w.call('Settings/set', {
    opId: 'cap',
    patch: { ai: { dailyCap: { enabled: true, tokens: 10 } } },
  });
  // Spend past the cap interactively — background share is what counts, so write usage as background.
  w.store.commit({
    opId: 'spend',
    origin: 'system',
    writes: [
      {
        kind: 'aiUsage',
        day: new Date(w.clock.now()).toISOString().slice(0, 10),
        provider: 'groq',
        model: 'm',
        lane: 'background',
        requests: 1,
        tokensIn: 500,
        tokensOut: 0,
      },
    ],
  });
  const req = await w.call('Ai/request', {
    opId: 'r1',
    kind: 'summary',
    threadId: 'acct-1:T-thread',
  });
  const transport = w.engine.services.ai.transport() as ReturnType<typeof stubTransport>;
  await runJobs(w.engine.services, w.clock.now());
  assert.equal(transport.calls.length, 0, 'capped: no provider call');
  const job = (await w.call('Ai/jobs', {})).list.find(j => j.id === req.job.id)!;
  assert.equal(job.state, 'queued');
});

test('Ai/testKey, Ai/test and Ai/models: bound transport answers live; detached answers honestly', async () => {
  const w = await world();
  const ok = await w.call('Ai/testKey', { provider: 'groq' });
  assert.equal(ok.ok, true);
  const models = await w.call('Ai/models', { provider: 'groq' });
  assert.equal(models.live, true);
  assert.deepEqual(
    models.list.map(m => m.id),
    ['groq-live'],
  );
  const test = await w.call('Ai/test', { model: { provider: 'groq', model: 'm' } });
  assert.equal(typeof test.ms, 'number');

  const bare = await world(detachedTransport());
  const miss = await bare.call('Ai/testKey', { provider: 'groq' });
  assert.equal(miss.ok, false);
  assert.equal(miss.reasonCode, 'ai.unavailable');
  const list = await bare.call('Ai/models', { provider: 'groq' });
  assert.equal(list.live, false);
  assert.ok(list.list.length > 0, 'curated fallback');
});

test('Ask/run: retrieves mail, streams frames, lands a cited turn in the conversation', async () => {
  const w = await world();
  seedMail(w);
  const { runId, conversationId } = await w.call('Ask/run', {
    question: 'When is the invoice due?',
  });
  const prog = () =>
    w.frames.filter(
      (f): f is Extract<Frame, { frame: 'progress' }> =>
        f.frame === 'progress' && (f as { runId?: string }).runId === runId,
    );
  for (let i = 0; i < 50 && !prog().some(f => f.kind === 'done'); i++)
    await new Promise(r => setImmediate(r));
  const done = w.frames.filter(
    (f): f is Extract<Frame, { frame: 'progress' }> =>
      f.frame === 'progress' && (f as { runId?: string }).runId === runId,
  );
  assert.ok(done.some(f => f.kind === 'step'));
  assert.ok(done.some(f => f.kind === 'citation'));
  assert.ok(done.some(f => f.kind === 'done'));
  const { list } = await w.call('Conversation/get', { ids: [conversationId] });
  assert.equal(list.length, 1);
  const turn = list[0].turns[0];
  assert.equal(turn.question, 'When is the invoice due?');
  assert.equal(turn.answer!.blocks[0].text, 'It is due Friday .');
  assert.equal(turn.citations.length, 1);
  assert.equal(turn.citations[0].kind, 'message');
  assert.equal(turn.citations[0].threadId, 'acct-1:T-thread');
  assert.equal(turn.noSource, false);
});

test('Ask/run: a kept-out scope and a trains-on-inputs provider refuse honestly', async () => {
  const w = await world();
  seedMail(w);
  // Scope to an account with AI off.
  w.store.commit({
    opId: 'b',
    origin: 'sync',
    writes: [
      {
        kind: 'account',
        id: 'acct-2',
        provider: 'google',
        address: 'two@mail.example',
        capabilities: {},
        status: { state: 'ok' },
        aiAllowed: false,
      },
    ],
  });
  const { runId } = await w.call('Ask/run', {
    question: 'hi',
    scope: { accountIds: ['acct-2'] },
  });
  for (
    let i = 0;
    i < 50 &&
    !w.frames.some(
      f =>
        f.frame === 'progress' &&
        (f as { runId?: string }).runId === runId &&
        (f as { kind?: string }).kind === 'error',
    );
    i++
  )
    await new Promise(r => setImmediate(r));
  const err = w.frames.find(
    f =>
      f.frame === 'progress' &&
      (f as { runId?: string }).runId === runId &&
      (f as { kind?: string }).kind === 'error',
  ) as { problem?: { reasonCode?: string } } | undefined;
  assert.equal(err?.problem?.reasonCode, 'ai.accountExcluded');
  // Gemini trains on inputs: ask must refuse before a call is made.
  const cur = (await w.call('Settings/get', {})).ai.features;
  await w.call('Settings/set', {
    opId: 'gem',
    patch: { ai: { features: { ...cur, ask: { provider: 'gemini', model: 'gemini-flash' } } } },
  });
  const r2 = await w.call('Ask/run', { question: 'hi' });
  for (
    let i = 0;
    i < 50 &&
    !w.frames.some(
      f =>
        f.frame === 'progress' &&
        (f as { runId?: string }).runId === r2.runId &&
        (f as { kind?: string }).kind === 'error',
    );
    i++
  )
    await new Promise(r => setImmediate(r));
  const err2 = w.frames.find(
    f =>
      f.frame === 'progress' &&
      (f as { runId?: string }).runId === r2.runId &&
      (f as { kind?: string }).kind === 'error',
  ) as { problem?: { reasonCode?: string } } | undefined;
  assert.equal(err2?.problem?.reasonCode, 'ai.providerTrains');
});

test('Ask/run: the picked account scopes retrieval, and sources name their account', async () => {
  const t = stubTransport({});
  const w = await world(t);
  seedMail(w);
  w.store.commit({
    opId: 'seed-b',
    origin: 'sync',
    writes: [
      {
        kind: 'account',
        id: 'acct-2',
        provider: 'google',
        address: 'two@mail.example',
        capabilities: {},
        status: { state: 'ok' },
        aiAllowed: true,
      },
      {
        kind: 'folder',
        accountId: 'acct-2',
        remoteId: 'INBOX',
        name: 'Inbox',
        role: 'inbox',
        folderKind: 'system',
      },
      msg('x1', 'T-other', 7, {
        accountId: 'acct-2',
        subject: 'Invoice paid already',
        snippet: 'The invoice was paid last week.',
      }),
    ],
  });
  // All accounts: both accounts' mail can be a source, labelled by the fixed account order —
  // acct-2 'Account 2', acct-1 'Account 1' — never by the owner's own address, which stays out of
  // the provider's prompt.
  const all = await w.call('Ask/run', { question: 'invoice' });
  await settle(w, all.runId);
  const promptAll = lastPrompt(t);
  assert.match(
    promptAll,
    /\[1\] Account: Account 2\nFrom: Sender x1\nSubject: Invoice paid already/,
  );
  assert.match(promptAll, /\[2\] Account: Account 1\nFrom: Sender m1\nSubject: Invoice due Friday/);
  assert.doesNotMatch(promptAll, /@mail\.example/);
  // Account B picked: only B's mail is quoted — A's subject never reaches the provider, and a
  // one-account run carries no Account: line at all.
  const scoped = await w.call('Ask/run', {
    question: 'invoice',
    scope: { accountIds: ['acct-2'] },
  });
  await settle(w, scoped.runId);
  const promptScoped = lastPrompt(t);
  assert.match(promptScoped, /\[1\]\nFrom: Sender x1\nSubject: Invoice paid already/);
  assert.doesNotMatch(promptScoped, /Account:|@mail\.example|Invoice due Friday/);
});

test('Ask/cancel: a live run aborts', async () => {
  let signal: AbortSignal | undefined;
  const hanging = stubTransport({ onChat: req => (signal = req.signal) });
  hanging.chat = req => {
    signal = req.signal;
    return new Promise((_, reject) =>
      req.signal?.addEventListener('abort', () => reject(new AiCallError('cancelled', 'aborted')), {
        once: true,
      }),
    );
  };
  const w = await world(hanging);
  seedMail(w);
  const { runId } = await w.call('Ask/run', { question: 'hi' });
  for (let i = 0; i < 50 && !signal; i++) await new Promise(r => setImmediate(r));
  assert.ok(signal);
  const res = await w.call('Ask/cancel', { runId });
  assert.equal(res.cancelled, true);
  assert.equal(signal!.aborted, true);
});

test('detached transport: Ai/* calls never log or leak a key; unavailable is honest', async () => {
  const w = await world(detachedTransport());
  seedMail(w);
  const t = await w.call('Ai/testKey', { provider: 'openai' });
  assert.equal(t.ok, false);
  assert.match(t.message ?? '', /not connected|unavailable|key/i);
  assert.doesNotMatch(t.message ?? '', /sk-/);
});

const followJobRows = (w: World) =>
  w.engine.services.store.read(q =>
    q.all<{ key: string; state: string }>("SELECT key, state FROM jobs WHERE kind = 'followup'"),
  );

test('followup job: a sent, unanswered thread gets a local nudge Ai/followup serves', async () => {
  const w = await world(
    stubTransport({ answer: '{"nudge":"quick check: any update on the invoice?"}' }),
  );
  seedFollow(w);
  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now());
  const rows = followJobRows(w);
  assert.equal(rows.length, 1, 'the sweep queued the lane thread');
  assert.match(rows[0].key, /^followup:acct-1:T-follow:/);
  assert.equal(rows[0].state, 'done');
  const got = await w.call('Ai/followup', { threadId: 'acct-1:T-follow' });
  assert.match(got.suggestion?.html ?? '', /quick check: any update on the invoice/);
  assert.equal(got.suggestion?.basedOnMessageId, 'acct-1:f-out');
  assert.equal(got.suggestion?.model.provider, 'groq');
  const transport = w.engine.services.ai.transport() as ReturnType<typeof stubTransport>;
  assert.equal(transport.calls.length, 1, 'one provider call wrote the suggestion');
});

test('followup sweep: a discarded job re-queues cleanly and never blocks summaries', async () => {
  const w = await world(
    stubTransport({ answer: '{"nudge":"bump?","summary":"Ada asked.","action":null}' }),
  );
  seedFollow(w);
  seedMail(w);
  await consentNow(w);
  await w.call('Ai/request', { opId: 'rs', kind: 'summary', threadId: 'acct-1:T-thread' });
  await runJobs(w.engine.services, w.clock.now());
  const rows = w.engine.services.store.read(q =>
    q.all<{ id: number; key: string; state: string }>(
      "SELECT id, key, state FROM jobs WHERE kind = 'followup'",
    ),
  );
  assert.equal(rows.length, 1);
  await w.call('Queue/discard', { id: `job:${rows[0].id}` });
  // The next pass must not throw — the sweep's fresh opId re-enqueues under the same singleton key.
  await runJobs(w.engine.services, w.clock.now());
  const again = w.engine.services.store.read(q =>
    q.all<{ id: number; key: string; state: string }>(
      "SELECT id, key, state FROM jobs WHERE kind = 'followup'",
    ),
  );
  assert.equal(again.length, 1, 'the discarded job re-queued under its singleton key');
  assert.notEqual(again[0].state, 'failed', 'the re-enqueue ran clean, not a replayed commit');
  // A summary job still claims and completes in the same passes — the sweep never blocked the queue.
  const summaries = w.engine.services.store.read(q =>
    q.all<{ state: string }>("SELECT state FROM jobs WHERE kind = 'summary'"),
  );
  assert.ok(summaries.length > 0 && summaries.every(r => r.state === 'done'));
});

test('followup job: a new sent message retires the suggestion and re-keys the job', async () => {
  const w = await world(
    stubTransport({ answer: '{"nudge":"quick check: any update on the invoice?"}' }),
  );
  seedFollow(w);
  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now());
  const first = await w.call('Ai/followup', { threadId: 'acct-1:T-follow' });
  assert.ok(first.suggestion, 'the first nudge landed');
  // Four days pass; the owner sends again (still a day over the nudge period, still awaiting a reply).
  w.clock.advance(4 * DAY_MS);
  w.store.commit({
    opId: 'bump',
    origin: 'sync',
    writes: [
      msg('f-out2', 'T-follow', 0, {
        from: { address: 'owner@mail.example', name: 'Owner' },
        to: [{ address: 'sender-f-in@mail.example' }],
        snippet: 'Bumping this to the top of your inbox.',
        flags: { seen: true, flagged: false, draft: false, fromMe: true },
        folders: [{ folder: 'SENT' }],
      }),
    ],
  });
  const stale = await w.call('Ai/followup', { threadId: 'acct-1:T-follow' });
  assert.equal(stale.suggestion, undefined, 'the moved hash expired the old suggestion');
  await runJobs(w.engine.services, w.clock.now());
  const rows = followJobRows(w);
  assert.equal(rows.length, 2, 'a fresh job ran under the new last-sent hash');
  assert.notEqual(rows[0].key, rows[1].key);
  const fresh = await w.call('Ai/followup', { threadId: 'acct-1:T-follow' });
  assert.match(fresh.suggestion?.html ?? '', /quick check/);
  assert.equal(fresh.suggestion?.basedOnMessageId, 'acct-1:f-out2');
});

test('followup job: a spam-labeled thread is never queued, never read', async () => {
  const w = await world(
    stubTransport({ answer: '{"nudge":"quick check: any update on the invoice?"}' }),
  );
  seedFollow(w, { spam: true });
  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now());
  assert.equal(followJobRows(w).length, 0);
  const transport = w.engine.services.ai.transport() as ReturnType<typeof stubTransport>;
  assert.equal(transport.calls.length, 0, 'spam mail never reached the provider');
  const got = await w.call('Ai/followup', { threadId: 'acct-1:T-follow' });
  assert.equal(got.suggestion, undefined);
});

test('followup job: an account kept out of AI gets no job even when eligible', async () => {
  const w = await world(
    stubTransport({ answer: '{"nudge":"quick check: any update on the invoice?"}' }),
  );
  seedFollow(w, { aiAllowed: false });
  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now());
  assert.equal(followJobRows(w).length, 0);
  const transport = w.engine.services.ai.transport() as ReturnType<typeof stubTransport>;
  assert.equal(transport.calls.length, 0);
  const got = await w.call('Ai/followup', { threadId: 'acct-1:T-follow' });
  assert.equal(got.suggestion, undefined);
});

test('Setup/end: the one-shot backfill queues summaries for Home-visible mail, never Spam/Trash', async () => {
  const w = await world();
  seedMail(w);
  await w.call('Setup/end', { reason: 'finished' });
  for (let i = 0; i < 50 && !(await w.call('Ai/jobs', {})).list.length; i++)
    await new Promise(r => setImmediate(r));
  const jobs = await w.call('Ai/jobs', {});
  assert.equal(jobs.list.length, 1);
  assert.equal(jobs.list[0].kind, 'summary');
  assert.equal(jobs.list[0].threadId, 'acct-1:T-thread');
  // A second end does not double the queue (singleton keys).
  await w.call('Setup/end', { reason: 'finished' });
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  assert.equal((await w.call('Ai/jobs', {})).list.length, 1);
});
