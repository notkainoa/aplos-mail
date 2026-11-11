/**
 * Rows as the shared list wants them: the pure mapping from a thread, a draft or a submission to the props of
 * `ListRow` (DESIGN 4.1, 7.4). Thread rows reuse Home's mapping; Drafts rows are Draft rows (recipients and the time
 * they were edited), Sent shows the recipients, Done adds the "Done 9:41 AM" stamp. Nothing here reads the engine.
 */
import { toIsoDateTime, type Draft, type Submission, type ThreadRow } from '../../data';
import type { LaterUntil, ListRowProps } from '../../ui/props';
import {
  joinNames,
  listRowProps,
  otherNames,
  primaryOf,
  senderOf,
  type RowContext,
} from '../home/homeRows';
import type { ListConfig } from './listKinds';

/** A row a mail list can hold. */
export type ListRowData = ThreadRow | Draft | Submission;

/** What a row opens as: a thread in the reader, a draft in the composer, a submission in the outbox. */
export type OpenKind = 'thread' | 'draft' | 'submission';

/** Narrows an unknown cache entry to a draft. */
export function isDraft(row: unknown): row is Draft {
  return typeof row === 'object' && row !== null && 'revision' in row && 'html' in row;
}

/** Narrows an unknown cache entry to a submission. */
export function isSubmission(row: unknown): row is Submission {
  return typeof row === 'object' && row !== null && 'toNames' in row && 'notBefore' in row;
}

/** Narrows an unknown cache entry to a thread row. */
export function isThread(row: unknown): row is ThreadRow {
  return typeof row === 'object' && row !== null && 'participants' in row && 'workflow' in row;
}

/** Keeps a cache entry the list can draw; anything else (a row type a newer engine added) is dropped. */
export function asListRow(row: unknown): ListRowData | undefined {
  return isThread(row) || isDraft(row) || isSubmission(row) ? row : undefined;
}

/** What opening the row does. */
export function openKindOf(row: ListRowData): OpenKind {
  if (isDraft(row)) return 'draft';
  return isSubmission(row) ? 'submission' : 'thread';
}

/** Sent's who column: the people the thread went to (the newest message the owner sent), never the owner. */
export function recipientsOfThread(row: ThreadRow): string {
  const to = otherNames(row.recipients);
  if (to.length > 0) return joinNames(to);
  const names = otherNames(row.participants);
  return names.length > 0 ? joinNames(names) : senderOf(row);
}

/** A draft's who column: its recipients, or "No recipient" for a draft with none yet. */
export function recipientsOfDraft(draft: Draft): string {
  const names = draft.to
    .map(person => (person.name || person.address).trim())
    .filter(name => name.length > 0);
  return names.length > 0 ? joinNames(names) : 'No recipient';
}

const TAG = /<[^>]*>/g;
const SPACE = /\s+/g;

/** The words of a draft's body without markup, for the line when the subject is empty. Never inserted as HTML. */
export function plainText(html: string): string {
  return html.replace(TAG, ' ').replace(SPACE, ' ').trim();
}

/** A draft's main line: its subject, else the start of its body, else "No subject". */
export function draftLine(draft: Draft): string {
  const subject = draft.subject.trim();
  if (subject.length > 0) return subject;
  const body = plainText(draft.html);
  return body.length > 0 ? body : 'No subject';
}

/** A submission's main line. */
function submissionLine(submission: Submission): string {
  const subject = submission.subject.trim();
  return subject.length > 0 ? subject : 'No subject';
}

/** The moment a row sorts and groups by: last activity, or when it was finished in Done. */
export function dateMsOf(row: ListRowData, field: ListConfig['dateField']): number | undefined {
  if (isDraft(row)) return row.updatedAt;
  if (isSubmission(row)) return row.sentAt ?? row.notBefore;
  if (field === 'doneAt') return row.workflow.doneAt;
  return row.lastDate;
}

/** The part of `ListRowProps` the screen decides. */
export interface ListRowContext extends Omit<RowContext, 'layout'> {
  readonly config: ListConfig;
  /** The clock, for the Later chip's overdue flag. */
  readonly nowMs?: number;
  /** This row is in the bulk pick (`--accent-wash`). */
  readonly picked?: boolean;
  /** A bulk pick is under way, so every row shows its pick box. */
  readonly picking?: boolean;
}

/** When a Later thread comes back: a moment (overdue once it has passed) or Someday. */
export function laterUntilOf(row: ThreadRow, nowMs: number): LaterUntil {
  const at = row.workflow.laterUntil;
  if (at === undefined) return { kind: 'someday' };
  return { kind: 'at', at: toIsoDateTime(at), overdue: at < nowMs };
}

/** A row before the bulk pick state is added: `listRowPropsFor` adds it for every kind at once. */
type UnpickedProps = Omit<ListRowProps, 'picked' | 'picking'>;

function draftProps(draft: Draft, context: ListRowContext): UnpickedProps {
  return {
    id: context.domId,
    layout: context.config.layout,
    density: context.density,
    sender: recipientsOfDraft(draft),
    primary: draftLine(draft),
    unread: false,
    date: toIsoDateTime(draft.updatedAt),
    marks: { attachment: draft.attachments.length > 0 },
    showAccountDot: false,
    cursor: context.cursor,
    hoverActions: context.config.hoverActions,
    rejected: context.rejected,
    ...context.handlers,
  };
}

function submissionProps(submission: Submission, context: ListRowContext): UnpickedProps {
  const at = submission.sentAt ?? submission.notBefore;
  return {
    id: context.domId,
    layout: context.config.layout,
    density: context.density,
    sender: joinNames(submission.toNames.filter(name => name.trim().length > 0)) || 'No recipient',
    primary: submissionLine(submission),
    unread: false,
    date: toIsoDateTime(at),
    showAccountDot: false,
    cursor: context.cursor,
    hoverActions: context.config.hoverActions,
    rejected: context.rejected,
    ...context.handlers,
  };
}

/** When the thread was finished; absent when the engine does not say, so the stamp reads a bare "Done". */
function doneStampOf(row: ThreadRow): ListRowProps['doneAt'] {
  const at = row.workflow.doneAt;
  return at === undefined ? undefined : toIsoDateTime(at);
}

function threadProps(row: ThreadRow, context: ListRowContext): UnpickedProps {
  const { config } = context;
  const base = listRowProps(row, { ...context, layout: config.layout });
  const who = config.kind === 'sent' ? recipientsOfThread(row) : base.sender;
  return {
    ...base,
    sender: who.trim() || 'No sender',
    primary: primaryOf(row),
    hoverActions: config.hoverActions,
    doneAt: config.layout === 'done' ? doneStampOf(row) : undefined,
    laterUntil:
      config.layout === 'later' ? laterUntilOf(row, context.nowMs ?? Date.now()) : undefined,
  };
}

/** Everything `ListRow` needs for one row of this list. */
export function listRowPropsFor(row: ListRowData, context: ListRowContext): ListRowProps {
  const picks = { picked: context.picked ?? false, picking: context.picking ?? false };
  if (isDraft(row)) return { ...draftProps(row, context), ...picks };
  if (isSubmission(row)) return { ...submissionProps(row, context), ...picks };
  return { ...threadProps(row, context), ...picks };
}

/** The cursor target the palette's first line names. */
export function targetOf(row: ListRowData): {
  kind: 'thread' | 'draft';
  id: string;
  title: string;
  detail: string;
} {
  if (isDraft(row)) {
    return { kind: 'draft', id: row.id, title: recipientsOfDraft(row), detail: draftLine(row) };
  }
  if (isSubmission(row)) {
    return {
      kind: 'thread',
      id: row.id,
      title: joinNames(row.toNames),
      detail: submissionLine(row),
    };
  }
  return { kind: 'thread', id: row.id, title: senderOf(row), detail: row.subject };
}
