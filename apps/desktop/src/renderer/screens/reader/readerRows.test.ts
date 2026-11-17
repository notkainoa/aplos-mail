/**
 * Thread and message rows as the reader's components want them: the words of the sender line, the earlier-messages
 * line, "Reply to Jordan…" and "N trackers removed", with no engine and no DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../data';
import {
  attachmentChips,
  excerptOf,
  excerptView,
  fromName,
  joinRecipients,
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

test('a message header says "to you, Mina Cho", the owner first', () => {
  const m = message({ id: 'm1', from: jordan, to: [mina, alex] });
  assert.equal(toLabel(m, ME), 'to you, Mina Cho');
  assert.equal(toLabel(message({ id: 'm2', from: jordan, to: [alex] }), ME), 'to you');
  assert.equal(toLabel(message({ id: 'm3', from: jordan }), ME), 'to no one');
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
  assert.equal(replyName(message({ id: 'c' }), ME), '');
  // The owner wrote last to no one else (a note to self, or no recipient loaded): no one to name.
  assert.equal(replyName(message({ id: 'd', from: alex, fromMe: true, to: [alex] }), ME), '');
  assert.equal(replyName(message({ id: 'e', from: alex, fromMe: true, to: [] }), ME), '');
  assert.equal(replyName(message({ id: 'f', from: alex, to: [mina] }), ME), 'Mina');
});

test('"Reply to …" says a person\'s first name and a business\'s whole name', () => {
  const trail = { name: 'Trail Journal', address: 'hello@trail.example' };
  const library = { name: 'Maple Library', address: 'hello@library.example' };
  const pottery = { name: 'Rowan Pottery', address: 'classes@pottery.example' };
  const park = { name: 'Jordan Park', address: 'jordan.park@work.example' };
  assert.equal(replyName(message({ id: 't', from: trail, to: [alex] }), ME), 'Trail Journal');
  assert.equal(replyName(message({ id: 'l', from: library, to: [alex] }), ME), 'Maple Library');
  assert.equal(replyName(message({ id: 'p', from: pottery, to: [alex] }), ME), 'Rowan Pottery');
  assert.equal(replyName(message({ id: 'j', from: park, to: [alex] }), ME), 'Jordan');
  const noMatch = { name: 'Dana Whitfield', address: 'dw@work.example' };
  assert.equal(replyName(message({ id: 'd', from: noMatch, to: [alex] }), ME), 'Dana');
});

test('a compact card shows the first sentence or two; only a cut sentence ends in an ellipsis', () => {
  const excerpt = (snippet: string) => excerptOf(message({ id: 'x', snippet }));
  assert.equal(excerpt('Hi Alex,'), 'Hi Alex', 'a message that is only a greeting keeps it');
  assert.equal(
    excerpt('Hi Alex, The first pass of the brochure is ready. Tell me what you think. Mina'),
    'The first pass of the brochure is ready. Tell me what you think.',
    'the salutation is skipped, two whole sentences keep their full stop',
  );
  assert.equal(excerpt('Hello Mina and Jordan, thanks both.'), 'thanks both.');
  assert.equal(
    excerpt('Can you send the first draft by Friday? Mina'),
    'Can you send the first draft by Friday?',
    'a whole question keeps its mark, never "Friday?…"',
  );
  assert.equal(excerpt('Sounds   good\n to me!  Ship it.'), 'Sounds good to me! Ship it.');
  assert.equal(excerpt('Thanks… and more'), 'Thanks… and more');
  assert.equal(excerpt(''), '', 'no text: the card says "No preview"');
  assert.equal(excerpt('  \n\t '), '');
  const long = excerpt(`${'word '.repeat(60)}end.`);
  assert.ok(long.endsWith('…') && long.length <= 151, 'a long first sentence is cut at a word');
  assert.doesNotMatch(long, / …$|[.?!]…$/, 'no dangling space or full stop before the ellipsis');
});

test('trackers: nothing when none, singular and plural otherwise', () => {
  assert.equal(trackersLine(0), null);
  assert.equal(trackersLine(undefined), null, 'a frame that cannot tell says nothing');
  assert.equal(trackersLine(1), '1 tracker removed');
  assert.equal(trackersLine(3), '3 trackers removed');
});

test('loading line: names the subject, else the sender, else nothing (the caller says "this email")', () => {
  const row = (subject: string, fromName: string, participants: unknown[] = []) =>
    ({ subject, fromName, participants }) as never;
  assert.equal(
    loadingLabel(row('October illustrations', 'Drew Bell')),
    'Loading October illustrations…',
  );
  assert.equal(loadingLabel(row('  ', 'Drew Bell')), 'Loading Drew Bell…');
  assert.equal(loadingLabel(row('', '')), null);
  const me = { name: 'Kainoa Newton', address: 'owner@mail.example', me: true };
  const leah = { name: 'Leah Okafor', address: 'leah@harbor-table.example' };
  assert.equal(
    loadingLabel(row('', 'Kainoa Newton', [me, leah])),
    'Loading Leah Okafor…',
    'the owner answered last: the other person',
  );
  assert.equal(
    loadingLabel(row('', '  \u202eLeah\u0000   Okafor  ')),
    'Loading Leah Okafor…',
    'bidi overrides and control characters are cleaned',
  );
  assert.equal(loadingLabel(row('Re:\u202e fish', 'x')), 'Loading Re: fish…');
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

test('an excerpt with no space to cut at is cut hard at 150 code points, never to one character', () => {
  const excerpt = (snippet: string) => excerptOf(message({ id: 'x', snippet }));
  const long = excerpt('x'.repeat(400));
  assert.equal(long, `${'x'.repeat(150)}…`);
  const kana = excerpt('こ'.repeat(300));
  assert.equal(Array.from(kana).length, 151, '150 characters and the ellipsis');
  const emoji = excerpt('😀'.repeat(200));
  assert.equal(Array.from(emoji).length, 151);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no half of a surrogate pair');
  assert.ok(excerpt(`a ${'y'.repeat(300)}`).length > 100, 'a short first word does not leave "a…"');
});

test('CJK sentence ends close an excerpt, and an abbreviation is not a sentence', () => {
  const excerpt = (snippet: string) => excerptOf(message({ id: 'x', snippet }));
  // With an attachment the card is never whole, so the first two sentences show and the dropped third earns " …".
  assert.equal(
    excerptOf(
      message({
        id: 'x',
        snippet: '了解しました。明日の朝までに送ります。よろしくお願いします。',
        attachments: [
          {
            id: 'f',
            name: 'a.pdf',
            mime: 'application/pdf',
            size: 1,
            inline: false,
            state: 'absent',
          },
        ],
      }),
    ),
    '了解しました。明日の朝までに送ります。 …',
  );
  assert.equal(excerpt('今日は晴れです！'), '今日は晴れです！');
  assert.equal(
    excerpt('Dr. Okafor will join the call on Thursday. Please send the notes before then.'),
    'Dr. Okafor will join the call on Thursday. Please send the notes before then.',
  );
  assert.match(
    excerpt('Ok. Sounds good to me, I will bring the samples on Monday morning.'),
    /^Ok\. Sounds good/,
  );
  assert.equal(excerpt('e.g. the north wall.'), 'e.g. the north wall.');
});

test('a short message the folded card shows whole is complete: no "…", nothing to open', () => {
  const view = (snippet: string, over: Partial<Message> = {}) =>
    excerptView(message({ id: 'x', snippet, ...over }));
  assert.deepEqual(
    view('Hi Alex, Thanks both. Two directions coming tomorrow: one quieter, one denser. Jordan'),
    {
      text: 'Thanks both. Two directions coming tomorrow: one quieter, one denser.',
      complete: true,
    },
  );
  assert.deepEqual(
    view('Sounds good. I will bring the samples. See you Monday. Best, Mina Cho'),
    { text: 'Sounds good. I will bring the samples. See you Monday.', complete: true },
    'three short sentences are shown whole; the sign-off is left out like the salutation',
  );
  const attached = view('Here is the brief.', {
    attachments: [
      { id: 'f', name: 'a.pdf', mime: 'application/pdf', size: 1, inline: false, state: 'absent' },
    ],
  });
  assert.equal(attached.complete, false, 'an attachment is something to open');
  assert.equal(attached.text, 'Here is the brief.', 'only the sign-off-free text, so no "…"');
  const near = `${'Word '.repeat(23)}end. More here.`;
  assert.equal(
    view(near).complete,
    false,
    'a snippet near the provider limit may be cut: keep the chevron',
  );
  assert.equal(view('').complete, false, 'no text: "No preview" and a chevron');
});

test('"…" marks text left out: a sentence cut short, or whole sentences dropped', () => {
  const long =
    'The layout review moved to Thursday at two in the Oak room. Please bring the printed boards. ' +
    'Mina will send the agenda tonight, and Jordan has the projector booked for the whole afternoon.';
  const text = excerptOf(message({ id: 'x', snippet: long }));
  assert.equal(
    text,
    'The layout review moved to Thursday at two in the Oak room. Please bring the printed boards. …',
  );
  assert.match(excerptOf(message({ id: 'x', snippet: 'x'.repeat(400) })), /x…$/);
});
