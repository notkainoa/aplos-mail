import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Frame, Input, Output } from '@aplos/contract';
import type { LogRecord } from '@aplos/contract/log/events';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import {
  AiCallError,
  type AiChatRequest,
  type AiChatTurn,
  type AiTransport,
} from '../../src/ai/host';
import { runJobs } from '../../src/ai/impl/runner';
import { queueSummary } from '../../src/ai/impl/jobs';
import { CHAT_TIMEOUT_MS, meteredChat } from '../../src/ai/impl/runtime';
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

test('a spent daily cap settles the placeholder while the job waits for tomorrow', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  await w.call('Settings/set', {
    opId: 'cap',
    patch: { ai: { dailyCap: { enabled: true, tokens: 1 } } },
  });
  // First call lands (cap opens before it, the spend records after); a re-pend then meets a spent day.
  await runJobs(w.engine.services, w.clock.now());
  assert.equal((await threadSummary(w)).state, 'ready');
  w.engine.services.store.commit({
    opId: 'reply',
    origin: 'sync',
    writes: [msg('m3', 'T-thread', 7)],
  });
  queueSummary(w.engine.services, ACCOUNT, 'T-thread');
  assert.equal((await threadSummary(w)).state, 'pending');
  await runJobs(w.engine.services, w.clock.now());
  const row = await threadSummary(w);
  assert.equal(row.state, 'stale', 'a day-long wait collapses like AI-off, keeping the older text');
  // The job itself was only deferred — tomorrow's pass still has it queued, not dead.
  assert.equal(jobsOf(w, 'summary').at(-1)!.state, 'queued');
});

test('a pending placeholder with no live job behind it settles instead of spinning', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  // The crash shape: a `pending` row whose job row is gone entirely (dead-lettered, or the enqueue lost).
  w.engine.services.store.commit({
    opId: 'orphan',
    origin: 'system',
    writes: [
      {
        kind: 'summary',
        accountId: ACCOUNT,
        remoteThreadId: 'T-thread',
        inputHash: 'no-such-job',
        model: 'groq/demo',
        text: '',
        state: 'pending',
      },
    ],
  });
  const orphan = () =>
    w.engine.services.store.read(
      q =>
        q.get<{ state: string }>("SELECT state FROM summaries WHERE input_hash = 'no-such-job'")
          ?.state,
    );
  assert.equal(orphan(), 'pending');
  await runJobs(w.engine.services, w.clock.now());
  assert.equal(orphan(), 'failed', 'nothing is coming — the card collapses');
});

test('the 120 s bound covers background jobs only — a slow interactive answer still lands', async () => {
  let resolve: ((turn: AiChatTurn) => void) | undefined;
  const slow = stubTransport({ hang: true });
  slow.chat = req => {
    // A local provider answering slowly, honestly: the stream lives until the test lets it finish.
    return new Promise(res => {
      resolve = res;
      req.signal?.addEventListener('abort', () => res({ content: 'aborted', toolCalls: [] }), {
        once: true,
      });
    });
  };
  const w = await world(slow);
  seedMail(w);
  const turn = meteredChat(
    w.engine.services,
    { feature: 'ask', model: { provider: 'groq', model: 'demo' }, lane: 'interactive' },
    { messages: [{ role: 'user', content: 'hi' }] },
  );
  await Promise.resolve();
  // Well past the bound: an interactive call has no timer armed, so nothing fires.
  w.clock.advance(CHAT_TIMEOUT_MS * 3);
  resolve!({ content: 'a slow but honest answer', toolCalls: [] });
  assert.equal((await turn).content, 'a slow but honest answer');
});
