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
  createFaultInjector,
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
  sendPosts.count = 0;
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
    fetch: (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (/\/messages\/send$/.test(url.pathname) && (init?.method ?? 'GET') === 'POST')
        sendPosts.count++;
      return emu.fetch(input, init);
    },
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

/** Every POST to messages.send the runner's fetch made, faulted ones included. */
const sendPosts = { count: 0 };

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
    probesFor('gmail', 'S-self')
      .map(p => p.id)
      .sort(),
    ['gmail.adapter-send-find', 'gmail.send-message-id'],
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

test('the duplicate check fails closed: a server error on the search sends nothing', async () => {
  const faults = createFaultInjector();
  const r = await rig({ faults });
  faults.failNext(
    { apiMethod: 'gmail.users.messages.list' },
    { status: 500, reason: 'backendError', message: 'Backend Error' },
  );
  const out = await r.run();
  assert.equal(out.status, 'fail');
  assert.match(out.text, /Error classes: server=1/);
  assert.equal(sendPosts.count, 0, 'no send was attempted');
  assert.equal(probeMessages(r.emu).length, 0);
  assert.equal(out.counts.sent, undefined);
});

for (const [name, fault] of [
  [
    'a 503',
    (f: ReturnType<typeof createFaultInjector>) =>
      f.failNext(
        { apiMethod: 'gmail.users.messages.send' },
        { status: 503, reason: 'backendError', message: 'Backend Error' },
        { times: 5 },
      ),
  ],
  [
    'a dropped connection',
    (f: ReturnType<typeof createFaultInjector>) =>
      f.dropNext({ apiMethod: 'gmail.users.messages.send' }, { times: 5 }),
  ],
] as const) {
  test(`the send is never retried: ${name} on messages.send is exactly one POST and a fail`, async () => {
    const faults = createFaultInjector();
    const r = await rig({ faults });
    fault(faults);
    const out = await r.run();
    assert.equal(out.status, 'fail');
    assert.equal(sendPosts.count, 1, 'exactly one send POST, no retry');
    assert.equal(out.counts.sent, undefined);
    assert.ok(!/@/.test(out.text));
  });
}

test('the same-day refusal also counts our fixed Message-ID, so a subject the search cannot match still refuses', async () => {
  const r = await rig();
  await r.run();
  // The probe message's subject is changed by a client; only the fixed Message-ID still identifies it.
  const [sent] = probeMessages(r.emu);
  const stored = r.emu.mailbox.getMessage(sent!.id)!;
  assert.ok(stored);
  r.emu.mailbox.deleteMessage(sent!.id);
  r.emu.mailbox.addMessage({
    subject: 'something else entirely',
    messageId:
      'aplos-live-probe-send-' +
      new Date().toISOString().slice(0, 10).replaceAll('-', '') +
      '@aplos.invalid',
    labelIds: ['INBOX'],
    text: 'x',
  });
  const before = sendPosts.count;
  const again = await r.run();
  assert.equal(again.status, 'fail');
  assert.equal(again.counts.probeMessagesExisting, 1);
  assert.equal(sendPosts.count, before, 'no second send');
});
