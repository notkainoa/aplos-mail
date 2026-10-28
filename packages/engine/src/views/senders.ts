import type { WorkflowFields } from '../store';
import { FLAG, type CommitExtension, type CommitExtensionTx, type StoreReader } from '../store';

/*
 * Sender rules (views-4): the `sender_rules` table, its writer (seam 2) and the ingest hook that applies a rule to new
 * mail inside the commit that stores it. `remote_filter_id` belongs to `prov-gmail-write`; this lane never changes it.
 * The table has no `lane` column, so a lane rule is stored as `lane:<lane>` in `action`.
 *
 * Precedence (ARCH 8.2): a rule beats a heuristic or AI lane and an older rule, but never a lane the user set on that
 * thread (`rank_source = 'user'`). A block or skip-Inbox rule only hides the thread from Home; it never touches the lane.
 */

export type RuleAction = 'block' | 'lane' | 'skipInbox';
export type RuleLane = 'do' | 'update' | 'low';

/** A rule as the engine uses it. `accountId` null means every account. */
export interface Rule {
  accountId: string | null;
  match: string;
  action: RuleAction;
  lane?: RuleLane;
}

export interface RuleRow extends Rule {
  id: number;
  remoteFilterId: string | null;
}

export type SenderRuleWrite =
  | (Rule & { kind: 'senderRule'; op: 'put'; id?: number; remoteFilterId?: string | null })
  | { kind: 'senderRule'; op: 'delete'; id?: number; accountId?: string | null; match?: string };

declare module '../store/port' {
  interface ExtensionWrites {
    senderRule: SenderRuleWrite;
  }
}

/** Reads over a store reader or a commit extension's transaction. */
export type Sql = Pick<StoreReader, 'get' | 'all'>;

// ------------------------------------------------------------ the table

const encode = (r: Rule) => (r.action === 'lane' ? `lane:${r.lane}` : r.action);

const LANES: readonly string[] = ['do', 'update', 'low'];

/** A row another lane wrote may hold anything; an action this lane does not know is ignored, never guessed at. */
function decode(action: string): Pick<Rule, 'action' | 'lane'> | undefined {
  if (action === 'block' || action === 'skipInbox') return { action };
  const lane = action.startsWith('lane:') ? action.slice(5) : '';
  return LANES.includes(lane) ? { action: 'lane', lane: lane as RuleLane } : undefined;
}

interface RuleDb {
  id: number;
  account_id: string | null;
  address_or_domain: string;
  action: string;
  remote_filter_id: string | null;
  [k: string]: string | number | null;
}

const COLS = 'id, account_id, address_or_domain, action, remote_filter_id';

function rowOf(r: RuleDb): RuleRow | undefined {
  const what = decode(r.action);
  if (!what) return undefined;
  return {
    id: r.id,
    accountId: r.account_id,
    match: r.address_or_domain,
    remoteFilterId: r.remote_filter_id,
    ...what,
  };
}

const rowsOf = (rows: RuleDb[]) => rows.flatMap(r => rowOf(r) ?? []);

export const ruleById = (sql: Sql, id: number): RuleRow | undefined => {
  const r = sql.get<RuleDb>(`SELECT ${COLS} FROM sender_rules WHERE id = ?`, id);
  return r && rowOf(r);
};

/** The rule for exactly this account scope and match. */
export const ruleByKey = (
  sql: Sql,
  accountId: string | null,
  match: string,
): RuleRow | undefined => {
  const r = sql.get<RuleDb>(
    `SELECT ${COLS} FROM sender_rules WHERE account_id IS ? AND address_or_domain = ?`,
    accountId,
    match,
  );
  return r && rowOf(r);
};

export const rulesFor = (sql: Sql, accountId?: string): RuleRow[] =>
  rowsOf(
    sql.all<RuleDb>(
      `SELECT ${COLS} FROM sender_rules WHERE ? IS NULL OR account_id IS NULL OR account_id = ? ORDER BY id`,
      accountId ?? null,
      accountId ?? null,
    ),
  );

/** Every rule on an exact match, in any account scope. */
export const rulesByMatch = (sql: Sql, match: string): RuleRow[] =>
  rowsOf(
    sql.all<RuleDb>(
      `SELECT ${COLS} FROM sender_rules WHERE address_or_domain = ? ORDER BY id`,
      match,
    ),
  );

const domainOf = (address: string) => address.slice(address.lastIndexOf('@'));

/** The rules that cover a sender in an account, the one that governs first: the exact address before its domain, an account's own before a global. */
export function rulesCovering(sql: Sql, accountId: string, address: string): RuleRow[] {
  return rowsOf(
    sql.all<RuleDb>(
      `SELECT ${COLS} FROM sender_rules WHERE (account_id IS NULL OR account_id = ?) AND address_or_domain IN (?, ?)
       ORDER BY (address_or_domain = ?) DESC, (account_id IS NOT NULL) DESC, id`,
      accountId,
      address,
      domainOf(address),
      address,
    ),
  );
}

/** How early a rule governs a sender: 0 is the exact address, an account's own before a global rule; lower wins. */
export const precedence = (rule: Pick<Rule, 'accountId' | 'match'>, address: string) =>
  (rule.match === address ? 0 : 2) + (rule.accountId === null ? 1 : 0);

/** Every rule at once, by address or domain, so a batch of new mail reads the table one time. */
export type RuleIndex = ReadonlyMap<string, RuleRow[]>;

export function indexRules(sql: Sql): RuleIndex {
  const index = new Map<string, RuleRow[]>();
  for (const rule of rulesFor(sql)) index.set(rule.match, [...(index.get(rule.match) ?? []), rule]);
  return index;
}

/** The rule that governs a sender in an account, from an index. */
export function governing(
  index: RuleIndex,
  accountId: string,
  address: string,
): RuleRow | undefined {
  const found = [...(index.get(address) ?? []), ...(index.get(domainOf(address)) ?? [])];
  return found
    .filter(r => r.accountId === null || r.accountId === accountId)
    .sort((a, b) => precedence(a, address) - precedence(b, address) || a.id - b.id)[0];
}

// ------------------------------------------------------------ senders and matching

/** Lower-cased address of the newest message the owner did not write, the sender a rule is matched against. */
export function senderOf(sql: Sql, threadRowId: number): string | undefined {
  const m = sql.get<{ a: string | null }>(
    `SELECT lower(from_addr) AS a FROM messages WHERE thread_id = ? AND (flags & ${FLAG.draft | FLAG.fromMe}) = 0
     ORDER BY internal_date DESC, id DESC LIMIT 1`,
    threadRowId,
  );
  return m?.a?.trim() || undefined;
}

export const matches = (match: string, address: string) =>
  match.startsWith('@') ? address.endsWith(match) : address === match;

/** Contract ids of the threads whose sender the rule matches, in its account scope. */
export function threadsOf(sql: Sql, rule: Pick<Rule, 'accountId' | 'match'>): string[] {
  const domain = rule.match.startsWith('@');
  const found = sql.all<{ id: number; a: string; r: string }>(
    `SELECT DISTINCT t.id AS id, t.account_id AS a, t.remote_id AS r FROM messages m JOIN threads t ON t.id = m.thread_id
     WHERE (m.flags & ${FLAG.draft | FLAG.fromMe}) = 0 AND (? IS NULL OR m.account_id = ?)
       AND ${domain ? 'substr(lower(m.from_addr), -?) = ?' : 'lower(m.from_addr) = ?'} ORDER BY t.id`,
    rule.accountId,
    rule.accountId,
    ...(domain ? [rule.match.length] : []),
    rule.match,
  );
  return found
    .filter(t => matches(rule.match, senderOf(sql, t.id) ?? ''))
    .map(t => `${t.a}:${t.r}`);
}

// ------------------------------------------------------------ precedence

export interface RankFacts {
  rankSource: string;
  lane: string;
  hidden: boolean;
}

/** What a rule changes on a thread's workflow row, or undefined when it changes nothing. */
export function rulePatch(
  rule: Pick<Rule, 'action' | 'lane'>,
  facts: RankFacts,
  now: number,
): Partial<WorkflowFields> | undefined {
  if (rule.action !== 'lane') return facts.hidden ? undefined : { hiddenFromHome: true };
  if (facts.rankSource === 'user') return undefined;
  if (facts.rankSource === 'rule' && facts.lane === rule.lane) return undefined;
  return { lane: rule.lane, rankSource: 'rule', rankedAt: now };
}

// ------------------------------------------------------------ the writer

function put(w: Extract<SenderRuleWrite, { op: 'put' }>, tx: CommitExtensionTx): void {
  const found = w.id === undefined ? ruleByKey(tx, w.accountId, w.match) : ruleById(tx, w.id);
  if (found) {
    tx.run(
      'UPDATE sender_rules SET account_id = ?, address_or_domain = ?, action = ?, remote_filter_id = ? WHERE id = ?',
      w.accountId,
      w.match,
      encode(w),
      w.remoteFilterId === undefined ? found.remoteFilterId : w.remoteFilterId,
      found.id,
    );
    tx.mark('SenderRule', String(found.id), 'u');
    return;
  }
  const inserted = tx.run(
    'INSERT INTO sender_rules(id, account_id, address_or_domain, action, remote_filter_id) VALUES(?, ?, ?, ?, ?)',
    w.id ?? null,
    w.accountId,
    w.match,
    encode(w),
    w.remoteFilterId ?? null,
  );
  tx.mark('SenderRule', String(inserted.lastInsertRowid), 'u');
}

function remove(w: Extract<SenderRuleWrite, { op: 'delete' }>, tx: CommitExtensionTx): void {
  const found =
    w.id !== undefined ? ruleById(tx, w.id) : ruleByKey(tx, w.accountId ?? null, w.match ?? '');
  if (!found) return;
  tx.run('DELETE FROM sender_rules WHERE id = ?', found.id);
  tx.mark('SenderRule', String(found.id), 'd');
}

// ------------------------------------------------------------ new mail

function applyToThread(
  tx: CommitExtensionTx,
  rules: RuleIndex,
  accountId: string,
  remoteThreadId: string,
): void {
  const id = tx.threadRowId(accountId, remoteThreadId);
  const sender = id === undefined ? undefined : senderOf(tx, id);
  if (id === undefined || !sender) return;
  const rule = governing(rules, accountId, sender);
  const wf = tx.get<{ rank_source: string; lane: string; hidden: number | null }>(
    'SELECT rank_source, lane, hidden_from_home AS hidden FROM thread_workflow WHERE thread_id = ?',
    id,
  );
  if (!rule || !wf) return;
  const patch = rulePatch(
    rule,
    { rankSource: wf.rank_source, lane: wf.lane, hidden: wf.hidden === 1 },
    tx.now(),
  );
  if (!patch) return;
  if (rule.action === 'lane')
    tx.run(
      "UPDATE thread_workflow SET lane = ?, rank_source = 'rule', ranked_at = ? WHERE thread_id = ?",
      rule.lane ?? 'update',
      tx.now(),
      id,
    );
  else tx.run('UPDATE thread_workflow SET hidden_from_home = 1 WHERE thread_id = ?', id);
  tx.touchThread(accountId, remoteThreadId);
}

/** Mail that arrives by sync (not a search hit, not the owner's own) meets the rules inside its commit. */
function ingest(
  batch: Parameters<NonNullable<CommitExtension['ingest']>>[0],
  tx: CommitExtensionTx,
) {
  if (batch.origin !== 'sync') return;
  const done = new Set<string>();
  const rules = indexRules(tx);
  for (const m of batch.messages) {
    const key = `${m.accountId}\0${m.remoteThreadId}`;
    if (!m.added || m.origin === 'search' || m.flags.fromMe || m.flags.draft || done.has(key))
      continue;
    done.add(key);
    // A throw here would roll back the account's whole sync commit on every retry: bad data skips the thread.
    try {
      applyToThread(tx, rules, m.accountId, m.remoteThreadId);
    } catch {
      // This thread keeps the rank it arrived with.
    }
  }
}

/** The lane's writer for `sender_rules` (seam 2). */
export const senderRuleExtension: CommitExtension = {
  lane: 'eng-views',
  kinds: ['senderRule'],
  changeTypes: ['SenderRule'],
  apply(write, tx) {
    const w = write as SenderRuleWrite;
    if (w.op === 'put') put(w, tx);
    else remove(w, tx);
  },
  ingest,
};
