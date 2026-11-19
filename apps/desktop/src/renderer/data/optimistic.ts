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
  /** The predicted action (act), or the action a restore reverses (null when unknown). */
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

/** The value of a view spec, for comparing specs by value: a deep stable stringify — keys sorted at every depth, so `{kind:'search', query:{text:'a'}}` and `{text:'b'}` never share a key. */
export function specKey(spec: ViewSpec): string {
  return JSON.stringify(sortDeep(spec));
}

/** `value` with every object's keys sorted, recursively; arrays keep their order. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map(key => [key, sortDeep(record[key])]),
    );
  }
  return value;
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
  if (HOME_KINDS.has(spec.kind)) return leavesHomeView(spec, action);
  switch (spec.kind) {
    case 'mailbox':
      return leavesMailbox(spec, action, mail);
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

function leavesHomeView(spec: ViewSpec, action: ThreadAction): boolean {
  const type = action.type;
  if (type === 'done' || type === 'later') return true;
  if (type === 'home') return action.hidden;
  if (type === 'lane') {
    if (spec.kind === 'home') return action.lane === 'low';
    return 'section' in spec && spec.section !== 'follow' && spec.section !== action.lane;
  }
  return false;
}

function leavesMailbox(
  spec: Extract<ViewSpec, { kind: 'mailbox' }>,
  action: ThreadAction,
  mail?: Pick<MailSettings, 'doneAction' | 'laterAction'>,
): boolean {
  const type = action.type;
  if (spec.role === 'inbox') {
    if (type === 'done') return (mail?.doneAction ?? 'archive') === 'archive';
    if (type === 'later') return (mail?.laterAction ?? 'archive') === 'archive';
    return false;
  }
  if (spec.role === 'trash' || spec.role === 'spam') return type === 'restore';
  if (spec.role === 'starred') return type === 'flag' && !action.on;
  return false;
}

/**
 * Whether an action can bring a thread into a view: the mirror of `leavesView`. A restore entry takes its rows out of
 * such a view (one they were not in before the action), so an undone move does not leave a copy behind.
 */
export function entersView(
  spec: ViewSpec,
  action: ThreadAction,
  mail?: Pick<MailSettings, 'doneAction' | 'laterAction'>,
): boolean {
  const type = action.type;
  if (type === 'trash' || type === 'spam') return spec.kind === 'mailbox' && spec.role === type;
  if (HOME_KINDS.has(spec.kind)) {
    if (type === 'restore') return true;
    if (type === 'home') return !action.hidden;
    if (type === 'lane')
      return 'section' in spec ? spec.section === action.lane : action.lane !== 'low';
    return false;
  }
  switch (spec.kind) {
    case 'mailbox':
      if (spec.role === 'inbox') return type === 'restore';
      if (spec.role === 'starred') return type === 'flag' && action.on;
      if (spec.role === 'archive') {
        if (type === 'done') return (mail?.doneAction ?? 'archive') === 'archive';
        if (type === 'later') return (mail?.laterAction ?? 'archive') === 'archive';
      }
      return false;
    case 'later':
      return type === 'later';
    case 'bookmarks':
      return type === 'bookmark' && action.on;
    case 'done':
      return type === 'done';
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

type ViewMail = Pick<MailSettings, 'doneAction' | 'laterAction'>;

/** What the entries have done to one window so far. */
interface WindowDraft {
  readonly ids: Id[];
  readonly sectionOf: Map<Id, string | null>;
  readonly delta: Map<string | null, number>;
  readonly zeroed: Set<string>;
  cleared: boolean;
}

function bumpSection(draft: WindowDraft, section: string | null, by: number): void {
  draft.delta.set(section, (draft.delta.get(section) ?? 0) + by);
}

function removeFromDraft(draft: WindowDraft, id: Id): void {
  const i = draft.ids.indexOf(id);
  if (i < 0) return;
  draft.ids.splice(i, 1);
  bumpSection(draft, draft.sectionOf.get(id) ?? null, -1);
}

function applyActEntry(
  draft: WindowDraft,
  entry: OverlayEntry,
  spec: ViewSpec,
  thisSpec: string,
  mail?: ViewMail,
): void {
  if (entry.selector && specKey(entry.selector.spec) === thisSpec) {
    const section = entry.selector.section;
    for (const id of [...draft.ids])
      if (!section || draft.sectionOf.get(id) === section) removeFromDraft(draft, id);
    if (section) draft.zeroed.add(section);
    else draft.cleared = true;
  }
  if (entry.action && leavesView(spec, entry.action, mail))
    for (const id of entry.targets) removeFromDraft(draft, id);
}

function applyRestoreEntry(
  draft: WindowDraft,
  entry: OverlayEntry,
  key: string,
  spec: ViewSpec,
  mail?: ViewMail,
): void {
  const placed = entry.originalPosition.get(key);
  if (!placed) {
    if (entry.action && entersView(spec, entry.action, mail))
      for (const id of entry.targets) removeFromDraft(draft, id);
    return;
  }
  for (const id of entry.targets) {
    const where = placed.get(id);
    if (!where || draft.ids.includes(id)) continue;
    draft.ids.splice(Math.min(where.index, draft.ids.length), 0, id);
    draft.sectionOf.set(id, where.section);
    bumpSection(draft, where.section, 1);
    if (where.section) draft.zeroed.delete(where.section);
    draft.cleared = false;
  }
}

/** The section keys after the overlay: the engine's, plus any section a restored row brings back, in section order. */
function overlaidSectionKeys(
  spec: ViewSpec,
  base: WindowBody,
  known: ReadonlyMap<string, WindowSection>,
  delta: ReadonlyMap<string | null, number>,
): string[] {
  const order_ = SECTION_ORDER[spec.kind] ?? [];
  const keys = [...base.sections.map(s => s.key)];
  for (const section of delta.keys())
    if (section && !known.has(section) && (delta.get(section) ?? 0) > 0) {
      const rank = order_.indexOf(section);
      const at = keys.findIndex(k => order_.indexOf(k) > rank);
      keys.splice(at < 0 || rank < 0 ? keys.length : at, 0, section);
    }
  return keys;
}

function overlaySections(spec: ViewSpec, base: WindowBody, draft: WindowDraft): OverlaidWindow {
  const { ids, delta, zeroed, cleared } = draft;
  const known = new Map(base.sections.map(s => [s.key, s]));
  const keys = overlaidSectionKeys(spec, base, known, delta);
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

/** Lays the entries (oldest first) over one window's body. */
export function overlayWindow(
  key: string,
  spec: ViewSpec,
  base: WindowBody,
  entries: readonly OverlayEntry[],
  order: StateOrder,
  mail?: ViewMail,
): OverlaidWindow {
  const live = entries.filter(entry => applies(entry, base.state, order));
  if (!live.length) return base;
  const draft: WindowDraft = {
    ids: [...base.ids],
    sectionOf: new Map(),
    delta: new Map(),
    zeroed: new Set(),
    cleared: false,
  };
  base.ids.forEach((id, i) => draft.sectionOf.set(id, sectionAt(base, i)));
  const thisSpec = specKey(spec);
  for (const entry of live) {
    if (entry.kind === 'act') applyActEntry(draft, entry, spec, thisSpec, mail);
    else applyRestoreEntry(draft, entry, key, spec, mail);
  }

  if (!base.sections.length) {
    const added = [...draft.delta.values()].reduce((n, d) => n + d, 0);
    return {
      ids: draft.ids,
      total: draft.cleared ? draft.ids.length : Math.max(draft.ids.length, base.total + added),
      sections: [],
    };
  }
  return overlaySections(spec, base, draft);
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

/**
 * The ordered list of entries plus a cache of overlaid rows, so an untouched row keeps its identity. `changed` hears
 * every entry added, removed or mutated, so the layer can wake the windows and the target rows.
 */
export class Overlay {
  private list: OverlayEntry[] = [];
  private readonly rowCache = new WeakMap<
    ThreadRow,
    { version: number; at: string; out: ThreadRow }
  >();
  private version = 0;

  constructor(private readonly changed: (entries: readonly OverlayEntry[]) => void = () => {}) {}

  get entries(): readonly OverlayEntry[] {
    return this.list;
  }

  get(opId: OpId): OverlayEntry | undefined {
    return this.list.find(entry => entry.opId === opId);
  }

  add(entry: OverlayEntry): void {
    this.list = [...this.list, entry];
    this.version++;
    this.changed([entry]);
  }

  remove(opId: OpId): OverlayEntry | undefined {
    const entry = this.get(opId);
    if (entry) {
      this.list = this.list.filter(e => e !== entry);
      this.version++;
      this.changed([entry]);
    }
    return entry;
  }

  /** Call after mutating an entry in place (receipt, supersede). */
  touch(entry: OverlayEntry): void {
    this.version++;
    this.changed([entry]);
  }

  /** Drops entries every holder has caught up with. */
  sweep(settled: (entry: OverlayEntry) => boolean): OverlayEntry[] {
    const gone = this.list.filter(settled);
    if (gone.length) {
      this.list = this.list.filter(entry => !gone.includes(entry));
      this.version++;
      this.changed(gone);
    }
    return gone;
  }

  row(row: ThreadRow, rowState: State | null, order: StateOrder): ThreadRow {
    if (!this.list.some(entry => entry.targets.has(row.id))) return row;
    const at = rowState ? `${rowState.dbEpoch}:${rowState.seq}` : '';
    const cached = this.rowCache.get(row);
    if (cached && cached.version === this.version && cached.at === at) return cached.out;
    const out = overlayRow(row, rowState, this.list, order);
    const stable = cached && sameThreadRow(cached.out, out) ? cached.out : out;
    this.rowCache.set(row, { version: this.version, at, out: stable });
    return stable;
  }
}

/** Equality for overlaid rows: patches copy the row and its `workflow` and `rank`, and share everything else. */
function sameThreadRow(a: ThreadRow, b: ThreadRow): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as Array<keyof ThreadRow>;
  if (ka.length !== Object.keys(b).length) return false;
  for (const key of ka) {
    const x = a[key];
    const y = b[key];
    if (Object.is(x, y)) continue;
    if (!x || !y || typeof x !== 'object' || typeof y !== 'object' || Array.isArray(x))
      return false;
    const fx = Object.keys(x) as Array<keyof typeof x>;
    if (fx.length !== Object.keys(y).length) return false;
    for (const f of fx) if (!Object.is(x[f], y[f])) return false;
  }
  return true;
}
