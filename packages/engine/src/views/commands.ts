import type { Input, Operation, Receipt } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { Caller } from '../methods/types';
import type { StoreReader } from '../store';
import { factsReader, planThread, type ActEnv, type ThreadFacts } from './act';
import { addThread, commitBuilt, emptyBuilt, readEnv, type Built } from './apply';
import { createJournal, priorReceipt, readOperation, type CommandDeps, type Journal } from './ops';
import { viewEnv } from './page';
import { resolveSelector } from './select';
import { addSenderRule, alsoForSender } from './sender-ops';
import { retryOperation, undoOperation } from './undo';

/*
 * Commands (views-3, ARCH 4.3 and 9.2): `Thread/act` applies its workflow edit and the local effect of every message
 * edit in ONE commit and enqueues the provider ops in it, so a window never shows half an action. `Operation/undo`
 * (`undo.ts`) enqueues the inverse and never delays a commit (DESIGN section 5 rule 11).
 */

/** The commands as `services.threadOps`. */
export interface ThreadOps {
  act(args: Input<'Thread/act'>, caller: Caller): Receipt;
  undo(args: Input<'Operation/undo'>, caller: Caller): Receipt;
  retry(args: Input<'Operation/retry'>, caller: Caller): Receipt;
  get(opIds: readonly string[]): { list: Operation[]; notFound: string[] };
}

/** `journal` is shared with the sender rules, whose commits undo the same way. */
export function createThreadOps(
  deps: Omit<CommandDeps, 'journal'>,
  journal: Journal = createJournal(),
): ThreadOps {
  const full: CommandDeps = { ...deps, journal };
  return {
    act: (args, _caller) => act(full, args),
    undo: (args, caller) => undoOperation(full, args, caller),
    retry: (args, caller) => retryOperation(full, args, caller),
    get: opIds => getOperations(full, opIds),
  };
}

const notFound = (message: string) => new ContractError({ type: 'notFound', message });

function targetIds(deps: CommandDeps, q: StoreReader, args: Input<'Thread/act'>, env: ActEnv) {
  const hasIds = (args.ids?.length ?? 0) > 0;
  if (hasIds === !!args.selector)
    throw new ContractError({ type: 'validation', message: 'Choose at least one conversation.' });
  if (args.selector)
    return resolveSelector(q, args.selector, viewEnv(q, env.now, deps.zone), {
      dbEpoch: deps.store.dbEpoch,
      seq: deps.store.seq(),
    });
  return [...new Set(args.ids)];
}

function build(deps: CommandDeps, q: StoreReader, args: Input<'Thread/act'>): Built {
  const env = readEnv(deps, q);
  const read = factsReader(q);
  const out = emptyBuilt();
  const wanted = new Map<string, { facts: ThreadFacts; lane: 'do' | 'update' | 'low' }>();
  for (const id of targetIds(deps, q, args, env)) {
    const facts = read(id);
    if (!facts) throw notFound('This conversation is no longer available.');
    const plan = planThread(facts, args.action, env);
    if (!plan) continue;
    addThread(out, facts, plan, args.opId, 'Thread/act');
    if (plan.patch.lane && alsoForSender(args.action))
      wanted.set(id, { facts, lane: plan.patch.lane });
  }
  for (const w of wanted.values()) addSenderRule(q, out, w, args.opId, env);
  return out;
}

function act(deps: CommandDeps, args: Input<'Thread/act'>): Receipt {
  const replay = priorReceipt(deps, args.opId, 'Thread/act');
  if (replay) return replay;
  const built = deps.store.read(q => build(deps, q, args));
  return commitBuilt(deps, args.opId, 'Thread/act', built);
}

function getOperations(deps: CommandDeps, opIds: readonly string[]) {
  return deps.store.read(q => {
    const list: Operation[] = [];
    const missing: string[] = [];
    for (const id of opIds) {
      const op = readOperation(q, id, deps.journal.get(id), deps.store.dbEpoch);
      if (op) list.push(op);
      else missing.push(id);
    }
    return { list, notFound: missing };
  });
}
