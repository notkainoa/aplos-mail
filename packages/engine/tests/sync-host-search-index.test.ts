import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterContext, SearchResult, ServerSearch, StepResult } from '../src/ports';
import type { StorePort } from '../src/store';
import { ftsQuery } from '../src/views/search';
// What `views/module.ts` loads at engine start: installs the row builder `indexWritten` calls.
import '../src/store/fts-indexer';
import { ACCOUNT, FakeAdapter, disk, fact, governed, until, world } from './sync-actor-helpers';

/**
 * fix-search (2026-11-12): on the real engine, search found nothing because no commit ever wrote `messages_fts` (0 index
 * rows against 341 messages in the owner's store). A list round and a provider search both go through the actor host
 * here, with the real store, and what they stored must be searchable by the FTS query the search view runs.
 */

const indexed = (store: StorePort) =>
  store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM messages_fts_docsize')!.n);
const messages = (store: StorePort) =>
  store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM messages')!.n);
const matches = (store: StorePort, text: string) =>
  store.read(q =>
    q
      .all<{ remote_id: string }>(
        `SELECT m.remote_id FROM messages_fts f JOIN messages m ON m.id = f.rowid
        WHERE messages_fts MATCH ? ORDER BY m.remote_id`,
        ftsQuery({ text }),
      )
      .map(r => r.remote_id),
  );

class ListAndSearch extends FakeAdapter {
  searched: string[] = [];
  constructor() {
    super(
      input =>
        input.states.find(s => s.scope === 'window:inbox')?.phase === 'done'
          ? []
          : [
              {
                scope: 'window:inbox',
                lane: 'incremental',
                origin: 'baseline',
                trigger: input.trigger,
              },
            ],
      {
        'window:inbox': async (s, _state, ctx) => {
          await governed(ctx, s, 25);
          const result: StepResult = {
            upserts: [
              fact('m1', 1, {
                subject: 'Your reservation is confirmed',
                from: { address: 'automated@airbnb.example', name: 'Airbnb' },
              }),
              fact('m2', 2, { subject: 'AppleCare renewal', snippet: 'coverage for your laptop' }),
            ],
            nextStates: [
              { scope: 'window:inbox', generation: ctx.generation, updatedAt: 0, phase: 'done' },
            ],
            done: true,
            baselineReached: true,
            costUnits: 25,
          };
          return result;
        },
      },
    );
  }

  async search(query: ServerSearch, _ctx: AdapterContext): Promise<SearchResult> {
    this.searched.push(query.text);
    // A thread only the provider has: never listed here, so it arrives with `origin='search'`.
    const hit = fact('old', -60 * 24 * 400, { remoteThreadId: 't-old', subject: 'Cursor invoice' });
    return { upserts: [hit], remoteThreadIds: ['t-old'], costUnits: 5 };
  }
}

test('a list round and a provider search leave every stored message in the search index', async () => {
  const d = disk();
  const adapter = new ListAndSearch();
  const w = world(d, () => adapter);
  try {
    await w.host.start(ACCOUNT);
    await until(() => messages(w.store) === 2, 'the list round to commit');
    assert.equal(indexed(w.store), 2, 'every synced message has an index row');
    assert.deepEqual(matches(w.store, 'reservation'), ['m1'], 'subject words');
    assert.deepEqual(matches(w.store, 'airbnb'), ['m1'], 'sender name and address');
    assert.deepEqual(
      matches(w.store, 'coverage'),
      ['m2'],
      'the snippet stands in for a body not fetched',
    );

    await w.host.search(ACCOUNT, { text: 'cursor', limit: 10 });
    assert.deepEqual(adapter.searched, ['cursor']);
    assert.deepEqual(
      matches(w.store, 'cursor'),
      ['old'],
      'a search hit is searchable in the commit that stores it',
    );
    const origin = w.store.read(q =>
      q.get<{ origin: string }>("SELECT origin FROM messages WHERE remote_id = 'old'"),
    );
    assert.equal(origin?.origin, 'search');
    assert.equal(indexed(w.store), messages(w.store));
  } finally {
    await w.kill();
    d.cleanup();
  }
});
