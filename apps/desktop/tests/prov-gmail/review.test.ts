/**
 * Lane tests for the fixes to the adversarial review (prov-gmail-attack.test.ts): the adapter's own pacer measured
 * without the harness's pacing governor, a phone draft edited and then deleted, and a capped resync whose date probe
 * is refused. Synthetic data only (example.test), fake clock, the emulator's fetch only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { BoundGovernor, GovernedRequest, PlannedStep, RequestIo } from '@aplos/engine/ports';
import { GmailAdapter } from '../../src/host/providers/google/adapter';
import { peakWindowUnits, refusals, rig, type Rig } from './harness';

const windowDone = (r: Rig) => () => r.store.states.get('window:inbox')?.phase === 'done';

/** A governor that paces nothing and admits everything at once: only the adapter's own pacer is left. */
class PassThrough implements BoundGovernor {
  constructor(private readonly r: Rig) {}
  run<T>(req: GovernedRequest, fn: (io: RequestIo) => Promise<T>): Promise<T> {
    return fn({
      signal: req.signal ?? new AbortController().signal,
      accessToken: this.r.tokens.access,
    });
  }
  observe(): void {}
  charge(): void {}
  batchSize(): number {
    return 10;
  }
}

/** The window, an open and a search racing, all on a pass-through governor. Returns the emulator's view of it. */
async function race(
  r: Rig,
  adapter: GmailAdapter,
): Promise<{ maxInFlight: number; peak: number; refused: number }> {
  const ctx = () => ({ ...r.ctx(), governor: new PassThrough(r) });
  const window = (async () => {
    for (let i = 0; i < 30 && !windowDone(r)(); i++) {
      const step = adapter
        .plan({
          account: r.account,
          states: [...r.store.states.values()],
          trigger: 'poll',
          env: r.env(),
          memory: r.store.memory,
        })
        .find((s: PlannedStep) => s.scope === 'history' || s.scope === 'window:inbox');
      if (!step) break;
      r.store.commit(
        step,
        await adapter.syncStep(step, r.store.state(step.scope), ctx()),
        r.clock.now(),
      );
    }
  })();
  const known = r.emu.mailbox
    .selectThreads({ labelIds: ['INBOX'] })
    .slice(0, 6)
    .map(th => th.id);
  const users = Promise.all(
    known.map(id =>
      Promise.all([
        adapter.openThread({ remoteThreadId: id }, 'interactive', ctx()),
        adapter.search({ text: 'synthetic', limit: 25 }, ctx()),
      ]),
    ),
  );
  // The unpaced control is refused by Gmail; the race still ends so the emulator's log can be read.
  await Promise.allSettled([window, users]);
  const direct = r.emu.log.filter(e => e.service === 'gmail' && e.batch === undefined);
  return {
    maxInFlight: Math.max(...direct.map(e => e.inFlight)),
    peak: peakWindowUnits(r.emu),
    refused: refusals(r.emu).length,
  };
}

test('prov-gmail pacer: on a governor that paces nothing, the adapter alone keeps one in flight and <= 3,000 units/60 s', async t => {
  const r = await rig({ threads: 600 });
  const paced = await race(r, r.adapter);
  t.diagnostic(
    `paced: max in flight ${paced.maxInFlight}, peak ${paced.peak} units/60 s, ${paced.refused} refusals`,
  );
  assert.ok(windowDone(r)(), 'the window finished');
  assert.equal(paced.refused, 0);
  assert.equal(paced.maxInFlight, 1);
  assert.ok(paced.peak <= 3_000, `${paced.peak} units in 60 s`);

  // Control: the same race with the pacer turned off (as when prov-gov's governor takes over) is unpaced.
  const c = await rig({ threads: 600 });
  const unpaced = await race(c, new GmailAdapter(c.account, { fetch: c.emu.fetch, pace: false }));
  t.diagnostic(
    `unpaced control: max in flight ${unpaced.maxInFlight}, peak ${unpaced.peak} units/60 s, ${unpaced.refused} refusals`,
  );
  assert.ok(
    unpaced.maxInFlight > 1 || unpaced.peak > 3_000,
    'the control shows what the pacer prevents',
  );
});

test('prov-gmail D9 a phone draft edited elsewhere stays one draft with its new message; deleted later, it leaves Drafts', async () => {
  const r = await rig({ threads: 120 });
  await r.drive({ until: windowDone(r), maxSteps: 100 });
  const known = [...r.store.rows.values()][0].facts;
  const historyPass = async () => {
    for (let i = 0; i < 20; i++) {
      await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
      if (!/^pass:/.test(r.store.states.get('history')?.phase ?? '')) return;
    }
  };
  const draft = r.emu.mailbox.createDraftElsewhere({
    to: ['ivo.marsh@mail.example.test'],
    subject: 'Re: synthetic',
    text: 'v1',
    threadId: known.remoteThreadId,
  });
  await historyPass();
  // Gmail replaces a draft's message on every save: same draft id, new message id.
  const updated = r.emu.mailbox.updateDraft(
    draft.draftId,
    Buffer.from('To: ivo.marsh@mail.example.test\r\nSubject: Re: synthetic\r\n\r\nv2'),
  );
  await historyPass();
  const fact = r.store.drafts.get(draft.draftId)!;
  assert.equal(fact.removed, undefined, 'an edit is not a deletion');
  assert.equal(fact.remoteMessageId, updated.message.id);
  assert.ok(
    !r.store.rows.has(updated.message.id) && !r.store.rows.has(draft.messageId),
    'neither version is a thread row',
  );
  r.emu.mailbox.deleteDraft(draft.draftId);
  await historyPass();
  assert.equal(r.store.drafts.get(draft.draftId)?.removed, true);
});

test('prov-gmail D10 a capped resync whose date probe is refused never sweeps (no bound, no removal)', async () => {
  const r = await rig({ threads: 600 });
  await r.drive({ until: windowDone(r), maxSteps: 300 });
  await r.clock.advance(60_000);
  const before = new Set(
    [...r.store.rows.values()]
      .filter(row => row.folders.has('INBOX'))
      .map(row => row.facts.remoteId),
  );
  r.emu.mailbox.expireHistory();
  await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 }); // 404 -> reset
  await r.drive({ trigger: 'reset', scopes: ['history'], maxSteps: 1 }); // P0
  r.governor.pauseAfter = 1; // the list goes out, the date probe meets a pause
  await r.drive({ trigger: 'reset', scopes: ['window:inbox'], maxSteps: 1 });
  assert.equal(
    r.store.states.get('window:inbox')?.oldestLoaded,
    undefined,
    'the probe never answered',
  );
  await r.clock.advance(61_000);
  await r.drive({
    trigger: 'resume',
    until: windowDone(r),
    scopes: ['window:inbox'],
    maxSteps: 10,
  });
  assert.ok(windowDone(r)());
  const windowCommits = r.store.commits.filter(c => c.step.scope === 'window:inbox');
  assert.equal(
    windowCommits.at(-1)!.result.scopeCovered,
    undefined,
    'a capped round without a bound does not sweep',
  );
  for (const id of before)
    assert.ok(r.store.rows.get(id)?.folders.has('INBOX'), 'nothing left the Inbox');
});
