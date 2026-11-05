import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { IMAGE_PROXY_LIMITS } from '../../src/ports';
import { ACCOUNT, frameOf, IDS, mailWorld, serve, settle, text, type World } from './harness';
import { msg } from '../store/helpers';

// The slice-2 review's findings: closed windows, body identity in the cache key, toggles that re-resolve the policy,
// one reporter digest, and a bounded wait for inline parts.

async function withWorld(fn: (w: World) => Promise<void>, from?: string) {
  const world = await mailWorld(from ? { from } : {});
  try {
    await fn(world);
  } finally {
    await world.cleanup();
  }
}

describe('a closed window takes its tokens with it', () => {
  it('releases every token of the closed connection, and only those', () =>
    withWorld(async w => {
      const { tokens } = w.engine.services.mailFrames;
      const served = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      await serve(w, served.url, '', w.ids.windowA);
      const unserved = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'load' });
      const other = await frameOf(w.windowB, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.equal(tokens.liveCount(w.ids.windowA), 2);
      w.windowA.close();
      assert.equal(tokens.liveCount(w.ids.windowA), 0);
      const now = w.clock.now();
      for (const url of [served.url, unserved.url]) {
        assert.equal(tokens.lookup(w.ids.windowA, url.slice(15, -1), now), undefined);
        assert.equal(tokens.holdsDocument(w.ids.windowA, url.slice(15, -1), now), false);
      }
      assert.equal((await serve(w, served.url, 'cid/0', w.ids.windowA)).status, 404);
      assert.equal((await serve(w, other.url, '', w.ids.windowB)).status, 200, 'B unaffected');
    }));

  it('sweeps every window’s overdue unfetched tokens on each issue', () =>
    withWorld(async w => {
      const { tokens } = w.engine.services.mailFrames;
      await frameOf(w.windowB, { messageId: IDS.rich, imagePolicy: 'block' });
      w.clock.advance(60_000);
      await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.equal(tokens.liveCount(w.ids.windowB), 0, 'B’s overdue document is gone');
      assert.equal(tokens.liveCount(w.ids.windowA), 1);
    }));
});

describe('the render cache knows which stored copy it rendered', () => {
  it('renders again when a message is deleted and stored again with another body', () =>
    withWorld(async w => {
      const before = w.refOf(IDS.rich);
      await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      w.store.commit({
        opId: 'gone',
        origin: 'sync',
        writes: [{ kind: 'messageDelete', accountId: ACCOUNT, remoteId: 'r1' }],
      });
      const body = { html: '<p>A different body</p>', cidMap: {} };
      w.store.commit({
        opId: 'back',
        origin: 'sync',
        writes: [
          msg('r1', 't1', 0, { from: { address: 'ada@corp.example' } }),
          { kind: 'body', accountId: ACCOUNT, remoteId: 'r1', body },
        ],
      });
      const after = w.refOf(IDS.rich);
      assert.equal(
        after.rowId,
        before.rowId,
        'the freed rowid is reused: rowid alone is not enough',
      );
      const frame = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.equal(w.renders.length, 2);
      const html = text((await serve(w, frame.url, '', w.ids.windowA)).body);
      assert.match(html, /A different body/);
      assert.doesNotMatch(html, /Hello there/);
    }));

  it('does not miss on a flag change (the key has no rev)', () =>
    withWorld(async w => {
      await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      const flags = { seen: true, flagged: true, draft: false, fromMe: false };
      const write = msg('r1', 't1', 0, { from: { address: 'ada@corp.example' }, flags });
      w.store.commit({ opId: 'flag', origin: 'sync', writes: [write] });
      await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      assert.equal(w.renders.length, 1);
    }));
});

describe('Mail/toggleQuotes resolves the requested policy again', () => {
  it('blocks images once the sender is taken off the allow-list', () =>
    withWorld(async w => {
      await w.windowA.call('Mail/allowImages', {
        opId: 'on',
        sender: '@corp.example',
        allow: true,
      });
      const first = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
      await serve(w, first.url, '', w.ids.windowA);
      assert.equal((await serve(w, first.url, 'img/0', w.ids.windowA)).status, 200);
      await w.windowA.call('Mail/allowImages', {
        opId: 'off',
        sender: '@corp.example',
        allow: false,
      });
      const next = (await w.windowA.call('Mail/toggleQuotes', { url: first.url, open: true })) as {
        url: string;
      };
      const html = text((await serve(w, next.url, '', w.ids.windowA)).body);
      assert.doesNotMatch(html, /img\/0/);
      assert.equal((await serve(w, next.url, 'img/0', w.ids.windowA)).status, 404);
    }, 'ada@corp.example'));

  it('keeps an explicit "load" loading', () =>
    withWorld(async w => {
      const first = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'load' });
      const next = (await w.windowA.call('Mail/toggleQuotes', { url: first.url, open: true })) as {
        url: string;
      };
      await serve(w, next.url, '', w.ids.windowA);
      assert.equal((await serve(w, next.url, 'img/0', w.ids.windowA)).status, 200);
    }));
});

describe('Mail/serve hashes the reporter once', () => {
  it('digests at most once across many documents', () =>
    withWorld(async w => {
      const digest = mock.method(globalThis.crypto.subtle, 'digest');
      try {
        for (let i = 0; i < 20; i++) {
          const frame = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
          assert.equal((await serve(w, frame.url, '', w.ids.windowA)).status, 200);
        }
        assert.ok(digest.mock.callCount() <= 1, `${digest.mock.callCount()} digests`);
      } finally {
        digest.mock.restore();
      }
    }));
});

describe('an inline part has the proxy’s time limit', () => {
  function stalledStream(afterFirst: boolean) {
    const state = { returned: false };
    let sent = false;
    const iterator: AsyncIterator<Uint8Array> = {
      next() {
        if (afterFirst && !sent) {
          sent = true;
          return Promise.resolve({ done: false, value: new Uint8Array([0x89, 0x50]) });
        }
        return new Promise(() => undefined);
      },
      async return() {
        state.returned = true;
        return { done: true, value: undefined };
      },
    };
    return { state, stream: { [Symbol.asyncIterator]: () => iterator } };
  }

  for (const afterFirst of [false, true]) {
    it(`answers the 404 and closes a stream that stalls ${afterFirst ? 'mid-way' : 'at once'}`, () =>
      withWorld(async w => {
        const frame = await frameOf(w.windowA, { messageId: IDS.rich, imagePolicy: 'block' });
        await serve(w, frame.url, '', w.ids.windowA);
        const { state, stream } = stalledStream(afterFirst);
        w.setStream(() => stream);
        const pending = serve(w, frame.url, 'cid/0', w.ids.windowA);
        await settle();
        w.clock.advance(IMAGE_PROXY_LIMITS.timeoutMs - 1);
        await settle();
        assert.equal(state.returned, false, 'still waiting just before the limit');
        w.clock.advance(1);
        const answer = await pending;
        assert.equal(answer.status, 404);
        assert.equal(answer.body.length, 0);
        await settle();
        assert.equal(state.returned, true, 'the iterator was returned');
      }));
  }
});
