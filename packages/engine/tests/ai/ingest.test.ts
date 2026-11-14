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
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { manualClock, silentDeadlines } from '../runtime.helpers';

/**
 * The ingest enqueue path (`aiWritesExtension.ingest` → `ai/impl/jobs.ts#queueSummary`): a commit that stores
 * mail drops a `wake` sentinel the `jobs` runner turns into a `summary` job — no `Ai/request`, no `Setup/end`
 * needed — and `ThreadRow.summary` tells the card states: 'pending' while the work is live, 'ready' once it
 * lands, 'none' when nothing ever queued (collapsed). A fake transport stands in for the provider; nothing here
 * touches the network.
 */

function stubTransport(opts: {
  answer?: string;
  fail?: Error;
  onChat?: (req: AiChatRequest) => void;
}): AiTransport & { calls: AiChatRequest[] } {
  const calls: AiChatRequest[] = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      opts.onChat?.(req);
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
  // A recording, never-firing deadline registry: asserts the commit→wake poke while `runJobs` calls stay explicit.
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

// Commits through `services.store` — the observed wrapper — like the real sync lane: the raw store would
// write the job but skip the `AiJob`-change poke that wakes the `jobs` deadline.
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
    q.all<{ kind: string; key: string; state: string }>(
      `SELECT kind, key, state FROM jobs${kind ? ' WHERE kind = ?' : ''} ORDER BY id`,
      ...(kind ? [kind] : []),
    ),
  );

const threadSummary = async (
  w: Awaited<ReturnType<typeof world>>,
  remoteId = 'T-thread',
  accountId = ACCOUNT,
) => (await w.call('Thread/get', { ids: [`${accountId}:${remoteId}`] })).list[0].summary;

test('sync ingest queues work for the thread; the run lands ready', async () => {
  const transport = stubTransport({});
  const w = await world(transport);
  seedMail(w);
  // No Ai/request, no Setup/end: the commit dropped the ingest sentinel, and the AiJob change row woke the
  // `jobs` deadline (recorded — a real loop would fire on it). The sentinel becomes the summary job in the run.
  const wakes = jobsOf(w, 'wake');
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].key, `ingest:${ACCOUNT}:T-thread`);
  assert.equal(wakes[0].state, 'queued');
  assert.ok(w.deadlines.told.includes('jobs'));
  // The gate is still closed (no consent), so the row reads 'none', never a fake 'pending'.
  assert.equal((await threadSummary(w)).state, 'none');
  await consentNow(w);
  // With the gate open, the eligibility pass leaves the pending placeholder the card shows.
  queueSummary(w.engine.services, ACCOUNT, 'T-thread');
  assert.equal((await threadSummary(w)).state, 'pending');
  await runJobs(w.engine.services, w.clock.now());
  const row = await threadSummary(w);
  assert.equal(row.state, 'ready');
  assert.equal(row.text, 'Ada asked about the invoice.');
  assert.equal(transport.calls.length, 1);
  // The sentinel fired and is gone (wake rows delete, never accumulate); the summary job ran and the done
  // event is logged — the pipeline is no longer silent.
  assert.equal(jobsOf(w, 'wake').filter(j => j.key.startsWith('ingest:')).length, 0);
  assert.equal(jobsOf(w, 'summary')[0].state, 'done');
  assert.ok(w.lines.some(l => l.event === 'ai.job.done'));
});

test('a new reply re-queues under the new input hash and the old text rides the pending row', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now());
  assert.equal((await threadSummary(w)).state, 'ready');
  // A reply lands: the fixed-key sentinel re-arms, and the eligibility pass writes a 'pending' placeholder
  // that keeps the prior summary's text visible until the re-run lands.
  w.engine.services.store.commit({
    opId: 'reply',
    origin: 'sync',
    writes: [msg('m3', 'T-thread', 7, { snippet: 'One more question about Friday.' })],
  });
  const wake = jobsOf(w, 'wake').find(j => j.key === `ingest:${ACCOUNT}:T-thread`);
  assert.equal(wake?.state, 'queued');
  queueSummary(w.engine.services, ACCOUNT, 'T-thread');
  const pending = await threadSummary(w);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.text, 'Ada asked about the invoice.');
  await runJobs(w.engine.services, w.clock.now());
  assert.equal((await threadSummary(w)).state, 'ready');
});

test('a kept-out account and a Spam thread never produce summary work', async () => {
  const w = await world(stubTransport({}));
  // Account kept out of AI: the sentinel is written but the lazy eligibility check refuses everything.
  seedMail(w, false);
  // A Spam-only thread on a second, allowed account: same refusal from `priorityOf`.
  w.engine.services.store.commit({
    opId: 'spam',
    origin: 'sync',
    writes: [
      { ...accountWrite, id: 'acct-2', aiAllowed: true },
      {
        kind: 'folder',
        accountId: 'acct-2',
        remoteId: 'SPAM',
        name: 'Spam',
        role: 'spam',
        folderKind: 'system',
      },
      msg('s1', 'T-spam', 8, { accountId: 'acct-2', folders: [{ folder: 'SPAM' }] }),
    ],
  });
  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now());
  assert.deepEqual(jobsOf(w, 'summary'), []);
  // 'none' is the collapsed state the card reads for both.
  assert.equal((await threadSummary(w)).state, 'none');
  assert.equal((await threadSummary(w, 'T-spam', 'acct-2')).state, 'none');
});

test('a provider that is not connected keeps the job pending and logs nothing but the truth', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  // Detach the transport: the job releases without burning attempts, stays queued = 'pending', not 'failed'.
  w.engine.services.ai.useTransport(stubTransport({ fail: new AiCallError('missingKey', 'x') }));
  await runJobs(w.engine.services, w.clock.now());
  assert.equal(jobsOf(w, 'summary')[0].state, 'queued');
  assert.equal((await threadSummary(w)).state, 'pending');
  assert.ok(!w.lines.some(l => l.event === 'ai.job.failed'));
});
