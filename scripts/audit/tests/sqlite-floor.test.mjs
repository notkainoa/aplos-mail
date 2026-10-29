import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { probeJson, sqliteAtLeastFloor } from '../sqlite-floor.mjs';

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

  it('reads the probe result from the last JSON line after install noise', () => {
    const stdout = [
      'Downloading Electron binary...',
      'still installing',
      '{"version":"3.53.4","fts5Delete":true}',
      '',
    ].join('\n');
    assert.deepEqual(probeJson(stdout), { version: '3.53.4', fts5Delete: true });
  });

  it('fails with the raw output when the child prints no JSON line', () => {
    assert.throws(() => probeJson('Downloading Electron binary...\n'), /no JSON line/);
    assert.throws(() => probeJson(''), /no JSON line/);
  });

  it('requires a string version and a boolean fts5Delete', () => {
    assert.throws(() => probeJson('{"version":"3.53.4"}'), /fts5Delete/);
    assert.throws(() => probeJson('{"version":3.53,"fts5Delete":true}'), /string version/);
    assert.throws(() => probeJson('{"version":"3.53.4","fts5Delete":"yes"}'), /boolean fts5Delete/);
    assert.throws(() => probeJson('{}'), /string version/);
  });
});
