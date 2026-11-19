import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMailbox } from '../src/gmail';

const DAY = 86400_000;

test('the same seed builds the same mailbox, another seed a different one', () => {
  const fingerprint = (seed: number) =>
    generateMailbox({ threads: 40, seed })
      .listMessages()
      .map(m => [m.id, m.threadId, m.subject, m.labelIds.join('+'), m.internalDate]);
  assert.deepEqual(fingerprint(5), fingerprint(5));
  assert.notDeepEqual(fingerprint(5), fingerprint(6));
});

test('a generated mailbox covers every label, header and shape the sync code has to handle', () => {
  const mailbox = generateMailbox({ threads: 120, seed: 11 });
  const messages = mailbox.listMessages();
  const labels = new Set(messages.flatMap(m => m.labelIds));
  for (const label of [
    'INBOX',
    'UNREAD',
    'IMPORTANT',
    'STARRED',
    'CATEGORY_PROMOTIONS',
    'CATEGORY_SOCIAL',
    'CATEGORY_UPDATES',
    'SENT',
    'TRASH',
    'SPAM',
    'DRAFT',
  ]) {
    assert.ok(labels.has(label), `missing ${label}`);
  }
  assert.ok(
    [...labels].some(l => l.startsWith('Label_')),
    'user labels are used',
  );
  assert.equal(mailbox.threadCount, 120);

  const sizes = new Map<string, number>();
  for (const m of messages) sizes.set(m.threadId, (sizes.get(m.threadId) ?? 0) + 1);
  assert.equal(Math.min(...sizes.values()), 1);
  assert.ok(Math.max(...sizes.values()) >= 5 && Math.max(...sizes.values()) <= 6);

  const headerSets = messages.map(m => {
    const raw = mailbox.rawOf(m.id).toString('latin1');
    return { raw, headers: raw.split(/\r\n\r\n/)[0] };
  });
  assert.ok(headerSets.some(h => /^List-Unsubscribe: /m.test(h.headers)));
  assert.ok(headerSets.some(h => /^Precedence: bulk/m.test(h.headers)));
  assert.ok(headerSets.some(h => /^Auto-Submitted: auto-generated/m.test(h.headers)));
  assert.ok(headerSets.some(h => /filename="receipt\.pdf"/.test(h.raw)));
});

test('all generated addresses are synthetic and dates are spread over the last two months', () => {
  const mailbox = generateMailbox({ threads: 60, seed: 2 });
  const now = Date.parse('2026-10-27T16:00:00Z');
  for (const m of mailbox.listMessages()) {
    for (const address of `${m.from} ${m.to}`.match(/[\w.+-]+@[\w.-]+/g) ?? [])
      assert.match(address, /[@.]example\.test$/);
    assert.ok(m.internalDate <= now && m.internalDate > now - 70 * DAY);
  }
});

test('generation leaves no history behind, so the first cursor is the starting state', () => {
  const mailbox = generateMailbox({ threads: 20, seed: 3 });
  const cursor = mailbox.history.currentId;
  const result = mailbox.history.query({ startHistoryId: cursor, types: [], maxResults: 100 });
  assert.equal(result.expired, false);
  assert.deepEqual(result.expired === false && result.records, []);
});
