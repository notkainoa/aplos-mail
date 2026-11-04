/**
 * Tier S-self probe `gmail.adapter-send-find` (apps/desktop/scripts/live/probes/gmail-adapter-send.ts), through the real
 * runner and guard against the emulator: one self-addressed send THROUGH the adapter's `sendSubmission`, then the
 * adapter's `findSentCopy` on the Sent copy. The emulator does not model the media upload, so the test's final fetch
 * turns the guard-approved simple media upload (`uploadType=media`) into the equivalent JSON send, as Gmail stores it.
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
import {
  adapterNames,
  mediaUpload,
} from '../../../apps/desktop/scripts/live/probes/gmail-adapter-send';

const CLIENT = { clientId: 'live-client', clientSecret: 'live-secret' };
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface Upload {
  uploadType: string | null;
  contentType: string;
  raw: Buffer;
}

async function rig(emulator: Partial<GmailEmulatorOptions> = {}) {
  searchRetry.waitMs = 0;
  // The probe reads the wall clock (findSent's window is the real attempt time), so the emulator's clock starts there.
  const clock = new FakeClock({ start: Date.now() });
  const faults = createFaultInjector();
  const emu: GmailEmulator = createGmailEmulator({ clock, latencyMs: 0, faults, ...emulator });
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
  const uploads: Upload[] = [];
  const deps: RunDeps = {
    env: {
      APLOS_LIVE_VAULT: vault,
      APLOS_GOOGLE_CLIENT_ID: CLIENT.clientId,
      APLOS_GOOGLE_CLIENT_SECRET: CLIENT.clientSecret,
    },
    // The final network: the emulator has no media upload, so a simple media upload becomes the JSON send.
    fetch: async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (!url.pathname.endsWith('/upload/gmail/v1/users/me/messages/send'))
        return emu.fetch(input, init);
      const headers = new Headers(init?.headers);
      const raw = Buffer.from(init!.body as Uint8Array);
      uploads.push({
        uploadType: url.searchParams.get('uploadType'),
        contentType: headers.get('content-type') ?? '',
        raw,
      });
      headers.set('content-type', 'application/json');
      return emu.fetch(`${API}/messages/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ raw: raw.toString('base64url') }),
      });
    },
    readSecret,
    now: () => clock.now(),
    sleep: ms => clock.advance(ms),
    log: () => undefined,
    evidenceDir: evidence,
    probes: PROBES.filter(p => p.id === 'gmail.adapter-send-find'),
  };
  return {
    emu,
    faults,
    uploads,
    async run(phase = 'adapter', confirm = true) {
      const outcome = await runLive(
        {
          provider: 'gmail',
          tier: 'S-self',
          account: 'agent',
          dryRun: false,
          confirmMutating: confirm,
          ...(phase ? { phase } : {}),
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
  emu.mailbox.select({ q: 'subject:aplos-live-probe-adapter', includeSpamTrash: true });

test('through the adapter, Gmail rewrites the Message-ID: the token is on the Sent copy and the adapter findSent finds it', async () => {
  const r = await rig({ sendIdentity: 'rewritten' });
  const out = await r.run();
  assert.equal(out.status, 'pass');
  const c = out.counts;
  assert.deepEqual(
    [c.sent, c.sentKeptMessageId, c.sentMessageIdShape, c.sentHeaderTokenKept, c.findSentByToken],
    [1, 0, 2, 1, 1],
  );
  assert.ok(c.sentSearchTries! >= 1);
  assert.equal(r.uploads.length, 1, 'one send');
  assert.equal(r.uploads[0]!.uploadType, 'media', 'the guard-approved simple media upload');
  assert.equal(r.uploads[0]!.contentType, 'message/rfc822');
  const id = adapterNames(new Date()).messageId;
  assert.ok(
    r.uploads[0]!.raw.toString('latin1').startsWith(`X-Aplos-Send: ${id}\r\n`),
    'the adapter wrote the token as the first header',
  );
  const [sent] = probeMessages(r.emu);
  assert.ok(sent);
  const view = r.emu.mailbox.getMessage(sent!.id)!;
  assert.equal(
    view.to.toLowerCase(),
    r.emu.mailbox.emailAddress.toLowerCase(),
    'only the account itself',
  );
});

test('where Gmail keeps the Message-ID the same run reports it kept', async () => {
  const r = await rig();
  const out = await r.run();
  assert.equal(out.status, 'pass');
  assert.deepEqual(
    [out.counts.sentKeptMessageId, out.counts.sentMessageIdShape, out.counts.findSentByToken],
    [1, 1, 1],
  );
});

test('it runs only with --phase adapter, needs --confirm-mutating, and is skipped otherwise', async () => {
  const r = await rig();
  assert.equal((await r.run('')).status, 'skip');
  assert.equal((await r.run('create')).status, 'skip');
  await assert.rejects(r.run('adapter', false), /--confirm-mutating/);
  assert.equal(probeMessages(r.emu).length, 0);
  assert.equal(r.uploads.length, 0, 'nothing was sent');
  assert.deepEqual(
    probesFor('gmail', 'S-self')
      .map(p => p.id)
      .sort(),
    ['gmail.adapter-send-find', 'gmail.send-message-id'],
  );
});

test('a second run the same day refuses and sends nothing', async () => {
  const r = await rig({ sendIdentity: 'rewritten' });
  await r.run();
  const again = await r.run();
  assert.equal(again.status, 'fail');
  assert.equal(again.counts.probeMessagesExisting, 1);
  assert.equal(again.counts.sent, undefined);
  assert.equal(r.uploads.length, 1, 'no second send');
});

test('a failed send is one upload and a fail: the adapter never retries it', async () => {
  const r = await rig();
  r.faults.failNext(
    { apiMethod: 'gmail.users.messages.send' },
    { status: 503, reason: 'backendError', message: 'Backend Error' },
    { times: 5 },
  );
  const out = await r.run();
  assert.equal(out.status, 'fail');
  assert.equal(out.counts.sent, undefined);
  assert.equal(r.uploads.length, 1, 'exactly one send');
});

test('the evidence holds counts only: no address, Message-ID, subject or token', async () => {
  const r = await rig({ sendIdentity: 'rewritten' });
  const out = await r.run();
  const address = r.emu.mailbox.emailAddress;
  const id = adapterNames(new Date()).messageId;
  assert.ok(!out.text.includes(address) && !out.text.includes(id));
  assert.ok(
    !/@|aplos-live-probe-adapter|aplos\.invalid/.test(
      out.text.replace(/gmail\.adapter-send-find/g, ''),
    ),
  );
});

test('mediaUpload turns only the adapter multipart upload of a thread-less message into the simple media upload', () => {
  const boundary = 'b0undary';
  const message = Buffer.from('To: me@example.test\r\nSubject: x\r\n\r\nbody');
  const multipart = (
    metadata: string,
    path = '/upload/gmail/v1/users/me/messages/send',
    type = 'multipart',
  ) =>
    [
      `https://gmail.googleapis.com${path}?uploadType=${type}`,
      {
        method: 'POST',
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
          ),
          message,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      },
    ] as const;
  const [url, init] = mediaUpload(...multipart('{}'));
  assert.equal(new URL(url).searchParams.get('uploadType'), 'media');
  assert.deepEqual(Buffer.from(init.body as Uint8Array), message, 'the same message bytes');
  assert.equal(new Headers(init.headers).get('content-type'), 'message/rfc822');
  assert.throws(
    () => mediaUpload(...multipart('{"threadId":"abc"}')),
    /guard/,
    'a thread is refused',
  );
  assert.throws(
    () => mediaUpload(...multipart('{}', '/upload/gmail/v1/users/me/drafts/send')),
    /guard/,
  );
  assert.throws(() => mediaUpload(...multipart('{}', undefined, 'resumable')), /guard/);
});

test('its counts are on the evidence allowlist', () => {
  for (const key of [
    'sent',
    'sentKeptMessageId',
    'sentMessageIdShape',
    'sentHeaderTokenKept',
    'findSentByToken',
    'sentSearchTries',
    'probeMessagesExisting',
  ])
    assert.ok(COUNT_KEYS.includes(key), key);
});
