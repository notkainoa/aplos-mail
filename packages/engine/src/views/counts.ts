import type { Counts, Folder, Output, State } from '@aplos/contract';
import type { StoreReader } from '../store';
import { accountIds, roleFolder } from './compile';
import { lowGroups, senderGroupId, localDay, startOfDay } from './sections';
import { compileView } from './registry';
import type { ViewEnv } from './specs';

/*
 * Sidebar numbers, the folder list and the Low importance sender rows (views-2). All of them read through the compiled
 * views and the unread index, so a number always agrees with the list it opens.
 */

type CountsBlock = Counts['all'];
export type SenderGroupRow = Output<'SenderGroup/get'>['list'][number];

const sectionCount = (sections: { key: string; count: number }[], ...keys: string[]) =>
  sections.filter(s => keys.includes(s.key)).reduce((n, s) => n + s.count, 0);

/** Unread threads in the account's Inbox (all accounts when `accountId` is absent). */
function unreadInbox(q: StoreReader, accountId?: string): number {
  let n = 0;
  for (const a of accountIds(q, accountId)) {
    const inbox = roleFolder(q, a, 'inbox');
    if (inbox === undefined) continue;
    n +=
      q.get<{ n: number }>(
        'SELECT count(*) AS n FROM thread_folders WHERE folder_id = ? AND unread > 0',
        inbox,
      )?.n ?? 0;
  }
  return n;
}

/** Later items whose date has arrived (the sidebar's due badge). */
function laterDue(q: StoreReader, env: ViewEnv, accountId?: string): number {
  const where = accountId === undefined ? '' : ' AND account_id = ?';
  const params = accountId === undefined ? [env.now] : [env.now, accountId];
  return (
    q.get<{ n: number }>(
      `SELECT count(*) AS n FROM thread_workflow WHERE status = 'later' AND later_until <= ?${where}`,
      ...params,
    )?.n ?? 0
  );
}

/**
 * Threads moved off Home today in the owner's local day: Done and Later, by the time the owner last edited them (undo
 * puts the thread back, so it subtracts). Trash and Spam are not counted until `Thread/act` records them (views-3).
 */
function handledToday(q: StoreReader, env: ViewEnv, accountId?: string): number {
  const since = startOfDay(localDay(env.now, env.zone), env.zone);
  const where = accountId === undefined ? '' : ' AND account_id = ?';
  const params = accountId === undefined ? [since] : [since, accountId];
  return (
    q.get<{ n: number }>(
      `SELECT count(*) AS n FROM thread_workflow WHERE status IN ('done', 'later') AND edited_at >= ?${where}`,
      ...params,
    )?.n ?? 0
  );
}

function block(q: StoreReader, env: ViewEnv, accountId?: string): CountsBlock {
  const home = compileView({ kind: 'home', accountId }, env).layout(q).sections;
  const doNow = sectionCount(home, 'do', 'fromLater');
  const update = sectionCount(home, 'update');
  return {
    home: doNow + update,
    do: doNow,
    update,
    follow: sectionCount(home, 'follow'),
    laterDue: laterDue(q, env, accountId),
    drafts: compileView({ kind: 'drafts', accountId }, env).layout(q).total,
    scheduled: compileView({ kind: 'scheduled', accountId }, env).layout(q).total,
    unread: unreadInbox(q, accountId),
    handledToday: handledToday(q, env, accountId),
  };
}

/** Unread threads per folder id, for folders that have any. */
function folderUnread(q: StoreReader): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of q.all<{ folder_id: number; n: number }>(
    'SELECT folder_id, count(*) AS n FROM thread_folders WHERE unread > 0 GROUP BY folder_id',
  ))
    out.set(r.folder_id, r.n);
  return out;
}

type FolderRow = {
  id: number;
  account_id: string;
  remote_id: string;
  name: string;
  role: string | null;
  kind: string;
  hidden: number;
};

export function readFolders(q: StoreReader, accountId?: string): Folder[] {
  const unread = folderUnread(q);
  const rows =
    accountId === undefined
      ? q.all<FolderRow>('SELECT * FROM folders ORDER BY account_id, id')
      : q.all<FolderRow>('SELECT * FROM folders WHERE account_id = ? ORDER BY id', accountId);
  return rows.map(f => ({
    id: `${f.account_id}:${f.remote_id}`,
    accountId: f.account_id,
    name: f.name,
    ...(f.role ? { role: f.role as Folder['role'] } : {}),
    kind: f.kind,
    hidden: f.hidden === 1,
    unread: unread.get(f.id) ?? 0,
  }));
}

export function readCounts(q: StoreReader, env: ViewEnv): Counts {
  const accounts: Record<string, CountsBlock> = {};
  for (const id of accountIds(q)) accounts[id] = block(q, env, id);
  const folders: Record<string, number> = {};
  for (const f of readFolders(q)) folders[f.id] = f.unread;
  return { all: block(q, env), accounts, folders };
}

/** `SenderGroup/get`: the Low importance sender rows for `sender:<address>` ids; the rest come back in `notFound`. */
export function readSenderGroups(
  q: StoreReader,
  ids: readonly string[],
  state: State,
): { state: State; list: SenderGroupRow[]; notFound: string[] } {
  const byId = new Map(lowGroups(q).map(g => [senderGroupId(g.address), g]));
  const list: SenderGroupRow[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const g = byId.get(id);
    if (!g) notFound.push(id);
    else
      list.push({
        id,
        address: g.address,
        ...(g.name ? { name: g.name } : {}),
        count: g.threadIds.length,
        latestThreadId: g.threadIds[0],
        unsubscribe: g.unsubscribe,
      });
  }
  return { state, list, notFound };
}
