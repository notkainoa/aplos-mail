/**
 * The card header's right side (owner request 2026-11-10), rendered with no DOM: the bell follows `Message.notification`
 * (a bell when it notified, a slashed bell when it did not, an unnamed outline mark when the engine did not say), and the
 * ⋯ menu leaves Reply all out where the view has no reply-all.
 * Run: cd apps/desktop && npx tsx --test src/renderer/screens/reader/headActions.test.tsx
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message, ThreadRow } from '../../data';
import type { SuggestedAction } from '../../ui/props';
import { HeadActions, moreEntries, type HeadControls } from './HeadActions';

const row = { rank: { lane: 'do' }, workflow: { bookmarked: false } } as unknown as ThreadRow;
const suggestion = { verb: 'Reply', icon: 'reply', isDone: false } as SuggestedAction;
const noop = () => undefined;
const controls: HeadControls = {
  suggest: noop,
  later: noop,
  done: noop,
  bookmark: noop,
  trash: noop,
  lane: noop,
};

const render = (notification?: string) =>
  renderToStaticMarkup(
    createElement(HeadActions, {
      row,
      message: { notification } as unknown as Message,
      suggestion,
      controls,
    }),
  );

test('the bell: sent is a bell, none and suppressed a slashed bell, absent no bell', () => {
  assert.match(render('sent'), /aria-label="This email notified you"[^>]*data-state="notified"/);
  assert.match(
    render('none'),
    /aria-label="This email did not notify you"[^>]*data-state="silent"/,
  );
  assert.match(render('suppressed'), /data-icon="bell-off"/);
  const unknown = render(undefined);
  assert.doesNotMatch(
    unknown,
    /aplos-bell/,
    'no bell when the engine did not say: a plain bell would read as notified',
  );
  assert.match(unknown, /aria-label="Message actions"/, 'the rest of the header stays');
});

test('the bell, Importance and More are all there, in that order (owner sketch 2026-11-10)', () => {
  const html = render('sent');
  const at = (text: string) => html.indexOf(text);
  assert.ok(at('aplos-bell') >= 0 && at('aplos-bell') < at('Important'));
  assert.ok(at('Important') < at('aria-label="Message actions"'));
});

test('the ⋯ menu lists Reply all only where the view has it', () => {
  const ids = (canReplyAll: boolean) =>
    moreEntries(row, suggestion, canReplyAll).flatMap(e => (e.kind === 'item' ? [e.id] : []));
  assert.ok(ids(true).includes('replyAll'));
  assert.ok(!ids(false).includes('replyAll'));
  assert.deepEqual(ids(false), ['suggested', 'later', 'done', 'bookmark', 'trash']);
});
