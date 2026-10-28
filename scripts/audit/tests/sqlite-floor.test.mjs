import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sqliteAtLeastFloor } from '../sqlite-floor.mjs';

describe('sqlite-floor', () => {
  it('accepts versions at or above the 3.43.0 floor', () => {
    assert.equal(sqliteAtLeastFloor('3.43.0'), true);
    assert.equal(sqliteAtLeastFloor('3.53.4'), true);
    assert.equal(sqliteAtLeastFloor('3.54.0'), true);
    assert.equal(sqliteAtLeastFloor('3.100.2'), true);
  });

  it('rejects versions below the floor', () => {
    assert.equal(sqliteAtLeastFloor('3.42.9'), false);
    assert.equal(sqliteAtLeastFloor('3.42.99'), false);
    assert.equal(sqliteAtLeastFloor('3.4.10'), false);
  });
});
