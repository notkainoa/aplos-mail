/**
 * The new renderer entry's boot proof (`renderer/App.tsx`) against a live stand-in engine (F6), in node with no DOM.
 * Run: `cd apps/desktop && npx tsx --test src/renderer/shell/app.test.ts`.
 *
 * `main.tsx` only picks the path and mounts `<App client>`; everything App draws comes from `watchHome` (the window
 * and its frames) and `HomeContent` (the lines), so this boots the stand-in the way `main.tsx` does, watches Home,
 * and renders `HomeContent` to static markup with react-dom/server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultNow } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';
import { connectStandIn } from '../data/standin';
import type { WindowBody } from '../data';
import {
  HomeContent,
  handledLine,
  homeLines,
  sectionCount,
  watchHome,
  type AppClient,
  type HomeState,
} from '../App';

/** A fake-clock stand-in, so frames move only when the test advances the clock. */
function boot(scenario: 'demo' | 'empty' = 'demo') {
  return connectStandIn({ scenario, clock: defaultNow });
}

/** Watches Home and records every reported state; `until(pred)` resolves with the first state (latest seen, or next) that passes, or rejects after 2 s. */
function record(client: AppClient) {
  const seen: HomeState[] = [];
  const waiters: Array<{ pred: (s: HomeState) => boolean; resolve: (s: HomeState) => void }> = [];
  const stop = watchHome(client, state => {
    seen.push(state);
    for (const w of [...waiters]) {
      if (w.pred(state)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(state);
      }
    }
  });
  const until = (pred: (s: HomeState) => boolean): Promise<HomeState> => {
    const last = seen.at(-1);
    if (last && pred(last)) return Promise.resolve(last);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no matching Home state within 2 s')), 2_000);
      waiters.push({
        pred,
        resolve: s => {
          clearTimeout(timer);
          resolve(s);
        },
      });
    });
  };
  return { seen, until, stop };
}

const live = (state: HomeState): state is Extract<HomeState, { status: 'live' }> =>
  state.status === 'live';

/** Strips tags, for reading markup as text. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

test('Home lines: Do now includes Back from Later, Low is the band, unknown keys are skipped', () => {
  const window = {
    sections: [
      { key: 'do', count: 4 },
      { key: 'fromLater', count: 1 },
      { key: 'update', count: 1 },
      { key: 'low', count: 2, senders: ['Parcel Trail', 'Field Notes'] },
      { key: 'follow', count: 1 },
      { key: 'fromANewerEngine', count: 9 },
    ],
  } as unknown as WindowBody;
  assert.equal(sectionCount(window.sections[0]!, window.sections), 5);
  assert.equal(sectionCount(window.sections[1]!, window.sections), 1);
  assert.deepEqual(homeLines(window), [
    { kind: 'section', key: 'do', label: 'Do now', variant: 'section', count: 5 },
    { kind: 'section', key: 'fromLater', label: 'Back from Later', variant: 'sub', count: 1 },
    { kind: 'section', key: 'update', label: 'Important updates', variant: 'section', count: 1 },
    { kind: 'low', count: 2, senders: ['Parcel Trail', 'Field Notes'] },
    { kind: 'section', key: 'follow', label: 'Follow up', variant: 'section', count: 1 },
  ]);
  assert.equal(handledLine(1), 'You handled 1 email');
  assert.equal(handledLine(12), 'You handled 12 emails');
});

test('the demo mailbox boots into section headers and one Low band', async () => {
  const { client, close } = boot();
  const home = record(client);
  try {
    const state = await home.until(live);
    assert.ok(live(state));
    const lines = homeLines(state.window);
    assert.deepEqual(
      lines.map(l => (l.kind === 'low' ? 'low' : l.key)),
      state.window.sections.map(s => s.key),
      'every demo section is a known key, in window order',
    );
    const low = lines.find(l => l.kind === 'low');
    assert.ok(low && low.count > 0 && low.senders.length > 0, 'the demo has Low importance mail');

    const html = renderToStaticMarkup(createElement(HomeContent, { home: state }));
    assert.equal(html.match(/class="ui-low-band"/g)?.length, 1, 'Low is one band line');
    assert.equal(text(html).match(/Low importance/g)?.length, 1, 'Low is never also a header');
    for (const line of lines) {
      if (line.kind === 'section') assert.ok(text(html).includes(line.label), line.label);
    }
  } finally {
    home.stop();
    close();
  }
});

test('an empty mailbox shows the handled line, a failure its sentence, opening nothing', async () => {
  const { client, close } = boot('empty');
  const home = record(client);
  try {
    const state = await home.until(live);
    const html = renderToStaticMarkup(createElement(HomeContent, { home: state }));
    assert.match(text(html), /^You handled 0 emails$/);
  } finally {
    home.stop();
    close();
  }
  const failed: HomeState = {
    status: 'failed',
    error: { type: 'unavailable', message: 'Aplos can’t reach its mail engine.' },
  };
  assert.match(
    text(renderToStaticMarkup(createElement(HomeContent, { home: failed }))),
    /reach its mail engine/,
  );
  assert.equal(
    renderToStaticMarkup(createElement(HomeContent, { home: { status: 'opening' } })),
    '',
  );
});

test('window frames and Counts changes keep Home current, and a reset frame reopens it', async () => {
  const { client, engine, close } = boot();
  const control = fixtureControl(engine);
  const home = record(client);
  try {
    const first = await home.until(live);
    assert.ok(live(first));

    // Done on one thread: a window frame drops it and the Counts change re-reads handledToday.
    const target = first.window.ids[0]!;
    await client.api.thread.act({ opId: 'op-app-done', ids: [target], action: { type: 'done' } });
    await control.advanceClock({ ms: 300 });
    const done = await home.until(
      s => live(s) && !s.window.ids.includes(target) && s.handledToday > first.handledToday,
    );
    assert.ok(live(done) && done.window.windowId === first.window.windowId);

    // A restore voids every window and starts a new epoch: Home opens a new window on its own.
    await control.reset({ reason: 'restore' });
    await control.advanceClock({ ms: 300 });
    const reopened = await home.until(s => live(s) && s.window.windowId !== first.window.windowId);
    assert.ok(live(reopened));
    assert.notEqual(reopened.window.state.dbEpoch, first.window.state.dbEpoch);
    assert.ok(!reopened.window.ids.includes(target), 'the reopened window still has Done applied');
  } finally {
    home.stop();
    close();
  }
});
