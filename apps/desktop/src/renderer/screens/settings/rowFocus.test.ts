// The focus-restore helpers behind DESIGN 11.2's "focus is never lost on commit": which row a control
// sat in (`focusRowId`), and which element takes its place once that control is gone (`focusRowTarget`).
// Run: npx tsx --test src/renderer/screens/settings/rowFocus.test.ts   (from apps/desktop)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { focusRowId, focusRowTarget, removedRowTarget } from './rowFocus';

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

describe('removedRowTarget', () => {
  test('names the row that moved into the removed row’s place', () => {
    assert.equal(
      removedRowTarget(
        ['set-general-tools-a', 'set-general-tools-b', 'set-general-tools-c'],
        ['set-general-tools-a', 'set-general-tools-c'],
        'set-general-addTool',
      ),
      'set-general-tools-c',
      'the next row still standing',
    );
    assert.equal(
      removedRowTarget(
        ['set-general-tools-a', 'set-general-tools-b'],
        ['set-general-tools-b'],
        'set-general-addTool',
      ),
      'set-general-tools-b',
      'the first row leaves the second in its place',
    );
  });

  test('falls back to the previous row, then to the group’s stable row', () => {
    assert.equal(
      removedRowTarget(
        ['set-general-tools-a', 'set-general-tools-b'],
        ['set-general-tools-a'],
        'set-general-addTool',
      ),
      'set-general-tools-a',
      'the last row leaves the one before it',
    );
    assert.equal(
      removedRowTarget(['set-general-tools-a'], [], 'set-general-addTool'),
      'set-general-addTool',
      'an emptied list lands on Add a tool',
    );
  });

  test('is null when nothing left the list', () => {
    assert.equal(removedRowTarget(['a', 'b'], ['a', 'b'], 'add'), null, 'no removal, no move');
    assert.equal(removedRowTarget(['a'], ['a', 'b'], 'add'), null, 'a growth is not a removal');
  });
});
