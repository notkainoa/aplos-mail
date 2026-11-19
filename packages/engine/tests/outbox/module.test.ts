import test from 'node:test';
import assert from 'node:assert/strict';
import type { LogRecord } from '@aplos/contract/log/events';
import { ContractError } from '@aplos/contract/contract-error';
import type { Input, Output, EngineMethodName } from '@aplos/contract';
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
  const session = engine.connect();
  /** A typed call through the engine's dispatch, as a window. */
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    session.call(method, args) as Promise<Output<M>>;
  return {
    engine,
    clock,
    server,
    call,
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
    const out = await w.call('Submission/set', {
      opId: 'op-1',
      action: { type: 'send', draftId: 'd1', revision: 1 },
    });
    assert.equal(out.submission.state, 'queued');
    assert.equal(out.receipt.undoable, true);
    assert.equal((await w.call('Outbox/pending', {})).scheduledSends, 1);

    await w.clock.advance(10 * SEC);
    await w.clock.flush();
    const got = await w.call('Submission/get', { ids: [out.submission.id] });
    assert.equal(got.list[0].state, 'sent');
    assert.equal(w.server.worst(), 1);
    assert.equal((await w.call('Outbox/pending', {})).scheduledSends, 0);
  } finally {
    await w.cleanup();
  }
});

test('the window cannot undo a send that is already sending: stateMismatch, one delivery', async () => {
  const w = await engineWorld();
  try {
    let release!: () => void;
    w.server.script.push({ wait: new Promise<void>(resolve => (release = resolve)) });
    const { submission } = await w.call('Submission/set', {
      opId: 'op-1',
      action: { type: 'send', draftId: 'd1', revision: 1 },
    });
    await w.clock.advance(10 * SEC);
    await assert.rejects(
      w.call('Submission/set', {
        opId: 'op-2',
        action: { type: 'undo', submissionId: submission.id },
      }),
      (e: unknown) => e instanceof ContractError && e.type === 'stateMismatch',
    );
    release();
    await w.clock.flush();
    assert.equal((await w.call('Submission/get', { ids: [submission.id] })).list[0].state, 'sent');
    assert.equal(w.server.worst(), 1);
  } finally {
    await w.cleanup();
  }
});

test('closing the engine gives a hung send the grace, then leaves its marker for the start rule', async () => {
  const w = await engineWorld();
  try {
    const { submission } = await w.call('Submission/set', {
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

test('Draft/set, Draft/get, Draft/resolve and Draft/destroy run through the engine; a host without a draft port keeps the draft local', async () => {
  const w = await engineWorld();
  try {
    const made = await w.call('Draft/set', { opId: 'dop-1', fields: fields() });
    assert.equal(made.draft.revision, 1);
    assert.equal(made.draft.sync, 'pending');
    const saved = await w.call('Draft/set', {
      opId: 'dop-2',
      id: made.draft.id,
      baseRevision: 1,
      fields: fields({ subject: 'Changed' }),
    });
    assert.equal(saved.draft.revision, 2);
    await assert.rejects(
      w.call('Draft/set', {
        opId: 'dop-3',
        id: made.draft.id,
        baseRevision: 1,
        fields: fields({ subject: 'Stale' }),
      }),
      (e: unknown) => e instanceof ContractError && e.type === 'stateMismatch',
    );
    await assert.rejects(
      w.call('Draft/resolve', { opId: 'dop-4', id: made.draft.id, choice: 'keepMine' }),
      (e: unknown) => e instanceof ContractError && e.type === 'stateMismatch',
    );
    // No draft port was injected: the upload is refused as unavailable and asked again later, the draft stays.
    await w.clock.advance(6 * SEC);
    await w.clock.flush();
    const got = await w.call('Draft/get', { ids: [made.draft.id, 'nope'] });
    assert.equal(got.list[0].subject, 'Changed');
    assert.deepEqual(got.notFound, ['nope']);
    assert.equal(got.list[0].sync, 'pending');
    await w.call('Draft/destroy', { opId: 'dop-5', id: made.draft.id });
    assert.deepEqual((await w.call('Draft/get', { ids: [made.draft.id] })).notFound, [
      made.draft.id,
    ]);
  } finally {
    await w.cleanup();
  }
});

test('with no send port a new send is refused up front, so no draft is locked for a message that can never leave', async () => {
  const file = tempDb();
  const clock = fakeClock(T0);
  const log = createLogger({ sink: { write: () => undefined }, salt: 's', clock });
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  store.commit({ opId: 'setup', origin: 'sync', writes: [{ ...accountWrite }] });
  const engine = await createEngine({ store, clock, log, ports: {} });
  try {
    const db = file.open();
    db.prepare(
      'INSERT INTO drafts(id, account_id, revision, data, updated_at) VALUES(?, ?, 1, ?, ?)',
    ).run('d1', accountWrite.id, JSON.stringify(fields()), T0);
    db.close();
    const session = engine.connect();
    await assert.rejects(
      session.call('Submission/set', {
        opId: 'op-no-send',
        action: { type: 'send', draftId: 'd1', revision: 1 },
      }) as Promise<unknown>,
      (error: unknown) => error instanceof ContractError && error.body.type === 'unavailable',
    );
    const rows = store.read(q => q.all('SELECT 1 FROM submissions'));
    assert.equal(rows.length, 0, 'nothing was queued');
  } finally {
    await engine.close();
    store.close();
    file.cleanup();
  }
});
