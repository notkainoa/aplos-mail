import { NotSentError, ProviderError } from '../ports/base';
import type { AccountId, BudgetId } from '../ports/base';
import type {
  AdapterContext,
  DraftSaveResult,
  DraftUpload,
  ProviderAdapter,
} from '../ports/provider';

/**
 * What a remote-draft or send call needs from a started account: its adapter, its mail budget (for errors only)
 * and the account actor's context, the only door to the governor. The host hands over the entry it keeps for
 * exactly the account the caller named, never another's.
 */
export interface DraftTarget {
  adapter: ProviderAdapter;
  budget: BudgetId;
  context(): AdapterContext;
}

/**
 * An account actor entry as a `DraftTarget`, or undefined when the account is not started. Draft and send calls
 * share the shape; `entry` stays the host's own record type by taking it structurally.
 */
export function entryTarget(
  entry:
    | {
        adapter: ProviderAdapter;
        budget: BudgetId;
        actor: { context(): AdapterContext };
      }
    | undefined,
): DraftTarget | undefined {
  if (!entry) return undefined;
  return { adapter: entry.adapter, budget: entry.budget, context: () => entry.actor.context() };
}

/**
 * A `permanent` refusal with a plain reason code and no draft content. `DraftSaveResult` has no `unsupported` kind, so
 * the engine parks the draft on it and the owner's local copy is untouched.
 */
function refused(method: string, reason: string, provider: string): ProviderError {
  return new ProviderError({ class: 'permanent', provider, method, reason });
}

/**
 * An account that is not started right now: the draft calls arrive before `start` or in the moment a restart stops
 * the account, so this is a `transient` refusal that provably wrote nothing (`NotSentError`). The engine tries
 * again after its retry delay instead of parking the draft in a problem state. The send lane does not share this:
 * the outbox settles a `NotSentError` as `failed`, so `host-send.ts` pauses instead.
 */
export function notStarted(method: string): NotSentError {
  return new NotSentError({
    class: 'transient',
    provider: 'engine',
    method,
    reason: 'accountNotStarted',
  });
}

/**
 * The account's context, checked against the account the caller named. The host keys its entries by account, so a
 * mismatch is a bug; it throws rather than let one account's draft reach another account's mailbox.
 */
export function contextFor(
  account: AccountId,
  target: DraftTarget,
  method: string,
): AdapterContext {
  const ctx = target.context();
  if (ctx.account.id !== account) throw refused(method, 'accountMismatch', target.budget);
  return ctx;
}

/** `DraftSyncPort.save`: the account adapter's `saveDraft` under the account's own context (its `opFlush` lane). */
export async function saveRemoteDraft(
  account: AccountId,
  target: DraftTarget | undefined,
  draft: DraftUpload,
): Promise<DraftSaveResult> {
  const method = 'drafts.save';
  if (!target) throw notStarted(method);
  const { adapter } = target;
  if (!adapter.saveDraft) throw refused(method, 'draftsUnsupported', target.budget);
  return adapter.saveDraft(draft, contextFor(account, target, method));
}

/** `DraftSyncPort.remove`: the adapter's guarded `deleteDraft`; `expectedMessageId` is forwarded untouched. */
export async function removeRemoteDraft(
  account: AccountId,
  target: DraftTarget | undefined,
  remoteDraftId: string,
  expectedMessageId?: string,
): Promise<void> {
  const method = 'drafts.remove';
  if (!target) throw notStarted(method);
  const { adapter } = target;
  if (!adapter.deleteDraft) throw refused(method, 'draftsUnsupported', target.budget);
  const ctx = contextFor(account, target, method);
  if (expectedMessageId === undefined) return adapter.deleteDraft(remoteDraftId, ctx);
  return adapter.deleteDraft(remoteDraftId, ctx, expectedMessageId);
}
