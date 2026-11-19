import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Bookmark,
  CalendarDays,
  Check,
  Clock,
  FileText,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  Reply,
  RotateCcw,
  Trash2,
} from '../icons';
import type { Draft, SuggestedAction, Thread } from '@aplos/contract/legacy/types';
import { liveAction, shortDue, shortSender } from '@aplos/contract/legacy/mailbox';
import { dateLabel, dueLabel, plain } from '../bridge';
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Count,
  IconButton,
  cx,
  reducedMotion,
  useListPresence,
  useSwipe,
  type Icon,
  type SwipeSide,
} from '../ui';
import { ymd } from '../calendarTime';
import { cancelRow, hasRealSummary, summarizeRow, useSummarizing } from '../summaries';

export type Triage = 'done' | 'later' | 'trash' | 'spam';
/** Row callbacks. Pass a stable object (see `useHandlers`) so unchanged rows skip re-rendering. */
export type RowActions = {
  open: (thread: Thread) => void;
  /** Run the thread's suggested action (Space); threads without one open. */
  run: (thread: Thread) => void;
  /** `range` extends the selection from the last toggled row, `toggle` flips just this one. */
  select: (thread: Thread, how?: 'toggle' | 'range') => void;
  triage: (thread: Thread, status: Triage) => void;
  bookmark: (thread: Thread) => void;
  /** Bring a thread back from Trash or Spam. */
  restore: (thread: Thread) => void;
  more: (thread: Thread, anchor: HTMLElement) => void;
  /** Make this the one focused row. Without it a click opens the thread. */
  focus?: (thread: Thread) => void;
  hover?: (thread: Thread, on: boolean) => void;
};
export type RowHandlers = {
  activeId?: string;
  /** The focused row, drawn as a card. */
  cursorId?: string;
  /** A card just acted on; it stays a card until it has left the list. */
  departingId?: string;
  /** A thread whose suggested action is running (calendar extraction, attachment download). */
  busyId?: string;
  /** Each thread's position in the whole on-screen order; rows expose it as `--i` for distance styling. */
  indexOf?: Map<string, number>;
  highlight?: Terms;
  selected: Set<string>;
  doneLeft: boolean;
  /** Rows can be dragged or swiped sideways to triage. */
  swipe: boolean;
  actions: RowActions;
};

/** Words from a search query worth marking in rows; `from:` and `subject:` terms only mark their own field. */
export function highlightTerms(query: string) {
  const terms = { any: [] as string[], from: [] as string[], subject: [] as string[] };
  for (const token of query.match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
    const value = token.replace(/"/g, '').trim();
    const colon = value.indexOf(':');
    const key = colon > 0 ? value.slice(0, colon).toLowerCase() : '';
    const term = colon > 0 ? value.slice(colon + 1) : value;
    if (term.length < 2) continue;
    if (!key) terms.any.push(term);
    else if (key === 'from') terms.from.push(term);
    else if (key === 'subject') terms.subject.push(term);
  }
  return terms.any.length || terms.from.length || terms.subject.length ? terms : undefined;
}
type Terms = NonNullable<ReturnType<typeof highlightTerms>>;
export function Marked({ text, terms }: { text: string; terms?: string[] }) {
  if (!terms?.length || !text) return <>{text}</>;
  const pattern = new RegExp(
    '(' + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')',
    'gi',
  );
  return (
    <>
      {text.split(pattern).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="match">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** A titled group of mail rows. Rows leaving after triage slide out and collapse; rows coming back grow in. */
const noThreads: Thread[] = [];
// Long enough for a focused card to slide away and close its gap.
const exitMs = 280;
export function MailSection({
  title,
  threads,
  action,
  showCount = true,
  rows,
  plain,
}: {
  title: string;
  threads: Thread[];
  action?: React.ReactNode;
  showCount?: boolean;
  rows: RowHandlers;
  plain?: boolean;
}) {
  const items = useListPresence(
    threads.length > 200 ? noThreads : threads,
    thread => thread.id,
    exitMs,
  );
  if (!threads.length && !items.length) return null;
  return (
    <section className={cx('mail-section', plain && 'is-plain')}>
      {!plain && (
        <header data-flip={'section:' + title}>
          <h2>
            {title}
            {showCount && threads.length > 0 && (
              <Count value={threads.length} className="section-count" />
            )}
          </h2>
          {action}
        </header>
      )}
      {threads.length > 200 ? (
        <WindowedMailRows threads={threads} rows={rows} />
      ) : (
        <div className="mail-group">{presentRows(items, rows)}</div>
      )}
    </section>
  );
}

/** Rows that scroll into a window are not new mail, so they never play the enter animation. */
function PresentMailRows({ threads, rows }: { threads: Thread[]; rows: RowHandlers }) {
  const items = useListPresence(threads, thread => thread.id, exitMs);
  return (
    <>
      {presentRows(
        items.map(entry => (entry.phase === 'enter' ? { ...entry, phase: undefined } : entry)),
        rows,
      )}
    </>
  );
}
const presentRows = (
  items: Array<{ item: Thread; phase?: 'enter' | 'exit'; direction?: string }>,
  rows: RowHandlers,
) =>
  items.map(({ item, phase, direction }) => (
    <MailRow
      key={item.id}
      thread={item}
      actions={rows.actions}
      phase={phase}
      direction={direction}
      index={rows.indexOf?.get(item.id)}
      active={rows.activeId === item.id}
      cursor={rows.cursorId === item.id || rows.departingId === item.id}
      busy={rows.busyId === item.id}
      selected={rows.selected.has(item.id)}
      selecting={rows.selected.size > 0}
      doneLeft={rows.doneLeft}
      swipe={rows.swipe}
      highlight={rows.highlight}
    />
  ));

/**
 * Fixed-height rows keep the scrollbar and keyboard order while only nearby rows mount. The one focused card is
 * taller; its measured extra height is added after its index so offsets and spacers stay exact. Rows keep their
 * elements while the window moves, so a focus glide in progress is never cut off by a remount.
 */
function WindowedMailRows({ threads, rows }: { threads: Thread[]; rows: RowHandlers }) {
  const group = useRef<HTMLDivElement>(null),
    measure = useRef<() => void>(() => {});
  const focusAt = rows.cursorId ? threads.findIndex(t => t.id === rows.cursorId) : -1;
  const geometry = useRef({ focus: focusAt, extra: 0 });
  geometry.current.focus = focusAt;
  const [range, setRange] = useState({ start: 0, end: 40, height: 40, extra: 0 });
  const top = (index: number, height: number, extra: number) =>
    index * height + (focusAt >= 0 && index > focusAt ? extra : 0);
  useLayoutEffect(() => {
    const node = group.current,
      scroll = node?.closest<HTMLElement>('.mail-content');
    if (!node || !scroll) return;
    let frame = 0;
    const height = parseFloat(getComputedStyle(node).getPropertyValue('--row-height')) || 40;
    const update = () => {
      const { focus, extra } = geometry.current;
      const x = focus >= 0 ? extra : 0;
      const offset = scroll.getBoundingClientRect().top - node.getBoundingClientRect().top;
      let first = Math.floor(offset / height);
      if (focus >= 0 && first > focus)
        first = Math.max(focus + 1, Math.floor((offset - x) / height));
      const count = Math.ceil(scroll.clientHeight / height) + 16;
      const start = Math.max(0, Math.min(threads.length - count, first - 8)),
        end = Math.min(threads.length, start + count);
      setRange(old =>
        old.start === start && old.end === end && old.height === height && old.extra === extra
          ? old
          : { start, end, height, extra },
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    measure.current = update;
    update();
    scroll.addEventListener('scroll', schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(scroll);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      scroll.removeEventListener('scroll', schedule);
      measure.current = () => {};
    };
  }, [threads.length]);
  // The card's body keeps its natural height while the row animates, so it measures the settled size.
  useLayoutEffect(() => {
    const card = group.current?.querySelector<HTMLElement>(
      '.mail-row.is-focus:not(.row-exit) > .row-body',
    );
    if (!card) return;
    const style = getComputedStyle(card.parentElement!);
    const extra = Math.max(
      0,
      card.offsetHeight +
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom) -
        range.height,
    );
    if (Math.abs(extra - geometry.current.extra) > 1) {
      geometry.current.extra = extra;
      measure.current();
    }
  });
  useLayoutEffect(() => {
    if (focusAt < 0) return;
    measure.current();
    if (focusAt >= range.start && focusAt < range.end) return;
    const node = group.current,
      scroll = node?.closest<HTMLElement>('.mail-content');
    if (!node || !scroll) return;
    scroll.scrollTop +=
      node.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top +
      focusAt * range.height -
      scroll.clientHeight / 3;
    measure.current();
  }, [rows.cursorId]);
  const visible = useMemo(
    () => threads.slice(range.start, range.end),
    [threads, range.start, range.end],
  );
  const before = top(range.start, range.height, range.extra),
    after =
      Math.max(0, threads.length - range.end) * range.height +
      (focusAt >= range.end ? range.extra : 0);
  return (
    <div className="mail-group" ref={group} data-virtual-count={threads.length}>
      <div aria-hidden="true" style={{ height: before }} />
      <PresentMailRows threads={visible} rows={rows} />
      <div aria-hidden="true" style={{ height: after }} />
    </div>
  );
}

/* ---------- Focus motion ---------- */

/*
 * Moving the focus is one continuous motion rather than one card closing and another opening. Just before the
 * cursor changes, `prepareFocusMove` records where everything is on screen (including any glide still running).
 * After React commits, `useFocusGlide` scrolls the list so the card sits at a steady height, then plays every
 * element from where it was to where it now is (FLIP): rows and headers slide, the card's surface glides and
 * resizes into its new row, and the summary text scales between its line and headline sizes. A new move cancels
 * the running glide and starts from the current on-screen positions, so a held key reads as one smooth sweep.
 */
const glideMs = 300;
const glideEase = 'cubic-bezier(.2,.85,.25,1)';
const cardParts = ['.row-leading', '.sender', '.summary', '.row-meta'];
type Spot = { x: number; y: number; size: number };
type FocusSnapshot = {
  mode: 'key' | 'pointer';
  quick: boolean;
  from?: string;
  to: string;
  blocks: Map<string, number>;
  parts: Map<string, Spot>;
  frame?: { top: number; height: number };
};
let pendingMove: FocusSnapshot | null = null;
const glides = new Set<Animation>();
const listView = () => document.querySelector<HTMLElement>('.mail-content > .mail-view');
const rowOf = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`.mail-row[data-thread-id="${CSS.escape(id)}"]`);
function visualSize(el: HTMLElement) {
  const style = getComputedStyle(el);
  let scale = 1;
  try {
    scale =
      style.transform && style.transform !== 'none' ? new DOMMatrixReadOnly(style.transform).a : 1;
  } catch {
    scale = 1;
  }
  return parseFloat(style.fontSize) * scale;
}

/** Call right before moving the cursor with the keyboard (`key`) or a click (`pointer`). A held key glides `quick`ly. */
export function prepareFocusMove(mode: 'key' | 'pointer', to: string, quick = false) {
  const view = listView(),
    scroller = view?.parentElement;
  if (!view || !scroller) {
    pendingMove = null;
    return;
  }
  const box = scroller.getBoundingClientRect(),
    reach = box.height;
  const blocks = new Map<string, number>();
  for (const el of view.querySelectorAll<HTMLElement>('[data-flip]')) {
    const r = el.getBoundingClientRect();
    if (r.bottom < box.top - reach || r.top > box.bottom + reach) continue;
    blocks.set(el.dataset.flip!, r.top);
  }
  const current = view.querySelector<HTMLElement>('.mail-row.is-focus:not(.row-exit)'),
    from = current?.dataset.threadId;
  const parts = new Map<string, Spot>();
  for (const [row, id] of [
    [current, from],
    [rowOf(view, to), to],
  ] as const) {
    if (!row || !id) continue;
    for (const part of cardParts) {
      const el = row.querySelector<HTMLElement>(part);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      parts.set(id + part, { x: r.left, y: r.top, size: visualSize(el) });
    }
  }
  const frame = current?.querySelector<HTMLElement>('.focus-frame')?.getBoundingClientRect();
  pendingMove = {
    mode,
    quick,
    from,
    to,
    blocks,
    parts,
    frame: frame && { top: frame.top, height: frame.height },
  };
}

/** A gentle bump of the card at the first or last email, instead of wrapping around. */
export function nudgeFocus(direction: number) {
  const body = listView()?.querySelector<HTMLElement>(
    '.mail-row.is-focus:not(.row-exit) > .row-body',
  );
  if (!body || reducedMotion()) return;
  body.animate(
    [
      { transform: 'none' },
      { transform: `translateY(${Math.sign(direction) * 5}px)`, offset: 0.35 },
      { transform: 'none' },
    ],
    { duration: 320, easing: 'cubic-bezier(.3,.7,.4,1)' },
  );
}

function glide(el: Element, keyframes: Keyframe[], duration = glideMs) {
  const animation = el.animate(keyframes, { duration, easing: glideEase });
  glides.add(animation);
  const done = () => glides.delete(animation);
  animation.onfinish = done;
  animation.oncancel = done;
}
/** Keeps the focused card in a steady place and animates every focus move. See `prepareFocusMove`. */
export function useFocusGlide(
  scrollerRef: React.RefObject<HTMLElement | null>,
  focusId: string | undefined,
  enabled: boolean,
) {
  useLayoutEffect(() => {
    const snap = pendingMove && pendingMove.to === focusId ? pendingMove : null;
    pendingMove = null;
    const scroller = scrollerRef.current;
    if (!enabled || !scroller || !focusId) return;
    const row = rowOf(scroller, focusId);
    if (!row) return;
    for (const animation of [...glides]) animation.cancel();
    const motion = !reducedMotion();
    const view = scroller.getBoundingClientRect(),
      box = row.getBoundingClientRect();
    const fit = (delta: number) => {
      // The whole card stays visible, with a little air below it and under the toolbar.
      const top = box.top - delta;
      if (top + box.height > view.bottom - 24) delta += top + box.height - (view.bottom - 24);
      if (box.top - delta < view.top + 56) delta -= view.top + 56 - (box.top - delta);
      return delta;
    };
    if (!snap) {
      // Triage, undo or new mail moved the focus: only scroll if the card is out of view.
      const top = view.top + 64,
        bottom = view.bottom - 96;
      const delta = box.top < top || box.top + box.height > bottom ? fit(box.top - top) : 0;
      if (delta) scroller.scrollBy({ top: delta, behavior: motion ? 'smooth' : 'auto' });
      return;
    }
    // A click keeps the clicked row under the pointer; the keyboard keeps the card at a steady reading height.
    const was = snap.blocks.get(focusId);
    const anchor = view.top + Math.max(72, Math.round(scroller.clientHeight * 0.3));
    const delta = fit(
      snap.mode === 'pointer' && was !== undefined ? box.top - was : box.top - anchor,
    );
    const was0 = scroller.scrollTop;
    scroller.scrollTop = Math.max(
      0,
      Math.min(scroller.scrollHeight - scroller.clientHeight, was0 + delta),
    );
    const list = listView();
    if (!motion || !list) return;
    // The list jumps to its new scroll position at once and every element starts from where it was on screen.
    // The whole view carries the scroll distance, so content that only scrolled needs no transform of its own;
    // rows whose layout changed add just the difference. One timeline drives everything, so it all lands in step.
    // Measure everything first: a glide started early would shift the rects read after it.
    const scrolled = scroller.scrollTop - was0;
    const reach = view.height,
      offset = new Map<Element, number>(),
      moves: Array<[Element, Keyframe[]]> = [];
    let carry = 0;
    if (Math.abs(scrolled) > 0.5)
      moves.push([list, [{ transform: `translateY(${scrolled}px)` }, { transform: 'none' }]]);
    for (const el of list.querySelectorAll<HTMLElement>('[data-flip]')) {
      if (el.classList.contains('row-exit')) continue;
      const r = el.getBoundingClientRect(),
        before = snap.blocks.get(el.dataset.flip!);
      // Rows the window just mounted had no position yet; they move with their neighbours.
      const dy = before === undefined ? carry : before - r.top;
      carry = dy;
      if (r.bottom < view.top - reach || r.top > view.bottom + reach) continue;
      offset.set(el, dy);
      if (Math.abs(dy - scrolled) > 0.5)
        moves.push([el, [{ transform: `translateY(${dy - scrolled}px)` }, { transform: 'none' }]]);
    }
    // The card's surface travels from the old card to the new one and takes its new height on the way.
    const frame = row.querySelector<HTMLElement>('.focus-frame');
    if (frame && snap.frame) {
      for (const animation of frame.getAnimations()) animation.cancel();
      const r = frame.getBoundingClientRect();
      moves.push([
        frame,
        [
          {
            transform: `translateY(${snap.frame.top - r.top - (offset.get(row) ?? 0)}px)`,
            height: snap.frame.height + 'px',
          },
          { transform: 'none', height: r.height + 'px' },
        ],
      ]);
    }
    // Sender, time and summary move between line and card layouts; the summary scales between its two sizes.
    for (const id of [snap.from, focusId]) {
      const host = id && rowOf(list, id);
      if (!host || !id) continue;
      const shift = offset.get(host) ?? 0;
      for (const part of cardParts) {
        const el = host.querySelector<HTMLElement>(part),
          from = snap.parts.get(id + part);
        if (!el || !from) continue;
        const r = el.getBoundingClientRect(),
          scale = part === '.summary' ? from.size / parseFloat(getComputedStyle(el).fontSize) : 1;
        const dx = from.x - r.left,
          dy = from.y - r.top - shift;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.01) continue;
        moves.push([
          el,
          [
            { transform: `translate(${dx}px,${dy}px) scale(${scale})`, transformOrigin: '0 0' },
            { transform: 'none', transformOrigin: '0 0' },
          ],
        ]);
      }
    }
    // Key repeat arrives every ~30 ms; shorter glides keep the content close behind the card.
    for (const [el, keyframes] of moves) glide(el, keyframes, snap.quick ? 170 : glideMs);
  }, [focusId, enabled]);
}

/* ---------- Rows ---------- */

let lastClick: { thread: Thread; at: number } | null = null;
const capital = (text: string) => text && text[0].toUpperCase() + text.slice(1);
/** The preset icon for each kind of suggested action; AI chooses the kind and label, never the code or icon. */
const actionIcons: Record<SuggestedAction['kind'], Icon> = {
  link: ArrowUpRight,
  attachment: Paperclip,
  reply: Reply,
  calendar: CalendarDays,
  read: FileText,
};
export const actionIcon = (kind: SuggestedAction['kind']) => actionIcons[kind];
/** Where a link action goes, shown on the button so a one-key open never hides its destination. */
export function linkHost(url?: string) {
  try {
    return new URL(url ?? '').host.replace(/^www\./, '');
  } catch {
    return '';
  }
}
function actionHint(
  action: SuggestedAction | undefined,
  thread: Thread,
): { content: string; detail?: string } {
  if (!action) return { content: 'Open the email' };
  switch (action.kind) {
    case 'link': {
      let where = action.url ?? '';
      try {
        const url = new URL(where);
        where = url.host + (url.pathname === '/' ? '' : url.pathname);
      } catch {
        /* shown as written */
      }
      return { content: 'Open link', detail: where };
    }
    case 'attachment':
      return {
        content: 'Open attachment',
        detail: thread.messages.flatMap(m => m.attachments).find(a => a.id === action.attachmentId)
          ?.name,
      };
    case 'reply':
      return { content: 'Reply with a suggested draft', detail: action.prompt };
    case 'calendar':
      return { content: 'Find the event', detail: 'Review it before anything is added' };
    case 'read':
      return { content: 'Open the email' };
  }
}
type RowProps = {
  thread: Thread;
  actions: RowActions;
  phase?: 'enter' | 'exit';
  direction?: string;
  index?: number;
  active: boolean;
  cursor: boolean;
  busy: boolean;
  selected: boolean;
  selecting: boolean;
  doneLeft: boolean;
  swipe: boolean;
  highlight?: Terms;
};
/**
 * One email. Unfocused it is a single line, "Sender: summary"; focused, the same summary becomes the card's one
 * big line under the sender, followed by the suggested action and the triage keys. A row on its way out keeps
 * the look it had.
 */
const MailRow = memo(function MailRow({
  thread: t,
  actions: rows,
  phase,
  direction,
  index,
  active,
  cursor,
  busy,
  selected,
  selecting,
  doneLeft,
  swipe,
  highlight: hl,
}: RowProps) {
  const m = t.messages.at(-1)!;
  const sent = m.sent ? m : undefined;
  const recipient = sent?.to[0]?.replace(/^\s*"?([^"<]+?)"?\s*<.*$/, '$1');
  const name = sent
    ? recipient
      ? 'To ' + recipient + (sent.to.length > 1 ? ` +${sent.to.length - 1}` : '')
      : 'No recipients'
    : m.fromName || m.from;
  const short = sent ? name : shortSender(m.fromName, m.from);
  const exiting = phase === 'exit';
  const focus = cursor,
    at = index;
  const attached = t.messages.some(message => message.attachments.length > 0);
  const today = ymd(new Date());
  const due = t.dueDate?.slice(0, 10);
  const overdue = !!due && due < today;
  // Until the model has summarized it, a row shows the subject, dimmed, rather than the email's opening words passing for
  // a summary; it shimmers while the model works and the summary fades in. Rows on screen ask for one after a moment.
  const real = hasRealSummary(t),
    working = useSummarizing(t.id);
  // Only a summary that arrives while the row is on screen fades in, not one it already had.
  const [shownUnsummarized, setShownUnsummarized] = useState(!real);
  useEffect(() => {
    if (!real) setShownUnsummarized(true);
  }, [real]);
  const headline = real ? capital(t.summary.trim()) : t.subject || '(No subject)';
  // Only rows actually on screen ask (short lists mount every row); one that scrolls away stops waiting.
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const el = rowRef.current;
    if (real || !el) return;
    const seen = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    seen.observe(el);
    return () => seen.disconnect();
  }, [real]);
  useEffect(() => {
    if (real || !onScreen || exiting || t.status === 'trash') return;
    const timer = setTimeout(() => summarizeRow(t), 1500);
    return () => {
      clearTimeout(timer);
      cancelRow(t.id);
    };
  }, [t.id, real, onScreen, exiting, t.status]);
  const shift = useRef(false);
  const restorable = t.status === 'trash' || t.status === 'spam';
  const rowRef = useRef<HTMLDivElement>(null),
    bodyRef = useRef<HTMLDivElement>(null);
  const [swiping, setSwiping] = useState(false);
  const actionFor = (side: SwipeSide): 'done' | 'later' =>
    (side === 'right') !== doneLeft ? 'done' : 'later';
  const gesture = useSwipe({
    enabled: swipe && !restorable && !selecting && !exiting,
    host: rowRef,
    actionFor,
    onActive: setSwiping,
    canStart: target => !target.closest('.card-actions, .row-leading'),
    onCommit: side => rows.triage(t, actionFor(side)),
  });
  // Exit keyframes collapse the card from its real height.
  useLayoutEffect(() => {
    const row = rowRef.current,
      body = bodyRef.current;
    if (focus && row && body) row.style.setProperty('--card-h', body.offsetHeight + 'px');
  }, [focus, t]);
  const subjectTerms = hl && [...hl.any, ...hl.subject];
  const chip = t.dueDate && (
    <Badge
      tone={overdue ? 'red' : due === today ? 'blue' : 'neutral'}
      className="row-due"
      title={dueLabel(t.dueDate)}
    >
      {shortDue(t.dueDate)}
    </Badge>
  );
  const action = liveAction(t);
  const ActionIcon = action ? actionIcons[action.kind] : MailOpen;
  const later = (
    <Button
      key="later"
      variant="ghost"
      size="sm"
      icon={Clock}
      className="card-btn"
      shortcut={doneLeft ? '→' : '←'}
      onClick={() => rows.triage(t, 'later')}
      tooltip={{ content: 'Move to Later', shortcut: 'L' }}
    >
      Later
    </Button>
  );
  const done = (
    <Button
      key="done"
      variant="ghost"
      size="sm"
      icon={Check}
      className="card-btn card-done"
      shortcut={doneLeft ? '←' : '→'}
      onClick={() => rows.triage(t, 'done')}
      tooltip={{ content: 'Mark done', shortcut: 'E' }}
    >
      Done
    </Button>
  );
  function click(e: React.MouseEvent) {
    // The second click of a double-click may land on a neighbour once the cards resize; it opens the first row.
    if (
      e.detail > 1 &&
      lastClick &&
      lastClick.thread.id !== t.id &&
      performance.now() - lastClick.at < 600
    ) {
      rows.open(lastClick.thread);
      return;
    }
    if (!focus && rows.focus && !e.shiftKey && !e.metaKey && !e.ctrlKey && !selecting)
      lastClick = { thread: t, at: performance.now() };
    if (e.shiftKey) rows.select(t, 'range');
    else if (e.metaKey || e.ctrlKey || selecting) rows.select(t, 'toggle');
    else if (focus || !rows.focus) rows.open(t);
    else rows.focus(t);
  }
  return (
    <div
      ref={rowRef}
      data-thread-id={t.id}
      data-flip={t.id}
      className={cx(
        'mail-row',
        focus && 'is-focus',
        t.unread && 'unread',
        active && 'active',
        selected && 'checked',
        selecting && 'selecting',
        phase && 'row-' + phase,
        exiting && 'row-exit-' + direction,
      )}
      inert={exiting || undefined}
      style={at === undefined ? undefined : ({ '--i': at } as React.CSSProperties)}
      {...gesture}
    >
      {swiping && <SwipeReveal actionFor={actionFor} />}
      <div
        className="row-body"
        ref={bodyRef}
        onClick={e => {
          if (focus && e.target === e.currentTarget) click(e);
        }}
      >
        {focus && <div className="focus-frame" aria-hidden="true" />}
        <div
          className="row-leading"
          onClickCapture={e => {
            shift.current = e.shiftKey;
          }}
        >
          {focus ? (
            <Avatar
              name={recipient || m.fromName || m.from}
              seed={recipient || m.fromName || m.from}
              size={24}
            />
          ) : (
            t.unread && <span className="unread-dot" aria-label="Unread" />
          )}
          <Checkbox
            className="row-checkbox"
            checked={selected}
            hideLabel
            label={'Select ' + t.subject}
            onChange={() => rows.select(t, shift.current ? 'range' : 'toggle')}
          />
        </div>
        <button
          className="row-content"
          onClick={click}
          aria-label={focus ? undefined : `${name}: ${headline}`}
        >
          <span className="row-line">
            <span className="sender">
              <Marked text={focus ? name : short} terms={hl && [...hl.any, ...hl.from]} />
            </span>
            {focus && t.messages.length > 1 && (
              <span className="thread-count">{t.messages.length}</span>
            )}
            <span
              className={cx(
                'summary',
                !real && 'is-unsummarized',
                !real && working && 'is-summarizing',
                real && shownUnsummarized && 'is-arriving',
              )}
              title={t.subject || undefined}
            >
              {hl && !focus && real && (
                <span className="subject">
                  <Marked text={t.subject} terms={subjectTerms} />
                </span>
              )}
              <Marked text={headline} terms={real ? hl?.any : subjectTerms || undefined} />
            </span>
            <span className="row-meta">
              {t.bookmarked && <Bookmark size={13} className="row-flag" fill="currentColor" />}
              {chip}
              {attached && <Paperclip size={13} className="row-clip" />}
              <span className="row-time">{dateLabel(t.date)}</span>
            </span>
          </span>
        </button>
        {focus && (
          <div className="card-actions">
            {!restorable && (
              <Button
                size="sm"
                variant="primary"
                icon={ActionIcon}
                shortcut="Space"
                className="card-primary"
                loading={busy}
                onClick={() => rows.run(t)}
                tooltip={{ ...actionHint(action, t), placement: 'bottom' }}
              >
                {action?.label || 'Open'}
                {action?.kind === 'link' && (
                  <span className="card-host">{linkHost(action.url)}</span>
                )}
              </Button>
            )}
            <span className="card-spacer" />
            {restorable ? (
              <>
                {t.status === 'spam' && (
                  <IconButton
                    className="card-btn"
                    size="sm"
                    label="Move to Trash"
                    shortcut="#"
                    icon={Trash2}
                    onClick={() => rows.triage(t, 'trash')}
                  />
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  icon={RotateCcw}
                  className="card-btn"
                  onClick={() => rows.restore(t)}
                >
                  Restore
                </Button>
                {t.status === 'spam' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Check}
                    className="card-btn card-done"
                    onClick={() => rows.triage(t, 'done')}
                    tooltip={{ content: 'Mark done', shortcut: 'E' }}
                  >
                    Done
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Bookmark}
                  iconFill={t.bookmarked ? 'currentColor' : 'none'}
                  className={cx('card-btn card-bookmark', t.bookmarked && 'is-on')}
                  shortcut="B"
                  aria-label={t.bookmarked ? 'Remove bookmark' : 'Bookmark'}
                  aria-pressed={t.bookmarked}
                  onClick={() => rows.bookmark(t)}
                  tooltip={{
                    content: t.bookmarked ? 'Remove bookmark' : 'Bookmark',
                    shortcut: 'B',
                  }}
                />
                {doneLeft ? done : later}
                {doneLeft ? later : done}
              </>
            )}
            {!restorable && (
              <IconButton
                className="card-more"
                size="sm"
                label="More actions"
                shortcut="."
                icon={MoreHorizontal}
                onClick={e => rows.more(t, e.currentTarget)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/** What a sideways drag will do, shown under the row on the side it uncovers. */
function SwipeReveal({ actionFor }: { actionFor: (side: SwipeSide) => 'done' | 'later' }) {
  return (
    <div className="swipe-reveal" aria-hidden="true">
      {(['right', 'left'] as const).map(side => {
        const action = actionFor(side);
        return (
          <span key={side} className="swipe-action" data-for={side}>
            {action === 'done' ? <Check size={17} /> : <Clock size={17} />}
            <span>{action === 'done' ? 'Done' : 'Todo'}</span>
          </span>
        );
      })}
    </div>
  );
}

function draftRecipients(to: string) {
  const list = (to.match(/(?:"[^"]*"|[^,;])+/g) || []).map(s => s.trim()).filter(Boolean);
  if (!list.length) return 'No recipients yet';
  const first = list[0].replace(/^\s*"?([^"<]+?)"?\s*<.*$/, '$1');
  return 'To ' + first + (list.length > 1 ? ` +${list.length - 1}` : '');
}
export function DraftList({
  drafts,
  open,
  remove,
}: {
  drafts: Draft[];
  open: (draft: Draft) => void;
  remove: (draft: Draft) => void;
}) {
  const items = useListPresence(drafts, draft => draft.id);
  return (
    <div className="mail-group drafts-list">
      {items.map(({ item: d, phase, direction }) => (
        <div
          key={d.id}
          className={cx(
            'draft-row',
            phase && 'row-' + phase,
            phase === 'exit' && 'row-exit-' + direction,
          )}
          inert={phase === 'exit' || undefined}
        >
          <button className="draft-open" onClick={() => open(d)}>
            <span className="draft-avatar">
              <FileText size={15} />
            </span>
            <span className="draft-text">
              <span className="row-first">
                <span className="sender">{draftRecipients(d.to)}</span>
                <span className="row-separator">·</span>
                <span className="subject">{d.subject || '(No subject)'}</span>
                <span className="row-time">{dateLabel(d.updatedAt)}</span>
              </span>
              <span className="row-second">
                <span className="summary">{plain(d.html).slice(0, 140) || 'Empty draft'}</span>
              </span>
              {d.sendError && <em className="danger">{d.sendError}</em>}
            </span>
          </button>
          <IconButton
            className="draft-delete"
            label="Delete draft"
            icon={Trash2}
            size="sm"
            onClick={() => remove(d)}
          />
        </div>
      ))}
    </div>
  );
}
