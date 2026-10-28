import * as z from 'zod/mini';
import { ErrorBodySchema } from '../errors';
import { Address, bool, choice, Count, EpochMs, Id, Ids, line, LocalDate, OpId, openEnum, State, text } from './common';

/** Home's lanes: respond, see or skip (ARCH 8.2, DESIGN 7.2). Follow up is computed, never stored. */
export const Lane = openEnum(['do', 'update', 'low']);
export const Importance = openEnum(['important', 'normal']);
/** Who set a thread's lane, in rising order of authority: a rule or the user always wins over AI and heuristics. */
export const RankSource = openEnum(['heuristic', 'ai', 'rule', 'user']);
/** Trust order of a due date's source; a lower one never overwrites a higher one. */
export const DueSource = openEnum(['user', 'structured', 'ai']);

/** App-owned workflow facts, synced between Macs on the encrypted channel, never mixed into provider facts (ARCH 3.2). */
export const WorkflowState = z.object({
  status: openEnum(['new', 'done', 'later']),
  /** Epoch ms a Later item returns; absent with `later` means Someday. */
  laterUntil: z.optional(EpochMs),
  dueDate: z.optional(LocalDate),
  dueSource: z.optional(DueSource),
  reminderAt: z.optional(EpochMs),
  reminderFiredAt: z.optional(EpochMs),
  /** The reminder only fires if nobody has replied by then ("Remind me if no reply"). */
  reminderIfNoReply: z.optional(z.boolean()),
  bookmarked: z.boolean(),
  replyStatus: z.optional(openEnum(['none', 'needsReply', 'awaitingReply'])),
  todo: z.optional(text(2_000)),
  hiddenFromHome: z.boolean(),
  doneAt: z.optional(EpochMs),
  editedAt: z.optional(EpochMs),
});
export type WorkflowState = z.infer<typeof WorkflowState>;

export const Rank = z.object({
  lane: Lane,
  importance: Importance,
  source: RankSource,
  /** 0 overdue or due today, 1 tomorrow, 2 within 7 days, 3 later or undated; refreshed at local midnight. */
  dueBand: z.int().check(z.minimum(0), z.maximum(3)),
  rankedAt: z.optional(EpochMs),
});

/** One preset next step, rendered as a proposal that needs a keystroke (ARCH 8.5). Model output is data, never a tool call. */
export const SuggestedAction = z.object({
  kind: openEnum(['reply', 'link', 'attachment', 'calendar', 'read', 'done', 'pay', 'unsubscribe']),
  label: line(200),
  url: z.optional(text(2_000)),
  attachmentId: z.optional(Id),
  planId: z.optional(Id),
  prompt: z.optional(text(2_000)),
});
export type SuggestedAction = z.infer<typeof SuggestedAction>;

/** The summary as a list row carries it; the full record is `Summary` (schemas/ai.ts). */
export const SummaryRef = z.object({
  state: openEnum(['none', 'pending', 'ready', 'stale', 'failed']),
  text: z.optional(text(10_000)),
  provider: z.optional(line(60)),
  model: z.optional(line(200)),
  action: z.optional(SuggestedAction),
});

export const Participant = z.object({ name: z.optional(line(200)), address: z.optional(line(320)), me: z.optional(z.boolean()) });

/**
 * A body-free list row (ARCH 9.1). Windows push ids only; clients `Thread/get` unknown or stale rows (`rev` changed).
 * `partial` is true while the row was built from one metadata message and the thread's size is unknown (ARCH 5.1,
 * plan 20 section 2), so the UI never shows "1 message" for a twelve-message thread.
 */
export const ThreadRow = z.object({
  id: Id,
  accountId: Id,
  rev: Count,
  subject: text(2_000),
  snippet: text(1_000),
  /** The newest sender's display name, for the palette context line and search rows. */
  fromName: line(200),
  participants: z.array(Participant).check(z.maxLength(6)),
  lastDate: EpochMs,
  lastInboundDate: z.optional(EpochMs),
  messageCount: Count,
  unreadCount: Count,
  partial: z.boolean(),
  unread: z.boolean(),
  /** Starred or flagged at the provider. */
  flagged: z.boolean(),
  hasAttachments: z.boolean(),
  /** Folder ids (labels or the folder) the thread sits in, from messages not in Trash or Spam (ARCH 3.2, D8). */
  labels: z.array(Id),
  workflow: WorkflowState,
  rank: Rank,
  summary: SummaryRef,
  /** The thread can be unsubscribed from (`Unsubscribe/get` gives the method). */
  unsubscribe: z.optional(z.boolean()),
  /** Follow up: the user sent the last message at `since` and no reply has come (ARCH 8.2). */
  follow: z.optional(z.object({ since: EpochMs, suggestion: z.optional(z.boolean()) })),
  /** A calendar invitation in this thread. */
  eventId: z.optional(Id),
});
export type ThreadRow = z.infer<typeof ThreadRow>;

export const AttachmentMeta = z.object({
  id: Id,
  name: line(500),
  mime: line(200),
  size: Count,
  inline: z.boolean(),
  contentId: z.optional(line(200)),
  state: openEnum(['absent', 'fetching', 'present', 'evicted', 'failed']),
});

export const Message = z.object({
  id: Id,
  threadId: Id,
  accountId: Id,
  rev: Count,
  internetId: z.optional(line(1_000)),
  from: z.optional(Address),
  to: z.array(Address),
  cc: z.array(Address),
  bcc: z.optional(z.array(Address)),
  replyTo: z.optional(z.array(Address)),
  subject: text(2_000),
  snippet: text(1_000),
  date: EpochMs,
  seen: z.boolean(),
  flagged: z.boolean(),
  answered: z.boolean(),
  fromMe: z.boolean(),
  labels: z.array(Id),
  attachments: z.array(AttachmentMeta),
  /** The lazy-body marker: bodies are fetched on open or prefetch and may be evicted after 90 days (ARCH 3.6). */
  bodyState: openEnum(['absent', 'fetching', 'present', 'evicted', 'failed']),
  bodyKind: z.optional(openEnum(['html', 'text'])),
  inReplyTo: z.optional(line(1_000)),
  references: z.optional(z.array(line(1_000))),
});
export type Message = z.infer<typeof Message>;

/**
 * The readable form of a body. HTML mail is shown only through `Mail/frame`, never inserted into the app's own DOM;
 * `text` is the plain-text rendering for plain mail (the host escapes it) and for quoting in a reply.
 */
export const MessageBody = z.object({
  messageId: Id,
  bodyKind: openEnum(['html', 'text', 'none']),
  text: text(5_000_000),
  /** Character ranges of quoted history in `text`. */
  quoted: z.array(z.object({ start: Count, end: Count })),
  quotedCount: Count,
  hasRemoteImages: z.boolean(),
});
export type MessageBody = z.infer<typeof MessageBody>;

/** `Mail/frame`'s answer (plan 30 section 8.1 item 4): the token is the URL's path segment, `aplos-mail://m/<token>`. */
export const MailFrame = z.object({
  url: text(500),
  expiresAt: EpochMs,
  bodyKind: openEnum(['html', 'text']),
  trackersRemoved: Count,
  hasRemoteImages: z.boolean(),
  quotedCount: Count,
});
export type MailFrame = z.infer<typeof MailFrame>;

/** What `Thread/act` can do, one discriminated union so each action names its own fields. Input: closed. */
export const ThreadAction = z.discriminatedUnion('type', [
  /** Done, then the account's `doneAction` (archive, mark read or unread). Done on mail needing a reply leaves Home. */
  z.object({ type: z.literal('done') }),
  /** Back to Home / Inbox (H in the Done place; Restore in Trash and Spam). */
  z.object({ type: z.literal('restore') }),
  /** Later until a time, or Someday without one. */
  z.object({ type: z.literal('later'), until: z.optional(EpochMs) }),
  z.object({ type: z.literal('trash') }),
  z.object({ type: z.literal('spam') }),
  z.object({ type: z.literal('read') }),
  z.object({ type: z.literal('unread') }),
  z.object({ type: z.literal('flag'), on: bool() }),
  z.object({ type: z.literal('bookmark'), on: bool() }),
  /** Set or clear (absent) the user's due date. */
  z.object({ type: z.literal('due'), date: z.optional(LocalDate) }),
  z.object({ type: z.literal('reminder'), at: z.optional(EpochMs), ifNoReply: z.optional(bool()) }),
  /** ⌥↑ / ⌥↓, or a lane chosen in "Why it's here"; stored with `rank_source='user'`. */
  z.object({ type: z.literal('lane'), lane: choice(['do', 'update', 'low']) }),
  z.object({ type: z.literal('laneStep'), direction: choice(['up', 'down']) }),
  z.object({ type: z.literal('importance'), importance: choice(['important', 'normal']) }),
  z.object({ type: z.literal('replyStatus'), status: choice(['none', 'needsReply', 'awaitingReply']) }),
  z.object({ type: z.literal('todo'), text: z.optional(text(2_000)) }),
  /** Hide from Home or show there again (today's `home.hide`). "Clear from Home" on Back from Later is `later` instead. */
  z.object({ type: z.literal('home'), hidden: bool() }),
  z.object({ type: z.literal('labels'), add: Ids(100), remove: Ids(100) }),
]);
export type ThreadAction = z.infer<typeof ThreadAction>;

/** A command's lifecycle after its receipt: failures return the row to its place with an inline error and Retry (DESIGN 5 rule 11). */
export const Operation = z.object({
  opId: OpId,
  kind: line(60),
  targets: z.array(Id),
  state: openEnum(['applied', 'queued', 'syncing', 'synced', 'failed', 'conflict', 'cancelled']),
  appliedState: State,
  error: z.optional(ErrorBodySchema),
  undoable: z.boolean(),
  undoUntil: z.optional(EpochMs),
  createdAt: EpochMs,
});
export type Operation = z.infer<typeof Operation>;

/**
 * Parsed search, so the UI's operator tokens and the engine agree. `text` is the free words; operators are structured.
 * The parser is not part of the contract (the contract holds no behaviour beyond validation).
 */
export const SearchQuery = z.object({
  text: text(2_000),
  from: z.optional(line(320)),
  to: z.optional(line(320)),
  subject: z.optional(line(500)),
  hasAttachment: z.optional(bool()),
  before: z.optional(LocalDate),
  after: z.optional(LocalDate),
  /** A place: a folder role, `done`, `later`, or a folder id. */
  in: z.optional(line(200)),
  is: z.optional(z.array(choice(['unread', 'read', 'flagged', 'bookmarked'])).check(z.maxLength(4))),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

const account = { accountId: z.optional(Id) };
const homeSection = choice(['do', 'update', 'low', 'follow']);

/**
 * What a window shows (ARCH 9.2; plan 30 section 4.1). `accountId` absent means every account. The engine owns the SQL;
 * each kind names its row type in the window frame. Input: closed, so an older engine refuses a kind it cannot serve.
 */
export const ViewSpec = z.discriminatedUnion('kind', [
  /** Home in order: Do now (with Back from Later at its bottom), Important updates, then Follow up; the Low band as a section with its count only. */
  z.object({ kind: z.literal('home'), ...account }),
  /** One Home section in full, e.g. the Low importance sheet's threads. */
  z.object({ kind: z.literal('homeSection'), section: homeSection, ...account }),
  /** The Low importance sheet grouped by sender: rows are `SenderGroup`s. */
  z.object({ kind: z.literal('lowSenders'), ...account }),
  /** Go one by one: a frozen order taken when the window opens, so items never reshuffle while you work through them. */
  z.object({ kind: z.literal('oneByOne'), section: homeSection, ...account }),
  /** Inbox, All mail, Sent, Trash, Spam, Archive, Starred by folder role. */
  z.object({ kind: z.literal('mailbox'), role: choice(['inbox', 'all', 'sent', 'trash', 'spam', 'archive', 'starred', 'important']), ...account }),
  z.object({ kind: z.literal('label'), folderId: Id }),
  /** Later in groups Overdue, Today, This week, Someday. */
  z.object({ kind: z.literal('later'), ...account }),
  z.object({ kind: z.literal('bookmarks'), ...account }),
  /** Threads by reply state: waiting on you, or on others (today's Needs reply and Awaiting reply views). */
  z.object({ kind: z.literal('replyState'), status: choice(['needsReply', 'awaitingReply']), ...account }),
  /** The Done place, newest done first. */
  z.object({ kind: z.literal('done'), ...account }),
  /** Drafts are `Draft` rows, never threads (D9). */
  z.object({ kind: z.literal('drafts'), ...account }),
  /** Queued and scheduled sends: `Submission` rows. */
  z.object({ kind: z.literal('scheduled'), ...account }),
  /** Local search as you type; server results join this window after `Search/remote`. */
  z.object({ kind: z.literal('search'), query: SearchQuery, ...account }),
  /** The reader: a thread's messages, oldest first. */
  z.object({ kind: z.literal('thread'), threadId: Id }),
  /** Calendar occurrences in a range of at most 62 days, not capped at 200 rows (else `rangeTooLarge`). */
  z.object({ kind: z.literal('events'), from: EpochMs, to: EpochMs, calendarIds: z.optional(Ids(200)), includeDeclined: z.optional(bool()), includePlans: z.optional(bool()) }),
  /** Plans found in mail and not yet confirmed or dismissed. */
  z.object({ kind: z.literal('plans'), threadId: z.optional(Id) }),
  /** Ask history, newest first. */
  z.object({ kind: z.literal('conversations') }),
]);
export type ViewSpec = z.infer<typeof ViewSpec>;

/** The row type a window's ids refer to, so a client knows which `T/get` to call. */
export const RowType = openEnum(['Thread', 'Message', 'Draft', 'Submission', 'Event', 'Plan', 'Conversation', 'SenderGroup']);

/** A Low importance sender, the sheet's row. */
export const SenderGroup = z.object({ id: Id, address: line(320), name: z.optional(line(200)), count: Count, latestThreadId: Id, unsubscribe: z.boolean() });

/** A labelled run of a window: Home's sections, Later's groups, date groups. */
export const WindowSection = z.object({
  key: line(60),
  /** Index of the section's first row in the full ordered list. */
  start: Count,
  count: Count,
  /** For the Low band: up to three sender names for "Field Notes, Cedar Market, Google and 3 more". */
  senders: z.optional(z.array(line(200)).check(z.maxLength(3))),
});

/** Where a window should start: an absolute position, or relative to a known row (keyset, never OFFSET in SQL). */
export const WindowAnchor = z.object({ id: z.optional(Id), offset: z.optional(z.int()), position: z.optional(Count) });

/** The body of every `window` frame and of `View/watch`, `View/move` and `View/query` answers. */
export const WindowBody = z.object({
  windowId: Id,
  state: State,
  rowType: RowType,
  /** At most 200 ids, starting at `position` (events windows excepted). */
  ids: z.array(Id),
  position: Count,
  total: Count,
  /** Ids whose rows changed (`rev` moved) since the last frame of this window. */
  changed: z.optional(z.array(Id)),
  sections: z.optional(z.array(WindowSection)),
  /** Rows the engine kept in place because they are held (`holdIds`, `View/hold`). */
  held: z.optional(z.array(Id)),
});
export type WindowBody = z.infer<typeof WindowBody>;
