import type { EngineMethodName, Frame, Input, Output } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { AiCallError, type AiChatRequest, type AiTransport } from '../../src/ai/host';
import { accountWrite, folderWrites, msg, tempDb } from '../store/helpers';
import { manualClock, silentDeadlines } from '../runtime.helpers';

/** A scripted provider: `chat` answers every call with `answer`, or throws `fail` when set. */
export function stubTransport(opts: {
  answer?: string;
  fail?: AiCallError;
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
        content: opts.answer ?? '{"answer":"It is due Friday [1].","proposals":[]}',
        toolCalls: [],
        usage: { prompt: 42, completion: 21 },
      };
    },
    transcribe: () => Promise.resolve({ text: 'words' }),
    models: provider => Promise.resolve({ list: [`${provider}-live`], live: true }),
    check: () => (opts.fail ? Promise.reject(opts.fail) : Promise.resolve()),
    setKey: () => Promise.resolve('keychain' as const),
    removeKey: () => Promise.resolve('none' as const),
    keySource: () => 'env' as const,
  };
}

/** Engine + window over a temp store with every lane's writers; seeds an account, folders and mail. */
export async function world(transport?: AiTransport) {
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
    // The queue's own deadline never fires on its own here: tests drive it with explicit `runJobs` calls,
    // so an ingest-queued summary job cannot race a scripted answer.
    ports: { deadlines: silentDeadlines() },
  });
  engine.services.ai.useTransport(transport ?? stubTransport({}));
  const window = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    window.call(method, args) as Promise<Output<M>>;
  const frames: Frame[] = [];
  window.subscribe(f => void frames.push(f));
  return { store, engine, call, frames, clock, file };
}

export type World = Awaited<ReturnType<typeof world>>;

/** Wait until a run's `done` frame lands (the error path emits `error` then `done`, so one wait covers both). */
export async function settle(w: World, runId: string) {
  for (
    let i = 0;
    i < 60 &&
    !w.frames.some(
      f =>
        f.frame === 'progress' &&
        (f as { runId?: string }).runId === runId &&
        (f as { kind?: string }).kind === 'done',
    );
    i++
  )
    await new Promise(r => setImmediate(r));
}

/** The run's error frame, when it refused. */
export const errorFrame = (w: World, runId: string) =>
  w.frames.find(
    f =>
      f.frame === 'progress' &&
      (f as { runId?: string }).runId === runId &&
      (f as { kind?: string }).kind === 'error',
  ) as { problem?: { reasonCode?: string; message?: string } } | undefined;

/** The last user message the scripted provider saw — the prompt the sources were quoted into. */
export const lastPrompt = (t: ReturnType<typeof stubTransport>) =>
  t.calls.at(-1)!.messages.at(-1)!.content ?? '';

export const seedMail = (w: World, aiAllowed = true) =>
  w.store.commit({
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
