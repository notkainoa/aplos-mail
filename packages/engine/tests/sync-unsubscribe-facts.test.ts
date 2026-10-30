import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccountId, MessageFacts } from '../src/ports';
import { messageWrite } from '../src/sync/facts';
import { listHeaders } from '../src/store/ingest';

/** List-Unsubscribe-Post is sender-controlled: only the exact RFC 8058 value may switch one-click on in the store. */

const ACCOUNT = 'acct' as AccountId;
const URLS = '<https://list.example/u>, <mailto:leave@list.example>';
const EXACT = 'List-Unsubscribe=One-Click';

function facts(post: string | undefined): MessageFacts {
  return {
    remoteId: 'm1',
    remoteThreadId: 't1',
    to: [],
    cc: [],
    date: 1,
    internalDate: 1,
    flags: { seen: false, flagged: false, draft: false, fromMe: false },
    placements: [],
    partial: false,
    list: { listUnsubscribe: URLS, ...(post === undefined ? {} : { listUnsubscribePost: post }) },
  };
}

function stored(post: string | undefined) {
  return messageWrite(ACCOUNT, 'me@mail.example', facts(post)).listUnsubscribe;
}

const URL_LIST = ['https://list.example/u', 'mailto:leave@list.example'];

test('the exact List-Unsubscribe-Post value (trimmed) stores oneClick, as exactly {urls, oneClick}', () => {
  for (const post of [EXACT, `  ${EXACT} `, `\t${EXACT}\r\n`])
    assert.deepEqual(stored(post), { urls: URL_LIST, oneClick: true }, JSON.stringify(post));
});

test('any other List-Unsubscribe-Post value stores no oneClick', () => {
  for (const post of [
    undefined,
    '',
    '   ',
    'x; list-unsubscribe=one-click-not',
    'list-unsubscribe=one-click',
    'LIST-UNSUBSCRIBE=ONE-CLICK',
    'List-Unsubscribe=One-Click-not',
    'xList-Unsubscribe=One-Click',
    'x; List-Unsubscribe=One-Click',
    'List-Unsubscribe=One-Click; extra=1',
    `${EXACT}, ${EXACT}`,
    `${EXACT}\r\nBcc: a@b.example`,
    `${EXACT} ${EXACT}`,
  ])
    assert.deepEqual(stored(post), { urls: URL_LIST }, JSON.stringify(post));
});

test('what the store reads back is one-click only for the exact value, and the POST header is rebuilt fixed', () => {
  const back = (post: string | undefined) => {
    const write = stored(post);
    return listHeaders(0, JSON.stringify(write));
  };
  assert.equal(back(EXACT).listUnsubscribePost, EXACT);
  assert.equal(back('x; list-unsubscribe=one-click-not').listUnsubscribePost, undefined);
  assert.equal(back(undefined).listUnsubscribePost, undefined);
  assert.equal(
    back(EXACT).listUnsubscribe,
    '<https://list.example/u>, <mailto:leave@list.example>',
  );
});
