import assert from 'node:assert/strict';
import test from 'node:test';
import { Message } from '../src/schemas/mail';

/** The reader's bell field (ui-reader REQUEST): optional and read-only, so absent, sent and suppressed all parse. */
const base = {
  id: 'm1',
  threadId: 't1',
  accountId: 'a1',
  rev: 1,
  to: [],
  cc: [],
  subject: 's',
  snippet: 'sn',
  date: 1,
  seen: false,
  flagged: false,
  answered: false,
  fromMe: false,
  labels: [],
  attachments: [],
  bodyState: 'absent',
};

test('notified accepts sent and suppressed, stays optional, and openEnum stays forward-compatible', () => {
  assert.equal(Message.safeParse({ ...base, notified: 'sent' }).success, true);
  assert.equal(Message.safeParse({ ...base, notified: 'suppressed' }).success, true);
  assert.equal(Message.safeParse(base).success, true, 'absent is fine — the field is optional');
  // openEnum: a value added later parses instead of breaking old clients.
  assert.equal(Message.safeParse({ ...base, notified: 'queued' }).success, true);
  for (const bad of [true, 1, {}])
    assert.equal(Message.safeParse({ ...base, notified: bad }).success, false, String(bad));
});
