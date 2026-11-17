/**
 * What gives the reader's cards substance: the attachment kind icons, the quoted history of a plain-text body (split,
 * hidden behind "Show quoted text", then a quiet block without `>`), and the invitation card's words.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Event } from '../../data';
import { PlainText } from '../../mailframe/PlainText';
import { foldsQuoted, quotedParts, quotedRangesFor, quotedRangesOf } from '../../mailframe/quoted';
import { attachmentIcon } from './attachmentIcon';
import { inviteOf, inviteWhen } from './invite';
import { InviteCard } from './InviteCard';

test('attachment icons: MIME first, extension next, the plain file last', () => {
  assert.equal(attachmentIcon('Studio plan v3.pdf', 'application/pdf'), 'file-text');
  assert.equal(attachmentIcon('site-photos.zip', 'application/zip'), 'file-archive');
  assert.equal(
    attachmentIcon(
      'budget-q4.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ),
    'file-sheet',
  );
  assert.equal(attachmentIcon('invite.ics', 'text/calendar'), 'calendar');
  assert.equal(attachmentIcon('door.HEIC', 'image/heic'), 'file-image');
  assert.equal(attachmentIcon('notes.csv', 'application/octet-stream'), 'file-sheet');
  assert.equal(attachmentIcon('photos.tar.gz', ''), 'file-archive');
  assert.equal(attachmentIcon('brief.docx', ''), 'file-text');
  assert.equal(attachmentIcon('model.step', 'application/octet-stream'), 'file');
  assert.equal(attachmentIcon('README', ''), 'file');
  assert.equal(attachmentIcon('trailing.', ''), 'file');
});

const BODY = `Hi Alex,

The sample folds cleanly.

> Switched to the plain list and exported new proofs, same folder as
> before.

I checked the new proofs.

Mina`;

test('quoted ranges: runs of > lines, start of the first line to the end of the last', () => {
  const ranges = quotedRangesOf(BODY);
  assert.equal(ranges.length, 1);
  const [range] = ranges;
  assert.equal(
    BODY.slice(range!.start, range!.end),
    '> Switched to the plain list and exported new proofs, same folder as\n> before.',
  );
  assert.deepEqual(quotedRangesOf('no quotes here\nat all'), []);
  assert.deepEqual(quotedRangesOf('> only\n> quote'), [{ start: 0, end: 14 }]);
  assert.equal(quotedRangesOf('a\n> one\nb\n  > two').length, 2);
});

test('quoted ranges: the engine’s ranges win when it gave any', () => {
  assert.deepEqual(quotedRangesFor(BODY, [{ start: 0, end: 4 }]), [{ start: 0, end: 4 }]);
  assert.deepEqual(quotedRangesFor(BODY, []), quotedRangesOf(BODY));
});

test('quoted parts: own and quoted in order, blank lines dropped, > marks off', () => {
  const parts = quotedParts(BODY, quotedRangesOf(BODY));
  assert.deepEqual(
    parts.map(p => p.kind),
    ['own', 'quoted', 'own'],
  );
  assert.equal(parts[0]!.text, 'Hi Alex,\n\nThe sample folds cleanly.');
  assert.equal(
    parts[1]!.text,
    'Switched to the plain list and exported new proofs, same folder as\nbefore.',
  );
  assert.equal(parts[2]!.text, 'I checked the new proofs.\n\nMina');
  // Out-of-order, overlapping and out-of-range ranges are cleaned, not trusted.
  const messy = quotedParts('ab\n> c\n> d', [
    { start: 7, end: 99 },
    { start: 3, end: 8 },
    { start: 5, end: 5 },
  ]);
  assert.deepEqual(messy, [
    { kind: 'own', text: 'ab' },
    { kind: 'quoted', text: 'c\nd' },
  ]);
});

test('a body that is all quote (a forward) is shown whole and offers no fold; a reply still folds', () => {
  const forward = '> Forwarded text\n> second line';
  const ranges = quotedRangesOf(forward);
  assert.equal(foldsQuoted(forward, ranges), false);
  assert.equal(foldsQuoted(BODY, quotedRangesOf(BODY)), true);
  assert.equal(foldsQuoted('no quotes', []), false);
  const html = renderToStaticMarkup(createElement(PlainText, { text: forward, quoted: ranges }));
  assert.match(html, /Forwarded text/);
  assert.match(html, /aplos-mailframe__quote/);
});

test('PlainText: paragraphs; quoted history hidden until shown, then a quiet block; no ranges keeps the > lines', () => {
  const ranges = quotedRangesOf(BODY);
  const hidden = renderToStaticMarkup(createElement(PlainText, { text: BODY, quoted: ranges }));
  assert.doesNotMatch(hidden, /Switched/);
  assert.doesNotMatch(hidden, /&gt;/);
  assert.match(hidden, /data-quoted="true"/);
  const shown = renderToStaticMarkup(
    createElement(PlainText, { text: BODY, quoted: ranges, showQuoted: true }),
  );
  assert.match(
    shown,
    /<blockquote class="aplos-mailframe__quote"><p dir="auto">Switched to the plain list/,
  );
  // A blank line is a paragraph break (the body spaces paragraphs), never an empty 26 px line.
  assert.match(shown, /<p dir="auto">Hi Alex,<\/p><p dir="auto">The sample folds cleanly\.<\/p>/);
  // Each paragraph takes its own direction, so a right-to-left text reads and aligns right to left.
  assert.equal(shown.match(/<p dir="auto">/g)?.length, shown.match(/<p[ >]/g)?.length);
  assert.doesNotMatch(shown, /&gt; /);
  const whole = renderToStaticMarkup(createElement(PlainText, { text: BODY }));
  assert.match(whole, /&gt; Switched/);
  assert.doesNotMatch(whole, /data-quoted/);
});

/** 2:00 PM local on Thursday 5 November 2026, whatever zone the tests run in. */
const NOV_5_2PM = new Date(2026, 10, 5, 14, 0).getTime();

function event(over: Partial<Event> = {}): Event {
  const person = (address: string, name: string, organizer = false, self = false) => ({
    address,
    name,
    response: 'needsAction' as const,
    organizer,
    self,
  });
  const noor = person('noor@studio.example', 'Noor Haddad', true);
  return {
    id: 'ev',
    rev: 1,
    accountId: 'a',
    calendarId: 'c',
    recurring: false,
    exception: false,
    title: 'Brand review',
    start: { type: 'utc', utc: NOV_5_2PM },
    end: { type: 'utc', utc: NOV_5_2PM + 45 * 60_000 },
    allDay: false,
    location: 'Oak room, second floor',
    organizer: noor,
    attendees: [
      noor,
      person('alex@studio.example', 'Alex Morgan', false, true),
      person('jordan@studio.example', 'Jordan Park'),
      person('tomas@studio.example', 'Tomas Reyes'),
    ],
    status: 'confirmed',
    can: { edit: false, move: false, delete: false, rsvp: true, editGuests: false },
    sync: 'synced',
    ...over,
  } as Event;
}

const ME = new Set(['alex@studio.example']);

test('invite: title, the calendar’s when line, place, Invite from, the other guests with you first', () => {
  const view = inviteOf(event(), ME, 'Invitation: Brand review');
  assert.equal(view.title, 'Brand review');
  assert.match(view.when, /^Thursday, November 5 · 2:00 – 2:45 PM$/);
  assert.equal(view.place, 'Oak room, second floor');
  assert.equal(view.from, 'Invite from Noor');
  assert.equal(view.guests, 'you, Jordan Park and Tomas Reyes');
  assert.equal(view.video, undefined);
});

test('invite: no title takes the subject; no place, guests or organiser draw nothing', () => {
  const bare = inviteOf(
    event({ title: '  ', location: undefined, organizer: undefined, attendees: [] }),
    ME,
    'Invitation: Walkthrough',
  );
  assert.deepEqual(Object.keys(bare).sort(), ['title', 'when']);
  assert.equal(bare.title, 'Invitation: Walkthrough');
  const call = inviteOf(
    event({ conference: { url: 'https://meet.example/abc', label: 'Studio call' } }),
    ME,
    's',
  );
  assert.equal(call.video, 'Studio call');
});

test('invite when: all day, several days', () => {
  assert.equal(
    inviteWhen({
      start: { type: 'date', date: '2026-11-05' },
      end: { type: 'date', date: '2026-11-06' },
      allDay: true,
    }),
    'Thursday, November 5 · All day',
  );
  assert.equal(
    inviteWhen({
      start: { type: 'date', date: '2026-11-05' },
      end: { type: 'date', date: '2026-11-08' },
      allDay: true,
    }),
    'Thu, Nov 5 – Sat, Nov 7 · All day',
  );
});

test('InviteCard: Text only, no buttons, every line behind its icon', () => {
  const html = renderToStaticMarkup(
    createElement(InviteCard, { invite: inviteOf(event(), ME, 's') }),
  );
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /<h3 class="ui-text" data-variant="title"[^>]*>Brand review<\/h3>/);
  for (const icon of ['clock', 'pin', 'users'])
    assert.match(html, new RegExp(`data-icon="${icon}"`));
  assert.match(html, /Invite from Noor/);
});
