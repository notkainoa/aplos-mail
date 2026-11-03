/**
 * prov-gmail drafts listing (google/history.ts `listDrafts`, `retainedDrafts`): `drafts.list` is paged to its end, and a
 * draft is reported `removed` only when the listing is complete AND `drafts.get` answers 404 for it. Integrator
 * end-to-end review HIGH 2: with more than 500 drafts the first page alone made a draft that still exists look deleted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { GmailEmulator } from '@aplos/emulators';
import type { RemoteDraftFact } from '@aplos/engine/ports';
import { rig, type Rig } from './harness';

const windowDone = (r: Rig) => () => r.store.states.get('window:inbox')?.phase === 'done';

async function synced(
  options: Parameters<typeof rig>[0] = {},
  holder: { emu?: GmailEmulator } = {},
): Promise<Rig> {
  const r = await rig({ threads: 60, ...options });
  holder.emu = r.emu;
  await r.drive({ until: windowDone(r), maxSteps: 300 });
  await r.clock.advance(60_000);
  return r;
}

async function historyPass(r: Rig): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
    if (!/^pass:/.test(r.store.states.get('history')?.phase ?? '')) return;
  }
  throw new Error('history pass did not finish');
}

const factsSince = (r: Rig, from: number): RemoteDraftFact[] =>
  r.store.commits.slice(from).flatMap(c => c.result.drafts ?? []);

const spec = (subject: string) => ({
  to: ['maren.ashgrove@mail.example.test'],
  subject,
  text: 'Phone text.',
});

const isList = (url: URL) => /\/drafts$/.test(url.pathname);

/** A fetch that lets `change` rewrite each `drafts.list` reply (pages, tokens, dropped items). */
let n = 0;
let listCalls = 0;

function listFetch(
  holder: { emu?: GmailEmulator },
  change: (json: { drafts?: { id: string }[]; nextPageToken?: string }) => void,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const token = url.searchParams.get('pageToken');
    if (isList(url)) listCalls++;
    if (isList(url) && token?.startsWith('fake:')) {
      const empty = { drafts: [], nextPageToken: token === 'fake:same' ? token : `fake:${n++}` };
      return Response.json(empty);
    }
    const response = await holder.emu!.fetch(input, init);
    if (!isList(url) || !response.ok || url.searchParams.has('q')) return response;
    const json = JSON.parse(await response.text()) as Parameters<typeof change>[0];
    change(json);
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function withManyDrafts(count: number): Promise<{ r: Rig; ids: string[]; from: number }> {
  const r = await synced();
  const first = r.emu.mailbox.createDraftElsewhere(spec('Tracked first'));
  await historyPass(r);
  assert.ok(
    r.store.drafts.get(first.draftId),
    'the first draft is tracked before the crowd arrives',
  );
  const ids = [first.draftId];
  for (let i = 1; i < count; i++)
    ids.push(r.emu.mailbox.createDraftElsewhere(spec(`D${i}`)).draftId);
  return { r, ids, from: r.store.commits.length };
}

test('prov-gmail-drafts paging: with 505 drafts no tracked draft is reported removed, and every page is read', async () => {
  const { r, ids, from } = await withManyDrafts(505);
  const start = r.clock.now();
  await historyPass(r);
  const facts = factsSince(r, from);
  assert.deepEqual(
    facts.filter(f => f.removed),
    [],
    'a draft that still exists is never removed',
  );
  assert.equal(r.store.drafts.get(ids[0])?.removed, undefined);
  assert.equal(new Set(facts.map(f => f.remoteDraftId)).size, 504, 'every new draft is reported');
  const lists = r.fetches.filter(f => f.at >= start && /\/drafts$/.test(f.path));
  assert.ok(lists.length >= 2, 'drafts.list is followed to its second page');
  assert.ok(lists.some(f => f.query.has('pageToken')));
});

test('prov-gmail-drafts paging: with 505 drafts a real deletion removes exactly that draft', async () => {
  const { r, ids } = await withManyDrafts(505);
  await historyPass(r);
  await r.clock.advance(60_000);
  const from = r.store.commits.length;
  r.emu.mailbox.deleteDraft(ids[0]);
  await historyPass(r);
  const removed = factsSince(r, from).filter(f => f.removed);
  assert.deepEqual(
    removed.map(f => f.remoteDraftId),
    [ids[0]],
  );
});

test('prov-gmail-drafts paging: a listing that skips an existing draft (a page race) does not remove it; drafts.get confirms', async () => {
  const holder: { emu?: GmailEmulator } = {};
  let skip = '';
  const r = await synced(
    {
      adapter: {
        fetch: listFetch(holder, json => {
          if (json.drafts) json.drafts = json.drafts.filter(d => d.id !== skip);
        }),
      },
    },
    holder,
  );
  const kept = r.emu.mailbox.createDraftElsewhere(spec('Skipped by a racing listing'));
  await historyPass(r);
  assert.ok(r.store.drafts.get(kept.draftId));
  skip = kept.draftId;
  await r.clock.advance(60_000);
  const from = r.store.commits.length;
  r.emu.mailbox.createDraftElsewhere(spec('Another'));
  await historyPass(r);
  assert.deepEqual(
    factsSince(r, from).filter(f => f.removed),
    [],
  );
  assert.equal(r.store.drafts.get(kept.draftId)?.removed, undefined);
  // Once the draft really goes (404), it is removed at last.
  skip = '';
  r.emu.mailbox.deleteDraft(kept.draftId);
  await r.clock.advance(60_000);
  await historyPass(r);
  assert.equal(r.store.drafts.get(kept.draftId)?.removed, true);
});

test('prov-gmail-drafts paging: a listing that never ends is incomplete and reports no removal, even for a draft that is gone', async () => {
  const holder: { emu?: GmailEmulator } = {};
  let endless = false;
  const r = await synced(
    {
      adapter: {
        fetch: listFetch(holder, json => {
          if (endless) json.nextPageToken = 'fake:start';
        }),
      },
    },
    holder,
  );
  const gone = r.emu.mailbox.createDraftElsewhere(spec('Will be deleted'));
  await historyPass(r);
  assert.ok(r.store.drafts.get(gone.draftId));
  endless = true;
  r.emu.mailbox.deleteDraft(gone.draftId);
  await r.clock.advance(60_000);
  const from = r.store.commits.length;
  listCalls = 0;
  await historyPass(r);
  assert.deepEqual(
    factsSince(r, from).filter(f => f.removed),
    [],
    'nothing is concluded from a listing that cannot be proved complete',
  );
  assert.equal(listCalls, 20, 'the paging stops at its bound');
  // The draft stays tracked: a later complete listing settles it.
  endless = false;
  r.emu.mailbox.createDraftElsewhere(spec('Prompts another listing'));
  await r.clock.advance(60_000);
  await historyPass(r);
  assert.equal(r.store.drafts.get(gone.draftId)?.removed, true);
});

test('prov-gmail-drafts paging: a repeated page token ends the listing as incomplete', async () => {
  const holder: { emu?: GmailEmulator } = {};
  let loop = false;
  const r = await synced(
    {
      adapter: {
        fetch: listFetch(holder, json => {
          if (loop) json.nextPageToken = 'fake:same';
        }),
      },
    },
    holder,
  );
  const gone = r.emu.mailbox.createDraftElsewhere(spec('Deleted'));
  await historyPass(r);
  loop = true;
  r.emu.mailbox.deleteDraft(gone.draftId);
  await r.clock.advance(60_000);
  const from = r.store.commits.length;
  listCalls = 0;
  await historyPass(r);
  assert.deepEqual(
    factsSince(r, from).filter(f => f.removed),
    [],
  );
  assert.equal(listCalls, 2, 'a token seen twice stops the loop at once');
});
