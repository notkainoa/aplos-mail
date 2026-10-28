/**
 * Home's empty states (DESIGN 7.14): no accounts, the first sync still reading mail, and inbox zero. The wording is the
 * shell's (`shell/states`); inbox zero adds "Undo last · Z" when there is something to undo. Inbox zero is never shown
 * while an account is still importing or paused, because Home is not really empty then.
 */
import { api, undoStack } from '../../data';
import { navigate } from '../../shell';
import { FirstSyncLine, NoAccountsLine } from '../../shell/states';
import { EmptyLine } from '../../ui/list';

/** "You handled 12 emails." (DESIGN 7.14). */
export function handledLine(handledToday: number): string {
  return `You handled ${handledToday} ${handledToday === 1 ? 'email' : 'emails'}.`;
}

/** Props for `HomeEmpty`. */
export interface HomeEmptyProps {
  readonly accountCount: number;
  /** An account is still reading its first mail, or sync is paused. */
  readonly settling: boolean;
  /** The status slot's sentence for the same moment. */
  readonly reason?: string;
  readonly handledToday: number;
  /** There is a change Z can undo. */
  readonly canUndo: boolean;
}

function tryDemo(): void {
  void api.demo.load({}).catch(() => undefined);
}

function undoLast(): void {
  undoStack.undoLast();
}

/** The line Home shows instead of the list. */
export function HomeEmpty({
  accountCount,
  settling,
  reason,
  handledToday,
  canUndo,
}: HomeEmptyProps) {
  if (accountCount === 0)
    return <NoAccountsLine onAddAccount={() => navigate('settings')} onTryDemo={tryDemo} />;
  if (settling) return <FirstSyncLine reason={reason} />;
  return (
    <EmptyLine
      size="display"
      text={handledLine(handledToday)}
      action={
        canUndo
          ? { label: 'Undo last', commandId: 'app.undo', emphasis: 'text', onSelect: undoLast }
          : undefined
      }
    />
  );
}
