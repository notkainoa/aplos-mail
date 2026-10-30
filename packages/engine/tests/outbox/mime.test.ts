import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnvelope,
  buildMime,
  checkAddress,
  htmlToText,
  MimeError,
  newMessageId,
  quotedPrintable,
  type MimeInput,
} from '../../src/outbox/mime';

const T0 = Date.UTC(2026, 9, 28, 9, 0, 0);
const decoder = new TextDecoder();
const counter = () => {
  let n = 0;
  return (size: number) => Uint8Array.from({ length: size }, () => ++n % 256);
};

function input(extra: Partial<MimeInput> = {}): MimeInput {
  return {
    from: { address: 'owner@mail.example', name: 'Owner' },
    to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
    cc: [],
    subject: 'Lunch',
    html: '<p>Lunch at noon?</p>',
    messageId: '<abc@mail.example>',
    date: T0,
    randomBytes: counter(),
    ...extra,
  };
}

/** The unfolded header lines and the body of a message, split at the first blank line. */
function parse(bytes: Uint8Array) {
  const text = decoder.decode(bytes);
  const at = text.indexOf('\r\n\r\n');
  const head = text.slice(0, at).replace(/\r\n[ \t]+/g, ' ');
  const headers = head.split('\r\n').map(line => {
    const colon = line.indexOf(':');
    return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  });
  return { text, headers, body: text.slice(at + 4), head: text.slice(0, at) };
}

const named = (headers: { name: string }[], name: string) =>
  headers.filter(h => h.name.toLowerCase() === name.toLowerCase());

/** RFC 2047: whitespace between two encoded words is not part of the text. */
function decodeWords(value: string) {
  return value
    .replace(/\?=\s+(?==\?UTF-8)/g, '?=')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b64: string) =>
      Buffer.from(b64, 'base64').toString('utf8'),
    );
}

test('the same input and randomness give byte-identical MIME, so a kept copy can be reused as is', () => {
  const a = buildMime(input());
  const b = buildMime(input());
  assert.deepEqual(a, b);
  const c = buildMime(input({ randomBytes: undefined }));
  assert.notDeepEqual(
    a,
    c,
    'a different boundary is a different message: that is why the bytes are kept',
  );
});

test('the headers are the expected ones, with CRLF line ends and a Message-ID that is exactly the one given', () => {
  const { headers, head } = parse(buildMime(input()));
  assert.deepEqual(
    headers.map(h => h.name),
    ['Date', 'From', 'To', 'Subject', 'Message-ID', 'MIME-Version', 'Content-Type'],
  );
  assert.equal(named(headers, 'Message-ID')[0].value, '<abc@mail.example>');
  assert.equal(named(headers, 'Date')[0].value, 'Wed, 28 Oct 2026 09:00:00 +0000');
  assert.equal(named(headers, 'From')[0].value, 'Owner <owner@mail.example>');
  assert.ok(!/(^|[^\r])\n/.test(head), 'no bare LF in the headers');
});

test('header injection: CR and LF in the subject or in names never start a header', () => {
  const evil = 'Hi\r\nBcc: attacker@evil.example\r\nX-Injected: yes';
  const bytes = buildMime(
    input({
      subject: evil,
      from: { address: 'owner@mail.example', name: `Owner${'\r\n'}Bcc: a@evil.example` },
      to: [{ address: 'jordan@mail.example', name: 'Jo\nrdan\r\nCc: b@evil.example' }],
      cc: [{ address: 'cc@mail.example', name: '\r\nX-Cc: yes\r\n' }],
    }),
  );
  const { headers, head } = parse(bytes);
  for (const name of ['Bcc', 'X-Injected', 'X-Cc'])
    assert.equal(named(headers, name).length, 0, `${name} must not exist`);
  assert.equal(named(headers, 'Cc').length, 1, 'only the real Cc');
  assert.equal(named(headers, 'Subject').length, 1);
  assert.ok(!/\r\n(Bcc|X-Injected|X-Cc):/i.test(head));
  assert.match(
    named(headers, 'Subject')[0].value,
    /^Hi Bcc: attacker@evil\.example X-Injected: yes$/,
  );
});

test('header injection: other line breaks and control characters are encoded, never written raw', () => {
  const subject = 'a\u2028Bcc: x@evil.example\u0085b\u000bc\u0000d';
  const { head, headers } = parse(buildMime(input({ subject })));
  assert.ok(
    !['\u2028', '\u0085', '\u000b', '\u0000'].some(ch => head.includes(ch)),
    'raw separators never reach the header block',
  );
  assert.equal(named(headers, 'Bcc').length, 0);
  assert.equal(named(headers, 'Subject').length, 1);
});

test('an address with CR/LF, spaces, quotes, brackets or a second @ is refused; Bcc names are not headers', () => {
  const bad = [
    'a@b.example\r\nBcc: x@evil.example',
    'a@b.example\nX: y',
    'a b@mail.example',
    '"a"@mail.example',
    'a@@mail.example',
    'a@mail.example>',
    '<a@mail.example>',
    'a,b@mail.example',
    'a@mail.example;c@mail.example',
    'nodomain@',
    '@mail.example',
    'plain',
    'ünï@mail.example',
    'a@bad domain.example',
    'a@mail.example/path',
    '',
  ];
  for (const address of bad) {
    assert.throws(() => checkAddress(address), MimeError, JSON.stringify(address));
    assert.throws(() => buildMime(input({ to: [{ address }] })), MimeError);
    assert.throws(() => buildMime(input({ from: { address } })), MimeError);
  }
  assert.equal(checkAddress('first.last+tag@sub.mail.example'), 'first.last+tag@sub.mail.example');
});

test('a non-ASCII domain is written as punycode in the header and the envelope', () => {
  assert.equal(checkAddress('anna@münchen.example'), 'anna@xn--mnchen-3ya.example');
  const { headers } = parse(buildMime(input({ to: [{ address: 'anna@münchen.example' }] })));
  assert.equal(named(headers, 'To')[0].value, 'anna@xn--mnchen-3ya.example');
  const env = buildEnvelope(
    { address: 'owner@mail.example' },
    {
      to: [{ address: 'anna@münchen.example' }],
      cc: [],
      bcc: [],
    },
  );
  assert.deepEqual(env.rcpt, ['anna@xn--mnchen-3ya.example']);
});

test('the envelope validates Bcc, de-duplicates case-insensitively and keeps Bcc out of the headers', () => {
  const from = { address: 'owner@mail.example' };
  const env = buildEnvelope(from, {
    to: [{ address: 'A@mail.example' }],
    cc: [{ address: 'a@MAIL.example' }, { address: 'c@mail.example' }],
    bcc: [{ address: 'secret@mail.example' }],
  });
  assert.deepEqual(env, {
    from: 'owner@mail.example',
    rcpt: ['A@mail.example', 'c@mail.example', 'secret@mail.example'],
  });
  assert.throws(
    () =>
      buildEnvelope(from, {
        to: [{ address: 'a@mail.example' }],
        cc: [],
        bcc: [{ address: 'x@mail.example\r\nRCPT TO:<y@evil.example>' }],
      }),
    MimeError,
    'an SMTP command smuggled in a Bcc address is refused',
  );
  assert.throws(
    () =>
      buildEnvelope(
        { address: 'owner@mail.example\r\nMAIL FROM:<x@evil.example>' },
        { to: [], cc: [], bcc: [] },
      ),
    MimeError,
  );
  const { text } = parse(buildMime(input({ to: [{ address: 'a@mail.example' }] })));
  assert.ok(!/secret@mail\.example/.test(text));
});

test('names and subjects with non-ASCII text are RFC 2047 encoded, round-trip, and stay under 76 columns', () => {
  const subject = 'Café ☕ — réunion à 12h, déjeuner « très » important ' + 'é'.repeat(80);
  const name = 'Zoë Ørsted 日本語';
  const bytes = buildMime(input({ subject, to: [{ address: 'jordan@mail.example', name }] }));
  const { headers, head } = parse(bytes);
  assert.ok(/^[\x20-\x7e\r\n]*$/.test(head), 'the header block is plain ASCII');
  assert.ok(
    head.split('\r\n').every(line => line.length <= 78),
    'folded lines stay short',
  );
  assert.equal(decodeWords(named(headers, 'Subject')[0].value), subject);
  const to = named(headers, 'To')[0].value;
  assert.match(to, /^=\?UTF-8\?B\?/);
  assert.equal(decodeWords(to), `${name} <jordan@mail.example>`);
});

test('display names with specials are quoted and escaped; plain ones are left alone', () => {
  const { headers } = parse(
    buildMime(
      input({
        to: [
          { address: 'a@mail.example', name: 'Doe, Jane' },
          { address: 'b@mail.example', name: 'say "hi" \\ there' },
          { address: 'c@mail.example', name: 'Plain Name' },
        ],
      }),
    ),
  );
  assert.equal(
    named(headers, 'To')[0].value,
    '"Doe, Jane" <a@mail.example>, "say \\"hi\\" \\\\ there" <b@mail.example>, Plain Name <c@mail.example>',
  );
});

test('a long recipient list is folded into short lines and unfolds to exactly the addresses', () => {
  const to = Array.from({ length: 300 }, (_, i) => ({ address: `person${i}@mail.example` }));
  const { head, headers } = parse(buildMime(input({ to })));
  assert.ok(head.split('\r\n').every(line => line.length <= 78));
  assert.deepEqual(
    named(headers, 'To')[0].value.split(', '),
    to.map(a => a.address),
  );
});

test('quoted-printable bodies keep lines under 77 characters and decode back to the text', () => {
  const html = '<p>' + 'Grüße aus Zürich = ünïcode ☕ '.repeat(40) + '</p>\n<p>second  \nline</p>';
  const encoded = quotedPrintable(html);
  assert.ok(encoded.split('\r\n').every(line => line.length <= 76));
  const decoded = encoded
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  assert.equal(
    Buffer.from(decoded, 'latin1').toString('utf8').replace(/\r\n/g, '\n').trimEnd(),
    html.replace(/[ \t]+$/gm, m => m).trimEnd(),
  );
  const { body } = parse(buildMime(input({ html })));
  assert.ok(body.split('\r\n').every(line => line.length <= 76));
});

test('a plain-text alternative is made from the HTML: blocks, breaks, entities; scripts and styles dropped', () => {
  const html =
    '<style>p{color:red}</style><p>Hello&nbsp;<b>there</b> &amp; welcome</p><script>alert(1)</script>' +
    '<ul><li>one</li><li>two</li></ul>line<br>break<div>a &lt; b &#233;</div>';
  assert.equal(
    htmlToText(html),
    'Hello there & welcome\n\n- one\n- two\n\nline\nbreak\na < b é'.replace('\n\n\n', '\n\n'),
  );
});

test('htmlToText: a lone < is text, an unclosed script drops the rest, and ASCII lower-casing keeps offsets', () => {
  assert.equal(htmlToText('a < b and c > d'), 'a < b and c > d');
  assert.equal(htmlToText('keep<script>never closed <b>x</b>'), 'keep');
  // `İ` lower-cases to two code units with `toLowerCase`, which used to shift every later offset.
  assert.equal(htmlToText('İİİ<script>x</script>after<SCRIPT>y</SCRIPT>end'), 'İİİafterend');
});

test('htmlToText is linear on hostile input (no regex backtracking over a megabyte)', () => {
  const started = Date.now();
  const inputs = [
    '<'.repeat(1_000_000),
    '<li '.repeat(250_000),
    '<a '.repeat(300_000) + '>',
    '&#'.repeat(500_000),
  ];
  for (const html of inputs) htmlToText(html);
  assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
});

test('attachments: base64 lines of 76, names encoded safely, mixed wrapper; inline images in related', () => {
  const bytes = Uint8Array.from({ length: 5_000 }, (_, i) => i % 256);
  const evilName = 'rep"ort\r\nX-Evil: 1 ünï.pdf';
  const mime = buildMime(
    input({
      html: '<p>see <img src="cid:logo@aplos"></p>',
      attachments: [
        { name: evilName, mime: 'application/pdf', bytes },
        {
          name: 'logo.png',
          mime: 'image/png',
          bytes: bytes.slice(0, 300),
          inline: true,
          contentId: 'logo@aplos',
        },
        { name: 'x.bin', mime: 'bad type;\r\nX-Evil: 2', bytes: new Uint8Array(0) },
      ],
    }),
  );
  const { text, headers } = parse(mime);
  assert.equal(named(headers, 'X-Evil').length, 0);
  assert.ok(!/\r\nX-Evil:/.test(text), 'no injected header anywhere in the message');
  assert.match(named(headers, 'Content-Type')[0].value, /^multipart\/mixed; boundary="=_aplos_/);
  assert.ok(
    text.includes('Content-Type: multipart/related; boundary='),
    'inline image inside multipart/related',
  );
  assert.ok(text.includes('Content-ID: <logo@aplos>'));
  assert.ok(text.includes('Content-Type: application/octet-stream'), 'an unusable type falls back');
  assert.ok(text.includes("filename*=UTF-8''"), 'a non-ASCII name uses RFC 2231');
  const b64 = text.split('\r\n').filter(l => /^[A-Za-z0-9+/]{76}$/.test(l));
  assert.ok(b64.length > 50);
  assert.ok(text.split('\r\n').every(l => l.length <= 998));
});

test('boundaries are unique per part and never appear in the content', () => {
  const mime = buildMime(
    input({
      attachments: [{ name: 'a.txt', mime: 'text/plain', bytes: new TextEncoder().encode('x') }],
    }),
  );
  const text = decoder.decode(mime);
  const boundaries = [...text.matchAll(/boundary="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(boundaries).size, boundaries.length);
  for (const b of boundaries) assert.equal(text.split(`--${b}\r\n`).length > 1, true);
  const hostile = buildMime(input({ html: '<p>--=_aplos_00 boundary in the body</p>' }));
  assert.ok(
    decoder.decode(hostile).includes('--=3D_aplos_00'),
    '`=` is quoted-printable encoded, so a boundary cannot be forged',
  );
});

test('replies carry In-Reply-To and References; malformed ids from the store are dropped', () => {
  const { headers } = parse(
    buildMime(
      input({
        inReplyTo: '<parent@mail.example>',
        references: [
          '<root@mail.example>',
          'not an id',
          '<bad\r\nBcc: x@evil.example>',
          '<parent@mail.example>',
        ],
      }),
    ),
  );
  assert.equal(named(headers, 'In-Reply-To')[0].value, '<parent@mail.example>');
  assert.equal(named(headers, 'References')[0].value, '<root@mail.example> <parent@mail.example>');
  assert.equal(named(headers, 'Bcc').length, 0);
  const none = parse(buildMime(input({ inReplyTo: 'x\r\nBcc: y@evil.example' })));
  assert.equal(named(none.headers, 'In-Reply-To').length, 0);
});

test('a Message-ID that is not a plain <id> is refused instead of written', () => {
  for (const messageId of [
    'abc@mail.example',
    '<a b@mail.example>',
    '<a@b>\r\nBcc: x@evil.example',
    '<>',
  ])
    assert.throws(() => buildMime(input({ messageId })), MimeError, messageId);
});

test('newMessageId: 128 random bits at the sender domain, different every time', () => {
  const a = newMessageId(undefined, 'mail.example');
  const b = newMessageId(undefined, 'mail.example');
  assert.match(a, /^<[0-9a-f]{32}@mail\.example>$/);
  assert.notEqual(a, b);
  assert.match(newMessageId(), /^<[0-9a-f]{32}@aplos\.local>$/);
});
