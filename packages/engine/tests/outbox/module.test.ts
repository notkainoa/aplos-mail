import test from 'node:test';
import assert from 'node:assert/strict';
import type { LogRecord } from '@aplos/contract/log/events';
import { ContractError } from '@aplos/contract/contract-error';
import { fakeClock } from '../../src/clock/module';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { accountWrite, tempDb } from '../store/helpers';
import { countingSend, fields, SEC, T0 } from './helpers';

/** The lane module wired into the real engine: methods dispatch to the outbox, the deadline source fires on the fake clock. */
async function engineWorld() {
  const file = tempDb();
  const clock = fakeClock(T0);
  const records: LogRecord[] = [];
  const log = createLogger({ sink: { write: r => records.push(r) }, salt: 's', clock });
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  store.commit({ opId: 'setup', origin: 'sync', writes: [{ ...accountWrite }] });
  const server = countingSend(clock);
  const engine = await createEngine({ store, clock, log, ports: { send: server.port } });
  const db = file.open();
  db.prepare(
    'INSERT INTO drafts(id, account_id, revision, data, updated_at) VALUES(?, ?, 1, ?, ?)',
  ).run('d1', accountWrite.id, JSON.stringify(fields()), T0);
  db.close();
  return {
    engine,
    clock,
    server,
    session: engine.connect(),
    async cleanup() {
      await engine.close();
      store.close();
      file.cleanup();
    },
  };
}

test('Submission/set, Submission/get and Outbox/pending run through the engine and the clock loop sends once', async () => {
  const w = await engineWorld();
  try {
    const out = await w.session.call('Submission/set', {
      opId: 'op-1',
      action: { type: 'send', draftId: 'd1', revision: 1 },
    });
    assert.equal(out.submission.state, 'queued');
    assert.equal(out.receipt.undoable, true);
    assert.equal((await w.session.call('Outbox/pending', {})).scheduledSends, 1);

    await w.clock.advance(10 * SEC);
    await w.clock.flush();
    const got = await w.session.call('Submission/get', { ids: [out.submission.id] });
    assert.equal(got.list[0].state, 'sent');
    assert.equal(w.server.worst(), 1);
    assert.equal((await w.session.call('Outbox/pending', {})).scheduledSends, 0);
  } finally {
    await w.cleanup();
  }
});

test('the window cannot undo a send that is already sending: stateMismatch, one delivery', async () => {
  const w = await engineWorld();
  try {
    let release!: () => void;
    w.server.script.push({ wait: new Promise<void>(resolve => (release = resolve)) });
    const { submission } = await w.session.call('Submission/set', {
      opId: 'op-1',
      action: { type: 'send', draftId: 'd1', revision: 1 },
    });
    await w.clock.advance(10 * SEC);
    await assert.rejects(
      w.session.call('Submission/set', {
        opId: 'op-2',
        action: { type: 'undo', submissionId: submission.id },
      }),
      (e: unknown) => e instanceof ContractError && e.type === 'stateMismatch',
    );
    release();
    await w.clock.flush();
    assert.equal(
      (await w.session.call('Submission/get', { ids: [submission.id] })).list[0].state,
      'sent',
    );
    assert.equal(w.server.worst(), 1);
  } finally {
    await w.cleanup();
  }
});

test('closing the engine gives a hung send the grace, then leaves its marker for the start rule', async () => {
  const w = await engineWorld();
  try {
    const { submission } = await w.session.call('Submission/set', {
      opId: 'op-1',
      action: { type: 'send', draftId: 'd1', revision: 1 },
    });
    w.server.script.push({ result: 'hang', delivered: false });
    await w.clock.advance(10 * SEC);
    const closing = w.engine.close();
    await w.clock.advance(11 * SEC);
    await closing;
    const row = w.engine.services.store.read(q =>
      q.get<{ state: string }>('SELECT state FROM submissions WHERE id = ?', submission.id),
    );
    assert.equal(row?.state, 'sending', 'the marker stays: the next launch makes it uncertain');
    assert.equal(w.server.sends().length, 1);
  } finally {
    await w.cleanup();
  }
});
