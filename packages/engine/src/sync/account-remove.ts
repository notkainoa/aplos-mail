import type { Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { StoreWrite, StorePort } from '../store/port';
import type { MethodContext } from '../methods/types';
import type { EngineServices } from '../runtime/services';

/*
 * `Account/disconnect`: removes an account and everything Aplos stored for it. Loaded on first use (`import()` in
 * methods/account.ts, and by the host's start-up sweep), so none of it counts against the core budget. Import only
 * what the core already shares with lazy chunks (the error class): a static import of another lazy module (the
 * calendar holds, say) makes the bundler re-split the core and costs hundreds of core bytes.
 *
 * Order, so a removal is never left half-done and never blocks the engine:
 *
 * 1. Refuse while anything the owner asked to send is still on its way (`pendingMessage`). Failed sends and finished
 *    calendar changes do not block; they are deleted with the account (the Settings confirm lists them).
 * 2. Stop the account's actor (sync, its lease and its in-flight provider requests), check again, and commit ONE small
 *    transaction: the account's status becomes `removing` (every account list, the per-account views and the
 *    start-up `startAll` skip it from here on, see `sync/account-read.ts` and `views/compile.ts`), a journal row
 *    (`account.removing.<id>` in `meta`, which outlives the account row) records what is left to do, and the rows no
 *    foreign key reaches go: AI jobs, Ask conversations that quote its mail, its calendar holds.
 * 3. `finishRemoval`, in batches that each yield a real timer turn: attachment files on disk (before their rows, so a
 *    crash leaves the paths to try again), threads newest first (`threadDelete`, coarse change rows; messages, bodies,
 *    placements and search rows go with them), calendar events, then the account row itself (`accountRemove` cascades
 *    the small rest), then the stored sign-in (`AccountActorHost.forgetAccount`).
 * 4. The journal row goes last, once the sign-in is forgotten. Until then the host's start-up sweep
 *    (`resumeRemovals`) runs `finishRemoval` again, so a quit or crash at any step is finished at the next start.
 */

type Receipt = Output<'Account/disconnect'>;

/** Submission states that still mean "on its way": the owner asked for it to go out and it has not, or may have. */
const BLOCKING_STATES = ['sending', 'uncertain', 'queued', 'scheduled', 'suspended'] as const;
type BlockingState = (typeof BLOCKING_STATES)[number];

/** How the refusal names each waiting state; queued and suspended rows both read as waiting. */
const LABEL: Record<Exclude<BlockingState, 'sending'>, string> = {
  scheduled: 'scheduled',
  queued: 'waiting to send',
  suspended: 'waiting to send',
  uncertain: 'that may not have sent',
};

const SENDING = 'A message is being sent from this account. Try again when it has gone out.';
/** `calendar/holds.ts` HOLD_PREFIX, repeated: importing that lazy module here would cost core bytes (see above). */
const HOLD_PREFIX = 'calendar.hold.';
const JOURNAL = 'account.removing.';
/** Rows per batch: each batch is one short transaction, then a timer turn for everything else. */
export const REMOVE_BATCH = 200;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** The refusal sentence, or undefined when nothing is on its way. */
export function pendingMessage(store: StorePort, accountId: string): string | undefined {
  const rows = store.read(q =>
    q.all<{ state: BlockingState; n: number }>(
      `SELECT state, count(*) AS n FROM submissions WHERE account_id = ? AND state IN (${BLOCKING_STATES.map(() => '?').join()}) GROUP BY state`,
      accountId,
      ...BLOCKING_STATES,
    ),
  );
  if (rows.some(r => r.state === 'sending')) return SENDING;
  const holds = holdRows(store, accountId).filter(h => h.live).length;
  if (!rows.length && !holds) return undefined;
  const byLabel = new Map<string, number>();
  for (const r of rows) {
    const label = LABEL[r.state as Exclude<BlockingState, 'sending'>];
    byLabel.set(label, (byLabel.get(label) ?? 0) + Number(r.n));
  }
  const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
  const detail = [...byLabel].map(([label, n]) => `${n} ${label}`).join(', ');
  const mail = total
    ? `${plural(total, 'message that has', 'messages that have')} not gone out (${detail})`
    : '';
  const calendar = holds
    ? `${plural(holds, 'calendar change', 'calendar changes')} for guests`
    : '';
  const what = [mail, calendar].filter(Boolean).join(' and ');
  const them = total + holds === 1 ? 'it' : 'them';
  return `This account still has ${what}. Send or cancel ${them} first, then remove the account.`;
}

/**
 * The account's calendar holds. A hold is live while it waits its undo window or to be sent (`queued`) or is being
 * sent (`syncing`): those block. A failed, sent or undone one is history and goes with the account.
 */
function holdRows(store: StorePort, accountId: string): { key: string; live: boolean }[] {
  const rows = store.read(q =>
    q.all<{ key: string; value: string }>(
      'SELECT key, value FROM meta WHERE key LIKE ?',
      `${HOLD_PREFIX}%`,
    ),
  );
  const out: { key: string; live: boolean }[] = [];
  for (const row of rows) {
    let record: { state?: string; targets?: unknown; call?: { account?: string } };
    try {
      record = JSON.parse(row.value) as typeof record;
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const targets = Array.isArray(record.targets) ? record.targets : [];
    const mine =
      record.call?.account === accountId ||
      targets.some(t => typeof t === 'string' && t.startsWith(`${accountId}:`));
    if (mine)
      out.push({ key: row.key, live: record.state === 'queued' || record.state === 'syncing' });
  }
  return out;
}

/** AI jobs carry the account as their key's second segment (`summary:<account>:…`, `ingest:<account>:…`). */
function jobDeletes(store: StorePort, accountId: string): StoreWrite[] {
  const prefix = `${accountId}:`;
  const ids = store.read(q =>
    q.all<{ id: number }>(
      "SELECT id FROM jobs WHERE substr(key, instr(key, ':') + 1, ?) = ?",
      prefix.length,
      prefix,
    ),
  );
  return ids.map(r => ({ kind: 'job', action: 'delete', id: r.id }) as StoreWrite);
}

/** An Ask conversation goes when any of its turns quotes or links the account's mail (a wire id `"<account>:…`). */
function conversationRemoves(store: StorePort, accountId: string): StoreWrite[] {
  const needle = `"${accountId}:`;
  const ids = store.read(q =>
    q.all<{ id: string }>(
      'SELECT DISTINCT substr(id, 1, length(id) - length(pos) - 1) AS id FROM conversations WHERE instr(data, ?) > 0',
      needle,
    ),
  );
  return ids.map(r => ({ kind: 'conversation', id: r.id, data: '', remove: true }) as StoreWrite);
}

/** The rows no foreign key reaches. Written when the removal starts and again at the end (an Ask meanwhile). */
const unlinkedDeletes = (store: StorePort, accountId: string): StoreWrite[] => [
  ...jobDeletes(store, accountId),
  ...conversationRemoves(store, accountId),
  ...holdRows(store, accountId).map(h => ({ kind: 'meta', key: h.key, value: null }) as StoreWrite),
];

function refuseIfPending(store: StorePort, accountId: string): void {
  const message = pendingMessage(store, accountId);
  if (message) throw new ContractError({ type: 'conflict', message });
}

const notFound = () =>
  new ContractError({ type: 'notFound', message: 'That account is not in Aplos.' });

const accountRow = (store: StorePort, id: string) =>
  store.read(q =>
    q.get<{ provider: string; status: string }>(
      'SELECT provider, status FROM accounts WHERE id = ?',
      id,
    ),
  );

interface Journal {
  provider: string;
  opId: string;
}

function readJournal(store: StorePort, accountId: string): Journal | undefined {
  const row = store.read(q =>
    q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', JOURNAL + accountId),
  );
  if (!row) return undefined;
  try {
    const j = JSON.parse(row.value) as Partial<Journal>;
    return typeof j?.provider === 'string'
      ? { provider: j.provider, opId: String(j.opId) }
      : undefined;
  } catch {
    return undefined;
  }
}

const committedSeq = (store: StorePort, opId: string) =>
  store.read(q => q.get<{ seq: number }>('SELECT seq FROM commits WHERE op_id = ?', opId))?.seq;

const systemCommit = (store: StorePort, accountId: string, writes: StoreWrite[]) =>
  store.commit({
    opId: `account-remove:${accountId}:${store.seq()}:${writes.length}`,
    origin: 'system',
    changes: 'coarse',
    writes,
  });

/** Step 2: hides the account and journals the removal, in one small commit; a refusal restarts the actor. */
async function startRemoval(
  services: EngineServices,
  opId: string,
  accountId: string,
  provider: string,
) {
  const { store, accounts } = services;
  try {
    refuseIfPending(store, accountId);
    const journal: Journal = { provider, opId };
    const result = store.commit({
      opId,
      origin: 'local',
      writes: [
        { kind: 'meta', key: JOURNAL + accountId, value: JSON.stringify(journal) },
        { kind: 'account', id: accountId, status: { state: 'removing' } as never },
        ...unlinkedDeletes(store, accountId),
      ],
    });
    services.deadlines.changed('jobs');
    return result;
  } catch (error) {
    await accounts.start(accountId).catch(() => undefined);
    throw error;
  }
}

/** Deletes the account's attachment files, keyset-paged; the rows (and their paths) stay until their thread goes. */
async function removeFiles(services: EngineServices, accountId: string): Promise<boolean> {
  const { store, attachmentFiles } = services;
  let after = 0;
  let ok = true;
  for (;;) {
    const page = store.read(q =>
      q.all<{ id: number; path: string }>(
        `SELECT a.id, a.path FROM attachments a JOIN messages m ON m.id = a.message_id
         WHERE m.account_id = ? AND a.path IS NOT NULL AND a.id > ? ORDER BY a.id LIMIT ${REMOVE_BATCH}`,
        accountId,
        after,
      ),
    );
    if (!page.length) return ok;
    for (const { path } of page)
      await attachmentFiles.remove(path).catch(() => {
        ok = false;
      });
    after = page[page.length - 1].id;
    await turn();
  }
}

/** Deletes the account's threads (newest first, so its mail leaves the top of every list first), then its events. */
async function removeRows(store: StorePort, accountId: string): Promise<void> {
  for (;;) {
    const threads = store.read(q =>
      q.all<{ remote_id: string }>(
        `SELECT remote_id FROM threads WHERE account_id = ? ORDER BY last_date DESC LIMIT ${REMOVE_BATCH}`,
        accountId,
      ),
    );
    if (!threads.length) break;
    systemCommit(
      store,
      accountId,
      threads.map(t => ({ kind: 'threadDelete', accountId, remoteThreadId: t.remote_id })),
    );
    await turn();
  }
  for (;;) {
    const events = store.read(q =>
      q.all<{ cal: string; remote_id: string }>(
        `SELECT DISTINCT c.remote_id AS cal, e.remote_id FROM events e JOIN calendars c ON c.id = e.calendar_id
         WHERE c.account_id = ? LIMIT ${REMOVE_BATCH}`,
        accountId,
      ),
    );
    if (!events.length) break;
    systemCommit(
      store,
      accountId,
      events.map(e => ({
        kind: 'eventDelete',
        accountId,
        calendarRemoteId: e.cal,
        remoteId: e.remote_id,
      })),
    );
    await turn();
  }
}

/** Deletes the attachment files `accountRemove` queued (and any an earlier removal left); never throws. */
export async function drainFileRemovals(services: EngineServices): Promise<void> {
  const { store, attachmentFiles } = services;
  const paths = store.read(q =>
    q
      .all<{ path: string }>(
        'SELECT path FROM file_removals WHERE path NOT IN (SELECT path FROM attachments WHERE path IS NOT NULL)',
      )
      .map(r => r.path),
  );
  const removed: string[] = [];
  for (const path of paths) {
    try {
      await attachmentFiles.remove(path);
      removed.push(path);
    } catch {
      // Left queued: the next removal or start-up sweep tries it again.
    }
  }
  if (!removed.length) return;
  try {
    store.commit({
      opId: `files-removed-${store.seq()}-${removed.length}`,
      origin: 'system',
      writes: [{ kind: 'fileRemoved', paths: removed }],
    });
  } catch {
    // The rows stay; removing an already-removed file again is harmless.
  }
}

/** True when the sign-in is forgotten (or the provider keeps none); false leaves it to the start-up sweep. */
async function forgetCredential(services: EngineServices, accountId: string, provider: string) {
  try {
    await services.accounts.forgetAccount?.(accountId, provider as never);
    return true;
  } catch {
    services.log.event('rpc.failed', { method: 'Account/forget', reason: 'failed' });
    return false;
  }
}

/** What is still on this Mac after a removal that went through: only ever the stored sign-in. */
export interface RemovalLeft {
  /** The stored sign-in could not be deleted; the next start tries again. */
  signInKept: boolean;
}

const filesStuck = () =>
  new ContractError({
    type: 'unavailable',
    message:
      'Aplos could not delete some of this account’s files on this Mac. It tries again the next time it starts, or try again now.',
  });

/** One finish per account at a time: a retry from Settings and the start-up sweep share the run in progress. */
const running = new Map<string, Promise<RemovalLeft>>();

/** Steps 3 and 4, idempotent: every step looks at what is still stored, so a second run picks up where one stopped. */
export function finishRemoval(services: EngineServices, accountId: string): Promise<RemovalLeft> {
  let run = running.get(accountId);
  if (!run) {
    run = finish(services, accountId).finally(() => running.delete(accountId));
    running.set(accountId, run);
  }
  return run;
}

async function finish(services: EngineServices, accountId: string): Promise<RemovalLeft> {
  const { store } = services;
  const journal = readJournal(store, accountId);
  if (!journal) return { signInKept: false };
  // The start-up sweep reaches here without `removeAccount`: the lazy job and conversation writers load first.
  await import('../ai/impl/ai-writes');
  // A file that could not be deleted keeps its rows (the only record of its path): stop here, still hidden, and let
  // the next start or a Retry try again rather than lose track of it.
  if (!(await removeFiles(services, accountId))) throw filesStuck();
  await removeRows(store, accountId);
  if (accountRow(store, accountId))
    store.commit({
      opId: `account-remove:${accountId}:${store.seq()}:row`,
      origin: 'system',
      writes: [...unlinkedDeletes(store, accountId), { kind: 'accountRemove', accountId }],
    });
  await drainFileRemovals(services);
  const forgotten = await forgetCredential(services, accountId, journal.provider);
  if (forgotten)
    store.commit({
      opId: `account-remove:${accountId}:${store.seq()}:done`,
      origin: 'system',
      writes: [{ kind: 'meta', key: JOURNAL + accountId, value: null }],
    });
  return { signInKept: !forgotten };
}

/**
 * The host's start-up sweep: finishes every removal a quit or crash interrupted (a hidden, half-deleted account, its
 * files, its stored sign-in). Driven by the journal rather than by scanning the vault: a scan would also find the
 * credential a connect stores just before it commits its account row. Never throws; one account's failure is logged
 * and the next start tries it again.
 */
export async function resumeRemovals(services: EngineServices): Promise<void> {
  const ids = services.store.read(q =>
    q
      .all<{ key: string }>(
        'SELECT key FROM meta WHERE substr(key, 1, ?) = ?',
        JOURNAL.length,
        JOURNAL,
      )
      .map(r => r.key.slice(JOURNAL.length)),
  );
  for (const id of ids) {
    try {
      await finishRemoval(services, id);
    } catch {
      services.log.event('rpc.failed', { method: 'Account/disconnect', reason: 'resume' });
    }
  }
}

const receiptOf = (opId: string, dbEpoch: string, seq: number, left?: RemovalLeft): Receipt => ({
  opId,
  appliedState: { dbEpoch, seq },
  undoable: false,
  ...(left?.signInKept ? { signInKept: true as const } : {}),
});

export async function removeAccount(
  args: Input<'Account/disconnect'>,
  ctx: MethodContext,
): Promise<Receipt> {
  const { services } = ctx;
  const { store, accounts } = services;
  const { opId, accountId } = args;
  const row = accountRow(store, accountId);
  if (!row || row.status === 'removing') {
    // A retry of a removal (its receipt), or one a quit interrupted: finish what is left first.
    const seq = committedSeq(store, opId);
    if (!row && seq === undefined) throw notFound();
    const left = await finishRemoval(services, accountId);
    return receiptOf(opId, store.dbEpoch, seq ?? store.seq(), left);
  }
  refuseIfPending(store, accountId);
  // The job and conversation writers are lazy: load them before the commit, never between the check and it.
  await import('../ai/impl/ai-writes');
  await accounts.stop(accountId, 'disconnect');
  const started = await startRemoval(services, opId, accountId, row.provider);
  const left = await finishRemoval(services, accountId);
  return receiptOf(opId, started.dbEpoch, started.seq, left);
}
