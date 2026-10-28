import type { Input, Output, Receipt, SenderRule, ThreadAction } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { StoreReader, StoreWrite } from '../store';
import {
  archive,
  factsReader,
  restore,
  spam,
  type ActEnv,
  type Plan,
  type ThreadFacts,
} from './act';
import {
  addThread,
  commitBuilt,
  emptyBuilt,
  readEnv,
  type Built,
  type CommandMethod,
} from './apply';
import { priorReceipt, type CommandDeps, type Step } from './ops';
import {
  ruleById,
  ruleByKey,
  rulesCovering,
  rulePatch,
  rulesByMatch,
  rulesFor,
  senderOf,
  threadsOf,
  type Rule,
  type RuleRow,
} from './senders';

/*
 * `SenderRule/*` (views-4). A rule is saved and applied to the threads that already match in ONE commit built from the
 * same pieces as `Thread/act` (`apply.ts`): one receipt, the provider ops in the queue, and an undo that puts the
 * threads and the rule back. A block moves the thread to Spam and hides it from Home; it never deletes a message, and
 * unblocking brings the thread back.
 */

export interface SenderOps {
  get(args: Input<'SenderRule/get'>): Output<'SenderRule/get'>;
  set(args: Input<'SenderRule/set'>): Output<'SenderRule/set'>;
  destroy(args: Input<'SenderRule/destroy'>): Receipt;
  block(args: Input<'SenderRule/block'>): Output<'SenderRule/block'>;
  unblock(args: Input<'SenderRule/unblock'>): Receipt;
}

const fail = (type: 'validation' | 'notFound' | 'conflict', message: string) =>
  new ContractError({ type, message });

// ------------------------------------------------------------ planning a rule over a thread

function ruleSteps(f: ThreadFacts, rule: Rule): Step[] {
  if (rule.action === 'skipInbox') return archive(f);
  if (rule.action !== 'block') return [];
  try {
    return spam(f);
  } catch (e) {
    // An account with no Spam folder still hides the thread from Home.
    if (e instanceof ContractError) return [];
    throw e;
  }
}

function planRule(f: ThreadFacts, rule: Rule, env: ActEnv): Plan | undefined {
  const facts = {
    rankSource: f.row.rank_source,
    lane: f.row.lane,
    hidden: f.row.hidden_from_home === 1,
  };
  const patch = rulePatch(rule, facts, env.now);
  const steps = ruleSteps(f, rule);
  if (!patch && !steps.length) return undefined;
  return { patch: { ...patch, editedAt: env.now }, steps };
}

/** Back from a block: out of Spam, shown on Home again. Only threads the block hid. */
function planUnblock(f: ThreadFacts, env: ActEnv): Plan | undefined {
  if (f.row.hidden_from_home !== 1) return undefined;
  return { patch: { hiddenFromHome: false, editedAt: env.now }, steps: restore(f) };
}

interface Scope {
  q: StoreReader;
  out: Built;
  env: ActEnv;
  opId: string;
  method: CommandMethod;
}

function applyRule(s: Scope, rule: Rule): void {
  const read = factsReader(s.q);
  const skip = new Set(s.out.targets);
  for (const id of threadsOf(s.q, rule)) {
    const facts = skip.has(id) ? undefined : read(id);
    const plan = facts && planRule(facts, rule, s.env);
    if (facts && plan) addThread(s.out, facts, plan, s.opId, s.method);
  }
}

// ------------------------------------------------------------ saving and removing

const putWrite = (r: Rule & { id?: number; remoteFilterId?: string | null }): StoreWrite => ({
  kind: 'senderRule',
  op: 'put',
  ...r,
});

function putRule(s: Scope, draft: Rule & { id?: number }): void {
  const current =
    draft.id === undefined ? ruleByKey(s.q, draft.accountId, draft.match) : ruleById(s.q, draft.id);
  if (draft.id !== undefined && !current) throw fail('notFound', 'This rule no longer exists.');
  const clash = ruleByKey(s.q, draft.accountId, draft.match);
  if (clash && clash.id !== current?.id)
    throw fail('conflict', 'There is already a rule for that sender.');
  s.out.writes.push(putWrite({ ...draft, id: current?.id }));
  s.out.restore.push(
    current
      ? putWrite(current)
      : { kind: 'senderRule', op: 'delete', accountId: draft.accountId, match: draft.match },
  );
  applyRule(s, draft);
}

/** Another block rule that still covers the sender keeps the thread blocked. */
function stillBlocked(q: StoreReader, f: ThreadFacts, gone: ReadonlySet<number>): boolean {
  const sender = senderOf(q, f.row.rowid);
  const rule = sender
    ? rulesCovering(q, f.row.account_id, sender).find(r => !gone.has(r.id))
    : undefined;
  return rule?.action === 'block';
}

function removeRules(s: Scope, rules: readonly RuleRow[]): void {
  const gone = new Set(rules.map(r => r.id));
  const read = factsReader(s.q);
  for (const rule of rules) {
    s.out.writes.push({ kind: 'senderRule', op: 'delete', id: rule.id });
    s.out.restore.push(putWrite(rule));
  }
  const skip = new Set(s.out.targets);
  for (const rule of rules.filter(r => r.action === 'block'))
    for (const id of threadsOf(s.q, rule)) {
      const facts = skip.has(id) ? undefined : read(id);
      const plan = facts && !stillBlocked(s.q, facts, gone) && planUnblock(facts, s.env);
      if (facts && plan) addThread(s.out, facts, plan, s.opId, s.method);
    }
}

// ------------------------------------------------------------ the wire

function ruleOut(q: StoreReader, row: RuleRow): SenderRule {
  const log = q.get<{ rev: number | null; first: number | null }>(
    "SELECT max(seq) AS rev, min(seq) AS first FROM changes WHERE type = 'SenderRule' AND id = ?",
    String(row.id),
  );
  const made =
    log?.first == null
      ? undefined
      : q.get<{ at: number }>('SELECT at FROM commits WHERE seq = ? LIMIT 1', log.first);
  return {
    id: String(row.id),
    rev: log?.rev ?? 0,
    ...(row.accountId ? { accountId: row.accountId } : {}),
    match: row.match,
    action: row.action,
    ...(row.lane ? { lane: row.lane } : {}),
    atProvider: row.remoteFilterId !== null,
    createdAt: made?.at ?? 0,
  };
}

interface DraftArgs {
  accountId?: string;
  match: string;
  action: Rule['action'];
  lane?: Rule['lane'];
}

function draftOf(args: DraftArgs): Rule {
  if (args.action === 'lane' && !args.lane)
    throw fail('validation', 'Choose a lane for this rule.');
  return {
    accountId: args.accountId ?? null,
    match: args.match.trim().toLowerCase(),
    action: args.action,
    ...(args.action === 'lane' ? { lane: args.lane } : {}),
  };
}

function requireAccount(q: StoreReader, accountId: string | null): void {
  if (accountId !== null && !q.get('SELECT 1 FROM accounts WHERE id = ?', accountId))
    throw fail('notFound', 'That account is not connected.');
}

export function createSenderOps(deps: CommandDeps): SenderOps {
  function command(opId: string, method: CommandMethod, plan: (s: Scope) => void): Receipt {
    const replay = priorReceipt(deps, opId, method);
    if (replay) return replay;
    const built = deps.store.read(q => {
      const out = emptyBuilt();
      plan({ q, out, env: readEnv(deps, q), opId, method });
      return out;
    });
    return commitBuilt(deps, opId, method, built);
  }

  function save(opId: string, method: CommandMethod, draft: Rule & { id?: number }) {
    const receipt = command(opId, method, s => {
      requireAccount(s.q, draft.accountId);
      putRule(s, draft);
    });
    const rule = deps.store.read(q => {
      const row = ruleByKey(q, draft.accountId, draft.match);
      return row && ruleOut(q, row);
    });
    if (!rule) throw fail('notFound', 'This rule no longer exists.');
    return { rule, receipt };
  }

  return {
    get: args =>
      deps.store.read(q => ({
        state: { dbEpoch: deps.store.dbEpoch, seq: deps.store.seq() },
        list: rulesFor(q, args.accountId).map(r => ruleOut(q, r)),
      })),
    set: args =>
      save(args.opId, 'SenderRule/set', {
        ...draftOf(args),
        id: args.id === undefined ? undefined : Number(args.id),
      }),
    block: args =>
      save(
        args.opId,
        'SenderRule/block',
        draftOf({ ...args, match: args.address, action: 'block' }),
      ),
    destroy: args =>
      command(args.opId, 'SenderRule/destroy', s => {
        const rule = ruleById(s.q, Number(args.id));
        if (!rule) throw fail('notFound', 'This rule no longer exists.');
        removeRules(s, [rule]);
      }),
    unblock: args =>
      command(args.opId, 'SenderRule/unblock', s =>
        removeRules(
          s,
          rulesByMatch(s.q, args.address.trim().toLowerCase()).filter(r => r.action === 'block'),
        ),
      ),
  };
}

// ------------------------------------------------------------ "Always do this for [sender]"

/** A `lane` or `laneStep` act that also asks for the sender's rule. */
export const alsoForSender = (action: ThreadAction): boolean =>
  (action.type === 'lane' || action.type === 'laneStep') && !!action.alsoForSender;

/**
 * Adds the lane rule for a thread's sender to a `Thread/act` commit and applies it to the sender's other threads.
 * A block rule on that sender stays as it is: a lane choice never unblocks.
 */
export function addSenderRule(
  q: StoreReader,
  out: Built,
  wanted: { facts: ThreadFacts; lane: NonNullable<Rule['lane']> },
  opId: string,
  env: ActEnv,
): void {
  const { facts, lane } = wanted;
  const sender = senderOf(q, facts.row.rowid);
  if (!sender) return;
  const accountId = facts.row.account_id;
  if (ruleByKey(q, accountId, sender)?.action === 'block') return;
  putRule(
    { q, out, env, opId, method: 'Thread/act' },
    { accountId, match: sender, action: 'lane', lane },
  );
}
