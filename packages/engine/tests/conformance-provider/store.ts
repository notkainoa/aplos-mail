/**
 * The engine's own store, in memory, as the conformance suite's mailbox copy. Steps commit through `stepWrites` as the
 * actor commits them, so what the suite reads back is what the app would show.
 */
import type {
  AdapterAccount,
  KnownLookup,
  PlannedStep,
  ScopeId,
  StepResult,
  SyncState,
} from '@aplos/engine/ports';
import {
  createKnownLookup,
  openStore,
  type CommitExtension,
  type RemoteDraftWrite,
  type StorePort,
} from '@aplos/engine/store';
import { stepWrites } from '../../src/sync/facts';
import { readFailures, readMemory, readStates } from '../../src/sync/persist';
import { openSqlite } from '../../../../apps/desktop/src/host/sqlite';

/** One stored message, as the suite compares it with the server. */
export interface StoredMessage {
  remoteId: string;
  remoteThreadId: string;
  seen: boolean;
  flagged: boolean;
  folders: string[];
}

const FLAG_SEEN = 1;
const FLAG_FLAGGED = 2;

/** Remote drafts are another lane's writes; the suite only needs them to commit. */
const draftExtension: CommitExtension = {
  lane: 'eng-time',
  kinds: ['remoteDraft'],
  changeTypes: ['Draft'],
  apply(write, tx) {
    const w = write as RemoteDraftWrite;
    tx.mark('Draft', `${w.accountId}:remote-${w.remoteDraftId}`, w.removed ? 'd' : 'u');
  },
};

export class SuiteStore {
  readonly lookup: KnownLookup;
  private readonly db: StorePort;
  private ops = 0;

  /** `memory` is what connect returned, stored with the account as the engine stores it. */
  constructor(
    private readonly account: AdapterAccount,
    private readonly now: () => number,
    memory: Record<string, string> = {},
  ) {
    this.db = openStore(openSqlite(':memory:'), { now, extensions: [draftExtension] });
    this.db.commit({
      opId: 'suite-account',
      origin: 'system',
      writes: [
        {
          kind: 'account',
          id: account.id,
          provider: account.provider,
          address: account.address,
          capabilities: { ...account.capabilities },
          status: { state: 'syncing' },
        },
        ...(Object.keys(memory).length
          ? [{ kind: 'providerMemory' as const, accountId: account.id, values: memory }]
          : []),
      ],
    });
    this.lookup = createKnownLookup(this.db, account.id);
  }

  get seq(): number {
    return this.db.seq();
  }

  get memory(): Map<string, string> {
    return readMemory(this.db, this.account.id);
  }

  states(): SyncState[] {
    return readStates(this.db, this.account.id);
  }

  state(scope: ScopeId): SyncState {
    return this.states().find(s => s.scope === scope) ?? { scope, generation: 0, updatedAt: 0 };
  }

  commit(step: PlannedStep, result: StepResult, fenceSeq: number): void {
    const writes = stepWrites(result, {
      account: this.account,
      step,
      state: this.state(step.scope),
      now: this.now(),
      failures: readFailures(
        this.db,
        this.account.id,
        (result.quarantine ?? []).map(q => q.item),
      ),
      baselineDone: this.baselineDone(),
    });
    this.db.commit({
      opId: `suite-${++this.ops}`,
      origin: 'sync',
      step: step.origin,
      fenceSeq,
      changes: step.origin === 'backfill' ? 'coarse' : 'fine',
      writes,
    });
  }

  messages(): Map<string, StoredMessage> {
    const rows = this.db.read(q =>
      q.all<{ remote_id: string; thread: string; flags: number }>(
        `SELECT m.remote_id, t.remote_id AS thread, m.flags FROM messages m
        JOIN threads t ON t.id = m.thread_id WHERE m.account_id = ? ORDER BY m.id`,
        this.account.id,
      ),
    );
    const out = new Map<string, StoredMessage>();
    for (const r of rows) out.set(r.remote_id, toStored(r));
    for (const p of this.placements()) out.get(p.remote_id)?.folders.push(p.folder);
    return out;
  }

  close(): void {
    this.db.close();
  }

  private placements(): { remote_id: string; folder: string }[] {
    return this.db.read(q =>
      q.all<{ remote_id: string; folder: string }>(
        `SELECT m.remote_id, f.remote_id AS folder FROM message_folders mf
        JOIN messages m ON m.id = mf.message_id JOIN folders f ON f.id = mf.folder_id
        WHERE m.account_id = ? ORDER BY m.id, f.remote_id`,
        this.account.id,
      ),
    );
  }

  private baselineDone(): boolean {
    const row = this.db.read(q =>
      q.get<{ at: number | null }>(
        'SELECT baseline_done_at AS at FROM accounts WHERE id = ?',
        this.account.id,
      ),
    );
    return row?.at != null;
  }
}

function toStored(r: { remote_id: string; thread: string; flags: number }): StoredMessage {
  return {
    remoteId: r.remote_id,
    remoteThreadId: r.thread,
    seen: (r.flags & FLAG_SEEN) !== 0,
    flagged: (r.flags & FLAG_FLAGGED) !== 0,
    folders: [],
  };
}
