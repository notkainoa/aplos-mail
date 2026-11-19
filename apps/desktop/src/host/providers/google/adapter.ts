import { NotImplementedError } from '@aplos/contract/contract-error';
import type {
  AdapterAccount,
  AdapterContext,
  AttachmentRef,
  BudgetSpec,
  CalendarAdapter,
  CoalescedOp,
  ConnectContext,
  ConnectRequest,
  ConnectResult,
  DraftSaveResult,
  DraftUpload,
  FindSentResult,
  OpenedThread,
  OpOutcome,
  PendingOp,
  PlanInput,
  PlannedStep,
  ProviderAdapter,
  ProviderFactory,
  RulesAdapter,
  SearchResult,
  SendReceipt,
  ServerSearch,
  StepResult,
  SubmissionPayload,
  SyncState,
  ThreadOpenRef,
  WorkflowChannel,
} from '@aplos/engine/ports';
import type { GoogleConnect } from '../oauth/connect';
import { fetchAttachment, fetchOriginal, openThread } from './bodies';
import { createGoogleCalendar } from './calendar';
import { GmailPacer, PACER_TARGET, type GmailDeps } from './client';
import { GMAIL_COSTS, type GmailCostTable } from './costs';
import { deleteDraftCopy, saveDraftCopy } from './drafts';
import { RETRY_SCOPE } from './failures';
import { gmailRules } from './filters';
import { historyStep } from './history';
import { applyOp, coalesceOps } from './ops';
import { retryStep } from './retry';
import { search } from './search';
import { findSentCopy, sendSubmission } from './send';
import { FactsMemo, listFolder, listStep, plan, type SyncRuntime, type WindowCall } from './sync';
import { GmailWorkflowTransport, type TransportLimits } from './workflow';
import type { WorkflowTransport } from './workflow-state';

/**
 * The google `ProviderFactory` and its per-account `ProviderAdapter` (plan 20 section 3.2): the read path of
 * `prov-gmail`. Parts that belong to other lanes are explicit stubs that throw `NotInThisLaneError`, never silent
 * no-ops: connect when the host passes none (prov-gov's `oauth/host-connect.ts`), the workflow channel and calendar
 * (left undefined; prov-gmail workflow, prov-cal). Send and findSent are prov-gmail-write's (send.ts).
 * `rules` is prov-gmail-write's sender-rule mirror on `users.settings.filters` (filters.ts); `saveDraft` and
 * `deleteDraft` are its drafts API (drafts.ts).
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

/**
 * Wiring the workflow channel on (`GoogleProviderOptions.workflow`): the adapter owns the sealed-copy transport
 * (`workflow.ts`) and plans its rounds; the merged state channel and the lease that rides it are the host's
 * (`googleWorkflowChannel` in `workflow-host.ts`).
 */
export interface GoogleWorkflowOptions {
  /** Transport bounds (`TRANSPORT_LIMITS` in `workflow.ts`); tests lower them. */
  limits?: Partial<TransportLimits>;
  /**
   * The floor between two planned rounds — the channel's idle cadence. A gated read is ~2 units when nothing
   * changed (`workflow.ts` header), so one round a minute is the default.
   */
  roundMs?: number;
}

/** `WORKFLOW_ROUND_MS`: the `workflow` scope's idle cadence (ARCH 6.5's lease round, plan 20 PV3). */
export const WORKFLOW_ROUND_MS = 60_000;

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
  /** `ProviderFactory.forgetAccount` (account removal), from the same place; without it the factory has none. */
  forgetAccount?: (accountId: string) => Promise<void>;
  /**
   * Present to enable the workflow channel: `adapter.workflow` is the transport (`WorkflowChannel`) and `plan()`
   * schedules its round. Off by default so callers without a lease host do not pay for channel reads — see
   * `workflow-host.ts` for the host-side wiring.
   */
  workflow?: GoogleWorkflowOptions;
  /** Default false: sends never use `drafts.send` until the live gate proves it (`SendOptions.useDraftsSend` in send.ts). */
  useDraftsSend?: boolean;
  /**
   * Default true: `deleteDraft` removes a draft only when the caller names the message id it holds
   * (`expectedMessageId`, PORT GAP 3 closed by #153) and the draft still holds it; without one it never deletes. False
   * turns every removal off (the call resolves without a request); saving and replacing drafts is unaffected.
   */
  deleteDrafts?: boolean;
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

/**
 * The `gcal` budget (prov-cal): Google Calendar's 600 requests a minute per user, half of it as the target — the
 * same spec as `gcalBudget` in the engine's `sync/budgets.ts`, declared here because the factory supplies budgets.
 * A pause or block on it shows per calendar, never as the mail status (D12).
 */
export const GCAL_BUDGET: BudgetSpec = {
  id: 'gcal',
  unit: 'requests',
  windowMs: 60_000,
  ceiling: 600,
  target: { primary: 300, secondary: 300 },
  floor: 60,
  laneShare: {
    interactive: 1,
    opFlush: 1,
    incremental: 0.9,
    prefetch: 0.2,
    backfill: 0.75,
    enrichment: 0.5,
  },
  inFlight: 2,
  reservedInteractive: 1,
};

export class GmailAdapter implements ProviderAdapter {
  readonly kind = 'google' as const;
  private readonly closer = new AbortController();
  private readonly rt: SyncRuntime;
  private readonly pacer?: GmailPacer;
  /** The paced workflow transport behind `workflow` and `workflowTransport()`, when the channel is wired on. */
  private readonly transport?: WorkflowTransport;
  private readonly workflowRoundMs: number;
  private readonly useDraftsSend: boolean;
  private readonly deleteDrafts: boolean;
  readonly workflow?: WorkflowChannel;
  /** The sender-rules mirror (prov-gmail-write): the account's granted scopes decide what it answers. */
  readonly rules: RulesAdapter;
  /**
   * The calendar half (prov-cal, calendar.ts): always present, so `runtime.missingPermissions` can tell a grant
   * without its scopes from a provider that has no calendar at all. Its `plan` emits nothing while
   * `capabilities.calendar` is false.
   */
  readonly calendar: CalendarAdapter;

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
    this.calendar = createGoogleCalendar({
      fetch: deps.fetch,
      userAgent: deps.userAgent,
      closed: deps.closed,
    });
    this.rt = {
      deps,
      windowCall: options.windowCall ?? 'messages.get',
      memo: new FactsMemo(),
      rounds: new Map(),
    };
    if (options.pace !== false) this.pacer = new GmailPacer();
    this.useDraftsSend = options.useDraftsSend === true;
    this.deleteDrafts = options.deleteDrafts !== false;
    const rules = gmailRules(deps);
    this.rules = {
      list: ctx => rules.list(this.paced(ctx)),
      create: (rule, ctx) => rules.create(rule, this.paced(ctx)),
      delete: (remoteId, ctx) => rules.delete(remoteId, this.paced(ctx)),
    };
    this.workflowRoundMs = options.workflow?.roundMs ?? WORKFLOW_ROUND_MS;
    if (options.workflow) {
      const transport = new GmailWorkflowTransport(deps, account.address, options.workflow.limits);
      this.transport = {
        round: (state, ctx) => transport.round(state, this.paced(ctx)),
        put: (copy, ctx) => transport.put(copy, this.paced(ctx)),
        compact: (ids, ctx) => transport.compact(ids, this.paced(ctx)),
        readBack: (id, ctx) => transport.readBack(id, this.paced(ctx)),
        receivedAt: (id, ctx) => transport.receivedAt(id, this.paced(ctx)),
        sentWindow: id => transport.sentWindow(id),
      };
      this.workflow = this.transport;
    }
  }

  /** The context every call runs with: the actor's governor behind this account's pacer, while there is one. */
  private paced(ctx: AdapterContext): AdapterContext {
    return this.pacer ? { ...ctx, governor: this.pacer.bind(ctx.governor, ctx.clock) } : ctx;
  }

  /**
   * The paced transport `createWorkflowStateChannel` wraps (the lease's records ride the merged channel; see
   * `googleWorkflowChannel` in `workflow-host.ts`). Undefined unless `GoogleProviderOptions.workflow` was set.
   */
  workflowTransport(): WorkflowTransport | undefined {
    return this.transport;
  }

  plan(input: PlanInput): PlannedStep[] {
    const steps = plan(input);
    const workflow = this.workflowStep(input);
    return [...steps, ...this.calendar.plan(input), ...(workflow ? [workflow] : [])];
  }

  /**
   * The channel's own round (ARCH 6.5, plan 20 PV3): on the `workflow` scope, at its idle cadence — a gated read is
   * ~2 units when nothing changed — so at most one round per `roundMs` after the committed row. The actor runs it
   * only when it is the channel's one reader: never when the host's lease round reads the channel
   * (`googleWorkflowChannel`), and not on a secondary that sees a live holder (`PlanInput` has no lease field, so the
   * planner cannot tell). A pause or block makes no I/O because every call the round makes goes through
   * `ctx.governor`.
   */
  private workflowStep(input: PlanInput): PlannedStep | undefined {
    if (!this.workflow) return undefined;
    const last = input.states.find(s => s.scope === 'workflow')?.updatedAt;
    return {
      scope: 'workflow',
      lane: 'enrichment',
      origin: 'workflow',
      ...(last ? { notBefore: last + this.workflowRoundMs } : {}),
      trigger: input.trigger,
    };
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

  original(
    remoteMessageId: string,
    ctx: AdapterContext,
    opts?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<Uint8Array>> {
    return fetchOriginal(this.rt.deps, remoteMessageId, this.paced(ctx), opts);
  }

  search(query: ServerSearch, ctx: AdapterContext): Promise<SearchResult> {
    return search(this.rt.deps, query, this.paced(ctx));
  }

  /** `ProviderPort.listFolder`'s adapter half: one page of a `lazy` folder the UI opened (Spam, Trash, Starred…). */
  listFolder(folder: string, pageToken: string | undefined, ctx: AdapterContext) {
    return listFolder(this.rt, folder, pageToken, this.paced(ctx));
  }

  coalesce(ops: PendingOp[]): CoalescedOp[] {
    return coalesceOps(ops, this.rt.deps.costs);
  }

  apply(op: CoalescedOp, ctx: AdapterContext): Promise<OpOutcome[]> {
    return applyOp(this.rt.deps, op, this.paced(ctx));
  }

  /** prov-gmail-write's transport (`send.ts`): the pinned bytes; `drafts.send` only when enabled and `sendsRemoteDraft`. */
  send(submission: SubmissionPayload, ctx: AdapterContext): Promise<SendReceipt> {
    return sendSubmission(this.rt.deps, submission, this.paced(ctx), {
      useDraftsSend: this.useDraftsSend,
    });
  }

  /** Searches Sent only (`in:sent`, never a DRAFT), so an unsent draft with the same Message-ID is never found. */
  findSent(internetId: string, since: number, ctx: AdapterContext): Promise<FindSentResult> {
    return findSentCopy(this.rt.deps, internetId, since, this.paced(ctx));
  }

  saveDraft(draft: DraftUpload, ctx: AdapterContext): Promise<DraftSaveResult> {
    return saveDraftCopy(this.rt.deps, draft, this.paced(ctx));
  }

  deleteDraft(
    remoteDraftId: string,
    ctx: AdapterContext,
    expectedMessageId?: string,
  ): Promise<void> {
    // Switched off, or no proof of which copy the caller holds: resolving leaves the copy in place (read as removed).
    if (!this.deleteDrafts || expectedMessageId === undefined) return Promise.resolve();
    return deleteDraftCopy(this.rt.deps, remoteDraftId, this.paced(ctx), expectedMessageId);
  }

  /** Aborts every request this adapter has in flight or queued (D23); later calls fail at once. */
  async close(): Promise<void> {
    this.closer.abort(new Error('adapter closed'));
  }
}

export function createGoogleProvider(options: GoogleProviderOptions): ProviderFactory {
  const { connect, discardCredential, forgetAccount } = options;
  return {
    kind: 'google',
    connect(req: ConnectRequest, ctx: ConnectContext): Promise<ConnectResult> {
      if (connect) return connect(req, ctx);
      return Promise.reject(new NotInThisLaneError('connect', 'prov-gov (host/providers/oauth)'));
    },
    ...(discardCredential ? { discardCredential } : {}),
    ...(forgetAccount ? { forgetAccount } : {}),
    budgets(): BudgetSpec[] {
      return [GMAIL_BUDGET, GCAL_BUDGET];
    },
    open(account: AdapterAccount): ProviderAdapter {
      return new GmailAdapter(account, options);
    },
  };
}
