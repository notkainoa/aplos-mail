import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '@aplos/contract/contract-error';
import { OVERDUE_GRACE_MS } from '@aplos/contract/rules';
import { assertIdsPerRevision, fields, gate, inWorld, MIN, SEC, T0, type World } from './helpers';

/** The review of PR #105 (SEND-GUARD): one Message-ID is never delivered twice, and nothing goes out wrongly. */

function refused(fn: () => unknown, type: string): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ContractError, `a ContractError, got ${String(error)}`);
    assert.equal(error.type, type, error.message);
    return error.message;
  }
  assert.fail(`expected ${type}`);
}

const header = (mime: Uint8Array, name: string) =>
  new RegExp(`^${name}: (.*)$`, 'm').exec(new TextDecoder().decode(mime))?.[1];

const storedMime = (w: World, id: string) => w.raw(id)!.mime as Uint8Array;

const REMOTE_ID = '<remote-copy-1@mail.example>';

// ---------------------------------------------------------------- (1) the remote draft's Message-ID

test('a draft synced at its revision is sent under the remote copy Message-ID, so findSent looks for the id that left', () =>
  inWorld(async w => {
    w.draft('d1', fields(), {
      remoteDraftId: 'rd-1',
      remoteMessageId: 'rm-1',
      remoteInternetId: REMOTE_ID,
      syncedRevision: 1,
    });
    w.server.script.push({ result: 'lost', delivered: true });
    const s = w.send(w.first, 'd1');
    assert.equal(s.internetId, REMOTE_ID, 'the submission carries the remote copy id');
    assert.equal(header(storedMime(w, s.id), 'Message-ID'), REMOTE_ID);
    await w.clock.advance(10 * SEC);
    await w.settle();
    const payload = w.server.payloads[0];
    assert.equal(payload.internetId, REMOTE_ID);
    assert.equal(payload.remoteDraftId, 'rd-1');
    assert.equal(payload.baseRemoteMessageId, 'rm-1');
    const asked = w.server.calls.filter(c => c.op === 'findSent').map(c => c.internetId);
    assert.deepEqual(asked, [REMOTE_ID], 'findSent was asked for the id the remote draft carries');
    assert.equal(w.get(s.id).state, 'sent', 'a found match settles sent');
    assert.equal(w.server.sends().length, 1);
    assert.equal(w.server.worst(), 1);
  }));

test('a timed-out drafts.send that never delivered is not found under the remote id and stays uncertain, never re-sent', () =>
  inWorld(async w => {
    w.draft('d1', fields(), {
      remoteDraftId: 'rd-1',
      remoteMessageId: 'rm-1',
      remoteInternetId: REMOTE_ID,
      syncedRevision: 1,
    });
    w.server.script.push({ result: 'lost', delivered: false });
    const s = w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    await w.clock.advance(MIN);
    await w.settle();
    const asked = new Set(w.server.calls.filter(c => c.op === 'findSent').map(c => c.internetId));
    assert.deepEqual([...asked], [REMOTE_ID]);
    assert.equal(w.get(s.id).problem?.reasonCode, 'send.uncertain');
    assert.equal(w.server.sends().length, 1);
  }));

test('a draft whose synced copy is another revision sends the pinned MIME without the remote draft, under its own Message-ID', () =>
  inWorld(async w => {
    w.draft('d1', fields(), {
      revision: 2,
      remoteDraftId: 'rd-1',
      remoteMessageId: 'rm-1',
      remoteInternetId: REMOTE_ID,
      syncedRevision: 1,
    });
    const s = w.send(w.first, 'd1', { revision: 2 });
    assert.notEqual(s.internetId, REMOTE_ID);
    assert.match(s.internetId, /^<[0-9a-f]{32}@mail\.example>$/);
    await w.clock.advance(10 * SEC);
    await w.settle();
    const payload = w.server.payloads[0];
    assert.equal(payload.remoteDraftId, undefined);
    assert.equal(payload.baseRemoteMessageId, undefined);
    assert.equal(payload.internetId, s.internetId);
  }));

test('a synced draft with no stored remote Message-ID is sent as the pinned MIME, never as the remote draft', () =>
  inWorld(async w => {
    w.draft('d1', fields(), { remoteDraftId: 'rd-1', remoteMessageId: 'rm-1', syncedRevision: 1 });
    w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.server.payloads[0].remoteDraftId, undefined);
    assert.equal(w.server.payloads[0].baseRemoteMessageId, undefined);
  }));

// ---------------------------------------------------------------- (2) the sender

test('a From that is not the account address is refused with a sentence; the account address in any case is accepted', () =>
  inWorld(w => {
    w.draft('evil', fields({ from: { address: 'ceo@bank.example', name: 'CEO' } }));
    w.draft('case', fields({ from: { address: ' Owner@Mail.Example ', name: 'Owner' } }));
    const sentence = refused(
      () => w.act(w.first, { type: 'send', draftId: 'evil', revision: 1 }),
      'validation',
    );
    assert.match(sentence, /send from this account/i);
    const n = () =>
      w.first.store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM submissions'))!.n;
    assert.equal(n(), 0, 'nothing was queued');
    const s = w.send(w.first, 'case');
    const mime = new TextDecoder().decode(storedMime(w, s.id));
    assert.match(mime, /^From: Owner <owner@mail\.example>$/m);
    assert.equal(n(), 1);
  }));

// ---------------------------------------------------------------- (3) not-sent classes

const CLASSES: [string, string, string, boolean][] = [
  [
    'permanent',
    'send.permanent',
    'The provider refused this message. Check the address and the content.',
    false,
  ],
  [
    'permission',
    'send.permission',
    'Aplos is not allowed to send from this account. Reconnect it in Settings.',
    false,
  ],
  [
    'anti_abuse',
    'send.anti_abuse',
    'The provider paused sending because it looked unusual. Wait a while, then cancel this message and send it again.',
    false,
  ],
  ['config', 'send.config', 'Sending is not set up correctly for this account.', false],
  [
    'transient',
    'net.offline',
    'Your message was not sent. Check your connection, then try again.',
    true,
  ],
  [
    'auth',
    'auth.expired',
    'Aplos needs you to sign in to this account again. Reconnect it in Settings.',
    true,
  ],
];

for (const [cls, code, copy, retryable] of CLASSES) {
  test(`a not-sent ${cls} failure says ${code}${retryable ? ' and offers Retry' : ' and refuses Retry'}`, () =>
    inWorld(async w => {
      w.draft('d1');
      w.server.script.push({ result: 'notSent', notSentClass: cls });
      const s = w.send(w.first, 'd1');
      await w.clock.advance(10 * SEC);
      await w.settle();
      const failed = w.get(s.id);
      assert.equal(failed.state, 'failed');
      assert.equal(failed.problem?.reasonCode, code);
      assert.equal(failed.problem?.message, copy);
      if (cls === 'auth') assert.doesNotMatch(copy, /connection/i);
      const retry = () => w.act(w.first, { type: 'retry', submissionId: s.id });
      if (retryable) assert.equal(retry().submission.state, 'queued');
      else {
        refused(retry, 'stateMismatch');
        assert.equal(w.get(s.id).state, 'failed');
        assert.equal(
          w.act(w.first, { type: 'cancel', submissionId: s.id }).submission.state,
          'cancelled',
          'Cancel clears it',
        );
      }
    }));
}

// ---------------------------------------------------------------- (4) Date is the send time

test('a scheduled send is dated at its not_before; a reschedule or Send now re-dates the same bytes under the same Message-ID', () =>
  inWorld(async w => {
    w.draft('d1');
    const s = w.send(w.first, 'd1', { notBefore: T0 + 60 * MIN });
    const before = storedMime(w, s.id);
    assert.equal(header(before, 'Date'), 'Wed, 28 Oct 2026 10:00:00 +0000');

    const moved = w.act(w.first, {
      type: 'reschedule',
      submissionId: s.id,
      notBefore: T0 + 120 * MIN,
    }).submission;
    const after = storedMime(w, s.id);
    assert.equal(header(after, 'Date'), 'Wed, 28 Oct 2026 11:00:00 +0000');
    assert.equal(header(after, 'Message-ID'), s.internetId);
    assert.equal(moved.internetId, s.internetId);
    assert.equal(
      new TextDecoder().decode(after).replace(/^Date: .*$/m, ''),
      new TextDecoder().decode(before).replace(/^Date: .*$/m, ''),
      'only the Date line changed',
    );

    await w.clock.advance(5 * MIN);
    w.act(w.first, { type: 'sendNow', submissionId: s.id });
    assert.equal(header(storedMime(w, s.id), 'Date'), 'Wed, 28 Oct 2026 09:05:00 +0000');
    await w.settle();
    await w.clock.advance(1 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent');
    assert.equal(header(w.server.payloads[0].mime, 'Date'), 'Wed, 28 Oct 2026 09:05:00 +0000');
    assert.equal(w.server.payloads[0].internetId, s.internetId);
    assert.equal(w.server.worst(), 1);
  }));

test('an ordinary send is dated when it leaves (not_before), and a row already sending keeps its bytes', () =>
  inWorld(async w => {
    w.draft('d1');
    const gateOpen = gate();
    w.server.script.push({ wait: gateOpen.wait });
    const s = w.send(w.first, 'd1');
    assert.equal(header(storedMime(w, s.id), 'Date'), 'Wed, 28 Oct 2026 09:00:10 +0000');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'sending');
    const bytes = Buffer.from(storedMime(w, s.id)).toString('latin1');
    refused(
      () => w.act(w.first, { type: 'reschedule', submissionId: s.id, notBefore: T0 + 90 * MIN }),
      'stateMismatch',
    );
    assert.equal(Buffer.from(storedMime(w, s.id)).toString('latin1'), bytes, 'never rebuilt');
    gateOpen.open();
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent');
  }));

test('retry and Send anyway keep the bytes exactly, Date included', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'notSent' });
    const s = w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    const bytes = Buffer.from(storedMime(w, s.id)).toString('latin1');
    await w.clock.advance(3 * MIN);
    w.act(w.first, { type: 'retry', submissionId: s.id });
    assert.equal(Buffer.from(storedMime(w, s.id)).toString('latin1'), bytes);
  }));

test('a suspended send re-dated by Send now is still a single delivery of one Message-ID', () =>
  inWorld(async w => {
    w.draft('d1');
    const s = w.send(w.first, 'd1', { notBefore: T0 + 5 * MIN });
    await w.clock.set(T0 + 5 * MIN + OVERDUE_GRACE_MS + 5 * SEC);
    w.first.outbox.wake();
    await w.settle();
    assert.equal(w.get(s.id).state, 'suspended');
    w.act(w.first, { type: 'sendNow', submissionId: s.id });
    await w.settle();
    await w.clock.advance(1 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent');
    assert.equal(w.server.worst(), 1);
  }));

// ---------------------------------------------------------------- (6) clock skew in findSent

test('findSent searches from a margin before the attempt, so a skewed clock cannot hide the message', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'lost', delivered: true });
    const s = w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    const attemptAt = w.raw(s.id)!.attempt_at as number;
    const since = w.server.calls.find(c => c.op === 'findSent')!.since!;
    assert.equal(since, attemptAt - 5 * MIN, 'five minutes before the attempt');
  }));

// ---------------------------------------------------------------- follow-ups: drafts, Microsoft, per-revision ids, re-dating

const header2 = header;
const REMOTE_R1 = '<remote-copy-r1@mail.example>';
const REMOTE_R2 = '<remote-copy-r2@mail.example>';
const bytesOf = (mime: Uint8Array) => Buffer.from(mime).toString('latin1');

test('microsoft: a synced draft id is not reused, the remote draft is never sent, and two revisions get different ids', () =>
  inWorld(
    async w => {
      w.draft('d1', fields(), {
        remoteDraftId: 'rd-1',
        remoteMessageId: 'rm-1',
        remoteInternetId: REMOTE_R1,
        syncedRevision: 1,
      });
      const r1 = w.send(w.first, 'd1');
      assert.notEqual(r1.internetId, REMOTE_R1, 'a fresh Message-ID, not the Graph draft id');
      assert.equal(header2(storedMime(w, r1.id), 'Message-ID'), r1.internetId);
      w.act(w.first, { type: 'undo', submissionId: r1.id });
      // Graph keeps the draft's Message-ID across the edit: revision 2 is "synced" under the very same id.
      w.draft('d1', fields({ subject: 'Lunch?' }), {
        revision: 2,
        remoteDraftId: 'rd-1',
        remoteMessageId: 'rm-1',
        remoteInternetId: REMOTE_R1,
        syncedRevision: 2,
      });
      const r2 = w.send(w.first, 'd1', { revision: 2 });
      assert.notEqual(r2.internetId, REMOTE_R1);
      assert.notEqual(r2.internetId, r1.internetId, 'two revisions, two ids');
      await w.clock.advance(10 * SEC);
      await w.settle();
      const payload = w.server.payloads[0];
      assert.equal(payload.remoteDraftId, undefined, 'a Microsoft remote draft is never sent');
      assert.equal(payload.baseRemoteMessageId, undefined);
      assert.equal(payload.internetId, r2.internetId);
      assertIdsPerRevision(w, 'd1');
    },
    { provider: 'microsoft' },
  ));

test('ids are per revision: revision R+1 never reuses the id of revision R, even when draft sync kept it', () =>
  inWorld(async w => {
    w.draft('d1', fields(), {
      remoteDraftId: 'rd-1',
      remoteMessageId: 'rm-1',
      remoteInternetId: REMOTE_R1,
      syncedRevision: 1,
    });
    const r1 = w.send(w.first, 'd1');
    assert.equal(r1.internetId, REMOTE_R1, 'revision 1 goes out under its synced copy id');
    w.act(w.first, { type: 'undo', submissionId: r1.id });
    // A correct draft sync uploads revision 2 under a new id.
    w.draft('d1', fields({ subject: 'Lunch?' }), {
      revision: 2,
      remoteDraftId: 'rd-2',
      remoteMessageId: 'rm-2',
      remoteInternetId: REMOTE_R2,
      syncedRevision: 2,
    });
    const r2 = w.send(w.first, 'd1', { revision: 2 });
    assert.equal(r2.internetId, REMOTE_R2);
    w.act(w.first, { type: 'undo', submissionId: r2.id });
    // A draft sync that kept the id per draft (a bug) must not make revision 3 share revision 1's id.
    w.draft('d1', fields({ subject: 'Lunch??' }), {
      revision: 3,
      remoteDraftId: 'rd-2',
      remoteMessageId: 'rm-3',
      remoteInternetId: REMOTE_R1,
      syncedRevision: 3,
    });
    const r3 = w.send(w.first, 'd1', { revision: 3 });
    assert.notEqual(r3.internetId, REMOTE_R1);
    assert.notEqual(r3.internetId, REMOTE_R2);
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.server.payloads[0].remoteDraftId, undefined, 'its remote copy is not its id');
    assertIdsPerRevision(w, 'd1');
    assert.equal(w.server.worst(), 1);
  }));

test('the same revision sent again after an undo keeps its remote copy id', () =>
  inWorld(async w => {
    w.draft('d1', fields(), {
      remoteDraftId: 'rd-1',
      remoteMessageId: 'rm-1',
      remoteInternetId: REMOTE_R1,
      syncedRevision: 1,
    });
    const first = w.send(w.first, 'd1');
    w.act(w.first, { type: 'undo', submissionId: first.id });
    const again = w.send(w.first, 'd1');
    assert.equal(again.internetId, REMOTE_R1);
    assertIdsPerRevision(w, 'd1');
  }));

test('a row that has had an attempt is not re-dated: Send anyway, then Reschedule or Send now, resends the same bytes', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'lost', delivered: true });
    w.server.hideDeliveriesUntil(Number.MAX_SAFE_INTEGER);
    const s = w.send(w.first, 'd1');
    const original = bytesOf(storedMime(w, s.id));
    await w.clock.advance(10 * SEC);
    await w.settle();
    await w.clock.advance(MIN);
    await w.settle();
    assert.equal(w.get(s.id).problem?.reasonCode, 'send.uncertain');
    assert.equal(bytesOf(storedMime(w, s.id)), original);

    await w.clock.advance(7 * MIN);
    w.act(w.first, { type: 'sendAnyway', submissionId: s.id });
    const later = w.act(w.first, {
      type: 'reschedule',
      submissionId: s.id,
      notBefore: w.clock.now() + 30 * MIN,
    });
    assert.equal(later.submission.state, 'scheduled');
    assert.equal(bytesOf(storedMime(w, s.id)), original, 'Reschedule did not re-date a tried row');
    w.act(w.first, { type: 'sendNow', submissionId: s.id });
    assert.equal(bytesOf(storedMime(w, s.id)), original, 'nor did Send now');

    w.server.hideDeliveriesUntil(0);
    await w.settle();
    await w.clock.advance(1 * SEC);
    await w.settle();
    assert.equal(w.server.payloads.length, 2, 'the owner chose the second delivery');
    assert.equal(bytesOf(w.server.payloads[1].mime), bytesOf(w.server.payloads[0].mime));
    assert.equal(w.server.payloads[1].internetId, s.internetId);
  }));

test('a send paused before it left was not tried: Send now still re-dates it', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'paused', until: T0 + 20 * SEC });
    const s = w.send(w.first, 'd1');
    const original = bytesOf(storedMime(w, s.id));
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'queued');
    await w.clock.advance(2 * SEC);
    w.act(w.first, { type: 'sendNow', submissionId: s.id });
    assert.notEqual(bytesOf(storedMime(w, s.id)), original);
    assert.equal(header2(storedMime(w, s.id), 'Message-ID'), s.internetId);
  }));

test('a tried row that is then only paused keeps its attempt marker: Reschedule does not re-date it', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'lost', delivered: true });
    w.server.hideDeliveriesUntil(Number.MAX_SAFE_INTEGER);
    const s = w.send(w.first, 'd1');
    const original = bytesOf(storedMime(w, s.id));
    await w.clock.advance(10 * SEC);
    await w.settle();
    await w.clock.advance(MIN);
    await w.settle();
    assert.equal(w.get(s.id).problem?.reasonCode, 'send.uncertain');

    await w.clock.advance(7 * MIN);
    w.server.script.push({ result: 'paused', until: w.clock.now() + 20 * MIN });
    w.act(w.first, { type: 'sendAnyway', submissionId: s.id });
    await w.settle();
    await w.clock.advance(1 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'queued', 'paused, not sent');
    assert.equal(w.server.payloads.length, 1, 'the paused send did not leave');

    w.act(w.first, { type: 'reschedule', submissionId: s.id, notBefore: w.clock.now() + 30 * MIN });
    assert.equal(
      bytesOf(storedMime(w, s.id)),
      original,
      'Reschedule did not re-date a row that was tried',
    );
    assert.equal(header2(storedMime(w, s.id), 'Message-ID'), s.internetId);
  }));

test('a paused send with no earlier attempt clears the marker: Reschedule still re-dates it', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'paused', until: T0 + 20 * SEC });
    const s = w.send(w.first, 'd1');
    const original = bytesOf(storedMime(w, s.id));
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'queued');
    w.act(w.first, { type: 'reschedule', submissionId: s.id, notBefore: w.clock.now() + 30 * MIN });
    assert.notEqual(bytesOf(storedMime(w, s.id)), original);
    assert.equal(header2(storedMime(w, s.id), 'Message-ID'), s.internetId);
  }));
