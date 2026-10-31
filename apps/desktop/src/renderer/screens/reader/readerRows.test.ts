/**
 * Thread and message rows as the reader's components want them: the words of the sender line, the earlier-messages
 * line, "Reply to Jordan…" and "N trackers removed", with no engine and no DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../data';
import {
  attachmentChips,
  collapsedOf,
  fromName,
  joinRecipients,
  participantsOf,
  recipientsLabel,
  replyName,
  toLabel,
  trackersLine,
  loadingLabel,
} from './readerRows';

const ME = new Set(['alex@home.example']);

function message(over: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    threadId: 't',
    accountId: 'a',
    rev: 1,
    to: [],
    cc: [],
    subject: 'A quieter home',
    snippet: ' Hi Alex, ',
    date: Date.UTC(2026, 9, 27, 14, 55),
    seen: true,
    flagged: false,
    answered: false,
    fromMe: false,
    labels: [],
    attachments: [],
    bodyState: 'present',
    ...over,
  };
}

const jordan = { address: 'jordan@park.example', name: 'Jordan Park' };
const mina = { address: 'mina@park.example', name: 'Mina Cho' };
const alex = { address: 'alex@home.example', name: 'Alex Morgan' };

test('the sender line says "to you and Mina Cho", the owner first', () => {
  const m = message({ id: 'm1', from: jordan, to: [mina, alex] });
  assert.equal(recipientsLabel(m, ME), 'to you and Mina Cho');
  assert.equal(toLabel(m, ME), 'to you, Mina Cho');
  assert.equal(recipientsLabel(message({ id: 'm2', from: jordan, to: [alex] }), ME), 'to you');
  assert.equal(recipientsLabel(message({ id: 'm3', from: jordan }), ME), 'to no one');
});

test('long recipient lists name three and count the rest', () => {
  assert.equal(joinRecipients(['you', 'A', 'B', 'C', 'D']), 'you, A, B and 2 others');
  assert.equal(joinRecipients(['you', 'A', 'B', 'C']), 'you, A, B and C');
});

test('the owner is "You", everyone else their name or address', () => {
  assert.equal(fromName(message({ id: 'm', from: alex, fromMe: true }), ME), 'You');
  assert.equal(fromName(message({ id: 'm', from: { address: 'x@y.example' } }), ME), 'x@y.example');
  assert.equal(fromName(message({ id: 'm' }), ME), 'No sender');
});

test('"Reply to Jordan…" names the sender, or whom the owner last wrote to', () => {
  assert.equal(replyName(message({ id: 'a', from: jordan, to: [alex] }), ME), 'Jordan');
  assert.equal(replyName(message({ id: 'b', from: alex, fromMe: true, to: [mina] }), ME), 'Mina');
  assert.equal(replyName(message({ id: 'c' }), ME), 'sender');
});

test('earlier messages: first names once each in thread order, one-liners with trimmed previews', () => {
  const earlier = [
    message({ id: 'e1', from: jordan }),
    message({ id: 'e2', from: alex, fromMe: true }),
    message({ id: 'e3', from: jordan }),
    message({ id: 'e4', from: mina }),
  ];
  assert.deepEqual(participantsOf(earlier, ME), ['Jordan', 'you', 'Mina']);
  const line = collapsedOf(earlier[0]!, ME);
  assert.equal(line.preview, 'Hi Alex,');
  assert.equal(line.from, 'Jordan Park');
});

test('trackers: nothing when none, singular and plural otherwise', () => {
  assert.equal(trackersLine(0), null);
  assert.equal(trackersLine(undefined), null, 'a frame that cannot tell says nothing');
  assert.equal(trackersLine(1), '1 tracker removed');
  assert.equal(trackersLine(3), '3 trackers removed');
});

test('loading line: names the subject, else the sender, else nothing (the caller says "this email")', () => {
  const row = (subject: string, fromName: string) => ({ subject, fromName }) as never;
  assert.equal(
    loadingLabel(row('October illustrations', 'Drew Bell')),
    'Loading October illustrations…',
  );
  assert.equal(loadingLabel(row('  ', 'Drew Bell')), 'Loading Drew Bell…');
  assert.equal(loadingLabel(row('', '')), null);
  assert.equal(loadingLabel(undefined), null);
});

test('attachments: file chips only, failed from the engine or from this reading', () => {
  const m = message({
    id: 'm',
    attachments: [
      {
        id: 'a1',
        name: 'layouts.pdf',
        mime: 'application/pdf',
        size: 4_200_000,
        inline: false,
        state: 'present',
      },
      { id: 'a2', name: 'logo.png', mime: 'image/png', size: 100, inline: true, state: 'present' },
      {
        id: 'a3',
        name: 'brief.docx',
        mime: 'application/x',
        size: 9,
        inline: false,
        state: 'failed',
      },
      {
        id: 'a4',
        name: 'map.pdf',
        mime: 'application/pdf',
        size: 9,
        inline: false,
        state: 'present',
      },
    ],
  });
  const opened: string[] = [];
  const chips = attachmentChips(m, new Map([['m:a4', 'failed' as const]]), id => opened.push(id));
  assert.deepEqual(
    chips.map(c => [c.name, c.state]),
    [
      ['layouts.pdf', 'ready'],
      ['brief.docx', 'failed'],
      ['map.pdf', 'failed'],
    ],
  );
  chips[1]!.onRetry?.();
  assert.deepEqual(opened, ['a3']);
});

test('attachments: Open and Retry on a chip that is already downloading start nothing', () => {
  const m = message({
    id: 'm',
    attachments: [
      {
        id: 'a1',
        name: 'a.pdf',
        mime: 'application/pdf',
        size: 9,
        inline: false,
        state: 'present',
      },
    ],
  });
  const started: string[] = [];
  const chips = attachmentChips(m, new Map([['m:a1', 'downloading' as const]]), id =>
    started.push(id),
  );
  chips[0]!.onOpen?.();
  chips[0]!.onRetry?.();
  assert.equal(started.length, 0, 'a second fetch would only race the first');
  const idle = attachmentChips(m, new Map(), id => started.push(id));
  idle[0]!.onOpen?.();
  assert.deepEqual(started, ['a1']);
});
