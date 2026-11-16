import test from 'node:test';
import assert from 'node:assert/strict';
import type { DraftFields } from '@aplos/contract';
import type { StoreReader } from '../../src/store';
import { replyHeaders } from '../../src/outbox/submissions';

const PARENT = { account_id: 'work', remote_id: 'm1', internet_id: '<parent@mail.example>' };

/** A store with two accounts and one message, in `work`. */
function storeWithParent(): StoreReader {
  const get = (_sql: string, account: unknown, remote: unknown) =>
    account === PARENT.account_id && remote === PARENT.remote_id
      ? { internet_id: PARENT.internet_id, refs: JSON.stringify(['<root@mail.example>']) }
      : undefined;
  const all = (_sql: string, except: unknown) =>
    ['home', 'work'].filter(id => id !== except).map(id => ({ id }));
  return { get, all, iterate: () => [][Symbol.iterator]() } as unknown as StoreReader;
}

function replyFields(accountId: string): DraftFields {
  return {
    accountId,
    mode: 'reply',
    threadId: 'work:t1',
    replyToMessageId: 'work:m1',
    to: [],
    cc: [],
    bcc: [],
    subject: 'Re: Plans',
    html: '<p>Yes</p>',
    attachments: [],
    signature: false,
  };
}

test('a reply sent from the thread’s own account carries the parent’s headers', () => {
  const headers = replyHeaders(storeWithParent(), { account_id: 'work' }, replyFields('work'));
  assert.deepEqual(headers, {
    inReplyTo: '<parent@mail.example>',
    references: ['<root@mail.example>', '<parent@mail.example>'],
  });
});

test('a reply switched to another account still threads for the recipient', () => {
  const headers = replyHeaders(storeWithParent(), { account_id: 'home' }, replyFields('home'));
  assert.equal(headers.inReplyTo, '<parent@mail.example>');
  assert.deepEqual(headers.references, ['<root@mail.example>', '<parent@mail.example>']);
});

test('a reply whose parent is not stored in any account goes without reply headers', () => {
  const fields = { ...replyFields('home'), replyToMessageId: 'work:gone' };
  assert.deepEqual(replyHeaders(storeWithParent(), { account_id: 'home' }, fields), {});
});
