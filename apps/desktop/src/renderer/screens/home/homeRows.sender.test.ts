/**
 * Worst-case sender names for Home's rows (break-ui pass). The engine builds `fromName` from the newest sender of the
 * thread, which is the owner whenever they answered last, so a row, "Always do this for …" and the one-by-one title
 * must not read the owner's own name; and names arrive with whitespace, bidi controls and nothing but an address.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadRow } from '../../data';
import { senderOf, suggestedLabel } from './homeRows';

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

test('the owner is matched by address too, and a name of only invisible characters falls through', () => {
  const byAddress = thread({
    fromName: 'owner@mail.example',
    participants: [{ name: 'Kainoa Newton', address: 'owner@mail.example', me: true }, LEAH],
  });
  assert.equal(senderOf(byAddress), 'Leah Okafor');
  assert.equal(
    senderOf(thread({ fromName: '\u200b\u2060\ufeff', participants: [LEAH] })),
    'Leah Okafor',
  );
  assert.equal(
    senderOf(thread({ fromName: 'דני Cohen\u200f', participants: [] })),
    'דני Cohen\u200f',
  );
});

test("a colleague who shares the owner's display name is still a sender; the soft hyphen and Arabic letter mark are dropped", () => {
  const twin = { name: 'Kainoa Newton', address: 'kainoa.n@other.example' };
  assert.equal(
    senderOf(thread({ fromName: twin.name, participants: [twin, ME] })),
    'Kainoa Newton',
    'the newest sender is the colleague, not the owner',
  );
  assert.equal(
    senderOf(thread({ fromName: 'Leah\u00adOka\u061cfor', participants: [LEAH] })),
    'LeahOkafor',
  );
});

// ThreadRow.recipients (the newest message the owner sent: To and Cc) names who a thread the owner wrote waits on.
function sentThread(recipients: readonly { name?: string; address?: string; me?: boolean }[]) {
  return {
    subject: 'Dinner at 7?',
    fromName: ME.name,
    participants: [ME],
    recipients,
  } as unknown as ThreadRow;
}

test('a thread the owner wrote names who it waits on, never the owner', () => {
  const owen = { name: 'Owen Park', address: 'owen@example.test' };
  assert.equal(senderOf(sentThread([owen])), 'Owen Park');
  assert.equal(senderOf(sentThread([{ address: 'owen@example.test' }])), 'owen@example.test');
  assert.equal(
    senderOf(sentThread([ME, owen])),
    'Owen Park',
    'the owner in Cc of their own message is skipped',
  );
  const crowd = ['Ada', 'Ben', 'Cleo', 'Dev', 'Eve'].map(name => ({ name }));
  assert.equal(senderOf(sentThread(crowd)), 'Ada, Ben, Cleo and 2 more');
  assert.equal(senderOf(sentThread([{ name: '‮Owen\u0000 Park' }])), 'Owen Park');
});

test('someone who wrote to the owner still wins over recipients; no recipients keeps the old fallback', () => {
  const heard = {
    subject: 'Dinner',
    fromName: LEAH.name,
    participants: [LEAH, ME],
    recipients: [{ name: 'Priya Raman' }],
  } as unknown as ThreadRow;
  assert.equal(senderOf(heard), 'Leah Okafor');
  assert.equal(senderOf(sentThread([])), 'Kainoa Newton');
  assert.equal(
    senderOf({ ...sentThread([]), recipients: undefined } as unknown as ThreadRow),
    'Kainoa Newton',
  );
});

test('the palette names the suggested action: who a reply goes to, or Mark done', () => {
  const reply = { verb: 'Reply', icon: 'reply', isDone: false } as const;
  assert.equal(suggestedLabel(reply, 'Jordan Park'), 'Reply to Jordan Park');
  assert.equal(
    suggestedLabel({ verb: 'Reply with a nudge', icon: 'reply', isDone: false }, 'Maya Chen'),
    'Nudge Maya Chen',
  );
  assert.equal(
    suggestedLabel({ verb: 'Done', icon: 'check', isDone: true }, 'Jordan Park'),
    'Mark done',
  );
  assert.equal(
    suggestedLabel({ verb: 'View invoice', icon: 'link', isDone: false }, 'Parcel Trail'),
    'View invoice',
  );
});
