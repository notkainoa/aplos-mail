/**
 * The Done place (DESIGN 7.4): mail you finished. Rows show the date they were finished in a fixed stamp column (a quiet check, then the date), the one hover
 * action is an icon-only "Move to Home" (H) to the stamp's left, and E and L do nothing here. Moving a row back is an
 * operation with Undo. Every key is the registry's.
 */
import type { AccountId } from '../../data';
import { DONE_CONFIG } from '../lists/listKinds';
import type { OpenKind } from '../lists/listRows';
import { MailListView } from '../lists/MailListView';
import { Reopenable } from '../lists/Reopenable';
import { useMailList } from '../lists/useMailList';
import { useDoneKeys } from './doneCommands';

/** Props for `DoneScreen`. */
export interface DoneScreenProps {
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
  /** Open a thread in the reader (the reader lane owns it; absent until it lands). */
  readonly onOpen?: (id: string, kind: OpenKind, listIds?: readonly string[]) => void;
}

function DoneBody(props: DoneScreenProps) {
  const list = useMailList(DONE_CONFIG, { ...props, returnKey: 'done' });
  useDoneKeys(list.actions);
  return <MailListView list={list} />;
}

export function DoneScreen(props: DoneScreenProps) {
  return (
    <Reopenable>
      <DoneBody {...props} />
    </Reopenable>
  );
}
