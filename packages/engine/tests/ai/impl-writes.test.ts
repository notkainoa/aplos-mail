import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Frame, Input, Output } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import type { AiChatRequest, AiTransport } from '../../src/ai/host';
import { accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { manualClock } from '../runtime.helpers';

/**
 * The impl-only write kinds (summary, aiUsage, conversation, plan) register through `ai/impl/ai-writes`
 * at module load. This file deliberately imports NO impl module and never runs the jobs runner — every
 * write below lands only because whichever lazy module the method pulled in registered the handlers.
 * Loading `runner` here would hide a missing registration (it transitively loads the writes).
 */
function stubTransport(): AiTransport & { calls: AiChatRequest[] } {
  const calls: AiChatRequest[] = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      return {
        content: '{"answer":"It is due Friday [1].","proposals":[]}',
        toolCalls: [],
        usage: { prompt: 42, completion: 21 },
      };
    },
    transcribe: () => Promise.resolve({ text: 'words' }),
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
  const frames: Frame[] = [];
  window.subscribe(f => void frames.push(f));
  return { store, engine, call, frames, clock, file };
}

const seedMail = (w: Awaited<ReturnType<typeof world>>) =>
  w.store.commit({
    opId: 'seed',
    origin: 'sync',
    writes: [
      { ...accountWrite, aiAllowed: true },
      ...folderWrites.map(f => ({ ...f })),
      msg('m1', 'T-thread', 5, {
        subject: 'Invoice due Friday',
        snippet: 'The invoice is due this Friday.',
      }),
    ],
  });

test('Ask/run works with no runner import: the conversation and usage writes register on load', async () => {
  const w = await world(stubTransport());
  seedMail(w);
  // Ask/run lazy-loads impl/ask, which must register the write kinds — an unregistered conversation or
  // aiUsage write surfaces as an 'ai.failed' error frame instead of a finished run.
  const { runId, conversationId } = await w.call('Ask/run', {
    question: 'When is the invoice due?',
  });
  for (let i = 0; i < 50; i++) {
    const done = w.frames.some(
      f => f.frame === 'progress' && (f as { runId?: string }).runId === runId && f.kind === 'done',
    );
    if (done) break;
    await new Promise(r => setImmediate(r));
  }
  const failed = w.frames.some(
    f => f.frame === 'progress' && (f as { runId?: string }).runId === runId && f.kind === 'error',
  );
  assert.equal(failed, false, 'Ask/run did not end in an error frame');
  const { list } = await w.call('Conversation/get', { ids: [conversationId] });
  assert.equal(list.length, 1, 'the turn landed in the conversation');
  assert.equal(list[0].turns[0].question, 'When is the invoice due?');
  const usage = w.store.read(q => q.all<{ requests: number }>('SELECT requests FROM ai_usage'));
  assert.ok(usage.length > 0, 'the metered call was recorded');
  // A summary and a conversation write commit through the registered extension — no runner needed.
  w.store.commit({
    opId: 'sum',
    origin: 'system',
    writes: [
      {
        kind: 'summary',
        accountId: 'acct-1',
        remoteThreadId: 'T-thread',
        inputHash: 'h1',
        model: 'test/stub',
        text: 'A summary.',
        state: 'ready',
      } as never,
    ],
  });
  const summary = w.store.read(q => q.get<{ text: string }>('SELECT text FROM summaries'))!;
  assert.equal(summary.text, 'A summary.');
  w.store.commit({
    opId: 'conv',
    origin: 'local',
    writes: [{ kind: 'conversation', id: 'conv-1', data: '{"turn":1}' } as never],
  });
  const conv = w.store.read(q =>
    q.get<{ id: string }>("SELECT id FROM conversations WHERE id = 'conv-1:0'"),
  );
  assert.ok(conv, 'the conversation row landed');
  w.file.cleanup();
});
