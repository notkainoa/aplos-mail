import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFieldsMask } from '../src/gmail';
import { setup } from './gmail-helpers';

const sample = {
  nextPageToken: 'tok',
  resultSizeEstimate: 3,
  messages: [
    {
      id: 'a',
      threadId: 't1',
      labelIds: ['INBOX'],
      payload: {
        headers: [{ name: 'Subject', value: 's' }],
        mimeType: 'text/plain',
        body: { size: 3 },
      },
    },
    { id: 'b', threadId: 't2', labelIds: [], payload: { headers: [], mimeType: 'text/html' } },
  ],
};

test('fields masks: top level, lists, nested paths and sub-selections', () => {
  assert.deepEqual(applyFieldsMask(sample, 'nextPageToken'), { nextPageToken: 'tok' });
  assert.deepEqual(applyFieldsMask(sample, 'nextPageToken,resultSizeEstimate'), {
    nextPageToken: 'tok',
    resultSizeEstimate: 3,
  });
  assert.deepEqual(applyFieldsMask(sample, 'messages(id,threadId)'), {
    messages: [
      { id: 'a', threadId: 't1' },
      { id: 'b', threadId: 't2' },
    ],
  });
  assert.deepEqual(applyFieldsMask(sample, 'messages(id,threadId,labelIds,payload/headers)'), {
    messages: [
      {
        id: 'a',
        threadId: 't1',
        labelIds: ['INBOX'],
        payload: { headers: [{ name: 'Subject', value: 's' }] },
      },
      { id: 'b', threadId: 't2', labelIds: [], payload: { headers: [] } },
    ],
  });
  assert.deepEqual(applyFieldsMask(sample, 'messages/id'), {
    messages: [{ id: 'a' }, { id: 'b' }],
  });
  assert.deepEqual(
    (applyFieldsMask(sample, 'messages(payload(headers(name),mimeType))') as typeof sample)
      .messages[0],
    { payload: { headers: [{ name: 'Subject' }], mimeType: 'text/plain' } },
  );
  assert.deepEqual(
    (applyFieldsMask(sample, 'messages/payload/body/size') as typeof sample).messages[0],
    { payload: { body: { size: 3 } } },
  );
});

test('fields masks: wildcard, unknown paths and empty masks', () => {
  assert.equal((applyFieldsMask(sample, 'messages(*)') as typeof sample).messages[0].id, 'a');
  assert.deepEqual(applyFieldsMask(sample, 'nope,nextPageToken'), { nextPageToken: 'tok' });
  assert.deepEqual(
    (applyFieldsMask(sample, 'messages(id,missing/deeper)') as typeof sample).messages[1],
    { id: 'b' },
  );
  assert.deepEqual(applyFieldsMask(sample, 'nope'), {});
  assert.equal(applyFieldsMask(sample, ''), sample);
  assert.deepEqual(applyFieldsMask({ a: 1, b: { c: 2, d: 3 } }, 'b(c)'), { b: { c: 2 } });
});

test('the API applies fields on list, get and thread responses, and ignores them on errors', async () => {
  const h = await setup({ threads: 12, unitsPerMinute: 10_000_000 });
  const messages = await h.api('/messages?maxResults=3&fields=messages(id,threadId),nextPageToken');
  assert.deepEqual(Object.keys(messages.json).sort(), ['messages', 'nextPageToken']);
  assert.deepEqual(Object.keys(messages.json.messages[0]).sort(), ['id', 'threadId']);

  const threads = await h.api('/threads?maxResults=2&fields=threads/id,nextPageToken');
  assert.deepEqual(
    threads.json.threads.map((t: any) => Object.keys(t)),
    [['id'], ['id']],
  );

  const id = messages.json.messages[0].id;
  const message = await h.api(`/messages/${id}?format=full&fields=id,labelIds,payload/headers`);
  assert.ok(message.json.id);
  assert.ok(Object.keys(message.json).every(key => ['id', 'labelIds', 'payload'].includes(key)));
  assert.deepEqual(Object.keys(message.json.payload), ['headers']);

  const thread = await h.api(
    `/threads/${threads.json.threads[0].id}?format=metadata&fields=messages(id,payload/headers)`,
  );
  assert.ok(thread.json.messages[0].payload.headers.length > 0);
  assert.equal(thread.json.id, undefined);

  const error = await h.api('/messages/00000000000000ff?fields=id');
  assert.equal(error.status, 404);
  assert.equal(error.json.error.code, 404);
  // A name the response type does not have is a 400, even when it would select nothing.
  const typo = await h.api('/profile?fields=nonsense');
  assert.equal(typo.status, 400);
  assert.equal(typo.json.error.message, 'Invalid field selection nonsense');
  assert.equal(typo.json.error.errors[0].reason, 'invalidParameter');
  assert.equal(
    (await h.api(`/messages/${id}?fields=payload/header`)).status,
    400,
    'a typo deep in a path is caught',
  );
  assert.equal(
    (await h.api(`/messages/${id}?fields=id/x`)).status,
    400,
    'a scalar has no sub-fields',
  );
  // A real field that this value lacks (no further page) is fine and simply absent.
  const last = await h.api('/labels?fields=labels(id,color/textColor)');
  assert.equal(last.status, 200);
  assert.deepEqual(Object.keys(last.json.labels[0]), ['id']);
  assert.equal(
    (await h.api('/messages?maxResults=500&fields=nextPageToken,*')).status,
    200,
    '* matches anything',
  );
});
