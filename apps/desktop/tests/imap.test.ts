import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import type { Account, Draft, Thread } from '@aplos/contract/legacy/types';
import type {
  CalendarBackend,
  CalendarCredentials,
  ProviderMemory,
  SyncResult,
} from '@aplos/engine/legacy/provider';
import {
  createImap,
  IMAP_PRESETS,
  MAX_SOURCE,
  type ImapFetched,
  type ImapLogin,
  type ImapPart,
  type ImapQuery,
  type ImapSession,
  type SmtpSender,
} from '../src/main/imap';

const encrypt = (text: string) => Buffer.from([...Buffer.from(text)].map(x => x ^ 0x5a));
const decrypt = (buffer: Buffer) => Buffer.from([...buffer].map(x => x ^ 0x5a)).toString();
const ME = 'alex@icloud.example',
  PASSWORD = 'abcd-efgh-ijkl-mnop';

interface FakeMessage {
  uid: number;
  raw: Buffer;
  flags: Set<string>;
  date: string;
  modseq: number;
  size?: number;
  parts?: ImapPart[];
  data?: Record<string, Buffer>;
}
interface FakeFolder {
  path: string;
  specialUse?: string;
  uidValidity: number;
  uidNext: number;
  messages: FakeMessage[];
  subscribed: boolean;
}
const inSet = (n: number, range: string, max: number) =>
  range.split(',').some(p => {
    const [a, b = a] = p.split(':');
    const lo = a === '*' ? max : Number(a),
      hi = b === '*' ? max : Number(b);
    return n >= Math.min(lo, hi) && n <= Math.max(lo, hi);
  });
const headerBlock = (raw: Buffer) => raw.toString('utf8').split('\r\n\r\n')[0] + '\r\n';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An in-memory IMAP host with UIDs, UIDVALIDITY, MODSEQ, MOVE and COPYUID that can be switched off. */
class FakeHost {
  folders = new Map<string, FakeFolder>();
  capabilities = new Set(['CONDSTORE', 'MOVE', 'UIDPLUS']);
  modseq = 1;
  clock = 0;
  logins: ImapLogin[] = [];
  constructor(folders: Array<[string, string?]>) {
    for (const [path, specialUse] of folders) this.folder(path, specialUse);
  }
  folder(path: string, specialUse?: string) {
    const f: FakeFolder = {
      path,
      specialUse,
      uidValidity: 100 + this.folders.size,
      uidNext: 1,
      messages: [],
      subscribed: true,
    };
    this.folders.set(path, f);
    return f;
  }
  box(path: string) {
    const f = this.folders.get(path);
    if (!f) throw Object.assign(new Error(`No mailbox ${path}`), { mailboxMissing: true });
    return f;
  }
  deliver(path: string, raw: Buffer, flags: string[] = [], extra: Partial<FakeMessage> = {}) {
    const f = this.box(path),
      uid = f.uidNext++;
    f.messages.push({
      uid,
      raw,
      flags: new Set(flags),
      date: new Date(Date.now() - 3600_000 + this.clock++ * 60_000).toISOString(),
      modseq: ++this.modseq,
      ...extra,
    });
    return uid;
  }
  find(id: string) {
    for (const f of this.folders.values())
      for (const m of f.messages)
        if (new RegExp(`^Message-ID:\\s*<${escape(id)}>`, 'im').test(headerBlock(m.raw)))
          return { folder: f.path, message: m };
    return undefined;
  }
  setFlag(id: string, flag: string, on: boolean) {
    const hit = this.find(id)!;
    if (on) hit.message.flags.add(flag);
    else hit.message.flags.delete(flag);
    hit.message.modseq = ++this.modseq;
  }
  expunge(id: string) {
    const hit = this.find(id)!;
    const f = this.box(hit.folder);
    f.messages = f.messages.filter(m => m !== hit.message);
    this.modseq++;
  }
  where(id: string) {
    return this.find(id)?.folder;
  }
  /** Move a message the way another client would, without telling Aplos. */
  relocate(id: string, path: string) {
    const hit = this.find(id)!;
    this.expunge(id);
    return this.deliver(path, hit.message.raw, [...hit.message.flags], { date: hit.message.date });
  }
  /** The server rebuilds a folder: new UIDVALIDITY, UIDs numbered from 1 again. */
  rebuild(path: string, raws: Buffer[]) {
    const f = this.box(path);
    f.uidValidity += 1000;
    f.uidNext = 1;
    f.messages = [];
    for (const raw of raws) this.deliver(path, raw);
  }
  session(config: ImapLogin): ImapSession {
    const host = this;
    let open = false;
    const matches = (m: FakeMessage, q: ImapQuery, f: FakeFolder): boolean => {
      const head = headerBlock(m.raw).toLowerCase(),
        body = m.raw.toString('utf8').split('\r\n\r\n').slice(1).join('\r\n\r\n').toLowerCase();
      const field = (name: string, term: string) =>
        new RegExp(`^${name}:.*${escape(term.toLowerCase())}`, 'im').test(head);
      if (q.uid && !inSet(m.uid, q.uid, f.uidNext - 1)) return false;
      if (q.since && Date.parse(m.date) < q.since.getTime()) return false;
      if (q.header) for (const [k, v] of Object.entries(q.header)) if (!field(k, v)) return false;
      if (q.text && !(head + body).includes(q.text.toLowerCase())) return false;
      if (q.subject && !field('subject', q.subject)) return false;
      if (q.from && !field('from', q.from)) return false;
      if (q.to && !field('to', q.to)) return false;
      if (q.body && !body.includes(q.body.toLowerCase())) return false;
      if (q.or && !q.or.some(sub => matches(m, sub, f))) return false;
      return true;
    };
    const row = (
      m: FakeMessage,
      query: { headers?: boolean; source?: boolean; parts?: boolean },
    ): ImapFetched => ({
      uid: m.uid,
      flags: [...m.flags],
      size: m.size ?? m.raw.length,
      date: m.date,
      modseq: String(m.modseq),
      ...(query.headers ? { headers: Buffer.from(headerBlock(m.raw)) } : {}),
      ...(query.source ? { source: m.raw } : {}),
      ...(query.parts ? { parts: m.parts ?? [] } : {}),
    });
    return {
      async connect() {
        host.logins.push(config);
        if (config.pass !== PASSWORD)
          throw Object.assign(new Error('Authentication failed'), {
            authenticationFailed: true,
            serverResponseCode: 'AUTHENTICATIONFAILED',
          });
        open = true;
      },
      get usable() {
        return open;
      },
      get capabilities() {
        return host.capabilities;
      },
      async list() {
        return [...host.folders.values()].map(f => ({
          path: f.path,
          name: f.path.split('/').at(-1)!,
          specialUse: f.specialUse,
          subscribed: f.subscribed,
        }));
      },
      async create(path) {
        if (!host.folders.has(path)) host.folder(path);
      },
      async unsubscribe(path) {
        host.box(path).subscribed = false;
      },
      async open(path) {
        const f = host.box(path);
        return {
          uidValidity: String(f.uidValidity),
          uidNext: f.uidNext,
          exists: f.messages.length,
          ...(host.capabilities.has('CONDSTORE') ? { highestModseq: String(host.modseq) } : {}),
        };
      },
      async fetch(path, range, query, options = {}) {
        const f = host.box(path),
          sorted = [...f.messages].sort((a, b) => a.uid - b.uid);
        return sorted
          .filter((m, i) =>
            options.bySequence
              ? inSet(i + 1, range, sorted.length)
              : inSet(m.uid, range, f.uidNext - 1),
          )
          .filter(m => !options.changedSince || m.modseq > Number(options.changedSince))
          .map(m => row(m, query));
      },
      async search(path, query) {
        const f = host.box(path);
        return f.messages.filter(m => matches(m, query, f)).map(m => m.uid);
      },
      async flags(path, uids, action, flags) {
        for (const m of host.box(path).messages)
          if (uids.includes(m.uid)) {
            for (const flag of flags)
              if (action === 'add') m.flags.add(flag);
              else m.flags.delete(flag);
            m.modseq = ++host.modseq;
          }
      },
      async move(path, uids, destination) {
        const from = host.box(path),
          to = host.box(destination),
          map = new Map<number, number>();
        for (const m of from.messages.filter(m => uids.includes(m.uid))) {
          const uid = to.uidNext++;
          to.messages.push({ ...m, uid, modseq: ++host.modseq });
          map.set(m.uid, uid);
        }
        from.messages = from.messages.filter(m => !uids.includes(m.uid));
        host.modseq++;
        return host.capabilities.has('UIDPLUS') ? { uidValidity: String(to.uidValidity), map } : {};
      },
      async remove(path, uids) {
        const f = host.box(path);
        f.messages = f.messages.filter(m => !uids.includes(m.uid));
        host.modseq++;
      },
      async append(path, raw, flags) {
        const uid = host.deliver(path, raw, flags);
        return { uid, uidValidity: String(host.box(path).uidValidity) };
      },
      async download(path, uid, part) {
        return host.box(path).messages.find(m => m.uid === uid)?.data?.[part];
      },
      async logout() {
        open = false;
      },
    };
  }
}
const iCloudFolders = (): Array<[string, string?]> => [
  ['INBOX', '\\Inbox'],
  ['Sent Messages'],
  ['Archive', '\\Archive'],
  ['Deleted Messages'],
  ['Junk'],
];
function mail(m: {
  id: string;
  from: string;
  to?: string;
  subject?: string;
  body?: string;
  inReplyTo?: string;
  references?: string[];
}) {
  const lines = [
    `Message-ID: <${m.id}>`,
    `From: ${m.from}`,
    `To: ${m.to ?? ME}`,
    `Subject: ${m.subject ?? 'Studio review'}`,
    `Date: ${new Date().toUTCString()}`,
  ];
  if (m.inReplyTo) lines.push(`In-Reply-To: <${m.inReplyTo}>`);
  if (m.references) lines.push(`References: ${m.references.map(r => `<${r}>`).join(' ')}`);
  lines.push(
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    m.body ?? 'Hello there',
  );
  return Buffer.from(lines.join('\r\n'));
}
function memoryMap(): ProviderMemory {
  const data = new Map<string, string>();
  return {
    get: (a, k) => data.get(`${a}|${k}`),
    set: (a, k, v) => {
      if (v === undefined) data.delete(`${a}|${k}`);
      else data.set(`${a}|${k}`, v);
    },
    clear: a => {
      for (const k of [...data.keys()]) if (k.startsWith(`${a}|`)) data.delete(k);
    },
  };
}
async function compose(options: SendMailOptions) {
  return (
    await nodemailer
      .createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
      .sendMail(options)
  ).message as Buffer;
}

/** Memory whose writes during a sync are held until the caller commits or discards them, as the service does. */
function stagedMemory() {
  const base = memoryMap(),
    held = new Map<string, [string, string, string | undefined]>();
  let staging = false;
  const memory: ProviderMemory = {
    get: (a, k) => (held.has(`${a}|${k}`) ? held.get(`${a}|${k}`)![2] : base.get(a, k)),
    set: (a, k, v) => {
      if (staging) held.set(`${a}|${k}`, [a, k, v]);
      else base.set(a, k, v);
    },
    clear: a => {
      base.clear(a);
      for (const [key, [account]] of [...held]) if (account === a) held.delete(key);
    },
  };
  return {
    memory,
    begin() {
      staging = true;
    },
    commit() {
      for (const [a, k, v] of held.values()) base.set(a, k, v);
      held.clear();
      staging = false;
    },
    discard() {
      held.clear();
      staging = false;
    },
  };
}

async function harness(
  opts: {
    folders?: Array<[string, string?]>;
    preset?: 'icloud' | 'yahoo';
    autoSave?: boolean;
    calendar?: CalendarBackend;
    memory?: ProviderMemory;
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-imap-'));
  const host = new FakeHost(opts.folders ?? iCloudFolders()),
    memory = opts.memory ?? memoryMap();
  const smtp = {
    sent: [] as SendMailOptions[],
    error: undefined as unknown,
    logins: [] as string[],
  };
  const sender = (config: { pass: string; user: string }): SmtpSender => ({
    async verify() {
      smtp.logins.push(config.user);
      if (config.pass !== PASSWORD)
        throw Object.assign(new Error('Invalid login: 535 5.7.8 Error: authentication failed'), {
          code: 'EAUTH',
          responseCode: 535,
          command: 'AUTH PLAIN',
        });
    },
    async send(options) {
      if (smtp.error) throw smtp.error;
      smtp.sent.push(options);
      if (opts.autoSave) host.deliver('Sent Messages', await compose(options), ['\\Seen']);
      return { accepted: [String(options.to)], rejected: [] };
    },
    close() {},
  });
  const open = () =>
    createImap({
      dataDir,
      encrypt,
      decrypt,
      memory,
      client: config => host.session(config),
      smtp: sender,
      calendar: opts.calendar,
      sentCopyDelayMs: 0,
    });
  let imap = await open();
  const account = await imap.connect({
    provider: 'imap',
    email: ME,
    secret: PASSWORD,
    preset: opts.preset ?? 'icloud',
    name: 'Alex',
  });
  const has = new Set<string>();
  const sync = async (cursor?: string): Promise<SyncResult> => {
    const result = await imap.sync(account, cursor, { has: id => has.has(id) });
    for (const t of result.threads) has.add(t.id);
    for (const id of result.removed) has.delete(id);
    return result;
  };
  return {
    dataDir,
    host,
    memory,
    smtp,
    account,
    sync,
    get imap() {
      return imap;
    },
    async reopen() {
      await imap.close();
      imap = await open();
    },
    async cleanup() {
      await imap.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
const one = (threads: Thread[], subject: string) => {
  const found = threads.filter(t => t.subject === subject);
  assert.equal(found.length, 1, `one thread "${subject}"`);
  return found[0];
};

test('connect checks IMAP and SMTP logins before saving, stores only an encrypted secret, and calendar is optional', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-imap-connect-'));
  try {
    const host = new FakeHost(iCloudFolders());
    let smtpOk = true;
    const calendarCalls: CalendarCredentials[] = [];
    let calendarOk = true;
    const calendar = {
      verify: async (c: CalendarCredentials) => {
        calendarCalls.push(c);
        if (!calendarOk) throw new Error('no calendar');
      },
    } as unknown as CalendarBackend;
    const imap = await createImap({
      dataDir,
      encrypt,
      decrypt,
      memory: memoryMap(),
      calendar,
      client: c => host.session(c),
      smtp: c => ({
        verify: async () => {
          if (!smtpOk || c.pass !== PASSWORD)
            throw Object.assign(new Error('535'), { code: 'EAUTH', responseCode: 535 });
        },
        send: async () => ({ accepted: [], rejected: [] }),
        close() {},
      }),
    });
    await assert.rejects(
      imap.connect({ provider: 'imap', email: ME, secret: 'my-apple-password', preset: 'icloud' }),
      (e: any) =>
        e.status === 401 &&
        /iCloud rejected the password.*app-specific password.*appleid\.apple\.com/.test(e.message),
    );
    smtpOk = false;
    await assert.rejects(
      imap.connect({ provider: 'imap', email: ME, secret: PASSWORD, preset: 'icloud' }),
      (e: any) => e.status === 401,
    );
    assert.deepEqual(await readdir(dataDir), [], 'nothing is saved until both logins work');
    smtpOk = true;
    calendarOk = false;
    let account = await imap.connect({
      provider: 'imap',
      email: ME.toUpperCase(),
      secret: PASSWORD,
      preset: 'icloud',
    });
    assert.equal(
      account.calendarConnected,
      false,
      'a calendar failure leaves calendar off without failing the account',
    );
    calendarOk = true;
    account = await imap.connect({
      provider: 'imap',
      email: ME,
      secret: PASSWORD,
      preset: 'icloud',
      name: 'Alex',
    });
    assert.match(account.id, /^imap-[0-9a-f]{16}$/);
    assert.equal(account.provider, 'imap');
    assert.equal(account.preset, 'icloud');
    assert.equal(account.calendarConnected, true);
    assert.deepEqual(account.server, IMAP_PRESETS.icloud.server);
    assert.deepEqual(account.sendAs, [{ email: ME, name: 'Alex', signature: '', isDefault: true }]);
    assert.deepEqual(imap.capabilities(account), {
      labels: false,
      importance: false,
      aliases: false,
      signatures: false,
      calendar: true,
      serverSearch: true,
    });
    assert.deepEqual(calendarCalls.at(-1), {
      url: 'https://caldav.icloud.com',
      username: ME,
      password: PASSWORD,
    });
    assert.deepEqual(host.logins.at(-1), {
      host: 'imap.mail.me.com',
      port: 993,
      secure: true,
      user: ME,
      pass: PASSWORD,
    });
    const saved = await readFile(join(dataDir, 'imap-credentials.enc.json'), 'utf8');
    assert.ok(!saved.includes(PASSWORD), 'the app password is stored encrypted');
    assert.equal(
      decrypt(Buffer.from(JSON.parse(saved)[account.id], 'base64')),
      JSON.stringify(PASSWORD),
    );
    await imap.disconnect(account.id);
    assert.deepEqual(
      JSON.parse(await readFile(join(dataDir, 'imap-credentials.enc.json'), 'utf8')),
      {},
    );
    await imap.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('first sync threads an inbox message with its reply in Sent and maps folders to status and labels', async () => {
  const h = await harness();
  try {
    h.host.deliver('INBOX', mail({ id: 'a1@sam.example', from: 'Sam <sam@example.test>' }));
    h.host.deliver(
      'Sent Messages',
      mail({
        id: 's1@icloud.example',
        from: `Alex <${ME}>`,
        to: 'sam@example.test',
        subject: 'Re: Studio review',
        inReplyTo: 'a1@sam.example',
        references: ['a1@sam.example'],
      }),
      ['\\Seen'],
    );
    h.host.deliver(
      'Archive',
      mail({ id: 'b1@lee.example', from: 'lee@example.test', subject: 'Invoice' }),
      ['\\Seen', '\\Flagged'],
    );
    h.host.deliver(
      'Deleted Messages',
      mail({ id: 'c1@spam.example', from: 'old@example.test', subject: 'Old news' }),
      ['\\Seen'],
    );
    const result = await h.sync();
    assert.equal(result.reset, true);
    assert.equal(result.threads.length, 3);
    const review = one(result.threads, 'Studio review');
    assert.equal(review.id, `${h.account.id}:${review.remoteId}`);
    assert.deepEqual(
      review.messages.map(m => [m.id, m.sent]),
      [
        ['a1@sam.example', false],
        ['s1@icloud.example', true],
      ],
    );
    assert.equal(review.messages[1].internetId, '<s1@icloud.example>');
    assert.equal(review.messages[1].references, '<a1@sam.example>');
    assert.equal(review.messages[0].from, 'sam@example.test');
    assert.equal(review.messages[0].fromName, 'Sam');
    assert.match(review.messages[0].text, /Hello there/);
    assert.equal(review.status, 'new');
    assert.equal(review.unread, true);
    assert.deepEqual(review.labels, ['INBOX', 'SENT', 'UNREAD']);
    const invoice = one(result.threads, 'Invoice');
    assert.equal(invoice.status, 'done');
    assert.equal(invoice.bookmarked, true);
    assert.deepEqual(invoice.labels, ['ARCHIVE', 'STARRED']);
    assert.equal(one(result.threads, 'Old news').status, 'trash');
    const cursor = JSON.parse(result.cursor!);
    assert.equal(cursor.f.inbox.v, String(h.host.box('INBOX').uidValidity));
    assert.equal(cursor.f.inbox.n, 2);
  } finally {
    await h.cleanup();
  }
});

test('incremental sync: arrivals join threads, flags arrive as flags, expunges remove only empty threads, UIDVALIDITY resets', async () => {
  for (const condstore of [true, false]) {
    const h = await harness();
    try {
      if (!condstore) h.host.capabilities.delete('CONDSTORE');
      h.host.deliver('INBOX', mail({ id: 'a1@sam.example', from: 'sam@example.test' }));
      h.host.deliver(
        'Archive',
        mail({ id: 'b1@lee.example', from: 'lee@example.test', subject: 'Invoice' }),
        ['\\Seen'],
      );
      h.host.deliver(
        'Archive',
        mail({ id: 'd1@kim.example', from: 'kim@example.test', subject: 'Plans' }),
        ['\\Seen'],
      );
      h.host.deliver(
        'Archive',
        mail({
          id: 'd2@kim.example',
          from: 'kim@example.test',
          subject: 'Re: Plans',
          inReplyTo: 'd1@kim.example',
        }),
        ['\\Seen'],
      );
      let result = await h.sync();
      const review = one(result.threads, 'Studio review'),
        invoice = one(result.threads, 'Invoice'),
        plans = one(result.threads, 'Plans');
      result = await h.sync(result.cursor);
      assert.deepEqual(
        [result.threads, result.flags, result.removed, result.reset],
        [[], [], [], false],
        'nothing changed',
      );

      h.host.deliver(
        'INBOX',
        mail({
          id: 'a2@sam.example',
          from: 'sam@example.test',
          subject: 'Re: Studio review',
          inReplyTo: 'a1@sam.example',
        }),
      );
      result = await h.sync(result.cursor);
      assert.equal(result.threads.length, 1);
      assert.equal(result.threads[0].id, review.id, 'a reply keeps the thread ID');
      assert.deepEqual(
        result.threads[0].messages.map(m => m.id),
        ['a1@sam.example', 'a2@sam.example'],
      );

      h.host.setFlag('a1@sam.example', '\\Seen', true);
      h.host.setFlag('a2@sam.example', '\\Seen', true);
      h.host.setFlag('b1@lee.example', '\\Flagged', true);
      result = await h.sync(result.cursor);
      assert.deepEqual(
        result.threads,
        [],
        `flag-only changes are not refetched (CONDSTORE ${condstore})`,
      );
      assert.deepEqual(
        result.flags.sort((a, b) => a.id.localeCompare(b.id)),
        [
          { id: review.id, unread: false, bookmarked: false, status: 'new', labels: ['INBOX'] },
          {
            id: invoice.id,
            unread: false,
            bookmarked: true,
            status: 'done',
            labels: ['ARCHIVE', 'STARRED'],
          },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );

      h.host.expunge('d2@kim.example');
      h.host.expunge('b1@lee.example');
      result = await h.sync(result.cursor);
      assert.deepEqual(
        result.removed,
        [invoice.id],
        'a thread is removed only when no message is left',
      );
      assert.equal(result.threads.length, 1);
      assert.equal(result.threads[0].id, plans.id);
      assert.deepEqual(
        result.threads[0].messages.map(m => m.id),
        ['d1@kim.example'],
      );

      h.host.box('INBOX').uidValidity++;
      result = await h.sync(result.cursor);
      assert.equal(result.reset, false, 'only one folder was reset');
      assert.deepEqual(
        [...result.threads, ...result.flags].map(t => t.id),
        [review.id],
        'the reset folder is read again and keeps thread IDs',
      );
      assert.deepEqual(result.removed, []);
      for (const f of h.host.folders.values()) f.uidValidity += 10;
      result = await h.sync(result.cursor);
      assert.equal(result.reset, true);
      assert.deepEqual(
        [...result.threads, ...result.flags].map(t => t.id).sort(),
        [review.id, plans.id].sort(),
      );
      assert.deepEqual(result.removed, []);
    } finally {
      await h.cleanup();
    }
  }
});

test('a message linking two threads merges them into the older thread and reports the other as removed', async () => {
  const h = await harness();
  try {
    h.host.deliver(
      'INBOX',
      mail({ id: 'x1@a.example', from: 'ann@example.test', subject: 'Venue' }),
    );
    h.host.deliver(
      'INBOX',
      mail({ id: 'y1@b.example', from: 'bob@example.test', subject: 'Catering' }),
    );
    let result = await h.sync();
    const venue = one(result.threads, 'Venue'),
      catering = one(result.threads, 'Catering');
    h.host.deliver(
      'INBOX',
      mail({
        id: 'z1@c.example',
        from: 'cat@example.test',
        subject: 'Re: Venue and catering',
        references: ['y1@b.example', 'x1@a.example'],
      }),
    );
    result = await h.sync(result.cursor);
    assert.deepEqual(result.removed, [catering.id]);
    assert.equal(result.threads.length, 1);
    assert.equal(result.threads[0].id, venue.id);
    assert.deepEqual(
      result.threads[0].messages.map(m => m.id),
      ['x1@a.example', 'y1@b.example', 'z1@c.example'],
    );
    // Updates sent with the merged-away ID still reach the surviving thread.
    await h.imap.updateThread(
      h.account,
      { remoteId: catering.remoteId, status: 'new', labels: ['INBOX'] },
      { unread: false },
    );
    assert.ok(h.host.find('z1@c.example')!.message.flags.has('\\Seen'));
  } finally {
    await h.cleanup();
  }
});

test('updates move messages between folders, follow their new UIDs, and keep Sent copies in Sent', async () => {
  for (const uidplus of [true, false]) {
    const h = await harness({
      folders: [['INBOX', '\\Inbox'], ['Sent Messages'], ['Deleted Messages'], ['Junk']],
    });
    try {
      if (!uidplus) h.host.capabilities.delete('UIDPLUS');
      h.host.deliver('INBOX', mail({ id: 'a1@sam.example', from: 'sam@example.test' }));
      h.host.deliver(
        'Sent Messages',
        mail({
          id: 's1@icloud.example',
          from: ME,
          subject: 'Re: Studio review',
          inReplyTo: 'a1@sam.example',
        }),
        ['\\Seen'],
      );
      h.host.deliver(
        'INBOX',
        mail({
          id: 'a2@sam.example',
          from: 'sam@example.test',
          subject: 'Re: Studio review',
          inReplyTo: 's1@icloud.example',
        }),
      );
      let result = await h.sync();
      const thread = one(result.threads, 'Studio review'),
        remote = { remoteId: thread.remoteId, status: thread.status, labels: thread.labels };
      await h.imap.updateThread(h.account, remote, { status: 'done', labels: ['SENT', 'UNREAD'] });
      assert.ok(h.host.folders.has('Archive'), 'Archive is created on first archive');
      assert.deepEqual(
        ['a1@sam.example', 'a2@sam.example', 's1@icloud.example'].map(id => h.host.where(id)),
        ['Archive', 'Archive', 'Sent Messages'],
      );
      await h.imap.updateThread(h.account, remote, { status: 'trash' });
      assert.deepEqual(
        ['a1@sam.example', 'a2@sam.example', 's1@icloud.example'].map(id => h.host.where(id)),
        ['Deleted Messages', 'Deleted Messages', 'Sent Messages'],
        `second move finds the moved copies (UIDPLUS ${uidplus})`,
      );
      await h.imap.updateThread(h.account, remote, { status: 'new', labels: ['INBOX'] });
      assert.deepEqual(
        ['a1@sam.example', 'a2@sam.example'].map(id => h.host.where(id)),
        ['INBOX', 'INBOX'],
      );
      await h.imap.updateThread(h.account, remote, { unread: false });
      assert.ok(
        ['a1@sam.example', 'a2@sam.example'].every(id =>
          h.host.find(id)!.message.flags.has('\\Seen'),
        ),
      );
      await h.imap.updateThread(h.account, remote, { unread: true, bookmarked: true });
      assert.deepEqual(
        ['a1@sam.example', 'a2@sam.example'].map(id => [...h.host.find(id)!.message.flags].sort()),
        [['\\Seen'], ['\\Flagged']],
        'unread and star apply to the latest inbound message',
      );
      await h.imap.updateThread(h.account, remote, { status: 'spam' });
      assert.deepEqual(
        ['a1@sam.example', 'a2@sam.example', 's1@icloud.example'].map(id => h.host.where(id)),
        ['Junk', 'Junk', 'Sent Messages'],
      );
      result = await h.sync(result.cursor);
      const after = [...result.threads, ...result.flags].find(t => t.id === thread.id)!;
      assert.equal(after.status, 'spam');
      assert.equal(after.bookmarked, true);
      assert.equal(after.unread, true);
      assert.deepEqual(result.removed, []);
      await h.imap.updateThread(h.account, remote, { bookmarked: false });
      assert.ok(!h.host.find('a2@sam.example')!.message.flags.has('\\Flagged'));
      for (const id of ['a1@sam.example', 'a2@sam.example', 's1@icloud.example'])
        h.host.expunge(id);
      await assert.rejects(
        h.imap.updateThread(h.account, remote, { unread: false }),
        (e: any) => e.status === 404,
      );
    } finally {
      await h.cleanup();
    }
  }
});

test('send uses the fixed Message-ID, files a Sent copy only when the host did not, and findSent settles it', async () => {
  for (const autoSave of [false, true]) {
    const h = await harness({ autoSave });
    try {
      h.host.deliver('INBOX', mail({ id: 'a1@sam.example', from: 'sam@example.test' }));
      let result = await h.sync();
      const thread = one(result.threads, 'Studio review');
      const draft: Draft = {
        id: 'd1',
        accountId: h.account.id,
        to: 'sam@example.test',
        cc: '',
        bcc: 'boss@example.test',
        subject: 'Re: Studio review',
        html: '<p>Friday works.</p>',
        attachments: [],
        threadId: thread.id,
        mode: 'reply',
        updatedAt: new Date().toISOString(),
        signature: false,
        revision: 1,
        messageId: '<fixed-1@icloud.example>',
      };
      const sent = await h.imap.send(h.account, draft, thread);
      assert.deepEqual(sent, { id: 'fixed-1@icloud.example', threadId: thread.remoteId });
      const out = h.smtp.sent.at(-1)!;
      assert.equal(out.messageId, '<fixed-1@icloud.example>');
      assert.equal(out.inReplyTo, '<a1@sam.example>');
      assert.equal(out.references, '<a1@sam.example>');
      assert.deepEqual(out.from, { name: 'Alex', address: ME });
      const copies = h.host.box('Sent Messages').messages;
      assert.equal(copies.length, 1, `exactly one Sent copy (host saves: ${autoSave})`);
      assert.ok(copies[0].flags.has('\\Seen'));
      assert.match(copies[0].raw.toString(), /Message-ID: <fixed-1@icloud\.example>/i);
      assert.deepEqual(await h.imap.findSent(h.account, '<fixed-1@icloud.example>'), {
        id: 'fixed-1@icloud.example',
        threadId: thread.remoteId,
      });
      assert.equal(await h.imap.findSent(h.account, '<never@icloud.example>'), undefined);
      result = await h.sync(result.cursor);
      assert.equal(result.threads.length, 1);
      assert.equal(result.threads[0].id, thread.id, 'the Sent copy joins the thread');
      assert.deepEqual(
        result.threads[0].messages.map(m => [m.id, m.sent]),
        [
          ['a1@sam.example', false],
          ['fixed-1@icloud.example', true],
        ],
      );
      const fresh = await h.imap.send(h.account, {
        ...draft,
        id: 'd2',
        threadId: undefined,
        mode: 'new',
        subject: 'Hello',
        messageId: '<fixed-2@icloud.example>',
      });
      result = await h.sync(result.cursor);
      assert.equal(
        result.threads[0].id,
        `${h.account.id}:${fresh.threadId}`,
        'a new message reports the thread its Sent copy lands in',
      );
    } finally {
      await h.cleanup();
    }
  }
});

test('SMTP failures are uncertain only when the message may have been accepted', async () => {
  const h = await harness();
  try {
    const draft: Draft = {
      id: 'd1',
      accountId: h.account.id,
      to: 'sam@example.test',
      cc: '',
      bcc: '',
      subject: 'Hi',
      html: '<p>Hi</p>',
      attachments: [],
      mode: 'new',
      updatedAt: new Date().toISOString(),
      signature: false,
      revision: 1,
      messageId: '<m@icloud.example>',
    };
    const cases: Array<[unknown, boolean, number | undefined]> = [
      [
        Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', command: 'DATA' }),
        true,
        undefined,
      ],
      [Object.assign(new Error('Connection closed'), { code: 'ECONNECTION' }), true, undefined],
      [
        Object.assign(new Error('Recipient rejected'), {
          code: 'EENVELOPE',
          responseCode: 550,
          command: 'RCPT TO',
          response: '550 5.1.1 no such user',
        }),
        false,
        550,
      ],
      [
        Object.assign(new Error('Message rejected'), {
          code: 'EMESSAGE',
          responseCode: 554,
          command: 'DATA',
        }),
        false,
        554,
      ],
      [
        Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT', command: 'CONN' }),
        false,
        undefined,
      ],
      [Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }), false, 401],
    ];
    for (const [error, uncertain, status] of cases) {
      h.smtp.error = error;
      await assert.rejects(
        h.imap.send(h.account, draft),
        (e: any) =>
          e.uncertain === uncertain && e.status === status && !String(e.message).includes(PASSWORD),
      );
    }
    assert.equal(
      h.host.box('Sent Messages').messages.length,
      0,
      'nothing is filed in Sent after a failure',
    );
  } finally {
    await h.cleanup();
  }
});

test('server search finds mail outside the synced window and indexes it for later updates', async () => {
  const h = await harness();
  try {
    const old = h.host.deliver(
      'Archive',
      mail({
        id: 'old@lee.example',
        from: 'lee@example.test',
        subject: 'Invoice 2019',
        body: 'Payment for the kiln',
      }),
      ['\\Seen'],
    );
    h.host.box('Archive').messages.find(m => m.uid === old)!.date = '2019-01-01T00:00:00.000Z';
    h.host.deliver('INBOX', mail({ id: 'a1@sam.example', from: 'sam@example.test' }));
    const result = await h.sync();
    assert.equal(result.threads.length, 1, 'old archive mail is outside the first window');
    const found = await h.imap.search(h.account, 'kiln');
    assert.deepEqual(
      found.map(t => t.subject),
      ['Invoice 2019'],
    );
    assert.equal(found[0].status, 'done');
    await h.imap.updateThread(
      h.account,
      { remoteId: found[0].remoteId, status: 'done', labels: found[0].labels },
      { status: 'trash' },
    );
    assert.equal(h.host.where('old@lee.example'), 'Deleted Messages');
    assert.deepEqual(await h.imap.search(h.account, 'nothing-matches'), []);
  } finally {
    await h.cleanup();
  }
});

test('large messages download only their text; attachments come on demand', async () => {
  const h = await harness();
  try {
    h.host.deliver(
      'INBOX',
      mail({ id: 'big@sam.example', from: 'sam@example.test', subject: 'Drawings' }),
      [],
      {
        size: MAX_SOURCE + 1,
        parts: [
          { part: '1', type: 'text/plain', size: 20 },
          {
            part: '2',
            type: 'application/pdf',
            size: MAX_SOURCE,
            filename: 'plans.pdf',
            disposition: 'attachment',
          },
        ],
        data: { '1': Buffer.from('See attached plans.'), '2': Buffer.from('%PDF-1.7 fake') },
      },
    );
    const result = await h.sync();
    const message = result.threads[0].messages[0];
    assert.equal(message.text, 'See attached plans.');
    assert.deepEqual(
      message.attachments.map(a => [a.name, a.remoteId, a.data]),
      [['plans.pdf', 'part:2', undefined]],
    );
    const file = await h.imap.attachment(h.account, result.threads[0], message.attachments[0]);
    assert.equal(Buffer.from(file.data!, 'base64').toString(), '%PDF-1.7 fake');
  } finally {
    await h.cleanup();
  }
});

test('app data lives in marked messages in a hidden Aplos folder and only merged copies are replaced', async () => {
  const h = await harness();
  try {
    assert.deepEqual(await h.imap.readAppData(h.account), []);
    await h.imap.writeAppData(h.account, '{"v":1}', []);
    const folder = h.host.box('Aplos Mail Data');
    assert.equal(folder.subscribed, false);
    const [first] = await h.imap.readAppData(h.account);
    assert.equal(first.data, '{"v":1}');
    // Two devices write without seeing each other: both copies are kept, newest first.
    await h.imap.writeAppData(h.account, '{"v":2,"text":"ünïcode"}', []);
    const both = await h.imap.readAppData(h.account);
    assert.deepEqual(
      both.map(r => r.data),
      ['{"v":2,"text":"ünïcode"}', '{"v":1}'],
    );
    assert.equal(both[1].id, first.id);
    // The folder is rebuilt (new UIDVALIDITY, UIDs reordered) and another device writes before this one replaces what it read.
    h.host.rebuild(
      'Aplos Mail Data',
      [...folder.messages].reverse().map(m => m.raw),
    );
    await h.imap.writeAppData(h.account, '{"v":"other device"}', []);
    await h.imap.writeAppData(
      h.account,
      '{"v":3}',
      both.map(r => r.id),
    );
    assert.deepEqual(
      (await h.imap.readAppData(h.account)).map(r => r.data),
      ['{"v":3}', '{"v":"other device"}'],
      'only the merged copies are deleted',
    );
    const result = await h.sync();
    assert.ok(
      result.threads.every(t => !t.subject.includes('Aplos')),
      'app data is never synced as mail',
    );
  } finally {
    await h.cleanup();
  }
});

test('a user folder named Aplos is never read as app data and its mail is never deleted', async () => {
  const h = await harness({ folders: [...iCloudFolders(), ['Aplos']] });
  try {
    h.host.deliver(
      'Aplos',
      mail({
        id: 'note@me.example',
        from: ME,
        subject: 'Aplos Mail sync data',
        body: 'my own notes',
      }),
    );
    h.host.deliver(
      'Aplos',
      await compose({
        messageId: '<lookalike@me.example>',
        from: ME,
        to: ME,
        subject: 'Aplos Mail sync data',
        text: 'x',
        attachments: [{ filename: 'aplos-data.json', content: '{"v":"user"}' }],
      }),
    );
    assert.deepEqual(await h.imap.readAppData(h.account), []);
    await h.imap.writeAppData(h.account, '{"v":1}', ['note@me.example', 'lookalike@me.example']);
    assert.deepEqual(
      (await h.imap.readAppData(h.account)).map(r => r.data),
      ['{"v":1}'],
    );
    assert.ok(
      h.host.find('note@me.example') && h.host.find('lookalike@me.example'),
      'user mail stays even when its ID is listed',
    );
  } finally {
    await h.cleanup();
  }
});

test('a folder rebuilt under a new UIDVALIDITY never redirects triage to the mail that reused a UID', async () => {
  const h = await harness();
  try {
    const a1 = mail({ id: 'a1@sam.example', from: 'sam@example.test' });
    h.host.deliver('INBOX', a1);
    const first = await h.sync();
    const thread = one(first.threads, 'Studio review'),
      remote = { remoteId: thread.remoteId, status: thread.status, labels: thread.labels };
    h.host.rebuild('INBOX', [
      mail({ id: 'other@bank.example', from: 'bank@example.test', subject: 'Statement' }),
      a1,
    ]);
    assert.equal(
      h.host.find('other@bank.example')!.message.uid,
      1,
      'UID 1 now belongs to unrelated mail',
    );
    await h.imap.updateThread(h.account, remote, { unread: false, bookmarked: true });
    assert.deepEqual([...h.host.find('other@bank.example')!.message.flags], []);
    assert.deepEqual([...h.host.find('a1@sam.example')!.message.flags].sort(), [
      '\\Flagged',
      '\\Seen',
    ]);
    await h.imap.updateThread(h.account, remote, { status: 'done', labels: [] });
    assert.equal(h.host.where('other@bank.example'), 'INBOX');
    assert.equal(h.host.where('a1@sam.example'), 'Archive');
    const next = await h.sync(first.cursor);
    assert.deepEqual(next.removed, []);
    assert.equal([...next.threads, ...next.flags].find(t => t.id === thread.id)?.status, 'done');
    assert.equal(one(next.threads, 'Statement').status, 'new');
  } finally {
    await h.cleanup();
  }
});

test('thread keys come from the root message, so a rebuilt index keeps them after the root moved folders', async () => {
  const h = await harness();
  try {
    h.host.deliver('INBOX', mail({ id: 'a1@sam.example', from: 'sam@example.test' }));
    h.host.deliver(
      'INBOX',
      mail({
        id: 'a2@sam.example',
        from: 'sam@example.test',
        subject: 'Re: Studio review',
        inReplyTo: 'a1@sam.example',
        references: ['a1@sam.example'],
      }),
    );
    const before = one((await h.sync()).threads, 'Studio review');
    h.host.relocate('a1@sam.example', 'Archive');
    h.memory.clear(h.account.id);
    const after = one((await h.sync()).threads, 'Studio review');
    assert.equal(after.id, before.id);
    assert.deepEqual(
      after.messages.map(m => m.id),
      ['a1@sam.example', 'a2@sam.example'],
    );
  } finally {
    await h.cleanup();
  }
});

test('explicit flag changes are always sent, even when the index already agrees', async () => {
  const h = await harness();
  try {
    h.host.deliver('INBOX', mail({ id: 'a1@sam.example', from: 'sam@example.test' }));
    const thread = one((await h.sync()).threads, 'Studio review'),
      remote = { remoteId: thread.remoteId, status: thread.status, labels: thread.labels };
    await h.imap.updateThread(h.account, remote, { unread: false, bookmarked: true });
    // Another client undoes both before Aplos syncs again.
    h.host.setFlag('a1@sam.example', '\\Seen', false);
    h.host.setFlag('a1@sam.example', '\\Flagged', false);
    await h.imap.updateThread(h.account, remote, { unread: false, bookmarked: true });
    assert.deepEqual([...h.host.find('a1@sam.example')!.message.flags].sort(), [
      '\\Flagged',
      '\\Seen',
    ]);
  } finally {
    await h.cleanup();
  }
});

test('Message-ID lookups match exactly, not by substring', async () => {
  const h = await harness();
  try {
    h.host.deliver(
      'Sent Messages',
      mail({ id: 'prefixed-1@icloud.example', from: ME, subject: 'Other' }),
      ['\\Seen'],
    );
    assert.equal(await h.imap.findSent(h.account, '<fixed-1@icloud.example>'), undefined);
    const draft: Draft = {
      id: 'd1',
      accountId: h.account.id,
      to: 'sam@example.test',
      cc: '',
      bcc: '',
      subject: 'Hi',
      html: '<p>Hi</p>',
      attachments: [],
      mode: 'new',
      updatedAt: new Date().toISOString(),
      signature: false,
      revision: 1,
      messageId: '<fixed-1@icloud.example>',
    };
    await h.imap.send(h.account, draft);
    assert.equal(
      h.host.box('Sent Messages').messages.length,
      2,
      'a look-alike ID does not stop the Sent copy',
    );
    h.host.deliver('INBOX', mail({ id: 'a1@sam.example', from: 'sam@example.test' }));
    const thread = one((await h.sync()).threads, 'Studio review');
    h.host.deliver(
      'Archive',
      mail({ id: 'xa1@sam.example', from: 'sam@example.test', subject: 'Look-alike' }),
    );
    h.host.relocate('a1@sam.example', 'Junk');
    await h.imap.updateThread(
      h.account,
      { remoteId: thread.remoteId, status: 'new', labels: ['INBOX'] },
      { unread: false },
    );
    assert.ok(
      h.host.find('a1@sam.example')!.message.flags.has('\\Seen'),
      'the moved message is found where it went',
    );
    assert.ok(!h.host.find('xa1@sam.example')!.message.flags.has('\\Seen'));
  } finally {
    await h.cleanup();
  }
});

test('a sync whose memory writes are discarded replays from the old cursor and reports the same changes', async () => {
  const staged = stagedMemory(),
    h = await harness({ memory: staged.memory });
  const sync = async (cursor: string | undefined, keep: boolean) => {
    staged.begin();
    try {
      return await h.sync(cursor);
    } finally {
      if (keep) staged.commit();
      else staged.discard();
    }
  };
  try {
    h.host.deliver('INBOX', mail({ id: 'a1@sam.example', from: 'sam@example.test' }));
    h.host.deliver(
      'Archive',
      mail({ id: 'b1@lee.example', from: 'lee@example.test', subject: 'Invoice' }),
      ['\\Seen'],
    );
    const first = await sync(undefined, true);
    const review = one(first.threads, 'Studio review'),
      invoice = one(first.threads, 'Invoice');
    h.host.deliver(
      'INBOX',
      mail({
        id: 'a2@sam.example',
        from: 'sam@example.test',
        subject: 'Re: Studio review',
        inReplyTo: 'a1@sam.example',
      }),
    );
    h.host.expunge('b1@lee.example');
    let result: SyncResult | undefined;
    for (const keep of [false, true]) {
      result = await sync(first.cursor, keep);
      assert.deepEqual(
        result.threads.map(t => [t.id, t.messages.map(m => m.id)]),
        [[review.id, ['a1@sam.example', 'a2@sam.example']]],
        `reply reported (kept: ${keep})`,
      );
      assert.deepEqual(result.removed, [invoice.id], `deletion reported (kept: ${keep})`);
    }
    // A copy found missing while changing a thread outside sync is reported by the next sync, even if that sync is replayed.
    h.host.expunge('a2@sam.example');
    await h.imap.updateThread(
      h.account,
      { remoteId: review.remoteId, status: 'new', labels: ['INBOX'] },
      { unread: false },
    );
    for (const keep of [false, true]) {
      const next = await sync(result!.cursor, keep);
      assert.deepEqual(
        next.threads.map(t => [t.id, t.messages.map(m => m.id)]),
        [[review.id, ['a1@sam.example']]],
        `lost copy reported (kept: ${keep})`,
      );
      if (keep) result = next;
    }
    const quiet = await sync(result!.cursor, true);
    assert.deepEqual([quiet.threads, quiet.removed], [[], []]);
  } finally {
    await h.cleanup();
  }
});

test('calendar calls go to the CalDAV backend with the account login', async () => {
  const calls: Array<[string, CalendarCredentials]> = [];
  const calendar: CalendarBackend = {
    verify: async c => {
      calls.push(['verify', c]);
    },
    listCalendars: async (c, a) => {
      calls.push(['list', c]);
      return [{ id: 'home', name: 'Home', accountId: a.id }];
    },
    listEvents: async c => {
      calls.push(['events', c]);
      return [];
    },
    saveEvent: async (c, _a, e) => {
      calls.push(['save', c]);
      return { ...e, remoteId: 'r1' };
    },
    deleteEvent: async c => {
      calls.push(['delete', c]);
    },
  };
  const h = await harness({ calendar });
  try {
    const account: Account = h.account;
    assert.equal(account.calendarConnected, true);
    assert.equal(h.imap.capabilities(account).calendar, true);
    assert.deepEqual(await h.imap.listCalendars(account), [
      { id: 'home', name: 'Home', accountId: account.id },
    ]);
    const event = {
      id: 'e1',
      accountId: account.id,
      calendarId: 'home',
      title: 'Review',
      start: '2026-10-16T10:00:00Z',
      end: '2026-10-16T11:00:00Z',
      allDay: false,
      location: '',
      description: '',
      guests: [],
    };
    assert.equal((await h.imap.saveEvent(account, event)).remoteId, 'r1');
    await h.imap.listEvents(account);
    await h.imap.deleteEvent(account, { ...event, remoteId: 'r1' });
    const login = { url: 'https://caldav.icloud.com', username: ME, password: PASSWORD };
    assert.deepEqual(
      calls.map(c => c[0]),
      ['verify', 'list', 'save', 'events', 'delete'],
    );
    for (const [, credentials] of calls) assert.deepEqual(credentials, login);
    assert.equal(h.imap.capabilities({ ...account, calendarConnected: false }).calendar, false);
    await assert.rejects(
      h.imap.listEvents({ ...account, calendarConnected: false }),
      /Calendar is not connected/,
    );
  } finally {
    await h.cleanup();
  }
});
