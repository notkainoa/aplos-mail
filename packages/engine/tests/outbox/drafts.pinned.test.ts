import test from 'node:test';
import assert from 'node:assert/strict';
import type { CommitInput } from '../../src/store';
import { hasSend, sendPins } from '../../src/outbox/draft-proof';
import type { DraftRow } from '../../src/outbox/draft-state';
import { ContractError } from '@aplos/contract/contract-error';
import { ACCOUNT, fields, SEC, type World } from './helpers';
import {
  count,
  create,
  edit,
  fact,
  next,
  read,
  row,
  service,
  syncOf,
  synced,
  wait,
  world,
} from './drafts.ports.kit';

/**
 * A draft held by a send does not change. A phone copy reported in a NEWER version while a send of the draft is queued
 * used to rebuild the draft (revision + 1): the send then named no base for the copy, the sent draft stayed in Drafts, and
 * a second send would have mailed it again. Now the newer version is remembered (the copy is never deleted from here) and
 * taken when the provider reports it after the send is over.
 */

const D = `${ACCOUNT}:rd-reply`;
let reports = 0;

function report(w: World, messageId: string, subject: string) {
  w.first.store.commit({
    opId: `pinned-${++reports}`,
    origin: 'sync',
    writes: [
      {
        kind: 'remoteDraft',
        accountId: ACCOUNT,
        remoteDraftId: 'rd-reply',
        remoteMessageId: messageId,
        remoteThreadId: 't-1',
        internetId: '<reply@phone.example>',
        changedAt: w.clock.now(),
        html: `<p>${subject}</p>`,
        message: {
          remoteId: messageId,
          remoteThreadId: 't-1',
          from: { address: 'owner@mail.example' },
          to: [{ address: 'jordan@mail.example' }],
          cc: [],
          bcc: [],
          subject,
          snippet: subject,
          hasAttachments: false,
          date: w.clock.now(),
          internalDate: w.clock.now(),
          flags: { seen: true, flagged: false, draft: true, fromMe: true },
        },
      },
    ],
  } as never);
}

/** The message id of the newer copy the draft holds, `true` for a hold from before the report was kept, else nothing. */
const held = (w: World, id = D) => {
  const kept = (syncOf(w, id) as { changedElsewhere?: true | { remoteMessageId: string } })
    .changedElsewhere;
  return typeof kept === 'object' ? kept.remoteMessageId : kept;
};

const subjectHeader = (mime: Uint8Array) =>
  Buffer.from(mime)
    .toString()
    .match(/^Subject: (.*)$/m)?.[1];

test('a newer phone version reported while a send is queued does not move the draft: the send keeps its base and the draft leaves Drafts', () =>
  world(async w => {
    report(w, 'pm-1', 'Version one');
    const queued = read(w, D);
    const sub = await w.send(w.first, D, { revision: queued.revision });
    report(w, 'pm-2', 'Version two');
    const now = read(w, D);
    assert.equal(now.revision, queued.revision, 'the draft did not move under its queued send');
    assert.equal(now.subject, 'Version one');
    assert.equal(row(w, D)!.remote_message_id, 'pm-1');
    assert.equal(held(w), 'pm-2', 'the change is remembered, with the version it names');
    await wait(w, 30 * SEC);
    assert.equal(w.get(sub.id).state, 'sent');
    assert.equal(w.server.payloads.length, 1, 'mailed once');
    const payload = w.server.payloads[0];
    assert.equal(subjectHeader(payload.mime), 'Version one', 'the content that was queued');
    assert.equal(payload.baseRemoteMessageId, 'pm-1', 'and it names the version it was queued on');
    await wait(w, 60 * SEC);
    assert.equal(service(w).get([D]).notFound.length, 1, 'the sent draft left Drafts');
    assert.deepEqual(w.remoteDrafts.removes, [], 'the engine deleted no copy');
  }));

test('a queued send that is undone lets the newer phone version in when it is reported again', () =>
  world(async w => {
    report(w, 'pm-1', 'Version one');
    const sub = await w.send(w.first, D, { revision: read(w, D).revision });
    report(w, 'pm-2', 'Version two');
    assert.equal(read(w, D).subject, 'Version one', 'held while the send is queued');
    await w.act(w.first, { type: 'undo', submissionId: sub.id });
    report(w, 'pm-2', 'Version two');
    const d = read(w, D);
    assert.equal(d.subject, 'Version two', 'taken once nothing holds the draft');
    assert.equal(d.revision, sub.revision + 1);
    assert.equal(row(w, D)!.remote_message_id, 'pm-2');
  }));

test('a send of an OLDER revision does not hold a draft that has moved on, a queued one or one of this revision does', () =>
  world(async w => {
    const d = create(w, fields());
    const sub = await w.send(w.first, d.id, { revision: d.revision });
    const pins = () =>
      w.first.store.read(q => {
        const r = q.get<DraftRow>('SELECT * FROM drafts WHERE id = ?', d.id)!;
        return { pins: sendPins(q as never, r), any: hasSend(q as never, d.id) };
      });
    assert.deepEqual(pins(), { pins: true, any: true }, 'queued');
    // Keep the sent draft in Drafts: its clean-up commit is held back, so it can be edited after the send.
    for (let i = 0; i < 40; i++)
      w.faults.push((input: CommitInput) => input.writes[0]?.kind === 'draftDelete');
    await wait(w, 15 * SEC);
    assert.equal(w.get(sub.id).state, 'sent');
    assert.deepEqual(pins(), { pins: true, any: true }, 'sent at the current revision');
    edit(w, read(w, d.id), fields({ subject: 'Edited after the send' }));
    assert.deepEqual(pins(), { pins: false, any: true }, 'sent at an older revision');
  }));

test('a newer phone version taken after the send was undone clears the memory: a discard then deletes the copy, guarded on its id', () =>
  world(async w => {
    report(w, 'pm-1', 'Version one');
    const sub = await w.send(w.first, D, { revision: read(w, D).revision });
    report(w, 'pm-2', 'Version two');
    await w.act(w.first, { type: 'undo', submissionId: sub.id });
    report(w, 'pm-2', 'Version two');
    assert.equal(read(w, D).subject, 'Version two');
    assert.equal((syncOf(w, D) as { changedElsewhere?: true }).changedElsewhere, undefined);
    service(w).destroy(next(), D);
    await wait(w, 60 * SEC);
    assert.deepEqual(
      w.remoteDrafts.removeAttempts,
      ['rd-reply'],
      'the copy is removed, not forgotten',
    );
    assert.deepEqual(w.remoteDrafts.removeExpected, ['pm-2'], 'guarded on the version it holds');
    assert.equal(row(w, D), undefined, 'and the hidden row ends');
  }));

test('an undone send shows the version the phone saved meanwhile, so the owner does not send over it', () =>
  world(async w => {
    report(w, 'pm-1', 'Version one');
    const sub = await w.send(w.first, D, { revision: read(w, D).revision });
    report(w, 'pm-2', 'Version two');
    assert.equal(read(w, D).subject, 'Version one', 'held while the send is queued');
    await w.act(w.first, { type: 'undo', submissionId: sub.id });
    const d = read(w, D);
    assert.equal(d.subject, 'Version two', 'applied the moment nothing pins the draft');
    assert.equal(d.revision, sub.revision + 1);
    assert.equal(held(w), undefined, 'and no longer held');
    // Send again from the revision the owner has now seen: it carries the new version.
    await w.send(w.first, D, { revision: d.revision });
    await wait(w, 30 * SEC);
    assert.equal(w.server.payloads.length, 1);
    assert.equal(subjectHeader(w.server.payloads[0].mime), 'Version two');
  }));

test('a Send pressed on the old revision after an undo is refused, and the held version is applied by that check', () =>
  world(async w => {
    report(w, 'pm-1', 'Version one');
    const sub = await w.send(w.first, D, { revision: read(w, D).revision });
    report(w, 'pm-2', 'Version two');
    // The release after the undo fails once (a disk error): the copy stays held.
    w.faults.push((input: CommitInput) => input.opId.startsWith('held:'));
    await w.act(w.first, { type: 'undo', submissionId: sub.id });
    assert.equal(w.get(sub.id).state, 'cancelled');
    assert.equal(read(w, D).subject, 'Version one');
    assert.equal(held(w), 'pm-2', 'still held');
    try {
      await w.send(w.first, D, { revision: sub.revision });
      assert.fail('expected the send to be refused');
    } catch (error) {
      assert.ok(error instanceof ContractError);
      assert.equal(error.type, 'stateMismatch');
    }
    assert.equal(read(w, D).subject, 'Version two', 'the check applied the held version');
    assert.equal(w.server.payloads.length, 0, 'nothing went out');
    await wait(w, 30 * SEC);
    assert.equal(w.server.payloads.length, 0, 'and nothing is queued');
  }));

test('a held version is not applied while another send still pins the draft', () =>
  world(async w => {
    report(w, 'pm-1', 'Version one');
    await w.send(w.first, D, { revision: read(w, D).revision });
    report(w, 'pm-2', 'Version two');
    report(w, 'pm-3', 'Version three');
    assert.equal(held(w), 'pm-3', 'the newest report is the one held');
    assert.equal(read(w, D).subject, 'Version one');
  }));

test("a local draft's phone edit held under a queued send is asked about once the send is undone", () =>
  world(async w => {
    const s = await synced(w);
    const mine = edit(w, s.draft, fields({ subject: 'Mine' }));
    const sub = await w.send(w.first, s.draft.id, { revision: mine.revision });
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, theirId, { subject: 'Theirs', html: '<p>Their body</p>' });
    assert.equal(read(w, s.draft.id).conflict, undefined, 'nothing can be asked under a send');
    await w.act(w.first, { type: 'undo', submissionId: sub.id });
    assert.ok(
      read(w, s.draft.id).conflict,
      'the phone edit is asked about as soon as the send is undone',
    );
    assert.equal(read(w, s.draft.id).subject, 'Mine', 'and nothing of ours was replaced');
  }));

// ---------------------------------------------------------------- the Opus review of the held copy

const rejectedWith = async (fn: () => Promise<unknown>, type: string) => {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof ContractError);
    assert.equal(error.type, type);
    return;
  }
  assert.fail(`expected ${type}`);
};

test('a copy the phone edited and then sent or deleted under our queued send is gone when the send is undone: nothing is resurrected or mailed again', () =>
  world(async w => {
    const s = await synced(w);
    const sub = await w.send(w.first, s.draft.id, { revision: s.draft.revision });
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, theirId, { subject: 'Theirs', html: '<p>Their body</p>' });
    // The removal reports the last known id (Gmail does): the same id as the held edit.
    fact(w, s.remoteDraftId, theirId, { removed: true });
    await w.act(w.first, { type: 'undo', submissionId: sub.id });
    assert.equal(service(w).get([s.draft.id]).notFound.length, 1, 'the removal was applied');
    await rejectedWith(
      () => w.send(w.first, s.draft.id, { revision: s.draft.revision }),
      'notFound',
    );
    await wait(w, 60 * SEC);
    assert.equal(w.server.payloads.length, 0, 'nothing was mailed');
    assert.equal(count(w), 0, 'and no draft names the vanished copy');
  }));

test('a held removal is not overwritten by a late report of the version it replaced', () =>
  world(async w => {
    const s = await synced(w);
    await w.send(w.first, s.draft.id, { revision: s.draft.revision });
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, theirId, { removed: true });
    // An older report of the copy arrives late, under another message id.
    fact(w, s.remoteDraftId, 'msg-late', { subject: 'Late', html: '<p>Late</p>' });
    const kept = (syncOf(w, s.draft.id) as { changedElsewhere?: { removed?: true } })
      .changedElsewhere;
    assert.equal(kept?.removed, true, 'the removal is still the one held');
  }));

test('a held report that a later report overtook is never replayed over it (the clean draft)', () =>
  world(async w => {
    const s = await synced(w);
    const sub = await w.send(w.first, s.draft.id, { revision: s.draft.revision });
    const a = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, a, { subject: 'Phone A', html: '<p>A</p>' });
    // The release after the undo fails once: A stays held.
    w.faults.push((input: CommitInput) => input.opId.startsWith('held:'));
    await w.act(w.first, { type: 'undo', submissionId: sub.id });
    assert.equal(read(w, s.draft.id).subject, 'Lunch');
    const b = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, b, { subject: 'Phone B', html: '<p>B</p>' });
    const now = read(w, s.draft.id);
    assert.equal(now.subject, 'Phone B', 'the clean draft took B');
    await w.send(w.first, s.draft.id, { revision: now.revision });
    assert.equal(read(w, s.draft.id).subject, 'Phone B', 'and the send check did not replay A');
    assert.equal(read(w, s.draft.id).revision, now.revision);
  }));

test('a held report that a later report overtook is never replayed over it (a conflict)', () =>
  world(async w => {
    const s = await synced(w, fields({ bcc: [{ address: 'hidden@mail.example' }] }));
    const sub = await w.send(w.first, s.draft.id, { revision: s.draft.revision });
    const a = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, a, { subject: 'Phone A', html: '<p>A</p>' });
    w.faults.push((input: CommitInput) => input.opId.startsWith('held:'));
    await w.act(w.first, { type: 'undo', submissionId: sub.id });
    const b = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, b, { subject: 'Phone B', html: '<p>B</p>' });
    const other = () =>
      (syncOf(w, s.draft.id) as { conflict?: { theirsMessageId?: string } }).conflict
        ?.theirsMessageId;
    assert.equal(other(), b, 'the conflict names B');
    await rejectedWith(
      () => w.send(w.first, s.draft.id, { revision: read(w, s.draft.id).revision }),
      'stateMismatch',
    );
    assert.equal(other(), b, 'and the send check did not switch it to A');
  }));

test('a held version is not applied by a send check while the draft is still pinned by a send', () =>
  world(async w => {
    report(w, 'pm-1', 'Version one');
    const first = read(w, D);
    await w.send(w.first, D, { revision: first.revision });
    report(w, 'pm-2', 'Version two');
    const seq = w.first.store.seq();
    await rejectedWith(() => w.send(w.first, D, { revision: first.revision }), 'stateMismatch');
    assert.equal(w.first.store.seq(), seq, 'the refused check committed nothing (no release)');
    assert.equal(read(w, D).subject, 'Version one', 'still the version the send was queued on');
    assert.equal(held(w), 'pm-2', 'and still held');
  }));

for (const [name, extra] of [
  ['a copy the row no longer names', { remoteDraftId: 'rd-other' }],
  ['another account', { accountId: 'someone-else' }],
] as const)
  test(`a held report of ${name} is not replayed: no stray draft, the copy stays marked`, () =>
    world(async w => {
      const s = await synced(w);
      const sub = await w.send(w.first, s.draft.id, { revision: s.draft.revision });
      const base = {
        kind: 'remoteDraft',
        accountId: ACCOUNT,
        remoteDraftId: s.remoteDraftId,
        remoteMessageId: 'msg-x',
        changedAt: w.clock.now(),
        html: '<p>x</p>',
        message: {
          remoteId: 'msg-x',
          remoteThreadId: 't-x',
          subject: 'Stray',
          flags: { seen: true, flagged: false, draft: true, fromMe: true },
          date: 1,
          internalDate: 1,
        },
      };
      const stray = Object.assign({}, base, extra);
      w.first.store.commit({
        opId: `craft-${++reports}`,
        origin: 'system',
        writes: [
          { kind: 'draft', op: 'meta', id: s.draft.id, patch: { changedElsewhere: stray } },
        ] as never,
      });
      const before = count(w);
      await w.act(w.first, { type: 'undo', submissionId: sub.id });
      assert.equal(count(w), before, 'no stray draft was inserted');
      assert.equal(held(w, s.draft.id), true);
      assert.equal(read(w, s.draft.id).subject, 'Lunch');
    }));

// ---------------------------------------------------------------- the Opus re-check of the held copy

test('an echo of our own copy arriving while a report is held does not drop it: the send check still applies it', () =>
  world(async w => {
    const s = await synced(w);
    const sub = await w.send(w.first, s.draft.id, { revision: s.draft.revision });
    const a = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, a, { subject: 'Phone A', html: '<p>A</p>' });
    w.faults.push((input: CommitInput) => input.opId.startsWith('held:'));
    await w.act(w.first, { type: 'undo', submissionId: sub.id });
    assert.equal(read(w, s.draft.id).subject, 'Lunch', 'A is still held');
    // History repeats the copy this row already holds (an echo): it changes nothing, and A stays held.
    fact(w, s.remoteDraftId, s.messageId, { subject: 'Lunch', html: '<p>Lunch at noon?</p>' });
    assert.equal(held(w, s.draft.id), a, 'A is still held after the echo');
    await rejectedWith(
      () => w.send(w.first, s.draft.id, { revision: s.draft.revision }),
      'stateMismatch',
    );
    assert.equal(read(w, s.draft.id).subject, 'Phone A', 'the check applied A');
    assert.equal(w.server.payloads.length, 0, 'and nothing went out');
  }));

test('a phone edit of a draft whose OLDER revision was sent is asked about, not held for good', () =>
  world(async w => {
    const s = await synced(w);
    const sub = await w.send(w.first, s.draft.id, { revision: s.draft.revision });
    // Keep the sent draft in Drafts for a moment, so the owner can edit it after the send.
    for (let i = 0; i < 40; i++)
      w.faults.push((input: CommitInput) => input.writes[0]?.kind === 'draftDelete');
    await wait(w, 15 * SEC);
    assert.equal(w.get(sub.id).state, 'sent');
    const after = edit(w, read(w, s.draft.id), fields({ subject: 'After' }));
    assert.equal(after.revision, s.draft.revision + 1);
    const b = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, b, { subject: 'Phone B', html: '<p>B</p>' });
    assert.equal(held(w, s.draft.id), undefined, 'nothing is held: no send pins this revision');
    const conflict = (syncOf(w, s.draft.id) as { conflict?: { theirsMessageId?: string } })
      .conflict;
    assert.equal(conflict?.theirsMessageId, b, 'the owner is asked about the phone version');
    await rejectedWith(
      () => w.send(w.first, s.draft.id, { revision: after.revision }),
      'stateMismatch',
    );
    assert.equal(w.server.payloads.length, 1, 'the later text was not mailed over it');
  }));

test('a removal reported under the row’s own message id is a removal, not an echo (no send, queued send)', () =>
  world(async w => {
    const s = await synced(w);
    fact(w, s.remoteDraftId, s.messageId, { removed: true });
    assert.equal(service(w).get([s.draft.id]).notFound.length, 1, 'the draft is gone');
    const t = await synced(w, fields({ subject: 'Second' }));
    const sub = await w.send(w.first, t.draft.id, { revision: t.draft.revision });
    fact(w, t.remoteDraftId, t.messageId, { removed: true });
    await w.act(w.first, { type: 'undo', submissionId: sub.id });
    assert.equal(service(w).get([t.draft.id]).notFound.length, 1, 'gone once the send is undone');
    await rejectedWith(
      () => w.send(w.first, t.draft.id, { revision: t.draft.revision }),
      'notFound',
    );
    assert.equal(w.server.payloads.length, 0, 'nothing can be mailed a second time');
  }));

test('our own removal of the copy, reported back under the row’s id, still just ends the hidden row', () =>
  world(async w => {
    const s = await synced(w);
    service(w).destroy(next(), s.draft.id);
    await wait(w, 60 * SEC);
    assert.deepEqual(w.remoteDrafts.removeAttempts, [s.remoteDraftId], 'we removed the copy');
    fact(w, s.remoteDraftId, s.messageId, { removed: true });
    assert.equal(count(w), 0, 'nothing is left');
    assert.equal(w.remoteDrafts.removeAttempts.length, 1);
  }));

test('after a later version replaced the clean draft over a held one, a discard deletes the copy again, guarded on its id', () =>
  world(async w => {
    const s = await synced(w);
    const sub = await w.send(w.first, s.draft.id, { revision: s.draft.revision });
    const a = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, a, { subject: 'Phone A', html: '<p>A</p>' });
    w.faults.push((input: CommitInput) => input.opId.startsWith('held:'));
    await w.act(w.first, { type: 'undo', submissionId: sub.id });
    const b = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, b, { subject: 'Phone B', html: '<p>B</p>' });
    assert.equal(read(w, s.draft.id).subject, 'Phone B');
    assert.equal(held(w, s.draft.id), undefined, 'the mark is cleared with the version taken');
    service(w).destroy(next(), s.draft.id);
    await wait(w, 60 * SEC);
    assert.deepEqual(w.remoteDrafts.removeAttempts, [s.remoteDraftId]);
    assert.deepEqual(w.remoteDrafts.removeExpected, [b]);
  }));

test('the phone removes a draft whose older revision was sent and that was edited here since: the text is kept and the owner is told the copy is gone', () =>
  world(async w => {
    const s = await synced(w);
    const sub = await w.send(w.first, s.draft.id, { revision: s.draft.revision });
    for (let i = 0; i < 40; i++)
      w.faults.push((input: CommitInput) => input.writes[0]?.kind === 'draftDelete');
    await wait(w, 15 * SEC);
    assert.equal(w.get(sub.id).state, 'sent');
    const after = edit(w, read(w, s.draft.id), fields({ subject: 'After' }));
    fact(w, s.remoteDraftId, s.messageId, { removed: true });
    const d = read(w, s.draft.id);
    assert.equal(d.subject, 'After', 'the text is kept');
    const conflict = (syncOf(w, s.draft.id) as { conflict?: { gone?: true } }).conflict;
    assert.equal(conflict?.gone, true, 'and the owner is told the copy is gone');
    assert.equal(held(w, s.draft.id), undefined, 'nothing is held for good');
    await rejectedWith(
      () => w.send(w.first, s.draft.id, { revision: after.revision }),
      'stateMismatch',
    );
    assert.equal(w.server.payloads.length, 1, 'the later text was not mailed');
  }));
