import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '@aplos/contract/contract-error';
import { OVERDUE_GRACE_MS } from '@aplos/contract/rules';
import { SubmissionConflict } from '../../src/outbox/module';
import type { CommitInput } from '../../src/store';
import { ACCOUNT, fields, gate, inWorld, MIN, SEC, T0 } from './helpers';

/** Asserts a `Submission/set` refusal (a rejected promise) by contract error type, and returns its sentence. */
async function rejected(fn: () => Promise<unknown>, type: string): Promise<string> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof ContractError, `a ContractError, got ${String(error)}`);
    assert.equal(error.type, type, error.message);
    return error.message;
  }
  assert.fail(`expected ${type}`);
}

test('send queues with the undo window, pins the revision and its MIME, and goes out once at notBefore', () =>
  inWorld(async w => {
    w.draft('d1');
    const { submission: s, receipt } = await w.act(w.first, {
      type: 'send',
      draftId: 'd1',
      revision: 1,
    });
    assert.equal(s.state, 'queued');
    assert.equal(s.notBefore, T0 + 10 * SEC, 'undoSendSeconds defaults to 10');
    assert.equal(s.queuedAt, T0);
    assert.equal(s.revision, 1);
    assert.deepEqual(s.toNames, ['Jordan']);
    assert.equal(s.subject, 'Lunch');
    assert.match(s.internetId, /^<[0-9a-f]{32}@mail\.example>$/);
    assert.equal(receipt.undoable, true);
    assert.equal(receipt.undoUntil, s.notBefore);
    assert.equal(receipt.appliedState.dbEpoch, w.first.store.dbEpoch);
    const mime = w.raw(s.id)!.mime as Uint8Array;
    assert.ok(mime.length > 0, 'the exact bytes are stored at send');

    await w.clock.advance(9 * SEC);
    await w.settle();
    assert.equal(w.server.sends().length, 0, 'nothing leaves inside the undo window');
    await w.clock.advance(1 * SEC);
    await w.settle();
    const sent = w.get(s.id);
    assert.equal(sent.state, 'sent');
    assert.equal(sent.sentAt, T0 + 10 * SEC);
    assert.equal(sent.attemptAt, T0 + 10 * SEC);
    assert.equal(w.server.deliveries.get(s.internetId), 1);
    assert.deepEqual(w.server.payloads[0].mime, mime, 'the pinned bytes are what left');
    assert.equal(w.raw(s.id)!.mime, null, 'the MIME is dropped once sent is committed');
    assert.deepEqual(
      w.events('submission.state').map(r => [r.data.from, r.data.to]),
      [
        ['queued', 'sending'],
        ['sending', 'sent'],
      ],
    );
    assert.equal(w.events('send.sent').length, 1);
    await w.clock.advance(10 * MIN);
    await w.settle();
    assert.equal(w.server.sends().length, 1, 'never sent again');
    assert.equal(
      w.events('engine.watchdog').length,
      0,
      'the outbox never leaves its deadline in the past',
    );
  }));

test('the undo window follows the setting; send later is scheduled; a send replayed by opId changes nothing', () =>
  inWorld(
    async w => {
      w.draft('d1');
      w.draft('d2');
      const a = await w.act(w.first, { type: 'send', draftId: 'd1', revision: 1 }, 'op-same');
      assert.equal(a.submission.notBefore, T0 + 5 * SEC);
      const again = await w.act(w.first, { type: 'send', draftId: 'd1', revision: 1 }, 'op-same');
      assert.equal(again.submission.id, a.submission.id);
      assert.equal(again.receipt.appliedState.seq, a.receipt.appliedState.seq);
      const later = await w.send(w.first, 'd2', { notBefore: T0 + 2 * MIN });
      assert.equal(later.state, 'scheduled');
      assert.equal(later.notBefore, T0 + 2 * MIN);
      await w.clock.advance(5 * SEC);
      await w.settle();
      assert.equal(w.get(a.submission.id).state, 'sent');
      assert.equal(w.get(later.id).state, 'scheduled');
      await w.clock.advance(2 * MIN);
      await w.settle();
      assert.equal(w.get(later.id).state, 'sent');
      assert.equal(w.server.worst(), 1);
      assert.equal(w.server.sends().length, 2);
    },
    { settings: () => ({ undoSendSeconds: 5 }) },
  ));

test('send refuses a stale revision, a draft already sending, a missing draft and no recipients', () =>
  inWorld(async w => {
    w.draft('d1', fields(), { revision: 3 });
    w.draft('empty', fields({ to: [] }));
    assert.match(
      await rejected(
        () => w.act(w.first, { type: 'send', draftId: 'd1', revision: 2 }),
        'stateMismatch',
      ),
      /changed in another window/,
    );
    await w.act(w.first, { type: 'send', draftId: 'd1', revision: 3 });
    await rejected(
      () => w.act(w.first, { type: 'send', draftId: 'd1', revision: 3 }),
      'stateMismatch',
    );
    await rejected(
      () => w.act(w.first, { type: 'send', draftId: 'nope', revision: 1 }),
      'notFound',
    );
    await rejected(
      () => w.act(w.first, { type: 'send', draftId: 'empty', revision: 1 }),
      'validation',
    );
    const count = w.first.store.read(q =>
      q.get<{ n: number }>('SELECT count(*) AS n FROM submissions'),
    )!.n;
    assert.equal(count, 1);
  }));

test('a settled send wakes the account sync so Sent and the thread refresh at once', () => {
  const wakes: string[] = [];
  return inWorld(
    async w => {
      w.draft('d1');
      const { submission: s } = await w.act(w.first, {
        type: 'send',
        draftId: 'd1',
        revision: 1,
      });
      await w.clock.advance(11 * SEC);
      await w.settle();
      assert.equal(w.get(s.id).state, 'sent');
      assert.deepEqual(wakes, [ACCOUNT], 'the sending account, not another');
    },
    { afterSend: id => wakes.push(id) },
  );
});

test('undo before notBefore cancels and nothing leaves; wrong states are refused with a sentence', () =>
  inWorld(async w => {
    w.draft('d1');
    const s = await w.send(w.first, 'd1');
    const out = await w.act(w.first, { type: 'undo', submissionId: s.id });
    assert.equal(out.submission.state, 'cancelled');
    assert.equal(out.receipt.undoable, false);
    await w.clock.advance(1 * MIN);
    await w.settle();
    assert.equal(w.server.sends().length, 0);
    assert.match(
      await rejected(() => w.act(w.first, { type: 'undo', submissionId: s.id }), 'stateMismatch'),
      /cancelled/,
    );
    for (const type of ['sendAnyway', 'retry', 'cancel', 'sendNow'] as const)
      await rejected(() => w.act(w.first, { type, submissionId: s.id }), 'stateMismatch');
    await rejected(() => w.act(w.first, { type: 'undo', submissionId: 'missing' }), 'notFound');
    // The draft is unlocked: it can be sent again, as a new submission with a new Message-ID.
    const again = await w.send(w.first, 'd1');
    assert.notEqual(again.internetId, s.internetId);
  }));

test('undo racing the send: once the sending marker is committed, undo loses and the message leaves once', () =>
  inWorld(async w => {
    w.draft('d1');
    const g = gate();
    w.server.script.push({ wait: g.wait });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    assert.equal(w.get(s.id).state, 'sending', 'the marker is committed before send is called');
    assert.equal(w.server.sends().length, 1);
    assert.match(
      await rejected(() => w.act(w.first, { type: 'undo', submissionId: s.id }), 'stateMismatch'),
      /sending now/,
    );
    g.open();
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent');
    await rejected(() => w.act(w.first, { type: 'undo', submissionId: s.id }), 'stateMismatch');
    assert.equal(w.server.worst(), 1);
  }));

test('a stale timer loses its compare-and-set against an undo committed first', () =>
  inWorld(async w => {
    w.draft('d1');
    const s = await w.send(w.first, 'd1');
    await w.act(w.first, { type: 'undo', submissionId: s.id });
    // What the timer would commit had it read the row before the undo landed.
    assert.throws(
      () =>
        w.first.store.commit({
          opId: 'stale-timer',
          origin: 'system',
          writes: [
            {
              kind: 'submission',
              op: 'move',
              id: s.id,
              from: ['queued'],
              to: 'sending',
              ifNotBefore: s.notBefore,
              set: { attemptAt: T0 + 10 * SEC },
            },
          ],
        }),
      (e: unknown) => e instanceof SubmissionConflict && e.current === 'cancelled',
    );
    assert.equal(w.get(s.id).state, 'cancelled');
    await w.clock.advance(1 * MIN);
    await w.settle();
    assert.equal(w.server.sends().length, 0);
  }));

test('NotSentError fails with Retry and is never retried on its own; retry sends the same Message-ID once', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'notSent' });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    const failed = w.get(s.id);
    assert.equal(failed.state, 'failed');
    assert.ok(failed.problem?.message);
    assert.equal(w.events('send.failed').length, 1);
    await w.clock.advance(2 * 60 * MIN);
    await w.settle();
    assert.equal(w.server.sends().length, 1, 'no automatic retry');
    await rejected(
      () => w.act(w.first, { type: 'retry', submissionId: s.id, revision: 9 }),
      'stateMismatch',
    );
    const retried = (await w.act(w.first, { type: 'retry', submissionId: s.id, revision: 1 }))
      .submission;
    assert.equal(retried.state, 'queued');
    assert.equal(retried.problem, undefined);
    await w.settle();
    await w.clock.advance(1 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent');
    assert.equal(w.server.sends().length, 2);
    assert.equal(w.server.payloads[0].internetId, s.internetId);
    assert.equal(w.server.worst(), 1);
  }));

test('a send-limit pause fails with its until; another pause waits and resumes at until', () =>
  inWorld(async w => {
    w.draft('limit');
    w.server.script.push({ result: 'sendLimit', until: T0 + 6 * 60 * MIN });
    const a = await w.send(w.first, 'limit');
    await w.clock.advance(10 * SEC);
    await w.settle();
    const failed = w.get(a.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.problem?.reasonCode, 'quota.sendLimit');
    assert.equal(failed.problem?.until, T0 + 6 * 60 * MIN);

    w.draft('pause');
    const start = w.clock.now();
    w.server.script.push({ result: 'paused', until: start + 10 * SEC + 30 * SEC });
    const b = await w.send(w.first, 'pause');
    await w.clock.advance(10 * SEC);
    await w.settle();
    const waiting = w.get(b.id);
    assert.equal(waiting.state, 'queued', 'provably not sent, waiting again');
    assert.equal(waiting.notBefore, b.notBefore, 'on the same notBefore');
    await w.clock.advance(29 * SEC);
    await w.settle();
    assert.equal(w.server.sends().length, 2, 'not before until');
    await w.clock.advance(1 * SEC);
    await w.settle();
    assert.equal(w.get(b.id).state, 'sent');
    assert.equal(w.server.worst(), 1);
  }));

test('a pause that outlasts the grace suspends the send instead of sending it late', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'paused', until: T0 + 60 * MIN });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'queued');
    await w.clock.advance(OVERDUE_GRACE_MS + 1 * SEC);
    await w.settle();
    const suspended = w.get(s.id);
    assert.equal(suspended.state, 'suspended');
    assert.equal(suspended.problem?.reasonCode, 'send.overdue');
    await w.clock.advance(2 * 60 * MIN);
    await w.settle();
    assert.equal(w.server.sends().length, 1, 'the paused attempt only');
    assert.equal(w.server.deliveries.size, 0);
    assert.equal(w.events('engine.watchdog').length, 0, 'a paused account does not spin the loop');
  }));

test('admission refused: the send stays waiting, goes at until, and is still under the overdue rule', () =>
  inWorld(async w => {
    w.draft('d1');
    w.draft('d2');
    w.server.setAdmission({ ok: false, cls: 'throttle', reason: 'rate', until: T0 + 40 * SEC });
    const a = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.get(a.id).state, 'queued');
    assert.equal(w.server.sends().length, 0, 'no call while the budget is closed');
    w.server.setAdmission({ ok: true });
    await w.clock.advance(30 * SEC);
    await w.settle();
    assert.equal(w.get(a.id).state, 'sent');

    w.server.setAdmission({ ok: false, cls: 'auth', reason: 'invalid_grant' });
    const b = await w.send(w.first, 'd2');
    await w.clock.advance(OVERDUE_GRACE_MS + 11 * SEC);
    await w.settle();
    assert.equal(w.get(b.id).state, 'suspended');
    assert.equal(w.server.sends().length, 1);
    assert.equal(w.events('engine.watchdog').length, 0);
  }));

test('the clock jumping forward suspends waiting sends (queued and scheduled); jumping back sends nothing early', () =>
  inWorld(async w => {
    w.draft('d1');
    w.draft('d2');
    const undo = await w.send(w.first, 'd1');
    const later = await w.send(w.first, 'd2', { notBefore: T0 + 60 * MIN });
    await w.clock.set(T0 + 3 * 24 * 60 * MIN);
    w.first.outbox.wake();
    await w.settle();
    assert.equal(w.get(undo.id).state, 'suspended');
    assert.equal(w.get(later.id).state, 'suspended');
    assert.equal(w.events('outbox.suspended').length, 2);
    assert.equal(w.server.sends().length, 0, 'never sent late');

    // Send now resumes it; reschedule moves it.
    const now = w.clock.now();
    await w.act(w.first, { type: 'reschedule', submissionId: later.id, notBefore: now + 30 * MIN });
    await w.act(w.first, { type: 'sendNow', submissionId: undo.id });
    await w.settle();
    await w.clock.advance(1 * SEC);
    await w.settle();
    assert.equal(w.get(undo.id).state, 'sent');
    assert.equal(w.get(later.id).state, 'scheduled');

    // Back in time: the scheduled send must not leave before its notBefore on the new clock.
    await w.clock.set(now - 2 * 60 * MIN);
    w.first.outbox.wake();
    await w.settle();
    await w.clock.advance(2 * 60 * MIN + 29 * MIN);
    await w.settle();
    assert.equal(w.get(later.id).state, 'scheduled');
    await w.clock.advance(1 * MIN);
    await w.settle();
    assert.equal(w.get(later.id).state, 'sent');
    assert.equal(w.server.worst(), 1);
  }));

test('sendAnyway only after uncertain: two findSent checks, the prompt, then the same Message-ID and bytes once', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'lost', delivered: false });
    const s = await w.send(w.first, 'd1');
    await rejected(
      () => w.act(w.first, { type: 'sendAnyway', submissionId: s.id }),
      'stateMismatch',
    );
    const mime = w.raw(s.id)!.mime as Uint8Array;
    await w.clock.advance(10 * SEC);
    await w.settle();
    let u = w.get(s.id);
    assert.equal(u.state, 'uncertain');
    assert.equal(u.problem, undefined, 'still checking');
    assert.equal(w.server.calls.filter(c => c.op === 'findSent').length, 1, 'findSent at once');
    await w.clock.advance(60 * SEC);
    await w.settle();
    u = w.get(s.id);
    assert.equal(w.server.calls.filter(c => c.op === 'findSent').length, 2, 'once more after 60 s');
    assert.equal(u.state, 'uncertain');
    assert.equal(
      u.problem?.message,
      'We could not confirm this was sent. Check Sent, or Send anyway.',
    );
    await w.clock.advance(60 * MIN);
    await w.settle();
    assert.equal(w.server.sends().length, 1, 'never replayed on its own');
    assert.equal(w.server.calls.filter(c => c.op === 'findSent').length, 2);

    const out = await w.act(w.first, { type: 'sendAnyway', submissionId: s.id, revision: 1 });
    assert.equal(out.submission.state, 'queued');
    await w.settle();
    await w.clock.advance(1 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent');
    assert.equal(w.server.payloads.length, 1);
    assert.equal(w.server.payloads[0].internetId, s.internetId, 'the same Message-ID');
    assert.deepEqual(w.server.payloads[0].mime, mime, 'the same bytes');
    assert.equal(w.server.worst(), 1);
  }));

test('an unknown outcome that did deliver is found by findSent and settles sent without a second send', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'lost', delivered: true });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    const sent = w.get(s.id);
    assert.equal(sent.state, 'sent');
    assert.equal(w.events('send.uncertain').length, 1);
    assert.equal(w.events('send.reconciled')[0].data.found, true);
    assert.equal(w.server.sends().length, 1);
    assert.equal(w.server.worst(), 1);
    assert.equal(w.raw(s.id)!.remote_message_id, `found-${s.internetId}`);
  }));

test('cancel ends a failed, uncertain or suspended send and unlocks the draft', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'notSent' });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'failed');
    assert.equal(
      (await w.act(w.first, { type: 'cancel', submissionId: s.id })).submission.state,
      'cancelled',
    );
    await w.send(w.first, 'd1');
  }));

test('cancel is refused while the findSent checks are pending: the message that went out is found, never sent twice', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'lost', delivered: true });
    w.server.hideDeliveriesUntil(T0 + 10 * SEC + 30 * SEC);
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'uncertain', 'the first check found nothing yet');
    const sentence = await rejected(
      () => w.act(w.first, { type: 'cancel', submissionId: s.id }),
      'stateMismatch',
    );
    assert.equal(sentence, 'We are still checking whether this message went out.');
    await rejected(() => w.send(w.first, 'd1'), 'stateMismatch');
    assert.equal(w.get(s.id).state, 'uncertain', 'the refusals changed nothing');
    await w.clock.advance(60 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent', 'the pending check found it');
    assert.equal(w.server.sends().length, 1);
    assert.equal(w.server.worst(), 1);
  }));

test('cancel of an uncertain send is allowed at the prompt, once the checks are over', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'lost', delivered: false });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    await w.clock.advance(60 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).problem?.reasonCode, 'send.uncertain', 'the prompt is showing');
    assert.equal(
      (await w.act(w.first, { type: 'cancel', submissionId: s.id })).submission.state,
      'cancelled',
    );
    assert.equal((await w.send(w.first, 'd1')).state, 'queued');
  }));

test('two engines on one store firing at once deliver once', () =>
  inWorld(async w => {
    const second = w.open();
    for (let i = 0; i < 5; i++) w.draft(`d${i}`);
    const subs = [];
    for (const i of [0, 1, 2, 3, 4]) subs.push(await w.send(i % 2 ? second : w.first, `d${i}`));
    await w.clock.advance(10 * SEC);
    await w.settle();
    await w.clock.advance(10 * SEC);
    await w.settle();
    for (const s of subs) assert.equal(w.get(s.id).state, 'sent');
    assert.equal(w.server.sends().length, 5, 'one send call per submission');
    assert.equal(w.server.worst(), 1);
    const fired = w.events('timer.fired').filter(r => r.t === T0 + 10 * SEC);
    assert.ok(fired.length >= 2, 'both engines fired the outbox at the same instant');
  }));

test('the pinned revision: the remote draft is named only when its synced copy is that revision', () =>
  inWorld(async w => {
    w.draft('synced', fields(), {
      remoteDraftId: 'rd-1',
      remoteMessageId: 'rm-1',
      remoteInternetId: '<remote-1@mail.example>',
      syncedRevision: 1,
    });
    w.draft('stale', fields(), {
      revision: 2,
      remoteDraftId: 'rd-2',
      remoteMessageId: 'rm-2',
      remoteInternetId: '<remote-2@mail.example>',
      syncedRevision: 1,
    });
    w.draft('local');
    await w.send(w.first, 'synced');
    await w.send(w.first, 'stale', { revision: 2 });
    await w.send(w.first, 'local');
    await w.clock.advance(10 * SEC);
    await w.settle();
    await w.clock.advance(5 * SEC);
    await w.settle();
    const by = (draft: string) =>
      w.server.payloads.find(p => w.raw(p.submissionId)!.draft_id === draft)!;
    assert.equal(by('synced').baseRemoteMessageId, 'rm-1');
    assert.equal(by('synced').remoteDraftId, 'rd-1');
    assert.equal(
      by('stale').baseRemoteMessageId,
      undefined,
      'a newer local revision sends the pinned MIME',
    );
    assert.equal(by('stale').remoteDraftId, undefined, 'its Message-ID is not the remote copy');
    assert.equal(by('local').baseRemoteMessageId, undefined);
    assert.equal(by('local').remoteDraftId, undefined);
  }));

test('a microsoft account always sends the pinned MIME: no change key, so the id proves nothing', () =>
  inWorld(
    async w => {
      w.draft('synced', fields(), {
        remoteDraftId: 'rd-1',
        remoteMessageId: 'rm-1',
        syncedRevision: 1,
      });
      await w.send(w.first, 'synced');
      await w.clock.advance(10 * SEC);
      await w.settle();
      assert.equal(w.server.payloads[0].baseRemoteMessageId, undefined);
      assert.equal(w.server.payloads[0].baseChangeKey, undefined);
    },
    { provider: 'microsoft' },
  ));

test('Outbox/pending counts waiting and uncertain sends and the next time', () =>
  inWorld(async w => {
    w.draft('d1');
    w.draft('d2');
    w.draft('d3');
    assert.deepEqual(w.first.outbox.service.pending(), {
      scheduledSends: 0,
      reminders: 0,
      uncertain: 0,
    });
    w.server.script.push({ result: 'lost' });
    await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    await w.send(w.first, 'd2', { notBefore: T0 + 60 * MIN });
    const queued = await w.send(w.first, 'd3');
    assert.deepEqual(w.first.outbox.service.pending(), {
      scheduledSends: 2,
      reminders: 0,
      uncertain: 1,
      nextAt: queued.notBefore,
    });
  }));

test('Submission/get answers unknown ids in notFound with the current state token', () =>
  inWorld(async w => {
    w.draft('d1');
    const s = await w.send(w.first, 'd1');
    const out = w.first.outbox.service.get([s.id, 'nope']);
    assert.deepEqual(
      out.list.map(x => x.id),
      [s.id],
    );
    assert.deepEqual(out.notFound, ['nope']);
    assert.equal(out.state.seq, w.first.store.seq());
    const changes = w.first.store.changesSince(0);
    assert.ok(
      changes.status === 'ok' &&
        changes.changes.some(c => c.type === 'Submission' && c.id === s.id),
    );
    assert.ok(
      changes.status === 'ok' && changes.changes.some(c => c.type === 'Draft' && c.id === 'd1'),
    );
  }));

test('two engines that both read a row as queued cannot both commit sending: the second loses', () =>
  inWorld(async w => {
    const second = w.open(false);
    w.draft('d1');
    const s = await w.send(w.first, 'd1');
    const marker = (opId: string) => ({
      opId,
      origin: 'system' as const,
      writes: [
        {
          kind: 'submission' as const,
          op: 'move' as const,
          id: s.id,
          from: ['queued' as const],
          to: 'sending' as const,
          ifNotBefore: s.notBefore,
          set: { attemptAt: s.notBefore },
        },
      ],
    });
    // Both decided from the same read (state queued); each commits on its own connection.
    w.first.store.commit(marker('engine-a'));
    assert.throws(
      () => second.store.commit(marker('engine-b')),
      (e: unknown) => e instanceof SubmissionConflict && e.current === 'sending',
    );
    assert.deepEqual(w.conflicts, ['engine-b']);
  }));

const isSentMove = (to: string) => (input: CommitInput) =>
  input.writes.some(x => x.kind === 'submission' && 'to' in x && x.to === to);

test('findSent finds a message the search index only shows after the first check: sent, never sent twice', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'lost', delivered: true });
    w.server.hideDeliveriesUntil(T0 + 10 * SEC + 30 * SEC);
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'uncertain', 'the first check found nothing yet');
    await w.clock.advance(60 * SEC);
    await w.settle();
    const sent = w.get(s.id);
    assert.equal(sent.state, 'sent', 'the check after 60 s found it');
    assert.equal(sent.problem, undefined);
    assert.equal(w.raw(s.id)!.mime, null);
    await w.clock.advance(60 * MIN);
    await w.settle();
    assert.equal(w.server.sends().length, 1);
    assert.equal(w.server.worst(), 1);
  }));

test('findSent that cannot run counts as a check; a relaunch asks again and settles what was delivered', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'lost', delivered: true });
    w.server.failFindSent(true);
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    await w.clock.advance(60 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'uncertain');
    assert.ok(w.get(s.id).problem?.message, 'the owner is asked, not left waiting');
    w.server.failFindSent(false);
    w.first.kill();
    const next = w.open();
    await w.settle();
    assert.equal(w.get(s.id, next).state, 'sent', 'launch re-checks an unconfirmed send');
    assert.equal(w.server.sends().length, 1);
    assert.equal(w.server.worst(), 1);
  }));

test('a send that was delivered but whose sent commit failed becomes uncertain on the next fire and is found, not re-sent', () =>
  inWorld(async w => {
    w.draft('d1');
    w.faults.push(isSentMove('sent'));
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.server.deliveries.get(s.internetId), 1);
    assert.equal(w.get(s.id).state, 'sending', 'the failed commit left the marker');
    await w.clock.advance(1 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent', 'recovered without a restart: uncertain, then found');
    assert.equal(w.server.sends().length, 1);
    assert.equal(w.server.worst(), 1);
  }));

test('a second engine started during a send marks it uncertain but never sends it; the first still settles it sent', () =>
  inWorld(async w => {
    w.draft('d1');
    const g = gate();
    w.server.script.push({ wait: g.wait });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    assert.equal(w.get(s.id).state, 'sending');
    const second = w.open();
    await w.settle();
    assert.equal(
      w.get(s.id, second).state,
      'uncertain',
      'the start rule cannot know the first is alive',
    );
    assert.equal(w.server.sends().length, 1, 'the second engine sent nothing');
    g.open();
    await w.settle();
    await w.clock.advance(2 * MIN);
    await w.settle();
    assert.equal(w.get(s.id, second).state, 'sent');
    assert.equal(w.server.sends().length, 1);
    assert.equal(w.server.worst(), 1);
  }));

test('the daily send limit from admission fails the send with its until; nothing is attempted or retried on its own', () =>
  inWorld(async w => {
    w.draft('d1');
    const until = T0 + 3 * 60 * MIN;
    w.server.setAdmission({ ok: false, cls: 'send_limit', reason: 'dailyLimitExceeded', until });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    const failed = w.get(s.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.problem?.until, until);
    assert.equal(w.server.calls.length, 0, 'no send, no marker');
    assert.equal(w.raw(s.id)!.attempt_at, null);
    w.server.setAdmission({ ok: true });
    await w.clock.advance(4 * 60 * MIN);
    await w.settle();
    assert.equal(w.server.calls.length, 0, 'never retried on its own');
    await w.act(w.first, { type: 'retry', submissionId: s.id });
    await w.settle();
    await w.clock.advance(1 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent');
    assert.equal(w.server.worst(), 1);
  }));

test('a send that hangs on one account does not stop the overdue rule for the next one', () =>
  inWorld(async w => {
    w.draft('d1');
    w.draft('d2');
    w.server.script.push({ result: 'hang', delivered: false });
    const first = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    const behind = await w.send(w.first, 'd2');
    await w.clock.advance(OVERDUE_GRACE_MS + 30 * SEC);
    await w.settle();
    assert.equal(w.get(first.id).state, 'sending');
    assert.equal(
      w.get(behind.id).state,
      'suspended',
      'it is asked about, not left silently waiting',
    );
    assert.equal(w.server.sends().length, 1);
  }));

test('a revision that was sent is not sent again under a new Message-ID; an edit makes a new send', () =>
  inWorld(async w => {
    w.draft('d1');
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent');
    assert.match(
      await rejected(
        () => w.act(w.first, { type: 'send', draftId: 'd1', revision: 1 }),
        'stateMismatch',
      ),
      /already sent/,
    );
    w.draft('d1', fields({ subject: 'Lunch, second try' }), { revision: 2 });
    const again = (await w.act(w.first, { type: 'send', draftId: 'd1', revision: 2 })).submission;
    assert.notEqual(again.internetId, s.internetId);
    assert.equal(w.server.worst(), 1);
  }));

test('a Bcc address that could smuggle a command is refused at send, with nothing queued', () =>
  inWorld(async w => {
    w.draft('evil', fields({ bcc: [{ address: 'x@mail.example\r\nRCPT TO:<y@evil.example>' }] }));
    w.draft('idn', fields({ bcc: [{ address: 'anna@münchen.example' }] }));
    await rejected(
      () => w.act(w.first, { type: 'send', draftId: 'evil', revision: 1 }),
      'validation',
    );
    const ok = await w.send(w.first, 'idn');
    assert.ok(ok.id);
    const db = w.file.open();
    const row = db.prepare('SELECT error FROM submissions WHERE id = ?').get(ok.id) as {
      error: string;
    };
    db.close();
    assert.deepEqual(JSON.parse(row.error).envelope.rcpt, [
      'jordan@mail.example',
      'anna@xn--mnchen-3ya.example',
    ]);
    const n = w.first.store.read(q =>
      q.get<{ n: number }>('SELECT count(*) AS n FROM submissions'),
    )!.n;
    assert.equal(n, 1);
  }));

test('reschedule refuses a time in the past; a waiting row without its bytes fails with a sentence instead of waiting', () =>
  inWorld(async w => {
    w.draft('d1');
    w.draft('d2');
    const a = await w.send(w.first, 'd1', { notBefore: T0 + 5 * MIN });
    await rejected(
      () => w.act(w.first, { type: 'reschedule', submissionId: a.id, notBefore: T0 - 1 }),
      'validation',
    );
    const b = await w.send(w.first, 'd2');
    const db = w.file.open();
    db.prepare('UPDATE submissions SET mime = NULL WHERE id = ?').run(b.id);
    db.close();
    await w.clock.advance(10 * SEC);
    await w.settle();
    const failed = w.get(b.id);
    assert.equal(failed.state, 'failed');
    assert.ok(failed.problem?.message);
    assert.equal(w.server.calls.length, 0);
  }));

test('drafts.send times out without delivering: the unsent draft with the same id is not a match, so the row ends at the prompt, never sent', () =>
  inWorld(async w => {
    const id = '<unsent-draft@mail.example>';
    w.draft('d1', fields(), {
      remoteDraftId: 'rd-1',
      remoteMessageId: 'rm-1',
      remoteInternetId: id,
      syncedRevision: 1,
    });
    assert.ok(w.server.drafts.has(id), 'the fake holds the unsent draft under the same Message-ID');
    w.server.script.push({ result: 'lost', delivered: false });
    const s = await w.send(w.first, 'd1');
    assert.equal(s.internetId, id);
    await w.clock.advance(10 * SEC);
    await w.settle();
    await w.clock.advance(MIN);
    await w.settle();
    assert.equal(w.server.payloads.length, 0, 'nothing left');
    assert.equal(w.server.sent.size, 0, 'Sent is empty');
    assert.ok(w.server.drafts.has(id), 'the draft is still only a draft');
    const checks = w.server.calls.filter(c => c.op === 'findSent');
    assert.equal(checks.length, 2, 'both checks ran and found nothing');
    const row = w.get(s.id);
    assert.equal(row.state, 'uncertain');
    assert.equal(row.problem?.reasonCode, 'send.uncertain', 'the owner is asked');
    assert.notEqual(row.state, 'sent');
  }));
