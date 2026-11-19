/**
 * Named crash points for engine tests.
 *
 * Engine code under test calls `checkpoint('before-send-marker')` (and similar) through a hook it is
 * given at construction, e.g. `new SendQueue({ checkpoint: kill.checkpoint })`. In production the
 * hook is a no-op. A test arms one name; when the engine reaches it, `checkpoint` throws
 * `KilledError`, which unwinds the engine exactly where a crash would stop it. The test then builds
 * a fresh engine over the same database and server and checks it recovers. No process is killed.
 */

/** Thrown by a checkpoint that was armed. Engine code must not catch it. */
export class KilledError extends Error {
  readonly name = 'KilledError';
  constructor(readonly point: string) {
    super(`killed at checkpoint '${point}'`);
  }
}

export function isKilled(error: unknown, point?: string): error is KilledError {
  return error instanceof KilledError && (point === undefined || error.point === point);
}

/** The hook shape engine code accepts. */
export type CheckpointHook = (name: string) => void;

export interface ArmOptions {
  /** Let the checkpoint pass this many times after arming, then kill on the next. Default 0 (kill at the first hit). */
  after?: number;
}

export interface KillSwitch {
  /** Kill the engine the next time (or the `after`+1st time) it reaches `name`. One kill per arming. */
  arm(name: string, options?: ArmOptions): void;
  /** Called by engine code. Counts the hit; throws `KilledError` if armed and due. */
  checkpoint(name: string): void;
  /** Cancel armed checkpoints: one name, or all when no name is given. */
  disarm(name?: string): void;
  /** How many times each checkpoint was reached since creation, kills included. */
  readonly hits: Readonly<Record<string, number>>;
  /** Names that actually killed, in order. */
  readonly kills: readonly string[];
}

export function createKillSwitch(): KillSwitch {
  const hits: Record<string, number> = {};
  const kills: string[] = [];
  /** name -> checkpoint passes still allowed before the kill. */
  const armed = new Map<string, number>();

  return {
    arm(name, options = {}) {
      armed.set(name, options.after ?? 0);
    },

    // An arrow function so it can be passed around as a bare hook without losing its closure.
    checkpoint: (name: string): void => {
      hits[name] = (hits[name] ?? 0) + 1;
      const passesLeft = armed.get(name);
      if (passesLeft === undefined) return;
      if (passesLeft > 0) {
        armed.set(name, passesLeft - 1);
        return;
      }
      // One kill per arming, so the restarted engine is not killed again at the same point.
      armed.delete(name);
      kills.push(name);
      throw new KilledError(name);
    },

    disarm(name) {
      if (name === undefined) armed.clear();
      else armed.delete(name);
    },
    hits,
    kills,
  };
}
