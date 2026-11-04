import test from 'node:test';
import assert from 'node:assert/strict';
import { installKillHook, KP } from '../../src/outbox/killpoints';
import { inWorld, MIN, SEC, type World } from './helpers';

/**
 * `during-commit` fires inside the commit of EVERY state move, not only the move to `sent` (time-6 follow-up): a kill
 * there leaves an open SQLite transaction that must roll back whichever move it was. The hook sees a description of the
 * move, `from>to:why`, so the matrix can name the one move it kills. This file proves the point fires for each move the
 * machine makes, in-process (no child), so a call site that is lost fails here at once, not after the matrix's minutes.
 */

async function recorded(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  installKillHook((name, detail) => {
    if (name === KP.DURING_COMMIT) seen.push(detail ?? '(no detail)');
  });
  try {
    await fn();
  } finally {
    installKillHook(undefined);
  }
  return seen;
}

/** Sends draft `id` and lets the clock run until its first `send` call has settled. */
async function sendAndSettle(w: World, id: string) {
  w.draft(id);
  const submission = await w.send(w.first, id);
  await w.clock.advance(10 * SEC);
  await w.settle();
  return submission;
}

test('a send that goes out commits queued>sending then sending>sent, and both fire during-commit', () =>
  inWorld(async w => {
    const seen = await recorded(async () => {
      await sendAndSettle(w, 'd1');
    });
    assert.deepEqual(seen, ['queued>sending:due', 'sending+uncertain>sent:sent']);
  }));

test('an undo fires during-commit for queued>cancelled', () =>
  inWorld(async w => {
    w.draft('d1');
    const s = await w.send(w.first, 'd1');
    const seen = await recorded(async () => {
      await w.act(w.first, { type: 'undo', submissionId: s.id });
    });
    assert.deepEqual(seen, ['queued>cancelled:undo']);
  }));

test('a send whose answer is lost fires for sending>uncertain, each findSent bookkeeping move, Send anyway and Cancel', () =>
  inWorld(async w => {
    w.server.script.push({ result: 'lost', delivered: false });
    let id = '';
    const seen = await recorded(async () => {
      id = (await sendAndSettle(w, 'd1')).id;
      await w.clock.advance(MIN);
      await w.settle();
    });
    assert.equal(w.get(id).state, 'uncertain');
    assert.deepEqual(seen, [
      'queued>sending:due',
      'sending>uncertain:uncertain',
      'uncertain>uncertain:findSent',
      'uncertain>uncertain:findSent',
    ]);
    // A second message, cancelled from the prompt (Send anyway comes last: it would send again at once).
    w.server.script.push({ result: 'lost', delivered: false });
    const other = (await sendAndSettle(w, 'd2')).id;
    await w.clock.advance(MIN);
    await w.settle();
    assert.equal(w.get(other).state, 'uncertain');
    const cancel = await recorded(async () => {
      await w.act(w.first, { type: 'cancel', submissionId: other });
    });
    assert.deepEqual(cancel, ['uncertain>cancelled:cancel']);
    const anyway = await recorded(async () => {
      await w.act(w.first, { type: 'sendAnyway', submissionId: id });
    });
    assert.deepEqual(anyway, ['uncertain>queued:sendAnyway']);
  }));

test('a refused send fires for sending>failed', () =>
  inWorld(async w => {
    w.server.script.push({ result: 'notSent', notSentClass: 'permanent' });
    const seen = await recorded(async () => {
      await sendAndSettle(w, 'd1');
    });
    assert.deepEqual(seen, ['queued>sending:due', 'sending+uncertain>failed:notSent']);
  }));

test('the start rule fires for sending>uncertain at launch', () =>
  inWorld(async w => {
    w.server.script.push({ result: 'hang' });
    const s = await sendAndSettle(w, 'd1');
    assert.equal(w.get(s.id).state, 'sending');
    w.first.kill();
    const seen = await recorded(async () => {
      w.open();
      await w.settle();
    });
    assert.equal(seen[0], 'sending>uncertain:startRule');
  }));
