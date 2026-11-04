import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { parseFrameUrl } from '../../src/frame/paths';
import { FrameTokens, MAX_TOKENS_PER_WINDOW, UNFETCHED_TTL_MS } from '../../src/frame/tokens';
import { render } from './fixtures';

// The token registry: random, per window, single render, capped, released, replaced, expired.

describe('frame tokens', () => {
  it('issues 128-bit lowercase hex tokens in a document URL', () => {
    const tokens = new FrameTokens();
    const issued = tokens.issue(render(), 1_000);
    assert.match(issued.token, /^[0-9a-f]{32}$/);
    assert.equal(issued.url, `aplos-mail://m/${issued.token}/`);
    assert.deepEqual(parseFrameUrl(issued.url)?.token, issued.token);
    assert.equal(issued.expiresAt, 1_000 + UNFETCHED_TTL_MS);
    assert.equal(UNFETCHED_TTL_MS, 60_000);
  });

  it('draws every token from Web Crypto by default', () => {
    const spy = mock.method(globalThis.crypto, 'getRandomValues');
    try {
      const issued = new FrameTokens().issue(render(), 0);
      assert.equal(spy.mock.callCount(), 1);
      const filled = spy.mock.calls[0].arguments[0] as Uint8Array;
      assert.equal(filled.length, 16);
      assert.equal(issued.token, [...filled].map(b => b.toString(16).padStart(2, '0')).join(''));
    } finally {
      spy.mock.restore();
    }
  });

  it('ignores an option named like the old injection (only the test-only name is honoured)', () => {
    const spy = mock.method(globalThis.crypto, 'getRandomValues');
    try {
      const options = { random: (b: Uint8Array) => b.fill(1) } as never;
      assert.notEqual(new FrameTokens(options).issue(render(), 0).token, '01'.repeat(16));
      assert.equal(spy.mock.callCount(), 1);
    } finally {
      spy.mock.restore();
    }
  });

  it('draws every token from the test source when one is injected, 16 bytes at a time', () => {
    const sizes: number[] = [];
    const tokens = new FrameTokens({
      insecureTestRandom: bytes => {
        sizes.push(bytes.length);
        bytes.fill(0xab);
      },
    });
    assert.equal(tokens.issue(render(), 0).token, 'ab'.repeat(16));
    assert.deepEqual(sizes, [16]);
  });

  it('never hands out a live token twice, even when the source repeats', () => {
    let calls = 0;
    const tokens = new FrameTokens({
      insecureTestRandom: bytes => bytes.fill(calls++ < 2 ? 1 : 2),
    });
    const a = tokens.issue(render({ windowId: 'w1' }), 0);
    const b = tokens.issue(render({ windowId: 'w2' }), 0);
    assert.notEqual(a.token, b.token);
    const stuck = new FrameTokens({ insecureTestRandom: bytes => bytes.fill(9) });
    stuck.issue(render(), 0);
    assert.throws(() => stuck.issue(render(), 0), /repeats/);
  });

  it('gives unique tokens over many renders', () => {
    const tokens = new FrameTokens();
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) seen.add(tokens.issue(render({ windowId: `w${i}` }), 0).token);
    assert.equal(seen.size, 2_000);
  });

  it('keeps the render record frozen and complete', () => {
    const tokens = new FrameTokens();
    const images = ['https://a.example/x.png'];
    const { token } = tokens.issue(
      render({ imagePolicy: 'allow', findQuery: 'q', quotesOpen: true, remoteImages: images }),
      5,
    );
    images.push('https://evil.example/');
    const record = tokens.lookup('w1', token, 5);
    assert.ok(record);
    assert.deepEqual(record.remoteImages, ['https://a.example/x.png']);
    assert.equal(record.bodyKind, 'html');
    assert.equal(record.createdAt, 5);
    assert.equal(record.findQuery, 'q');
    assert.equal(record.quotesOpen, true);
    assert.equal(record.accountScope, 'acct-1');
    assert.ok(Object.isFrozen(record) && Object.isFrozen(record.remoteImages));
  });

  it('serves the document once (single render)', () => {
    const tokens = new FrameTokens();
    const { token } = tokens.issue(render(), 0);
    assert.equal(
      tokens.forResource('w1', token, 0),
      undefined,
      'no sub-resource before the document',
    );
    assert.ok(tokens.takeDocument('w1', token, 0));
    assert.equal(tokens.takeDocument('w1', token, 1), undefined);
    assert.ok(tokens.forResource('w1', token, 1), 'sub-resources while the token lives');
  });

  it('refuses a token from another window, without spending it', () => {
    const tokens = new FrameTokens();
    const { token } = tokens.issue(render({ windowId: 'w1' }), 0);
    assert.equal(tokens.lookup('w2', token, 0), undefined);
    assert.equal(tokens.takeDocument('w2', token, 0), undefined);
    assert.equal(tokens.release('w2', token), false);
    assert.ok(tokens.takeDocument('w1', token, 0), 'still usable by its own window');
    assert.equal(tokens.forResource('w2', token, 0), undefined);
  });

  it('expires an unfetched token on the injected clock', () => {
    const tokens = new FrameTokens({ ttlMs: 100 });
    const { token } = tokens.issue(render(), 1_000);
    assert.ok(tokens.lookup('w1', token, 1_099));
    assert.equal(tokens.lookup('w1', token, 1_100), undefined);
    assert.equal(tokens.liveCount('w1'), 0, 'an expired token is deleted');
    const late = tokens.issue(render(), 2_000);
    assert.equal(
      tokens.takeDocument('w1', late.token, 2_000 + 100),
      undefined,
      'document too late',
    );
  });

  it('keeps a served token past the deadline, for the lazy images of a message left open', () => {
    const tokens = new FrameTokens();
    const { token } = tokens.issue(render(), 0);
    assert.ok(tokens.takeDocument('w1', token, UNFETCHED_TTL_MS - 1));
    const hours = 6 * 60 * 60 * 1000;
    assert.ok(tokens.forResource('w1', token, hours), 'sub-resources hours later');
    tokens.sweep(hours);
    tokens.issue(render(), hours);
    assert.ok(tokens.forResource('w1', token, hours + 1), 'neither a sweep nor an issue drops it');
    assert.equal(tokens.release('w1', token), true, 'release still ends it');
    assert.equal(tokens.forResource('w1', token, hours + 1), undefined);
  });

  it('releases by URL or token, only in its own window', () => {
    const tokens = new FrameTokens();
    const a = tokens.issue(render(), 0);
    const b = tokens.issue(render(), 0);
    assert.equal(tokens.release('w1', a.url), true);
    assert.equal(tokens.release('w1', b.token), true);
    assert.equal(tokens.lookup('w1', a.token, 0), undefined);
    assert.equal(tokens.lookup('w1', b.token, 0), undefined);
    assert.equal(tokens.release('w1', a.url), false, 'a second release is a no-op');
    assert.equal(tokens.release('w1', `${a.url}cid/0`), false);
    assert.equal(tokens.release('w1', 'garbage'), false);
  });

  it('frees the old token on replace, and on a newer render for the same slot', () => {
    const tokens = new FrameTokens();
    const first = tokens.issue(render({ slot: 'reader' }), 0);
    const other = tokens.issue(render({ slot: 'popout' }), 0);
    const second = tokens.issue(render({ slot: 'reader' }), 0);
    assert.equal(tokens.lookup('w1', first.token, 0), undefined);
    assert.ok(tokens.lookup('w1', second.token, 0));
    assert.ok(tokens.lookup('w1', other.token, 0));
    const third = tokens.replace(second.url, render(), 0);
    assert.equal(tokens.lookup('w1', second.token, 0), undefined);
    assert.ok(tokens.lookup('w1', third.token, 0));
  });

  it('does not let another window replace or slot-evict a token', () => {
    const tokens = new FrameTokens();
    const mine = tokens.issue(render({ windowId: 'w1', slot: 'reader' }), 0);
    tokens.replace(mine.url, render({ windowId: 'w2' }), 0);
    tokens.issue(render({ windowId: 'w2', slot: 'reader' }), 0);
    assert.ok(tokens.lookup('w1', mine.token, 0));
  });

  it(`keeps at most ${MAX_TOKENS_PER_WINDOW} live per window; the next evicts the oldest`, () => {
    const tokens = new FrameTokens();
    const issued = Array.from({ length: MAX_TOKENS_PER_WINDOW }, (_, i) =>
      tokens.issue(render({ messageId: `m${i}` }), i),
    );
    const other = tokens.issue(render({ windowId: 'w2' }), 0);
    assert.equal(tokens.liveCount('w1'), MAX_TOKENS_PER_WINDOW);
    const next = tokens.issue(render(), 100);
    assert.equal(tokens.liveCount('w1'), MAX_TOKENS_PER_WINDOW);
    assert.equal(tokens.lookup('w1', issued[0].token, 100), undefined, 'oldest evicted');
    assert.ok(tokens.lookup('w1', issued[1].token, 100));
    assert.ok(tokens.lookup('w1', next.token, 100));
    assert.ok(tokens.lookup('w2', other.token, 100), 'other windows are untouched');
    for (let i = 0; i < 200; i++) tokens.issue(render(), 200 + i);
    assert.equal(tokens.liveCount('w1'), MAX_TOKENS_PER_WINDOW);
  });

  it('sweeps expired tokens before counting toward the cap', () => {
    const tokens = new FrameTokens({ ttlMs: 10, maxPerWindow: 2 });
    tokens.issue(render(), 0);
    const kept = tokens.issue(render(), 5);
    tokens.issue(render(), 12);
    assert.ok(tokens.lookup('w1', kept.token, 12), 'the expired one went, not the live one');
    tokens.sweep(1_000);
    assert.equal(tokens.liveCount('w1'), 0);
  });

  it('lets the cap, not the clock, end a served token', () => {
    const tokens = new FrameTokens({ ttlMs: 10, maxPerWindow: 2 });
    const served = tokens.issue(render(), 0);
    tokens.takeDocument('w1', served.token, 0);
    tokens.issue(render(), 100);
    assert.ok(tokens.forResource('w1', served.token, 100));
    tokens.issue(render(), 105);
    assert.equal(tokens.forResource('w1', served.token, 105), undefined, 'evicted as the oldest');
  });

  it('frees every token of a closed window', () => {
    const tokens = new FrameTokens();
    const a = tokens.issue(render(), 0);
    const b = tokens.issue(render({ windowId: 'w2' }), 0);
    tokens.releaseWindow('w1');
    assert.equal(tokens.lookup('w1', a.token, 0), undefined);
    assert.ok(tokens.lookup('w2', b.token, 0));
  });

  it('answers every refusal with the same undefined', () => {
    const tokens = new FrameTokens({ ttlMs: 10 });
    const used = tokens.issue(render(), 0);
    tokens.takeDocument('w1', used.token, 0);
    const released = tokens.issue(render(), 0);
    tokens.release('w1', released.token);
    const expired = tokens.issue(render(), 0);
    const foreign = tokens.issue(render({ windowId: 'w2' }), 0);
    const cases: [string, unknown, number][] = [
      ['reused', used.token, 1],
      ['guessed', 'f'.repeat(32), 1],
      ['released', released.token, 1],
      ['expired', expired.token, 11],
      ['other window', foreign.token, 1],
      ['malformed', used.token.toUpperCase(), 1],
      ['not a string', { toString: () => used.token }, 1],
    ];
    for (const [name, token, now] of cases) {
      assert.equal(tokens.takeDocument('w1', token, now), undefined, name);
    }
  });

  it('refuses an empty or non-string window id at issue', () => {
    const tokens = new FrameTokens();
    for (const windowId of ['', undefined, null, 0, {}]) {
      assert.throws(
        () => tokens.issue(render({ windowId: windowId as string }), 0),
        /window/,
        String(windowId),
      );
    }
    assert.equal(tokens.liveCount(''), 0);
  });

  it('drops the document from memory once it is served', () => {
    const tokens = new FrameTokens();
    const { token } = tokens.issue(render({ document: '<p>secret body</p>' }), 0);
    const record = tokens.lookup('w1', token, 0);
    assert.ok(record);
    assert.equal('document' in record, false, 'the record never carries the document');
    assert.equal(tokens.holdsDocument('w1', token, 0), true);
    assert.equal(tokens.takeDocument('w1', token, 0), '<p>secret body</p>');
    assert.equal(tokens.holdsDocument('w1', token, 0), false);
    assert.equal(tokens.takeDocument('w1', token, 0), undefined);
    assert.ok(tokens.forResource('w1', token, 0), 'sub-resources still work');
  });
});
