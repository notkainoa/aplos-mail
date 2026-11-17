// The list family's number formats. Run: cd apps/desktop && npx tsx --test src/renderer/ui/list/format.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes, formatMessageTime, setFormatClock } from './internal/format';

test('attachment sizes use the short unit: "129 B", "4.2 KB", "312 KB", "4.2 MB"', () => {
  assert.equal(formatBytes(129), '129 B');
  assert.equal(formatBytes(4_200), '4.2 KB');
  assert.equal(formatBytes(312_000), '312 KB');
  assert.equal(formatBytes(4_200_000), '4.2 MB');
  assert.equal(formatBytes(-1), '');
});

test('a message header time: Today and Yesterday keep their word, older days read "Fri, Nov 13, 10:42 PM"', () => {
  setFormatClock(() => new Date('2026-11-17T12:00:00').getTime());
  try {
    assert.equal(formatMessageTime('2026-11-17T09:15:00'), 'Today, 9:15 AM');
    assert.equal(formatMessageTime('2026-11-16T16:12:00'), 'Yesterday, 4:12 PM');
    assert.equal(formatMessageTime('2026-11-13T22:42:00'), 'Fri, Nov 13, 10:42 PM');
  } finally {
    setFormatClock(null);
  }
});
