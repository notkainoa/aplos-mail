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
const inflight = new WeakMap<object, Map<string, Promise<ErrorBody | undefined>>>();

/**
 * Per-account cool-down after a throttle/quota answer: its `resumeAt`/`retryAfterMs` is honoured before the
 * account is asked again — a search inside the pause fails fast locally without a call. A hint-less throttle
 * still buys a short breath (escalating, 10 s), so an Enter loop cannot keep hitting a hot provider.
 */
const pauses = new WeakMap<object, Map<string, number>>();
const COALESCE_LIMIT = 50;
const DEFAULT_PAUSE_MS = 10_000;

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

/** The provider's own "wait until" from whatever it threw, or a short breath for a hint-less throttle. */
function resumeHint(error: unknown, now: number): number | undefined {
  if (error instanceof PausedError) return error.until ?? now + DEFAULT_PAUSE_MS;
  if (error instanceof ProviderError) {
    const e = error.error;
    if (typeof e.resumeAt === 'number') return e.resumeAt;
    if (typeof e.retryAfterMs === 'number') return now + e.retryAfterMs;
    return ['throttle', 'quota', 'daily', 'concurrency'].includes(e.class ?? '')
      ? now + DEFAULT_PAUSE_MS
      : undefined;
  }
  return undefined;
}

const scopeKey = (args: Args) => `${args.accountId ?? '*'}\0${args.query.text}`;

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
  const body = await shareSearch(services, args);
  if (body === undefined) progress('done');
  else {
    progress('error', { problem: problemOf(body) });
    services.views.stopWindows(
      connectionId,
      'search',
      body,
      spec => spec.kind === 'search' && sameSearch(spec, args),
    );
  }
}

/**
 * The coalesced call: the first run for a scope+query holds the key and does the asking; joiners await its
 * outcome (undefined for done, else the error body) and report it to their own connection — the provider sees
 * one search no matter how many callers asked. The key clears when the run settles.
 */
function shareSearch(services: EngineServices, args: Args): Promise<ErrorBody | undefined> {
  const map = inflight.get(services.views) ?? new Map<string, Promise<ErrorBody | undefined>>();
  inflight.set(services.views, map);
  const key = scopeKey(args);
  const running = map.get(key);
  if (running) return running;
  const run = askProvider(services, args).finally(() => map.delete(key));
  map.set(key, run);
  if (map.size > COALESCE_LIMIT) map.delete(map.keys().next().value as string);
  return run;
}

/** The actual provider round: one serial pass over the accounts, honouring each account's cool-down first. */
async function askProvider(services: EngineServices, args: Args): Promise<ErrorBody | undefined> {
  const accounts = args.accountId ? [args.accountId] : services.store.read(q => accountIds(q));
  const pauseMap = pauses.get(services.views) ?? new Map<string, number>();
  pauses.set(services.views, pauseMap);
  const now = () => services.clock.now();
  for (const account of accounts) {
    const until = pauseMap.get(account);
    if (until !== undefined && until > now())
      return {
        type: 'paused',
        message: 'Aplos is waiting before it tries this again.',
        resumeAt: until,
      };
    try {
      await services.accounts.search(account, { text: args.query.text, limit: REMOTE_LIMIT });
      pauseMap.delete(account);
    } catch (error) {
      const resume = resumeHint(error, now());
      if (resume !== undefined) pauseMap.set(account, resume);
      return toContractError(error, 'Search/remote', services.log).body;
    }
  }
  return undefined;
}

/** A search window shows what this run looks for: the same query over the same account scope. */
const sameSearch = (spec: Extract<ViewSpec, { kind: 'search' }>, args: Args) =>
  spec.accountId === args.accountId && JSON.stringify(spec.query) === JSON.stringify(args.query);

const problemOf = (body: ErrorBody) => ({
  reasonCode: body.reasonCode ?? body.type,
  message: body.message,
});
