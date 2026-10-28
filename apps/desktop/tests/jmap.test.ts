import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, Draft, Thread } from '@aplos/contract/legacy/types';
import type { ProviderMemory } from '@aplos/engine/legacy/provider';
import { createJmap, JmapError, JMAP_PRESETS } from '../src/main/jmap';

type Json = Record<string, any>;
const SESSION = JMAP_PRESETS.fastmail.sessionUrl,
  TOKEN = 'fmu1-test-token-not-real';
const xor = (b: Buffer) => Buffer.from(b.map(x => x ^ 0x5a));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A small in-memory JMAP server covering the methods the adapter calls. */
class FakeJmap {
  mailboxes: Json[] = [
    { id: 'mb-inbox', name: 'Inbox', role: 'inbox', parentId: null },
    { id: 'mb-archive', name: 'Archive', role: 'archive', parentId: null },
    { id: 'mb-sent', name: 'Sent', role: 'sent', parentId: null },
    { id: 'mb-trash', name: 'Trash', role: 'trash', parentId: null },
    { id: 'mb-junk', name: 'Spam', role: 'junk', parentId: null },
    { id: 'mb-drafts', name: 'Drafts', role: 'drafts', parentId: null },
    { id: 'mb-work', name: 'Work', role: null, parentId: null },
  ];
  identities: Json[] = [
    {
      id: 'id-1',
      name: 'Alex',
      email: 'alex@example.test',
      htmlSignature: '<b>Alex</b>',
      textSignature: '',
      mayDelete: false,
    },
    {
      id: 'id-2',
      name: 'Alex at Work',
      email: 'alex@work.test',
      htmlSignature: '',
      textSignature: 'Thanks\nAlex',
      mayDelete: true,
    },
    {
      id: 'id-3',
      name: '',
      email: '*@alias.test',
      htmlSignature: '',
      textSignature: '',
      mayDelete: true,
    },
  ];
  capabilities: string[] = [
    'urn:ietf:params:jmap:core',
    'urn:ietf:params:jmap:mail',
    'urn:ietf:params:jmap:submission',
  ];
  emails = new Map<string, Json>();
  blobs = new Map<string, { data: Buffer; type: string }>();
  submissions: Json[] = [];
  log: {
    v: number;
    kind: 'email' | 'thread';
    id: string;
    op: 'created' | 'updated' | 'destroyed';
  }[] = [];
  version = 0;
  minState = 0;
  pageSize = Infinity;
  maxGet = 1000;
  calls: Json[][] = [];
  auth: string[] = [];
  requests: { url: string; auth: string; redirect?: string; method: string; body?: string }[] = [];
  offline = false;
  httpStatus = 0;
  methodError = '';
  rejectSubmission = false;
  /** The implicit Email/set after a submission fails, leaving the sent message as a draft. */
  failImplicitMove = false;
  /** The next request that submits mail is processed but its response never arrives. */
  loseResponse = false;
  sessionPatch: Json = {};
  redirects = new Map<string, [number, string]>();
  after?: (name: string) => void;
  private next = 100;
  id(prefix: string) {
    return `${prefix}${this.next++}`;
  }
  emailIds(threadId: string) {
    return [...this.emails.values()]
      .filter(e => e.threadId === threadId)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
      .map(e => e.id);
  }
  record(kind: 'email' | 'thread', id: string, op: 'created' | 'updated' | 'destroyed') {
    this.log.push({ v: ++this.version, kind, id, op });
  }
  add(e: Json) {
    const fresh = !this.emailIds(e.threadId).length;
    const email: Json = {
      keywords: {},
      to: [{ name: 'Alex', email: 'alex@example.test' }],
      cc: [],
      references: null,
      attachments: [],
      preview: String(e.text ?? '').slice(0, 10),
      textBody: [{ partId: '1', type: 'text/plain' }],
      htmlBody: e.html
        ? [{ partId: '2', type: 'text/html' }]
        : [{ partId: '1', type: 'text/plain' }],
      bodyValues: { '1': { value: e.text ?? '' }, ...(e.html ? { '2': { value: e.html } } : {}) },
      ...e,
    };
    delete email.text;
    delete email.html;
    this.emails.set(e.id, email);
    this.record('email', e.id, 'created');
    this.record('thread', e.threadId, fresh ? 'created' : 'updated');
    return email;
  }
  update(id: string, patch: Json) {
    const e = this.emails.get(id)!;
    for (const [key, value] of Object.entries(patch)) {
      const [prop, sub] = key.split('/');
      if (sub === undefined) e[prop] = structuredClone(value);
      else if (value === null || value === false) delete e[prop][sub];
      else e[prop][sub] = value;
    }
    this.record('email', id, 'updated');
  }
  destroy(id: string) {
    const e = this.emails.get(id)!;
    this.emails.delete(id);
    this.record('email', id, 'destroyed');
    this.record('thread', e.threadId, this.emailIds(e.threadId).length ? 'updated' : 'destroyed');
  }
  changes(kind: 'email' | 'thread', since: string, max: number): Json | [string, Json] {
    const from = Number(since);
    if (!Number.isFinite(from) || from < this.minState)
      return ['error', { type: 'cannotCalculateChanges' }];
    const all = this.log.filter(x => x.kind === kind && x.v > from),
      page = all.slice(0, Math.min(max, this.pageSize));
    const more = page.length < all.length,
      newState = more ? page.at(-1)!.v : this.version;
    const ops = new Map<string, string[]>();
    for (const x of page) ops.set(x.id, [...(ops.get(x.id) ?? []), x.op]);
    const created: string[] = [],
      updated: string[] = [],
      destroyed: string[] = [];
    for (const [id, list] of ops) {
      const born = list[0] === 'created',
        dead = list.at(-1) === 'destroyed';
      if (born && dead) continue;
      (born ? created : dead ? destroyed : updated).push(id);
    }
    return {
      oldState: since,
      newState: String(newState),
      hasMoreChanges: more,
      created,
      updated,
      destroyed,
    };
  }
  matches(e: Json, f: Json | undefined): boolean {
    if (!f) return true;
    if (f.operator === 'AND') return f.conditions.every((c: Json) => this.matches(e, c));
    if (f.inMailbox && !e.mailboxIds[f.inMailbox]) return false;
    if (
      f.inMailboxOtherThan &&
      !Object.keys(e.mailboxIds).some(id => !f.inMailboxOtherThan.includes(id))
    )
      return false;
    if (
      f.text &&
      !`${e.subject} ${Object.values(e.bodyValues)
        .map((v: any) => v.value)
        .join(' ')}`
        .toLowerCase()
        .includes(f.text.toLowerCase())
    )
      return false;
    if (
      f.header &&
      !(
        f.header[0] === 'Message-ID' &&
        (e.messageId ?? []).some((m: string) => m.includes(f.header[1]))
      )
    )
      return false;
    if (f.hasKeyword && !e.keywords[f.hasKeyword]) return false;
    if (f.notKeyword && e.keywords[f.notKeyword]) return false;
    return true;
  }
  resolve(args: Json, responses: any[]): Json {
    const out: Json = {};
    for (const [key, value] of Object.entries(args)) {
      if (!key.startsWith('#')) {
        out[key] = value;
        continue;
      }
      const source = responses.find(r => r[2] === value.resultOf && r[0] === value.name)?.[1];
      let result: any = [source];
      for (const part of value.path.split('/').slice(1))
        result = part === '*' ? result.flat() : result.map((x: any) => x?.[part]);
      out[key.slice(1)] = result.flat();
    }
    return out;
  }
  /** Only the requested properties, like a real server; body values only for the parts the fetch flags ask for. */
  project(e: Json, args: Json): Json {
    const out: Json = args.properties
      ? Object.fromEntries(
          ['id', ...args.properties].filter(p => p in e).map(p => [p, structuredClone(e[p])]),
        )
      : structuredClone(e);
    if ('bodyValues' in out) {
      const parts = new Set(
        [
          ...(args.fetchTextBodyValues ? (e.textBody ?? []) : []),
          ...(args.fetchHTMLBodyValues ? (e.htmlBody ?? []) : []),
        ].map((p: Json) => p.partId),
      );
      out.bodyValues = Object.fromEntries(
        Object.entries(e.bodyValues ?? {}).filter(([k]) => parts.has(k)),
      );
    }
    return out;
  }
  handle(
    name: string,
    args: Json,
    responses: any[],
    creations: Map<string, string>,
    id: string,
  ): any[] {
    const out = this.method(name, args, responses, creations, id);
    this.after?.(name);
    return out;
  }
  method(
    name: string,
    args: Json,
    responses: any[],
    creations: Map<string, string>,
    id: string,
  ): any[] {
    if (this.methodError) return [['error', { type: this.methodError }, id]];
    if (name.endsWith('/get') && (args.ids?.length ?? 0) > this.maxGet)
      return [['error', { type: 'requestTooLarge' }, id]];
    const state = String(this.version);
    switch (name) {
      case 'Mailbox/get':
        return [[name, { state: 'm1', list: structuredClone(this.mailboxes), notFound: [] }, id]];
      case 'Mailbox/set': {
        const created: Json = {};
        for (const [key, box] of Object.entries(args.create ?? {}) as [string, Json][]) {
          const mid = this.id('mb-');
          this.mailboxes.push({ id: mid, parentId: null, role: null, isSubscribed: true, ...box });
          created[key] = { id: mid };
        }
        return [[name, { created }, id]];
      }
      case 'Identity/get':
        return [[name, { state: 'i1', list: structuredClone(this.identities), notFound: [] }, id]];
      case 'Email/query': {
        let list = [...this.emails.values()]
          .filter(e => this.matches(e, args.filter))
          .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
        if (args.collapseThreads) {
          const seen = new Set();
          list = list.filter(e => !seen.has(e.threadId) && seen.add(e.threadId));
        }
        const position = args.position ?? 0;
        return [
          [
            name,
            {
              queryState: state,
              position,
              total: list.length,
              ids: list.slice(position, position + (args.limit ?? Infinity)).map(e => e.id),
            },
            id,
          ],
        ];
      }
      case 'Email/get': {
        const ids: string[] = args.ids ?? [];
        const list = ids
          .filter(x => this.emails.has(x))
          .map(x => this.project(this.emails.get(x)!, args));
        return [[name, { state, list, notFound: ids.filter(x => !this.emails.has(x)) }, id]];
      }
      case 'EmailSubmission/query': {
        const list = this.submissions.filter(
          s => !args.filter?.emailIds || args.filter.emailIds.includes(s.emailId),
        );
        return [
          [
            name,
            {
              queryState: 'q1',
              position: 0,
              ids: list.slice(0, args.limit ?? Infinity).map(s => s.id),
            },
            id,
          ],
        ];
      }
      case 'EmailSubmission/get': {
        const ids: string[] = args.ids ?? [],
          list = this.submissions
            .filter(s => ids.includes(s.id))
            .map(s => ({ id: s.id, emailId: s.emailId, undoStatus: s.undoStatus ?? 'final' }));
        return [
          [name, { state: 's1', list, notFound: ids.filter(x => !list.some(s => s.id === x)) }, id],
        ];
      }
      case 'Thread/get': {
        const ids = [...new Set(args.ids as string[])],
          found = ids.filter(t => this.emailIds(t).length);
        return [
          [
            name,
            {
              state,
              list: found.map(t => ({ id: t, emailIds: this.emailIds(t) })),
              notFound: ids.filter(t => !found.includes(t)),
            },
            id,
          ],
        ];
      }
      case 'Email/changes':
      case 'Thread/changes': {
        const result = this.changes(
          name === 'Email/changes' ? 'email' : 'thread',
          args.sinceState,
          args.maxChanges ?? 500,
        );
        return Array.isArray(result) ? [[...result, id]] : [[name, result, id]];
      }
      case 'Email/set': {
        const created: Json = {},
          updated: Json = {},
          notUpdated: Json = {},
          destroyed: string[] = [];
        for (const [key, draft] of Object.entries(args.create ?? {}) as [string, Json][]) {
          const parent =
            draft.inReplyTo?.[0] &&
            [...this.emails.values()].find(e => e.messageId?.includes(draft.inReplyTo[0]));
          const e = this.add({
            receivedAt: new Date(Date.now() + this.next * 1000).toISOString(),
            ...structuredClone(draft),
            id: this.id('e-'),
            threadId: parent ? parent.threadId : this.id('t-'),
          });
          creations.set(key, e.id);
          created[key] = { id: e.id, threadId: e.threadId, blobId: this.id('b-'), size: 1 };
        }
        for (const [key, patch] of Object.entries(args.update ?? {}) as [string, Json][]) {
          if (!this.emails.has(key)) {
            notUpdated[key] = { type: 'notFound' };
            continue;
          }
          this.update(key, patch);
          updated[key] = null;
        }
        for (const key of args.destroy ?? [])
          if (this.emails.has(key)) {
            this.destroy(key);
            destroyed.push(key);
          }
        return [
          [name, { newState: String(this.version), created, updated, notUpdated, destroyed }, id],
        ];
      }
      case 'EmailSubmission/set': {
        const out: any[] = [],
          created: Json = {},
          notCreated: Json = {},
          updates: Json = {};
        for (const [key, raw] of Object.entries(args.create ?? {}) as [string, Json][]) {
          const sub: Json = {
            ...raw,
            emailId: String(raw.emailId).startsWith('#')
              ? creations.get(raw.emailId.slice(1))
              : raw.emailId,
          };
          if (
            this.rejectSubmission ||
            !this.identities.some(i => i.id === sub.identityId) ||
            !this.emails.has(sub.emailId)
          ) {
            notCreated[key] = { type: 'forbiddenFrom' };
            continue;
          }
          const sid = this.id('s-');
          this.submissions.push({ id: sid, ...sub });
          created[key] = { id: sid };
          const patch = args.onSuccessUpdateEmail?.[`#${key}`];
          if (patch) updates[sub.emailId] = patch;
        }
        out.push([name, { created, notCreated }, id]);
        if (Object.keys(updates).length && this.failImplicitMove)
          out.push([
            'Email/set',
            {
              newState: String(this.version),
              updated: {},
              notUpdated: Object.fromEntries(
                Object.keys(updates).map(k => [k, { type: 'serverFail' }]),
              ),
            },
            id,
          ]);
        else if (Object.keys(updates).length)
          out.push(...this.handle('Email/set', { update: updates }, responses, creations, id));
        return out;
      }
      default:
        return [['error', { type: 'unknownMethod' }, id]];
    }
  }
  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input),
      json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
    const headers = new Headers(init.headers),
      authorization = headers.get('authorization') ?? '';
    this.requests.push({
      url,
      auth: authorization,
      redirect: init.redirect,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    if (this.offline) throw new TypeError('fetch failed');
    const hop = this.redirects.get(url);
    if (hop) return new Response(null, { status: hop[0], headers: { Location: hop[1] } });
    if (url.startsWith('https://cdn.test/')) return new Response('cdn bytes');
    if (!url.startsWith('https://')) return new Response('plain http was used', { status: 200 });
    this.auth.push(authorization);
    if (authorization !== `Bearer ${TOKEN}`) return new Response('', { status: 401 });
    if (this.httpStatus) return new Response('', { status: this.httpStatus });
    if (url === SESSION)
      return json({
        capabilities: Object.fromEntries(
          this.capabilities.map(c => [
            c,
            c.endsWith('core') ? { maxObjectsInGet: this.maxGet, maxCallsInRequest: 16 } : {},
          ]),
        ),
        accounts: {
          acc1: { name: 'alex@example.test', isPersonal: true, accountCapabilities: {} },
        },
        primaryAccounts: Object.fromEntries(this.capabilities.map(c => [c, 'acc1'])),
        username: 'alex@example.test',
        apiUrl: 'https://api.test/jmap/api/',
        downloadUrl: 'https://api.test/jmap/download/{accountId}/{blobId}/{name}?type={type}',
        uploadUrl: 'https://api.test/jmap/upload/{accountId}/',
        eventSourceUrl: 'https://api.test/events',
        state: 's1',
        ...this.sessionPatch,
      });
    if (url === 'https://api.test/jmap/upload/acc1/') {
      const blobId = this.id('blob-'),
        data = Buffer.from(init.body as Uint8Array);
      this.blobs.set(blobId, { data, type: String(headers.get('content-type')) });
      return json({
        accountId: 'acc1',
        blobId,
        type: 'application/octet-stream',
        size: data.length,
      });
    }
    const download = url.match(/^https:\/\/api\.test\/jmap\/download\/acc1\/([^/]+)\//);
    if (download) {
      const blob = this.blobs.get(decodeURIComponent(download[1]));
      return blob ? new Response(new Uint8Array(blob.data)) : new Response('', { status: 404 });
    }
    if (url === 'https://api.test/jmap/api/' || url === 'https://api.test/jmap/moved/') {
      const body = JSON.parse(String(init.body));
      this.calls.push(body.methodCalls);
      const responses: any[] = [],
        creations = new Map<string, string>();
      for (const [name, args, id] of body.methodCalls)
        responses.push(
          ...this.handle(name, this.resolve(args, responses), responses, creations, id),
        );
      if (
        this.loseResponse &&
        body.methodCalls.some((c: any[]) => c[0] === 'EmailSubmission/set')
      ) {
        this.loseResponse = false;
        throw new TypeError('fetch failed');
      }
      return json({ methodResponses: responses, sessionState: 's1' });
    }
    return new Response('', { status: 404 });
  };
  /** The calls of every request so far, flattened, filtered by method name. */
  called(name: string) {
    return this.calls
      .flat()
      .filter(c => c[0] === name)
      .map(c => c[1]);
  }
}

function seed(server: FakeJmap) {
  server.blobs.set('blob-menu', { data: Buffer.from('menu bytes'), type: 'application/pdf' });
  server.add({
    id: 'e1',
    threadId: 'T1',
    mailboxIds: { 'mb-inbox': true },
    from: [{ name: 'Sam', email: 'sam@example.test' }],
    subject: 'Lunch',
    receivedAt: '2026-10-14T10:00:00Z',
    messageId: ['m1@example.test'],
    text: 'Lunch on Friday?',
    html: '<p>Lunch on <b>Friday</b>?</p>',
    attachments: [
      { partId: '3', blobId: 'blob-menu', name: 'menu.pdf', type: 'application/pdf', size: 10 },
    ],
  });
  server.add({
    id: 'e2',
    threadId: 'T2',
    mailboxIds: { 'mb-archive': true, 'mb-work': true },
    keywords: { $seen: true, $flagged: true },
    from: [{ name: 'Lee', email: 'lee@example.test' }],
    subject: 'Report',
    receivedAt: '2026-10-13T09:00:00Z',
    messageId: ['m2@example.test'],
    text: 'Draft report attached',
  });
  server.add({
    id: 'e3',
    threadId: 'T2',
    mailboxIds: { 'mb-sent': true },
    keywords: { $seen: true },
    from: [{ name: 'Alex', email: 'alex@example.test' }],
    to: [{ name: 'Lee', email: 'lee@example.test' }],
    subject: 'Re: Report',
    receivedAt: '2026-10-13T11:00:00Z',
    messageId: ['m3@example.test'],
    references: ['m2@example.test'],
    text: 'Thanks',
  });
  server.add({
    id: 'e4',
    threadId: 'T3',
    mailboxIds: { 'mb-trash': true },
    keywords: { $seen: true },
    from: [{ name: 'Old', email: 'old@example.test' }],
    subject: 'Old news',
    receivedAt: '2026-10-01T09:00:00Z',
    messageId: ['m4@example.test'],
    text: 'Old',
  });
  server.add({
    id: 'e5',
    threadId: 'T4',
    mailboxIds: { 'mb-junk': true },
    from: [{ name: 'Win', email: 'win@spam.test' }],
    subject: 'You won',
    receivedAt: '2026-10-12T09:00:00Z',
    messageId: ['m5@example.test'],
    text: 'Prize',
  });
  server.add({
    id: 'e6',
    threadId: 'T5',
    mailboxIds: { 'mb-drafts': true },
    keywords: { $draft: true, $seen: true },
    from: [{ name: 'Alex', email: 'alex@example.test' }],
    subject: 'Unfinished',
    receivedAt: '2026-10-14T12:00:00Z',
    messageId: ['m6@example.test'],
    text: 'Draft',
  });
}

async function harness(options: { seed?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-jmap-'));
  const server = new FakeJmap();
  if (options.seed !== false) seed(server);
  const cleared: string[] = [];
  const memory: ProviderMemory = {
    get: () => undefined,
    set: () => {},
    clear: id => {
      cleared.push(id);
    },
  };
  const jmap = await createJmap({
    dataDir,
    fetch: server.fetch as typeof fetch,
    encrypt: v => xor(Buffer.from(v)),
    decrypt: b => xor(b).toString(),
    memory,
  });
  const account = await jmap.connect({ provider: 'jmap', preset: 'fastmail', secret: TOKEN });
  return {
    dataDir,
    server,
    jmap,
    account,
    cleared,
    cleanup: async () => {
      await jmap.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
const has = (threads: Thread[]) => {
  const ids = new Set(threads.map(t => t.id));
  return { has: (id: string) => ids.has(id) };
};
const draft = (patch: Partial<Draft> = {}): Draft => ({
  id: 'd1',
  accountId: 'jmap-acc1',
  to: 'Sam <sam@example.test>',
  cc: '',
  bcc: '',
  subject: 'Hello',
  html: '<p>Hi there</p>',
  attachments: [],
  mode: 'new',
  updatedAt: '2026-10-14T10:00:00Z',
  signature: false,
  revision: 1,
  ...patch,
});

test('connect verifies the token, stores it encrypted and builds sending addresses from identities', async () => {
  const h = await harness();
  try {
    const a = h.account;
    assert.equal(a.id, 'jmap-acc1');
    assert.equal(a.provider, 'jmap');
    assert.equal(a.preset, 'fastmail');
    assert.equal(a.email, 'alex@example.test');
    assert.equal(a.name, 'Alex');
    assert.equal(a.calendarConnected, false);
    assert.equal(a.capabilities?.calendar, false);
    assert.equal(a.capabilities?.labels, false);
    assert.equal(a.capabilities?.serverSearch, true);
    assert.deepEqual(
      a.sendAs,
      [
        { email: 'alex@example.test', name: 'Alex', signature: '<b>Alex</b>', isDefault: true },
        {
          email: 'alex@work.test',
          name: 'Alex at Work',
          signature: 'Thanks<br>Alex',
          isDefault: false,
        },
      ],
      'wildcard identities are not offered as addresses',
    );
    assert.ok(h.server.auth.every(v => v === `Bearer ${TOKEN}`));
    const saved = await readFile(join(h.dataDir, 'jmap-credentials.enc.json'), 'utf8');
    assert.ok(
      saved.includes('jmap-acc1') && !saved.includes(TOKEN),
      'the token is only stored encrypted',
    );
    await h.jmap.disconnect(a.id);
    assert.deepEqual(h.cleared, ['jmap-acc1']);
    assert.ok(
      !(await readFile(join(h.dataDir, 'jmap-credentials.enc.json'), 'utf8')).includes('jmap-acc1'),
    );
    await assert.rejects(
      h.jmap.sync(a, undefined, { has: () => false }),
      (e: JmapError) => e.status === 401 && /reconnect/i.test(e.message),
    );
    h.server.capabilities = h.server.capabilities.filter(c => !c.endsWith('submission'));
    await assert.rejects(
      h.jmap.connect({ provider: 'jmap', secret: TOKEN }),
      (e: JmapError) => e.status === 403 && /Email submission/.test(e.message),
    );
    await assert.rejects(
      h.jmap.connect({ provider: 'jmap', secret: 'wrong' }),
      (e: JmapError) => e.status === 401 && !e.uncertain,
    );
  } finally {
    await h.cleanup();
  }
});

test('first sync normalizes threads, status and role labels and skips drafts', async () => {
  const h = await harness();
  try {
    const result = await h.jmap.sync(h.account, undefined, { has: () => false });
    assert.equal(result.reset, true);
    assert.deepEqual(JSON.parse(result.cursor!), {
      email: String(h.server.version),
      thread: String(h.server.version),
    });
    const by = new Map(result.threads.map(t => [t.remoteId, t]));
    assert.deepEqual(
      [...by.keys()].sort(),
      ['T1', 'T2', 'T3', 'T4'],
      'a thread holding only a draft is not shown',
    );
    const t1 = by.get('T1')!;
    assert.equal(t1.id, 'jmap-acc1:T1');
    assert.equal(t1.status, 'new');
    assert.equal(t1.unread, true);
    assert.deepEqual(t1.labels, ['INBOX', 'UNREAD']);
    const m = t1.messages[0];
    assert.equal(m.id, 'e1');
    assert.equal(m.internetId, '<m1@example.test>');
    assert.equal(m.text, 'Lunch on Friday?');
    assert.equal(m.html, '<p>Lunch on <b>Friday</b>?</p>');
    assert.equal(m.fromName, 'Sam');
    assert.equal(m.sent, false);
    assert.deepEqual(m.attachments, [
      {
        id: 'e1:3',
        name: 'menu.pdf',
        type: 'application/pdf',
        size: 10,
        remoteId: 'blob-menu',
        messageId: 'e1',
        contentId: undefined,
      },
    ]);
    const t2 = by.get('T2')!;
    assert.equal(t2.status, 'done');
    assert.equal(t2.unread, false);
    assert.equal(t2.bookmarked, true);
    assert.deepEqual(t2.labels, ['ARCHIVE', 'Work', 'SENT', 'STARRED']);
    assert.deepEqual(
      t2.messages.map(x => [x.id, x.sent]),
      [
        ['e2', false],
        ['e3', true],
      ],
    );
    assert.equal(t2.messages[1].references, '<m2@example.test>');
    assert.equal(by.get('T3')!.status, 'trash');
    assert.equal(by.get('T4')!.status, 'spam');
    assert.deepEqual(by.get('T4')!.labels, ['SPAM', 'UNREAD']);
    const file = await h.jmap.attachment(h.account, t1, m.attachments[0]);
    assert.equal(Buffer.from(file.data!, 'base64').toString(), 'menu bytes');
    const get = h.server.called('Email/get').find(a => a.fetchHTMLBodyValues)!;
    assert.equal(get.fetchTextBodyValues, true);
    assert.equal(get.maxBodyValueBytes, 1_000_000);
    assert.ok(get.properties.includes('bodyValues'), 'body values are requested explicitly');
    assert.equal(
      by.get('T2')!.messages[0].text,
      'Draft report attached',
      'the full body, not the short preview',
    );
    const q = h.server.called('Email/query')[0];
    assert.equal(q.collapseThreads, true);
    assert.equal(q.limit, 500);
    assert.deepEqual(q.sort, [{ property: 'receivedAt', isAscending: false }]);
  } finally {
    await h.cleanup();
  }
});

test('incremental sync returns new mail as threads, keyword and folder changes as flags, and removals', async () => {
  const h = await harness();
  try {
    const first = await h.jmap.sync(h.account, undefined, { has: () => false });
    h.server.add({
      id: 'e7',
      threadId: 'T1',
      mailboxIds: { 'mb-inbox': true },
      from: [{ name: 'Sam', email: 'sam@example.test' }],
      subject: 'Re: Lunch',
      receivedAt: '2026-10-14T13:00:00Z',
      messageId: ['m7@example.test'],
      text: 'Noon works',
    });
    h.server.update('e2', { 'keywords/$flagged': null });
    h.server.destroy('e4');
    h.server.add({
      id: 'e8',
      threadId: 'T9',
      mailboxIds: { 'mb-archive': true },
      keywords: { $seen: true },
      from: [{ name: 'X', email: 'x@example.test' }],
      subject: 'Elsewhere',
      receivedAt: '2026-10-14T14:00:00Z',
      messageId: ['m8@example.test'],
      text: 'Hi',
    });
    h.server.pageSize = 1;
    const second = await h.jmap.sync(h.account, first.cursor, has(first.threads));
    assert.equal(second.reset, false);
    assert.ok(h.server.called('Email/changes').length > 1, 'follows hasMoreChanges across pages');
    assert.deepEqual(
      second.threads.map(t => [t.remoteId, t.messages.map(m => m.id)]),
      [
        ['T9', ['e8']],
        ['T1', ['e1', 'e7']],
      ],
      'new mail arrives as full threads',
    );
    assert.deepEqual(second.flags, [
      {
        id: 'jmap-acc1:T2',
        unread: false,
        bookmarked: false,
        status: 'done',
        labels: ['ARCHIVE', 'Work', 'SENT'],
      },
    ]);
    assert.deepEqual(second.removed, ['jmap-acc1:T3']);
    h.server.pageSize = Infinity;
    const known = has([...first.threads, ...second.threads]);
    h.server.update('e1', { mailboxIds: { 'mb-archive': true } });
    h.server.update('e7', { mailboxIds: { 'mb-archive': true }, 'keywords/$seen': true });
    const third = await h.jmap.sync(h.account, second.cursor, known);
    assert.deepEqual(third.threads, []);
    assert.deepEqual(
      third.flags.map(f => [f.id, f.status, f.unread, f.labels]),
      [['jmap-acc1:T1', 'done', true, ['ARCHIVE', 'UNREAD']]],
      'a move out of the inbox is a flag change',
    );
    h.server.update('e5', { 'keywords/$seen': true });
    const unknown = await h.jmap.sync(h.account, third.cursor, {
      has: id => id !== 'jmap-acc1:T4',
    });
    assert.deepEqual(
      unknown.threads,
      [],
      'a thread not on this device is only fetched once it is in the inbox',
    );
    assert.deepEqual(unknown.flags, []);
  } finally {
    await h.cleanup();
  }
});

test('a cursor the server can no longer resolve returns a fresh window', async () => {
  const h = await harness();
  try {
    const first = await h.jmap.sync(h.account, undefined, { has: () => false });
    h.server.add({
      id: 'e9',
      threadId: 'T1',
      mailboxIds: { 'mb-inbox': true },
      from: [{ name: 'Sam', email: 'sam@example.test' }],
      subject: 'Re: Lunch',
      receivedAt: '2026-10-14T15:00:00Z',
      messageId: ['m9@example.test'],
      text: 'Later',
    });
    h.server.minState = h.server.version;
    const result = await h.jmap.sync(h.account, first.cursor, has(first.threads));
    assert.equal(result.reset, true);
    assert.equal(result.threads.length, 4);
    assert.equal(JSON.parse(result.cursor!).email, String(h.server.version));
    assert.equal((await h.jmap.sync(h.account, 'not json', has(first.threads))).reset, true);
  } finally {
    await h.cleanup();
  }
});

test('updateThread archives, trashes, restores, marks spam, read and starred through Email/set', async () => {
  const h = await harness();
  try {
    const boxes = (id: string) => Object.keys(h.server.emails.get(id)!.mailboxIds).sort();
    const kw = (id: string) => h.server.emails.get(id)!.keywords;
    await h.jmap.updateThread(
      h.account,
      { remoteId: 'T1', status: 'new', labels: ['INBOX', 'UNREAD'] },
      { status: 'done', labels: ['UNREAD'], unread: false },
    );
    assert.deepEqual(boxes('e1'), ['mb-archive']);
    assert.equal(kw('e1').$seen, true);
    await h.jmap.updateThread(
      h.account,
      { remoteId: 'T1', status: 'done', labels: ['ARCHIVE'] },
      { status: 'done' },
    );
    assert.deepEqual(
      boxes('e1'),
      ['mb-archive'],
      'done without an archive action leaves folders alone',
    );
    await h.jmap.updateThread(
      h.account,
      { remoteId: 'T1', status: 'done', labels: ['ARCHIVE'] },
      { status: 'trash' },
    );
    assert.deepEqual(boxes('e1'), ['mb-trash']);
    await h.jmap.updateThread(
      h.account,
      { remoteId: 'T1', status: 'trash', labels: ['TRASH'] },
      { status: 'new', labels: ['TRASH', 'INBOX'] },
    );
    assert.deepEqual(boxes('e1'), ['mb-inbox'], 'restoring from trash returns mail to the inbox');
    await h.jmap.updateThread(
      h.account,
      { remoteId: 'T1', status: 'new', labels: ['INBOX'] },
      { status: 'spam' },
    );
    assert.deepEqual(boxes('e1'), ['mb-junk']);
    await h.jmap.updateThread(
      h.account,
      { remoteId: 'T1', status: 'spam', labels: ['SPAM'] },
      { status: 'done', labels: [] },
    );
    assert.deepEqual(boxes('e1'), ['mb-archive'], 'not spam without the inbox goes to the archive');
    await h.jmap.updateThread(
      h.account,
      { remoteId: 'T2', status: 'done', labels: ['ARCHIVE', 'Work', 'SENT'] },
      { status: 'new', labels: ['ARCHIVE', 'Work', 'SENT', 'INBOX'] },
    );
    assert.deepEqual(boxes('e2'), ['mb-inbox', 'mb-work']);
    assert.deepEqual(boxes('e3'), ['mb-sent'], 'sent mail stays in Sent');
    await h.jmap.updateThread(
      h.account,
      { remoteId: 'T2', status: 'new' },
      { bookmarked: false, unread: true },
    );
    assert.equal(kw('e2').$flagged, undefined);
    assert.equal(kw('e2').$seen, undefined, 'unread marks the latest message from someone else');
    assert.equal(kw('e3').$seen, true);
    await h.jmap.updateThread(h.account, { remoteId: 'T2', status: 'new' }, { bookmarked: true });
    assert.equal(kw('e2').$flagged, true);
    assert.equal(kw('e3').$flagged, undefined);
    await assert.rejects(
      h.jmap.updateThread(h.account, { remoteId: 'gone', status: 'new' }, { unread: false }),
      (e: JmapError) => e.status === 404,
    );
    const before = h.server.called('Email/set').length;
    await h.jmap.updateThread(h.account, { remoteId: 'T2', status: 'new' }, { bookmarked: true });
    assert.equal(h.server.called('Email/set').length, before, 'no request when nothing changes');
  } finally {
    await h.cleanup();
  }
});

test('archiving creates an Archive mailbox when the server has none', async () => {
  const h = await harness();
  try {
    h.server.mailboxes = h.server.mailboxes.filter(m => m.role !== 'archive');
    await h.jmap.updateThread(
      h.account,
      { remoteId: 'T1', status: 'new', labels: ['INBOX'] },
      { status: 'done', labels: [] },
    );
    const created = h.server.mailboxes.find(m => m.role === 'archive')!;
    assert.equal(created.name, 'Archive');
    assert.deepEqual(Object.keys(h.server.emails.get('e1')!.mailboxIds), [created.id]);
  } finally {
    await h.cleanup();
  }
});

test('send creates the draft with our Message-ID, submits it and moves it to Sent in one request', async () => {
  const h = await harness();
  try {
    const first = await h.jmap.sync(h.account, undefined, { has: () => false });
    const thread = first.threads.find(t => t.remoteId === 'T1')!;
    const before = h.server.calls.length;
    const result = await h.jmap.send(
      h.account,
      draft({
        messageId: '<our-id@example.test>',
        mode: 'reply',
        threadId: thread.id,
        bcc: 'boss@example.test',
        fromEmail: 'alex@work.test',
        attachments: [
          {
            id: 'a1',
            name: 'notes.txt',
            type: 'text/plain',
            size: 5,
            data: Buffer.from('notes').toString('base64'),
          },
        ],
      }),
      thread,
    );
    const request = h.server.calls.at(-1)!;
    assert.deepEqual(
      request.map(c => c[0]),
      ['Email/set', 'EmailSubmission/set'],
      'draft and submission travel together',
    );
    assert.deepEqual(
      h.server.calls.at(-2)!.map(c => c[0]),
      ['Identity/get', 'Mailbox/get', 'Email/query', 'Email/get'],
      'earlier copies are looked up with identities and mailboxes',
    );
    assert.equal(
      h.server.calls.length - before,
      2,
      'identities and mailboxes, then the send itself',
    );
    const created = request[0][1].create.draft;
    assert.deepEqual(created.messageId, ['our-id@example.test']);
    assert.deepEqual(created.inReplyTo, ['m1@example.test']);
    assert.deepEqual(created.references, ['m1@example.test']);
    assert.deepEqual(created.from, [{ name: 'Alex at Work', email: 'alex@work.test' }]);
    assert.equal(created.bcc, undefined, 'Bcc is not written into the message');
    assert.equal(created.bodyValues.text.value, 'Hi there');
    assert.equal(created.bodyValues.html.value, '<p>Hi there</p>');
    assert.equal(h.server.blobs.get(created.attachments[0].blobId)!.data.toString(), 'notes');
    const submission = h.server.submissions[0];
    assert.equal(submission.identityId, 'id-2');
    assert.deepEqual(
      submission.envelope.rcptTo.map((r: Json) => r.email),
      ['sam@example.test', 'boss@example.test'],
    );
    const sent = h.server.emails.get(result.id!)!;
    assert.equal(result.threadId, 'T1');
    assert.deepEqual(Object.keys(sent.mailboxIds), ['mb-sent']);
    assert.equal(sent.keywords.$draft, undefined);
    assert.deepEqual(await h.jmap.findSent(h.account, '<our-id@example.test>'), {
      id: result.id,
      threadId: 'T1',
    });
    assert.equal(await h.jmap.findSent(h.account, '<missing@example.test>'), undefined);
    const next = await h.jmap.sync(h.account, first.cursor, has(first.threads));
    const t1 = next.threads.find(t => t.remoteId === 'T1')!;
    assert.equal(t1.messages.at(-1)!.sent, true);
    assert.equal(t1.status, 'new');
    await h.jmap.send(h.account, draft({ fromEmail: 'anyone@alias.test' }));
    assert.equal(
      h.server.submissions.at(-1)!.identityId,
      'id-3',
      'wildcard identities authorize matching addresses',
    );
    await assert.rejects(
      h.jmap.send(h.account, draft({ fromEmail: 'stranger@example.test' })),
      /not authorized/,
    );
  } finally {
    await h.cleanup();
  }
});

test('a rejected submission removes the draft; a retry after an unknown outcome replaces leftovers', async () => {
  const h = await harness();
  try {
    h.server.rejectSubmission = true;
    await assert.rejects(
      h.jmap.send(h.account, draft({ messageId: '<retry@example.test>' })),
      (e: JmapError) => e.status === 403 && !e.uncertain,
    );
    assert.equal(
      [...h.server.emails.values()].filter(e => e.messageId?.includes('retry@example.test')).length,
      0,
    );
    assert.equal(await h.jmap.findSent(h.account, '<retry@example.test>'), undefined);
    h.server.add({
      id: 'left',
      threadId: 'TL',
      mailboxIds: { 'mb-drafts': true },
      keywords: { $draft: true },
      from: [{ name: 'Alex', email: 'alex@example.test' }],
      subject: 'Hello',
      receivedAt: '2026-10-14T10:00:00Z',
      messageId: ['retry@example.test'],
      text: 'x',
    });
    h.server.rejectSubmission = false;
    await h.jmap.send(h.account, draft({ messageId: '<retry@example.test>' }));
    const copies = [...h.server.emails.values()].filter(e =>
      e.messageId?.includes('retry@example.test'),
    );
    assert.equal(copies.length, 1);
    assert.deepEqual(Object.keys(copies[0].mailboxIds), ['mb-sent']);
  } finally {
    await h.cleanup();
  }
});

test('failures are classified: unreachable and 5xx are uncertain, auth and rate limits are not', async () => {
  const h = await harness();
  try {
    h.server.offline = true;
    await assert.rejects(
      h.jmap.send(h.account, draft()),
      (e: unknown) => e instanceof JmapError && e.uncertain && e.status === undefined,
    );
    h.server.offline = false;
    h.server.httpStatus = 503;
    await assert.rejects(
      h.jmap.sync(h.account, undefined, { has: () => false }),
      (e: JmapError) => e.uncertain && e.status === 503,
    );
    h.server.httpStatus = 401;
    await assert.rejects(
      h.jmap.sync(h.account, undefined, { has: () => false }),
      (e: JmapError) => !e.uncertain && /reconnect/i.test(e.message),
    );
    h.server.httpStatus = 429;
    await assert.rejects(
      h.jmap.sync(h.account, undefined, { has: () => false }),
      (e: JmapError) => !e.uncertain && e.status === 429 && /retry/i.test(e.message),
    );
    h.server.httpStatus = 0;
    h.server.methodError = 'serverFail';
    await assert.rejects(
      h.jmap.updateThread(h.account, { remoteId: 'T1', status: 'new' }, { unread: false }),
      (e: JmapError) => e.uncertain && e.type === 'serverFail',
    );
    h.server.methodError = 'forbidden';
    await assert.rejects(
      h.jmap.search(h.account, 'x'),
      (e: JmapError) => !e.uncertain && e.status === 403,
    );
  } finally {
    await h.cleanup();
  }
});

test('search queries the server and returns full threads', async () => {
  const h = await harness();
  try {
    const threads = await h.jmap.search(h.account, 'friday');
    assert.deepEqual(
      threads.map(t => t.remoteId),
      ['T1'],
    );
    assert.equal(threads[0].messages[0].text, 'Lunch on Friday?');
    const q = h.server.called('Email/query').at(-1)!;
    assert.deepEqual(q.filter, {
      operator: 'AND',
      conditions: [{ text: 'friday' }, { notKeyword: 'aplos-app-data' }],
    });
    assert.equal(q.limit, 100);
    assert.equal(q.collapseThreads, true);
  } finally {
    await h.cleanup();
  }
});

test('app data copies live in a hidden Aplos mailbox, are all listed newest first and only replaced copies go', async () => {
  const h = await harness();
  try {
    const account: Account = h.account;
    assert.deepEqual(await h.jmap.readAppData(account), []);
    const first = await h.jmap.sync(account, undefined, { has: () => false });
    await h.jmap.writeAppData(account, '{"v":1}', []);
    const box = h.server.mailboxes.find(m => m.name === 'Aplos Mail Data')!;
    assert.equal(box.isSubscribed, false);
    await sleep(5);
    await h.jmap.writeAppData(account, '{"v":2,"note":"ünïcode"}', []);
    const both = await h.jmap.readAppData(account);
    assert.deepEqual(
      both.map(r => r.data),
      ['{"v":2,"note":"ünïcode"}', '{"v":1}'],
      'copies written at the same time are all returned',
    );
    await sleep(5);
    await h.jmap.writeAppData(account, '{"v":"other device"}', []);
    await sleep(5);
    await h.jmap.writeAppData(
      account,
      '{"v":3}',
      both.map(r => r.id),
    );
    assert.deepEqual(
      (await h.jmap.readAppData(account)).map(r => r.data),
      ['{"v":3}', '{"v":"other device"}'],
      'a copy written after the read survives',
    );
    assert.equal([...h.server.emails.values()].filter(e => e.mailboxIds[box.id]).length, 2);
    const next = await h.jmap.sync(account, first.cursor, has(first.threads));
    assert.deepEqual(next.threads, []);
    assert.deepEqual(next.removed, []);
    const fresh = await h.jmap.sync(account, undefined, { has: () => false });
    assert.deepEqual(fresh.threads.map(t => t.remoteId).sort(), ['T1', 'T2', 'T3', 'T4']);
    assert.deepEqual(h.server.called('Email/query').at(-1)!.filter, {
      notKeyword: 'aplos-app-data',
    });
    assert.equal((await h.jmap.search(account, 'Aplos Mail')).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('a user folder named Aplos is never read or emptied and its mail still syncs', async () => {
  const h = await harness();
  try {
    h.server.mailboxes.push({ id: 'mb-user-aplos', name: 'Aplos', role: null, parentId: null });
    h.server.add({
      id: 'eu',
      threadId: 'TU',
      mailboxIds: { 'mb-user-aplos': true },
      from: [{ name: 'Kim', email: 'kim@example.test' }],
      subject: 'Aplos project',
      receivedAt: '2026-10-14T09:00:00Z',
      messageId: ['mu@example.test'],
      text: 'Plans',
      attachments: [
        { partId: '3', blobId: 'blob-menu', name: 'menu.pdf', type: 'application/pdf', size: 10 },
      ],
    });
    assert.deepEqual(await h.jmap.readAppData(h.account), [], 'user mail is not app data');
    await h.jmap.writeAppData(h.account, '{"v":1}', ['eu']);
    assert.ok(h.server.emails.has('eu'), 'user mail is never destroyed, even when asked');
    assert.deepEqual(
      (await h.jmap.readAppData(h.account)).map(r => r.data),
      ['{"v":1}'],
    );
    assert.equal(
      [...h.server.emails.values()].filter(e => e.mailboxIds['mb-user-aplos']).length,
      1,
      'data copies go to Aplos’s own mailbox, not the user folder',
    );
    const fresh = await h.jmap.sync(h.account, undefined, { has: () => false });
    const tu = fresh.threads.find(t => t.remoteId === 'TU')!;
    assert.deepEqual(
      tu.messages.map(m => m.id),
      ['eu'],
    );
    assert.ok(tu.labels?.includes('Aplos'));
    assert.equal(fresh.threads.length, 5, 'the data copy itself stays hidden');
  } finally {
    await h.cleanup();
  }
});

test('a send whose answer was lost after submission is found and never submitted again', async () => {
  const h = await harness();
  try {
    h.server.failImplicitMove = true;
    h.server.loseResponse = true;
    await assert.rejects(
      h.jmap.send(h.account, draft({ messageId: '<lost@example.test>' })),
      (e: JmapError) => e.uncertain,
    );
    const copy = () =>
      [...h.server.emails.values()].filter(e => e.messageId?.includes('lost@example.test'));
    assert.equal(h.server.submissions.length, 1);
    assert.equal(copy()[0].keywords.$draft, true, 'the move to Sent failed');
    h.server.failImplicitMove = false;
    const found = await h.jmap.findSent(h.account, '<lost@example.test>');
    assert.deepEqual(
      found,
      { id: copy()[0].id, threadId: copy()[0].threadId },
      'a submitted draft counts as sent',
    );
    assert.deepEqual(Object.keys(copy()[0].mailboxIds), ['mb-sent']);
    assert.equal(copy()[0].keywords.$draft, undefined, 'and is filed in Sent');
    assert.deepEqual(
      await h.jmap.send(h.account, draft({ messageId: '<lost@example.test>' })),
      found,
    );
    assert.equal(h.server.submissions.length, 1);
    assert.equal(copy().length, 1);

    h.server.failImplicitMove = true;
    h.server.loseResponse = true;
    await assert.rejects(h.jmap.send(h.account, draft({ messageId: '<again@example.test>' })));
    const again = [...h.server.emails.values()].find(e =>
      e.messageId?.includes('again@example.test'),
    )!;
    h.server.failImplicitMove = false;
    assert.deepEqual(
      await h.jmap.send(h.account, draft({ messageId: '<again@example.test>' })),
      { id: again.id, threadId: again.threadId },
      'a retry returns the submitted copy',
    );
    assert.equal(h.server.submissions.length, 2);
    assert.ok(h.server.emails.has(again.id), 'a submitted draft is never destroyed');

    h.server.failImplicitMove = true;
    const ok = await h.jmap.send(h.account, draft({ messageId: '<moved@example.test>' }));
    const moved = h.server.emails.get(ok.id!)!;
    assert.deepEqual(
      Object.keys(moved.mailboxIds),
      ['mb-sent'],
      'a failed implicit move is repaired',
    );
    assert.equal(moved.keywords.$draft, undefined);
  } finally {
    await h.cleanup();
  }
});

test('mail that arrives while a fresh window loads is replayed into it', async () => {
  const h = await harness();
  try {
    let query = 0,
      threads = 0;
    h.server.after = name => {
      if (name === 'Email/query' && !query++)
        h.server.add({
          id: 'e10',
          threadId: 'T7',
          mailboxIds: { 'mb-inbox': true },
          from: [{ name: 'New', email: 'new@example.test' }],
          subject: 'Arrived',
          receivedAt: '2026-10-14T16:00:00Z',
          messageId: ['m10@example.test'],
          text: 'Just now',
        });
      if (name === 'Thread/get' && query && !threads++)
        h.server.add({
          id: 'e11',
          threadId: 'T1',
          mailboxIds: { 'mb-inbox': true },
          from: [{ name: 'Sam', email: 'sam@example.test' }],
          subject: 'Re: Lunch',
          receivedAt: '2026-10-14T17:00:00Z',
          messageId: ['m11@example.test'],
          text: 'Also',
        });
    };
    const result = await h.jmap.sync(h.account, undefined, { has: () => false });
    h.server.after = undefined;
    assert.equal(result.reset, true);
    assert.deepEqual(
      result.threads.map(t => t.remoteId),
      ['T1', 'T7', 'T2', 'T4', 'T3'],
    );
    assert.deepEqual(
      result.threads[0].messages.map(m => m.id),
      ['e1', 'e11'],
    );
    assert.deepEqual(JSON.parse(result.cursor!), {
      email: String(h.server.version),
      thread: String(h.server.version),
    });
    const next = await h.jmap.sync(h.account, result.cursor, has(result.threads));
    assert.deepEqual([next.threads, next.flags, next.removed], [[], [], []]);
  } finally {
    await h.cleanup();
  }
});

test('getters stay within the server limit for large windows and long threads', async () => {
  const h = await harness({ seed: false });
  try {
    h.server.maxGet = 256;
    for (let i = 0; i < 259; i++)
      h.server.add({
        id: `s${i}`,
        threadId: `TS${i}`,
        mailboxIds: { 'mb-inbox': true },
        from: [{ name: 'S', email: 's@example.test' }],
        subject: `n${i}`,
        receivedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        messageId: [`s${i}@example.test`],
        text: 'x',
      });
    for (let i = 0; i < 300; i++)
      h.server.add({
        id: `b${i}`,
        threadId: 'TB',
        mailboxIds: { 'mb-inbox': true },
        from: [{ name: 'B', email: 'b@example.test' }],
        subject: 'Long',
        receivedAt: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
        messageId: [`b${i}@example.test`],
        text: 'y',
      });
    await h.jmap.close();
    const first = await h.jmap.sync(h.account, undefined, { has: () => false });
    assert.equal(first.threads.length, 260);
    assert.equal(first.threads.find(t => t.remoteId === 'TB')!.messages.length, 300);
    assert.deepEqual(
      h.server.called('Email/query').map(q => [q.position, q.limit]),
      [
        [0, 256],
        [256, 244],
      ],
    );
    await h.jmap.updateThread(h.account, { remoteId: 'TB', status: 'new' }, { unread: false });
    assert.ok(
      [...h.server.emails.values()].filter(e => e.threadId === 'TB').every(e => e.keywords.$seen),
    );
    for (let i = 0; i < 260; i++)
      h.server.update(i < 259 ? `s${i}` : 'b0', { 'keywords/$flagged': true });
    const next = await h.jmap.sync(h.account, first.cursor, has(first.threads));
    assert.equal(next.flags.length, 260);
    assert.ok(next.flags.every(f => f.bookmarked));
    const sizes = h.server.calls
      .flat()
      .filter(c => c[0].endsWith('/get'))
      .map(c => c[1].ids?.length ?? 0);
    assert.ok(Math.max(...sizes) <= 256);
  } finally {
    await h.cleanup();
  }
});

test('every server address must be https and redirects never downgrade or leak the token', async () => {
  const h = await harness();
  try {
    const plain = () => h.server.requests.filter(r => !r.url.startsWith('https://'));
    h.server.sessionPatch = { apiUrl: 'http://api.test/jmap/api/' };
    await assert.rejects(
      h.jmap.connect({ provider: 'jmap', preset: 'fastmail', secret: TOKEN }),
      /https/,
    );
    h.server.sessionPatch = { uploadUrl: 'https://user:pw@api.test/jmap/upload/{accountId}/' };
    await assert.rejects(
      h.jmap.connect({ provider: 'jmap', preset: 'fastmail', secret: TOKEN }),
      /https/,
    );
    h.server.sessionPatch = {};
    h.server.redirects.set('https://api.test/jmap/api/', [307, 'http://api.test/jmap/api/']);
    await assert.rejects(h.jmap.sync(h.account, undefined, { has: () => false }), /https/);
    assert.deepEqual(plain(), [], 'nothing is sent over plain http');
    assert.ok(h.server.requests.every(r => r.redirect === 'manual'));
    h.server.redirects.set('https://api.test/jmap/api/', [308, '/jmap/moved/']);
    assert.equal(
      (await h.jmap.sync(h.account, undefined, { has: () => false })).threads.length,
      4,
      'an https redirect keeps method, body and token',
    );
    const moved = h.server.requests.filter(r => r.url === 'https://api.test/jmap/moved/');
    assert.ok(
      moved.length &&
        moved.every(r => r.method === 'POST' && r.body && r.auth === `Bearer ${TOKEN}`),
    );
    h.server.redirects.set(
      'https://api.test/jmap/download/acc1/blob-menu/menu.pdf?type=application%2Fpdf',
      [302, 'https://cdn.test/menu'],
    );
    const t1 = (await h.jmap.search(h.account, 'friday'))[0];
    assert.equal(
      Buffer.from(
        (await h.jmap.attachment(h.account, t1, t1.messages[0].attachments[0])).data!,
        'base64',
      ).toString(),
      'cdn bytes',
    );
    assert.equal(
      h.server.requests.find(r => r.url === 'https://cdn.test/menu')!.auth,
      '',
      'the token stays with its origin',
    );
    h.server.redirects.set('https://api.test/jmap/api/', [307, 'https://api.test/jmap/loop/']);
    h.server.redirects.set('https://api.test/jmap/loop/', [307, 'https://api.test/jmap/api/']);
    await assert.rejects(h.jmap.sync(h.account, undefined, { has: () => false }), /too many/);
    assert.deepEqual(plain(), []);
  } finally {
    await h.cleanup();
  }
});
