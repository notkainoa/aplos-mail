/**
 * Tier M probe `gmail.draft-message-id-after-edit` (apps/desktop/scripts/live/probes/gmail-draft-message-id.ts), run
 * through the real runner and guard against the emulator: `--phase create`, a simulated phone edit, `--phase inspect`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGmailEmulator,
  FakeClock,
  type GmailEmulator,
  type GmailEmulatorOptions,
} from '../src/index';
import { parseArgs, runLive, type RunDeps } from '../../../apps/desktop/scripts/live/run';
import { signIn } from '../../../apps/desktop/scripts/live/signin';
import { PROBES } from '../../../apps/desktop/scripts/live/probes';
import { COUNT_KEYS } from '../../../apps/desktop/scripts/live/evidence';
import { emptyResult, type SmokeProbe } from '../../../apps/desktop/scripts/live/types';
import { createProbeState } from '../../../apps/desktop/scripts/live/state';
import { probeNames } from '../../../apps/desktop/scripts/live/probes/gmail-draft-message-id';

const CLIENT = { clientId: 'live-client', clientSecret: 'live-secret' };

interface Rig {
  emu: GmailEmulator;
  /** Where the probe's state file goes (a temp folder). */
  stateDir: string;
  run(
    phase?: string,
    confirm?: boolean,
  ): Promise<{ counts: Record<string, number>; text: string; status: string }>;
}

async function rig(
  extraProbes: SmokeProbe[] = [],
  listAnswer?: (url: URL) => Response | undefined,
  emulator: Partial<GmailEmulatorOptions> = {},
): Promise<Rig> {
  const clock = new FakeClock();
  const emu = createGmailEmulator({ clock, latencyMs: 0, ...emulator });
  emu.oauth.addClient(CLIENT.clientId, CLIENT.clientSecret);
  emu.seedMailbox({ threads: 10, seed: 3 });
  const vault = await mkdtemp(join(tmpdir(), 'aplos-live-vault-'));
  const evidence = await mkdtemp(join(tmpdir(), 'aplos-live-evidence-'));
  const stateDir = join(await mkdtemp(join(tmpdir(), 'aplos-live-state-')), 'state');
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
    // `listAnswer` replaces the answer to `drafts.list` (not the other calls), to play Gmail's empty answers.
    fetch: (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const answer =
        listAnswer && /\/drafts$/.test(url.pathname) && (init?.method ?? 'GET') === 'GET'
          ? listAnswer(url)
          : undefined;
      return answer ? Promise.resolve(answer) : emu.fetch(input, init);
    },
    readSecret,
    now: () => clock.now(),
    sleep: ms => clock.advance(ms),
    log: () => undefined,
    evidenceDir: evidence,
    stateDir,
    probes: [...extraProbes, ...PROBES.filter(p => p.id === 'gmail.draft-message-id-after-edit')],
  };
  return {
    emu,
    stateDir,
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

const emptyOk = (body: string) => () =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

for (const [name, body] of [
  ['an empty body', ''],
  ['{}', '{}'],
  ['JSON null', 'null'],
] as const) {
  test(`create reaches the write when drafts.list answers ${name} with zero drafts, and says the answer was empty`, async () => {
    const r = await rig([], emptyOk(body));
    const out = await r.run('create');
    assert.equal(out.status, 'pass');
    assert.equal(out.counts.emptyAnswers, 1, 'ok-empty is counted, not an error');
    assert.equal(out.counts.probeDraftsExisting, 0);
    assert.equal(out.counts.created, 1);
    assert.match(out.text, /Error classes: none/);
  });
}

test('inspect on an empty drafts.list: draftFound 0, ok-empty counted, pass', async () => {
  const r = await rig([], emptyOk(''));
  const out = await r.run('inspect');
  assert.equal(out.status, 'pass');
  assert.equal(out.counts.emptyAnswers, 1);
  assert.equal(out.counts.draftFound, 0);
});

for (const [name, body] of [
  ['text that is not JSON', 'SECRET-TEXT not json'],
  ['a JSON list', '[{"id":"SECRET-ID"}]'],
] as const) {
  test(`${name} in a 200 is a real error of its own class (bad-body), nothing is written and no body text reaches the evidence`, async () => {
    const r = await rig([], emptyOk(body));
    const before = r.emu.mailbox.listDrafts().length;
    const out = await r.run('create');
    assert.equal(out.status, 'fail');
    assert.match(out.text, /Error classes: bad-body=1/);
    assert.equal(out.counts.created, undefined);
    assert.equal(r.emu.mailbox.listDrafts().length, before, 'nothing was created');
    assert.ok(!/SECRET/.test(out.text), 'no body text in the evidence');
  });
}

const STATE_FILE = 'gmail.draft-message-id-after-edit.json';

test('v2 kept identity: shapes ours, stable across the API save, custom header kept; the state file is content-free and mode 0600', async () => {
  const r = await rig();
  const out = await r.run('create');
  assert.equal(out.status, 'pass');
  const c = out.counts;
  assert.deepEqual(
    [c.messageIdShapeCreate, c.messageIdShapeSave, c.messageIdStableAcrossApiSave],
    [1, 1, 1],
  );
  assert.deepEqual([c.customHeaderKeptAfterCreate, c.customHeaderKeptAfterApiSave], [1, 1]);
  assert.deepEqual([c.engineHeaderKeptAfterCreate, c.engineHeaderKeptAfterApiSave], [1, 1]);
  assert.equal(c.searchDraftsOursCreate, 1);
  assert.equal(c.searchMessagesOursCreate, 1);
  const file = join(r.stateDir, STATE_FILE);
  const text = await readFile(file, 'utf8');
  const state = JSON.parse(text) as Record<string, string>;
  assert.deepEqual(Object.keys(state).sort(), [
    'afterCreateHash',
    'afterCreateShape',
    'afterSaveHash',
    'afterSaveShape',
    'draftIdHash',
    'draftTokenHash',
    'salt',
    'tokenHash',
  ]);
  for (const [key, value] of Object.entries(state))
    assert.ok(
      /^[0-9a-f]{16,64}$/.test(value) || ['ours', 'gmail', 'other', 'absent'].includes(value),
      key,
    );
  assert.ok(!/[@<>]|aplos|invalid/i.test(text), 'no Message-ID or text in the state file');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(r.stateDir)).mode & 0o777, 0o700);
});

test('v2 kept identity: a phone edit that keeps both ids is stable across the phone edit; one that drops the custom header is not', async () => {
  const r = await rig();
  await r.run('create');
  const draft = probeDraft(r.emu);
  const ours = probeNames(new Date()).messageId;
  const same = await r.run('inspect');
  assert.deepEqual(
    [
      same.counts.messageIdStableAcrossPhoneEdit,
      same.counts.customHeaderKeptAfterPhoneEdit,
      same.counts.stateMissing,
    ],
    [1, 1, 0],
  );
  r.emu.mailbox.updateDraft(draft.id, edited([`Message-ID: ${ours}`], 'Edited on the phone.'));
  const phone = await r.run('inspect');
  assert.equal(phone.counts.messageIdStableAcrossPhoneEdit, 1);
  assert.equal(phone.counts.customHeaderKeptAfterPhoneEdit, 0, 'the phone dropped our header');
  assert.equal(phone.counts.engineHeaderKeptAfterPhoneEdit, 0, 'and the engine-named one');
  assert.equal(same.counts.engineHeaderKeptAfterPhoneEdit, 1);
  assert.equal(phone.counts.searchDraftsOursPhone, 1);
});

test('v2 Gmail-like identity: the Message-ID is rewritten on every save and our custom header dropped, and the report says so', async () => {
  const r = await rig([], undefined, {
    draftIdentity: 'rewritten',
    dropDraftHeaders: ['X-Aplos-Probe'],
  });
  const out = await r.run('create');
  assert.equal(out.status, 'pass');
  const c = out.counts;
  assert.deepEqual(
    [
      c.messageIdShapeCreate,
      c.messageIdShapeSave,
      c.createKeptMessageId,
      c.updatedKeptMessageIdHeader,
    ],
    [2, 2, 0, 0],
  );
  assert.equal(c.messageIdStableAcrossApiSave, 0, 'every save gives a new Message-ID');
  assert.deepEqual([c.customHeaderKeptAfterCreate, c.customHeaderKeptAfterApiSave], [0, 0]);
  assert.deepEqual(
    [c.engineHeaderKeptAfterCreate, c.engineHeaderKeptAfterApiSave],
    [1, 1],
    'X-Aplos-Draft is measured on its own: only the named header was dropped',
  );
  assert.equal(c.searchDraftsOursCreate, 0, 'our Message-ID finds nothing');
  assert.equal(c.searchMessagesOursCreate, 0);
  assert.equal(c.searchDraftsReportedCreate, 1, 'the id Gmail reports finds the draft');
  assert.equal(c.searchMessagesReportedCreate, 1);
  r.emu.mailbox.updateDraft(probeDraft(r.emu).id, edited([], 'Edited on the phone.'));
  const phone = await r.run('inspect');
  assert.deepEqual(
    [
      phone.counts.messageIdShapePhone,
      phone.counts.messageIdStableAcrossPhoneEdit,
      phone.counts.customHeaderKeptAfterPhoneEdit,
      phone.counts.messageIdIsOurs,
    ],
    [2, 0, 0, 0],
  );
  assert.equal(phone.counts.searchDraftsReportedPhone, 1);
});

test('v2 inspect without a state file says so and reports no stability flag; the evidence names no id', async () => {
  const r = await rig();
  await r.run('create');
  await rm(join(r.stateDir, STATE_FILE));
  const out = await r.run('inspect');
  assert.equal(out.counts.stateMissing, 1);
  assert.equal(out.counts.messageIdStableAcrossPhoneEdit, undefined);
  assert.equal(out.counts.customHeaderKeptAfterPhoneEdit, undefined);
  assert.equal(out.counts.messageIdShapePhone, 1);
  assert.ok(
    !/@|aplos-live-probe|invalid/.test(out.text.replace(/gmail\.draft-message-id-after-edit/g, '')),
  );
});

test('state.ts: only allowlisted keys and hex or shape values are stored; a rejection names the field, never the value', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'aplos-state-unit-')), 's');
  const state = createProbeState(dir, 'some.probe');
  assert.equal(await state.load(), undefined);
  await state.save({ salt: 'a'.repeat(32), afterSaveShape: 'gmail' });
  assert.deepEqual(await state.load(), { salt: 'a'.repeat(32), afterSaveShape: 'gmail' });
  await assert.rejects(
    state.save({ messageId: 'abcdef0123456789' }),
    /key is not on the allowlist/,
  );
  await assert.rejects(state.save({ salt: '<CA1234@mail.gmail.com>' }), err => {
    assert.match(String(err), /the value of salt is not allowed/);
    assert.ok(!/CA1234|gmail/.test(String(err)), 'the value is not repeated');
    return true;
  });
  await assert.rejects(
    state.save({ afterSaveShape: 'someone@example.test' }),
    /afterSaveShape is not allowed/,
  );
  assert.throws(() => createProbeState(dir, '../escape'), /probe id/);
  await writeFile(join(dir, 'some.probe.json'), '{"salt":"not allowed value"}');
  assert.equal(await state.load(), undefined, 'a tampered file is treated as no state');
});

test('a create whose search fails after the save still leaves ITS state: inspect is not misled by the previous run', async () => {
  const failing = { on: false };
  const r = await rig([], url =>
    failing.on && url.searchParams.has('q')
      ? Response.json(
          { error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] } },
          { status: 429 },
        )
      : undefined,
  );
  await r.run('create');
  // The owner discards that draft; the next create finds nothing to refuse, saves its state, then its search is refused.
  r.emu.mailbox.deleteDraft(probeDraft(r.emu).id);
  failing.on = true;
  const second = await r.run('create');
  assert.equal(second.status, 'fail', 'the failed search is reported');
  assert.equal(second.counts.created, 1);
  failing.on = false;
  const ours = probeNames(new Date()).messageId;
  r.emu.mailbox.updateDraft(probeDraft(r.emu).id, edited([`Message-ID: ${ours}`], 'Edited.'));
  const out = await r.run('inspect');
  assert.equal(out.counts.stateMissing, 0);
  assert.equal(
    out.counts.messageIdStableAcrossPhoneEdit,
    1,
    'compared with the NEW state, not the old one',
  );
});

test('a state file written for another draft is no state: stateMissing 1 and no stability flag', async () => {
  const r = await rig();
  await r.run('create');
  const old = probeDraft(r.emu);
  r.emu.mailbox.deleteDraft(old.id);
  // The new probe draft appears without this state ever being written for it (a create that died before saving).
  r.emu.mailbox.createDraftElsewhere({ subject: probeNames(new Date()).subject, text: 'x' });
  const out = await r.run('inspect');
  assert.equal(out.counts.stateMissing, 1);
  assert.equal(out.counts.messageIdStableAcrossPhoneEdit, undefined);
});

test('state.ts: a folder that already exists is tightened to 0700, a planted temp symlink is never written through, values must fit their key', async () => {
  const base = await mkdtemp(join(tmpdir(), 'aplos-state-hard-'));
  const dir = join(base, 's');
  await mkdir(dir, { mode: 0o755 });
  await chmod(dir, 0o755);
  const decoy = join(base, 'decoy.txt');
  await writeFile(decoy, 'untouched');
  await symlink(decoy, join(dir, 'some.probe.json.tmp'));
  const state = createProbeState(dir, 'some.probe');
  await state.save({ salt: 'b'.repeat(32), afterSaveHash: 'c'.repeat(16) });
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal(
    await readFile(decoy, 'utf8'),
    'untouched',
    'the decoy behind the symlink is untouched',
  );
  assert.equal((await stat(join(dir, 'some.probe.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await state.load(), { salt: 'b'.repeat(32), afterSaveHash: 'c'.repeat(16) });
  // A 16-hex Gmail message id fits no key but a hash; 32 hex fits no hash; a hash is not a shape.
  await assert.rejects(state.save({ salt: 'abcdef0123456789' }), /value of salt is not allowed/);
  await assert.rejects(
    state.save({ afterSaveHash: 'a'.repeat(32) }),
    /afterSaveHash is not allowed/,
  );
  await assert.rejects(
    state.save({ afterSaveShape: 'a'.repeat(16) }),
    /afterSaveShape is not allowed/,
  );
  await assert.rejects(state.save({ afterSaveHash: 'ours' }), /afterSaveHash is not allowed/);
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
    'emptyAnswers',
    'messageIdShapeCreate',
    'messageIdShapeSave',
    'messageIdShapePhone',
    'messageIdStableAcrossApiSave',
    'messageIdStableAcrossPhoneEdit',
    'customHeaderKeptAfterCreate',
    'customHeaderKeptAfterApiSave',
    'customHeaderKeptAfterPhoneEdit',
    'engineHeaderKeptAfterCreate',
    'engineHeaderKeptAfterApiSave',
    'engineHeaderKeptAfterPhoneEdit',
    'stateMissing',
    'searchDraftsOursCreate',
    'searchDraftsReportedCreate',
    'searchMessagesOursCreate',
    'searchMessagesReportedCreate',
    'searchDraftsOursPhone',
    'searchDraftsReportedPhone',
    'searchMessagesOursPhone',
    'searchMessagesReportedPhone',
  ])
    assert.ok(COUNT_KEYS.includes(key), key);
});
