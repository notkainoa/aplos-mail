import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearPendingReply,
  getPendingReply,
  setOpenThread,
  type ThreadReply,
} from './store-thread';

const REPLY_ALL: ThreadReply = { replyAll: true, dictate: false, nudge: false };

test('a thread opened for a reply keeps it pending until the reader takes it', () => {
  setOpenThread('t1', { reply: REPLY_ALL });
  assert.deepEqual(getPendingReply(), { id: 't1', reply: REPLY_ALL });
  clearPendingReply();
  assert.equal(getPendingReply(), null);
});

test('opening another thread, plainly, drops a reply that was never taken', () => {
  setOpenThread('t1', { reply: REPLY_ALL });
  setOpenThread('t2');
  assert.equal(getPendingReply(), null);
  setOpenThread(null);
});
