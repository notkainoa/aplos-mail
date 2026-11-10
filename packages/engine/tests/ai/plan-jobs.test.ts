import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { detachedTransport, type AiChatRequest, type AiTransport } from '../../src/ai/host';
import { runJobs } from '../../src/ai/impl/runner';
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
  const plan = await w.call('Ai/request', { opId: 'p1', kind: 'plan', threadId: 'acct-1:T-plans' });
  const sug = await w.call('Ai/request', {
    opId: 'a1',
    kind: 'suggestAction',
    threadId: 'acct-1:T-plans',
  });
  const rows = w.engine.services.store.read(q =>
    q.all<{ kind: string; key: string }>('SELECT kind, key FROM jobs ORDER BY id'),
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
  assert.notEqual(plan.job.id, sug.job.id);
  assert.equal(sug.job.kind, 'suggestAction');
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
  const plan = await w.call('Ai/request', { opId: 'p1', kind: 'plan', threadId: 'acct-1:T-plans' });
  await runJobs(w.engine.services, w.clock.now());
  const jobs = (
    await w.call('Ai/jobs', { states: ['queued', 'running', 'failed', 'dead', 'done'] })
  ).list;
  const sumJob = jobs.find(j => j.kind === 'summary')!;
  const planJob = jobs.find(j => j.id === plan.job.id)!;
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
  const sug = await w.call('Ai/request', {
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
  const done = (
    await w.call('Ai/jobs', { states: ['queued', 'running', 'failed', 'dead', 'done'] })
  ).list.find(j => j.id === sug.job.id)!;
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
  const sug = await w.call('Ai/request', {
    opId: 'a1',
    kind: 'suggestAction',
    threadId: 'acct-1:T-plans',
  });
  await runJobs(w.engine.services, w.clock.now());
  const job = (
    await w.call('Ai/jobs', { states: ['queued', 'running', 'failed', 'dead', 'done'] })
  ).list.find(j => j.id === sug.job.id)!;
  assert.equal(job.state, 'done');
  assert.equal(t.calls.length, 0);
  w.file.cleanup();
});
