/**
 * A forward's unsaved text is kept under its own key: opening one must not release a new message's kept text, and
 * a new message must not take a forward's.
 * Run: cd apps/desktop && npx tsx --test src/renderer/screens/compose/runtime/recoveryForward.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshCompose } from '../model/composeState';
import { recoveryKey } from './recovery';

const forward = freshCompose({ accountId: 'a', mode: 'forward', replyToMessageId: 'a:m1' });
const fresh = freshCompose({ accountId: 'a', mode: 'new' });
const reply = freshCompose({ accountId: 'a', mode: 'reply', threadId: 'a:t1' });

test('a forward, a new message and a reply never share a kept-text key', () => {
  const keys = [forward, fresh, reply].map(state => recoveryKey(state));
  assert.deepEqual(keys, ['forward:a:m1', 'new:a', 'reply:a:t1']);
});
