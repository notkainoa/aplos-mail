import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageWrite } from '../../src/store';
import { incoming, worldEngine } from './harness';

/*
 * Every thread starts `new`, so a thread the owner started and nobody answered (Sent only: no inbound message) would
 * sit in Do now. Home's lane cursors test for an inbound message; Follow up is where such a thread belongs.
 */

const sentOnly = (thread: string): MessageWrite => ({
  ...incoming(thread, { folder: 'SENT', seen: true }),
  from: { address: 'owner@mail.example', name: 'Owner' },
  to: [{ address: 'friend@mail.example' }],
  flags: { seen: true, flagged: false, draft: false, fromMe: true },
});

const sections = async (
  t: Awaited<ReturnType<typeof worldEngine>>,
  section: 'do' | 'update' | 'low',
) => (await t.call('View/query', { spec: { kind: 'homeSection', section }, limit: 50 })).ids;

test('a Sent-only thread is in no Home lane, an answered one is', async () => {
  const t = await worldEngine(3, 0);
  try {
    t.commit([incoming('heard'), sentOnly('lonely')], 'sync');
    const doIds = await sections(t, 'do');
    assert.ok(doIds.includes('acct-1:heard'), 'mail from someone is in Do now');
    assert.ok(!doIds.includes('acct-1:lonely'), 'a thread nobody answered is not new mail');
    const all = [...doIds, ...(await sections(t, 'update')), ...(await sections(t, 'low'))];
    assert.ok(!all.includes('acct-1:lonely'));
  } finally {
    await t.close?.();
  }
});
