import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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
}

export interface PortEnv {
  clock: Clock;
  config: Record<string, unknown>;
}

export interface LogLine {
  op: 'send' | 'deliver' | 'findSent';
  internetId: string;
  at: number;
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
  const { logPath, deliver = true, find = 'finds' } = env.config as unknown as FakeConfig;
  const { clock } = env;
  return {
    admission: () => ({ ok: true }),
    async send(_account, payload) {
      const at = clock.now();
      record(logPath, { op: 'send', internetId: payload.internetId, at });
      if (!deliver) throw new Error('socket hang up');
      record(logPath, { op: 'deliver', internetId: payload.internetId, at });
      return { acceptedAt: at, remoteMessageId: `r-${payload.submissionId}` };
    },
    async findSent(_account, internetId, since) {
      const at = clock.now();
      const arrived = readLog(logPath).find(l => l.op === 'deliver' && l.internetId === internetId);
      const visible = arrived !== undefined && arrived.at >= since && indexed(find, arrived.at, at);
      const answer = find === 'throws' ? 'threw' : visible ? 'found' : 'absent';
      record(logPath, { op: 'findSent', internetId, at, answer });
      if (answer === 'threw') throw new Error('offline');
      return answer === 'found'
        ? { kind: 'found', remoteMessageId: `found-${internetId}` }
        : { kind: 'absent', checkedAt: at };
    },
  };
}

function indexed(find: FakeConfig['find'], arrivedAt: number, now: number) {
  return find === 'lags' ? now >= arrivedAt + INDEX_LAG_MS : true;
}
