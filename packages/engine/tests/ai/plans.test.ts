import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { type AiChatRequest, type AiTransport } from '../../src/ai/host';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { manualClock } from '../runtime.helpers';

function stubTransport(answer: string): AiTransport & { calls: AiChatRequest[] } {
  const calls: AiChatRequest[] = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      return { content: answer, toolCalls: [], usage: { prompt: 10, completion: 10 } };
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

test('Event/extract: gated mail becomes open plans; a second call returns them (no new call)', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w);
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' });
  assert.equal(out.plans.length, 1);
  assert.equal(out.plans[0].title, 'Garden day');
  assert.equal(out.plans[0].state, 'open');
  assert.equal(t.calls.length, 1, 'one metered provider call');
  const again = await w.call('Event/extract', { opId: 'x2', threadId: 'acct-1:T-plans' });
  assert.equal(again.plans.length, 1);
  assert.equal(t.calls.length, 1, 'existing open plans win without a second call');
  // Plan/get and Plan/dismiss round-trip the row.
  const got = await w.call('Plan/get', { ids: [out.plans[0].id] });
  assert.equal(got.list.length, 1);
  await w.call('Plan/dismiss', { opId: 'd1', ids: [out.plans[0].id] });
  const gone = await w.call('Plan/get', { ids: [out.plans[0].id] });
  assert.equal(gone.list[0].state, 'dismissed');
  w.file.cleanup();
});

test('Event/extract: no consent and a Spam thread mean no provider call', async () => {
  const t = stubTransport(EVENT_ANSWER);
  const w = await world(t);
  seed(w, true);
  await assert.rejects(
    () => w.call('Event/extract', { opId: 'x1', threadId: 'acct-1:T-plans' }),
    (e: unknown) => (e as { type?: string }).type === 'forbidden',
  );
  await consentNow(w);
  const out = await w.call('Event/extract', { opId: 'x2', threadId: 'acct-1:T-plans' });
  assert.equal(out.plans.length, 0, 'Spam mail is never read for the model');
  assert.equal(t.calls.length, 0);
  w.file.cleanup();
});
