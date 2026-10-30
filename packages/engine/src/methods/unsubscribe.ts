import { ContractError } from '@aplos/contract/contract-error';
import type { Output } from '@aplos/contract';
import type { ListHeaders } from '../ports';
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

/** What the host executor reports. `none`: the message offers no usable way. */
export type UnsubscribeKind = 'done' | 'unsure' | 'failed' | 'open' | 'compose' | 'none';

/**
 * The host executor, structurally. MISSING PORT: this belongs in `ports/` and in `HostPorts` (eng-contract) as
 * `unsubscribe`, so the host can inject it like `images`. Until then it is an optional service a lane module may set.
 */
export interface UnsubscribeExecutor {
  describe(headers: ListHeaders): { method: 'oneClick' | 'mailto' | 'link' | 'none'; url?: string };
  run(request: {
    from: string;
    headers: ListHeaders;
    signal: AbortSignal;
  }): Promise<{ kind: UnsubscribeKind; message: string; url?: string }>;
}

declare module '../runtime/services' {
  interface EngineServices {
    /** The List-Unsubscribe executor; absent until the host can inject it (see `UnsubscribeExecutor`). */
    unsubscribe?: UnsubscribeExecutor;
  }
}

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

function executorOf(ctx: MethodContext): UnsubscribeExecutor {
  const executor = ctx.services.unsubscribe;
  if (!executor) throw new ContractError({ type: 'unavailable', message: NOT_YET });
  return executor;
}

function shown(url: string | undefined): { url: string } | Record<string, never> {
  return typeof url === 'string' && url.length <= MAX_URL && !/[\r\n]/.test(url) ? { url } : {};
}

export const handlers: AreaHandlers<'unsubscribe'> = {
  'Unsubscribe/get': (args, ctx) => {
    const found = target(ctx, args.threadId);
    if (!found) return { method: 'none' };
    const described = executorOf(ctx).describe(found.headers);
    return { method: described.method, ...shown(described.url) };
  },
  'Unsubscribe/run': async (args, ctx) => {
    const found = target(ctx, args.threadId);
    if (!found) return { outcome: 'unavailable', message: NO_WAY };
    const result = await executorOf(ctx).run({ ...found, signal: ctx.signal });
    return {
      outcome: OUTCOME[result.kind] ?? 'failed',
      message: result.message,
      ...shown(result.url),
    };
  },
};
