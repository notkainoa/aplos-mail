/**
 * Emulator option `searchLagMs`: a message `messages.send` just made stays out of every `messages.list` result (by `q`
 * or by label) for that many ms of the emulator's clock, while `messages.get` sees it at once. Live 2026-11-05: the
 * sent copy showed on the 4th search, a few seconds late. Default 0 hides nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './gmail-helpers';

const MESSAGE = (subject: string) =>
  Buffer.from(
    `To: friend@example.test\r\nSubject: ${subject}\r\nMessage-ID: <lag-${subject}@mail.example.test>\r\n\r\nbody`,
  );

const sendIt = async (h: Awaited<ReturnType<typeof setup>>, subject: string) => {
  const sent = await h.api('/messages/send', {
    method: 'POST',
    body: { raw: MESSAGE(subject).toString('base64url') },
  });
  assert.equal(sent.status, 200);
  return sent.json.id as string;
};

const listed = async (h: Awaited<ReturnType<typeof setup>>, query: string) =>
  ((await h.api(`/messages?${query}`)).json.messages ?? []).map((m: { id: string }) => m.id);

test('searchLagMs: a sent message is hidden from list (by q and by label) until the lag has passed, but get finds it at once', async () => {
  const h = await setup({ searchLagMs: 5_000 });
  const id = await sendIt(h, 'one');
  assert.deepEqual(await listed(h, 'labelIds=SENT'), [], 'hidden by label');
  assert.deepEqual(await listed(h, 'q=subject:one'), [], 'hidden by search');
  assert.equal((await h.api(`/messages/${id}?format=minimal`)).status, 200, 'get sees it');
  await h.clock.advance(4_000);
  assert.deepEqual(await listed(h, 'labelIds=SENT'), [], 'still inside the lag');
  await h.clock.advance(1_000);
  assert.deepEqual(await listed(h, 'labelIds=SENT'), [id], 'shown once the lag has passed');
  assert.deepEqual(await listed(h, 'q=subject:one'), [id]);
});

test('searchLagMs: mail that was not sent through the API (an inserted message) is never hidden', async () => {
  const h = await setup({ searchLagMs: 60_000 });
  const inbound = h.emu.mailbox.addMessage({
    from: 'someone@example.test',
    to: ['owner@example.test'],
    labelIds: ['INBOX'],
    subject: 'inbound',
  });
  await sendIt(h, 'two');
  assert.deepEqual(await listed(h, 'labelIds=INBOX'), [inbound.id]);
});

test('searchLagMs: the default hides nothing', async () => {
  const h = await setup();
  const id = await sendIt(h, 'three');
  assert.deepEqual(await listed(h, 'labelIds=SENT'), [id]);
});

test('searchLagMs: a live change of the setting takes effect on the next list', async () => {
  const h = await setup();
  const id = await sendIt(h, 'four');
  h.emu.settings.searchLagMs = 10_000;
  assert.deepEqual(await listed(h, 'labelIds=SENT'), [], 'the new lag applies to the earlier send');
  h.emu.settings.searchLagMs = 0;
  assert.deepEqual(await listed(h, 'labelIds=SENT'), [id]);
});
