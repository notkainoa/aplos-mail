/** The sidebar slot a screen adds under the place groups: the latest mounted wins, and it clears on unmount. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  addSidebarSlot,
  setSidebarSlot,
  getSidebarSlot,
  subscribeSidebarSlot,
  type SidebarSlot,
} from './store-sidebar';
import { Sidebar } from './Sidebar';
import type { CalendarListProps, MiniMonthProps } from '../ui/props';

const noop = (): void => undefined;

const MONTH: MiniMonthProps = {
  month: '2026-10',
  today: '2026-10-29',
  weekStartsOn: 0,
  onMonthChange: noop,
  onPick: noop,
};

const CALENDARS: CalendarListProps = {
  calendars: [
    { id: 'work', name: 'Work', color: 'sky', visible: true },
    { id: 'home', name: 'Hollow Creek', color: 'hill', visible: false },
  ],
  onToggle: noop,
  onSolo: noop,
};

function sidebar(): string {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      screen: 'calendar',
      counts: {},
      onNavigate: noop,
      onCompose: noop,
      onToggleSidebar: noop,
      accountSwitcher: null,
      status: null,
    }),
  );
}

test('nothing set: no slot', () => {
  assert.equal(getSidebarSlot(), null);
});

test('the latest slot wins and the earlier one returns when it goes', () => {
  const first: SidebarSlot = { miniMonth: MONTH };
  const second: SidebarSlot = { calendars: CALENDARS };
  const removeFirst = addSidebarSlot(first);
  const removeSecond = addSidebarSlot(second);
  assert.equal(getSidebarSlot(), second);
  removeSecond();
  assert.equal(getSidebarSlot(), first);
  removeFirst();
  assert.equal(getSidebarSlot(), null);
});

test('unmounting clears the slot, only winner changes notify, and removing twice or out of order drops nothing else', () => {
  let notified = 0;
  const off = subscribeSidebarSlot(() => (notified += 1));
  const a: SidebarSlot = { miniMonth: MONTH };
  const b: SidebarSlot = { calendars: CALENDARS };
  const removeA = addSidebarSlot(a);
  const removeB = addSidebarSlot(b);
  removeA();
  removeA();
  assert.equal(getSidebarSlot(), b);
  removeB();
  assert.equal(getSidebarSlot(), null);
  assert.equal(notified, 3, 'only changes of the winner notify');
  off();
});

test('the sidebar draws the slot under the groups and above the footer; without one it draws none', () => {
  assert.doesNotMatch(sidebar(), /aplos-sidebar__slot/);
  const remove = addSidebarSlot({ miniMonth: MONTH, calendars: CALENDARS });
  const html = sidebar();
  remove();
  const at = (needle: string): number => html.indexOf(needle);
  assert.ok(at('ui-mini-month') > at('Trash'), 'the month is under the places');
  assert.ok(at('ui-calendar-list') > at('ui-mini-month'), 'the list follows the month');
  assert.ok(at('aplos-sidebar__foot') > at('ui-calendar-list'), 'the footer stays last');
  assert.match(html, /Hollow Creek/);
  assert.match(html, /October 2026/);
  const region = html.match(/<div class="aplos-sidebar__slot"[^>]*>/)?.[0] ?? '';
  assert.equal(
    region,
    '<div class="aplos-sidebar__slot">',
    'a slot that does not scroll is not a tab stop',
  );
});

test('a slot with only one part draws only that part', () => {
  const remove = addSidebarSlot({ calendars: CALENDARS });
  const html = sidebar();
  remove();
  assert.match(html, /ui-calendar-list/);
  assert.doesNotMatch(html, /ui-mini-month/);
});

test('one owner updating its slot keeps its place; the latest mounted owner still wins', () => {
  const ownerA = {};
  const ownerB = {};
  let notified = 0;
  const off = subscribeSidebarSlot(() => (notified += 1));
  const a1: SidebarSlot = { miniMonth: MONTH };
  const b1: SidebarSlot = { calendars: CALENDARS };
  setSidebarSlot(ownerA, a1);
  setSidebarSlot(ownerB, b1);
  assert.equal(getSidebarSlot(), b1);
  // A re-renders with a new object: it must not climb above B.
  const a2: SidebarSlot = { miniMonth: MONTH, calendars: CALENDARS };
  setSidebarSlot(ownerA, a2);
  assert.equal(getSidebarSlot(), b1, 'B, mounted later, still wins');
  assert.equal(notified, 2, 'an update below the winner does not notify');
  // B re-renders: replaced in place, published once.
  const b2: SidebarSlot = { calendars: CALENDARS };
  setSidebarSlot(ownerB, b2);
  assert.equal(getSidebarSlot(), b2);
  assert.equal(notified, 3);
  setSidebarSlot(ownerB, b2);
  assert.equal(notified, 3, 'the same reference does not publish again');
  // B goes: A returns with its latest slot, not the first one it set.
  setSidebarSlot(ownerB, null);
  assert.equal(getSidebarSlot(), a2);
  setSidebarSlot(ownerA, null);
  assert.equal(getSidebarSlot(), null);
  off();
});
