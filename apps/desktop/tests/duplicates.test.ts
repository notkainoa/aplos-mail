import test from 'node:test';
import assert from 'node:assert/strict';
import type { Thread } from '@aplos/contract/legacy/types';
import { olderInboxDuplicates } from '@aplos/engine/legacy/duplicates';

const copy = (id: string, date = '2026-10-18T12:00:00Z'): Thread => ({
  id,
  accountId: 'a',
  remoteId: id,
  subject: 'Original studio update',
  summary: '',
  date,
  unread: true,
  status: 'new',
  importance: 'important',
  bookmarked: false,
  replyStatus: 'none',
  labels: ['INBOX', 'UNREAD'],
  messages: [
    {
      id: `${id}-message`,
      internetId: `<${id}@example.test>`,
      date,
      from: 'ari@example.test',
      fromName: 'Ari',
      to: ['alex@example.test'],
      text: 'The studio opens at 10.',
      html: '<p>The studio opens at 10.</p>',
      attachments: [],
    },
  ],
});
const older = (threads: Thread[], arrivals: string[], protectedIds: string[] = []) =>
  olderInboxDuplicates(threads, 'a', new Set(arrivals), new Set(protectedIds))
    .map(t => t.id)
    .sort();

test('exact duplicates keep the newest delivery across initial and incremental batches, independent of input order', () => {
  const first = copy('first', '2026-10-18T10:00:00Z'),
    second = copy('second', '2026-10-18T11:00:00Z'),
    last = copy('last');
  assert.deepEqual(older([last, first, second], ['first', 'second', 'last']), ['first', 'second']);
  assert.deepEqual(older([first, last, second], ['last']), ['first', 'second']);
  assert.deepEqual(
    older([last, first], ['first']),
    ['first'],
    'a late download of old mail cannot replace the newest copy',
  );
  assert.deepEqual(
    older([copy('existing'), copy('incoming')], ['incoming']),
    ['existing'],
    'equal delivery timestamps prefer the newly seen copy',
  );
  assert.deepEqual(older([first, last], []), [], 'a flag-only sync never sweeps unrelated mail');
  assert.deepEqual(older([first, last], ['last'], ['first']), [], 'an edit made during sync wins');
});

test('duplicate detection requires matching people and complete content, including history and known attachment bytes', () => {
  const first = copy('first'),
    last = copy('last', '2026-10-18T13:00:00Z');
  const changed: Array<(t: Thread) => void> = [
    t => {
      t.accountId = 'other';
    },
    t => {
      t.status = 'done';
    },
    t => {
      t.status = 'later';
    },
    t => {
      t.status = 'trash';
    },
    t => {
      t.status = 'spam';
    },
    t => {
      t.labels = [];
    },
    t => {
      t.subject += '!';
    },
    t => {
      t.messages[0].from = 'someone@example.test';
    },
    t => {
      t.messages[0].fromName = 'Someone';
    },
    t => {
      t.messages[0].to = ['someone@example.test'];
    },
    t => {
      t.messages[0].cc = ['someone@example.test'];
    },
    t => {
      t.messages[0].text += '!';
    },
    t => {
      t.messages[0].html += '<br>';
    },
    t => {
      t.messages[0].quoted = 'Different history';
    },
    t => {
      t.messages.unshift({ ...t.messages[0], id: 'prior', text: 'Earlier conversation' });
    },
    t => {
      t.messages[0].sent = true;
    },
  ];
  for (const mutate of changed) {
    const different = structuredClone(first);
    mutate(different);
    assert.deepEqual(older([different, last], ['last']), []);
  }
  const attachment = {
    id: 'file',
    remoteId: 'remote-file',
    name: 'notes.txt',
    type: 'text/plain',
    size: 3,
  };
  first.messages[0].attachments = [{ ...attachment }];
  last.messages[0].attachments = [{ ...attachment }];
  assert.deepEqual(
    older([first, last], ['last']),
    [],
    'same attachment metadata does not prove same file',
  );
  first.messages[0].attachments[0].data = 'b25l';
  last.messages[0].attachments[0].data = 'dHdv';
  assert.deepEqual(older([first, last], ['last']), [], 'different file bytes keep both');
  last.messages[0].attachments[0].data = 'b25l';
  last.messages[0].attachments[0].id = 'different-download-id';
  assert.deepEqual(older([first, last], ['last']), ['first']);
  first.messages[0].text = '';
  delete first.messages[0].html;
  last.messages[0].text = '';
  delete last.messages[0].html;
  assert.deepEqual(older([first, last], ['last']), [], 'missing bodies cannot prove equality');
});
