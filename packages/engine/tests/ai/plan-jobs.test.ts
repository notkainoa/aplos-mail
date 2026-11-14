import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { detachedTransport, type AiChatRequest, type AiTransport } from '../../src/ai/host';
import { runJobs } from '../../src/ai/impl/runner';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { manualClock, silentDeadlines } from '../runtime.helpers';

function stubTransport(answer: string | string[]): AiTransport & { calls: AiChatRequest[] } {
  const calls: AiChatRequest[] = [];
  const queue = [...(Array.isArray(answer) ? answer : [answer])];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      return {
        content: queue.length > 1 ? queue.shift()! : (queue[0] ?? answer[0]!),
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

async function world(transport: AiTransport) {
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
    ports: { deadlines: silentDeadlines() },
  });
  engine.services.ai.useTransport(transport);
  const window = engine.connect();
  const call = <M extends EngineMethodName>(m: M, a: Input<M>) =>
    window.call(m, a) as Promise<Output<M>>;
  return { store, engine, call, clock, file };
}

const EVENT_ANSWER =
  '{"events":[{"title":"Garden day","start":"2026-11-14T10:00:00Z","end":"2026-11-14T11:00:00Z","allDay":false,"location":"Community garden","quote":"this Saturday at 10 am"}]}';

const seed = (w: Awaited<ReturnType<typeof world>>, spam = false) => {
  // Mail lands while the account is still kept out of AI so the ingest enqueue stays out, and seen+done keeps the
  // thread below the summary queue's Home-visible/unread bar so the Settings/set catch-up in `consentNow` queues
  // nothing either — a summary job would be legitimate but spends a scripted answer.
  w.store.commit({
    opId: 'seed',
    origin: 'sync',
    writes: [
      { ...accountWrite, aiAllowed: false },
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
        flags: { seen: true, flagged: false, draft: false, fromMe: false },
        ...(spam ? { folders: [{ folder: 'INBOX' }, { folder: 'SPAM' }] } : {}),
      }),
      {
        kind: 'workflow',
        accountId: ACCOUNT,
        remoteThreadId: 'T-plans',
        patch: { status: 'done' },
      },
    ],
  });
  w.store.commit({
    opId: 'ai-on',
    origin: 'sync',
    writes: [{ kind: 'account', id: ACCOUNT, aiAllowed: true }],
  });
};

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

test('plan job: Ai/request kind plan runs the extraction under the jobs runner', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  const req = await w.call('Ai/request', { opId: 'r1', kind: 'plan', threadId: 'acct-1:T-plans' });
  assert.equal(req.job.kind, 'plan');
  await runJobs(w.engine.services, w.clock.now());
  const got = await w.call('Plan/get', { ids: ['acct-1:plan-1'] });
  assert.equal(got.list[0]?.title, 'Garden day');
  assert.equal(t.calls.length, 1);
  w.file.cleanup();
});

test('jobs runner: an unbound transport leaves the plan job queued (release, no dead-letter)', async () => {
  const w = await world(detachedTransport());
  seed(w);
  await consentNow(w);
  const req = await w.call('Ai/request', { opId: 'r1', kind: 'plan', threadId: 'acct-1:T-plans' });
  for (let i = 0; i < 3; i++) await runJobs(w.engine.services, w.clock.now());
  const job = (
    await w.call('Ai/jobs', { states: ['queued', 'running', 'failed', 'dead'] })
  ).list.find(j => j.id === req.job.id)!;
  assert.equal(job.state, 'queued');
  assert.equal(job.attempts, 0);
  w.file.cleanup();
});

test('Ai/request: a summary job never swallows a plan or suggestAction request (per-kind keys)', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  await w.call('Ai/request', {
    opId: 's1',
    kind: 'summary',
    threadId: 'acct-1:T-plans',
  });
  await w.call('Ai/request', { opId: 'p1', kind: 'plan', threadId: 'acct-1:T-plans' });
  await w.call('Ai/request', {
    opId: 'a1',
    kind: 'suggestAction',
    threadId: 'acct-1:T-plans',
  });
  const rows = w.engine.services.store.read(q =>
    q.all<{ kind: string; key: string }>(
      "SELECT kind, key FROM jobs WHERE kind != 'wake' ORDER BY id",
    ),
  );
  assert.deepEqual(
    rows.map(r => r.kind).sort(),
    ['plan', 'suggestAction', 'summary'],
    'each kind owns its singleton key',
  );
  assert.deepEqual(
    new Set(rows.map(r => r.key)).size,
    3,
    'summary, plan and suggestAction keys are distinct',
  );
  w.file.cleanup();
});

test('jobs runner: a broken Summaries provider never blocks Plans work (per-feature gate)', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w);
  // Gemini trains on inputs → the summaries feature gate refuses; plans stays on Groq.
  const cur = (await w.call('Settings/get', {})).ai.features;
  await w.call('Settings/set', {
    opId: 'feat',
    patch: {
      ai: {
        features: {
          ...cur,
          summaries: { provider: 'gemini', model: 'gemini-flash' },
          plans: { provider: 'groq', model: 'openai/gpt-oss-120b' },
        },
      },
    },
  });
  await consentNow(w);
  await w.call('Ai/request', {
    opId: 's1',
    kind: 'summary',
    threadId: 'acct-1:T-plans',
  });
  await w.call('Ai/request', { opId: 'p1', kind: 'plan', threadId: 'acct-1:T-plans' });
  // The `jobs` deadline also fires on the request commits — its runner may claim a row mid-pass, so drain
  // until both jobs settle instead of assuming our own runJobs owned the claim.
  let jobs: { kind: string; state: string }[] = [];
  for (let i = 0; i < 6; i++) {
    await runJobs(w.engine.services, w.clock.now());
    jobs = w.engine.services.store.read(q =>
      q.all<{ kind: string; state: string }>('SELECT kind, state FROM jobs'),
    );
    if (!jobs.some(j => j.state === 'running')) break;
    await new Promise(r => setTimeout(r, 0));
  }
  const sumJob = jobs.find(j => j.kind === 'summary')!;
  const planJob = jobs.find(j => j.kind === 'plan')!;
  assert.equal(planJob.state, 'done', 'the open Plans gate let the job run');
  assert.equal(sumJob.state, 'queued', 'the closed Summaries gate deferred its own job');
  const got = await w.call('Plan/get', { ids: ['acct-1:plan-1'] });
  assert.equal(got.list[0]?.title, 'Garden day');
  w.file.cleanup();
});

test('suggestAction job: waits for an in-flight summary, then drafts a reply suggestion', async () => {
  const SUMMARY_REPLY =
    '{"summary":"They asked a question.","action":{"kind":"reply","label":"Reply"}}';
  const DRAFT = '{"draft":"Here is the reply you wanted."}';
  const t = stubTransport([SUMMARY_REPLY, DRAFT]);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  await w.call('Ai/request', {
    opId: 'a1',
    kind: 'suggestAction',
    threadId: 'acct-1:T-plans',
  });
  await w.call('Ai/request', {
    opId: 's1',
    kind: 'summary',
    threadId: 'acct-1:T-plans',
  });
  // The deadline source may drain a due job between awaits; run until the suggestion exists or the
  // job is proven done — the draft call only happens after the summary lands (the deferral).
  for (let i = 0; i < 4; i++) {
    await runJobs(w.engine.services, w.clock.now());
    const draft = w.engine.services.store.read(q =>
      q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'replydraft:acct-1:T-plans'),
    );
    if (draft) break;
    w.clock.advance(31 * 60_000);
  }
  const done = w.engine.services.store.read(q =>
    q.get<{ state: string }>('SELECT state FROM jobs WHERE kind = ?', 'suggestAction'),
  )!;
  assert.equal(done.state, 'done');
  const draft = w.engine.services.store.read(q =>
    q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'replydraft:acct-1:T-plans'),
  );
  assert.match(draft?.value ?? '', /Here is the reply/);
  assert.equal(t.calls.length, 2, 'one summary call, one draft call');
  w.file.cleanup();
});

test('suggestAction job: no summary and none coming settles done with no provider call', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  await w.call('Ai/request', {
    opId: 'a1',
    kind: 'suggestAction',
    threadId: 'acct-1:T-plans',
  });
  await runJobs(w.engine.services, w.clock.now());
  const job = w.engine.services.store.read(q =>
    q.get<{ state: string }>('SELECT state FROM jobs WHERE kind = ?', 'suggestAction'),
  )!;
  assert.equal(job.state, 'done');
  assert.equal(t.calls.length, 0);
  w.file.cleanup();
});

test('plan job: the owner zone reaches the prompt; the job shares the in-flight extraction', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  (w.engine.services.views as { zone: string }).zone = 'Europe/Oslo';
  await w.call('Ai/request', { opId: 'r1', kind: 'plan', threadId: 'acct-1:T-plans' });
  // The job and an interactive extract of the same input share one provider call (the in-flight guard).
  const ext = w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  await Promise.all([runJobs(w.engine.services, w.clock.now()), ext]);
  assert.equal(t.calls.length, 1, 'job and extract together spend one provider call');
  const prompt = JSON.stringify(t.calls[0].messages.map(m => m.content));
  assert.match(prompt, /Europe\/Oslo/, 'the owner zone goes to the model, not UTC');
  w.file.cleanup();
});

test('suggestAction job: mail that moved since the request means no draft call', async () => {
  const SUMMARY_REPLY =
    '{"summary":"They asked a question.","action":{"kind":"reply","label":"Reply"}}';
  // The new message legitimately re-queues a summary under the new hash — a second summary call runs;
  // the draft answer stays unconsumed.
  const t = stubTransport([SUMMARY_REPLY, SUMMARY_REPLY, '{"draft":"unused"}']);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  await w.call('Ai/request', {
    opId: 'a1',
    kind: 'suggestAction',
    threadId: 'acct-1:T-plans',
  });
  await w.call('Ai/request', { opId: 's1', kind: 'summary', threadId: 'acct-1:T-plans' });
  await runJobs(w.engine.services, w.clock.now());
  // The reply summary landed, but the thread moved before the suggestAction run — the stored input hash
  // no longer matches, so the job must not draft against stale mail.
  w.store.commit({
    opId: 'm2',
    origin: 'sync',
    writes: [
      msg('m2', 'T-plans', 6, { subject: 'Re: Garden day', snippet: 'and bring tools Sunday' }),
    ],
  });
  // The job was deferred while the summary was in flight — advance past the pause so it really runs
  // (without this the job is simply not due and the test proves nothing).
  w.clock.advance(31 * 60_000);
  await runJobs(w.engine.services, w.clock.now());
  const job = w.engine.services.store.read(q =>
    q.get<{ state: string }>('SELECT state FROM jobs WHERE kind = ?', 'suggestAction'),
  )!;
  assert.equal(job.state, 'done', 'the job ran and settled — the stale-mail return did its work');
  const draft = w.engine.services.store.read(q =>
    q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'replydraft:acct-1:T-plans'),
  );
  assert.equal(draft, undefined, 'no draft was written for stale mail');
  assert.equal(
    t.calls.length,
    2,
    'two summary calls — the new input re-summarized; no draft call ran',
  );
  w.file.cleanup();
});

test('plan job: a recorded empty answer for this input skips the model; plans for the hash settle early', async () => {
  const t = stubTransport('{"events":[]}');
  const w = await world(t);
  seed(w);
  await consentNow(w);
  await w.call('Ai/request', { opId: 'r1', kind: 'plan', threadId: 'acct-1:T-plans' });
  await runJobs(w.engine.services, w.clock.now());
  assert.equal(t.calls.length, 1, 'the job asked the model once');
  const marker = w.engine.services.store.read(q =>
    q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'plans-empty:acct-1:T-plans'),
  );
  assert.ok(marker?.value, 'the empty answer is recorded for this input hash');
  // A forced rerun reads the marker and settles without a second model call. The jobs deadline may
  // claim the row mid-pass, so drain until no runner holds it.
  await w.call('Ai/request', {
    opId: 'r2',
    kind: 'plan',
    threadId: 'acct-1:T-plans',
    force: true,
  });
  let state = '';
  for (let i = 0; i < 6; i++) {
    await runJobs(w.engine.services, w.clock.now());
    state = w.engine.services.store.read(q =>
      q.get<{ state: string }>("SELECT state FROM jobs WHERE kind = 'plan'"),
    )!.state;
    if (state !== 'running') break;
    await new Promise(r => setTimeout(r, 0));
  }
  assert.equal(t.calls.length, 1, 'the recorded empty answer skips the provider');
  assert.equal(state, 'done');
  w.file.cleanup();
});

test('plan job: plans already stored for this input hash settle the job with no provider call', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  await w.call('Ai/request', { opId: 'r1', kind: 'plan', threadId: 'acct-1:T-plans' });
  // Another writer landed a set for the job's input hash before it ran (an interactive extract).
  const hash = w.engine.services.store.read(q => {
    const p = q.get<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'plan'")!;
    return (JSON.parse(p.payload) as { inputHash: string }).inputHash;
  });
  w.store.commit({
    opId: 'ext-put',
    origin: 'system',
    writes: [
      {
        kind: 'plan',
        action: 'put',
        accountId: 'acct-1',
        remoteThreadId: 'T-plans',
        inputHash: hash,
        title: 'Garden day',
        startUtc: 1,
        endUtc: 2,
        allDay: false,
        model: 'test/stub',
      } as never,
    ],
  });
  await runJobs(w.engine.services, w.clock.now());
  const job = w.engine.services.store.read(q =>
    q.get<{ state: string }>("SELECT state FROM jobs WHERE kind = 'plan'"),
  )!;
  assert.equal(job.state, 'done');
  assert.equal(t.calls.length, 0, 'existing plans for the hash mean no model call');
  w.file.cleanup();
});

test('plan job: an empty answer records THIS hash even when an older open plan exists', async () => {
  const t = stubTransport('{"events":[]}');
  const w = await world(t);
  seed(w);
  await consentNow(w);
  // An open proposal from an older input — the job's own extraction list is never empty, so only the
  // model's answer for THIS hash (`x.plans.length`) can decide whether the marker is written.
  w.store.commit({
    opId: 'old-plan',
    origin: 'system',
    writes: [
      {
        kind: 'plan',
        action: 'put',
        accountId: 'acct-1',
        remoteThreadId: 'T-plans',
        inputHash: 'older-input',
        title: 'Older',
        startUtc: 1,
        endUtc: 2,
        allDay: false,
        model: 'test/stub',
      } as never,
    ],
  });
  await w.call('Ai/request', { opId: 'r1', kind: 'plan', threadId: 'acct-1:T-plans' });
  await runJobs(w.engine.services, w.clock.now());
  assert.equal(t.calls.length, 1, 'the job asked the model once');
  const hash = w.engine.services.store.read(q => {
    const p = q.get<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'plan'")!;
    return (JSON.parse(p.payload) as { inputHash: string }).inputHash;
  });
  const marker = w.engine.services.store.read(q =>
    q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'plans-empty:acct-1:T-plans'),
  );
  assert.equal(marker?.value, hash, 'the empty answer is recorded under THIS input hash');
  // A forced rerun reads the marker and never calls the model again.
  await w.call('Ai/request', {
    opId: 'r2',
    kind: 'plan',
    threadId: 'acct-1:T-plans',
    force: true,
  });
  for (let i = 0; i < 6; i++) {
    await runJobs(w.engine.services, w.clock.now());
    const state = w.engine.services.store.read(q =>
      q.get<{ state: string }>("SELECT state FROM jobs WHERE kind = 'plan'"),
    )!.state;
    if (state !== 'running') break;
    await new Promise(r => setTimeout(r, 0));
  }
  assert.equal(t.calls.length, 1, 'the recorded empty answer for this hash skips the provider');
  w.file.cleanup();
});
