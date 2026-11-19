import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccountActorHost } from '../../src/ports';
import { incoming, openEngine } from './harness';
import { BIG_NOW } from './big';
import { makeWorld } from './world';

/*
 * fix-search (2026-11-12): word search now shows threads only a provider search found (`origin='search'`), with the
 * same exclusions as every other list: Trash, Spam and drafts stay out. And `Search/remote` with nothing a provider can
 * look for (a place or a bookmark alone) asks no provider.
 */

async function rig() {
  const world = makeWorld(7, BIG_NOW, 30);
  const asked: string[] = [];
  const accounts = {
    search: async (account: string, query: { text: string }) => {
      asked.push(`${account}:${query.text}`);
      return { remoteThreadIds: [] };
    },
  } as unknown as AccountActorHost;
  const t = await openEngine(world.store, { ports: { accounts } });
  return {
    t,
    asked,
    done: async () => {
      await t.close();
      world.cleanup();
    },
  };
}

const hit = (thread: string, folder: string, draft = false) => ({
  ...incoming(thread, { folder }),
  subject: 'quokka sighting',
  flags: { seen: false, flagged: false, draft, fromMe: false },
});

test('search hits show in word search, except in Trash, in Spam or as drafts', async () => {
  const { t, done } = await rig();
  try {
    t.store.commit({
      opId: 'hits',
      origin: 'sync',
      step: 'search',
      writes: [
        hit('hit-inbox', 'INBOX'),
        hit('hit-trash', 'TRASH'),
        hit('hit-spam', 'SPAM'),
        hit('hit-draft', 'INBOX', true),
      ],
    });
    const found = await t.call('View/query', {
      spec: { kind: 'search', query: { text: 'quokka' } },
      limit: 200,
    });
    assert.deepEqual(found.ids, ['acct-1:hit-inbox']);
    const all = await t.call('View/query', {
      spec: { kind: 'search', query: { text: 'quokka', in: 'all' } },
      limit: 200,
    });
    assert.deepEqual(all.ids, ['acct-1:hit-inbox'], 'in:all is the same place');
  } finally {
    await done();
  }
});

test('Search/remote with only a place or a bookmark asks no provider and ends done', async () => {
  const { t, asked, done } = await rig();
  try {
    await t.call('Search/remote', {
      opId: 'op-empty',
      query: { text: ' ', in: 'done', is: ['bookmarked'] },
    });
    await t.advance(10);
    assert.deepEqual(asked, []);
    assert.equal(t.frames.filter(f => f.frame === 'progress').at(-1)?.kind, 'done');
    await t.call('Search/remote', { opId: 'op-from', query: { text: '', from: 'airbnb' } });
    await t.advance(10);
    assert.deepEqual(asked.sort(), ['acct-1:from:"airbnb"', 'imap:2:from:"airbnb"']);
  } finally {
    await done();
  }
});
