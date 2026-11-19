import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { ContractError } from '@aplos/contract/contract-error';
import { OVERDUE_GRACE_MS } from '@aplos/contract/rules';
import { SubmissionConflict } from '../../src/outbox/module';
import type { CommitInput } from '../../src/store';
import { fields, gate, inWorld, MIN, SEC, T0, type Instance, type World } from './helpers';

/** The Opus review of the send state machine (time-2): one test per defect, and one per mutation it found uncaught. */

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

const writesOf = (input: CommitInput) =>
  input.writes.filter(x => x.kind === 'submission') as unknown as {
    op: string;
    to?: string;
  }[];
const isMove = (to: string) => (input: CommitInput) =>
  writesOf(input).some(x => x.op === 'move' && x.to === to);
const isCreate = (input: CommitInput) => writesOf(input).some(x => x.op === 'create');

/** Races that did not race: reported by the hook and failed by `afterEach`, whichever call the hook ran inside. */
const raceErrors: string[] = [];
afterEach(() => assert.deepEqual(raceErrors.splice(0), [], 'every raceOnce raced'));

/**
 * A racing call must have done its work inside the hook: a promise still pending there awaits something first (a blob
 * read, say) and lands after the commit it was meant to beat, so it fails the test. Its outcome is the test's to check
 * through the store; a rejection is handled here, never left floating.
 */
function settledNow(out: unknown) {
  if (!(out instanceof Promise)) return;
  out.catch(() => {});
  if (inspect(out).includes('<pending>')) {
    raceErrors.push('the racing call was still pending inside the hook: it did not race');
    throw new Error(raceErrors.at(-1));
  }
}

/** Runs `before` once, right before the first commit `match` accepts (the other engine wins the race). */
function raceOnce(w: World, match: (input: CommitInput) => boolean, before: () => unknown) {
  let done = false;
  w.faults.push(input => {
    if (!done && match(input)) {
      done = true;
      settledNow(before());
    }
    return false;
  });
}

const recheck = (id: string, checkAt: number): CommitInput => ({
  opId: `recheck-${checkAt}`,
  origin: 'system',
  writes: [
    {
      kind: 'submission',
      op: 'move',
      id,
      from: ['uncertain'],
      to: 'uncertain',
      set: { checkCount: 0, checkAt },
    },
  ],
});

// ---------------------------------------------------------------- 1. sendAnyway needs finished checks

test('sendAnyway is refused while the findSent checks are pending, so a lagging index cannot cause a second delivery', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'lost', delivered: true });
    w.server.hideDeliveriesUntil(T0 + 10 * SEC + 30 * SEC);
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    const pending = w.get(s.id);
    assert.equal(pending.state, 'uncertain');
    assert.equal(pending.problem, undefined, 'still checking: no prompt yet');
    await rejected(
      () => w.act(w.first, { type: 'sendAnyway', submissionId: s.id }),
      'stateMismatch',
    );
    await w.clock.advance(1 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'uncertain', 'the refusal changed nothing');
    await w.clock.advance(60 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent', 'the second check found it');
    assert.equal(w.server.sends().length, 1);
    assert.equal(w.server.worst(), 1);
  }));

test('sendAnyway also loses inside the commit when a check was scheduled after the owner looked', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'lost', delivered: false });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    await w.clock.advance(60 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).problem?.reasonCode, 'send.uncertain', 'the prompt is showing');
    const second = w.open(false);
    // Between the act's read and its commit, another engine starts a new round of checks.
    raceOnce(w, isMove('queued'), () =>
      second.store.commit(recheck(s.id, w.clock.now() + 1 * MIN)),
    );
    await rejected(
      () => w.act(w.first, { type: 'sendAnyway', submissionId: s.id }),
      'stateMismatch',
    );
    assert.equal(w.get(s.id).state, 'uncertain');
    assert.equal(w.server.sends().length, 1);
    // The same guard directly: a move that demands finished checks cannot pass over a pending one.
    assert.throws(
      () =>
        w.first.store.commit({
          opId: 'direct',
          origin: 'local',
          writes: [
            {
              kind: 'submission',
              op: 'move',
              id: s.id,
              from: ['uncertain'],
              to: 'queued',
              ifChecksDone: true,
            },
          ],
        }),
      (e: unknown) => e instanceof SubmissionConflict && e.current === 'uncertain',
    );
  }));

// ---------------------------------------------------------------- 4. one `now` for the whole fire

test('a recovered row is checked before any other send on its account even when the clock moves during the fire', () =>
  inWorld(async w => {
    w.draft('d1');
    w.draft('d2');
    w.server.script.push({ result: 'hang', delivered: false });
    const lost = await w.send(w.first, 'd1');
    await w.clock.advance(1 * SEC);
    const other = await w.send(w.first, 'd2');
    await w.clock.advance(9 * SEC);
    await w.settle();
    assert.equal(w.get(lost.id).state, 'sending');
    assert.equal(w.get(other.id).state, 'queued', 'due a second later, behind the hung send');
    w.first.kill();
    await w.clock.advance(20 * SEC);
    // A real clock: every read is a little later than the one before.
    w.skew.perCall = 1;
    const next = w.open(false);
    next.loop.start();
    await w.settle();
    await w.clock.advance(2 * SEC);
    await w.settle();
    const calls = w.server.calls.map(
      c => `${c.op}:${c.internetId === lost.internetId ? 'lost' : 'other'}`,
    );
    assert.deepEqual(calls.slice(0, 3), ['send:lost', 'findSent:lost', 'send:other']);
    assert.equal(w.get(other.id, next).state, 'sent');
    assert.equal(w.server.deliveries.get(lost.internetId), undefined);
  }));

// ---------------------------------------------------------------- 5. mutations the review found uncaught

test('the sending marker is durable, with its attempt time, before send() is called', () =>
  inWorld(async w => {
    w.draft('d1');
    let seen: { state: unknown; attempt_at: unknown } | undefined;
    w.server.script.push({
      observe: p => {
        const row = w.raw(p.submissionId) as { state: unknown; attempt_at: unknown };
        seen = { state: row.state, attempt_at: row.attempt_at };
      },
    });
    await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.deepEqual(seen, { state: 'sending', attempt_at: T0 + 10 * SEC });
  }));

test('a reschedule that lands between the timer reading a scheduled row and its marker wins: nothing leaves early', () =>
  inWorld(async w => {
    w.draft('d1');
    const second = w.open(false);
    const s = await w.send(w.first, 'd1', { notBefore: T0 + 2 * MIN });
    assert.equal(s.state, 'scheduled');
    raceOnce(w, isMove('sending'), () =>
      w.act(second, { type: 'reschedule', submissionId: s.id, notBefore: T0 + 60 * MIN }),
    );
    await w.clock.advance(2 * MIN);
    await w.settle();
    assert.equal(w.server.sends().length, 0, 'the old time no longer applies');
    const row = w.get(s.id);
    assert.equal(row.state, 'scheduled');
    assert.equal(row.notBefore, T0 + 60 * MIN);
    assert.equal(w.conflicts.length, 1, 'the marker lost its compare-and-set');
    await w.clock.advance(58 * MIN);
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent');
    assert.equal(w.server.worst(), 1);
  }));

test('two engines sending the same draft revision at once create one submission', () =>
  inWorld(async w => {
    w.draft('d1');
    const second = w.open(false);
    raceOnce(w, isCreate, () => w.act(second, { type: 'send', draftId: 'd1', revision: 1 }));
    await rejected(
      () => w.act(w.first, { type: 'send', draftId: 'd1', revision: 1 }),
      'stateMismatch',
    );
    const n = w.first.store.read(q =>
      q.get<{ n: number }>('SELECT count(*) AS n FROM submissions'),
    );
    assert.equal(n?.n, 1, 'the loser of the race created nothing');
  }));

test('a draft edited elsewhere right before the send commits: the commit compares the revision, no row', () =>
  inWorld(async w => {
    w.draft('d1');
    raceOnce(w, isCreate, () => w.draft('d1', fields({ subject: 'Edited' }), { revision: 2 }));
    const sentence = await rejected(
      () => w.act(w.first, { type: 'send', draftId: 'd1', revision: 1 }),
      'stateMismatch',
    );
    assert.equal(sentence, 'This draft changed in another window. Reopen it before sending.');
    const n = w.first.store.read(q =>
      q.get<{ n: number }>('SELECT count(*) AS n FROM submissions'),
    );
    assert.equal(n?.n, 0, 'no row');
  }));

test('raceOnce fails a race whose call is still pending inside the hook', () =>
  inWorld(async w => {
    w.draft('d1');
    raceOnce(w, isCreate, () => new Promise(() => {}));
    await assert.rejects(() => w.act(w.first, { type: 'send', draftId: 'd1', revision: 1 }));
    assert.equal(raceErrors.splice(0).length, 1, 'the race was reported');
  }));

/** An attempt that outlives its engine, a newer attempt by another engine, then the old one settles. */
async function lateSettle(w: World, late: { result?: 'ok' | 'notSent' }, newer = true) {
  w.draft('d1');
  const old = gate();
  w.server.script.push({ wait: old.wait, ...late, delivered: late.result !== 'notSent' });
  const s = await w.send(w.first, 'd1');
  await w.clock.advance(10 * SEC);
  const attempt1 = (w.raw(s.id) as { attempt_at: number }).attempt_at;
  assert.equal(w.get(s.id).state, 'sending');
  w.first.kill();
  const second: Instance = w.open();
  await w.settle();
  assert.equal(w.get(s.id, second).state, 'uncertain', 'the other engine recovered the row');
  if (newer) {
    await w.clock.advance(60 * SEC);
    await w.settle();
    const hold = gate();
    w.server.script.push({ wait: hold.wait, delivered: false });
    await w.act(second, { type: 'sendAnyway', submissionId: s.id });
    await w.settle();
    await w.clock.advance(1 * SEC);
    await w.settle();
    assert.equal(w.get(s.id, second).state, 'sending', 'the newer attempt is in flight');
    const attempt2 = (w.raw(s.id) as { attempt_at: number }).attempt_at;
    assert.ok(attempt2 > attempt1);
    return { s, second, old, hold, attempt2 };
  }
  return { s, second, old, hold: undefined, attempt2: attempt1 };
}

test('a late settle of an older attempt cannot overwrite a newer attempt', () =>
  inWorld(async w => {
    const { s, old, attempt2 } = await lateSettle(w, { result: 'ok' });
    old.open();
    for (let i = 0; i < 5; i++) await w.clock.flush();
    const row = w.raw(s.id) as { state: string; attempt_at: number; mime: unknown };
    assert.equal(row.state, 'sending', 'the older attempt lost its compare-and-set');
    assert.equal(row.attempt_at, attempt2);
    assert.ok(row.mime, 'the bytes are kept while the newer attempt runs');
  }));

test('NotSentError of the attempt in flight settles failed even after the start rule made the row uncertain', () =>
  inWorld(async w => {
    const { s, second, old } = await lateSettle(w, { result: 'notSent' }, false);
    old.open();
    for (let i = 0; i < 5; i++) await w.clock.flush();
    const failed = w.get(s.id, second);
    assert.equal(failed.state, 'failed', 'provably not sent: Retry, not a prompt about Sent');
    assert.ok(failed.problem?.message);
    assert.equal(w.server.deliveries.size, 0);
  }));

test('a send whose slow admission pushed it past the grace is suspended at the marker, never sent late', () =>
  inWorld(async w => {
    w.draft('d1');
    // The fire saw the row on time; by the time the job runs it is later than the grace allows.
    w.server.onAdmission(() => {
      w.skew.jump = OVERDUE_GRACE_MS + 1 * MIN;
      w.server.onAdmission(undefined);
    });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.server.sends().length, 0, 'never sent late');
    const row = w.get(s.id);
    assert.equal(row.state, 'suspended');
    assert.equal(row.problem?.reasonCode, 'send.overdue');
  }));

test('Bcc is in the envelope only: the stored and the sent MIME have no Bcc header and no Bcc address', () =>
  inWorld(async w => {
    w.draft('d1', fields({ bcc: [{ address: 'quiet@hidden.example', name: 'Quiet' }] }));
    const s = await w.send(w.first, 'd1');
    const stored = new TextDecoder().decode(w.raw(s.id)!.mime as Uint8Array);
    await w.clock.advance(10 * SEC);
    await w.settle();
    const sent = w.server.payloads[0];
    for (const text of [stored, new TextDecoder().decode(sent.mime)]) {
      assert.ok(!/^bcc:/im.test(text), 'no Bcc header');
      assert.ok(!text.includes('quiet@hidden.example'), 'the address is not in the bytes');
    }
    assert.deepEqual(sent.envelope.rcpt, ['jordan@mail.example', 'quiet@hidden.example']);
  }));

// ---------------------------------------------------------------- 7. a failed-without-bytes row

test('a row that lost its bytes says Cancel first: Retry is refused with that sentence, Cancel then a new send works once', () =>
  inWorld(async w => {
    w.draft('d1');
    const s = await w.send(w.first, 'd1');
    const db = w.file.open();
    db.prepare('UPDATE submissions SET mime = NULL WHERE id = ?').run(s.id);
    db.close();
    await w.clock.advance(10 * SEC);
    await w.settle();
    const failed = w.get(s.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.problem?.reasonCode, 'send.noBytes');
    assert.match(failed.problem?.message ?? '', /Cancel/);
    assert.match(
      await rejected(() => w.act(w.first, { type: 'retry', submissionId: s.id }), 'stateMismatch'),
      /Cancel/,
    );
    await rejected(
      () => w.act(w.first, { type: 'send', draftId: 'd1', revision: 1 }),
      'stateMismatch',
    );
    await w.act(w.first, { type: 'cancel', submissionId: s.id });
    const again = await w.send(w.first, 'd1');
    assert.notEqual(
      again.internetId,
      s.internetId,
      'nothing was sent, so a new Message-ID is fine',
    );
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.get(again.id).state, 'sent');
    assert.equal(w.server.sends().length, 1);
    assert.equal(w.server.worst(), 1);
  }));
