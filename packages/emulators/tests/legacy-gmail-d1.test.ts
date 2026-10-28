/**
 * Gate for the prov-emu lane: the UNMODIFIED 0.2.3 Gmail adapter must fail on the emulator the way it
 * fails in the field (defect D1, proto-google.md section 1.2 "Why the first sync never finishes").
 *
 * The adapter's first sync lists 500 threads and fetches each with threads.get?format=full (120 units)
 * on four workers. On a new project's 6,000-unit minute, about 50 fit; every later request is refused
 * with 403 rateLimitExceeded, retried 1, 2, 4, 8 and 16 s (plus jitter) and given up after about 31 s,
 * well before the sliding window frees anything. One worker's error rejects the whole sync, nothing is
 * kept, and the next attempt starts again from zero.
 *
 * prov-gmail inverts the first test once the new adapter lands; the control tests prove the failure
 * comes from the quota and not from an emulator bug.
 *
 * The outcome also depends on Gmail sending no Retry-After on the per-user 403: 0.2.3 sleeps
 * min(Retry-After, 30 s) when one is present, and five 30 s waits outlast the window. The rig pins
 * `retryAfter: 'none'` and a control shows the flip. Whether live Gmail sends Retry-After there is
 * an unknown to check on the first live run (prov-gmail).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/kit/clock';
import { unitsNeverAbove } from '../src/kit/scenario';
import type { RequestLogEntry } from '../src/kit/types';
import {
  createGmailEmulator,
  SCOPE,
  type GmailEmulator,
  type GmailEmulatorOptions,
} from '../src/gmail';
import { createGoogle, INITIAL_THREADS } from '../../../apps/desktop/src/main/google';
import type { Account } from '@aplos/contract/legacy/types';

const CLIENT_ID = 'legacy-d1-client.apps.example.test';
const CLIENT_SECRET = 'legacy-d1-secret';
const THREADS_GET = 'gmail.users.threads.get';
const ATTACHMENTS_GET = 'gmail.users.messages.attachments.get';
/** The scopes 0.2.3 asks for at connect (google.ts connect()). */
const LEGACY_SCOPES = [
  'openid',
  'email',
  'profile',
  SCOPE.gmailModify,
  SCOPE.gmailSettingsBasic,
  SCOPE.calendarList,
  SCOPE.calendarEvents,
];
/** The adapter's own backoff when no Retry-After comes back: 2^attempt seconds, plus up to 500 ms jitter. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const JITTER_MS = 500;

/** One Gmail call as the test saw it. Thread ids stay in memory for grouping and are never printed. */
interface Observed {
  at: number;
  apiMethod: 'threads.get' | 'other';
  threadId?: string;
  status: number;
}

interface Rig {
  clock: FakeClock;
  emu: GmailEmulator;
  account: Account;
  adapter: Awaited<ReturnType<typeof createGoogle>>;
  observed: Observed[];
  latencyMs: number;
  /** Fake-clock time the emulator's access token dies. The adapter cannot see it (it checks real time). */
  tokenExpiresAt: number;
  dispose(): Promise<void>;
}

/**
 * An emulator with a 600-thread synthetic mailbox and the legacy adapter wired to it. The adapter's
 * token file is seeded with tokens the emulator issued through its own OAuth flow; `expiresAt` is far
 * in the real future because the adapter checks expiry with the real Date.now().
 */
async function rig(options: Partial<GmailEmulatorOptions> = {}): Promise<Rig> {
  const clock = new FakeClock();
  // Pinned rather than left to the default: D1's verdict depends on it (see the file comment).
  const emu = createGmailEmulator({ clock, retryAfter: 'none', ...options });
  emu.oauth.addClient(CLIENT_ID, CLIENT_SECRET);
  emu.seedMailbox({ threads: 600, seed: 23 });
  const session = await emu.oauth.signIn({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: LEGACY_SCOPES,
    fetch: emu.fetch,
  });
  const tokenExpiresAt = clock.now() + Number(session.response.expires_in) * 1000;
  const user = emu.users()[0];
  const account: Account = {
    id: `google-${user.sub}`,
    name: user.name,
    email: user.email,
    provider: 'google',
    preset: 'gmail',
    color: '#738c80',
    connected: true,
    calendarConnected: true,
  };

  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-legacy-d1-'));
  const encrypt = (value: string) => Buffer.from(value, 'utf8');
  const decrypt = (value: Buffer) => value.toString('utf8');
  const token = {
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expiresAt: Date.now() + 365 * 86400_000,
  };
  await writeFile(
    join(dataDir, 'google-tokens.enc.json'),
    JSON.stringify({ [account.id]: encrypt(JSON.stringify(token)).toString('base64') }),
    { mode: 0o600 },
  );

  // Watch the adapter's Gmail calls so refusals can be grouped per thread. Nothing here is logged.
  const observed: Observed[] = [];
  const watched: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const at = clock.now();
    const match = /\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(url.pathname);
    const response = await emu.fetch(input, init);
    if (url.origin === 'https://gmail.googleapis.com') {
      observed.push(
        match
          ? {
              at,
              apiMethod: 'threads.get',
              threadId: decodeURIComponent(match[1]),
              status: response.status,
            }
          : { at, apiMethod: 'other', status: response.status },
      );
    }
    return response;
  };

  const adapter = await createGoogle({
    dataDir,
    encrypt,
    decrypt,
    fetch: watched,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    sleep: ms => clock.sleep(ms),
  });
  return {
    clock,
    emu,
    account,
    adapter,
    observed,
    latencyMs: emu.settings.latencyMs,
    tokenExpiresAt,
    async dispose() {
      adapter.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

interface Attempt {
  error?: Error;
  threads: number;
  startedAt: number;
  /** Filled in by `slice` once the next attempt has started (stragglers finish after the rejection). */
  log: RequestLogEntry[];
  observed: Observed[];
}

/** One `sync(account)` with no cursor: the adapter's first sync. */
async function firstSync(r: Rig): Promise<Attempt> {
  const startedAt = r.clock.now();
  let error: Error | undefined;
  let threads = 0;
  try {
    threads = (await r.adapter.sync(r.account, undefined, { has: () => false })).threads.length;
  } catch (caught) {
    error = caught as Error;
  }
  return { error, threads, startedAt, log: [], observed: [] };
}

/**
 * Splits the log by attempt start times. When one worker gives up, `Promise.all` rejects but the
 * other three keep retrying for a moment; their refusals belong to the attempt that started them.
 */
function slice(r: Rig, attempts: Attempt[]): void {
  attempts.forEach((attempt, i) => {
    const end = attempts[i + 1]?.startedAt ?? Infinity;
    attempt.log = r.emu.log.filter(e => e.at >= attempt.startedAt && e.at < end);
    attempt.observed = r.observed.filter(c => c.at >= attempt.startedAt && c.at < end);
  });
}

/**
 * The access token the adapter holds dies after one fake hour, but the adapter believes it is good
 * for a year of real time and would report "authorization expired". Any run past that point would
 * fail because of the rig, not the adapter, so every scenario checks it stayed inside.
 */
function assertWithinTokenLife(r: Rig): void {
  assert.ok(
    r.clock.now() < r.tokenExpiresAt,
    'the run outlived the emulator access token: a rig artifact, not D1',
  );
  assert.ok(!r.emu.log.some(e => e.status === 401), 'no 401 during the run');
}

/**
 * When the engine starts its next sync: the gate's backoff after `failures` straight failures
 * (apps/desktop/src/engine/gate.ts: 30 s doubling, capped at 15 min), rounded up to the next 60 s
 * auto-sync tick (service.ts autoSyncMs), counted from the tick that started the first attempt.
 */
function nextEngineAttempt(firstTick: number, failedAt: number, failures: number): number {
  const retryAt = failedAt + Math.min(900_000, 30_000 * 2 ** (failures - 1));
  return firstTick + Math.ceil((retryAt - firstTick) / 60_000) * 60_000;
}

const fullGets = (log: RequestLogEntry[]) => log.filter(e => e.apiMethod === THREADS_GET);
const accepted = (log: RequestLogEntry[]) => fullGets(log).filter(e => e.status === 200);
const refused = (log: RequestLogEntry[]) => fullGets(log).filter(e => e.status !== 200);
const unitsBefore = (log: RequestLogEntry[], at: number) =>
  log.filter(e => e.at > at - 60_000 && e.at < at).reduce((sum, e) => sum + e.units, 0);

/** Every refused thread was tried six times (one call plus five retries), spaced by the adapter's own backoff. */
function assertBackoff(attempt: Attempt, latencyMs: number): number {
  const byThread = new Map<string, Observed[]>();
  for (const call of attempt.observed) {
    if (call.apiMethod !== 'threads.get') continue;
    const list = byThread.get(call.threadId!) ?? [];
    list.push(call);
    byThread.set(call.threadId!, list);
  }
  const refusedThreads = [...byThread.values()].filter(calls => calls.some(c => c.status === 403));
  assert.ok(refusedThreads.length >= 1, 'at least one thread was refused');
  for (const calls of refusedThreads) {
    assert.equal(
      calls.length,
      BACKOFF_MS.length + 1,
      'a refused thread is called once and retried five times',
    );
    assert.ok(
      calls.every(c => c.status === 403),
      'no retry got through: the window never freed in time',
    );
    for (let i = 1; i < calls.length; i++) {
      const gap = calls[i].at - calls[i - 1].at - latencyMs;
      assert.ok(
        gap >= BACKOFF_MS[i - 1] && gap < BACKOFF_MS[i - 1] + JITTER_MS,
        `retry ${i} waited ${gap} ms`,
      );
    }
  }
  return refusedThreads.length;
}

test('D1 0.2.3 first sync never finishes on a 6,000-unit quota (asserts the old failure; prov-gmail inverts it)', async () => {
  const r = await rig();
  try {
    const attempts: Attempt[] = [];
    const firstTick = r.clock.now();
    attempts.push(await firstSync(r));
    for (let again = 1; again <= 3; again++) {
      // The engine retries on its auto-sync tick once the gate's doubling backoff has passed.
      await r.clock.advanceTo(nextEngineAttempt(firstTick, r.clock.now(), again));
      attempts.push(await firstSync(r));
    }
    // Let the last attempt's remaining workers finish their retries, then split the log per attempt.
    await r.clock.advance(60_000);
    slice(r, attempts);

    let firstIds: string[] | undefined;
    for (const [index, attempt] of attempts.entries()) {
      const label = `attempt ${index + 1}`;
      // The call rejects with the adapter's rate-limit error and returns nothing.
      assert.ok(attempt.error, `${label} rejects`);
      assert.match(attempt.error.message, /Google rate limit reached/);
      assert.equal((attempt.error as Error & { status?: number }).status, 429);
      assert.equal(attempt.threads, 0);

      // Each attempt starts with an empty window and re-spends it from zero.
      assert.equal(
        unitsBefore(r.emu.log, attempt.startedAt),
        0,
        `${label} starts on an empty window`,
      );

      // About 50 full fetches at 120 units fit in the first seconds: 6,000 - 1 (profile) - 10 (list) = 5,989,
      // less the 20-unit attachments.get calls for HTML bodies Gmail stores as attachments.
      const ok = accepted(attempt.log);
      const attachmentGets = attempt.log.filter(
        e => e.apiMethod === ATTACHMENTS_GET && e.status === 200,
      );
      assert.ok(
        attachmentGets.length >= 1,
        `${label} also exercised the serial attachments.get path`,
      );
      assert.ok(ok.length >= 45 && ok.length <= 49, `${label} fetched ${ok.length} threads`);
      assert.ok(
        ok.every(e => e.units === 120),
        'full threads.get costs 120 units',
      );
      const spent = attempt.log.reduce((sum, e) => sum + e.units, 0);
      assert.ok(spent > 6000 - 120 && spent <= 6000, `${label} filled its window (${spent} units)`);
      assert.ok(
        ok.at(-1)!.at - attempt.startedAt < 10_000,
        `${label} spent its window in under 10 s`,
      );
      assert.ok(ok.length < INITIAL_THREADS / 5, 'far short of the 500 threads a first sync needs');

      // Then refusals: 403 rateLimitExceeded, free, every one retried five times with the adapter's backoff.
      const no = refused(attempt.log);
      assert.ok(no.length > 0);
      assert.ok(
        no.every(e => e.status === 403 && e.reason === 'rateLimitExceeded' && e.units === 0),
      );
      assert.ok(
        attempt.log.every(e => e.status !== 403 || e.apiMethod === THREADS_GET),
        'only thread fetches were refused',
      );
      assert.ok(no[0].at >= ok.at(-1)!.at, 'refusals follow the accepted fetches');
      const refusedThreads = assertBackoff(attempt, r.latencyMs);
      assert.equal(no.length, refusedThreads * 6);
      // Every worker was refused and gave up long before the window would free (about 31 s of retries).
      assert.equal(refusedThreads, 4, 'all four workers hit the wall');
      assert.ok(
        no.at(-1)!.at - attempt.startedAt < 40_000,
        `${label} gave up before the 60 s window freed`,
      );

      // The same first threads are fetched again each time: nothing from the last attempt was kept.
      const ids = attempt.observed
        .filter(c => c.apiMethod === 'threads.get' && c.status === 200)
        .map(c => c.threadId!)
        .sort();
      if (!firstIds) firstIds = ids;
      else assert.deepEqual(ids, firstIds, `${label} re-downloads the same threads`);
    }

    // No 60 s window ever charges more than the quota, measured from the emulator's own log and meter.
    unitsNeverAbove(r.emu.log, 6000);
    assertWithinTokenLife(r);
    assert.ok(r.emu.meter.peakWindow() <= 6000);
    assert.ok(r.emu.meter.peakWindow() > 5800, 'the window was spent in full each time');

    const successes = attempts.reduce((sum, a) => sum + accepted(a.log).length, 0);
    const refusals = attempts.reduce((sum, a) => sum + refused(a.log).length, 0);
    const units = r.emu.log.reduce((sum, e) => sum + e.units, 0);
    const seconds = ((r.clock.now() - attempts[0].startedAt) / 1000).toFixed(1);
    // Content-free summary: counts and times only.
    console.log(
      `D1 legacy: attempts=${attempts.length} successes=${successes} unique=${firstIds!.length} refusals=${refusals} units=${units} peakWindow=${r.emu.meter.peakWindow()} clockSeconds=${seconds} threadsReturned=0`,
    );
  } finally {
    await r.dispose();
  }
});

test('D1 control: the same mailbox syncs when the quota is grandfathered (10-unit thread gets)', async () => {
  const r = await rig({ grandfathered: true });
  try {
    const attempt = await firstSync(r);
    slice(r, [attempt]);
    assert.equal(attempt.error, undefined, attempt.error?.message);
    assert.equal(attempt.threads, INITIAL_THREADS);
    const ok = accepted(attempt.log);
    assert.equal(ok.length, INITIAL_THREADS);
    assert.ok(ok.every(e => e.units === 10));
    assert.equal(refused(attempt.log).length, 0);
    unitsNeverAbove(r.emu.log, 6000);
    assertWithinTokenLife(r);
  } finally {
    await r.dispose();
  }
});

test('D1 control: the same adapter syncs 500 full threads when the minute holds them all', async () => {
  // 500 x 120 + 11 (profile and list) = 60,011 units, all inside one minute at four in parallel.
  const r = await rig({ unitsPerMinute: 61_000 });
  try {
    const attempt = await firstSync(r);
    slice(r, [attempt]);
    assert.equal(attempt.error, undefined, attempt.error?.message);
    assert.equal(attempt.threads, INITIAL_THREADS);
    assert.equal(accepted(attempt.log).length, INITIAL_THREADS);
    assert.equal(refused(attempt.log).length, 0);
    unitsNeverAbove(r.emu.log, 61_000);
    assertWithinTokenLife(r);
  } finally {
    await r.dispose();
  }
});

test('D1 control: with Retry-After on the 403, the same adapter finishes slowly instead of failing', async () => {
  // 0.2.3 waits min(Retry-After, 30 s) per retry; five such waits outlast the 60 s window, so every
  // thread eventually gets through. This is why the gate pins retryAfter: 'none'.
  const r = await rig({ retryAfter: 'seconds' });
  try {
    const attempt = await firstSync(r);
    slice(r, [attempt]);
    assert.equal(attempt.error, undefined, attempt.error?.message);
    assert.equal(attempt.threads, INITIAL_THREADS);
    assert.ok(refused(attempt.log).length > 0, 'it was throttled along the way');
    assert.ok(
      r.clock.now() - attempt.startedAt > 5 * 60_000,
      'and took many minutes of clock time',
    );
    unitsNeverAbove(r.emu.log, 6000);
    assertWithinTokenLife(r);
  } finally {
    await r.dispose();
  }
});
