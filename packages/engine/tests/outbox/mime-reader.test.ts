/**
 * What Aplos sends is what the reader opens: a draft is built into MIME by the outbox, its text/html part is handed to the
 * reader's sanitiser, and the sent copy must come back "plain" (no colours of its own), so the dark theme draws it on the
 * card instead of on a white sheet. The HTML is the composer's own shape (`textToHtml`, apps/desktop
 * `screens/compose/model/fields.ts`): one `<p>` per line, an empty line as `<p><br></p>`, text escaped.
 * Run: cd packages/engine && npx tsx --test tests/outbox/mime-reader.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@aplos/mail-html';
import { buildMime } from '../../src/outbox/mime';

const T0 = Date.UTC(2026, 10, 17, 2, 56, 42);
const decoder = new TextDecoder();

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** The composer's own HTML for a body typed as plain text. */
const composerHtml = (body: string) =>
  body
    .split('\n')
    .map(line => (line === '' ? '<p><br></p>' : `<p>${escape(line)}</p>`))
    .join('');

function decodeQuotedPrintable(text: string): string {
  const bytes: number[] = [];
  const raw = Buffer.from(text.replace(/=\r\n/g, ''), 'latin1');
  for (let i = 0; i < raw.length; i++) {
    const hex = raw.toString('latin1', i + 1, i + 3);
    if (raw[i] === 0x3d && /^[0-9A-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(raw[i]);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The html part of a built message, decoded as the reader receives it. */
function sentHtml(html: string): string {
  const mime = decoder.decode(
    buildMime({
      from: { address: 'owner@mail.example', name: 'Owner' },
      to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
      cc: [],
      subject: 'Lunch',
      html,
      messageId: '<abc@mail.example>',
      date: T0,
    }),
  );
  const part =
    /Content-Type: text\/html[^\r]*\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n([\s\S]*?)(?:\r\n--=_aplos_|$)/.exec(
      mime,
    );
  assert.ok(part, 'the message has an html part');
  return decodeQuotedPrintable(part[1]);
}

const root = (html: string) => {
  const result = render({ html, cids: [], imagePolicy: 'block' });
  assert.equal(result.bodyKind, 'html');
  return /<html[^>]*>/.exec(result.document)?.[0] ?? '';
};
const isPlain = (html: string) => root(html).includes('data-aplos-plain');

const FORWARD =
  'Look at this.\n\n---------- Forwarded message ----------\nFrom: Jo <jo@mail.example>\nDate: Mon, Nov 16, 2026 at 6:56 PM\nSubject: Plans <draft> & more\nTo: Owner <owner@mail.example>\n\nSee you at 6.\n  -- Jo';

test('a new message, a reply and a forward built by the outbox read as plain', () => {
  for (const body of [
    'Hi Jordan,\n\nLunch at noon?\n\nOwner',
    'Thanks, Jo.\n> older words',
    FORWARD,
  ])
    assert.equal(isPlain(sentHtml(composerHtml(body))), true, body);
});

test('the same HTML in the wrappers a mail server or another client adds stays plain', () => {
  const inner = composerHtml('Hi Jordan,\n\nLunch at noon?');
  for (const wrapped of [
    `<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head><body>${inner}</body></html>`,
    `<html><body dir="ltr">${inner}</body></html>`,
    `<html><body class="msg" style="margin:0;padding:0">${inner}</body></html>`,
    `<div dir="ltr">${inner}</div>`,
    `<div style="margin:0;white-space:pre-wrap">${inner}</div>`,
  ])
    assert.equal(isPlain(sentHtml(wrapped)), true, wrapped);
});

test('a message with its own colours, images or tables is not plain', () => {
  const inner = composerHtml('Hello');
  for (const rich of [
    `<html><body bgcolor="#112233">${inner}</body></html>`,
    `<html><body style="background:#112233">${inner}</body></html>`,
    `<html><body text="#ffffff">${inner}</body></html>`,
    `<p style="color:#c00">Hello</p>`,
    `<table><tr><td>Hello</td></tr></table>`,
    `<p>Hello <img src="https://example.com/a.png" alt="Logo"></p>`,
  ])
    assert.equal(isPlain(sentHtml(rich)), false, rich);
});
