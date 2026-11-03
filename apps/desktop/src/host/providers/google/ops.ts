import type { ClassifiedError } from '@aplos/contract';
import {
  PausedError,
  ProviderError,
  type AdapterContext,
  type CoalescedOp,
  type OpOutcome,
  type PendingOp,
} from '@aplos/engine/ports';
import { GmailClient, isStop, type GmailDeps } from './client';
import { gmailCost, type GmailCostTable, type GmailMethod } from './costs';

/**
 * Local edits to Gmail calls (ARCH 4.3, plan 20 PV3 "Ops"). Ops are per message and per label; ops with the same label
 * change merge into one `messages.batchModify` (up to 1,000 ids), a smaller group goes out as `messages.modify` per
 * message when that is cheaper (5 units against 50), and trash and untrash are one call per message. A permanent delete
 * is never issued: `gmail.modify` cannot delete, and Aplos does not want to. `apply` makes one request per call and never
 * retries: re-sending an idempotent write is the governor's job, and a refusal comes back as a classified `failed` outcome.
 */

/** Gmail's documented cap on `messages.batchModify`. */
const BATCH_MAX = 1_000;
/** The interactive-lane label ops all run on `opFlush`, ahead of incremental sync. */
const LANE = 'opFlush' as const;

/** One message and every op id whose effect it carries (a message's consecutive label ops fold into one). */
interface Target {
  id: string;
  opIds: string[];
}

/** The adapter's own `CoalescedOp.body`. `none` is an op Gmail has no concept of (`answered`): applied without a call. */
export interface GmailOpBody {
  call: 'none' | 'modify' | 'batchModify' | 'trash' | 'untrash';
  targets: Target[];
  addLabelIds: string[];
  removeLabelIds: string[];
}

/** Catalog ids of the calls an op can make; `none` is not a call and has no price. */
const NO_CALL = 'gmail.none';
const METHOD = {
  modify: 'gmail.messages.modify',
  batchModify: 'gmail.messages.batchModify',
  trash: 'gmail.messages.trash',
  untrash: 'gmail.messages.untrash',
} as const satisfies Record<string, GmailMethod>;

// ---- coalesce ----

/** One message's pending change, in order. A trash or untrash is a barrier: label ops never fold across it. */
type Step =
  | { kind: 'labels'; add: Set<string>; remove: Set<string>; opIds: string[]; seq: number }
  | { kind: 'trash' | 'untrash'; opIds: string[]; seq: number };

/** What a label-shaped op does in Gmail terms. Flags are labels there: UNREAD is "not seen", STARRED is "flagged". */
function labelChange(op: PendingOp): { add: string[]; remove: string[] } | undefined {
  const { change } = op;
  if (change.kind === 'folders') return { add: change.add, remove: change.remove };
  if (change.kind !== 'flags') return undefined;
  const add: string[] = [];
  const remove: string[] = [];
  if (change.seen !== undefined) (change.seen ? remove : add).push('UNREAD');
  if (change.flagged !== undefined) (change.flagged ? add : remove).push('STARRED');
  // `answered` has no Gmail label: the op stays in the list with an empty change and is applied without a call.
  return { add, remove };
}

/** A later op wins per label, exactly as if the ops had run one after the other. */
function fold(
  step: Extract<Step, { kind: 'labels' }>,
  change: { add: string[]; remove: string[] },
): void {
  for (const label of change.add) {
    step.add.add(label);
    step.remove.delete(label);
  }
  for (const label of change.remove) {
    step.remove.add(label);
    step.add.delete(label);
  }
}

/** Individual modifies are cheaper than a batch below this many ids (5 units each against 50). */
function batchPays(count: number, costs: GmailCostTable): boolean {
  return (
    count * gmailCost('gmail.messages.modify', undefined, costs) >=
    gmailCost('gmail.messages.batchModify', undefined, costs)
  );
}

export function coalesceOps(ops: readonly PendingOp[], costs: GmailCostTable): CoalescedOp[] {
  const perMessage = new Map<string, Step[]>();
  for (const op of [...ops].sort((a, b) => a.seq - b.seq)) {
    const steps = perMessage.get(op.remoteId) ?? [];
    perMessage.set(op.remoteId, steps);
    const last = steps.at(-1);
    const change = labelChange(op);
    if (!change) {
      const kind = op.change.kind === 'untrash' ? 'untrash' : 'trash';
      if (last?.kind === kind) last.opIds.push(op.opId);
      else steps.push({ kind, opIds: [op.opId], seq: op.seq });
    } else if (last?.kind === 'labels') {
      last.opIds.push(op.opId);
      fold(last, change);
    } else {
      const step: Step = {
        kind: 'labels',
        add: new Set(),
        remove: new Set(),
        opIds: [op.opId],
        seq: op.seq,
      };
      fold(step, change);
      steps.push(step);
    }
  }

  // A message's n-th step goes out in layer n, so its steps keep their order while steps of different messages that
  // change labels the same way still share a call.
  const layers: { id: string; step: Step }[][] = [];
  for (const [id, steps] of perMessage)
    steps.forEach((step, i) => (layers[i] ??= []).push({ id, step }));

  const out: CoalescedOp[] = [];
  for (const layer of layers) {
    const emitted: { seq: number; op: CoalescedOp }[] = [];
    const groups = new Map<
      string,
      { add: string[]; remove: string[]; targets: { target: Target; seq: number }[] }
    >();
    for (const { id, step } of layer) {
      const target = { id, opIds: step.opIds };
      if (step.kind !== 'labels') {
        emitted.push({ seq: step.seq, op: single(step.kind, target, [], [], costs) });
        continue;
      }
      const add = [...step.add].sort();
      const remove = [...step.remove].sort();
      const key = JSON.stringify([add, remove]);
      const group = groups.get(key) ?? { add, remove, targets: [] };
      groups.set(key, group);
      group.targets.push({ target, seq: step.seq });
    }
    for (const { add, remove, targets } of groups.values()) {
      targets.sort((a, b) => a.seq - b.seq);
      if (add.length === 0 && remove.length === 0) {
        // Nothing for Gmail to do (an `answered` flag): one free op so every op id still gets an outcome.
        const body: GmailOpBody = {
          call: 'none',
          targets: targets.map(t => t.target),
          addLabelIds: [],
          removeLabelIds: [],
        };
        emitted.push({
          seq: targets[0].seq,
          op: { opIds: targets.flatMap(t => t.target.opIds), method: NO_CALL, cost: 0, body },
        });
        continue;
      }
      for (let from = 0; from < targets.length; from += BATCH_MAX) {
        const chunk = targets.slice(from, from + BATCH_MAX);
        if (batchPays(chunk.length, costs)) {
          const body: GmailOpBody = {
            call: 'batchModify',
            targets: chunk.map(t => t.target),
            addLabelIds: add,
            removeLabelIds: remove,
          };
          emitted.push({
            seq: chunk[0].seq,
            op: {
              opIds: chunk.flatMap(t => t.target.opIds),
              method: METHOD.batchModify,
              cost: gmailCost(METHOD.batchModify, undefined, costs),
              body,
            },
          });
        } else {
          for (const t of chunk)
            emitted.push({ seq: t.seq, op: single('modify', t.target, add, remove, costs) });
        }
      }
    }
    out.push(...emitted.sort((a, b) => a.seq - b.seq).map(e => e.op));
  }
  return out;
}

function single(
  call: 'modify' | 'trash' | 'untrash',
  target: Target,
  add: string[],
  remove: string[],
  costs: GmailCostTable,
): CoalescedOp {
  const body: GmailOpBody = { call, targets: [target], addLabelIds: add, removeLabelIds: remove };
  return {
    opIds: target.opIds,
    method: METHOD[call],
    cost: gmailCost(METHOD[call], undefined, costs),
    body,
  };
}

// ---- apply ----

type Verdict = { result: 'applied' | 'notFound' } | { result: 'failed'; error: ClassifiedError };

/** The message does not exist (any more): a 404, or Gmail's 400 "Invalid id value" for an id it cannot place. */
function isGone(error: ClassifiedError): boolean {
  return (
    error.status === 404 ||
    (error.status === 400 && /invalid id/i.test(error.providerMessage ?? ''))
  );
}

function pausedAs(paused: PausedError, method: string): ClassifiedError {
  return {
    class: paused.cls,
    provider: 'gmail',
    method,
    reason: paused.reason,
    ...(paused.until !== undefined ? { resumeAt: paused.until } : {}),
  };
}

export async function applyOp(
  deps: GmailDeps,
  op: CoalescedOp,
  ctx: AdapterContext,
): Promise<OpOutcome[]> {
  const body = op.body as GmailOpBody;
  if (body.call === 'none')
    return body.targets.flatMap(t =>
      t.opIds.map((opId): OpOutcome => ({ opId, result: 'applied' })),
    );

  const client = new GmailClient(deps, ctx);
  /** After a refusal that paused the governor, nothing else is sent: the rest fail with the same error. */
  let halted: ClassifiedError | undefined;

  /** Runs one request. `gone` is a missing message; any other failure is the classified error. */
  const send = async (
    call: () => Promise<unknown>,
    method: string,
  ): Promise<'ok' | 'gone' | ClassifiedError> => {
    try {
      await call();
      return 'ok';
    } catch (error) {
      if (error instanceof PausedError) return (halted = pausedAs(error, method));
      if (!(error instanceof ProviderError)) throw error;
      if (isGone(error.error)) return 'gone';
      if (isStop(error)) halted = error.error;
      return error.error;
    }
  };
  const verdict = (sent: Awaited<ReturnType<typeof send>>): Verdict =>
    sent === 'ok'
      ? { result: 'applied' }
      : sent === 'gone'
        ? { result: 'notFound' }
        : { result: 'failed', error: sent };

  const one = async (target: Target): Promise<Verdict> => {
    if (halted) return { result: 'failed', error: halted };
    const call = body.call === 'batchModify' || body.call === 'none' ? 'modify' : body.call;
    const method = METHOD[call];
    const path = `/messages/${target.id}/${call}`;
    return verdict(
      await send(
        () =>
          client.call({
            method,
            path,
            httpMethod: 'POST',
            ...(call === 'modify'
              ? { body: { addLabelIds: body.addLabelIds, removeLabelIds: body.removeLabelIds } }
              : {}),
            fields: 'id',
            lane: LANE,
            kind: 'idempotentWrite',
            item: target.id,
          }),
        method,
      ),
    );
  };

  /**
   * A batch with one missing id fails whole (Gmail answers 400 and changes nothing), so the ids are halved until the
   * missing ones are alone. Each half is a new request, not a re-send: the idempotent label change is simply asked again
   * for fewer ids, and a group small enough for individual modifies goes out that way.
   */
  const many = async (targets: Target[]): Promise<Verdict[]> => {
    if (halted) return targets.map(() => ({ result: 'failed', error: halted! }));
    if (!batchPays(targets.length, deps.costs)) {
      const out: Verdict[] = [];
      for (const t of targets) out.push(await one(t));
      return out;
    }
    const method = METHOD.batchModify;
    const sent = await send(
      () =>
        client.call({
          method,
          path: '/messages/batchModify',
          httpMethod: 'POST',
          body: {
            ids: targets.map(t => t.id),
            addLabelIds: body.addLabelIds,
            removeLabelIds: body.removeLabelIds,
          },
          lane: LANE,
          kind: 'idempotentWrite',
        }),
      method,
    );
    if (sent !== 'gone') return targets.map(() => verdict(sent));
    const half = Math.ceil(targets.length / 2);
    return [...(await many(targets.slice(0, half))), ...(await many(targets.slice(half)))];
  };

  const verdicts =
    body.call === 'batchModify' ? await many(body.targets) : [await one(body.targets[0])];
  return body.targets.flatMap((target, i) =>
    target.opIds.map((opId): OpOutcome => {
      const v = verdicts[i];
      return v.result === 'failed'
        ? { opId, result: 'failed', error: v.error }
        : { opId, result: v.result };
    }),
  );
}
