/**
 * Tier M probe `gmail.draft-message-id-after-edit` (apps/desktop/scripts/live/probes/gmail-draft-message-id.ts), run
 * through the real runner and guard against the emulator: `--phase create`, a simulated phone edit, `--phase inspect`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGmailEmulator, FakeClock, type GmailEmulator } from '../src/index';
import { parseArgs, runLive, type RunDeps } from '../../../apps/desktop/scripts/live/run';
import { signIn } from '../../../apps/desktop/scripts/live/signin';
import { PROBES } from '../../../apps/desktop/scripts/live/probes';
import { COUNT_KEYS } from '../../../apps/desktop/scripts/live/evidence';
import { emptyResult, type SmokeProbe } from '../../../apps/desktop/scripts/live/types';
import { probeNames } from '../../../apps/desktop/scripts/live/probes/gmail-draft-message-id';

const CLIENT = { clientId: 'live-client', clientSecret: 'live-secret' };

interface Rig {
  emu: GmailEmulator;
  run(
    phase?: string,
    confirm?: boolean,
  ): Promise<{ counts: Record<string, number>; text: string; status: string }>;
}

async function rig(extraProbes: SmokeProbe[] = []): Promise<Rig> {
  const clock = new FakeClock();
  const emu = createGmailEmulator({ clock, latencyMs: 0 });
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
    probes: [...extraProbes, ...PROBES.filter(p => p.id === 'gmail.draft-message-id-after-edit')],
  };
  return {
    emu,
    async run(phase, confirm = true) {
      const outcome = await runLive(
        {
          provider: 'gmail',
          tier: 'M',
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

const probeDraft = (emu: GmailEmulator) => {
  const found = emu.mailbox
    .listDrafts()
    .filter(d => d.message.subject.startsWith('aplos-live-probe '));
  assert.equal(found.length, 1, 'exactly one probe draft');
  return found[0]!;
};

const edited = (extra: string[], body: string): Buffer => {
  const { subject } = probeNames(new Date());
  return Buffer.from(
    [`Subject: ${subject}`, ...extra, 'Content-Type: text/plain; charset=utf-8', '', body].join(
      '\r\n',
    ),
  );
};

test('create: one draft with no recipient, saved twice, flags report what survived; nothing is sent or deleted', async () => {
  const r = await rig();
  const before = r.emu.log.length;
  const out = await r.run('create');
  assert.equal(out.status, 'pass');
  assert.deepEqual(
    {
      created: out.counts.created,
      createKept: out.counts.createKeptMessageId,
      idKept: out.counts.updatedDraftIdKept,
      msgChanged: out.counts.updatedMessageIdChanged,
      headerKept: out.counts.updatedKeptMessageIdHeader,
    },
    { created: 1, createKept: 1, idKept: 1, msgChanged: 1, headerKept: 1 },
  );
  const draft = probeDraft(r.emu);
  assert.equal(draft.message.subject, probeNames(new Date()).subject);
  const calls = r.emu.log.slice(before).map(e => `${e.httpMethod} ${e.apiMethod}`);
  assert.ok(calls.includes('POST gmail.users.drafts.create'));
  assert.ok(calls.includes('PUT gmail.users.drafts.update'));
  assert.ok(!calls.some(c => /send|delete|trash|modify/.test(c)), calls.join(', '));
  assert.ok(
    /^[^@]*$/.test(draft.message.to) || draft.message.to === '',
    'no recipient on the draft',
  );
  assert.ok(
    !/[@]|aplos-live-probe|second save|aplos\.invalid|example\.test/.test(
      out.text.replace(/gmail\.draft-message-id-after-edit/g, ''),
    ),
    'evidence has no content',
  );
});

test('inspect: untouched draft = Message-ID ours and body unchanged; a phone edit that keeps the Message-ID = ours and edited', async () => {
  const r = await rig();
  await r.run('create');
  const same = await r.run('inspect');
  assert.deepEqual(
    [
      same.counts.draftFound,
      same.counts.messageIdIsOurs,
      same.counts.bodyUnchanged,
      same.counts.bodyEdited,
    ],
    [1, 1, 1, 0],
  );
  const draft = probeDraft(r.emu);
  r.emu.mailbox.updateDraft(
    draft.id,
    edited([`Message-ID: ${probeNames(new Date()).messageId}`], 'Edited on the phone.'),
  );
  const kept = await r.run('inspect');
  assert.deepEqual(
    [
      kept.counts.draftFound,
      kept.counts.messageIdIsOurs,
      kept.counts.bodyUnchanged,
      kept.counts.bodyEdited,
    ],
    [1, 1, 0, 1],
  );
});

test('inspect: a phone edit that loses our Message-ID is reported as not ours', async () => {
  const r = await rig();
  await r.run('create');
  r.emu.mailbox.updateDraft(
    probeDraft(r.emu).id,
    edited(['Message-ID: <phone-made@example.test>'], 'Edited.'),
  );
  const out = await r.run('inspect');
  assert.deepEqual(
    [out.counts.draftFound, out.counts.messageIdIsOurs, out.counts.bodyEdited],
    [1, 0, 1],
  );
});

test('inspect: no probe draft is draftFound 0; no phase or an unknown phase is a skip; create needs --confirm-mutating', async () => {
  const r = await rig();
  const none = await r.run('inspect');
  assert.equal(none.counts.draftFound, 0);
  assert.equal(none.counts.draftsMatching, 0);
  const noPhase = await r.run(undefined);
  assert.equal(noPhase.status, 'skip');
  assert.equal((await r.run('other')).status, 'skip');
  await assert.rejects(r.run('create', false), /--confirm-mutating/);
  assert.equal(
    r.emu.mailbox.listDrafts().filter(d => d.message.subject.startsWith('aplos-live-probe '))
      .length,
    0,
    'nothing was created',
  );
});

test('create stops when a probe draft already exists; inspect gives no verdict when there are two', async () => {
  const r = await rig();
  await r.run('create');
  const again = await r.run('create');
  assert.equal(again.status, 'fail');
  assert.equal(again.counts.probeDraftsExisting, 1);
  assert.equal(again.counts.created, undefined, 'no second draft was made');
  assert.equal(
    r.emu.mailbox.listDrafts().filter(d => d.message.subject.startsWith('aplos-live-probe '))
      .length,
    1,
  );
  // An older probe draft left behind (made elsewhere) next to the new one: nothing is judged.
  r.emu.mailbox.createDraftElsewhere({ subject: probeNames(new Date()).subject, text: 'older' });
  const out = await r.run('inspect');
  assert.equal(out.status, 'fail');
  assert.equal(out.counts.draftsMatching, 2);
  assert.equal(out.counts.draftFound, 1);
  assert.equal(out.counts.messageIdIsOurs, undefined);
  assert.equal(out.counts.bodyUnchanged, undefined);
});

test('inspect sends nothing but GETs (after the token refresh), and does not touch any draft', async () => {
  const r = await rig();
  await r.run('create');
  const before = r.emu.log.length;
  const drafts = JSON.stringify(
    r.emu.mailbox.listDrafts().map(d => [d.id, d.message.id, d.message.subject]),
  );
  await r.run('inspect');
  const writes = r.emu.log
    .slice(before)
    .filter(e => e.httpMethod !== 'GET')
    .map(e => e.apiMethod);
  assert.deepEqual(writes, ['oauth.token']);
  assert.equal(
    JSON.stringify(r.emu.mailbox.listDrafts().map(d => [d.id, d.message.id, d.message.subject])),
    drafts,
  );
});

test('--phase runs only probes that declare phases: --phase inspect --confirm-mutating does not authorise another tier M probe', async () => {
  let ran = 0;
  const other: SmokeProbe = {
    id: 'gmail.profile-and-labels',
    provider: 'gmail',
    tier: 'M',
    async run() {
      ran++;
      return emptyResult();
    },
  };
  const r = await rig([other]);
  await r.run('inspect');
  assert.equal(ran, 0, 'the unphased probe did not run');
  await r.run(undefined);
  assert.equal(ran, 1, 'without --phase the tier runs every probe as before');
});

test('command line: --phase takes a short lowercase word only; the counts are on the evidence allowlist', () => {
  const base = ['--provider', 'gmail', '--tier', 'M', '--account', 'agent', '--dry-run'];
  assert.equal(parseArgs([...base, '--phase', 'create']).phase, 'create');
  assert.equal(parseArgs(base).phase, undefined);
  assert.throws(() => parseArgs([...base, '--phase', 'Create1']), /--phase/);
  assert.throws(() => parseArgs([...base, '--phase', 'a@b.c']), /--phase/);
  for (const key of [
    'created',
    'createKeptMessageId',
    'updatedDraftIdKept',
    'updatedMessageIdChanged',
    'updatedKeptMessageIdHeader',
    'draftsScanned',
    'draftsMatching',
    'draftFound',
    'messageIdIsOurs',
    'bodyUnchanged',
    'bodyEdited',
    'probeDraftsExisting',
  ])
    assert.ok(COUNT_KEYS.includes(key), key);
});
