/**
 * Tier S-self probe `gmail.send-message-id` (apps/desktop/scripts/live/probes/gmail-send-message-id.ts), through the real
 * runner and guard against the emulator: one self-addressed `messages.send`, a report of what Gmail did to our Message-ID.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGmailEmulator,
  FakeClock,
  type GmailEmulator,
  type GmailEmulatorOptions,
} from '../src/index';
import { runLive, type RunDeps } from '../../../apps/desktop/scripts/live/run';
import { signIn } from '../../../apps/desktop/scripts/live/signin';
import { PROBES, probesFor } from '../../../apps/desktop/scripts/live/probes';
import { COUNT_KEYS } from '../../../apps/desktop/scripts/live/evidence';
import { searchRetry } from '../../../apps/desktop/scripts/live/probes/gmail-send-message-id';

const CLIENT = { clientId: 'live-client', clientSecret: 'live-secret' };

async function rig(emulator: Partial<GmailEmulatorOptions> = {}) {
  searchRetry.waitMs = 0;
  const clock = new FakeClock();
  const emu: GmailEmulator = createGmailEmulator({ clock, latencyMs: 0, ...emulator });
  emu.oauth.addClient(CLIENT.clientId, CLIENT.clientSecret);
  emu.seedMailbox({ threads: 10, seed: 3 });
  const vault = await mkdtemp(join(tmpdir(), 'aplos-live-vault-'));
  const evidence = await mkdtemp(join(tmpdir(), 'aplos-live-evidence-'));
  const secrets = new Map<string, string>();
  const readSecret = async (service: string) => secrets.get(service)!;
  await signIn(
    { label: 'agent', client: CLIENT },
    {
      fetch: emu.fetch,
      opener: async url => {
        await fetch(new URL(emu.oauth.authorize(url)));
      },
      readSecret,
      writeSecret: async (service, value) => void secrets.set(service, value),
      now: () => clock.now(),
      vaultDir: vault,
      timeoutMs: 5000,
    },
  );
  const deps: RunDeps = {
    env: {
      APLOS_LIVE_VAULT: vault,
      APLOS_GOOGLE_CLIENT_ID: CLIENT.clientId,
      APLOS_GOOGLE_CLIENT_SECRET: CLIENT.clientSecret,
    },
    fetch: emu.fetch,
    readSecret,
    now: () => clock.now(),
    sleep: ms => clock.advance(ms),
    log: () => undefined,
    evidenceDir: evidence,
    probes: PROBES.filter(p => p.id === 'gmail.send-message-id'),
  };
  return {
    emu,
    async run(confirm = true) {
      const outcome = await runLive(
        {
          provider: 'gmail',
          tier: 'S-self',
          account: 'agent',
          dryRun: false,
          confirmMutating: confirm,
        },
        deps,
      );
      return {
        counts: outcome.results[0]!.counts,
        status: outcome.results[0]!.status,
        text: await readFile(outcome.evidencePath!, 'utf8'),
      };
    },
  };
}

const probeMessages = (emu: GmailEmulator) =>
  emu.mailbox.select({ q: 'subject:aplos-live-probe-send', includeSpamTrash: true });

test('Message-ID kept: one self-addressed send, shape ours, header kept, found by our id and by the shown id', async () => {
  const r = await rig();
  const before = r.emu.log.length;
  const out = await r.run();
  assert.equal(out.status, 'pass');
  const c = out.counts;
  assert.deepEqual(
    [c.sent, c.sentKeptMessageId, c.sentMessageIdShape, c.sentHeaderKept],
    [1, 1, 1, 1],
  );
  assert.deepEqual(
    [c.sentFoundByRfc822msgidOurs, c.sentFoundByRfc822msgidGmails, c.sentSearchTries],
    [1, 1, 1],
  );
  const calls = r.emu.log.slice(before).map(e => `${e.httpMethod} ${e.apiMethod}`);
  assert.equal(calls.filter(x => x === 'POST gmail.users.messages.send').length, 1, 'one send');
  assert.ok(!calls.some(x => /delete|trash|drafts|modify|settings/.test(x)), calls.join(', '));
  const [sent] = probeMessages(r.emu);
  assert.ok(sent);
  const view = r.emu.mailbox.getMessage(sent!.id)!;
  assert.equal(
    view.to.toLowerCase(),
    r.emu.mailbox.emailAddress.toLowerCase(),
    'only the account itself',
  );
});

test('Message-ID rewritten on send: shape Gmail-style, ours not kept, our id finds nothing in Sent, the shown id finds it', async () => {
  const r = await rig({ sendIdentity: 'rewritten' });
  const out = await r.run();
  assert.equal(out.status, 'pass');
  const c = out.counts;
  assert.deepEqual([c.sentKeptMessageId, c.sentMessageIdShape, c.sentHeaderKept], [0, 2, 1]);
  assert.equal(c.sentFoundByRfc822msgidOurs, 0);
  assert.equal(c.sentFoundByRfc822msgidGmails, 1);
  assert.equal(c.sentSearchTries, searchRetry.tries, 'the empty search was repeated to its bound');
});

test('a second run the same day refuses and sends nothing', async () => {
  const r = await rig();
  await r.run();
  const count = probeMessages(r.emu).length;
  const again = await r.run();
  assert.equal(again.status, 'fail');
  assert.equal(again.counts.probeMessagesExisting, 1);
  assert.equal(again.counts.sent, undefined);
  assert.equal(probeMessages(r.emu).length, count, 'no second message');
});

test('S-self needs --confirm-mutating; the evidence holds no address, id or text', async () => {
  const r = await rig();
  await assert.rejects(r.run(false), /--confirm-mutating/);
  assert.equal(probeMessages(r.emu).length, 0);
  const out = await r.run();
  const address = r.emu.mailbox.emailAddress;
  assert.ok(
    !out.text.includes(address) &&
      !/@|aplos-live-probe|aplos\.invalid/.test(out.text.replace(/gmail\.send-message-id/g, '')),
  );
});

test('the probe is a tier S-self probe only, and its counts are on the evidence allowlist', () => {
  assert.deepEqual(
    probesFor('gmail', 'S-self').map(p => p.id),
    ['gmail.send-message-id'],
  );
  assert.ok(!probesFor('gmail', 'R').some(p => p.id === 'gmail.send-message-id'));
  assert.ok(!probesFor('gmail', 'M').some(p => p.id === 'gmail.send-message-id'));
  for (const key of [
    'sent',
    'sentKeptMessageId',
    'sentMessageIdShape',
    'sentHeaderKept',
    'sentFoundByRfc822msgidOurs',
    'sentFoundByRfc822msgidGmails',
    'sentSearchTries',
    'probeMessagesExisting',
  ])
    assert.ok(COUNT_KEYS.includes(key), key);
});
