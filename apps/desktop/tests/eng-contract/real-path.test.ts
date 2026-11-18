import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { windowCaller } from '@aplos/engine';
import { closeThenRelease, createProcessState, QUIT_DRAIN_MS } from '../../src/host/lifecycle';
import {
  ENGINE_EXIT_AFTER_KILL_MS,
  ENGINE_QUIT_MS,
  createEngineSupervisor,
  draftOpenable,
  realEngineRequested,
  type EngineLink,
} from '../../src/host/transports/port';
import { fakeWindow, mainSide, T0, until } from './rig';

/** The modules of the real engine path. Phase 2 widens this to all of `src/main` when the legacy code goes. */
const realPathModules = [
  '../../src/host/transports/port.ts',
  '../../src/main/engine-real.ts',
  '../../src/main/engine-utility.ts',
];

test('the real path keeps no state mirror in main', () => {
  for (const path of realPathModules) {
    const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    for (const banned of [
      /latestState/,
      /applyChanges/,
      /\bAppState\b/,
      /'state\.get'/,
      /from '[^']*legacy[^']*'/,
    ])
      assert.doesNotMatch(source, banned, `${path} has ${banned}`);
  }
});

test('APLOS_ENGINE=real is opt-in and never in a release build', () => {
  assert.equal(realEngineRequested({}, false), false);
  assert.equal(realEngineRequested({ APLOS_ENGINE: 'legacy' }, false), false);
  assert.equal(realEngineRequested({ APLOS_ENGINE: 'real' }, false), true);
  assert.equal(realEngineRequested({ APLOS_ENGINE: 'real' }, true), false);
});

test('real path: a window gets its own port, Session/get answers, main validates compose through Draft/get', async t => {
  const main = mainSide(t);
  const link = await main.supervisor.start();
  const ready = await link.ready;
  const one = fakeWindow(1);
  main.broker.connect(one.win);

  // The handshake and the settings answer over the port from the real handlers (go-live needs both: a window opens on them).
  const session = (await one.client.call('Session/get', {})) as {
    apiVersion: number;
    dbEpoch: string;
    engine: { state: string };
    device: { id: string };
  };
  assert.equal(session.apiVersion, 1);
  assert.equal(session.dbEpoch, ready.dbEpoch);
  assert.equal(session.engine.state, 'ready');
  assert.ok(session.device.id);
  const settings = (await one.client.call('Settings/get', {})) as {
    mail: { remoteImages: string };
  };
  assert.equal(settings.mail.remoteImages, 'block');
  assert.equal(
    one.client.position().dbEpoch,
    ready.dbEpoch,
    'the hello carried the store’s dbEpoch',
  );
  assert.ok(await one.client.call('Counts/get', {}));
  // A host-only method: preload's list and the port refuse it, and so does the engine's own dispatch for a window.
  await assert.rejects(one.client.call('Notification/claim', {}), { type: 'unsupported' });
  const direct = main.hosts[0].engine.connect(windowCaller);
  await assert.rejects(direct.call('Notification/claim', {}), { type: 'forbidden' });
  direct.close();

  // `window.compose` validates through main's own connection, never a mirror.
  assert.equal(await draftOpenable(link, 'no-such-draft'), false);
  const demo = (await one.client.call('Demo/load', {})) as { accountIds: string[] };
  const saved = (await one.client.call('Draft/set', {
    opId: 'contract4-draft-1',
    fields: {
      accountId: demo.accountIds[0],
      mode: 'new',
      to: [],
      cc: [],
      bcc: [],
      subject: 'Hello',
      html: '<p>Hi</p>',
      attachments: [],
      signature: false,
    },
  })) as { draft: { id: string } };
  assert.equal(await draftOpenable(link, saved.draft.id), true);
  // Main's control connection is limited to its named queries.
  await assert.rejects(link.call('Thread/act', {}), /Not a control method/);

  // A second window gets its own port; closing one leaves the other working.
  const two = fakeWindow(2);
  main.broker.connect(two.win);
  assert.ok(await two.client.call('Counts/get', {}));
  main.broker.revoke(1);
  assert.ok(await two.client.call('Counts/get', {}));
  assert.deepEqual(main.broker.holders(), [2]);
});

test('real path: a control call whose signal aborts rejects at once and its late answer is dropped', async t => {
  const main = mainSide(t);
  const link = await main.supervisor.start();
  await link.ready;
  const args = { token: 'f'.repeat(32), path: '', windowId: '' };
  const before = new AbortController();
  before.abort();
  await assert.rejects(link.call('Mail/serve', args, 5000, before.signal), /cancelled/);
  const during = new AbortController();
  const call = link.call('Mail/serve', args, 5000, during.signal);
  during.abort();
  await assert.rejects(call, /cancelled/);
  // The link still works, and the dropped answer did not confuse it.
  assert.ok(await link.call('Counts/get', {}));
});

test('real path: a control call that settles removes its abort listener (a long-lived signal does not collect them)', async t => {
  const main = mainSide(t);
  const link = await main.supervisor.start();
  await link.ready;
  let added = 0;
  let removed = 0;
  const live = new AbortController();
  const signal = live.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof add>) => (
    added++,
    add(...args)
  )) as typeof add;
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => (
    removed++,
    remove(...args)
  )) as typeof remove;
  for (let i = 0; i < 5; i++) await link.call('Counts/get', {}, 5000, signal);
  assert.equal(added, 5);
  assert.equal(removed, 5, 'every settled call took its listener off the signal');
});

test('real path: killing the engine reconnects windows on the same dbEpoch with no re-snapshot', async t => {
  const main = mainSide(t);
  const first = await (await main.supervisor.start()).ready;
  const one = fakeWindow(1);
  main.broker.connect(one.win);
  await one.client.call('Demo/load', {});
  await main.clock.advance(500);
  await until(() => (one.client.position().seq ?? 0) > first.seq, 'a state frame after the demo');
  const before = one.client.position();
  const framesBefore = one.frames.length;

  await main.utilities[0].crash();
  await until(() => main.ups.length === 2, 'the restart');
  assert.deepEqual(main.ups, [false, true]);
  await until(() => one.state.deliveries === 2, 'a new port for the window');
  assert.ok(await one.client.call('Counts/get', {}));

  const after = one.client.position();
  assert.equal(after.dbEpoch, before.dbEpoch, 'same database, same dbEpoch');
  assert.equal(after.seq, before.seq, 'the window kept its state token');
  const since = one.frames.slice(framesBefore);
  assert.ok(
    since.every(frame => frame.frame !== 'reset'),
    'no reset: the window resumes, nothing is re-sent',
  );
  assert.ok(since.some(frame => frame.frame === 'desktop' && frame.event.type === 'engine'));
});

test('real path: the stored theme reaches main at every engine start, and a change follows at once', async t => {
  const main = mainSide(t);
  await (
    await main.supervisor.start()
  ).ready;
  const appearance = () =>
    main.hostEvents.filter(
      (event): event is { type: 'appearance'; theme: string } =>
        (event as { type?: string }).type === 'appearance',
    );
  await until(() => appearance().length === 1, 'the boot appearance seed');
  assert.equal(appearance()[0].theme, 'system', 'default settings seed the system theme');

  // A Settings/set theme change emits on the same channel main's `nativeTheme` follows.
  const direct = main.hosts[0].engine.connect(windowCaller);
  await direct.call('Settings/set', { opId: 'theme-1', patch: { ui: { theme: 'dark' } } });
  direct.close();
  await until(() => appearance().length === 2, 'the change event');
  assert.equal(appearance()[1].theme, 'dark');

  // An engine restart seeds the stored theme again: explicit Light/Dark survives it (ui-shell's #450 finding).
  await main.utilities[0].crash();
  await until(() => main.ups.length === 2, 'the restart');
  assert.deepEqual(main.ups, [false, true]);
  await until(() => appearance().length === 3, 'the restart seed');
  assert.equal(appearance()[2].theme, 'dark', 'the stored theme, not a system fallback');
});

test('real path: the third engine stop within 60 s parks, with no further restart', async t => {
  let now = T0;
  const main = mainSide(t, { now: () => now });
  await main.supervisor.start();
  const one = fakeWindow(1);
  main.broker.connect(one.win);
  for (const stop of [1, 2, 3]) {
    now += 5_000;
    await until(() => main.utilities.length === stop && !!main.supervisor.current(), 'an engine');
    await main.supervisor.current()!.ready;
    await main.utilities[stop - 1].crash();
    await until(() => main.desktop.length === stop, `stop ${stop}`);
  }
  assert.equal(main.processState.state, 'parked');
  assert.deepEqual(
    main.desktop.map(frame => frame.event.type === 'engine' && frame.event.state),
    ['connecting', 'connecting', 'parked'],
  );
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(main.utilities.length, 3, 'parked: no fourth engine');
  assert.equal(main.supervisor.current(), undefined);
  assert.ok(
    one.frames.some(
      f => f.frame === 'desktop' && f.event.type === 'engine' && f.event.state === 'parked',
    ),
  );
});

test('real path: quitting closes the engine cleanly (database closed, process exited)', async t => {
  const main = mainSide(t);
  await main.supervisor.start();
  const one = fakeWindow(1);
  main.broker.connect(one.win);
  assert.ok(await one.client.call('Counts/get', {}));
  await main.supervisor.close();
  assert.equal(main.utilities[0].isDead(), true);
  assert.equal(main.ups.length, 1, 'no restart after a quit');
  assert.throws(() => main.hosts[0].engine.connect(), /not running/);
});

/** Timers that run only when the test moves them. */
function manualTimers() {
  let now = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  let next = 0;
  return {
    set: (run: () => void, ms: number) => {
      due.set(++next, { at: now + ms, run });
      return next;
    },
    clear: (handle: unknown) => void due.delete(handle as number),
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const first = [...due].sort((a, b) => a[1].at - b[1].at)[0];
        if (!first || first[1].at > target) break;
        due.delete(first[0]);
        now = Math.max(now, first[1].at);
        first[1].run();
      }
      now = target;
    },
  };
}

/** A link to an engine that answers `ready` only if told to, and exits when killed. */
function fakeLink(readies: boolean) {
  const exits: (() => void)[] = [];
  let exited = false;
  let kills = 0;
  let fail!: (error: unknown) => void;
  const ready = new Promise<{ dbEpoch: string; seq: number }>((resolve, reject) => {
    fail = reject;
    if (readies) resolve({ dbEpoch: 'e1', seq: 0 });
  });
  ready.catch(() => undefined);
  const exit = () => {
    if (exited) return;
    exited = true;
    fail(new Error('stopped'));
    exits.splice(0).forEach(handler => handler());
  };
  const link: EngineLink = {
    ready,
    get exited() {
      return exited;
    },
    call: async () => ({}),
    attach: () => undefined,
    detach: () => undefined,
    power: () => undefined,
    quit: exit,
    kill: () => {
      kills++;
      exit();
    },
    onExit: handler => (exited ? handler() : void exits.push(handler)),
  };
  return { link, exit, kills: () => kills };
}

test('an engine that never answers ready is killed after the ready timeout, and that counts as a stop', async () => {
  const timers = manualTimers();
  const links: ReturnType<typeof fakeLink>[] = [];
  let stops = 0;
  const downs: boolean[] = [];
  const supervisor = createEngineSupervisor({
    // The first engine starts; every restart hangs before `ready`.
    spawn: () => {
      const next = fakeLink(links.length === 0);
      links.push(next);
      return next.link;
    },
    noteExit: () => ++stops >= 3,
    onUp: () => undefined,
    onDown: parked => void downs.push(parked),
    timers,
    restartDelayMs: 10,
    readyTimeoutMs: 1000,
  });
  await supervisor.start();
  links[0].exit();
  timers.advance(10);
  assert.equal(links.length, 2, 'restarted');
  timers.advance(999);
  assert.equal(links[1].kills(), 0, 'not before the timeout');
  timers.advance(1);
  assert.equal(links[1].kills(), 1, 'killed at the timeout');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 2, 'the hung start counted as a stop');
  timers.advance(10);
  timers.advance(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(downs, [false, false, true], 'the third stop parks');
  assert.equal(links.length, 3);
  assert.equal(supervisor.current(), undefined);
});

// ---------------------------------------------------------------- the data lock and a stuck engine (#203)

/** An engine that ignores quit and kill until the test lets it exit. */
function stuckLink(options: { killThrows?: boolean } = {}) {
  const exits: (() => void)[] = [];
  let exited = false;
  let kills = 0;
  let quits = 0;
  const link: EngineLink = {
    ready: Promise.resolve({ dbEpoch: 'e1', seq: 0 }),
    get exited() {
      return exited;
    },
    call: async () => ({}),
    attach: () => undefined,
    detach: () => undefined,
    power: () => undefined,
    quit: () => void quits++,
    kill: () => {
      kills++;
      if (options.killThrows) throw new Error('kill EPERM');
    },
    onExit: handler => (exited ? handler() : void exits.push(handler)),
  };
  const exit = () => {
    if (exited) return;
    exited = true;
    exits.splice(0).forEach(handler => handler());
  };
  return { link, exit, kills: () => kills, quits: () => quits };
}

/** The supervisor wired into `closeThenRelease` exactly as `finishQuit` does it (main/lifecycle.ts, main/engine-real.ts). */
async function quitWith(engine: ReturnType<typeof stuckLink>, whenExits?: number) {
  const timers = manualTimers();
  const supervisor = createEngineSupervisor({
    spawn: () => engine.link,
    noteExit: () => false,
    onUp: () => undefined,
    onDown: () => undefined,
    timers,
  });
  await supervisor.start();
  let released = 0;
  const closed = supervisor.close().then(result => {
    if (result !== 'exited') throw new Error('The mailbox engine did not stop.');
  });
  const outcome = closeThenRelease(closed, QUIT_DRAIN_MS, timers, () => void released++);
  if (whenExits !== undefined) {
    timers.advance(whenExits);
    engine.exit();
  }
  await new Promise(resolve => setImmediate(resolve));
  timers.advance(ENGINE_QUIT_MS + ENGINE_EXIT_AFTER_KILL_MS + 1);
  await new Promise(resolve => setImmediate(resolve));
  timers.advance(QUIT_DRAIN_MS);
  const result = await outcome;
  return { result, released };
}

test('quit with a stuck engine: the data lock stays held, even after the supervisor killed it', async () => {
  const engine = stuckLink();
  const { result, released } = await quitWith(engine);
  assert.equal(result, false);
  assert.equal(released, 0, 'the engine never exited: the lock is not let go');
  assert.equal(engine.quits(), 1);
  assert.equal(engine.kills(), 1, 'it was killed after the quit wait');
});

test('quit with an engine that exits just after the kill: the lock is released', async () => {
  const engine = stuckLink();
  const { result, released } = await quitWith(engine, ENGINE_QUIT_MS + 500);
  assert.equal(engine.kills(), 1);
  assert.equal(result, true);
  assert.equal(released, 1);
});

test('quit with an engine that exits when asked: the lock is released at once', async () => {
  const engine = stuckLink();
  const { result, released } = await quitWith(engine, 1);
  assert.equal(engine.kills(), 0);
  assert.equal(result, true);
  assert.equal(released, 1);
});

test('the quit drain outlasts the supervisor wait, so a late exit is still seen', () => {
  assert.ok(QUIT_DRAIN_MS > ENGINE_QUIT_MS + ENGINE_EXIT_AFTER_KILL_MS);
});

test('once the quit has begun, the supervisor starts no engine', async () => {
  const engine = stuckLink();
  let spawned = 0;
  const supervisor = createEngineSupervisor({
    spawn: () => (spawned++, engine.link),
    noteExit: () => false,
    onUp: () => undefined,
    onDown: () => undefined,
    timers: manualTimers(),
  });
  await supervisor.close();
  await assert.rejects(supervisor.start());
  assert.equal(spawned, 0);
});

// ---------------------------------------------------------------- the #203 LOWs (kill throws, source shape, quit during start-up)

test('quit with an engine whose kill throws: no uncaught error, the exit wait still runs, a late exit releases', async () => {
  const stuck = stuckLink({ killThrows: true });
  const first = await quitWith(stuck);
  assert.equal(first.result, false, 'still running after the kill: the lock stays held');
  assert.equal(first.released, 0);
  assert.equal(stuck.kills(), 1, 'the kill was tried');
  const dying = stuckLink({ killThrows: true });
  const second = await quitWith(dying, ENGINE_QUIT_MS + 500);
  assert.equal(second.result, true, 'it exited anyway, within the wait after the kill');
  assert.equal(second.released, 1);
});

test('an engine that never answers ready and whose kill throws is not an uncaught error either', async () => {
  const engine = stuckLink({ killThrows: true });
  const timers = manualTimers();
  const failures: unknown[] = [];
  const supervisor = createEngineSupervisor({
    spawn: () => ({ ...engine.link, ready: new Promise(() => undefined) }),
    noteExit: () => false,
    onUp: () => undefined,
    onDown: () => undefined,
    timers,
    readyTimeoutMs: 1000,
    onKillFailed: error => void failures.push(error),
  });
  void supervisor.start().catch(() => undefined);
  timers.advance(1000);
  assert.equal(engine.kills(), 1, 'killed at the timeout, and the throw did not escape the timer');
  assert.equal(failures.length, 1, 'the failed kill was reported, not swallowed silently');
});

/** The source of a main-process module, for the guards that cannot run Electron here. */
const sourceOf = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('source shape: realEngine.close() sets closeRequested and rejects unless the engine exited', () => {
  const source = sourceOf('../../src/main/engine-real.ts');
  const close = /close: async \(\): Promise<void> => \{([\s\S]*?)\n {2}\},/.exec(source)?.[1] ?? '';
  assert.match(close, /closeRequested = true;/, 'the quit is recorded before the engine is asked');
  assert.match(close, /await supervisor\?\.close\(\)/);
  assert.match(close, /if \(result !== 'exited'\) throw new Error\(/, 'a stuck engine rejects');
  // No engine starts once the quit began, wherever the start-up had got to.
  const boot = /async function bootRealEngine[\s\S]*?supervisor = createEngineSupervisor/.exec(
    source,
  );
  assert.match(boot?.[0] ?? '', /if \(closeRequested\) return;/);
});

test('source shape: finishQuit hands the REAL close to closeThenRelease, and start-up shows no error during a quit', () => {
  const source = sourceOf('../../src/main/lifecycle.ts');
  assert.match(source, /realPath \? realEngine\.close\(\) : service\?\.close\(\)/);
  assert.match(source, /closeThenRelease\(Promise\.resolve\(engineClosed\), QUIT_DRAIN_MS/);
  assert.match(source, /\.catch\(failedStart\)/, 'a start-up failure goes through failedStart');
  const failed = /function failedStart\(error: unknown\) \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
  const guard = failed.indexOf('if (closing) return;');
  assert.ok(guard >= 0, 'the start-up catch returns while a quit is in progress');
  assert.ok(guard < failed.indexOf('showErrorBox'), '... before it shows the dialog');
});

function restartWorld() {
  const timers = manualTimers();
  const links: ReturnType<typeof fakeLink>[] = [];
  const downs: boolean[] = [];
  const ups: boolean[] = [];
  const restarts: boolean[] = [];
  let stops = 0;
  const supervisor = createEngineSupervisor({
    spawn: () => {
      const next = fakeLink(true);
      links.push(next);
      return next.link;
    },
    noteExit: () => ++stops >= 3,
    onUp: (_link, restarted) => void ups.push(restarted),
    onDown: parked => void downs.push(parked),
    timers,
    restartDelayMs: 10,
    quitMs: 100,
    exitAfterKillMs: 50,
    // The restarts below are meant to follow each other; the coalescing has its own test.
    restartCoalesceMs: 0,
    onRestart: () => void restarts.push(true),
  });
  return { supervisor, links, downs, ups, timers, restarts, stops: () => stops };
}

test('Engine/restart: a running engine is asked to quit and the next starts at once, without counting toward the park', async () => {
  const w = restartWorld();
  await w.supervisor.start();
  for (let i = 0; i < 5; i++) {
    await w.supervisor.restart();
    await until(() => w.links.length === i + 2, 'the next engine');
  }
  assert.equal(w.stops(), 0, 'an asked restart never reaches noteExit');
  assert.deepEqual(w.downs, [false, false, false, false, false]);
  assert.equal(w.ups.at(-1), true);
  assert.equal(w.links.length, 6);
});

test('Engine/restart: an engine that ignores the quit is killed after quitMs, then replaced', async () => {
  const w = restartWorld();
  await w.supervisor.start();
  // This engine ignores quit: only the kill ends it.
  const stubborn = w.links[0].link;
  stubborn.quit = () => undefined;
  await w.supervisor.restart();
  assert.equal(w.links.length, 1, 'nothing replaces it while it runs');
  w.timers.advance(100);
  assert.equal(w.links[0].kills(), 1);
  await until(() => w.links.length === 2, 'the next engine');
});

test('Engine/restart: a parked app starts an engine now, and a closed supervisor refuses', async () => {
  const w = restartWorld();
  await w.supervisor.start();
  for (let i = 0; i < 3; i++) {
    w.links[i].exit();
    w.timers.advance(10);
    await until(() => w.links.length === Math.min(i + 2, 3), 'the next engine');
  }
  assert.equal(w.downs.at(-1), true, 'three stops park it');
  const before = w.links.length;
  await w.supervisor.restart();
  await until(() => w.links.length === before + 1, 'the next engine');
  assert.equal(w.ups.at(-1), true);
  await w.supervisor.close();
  await assert.rejects(w.supervisor.restart());
});

test('Engine/restart: an engine that survives the kill does not leave the app unable to retry', async () => {
  const w = restartWorld();
  await w.supervisor.start();
  const wedged = w.links[0].link;
  wedged.quit = () => undefined;
  wedged.kill = () => undefined; // the OS refused: the process stays
  await w.supervisor.restart();
  w.timers.advance(100); // quit window over: the kill is tried
  w.timers.advance(50); // and the wait after it: give up
  // The next ask is a real one again (quit is tried a second time), not a silent success.
  let quits = 0;
  wedged.quit = () => void (quits += 1);
  await w.supervisor.restart();
  assert.equal(quits, 1);
  assert.equal(w.restarts.length, 2, 'each accepted ask told the host');
});

test('Engine/restart: asks closer together than the coalescing window are one restart', async () => {
  const timers = manualTimers();
  let clock = 1_000;
  const links: ReturnType<typeof fakeLink>[] = [];
  let told = 0;
  const supervisor = createEngineSupervisor({
    spawn: () => {
      const next = fakeLink(true);
      links.push(next);
      return next.link;
    },
    noteExit: () => false,
    onUp: () => undefined,
    onDown: () => undefined,
    onRestart: () => void (told += 1),
    now: () => clock,
    timers,
    quitMs: 100,
  });
  await supervisor.start();
  await supervisor.restart();
  await until(() => links.length === 2, 'the next engine');
  for (let i = 0; i < 10; i++) await supervisor.restart(); // a loop of asks
  assert.equal(links.length, 2, 'no second restart inside the window');
  assert.equal(told, 1);
  clock += 5_000;
  await supervisor.restart();
  await until(() => links.length === 3, 'the engine after the window');
  assert.equal(told, 2);
});

test('source shape: the desktop handler checks the caller before anything else, and File/open refuses a type before reading bytes', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/main/engine-real.ts', import.meta.url)),
    'utf8',
  );
  // The whole handler is ONE return of the guard: the caller check is its first argument, so no branch can reach a
  // method without it (the guard's behaviour is tested in attachment-files.test.ts).
  const handler = /function desktopMethod\(([^)]*)\) \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(handler, 'desktopMethod is found');
  const body = handler![2]!.replace(/\/\/[^\n]*/g, '');
  assert.match(
    body,
    /^\s*return guardedDesktopCall\(\s*\(\) => assertCaller\(event\),\s*\(\) => desktopMethodFor\(event, method, input\),\s*\);\s*$/,
  );
  const open = source.indexOf("method === 'File/open' && !SNIFFED_EXTENSIONS");
  assert.ok(open > 0 && open < source.indexOf('await blobBytes('), 'the type check comes first');
  const bundle = source.slice(
    source.indexOf('function hostBundle'),
    source.indexOf('function copyDiagnostics'),
  );
  for (const banned of [/hostname/, /userInfo/, /homedir/, /networkInterfaces/])
    assert.doesNotMatch(bundle, banned, 'the host bundle stays content-free');
  assert.match(
    source,
    /isTest\) clipboard\.writeText|!isTest\) clipboard/,
    'test mode never writes the clipboard',
  );
});

test('Engine/restart: the park count is cleared by at most three asks per window, the engine restarts every time', async () => {
  const timers = manualTimers();
  let clock = 0;
  const links: ReturnType<typeof fakeLink>[] = [];
  let told = 0;
  const supervisor = createEngineSupervisor({
    spawn: () => {
      const next = fakeLink(true);
      links.push(next);
      return next.link;
    },
    noteExit: () => false,
    onUp: () => undefined,
    onDown: () => undefined,
    onRestart: () => void (told += 1),
    now: () => clock,
    timers,
    quitMs: 100,
    restartCoalesceMs: 0,
  });
  await supervisor.start();
  for (let i = 0; i < 6; i++) {
    clock += 1_000;
    await supervisor.restart();
    await until(() => links.length === i + 2, 'the next engine');
  }
  assert.equal(links.length, 7, 'every ask restarted the engine');
  assert.equal(told, 3, 'but only three cleared the park count');
  clock += 10 * 60_000;
  await supervisor.restart();
  await until(() => links.length === 8, 'the engine after the window');
  assert.equal(told, 4, 'the window passed: the cap resets');
});

test('Engine/restart: an ask while the FIRST engine is still starting changes nothing and is not lost to the start', async () => {
  const timers = manualTimers();
  const links: ReturnType<typeof fakeLink>[] = [];
  let told = 0;
  const supervisor = createEngineSupervisor({
    spawn: () => {
      const next = fakeLink(false);
      links.push(next);
      return next.link;
    },
    noteExit: () => false,
    onUp: () => undefined,
    onDown: () => undefined,
    onRestart: () => void (told += 1),
    timers,
    restartCoalesceMs: 0,
  });
  const starting = supervisor.start();
  starting.catch(() => undefined);
  await supervisor.restart();
  assert.equal(links.length, 1, 'no second engine while the first one starts');
  assert.equal(told, 0, 'and the host is not told to forget stops');
  assert.equal(links[0].kills(), 0);
});

test('Engine/restart: past the un-park cap while PARKED, the next crash parks again instead of looping', async () => {
  const timers = manualTimers();
  let clock = 0;
  const processState = createProcessState();
  const links: ReturnType<typeof fakeLink>[] = [];
  const downs: boolean[] = [];
  const supervisor = createEngineSupervisor({
    spawn: () => {
      const next = fakeLink(true);
      links.push(next);
      return next.link;
    },
    noteExit: () => processState.noteEngineExit(clock),
    onUp: () => undefined,
    onDown: parked => void downs.push(parked),
    onRestart: () => processState.tryAgain(),
    now: () => clock,
    timers,
    quitMs: 100,
    restartDelayMs: 10,
    restartCoalesceMs: 0,
    maxUnparks: 1,
  });
  await supervisor.start();
  // Three quick stops park the app.
  for (let i = 0; i < 3; i++) {
    clock += 1_000;
    links.at(-1)!.exit();
    timers.advance(10);
  }
  assert.equal(downs.at(-1), true, 'parked');
  await supervisor.restart(); // the one allowed un-park
  await until(() => links.length >= 4, 'the engine after the first ask');
  for (let i = 0; i < 3; i++) {
    clock += 1_000;
    links.at(-1)!.exit();
    timers.advance(10);
  }
  assert.equal(downs.at(-1), true, 'parked again');
  const spawned = links.length;
  clock += 6_000;
  await supervisor.restart(); // past the cap: the engine starts, the park count is not cleared
  await until(() => links.length === spawned + 1, 'the engine after the capped ask');
  links.at(-1)!.exit();
  timers.advance(10);
  timers.advance(10);
  assert.equal(links.length, spawned + 1, 'a crash while still parked does not restart it again');
  assert.equal(downs.at(-1), true);
});

test('Engine/restart: a second ask while the quit is pending does not spend an un-park slot', async () => {
  const w = restartWorld();
  await w.supervisor.start();
  w.links[0].link.quit = () => undefined; // slow to quit
  await w.supervisor.restart();
  await w.supervisor.restart();
  await w.supervisor.restart();
  assert.equal(w.restarts.length, 1, 'the host was told once');
});
