import type { Message, Plan, SearchQuery, ThreadRow, ViewSpec } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { Store } from './store';
import { atLocal, localDay } from './time';
import { live } from './methods/util';

/**
 * View specs as in-memory sorts (the real engine runs them as SQL keyset queries). Each returns the full ordered id
 * list; the window layer slices it, holds rows in place and coalesces frames.
 */

export interface Section {
  key: string;
  label?: string;
  start: number;
  count: number;
  senders?: string[];
}
/** `sections` is empty for ungrouped views (the wire field is required). */
export interface ViewResult {
  rowType: string;
  ids: string[];
  sections: Section[];
}
export interface ViewContext {
  store: Store;
  now: number;
  zone: string;
  body(messageId: string): string;
  /** Threads remote search found, by query text (`Search/remote`, the `searchRemote` knob): they join search windows. */
  remote?: ReadonlyMap<string, readonly string[]>;
}

const has = (t: ThreadRow, role: string) => t.labels.includes(`${t.accountId}:${role}`);
const away = (t: ThreadRow) => has(t, 'TRASH') || has(t, 'SPAM');
const newest = (a: ThreadRow, b: ThreadRow) => b.lastDate - a.lastDate || (a.id < b.id ? -1 : 1);
const important = (t: ThreadRow) => (t.rank.importance === 'important' ? 0 : 1);

/** Do now order (DESIGN 7.2): due band, important first, soonest due date, newest. */
const doOrder = (a: ThreadRow, b: ThreadRow) =>
  a.rank.dueBand - b.rank.dueBand ||
  important(a) - important(b) ||
  (a.workflow.dueDate ?? '9999').localeCompare(b.workflow.dueDate ?? '9999') ||
  newest(a, b);
const updateOrder = (a: ThreadRow, b: ThreadRow) => important(a) - important(b) || newest(a, b);

/** Home's sections. A Later item whose date has arrived sits at the bottom of Do now, as Back from Later. */
export function homeParts(ctx: ViewContext, accountId?: string) {
  const threads = ctx.store
    .all('Thread')
    .filter(t => !away(t) && (!accountId || t.accountId === accountId));
  const back = (t: ThreadRow) => t.workflow.status === 'later' && t.fromLater;
  const onHome = threads.filter(
    t => !t.workflow.hiddenFromHome && (t.workflow.status === 'new' || back(t)),
  );
  const lane = (l: string) => onHome.filter(t => t.rank.lane === l);
  const doNew = lane('do')
    .filter(t => !back(t))
    .sort(doOrder);
  const fromLater = onHome.filter(back).sort(doOrder);
  const update = lane('update')
    .filter(t => !back(t))
    .sort(updateOrder);
  const low = lane('low')
    .filter(t => !back(t))
    .sort(newest);
  const followUpDays = ctx.store.get('Settings', 'settings')?.mail.followUpDays ?? 3;
  const follow = threads
    .filter(
      t =>
        t.follow &&
        t.follow.since <= ctx.now - followUpDays * 86_400_000 &&
        t.workflow.replyStatus === 'awaitingReply',
    )
    .sort((a, b) => a.follow!.since - b.follow!.since);
  return { doNew, fromLater, update, low, follow };
}

function senders(threads: ThreadRow[]) {
  return [...new Set(threads.map(t => t.fromName))].slice(0, 3);
}

function lowGroups(ctx: ViewContext, accountId?: string) {
  const groups = new Map<string, ThreadRow[]>();
  for (const t of homeParts(ctx, accountId).low) {
    const address = t.participants.find(p => !p.me)?.address ?? t.fromName;
    groups.set(address, [...(groups.get(address) ?? []), t]);
  }
  return [...groups.entries()].map(([address, list]) => ({
    id: `sender:${address}`,
    address,
    name: list[0]!.fromName,
    count: list.length,
    latestThreadId: list[0]!.id,
    unsubscribe: list.some(t => !!t.unsubscribe),
    threadIds: list.map(t => t.id),
  }));
}
export const senderGroups = (ctx: ViewContext) => lowGroups(ctx).map(({ threadIds: _, ...g }) => g);

const addressMatches = (list: { address?: string; name?: string }[], v: string) =>
  list.some(p => `${p.name ?? ''} ${p.address ?? ''}`.toLowerCase().includes(v.toLowerCase()));

function matchesWords(ctx: ViewContext, t: ThreadRow, messages: Message[], q: SearchQuery) {
  const words = q.text.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [
    t.subject,
    t.snippet,
    t.fromName,
    ...t.participants.map(p => p.address ?? ''),
    ...messages.map(m => ctx.body(m.id)),
  ]
    .join(' ')
    .toLowerCase();
  return words.every(w => hay.includes(w));
}

function matchesPeople(messages: Message[], q: SearchQuery) {
  if (q.from && !messages.some(m => m.from && addressMatches([m.from], q.from!))) return false;
  if (q.to && !messages.some(m => addressMatches(m.to, q.to!))) return false;
  return true;
}

function matchesSubject(t: ThreadRow, q: SearchQuery) {
  if (q.subject && !t.subject.toLowerCase().includes(q.subject.toLowerCase())) return false;
  if (q.hasAttachment !== undefined && t.hasAttachments !== q.hasAttachment) return false;
  return true;
}

function matchesDates(ctx: ViewContext, t: ThreadRow, q: SearchQuery) {
  const day = localDay(t.lastDate, ctx.zone);
  if (q.before && !(day < q.before)) return false;
  if (q.after && !(day >= q.after)) return false;
  return true;
}

function matchesPlace(t: ThreadRow, q: SearchQuery) {
  if (q.in) {
    const place = q.in.toLowerCase();
    const ok =
      place === 'done'
        ? t.workflow.status === 'done'
        : place === 'later'
          ? t.workflow.status === 'later'
          : ['inbox', 'sent', 'trash', 'spam', 'starred', 'important'].includes(place)
            ? has(t, place.toUpperCase())
            : t.labels.includes(q.in);
    if (!ok) return false;
  } else if (away(t)) return false;
  return true;
}

function matchesFlags(t: ThreadRow, q: SearchQuery) {
  for (const flag of q.is ?? []) {
    if (flag === 'unread' && !t.unread) return false;
    if (flag === 'read' && t.unread) return false;
    if (flag === 'flagged' && !t.flagged) return false;
    if (flag === 'bookmarked' && !t.workflow.bookmarked) return false;
  }
  return true;
}

function matches(ctx: ViewContext, t: ThreadRow, q: SearchQuery) {
  const messages = ctx.store.all('Message').filter(m => m.threadId === t.id);
  return (
    matchesWords(ctx, t, messages, q) &&
    matchesPeople(messages, q) &&
    matchesSubject(t, q) &&
    matchesDates(ctx, t, q) &&
    matchesPlace(t, q) &&
    matchesFlags(t, q)
  );
}

function sectioned(parts: [string, string[]][]): ViewResult & { rowType: 'Thread' } {
  const ids: string[] = [],
    sections: Section[] = [];
  for (const [key, list] of parts)
    if (list.length) {
      sections.push({ key, start: ids.length, count: list.length });
      ids.push(...list);
    }
  return { rowType: 'Thread', ids, sections };
}

export const maxEventRangeMs = 62 * 86_400_000;

const idsOf = (list: { id: string }[]) => list.map(x => x.id);

const threadRows = (ctx: ViewContext, filter: (t: ThreadRow) => boolean, accountId?: string) =>
  ctx.store.all('Thread').filter(t => (!accountId || t.accountId === accountId) && filter(t));

type HomeSpec = Extract<
  ViewSpec,
  { kind: 'home' | 'homeSection' | 'oneByOne' | 'lowSenders' | 'lowBySender' }
>;
type MailboxSpec = Extract<
  ViewSpec,
  {
    kind:
      'mailbox' | 'label' | 'later' | 'bookmarks' | 'replyState' | 'done' | 'drafts' | 'scheduled';
  }
>;
type OtherSpec = Extract<
  ViewSpec,
  { kind: 'search' | 'thread' | 'events' | 'plans' | 'conversations' }
>;

function homeView(ctx: ViewContext, spec: HomeSpec): ViewResult {
  switch (spec.kind) {
    case 'home': {
      const p = homeParts(ctx, spec.accountId);
      const result = sectioned([
        ['do', idsOf(p.doNew)],
        ['fromLater', idsOf(p.fromLater)],
        ['update', idsOf(p.update)],
      ]);
      // The Low band is a count-only section: its rows are not in `ids` (open `homeSection: low` or `lowSenders` for them).
      if (p.low.length)
        result.sections!.push({
          key: 'low',
          start: result.ids.length,
          count: p.low.length,
          senders: senders(p.low),
        });
      if (p.follow.length) {
        result.sections!.push({ key: 'follow', start: result.ids.length, count: p.follow.length });
        result.ids.push(...idsOf(p.follow));
      }
      return result;
    }
    case 'homeSection':
    case 'oneByOne': {
      const p = homeParts(ctx, spec.accountId);
      if (spec.section === 'do')
        return sectioned([
          ['do', idsOf(p.doNew)],
          ['fromLater', idsOf(p.fromLater)],
        ]);
      const list = spec.section === 'update' ? p.update : spec.section === 'low' ? p.low : p.follow;
      return sectioned([[spec.section, idsOf(list)]]);
    }
    case 'lowSenders': {
      // One run per sender: the address as the key and the name as the engine-owned label.
      const groups = lowGroups(ctx, spec.accountId);
      return {
        rowType: 'SenderGroup',
        ids: idsOf(groups),
        sections: groups.map((g, i) => ({ key: g.address, label: g.name, start: i, count: 1 })),
      };
    }
    case 'lowBySender': {
      // The Low sheet's threads, one run per sender in `lowSenders` order (FR-27).
      const groups = lowGroups(ctx, spec.accountId);
      const result: ViewResult = { rowType: 'Thread', ids: [], sections: [] };
      for (const g of groups) {
        result.sections.push({
          key: g.address,
          label: g.name,
          start: result.ids.length,
          count: g.threadIds.length,
        });
        result.ids.push(...g.threadIds);
      }
      return result;
    }
  }
}

function mailboxView(ctx: ViewContext, spec: MailboxSpec): ViewResult {
  switch (spec.kind) {
    case 'mailbox': {
      const role = spec.role;
      const filter = (t: ThreadRow) =>
        role === 'all'
          ? !away(t)
          : role === 'archive'
            ? !away(t) && !has(t, 'INBOX')
            : role === 'starred'
              ? t.flagged && !away(t)
              : role === 'important'
                ? has(t, 'IMPORTANT') && !away(t)
                : has(t, role.toUpperCase());
      return {
        rowType: 'Thread',
        ids: idsOf(threadRows(ctx, filter, spec.accountId).sort(newest)),
        sections: [],
      };
    }
    case 'label':
      return {
        rowType: 'Thread',
        ids: idsOf(threadRows(ctx, t => t.labels.includes(spec.folderId) && !away(t)).sort(newest)),
        sections: [],
      };
    case 'later': {
      const today = localDay(ctx.now, ctx.zone);
      const list = threadRows(
        ctx,
        t => t.workflow.status === 'later' && !away(t),
        spec.accountId,
      ).sort(
        (a, b) =>
          (a.workflow.laterUntil ?? Infinity) - (b.workflow.laterUntil ?? Infinity) || newest(a, b),
      );
      const group = (t: ThreadRow) => {
        const until = t.workflow.laterUntil;
        if (until === undefined) return 'someday';
        if (until <= ctx.now) return 'overdue';
        const d = localDay(until, ctx.zone);
        return d === today
          ? 'today'
          : Date.parse(d) - Date.parse(today) <= 6 * 86_400_000
            ? 'week'
            : 'someday';
      };
      return sectioned(
        ['overdue', 'today', 'week', 'someday'].map(key => [
          key,
          idsOf(list.filter(t => group(t) === key)),
        ]),
      );
    }
    case 'bookmarks':
      return {
        rowType: 'Thread',
        ids: idsOf(
          threadRows(ctx, t => t.workflow.bookmarked && !away(t), spec.accountId).sort(newest),
        ),
        sections: [],
      };
    case 'replyState':
      return {
        rowType: 'Thread',
        ids: idsOf(
          threadRows(
            ctx,
            t => t.workflow.replyStatus === spec.status && !away(t),
            spec.accountId,
          ).sort(newest),
        ),
        sections: [],
      };
    case 'done':
      return {
        rowType: 'Thread',
        ids: idsOf(
          threadRows(ctx, t => t.workflow.status === 'done' && !away(t), spec.accountId).sort(
            (a, b) => (b.workflow.doneAt ?? 0) - (a.workflow.doneAt ?? 0) || newest(a, b),
          ),
        ),
        sections: [],
      };
    case 'drafts':
      return {
        rowType: 'Draft',
        ids: idsOf(
          ctx.store
            .all('Draft')
            .filter(d => (!spec.accountId || d.accountId === spec.accountId) && !d.submissionId)
            .sort((a, b) => b.updatedAt - a.updatedAt),
        ),
        sections: [],
      };
    case 'scheduled': {
      return {
        rowType: 'Submission',
        ids: idsOf(
          ctx.store
            .all('Submission')
            .filter(s => live.has(s.state) && (!spec.accountId || s.accountId === spec.accountId))
            .sort((a, b) => a.notBefore - b.notBefore),
        ),
        sections: [],
      };
    }
  }
}

function otherViews(ctx: ViewContext, spec: OtherSpec): ViewResult {
  switch (spec.kind) {
    case 'search':
      return {
        rowType: 'Thread',
        ids: idsOf(
          threadRows(
            ctx,
            t => matches(ctx, t, spec.query) || !!ctx.remote?.get(spec.query.text)?.includes(t.id),
            spec.accountId,
          ).sort(newest),
        ),
        sections: [],
      };
    case 'thread': {
      if (!ctx.store.get('Thread', spec.threadId))
        throw new ContractError({
          type: 'notFound',
          message: 'This conversation is no longer available.',
        });
      return {
        rowType: 'Message',
        ids: idsOf(
          ctx.store
            .all('Message')
            .filter(m => m.threadId === spec.threadId)
            .sort((a, b) => a.date - b.date),
        ),
        sections: [],
      };
    }
    case 'events': {
      if (spec.to < spec.from || spec.to - spec.from > maxEventRangeMs)
        throw new ContractError({
          type: 'rangeTooLarge',
          message: 'Choose a range of at most 62 days.',
        });
      return {
        rowType: 'Event',
        ids: idsOf(
          eventsIn(ctx, spec.from, spec.to, spec.calendarIds, spec.includeDeclined).filter(
            e => spec.includeHidden || !e.hidden,
          ),
        ),
        sections: [],
      };
    }
    case 'plans': {
      const { from, to } = spec;
      if (from !== undefined && to !== undefined && (to < from || to - from > maxEventRangeMs))
        throw new ContractError({
          type: 'rangeTooLarge',
          message: 'Choose a range of at most 62 days.',
        });
      // With a range, only plans overlapping it (the grid's dashed outlines, FR-22).
      const inRange = (p: Plan) =>
        (from === undefined || instant(p.end, ctx.zone) > from) &&
        (to === undefined || instant(p.start, ctx.zone) < to);
      return {
        rowType: 'Plan',
        ids: idsOf(
          ctx.store
            .all('Plan')
            .filter(
              p =>
                p.state === 'open' &&
                (!spec.threadId || p.threadId === spec.threadId) &&
                inRange(p),
            )
            .sort((a, b) => instant(a.start, ctx.zone) - instant(b.start, ctx.zone)),
        ),
        sections: [],
      };
    }
    case 'conversations':
      return {
        rowType: 'Conversation',
        ids: idsOf(ctx.store.all('Conversation').sort((a, b) => b.updatedAt - a.updatedAt)),
        sections: [],
      };
  }
}

/** Runs a spec. `frozen` is a `oneByOne` window's order, taken once when it opened. */
export function runView(ctx: ViewContext, spec: ViewSpec): ViewResult {
  switch (spec.kind) {
    case 'home':
    case 'homeSection':
    case 'oneByOne':
    case 'lowSenders':
    case 'lowBySender':
      return homeView(ctx, spec);
    case 'mailbox':
    case 'label':
    case 'later':
    case 'bookmarks':
    case 'replyState':
    case 'done':
    case 'drafts':
    case 'scheduled':
      return mailboxView(ctx, spec);
    case 'search':
    case 'thread':
    case 'events':
    case 'plans':
    case 'conversations':
      return otherViews(ctx, spec);
  }
}

/** An event time as an instant, for range checks and ordering (all-day dates count from local midnight). */
export function instant(
  t:
    | { type: 'utc'; utc: number }
    | { type: 'date'; date: string }
    | { type: 'floating'; local: string },
  zone: string,
): number {
  if (t.type === 'utc') return t.utc;
  if (t.type === 'date') return atLocal(t.date, 0, 0, zone);
  const [day = '', time = '00:00'] = t.local.split('T');
  const [h = 0, m = 0] = time.split(':').map(Number);
  return atLocal(day, h, m, zone);
}

function eventsIn(
  ctx: ViewContext,
  from: number,
  to: number,
  calendarIds?: string[],
  includeDeclined?: boolean,
) {
  const shown = new Set(
    ctx.store
      .all('Calendar')
      .filter(c => c.shown)
      .map(c => c.id),
  );
  return ctx.store
    .all('Event')
    .filter(
      e =>
        (calendarIds ? calendarIds.includes(e.calendarId) : shown.has(e.calendarId)) &&
        (includeDeclined || e.myResponse !== 'declined') &&
        e.status !== 'cancelled',
    )
    .filter(e => instant(e.start, ctx.zone) < to && instant(e.end, ctx.zone) > from)
    .sort(
      (a, b) => instant(a.start, ctx.zone) - instant(b.start, ctx.zone) || (a.id < b.id ? -1 : 1),
    );
}
