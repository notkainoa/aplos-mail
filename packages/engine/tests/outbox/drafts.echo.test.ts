import test from 'node:test';
import assert from 'node:assert/strict';
import type { CommitInput } from '../../src/store';
import { ACCOUNT, fields, gate, SEC } from './helpers';
import {
  create,
  edit,
  fact,
  next,
  read,
  row,
  service,
  syncOf,
  synced,
  wait,
  world,
  type Fact,
} from './drafts.ports.kit';

/**
 * End-to-end review HIGH 1 (probe P4a): a provider that KEEPS our Message-ID across a phone edit (Gmail is believed to)
 * reports the edit under a new message id and our Message-ID. That is no echo of our upload unless its content is ours.
 */

const OWN: Fact = {
  subject: 'Lunch',
  html: '<p>Lunch at noon?</p>',
  to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
};
const PHONE: Fact = { ...OWN, subject: 'Phone edit', html: '<p>PHONE TEXT</p>' };
const refused = (fn: () => unknown) => assert.throws(fn, /./);

test('echo: a phone edit under our Message-ID with a new message id is shown as a conflict with both bodies', () =>
  world(async w => {
    const s = await synced(w);
    // The owner has an unsent local edit when the phone's edit (same Message-ID, new message id, body delivered) arrives.
    edit(w, s.draft, fields({ subject: 'Mine' }), false);
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, phoneId, { ...PHONE, internetId: s.internetId });
    const d = read(w, s.draft.id);
    assert.ok(d.conflict, 'the edit is not dropped as an echo');
    assert.equal(syncOf(w, s.draft.id).conflict?.complete, true, 'and both bodies are available');
    service(w).resolve(next(), s.draft.id, 'takeTheirs');
    assert.match(read(w, s.draft.id).html, /PHONE TEXT/);
  }));

test('echo: the same phone edit on a clean draft is shown, not hidden', () =>
  world(async w => {
    const s = await synced(w);
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, phoneId, { ...PHONE, internetId: s.internetId });
    assert.match(read(w, s.draft.id).html, /PHONE TEXT/);
    assert.equal(row(w, s.draft.id)!.remote_message_id, phoneId);
  }));

test('echo: a report with no body under our Message-ID and a new message id is not taken as our echo', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }), false);
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, phoneId, { internetId: s.internetId });
    assert.ok(read(w, s.draft.id).conflict, 'the owner is asked');
  }));

test('echo (probe P4a): when the other version never arrived whole, keep mine makes a NEW copy and the phone edit survives', () =>
  world(async w => {
    const s = await synced(w);
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    // History never reports the phone edit again; the owner edits and the upload meets the changed copy.
    edit(w, s.draft, fields({ subject: 'Mine' }), true);
    await wait(w, 5 * SEC);
    const d = read(w, s.draft.id);
    assert.ok(d.conflict, 'the upload found the copy changed');
    refused(() => service(w).resolve(next(), s.draft.id, 'takeTheirs'));
    service(w).resolve(next(), s.draft.id, 'keepMine');
    await w.settle();
    const last = w.remoteDrafts.saves.at(-1)!;
    assert.equal(
      last.remoteDraftId,
      undefined,
      'a new copy, not an update over the unseen version',
    );
    assert.equal(
      w.remoteDrafts.remote.get(s.remoteDraftId)?.messageId,
      phoneId,
      'the phone edit is untouched',
    );
    assert.equal(read(w, s.draft.id).sync, 'synced');
  }));

test('echo: our own copy still counts as our echo when its content is ours', () =>
  world(async w => {
    const s = await synced(w);
    // History re-reports our own copy under a new message id (a normalised re-save) with the same content.
    fact(w, s.remoteDraftId, 'msg-same', { ...OWN, internetId: s.internetId });
    assert.equal(read(w, s.draft.id).conflict, undefined);
    assert.match(read(w, s.draft.id).html, /Lunch at noon/);
  }));

test("log: a removal with no draft row that keeps failing is logged without the provider's draft id", () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    service(w).destroy(next(), d.id);
    w.first.store.commit({
      opId: next(),
      origin: 'system',
      writes: [{ kind: 'draftDelete', id: d.id, at: w.clock.now(), final: true }],
    });
    for (let i = 0; i < 5; i++) w.remoteDrafts.removeScript.push({ result: 'notSent' });
    g.open();
    await wait(w, 5 * 60 * SEC);
    const failed = w.events('draft.sync_failed');
    assert.ok(failed.length > 0, 'the failure was logged');
    for (const r of failed) {
      const text = JSON.stringify(r);
      assert.equal(text.includes('rd1'), false, 'the provider draft id is not written');
      assert.match(String(r.data?.draft), /^r[0-9a-f]{16}$/);
    }
  }));

test('a send that is done but whose clean-up has not run still pins the draft: a phone edit is held, then shown as a draft of its own', () =>
  world(async w => {
    const s = await synced(w);
    // The hidden-row clean-up is held up, so the submission is `sent` at the current revision but the draft row remains.
    for (let i = 0; i < 20; i++)
      w.faults.push((input: CommitInput) => input.writes[0]?.kind === 'draftDelete');
    await w.send(w.first, s.draft.id, { revision: read(w, s.draft.id).revision });
    await wait(w, 15 * SEC);
    const states = w.first.store.read(q =>
      q.all<{ state: string }>('SELECT state FROM submissions WHERE draft_id = ?', s.draft.id),
    );
    assert.deepEqual(
      states.map(r => r.state),
      ['sent'],
    );
    const revision = row(w, s.draft.id)!.revision;
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, phoneId, { ...PHONE, internetId: 'theirs-id@phone.example' });
    assert.equal(
      row(w, s.draft.id)!.revision,
      revision,
      'the sent draft was not rewritten under its send',
    );
    assert.equal(
      typeof (syncOf(w, s.draft.id) as { changedElsewhere?: unknown }).changedElsewhere,
      'object',
      'the report is held',
    );
    w.faults.length = 0;
    await wait(w, 30 * SEC);
    assert.match(
      read(w, `${ACCOUNT}:${s.remoteDraftId}`).html,
      /PHONE TEXT/,
      'and shown once the draft is gone',
    );
  }));

// ---------------------------------------------------------------- review of the isEcho change (Opus)

test('echo: our own update reported with no body BEFORE its ack opens no lasting conflict: the ack ends it', () =>
  world(async w => {
    const s = await synced(w);
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    edit(w, s.draft, fields({ subject: 'Second' }), true);
    await wait(w, 1);
    const upload = w.remoteDrafts.saves.at(-1)!;
    // History reports the update's new message id (the fake gives the next one, `msg3`) with no body, before the ack.
    fact(w, s.remoteDraftId, 'msg3', { internetId: upload.internetId });
    assert.ok(read(w, s.draft.id).conflict, 'asked for now: the report cannot be proven ours');
    g.open();
    await wait(w, 1);
    assert.equal(
      read(w, s.draft.id).conflict,
      undefined,
      'the ack named that very copy: it was ours',
    );
    assert.equal(row(w, s.draft.id)!.remote_message_id, 'msg3');
    assert.equal(read(w, s.draft.id).sync, 'synced');
  }));

test('echo: after keep mine made a new copy, a later report of the old copy under our Message-ID is shown, not swallowed', () =>
  world(async w => {
    const s = await synced(w);
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    edit(w, s.draft, fields({ subject: 'Mine' }), true);
    await wait(w, 5 * SEC);
    assert.ok(read(w, s.draft.id).conflict);
    service(w).resolve(next(), s.draft.id, 'keepMine');
    await w.settle();
    assert.notEqual(row(w, s.draft.id)!.remote_draft_id, s.remoteDraftId, 'a new copy');
    // History now reports the phone's version of the OLD copy, with its body, under our Message-ID.
    fact(w, s.remoteDraftId, phoneId, { ...PHONE, internetId: s.internetId });
    assert.match(
      read(w, `${ACCOUNT}:${s.remoteDraftId}`).html,
      /PHONE TEXT/,
      'the phone edit is shown',
    );
  }));

test('resurface: a held phone version of a draft that came from the phone gets its own id, and a send does not pin it', () =>
  world(async w => {
    // A draft written on the phone, complete, then sent from here unchanged.
    fact(w, 'rd-p', 'pm-1', { ...OWN, internetId: '<p1@phone.example>' });
    const id = `${ACCOUNT}:rd-p`;
    for (let i = 0; i < 20; i++)
      w.faults.push((input: CommitInput) => input.writes[0]?.kind === 'draftDelete');
    await w.send(w.first, id, { revision: read(w, id).revision });
    await wait(w, 15 * SEC);
    fact(w, 'rd-p', 'pm-2', { ...PHONE, internetId: '<p1@phone.example>' });
    w.faults.length = 0;
    await wait(w, 30 * SEC);
    const rows = w.first.store.read(q =>
      q.all<{ id: string; origin: string }>(
        'SELECT id, origin FROM drafts WHERE account_id = ?',
        ACCOUNT,
      ),
    );
    assert.equal(rows.length, 1, 'the sent draft is gone and the phone version shows once');
    assert.match(rows[0]!.id, /^.+:rd-p~\d+$/, "under a fresh id, not the sent draft's");
    assert.match(read(w, rows[0]!.id).html, /PHONE TEXT/);
  }));

// ---------------------------------------------------------------- the 17:00 review of #194

test('echo: after keep mine on a version that was never shown whole, that version is shown as a remote draft of its own', () =>
  world(async w => {
    const s = await synced(w);
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    // Our edit is pending when history reports the phone's edit with no body (a snippet): a conflict, incomplete.
    edit(w, s.draft, fields({ subject: 'Mine' }), false);
    fact(w, s.remoteDraftId, phoneId, {
      subject: 'Phone subject',
      internetId: '<phone@phone.example>',
    });
    assert.equal(syncOf(w, s.draft.id).conflict?.complete, false);
    service(w).resolve(next(), s.draft.id, 'keepMine');
    await w.settle();
    const shown = read(w, `${ACCOUNT}:${s.remoteDraftId}`);
    assert.equal(
      shown.subject,
      'Phone subject',
      'the version keep mine stepped away from is visible',
    );
    assert.equal(syncOf(w, `${ACCOUNT}:${s.remoteDraftId}`).incomplete, true);
    // Discarding it never deletes the phone's copy from the provider (an incomplete draft's copy is not ours to delete).
    service(w).destroy(next(), `${ACCOUNT}:${s.remoteDraftId}`);
    await wait(w, 60 * SEC);
    assert.equal(w.remoteDrafts.remote.get(s.remoteDraftId)?.messageId, phoneId);
  }));

test('echo: a REAL conflict survives an ack that names another copy; only an ack for the conflicting copy itself ends it', () =>
  world(async w => {
    const s = await synced(w);
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    edit(w, s.draft, fields({ subject: 'Second' }), true);
    await wait(w, 1);
    const upload = w.remoteDrafts.saves.at(-1)!;
    // The phone edits (another message id, another Message-ID, a body): a real conflict while our upload runs.
    fact(w, s.remoteDraftId, 'msg-phone', { ...PHONE, internetId: '<phone@phone.example>' });
    assert.ok(read(w, s.draft.id).conflict);
    g.open();
    await wait(w, 1);
    // Our ack names OUR copy (msg3), not the phone's: the conflict about the phone's version stays.
    assert.ok(read(w, s.draft.id).conflict, 'the phone version is still asked about');
    assert.equal(syncOf(w, s.draft.id).conflict?.theirsMessageId, 'msg-phone');
    assert.notEqual(upload.internetId, '<phone@phone.example>');
  }));

test('fingerprint: the same content as the writer produces it hashes the same (line breaks, subject spacing)', async () => {
  const { fingerprintOf, isEmpty } = await import('../../src/outbox/draft-state');
  const base = fields({ subject: 'Lunch  at noon ', html: '<p>a</p>\n<p>b</p>\n' });
  const back = fields({ subject: 'Lunch at noon', html: '<p>a</p>\r\n<p>b</p>\r\n' });
  assert.equal(fingerprintOf(base), fingerprintOf(back));
  assert.equal(
    fingerprintOf(fields({ html: '<p>x</p>\r' })),
    fingerprintOf(fields({ html: '<p>x</p>' })),
  );
  // Real differences still differ: text, an inner break, a space in the html, a different subject.
  assert.notEqual(
    fingerprintOf(fields({ html: '<p>a</p>' })),
    fingerprintOf(fields({ html: '<p>b</p>' })),
  );
  assert.notEqual(
    fingerprintOf(fields({ html: '<p>a</p>\n<p>b</p>' })),
    fingerprintOf(fields({ html: '<p>a</p><p>b</p>' })),
  );
  assert.notEqual(
    fingerprintOf(fields({ html: '<p>a</p> ' })),
    fingerprintOf(fields({ html: '<p>a</p>' })),
  );
  assert.notEqual(fingerprintOf(fields({ subject: 'A' })), fingerprintOf(fields({ subject: 'B' })));
  // An empty body and the trivially-empty markup adapters give it back as hash the same.
  assert.equal(fingerprintOf(fields({ html: '' })), fingerprintOf(fields({ html: '<p></p>' })));
  assert.equal(
    fingerprintOf(fields({ html: '<p></p>' })),
    fingerprintOf(fields({ html: '<div><br></div>' })),
  );
  // The same rule isEmpty uses: a non-breaking space is no content either.
  assert.equal(
    fingerprintOf(fields({ html: '<p>&nbsp;</p>' })),
    fingerprintOf(fields({ html: '' })),
  );
  // A body with real content still differs from empty.
  assert.notEqual(fingerprintOf(fields({ html: '<p>x</p>' })), fingerprintOf(fields({ html: '' })));
  // And a body that is only text-less still differs: an image, a rule, a table is content an
  // edit can add — never an empty body, or the proof would swallow it as our echo.
  for (const markup of [
    '<img src="https://x/y.png">',
    '<p><img src="data:image/png;base64,AAAA"></p>',
    '<hr>',
    '<table><tr><td></td></tr></table>',
    '<a href="https://x"></a>',
    '<iframe src="https://x/doc"></iframe>',
    '<input value="hunter2">',
    '<video src="https://x/v.mp4"></video>',
  ])
    assert.notEqual(
      fingerprintOf(fields({ html: markup })),
      fingerprintOf(fields({ html: '' })),
      `${markup} is content, not an empty body`,
    );
  // Entity text and zero-width marks are content, not empty markup.
  for (const markup of ['<p>&amp;</p>', '<p>&lt;</p>', '<p>\u200b</p>', '<p><b>&gt;</b></p>'])
    assert.notEqual(
      fingerprintOf(fields({ html: markup })),
      fingerprintOf(fields({ html: '' })),
      `${markup} is content, not an empty body`,
    );
  // Decorative attributes are ignored: a styled-but-empty p is still empty.
  assert.equal(
    fingerprintOf(fields({ html: '<p style="color:red"></p>' })),
    fingerprintOf(fields({ html: '' })),
  );
  // But a reference attribute is content wherever it sits.
  for (const markup of [
    '<div style="background-image:url(cid:x.png)"></div>',
    '<body background="cid:logo.png"></body>',
    '<span style="display:block;background:url(http://t/p.gif)"></span>',
    '<p poster="x.png"></p>',
  ])
    assert.notEqual(
      fingerprintOf(fields({ html: markup })),
      fingerprintOf(fields({ html: '' })),
      `${markup} references content`,
    );
  // Emptied-editor containers suppress like <p></p>.
  for (const markup of [
    '<blockquote><br></blockquote>',
    '<h2><br></h2>',
    '<pre></pre>',
    '<section></section>',
    '<dl><dt></dt><dd></dd></dl>',
  ])
    assert.equal(
      fingerprintOf(fields({ html: markup })),
      fingerprintOf(fields({ html: '' })),
      `${markup} is trivially empty`,
    );
  // isEmpty shares the rule: an image-only draft is content and does upload.
  assert.equal(
    isEmpty(
      fields({ to: [], cc: [], bcc: [], attachments: [], subject: '', html: '<img src="x">' }),
    ),
    false,
  );
  assert.equal(
    isEmpty(fields({ to: [], cc: [], bcc: [], attachments: [], subject: '', html: '<p></p>' })),
    true,
  );
  // A long run of line breaks costs nothing.
  const start = performance.now();
  fingerprintOf(fields({ html: `x${'\r\n'.repeat(500_000)}y` }));
  assert.ok(performance.now() - start < 500);
});
