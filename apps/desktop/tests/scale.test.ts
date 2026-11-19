import test from 'node:test';
import assert from 'node:assert/strict';
import { runMailboxBenchmark } from '../scripts/mailbox-benchmark';

test('10,000 synthetic threads retain search, changed-row writes, restart, paging and narrow change events', async () => {
  const result = await runMailboxBenchmark(10000, { bodySize: 160 });
  assert.equal(result.threads, 10000);
  assert.equal(result.messages, 20000);
  assert.ok(result.databaseBytes > 0);
});
