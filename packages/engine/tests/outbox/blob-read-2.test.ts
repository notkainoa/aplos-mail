import test from 'node:test';
import assert from 'node:assert/strict';
import { fields, gate, inWorld, SEC, type World } from './helpers';

/**
 * Blob package 4 follow-up (the Integrator's 09:22 finding): a discard while an upload's blob read
 * is held or failing must never get retry metadata written — the row is hidden without a revision
 * bump, and a hidden row must never be given a due time nor a problem.
 */

let ops = 0;
const next = () => `blob-op2-${++ops}`;

function attach(w: World, name = 'notes.txt', body: string | null = 'hello') {
  if (body !== null) w.blobs.set(`blob-${name}`, new TextEncoder().encode(body));
  return { id: `att-${name}`, name, mime: 'text/plain', size: 5, blobId: `blob-${name}` };
}

const withFile = (w: World, extra: Parameters<typeof fields>[0] = {}) =>
  fields({ attachments: [attach(w)], ...extra });

const draftRow = (w: World, id: string) =>
  w.first.store.read(q =>
    q.get<{ updated_at: number; synced_revision: number | null; data: string }>(
      'SELECT updated_at, synced_revision, data FROM drafts WHERE id = ?',
      id,
    ),
  )!;

test('viii: a draft discarded while its failing upload read runs keeps no due time on the hidden row', () =>
  inWorld(
    async w => {
      const drafts = w.first.outbox.drafts!;
      const d = drafts.set(next(), { fields: withFile(w) }).draft;
      await w.clock.advance(5 * SEC);
      await w.settle();
      assert.equal(w.remoteDrafts.saves.length, 1, 'the copy exists');
      // An edit asks for a fresh upload; hold its read open, then discard while it waits.
      drafts.set(next(), {
        id: d.id,
        baseRevision: d.revision,
        fields: withFile(w, { subject: 'v2' }),
      });
      const g = gate();
      w.blobReads.hold = g.wait;
      w.blobReads.fail = new Error('EIO');
      await w.clock.advance(5 * SEC);
      w.blobReads.hold = undefined;
      assert.equal(w.blobReads.calls.length, 2, 'the second upload is reading');
      // The discard hides the row (remote copy) without touching its revision.
      // Hold the provider's delete, so the hidden row is observable before it is confirmed gone.
      const hold = gate();
      w.remoteDrafts.removeScript.push({ wait: hold.wait });
      drafts.destroy(next(), d.id);
      g.open();
      await w.settle();
      const row = draftRow(w, d.id);
      const meta = (
        JSON.parse(row.data) as {
          _sync: { removing?: boolean; dueAt?: number; problem?: unknown };
        }
      )._sync;
      assert.equal(meta.removing, true, 'hidden');
      assert.equal(meta.dueAt, undefined, 'no retry deadline lands on the hidden row');
      assert.equal(meta.problem, undefined, 'and no problem');
      hold.open();
      await w.clock.advance(60 * SEC);
      await w.settle();
      assert.equal(draftRow(w, d.id), undefined, 'then the confirmed copy removes the row');
    },
    { drafts: true },
  ));

test('viii: a draft with no copy deleted while its failing upload read runs writes nothing', () =>
  inWorld(
    async w => {
      const drafts = w.first.outbox.drafts!;
      const d = drafts.set(next(), { fields: withFile(w) }).draft;
      // No upload yet, so no remote copy: the discard deletes the row outright (deleteHidden).
      const g = gate();
      w.blobReads.hold = g.wait;
      w.blobReads.fail = new Error('EIO');
      await w.clock.advance(5 * SEC);
      w.blobReads.hold = undefined;
      assert.equal(w.blobReads.calls.length, 1, 'the upload is reading');
      drafts.destroy(next(), d.id);
      g.open();
      await w.settle();
      assert.equal(draftRow(w, d.id), undefined, 'gone for good');
      await w.clock.advance(60 * SEC);
      await w.settle();
      assert.equal(draftRow(w, d.id), undefined, 'nothing resurrects it');
    },
    { drafts: true },
  ));

test('viii: a hidden row left holding a due time (pre-guard damage) loses it when the due scan fires', () =>
  inWorld(
    async w => {
      // Unreachable through today's writers (the hide clears dueAt atomically and the commit guard
      // refuses every later dueAt write on a removing row), so this is the legacy shape the backstop
      // repairs: removing:true with a past deadline still on the row.
      const f = withFile(w) as ReturnType<typeof withFile> & { _sync?: Record<string, unknown> };
      f._sync = { rev: 1, removing: true, removeAt: 1, dueAt: 1 };
      w.draft('d1', f, { remoteDraftId: 'rd-x' });
      // Hold the provider's delete so the hidden row stays observable.
      const hold = gate();
      w.remoteDrafts.removeScript.push({ wait: hold.wait });
      await w.clock.advance(5 * SEC);
      await w.settle();
      const row = draftRow(w, 'd1');
      const meta = (JSON.parse(row.data) as { _sync: { removing?: boolean; dueAt?: number } })
        ._sync;
      assert.equal(meta.removing, true, 'still hidden');
      assert.equal(meta.dueAt, undefined, 'the backstop cleared the stale deadline');
      hold.open();
    },
    { drafts: true },
  ));
