/**
 * "Try demo mail" on the REAL composed engine (compose.ts, over real MessagePorts), the way the renderer drives it: the
 * reader opens a thread (`Thread/open`) and the composer sends with an undo window (`Submission/set` with `notBefore`).
 * Demo accounts have no provider, so before the fix the open answered `internal` (demo threads were stored partial and
 * the engine asked the missing provider for them) and a send stayed `queued` forever (the send port answered
 * `accountNotStarted`). The reader hid the first (`.catch(() => undefined)`), so only scripted checks saw it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeWindow, mainSide } from './rig';

/** The answer fields these checks read, across the methods they call. */
interface Answer {
  accountIds: string[];
  ids: string[];
  complete: boolean;
  draft: { id: string; revision: number };
  submission: { id: string; state: string };
  list: { state?: string; subject?: string }[];
}

async function demoWorld(t: import('node:test').TestContext) {
  const main = mainSide(t);
  await (
    await main.supervisor.start()
  ).ready;
  const one = fakeWindow(1);
  main.broker.connect(one.win);
  const call = (method: string, args: unknown = {}) =>
    one.client.call(method as never, args as never) as Promise<Answer>;
  const demo = await call('Demo/load', {});
  return { main, call, accountIds: demo.accountIds as string[] };
}

test('demo mail on the real engine: Thread/open completes a demo thread with no provider', async t => {
  const { call } = await demoWorld(t);
  const inbox = (await call('View/query', { spec: { kind: 'mailbox', role: 'inbox' } })).ids;
  assert.ok(inbox.length > 0);
  for (const threadId of inbox) {
    const opened = await call('Thread/open', { threadId });
    assert.equal(opened.complete, true, `${threadId} opens complete`);
  }
  const messages = (await call('View/query', { spec: { kind: 'thread', threadId: inbox[0] } })).ids;
  assert.ok(messages.length > 0, 'the opened thread lists its messages');
});

test('demo mail on the real engine: a send with Undo reaches sent and is filed in Sent', async t => {
  const { main, call, accountIds } = await demoWorld(t);
  const sentBefore = (await call('View/query', { spec: { kind: 'mailbox', role: 'sent' } })).ids;
  const draft = (
    await call('Draft/set', {
      opId: 'demo-draft-1',
      fields: {
        accountId: accountIds[0],
        mode: 'new',
        to: [{ address: 'reader@verification.example', name: 'Reader' }],
        cc: [],
        bcc: [],
        subject: 'Demo send check',
        html: '<p>Original synthetic demo send.</p>',
        attachments: [],
        signature: false,
      },
    })
  ).draft;
  // The composer's own call: Send now, held for the undo window.
  const queued = (
    await call('Submission/set', {
      opId: 'demo-send-1',
      action: {
        type: 'send',
        draftId: draft.id,
        revision: draft.revision,
        notBefore: main.clock.now(),
      },
    })
  ).submission;
  assert.equal(queued.state, 'queued');
  const state = async () => (await call('Submission/get', { ids: [queued.id] })).list[0]?.state;
  for (let i = 0; i < 60 && (await state()) !== 'sent'; i++) {
    await main.clock.advance(1000);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(await state(), 'sent');

  const sentAfter = (await call('View/query', { spec: { kind: 'mailbox', role: 'sent' } })).ids;
  const added = sentAfter.filter((id: string) => !sentBefore.includes(id));
  assert.equal(added.length, 1, 'the sent message is in Sent');
  const row = (await call('Thread/get', { ids: added })).list[0];
  assert.equal(row.subject, 'Demo send check');
  assert.equal((await call('Thread/open', { threadId: added[0] })).complete, true);
  // The draft leaves Drafts once its send went out.
  for (let i = 0; i < 20; i++) {
    if ((await call('Draft/get', { ids: [draft.id] })).list.length === 0) break;
    await main.clock.advance(1000);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await call('Draft/get', { ids: [draft.id] })).list.length, 0);
});
