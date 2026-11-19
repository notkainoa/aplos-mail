import test from 'node:test';
import assert from 'node:assert/strict';
import { handlers, type EngineServices, type MethodContext } from '../../src/methods/index';
import type { Admission } from '../../src/ports';

type Req = { scope?: string; manual: boolean; force?: boolean };

function fakeContext(answers: Record<string, Admission>, forced: Record<string, Admission> = {}) {
  const calls: Array<[string, Req]> = [];
  const accounts = {
    request(id: string, req: Req) {
      calls.push([id, req]);
      return (req.force ? forced[id] : undefined) ?? answers[id] ?? { ok: true };
    },
    requestAll: () => answers,
  };
  const services = { accounts } as unknown as EngineServices;
  return { calls, ctx: { services } as MethodContext };
}

const paused: Admission = { ok: false, cls: 'throttle', reason: 'pausedUntilRetry', until: 900 };
const run = (ctx: MethodContext, args: Record<string, unknown>) =>
  handlers['Sync/request'](args as never, ctx);

test('a manual sync is accepted when the governor admits it', async () => {
  const { ctx, calls } = fakeContext({ a1: { ok: true } });
  assert.deepEqual(await run(ctx, { accountId: 'a1' }), {
    accounts: [{ accountId: 'a1', accepted: true }],
  });
  assert.deepEqual(calls, [['a1', { manual: true, force: undefined }]]);
});

test('a paused account answers with its reason and resume time and no extra call', async () => {
  const { ctx } = fakeContext({ a1: paused });
  assert.deepEqual(await run(ctx, { accountId: 'a1' }), {
    accounts: [{ accountId: 'a1', accepted: false, reasonCode: 'pausedUntilRetry', resumeAt: 900 }],
  });
});

test('without an account every started account is asked; force retries only the refused ones', async () => {
  const { ctx, calls } = fakeContext({ a1: { ok: true }, a2: paused }, { a2: { ok: true } });
  const out = await run(ctx, { force: true });
  assert.deepEqual(out, {
    accounts: [
      { accountId: 'a1', accepted: true },
      { accountId: 'a2', accepted: true },
    ],
  });
  assert.deepEqual(calls, [['a2', { manual: true, force: true }]]);
  const plain = fakeContext({ a2: paused });
  assert.equal(((await run(plain.ctx, {})) as { accounts: unknown[] }).accounts.length, 1);
  assert.deepEqual(plain.calls, []);
});
