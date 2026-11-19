import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';

type Kind = 'google' | 'microsoft';
interface Mail {
  id: string;
  thread: string;
  subject: string;
  text: string;
  date: string;
  from: string;
  to: string[];
  internetId: string;
  labels: string[];
}
interface Fault {
  kind: Kind;
  method: string;
  path: string;
  status: number;
}
const graph = 'https://graph.microsoft.com/v1.0';
const folders: Record<string, string> = {
  inbox: 'INBOX',
  archive: 'ARCHIVE',
  sentitems: 'SENT',
  deleteditems: 'TRASH',
  junkemail: 'SPAM',
  drafts: 'DRAFTS',
};
const origins = new Map([
  ['https://accounts.google.com', 'google'],
  ['https://oauth2.googleapis.com', 'google'],
  ['https://www.googleapis.com', 'google'],
  ['https://gmail.googleapis.com', 'google'],
  ['https://login.microsoftonline.com', 'microsoft'],
  ['https://graph.microsoft.com', 'microsoft'],
] as const);
export const emulatedIdentity = (kind: Kind) => ({
  id: kind === 'google' ? 'google-local' : 'microsoft-local',
  email: `alex@${kind}.example.test`,
  name: 'Alex Local',
});

/** Original, deliberately small protocol emulator. No request can reach an external provider. */
export async function startProviderEmulator() {
  const mail = { google: new Map<string, Mail>(), microsoft: new Map<string, Mail>() };
  const changes: { kind: Kind; version: number; id: string; before: string[] }[] = [];
  const codes = new Map<string, { kind: Kind; challenge: string; redirect: string }>();
  const access = new Map<string, Kind>(),
    refresh = new Map<string, Kind>();
  const stats = { authorization: 0, pkce: 0, refresh: 0, requests: 0, sends: 0 };
  const faults: Fault[] = [];
  let version = 0;
  const put = (kind: Kind, message: Mail) => {
    const before = mail[kind].get(message.id)?.labels ?? [];
    mail[kind].set(message.id, message);
    changes.push({ kind, version: ++version, id: message.id, before });
  };
  const add = (kind: Kind, id: string, text = 'Please review the original studio plan.') =>
    put(kind, {
      id,
      thread: id,
      subject: `Studio plan ${id}`,
      text,
      date: new Date().toISOString(),
      from: 'ari@studio.example.test',
      to: [emulatedIdentity(kind).email],
      internetId: `<${id}@studio.example.test>`,
      labels: ['INBOX', 'UNREAD', 'IMPORTANT'],
    });
  for (const kind of ['google', 'microsoft'] as const) {
    add(kind, 'studio');
    add(kind, 'walk', 'The neighborhood walk is confirmed for November 20, 2026 at 15:00 UTC.');
  }
  const gmailMessage = (m: Mail) => ({
    id: m.id,
    threadId: m.thread,
    labelIds: m.labels,
    internalDate: String(Date.parse(m.date)),
    snippet: m.text,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: m.from },
        { name: 'To', value: m.to.join(', ') },
        { name: 'Subject', value: m.subject },
        { name: 'Message-ID', value: m.internetId },
      ],
      body: { data: Buffer.from(m.text).toString('base64url') },
    },
  });
  const graphMessage = (m: Mail) => ({
    id: m.id,
    conversationId: m.thread,
    internetMessageId: m.internetId,
    subject: m.subject,
    body: { contentType: 'text', content: m.text },
    bodyPreview: m.text,
    from: { emailAddress: { address: m.from, name: 'Ari' } },
    toRecipients: m.to.map(address => ({ emailAddress: { address } })),
    ccRecipients: [],
    receivedDateTime: m.date,
    sentDateTime: m.date,
    isRead: !m.labels.includes('UNREAD'),
    flag: { flagStatus: m.labels.includes('STARRED') ? 'flagged' : 'notFlagged' },
    parentFolderId: Object.keys(folders).find(f => m.labels.includes(folders[f])) ?? 'archive',
    isDraft: false,
    hasAttachments: false,
  });
  const json = (data: unknown, status = 200) =>
    new Response(status === 204 || status === 202 ? null : JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  async function route(
    kind: Kind,
    url: URL,
    method: string,
    body: string,
    headers: Headers,
  ): Promise<Response> {
    stats.requests++;
    const path = url.pathname,
      p = url.searchParams;
    const failed = faults.findIndex(
      f => f.kind === kind && f.method === method && path.includes(f.path),
    );
    if (failed >= 0)
      return json({ error: { code: 'EmulatedFailure' } }, faults.splice(failed, 1)[0].status);
    if (path.endsWith('/auth') || path.endsWith('/authorize')) {
      const redirect = p.get('redirect_uri') ?? '',
        callback = new URL(redirect);
      if (
        callback.protocol !== 'http:' ||
        !['localhost', '127.0.0.1'].includes(callback.hostname) ||
        callback.username ||
        callback.password ||
        !callback.port ||
        p.get('client_id') !== 'emulated-aplos' ||
        p.get('code_challenge_method') !== 'S256' ||
        !p.get('state') ||
        !p.get('code_challenge')
      )
        return json({ error: 'invalid_authorization_request' }, 400);
      const code = randomUUID();
      codes.set(code, { kind, challenge: p.get('code_challenge')!, redirect });
      stats.authorization++;
      callback.searchParams.set('state', p.get('state')!);
      callback.searchParams.set('code', code);
      return new Response(null, { status: 302, headers: { Location: callback.href } });
    }
    if (path.endsWith('/token')) {
      const params = new URLSearchParams(body);
      if (params.get('client_id') !== 'emulated-aplos')
        return json({ error: 'invalid_client' }, 400);
      if (params.get('grant_type') === 'authorization_code') {
        const record = codes.get(params.get('code') ?? '');
        codes.delete(params.get('code') ?? '');
        if (
          !record ||
          record.kind !== kind ||
          record.redirect !== params.get('redirect_uri') ||
          record.challenge !==
            createHash('sha256')
              .update(params.get('code_verifier') ?? '')
              .digest('base64url')
        )
          return json({ error: 'invalid_grant' }, 400);
        stats.pkce++;
      } else if (params.get('grant_type') === 'refresh_token') {
        const token = params.get('refresh_token') ?? '';
        if (refresh.get(token) !== kind) return json({ error: 'invalid_grant' }, 400);
        refresh.delete(token);
        stats.refresh++;
      } else return json({ error: 'unsupported_grant' }, 400);
      const a = randomUUID(),
        r = randomUUID();
      access.set(a, kind);
      refresh.set(r, kind);
      // Expire the initial grant immediately to exercise each adapter's refresh path.
      return json({
        access_token: a,
        refresh_token: r,
        expires_in: params.get('grant_type') === 'authorization_code' ? 1 : 3600,
      });
    }
    if (path === '/revoke') return json({});
    if (access.get((headers.get('authorization') ?? '').replace(/^Bearer /, '')) !== kind)
      return json({ error: { code: 'InvalidAuthenticationToken' } }, 401);
    const identity = emulatedIdentity(kind);
    if (path.endsWith('/userinfo'))
      return json({ sub: 'local', email: identity.email, name: identity.name });
    if (kind === 'microsoft' && path === '/v1.0/me')
      return json({ id: 'local', mail: identity.email, displayName: identity.name });
    const data =
      body && headers.get('content-type')?.includes('application/json') ? JSON.parse(body) : {};
    if (kind === 'google') {
      const root = '/gmail/v1/users/me',
        rel = path.slice(root.length);
      let match: RegExpMatchArray | null;
      if (path === '/calendar/v3/users/me/calendarList')
        return json({
          items: [{ id: 'primary', summary: 'Local calendar', primary: true, accessRole: 'owner' }],
        });
      if (path.startsWith('/calendar/v3/calendars/')) return json({ items: [] });
      if (rel === '/settings/sendAs')
        return json({
          sendAs: [
            {
              sendAsEmail: identity.email,
              displayName: identity.name,
              isPrimary: true,
              isDefault: true,
              verificationStatus: 'accepted',
              signature: '',
            },
          ],
        });
      if (rel === '/profile')
        return json({ historyId: String(version), emailAddress: identity.email });
      if (rel === '/history')
        return json({
          historyId: String(version),
          history: changes
            .filter(c => c.kind === kind && c.version > Number(p.get('startHistoryId')))
            .map(c => ({
              id: String(c.version),
              messagesAdded: [
                { message: { id: c.id, threadId: mail[kind].get(c.id)?.thread ?? c.id } },
              ],
            })),
        });
      if (rel === '/threads')
        return json({
          threads: [
            ...new Set(
              [...mail[kind].values()]
                .filter(
                  m =>
                    !p.get('q') ||
                    p.get('q')!.startsWith('-label:') ||
                    `${m.subject} ${m.text}`.toLowerCase().includes(p.get('q')!.toLowerCase()),
                )
                .map(m => m.thread),
            ),
          ].map(id => ({ id })),
        });
      if (rel === '/messages')
        return json({
          messages: [...mail[kind].values()]
            .filter(
              m =>
                m.labels.includes('SENT') &&
                p.get('q')?.includes(m.internetId.replace(/^<|>$/g, '')),
            )
            .map(m => ({ id: m.id, threadId: m.thread })),
        });
      if (rel === '/messages/send' && method === 'POST')
        return deliver(kind, Buffer.from(data.raw, 'base64url'), data.threadId);
      if ((match = rel.match(/^\/threads\/([^/]+)(?:\/(modify|trash|untrash))?$/))) {
        const rows = [...mail[kind].values()].filter(
          m => m.thread === decodeURIComponent(match![1]),
        );
        if (!rows.length) return json({}, 404);
        if (method === 'POST')
          for (const m of rows) {
            const labels = new Set(m.labels);
            for (const l of data.addLabelIds ?? []) labels.add(l);
            for (const l of data.removeLabelIds ?? []) labels.delete(l);
            if (match[2] === 'trash') labels.add('TRASH');
            if (match[2] === 'untrash') labels.delete('TRASH');
            put(kind, { ...m, labels: [...labels] });
          }
        return json({ id: rows[0].thread, messages: rows.map(gmailMessage) });
      }
    } else {
      const rel = path.replace(/^\/v1\.0/, '');
      let match: RegExpMatchArray | null;
      if (rel === '/$batch') {
        const responses = [];
        for (const r of data.requests) {
          const response = await route(
            kind,
            new URL(graph + r.url),
            r.method,
            r.body === undefined ? '' : JSON.stringify(r.body),
            new Headers({ ...Object.fromEntries(headers), ...r.headers }),
          );
          responses.push({
            id: r.id,
            status: response.status,
            body: response.status === 204 ? {} : await response.json(),
          });
        }
        return json({ responses });
      }
      if (rel === '/me/mailboxSettings/timeZone') return json({ value: 'UTC' });
      if (rel === '/me/calendars')
        return json({
          value: [{ id: 'local-calendar', name: 'Local calendar', isDefaultCalendar: true }],
        });
      if (rel.endsWith('/calendarView')) return json({ value: [] });
      if (rel === '/me/sendMail' && method === 'POST')
        return deliver(kind, Buffer.from(body, 'base64'));
      if ((match = rel.match(/^\/me\/mailFolders\/([^/]+)(?:\/messages(\/delta)?)?$/))) {
        const folder = decodeURIComponent(match[1]),
          label = folders[folder];
        if (!label) return json({}, 404);
        if (!rel.includes('/messages')) return json({ id: folder });
        const rows = [...mail[kind].values()].filter(m => m.labels.includes(label));
        if (match[2]) {
          const since = p.get('$deltatoken');
          const touched =
            since === null
              ? undefined
              : new Set(
                  changes
                    .filter(
                      c =>
                        c.kind === kind &&
                        c.version > Number(since) &&
                        (c.before.includes(label) || mail[kind].get(c.id)?.labels.includes(label)),
                    )
                    .map(c => c.id),
                );
          return json({
            value: touched
              ? [...touched].map(id => {
                  const m = mail[kind].get(id);
                  return m?.labels.includes(label)
                    ? graphMessage(m)
                    : { id, '@removed': { reason: 'deleted' } };
                })
              : rows.map(graphMessage),
            '@odata.deltaLink': `${graph}/me/mailFolders/${folder}/messages/delta?$deltatoken=${version}`,
          });
        }
        const internet = p.get('$filter')?.match(/internetMessageId eq '([^']+)'/)?.[1];
        return json({
          value: rows.filter(m => !internet || m.internetId === internet).map(graphMessage),
        });
      }
      if (rel === '/me/messages') {
        const conversation = p.get('$filter')?.match(/conversationId eq '([^']+)'/)?.[1];
        return json({
          value: [...mail[kind].values()]
            .filter(m => !conversation || m.thread === conversation)
            .map(graphMessage),
        });
      }
      if ((match = rel.match(/^\/me\/messages\/([^/]+)(?:\/(move|attachments))?$/))) {
        const id = decodeURIComponent(match[1]),
          m = mail[kind].get(id);
        if (!m) return json({}, 404);
        if (match[2] === 'attachments') return json({ value: [] });
        let labels = new Set(m.labels);
        if (match[2] === 'move') {
          labels = new Set([...labels].filter(l => !Object.values(folders).includes(l)));
          labels.add(folders[data.destinationId] ?? data.destinationId);
        }
        if (method === 'PATCH') {
          if (data.isRead !== undefined)
            data.isRead ? labels.delete('UNREAD') : labels.add('UNREAD');
          if (data.flag)
            data.flag.flagStatus === 'flagged' ? labels.add('STARRED') : labels.delete('STARRED');
        }
        if (method !== 'GET') put(kind, { ...m, labels: [...labels] });
        return json(graphMessage(mail[kind].get(id)!));
      }
    }
    return json({ error: 'Unimplemented emulated endpoint', method, path }, 501);
  }
  async function deliver(kind: Kind, bytes: Buffer, thread?: string) {
    const parsed = await simpleParser(bytes),
      recipients = [parsed.to, parsed.cc, parsed.bcc].flatMap(group =>
        (Array.isArray(group) ? group : group ? [group] : []).flatMap(g =>
          g.value.map(a => a.address ?? ''),
        ),
      );
    if (!recipients.length || recipients.some(a => !a.endsWith('.test') && !a.endsWith('.example')))
      return json({ error: 'Emulation accepts only .test or .example recipients' }, 400);
    const id = `sent-${++stats.sends}`;
    put(kind, {
      id,
      thread: thread ?? id,
      subject: parsed.subject ?? '',
      text: parsed.text ?? '',
      date: new Date().toISOString(),
      from: emulatedIdentity(kind).email,
      to: recipients,
      internetId: parsed.messageId ?? `<${id}@local.test>`,
      labels: ['SENT'],
    });
    return kind === 'google' ? json({ id, threadId: thread ?? id }) : json({}, 202);
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host || req.headers.origin) {
        res.writeHead(403);
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', origin),
        providerOrigin = url.searchParams.get('origin') ?? '',
        kind = origins.get(providerOrigin as never);
      if (!kind) {
        res.writeHead(403);
        res.end();
        return;
      }
      const target = new URL(url.pathname + url.searchParams.get('query'), providerOrigin);
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 8_000_000) throw new Error('Emulated request too large');
        parts.push(part);
      }
      const response = await route(
        kind,
        target,
        req.method ?? 'GET',
        Buffer.concat(parts).toString(),
        new Headers(req.headers as Record<string, string>),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Emulation failed' }));
    }
  });
  let origin = '';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!origins.has(url.origin as never))
      throw new Error('External network access is disabled in provider emulation.');
    const target = new URL(url.pathname, origin);
    target.search = new URLSearchParams({ origin: url.origin, query: url.search }).toString();
    return fetch(target, { ...init, redirect: 'manual' });
  };
  return {
    origin,
    fetch: request,
    stats,
    mail,
    add,
    failNext(kind: Kind, method: string, path: string, status = 503) {
      faults.push({ kind, method, path, status });
    },
    async authorize(url: string) {
      const expected = new URL(url).searchParams.get('redirect_uri');
      const response = await request(url);
      const location = response.headers.get('location');
      if (response.status !== 302 || !location || !expected)
        throw new Error('Emulated authorization failed.');
      const callback = new URL(location),
        registered = new URL(expected);
      if (callback.origin !== registered.origin || callback.pathname !== registered.pathname)
        throw new Error('Invalid emulated callback.');
      const result = await fetch(callback, { redirect: 'error' });
      if (!result.ok) throw new Error('Emulated callback rejected.');
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
