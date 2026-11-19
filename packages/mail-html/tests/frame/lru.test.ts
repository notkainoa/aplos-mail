import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Lru, RENDER_CACHE_SIZE, renderKey, type RenderKeyParts } from '../../src/frame/lru';

// The render cache: 12 entries, least recently used out first, keyed by everything that changes
// the sanitized output (the sanitizer version included).

describe('render cache', () => {
  it('holds 12 by default; the 13th evicts the least recently used', () => {
    const cache = new Lru<number>();
    assert.equal(cache.capacity, RENDER_CACHE_SIZE);
    assert.equal(RENDER_CACHE_SIZE, 12);
    for (let i = 0; i < 12; i++) cache.set(`k${i}`, i);
    assert.equal(cache.size, 12);
    cache.set('k12', 12);
    assert.equal(cache.size, 12);
    assert.equal(cache.has('k0'), false);
    assert.equal(cache.get('k1'), 1);
  });

  it('refreshes recency on get, so the untouched entry goes', () => {
    const cache = new Lru<string>(3);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    assert.equal(cache.get('a'), 'A');
    cache.set('d', 'D');
    assert.deepEqual(
      ['a', 'b', 'c', 'd'].map(k => cache.has(k)),
      [true, false, true, true],
    );
  });

  it('refreshes recency on set of an existing key, without growing', () => {
    const cache = new Lru<string>(2);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('a', '3');
    cache.set('c', '4');
    assert.equal(cache.get('a'), '3');
    assert.equal(cache.has('b'), false);
    assert.equal(cache.size, 2);
  });

  it('caches falsy values and misses unknown keys', () => {
    const cache = new Lru<number>(2);
    cache.set('zero', 0);
    assert.equal(cache.get('zero'), 0);
    assert.equal(cache.get('none'), undefined);
  });

  it('deletes and clears', () => {
    const cache = new Lru<number>();
    cache.set('a', 1);
    cache.set('b', 2);
    assert.equal(cache.delete('a'), true);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get('b'), undefined);
  });
});

describe('render key', () => {
  const base: RenderKeyParts = {
    messageId: 'm1',
    imagePolicy: 'block',
    findQuery: 'invoice',
    quotesOpen: false,
    version: 'mail-html/1',
  };

  it('changes when any one part changes', () => {
    const variants: Partial<RenderKeyParts>[] = [
      { messageId: 'm2' },
      { imagePolicy: 'allow' },
      { findQuery: 'receipt' },
      { findQuery: undefined },
      { quotesOpen: true },
      { version: 'mail-html/2' },
      { body: '7:3' },
    ];
    for (const change of variants) {
      assert.notEqual(renderKey({ ...base, ...change }), renderKey(base), JSON.stringify(change));
    }
  });

  it('treats an absent quotesOpen as closed', () => {
    assert.equal(renderKey({ ...base, quotesOpen: undefined }), renderKey(base));
  });

  it('cannot be forged by a separator inside a part', () => {
    const a = renderKey({ ...base, messageId: 'm1","allow', imagePolicy: 'block' });
    const b = renderKey({ ...base, messageId: 'm1', findQuery: 'allow","block' });
    assert.notEqual(a, b);
    assert.notEqual(a, renderKey(base));
  });

  it('misses a cached body after a sanitizer version bump', () => {
    const cache = new Lru<string>();
    cache.set(renderKey(base), 'old body');
    assert.equal(cache.get(renderKey({ ...base, version: 'mail-html/2' })), undefined);
    assert.equal(cache.get(renderKey(base)), 'old body');
  });
});
