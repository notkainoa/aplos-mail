import test from 'node:test';
import assert from 'node:assert/strict';
import type { Recipient } from '../../../ui/props';
import { addressOf } from './fields';
import {
  blockedSend,
  namesOf,
  NO_TYPED,
  parseRecipient,
  recipientPhrase,
  safeDisplayName,
  withTyped,
} from './recipients';
import { toLabelOf } from '../views/SendStatus';

const SPOOF = '"boss@company.com" <attacker@evil.example>';

function spoofed(): Recipient {
  const recipient = parseRecipient(SPOOF);
  assert.ok(recipient);
  return recipient;
}

function fieldsOf(to: readonly Recipient[]) {
  return { to, cc: [], bcc: [], subject: '', body: '' };
}

test('a display name that contains "@" is never shown in place of the address', () => {
  assert.equal(safeDisplayName(spoofed()), 'attacker@evil.example');
  assert.equal(
    safeDisplayName({ id: 'a', name: 'Jordan Lee', address: 'jordan@example.com' }),
    'Jordan Lee',
  );
  assert.equal(
    safeDisplayName({ id: 'a', name: '  ', address: 'jordan@example.com' }),
    'jordan@example.com',
  );
  assert.equal(safeDisplayName({ id: 'a', address: 'jordan@example.com' }), 'jordan@example.com');
});

test('the undo tray names the real address for a spoofed name', () => {
  const fields = fieldsOf([spoofed()]);
  assert.deepEqual(namesOf(fields), ['attacker@evil.example']);
  assert.equal(recipientPhrase(namesOf(fields)), 'attacker@evil.example');
});

test('the draft never carries a display name that contains "@"', () => {
  assert.deepEqual(addressOf(spoofed()), { address: 'attacker@evil.example' });
  assert.deepEqual(addressOf({ id: 'j', name: ' Jordan Lee ', address: 'jordan@example.com' }), {
    address: 'jordan@example.com',
    name: 'Jordan Lee',
  });
});

test('the sent message line names the real address too', () => {
  assert.equal(toLabelOf(fieldsOf([spoofed()])), 'to attacker@evil.example');
});

test('a fullwidth ＠ or small ﹫ in a display name counts as "@": the address shows, the draft drops the name', () => {
  for (const fake of ['boss＠company.com', 'boss﹫company.com']) {
    const recipient: Recipient = { id: 'a', name: fake, address: 'attacker@evil.example' };
    assert.equal(safeDisplayName(recipient), 'attacker@evil.example', fake);
    assert.deepEqual(addressOf(recipient), { address: 'attacker@evil.example' }, fake);
    assert.deepEqual(namesOf(fieldsOf([recipient])), ['attacker@evil.example'], fake);
  }
});

test('Send counts a valid typed address that is not yet a chip, and still waits for a bad one', () => {
  const empty = fieldsOf([]);
  const typed = (to: string) => ({ to, cc: '', bcc: '' });
  assert.notEqual(blockedSend(withTyped(empty, typed(''))), null);
  assert.equal(blockedSend(withTyped(empty, typed('maya@garden.example'))), null);
  assert.notEqual(blockedSend(withTyped(empty, typed('maya'))), null);
  const chip = parseRecipient('jordan@example.com')!;
  assert.equal(blockedSend(withTyped(fieldsOf([chip]), NO_TYPED)), null);
  assert.equal(blockedSend(withTyped(empty, { to: '', cc: 'maya@garden.example', bcc: '' })), null);
});
