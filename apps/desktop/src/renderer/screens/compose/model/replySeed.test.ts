import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../../data';
import { replySeed } from './replySeed';

const me = new Set(['me@example.com']);

function message(patch: Partial<Message>): Message {
  return {
    id: 'm1',
    threadId: 't1',
    accountId: 'a1',
    from: { address: 'jordan@example.com', name: 'Jordan' },
    to: [{ address: 'me@example.com' }],
    cc: [],
    subject: 'Plans',
    fromMe: false,
    ...patch,
  } as unknown as Message;
}

const addresses = (list: readonly { address: string }[]) => list.map(r => r.address);

test('a reply goes to the Reply-To addresses when the message has them', () => {
  const seed = replySeed(
    message({ replyTo: [{ address: 'team@example.com', name: 'Team' }] }),
    me,
    false,
  );
  assert.deepEqual(addresses(seed.fields.to), ['team@example.com']);
  assert.deepEqual(seed.fields.cc, []);
});

test('a reply goes to the sender when Reply-To is absent or empty', () => {
  assert.deepEqual(addresses(replySeed(message({}), me, false).fields.to), ['jordan@example.com']);
  const empty = replySeed(message({ replyTo: [] }), me, false);
  assert.deepEqual(addresses(empty.fields.to), ['jordan@example.com']);
});

test('reply all sends to Reply-To and copies the sender with the original To and Cc', () => {
  const seed = replySeed(
    message({
      replyTo: [{ address: 'team@example.com' }],
      to: [{ address: 'me@example.com' }, { address: 'mina@example.com' }],
      cc: [{ address: 'sam@example.com' }],
    }),
    me,
    true,
  );
  assert.deepEqual(addresses(seed.fields.to), ['team@example.com']);
  assert.deepEqual(addresses(seed.fields.cc), [
    'jordan@example.com',
    'mina@example.com',
    'sam@example.com',
  ]);
});

test('reply all dedupes by address regardless of case and drops your own addresses', () => {
  const seed = replySeed(
    message({
      from: { address: 'Jordan@X.com' },
      replyTo: [{ address: 'jordan@x.com' }],
      to: [{ address: 'ME@example.com' }, { address: 'JORDAN@x.com' }, { address: 'mina@x.com' }],
      cc: [{ address: 'Mina@X.com' }, { address: 'me@example.com' }],
    }),
    me,
    true,
  );
  assert.deepEqual(addresses(seed.fields.to), ['jordan@x.com']);
  assert.deepEqual(addresses(seed.fields.cc), ['mina@x.com']);
});

test('a reply to your own message still goes to the people you wrote to', () => {
  const seed = replySeed(
    message({
      fromMe: true,
      from: { address: 'me@example.com' },
      replyTo: [{ address: 'elsewhere@example.com' }],
      to: [{ address: 'mina@example.com' }, { address: 'me@example.com' }],
    }),
    me,
    false,
  );
  assert.deepEqual(addresses(seed.fields.to), ['mina@example.com']);
});
