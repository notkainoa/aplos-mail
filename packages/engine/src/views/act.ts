import type { ThreadAction } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { FLAG, type StoreReader, type WorkflowFields } from '../store';
import { flagsStep, foldersStep, trashStep, untrashStep, type Step } from './ops';
import { isFromLater, threadByContractId, contractId, type ThreadDbRow } from './rows';
import { addDays } from './sections';

/*
 * What each `Thread/act` action does (views-3), per thread: a patch of the workflow row, which is local truth and
 * needs no replay, and the message edits the provider must learn (`Step`s). A plan reads the thread as it is now and
 * records what the edit replaces, so the same facts give the inverse (`undo.ts`).
 */

type ActionOf<K extends ThreadAction['type']> = Extract<ThreadAction, { type: K }>;
type MailAction = 'archive' | 'read' | 'unread';

export interface ActEnv {
  now: number;
  /** The owner's local day, `YYYY-MM-DD`. */
  today: string;
  followUpDays: number;
  doneAction: MailAction;
  laterAction: MailAction;
}

interface Roles {
  inbox?: string;
  trash?: string;
  spam?: string;
  archive?: string;
  important?: string;
}

interface MessageFacts {
  remoteId: string;
  seen: boolean;
  flagged: boolean;
  /** Folder remote ids. */
  folders: string[];
}

export interface ThreadFacts {
  row: ThreadDbRow;
  /** Messages that are not drafts, oldest first. */
  messages: MessageFacts[];
  roles: Roles;
  /** The user labels and folders of the thread's account (remote ids), the only ones a `labels` action may add. */
  userLabels: ReadonlySet<string>;
  /** The account files mail under labels (Gmail): a message keeps its other labels when it moves. */
  labels: boolean;
}

export interface Plan {
  patch: Partial<WorkflowFields>;
  steps: Step[];
}

// ------------------------------------------------------------ reading a thread

const ROLES = ['inbox', 'trash', 'spam', 'archive', 'important'] as const;

function rolesOf(q: StoreReader, accountId: string): Roles {
  const roles: Roles = {};
  for (const f of q.all<{ role: string; remote_id: string }>(
    `SELECT role, remote_id FROM folders WHERE account_id = ? AND role IN ('inbox', 'trash', 'spam', 'archive', 'important') ORDER BY id DESC`,
    accountId,
  ))
    if ((ROLES as readonly string[]).includes(f.role)) roles[f.role as keyof Roles] = f.remote_id;
  return roles;
}

function userLabelsOf(q: StoreReader, accountId: string): Set<string> {
  return new Set(
    q
      .all<{ remote_id: string }>(
        "SELECT remote_id FROM folders WHERE account_id = ? AND role IS NULL AND kind IN ('label', 'folder')",
        accountId,
      )
      .map(f => f.remote_id),
  );
}

function labelsOf(q: StoreReader, accountId: string): boolean {
  const row = q.get<{ labels: number | null }>(
    "SELECT json_extract(capabilities, '$.labels') AS labels FROM accounts WHERE id = ?",
    accountId,
  );
  return row?.labels === 1;
}

function messagesOf(q: StoreReader, threadRowId: number): MessageFacts[] {
  const placed = new Map<number, string[]>();
  for (const p of q.all<{ mid: number; remote_id: string }>(
    `SELECT mf.message_id AS mid, f.remote_id FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
     WHERE mf.message_id IN (SELECT id FROM messages WHERE thread_id = ?)`,
    threadRowId,
  ))
    placed.set(p.mid, [...(placed.get(p.mid) ?? []), p.remote_id]);
  return q
    .all<{ id: number; remote_id: string; flags: number }>(
      'SELECT id, remote_id, flags FROM messages WHERE thread_id = ? AND (flags & 8) = 0 ORDER BY internal_date, id',
      threadRowId,
    )
    .map(m => ({
      remoteId: m.remote_id,
      seen: (m.flags & FLAG.seen) !== 0,
      flagged: (m.flags & FLAG.flagged) !== 0,
      folders: placed.get(m.id) ?? [],
    }));
}

/** Reads threads for planning, remembering each account's folders and kind. */
export function factsReader(q: StoreReader) {
  const accounts = q.all<{ id: string }>('SELECT id FROM accounts').map(a => a.id);
  const roles = new Map<string, Roles>();
  const labels = new Map<string, boolean>();
  const userLabels = new Map<string, Set<string>>();
  return (id: string): ThreadFacts | undefined => {
    const row = threadByContractId(q, id, accounts);
    if (!row) return undefined;
    if (!roles.has(row.account_id)) {
      roles.set(row.account_id, rolesOf(q, row.account_id));
      labels.set(row.account_id, labelsOf(q, row.account_id));
      userLabels.set(row.account_id, userLabelsOf(q, row.account_id));
    }
    return {
      row,
      messages: messagesOf(q, row.rowid),
      roles: roles.get(row.account_id)!,
      userLabels: userLabels.get(row.account_id)!,
      labels: labels.get(row.account_id)!,
    };
  };
}

/** `mail.doneAction` and `mail.laterAction` from the settings document, or their defaults. */
export function mailActions(q: StoreReader): Pick<ActEnv, 'doneAction' | 'laterAction'> {
  const row = q.get<{ done: string | null; later: string | null }>(
    "SELECT json_extract(data, '$.mail.doneAction') AS done, json_extract(data, '$.mail.laterAction') AS later FROM settings WHERE id = 1",
  );
  const pick = (v: string | null | undefined, fallback: MailAction): MailAction =>
    v === 'archive' || v === 'read' || v === 'unread' ? v : fallback;
  return { doneAction: pick(row?.done, 'archive'), laterAction: pick(row?.later, 'read') };
}

// ------------------------------------------------------------ message edits

const newest = (f: ThreadFacts) => f.messages[f.messages.length - 1];

function setSeen(f: ThreadFacts, seen: boolean): Step[] {
  return f.messages
    .filter(m => m.seen !== seen)
    .map(m => flagsStep(m.remoteId, { seen }, { seen: m.seen }));
}

/** Done with "mark unread" marks the newest message unread, which is what shows the thread as unread again. */
function markUnread(f: ThreadFacts): Step[] {
  const last = newest(f);
  if (!last || !last.seen) return [];
  return [flagsStep(last.remoteId, { seen: false }, { seen: true })];
}

/** Out of the Inbox: moved to the account's Archive where it has one (IMAP), else just no longer in the Inbox. */
export function archive(f: ThreadFacts): Step[] {
  const { inbox, archive: to } = f.roles;
  if (!inbox) return [];
  return f.messages
    .filter(m => m.folders.includes(inbox))
    .map(m => foldersStep(m.remoteId, to && !m.folders.includes(to) ? [to] : [], [inbox]));
}

function after(f: ThreadFacts, mode: MailAction): Step[] {
  if (mode === 'archive') return archive(f);
  return mode === 'read' ? setSeen(f, true) : markUnread(f);
}

function need(folder: string | undefined, what: string): string {
  if (folder) return folder;
  throw new ContractError({
    type: 'unsupported',
    message: `This account has no ${what} folder, so Aplos cannot do that here.`,
  });
}

/** What a message leaves when it moves to Trash or Spam: its Inbox place, or on a folder account everything. */
const leaving = (f: ThreadFacts, m: MessageFacts, into: string) =>
  f.labels ? m.folders.filter(x => x === f.roles.inbox) : m.folders.filter(x => x !== into);

function trash(f: ThreadFacts): Step[] {
  const into = need(f.roles.trash, 'Trash');
  return f.messages
    .filter(m => !m.folders.includes(into))
    .map(m => trashStep(m.remoteId, into, leaving(f, m, into)));
}

export function spam(f: ThreadFacts): Step[] {
  const into = need(f.roles.spam, 'Spam');
  return f.messages
    .filter(m => !m.folders.includes(into))
    .map(m => foldersStep(m.remoteId, [into], leaving(f, m, into)));
}

/** Back to the Inbox: out of Trash and Spam, into the Inbox. */
export function restore(f: ThreadFacts): Step[] {
  const { inbox, trash: bin, spam: junk } = f.roles;
  const steps: Step[] = [];
  for (const m of f.messages) {
    if (bin && m.folders.includes(bin)) steps.push(untrashStep(m.remoteId, bin));
    const out = junk && m.folders.includes(junk) ? [junk] : [];
    const into = inbox && !m.folders.includes(inbox) ? [inbox] : [];
    if (into.length || out.length) steps.push(foldersStep(m.remoteId, into, out));
  }
  return steps;
}

function flag(f: ThreadFacts, on: boolean): Step[] {
  if (on) {
    const last = newest(f);
    if (!last || f.messages.some(m => m.flagged)) return [];
    return [flagsStep(last.remoteId, { flagged: true }, { flagged: false })];
  }
  return f.messages
    .filter(m => m.flagged)
    .map(m => flagsStep(m.remoteId, { flagged: false }, { flagged: true }));
}

/** Adds and removes the folders a `labels` action names for this thread's own account. */
function relabel(f: ThreadFacts, add: string[], remove: string[]): Step[] {
  const mine = (ids: string[]) =>
    ids
      .filter(id => id.startsWith(`${f.row.account_id}:`))
      .map(id => id.slice(f.row.account_id.length + 1));
  const [put, take] = [mine(add), mine(remove)];
  const unknown = put.find(x => !f.userLabels.has(x));
  if (unknown !== undefined)
    throw new ContractError({
      type: 'validation',
      message: 'That label does not exist in this account.',
    });
  const steps: Step[] = [];
  for (const m of f.messages) {
    const gain = put.filter(x => !m.folders.includes(x));
    const lose = take.filter(x => m.folders.includes(x) && !put.includes(x));
    if (gain.length || lose.length) steps.push(foldersStep(m.remoteId, gain, lose));
  }
  return steps;
}

function important(f: ThreadFacts, on: boolean): Step[] {
  const label = f.roles.important;
  if (!label || !f.labels) return [];
  return f.messages
    .filter(m => m.folders.includes(label) !== on)
    .map(m => foldersStep(m.remoteId, on ? [label] : [], on ? [] : [label]));
}

// ------------------------------------------------------------ workflow patches

const LANES = ['do', 'update', 'low'] as const;
const USER = (env: ActEnv): Partial<WorkflowFields> => ({ rankSource: 'user', rankedAt: env.now });

/** 0 overdue or due today, 1 tomorrow, 2 within 7 days, 3 later or undated (the contract's `Rank.dueBand`). */
export function dueBandOf(date: string | null | undefined, today: string): 0 | 1 | 2 | 3 {
  if (!date) return 3;
  if (date <= today) return 0;
  if (date === addDays(today, 1)) return 1;
  return date <= addDays(today, 7) ? 2 : 3;
}

type Planner<K extends ThreadAction['type']> = (
  f: ThreadFacts,
  a: ActionOf<K>,
  env: ActEnv,
) => Plan | undefined;

const only = (patch: Partial<WorkflowFields>, steps: Step[] = []): Plan => ({ patch, steps });

const planners: { [K in ThreadAction['type']]: Planner<K> } = {
  done: (f, _a, env) => only({ status: 'done', laterUntil: null }, after(f, env.doneAction)),
  restore: f => only({ status: 'new', laterUntil: null, hiddenFromHome: false }, restore(f)),
  later: (f, a, env) =>
    only(
      { status: 'later', laterUntil: a.until ?? null, hiddenFromHome: false },
      after(f, env.laterAction),
    ),
  trash: f => only({}, trash(f)),
  spam: f => only({}, spam(f)),
  read: f => only({}, setSeen(f, true)),
  unread: f => only({}, markUnread(f)),
  flag: (f, a) => only({}, flag(f, a.on)),
  bookmark: (_f, a) => only({ bookmarked: a.on }),
  due: (_f, a, env) =>
    only({
      dueDate: a.date ?? null,
      dueSource: a.date ? 'user' : null,
      dueBand: dueBandOf(a.date, env.today),
    }),
  reminder: (_f, a, env) => {
    if (a.clear) return only({ reminderAt: null, reminderFiredAt: null });
    const at = a.at ?? env.now + env.followUpDays * 86_400_000;
    return only({ reminderAt: at, reminderFiredAt: null });
  },
  // `alsoForSender` is the sender rule of views-4; the lane itself is applied here.
  lane: (_f, a, env) => only({ lane: a.lane, ...USER(env) }),
  laneStep: (f, a, env) => {
    const at = LANES.indexOf(f.row.lane as (typeof LANES)[number]);
    const next = Math.max(0, Math.min(2, (at < 0 ? 1 : at) + (a.direction === 'up' ? -1 : 1)));
    return only({ lane: LANES[next], ...USER(env) });
  },
  importance: (f, a, env) =>
    only({ importance: a.importance, ...USER(env) }, important(f, a.importance === 'important')),
  replyStatus: (_f, a) => only({ replyStatus: a.status }),
  todo: (_f, a) => only({ todo: a.text || null }),
  home: (_f, a) => only({ hiddenFromHome: a.hidden }),
  // Back from Later only: the thread stays in Later with its own date and leaves Home until acted on.
  clearFromHome: (f, _a, env) =>
    isFromLater(f.row, env.now) ? only({ hiddenFromHome: true }) : undefined,
  labels: (f, a) => only({}, relabel(f, a.add, a.remove)),
};

/** A thread's patch and message edits for an action; undefined when the action leaves this thread alone. */
export function planThread(f: ThreadFacts, action: ThreadAction, env: ActEnv): Plan | undefined {
  const plan = (planners[action.type] as Planner<ThreadAction['type']>)(f, action as never, env);
  if (!plan) return undefined;
  return { patch: { ...plan.patch, editedAt: env.now }, steps: plan.steps };
}

// ------------------------------------------------------------ before images

const COLUMN: Partial<Record<keyof WorkflowFields, keyof ThreadDbRow>> = {
  status: 'status',
  laterUntil: 'later_until',
  dueDate: 'due_date',
  dueSource: 'due_source',
  reminderAt: 'reminder_at',
  reminderFiredAt: 'reminder_fired_at',
  bookmarked: 'bookmarked',
  replyStatus: 'reply_status',
  todo: 'todo',
  hiddenFromHome: 'hidden_from_home',
  lane: 'lane',
  importance: 'importance',
  rankSource: 'rank_source',
  rankedAt: 'ranked_at',
  dueBand: 'due_band',
  editedAt: 'edited_at',
};

const BOOLEAN_FIELDS = new Set<keyof WorkflowFields>(['bookmarked', 'hiddenFromHome']);

/** The values `patch` replaces, so writing them back restores the row. */
export function beforeOf(
  row: ThreadDbRow,
  patch: Partial<WorkflowFields>,
): Partial<WorkflowFields> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof WorkflowFields)[]) {
    const value = row[COLUMN[key] as keyof ThreadDbRow] ?? null;
    out[key] = BOOLEAN_FIELDS.has(key) && value !== null ? value === 1 : value;
  }
  return out as Partial<WorkflowFields>;
}

export const idOf = (f: ThreadFacts) => contractId(f.row);
