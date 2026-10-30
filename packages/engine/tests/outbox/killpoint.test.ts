import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { UNCERTAIN_COPY } from '../../src/outbox/context';
import { KILL_POINTS } from '../../src/outbox/killpoints';
import {
  assertSendInvariant,
  runKillScenario,
  type KillScenario,
  type KillStep,
} from './killpoint-harness';

/**
 * The kill-point matrix (time-6, plan 10 E6 "double send" and "lost mail"): a child engine is SIGKILLed at a named
 * point of one send, a fresh engine restarts on the same store file against the same server record, and the send must
 * end `sent`, `failed` with a reason, `uncertain` with the prompt, or `suspended`, with at most one delivery and at most
 * one `send` call. Four columns decide the row: where the process died, whether the fake server accepted the bytes,
 * and what `findSent` does after the restart (finds it at once, finds it only after the search index catches up
 * (`lags`, past both checks), or throws). A scenario with two kill points dies twice (the second life is killed too).
 */

type Find = NonNullable<KillScenario['find']>;
const FINDS: readonly Find[] = ['finds', 'lags', 'throws'];

interface Row {
  killAt: KillStep | KillStep[];
  /** Does the fake accept the bytes when a life calls `send`? */
  deliver: boolean;
  find: Find;
  state: 'sent' | 'uncertain' | 'suspended' | 'failed';
  deliveries: 0 | 1;
  /** `send` calls in total, across every life. */
  sendCalls: 0 | 1;
  downtimeMs?: number;
  /** The reason code when the row asks the owner or failed. */
  reason?: string;
  /** `findSent` calls in total, across every life. */
  findCalls?: number;
  /** The server accepts the bytes and the answer is lost (`send` throws). */
  answerLost?: boolean;
  /** The search index shows a delivery this long after it arrived. */
  indexLagMs?: number;
  /** The server's clock minus the engine's. */
  serverClockOffsetMs?: number;
  /** `send` refuses with a `NotSentError` of this class. */
  refuse?: string;
}

/** The expected end of a send that reached the server, by what `findSent` does afterwards. */
const REACHED: Record<Find, Pick<Row, 'state' | 'deliveries'>> = {
  finds: { state: 'sent', deliveries: 1 },
  lags: { state: 'uncertain', deliveries: 1 },
  throws: { state: 'uncertain', deliveries: 1 },
};
/** The end of a send that never reached it: the owner is asked (Send anyway), nothing was delivered. */
const LOST: Pick<Row, 'state' | 'deliveries'> = { state: 'uncertain', deliveries: 0 };

function rows(): Row[] {
  const out: Row[] = [];
  for (const find of FINDS) {
    // 1. Before the marker: nothing happened. The restart finds a due, queued row and sends it, once.
    out.push({
      killAt: 'before-marker',
      deliver: true,
      find,
      state: 'sent',
      deliveries: 1,
      sendCalls: 1,
    });
    // 2. After the marker, before `send`: the row is `sending`. The start rule makes it uncertain, never re-sends it.
    out.push({ killAt: 'after-marker', deliver: true, find, ...LOST, sendCalls: 0 });
    // 3. After the bytes, before the engine heard: the server accepted them, or they were lost on the wire.
    out.push({ killAt: 'after-bytes', deliver: false, find, ...LOST, sendCalls: 1 });
    out.push({ killAt: 'after-bytes', deliver: true, find, ...REACHED[find], sendCalls: 1 });
    // 4. After the acceptance, before the local commit; and inside the commit's transaction (it rolls back).
    out.push({ killAt: 'after-accept', deliver: true, find, ...REACHED[find], sendCalls: 1 });
    out.push({ killAt: 'during-commit', deliver: true, find, ...REACHED[find], sendCalls: 1 });
    // 5. The restart itself dies inside `findSent`; the next restart settles it.
    out.push({
      killAt: ['after-marker', 'during-find-sent'],
      deliver: true,
      find,
      ...LOST,
      sendCalls: 0,
    });
    out.push({
      killAt: ['after-bytes', 'during-find-sent'],
      deliver: true,
      find,
      ...REACHED[find],
      sendCalls: 1,
    });
    // The send fails with an unknown outcome and the same life's `findSent` is the one that dies.
    out.push({ killAt: 'during-find-sent', deliver: false, find, ...LOST, sendCalls: 1 });
    // Chains: the process dies, restarts, sends and dies again.
    out.push({
      killAt: ['before-marker', 'after-marker'],
      deliver: true,
      find,
      ...LOST,
      sendCalls: 0,
    });
    out.push({
      killAt: ['before-marker', 'after-accept'],
      deliver: true,
      find,
      ...REACHED[find],
      sendCalls: 1,
    });
  }
  // The prompt was shown and the app quit; the launch recheck is what dies, and the owner is still asked.
  out.push({
    killAt: ['after-bytes', 'none', 'during-find-sent'],
    deliver: true,
    find: 'lags',
    ...REACHED.lags,
    sendCalls: 1,
  });
  out.push({
    killAt: ['after-marker', 'none', 'during-find-sent'],
    deliver: true,
    find: 'lags',
    ...LOST,
    sendCalls: 0,
  });
  // The restart's own `sent` commit dies mid-transaction: the next restart finds it again.
  out.push({
    killAt: ['after-bytes', 'during-commit'],
    deliver: true,
    find: 'finds',
    state: 'sent',
    deliveries: 1,
    sendCalls: 1,
  });
  // Down for ten minutes after the kill before the marker: too late to send, so the owner is asked.
  out.push({
    killAt: 'before-marker',
    deliver: true,
    find: 'finds',
    state: 'suspended',
    deliveries: 0,
    sendCalls: 0,
    downtimeMs: 10 * 60_000,
    reason: 'send.overdue',
  });
  out.push(...clockRows(), ...checkRows());
  return out;
}

const HOUR = 60 * 60_000;

/**
 * The wall clock moves while the app is quit, between the send's first `findSent` (absent, the second due 60 s later) and
 * the relaunch. Back an hour: the second check must not wait for the old due time, an hour away. Forward a day: it is due
 * at once, runs once, and a message the index has by then is found.
 */
function clockRows(): Row[] {
  const base = { killAt: 'quit', find: 'lags', sendCalls: 1, findCalls: 2 } as const;
  return [
    {
      ...base,
      deliver: false,
      find: 'finds',
      state: 'uncertain',
      deliveries: 0,
      downtimeMs: -HOUR,
    },
    {
      ...base,
      deliver: true,
      answerLost: true,
      state: 'uncertain',
      deliveries: 1,
      downtimeMs: -HOUR,
    },
    {
      ...base,
      deliver: false,
      find: 'finds',
      state: 'uncertain',
      deliveries: 0,
      downtimeMs: 24 * HOUR,
    },
    {
      ...base,
      deliver: true,
      answerLost: true,
      state: 'sent',
      deliveries: 1,
      downtimeMs: 24 * HOUR,
    },
  ];
}

/** What the two checks and the five-minute margin are for, and a send the provider refuses outright. */
function checkRows(): Row[] {
  const lagging = {
    deliver: true,
    find: 'finds',
    indexLagMs: 30_000,
    downtimeMs: -15_000,
  } as const;
  const reached = { state: 'sent', deliveries: 1, sendCalls: 1 } as const;
  return [
    // The index shows the message 30 s after it arrived: absent at the first check, found only by the 60 s recheck.
    { ...lagging, killAt: 'after-accept', ...reached, findCalls: 2 },
    { ...lagging, killAt: 'after-bytes', ...reached, findCalls: 2 },
    // The server's clock is two minutes behind ours: found only because `since` starts five minutes before the attempt.
    {
      killAt: 'after-accept',
      deliver: true,
      find: 'finds',
      serverClockOffsetMs: -2 * 60_000,
      ...reached,
      findCalls: 1,
    },
    // The provider refuses before accepting anything: failed with a reason, not uncertain, and never searched.
    {
      killAt: 'none',
      deliver: false,
      find: 'finds',
      refuse: 'permanent',
      state: 'failed',
      deliveries: 0,
      sendCalls: 1,
      findCalls: 0,
      reason: 'send.permanent',
    },
  ];
}

const NOTES: [keyof Row, (r: Row) => string][] = [
  ['answerLost', () => 'answer lost'],
  ['indexLagMs', r => `index lags ${r.indexLagMs! / 1000} s`],
  ['serverClockOffsetMs', r => `server clock ${r.serverClockOffsetMs! / 60_000} min`],
  ['refuse', r => `refused ${r.refuse}`],
  ['downtimeMs', r => `down ${r.downtimeMs! / 60_000} min`],
];

const label = (r: Row) =>
  [
    `${[r.killAt].flat().join(' > ')} | server ${r.deliver ? 'accepts' : 'drops'} | findSent ${r.find}`,
    ...NOTES.filter(([key]) => r[key]).map(([, text]) => text(r)),
  ].join(' | ');

const report: string[] = [];

describe('kill-point matrix', { concurrency: 6 }, () => {
  after(() => console.log(`\nkill-point matrix\n${report.sort().join('\n')}`));
  for (const row of rows())
    it(label(row), async () => {
      const r = await runKillScenario({
        killAt: row.killAt,
        deliver: row.deliver,
        find: row.find,
        ...(row.downtimeMs ? { downtimeMs: row.downtimeMs } : {}),
        ...(row.answerLost ? { answerLost: true } : {}),
        ...(row.indexLagMs ? { indexLagMs: row.indexLagMs } : {}),
        ...(row.serverClockOffsetMs ? { serverClockOffsetMs: row.serverClockOffsetMs } : {}),
        ...(row.refuse ? { refuse: row.refuse } : {}),
      });
      report.push(
        `${label(row).padEnd(78)} -> ${r.submission.state.padEnd(9)} deliveries ${r.deliveries}, send calls ${r.sendCalls}, findSent calls ${r.findCalls}`,
      );
      assertSendInvariant(r);
      assert.equal(r.submission.state, row.state);
      assert.equal(r.deliveries, row.deliveries);
      assert.equal(r.sendCalls, row.sendCalls);
      if (row.findCalls !== undefined) assert.equal(r.findCalls, row.findCalls);
      if (row.state === 'uncertain') assert.equal(r.submission.problem?.message, UNCERTAIN_COPY);
      if (row.reason) assert.equal(r.submission.problem?.reasonCode, row.reason);
      assert.equal(r.signals.length, [row.killAt].flat().length);
    });
});

describe('after the owner is asked', () => {
  it('an uncertain send is never re-sent by itself, however long the app runs', async () => {
    const r = await runKillScenario({
      killAt: 'after-marker',
      recoverMs: 6 * 60 * 60_000,
    });
    assertSendInvariant(r);
    assert.equal(r.submission.state, 'uncertain');
    assert.equal(r.sendCalls, 0);
    assert.equal(r.deliveries, 0);
  });

  it('every kill point is exercised by the matrix', () => {
    const used = new Set(rows().flatMap(r => [r.killAt].flat()));
    assert.deepEqual(
      [...KILL_POINTS].filter(p => !used.has(p)),
      [],
    );
  });
});
