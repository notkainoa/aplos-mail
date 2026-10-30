import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { NotSentError } from '../../src/ports/base';
import type { SendPort } from '../../src/ports/engine';
import type { Clock } from '../../src/ports/time';

/**
 * The counting fake `SendPort` for the kill-point harness (`killpoint-harness.ts`): the same idea as `countingSend` in
 * `helpers.ts`, but its record is a file, because the engine that sent dies and a different process counts afterwards.
 * Every call is one JSON line in `logPath`. A `deliver` line is a message the "server" accepted: that is what the matrix
 * counts. The file is the server's memory, so a restarted engine (a new process, a new port object) sees what the dead
 * one did.
 *
 * It is also the harness's plug-in shape. A port module exports `createSendPort(env)`; `env.config` is the JSON the
 * scenario passed, `env.clock` the engine's clock. The Gmail emulator's adapter plugs in the same way (see the header of
 * `killpoint-harness.ts`).
 */

export interface FakeConfig {
  /** Where the server's record lives. */
  logPath: string;
  /** Does `send` get the message accepted? `false`: the bytes are lost on the wire and `send` throws (outcome unknown). */
  deliver?: boolean;
  /**
   * What `findSent` says about an accepted message. `finds`: it is in Sent at once. `lags`: the search index shows it only
   * ten minutes after it arrived (past both of the engine's checks). `throws`: the provider is unreachable.
   */
  find?: 'finds' | 'lags' | 'throws';
  /**
   * The search index shows a message this long after it was delivered (engine clock), whatever `find` says. `30_000`
   * with a 60 s recheck: absent at the first check, found at the second.
   */
  indexLagMs?: number;
  /**
   * The server's clock minus the engine's, in ms (`-120_000`: the server is two minutes behind). A delivered message is
   * stamped with the server's clock, and `findSent` only looks at messages stamped at or after `since`.
   */
  serverClockOffsetMs?: number;
  /** The server accepts the bytes but the answer is lost: `send` delivers, then throws (outcome unknown to the engine). */
  answerLost?: boolean;
  /** `send` refuses with a `NotSentError` of this class (provably not sent) and delivers nothing. */
  refuse?: string;
  /**
   * What the k-th `send` call for one Message-ID does (counted in the server's record, so across engine lives), whatever
   * `deliver` and `answerLost` say; later calls follow them. `drop`: lost on the wire, nothing delivered. `lose`: delivered,
   * the answer lost. `ok`: delivered and answered.
   */
  script?: ('drop' | 'lose' | 'ok')[];
}

export interface PortEnv {
  clock: Clock;
  config: Record<string, unknown>;
}

export interface LogLine {
  op: 'send' | 'deliver' | 'findSent';
  internetId: string;
  at: number;
  /** `deliver` only: the arrival time on the server's clock. */
  serverAt?: number;
  /** `findSent` only: what it answered. */
  answer?: 'found' | 'absent' | 'threw';
}

export const INDEX_LAG_MS = 10 * 60_000;

export function readLog(logPath: string): LogLine[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as LogLine);
}

function record(logPath: string, line: LogLine) {
  appendFileSync(logPath, `${JSON.stringify(line)}\n`);
}

/** Deliveries of each Message-ID, as the server accepted them. */
export function deliveryCounts(logPath: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of readLog(logPath))
    if (line.op === 'deliver') counts.set(line.internetId, (counts.get(line.internetId) ?? 0) + 1);
  return counts;
}

export function createSendPort(env: PortEnv): SendPort {
  const config = env.config as unknown as FakeConfig;
  const { logPath, deliver = true, find = 'finds', refuse, answerLost = false } = config;
  const { clock } = env;
  const offset = config.serverClockOffsetMs ?? 0;
  const lag = config.indexLagMs ?? (find === 'lags' ? INDEX_LAG_MS : 0);
  return {
    admission: () => ({ ok: true }),
    async send(_account, payload) {
      const at = clock.now();
      const nth = readLog(logPath).filter(
        l => l.op === 'send' && l.internetId === payload.internetId,
      ).length;
      record(logPath, { op: 'send', internetId: payload.internetId, at });
      const how = config.script?.[nth] ?? (!deliver ? 'drop' : answerLost ? 'lose' : 'ok');
      if (refuse)
        throw new NotSentError({
          class: refuse,
          provider: 'gmail',
          method: 'send',
          reason: refuse,
        });
      if (how === 'drop') throw new Error('socket hang up');
      record(logPath, { op: 'deliver', internetId: payload.internetId, at, serverAt: at + offset });
      if (how === 'lose') throw new Error('connection reset');
      return { acceptedAt: at, remoteMessageId: `r-${payload.submissionId}` };
    },
    async findSent(_account, internetId, since) {
      const at = clock.now();
      const arrived = readLog(logPath).find(l => l.op === 'deliver' && l.internetId === internetId);
      const visible =
        arrived !== undefined &&
        (arrived.serverAt ?? arrived.at) >= since &&
        (lag === 0 || at >= arrived.at + lag);
      const answer = find === 'throws' ? 'threw' : visible ? 'found' : 'absent';
      record(logPath, { op: 'findSent', internetId, at, answer });
      if (answer === 'threw') throw new Error('offline');
      return answer === 'found'
        ? { kind: 'found', remoteMessageId: `found-${internetId}` }
        : { kind: 'absent', checkedAt: at };
    },
  };
}
