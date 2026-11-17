import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../../data';
import { ownAddresses, replySeed } from './replySeed';

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

test('"me" holds every account address and send-as alias; a message from an alias replies to its To', () => {
  const own = ownAddresses([
    {
      address: 'Me@Example.com',
      identities: [{ address: 'Alias@Example.com', default: false }],
    },
  ] as never);
  assert.deepEqual([...own], ['me@example.com', 'alias@example.com']);
  const fromAlias = message({
    from: { address: 'alias@example.com' },
    to: [{ address: 'jordan@example.com' }],
    cc: [{ address: 'me@example.com' }],
  });
  const seed = replySeed(fromAlias, own, true);
  assert.deepEqual(addresses(seed.fields.to), ['jordan@example.com']);
  assert.deepEqual(addresses(seed.fields.cc), [], 'neither alias nor main address is copied');
});

test('a message with no From is not taken for yours: Reply-To, else an empty To to fill', () => {
  const noFrom = message({
    from: undefined,
    to: [{ address: 'me@example.com' }, { address: 'mina@example.com' }],
  });
  assert.deepEqual(
    addresses(replySeed(noFrom, me, false).fields.to),
    [],
    'no guess at the other To people',
  );
  const withReplyTo = message({ from: undefined, replyTo: [{ address: 'list@example.com' }] });
  assert.deepEqual(addresses(replySeed(withReplyTo, me, false).fields.to), ['list@example.com']);
});

test('a reply to your own message to another of your addresses goes back to it, not to an empty To', () => {
  const both = new Set(['me@example.com', 'work@example.com']);
  const sent = message({
    fromMe: true,
    from: { address: 'me@example.com' },
    to: [{ address: 'work@example.com' }],
  });
  for (const replyAll of [false, true]) {
    const seed = replySeed(sent, both, replyAll);
    assert.deepEqual(addresses(seed.fields.to), ['work@example.com']);
    assert.deepEqual(seed.fields.cc, []);
  }
});

test('a reply to your own Bcc-only message goes to the thread’s last other sender', () => {
  const earlier = message({ id: 'm0', date: 1, from: { address: 'jordan@example.com' } });
  const older = message({ id: 'm00', date: 0, from: { address: 'sam@example.com' } });
  const sent = message({
    id: 'm2',
    date: 2,
    fromMe: true,
    from: { address: 'me@example.com' },
    to: [],
    cc: [],
  });
  const seed = replySeed(sent, me, true, [sent, older, earlier]);
  assert.deepEqual(addresses(seed.fields.to), ['jordan@example.com']);
  assert.deepEqual(addresses(replySeed(sent, me, false).fields.to), [], 'nobody to name: empty');
});

test('reply all to your own message copies its Cc and keeps its To', () => {
  const sent = message({
    fromMe: true,
    from: { address: 'me@example.com' },
    to: [{ address: 'mina@example.com' }, { address: 'me@example.com' }],
    cc: [{ address: 'sam@example.com' }],
  });
  const seed = replySeed(sent, me, true);
  assert.deepEqual(addresses(seed.fields.to), ['mina@example.com']);
  assert.deepEqual(addresses(seed.fields.cc), ['sam@example.com']);
});
