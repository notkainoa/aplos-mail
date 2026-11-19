import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGmailEmulator, FakeClock, type GmailEmulator } from '../src/index';
import { createGuardedFetch, GuardRefusal } from '../../../apps/desktop/scripts/live/guard';
import { defaultEvidenceDir, renderEvidence } from '../../../apps/desktop/scripts/live/evidence';
import {
  parseArgs,
  runLive,
  type RunArgs,
  type RunDeps,
} from '../../../apps/desktop/scripts/live/run';
import { acquireRunLock, LOCK_FILE } from '../../../apps/desktop/scripts/live/run-lock';
import { gitRevision } from '../../../apps/desktop/scripts/live/revision';
import * as signin from '../../../apps/desktop/scripts/live/signin';
import * as vault from '../../../apps/desktop/scripts/live/vault';
import { emptyResult, type SmokeProbe } from '../../../apps/desktop/scripts/live/types';

/**
 * The merge gate of PR #38 (plans/STATUS.md 2026-10-28 14:22): one run at a time, evidence outside
 * the repository, the run pinned to a clean commit, and no media form of drafts.send. Every test
 * here failed before its fix. The account binding and the strict recipients are tested beside the
 * older tests they changed (live-review-runner and live-attack).
 */

const CLIENT = { clientId: 'live-client', clientSecret: 'live-secret' };
const PROBE_ID = 'gmail.profile-and-labels';
const SHA = 'a'.repeat(40);

interface Fixture {
  emu: GmailEmulator;
  vaultDir: string;
  evidenceDir: string;
  deps: RunDeps;
}

async function fixture(): Promise<Fixture> {
  const clock = new FakeClock();
  const emu = createGmailEmulator({ clock, latencyMs: 0 });
  emu.oauth.addClient(CLIENT.clientId, CLIENT.clientSecret);
  emu.seedMailbox({ threads: 5, seed: 3 });
  const vaultDir = await mkdtemp(join(tmpdir(), 'aplos-gate-vault-'));
  const evidenceDir = await mkdtemp(join(tmpdir(), 'aplos-gate-evidence-'));
  const secrets = new Map<string, string>();
  const readSecret = async (service: string): Promise<string> => {
    const value = secrets.get(service);
    if (!value) throw new Error('no such keychain item');
    return value;
  };
  await signin.signIn(
    { label: 'agent', client: CLIENT },
    {
      fetch: emu.fetch,
      opener: async url => void (await fetch(new URL(emu.oauth.authorize(url, {})))),
      readSecret,
      writeSecret: async (service, value) => void secrets.set(service, value),
      now: () => clock.now(),
      vaultDir,
      timeoutMs: 5000,
    },
  );
  return {
    emu,
    vaultDir,
    evidenceDir,
    deps: {
      env: {
        APLOS_LIVE_VAULT: vaultDir,
        APLOS_GOOGLE_CLIENT_ID: CLIENT.clientId,
        APLOS_GOOGLE_CLIENT_SECRET: CLIENT.clientSecret,
      },
      fetch: (input, init) => emu.fetch(input, init),
      readSecret,
      now: () => clock.now(),
      sleep: ms => clock.advance(ms),
      log: () => undefined,
      evidenceDir,
      probes: [readingProbe()],
    },
  };
}

const args = (extra: Partial<RunArgs> = {}): RunArgs => ({
  provider: 'gmail',
  tier: 'R',
  account: 'agent',
  dryRun: false,
  confirmMutating: false,
  ...extra,
});

/** A tier R probe that reads the profile, optionally waiting for `gate` first. */
function readingProbe(gate?: { started(): void; until: Promise<void> }): SmokeProbe {
  return {
    id: PROBE_ID,
    provider: 'gmail',
    tier: 'R',
    async run(ctx) {
      gate?.started();
      await gate?.until;
      const response = await ctx.fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile');
      return emptyResult(response.ok ? 'pass' : 'fail');
    },
  };
}

/** The PID of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.ok(child.pid);
  return child.pid;
}

const lockIn = (dir: string): string => join(dir, LOCK_FILE);

// ---------- (3) one run at a time ----------

test('run lock: a lock held by a running process refuses the run before any request', async () => {
  const f = await fixture();
  await writeFile(lockIn(f.vaultDir), `${process.pid}\n`);
  const before = f.emu.log.length;
  await assert.rejects(runLive(args(), f.deps), /Another live run is going/);
  assert.equal(f.emu.log.length, before, 'no request was made');
  assert.equal(await readFile(lockIn(f.vaultDir), 'utf8'), `${process.pid}\n`, 'lock untouched');
});

test('run lock: two runners side by side, the second refuses; the lock is gone afterwards', async () => {
  const f = await fixture();
  let started!: () => void;
  const running = new Promise<void>(resolve => (started = resolve));
  let finish!: () => void;
  const until = new Promise<void>(resolve => (finish = resolve));
  const first = runLive(args(), { ...f.deps, probes: [readingProbe({ started, until })] });
  await running;
  assert.equal(await readFile(lockIn(f.vaultDir), 'utf8'), `${process.pid}\n`);
  await assert.rejects(runLive(args(), f.deps), /Another live run is going/);
  finish();
  assert.equal((await first).exitCode, 0);
  assert.deepEqual(await readdir(f.vaultDir), ['accounts.json'], 'the lock was released');
  assert.equal((await runLive(args(), f.deps)).exitCode, 0, 'and the next run may go');
});

test('run lock: a dead runner’s lock is taken over, and the lock is released on error too', async () => {
  const f = await fixture();
  await writeFile(lockIn(f.vaultDir), `${deadPid()}\n`);
  assert.equal((await runLive(args(), f.deps)).exitCode, 0);
  assert.deepEqual(await readdir(f.vaultDir), ['accounts.json']);

  // An error after the lock is taken (the token belongs to another account) still releases it.
  const stored = (await vault.loadAccounts(f.vaultDir)).agent!;
  await vault.saveAccount(f.vaultDir, 'agent', {
    ...stored,
    addressHash: vault.addressHash('owner.main@example.test', stored.addressSalt!),
  });
  await assert.rejects(runLive(args(), f.deps), /does not match/);
  assert.deepEqual(await readdir(f.vaultDir), ['accounts.json']);
});

test('run lock: an empty lockfile refuses (a runner may be writing it); release keeps a lock it lost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-gate-lock-'));
  await writeFile(lockIn(dir), '');
  await assert.rejects(acquireRunLock(dir, { pid: 4242 }), /no process id yet/);

  const other = await mkdtemp(join(tmpdir(), 'aplos-gate-lock-'));
  const lock = await acquireRunLock(other, { pid: 4242, isAlive: () => false });
  // Another runner took the (apparently stale) lock over meanwhile: releasing must not remove it.
  await writeFile(lockIn(other), '4343\n');
  await lock.release();
  assert.equal(await readFile(lockIn(other), 'utf8'), '4343\n');
});

// ---------- (4) evidence outside the repository ----------

test('evidence: the default folder is Application Support/Aplos Mail Review/live/<date>/', async () => {
  assert.match(
    defaultEvidenceDir('2026-10-28'),
    /Library\/Application Support\/Aplos Mail Review\/live\/2026-10-28$/,
  );
  assert.throws(() => defaultEvidenceDir('../../x'));

  const f = await fixture();
  const home = await mkdtemp(join(tmpdir(), 'aplos-gate-home-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const outcome = await runLive(args(), { ...f.deps, evidenceDir: undefined });
    const date = outcome.evidencePath!.match(/(\d{4}-\d{2}-\d{2})-gmail\.md$/)![1]!;
    assert.equal(
      outcome.evidencePath,
      join(
        home,
        'Library',
        'Application Support',
        'Aplos Mail Review',
        'live',
        date,
        `${date}-gmail.md`,
      ),
    );
    assert.ok(!outcome.evidencePath!.includes('verification'));
  } finally {
    process.env.HOME = saved;
  }
  // An explicit folder still wins, as before.
  const explicit = await runLive(args(), f.deps);
  assert.ok(explicit.evidencePath!.startsWith(f.evidenceDir));
});

// ---------- SHOULD: the run is pinned to a clean commit ----------

test('expect-sha: the command line needs it for a real run, as a full SHA', () => {
  const base = ['--provider', 'gmail', '--tier', 'R', '--account', 'agent'];
  assert.throws(() => parseArgs(base), /--expect-sha/);
  assert.throws(() => parseArgs([...base, '--expect-sha', 'abc1234']), /40-character/);
  assert.equal(parseArgs([...base, '--expect-sha', SHA]).expectSha, SHA);
  assert.equal(parseArgs([...base, '--dry-run']).expectSha, undefined);
});

test('expect-sha: another HEAD or a dirty tree refuses before any request; the SHA is in the evidence', async () => {
  const f = await fixture();
  const before = f.emu.log.length;
  const other = { ...f.deps, revision: async () => ({ head: 'b'.repeat(40), clean: true }) };
  await assert.rejects(runLive(args({ expectSha: SHA }), other), /HEAD is not the commit/);
  const dirty = { ...f.deps, revision: async () => ({ head: SHA, clean: false }) };
  await assert.rejects(runLive(args({ expectSha: SHA }), dirty), /working tree has changes/);
  assert.equal(f.emu.log.length, before);

  const clean = { ...f.deps, revision: async () => ({ head: SHA, clean: true }) };
  const outcome = await runLive(args({ expectSha: SHA }), clean);
  assert.match(await readFile(outcome.evidencePath!, 'utf8'), new RegExp(`Commit: ${SHA}`));
  assert.throws(
    () =>
      renderEvidence(
        {
          provider: 'gmail',
          tier: 'R',
          date: '2026-10-28',
          startedAt: '2026-10-28T10:00:00.000Z',
          node: '24.0.0',
          daysToExpiry: 6,
          commit: 'not-a-sha',
          results: [],
          unitsPerMinute: [],
          peakUnitsPerWindow: 0,
        },
        [],
      ),
    /commit/,
  );
  assert.match((await gitRevision()).head, /^[0-9a-f]{40}$/);
});

// ---------- SHOULD: no media form of drafts.send ----------

test('drafts.send has no media upload form, even for a message to self', async () => {
  const sent: string[] = [];
  const guard = createGuardedFetch(
    async input => {
      sent.push(String(input));
      return new Response('{}');
    },
    { tier: 'S-self', selfAddress: 'self@example.test' },
  );
  await assert.rejects(
    guard('https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts/send?uploadType=media', {
      method: 'POST',
      headers: { 'content-type': 'message/rfc822' },
      body: 'To: self@example.test\r\n\r\nhi',
    }),
    (error: unknown) => error instanceof GuardRefusal && error.reason === 'unknown-endpoint',
  );
  assert.deepEqual(sent, []);
});
