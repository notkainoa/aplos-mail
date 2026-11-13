import type { ErrorBody, Input, Output, ViewSpec } from '@aplos/contract';
import { toContractError } from '../runtime/errors';
import type { EngineServices } from '../runtime/services';
import { PausedError, ProviderError } from '../ports';
import { accountIds } from './compile';

/*
 * `Search/remote` (views-2): the provider is asked once, on Return. The provider commits what it finds with
 * `origin = 'search'`, which reaches the open `search` windows like any other commit, so the results join the window
 * through the normal re-run. A provider that is paused, offline or not running ends those windows with a last frame
 * carrying `WindowBody.error`, and the run with a `progress` error.
 */

type Args = Input<'Search/remote'>;
type Result = Output<'Search/remote'>;

const REMOTE_LIMIT = 50;
const MEMO_LIMIT = 200;

/** Replies already given, so a repeated `opId` answers the same run and searches once. */
const memos = new WeakMap<object, Map<string, Result>>();

/**
 * The search a connection is running, by account scope and query: a second Return on the same search joins the
 * running run instead of asking the provider again — several Enters (or a re-mounted screen) must never fan out
 * to several Gmail calls, which is what tripped the user-rate limit (Platform 3's finding).
 */
const inflight = new WeakMap<object, Map<string, Promise<Outcome>>>();

/**
 * How a provider round ended: `body` is an error that ends the run; `partialUntil` says some accounts were SKIPPED for a
 * cool-down while the rest answered (the earliest time one of them is asked again), which is not the same as no results.
 */
interface Outcome {
  body?: ErrorBody;
  partialUntil?: number;
}

/**
 * Per-account cool-down after a throttle/quota answer: its `resumeAt`/`retryAfterMs` is honoured before the
 * account is asked again — a search inside the pause fails fast locally without a call. A hint-less throttle
 * still buys a flat 10 s breath, so an Enter loop cannot keep hitting a hot provider. A `PausedError` without
 * `until` (an auth or config block, ended only by the governor) gets the same breath — the next try just hits
 * the governor's refusal again.
 */
const pauses = new WeakMap<object, Map<string, number>>();
const COALESCE_LIMIT = 50;
const DEFAULT_PAUSE_MS = 10_000;
/** The longest a stored pause counts for: a huge or garbage hint, or a clock set back, never pauses an account for good. */
const MAX_PAUSE_MS = 24 * 60 * 60 * 1000;

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export function searchRemote(services: EngineServices, args: Args, connectionId: string): Result {
  const memo = memos.get(services.views) ?? new Map<string, Result>();
  memos.set(services.views, memo);
  const key = `${connectionId}\0${args.opId}`;
  const seen = memo.get(key);
  if (seen) return seen;
  const runId = `r${hex(services.randomBytes(6))}`;
  const { dbEpoch } = services.store;
  const result: Result = {
    runId,
    receipt: {
      opId: args.opId,
      appliedState: { dbEpoch, seq: services.store.seq() },
      undoable: false,
    },
  };
  memo.set(key, result);
  if (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value as string);
  void runSearch(services, args, connectionId, runId);
  return result;
}

/** The body a failed search puts on the run and its windows. An auth failure is NOT a pause: the generic
 * `paused` body would show the "slow down" copy, hiding that the account needs re-signing (Platform's
 * sweep found a Reconnect-state token rendering the throttle line). `auth.reconnect` keeps the
 * progress-frame path honest too — the renderer keys needsReauth off the `auth.` prefix as well as the type. */
function searchErrorBody(error: unknown, services: EngineServices): ErrorBody {
  if (error instanceof PausedError && error.cls === 'auth')
    return {
      type: 'needsReauth',
      reasonCode: 'auth.reconnect',
      message: 'This account needs you to sign in again.',
    };
  if (error instanceof ProviderError && error.error.class === 'auth')
    return {
      type: 'needsReauth',
      reasonCode: 'auth.reconnect',
      message: 'This account needs you to sign in again.',
    };
  if (error instanceof PausedError && error.cls === 'config')
    return {
      type: 'permission',
      reasonCode: 'auth.config',
      message: 'This account needs its permissions reviewed.',
    };
  return toContractError(error, 'Search/remote', services.log).body;
}

/** The provider's own "wait until" from whatever it threw, or a short breath for a hint-less throttle;
 * `synthetic` means we guessed (no provider hint) and the number should not go on the wire. */
function resumeHint(
  error: unknown,
  now: number,
): { until: number; synthetic: boolean } | undefined {
  if (error instanceof PausedError)
    return error.until === undefined
      ? { until: now + DEFAULT_PAUSE_MS, synthetic: true }
      : { until: error.until, synthetic: false };
  if (error instanceof ProviderError) {
    const e = error.error;
    if (typeof e.resumeAt === 'number') return { until: e.resumeAt, synthetic: false };
    if (typeof e.retryAfterMs === 'number')
      return { until: now + e.retryAfterMs, synthetic: false };
    // The governor's classes that pause a budget (ports/governor.ts GOVERNOR_CLASS_POLICY), or a concurrency refusal.
    return ['throttle', 'daily', 'anti_abuse'].includes(e.class ?? '') || e.concurrency
      ? { until: now + DEFAULT_PAUSE_MS, synthetic: true }
      : undefined;
  }
  return undefined;
}

// `null` marks the all-accounts scope ('*' is a valid wire Id) and the WHOLE query keys the run —
// structured fields (from/subject/in:) must not share a leader's results.
const scopeKey = (args: Args) => JSON.stringify([args.accountId ?? null, args.query]);

async function runSearch(
  services: EngineServices,
  args: Args,
  connectionId: string,
  runId: string,
): Promise<void> {
  const progress = (kind: 'step' | 'done' | 'error', extra: object = {}) =>
    services.frames.emit(
      { frame: 'progress', runId, source: 'search', kind, ...extra },
      connectionId,
    );
  progress('step', {
    step: { id: 'search', text: 'Searching your mail provider', state: 'running' },
  });
  let outcome: Outcome;
  try {
    outcome = await shareSearch(services, args);
  } catch {
    // A shared run that rejects rather than resolves an outcome still answers each joiner.
    services.log.event('rpc.failed', { method: 'Search/remote', reason: 'shared-run rejected' });
    outcome = { body: { type: 'internal', message: 'Something went wrong. Try again.' } };
  }
  const { body, partialUntil } = outcome;
  if (body !== undefined) {
    progress('error', { problem: problemOf(body) });
    services.views.stopWindows(
      connectionId,
      'search',
      body,
      spec => spec.kind === 'search' && sameSearch(spec, args),
    );
  } else if (partialUntil !== undefined) {
    // Some accounts were not asked (cooling down) while the rest answered: say so, with when they are asked again. The
    // windows keep what the healthy accounts found; only the run's last frame carries the gap, so an empty list is never
    // read as "nothing matched anywhere".
    progress('error', {
      problem: {
        reasonCode: 'paused',
        message: 'Some accounts are waiting before they are searched again.',
        resumeAt: partialUntil,
      },
    });
  } else progress('done');
}

/**
 * The coalesced call: the first run for a scope+query holds the key and does the asking; joiners await its
 * outcome and report it to their own connection (each gets its own done or error frame) — the provider sees
 * one search no matter how many callers asked. The key clears when the run settles.
 */
function shareSearch(services: EngineServices, args: Args): Promise<Outcome> {
  const map = inflight.get(services.views) ?? new Map<string, Promise<Outcome>>();
  inflight.set(services.views, map);
  const key = scopeKey(args);
  const running = map.get(key);
  if (running) return running;
  // `run` is read only inside the settled callback, which fires after assignment — const is safe.
  const run = askProvider(services, args).finally(() => {
    if (map.get(key) === run) map.delete(key);
  });
  map.set(key, run);
  if (map.size > COALESCE_LIMIT) map.delete(map.keys().next().value as string);
  return run;
}

/** The accounts on the same provider as `account` (a project-wide refusal does not reach another provider's accounts). */
function sameProvider(services: EngineServices, account: string): string[] {
  const ids = services.store.read(q =>
    q.all<{ id: string }>(
      'SELECT id FROM accounts WHERE provider = (SELECT provider FROM accounts WHERE id = ?)',
      account,
    ),
  );
  return ids.length ? ids.map(row => row.id) : [account];
}

/** A stored pause that is still in force: ahead of now, and not further ahead than the clamp (a clock set back). */
const inForce = (until: number | undefined, now: number): until is number =>
  until !== undefined && until > now && until - now <= MAX_PAUSE_MS;

/**
 * The actual provider round: one serial pass over the accounts, skipping any in cool-down — one paused account never
 * starves the rest; a FAILING account still ends the run (first-error-wins, as before). Total: a store failure is an
 * error body, never a rejection nobody handles.
 */
async function askProvider(services: EngineServices, args: Args): Promise<Outcome> {
  try {
    return await askAccounts(services, args);
  } catch (error) {
    return { body: toContractError(error, 'Search/remote', services.log).body };
  }
}

async function askAccounts(services: EngineServices, args: Args): Promise<Outcome> {
  const text = (await import('./remote-text')).remoteText(args.query);
  // Nothing the provider can look for (a place or bookmark alone): the local answer is the whole answer.
  if (!text) return {};
  const accounts = args.accountId ? [args.accountId] : services.store.read(q => accountIds(q));
  const pauseMap = pauses.get(services.views) ?? new Map<string, number>();
  pauses.set(services.views, pauseMap);
  const now = () => services.clock.now();
  let pausedUntil: number | undefined;
  let asked = 0;
  for (const account of accounts) {
    const until = pauseMap.get(account);
    if (inForce(until, now())) {
      pausedUntil = Math.min(pausedUntil ?? until, until);
      continue;
    }
    // An entry that is over, or too far ahead to be believed, is gone.
    if (until !== undefined) pauseMap.delete(account);
    try {
      asked += 1;
      await services.accounts.search(account, { text, limit: REMOTE_LIMIT });
      pauseMap.delete(account);
    } catch (error) {
      const resume = resumeHint(error, now());
      // Stored at most MAX_PAUSE_MS ahead; the same number goes on the wire.
      const until = resume && Math.min(resume.until, now() + MAX_PAUSE_MS);
      if (until !== undefined) {
        // A project-scoped refusal (Gmail's daily limit) cools every account of that provider; another provider's are
        // not its business.
        const project = error instanceof ProviderError && error.scope === 'project';
        for (const a of project ? sameProvider(services, account) : [account])
          pauseMap.set(a, until);
      }
      const body = searchErrorBody(error, services);
      // A synthesized breath (hint-less PausedError) is not put on the wire — the client would trust it.
      if (until === undefined || resume!.synthetic) return { body };
      return { body: { ...body, resumeAt: until } };
    }
  }
  // Nothing was asked: every account is cooling down, the run is `paused`. Some were skipped and others answered: the
  // caller says so, partially.
  if (asked === 0 && pausedUntil !== undefined)
    return {
      body: {
        type: 'paused',
        message: 'Aplos is waiting before it tries this again.',
        resumeAt: pausedUntil,
      },
    };
  return pausedUntil === undefined ? {} : { partialUntil: pausedUntil };
}

/** A search window shows what this run looks for: the same query over the same account scope. */
const sameSearch = (spec: Extract<ViewSpec, { kind: 'search' }>, args: Args) =>
  spec.accountId === args.accountId && JSON.stringify(spec.query) === JSON.stringify(args.query);

const problemOf = (body: ErrorBody) => ({
  reasonCode: body.reasonCode ?? body.type,
  message: body.message,
  ...(body.resumeAt !== undefined ? { resumeAt: body.resumeAt } : {}),
});
