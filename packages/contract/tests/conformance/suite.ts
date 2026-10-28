import nodeTest, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkResult, ContractError, ErrorBodySchema, errorTypes, Frame, methodsByArea, type EngineMethodName, type Input, type Output, type Receipt, type WindowBody } from '../../src/index';
import type { EngineSession } from '../../src/client/index';
import { runLast, SampleContext, samples, opId } from './samples';
import type { ConformanceTarget, EngineUnderTest, OrderingMode } from './target';

/**
 * The conformance suite (plan 10 section 4.1): one set of assertions any `EngineConnection` must pass, the stand-in
 * engine at C1 and the real engine from day 4. Every test has a stable id; an engine's known gaps go in
 * `expected-fail.<name>.json`, and a listed test that starts passing fails the run until it is taken off the list.
 * This file and its helpers import only the contract: an assertion that needs an engine's internals does not belong here.
 */

export const expectedFailPath = (name: string) => join(import.meta.dirname, `expected-fail.${name}.json`);
export function readExpectedFail(name: string): string[] {
  return JSON.parse(readFileSync(expectedFailPath(name), 'utf8')) as string[];
}

/** Every test id the suite registers, so an expected-fail list can be checked for stale names. */
export const testIds = new Set<string>();

type Body = (t: TestContext) => Promise<void>;

/** A connection with its frames recorded in arrival order, and typed calls. */
function open(engine: EngineUnderTest) {
  const session: EngineSession = engine.connection.connect();
  const frames: Frame[] = [];
  const events: ({ kind: 'frame'; frame: Frame } | { kind: 'reply'; method: string; result: unknown })[] = [];
  session.subscribe(frame => { frames.push(frame); events.push({ kind: 'frame', frame }); });
  const call = async <M extends EngineMethodName>(method: M, args: Input<M>): Promise<Output<M>> => {
    const result = await session.call(method, args);
    events.push({ kind: 'reply', method, result });
    return checkResult(method, result);
  };
  const windowFrames = (windowId: string) => frames.filter((f): f is Extract<Frame, { frame: 'window' }> => f.frame === 'window' && f.windowId === windowId);
  return { session, frames, events, call, windowFrames };
}

async function rejects(promise: Promise<unknown>, type: string) {
  try { await promise; } catch (error) {
    assert.ok(error instanceof ContractError, `a ContractError, not ${String(error)}`);
    assert.ok(ErrorBodySchema.safeParse(error.body).success, 'the error body matches the schema');
    assert.ok(error.body.message.length > 0, 'the error carries the sentence the UI shows');
    assert.equal(error.type, type, `error type (${error.body.message})`);
    return error;
  }
  assert.fail(`expected a ${type} error`);
}

/**
 * Registers the suite for one engine. `collect` only records the test ids (for the expected-fail checks) and runs nothing.
 */
export function conformance(target: ConformanceTarget, expectedFail: readonly string[] = readExpectedFail(target.name), { collect = false } = {}) {
  const test = collect ? (() => undefined) as unknown as typeof nodeTest : nodeTest;
  const check = (register: (name: string, fn: Body) => unknown, id: string, body: Body) => {
    testIds.add(id);
    return register(id, async t => {
      const expected = expectedFail.includes(id);
      try { await body(t); } catch (error) {
        if (expected) { t.diagnostic(`expected failure on ${target.name}: ${(error as Error).message}`); return; }
        throw error;
      }
      if (expected) assert.fail(`${id} passes on ${target.name} now: remove it from expected-fail.${target.name}.json.`);
    });
  };
  /** A test with its own engine. */
  const scenario = (id: string, body: (engine: EngineUnderTest, c: ReturnType<typeof open>, t: TestContext) => Promise<void>, skip?: (e: EngineUnderTest) => string | false) =>
    check((name, fn) => test(name, fn), id, async t => {
      const engine = await target.create();
      try {
        const why = skip?.(engine);
        if (why) { t.skip(why); return; }
        await body(engine, open(engine), t);
      } finally { await engine.close?.(); }
    });

  // ---- envelopes and error types ----------------------------------------------------------------------------

  scenario('envelope/unknown-method', async (_e, c) => {
    await rejects(c.session.call('Thread/explode', {}), 'unsupported');
  });
  scenario('envelope/desktop-method', async (_e, c) => {
    await rejects(c.session.call('File/save', { blobId: 'b', name: 'x.txt' }), 'unsupported');
  });
  scenario('envelope/validation', async (_e, c) => {
    const error = await rejects(c.session.call('Settings/set', { opId: opId(), patch: { mail: { undoSendSeconds: 99 } } }), 'validation');
    assert.equal(error.message, 'Undo send must be between 0 and 60 seconds.');
    assert.deepEqual(error.body.path, ['patch', 'mail', 'undoSendSeconds']);
    await rejects(c.session.call('Thread/act', { opId: opId(), ids: [], action: { type: 'done' } }), 'validation');
  });
  scenario('envelope/not-found', async (_e, c) => {
    await rejects(c.session.call('MessageBody/get', { messageId: 'no-such-message' }), 'notFound');
    const rows = await c.call('Thread/get', { ids: ['no-such-thread'] });
    assert.deepEqual(rows.notFound, ['no-such-thread'], 'T/get reports unknown ids instead of failing');
  });
  scenario('envelope/idempotent-opId', async (_e, c) => {
    const ctx = new SampleContext(c.session, async () => {});
    const args = { opId: opId('same'), ids: [await ctx.thread()], action: { type: 'bookmark' as const, on: true } };
    const first = await c.call('Thread/act', args);
    const second = await c.call('Thread/act', args);
    assert.deepEqual(second, first, 'a replayed opId answers the same receipt');
    assert.equal((await c.call('Session/get', {})).state.seq, first.appliedState.seq, 'and applies nothing twice');
  });

  // ---- every method on the demo data ------------------------------------------------------------------------

  check((name, fn) => test(name, fn), 'methods/coverage', async () => {
    const engine = Object.values(methodsByArea()).flat().sort();
    assert.deepEqual(Object.keys(samples).sort(), engine, 'one sample call per engine method in the registry');
  });
  const methodOrder = (() => {
    const names = (Object.keys(samples) as EngineMethodName[]).sort();
    return [...names.filter(m => !runLast.includes(m)), ...runLast];
  })();
  for (const method of methodOrder) testIds.add(`method/${method}`);
  test('methods', async t => {
    const engine = await target.create();
    try {
      const c = open(engine);
      const ctx = new SampleContext(c.session, ms => engine.advance(ms));
      for (const method of methodOrder) {
        await check((name, fn) => t.test(name, fn), `method/${method}`, async () => {
          const sample = samples[method] as { args: (c: SampleContext) => unknown; allow?: readonly string[] };
          const args = await sample.args(ctx);
          try {
            checkResult(method, await c.session.call(method, args));
          } catch (error) {
            if (!(error instanceof ContractError) || !sample.allow?.includes(error.type)) throw error;
            assert.ok(ErrorBodySchema.safeParse(error.body).success);
          }
        });
      }
      for (const f of c.frames) assert.ok(Frame.safeParse(f).success, `frame ${f.frame} matches the schema`);
    } finally { await engine.close?.(); }
  });

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
    for (let i = 0; i < 3; i++) { await c.call('Thread/act', { opId: opId(), ids: [win.ids[i]!], action: { type: 'flag', on: true } }); await engine.advance(300); }
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
    assert.deepEqual(dates, [...dates].sort((a, b) => b - a), 'a mailbox is newest first');
    const home = await c.call('View/watch', { spec: { kind: 'home' } });
    const keys = (home.sections ?? []).map(s => s.key).filter(k => ['do', 'update', 'follow'].includes(k));
    assert.deepEqual(keys, ['do', 'update', 'follow'].filter(k => keys.includes(k)), 'Home: Do now, then Important updates, then Follow up');
    const doNow = home.sections!.find(s => s.key === 'do')!;
    const band = (await c.call('Thread/get', { ids: home.ids.slice(doNow.start, doNow.start + doNow.count) })).list.map(t => t.rank.dueBand);
    assert.deepEqual(band, [...band].sort((a, b) => a - b), 'Do now is ordered by due band');
  });
  scenario('window/frame-after-change', async (engine, c) => {
    const win = await c.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } });
    const target = win.ids[0]!;
    const receipt = await c.call('Thread/act', { opId: opId(), ids: [target], action: { type: 'trash' } });
    await engine.advance(300);
    const last = c.windowFrames(win.windowId).at(-1);
    assert.ok(last, 'a window frame arrives after a relevant commit');
    assert.ok(!last.ids.includes(target), 'the trashed thread left the Inbox');
    assert.ok(last.state.seq >= receipt.appliedState.seq, 'the frame has reached the receipt\'s state');
    assert.equal(last.total, win.total - 1);
  });
  scenario('window/move-and-unwatch', async (engine, c) => {
    const win = await c.call('View/watch', { spec: { kind: 'mailbox', role: 'all' }, limit: 2 });
    assert.equal(win.ids.length, 2);
    const moved = await c.call('View/move', { windowId: win.windowId, anchor: { position: 2 } });
    assert.equal(moved.position, 2);
    assert.notDeepEqual(moved.ids, win.ids);
    await c.call('View/unwatch', { windowId: win.windowId });
    await rejects(c.session.call('View/move', { windowId: win.windowId, anchor: { position: 0 } }), 'notFound');
    const before = c.windowFrames(win.windowId).length;
    await c.call('Thread/act', { opId: opId(), ids: [win.ids[0]!], action: { type: 'trash' } });
    await engine.advance(300);
    assert.equal(c.windowFrames(win.windowId).length, before, 'a closed window gets no frames');
  });
  scenario('window/holdIds-keep-place', async (engine, c) => {
    const first = await c.call('View/query', { spec: { kind: 'mailbox', role: 'inbox' } });
    const held = first.ids[0]!;
    const win = await c.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' }, holdIds: [held] });
    await c.call('Thread/act', { opId: opId(), ids: [held], action: { type: 'done' } });
    await c.call('Thread/act', { opId: opId(), ids: [win.ids[1]!], action: { type: 'flag', on: true } });
    await engine.advance(300);
    for (const f of c.windowFrames(win.windowId)) assert.equal(f.ids[0], held, 'a held row stays where it was, even after leaving the view');
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
      receipt = await c.call('Thread/act', { opId: opId(), ids: [target], action: { type: 'flag', on: i % 2 === 0 } });
      await engine.advance(50);
    }
    const during = c.windowFrames(win.windowId).length;
    assert.ok(during >= 2, `frames keep flowing during a burst (${during})`);
    assert.ok(during <= 5, `at most 4 frames per second per window, ${during} in 1 s`);
    await engine.advance(500);
    const last = c.windowFrames(win.windowId).at(-1)!;
    assert.ok(last.state.seq >= receipt!.appliedState.seq, 'the burst settles on a frame at the last change');
  });

  // ---- receipts and overlays --------------------------------------------------------------------------------

  /** The overlay rule (ARCH 9.2): whatever the order, a frame at or past the receipt's state shows the change, and none at or past it shows the old order. */
  const converge = async (engine: EngineUnderTest, c: ReturnType<typeof open>) => {
    const win = await c.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } });
    const target = win.ids[0]!;
    const receipt: Receipt = await c.call('Thread/act', { opId: opId(), ids: [target], action: { type: 'done' } });
    await engine.advance(300);
    const frames = c.windowFrames(win.windowId);
    const reached = frames.filter(f => f.state.seq >= receipt.appliedState.seq);
    assert.ok(reached.length, 'a window frame reaches the receipt\'s appliedState');
    for (const f of reached) assert.ok(!f.ids.includes(target), 'no frame at or past appliedState shows the pre-change list');
    assert.equal(receipt.appliedState.dbEpoch, frames[0]!.dbEpoch);
    return c.events.filter(e => e.kind === 'reply' && e.method === 'Thread/act' || e.kind === 'frame' && e.frame.frame === 'window').map(e => e.kind);
  };
  scenario('receipts/natural-order', async (engine, c) => { await converge(engine, c); });
  for (const mode of ['receiptFirst', 'frameFirst', 'together'] as const satisfies readonly OrderingMode[]) {
    scenario(`receipts/${mode}`, async (engine, c) => {
      await engine.orderings!.set(mode);
      await converge(engine, c);
    }, e => !e.orderings?.modes.includes(mode) && `${target.name} cannot force ${mode}`);
  }

  // ---- catch-up and reset -----------------------------------------------------------------------------------

  scenario('changes/catch-up', async (_e, c) => {
    const ctx = new SampleContext(c.session, async () => {});
    const since = await ctx.state();
    const thread = await ctx.thread();
    const receipt = await c.call('Thread/act', { opId: opId(), ids: [thread], action: { type: 'bookmark', on: true } });
    const changes = await c.call('Session/changes', { since });
    assert.ok(changes.changes.some(ch => ch.type === 'Thread' && ch.id === thread && ch.op === 'u'));
    assert.ok(changes.newState.seq >= receipt.appliedState.seq);
    assert.equal(changes.hasMore, false);
    const none = await c.call('Session/changes', { since: changes.newState });
    assert.deepEqual(none.changes, [], 'nothing new since the newest state');
  });
  scenario('changes/foreign-epoch', async (_e, c) => {
    await rejects(c.session.call('Session/changes', { since: { dbEpoch: 'another-database', seq: 1 } }), 'cannotCalculateChanges');
  });
  scenario('changes/below-floor', async (engine, c) => {
    const since = (await c.call('Session/get', {})).state;
    const ctx = new SampleContext(c.session, async () => {});
    await c.call('Thread/act', { opId: opId(), ids: [await ctx.thread()], action: { type: 'flag', on: true } });
    await engine.compactLog!();
    await rejects(c.session.call('Session/changes', { since }), 'cannotCalculateChanges');
  }, e => !e.compactLog && `${target.name} cannot compact its change log on demand`);
  scenario('reset/void-windows', async (engine, c) => {
    const before = await c.call('Session/get', {});
    const win: WindowBody = await c.call('View/watch', { spec: { kind: 'home' } });
    await engine.reset!('dbEpoch');
    await engine.advance(10);
    const reset = c.frames.find(f => f.frame === 'reset');
    assert.ok(reset, 'a reset frame arrives');
    const after = await c.call('Session/get', {});
    assert.notEqual(after.dbEpoch, before.dbEpoch, 'a new dbEpoch');
    await rejects(c.session.call('View/move', { windowId: win.windowId, anchor: { position: 0 } }), 'notFound');
    await rejects(c.session.call('Session/changes', { since: before.state }), 'cannotCalculateChanges');
    const again = await c.call('View/watch', { spec: { kind: 'home' } });
    assert.equal(again.state.dbEpoch, after.dbEpoch, 're-opened windows speak the new epoch');
  }, e => !e.reset && `${target.name} cannot reset on demand`);

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
    await c.call('Thread/act', { opId: act, selector: { spec: { kind: 'home' }, section: 'update', atState: home.state }, action: { type: 'done' } });
    assert.ok((await c.call('Thread/get', { ids: seen })).list.every(t => t.workflow.status === 'done'), 'every row of the section is Done');
    assert.equal((await c.call('View/query', { spec: { kind: 'home' } })).sections.find(s => s.key === 'update'), undefined, 'the section is empty');
    await c.call('Operation/undo', { opId: act, undoOpId: opId('undo') });
    assert.ok((await c.call('Thread/get', { ids: seen })).list.every(t => t.workflow.status === 'new'), 'one undo restores the whole section');
    await rejects(c.session.call('Thread/act', { opId: opId(), selector: { spec: { kind: 'drafts' }, atState: home.state }, action: { type: 'done' } }), 'unsupported');
  });
  scenario('undo/restores-thread', async (_e, c) => {
    const ctx = new SampleContext(c.session, async () => {});
    const id = await ctx.thread();
    const facts = async () => { const t = (await c.call('Thread/get', { ids: [id] })).list[0]!; return { rev: t.rev, facts: { workflow: { ...t.workflow, editedAt: undefined }, labels: [...t.labels].sort(), lane: t.rank.lane, unread: t.unread, flagged: t.flagged } }; };
    const actions = [{ type: 'done' }, { type: 'trash' }, { type: 'later', until: (await c.call('Session/get', {})).now + 86_400_000 }, { type: 'lane', lane: 'low' }, { type: 'read' }, { type: 'flag', on: true }] as const;
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
