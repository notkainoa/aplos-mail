/**
 * The hooks through the frozen surface: `connectDataLayer()` installs the runtime behind `./index.ts`, and React reads
 * the stores with `useSyncExternalStore`. Rendered with `react-dom/server` in node (no DOM, no effects), over windows
 * the test opened first. `cd apps/desktop && npx tsx --test src/renderer/data/hooks.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { harnessClock } from './clock';
import { connectDataLayer } from './connect';
import {
  api,
  DataLayerNotConnectedError,
  getNow,
  HARNESS_NOW_MS,
  setClock,
  undoStack,
  useCounts,
  useHold,
  useHome,
  useNow,
  useOperation,
  useRow,
  useUndoTop,
  useView,
} from './index';
import { createManualScheduler, createManualTimers } from './scheduler';

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

async function settle(flush: () => void) {
  for (let i = 0; i < 20; i++) {
    await nextTask();
    flush();
  }
}

function Home() {
  const hold = useHold('home');
  const home = useHome({ holdIds: hold.heldIds });
  const inbox = useView({ kind: 'mailbox', role: 'inbox' });
  const first = inbox.ids[0];
  const row = useRow('Thread', first);
  const now = useNow({ granularity: 'minute' });
  const top = useUndoTop();
  const op = useOperation(top?.kind === 'operation' ? top.opId : undefined);
  const counts = useCounts();
  return createElement(
    'p',
    null,
    [
      `do ${home.sections[0]!.count}`,
      `inbox ${inbox.ids.length}`,
      `row ${row?.subject ?? 'none'}`,
      `now ${now}`,
      `op ${op?.state ?? 'none'}`,
      `hidden ${counts.hidden}`,
    ].join(' | '),
  );
}

test('the surface throws until a data layer is connected, then serves hooks and api', async () => {
  assert.throws(() => getNow(), DataLayerNotConnectedError);
  const engine = createFixtureEngine({ scenario: 'demo', clock: defaultNow });
  const scheduler = createManualScheduler();
  const connection = connectDataLayer({
    session: engine.connect(),
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  const { layer } = connection;
  try {
    const home = layer.windows.acquire({ kind: 'home' });
    layer.windows.acquire({ kind: 'lowSenders' });
    const inbox = layer.windows.acquire({ kind: 'mailbox', role: 'inbox' });
    await settle(() => scheduler.flush());

    setClock(harnessClock);
    assert.equal(getNow(), HARNESS_NOW_MS);
    const firstHtml = renderToStaticMarkup(createElement(Home));
    const doCount = home
      .snapshot()
      .sections.filter(s => s.key === 'do' || s.key === 'fromLater')
      .reduce((n, s) => n + s.count, 0);
    assert.match(
      firstHtml,
      new RegExp(`do ${doCount} \\| inbox ${inbox.snapshot().ids.length} \\|`),
    );
    assert.match(firstHtml, /row (?!none)/, 'the first inbox row is read from the cache');
    assert.match(firstHtml, new RegExp(`now ${HARNESS_NOW_MS}`));
    assert.match(firstHtml, /op none/);

    const target = inbox.snapshot().ids[0]!;
    const { opId } = api.thread.act({ ids: [target], action: { type: 'done' } });
    assert.deepEqual(undoStack.peek(), { kind: 'operation', id: undoStack.peek()!.id, opId });
    const afterHtml = renderToStaticMarkup(createElement(Home));
    assert.match(afterHtml, /op pending/);
    assert.match(afterHtml, new RegExp(`inbox ${inbox.snapshot().ids.length} \\|`));
    assert.ok(!inbox.snapshot().ids.includes(target));
    await settle(() => scheduler.flush());
  } finally {
    connection.close();
  }
  assert.throws(() => getNow(), DataLayerNotConnectedError, 'closing uninstalls the runtime');
});

test('accountsLoaded flips once Account/get has answered, and stays true', async () => {
  const engine = createFixtureEngine({ scenario: 'demo', clock: defaultNow });
  const scheduler = createManualScheduler();
  const connection = connectDataLayer({
    session: engine.connect(),
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  try {
    const { session } = connection.layer;
    assert.equal(session.accountsLoaded, false);
    session.want('accounts');
    await settle(() => scheduler.flush());
    assert.equal(session.accountsLoaded, true);
    assert.ok(session.accounts.length > 0);
  } finally {
    connection.close();
  }
});
