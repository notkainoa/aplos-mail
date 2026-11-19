/**
 * The card treatment (owner review 2026-11-03): `cardStyle` only sets `data-cards` on the reader's root, the default
 * is 'a' (each message its own card; 'off' is DESIGN 7.5 as first written, option B is gone), and the letter carries the
 * one layout hook the cards style (`aplos-reader__messages`, the messages without the reply). The looks are reader.css's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { connectDataLayer } from '../../data/connect';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { harnessClock } from '../../data/clock';
import { setClock } from '../../data';
import { setOpenThread } from '../../shell/store-thread';
import { ReaderLetter } from './ReaderLetter';
import { ReaderScreen, type ReaderCardStyle } from './ReaderScreen';
import { freshUi } from './readerUi';

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

async function boot() {
  const engine = createFixtureEngine({ scenario: 'demo', clock: defaultNow });
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
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await nextTask();
      scheduler.flush();
    }
  };
  await settle();
  const threadId = home.snapshot().ids[0]!;
  layer.windows.acquire({ kind: 'thread', threadId });
  await settle();
  return { connection, threadId };
}

function screenWith(cardStyle?: ReaderCardStyle): string {
  return renderToStaticMarkup(createElement(ReaderScreen, cardStyle ? { cardStyle } : {}));
}

test('the reader root carries the card option; absent, it is a', async () => {
  const world = await boot();
  try {
    setOpenThread(world.threadId);
    assert.match(screenWith(), /class="aplos-reader"[^>]*data-cards="a"/, 'the default is a');
    assert.match(screenWith('off'), /class="aplos-reader"[^>]*data-cards="off"/);
    assert.match(screenWith('a'), /class="aplos-reader"[^>]*data-cards="a"/);
    setOpenThread(null);
  } finally {
    world.connection.close();
  }
});

test('the letter wraps its messages, not the reply, in the layout hook the options style', async () => {
  const world = await boot();
  try {
    const html = renderToStaticMarkup(
      createElement(ReaderLetter, {
        threadId: world.threadId,
        paper: true,
        ui: freshUi(world.threadId),
        dispatch: () => undefined,
        controls: {
          suggest: () => undefined,
          later: () => undefined,
          done: () => undefined,
          reply: () => undefined,
          replyAll: () => undefined,
          bookmark: () => undefined,
          trash: () => undefined,
          lane: () => undefined,
          relayKey: () => false,
        },
        onReady: () => undefined,
      }),
    );
    const order = [
      'aplos-reader__thread',
      'aplos-reader__messages',
      'ui-thread-message',
      'ui-reply-stub',
    ].map(part => html.indexOf(part));
    assert.ok(
      order.every(at => at >= 0),
      `all present: ${order}`,
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
    );
    const messages = html.slice(html.indexOf('aplos-reader__messages'));
    const closed = messages.indexOf('</article></div>');
    assert.ok(
      closed >= 0 && closed < messages.indexOf('ui-reply-stub'),
      'the stub sits after the messages hook, not in it',
    );
  } finally {
    world.connection.close();
  }
});

test('reader.css styles option a only; off draws what DESIGN 7.5 first drew', () => {
  const css = readFileSync(new URL('./reader.css', import.meta.url), 'utf8');
  assert.match(css, /\[data-cards='a'\] \.ui-thread-message \{/, 'A: each message is a card');
  assert.doesNotMatch(css, /data-cards='b'/, 'option B is gone');
  assert.doesNotMatch(css, /\[data-cards='off'\] /, 'no rule targets off');
  assert.doesNotMatch(
    css,
    /var\(--elev-card\)/,
    'the cards never take the inline reply’s elevation',
  );
});

test('ReaderMessage is one component with one ThreadMessage, so a fold never remounts the focused toggle', () => {
  const source = readFileSync(new URL('./ReaderMessage.tsx', import.meta.url), 'utf8');
  assert.equal(source.match(/<ThreadMessage/g)?.length, 1, 'one ThreadMessage element in the file');
  assert.equal(source.match(/^export function /gm)?.length, 1, 'one exported component');
  assert.doesNotMatch(source, /FoldedMessage|FullMessage/, 'no second component type per state');
});

test('reader.css is balanced: every block closes (a merge once left one open and nested the card rules under it)', () => {
  const css = readFileSync(new URL('./reader.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"[^"\n]*"|'[^'\n]*'/g, '');
  let depth = 0;
  for (const ch of css) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    assert.ok(depth >= 0, 'a block closes that was never opened');
  }
  assert.equal(depth, 0, 'every block closes');
});
