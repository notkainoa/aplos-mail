import type { Frame, Input, Output, EngineMethodName } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { createEngine, type Engine, type EngineOptions } from '../../src/index';
import type { MessageWrite, StorePort, StoreWrite } from '../../src/store';
import { fakeClock } from '../../src/clock/module';
import { BIG_NOW } from './big';
import { makeWorld } from './world';

/*
 * A real engine over a store, the engine's fake clock and the views lane, for the window tests. `commit` writes the way a sync
 * or a `Thread/act` does; `advance` lets engine time pass so ticks, coalescing and hold lapses run.
 */

export type WindowFrame = Extract<Frame, { frame: 'window' }>;

export async function openEngine(
  store: StorePort,
  options: Partial<EngineOptions> = {},
  start = BIG_NOW,
) {
  const clock = fakeClock(start);
  const log = createLogger({ sink: { write: () => undefined }, salt: 'views-test', clock });
  const engine: Engine = await createEngine({ store, clock, log, ...options });
  // The lanes' start rules (e.g. the outbox marking a seeded `sending` row uncertain) run on the loop's first pass;
  // let them commit now, so a test's seq arithmetic does not depend on microtask timing.
  await clock.flush();
  const session = engine.connect();
  const frames: Frame[] = [];
  session.subscribe(f => frames.push(f));
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    session.call(method, args) as Promise<Output<M>>;
  const windowFrames = (windowId: string) =>
    frames.filter((f): f is WindowFrame => f.frame === 'window' && f.windowId === windowId);
  let n = 0;
  const commit = (writes: StoreWrite[], origin: 'local' | 'sync' = 'local') =>
    store.commit({ opId: `test-${++n}`, origin, writes });
  return {
    engine,
    store,
    clock,
    session,
    frames,
    call,
    windowFrames,
    commit,
    views: engine.services.views,
    /** Lets `ms` of engine time pass in 10 ms steps, so ticks fire in order. */
    async advance(ms: number) {
      for (let t = 0; t < ms; t += 10) await clock.advance(Math.min(10, ms - t));
    },
    close: () => engine.close(),
  };
}

export type TestEngine = Awaited<ReturnType<typeof openEngine>>;

/** A seeded random mailbox of `threads` threads under a running engine. */
export async function worldEngine(seed = 7, threads = 120) {
  const world = makeWorld(seed, BIG_NOW, threads);
  const t = await openEngine(world.store);
  return {
    ...t,
    world,
    async close() {
      await t.engine.close();
      world.cleanup();
    },
  };
}

/** The `{accountId, remoteThreadId}` of a contract thread id in the seeded world. */
export function splitThread(id: string): { accountId: string; remoteThreadId: string } {
  const accountId = id.startsWith('imap:2:') ? 'imap:2' : 'acct-1';
  return { accountId, remoteThreadId: id.slice(accountId.length + 1) };
}

/** A workflow patch on a thread, as `Thread/act` commits it. */
export function patch(id: string, fields: Record<string, unknown>): StoreWrite {
  return { kind: 'workflow', ...splitThread(id), patch: fields } as StoreWrite;
}

/** A message in the Inbox (or `folder`) of a thread; the default date is newer than the seeded mailbox. */
export function incoming(
  remoteThreadId: string,
  options: {
    accountId?: string;
    remoteId?: string;
    date?: number;
    folder?: string;
    seen?: boolean;
  } = {},
): MessageWrite {
  const date = options.date ?? BIG_NOW;
  return {
    kind: 'message',
    accountId: options.accountId ?? 'acct-1',
    remoteId: options.remoteId ?? `${remoteThreadId}-m`,
    remoteThreadId,
    from: { address: 'x@mail.example', name: 'x' },
    to: [{ address: 'owner@mail.example' }],
    cc: [],
    subject: 'garden party',
    snippet: 'garden',
    date,
    internalDate: date,
    flags: { seen: options.seen ?? false, flagged: false, draft: false, fromMe: false },
    folders: [{ folder: options.folder ?? 'INBOX' }],
  };
}
