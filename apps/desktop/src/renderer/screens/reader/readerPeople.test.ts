/**
 * Who a message went to (owner request 2026-11-10): the circles are the people on To and Cc with the owner first,
 * "You" is added for mail that arrived without their address on it, and the details rows carry only what the message
 * has (Reply-to only when it differs from the sender, Bcc only when present).
 * Run: cd apps/desktop && npx tsx --test src/renderer/screens/reader/readerPeople.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../data';
import {
  MAX_NAMED,
  detailDate,
  detailRows,
  personOf,
  recipientPeople,
  recipientLabel,
} from './readerPeople';

const ME = new Set(['alex@studio.example']);
const JORDAN = { name: 'Jordan Park', address: 'jordan@studio.example' };
const MINA = { name: 'Mina Cho', address: 'mina@studio.example' };
const ALEX = { name: 'Alex Morgan', address: 'Alex@Studio.example' };

function message(over: Partial<Message>): Message {
  return {
    id: 'm1',
    from: JORDAN,
    to: [ALEX],
    cc: [],
    date: Date.UTC(2026, 10, 10, 17, 10),
    fromMe: false,
    ...over,
  } as Message;
}

test('a person is a monogram of the first letter; the owner reads "You" with their own initial', () => {
  assert.equal(personOf(JORDAN, ME).initial, 'J');
  assert.equal(personOf({ name: '', address: 'zed@x.example' }, ME).initial, 'Z');
  assert.equal(personOf({ name: '“Édith”', address: 'e@x.example' }, ME).initial, 'É');
  const me = personOf(ALEX, ME);
  assert.deepEqual([me.name, me.initial, me.me], ['You', 'A', true]);
});

test('people: the owner first, duplicates once, To then Cc', () => {
  const people = recipientPeople(message({ to: [JORDAN, ALEX], cc: [MINA, JORDAN] }), ME);
  assert.deepEqual(
    people.map(p => p.name),
    ['You', 'Jordan Park', 'Mina Cho'],
  );
});

test('every address of the owner is one person', () => {
  const both = new Set(['alex@studio.example', 'alex@home.example']);
  const people = recipientPeople(
    message({ to: [ALEX], cc: [{ name: 'Alex', address: 'alex@home.example' }] }),
    both,
  );
  assert.deepEqual(
    people.map(p => p.name),
    ['You'],
  );
});

test('mail that arrived without the owner on it still went to them; a sent message did not', () => {
  const arrived = recipientPeople(message({ to: [MINA] }), ME);
  assert.deepEqual(
    arrived.map(p => p.name),
    ['You', 'Mina Cho'],
  );
  assert.equal(arrived[0]?.address, 'alex@studio.example');
  const sent = recipientPeople(message({ fromMe: true, to: [MINA] }), ME);
  assert.deepEqual(
    sent.map(p => p.name),
    ['Mina Cho'],
  );
});

test('the label says who it went to in plain words: "to me", a name, or the address', () => {
  assert.equal(recipientLabel(recipientPeople(message({ to: [ALEX] }), ME)), 'to me');
  assert.equal(
    recipientLabel(recipientPeople(message({ to: [ALEX, MINA] }), ME)),
    'to me, Mina Cho',
  );
  const bare = recipientPeople(
    message({ fromMe: true, to: [{ name: '', address: 'sam@studio.example' }] }),
    ME,
  );
  assert.equal(recipientLabel(bare), 'to sam@studio.example');
  assert.equal(recipientLabel([]), 'to undisclosed recipients');
  const many = ['a', 'b', 'c', 'd', 'e'].map(n =>
    personOf({ name: n, address: `${n}@x.example` }, ME),
  );
  assert.equal(recipientLabel(many), 'to a, b and 3 more', 'a long list never becomes a paragraph');
  const long = personOf({ name: 'Bartholomew Featherstonehaugh', address: 'b@x.example' }, ME);
  assert.equal(
    recipientLabel([long, ...many]),
    'to Bartholomew Fea…, a and 4 more',
    'a long name is cut so the count stays whole',
  );
  assert.ok(MAX_NAMED >= 2);
});

test('details: From, Date, then To and Cc (the long lists last); Bcc and Reply-to only when present, Reply-to only when it differs', () => {
  const plain = detailRows(message({ to: [ALEX], cc: [MINA] }), ME);
  assert.deepEqual(
    plain.map(r => r.label),
    ['From', 'Date', 'To', 'Cc'],
  );
  const same = detailRows(message({ replyTo: [JORDAN] }), ME);
  assert.ok(
    !same.some(r => r.label === 'Reply-to'),
    'the sender replying to themselves is no news',
  );
  const full = detailRows(message({ bcc: [MINA], replyTo: [MINA] }), ME);
  assert.deepEqual(
    full.map(r => r.label),
    ['From', 'Reply-to', 'Date', 'To', 'Bcc'],
  );
});

test('the date reads "Nov 10, 9:10 AM" and takes the year when it is another year', () => {
  const ms = new Date(2026, 10, 10, 9, 10).getTime();
  assert.equal(detailDate(ms, new Date(2026, 10, 12).getTime()), 'Nov 10, 9:10 AM');
  assert.equal(detailDate(ms, new Date(2027, 0, 5).getTime()), 'Nov 10, 2026, 9:10 AM');
});

test('a hundreds-long recipient list never pushes the Date down: it stays among the first rows', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    name: `Person ${i}`,
    address: `p${i}@x.example`,
  }));
  const labels = detailRows(message({ to: many, cc: many.slice(0, 50) }), ME).map(r => r.label);
  assert.deepEqual(labels.slice(0, 2), ['From', 'Date']);
  assert.ok(labels.indexOf('Date') < labels.indexOf('To'));
});

test('right-to-left names: the monogram is the first letter of the name, whatever its direction', () => {
  assert.equal(personOf({ name: 'محمد علي', address: 'm@x.example' }, ME).initial, 'م');
  assert.equal(personOf({ name: 'שרה כהן', address: 's@x.example' }, ME).initial, 'ש');
  assert.equal(
    personOf({ name: '“محمد”', address: 'm2@x.example' }, ME).initial,
    'م',
    'quotes are skipped',
  );
});
