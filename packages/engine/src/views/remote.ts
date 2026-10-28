import type { ErrorBody, Input, Output, ViewSpec } from '@aplos/contract';
import { toContractError } from '../runtime/errors';
import type { EngineServices } from '../runtime/services';
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
  try {
    const accounts = args.accountId ? [args.accountId] : services.store.read(q => accountIds(q));
    for (const account of accounts)
      await services.accounts.search(account, { text: args.query.text, limit: REMOTE_LIMIT });
    progress('done');
  } catch (error) {
    const body = toContractError(error, 'Search/remote', services.log).body;
    progress('error', { problem: problemOf(body) });
    services.views.stopWindows(
      connectionId,
      'search',
      body,
      spec => spec.kind === 'search' && sameSearch(spec, args),
    );
  }
}

/** A search window shows what this run looks for: the same query over the same account scope. */
const sameSearch = (spec: Extract<ViewSpec, { kind: 'search' }>, args: Args) =>
  spec.accountId === args.accountId && JSON.stringify(spec.query) === JSON.stringify(args.query);

const problemOf = (body: ErrorBody) => ({
  reasonCode: body.reasonCode ?? body.type,
  message: body.message,
});
