import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '@aplos/contract/contract-error';
import { createLogger } from '../src/diag/log';
import { createEngine, isAbsent, laneExtensions } from '../src/index';
import { buildEngine } from '../src/runtime/engine';
import type { DeadlineRegistry } from '../src/ports';
import type { LaneModuleSource } from '../src/runtime/services';
import { openStore } from '../src/store';
import { T0, tempDb } from './store/helpers';
import { manualClock, testEngine } from './runtime.helpers';

function deps() {
  const file = tempDb();
  const store = openStore(file.open(), { now: () => T0 });
  const clock = manualClock();
  const log = createLogger({ sink: { write: () => {} }, salt: 's', clock });
  return {
    options: { store, clock, log },
    cleanup: () => {
      store.close();
      file.cleanup();
    },
  };
}

const registry: DeadlineRegistry = { register: () => () => {}, changed: () => {} };

test('the root composes the lane modules; ports the host left out answer unavailable', async () => {
  // eng-contract registers the settings writer, eng-views the sender-rule writer, eng-time the submission writer,
  // eng-ai the consent and AI writers, eng-html the image allow-list writer and eng-host the audit, client and
  // retention writers.
  assert.deepEqual(
    laneExtensions().map(extension => extension.lane),
    [
      'eng-contract',
      'eng-views',
      'eng-time',
      'eng-ai',
      'eng-ai',
      'eng-html',
      'eng-host',
      'eng-host',
      'eng-host',
    ],
  );
  const t = await testEngine();
  try {
    const { accounts, deadlines, laneFor, frames } = t.engine.services;
    assert.ok(isAbsent(accounts) && isAbsent(laneFor));
    // eng-time's clock lane fills the `deadlines` stand-in with the real timer loop.
    assert.ok(!isAbsent(deadlines) && !isAbsent(frames));
    assert.doesNotThrow(() => deadlines.changed('nothing registered'), 'a real registry answers');
    assert.throws(
      () => accounts.status('a1'),
      (e: unknown) => e instanceof ContractError && e.type === 'unavailable',
    );
    assert.equal(
      (accounts as unknown as { then?: unknown }).then,
      undefined,
      'awaiting a port is safe',
    );
  } finally {
    await t.cleanup();
  }
});

test('a registry the host injects wins over the clock lane, which leaves its lifecycle to the host', async () => {
  const d = deps();
  try {
    const engine = await createEngine({ ...d.options, ports: { deadlines: registry } });
    assert.equal(engine.services.deadlines, registry);
    await engine.close();
  } finally {
    d.cleanup();
  }
});

test('a lane fills a stand-in port and sees services built before it; start and stop run in order', async () => {
  const d = deps();
  const order: string[] = [];
  const clockLane: LaneModuleSource = {
    lane: 'eng-time',
    extensions: [],
    createModule: () => ({
      services: { deadlines: registry },
      start: () => void order.push('start time'),
      stop: () => void order.push('stop time'),
    }),
  };
  const viewsLane: LaneModuleSource = {
    lane: 'eng-views',
    extensions: [],
    createModule: services => {
      assert.equal(services.deadlines, registry, 'the clock lane ran first');
      return {
        start: () => void order.push('start views'),
        stop: () => void order.push('stop views'),
      };
    },
  };
  try {
    const engine = await buildEngine(d.options, [clockLane, viewsLane]);
    assert.equal(engine.services.deadlines, registry);
    await engine.close();
    assert.deepEqual(order, ['start time', 'start views', 'stop views', 'stop time']);
  } finally {
    d.cleanup();
  }
});

test("a lane cannot replace a host port, a core service or another lane's service", async () => {
  const d = deps();
  const setting = (lane: string, services: object): LaneModuleSource => ({
    lane,
    extensions: [],
    createModule: () => ({ services }),
  });
  try {
    await assert.rejects(
      buildEngine({ ...d.options, ports: { deadlines: registry } }, [
        setting('eng-time', { deadlines: registry }),
      ]),
      /eng-time cannot set services\.deadlines: the host set it/,
    );
    await assert.rejects(
      buildEngine(d.options, [setting('eng-ai', { store: {} })]),
      /the host set it/,
    );
    await assert.rejects(
      buildEngine(d.options, [
        setting('eng-time', { deadlines: registry }),
        setting('eng-ai', { deadlines: registry }),
      ]),
      /eng-ai cannot set services\.deadlines: eng-time set it/,
    );
  } finally {
    d.cleanup();
  }
});

test('a closed engine refuses new connections and closes the open ones', async () => {
  const t = await testEngine();
  const s = t.engine.connect();
  await t.cleanup();
  await assert.rejects(
    s.call('Thread/get', { ids: [] }),
    (e: unknown) => e instanceof ContractError && e.type === 'unavailable',
  );
  assert.throws(
    () => t.engine.connect(),
    (e: unknown) => e instanceof ContractError && e.type === 'unavailable',
  );
});

test('a module cannot write to the services it is given', async () => {
  const d = deps();
  try {
    await assert.rejects(
      buildEngine(d.options, [
        {
          lane: 'eng-ai',
          extensions: [],
          createModule: services => {
            (services as { send: unknown }).send = {};
            return {};
          },
        },
      ]),
      /cannot change services\.send/,
    );
  } finally {
    d.cleanup();
  }
});

test('when a lane fails to start, the lanes already started are stopped', async () => {
  const d = deps();
  const order: string[] = [];
  const lane = (name: string, fails = false): LaneModuleSource => ({
    lane: name,
    extensions: [],
    createModule: () => ({
      start: () => {
        if (fails) throw new Error(`${name} failed`);
        order.push(`start ${name}`);
      },
      stop: () => void order.push(`stop ${name}`),
    }),
  });
  try {
    await assert.rejects(
      buildEngine(d.options, [lane('eng-time'), lane('eng-views'), lane('eng-ai', true)]),
      /eng-ai failed/,
    );
    assert.deepEqual(order, [
      'start eng-time',
      'start eng-views',
      'stop eng-views',
      'stop eng-time',
    ]);
  } finally {
    d.cleanup();
  }
});
