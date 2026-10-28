import assert from 'node:assert/strict';
import { SampleContext, opId } from './samples';
import { freezeTools, rejects, type SuiteTools } from './suite-helpers';

/** The freeze rules for sending (plans/freeze/findings.md). */
export function sendSuite({ target, scenario }: SuiteTools) {
  const { hour, send, submission } = freezeTools(target);

  // ---- freeze rules (plans/freeze/findings.md) -------------------------------------------------------------

  /** FR-2 (ARCH 7.3): a send waiting on `notBefore` that the Mac slept through is suspended, never sent late. */
  scenario(
    'send/overdue-suspends',
    async (engine, c) => {
      const now = (await c.call('Session/get', {})).now;
      const later = await send(c, now + hour);
      assert.equal(later.submission.state, 'scheduled');
      const undo = await send(c);
      assert.equal(undo.submission.state, 'queued');
      await engine.sleep!(3 * hour);
      await engine.advance(1_000);
      for (const { submission: s } of [later, undo]) {
        const after = await submission(c, s.id);
        assert.equal(after.state, 'suspended', `a ${s.state} send that fell due asleep waits`);
        assert.ok(after.problem?.reasonCode, 'with the reason the UI shows');
      }
    },
    e => !e.sleep && `${target.name} cannot sleep`,
  );

  /** FR-7: the bytes that leave are the revision the owner sent; a held send locks its draft. */
  scenario('send/draft-locked-while-held', async (_e, c) => {
    const now = (await c.call('Session/get', {})).now;
    const { draft, submission: s } = await send(c, now + hour);
    assert.equal(s.revision, draft.revision, 'the submission records the revision it sends');
    const { revision } = draft;
    const fields = {
      accountId: draft.accountId,
      mode: 'new' as const,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      html: draft.html,
      attachments: draft.attachments,
      signature: draft.signature,
    };
    await rejects(
      c.session.call('Draft/set', {
        opId: opId(),
        id: draft.id,
        baseRevision: revision,
        fields: { ...fields, to: [{ address: 'someone-else@conformance.example' }] },
      }),
      'stateMismatch',
    );
    await rejects(
      c.session.call('Draft/resolve', { opId: opId(), id: draft.id, choice: 'keepMine' }),
      'stateMismatch',
    );
    await rejects(
      c.session.call('Submission/set', {
        opId: opId(),
        action: { type: 'sendNow', submissionId: s.id, revision: revision + 1 },
      }),
      'stateMismatch',
    );
    await c.call('Submission/set', { opId: opId(), action: { type: 'undo', submissionId: s.id } });
    await c.call('Draft/set', { opId: opId(), id: draft.id, baseRevision: revision, fields });
  });

  /** FR-7: a file attached to a held send stays until the send settles; `Blob/release` cannot drop it. */
  scenario('send/attachment-kept-while-held', async (_e, c) => {
    const now = (await c.call('Session/get', {})).now;
    const bytes = new TextEncoder().encode('attached');
    const { blobId } = await c.call('Blob/put', { bytes, mime: 'text/plain', name: 'a.txt' });
    const ctx = new SampleContext(c.session, async () => {});
    const { draft } = await c.call('Draft/set', {
      opId: opId('draft'),
      fields: {
        accountId: await ctx.account(),
        mode: 'new',
        to: [{ address: 'someone@conformance.example' }],
        cc: [],
        bcc: [],
        subject: 'With a file',
        html: '<p>Attached.</p>',
        attachments: [{ id: 'a1', name: 'a.txt', mime: 'text/plain', size: bytes.length, blobId }],
        signature: false,
      },
    });
    const { submission: s } = await c.call('Submission/set', {
      opId: opId('send'),
      action: { type: 'send', draftId: draft.id, revision: draft.revision, notBefore: now + hour },
    });
    await rejects(c.session.call('Blob/release', { blobId }), 'stateMismatch');
    assert.equal(
      (await c.call('Blob/get', { blobId })).size,
      bytes.length,
      'the bytes are still there',
    );
    await c.call('Submission/set', { opId: opId(), action: { type: 'undo', submissionId: s.id } });
    await c.call('Blob/release', { blobId });
  });

  /** FR-14: a send's receipt is undoable while held, and `Operation/undo` on it cancels the send. */
  scenario('send/undo-through-receipt', async (_e, c) => {
    const { draft, submission: s, receipt } = await send(c);
    assert.equal(receipt.undoable, true, 'a held send can be undone from its receipt');
    assert.equal(receipt.undoUntil, s.notBefore);
    await c.call('Operation/undo', { opId: receipt.opId, undoOpId: opId('undo') });
    assert.equal((await submission(c, s.id)).state, 'cancelled');
    const back = (await c.call('Draft/get', { ids: [draft.id] })).list[0]!;
    assert.equal(back.submissionId, undefined, 'the draft comes back unlocked');
  });

  /** FR-13: "Don't send it" after a suspended send, and discarding a draft cancels its held send. */
  scenario(
    'send/cancel-and-discard',
    async (engine, c) => {
      const now = (await c.call('Session/get', {})).now;
      const missed = await send(c, now + hour);
      await engine.sleep!(3 * hour);
      await engine.advance(1_000);
      assert.equal((await submission(c, missed.submission.id)).state, 'suspended');
      const out = await c.call('Submission/set', {
        opId: opId(),
        action: { type: 'cancel', submissionId: missed.submission.id },
      });
      assert.equal(out.submission.state, 'cancelled');
      const draft = (await c.call('Draft/get', { ids: [missed.draft.id] })).list[0]!;
      assert.equal(draft.submissionId, undefined, 'the draft comes back unlocked');
      const held = await send(c, now + 10 * hour);
      await c.call('Draft/destroy', { opId: opId(), id: held.draft.id });
      assert.equal((await submission(c, held.submission.id)).state, 'cancelled');
      const pending = await c.call('Outbox/pending', {});
      assert.ok(
        !JSON.stringify(pending).includes(held.submission.id),
        'a discarded draft leaves nothing to send',
      );
    },
    e => !e.sleep && `${target.name} cannot sleep`,
  );
}
