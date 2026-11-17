/** The forward page: its crumb says Forward, and its body shows a note area above a quiet quoted original. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { composeHeader, COMPOSE_CRUMB, FORWARD_CRUMB } from './composeHeader';
import { FORWARD_MARK } from './model/forwardSeed';
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

test('a plain body keeps the single editor and its own placeholder', () => {
  const html = renderToStaticMarkup(<BodyEditor value="" onChange={noop} label="Message" />);
  assert.match(html, /placeholder="Write something…"/);
  assert.doesNotMatch(html, /aplos-compose-quote/);
});
