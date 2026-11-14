import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Frame, Input, Output } from '@aplos/contract';
import type { LogRecord } from '@aplos/contract/log/events';
import { openSqlite } from '../../../../apps/desktop/src/host/sqlite';
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
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { manualClock, silentDeadlines } from '../runtime.helpers';

/**
 * Queue recovery (the review of the ingest enqueue): a `summary` job that dies, is skipped or finishes must not
 * wedge the queue — a `pending` placeholder only exists while live work does, a failed re-run keeps the older
 * `ready` text as `stale`, bulk sync steps arm no per-message sentinels (the bounded `ai:backfill` catch-up
 * covers them), and a draft save never re-summarises. A fake transport stands in for the provider; nothing here
 * touches the network.
 */

function stubTransport(opts: {
  answer?: string;
  fail?: Error;
  chat?: (req: AiChatRequest) => Promise<AiChatTurn>;
}): AiTransport & { calls: AiChatRequest[] } {
  const calls: AiChatRequest[] = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      if (opts.chat) return opts.chat(req);
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
    ports: { deadlines, accounts: { status: () => undefined } as never },
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
    step: 'incremental',
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

/** Run the provider-failing queue until every attempt is spent and the job dead-letters. */
const drainFailing = async (w: Awaited<ReturnType<typeof world>>) => {
  for (let i = 0; i < 8; i++) {
    await runJobs(w.engine.services, w.clock.now());
    w.clock.advance(5 * 60 * 60_000);
  }
};

test('a dead summary job re-queues on the next catch-up; flag-only and bulk steps arm nothing', async () => {
  const w = await world(stubTransport({ fail: new AiCallError('unreachable', 'ai.server') }));
  seedMail(w);
  await consentNow(w);
  await drainFailing(w);
  assert.equal(jobsOf(w, 'summary')[0].state, 'dead');
  assert.equal((await threadSummary(w)).state, 'failed');
  // A flag-only update of a known message changes no summary input and re-arms no sentinel.
  w.engine.services.store.commit({
    opId: 'read',
    origin: 'sync',
    step: 'incremental',
    writes: [
      msg('m1', 'T-thread', 5, {
        subject: 'Invoice due Friday',
        snippet: 'The invoice is due this Friday.',
        flags: { seen: true, flagged: false, draft: false, fromMe: false },
      }),
    ],
  });
  await runJobs(w.engine.services, w.clock.now());
  assert.equal(jobsOf(w, 'summary')[0].state, 'dead');
  assert.equal((await threadSummary(w)).state, 'failed');
  // A resync-step page that does store a new message arms nothing either — bulk steps rely on the catch-up.
  w.engine.services.store.commit({
    opId: 'resync',
    origin: 'sync',
    step: 'resync',
    writes: [msg('r1', 'T-other', 3)],
  });
  assert.equal(jobsOf(w, 'wake').filter(j => j.key === `ingest:${ACCOUNT}:T-other`).length, 0);
  // An `ai` settings change arms the `ai:backfill` sentinel, whose catch-up gives the dead row a fresh budget.
  w.engine.services.ai.useTransport(stubTransport({}));
  await w.call('Settings/set', { opId: 'kick', patch: { ai: { background: true } } });
  assert.equal(jobsOf(w, 'wake').find(j => j.key === 'ai:backfill')?.state, 'queued');
  await runJobs(w.engine.services, w.clock.now());
  const row = await threadSummary(w);
  assert.equal(row.state, 'ready');
  assert.equal(row.text, 'Ada asked about the invoice.');
  assert.equal(jobsOf(w, 'summary')[0].state, 'done');
  // The one-shot sentinel fired once and is gone — the next settings change can arm it again.
  assert.equal(
    jobsOf(w, 'wake').find(j => j.key === 'ai:backfill'),
    undefined,
  );
});

test('a failed re-run keeps the earlier ready text as stale, then the catch-up lands a new one', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now());
  assert.equal((await threadSummary(w)).state, 'ready');
  // A reply lands: the pending placeholder carries the old text while the re-run's job dies on a dead provider.
  w.engine.services.ai.useTransport(
    stubTransport({ fail: new AiCallError('unreachable', 'ai.server') }),
  );
  w.engine.services.store.commit({
    opId: 'reply',
    origin: 'sync',
    step: 'incremental',
    writes: [msg('m3', 'T-thread', 7, { snippet: 'One more question about Friday.' })],
  });
  await drainFailing(w);
  assert.ok(jobsOf(w, 'summary').some(j => j.state === 'dead'));
  const stale = await threadSummary(w);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.text, 'Ada asked about the invoice.');
  // The catch-up re-queues the dead job: a `stale` row is not `ready`, so the thread is still eligible.
  w.engine.services.ai.useTransport(
    stubTransport({ answer: '{"summary":"Ada followed up on the invoice.","action":null}' }),
  );
  await w.call('Settings/set', { opId: 'kick', patch: { ai: { background: true } } });
  await runJobs(w.engine.services, w.clock.now());
  const row = await threadSummary(w);
  assert.equal(row.state, 'ready');
  assert.equal(row.text, 'Ada followed up on the invoice.');
});

test('a skipped job writes nothing over a ready row and re-queues when the account comes back', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await w.call('Settings/set', { opId: 'bg', patch: { ai: { background: true } } });
  // Gate closed (no consent): the sentinel still queues the job, which waits out a 30-minute release.
  await runJobs(w.engine.services, w.clock.now());
  assert.equal(jobsOf(w, 'summary').length, 1);
  assert.equal(jobsOf(w, 'summary')[0].state, 'queued');
  assert.equal((await threadSummary(w)).state, 'none');
  // Consent lands (its wake pulls the released job forward), then the account is excluded before the job
  // runs: the outcome is `skipped`, and with no placeholder ever written the settle writes nothing — the
  // row reads 'none', not an empty 'failed'.
  await consentNow(w);
  await w.call('Account/set', { opId: 'off', accountId: ACCOUNT, aiAllowed: false });
  await runJobs(w.engine.services, w.clock.now());
  assert.equal(jobsOf(w, 'summary')[0].state, 'skipped');
  assert.equal((await threadSummary(w)).state, 'none');
  // Letting the account back in arms the catch-up, which re-queues the `skipped` row (`requeue` covers
  // skipped rows) and the job lands.
  await w.call('Account/set', { opId: 'on', accountId: ACCOUNT, aiAllowed: true });
  assert.equal(jobsOf(w, 'wake').find(j => j.key === 'ai:backfill')?.state, 'queued');
  await runJobs(w.engine.services, w.clock.now());
  const row = await threadSummary(w);
  assert.equal(row.state, 'ready');
  assert.equal(row.text, 'Ada asked about the invoice.');
  assert.equal(jobsOf(w, 'summary')[0].state, 'done');
});

test('a skipped job with a pending placeholder keeps its carried text as stale', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now());
  assert.equal((await threadSummary(w)).state, 'ready');
  // A reply queues work with the placeholder holding the old text; the account leaves before the job runs.
  w.engine.services.store.commit({
    opId: 'reply',
    origin: 'sync',
    step: 'incremental',
    writes: [msg('m3', 'T-thread', 7, { snippet: 'One more question about Friday.' })],
  });
  queueSummary(w.engine.services, ACCOUNT, 'T-thread');
  assert.equal((await threadSummary(w)).state, 'pending');
  await w.call('Account/set', { opId: 'off', accountId: ACCOUNT, aiAllowed: false });
  await runJobs(w.engine.services, w.clock.now());
  assert.ok(jobsOf(w, 'summary').some(j => j.state === 'skipped'));
  const stale = await threadSummary(w);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.text, 'Ada asked about the invoice.');
});

test('three draft saves on a summarised thread make no new provider call', async () => {
  const transport = stubTransport({});
  const w = await world(transport);
  seedMail(w);
  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now());
  assert.equal((await threadSummary(w)).state, 'ready');
  assert.equal(transport.calls.length, 1);
  // Each Gmail draft save stores a new message id: the draft is no summary input, so the hash never moves.
  for (let i = 0; i < 3; i++) {
    w.engine.services.store.commit({
      opId: `draft-${i}`,
      origin: 'sync',
      writes: [
        msg(`draft-${i}`, 'T-thread', 8 + i, {
          snippet: `draft text ${i}`,
          flags: { seen: true, flagged: false, draft: true, fromMe: true },
        }),
      ],
    });
    await runJobs(w.engine.services, w.clock.now());
  }
  assert.equal(transport.calls.length, 1);
  assert.equal(jobsOf(w, 'summary').length, 1);
  assert.equal(jobsOf(w, 'summary')[0].state, 'done');
});

test('a baseline page arms no per-thread sentinels; the catch-up queues at most BACKFILL_LIMIT', async () => {
  const w = await world(stubTransport({}));
  const writes: unknown[] = [
    { ...accountWrite, aiAllowed: true },
    ...folderWrites.map(f => ({ ...f })),
  ];
  for (let i = 0; i < 1_200; i++)
    writes.push(
      msg(`b${i}`, `T-b${i}`, 1, {
        flags: { seen: true, flagged: false, draft: false, fromMe: false },
      }),
    );
  w.engine.services.store.commit({
    opId: 'baseline',
    origin: 'sync',
    step: 'baseline',
    writes: writes as never,
  });
  assert.equal(jobsOf(w, 'wake').filter(j => j.key.startsWith('ingest:')).length, 0);
  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now());
  // The bounded catch-up does the first-sync work instead: 1,200 eligible threads, capped at 500 jobs.
  assert.equal(jobsOf(w, 'summary').length, 500);
});

test('a sentinel-heavy pass yields to the event loop between rounds', async () => {
  const w = await world(stubTransport({}));
  await consentNow(w);
  const writes: unknown[] = [
    { ...accountWrite, aiAllowed: true },
    ...folderWrites.map(f => ({ ...f })),
  ];
  for (let i = 0; i < 200; i++) writes.push(msg(`y${i}`, `T-y${i}`, i + 1));
  w.engine.services.store.commit({
    opId: 'bulk',
    origin: 'sync',
    step: 'incremental',
    writes: writes as never,
  });
  let ticks = 0;
  const iv = setInterval(() => ticks++, 1);
  await runJobs(w.engine.services, w.clock.now());
  clearInterval(iv);
  assert.ok(ticks > 0, 'a 1 ms timer fired while the queue worked');
});

test('Settings/set, Account/set and Consent/grant arm the one-shot backfill sentinel', async () => {
  const w = await world(stubTransport({}));
  seedMail(w, false);
  const backfill = () => jobsOf(w, 'wake').find(j => j.key === 'ai:backfill');
  await w.call('Settings/set', { opId: 's1', patch: { ai: { background: true } } });
  assert.equal(backfill()?.state, 'queued');
  await runJobs(w.engine.services, w.clock.now());
  // It fired once and deleted itself (nothing was eligible — the account is kept out).
  assert.equal(backfill(), undefined);
  // Account/set re-arms it; Consent/grant does the same — after both, the catch-up lands the summary.
  await w.call('Account/set', { opId: 'a1', accountId: ACCOUNT, aiAllowed: true });
  assert.equal(backfill()?.state, 'queued');
  await runJobs(w.engine.services, w.clock.now());
  assert.equal(backfill(), undefined);
  await consentNow(w);
  assert.equal(backfill()?.state, 'queued');
  await runJobs(w.engine.services, w.clock.now());
  assert.equal((await threadSummary(w)).state, 'ready');
});

test('the sentinel -> runner -> queueSummary path writes pending end to end', async () => {
  let release!: () => void;
  const held = new Promise<void>(r => (release = r));
  const transport = stubTransport({
    chat: async () => {
      await held;
      return {
        content: '{"summary":"Ada asked about the invoice.","action":null}',
        toolCalls: [],
        usage: { prompt: 1, completion: 1 },
      };
    },
  });
  const w = await world(transport);
  seedMail(w);
  await consentNow(w);
  const run = runJobs(w.engine.services, w.clock.now());
  // Let the runner reach the provider call: the sentinel has become the job, claimed and in flight.
  for (let i = 0; i < 100 && transport.calls.length === 0; i++)
    await new Promise(r => setTimeout(r, 0));
  assert.equal(transport.calls.length, 1);
  const pending = await threadSummary(w);
  assert.equal(pending.state, 'pending');
  release();
  await run;
  const row = await threadSummary(w);
  assert.equal(row.state, 'ready');
  assert.equal(row.text, 'Ada asked about the invoice.');
});

test('write-side eligibility: kept-out accounts, search hits, drafts and Spam/Trash mail arm nothing', async () => {
  const w = await world(stubTransport({}));
  w.engine.services.store.commit({
    opId: 'mixed',
    origin: 'sync',
    step: 'incremental',
    writes: [
      { ...accountWrite, aiAllowed: false },
      { ...accountWrite, id: 'acct-2', aiAllowed: true },
      {
        kind: 'folder',
        accountId: 'acct-2',
        remoteId: 'SPAM',
        name: 'Spam',
        role: 'spam',
        folderKind: 'system',
      },
      ...folderWrites.map(f => ({ ...f })),
      // An AI-off account never sees a sentinel, even for live incremental mail.
      msg('m1', 'T-kept', 5),
      // A stored server-search hit, a draft and Spam-only mail never arm one either.
      msg('m2', 'T-search', 6, { accountId: 'acct-2', origin: 'search' }),
      msg('m3', 'T-draft', 7, {
        accountId: 'acct-2',
        flags: { seen: true, flagged: false, draft: true, fromMe: true },
      }),
      msg('m4', 'T-spam', 8, { accountId: 'acct-2', folders: [{ folder: 'SPAM' }] }),
      // The one message that can lead somewhere arms its thread.
      msg('m5', 'T-real', 9, { accountId: 'acct-2' }),
    ],
  });
  assert.deepEqual(
    jobsOf(w, 'wake').map(j => j.key),
    ['ingest:acct-2:T-real'],
  );
});

test('a slip in the ingest hook rolls back only its own writes; mail still lands and the catch-up arms', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  // A second connection plants a booby trap: every `ingest:` sentinel insert aborts inside the hook.
  const raw = openSqlite(w.file.path);
  try {
    raw.exec(`CREATE TRIGGER fail_ingest BEFORE INSERT ON jobs WHEN NEW.key LIKE 'ingest:%'
              BEGIN SELECT RAISE(ABORT, 'forced'); END`);
    w.engine.services.store.commit({
      opId: 'during-fault',
      origin: 'sync',
      step: 'incremental',
      writes: [msg('m9', 'T-late', 9)],
    });
    // The mail commit landed anyway — the savepoint contained the hook's failure.
    const stored = w.engine.services.store.read(q =>
      q.get<{ remote_id: string }>("SELECT remote_id FROM messages WHERE remote_id = 'm9'"),
    );
    assert.equal(stored?.remote_id, 'm9');
    // And the bounded catch-up sentinel stands in for the thread-level detail the slip dropped.
    assert.equal(jobsOf(w, 'wake').find(j => j.key === 'ai:backfill')?.state, 'queued');
  } finally {
    raw.exec('DROP TRIGGER IF EXISTS fail_ingest');
    raw.close();
  }
});

test('an account id containing a colon still resolves through the sentinel', async () => {
  const w = await world(stubTransport({}));
  const COLON = 'acct:one';
  w.engine.services.store.commit({
    opId: 'colon',
    origin: 'sync',
    step: 'incremental',
    writes: [
      { ...accountWrite, id: COLON, aiAllowed: true },
      ...folderWrites.map(f => ({ ...f, accountId: COLON })),
      msg('c1', 'T-colon', 5, { accountId: COLON }),
    ],
  });
  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now());
  assert.equal((await threadSummary(w, 'T-colon', COLON)).state, 'ready');
});

test('the queued job carries its model and the done log reports it', async () => {
  const w = await world(stubTransport({}));
  seedMail(w);
  await consentNow(w);
  await runJobs(w.engine.services, w.clock.now());
  const payload = w.engine.services.store.read(
    q => q.get<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'summary'")?.payload,
  );
  assert.equal(
    (JSON.parse(payload ?? '{}') as { model?: { model?: string } }).model?.model,
    'openai/gpt-oss-120b',
  );
  const done = w.lines.find(l => l.event === 'ai.job.done');
  assert.equal(done?.data.model, 'openai/gpt-oss-120b');
});
