/**
 * The prov-gmail tests' store: the engine's real `mail.db` (`openStore` on the host's SQLite, in a temp folder), driven
 * the way the sync actor drives it. A step's `StepResult` goes through the engine's own `stepWrites` and one
 * `store.commit` with a unique op id, the mutation fence and the step origin, so every test now exercises the real
 * sweep, placement, rollup and replay code. The read views (`rows`, `states`, `memory`, `drafts`) are rebuilt from SQL
 * after each commit; `commits` and `swept` are the rig's own record of what was committed.
 */
import { removeScratchDir, scratchDir } from './scratch';
import { join } from 'node:path';
import type {
  AdapterAccount,
  KnownLookup,
  MessageFacts,
  PlannedStep,
  RemoteDraftFact,
  ScopeId,
  StepResult,
  SyncState,
} from '@aplos/engine/ports';
import {
  createKnownLookup,
  openStore,
  type CommitExtension,
  type IngestBatch,
  type RemoteDraftWrite,
  type StorePort,
} from '@aplos/engine/store';
import { stepWrites } from '../../../../packages/engine/src/sync/facts';
import { readFailures, readMemory, readStates } from '../../../../packages/engine/src/sync/persist';
import { openSqlite } from '../../src/host/sqlite';

export interface Commit {
  at: number;
  step: PlannedStep;
  result: StepResult;
}

/** The part of a stored message the tests read back. */
export type StoredFacts = Pick<
  MessageFacts,
  'remoteId' | 'remoteThreadId' | 'internalDate' | 'partial' | 'snippet' | 'from'
>;

/** An ingest batch with whether the account's baseline was already done when it landed. */
export type RecordedBatch = IngestBatch & { baselineDone: boolean };

export interface Row {
  facts: StoredFacts;
  /** Folder remote id -> `seen_gen` (null: written by history, open or search). */
  folders: Map<string, number | null>;
  seen: boolean;
  flagged: boolean;
}

interface MessageRow {
  remote_id: string;
  thread: string;
  internal_date: number;
  flags: number;
  parts: number;
  snippet: string | null;
  from_addr: string | null;
  from_name: string | null;
  [k: string]: string | number | null;
}

interface PlacementRow {
  remote_id: string;
  folder: string;
  seen_gen: number | null;
  [k: string]: string | number | null;
}

const FLAG_SEEN = 1;
const FLAG_FLAGGED = 2;
const PART_BODY = 2 | 4;

/**
 * eng-time's extension, cut down: the `remoteDraft` writer (the columns the Gmail lookups read) and an `ingest` hook
 * that records every batch, which is where the real notification outbox decides what is new mail (step `incremental`
 * after the baseline, `added`, newer than the last sync).
 */
const rigExtension = (batches: RecordedBatch[]): CommitExtension => ({
  lane: 'eng-time',
  kinds: ['remoteDraft'],
  changeTypes: ['Draft'],
  ingest(batch, tx) {
    const account = batch.messages[0]?.accountId;
    const done = tx.get<{ at: number | null }>(
      'SELECT baseline_done_at AS at FROM accounts WHERE id = ?',
      account,
    );
    batches.push({ ...batch, messages: [...batch.messages], baselineDone: done?.at != null });
  },
  apply(write, tx) {
    const w = write as RemoteDraftWrite;
    const id = `remote-${w.remoteDraftId}`;
    if (w.removed) {
      tx.run('DELETE FROM drafts WHERE id = ?', id);
    } else {
      tx.run(
        `INSERT INTO drafts(id, account_id, revision, data, remote_draft_id, remote_message_id, origin, updated_at)
        VALUES(?, ?, 1, '{}', ?, ?, 'remote', ?)
        ON CONFLICT(id) DO UPDATE SET remote_message_id = excluded.remote_message_id, updated_at = excluded.updated_at`,
        id,
        w.accountId,
        w.remoteDraftId,
        w.remoteMessageId,
        w.changedAt,
      );
    }
    tx.mark('Draft', `${w.accountId}:${id}`, w.removed ? 'd' : 'u');
  },
});

export class RigStore {
  readonly commits: Commit[] = [];
  /** Message ids a covering sweep took out of its folder. */
  readonly swept: string[] = [];
  /** Remote drafts as the adapter reported them, latest fact per draft (a removal stays visible as `removed`). */
  readonly drafts = new Map<string, RemoteDraftFact>();
  /** What the store's ingest hook saw per commit that wrote a message, oldest first. */
  readonly ingested: RecordedBatch[] = [];
  readonly lookup: KnownLookup;
  /** Message id -> draft id of the copies this device wrote: a real `drafts` row, as the send path leaves one. */
  readonly ownDrafts = {
    set: (messageId: string, draftId: string) => this.trackDraft(messageId, draftId),
  };
  private readonly db: StorePort;
  private readonly dir: string;
  private ops = 0;
  private version = 0;
  private cache?: { version: number; rows: Map<string, Row> };

  constructor(
    private readonly account: AdapterAccount,
    now: () => number,
  ) {
    this.dir = scratchDir('aplos-gmail-rig-');
    this.db = openStore(openSqlite(join(this.dir, 'mail.db')), {
      now,
      extensions: [rigExtension(this.ingested)],
    });
    this.db.commit({
      opId: 'rig-account',
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
      ],
    });
    this.lookup = createKnownLookup(this.db, account.id);
  }

  get raw(): StorePort {
    return this.db;
  }

  close(): void {
    this.db.close();
    removeScratchDir(this.dir);
  }

  /** The store's seq: the generation a round starting now would carry (the actor's fence). */
  get seq(): number {
    return this.db.seq();
  }

  get states(): Map<ScopeId, SyncState> {
    return new Map(readStates(this.db, this.account.id).map(s => [s.scope, s]));
  }

  get memory(): Map<string, string> {
    return readMemory(this.db, this.account.id);
  }

  /** `accounts.baseline_done_at`: when the first window was committed. */
  get baselineAt(): number | undefined {
    const row = this.db.read(q =>
      q.get<{ at: number | null }>(
        'SELECT baseline_done_at AS at FROM accounts WHERE id = ?',
        this.account.id,
      ),
    );
    return row?.at ?? undefined;
  }

  state(scope: ScopeId): SyncState {
    return this.states.get(scope) ?? { scope, generation: 0, updatedAt: 0 };
  }

  get rows(): Map<string, Row> {
    if (this.cache?.version !== this.version)
      this.cache = { version: this.version, rows: this.readRows() };
    return this.cache.rows;
  }

  /**
   * Message ids the notification hook would treat as new mail: stored for the first time by an `incremental` commit
   * (ARCH 4.2: the one step that notifies, and only after the baseline), in the Inbox, newer than `since`.
   */
  newMail(since = 0): string[] {
    return this.ingested
      .filter(b => b.origin === 'sync' && b.step === 'incremental' && b.baselineDone)
      .flatMap(b => b.messages)
      .filter(m => m.added && m.roles.includes('inbox') && m.internalDate > since)
      .map(m => m.remoteId);
  }

  /** Threads with at least one message in `folder`. */
  threadsIn(folder: string): Set<string> {
    return new Set(
      [...this.rows.values()].filter(r => r.folders.has(folder)).map(r => r.facts.remoteThreadId),
    );
  }

  /** The failure counts the engine holds for quarantined items (`sync_failures.attempts`). */
  failures(items: string[]): Map<string, number> {
    return readFailures(this.db, this.account.id, items);
  }

  /** Commits one step's result as the actor does: all its writes in one transaction, fenced at `fenceSeq`. */
  commit(step: PlannedStep, result: StepResult, now: number, fenceSeq?: number): void {
    const before =
      result.scopeCovered && result.done
        ? this.folderMembers(result.scopeCovered.bound.folder)
        : [];
    const state = this.state(step.scope);
    const writes = stepWrites(result, {
      account: this.account,
      step,
      state,
      now,
      failures: this.failures((result.quarantine ?? []).map(q => q.item)),
      baselineDone: this.baselineAt !== undefined,
    });
    this.db.commit({
      opId: `rig-${++this.ops}`,
      origin: 'sync',
      step: step.origin,
      fenceSeq: fenceSeq ?? this.db.seq(),
      changes: step.origin === 'backfill' ? 'coarse' : 'fine',
      writes,
    });
    this.commits.push({ at: now, step, result });
    for (const d of result.drafts ?? []) this.drafts.set(d.remoteDraftId, d);
    if (result.scopeCovered && result.done)
      this.noteSwept(result.scopeCovered.bound.folder, before);
    this.version++;
  }

  private trackDraft(messageId: string, draftId: string): void {
    this.db.commit({
      opId: `rig-${++this.ops}`,
      origin: 'system',
      writes: [
        {
          kind: 'remoteDraft',
          accountId: this.account.id,
          remoteDraftId: draftId,
          remoteMessageId: messageId,
          changedAt: 0,
        },
      ],
    });
  }

  private folderMembers(folder: string): string[] {
    return this.db.read(q =>
      q
        .all<{ id: string }>(
          `SELECT m.remote_id AS id FROM message_folders mf JOIN messages m ON m.id = mf.message_id
          JOIN folders f ON f.id = mf.folder_id WHERE f.account_id = ? AND f.remote_id = ?`,
          this.account.id,
          folder,
        )
        .map(r => r.id),
    );
  }

  private noteSwept(folder: string, before: string[]): void {
    const after = new Set(this.folderMembers(folder));
    for (const id of before) if (!after.has(id)) this.swept.push(id);
  }

  private readRows(): Map<string, Row> {
    const id = this.account.id;
    const messages = this.db.read(q =>
      q.all<MessageRow>(
        `SELECT m.remote_id, t.remote_id AS thread, m.internal_date, m.flags, m.parts,
        m.snippet, m.from_addr, m.from_name FROM messages m
        JOIN threads t ON t.id = m.thread_id WHERE m.account_id = ? ORDER BY m.id`,
        id,
      ),
    );
    const rows = new Map<string, Row>(messages.map(m => [m.remote_id, toRow(m)]));
    const placements = this.db.read(q =>
      q.all<PlacementRow>(
        `SELECT m.remote_id, f.remote_id AS folder, mf.seen_gen FROM message_folders mf
        JOIN messages m ON m.id = mf.message_id JOIN folders f ON f.id = mf.folder_id
        WHERE m.account_id = ? ORDER BY m.id, f.remote_id`,
        id,
      ),
    );
    for (const p of placements) rows.get(p.remote_id)?.folders.set(p.folder, p.seen_gen);
    return rows;
  }
}

function toRow(m: MessageRow): Row {
  return {
    facts: {
      remoteId: m.remote_id,
      remoteThreadId: m.thread,
      internalDate: m.internal_date,
      partial: (m.parts & PART_BODY) === 0,
      ...(m.snippet !== null ? { snippet: m.snippet } : {}),
      ...(m.from_addr !== null
        ? { from: { address: m.from_addr, ...(m.from_name ? { name: m.from_name } : {}) } }
        : {}),
    },
    folders: new Map(),
    seen: (m.flags & FLAG_SEEN) !== 0,
    flagged: (m.flags & FLAG_FLAGGED) !== 0,
  };
}
