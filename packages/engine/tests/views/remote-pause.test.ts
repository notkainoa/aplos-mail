import assert from 'node:assert/strict';
import test from 'node:test';
import type { Frame } from '@aplos/contract';
import type { AccountActorHost } from '../../src/ports';
import { ProviderError } from '../../src/ports';
import { BIG_NOW } from './big';
import { openEngine } from './harness';
import { makeWorld } from './world';

// `Search/remote` cool-downs: expiry, the default breath, the clamp, the project scope, joiners and the partial run.
// acct-1 is the Google account, imap:2 the IMAP one. The engine clock is a fake: `t.clock.advance` moves it.

type Progress = Extract<Frame, { frame: 'progress' }>;
const progress = (frames: Frame[], runId?: string) =>
  frames.filter((f): f is Progress => f.frame === 'progress' && (!runId || f.runId === runId));
const lastOf = (frames: Frame[], runId?: string) => progress(frames, runId).at(-1);

const throttle = (extra: object = {}, scope?: 'project') =>
  new ProviderError({ class: 'throttle', reason: 'rateLimitExceeded', ...extra } as never, scope);

/** Accounts whose provider answer per account is scripted; every call is recorded. */
function provider(answer: (account: string, call: number) => Promise<unknown> | void) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const port = {
    search: async (account: string) => {
      calls.push(account);
      const n = (counts.get(account) ?? 0) + 1;
      counts.set(account, n);
      await answer(account, n);
      return { remoteThreadIds: [] };
    },
  } as unknown as AccountActorHost;
  return { port, calls, count: (account: string) => calls.filter(c => c === account).length };
}

async function withEngine(
  answer: Parameters<typeof provider>[0],
  run: (t: Awaited<ReturnType<typeof openEngine>>, p: ReturnType<typeof provider>) => Promise<void>,
) {
  const world = makeWorld(5, BIG_NOW, 60);
  const p = provider(answer);
  const t = await openEngine(world.store, { ports: { accounts: p.port } });
  try {
    await run(t, p);
  } finally {
    await t.close();
    world.cleanup();
  }
}

let op = 0;
const search = async (
  t: Awaited<ReturnType<typeof openEngine>>,
  text = 'garden',
  accountId?: string,
) => {
  const result = await t.call('Search/remote', {
    opId: `s${++op}`,
    query: { text },
    ...(accountId ? { accountId } : {}),
  });
  await t.advance(20);
  return result;
};

test('a pause ends when its time comes: the account is asked again, and a clean answer clears it', async () => {
  await withEngine(
    account => {
      if (account === 'acct-1') throw throttle({ retryAfterMs: 60_000 });
    },
    async (t, p) => {
      await search(t, 'garden', 'acct-1');
      assert.equal(p.count('acct-1'), 1);
      await t.clock.advance(59_000);
      await search(t, 'garden', 'acct-1');
      assert.equal(p.count('acct-1'), 1, 'still inside the pause');
      await t.clock.advance(1_100);
      await search(t, 'garden', 'acct-1');
      assert.equal(p.count('acct-1'), 2, 'asked again once the pause is over');
    },
  );
});

test('a throttle with no hint buys the flat 10 s breath, exactly', async () => {
  await withEngine(
    account => {
      if (account === 'acct-1') throw throttle();
    },
    async (t, p) => {
      const first = await search(t, 'garden', 'acct-1');
      assert.ok(first.runId);
      await t.clock.advance(9_900);
      await search(t, 'garden', 'acct-1');
      assert.equal(p.count('acct-1'), 1, 'not at 9.9 s');
      await t.clock.advance(200);
      await search(t, 'garden', 'acct-1');
      assert.equal(p.count('acct-1'), 2, 'asked again after 10 s');
      // The guessed breath is not put on the wire: the client would trust it as the provider's word.
      const error = lastOf(t.frames, undefined) as Progress;
      assert.equal(error?.problem?.resumeAt, undefined, 'no resumeAt for a synthesized breath');
    },
  );
});

test('anti_abuse with no hint is a breath too (it is a governor class that pauses its budget)', async () => {
  await withEngine(
    account => {
      if (account === 'acct-1')
        throw new ProviderError({ class: 'anti_abuse', reason: 'abuse' } as never);
    },
    async (t, p) => {
      await search(t, 'garden', 'acct-1');
      await search(t, 'garden', 'acct-1');
      assert.equal(p.count('acct-1'), 1, 'the second try is inside the breath');
    },
  );
});

test('a huge or garbage hint is clamped to 24 h: stored, sent and expired as 24 h, never for good', async () => {
  await withEngine(
    account => {
      if (account === 'acct-1') throw throttle({ retryAfterMs: 1e15 });
    },
    async (t, p) => {
      const start = t.clock.now();
      await search(t, 'garden', 'acct-1');
      const sent = (lastOf(t.frames) as Progress).problem?.resumeAt ?? 0;
      assert.ok(sent <= start + 24 * 3600_000 + 1_000, 'the wire says at most 24 h ahead');
      assert.ok(sent > start + 23 * 3600_000, 'and not less');
      await t.clock.advance(24 * 3600_000 + 1_000);
      await search(t, 'garden', 'acct-1');
      assert.equal(p.count('acct-1'), 2, 'asked again after 24 h');
    },
  );
});

test('a project-wide refusal cools the accounts of that provider only', async () => {
  await withEngine(
    account => {
      if (account === 'acct-1') throw throttle({ retryAfterMs: 60_000 }, 'project');
    },
    async (t, p) => {
      // All accounts: the Google account is asked first and refuses for the whole project.
      await search(t, 'garden');
      assert.equal(p.count('acct-1'), 1);
      // The IMAP account is not on Google's project: it is still asked.
      await search(t, 'garden', 'imap:2');
      assert.equal(
        p.count('imap:2'),
        1,
        'another provider is not cooled by the Google project limit',
      );
      await search(t, 'garden', 'acct-1');
      assert.equal(p.count('acct-1'), 1, 'but the Google account itself is');
    },
  );
});

test('some accounts cooling and others answering ends the run as a partial: paused, with when, not done', async () => {
  await withEngine(
    account => {
      if (account === 'acct-1') throw throttle({ retryAfterMs: 60_000 });
    },
    async (t, p) => {
      await search(t, 'garden');
      const second = await search(t, 'garden');
      // The first run ended at the failing account (first error wins); the second skips it and asks the healthy one.
      assert.equal(p.count('imap:2'), 1, 'the healthy account was asked in the second run');
      const last = lastOf(t.frames, second.runId) as Progress;
      assert.equal(last.kind, 'error', 'not `done`: a skipped account is not "no results"');
      assert.equal(last.problem?.reasonCode, 'paused');
      assert.ok((last.problem?.resumeAt ?? 0) > t.clock.now());
      assert.equal(
        progress(t.frames, second.runId).some(f => f.kind === 'done'),
        false,
      );
    },
  );
});

test('every joiner gets its own frames: one provider round, one done frame per caller', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  await withEngine(
    async (_account, n) => {
      if (n === 1) await gate;
    },
    async (t, p) => {
      const other = t.engine.connect();
      const otherFrames: Frame[] = [];
      other.subscribe(f => void otherFrames.push(f));
      const a = await t.call('Search/remote', { opId: 'ja', query: { text: 'garden' } });
      const b = (await other.call('Search/remote', { opId: 'jb', query: { text: 'garden' } })) as {
        runId: string;
      };
      await t.advance(20);
      release();
      await t.advance(40);
      assert.equal(p.count('acct-1'), 1, 'one provider round for two callers');
      assert.equal(lastOf(t.frames, a.runId)?.kind, 'done');
      assert.equal(
        lastOf(otherFrames, b.runId)?.kind,
        'done',
        'the joiner is told its own run ended',
      );
      assert.equal(
        progress(t.frames, b.runId).length,
        0,
        "and never sees the other caller's frames",
      );
    },
  );
});

test('a store failure inside the search is an error frame, never an unhandled rejection', async () => {
  const world = makeWorld(5, BIG_NOW, 60);
  const real = world.store;
  let boom = false;
  const store = {
    ...real,
    read: <T>(fn: (q: never) => T): T =>
      real.read(q =>
        fn({
          ...q,
          all: (sql: string, ...params: never[]) => {
            if (boom && sql.includes('FROM accounts')) throw new Error('database is not open');
            return (q as { all: (s: string, ...a: never[]) => unknown }).all(sql, ...params);
          },
          get: (q as { get: unknown }).get,
          iterate: (q as { iterate: unknown }).iterate,
        } as never),
      ),
  } as unknown as typeof real;
  const p = provider(() => undefined);
  const t = await openEngine(store, { ports: { accounts: p.port } });
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => void unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    boom = true;
    const run = await t.call('Search/remote', { opId: 'boom', query: { text: 'garden' } });
    await t.advance(20);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled.map(String), []);
    assert.equal(lastOf(t.frames, run.runId)?.kind, 'error');
  } finally {
    boom = false;
    process.off('unhandledRejection', onUnhandled);
    await t.close();
    world.cleanup();
  }
});
