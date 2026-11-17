// The Later chip's short return. Run: cd apps/desktop && npx tsx --test src/renderer/ui/list/laterChip.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatLaterUntilCompact, setFormatClock } from './internal/format';

test('a return inside the next week is "Thu 9 AM"; a past or farther day keeps its date', () => {
  setFormatClock(() => new Date('2026-11-17T12:00:00').getTime());
  try {
    assert.equal(formatLaterUntilCompact('2026-11-17T17:00:00'), 'today 5 PM');
    assert.equal(formatLaterUntilCompact('2026-11-18T09:00:00'), 'tomorrow 9 AM');
    assert.equal(formatLaterUntilCompact('2026-11-19T09:00:00'), 'Thu 9 AM');
    assert.equal(formatLaterUntilCompact('2026-11-19T09:30:00'), 'Thu 9:30 AM');
    assert.equal(formatLaterUntilCompact('2026-11-19T00:00:00'), 'Thu');
    assert.equal(formatLaterUntilCompact('2026-12-05T09:00:00'), 'Sat, Dec 5, 9:00 AM');
  } finally {
    setFormatClock(null);
  }
});
