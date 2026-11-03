import type { ViewSpec } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { SqlValue, StoreReader } from '../store';
import {
  THREAD_ID,
  accountIds,
  keysetPlan,
  roleFolder,
  splitId,
  threadRowId,
  visible,
} from './compile';
import type { CursorDef, KeyCol, Run, ViewPlan } from './specs';

/*
 * The flat lists (views-1): mailboxes by folder role, labels, bookmarks, reply state, Done, drafts, scheduled sends and
 * a thread's messages. Folder lists read `thread_folders` newest first (its primary key, reversed); workflow lists read
 * `wf_status` per status and merge the three.
 */

/** A predicate and its parameters. */
export type Pred = [sql: string, ...params: SqlValue[]];

export const NEWEST_WF: KeyCol[] = [{ expr: 'w.last_date', desc: true }, { expr: 'w.thread_id' }];
const NEWEST_TF: KeyCol[] = [
  { expr: 'tf.last_date', desc: true },
  { expr: 'tf.thread_id', desc: true },
];
/** Workflow lists that merge with folder lists use the folder lists' tie order. */
const NEWEST_TF_WF: KeyCol[] = [
  { expr: 'w.last_date', desc: true },
  { expr: 'w.thread_id', desc: true },
];
const STATUSES = ['new', 'done', 'later'] as const;

const sqlOf = (preds: Pred[]) => preds.map(p => p[0]);
const paramsOf = (preds: Pred[]) => preds.flatMap(p => p.slice(1) as SqlValue[]);

/** A cursor over `thread_workflow w`, ids from the joined thread. */
export function wfCursor(preds: Pred[], key: KeyCol[] = NEWEST_WF, index = 'wf_status'): CursorDef {
  return {
    from: 'thread_workflow w',
    index,
    where: sqlOf(preds),
    params: paramsOf(preds),
    key,
    id: THREAD_ID,
    join: 'CROSS JOIN threads t ON t.id = w.thread_id',
    rowid: 'w.thread_id',
  };
}

/** One folder's thread list, newest first. */
export function tfCursor(folderId: number, preds: Pred[] = [], key = NEWEST_TF): CursorDef {
  const all: Pred[] = [['tf.folder_id = ?', folderId], ...preds];
  return {
    from: 'thread_folders tf',
    where: sqlOf(all),
    params: paramsOf(all),
    key,
    id: THREAD_ID,
    join: 'CROSS JOIN threads t ON t.id = tf.thread_id',
    rowid: 'tf.thread_id',
  };
}

export const accountPred = (accountId?: string): Pred[] =>
  accountId === undefined ? [] : [['w.account_id = ?', accountId]];

/** Every status's `wf_status` range, merged newest first. */
export function statusRun(preds: Pred[], accountId?: string, key: KeyCol[] = NEWEST_WF): Run {
  return {
    cursors: STATUSES.map(s =>
      wfCursor([['w.status = ?', s], ...accountPred(accountId), ...preds], key),
    ),
  };
}

/** The role's folder in each covered account, merged. */
export function roleRun(q: StoreReader, role: string, accountId?: string, preds: Pred[] = []): Run {
  const cursors: CursorDef[] = [];
  for (const a of accountIds(q, accountId)) {
    const folder = roleFolder(q, a, role);
    if (folder !== undefined) cursors.push(tfCursor(folder, preds));
  }
  return { cursors };
}

/** Archive: the account's Archive folder where it has one (IMAP), else everything outside the Inbox (Gmail). */
export function archiveRun(
  q: StoreReader,
  accountId?: string,
  preds: (col: string) => Pred[] = () => [],
): Run {
  const cursors: CursorDef[] = [];
  for (const a of accountIds(q, accountId)) {
    const folder = roleFolder(q, a, 'archive');
    if (folder !== undefined) {
      cursors.push(tfCursor(folder, preds('tf.thread_id')));
      continue;
    }
    const inbox = roleFolder(q, a, 'inbox') ?? -1;
    const notInbox: Pred = [
      'NOT EXISTS (SELECT 1 FROM thread_folders ix WHERE ix.folder_id = ? AND ix.thread_id = w.thread_id)',
      inbox,
    ];
    // Same key shape as the folder lists, so both kinds merge in one run.
    cursors.push(
      ...statusRun([notInbox, [visible('w.thread_id')], ...preds('w.thread_id')], a, NEWEST_TF_WF)
        .cursors,
    );
  }
  return { cursors };
}

export const threadPlan = (kind: string, runs: (q: StoreReader) => Run[]): ViewPlan =>
  keysetPlan({
    kind,
    rowType: 'Thread',
    sections: q => [{ key: '', runs: runs(q) }],
    resolve: threadRowId,
  });

type Mailbox = Extract<ViewSpec, { kind: 'mailbox' }>;

export function mailboxPlan(spec: Mailbox): ViewPlan {
  const shown: Pred = [visible('w.thread_id')];
  return threadPlan('mailbox', q => {
    switch (spec.role) {
      case 'all':
        return [statusRun([shown], spec.accountId)];
      case 'starred':
        return [
          statusRun(
            [
              ['EXISTS (SELECT 1 FROM threads st WHERE st.id = w.thread_id AND st.flagged = 1)'],
              shown,
            ],
            spec.accountId,
          ),
        ];
      case 'archive':
        return [archiveRun(q, spec.accountId)];
      default:
        return [roleRun(q, spec.role, spec.accountId)];
    }
  });
}

/** The folder row for a contract folder id, or undefined. */
export function folderRowId(q: StoreReader, id: string): number | undefined {
  const parts = splitId(q, id);
  if (!parts) return undefined;
  return q.get<{ id: number }>(
    'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
    parts.accountId,
    parts.remoteId,
  )?.id;
}

export function labelPlan(spec: Extract<ViewSpec, { kind: 'label' }>): ViewPlan {
  return threadPlan('label', q => {
    const folder = folderRowId(q, spec.folderId);
    return [{ cursors: folder === undefined ? [] : [tfCursor(folder)] }];
  });
}

export function workflowListPlan(
  spec: Extract<ViewSpec, { kind: 'bookmarks' | 'replyState' | 'done' }>,
): ViewPlan {
  const shown: Pred = [visible('w.thread_id')];
  return threadPlan(spec.kind, () => {
    switch (spec.kind) {
      case 'bookmarks':
        return [statusRun([['w.bookmarked = 1'], shown], spec.accountId)];
      case 'replyState':
        return [statusRun([['w.reply_status = ?', spec.status], shown], spec.accountId)];
      case 'done':
        // Newest first by the thread's date: schema 0001 has no done time (requested from eng-store).
        return [
          {
            cursors: [wfCursor([['w.status = ?', 'done'], ...accountPred(spec.accountId), shown])],
          },
        ];
    }
  });
}

/** Submission states that lock their draft (the stand-in's `live`, FR-7). */
export const LIVE_SUBMISSION = [
  'queued',
  'scheduled',
  'sending',
  'uncertain',
  'failed',
  'suspended',
];
const inLive = `(${LIVE_SUBMISSION.map(s => `'${s}'`).join(', ')})`;

const identity = (_q: StoreReader, id: string) => id;

/** A discarded or sent draft keeps its row, hidden, until its remote copy is deleted (`_sync.removing`, eng-time); unreadable data is not hidden. */
const NOT_REMOVING = `CASE WHEN json_valid(d.data) THEN json_extract(d.data, '$._sync.removing') END IS NULL`;

export function draftsPlan(spec: Extract<ViewSpec, { kind: 'drafts' }>): ViewPlan {
  const preds: Pred[] = [
    [NOT_REMOVING],
    [`NOT EXISTS (SELECT 1 FROM submissions s WHERE s.draft_id = d.id AND s.state IN ${inLive})`],
    ...(spec.accountId === undefined ? [] : [['d.account_id = ?', spec.accountId] as Pred]),
  ];
  const cursor: CursorDef = {
    from: 'drafts d',
    where: sqlOf(preds),
    params: paramsOf(preds),
    key: [{ expr: 'd.updated_at', desc: true }, { expr: 'd.id' }],
    id: 'd.id',
    rowid: 'd.id',
  };
  return keysetPlan({
    kind: 'drafts',
    rowType: 'Draft',
    sections: () => [{ key: '', runs: [{ cursors: [cursor] }] }],
    resolve: identity,
  });
}

export function scheduledPlan(spec: Extract<ViewSpec, { kind: 'scheduled' }>): ViewPlan {
  const preds: Pred[] = [
    [`s.state IN ${inLive}`],
    ...(spec.accountId === undefined ? [] : [['s.account_id = ?', spec.accountId] as Pred]),
  ];
  const cursor: CursorDef = {
    from: 'submissions s',
    where: sqlOf(preds),
    params: paramsOf(preds),
    key: [{ expr: 's.not_before' }, { expr: 's.id' }],
    id: 's.id',
    rowid: 's.id',
  };
  return keysetPlan({
    kind: 'scheduled',
    rowType: 'Submission',
    sections: () => [{ key: '', runs: [{ cursors: [cursor] }] }],
    resolve: identity,
  });
}

/** The reader: the thread's messages oldest first (date-ordered rowids), drafts excluded (they are `Draft` rows, D9). */
export function threadMessagesPlan(spec: Extract<ViewSpec, { kind: 'thread' }>): ViewPlan {
  return keysetPlan({
    kind: 'thread',
    rowType: 'Message',
    sections(q) {
      const thread = threadRowId(q, spec.threadId);
      if (thread === undefined)
        throw new ContractError({
          type: 'notFound',
          message: 'This conversation is no longer available.',
        });
      const cursor: CursorDef = {
        from: 'messages m',
        where: ['m.thread_id = ?', '(m.flags & 8) = 0'],
        params: [thread],
        key: [{ expr: 'm.id' }],
        id: "m.account_id || ':' || m.remote_id",
        rowid: 'm.id',
      };
      return [{ key: '', runs: [{ cursors: [cursor] }] }];
    },
    resolve(q, id) {
      const parts = splitId(q, id);
      if (!parts) return undefined;
      return q.get<{ id: number }>(
        'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
        parts.accountId,
        parts.remoteId,
      )?.id;
    },
  });
}
