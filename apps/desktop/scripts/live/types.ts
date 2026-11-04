import type { ProbeState } from './state';

/**
 * Shared types of the live-provider runner (plan 20 section 5.4). A probe is one check against a
 * real provider account; its result is content-free by construction: numbers and fixed names only.
 */

/**
 * R: read-only. M: reversible changes on the agent test account. S-self: also sends, but only to
 * the account's own address. There is deliberately no tier S (sending to others): the runner has
 * no code path for it.
 */
export type Tier = 'R' | 'M' | 'S-self';
export const TIERS: readonly Tier[] = ['R', 'M', 'S-self'];

export type LiveProvider = 'gmail' | 'gcal';

export type ProbeStatus = 'pass' | 'fail' | 'skip';

/** One counted kind of outgoing request: the API method name (never a URL) and the HTTP verb. */
export interface RequestCount {
  method: string;
  httpMethod: string;
  count: number;
}

export interface ProbeResult {
  status: ProbeStatus;
  /** Names come from a fixed list in evidence.ts, so a probe cannot smuggle content in a key. */
  counts: Record<string, number>;
  timingsMs: Record<string, number>;
  /** Fixed class names (rate-limit, auth, ...) mapped to how often each happened. */
  errorClasses: Record<string, number>;
  /** Filled by the runner from the guard, not by the probe. */
  requests: RequestCount[];
  /** Units per clock minute while the probe ran. Filled by the runner from the pacer. */
  unitsPerMinute: number[];
}

export interface ProbeContext {
  /**
   * The only network access a probe has: guarded, paced and already signed in. A probe never sees
   * a token or an address.
   */
  fetch: typeof fetch;
  tier: Tier;
  /** Monotonic milliseconds, for timings. */
  now(): number;
  /**
   * Random id of this run. Tier M calendar probes tag every event they create with it
   * (extendedProperties.private.aplosLiveRun); the guard lets them change or delete only those.
   */
  runId: string;
  /** The `--phase` the operator named for a probe that runs in steps across runs (tier M draft probe); else undefined. */
  phase?: string;
  /** The probe's own small content-free state file, for a probe whose phases run in separate runs (state.ts). */
  state?: ProbeState;
}

/** Plan 40's SmokeProbe interface; tier R probes of plan 20 satisfy it directly. */
export interface SmokeProbe {
  id: string;
  provider: LiveProvider;
  tier: Tier;
  /** True for a probe that runs in steps named by `--phase`. A run given `--phase` runs only these probes. */
  phased?: boolean;
  run(ctx: ProbeContext): Promise<ProbeResult>;
}

export function emptyResult(status: ProbeStatus = 'pass'): ProbeResult {
  return { status, counts: {}, timingsMs: {}, errorClasses: {}, requests: [], unitsPerMinute: [] };
}
