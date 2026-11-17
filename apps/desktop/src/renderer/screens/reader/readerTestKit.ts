/**
 * What the reader's node tests share: the stand-in engine booted under the real data layer with a manual scheduler, the
 * Do now ids, a thread window, and the `ReaderDeps` the screen would build over them (see readerScreen.test.ts).
 */
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { connectDataLayer } from '../../data/connect';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { harnessClock } from '../../data/clock';
import { api, setClock, type ThreadRow } from '../../data';
import { pushToast } from '../../shell';
import { createLetterController } from './letterController';
import type { ReaderDeps } from './readerActions';
import type { ReplyRequest } from './readerUi';

export const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

export async function settle(flush: () => void) {
  for (let i = 0; i < 20; i++) {
    await nextTask();
    flush();
  }
}

/** Two earlier messages (a day apart) in front of a demo thread's one message, for the compact cards. */
export function seedEarlier(
  engine: ReturnType<typeof createFixtureEngine>,
  threadId: string,
): void {
  const fx = engine.fixture;
  const last = fx.store.get('Message', `${threadId}.m1`);
  if (!last) return;
  const bodies = [
    'Kicking off: here is the brief we agreed on Friday. Please read it before Monday and tell me what is missing from it.',
    'Thanks, that helps. Two things to keep in mind before we start.',
  ];
  bodies.forEach((body, index) => {
    fx.write({ kind: 'Fixture/control' }, tx => {
      tx.put('Message', {
        ...last,
        id: `${threadId}.e${index + 1}`,
        rev: 0,
        snippet: body,
        date: last.date - (bodies.length - index) * 86_400_000,
        seen: true,
        attachments: [],
      });
    });
  });
}

export async function boot(seed?: string) {
  const engine = createFixtureEngine({ scenario: 'demo', clock: defaultNow });
  if (seed) seedEarlier(engine, seed);
  const scheduler = createManualScheduler();
  const connection = connectDataLayer({
    session: engine.connect(),
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  const { layer } = connection;
  const home = layer.windows.acquire({ kind: 'home' });
  for (const name of ['accounts', 'counts', 'settings'] as const) layer.session.want(name);
  setClock(harnessClock);
  await settle(() => scheduler.flush());
  const doIds = () => {
    const snap = home.snapshot();
    const section = snap.sections.find(s => s.key === 'do');
    return section
      ? snap.ids.slice(section.start - snap.position, section.start - snap.position + section.count)
      : [];
  };
  const threadWindow = async (threadId: string) => {
    const window = layer.windows.acquire({ kind: 'thread', threadId });
    await settle(() => scheduler.flush());
    return window;
  };
  return { connection, home, doIds, threadWindow, flush: () => settle(() => scheduler.flush()) };
}

export type World = Awaited<ReturnType<typeof boot>>;

export const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The deps the screen builds, over the real data layer, the home window as the list, and a letter buffer. */
export function depsOver(world: World, start: string, readyOnGo = true) {
  const controller = createLetterController(createManualTimers(0));
  const state = {
    open: start,
    left: 0,
    gone: new Set<string>(),
    findOpen: false,
    replies: [] as string[],
    requests: [] as Array<ReplyRequest | undefined>,
    suggested: [] as string[],
    forwards: [] as string[],
    /** The thread was read from Trash or Spam. */
    restorable: true,
  };
  controller.want(start);
  controller.ready(start);
  const go = (id: string) => {
    state.open = id;
    // What `useLetterBuffer` does: a letter this reading sent away is not kept on paper while the next one loads.
    const paper = controller.snapshot().letter;
    controller.want(id, paper === null || state.gone.has(paper));
    if (readyOnGo) controller.ready(id);
  };
  const deps: ReaderDeps = {
    shown: () => controller.snapshot().letter,
    wanted: () => state.open,
    ids: () => world.home.snapshot().ids,
    rowOf: id => world.home.snapshot().rows.get(id) as ThreadRow | undefined,
    go,
    reopen: go,
    restorable: () => state.restorable,
    markGone: (id, gone) => void (gone ? state.gone.add(id) : state.gone.delete(id)),
    leave: () => void state.left++,
    closeFind: () => {
      const was = state.findOpen;
      state.findOpen = false;
      return was;
    },
    act: args => api.thread.act(args),
    push: pushToast,
    dismiss: () => undefined,
    undoLabel: (_id, fallback) => fallback,
    forward: id => void state.forwards.push(id),
    reply: (id, request) => {
      state.replies.push(id);
      state.requests.push(request);
    },
    suggested: (id, action) => void state.suggested.push(`${id}:${action.verb}`),
  };
  return { deps, state, controller };
}
