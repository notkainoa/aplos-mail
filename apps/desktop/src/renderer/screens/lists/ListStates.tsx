/**
 * The shared list's non-row states (DESIGN 7.14, 6 Confirm): the empty sentence, the first-sync line while mail is
 * still arriving, and the two destructive confirmations. One plain sentence, at most one action, no illustration.
 */
import { FirstSyncLine } from '../../shell/states';
import { EmptyLine, ErrorLine } from '../../ui/list';
import { Confirm } from '../../ui/surfaces';
import type { Confirmation } from './listActions';
import { useReopen } from './Reopenable';
import type { EmptyState } from './useMailList';

/** The line a list shows when it holds nothing. */
export function ListEmpty({ text, state }: { readonly text: string; readonly state: EmptyState }) {
  if (state.settling) return <FirstSyncLine reason={state.reason} />;
  return <EmptyLine text={text} />;
}

/**
 * The line a list shows when its view failed with nothing to show: the ErrorLine's own sentence (DESIGN 7.15) with Try
 * again, which reopens the view (`Reopenable`).
 */
export function ListFailed() {
  const reopen = useReopen();
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

/** The destructive confirmation: Cancel is the default row, and confirming needs Shift Return. */
export function ListConfirm(props: {
  readonly confirmation: Confirmation;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const copy = CONFIRM_COPY[props.confirmation.kind];
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
