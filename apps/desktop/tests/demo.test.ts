import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemo } from '../src/main/demo';

test('demo threads carry real summaries rather than copies of the message text', () => {
  const demo = createDemo(new Date(2026, 9, 15, 12));
  for (const thread of demo.threads) {
    const body = thread.messages
      .map(m => m.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    assert.ok(thread.summary.length > 0 && thread.summary.length <= 120, thread.id);
    assert.ok(
      !body.includes(thread.summary.toLowerCase()),
      `${thread.id} summary repeats the body`,
    );
  }
  const sent = demo.threads.find(t => t.messages.some(m => m.sent));
  assert.match(sent!.messages[0].to[0], /^Studio team </);
});
