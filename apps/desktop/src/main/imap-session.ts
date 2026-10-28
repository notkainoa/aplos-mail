import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
  type MessageStructureObject,
} from 'imapflow';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { ProviderError } from '@aplos/engine/legacy/provider';

export interface ImapLogin {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}
export interface SmtpLogin {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}
export interface ImapFolder {
  path: string;
  name: string;
  specialUse?: string;
  subscribed?: boolean;
}
/** What SELECT reports. Numbers that can exceed 2^53 (UIDVALIDITY, MODSEQ) travel as strings. */
export interface ImapBox {
  uidValidity: string;
  uidNext: number;
  highestModseq?: string;
  exists: number;
}
/** A leaf MIME part from BODYSTRUCTURE. */
export interface ImapPart {
  part: string;
  type: string;
  size: number;
  filename?: string;
  contentId?: string;
  disposition?: string;
}
export interface ImapFetched {
  uid: number;
  flags: string[];
  size?: number;
  date?: string;
  modseq?: string;
  headers?: Buffer;
  source?: Buffer;
  parts?: ImapPart[];
}
export interface ImapFetchQuery {
  headers?: boolean;
  source?: boolean;
  parts?: boolean;
}
/** The subset of IMAP SEARCH keys Aplos uses; structurally compatible with imapflow's SearchObject. */
export interface ImapQuery {
  all?: boolean;
  uid?: string;
  since?: Date;
  text?: string;
  subject?: string;
  from?: string;
  to?: string;
  body?: string;
  header?: Record<string, string>;
  or?: ImapQuery[];
}

/**
 * One authenticated IMAP connection. Mailbox-scoped calls take the path and select it as needed;
 * callers serialize operations, so one mailbox is selected at a time. UIDs are always used.
 */
export interface ImapSession {
  connect(): Promise<void>;
  readonly usable: boolean;
  /** Upper-case capability names (CONDSTORE, MOVE, UIDPLUS, ...). */
  readonly capabilities: ReadonlySet<string>;
  list(): Promise<ImapFolder[]>;
  create(path: string): Promise<void>;
  unsubscribe(path: string): Promise<void>;
  /** Select the mailbox afresh and report its current state. */
  open(path: string): Promise<ImapBox>;
  /** `range` is a UID set unless `bySequence`; `changedSince` limits results to messages whose MODSEQ grew. */
  fetch(
    path: string,
    range: string,
    query: ImapFetchQuery,
    options?: { bySequence?: boolean; changedSince?: string },
  ): Promise<ImapFetched[]>;
  /** UIDs of matching messages. */
  search(path: string, query: ImapQuery): Promise<number[]>;
  /** Rejects with a ProviderError when the server does not apply the change. */
  flags(path: string, uids: number[], action: 'add' | 'remove', flags: string[]): Promise<void>;
  /**
   * MOVE, or COPY + \Deleted + UID EXPUNGE with UIDPLUS. Without either the source copies are only marked \Deleted
   * (left for the server or another client to expunge), because a plain EXPUNGE removes every \Deleted message.
   * The map is source UID → destination UID when the server reports COPYUID.
   */
  move(
    path: string,
    uids: number[],
    destination: string,
  ): Promise<{ uidValidity?: string; map?: Map<number, number> }>;
  /** Mark \Deleted and expunge just these UIDs (UIDPLUS); without UIDPLUS they are only marked \Deleted. */
  remove(path: string, uids: number[]): Promise<void>;
  append(
    path: string,
    raw: Buffer,
    flags: string[],
    date?: Date,
  ): Promise<{ uid?: number; uidValidity?: string }>;
  /** One decoded MIME part (text parts converted to UTF-8). */
  download(path: string, uid: number, part: string, maxBytes: number): Promise<Buffer | undefined>;
  logout(): Promise<void>;
}

export interface SmtpSender {
  verify(): Promise<void>;
  send(
    mail: SendMailOptions,
  ): Promise<{ accepted: string[]; rejected: string[]; response?: string }>;
  close(): void;
}

/** Headers needed for threading and for showing messages too large to download whole. */
export const HEADER_FIELDS = [
  'message-id',
  'in-reply-to',
  'references',
  'from',
  'to',
  'cc',
  'subject',
  'date',
  'x-aplos-data',
];

function leaves(node: MessageStructureObject | undefined): ImapPart[] {
  if (!node) return [];
  if (node.childNodes?.length && node.type.startsWith('multipart/'))
    return node.childNodes.flatMap(leaves);
  return [
    {
      part: node.part ?? '1',
      type: node.type,
      size: node.size ?? 0,
      filename: node.dispositionParameters?.filename ?? node.parameters?.name,
      contentId: node.id?.replace(/^<|>$/g, ''),
      disposition: node.disposition,
    },
  ];
}
function fetched(m: FetchMessageObject): ImapFetched {
  return {
    uid: m.uid,
    flags: [...(m.flags ?? [])],
    size: m.size,
    date: m.internalDate ? new Date(m.internalDate).toISOString() : undefined,
    modseq: m.modseq !== undefined ? String(m.modseq) : undefined,
    headers: m.headers,
    source: m.source,
    parts: m.bodyStructure ? leaves(m.bodyStructure) : undefined,
  };
}
/** Production IMAP session over imapflow. Logging is off so credentials and mail never reach logs. */
export function imapflowSession(
  config: ImapLogin,
  create: (options: ImapFlowOptions) => ImapFlow = o => new ImapFlow(o),
): ImapSession {
  const client = create({
    host: config.host,
    port: config.port,
    secure: config.secure,
    doSTARTTLS: config.secure ? undefined : true,
    auth: { user: config.user, pass: config.pass },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
    clientInfo: { name: 'Aplos Mail' },
  });
  // An unhandled 'error' event would crash the process; failures still reject the pending command.
  client.on('error', () => {});
  // imapflow reports a refused command as false (or undefined) rather than throwing. When the connection is gone
  // the command may still have run, so that case is uncertain.
  const ensure = <T>(value: T | false | undefined, what: string): T => {
    if (value !== false && value !== undefined) return value;
    throw client.usable
      ? new ProviderError(`The mail server refused to ${what}.`)
      : new ProviderError(
          `The connection to the mail server was lost while trying to ${what}.`,
          undefined,
          true,
        );
  };
  // RFC 9051 folds MOVE and UIDPLUS into IMAP4rev2, so a rev2 session has both without advertising them.
  const has = (capability: string) =>
    client.capabilities.has(capability) ||
    client.enabled.has('IMAP4REV2') ||
    (client.capabilities.has('IMAP4rev2') && !client.capabilities.has('IMAP4rev1'));
  async function locked<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const lock = await client.getMailboxLock(path);
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }
  return {
    connect: () => client.connect(),
    get usable() {
      return client.usable;
    },
    get capabilities() {
      return new Set([...client.capabilities.keys(), ...client.enabled].map(c => c.toUpperCase()));
    },
    async list() {
      return (await client.list()).map(f => ({
        path: f.path,
        name: f.name,
        specialUse: f.specialUse,
        subscribed: f.subscribed,
      }));
    },
    async create(path) {
      await client.mailboxCreate(path);
    },
    async unsubscribe(path) {
      await client.mailboxUnsubscribe(path);
    },
    async open(path) {
      const selected = client.mailbox && client.mailbox.path === path;
      return locked(path, async () => {
        // getMailboxLock keeps an already selected mailbox, whose UIDNEXT may be stale; SELECT it again.
        // (CLOSE would also expunge messages other clients marked \Deleted.)
        const box = selected
          ? await client.mailboxOpen(path)
          : ensure(client.mailbox || undefined, 'open the mailbox');
        return {
          uidValidity: String(box.uidValidity),
          uidNext: box.uidNext,
          highestModseq:
            box.highestModseq !== undefined && !box.noModseq
              ? String(box.highestModseq)
              : undefined,
          exists: box.exists,
        };
      });
    },
    fetch(path, range, query, options = {}) {
      return locked(path, async () => {
        const rows: ImapFetched[] = [];
        const items = {
          uid: true,
          flags: true,
          size: true,
          internalDate: true,
          ...(query.headers ? { headers: HEADER_FIELDS } : {}),
          ...(query.source ? { source: true } : {}),
          ...(query.parts ? { bodyStructure: true } : {}),
        };
        for await (const m of client.fetch(range, items, {
          uid: !options.bySequence,
          ...(options.changedSince ? { changedSince: BigInt(options.changedSince) } : {}),
        }))
          rows.push(fetched(m));
        return rows;
      });
    },
    search(path, query) {
      return locked(path, async () => ensure(await client.search(query, { uid: true }), 'search'));
    },
    flags(path, uids, action, flags) {
      return locked(path, async () => {
        const set = uids.join(',');
        ensure(
          (action === 'add'
            ? await client.messageFlagsAdd(set, flags, { uid: true })
            : await client.messageFlagsRemove(set, flags, { uid: true })) || undefined,
          'change the message flags',
        );
      });
    },
    move(path, uids, destination) {
      return locked(path, async () => {
        const set = uids.join(',');
        let r;
        if (has('MOVE') || has('UIDPLUS'))
          r = ensure(
            await client.messageMove(set, destination, { uid: true }),
            'move the messages',
          );
        else {
          r = ensure(
            await client.messageCopy(set, destination, { uid: true }),
            'copy the messages',
          );
          ensure(
            (await client.messageFlagsAdd(set, ['\\Deleted'], { uid: true })) || undefined,
            'remove the moved messages from their folder',
          );
        }
        return {
          uidValidity: r.uidValidity !== undefined ? String(r.uidValidity) : undefined,
          map: r.uidMap,
        };
      });
    },
    remove(path, uids) {
      return locked(path, async () => {
        const set = uids.join(',');
        if (has('UIDPLUS'))
          ensure(
            (await client.messageDelete(set, { uid: true })) || undefined,
            'delete the messages',
          );
        else
          ensure(
            (await client.messageFlagsAdd(set, ['\\Deleted'], { uid: true })) || undefined,
            'delete the messages',
          );
      });
    },
    async append(path, raw, flags, date) {
      const r = ensure(await client.append(path, raw, flags, date), 'save the message');
      return {
        uid: r.uid,
        uidValidity: r.uidValidity !== undefined ? String(r.uidValidity) : undefined,
      };
    },
    download(path, uid, part, maxBytes) {
      return locked(path, async () => {
        const result = await client.download(String(uid), part, { uid: true, maxBytes });
        if (!result.content) return undefined;
        const chunks: Buffer[] = [];
        for await (const chunk of result.content) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
      });
    },
    async logout() {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
}

/** Production SMTP sender. Every send opens its own connection; nothing is pooled across sends. */
export function nodemailerSender(config: SmtpLogin): SmtpSender {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    logger: false,
    debug: false,
  });
  return {
    async verify() {
      await transport.verify();
    },
    async send(mail) {
      const info = await transport.sendMail({
        ...mail,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      const plain = (list: unknown[] | undefined) =>
        (list ?? []).map(a =>
          typeof a === 'string' ? a : String((a as { address?: string }).address ?? ''),
        );
      return {
        accepted: plain(info.accepted),
        rejected: plain(info.rejected),
        response: info.response,
      };
    },
    close() {
      transport.close();
    },
  };
}
