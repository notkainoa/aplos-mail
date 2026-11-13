// The outbox's stand-ins and focus: a flag where the sidebar is not drawn, and focus that never falls to the page.
// Run: cd apps/desktop && npx tsx --test src/renderer/shell/outbox-host.test.ts
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { focusAfterLeaving, OutboxFlag, OutboxFlagView } from './OutboxHost';
import { paneHeader, ShellLayout } from './Shell';
import { addOutboxNotice, resetOutbox } from './store-outbox';

afterEach(() => {
  resetOutbox();
  Reflect.deleteProperty(globalThis, 'document');
});

const notice = { id: 'n1', message: 'Couldn’t send to Jordan. Your draft is saved.', actions: [] };

function layout(minimised: boolean, collapsed: boolean): string {
  return renderToStaticMarkup(
    createElement(ShellLayout, {
      screen: 'home',
      counts: {},
      minimised,
      chrome: { fullscreen: false, collapsed },
      mac: false,
      onNavigate: () => undefined,
      onCompose: () => undefined,
      onToggleSidebar: () => undefined,
      accountSwitcher: null,
      status: null,
      header: paneHeader(
        'closed',
        () => undefined,
        {},
        () => undefined,
      ),
      toasts: null,
      children: null,
    }),
  );
}

test('the flag draws nothing without a notice and an alert with a name with one', () => {
  assert.equal(
    renderToStaticMarkup(createElement(OutboxFlagView, { count: 0, onPress: () => undefined })),
    '',
  );
  const html = renderToStaticMarkup(createElement(OutboxFlag));
  assert.equal(html, '');
  addOutboxNotice({ ...notice, onAction: () => undefined });
  const shown = renderToStaticMarkup(createElement(OutboxFlag));
  assert.match(shown, /aria-label="Messages that did not send"/);
  assert.match(shown, /data-icon="alert"/);
});

test('the flag stands in when the sidebar is minimised or collapsed, not beside the full sidebar', () => {
  addOutboxNotice({ ...notice, onAction: () => undefined });
  assert.match(layout(true, false), /aria-label="Messages that did not send"/);
  assert.match(layout(false, true), /aria-label="Messages that did not send"/);
  assert.doesNotMatch(layout(false, false), /aplos-outbox-flag/);
});

function fakeItem(id: string, button: object | null) {
  return { dataset: { noticeId: id }, querySelector: () => button };
}

test('focus goes to another notice’s button, else the Settings row', () => {
  const next = { name: 'next' };
  const settings = { name: 'settings' };
  const items = [fakeItem('a', { name: 'a' }), fakeItem('b', next)];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelectorAll: () => items,
      querySelector: () => settings,
    },
  });
  assert.equal(focusAfterLeaving('a'), next);
  assert.equal(focusAfterLeaving('b'), items[0]?.querySelector());
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [items[0]], querySelector: () => settings },
  });
  assert.equal(focusAfterLeaving('a'), settings);
});
