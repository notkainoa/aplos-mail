/**
 * The BINDING `findSent` contract (#105/#107) on the real Gmail adapter over the Gmail emulator: Sent is searched,
 * a DRAFT never counts, even one that carries the same Message-ID as the mail about to leave.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { sendPortContract } from '../../../../packages/engine/tests/ports/send-port-contract';
import { ACCOUNT, contractHarness, sendWorld, submission } from './send-rig';

sendPortContract('gmail adapter on the Gmail emulator', () => contractHarness());
sendPortContract('gmail adapter on the Gmail emulator, paced by its GmailPacer', () =>
  contractHarness({ pace: true }),
);

const AT = Date.UTC(2026, 9, 28, 9, 0, 0);
const ID = '<contract-shared-1@mail.example>';

test('gmail: a draft and a Sent copy share one Message-ID: findSent returns the Sent copy, never the draft', async () => {
  const world = await sendWorld();
  const draft = world.emu.mailbox.createDraftElsewhere({
    to: ['friend@example.test'],
    subject: 'Draft copy',
    messageId: 'contract-shared-1@mail.example',
    internalDate: AT,
  });
  const sent = world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    subject: 'Sent copy',
    messageId: 'contract-shared-1@mail.example',
    labelIds: ['SENT'],
    internalDate: AT + 1_000,
  });
  const found = await world.port.findSent(ACCOUNT, ID, AT - 5 * 60_000);
  assert.deepEqual(found, {
    kind: 'found',
    remoteMessageId: sent.id,
    remoteThreadId: sent.threadId,
  });
  assert.notEqual(found.kind === 'found' && found.remoteMessageId, draft.messageId);
});

test('gmail: the draft-only check holds even when the search itself lets the draft through (labels are re-read)', async () => {
  const world = await sendWorld();
  world.emu.mailbox.createDraftElsewhere({
    to: ['friend@example.test'],
    subject: 'Draft copy',
    messageId: 'contract-shared-1@mail.example',
    internalDate: AT,
  });
  // A search that ignored `in:sent -in:drafts` (the legacy adapter's bug) returns the draft; its labels refuse it.
  world.bridge.rewriteQuery = q => q.replace(' in:sent -in:drafts', ' in:anywhere');
  const result = await world.port.findSent(ACCOUNT, ID, AT - 5 * 60_000);
  assert.equal(result.kind, 'absent');
});

test('gmail: after an unsent drafts.send (reply lost before Gmail saw it), the draft carrying the id is not found', async () => {
  const world = await sendWorld({ useDraftsSend: true });
  const pinned = submission(world);
  const draft = world.emu.mailbox.createDraft(pinned.mime);
  world.faults.dropNext({ apiMethod: 'gmail.users.drafts.send' });
  await assert.rejects(
    world.port.send(ACCOUNT, {
      ...pinned.payload,
      remoteDraftId: draft.id,
      baseRemoteMessageId: draft.message.id,
    }),
  );
  assert.equal(world.sentMessages().length, 0, 'nothing left');
  const result = await world.port.findSent(
    ACCOUNT,
    pinned.payload.internetId,
    world.clock.now() - 300_000,
  );
  assert.equal(
    result.kind,
    'absent',
    'the draft with the same Message-ID must never settle the row as sent',
  );
});
