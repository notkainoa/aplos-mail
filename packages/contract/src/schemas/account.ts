import * as z from 'zod/mini';
import { AccountHealthSchema, ReasonCodeSchema } from '../status';
import { Count, EpochMs, Id, line, openEnum, text } from './common';

/** Mail adapters (Providers port proposal section 2); `demo` accounts hold original demo data only. CalDAV is a calendar on an imap or jmap account. */
export const ProviderKind = openEnum(['google', 'microsoft', 'imap', 'jmap', 'demo']);
/** Add-account presets that fill server settings and copy (round 2 beyond `gmail`). */
export const AccountPreset = openEnum([
  'gmail',
  'outlook',
  'icloud',
  'yahoo',
  'aol',
  'fastmail',
  'generic',
]);

/**
 * What the account's host supports, from the grant and server capabilities, never from names (ARCH 5.1). Every frozen
 * flag has to make sense for Gmail, Graph, IMAP, JMAP and CalDAV unchanged.
 */
export const AccountCapabilities = z.object({
  /** A message can carry several labels at once (Gmail); otherwise each lives in one folder. */
  labels: z.boolean(),
  folders: z.boolean(),
  /** Drafts sync to the provider (Gmail, IMAP APPEND, JMAP, Graph). */
  drafts: z.boolean(),
  /** The host can search mail Aplos has not downloaded (`Search/remote`). */
  serverSearch: z.boolean(),
  calendar: z.boolean(),
  /** Block and skip-Inbox rules become provider filters that act while the Mac sleeps. */
  filters: z.boolean(),
  push: z.boolean(),
  /** Extra sending addresses come from the host. */
  sendAs: z.boolean(),
  unsubscribeHeaders: z.boolean(),
  /** The host has an importance marker Aplos can set (Gmail IMPORTANT). */
  importance: z.optional(z.boolean()),
  /** The host shows partial folders (Yahoo limited mode). */
  partialView: z.optional(z.boolean()),
  /** Threads come from the host (Gmail, Graph conversations, JMAP) or from headers (IMAP), as the F3 `Capabilities` say. */
  threading: z.optional(openEnum(['native', 'headers'])),
});
export type AccountCapabilities = z.infer<typeof AccountCapabilities>;

/** A sending identity: the account address or a provider alias. */
export const SendIdentity = z.object({
  address: line(320),
  name: z.optional(line(200)),
  signatureHtml: z.optional(text(20_000)),
  default: z.boolean(),
});

/** The primary-device lease (ARCH 6.5): only the primary runs backfill, prefetch, background AI and compaction. */
export const Lease = z.object({
  role: openEnum(['primary', 'secondary']),
  holderDeviceId: z.optional(line(200)),
  /** "Background work runs on: MacBook Pro". */
  holderDeviceName: z.optional(line(200)),
  until: z.optional(EpochMs),
  /** The owner pressed "Use this Mac": this device claims the lease whenever it is awake. */
  pinned: z.optional(z.boolean()),
});

/** Non-secret IMAP/SMTP settings (round 2); a password never appears in any contract type. */
export const ServerSettings = z.object({
  imap: z.object({
    host: line(253),
    port: z.int().check(z.minimum(1), z.maximum(65_535)),
    secure: z.boolean(),
  }),
  smtp: z.object({
    host: line(253),
    port: z.int().check(z.minimum(1), z.maximum(65_535)),
    secure: z.boolean(),
  }),
  username: z.optional(line(320)),
  caldav: z.optional(text(2_000)),
});

export const Account = z.object({
  id: Id,
  rev: Count,
  provider: ProviderKind,
  address: line(320),
  name: line(200),
  /** A colour token name from DESIGN 4.2, chosen by the owner or the stable hash. */
  colorTag: z.optional(line(40)),
  demo: z.boolean(),
  health: AccountHealthSchema,
  capabilities: AccountCapabilities,
  grantedScopes: z.array(z.string()),
  /** Features that lack a permission while mail still works (calendar, filters), each with its copy key. */
  missingPermissions: z.optional(
    z.array(
      z.object({
        capability: line(60),
        reasonCode: ReasonCodeSchema,
        missingScopes: z.optional(z.array(z.string())),
      }),
    ),
  ),
  /** "Use this account's mail for AI" (ARCH 8.3). */
  aiAllowed: z.boolean(),
  notifications: z.boolean(),
  lease: z.optional(Lease),
  identities: z.array(SendIdentity),
  /** Gmail's daily send limit: sending is refused until then (ARCH 6.3 `send_limit`). */
  sendBlockedUntil: z.optional(EpochMs),
  /** The first window (the newest ~50 Inbox threads) is in: notifications and background AI may start (AM-4). Absent while first sync reads it. */
  baselineDoneAt: z.optional(EpochMs),
  /**
   * When the account's calendar list was first read from the provider, even if it held no calendars. Absent until then:
   * a calendar-capable account without it is still syncing its list; with it and no calendars, there are none.
   */
  calendarListedAt: z.optional(EpochMs),
  /** Changes made here that have not reached the provider yet ("Offline · 2 changes waiting", "Saved here · will sync"). */
  pendingChanges: Count,
  preset: z.optional(AccountPreset),
  server: z.optional(ServerSettings),
  createdAt: EpochMs,
});
export type Account = z.infer<typeof Account>;

/** Labels and folders share one type, as they share one table (ARCH 3.2). */
export const Folder = z.object({
  id: Id,
  accountId: Id,
  name: line(500),
  role: z.optional(
    openEnum([
      'inbox',
      'sent',
      'drafts',
      'trash',
      'spam',
      'archive',
      'starred',
      'important',
      'all',
    ]),
  ),
  kind: openEnum(['label', 'folder', 'system']),
  hidden: z.boolean(),
  colorTag: z.optional(line(40)),
  /** Threads, not messages (ARCH 3.2 "counts count threads"). */
  unread: Count,
  total: z.optional(Count),
});
export type Folder = z.infer<typeof Folder>;

/** Sidebar numbers. Home counts Do now plus Important updates (DESIGN decision 19). */
export const CountsBlock = z.object({
  home: Count,
  do: Count,
  update: Count,
  follow: Count,
  laterDue: Count,
  drafts: Count,
  scheduled: Count,
  unread: Count,
  /** Threads moved off Home today (Done, Later, Trash, Spam) in the owner's local day; undo subtracts. "You handled 12 emails." */
  handledToday: Count,
});
export const Counts = z.object({
  all: CountsBlock,
  accounts: z.record(z.string(), CountsBlock),
  /** Unread threads per folder id. */
  folders: z.record(z.string(), Count),
});
export type Counts = z.infer<typeof Counts>;

/** A connect, reconnect or permission grant in progress; its outcome arrives as `connect` frames. */
export const ConnectStart = z.object({ connectId: Id });
export const ConnectMode = openEnum(['new', 'reconnect', 'grantPermissions']);
export const ConnectState = openEnum(['waiting', 'connected', 'failed', 'cancelled']);
