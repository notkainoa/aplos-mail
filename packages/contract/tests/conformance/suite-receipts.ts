import assert from 'node:assert/strict';
import { type Receipt, type WindowBody } from '../../src/index';
import { SampleContext, opId } from './samples';
import { rejects, type Connection, type SuiteTools } from './suite-helpers';
import type { EngineUnderTest, OrderingMode } from './target';

/** Receipt/frame convergence, catch-up, and reset. */
export function receiptsSuite({ target, scenario }: SuiteTools) {
  // ---- receipts and overlays --------------------------------------------------------------------------------

  /** The overlay rule (ARCH 9.2): whatever the order, a frame at or past the receipt's state shows the change, and none at or past it shows the old order. */
  const converge = async (engine: EngineUnderTest, c: Connection) => {
    const win = await c.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } });
    const target = win.ids[0]!;
    const receipt: Receipt = await c.call('Thread/act', {
      opId: opId(),
      ids: [target],
      action: { type: 'done' },
    });
    await engine.advance(300);
    const frames = c.windowFrames(win.windowId);
    const reached = frames.filter(f => f.state.seq >= receipt.appliedState.seq);
    assert.ok(reached.length, "a window frame reaches the receipt's appliedState");
    for (const f of reached)
      assert.ok(
        !f.ids.includes(target),
        'no frame at or past appliedState shows the pre-change list',
      );
    assert.equal(receipt.appliedState.dbEpoch, frames[0]!.dbEpoch);
    return c.events
      .filter(
        e =>
          (e.kind === 'reply' && e.method === 'Thread/act') ||
          (e.kind === 'frame' && e.frame.frame === 'window'),
      )
      .map(e => e.kind);
  };
  scenario('receipts/natural-order', async (engine, c) => {
    await converge(engine, c);
  });
  for (const mode of [
    'receiptFirst',
    'frameFirst',
    'together',
  ] as const satisfies readonly OrderingMode[]) {
    scenario(
      `receipts/${mode}`,
      async (engine, c) => {
        await engine.orderings!.set(mode);
        await converge(engine, c);
      },
      e => !e.orderings?.modes.includes(mode) && `${target.name} cannot force ${mode}`,
    );
  }

  // ---- catch-up and reset -----------------------------------------------------------------------------------

  scenario('changes/catch-up', async (_e, c) => {
    const ctx = new SampleContext(c.session, async () => {});
    const since = await ctx.state();
    const thread = await ctx.thread();
    const receipt = await c.call('Thread/act', {
      opId: opId(),
      ids: [thread],
      action: { type: 'bookmark', on: true },
    });
    const changes = await c.call('Session/changes', { since });
    assert.ok(
      changes.changes.some(ch => ch.type === 'Thread' && ch.id === thread && ch.op === 'u'),
    );
    assert.ok(changes.newState.seq >= receipt.appliedState.seq);
    assert.equal(changes.hasMore, false);
    const none = await c.call('Session/changes', { since: changes.newState });
    assert.deepEqual(none.changes, [], 'nothing new since the newest state');
  });
  scenario('changes/foreign-epoch', async (_e, c) => {
    await rejects(
      c.session.call('Session/changes', { since: { dbEpoch: 'another-database', seq: 1 } }),
      'cannotCalculateChanges',
    );
  });
  scenario(
    'changes/below-floor',
    async (engine, c) => {
      const since = (await c.call('Session/get', {})).state;
      const ctx = new SampleContext(c.session, async () => {});
      await c.call('Thread/act', {
        opId: opId(),
        ids: [await ctx.thread()],
        action: { type: 'flag', on: true },
      });
      await engine.compactLog!();
      await rejects(c.session.call('Session/changes', { since }), 'cannotCalculateChanges');
    },
    e => !e.compactLog && `${target.name} cannot compact its change log on demand`,
  );
  scenario(
    'reset/void-windows',
    async (engine, c) => {
      const before = await c.call('Session/get', {});
      const win: WindowBody = await c.call('View/watch', { spec: { kind: 'home' } });
      await engine.reset!('dbEpoch');
      await engine.advance(10);
      const reset = c.frames.find(f => f.frame === 'reset');
      assert.ok(reset, 'a reset frame arrives');
      const after = await c.call('Session/get', {});
      assert.notEqual(after.dbEpoch, before.dbEpoch, 'a new dbEpoch');
      await rejects(
        c.session.call('View/move', { windowId: win.windowId, anchor: { position: 0 } }),
        'notFound',
      );
      await rejects(
        c.session.call('Session/changes', { since: before.state }),
        'cannotCalculateChanges',
      );
      const again = await c.call('View/watch', { spec: { kind: 'home' } });
      assert.equal(again.state.dbEpoch, after.dbEpoch, 're-opened windows speak the new epoch');
    },
    e => !e.reset && `${target.name} cannot reset on demand`,
  );
}
