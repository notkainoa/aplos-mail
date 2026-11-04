/**
 * The engine's kill-point matrix (`killpoint.test.ts`, beside this file) against the REAL Gmail send adapter
 * over the Gmail emulator: the same scenarios, the same invariant (one Message-ID never delivered twice, a message never
 * lost silently), and the exact final state of each.
 *
 * The emulator runs in this process behind an HTTP server; each child engine builds the real `GmailAdapter` and
 * `Governor` over its URL (`killpoint-gmail-port.ts`). The server's own SENT count per Message-ID is the delivery count.
 * The emulator's fault rules model the server dropping the bytes (a connection reset before it saw them), accepting them
 * and losing the answer, refusing, and being unreachable; a search index that shows a delivery late is a filter on the
 * server side of the wire.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { UNCERTAIN_COPY } from '../../src/outbox/context';
import { KILL_POINTS } from '../../src/outbox/killpoints';
import {
  assertSendInvariant,
  runKillScenario,
  type KillStep,
  type MoveName,
} from './killpoint-harness';
import { readCalls, startGmailServer, type GmailServer } from './killpoint-gmail-port';

/**
 * How `findSent` fares: `lags` is a search index that shows the delivery late while the SENT label listing (the
 * adapter's fallback) already shows it; `misses` is both of them stale; `throws` is a search that fails.
 */
type Find = 'finds' | 'lags' | 'misses' | 'throws';
const FINDS: readonly Find[] = ['finds', 'lags', 'misses', 'throws'];
const SEND = 'gmail.users.messages.send';
const LIST = 'gmail.users.messages.list';
const MIN = 60_000;
const HOUR = 60 * MIN;

interface Row {
  killAt: KillStep | KillStep[];
  /** The move each `during-commit` step dies in (as in `killpoint.test.ts`). */
  onMove?: MoveName | readonly MoveName[];
  /** Does the server get the bytes when a life calls `send`? `false`: the connection resets before it saw them. */
  deliver: boolean;
  find: Find;
  state: 'sent' | 'uncertain' | 'suspended' | 'failed';
  deliveries: 0 | 1;
  /** `send` calls in total, across every life. */
  sendCalls: 0 | 1;
  downtimeMs?: number;
  reason?: string;
  /** `findSent` calls in total, across every life. */
  findCalls?: number;
  /** The server accepts the bytes and the answer is lost. */
  answerLost?: boolean;
  /** The search shows a delivery this long after it arrived. */
  indexLagMs?: number;
  /** The server's clock minus the engine's. */
  serverClockOffsetMs?: number;
  /** Gmail refuses the send with a 400. */
  refuse?: boolean;
  /** A draft carrying the outgoing Message-ID sits in the mailbox: it must never count as the sent mail. */
  draftTwin?: boolean;
}

const REACHED: Record<Find, Pick<Row, 'state' | 'deliveries'>> = {
  finds: { state: 'sent', deliveries: 1 },
  lags: { state: 'sent', deliveries: 1 },
  misses: { state: 'uncertain', deliveries: 1 },
  throws: { state: 'uncertain', deliveries: 1 },
};
const LOST: Pick<Row, 'state' | 'deliveries'> = { state: 'uncertain', deliveries: 0 };

function rows(): Row[] {
  const out: Row[] = [];
  for (const find of FINDS) {
    out.push({
      killAt: 'before-marker',
      deliver: true,
      find,
      state: 'sent',
      deliveries: 1,
      sendCalls: 1,
    });
    out.push({ killAt: 'after-marker', deliver: true, find, ...LOST, sendCalls: 0 });
    out.push({ killAt: 'after-bytes', deliver: false, find, ...LOST, sendCalls: 1 });
    out.push({ killAt: 'after-bytes', deliver: true, find, ...REACHED[find], sendCalls: 1 });
    out.push({ killAt: 'after-accept', deliver: true, find, ...REACHED[find], sendCalls: 1 });
    // The `sent` commit dies inside its transaction: the restart finds the row `sending` and derives the rest again.
    out.push({
      killAt: 'during-commit',
      onMove: 'sent',
      deliver: true,
      find,
      ...REACHED[find],
      sendCalls: 1,
    });
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
    out.push({ killAt: 'during-find-sent', deliver: false, find, ...LOST, sendCalls: 1 });
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
  // Only a stale listing too keeps the delivery unseen into the third life, where the kill point is reached.
  out.push({
    killAt: ['after-bytes', 'none', 'during-find-sent'],
    deliver: true,
    find: 'misses',
    ...REACHED.misses,
    sendCalls: 1,
  });
  for (const find of ['lags', 'misses'] as const)
    out.push({
      killAt: ['after-marker', 'none', 'during-find-sent'],
      deliver: true,
      find,
      ...LOST,
      sendCalls: 0,
    });
  out.push({
    killAt: ['after-bytes', 'during-commit'],
    onMove: 'sent',
    deliver: true,
    find: 'finds',
    state: 'sent',
    deliveries: 1,
    sendCalls: 1,
  });
  out.push({
    killAt: 'before-marker',
    deliver: true,
    find: 'finds',
    state: 'suspended',
    deliveries: 0,
    sendCalls: 0,
    downtimeMs: 10 * MIN,
    reason: 'send.overdue',
  });
  out.push(...clockRows(), ...checkRows(), ...draftRows());
  return out;
}

/** The wall clock moves while the app is quit between the first `findSent` (absent) and the relaunch. */
function clockRows(): Row[] {
  const base = { killAt: 'quit', find: 'misses', sendCalls: 1, findCalls: 2 } as const;
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

function checkRows(): Row[] {
  const lagging = {
    deliver: true,
    find: 'finds',
    indexLagMs: 30_000,
    downtimeMs: -15_000,
  } as const;
  const reached = { state: 'sent', deliveries: 1, sendCalls: 1 } as const;
  return [
    { ...lagging, killAt: 'after-accept', ...reached, findCalls: 2 },
    { ...lagging, killAt: 'after-bytes', ...reached, findCalls: 2 },
    {
      killAt: 'after-accept',
      deliver: true,
      find: 'finds',
      serverClockOffsetMs: -2 * MIN,
      ...reached,
      findCalls: 1,
    },
    {
      killAt: 'none',
      deliver: true,
      find: 'finds',
      refuse: true,
      state: 'failed',
      deliveries: 0,
      sendCalls: 1,
      findCalls: 0,
      reason: 'send.permanent',
    },
  ];
}

/** `findSent` searches Sent only: a draft with the outgoing Message-ID is never taken for the sent mail. */
function draftRows(): Row[] {
  const twin = { draftTwin: true, find: 'finds', sendCalls: 1 } as const;
  return [
    { ...twin, killAt: 'after-bytes', deliver: false, ...LOST },
    // Two checks in the first life, two more when the app starts again: the draft never answers any of them.
    { ...twin, killAt: 'none', deliver: false, ...LOST, findCalls: 4 },
    { ...twin, killAt: 'after-accept', deliver: true, state: 'sent', deliveries: 1 },
    { ...twin, killAt: 'none', deliver: true, answerLost: true, state: 'sent', deliveries: 1 },
  ];
}

const NOTES: [keyof Row, (r: Row) => string][] = [
  ['answerLost', () => 'answer lost'],
  ['indexLagMs', r => `index lags ${r.indexLagMs! / 1000} s`],
  ['serverClockOffsetMs', r => `server clock ${r.serverClockOffsetMs! / MIN} min`],
  ['refuse', () => 'refused 400'],
  ['draftTwin', () => 'draft twin'],
  ['downtimeMs', r => `down ${r.downtimeMs! / MIN} min`],
];

const label = (r: Row) =>
  [
    `${[r.killAt].flat().join(' > ')} | server ${r.deliver ? 'accepts' : 'drops'} | findSent ${r.find}`,
    ...NOTES.filter(([key]) => r[key]).map(([, text]) => text(r)),
  ].join(' | ');

/** The emulator's fault rules and the server's lag for one row. */
function indexLag(row: Row): number | undefined {
  if (row.indexLagMs) return row.indexLagMs;
  return row.find === 'lags' || row.find === 'misses' ? 10 * MIN : undefined;
}

interface Run {
  deliveries: number;
  sendCalls: number;
  findCalls: number;
  result: Awaited<ReturnType<typeof runKillScenario>>;
}

/**
 * The mode the whole matrix runs in. Gmail's real behaviour is `rewritten` (`messages.send` replaces the Message-ID and
 * keeps the custom `X-Aplos-Send` header), so that is the DEFAULT; `npm run test:engine:gmail-kept` (the old emulator
 * behaviour, still true of other providers that keep the Message-ID) sets `APLOS_KILLPOINT_GMAIL_MODE=kept`.
 */
const MODE: 'kept' | 'rewritten' =
  process.env.APLOS_KILLPOINT_GMAIL_MODE === 'kept' ? 'kept' : 'rewritten';

/**
 * A run that quietly fell back to the other mode would pass for the wrong reason: the emulator must say it ran in `MODE`
 * and, rewritten, no Sent copy may keep the engine's Message-ID (every delivery is then found only by its token).
 */
function assertModeRan(server: GmailServer, internetId: string) {
  assert.equal(server.sendIdentity(), MODE, `the emulator did not run in ${MODE} mode`);
  if (MODE !== 'rewritten') return;
  assert.ok(internetId, 'the row never counted a delivery, so nothing proves the rewrite ran');
  assert.equal(server.sentUnderOwnId(internetId), 0, 'a Sent copy kept the engine Message-ID');
}

async function runRow(row: Row): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-kill-gmail-'));
  const lagMs = indexLag(row);
  const server = await startGmailServer({
    ...(lagMs ? { lagMs } : {}),
    ...(row.find === 'misses' || row.indexLagMs ? { listingLagMs: lagMs } : {}),
    ...(row.serverClockOffsetMs ? { serverClockOffsetMs: row.serverClockOffsetMs } : {}),
    ...(row.draftTwin ? { draftTwin: true } : {}),
    sendIdentity: MODE,
  });
  try {
    if (!row.deliver) server.faults.dropNext({ apiMethod: SEND });
    if (row.answerLost) server.faults.dropAfterNext({ apiMethod: SEND });
    if (row.refuse)
      server.faults.failNext({ apiMethod: SEND }, { status: 400, reason: 'invalidArgument' });
    // A permanent refusal, not a reset: the governor retries a reset read with a back-off sleep on the engine clock, and
    // the harness's `idle()` waits for that sleep while the clock waits for `idle()`. A refusal is thrown at once.
    if (row.find === 'throws')
      server.faults.failNext(
        { apiMethod: LIST },
        { status: 400, reason: 'invalidArgument' },
        { times: 1_000 },
      );
    const logPath = join(dir, 'calls.jsonl');
    let internetId = '';
    const result = await runKillScenario({
      killAt: row.killAt,
      ...(row.onMove ? { onMove: row.onMove } : {}),
      port: {
        module: join(import.meta.dirname, 'killpoint-gmail-port.ts'),
        config: { ...server.config, logPath },
      },
      ...(row.downtimeMs ? { downtimeMs: row.downtimeMs } : {}),
      countDeliveries: id => {
        internetId = id;
        return server.deliveries(id);
      },
    });
    // A bridge or emulator exception is not an injected fault: a row that passed through one passed for the wrong reason.
    assert.deepEqual(
      server.errors,
      [],
      'the server answered an exception that was not an injected drop',
    );
    assertModeRan(server, internetId);
    const calls = readCalls(logPath).filter(c => !internetId || c.internetId === internetId);
    return {
      result,
      deliveries: result.deliveries,
      sendCalls: calls.filter(c => c.op === 'send').length,
      findCalls: calls.filter(c => c.op === 'findSent').length,
    };
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const report: string[] = [];

/** Part `part` (from 0) of `of` of the Gmail matrix: the rows are dealt out by index so the CI shards can spread them. */
export function defineMatrix(part: number, of: number) {
  describe(
    `kill-point matrix on the Gmail adapter over the Gmail emulator (${MODE === 'rewritten' ? 'messages.send rewrites the Message-ID' : 'Message-ID kept'})`,
    { concurrency: 2 },
    () => {
      after(() => console.log(`\nkill-point matrix (gmail)\n${report.sort().join('\n')}`));
      for (const row of rows().filter((_, i) => i % of === part))
        it(label(row), async () => {
          const run = await runRow(row);
          const r = { ...run.result, sendCalls: run.sendCalls, findCalls: run.findCalls };
          report.push(
            `${label(row).padEnd(90)} -> ${r.submission.state.padEnd(9)} deliveries ${r.deliveries}, send calls ${r.sendCalls}, findSent calls ${r.findCalls}`,
          );
          assertSendInvariant(r);
          assert.equal(r.submission.state, row.state, JSON.stringify(r.submission.problem));
          assert.equal(r.deliveries, row.deliveries);
          assert.equal(r.sendCalls, row.sendCalls);
          if (row.findCalls !== undefined) assert.equal(r.findCalls, row.findCalls);
          if (row.state === 'uncertain')
            assert.equal(r.submission.problem?.message, UNCERTAIN_COPY);
          if (row.reason) assert.equal(r.submission.problem?.reasonCode, row.reason);
          assert.equal(r.signals.length, [row.killAt].flat().length);
        });
    },
  );
}

/** The checks that look at the whole matrix, and the test server's own tests. */
export function defineChecks() {
  describe('the Gmail matrix covers the engine matrix', () => {
    it('every kill point is exercised', () => {
      const used = new Set(rows().flatMap(r => [r.killAt].flat()));
      assert.deepEqual(
        [...KILL_POINTS].filter(p => !used.has(p)),
        [],
      );
    });
  });

  describe('the Gmail test server tells an injected drop from a bug', () => {
    const profile = (server: GmailServer) =>
      fetch(`${server.config.baseUrl}/gmail/v1/users/me/profile`, {
        headers: {
          authorization: `Bearer ${server.config.accessToken}`,
          'x-kp-origin': 'https://gmail.googleapis.com',
          'x-kp-now': String(Date.UTC(2026, 9, 28, 9, 0, 10)),
        },
      });

    it('an exception that is not an injected drop answers 500 and is recorded', async () => {
      const server = await startGmailServer();
      try {
        server.breakNext(new Error('bridge exploded'));
        const reply = await profile(server);
        assert.equal(reply.status, 500);
        assert.deepEqual(server.errors, ['Error: bridge exploded']);
      } finally {
        await server.close();
      }
    });

    it('an injected drop resets the connection and records nothing', async () => {
      const server = await startGmailServer();
      try {
        server.faults.dropNext({ apiMethod: 'gmail.users.getProfile' });
        await assert.rejects(profile(server), TypeError);
        assert.deepEqual(server.errors, []);
      } finally {
        await server.close();
      }
    });
  });
}
