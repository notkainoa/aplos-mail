/**
 * The shared list's non-row states (DESIGN 7.14, 6 Confirm): the empty sentence, the first-sync line while mail is
 * still arriving, and the two destructive confirmations. One plain sentence, at most one action, no illustration.
 */
import { openCompose } from '../../shell';
import { FirstSyncLine } from '../../shell/states';
import { EmptyLine, ErrorLine } from '../../ui/list';
import type { CommandId, IconName } from '../../ui/props';
import { Confirm } from '../../ui/surfaces';
import type { Confirmation } from './listActions';
import { useReopen } from './Reopenable';
import type { EmptyState } from './useMailList';

/** Props for `ListEmpty`. */
export interface ListEmptyProps {
  /** The list's empty sentence (its config's `empty`). */
  readonly text: string;
  /** The place's muted mark (its config's `emptyIcon`). */
  readonly icon?: IconName;
  /** The quieter second line (its config's `emptyDetail`), if any. */
  readonly detail?: string;
  /** The one text action (its config's `emptyAction`), if any. */
  readonly action?: { readonly label: string; readonly commandId: CommandId };
  readonly state: EmptyState;
}

/** The line a list shows when it holds nothing, centred in the pane. */
export function ListEmpty({ text, icon, detail, action, state }: ListEmptyProps) {
  if (state.settling) return <FirstSyncLine reason={state.reason} />;
  // The same hierarchy as a search with no match: the sentence, then one quiet text action.
  return (
    <EmptyLine
      placement="pane"
      text={text}
      icon={icon}
      detail={detail}
      action={
        action ? { ...action, emphasis: 'quiet', onSelect: () => openCompose({}) } : undefined
      }
    />
  );
}

/**
 * The line a list shows when its view failed with nothing to show: the ErrorLine's own sentence (DESIGN 7.15) with Try
 * again, which reopens the view (`Reopenable`).
 */
/**
 * Why a window ended, in the owner-visible contract classes: a sign-in or scope problem gets the sentence that
 * says what to do; an unbuilt or unloaded view says it plainly; anything else is the generic list failure.
 */
function listFailedWhy(type: string | undefined): string | undefined {
  switch (type) {
    case 'needsReauth':
    case 'permission':
      return 'Google needs you to sign in again before it can show this list. Reconnect the account and try again.';
    case 'unsupported':
    case 'unavailable':
    case 'notImplemented':
      return 'This list isn’t available in this build yet.';
    default:
      return undefined;
  }
}

export function ListFailed({ errorType }: { errorType?: string } = {}) {
  const reopen = useReopen();
  const why = listFailedWhy(errorType);
  if (why)
    return <ErrorLine kind="reason" text={why} retryable placement="column" onAction={reopen} />;
  return <ErrorLine kind="listFailed" placement="column" onAction={reopen} />;
}

/** The words of each confirmation: what happens and whether it can be undone (DESIGN 10). */
export const CONFIRM_COPY = {
  deleteForever: {
    question: 'Delete this email forever?',
    consequence: 'It can’t be restored.',
    confirmLabel: 'Delete forever',
  },
  discardDraft: {
    question: 'Discard this draft?',
    consequence: 'It is deleted from every device. This can’t be undone.',
    confirmLabel: 'Discard',
  },
} as const;

/** "1 email" or "3 emails". */
function emailsOf(count: number): string {
  return count === 1 ? '1 email' : `${count} emails`;
}

/** The words of a confirmation, naming how many when it was asked over several rows. */
export function confirmCopyOf(confirmation: Confirmation) {
  const count = confirmation.count ?? confirmation.ids.length;
  if (confirmation.kind === 'trashPicked') {
    return {
      question: `Move ${emailsOf(count)} to Trash?`,
      consequence: 'You can restore them from Trash.',
      confirmLabel: 'Move to Trash',
    };
  }
  const copy = CONFIRM_COPY[confirmation.kind];
  if (count === 1) return copy;
  const question =
    confirmation.kind === 'deleteForever'
      ? `Delete ${emailsOf(count)} forever?`
      : `Discard ${count} drafts?`;
  return { ...copy, question };
}

/** The destructive confirmation: Cancel is the default row, and confirming needs Shift Return. */
export function ListConfirm(props: {
  readonly confirmation: Confirmation;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const copy = confirmCopyOf(props.confirmation);
  return (
    <Confirm
      {...copy}
      destructive
      presentation="dialog"
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}
