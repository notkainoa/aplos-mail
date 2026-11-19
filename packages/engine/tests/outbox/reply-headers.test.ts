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

/** Both accounts store a message with the SAME remote id `m1`, each under its own Message-ID. */
function storeWithCollision(): StoreReader {
  const rows: Record<string, { internet_id: string; refs: string }> = {
    work: {
      internet_id: '<work-m1@mail.example>',
      refs: JSON.stringify(['<work-root@mail.example>']),
    },
    home: {
      internet_id: '<home-m1@mail.example>',
      refs: JSON.stringify(['<home-root@mail.example>']),
    },
  };
  const get = (_sql: string, account: unknown, remote: unknown) =>
    remote === 'm1' ? rows[account as string] : undefined;
  const all = (_sql: string, except: unknown) =>
    ['home', 'work'].filter(id => id !== except).map(id => ({ id }));
  return { get, all, iterate: () => [][Symbol.iterator]() } as unknown as StoreReader;
}

test('two accounts storing the same remote id: the reply answers the account the message id names', () => {
  const store = storeWithCollision();
  // The parent is `work:m1`, the reply is sent from `home`: work's row, not home's `m1`.
  const fromHome = replyHeaders(store, { account_id: 'home' }, replyFields('home'));
  assert.equal(fromHome.inReplyTo, '<work-m1@mail.example>');
  assert.deepEqual(fromHome.references, ['<work-root@mail.example>', '<work-m1@mail.example>']);
  // And the other way round: the parent is `home:m1`, sent from `work`.
  const fields = { ...replyFields('work'), replyToMessageId: 'home:m1' };
  const fromWork = replyHeaders(store, { account_id: 'work' }, fields);
  assert.equal(fromWork.inReplyTo, '<home-m1@mail.example>');
});
