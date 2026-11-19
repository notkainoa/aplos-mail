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
import {
  priorReceipt,
  type CommandDeps,
  type Journal,
  type RecordedThread,
  type Step,
} from './ops';
import {
  ruleById,
  ruleByKey,
  precedence,
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

const inSpam = (f: ThreadFacts) =>
  !!f.roles.spam && f.messages.some(m => m.folders.includes(f.roles.spam!));

/** What a removed block changed on a thread, from the journal of the commands that applied it (newest first). */
function blockImages(journal: Journal, removed: readonly RuleRow[], f: ThreadFacts) {
  const ofRule = (w: StoreWrite) =>
    w.kind === 'senderRule' &&
    removed.some(r => r.accountId === (w.accountId ?? null) && r.match === w.match);
  const here = (t: RecordedThread) =>
    t.accountId === f.row.account_id && t.remoteThreadId === f.row.remote_id;
  return journal
    .filter(
      r =>
        !r.undone &&
        (r.method === 'SenderRule/block' || r.method === 'SenderRule/set') &&
        !!r.restore?.some(ofRule),
    )
    .flatMap(r => r.threads.filter(here));
}

/** Rules that keep a thread out of the Inbox put an unblocked thread in the archive instead. */
const toArchive = (f: ThreadFacts): ThreadFacts => ({
  ...f,
  roles: { ...f.roles, inbox: f.roles.archive },
});

/**
 * Back from a block: out of Spam, shown on Home again, but only what the block itself did. With the block's journal
 * that is a thread still in Spam (or one without a Spam folder) and, if the block hid it, hidden again. Without it, a
 * thread that is in Spam and hidden. A thread the owner hid or moved is left as it is.
 */
function planUnblock(
  f: ThreadFacts,
  env: ActEnv,
  images: readonly RecordedThread[],
  quiet: boolean,
): Plan | undefined {
  const hidden = f.row.hidden_from_home === 1;
  const moved = !!f.roles.spam && !inSpam(f);
  const mine = images.length ? !moved : inSpam(f) && hidden;
  if (!mine) return undefined;
  const blockHid = !images.length || images.some(i => 'hiddenFromHome' in i.before);
  const unhide = hidden && blockHid && !quiet;
  const steps = inSpam(f) ? restore(quiet ? toArchive(f) : f) : [];
  if (!unhide && !steps.length) return undefined;
  return { patch: { ...(unhide ? { hiddenFromHome: false } : {}), editedAt: env.now }, steps };
}

interface Scope {
  q: StoreReader;
  out: Built;
  env: ActEnv;
  opId: string;
  method: CommandMethod;
}

/** The rule governs the thread's sender once saved: no rule that is more specific (replacing `replaced`) covers it. */
function governs(q: StoreReader, f: ThreadFacts, rule: Rule, replaced?: number): boolean {
  const sender = senderOf(q, f.row.rowid);
  if (!sender) return false;
  const mine = precedence(rule, sender);
  return rulesCovering(q, f.row.account_id, sender).every(
    r => r.id === replaced || precedence(r, sender) > mine,
  );
}

function applyRule(s: Scope, rule: Rule, replaced?: number): void {
  const read = factsReader(s.q);
  const skip = new Set(s.out.targets);
  for (const id of threadsOf(s.q, rule)) {
    const facts = skip.has(id) ? undefined : read(id);
    const plan = facts && governs(s.q, facts, rule, replaced) && planRule(facts, rule, s.env);
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
  applyRule(s, draft, current?.id);
}

/** After the removal: another block still holds the thread; a skip-Inbox rule keeps it out of the Inbox. */
function planRemoval(
  s: Scope,
  journal: Journal,
  f: ThreadFacts,
  removed: readonly RuleRow[],
): Plan | undefined {
  const sender = senderOf(s.q, f.row.rowid);
  const gone = new Set(removed.map(r => r.id));
  const left = sender
    ? rulesCovering(s.q, f.row.account_id, sender).filter(r => !gone.has(r.id))
    : [];
  if (left.some(r => r.action === 'block')) return undefined;
  const quiet = left.some(r => r.action === 'skipInbox');
  return planUnblock(f, s.env, blockImages(journal, removed, f), quiet);
}

function removeRules(s: Scope, journal: Journal, rules: readonly RuleRow[]): void {
  for (const rule of rules) {
    s.out.writes.push({ kind: 'senderRule', op: 'delete', id: rule.id });
    s.out.restore.push(putWrite(rule));
  }
  const blocks = rules.filter(r => r.action === 'block');
  const ids = new Set(blocks.flatMap(rule => threadsOf(s.q, rule)));
  const read = factsReader(s.q);
  for (const id of ids) {
    const facts = read(id);
    const plan = facts && planRemoval(s, journal, facts, rules);
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
        removeRules(s, deps.journal, [rule]);
      }),
    unblock: args =>
      command(args.opId, 'SenderRule/unblock', s =>
        removeRules(
          s,
          deps.journal,
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
