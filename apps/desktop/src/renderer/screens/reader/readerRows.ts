/**
 * Thread and message rows as the reader's components want them (DESIGN 7.5): the pure mapping from a `ThreadRow`, its
 * `Message`s and the owner's addresses to the props of `ReaderHead`, `ReaderActions` and `ThreadMessage`. Nothing here
 * reads the engine or draws; the screen adds the handlers.
 */
import { type Account, type Address, type Message, type ThreadRow } from '../../data';
import type { ChipProps, SuggestedAction, SummaryContent } from '../../ui/props';
import { cleanName, dueOf, senderOf, suggestionOf, summaryOf } from '../home/homeRows';
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

/** The excerpt a folded card shows: at most this many characters (code points) before it is cut. */
const EXCERPT_LIMIT = 150;

/** A first sentence shorter than this is an abbreviation ("Dr.", "e.g.", "Ok."), not a sentence: keep reading. */
const SENTENCE_MIN = 20;

/** Where a sentence ends: terminal punctuation (with any closing quote) before a space or the end, or CJK 。！？. */
const SENTENCE_END = /[.!?]["')\]]*(?=\s|$)|[。！？]["')\]」』]*/gu;

/** A salutation that opens a message ("Hi Alex,", "Hello Mina and Jordan,", "Dear Ms Park:", "Hey,"): not a sentence. */
const SALUTATION =
  /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^.!?,:\n]{0,40}[,:!]\s+/i;

/** Cut a long excerpt: at a word when one falls in the back half, else hard at the limit, never inside a character. */
function cutLong(excerpt: string): string {
  const chars = Array.from(excerpt);
  if (chars.length <= EXCERPT_LIMIT) return excerpt;
  const room = chars.slice(0, EXCERPT_LIMIT).join('');
  const space = room.lastIndexOf(' ');
  return space >= EXCERPT_LIMIT / 2 ? room.slice(0, space) : room;
}

/** A sentence end: where it is, and whether it is long enough to be one (CJK terminators never are abbreviations). */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    const cjk = /^[。！？]/u.test(match[0]);
    if (cjk || Array.from(text.slice(0, end)).length >= SENTENCE_MIN) ends.push(end);
  }
  return ends;
}

/** Where the excerpt ends in `text`: the first real sentence end, or the second when it fits too. */
function excerptEnd(text: string): number {
  const [first, second] = sentenceEnds(text);
  if (first === undefined) return text.length;
  const fits = second !== undefined && Array.from(text.slice(0, second)).length <= EXCERPT_LIMIT;
  return fits ? second : first;
}

/**
 * A snippet this short was not cut by the provider (Gmail stops near 200 characters, the stand-in at 140), so what it
 * says is the whole message. Longer, the card cannot know, and keeps its chevron.
 */
const SNIPPET_WHOLE = 120;

/**
 * A sign-off after the last sentence ("Jordan", "Thanks, Mina", "Best, Jordan Park"): at most three words and no
 * sentence mark of its own. Like the salutation, it is not part of what the message says.
 */
const SIGN_OFF =
  /^(?:(?:thanks|thank you|best|cheers|regards|best regards|kind regards|warmly|love|talk soon|thx)[,!]?\s+)?\p{L}[\p{L}.'’-]*(?:\s+\p{L}[\p{L}.'’-]*){0,2}$/iu;

/** `text` without a trailing sign-off, when it has a sentence end for the sign-off to follow. */
function withoutSignOff(text: string): string {
  const ends = sentenceEnds(text);
  const last = ends[ends.length - 1];
  if (last === undefined) return text;
  const tail = text.slice(last).trim();
  return tail !== '' && Array.from(tail).length <= 40 && SIGN_OFF.test(tail)
    ? text.slice(0, last)
    : text;
}

/** What a folded card shows, and whether that is the whole message (then the card has nothing to open). */
export interface Excerpt {
  readonly text: string;
  readonly complete: boolean;
}

/**
 * The plain-text excerpt of a folded card (owner review 2026-11-03; owner call 2026-11-14), taken from the message's own
 * snippet so a folded card never loads its body, with the salutation skipped and whitespace collapsed.
 * - A short message with no attachments, whose snippet is surely whole, is shown in full (its sign-off left out, as the
 *   salutation is): `complete`, so the card has no chevron and nothing to open.
 * - Otherwise the first sentence or two, cut at a sentence end when two fit and else at a word (hard at the limit when
 *   there is none). "…" marks that something was left out: after the last whole word when a sentence is cut short, or
 *   after a space when whole sentences were dropped. Nothing left out but a sign-off: no "…".
 * An abbreviation ("Dr.") is not a sentence. A message with no text gives "": the card says "No preview".
 */
export function excerptView(message: Pick<Message, 'snippet' | 'attachments'>): Excerpt {
  const all = message.snippet.replace(/\s+/g, ' ').trim();
  const text = all.replace(SALUTATION, '') || all;
  if (text === '') return { text: '', complete: false };
  const content = withoutSignOff(text).trim();
  const whole =
    (message.attachments?.length ?? 0) === 0 &&
    Array.from(all).length < SNIPPET_WHOLE &&
    Array.from(content).length <= EXCERPT_LIMIT;
  if (whole) return { text: content.replace(/[\s,;:、，]+$/u, ''), complete: true };
  const sentences = text.slice(0, excerptEnd(text));
  const excerpt = cutLong(sentences);
  if (excerpt !== sentences)
    return { text: `${excerpt.replace(/[\s.…,;:。！？、，]+$/u, '')}…`, complete: false };
  const kept = excerpt.replace(/[\s,;:、，]+$/u, '');
  const dropped = withoutSignOff(text).slice(sentences.length).trim() !== '';
  return { text: dropped ? `${kept} …` : kept, complete: false };
}

/** The excerpt's text alone (see `excerptView`). */
export function excerptOf(message: Pick<Message, 'snippet' | 'attachments'>): string {
  return excerptView(message).text;
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

/**
 * What the loading line says it is waiting for: "Loading Maple Library…" (DESIGN 5 rule 10), the subject else the sender.
 * Both go through Home's name cleaning, and the sender is the one Home's row shows (the other person, not the owner).
 */
export function loadingLabel(row: ThreadRow | undefined): string | null {
  if (!row) return null;
  const subject = cleanName(row.subject);
  if (subject) return `Loading ${subject}…`;
  const hasSender =
    cleanName(row.fromName) !== '' || row.participants.some(p => cleanName(p.name || p.address));
  return hasSender ? `Loading ${senderOf(row)}…` : null;
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
