import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ContractError } from '@aplos/contract/contract-error';
import { quotedRanges } from '../../src/mail/body';
import { cacheKey } from '../../src/mail/render';
import { frameOf, IDS, mailWorld, type World } from './harness';

// `MessageBody/get`, `Message/get` and `MessageBody/prefetch` over the store and a fake provider.

async function withWorld(fn: (w: World) => Promise<void>) {
  const world = await mailWorld();
  try {
    await fn(world);
  } finally {
    await world.cleanup();
  }
}

/** Lets the prefetch work that runs behind the answer finish. */
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('MessageBody/get', () => {
  it('fetches an absent body through the provider, then serves it from the store', () =>
    withWorld(async w => {
      const body = await w.windowA.call('MessageBody/get', { messageId: IDS.remote });
      assert.deepEqual(body, {
        messageId: IDS.remote,
        bodyKind: 'html',
        text: 'Hello there\n> old words',
        quoted: [{ start: 12, end: 23 }],
        quotedCount: 1,
        hasRemoteImages: true,
      });
      assert.deepEqual(w.calls.opened, ['acct-1 t3 interactive']);
      await w.windowA.call('MessageBody/get', { messageId: IDS.remote });
      assert.equal(w.calls.opened.length, 1);
    }));

  it('answers plain text without rendering, and notFound for an unknown message', () =>
    withWorld(async w => {
      const body = (await w.windowA.call('MessageBody/get', { messageId: IDS.plain })) as {
        bodyKind: string;
        text: string;
      };
      assert.equal(body.bodyKind, 'text');
      assert.equal(body.text, 'Just text\n> quoted line');
      assert.equal(w.renders.length, 0);
      await assert.rejects(
        w.windowA.call('MessageBody/get', { messageId: 'acct-1:missing' }),
        (e: unknown) =>
          e instanceof ContractError &&
          e.type === 'notFound' &&
          e.message === 'This message is no longer available.',
      );
    }));

  it('drops quote ranges that do not fit the text', () => {
    const ranges = [
      { start: 0, end: 4 },
      { start: 2, end: 6 },
      { start: 6, end: 6 },
      { start: 7, end: 99 },
      { start: 1.5, end: 8 },
      null,
      { start: 8, end: 10 },
    ];
    assert.deepEqual(quotedRanges({ text: 'x'.repeat(10), quotedRanges: ranges as never }, 10), [
      { start: 0, end: 4 },
      { start: 8, end: 10 },
    ]);
  });
});

describe('Message/get', () => {
  it('returns stored headers and attachments, with unknown ids in notFound', () =>
    withWorld(async w => {
      const result = (await w.windowA.call('Message/get', {
        ids: [IDS.rich, IDS.remote, 'acct-1:missing', 'nope'],
      })) as { list: Record<string, unknown>[]; notFound: string[] };
      assert.deepEqual(result.notFound, ['acct-1:missing', 'nope']);
      const [rich, remote] = result.list;
      assert.equal(rich.id, IDS.rich);
      assert.equal(rich.threadId, 'acct-1:t1');
      assert.deepEqual(rich.from, { address: 'ada@corp.example', name: 'Sender' });
      assert.deepEqual(rich.to, [{ address: 'owner@mail.example' }]);
      assert.equal(rich.bodyState, 'present');
      assert.equal(rich.bodyKind, 'html');
      assert.deepEqual(rich.labels, ['acct-1:INBOX']);
      assert.deepEqual(rich.attachments, []);
      assert.equal(remote.bodyState, 'absent');
      assert.equal('bodyKind' in remote, false);
    }));
});

describe('MessageBody/prefetch', () => {
  it('fetches on the prefetch lane and warms the cache Mail/frame then hits', () =>
    withWorld(async w => {
      assert.deepEqual(await w.windowA.call('MessageBody/prefetch', { ids: [IDS.remote] }), {
        ok: true,
      });
      await settle();
      assert.deepEqual(w.calls.opened, ['acct-1 t3 prefetch']);
      const key = cacheKey({ messageId: IDS.remote, policy: 'block', quotesOpen: false }, 'v1');
      assert.ok(w.engine.services.mailFrames.cache.has(key));
      await frameOf(w.windowA, { messageId: IDS.remote, imagePolicy: 'block' });
      assert.equal(w.renders.length, 1, 'the frame used the warmed render');
    }));

  it('warms a thread by its newest message, and stops a cancelled warm-up', () =>
    withWorld(async w => {
      await w.windowA.call('MessageBody/prefetch', { threadIds: ['acct-1:t1'] });
      await settle();
      assert.equal(w.renders.length, 1);
      assert.deepEqual(w.calls.opened, [], 'a stored body needs no fetch');
      const pending = w.windowA.call('MessageBody/prefetch', { ids: [IDS.remote] });
      await w.windowA.call('MessageBody/prefetch', { ids: [IDS.remote], cancel: true });
      await pending;
      await settle();
      assert.equal(w.renders.length, 1, 'cancelled before it rendered');
    }));
});
