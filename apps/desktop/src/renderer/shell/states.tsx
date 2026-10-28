/**
 * Empty and first-sync states for the screen slot (DESIGN 7.14): one plain sentence, at most one action, no icon in a
 * circle. The wording is the table's; screens other lanes own replace the placeholder with their own content.
 */
import { EmptyLine } from '../ui/list';
import { screenLabel } from './nav';
import type { Screen } from './index';

/** DESIGN 7.14's line for each place that can be empty. */
const EMPTY_COPY: Readonly<Record<string, string>> = {
  later: 'Nothing set aside for later.',
  all: 'No mail here yet.',
  done: 'Nothing done yet.',
  drafts: 'No drafts.',
  sent: 'Nothing sent yet.',
  trash: 'Trash is empty.',
  spam: 'Spam is empty.',
};

/** The sentence for a place's empty state; places another lane builds get a plain "not in this build" line. */
export function emptyText(screen: Screen): string {
  if (typeof screen === 'string' && EMPTY_COPY[screen]) return EMPTY_COPY[screen];
  return `${screenLabel(screen)} isn’t in this build yet.`;
}

/** The placeholder shown for every screen the shell has no content for. */
export function PlaceholderScreen({ screen }: { readonly screen: Screen }) {
  return <EmptyLine text={emptyText(screen)} />;
}

/** Props for `FirstSyncLine`. */
export interface FirstSyncLineProps {
  /** The status slot's sentence for the same moment ("Importing 214 of 500"), if it has one. */
  readonly reason?: string;
}

/** Home during first sync (DESIGN 7.14): never inbox zero while an account is still reading its first mail. */
export function FirstSyncLine({ reason }: FirstSyncLineProps) {
  return <EmptyLine text="Your first mail is on its way." detail={reason} />;
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
      text="Add an account to bring in your mail."
      action={{ label: 'Add an account', icon: 'plus', emphasis: 'filled', onSelect: onAddAccount }}
      secondaryAction={{ label: 'Try demo mail', onSelect: onTryDemo }}
    />
  );
}
