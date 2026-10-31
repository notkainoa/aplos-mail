import test from 'node:test';
import assert from 'node:assert/strict';
import type { CommitInput } from '../../src/store';
import { hasSend, sendPins } from '../../src/outbox/draft-proof';
import type { DraftRow } from '../../src/outbox/draft-state';
import { ACCOUNT, fields, SEC, type World } from './helpers';
import { create, edit, next, read, row, service, syncOf, wait, world } from './drafts.ports.kit';

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

const subjectHeader = (mime: Uint8Array) =>
  Buffer.from(mime)
    .toString()
    .match(/^Subject: (.*)$/m)?.[1];

test('a newer phone version reported while a send is queued does not move the draft: the send keeps its base and the draft leaves Drafts', () =>
  world(async w => {
    report(w, 'pm-1', 'Version one');
    const queued = read(w, D);
    const sub = w.send(w.first, D, { revision: queued.revision });
    report(w, 'pm-2', 'Version two');
    const now = read(w, D);
    assert.equal(now.revision, queued.revision, 'the draft did not move under its queued send');
    assert.equal(now.subject, 'Version one');
    assert.equal(row(w, D)!.remote_message_id, 'pm-1');
    assert.equal(
      (syncOf(w, D) as { changedElsewhere?: true }).changedElsewhere,
      true,
      'the change is remembered',
    );
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
    const sub = w.send(w.first, D, { revision: read(w, D).revision });
    report(w, 'pm-2', 'Version two');
    assert.equal(read(w, D).subject, 'Version one', 'held while the send is queued');
    w.act(w.first, { type: 'undo', submissionId: sub.id });
    report(w, 'pm-2', 'Version two');
    const d = read(w, D);
    assert.equal(d.subject, 'Version two', 'taken once nothing holds the draft');
    assert.equal(d.revision, sub.revision + 1);
    assert.equal(row(w, D)!.remote_message_id, 'pm-2');
  }));

test('a send of an OLDER revision does not hold a draft that has moved on, a queued one or one of this revision does', () =>
  world(async w => {
    const d = create(w, fields());
    const sub = w.send(w.first, d.id, { revision: d.revision });
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
    const sub = w.send(w.first, D, { revision: read(w, D).revision });
    report(w, 'pm-2', 'Version two');
    w.act(w.first, { type: 'undo', submissionId: sub.id });
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
