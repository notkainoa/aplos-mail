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

const named = <T extends { name: string }>(headers: T[], name: string) =>
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

test('a subject or a name that looks like an encoded word is encoded, so a reader shows the characters typed', () => {
  const lookalike = '=?UTF-8?B?SGk=?=';
  const bytes = buildMime(
    input({
      subject: lookalike,
      to: [{ address: 'jordan@mail.example', name: lookalike }],
      from: { address: 'owner@mail.example', name: 'a =?us-ascii?q?b?= c' },
    }),
  );
  const { headers, head } = parse(bytes);
  assert.ok(!head.includes(lookalike), 'the look-alike is never written raw');
  const subject = named(headers, 'Subject')[0].value;
  assert.equal(decodeWords(subject), lookalike, 'and decodes back to what was typed');
  assert.equal(decodeWords(named(headers, 'To')[0].value), `${lookalike} <jordan@mail.example>`);
  assert.equal(
    decodeWords(named(headers, 'From')[0].value),
    'a =?us-ascii?q?b?= c <owner@mail.example>',
  );
  // An ordinary subject with an equals sign or a question mark is still written plain.
  const plain = parse(buildMime(input({ subject: 'Is x=1 ok?' })));
  assert.equal(named(plain.headers, 'Subject')[0].value, 'Is x=1 ok?');
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

const median = (values: number[]) =>
  [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)]!;

const timeOf = (run: (size: number) => void, size: number) => {
  const started = performance.now();
  run(size);
  return performance.now() - started;
};

/** Small runs must take about this long before their ratio means anything (GC and other suites' CPU dominate below). */
const MEASURABLE_MS = 30;
const MAX_SIZE = 1_000_000;
/** Midway between linear (4) and quadratic (16) on a log scale. */
const LINEAR_GROWTH_LIMIT = 11;

/**
 * Asserts `run` is not quadratic. Calibrates the size by doubling until one run takes at least 30 ms, warms up, then
 * compares the median of five runs at that size with the median of five at 4x the size, run one after the other: about
 * 4 for linear code, about 16 for quadratic. A run that stays fast even at the largest size is linear enough on its own:
 * it only has to finish the 4x input quickly.
 */
function measureOnce(run: (size: number) => void, start: number): { ok: boolean; message: string } {
  run(start); // warm-up: compile, allocate
  let size = start;
  while (timeOf(run, size) < MEASURABLE_MS && size < MAX_SIZE) size *= 2;
  const sample = (n: number) => median(Array.from({ length: 5 }, () => timeOf(run, n)));
  const small = sample(size);
  const large = sample(size * 4);
  if (small < MEASURABLE_MS)
    return { ok: large < 2_000, message: `the 4x input took ${large.toFixed(0)} ms` };
  const ratio = large / small;
  return {
    ok: ratio < LINEAR_GROWTH_LIMIT,
    message: `4x the input took ${ratio.toFixed(1)}x the time (${small.toFixed(0)} ms to ${large.toFixed(0)} ms)`,
  };
}

/** Quadratic code fails every attempt (about 16x each time); a GC pause or a loaded machine rarely repeats. */
const ATTEMPTS = 3;

function assertNotQuadratic(label: string, run: (size: number) => void, start: number): void {
  const seen: string[] = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const result = measureOnce(run, start);
    if (result.ok) return;
    seen.push(result.message);
  }
  assert.fail(`${label}: ${seen.join('; ')}`);
}

test('htmlToText: named entities are case-sensitive', () => {
  assert.equal(htmlToText('&Eacute;t&eacute;'), 'Été');
  assert.equal(htmlToText('&Ntilde;ame &ntilde;ame'), 'Ñame ñame');
  assert.equal(htmlToText('&EACUTE;'), '&EACUTE;', 'all-caps stays literal');
});

test('htmlToText skips the content of every non-rendered element name', () => {
  for (const name of [
    'script',
    'style',
    'head',
    'title',
    'noscript',
    'textarea',
    'iframe',
    'object',
    'template',
    'select',
    'svg',
  ]) {
    assert.equal(htmlToText(`<${name}>drop me</${name}>keep`), 'keep', `<${name}>`);
    assert.equal(htmlToText(`<${name} src="x"/>keep`), 'keep', `self-closing <${name}>`);
  }
});

test('htmlToText is linear on hostile input (no regex backtracking over a megabyte)', () => {
  const shapes: Array<(n: number) => string> = [
    n => '<'.repeat(n),
    n => '<li '.repeat(n / 4),
    n => '<a '.repeat(n / 3) + '>',
    n => '&#'.repeat(n / 2),
  ];
  shapes.forEach((shape, i) =>
    assertNotQuadratic(`hostile shape ${i}`, n => void htmlToText(shape(n)), 50_000),
  );
});

test('htmlToText trims line ends in linear time: long runs of spaces, tabs and &nbsp; between text', () => {
  // The old per-line `/[ \t]+$/` was quadratic: 50,000 spaces took 28 s, so these would take minutes.
  assertNotQuadratic('spaces', n => void htmlToText('a' + ' '.repeat(n) + 'b'), 4_000);
  const spaces = htmlToText('a' + ' '.repeat(100_000) + 'b');
  const mixed = htmlToText('a' + ' \t'.repeat(60_000) + 'b');
  const nbsp = htmlToText('a' + '&nbsp;'.repeat(60_000) + 'b');
  const tail = htmlToText('x' + ' '.repeat(200_000) + '\ny');
  assert.equal(spaces.length, 100_002, 'inner spaces are kept');
  assert.equal(mixed.length, 120_002);
  assert.equal(nbsp.length, 60_002);
  assert.equal(tail, 'x\ny', 'trailing spaces and tabs go');
  assert.equal(htmlToText('a \t \nb\t\n\n\n\nc  '), 'a\nb\n\nc');
});

test('htmlToText stays linear on tags that each end or start a line', () => {
  // `out.endsWith('\n')` per tag flattened the growing string every time: `<br>` took 6.9 s, `x<p>` 22.8 s at 100k tags.
  for (const unit of ['<br>', 'x<p>'])
    assertNotQuadratic(unit, n => void htmlToText(unit.repeat(n)), 10_000);
  const breaks = htmlToText('<br>'.repeat(100_000));
  const paragraphs = htmlToText('x<p>'.repeat(100_000));
  assert.equal(breaks, '');
  assert.equal(paragraphs.split('\n').filter(Boolean).length, 100_000);
  assert.equal(htmlToText('a<br>b<p>c</p>d<div>e'), 'a\nb\nc\n\nd\ne');
});

test('a subject of 100,000 spaces folds in linear time and never into a whitespace-only line', () => {
  assertNotQuadratic(
    'subject fold',
    n => void buildMime(input({ subject: 'Re:' + ' '.repeat(n) + 'x' })),
    10_000,
  );
  const out = parse(buildMime(input({ subject: 'Re:' + ' '.repeat(100_000) + 'x' }))).head;
  for (const line of out.split('\r\n')) assert.ok(line.trim() !== '', 'no whitespace-only line');
  const subject = parse(buildMime(input({ subject: 'Re:' + ' '.repeat(100_000) + 'x' }))).headers;
  assert.equal(named(subject, 'Subject')[0].value, 'Re: x', 'a run of spaces is one space');
});

test('References keep the first id and the last 20, and the header block has a ceiling', () => {
  const refs = Array.from({ length: 5_000 }, (_, i) => `<ref${i}@mail.example>`);
  const { headers, head } = parse(buildMime(input({ references: refs })));
  const ids = named(headers, 'References')[0].value.split(' ');
  assert.equal(ids.length, 21);
  assert.equal(ids[0], '<ref0@mail.example>');
  assert.equal(ids[20], '<ref4999@mail.example>');
  assert.equal(ids[1], '<ref4980@mail.example>');
  assert.ok(head.length < 3_000, `header block is ${head.length} octets`);
});

test('a header block past 10,000 octets is refused', () => {
  assert.throws(
    () => buildMime(input({ subject: 'é'.repeat(20_000) })),
    (e: unknown) => e instanceof MimeError && /too long/.test(e.message),
  );
});

test('a Message-ID with NUL, control or 8-bit bytes (from inbound mail) is dropped, never written', () => {
  const hostile = ['<a\0bé\u0085c@evil>', '<r\u0001@evil>', '<tab\t@evil>', '<del\u007f@evil>'];
  const out = buildMime(
    input({
      inReplyTo: hostile[0],
      references: [...hostile, '<ok@mail.example>'],
    }),
  );
  const { headers, head } = parse(out);
  assert.equal(named(headers, 'In-Reply-To').length, 0);
  assert.equal(named(headers, 'References')[0].value, '<ok@mail.example>');
  // The whole header block is printable ASCII (and CRLF): nothing from the hostile ids got through.
  assert.match(head, /^[\x20-\x7e\r\n]*$/);
  const only = parse(buildMime(input({ inReplyTo: hostile[1], references: [hostile[0]] })));
  assert.equal(named(only.headers, 'In-Reply-To').length, 0);
  assert.equal(named(only.headers, 'References').length, 0);
  assert.throws(() => buildMime(input({ messageId: '<a\0b@mail.example>' })), MimeError);
  assert.throws(() => buildMime(input({ messageId: '<café@mail.example>' })), MimeError);
});

test('no header line passes 998 octets: a 3,000-character attachment name and other long unbroken values', () => {
  const long = 'x'.repeat(3_000) + '.pdf';
  const bytes = new Uint8Array(10);
  const mime = buildMime(
    input({
      from: { address: 'owner@mail.example', name: 'a,'.repeat(750) },
      subject: 'S'.repeat(1_500),
      attachments: [
        { name: long, mime: 'application/pdf', bytes },
        { name: 'é'.repeat(1_500) + '.pdf', mime: 'application/pdf', bytes },
        { name: 'cid.png', mime: 'image/png', bytes, inline: true, contentId: 'c'.repeat(3_000) },
      ],
    }),
  );
  const text = decoder.decode(mime);
  const lines = text.split('\r\n');
  assert.ok(Math.max(...lines.map(l => l.length)) <= 998, 'no line over 998');
  // The name is not lost: RFC 2231 continuations unfold back to it.
  const section = (param: string) =>
    [...text.matchAll(new RegExp(`(?<![a-z])${param}\\*(\\d+)="([^"]*)"`, 'g'))]
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map(m => m[2])
      .join('');
  assert.equal(section('filename'), long);
  assert.equal(section('name'), long);
  const encoded = [...text.matchAll(/filename\*(\d+)\*=(?:UTF-8'')?([^;\r\n]*)/g)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map(m => m[2])
    .join('');
  assert.equal(decodeURIComponent(encoded), 'é'.repeat(1_500) + '.pdf');
  assert.ok(!text.includes('Content-ID: <ccc'), 'an over-long Content-ID is not written');
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

test('a domain the URL parser would cut short is refused before it becomes punycode', () => {
  const bad = [
    'a@evil.com/bänk.com',
    'a@evil.com#bänk.com',
    'a@evil.com?bänk.com',
    'a@evil.com\\bänk.com',
    'a@evil.com:8080/bänk.com',
    'a@ev\til.bänk.com',
    'a@ev\nil.bänk.com',
    'a@evil.com bänk.com',
    'a@ev%69l.bänk.com',
    'a@evil.com\u0000bänk.com',
    'a@ev\til.com',
  ];
  for (const address of bad) {
    assert.throws(() => checkAddress(address), MimeError, JSON.stringify(address));
    assert.throws(() => buildMime(input({ to: [{ address }] })), MimeError);
  }
  assert.equal(checkAddress('a@bänk.com'), 'a@xn--bnk-qla.com');
});
