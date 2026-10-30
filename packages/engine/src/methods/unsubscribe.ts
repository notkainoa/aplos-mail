import { ContractError } from '@aplos/contract/contract-error';
import type { Output } from '@aplos/contract';
import type { ListHeaders, UnsubscribeKind, UnsubscribePort } from '../ports';
import { isAbsent } from '../runtime/engine';
import { FLAG } from '../store/commit';
import { listHeaders } from '../store/ingest';
import type { StoreReader } from '../store/port';
import { threadRowId } from '../views/compile';
import type { AreaHandlers, MethodContext } from './types';

/**
 * The `unsubscribe` area, owned by lane `prov-gmail-write` (plan 20 PV4, Decision 5). The engine finds the thread's
 * newest inbound message that carries List-Unsubscribe and the account it arrived at; the host executor
 * (`apps/desktop/src/host/providers/google/unsubscribe.ts`) plans and performs the one-click POST, the mailto or the
 * page link, because it needs Node networking. Nothing here opens a page or sends mail.
 */

interface Target {
  from: string;
  headers: ListHeaders;
}

const GONE = 'This conversation is no longer available.';
const NO_WAY = 'This sender does not offer a way to unsubscribe. You can block them instead.';
const NOT_YET = 'Unsubscribing is not available in this version of Aplos yet.';

/** Contract outcomes; `unsure`, `failed` and `compose` ride the open enum until the contract names them. */
const OUTCOME: Record<UnsubscribeKind, Output<'Unsubscribe/run'>['outcome']> = {
  done: 'done',
  open: 'openLink',
  compose: 'compose',
  unsure: 'unsure',
  failed: 'failed',
  none: 'unavailable',
};

const MAX_URL = 2_000;

type RunOutput = Output<'Unsubscribe/run'>;

/**
 * Receipts for `Unsubscribe/run`, keyed by `opId` and thread: a retried call (same `opId`) gets the first call's outcome
 * and never reaches the executor, so it cannot POST twice. The promise is stored at once, so a concurrent retry joins
 * the call in flight. Bounded by count and age; a call that rejects (cancelled) leaves no receipt.
 *
 * The receipt is process-local: it is lost on restart and not shared between processes. `common.ts` promises that a
 * replayed `opId` never applies twice; for this method that holds only within this process (and the port also gets the
 * `opId`, so a host that keeps its own record can dedupe too) until a store receipt exists. That store receipt is a
 * known gap, not written here.
 */
export interface Receipts {
  once(
    opId: string | undefined,
    threadId: string,
    make: () => Promise<RunOutput>,
  ): Promise<RunOutput>;
}

interface Receipt {
  at: number;
  result: Promise<RunOutput>;
}

export const RECEIPT_LIMITS = Object.freeze({ maxEntries: 200, ttlMs: 10 * 60_000 });

export function createReceipts(
  now: () => number = Date.now,
  limits: { maxEntries: number; ttlMs: number } = RECEIPT_LIMITS,
): Receipts {
  const entries = new Map<string, Receipt>();
  // Insertion order is age order, so expiry and eviction only look at the front.
  function trim(): void {
    for (const [key, receipt] of entries) {
      if (entries.size <= limits.maxEntries && now() - receipt.at <= limits.ttlMs) return;
      entries.delete(key);
    }
  }
  return {
    once(opId, threadId, make) {
      if (!opId) return make();
      const key = JSON.stringify([opId, threadId]);
      trim();
      const known = entries.get(key);
      if (known) return known.result;
      const receipt: Receipt = { at: now(), result: make() };
      entries.set(key, receipt);
      trim();
      receipt.result.catch(() => {
        if (entries.get(key) === receipt) entries.delete(key);
      });
      return receipt.result;
    },
  };
}

/** One receipt book per executor, so nothing leaks between hosts or tests. */
const books = new WeakMap<UnsubscribePort, Receipts>();

function receiptsOf(executor: UnsubscribePort): Receipts {
  const known = books.get(executor);
  if (known) return known;
  const made = createReceipts();
  books.set(executor, made);
  return made;
}

function readTarget(q: StoreReader, threadId: string): Target | undefined {
  const rowid = threadRowId(q, threadId);
  if (rowid === undefined) throw new ContractError({ type: 'notFound', message: GONE });
  const m = q.get<{ account_id: string; hdr: number; list_unsub: string; address: string }>(
    `SELECT m.account_id, m.hdr, m.list_unsub, a.address FROM messages m JOIN accounts a ON a.id = m.account_id
     WHERE m.thread_id = ? AND (m.flags & ?) = 0 AND m.list_unsub IS NOT NULL
     ORDER BY m.internal_date DESC, m.id DESC LIMIT 1`,
    rowid,
    FLAG.draft | FLAG.fromMe,
  );
  return m ? { from: m.address, headers: listHeaders(m.hdr, m.list_unsub) } : undefined;
}

function target(ctx: MethodContext, threadId: string): Target | undefined {
  return ctx.services.store.read(q => readTarget(q, threadId));
}

function executorOf(ctx: MethodContext): UnsubscribePort {
  const executor = ctx.services.unsubscribe;
  if (isAbsent(executor)) throw new ContractError({ type: 'unavailable', message: NOT_YET });
  return executor;
}

function shown(url: string | undefined): { url: string } | Record<string, never> {
  return typeof url === 'string' && url.length <= MAX_URL && !/[\r\n]/.test(url) ? { url } : {};
}

async function perform(
  executor: UnsubscribePort,
  found: Target,
  opId: string | undefined,
  ctx: MethodContext,
): Promise<RunOutput> {
  const result = await executor.run({ ...found, ...(opId ? { opId } : {}), signal: ctx.signal });
  return {
    outcome: OUTCOME[result.kind] ?? 'failed',
    message: result.message,
    ...shown(result.url),
  };
}

export const handlers: AreaHandlers<'unsubscribe'> = {
  'Unsubscribe/get': (args, ctx) => {
    const found = target(ctx, args.threadId);
    if (!found) return { method: 'none' };
    // Without the executor nothing can be done with the headers, so the thread reads as not unsubscribable.
    if (isAbsent(ctx.services.unsubscribe)) return { method: 'none' };
    const described = ctx.services.unsubscribe.describe(found.headers);
    return { method: described.method, ...shown(described.url) };
  },
  'Unsubscribe/run': async (args, ctx) => {
    const found = target(ctx, args.threadId);
    if (!found) return { outcome: 'unavailable', message: NO_WAY };
    const executor = executorOf(ctx);
    return receiptsOf(executor).once(args.opId, args.threadId, () =>
      perform(executor, found, args.opId, ctx),
    );
  },
};
