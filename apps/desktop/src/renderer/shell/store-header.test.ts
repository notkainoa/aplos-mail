import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  clearPaneHeader,
  getPaneHeader,
  mergePaneHeader,
  setPaneHeader,
  subscribePaneHeader,
  type ScreenPaneHeader,
} from './store-header';
import { ShellLayout } from './Shell';
import type { PaneHeaderProps } from '../ui/props';

const BASE: PaneHeaderProps = {
  ask: { pressed: false, scope: 'mail', onPress: () => undefined },
  today: { pressed: false, onPress: () => undefined },
};

function header(label: string, onPress: () => void = () => undefined): ScreenPaneHeader {
  return {
    lead: { kind: 'back', label: 'Back', commandId: 'nav.back', onPress },
    crumb: { label, position: { index: 1, of: 4 } },
    tools: [{ commandId: 'reader.nextThread', icon: 'chevron-down', label: 'Next email' }],
  };
}

const owner = {};
afterEach(() => clearPaneHeader(owner));

test('an equal description from new closures keeps the snapshot and does not notify', () => {
  let notified = 0;
  const off = subscribePaneHeader(() => (notified += 1));
  setPaneHeader(owner, header('Home'));
  const first = getPaneHeader();
  setPaneHeader(owner, header('Home'));
  assert.equal(getPaneHeader(), first);
  assert.equal(notified, 1);
  setPaneHeader(owner, header('Later'));
  assert.notEqual(getPaneHeader(), first);
  assert.equal(notified, 2);
  off();
});

test('the published back button calls the owner latest callback', () => {
  const calls: string[] = [];
  setPaneHeader(
    owner,
    header('Home', () => calls.push('old')),
  );
  setPaneHeader(
    owner,
    header('Home', () => calls.push('new')),
  );
  getPaneHeader()?.lead?.onPress();
  assert.deepEqual(calls, ['new']);
});

test('only the owner clears; a null description clears too', () => {
  setPaneHeader(owner, header('Home'));
  clearPaneHeader({});
  assert.ok(getPaneHeader());
  setPaneHeader(owner, null);
  assert.equal(getPaneHeader(), null);
  setPaneHeader(owner, header('Home'));
  clearPaneHeader(owner);
  assert.equal(getPaneHeader(), null);
});

test('a newer owner replaces the header and the older one cannot clear it', () => {
  const next = {};
  setPaneHeader(owner, header('Home'));
  setPaneHeader(next, header('Later'));
  clearPaneHeader(owner);
  assert.equal(getPaneHeader()?.crumb?.label, 'Later');
  clearPaneHeader(next);
  assert.equal(getPaneHeader(), null);
});

test('merge: none gives the shell header; a screen header keeps Ask and Today and runs tools through the registry', () => {
  assert.equal(
    mergePaneHeader(BASE, null, () => undefined),
    BASE,
  );
  const ran: string[] = [];
  const merged = mergePaneHeader(BASE, { ...header('Home'), askScope: 'thisEmail' }, id =>
    ran.push(id),
  );
  assert.equal(merged.ask.scope, 'thisEmail');
  assert.equal(merged.today, BASE.today);
  assert.equal(merged.crumb?.label, 'Home');
  merged.onTool?.('reader.nextThread', {} as HTMLElement);
  assert.deepEqual(ran, ['reader.nextThread']);
});

test('merge: a header with its own onTool handles tool presses itself', () => {
  const ran: string[] = [];
  const own: string[] = [];
  const merged = mergePaneHeader(BASE, { ...header('Home'), onTool: id => own.push(id) }, id =>
    ran.push(id),
  );
  merged.onTool?.('list.more', {} as HTMLElement);
  assert.deepEqual([own, ran], [['list.more'], []]);
});

test('the pane draws the merged header: back, crumb with position, tools, Ask', () => {
  const html = renderToStaticMarkup(
    createElement(ShellLayout, {
      screen: { label: 'thread' },
      counts: {},
      minimised: true,
      onNavigate: () => undefined,
      onCompose: () => undefined,
      accountSwitcher: null,
      status: null,
      header: mergePaneHeader(BASE, header('Home'), () => undefined),
      toasts: null,
      children: null,
    }),
  );
  assert.match(html, /aria-label="Back"/);
  assert.match(html, /Home/);
  assert.match(html, /1 of 4/);
  assert.match(html, /Next email/);
  assert.match(html, /Ask/);
});
