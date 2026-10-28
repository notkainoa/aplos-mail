/**
 * Shapes shared by every emulator and the fault kit. Emulators call the fault hook before they
 * answer, and append one content-free entry per request to their log.
 */

/** What an emulator knows about a request before answering it. */
export interface EmulatedRequest {
  /** Emulator name, e.g. 'gmail', 'gcal', 'oauth'. */
  service: string;
  /** Provider method id, e.g. 'gmail.users.threads.get', 'oauth.token'. */
  apiMethod: string;
  httpMethod: string;
  /** Path without query, e.g. '/gmail/v1/users/me/threads/abc'. */
  path: string;
  /** Units or requests this call would cost if accepted. */
  cost: number;
  /** Account the request acts for, when known (from the bearer token). */
  account?: string;
  /** Monotonic request number inside this emulator. */
  seq: number;
}

/**
 * A fault hook's answer: `undefined` lets the emulator answer normally; a `Response` replaces the
 * answer (the call is not charged unless `charge` is set); `drop` simulates a connection reset
 * before any reply (fetch rejects with a TypeError); `dropAfter` lets the provider apply the call
 * and charge it, then loses the reply (the write may have happened); `corrupt` returns a 200
 * whose body is truncated JSON.
 */
export type FaultDecision =
  | undefined
  | { kind: 'respond'; response: Response; charge?: boolean }
  | { kind: 'drop' }
  | { kind: 'dropAfter' }
  | { kind: 'corrupt' };

export interface FaultHook {
  intercept(request: EmulatedRequest, now: number): FaultDecision;
}

/** One request as the emulator saw it. Never holds subjects, bodies, addresses, tokens or queries. */
export interface RequestLogEntry {
  seq: number;
  at: number;
  service: string;
  apiMethod: string;
  httpMethod: string;
  /** Units charged (0 when refused and not charged). */
  units: number;
  status: number;
  /** Google's `error.errors[0].reason` or the OAuth `error`, when refused. */
  reason?: string;
  /** Requests in flight for this account when this one arrived, itself included. */
  inFlight: number;
  /** Set by the fault hook, e.g. 'drop', 'corrupt', 'respond'. */
  fault?: string;
  account?: string;
  /** For batch sub-requests: the batch's own seq. */
  batch?: number;
}
