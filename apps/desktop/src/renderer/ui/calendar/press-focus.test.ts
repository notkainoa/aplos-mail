/** Pointer presses inside the hours scroller keep focus on the grid root, except the scrollbar and real controls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { keepGridFocus, redirectsToGrid, type PressTarget } from './press-focus';

/** A fake element: `controls` are what `closest` finds for the control selector. */
function target(inControl: boolean): PressTarget {
  return { closest: () => (inControl ? {} : null) };
}

test('an incidental press (track, gutter, slot padding) goes to the grid root', () => {
  const scroller = target(false);
  assert.equal(redirectsToGrid(target(false), scroller), true);
});

test('the scroller itself (its scrollbar) and controls inside keep the default', () => {
  const scroller = target(false);
  assert.equal(redirectsToGrid(scroller, scroller), false);
  assert.equal(
    redirectsToGrid(target(true), scroller),
    false,
    'an entry button takes its own focus',
  );
});

test('keepGridFocus prevents the default and focuses the root once, without scrolling', () => {
  const scroller = target(false);
  const calls: string[] = [];
  const grid = { focus: (o?: FocusOptions) => calls.push(`focus:${o?.preventScroll}`) };
  keepGridFocus(
    { target: target(false), currentTarget: scroller, preventDefault: () => calls.push('prevent') },
    grid,
  );
  assert.deepEqual(calls, ['prevent', 'focus:true']);
});

test('keepGridFocus leaves scrollbar presses, controls and a missing root alone', () => {
  const scroller = target(false);
  const calls: string[] = [];
  const grid = { focus: () => calls.push('focus') };
  const prevent = () => calls.push('prevent');
  keepGridFocus({ target: scroller, currentTarget: scroller, preventDefault: prevent }, grid);
  keepGridFocus({ target: target(true), currentTarget: scroller, preventDefault: prevent }, grid);
  keepGridFocus({ target: target(false), currentTarget: scroller, preventDefault: prevent }, null);
  assert.deepEqual(calls, []);
});

test('a middle or right press keeps the default (autoscroll, context menu) and does not move focus', () => {
  const scroller = target(false);
  for (const button of [1, 2]) {
    const calls: string[] = [];
    const grid = { focus: () => calls.push('focus') };
    keepGridFocus(
      {
        button,
        target: target(false),
        currentTarget: scroller,
        preventDefault: () => calls.push('prevent'),
      },
      grid,
    );
    assert.deepEqual(calls, [], `button ${button}`);
  }
});
