/**
 * Operations as screens see them, and the one undo stack (DESIGN 5 rule 11, 7.13; gap list U7). The data layer
 * records every optimistic command here; toasts word themselves from `OperationView`, and Z undoes the newest entry
 * of either kind: an engine operation (through `Operation/undo`, an inverse operation) or a local change.
 */
import type {
  EpochMs,
  ErrorBody,
  Id,
  Operation,
  OpId,
  ThreadAction,
  ThreadRow,
} from './contract-shapes';
import { memoSnapshot, opTopic, sameJson, UNDO_TOPIC, type Emitter } from './emitter';
import type {
  ActResult,
  LocalUndo,
  OperationView,
  UndoEntry,
  UndoHandle,
  UndoOutcome,
  UndoStack,
} from './index';
import type { Placement } from './optimistic';
import type { OperationState, ThreadListSelector } from './ui-types';

/** What an operation did to rows, so its inverse (and a failure's return) can be laid over windows. */
export type Effect =
  | {
      readonly type: 'act';
      readonly action: ThreadAction;
      readonly selector: ThreadListSelector | null;
      readonly targets: ReadonlySet<Id>;
      readonly before: ReadonlyMap<Id, ThreadRow>;
      readonly originalPosition: ReadonlyMap<string, ReadonlyMap<Id, Placement>>;
    }
  | {
      readonly type: 'restore';
      /** The action this restore reverses, so undoing the undo applies it again. */
      readonly action: ThreadAction;
      readonly targets: ReadonlySet<Id>;
      readonly before: ReadonlyMap<Id, ThreadRow>;
      readonly originalPosition: ReadonlyMap<string, ReadonlyMap<Id, Placement>>;
    };

export interface OpRecord {
  readonly opId: OpId;
  /** `act` for `Thread/act`, `undo` for `Operation/undo`, `command` for any other write that returns a receipt (no overlay). */
  readonly kind: 'act' | 'undo' | 'command';
  /** For an undo: the operation it reverses. */
  readonly undoOf: OpId | null;
  readonly action: ThreadAction | null;
  readonly selector: ThreadListSelector | null;
  readonly targets: readonly Id[];
  readonly effect: Effect | null;
  state: OperationState;
  error: ErrorBody | null;
  receiptUndoable: boolean;
  undoUntil: EpochMs | null;
  /** Set while an undo of this operation is issued or done; cleared if that undo fails. */
  undoneBy: OpId | null;
  /** A `command` only: sends the same write again under a fresh `opId` (Retry after the engine refused it). */
  readonly reissue?: () => ActResult;
}

/** Operations remembered for toasts; the oldest are forgotten past this. */
const KEEP_OPERATIONS = 200;
/** Undo entries kept. */
const KEEP_UNDO = 100;

export interface OperationsDeps {
  readonly emitter: Emitter;
  /** The provider-side `Operation` row, once read or pushed. */
  readonly remote: (opId: OpId) => Operation | undefined;
  readonly retry: (record: OpRecord) => ActResult;
  readonly undo: (opId: OpId) => ActResult;
  readonly mintId: (prefix: string) => string;
  /** A record was forgotten (evicted or dropped): release what the layer holds for it. */
  readonly forgotten?: (opId: OpId) => void;
}

export class Operations {
  private readonly records = new Map<OpId, OpRecord>();
  private readonly views = new Map<OpId, () => OperationView | undefined>();

  constructor(private readonly deps: OperationsDeps) {}

  get(opId: OpId): OpRecord | undefined {
    return this.records.get(opId);
  }

  add(record: OpRecord): void {
    this.records.set(record.opId, record);
    while (this.records.size > KEEP_OPERATIONS) this.forget(this.records.keys().next().value!);
    this.changed(record.opId);
  }

  forget(opId: OpId): void {
    if (!this.records.delete(opId)) return;
    this.views.delete(opId);
    this.deps.forgotten?.(opId);
    this.changed(opId);
  }

  /** Wake the views of one operation and the undo stack. */
  changed(opId: OpId): void {
    this.deps.emitter.emit(opTopic(opId), UNDO_TOPIC);
  }

  /** Every record, oldest first. */
  all(): OpRecord[] {
    return [...this.records.values()];
  }

  /** The live view of one operation, stable while nothing about it changes. */
  view(opId: OpId | undefined): OperationView | undefined {
    if (!opId) return undefined;
    let read = this.views.get(opId);
    if (!read) {
      read = memoSnapshot(this.deps.emitter, () => this.compute(opId), sameOperationView);
      this.views.set(opId, read);
    }
    return read();
  }

  /** Whether Z can still undo it. */
  undoable(opId: OpId): boolean {
    const record = this.records.get(opId);
    if (!record || record.state === 'failed' || record.undoneBy || !record.receiptUndoable)
      return false;
    const remote = this.deps.remote(opId)?.state;
    return remote !== 'cancelled' && remote !== 'failed';
  }

  private compute(opId: OpId): OperationView | undefined {
    const record = this.records.get(opId);
    if (!record) return undefined;
    const remote = record.state === 'confirmed' ? (this.deps.remote(opId) ?? null) : null;
    const targets =
      record.state === 'confirmed' && remote
        ? remote.targets
        : record.selector && record.state === 'pending'
          ? []
          : record.targets;
    return {
      opId,
      state: record.state,
      remote: remote?.state ?? null,
      action: record.action,
      targets,
      selector: record.selector,
      error:
        record.error ??
        (remote?.state === 'failed' || remote?.state === 'conflict'
          ? (remote.error ?? null)
          : null),
      undoable: this.undoable(opId),
      undoUntil: record.undoUntil,
      retry: () => this.deps.retry(record),
    };
  }
}

function sameOperationView(a: OperationView | undefined, b: OperationView | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.state === b.state &&
    a.remote === b.remote &&
    a.undoable === b.undoable &&
    a.undoUntil === b.undoUntil &&
    a.error === b.error &&
    sameJson(a.targets, b.targets)
  );
}

type StackEntry =
  | { readonly kind: 'operation'; readonly id: string; readonly opId: OpId }
  | {
      readonly kind: 'local';
      readonly id: string;
      readonly label: string;
      readonly entry: LocalUndo;
    };

/** The one stack Z reads (DESIGN 7.13): engine operations join by themselves, screens push local changes. */
export class UndoStackStore implements UndoStack {
  private entries: StackEntry[] = [];
  readonly top: () => UndoEntry | null;

  constructor(
    private readonly operations: Operations,
    private readonly deps: OperationsDeps,
  ) {
    this.top = memoSnapshot(deps.emitter, () => this.peek(), sameJson);
  }

  pushOperation(opId: OpId): void {
    this.add({ kind: 'operation', id: this.deps.mintId('undo'), opId });
  }

  /** Take an operation off the stack (its receipt said it cannot be undone). */
  dropOperation(opId: OpId): void {
    const kept = this.entries.filter(e => !(e.kind === 'operation' && e.opId === opId));
    if (kept.length === this.entries.length) return;
    this.entries = kept;
    this.deps.emitter.emit(UNDO_TOPIC);
  }

  push(entry: LocalUndo): UndoHandle {
    const id = this.deps.mintId('undo');
    this.add({ kind: 'local', id, label: entry.label, entry });
    return {
      id,
      forget: () => {
        this.entries = this.entries.filter(e => e.id !== id);
        this.deps.emitter.emit(UNDO_TOPIC);
      },
    };
  }

  peek(): UndoEntry | null {
    const entry = this.newest();
    if (!entry) return null;
    return entry.kind === 'operation'
      ? { kind: 'operation', id: entry.id, opId: entry.opId }
      : { kind: 'local', id: entry.id, label: entry.label };
  }

  undoLast(): UndoOutcome | null {
    const entry = this.newest();
    if (!entry) return null;
    this.entries = this.entries.slice(0, this.entries.indexOf(entry));
    this.deps.emitter.emit(UNDO_TOPIC);
    if (entry.kind === 'operation') {
      return { kind: 'operation', opId: entry.opId, result: this.deps.undo(entry.opId) };
    }
    const done = Promise.resolve().then(() => entry.entry.undo());
    done.catch(() => {});
    return { kind: 'local', label: entry.label, done };
  }

  private newest(): StackEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (entry.kind === 'local' || this.operations.undoable(entry.opId)) return entry;
    }
    return undefined;
  }

  private add(entry: StackEntry): void {
    this.entries = [...this.entries, entry].slice(-KEEP_UNDO);
    this.deps.emitter.emit(UNDO_TOPIC);
  }
}
