/**
 * Thread rows as the list components want them: the pure mapping from a `ThreadRow` to the props of `ListRow` and
 * `FocusLetter` (DESIGN 7.2, 9). Nothing here reads the engine or draws; callers add the handlers.
 */
import { toIsoDateTime, type Account, type ThreadAction, type ThreadRow } from '../../data';
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
  TagColor,
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

/** The sender column: the newest sender, or the subject's first words when the row has no name; never blank. */
export function senderOf(row: ThreadRow): string {
  const name = row.fromName || row.participants.find(p => !p.me)?.name || row.subject;
  return name.trim() || 'No sender';
}

/** The main line of a row: the summary when it is ready, otherwise the subject (DESIGN 7.2 "No AI"). */
export function primaryOf(row: ThreadRow): string {
  const { state, text } = row.summary;
  return (
    ((state === 'ready' || state === 'stale') && text ? text : row.subject).trim() || 'No subject'
  );
}

/** What the focus letter's summary slot shows: serif when written, the subject in SF otherwise. */
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

const ACCOUNT_COLORS: readonly TagColor[] = ['sky', 'hill', 'dusk', 'sand', 'ember', 'stamp'];

/** An account's dot: its name, and a colour from its tag when it names one of the six, else by position. */
export function accountMark(
  accountId: string,
  accounts: readonly Account[],
): { label: string; color: TagColor } | undefined {
  const index = accounts.findIndex(account => account.id === accountId);
  const account = accounts[index];
  if (!account) return undefined;
  const tagged = ACCOUNT_COLORS.find(color => color === account.colorTag);
  return {
    label: account.name || account.address,
    color: tagged ?? ACCOUNT_COLORS[index % ACCOUNT_COLORS.length] ?? 'sky',
  };
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
  readonly accounts: readonly Account[];
  readonly handlers: RowHandlers;
  readonly rejected?: ListRowProps['rejected'];
}

/** Everything `ListRow` needs for one thread. */
export function listRowProps(row: ThreadRow, context: RowContext): ListRowProps {
  const showAccountDot = context.accounts.length >= 2;
  return {
    id: context.domId,
    layout: context.layout,
    density: context.density,
    sender: senderOf(row),
    primary: primaryOf(row),
    unread: row.unread,
    date: dateOf(row),
    due: dueOf(row),
    marks: { bookmarked: row.workflow.bookmarked, attachment: row.hasAttachments },
    account: showAccountDot ? accountMark(row.accountId, context.accounts) : undefined,
    showAccountDot,
    cursor: context.cursor,
    picked: false,
    picking: false,
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
