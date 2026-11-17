import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Frame, Input, Output } from '@aplos/contract';
import type { LogRecord } from '@aplos/contract/log/events';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { AiCallError, type AiChatRequest, type AiTransport } from '../../src/ai/host';
import { runJobs } from '../../src/ai/impl/runner';
import { queueSummary } from '../../src/ai/impl/jobs';
import { CHAT_TIMEOUT_MS, LONG_CHAT_TIMEOUT_MS, meteredChat } from '../../src/ai/impl/runtime';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { manualClock, silentDeadlines } from '../runtime.helpers';

/**
 * The queue's liveness rules (owner rule, hands-on 2026-11-16): a card shows "Summarizing…" while work is
 * live, and the space collapses only when AI is off or the request genuinely fails — so a provider call that
 * stalls forever must fail the job instead of holding the whole `jobs` source open, a gate-off pass settles
 * every `pending` placeholder, and a transient failure leaves a non-secret reason in the log.
 */

function stubTransport(opts: {
  answer?: string;
  fail?: Error;
  hang?: boolean;
}): AiTransport & { calls: AiChatRequest[] } {
  const calls: AiChatRequest[] = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      if (opts.hang)
        // The stall the transport is allowed to produce: the signal is honoured but never settled.
        await new Promise<void>((_, reject) => {
          req.signal?.addEventListener('abort', () => reject(new AiCallError('cancelled', 'x')), {
            once: true,
          });
        });
      if (opts.fail) throw opts.fail;
      return {
        content: opts.answer ?? '{"summary":"Ada asked about the invoice.","action":null}',
        toolCalls: [],
        usage: { prompt: 42, completion: 21 },
      };
    },
    transcribe: () => Promise.resolve({ text: 'words' }),
    models: provider => Promise.resolve({ list: [`${provider}-live`], live: true }),
    check: () => Promise.resolve(),
    setKey: () => Promise.resolve('keychain' as const),
    removeKey: () => Promise.resolve('none' as const),
    keySource: () => 'env' as const,
  };
}

async function world(transport?: AiTransport) {
  const file = tempDb();
  const clock = manualClock();
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  const lines: LogRecord[] = [];
  const log = createLogger({
    sink: { write: r => void lines.push(r) },
    salt: 's',
    clock,
    level: 'debug',
  });
  const deadlines = silentDeadlines();
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
    ports: { deadlines },
  });
  engine.services.ai.useTransport(transport ?? stubTransport({}));
  const window = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    window.call(method, args) as Promise<Output<M>>;
  const frames: Frame[] = [];
  window.subscribe(f => void frames.push(f));
  return { store, engine, call, frames, lines, deadlines, clock, file };
}

const seedMail = (w: Awaited<ReturnType<typeof world>>, aiAllowed = true) =>
  w.engine.services.store.commit({
    opId: 'seed',
    origin: 'sync',
    writes: [
      { ...accountWrite, aiAllowed },
      ...folderWrites.map(f => ({ ...f })),
      msg('m1', 'T-thread', 5, {
        subject: 'Invoice due Friday',
        snippet: 'The invoice is due this Friday.',
      }),
      msg('m2', 'T-thread', 6),
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

const jobsOf = (w: Awaited<ReturnType<typeof world>>, kind?: string) =>
  w.engine.services.store.read(q =>
    q.all<{ kind: string; key: string; state: string; last_error: string | null }>(
      `SELECT kind, key, state, last_error FROM jobs${kind ? ' WHERE kind = ?' : ''} ORDER BY id`,
      ...(kind ? [kind] : []),
    ),
  );

const threadSummary = async (
  w: Awaited<ReturnType<typeof world>>,
  remoteId = 'T-thread',
  accountId = ACCOUNT,
) => (await w.call('Thread/get', { ids: [`${accountId}:${remoteId}`] })).list[0].summary;

test('a stalled provider call times the job out and the queue keeps draining', async () => {
  const w = await world(stubTransport({ hang: true }));
  seedMail(w);
  await consentNow(w);
  queueSummary(w.engine.services, ACCOUNT, 'T-thread');
  const run = runJobs(w.engine.services, w.clock.now());
  // The call never settles on its own: the metered bound fires, not the transport.
  w.clock.advance(CHAT_TIMEOUT_MS);
  await run;
  const job = jobsOf(w, 'summary')[0];
  assert.equal(job.state, 'failed', 'a timeout is a retryable failure, not a stall');
  assert.match(job.last_error ?? '', /ai\.timeout/);
  // The non-secret reason reached the log: 'unreachable' classed, 'ai.timeout' recorded, attempt stamped.
  const line = w.lines.find(l => l.event === 'ai.job.failed');
  assert.ok(line, 'a failed attempt logs — the card collapse is never silent');
  assert.equal(line!.data.attempt, 1);
  // The placeholder stays: retryable work is still coming.
  assert.equal((await threadSummary(w)).state, 'pending');
  // After the backoff the same queue takes the job again — a recovered provider lands the summary.
  w.engine.services.ai.useTransport(stubTransport({}));
  w.clock.advance(61_000);
  await runJobs(w.engine.services, w.clock.now());
  assert.equal(jobsOf(w, 'summary')[0].state, 'done');
  assert.equal((await threadSummary(w)).state, 'ready');
});

test('AI switched off collapses every pending placeholder instead of parking it', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  queueSummary(w.engine.services, ACCOUNT, 'T-thread');
  assert.equal((await threadSummary(w)).state, 'pending');
  // The owner turns background AI off: the gate is closed for every due feature, so the pass pauses — and
  // the placeholder settles to 'failed' rather than showing "Summarizing…" for as long as AI stays off.
  await w.call('Settings/set', { opId: 'off', patch: { ai: { background: false } } });
  await runJobs(w.engine.services, w.clock.now());
  assert.equal((await threadSummary(w)).state, 'failed');
});

test('the metered bound is a literal 120 s, aborts the transport signal, and retires its own timer', async () => {
  assert.equal(
    CHAT_TIMEOUT_MS,
    120_000,
    'the background bound is the literal 120 s the stall test relies on',
  );
  const transport = stubTransport({ hang: true });
  const w = await world(transport);
  seedMail(w);
  await consentNow(w);
  const base = w.clock.pending();
  const hanging = meteredChat(
    w.engine.services,
    { feature: 'summaries', model: { provider: 'groq', model: 'm' }, lane: 'background' },
    { messages: [{ role: 'user', content: 'sum' }] },
  );
  assert.equal(
    w.clock.pending(),
    base + 1,
    'exactly one timer — the bound — arms behind an open call',
  );
  w.clock.advance(CHAT_TIMEOUT_MS);
  await assert.rejects(hanging, (e: unknown) => (e as AiCallError).code === 'unreachable');
  // The abort reached the transport's own signal, and the engine's timer retired with the call — nothing
  // stays armed (the advance may have fired timers the engine itself armed, so only the bound's +1 matters).
  assert.ok(transport.calls[0].signal?.aborted, 'the timed-out call aborts its transport signal');
  assert.ok(w.clock.pending() <= base, 'the bound retires instead of leaking a timer');
});

test('a call that settles before the bound retires the timer — nothing stays armed', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  const base = w.clock.pending();
  const turn = await meteredChat(
    w.engine.services,
    { feature: 'summaries', model: { provider: 'groq', model: 'm' }, lane: 'background' },
    { messages: [{ role: 'user', content: 'sum' }] },
  );
  assert.ok(turn.content);
  assert.equal(w.clock.pending(), base, 'a landed call leaves no bound timer behind');
});

test('interactive calls and local providers run on the longer bound', async () => {
  const transport = stubTransport({ hang: true });
  const w = await world(transport);
  const flush = () => new Promise<void>(r => setTimeout(r, 0));
  const hanging = (call: Parameters<typeof meteredChat>[1]) => {
    const p = meteredChat(w.engine.services, call, { messages: [{ role: 'user', content: 'x' }] });
    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true),
    );
    return { p, settled: () => settled };
  };
  // An interactive call is not cut at 120 s: the owner watches it stream and can cancel it.
  const ask = hanging({
    feature: 'ask',
    model: { provider: 'groq', model: 'm' },
    lane: 'interactive',
  });
  w.clock.advance(CHAT_TIMEOUT_MS);
  await flush();
  assert.equal(ask.settled(), false, 'an interactive call outlives the background bound');
  w.clock.advance(LONG_CHAT_TIMEOUT_MS - CHAT_TIMEOUT_MS);
  await assert.rejects(ask.p, (e: unknown) => (e as AiCallError).code === 'unreachable');
  // A local provider on the background lane gets the same leash — a slow local model must get to finish.
  const local = hanging({
    feature: 'summaries',
    model: { provider: 'ollama', model: 'm' },
    lane: 'background',
  });
  w.clock.advance(CHAT_TIMEOUT_MS);
  await flush();
  assert.equal(local.settled(), false, 'a local provider outlives the remote bound');
  w.clock.advance(LONG_CHAT_TIMEOUT_MS - CHAT_TIMEOUT_MS);
  await assert.rejects(local.p, (e: unknown) => (e as AiCallError).code === 'unreachable');
});

test('a dailyLimit release settles the placeholder — the card does not spin for the rest of the day', async () => {
  const w = await world(stubTransport({ fail: new AiCallError('dailyLimit', 'cap') }));
  seedMail(w);
  await consentNow(w);
  queueSummary(w.engine.services, ACCOUNT, 'T-thread');
  await runJobs(w.engine.services, w.clock.now());
  // The job keeps its queue slot for tomorrow, but the card's "nothing is coming" is already true.
  assert.equal(jobsOf(w, 'summary')[0].state, 'queued');
  assert.equal((await threadSummary(w)).state, 'failed');
});

test('the daily-cap pause settles every held placeholder', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  w.engine.services.store.commit({
    opId: 'seed2',
    origin: 'sync',
    writes: [msg('m3', 'T-two', 7, { subject: 'Second thread' })],
  });
  await consentNow(w);
  // A cap the first summary's recorded usage puts the day over: T-thread's job runs, the catch-up armed by
  // the settings patch queues T-two, and the spent budget then holds that work past the card's patience.
  await w.call('Settings/set', {
    opId: 'cap',
    patch: { ai: { dailyCap: { enabled: true, tokens: 1 } } },
  });
  queueSummary(w.engine.services, ACCOUNT, 'T-thread');
  await runJobs(w.engine.services, w.clock.now());
  assert.equal((await threadSummary(w)).state, 'ready');
  assert.equal((await threadSummary(w, 'T-two')).state, 'failed');
  const job = jobsOf(w, 'summary').find(j => j.key.includes('T-two'))!;
  assert.equal(job.state, 'queued', 'the job waits for tomorrow — only the placeholder collapsed');
});

test('a spent cap settles a held placeholder backlog past one sweep', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  // 255 pendings — past the 200-row sweep bound — across five threads; every one must collapse, not
  // just the oldest 200 (the pause that force-closes may not fire again until tomorrow).
  const writes = ['T-a', 'T-b', 'T-c', 'T-d', 'T-e'].flatMap(remoteId =>
    Array.from({ length: 51 }, (_, i) => ({
      kind: 'summary' as const,
      accountId: ACCOUNT,
      remoteThreadId: remoteId,
      inputHash: `orphan-${i}`,
      model: 'openai/gpt-oss-120b',
      text: '',
      action: null,
      state: 'pending' as const,
    })),
  );
  w.engine.services.store.commit({
    opId: 'backlog',
    origin: 'sync',
    writes: ['T-a', 'T-b', 'T-c', 'T-d', 'T-e'].map((t, i) => msg(`bm${i}`, t, 8 + i)),
  });
  w.engine.services.store.commit({ opId: 'pendings', origin: 'system', writes });
  // A spent day: the next pass pauses the queue instead of running the seeded work.
  w.engine.services.store.commit({
    opId: 'spent',
    origin: 'system',
    writes: [
      {
        kind: 'aiUsage',
        day: new Date(w.clock.now()).toISOString().slice(0, 10),
        provider: 'groq',
        model: 'm',
        lane: 'background',
        requests: 1,
        tokensIn: 150_000,
        tokensOut: 1,
      },
    ],
  });
  await runJobs(w.engine.services, w.clock.now());
  const left = w.engine.services.store.read(q =>
    q.get<{ c: number }>("SELECT count(*) AS c FROM summaries WHERE state = 'pending'"),
  );
  assert.equal(
    left?.c,
    0,
    'every held placeholder settles — no spinning card past the sweep bound',
  );
});

test('an open setup session settles held placeholders while it pauses the queue', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  queueSummary(w.engine.services, ACCOUNT, 'T-thread');
  assert.equal((await threadSummary(w)).state, 'pending');
  const { setupId } = await w.call('Setup/begin', { origin: 'onboarding' });
  try {
    await runJobs(w.engine.services, w.clock.now());
    assert.equal((await threadSummary(w)).state, 'failed');
    assert.equal(jobsOf(w, 'summary')[0].state, 'queued', 'the job waits out the session');
  } finally {
    // The session flag is module-global — every other test's runJobs must see it closed.
    await w.call('Setup/end', { setupId, reason: 'closed' });
  }
});

test('a pending placeholder with no live job behind it settles on the next pass', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  // A placeholder whose job row vanished — an older version's row, a deleted job — must not pin the card.
  w.engine.services.store.commit({
    opId: 'orphan',
    origin: 'system',
    writes: [
      {
        kind: 'summary',
        accountId: ACCOUNT,
        remoteThreadId: 'T-thread',
        inputHash: 'lost',
        model: 'openai/gpt-oss-120b',
        text: '',
        action: null,
        state: 'pending',
      },
    ],
  });
  await runJobs(w.engine.services, w.clock.now());
  // The orphaned row settled; the live pipeline's own summary for the thread still landed.
  const row = w.engine.services.store.read(q =>
    q.get<{ state: string }>(
      `SELECT s.state FROM summaries s JOIN threads t ON t.id = s.thread_id
       WHERE t.remote_id = ? AND s.input_hash = ?`,
      'T-thread',
      'lost',
    ),
  );
  assert.equal(row?.state, 'failed');
});

test('a classify job that dies settles the placeholder like a summary job', async () => {
  const w = await world(stubTransport({ fail: new AiCallError('gatePermanent', 'off') }));
  seedMail(w);
  await consentNow(w);
  // `classify` shares the summary singleton key: Ai/request parks the job, queueSummary arms the card.
  await w.call('Ai/request', { opId: 'r', kind: 'classify', threadId: `${ACCOUNT}:T-thread` });
  queueSummary(w.engine.services, ACCOUNT, 'T-thread');
  assert.equal(jobsOf(w, 'classify').length, 1);
  assert.equal((await threadSummary(w)).state, 'pending');
  await runJobs(w.engine.services, w.clock.now());
  assert.equal(jobsOf(w, 'classify')[0].state, 'skipped');
  assert.equal((await threadSummary(w)).state, 'failed');
});

test('a pending placeholder with older text goes stale, not empty, when AI is switched off', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now());
  assert.equal((await threadSummary(w)).state, 'ready');
  // New mail re-pends the thread under a new input hash, carrying the older summary's text.
  w.engine.services.store.commit({
    opId: 'reply',
    origin: 'sync',
    writes: [msg('m3', 'T-thread', 7, { snippet: 'One more question about Friday.' })],
  });
  queueSummary(w.engine.services, ACCOUNT, 'T-thread');
  assert.equal((await threadSummary(w)).state, 'pending');
  await w.call('Settings/set', { opId: 'off', patch: { ai: { background: false } } });
  await runJobs(w.engine.services, w.clock.now());
  const row = await threadSummary(w);
  assert.equal(row.state, 'stale');
  assert.equal(row.text, 'Ada asked about the invoice.');
});
