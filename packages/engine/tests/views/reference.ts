import type { SearchQuery, ViewSpec } from '@aplos/contract';
import type { StoreReader } from '../../src/store';
import type { LayoutSection, ViewEnv } from '../../src/views/specs';
import { localDay } from '../../src/views/sections';
import { bodyOf } from './world';

/*
 * The slow reference for the view compiler: every table read whole into memory and each spec evaluated as plain
 * filters and sorts, written from the rules (ARCH 8.2, D8, the stand-in's `views.ts`) rather than from the SQL.
 */

interface RMsg {
  row: number;
  id: string;
  flags: number;
  origin: string;
  folders: number[];
  fromAddr: string;
  fromName: string;
  to: string;
  subject: string;
}
interface RThread {
  row: number;
  id: string;
  account: string;
  last: number;
  inbound: number | null;
  flagged: number;
  unread: number;
  attach: number;
  participants: { address?: string; name?: string }[];
  status: string;
  lane: string;
  importance: string;
  band: number;
  due: string | null;
  until: number | null;
  hidden: boolean;
  bookmarked: boolean;
  reply: string | null;
  lists: Set<number>;
  msgs: RMsg[];
}
interface RFolder {
  row: number;
  account: string;
  remote: string;
  role: string | null;
}
export interface Data {
  threads: RThread[];
  folders: RFolder[];
  accounts: { id: string; address: string }[];
  drafts: { id: string; account: string; updated: number }[];
  subs: { id: string; draft: string; account: string; notBefore: number; state: string }[];
}

const LIVE = new Set(['queued', 'scheduled', 'sending', 'uncertain', 'failed', 'suspended']);

export function load(q: StoreReader): Data {
  const folders = q
    .all<{ id: number; account_id: string; remote_id: string; role: string | null }>(
      'SELECT * FROM folders',
    )
    .map(f => ({ row: f.id, account: f.account_id, remote: f.remote_id, role: f.role }));
  const placements = new Map<number, number[]>();
  for (const p of q.all<{ message_id: number; folder_id: number }>('SELECT * FROM message_folders'))
    placements.set(p.message_id, [...(placements.get(p.message_id) ?? []), p.folder_id]);
  const lists = new Map<number, Set<number>>();
  for (const l of q.all<{ thread_id: number; folder_id: number }>('SELECT * FROM thread_folders'))
    lists.set(l.thread_id, (lists.get(l.thread_id) ?? new Set()).add(l.folder_id));
  const msgs = new Map<number, RMsg[]>();
  for (const m of q.all<Record<string, never>>('SELECT * FROM messages ORDER BY id'))
    msgs.set(m.thread_id, [
      ...(msgs.get(m.thread_id) ?? []),
      {
        row: m.id,
        id: `${m.account_id}:${m.remote_id}`,
        flags: m.flags,
        origin: m.origin,
        folders: placements.get(m.id) ?? [],
        fromAddr: m.from_addr ?? '',
        fromName: m.from_name ?? '',
        to: m.to_json ?? '',
        subject: m.subject ?? '',
      },
    ]);
  const threads = q
    .all<Record<string, never>>(
      'SELECT t.*, w.* FROM threads t JOIN thread_workflow w ON w.thread_id = t.id',
    )
    .map(t => ({
      row: t.thread_id,
      id: `${t.account_id}:${t.remote_id}`,
      account: t.account_id,
      last: t.last_date,
      inbound: t.last_inbound_date,
      flagged: t.flagged,
      unread: t.unread_count,
      attach: t.has_attach,
      participants: JSON.parse(t.participants ?? '[]'),
      status: t.status,
      lane: t.lane,
      importance: t.importance,
      band: t.due_band,
      due: t.due_date,
      until: t.later_until,
      hidden: !!t.hidden_from_home,
      bookmarked: t.bookmarked === 1,
      reply: t.reply_status,
      lists: lists.get(t.thread_id) ?? new Set<number>(),
      msgs: msgs.get(t.thread_id) ?? [],
    }));
  return {
    threads,
    folders,
    accounts: q.all<{ id: string; address: string }>(
      'SELECT id, address FROM accounts ORDER BY id',
    ),
    drafts: q
      .all<{ id: string; account_id: string; updated_at: number }>('SELECT * FROM drafts')
      .map(d => ({ id: d.id, account: d.account_id, updated: d.updated_at })),
    subs: q.all<Record<string, never>>('SELECT * FROM submissions').map(s => ({
      id: s.id,
      draft: s.draft_id,
      account: s.account_id,
      notBefore: s.not_before,
      state: s.state,
    })),
  };
}

export interface Expected {
  ids: string[];
  sections: LayoutSection[];
  /** Count-only rows (Home's Low band), checked through the section counts. */
  total: number;
}

const awayRoles = new Set(['trash', 'spam']);

function reference(d: Data, env: ViewEnv) {
  const role = (f: number) => d.folders.find(x => x.row === f)?.role ?? null;
  const roleFolder = (account: string, r: string) =>
    d.folders.filter(f => f.account === account && f.role === r).sort((a, b) => a.row - b.row)[0]
      ?.row;
  const accounts = (a?: string) =>
    d.accounts.map(x => x.id).filter(x => a === undefined || x === a);
  const visible = (t: RThread) =>
    t.msgs.some(
      m =>
        !(m.flags & 8) &&
        m.origin !== 'search' &&
        !m.folders.some(f => awayRoles.has(role(f) ?? '')),
    );
  const inAcct = (a?: string) => (t: RThread) => a === undefined || t.account === a;
  const wfNewest = (a: RThread, b: RThread) => b.last - a.last || a.row - b.row;
  const tfNewest = (a: RThread, b: RThread) => b.last - a.last || b.row - a.row;
  const imp = (t: RThread) => (t.importance === 'important' ? 0 : 1);
  return { role, roleFolder, accounts, visible, inAcct, wfNewest, tfNewest, imp, d, env };
}
type Ref = ReturnType<typeof reference>;

/** SQLite's BINARY collation on ASCII: plain code-unit order, not the locale's. */
const byteOrder = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

const ids = (list: RThread[]) => list.map(t => t.id);

function sectioned(
  parts: [string, string[]][],
  countOnly: [string, number, string[]?][] = [],
): Expected {
  const out: Expected = { ids: [], sections: [], total: 0 };
  for (const [key, list] of parts) {
    const only = countOnly.find(c => c[0] === key);
    if (only) {
      if (only[1])
        out.sections.push({
          key,
          start: out.ids.length,
          count: only[1],
          ...(only[2] ? { senders: only[2] } : {}),
        });
      continue;
    }
    if (list.length) out.sections.push({ key, start: out.ids.length, count: list.length });
    out.ids.push(...list);
  }
  out.total = out.ids.length;
  return out;
}

function homeLists(r: Ref, a?: string) {
  const live = r.d.threads.filter(t => r.inAcct(a)(t) && r.visible(t));
  const onHome = live.filter(t => !t.hidden);
  const doOrder = (x: RThread, y: RThread) =>
    x.band - y.band ||
    r.imp(x) - r.imp(y) ||
    byteOrder(x.due ?? '~', y.due ?? '~') ||
    r.wfNewest(x, y);
  const newIn = (lane: string) =>
    onHome.filter(t => t.status === 'new' && t.lane === lane && t.inbound !== null);
  const cutoff = r.env.now - r.env.followUpDays * 86_400_000;
  const sent = new Set(
    r
      .accounts(a)
      .map(x => r.roleFolder(x, 'sent'))
      .filter(x => x !== undefined),
  );
  return {
    do: newIn('do').sort(doOrder),
    fromLater: onHome
      .filter(t => t.status === 'later' && t.until !== null && t.until <= r.env.now)
      .sort(doOrder),
    update: newIn('update').sort((x, y) => r.imp(x) - r.imp(y) || r.wfNewest(x, y)),
    low: newIn('low').sort(r.wfNewest),
    follow: r.d.threads
      .filter(
        t =>
          r.inAcct(a)(t) &&
          [...t.lists].some(f => sent.has(f)) &&
          t.last <= cutoff &&
          (t.inbound === null || t.inbound < t.last) &&
          t.reply === 'awaitingReply',
      )
      .sort((x, y) => x.last - y.last || x.row - y.row),
  };
}

const fromName = (t: RThread) => t.participants[0]?.name ?? t.participants[0]?.address ?? '';

/** A participant is not the owner when its address is no account's and sent no non-draft from-me message here. */
const nonOwner = (r: Ref, t: RThread, p: { address?: string }) => {
  const addr = (p.address ?? '').toLowerCase();
  return (
    !r.d.accounts.some(a => a.address.toLowerCase() === addr) &&
    !t.msgs.some(
      m =>
        m.fromAddr !== '' &&
        (m.flags & 16) !== 0 &&
        (m.flags & 8) === 0 &&
        m.fromAddr.toLowerCase() === addr,
    )
  );
};

/** The newest non-owner sender's name, else address, else the newest sender's (SENDER_NAME in views/sections). */
const senderName = (r: Ref, t: RThread): string => {
  const others = t.participants.filter(p => nonOwner(r, t, p));
  return (
    others.find(p => p.name != null)?.name ??
    others.find(p => p.address != null)?.address ??
    fromName(t)
  );
};

function homeExpected(
  r: Ref,
  spec: Extract<ViewSpec, { kind: 'home' | 'homeSection' | 'oneByOne' }>,
): Expected {
  const h = homeLists(r, spec.accountId);
  if (spec.kind !== 'home') {
    if (spec.section === 'do')
      return sectioned([
        ['do', ids(h.do)],
        ['fromLater', ids(h.fromLater)],
      ]);
    return sectioned([[spec.section, ids(h[spec.section])]]);
  }
  const senders = [...new Set(h.low.map(t => senderName(r, t)).filter(Boolean))].slice(0, 3);
  return sectioned(
    [
      ['do', ids(h.do)],
      ['fromLater', ids(h.fromLater)],
      ['update', ids(h.update)],
      ['low', []],
      ['follow', ids(h.follow)],
    ],
    [['low', h.low.length, senders]],
  );
}

function lowGroups(
  r: Ref,
  spec: Extract<ViewSpec, { kind: 'lowSenders' | 'lowBySender' }>,
): Expected {
  const groups = new Map<string, { name: string; ids: string[] }>();
  for (const t of homeLists(r, spec.accountId).low) {
    const address = t.participants.find(p => nonOwner(r, t, p))?.address ?? senderName(r, t);
    const g = groups.get(address) ?? { name: senderName(r, t), ids: [] };
    g.ids.push(t.id);
    groups.set(address, g);
  }
  const out: Expected = { ids: [], sections: [], total: 0 };
  for (const [address, g] of groups) {
    const list = spec.kind === 'lowSenders' ? [`sender:${address}`] : g.ids;
    out.sections.push({ key: address, label: g.name, start: out.ids.length, count: list.length });
    out.ids.push(...list);
  }
  out.total = out.ids.length;
  return out;
}

function mailboxThreads(r: Ref, role: string, a?: string): RThread[] {
  const live = r.d.threads.filter(r.inAcct(a));
  if (role === 'all') return live.filter(r.visible).sort(r.wfNewest);
  if (role === 'starred') return live.filter(t => r.visible(t) && t.flagged).sort(r.wfNewest);
  if (role === 'archive') return live.filter(t => inArchive(r, t)).sort(r.tfNewest);
  return live
    .filter(t => {
      const f = r.roleFolder(t.account, role);
      return f !== undefined && t.lists.has(f);
    })
    .sort(r.tfNewest);
}

function laterExpected(r: Ref, a?: string): Expected {
  const today = localDay(r.env.now, r.env.zone);
  const list = r.d.threads.filter(t => r.inAcct(a)(t) && t.status === 'later' && r.visible(t));
  const group = (t: RThread) => {
    if (t.until === null) return 'someday';
    if (t.until <= r.env.now) return 'overdue';
    const d = localDay(t.until, r.env.zone);
    if (d === today) return 'today';
    return Date.parse(d) - Date.parse(today) <= 6 * 86_400_000 ? 'week' : 'someday';
  };
  const order = (x: RThread, y: RThread) =>
    (x.until ?? Infinity) - (y.until ?? Infinity) || r.wfNewest(x, y);
  return sectioned(
    ['overdue', 'today', 'week', 'someday'].map(k => [
      k,
      ids(list.filter(t => group(t) === k).sort(order)),
    ]),
  );
}

const flat = (list: string[]): Expected => ({ ids: list, sections: [], total: list.length });

/** FTS5's unicode61 view of a text: lower-case alphanumeric tokens with accents removed. */
const tokens = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** A quoted prefix phrase against a token list: consecutive tokens, the last one by prefix. */
function phraseIn(word: string, hay: string[]): boolean {
  const p = tokens(word);
  if (!p.length) return true;
  return hay.some((_, i) =>
    p.every((w, j) => (j === p.length - 1 ? (hay[i + j] ?? '').startsWith(w) : hay[i + j] === w)),
  );
}

function ftsMatch(m: RMsg, qy: SearchQuery): boolean {
  const people = tokens(`${m.fromName} ${m.fromAddr} ${m.to}`);
  const all = [tokens(m.subject), people, tokens(bodyOf(m.row))];
  const words = (s?: string) => (s ?? '').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  return (
    words(qy.text).every(w => all.some(col => phraseIn(w, col))) &&
    words(qy.from).every(w => phraseIn(w, people)) &&
    words(qy.to).every(w => phraseIn(w, people)) &&
    words(qy.subject).every(w => phraseIn(w, tokens(m.subject)))
  );
}

const has = (hay: string, v: string) => hay.toLowerCase().includes(v.toLowerCase());

/** Archive: the account's Archive folder where it has one (IMAP), else everything outside the Inbox (Gmail). */
function inArchive(r: Ref, t: RThread): boolean {
  const archive = r.roleFolder(t.account, 'archive');
  if (archive !== undefined) return t.lists.has(archive);
  const inbox = r.roleFolder(t.account, 'inbox');
  return r.visible(t) && (inbox === undefined || !t.lists.has(inbox));
}

/** A thread only a provider search found: word search shows it with no place or `all` (fix-search, 2026-11-12). */
const searchHit = (r: Ref, t: RThread) =>
  t.msgs.some(
    m =>
      !(m.flags & 8) &&
      m.origin === 'search' &&
      !m.folders.some(f => awayRoles.has(r.role(f) ?? '')),
  );

function placeOk(r: Ref, t: RThread, place: string | undefined, words: boolean): boolean {
  const p = place?.toLowerCase() ?? 'all';
  if (p === 'all') return r.visible(t) || (words && searchHit(r, t));
  if (p === 'starred') return !!t.flagged;
  if (p === 'done' || p === 'later') return t.status === p;
  if (p === 'archive') return inArchive(r, t);
  if (['inbox', 'sent', 'trash', 'spam', 'important'].includes(p))
    return [...t.lists].some(f => r.role(f) === p);
  const f = r.d.folders.find(x => `${x.account}:${x.remote}` === place);
  return !!f && t.lists.has(f.row);
}

function threadOk(
  r: Ref,
  t: RThread,
  qy: SearchQuery,
  startOf: (day: string) => number,
  words: boolean,
): boolean {
  if (qy.hasAttachment !== undefined && !!t.attach !== qy.hasAttachment) return false;
  if (qy.before && !(t.last < startOf(qy.before))) return false;
  if (qy.after && !(t.last >= startOf(qy.after))) return false;
  for (const f of qy.is ?? []) {
    if (f === 'unread' && !t.unread) return false;
    if (f === 'read' && t.unread) return false;
    if (f === 'flagged' && !t.flagged) return false;
    if (f === 'bookmarked' && !t.bookmarked) return false;
  }
  return placeOk(r, t, qy.in, words);
}

function searchExpected(
  r: Ref,
  spec: Extract<ViewSpec, { kind: 'search' }>,
  startOf: (day: string) => number,
  fts: boolean,
): Expected {
  const qy = spec.query;
  const list = r.d.threads.filter(
    t => r.inAcct(spec.accountId)(t) && threadOk(r, t, qy, startOf, fts),
  );
  if (fts) {
    const hit = list.filter(t =>
      t.msgs.some(
        m =>
          ftsMatch(m, qy) &&
          (!qy.from || has(m.fromAddr, qy.from) || has(m.fromName, qy.from)) &&
          (!qy.to || has(m.to, qy.to)),
      ),
    );
    return flat(ids(hit.sort(r.tfNewest)));
  }
  // Words were typed but none is searchable (punctuation only): nothing matches.
  if ([qy.text, qy.from, qy.to, qy.subject].some(v => (v ?? '').trim() !== '')) return flat([]);
  const p = qy.in?.toLowerCase();
  const tfOrdered =
    p !== undefined && p !== 'done' && p !== 'later' && p !== 'starred' && p !== 'all';
  // A role place reads one folder per account: the account's first folder with that role.
  const inPlace =
    tfOrdered && ['inbox', 'sent', 'trash', 'spam', 'important'].includes(p!)
      ? list.filter(t => {
          const f = r.roleFolder(t.account, p!);
          return f !== undefined && t.lists.has(f);
        })
      : list;
  return flat(ids(inPlace.sort(tfOrdered ? r.tfNewest : r.wfNewest)));
}

export function expected(
  d: Data,
  spec: ViewSpec,
  env: ViewEnv,
  opts: { fts: boolean; startOf: (day: string) => number },
): Expected {
  const r = reference(d, env);
  const a = 'accountId' in spec ? spec.accountId : undefined;
  switch (spec.kind) {
    case 'home':
    case 'homeSection':
    case 'oneByOne':
      return homeExpected(r, spec);
    case 'lowSenders':
    case 'lowBySender':
      return lowGroups(r, spec);
    case 'mailbox':
      return flat(ids(mailboxThreads(r, spec.role, a)));
    case 'label': {
      const f = d.folders.find(x => `${x.account}:${x.remote}` === spec.folderId);
      return flat(ids(d.threads.filter(t => !!f && t.lists.has(f.row)).sort(r.tfNewest)));
    }
    case 'later':
      return laterExpected(r, a);
    case 'bookmarks':
      return flat(
        ids(d.threads.filter(t => r.inAcct(a)(t) && t.bookmarked && r.visible(t)).sort(r.wfNewest)),
      );
    case 'replyState':
      return flat(
        ids(
          d.threads
            .filter(t => r.inAcct(a)(t) && t.reply === spec.status && r.visible(t))
            .sort(r.wfNewest),
        ),
      );
    case 'done':
      return flat(
        ids(
          d.threads
            .filter(t => r.inAcct(a)(t) && t.status === 'done' && r.visible(t))
            .sort(r.wfNewest),
        ),
      );
    case 'drafts': {
      const locked = new Set(d.subs.filter(s => LIVE.has(s.state)).map(s => s.draft));
      return flat(
        d.drafts
          .filter(x => (a === undefined || x.account === a) && !locked.has(x.id))
          .sort((x, y) => y.updated - x.updated || (x.id < y.id ? -1 : 1))
          .map(x => x.id),
      );
    }
    case 'scheduled':
      return flat(
        d.subs
          .filter(s => LIVE.has(s.state) && (a === undefined || s.account === a))
          .sort((x, y) => x.notBefore - y.notBefore || (x.id < y.id ? -1 : 1))
          .map(s => s.id),
      );
    case 'search':
      return searchExpected(r, spec, opts.startOf, opts.fts);
    case 'thread': {
      const t = d.threads.find(x => x.id === spec.threadId);
      return flat((t?.msgs ?? []).filter(m => !(m.flags & 8)).map(m => m.id));
    }
    default:
      throw new Error(`no reference for ${spec.kind}`);
  }
}
