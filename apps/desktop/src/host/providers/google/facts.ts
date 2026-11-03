import type {
  Address,
  FolderFacts,
  FolderRole,
  MessageFacts,
  MessageFlags,
} from '@aplos/engine/ports';
import { listAuthenticated } from './list-auth';
import { headerOf, type GmailHeader, type GmailPart } from './mime';

/**
 * Gmail JSON -> the engine's facts. Pure functions: no I/O, no clock. Labels become placements, UNREAD and STARRED
 * become flags, DRAFT is a flag (drafts never become thread rows, D9), and snippets are entity-decoded once (D22).
 */

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  historyId?: string;
  payload?: GmailPart;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: 'system' | 'user';
  labelListVisibility?: string;
}

/**
 * ARCH 5.1's nine headers, plus List-Unsubscribe-Post (one-click unsubscribe), List-Id, and Reply-To, In-Reply-To and
 * References, which `MessageFacts` carries for threading, and Authentication-Results and DKIM-Signature, from which
 * `list-auth.ts` derives `list.authenticated` (RFC 8058 section 4). Same price either way: metadata costs per call, not
 * per header.
 */
export const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Subject',
  'Date',
  'Message-ID',
  'List-Unsubscribe',
  'Precedence',
  'Auto-Submitted',
  'List-Unsubscribe-Post',
  'List-Id',
  'Reply-To',
  'In-Reply-To',
  'References',
  'Authentication-Results',
  'DKIM-Signature',
] as const;

/** Labels that are flags, not places. */
export const FLAG_LABELS: ReadonlySet<string> = new Set(['UNREAD', 'STARRED', 'DRAFT']);

const SYSTEM_ROLES: Record<string, FolderRole> = {
  INBOX: 'inbox',
  SENT: 'sent',
  DRAFT: 'drafts',
  TRASH: 'trash',
  SPAM: 'spam',
  STARRED: 'starred',
  IMPORTANT: 'important',
  CATEGORY_PERSONAL: 'category.personal',
  CATEGORY_SOCIAL: 'category.social',
  CATEGORY_PROMOTIONS: 'category.promotions',
  CATEGORY_UPDATES: 'category.updates',
  CATEGORY_FORUMS: 'category.forums',
};

// ---- text helpers ----

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodes HTML character references exactly once (`&amp;#39;` stays `&#39;`); unknown ones stay as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** RFC 2047 encoded words (`=?UTF-8?B?...?=`, `=?ISO-8859-1?Q?...?=`), which Gmail returns undecoded in metadata. */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, '$1')
    .replace(
      /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
      (whole, charset: string, enc: string, data: string) => {
        try {
          const bytes =
            enc.toLowerCase() === 'b'
              ? Buffer.from(data, 'base64')
              : Buffer.from(
                  data
                    .replace(/_/g, ' ')
                    .replace(/=([0-9a-f]{2})/gi, (_m, hex: string) =>
                      String.fromCharCode(parseInt(hex, 16)),
                    ),
                  'latin1',
                );
          return new TextDecoder(charset.split('*')[0]).decode(bytes);
        } catch {
          return whole;
        }
      },
    );
}

/**
 * Splits an address list at commas outside quotes, angle brackets and comments. RFC 5322 groups
 * (`Team: a@x, b@y;`, `undisclosed-recipients:;`) contribute their members: the group name before
 * an unquoted `:` and the `;` that closes the group are dropped.
 */
function splitList(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && quoted) {
      current += c + (value[++i] ?? '');
      continue;
    }
    if (c === '"' && !comment) quoted = !quoted;
    else if (!quoted && c === '<') angle++;
    else if (!quoted && c === '>') angle = Math.max(0, angle - 1);
    else if (!quoted && c === '(') comment++;
    else if (!quoted && c === ')') comment = Math.max(0, comment - 1);
    const outside = !quoted && !angle && !comment;
    if (outside && (c === ',' || c === ';')) {
      out.push(current);
      current = '';
    } else if (outside && c === ':') current = '';
    else current += c;
  }
  out.push(current);
  return out.map(s => s.trim()).filter(Boolean);
}

/**
 * Splits first and decodes each display name after: an RFC 2047 word may encode a comma (`=?UTF-8?Q?Doe=2C_Jane?=`),
 * which must stay inside the name rather than split the list.
 */
export function parseAddresses(value: string | undefined): Address[] {
  if (!value) return [];
  const out: Address[] = [];
  for (const entry of splitList(value)) {
    const angle = /^(.*)<([^<>]*)>\s*$/.exec(entry);
    if (angle) {
      const name = decodeWords(
        angle[1]
          .trim()
          .replace(/^"(.*)"$/, '$1')
          .replace(/\\(.)/g, '$1')
          .trim(),
      ).trim();
      const address = angle[2].trim();
      if (address) out.push(name ? { address, name } : { address });
      continue;
    }
    const bare = entry.replace(/\(.*?\)/g, '').trim();
    if (bare.includes('@')) out.push({ address: bare });
  }
  return out;
}

const stripAngle = (id: string) => id.trim().replace(/^<|>$/g, '');

function messageIds(value: string | undefined): string[] {
  return value ? (value.match(/<[^<>]+>/g) ?? []).map(stripAngle) : [];
}

// ---- facts ----

export interface FactsOptions {
  /** The account's own address, for `fromMe`. */
  self: string;
  /** Metadata-only rows are partial until the thread is opened. */
  partial: boolean;
  threadSize?: number;
}

export function flagsOf(
  labels: readonly string[],
  from: Address | undefined,
  self: string,
): MessageFlags {
  return {
    seen: !labels.includes('UNREAD'),
    flagged: labels.includes('STARRED'),
    draft: labels.includes('DRAFT'),
    fromMe: labels.includes('SENT') || from?.address.toLowerCase() === self.toLowerCase(),
  };
}

/**
 * The header's value only when the message has it exactly once. Two copies of a sender-controlled header (one possibly
 * outside what the signature covers) are ambiguous, so neither is trusted: List-Unsubscribe-Post then reads as absent
 * and one-click stays off.
 */
function once(headers: readonly GmailHeader[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers.filter(h => h.name.toLowerCase() === wanted).length === 1
    ? headerOf(headers, name)
    : undefined;
}

export function messageFacts(message: GmailMessage, options: FactsOptions): MessageFacts {
  const headers: GmailHeader[] = message.payload?.headers ?? [];
  const get = (name: string) => headerOf(headers, name);
  const labels = message.labelIds ?? [];
  const fromList = parseAddresses(get('From'));
  const from = fromList[0];
  const internalDate = Number(message.internalDate ?? 0);
  const dateHeader = get('Date');
  const parsedDate = dateHeader ? Date.parse(dateHeader) : NaN;
  const subject = get('Subject');
  const internetId = get('Message-ID');
  const inReplyTo = messageIds(get('In-Reply-To'))[0];
  const references = messageIds(get('References'));
  const replyTo = parseAddresses(get('Reply-To'));
  const listUnsubscribe = get('List-Unsubscribe');
  // The verdict is about List-Unsubscribe, so it is sent only with one; absent means unknown.
  const authenticated =
    listUnsubscribe === undefined ? undefined : listAuthenticated(headers, fromList);
  const list = {
    ...optional('listUnsubscribe', listUnsubscribe),
    ...optional('listUnsubscribePost', once(headers, 'List-Unsubscribe-Post')),
    ...optional('listId', get('List-Id')),
    ...optional('precedence', get('Precedence')),
    ...optional('autoSubmitted', get('Auto-Submitted')),
    ...(authenticated === undefined ? {} : { authenticated }),
  };
  return {
    remoteId: message.id,
    remoteThreadId: message.threadId,
    ...(internetId ? { internetId: stripAngle(internetId) } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references.length ? { references } : {}),
    ...(from ? { from } : {}),
    to: parseAddresses(get('To')),
    cc: parseAddresses(get('Cc')),
    ...(replyTo.length ? { replyTo } : {}),
    ...(subject !== undefined ? { subject: decodeWords(subject) } : {}),
    ...(message.snippet !== undefined ? { snippet: decodeEntities(message.snippet) } : {}),
    date: Number.isNaN(parsedDate) ? internalDate : parsedDate,
    internalDate,
    ...(message.sizeEstimate !== undefined ? { size: message.sizeEstimate } : {}),
    flags: flagsOf(labels, from, options.self),
    placements: labels.filter(l => !FLAG_LABELS.has(l)).map(folder => ({ folder })),
    list,
    partial: options.partial,
    ...(options.threadSize !== undefined ? { threadSize: options.threadSize } : {}),
  };
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** `labels.list` -> folders. UNREAD is a flag with no folder of its own; CHAT is never shown. */
export function folderFacts(labels: readonly GmailLabel[]): FolderFacts[] {
  return labels
    .filter(l => l.id !== 'UNREAD' && l.id !== 'CHAT')
    .map(l => {
      const system = l.type === 'system';
      const role = SYSTEM_ROLES[l.id];
      return {
        remoteId: l.id,
        name: l.name,
        ...(role ? { role } : {}),
        kind: system ? 'system' : 'label',
        ...(l.labelListVisibility === 'labelHide' ? { hidden: true } : {}),
      } satisfies FolderFacts;
    });
}
