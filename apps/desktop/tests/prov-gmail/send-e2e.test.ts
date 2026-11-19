/**
 * Through the real engine on the Gmail emulator: an uncertain send (the answer is lost) whose Sent copy Gmail gave
 * another Message-ID and whose search index lags is settled `sent` by the adapter's `X-Aplos-Send` token, with exactly
 * one message in Sent. The adapter stamps the token at transmit (providers #224/#226); the engine is untouched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { inWorld, T0, SEC } from '../../../../packages/engine/tests/outbox/helpers';
import { sendWorld } from './send-rig';

/** Lets the engine and the emulator's HTTP server run (real time) until `done`, settling the fake clock's work. */
async function until(done: () => boolean) {
  for (let i = 0; i < 2000 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(done(), 'the engine got there');
}

const bare = (id: string) => id.trim().replace(/^<|>$/g, '').toLowerCase();
const tokensOf = (raw: Buffer) =>
  raw
    .toString('latin1')
    .split('\r\n\r\n')[0]
    .split('\r\n')
    .filter(line => line.toLowerCase().startsWith('x-aplos-send:'))
    .map(line => bare(line.slice('x-aplos-send:'.length)));

test('engine: an uncertain Gmail send (answer lost, Message-ID rewritten, index lagging) is settled found -> sent by the token, exactly one message in Sent', async () => {
  const gmail = await sendWorld({
    sendIdentity: 'rewritten',
    searchLagMs: 5_000,
    user: { sub: 'e2e-owner', email: 'owner@mail.example', name: 'Owner' },
    clockStart: T0,
  });
  await inWorld(
    async w => {
      w.draft('d1');
      // Gmail applies the send; the answer is a truncated body, so the outcome is unknown.
      gmail.bridge.failNext = 'corrupt';
      const submitted = await w.send(w.first, 'd1');
      await w.clock.advance(10 * SEC);
      await until(() => w.events('send.reconciled').length >= 1);
      assert.equal(w.get(submitted.id).state, 'uncertain');
      // The first check runs at once and sees nothing yet (the index lags the send by 5 s); one pass, no waiting.
      assert.equal(w.get(submitted.id).state, 'uncertain');
      assert.equal(w.events('send.reconciled')[0].data.found, false);
      // The engine's own re-check 60 s later finds the copy by its token.
      for (let step = 0; step < 14 && w.get(submitted.id).state !== 'sent'; step++) {
        // Two clocks: the engine's, and the emulator's (the index lag and the adapter's windows run on it).
        await gmail.clock.advance(5 * SEC);
        await w.clock.advance(5 * SEC);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      await until(() => w.get(submitted.id).state === 'sent');
      const sent = gmail.sentMessages();
      assert.equal(sent.length, 1, 'one message in Sent');
      assert.equal(gmail.sendRequests(), 1, 'one send request, ever');
      assert.notEqual(
        sent[0].messageId.toLowerCase(),
        bare(submitted.internetId),
        'Gmail rewrote the id',
      );
      assert.deepEqual(tokensOf(sent[0].raw), [bare(submitted.internetId)]);
      assert.equal(
        w.raw(submitted.id)!.remote_message_id,
        sent[0].id,
        'the Sent copy found by the token',
      );
      assert.equal(w.events('send.reconciled').at(-1)!.data.found, true);
      // Nothing more happens on its own.
      await w.clock.advance(10 * 60 * SEC);
      await w.settle();
      assert.equal(gmail.sendRequests(), 1);
      assert.equal(gmail.sentMessages().length, 1);
    },
    { send: gmail.port },
  );
});
