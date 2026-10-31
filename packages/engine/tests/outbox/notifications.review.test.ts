import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../src/clock/module';
import { createLogger } from '../../src/diag/log';
import {
  ACK_SQL,
  BADGE_POLL_MS,
  CLAIM_LEASE_MS,
  KEEP_DONE_MS,
  MAX_AGE_MS,
  MAX_PER_BATCH,
  UNREAD_INBOX_SQL,
  createNotifications,
  signalListeners,
} from '../../src/outbox/notifications';
import { readCounts } from '../../src/views/counts';
import { deadlinesChanged, type CommandDeps } from '../../src/views/ops';
import { ACCOUNT } from '../store/helpers';
import { inboxIds, nextOp } from '../views/acts';
import { worldEngine } from '../views/harness';
import { makeWorld } from '../views/world';
import { HOUR, SEEN, T0, ids, mail, simulatedHost, world } from './notifications-world';
// ------------------------------------------------------------------ the badge follows the mailbox

const badges = (w: { events: { type: string }[] }) =>
  w.events.filter((e): e is { type: 'badge'; count: number } => e.type === 'badge');

test('a flags write with no message in it moves the badge once the loop is told', async () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('m1'), mail('m2')]);
  w.notes.start();
  await w.clock.advance(300);
  w.events.length = 0;
  // The views lane's local edit: no message write, so no ingest hook; it tells the loop afterwards.
  w.commit(
    undefined,
    [{ kind: 'flags', accountId: ACCOUNT, target: { remoteId: 'm1' }, seen: true }],
    'local',
  );
  await w.clock.advance(300);
  assert.deepEqual(badges(w), [], 'nothing looked yet');
  w.sources.find(s => s.id === 'notifications')!.next();
  await w.clock.advance(300);
  assert.deepEqual(badges(w), [{ type: 'badge', count: 1 }]);
  w.close();
});

test('a sync commit that only moved flags is caught by the 60 s look', async () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('m1')]);
  w.notes.start();
  await w.clock.advance(300);
  w.events.length = 0;
  w.commit('incremental', [], 'sync');
  w.commit(
    undefined,
    [{ kind: 'flags', accountId: ACCOUNT, target: { remoteId: 'm1' }, seen: true }],
    'sync',
  );
  const source = w.sources.find(s => s.id === 'notifications')!;
  const at = (await source.next())!;
  assert.ok(at <= w.clock.now() + BADGE_POLL_MS);
  await w.clock.set(at);
  await source.fire(at);
  await w.clock.advance(300);
  assert.deepEqual(badges(w), [{ type: 'badge', count: 0 }]);
  w.close();
});

test('marking mail read through Thread/act sends the lower badge with no claim, ack or wake', async () => {
  const t = await worldEngine(11, 60);
  try {
    const host = t.engine.connect({ kind: 'host', scopes: ['host', 'read', 'triage'] });
    const counts: number[] = [];
    host.subscribe(f => {
      if (f.frame === 'host' && f.event.type === 'badge') counts.push(f.event.count);
    });
    await t.advance(400);
    const before = t.engine.services.notifications.badge();
    assert.ok(before > 1, 'the seeded world has unread Inbox mail');
    const unread: string[] = [];
    for (const id of await inboxIds(t)) {
      const row = (await t.call('Thread/get', { ids: [id] })).list[0]!;
      if (row.unread) unread.push(id);
    }
    counts.length = 0;
    await t.call('Thread/act', {
      opId: nextOp('badge'),
      ids: [unread[0]!],
      action: { type: 'read' },
    });
    await t.advance(400);
    assert.deepEqual(counts, [before - 1]);
    await t.call('Thread/act', {
      opId: nextOp('badge'),
      ids: [unread[1]!],
      action: { type: 'trash' },
    });
    await t.advance(400);
    assert.deepEqual(counts, [before - 1, before - 2]);
  } finally {
    await t.close();
  }
});

test('the views lane tells the notifications source about mail edits and nothing else', () => {
  const told: string[] = [];
  const deps = { deadlines: { register: () => () => {}, changed: (id: string) => told.push(id) } };
  const call = (...writes: unknown[]) =>
    deadlinesChanged(deps as unknown as CommandDeps, writes as never);
  call({ kind: 'op', opId: 'x' });
  call({ kind: 'flags', accountId: 'a', target: 't', seen: true });
  call({ kind: 'placements', accountId: 'a', target: 't', add: [], remove: ['INBOX'] });
  assert.deepEqual(told, ['notifications', 'notifications', 'notifications']);
  told.length = 0;
  call({ kind: 'workflow', accountId: 'a', remoteThreadId: 't', patch: { title: 'x' } });
  call({ kind: 'workflow', accountId: 'a', remoteThreadId: 't', patch: { laterUntil: 5 } });
  assert.deepEqual(told, ['later']);
});

// ------------------------------------------------------------------ the badge query

test('the badge number is the sidebar unread Inbox count, so the two cannot drift', () => {
  const world = makeWorld(5, T0, 300);
  try {
    const clock = fakeClock(T0);
    const log = createLogger({ sink: { write: () => {} }, salt: 's', clock });
    const notes = createNotifications({
      store: world.store,
      clock,
      log,
      randomBytes: n => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      deadlines: { register: () => () => {}, changed: () => {} },
    });
    const sidebar = () =>
      world.store.read(q => readCounts(q, { now: T0, zone: 'UTC', followUpDays: 3 }).all.unread);
    assert.ok(sidebar() > 10);
    assert.equal(notes.service.badge(), sidebar());
    // Move threads around: read some, trash some, archive some. Both numbers follow.
    const threads = world.store.read(q =>
      q.all<{ account_id: string; remote_id: string }>(
        'SELECT account_id, remote_id FROM threads ORDER BY id LIMIT 90',
      ),
    );
    let applied = 0;
    threads.forEach((th, i) => {
      const target = { remoteThreadId: th.remote_id };
      const accountId = th.account_id;
      const write =
        i % 3 === 0
          ? { kind: 'flags', accountId, target, seen: true }
          : i % 3 === 1
            ? { kind: 'placements', accountId, target, add: [], remove: ['INBOX'] }
            : {
                kind: 'workflow',
                accountId,
                remoteThreadId: th.remote_id,
                patch: { status: 'done' },
              };
      try {
        world.store.commit({ opId: `edit-${i}`, origin: 'local', writes: [write as never] });
        applied++;
      } catch {
        // A target that is a thread id rather than a message id is skipped; the rest still move the numbers.
      }
      assert.equal(notes.service.badge(), sidebar(), `after edit ${i}`);
    });
    assert.ok(applied > 60, `only ${applied} edits applied`);
    notes.stop();
  } finally {
    world.cleanup();
  }
});

test('the badge query reads the unread index, not threads or messages', () => {
  const world = makeWorld(5, T0, 50);
  try {
    const plan = world.store
      .read(q => q.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${UNREAD_INBOX_SQL}`))
      .map(r => r.detail)
      .join('\n');
    assert.match(plan, /SEARCH tf USING (COVERING )?INDEX tf_unread/);
    assert.doesNotMatch(plan, /SCAN (threads|messages|tf|thread_folders)\b/);
  } finally {
    world.cleanup();
  }
});

test('the ack lookup starts at notifications and probes messages by primary key', () => {
  const world = makeWorld(5, T0, 50);
  try {
    const plan = world.store
      .read(q => q.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${ACK_SQL}`, 'posted', '[]'))
      .map(r => r.detail)
      .join('\n');
    assert.match(plan, /SCAN notifications/);
    assert.match(plan, /SEARCH m USING INTEGER PRIMARY KEY/);
    assert.doesNotMatch(plan, /SCAN m\b/);
  } finally {
    world.cleanup();
  }
});

test('ack finds its rows in a 5k-message world', () => {
  const w = world();
  w.setup(true);
  const writes = Array.from({ length: 5000 }, (_, i) => mail(`bulk-${i}`, { flags: SEEN }));
  w.commit('backfill', writes);
  w.commit('incremental', [mail('m1'), mail('m2')]);
  const items = w.notes.service.claim();
  assert.equal(items.length, 2);
  w.notes.service.ack([items[0]!.id], 'posted');
  assert.deepEqual(
    w.rows().map(r => r.state),
    ['posted', 'claimed'],
  );
  w.close();
});

// ------------------------------------------------------------------ the lease and the clock

test('a lease written by a clock that was set back a day counts as expired', async () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('m1')]);
  const first = w.notes.service.claim();
  const source = w.sources.find(s => s.id === 'notifications')!;
  await w.clock.set(w.clock.now() - 24 * HOUR);
  assert.equal(await source.next(), w.clock.now(), 'due at once, not a day from now');
  assert.deepEqual(ids(w.notes.service.claim()), ids(first));
  assert.deepEqual(w.notes.service.claim(), []);
  await w.clock.advance(CLAIM_LEASE_MS - 1);
  assert.deepEqual(w.notes.service.claim(), [], 'the new lease holds');
  w.close();
});

test('a late ack after a reclaim ends the offers; the stable id means a repost replaces the banner', async () => {
  const w = world();
  w.setup(true);
  const host = simulatedHost(w);
  w.commit('incremental', [mail('m1')]);
  const first = host.claim();
  await w.clock.advance(CLAIM_LEASE_MS);
  const second = host.claim();
  assert.deepEqual(ids(second), ids(first), 'same id, so the second post replaces the first');
  assert.deepEqual(host.posts, [...ids(first), ...ids(second)]);
  host.ack(first);
  assert.deepEqual(w.rows(), [{ remote_id: 'm1', state: 'posted' }]);
  w.notes.service.ack(ids(second), 'posted');
  await w.clock.advance(10 * CLAIM_LEASE_MS);
  assert.deepEqual(w.notes.service.claim(), []);
  w.close();
});

test('an ack id without the mail: prefix is ignored', () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('m1')]);
  w.notes.service.claim();
  w.notes.service.ack([`${ACCOUNT}:m1`, `reminder:${ACCOUNT}:m1`, `MAIL:${ACCOUNT}:m1`], 'posted');
  assert.deepEqual(w.rows(), [{ remote_id: 'm1', state: 'claimed' }]);
  w.close();
});

test('posted and dropped rows are deleted after 30 days; newer ones stay', async () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('old-posted'), mail('old-dropped')]);
  const first = w.notes.service.claim();
  w.notes.service.ack([first[0]!.id], 'posted');
  w.notes.service.ack([first[1]!.id], 'dropped');
  await w.clock.advance(KEEP_DONE_MS - HOUR);
  w.commit('incremental', [mail('new', { internalDate: w.clock.now(), date: w.clock.now() })]);
  const second = w.notes.service.claim();
  w.notes.service.ack(ids(second), 'posted');
  assert.equal(w.rows().length, 3, 'inside the 30 days nothing is deleted');
  await w.clock.advance(2 * HOUR);
  w.notes.service.claim();
  assert.deepEqual(w.rows(), [{ remote_id: 'new', state: 'posted' }]);
  w.close();
});

// ------------------------------------------------------------------ what qualifies

test('mail older than a day is not announced, but it is in the badge', async () => {
  const w = world();
  w.setup(true);
  w.notes.start();
  w.commit('incremental', [
    mail('stale', { internalDate: T0 - MAX_AGE_MS - 1, date: T0 - MAX_AGE_MS - 1 }),
    mail('edge', { internalDate: T0 - MAX_AGE_MS, date: T0 - MAX_AGE_MS }),
    mail('fresh', { internalDate: T0 - HOUR, date: T0 - HOUR }),
  ]);
  assert.deepEqual(
    w.rows().map(r => r.remote_id),
    ['edge', 'fresh'],
  );
  await w.clock.advance(300);
  assert.equal(w.notes.service.badge(), 3);
  w.close();
});

test('one batch writes at most 20 notifications and keeps the newest', () => {
  const w = world();
  w.setup(true);
  const burst = Array.from({ length: 30 }, (_, i) =>
    mail(`b${String(i).padStart(2, '0')}`, {
      internalDate: T0 - (30 - i) * 1000,
      date: T0 - (30 - i) * 1000,
    }),
  );
  w.commit('incremental', burst);
  const rows = w.rows().map(r => r.remote_id);
  assert.equal(rows.length, MAX_PER_BATCH);
  assert.deepEqual(
    rows,
    burst
      .slice(-MAX_PER_BATCH)
      .map(m => m.remoteId)
      .sort(),
  );
  w.close();
});

test('a message first stored by backfill and later re-labelled by an incremental pass is silent', () => {
  const w = world();
  w.setup(true);
  w.commit('backfill', [mail('m1', { folders: [{ folder: 'Label_1' }] })]);
  w.commit('incremental', [mail('m1', { folders: [{ folder: 'INBOX' }] })]);
  assert.deepEqual(w.rows(), []);
  w.close();
});

test('Trash is silent even beside the Inbox, and mail trashed before the claim is dropped', () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [
    mail('both', { folders: [{ folder: 'INBOX' }, { folder: 'TRASH' }] }),
    mail('later-trashed'),
  ]);
  assert.deepEqual(w.rows(), [{ remote_id: 'later-trashed', state: 'pending' }]);
  w.commit('incremental', [mail('later-trashed', { folders: [{ folder: 'TRASH' }] })]);
  assert.deepEqual(w.notes.service.claim(), []);
  assert.deepEqual(w.rows(), [{ remote_id: 'later-trashed', state: 'dropped' }]);
  w.close();
});

test('the title is clamped to 500 characters', () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [
    mail('m1', { from: { address: 'a@mail.example', name: 'N'.repeat(900) } }),
  ]);
  const [item] = w.notes.service.claim();
  assert.equal(item!.title.length, 500);
  w.close();
});

test('stop() leaves no listener, no source and no timer behind', async () => {
  const w = world();
  w.setup(true);
  w.notes.start();
  w.commit('incremental', [mail('m1')]);
  assert.ok(w.clock.pending() > 0);
  assert.equal(signalListeners(), 1);
  w.notes.stop();
  assert.equal(signalListeners(), 0, 'the ingest listener is removed');
  assert.equal(w.sources.length, 0, 'the deadline source is unregistered');
  assert.equal(w.clock.pending(), 0, 'the badge timer is cancelled');
  w.events.length = 0;
  w.commit('incremental', [mail('m2')]);
  await w.clock.advance(1000);
  assert.deepEqual(w.events, [], 'no listener answers a later commit');
  assert.equal(w.clock.pending(), 0);
  w.close();
});

// ------------------------------------------------------------------ banner text is plain and short

function claimedOne(from: { address: string; name?: string }, subject: string) {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('m1', { from, subject })]);
  const [item] = w.notes.service.claim();
  w.close();
  return item!;
}

test('bidi, zero-width space, BOM and soft-hyphen characters are stripped from the subject', () => {
  const subject = '‮Report‬ ⁦for⁩ you​﻿ to­day‏';
  const item = claimedOne({ address: 'a@mail.example', name: 'Ann' }, subject);
  assert.equal(item.body, 'Report for you today');
});

test('ZWNJ, ZWJ and the Arabic number signs survive, they are part of the text', () => {
  const subject = 'می\u200Cخواهم \u0600١٢٣ क्\u200Dष \u{1F468}\u200D\u{1F469}';
  const item = claimedOne({ address: 'a@mail.example', name: 'Ann' }, subject);
  assert.equal(item.body, subject);
  const tags = claimedOne(
    { address: 'a@mail.example', name: 'Ann' },
    'a\u{E0041}\u{E007F}b\u2060\u2066c',
  );
  assert.equal(tags.body, 'abc');
});

test('the sender name is cleaned the same way', () => {
  const item = claimedOne({ address: 'a@mail.example', name: '‮evil​﻿⁦ Ann­\n' }, 'Hi');
  assert.equal(item.title, 'evil Ann');
});

test('a 5,000-character subject becomes a 200-character body', () => {
  const item = claimedOne({ address: 'a@mail.example', name: 'Ann' }, 'word '.repeat(1000));
  assert.ok(item.body!.length <= 200);
  assert.ok(item.body!.length >= 199);
  assert.ok(!item.body!.endsWith(' '), 'it does not end on a space');
});

test('an emoji at the body boundary is kept whole or dropped, never split', () => {
  const at199 = claimedOne({ address: 'a@mail.example', name: 'Ann' }, `${'x'.repeat(199)}😀tail`);
  assert.equal(at199.body, `${'x'.repeat(199)}😀`);
  assert.equal([...at199.body!].length, 200);
  const at200 = claimedOne({ address: 'a@mail.example', name: 'Ann' }, `${'x'.repeat(200)}😀`);
  assert.equal(at200.body, 'x'.repeat(200));
  for (const body of [at199.body!, at200.body!]) {
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body));
  }
});

test('the title keeps its own limit of 500 characters', () => {
  const item = claimedOne({ address: 'a@mail.example', name: 'N'.repeat(900) }, 'Hi');
  assert.equal(item.title.length, 500);
});
