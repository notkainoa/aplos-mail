import test from 'node:test';
import assert from 'node:assert/strict';
import { batchRefusalProbability } from '../src/gmail';
import { sendBatch, setup } from './gmail-helpers';

test('each batch part is answered, metered and logged on its own', async () => {
  const h = await setup({ threads: 6, unitsPerMinute: 10_000_000 });
  const ids = (await h.api('/messages?maxResults=2')).json.messages.map(
    (m: any) => m.id,
  ) as string[];
  h.emu.log.length = 0;
  const { status, answers } = await sendBatch(h.emu, h.token, [
    {
      path: `/messages/${ids[0]}?format=metadata&metadataHeaders=Subject&fields=id,payload/headers`,
    },
    { path: '/messages/00000000000000ff?format=minimal' }, // well-formed but unknown
    { path: `/messages/${ids[1]}/modify`, method: 'POST', body: { addLabelIds: ['STARRED'] } },
    { path: '/profile' },
  ]);
  assert.equal(status, 200);
  assert.deepEqual(
    answers.map(a => a.contentId),
    ['item1', 'item2', 'item3', 'item4'],
  );
  assert.deepEqual(
    answers.map(a => a.status),
    [200, 404, 200, 200],
  );
  assert.deepEqual(
    Object.keys(answers[0].json).sort(),
    ['id', 'payload'],
    'fields masks apply inside batch parts',
  );
  assert.equal(answers[1].json.error.errors[0].reason, 'notFound');
  assert.ok(h.emu.mailbox.getMessage(ids[1])!.labelIds.includes('STARRED'));

  const batchEntry = h.emu.log.find(e => e.apiMethod === 'gmail.batch')!;
  const parts = h.emu.log.filter(e => e.batch === batchEntry.seq);
  assert.deepEqual(
    parts.map(p => [p.apiMethod, p.units, p.status]),
    [
      ['gmail.users.messages.get', 20, 200],
      ['gmail.users.messages.get', 20, 404],
      ['gmail.users.messages.modify', 5, 200],
      ['gmail.users.getProfile', 1, 200],
    ],
  );
  assert.equal(batchEntry.units, 0, 'the envelope is free; the parts pay');
});

test('batching saves round trips, not quota: parts hit the unit meter one by one', async () => {
  const h = await setup({ threads: 4, unitsPerMinute: 45 });
  const id = (await h.api('/messages?maxResults=1')).json.messages[0].id; // 5 units
  const { answers } = await sendBatch(h.emu, h.token, [
    { path: `/messages/${id}?format=metadata` }, // 20 -> 25
    { path: `/messages/${id}?format=metadata` }, // 20 -> 45
    { path: `/messages/${id}?format=metadata` }, // refused
    { path: '/profile' }, // also refused, the window is full
  ]);
  assert.deepEqual(
    answers.map(a => a.status),
    [200, 200, 403, 403],
  );
  assert.equal(answers[2].json.error.errors[0].reason, 'rateLimitExceeded');
  assert.equal(h.emu.meter.unitsInWindow(), 45);
});

test('more than 100 parts is a 400, exactly 100 is fine', async () => {
  const h = await setup({ unitsPerMinute: 10_000_000 });
  const tooMany = await sendBatch(
    h.emu,
    h.token,
    Array.from({ length: 101 }, () => ({ path: '/profile' })),
  );
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.json.error.message, /more than 100/);
  const hundred = await sendBatch(
    h.emu,
    h.token,
    Array.from({ length: 100 }, () => ({ path: '/labels/INBOX' })),
  );
  assert.equal(hundred.status, 200);
  assert.equal(hundred.answers.length, 100);
  assert.equal((await sendBatch(h.emu, h.token, [])).status, 400);
});

test('batch needs credentials', async () => {
  const h = await setup();
  const response = await sendBatch(h.emu, 'not-a-token', [{ path: '/profile' }]);
  assert.equal(response.status, 401);
});

test('the refusal probability curve: none up to 10, about 1.2% at 25, about 19% at 50', () => {
  for (const size of [1, 5, 10]) assert.equal(batchRefusalProbability(size), 0);
  assert.ok(Math.abs(batchRefusalProbability(25) - 0.012) < 1e-9);
  assert.ok(Math.abs(batchRefusalProbability(50) - 0.19) < 1e-9);
  const between = batchRefusalProbability(17);
  assert.ok(between > 0 && between < 0.012);
  assert.ok(batchRefusalProbability(37) > 0.012 && batchRefusalProbability(37) < 0.19);
  assert.ok(batchRefusalProbability(100) > 0.19);
});

async function refusalRate(
  size: number,
  batches: number,
  seed: number,
): Promise<{ rate: number; pattern: number[] }> {
  const h = await setup({ seed, unitsPerMinute: 100_000_000, concurrency: 1000 });
  let refused = 0;
  const pattern: number[] = [];
  for (let i = 0; i < batches; i++) {
    const { answers } = await sendBatch(
      h.emu,
      h.token,
      Array.from({ length: size }, () => ({ path: '/profile' })),
    );
    assert.equal(answers.length, size);
    for (const [index, answer] of answers.entries()) {
      if (answer.status === 429) {
        refused++;
        if (i < 5) pattern.push(i * size + index);
        assert.equal(answer.json.error.errors[0].reason, 'rateLimitExceeded');
        assert.equal(answer.json.error.status, 'RESOURCE_EXHAUSTED');
      } else {
        assert.equal(answer.status, 200);
      }
    }
  }
  return { rate: refused / (size * batches), pattern };
}

test('batches of 10 or fewer are never refused by the curve', async () => {
  assert.equal((await refusalRate(10, 40, 1)).rate, 0);
});

test('batches of 25 are refused about 1.2% of the time, batches of 50 about 19%', async () => {
  const at25 = await refusalRate(25, 120, 1);
  assert.ok(at25.rate > 0.004 && at25.rate < 0.025, `rate at 25: ${at25.rate}`);
  const at50 = await refusalRate(50, 60, 1);
  assert.ok(at50.rate > 0.15 && at50.rate < 0.23, `rate at 50: ${at50.rate}`);
});

test('the refusal curve is deterministic for a seed', async () => {
  const a = await refusalRate(50, 5, 9);
  const b = await refusalRate(50, 5, 9);
  const c = await refusalRate(50, 5, 10);
  assert.deepEqual(a.pattern, b.pattern);
  assert.notDeepEqual(a.pattern, c.pattern);
  assert.ok(a.pattern.length > 0);
});
