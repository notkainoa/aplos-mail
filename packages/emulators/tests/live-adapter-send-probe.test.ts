/**
 * Tier S-self probe `gmail.adapter-send-find` (apps/desktop/scripts/live/probes/gmail-adapter-send.ts), through the real
 * runner and guard against the emulator: one self-addressed send THROUGH the adapter's `sendSubmission`, then the
 * adapter's `findSentCopy` on the Sent copy. The emulator does not model the media upload, so the test's final fetch
 * turns the guard-approved simple media upload (`uploadType=media`) into the equivalent JSON send, as Gmail stores it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '@aplos/engine/ports';
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
  failureClass,
  mediaUpload,
  probeHooks,
} from '../../../apps/desktop/scripts/live/probes/gmail-adapter-send';

const CLIENT = { clientId: 'live-client', clientSecret: 'live-secret' };
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface Upload {
  uploadType: string | null;
  contentType: string;
  raw: Buffer;
}

async function rig(emulator: Partial<GmailEmulatorOptions> = {}, failList?: (url: URL) => boolean) {
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
      // One chosen messages.list (by its query) answers 500; every other request is untouched.
      if (failList && /\/messages$/.test(url.pathname) && failList(url))
        return Response.json(
          { error: { code: 500, message: 'Backend Error', errors: [{ reason: 'backendError' }] } },
          { status: 500 },
        );
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
  // The adapter wraps the failure; the evidence says the send ended uncertain, so the operator checks Sent by hand.
  assert.match(out.text, /Error classes: network=1/);
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

test('a second recipient is refused by the guard through THIS probe path: nothing reaches the network, class guard', async () => {
  const r = await rig();
  probeHooks.extraTo = ['evil@example.test'];
  try {
    const out = await r.run();
    assert.equal(out.status, 'fail');
    assert.match(out.text, /Error classes: guard=1/);
    assert.equal(out.counts.sent, undefined);
  } finally {
    probeHooks.extraTo = [];
  }
  assert.equal(r.uploads.length, 0, 'no upload reached the network');
  assert.equal(probeMessages(r.emu).length, 0, 'no probe message exists');
});

// The probe asks four list questions before it may send; each is failed ALONE so none hides another.
for (const [name, matches] of [
  [
    'the subject search',
    (u: URL) => (u.searchParams.get('q') ?? '').startsWith('subject:aplos-live-probe-adapter'),
  ],
  [
    "the search for today's Message-ID",
    (u: URL) => /^rfc822msgid:\S+ in:anywhere$/.test(u.searchParams.get('q') ?? ''),
  ],
  [
    "the adapter's own findSent search",
    (u: URL) => /^rfc822msgid:\S+ in:sent/.test(u.searchParams.get('q') ?? ''),
  ],
  [
    "the adapter's own findSent listing of the newest Sent",
    (u: URL) => u.searchParams.getAll('labelIds').includes('SENT') && !u.searchParams.has('q'),
  ],
] as const) {
  test(`the duplicate check fails closed: a server error on ${name} alone sends nothing`, async () => {
    const seen: string[] = [];
    const r = await rig({}, url => {
      const hit = matches(url);
      if (hit) seen.push(url.searchParams.get('q') ?? 'labelIds');
      return hit;
    });
    const out = await r.run();
    assert.ok(seen.length >= 1, 'the chosen list question was asked, and failed');
    assert.equal(out.status, 'fail');
    assert.match(out.text, /Error classes: (server|other|network)=1/);
    assert.equal(out.counts.sent, undefined);
    assert.equal(r.uploads.length, 0, 'nothing was uploaded');
    assert.equal(probeMessages(r.emu).length, 0);
  });
}

test('the token header is on the upload exactly once, and nothing else in the message names it', async () => {
  const r = await rig({ sendIdentity: 'rewritten' });
  await r.run();
  const head = r.uploads[0]!.raw.toString('latin1').split('\r\n\r\n')[0]!;
  assert.equal(head.split('\r\n').filter(l => /^x-aplos-send:/i.test(l)).length, 1);
  assert.equal(r.uploads[0]!.raw.toString('latin1').match(/x-aplos-send/gi)?.length, 1);
});

test('the probe never uses the global fetch: with it replaced by a thrower the run still passes', async () => {
  const r = await rig({ sendIdentity: 'rewritten' });
  const real = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('the global fetch bypasses the guard');
  }) as typeof fetch;
  try {
    const out = await r.run();
    assert.equal(out.status, 'pass');
  } finally {
    globalThis.fetch = real;
  }
});

test('failureClass: a guard refusal, an uncertain end, a 5xx and anything else are told apart', () => {
  const wrapped = (extra: Record<string, unknown>) =>
    new ProviderError({
      class: 'transient',
      provider: 'gmail',
      method: 'gmail.messages.send',
      reason: 'x',
      ...extra,
    });
  assert.equal(failureClass(wrapped({}), true), 'guard');
  assert.equal(failureClass(wrapped({ uncertain: true }), false), 'network');
  assert.equal(failureClass(wrapped({ status: 503 }), false), 'server');
  assert.equal(failureClass(wrapped({ status: 400 }), false), 'other');
  assert.equal(failureClass(new Error('x'), false), 'other');
});

test('mediaUpload keeps the adapter signal, so the send timeout still applies', () => {
  const boundary = 'b0undary';
  const message = Buffer.from('To: me@example.test\r\n\r\nbody');
  const controller = new AbortController();
  const [, init] = mediaUpload(
    'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart',
    {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      signal: controller.signal,
      body: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
        ),
        message,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    },
  );
  assert.equal(init.signal, controller.signal);
});
