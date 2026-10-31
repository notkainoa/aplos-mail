import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { windowCaller } from '@aplos/engine';
import type { ComposedHost } from '../../src/host/compose';
import { createProcessState } from '../../src/host/lifecycle';
import {
  createEngineLink,
  createEngineSupervisor,
  createPortBroker,
  draftOpenable,
  realEngineRequested,
  type DesktopFrame,
  type EngineLink,
  type Timers,
  type UtilityRequest,
} from '../../src/host/transports/port';
import { dataDir, fakeClock, fakeWindow, inProcessUtility, portTracker, T0, until } from './rig';

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

const timers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

/** Main's side over in-process engine "processes" on one data folder: supervisor, broker, link, host-channel log. */
function mainSide(t: TestContext, options: { now?: () => number } = {}) {
  const dir = dataDir(t);
  const clock = fakeClock(T0);
  const hosts: ComposedHost[] = [];
  const utilities: ReturnType<typeof inProcessUtility>[] = [];
  const requests: UtilityRequest[] = [];
  const desktop: DesktopFrame[] = [];
  const ups: boolean[] = [];
  const processState = createProcessState();
  const ports = portTracker(t);
  // The broker reads the supervisor's current engine, and the supervisor's hooks use the broker.
  const box: { supervisor?: ReturnType<typeof createEngineSupervisor> } = {};
  const broker = createPortBroker({
    channel: ports.channel,
    link: () => box.supervisor?.current(),
  });
  const supervisor = createEngineSupervisor({
    spawn: (): EngineLink => {
      const utility = inProcessUtility({ dir, clock, hosts });
      utilities.push(utility);
      return createEngineLink(
        utility.child,
        { dataDir: dir, appVersion: '0.3.0-test' },
        {
          hostEvent: () => undefined,
          request: async request => (requests.push(request), 'posted'),
        },
        timers,
      );
    },
    noteExit: () => processState.noteEngineExit((options.now ?? Date.now)()),
    onUp: (_link, restarted) => {
      ups.push(restarted);
      if (restarted) broker.reissue();
    },
    onDown: parked => {
      const frame: DesktopFrame = {
        frame: 'desktop',
        event: { type: 'engine', state: parked ? 'parked' : 'connecting', at: Date.now() },
      };
      desktop.push(frame);
      broker.desktop(frame);
    },
    timers,
    restartDelayMs: 10,
  });
  box.supervisor = supervisor;
  t.after(() => supervisor.close());
  return { dir, clock, hosts, utilities, requests, desktop, ups, broker, supervisor, processState };
}

test('real path: a window gets its own port, Session/get answers, main validates compose through Draft/get', async t => {
  const main = mainSide(t);
  const link = await main.supervisor.start();
  const ready = await link.ready;
  const one = fakeWindow(1);
  main.broker.connect(one.win);

  // Contract-3 has not filled Session/get yet: the real engine answers over the port with the contract's error.
  await assert.rejects(one.client.call('Session/get', {}), { type: 'notImplemented' });
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
