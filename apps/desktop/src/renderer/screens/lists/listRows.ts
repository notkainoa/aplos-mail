/**
 * Rows as the shared list wants them: the pure mapping from a thread, a draft or a submission to the props of
 * `ListRow` (DESIGN 4.1, 7.4). Thread rows reuse Home's mapping; Drafts rows are Draft rows (recipients and the time
 * they were edited), Sent shows the recipients, Done adds the date-it-was-done stamp. Nothing here reads the engine.
 */
import { toIsoDateTime, type Draft, type Submission, type ThreadRow } from '../../data';
import type { LaterUntil, ListRowProps } from '../../ui/props';
import { cleanName, joinNames, listRowProps, senderOf, type RowContext } from '../home/homeRows';
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

/** A person as a recipient column may name them. */
export interface Who {
  readonly name?: string;
  readonly address?: string;
  readonly me?: boolean;
}

const BARE_ADDRESS = /^[^\s@]+@[^\s@]+$/;

const ANGLE_ADDRESS = /\s*<[^<>]*>\s*$/;
const QUOTES = /^["'\u201c\u2018]+|["'\u201d\u2019]+$/g;

/** A display name as written, with a trailing "<address>" and the quotes around it removed ("Park, Jordan" stays whole). */
function plainName(text: string): string {
  return cleanName(text).replace(ANGLE_ADDRESS, '').replace(QUOTES, '').trim();
}

/** The short form of a name or address: an address gives its local part, a display name stays whole. */
export function shortWho(text: string): string {
  const clean = plainName(text);
  return BARE_ADDRESS.test(clean) ? clean.slice(0, clean.indexOf('@')) : clean;
}

/** The address of a person: their own, else the one a display name carries in angle brackets. */
function addressOf(who: Who): string {
  const own = cleanName(who.address);
  return own || (/<([^<>]*)>\s*$/.exec(cleanName(who.name))?.[1] ?? '').trim();
}

function shortOf(who: Who): string {
  const name = plainName(who.name ?? '');
  const address = addressOf(who);
  // A name that is itself an address, and not this person's own, is kept whole rather than cut to its local part.
  if (BARE_ADDRESS.test(name) && address !== '' && name.toLowerCase() !== address.toLowerCase())
    return name;
  return shortWho(name || address);
}

/** The full form for the tooltip: "Name <address>", or the address, or the name. */
function fullOf(who: Who): string {
  const name = plainName(who.name ?? '');
  const address = addressOf(who);
  if (!name) return address;
  if (!address || name.toLowerCase() === address.toLowerCase()) return name;
  return `${name} <${address}>`;
}

/** A recipients column: "To: name, name and 2 more" with the full addresses for the tooltip. */
export interface RecipientsLine {
  readonly text: string;
  readonly title: string;
  /** The plain joined names, with no "To:" and no addresses (the palette's context line). */
  readonly names: string;
}

/** How many full addresses the tooltip lists before it says "and N more" (a reply-all can hold 500). */
const TITLE_ADDRESSES = 5;

function titleOf(people: readonly Who[]): string {
  const shown = people.slice(0, TITLE_ADDRESSES).map(fullOf).join(', ');
  const more = people.length - TITLE_ADDRESSES;
  return more > 0 ? `To: ${shown} and ${more} more` : `To: ${shown}`;
}

/** The "To: ..." line of Drafts and Sent: display names (or local parts) first, every full address in the tooltip. */
export function recipientsLine(people: readonly Who[]): RecipientsLine | undefined {
  const named = people.filter(who => shortOf(who) !== '');
  if (named.length === 0) return undefined;
  const names = joinNames(named.map(shortOf));
  return { text: `To: ${names}`, title: titleOf(named), names };
}

const NO_RECIPIENT: RecipientsLine = {
  text: 'No recipient',
  title: 'No recipient',
  names: 'No recipient',
};

/** Sent's who column: the people the thread went to (the newest message the owner sent), never the owner. */
export function recipientsOfThread(row: ThreadRow): RecipientsLine {
  const to = (row.recipients ?? []).filter(who => who.me !== true);
  const others = row.participants.filter(who => who.me !== true);
  const line = recipientsLine(to) ?? recipientsLine(others);
  if (line) return line;
  const sender = senderOf(row);
  return { text: sender, title: sender, names: sender };
}

/** A draft's who column: its recipients, or "No recipient" for a draft with none yet. */
export function recipientsOfDraft(draft: Draft): RecipientsLine {
  return recipientsLine(draft.to) ?? NO_RECIPIENT;
}

/** A submission's who column. */
function recipientsOfSubmission(submission: Submission): RecipientsLine {
  const names = submission.toNames.map(name => ({ name }));
  return recipientsLine(names) ?? NO_RECIPIENT;
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

/**
 * When a thread was finished: the engine's `doneAt` when it says one, else the thread's last message (the real engine
 * does not stamp it yet, and a row never reads as "Done" with no date or lumps under Today).
 */
export function doneMsOf(row: ThreadRow): number {
  return row.workflow.doneAt ?? row.lastDate;
}

/** The moment a row sorts and groups by: last activity, or when it was finished in Done. */
export function dateMsOf(row: ListRowData, field: ListConfig['dateField']): number | undefined {
  if (isDraft(row)) return row.updatedAt;
  if (isSubmission(row)) return row.sentAt ?? row.notBefore;
  return field === 'doneAt' ? doneMsOf(row) : row.lastDate;
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
  const who = recipientsOfDraft(draft);
  return {
    id: context.domId,
    layout: context.config.layout,
    density: context.density,
    sender: who.text,
    senderTitle: who.title,
    tag: 'Draft',
    primary: draftLine(draft),
    unread: false,
    date: toIsoDateTime(draft.updatedAt),
    marks: { attachment: draft.attachments.length > 0 },
    cursor: context.cursor,
    hoverActions: context.config.hoverActions,
    rejected: context.rejected,
    ...context.handlers,
  };
}

function submissionProps(submission: Submission, context: ListRowContext): UnpickedProps {
  const at = submission.sentAt ?? submission.notBefore;
  const who = recipientsOfSubmission(submission);
  return {
    id: context.domId,
    layout: context.config.layout,
    density: context.density,
    sender: who.text,
    senderTitle: who.title,
    primary: submissionLine(submission),
    unread: false,
    date: toIsoDateTime(at),
    cursor: context.cursor,
    hoverActions: context.config.hoverActions,
    rejected: context.rejected,
    ...context.handlers,
  };
}

/** When the thread was finished, for the Done stamp column. */
function doneStampOf(row: ThreadRow): ListRowProps['doneAt'] {
  return toIsoDateTime(doneMsOf(row));
}

/** True when the stamp is the last message's date, not a finish time the engine reported. */
function doneIsEstimated(row: ThreadRow): boolean {
  return row.workflow.doneAt === undefined;
}

function threadProps(row: ThreadRow, context: ListRowContext): UnpickedProps {
  const { config } = context;
  const base = listRowProps(row, { ...context, layout: config.layout });
  const sent = config.kind === 'sent' ? recipientsOfThread(row) : undefined;
  return {
    ...base,
    sender: (sent?.text ?? base.sender).trim() || 'No sender',
    senderTitle: sent?.title,
    hoverActions: config.hoverActions,
    doneAt: config.layout === 'done' ? doneStampOf(row) : undefined,
    doneEstimated: config.layout === 'done' ? doneIsEstimated(row) : undefined,
    laterUntil:
      config.layout === 'later' ? laterUntilOf(row, context.nowMs ?? Date.now()) : undefined,
  };
}

/** Everything `ListRow` needs for one row of this list. */
export function listRowPropsFor(row: ListRowData, context: ListRowContext): ListRowProps {
  const picks = {
    picked: context.picked ?? false,
    picking: context.picking ?? false,
    dayGrouped: context.config.dateGroups,
  };
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
    return {
      kind: 'draft',
      id: row.id,
      title: recipientsOfDraft(row).names,
      detail: draftLine(row),
    };
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
