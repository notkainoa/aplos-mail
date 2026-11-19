/**
 * prov-gmail draft facts through the engine's own recognition (`outboxExtension`, `draft-writes.ts` `showsEveryField`):
 * the fact the Gmail adapter reports for the copy of our own upload moves the row's base (our echo), and the same copy
 * with a Bcc, which our upload never carries, is another device's edit. The engine's world and kit come from its tests.
 *
 * The facts are the adapter's own (Gmail emulator, real history pass). They reach the engine through its own
 * `stepWrites` (the conversion the sync actor commits with, `draftWrite` included), then one `store.commit` into the
 * engine's world; only the sync actor's loop is skipped, because the engine world has no Gmail provider to drive. The
 * phone's copy differs from the local draft in recipients, subject and body wherever a test claims "theirs", so a
 * kept local field fails the assertion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AdapterAccount,
  PlannedStep,
  RemoteDraftFact,
  StepResult,
  DraftUpload,
  SyncState,
} from '@aplos/engine/ports';
import { createFaultInjector } from '@aplos/emulators';
// Type-only: the engine's modules augment `EngineServices`; the kit below needs all of them in this project.
import type {} from '../../../../packages/engine/src/index';
import { stepWrites } from '../../../../packages/engine/src/sync/facts';
import { ACCOUNT, fields, SEC } from '../../../../packages/engine/tests/outbox/helpers';
import {
  read,
  count,
  create,
  wait,
  edit,
  row,
  synced,
  syncOf,
  world,
} from '../../../../packages/engine/tests/outbox/drafts.ports.kit';
import { rig } from './harness';
import { setup } from './draft-rig';

// The engine world's account address; the copy must be sent from it.
const OWNER = 'owner@mail.example';

interface PhoneCopy {
  to?: string[];
  cc?: string[];
  subject?: string;
  html?: string;
}

async function gmailFact(
  internetId: string,
  headers: Record<string, string>,
  copy: PhoneCopy = {},
) {
  const faults = createFaultInjector();
  const r = await rig({ threads: 60, emulator: { faults } });
  await r.drive({
    until: () => r.store.states.get('window:inbox')?.phase === 'done',
    maxSteps: 300,
  });
  await r.clock.advance(60_000);
  const draft = r.emu.mailbox.createDraftElsewhere({
    from: OWNER,
    to: copy.to ?? ['Jordan <jordan@mail.example>'],
    ...(copy.cc ? { cc: copy.cc } : {}),
    subject: copy.subject ?? 'Lunch',
    html: copy.html ?? '<p>Lunch at noon?</p>',
    messageId: internetId.replace(/^<|>$/g, ''),
    headers,
  });
  const from = r.store.commits.length;
  for (let i = 0; i < 50; i++) {
    await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
    if (!/^pass:/.test(r.store.states.get('history')?.phase ?? '')) break;
  }
  const facts = r.store.commits.slice(from).flatMap(c => c.result.drafts ?? []);
  return facts.find(f => f.remoteDraftId === draft.draftId) as RemoteDraftFact;
}

/** The writes the sync actor commits for a step that reports `fact` (as the draft `remoteDraftId` of the engine's row). */
function actorWrites(fact: RemoteDraftFact, remoteDraftId: string, supersedes?: string[]) {
  const reported = { ...fact, remoteDraftId, ...(supersedes ? { supersedes } : {}) };
  const result = { drafts: [reported], nextStates: [], done: true, costUnits: 0 } as StepResult;
  const state: SyncState = { scope: 'history', generation: 0, updatedAt: 0 };
  return stepWrites(result, {
    account: { id: ACCOUNT, address: OWNER } as AdapterAccount,
    step: { scope: 'history', lane: 'poll' } as unknown as PlannedStep,
    state,
    now: fact.changedAt,
    failures: new Map(),
    baselineDone: true,
  }).filter(write => write.kind === 'remoteDraft');
}

test('prov-gmail-drafts echo: the fact for the copy of our own upload is recognised by the engine; a copy with a Bcc is not', () =>
  world(async w => {
    const s = await synced(w, fields());
    const echo = await gmailFact(s.internetId, {});
    assert.deepEqual(echo.message?.bcc, []);
    w.first.store.commit({
      opId: 'echo-1',
      origin: 'sync',
      writes: actorWrites(echo, s.remoteDraftId, [s.messageId]),
    });
    assert.equal(row(w, s.draft.id)!.remote_message_id, echo.remoteMessageId, 'the base moved');
    assert.equal(read(w, s.draft.id).conflict, undefined);
    assert.ok(syncOf(w, s.draft.id).wrote?.includes(echo.remoteMessageId));
  }));

test("prov-gmail-drafts echo: our content plus a Bcc under another Message-ID is another device's edit; a clean draft takes it with the Bcc", () =>
  world(async w => {
    const s = await synced(w, fields());
    const other = await gmailFact('<phone-bcc@mail.example>', { Bcc: 'quiet@mail.example' });
    assert.equal(other.message?.bcc?.length, 1);
    w.first.store.commit({
      opId: 'echo-2',
      origin: 'sync',
      writes: actorWrites(other, s.remoteDraftId, [s.messageId]),
    });
    assert.equal(
      row(w, s.draft.id)!.remote_message_id,
      other.remoteMessageId,
      'replaced as theirs',
    );
    assert.deepEqual(
      read(w, s.draft.id).bcc.map(a => a.address),
      ['quiet@mail.example'],
      'with the Bcc the copy shows, not silently without it',
    );
    assert.equal(syncOf(w, s.draft.id).conflict, undefined);
  }));

test('prov-gmail-drafts echo: the same Bcc copy on a draft with unsent local edits raises the conflict, nothing is replaced', () =>
  world(async w => {
    const s = await synced(w, fields());
    const edited = edit(w, s.draft, fields({ subject: 'Edited here' }));
    const other = await gmailFact(
      '<phone-bcc@mail.example>',
      { Bcc: 'quiet@mail.example' },
      { subject: 'Edited on the phone', html: '<p>Phone body</p>' },
    );
    w.first.store.commit({
      opId: 'echo-3',
      origin: 'sync',
      writes: actorWrites(other, s.remoteDraftId, [s.messageId]),
    });
    const conflict = syncOf(w, edited.id).conflict;
    assert.ok(conflict, 'a conflict was raised');
    assert.equal(conflict.theirsMessageId, other.remoteMessageId);
    assert.equal(read(w, edited.id).subject, 'Edited here', 'the local edit is intact');
    assert.notEqual(row(w, edited.id)!.remote_message_id, other.remoteMessageId);
  }));

// ---- a phone draft must keep its recipients and subject when the engine takes the delivered body ----

test("prov-gmail-drafts echo: a phone draft's delivered body arrives with its recipients and subject, complete", () =>
  world(async w => {
    const phone = await gmailFact('<phone-new@mail.example>', {});
    assert.ok(phone.html, 'the adapter delivered the body');
    assert.ok(phone.message, 'and the message with it');
    w.first.store.commit({
      opId: 'phone-1',
      origin: 'sync',
      writes: actorWrites(phone, phone.remoteDraftId),
    });
    const id = `${ACCOUNT}:${phone.remoteDraftId}`;
    const d = read(w, id);
    assert.deepEqual(
      d.to.map(a => a.address),
      ['jordan@mail.example'],
    );
    assert.equal(d.subject, 'Lunch');
    assert.match(d.html, /Lunch at noon\?/);
    assert.equal(syncOf(w, id).incomplete, undefined, 'complete');
    assert.equal(count(w), 1, 'inserted, nothing forked');
  }));

test("prov-gmail-drafts echo: another device's edit of a clean draft replaces it with the phone's recipients, subject and body", () =>
  world(async w => {
    const s = await synced(w, fields());
    assert.equal(
      read(w, s.draft.id).subject,
      'Lunch',
      'the local draft differs from the phone copy',
    );
    const edit = await gmailFact(
      '<phone-edit@mail.example>',
      {},
      {
        to: ['Casey <casey@mail.example>'],
        cc: ['pat@mail.example'],
        subject: 'Dinner instead',
        html: '<p>Dinner at 7?</p>',
      },
    );
    w.first.store.commit({
      opId: 'phone-2',
      origin: 'sync',
      writes: actorWrites(edit, s.remoteDraftId, [s.messageId]),
    });
    assert.equal(row(w, s.draft.id)!.remote_message_id, edit.remoteMessageId, 'replaced');
    const d = read(w, s.draft.id);
    assert.deepEqual(
      d.to.map(a => a.address),
      ['casey@mail.example'],
    );
    assert.deepEqual(
      d.cc.map(a => a.address),
      ['pat@mail.example'],
    );
    assert.equal(d.subject, 'Dinner instead');
    assert.match(d.html, /Dinner at 7\?/);
    assert.doesNotMatch(d.html, /Lunch/);
  }));

// ---- the engine's OWN uploaded MIME, through the real adapter, must be recognised as ours ----

/** The fact the Gmail adapter reports for `upload` after it was saved to the emulator by the adapter itself. */
async function factOfOwnUpload(upload: DraftUpload) {
  const s = await setup({ threads: 60 });
  await s.r.drive({
    until: () => s.r.store.states.get('window:inbox')?.phase === 'done',
    maxSteps: 300,
  });
  await s.r.clock.advance(60_000);
  const saved = await s.r.adapter.saveDraft(upload, s.r.ctx());
  assert.equal(saved.kind, 'saved', JSON.stringify(saved));
  if (saved.kind !== 'saved') throw new Error('unreachable');
  const from = s.r.store.commits.length;
  for (let i = 0; i < 50; i++) {
    await s.r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
    if (!/^pass:/.test(s.r.store.states.get('history')?.phase ?? '')) break;
  }
  const facts = s.r.store.commits.slice(from).flatMap(c => c.result.drafts ?? []);
  return facts.find(f => f.remoteDraftId === saved.remoteDraftId) as RemoteDraftFact;
}

test("prov-gmail-drafts echo: the copy of the engine's own uploaded MIME (html part before the boundary) is recognised as our echo", () =>
  world(async w => {
    const s = await synced(w, fields());
    const upload = w.remoteDrafts.saves[0] as unknown as DraftUpload;
    const own = await factOfOwnUpload(upload);
    assert.ok(own?.html, 'the adapter delivered the body');
    w.first.store.commit({
      opId: 'own-echo',
      origin: 'sync',
      writes: actorWrites(own, s.remoteDraftId),
    });
    // Our own copy under a new message id and our Message-ID: an echo, nothing replaced, no conflict.
    assert.equal(read(w, s.draft.id).conflict, undefined);
    assert.equal(row(w, s.draft.id)!.revision, s.draft.revision);
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId);
  }));

test("prov-gmail-drafts echo: a lost reply, then the adapter's report of the same upload: adopted, not shown as another draft", () =>
  world(async w => {
    w.remoteDrafts.script.push({ result: 'landedLost' });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    assert.equal(row(w, d.id)!.remote_draft_id, null, 'its reply was lost');
    const upload = w.remoteDrafts.saves.at(-1) as unknown as DraftUpload;
    const own = await factOfOwnUpload(upload);
    assert.ok(own?.html);
    w.first.store.commit({
      opId: 'own-adopt',
      origin: 'sync',
      writes: actorWrites(own, 'rd1'),
    });
    assert.equal(count(w), 1, 'no duplicate draft from our own landed copy');
    assert.equal(row(w, d.id)!.remote_draft_id, 'rd1', 'adopted');
  }));

// ---- what the writer changes besides the last line break: every line break, and runs of spaces in the subject ----

const AWKWARD = fields({ subject: 'Lunch  at noon ', html: '<p>a</p>\n<p>b</p>\r<p>c</p>\n' });

test('prov-gmail-drafts echo: a multi-line html body and a subject with a double space come back as the same content (our echo)', () =>
  world(async w => {
    const s = await synced(w, AWKWARD);
    const upload = w.remoteDrafts.saves[0] as unknown as DraftUpload;
    const own = await factOfOwnUpload(upload);
    assert.ok(own?.html?.includes('\r\n'), 'the writer made every line break a CRLF');
    w.first.store.commit({
      opId: 'own-echo-awkward',
      origin: 'sync',
      writes: actorWrites(own, s.remoteDraftId),
    });
    assert.equal(read(w, s.draft.id).conflict, undefined);
    assert.equal(row(w, s.draft.id)!.revision, s.draft.revision, 'our own text was not replaced');
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId);
  }));

test('prov-gmail-drafts echo: a lost reply with the same awkward content is adopted, not shown as a duplicate', () =>
  world(async w => {
    w.remoteDrafts.script.push({ result: 'landedLost' });
    const d = create(w, AWKWARD);
    await wait(w, 5 * SEC);
    const upload = w.remoteDrafts.saves.at(-1) as unknown as DraftUpload;
    const own = await factOfOwnUpload(upload);
    w.first.store.commit({
      opId: 'own-adopt-awkward',
      origin: 'sync',
      writes: actorWrites(own, 'rd1'),
    });
    assert.equal(count(w), 1, 'no duplicate draft');
    assert.equal(row(w, d.id)!.remote_draft_id, 'rd1', 'adopted');
  }));
