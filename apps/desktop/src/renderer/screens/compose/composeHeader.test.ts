/**
 * The compose page's crumb: "New message", "Forward" for a forward, "Draft" for a reopened draft; replies keep theirs.
 * Run: cd apps/desktop && npx tsx --test src/renderer/screens/compose/composeHeader.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeCrumb } from './composeHeader';

test('a new message says New message', () => {
  assert.equal(composeCrumb({}), 'New message');
});

test('a forward says Forward, and so does a reopened forward draft', () => {
  assert.equal(composeCrumb({ forward: true }), 'Forward');
  assert.equal(composeCrumb({ draftId: 'd1', draft: { mode: 'forward' } }), 'Forward');
});

test('a reopened draft says Draft, until its row is known too', () => {
  assert.equal(composeCrumb({ draftId: 'd1', draft: { mode: 'new' } }), 'Draft');
  assert.equal(composeCrumb({ draftId: 'd1' }), 'Draft');
});

test('a reply, popped out or reopened, keeps its wording', () => {
  assert.equal(composeCrumb({ draftId: 'd1', draft: { mode: 'reply' } }), 'New message');
  assert.equal(composeCrumb({ draftId: 'd1', draft: { mode: 'replyAll' } }), 'New message');
});
