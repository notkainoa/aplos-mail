/**
 * A forward's starting fields: "Fwd:" once, To empty, the original quoted under a plain header, and the forward kept
 * out of the original's thread.
 * Run: cd apps/desktop && npx tsx --test src/renderer/screens/compose/model/forwardSeed.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../../data';
import { forwardDate, forwardSeed, forwardSubject, joinForward, splitForward } from './forwardSeed';

const message = {
  id: 'acct:m1',
  threadId: 'acct:t1',
  accountId: 'acct',
  subject: 'Launch plan',
  from: { address: 'drew@example.com', name: 'Drew Bell' },
  to: [{ address: 'me@example.com' }],
  cc: [],
  date: Date.UTC(2026, 9, 26, 15, 30),
} as unknown as Message;

test('the subject gains one Fwd:, whatever the case of an existing prefix', () => {
  assert.equal(forwardSubject('Launch plan'), 'Fwd: Launch plan');
  assert.equal(forwardSubject('Fwd: Launch plan'), 'Fwd: Launch plan');
  assert.equal(forwardSubject('  FW: Launch plan '), 'FW: Launch plan');
  assert.equal(forwardSubject('Re: Launch plan'), 'Fwd: Re: Launch plan');
});

test('a forward starts with nobody in To, an empty note, and the quoted original', () => {
  const { context, fields } = forwardSeed(message, 'Here is the plan.\nSee you Monday.\n');
  assert.deepEqual([fields.to, fields.cc, fields.bcc], [[], [], []]);
  assert.equal(fields.subject, 'Fwd: Launch plan');
  assert.ok(fields.body.startsWith('---------- Forwarded message ----------\n'));
  assert.deepEqual(
    splitForward(fields.body).note,
    '',
    'the note is empty, so its placeholder shows',
  );
  assert.match(fields.body, /\nFrom: Drew Bell <drew@example\.com>\n/);
  assert.match(fields.body, /\nSubject: Launch plan\n/);
  assert.match(fields.body, /\nTo: me@example\.com\n/);
  assert.ok(!fields.body.includes('\nCc:'), 'an empty line is left out');
  assert.ok(fields.body.endsWith('\n\nHere is the plan.\nSee you Monday.'));
  assert.equal(context.mode, 'forward');
  assert.equal(context.replyToMessageId, 'acct:m1');
  assert.equal(context.threadId, undefined, 'a forward is not part of the original thread');
});

test('the note and the quote split and join without losing a keystroke', () => {
  const { fields } = forwardSeed(message, 'Hello.');
  const { note, quote } = splitForward(fields.body);
  assert.equal(joinForward(note, quote), fields.body);
  for (const typed of ['x', 'x\n', '\n', 'two\n\nlines\n\n']) {
    assert.deepEqual(splitForward(joinForward(typed, quote)), { note: typed, quote });
  }
  assert.deepEqual(splitForward('no mark here\n\n'), { note: 'no mark here\n\n', quote: '' });
  // A draft saved before the note area existed opened on two blank lines.
  assert.equal(splitForward(`\n\n${quote}`).note, '');
});

test('the forwarded Date line is in the owner’s zone, not UTC', () => {
  assert.equal(forwardDate(message.date, 'America/Los_Angeles'), 'Mon, Oct 26, 2026 at 8:30 AM');
  assert.equal(forwardDate(message.date, 'Pacific/Honolulu'), 'Mon, Oct 26, 2026 at 5:30 AM');
  const { fields } = forwardSeed(message, 'Hi');
  assert.match(fields.body, /\nDate: \w{3}, \w{3} \d{1,2}, 2026 at \d{1,2}:\d{2} [AP]M\n/);
  assert.doesNotMatch(fields.body, /UTC|GMT/);
});
