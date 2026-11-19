import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMenuRefresh,
  engineSyncFacts,
  type MenuEntry,
  type SyncFacts,
} from '../../src/host/menu-bar';
import { fakeWindow, mainSide } from './rig';

/**
 * The menu-bar status line on the real engine path, end to end: the poll `main/lifecycle.ts` runs fills a
 * cache that the menu's refresh (`main/menu-bar.ts`, both through the same host/menu-bar.ts functions the app
 * uses) reads on every tick. While `Account/get` was off the control list the link refused the call, the
 * cache never filled, and the line sat on "Starting…" for the whole session (#541's follow-up).
 */
test('real path: the tray poll answers Account/get and the rebuilt menu follows the cache', async t => {
  const main = mainSide(t);
  const link = await main.supervisor.start();
  await link.ready;
  let menuSync: SyncFacts | undefined;
  const poll = async () => {
    try {
      menuSync =
        (await engineSyncFacts((method, args, timeoutMs) => link.call(method, args, timeoutMs))) ??
        menuSync;
    } catch {
      // A down or slow engine keeps the last answer.
    }
  };
  const labels = (entries: MenuEntry[]) =>
    entries.flatMap(entry => (entry.type === 'item' ? [entry.label] : []));
  const built: string[][] = [];
  const refresh = createMenuRefresh(
    { sync: () => menuSync, pausedUntil: () => undefined },
    entries => built.push(labels(entries)),
  );
  refresh();
  assert.deepEqual(built, [
    ['Starting…', 'Open Aplos', 'Pause sync for 1 hour', 'Quit Aplos completely'],
  ]);

  // No accounts yet: an honest "caught up" line, never a stuck "Starting…".
  await poll();
  refresh();
  assert.equal(built.at(-1)?.[0], 'Caught up');

  // Two caught-up demo accounts read as the up-to-date line.
  const win = fakeWindow(1);
  main.broker.connect(win.win);
  const demo = (await win.client.call('Demo/load', {})) as { accountIds: string[] };
  assert.equal(demo.accountIds.length, 2);
  await poll();
  refresh();
  assert.equal(built.at(-1)?.[0], 'Up to date · 2 accounts');
  refresh();
  assert.equal(built.length, 3, 'an unchanged tick does not rebuild the menu');
});
