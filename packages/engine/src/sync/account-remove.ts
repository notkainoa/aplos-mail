import type { Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { StoreError, type StoreWrite, type StorePort } from '../store/port';
import type { MethodContext } from '../methods/types';
import type { EngineServices } from '../runtime/services';
import { HOLD_PREFIX } from '../calendar/holds';

/*
 * `Account/disconnect`: removes an account and everything Aplos stored for it. Loaded on first use (`import()` in
 * methods/account.ts), so none of it counts against the core budget.
 *
 * Order: refuse while anything the owner asked to send is still waiting; stop the account's actor (sync, its lease and
 * the provider requests it has in flight); check again, synchronously, and commit ONE transaction that deletes the
 * account row (foreign keys cascade to mail, threads, bodies, attachments, drafts, submissions, ops, calendars, events,
 * plans, summaries, sender rules, sync and provider state, `store/commit-account-remove.ts` clears the FTS rows, the
 * governor rows and the account's meta keys) together with the rows no foreign key reaches: the AI jobs keyed to the
 * account, Ask conversations that quote its mail and its calendar holds. Then, best effort and after the commit: the
 * attachment files on disk and the stored sign-in (`AccountActorHost.forgetAccount`).
 */

type Receipt = Output<'Account/disconnect'>;

/** Every submission state that is not finished: the owner asked for it to go out and it has not (or may not have). */
const PENDING_STATES = [
  'sending',
  'uncertain',
  'queued',
  'scheduled',
  'suspended',
  'failed',
] as const;
type PendingState = (typeof PENDING_STATES)[number];

/** How the refusal names each waiting state; queued and suspended rows both read as waiting. */
const LABEL: Record<Exclude<PendingState, 'sending'>, string> = {
  scheduled: 'scheduled',
  queued: 'waiting to send',
  suspended: 'waiting to send',
  failed: 'that failed to send',
  uncertain: 'that may not have sent',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The refusal sentence, or undefined when nothing is waiting. */
export function pendingMessage(store: StorePort, accountId: string): string | undefined {
  const rows = store.read(q =>
    q.all<{ state: PendingState; n: number }>(
      `SELECT state, count(*) AS n FROM submissions WHERE account_id = ? AND state IN (${PENDING_STATES.map(() => '?').join()}) GROUP BY state`,
      accountId,
      ...PENDING_STATES,
    ),
  );
  if (rows.some(r => r.state === 'sending'))
    return 'A message is being sent from this account. Try again when it has gone out.';
  const holds = liveHolds(store, accountId);
  if (!rows.length && !holds) return undefined;
  const byLabel = new Map<string, number>();
  for (const r of rows) {
    const label = LABEL[r.state as Exclude<PendingState, 'sending'>];
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
    const targets = Array.isArray(record.targets) ? record.targets : [];
    const mine =
      record.call?.account === accountId ||
      targets.some(t => typeof t === 'string' && t.startsWith(`${accountId}:`));
    if (mine)
      out.push({ key: row.key, live: record.state === 'queued' || record.state === 'syncing' });
  }
  return out;
}

const liveHolds = (store: StorePort, accountId: string) =>
  holdRows(store, accountId).filter(h => h.live).length;

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

function holdDeletes(store: StorePort, accountId: string): StoreWrite[] {
  return holdRows(store, accountId).map(h => ({ kind: 'meta', key: h.key, value: null }));
}

function refuseIfPending(store: StorePort, accountId: string): void {
  const message = pendingMessage(store, accountId);
  if (message) throw new ContractError({ type: 'conflict', message });
}

const notFound = () =>
  new ContractError({ type: 'notFound', message: 'That account is not in Aplos.' });

const providerOf = (store: StorePort, id: string) =>
  store.read(q => q.get<{ provider: string }>('SELECT provider FROM accounts WHERE id = ?', id))
    ?.provider;

const committedSeq = (store: StorePort, opId: string) =>
  store.read(q => q.get<{ seq: number }>('SELECT seq FROM commits WHERE op_id = ?', opId))?.seq;

const receiptOf = (opId: string, dbEpoch: string, seq: number): Receipt => ({
  opId,
  appliedState: { dbEpoch, seq },
  undoable: false,
});

/** Commits the removal; any refusal puts the actor back so the account keeps syncing as before. */
async function commitRemoval(services: EngineServices, opId: string, accountId: string) {
  const { store, accounts } = services;
  try {
    refuseIfPending(store, accountId);
    return store.commit({
      opId,
      origin: 'local',
      writes: [
        ...jobDeletes(store, accountId),
        ...conversationRemoves(store, accountId),
        ...holdDeletes(store, accountId),
        { kind: 'accountRemove', accountId },
      ],
    });
  } catch (error) {
    await accounts.start(accountId).catch(() => undefined);
    if (error instanceof StoreError && error.code === 'conflict')
      throw new ContractError({
        type: 'conflict',
        message: 'A message is being sent from this account. Try again when it has gone out.',
      });
    throw error;
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
      // Left queued: the next removal tries it again.
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

async function forgetCredential(services: EngineServices, accountId: string, provider: string) {
  try {
    await services.accounts.forgetAccount?.(accountId, provider as never);
  } catch {
    services.log.event('rpc.failed', { method: 'Account/forget', reason: 'failed' });
  }
}

export async function removeAccount(
  args: Input<'Account/disconnect'>,
  ctx: MethodContext,
): Promise<Receipt> {
  const { services } = ctx;
  const { store, accounts } = services;
  const { opId, accountId } = args;
  const provider = providerOf(store, accountId);
  if (provider === undefined) {
    // A retry of a removal that already landed answers with its receipt.
    const seq = committedSeq(store, opId);
    if (seq !== undefined) return receiptOf(opId, store.dbEpoch, seq);
    throw notFound();
  }
  refuseIfPending(store, accountId);
  // The job and conversation writers are lazy: load them before the commit, never between the check and it.
  await import('../ai/impl/ai-writes');
  await accounts.stop(accountId, 'disconnect');
  const result = await commitRemoval(services, opId, accountId);
  await drainFileRemovals(services);
  await forgetCredential(services, accountId, provider);
  services.deadlines.changed('jobs');
  return receiptOf(opId, result.dbEpoch, result.seq);
}
