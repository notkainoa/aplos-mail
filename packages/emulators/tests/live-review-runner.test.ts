import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGmailEmulator, FakeClock, type GmailEmulator } from '../src/index';
import {
  parseArgs,
  runLive,
  type RunArgs,
  type RunDeps,
} from '../../../apps/desktop/scripts/live/run';
import * as signin from '../../../apps/desktop/scripts/live/signin';
import * as vault from '../../../apps/desktop/scripts/live/vault';
import { emptyResult, type SmokeProbe, type Tier } from '../../../apps/desktop/scripts/live/types';

/**
 * The runner-side gaps of the guard review (plans/STATUS.md 2026-10-28 08:05): the mutating tiers
 * run only on the account that signed in, the login hint stays out of argv, and the probe context
 * cannot be swapped out. Every test here failed before its fix.
 */

const CLIENT = { clientId: 'live-client', clientSecret: 'live-secret' };
const PROBE_ID = 'gmail.profile-and-labels';

interface Fixture {
  emu: GmailEmulator;
  clock: FakeClock;
  vaultDir: string;
  secrets: Map<string, string>;
  deps: RunDeps;
}

async function fixture(): Promise<Fixture> {
  const clock = new FakeClock();
  const emu = createGmailEmulator({ clock, latencyMs: 0 });
  emu.oauth.addClient(CLIENT.clientId, CLIENT.clientSecret);
  emu.seedMailbox({ threads: 5, seed: 3 });
  const vaultDir = await mkdtemp(join(tmpdir(), 'aplos-review-vault-'));
  const evidence = await mkdtemp(join(tmpdir(), 'aplos-review-evidence-'));
  const secrets = new Map<string, string>();
  return {
    emu,
    clock,
    vaultDir,
    secrets,
    deps: {
      env: {
        APLOS_LIVE_VAULT: vaultDir,
        APLOS_GOOGLE_CLIENT_ID: CLIENT.clientId,
        APLOS_GOOGLE_CLIENT_SECRET: CLIENT.clientSecret,
      },
      fetch: (input, init) => emu.fetch(input, init),
      readSecret: async service => {
        const value = secrets.get(service);
        if (!value) throw new Error('no such keychain item');
        return value;
      },
      now: () => clock.now(),
      sleep: ms => clock.advance(ms),
      log: () => undefined,
      evidenceDir: evidence,
      probes: [],
    },
  };
}

async function signInAgent(f: Fixture): Promise<void> {
  await signin.signIn(
    { label: 'agent', client: CLIENT },
    {
      fetch: f.emu.fetch,
      opener: async url => void (await fetch(new URL(f.emu.oauth.authorize(url, {})))),
      readSecret: f.deps.readSecret,
      writeSecret: async (service, value) => void f.secrets.set(service, value),
      now: () => f.clock.now(),
      vaultDir: f.vaultDir,
      timeoutMs: 5000,
    },
  );
}

const args = (tier: Tier): RunArgs => ({
  provider: 'gmail',
  tier,
  account: 'agent',
  dryRun: false,
  confirmMutating: true,
});

/** A probe of the given tier that creates a label (a write) and records that it ran. */
function writingProbe(tier: Tier, ran: string[]): SmokeProbe {
  return {
    id: PROBE_ID,
    provider: 'gmail',
    tier,
    async run(ctx) {
      ran.push(tier);
      const response = await ctx.fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `aplos-review-${tier}` }),
      });
      return emptyResult(response.ok ? 'pass' : 'fail');
    },
  };
}

const writesIn = (f: Fixture): string[] =>
  f.emu.log
    .filter(entry => entry.httpMethod !== 'GET' && entry.apiMethod !== 'oauth.token')
    .map(entry => entry.apiMethod);

// ---------- (7) the mutating tiers check the signed-in account against the vault ----------

test('review 7: sign-in stores a salted hash of the account address, never the address', async () => {
  const f = await fixture();
  await signInAgent(f);
  const address = f.emu.mailbox.emailAddress;
  const stored = (await vault.loadAccounts(f.vaultDir)).agent!;
  assert.equal(typeof stored.addressSalt, 'string');
  assert.equal(typeof stored.addressHash, 'string');
  assert.equal(stored.addressHash, vault.addressHash(address, stored.addressSalt!));
  const file = await readFile(join(f.vaultDir, 'accounts.json'), 'utf8');
  assert.ok(!file.toLowerCase().includes(address.toLowerCase()), 'the address is in the vault');
  assert.ok(!file.toLowerCase().includes(address.split('@')[0]!.toLowerCase()));

  await signInAgent(f);
  const again = (await vault.loadAccounts(f.vaultDir)).agent!;
  assert.notEqual(again.addressSalt, stored.addressSalt, 'every sign-in draws a new salt');
});

test('review 7: tiers M and S-self run when the signed-in account matches the stored hash', async () => {
  const f = await fixture();
  await signInAgent(f);
  for (const tier of ['M', 'S-self'] as const) {
    const ran: string[] = [];
    f.deps.probes = [writingProbe(tier, ran)];
    const outcome = await runLive(args(tier), f.deps);
    assert.equal(outcome.exitCode, 0, tier);
    assert.deepEqual(ran, [tier]);
  }
  assert.equal(writesIn(f).length, 2);
});

test('review 7: another signed-in account refuses tiers M and S-self before any write', async () => {
  const f = await fixture();
  await signInAgent(f);
  const stored = (await vault.loadAccounts(f.vaultDir)).agent!;
  await vault.saveAccount(f.vaultDir, 'agent', {
    ...stored,
    addressHash: vault.addressHash('owner.main@example.test', stored.addressSalt!),
  });
  for (const tier of ['M', 'S-self'] as const) {
    const ran: string[] = [];
    f.deps.probes = [writingProbe(tier, ran)];
    await assert.rejects(runLive(args(tier), f.deps), /does not match/);
    assert.deepEqual(ran, [], 'no probe ran');
  }
  assert.deepEqual(writesIn(f), []);
});

test('review 7: an account signed in without an address hash refuses every tier, R included', async () => {
  const f = await fixture();
  await signInAgent(f);
  const {
    addressHash: _hash,
    addressSalt: _salt,
    ...legacy
  } = (await vault.loadAccounts(f.vaultDir)).agent!;
  await vault.saveAccount(f.vaultDir, 'agent', legacy);
  const logBefore = f.emu.log.length;
  for (const tier of ['R', 'M', 'S-self'] as const) {
    const ran: string[] = [];
    f.deps.probes = [writingProbe(tier, ran)];
    await assert.rejects(runLive(args(tier), f.deps), /sign it in again/);
    assert.deepEqual(ran, []);
  }
  assert.equal(f.emu.log.length, logBefore, 'no request at all, not even the token refresh');
});

test('account binding: tier R checks the signed-in account too, and runs on the agent label only', async () => {
  const f = await fixture();
  await signInAgent(f);
  const stored = (await vault.loadAccounts(f.vaultDir)).agent!;
  await vault.saveAccount(f.vaultDir, 'agent', {
    ...stored,
    addressHash: vault.addressHash('owner.main@example.test', stored.addressSalt!),
  });
  const ran: string[] = [];
  const reader: SmokeProbe = {
    id: PROBE_ID,
    provider: 'gmail',
    tier: 'R',
    async run() {
      ran.push('R');
      return emptyResult();
    },
  };
  f.deps.probes = [reader];
  await assert.rejects(runLive(args('R'), f.deps), /does not match/);
  assert.deepEqual(ran, [], 'no probe read the mailbox of another account');

  // Another vault label is refused before the vault is read, whatever the tier.
  await vault.saveAccount(f.vaultDir, 'spare', stored);
  await assert.rejects(runLive({ ...args('R'), account: 'spare' }, f.deps), /agent test account/);
  assert.deepEqual(ran, []);
});

test('review 7: a malformed hash or salt in the vault is rejected as metadata', async () => {
  const f = await fixture();
  await signInAgent(f);
  const stored = (await vault.loadAccounts(f.vaultDir)).agent!;
  await assert.rejects(
    vault.saveAccount(f.vaultDir, 'agent', { ...stored, addressHash: 'agent@example.test' }),
    /address hash/,
  );
  await assert.rejects(
    vault.saveAccount(f.vaultDir, 'agent', { ...stored, addressSalt: undefined }),
    /address hash/,
  );
});

// ---------- (8) the login hint stays out of argv; parseArgs names both providers ----------

test('review 8: --login-hint is refused on the command line; the hint comes from APLOS_LIVE_LOGIN_HINT', () => {
  const parse = signin.signInArgsFrom;
  assert.equal(typeof parse, 'function');
  assert.throws(
    () => parse(['--provider', 'gmail', '--label', 'agent', '--login-hint', 'a@example.test'], {}),
    /APLOS_LIVE_LOGIN_HINT/,
  );
  assert.throws(
    () => parse(['--provider', 'gmail', '--label', 'agent', '--login-hint=a@example.test'], {}),
    /APLOS_LIVE_LOGIN_HINT/,
  );
  assert.deepEqual(
    parse(['--provider', 'gmail', '--label', 'agent'], {
      APLOS_LIVE_LOGIN_HINT: 'agent@example.test',
    }),
    { label: 'agent', loginHint: 'agent@example.test' },
  );
  assert.deepEqual(parse(['--provider', 'gmail', '--label', 'agent'], {}), { label: 'agent' });
});

test('review 8: parseArgs names both providers it accepts', () => {
  assert.throws(
    () => parseArgs(['--provider', 'outlook', '--tier', 'R', '--account', 'agent']),
    /gmail or gcal/,
  );
  assert.equal(
    parseArgs(['--provider', 'gcal', '--tier', 'R', '--account', 'agent', '--dry-run']).provider,
    'gcal',
  );
});

// ---------- (6) the probe context cannot be swapped out ----------

test('review 6: a probe cannot replace ctx.fetch for the probes after it', async () => {
  const f = await fixture();
  await signInAgent(f);
  const seen: unknown[] = [];
  const swapper: SmokeProbe = {
    id: PROBE_ID,
    provider: 'gmail',
    tier: 'R',
    async run(ctx) {
      try {
        (ctx as { fetch: typeof fetch }).fetch = async () => new Response('{}');
      } catch {
        // a frozen context throws in strict mode
      }
      return emptyResult();
    },
  };
  const after: SmokeProbe = {
    id: 'gmail.inbox-window-metadata',
    provider: 'gmail',
    tier: 'R',
    async run(ctx) {
      seen.push(typeof (ctx.fetch as { requests?: unknown }).requests);
      return emptyResult();
    },
  };
  f.deps.probes = [swapper, after];
  await runLive(args('R'), f.deps);
  assert.deepEqual(seen, ['function'], 'the second probe got the guarded fetch');
});
