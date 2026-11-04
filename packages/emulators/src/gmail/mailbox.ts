import type { Clock } from '../kit/clock';
import { ApiError, badRequest, notFound } from './errors';
import { HistoryLog, type HistoryMessage } from './history';
import {
  addressesIn,
  bodyText,
  buildRfc822,
  collectLeaves,
  headerValue,
  makeSnippet,
  parseRfc822,
  toPayload,
  withDefaultHeaders,
  withoutHeaders,
  type BuildAttachment,
  type GmailPart,
  type MimeHeader,
} from './mime';
import {
  matchesQuery,
  mentionsSpamTrash,
  normalizeLabelName,
  parseQuery,
  type QueryTarget,
} from './query';
import { Random } from './rng';

const SYSTEM_LABEL_IDS = [
  'INBOX',
  'SENT',
  'DRAFT',
  'TRASH',
  'SPAM',
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'CHAT',
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
];

export interface MailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
  messageListVisibility?: string;
  labelListVisibility?: string;
}

export interface GmailFilter {
  id: string;
  criteria: Record<string, unknown>;
  action: Record<string, unknown>;
}

export interface SendAsAlias {
  sendAsEmail: string;
  displayName: string;
  isDefault: boolean;
  isPrimary: boolean;
  treatAsAlias: boolean;
  verificationStatus: string;
}

/** Everything a test needs to build a message "made elsewhere" (Gmail web, a phone). */
export interface MessageSpec {
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  labelIds?: string[];
  /** Join this thread; otherwise `replyTo` or the headers decide, else a new thread starts. */
  threadId?: string;
  /** Internal id of a message in this mailbox to answer: sets threadId, In-Reply-To and References. */
  replyTo?: string;
  internalDate?: number;
  messageId?: string;
  headers?: Record<string, string>;
  attachments?: BuildAttachment[];
  /** Store the HTML body as an attachmentId-only part. */
  htmlAsAttachment?: boolean;
}

export interface MessageView {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  historyId: string;
  subject: string;
  from: string;
  to: string;
  messageId: string;
  snippet: string;
}

interface StoredMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  historyId: number;
  raw: Buffer;
  payload: GmailPart;
  snippet: string;
  attachments: Map<string, Buffer>;
  subject: string;
  from: string;
  toRaw: string;
  meta: Omit<QueryTarget, 'labelIds' | 'labelNames'>;
}

export interface Keyed {
  date: number;
  id: string;
}

export interface ThreadSummary extends Keyed {
  snippet: string;
  historyId: string;
}

export type MessageFormat = 'minimal' | 'metadata' | 'full' | 'raw';

export interface MailboxOptions {
  clock: Clock;
  emailAddress: string;
  seed: number;
  /** Milliseconds history stays valid, or a function so a live setting can change it. Default 7 days. */
  historyRetentionMs?: number | (() => number);
  /** How a draft saved through the API is changed, read at each save (see `GmailEmulatorOptions.draftIdentity`). */
  draftIdentity?: () => { rewriteMessageId: boolean; dropHeaders: readonly string[] };
  /** Whether `messages.send` replaces the Message-ID the client wrote (see `GmailEmulatorOptions.sendIdentity`). */
  rewriteSentMessageId?: () => boolean;
}

/** Names Gmail keeps for itself; labels.create refuses them in any letter case [observed]. */
const RESERVED_LABEL_NAMES = new Set([
  ...SYSTEM_LABEL_IDS.map(id => id.toLowerCase()),
  'drafts',
  'chats',
  'all mail',
  'scheduled',
  'snoozed',
]);

/** How an explicit threadId is honoured. */
type ThreadRule = 'api' | 'fixture';

interface InsertOptions {
  labelIds?: string[];
  threadId?: string;
  internalDate?: number;
  htmlAsAttachment?: boolean;
  /**
   * 'api' (send, insert, drafts): an explicit threadId only takes when the subject matches, as the
   * sending guide requires ("The Subject headers must match"); otherwise a new thread starts.
   * 'fixture' (test helpers, the default): the threadId is always honoured.
   */
  threadRule?: ThreadRule;
}

const stripAngle = (id: string): string => id.trim().replace(/^<|>$/g, '');
const baseSubject = (subject: string): string =>
  subject
    .toLowerCase()
    .replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/, '')
    .trim();

export class Mailbox {
  readonly emailAddress: string;
  readonly history: HistoryLog;
  private readonly clock: Clock;
  private readonly random: Random;
  private readonly messages = new Map<string, StoredMessage>();
  private readonly threads = new Map<string, string[]>();
  private readonly byMessageId = new Map<string, string>();
  private readonly labels = new Map<string, MailLabel>();
  private readonly drafts = new Map<string, string>();
  private readonly filters = new Map<string, GmailFilter>();
  private readonly aliases: SendAsAlias[];
  private nextUserLabel = 1;
  private boundaries = 0;

  constructor(options: MailboxOptions) {
    this.clock = options.clock;
    this.draftIdentity = options.draftIdentity;
    this.rewriteSentMessageId = options.rewriteSentMessageId;
    this.emailAddress = options.emailAddress;
    this.random = new Random(options.seed);
    this.history = new HistoryLog(
      options.clock,
      this.random,
      options.historyRetentionMs ?? 7 * 86400_000,
    );
    for (const id of SYSTEM_LABEL_IDS) {
      this.labels.set(id, {
        id,
        name: id,
        type: 'system',
        messageListVisibility: 'show',
        labelListVisibility: id === 'CHAT' ? 'labelHide' : 'labelShow',
      });
    }
    this.aliases = [
      {
        sendAsEmail: options.emailAddress,
        displayName: '',
        isDefault: true,
        isPrimary: true,
        treatAsAlias: false,
        verificationStatus: 'accepted',
      },
    ];
  }

  // ---------- labels ----------

  listLabels(): MailLabel[] {
    return [...this.labels.values()].map(l => ({ ...l }));
  }

  getLabel(id: string): MailLabel {
    const label = this.labels.get(id);
    if (!label) throw notFound();
    return { ...label };
  }

  /** Counts for labels.get, in Gmail's four fields. */
  labelCounts(id: string): {
    messagesTotal: number;
    messagesUnread: number;
    threadsTotal: number;
    threadsUnread: number;
  } {
    const inLabel = [...this.messages.values()].filter(m => m.labelIds.includes(id));
    const unread = inLabel.filter(m => m.labelIds.includes('UNREAD'));
    return {
      messagesTotal: inLabel.length,
      messagesUnread: unread.length,
      threadsTotal: new Set(inLabel.map(m => m.threadId)).size,
      threadsUnread: new Set(unread.map(m => m.threadId)).size,
    };
  }

  createLabel(
    name: string,
    visibility: { labelListVisibility?: string; messageListVisibility?: string } = {},
  ): MailLabel {
    const clean = name.trim();
    if (!clean || RESERVED_LABEL_NAMES.has(clean.toLowerCase()))
      throw badRequest('Invalid label name');
    if ([...this.labels.values()].some(l => l.name.toLowerCase() === clean.toLowerCase())) {
      throw new ApiError(409, 'duplicate', 'Label name exists or conflicts', {});
    }
    const label: MailLabel = {
      id: `Label_${this.nextUserLabel++}`,
      name: clean,
      type: 'user',
      messageListVisibility: visibility.messageListVisibility ?? 'show',
      labelListVisibility: visibility.labelListVisibility ?? 'labelShow',
    };
    this.labels.set(label.id, label);
    return { ...label };
  }

  /** Id of a label by display name, e.g. 'Projects' (undefined when absent). */
  labelIdByName(name: string): string | undefined {
    return [...this.labels.values()].find(l => l.name.toLowerCase() === name.toLowerCase())?.id;
  }

  private requireLabels(ids: readonly string[]): void {
    for (const id of ids) if (!this.labels.has(id)) throw badRequest(`Invalid label: ${id}`);
  }

  // ---------- reading ----------

  profile(): {
    emailAddress: string;
    messagesTotal: number;
    threadsTotal: number;
    historyId: string;
  } {
    return {
      emailAddress: this.emailAddress,
      messagesTotal: this.messages.size,
      threadsTotal: this.threads.size,
      historyId: String(this.history.currentId),
    };
  }

  get messageCount(): number {
    return this.messages.size;
  }

  get threadCount(): number {
    return this.threads.size;
  }

  getMessage(id: string): MessageView | undefined {
    const m = this.messages.get(id);
    return m && this.view(m);
  }

  listMessages(): MessageView[] {
    return [...this.messages.values()].map(m => this.view(m));
  }

  threadMessageIds(threadId: string): string[] {
    return this.sortedThread(threadId).map(m => m.id);
  }

  threadIds(): string[] {
    return [...this.threads.keys()];
  }

  hasMessage(id: string): boolean {
    return this.messages.has(id);
  }

  rawOf(id: string): Buffer {
    return Buffer.from(this.require(id).raw);
  }

  private view(m: StoredMessage): MessageView {
    return {
      id: m.id,
      threadId: m.threadId,
      labelIds: [...m.labelIds],
      internalDate: m.internalDate,
      historyId: String(m.historyId),
      subject: m.subject,
      from: m.from,
      to: m.toRaw,
      messageId: m.meta.messageId,
      snippet: m.snippet,
    };
  }

  private require(id: string): StoredMessage {
    const m = this.messages.get(id);
    if (!m) throw notFound();
    return m;
  }

  private sortedThread(threadId: string): StoredMessage[] {
    const ids = this.threads.get(threadId);
    if (!ids) throw notFound();
    return ids
      .map(id => this.messages.get(id)!)
      .sort((a, b) => a.internalDate - b.internalDate || a.historyId - b.historyId);
  }

  private target(m: StoredMessage): QueryTarget {
    const labelNames = m.labelIds.flatMap(id => {
      const label = this.labels.get(id);
      return [id.toLowerCase(), ...(label ? [normalizeLabelName(label.name)] : [])];
    });
    return { ...m.meta, labelIds: m.labelIds, labelNames };
  }

  /** Messages matching labelIds (all of them) and a Gmail query, newest first. */
  select(options: {
    labelIds?: string[];
    q?: string;
    includeSpamTrash?: boolean;
  }): (Keyed & { id: string; threadId: string })[] {
    const parsed = parseQuery(options.q ?? '');
    const wanted = options.labelIds ?? [];
    const showJunk =
      options.includeSpamTrash ||
      wanted.includes('TRASH') ||
      wanted.includes('SPAM') ||
      mentionsSpamTrash(parsed);
    const now = this.clock.now();
    return [...this.messages.values()]
      .filter(m => showJunk || !(m.labelIds.includes('TRASH') || m.labelIds.includes('SPAM')))
      .filter(m => wanted.every(l => m.labelIds.includes(l)))
      .filter(m => matchesQuery(parsed, this.target(m), now))
      .map(m => ({ id: m.id, threadId: m.threadId, date: m.internalDate }))
      .sort(compareKeyed);
  }

  /** Threads with at least one matching message, ordered by their newest matching message. */
  selectThreads(options: {
    labelIds?: string[];
    q?: string;
    includeSpamTrash?: boolean;
  }): ThreadSummary[] {
    const newest = new Map<string, Keyed & { id: string }>();
    for (const hit of this.select(options))
      if (!newest.has(hit.threadId)) newest.set(hit.threadId, hit);
    return [...newest.entries()]
      .map(([threadId, hit]) => {
        const stored = this.messages.get(hit.id)!;
        return {
          id: threadId,
          date: hit.date,
          snippet: stored.snippet,
          historyId: String(this.threadHistoryId(threadId)),
        };
      })
      .sort(compareKeyed);
  }

  private threadHistoryId(threadId: string): number {
    return Math.max(...this.sortedThread(threadId).map(m => m.historyId));
  }

  // ---------- resources ----------

  private baseResource(m: StoredMessage): Record<string, unknown> {
    return {
      id: m.id,
      threadId: m.threadId,
      ...(m.labelIds.length ? { labelIds: [...m.labelIds] } : {}),
      snippet: m.snippet,
      sizeEstimate: m.raw.length,
      historyId: String(m.historyId),
      internalDate: String(m.internalDate),
    };
  }

  messageResource(
    id: string,
    format: MessageFormat,
    metadataHeaders: string[] = [],
  ): Record<string, unknown> {
    return this.resourceOf(this.require(id), format, metadataHeaders);
  }

  private resourceOf(
    m: StoredMessage,
    format: MessageFormat,
    metadataHeaders: string[],
  ): Record<string, unknown> {
    const base = this.baseResource(m);
    switch (format) {
      case 'minimal':
        return base;
      case 'metadata': {
        const wanted = new Set(metadataHeaders.map(h => h.toLowerCase()));
        const headers = m.payload.headers.filter(
          h => !wanted.size || wanted.has(h.name.toLowerCase()),
        );
        return {
          ...base,
          payload: {
            partId: '',
            mimeType: m.payload.mimeType,
            filename: '',
            headers: headers.map(h => ({ ...h })),
            body: { size: 0 },
          },
        };
      }
      case 'full':
        return { ...base, payload: structuredClone(m.payload) };
      case 'raw':
        return { ...base, raw: m.raw.toString('base64url') };
    }
  }

  threadResource(
    threadId: string,
    format: Exclude<MessageFormat, 'raw'>,
    metadataHeaders: string[] = [],
  ): Record<string, unknown> {
    const messages = this.sortedThread(threadId);
    return {
      id: threadId,
      snippet: messages[messages.length - 1].snippet,
      historyId: String(this.threadHistoryId(threadId)),
      messages: messages.map(m => this.resourceOf(m, format, metadataHeaders)),
    };
  }

  attachment(messageId: string, attachmentId: string): Buffer {
    const data = this.require(messageId).attachments.get(attachmentId);
    if (!data) throw notFound();
    return Buffer.from(data);
  }

  // ---------- adding messages ----------

  private newId(): string {
    for (;;) {
      const id = this.random.hex(16);
      if (!this.messages.has(id) && !this.threads.has(id)) return id;
    }
  }

  /** Inserts a message from raw bytes and writes the history record for it. */
  addRaw(raw: Buffer, options: InsertOptions = {}): MessageView {
    return this.view(this.insert(raw, options));
  }

  private insert(raw: Buffer, options: InsertOptions): StoredMessage {
    const labelIds = [...new Set(options.labelIds ?? [])];
    this.requireLabels(labelIds);
    const tree = parseRfc822(raw);
    const attachments = new Map<string, Buffer>();
    const payload = toPayload(tree, {
      htmlAsAttachment: options.htmlAsAttachment ?? false,
      storeAttachment: data => {
        const id = `ANGjdJ${this.random.hex(48)}`;
        attachments.set(id, data);
        return id;
      },
    });
    const headers = payload.headers;
    const subject = headerValue(headers, 'subject') ?? '';
    const from = headerValue(headers, 'from') ?? '';
    const toRaw = [headerValue(headers, 'to'), headerValue(headers, 'cc')]
      .filter(Boolean)
      .join(', ');
    const messageId = stripAngle(headerValue(headers, 'message-id') ?? '');
    const id = this.newId();
    const threadId =
      this.resolveThread(headers, options.threadId, options.threadRule ?? 'fixture') ?? id;
    const text = bodyText(tree);
    const message: StoredMessage = {
      id,
      threadId,
      labelIds,
      internalDate: options.internalDate ?? this.clock.now(),
      historyId: 0,
      raw,
      payload,
      snippet: makeSnippet(text),
      attachments,
      subject,
      from,
      toRaw,
      meta: {
        from: from.toLowerCase(),
        to: toRaw.toLowerCase(),
        subject: subject.toLowerCase(),
        messageId,
        internalDate: options.internalDate ?? this.clock.now(),
        hasAttachment: collectLeaves(tree).some(
          l => l.filename !== '' || l.disposition === 'attachment',
        ),
        searchText: `${subject}\n${text}`.toLowerCase(),
      },
    };
    this.messages.set(id, message);
    this.threads.set(threadId, [...(this.threads.get(threadId) ?? []), id]);
    if (messageId && !this.byMessageId.has(messageId)) this.byMessageId.set(messageId, id);
    const record = this.history.append({
      messages: [{ id, threadId }],
      messagesAdded: [{ message: this.historyMessage(message) }],
    });
    message.historyId = Number(record.id);
    return message;
  }

  /**
   * Threads by explicit id, else by In-Reply-To/References plus a matching subject. Through the API
   * an explicit id also needs a matching subject (Re:/Fwd: ignored); the References requirement in
   * the sending guide is not enforced, because Gmail is widely seen to thread on id plus subject.
   */
  private resolveThread(
    headers: MimeHeader[],
    explicit: string | undefined,
    rule: ThreadRule,
  ): string | undefined {
    const subject = baseSubject(headerValue(headers, 'subject') ?? '');
    if (explicit) {
      if (!this.threads.has(explicit)) throw notFound();
      if (rule === 'fixture') return explicit;
      return this.sortedThread(explicit).some(m => baseSubject(m.subject) === subject)
        ? explicit
        : undefined;
    }
    const refs =
      `${headerValue(headers, 'in-reply-to') ?? ''} ${headerValue(headers, 'references') ?? ''}`
        .split(/\s+/)
        .map(stripAngle)
        .filter(Boolean);
    for (const ref of refs) {
      const match = this.messages.get(this.byMessageId.get(ref) ?? '');
      if (match && baseSubject(match.subject) === subject) return match.threadId;
    }
    return undefined;
  }

  private nextBoundary = (): string =>
    `=_emu_${(this.boundaries++).toString(36)}_${this.random.hex(6)}`;

  /** Builds and inserts a message the way another Gmail client would have delivered it. */
  addMessage(spec: MessageSpec): MessageView {
    const internalDate = spec.internalDate ?? this.clock.now();
    const parent = spec.replyTo ? this.require(spec.replyTo) : undefined;
    const messageId = spec.messageId ?? `${this.random.hex(20)}@mail.example.test`;
    const headers: [string, string][] = [
      ['From', spec.from ?? 'sender@example.test'],
      ['To', (spec.to ?? [this.emailAddress]).join(', ')],
    ];
    if (spec.cc?.length) headers.push(['Cc', spec.cc.join(', ')]);
    headers.push([
      'Subject',
      spec.subject ??
        (parent ? `Re: ${parent.subject.replace(/^(re:\s*)+/i, '')}` : '(no subject)'),
    ]);
    headers.push(['Date', new Date(internalDate).toUTCString()]);
    headers.push(['Message-ID', `<${messageId}>`]);
    if (parent) {
      headers.push(['In-Reply-To', `<${parent.meta.messageId}>`]);
      headers.push(['References', `<${parent.meta.messageId}>`]);
    }
    for (const [name, value] of Object.entries(spec.headers ?? {})) headers.push([name, value]);
    const raw = buildRfc822(
      { headers, text: spec.text, html: spec.html, attachments: spec.attachments },
      this.nextBoundary,
    );
    return this.addRaw(raw, {
      labelIds: spec.labelIds ?? ['INBOX'],
      threadId: spec.threadId ?? parent?.threadId,
      internalDate,
      htmlAsAttachment: spec.htmlAsAttachment,
    });
  }

  // ---------- history helpers ----------

  private historyMessage(m: StoredMessage): HistoryMessage {
    return { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] };
  }

  /** Adds and removes labels on messages, writing one history record per kind of change per message. */
  private applyLabels(
    targets: StoredMessage[],
    add: readonly string[],
    remove: readonly string[],
  ): number {
    let changed = 0;
    for (const m of targets) {
      const added = add.filter(l => !m.labelIds.includes(l));
      const removed = remove.filter(l => m.labelIds.includes(l) && !added.includes(l));
      if (!added.length && !removed.length) continue;
      changed++;
      m.labelIds = [...m.labelIds.filter(l => !removed.includes(l)), ...added];
      const ref = { id: m.id, threadId: m.threadId };
      if (added.length)
        m.historyId = Number(
          this.history.append({
            messages: [ref],
            labelsAdded: [{ message: this.historyMessage(m), labelIds: added }],
          }).id,
        );
      if (removed.length)
        m.historyId = Number(
          this.history.append({
            messages: [ref],
            labelsRemoved: [{ message: this.historyMessage(m), labelIds: removed }],
          }).id,
        );
    }
    return changed;
  }

  private remove(m: StoredMessage): void {
    this.messages.delete(m.id);
    const siblings = (this.threads.get(m.threadId) ?? []).filter(id => id !== m.id);
    if (siblings.length) this.threads.set(m.threadId, siblings);
    else this.threads.delete(m.threadId);
    if (this.byMessageId.get(m.meta.messageId) === m.id) this.byMessageId.delete(m.meta.messageId);
    for (const [draftId, messageId] of this.drafts)
      if (messageId === m.id) this.drafts.delete(draftId);
    this.history.append({
      messages: [{ id: m.id, threadId: m.threadId }],
      messagesDeleted: [{ message: this.historyMessage(m) }],
    });
  }

  // ---------- changes (API and "made elsewhere" helpers) ----------

  modifyMessages(ids: string[], add: string[], remove: string[]): void {
    this.requireLabels([...add, ...remove]);
    this.applyLabels(
      ids.map(id => this.require(id)),
      add,
      remove,
    );
  }

  modifyThread(threadId: string, add: string[], remove: string[]): void {
    this.requireLabels([...add, ...remove]);
    this.applyLabels(this.sortedThread(threadId), add, remove);
  }

  /** Changes labels on messages and/or whole threads, as the Gmail web app or a phone would. Returns messages changed. */
  relabel(
    target: { messageIds?: string[]; threadIds?: string[] },
    add: string[] = [],
    remove: string[] = [],
  ): number {
    this.requireLabels([...add, ...remove]);
    const messages = [
      ...(target.messageIds ?? []).map(id => this.require(id)),
      ...(target.threadIds ?? []).flatMap(id => this.sortedThread(id)),
    ];
    return this.applyLabels([...new Set(messages)], add, remove);
  }

  /** Removes INBOX from the `count` newest inbox threads. Returns their ids. */
  archiveThreads(count: number): string[] {
    const ids = this.selectThreads({ labelIds: ['INBOX'] })
      .slice(0, count)
      .map(t => t.id);
    this.relabel({ threadIds: ids }, [], ['INBOX']);
    return ids;
  }

  trashMessage(id: string): void {
    this.applyLabels([this.require(id)], ['TRASH'], ['INBOX', 'SPAM']);
  }

  untrashMessage(id: string): void {
    const m = this.require(id);
    const restore = m.labelIds.includes('SENT') || m.labelIds.includes('DRAFT') ? [] : ['INBOX'];
    this.applyLabels([m], restore, ['TRASH']);
  }

  trashThread(threadId: string): void {
    for (const m of this.sortedThread(threadId)) this.trashMessage(m.id);
  }

  untrashThread(threadId: string): void {
    for (const m of this.sortedThread(threadId)) this.untrashMessage(m.id);
  }

  /** Permanently deletes a message (history gets messagesDeleted). */
  deleteMessage(id: string): void {
    this.remove(this.require(id));
  }

  expireHistory(): void {
    this.history.expire();
  }

  // ---------- sending and inserting ----------

  private readonly draftIdentity?: MailboxOptions['draftIdentity'];
  private readonly rewriteSentMessageId?: MailboxOptions['rewriteSentMessageId'];

  /** A draft saved through the API, as Gmail would store it: Message-ID rewritten and some headers dropped, by option. */
  private draftRaw(raw: Buffer): Buffer {
    const change = this.draftIdentity?.();
    if (!change) return this.outgoing(raw);
    const gone = [...change.dropHeaders, ...(change.rewriteMessageId ? ['Message-ID'] : [])];
    const stripped = gone.length ? withoutHeaders(raw, gone) : raw;
    return this.outgoing(
      change.rewriteMessageId
        ? withDefaultHeaders(stripped, { 'Message-ID': `<${this.random.hex(20)}@mail.gmail.com>` })
        : stripped,
    );
  }

  private outgoing(raw: Buffer): Buffer {
    return withDefaultHeaders(raw, {
      From: this.emailAddress,
      Date: new Date(this.clock.now()).toUTCString(),
      'Message-ID': `<${this.random.hex(20)}@mail.example.test>`,
    });
  }

  /** Every To, Cc and Bcc address of a raw message; a send with none is 400 "Recipient address required" [observed]. */
  private recipientsOf(raw: Buffer): string[] {
    const headers = parseRfc822(raw).headers;
    const recipients = ['to', 'cc', 'bcc'].flatMap(h => addressesIn(headerValue(headers, h)));
    if (!recipients.length) throw badRequest('Recipient address required');
    return recipients;
  }

  /** messages.send: the message lands in SENT, and also in INBOX when it is addressed to the account itself. */
  sendRaw(raw: Buffer, threadId?: string): MessageView {
    const sent = this.rewriteSentMessageId?.()
      ? withDefaultHeaders(withoutHeaders(raw, ['Message-ID']), {
          'Message-ID': `<${this.random.hex(20)}@mail.gmail.com>`,
        })
      : raw;
    const full = this.outgoing(sent);
    const toSelf = this.recipientsOf(full).includes(this.emailAddress.toLowerCase());
    return this.addRaw(full, {
      labelIds: toSelf ? ['SENT', 'INBOX', 'UNREAD'] : ['SENT'],
      threadId,
      threadRule: 'api',
    });
  }

  /** messages.insert: no labels unless asked, like an IMAP APPEND. */
  insertRaw(
    raw: Buffer,
    labelIds: string[],
    threadId: string | undefined,
    dateSource: 'receivedTime' | 'dateHeader',
  ): MessageView {
    const dateHeader = headerValue(parseRfc822(raw).headers, 'date');
    const parsedDate = dateHeader ? Date.parse(dateHeader) : NaN;
    const internalDate =
      dateSource === 'dateHeader' && Number.isFinite(parsedDate) ? parsedDate : this.clock.now();
    return this.addRaw(raw, { labelIds, threadId, internalDate, threadRule: 'api' });
  }

  // ---------- drafts ----------

  createDraft(raw: Buffer, threadId?: string): { id: string; message: MessageView } {
    const message = this.addRaw(this.draftRaw(raw), {
      labelIds: ['DRAFT'],
      threadId,
      threadRule: 'api',
    });
    const id = `r${this.random.int(1, 9)}${this.random.hex(18)}`;
    this.drafts.set(id, message.id);
    return { id, message };
  }

  /** Replaces the whole message: the draft id stays, the message id changes. */
  updateDraft(
    draftId: string,
    raw: Buffer,
    threadId?: string,
  ): { id: string; message: MessageView } {
    const old = this.require(this.draftMessageId(draftId));
    // Add the replacement first so the thread never empties out and keeps its id.
    // Only a threadId the client sends is held to the subject rule; otherwise the draft keeps its thread.
    const message = threadId
      ? this.addRaw(this.draftRaw(raw), { labelIds: ['DRAFT'], threadId, threadRule: 'api' })
      : this.addRaw(this.draftRaw(raw), { labelIds: ['DRAFT'], threadId: old.threadId });
    this.remove(old);
    this.drafts.set(draftId, message.id);
    return { id: draftId, message };
  }

  deleteDraft(draftId: string): void {
    this.remove(this.require(this.draftMessageId(draftId)));
    this.drafts.delete(draftId);
  }

  /** drafts.send: the draft message becomes a SENT message (same id) and the draft disappears. */
  sendDraft(draftId: string): MessageView {
    const message = this.require(this.draftMessageId(draftId));
    const toSelf = this.recipientsOf(message.raw).includes(this.emailAddress.toLowerCase());
    this.drafts.delete(draftId);
    this.applyLabels([message], toSelf ? ['SENT', 'INBOX', 'UNREAD'] : ['SENT'], ['DRAFT']);
    return this.view(message);
  }

  draftMessageId(draftId: string): string {
    const id = this.drafts.get(draftId);
    if (!id) throw notFound();
    return id;
  }

  listDrafts(): { id: string; message: MessageView }[] {
    return [...this.drafts.entries()].map(([id, messageId]) => ({
      id,
      message: this.view(this.require(messageId)),
    }));
  }

  /** A draft started on a phone or in Gmail web. Returns the ids a client should later see. */
  createDraftElsewhere(spec: MessageSpec): {
    draftId: string;
    messageId: string;
    threadId: string;
  } {
    const message = this.addMessage({
      ...spec,
      labelIds: ['DRAFT'],
      from: spec.from ?? this.emailAddress,
    });
    const draftId = `r${this.random.int(1, 9)}${this.random.hex(18)}`;
    this.drafts.set(draftId, message.id);
    return { draftId, messageId: message.id, threadId: message.threadId };
  }

  // ---------- settings ----------

  createFilter(criteria: Record<string, unknown>, action: Record<string, unknown>): GmailFilter {
    if (this.filters.size >= 1000) throw badRequest('Too many filters', 'failedPrecondition');
    if (![...Object.keys(criteria)].length) throw badRequest('Filter criteria is empty');
    if (![...Object.keys(action)].length) throw badRequest('Filter action is empty');
    this.requireLabels([
      ...((action.addLabelIds as string[] | undefined) ?? []),
      ...((action.removeLabelIds as string[] | undefined) ?? []),
    ]);
    const fingerprint = JSON.stringify([criteria, action]);
    for (const existing of this.filters.values()) {
      if (JSON.stringify([existing.criteria, existing.action]) === fingerprint)
        throw badRequest('Filter already exists', 'failedPrecondition');
    }
    const filter: GmailFilter = { id: `ANe1Bm${this.random.hex(24)}`, criteria, action };
    this.filters.set(filter.id, filter);
    return structuredClone(filter);
  }

  listFilters(): GmailFilter[] {
    return [...this.filters.values()].map(f => structuredClone(f));
  }

  getFilter(id: string): GmailFilter {
    const filter = this.filters.get(id);
    if (!filter) throw notFound();
    return structuredClone(filter);
  }

  deleteFilter(id: string): void {
    if (!this.filters.delete(id)) throw notFound();
  }

  listSendAs(): SendAsAlias[] {
    return this.aliases.map(a => ({ ...a }));
  }

  addSendAs(email: string, displayName = ''): void {
    this.aliases.push({
      sendAsEmail: email,
      displayName,
      isDefault: false,
      isPrimary: false,
      treatAsAlias: true,
      verificationStatus: 'accepted',
    });
  }
}

/** Newest first; ties broken by id so paging is stable. */
export function compareKeyed(a: Keyed, b: Keyed): number {
  return b.date - a.date || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}
