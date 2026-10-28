/**
 * The optimistic overlay (plan 30 4.1 `optimistic.ts`, DESIGN 5 rules 1 and 11). An entry is `{opId, targets, patch,
 * originalPosition}`: applied synchronously when a command is issued, laid over every window and row until that
 * window or row reaches the receipt's `appliedState`, then dropped. Undo and a provider-side failure add a `restore`
 * entry that puts rows back where they were (their `originalPosition`) until the engine's own frames show them there.
 *
 * Everything here is pure over its inputs: the windows and the row cache call `overlayWindow` and `overlayRow`.
 */
import type {
  Id,
  MailSettings,
  OpId,
  State,
  ThreadAction,
  ThreadRow,
  ViewSpec,
  WindowBody,
  WindowSection,
} from './contract-shapes';
import type { StateOrder } from './states';
import type { ThreadListSelector } from './ui-types';

/** Where a row sat in one window when an entry was applied. */
export interface Placement {
  /** Index in the window's rendered ids. */
  readonly index: number;
  /** The section it was in; null for ungrouped views. */
  readonly section: string | null;
}

export interface OverlayEntry {
  readonly opId: OpId;
  /** `act` predicts an action; `restore` shows rows as they were before an operation it reverses. */
  readonly kind: 'act' | 'restore';
  /** The rows it changes. For a selector, the ids that were visible when it was issued. */
  readonly targets: ReadonlySet<Id>;
  readonly action: ThreadAction | null;
  readonly selector: ThreadListSelector | null;
  /** The predicted row (act) or the before-image (restore). */
  readonly patch: (row: ThreadRow) => ThreadRow;
  /** Rows before the entry applied, for an undo's restore entry. */
  readonly before: ReadonlyMap<Id, ThreadRow>;
  /** By window key: where each target sat when the entry applied. */
  readonly originalPosition: ReadonlyMap<string, ReadonlyMap<Id, Placement>>;
  /** The receipt's (or the failure frame's) state; null while pending. */
  appliedState: State | null;
  /** An undo was issued for it; its restore entry takes over until the undo settles. */
  superseded: boolean;
}

/** The value of a view spec, for comparing specs by value. */
export function specKey(spec: ViewSpec): string {
  return JSON.stringify(spec, Object.keys(spec).sort());
}

const HOME_KINDS = new Set(['home', 'homeSection', 'oneByOne']);

/**
 * Whether an action takes a thread out of a view. A prediction only: the engine's next frame is the truth. Views the
 * action may move a row into are left to the engine (a row arriving late is fine; a row lingering is not).
 */
export function leavesView(
  spec: ViewSpec,
  action: ThreadAction,
  mail?: Pick<MailSettings, 'doneAction' | 'laterAction'>,
): boolean {
  const type = action.type;
  if (type === 'trash' || type === 'spam')
    return !(spec.kind === 'mailbox' && spec.role === type) && spec.kind !== 'thread';
  if (HOME_KINDS.has(spec.kind)) {
    if (type === 'done' || type === 'later') return true;
    if (type === 'home') return action.hidden;
    if (type === 'lane') {
      if (spec.kind === 'home') return action.lane === 'low';
      return 'section' in spec && spec.section !== 'follow' && spec.section !== action.lane;
    }
    return false;
  }
  switch (spec.kind) {
    case 'mailbox':
      if (spec.role === 'inbox') {
        if (type === 'done') return (mail?.doneAction ?? 'archive') === 'archive';
        if (type === 'later') return (mail?.laterAction ?? 'archive') === 'archive';
        return false;
      }
      if (spec.role === 'trash' || spec.role === 'spam') return type === 'restore';
      if (spec.role === 'starred') return type === 'flag' && !action.on;
      return false;
    case 'later':
      return type === 'done' || type === 'restore';
    case 'bookmarks':
      return type === 'bookmark' && !action.on;
    case 'done':
      return type === 'restore' || type === 'later';
    default:
      return false;
  }
}

/** The row an action will produce, as far as the renderer can tell: enough to draw read state, flags and badges at once. */
export function predictRow(row: ThreadRow, action: ThreadAction, now: number): ThreadRow {
  const workflow = { ...row.workflow };
  let next: ThreadRow = { ...row, workflow };
  switch (action.type) {
    case 'done':
      workflow.status = 'done';
      workflow.doneAt = now;
      delete workflow.laterUntil;
      break;
    case 'later':
      workflow.status = 'later';
      if (action.until === undefined) delete workflow.laterUntil;
      else workflow.laterUntil = action.until;
      break;
    case 'restore':
      workflow.status = 'new';
      delete workflow.laterUntil;
      delete workflow.doneAt;
      workflow.hiddenFromHome = false;
      break;
    case 'read':
      next = { ...next, unread: false, unreadCount: 0 };
      break;
    case 'unread':
      next = { ...next, unread: true, unreadCount: Math.max(1, row.unreadCount) };
      break;
    case 'flag':
      next = { ...next, flagged: action.on };
      break;
    case 'bookmark':
      workflow.bookmarked = action.on;
      break;
    case 'importance':
      next = { ...next, rank: { ...row.rank, importance: action.importance } };
      break;
    case 'lane':
      next = { ...next, rank: { ...row.rank, lane: action.lane } };
      break;
    case 'replyStatus':
      workflow.replyStatus = action.status;
      break;
    case 'home':
      workflow.hiddenFromHome = action.hidden;
      break;
    case 'due':
      if (action.date) workflow.dueDate = action.date;
      else delete workflow.dueDate;
      break;
    default:
      break;
  }
  if (['done', 'restore', 'later', 'trash', 'spam', 'home'].includes(action.type))
    next.fromLater = false;
  return next;
}

/** The section a window index falls in (count-only sections such as Low hold no rows). */
export function sectionAt(
  body: { readonly position: number; readonly sections: readonly WindowSection[] },
  index: number,
): string | null {
  const at = body.position + index;
  for (const s of body.sections) {
    if (s.key === 'low') continue;
    if (at >= s.start && at < s.start + s.count) return s.key;
  }
  return null;
}

const SECTION_ORDER: Record<string, readonly string[]> = {
  home: ['do', 'fromLater', 'update', 'low', 'follow'],
  later: ['overdue', 'today', 'week', 'someday'],
};

/** A window's ids, total and sections with the overlay laid over the engine's body. */
export interface OverlaidWindow {
  readonly ids: readonly Id[];
  readonly total: number;
  readonly sections: readonly WindowSection[];
}

function applies(entry: OverlayEntry, state: State | null, order: StateOrder): boolean {
  if (entry.superseded) return false;
  return !(entry.appliedState && order.reached(state, entry.appliedState));
}

/** Lays the entries (oldest first) over one window's body. */
export function overlayWindow(
  key: string,
  spec: ViewSpec,
  base: WindowBody,
  entries: readonly OverlayEntry[],
  order: StateOrder,
  mail?: Pick<MailSettings, 'doneAction' | 'laterAction'>,
): OverlaidWindow {
  const live = entries.filter(entry => applies(entry, base.state, order));
  if (!live.length) return base;
  const ids = [...base.ids];
  const sectionOf = new Map<Id, string | null>();
  base.ids.forEach((id, i) => sectionOf.set(id, sectionAt(base, i)));
  const delta = new Map<string | null, number>();
  const bump = (section: string | null, by: number) =>
    delta.set(section, (delta.get(section) ?? 0) + by);
  const zeroed = new Set<string>();
  let cleared = false;
  const thisSpec = specKey(spec);

  const remove = (id: Id) => {
    const i = ids.indexOf(id);
    if (i < 0) return;
    ids.splice(i, 1);
    bump(sectionOf.get(id) ?? null, -1);
  };

  for (const entry of live) {
    if (entry.kind === 'act') {
      if (entry.selector && specKey(entry.selector.spec) === thisSpec) {
        const section = entry.selector.section;
        for (const id of [...ids]) if (!section || sectionOf.get(id) === section) remove(id);
        if (section) zeroed.add(section);
        else cleared = true;
      }
      if (entry.action && leavesView(spec, entry.action, mail))
        for (const id of entry.targets) remove(id);
    } else {
      const placed = entry.originalPosition.get(key);
      if (!placed) continue;
      for (const id of entry.targets) {
        const where = placed.get(id);
        if (!where || ids.includes(id)) continue;
        ids.splice(Math.min(where.index, ids.length), 0, id);
        sectionOf.set(id, where.section);
        bump(where.section, 1);
        if (where.section) zeroed.delete(where.section);
        cleared = false;
      }
    }
  }

  if (!base.sections.length) {
    const added = [...delta.values()].reduce((n, d) => n + d, 0);
    return {
      ids,
      total: cleared ? ids.length : Math.max(ids.length, base.total + added),
      sections: [],
    };
  }

  const known = new Map(base.sections.map(s => [s.key, s]));
  const order_ = SECTION_ORDER[spec.kind] ?? [];
  const keys = [...base.sections.map(s => s.key)];
  for (const section of delta.keys())
    if (section && !known.has(section) && (delta.get(section) ?? 0) > 0) {
      const rank = order_.indexOf(section);
      const at = keys.findIndex(k => order_.indexOf(k) > rank);
      keys.splice(at < 0 || rank < 0 ? keys.length : at, 0, section);
    }
  let shift = 0;
  const sections: WindowSection[] = [];
  for (const k of keys) {
    const s = known.get(k) ?? { key: k, start: 0, count: 0 };
    if (k === 'low') {
      sections.push({ ...s, start: s.start + shift });
      continue;
    }
    const start = known.has(k)
      ? s.start + shift
      : (sections.at(-1)?.start ?? 0) +
        (sections.at(-1)?.key === 'low' ? 0 : (sections.at(-1)?.count ?? 0));
    const count = cleared || zeroed.has(k) ? 0 : Math.max(0, s.count + (delta.get(k) ?? 0));
    shift += count - s.count;
    if (count > 0) sections.push({ ...s, start, count });
  }
  return { ids, total: Math.max(ids.length, base.total + shift), sections };
}

/** Lays the entries over one row read at `rowState`; returns the row itself when nothing applies. */
export function overlayRow(
  row: ThreadRow,
  rowState: State | null,
  entries: readonly OverlayEntry[],
  order: StateOrder,
): ThreadRow {
  let out = row;
  for (const entry of entries) {
    if (!entry.targets.has(row.id) || !applies(entry, rowState, order)) continue;
    out = entry.patch(out);
  }
  return out;
}

/** The before-image patch of a restore entry: the old fields, the current `rev`. */
export function restorePatch(before: ReadonlyMap<Id, ThreadRow>): (row: ThreadRow) => ThreadRow {
  return row => {
    const old = before.get(row.id);
    return old ? { ...old, rev: row.rev } : row;
  };
}

/** The ordered list of entries plus a cache of overlaid rows, so an untouched row keeps its identity. */
export class Overlay {
  private list: OverlayEntry[] = [];
  private readonly rowCache = new WeakMap<
    ThreadRow,
    { version: number; at: string; out: ThreadRow }
  >();
  private version = 0;

  get entries(): readonly OverlayEntry[] {
    return this.list;
  }

  get(opId: OpId): OverlayEntry | undefined {
    return this.list.find(entry => entry.opId === opId);
  }

  add(entry: OverlayEntry): void {
    this.list = [...this.list, entry];
    this.version++;
  }

  remove(opId: OpId): OverlayEntry | undefined {
    const entry = this.get(opId);
    if (entry) {
      this.list = this.list.filter(e => e !== entry);
      this.version++;
    }
    return entry;
  }

  /** Call after mutating an entry in place (receipt, supersede). */
  touch(): void {
    this.version++;
  }

  /** Drops entries every holder has caught up with. */
  sweep(settled: (entry: OverlayEntry) => boolean): OverlayEntry[] {
    const gone = this.list.filter(settled);
    if (gone.length) {
      this.list = this.list.filter(entry => !gone.includes(entry));
      this.version++;
    }
    return gone;
  }

  row(row: ThreadRow, rowState: State | null, order: StateOrder): ThreadRow {
    if (!this.list.length) return row;
    const at = rowState ? `${rowState.dbEpoch}:${rowState.seq}` : '';
    const cached = this.rowCache.get(row);
    if (cached && cached.version === this.version && cached.at === at) return cached.out;
    const out = overlayRow(row, rowState, this.list, order);
    const stable = cached && JSON.stringify(cached.out) === JSON.stringify(out) ? cached.out : out;
    this.rowCache.set(row, { version: this.version, at, out: stable });
    return stable;
  }
}
