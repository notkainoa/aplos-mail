/**
 * The body cache's recovery from a failed load (fix-bodies R1/R2, 2026-11-11): a failed letter used to stay failed until
 * the owner pressed Try again, so one Gmail pause or engine restart showed "Couldn't load this email." on every reopen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BodyStore } from './bodies';
import type { DataClient } from './client';
import { createEmitter } from './emitter';
import { createManualTimers } from './scheduler';

type Answer = { ok: true } | { ok: false; error: unknown };

/** A client whose `MessageBody/get` answers from a script, one entry per call. */
function scriptedClient(answers: Answer[]) {
  const calls: string[] = [];
  const client = {
    call: async (method: string, args: { messageId: string }) => {
      calls.push(`${method} ${args.messageId}`);
      const answer = answers.shift() ?? { ok: true };
      if (!answer.ok) throw answer.error;
      return { messageId: args.messageId, bodyKind: 'text', text: 'Hi', quoted: [] };
    },
  } as unknown as DataClient;
  return { client, calls };
}

const failure = (body: object) => ({ ok: false as const, error: { body } });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('a failed letter is asked again when it is opened again', async () => {
  const { client, calls } = scriptedClient([
    failure({ type: 'unavailable', message: 'The mailbox is restarting.' }),
  ]);
  const store = new BodyStore(client, createEmitter(), createManualTimers());
  const release = store.retain('m1');
  await flush();
  assert.equal(store.get('m1').status, 'failed');
  release();
  const again = store.retain('m1');
  await flush();
  assert.equal(calls.length, 2, 'the reopen asked again');
  assert.equal(store.get('m1').status, 'ready');
  again();
});

test('a second reader of an open letter does not ask again', async () => {
  const { client, calls } = scriptedClient([failure({ type: 'internal', message: 'x' })]);
  const store = new BodyStore(client, createEmitter(), createManualTimers());
  store.retain('m1');
  await flush();
  store.retain('m1');
  await flush();
  assert.equal(calls.length, 1, 'Try again stays the way to ask while it is on screen');
  assert.equal(store.get('m1').status, 'failed');
});

test('a letter refused by an account pause is asked again when the pause ends, while it is open', async () => {
  const timers = createManualTimers(1_000);
  const { client, calls } = scriptedClient([
    failure({ type: 'paused', message: 'Aplos is waiting.', resumeAt: 61_000 }),
  ]);
  const store = new BodyStore(client, createEmitter(), timers);
  store.retain('m1');
  await flush();
  assert.equal(store.get('m1').status, 'failed');
  timers.advance(59_999);
  await flush();
  assert.equal(calls.length, 1, 'nothing before the pause ends');
  timers.advance(2_000);
  await flush();
  assert.equal(calls.length, 2, 'asked again once the pause is over');
  assert.equal(store.get('m1').status, 'ready');
});

test('a paused letter that was closed waits for its next open instead', async () => {
  const timers = createManualTimers(1_000);
  const { client, calls } = scriptedClient([
    failure({ type: 'paused', message: 'Aplos is waiting.', resumeAt: 61_000 }),
  ]);
  const store = new BodyStore(client, createEmitter(), timers);
  const release = store.retain('m1');
  await flush();
  release();
  timers.advance(120_000);
  await flush();
  assert.equal(calls.length, 1, 'no fetch for a letter nobody has open');
});
