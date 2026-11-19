import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './harness';

/*
 * `listFolder` is the engine's fetch for `sync_scope = 'lazy'` folders opened in a view (F3): Spam, Trash and
 * Starred reported 0 messages in the 2026-11-12 packaged build because nothing ever listed them. The call lists
 * one Gmail labelId head-first, returns every message's complete placement set plus flags, and must pass
 * `includeSpamTrash` or Gmail's default listing hides SPAM and TRASH. STARRED ids land as `flagged` facts (the
 * `mailbox:starred` view reads `threads.flagged`), label ids as placements.
 */

test('listFolder returns SPAM and TRASH placements the engine can commit', async () => {
  const r = await rig();
  const spam = r.emu.mailbox.addMessage({ labelIds: ['SPAM'], subject: 'spam' });
  const trashed = r.emu.mailbox.addMessage({ labelIds: ['TRASH'], subject: 'trashed' });

  const spamPage = await r.adapter.listFolder!('SPAM', undefined, r.ctx());
  assert.deepEqual(
    spamPage.upserts.map(f => f.remoteId),
    [spam.id],
  );
  assert.deepEqual(
    spamPage.upserts.flatMap(f => f.placements.map(p => p.folder)),
    ['SPAM'],
  );
  assert.equal(spamPage.nextPageToken, undefined);

  const trashPage = await r.adapter.listFolder!('TRASH', undefined, r.ctx());
  assert.deepEqual(
    trashPage.upserts.map(f => f.remoteId),
    [trashed.id],
  );
  assert.deepEqual(
    trashPage.upserts.flatMap(f => f.placements.map(p => p.folder)),
    ['TRASH'],
  );
});

test('listFolder on STARRED lands as flagged facts, so mailbox:starred fills', async () => {
  const r = await rig();
  const starred = r.emu.mailbox.addMessage({ labelIds: ['STARRED'], subject: 'star me' });
  r.emu.mailbox.addMessage({ labelIds: ['INBOX'], subject: 'not starred' });

  const page = await r.adapter.listFolder!('STARRED', undefined, r.ctx());
  assert.deepEqual(
    page.upserts.map(f => f.remoteId),
    [starred.id],
  );
  assert.equal(page.upserts[0]!.flags.flagged, true);
});

test('the request carries includeSpamTrash and the labelId — the default listing hides Spam and Trash', async () => {
  const r = await rig();
  await r.adapter.listFolder!('SPAM', undefined, r.ctx());
  const list = r.fetches.find(f => f.path.endsWith('/messages'));
  assert.ok(list);
  assert.equal(list!.query.get('labelIds'), 'SPAM');
  assert.equal(list!.query.get('includeSpamTrash'), 'true');
});
