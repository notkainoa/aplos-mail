import type { Account, Thread } from '@aplos/contract/legacy/types';

/**
 * Aplos workflow state that syncs between devices through an encrypted blob in each account's hidden
 * "Aplos" folder. Trash and spam are host state, so a thread there has no workflow fields of its own.
 */
export interface WorkflowFields {
  status: 'new' | 'done' | 'later';
  replyStatus: Thread['replyStatus'];
  reminderAt?: string;
  reminderFired?: true;
  dueDate?: string;
  todo?: string;
  hiddenFromHome?: true;
}
export interface WorkflowEntry {
  fields: WorkflowFields;
  /** Epoch ms of the user's edit. */ at: number;
  device: string;
}
/**
 * Last writer wins per thread; ties go to the larger device ID, then the larger fields.
 * `floor` is the compaction watermark: a key missing from the log whose entry is no newer than the floor
 * was dropped on purpose, so a copy of that entry held elsewhere is not taken back in. A missing key never
 * means "cleared"; it only means "nothing to apply".
 */
export interface WorkflowLog {
  version: 1;
  entries: Record<string, WorkflowEntry>;
  floor?: number;
}
export interface WorkflowPatch {
  threadId: string;
  patch: Partial<Thread>;
}
/**
 * A user edit waiting to be shared: the thread's fields right after the edit (none in Trash or Spam), when
 * it happened, and a per-account generation that tells a round whether the thread was edited again meanwhile.
 * Both key schemes are kept because the edit is recorded before the account's provider is at hand.
 */
export interface WorkflowEdit {
  keys: Partial<Record<KeyScheme, string>>;
  fields?: WorkflowFields;
  at: number;
  gen: number;
}

/**
 * How threads are keyed in one account's log. Gmail thread IDs, Graph conversation IDs and JMAP thread IDs
 * are assigned by the host and identical on every device (`thread`). IMAP thread keys are built locally from
 * whichever messages a device happened to index, so IMAP keys by the thread's root Message-ID (`message`).
 * Hosts with their own IDs do not key by Message-ID because they can split one References chain into
 * several threads (Gmail does on a subject change), which would make those threads share an entry.
 */
export type KeyScheme = 'thread' | 'message';
export const keySchemeFor = (provider: Account['provider']): KeyScheme =>
  provider === 'imap' ? 'message' : 'thread';

export const WORKFLOW_RETENTION_MS = 180 * 86_400_000;
export const WORKFLOW_MAX_ENTRIES = 20_000;

export const emptyWorkflowLog = (): WorkflowLog => ({ version: 1, entries: {} });
const withFloor = (entries: Record<string, WorkflowEntry>, floor: number): WorkflowLog =>
  floor > 0 ? { version: 1, entries, floor } : { version: 1, entries };
const ids = (value: string | undefined) =>
  [...(value ?? '').matchAll(/<([^<>\s]+)>/g)].map(m => m[1]);
const bare = (value: string | undefined) => value?.trim().replace(/^<|>$/g, '').trim() || undefined;

/**
 * Stable key for a thread within its account's log, or undefined when the thread has nothing stable.
 * `message`: the first References entry of the oldest message (the conversation's root, which every reply
 * carries), else that message's own Message-ID; falls back to the remote ID.
 */
export function threadKey(thread: Thread, scheme: KeyScheme = 'thread'): string | undefined {
  if (scheme === 'message') {
    const first = [...thread.messages].sort((a, b) => a.date.localeCompare(b.date))[0];
    const root = ids(first?.references)[0] ?? bare(first?.internetId);
    if (root) return `m:${root}`;
  }
  return thread.remoteId ? `t:${thread.remoteId}` : undefined;
}

/** The thread's workflow fields in canonical form (unset and false values omitted), or undefined in Trash/Spam. */
export function workflowFields(thread: Thread): WorkflowFields | undefined {
  if (thread.status === 'trash' || thread.status === 'spam') return undefined;
  return {
    status: thread.status,
    replyStatus: thread.replyStatus ?? 'none',
    ...(thread.reminderAt ? { reminderAt: thread.reminderAt } : {}),
    ...(thread.reminderFired ? { reminderFired: true as const } : {}),
    ...(thread.dueDate ? { dueDate: thread.dueDate } : {}),
    ...(thread.todo ? { todo: thread.todo } : {}),
    ...(thread.hiddenFromHome ? { hiddenFromHome: true as const } : {}),
  };
}
const FIELD_ORDER = [
  'status',
  'replyStatus',
  'reminderAt',
  'reminderFired',
  'dueDate',
  'todo',
  'hiddenFromHome',
] as const;
const canonical = (fields: WorkflowFields) =>
  JSON.stringify(FIELD_ORDER.map(k => fields[k] ?? null));
export const sameFields = (a: WorkflowFields | undefined, b: WorkflowFields | undefined) =>
  !!a && !!b && canonical(a) === canonical(b);
/** Fields that say nothing beyond what the host itself shows (inbox or archived). */
const plain = (fields: WorkflowFields) =>
  (fields.status === 'new' || fields.status === 'done') &&
  fields.replyStatus === 'none' &&
  FIELD_ORDER.slice(2).every(k => fields[k] === undefined);

/** Positive when `a` wins over `b`. A total order, so merging does not depend on argument order. */
function compare(a: WorkflowEntry, b: WorkflowEntry): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  const x = canonical(a.fields),
    y = canonical(b.fields);
  return x === y ? 0 : x < y ? -1 : 1;
}
const sameEntry = (a: WorkflowEntry | undefined, b: WorkflowEntry | undefined) =>
  a === b || (!!a && !!b && compare(a, b) === 0);
/** Identifies an entry for "already applied" bookkeeping. */
export const entryStamp = (entry: WorkflowEntry) => `${entry.at}:${entry.device}`;
export function sameLog(a: WorkflowLog | undefined, b: WorkflowLog | undefined): boolean {
  const x = a?.entries ?? {},
    y = b?.entries ?? {},
    keys = Object.keys(x);
  return (
    (a?.floor ?? 0) === (b?.floor ?? 0) &&
    keys.length === Object.keys(y).length &&
    keys.every(k => sameEntry(x[k], y[k]))
  );
}

/** The record `noteEdits` keeps for a thread right after the user changed it. */
export const workflowEdit = (thread: Thread, at: number, gen: number): WorkflowEdit => {
  const keys: WorkflowEdit['keys'] = {},
    t = threadKey(thread, 'thread'),
    m = threadKey(thread, 'message'),
    fields = workflowFields(thread);
  if (t) keys.thread = t;
  if (m) keys.message = m;
  return { keys, ...(fields ? { fields } : {}), at, gen };
};

/**
 * Union keeping the winning entry per key. An entry is dropped when a log that lacks its key has a floor at
 * or above it (that log compacted it away). Taking every log at once keeps the result independent of order.
 */
export function mergeLogs(...logs: WorkflowLog[]): WorkflowLog {
  const entries: Record<string, WorkflowEntry> = {};
  for (const key of new Set(logs.flatMap(l => Object.keys(l.entries)))) {
    let best: WorkflowEntry | undefined,
      floor = 0;
    for (const l of logs) {
      const e = l.entries[key];
      if (!e) floor = Math.max(floor, l.floor ?? 0);
      else if (!best || compare(e, best) > 0) best = e;
    }
    if (best && best.at > floor) entries[key] = best;
  }
  return withFloor(entries, Math.max(0, ...logs.map(l => l.floor ?? 0)));
}

/** Drop old entries that say nothing beyond the host's own state, then keep the newest `max`; raise the floor past what was dropped. */
export function compactLog(
  log: WorkflowLog,
  now: number,
  max = WORKFLOW_MAX_ENTRIES,
  retention = WORKFLOW_RETENTION_MS,
): WorkflowLog {
  const all = Object.entries(log.entries),
    kept = all.filter(([, e]) => !(e.at < now - retention && plain(e.fields)));
  if (kept.length > max)
    kept.sort(([ka, a], [kb, b]) => compare(b, a) || (ka < kb ? -1 : 1)).splice(max);
  const keep = new Set(kept.map(([k]) => k));
  let floor = log.floor ?? 0;
  for (const [k, e] of all) if (!keep.has(k)) floor = Math.max(floor, e.at);
  return withFloor(Object.fromEntries(kept), floor);
}

/** Latest message time, which a seeded entry takes so that any real edit made after triage still wins. */
const lastActivity = (thread: Thread, now: number) =>
  Math.min(
    now,
    Math.max(Date.parse(thread.date) || 0, ...thread.messages.map(m => Date.parse(m.date) || 0)) ||
      now,
  );

export interface PublishInput {
  /** Every copy read from the host that opened with the sync code. */
  remotes: WorkflowLog[];
  /** This device's pending edits as of the start of the round. */
  edits: WorkflowEdit[];
  /** Key → stamp of the entry this device last applied or published. */
  applied: Record<string, string>;
  threads: Thread[];
  /** No copy exists yet: this is the first device, so its existing Later, todos and reminders are shared too. */
  seed: boolean;
  device: string;
  now: number;
  scheme?: KeyScheme;
}
/** The log to publish: all copies merged with this device's edits (and seeded state), compacted. `own` lists this device's contributions. */
export function publishLog(input: PublishInput): {
  log: WorkflowLog;
  own: Record<string, WorkflowEntry>;
} {
  const scheme = input.scheme ?? 'thread',
    remote = mergeLogs(...input.remotes),
    own: Record<string, WorkflowEntry> = {};
  if (input.seed)
    for (const thread of input.threads) {
      const key = threadKey(thread, scheme),
        fields = workflowFields(thread);
      if (key && fields && !plain(fields))
        own[key] = { fields, at: lastActivity(thread, input.now), device: input.device };
    }
  for (const edit of [...input.edits].sort((a, b) => a.gen - b.gen)) {
    const key = edit.keys[scheme];
    if (!key || !edit.fields) continue;
    if (sameFields(remote.entries[key]?.fields, edit.fields)) {
      delete own[key];
      continue;
    }
    // An edit made after this device applied an entry is newer than it, even if this device's clock is behind.
    const seen = Number(input.applied[key]?.split(':')[0]) || 0;
    own[key] = { fields: edit.fields, at: Math.max(edit.at, seen + 1), device: input.device };
  }
  return {
    log: compactLog(mergeLogs(...input.remotes, { version: 1, entries: own }), input.now),
    own,
  };
}

/**
 * What applying `entry` changes on `thread`. Mail from someone else that arrived after the edit keeps the
 * thread's Home state (status, hidden from Home, reply status); the edit's todo, due date and reminder still apply.
 */
export function workflowPatch(entry: WorkflowEntry, thread: Thread): Partial<Thread> | undefined {
  const fields = workflowFields(thread);
  if (!fields) return undefined;
  const target = entry.fields,
    arrived = thread.messages.some(m => !m.sent && Date.parse(m.date) > entry.at),
    patch: Partial<Thread> = {};
  if (!arrived) {
    if (target.status !== fields.status) patch.status = target.status;
    if (target.replyStatus !== fields.replyStatus) patch.replyStatus = target.replyStatus;
    if (target.hiddenFromHome !== fields.hiddenFromHome)
      patch.hiddenFromHome = target.hiddenFromHome ?? false;
  }
  // Cleared text fields are patched as present-but-undefined keys; apply patches with a spread.
  for (const k of ['reminderAt', 'dueDate', 'todo'] as const)
    if (target[k] !== fields[k]) patch[k] = target[k];
  if (target.reminderFired !== fields.reminderFired)
    patch.reminderFired = target.reminderFired ?? false;
  return Object.keys(patch).length ? patch : undefined;
}

/**
 * Patches for local threads whose winning entry this device has not applied yet, and the updated `applied`
 * map. Each entry applies once, so a later host change (moving the thread back to the inbox elsewhere) is
 * not undone on every round, while an entry for a thread that only reaches this device later still applies
 * then. Threads in `skip` were edited during the round and keep the user's newer state for now.
 */
export function applyLog(
  log: WorkflowLog,
  threads: Thread[],
  applied: Record<string, string>,
  options: { scheme?: KeyScheme; skip?: Set<string>; own?: Record<string, WorkflowEntry> } = {},
): { patches: WorkflowPatch[]; applied: Record<string, string> } {
  const next: Record<string, string> = {},
    patches: WorkflowPatch[] = [];
  for (const [key, stamp] of Object.entries(applied)) if (log.entries[key]) next[key] = stamp;
  for (const [key, entry] of Object.entries(options.own ?? {}))
    if (sameEntry(log.entries[key], entry)) next[key] = entryStamp(entry);
  for (const thread of threads) {
    const key = threadKey(thread, options.scheme),
      entry = key ? log.entries[key] : undefined;
    if (!entry || options.skip?.has(thread.id) || next[key!] === entryStamp(entry)) continue;
    next[key!] = entryStamp(entry);
    const patch = workflowPatch(entry, thread);
    if (patch) patches.push({ threadId: thread.id, patch });
  }
  return { patches, applied: next };
}

/** Validate a decrypted log; throws on anything that is not a version 1 log. */
export function parseWorkflowLog(value: unknown): WorkflowLog {
  const fail = () => {
    throw new Error('Synced workflow data is not in a format this version of Aplos understands.');
  };
  if (!value || typeof value !== 'object') return fail();
  const raw = value as { version?: unknown; entries?: unknown; floor?: unknown };
  if (
    raw.version !== 1 ||
    !raw.entries ||
    typeof raw.entries !== 'object' ||
    Array.isArray(raw.entries)
  )
    return fail();
  const text = (v: unknown) =>
    typeof v === 'string' && v.length > 0 && v.length <= 10_000 ? v : undefined;
  const entries: Record<string, WorkflowEntry> = {};
  for (const [key, item] of Object.entries(raw.entries as Record<string, any>)) {
    const f = item?.fields;
    if (
      key === '__proto__' ||
      !f ||
      typeof item.at !== 'number' ||
      !Number.isFinite(item.at) ||
      typeof item.device !== 'string' ||
      !['new', 'done', 'later'].includes(f.status) ||
      !['none', 'needs-reply', 'awaiting-reply'].includes(f.replyStatus)
    )
      continue;
    const fields: WorkflowFields = { status: f.status, replyStatus: f.replyStatus };
    for (const k of ['reminderAt', 'dueDate', 'todo'] as const) {
      const v = text(f[k]);
      if (v) fields[k] = v;
    }
    if (f.reminderFired === true) fields.reminderFired = true;
    if (f.hiddenFromHome === true) fields.hiddenFromHome = true;
    entries[key] = { fields, at: item.at, device: item.device };
  }
  return withFloor(
    entries,
    typeof raw.floor === 'number' && Number.isFinite(raw.floor) ? raw.floor : 0,
  );
}
