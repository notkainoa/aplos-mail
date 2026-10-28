import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { createMicrosoft, MicrosoftError } from '../src/main/microsoft';
import { createVault } from '../src/main/vault';
import type { ProviderMemory, SyncResult } from '@aplos/engine/legacy/provider';
import type { Account, CalendarEvent, Draft, Thread } from '@aplos/contract/legacy/types';

type Json = Record<string, any>;
const graph = 'https://graph.microsoft.com/v1.0';
const account: Account = {
  id: 'microsoft-u1',
  name: 'Alex',
  email: 'alex@example.test',
  provider: 'microsoft',
  connected: true,
  color: '#4f7cac',
};
const encrypt = (text: string) => Buffer.from([...Buffer.from(text)].map(x => x ^ 0x5a));
const decrypt = (buffer: Buffer) => Buffer.from([...buffer].map(x => x ^ 0x5a)).toString();
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(status === 204 || status === 202 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const FOLDER_IDS: Record<string, string> = {
  inbox: 'F-inbox',
  archive: 'F-archive',
  sentitems: 'F-sent',
  deleteditems: 'F-deleted',
  junkemail: 'F-junk',
  drafts: 'F-drafts',
};

interface FakeMessage {
  id: string;
  conversationId: string;
  folder: string;
  subject: string;
  from: string;
  to: string[];
  date: string;
  isRead: boolean;
  flagged: boolean;
  html: string;
  internetMessageId: string;
  isDraft?: boolean;
  attachments?: Json[];
  references?: string;
  props?: Record<string, string>;
}

/** A small in-memory Graph mailbox, calendar and token endpoint. Folder deltas replay a change log. */
function fakeGraph() {
  const messages = new Map<string, FakeMessage>(),
    events = new Map<string, Json>(),
    folders: Json[] = [];
  const log: { v: number; folder: string; id: string }[] = [];
  const s = {
    version: 0,
    created: 0,
    gone: false,
    tokenCalls: 0,
    renameOnMove: false,
    attachmentPage: 0,
    fail: undefined as undefined | ((method: string, url: URL) => number | undefined),
    requests: [] as { method: string; url: string; body?: any }[],
    mime: [] as string[],
    messages,
    events,
    folders,
    log,
  };
  const touch = (folder: string, id: string) => log.push({ v: ++s.version, folder, id });
  const add = (m: FakeMessage) => {
    messages.set(m.id, m);
    touch(m.folder, m.id);
  };
  const move = (id: string, folder: string, newId = id) => {
    const m = messages.get(id)!;
    touch(m.folder, id);
    messages.delete(id);
    m.id = newId;
    m.folder = folder;
    messages.set(newId, m);
    touch(folder, newId);
    return m;
  };
  const remove = (id: string) => {
    const m = messages.get(id)!;
    messages.delete(id);
    touch(m.folder, id);
  };
  const update = (id: string, patch: Partial<FakeMessage>) => {
    const m = messages.get(id)!;
    Object.assign(m, patch);
    touch(m.folder, id);
  };
  const parent = (m: FakeMessage) => FOLDER_IDS[m.folder] ?? m.folder;
  const light = (m: FakeMessage) => ({
    id: m.id,
    conversationId: m.conversationId,
    receivedDateTime: m.date,
    isRead: m.isRead,
    flag: { flagStatus: m.flagged ? 'flagged' : 'notFlagged' },
    from: { emailAddress: { address: m.from } },
    isDraft: !!m.isDraft,
    parentFolderId: parent(m),
  });
  const full = (m: FakeMessage) => ({
    ...light(m),
    createdDateTime: m.date,
    internetMessageId: m.internetMessageId,
    subject: m.subject,
    body: { contentType: 'html', content: m.html },
    bodyPreview: m.html.replace(/<[^>]+>/g, ''),
    toRecipients: m.to.map(address => ({ emailAddress: { address } })),
    ccRecipients: [],
    sentDateTime: m.date,
    hasAttachments: (m.attachments ?? []).some(a => !a.isInline),
    inferenceClassification: 'focused',
  });
  const filterValue = (filter: string | null, name: string) =>
    filter?.match(new RegExp(`${name} eq '((?:[^']|'')*)'`))?.[1].replace(/''/g, "'");
  async function route(
    method: string,
    url: URL,
    body: any,
    headers: Record<string, string>,
  ): Promise<{ status: number; body?: any; headers?: Record<string, string>; raw?: Buffer }> {
    const path = url.pathname.replace(/^\/v1\.0/, ''),
      p = url.searchParams;
    let match: RegExpMatchArray | null;
    if (path === '/$batch') {
      const responses = [];
      for (const r of body.requests) {
        const sub = await route(r.method, new URL(`${graph}${r.url}`), r.body, r.headers ?? {});
        responses.push({
          id: r.id,
          status: sub.status,
          headers: sub.headers ?? {},
          body: sub.body,
        });
      }
      return { status: 200, body: { responses } };
    }
    const injected = s.fail?.(method, url);
    if (injected) return { status: injected, body: { error: { code: 'ServiceUnavailable' } } };
    assert.match(headers.Prefer ?? headers.prefer ?? '', /IdType="ImmutableId"/);
    if ((match = path.match(/^\/me\/mailFolders\/(\w+)\/messages\/delta$/))) {
      const folder = match[1];
      if (p.has('$deltatoken')) {
        if (s.gone)
          return { status: 410, body: { error: { code: 'syncStateNotFound', message: 'gone' } } };
        const since = Number(p.get('$deltatoken')),
          ids = [...new Set(log.filter(e => e.folder === folder && e.v > since).map(e => e.id))];
        const value = ids.map(id => {
          const m = messages.get(id);
          return m && m.folder === folder ? light(m) : { id, '@removed': { reason: 'deleted' } };
        });
        return {
          status: 200,
          body: {
            value,
            '@odata.deltaLink': `${graph}/me/mailFolders/${folder}/messages/delta?$deltatoken=${s.version}`,
          },
        };
      }
      const cutoff = p.get('$filter')?.match(/receivedDateTime ge (\S+)/)?.[1];
      const value = [...messages.values()]
        .filter(m => m.folder === folder && (!cutoff || m.date >= new Date(cutoff).toISOString()))
        .map(light);
      return {
        status: 200,
        body: {
          value,
          '@odata.deltaLink': `${graph}/me/mailFolders/${folder}/messages/delta?$deltatoken=${s.version}`,
        },
      };
    }
    if ((match = path.match(/^\/me\/mailFolders\/(\w+)$/)) && method === 'GET') {
      const id = FOLDER_IDS[match[1]];
      return id
        ? { status: 200, body: { id } }
        : { status: 404, body: { error: { code: 'ErrorFolderNotFound' } } };
    }
    if ((match = path.match(/^\/me\/mailFolders\/([\w-]+)\/messages$/))) {
      const folder = Object.entries(FOLDER_IDS).find(([, id]) => id === match![1])?.[0] ?? match[1];
      if (method === 'POST') {
        const id = `app-${++s.created}`,
          props = Object.fromEntries(
            (body.singleValueExtendedProperties ?? []).map((x: Json) => [x.id, x.value]),
          );
        messages.set(id, {
          id,
          conversationId: `c-${id}`,
          folder,
          subject: body.subject,
          from: account.email,
          to: [],
          date: new Date(Date.UTC(2027, 0, 1) + s.created * 1000).toISOString(),
          isRead: true,
          flagged: false,
          html: '',
          internetMessageId: `<${id}@x>`,
          isDraft: true,
          props,
          attachments: body.attachments.map((a: Json, i: number) => ({ ...a, id: `att-${i}` })),
        });
        return { status: 201, body: { id } };
      }
      const internet = filterValue(p.get('$filter'), 'internetMessageId');
      const prop = p
        .get('$filter')
        ?.match(
          /singleValueExtendedProperties\/Any\(ep: ep\/id eq '([^']+)' and ep\/value eq '([^']+)'\)/,
        );
      const rows = [...messages.values()]
        .filter(
          m =>
            m.folder === folder &&
            (!internet || m.internetMessageId === internet) &&
            (!prop || m.props?.[prop[1]] === prop[2]),
        )
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, Number(p.get('$top') ?? 100));
      return { status: 200, body: { value: rows.map(full) } };
    }
    if (path === '/me/mailFolders') {
      if (method === 'POST') {
        const folder = {
          id: `F-custom-${folders.length + 1}`,
          displayName: body.displayName,
          isHidden: body.isHidden,
        };
        folders.push(folder);
        return { status: 201, body: folder };
      }
      assert.equal(p.get('includeHiddenFolders'), 'true');
      return {
        status: 200,
        body: { value: [{ id: 'F-inbox', displayName: 'Inbox' }, ...folders] },
      };
    }
    if (path === '/me/messages' && method === 'GET') {
      const conversation = filterValue(p.get('$filter'), 'conversationId'),
        internet = filterValue(p.get('$filter'), 'internetMessageId'),
        search = p.get('$search')?.replace(/"/g, '').toLowerCase();
      const rows = [...messages.values()].filter(
        m =>
          (!conversation || m.conversationId === conversation) &&
          (!internet || m.internetMessageId === internet) &&
          (!search || `${m.subject} ${m.html}`.toLowerCase().includes(search)),
      );
      return { status: 200, body: { value: rows.map(full) } };
    }
    if ((match = path.match(/^\/me\/messages\/([^/]+)\/move$/))) {
      const id = decodeURIComponent(match[1]);
      if (!messages.has(id)) return { status: 404, body: { error: { code: 'ErrorItemNotFound' } } };
      return {
        status: 201,
        body: full(move(id, body.destinationId, s.renameOnMove ? `${id}-moved` : id)),
      };
    }
    if ((match = path.match(/^\/me\/messages\/([^/]+)\/attachments\/([^/]+)(\/\$value)?$/))) {
      const a = messages
        .get(decodeURIComponent(match[1]))
        ?.attachments?.find(x => x.id === match![2]);
      if (!a) return { status: 404, body: {} };
      return match[3]
        ? { status: 200, raw: Buffer.from(a.contentBytes, 'base64') }
        : { status: 200, body: { '@odata.type': '#microsoft.graph.fileAttachment', ...a } };
    }
    if ((match = path.match(/^\/me\/messages\/([^/]+)\/attachments$/))) {
      const m = messages.get(decodeURIComponent(match[1]));
      if (!m) return { status: 404, body: {} };
      const selected = p.has('$select'),
        skip = Number(p.get('$skip') ?? 0),
        all = m.attachments ?? [];
      const shown = s.attachmentPage ? all.slice(skip, skip + s.attachmentPage) : all,
        more = s.attachmentPage && skip + s.attachmentPage < all.length;
      const nextLink = more
        ? (() => {
            const link = new URL(url);
            link.searchParams.set('$skip', String(skip + s.attachmentPage));
            return link.toString();
          })()
        : undefined;
      return {
        status: 200,
        body: {
          ...(nextLink ? { '@odata.nextLink': nextLink } : {}),
          value: shown.map(a =>
            selected
              ? {
                  '@odata.type': '#microsoft.graph.fileAttachment',
                  id: a.id,
                  name: a.name,
                  contentType: a.contentType,
                  size: a.size,
                  isInline: !!a.isInline,
                }
              : { '@odata.type': '#microsoft.graph.fileAttachment', ...a },
          ),
        },
      };
    }
    if ((match = path.match(/^\/me\/messages\/([^/]+)$/))) {
      const id = decodeURIComponent(match[1]),
        m = messages.get(id);
      if (!m) return { status: 404, body: { error: { code: 'ErrorItemNotFound' } } };
      if (method === 'DELETE') {
        remove(id);
        return { status: 204 };
      }
      if (method === 'PATCH') {
        update(id, {
          ...(body.isRead !== undefined ? { isRead: body.isRead } : {}),
          ...(body.flag ? { flagged: body.flag.flagStatus === 'flagged' } : {}),
        });
        return { status: 200, body: full(m) };
      }
      return {
        status: 200,
        body: {
          ...full(m),
          internetMessageHeaders: [
            { name: 'Message-ID', value: m.internetMessageId },
            ...(m.references ? [{ name: 'References', value: m.references }] : []),
          ],
        },
      };
    }
    if (path === '/me/sendMail') {
      const mime = Buffer.from(String(body), 'base64').toString('utf8');
      s.mime.push(mime);
      const parsed = await simpleParser(mime),
        parentMessage = [...messages.values()].find(m => m.internetMessageId === parsed.inReplyTo);
      const id = `sent-${s.mime.length}`;
      add({
        id,
        conversationId: parentMessage?.conversationId ?? `c-${id}`,
        folder: 'sentitems',
        subject: parsed.subject ?? '',
        from: account.email,
        to: [String((parsed.to as any)?.value?.[0]?.address)],
        date: new Date().toISOString(),
        isRead: true,
        flagged: false,
        html: String(parsed.html || ''),
        internetMessageId: parsed.messageId!,
      });
      return { status: 202 };
    }
    if (path === '/me/mailboxSettings/timeZone')
      return { status: 200, body: { value: 'W. Europe Standard Time' } };
    if (path === '/me/calendars')
      return { status: 200, body: { value: [{ id: 'cal-1', name: 'Calendar' }] } };
    if (path === '/me/calendars/cal-1/calendarView') {
      assert.match(headers.Prefer, /outlook\.timezone="UTC"/);
      assert.ok(p.get('startDateTime') && p.get('endDateTime'));
      return { status: 200, body: { value: [...events.values()] } };
    }
    if (path === '/me/calendar/events' && method === 'POST') {
      const id = `ev-${events.size + 1}`;
      const event = {
        id,
        webLink: `https://outlook.example/${id}`,
        ...body,
        start: { ...body.start },
        end: { ...body.end },
      };
      events.set(id, event);
      return { status: 201, body: event };
    }
    if ((match = path.match(/^\/me\/events\/([^/]+)$/))) {
      const event = events.get(match[1]);
      if (!event) return { status: 404, body: {} };
      if (method === 'DELETE') {
        events.delete(match[1]);
        return { status: 204 };
      }
      Object.assign(event, body);
      return { status: 200, body: event };
    }
    return { status: 500, body: { error: { code: 'unhandled', message: `${method} ${path}` } } };
  }
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET',
      headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.hostname === 'login.microsoftonline.com') {
      const values = new URLSearchParams(String(init?.body));
      s.tokenCalls++;
      assert.equal(values.get('client_id'), 'own-client');
      assert.match(values.get('scope') ?? '', /offline_access/);
      if (values.get('grant_type') === 'refresh_token') {
        assert.equal(values.get('refresh_token'), `refresh-${s.tokenCalls}`);
        await new Promise(r => setTimeout(r, 20));
        return json({
          access_token: `access-${s.tokenCalls + 1}`,
          refresh_token: `refresh-${s.tokenCalls + 1}`,
          expires_in: 3600,
        });
      }
      return json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 });
    }
    assert.equal(url.origin, 'https://graph.microsoft.com');
    assert.match(headers.Authorization, /^Bearer access-/);
    const body =
      headers['Content-Type'] === 'application/json' ? JSON.parse(String(init?.body)) : init?.body;
    s.requests.push({ method, url: url.pathname + url.search, body });
    const result = await route(method, url, body, headers);
    if (result.raw) return new Response(new Uint8Array(result.raw), { status: result.status });
    return json(result.body ?? {}, result.status, result.headers);
  };
  return { s, fetch: fetcher, add, move, remove, update };
}
function memoryStore(): ProviderMemory {
  const data = new Map<string, string>();
  return {
    get: (a, k) => data.get(`${a}\n${k}`),
    set: (a, k, v) => {
      if (v === undefined) data.delete(`${a}\n${k}`);
      else data.set(`${a}\n${k}`, v);
    },
    clear: a => {
      for (const key of [...data.keys()]) if (key.startsWith(`${a}\n`)) data.delete(key);
    },
  };
}
async function setup(expired = false) {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-microsoft-test-'));
  const vault = await createVault<Json>({
    dataDir,
    encrypt,
    decrypt,
    file: 'microsoft-tokens.enc.json',
  });
  await vault.set(account.id, {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expiresAt: expired ? 0 : Date.now() + 3600000,
  });
  const fake = fakeGraph(),
    memory = memoryStore();
  const provider = await createMicrosoft({
    dataDir,
    encrypt,
    decrypt,
    fetch: fake.fetch,
    memory,
    clientId: 'own-client',
  });
  return {
    dataDir,
    fake,
    memory,
    provider,
    cleanup: async () => {
      provider.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
const msg = (
  id: string,
  conversationId: string,
  folder: string,
  patch: Partial<FakeMessage> = {},
): FakeMessage => ({
  id,
  conversationId,
  folder,
  subject: `Subject ${conversationId}`,
  from: 'sam@example.test',
  to: [account.email],
  date: `2026-10-0${id.replace(/\D/g, '') || 1}T10:00:00.000Z`,
  isRead: true,
  flagged: false,
  html: `<p>Body ${id}</p>`,
  internetMessageId: `<${id}@example.test>`,
  ...patch,
});
function seed(fake: ReturnType<typeof fakeGraph>) {
  fake.add(
    msg('m1', 'cA', 'inbox', {
      isRead: false,
      attachments: [
        {
          id: 'a1',
          name: 'notes.txt',
          contentType: 'text/plain',
          size: 5,
          contentBytes: Buffer.from('notes').toString('base64'),
        },
        {
          id: 'a2',
          name: 'logo.png',
          contentType: 'image/png',
          size: 3,
          isInline: true,
          contentId: '<logo>',
          contentBytes: Buffer.from('png').toString('base64'),
        },
      ],
      html: '<p>Hello <b>Alex</b></p><img src="cid:logo">',
    }),
  );
  fake.add(
    msg('m2', 'cA', 'sentitems', {
      from: account.email,
      to: ['sam@example.test'],
      date: '2026-10-02T11:00:00.000Z',
    }),
  );
  fake.add(msg('m3', 'cB', 'archive', { flagged: true }));
  fake.add(msg('m4', 'cC', 'deleteditems'));
  fake.add(msg('m5', 'cD', 'junkemail'));
}
const byId = (threads: Thread[]): Record<string, Thread> =>
  Object.fromEntries(threads.map(t => [t.remoteId!, t]));

test('Outlook is unavailable without a client ID and explains the app registration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-microsoft-test-'));
  try {
    const provider = await createMicrosoft({ dataDir: dir, clientId: '' });
    assert.equal(provider.available, false);
    assert.match(provider.unavailableReason ?? '', /MICROSOFT_CLIENT_ID/);
    assert.match(provider.unavailableReason ?? '', /http:\/\/localhost/);
    await assert.rejects(() => provider.connect({ provider: 'microsoft' }), /MICROSOFT_CLIENT_ID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Outlook sign-in uses PKCE on a localhost loopback redirect and stores tokens encrypted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-microsoft-test-'));
  let authUrl: URL | undefined;
  const provider = await createMicrosoft({
    dataDir: dir,
    clientId: 'own-client',
    tenant: 'consumers',
    encrypt,
    decrypt,
    openExternal: async url => {
      authUrl = new URL(url);
      assert.equal(
        authUrl.origin + authUrl.pathname,
        'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
      );
      assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
      assert.match(
        authUrl.searchParams.get('scope') ?? '',
        /Mail\.ReadWrite.*Calendars\.ReadWrite/,
      );
      const callback = new URL(authUrl.searchParams.get('redirect_uri')!);
      assert.equal(callback.hostname, 'localhost');
      assert.equal(callback.protocol, 'http:');
      callback.hostname = '127.0.0.1';
      callback.searchParams.set('state', 'forged');
      callback.searchParams.set('code', 'intercepted');
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set('state', authUrl.searchParams.get('state')!);
      callback.searchParams.set('code', 'good-code');
      assert.equal((await fetch(callback)).status, 200);
    },
    fetch: async (input, init) => {
      if (String(input).endsWith('/oauth2/v2.0/token')) {
        const v = new URLSearchParams(String(init?.body));
        assert.equal(v.get('code'), 'good-code');
        assert.equal(v.get('client_secret'), null);
        assert.equal(v.get('redirect_uri'), authUrl!.searchParams.get('redirect_uri'));
        assert.equal(
          createHash('sha256').update(v.get('code_verifier')!).digest('base64url'),
          authUrl!.searchParams.get('code_challenge'),
        );
        return json({
          access_token: 'sensitive-access',
          refresh_token: 'sensitive-refresh',
          expires_in: 3600,
        });
      }
      assert.equal(String(input), `${graph}/me?$select=id,displayName,mail,userPrincipalName`);
      return json({
        id: 'u1',
        displayName: 'Alex',
        mail: null,
        userPrincipalName: 'alex@example.test',
      });
    },
  });
  try {
    const result = await provider.connect({ provider: 'microsoft' });
    assert.deepEqual(
      {
        id: result.id,
        email: result.email,
        provider: result.provider,
        preset: result.preset,
        color: result.color,
        calendar: result.calendarConnected,
        sendAs: result.sendAs?.map(a => a.email),
      },
      {
        id: 'microsoft-u1',
        email: 'alex@example.test',
        provider: 'microsoft',
        preset: 'outlook',
        color: '#4f7cac',
        calendar: true,
        sendAs: ['alex@example.test'],
      },
    );
    assert.deepEqual(result.capabilities, {
      labels: false,
      importance: false,
      aliases: false,
      signatures: false,
      calendar: true,
      serverSearch: true,
    });
    const disk = await readFile(join(dir, 'microsoft-tokens.enc.json'), 'utf8');
    assert.ok(!disk.includes('sensitive-access') && !disk.includes('sensitive-refresh'));
  } finally {
    provider.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Rotated refresh tokens are persisted, refreshed once for concurrent calls, and forgotten on disconnect', async () => {
  const { dataDir, fake, memory, provider, cleanup } = await setup(true);
  try {
    await Promise.all([provider.findSent(account, '<a@x>'), provider.findSent(account, '<b@x>')]);
    assert.equal(fake.s.tokenCalls, 1);
    const reloaded = await createVault<Json>({
      dataDir,
      encrypt,
      decrypt,
      file: 'microsoft-tokens.enc.json',
    });
    assert.equal(reloaded.get(account.id)?.refresh_token, 'refresh-2');
    assert.equal(reloaded.get(account.id)?.access_token, 'access-2');
    memory.set(account.id, 'index', '{}');
    await provider.disconnect(account.id);
    assert.equal(memory.get(account.id, 'index'), undefined);
    assert.equal(
      (
        await createVault<Json>({ dataDir, encrypt, decrypt, file: 'microsoft-tokens.enc.json' })
      ).get(account.id),
      undefined,
    );
    await assert.rejects(() => provider.findSent(account, '<a@x>'), /reconnected/);
  } finally {
    await cleanup();
  }
});

test('First sync groups conversations with folder status, then delta reports arrivals, flags, moves and removals', async () => {
  const { fake, provider, cleanup } = await setup();
  try {
    seed(fake);
    const first = await provider.sync(account, undefined, { has: () => false });
    assert.equal(first.reset, true);
    const t = byId(first.threads);
    assert.deepEqual(Object.keys(t).sort(), ['cA', 'cB', 'cC', 'cD']);
    assert.equal(t.cA.id, `${account.id}:cA`);
    assert.equal(t.cA.status, 'new');
    assert.equal(t.cA.unread, true);
    assert.deepEqual(t.cA.labels, ['INBOX', 'SENT', 'UNREAD']);
    assert.deepEqual(
      t.cA.messages.map(m => [m.id, m.sent, m.internetId]),
      [
        ['m1', false, '<m1@example.test>'],
        ['m2', true, '<m2@example.test>'],
      ],
    );
    assert.equal(t.cA.messages[0].text, 'Hello Alex');
    assert.match(t.cA.messages[0].html ?? '', /<b>Alex<\/b>/);
    const [file, inline] = t.cA.messages[0].attachments;
    assert.deepEqual([file.remoteId, file.messageId, file.data], ['a1', 'm1', undefined]);
    assert.deepEqual(
      [inline.contentId, inline.data],
      ['logo', Buffer.from('png').toString('base64')],
    );
    assert.equal(
      (await provider.attachment(account, t.cA, file)).data,
      Buffer.from('notes').toString('base64'),
    );
    assert.deepEqual(
      [t.cB.status, t.cB.bookmarked, t.cB.labels],
      ['done', true, ['ARCHIVE', 'STARRED']],
    );
    assert.equal(t.cC.status, 'trash');
    assert.equal(t.cD.status, 'spam');
    const known = new Set(first.threads.map(x => x.id)),
      context = { has: (id: string) => known.has(id) };
    const step = async (cursor: string | undefined) => {
      const r = (await provider.sync(account, cursor, context)) as SyncResult;
      for (const x of r.threads) known.add(x.id);
      return r;
    };

    fake.add(msg('m6', 'cB', 'inbox', { isRead: false }));
    const arrival = await step(first.cursor);
    assert.equal(arrival.reset, false);
    assert.deepEqual(
      arrival.threads.map(x => [x.remoteId, x.status, x.messages.length]),
      [['cB', 'new', 2]],
    );
    assert.deepEqual(arrival.flags, []);

    fake.update('m1', { isRead: true });
    const read = await step(arrival.cursor);
    assert.deepEqual(read.threads, []);
    assert.deepEqual(
      read.flags.map(f => [f.id, f.unread, f.status]),
      [[`${account.id}:cA`, false, 'new']],
    );

    const bodies = fake.s.requests.length;
    fake.move('m1', 'archive');
    const moved = await step(read.cursor);
    assert.deepEqual(moved.removed, []);
    assert.deepEqual(moved.threads, []);
    assert.deepEqual(
      moved.flags.map(f => [f.id, f.status, f.labels]),
      [[`${account.id}:cA`, 'done', ['ARCHIVE', 'SENT']]],
    );
    assert.ok(
      !fake.s.requests.slice(bodies).some(r => r.url.includes('conversationId')),
      'a move must not refetch message bodies',
    );

    fake.remove('m4');
    fake.remove('m2');
    const deleted = await step(moved.cursor);
    assert.deepEqual(deleted.removed, [`${account.id}:cC`]);
    assert.deepEqual(deleted.flags, []);
    assert.deepEqual(
      deleted.threads.map(x => [x.remoteId, x.messages.map(m => m.id), x.labels]),
      [['cA', ['m1'], ['ARCHIVE']]],
      'a conversation that lost a message comes back in full',
    );

    fake.s.gone = true;
    const reset = await step(deleted.cursor);
    assert.equal(reset.reset, true);
    assert.deepEqual(reset.threads.map(x => x.remoteId).sort(), ['cA', 'cB', 'cD']);
  } finally {
    await cleanup();
  }
});

test('A sync whose conversation fetch fails saves no index, so the retry still delivers the new reply', async () => {
  const { fake, memory, provider, cleanup } = await setup();
  try {
    seed(fake);
    const first = await provider.sync(account, undefined, { has: () => false });
    const known = new Set(first.threads.map(t => t.id)),
      context = { has: (id: string) => known.has(id) },
      saved = memory.get(account.id, 'index');
    fake.add(msg('m6', 'cA', 'inbox', { isRead: false }));
    fake.s.fail = (method, url) =>
      method === 'GET' &&
      url.pathname.endsWith('/me/messages') &&
      url.searchParams.get('$filter')?.includes('conversationId')
        ? 503
        : undefined;
    await assert.rejects(
      () => provider.sync(account, first.cursor, context),
      (error: unknown) => error instanceof MicrosoftError && error.status === 503,
    );
    assert.equal(
      memory.get(account.id, 'index'),
      saved,
      'nothing is indexed before its conversation is fetched',
    );
    fake.s.fail = undefined;
    const retry = await provider.sync(account, first.cursor, context);
    assert.deepEqual(
      retry.threads.map(t => [t.remoteId, t.messages.map(m => m.id)]),
      [['cA', ['m1', 'm2', 'm6']]],
    );
    assert.deepEqual(retry.flags, []);
  } finally {
    await cleanup();
  }
});

test('Attachment lists follow continuation pages', async () => {
  const { fake, provider, cleanup } = await setup();
  try {
    fake.s.attachmentPage = 2;
    fake.add(
      msg('m1', 'cA', 'inbox', {
        attachments: [1, 2, 3].map(i => ({
          id: `a${i}`,
          name: `file-${i}.txt`,
          contentType: 'text/plain',
          size: 1,
          contentBytes: Buffer.from(String(i)).toString('base64'),
        })),
      }),
    );
    const { threads } = await provider.sync(account, undefined, { has: () => false });
    assert.deepEqual(
      threads[0].messages[0].attachments.map(a => [a.name, a.remoteId]),
      [
        ['file-1.txt', 'a1'],
        ['file-2.txt', 'a2'],
        ['file-3.txt', 'a3'],
      ],
    );
    assert.ok(fake.s.requests.some(r => decodeURIComponent(r.url).includes('$skip=2')));
  } finally {
    await cleanup();
  }
});

test('First sync starts each folder delta at the date of the 500th newest message', async () => {
  const { fake, provider, cleanup } = await setup();
  try {
    const start = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 501; i++)
      fake.add(
        msg(`n${i}`, `conv-${i}`, i % 2 ? 'inbox' : 'archive', {
          date: new Date(start + i * 60000).toISOString(),
        }),
      );
    const first = await provider.sync(account, undefined, { has: () => false });
    assert.equal(first.threads.length, 500);
    assert.ok(!first.threads.some(t => t.remoteId === 'conv-0'));
    const cutoff = new Date(start + 60000).toISOString();
    const deltas = fake.s.requests
      .filter(r => r.url.includes('/messages/delta'))
      .map(r => decodeURIComponent(r.url));
    assert.equal(deltas.length, 5);
    assert.ok(
      deltas.every(url => url.includes(`$filter=receivedDateTime ge ${cutoff}`)),
      deltas[0],
    );
  } finally {
    await cleanup();
  }
});

test('Thread changes move every message to the right folder, follow moved IDs and set read and flag state', async () => {
  const { fake, provider, cleanup } = await setup();
  try {
    seed(fake);
    fake.s.renameOnMove = true;
    await provider.sync(account, undefined, { has: () => false });
    const at = () => fake.s.requests.length;
    let mark = at();
    const moves = () =>
      fake.s.requests
        .slice(mark)
        .flatMap(r => (r.url === '/v1.0/$batch' ? r.body.requests : [r]))
        .filter((r: Json) => /\/move$/.test(r.url) || r.method === 'PATCH')
        .map((r: Json) => [r.method, decodeURIComponent(r.url), r.body]);

    await provider.updateThread(
      account,
      { remoteId: 'cA', status: 'new', labels: ['INBOX', 'SENT', 'UNREAD'] },
      { status: 'done', labels: ['SENT'] },
    );
    assert.deepEqual(moves(), [['POST', '/me/messages/m1/move', { destinationId: 'archive' }]]);
    assert.equal(fake.s.messages.get('m1-moved')?.folder, 'archive');

    mark = at();
    await provider.updateThread(
      account,
      { remoteId: 'cA', status: 'done', labels: ['ARCHIVE', 'SENT'] },
      { bookmarked: true, unread: false },
    );
    assert.deepEqual(moves(), [
      ['PATCH', '/me/messages/m1-moved', { isRead: true }],
      ['PATCH', '/me/messages/m1-moved', { flag: { flagStatus: 'flagged' } }],
    ]);

    mark = at();
    await provider.updateThread(
      account,
      { remoteId: 'cA', status: 'done', labels: ['ARCHIVE', 'SENT', 'STARRED'] },
      { status: 'trash' },
    );
    assert.deepEqual(
      moves()
        .map(m => [m[1], m[2].destinationId])
        .sort(),
      [
        ['/me/messages/m1-moved/move', 'deleteditems'],
        ['/me/messages/m2/move', 'deleteditems'],
      ],
    );

    mark = at();
    await provider.updateThread(
      account,
      { remoteId: 'cA', status: 'trash', labels: ['TRASH'] },
      { status: 'new', labels: ['INBOX'], unread: true },
    );
    const restored = moves();
    assert.deepEqual(
      restored
        .filter(m => m[0] === 'POST')
        .map(m => [m[1], m[2].destinationId])
        .sort(),
      [
        ['/me/messages/m1-moved-moved/move', 'inbox'],
        ['/me/messages/m2-moved/move', 'sentitems'],
      ],
    );
    assert.deepEqual(
      restored.filter(m => m[0] === 'PATCH'),
      [['PATCH', '/me/messages/m1-moved-moved-moved', { isRead: false }]],
    );
    assert.deepEqual(
      [...fake.s.messages.values()]
        .filter(m => m.conversationId === 'cA')
        .map(m => [m.folder, m.isRead, m.flagged])
        .sort(),
      [
        ['inbox', false, true],
        ['sentitems', true, false],
      ],
    );

    mark = at();
    await provider.updateThread(
      account,
      { remoteId: 'cD', status: 'spam', labels: ['SPAM'] },
      { status: 'done', labels: [] },
    );
    assert.deepEqual(
      moves().map(m => m[2].destinationId),
      ['archive'],
    );
  } finally {
    await cleanup();
  }
});

test('Sending keeps our Message-ID in MIME, threads replies, and findSent locates the sent copy', async () => {
  const { fake, provider, cleanup } = await setup();
  try {
    seed(fake);
    fake.s.messages.get('m1')!.references = '<root@example.test>';
    const { threads } = await provider.sync(account, undefined, { has: () => false });
    const thread = byId(threads).cA;
    const draft: Draft = {
      id: 'd1',
      accountId: account.id,
      to: 'sam@example.test',
      cc: '',
      bcc: '',
      subject: 'Re: Subject cA',
      html: '<p>Thanks</p>',
      attachments: [],
      threadId: thread.id,
      mode: 'reply',
      updatedAt: '',
      signature: false,
      revision: 1,
      messageId: '<draft-1@aplos.test>',
    };
    thread.messages.push({
      id: 'local-uuid',
      from: account.email,
      fromName: 'Alex',
      to: [],
      date: '2026-10-09T00:00:00Z',
      text: 'local',
      attachments: [],
      sent: true,
    });
    const sent = await provider.send(account, draft, thread);
    const parsed = await simpleParser(fake.s.mime[0]);
    assert.equal(parsed.messageId, '<draft-1@aplos.test>');
    assert.equal(parsed.inReplyTo, '<m2@example.test>');
    assert.deepEqual([parsed.references].flat(), ['<m2@example.test>']);
    assert.deepEqual(sent, { id: 'sent-1', threadId: 'cA' });
    assert.deepEqual(await provider.findSent(account, 'draft-1@aplos.test'), {
      id: 'sent-1',
      threadId: 'cA',
    });
    assert.equal(await provider.findSent(account, '<never@aplos.test>'), undefined);
    fake.s.messages.get('m2')!.references = '<root@example.test> <m1@example.test>';
    await provider.send(account, { ...draft, messageId: '<draft-2@aplos.test>' }, thread);
    assert.deepEqual([(await simpleParser(fake.s.mime[1])).references].flat(), [
      '<root@example.test>',
      '<m1@example.test>',
      '<m2@example.test>',
    ]);
    const big = {
      id: 'x',
      name: 'big.bin',
      type: 'application/octet-stream',
      size: 3_100_000,
      data: Buffer.alloc(3_100_000).toString('base64'),
    };
    await assert.rejects(
      () => provider.send(account, { ...draft, attachments: [big] }),
      /about 3 MB/,
    );
    await assert.rejects(
      () => provider.send(account, { ...draft, fromEmail: 'other@example.test' }),
      /primary address/,
    );
    assert.equal(fake.s.mime.length, 2);
  } finally {
    await cleanup();
  }
});

test('Outlook errors mark only unknown outcomes as uncertain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-microsoft-test-'));
  const vault = await createVault<Json>({
    dataDir: dir,
    encrypt,
    decrypt,
    file: 'microsoft-tokens.enc.json',
  });
  await vault.set(account.id, {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expiresAt: Date.now() + 3600000,
  });
  let respond: () => Promise<Response> = async () => json({});
  const provider = await createMicrosoft({
    dataDir: dir,
    encrypt,
    decrypt,
    clientId: 'own-client',
    fetch: () => respond(),
  });
  const failure = async () => {
    try {
      await provider.findSent(account, '<x@y>');
    } catch (error) {
      return error as MicrosoftError;
    }
    assert.fail('expected an error');
  };
  try {
    respond = async () => {
      throw new TypeError('fetch failed');
    };
    let error = await failure();
    assert.ok(error instanceof MicrosoftError);
    assert.equal(error.uncertain, true);
    respond = async () => json({ error: { code: 'ServiceUnavailable' } }, 503);
    error = await failure();
    assert.deepEqual([error.status, error.uncertain], [503, true]);
    respond = async () => json({ error: { code: 'BadRequest' } }, 400);
    error = await failure();
    assert.deepEqual([error.status, error.uncertain], [400, false]);
    respond = async () => json({ error: { code: 'TooManyRequests' } }, 429, { 'Retry-After': '7' });
    error = await failure();
    assert.equal(error.uncertain, false);
    assert.match(error.message, /7 seconds/);
    respond = async () => json({}, 401);
    error = await failure();
    assert.match(error.message, /Reconnect/);
  } finally {
    provider.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Search groups matching messages into full conversations', async () => {
  const { fake, provider, cleanup } = await setup();
  try {
    seed(fake);
    fake.add(
      msg('m7', 'cE', 'archive', { subject: 'Quarterly invoice', html: '<p>Invoice attached</p>' }),
    );
    fake.add(
      msg('m8', 'cE', 'sentitems', { subject: 'Re: Quarterly invoice', from: account.email }),
    );
    const found = await provider.search(account, 'invoice');
    assert.deepEqual(
      found.map(t => [t.remoteId, t.messages.length, t.subject]),
      [['cE', 2, 'Quarterly invoice']],
    );
    assert.ok(fake.s.requests.some(r => decodeURIComponent(r.url).includes('$search="invoice"')));
  } finally {
    await cleanup();
  }
});

test('Calendar lists, saves and deletes events through Graph', async () => {
  const { fake, provider, cleanup } = await setup();
  try {
    assert.deepEqual(await provider.listCalendars(account), [
      { id: 'cal-1', name: 'Calendar', accountId: account.id },
    ]);
    const draft: CalendarEvent = {
      id: 'local-1',
      accountId: account.id,
      calendarId: 'primary',
      title: 'Review',
      start: '2026-10-16T10:00:00.000Z',
      end: '2026-10-16T11:00:00.000Z',
      allDay: false,
      location: 'Studio',
      description: 'Bring notes',
      guests: ['sam@example.test'],
    };
    const saved = await provider.saveEvent(account, draft);
    assert.deepEqual(
      [saved.id, saved.remoteId, saved.url, saved.start, saved.location, saved.guests],
      [
        'local-1',
        'ev-1',
        'https://outlook.example/ev-1',
        '2026-10-16T10:00:00.000Z',
        'Studio',
        ['sam@example.test'],
      ],
    );
    assert.deepEqual(fake.s.events.get('ev-1')?.start, {
      dateTime: '2026-10-16T10:00:00.000',
      timeZone: 'UTC',
    });
    const allDay = await provider.saveEvent(account, {
      ...saved,
      allDay: true,
      start: '2026-10-17',
      end: '2026-10-18',
    });
    assert.deepEqual(fake.s.events.get('ev-1')?.start, {
      dateTime: '2026-10-17T00:00:00',
      timeZone: 'W. Europe Standard Time',
    });
    assert.deepEqual([allDay.start, allDay.end, allDay.allDay], ['2026-10-17', '2026-10-18', true]);
    const listed = await provider.listEvents(account);
    assert.deepEqual(
      listed.map(e => [e.id, e.calendarId, e.title, e.start]),
      [[`${account.id}:cal-1:ev-1`, 'cal-1', 'Review', '2026-10-17']],
    );
    await provider.deleteEvent(account, saved);
    assert.equal(fake.s.events.size, 0);
  } finally {
    await cleanup();
  }
});

test('Workflow data keeps every concurrent copy in a hidden folder until a write replaces it', async () => {
  const { fake, provider, cleanup } = await setup();
  try {
    assert.deepEqual(await provider.readAppData(account), []);
    assert.equal(fake.s.folders.length, 0, 'reading must not create the folder');
    await provider.writeAppData(account, 'ciphertext-v1', []);
    await provider.writeAppData(account, 'ciphertext-v2 ünïcode', []);
    assert.deepEqual(
      fake.s.folders.map(f => [f.displayName, f.isHidden]),
      [['Aplos Mail Data', true]],
    );
    const both = await provider.readAppData(account);
    assert.deepEqual(
      both.map(r => r.data),
      ['ciphertext-v2 ünïcode', 'ciphertext-v1'],
      'a second writer never deletes the first copy',
    );
    await provider.writeAppData(
      account,
      'merged',
      both.map(r => r.id),
    );
    assert.deepEqual(
      (await provider.readAppData(account)).map(r => r.data),
      ['merged'],
    );
    assert.equal(
      [...fake.s.messages.values()].filter(m => m.folder === fake.s.folders[0].id).length,
      1,
    );
    seed(fake);
    const synced = await provider.sync(account, undefined, { has: () => false });
    assert.deepEqual(
      synced.threads.map(t => t.remoteId).sort(),
      ['cA', 'cB', 'cC', 'cD'],
      'app data is never synced as mail',
    );
    assert.deepEqual(await provider.search(account, 'Aplos'), []);
  } finally {
    await cleanup();
  }
});

test('A user folder named Aplos and unmarked messages are never read or deleted as workflow data', async () => {
  const { fake, provider, cleanup } = await setup();
  try {
    const decoy = [
      {
        id: 'x1',
        name: 'aplos-data.bin',
        contentType: 'application/octet-stream',
        size: 4,
        contentBytes: Buffer.from('mine').toString('base64'),
      },
    ];
    fake.s.folders.push(
      { id: 'F-user', displayName: 'Aplos', isHidden: false },
      { id: 'F-user2', displayName: 'Aplos Mail Data', isHidden: false },
    );
    fake.add(msg('u1', 'cU', 'F-user', { subject: 'My Aplos notes', attachments: decoy }));
    fake.add(msg('u2', 'cV', 'F-user2', { attachments: decoy }));
    assert.deepEqual(await provider.readAppData(account), []);
    await provider.writeAppData(account, 'v1', ['u1', 'u2']);
    const hidden = fake.s.folders.find(f => f.isHidden)!;
    assert.ok(
      hidden && !['F-user', 'F-user2'].includes(hidden.id),
      'a visible folder of the same name is not reused',
    );
    fake.add(msg('u3', 'cW', hidden.id, { attachments: decoy }));
    const records = await provider.readAppData(account);
    assert.deepEqual(
      records.map(r => r.data),
      ['v1'],
    );
    await provider.writeAppData(account, 'v2', [records[0].id, 'u1', 'u2', 'u3']);
    assert.ok(
      ['u1', 'u2', 'u3'].every(id => fake.s.messages.has(id)),
      'only marked workflow records are deleted',
    );
    assert.ok(!fake.s.messages.has(records[0].id));
    assert.deepEqual(
      (await provider.readAppData(account)).map(r => r.data),
      ['v2'],
    );
  } finally {
    await cleanup();
  }
});
