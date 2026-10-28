import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockedAddress,
  checkDomain,
  dohLookup,
  discoverAccount,
  parseAutoconfig,
  publicHost,
  type DomainReport,
} from '@aplos/engine/legacy/discover';
import { duplicateTags, resolveDns } from '@aplos/engine/legacy/dns';

type Zone = Record<string, Partial<Record<'MX' | 'TXT' | 'CNAME' | 'A', string[]>>>;
const CODES = { A: 1, CNAME: 5, MX: 15, TXT: 16 } as const;

/** Answers DNS-over-HTTPS queries from `zone` and other HTTPS requests from `pages`; nothing touches the network. */
function fakeNet(
  zone: Zone,
  options: { pages?: Record<string, string>; down?: ('cloudflare-dns.com' | 'dns.google')[] } = {},
) {
  const calls: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.hostname === 'cloudflare-dns.com' || url.hostname === 'dns.google') {
      if (options.down?.includes(url.hostname)) throw new TypeError('fetch failed');
      const name = url.searchParams.get('name')!,
        type = url.searchParams.get('type') as keyof typeof CODES,
        entry = zone[name];
      if (!entry) return Response.json({ Status: 3 });
      const answer = (owner: string, t: keyof typeof CODES, data: string) => ({
        name: `${owner}.`,
        type: CODES[t],
        TTL: 300,
        // Cloudflare quotes TXT strings and splits them into 255-byte chunks; dns.google returns them joined and bare.
        data:
          t === 'TXT'
            ? url.hostname === 'dns.google'
              ? data
              : (data.match(/.{1,255}/g) ?? ['']).map(c => `"${c.replace(/"/g, '\\"')}"`).join(' ')
            : t === 'A'
              ? data
              : t === 'MX'
                ? `${data}.`
                : `${data}.`,
      });
      const Answer = [];
      if (type !== 'CNAME' && entry.CNAME) {
        Answer.push(answer(name, 'CNAME', entry.CNAME[0]));
        for (const d of zone[entry.CNAME[0]]?.[type] ?? [])
          Answer.push(answer(entry.CNAME[0], type, d));
      } else for (const d of entry[type] ?? []) Answer.push(answer(name, type, d));
      return Response.json({ Status: 0, Answer });
    }
    const page = options.pages?.[url.href];
    return page === undefined
      ? new Response('missing', { status: 404 })
      : new Response(page, { headers: { 'content-type': 'text/xml' } });
  };
  // Host lookups for vetting discovered servers come from the zone's A records too; unknown names do not resolve.
  const lookup = async (host: string) => {
    const a = zone[host]?.A;
    if (!a) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return a;
  };
  return { fetch: fetch as typeof globalThis.fetch, calls, lookup };
}
const offline = (async () => {
  throw new TypeError('fetch failed');
}) as typeof globalThis.fetch;

const AUTOCONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="lindenpost.example">
    <domain>lindenpost.example</domain>
    <displayName>Linden Post</displayName>
    <incomingServer type="pop3"><hostname>pop.lindenpost.example</hostname><port>995</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
    <incomingServer type="imap"><hostname>mail.lindenpost.example</hostname><port>143</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username></incomingServer>
    <incomingServer type="imap"><hostname>mail.lindenpost.example</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></incomingServer>
    <outgoingServer type="smtp"><hostname>plain.lindenpost.example</hostname><port>25</port><socketType>plain</socketType><username>%EMAILLOCALPART%</username></outgoingServer>
    <outgoingServer type="smtp"><hostname>send.%EMAILDOMAIN%</hostname><port>587</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username></outgoingServer>
  </emailProvider>
</clientConfig>`;

test('consumer domains are recognized without any network lookups', async () => {
  const cases: [string, string, string][] = [
    ['ada@gmail.com', 'google', 'gmail'],
    ['ada@googlemail.com', 'google', 'gmail'],
    ['ada@hotmail.co.uk', 'microsoft', 'outlook'],
    ['ada@live.com', 'microsoft', 'outlook'],
    ['ada@msn.com', 'microsoft', 'outlook'],
    ['ada@me.com', 'imap', 'icloud'],
    ['ada@yahoo.co.jp', 'imap', 'yahoo'],
    ['ada@ymail.com', 'imap', 'yahoo'],
    ['ada@aim.com', 'imap', 'aol'],
    ['ada@fastmail.fm', 'jmap', 'fastmail'],
    ['ada@sent.com', 'jmap', 'fastmail'],
  ];
  for (const [email, provider, preset] of cases) {
    const found = await discoverAccount(email, { fetch: offline });
    assert.deepEqual(
      [found.provider, found.preset, found.confidence],
      [provider, preset, 'known'],
      email,
    );
  }
  const icloud = await discoverAccount(' Ada@ICLOUD.com ', { fetch: offline });
  assert.equal(icloud.email, 'Ada@icloud.com');
  assert.deepEqual(icloud.server, {
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    caldav: 'https://caldav.icloud.com',
  });
  assert.match(icloud.help!, /app-specific password.*appleid\.apple\.com/);
  assert.deepEqual((await discoverAccount('a@yahoo.com', { fetch: offline })).server?.smtp, {
    host: 'smtp.mail.yahoo.com',
    port: 465,
    secure: true,
  });
  assert.equal(
    (await discoverAccount('a@aol.com', { fetch: offline })).server?.imap.host,
    'imap.aol.com',
  );
  const fm = await discoverAccount('a@fastmail.com', { fetch: offline });
  assert.equal(fm.sessionUrl, 'https://api.fastmail.com/jmap/session');
  assert.match(fm.help!, /API token/);
  await assert.rejects(discoverAccount('not an address', { fetch: offline }), /full email address/);
});

test('custom domains are detected from their MX hosts', async () => {
  const net = fakeNet({
    'northwind.example': { MX: ['5 alt1.aspmx.l.google.com', '1 smtp.google.com'] },
    'contoso.example': { MX: ['0 contoso-example.mail.protection.outlook.com'] },
    'appleseed.example': { MX: ['10 mx01.mail.icloud.com', '10 mx02.mail.icloud.com'] },
    'quill.example': { MX: ['10 in1-smtp.messagingengine.com', '20 in2-smtp.messagingengine.com'] },
  });
  const google = await discoverAccount('kim@northwind.example', net);
  assert.deepEqual(
    [google.provider, google.preset, google.confidence, google.source],
    ['google', 'gmail', 'mx', 'MX record smtp.google.com'],
  );
  const ms = await discoverAccount('kim@contoso.example', net);
  assert.deepEqual([ms.provider, ms.preset], ['microsoft', 'outlook']);
  const apple = await discoverAccount('kim@appleseed.example', net);
  assert.deepEqual(
    [apple.provider, apple.preset, apple.server?.imap.host],
    ['imap', 'icloud', 'imap.mail.me.com'],
  );
  assert.match(apple.help!, /app-specific password.*not kim@appleseed\.example/);
  const fm = await discoverAccount('kim@quill.example', net);
  assert.deepEqual(
    [fm.provider, fm.preset, fm.sessionUrl],
    ['jmap', 'fastmail', 'https://api.fastmail.com/jmap/session'],
  );
  assert.ok(
    net.calls.every(url => url.startsWith('https://cloudflare-dns.com/')),
    'no autoconfig requests once MX decides',
  );
});

test('autoconfig files from the domain or ISPDB fill in IMAP and SMTP settings, and guessing is the last resort', async () => {
  const own = fakeNet(
    { 'lindenpost.example': { MX: ['10 mx.lindenpost.example'] } },
    {
      pages: {
        'https://autoconfig.lindenpost.example/mail/config-v1.1.xml?emailaddress=jo%40lindenpost.example':
          AUTOCONFIG,
      },
    },
  );
  const found = await discoverAccount('jo@lindenpost.example', own);
  assert.deepEqual(
    [found.provider, found.preset, found.confidence],
    ['imap', 'generic', 'autoconfig'],
  );
  assert.match(found.source, /^https:\/\/autoconfig\.lindenpost\.example\//);
  // SSL on 993 wins over STARTTLS; plain-text SMTP is skipped; placeholders are filled in.
  assert.deepEqual(found.server, {
    imap: { host: 'mail.lindenpost.example', port: 993, secure: true },
    smtp: { host: 'send.lindenpost.example', port: 587, secure: false },
    username: 'jo',
  });

  // A domain hosted by a provider that publishes its config in ISPDB under the MX's own domain.
  const ispdb = AUTOCONFIG.replace(/%EMAILLOCALPART%/g, '%EMAILADDRESS%')
    .replace(/lindenpost\.example/g, 'hostedmail.example')
    .replace('send.%EMAILDOMAIN%', 'smtp.hostedmail.example');
  const hosted = fakeNet(
    { 'bakery.example': { MX: ['10 mx1.eu.hostedmail.example'] } },
    { pages: { 'https://autoconfig.thunderbird.net/v1.1/hostedmail.example': ispdb } },
  );
  const viaIspdb = await discoverAccount('orders@bakery.example', hosted);
  assert.equal(viaIspdb.source, 'https://autoconfig.thunderbird.net/v1.1/hostedmail.example');
  assert.equal(viaIspdb.server?.imap.host, 'mail.hostedmail.example');
  assert.equal(viaIspdb.server?.username, undefined, '%EMAILADDRESS% is the address itself');
  assert.ok(hosted.calls.includes('https://autoconfig.thunderbird.net/v1.1/bakery.example'));
  assert.ok(
    hosted.calls.every(url => url.startsWith('https://')),
    'autoconfig is only fetched over HTTPS',
  );

  const guess = await discoverAccount('me@nowhere.example', fakeNet({}));
  assert.deepEqual(
    [guess.confidence, guess.server?.imap, guess.server?.smtp],
    [
      'guess',
      { host: 'imap.nowhere.example', port: 993, secure: true },
      { host: 'smtp.nowhere.example', port: 465, secure: true },
    ],
  );
  assert.equal(
    parseAutoconfig(
      '<clientConfig><emailProvider><incomingServer type="imap"><hostname>x.example</hostname><port>143</port><socketType>plain</socketType></incomingServer></emailProvider></clientConfig>',
      'a@b.example',
    ),
    undefined,
  );
});

test('DNS lookups fall back to dns.google, sort MX, join TXT chunks and tell failure apart from no records', async () => {
  const long = `v=spf1 ${Array.from({ length: 30 }, (_, i) => `ip4:192.0.2.${i}`).join(' ')} -all`;
  const zone: Zone = {
    'ex.example': { MX: ['20 B.Mx.Example', '10 a.mx.example'], TXT: [long, 'say "hi"'] },
  };
  const cf = fakeNet(zone);
  assert.deepEqual(await resolveDns('Ex.Example.', 'MX', cf), ['a.mx.example', 'b.mx.example']);
  assert.deepEqual(await resolveDns('ex.example', 'TXT', cf), [long, 'say "hi"']);
  assert.ok(long.length > 255);
  const fallback = fakeNet(zone, { down: ['cloudflare-dns.com'] });
  assert.deepEqual(await resolveDns('ex.example', 'TXT', fallback), [long, 'say "hi"']);
  assert.deepEqual(
    fallback.calls.map(u => new URL(u).hostname),
    ['cloudflare-dns.com', 'dns.google'],
  );
  assert.deepEqual(await resolveDns('missing.example', 'MX', cf), []);
  assert.equal(await resolveDns('ex.example', 'MX', { fetch: offline }), undefined);
  await assert.rejects(resolveDns('ex.example&type=A', 'A', cf), /valid domain/);
});

const status = (report: DomainReport) =>
  Object.fromEntries(report.checks.map(c => [c.id, c.status]));
const check = (report: DomainReport, id: string) => report.checks.find(c => c.id === id)!;
const workspace = (over: Zone = {}): Zone => ({
  'northwind.example': {
    MX: ['1 smtp.google.com'],
    TXT: ['google-site-verification=abc', 'v=spf1 include:_spf.google.com ~all'],
  },
  '_spf.google.com': { TXT: ['v=spf1 ip4:192.0.2.0/24 ~all'] },
  'google._domainkey.northwind.example': {
    TXT: ['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA'],
  },
  '_dmarc.northwind.example': {
    TXT: ['v=DMARC1; p=quarantine; rua=mailto:dmarc@northwind.example'],
  },
  '_mta-sts.northwind.example': { TXT: ['v=STSv1; id=20260101'] },
  ...over,
});

test('a well-configured Google Workspace domain passes every check', async () => {
  const report = await checkDomain('northwind.example', fakeNet(workspace()));
  assert.deepEqual([report.provider, report.preset], ['google', 'gmail']);
  assert.deepEqual(status(report), {
    mx: 'pass',
    spf: 'pass',
    dkim: 'pass',
    dmarc: 'pass',
    'mta-sts': 'pass',
  });
  assert.match(check(report, 'mx').detail, /smtp\.google\.com \(Google\)/);
  assert.match(check(report, 'spf').detail, /1 of 10 DNS lookups/);
  assert.match(check(report, 'dmarc').detail, /spam.*dmarc@northwind\.example/);
});

test('DMARC and SPF problems fail or warn with a fix', async () => {
  const noDmarc = await checkDomain(
    'northwind.example',
    fakeNet(workspace({ '_dmarc.northwind.example': {} })),
  );
  assert.equal(check(noDmarc, 'dmarc').status, 'fail');
  assert.match(check(noDmarc, 'dmarc').fix!, /_dmarc\.northwind\.example: v=DMARC1; p=none/);
  const monitoring = await checkDomain(
    'northwind.example',
    fakeNet(workspace({ '_dmarc.northwind.example': { TXT: ['v=DMARC1; p=none'] } })),
  );
  assert.equal(check(monitoring, 'dmarc').status, 'warn');
  assert.match(check(monitoring, 'dmarc').detail, /no rua=/);

  const two = await checkDomain(
    'northwind.example',
    fakeNet(
      workspace({
        'northwind.example': {
          MX: ['1 smtp.google.com'],
          TXT: ['v=spf1 include:_spf.google.com ~all', 'v=spf1 mx -all'],
        },
      }),
    ),
  );
  assert.equal(check(two, 'spf').status, 'fail');
  assert.equal(
    check(two, 'spf').fix,
    'Replace them with a single TXT record: v=spf1 include:_spf.google.com mx -all',
  );

  const missing = await checkDomain(
    'northwind.example',
    fakeNet(
      workspace({ 'northwind.example': { MX: ['1 smtp.google.com'], TXT: ['v=spf1 mx ?all'] } }),
    ),
  );
  assert.equal(check(missing, 'spf').status, 'warn');
  assert.match(
    check(missing, 'spf').fix!,
    /Change the TXT record to: v=spf1 mx include:_spf\.google\.com \?all/,
  );
  assert.match(check(missing, 'spf').detail, /\?all/);

  const includes = Array.from({ length: 11 }, (_, i) => `include:s${i}.senders.example`).join(' ');
  const heavy = await checkDomain(
    'northwind.example',
    fakeNet(
      workspace({
        'northwind.example': {
          MX: ['1 smtp.google.com'],
          TXT: [`v=spf1 include:_spf.google.com ${includes} -all`],
        },
      }),
    ),
  );
  assert.equal(check(heavy, 'spf').status, 'fail');
  assert.match(check(heavy, 'spf').detail, /more than 10 DNS lookups/);
  // Nested includes count too.
  const nested = workspace({
    'northwind.example': {
      MX: ['1 smtp.google.com'],
      TXT: ['v=spf1 include:_spf.google.com include:bulk.example -all'],
    },
    'bulk.example': {
      TXT: [`v=spf1 ${Array.from({ length: 9 }, (_, i) => `a:h${i}.bulk.example`).join(' ')} -all`],
    },
  });
  assert.equal(
    check(await checkDomain('northwind.example', fakeNet(nested)), 'spf').status,
    'fail',
  );
});

test('DKIM is found through Microsoft CNAMEs, revoked keys fail, and failed lookups are unknown', async () => {
  const contoso: Zone = {
    'contoso.example': {
      MX: ['0 contoso-example.mail.protection.outlook.com'],
      TXT: ['v=spf1 include:spf.protection.outlook.com -all'],
    },
    'spf.protection.outlook.com': { TXT: ['v=spf1 ip4:192.0.2.0/24 -all'] },
    'selector1._domainkey.contoso.example': {
      CNAME: ['selector1-contoso-example._domainkey.contoso.onmicrosoft.com'],
    },
    '_dmarc.contoso.example': { TXT: ['v=DMARC1; p=reject'] },
  };
  const ms = await checkDomain('contoso.example', fakeNet(contoso));
  assert.deepEqual([ms.provider, ms.preset], ['microsoft', 'outlook']);
  assert.equal(check(ms, 'dkim').status, 'pass');
  assert.match(check(ms, 'dkim').detail, /selector1\._domainkey \(it points to Microsoft\)/);
  assert.deepEqual(check(ms, 'dkim').records, [
    'selector1._domainkey CNAME selector1-contoso-example._domainkey.contoso.onmicrosoft.com',
  ]);
  assert.equal(check(ms, 'mta-sts').status, 'warn');
  assert.match(check(ms, 'mta-sts').detail, /Optional/);

  const revoked = await checkDomain(
    'northwind.example',
    fakeNet(workspace({ 'google._domainkey.northwind.example': { TXT: ['v=DKIM1; k=rsa; p='] } })),
  );
  assert.equal(check(revoked, 'dkim').status, 'fail');
  assert.match(check(revoked, 'dkim').detail, /revoked/);
  // A selector that points at the host but resolves to a revoked key is not reported as found.
  const rotated = await checkDomain(
    'contoso.example',
    fakeNet({
      ...contoso,
      'selector2._domainkey.contoso.example': {
        CNAME: ['selector2-contoso-example._domainkey.contoso.onmicrosoft.com'],
      },
      'selector2-contoso-example._domainkey.contoso.onmicrosoft.com': {
        TXT: ['v=DKIM1; k=rsa; p='],
      },
    }),
  );
  assert.equal(check(rotated, 'dkim').status, 'pass');
  assert.match(
    check(rotated, 'dkim').detail,
    /^Found a DKIM key at selector1\._domainkey \(it points to Microsoft\)\. The key at selector2\._domainkey is empty/,
  );

  const unknownHost = await checkDomain(
    'plain.example',
    fakeNet({ 'plain.example': { MX: ['10 mail.plain.example'], TXT: ['v=spf1 mx -all'] } }),
  );
  assert.deepEqual(
    [unknownHost.provider, check(unknownHost, 'dkim').status, check(unknownHost, 'spf').status],
    ['unknown', 'warn', 'pass'],
  );
  assert.match(check(unknownHost, 'dkim').detail, /can't list every name/);

  const down = await checkDomain('northwind.example', { fetch: offline });
  assert.equal(down.provider, 'unknown');
  assert.deepEqual(status(down), {
    mx: 'unknown',
    spf: 'unknown',
    dkim: 'unknown',
    dmarc: 'unknown',
    'mta-sts': 'unknown',
  });
});

test('Proton addresses and configs pointing at a local bridge are not offered as mail servers', async () => {
  const none = (async () => {
    throw new Error('no network expected');
  }) as unknown as typeof fetch;
  const proton = await discoverAccount('kim@proton.me', { fetch: none });
  assert.match(proton.unsupported!, /Bridge/);
  const bridge =
    '<clientConfig><emailProvider id="x"><incomingServer type="imap"><hostname>127.0.0.1</hostname><port>1143</port><socketType>STARTTLS</socketType></incomingServer><outgoingServer type="smtp"><hostname>127.0.0.1</hostname><port>1025</port><socketType>STARTTLS</socketType></outgoingServer></emailProvider></clientConfig>';
  assert.equal(parseAutoconfig(bridge, 'kim@example.org'), undefined);
});

test('discovered hosts on this computer or a private network are dropped, in every spelling', async () => {
  for (const ip of [
    '127.0.0.1',
    '127.1',
    '2130706433',
    '0x7f000001',
    '0x7f.1',
    '017700000001',
    '0177.0.0.1',
    '10.1.2.3',
    '172.31.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '[::1]',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1%en0',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
  ])
    assert.equal(blockedAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111', '::ffff:8.8.8.8'])
    assert.equal(blockedAddress(ip), false, ip);
  assert.equal(blockedAddress('mail.example.com'), undefined);
  const resolve = async (host: string) =>
    (
      ({
        'evil.example': ['93.184.216.34', '10.0.0.5'],
        'v6.example': ['fe80::2'],
        'ok.example': ['93.184.216.34', '2606:4700::1111'],
      }) as Record<string, string[]>
    )[host] ?? [];
  for (const host of [
    'localhost',
    'mail.localhost',
    'printer.local',
    'db.internal',
    'intranet',
    '127.1',
    '0x7f.1',
    '[::1]',
    'evil.example',
    'v6.example',
    '1.2.3.4.5',
  ])
    assert.equal(await publicHost(host, resolve), false, host);
  assert.equal(await publicHost('ok.example', resolve), true);
  assert.equal(
    await publicHost('8.8.8.8', async () => {
      throw new Error('literals need no lookup');
    }),
    true,
  );

  const config = (
    imap: string,
    smtp = `smtp.${imap.split('.').slice(1).join('.') || 'x.example'}`,
  ) =>
    `<clientConfig><emailProvider id="x"><incomingServer type="imap"><hostname>${imap}</hostname><port>993</port><socketType>SSL</socketType></incomingServer><outgoingServer type="smtp"><hostname>${smtp}</hostname><port>465</port><socketType>SSL</socketType></outgoingServer></emailProvider></clientConfig>`;
  assert.equal(parseAutoconfig(config('127.1', 'smtp.x.example'), 'a@x.example'), undefined);
  assert.equal(parseAutoconfig(config('0x7f.1', 'smtp.x.example'), 'a@x.example'), undefined);
  const url =
    'https://autoconfig.rebind.example/mail/config-v1.1.xml?emailaddress=a%40rebind.example';
  // An ordinary-looking name in the config that resolves to a private address is not offered.
  const rebind = fakeNet(
    {
      'rebind.example': { MX: ['10 mx.rebind.example'] },
      'imap.rebind.example': { A: ['192.168.0.10'] },
      'smtp.rebind.example': { A: ['93.184.216.34'] },
    },
    { pages: { [url]: config('imap.rebind.example', 'smtp.rebind.example') } },
  );
  assert.equal(
    await publicHost('imap.rebind.example', dohLookup({ fetch: rebind.fetch })),
    false,
    'the default resolver reads A records over DNS-over-HTTPS',
  );
  const found = await discoverAccount('a@rebind.example', rebind);
  assert.equal(found.confidence, 'guess');
  assert.equal(
    found.server,
    undefined,
    'the guessed imap.rebind.example is private too, so no servers are suggested',
  );
  const fine = fakeNet(
    {
      'rebind.example': { MX: ['10 mx.rebind.example'] },
      'imap.rebind.example': { A: ['93.184.216.34'] },
      'smtp.rebind.example': { A: ['93.184.216.34'] },
    },
    { pages: { [url]: config('imap.rebind.example', 'smtp.rebind.example') } },
  );
  const vetted = await discoverAccount('a@rebind.example', fine);
  assert.deepEqual(
    [vetted.confidence, vetted.server?.imap.host],
    ['autoconfig', 'imap.rebind.example'],
  );
});

test('autoconfig redirects are followed by hand, and only to public HTTPS hosts', async () => {
  const start = 'https://autoconfig.hop.example/mail/config-v1.1.xml?emailaddress=a%40hop.example';
  const xml =
    '<clientConfig><emailProvider id="x"><incomingServer type="imap"><hostname>mail.hop.example</hostname><port>993</port><socketType>SSL</socketType></incomingServer><outgoingServer type="smtp"><hostname>mail.hop.example</hostname><port>465</port><socketType>SSL</socketType></outgoingServer></emailProvider></clientConfig>';
  const run = async (redirects: Record<string, string>) => {
    const net = fakeNet({
        'hop.example': { MX: ['10 mx.hop.example'] },
        'inside.hop.example': { A: ['10.0.0.8'] },
      }),
      requested: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = String(input);
      if (
        !href.startsWith('https://cloudflare-dns.com/') &&
        !href.startsWith('https://dns.google/')
      ) {
        requested.push(href);
        assert.equal(init?.redirect, 'manual');
        if (redirects[href])
          return new Response(null, { status: 302, headers: { location: redirects[href] } });
        if (href === 'https://final.hop.example/config.xml') return new Response(xml);
        return new Response('missing', { status: 404 });
      }
      return net.fetch(input);
    }) as typeof globalThis.fetch;
    return {
      found: await discoverAccount('a@hop.example', { fetch, lookup: net.lookup }),
      requested,
    };
  };
  const ok = await run({
    [start]: '/next',
    ['https://autoconfig.hop.example/next']: 'https://final.hop.example/config.xml',
  });
  assert.deepEqual([ok.found.confidence, ok.found.source], ['autoconfig', start]);
  const http = await run({ [start]: 'http://final.hop.example/config.xml' });
  assert.equal(http.found.confidence, 'guess');
  assert.ok(!http.requested.some(u => u.startsWith('http:')));
  const inside = await run({ [start]: 'https://inside.hop.example/config.xml' });
  assert.equal(inside.found.confidence, 'guess');
  assert.ok(!inside.requested.some(u => u.includes('inside.hop.example')));
  const literal = await run({ [start]: 'https://127.1/config.xml' });
  assert.ok(!literal.requested.some(u => u.includes('127.')));
  const loop = await run({
    [start]: 'https://a.hop.example/1',
    'https://a.hop.example/1': 'https://a.hop.example/2',
    'https://a.hop.example/2': 'https://a.hop.example/3',
    'https://a.hop.example/3': 'https://final.hop.example/config.xml',
  });
  assert.equal(loop.found.confidence, 'guess', 'more than three redirects are not followed');
});

test('SPF lookups stop at all, and redirect is ignored when all is present', async () => {
  const includes = Array.from({ length: 11 }, (_, i) => `include:s${i}.senders.example`).join(' ');
  const plain = (txt: string, over: Zone = {}) =>
    checkDomain(
      'plain.example',
      fakeNet({ 'plain.example': { MX: ['10 mail.plain.example'], TXT: [txt] }, ...over }),
    );
  const after = check(await plain(`v=spf1 -all ${includes}`), 'spf');
  assert.equal(after.status, 'pass');
  assert.match(after.detail, /using 0 of 10 DNS lookups/);
  const heavy = { 'big.example': { TXT: [`v=spf1 ${includes} -all`] } };
  const ignored = check(await plain('v=spf1 mx redirect=big.example -all', heavy), 'spf');
  assert.equal(ignored.status, 'pass');
  assert.match(ignored.detail, /using 1 of 10/);
  assert.equal(
    check(await plain('v=spf1 mx redirect=big.example', heavy), 'spf').status,
    'fail',
    'without all, the redirect is followed',
  );
});

test('DMARC records with repeated tags or invalid values fail instead of passing', async () => {
  assert.deepEqual(duplicateTags('v=DMARC1; p=reject; P=none; pct=banana'), ['p']);
  const dmarc = async (record: string) =>
    check(
      await checkDomain(
        'northwind.example',
        fakeNet(workspace({ '_dmarc.northwind.example': { TXT: [record] } })),
      ),
      'dmarc',
    );
  const bad = await dmarc('v=DMARC1; p=reject; p=none; pct=banana');
  assert.equal(bad.status, 'fail');
  assert.match(bad.detail, /repeats p=.*pct=banana/);
  assert.match(bad.fix!, /v=DMARC1; p=reject/);
  for (const record of [
    'v=DMARC1; p=reject; pct=101',
    'v=DMARC1; p=reject; pct=50.5',
    'v=DMARC1; p=reject; sp=deny',
    'v=DMARC1; p=block',
  ])
    assert.equal((await dmarc(record)).status, 'fail', record);
  const partial = await dmarc('v=DMARC1; p=reject; sp=quarantine; pct=25');
  assert.equal(partial.status, 'pass');
  assert.match(partial.detail, /only 25%/);
});
