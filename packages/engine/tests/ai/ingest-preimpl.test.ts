import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Frame, Input, Output } from '@aplos/contract';
import type { LogRecord } from '@aplos/contract/log/events';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { type AiChatRequest, type AiChatTurn, type AiTransport } from '../../src/ai/host';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { manualClock, silentDeadlines } from '../runtime.helpers';

/**
 * The `ai/impl` seam's pre-load path: a mail commit that lands before `ai/impl` first loads (nothing in this
 * file's static imports reaches it, and `silentDeadlines` never fires the `jobs` source that lazy-imports the
 * runner) cannot run the real ingest body — its job rows would come from a module that is not there yet. The
 * eager scaffold in `aiIngest` still opens `SAVEPOINT ai_i`, arms the bounded `ai:backfill` catch-up instead of
 * per-thread sentinels, and marks `AiJob` so the commit wakes the `jobs` deadline — the mail must be found once
 * the runner is up. Once `ai/impl` has loaded, later commits use the real per-thread path again.
 */

function stubTransport(answer: string): AiTransport & { calls: AiChatRequest[] } {
  const calls: AiChatRequest[] = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      return {
        content: answer,
        toolCalls: [],
        usage: { prompt: 42, completion: 21 },
      } satisfies AiChatTurn;
    },
    transcribe: () => Promise.resolve({ text: 'words' }),
    models: provider => Promise.resolve({ list: [`${provider}-live`], live: true }),
    check: () => Promise.resolve(),
    setKey: () => Promise.resolve('keychain' as const),
    removeKey: () => Promise.resolve('none' as const),
    keySource: () => 'env' as const,
  };
}

async function world() {
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
  engine.services.ai.useTransport(
    stubTransport('{"summary":"Ada asked about the invoice.","action":null}'),
  );
  const window = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    window.call(method, args) as Promise<Output<M>>;
  const frames: Frame[] = [];
  window.subscribe(f => void frames.push(f));
  return { store, engine, call, deadlines, clock, file };
}

const wakeKeys = (w: Awaited<ReturnType<typeof world>>) =>
  w.engine.services.store
    .read(q =>
      q.all<{ key: string; state: string }>(
        "SELECT key, state FROM jobs WHERE kind = 'wake' ORDER BY id",
      ),
    )
    .map(j => `${j.key}@${j.state}`);

test('a commit before ai/impl first loads arms the bounded catch-up; the runner still finds the mail', async () => {
  const w = await world();
  // No `ai/impl` import has run: the ingest fallback cannot write per-thread sentinels, so the one bounded
  // `ai:backfill` row stands in — and `AiJob` still pokes the `jobs` deadline for the commit.
  w.engine.services.store.commit({
    opId: 'pre-impl',
    origin: 'sync',
    step: 'incremental',
    writes: [
      { ...accountWrite, aiAllowed: true },
      ...folderWrites.map(f => ({ ...f })),
      msg('m1', 'T-early', 5),
    ],
  });
  assert.deepEqual(wakeKeys(w), ['ai:backfill@queued']);
  assert.ok(w.deadlines.told.includes('jobs'));

  // Load the lane's impl the way the first jobs-deadline fire does; the real ingest body is now registered.
  const { runJobs } = await import('../../src/ai/impl/runner');
  w.engine.services.store.commit({
    opId: 'post-impl',
    origin: 'sync',
    step: 'incremental',
    writes: [msg('m2', 'T-late', 6)],
  });
  assert.deepEqual(wakeKeys(w), ['ai:backfill@queued', `ingest:${ACCOUNT}:T-late@queued`]);

  // Consent on, one runner pass: the catch-up covers the pre-impl mail and the sentinel covers the new one.
  await w.call('Settings/set', { opId: 'bg', patch: { ai: { background: true } } });
  const got = await w.call('Consent/get', {});
  await w.call('Consent/grant', {
    scope: 'background',
    version: got.currentVersion ?? got.version,
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
  });
  await runJobs(w.engine.services, w.clock.now());
  const early = await w.call('Thread/get', { ids: [`${ACCOUNT}:T-early`] });
  const late = await w.call('Thread/get', { ids: [`${ACCOUNT}:T-late`] });
  assert.equal(early.list[0].summary.state, 'ready');
  assert.equal(late.list[0].summary.state, 'ready');
});
