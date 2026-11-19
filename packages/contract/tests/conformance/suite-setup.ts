import assert from 'node:assert/strict';
import { errorTypes } from '../../src/index';
import { SampleContext, opId } from './samples';
import { rejects, type SuiteTools } from './suite-helpers';

/** Setup status, selector acting, and undo. */
export function setupSuite({ scenario }: SuiteTools) {
  // ---- setup and undo ---------------------------------------------------------------------------------------

  scenario('setup/status-shape', async (_e, c) => {
    const status = await c.call('Setup/status', {});
    const accounts = (await c.call('Account/get', {})).list.map(a => a.id);
    assert.ok(status.accounts.length > 0);
    for (const a of status.accounts) {
      assert.ok(accounts.includes(a.accountId));
      assert.ok(a.firstWindow.total > 0, 'firstWindow.total is the first-window target');
      assert.ok(a.firstWindow.read <= Math.max(a.firstWindow.total, a.firstWindow.found ?? 0));
      assert.ok(a.runId.length > 0);
    }
    for (const e of status.errors) assert.ok(errorTypes.length && e.reasonCode.length > 0);
  });
  scenario('act/selector', async (_e, c) => {
    const home = await c.call('View/query', { spec: { kind: 'home' } });
    const update = home.sections.find(s => s.key === 'update');
    assert.ok(update && update.count > 0, 'the demo has Important updates');
    const seen = home.ids.slice(update.start, update.start + update.count);
    const act = opId('sel');
    await c.call('Thread/act', {
      opId: act,
      selector: { spec: { kind: 'home' }, section: 'update', atState: home.state },
      action: { type: 'done' },
    });
    assert.ok(
      (await c.call('Thread/get', { ids: seen })).list.every(t => t.workflow.status === 'done'),
      'every row of the section is Done',
    );
    assert.equal(
      (await c.call('View/query', { spec: { kind: 'home' } })).sections.find(
        s => s.key === 'update',
      ),
      undefined,
      'the section is empty',
    );
    await c.call('Operation/undo', { opId: act, undoOpId: opId('undo') });
    assert.ok(
      (await c.call('Thread/get', { ids: seen })).list.every(t => t.workflow.status === 'new'),
      'one undo restores the whole section',
    );
    await rejects(
      c.session.call('Thread/act', {
        opId: opId(),
        selector: { spec: { kind: 'drafts' }, atState: home.state },
        action: { type: 'done' },
      }),
      'unsupported',
    );
  });
  scenario('undo/restores-thread', async (_e, c) => {
    const ctx = new SampleContext(c.session, async () => {});
    const id = await ctx.thread();
    const facts = async () => {
      const t = (await c.call('Thread/get', { ids: [id] })).list[0]!;
      return {
        rev: t.rev,
        facts: {
          workflow: { ...t.workflow, editedAt: undefined },
          labels: [...t.labels].sort(),
          lane: t.rank.lane,
          unread: t.unread,
          flagged: t.flagged,
        },
      };
    };
    const actions = [
      { type: 'done' },
      { type: 'trash' },
      { type: 'later', until: (await c.call('Session/get', {})).now + 86_400_000 },
      { type: 'lane', lane: 'low' },
      { type: 'read' },
      { type: 'flag', on: true },
    ] as const;
    for (const action of actions) {
      const before = await facts();
      const act = opId('act');
      await c.call('Thread/act', { opId: act, ids: [id], action });
      assert.notDeepEqual((await facts()).facts, before.facts, `${action.type} changed the row`);
      const undo = await c.call('Operation/undo', { opId: act, undoOpId: opId('undo') });
      const after = await facts();
      assert.deepEqual(after.facts, before.facts, `undo of ${action.type} restores the row`);
      assert.ok(after.rev > before.rev, 'revisions only move forward, so caches re-read');
      assert.ok(undo.appliedState.seq > 0);
      const ops = await c.call('Operation/get', { opIds: [act] });
      assert.equal(ops.list[0]?.opId, act);
    }
  });
}
