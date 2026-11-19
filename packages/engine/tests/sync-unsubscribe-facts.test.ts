import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccountId, MessageFacts } from '../src/ports';
import { messageWrite } from '../src/sync/facts';
import { listHeaders } from '../src/store/ingest';

/** List-Unsubscribe-Post is sender-controlled: only the exact RFC 8058 value may switch one-click on in the store. */

const ACCOUNT = 'acct' as AccountId;
const URLS = '<https://list.example/u>, <mailto:leave@list.example>';
const EXACT = 'List-Unsubscribe=One-Click';

function facts(post: string | undefined, header: string = URLS): MessageFacts {
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
    list: { listUnsubscribe: header, ...(post === undefined ? {} : { listUnsubscribePost: post }) },
  };
}

function stored(post: string | undefined, header: string = URLS) {
  return messageWrite(ACCOUNT, 'me@mail.example', facts(post, header)).listUnsubscribe;
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

test('a hostile List-Unsubscribe header cannot stall the engine: a 1 MB run of "<" is ignored in well under a second', () => {
  const started = performance.now();
  for (const header of ['<'.repeat(1_000_000), `<https://a.example/u>${'<'.repeat(1_000_000)}`])
    assert.equal(stored(EXACT, header), undefined);
  assert.equal(stored(EXACT, `<${'<'.repeat(8_000)}`), undefined);
  assert.ok(performance.now() - started < 500, `took ${performance.now() - started} ms`);
});

test('a header over 8,192 characters is ignored whole, one at the limit is read', () => {
  const pad = (n: number) => `<https://a.example/${'x'.repeat(n)}>`;
  const atLimit = pad(8_192 - '<https://a.example/>'.length);
  assert.equal(atLimit.length, 8_192);
  assert.deepEqual(stored(undefined, atLimit)?.urls.length, 1);
  assert.equal(stored(undefined, `${atLimit} `), undefined);
  assert.equal(stored(undefined, `${URLS}${' '.repeat(9_000)}`), undefined);
});

test('an entry containing "<" never reaches the store, and what is stored rebuilds a header the executor reads the same way', () => {
  const header = '<https://x.example/<https://list.example/u>, <>, <<>';
  const write = stored(undefined, header);
  assert.deepEqual(write, { urls: ['https://list.example/u'] });
  assert.ok(write?.urls.every(url => !url.includes('<') && !url.includes('>')));
  assert.equal(listHeaders(0, JSON.stringify(write)).listUnsubscribe, '<https://list.example/u>');
  assert.ok(stored(undefined, '<a<b<c>')?.urls.every(url => !url.includes('<')));
});

test('ListHeaders.authenticated reaches the store write only as a real boolean, and only with List-Unsubscribe', () => {
  const verdict = (authenticated: unknown, header: string = URLS) => {
    const f = facts(EXACT, header);
    f.list = { ...f.list, authenticated: authenticated as boolean };
    return messageWrite(ACCOUNT, 'me@mail.example', f).listAuthenticated;
  };
  assert.equal(verdict(true), true);
  assert.equal(verdict(false), false);
  for (const hostile of [undefined, 'true', 1, 'yes', {}, null])
    assert.equal(verdict(hostile), undefined, JSON.stringify(hostile));
  assert.equal(verdict(true, 'no uri here'), undefined, 'no stored List-Unsubscribe, no verdict');
});

test('hdr.list marks a real List-Id only: a lone List-Unsubscribe never fakes a list', () => {
  const lone = messageWrite(ACCOUNT, 'me@mail.example', facts(undefined, URLS));
  assert.equal(lone.hdr?.list, false, 'List-Unsubscribe alone is not a list header');
  const listed = facts(undefined, URLS);
  listed.list = { ...listed.list, listId: 'list.example' };
  const withId = messageWrite(ACCOUNT, 'me@mail.example', listed);
  assert.equal(withId.hdr?.list, true, 'List-Id (with or without List-Unsubscribe) sets the bit');
});
