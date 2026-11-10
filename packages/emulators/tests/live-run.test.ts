import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGmailEmulator, FakeClock, type GmailEmulator } from '../src/index';
import {
  parseArgs,
  runLive,
  type RunArgs,
  type RunDeps,
} from '../../../apps/desktop/scripts/live/run';
import { signIn } from '../../../apps/desktop/scripts/live/signin';
import { loadAccounts } from '../../../apps/desktop/scripts/live/vault';
import { PROBES } from '../../../apps/desktop/scripts/live/probes';
import { emptyResult, type SmokeProbe } from '../../../apps/desktop/scripts/live/types';

const DAY = 86_400_000;
const CLIENT = { clientId: 'live-client', clientSecret: 'live-secret' };

interface Fixture {
  clock: FakeClock;
  emu: GmailEmulator;
  vault: string;
  evidence: string;
  secrets: Map<string, string>;
  lines: string[];
  deps: RunDeps;
  fetchCalls: number;
}

async function fixture(users = 1): Promise<Fixture> {
  const clock = new FakeClock();
  const emu = createGmailEmulator({ clock, latencyMs: 0 });
  emu.oauth.addClient(CLIENT.clientId, CLIENT.clientSecret);
  emu.seedMailbox({ threads: 120, seed: 5 });
  for (let i = 1; i < users; i++)
    emu.addUser({
      sub: `10000000000000000000${i + 1}`,
      email: `second${i}.user@example.test`,
      name: `Second ${i}`,
    });
  const vault = await mkdtemp(join(tmpdir(), 'aplos-live-vault-'));
  const evidence = await mkdtemp(join(tmpdir(), 'aplos-live-evidence-'));
  const secrets = new Map<string, string>();
  const lines: string[] = [];
  const f: Fixture = {
    clock,
    emu,
    vault,
    evidence,
    secrets,
    lines,
    fetchCalls: 0,
    deps: {
      env: {
        APLOS_LIVE_VAULT: vault,
        APLOS_GOOGLE_CLIENT_ID: CLIENT.clientId,
        APLOS_GOOGLE_CLIENT_SECRET: CLIENT.clientSecret,
      },
      fetch: (input, init) => {
        f.fetchCalls++;
        return emu.fetch(input, init);
      },
      readSecret: async service => {
        const value = secrets.get(service);
        if (!value) throw new Error('no such keychain item');
        return value;
      },
      now: () => clock.now(),
      sleep: ms => clock.advance(ms),
      log: line => void lines.push(line),
      evidenceDir: evidence,
      probes: PROBES,
    },
  };
  return f;
}

/** Runs the real sign-in (loopback server, PKCE) with an opener that plays the browser against the emulator. */
async function signInAs(
  f: Fixture,
  label = 'agent',
  options: { hint?: string; deny?: boolean; badState?: boolean; opened?: string[] } = {},
) {
  return signIn(
    { label, client: CLIENT, loginHint: options.hint },
    {
      fetch: f.emu.fetch,
      opener: async url => {
        options.opened?.push(url);
        const query = new URL(url).searchParams;
        const redirect = new URL(f.emu.oauth.authorize(url, { deny: options.deny }));
        if (options.badState) redirect.searchParams.set('state', 'not-the-state');
        assert.equal(
          redirect.hostname,
          query.get('redirect_uri') ? new URL(query.get('redirect_uri')!).hostname : '',
        );
        await fetch(redirect); // the browser following the redirect to the loopback server
      },
      readSecret: f.deps.readSecret,
      writeSecret: async (service, value) => void f.secrets.set(service, value),
      now: () => f.clock.now(),
      vaultDir: f.vault,
      timeoutMs: 5000,
    },
  );
}

const args = (extra: Partial<RunArgs> = {}): RunArgs => ({
  provider: 'gmail',
  tier: 'R',
  account: 'agent',
  dryRun: false,
  confirmMutating: false,
  ...extra,
});

test('sign-in round trip: PKCE on loopback, token in the secret store, metadata only in accounts.json', async () => {
  const f = await fixture(2);
  const opened: string[] = [];
  const outcome = await signInAs(f, 'agent', { hint: 'second1.user@example.test', opened });

  const url = new URL(opened[0]!);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('login_hint'), 'second1.user@example.test');
  assert.equal(url.searchParams.get('client_id'), 'live-client');
  assert.match(
    url.searchParams.get('redirect_uri')!,
    /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/,
  );
  assert.ok(url.searchParams.get('state'));
  assert.ok(url.searchParams.get('scope')!.includes('gmail.modify'));

  const accounts = await loadAccounts(f.vault);
  assert.deepEqual(Object.keys(accounts), ['agent']);
  assert.equal(accounts.agent!.keychainService, 'aplos-mail-live-agent');
  assert.equal(accounts.agent!.grantedAt, new Date(f.clock.now()).toISOString());
  assert.equal(
    accounts.agent!.refreshExpiresAt,
    new Date(f.clock.now() + 7 * DAY).toISOString(),
    'Google reports 7 days in testing mode',
  );
  assert.equal(outcome.reconnectBy, new Date(f.clock.now() + 7 * DAY).toISOString());

  const token = f.secrets.get('aplos-mail-live-agent')!;
  assert.ok(token.length > 10);
  const file = await readFile(join(f.vault, 'accounts.json'), 'utf8');
  assert.ok(!file.includes(token), 'no token in the vault file');
  assert.deepEqual(await readdir(f.vault), ['accounts.json']);
});

test('sign-in failures store nothing: denied consent and a mismatched state', async () => {
  const denied = await fixture();
  await assert.rejects(signInAs(denied, 'agent', { deny: true }), /access_denied/);
  assert.deepEqual(await loadAccounts(denied.vault), {});
  assert.equal(denied.secrets.size, 0);

  const forged = await fixture();
  await assert.rejects(signInAs(forged, 'agent', { badState: true }), /did not match/);
  assert.equal(forged.secrets.size, 0);
  await assert.rejects(signInAs(forged, 'me@example.test'), /lowercase/);
});

test('tier R run on a generated mailbox: probes pass, only reads are sent, and the evidence file is content-free', async () => {
  const f = await fixture();
  await signInAs(f);
  const logBefore = f.emu.log.length;

  const outcome = await runLive(args(), f.deps);
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.results));
  // gmail.archive-delta-cost is a phased probe: with no --phase it reports a skip, not a failure.
  assert.deepEqual(
    outcome.results.map(r => r.status),
    ['pass', 'pass', 'skip', 'pass'],
  );

  const sent = f.emu.log.slice(logBefore);
  const writes = sent.filter(entry => entry.httpMethod !== 'GET');
  assert.deepEqual(
    writes.map(entry => entry.apiMethod),
    ['oauth.token'],
    'the token refresh is the only non-GET',
  );
  assert.ok(sent.every(entry => entry.status < 400));
  const inbox = f.emu.mailbox.selectThreads({ labelIds: ['INBOX'] }).length;
  assert.ok(inbox > 5, 'the generated mailbox has an inbox');
  assert.equal(
    sent.filter(entry => entry.apiMethod === 'gmail.users.threads.get').length,
    Math.min(50, inbox),
  );

  const [profile, window] = outcome.results;
  assert.equal(profile!.counts.messagesTotal, f.emu.mailbox.messageCount);
  assert.ok(profile!.counts.userLabels! >= 0 && profile!.counts.systemLabels! > 0);
  assert.equal(window!.counts.threadsListed, Math.min(50, inbox));
  assert.equal(window!.counts.threadsFetched, window!.counts.threadsListed);
  assert.deepEqual(window!.requests.map(r => `${r.method} ${r.httpMethod} ${r.count}`).sort(), [
    `gmail.users.threads.get GET ${window!.counts.threadsListed}`,
    'gmail.users.threads.list GET 1',
  ]);
  assert.ok(
    window!.unitsPerMinute.length >= 1 &&
      window!.unitsPerMinute[0]! >= 40 * window!.counts.threadsFetched!,
  );

  // The emulator's own meter agrees the run stayed under 3,000 units a minute.
  assert.ok(f.emu.meter.peakWindow() < 3000, `peak ${f.emu.meter.peakWindow()}`);

  const text = await readFile(outcome.evidencePath!, 'utf8');
  assert.ok(outcome.evidencePath!.endsWith('2026-10-27-gmail.md'));
  assert.match(text, /Units per minute \(minute 0 first\): \d+/);
  assert.match(text, /Peak units in any 60 s window: \d+/);
  assert.match(text, /Days left before the test account must be reconnected: 7/);

  // Scan for everything generated: subjects, addresses, names, ids, label names and tokens.
  const secrets = new Set<string>([
    'example.test',
    '@',
    f.secrets.get('aplos-mail-live-agent')!,
    CLIENT.clientSecret,
    'Bearer',
  ]);
  for (const message of f.emu.mailbox.listMessages()) {
    for (const value of [
      message.subject,
      message.from,
      message.to,
      message.id,
      message.threadId,
      message.messageId,
    ])
      secrets.add(value);
    for (const part of message.from.split(/[<>,]/).map(p => p.trim()))
      if (part.length > 3) secrets.add(part);
  }
  for (const label of f.emu.mailbox.listLabels())
    if (label.type === 'user') secrets.add(label.name);
  assert.ok(secrets.size > 100, 'a real set of generated values is being scanned for');
  for (const secret of secrets)
    assert.ok(
      !text.includes(secret),
      `evidence contains generated content: ${secret.slice(0, 12)}`,
    );
  assert.ok(!f.lines.join('\n').match(/@|example\.test/), 'the console output is content-free too');
});

test('dry run prints the plan, reads no secret and makes no request', async () => {
  const f = await fixture();
  await signInAs(f);
  f.fetchCalls = 0;
  f.deps.readSecret = async () => assert.fail('a dry run must not touch the keychain');
  const outcome = await runLive(args({ dryRun: true }), f.deps);
  assert.equal(outcome.exitCode, 0);
  assert.equal(f.fetchCalls, 0);
  assert.match(
    f.lines.join('\n'),
    /Probes: gmail\.profile-and-labels, gmail\.inbox-window-metadata, gmail\.archive-delta-cost, gmail\.auth-results-shape/,
  );
  assert.match(f.lines.join('\n'), /reconnect by 2026-11-03/);
  assert.deepEqual(await readdir(f.evidence), []);
});

test('an expired test account is a skip with a plain message, its own result and not a failure', async () => {
  const f = await fixture();
  await signInAs(f);
  await f.clock.advance(8 * DAY);
  f.fetchCalls = 0;
  f.deps.readSecret = async () => assert.fail('an expired account must not be used');

  const outcome = await runLive(args(), f.deps);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.skipped, 'token-expiry');
  assert.deepEqual(
    outcome.results.map(r => r.status),
    ['skip', 'skip', 'skip', 'skip'],
  );
  assert.equal(f.fetchCalls, 0, 'zero requests');
  assert.deepEqual(f.lines, ['test account agent expires 2026-11-03, reconnect it first']);
  const text = await readFile(outcome.evidencePath!, 'utf8');
  assert.match(text, /Skipped: token-expiry/);
  assert.match(text, /reconnected: -1/);
});

test('a token that would expire during the run is skipped before the run starts', async () => {
  const f = await fixture();
  await signInAs(f);
  await f.clock.advance(7 * DAY - 3 * 60_000); // 2 probes need about 5 minutes
  f.fetchCalls = 0;
  const outcome = await runLive(args(), f.deps);
  assert.equal(outcome.skipped, 'token-expiry');
  assert.equal(f.fetchCalls, 0);
});

test('Google refusing the refresh token (invalid_grant) is a skip that asks for a reconnect', async () => {
  const f = await fixture();
  await signInAs(f);
  f.emu.oauth.revoke('test.user@example.test');
  const outcome = await runLive(args(), f.deps);
  assert.equal(outcome.skipped, 'token-refused');
  assert.equal(outcome.exitCode, 0);
  assert.equal(f.lines[0], 'test account agent was refused by Google, reconnect it first');
});

test('tier R: a probe that tries to change the mailbox fails, and the emulator never sees the write', async () => {
  const f = await fixture();
  await signInAs(f);
  const threadId = f.emu.mailbox.threadIds()[0]!;
  const rogue: SmokeProbe = {
    id: 'gmail.profile-and-labels',
    provider: 'gmail',
    tier: 'R',
    async run(ctx) {
      await ctx.fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`, {
        method: 'POST',
        body: JSON.stringify({ addLabelIds: ['STARRED'] }),
      });
      return emptyResult();
    },
  };
  f.deps.probes = [rogue];
  const logBefore = f.emu.log.length;
  const outcome = await runLive(args(), f.deps);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.results[0]!.status, 'fail');
  assert.deepEqual(outcome.results[0]!.errorClasses, { guard: 1 });
  assert.ok(
    f.emu.log
      .slice(logBefore)
      .every(entry => entry.httpMethod === 'GET' || entry.apiMethod === 'oauth.token'),
  );
  assert.ok(
    !f.emu.mailbox
      .getMessage(f.emu.mailbox.threadMessageIds(threadId)[0]!)!
      .labelIds.includes('STARRED'),
  );
});

test('tier S-self: a probe may send to the account itself, and the guard stops every other recipient', async () => {
  const f = await fixture();
  await signInAs(f);
  const self = f.emu.mailbox.emailAddress;
  const raw = (headers: string[]): string =>
    Buffer.from(`${headers.join('\r\n')}\r\nSubject: live self-send check\r\n\r\nbody`).toString(
      'base64url',
    );
  const outcomes: string[] = [];
  const sender: SmokeProbe = {
    id: 'gmail.profile-and-labels',
    provider: 'gmail',
    tier: 'S-self',
    async run(ctx) {
      for (const headers of [
        [`To: ${self}`],
        [`To: ${self}`, 'Cc: friend@example.test'],
        [`To: friend@example.test`],
        [`Bcc: friend@example.test`],
      ]) {
        try {
          const response = await ctx.fetch(
            'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ raw: raw(headers) }),
            },
          );
          outcomes.push(String(response.status));
        } catch (error) {
          outcomes.push((error as { reason?: string }).reason ?? 'error');
        }
      }
      return { ...emptyResult(), counts: { drafts: 1 } };
    },
  };
  f.deps.probes = [sender];

  await assert.rejects(runLive(args({ tier: 'S-self' }), f.deps), /confirm-mutating/);
  await assert.rejects(
    runLive(args({ tier: 'S-self', account: 'owner', confirmMutating: true }), f.deps),
    /only on the agent test account/,
  );

  const sentBefore = f.emu.mailbox.listMessages().filter(m => m.labelIds.includes('SENT')).length;
  const outcome = await runLive(args({ tier: 'S-self', confirmMutating: true }), f.deps);
  assert.deepEqual(outcomes, ['200', 'send-recipients', 'send-recipients', 'send-recipients']);
  assert.equal(outcome.exitCode, 0);
  const sent = f.emu.mailbox.listMessages().filter(m => m.labelIds.includes('SENT'));
  assert.equal(sent.length - sentBefore, 1, 'exactly one message left the account');
  assert.equal(f.emu.sendsToday(), 1);
  assert.deepEqual(outcome.results[0]!.requests, [
    { method: 'gmail.users.messages.send', httpMethod: 'POST', count: 1 },
  ]);
  assert.match(await readFile(outcome.evidencePath!, 'utf8'), /tier S-self/);
});

test('command line: tier S does not exist, and the mutating tiers need their flag', () => {
  assert.throws(
    () => parseArgs(['--provider', 'gmail', '--tier', 'S', '--account', 'agent']),
    /does not exist/,
  );
  assert.throws(
    () => parseArgs(['--provider', 'gmail', '--tier', 'X', '--account', 'agent']),
    /R, M or S-self/,
  );
  assert.throws(() => parseArgs(['--provider', 'gmail', '--tier', 'R']), /--account/);
  assert.deepEqual(
    parseArgs(['--provider', 'gmail', '--tier', 'S-self', '--account', 'agent', '--dry-run']),
    { provider: 'gmail', tier: 'S-self', account: 'agent', dryRun: true, confirmMutating: false },
  );
});
