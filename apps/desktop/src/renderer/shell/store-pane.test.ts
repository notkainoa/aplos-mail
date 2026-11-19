/** The pane header parts a screen adds: the latest mounted wins, and removing it gives the earlier one back. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  addPaneHeaderPart,
  getPaneHeaderPart,
  mergePaneHeaderPart,
  subscribePaneHeaderPart,
  type PaneHeaderPart,
} from './store-pane';
import { ShellLayout } from './Shell';
import type { PaneHeaderProps } from '../ui/props';

const bulk = (count: number) => ({
  bulk: { count, actions: [], onMore: () => {}, onClear: () => {} },
});

test('nothing set: an empty part', () => {
  assert.deepEqual(getPaneHeaderPart(), {});
});

test('the latest part wins and the earlier one returns when it goes', () => {
  const screen = { crumb: { label: 'Home' } };
  const picked = bulk(3);
  const removeScreen = addPaneHeaderPart(screen);
  const removePicked = addPaneHeaderPart(picked);
  assert.equal(getPaneHeaderPart(), picked);
  removePicked();
  assert.equal(getPaneHeaderPart(), screen);
  removeScreen();
  assert.deepEqual(getPaneHeaderPart(), {});
});

test('removing a part twice, or out of order, never throws or drops another', () => {
  const a = bulk(1);
  const b = bulk(2);
  const removeA = addPaneHeaderPart(a);
  const removeB = addPaneHeaderPart(b);
  removeA();
  removeA();
  assert.equal(getPaneHeaderPart(), b);
  removeB();
  assert.deepEqual(getPaneHeaderPart(), {});
});

const BASE: Pick<PaneHeaderProps, 'ask' | 'today'> = {
  ask: { pressed: false, scope: 'mail', onPress: () => undefined },
  today: { pressed: false, onPress: () => undefined },
};

function readerPart(label: string, onPress: () => void = () => undefined): PaneHeaderPart {
  return {
    lead: { kind: 'back', label: 'Back', commandId: 'nav.back', onPress },
    crumb: { label, position: { index: 1, of: 4 } },
    tools: [{ commandId: 'reader.nextThread', icon: 'chevron-down', label: 'Next email' }],
    askScope: 'thisEmail',
  };
}

test('a part that goes (unmount) clears the header, and only its own contribution', () => {
  let notified = 0;
  const off = subscribePaneHeaderPart(() => (notified += 1));
  const part = readerPart('Home');
  const remove = addPaneHeaderPart(part);
  assert.equal(getPaneHeaderPart(), part);
  remove();
  assert.deepEqual(getPaneHeaderPart(), {});
  assert.equal(notified, 2);
  off();
});

test('a reader part mounted over a bulk bar wins whole: the two never mix', () => {
  const bar = bulk(2);
  const reader = readerPart('Home');
  const removeBar = addPaneHeaderPart(bar);
  const removeReader = addPaneHeaderPart(reader);
  assert.equal(getPaneHeaderPart().bulk, undefined);
  removeReader();
  assert.equal(getPaneHeaderPart().bulk?.count, 2);
  removeBar();
});

test('merge: Ask and Today are added, the ask scope follows the part, a tool press runs through the registry', () => {
  const ran: string[] = [];
  const merged = mergePaneHeaderPart(BASE, readerPart('Home'), id => ran.push(id));
  assert.equal(merged.ask.scope, 'thisEmail');
  assert.equal(merged.today, BASE.today);
  assert.equal(merged.crumb?.label, 'Home');
  merged.onTool?.('reader.nextThread', {} as HTMLElement);
  assert.deepEqual(ran, ['reader.nextThread']);
  assert.equal(mergePaneHeaderPart(BASE, {}, () => undefined).ask, BASE.ask);
});

test('merge: a part with its own onTool handles tool presses itself; a bulk bar gets no tool handler', () => {
  const ran: string[] = [];
  const own: string[] = [];
  const merged = mergePaneHeaderPart(
    BASE,
    { ...readerPart('Home'), onTool: id => own.push(id) },
    id => ran.push(id),
  );
  merged.onTool?.('list.more', {} as HTMLElement);
  assert.deepEqual([own, ran], [['list.more'], []]);
  assert.equal(mergePaneHeaderPart(BASE, bulk(1), () => undefined).onTool, undefined);
});

test('the pane draws the merged header: back, crumb with position, tools, Ask', () => {
  const html = renderToStaticMarkup(
    createElement(ShellLayout, {
      screen: { label: 'thread' },
      counts: {},
      minimised: true,
      chrome: { fullscreen: false, collapsed: false },
      mac: false,
      onNavigate: () => undefined,
      onCompose: () => undefined,
      onToggleSidebar: () => undefined,
      accountSwitcher: null,
      status: null,
      header: mergePaneHeaderPart(BASE, readerPart('Home'), () => undefined),
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
