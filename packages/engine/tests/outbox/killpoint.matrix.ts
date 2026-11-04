import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { UNCERTAIN_COPY } from '../../src/outbox/context';
import { KILL_POINTS } from '../../src/outbox/killpoints';
import {
  assertSendInvariant,
  MOVES,
  runKillScenario,
  type ActionSpec,
  type KillScenario,
  type KillStep,
  type MoveName,
} from './killpoint-harness';

/**
 * The kill-point matrix (time-6, plan 10 E6 "double send" and "lost mail"): a child engine is SIGKILLed at a named
 * point of one send, a fresh engine restarts on the same store file against the same server record, and the send must
 * end `sent`, `failed` with a reason, `uncertain` with the prompt, or `suspended`, with at most one delivery and at most
 * one `send` call. Four columns decide the row: where the process died, whether the fake server accepted the bytes,
 * and what `findSent` does after the restart (finds it at once, finds it only after the search index catches up
 * (`lags`, past both checks), or throws). A scenario with two kill points dies twice (the second life is killed too).
 *
 * `during-commit` fires inside the commit of every state move, so a row that kills there names the ONE move (`onMove`):
 * the marker, `sent`, an unknown outcome (`uncertain`), the launch's start rule, a `findSent` that found nothing, `failed`,
 * `cancelled` and Send anyway's re-queue. The commit rolls back, the restart derives the state again, nothing is
 * delivered twice and no row is lost. Rows with `actions` have the owner press Undo, Cancel or Send anyway (see
 * `ActionSpec`); what the machine does is stated at each group of rows.
 */

type Find = NonNullable<KillScenario['find']>;
const FINDS: readonly Find[] = ['finds', 'lags', 'throws'];

interface Row {
  killAt: KillStep | KillStep[];
  /** Does the fake accept the bytes when a life calls `send`? */
  deliver: boolean;
  find: Find;
  state: 'sent' | 'uncertain' | 'suspended' | 'failed' | 'cancelled';
  deliveries: 0 | 1 | 2;
  /** `send` calls in total, across every life. */
  sendCalls: 0 | 1 | 2;
  /** The move each `during-commit` step dies in. */
  onMove?: MoveName | readonly MoveName[];
  /** The owner's scripted actions. */
  actions?: readonly ActionSpec[];
  /** What the k-th `send` call does (see `KillScenario.script`). */
  script?: readonly ('drop' | 'lose' | 'ok')[];
  killedRunMs?: number;
  /** The last action of the journal ended like this: `killed` is a call the process died inside. */
  last?: { outcome: 'ok' | 'refused' | 'killed'; sentence?: string };
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
    out.push({
      killAt: 'during-commit',
      onMove: 'sent',
      deliver: true,
      find,
      ...REACHED[find],
      sendCalls: 1,
    });
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
    onMove: 'sent',
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
  out.push(
    ...clockRows(),
    ...checkRows(),
    ...moveRows(),
    ...undoRows(),
    ...cancelRows(),
    ...sendAnywayRows(),
  );
  return out;
}

/**
 * `during-commit` on each move. The commit rolls back whole (SQLite drops the open transaction), so the restart sees the
 * row as it was before the move and derives the rest again: a marker that did not commit leaves a due `queued` row that
 * is sent once; a settle that did not commit leaves a `sending` row that the start rule makes `uncertain`.
 */
function moveRows(): Row[] {
  const one = { killAt: 'during-commit', deliver: true } as const;
  const out: Row[] = [
    // The marker's own commit: nothing has been sent, the row is still `queued`, the restart sends it once.
    { ...one, onMove: 'marker', find: 'finds', state: 'sent', deliveries: 1, sendCalls: 1 },
    // `send` threw: the move to `uncertain` dies, the row stays `sending`, the start rule asks the owner.
    { ...one, onMove: 'uncertain', deliver: false, find: 'finds', ...LOST, sendCalls: 1 },
    // A refusal that proves nothing was sent, but whose `failed` commit died: the restart cannot know, so it asks.
    {
      ...one,
      onMove: 'failed',
      refuse: 'permanent',
      find: 'finds',
      ...LOST,
      sendCalls: 1,
    },
    // A `findSent` that found nothing: its bookkeeping commit dies; the restart checks again.
    { ...one, onMove: 'check-uncertain', deliver: false, find: 'finds', ...LOST, sendCalls: 1 },
    {
      ...one,
      onMove: 'check-uncertain',
      answerLost: true,
      find: 'lags',
      ...REACHED.lags,
      sendCalls: 1,
    },
    // The launch's start rule: `sending` > `uncertain` dies; the next launch applies it again.
    {
      killAt: ['after-marker', 'during-commit'],
      onMove: 'startup-uncertain',
      deliver: true,
      find: 'finds',
      ...LOST,
      sendCalls: 0,
    },
  ];
  for (const find of FINDS) {
    // The answer is lost after the bytes arrived.
    out.push({
      ...one,
      onMove: 'uncertain',
      answerLost: true,
      find,
      ...REACHED[find],
      sendCalls: 1,
    });
    out.push({
      killAt: ['after-bytes', 'during-commit'],
      onMove: 'startup-uncertain',
      deliver: true,
      find,
      ...REACHED[find],
      sendCalls: 1,
    });
  }
  return out;
}

const PROMPT_WAIT_MS = 150_000;
const SENDING = 'This message is sending now.';
const STILL_CHECKING_CANCEL = 'We are still checking whether this message went out.';

/**
 * Undo (the undo window, before the send is due). What the machine does: Undo is a compare-and-set on `queued` or
 * `scheduled`. If it commits first, the row is `cancelled` and the timer's marker loses: nothing is ever sent, also after
 * a restart. If the process dies inside the Undo commit, the commit rolls back and the owner never got an answer, so the
 * message is still queued and goes out once on restart: `sent`, never `cancelled` with a delivery. Once the marker is
 * committed Undo is refused ("sending now") and the send carries on.
 */
function undoRows(): Row[] {
  const undoAt5s: ActionSpec = { do: 'undo', when: 5_000 };
  return [
    {
      killAt: 'quit',
      deliver: true,
      find: 'finds',
      actions: [undoAt5s],
      state: 'cancelled',
      deliveries: 0,
      sendCalls: 0,
      last: { outcome: 'ok' },
    },
    {
      killAt: 'during-commit',
      onMove: 'cancelled',
      deliver: true,
      find: 'finds',
      actions: [undoAt5s],
      state: 'sent',
      deliveries: 1,
      sendCalls: 1,
      last: { outcome: 'killed' },
    },
    // The click lands between the timer reading the row and its marker commit: Undo wins, the marker loses.
    {
      killAt: 'quit',
      deliver: true,
      find: 'finds',
      actions: [{ do: 'undo', when: 'before-marker' }],
      state: 'cancelled',
      deliveries: 0,
      sendCalls: 0,
      last: { outcome: 'ok' },
    },
    // The same race, and the process dies inside the Undo commit: the rolled-back Undo leaves the send to go out once.
    {
      killAt: 'during-commit',
      onMove: 'cancelled',
      deliver: true,
      find: 'finds',
      actions: [{ do: 'undo', when: 'before-marker' }],
      state: 'sent',
      deliveries: 1,
      sendCalls: 1,
      last: { outcome: 'killed' },
    },
    // The click lands with the send in flight: refused, the send finishes (and a kill after the bytes is the usual case).
    {
      killAt: 'after-bytes',
      deliver: true,
      find: 'finds',
      actions: [{ do: 'undo', when: 'after-marker' }],
      state: 'sent',
      deliveries: 1,
      sendCalls: 1,
      last: { outcome: 'refused', sentence: SENDING },
    },
    {
      killAt: 'quit',
      deliver: true,
      find: 'finds',
      actions: [{ do: 'undo', when: 'after-marker' }],
      state: 'sent',
      deliveries: 1,
      sendCalls: 1,
      last: { outcome: 'refused', sentence: SENDING },
    },
  ];
}

/**
 * Cancel of an `uncertain` row. What the machine does: it is accepted only once the checks are over and the prompt is
 * showing (`ifChecksDone` inside the commit), so a `cancelled` row with a delivery behind it is one the owner chose to
 * cancel after being told "Check Sent, or Send anyway". During a check it is refused. If the process dies inside the
 * Cancel commit, the commit rolls back: the row stays `uncertain` with the prompt, and the launch asks again.
 */
function cancelRows(): Row[] {
  const atPrompt: ActionSpec = { do: 'cancel', when: 'asked', life: 1 };
  const base = { find: 'lags', actions: [atPrompt], killedRunMs: PROMPT_WAIT_MS } as const;
  return [
    // Delivered, the answer lost, never found: the owner cancels from the prompt. `cancelled` with a delivery is allowed.
    {
      ...base,
      killAt: ['none', 'none'],
      deliver: true,
      script: ['lose'],
      state: 'cancelled',
      deliveries: 1,
      sendCalls: 1,
      last: { outcome: 'ok' },
    },
    // Nothing arrived: cancelled with no delivery.
    {
      ...base,
      killAt: ['none', 'none'],
      deliver: true,
      script: ['drop'],
      state: 'cancelled',
      deliveries: 0,
      sendCalls: 1,
      last: { outcome: 'ok' },
    },
    // The process dies inside the Cancel commit: the prompt is still there.
    {
      ...base,
      killAt: ['none', 'during-commit'],
      onMove: 'cancelled',
      deliver: true,
      script: ['lose'],
      state: 'uncertain',
      deliveries: 1,
      sendCalls: 1,
      last: { outcome: 'killed' },
    },
    // Cancel with a `findSent` in flight (the checks are not over): refused, and the row asks the owner as usual.
    {
      killAt: 'none',
      deliver: true,
      find: 'finds',
      script: ['drop'],
      actions: [{ do: 'cancel', when: 'during-find-sent' }],
      state: 'uncertain',
      deliveries: 0,
      sendCalls: 1,
      last: { outcome: 'refused', sentence: STILL_CHECKING_CANCEL },
    },
  ];
}

/**
 * Send anyway: the owner's deliberate second delivery after the prompt (same Message-ID, same bytes). Life 0 reaches the
 * prompt and the app is quit; life 1 is the relaunch, where the owner presses Send anyway as soon as the machine accepts
 * it, and dies at the named point of THAT send. The promise is the same as for any send, on top of the one delivery an
 * earlier life may have made: at most ONE new delivery and ONE new `send` call, and the row is never lost. A Send anyway
 * that dies in its own commit rolls back: the prompt is still there and nothing new was sent.
 */
function sendAnywayRows(): Row[] {
  const press: ActionSpec = { do: 'sendAnyway', when: 'asked', life: 1 };
  const base = { deliver: true, actions: [press], killedRunMs: PROMPT_WAIT_MS } as const;
  const rows: Row[] = [];
  // The first send never arrived (`drop`): the second is the only delivery.
  const dropped = { ...base, script: ['drop'], find: 'finds' } as const;
  // The first arrived but nobody could tell (`lose`, and the index never shows it): the second is the owner's duplicate.
  const lost = { ...base, script: ['lose'], find: 'lags' } as const;
  const second = (
    kill: KillStep | readonly KillStep[],
    onMove: MoveName | undefined,
    afterDropped: Pick<Row, 'state' | 'deliveries' | 'sendCalls'>,
    afterLost: Pick<Row, 'state' | 'deliveries' | 'sendCalls'>,
  ) => {
    const killAt = ['none', ...[kill].flat()] as KillStep[];
    const move = onMove ? { onMove } : {};
    rows.push({ ...dropped, ...move, killAt, ...afterDropped });
    rows.push({ ...lost, ...move, killAt, ...afterLost });
  };
  const sent2 = { state: 'sent', deliveries: 1, sendCalls: 2 } as const;
  const gone2 = { state: 'sent', deliveries: 2, sendCalls: 2 } as const;
  const asks1 = { state: 'uncertain', deliveries: 0, sendCalls: 1 } as const;
  const asksLost1 = { state: 'uncertain', deliveries: 1, sendCalls: 1 } as const;
  const asksLost2 = { state: 'uncertain', deliveries: 2, sendCalls: 2 } as const;
  second('none', undefined, sent2, gone2);
  second('before-marker', undefined, sent2, gone2);
  second('during-commit', 'marker', sent2, gone2);
  second('after-marker', undefined, asks1, asksLost1);
  second('after-bytes', undefined, sent2, asksLost2);
  second('after-accept', undefined, sent2, asksLost2);
  second('during-commit', 'sent', sent2, asksLost2);
  // Send anyway's own commit dies: rolled back, the prompt is back, nothing new left.
  second('during-commit', 'queued-after-sendAnyway', asks1, asksLost1);
  return rows;
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
  ['script', r => `sends ${r.script!.join(', ')}`],
  ['actions', r => `owner: ${r.actions!.map(act).join(', ')}`],
  ['downtimeMs', r => `down ${r.downtimeMs! / 60_000} min`],
];

/** `during-commit` steps carry their move: `during-commit@cancelled`. */
function steps(r: Row): string[] {
  const moves = [r.onMove ?? []].flat();
  let k = 0;
  return [r.killAt].flat().map(step => (step === 'during-commit' ? `${step}@${moves[k++]}` : step));
}

const act = (a: ActionSpec) =>
  `${a.do} ${a.when === 'asked' ? 'at the prompt' : `at ${a.when}`}${a.life ? ` (life ${a.life})` : ''}`;

const label = (r: Row) =>
  [
    `${steps(r).join(' > ')} | server ${r.deliver ? 'accepts' : 'drops'} | findSent ${r.find}`,
    ...NOTES.filter(([key]) => r[key]).map(([, text]) => text(r)),
  ].join(' | ');

const report: string[] = [];

/** Part `part` (from 0) of `of` of the matrix: the rows are dealt out by index so the CI shards can spread them. */
export function defineMatrix(part: number, of: number) {
  describe('kill-point matrix', { concurrency: 6 }, () => {
    after(() => console.log(`\nkill-point matrix\n${report.sort().join('\n')}`));
    for (const row of rows().filter((_, i) => i % of === part))
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
          ...(row.onMove ? { onMove: row.onMove } : {}),
          ...(row.actions ? { actions: row.actions } : {}),
          ...(row.script ? { script: row.script } : {}),
          ...(row.killedRunMs ? { killedRunMs: row.killedRunMs } : {}),
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
        if (row.last) {
          const last = r.actions.at(-1);
          assert.equal(last?.outcome, row.last.outcome, JSON.stringify(r.actions));
          if (row.last.sentence) assert.equal(last?.sentence, row.last.sentence);
        }
      });
  });
}

/** The checks that look at the whole matrix and the long-run uncertain case. */
export function defineChecks() {
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

    it('every move that during-commit can name is exercised by the matrix', () => {
      const used = new Set(rows().flatMap(r => [r.onMove ?? []].flat()));
      assert.deepEqual(
        Object.keys(MOVES).filter(m => !used.has(m as MoveName)),
        [],
      );
    });

    it('every kill point is exercised by the matrix', () => {
      const used = new Set(rows().flatMap(r => [r.killAt].flat()));
      assert.deepEqual(
        [...KILL_POINTS].filter(p => !used.has(p)),
        [],
      );
    });
  });
}
