/**
 * prov-gmail draft facts through the engine's own recognition (`outboxExtension`, `draft-writes.ts` `showsEveryField`):
 * the fact the Gmail adapter reports for the copy of our own upload moves the row's base (our echo), and the same copy
 * with a Bcc, which our upload never carries, is another device's edit. The engine's world and kit come from its tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { RemoteDraftFact } from '@aplos/engine/ports';
import { createFaultInjector } from '@aplos/emulators';
// Type-only: the engine's modules augment `EngineServices`; the kit below needs all of them in this project.
import type {} from '../../../../packages/engine/src/index';
import { messageWrite } from '../../../../packages/engine/src/sync/facts';
import { ACCOUNT, fields } from '../../../../packages/engine/tests/outbox/helpers';
import {
  read,
  row,
  synced,
  syncOf,
  world,
} from '../../../../packages/engine/tests/outbox/drafts.ports.kit';
import { rig } from './harness';

// The engine world's account address; the copy must be sent from it.
const OWNER = 'owner@mail.example';

async function gmailFact(internetId: string, headers: Record<string, string>) {
  const faults = createFaultInjector();
  const r = await rig({ threads: 60, emulator: { faults } });
  await r.drive({
    until: () => r.store.states.get('window:inbox')?.phase === 'done',
    maxSteps: 300,
  });
  await r.clock.advance(60_000);
  const draft = r.emu.mailbox.createDraftElsewhere({
    from: OWNER,
    to: ['Jordan <jordan@mail.example>'],
    subject: 'Lunch',
    html: '<p>Lunch at noon?</p>',
    messageId: internetId.replace(/^<|>$/g, ''),
    headers,
  });
  const from = r.store.commits.length;
  for (let i = 0; i < 50; i++) {
    await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
    if (!/^pass:/.test(r.store.states.get('history')?.phase ?? '')) break;
  }
  const facts = r.store.commits.slice(from).flatMap(c => c.result.drafts ?? []);
  return facts.find(f => f.remoteDraftId === draft.draftId) as RemoteDraftFact;
}

/** What the actor commits for the fact (`stepWrites` -> `draftWrite`), with the ids that tie it to the engine's row. */
function committed(f: RemoteDraftFact, own: { remoteDraftId: string; messageId: string }) {
  const { kind: _k, accountId: _a, ...message } = messageWrite(ACCOUNT, OWNER, f.message!);
  return {
    kind: 'remoteDraft' as const,
    accountId: ACCOUNT,
    remoteDraftId: own.remoteDraftId,
    remoteMessageId: f.remoteMessageId,
    changedAt: f.changedAt,
    ...(f.internetId ? { internetId: f.internetId } : {}),
    ...(f.html !== undefined ? { html: f.html } : {}),
    ...(f.text !== undefined ? { text: f.text } : {}),
    supersedes: [own.messageId],
    message,
  };
}

test('prov-gmail-drafts echo: the fact for the copy of our own upload is recognised by the engine; a copy with a Bcc is not', () =>
  world(async w => {
    const s = await synced(w, fields());
    const echo = await gmailFact(s.internetId, {});
    assert.deepEqual(echo.message?.bcc, []);
    w.first.store.commit({
      opId: 'echo-1',
      origin: 'sync',
      writes: [committed(echo, s)],
    });
    assert.equal(row(w, s.draft.id)!.remote_message_id, echo.remoteMessageId, 'the base moved');
    assert.equal(read(w, s.draft.id).conflict, undefined);
    assert.ok(syncOf(w, s.draft.id).wrote?.includes(echo.remoteMessageId));
  }));

test("prov-gmail-drafts echo: the same copy with a Bcc header is another device's edit, never our echo", () =>
  world(async w => {
    const s = await synced(w, fields());
    const other = await gmailFact(s.internetId, { Bcc: 'quiet@mail.example' });
    assert.equal(other.message?.bcc?.length, 1);
    w.first.store.commit({
      opId: 'echo-2',
      origin: 'sync',
      writes: [committed(other, s)],
    });
    assert.notEqual(
      row(w, s.draft.id)!.remote_message_id,
      other.remoteMessageId,
      'the base did not move to it',
    );
  }));

// ---- a phone draft must keep its recipients and subject when the engine takes the delivered body ----

/** What the actor commits for a fact that is not our echo: a plain `remoteDraft` write with the message's metadata. */
function committedForeign(f: RemoteDraftFact, remoteDraftId: string) {
  const { kind: _k, accountId: _a, ...message } = messageWrite(ACCOUNT, OWNER, f.message!);
  return {
    kind: 'remoteDraft' as const,
    accountId: ACCOUNT,
    remoteDraftId,
    remoteMessageId: f.remoteMessageId,
    changedAt: f.changedAt,
    ...(f.internetId ? { internetId: f.internetId } : {}),
    ...(f.html !== undefined ? { html: f.html } : {}),
    ...(f.text !== undefined ? { text: f.text } : {}),
    message,
  };
}

test("prov-gmail-drafts echo: a phone draft's delivered body arrives with its recipients and subject, complete", () =>
  world(async w => {
    const phone = await gmailFact('<phone-new@mail.example>', {});
    assert.ok(phone.html, 'the adapter delivered the body');
    assert.ok(phone.message, 'and the message with it');
    w.first.store.commit({
      opId: 'phone-1',
      origin: 'sync',
      writes: [committedForeign(phone, phone.remoteDraftId)],
    });
    const id = `${ACCOUNT}:${phone.remoteDraftId}`;
    const d = read(w, id);
    assert.deepEqual(
      d.to.map(a => a.address),
      ['jordan@mail.example'],
    );
    assert.equal(d.subject, 'Lunch');
    assert.match(d.html, /Lunch at noon\?/);
    assert.equal(syncOf(w, id).incomplete, undefined, 'complete');
  }));

test("prov-gmail-drafts echo: another device's edit of a clean draft replaces it with the phone's recipients and subject intact", () =>
  world(async w => {
    const s = await synced(w, fields());
    const edit = await gmailFact('<phone-edit@mail.example>', {});
    w.first.store.commit({
      opId: 'phone-2',
      origin: 'sync',
      writes: [{ ...committedForeign(edit, s.remoteDraftId), supersedes: [s.messageId] }],
    });
    assert.equal(row(w, s.draft.id)!.remote_message_id, edit.remoteMessageId, 'replaced');
    const d = read(w, s.draft.id);
    assert.deepEqual(
      d.to.map(a => a.address),
      ['jordan@mail.example'],
    );
    assert.equal(d.subject, 'Lunch');
    assert.match(d.html, /Lunch at noon\?/);
  }));
