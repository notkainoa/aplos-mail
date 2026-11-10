// The focus-restore helpers behind DESIGN 11.2's "focus is never lost on commit": which row a control
// sat in (`focusRowId`), and which element takes its place once that control is gone (`focusRowTarget`).
// Run: npx tsx --test src/renderer/screens/settings/rowFocus.test.ts   (from apps/desktop)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { focusRowId, focusRowTarget } from './rowFocus';

/** A minimal stand-in for the few DOM calls the helpers make, so their choices are tested in Node. */
function fakeRow(labelId: string) {
  return {
    querySelector: (selector: string) =>
      selector === '.ui-setting-row__label[id]' ? { id: labelId } : null,
  };
}

const controlIn = (row: object | null) =>
  ({ closest: (selector: string) => (selector === '.settings-anchor' ? row : null) }) as Element;

const rootWith = (rows: readonly object[]) =>
  ({
    querySelectorAll: (selector: string) => (selector === '.settings-anchor' ? rows : []),
  }) as unknown as ParentNode;

describe('focusRowId', () => {
  test('names the row a control sits in by its label id', () => {
    const row = fakeRow('set-calendar-calendarPermission-acct-1');
    assert.equal(focusRowId(controlIn(row)), 'set-calendar-calendarPermission-acct-1');
  });

  test('is null outside a settings-anchor row and for a row with no labelled SettingRow', () => {
    assert.equal(focusRowId(controlIn(null)), null);
    const anchor = { querySelector: () => null };
    assert.equal(focusRowId(controlIn(anchor)), null);
  });
});

describe('focusRowTarget', () => {
  test('returns the still-standing row the lost control lived in', () => {
    const gone = fakeRow('set-calendar-calendarPermission-acct-2');
    const row = fakeRow('set-calendar-calendarPermission-acct-1');
    const root = rootWith([row, gone]);
    assert.equal(
      focusRowTarget('set-calendar-calendarPermission-acct-1', root),
      row as unknown as HTMLElement,
    );
  });

  test('is null for a row that left with its control, an unknown id and no record', () => {
    const root = rootWith([fakeRow('set-calendar-calendarPermission-acct-1')]);
    assert.equal(focusRowTarget('set-calendar-calendarPermission-acct-9', root), null);
    assert.equal(focusRowTarget(null, root), null);
  });
});
