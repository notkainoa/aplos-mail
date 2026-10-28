import assert from 'node:assert/strict';
import { Frame, type Receipt } from '../../src/index';
import { opId } from './samples';
import { rejects, type SuiteTools } from './suite-helpers';

/** Session handshakes, frame stamping, and the live-window rules. */
export function sessionSuite({ scenario }: SuiteTools) {
  // ---- session and frames -----------------------------------------------------------------------------------

  scenario('session/handshake', async (_e, c) => {
    const s = await c.call('Session/get', {});
    assert.equal(s.apiVersion, 1);
    assert.equal(s.state.dbEpoch, s.dbEpoch);
    assert.equal(s.hasAccounts, true, 'demo data counts as accounts');
    assert.equal(s.engine.state, 'ready');
  });
  scenario('frames/stamped-and-ordered', async (engine, c) => {
    const s = await c.call('Session/get', {});
    const win = await c.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } });
    for (let i = 0; i < 3; i++) {
      await c.call('Thread/act', {
        opId: opId(),
        ids: [win.ids[i]!],
        action: { type: 'flag', on: true },
      });
      await engine.advance(300);
    }
    assert.ok(c.frames.length > 0, 'changes produce frames');
    let seq = 0;
    for (const f of c.frames) {
      assert.ok(Frame.safeParse(f).success, `frame ${f.frame} matches the schema`);
      // `desktop` frames are main's own and carry no state token; an engine never sends one.
      assert.ok(f.frame !== 'desktop', 'the engine sends no desktop frames');
      assert.equal(f.dbEpoch, s.dbEpoch, 'every frame carries the dbEpoch');
      assert.ok(f.seq >= seq, 'seq never goes backwards on one connection');
      seq = f.seq;
    }
  });

  // ---- live windows -----------------------------------------------------------------------------------------

  scenario('window/first-answer', async (_e, c) => {
    const inbox = await c.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } });
    assert.ok(inbox.ids.length <= 200 && inbox.total >= inbox.ids.length && inbox.ids.length > 0);
    assert.equal(inbox.rowType, 'Thread');
    const rows = (await c.call('Thread/get', { ids: inbox.ids })).list;
    const dates = inbox.ids.map(id => rows.find(r => r.id === id)!.lastDate);
    assert.deepEqual(
      dates,
      [...dates].sort((a, b) => b - a),
      'a mailbox is newest first',
    );
    const home = await c.call('View/watch', { spec: { kind: 'home' } });
    const keys = (home.sections ?? [])
      .map(s => s.key)
      .filter(k => ['do', 'update', 'follow'].includes(k));
    assert.deepEqual(
      keys,
      ['do', 'update', 'follow'].filter(k => keys.includes(k)),
      'Home: Do now, then Important updates, then Follow up',
    );
    const doNow = home.sections!.find(s => s.key === 'do')!;
    const band = (
      await c.call('Thread/get', { ids: home.ids.slice(doNow.start, doNow.start + doNow.count) })
    ).list.map(t => t.rank.dueBand);
    assert.deepEqual(
      band,
      [...band].sort((a, b) => a - b),
      'Do now is ordered by due band',
    );
  });
  scenario('window/frame-after-change', async (engine, c) => {
    const win = await c.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } });
    const target = win.ids[0]!;
    const receipt = await c.call('Thread/act', {
      opId: opId(),
      ids: [target],
      action: { type: 'trash' },
    });
    await engine.advance(300);
    const last = c.windowFrames(win.windowId).at(-1);
    assert.ok(last, 'a window frame arrives after a relevant commit');
    assert.ok(!last.ids.includes(target), 'the trashed thread left the Inbox');
    assert.ok(
      last.state.seq >= receipt.appliedState.seq,
      "the frame has reached the receipt's state",
    );
    assert.equal(last.total, win.total - 1);
  });
  scenario('window/move-and-unwatch', async (engine, c) => {
    const win = await c.call('View/watch', { spec: { kind: 'mailbox', role: 'all' }, limit: 2 });
    assert.equal(win.ids.length, 2);
    const moved = await c.call('View/move', { windowId: win.windowId, anchor: { position: 2 } });
    assert.equal(moved.position, 2);
    assert.notDeepEqual(moved.ids, win.ids);
    await c.call('View/unwatch', { windowId: win.windowId });
    await rejects(
      c.session.call('View/move', { windowId: win.windowId, anchor: { position: 0 } }),
      'notFound',
    );
    const before = c.windowFrames(win.windowId).length;
    await c.call('Thread/act', { opId: opId(), ids: [win.ids[0]!], action: { type: 'trash' } });
    await engine.advance(300);
    assert.equal(c.windowFrames(win.windowId).length, before, 'a closed window gets no frames');
  });
  scenario('window/holdIds-keep-place', async (engine, c) => {
    const first = await c.call('View/query', { spec: { kind: 'mailbox', role: 'inbox' } });
    const held = first.ids[0]!;
    const win = await c.call('View/watch', {
      spec: { kind: 'mailbox', role: 'inbox' },
      holdIds: [held],
    });
    await c.call('Thread/act', { opId: opId(), ids: [held], action: { type: 'done' } });
    await c.call('Thread/act', {
      opId: opId(),
      ids: [win.ids[1]!],
      action: { type: 'flag', on: true },
    });
    await engine.advance(300);
    for (const f of c.windowFrames(win.windowId))
      assert.equal(f.ids[0], held, 'a held row stays where it was, even after leaving the view');
    await c.call('View/release', { windowId: win.windowId });
    await engine.advance(300);
    const last = c.windowFrames(win.windowId).at(-1);
    assert.ok(last && !last.ids.includes(held), 'once released, the window reconciles');
  });
  scenario('window/hold-then-release', async (engine, c) => {
    const win = await c.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } });
    const held = win.ids[1]!;
    await c.call('View/hold', { windowId: win.windowId, ids: [held] });
    await c.call('Thread/act', { opId: opId(), ids: [held], action: { type: 'trash' } });
    await engine.advance(300);
    for (const f of c.windowFrames(win.windowId)) assert.equal(f.ids[1], held);
    await c.call('View/release', { windowId: win.windowId, ids: [held] });
    await engine.advance(300);
    assert.ok(!c.windowFrames(win.windowId).at(-1)?.ids.includes(held));
  });
  scenario('window/coalescing', async (engine, c) => {
    const win = await c.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } });
    const target = win.ids[0]!;
    let receipt: Receipt | undefined;
    for (let i = 0; i < 20; i++) {
      receipt = await c.call('Thread/act', {
        opId: opId(),
        ids: [target],
        action: { type: 'flag', on: i % 2 === 0 },
      });
      await engine.advance(50);
    }
    const during = c.windowFrames(win.windowId).length;
    assert.ok(during >= 2, `frames keep flowing during a burst (${during})`);
    assert.ok(during <= 5, `at most 4 frames per second per window, ${during} in 1 s`);
    await engine.advance(500);
    const last = c.windowFrames(win.windowId).at(-1)!;
    assert.ok(
      last.state.seq >= receipt!.appliedState.seq,
      'the burst settles on a frame at the last change',
    );
  });
}
