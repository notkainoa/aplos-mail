import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import {
  FIRST_PASS_MS,
  PASS_EVERY_MS,
  RESTAMP_MS,
  retainBodies,
  type RetentionOptions,
} from '../../src/store/retention';
import { ACCOUNT, PLAIN, mailWorld, type World, type WorldOptions } from '../mail/harness';
import { msg, T0 } from './helpers';

// Body retention (ARCH 3.6): text older than the window is dropped unless opened, starred or unread, everything under
// the size cap, and drafts, local-only mail and unindexed mail are never dropped. A dropped body comes back on open.

const DAY = 86_400_000;

async function withWorld(fn: (w: World) => Promise<void>, options?: WorldOptions) {
  const world = await mailWorld(options);
  try {
    await fn(world);
  } finally {
    await world.cleanup();
  }
}

let pauses = 0;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const pause = () => {
  pauses++;
  return tick();
};
const run = (w: World, options: RetentionOptions = {}) =>
  retainBodies(w.engine.services, { pause, ...options });

/** Seeds old mail of every kind, each with a body, then moves the clock 100 days on. */
async function seedOld(w: World) {
  const seen = { seen: true, flagged: false, draft: false, fromMe: false };
  const old = [
    msg('old-read', 'to1', 10, { flags: seen }),
    msg('old-read-2', 'to2', 11, { flags: seen }),
    msg('old-unread', 'to3', 12),
    msg('old-starred', 'to4', 13, { flags: { ...seen, flagged: true } }),
    msg('old-opened', 'to5', 14, { flags: seen }),
    msg('old-draft', 'to6', 15, { flags: { ...seen, draft: true } }),
  ];
  w.store.commit({
    opId: 'old',
    origin: 'sync',
    writes: [
      ...old,
      ...old.map(m => ({
        kind: 'body' as const,
        accountId: ACCOUNT,
        remoteId: m.remoteId,
        body: PLAIN,
      })),
    ],
  });
  // Mail written on this Mac (a message this device made that the provider has not echoed yet).
  w.store.commit({
    opId: 'local',
    origin: 'local',
    writes: [
      msg('old-local', 'to7', 16, { flags: seen }),
      { kind: 'body', accountId: ACCOUNT, remoteId: 'old-local', body: PLAIN },
    ],
  });
  w.clock.advance(100 * DAY);
  await tick();
  await w.windowA.call('Thread/open', { threadId: `${ACCOUNT}:to5` });
  w.clock.advance(60_000);
  // Recent read mail, inside the window.
  const now = w.clock.now();
  w.store.commit({
    opId: 'recent',
    origin: 'sync',
    writes: [
      msg('new-read', 'tn1', 0, { flags: seen, date: now - DAY, internalDate: now - DAY }),
      { kind: 'body', accountId: ACCOUNT, remoteId: 'new-read', body: PLAIN },
    ],
  });
}

const stored = (w: World) =>
  w.store
    .read(q =>
      q.all<{ remote_id: string }>(
        'SELECT m.remote_id FROM bodies b JOIN messages m ON m.id = b.message_id ORDER BY m.remote_id',
      ),
    )
    .map(r => r.remote_id);

const bodyState = async (w: World, remoteId: string) =>
  (
    (await w.windowA.call('Message/get', { ids: [`${ACCOUNT}:${remoteId}`] })) as {
      list: { bodyState: string }[];
    }
  ).list[0].bodyState;

/** Twenty read messages with 200 KB bodies each, so dropping them frees whole pages. */
function seedBig(w: World) {
  const seen = { seen: true, flagged: false, draft: false, fromMe: false };
  const big = { text: 'x'.repeat(200_000), cidMap: {} };
  w.store.commit({
    opId: 'big',
    origin: 'sync',
    writes: Array.from({ length: 20 }, (_, i) => [
      msg(`big-${i}`, `tb${i}`, i, { flags: seen }),
      { kind: 'body' as const, accountId: ACCOUNT, remoteId: `big-${i}`, body: big },
    ]).flat(),
  });
}

const freelist = (w: World) =>
  w.store.read(q => q.get<{ freelist_count: number }>('PRAGMA freelist_count')!.freelist_count);

describe('body retention', () => {
  it('drops old read text and keeps opened, starred, unread, draft, local and recent mail', () =>
    withWorld(async w => {
      await seedOld(w);
      const before = stored(w);
      assert.ok(before.includes('old-read') && before.includes('old-local'));
      const result = await run(w);
      assert.equal(result.byAge, 2);
      assert.equal(result.byCap, 0);
      const after = stored(w);
      assert.deepEqual(
        before.filter(id => !after.includes(id)),
        ['old-read', 'old-read-2'],
      );
      for (const kept of [
        'old-unread',
        'old-starred',
        'old-opened',
        'old-draft',
        'old-local',
        'new-read',
      ])
        assert.ok(after.includes(kept), `${kept} keeps its text`);
      assert.equal(await bodyState(w, 'old-read'), 'evicted');
      assert.equal(await bodyState(w, 'old-opened'), 'present');
      // Metadata and search stay: the subject and snippet are still there and the row is still indexed.
      const row = w.store.read(q =>
        q.get<{ subject: string; snippet: string; parts: number }>(
          "SELECT subject, snippet, parts FROM messages WHERE remote_id = 'old-read'",
        ),
      );
      assert.equal(row?.subject, 'Subject to1');
      assert.equal(row?.snippet, 'Snippet old-read');
      assert.ok(row!.parts & 8, 'still in the search index');
      assert.ok(row!.parts & 32, 'marked evicted');
      // Idempotent: a second pass finds nothing.
      const again = await run(w);
      assert.equal(again.byAge + again.byCap, 0);
    }));

  it('keeps text search has not indexed yet', () =>
    withWorld(async w => {
      await seedOld(w);
      w.rawSql("UPDATE messages SET parts = parts & ~8 WHERE remote_id = 'old-read'");
      const result = await run(w);
      assert.equal(result.byAge, 1);
      assert.ok(stored(w).includes('old-read'));
    }));

  it('never runs while an account is backfilling', () =>
    withWorld(async w => {
      await seedOld(w);
      w.setAccountStatus({ status: { state: 'backfilling', done: 10 } });
      const result = await run(w);
      assert.equal(result.skipped, 'backfill');
      assert.ok(stored(w).includes('old-read'));
    }));

  it('keeps the window the owner set', () =>
    withWorld(async w => {
      await seedOld(w);
      w.store.commit({
        opId: 'days',
        origin: 'local',
        writes: [{ kind: 'settings', patch: { retention: { bodyDays: 365 } } }],
      });
      const result = await run(w);
      assert.equal(result.byAge, 0);
      assert.ok(stored(w).includes('old-read'));
    }));

  it('holds the size cap: unmarked first, then least recently read, never drafts or local mail', () =>
    withWorld(async w => {
      await seedOld(w);
      const sizes = new Map(
        w.store
          .read(q =>
            q.all<{ remote_id: string; size: number }>(
              'SELECT m.remote_id, length(b.data) AS size FROM bodies b JOIN messages m ON m.id = b.message_id',
            ),
          )
          .map(r => [r.remote_id, r.size]),
      );
      const total = [...sizes.values()].reduce((a, b) => a + b, 0);
      // Leave room for about two bodies beyond the draft and the local message.
      const cap = sizes.get('old-draft')! + sizes.get('old-local')! + 2 * sizes.get('new-read')!;
      assert.ok(cap < total);
      w.store.commit({
        opId: 'cap',
        origin: 'local',
        writes: [{ kind: 'settings', patch: { retention: { maxBodyBytes: cap } } }],
      });
      pauses = 0;
      const result = await run(w, { evictBatch: 1 });
      assert.equal(result.byAge, 2);
      assert.ok(result.byCap > 0);
      // One pause per scan step and per commit, at the least: the pass never runs long without yielding.
      assert.ok(pauses >= result.byAge + result.byCap + 1);
      const left = stored(w);
      const bytes = left.reduce((sum, id) => sum + sizes.get(id)!, 0);
      assert.ok(bytes <= cap, `${bytes} bytes left under the ${cap} byte cap`);
      assert.ok(left.includes('old-draft') && left.includes('old-local'));
      // The opened message was read most recently of the marked ones; unread and starred mail went before it.
      assert.ok(left.includes('old-opened'), `kept: ${left.join(', ')}`);
    }));

  it('a message opened while the pass runs keeps its text', () =>
    withWorld(async w => {
      await seedOld(w);
      let opened = false;
      const result = await run(w, {
        pause: async () => {
          if (!opened) {
            opened = true;
            await w.windowA.call('Thread/open', { threadId: `${ACCOUNT}:to1` });
          }
          await tick();
        },
      });
      assert.equal(result.byAge, 1);
      assert.ok(stored(w).includes('old-read'));
    }));

  it('fetches dropped text again from the provider when the message is opened', () =>
    withWorld(async w => {
      await seedOld(w);
      await run(w);
      assert.equal(await bodyState(w, 'old-read'), 'evicted');
      w.remote.clear();
      w.remote.set('old-read', PLAIN);
      const opened = w.calls.opened.length;
      const body = (await w.windowA.call('MessageBody/get', {
        messageId: `${ACCOUNT}:old-read`,
      })) as { text: string };
      assert.equal(body.text, PLAIN.text);
      assert.equal(w.calls.opened.length, opened + 1, 'one provider read');
      assert.equal(await bodyState(w, 'old-read'), 'present');
      const parts = w.store.read(
        q =>
          q.get<{ parts: number }>("SELECT parts FROM messages WHERE remote_id = 'old-read'")!
            .parts,
      );
      assert.equal(parts & 32, 0, 'no longer marked evicted');
    }));

  it('hands freed pages back to the disk', () =>
    withWorld(async w => {
      seedBig(w);
      w.clock.advance(100 * DAY);
      await tick();
      const pages = () =>
        w.store.read(q => q.get<{ page_count: number }>('PRAGMA page_count')!.page_count);
      const before = pages();
      const result = await run(w);
      assert.equal(result.byAge, 20);
      assert.ok(result.vacuumSteps >= 1);
      assert.ok(pages() < before - 500, `${before} -> ${pages()} pages`);
      assert.equal(freelist(w), 0);
    }));
  it('stops handing pages back when the file cannot give them (no incremental auto_vacuum)', () =>
    withWorld(
      async w => {
        assert.equal(
          w.store.read(q => q.get<{ auto_vacuum: number }>('PRAGMA auto_vacuum')!.auto_vacuum),
          0,
          'the file was made without auto_vacuum',
        );
        seedBig(w);
        w.clock.advance(100 * DAY);
        await tick();
        // A guard, so a regression fails the test instead of hanging it.
        const guard = new AbortController();
        let steps = 0;
        const result = await run(w, {
          signal: guard.signal,
          pause: () => {
            if (++steps > 500) guard.abort();
            return tick();
          },
        });
        assert.equal(guard.signal.aborted, false, 'the pass ended by itself');
        assert.equal(result.byAge, 20);
        assert.equal(result.vacuumSteps, 1, 'one step freed nothing, so it stopped');
        assert.ok(freelist(w) > 0, 'the free pages stay in the file, reused by later writes');
      },
      {
        // An older opener: the file and a table exist before the store opens it, so its auto_vacuum pragma is a no-op.
        prepare: path => {
          const db = new DatabaseSync(path);
          db.exec('CREATE TABLE made_before(x)');
          db.close();
        },
      },
    ));

  it('a re-open writes nothing; a re-open a day later moves the stamp', () =>
    withWorld(async w => {
      await seedOld(w);
      w.remote.clear(); // the fake provider's open commits nothing, so every commit counted here is the stamp's
      const thread = { threadId: `${ACCOUNT}:to5` };
      const commits = () =>
        w.store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM commits')!.n);
      const stamp = () =>
        w.store.read(
          q =>
            q.get<{ at: number }>(
              "SELECT last_read_at AS at FROM messages WHERE remote_id = 'old-opened'",
            )!.at,
        );
      const first = stamp();
      const before = { commits: commits(), seq: w.store.seq() };
      await w.windowA.call('Thread/open', thread);
      await w.windowA.call('Thread/open', thread);
      assert.deepEqual(
        { commits: commits(), seq: w.store.seq() },
        before,
        'no commit, no change row',
      );
      assert.equal(stamp(), first);
      w.clock.advance(RESTAMP_MS + 1);
      await w.windowA.call('Thread/open', thread);
      assert.equal(commits(), before.commits + 1);
      assert.equal(w.store.seq(), before.seq, 'still no change row: no window reads the stamp');
      assert.equal(stamp(), w.clock.now());
    }));
});

/** The pass the way a desktop host runs it: the eng-host lane starts it after `FIRST_PASS_MS`, then every few hours. */
describe('body retention on a host', () => {
  const desktop = {
    appVersion: '9.9.9',
    device: { id: 'd', name: 'd' },
    resident: true,
    capabilities: { desktop: true },
  };
  const old = T0 - 100 * DAY;
  const seen = { seen: true, flagged: false, draft: false, fromMe: false };
  function seedHostMail(w: World) {
    w.store.commit({
      opId: 'host-old',
      origin: 'sync',
      writes: ['h-read', 'h-starred'].flatMap((id, i) => [
        msg(id, `th${i}`, 0, {
          flags: { ...seen, flagged: id === 'h-starred' },
          date: old,
          internalDate: old,
        }),
        { kind: 'body' as const, accountId: ACCOUNT, remoteId: id, body: PLAIN },
      ]),
    });
  }
  /** Fires due timers and lets the pass's yields run, until `done` or a bound. */
  async function pump(w: World, done: () => boolean) {
    for (let i = 0; i < 200 && !done(); i++) {
      w.clock.advance(0);
      await tick();
    }
  }

  it('a desktop engine drops old text on its own schedule and keeps starred mail', () =>
    withWorld(
      async w => {
        seedHostMail(w);
        w.clock.advance(FIRST_PASS_MS - 1);
        await pump(w, () => false);
        assert.ok(stored(w).includes('h-read'), 'nothing before the first pass is due');
        w.clock.advance(1);
        await pump(w, () => !stored(w).includes('h-read'));
        assert.deepEqual(
          stored(w).filter(id => id.startsWith('h-')),
          ['h-starred'],
        );
        assert.equal(await bodyState(w, 'h-read'), 'evicted');
        await pump(w, () => false); // the pass ends (its vacuum steps) and the loop sleeps until the next one
        // The next pass is scheduled: mail that ages out meanwhile goes then.
        w.store.commit({
          opId: 'host-unstar',
          origin: 'sync',
          writes: [msg('h-starred', 'th1', 0, { flags: seen, date: old, internalDate: old })],
        });
        w.clock.advance(PASS_EVERY_MS);
        await pump(w, () => !stored(w).includes('h-starred'));
        assert.ok(!stored(w).includes('h-starred'));
      },
      { host: desktop },
    ));

  it('a host without the desktop capability never runs it', () =>
    withWorld(async w => {
      seedHostMail(w);
      w.clock.advance(FIRST_PASS_MS + PASS_EVERY_MS);
      await pump(w, () => false);
      assert.ok(stored(w).includes('h-read'));
    }));
});
