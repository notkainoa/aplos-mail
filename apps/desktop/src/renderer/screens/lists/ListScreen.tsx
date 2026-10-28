/**
 * All mail, Drafts, Sent, Trash, Spam and labels (DESIGN 7.4): one list component. Arrows move the cursor and archive
 * nothing; Return opens through `onOpen`; Trash and Spam own Restore, Not spam and delete forever behind a Confirm.
 * Every key is the registry's.
 */
import type { AccountId } from '../../data';
import { configFor, type ListWhich } from './listKinds';
import { useListKeys } from './listCommands';
import { MailListView } from './MailListView';
import { useMailList } from './useMailList';
import type { OpenKind } from './listRows';

/** Props for `ListScreen`. */
export interface ListScreenProps {
  /** Which list: 'all', 'drafts', 'sent', 'trash', 'spam', or `{label: folderId}`. */
  readonly which: ListWhich;
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
  /** Open a thread (reader), a draft (composer) or a submission. */
  readonly onOpen?: (id: string, kind: OpenKind) => void;
  /** Permanent deletion for Trash and Spam; absent until the contract has it. */
  readonly deleteForever?: (ids: readonly string[]) => Promise<unknown>;
}

export function ListScreen({ which, ...options }: ListScreenProps) {
  const list = useMailList(configFor(which), options);
  useListKeys(list.actions);
  return <MailListView list={list} />;
}
