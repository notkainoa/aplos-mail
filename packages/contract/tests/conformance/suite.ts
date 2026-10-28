import nodeTest, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkResult,
  ContractError,
  ErrorBodySchema,
  errorTypes,
  Frame,
  methodsByArea,
  parseDiagnosticsBundle,
  type EngineMethodName,
  type Input,
  type Output,
  type Receipt,
  type WindowBody,
} from '../../src/index';
import type { EngineSession } from '../../src/client/index';
import { listenerCaller } from '../../src/access';
import { runLast, SampleContext, samples, opId } from './samples';
import type { ConformanceTarget, EngineUnderTest, OrderingMode } from './target';

/**
 * The conformance suite (plan 10 section 4.1): one set of assertions any `EngineConnection` must pass, the stand-in
 * engine at C1 and the real engine from day 4. Every test has a stable id; an engine's known gaps go in
 * `expected-fail.<name>.json`, and a listed test that starts passing fails the run until it is taken off the list.
 * This file and its helpers import only the contract: an assertion that needs an engine's internals does not belong here.
 */

export const expectedFailPath = (name: string) =>
  join(import.meta.dirname, `expected-fail.${name}.json`);
export function readExpectedFail(name: string): string[] {
  return JSON.parse(readFileSync(expectedFailPath(name), 'utf8')) as string[];
}

/** Every test id the suite registers, so an expected-fail list can be checked for stale names. */
export const testIds = new Set<string>();

type Body = (t: TestContext) => Promise<void>;

/** A connection with its frames recorded in arrival order, and typed calls. */
function open(engine: EngineUnderTest) {
  return openSession(engine.connection.connect());
}
function openSession(session: EngineSession) {
  const frames: Frame[] = [];
  const events: (
    { kind: 'frame'; frame: Frame } | { kind: 'reply'; method: string; result: unknown }
  )[] = [];
  session.subscribe(frame => {
    frames.push(frame);
    events.push({ kind: 'frame', frame });
  });
  const call = async <M extends EngineMethodName>(
    method: M,
    args: Input<M>,
  ): Promise<Output<M>> => {
    const result = await session.call(method, args);
    events.push({ kind: 'reply', method, result });
    return checkResult(method, result);
  };
  const windowFrames = (windowId: string) =>
    frames.filter(
      (f): f is Extract<Frame, { frame: 'window' }> =>
        f.frame === 'window' && f.windowId === windowId,
    );
  return { session, frames, events, call, windowFrames };
}

async function rejects(promise: Promise<unknown>, type: string) {
  try {
    await promise;
  } catch (error) {
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
export function conformance(
  target: ConformanceTarget,
  expectedFail: readonly string[] = readExpectedFail(target.name),
  { collect = false } = {},
) {
  const test = collect ? ((() => undefined) as unknown as typeof nodeTest) : nodeTest;
  const check = (register: (name: string, fn: Body) => unknown, id: string, body: Body) => {
    testIds.add(id);
    return register(id, async t => {
      const expected = expectedFail.includes(id);
      try {
        await body(t);
      } catch (error) {
        if (expected) {
          t.diagnostic(`expected failure on ${target.name}: ${(error as Error).message}`);
          return;
        }
        throw error;
      }
      if (expected)
        assert.fail(
          `${id} passes on ${target.name} now: remove it from expected-fail.${target.name}.json.`,
        );
    });
  };
  /** A test with its own engine. */
  const scenario = (
    id: string,
    body: (engine: EngineUnderTest, c: ReturnType<typeof open>, t: TestContext) => Promise<void>,
    skip?: (e: EngineUnderTest) => string | false,
  ) =>
    check(
      (name, fn) => test(name, fn),
      id,
      async t => {
        const engine = await target.create();
        try {
          const why = skip?.(engine);
          if (why) {
            t.skip(why);
            return;
          }
          await body(engine, open(engine), t);
        } finally {
          await engine.close?.();
        }
      },
    );

  // ---- envelopes and error types ----------------------------------------------------------------------------

  scenario('envelope/unknown-method', async (_e, c) => {
    await rejects(c.session.call('Thread/explode', {}), 'unsupported');
  });
  scenario('envelope/desktop-method', async (_e, c) => {
    await rejects(c.session.call('File/save', { blobId: 'b', name: 'x.txt' }), 'unsupported');
  });
  scenario('envelope/validation', async (_e, c) => {
    const error = await rejects(
      c.session.call('Settings/set', { opId: opId(), patch: { mail: { undoSendSeconds: 99 } } }),
      'validation',
    );
    assert.equal(error.message, 'Undo send must be between 0 and 60 seconds.');
    assert.deepEqual(error.body.path, ['patch', 'mail', 'undoSendSeconds']);
    await rejects(
      c.session.call('Thread/act', { opId: opId(), ids: [], action: { type: 'done' } }),
      'validation',
    );
  });
  scenario('envelope/not-found', async (_e, c) => {
    await rejects(c.session.call('MessageBody/get', { messageId: 'no-such-message' }), 'notFound');
    const rows = await c.call('Thread/get', { ids: ['no-such-thread'] });
    assert.deepEqual(
      rows.notFound,
      ['no-such-thread'],
      'T/get reports unknown ids instead of failing',
    );
  });
  scenario('envelope/idempotent-opId', async (_e, c) => {
    const ctx = new SampleContext(c.session, async () => {});
    const args = {
      opId: opId('same'),
      ids: [await ctx.thread()],
      action: { type: 'bookmark' as const, on: true },
    };
    const first = await c.call('Thread/act', args);
    const second = await c.call('Thread/act', args);
    assert.deepEqual(second, first, 'a replayed opId answers the same receipt');
    assert.equal(
      (await c.call('Session/get', {})).state.seq,
      first.appliedState.seq,
      'and applies nothing twice',
    );
  });

  // ---- every method on the demo data ------------------------------------------------------------------------

  check(
    (name, fn) => test(name, fn),
    'methods/coverage',
    async () => {
      const engine = Object.values(methodsByArea()).flat().sort();
      assert.deepEqual(
        Object.keys(samples).sort(),
        engine,
        'one sample call per engine method in the registry',
      );
    },
  );
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
        await check(
          (name, fn) => t.test(name, fn),
          `method/${method}`,
          async () => {
            const sample = samples[method] as {
              args: (c: SampleContext) => unknown;
              allow?: readonly string[];
            };
            const args = await sample.args(ctx);
            try {
              checkResult(method, await c.session.call(method, args));
            } catch (error) {
              if (!(error instanceof ContractError) || !sample.allow?.includes(error.type))
                throw error;
              assert.ok(ErrorBodySchema.safeParse(error.body).success);
            }
          },
        );
      }
      for (const f of c.frames)
        assert.ok(Frame.safeParse(f).success, `frame ${f.frame} matches the schema`);
    } finally {
      await engine.close?.();
    }
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

  // ---- receipts and overlays --------------------------------------------------------------------------------

  /** The overlay rule (ARCH 9.2): whatever the order, a frame at or past the receipt's state shows the change, and none at or past it shows the old order. */
  const converge = async (engine: EngineUnderTest, c: ReturnType<typeof open>) => {
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

  // ---- freeze rules (plans/freeze/findings.md) -------------------------------------------------------------

  /** A socket client holding `scopes`, its caller made from its stored Client row as every transport must (R2B-3). */
  const listener = (engine: EngineUnderTest, ...scopes: string[]) =>
    openSession(
      engine.connectAs!(
        listenerCaller({ id: `conf-${scopes.join('-')}`, kind: 'cli', scopes }, 'socket'),
      ),
    );
  const noCaller = (e: EngineUnderTest) =>
    !e.connectAs && `${target.name} cannot connect as a tool`;
  const hour = 3_600_000;
  /** A draft and a send of it at `notBefore` (absent: the undo window), with a 10 s undo window set first. */
  const send = async (c: ReturnType<typeof open>, notBefore?: number) => {
    await c.call('Settings/set', { opId: opId(), patch: { mail: { undoSendSeconds: 10 } } });
    const ctx = new SampleContext(c.session, async () => {});
    const draft = await ctx.draft();
    const out = await c.call('Submission/set', {
      opId: opId('send'),
      action: { type: 'send', draftId: draft.id, revision: draft.revision, notBefore },
    });
    return { draft, ...out };
  };
  const submission = async (c: ReturnType<typeof open>, id: string) =>
    (await c.call('Submission/get', { ids: [id] })).list[0]!;

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

  /** FR-8: "Use this account's mail for AI" bounds every AI scope; naming an excluded account never widens it. */
  scenario('ai/excluded-account-stays-out', async (engine, c) => {
    const accounts = (await c.call('Account/get', {})).list;
    if (accounts.length < 2) return;
    const [kept, excluded] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    await c.call('Account/set', { opId: opId(), accountId: excluded.id, aiAllowed: false });
    let run;
    try {
      run = await c.call('Ask/run', {
        question: 'What needs my reply today?',
        scope: { accountIds: [excluded.id, kept.id] },
      });
    } catch (error) {
      if (error instanceof ContractError && error.type === 'notConfigured') return;
      throw error;
    }
    await engine.advance(3_000);
    const turn = (
      await c.call('Conversation/get', { ids: [run.conversationId] })
    ).list[0]!.turns.at(-1)!;
    const threads = new Set(
      turn.citations.flatMap(x => (x.kind === 'message' ? [x.threadId] : [])),
    );
    const rows = (await c.call('Thread/get', { ids: [...threads] })).list;
    assert.ok(
      rows.every(t => t.accountId !== excluded.id),
      'no source from an account left out of AI',
    );
    assert.ok(turn.excludedAccountIds?.includes(excluded.id));
    const excludedThread = (
      await c.call('View/query', {
        spec: { kind: 'mailbox', role: 'inbox', accountId: excluded.id },
      })
    ).ids[0];
    if (excludedThread)
      await rejects(
        c.session.call('Ai/request', {
          opId: opId(),
          kind: 'summary',
          threadId: excludedThread,
          force: true,
        }),
        'forbidden',
      );
    // A draft in that account carries its mail as context, so Ai/draft and Ai/polish refuse it too (R2B-5).
    const { draft } = await c.call('Draft/set', {
      opId: opId('draft'),
      fields: {
        accountId: excluded.id,
        mode: 'new',
        to: [{ address: 'someone@conformance.example' }],
        cc: [],
        bcc: [],
        subject: 'Excluded',
        html: '<p>Private</p>',
        attachments: [],
        signature: false,
      },
    });
    const refused = [
      c.session.call('Ai/draft', {
        requestId: opId('ai'),
        instruction: 'Say thanks.',
        draftId: draft.id,
      }),
      c.session.call('Ai/polish', {
        requestId: opId('ai'),
        html: '<p>Private</p>',
        draftId: draft.id,
      }),
    ];
    for (const call of refused) {
      const error = await rejects(call, 'forbidden');
      assert.equal(error?.body.reasonCode, 'ai.accountExcluded');
    }
  });

  /** R2B-4: background consent covers every model background jobs run on, not only Summaries. */
  scenario('ai/consent-covers-background-features', async (_e, c) => {
    for (const feature of ['plans', 'drafts'] as const) {
      const consent = await c.call('Consent/get', {});
      const { features } = (await c.call('Settings/get', {})).ai;
      await c.call('Consent/grant', {
        scope: 'background',
        version: consent.currentVersion,
        provider: features.summaries.provider as Input<'Consent/grant'>['provider'],
        model: features.summaries.model,
      });
      const other =
        features[feature].provider === 'ollama'
          ? ({ provider: 'groq', model: 'openai/gpt-oss-120b' } as const)
          : ({ provider: 'ollama', model: 'llama3.2' } as const);
      await c.call('Settings/set', {
        opId: opId(),
        patch: { ai: { features: { ...features, [feature]: other } } },
      });
      const after = await c.call('Consent/get', {});
      assert.equal(
        after.needsReconsent,
        true,
        `moving ${feature} to another provider needs the card again`,
      );
      assert.ok(after.currentVersion > consent.currentVersion);
    }
  });

  /** FR-23: a reconnect sheet reopened anywhere finds its flow by account, and a cancel keeps its mode. */
  scenario('connect/reconnect-frames-carry-account', async (engine, c) => {
    const accountId = (await c.call('Account/get', {})).list[0]!.id;
    const start = await c.call('Account/reconnect', { accountId });
    await engine.advance(100);
    await c.call('Account/cancelConnect', { connectId: start.connectId });
    await engine.advance(100);
    const frames = c.frames.filter(
      (f): f is Extract<Frame, { frame: 'connect' }> =>
        f.frame === 'connect' && f.connectId === start.connectId,
    );
    assert.ok(frames.length > 0, 'the flow reports through connect frames');
    for (const f of frames) {
      assert.equal(f.accountId, accountId, `the ${f.state} frame names the account`);
      assert.equal(f.mode, 'reconnect', `the ${f.state} frame keeps the flow's mode`);
    }
    assert.ok(frames.some(f => f.state === 'cancelled'));
  });

  /** FR-32: the bundle the engine builds passes the host's strict production parse. */
  scenario('diagnostics/strict-bundle', async (_e, c) => {
    parseDiagnosticsBundle(await c.call('Diagnostics/preview', {}));
  });

  /** FR-34: only the stand-in may hand the reader a `srcdoc`, and then with its own CSP. */
  scenario('mail/srcdoc-stand-in-only', async (engine, c) => {
    const message = await new SampleContext(c.session, async () => {}).message();
    const frame = await c.call('Mail/frame', { messageId: message, imagePolicy: 'block' });
    if (!engine.standIn) assert.equal(frame.srcdoc, undefined, 'the real engine never sets srcdoc');
    if (frame.srcdoc !== undefined)
      assert.match(
        frame.srcdoc,
        /<meta http-equiv="Content-Security-Policy" content="default-src 'none'[^"]*">/,
        'the stand-in document carries its own CSP',
      );
  });
}
