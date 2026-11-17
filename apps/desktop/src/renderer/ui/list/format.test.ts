// The list family's number formats. Run: cd apps/desktop && npx tsx --test src/renderer/ui/list/format.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes } from './internal/format';

test('attachment sizes use the short unit: "129 B", "4.2 KB", "312 KB", "4.2 MB"', () => {
  assert.equal(formatBytes(129), '129 B');
  assert.equal(formatBytes(4_200), '4.2 KB');
  assert.equal(formatBytes(312_000), '312 KB');
  assert.equal(formatBytes(4_200_000), '4.2 MB');
  assert.equal(formatBytes(-1), '');
});
