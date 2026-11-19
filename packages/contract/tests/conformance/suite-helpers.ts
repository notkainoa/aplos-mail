import nodeTest, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkResult,
  ContractError,
  ErrorBodySchema,
  Frame,
  type EngineMethodName,
  type Input,
  type Output,
} from '../../src/index';
import type { EngineSession } from '../../src/client/index';
import { listenerCaller } from '../../src/access';
import { SampleContext, opId } from './samples';
import type { ConformanceTarget, EngineUnderTest } from './target';

export type Body = (t: TestContext) => Promise<void>;
export type Register = (name: string, fn: Body) => unknown;

/** A connection with its frames recorded in arrival order, and typed calls. */
export function open(engine: EngineUnderTest) {
  return openSession(engine.connection.connect());
}
export function openSession(session: EngineSession) {
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

export type Connection = ReturnType<typeof open>;

export async function rejects(promise: Promise<unknown>, type: string) {
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

export type Check = (register: Register, id: string, body: Body) => unknown;
export type Scenario = (
  id: string,
  body: (engine: EngineUnderTest, c: Connection, t: TestContext) => Promise<void>,
  skip?: (e: EngineUnderTest) => string | false,
) => unknown;

/** What the topic modules register their scenarios with. */
export interface SuiteTools {
  target: ConformanceTarget;
  testIds: Set<string>;
  test: typeof nodeTest;
  check: Check;
  scenario: Scenario;
  open: typeof open;
  openSession: typeof openSession;
}

/**
 * The freeze-rule helpers (plans/freeze/findings.md) shared by the send and access scenarios.
 */
export function freezeTools(target: ConformanceTarget) {
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
  const send = async (c: Connection, notBefore?: number) => {
    await c.call('Settings/set', { opId: opId(), patch: { mail: { undoSendSeconds: 10 } } });
    const ctx = new SampleContext(c.session, async () => {});
    const draft = await ctx.draft();
    const out = await c.call('Submission/set', {
      opId: opId('send'),
      action: { type: 'send', draftId: draft.id, revision: draft.revision, notBefore },
    });
    return { draft, ...out };
  };
  const submission = async (c: Connection, id: string) =>
    (await c.call('Submission/get', { ids: [id] })).list[0]!;
  return { listener, noCaller, hour, send, submission };
}
