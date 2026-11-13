import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteText } from '../../src/views/remote-text';

/*
 * fix-search (2026-11-12): `Search/remote` sent the provider only the free words, so a search typed as `from:airbnb`
 * (parsed into `query.from`, empty `text`) asked Gmail for nothing.
 */

test('the provider is asked for the free words and the operators it understands', () => {
  assert.equal(remoteText({ text: 'airbnb' }), 'airbnb');
  assert.equal(remoteText({ text: '', from: 'airbnb' }), 'from:"airbnb"');
  assert.equal(
    remoteText({
      text: ' reservation ',
      to: 'me@mail.example',
      subject: 'your "trip"',
      hasAttachment: true,
      after: '2026-01-02',
      before: '2026-03-04',
      is: ['unread', 'flagged', 'bookmarked'],
    }),
    'reservation to:"me@mail.example" subject:"your  trip" has:attachment after:2026/01/02 before:2026/03/04 is:unread is:starred',
  );
});

test('a query with only places or bookmarks asks the provider nothing', () => {
  assert.equal(remoteText({ text: ' ', in: 'done', is: ['bookmarked'] }), '');
});
