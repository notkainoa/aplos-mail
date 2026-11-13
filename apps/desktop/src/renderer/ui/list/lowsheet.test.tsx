// LowSheet's header count: the view's authoritative total, never the window's row count.
// Regression for the 2026-11-12 packaged build: the Home band said 162 low-importance threads while the sheet
// header said "Low importance 100", because the header summed the materialized window's groups (a bounded page).
// Run: cd apps/desktop && npx tsx --test src/renderer/ui/list/lowsheet.test.tsx

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LowSheetProps } from '../props';
import { html, text } from './testkit.test';
import { noop, row } from './fixtures.test';
import { LowSheet } from './LowSheet';

function sheet(over: Partial<LowSheetProps> = {}): LowSheetProps {
  return {
    open: true,
    binding: { id: 'low', label: 'Low importance' },
    groups: [{ id: 'g-1', sender: 'Leah Okafor', rows: [row()] }],
    armed: false,
    markAllCommandId: 'mail.done',
    onArm: noop,
    onCommitAll: noop,
    onClose: noop,
    ...over,
  };
}

describe('LowSheet header count', () => {
  test('shows the view total when it exceeds the windowed rows', () => {
    // One materialized row, 162 in the view: the header must say 162, not 1.
    const m = html(<LowSheet {...sheet({ total: 162 })} />);
    assert.ok(m.includes('ui-low-sheet__count'), 'the count span renders');
    assert.ok(m.includes('162'), `expected the view total in ${text(m)}`);
  });

  test('falls back to summing the groups when no total is supplied', () => {
    const m = html(
      <LowSheet
        {...sheet({
          groups: [
            { id: 'g-1', sender: 'A', rows: [row({ id: 'r1' }), row({ id: 'r2' })] },
            { id: 'g-2', sender: 'B', rows: [row({ id: 'r3' })] },
          ],
        })}
      />,
    );
    assert.ok(m.includes('3'), `expected the rows' sum in ${text(m)}`);
  });
});
