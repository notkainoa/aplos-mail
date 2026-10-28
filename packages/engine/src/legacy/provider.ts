import type {
  Account,
  Attachment,
  CalendarEvent,
  CalendarInfo,
  Draft,
  Thread,
} from '@aplos/contract/legacy/types';
import type {
  AccountPreset,
  ProviderCapabilities,
  ProviderKind,
  ServerSettings,
} from '@aplos/contract/legacy/provider-types';
export type {
  AccountPreset,
  ProviderCapabilities,
  ProviderKind,
  ServerSettings,
} from '@aplos/contract/legacy/provider-types';

/**
 * Mailbox state owned by the host. Aplos workflow state (Done vs. read, Later, todos) is not part of it.
 *
 * `labels` always uses role names for the special places a thread can be, whatever the host calls them:
 * `INBOX`, `SENT`, `TRASH`, `SPAM`, `ARCHIVE`, `DRAFTS`, plus `UNREAD`, `STARRED`, `IMPORTANT` where the host has them.
 * Other labels or folders keep the host's own name. Merge rules rely on `INBOX` meaning "in the inbox".
 */
export interface ThreadFlags {
  id: string;
  unread: boolean;
  bookmarked: boolean;
  status: 'new' | 'done' | 'trash' | 'spam';
  labels?: string[];
}

export interface SyncResult {
  /** Threads whose messages changed or that are new to this device, fully normalized. */
  threads: Thread[];
  /** Threads whose messages are unchanged but whose flags or folders changed. */
  flags: ThreadFlags[];
  /** Thread IDs that no longer exist at the host. */
  removed: string[];
  /** Opaque position to resume from next time (Gmail historyId, Graph delta links, IMAP MODSEQ, JMAP state). */
  cursor?: string;
  /** True when the provider could not continue from the cursor and returned a fresh window instead. */
  reset: boolean;
}

export interface SyncContext {
  /** Whether this device already stores the thread, so providers can skip refetching unchanged bodies. */
  has(threadId: string): boolean;
}

export interface ConnectRequest {
  provider: ProviderKind;
  email?: string;
  name?: string;
  /** App-specific password (IMAP) or API token (JMAP). Never stored in state. */
  secret?: string;
  preset?: AccountPreset;
  server?: ServerSettings;
  /** JMAP session URL; defaults to the preset's. */
  sessionUrl?: string;
}

/** The part of a local thread a provider needs to change it at the host. */
export type RemoteThread = Pick<Thread, 'remoteId' | 'status' | 'labels'>;

export type { CalendarInfo } from '@aplos/contract/legacy/types';
/** A host's calendar colour as `#rrggbb`; CalDAV servers often add an alpha byte. */
export const calendarColor = (value: unknown) =>
  typeof value === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value.trim())
    ? value.trim().slice(0, 7).toLowerCase()
    : undefined;

/** Login for a calendar server that shares the mail account's credentials (CalDAV with an app password). */
export interface CalendarCredentials {
  url: string;
  username: string;
  password: string;
}

/** Calendar access that mail providers without their own calendar API delegate to (CalDAV). */
export interface CalendarBackend {
  /** Resolves when the server accepts the login; rejects with a ProviderError otherwise. */
  verify(credentials: CalendarCredentials): Promise<void>;
  listCalendars(credentials: CalendarCredentials, account: Account): Promise<CalendarInfo[]>;
  /** Events from 30 days ago to one year ahead across all calendars, recurring events expanded. */
  listEvents(credentials: CalendarCredentials, account: Account): Promise<CalendarEvent[]>;
  saveEvent(
    credentials: CalendarCredentials,
    account: Account,
    event: CalendarEvent,
  ): Promise<CalendarEvent>;
  deleteEvent(
    credentials: CalendarCredentials,
    account: Account,
    event: CalendarEvent,
  ): Promise<void>;
}

/** One stored copy of workflow app data; `id` is the host's identifier for that copy. */
export interface AppDataRecord {
  id: string;
  data: string;
}

/**
 * A small per-account key-value store that providers use for their own indexes (IMAP UIDs, delta links).
 * Writes made while `sync` (or a workflow round) runs are held back and saved in the same transaction
 * as the mail they describe, so a failed or interrupted sync replays from the previous cursor with the
 * previous index. Reads inside that call see its own writes.
 */
export interface ProviderMemory {
  get(accountId: string, key: string): string | undefined;
  set(accountId: string, key: string, value: string | undefined): void;
  clear(accountId: string): void;
}

/** Shared dependencies every provider factory receives. */
export interface ProviderEnvironment<Cipher = Uint8Array> {
  dataDir: string;
  encrypt?: (value: string) => Cipher;
  decrypt?: (value: Cipher) => string;
  openExternal?: (url: string) => Promise<unknown>;
  fetch?: typeof fetch;
  memory?: ProviderMemory;
}

/**
 * One mail host. Thread IDs are `${account.id}:${remoteId}`. Calendar methods exist only when
 * `capabilities.calendar` is true; `'primary'` as a calendar ID means the account's default calendar.
 */
export interface MailProvider {
  readonly kind: ProviderKind;
  /** False when the app lacks configuration for this host (for example an OAuth client ID). */
  readonly available: boolean;
  /** Why the provider is unavailable, in words for the user. */
  readonly unavailableReason?: string;
  capabilities(account?: Account): ProviderCapabilities;
  connect(request: ConnectRequest): Promise<Account>;
  /** Forget credentials and indexes for the account; revoke them at the host when possible. */
  disconnect(accountId: string): Promise<void>;
  sync(account: Account, cursor: string | undefined, context: SyncContext): Promise<SyncResult>;
  search(account: Account, query: string): Promise<Thread[]>;
  updateThread(account: Account, thread: RemoteThread, patch: Partial<Thread>): Promise<void>;
  /** Look up a sent message by its Message-ID after a send whose outcome is unknown. */
  findSent(
    account: Account,
    messageId: string,
  ): Promise<{ id: string; threadId: string } | undefined>;
  /** `thread` is the local thread being replied to or forwarded, when there is one. */
  send(
    account: Account,
    draft: Draft,
    thread?: Thread,
  ): Promise<{ id?: string; threadId?: string }>;
  attachment(account: Account, thread: Thread, attachment: Attachment): Promise<Attachment>;
  getSendAs?(account: Account): Promise<NonNullable<Account['sendAs']>>;
  listCalendars?(account: Account): Promise<CalendarInfo[]>;
  listEvents?(account: Account): Promise<CalendarEvent[]>;
  saveEvent?(account: Account, event: CalendarEvent): Promise<CalendarEvent>;
  deleteEvent?(account: Account, event: CalendarEvent): Promise<void>;
  /**
   * Every copy of the small private blob kept in the account's hidden Aplos storage (workflow sync),
   * newest first. Several copies exist when devices wrote at the same time; callers merge them all.
   * Only records Aplos itself created count: a user folder that happens to share the name is never read.
   */
  readAppData?(account: Account): Promise<AppDataRecord[]>;
  /**
   * Store a new copy, then delete exactly the copies listed in `replaces` (ones the caller read and merged).
   * Anything else in the storage, including a concurrent writer's new copy, stays.
   */
  writeAppData?(account: Account, data: string, replaces: string[]): Promise<void>;
  close(): void | Promise<void>;
}

/**
 * Errors from providers carry an HTTP-like status where one exists. `uncertain` means the request may
 * have reached the host even though no answer came back (network failure, 5xx, dropped connection).
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
