import type { AccountStatus, ClassifiedError, ReasonCode } from '@aplos/contract';
import type { Admission } from '../ports';

// The one status vocabulary (ARCH 6.4, F1 `AccountStatus`) and its copy keys (`ReasonCode`), from what the governor
// refuses and what a step threw. The engine supplies codes and times, never sentences.

export interface StatusView {
  status: AccountStatus;
  reasonCode?: ReasonCode;
}

export interface RefusalFacts {
  now: number;
  /** `accounts.refresh_expires_at`: at or after it, an auth refusal is the Testing-mode expiry (prov-gov-T08). */
  reconnectBy?: number;
  /** The throttle was a concurrency refusal (the in-flight limit dropped to 1). */
  concurrency?: boolean;
  /** The daily stop is the project's (Gmail `dailyLimitExceeded`), not this account's. */
  project?: boolean;
}

/** A governor refusal as the account's status (prov-gov-T28). */
export function statusOfRefusal(
  adm: Extract<Admission, { ok: false }>,
  facts: RefusalFacts,
): StatusView {
  const reason = adm.reason || 'unknown';
  switch (adm.cls) {
    case 'throttle':
      return {
        status: { state: 'paused', until: adm.until ?? facts.now, class: 'throttle', reason },
        reasonCode: facts.concurrency ? 'rate.concurrency' : 'rate.minute',
      };
    case 'daily':
      return {
        status: { state: 'paused', until: adm.until ?? facts.now, class: 'daily', reason },
        reasonCode: facts.project ? 'quota.project' : 'quota.daily',
      };
    case 'anti_abuse':
      return {
        status: { state: 'paused', until: adm.until ?? facts.now, class: 'anti_abuse', reason },
        reasonCode: 'quota.calendarAbuse',
      };
    case 'auth':
      return authStatus(reason, facts);
    case 'config':
      return {
        status: { state: 'misconfigured', reason },
        reasonCode: reason === 'invalid_client' ? 'config.clientMissing' : 'config.apiDisabled',
      };
    default:
      return { status: { state: 'error', reason }, reasonCode: 'unknown' };
  }
}

function authStatus(reason: string, facts: RefusalFacts): StatusView {
  if (reason === 'admin_policy_enforced') {
    return { status: { state: 'needsAdmin', reason }, reasonCode: 'auth.adminPolicy' };
  }
  const code: ReasonCode =
    reason === 'wrongAccount'
      ? 'auth.wrongAccount'
      : facts.reconnectBy !== undefined && facts.now >= facts.reconnectBy
        ? 'auth.testingModeExpiry'
        : reason === 'invalid_grant'
          ? 'auth.revoked'
          : 'auth.expired';
  return { status: { state: 'needsReauth', reason }, reasonCode: code };
}

/**
 * A step that threw something the governor does not keep as a block. `undefined` means the status does not change
 * (a transient server error backs off quietly). Only `offline` and `paused` resume on their own.
 */
export function statusOfFailure(
  error: ClassifiedError | undefined,
  now: number,
): StatusView | undefined {
  if (!error) return { status: { state: 'error', reason: 'internal' }, reasonCode: 'unknown' };
  switch (error.class) {
    case 'permission':
      return {
        status: { state: 'needsPermission', missingScopes: error.missingScopes ?? [] },
        reasonCode: 'permission.mailModify',
      };
    case 'transient':
      // No HTTP status: the request never reached a server (DNS, reset, timeout before a reply).
      return error.status === undefined
        ? { status: { state: 'offline', since: now }, reasonCode: 'net.offline' }
        : undefined;
    case 'permanent':
      return {
        status: { state: 'error', reason: error.reason || 'unknown' },
        reasonCode: 'unknown',
      };
    default:
      return undefined;
  }
}

export function sameStatus(a: StatusView | undefined, b: StatusView): boolean {
  return (
    a !== undefined &&
    a.reasonCode === b.reasonCode &&
    JSON.stringify(a.status) === JSON.stringify(b.status)
  );
}
