import test from 'node:test';
import assert from 'node:assert/strict';
import type { Draft, DraftFields } from '@aplos/contract';
import { ACCOUNT, fields, gate, inWorld, SEC, type DraftStep, type World } from './helpers';

/**
 * Draft port gaps 3 and 4, body delivery and `supersedes` (additive, optional within v:1): a removal carries the expected
 * message id, a create-path conflict names the copy it found, a remote draft can arrive with its body, and a fact can say
 * which message ids it replaces.
 */

const world = (fn: (w: World) => Promise<void> | void) => inWorld(fn, { drafts: true });

let ops = 0;
const next = () => `ports-op-${++ops}`;

const service = (w: World) => w.first.outbox.drafts!;
const create = (w: World, f: DraftFields = fields()) => service(w).set(next(), { fields: f }).draft;
const edit = (w: World, d: Pick<Draft, 'id' | 'revision'>, f: DraftFields, close = false) =>
  service(w).set(next(), { id: d.id, baseRevision: d.revision, fields: f, close }).draft;

const read = (w: World, id: string): Draft => {
  const found = service(w).get([id]);
  assert.equal(found.notFound.length, 0, `draft ${id} exists`);
  return found.list[0];
};

const wait = async (w: World, ms: number) => {
  await w.clock.advance(ms);
  await w.settle();
};

interface Row {
  revision: number;
  remote_draft_id: string | null;
  remote_message_id: string | null;
  remote_internet_id: string | null;
  [k: string]: string | number | null;
}

const row = (w: World, id: string) =>
  w.first.store.read(q => q.get<Row>('SELECT * FROM drafts WHERE id = ?', id));

const count = (w: World) =>
  w.first.store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM drafts'))!.n;

interface Sync {
  incomplete?: true;
  wrote?: string[];
  conflict?: { complete?: boolean; theirsMessageId?: string; theirs?: { html: string } };
  removing?: true;
}

const syncOf = (w: World, id: string): Sync => {
  const data = w.first.store.read(q =>
    q.get<{ data: string }>('SELECT data FROM drafts WHERE id = ?', id),
  )!.data;
  return (JSON.parse(data) as { _sync: Sync })._sync;
};

const THEIRS_ID = '<theirs@phone.example>';

interface Fact {
  subject?: string;
  html?: string;
  text?: string;
  internetId?: string;
  supersedes?: string[];
  removed?: true;
  /** An `html` on the message itself (the pre-existing way of delivering a body). */
  messageHtml?: string;
  to?: { address: string; name?: string }[];
  snippet?: string;
  hasAttachments?: boolean;
}

/** What history reports when another device saves a draft. */
function fact(w: World, remoteDraftId: string, messageId: string, f: Fact = {}) {
  w.first.store.commit({
    opId: `ports-fact-${++ops}`,
    origin: 'sync',
    writes: [
      {
        kind: 'remoteDraft',
        accountId: ACCOUNT,
        remoteDraftId,
        remoteMessageId: messageId,
        changedAt: w.clock.now(),
        ...(f.internetId !== undefined ? { internetId: f.internetId } : {}),
        ...(f.removed ? { removed: true as const } : {}),
        ...(f.html !== undefined ? { html: f.html } : {}),
        ...(f.text !== undefined ? { text: f.text } : {}),
        ...(f.supersedes ? { supersedes: f.supersedes } : {}),
        message: {
          remoteId: messageId,
          remoteThreadId: 'phone-thread',
          to: f.to ?? [{ address: 'jordan@mail.example' }],
          cc: [],
          subject: f.subject ?? 'From the phone',
          snippet: f.snippet ?? 'only a snippet',
          date: w.clock.now(),
          internalDate: w.clock.now(),
          flags: { seen: true, flagged: false, draft: true, fromMe: true },
          ...(f.messageHtml !== undefined ? { html: f.messageHtml } : {}),
          ...(f.hasAttachments !== undefined ? { hasAttachments: f.hasAttachments } : {}),
        },
      },
    ],
  });
}

async function synced(w: World, f: DraftFields = fields()) {
  const d = create(w, f);
  await wait(w, 5 * SEC);
  const r = row(w, d.id)!;
  assert.equal(r.revision, d.revision);
  return {
    draft: read(w, d.id),
    remoteDraftId: r.remote_draft_id!,
    messageId: r.remote_message_id!,
    internetId: r.remote_internet_id!,
  };
}

// ---------------------------------------------------------------- GAP 3: remove carries the expected message id

test('gap 3: discarding a synced draft passes the message id it last wrote, and a match deletes', () =>
  world(async w => {
    const s = await synced(w);
    service(w).destroy(next(), s.draft.id);
    await w.settle();
    assert.deepEqual(w.remoteDrafts.removeExpected, [s.messageId]);
    assert.deepEqual(w.remoteDrafts.removes, [s.remoteDraftId]);
    assert.equal(w.remoteDrafts.remote.size, 0);
    assert.equal(count(w), 0, 'the hidden row finished');
  }));

test('gap 3: a copy the phone replaced since is not deleted, and the hidden row still finishes', () =>
  world(async w => {
    const s = await synced(w);
    // The phone saved the draft; history has not reported it yet, so this device still holds the old message id.
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    service(w).destroy(next(), s.draft.id);
    await w.settle();
    assert.equal(w.remoteDrafts.removeAttempts.length, 1, 'the provider was asked');
    assert.deepEqual(w.remoteDrafts.removeGuarded, [s.remoteDraftId], 'and refused on the id');
    assert.deepEqual(w.remoteDrafts.removes, [], 'nothing was deleted');
    assert.equal(
      w.remoteDrafts.remote.get(s.remoteDraftId)?.messageId,
      phoneId,
      'the newer version is there',
    );
    assert.equal(count(w), 0, 'the discard is complete here');
  }));

test('gap 3: a removal for a copy with no known message id is the old call without one', () =>
  world(async w => {
    w.remoteDrafts.remote.set('rdX', { messageId: 'mX', internetId: '<x@x>', revision: 1 });
    const d = w.draft('d-unknown', fields(), { remoteDraftId: 'rdX' });
    service(w).destroy(next(), d.id);
    await w.settle();
    assert.deepEqual(w.remoteDrafts.removeExpected, [undefined]);
    assert.deepEqual(w.remoteDrafts.removes, ['rdX']);
    assert.equal(count(w), 0);
  }));

test('gap 3: a discard while the first upload runs removes the copy under the id that upload returned', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const d = create(w);
    await wait(w, 5 * SEC);
    service(w).destroy(next(), d.id);
    g.open();
    await wait(w, 2 * SEC);
    assert.deepEqual(w.remoteDrafts.removeExpected, ['msg2']);
    assert.deepEqual(w.remoteDrafts.removes, ['rd1']);
    assert.equal(count(w), 0);
  }));

// ---------------------------------------------------------------- GAP 4: the create-path conflict names the copy

/**
 * The first create landed but its reply was lost; the same revision asks again under the same Message-ID, and the
 * provider answers `step` (default `conflictExisting`: it found that copy, whose bytes differ).
 */
async function retriedCreate(w: World, step: DraftStep = { result: 'conflictExisting' }) {
  w.remoteDrafts.script.push({ result: 'landedLost' }, step);
  const d = create(w);
  await wait(w, 5 * SEC);
  const internetId = w.remoteDrafts.saves[0].internetId;
  assert.equal(w.remoteDrafts.remote.size, 1, 'the first create landed');
  await wait(w, 31 * SEC);
  assert.equal(
    w.remoteDrafts.saves[1].internetId,
    internetId,
    'the same revision keeps its Message-ID',
  );
  assert.equal(w.remoteDrafts.saves[1].remoteDraftId, undefined, 'and is a create again');
  return { draft: d, internetId };
}

test('gap 4: a copy proven to carry our Message-ID is adopted: keep mine updates it, no second copy', () =>
  world(async w => {
    const { draft: d, internetId } = await retriedCreate(w);
    const held = row(w, d.id)!;
    assert.equal(held.remote_draft_id, 'rd1', 'the copy is the draft');
    assert.equal(held.remote_message_id, null, 'its message id is theirs, not a base of ours');
    const wrote = syncOf(w, d.id).wrote ?? [];
    assert.ok(wrote.includes(internetId), 'the Message-ID is remembered as ours');
    assert.ok(
      !wrote.includes('msg2'),
      'the copy`s message id is not, so its echo can still arrive',
    );
    assert.equal(syncOf(w, d.id).conflict?.theirsMessageId, 'msg2');
    assert.ok(read(w, d.id).conflict, 'the choice is asked');
    service(w).resolve(next(), d.id, 'keepMine');
    await wait(w, 40 * SEC);
    const third = w.remoteDrafts.saves.at(-1)!;
    assert.equal(third.remoteDraftId, 'rd1', 'keep mine replaced the copy');
    assert.equal(third.baseRemoteMessageId, 'msg2');
    assert.equal(w.remoteDrafts.remote.size, 1, 'no second Gmail draft');
    assert.equal(read(w, d.id).conflict, undefined);
    assert.equal(read(w, d.id).sync, 'synced');
  }));

test('gap 4: the adopted copy`s own history fact fills "theirs": no phantom draft, take theirs and keep both work', () =>
  world(async w => {
    const { draft: d, internetId } = await retriedCreate(w);
    const revision = row(w, d.id)!.revision;
    fact(w, 'rd1', 'msg2', { internetId, subject: 'Edited elsewhere', html: '<p>Their body</p>' });
    assert.equal(service(w).get([`${ACCOUNT}:rd1`]).notFound.length, 1, 'no phantom draft');
    assert.equal(count(w), 1);
    assert.equal(row(w, d.id)!.revision, revision, 'and not a replacement of the draft');
    const c = syncOf(w, d.id).conflict;
    assert.equal(c?.complete, true, 'their version arrived');
    assert.equal(c?.theirs?.html, '<p>Their body</p>');
    const both = service(w).resolve(next(), d.id, 'keepBoth');
    assert.equal(read(w, both.copyId!).html, '<p>Their body</p>', 'keep both has the body');
    await wait(w, 40 * SEC);
    const last = w.remoteDrafts.saves.filter(u => u.draftId === d.id).at(-1)!;
    assert.equal(last.remoteDraftId, 'rd1');
    const messageId = w.remoteDrafts.remote.get('rd1')!.messageId;
    fact(w, 'rd1', messageId, { internetId: last.internetId, subject: 'echo of keep mine' });
    assert.equal(count(w), 2, 'the draft and the kept copy; still no phantom');
    assert.equal(read(w, d.id).conflict, undefined);
  }));

test('gap 4: a copy with another Message-ID is not adopted: the ordinary conflict, keep mine creates its own', () =>
  world(async w => {
    w.remoteDrafts.remote.set('rdX', { messageId: 'mX', internetId: '<x@x.example>', revision: 1 });
    w.remoteDrafts.script.push({ result: 'conflictForeign' });
    const d = create(w);
    await wait(w, 5 * SEC);
    const held = row(w, d.id)!;
    assert.equal(held.remote_draft_id, null, 'not adopted');
    assert.ok(read(w, d.id).conflict, 'the conflict is raised as before');
    assert.deepEqual(syncOf(w, d.id).wrote ?? [], [], 'nothing is remembered as ours');
    service(w).resolve(next(), d.id, 'keepMine');
    await wait(w, 1);
    assert.equal(w.remoteDrafts.saves.at(-1)!.remoteDraftId, undefined, 'a create of its own');
    assert.ok(w.remoteDrafts.remote.has('rdX'), 'the other message is untouched');
    assert.equal(w.remoteDrafts.remote.get('rdX')!.messageId, 'mX');
  }));

test('gap 4: a copy the adapter does not prove is ours is not adopted either', () =>
  world(async w => {
    const { draft: d } = await retriedCreate(w, { result: 'conflictUnproven' });
    assert.equal(row(w, d.id)!.remote_draft_id, null);
    assert.ok(read(w, d.id).conflict);
    assert.deepEqual(syncOf(w, d.id).wrote ?? [], [], 'nothing remembered');
  }));

test('gap 4: an adopted copy without a message id still serves keep mine (unguarded replace, as the owner chose)', () =>
  world(async w => {
    const { draft: d } = await retriedCreate(w, {
      result: 'conflictExisting',
      omitMessageId: true,
    });
    const held = row(w, d.id)!;
    assert.equal(held.remote_draft_id, 'rd1');
    assert.equal(held.remote_message_id, null);
    service(w).resolve(next(), d.id, 'keepMine');
    await wait(w, 1);
    const third = w.remoteDrafts.saves.at(-1)!;
    assert.equal(third.remoteDraftId, 'rd1');
    assert.equal(third.baseRemoteMessageId, undefined);
    assert.equal(w.remoteDrafts.remote.size, 1);
  }));

for (const omitMessageId of [false, true]) {
  test(`gap 4: discarding an adopted, conflicted draft forgets the copy, never deletes it (message id ${omitMessageId ? 'absent' : 'named'})`, () =>
    world(async w => {
      const step: DraftStep = {
        result: 'conflictExisting',
        ...(omitMessageId ? { omitMessageId } : {}),
      };
      const { draft: d } = await retriedCreate(w, step);
      assert.equal(row(w, d.id)!.remote_draft_id, 'rd1');
      service(w).destroy(next(), d.id);
      await w.settle();
      await wait(w, 2 * SEC);
      assert.deepEqual(w.remoteDrafts.removeAttempts, [], 'the provider was never asked to delete');
      assert.equal(w.remoteDrafts.remote.size, 1, 'the differing copy is still there');
      assert.equal(count(w), 0, 'and the discard is complete here');
    }));
}

test('gap 4: a draft discarded while its retried create runs does not adopt the conflict`s copy, and the copy stays', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push(
      { result: 'landedLost' },
      { result: 'conflictExisting', wait: g.wait },
    );
    const d = create(w);
    await wait(w, 5 * SEC);
    const internetId = w.remoteDrafts.saves[0].internetId;
    await wait(w, 31 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 2, 'the second create is waiting');
    service(w).destroy(next(), d.id);
    g.open();
    await wait(w, 2 * SEC);
    assert.deepEqual(w.remoteDrafts.removeAttempts, [], 'nothing was deleted');
    assert.equal(w.remoteDrafts.remote.size, 1, 'the differing copy is still there');
    assert.equal(count(w), 0, 'the hidden row ended at once');
    // It is another device's version now: history showing it later is a draft of its own, not a deletion.
    fact(w, 'rd1', 'msg2', { internetId });
    assert.equal(count(w), 1);
    assert.equal(service(w).get([`${ACCOUNT}:rd1`]).notFound.length, 0);
  }));

test('gap 4: a conflict on an update never adopts the copy it names, even one claiming our Message-ID', () =>
  world(async w => {
    const s = await synced(w);
    w.remoteDrafts.script.push({ result: 'conflictRename' });
    edit(w, s.draft, fields({ subject: 'Mine' }), true);
    await wait(w, 1);
    const held = row(w, s.draft.id)!;
    assert.equal(held.remote_draft_id, s.remoteDraftId);
    assert.equal(held.remote_message_id, s.messageId, 'the base is still what this device wrote');
    assert.ok(!(syncOf(w, s.draft.id).wrote ?? []).includes('msg-other'));
    assert.ok(read(w, s.draft.id).conflict, 'the ordinary conflict');
  }));

test('gap 4: a conflict on an update names no copy to adopt: the stored ids stay', () =>
  world(async w => {
    const s = await synced(w);
    w.remoteDrafts.phoneEdit(s.remoteDraftId);
    edit(w, s.draft, fields({ subject: 'Mine' }), true);
    await wait(w, 1);
    const held = row(w, s.draft.id)!;
    assert.equal(held.remote_draft_id, s.remoteDraftId);
    assert.equal(held.remote_message_id, s.messageId, 'the base is still what this device wrote');
  }));

test('gap 3: the rowless removal (the row is gone when the first upload lands) still carries the message id', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const d = create(w);
    await wait(w, 5 * SEC);
    service(w).destroy(next(), d.id);
    // The hidden row ends while the upload runs (another instance, or its wait ran out): no row will take the result.
    w.first.store.commit({
      opId: next(),
      origin: 'system',
      writes: [{ kind: 'draftDelete', id: d.id, at: w.clock.now(), final: true }],
    });
    assert.equal(row(w, d.id), undefined, 'no row');
    g.open();
    await wait(w, 2 * SEC);
    assert.deepEqual(
      w.remoteDrafts.removeExpected,
      ['msg2'],
      'guarded by the id that upload returned',
    );
    assert.deepEqual(w.remoteDrafts.removes, ['rd1']);
  }));

// ---------------------------------------------------------------- body delivery

test('body: a phone draft delivered with html is complete, editable in place and no fork', () =>
  world(async w => {
    fact(w, 'phone-1', 'pm-1', { html: '<p>The full text</p>' });
    const id = `${ACCOUNT}:phone-1`;
    const d = read(w, id);
    assert.equal(d.html, '<p>The full text</p>');
    assert.equal(syncOf(w, id).incomplete, undefined, 'complete');
    const edited = edit(w, d, fields({ subject: 'Edited here', html: d.html }));
    assert.equal(edited.id, id, 'edited in place');
    assert.equal(count(w), 1, 'no fork');
  }));

test('body: without html a phone draft is snippet-only and an edit forks, as before', () =>
  world(async w => {
    fact(w, 'phone-1', 'pm-1');
    const id = `${ACCOUNT}:phone-1`;
    assert.equal(syncOf(w, id).incomplete, true);
    const d = read(w, id);
    const edited = edit(w, d, fields({ subject: 'Edited here' }));
    assert.notEqual(edited.id, id, 'the edit is a draft of its own');
    assert.equal(count(w), 2, 'forked');
    assert.equal(syncOf(w, id).incomplete, true, 'and the phone draft is untouched');
  }));

test('body: text alone completes the draft too, escaped, and the top-level html wins over the message html', () =>
  world(async w => {
    fact(w, 'phone-1', 'pm-1', { text: 'a < b\n\nsecond' });
    assert.equal(read(w, `${ACCOUNT}:phone-1`).html, '<p>a &lt; b</p><p>second</p>');
    assert.equal(syncOf(w, `${ACCOUNT}:phone-1`).incomplete, undefined);
    fact(w, 'phone-2', 'pm-2', { html: '<p>top</p>', messageHtml: '<p>message</p>' });
    assert.equal(read(w, `${ACCOUNT}:phone-2`).html, '<p>top</p>');
  }));

test('body: an ampersand in a text body is escaped (so "&lt;" typed by the owner stays text)', () =>
  world(async w => {
    fact(w, 'phone-1', 'pm-1', { text: 'Tom & Jerry &lt; > 1' });
    assert.equal(read(w, `${ACCOUNT}:phone-1`).html, '<p>Tom &amp; Jerry &amp;lt; &gt; 1</p>');
  }));

test('body: the top-level html wins over the top-level text', () =>
  world(async w => {
    fact(w, 'phone-1', 'pm-1', { html: '<p>the html</p>', text: 'the text' });
    assert.equal(read(w, `${ACCOUNT}:phone-1`).html, '<p>the html</p>');
    fact(w, 'phone-2', 'pm-2', { text: 'the text', messageHtml: '<p>message</p>' });
    assert.equal(
      read(w, `${ACCOUNT}:phone-2`).html,
      '<p>the text</p>',
      'text over the message html',
    );
  }));

test('body: an attachment-carrying draft stays incomplete even with its body: an edit forks, never uploads attachments: []', () =>
  world(async w => {
    fact(w, 'phone-1', 'pm-1', { html: '<p>See attached</p>', hasAttachments: true });
    const id = `${ACCOUNT}:phone-1`;
    assert.equal(syncOf(w, id).incomplete, true, 'incomplete');
    const d = read(w, id);
    assert.equal(d.incomplete, true);
    const edited = edit(w, d, fields({ subject: 'Edited here' }));
    assert.notEqual(edited.id, id, 'the edit is a draft of its own');
    assert.equal(syncOf(w, id).incomplete, true, 'the phone draft is untouched');
    const revision = row(w, id)!.revision;
    fact(w, 'phone-1', 'pm-1', { html: '<p>See attached</p>', hasAttachments: true });
    assert.equal(row(w, id)!.revision, revision, 'the same copy again changes nothing');
  }));

test('body: a draft whose attachments the fact says are none is complete', () =>
  world(async w => {
    fact(w, 'phone-1', 'pm-1', { html: '<p>No files</p>', hasAttachments: false });
    assert.equal(syncOf(w, `${ACCOUNT}:phone-1`).incomplete, undefined);
  }));

test('body: a phone edit with attachments raises a choice that cannot take theirs or keep both', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, theirId, {
      subject: 'Theirs',
      html: '<p>With a file</p>',
      internetId: THEIRS_ID,
      hasAttachments: true,
    });
    assert.notEqual(syncOf(w, s.draft.id).conflict?.complete, true);
    assert.throws(() => service(w).resolve(next(), s.draft.id, 'takeTheirs'));
    assert.throws(() => service(w).resolve(next(), s.draft.id, 'keepBoth'));
    assert.ok(read(w, s.draft.id).conflict, 'still asked');
  }));

test('body: a clean synced draft is not silently replaced by a phone edit that carries attachments', () =>
  world(async w => {
    const s = await synced(w);
    fact(w, s.remoteDraftId, 'msg-phone', {
      html: '<p>With a file</p>',
      internetId: THEIRS_ID,
      hasAttachments: true,
    });
    const d = read(w, s.draft.id);
    assert.ok(d.conflict, 'the owner chooses');
    assert.equal(d.html, '<p>Lunch at noon?</p>', 'and their text did not replace the draft');
  }));

const CAP = 1_000_000;

test('body: a remote html over the local cap leaves the draft incomplete (snippet only); at the cap it is complete', () =>
  world(async w => {
    fact(w, 'big', 'pm-big', { html: 'x'.repeat(CAP + 1) });
    const big = `${ACCOUNT}:big`;
    assert.equal(syncOf(w, big).incomplete, true);
    assert.equal(read(w, big).html, '<p>only a snippet</p>', 'the snippet, not a megabyte');
    fact(w, 'edge', 'pm-edge', { html: 'x'.repeat(CAP) });
    assert.equal(syncOf(w, `${ACCOUNT}:edge`).incomplete, undefined);
    assert.equal(read(w, `${ACCOUNT}:edge`).html.length, CAP);
  }));

test('body: the cap counts the stored body: a text that grows past it when escaped and wrapped is incomplete', () =>
  world(async w => {
    fact(w, 'amps', 'pm-a', { text: '&'.repeat(CAP / 4) });
    assert.equal(syncOf(w, `${ACCOUNT}:amps`).incomplete, true, 'escaped it is five times as long');
    fact(w, 'wrap', 'pm-w', { text: 'x'.repeat(CAP - 7) });
    assert.equal(
      syncOf(w, `${ACCOUNT}:wrap`).incomplete,
      undefined,
      '<p></p> brings it to the cap',
    );
    fact(w, 'over', 'pm-o', { text: 'x'.repeat(CAP - 6) });
    assert.equal(syncOf(w, `${ACCOUNT}:over`).incomplete, true, 'one more and it is over');
  }));

test('body: an oversized body on a phone edit does not become a replacement or a complete "theirs"', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, theirId, { html: 'x'.repeat(CAP + 1), internetId: THEIRS_ID });
    const c = syncOf(w, s.draft.id).conflict;
    assert.notEqual(c?.complete, true);
    assert.equal(c?.theirs?.html, '<p>only a snippet</p>');
  }));

test('body: an empty html with a snippet is not a body; with no snippet it is', () =>
  world(async w => {
    fact(w, 'phone-1', 'pm-1', { html: '' });
    assert.equal(
      syncOf(w, `${ACCOUNT}:phone-1`).incomplete,
      true,
      'the snippet says there is text',
    );
    fact(w, 'phone-1', 'pm-1', { html: '' });
    assert.equal(syncOf(w, `${ACCOUNT}:phone-1`).incomplete, true, 'again, still not a body');
    fact(w, 'phone-2', 'pm-2', { html: '', snippet: '' });
    assert.equal(syncOf(w, `${ACCOUNT}:phone-2`).incomplete, undefined, 'a really empty draft');
    fact(w, 'phone-3', 'pm-3', { html: '', text: 'the real text' });
    assert.equal(
      read(w, `${ACCOUNT}:phone-3`).html,
      '<p>the real text</p>',
      'text is next in line',
    );
  }));

test('body: the same snippet-only copy again with its body completes it', () =>
  world(async w => {
    fact(w, 'phone-1', 'pm-1');
    const id = `${ACCOUNT}:phone-1`;
    assert.equal(syncOf(w, id).incomplete, true);
    fact(w, 'phone-1', 'pm-1', { html: '<p>Now whole</p>' });
    assert.equal(syncOf(w, id).incomplete, undefined);
    assert.equal(read(w, id).html, '<p>Now whole</p>');
  }));

test('body: a phone edit delivered with html makes take theirs and keep both work with the full body', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, theirId, {
      subject: 'Theirs',
      html: '<p>Their whole body</p>',
      internetId: THEIRS_ID,
    });
    assert.equal(syncOf(w, s.draft.id).conflict?.complete, true);
    const both = service(w).resolve(next(), s.draft.id, 'keepBoth');
    assert.equal(
      read(w, both.copyId!).html,
      '<p>Their whole body</p>',
      'keep both: the copy has the body',
    );
  }));

test('body: take theirs gets the full body', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, theirId, {
      subject: 'Theirs',
      html: '<p>Their whole body</p>',
      internetId: THEIRS_ID,
    });
    const out = service(w).resolve(next(), s.draft.id, 'takeTheirs');
    assert.equal(out.draft.html, '<p>Their whole body</p>');
  }));

test('gap 3: a provider that ignores the expected id still sees the engine forget (not delete) a copy it adopted from a conflict', () =>
  world(async w => {
    w.remoteDrafts.state.ignoreExpected = true;
    const { draft: d } = await retriedCreate(w, { result: 'conflictExisting' });
    service(w).destroy(next(), d.id);
    await w.settle();
    await wait(w, 2 * SEC);
    assert.deepEqual(
      w.remoteDrafts.removeAttempts,
      [],
      'the rules that need no provider help still hold',
    );
    assert.equal(w.remoteDrafts.remote.size, 1);
    assert.equal(count(w), 0);
  }));

test('gap 3: a provider that ignores the expected id deletes an edit history has not reported yet (the limit of an old provider)', () =>
  world(async w => {
    w.remoteDrafts.state.ignoreExpected = true;
    const s = await synced(w);
    w.remoteDrafts.phoneEdit(s.remoteDraftId);
    service(w).destroy(next(), s.draft.id);
    await w.settle();
    assert.deepEqual(
      w.remoteDrafts.removeExpected,
      [s.messageId],
      'the engine still passed the id',
    );
    assert.deepEqual(w.remoteDrafts.removeGuarded, [], 'but this provider cannot refuse on it');
    assert.equal(w.remoteDrafts.remote.has(s.remoteDraftId), false);
    assert.equal(count(w), 0, 'the hidden row finished');
  }));

// ---------------------------------------------------------------- supersedes

/** The fact of our own upload's copy under a new message id: same content, same Message-ID. */
const echoOf = (s: { internetId: string; messageId: string }, f: Fact = {}): Fact => ({
  internetId: s.internetId,
  supersedes: [s.messageId],
  subject: 'Lunch',
  to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
  html: '<p>Lunch at noon?</p>',
  ...f,
});

test('supersedes: our own upload finished, the same content under our Message-ID and a new message id is our echo', () =>
  world(async w => {
    const s = await synced(w);
    const revision = row(w, s.draft.id)!.revision;
    fact(w, s.remoteDraftId, 'msg-new', echoOf(s));
    const held = row(w, s.draft.id)!;
    assert.equal(held.remote_message_id, 'msg-new', 'the base moved');
    assert.equal(held.revision, revision, 'no replacement of the draft');
    assert.equal(read(w, s.draft.id).conflict, undefined, 'no conflict');
    assert.ok(
      syncOf(w, s.draft.id).wrote?.includes('msg-new'),
      'and the new id is remembered as ours',
    );
    // The next upload is checked against the advanced base, so it is not a stale one.
    edit(w, read(w, s.draft.id), fields({ subject: 'Later edit' }), true);
    await wait(w, 1);
    assert.equal(w.remoteDrafts.saves.at(-1)!.baseRemoteMessageId, 'msg-new');
  }));

test('supersedes: a phone edit that keeps our Message-ID is NOT our echo when no upload is running and the content differs', () =>
  world(async w => {
    const s = await synced(w);
    const revision = row(w, s.draft.id)!.revision;
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, phoneId, echoOf(s, { html: '<p>Dinner at eight instead</p>' }));
    const held = row(w, s.draft.id)!;
    assert.equal(
      held.remote_message_id,
      s.messageId,
      'our base did not move to the phone`s version',
    );
    assert.equal(held.revision, revision);
    // Our next upload is still checked against the version we wrote, so the provider answers conflict.
    edit(w, read(w, s.draft.id), fields({ subject: 'Mine' }), true);
    await wait(w, 1);
    assert.equal(w.remoteDrafts.saves.at(-1)!.baseRemoteMessageId, s.messageId);
    assert.ok(read(w, s.draft.id).conflict, 'the phone`s edit is asked about, not overwritten');
    assert.equal(w.remoteDrafts.remote.get(s.remoteDraftId)!.messageId, phoneId, 'and still there');
  }));

test('supersedes: a changed subject under our Message-ID is not our echo either', () =>
  world(async w => {
    const s = await synced(w);
    fact(w, s.remoteDraftId, 'msg-new', echoOf(s, { subject: 'Changed on the phone' }));
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId);
  }));

test('supersedes: with no body to compare, a finished upload`s Message-ID alone does not move the base', () =>
  world(async w => {
    const s = await synced(w);
    const { html: _html, ...bare } = echoOf(s);
    fact(w, s.remoteDraftId, 'msg-new', bare);
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId);
  }));

test('supersedes: an id this device only wrote earlier (in wrote) counts as the base too', () =>
  world(async w => {
    const s = await synced(w);
    const second = edit(w, s.draft, fields({ subject: 'Second' }), true);
    await wait(w, 1);
    const now = row(w, second.id)!;
    assert.notEqual(now.remote_message_id, s.messageId, 'the copy has a newer message id');
    fact(
      w,
      s.remoteDraftId,
      'msg-newer',
      echoOf(
        { internetId: now.remote_internet_id!, messageId: s.messageId },
        { subject: 'Second' },
      ),
    );
    assert.equal(row(w, second.id)!.remote_message_id, 'msg-newer');
    assert.equal(read(w, second.id).conflict, undefined);
  }));

test('supersedes: a fact that replaces our base under a Message-ID we never wrote is a phone edit', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    fact(w, s.remoteDraftId, 'msg-phone', {
      subject: 'Theirs',
      html: '<p>Phone body</p>',
      internetId: THEIRS_ID,
      supersedes: [s.messageId],
    });
    const c = syncOf(w, s.draft.id).conflict;
    assert.equal(c?.theirsMessageId, 'msg-phone', 'the choice is asked');
    assert.equal(c?.complete, true);
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId, 'our base is not advanced');
  }));

test('supersedes: the same replacement with no Message-ID at all is a phone edit as well', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    fact(w, s.remoteDraftId, 'msg-phone', { supersedes: [s.messageId] });
    assert.equal(syncOf(w, s.draft.id).conflict?.theirsMessageId, 'msg-phone');
  }));

test('supersedes: a clean draft is replaced by a phone edit that supersedes its base', () =>
  world(async w => {
    const s = await synced(w);
    fact(w, s.remoteDraftId, 'msg-phone', {
      subject: 'Theirs',
      html: '<p>Phone body</p>',
      internetId: THEIRS_ID,
      supersedes: [s.messageId],
    });
    const d = read(w, s.draft.id);
    assert.equal(d.html, '<p>Phone body</p>');
    assert.equal(d.conflict, undefined);
  }));

test('supersedes: an upload in flight whose echo arrives first keeps the later result', () =>
  world(async w => {
    const s = await synced(w);
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    edit(w, s.draft, fields({ subject: 'Second' }), true);
    await wait(w, 1);
    const uploading = w.remoteDrafts.saves.at(-1)!;
    fact(w, s.remoteDraftId, 'msg-early', {
      internetId: uploading.internetId,
      supersedes: [s.messageId],
    });
    assert.equal(row(w, s.draft.id)!.remote_message_id, 'msg-early');
    g.open();
    await wait(w, 1);
    assert.equal(read(w, s.draft.id).conflict, undefined);
    assert.equal(read(w, s.draft.id).sync, 'synced');
    assert.equal(
      row(w, s.draft.id)!.remote_message_id,
      w.remoteDrafts.remote.get(s.remoteDraftId)!.messageId,
    );
  }));

test('supersedes: our Message-ID on a fact that does not replace our base moves nothing', () =>
  world(async w => {
    const s = await synced(w);
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    edit(w, s.draft, fields({ subject: 'Second' }), true);
    await wait(w, 1);
    const uploading = w.remoteDrafts.saves.at(-1)!;
    fact(w, s.remoteDraftId, 'msg-x', {
      internetId: uploading.internetId,
      supersedes: ['some-other-message'],
    });
    assert.equal(
      row(w, s.draft.id)!.remote_message_id,
      s.messageId,
      'not a replacement of our base',
    );
    g.open();
    await wait(w, 1);
    assert.equal(read(w, s.draft.id).conflict, undefined);
  }));

test('supersedes: an upload explains ONE move of the base; a phone edit that keeps the Message-ID afterwards is not ours', () =>
  world(async w => {
    const s = await synced(w);
    // The reply to our update is lost: `uploading` stays set and the retry waits.
    w.remoteDrafts.script.push({ result: 'lost' });
    edit(w, s.draft, fields({ subject: 'Second' }), true);
    await wait(w, 1);
    const attempt = w.remoteDrafts.saves.at(-1)!;
    assert.equal(attempt.baseRemoteMessageId, s.messageId);
    // First hop: our update landed as C, under the attempt's Message-ID. That is the move the attempt explains.
    fact(w, s.remoteDraftId, 'msg-c', {
      internetId: attempt.internetId,
      supersedes: [s.messageId],
      subject: 'Second',
      html: '<p>Lunch at noon?</p>',
    });
    assert.equal(row(w, s.draft.id)!.remote_message_id, 'msg-c', 'the first hop moved the base');
    // Second hop: the phone edits C into D and keeps the Message-ID. The attempt has used its move.
    fact(w, s.remoteDraftId, 'msg-d', {
      internetId: attempt.internetId,
      supersedes: ['msg-c'],
      subject: 'Phone edit',
      html: '<p>Phone body</p>',
    });
    assert.equal(
      row(w, s.draft.id)!.remote_message_id,
      'msg-c',
      "the phone's edit did not move the base",
    );
    // The retry therefore goes out against C, not D: a provider holding D answers with a conflict, not an overwrite.
    await wait(w, 5 * 60 * SEC);
    assert.equal(w.remoteDrafts.saves.at(-1)!.baseRemoteMessageId, 'msg-c');
    assert.notEqual(w.remoteDrafts.saves.at(-1)!.baseRemoteMessageId, 'msg-d');
  }));

test('body: an oversize text is dropped before it is escaped or wrapped, and the draft stays snippet-only', () =>
  world(async w => {
    fact(w, 'big', 'msg-big', { text: '&'.repeat(CAP + 1), internetId: '<big@phone.example>' });
    assert.equal(syncOf(w, `${ACCOUNT}:big`).incomplete, true);
    // A text at the limit that grows past it when escaped is also incomplete (the stored body is what counts).
    fact(w, 'big2', 'msg-big2', { text: '&'.repeat(CAP), internetId: '<big2@phone.example>' });
    assert.equal(syncOf(w, `${ACCOUNT}:big2`).incomplete, true);
  }));

// ---------------------------------------------------------------- GAP 2: DraftUpload.supersedes

/** A first create whose reply is lost after the copy landed, then an edit: the next create is a new revision. */
async function createThenEdit(w: World) {
  w.remoteDrafts.script.push({ result: 'landedLost' });
  const d = create(w, fields());
  await wait(w, 5 * SEC);
  const first = w.remoteDrafts.saves.at(-1)!;
  assert.equal(first.supersedes, undefined, 'nothing earlier on the first create');
  assert.equal(row(w, d.id)!.remote_draft_id, null, 'its reply was lost');
  edit(w, read(w, d.id), fields({ subject: 'Second' }), true);
  await wait(w, 5 * SEC);
  return { d, first };
}

test('gap 2: a create after an unanswered create offers the earlier Message-ID as supersedes', () =>
  world(async w => {
    const { first } = await createThenEdit(w);
    const second = w.remoteDrafts.saves.at(-1)!;
    assert.notEqual(second.internetId, first.internetId);
    assert.deepEqual(second.supersedes, [first.internetId]);
    assert.equal(second.remoteDraftId, undefined);
  }));

test('gap 2: a provider that honours supersedes replaces the copy, so no second remote draft', () =>
  world(async w => {
    w.remoteDrafts.state.honourSupersedes = true;
    const { d } = await createThenEdit(w);
    assert.equal(w.remoteDrafts.remote.size, 1, 'one remote draft');
    assert.equal(row(w, d.id)!.remote_draft_id, 'rd1');
    assert.equal(read(w, d.id).conflict, undefined);
  }));

test('gap 2: a provider that ignores supersedes leaves the old behaviour (a duplicate, never a loss)', () =>
  world(async w => {
    await createThenEdit(w);
    assert.equal(w.remoteDrafts.remote.size, 2);
  }));

test('gap 2: an update carries no supersedes, and a retry of the same revision never lists its own Message-ID', () =>
  world(async w => {
    w.remoteDrafts.script.push({ result: 'lost' });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    await wait(w, 5 * 60 * SEC);
    const sameRevision = w.remoteDrafts.saves.filter(save => save.revision === d.revision);
    assert.ok(sameRevision.length >= 2, 'it was retried');
    assert.ok(sameRevision.every(save => save.supersedes === undefined));
    edit(w, read(w, d.id), fields({ subject: 'Updated' }), true);
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.at(-1)!.remoteDraftId !== undefined, true, 'now an update');
    assert.equal(w.remoteDrafts.saves.at(-1)!.supersedes, undefined);
  }));

test('gap 2: the list is cleared once a create is answered', () =>
  world(async w => {
    const { d } = await createThenEdit(w);
    assert.equal((syncOf(w, d.id) as { earlier?: string[] }).earlier, undefined);
  }));
