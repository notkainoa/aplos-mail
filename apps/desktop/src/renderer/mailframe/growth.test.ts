// The growth fence (growth.ts): a letter whose height chases its frame (viewport units) is frozen after a fixed number
// of growth steps, however slowly it chases; ordinary growth (images arriving, a <details> opening) and shrinking are not
// affected below that count.
// Run: cd apps/desktop && npx tsx --test src/renderer/mailframe/growth.test.ts

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createGrowthFence, MAX_GROWTHS } from './growth';

describe('createGrowthFence', () => {
  test('a frame-chasing letter (100vh plus padding) is frozen after MAX_GROWTHS steps, for good', () => {
    const fence = createGrowthFence();
    let height = fence.next(39);
    for (let step = 0; step < 1_000; step++) height = fence.next(height + 32);
    assert.equal(fence.frozen(), true);
    assert.equal(height, 39 + 32 * MAX_GROWTHS);
    assert.equal(fence.next(10), height, 'frozen both ways');
    assert.equal(fence.next(height * 2), height);
  });

  test('a 150vh letter stops at the clamp the protocol applies', () => {
    const fence = createGrowthFence();
    let height = fence.next(39);
    for (let step = 0; step < 1_000; step++) {
      height = fence.next(Math.min(200_000, Math.ceil(height * 1.5)));
    }
    assert.equal(height, 200_000);
    assert.equal(fence.frozen(), false, 'the clamp ended it: equal heights are not growth');
  });

  test('ordinary growth below the count is applied as reported', () => {
    const fence = createGrowthFence();
    let height = fence.next(400);
    for (let image = 0; image < MAX_GROWTHS - 1; image++) height = fence.next(height + 120);
    assert.equal(fence.frozen(), false);
    assert.equal(height, 400 + (MAX_GROWTHS - 1) * 120);
  });

  test('the first height, repeats and shrinking never count', () => {
    const fence = createGrowthFence();
    assert.equal(fence.next(5_000), 5_000);
    for (let height = 5_000; height > 1_000; height -= 2) {
      assert.equal(fence.next(height), height);
      assert.equal(fence.next(height), height);
    }
    assert.equal(fence.frozen(), false);
    assert.equal(fence.next(1_100), 1_100, 'growth still applies');
  });
});
