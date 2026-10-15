import type { Account, Attachment, Draft, Thread } from '../shared/types';

/** Mailbox state owned by the host. Aplos workflow state (Done vs. read, Later, todos) is not part of it. */
export interface ThreadFlags {
  id:string;
  unread:boolean;
  bookmarked:boolean;
  status:'new'|'done'|'trash'|'spam';
  labels?:string[];
}

export interface SyncResult {
  /** Threads whose messages changed or that are new to this device, fully normalized. */
  threads:Thread[];
  /** Threads whose messages are unchanged but whose flags or folders changed. */
  flags:ThreadFlags[];
  /** Thread IDs that no longer exist at the host. */
  removed:string[];
  /** Opaque position to resume from next time (Gmail historyId, Graph delta link, IMAP MODSEQ...). */
  cursor?:string;
  /** True when the provider could not continue from the cursor and returned a fresh window instead. */
  reset:boolean;
}

export interface SyncContext {
  /** Whether this device already stores the thread, so providers can skip refetching unchanged bodies. */
  has(threadId:string):boolean;
}

export interface MailProvider {
  sync(account:Account, cursor:string|undefined, context:SyncContext):Promise<SyncResult>;
  search(account:Account, query:string):Promise<Thread[]>;
  updateThread(account:Account, thread:Thread, patch:Partial<Thread>):Promise<void>;
  send(account:Account, draft:Draft):Promise<{id?:string;threadId?:string}>;
  attachment(account:Account, thread:Thread, attachment:Attachment):Promise<Attachment>;
}
