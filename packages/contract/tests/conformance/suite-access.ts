import assert from 'node:assert/strict';
import { SampleContext, opId } from './samples';
import { freezeTools, rejects, type SuiteTools } from './suite-helpers';

/** The freeze rules for scopes, callers, and blobs (plans/freeze/findings.md). */
export function accessSuite({ target, scenario }: SuiteTools) {
  const { listener, noCaller, hour, send, submission } = freezeTools(target);

  /** FR-3: undo and retry act with the scope of the method that made the operation. */
  scenario(
    'access/undo-needs-originating-scope',
    async (engine, c) => {
      const ctx = new SampleContext(c.session, async () => {});
      const now = (await c.call('Session/get', {})).now;
      const created = await c.call('Event/set', {
        opId: opId('event'),
        change: {
          type: 'create',
          calendarId: await ctx.calendar(),
          fields: {
            title: 'Conformance meeting',
            start: { type: 'utc', utc: now + 24 * hour },
            end: { type: 'utc', utc: now + 25 * hour },
            allDay: false,
            attendees: [{ address: 'guest@conformance.example' }],
          },
        },
      });
      const op = (await c.call('Operation/get', { opIds: [created.receipt.opId] })).list[0]!;
      assert.equal(
        op.scope,
        'send',
        'every operation records the scope of the method that made it',
      );
      const triage = listener(engine, 'read', 'triage');
      await rejects(
        triage.session.call('Operation/undo', {
          opId: created.receipt.opId,
          undoOpId: opId('undo'),
        }),
        'forbidden',
      );
      await rejects(
        triage.session.call('Operation/retry', { opId: created.receipt.opId }),
        'forbidden',
      );
      const admin = listener(engine, 'read', 'admin');
      await rejects(admin.session.call('Queue/discard', { id: created.receipt.opId }), 'forbidden');
      const sender = listener(engine, 'read', 'triage', 'send');
      await sender.call('Operation/undo', { opId: created.receipt.opId, undoOpId: opId('undo') });
    },
    noCaller,
  );

  /** R2B-1: an RSVP and an unsubscribe record `send` too, so a triage or admin tool cannot undo, retry or drop them. */
  scenario(
    'access/originating-scope-every-op',
    async (engine, c) => {
      const ctx = new SampleContext(c.session, async () => {});
      const opIds: string[] = [];
      const invitation = await ctx.invitation();
      if (invitation !== 'none')
        opIds.push(
          (
            await c.call('Event/rsvp', {
              opId: opId('rsvp'),
              id: invitation,
              response: 'accepted',
              scope: 'occurrence',
            })
          ).opId,
        );
      for (const threadId of (
        await c.call('View/query', { spec: { kind: 'mailbox', role: 'inbox' } })
      ).ids) {
        if ((await c.call('Unsubscribe/get', { threadId })).method === 'none') continue;
        const out = await c.call('Unsubscribe/run', { opId: opId('unsub'), threadId });
        if (out.receipt) opIds.push(out.receipt.opId);
        break;
      }
      assert.ok(opIds.length > 0, 'the demo data has an invitation or a newsletter');
      const triage = listener(engine, 'read', 'triage');
      const admin = listener(engine, 'read', 'triage', 'admin');
      for (const op of (await c.call('Operation/get', { opIds })).list) {
        assert.equal(op.scope, 'send', `${op.kind} records send`);
        await rejects(
          triage.session.call('Operation/undo', { opId: op.opId, undoOpId: opId('undo') }),
          'forbidden',
        );
        await rejects(triage.session.call('Operation/retry', { opId: op.opId }), 'forbidden');
        await rejects(admin.session.call('Queue/retry', { id: op.opId }), 'forbidden');
        await rejects(admin.session.call('Queue/discard', { id: op.opId }), 'forbidden');
      }
    },
    noCaller,
  );

  /** R2B-2: discarding a draft cancels its held send, so a draft-only tool may not do it; one holding send may. */
  scenario(
    'access/destroy-held-draft-needs-send',
    async (engine, c) => {
      const now = (await c.call('Session/get', {})).now;
      const held = await send(c, now + hour);
      const drafter = listener(engine, 'read', 'draft');
      await rejects(
        drafter.session.call('Draft/destroy', { opId: opId(), id: held.draft.id }),
        'forbidden',
      );
      assert.equal(
        (await submission(c, held.submission.id)).state,
        'scheduled',
        'the send still waits',
      );
      assert.equal((await c.call('Draft/get', { ids: [held.draft.id] })).list.length, 1);
      const free = await new SampleContext(c.session, async () => {}).draft();
      await drafter.call('Draft/destroy', { opId: opId(), id: free.id });
      await listener(engine, 'read', 'draft', 'send').call('Draft/destroy', {
        opId: opId(),
        id: held.draft.id,
      });
      assert.equal((await submission(c, held.submission.id)).state, 'cancelled');
    },
    noCaller,
  );

  /**
   * NB-1: an operation records the strongest scope its call needed. The owner's Draft/destroy of a held draft cancelled
   * a send, so undoing it (which would put the send back on schedule) needs `send`, not just `draft` and `triage`.
   */
  scenario(
    'access/undo-of-elevated-destroy-needs-send',
    async (engine, c) => {
      const now = (await c.call('Session/get', {})).now;
      const held = await send(c, now + hour);
      const destroyed = await c.call('Draft/destroy', { opId: opId(), id: held.draft.id });
      assert.equal((await submission(c, held.submission.id)).state, 'cancelled');
      const op = (await c.call('Operation/get', { opIds: [destroyed.opId] })).list[0];
      if (op?.undoable) {
        assert.equal(op.scope, 'send', 'a destroy that cancelled a send records send');
        await rejects(
          listener(engine, 'read', 'triage', 'draft').session.call('Operation/undo', {
            opId: destroyed.opId,
            undoOpId: opId('undo'),
          }),
          'forbidden',
        );
      }
      assert.equal(
        (await submission(c, held.submission.id)).state,
        'cancelled',
        'the discarded send stays cancelled',
      );
    },
    noCaller,
  );

  /** FR-5 and FR-6: what only the owner may do in Aplos itself. */
  scenario(
    'access/window-only',
    async (engine, c) => {
      const tool = listener(engine, 'read', 'triage', 'draft', 'send', 'ai', 'admin');
      const accountId = await new SampleContext(c.session, async () => {}).account();
      await rejects(
        tool.session.call('Consent/grant', {
          scope: 'background',
          version: (await c.call('Consent/get', {})).currentVersion,
          provider: 'groq',
          model: 'openai/gpt-oss-120b',
        }),
        'forbidden',
      );
      await rejects(
        tool.session.call('Settings/set', {
          opId: opId(),
          patch: { ai: { providers: { ollama: { address: 'http://203.0.113.7:11434/v1' } } } },
        }),
        'forbidden',
      );
      await rejects(
        tool.session.call('Account/set', { opId: opId(), accountId, aiAllowed: true }),
        'forbidden',
      );
      await tool.call('Settings/set', { opId: opId(), patch: { ui: { density: 'roomy' } } });
      const message = await new SampleContext(c.session, async () => {}).message();
      await rejects(
        tool.session.call('Mail/frame', { messageId: message, imagePolicy: 'block' }),
        'forbidden',
      );
      const reader = listener(engine, 'read');
      await rejects(
        reader.session.call('Submission/set', {
          opId: opId(),
          action: { type: 'undo', submissionId: 'any' },
        }),
        'forbidden',
      );
    },
    noCaller,
  );

  /** FR-6: blobs are bound to who made them; an export never reaches a tool. */
  scenario(
    'access/blob-bound-to-caller',
    async (engine, c) => {
      const exported = await c.call('Data/export', {});
      const mine = await c.call('Blob/put', {
        bytes: new TextEncoder().encode('window'),
        mime: 'text/plain',
      });
      assert.ok(mine.blobId.length >= 22, 'a blob id carries at least 128 random bits');
      const a = listener(engine, 'read', 'draft');
      const b = listener(engine, 'read', 'draft', 'admin');
      for (const blobId of [exported.blobId, mine.blobId])
        await rejects(a.session.call('Blob/get', { blobId }), 'notFound');
      const theirs = await a.call('Blob/put', {
        bytes: new TextEncoder().encode('tool'),
        mime: 'text/plain',
      });
      await rejects(b.session.call('Blob/get', { blobId: theirs.blobId }), 'notFound');
      await rejects(b.session.call('Blob/release', { blobId: theirs.blobId }), 'notFound');
      assert.equal((await a.call('Blob/get', { blobId: theirs.blobId })).size, 4);
      assert.equal((await c.call('Blob/get', { blobId: exported.blobId })).mime.length > 0, true);
    },
    noCaller,
  );
}
