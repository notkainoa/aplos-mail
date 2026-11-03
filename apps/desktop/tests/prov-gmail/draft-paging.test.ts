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
/** Draft ids whose `drafts.get` is answered by `getReply` (and counted in `getCalls`) instead of the emulator. */
let getCalls: string[] = [];
let getReply: ((draftId: string) => Response | undefined) | undefined;

function listFetch(
  holder: { emu?: GmailEmulator },
  change: (json: { drafts?: { id: string }[]; nextPageToken?: string }) => void,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const token = url.searchParams.get('pageToken');
    const getId = /\/drafts\/([^/]+)$/.exec(url.pathname)?.[1];
    if (getId && url.searchParams.get('fields') === 'id,message(labelIds)') {
      getCalls.push(getId);
      const given = getReply?.(getId);
      if (given) return given;
    }
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

const errorReply = (status: number, reason: string) =>
  Response.json(
    { error: { code: status, message: 'x', errors: [{ reason, message: 'x' }] } },
    { status },
  );

async function hiddenFrom(
  skip: Set<string>,
  endless?: { on: boolean },
): Promise<{ r: Rig; holder: { emu?: GmailEmulator } }> {
  const holder: { emu?: GmailEmulator } = {};
  getCalls = [];
  getReply = undefined;
  const r = await synced(
    {
      adapter: {
        fetch: listFetch(holder, json => {
          if (json.drafts) json.drafts = json.drafts.filter(d => !skip.has(d.id));
          if (endless?.on) json.nextPageToken = 'fake:start';
        }),
      },
    },
    holder,
  );
  return { r, holder };
}

test('prov-gmail-drafts paging: a draft moved to Trash is reported removed (drafts.list hides it, drafts.get still answers 200)', async () => {
  const { r } = await hiddenFrom(new Set());
  const trashed = r.emu.mailbox.createDraftElsewhere(spec('Trashed on the phone'));
  await historyPass(r);
  assert.ok(r.store.drafts.get(trashed.draftId));
  r.emu.mailbox.trashMessage(trashed.messageId);
  r.emu.mailbox.createDraftElsewhere(spec('Another draft prompts a listing'));
  await r.clock.advance(60_000);
  await historyPass(r);
  assert.equal(r.store.drafts.get(trashed.draftId)?.removed, true);
});

test('prov-gmail-drafts paging: ten live drafts the listing hides never starve a later real deletion (least recently checked first)', async () => {
  const skip = new Set<string>();
  const endless = { on: false };
  const { r } = await hiddenFrom(skip, endless);
  const hidden = Array.from({ length: 12 }, (_, i) =>
    r.emu.mailbox.createDraftElsewhere(spec(`Hidden ${i}`)),
  );
  const doomed = r.emu.mailbox.createDraftElsewhere(spec('Doomed'));
  await historyPass(r);
  for (const d of hidden) skip.add(d.draftId);
  // The deletion arrives while the listing is incomplete, so nothing is checked yet: it is a cold entry later.
  endless.on = true;
  r.emu.mailbox.deleteDraft(doomed.draftId);
  await r.clock.advance(60_000);
  await historyPass(r);
  assert.equal(r.store.drafts.get(doomed.draftId)?.removed, undefined);
  endless.on = false;
  const perPass: number[] = [];
  for (let pass = 0; pass < 3 && !r.store.drafts.get(doomed.draftId)?.removed; pass++) {
    getCalls = [];
    r.emu.mailbox.createDraftElsewhere(spec(`Prompt ${pass}`));
    await r.clock.advance(60_000);
    await historyPass(r);
    perPass.push(getCalls.length);
  }
  assert.equal(r.store.drafts.get(doomed.draftId)?.removed, true, 'confirmed within three passes');
  assert.ok(
    perPass.every(c => c <= 10),
    `at most ten checks per pass: ${perPass.join(',')}`,
  );
  for (const d of hidden) assert.equal(r.store.drafts.get(d.draftId)?.removed, undefined);
});

test('prov-gmail-drafts paging: more than ten drafts deleted on one history page are all removed at once', async () => {
  const { r } = await hiddenFrom(new Set());
  const made = Array.from({ length: 13 }, (_, i) =>
    r.emu.mailbox.createDraftElsewhere(spec(`Bulk ${i}`)),
  );
  await historyPass(r);
  for (const d of made) r.emu.mailbox.deleteDraft(d.draftId);
  await r.clock.advance(60_000);
  await historyPass(r);
  assert.equal(
    made.filter(d => r.store.drafts.get(d.draftId)?.removed).length,
    13,
    'the drafts this page deleted are checked first, beyond the ten for the rest',
  );
});

for (const [name, reply] of [
  ['a 404 without the notFound reason', () => errorReply(404, 'backendError')],
  ['a permission refusal (403)', () => errorReply(403, 'forbidden')],
  ['a server error (500)', () => errorReply(500, 'backendError')],
] as const) {
  test(`prov-gmail-drafts paging: ${name} on the check proves nothing, the draft stays tracked`, async () => {
    const skip = new Set<string>();
    const { r } = await hiddenFrom(skip);
    const kept = r.emu.mailbox.createDraftElsewhere(spec('Kept'));
    await historyPass(r);
    skip.add(kept.draftId);
    getReply = id => (id === kept.draftId ? reply() : undefined);
    r.emu.mailbox.createDraftElsewhere(spec('Prompt'));
    await r.clock.advance(60_000);
    const from = r.store.commits.length;
    await historyPass(r);
    assert.ok(getCalls.includes(kept.draftId), 'the draft was checked');
    assert.deepEqual(
      factsSince(r, from).filter(f => f.removed),
      [],
    );
    getReply = undefined;
  });
}

for (const [name, labelIds, removed] of [
  ['a 200 with no labelIds', undefined, false],
  ['labels without DRAFT', ['INBOX'], true],
  ['a SENT label', ['DRAFT', 'SENT'], true],
  ['a plain DRAFT label', ['DRAFT'], false],
] as const) {
  test(`prov-gmail-drafts paging: ${name} on the check ${removed ? 'means gone' : 'keeps the draft'}`, async () => {
    const skip = new Set<string>();
    const { r } = await hiddenFrom(skip);
    const subject = r.emu.mailbox.createDraftElsewhere(spec('Checked'));
    await historyPass(r);
    skip.add(subject.draftId);
    getReply = id =>
      id === subject.draftId
        ? Response.json({ id, ...(labelIds ? { message: { id: 'x', labelIds } } : {}) })
        : undefined;
    r.emu.mailbox.createDraftElsewhere(spec('Prompt'));
    await r.clock.advance(60_000);
    await historyPass(r);
    assert.ok(getCalls.includes(subject.draftId));
    assert.equal(r.store.drafts.get(subject.draftId)?.removed, removed ? true : undefined);
    getReply = undefined;
  });
}

test('prov-gmail-drafts paging: drafts whose check keeps failing do not hold the front of the line', async () => {
  const skip = new Set<string>();
  const endless = { on: false };
  const { r } = await hiddenFrom(skip, endless);
  const stuck = Array.from({ length: 12 }, (_, i) =>
    r.emu.mailbox.createDraftElsewhere(spec(`Stuck ${i}`)),
  );
  const doomed = r.emu.mailbox.createDraftElsewhere(spec('Doomed'));
  await historyPass(r);
  for (const d of stuck) skip.add(d.draftId);
  const failing = new Set(stuck.map(d => d.draftId));
  getReply = id => (failing.has(id) ? errorReply(500, 'backendError') : undefined);
  endless.on = true;
  r.emu.mailbox.deleteDraft(doomed.draftId);
  await r.clock.advance(60_000);
  await historyPass(r);
  endless.on = false;
  for (let pass = 0; pass < 3 && !r.store.drafts.get(doomed.draftId)?.removed; pass++) {
    r.emu.mailbox.createDraftElsewhere(spec(`Prompt ${pass}`));
    await r.clock.advance(60_000);
    await historyPass(r);
  }
  assert.equal(r.store.drafts.get(doomed.draftId)?.removed, true);
  getReply = undefined;
});

test('prov-gmail-drafts paging: a draft restored from Trash is reported as a draft again', async () => {
  const { r } = await hiddenFrom(new Set());
  const draft = r.emu.mailbox.createDraftElsewhere(spec('Trashed, then restored'));
  await historyPass(r);
  r.emu.mailbox.trashMessage(draft.messageId);
  r.emu.mailbox.createDraftElsewhere(spec('Prompt'));
  await r.clock.advance(60_000);
  await historyPass(r);
  assert.equal(r.store.drafts.get(draft.draftId)?.removed, true);
  r.emu.mailbox.untrashMessage(draft.messageId);
  await r.clock.advance(60_000);
  const from = r.store.commits.length;
  await historyPass(r);
  const again = factsSince(r, from).find(f => f.remoteDraftId === draft.draftId);
  assert.ok(again && !again.removed, 'reported again as a live draft');
  assert.equal(r.store.drafts.get(draft.draftId)?.removed, undefined);
});
