import {
  checkResult,
  fromReply,
  getMethod,
  isMethod,
  parseArgs,
  toReply,
  type EngineMethodName,
  type ErrorBody,
  type Frame,
  type Input,
  type NotificationItem,
  type Operation,
  type Output,
  type Receipt,
  type ViewSpec,
  type WindowBody,
} from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { appScopes, checkAccess, type Caller } from '@aplos/contract/access';
import { methodScope } from '@aplos/contract/allowlists';
import type { EngineConnection, EngineSession } from '@aplos/contract/client';
import { fakeClock, realClock, seeded, type FixtureClock } from './clock';
import { Store, type Touch, type Tx } from './store';
import { runView, type Section, type ViewContext } from './views';
import type { Bytes } from './data/demo';
import {
  controlMethod,
  type AskScript,
  type ConnectOutcome,
  type ControlArgs,
  type SearchScript,
  type Ordering,
} from './control-types';

/** Every scenario the stand-in will serve (plan 10 section 4.1). `empty` and `demo` are complete at C1; the rest arrive in Phase 1. */
export const scenarios = [
  'empty',
  'demo',
  'small-10k',
  'large-100k',
  'offline',
  'needs-reauth',
  'backfilling',
  'rate-limited',
  'partial-threads',
  'send-uncertain',
  'send-suspended',
  'ai-off',
  'ai-budget-spent',
  'setup-partial',
  'parked',
] as const;
export type Scenario = (typeof scenarios)[number];

export interface FixtureOptions {
  scenario?: Scenario;
  /** Same seed, same epoch, ids and fake statuses. Default 1. */
  seed?: number;
  /** A start time for a fake clock (default `defaultNow`), `'real'` for wall-clock time, or a clock to share. */
  clock?: number | 'real' | FixtureClock;
  /** The zone due bands, Later presets and demo events are computed in. Default `America/Los_Angeles`. */
  timeZone?: string;
  /** Validate every result with the registry's `checkResult` (default true: a fixture bug fails loudly). */
  checkResults?: boolean;
}

/** What a handler receives besides its validated arguments. */
export interface CallContext {
  sessionId: string;
  /** Who is calling: a window (the default for `connect()`), main, or a listener client with its granted scopes. */
  caller: Caller;
}
/** What `connect()` gives a session when the caller is not named: an Electron window, holding every scope. */
export const windowCaller: Caller = { kind: 'window', scopes: appScopes };
export type Handler<M extends EngineMethodName> = (args: Input<M>, cx: CallContext) => Output<M>;
export type Handlers = { [M in EngineMethodName]: Handler<M> };

export { controlMethod };

/** Window frames per window are at most 4 per second (ARCH 9.2). */
export const windowIntervalMs = 250;
/** `state` frames coalesce over this long (ARCH 9.2: 50-250 ms). */
export const stateCoalesceMs = 100;
/** A hold lapses this long after the last activity (`View/hold`). */
export const holdLapseMs = 2_000;

interface WindowRec {
  id: string;
  sessionId: string;
  spec: ViewSpec;
  position: number;
  limit: number;
  holds: Set<string>;
  holdTimer?: () => void;
  frozen?: string[];
  /** The full ordered list and per-row revisions as last sent, and the last frame's visible body. */
  prev: string[];
  revs: Map<string, number>;
  last: string;
  lastSentAt: number;
  timer?: () => void;
}

interface OpRec {
  operation: Operation;
  touched: Touch[];
  method: string;
  /** The scope of the method that made it, always recorded; undo, retry and the queue need it too (FR-3, R2B-1). */
  scope: string;
  /** How `Operation/undo` undoes it when restoring before-images is not the inverse (a held send is cancelled). */
  undo?: (undoOpId: string) => Receipt;
  /** Accounts whose `pendingChanges` this operation counts in while it is queued for the provider. */
  pending: string[];
}
interface FailSpec {
  mode: 'reject' | 'afterReceipt';
  type: string;
  message: string;
  reasonCode?: string;
  afterMs: number;
}

const rowTables: Record<
  string,
  'Thread' | 'Message' | 'Draft' | 'Submission' | 'Event' | 'Plan' | 'Conversation' | undefined
> = {
  Thread: 'Thread',
  Message: 'Message',
  Draft: 'Draft',
  Submission: 'Submission',
  Event: 'Event',
  Plan: 'Plan',
  Conversation: 'Conversation',
};

/** The engine state behind every connection of one `createFixtureEngine` call. */
export class Fixture {
  readonly clock: FixtureClock;
  readonly zone: string;
  readonly seed: number;
  readonly random: () => number;
  readonly checkResults: boolean;
  store: Store;
  bodies: Record<string, string> = {};
  files: Record<string, { bytes: Bytes; mime: string; name: string }> = {};
  /** Blobs by id, each owned by the principal that made it (`principalOf`): another caller gets `notFound` (FR-6). */
  blobs = new Map<string, { bytes: Bytes; mime: string; name?: string; owner: string }>();
  notifications: NotificationItem[] = [];
  mailFrames = new Map<
    string,
    { messageId: string; expiresAt: number; quotesOpen: boolean; imagePolicy: 'block' | 'load' }
  >();
  ops = new Map<string, OpRec>();
  /** Results of commands by `method + opId`, so a replayed opId never applies twice (the HTTP `Idempotency-Key`). */
  replies = new Map<string, unknown>();
  windows = new Map<string, WindowRec>();
  sessions = new Map<
    string,
    { listeners: Set<(frame: Frame) => void>; closed: boolean; caller: Caller }
  >();
  /** The scope of the method being dispatched, stamped on the operations it writes. */
  private callScope?: string;
  /** Cancels for running timers keyed by run, connect or job id (`Ask/cancel`, `Account/cancelConnect`, `Ai/cancel`). */
  runs = new Map<string, () => void>();
  ordering: Ordering = { mode: 'receiptFirst' };
  /** Live connect flows by `connectId`, so a cancel or the `resolveConnect` knob can end one with any outcome. */
  connects = new Map<string, { finish: (outcome: ConnectOutcome) => void }>();
  /** Threads remote search found, by query text; they join matching search windows (`searchRemote` knob). */
  remoteResults = new Map<string, string[]>();
  /** Scripts the AI knobs queued: the next Ask run, the next failure per feature, the next transcription. */
  askScripts: AskScript[] = [];
  aiFailures = new Map<string, { reasonCode: string; message?: string }>();
  transcripts: string[] = [];
  searchScripts: SearchScript[] = [];
  /** Outcomes `resolveConnect` queued for the next flows; a flow without one connects after 800 ms. */
  connectScripts: (ConnectOutcome & { delayMs?: number })[] = [];
  failures: FailSpec[] = [];
  sendOutcomes: ('sent' | 'uncertain' | 'failed')[] = [];
  /** Submissions whose thread is marked Done once sent (`send.alsoDone`). */
  alsoDone = new Set<string>();
  /** A practice account's mailbox, landing a batch per setup tick, and its size for `firstWindow.found`. */
  pendingMail = new Map<string, ((tx: Tx) => void)[]>();
  pendingThreads = new Map<string, number>();
  setupId?: string;
  handlers!: Handlers;
  control!: (args: ControlArgs) => unknown;
  private capture?: Map<string, Frame[]>;
  private pendingTypes = new Map<string, number>();
  private stateTimer?: () => void;
  private counter = 0;
  private epochCount = 0;

  constructor(
    readonly scenario: Scenario,
    options: FixtureOptions,
  ) {
    this.seed = options.seed ?? 1;
    this.random = seeded(this.seed);
    this.zone = options.timeZone ?? 'America/Los_Angeles';
    this.checkResults = options.checkResults ?? true;
    const c = options.clock;
    this.clock = c === 'real' ? realClock() : typeof c === 'object' ? c : fakeClock(c);
    this.store = new Store(this.newEpoch());
  }

  get now() {
    return this.clock.now();
  }
  get view(): ViewContext {
    return {
      store: this.store,
      now: this.now,
      zone: this.zone,
      body: id => this.bodies[id] ?? '',
      remote: this.remoteResults,
    };
  }

  newEpoch() {
    return `fx${this.seed}-${((this.random() * 2 ** 32) >>> 0).toString(36)}-${++this.epochCount}`;
  }
  /** A deterministic id: `prefix-n`. */
  id(prefix: string) {
    return `${prefix}-${++this.counter}`;
  }

  // ---- frames ------------------------------------------------------------------------------------------------

  /** Stamps a frame with the current `{dbEpoch, seq}` and sends it to one session or all. Inside a call it waits for the reply ordering. */
  emit(frame: DistributiveOmit<Frame, 'dbEpoch' | 'seq'>, to?: string) {
    const stamped = { ...frame, dbEpoch: this.store.dbEpoch, seq: this.store.seq } as Frame;
    for (const [sid, s] of this.sessions) {
      if (s.closed || (to && sid !== to)) continue;
      if (this.capture) {
        const list = this.capture.get(sid) ?? [];
        list.push(stamped);
        this.capture.set(sid, list);
      } else this.deliver(sid, stamped);
    }
  }

  deliver(sessionId: string, frame: Frame) {
    const s = this.sessions.get(sessionId);
    if (!s || s.closed) return;
    for (const listener of [...s.listeners]) {
      try {
        listener(structuredClone(frame));
      } catch {
        /* a listener's bug is not the engine's */
      }
    }
  }

  // ---- writes ------------------------------------------------------------------------------------------------

  /**
   * Commits a change and returns its receipt. `opId` makes it an operation: recorded for `Operation/get`, undoable from
   * its before-images, and, when `provider` is set, queued then synced (or failed, by the control channel) on the clock.
   */
  write<V>(
    opts: {
      opId?: string;
      kind: string;
      targets?: string[];
      undoable?: boolean;
      undoUntil?: number;
      provider?: boolean;
      /** The originating scope, when not the dispatched method's own (a send queued by `Queue/retry` is still `send`). */
      scope?: string;
      undo?: (undoOpId: string) => Receipt;
    },
    fn: (tx: Tx) => V,
  ): { value: V; receipt: Receipt } {
    const fail = opts.opId ? this.failures[0] : undefined;
    if (fail?.mode === 'reject') {
      this.failures.shift();
      throw new ContractError({
        type: fail.type,
        message: fail.message,
        ...(fail.reasonCode ? { reasonCode: fail.reasonCode } : {}),
      });
    }
    // A provider-bound operation counts in its accounts' `pendingChanges` until it syncs or fails. That bump is kept out
    // of the operation's own before-images, so undo never restores a stale account row.
    const pending: string[] = [],
      bumpOnly = new Set<string>();
    const {
      value,
      touched: all,
      types,
    } = this.store.commit(tx => {
      const v = fn(tx);
      if (opts.provider && opts.opId) {
        const mine = tx.touched();
        for (const id of accountsOf(mine)) {
          if (!mine.some(t => t.table === 'Account' && t.id === id)) bumpOnly.add(id);
          if (this.bumpPending(tx, id, 1)) pending.push(id);
        }
      }
      return v;
    });
    const touched = all.filter(t => !(t.table === 'Account' && bumpOnly.has(t.id)));
    this.changed(types);
    const appliedState = this.store.state;
    const undoable = opts.undoable ?? true;
    const receipt: Receipt = {
      opId: opts.opId ?? this.id('op'),
      appliedState,
      ...(opts.undoUntil ? { undoUntil: opts.undoUntil } : {}),
      undoable,
    };
    if (opts.opId) {
      // Every operation records its originating scope (R2B-1): the dispatched method's, else its kind's own.
      const scope = opts.scope ?? this.callScope ?? methodScope[opts.kind];
      if (!scope) throw new Error(`The stand-in wrote ${opts.kind} with no originating scope.`);
      const operation: Operation = {
        opId: opts.opId,
        kind: opts.kind,
        targets: opts.targets ?? [...new Set(touched.map(t => t.id))],
        state: opts.provider ? 'queued' : 'applied',
        appliedState,
        undoable,
        ...(opts.undoUntil ? { undoUntil: opts.undoUntil } : {}),
        createdAt: this.now,
        scope,
      };
      this.ops.set(opts.opId, {
        operation,
        touched,
        method: opts.kind,
        scope,
        pending,
        ...(opts.undo ? { undo: opts.undo } : {}),
      });
      if (opts.provider)
        this.syncLater(
          opts.opId,
          fail?.mode === 'afterReceipt' ? this.failures.shift() : undefined,
        );
    }
    return { value, receipt };
  }

  /** The provider's answer to a queued operation: synced, or rejected, which puts the rows back and reports the error. */
  syncLater(opId: string, fail?: FailSpec) {
    this.clock.after(fail?.afterMs ?? 600, () => {
      const rec = this.ops.get(opId);
      if (!rec || rec.operation.state !== 'queued') return;
      const { types } = this.store.commit(tx => {
        this.settlePending(tx, rec);
        if (fail) this.restore(tx, rec.touched, 'before');
        // Events written here now exist at the provider.
        else
          for (const t of rec.touched)
            if (t.table === 'Event') {
              const e = tx.get('Event', t.id);
              if (e?.sync === 'pending') tx.put('Event', { ...e, sync: 'synced' });
            }
      });
      this.changed(types);
      rec.operation = fail
        ? {
            ...rec.operation,
            state: 'failed',
            error: {
              type: fail.type,
              message: fail.message,
              ...(fail.reasonCode ? { reasonCode: fail.reasonCode } : {}),
            },
          }
        : { ...rec.operation, state: 'synced' };
      this.emit({ frame: 'operation', operation: rec.operation });
    });
  }

  /** Moves an account's `pendingChanges` by `delta`; false when the account is gone. */
  bumpPending(tx: Tx, accountId: string, delta: number) {
    const a = tx.get('Account', accountId);
    if (!a) return false;
    tx.put('Account', { ...a, pendingChanges: Math.max(0, a.pendingChanges + delta) });
    return true;
  }
  /** An operation left the provider queue (synced, failed or cancelled): stop counting it, once. */
  settlePending(tx: Tx, rec: OpRec) {
    for (const id of rec.pending.splice(0)) this.bumpPending(tx, id, -1);
  }

  /** Writes rows back to their before- or after-images inside a transaction (undo, a failed write, retry). Revisions still move forward. */
  restore(tx: Tx, touched: Touch[], side: 'before' | 'after') {
    for (const t of touched) {
      const row = t[side] as { id: string } | undefined;
      if (row === undefined) tx.del(t.table, t.id);
      else
        tx.put(t.table, {
          ...row,
          ...('rev' in row
            ? { rev: (tx.get(t.table, t.id) as { rev?: number } | undefined)?.rev ?? 0 }
            : {}),
        } as never);
    }
  }

  /** The same as one new commit of its own. */
  replay(touched: Touch[], side: 'before' | 'after') {
    const { types } = this.store.commit(tx => this.restore(tx, touched, side));
    this.changed(types);
  }

  /** After a commit: queue the coalesced `state` frame and let every open window reconcile. */
  changed(types: Set<string>) {
    if (!types.size) return;
    if (types.has('Thread')) this.scheduleLater();
    for (const type of types) this.pendingTypes.set(type, this.store.seq);
    this.stateTimer ??= this.clock.after(stateCoalesceMs, () => {
      this.stateTimer = undefined;
      const types = Object.fromEntries(this.pendingTypes);
      this.pendingTypes.clear();
      this.emit({ frame: 'state', types });
    });
    for (const w of this.windows.values()) this.refresh(w);
  }

  /**
   * Back from Later (`ThreadRow.fromLater`): a timer at the soonest `laterUntil` flips the flag in its own commit, as the
   * real engine's timer does, so Home's windows move the row to the bottom of Do now when its time comes.
   */
  private laterTimer?: { at: number; cancel: () => void };
  scheduleLater(seeding = false) {
    const waiting = this.store
      .all('Thread')
      .filter(
        t => t.workflow.status === 'later' && t.workflow.laterUntil !== undefined && !t.fromLater,
      );
    const due = waiting.filter(t => t.workflow.laterUntil! <= this.now);
    if (due.length) {
      if (seeding) for (const t of due) this.store.seed('Thread', { ...t, fromLater: true });
      else {
        const { types } = this.store.commit(tx => {
          for (const t of due) tx.put('Thread', { ...t, fromLater: true });
        });
        this.changed(types);
        return;
      }
    }
    const next = Math.min(
      ...waiting.filter(t => t.workflow.laterUntil! > this.now).map(t => t.workflow.laterUntil!),
    );
    if (this.laterTimer?.at === next) return;
    this.laterTimer?.cancel();
    this.laterTimer = Number.isFinite(next)
      ? {
          at: next,
          cancel: this.clock.after(next - this.now, () => {
            this.laterTimer = undefined;
            this.scheduleLater();
          }),
        }
      : undefined;
  }

  // ---- windows -----------------------------------------------------------------------------------------------

  openWindow(
    sessionId: string,
    spec: ViewSpec,
    holdIds: string[] = [],
    anchor?: { id?: string; offset?: number; position?: number },
    limit?: number,
  ): WindowBody {
    const w: WindowRec = {
      id: this.id('w'),
      sessionId,
      spec,
      position: 0,
      limit: spec.kind === 'events' ? Infinity : (limit ?? 100),
      holds: new Set(holdIds),
      prev: [],
      revs: new Map(),
      last: '',
      lastSentAt: -Infinity,
    };
    if (spec.kind === 'oneByOne') w.frozen = runView(this.view, spec).ids;
    const body = this.compute(w);
    w.position = this.resolve(w, anchor, body.total);
    this.windows.set(w.id, w);
    if (holdIds.length) this.touchHold(w);
    return this.commitBody(w, this.compute(w));
  }

  window(windowId: string) {
    const w = this.windows.get(windowId);
    if (!w)
      throw new ContractError({
        type: 'notFound',
        message: 'This list is no longer open. Reopen it.',
      });
    return w;
  }

  moveWindow(
    w: WindowRec,
    anchor?: { id?: string; offset?: number; position?: number },
    limit?: number,
    range?: { from: number; to: number },
  ) {
    if (range && w.spec.kind === 'events') w.spec = { ...w.spec, ...range };
    if (limit && w.spec.kind !== 'events') w.limit = limit;
    w.position = this.resolve(w, anchor, this.compute(w).total);
    if (w.holds.size) this.touchHold(w);
    return this.commitBody(w, this.compute(w));
  }

  closeWindow(windowId: string) {
    const w = this.windows.get(windowId);
    if (!w) return;
    w.timer?.();
    w.holdTimer?.();
    this.windows.delete(windowId);
  }

  hold(w: WindowRec, ids: string[]) {
    for (const id of ids) w.holds.add(id);
    this.touchHold(w);
  }
  release(w: WindowRec, ids?: string[]) {
    if (ids) for (const id of ids) w.holds.delete(id);
    else w.holds.clear();
    if (!w.holds.size) {
      w.holdTimer?.();
      w.holdTimer = undefined;
    }
    this.refresh(w);
  }
  private touchHold(w: WindowRec) {
    w.holdTimer?.();
    w.holdTimer = this.clock.after(holdLapseMs, () => {
      w.holdTimer = undefined;
      w.holds.clear();
      this.refresh(w);
    });
  }

  private resolve(
    w: WindowRec,
    anchor: { id?: string; offset?: number; position?: number } | undefined,
    total: number,
  ) {
    if (!anchor) return Math.min(w.position, Math.max(0, total - 1));
    let at = anchor.position ?? w.position;
    if (anchor.id) {
      const i = w.prev.indexOf(anchor.id);
      at = i >= 0 ? i : this.fullList(w).ids.indexOf(anchor.id);
      if (at < 0) at = 0;
    }
    return Math.max(0, Math.min(at + (anchor.offset ?? 0), Math.max(0, total - 1)));
  }

  private fullList(w: WindowRec) {
    if (w.frozen) {
      const rowType = 'Thread';
      return {
        rowType,
        ids: w.frozen.filter(id => this.store.get('Thread', id)),
        sections: [] as Section[],
      };
    }
    return runView(this.view, w.spec);
  }

  /** The window as it should look now: the view's order with held rows kept where they were last sent. */
  private compute(w: WindowRec): WindowBody & { full: string[] } {
    const result = this.fullList(w);
    let full = result.ids,
      sections = result.sections;
    const kept = new Map<number, string>();
    for (const id of w.holds) {
      const i = w.prev.indexOf(id);
      if (i >= 0) kept.set(i, id);
    }
    if (kept.size) {
      const keptIds = new Set(kept.values());
      const rest = full.filter(id => !keptIds.has(id));
      const out: string[] = [];
      let r = 0;
      for (let i = 0; out.length < rest.length + kept.size; i++) {
        if (kept.has(i)) out.push(kept.get(i)!);
        else if (r < rest.length) out.push(rest[r++]!);
        else for (const id of keptIds) if (!out.includes(id)) out.push(id);
      }
      full = out;
      if (sections.length) sections = this.resection(full, result.ids, sections, w);
    }
    const end = w.limit === Infinity ? full.length : w.position + w.limit;
    const ids = full.slice(w.position, end);
    const table = rowTables[result.rowType];
    const changed = ids.filter(id => {
      const before = w.revs.get(id);
      const rev = table
        ? (this.store.get(table, id) as { rev?: number } | undefined)?.rev
        : undefined;
      return before !== undefined && rev !== undefined && rev !== before;
    });
    const held = full.filter(id => w.holds.has(id));
    return {
      windowId: w.id,
      state: this.store.state,
      rowType: result.rowType,
      ids,
      position: w.position,
      total: full.length,
      sections,
      ...(changed.length ? { changed } : {}),
      ...(held.length ? { held } : {}),
      full,
    };
  }

  /** Sections for a held order: each row keeps the section it is in now, or the one it was in when last sent. */
  private resection(full: string[], fresh: string[], sections: Section[], w: WindowRec): Section[] {
    const keyOf = (list: string[], secs: Section[], id: string) => {
      const i = list.indexOf(id);
      return secs.find(s => s.key !== 'low' && i >= s.start && i < s.start + s.count)?.key;
    };
    const prevSections = this.lastSections.get(w.id) ?? sections;
    const runs: Section[] = [];
    full.forEach((id, i) => {
      const key =
        keyOf(fresh, sections, id) ?? keyOf(w.prev, prevSections, id) ?? sections[0]?.key ?? 'rows';
      const run = runs.find(r => r.key === key);
      if (run) run.count++;
      else runs.push({ key, start: i, count: 1 });
    });
    const low = sections.find(s => s.key === 'low');
    if (low) {
      const follow = runs.find(r => r.key === 'follow');
      runs.splice(follow ? runs.indexOf(follow) : runs.length, 0, {
        ...low,
        start: follow?.start ?? full.length,
      });
    }
    return runs;
  }
  private lastSections = new Map<string, Section[]>();

  /** Records a body as sent (a watch or move answer, or a frame) and strips the internal full list. */
  private commitBody(w: WindowRec, body: WindowBody & { full: string[] }): WindowBody {
    const { full, ...wire } = body;
    w.prev = full;
    const table = rowTables[wire.rowType];
    w.revs = new Map(
      wire.ids.map(id => [
        id,
        (table ? (this.store.get(table, id) as { rev?: number } | undefined)?.rev : undefined) ?? 0,
      ]),
    );
    w.last = JSON.stringify([wire.ids, wire.total, wire.position, wire.sections, wire.held]);
    this.lastSections.set(w.id, wire.sections);
    return wire;
  }

  /** Re-runs a window after a change; sends an ID-only frame at most every `windowIntervalMs`. */
  refresh(w: WindowRec) {
    if (w.timer || !this.windows.has(w.id)) return;
    const wait = w.lastSentAt + windowIntervalMs - this.now;
    if (wait > 0) {
      w.timer = this.clock.after(wait, () => {
        w.timer = undefined;
        this.refresh(w);
      });
      return;
    }
    let body: WindowBody & { full: string[] };
    try {
      body = this.compute(w);
    } catch {
      return;
    }
    const visible = JSON.stringify([body.ids, body.total, body.position, body.sections, body.held]);
    if (visible === w.last && !body.changed) return;
    const wire = this.commitBody(w, body);
    w.lastSentAt = this.now;
    this.emit({ frame: 'window', ...wire }, w.sessionId);
  }

  /** Stops one session's windows of a kind with a last frame carrying `error` (remote search paused or unavailable). */
  stopWindows(sessionId: string, kind: ViewSpec['kind'], error: ErrorBody) {
    for (const w of [...this.windows.values()])
      if (w.sessionId === sessionId && w.spec.kind === kind) {
        const wire = this.commitBody(w, this.compute(w));
        this.emit({ frame: 'window', ...wire, error }, sessionId);
        this.closeWindow(w.id);
      }
  }

  /** Voids every window (another `dbEpoch`, a restore, a restart) and tells every session to re-open and re-read. */
  reset(reason: 'dbEpoch' | 'cannotCalculateChanges' | 'restore' | 'restart') {
    for (const id of [...this.windows.keys()]) this.closeWindow(id);
    if (reason === 'dbEpoch' || reason === 'restore') {
      this.store.dbEpoch = this.newEpoch();
      this.store.compact();
    }
    this.emit({ frame: 'reset', reason });
  }

  // ---- calls -------------------------------------------------------------------------------------------------

  dispatch(sessionId: string, method: string, rawArgs: unknown): unknown {
    if (!isMethod(method))
      throw new ContractError({ type: 'unsupported', message: 'Unsupported application method.' });
    const def = getMethod(method);
    if (def.host !== 'engine')
      throw new ContractError({
        type: 'unsupported',
        message: 'This method belongs to the desktop app, not the engine.',
      });
    const args = parseArgs(method, rawArgs) as { opId?: string };
    const caller = this.sessions.get(sessionId)?.caller ?? windowCaller;
    checkAccess(method, caller, args);
    const meta = this.store.get('Meta', 'meta')!;
    if (
      meta.engine.state === 'parked' &&
      !/^(Session\/get|Diagnostics\/|Setup\/status)/.test(method)
    )
      throw new ContractError({
        type: 'unavailable',
        message: meta.engine.parked?.message ?? 'Aplos is not running right now.',
      });
    const key =
      def.kind === 'command' && typeof args.opId === 'string'
        ? `${method}\u0000${args.opId}`
        : undefined;
    if (key && this.replies.has(key)) return this.replies.get(key);
    const outer = this.callScope;
    this.callScope = def.scope;
    let result: unknown;
    try {
      result = (this.handlers[method as EngineMethodName] as Handler<EngineMethodName>)(
        args as never,
        { sessionId, caller },
      );
    } finally {
      this.callScope = outer;
    }
    if (this.checkResults) checkResult(method, result);
    if (key) this.replies.set(key, result);
    return result;
  }

  /** One call through a real reply envelope, with frames released in the configured order relative to the reply. */
  async call(sessionId: string, callId: number, method: string, args: unknown): Promise<unknown> {
    if (method === controlMethod) {
      this.runDeferred();
      return structuredClone((await this.control(args as ControlArgs)) ?? { ok: true });
    }
    const capture = new Map<string, Frame[]>();
    this.capture = capture;
    let outcome: { result: unknown } | { error: unknown };
    try {
      outcome = { result: this.dispatch(sessionId, method, args) };
    } catch (error) {
      outcome = { error };
    } finally {
      this.capture = undefined;
    }
    const reply = structuredClone(toReply(callId, outcome));
    const flush = () => {
      for (const [sid, frames] of capture) for (const f of frames) this.deliver(sid, f);
    };
    if (!capture.size) return fromReply(reply);
    const later = (fn: () => void) => {
      if (this.ordering.delayMs) {
        this.clock.after(this.ordering.delayMs, fn);
        return;
      }
      this.deferred.push(fn);
      setTimeout(() => this.runDeferred(), 0);
    };
    if (this.ordering.mode === 'frameFirst') {
      flush();
      return new Promise((resolve, reject) =>
        later(() => {
          try {
            resolve(fromReply(reply));
          } catch (e) {
            reject(e);
          }
        }),
      );
    }
    if (this.ordering.mode === 'together') {
      flush();
      return fromReply(reply);
    }
    later(flush);
    return fromReply(reply);
  }

  /** Replies or frames held back one task by the ordering; a control call releases them first, so time never jumps past them. */
  private deferred: (() => void)[] = [];
  private runDeferred() {
    for (const fn of this.deferred.splice(0)) fn();
  }

  /** A new session; `caller` defaults to an Electron window. Listener callers get the listener's rules (`checkAccess`). */
  connect(caller: Caller = windowCaller): EngineSession {
    const sessionId = this.id('s');
    const s = { listeners: new Set<(frame: Frame) => void>(), closed: false, caller };
    this.sessions.set(sessionId, s);
    let callId = 0;
    const meta = this.store.get('Meta', 'meta');
    if (meta?.engine.parked) {
      const p = meta.engine.parked;
      setTimeout(
        () =>
          this.emit(
            {
              frame: 'host',
              event: {
                type: 'parked',
                reasonCode: p.reasonCode,
                message: p.message,
                canRetry: p.canRetry,
                at: p.at,
              },
            },
            sessionId,
          ),
        0,
      );
    }
    return {
      call: (method, args) =>
        s.closed
          ? Promise.reject(
              new ContractError({ type: 'unavailable', message: 'This connection is closed.' }),
            )
          : this.call(sessionId, ++callId, method, args),
      subscribe: listener => {
        s.listeners.add(listener);
        return () => {
          s.listeners.delete(listener);
        };
      },
      close: () => {
        s.closed = true;
        s.listeners.clear();
        for (const w of [...this.windows.values()])
          if (w.sessionId === sessionId) this.closeWindow(w.id);
      },
    };
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The accounts whose rows a commit touched (threads, messages, events and the rest carry `accountId`). */
export function accountsOf(touched: Touch[]): string[] {
  const ids = new Set<string>();
  for (const t of touched) {
    if (t.table === 'Account') continue;
    const row = (t.after ?? t.before) as { accountId?: string } | undefined;
    if (row?.accountId) ids.add(row.accountId);
  }
  return [...ids];
}

export class FixtureEngine implements EngineConnection {
  /** @internal The engine state; tests use the control channel, never this. */
  readonly fixture: Fixture;
  constructor(fixture: Fixture) {
    this.fixture = fixture;
  }
  /** A session as an Electron window, or as `caller` (a listener client with its scopes, or main). */
  connect(caller?: Caller): EngineSession {
    return this.fixture.connect(caller);
  }
}
