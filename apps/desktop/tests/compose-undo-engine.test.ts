/**
 * The composer's Undo against the REAL engine, not the contract fixture (send-safety review, round 2, finding 1). The
 * engine refuses a late Undo with `stateMismatch` (packages/engine/src/outbox/submissions.ts `wrongState`) where the
 * fixture says `conflict`; the composer must say "Already sent." for either, so the next drift between the two is caught
 * here. The send goes to the engine tests' counting fake server: nothing leaves this machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { createEngine, laneExtensions } from '../../../packages/engine/src/index';
import { fakeClock } from '../../../packages/engine/src/clock/module';
import { createLogger } from '../../../packages/engine/src/diag/log';
import { openStore } from '../../../packages/engine/src/store';
import { countingSend, fields, SEC, T0 } from '../../../packages/engine/tests/outbox/helpers';
import { accountWrite } from '../../../packages/engine/tests/store/helpers';
import { openSqlite } from '../src/host/sqlite';
import { composeFromDraft } from '../src/renderer/screens/compose/model/composeState';
import { SEND_COPY } from '../src/renderer/screens/compose/model/sendState';
import { undoRefusalOutcome } from '../src/renderer/screens/compose/model/undoRefusal';
import { refusalOf, type ComposeApi } from '../src/renderer/screens/compose/runtime/composeApi';
import { createComposeSession } from '../src/renderer/screens/compose/runtime/session';

async function engineWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-compose-undo-'));
  const path = join(dir, 'mail.db');
  const clock = fakeClock(T0);
  const log = createLogger({ sink: { write: () => undefined }, salt: 's', clock });
  const store = openStore(openSqlite(path), {
    now: () => clock.now(),
    extensions: laneExtensions(),
  });
  store.commit({ opId: 'setup', origin: 'sync', writes: [{ ...accountWrite }] });
  const server = countingSend(clock);
  const engine = await createEngine({ store, clock, log, ports: { send: server.port } });
  const db = openSqlite(path);
  db.prepare(
    'INSERT INTO drafts(id, account_id, revision, data, updated_at) VALUES(?, ?, 1, ?, ?)',
  ).run('d1', accountWrite.id, JSON.stringify(fields()), T0);
  db.close();
  const session = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    session.call(method, args) as Promise<Output<M>>;
  let n = 0;
  const mint = () => `ui-op-${++n}`;
  const api: ComposeApi = {
    saveDraft: args => call('Draft/set', { opId: args.opId ?? mint(), ...args }),
    destroyDraft: args => call('Draft/destroy', { opId: mint(), ...args }),
    setSubmission: args =>
      call('Submission/set', { opId: args.opId ?? mint(), action: args.action }),
  };
  return {
    clock,
    server,
    call,
    api,
    async cleanup() {
      await engine.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type World = Awaited<ReturnType<typeof engineWorld>>;

/** A composer on draft d1 that pressed Send; its tray still shows the held row it got back. */
async function pressedSend(w: World, notices: string[]) {
  const { list } = await w.call('Draft/get', { ids: ['d1'] });
  const session = createComposeSession(
    {
      api: w.api,
      timers: { now: () => w.clock.now(), setTimeout: () => () => undefined },
      notify: (notice, message) => notices.push(message ? `${notice}: ${message}` : notice),
    },
    composeFromDraft(list[0]!),
  );
  session.dispatch({ type: 'send', now: w.clock.now(), undoSeconds: 10 });
  await session.settled();
  const send = session.getState().send;
  assert.equal(send.kind === 'tracking' && send.row?.state, 'queued');
  return session;
}

test('real engine: Undo while the send is leaving is refused with stateMismatch and says "Already sent."', async () => {
  const w = await engineWorld();
  try {
    let release!: () => void;
    w.server.script.push({ wait: new Promise<void>(resolve => (release = resolve)) });
    const notices: string[] = [];
    const session = await pressedSend(w, notices);
    await w.clock.advance(10 * SEC);
    session.dispatch({ type: 'action', action: 'undo' });
    await session.settled();
    assert.deepEqual(notices, ['alreadySent']);
    assert.equal(SEND_COPY.alreadySent, 'Already sent.');
    release();
    await w.clock.flush();
    assert.equal(w.server.worst(), 1, 'one delivery, to the counting fake');
    session.dispose();
  } finally {
    await w.cleanup();
  }
});

test('real engine: Undo after the send went is "Already sent." too, by its exact ErrorBody', async () => {
  const w = await engineWorld();
  try {
    const notices: string[] = [];
    const session = await pressedSend(w, notices);
    const tracked = session.getState().send;
    assert.ok(tracked.kind === 'tracking');
    await w.clock.advance(10 * SEC);
    await w.clock.flush();
    session.dispatch({ type: 'action', action: 'undo' });
    await session.settled();
    assert.deepEqual(notices, ['alreadySent']);

    // The exact refusal the engine sends, through the same reading the toast stack's Undo uses.
    const undo = { type: 'undo', submissionId: tracked.submissionId } as const;
    const error = await w.call('Submission/set', { opId: 'late-undo', action: undo }).then(
      () => assert.fail('the engine took a late Undo'),
      (e: unknown) => e,
    );
    const refusal = refusalOf(error);
    assert.equal(refusal.type, 'stateMismatch', 'the engine’s shape (the fixture says conflict)');
    assert.deepEqual(undoRefusalOutcome(refusal, tracked.row ?? undefined, w.clock.now()), {
      kind: 'alreadySent',
    });
    assert.deepEqual(
      undoRefusalOutcome(refusal, undefined, w.clock.now()),
      { kind: 'refused', message: refusal.message },
      'with no row to go on, the engine’s own sentence shows (never nothing)',
    );
    session.dispose();
  } finally {
    await w.cleanup();
  }
});
