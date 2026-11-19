/**
 * The data layer, framework-free: one client, the row cache, the windows, the overlay, operations and the undo
 * stack, session singletons, streams, bodies, holds and prefetch, all on one change signal whose emits name topics.
 * `hooks.ts` puts React on top with `useSyncExternalStore`; tests drive this directly. Engine frames are queued and applied once per animation
 * frame (DESIGN 5 rule 13); a command's overlay applies synchronously, before `api.thread.act` returns (rule 1).
 */
import type { EngineSession } from '@aplos/contract/client';
import type { Frame, Id, OpId, Operation, Receipt, State, ThreadRow } from './contract-shapes';
import { BodyStore } from './bodies';
import { createDataClient, toErrorBody, type DataClient } from './client';
import { ClockStore } from './clock';
import { createEmitter, FAILURES_TOPIC, OVERLAY_TOPIC, rowTopic, type Emitter } from './emitter';
import { FrameBus, streamFrame } from './frames';
import { buildApi } from './layer-api';
import { createHoldGate, type HoldGate } from './holds';
import {
  OperationFailedError,
  type ActResult,
  type DataApi,
  type PrefetchIntent,
  type RowFailure,
  type ThreadActArgs,
  type UndoArgs,
} from './index';
import { Operations, UndoStackStore, type Effect, type OpRecord } from './operations';
import {
  Overlay,
  predictRow,
  restorePatch,
  sectionAt,
  specKey,
  type OverlayEntry,
  type Placement,
} from './optimistic';
import { createPrefetchIntent } from './prefetch';
import { RowCache, RowFetcher } from './rows';
import { animationFrameScheduler, realTimers, type FrameScheduler, type Timers } from './scheduler';
import { SessionStore } from './session';
import { StateOrder } from './states';
import type { CachedRowType, ThreadListSelector } from './ui-types';
import { cachedType, WindowManager } from './windows';

export interface DataLayerOptions {
  /** The transport: an `EngineSession` (the stand-in in-process, or `../bridge.ts`'s MessagePort session). */
  readonly session: EngineSession;
  /** When queued frames apply. Default: the next animation frame. */
  readonly scheduler?: FrameScheduler;
  /** Holds, prefetch, slow bodies and the clock's ticks. Default: wall-clock timers. */
  readonly timers?: Timers;
  /** Id minting for opIds, undoOpIds and requestIds. */
  readonly mintId?: (prefix: string) => string;
}

export interface DataLayer {
  readonly client: DataClient;
  readonly emitter: Emitter;
  readonly order: StateOrder;
  readonly rows: RowCache;
  readonly fetcher: RowFetcher;
  readonly overlay: Overlay;
  readonly windows: WindowManager;
  readonly session: SessionStore;
  readonly clock: ClockStore;
  readonly bus: FrameBus;
  readonly bodies: BodyStore;
  readonly operations: Operations;
  readonly undoStack: UndoStackStore;
  readonly api: DataApi;
  /** Rows whose last write failed, by thread id. */
  readonly failures: ReadonlyMap<Id, RowFailure>;
  /** The hold controller for one list scope. */
  hold(scope: string): HoldGate;
  /** A prefetch-on-intent tracker for one list. */
  prefetch(): PrefetchIntent;
  /** Apply queued frames and send batched reads now, instead of on the next animation frame. */
  flush(): void;
  /** Frames queued, reads batched or calls unanswered. */
  readonly busy: boolean;
  close(): void;
}

const CACHED: readonly CachedRowType[] = [
  'Thread',
  'Message',
  'Draft',
  'Submission',
  'Event',
  'Plan',
  'Conversation',
  'SenderGroup',
  'Account',
  'Operation',
];

export function createDataLayer(options: DataLayerOptions): DataLayer {
  const scheduler = options.scheduler ?? animationFrameScheduler;
  const timers = options.timers ?? realTimers;
  const client = createDataClient(
    options.session,
    options.mintId ? { mintId: options.mintId } : {},
  );
  const mint = (prefix: string) => client.mintId(prefix);
  const emitter = createEmitter();
  const order = new StateOrder();
  const rows = new RowCache(order, emitter);
  // An entry changes the windows (any of them may show its rows) and its own target rows, nothing else.
  const overlay = new Overlay(entries => {
    const topics = [OVERLAY_TOPIC];
    for (const entry of entries)
      for (const id of entry.targets) topics.push(rowTopic('Thread', id));
    emitter.emit(...topics);
  });
  const clock = new ClockStore(timers);
  const bus = new FrameBus();
  const bodies = new BodyStore(client, emitter, timers);
  const session = new SessionStore(client, emitter, s => {
    order.observe(s.dbEpoch);
    clock.engineNow(s.now);
  });
  let failures = new Map<Id, RowFailure>();
  const holds = new Map<string, HoldGate>();

  let queue: Frame[] = [];
  let flushing = false;
  let scheduled: (() => void) | null = null;
  let closed = false;

  const scheduleFlush = () => {
    if (scheduled || flushing || closed) return;
    scheduled = scheduler.request(() => {
      scheduled = null;
      flush();
    });
  };

  const fetcher = new RowFetcher(
    client,
    rows,
    scheduleFlush,
    (type, ids) => {
      // A read that failed leaves the rows stale; the next frame or state change asks again.
      rows.markStale(type, ids);
    },
    () => sweep(),
  );

  const deferred: Array<() => void> = [];
  const windows = new WindowManager({
    client,
    rows,
    fetcher,
    overlay,
    order,
    emitter,
    mail: () => session.settings?.mail,
    failures: () => failures,
    settled: () => sweep(),
    defer: fn => {
      deferred.push(fn);
      scheduleFlush();
    },
  });

  // ---- the overlay ---------------------------------------------------------------------------------------------

  const retainTargets = (entry: OverlayEntry) => rows.retain('Thread', entry.targets);
  const releaseTargets = (entry: OverlayEntry) => rows.release('Thread', entry.targets);

  const addEntry = (entry: OverlayEntry) => {
    overlay.add(entry);
    retainTargets(entry);
  };
  const dropEntry = (opId: OpId) => {
    const entry = overlay.remove(opId);
    if (entry) releaseTargets(entry);
    return entry;
  };

  /** An entry is done once every window and every target row has caught up with its state. */
  const settled = (entry: OverlayEntry): boolean => {
    if (entry.superseded) return false;
    const at = entry.appliedState;
    if (!at || !windows.settled(entry)) return false;
    for (const id of entry.targets) {
      if (!rows.has('Thread', id) || rows.status('Thread', id) === 'notFound') continue;
      if (!order.reached(rows.fetchedAt('Thread', id), at)) return false;
    }
    return true;
  };

  function sweep() {
    for (const entry of overlay.sweep(settled)) releaseTargets(entry);
  }

  /** Where each target sits in every open thread window right now. */
  const placements = (targets: ReadonlySet<Id>) => {
    const out = new Map<string, Map<Id, Placement>>();
    for (const w of windows.all()) {
      const shown = w.rendered();
      if (!shown || w.base?.rowType !== 'Thread') continue;
      const mine = new Map<Id, Placement>();
      shown.ids.forEach((id, index) => {
        if (targets.has(id))
          mine.set(id, {
            index,
            section: sectionAt({ position: w.base!.position, sections: shown.sections }, index),
          });
      });
      if (mine.size) out.set(w.key, mine);
    }
    return out;
  };

  const shownRow = (id: Id): ThreadRow | undefined => {
    const row = rows.get('Thread', id);
    return row && overlay.row(row, rows.fetchedAt('Thread', id), order);
  };

  const beforeImages = (targets: ReadonlySet<Id>) => {
    const out = new Map<Id, ThreadRow>();
    for (const id of targets) {
      const row = shownRow(id);
      if (row) out.set(id, row);
    }
    return out;
  };

  /** The visible ids a selector covers: its section (or every row) in the open window with the same spec. */
  const selectorIds = (selector: ThreadListSelector): Id[] => {
    const key = specKey(selector.spec);
    const w = windows.all().find(win => win.key === key);
    const shown = w?.rendered();
    if (!w?.base || !shown) return [];
    return shown.ids.filter(
      (_, i) =>
        !selector.section ||
        sectionAt({ position: w.base!.position, sections: shown.sections }, i) === selector.section,
    );
  };

  const entryFor = (opId: OpId, effect: Effect): OverlayEntry => {
    if (effect.type === 'act')
      return {
        opId,
        kind: 'act',
        targets: effect.targets,
        action: effect.action,
        selector: effect.selector,
        patch: row => predictRow(row, effect.action, clock.now()),
        before: effect.before,
        originalPosition: effect.originalPosition,
        appliedState: null,
        superseded: false,
      };
    return {
      opId,
      kind: 'restore',
      targets: effect.targets,
      action: effect.action,
      selector: null,
      patch: restorePatch(effect.before),
      before: effect.before,
      originalPosition: effect.originalPosition,
      appliedState: null,
      superseded: false,
    };
  };

  /** The effect that reverses one: an act's inverse restores its rows; a restore's inverse applies the action again. */
  const inverse = (effect: Effect): Effect => {
    if (effect.type === 'act')
      return {
        type: 'restore',
        action: effect.action,
        targets: effect.targets,
        before: effect.before,
        originalPosition: effect.originalPosition,
      };
    return {
      type: 'act',
      action: effect.action,
      selector: null,
      targets: effect.targets,
      before: beforeImages(effect.targets),
      originalPosition: placements(effect.targets),
    };
  };

  // ---- failures ------------------------------------------------------------------------------------------------

  const setFailures = (record: OpRecord, message: string) => {
    if (!record.action || record.kind !== 'act' || record.undoneBy) return;
    const action = record.action;
    const next = new Map(failures);
    const failure: RowFailure = {
      opId: record.opId,
      action,
      message,
      // A rejected write acts again; a provider refusal after the receipt goes through Operation/retry.
      retry: () => {
        failure.dismiss();
        return retry(record);
      },
      dismiss: () => {
        const left = new Map(failures);
        let changed = false;
        for (const [id, f] of left)
          if (f.opId === record.opId) {
            left.delete(id);
            changed = true;
          }
        if (changed) {
          failures = left;
          emitter.emit(FAILURES_TOPIC);
        }
      },
    };
    for (const id of record.targets) next.set(id, failure);
    failures = next;
    emitter.emit(FAILURES_TOPIC);
  };

  const clearFailures = (ids: Iterable<Id>) => {
    let next: Map<Id, RowFailure> | null = null;
    for (const id of ids)
      if (failures.has(id)) {
        next ??= new Map(failures);
        next.delete(id);
      }
    if (next) {
      failures = next;
      emitter.emit(FAILURES_TOPIC);
    }
  };

  /** Drop the inline errors one operation put on its rows (it went through, or was undone). */
  const clearFailuresOf = (opId: OpId) => {
    const ids: Id[] = [];
    for (const [id, f] of failures) if (f.opId === opId) ids.push(id);
    clearFailures(ids);
  };

  /** Operation rows held for records still remembered; released when the record is forgotten. */
  const heldOperations = new Set<OpId>();

  // ---- commands ------------------------------------------------------------------------------------------------

  const settle = (opId: OpId, call: Promise<Receipt>): Promise<Receipt> => {
    const receipt = call.then(
      r => onReceipt(opId, r),
      error => onReject(opId, error),
    );
    receipt.catch(() => {});
    return receipt;
  };

  const onReceipt = (opId: OpId, receipt: Receipt): Receipt => {
    emitter.batch(() => {
      order.observe(receipt.appliedState.dbEpoch);
      const entry = overlay.get(opId);
      if (entry) {
        entry.appliedState = receipt.appliedState;
        overlay.touch(entry);
      }
      const record = operations.get(opId);
      if (record) {
        record.state = 'confirmed';
        record.receiptUndoable = receipt.undoable !== false;
        record.undoUntil = receipt.undoUntil ?? null;
        if (record.undoOf) dropEntry(record.undoOf);
        if (!heldOperations.has(opId)) {
          heldOperations.add(opId);
          rows.retain('Operation', [opId]);
        }
        fetcher.request('Operation', [opId]);
        operations.changed(opId);
      }
      sweep();
    });
    return receipt;
  };

  const onReject = (opId: OpId, error: unknown): never => {
    const body = toErrorBody(error);
    emitter.batch(() => {
      dropEntry(opId);
      const record = operations.get(opId);
      if (record) {
        record.state = 'failed';
        record.error = body;
        if (record.undoOf) {
          const original = overlay.get(record.undoOf);
          if (original) {
            original.superseded = false;
            overlay.touch(original);
          }
          const undone = operations.get(record.undoOf);
          if (undone?.undoneBy === opId) undone.undoneBy = null;
        }
        setFailures(record, body.message);
      }
      emitter.emit();
    });
    throw new OperationFailedError(opId, body);
  };

  function act(args: ThreadActArgs): ActResult {
    const opId = args.opId ?? mint('op');
    const selector = args.selector ?? null;
    const action = args.action;
    const ids = args.ids?.length ? [...args.ids] : selector ? selectorIds(selector) : [];
    const targets = new Set(ids);
    const effect: Effect = {
      type: 'act',
      action,
      selector,
      targets,
      before: beforeImages(targets),
      originalPosition: placements(targets),
    };
    emitter.batch(() => {
      addEntry(entryFor(opId, effect));
      clearFailures(targets);
      operations.add({
        opId,
        kind: 'act',
        undoOf: null,
        action,
        selector,
        targets: ids,
        effect,
        state: 'pending',
        error: null,
        receiptUndoable: true,
        undoUntil: null,
        undoneBy: null,
      });
      if (!args.quiet) undoStack.pushOperation(opId);
    });
    const wire = args.ids?.length
      ? { opId, ids: [...args.ids], action }
      : { opId, selector: selector!, action };
    return { opId, receipt: settle(opId, client.call('Thread/act', wire)) };
  }

  function undo(args: UndoArgs): ActResult {
    const undoOpId = args.undoOpId ?? mint('op');
    const record = operations.get(args.opId);
    const alreadyUndone =
      !!record?.undoneBy || rows.get('Operation', args.opId)?.state === 'cancelled';
    let effect: Effect | null = null;
    emitter.batch(() => {
      if (record && !alreadyUndone) {
        // Every record is marked, effect or not (a command has none), so its view stops being undoable at once.
        if (record.effect) {
          const original = overlay.get(args.opId);
          if (original) {
            original.superseded = true;
            overlay.touch(original);
          }
          effect = inverse(record.effect);
          addEntry(entryFor(undoOpId, effect));
        }
        record.undoneBy = undoOpId;
        operations.changed(args.opId);
      }
      clearFailuresOf(args.opId);
      operations.add({
        opId: undoOpId,
        kind: 'undo',
        undoOf: args.opId,
        action: record?.action ?? null,
        selector: null,
        targets: record ? [...record.targets] : [],
        effect,
        state: 'pending',
        error: null,
        receiptUndoable: true,
        undoUntil: null,
        undoneBy: null,
      });
    });
    return {
      opId: undoOpId,
      receipt: settle(undoOpId, client.call('Operation/undo', { opId: args.opId, undoOpId })),
    };
  }

  const retry = (record: OpRecord): ActResult => {
    if (record.state === 'failed' && record.kind === 'command' && record.reissue)
      return record.reissue();
    if (record.state === 'failed' && record.kind === 'act' && record.action) {
      return record.selector && !record.targets.length
        ? act({ selector: record.selector, action: record.action })
        : act({ ids: [...record.targets], action: record.action });
    }
    if (record.state === 'confirmed' && rows.get('Operation', record.opId)?.state === 'failed') {
      const receipt = client.call('Operation/retry', { opId: record.opId }).then(
        r => {
          rows.markStale('Operation', [record.opId]);
          fetcher.request('Operation', [record.opId]);
          clearFailuresOf(record.opId);
          return r;
        },
        error => {
          const body = toErrorBody(error);
          setFailures(record, body.message);
          throw new OperationFailedError(record.opId, body);
        },
      );
      receipt.catch(() => {});
      return { opId: record.opId, receipt };
    }
    const receipt = Promise.reject(
      new OperationFailedError(record.opId, {
        type: 'validation',
        message: 'There is nothing to retry.',
      }),
    );
    receipt.catch(() => {});
    return { opId: record.opId, receipt };
  };

  const operations = new Operations({
    emitter,
    remote: opId => rows.get('Operation', opId),
    retry,
    undo: opId => undo({ opId }),
    mintId: mint,
    forgotten: opId => {
      if (heldOperations.delete(opId)) rows.release('Operation', [opId]);
    },
  });
  const undoStack = new UndoStackStore(operations, {
    emitter,
    remote: opId => rows.get('Operation', opId),
    retry,
    undo: opId => undo({ opId }),
    mintId: mint,
  });

  /**
   * A write that returns a receipt but has no overlay (calendar, plans, Ask proposals, conversations, calendars,
   * disconnect): it joins the operations the toasts read, its receipt retains the `Operation` row, and when the
   * receipt is undoable it joins the one undo stack when issued (and leaves it if the receipt turns out not undoable), so Z reverses it through `Operation/undo` like `Thread/act`. A
   * rejection takes the same path as `act` and undo (`onReject`): the operation is marked failed (its
   * `OperationView.retry` sends the write again under a fresh `opId`, and yields only the receipt, so a screen
   * re-reads the rows rather than rely on the original result) and the caller gets an `OperationFailedError`.
   */
  function command<A extends { opId?: OpId }, R>(
    args: A,
    send: (args: A & { opId: OpId }) => Promise<R>,
    receiptOf: (result: R) => Receipt,
  ): Promise<R> {
    const issue = (opId: OpId): Promise<R> => {
      const record: OpRecord = {
        opId,
        kind: 'command',
        undoOf: null,
        action: null,
        selector: null,
        targets: [],
        effect: null,
        state: 'pending',
        error: null,
        receiptUndoable: true,
        undoUntil: null,
        undoneBy: null,
        reissue: () => {
          const next = mint('op');
          const result = issue(next);
          const receipt = result.then(receiptOf);
          receipt.catch(() => {});
          return { opId: next, receipt };
        },
      };
      // Like `act`: the record and its place on the undo stack are in the same batch, before the call leaves, so Z
      // pressed while the receipt is in flight undoes this write and the stack keeps issue order.
      emitter.batch(() => {
        operations.add(record);
        undoStack.pushOperation(opId);
      });
      let call: Promise<R>;
      try {
        call = send({ ...args, opId });
      } catch (error) {
        call = Promise.reject(error);
      }
      return call.then(
        result => {
          const receipt = onReceipt(opId, receiptOf(result));
          if (receipt.undoable === false) undoStack.dropOperation(opId);
          return result;
        },
        error => onReject(opId, error),
      );
    };
    const result = issue(args.opId ?? mint('op'));
    result.catch(() => {});
    return result;
  }

  // ---- frames --------------------------------------------------------------------------------------------------

  const onOperationFrame = (operation: Operation, state: State) => {
    rows.put('Operation', [operation], state);
    const record = operations.get(operation.opId);
    if (operation.state !== 'failed') {
      // Retried (here or elsewhere) and on its way again: its rows lose their inline error.
      clearFailuresOf(operation.opId);
      return;
    }
    if (!record || record.kind !== 'act' || !record.effect) return;
    // The provider refused it after the receipt: the engine put the rows back; show them in place until the
    // windows catch up with this frame, with the inline error and Retry.
    dropEntry(operation.opId);
    if (record.undoneBy) return;
    const back = entryFor(`${operation.opId}:returned`, inverse(record.effect));
    back.appliedState = state;
    addEntry(back);
    setFailures(record, operation.error?.message ?? record.error?.message ?? '');
  };

  /** The engine is past `state`: a window still short of an entry it holds will get no frame for it, so re-read it. */
  const catchUpWindows = (state: State) => {
    for (const entry of overlay.entries) {
      if (!entry.appliedState || !order.reached(state, entry.appliedState)) continue;
      for (const w of windows.blocking(entry)) w.refresh();
    }
  };

  const applyFrame = (frame: Frame) => {
    if ('dbEpoch' in frame) order.observe(frame.dbEpoch);
    switch (frame.frame) {
      case 'window':
        windows.frame(frame);
        break;
      case 'reset':
        for (const type of CACHED) {
          rows.markAllStale(type);
          fetcher.request(type, rows.heldOutsideWindows(type));
        }
        windows.reset();
        break;
      case 'state':
        catchUpWindows({ dbEpoch: frame.dbEpoch, seq: frame.seq });
        for (const type of Object.keys(frame.types)) {
          const cached = type === 'Account' || type === 'Operation' ? type : cachedType(type);
          if (!cached) continue;
          const ids = rows.heldOutsideWindows(cached);
          rows.markStale(cached, ids);
          fetcher.request(cached, ids);
        }
        break;
      case 'operation':
        onOperationFrame(frame.operation, { dbEpoch: frame.dbEpoch, seq: frame.seq });
        break;
      case 'Draft/changed':
        if (frame.draft)
          rows.put('Draft', [frame.draft], { dbEpoch: frame.dbEpoch, seq: frame.seq });
        else {
          rows.markStale('Draft', [frame.draftId]);
          fetcher.request('Draft', [frame.draftId]);
        }
        break;
      case 'host':
        if (frame.event.type === 'clock') clock.engineNow(frame.event.now);
        break;
      default:
        break;
    }
    session.frame(frame);
    const stream = streamFrame(frame);
    if (stream) bus.push(stream.kind, stream.frame);
  };

  function flush() {
    if (flushing || closed) return;
    flushing = true;
    try {
      emitter.batch(() => {
        for (const run of deferred.splice(0)) run();
        const frames = queue;
        queue = [];
        for (const frame of frames) applyFrame(frame);
        fetcher.flush();
        windows.sweepUnused();
        sweep();
      });
    } finally {
      flushing = false;
    }
    if (queue.length || fetcher.pending || deferred.length) scheduleFlush();
  }

  const stopFrames = client.subscribe(frame => {
    queue.push(frame);
    scheduleFlush();
  });

  // ---- api -----------------------------------------------------------------------------------------------------

  const api = buildApi({ client, mint, act, undo, command });

  session.start();
  // Whether Done and Later take a row out of the Inbox depends on the owner's settings; never predict on defaults.
  session.want('settings');

  return {
    client,
    emitter,
    order,
    rows,
    fetcher,
    overlay,
    windows,
    session,
    clock,
    bus,
    bodies,
    operations,
    undoStack,
    api,
    get failures() {
      return failures;
    },
    hold(scope) {
      let gate = holds.get(scope);
      if (!gate) holds.set(scope, (gate = createHoldGate(timers)));
      return gate;
    },
    prefetch: () => createPrefetchIntent(client, timers),
    flush,
    get busy() {
      return queue.length > 0 || fetcher.pending || deferred.length > 0 || client.inFlight > 0;
    },
    close() {
      if (closed) return;
      closed = true;
      scheduled?.();
      stopFrames();
      for (const gate of holds.values()) gate.dispose();
      for (const w of windows.all()) w.close();
      client.close();
    },
  };
}
