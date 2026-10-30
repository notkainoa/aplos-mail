/**
 * prov-gmail table-driven tests for the pure parsing helpers in facts.ts and mime.ts. Every expectation is taken from
 * the source's actual behaviour; only invented example.test data is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Address, FolderFacts, MessageFlags } from '@aplos/engine/ports';
import {
  decodeEntities,
  decodeWords,
  parseAddresses,
  flagsOf,
  folderFacts,
  type GmailLabel,
} from '../../src/host/providers/google/facts';
import {
  headerOf,
  decodeText,
  fromBase64Url,
  walkPayload,
  buildBatch,
  parseBatch,
  type BodyLeaf,
  type GmailPart,
} from '../../src/host/providers/google/mime';

const SELF = 'owner@example.test';

// ---- facts.ts: text helpers ----

test('decodeEntities decodes named, decimal and hex references exactly once', () => {
  const cases: { name: string; input: string; expected: string }[] = [
    { name: 'amp', input: 'Ana &amp; Bo', expected: 'Ana & Bo' },
    { name: 'lt and gt', input: '&lt;tag&gt;', expected: '<tag>' },
    { name: 'quot', input: '&quot;Ana&quot;', expected: '"Ana"' },
    { name: 'decimal apostrophe', input: '&#39;', expected: "'" },
    { name: 'hex apostrophe', input: '&#x27;', expected: "'" },
    { name: 'uppercase hex marker', input: '&#X27;', expected: "'" },
    { name: 'decimal code point', input: 'a&#8212;b', expected: 'a\u2014b' },
    { name: 'hex code point', input: 'a&#x2014;b', expected: 'a\u2014b' },
    { name: 'nbsp is U+00A0', input: 'a&nbsp;b', expected: 'a\u00a0b' },
    { name: 'entity name is case-insensitive', input: '&AMP;', expected: '&' },
    { name: 'unknown entity stays', input: '&bogus;', expected: '&bogus;' },
    { name: 'only decoded once', input: '&amp;#39;', expected: '&#39;' },
    { name: 'zero code point stays', input: '&#0;', expected: '&#0;' },
    { name: 'out of range code point stays', input: '&#x110000;', expected: '&#x110000;' },
    {
      name: 'no entities',
      input: 'Ana Ruiz <ana@example.test>',
      expected: 'Ana Ruiz <ana@example.test>',
    },
    { name: 'empty', input: '', expected: '' },
  ];
  for (const { name, input, expected } of cases) {
    assert.deepEqual(decodeEntities(input), expected, name);
  }
});

test('decodeWords decodes RFC 2047 B and Q words and joins adjacent words', () => {
  const cases: { name: string; input: string; expected: string }[] = [
    { name: 'UTF-8 B', input: '=?UTF-8?B?QW5hIFJ1aXo=?=', expected: 'Ana Ruiz' },
    { name: 'UTF-8 Q with underscores', input: '=?UTF-8?Q?Ana_Ruiz?=', expected: 'Ana Ruiz' },
    { name: 'UTF-8 Q with =20', input: '=?UTF-8?Q?Ana=20Ruiz?=', expected: 'Ana Ruiz' },
    {
      name: 'adjacent words joined without the separating space',
      input: '=?UTF-8?Q?Ana?= =?UTF-8?Q?Ruiz?=',
      expected: 'AnaRuiz',
    },
    { name: 'ISO-8859-1 Q', input: '=?ISO-8859-1?Q?Jos=E9?=', expected: 'Jos\u00e9' },
    { name: 'ISO-8859-1 B', input: '=?ISO-8859-1?B?Sm9z6Q==?=', expected: 'Jos\u00e9' },
    { name: 'plain string unchanged', input: 'Ana Ruiz', expected: 'Ana Ruiz' },
    { name: 'unknown charset left as is', input: '=?FOO-8?B?QW5h?=', expected: '=?FOO-8?B?QW5h?=' },
    {
      name: 'unsupported encoding letter left as is',
      input: '=?UTF-8?X?nope?=',
      expected: '=?UTF-8?X?nope?=',
    },
    { name: 'word inside surrounding text', input: 'ana=?UTF-8?Q?_Ruiz?=', expected: 'ana Ruiz' },
    { name: 'empty', input: '', expected: '' },
  ];
  for (const { name, input, expected } of cases) {
    assert.deepEqual(decodeWords(input), expected, name);
  }
});

test('parseAddresses splits lists and decodes display names', () => {
  const cases: { name: string; input: string | undefined; expected: Address[] }[] = [
    {
      name: 'bare address',
      input: 'ana@example.test',
      expected: [{ address: 'ana@example.test' }],
    },
    {
      name: 'display name with angle brackets',
      input: 'Ana Ruiz <ana@example.test>',
      expected: [{ address: 'ana@example.test', name: 'Ana Ruiz' }],
    },
    {
      name: 'quoted display name containing a comma',
      input: '"Ruiz, Ana" <ana@example.test>',
      expected: [{ address: 'ana@example.test', name: 'Ruiz, Ana' }],
    },
    {
      name: 'several addresses separated by commas',
      input: 'Ana Ruiz <ana@example.test>, Bo Chen <bo@example.test>',
      expected: [
        { address: 'ana@example.test', name: 'Ana Ruiz' },
        { address: 'bo@example.test', name: 'Bo Chen' },
      ],
    },
    {
      name: 'encoded display name',
      input: '=?UTF-8?Q?Ana_Ruiz?= <ana@example.test>',
      expected: [{ address: 'ana@example.test', name: 'Ana Ruiz' }],
    },
    {
      name: 'encoded comma stays inside the name',
      input: '=?UTF-8?Q?Ruiz=2C_Ana?= <ana@example.test>',
      expected: [{ address: 'ana@example.test', name: 'Ruiz, Ana' }],
    },
    { name: 'undefined value', input: undefined, expected: [] },
    { name: 'empty value', input: '', expected: [] },
    {
      name: 'extra whitespace',
      input: '   Ana Ruiz   <  ana@example.test  >  ',
      expected: [{ address: 'ana@example.test', name: 'Ana Ruiz' }],
    },
    {
      name: 'comment after a bare address is dropped',
      input: 'ana@example.test (Ana Ruiz)',
      expected: [{ address: 'ana@example.test' }],
    },
    { name: 'empty angle address is dropped', input: '<>', expected: [] },
    {
      name: 'escaped quotes in the display name',
      input: '"Ana \\"AJ\\" Ruiz" <ana@example.test>',
      expected: [{ address: 'ana@example.test', name: 'Ana "AJ" Ruiz' }],
    },
    {
      name: 'bare and named addresses mixed',
      input: 'ana@example.test, Bo Chen <bo@example.test>',
      expected: [{ address: 'ana@example.test' }, { address: 'bo@example.test', name: 'Bo Chen' }],
    },
  ];
  for (const { name, input, expected } of cases) {
    assert.deepEqual(parseAddresses(input), expected, name);
  }
});

// RFC 5322 groups contribute their members; the group name and the closing ';' are dropped.
test('parseAddresses expands RFC 5322 group syntax', () => {
  assert.deepEqual(parseAddresses('Team: a@example.test, b@example.test;'), [
    { address: 'a@example.test' },
    { address: 'b@example.test' },
  ]);
  assert.deepEqual(parseAddresses('undisclosed-recipients:;'), []);
  assert.deepEqual(parseAddresses('Team: Ana Ruiz <ana@example.test>;, lee@example.test'), [
    { address: 'ana@example.test', name: 'Ana Ruiz' },
    { address: 'lee@example.test' },
  ]);
  assert.deepEqual(parseAddresses('"Ruiz: Ana" <ana@example.test>'), [
    { address: 'ana@example.test', name: 'Ruiz: Ana' },
  ]);
});

// ---- facts.ts: flags and folders ----

test('flagsOf maps labels and the From address to flags', () => {
  const cases: {
    name: string;
    input: [readonly string[], Address | undefined, string];
    expected: MessageFlags;
  }[] = [
    {
      name: 'no labels, no from',
      input: [[], undefined, SELF],
      expected: { seen: true, flagged: false, draft: false, fromMe: false },
    },
    {
      name: 'UNREAD clears seen',
      input: [['UNREAD'], undefined, SELF],
      expected: { seen: false, flagged: false, draft: false, fromMe: false },
    },
    {
      name: 'STARRED sets flagged',
      input: [['STARRED'], undefined, SELF],
      expected: { seen: true, flagged: true, draft: false, fromMe: false },
    },
    {
      name: 'DRAFT sets draft',
      input: [['DRAFT'], undefined, SELF],
      expected: { seen: true, flagged: false, draft: true, fromMe: false },
    },
    {
      name: 'SENT sets fromMe',
      input: [['SENT'], undefined, SELF],
      expected: { seen: true, flagged: false, draft: false, fromMe: true },
    },
    {
      name: 'From matching self sets fromMe case-insensitively',
      input: [[], { address: 'OWNER@example.test', name: 'Owner' }, SELF],
      expected: { seen: true, flagged: false, draft: false, fromMe: true },
    },
    {
      name: 'From not matching self',
      input: [[], { address: 'ana@example.test', name: 'Ana' }, SELF],
      expected: { seen: true, flagged: false, draft: false, fromMe: false },
    },
    {
      name: 'all three labels together',
      input: [['UNREAD', 'STARRED', 'DRAFT', 'INBOX'], undefined, SELF],
      expected: { seen: false, flagged: true, draft: true, fromMe: false },
    },
  ];
  for (const { name, input, expected } of cases) {
    assert.deepEqual(flagsOf(...input), expected, name);
  }
});

test('folderFacts maps labels to folders, dropping UNREAD and CHAT', () => {
  const cases: { name: string; input: GmailLabel[]; expected: FolderFacts[] }[] = [
    {
      name: 'INBOX',
      input: [{ id: 'INBOX', name: 'Inbox', type: 'system' }],
      expected: [{ remoteId: 'INBOX', name: 'Inbox', role: 'inbox', kind: 'system' }],
    },
    {
      name: 'SENT',
      input: [{ id: 'SENT', name: 'Sent', type: 'system' }],
      expected: [{ remoteId: 'SENT', name: 'Sent', role: 'sent', kind: 'system' }],
    },
    {
      name: 'DRAFT',
      input: [{ id: 'DRAFT', name: 'Drafts', type: 'system' }],
      expected: [{ remoteId: 'DRAFT', name: 'Drafts', role: 'drafts', kind: 'system' }],
    },
    {
      name: 'STARRED keeps a starred role',
      input: [{ id: 'STARRED', name: 'Starred', type: 'system' }],
      expected: [{ remoteId: 'STARRED', name: 'Starred', role: 'starred', kind: 'system' }],
    },
    {
      name: 'CATEGORY_PROMOTIONS',
      input: [{ id: 'CATEGORY_PROMOTIONS', name: 'Promotions', type: 'system' }],
      expected: [
        {
          remoteId: 'CATEGORY_PROMOTIONS',
          name: 'Promotions',
          role: 'category.promotions',
          kind: 'system',
        },
      ],
    },
    {
      name: 'user label has no role',
      input: [{ id: 'Label_1', name: 'Projects', type: 'user' }],
      expected: [{ remoteId: 'Label_1', name: 'Projects', kind: 'label' }],
    },
    {
      name: 'label without a type is a label',
      input: [{ id: 'Label_2', name: 'Receipts' }],
      expected: [{ remoteId: 'Label_2', name: 'Receipts', kind: 'label' }],
    },
    {
      name: 'hidden system label',
      input: [{ id: 'SPAM', name: 'Spam', type: 'system', labelListVisibility: 'labelHide' }],
      expected: [{ remoteId: 'SPAM', name: 'Spam', role: 'spam', kind: 'system', hidden: true }],
    },
    {
      name: 'UNREAD is filtered out',
      input: [
        { id: 'UNREAD', name: 'Unread', type: 'system' },
        { id: 'INBOX', name: 'Inbox', type: 'system' },
      ],
      expected: [{ remoteId: 'INBOX', name: 'Inbox', role: 'inbox', kind: 'system' }],
    },
    {
      name: 'CHAT is filtered out',
      input: [
        { id: 'CHAT', name: 'Chat', type: 'system' },
        { id: 'TRASH', name: 'Trash', type: 'system' },
      ],
      expected: [{ remoteId: 'TRASH', name: 'Trash', role: 'trash', kind: 'system' }],
    },
    { name: 'empty list', input: [], expected: [] },
  ];
  for (const { name, input, expected } of cases) {
    assert.deepEqual(folderFacts(input), expected, name);
  }
});

// ---- mime.ts ----

test('headerOf finds a header case-insensitively', () => {
  const cases: {
    name: string;
    input: [{ name: string; value: string }[] | undefined, string];
    expected: string | undefined;
  }[] = [
    {
      name: 'exact match',
      input: [[{ name: 'Subject', value: 'Hi' }], 'Subject'],
      expected: 'Hi',
    },
    {
      name: 'lowercase query',
      input: [[{ name: 'Subject', value: 'Hi' }], 'subject'],
      expected: 'Hi',
    },
    {
      name: 'uppercase query',
      input: [[{ name: 'Subject', value: 'Hi' }], 'SUBJECT'],
      expected: 'Hi',
    },
    {
      name: 'lowercase header name',
      input: [[{ name: 'content-id', value: '<cid-1>' }], 'Content-ID'],
      expected: '<cid-1>',
    },
    {
      name: 'missing header',
      input: [[{ name: 'Subject', value: 'Hi' }], 'From'],
      expected: undefined,
    },
    { name: 'undefined list', input: [undefined, 'Subject'], expected: undefined },
    { name: 'empty list', input: [[], 'Subject'], expected: undefined },
    {
      name: 'empty value is kept',
      input: [[{ name: 'Subject', value: '' }], 'subject'],
      expected: '',
    },
    {
      name: 'first of two matches wins',
      input: [
        [
          { name: 'X-Thing', value: 'first' },
          { name: 'x-thing', value: 'second' },
        ],
        'X-THING',
      ],
      expected: 'first',
    },
  ];
  for (const { name, input, expected } of cases) {
    assert.deepEqual(headerOf(...input), expected, name);
  }
});

test('decodeText decodes bytes in the declared charset', () => {
  const utf8 = (text: string) => new TextEncoder().encode(text);
  const cases: { name: string; input: [Uint8Array, string | undefined]; expected: string }[] = [
    {
      name: 'utf-8 default when no content type',
      input: [utf8('Ruiz \u2014 ana'), undefined],
      expected: 'Ruiz \u2014 ana',
    },
    {
      name: 'utf-8 declared',
      input: [utf8('h\u00e9llo'), 'text/plain; charset=utf-8'],
      expected: 'h\u00e9llo',
    },
    {
      name: 'quoted charset',
      input: [utf8('h\u00e9llo'), 'text/plain; charset="UTF-8"'],
      expected: 'h\u00e9llo',
    },
    {
      name: 'ISO-8859-1 bytes',
      input: [new Uint8Array([0x4a, 0x6f, 0x73, 0xe9]), 'text/plain; charset=ISO-8859-1'],
      expected: 'Jos\u00e9',
    },
    {
      name: 'unknown charset falls back to utf-8',
      input: [utf8('h\u00e9llo'), 'text/plain; charset=bogus-charset'],
      expected: 'h\u00e9llo',
    },
    { name: 'empty bytes', input: [new Uint8Array([]), 'text/plain'], expected: '' },
    {
      name: 'charset with a trailing parameter',
      input: [utf8('h\u00e9llo'), 'text/html; charset=UTF-8; format=flowed'],
      expected: 'h\u00e9llo',
    },
  ];
  for (const { name, input, expected } of cases) {
    assert.deepEqual(decodeText(...input), expected, name);
  }
});

test('fromBase64Url decodes with and without padding', () => {
  const hello = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  const anaRuiz = new Uint8Array([0x41, 0x6e, 0x61, 0x20, 0x52, 0x75, 0x69, 0x7a]);
  const cases: { name: string; input: string; expected: Uint8Array }[] = [
    { name: 'padded', input: 'SGVsbG8=', expected: hello },
    { name: 'unpadded', input: 'SGVsbG8', expected: hello },
    { name: 'two padding characters', input: 'QW4=', expected: new Uint8Array([0x41, 0x6e]) },
    { name: 'no padding needed', input: 'QW5hIFJ1aXo', expected: anaRuiz },
    { name: 'padded display name', input: 'QW5hIFJ1aXo=', expected: anaRuiz },
    { name: 'empty string', input: '', expected: new Uint8Array([]) },
  ];
  for (const { name, input, expected } of cases) {
    assert.deepEqual(fromBase64Url(input), expected, name);
  }
});

test('walkPayload classifies the leaves of a payload tree', () => {
  const textOnly: GmailPart = { mimeType: 'text/plain', body: { data: 'SGk' } };
  const plainPart: GmailPart = { mimeType: 'text/plain', body: { data: 'SGk' } };
  const htmlPart: GmailPart = { mimeType: 'text/html', body: { data: 'PGI-SGk8L2I-' } };
  const pdfPart: GmailPart = {
    mimeType: 'application/pdf',
    filename: 'report.pdf',
    body: { attachmentId: 'att-1', size: 42 },
  };
  const alternative: GmailPart = {
    mimeType: 'multipart/alternative',
    parts: [plainPart, htmlPart, pdfPart],
  };

  const firstText: GmailPart = { mimeType: 'text/plain', body: { data: 'b25l' } };
  const secondText: GmailPart = { mimeType: 'text/plain', body: { data: 'dHdv' } };
  const repeated: GmailPart = { mimeType: 'multipart/mixed', parts: [firstText, secondText] };

  const inlineImage: GmailPart = {
    mimeType: 'image/png',
    filename: 'logo.png',
    headers: [
      { name: 'Content-ID', value: '<cid-1>' },
      { name: 'Content-Disposition', value: 'inline; filename="logo.png"' },
    ],
    body: { attachmentId: 'att-2' },
  };

  const dispositionOnly: GmailPart = {
    mimeType: 'text/plain',
    headers: [{ name: 'Content-Disposition', value: 'attachment' }],
    body: { data: 'YXR0' },
  };

  const namedText: GmailPart = {
    mimeType: 'text/plain',
    filename: 'notes.txt',
    body: { attachmentId: 'att-3' },
  };

  const nested: GmailPart = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'multipart/alternative', parts: [plainPart, htmlPart] },
      { mimeType: 'application/zip', filename: 'bundle.zip', body: { attachmentId: 'att-4' } },
    ],
  };

  const cases: { name: string; input: GmailPart; expected: BodyLeaf[] }[] = [
    {
      name: 'single text leaf',
      input: textOnly,
      expected: [{ part: textOnly, kind: 'text', data: 'SGk', inline: false }],
    },
    {
      name: 'multipart/alternative with text, html and an attachment',
      input: alternative,
      expected: [
        { part: plainPart, kind: 'text', data: 'SGk', inline: false },
        { part: htmlPart, kind: 'html', data: 'PGI-SGk8L2I-', inline: false },
        { part: pdfPart, kind: 'attachment', attachmentId: 'att-1', inline: false },
      ],
    },
    {
      name: 'a second text/plain becomes an attachment',
      input: repeated,
      expected: [
        { part: firstText, kind: 'text', data: 'b25l', inline: false },
        { part: secondText, kind: 'attachment', data: 'dHdv', inline: false },
      ],
    },
    {
      name: 'inline image with a Content-ID',
      input: inlineImage,
      expected: [
        {
          part: inlineImage,
          kind: 'attachment',
          attachmentId: 'att-2',
          cid: 'cid-1',
          inline: true,
        },
      ],
    },
    {
      name: 'attachment disposition without a filename',
      input: dispositionOnly,
      expected: [{ part: dispositionOnly, kind: 'attachment', data: 'YXR0', inline: false }],
    },
    {
      name: 'text/plain with a filename is an attachment',
      input: namedText,
      expected: [{ part: namedText, kind: 'attachment', attachmentId: 'att-3', inline: false }],
    },
    {
      name: 'nested multiparts',
      input: nested,
      expected: [
        { part: plainPart, kind: 'text', data: 'SGk', inline: false },
        { part: htmlPart, kind: 'html', data: 'PGI-SGk8L2I-', inline: false },
        { part: nested.parts![1], kind: 'attachment', attachmentId: 'att-4', inline: false },
      ],
    },
  ];
  for (const { name, input, expected } of cases) {
    assert.deepEqual(walkPayload(input), expected, name);
  }
});

test('buildBatch writes the multipart envelope', () => {
  const cases: { name: string; input: [string[], string]; expected: string }[] = [
    {
      name: 'empty batch',
      input: [[], 'batch_ana'],
      expected: '--batch_ana--\r\n',
    },
    {
      name: 'one part',
      input: [['/gmail/v1/users/me/messages/a1?format=metadata'], 'batch_ana'],
      expected:
        '--batch_ana\r\n' +
        'Content-Type: application/http\r\n' +
        'Content-ID: <item0>\r\n' +
        '\r\n' +
        'GET /gmail/v1/users/me/messages/a1?format=metadata HTTP/1.1\r\n' +
        '\r\n' +
        '\r\n' +
        '--batch_ana--\r\n',
    },
    {
      name: 'two parts',
      input: [
        [
          '/gmail/v1/users/me/messages/a1?format=metadata',
          '/gmail/v1/users/me/messages/b2?format=metadata',
        ],
        'batch_ana',
      ],
      expected:
        '--batch_ana\r\n' +
        'Content-Type: application/http\r\n' +
        'Content-ID: <item0>\r\n' +
        '\r\n' +
        'GET /gmail/v1/users/me/messages/a1?format=metadata HTTP/1.1\r\n' +
        '\r\n' +
        '\r\n' +
        '--batch_ana\r\n' +
        'Content-Type: application/http\r\n' +
        'Content-ID: <item1>\r\n' +
        '\r\n' +
        'GET /gmail/v1/users/me/messages/b2?format=metadata HTTP/1.1\r\n' +
        '\r\n' +
        '\r\n' +
        '--batch_ana--\r\n',
    },
  ];
  for (const { name, input, expected } of cases) {
    const parts = input[0].map(target => ({ target }));
    assert.deepEqual(buildBatch(parts, input[1]), expected, name);
  }
});

test('parseBatch reads a multipart reply into request order', () => {
  const twoParts = [
    '--batch_ana',
    'Content-Type: application/http',
    'Content-ID: <response-item0>',
    '',
    'HTTP/1.1 200 OK',
    'Content-Type: application/json',
    '',
    '{"id":"a1"}',
    '--batch_ana',
    'Content-Type: application/http',
    'Content-ID: <response-item1>',
    '',
    'HTTP/1.1 404 Not Found',
    'Content-Type: application/json',
    '',
    '{"error":"nope"}',
    '--batch_ana--',
    '',
  ].join('\r\n');

  const withoutIds = [
    '--batch_ana',
    'Content-Type: application/http',
    '',
    'HTTP/1.1 200 OK',
    '',
    '{"id":"a1"}',
    '--batch_ana',
    'Content-Type: application/http',
    '',
    'HTTP/1.1 204 No Content',
    '',
    '',
    '--batch_ana--',
    '',
  ].join('\r\n');

  const outOfRange = [
    '--batch_ana',
    'Content-Type: application/http',
    'Content-ID: <response-item5>',
    '',
    'HTTP/1.1 200 OK',
    '',
    '{"id":"a1"}',
    '--batch_ana',
    'Content-Type: application/http',
    'Content-ID: <response-item1>',
    '',
    'HTTP/1.1 200 OK',
    '',
    '{"id":"b2"}',
    '--batch_ana--',
    '',
  ].join('\r\n');

  const quotedBoundary = [
    '--batch_ana',
    'Content-ID: <response-item0>',
    '',
    'HTTP/1.1 200 OK',
    'X-Trace: abc',
    '',
    'ok',
    '--batch_ana--',
    '',
  ].join('\r\n');

  type PlainPart = { status: number; headers: Record<string, string>; body: string } | undefined;
  const cases: {
    name: string;
    input: [string | null, string, number];
    expected: PlainPart[];
  }[] = [
    {
      name: 'two parts ordered by Content-ID',
      input: ['multipart/mixed; boundary="batch_ana"', twoParts, 2],
      expected: [
        { status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":"a1"}' },
        { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"nope"}' },
      ],
    },
    {
      name: 'parts without a Content-ID keep their position',
      input: ['multipart/mixed; boundary=batch_ana', withoutIds, 2],
      expected: [
        { status: 200, headers: {}, body: '{"id":"a1"}' },
        { status: 204, headers: {}, body: '' },
      ],
    },
    {
      name: 'an out-of-range Content-ID is dropped',
      input: ['multipart/mixed; boundary=batch_ana', outOfRange, 2],
      expected: [undefined, { status: 200, headers: {}, body: '{"id":"b2"}' }],
    },
    {
      name: 'quoted boundary with a custom header',
      input: ['multipart/mixed; boundary="batch_ana"', quotedBoundary, 1],
      expected: [{ status: 200, headers: { 'x-trace': 'abc' }, body: 'ok' }],
    },
  ];

  for (const { name, input, expected } of cases) {
    const parsed = parseBatch(...input);
    const plain = parsed.map(part =>
      part === undefined
        ? undefined
        : { status: part.status, headers: Object.fromEntries(part.headers), body: part.body },
    );
    assert.deepEqual(plain, expected, name);
  }

  assert.throws(
    () => parseBatch('multipart/mixed', twoParts, 2),
    /batch reply without a boundary/,
    'a reply without a boundary throws',
  );
});
