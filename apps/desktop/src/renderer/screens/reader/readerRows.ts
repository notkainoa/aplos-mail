/**
 * Thread and message rows as the reader's components want them (DESIGN 7.5): the pure mapping from a `ThreadRow`, its
 * `Message`s and the owner's addresses to the props of `ReaderHead`, `EarlierMessages` and `ThreadMessage`. Nothing here
 * reads the engine or draws; the screen adds the handlers.
 */
import {
  toIsoDateTime,
  type Account,
  type Address,
  type Message,
  type ThreadRow,
} from '../../data';
import type {
  ChipProps,
  CollapsedMessage,
  SenderInfo,
  SuggestedAction,
  SummaryContent,
} from '../../ui/props';
import { dueOf, subjectOf, suggestionOf, summaryOf } from '../home/homeRows';
import type { SectionKey } from '../home/homeModel';

export { dueOf };

/** Lower-cased addresses that are the owner's: the thread's `me` participants and the receiving account. */
export function myAddresses(row: ThreadRow, accounts: readonly Account[]): ReadonlySet<string> {
  const mine = new Set<string>();
  for (const p of row.participants) if (p.me && p.address) mine.add(p.address.toLowerCase());
  const account = accounts.find(a => a.id === row.accountId);
  if (account) mine.add(account.address.toLowerCase());
  return mine;
}

function isMe(address: Address, me: ReadonlySet<string>): boolean {
  return me.has(address.address.toLowerCase());
}

/** A person's name, or their address when they have none. */
export function nameOf(address: Address): string {
  return address.name?.trim() || address.address;
}

/** The first word of a name: "Jordan Park" is "Jordan"; an address stays whole. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function displayName(address: Address, me: ReadonlySet<string>): string {
  return isMe(address, me) ? 'you' : nameOf(address);
}

/** "you and Mina Cho", "you, Mina Cho and Dan Lee", "you, Mina Cho, Dan Lee and 2 others" (more than four); "no one" when empty. */
export function joinRecipients(names: readonly string[]): string {
  if (names.length === 0) return 'no one';
  if (names.length === 1) return names[0] ?? 'no one';
  if (names.length > 4) return `${names.slice(0, 3).join(', ')} and ${names.length - 3} others`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function recipientsOf(message: Message): readonly Address[] {
  return [...message.to, ...message.cc];
}

/** The owner first, then the others in order. */
function orderedNames(message: Message, me: ReadonlySet<string>): string[] {
  const all = recipientsOf(message);
  const names = all.map(a => displayName(a, me));
  return [...names.filter(n => n === 'you'), ...names.filter(n => n !== 'you')];
}

/** The sender line's dim phrase: "to you and Mina Cho". */
export function recipientsLabel(message: Message, me: ReadonlySet<string>): string {
  return `to ${joinRecipients(orderedNames(message, me))}`;
}

/** A message header's dim phrase: "to you, Mina Cho". */
export function toLabel(message: Message, me: ReadonlySet<string>): string {
  const names = orderedNames(message, me);
  return `to ${names.length > 0 ? names.join(', ') : 'no one'}`;
}

/** Who wrote a message: "You" for the owner. */
export function fromName(message: Message, me: ReadonlySet<string>): string {
  if (message.fromMe || (message.from && isMe(message.from, me))) return 'You';
  return message.from ? nameOf(message.from) : 'No sender';
}

/** The sender line's name and the details hover (address, account). */
export function senderInfo(
  message: Message,
  me: ReadonlySet<string>,
  accountLabel: string,
): SenderInfo {
  return {
    name: fromName(message, me),
    address: message.from?.address ?? '',
    accountLabel,
  };
}

/** The first name in "Reply to Jordan…": the sender, or whom the owner last wrote to; never empty. */
export function replyName(message: Message, me: ReadonlySet<string>): string {
  const other = message.fromMe
    ? recipientsOf(message).find(a => !isMe(a, me))
    : (message.from ?? recipientsOf(message).find(a => !isMe(a, me)));
  return other ? firstNameOf(nameOf(other)) : 'sender';
}

/** One earlier message as a one-liner. */
export function collapsedOf(message: Message, me: ReadonlySet<string>): CollapsedMessage {
  return {
    id: message.id,
    from: fromName(message, me),
    preview: message.snippet.trim(),
    date: toIsoDateTime(message.date),
  };
}

/** First names in thread order, "you" for the owner, once each. */
export function participantsOf(
  messages: readonly Message[],
  me: ReadonlySet<string>,
): readonly string[] {
  const names: string[] = [];
  for (const message of messages) {
    const name = fromName(message, me);
    const short = name === 'You' ? 'you' : firstNameOf(name);
    if (!names.includes(short)) names.push(short);
  }
  return names;
}

/** The section DESIGN 7.2 would file the thread under, for its suggestion (Home's rule). */
export function sectionOf(row: ThreadRow): SectionKey {
  if (row.follow) return 'follow';
  return row.rank.lane === 'do' ? 'do' : 'update';
}

/** The summary slot: serif when written, the subject in SF otherwise. */
export function summaryFor(row: ThreadRow): SummaryContent {
  return summaryOf(row);
}

/** The filled suggestion. */
export function suggestionFor(row: ThreadRow): SuggestedAction {
  return suggestionOf(row, sectionOf(row));
}

/** The dim line above the thread: "A quieter home for the site · 4 messages". */
export function subjectLine(row: ThreadRow, count: number): string {
  const noun = count === 1 ? 'message' : 'messages';
  return `${subjectOf(row)} · ${count} ${noun}`;
}

/** "3 trackers removed"; null when none were. */
export function trackersLine(blocked: number): string | null {
  if (blocked <= 0) return null;
  return `${blocked} ${blocked === 1 ? 'tracker' : 'trackers'} removed`;
}

/** What a download of one attachment is doing in this reading. */
export type DownloadState = 'downloading' | 'failed' | 'ready';

type AttachmentChip = Extract<ChipProps, { kind: 'attachment' }>;

function stateOf(meta: Message['attachments'][number], local: DownloadState | undefined) {
  if (local) return local;
  if (meta.state === 'failed') return 'failed';
  return meta.state === 'fetching' ? 'downloading' : 'ready';
}

/** The chips under a message: file attachments only (inline images belong to the body). */
export function attachmentChips(
  message: Message,
  local: ReadonlyMap<string, DownloadState>,
  open: (attachmentId: string) => void,
): readonly AttachmentChip[] {
  return message.attachments
    .filter(meta => !meta.inline)
    .map(meta => ({
      kind: 'attachment',
      name: meta.name,
      sizeBytes: meta.size,
      state: stateOf(meta, local.get(`${message.id}:${meta.id}`)),
      onOpen: () => open(meta.id),
      onRetry: () => open(meta.id),
    }));
}
