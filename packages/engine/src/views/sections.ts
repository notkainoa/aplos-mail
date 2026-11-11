import type { ViewSpec } from '@aplos/contract';
import type { StoreReader } from '../store';
import {
  accountIds,
  keysetPlan,
  materializedPlan,
  roleFolder,
  threadRowId,
  visible,
} from './compile';
import { NEWEST_WF, accountPred, tfCursor, wfCursor, type Pred } from './lists';
import {
  MATERIALIZED_LIMIT,
  type CursorDef,
  type KeyCol,
  type Run,
  type SectionPlan,
  type ViewEnv,
  type ViewPlan,
} from './specs';
import type { LayoutSection } from './specs';

/*
 * Grouped views (views-1): Home's sections, Later's groups and the Low importance sheet by sender. Home reads the `home`
 * index (status, lane, due_band, importance, due_date, last_date DESC, thread_id) as one run per band and importance,
 * dated rows before undated ones, which is exactly Do now's order (ARCH 8.2) without a sort.
 */

const BANDS = [0, 1, 2, 3] as const;
const IMPORTANCE = ['important', 'normal'] as const;
const DAY = 86_400_000;

const notHidden: Pred = ['coalesce(w.hidden_from_home, 0) = 0'];
/**
 * A thread someone wrote to you. One you started and nobody has answered is not new mail: it waits in Follow up, and it
 * must not also sit in Do now (every thread starts `new`, and the first sync reads Sent as well as Inbox).
 */
const inbound: Pred = [
  'EXISTS (SELECT 1 FROM threads lt WHERE lt.id = w.thread_id AND lt.last_inbound_date IS NOT NULL)',
];
const shown: Pred = [visible('w.thread_id')];

/** New mail in one lane, band and importance; `dated` picks rows with or without a due date. */
function laneCursor(
  lane: string,
  band: number,
  importance: string,
  dated: boolean,
  accountId: string | undefined,
  key?: KeyCol[],
): CursorDef {
  const preds: Pred[] = [
    ['w.status = ?', 'new'],
    ['w.lane = ?', lane],
    ['w.due_band = ?', band],
    ['w.importance = ?', importance],
    [dated ? 'w.due_date IS NOT NULL' : 'w.due_date IS NULL'],
    notHidden,
    inbound,
    ...accountPred(accountId),
    shown,
  ];
  const order: KeyCol[] = dated ? [{ expr: 'w.due_date' }, ...NEWEST_WF] : NEWEST_WF;
  return wfCursor(preds, key ?? order, 'home');
}

/** Do now: due band, important first, soonest due date (undated last), newest. One index range per run. */
function doRuns(accountId?: string): Run[] {
  return BANDS.flatMap(band =>
    IMPORTANCE.flatMap(imp =>
      [true, false].map(dated => ({ cursors: [laneCursor('do', band, imp, dated, accountId)] })),
    ),
  );
}

/** Important updates: important first, then newest, whatever the band. */
function updateRuns(accountId?: string): Run[] {
  return IMPORTANCE.map(imp => ({
    cursors: BANDS.flatMap(band =>
      [true, false].map(dated => laneCursor('update', band, imp, dated, accountId, NEWEST_WF)),
    ),
  }));
}

/** The Low band: newest first. */
function lowRun(accountId?: string): Run {
  return {
    cursors: BANDS.flatMap(band =>
      IMPORTANCE.flatMap(imp =>
        [true, false].map(dated => laneCursor('low', band, imp, dated, accountId, NEWEST_WF)),
      ),
    ),
  };
}

/** Back from Later: a Later item whose date has arrived, at the bottom of Do now in Do now's order, any lane. */
function fromLaterRun(env: ViewEnv, accountId?: string): Run {
  const preds: Pred[] = [
    // A literal, so the partial index `wf_later` (WHERE status = 'later') applies.
    ["w.status = 'later'"],
    ['w.later_until <= ?', env.now],
    notHidden,
    ...accountPred(accountId),
    shown,
  ];
  const key: KeyCol[] = [
    { expr: 'w.due_band' },
    { expr: 'w.importance' },
    { expr: "coalesce(w.due_date, '~')" },
    ...NEWEST_WF,
  ];
  return { cursors: [wfCursor(preds, key, 'wf_later')] };
}

/** Follow up: you sent the last message, nobody answered within `followUpDays`, and you are waiting on a reply. */
function followRun(q: StoreReader, env: ViewEnv, accountId?: string): Run {
  const cutoff = env.now - env.followUpDays * DAY;
  const preds: Pred[] = [
    ['tf.last_date <= ?', cutoff],
    [
      'EXISTS (SELECT 1 FROM threads ft WHERE ft.id = tf.thread_id AND (ft.last_inbound_date IS NULL OR ft.last_inbound_date < ft.last_date))',
    ],
    [
      'EXISTS (SELECT 1 FROM thread_workflow fw WHERE fw.thread_id = tf.thread_id AND fw.reply_status = ?)',
      'awaitingReply',
    ],
  ];
  const key: KeyCol[] = [{ expr: 'tf.last_date' }, { expr: 'tf.thread_id' }];
  const cursors: CursorDef[] = [];
  for (const a of accountIds(q, accountId)) {
    const sent = roleFolder(q, a, 'sent');
    if (sent !== undefined) cursors.push(tfCursor(sent, preds, key));
  }
  return { cursors };
}

/**
 * A participant who is not the owner: its address is no account's, and it sent no from-me message in the thread (an
 * alias sends under its own address, which no account row names).
 */
const NON_OWNER = `lower(coalesce(json_extract(p.value, '$.address'), '')) NOT IN
    (SELECT lower(ac.address) FROM accounts ac
     UNION
     SELECT lower(m.from_addr) FROM messages m
      WHERE m.thread_id = t.id AND (m.flags & 16) != 0 AND (m.flags & 8) = 0 AND m.from_addr IS NOT NULL AND m.from_addr <> '')`;

/**
 * The newest non-owner sender's name of each row, in place of its id: the Low band's "Field Notes, Cedar Market and
 * 3 more". Falls back to the newest participant so a thread only the owner wrote in still names someone.
 */
const SENDER_NAME = `coalesce(
    (SELECT json_extract(p.value, '$.name') FROM json_each(t.participants) p
      WHERE ${NON_OWNER} AND json_extract(p.value, '$.name') IS NOT NULL LIMIT 1),
    (SELECT json_extract(p.value, '$.address') FROM json_each(t.participants) p
      WHERE ${NON_OWNER} LIMIT 1),
    json_extract(t.participants, '$[0].name'), json_extract(t.participants, '$[0].address'), '')`;

function lowSenders(run: Run) {
  return (q: StoreReader) => {
    const names = new Set<string>();
    const named: Run = { cursors: run.cursors.map(c => ({ ...c, id: SENDER_NAME })) };
    for (const r of runPage(q, named, 200)) {
      if (r && names.size < 3) names.add(r);
    }
    return [...names];
  };
}

/** First `limit` row ids of a run, in order (merge across cursors). */
function runPage(q: StoreReader, run: Run, limit: number): string[] {
  const plan = keysetPlan({
    kind: 'run',
    rowType: 'Thread',
    sections: () => [{ key: '', runs: [run] }],
    resolve: () => undefined,
  });
  return plan.rows(q, undefined, limit).map(r => r.id);
}

type HomeSpec = Extract<ViewSpec, { kind: 'home' | 'homeSection' | 'oneByOne' }>;

function homeSections(q: StoreReader, spec: HomeSpec, env: ViewEnv): SectionPlan[] {
  const a = spec.accountId;
  const section = spec.kind === 'home' ? undefined : spec.section;
  const doNow: SectionPlan[] = [
    { key: 'do', runs: doRuns(a) },
    { key: 'fromLater', runs: [fromLaterRun(env, a)] },
  ];
  if (section === 'do') return doNow;
  if (section === 'update') return [{ key: 'update', runs: updateRuns(a) }];
  if (section === 'low') return [{ key: 'low', runs: [lowRun(a)] }];
  if (section === 'follow') return [{ key: 'follow', runs: [followRun(q, env, a)] }];
  const low = lowRun(a);
  return [
    ...doNow,
    { key: 'update', runs: updateRuns(a) },
    { key: 'low', runs: [low], countOnly: true, senders: lowSenders(low) },
    { key: 'follow', runs: [followRun(q, env, a)] },
  ];
}

/** `home`, `homeSection` and `oneByOne` (whose frozen order the window takes when it opens). */
export function homePlan(spec: HomeSpec, env: ViewEnv): ViewPlan {
  return keysetPlan({
    kind: spec.kind,
    rowType: 'Thread',
    sections: q => homeSections(q, spec, env),
    resolve: threadRowId,
  });
}

// ------------------------------------------------------------ Later

/** The local calendar day `YYYY-MM-DD` of an instant. */
export function localDay(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ms);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(day) + n * DAY).toISOString().slice(0, 10);
}

/** The zone's UTC offset in ms at an instant. */
function offsetAt(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(ms);
  const n = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The first instant of a local day (DST-safe: where midnight does not exist, the first instant that is that day). */
export function startOfDay(day: string, zone: string): number {
  const guess = Date.parse(day);
  let t = guess - offsetAt(guess, zone);
  t = guess - offsetAt(t, zone);
  while (localDay(t, zone) < day) t += 15 * 60_000;
  while (localDay(t - 1, zone) >= day) t -= 15 * 60_000;
  return t;
}

function laterRun(preds: Pred[], accountId?: string, key?: KeyCol[]): Run {
  const all: Pred[] = [["w.status = 'later'"], ...preds, ...accountPred(accountId), shown];
  const order: KeyCol[] = key ?? [{ expr: 'w.later_until' }, ...NEWEST_WF];
  return { cursors: [wfCursor(all, order, 'wf_later')] };
}

/** Later in groups Overdue, Today, This week (the next six days) and Someday (later, or no date). */
export function laterPlan(spec: Extract<ViewSpec, { kind: 'later' }>, env: ViewEnv): ViewPlan {
  return keysetPlan({
    kind: 'later',
    rowType: 'Thread',
    sections: () => {
      const today = localDay(env.now, env.zone);
      const tomorrow = startOfDay(addDays(today, 1), env.zone);
      const weekEnd = startOfDay(addDays(today, 7), env.zone);
      const a = spec.accountId;
      return [
        { key: 'overdue', runs: [laterRun([['w.later_until <= ?', env.now]], a)] },
        {
          key: 'today',
          runs: [
            laterRun(
              [
                ['w.later_until > ?', env.now],
                ['w.later_until < ?', tomorrow],
              ],
              a,
            ),
          ],
        },
        {
          key: 'week',
          runs: [
            laterRun(
              [
                ['w.later_until >= ?', tomorrow],
                ['w.later_until < ?', weekEnd],
              ],
              a,
            ),
          ],
        },
        {
          key: 'someday',
          runs: [
            laterRun([['w.later_until >= ?', weekEnd]], a),
            laterRun([['w.later_until IS NULL']], a, NEWEST_WF),
          ],
        },
      ];
    },
    resolve: threadRowId,
  });
}

// ------------------------------------------------------------ Low importance by sender

/**
 * The first participant who is not the owner, else the newest sender's name. The address and the name are each worked
 * out once per thread in the inner select: the owner test is a lookup, and running it again for every use of the
 * name made the grouping several times slower on a thread with many participants.
 */
const SENDER_ROW = `(SELECT json_array(t.account_id || ':' || t.remote_id, coalesce(x.address, x.name), x.name,
    t.list_unsub IS NOT NULL)
  FROM (SELECT
    (SELECT json_extract(p.value, '$.address') FROM json_each(t.participants) p WHERE ${NON_OWNER} LIMIT 1) AS address,
    ${SENDER_NAME} AS name) x)`;

export interface Group {
  address: string;
  name: string;
  threadIds: string[];
  /** Some thread of the sender carries a List-Unsubscribe link. */
  unsubscribe: boolean;
}

/** The Low band's threads grouped by sender, senders in order of their newest thread (bounded, computed whole). */
export function lowGroups(q: StoreReader, accountId?: string): Group[] {
  const run = lowRun(accountId);
  const rows: Run = { cursors: run.cursors.map(c => ({ ...c, id: SENDER_ROW })) };
  const groups = new Map<string, Group>();
  for (const raw of runPage(q, rows, MATERIALIZED_LIMIT)) {
    const [id, address, name, unsub] = JSON.parse(raw) as [string, string, string, number];
    const g = groups.get(address) ?? { address, name, threadIds: [], unsubscribe: false };
    g.threadIds.push(id);
    g.unsubscribe ||= unsub === 1;
    groups.set(address, g);
  }
  return [...groups.values()];
}

export const senderGroupId = (address: string) => `sender:${address}`;

export function lowSendersPlan(
  spec: Extract<ViewSpec, { kind: 'lowSenders' | 'lowBySender' }>,
): ViewPlan {
  const statements = (q: StoreReader) =>
    keysetPlan({
      kind: 'low',
      rowType: 'Thread',
      sections: () => [{ key: 'low', runs: [lowRun(spec.accountId)] }],
      resolve: () => undefined,
    }).statements(q);
  return materializedPlan({
    kind: spec.kind,
    rowType: spec.kind === 'lowSenders' ? 'SenderGroup' : 'Thread',
    build(q) {
      const groups = lowGroups(q, spec.accountId);
      const ids: string[] = [];
      const sections: LayoutSection[] = [];
      for (const g of groups) {
        const list = spec.kind === 'lowSenders' ? [senderGroupId(g.address)] : g.threadIds;
        sections.push({ key: g.address, label: g.name, start: ids.length, count: list.length });
        ids.push(...list);
      }
      return { ids, sections };
    },
    statements,
  });
}
