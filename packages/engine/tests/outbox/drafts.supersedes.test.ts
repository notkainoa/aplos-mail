import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftFields as DraftFieldsSchema, type DraftFields } from '@aplos/contract';
import { DRAFT_CONTENT_FIELDS } from '../../src/outbox/draft-state';
import { ACCOUNT, fields, gate, SEC, type World } from './helpers';
import {
  CAP,
  create,
  edit,
  fact,
  next,
  read,
  row,
  service,
  syncOf,
  synced,
  THEIRS_ID,
  wait,
  world,
  type Fact,
} from './drafts.ports.kit';

/** Draft port gap `supersedes`, and the remote body cap, the rules for what a remote fact may move or replace. */

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
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, phoneId, echoOf(s, { html: '<p>Dinner at eight instead</p>' }));
    // The phone's edit keeps our Message-ID, but its content is not ours: it is shown, like any other device's edit.
    const held = row(w, s.draft.id)!;
    assert.equal(held.remote_message_id, phoneId, 'the draft now holds the phone`s version');
    assert.match(read(w, s.draft.id).html, /Dinner at eight instead/);
    assert.equal(read(w, s.draft.id).conflict, undefined, 'a clean draft takes it silently');
    // Our next upload is checked against that version, which the owner has seen, and goes through.
    edit(w, read(w, s.draft.id), fields({ subject: 'Mine' }), true);
    await wait(w, 1);
    assert.equal(w.remoteDrafts.saves.at(-1)!.baseRemoteMessageId, phoneId);
    assert.equal(read(w, s.draft.id).conflict, undefined);
  }));

test('supersedes: a changed subject under our Message-ID is not our echo either', () =>
  world(async w => {
    const s = await synced(w);
    fact(w, s.remoteDraftId, 'msg-new', echoOf(s, { subject: 'Changed on the phone' }));
    assert.equal(row(w, s.draft.id)!.remote_message_id, 'msg-new', 'shown as the phone`s edit');
    assert.equal(read(w, s.draft.id).subject, 'Changed on the phone');
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
    fact(
      w,
      s.remoteDraftId,
      'msg-early',
      echoOf({ internetId: uploading.internetId, messageId: s.messageId }, { subject: 'Second' }),
    );
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
    // A report with no body under our running upload's Message-ID is not proof of our own copy: the draft was edited
    // meanwhile, so the owner is asked rather than the report guessed at.
    assert.ok(read(w, s.draft.id).conflict);
  }));

test('supersedes: a running upload explains a fact only by its content; a phone edit that keeps the Message-ID afterwards is not ours', () =>
  world(async w => {
    const s = await synced(w);
    // The reply to our update is lost: `uploading` stays set and the retry waits.
    w.remoteDrafts.script.push({ result: 'lost' });
    edit(w, s.draft, fields({ subject: 'Second' }), true);
    await wait(w, 1);
    const attempt = w.remoteDrafts.saves.at(-1)!;
    assert.equal(attempt.baseRemoteMessageId, s.messageId);
    const ours = echoOf(
      { internetId: attempt.internetId, messageId: s.messageId },
      { subject: 'Second' },
    );
    // First hop: our update landed as C, with the content the attempt sends.
    fact(w, s.remoteDraftId, 'msg-c', ours);
    assert.equal(row(w, s.draft.id)!.remote_message_id, 'msg-c', 'our content moved the base');
    // The phone edits C into D and keeps the Message-ID.
    fact(w, s.remoteDraftId, 'msg-d', {
      ...ours,
      supersedes: ['msg-c'],
      subject: 'Phone edit',
      html: '<p>Phone body</p>',
    });
    assert.equal(
      row(w, s.draft.id)!.remote_message_id,
      'msg-c',
      "the phone's edit did not move the base",
    );
    // The phone's edit is shown to the owner as a conflict (it is no echo), and nothing is uploaded over it.
    assert.ok(read(w, s.draft.id).conflict);
    const saves = w.remoteDrafts.saves.length;
    await wait(w, 5 * 60 * SEC);
    assert.equal(w.remoteDrafts.saves.length, saves, 'no retry goes out over the phone`s version');
  }));

test('supersedes: after a retry has started, a phone edit under the same Message-ID still does not move the base', () =>
  world(async w => {
    const s = await synced(w);
    w.remoteDrafts.script.push({ result: 'lost' });
    edit(w, s.draft, fields({ subject: 'Second' }), true);
    await wait(w, 1);
    const attempt = w.remoteDrafts.saves.at(-1)!;
    const ours = echoOf(
      { internetId: attempt.internetId, messageId: s.messageId },
      { subject: 'Second' },
    );
    fact(w, s.remoteDraftId, 'msg-c', ours);
    // The retry starts against C and is still unanswered when the phone's edit arrives.
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    await wait(w, 5 * 60 * SEC);
    assert.equal(w.remoteDrafts.saves.at(-1)!.baseRemoteMessageId, 'msg-c');
    fact(w, s.remoteDraftId, 'msg-d', {
      ...ours,
      supersedes: ['msg-c'],
      subject: 'Phone edit',
      html: '<p>Phone body</p>',
    });
    assert.equal(
      row(w, s.draft.id)!.remote_message_id,
      'msg-c',
      'the retry used no move for the phone',
    );
    g.open();
    await wait(w, 1);
  }));

test('supersedes: one fact that covers both hops (superseding the base and C) is judged by its content too', () =>
  world(async w => {
    const s = await synced(w);
    w.remoteDrafts.script.push({ result: 'lost' });
    edit(w, s.draft, fields({ subject: 'Second' }), true);
    await wait(w, 1);
    const attempt = w.remoteDrafts.saves.at(-1)!;
    const phone: Fact = {
      internetId: attempt.internetId,
      supersedes: [s.messageId, 'msg-c'],
      subject: 'Phone edit',
      html: '<p>Phone body</p>',
    };
    fact(w, s.remoteDraftId, 'msg-d', phone);
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId, 'the base did not jump to D');
  }));

test('supersedes: a fact with no body gets no proof from a running upload', () =>
  world(async w => {
    const s = await synced(w);
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    edit(w, s.draft, fields({ subject: 'Second' }), true);
    await wait(w, 1);
    const uploading = w.remoteDrafts.saves.at(-1)!;
    fact(w, s.remoteDraftId, 'msg-x', {
      internetId: uploading.internetId,
      supersedes: [s.messageId],
    });
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId);
    g.open();
    await wait(w, 1);
  }));

test('body: an html on the message over the limit next to a top-level text that fits leaves the draft incomplete', () =>
  world(async w => {
    fact(w, 'msgbig', 'msg-msgbig', {
      text: 'short text',
      messageHtml: 'x'.repeat(CAP + 1),
      internetId: '<msgbig@phone.example>',
    });
    assert.equal(syncOf(w, `${ACCOUNT}:msgbig`).incomplete, true);
  }));

test('body: html over the limit next to a text that fits leaves the draft incomplete, not built from the text', () =>
  world(async w => {
    fact(w, 'both', 'msg-both', {
      html: 'x'.repeat(CAP + 1),
      text: 'short text',
      internetId: '<both@phone.example>',
    });
    assert.equal(syncOf(w, `${ACCOUNT}:both`).incomplete, true);
  }));

/** What history shows for the copy of an upload of `fields()`: the body and every field, so it can be proven ours. */
const OWN_COPY: Fact = {
  subject: 'Lunch',
  html: '<p>Lunch at noon?</p>',
  to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
};

const WITH_FILE = [{ id: 'att-1', name: 'z.txt', mime: 'text/plain', size: 1 }];

/** A synced draft, then an edit whose reply is lost (`uploading` stays set): the fact of the landed copy comes next. */
async function lostUpdate(w: World, extra: Partial<DraftFields> = {}) {
  const s = await synced(w, fields(extra));
  w.remoteDrafts.script.push({ result: 'lost' });
  edit(w, s.draft, fields({ subject: 'Second', ...extra }), true);
  await wait(w, 1);
  const attempt = w.remoteDrafts.saves.at(-1)!;
  return {
    s,
    attempt,
    ours: echoOf({ internetId: attempt.internetId, messageId: s.messageId }, { subject: 'Second' }),
  };
}

test('supersedes: a draft with an attachment gets no proof from a fact that shows none (the phone may have removed it)', () =>
  world(async w => {
    const { s, ours } = await lostUpdate(w, { attachments: WITH_FILE });
    fact(w, s.remoteDraftId, 'msg-d', ours);
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId, 'the base did not move');
  }));

test('supersedes: a draft with a sign-off gets no proof either', () =>
  world(async w => {
    const { s, ours } = await lostUpdate(w, { signature: true });
    fact(w, s.remoteDraftId, 'msg-d', ours);
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId);
  }));

test('supersedes: a copy that says it has attachments gets no proof', () =>
  world(async w => {
    const { s, ours } = await lostUpdate(w);
    fact(w, s.remoteDraftId, 'msg-d', { ...ours, hasAttachments: true });
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId);
  }));

test('supersedes: the same content from another sender address is not our copy', () =>
  world(async w => {
    const { s, ours } = await lostUpdate(w);
    fact(w, s.remoteDraftId, 'msg-d', { ...ours, from: { address: 'alias@mail.example' } });
    assert.equal(
      row(w, s.draft.id)!.remote_message_id,
      s.messageId,
      'a changed From is a phone edit',
    );
  }));

test('supersedes: a finished upload with an attachment gets no proof from the last synced fingerprint either', () =>
  world(async w => {
    const s = await synced(w, fields({ attachments: WITH_FILE }));
    fact(w, s.remoteDraftId, 'msg-new', echoOf(s));
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId, 'the base did not move');
  }));

test('supersedes: a Bcc-only phone edit is not our copy', () =>
  world(async w => {
    const { s, ours } = await lostUpdate(w);
    fact(w, s.remoteDraftId, 'msg-d', { ...ours, bcc: [{ address: 'hidden@mail.example' }] });
    assert.equal(
      row(w, s.draft.id)!.remote_message_id,
      s.messageId,
      'a changed Bcc is a phone edit',
    );
  }));

test('supersedes: a copy that cannot show Bcc gets no proof (absent is not empty)', () =>
  world(async w => {
    const { s, ours } = await lostUpdate(w);
    fact(w, s.remoteDraftId, 'msg-d', { ...ours, omitBcc: true });
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId);
  }));

test('supersedes: a finished upload (last synced fingerprint) with a Bcc-only difference is not ours either', () =>
  world(async w => {
    const s = await synced(w);
    fact(w, s.remoteDraftId, 'msg-new', {
      ...echoOf(s),
      bcc: [{ address: 'hidden@mail.example' }],
    });
    // Not our copy: shown (the draft holds nothing only-local, so the phone's version replaces it).
    assert.equal(row(w, s.draft.id)!.remote_message_id, 'msg-new');
    assert.deepEqual(read(w, s.draft.id).bcc, [{ address: 'hidden@mail.example' }]);
  }));

/** A clean synced draft that holds something no copy carries, then a phone edit that delivers its body. */
async function phoneEditsTextOf(w: World, extra: Partial<DraftFields>, shows: Partial<Fact> = {}) {
  const s = await synced(w, fields(extra));
  fact(w, s.remoteDraftId, 'msg-phone', {
    subject: 'Lunch',
    html: '<p>Phone wrote this</p>',
    to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
    internetId: '<phone@phone.example>',
    ...shows,
  });
  return s;
}

for (const [name, shows] of [
  ['shows an empty Bcc', {}],
  ['cannot show Bcc', { omitBcc: true as const }],
] as const)
  test(`take-theirs path: a local Bcc is never dropped silently by a phone edit (the copy ${name})`, () =>
    world(async w => {
      const bcc = [{ address: 'quiet@mail.example' }];
      const s = await phoneEditsTextOf(w, { bcc }, shows);
      const d = read(w, s.draft.id);
      assert.deepEqual(d.bcc, bcc, 'our Bcc is untouched');
      assert.ok(d.conflict, 'the owner is asked');
      assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId, 'the base did not move');
    }));

test('take-theirs path: a draft with a sign-off source is not replaced silently either', () =>
  world(async w => {
    const s = await phoneEditsTextOf(w, { signature: true, signatureSource: 'account' });
    const d = read(w, s.draft.id);
    assert.equal(d.signatureSource, 'account');
    assert.ok(d.conflict);
  }));

test('take-theirs path: a draft with my attachment is not replaced silently (the phone may have removed it)', () =>
  world(async w => {
    const s = await phoneEditsTextOf(w, { attachments: WITH_FILE });
    const d = read(w, s.draft.id);
    assert.equal(d.attachments.length, 1, 'my attachment is untouched');
    assert.ok(d.conflict, 'the owner is asked');
  }));

test('take-theirs path: after an attachment-removal conflict, take theirs does not bring the removed file back', () =>
  world(async w => {
    const s = await phoneEditsTextOf(w, { attachments: WITH_FILE });
    assert.ok(read(w, s.draft.id).conflict);
    service(w).resolve(next(), s.draft.id, 'takeTheirs');
    const d = read(w, s.draft.id);
    assert.equal(d.html, '<p>Phone wrote this</p>');
    assert.deepEqual(d.attachments, [], 'the phone removed it');
  }));

test('a draft started on the phone from an alias keeps that sender (so a send refuses loudly), also when refreshed', () =>
  world(async w => {
    const alias = { address: 'alias@mail.example' };
    fact(w, 'rd-phone', 'pm-1', {
      from: alias,
      html: '<p>One</p>',
      internetId: '<p1@phone.example>',
    });
    const id = `${ACCOUNT}:rd-phone`;
    assert.equal(read(w, id).from?.address, 'alias@mail.example');
    fact(w, 'rd-phone', 'pm-2', {
      from: alias,
      html: '<p>Two</p>',
      internetId: '<p2@phone.example>',
    });
    assert.equal(read(w, id).html, '<p>Two</p>');
    assert.equal(
      read(w, id).from?.address,
      'alias@mail.example',
      'still the alias after the refresh',
    );
  }));

test('a draft started on the phone from the account address has no explicit sender', () =>
  world(async w => {
    fact(w, 'rd-own', 'pm-1', { html: '<p>One</p>', internetId: '<o1@phone.example>' });
    assert.equal(read(w, `${ACCOUNT}:rd-own`).from, undefined);
  }));

test('take-theirs path: a phone edit that changes the sender is a conflict, and the copy shows its sender', () =>
  world(async w => {
    const s = await phoneEditsTextOf(w, {}, { from: { address: 'alias@mail.example' } });
    const d = read(w, s.draft.id);
    assert.ok(d.conflict, 'the sender change is not merged silently');
    assert.equal(d.from, undefined, 'our From is untouched');
    const theirs = syncOf(w, s.draft.id).conflict?.theirs as
      { from?: { address: string } } | undefined;
    assert.equal(theirs?.from?.address, 'alias@mail.example', 'their copy shows its sender');
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId);
  }));

test('take-theirs path: a phone edit from the account address is still replaced silently (control)', () =>
  world(async w => {
    const s = await phoneEditsTextOf(w, {}, { from: { address: 'OWNER@mail.example' } });
    const d = read(w, s.draft.id);
    assert.equal(d.html, '<p>Phone wrote this</p>');
    assert.equal(d.conflict, undefined);
  }));

test('take-theirs path: keep mine on a Bcc conflict keeps the Bcc and settles on the phone copy as the base', () =>
  world(async w => {
    const bcc = [{ address: 'quiet@mail.example' }];
    const s = await phoneEditsTextOf(w, { bcc });
    assert.ok(read(w, s.draft.id).conflict);
    service(w).resolve(next(), s.draft.id, 'keepMine');
    const d = read(w, s.draft.id);
    assert.deepEqual(d.bcc, bcc, 'the Bcc stays');
    assert.equal(d.conflict, undefined);
    assert.equal(
      row(w, s.draft.id)!.remote_message_id,
      'msg-phone',
      'the base is the phone copy now',
    );
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.at(-1)!.baseRemoteMessageId, 'msg-phone');
  }));

test('take-theirs path: a clean draft with nothing only we hold is still replaced silently (control)', () =>
  world(async w => {
    const s = await phoneEditsTextOf(w, {});
    const d = read(w, s.draft.id);
    assert.equal(d.html, '<p>Phone wrote this</p>');
    assert.equal(d.conflict, undefined);
  }));

test('closed world: every draft field is classified, and a field that is neither shown nor carried cannot become provable by accident', () => {
  const { carried, shown, notShown } = DRAFT_CONTENT_FIELDS;
  const classified = [...carried, ...shown, ...notShown].sort();
  assert.deepEqual(
    classified,
    Object.keys(DraftFieldsSchema.shape).sort(),
    'a new field must be classified',
  );
  // Adding to these lists is a decision: a notShown field gives no proof unless it is empty on this device, a carried
  // field is one a provider edit cannot change, a shown field must be on the copy.
  assert.deepEqual([...notShown].sort(), ['attachments', 'signature', 'signatureSource']);
  assert.deepEqual([...shown].sort(), ['bcc', 'cc', 'from', 'html', 'subject', 'to']);
  assert.deepEqual([...carried].sort(), ['accountId', 'mode', 'replyToMessageId', 'threadId']);
});

test('supersedes: without those, the same content from our own address still moves the base', () =>
  world(async w => {
    const { s, ours } = await lostUpdate(w);
    fact(w, s.remoteDraftId, 'msg-c', ours);
    assert.equal(row(w, s.draft.id)!.remote_message_id, 'msg-c');
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

// ---------------------------------------------------------------- `earlier` stops when the create is answered

/** A create that nobody answered (the copy landed), then an edit whose create gets `answer`. */
async function answeredCreate(w: World, answer: 'gone' | 'conflictForeign') {
  w.remoteDrafts.script.push({ result: 'landedLost' }, { result: answer });
  const d = create(w, fields());
  await wait(w, 5 * SEC);
  edit(w, read(w, d.id), fields({ subject: 'Second' }), true);
  await wait(w, 5 * SEC);
  return d;
}

for (const answer of ['gone', 'conflictForeign'] as const)
  test(`earlier: a create answered ${answer} ends the list, so keep mine does not offer the dead ids again`, () =>
    world(async w => {
      const d = await answeredCreate(w, answer);
      assert.ok(read(w, d.id).conflict, 'the owner is asked');
      assert.equal(
        w.remoteDrafts.saves.at(-1)!.supersedes?.length,
        1,
        'this create offered the first id',
      );
      service(w).resolve(next(), d.id, 'keepMine');
      await wait(w, 5 * SEC);
      const last = w.remoteDrafts.saves.at(-1)!;
      assert.equal(last.remoteDraftId === undefined || answer !== 'gone', true);
      assert.equal(last.supersedes, undefined, 'nothing is offered a second time');
    }));

test('earlier: a fact that adopts the landed copy ends the list', () =>
  world(async w => {
    w.remoteDrafts.script.push({ result: 'landedLost' }, { result: 'lost' });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const first = w.remoteDrafts.saves.at(-1)!;
    edit(w, read(w, d.id), fields({ subject: 'Second' }), true);
    await wait(w, 1);
    assert.deepEqual((syncOf(w, d.id) as { earlier?: string[] }).earlier, [first.internetId]);
    // History reports the copy of the first create (its reply was lost): this draft adopts it.
    const copy = [...w.remoteDrafts.remote.entries()][0]!;
    fact(w, copy[0], copy[1].messageId, { ...OWN_COPY, internetId: first.internetId });
    assert.equal(row(w, d.id)!.remote_draft_id, copy[0]);
    assert.equal(
      (syncOf(w, d.id) as { earlier?: string[] }).earlier,
      undefined,
      'nothing left to offer',
    );
    await wait(w, 5 * 60 * SEC);
    assert.equal(w.remoteDrafts.saves.at(-1)!.supersedes, undefined);
    assert.equal(w.remoteDrafts.saves.at(-1)!.remoteDraftId, copy[0], 'an update now');
  }));

test('earlier: keeps the newest 5 Message-IDs', () =>
  world(async w => {
    const ids: string[] = [];
    const d = create(w, fields());
    for (let n = 0; n < 7; n += 1) {
      w.remoteDrafts.script.push({ result: 'lost' });
      await wait(w, 5 * SEC);
      ids.push(w.remoteDrafts.saves.at(-1)!.internetId);
      edit(w, read(w, d.id), fields({ subject: `Edit ${n}` }), true);
    }
    await wait(w, 5 * SEC);
    const last = w.remoteDrafts.saves.at(-1)!;
    assert.deepEqual(
      last.supersedes,
      ids.slice(-5),
      'the newest five of the seven earlier attempts',
    );
  }));

test('earlier: survives a restart and is offered again by the retry of the same revision', () =>
  world(async w => {
    w.remoteDrafts.script.push({ result: 'landedLost' }, { result: 'lost' });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const first = w.remoteDrafts.saves.at(-1)!;
    edit(w, read(w, d.id), fields({ subject: 'Second' }), true);
    await wait(w, 5 * SEC);
    w.first.kill();
    w.open();
    await wait(w, 5 * 60 * SEC);
    const again = w.remoteDrafts.saves.at(-1)!;
    assert.deepEqual(again.supersedes, [first.internetId]);
    assert.equal(again.revision, read(w, d.id).revision);
  }));

test('earlier: an edit made while the first create was still running, whose reply is then lost, still lists it', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait, result: 'landedLost' });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const first = w.remoteDrafts.saves.at(-1)!;
    edit(w, read(w, d.id), fields({ subject: 'Second' }), true);
    g.open();
    await wait(w, 5 * SEC);
    const second = w.remoteDrafts.saves.at(-1)!;
    assert.notEqual(second.internetId, first.internetId);
    assert.deepEqual(second.supersedes, [first.internetId]);
  }));

test('earlier: a create the provider refused for good may still have landed, so the next create offers its id', () =>
  world(async w => {
    w.remoteDrafts.script.push({ result: 'notSent' });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const first = w.remoteDrafts.saves.at(-1)!;
    assert.equal(read(w, d.id).sync, 'failed', 'refused for good');
    const kept = syncOf(w, d.id) as { earlier?: string[]; wrote?: string[] };
    assert.deepEqual(kept.earlier, [first.internetId]);
    assert.ok(kept.wrote?.includes(first.internetId), 'and remembered as ours');
    edit(w, read(w, d.id), fields({ subject: 'Second' }), true);
    await wait(w, 5 * SEC);
    assert.deepEqual(w.remoteDrafts.saves.at(-1)!.supersedes, [first.internetId]);
  }));

test('earlier: a refusal that arrives after a fact adopted the copy keeps the adopted draft, with no stale supersedes', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait, result: 'notSent' });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const first = w.remoteDrafts.saves.at(-1)!;
    // While the create runs, history reports its copy under the create's Message-ID: the draft adopts it.
    fact(w, 'rd-landed', 'm-landed', { ...OWN_COPY, internetId: first.internetId });
    assert.equal(row(w, d.id)!.remote_draft_id, 'rd-landed');
    g.open();
    await wait(w, 1);
    const kept = syncOf(w, d.id) as { earlier?: string[]; wrote?: string[] };
    assert.equal(kept.earlier, undefined, 'it has a remote draft, so nothing is offered');
    assert.ok(kept.wrote?.includes(first.internetId) && kept.wrote?.includes('m-landed'));
  }));

test('a conflict raised while an upload runs remembers the attempt`s Message-ID as ours', () =>
  world(async w => {
    const s = await synced(w);
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    edit(w, s.draft, fields({ subject: 'Second' }), true);
    await wait(w, 1);
    const attempt = w.remoteDrafts.saves.at(-1)!;
    // The phone edits while our update runs: the fact conflicts with the local change.
    fact(w, s.remoteDraftId, 'msg-phone', {
      subject: 'Phone',
      html: '<p>Phone</p>',
      internetId: '<phone@phone.example>',
    });
    const kept = syncOf(w, s.draft.id) as { wrote?: string[] };
    assert.ok(kept.wrote?.includes(attempt.internetId), 'the attempt`s id is remembered');
    g.open();
    await wait(w, 1);
  }));
