import type {
  Account,
  Attachment,
  Message,
  ProviderCapabilities,
  Thread,
  ThreadFlags,
} from './google';

export interface Token {
  access_token: string;
  refresh_token?: string;
  expiresAt: number;
}
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
}
export interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

export const CAPABILITIES: ProviderCapabilities = {
  labels: true,
  importance: true,
  aliases: true,
  signatures: true,
  calendar: true,
  serverSearch: true,
};
/** App data is one message under a hidden user label, marked by a header so sync can recognise it without the label ID. */
/** Named so it cannot be a label the user made; Gmail search spells spaces as hyphens. */
export const APP_LABEL = 'Aplos Mail Data',
  APP_QUERY = '-label:aplos-mail-data',
  APP_HEADER = 'X-Aplos-Data',
  APP_FILE = 'aplos-data.txt';
export const MAX_APP_DATA = 3_000_000;
export const SEARCH_THREADS = 100;
/** History pages to follow before a fresh window is cheaper than replaying changes. */
export const MAX_HISTORY_PAGES = 20;
export function labelStatus(labels: string[]): ThreadFlags['status'] {
  return labels.includes('TRASH')
    ? 'trash'
    : labels.includes('SPAM')
      ? 'spam'
      : labels.includes('INBOX')
        ? 'new'
        : 'done';
}
export const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const calendar = 'https://www.googleapis.com/calendar/v3';
export const enc = encodeURIComponent;
export const header = (part: GmailPart | undefined, name: string) =>
  part?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
export function address(value: string) {
  const match = value.match(/^(.*?)\s*<([^<>]+)>\s*$/);
  return match
    ? { email: match[2], name: match[1].replace(/^"|"$/g, '').trim() }
    : { email: value.trim(), name: value.split('@')[0] };
}
export function addresses(value: string) {
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map(v => address(v).email)
    .filter(Boolean);
}
export function flatten(part: GmailPart | undefined): GmailPart[] {
  return part ? [part, ...(part.parts ?? []).flatMap(flatten)] : [];
}
export function isBodyPart(part: GmailPart) {
  return (
    !part.filename &&
    !header(part, 'content-id') &&
    !/^attachment(?:;|$)/i.test(header(part, 'content-disposition')) &&
    ['text/plain', 'text/html'].includes(part.mimeType ?? '')
  );
}
export function decode(part: GmailPart) {
  if (!part.body?.data) return '';
  const bytes = Buffer.from(part.body.data, 'base64url');
  const charset =
    header(part, 'content-type').match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}
/** One MIME attachment for nodemailer; a draft attachment whose bytes were never downloaded cannot send. */
export function sendAttachment(a: Attachment) {
  if (!a.data)
    throw new Error(`Attachment "${a.name}" has not been downloaded. Reattach it before sending.`);
  return {
    filename: a.name,
    content: Buffer.from(a.data, 'base64'),
    contentType: a.type,
    cid: a.contentId,
  };
}
export function htmlText(html: string) {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
/** Normalize public Gmail payloads into our independent mailbox model. HTML is sanitized at display. */
export function normalizeGmailThread(raw: GmailThread, account: Account): Thread {
  const items = raw.messages ?? [];
  const messages: Message[] = items
    .map(m => {
      const parts = flatten(m.payload),
        from = address(header(m.payload, 'from'));
      const html = parts
        .filter(p => p.mimeType === 'text/html' && isBodyPart(p))
        .map(decode)
        .join('\n');
      const text =
        parts
          .filter(p => p.mimeType === 'text/plain' && isBodyPart(p))
          .map(decode)
          .join('\n') ||
        htmlText(html) ||
        m.snippet ||
        '';
      const date = new Date(
        Number(m.internalDate) || Date.parse(header(m.payload, 'date')) || Date.now(),
      ).toISOString();
      const internetId = header(m.payload, 'message-id') || undefined,
        references = header(m.payload, 'references') || undefined;
      return {
        id: m.id,
        ...(internetId ? { internetId } : {}),
        ...(references ? { references } : {}),
        from: from.email,
        fromName: from.name,
        to: addresses(header(m.payload, 'to')),
        cc: addresses(header(m.payload, 'cc')),
        date,
        text,
        html: html || undefined,
        sent: m.labelIds?.includes('SENT') ?? false,
        attachments: parts
          .filter(
            p => !isBodyPart(p) && (p.filename || p.body?.attachmentId || header(p, 'content-id')),
          )
          .map((p, i) => ({
            id: `${m.id}:${p.partId ?? i}`,
            name: p.filename || 'attachment',
            type: p.mimeType || 'application/octet-stream',
            size: p.body?.size ?? 0,
            data: p.body?.data
              ? Buffer.from(p.body.data, 'base64url').toString('base64')
              : undefined,
            remoteId: p.body?.attachmentId,
            messageId: m.id,
            contentId: header(p, 'content-id').replace(/^<|>$/g, '') || undefined,
          })),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const labels = [...new Set(items.flatMap(m => m.labelIds ?? []))];
  return {
    id: `${account.id}:${raw.id}`,
    remoteId: raw.id,
    accountId: account.id,
    subject: header(items[0]?.payload, 'subject') || '(No subject)',
    summary: htmlText(items.at(-1)?.snippet ?? '') || messages.at(-1)?.text.slice(0, 200) || '',
    messages,
    date: messages.at(-1)?.date ?? new Date().toISOString(),
    unread: labels.includes('UNREAD'),
    status: labelStatus(labels),
    importance: labels.includes('IMPORTANT') ? 'important' : 'low',
    bookmarked: labels.includes('STARRED'),
    replyStatus: 'none',
    labels,
  };
}
