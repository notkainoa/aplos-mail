import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemo } from '@aplos/engine/legacy/demo';
import {
  bookmarkLeavesList,
  isBookmark,
  isFollowUp,
  isHomeLow,
  isHomeNew,
  isReplyDue,
  shortDue,
  shortSender,
  threadInView,
} from '@aplos/contract/legacy/mailbox';
import type { Thread } from '@aplos/contract/legacy/types';

const demo = createDemo(new Date(2026, 9, 15, 12));
const byId = (id: string) => demo.threads.find(thread => thread.id === id)!;

test('bookmarked new mail lives in Bookmarks, not Home or the low-importance bundle', () => {
  const garden = byId('garden');
  const design = byId('design');
  const delivery = byId('delivery');
  const review = byId('review');
  assert.equal(garden.bookmarked, true);
  assert.equal(garden.status, 'new');
  assert.equal(isHomeNew(garden), false);
  assert.equal(isBookmark(garden), true);
  assert.equal(threadInView(garden, 'home'), false);
  assert.equal(threadInView(garden, 'later', 'bookmarks'), true);
  assert.equal(isHomeNew(design), true);
  assert.equal(isBookmark(design), false);
  assert.equal(isHomeNew(review), false);
  assert.equal(isHomeLow(delivery), true);
  assert.ok(!demo.threads.filter(isHomeNew).some(thread => thread.bookmarked));
  assert.ok(!demo.threads.filter(isHomeLow).some(thread => thread.bookmarked));
});

test('bookmarking a Home thread files it away; unbookmarking files it out of Bookmarks', () => {
  const design = byId('design');
  const garden = byId('garden');
  const lunch = byId('lunch');
  assert.equal(bookmarkLeavesList(design, true, 'home', 'todos'), true);
  assert.equal(
    bookmarkLeavesList(lunch, true, 'home', 'todos'),
    false,
    'Later items stay on Home’s ready section',
  );
  assert.equal(bookmarkLeavesList(garden, false, 'later', 'bookmarks'), true);
  assert.equal(bookmarkLeavesList(garden, false, 'home', 'todos'), false);
  const after: Thread = { ...design, bookmarked: true };
  assert.equal(isHomeNew(after), false);
  assert.equal(isBookmark(after), true);
});

test('focus-list lines name people by first name and keep organizations whole', () => {
  assert.equal(shortSender('Jordan Park', 'jordan@studio.example'), 'Jordan');
  assert.equal(shortSender('Leah Brooks', 'Leah Brooks <leah.b@studio.example>'), 'Leah');
  assert.equal(shortSender('Maple Library', 'holds@maplelibrary.example'), 'Maple Library');
  assert.equal(shortSender('Trail Journal', 'hello@trail.example'), 'Trail Journal');
  assert.equal(shortSender('', 'updates@service.example'), 'updates');
  for (const thread of demo.threads)
    for (const message of thread.messages)
      assert.ok(shortSender(message.fromName, message.from).length > 0);
});

test('due chips stay short and relative to today', () => {
  const now = new Date(2026, 9, 20, 9);
  assert.equal(shortDue('2026-10-20', now), 'today');
  assert.equal(shortDue('2026-10-21', now), 'by tomorrow');
  assert.equal(shortDue('2026-10-18', now), 'overdue');
  assert.match(shortDue('2026-10-23', now), /^by \S+$/);
  assert.match(shortDue('2026-11-12', now), /^by .*12/);
});

test('Home keeps reply work: done mail that needs a reply, and sent mail unanswered for a few days', () => {
  const sent = byId('sent');
  const now = Date.parse(sent.date);
  const day = 86400000;
  assert.equal(sent.replyStatus, 'awaiting-reply');
  assert.equal(isFollowUp(sent, now + 2 * day), false);
  assert.equal(isFollowUp(sent, now + 3 * day), true);
  assert.equal(isFollowUp({ ...sent, hiddenFromHome: true }, now + 5 * day), false);
  assert.equal(isFollowUp({ ...sent, replyStatus: 'needs-reply' }, now + 5 * day), false);
  const design = byId('design');
  assert.equal(isReplyDue({ ...design, status: 'done' }), true);
  assert.equal(isReplyDue({ ...design, status: 'done', hiddenFromHome: true }), false);
  assert.equal(isReplyDue(design), false);
});
