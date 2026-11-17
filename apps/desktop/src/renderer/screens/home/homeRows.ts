/**
 * Thread rows as the list components want them: the pure mapping from a `ThreadRow` to the props of `ListRow` and
 * `FocusLetter` (DESIGN 7.2, 9). Nothing here reads the engine or draws; callers add the handlers.
 */
import { toIsoDateTime, type Account, type ThreadAction, type ThreadRow } from '../../data';
import { accountLabel } from '../../ui/accountLabel';
import type {
  Density,
  DueInfo,
  DueSource,
  IsoDateTime,
  ListRowProps,
  RowAction,
  SuggestedAction,
  SuggestionIcon,
  SummaryContent,
} from '../../ui/props';
import type { SectionKey } from './homeModel';

/** The Later and Done icon buttons that overlay a row's date column on hover (DESIGN 7.2). */
export const ROW_ACTIONS: readonly RowAction[] = [
  { commandId: 'mail.later', icon: 'clock', label: 'Later' },
  { commandId: 'mail.done', icon: 'check', label: 'Done' },
];

/** Settings → General's density, in the components' words. */
export function densityOf(setting: string | undefined): Density {
  if (setting === 'roomy' || setting === 'compact') return setting;
  return 'comfortable';
}

const DUE_SOURCES: readonly DueSource[] = ['user', 'structured', 'ai'];

function dueSourceOf(source: string | undefined): DueSource {
  return DUE_SOURCES.find(known => known === source) ?? 'ai';
}

function localMidnight(date: string): number | null {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day).getTime();
}

/** The due chip: only a date the thread has, overdue or due today flagged from the engine's due band. */
export function dueOf(row: ThreadRow): DueInfo | undefined {
  const date = row.workflow.dueDate;
  const at = date === undefined ? null : localMidnight(date);
  if (at === null) return undefined;
  return {
    at: toIsoDateTime(at),
    overdue: row.rank.dueBand === 0,
    source: dueSourceOf(row.workflow.dueSource),
  };
}

/** The date column: when the thread last moved. */
export function dateOf(row: ThreadRow): IsoDateTime {
  return toIsoDateTime(row.lastDate);
}

/** The subject, or the lists' fixed words when it is empty. */
export function subjectOf(row: ThreadRow): string {
  return row.subject.trim() || 'No subject';
}

/**
 * A name as a row may show it: control characters become spaces, bidi overrides, the soft hyphen and invisible marks are
 * dropped (a spoofing vector), whitespace runs fold. Joiners (U+200C, U+200D) and the direction marks (U+200E, U+200F) stay: emoji families, Persian and mixed-direction names need them.
 */
export function cleanName(text: string | undefined): string {
  return (text ?? '')
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .replace(/[\u00ad\u061c\u200b\u202a-\u202e\u2060-\u2069\ufeff]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_NAMES = 3;

/** "Ada, Ben, Cleo and 2 more": at most three names, then how many are left. */
export function joinNames(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES).join(', ');
  return names.length > MAX_NAMES ? `${shown} and ${names.length - MAX_NAMES} more` : shown;
}

/** The cleaned names (or addresses) of the people who are not the owner, in order, none blank. */
export function otherNames(people: ThreadRow['participants'] | undefined): string[] {
  return (people ?? [])
    .filter(p => p.me !== true)
    .map(p => cleanName(p.name) || cleanName(p.address))
    .filter(name => name !== '');
}

/** What the one sender rule reads; a search row carries only the thread's names, so the lists are optional. */
export type SenderFields = Pick<ThreadRow, 'fromName' | 'subject'> &
  Partial<Pick<ThreadRow, 'participants' | 'recipients'>>;

/**
 * The sender column: the newest sender who is not the owner (the engine's `fromName` is the newest sender, which is the
 * owner whenever they answered last); for a thread the owner wrote entirely, who it went to (`recipients`, the newest
 * message the owner sent), so Follow up names who is being waited on; else the owner's own name, else the subject's
 * first words; never blank.
 */
export function senderOf(row: SenderFields): string {
  const participants = row.participants ?? [];
  const from = cleanName(row.fromName);
  // `fromName` is always `participants[0]`: it is the owner exactly when that participant is marked `me` (never judged
  // by name, so a colleague who shares the owner's display name is still a sender).
  if (from && participants[0]?.me !== true) return from;
  const [other] = otherNames(participants);
  if (other) return other;
  const waitingOn = otherNames(row.recipients ?? []);
  if (waitingOn.length > 0) return joinNames(waitingOn);
  return from || cleanName(row.subject) || 'No sender';
}

/** What the palette's "Run the suggested action" names: "Reply to Jordan Park", "Mark done", "View invoice". */
export function suggestedLabel(suggestion: SuggestedAction, sender: string): string {
  if (suggestion.isDone) return 'Mark done';
  if (suggestion.verb === 'Reply with a nudge') return `Nudge ${sender}`;
  if (suggestion.verb === 'Reply' || suggestion.icon === 'reply') return `Reply to ${sender}`;
  return suggestion.verb;
}

/** Longest sender name a triage toast shows before it is cut with an ellipsis. */
const TOAST_NAME_MAX = 40;
/** A name longer than this crowds the toast, so "no date" gives way: "Set a date" beside it already says so. */
const TOAST_NAME_ROOMY = 28;
const NO_DATE_TAIL = ' · no date';

/** A triage toast names its thread: "Done · Jordan Park", the sender cut with an ellipsis only when very long. */
export function namedToast(message: string, row: ThreadRow): string {
  const name = senderOf(row);
  const short =
    name.length > TOAST_NAME_MAX ? `${name.slice(0, TOAST_NAME_MAX - 1).trimEnd()}…` : name;
  const lead =
    name.length > TOAST_NAME_ROOMY && message.endsWith(NO_DATE_TAIL)
      ? message.slice(0, -NO_DATE_TAIL.length)
      : message;
  return `${lead} · ${short}`;
}

/**
 * The main line of every list row: the subject, always (owner decision 2026-11-16, DECISIONS; DESIGN 7.2). A summary
 * never replaces it; see `secondaryOf`.
 */
export function primaryOf(row: ThreadRow): string {
  return subjectOf(row);
}

/**
 * The muted phrase after the subject: a ready or stale summary's text on one line, else nothing (a pending, failed,
 * none or empty summary leaves the subject alone). Search may still fill the slot with its match snippet.
 */
export function secondaryOf(row: Partial<Pick<ThreadRow, 'summary'>>): string | undefined {
  const { state, text } = row.summary ?? {};
  if (state !== 'ready' && state !== 'stale') return undefined;
  return text?.replace(/\s+/g, ' ').trim() || undefined;
}

/**
 * What the focus letter's summary slot shows: serif when written, the placeholder while it is being made, and the
 * subject alone (the space collapses) when no summary is coming. Pending means pending — the placeholder holds
 * while the engine has live or queued work and the space collapses only when the engine settles the row `failed`
 * (the request failed) or `none` (AI off, no job): never an error on the card (owner rule, hands-on 2026-11-16).
 */
export function summaryOf(row: ThreadRow): SummaryContent {
  const { state, text, provider, local } = row.summary;
  const subject = subjectOf(row);
  if (state === 'pending') return { state: 'pending', subject };
  if ((state === 'ready' || state === 'stale') && text)
    return {
      state: 'ready',
      text,
      subject,
      provenance: { provider: provider ?? '', local: local === true },
    };
  return { state: 'absent', subject };
}

const ICON_FOR_KIND: Readonly<Record<string, SuggestionIcon>> = {
  reply: 'reply',
  link: 'link',
  attachment: 'paperclip',
  calendar: 'calendar',
  read: 'check',
  done: 'check',
  pay: 'cart',
  unsubscribe: 'link',
};

/** The one filled button: the summary's action, or what the section implies (DESIGN 7.2 Space does). */
export function suggestionOf(row: ThreadRow, section: SectionKey): SuggestedAction {
  const action = row.summary.action;
  if (section === 'follow') return { verb: 'Reply with a nudge', icon: 'reply', isDone: false };
  if (action)
    return {
      verb: action.label,
      icon: ICON_FOR_KIND[action.kind] ?? 'reply',
      isDone: action.kind === 'done',
    };
  if (section === 'update') return { verb: 'Done', icon: 'check', isDone: true };
  return { verb: 'Reply', icon: 'reply', isDone: false };
}

/** An account's name for a row's tooltip. Rows carry no account colour (owner decision 2026-11-13). */
export function accountMark(
  accountId: string,
  accounts: readonly Account[],
): { label: string } | undefined {
  const account = accounts.find(candidate => candidate.id === accountId);
  return account ? { label: accountLabel(account) } : undefined;
}

/** The handlers a row needs from its screen. */
export interface RowHandlers {
  readonly onSelect: () => void;
  readonly onOpen: () => void;
  readonly onAction: ListRowProps['onAction'];
}

/** The part of `ListRowProps` the screen decides, not the row. */
export interface RowContext {
  readonly domId: string;
  readonly layout: ListRowProps['layout'];
  readonly density: Density;
  readonly cursor: boolean;
  /** The row is in the bulk pick (it takes the accent wash; no box changes). */
  readonly picked?: boolean;
  /** Some rows are picked, so every row shows its pick mark. */
  readonly picking?: boolean;
  readonly accounts: readonly Account[];
  readonly handlers: RowHandlers;
  readonly rejected?: ListRowProps['rejected'];
}

/** Everything `ListRow` needs for one thread. */
export function listRowProps(row: ThreadRow, context: RowContext): ListRowProps {
  return {
    id: context.domId,
    layout: context.layout,
    density: context.density,
    sender: senderOf(row),
    primary: primaryOf(row),
    secondary: secondaryOf(row),
    unread: row.unread,
    date: dateOf(row),
    due: dueOf(row),
    marks: { bookmarked: row.workflow.bookmarked, attachment: row.hasAttachments },
    account:
      context.accounts.length >= 2 ? accountMark(row.accountId, context.accounts) : undefined,
    cursor: context.cursor,
    picked: context.picked === true,
    picking: context.picking === true,
    hoverActions: ROW_ACTIONS,
    rejected: context.rejected,
    ...context.handlers,
  };
}

/** The failed write as the row's inline error words it: "Couldn't <op>." (DESIGN 7.15). */
export function failurePhrase(action: ThreadAction): string {
  switch (action.type) {
    case 'done':
      return 'mark it done';
    case 'later':
    case 'clearFromHome':
      return 'move to Later';
    case 'trash':
      return 'move to Trash';
    case 'lane':
    case 'laneStep':
      return 'move it';
    default:
      return 'save that';
  }
}
