/**
 * The card treatment of the compose page (owner review 2026-11-03): `cardStyle` only sets `data-cards` on the page's
 * root (`aplos-compose`), the default is 'a' (one card; 'off' is DESIGN 7.6 as first written, option B is gone), the
 * fields keep their calm placeholders ("Add a name or email", "Subject", "Write something…"), and the page still owns
 * its one filled button. The looks are compose.css's; nothing else changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { connectDataLayer } from '../../data/connect';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { api, getNow } from '../../data';
import { ComposePageView, type ComposeCardStyle } from './ComposeScreen';
import { freshCompose } from './model/composeState';
import { composeView } from './model/composeView';
import { dataComposeApi } from './runtime/composeApi';
import { createComposeSession, type ComposeSession } from './runtime/session';

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

async function boot() {
  const engine = createFixtureEngine({ scenario: 'demo', clock: defaultNow });
  const scheduler = createManualScheduler();
  const connection = connectDataLayer({
    session: engine.connect(),
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  connection.layer.session.want('settings');
  for (let i = 0; i < 12; i++) {
    await nextTask();
    scheduler.flush();
  }
  const accountId = engine.fixture.store.all('Account')[0]!.id;
  return { connection, accountId };
}

function newMessage(accountId: string): ComposeSession {
  const timers = {
    now: () => getNow(),
    setTimeout: (callback: () => void, ms: number) => {
      const handle = setTimeout(callback, ms);
      return () => clearTimeout(handle);
    },
  };
  return createComposeSession(
    { api: dataComposeApi(api), timers },
    freshCompose({ accountId, mode: 'new' }),
  );
}

function pageWith(session: ComposeSession, cardStyle?: ComposeCardStyle): string {
  const state = session.getState();
  const binding = {
    session,
    state,
    view: composeView(state, getNow(), true, String),
    undoSeconds: 8,
  };
  const props = cardStyle ? { cardStyle } : {};
  return renderToStaticMarkup(createElement(ComposePageView, { binding, props }));
}

test('the compose page root carries the card option; absent, it is a', async () => {
  const world = await boot();
  const session = newMessage(world.accountId);
  try {
    assert.match(pageWith(session), /class="aplos-compose" data-cards="a"/, 'the default is a');
    for (const style of ['off', 'a'] as const) {
      const html = pageWith(session, style);
      assert.match(html, new RegExp(`class="aplos-compose" data-cards="${style}"`));
      assert.match(
        html,
        /class="aplos-compose"[^>]*><section class="ui-composer"/,
        'the root wraps the page',
      );
      assert.match(
        html,
        /aria-label="Subject" placeholder="Subject"/,
        'the subject keeps its words',
      );
      assert.match(html, /placeholder="Add a name or email"/, 'the To placeholder');
      assert.match(html, /placeholder="Write something…"/, 'the body placeholder');
      assert.equal(
        html.match(/data-variant="filled"/g)?.length,
        1,
        'Send is the one filled button',
      );
    }
  } finally {
    session.dispose();
    world.connection.close();
  }
});

test('compose.css styles option a only; off draws what DESIGN 7.6 first drew', () => {
  const css = readFileSync(new URL('./compose.css', import.meta.url), 'utf8');
  assert.match(css, /\.aplos-compose:not\(\[data-cards='off'\]\) \.ui-composer__page \{/);
  assert.match(css, /\.aplos-compose\[data-cards='a'\] /);
  assert.doesNotMatch(css, /data-cards='b'/, 'option B is gone');
  assert.match(css, /\.aplos-screen:has\(> \.aplos-compose\)/, 'the page still fills the pane');
  assert.doesNotMatch(css, /\[data-cards='off'\] /, 'no rule targets off');
  assert.doesNotMatch(
    css,
    /var\(--elev-card\)/,
    'the page card never takes the inline reply’s elevation',
  );
});
