/**
 * Empty and first-sync states for the screen slot (DESIGN 7.14): one small muted mark, one plain sentence, at most one
 * action, no icon in a circle. The wording is the table's; screens other lanes own replace the placeholder with their own content.
 */
import { EmptyLine, ErrorLine } from '../ui/list';
import type { IconName } from '../ui/props';
import { screenLabel } from './nav';
import type { Screen } from './index';

/** DESIGN 7.14's line for each place that can be empty, with its muted mark; no trailing period (owner override 2026-11-05). */
const EMPTY_STATES: Readonly<Record<string, { readonly text: string; readonly icon: IconName }>> = {
  later: { text: 'Nothing set aside for later', icon: 'clock' },
  all: { text: 'No mail here yet', icon: 'tray' },
  done: { text: 'Nothing done yet', icon: 'check-circle' },
  drafts: { text: 'No drafts', icon: 'file' },
  sent: { text: 'Nothing sent yet', icon: 'send' },
  trash: { text: 'Trash is empty', icon: 'trash' },
  spam: { text: 'Spam is empty', icon: 'spam' },
};

/** The sentence for a place's empty state; places another lane builds get a plain "not in this build" line. */
export function emptyText(screen: Screen): string {
  if (typeof screen === 'string' && EMPTY_STATES[screen]) return EMPTY_STATES[screen].text;
  return `${screenLabel(screen)} isn’t in this build yet`;
}

/** The muted mark for a place's empty state; the "not in this build" line has none. */
export function emptyIcon(screen: Screen): IconName | undefined {
  return typeof screen === 'string' ? EMPTY_STATES[screen]?.icon : undefined;
}

/** The placeholder shown for every screen the shell has no content for. */
export function PlaceholderScreen({ screen }: { readonly screen: Screen }) {
  return <EmptyLine placement="pane" text={emptyText(screen)} icon={emptyIcon(screen)} />;
}

/** Props for `FirstSyncLine`. */
export interface FirstSyncLineProps {
  /** The status slot's sentence for the same moment ("Importing 214 of 500"), if it has one. */
  readonly reason?: string;
}

/** Home during first sync (DESIGN 7.14): never inbox zero while an account is still reading its first mail. */
export function FirstSyncLine({ reason }: FirstSyncLineProps) {
  return (
    <EmptyLine placement="pane" icon="mail" text="Your first mail is on its way" detail={reason} />
  );
}

/** Props for `NoAccountsLine`. */
export interface NoAccountsLineProps {
  readonly onAddAccount: () => void;
  readonly onTryDemo: () => void;
}

/** No accounts (DESIGN 7.14): the one filled action plus "Try demo mail". */
export function NoAccountsLine({ onAddAccount, onTryDemo }: NoAccountsLineProps) {
  return (
    <EmptyLine
      placement="pane"
      icon="user"
      text="Add an account to bring in your mail"
      action={{ label: 'Add an account', icon: 'plus', emphasis: 'filled', onSelect: onAddAccount }}
      secondaryAction={{ label: 'Try demo mail', onSelect: onTryDemo }}
    />
  );
}

/** Props for `ListFailedLine`. */
export interface ListFailedLineProps {
  /** Opens the list's view again. The shell has no view of its own to reopen, so the owning screen passes its hook's retry. */
  readonly onRetry?: () => void;
}

function ignoreRetry(): void {
  // No view hook to reopen here (the shell lists nothing itself): the screen that draws this line passes onRetry.
}

/** A mail list whose first load or refresh failed (DESIGN 7.15): the ErrorLine's own sentence, with Try again. */
export function ListFailedLine({ onRetry = ignoreRetry }: ListFailedLineProps) {
  return <ErrorLine kind="listFailed" placement="column" onAction={onRetry} />;
}
