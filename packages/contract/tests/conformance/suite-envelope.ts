import assert from 'node:assert/strict';
import {
  checkResult,
  ContractError,
  ErrorBodySchema,
  Frame,
  methodsByArea,
  type EngineMethodName,
} from '../../src/index';
import { runLast, SampleContext, samples, opId } from './samples';
import { rejects, type SuiteTools } from './suite-helpers';

/** Envelopes, error types, and the coverage exercise of every method on the demo data. */
export function envelopeSuite({ target, testIds, test, check, scenario, open }: SuiteTools) {
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
}
