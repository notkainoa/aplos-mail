import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './gmail-helpers';

const DAY = 86400_000;

test('history ids increase but are not contiguous', async () => {
  const h = await setup({ threads: 10, unitsPerMinute: 10_000_000 });
  const mb = h.emu.mailbox;
  const start = (await h.api('/profile')).json.historyId;
  for (let i = 0; i < 40; i++) mb.addMessage({ subject: `Change ${i}`, text: 'x' });
  const { history } = (await h.api(`/history?startHistoryId=${start}&maxResults=500`)).json;
  const ids = history.map((r: any) => Number(r.id));
  assert.equal(ids.length, 40);
  const steps = ids.map((id: number, i: number) => id - (i ? ids[i - 1] : Number(start)));
  assert.ok(
    steps.every((s: number) => s >= 1 && s <= 7),
    `steps ${steps}`,
  );
  assert.ok(
    steps.some((s: number) => s > 1),
    'gaps appear',
  );
  assert.ok(new Set(steps).size > 2, 'the step is not constant');
});

test('history.list returns records strictly after the cursor, with the current historyId', async () => {
  const h = await setup({ threads: 5 });
  const mb = h.emu.mailbox;
  const first = mb.addMessage({ subject: 'one', text: 'x' });
  const second = mb.addMessage({ subject: 'two', text: 'x' });
  const afterFirst = first.historyId;
  const result = (await h.api(`/history?startHistoryId=${afterFirst}`)).json;
  assert.deepEqual(
    result.history.map((r: any) => r.messagesAdded[0].message.id),
    [second.id],
    'the record at the cursor itself is not repeated',
  );
  assert.equal(result.historyId, String(mb.history.currentId));
  assert.deepEqual(result.history[0].messages, [{ id: second.id, threadId: second.threadId }]);
  assert.deepEqual(result.history[0].messagesAdded[0].message.labelIds, ['INBOX']);
  const quiet = (await h.api(`/history?startHistoryId=${result.historyId}`)).json;
  assert.deepEqual(quiet, { historyId: result.historyId }, 'no records means no history key');
  assert.equal(h.emu.log.at(-1)!.units, 2);
});

test('label records carry labelIds and the message with its labels', async () => {
  const h = await setup({ threads: 5 });
  const mb = h.emu.mailbox;
  const m = mb.addMessage({ subject: 'x', text: 'x', labelIds: ['INBOX', 'UNREAD'] });
  const cursor = mb.history.currentId;
  mb.relabel({ messageIds: [m.id] }, ['STARRED'], ['UNREAD']);
  const { history } = (await h.api(`/history?startHistoryId=${cursor}`)).json;
  assert.equal(history.length, 2, 'one record for the addition, one for the removal');
  const added = history.find((r: any) => r.labelsAdded).labelsAdded[0];
  const removed = history.find((r: any) => r.labelsRemoved).labelsRemoved[0];
  assert.deepEqual(added.labelIds, ['STARRED']);
  assert.deepEqual(removed.labelIds, ['UNREAD']);
  assert.deepEqual(added.message, {
    id: m.id,
    threadId: m.threadId,
    labelIds: ['INBOX', 'STARRED'],
  });
});

test('historyTypes and labelId filters, repeated historyTypes, and paging', async () => {
  const h = await setup({ threads: 5, unitsPerMinute: 10_000_000 });
  const mb = h.emu.mailbox;
  const cursor = mb.history.currentId;
  const a = mb.addMessage({ subject: 'a', text: 'x', labelIds: ['INBOX'] });
  const b = mb.addMessage({ subject: 'b', text: 'x', labelIds: ['SENT'] });
  mb.relabel({ messageIds: [a.id] }, ['STARRED'], []);
  mb.deleteMessage(b.id);

  const kinds = async (query: string) =>
    (await h.api(`/history?startHistoryId=${cursor}&${query}`)).json.history.map(
      (r: any) => Object.keys(r).filter(k => k !== 'id' && k !== 'messages')[0],
    );
  assert.deepEqual(await kinds('historyTypes=messageAdded'), ['messagesAdded', 'messagesAdded']);
  assert.deepEqual(await kinds('historyTypes=labelAdded&historyTypes=messageDeleted'), [
    'labelsAdded',
    'messagesDeleted',
  ]);
  assert.equal((await h.api(`/history?startHistoryId=${cursor}&historyTypes=bogus`)).status, 400);

  const sentOnly = (await h.api(`/history?startHistoryId=${cursor}&labelId=SENT`)).json.history;
  assert.ok(
    sentOnly.every(
      (r: any) => JSON.stringify(r).includes(b.id) && !JSON.stringify(r).includes(a.id),
    ),
  );

  const page1 = (await h.api(`/history?startHistoryId=${cursor}&maxResults=2`)).json;
  assert.equal(page1.history.length, 2);
  const page2 = (
    await h.api(`/history?startHistoryId=${cursor}&maxResults=2&pageToken=${page1.nextPageToken}`)
  ).json;
  assert.equal(page2.history.length, 2);
  assert.equal(page2.nextPageToken, undefined);
  assert.equal((await h.api('/history')).status, 400, 'startHistoryId is required');
});

test('a cursor older than the retention horizon answers 404 notFound', async () => {
  const h = await setup({
    threads: 5,
    historyRetentionMs: 7 * DAY,
    unitsPerMinute: 10_000_000,
    testingMode: false,
  });
  const mb = h.emu.mailbox;
  const oldCursor = mb.history.currentId;
  await h.clock.advance(3 * DAY);
  mb.addMessage({ subject: 'midweek', text: 'x' });
  const midCursor = mb.history.currentId;
  await h.clock.advance(5 * DAY); // old cursor is now 8 days old, mid cursor 5
  mb.addMessage({ subject: 'late', text: 'x' });
  await h.renew();

  const stale = await h.api(`/history?startHistoryId=${oldCursor}`);
  assert.equal(stale.status, 404);
  assert.equal(stale.json.error.errors[0].reason, 'notFound');
  const fresh = await h.api(`/history?startHistoryId=${midCursor}`);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.history.length, 1);
});

test('a cursor that is current stays valid however long the mailbox was quiet', async () => {
  const h = await setup({ threads: 5, historyRetentionMs: 7 * DAY, testingMode: false });
  const cursor = h.emu.mailbox.history.currentId;
  await h.clock.advance(30 * DAY);
  await h.renew();
  assert.equal((await h.api(`/history?startHistoryId=${cursor}`)).status, 200);
});

test('expireHistory() makes every earlier cursor 404, and a fresh profile works again', async () => {
  const h = await setup({ threads: 5 });
  const mb = h.emu.mailbox;
  const cursor = (await h.api('/profile')).json.historyId;
  mb.addMessage({ subject: 'x', text: 'x' });
  const newest = mb.history.currentId;
  mb.expireHistory();
  assert.equal((await h.api(`/history?startHistoryId=${cursor}`)).status, 404);
  assert.equal(
    (await h.api(`/history?startHistoryId=${newest}`)).status,
    404,
    'even the newest cursor handed out before the purge',
  );
  const fresh = (await h.api('/profile')).json.historyId;
  assert.equal((await h.api(`/history?startHistoryId=${fresh}`)).status, 200);
  assert.equal(
    (await h.api(`/history?startHistoryId=${Number(fresh) + 1000}`)).status,
    404,
    'a cursor from the future is not valid either',
  );
});
