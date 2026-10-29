import { NotImplementedError } from '@aplos/contract/contract-error';
import type {
  AdapterAccount,
  AdapterContext,
  AttachmentRef,
  BudgetSpec,
  CoalescedOp,
  ConnectContext,
  ConnectRequest,
  ConnectResult,
  FindSentResult,
  OpenedThread,
  OpOutcome,
  PendingOp,
  PlanInput,
  PlannedStep,
  ProviderAdapter,
  ProviderFactory,
  SearchResult,
  SendReceipt,
  ServerSearch,
  StepResult,
  SubmissionPayload,
  SyncState,
  ThreadOpenRef,
} from '@aplos/engine/ports';
import type { GoogleConnect } from '../oauth/connect';
import { fetchAttachment, openThread } from './bodies';
import { GmailPacer, PACER_TARGET, type GmailDeps } from './client';
import { GMAIL_COSTS, type GmailCostTable } from './costs';
import { RETRY_SCOPE } from './failures';
import { historyStep } from './history';
import { applyOp, coalesceOps } from './ops';
import { retryStep } from './retry';
import { search } from './search';
import { FactsMemo, listStep, plan, type SyncRuntime, type WindowCall } from './sync';

/**
 * The google `ProviderFactory` and its per-account `ProviderAdapter` (plan 20 section 3.2): the read path of
 * `prov-gmail`. Parts that belong to other lanes are explicit stubs that throw `NotInThisLaneError`, never silent
 * no-ops: connect when the host passes none (prov-gov's `oauth/host-connect.ts`), send and findSent (prov-gmail-write),
 * drafts, filters, the workflow channel and calendar (left undefined; prov-gmail-write, prov-gmail workflow, prov-cal).
 */

export class NotInThisLaneError extends NotImplementedError {
  constructor(
    method: string,
    readonly lane: string,
  ) {
    super(method);
    this.name = 'NotInThisLaneError';
    this.message = `${method} is built by ${lane}, not in this lane yet`;
  }
}

export interface GoogleProviderOptions {
  /** The host's HTTP client; the tests pass the emulator's. */
  fetch: typeof fetch;
  /** Grandfathered projects pass `GMAIL_COSTS_GRANDFATHERED`. */
  costs?: GmailCostTable;
  /** P1's call; `messages.get` by measurement (see sync.ts). */
  windowCall?: WindowCall;
  userAgent?: string;
  /**
   * Default true: the adapter paces itself (`GmailPacer`, plan 20 PV0 item 1). The actor host passes false once
   * `prov-gov`'s governor, which applies `GMAIL_BUDGET` itself, is the one in `AdapterContext.governor`.
   */
  pace?: boolean;
  /** prov-gov's sign-in (`createGoogleHostConnect(...).connect`). Without it, `connect` rejects `NotInThisLaneError`. */
  connect?: GoogleConnect;
  /** `ProviderFactory.discardCredential`, from the same place; without it the factory has none (the engine fails closed). */
  discardCredential?: (ref: string) => Promise<void>;
}

/**
 * ARCH 6.2 and the ports' BudgetSpec notes, held to plan 20 PV0 item 1 and the Providers brief for now: 3,000 units a
 * minute and one request in flight, because every live run must stay under 3,000 and "two requests in flight" is one
 * of the named adversarial checks. ARCH's 4,500 primary and 3 in flight wait for the live gate and the lease
 * (`prov-gov`). With one slot the interactive reserve is 0 (min(reserve, limit - 1)); interactive calls go first in
 * the queue instead. The Calendar budget is `prov-cal`'s and joins this list there.
 */
export const GMAIL_BUDGET: BudgetSpec = {
  id: 'gmail',
  unit: 'units',
  windowMs: 60_000,
  ceiling: 6_000,
  target: { primary: PACER_TARGET, secondary: 1_500 },
  floor: 1_000,
  laneShare: {
    interactive: 1,
    opFlush: 1,
    incremental: 0.9,
    prefetch: 0.2,
    backfill: 0.75,
    enrichment: 0.1,
  },
  inFlight: 1,
  reservedInteractive: 0,
  batch: { start: 10, min: 1, max: 25, growBy: 5 },
};

export class GmailAdapter implements ProviderAdapter {
  readonly kind = 'google' as const;
  private readonly closer = new AbortController();
  private readonly rt: SyncRuntime;
  private readonly pacer?: GmailPacer;

  constructor(
    readonly account: AdapterAccount,
    options: GoogleProviderOptions,
  ) {
    const deps: GmailDeps = {
      fetch: options.fetch,
      costs: options.costs ?? GMAIL_COSTS,
      userAgent: options.userAgent ?? 'AplosMail/0.3 (gzip)',
      closed: this.closer.signal,
    };
    this.rt = {
      deps,
      windowCall: options.windowCall ?? 'messages.get',
      memo: new FactsMemo(),
      rounds: new Map(),
    };
    if (options.pace !== false) this.pacer = new GmailPacer();
  }

  /** The context every call runs with: the actor's governor behind this account's pacer, while there is one. */
  private paced(ctx: AdapterContext): AdapterContext {
    return this.pacer ? { ...ctx, governor: this.pacer.bind(ctx.governor, ctx.clock) } : ctx;
  }

  plan(input: PlanInput): PlannedStep[] {
    return plan(input);
  }

  syncStep(step: PlannedStep, state: SyncState, actorCtx: AdapterContext): Promise<StepResult> {
    const ctx = this.paced(actorCtx);
    switch (step.scope) {
      case 'history':
        return historyStep(this.rt, step, state, ctx);
      case 'window:inbox':
      case 'sent:recent':
      case 'backfill:inbox':
        return listStep(this.rt, state, ctx);
      case RETRY_SCOPE:
        return retryStep(this.rt, step, state, ctx);
      case 'workflow':
        throw new NotInThisLaneError('syncStep(workflow)', 'prov-gmail workflow');
      default:
        // `folder:<id>` (lazy user labels, 25 a page) is the next prov-gmail package; `prefetch` is a port gap.
        throw new NotInThisLaneError(`syncStep(${step.scope})`, 'a later prov-gmail package');
    }
  }

  openThread(
    ref: ThreadOpenRef,
    lane: 'interactive' | 'prefetch',
    ctx: AdapterContext,
  ): Promise<OpenedThread> {
    return openThread(this.rt.deps, ref, lane, this.paced(ctx));
  }

  fetchAttachment(ref: AttachmentRef, ctx: AdapterContext): Promise<AsyncIterable<Uint8Array>> {
    return fetchAttachment(this.rt.deps, ref, this.paced(ctx));
  }

  search(query: ServerSearch, ctx: AdapterContext): Promise<SearchResult> {
    return search(this.rt.deps, query, this.paced(ctx));
  }

  coalesce(ops: PendingOp[]): CoalescedOp[] {
    return coalesceOps(ops, this.rt.deps.costs);
  }

  apply(op: CoalescedOp, ctx: AdapterContext): Promise<OpOutcome[]> {
    return applyOp(this.rt.deps, op, this.paced(ctx));
  }

  send(_submission: SubmissionPayload, _ctx: AdapterContext): Promise<SendReceipt> {
    return Promise.reject(new NotInThisLaneError('send', 'prov-gmail-write'));
  }

  findSent(_internetId: string, _since: number, _ctx: AdapterContext): Promise<FindSentResult> {
    return Promise.reject(new NotInThisLaneError('findSent', 'prov-gmail-write'));
  }

  /** Aborts every request this adapter has in flight or queued (D23); later calls fail at once. */
  async close(): Promise<void> {
    this.closer.abort(new Error('adapter closed'));
  }
}

export function createGoogleProvider(options: GoogleProviderOptions): ProviderFactory {
  const { connect, discardCredential } = options;
  return {
    kind: 'google',
    connect(req: ConnectRequest, ctx: ConnectContext): Promise<ConnectResult> {
      if (connect) return connect(req, ctx);
      return Promise.reject(new NotInThisLaneError('connect', 'prov-gov (host/providers/oauth)'));
    },
    ...(discardCredential ? { discardCredential } : {}),
    budgets(): BudgetSpec[] {
      return [GMAIL_BUDGET];
    },
    open(account: AdapterAccount): ProviderAdapter {
      return new GmailAdapter(account, options);
    },
  };
}
