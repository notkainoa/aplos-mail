/**
 * Thread and message rows as the reader's components want them (DESIGN 7.5): the pure mapping from a `ThreadRow`, its
 * `Message`s and the owner's addresses to the props of `ReaderHead`, `ReaderActions` and `ThreadMessage`. Nothing here
 * reads the engine or draws; the screen adds the handlers.
 */
import { type Account, type Address, type Message, type ThreadRow } from '../../data';
import type { ChipProps, SuggestedAction, SummaryContent } from '../../ui/props';
import { dueOf, suggestionOf, summaryOf } from '../home/homeRows';
import type { SectionKey } from '../home/homeModel';
import { attachmentIcon } from './attachmentIcon';

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

/** The first name in "Reply to Jordan…": the sender, or whom the owner last wrote to; never empty. */
export function replyName(message: Message, me: ReadonlySet<string>): string {
  const other = message.fromMe
    ? recipientsOf(message).find(a => !isMe(a, me))
    : (message.from ?? recipientsOf(message).find(a => !isMe(a, me)));
  return other ? firstNameOf(nameOf(other)) : 'sender';
}

/** The excerpt a folded card shows: at most this many characters before it is cut at a word. */
const EXCERPT_LIMIT = 150;

/** Where a sentence ends: terminal punctuation (with any closing quote) followed by a space. */
const SENTENCE_END = /[.!?]["')\]]*(?=\s|$)/g;

/** A salutation that opens a message ("Hi Alex,", "Hello Mina and Jordan,", "Dear Ms Park:", "Hey,"): not a sentence. */
const SALUTATION =
  /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^.!?,:\n]{0,40}[,:!]\s+/i;

/**
 * The plain-text excerpt of a folded card (owner review 2026-11-03): the first sentence or two of the message after
 * its salutation, whitespace collapsed, cut at a sentence end when two fit and at a word when a sentence runs long,
 * and always ending in "…". Taken from the message's own snippet, so a folded card never loads its body.
 */
export function excerptOf(message: Pick<Message, 'snippet'>): string {
  const all = message.snippet.replace(/\s+/g, ' ').trim();
  const text = all.replace(SALUTATION, '') || all;
  const ends = [...text.matchAll(SENTENCE_END)].map(m => (m.index ?? 0) + m[0].length);
  let end = ends[0] ?? text.length;
  const second = ends[1];
  if (second !== undefined && second <= EXCERPT_LIMIT) end = second;
  let excerpt = text.slice(0, end);
  if (excerpt.length > EXCERPT_LIMIT) {
    const room = excerpt.slice(0, EXCERPT_LIMIT);
    excerpt = room.slice(0, Math.max(room.lastIndexOf(' '), 1));
  }
  return `${excerpt.replace(/[\s.…,;:]+$/u, '')}…`;
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

/**
 * "3 trackers removed"; null when none were, or when the frame did not say (`undefined`). It counts tracking pixels
 * only: a remote image that the "Images blocked" button holds back is not a tracker.
 */
export function trackersLine(trackers: number | undefined): string | null {
  if (trackers === undefined || trackers <= 0) return null;
  return `${trackers} ${trackers === 1 ? 'tracker' : 'trackers'} removed`;
}

/** What the loading line says it is waiting for: "Loading Maple Library…" (DESIGN 5 rule 10), the subject else the sender. */
export function loadingLabel(row: ThreadRow | undefined): string | null {
  const name = row?.subject.trim() || row?.fromName?.trim();
  return name ? `Loading ${name}…` : null;
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
    .map(meta => {
      const state = stateOf(meta, local.get(`${message.id}:${meta.id}`));
      // A chip that is already downloading ignores Open and Retry: a second fetch would only race the first.
      const start = () => {
        if (state !== 'downloading') open(meta.id);
      };
      return {
        kind: 'attachment',
        name: meta.name,
        sizeBytes: meta.size,
        state,
        icon: attachmentIcon(meta.name, meta.mime),
        onOpen: start,
        onRetry: start,
      };
    });
}
