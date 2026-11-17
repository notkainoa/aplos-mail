/** The forward page: its crumb says Forward, and its body shows a note area above a quiet quoted original. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { composeHeader, COMPOSE_CRUMB, FORWARD_CRUMB } from './composeHeader';
import { FORWARD_MARK, joinQuote, splitQuote } from './model/forwardSeed';
import { BodyEditor } from './views/BodyEditor';

const noop = () => undefined;

test('the header names a forward "Forward" and a new message "New message"', () => {
  assert.equal(
    composeHeader({ close: noop, saved: false, forward: true }).crumb?.label,
    FORWARD_CRUMB,
  );
  assert.equal(composeHeader({ close: noop, saved: false }).crumb?.label, COMPOSE_CRUMB);
});

test('a forward body draws an empty note with its placeholder, then the quoted original', () => {
  const body = `${FORWARD_MARK}\nFrom: Drew\n\nHello.`;
  const html = renderToStaticMarkup(<BodyEditor value={body} onChange={noop} label="Message" />);
  assert.match(html, /placeholder="Add a note…"/);
  assert.match(html, /aplos-compose-quote/);
  assert.match(html, /aria-label="Forwarded message"/);
});

test('a forward shows its header lines as one caption and keeps them in the stored body', () => {
  const header = `${FORWARD_MARK}\nFrom: Jordan Park <jordan@example.com>\nDate: Mon, Nov 16, 2026 at 8:29 PM EST\nSubject: Layouts`;
  const body = `${header}\n\nHello.`;
  const html = renderToStaticMarkup(<BodyEditor value={body} onChange={noop} label="Message" />);
  assert.match(html, />Forwarded from Jordan Park · Mon, Nov 16, 8:29 PM</);
  assert.doesNotMatch(html, /Forwarded message ----------/, 'the raw mark is not drawn');
  assert.doesNotMatch(html, /Subject: Layouts/, 'the raw header lines are not drawn');
  assert.match(html, />Hello\./);
  assert.deepEqual(splitQuote(body), { header, text: 'Hello.' });
  assert.equal(joinQuote(header, 'Hello again.'), `${header}\n\nHello again.`);
});

test('a plain body keeps the single editor and its own placeholder', () => {
  const html = renderToStaticMarkup(<BodyEditor value="" onChange={noop} label="Message" />);
  assert.match(html, /placeholder="Write something…"/);
  assert.doesNotMatch(html, /aplos-compose-quote/);
});
