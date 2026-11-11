/**
 * Worst-case sender names for Home's rows (break-ui pass). The engine builds `fromName` from the newest sender of the
 * thread, which is the owner whenever they answered last, so a row, "Always do this for …" and the one-by-one title
 * must not read the owner's own name; and names arrive with whitespace, bidi controls and nothing but an address.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadRow } from '../../data';
import { senderOf } from './homeRows';

const ME = { name: 'Kainoa Newton', address: 'owner@mail.example', me: true };
const LEAH = { name: 'Leah Okafor', address: 'leah@harbor-table.example' };

function thread(parts: {
  fromName: string;
  participants: readonly { name?: string; address?: string; me?: boolean }[];
  subject?: string;
}): ThreadRow {
  return { subject: 'Saturday table', ...parts } as unknown as ThreadRow;
}

test('the owner answered last: the row names the other person, not the owner', () => {
  const answered = thread({ fromName: ME.name, participants: [ME, LEAH] });
  assert.equal(senderOf(answered), 'Leah Okafor');
});

test('the owner is the only sender: the row still reads something (the contract has no recipients yet)', () => {
  assert.equal(senderOf(thread({ fromName: ME.name, participants: [ME] })), 'Kainoa Newton');
});

test('an address-only sender shows the address, a nameless other falls back to its address', () => {
  const long = 'bartholomew.fitzgerald@northwind-industries-holdings.example.com';
  assert.equal(senderOf(thread({ fromName: long, participants: [{ address: long }] })), long);
  assert.equal(
    senderOf(thread({ fromName: ME.name, participants: [ME, { address: long }] })),
    long,
  );
});

test('a whitespace-only fromName tries the participants before giving up', () => {
  assert.equal(senderOf(thread({ fromName: '   ', participants: [LEAH] })), 'Leah Okafor');
  assert.equal(senderOf(thread({ fromName: ' \t ', participants: [] })), 'Saturday table');
});

test('whitespace runs, line breaks and bidi or zero-width controls never reach the row or a rule label', () => {
  const messy = thread({
    fromName: '  Leah\n  ‮Okafor‬​  ',
    participants: [LEAH],
  });
  assert.equal(senderOf(messy), 'Leah Okafor');
});

test('one-letter, CJK, Arabic and emoji names pass through untouched', () => {
  for (const name of [
    'J',
    '山田 太郎',
    'محمد علي',
    '🎉 Party Planning 🎉',
    'Family 👩\u200d👩\u200d👧\u200d👦 Office',
    'می\u200cخواهم',
    'Jo',
  ]) {
    assert.equal(senderOf(thread({ fromName: name, participants: [{ name }] })), name);
  }
});
