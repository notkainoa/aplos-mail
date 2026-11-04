import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ContractError } from '@aplos/contract/contract-error';
import { MAX_ALLOW_LIST } from '../../src/mail/allow-list';
import { StoreError } from '../../src/store';
import { readAllowList } from '../../src/mail/policy';
import { mailWorld, type World } from './harness';

// `Mail/allowImages`: add, remove, normalise, replay, bound, and keep the rest of the settings document.

async function withWorld(fn: (w: World) => Promise<void>) {
  const world = await mailWorld();
  try {
    await fn(world);
  } finally {
    await world.cleanup();
  }
}

const list = (w: World) => w.store.read(readAllowList);
const allow = (w: World, opId: string, sender: string, on = true) =>
  w.windowA.call('Mail/allowImages', { opId, sender, allow: on }) as Promise<{
    opId: string;
    appliedState: { seq: number; dbEpoch: string };
    undoable?: boolean;
  }>;

describe('Mail/allowImages', () => {
  it('adds a normalised address or @domain, once, and removes it', () =>
    withWorld(async w => {
      const receipt = await allow(w, 'o1', 'Ada@Corp.Example');
      assert.equal(receipt.opId, 'o1');
      assert.equal(receipt.undoable, false);
      assert.equal(receipt.appliedState.seq, w.store.seq());
      await allow(w, 'o2', '@Shop.Example');
      await allow(w, 'o3', 'ada@corp.example');
      assert.deepEqual(list(w), ['ada@corp.example', '@shop.example'], 'no duplicate');
      await allow(w, 'o4', 'ADA@corp.example', false);
      assert.deepEqual(list(w), ['@shop.example']);
      await allow(w, 'o5', 'nobody@else.example', false);
      assert.deepEqual(list(w), ['@shop.example']);
    }));

  it('is idempotent for the same opId', () =>
    withWorld(async w => {
      const first = await allow(w, 'same', 'ada@corp.example');
      await allow(w, 'other', 'ada@corp.example', false);
      const replay = await allow(w, 'same', 'ada@corp.example');
      assert.equal(replay.appliedState.seq, first.appliedState.seq, 'the first commit’s seq');
      assert.deepEqual(list(w), [], 'the replay applied nothing');
    }));

  it('refuses a malformed sender as the contract does', () =>
    withWorld(async w => {
      for (const sender of ['', 'ada', '@', '@localhost', 'a b@c.example', '<a@b.example>']) {
        await assert.rejects(
          allow(w, `bad-${sender}`, sender),
          (e: unknown) => e instanceof ContractError && e.type === 'validation',
          sender,
        );
      }
      assert.deepEqual(list(w), []);
    }));

  it(`keeps at most ${MAX_ALLOW_LIST} entries`, () =>
    withWorld(async w => {
      const full = Array.from({ length: MAX_ALLOW_LIST }, (_, i) => `s${i}@full.example`);
      const doc = JSON.stringify({
        ui: { theme: 'dark' },
        mail: { followUpDays: 3, imageAllowList: full },
      });
      fillSettings(w, doc);
      await assert.rejects(
        allow(w, 'one-more', 'new@one.example'),
        (e: unknown) => e instanceof ContractError && e.type === 'tooLarge',
      );
      await allow(w, 'existing', 's1@full.example');
      await allow(w, 'remove', 's1@full.example', false);
      assert.equal(list(w).length, MAX_ALLOW_LIST - 1);
      await allow(w, 'now-fits', 'new@one.example');
      assert.equal(list(w).length, MAX_ALLOW_LIST);
      const write = { kind: 'imageAllowList', sender: 'direct@one.example', allow: true } as const;
      assert.throws(
        () => w.store.commit({ opId: 'direct', origin: 'local', writes: [write] }),
        (e: unknown) => e instanceof StoreError && e.code === 'invalid',
        'the writer holds the bound too',
      );
      assert.equal(list(w).length, MAX_ALLOW_LIST);
    }));

  it('keeps the rest of the settings document', () =>
    withWorld(async w => {
      fillSettings(w, JSON.stringify({ ui: { theme: 'dark' }, mail: { followUpDays: 3 } }));
      await allow(w, 'o1', 'ada@corp.example');
      const data = w.store.read(q =>
        q.get<{ data: string }>('SELECT data FROM settings WHERE id = 1'),
      );
      assert.deepEqual(JSON.parse(data!.data), {
        ui: { theme: 'dark' },
        mail: { followUpDays: 3, imageAllowList: ['ada@corp.example'] },
      });
    }));
});

/** The settings document as `Settings/set` (not built yet) would leave it, written straight to the table. */
function fillSettings(w: World, data: string) {
  w.rawSql(
    'INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
    data,
  );
}

describe('Mail/allowImages audit', () => {
  it('a listener client leaves one content-free audit row; a window leaves none', () =>
    withWorld(async w => {
      const listener = w.engine.connect({
        kind: 'listener',
        via: 'socket',
        clientId: 'audit-1',
        scopes: ['read', 'admin'],
      });
      await listener.call('Mail/allowImages', {
        opId: 'aud-1',
        sender: 'client@one.example',
        allow: true,
      });
      const rows = w.store.read(q =>
        q.all<{ client_id: string; method: string; target: string | null }>(
          'SELECT client_id, method, target FROM audit_log',
        ),
      );
      assert.deepEqual(
        rows.map(r => ({ ...r })),
        [{ client_id: 'audit-1', method: 'Mail/allowImages', target: 'client@one.example' }],
      );
      await allow(w, 'win-1', 'window@two.example');
      assert.equal(
        w.store.read(q => q.all('SELECT id FROM audit_log')).length,
        1,
        'a window call writes no row',
      );
      const again = (await listener.call('Mail/allowImages', {
        opId: 'aud-1',
        sender: 'client@one.example',
        allow: true,
      })) as { opId: string };
      assert.ok(again.opId === 'aud-1', 'a replay succeeds');
      assert.equal(
        w.store.read(q => q.all('SELECT id FROM audit_log')).length,
        1,
        'a replayed opId writes the row once',
      );
    }));
});
