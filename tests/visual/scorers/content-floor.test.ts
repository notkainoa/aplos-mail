import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { STATES } from '../states';
import { axeScore, openFailure } from './axe-score';
import {
  floorFailure,
  loadFloorConfig,
  MIN_TEXT,
  parseFloorConfig,
  staleFloorKeys,
  type FloorConfig,
} from './content-floor';

const none: FloorConfig = { exempt: {}, minInteractive: {} };

test('a blank or near-blank page is below the floor', () => {
  assert.match(
    floorFailure('a', { text: 0, interactive: 5 }, none) ?? '',
    /^content-floor: 0 visible/,
  );
  assert.notEqual(floorFailure('a', { text: MIN_TEXT - 1, interactive: 0 }, none), null);
  assert.equal(floorFailure('a', { text: MIN_TEXT, interactive: 0 }, none), null);
});

test('the interactive floor is per state and defaults to none', () => {
  const config: FloorConfig = { exempt: {}, minInteractive: { b: 3 } };
  assert.equal(floorFailure('a', { text: 40, interactive: 0 }, config), null);
  assert.match(
    floorFailure('b', { text: 40, interactive: 2 }, config) ?? '',
    /2 visible interactive.*floor 3/,
  );
  assert.equal(floorFailure('b', { text: 40, interactive: 3 }, config), null);
});

test('exempt skips only the text floor and reports both reasons otherwise', () => {
  const config: FloorConfig = { exempt: { a: 'blank by design' }, minInteractive: { a: 1 } };
  assert.equal(floorFailure('a', { text: 0, interactive: 1 }, config), null);
  assert.match(floorFailure('a', { text: 0, interactive: 0 }, config) ?? '', /interactive/);
  const both = floorFailure(
    'z',
    { text: 0, interactive: 0 },
    { ...none, minInteractive: { z: 1 } },
  );
  assert.match(both ?? '', /characters.*; .*interactive/);
});

test('a page under the floor scores 0 like one that failed to open', () => {
  const reason = floorFailure('a', { text: 0, interactive: 0 }, none) as string;
  assert.equal(axeScore([openFailure('a', 'light', reason)], 2), 0);
});

test('parseFloorConfig rejects a wrong shape, a blank reason and a negative floor', () => {
  assert.deepEqual(parseFloorConfig({ exempt: { a: 'why' }, minInteractive: { b: 2 } }), {
    exempt: { a: 'why' },
    minInteractive: { b: 2 },
  });
  assert.throws(() => parseFloorConfig({}), /"exempt" must be an object/);
  assert.throws(() => parseFloorConfig({ exempt: { a: ' ' }, minInteractive: {} }), /wrong type/);
  assert.throws(() => parseFloorConfig({ exempt: {}, minInteractive: { a: -1 } }), /wrong type/);
  assert.throws(() => parseFloorConfig({ exempt: {}, minInteractive: { a: 1.5 } }), /wrong type/);
  assert.throws(() => parseFloorConfig({ exempt: [], minInteractive: {} }), /must be an object/);
});

test('staleFloorKeys names keys that are not states', () => {
  const config: FloorConfig = { exempt: { gone: 'x' }, minInteractive: { a: 1, nope: 2 } };
  assert.deepEqual(staleFloorKeys(config, ['a']), ['gone', 'nope']);
});

test('content-floor.json is valid and names only existing states', () => {
  const config = loadFloorConfig();
  assert.deepEqual(
    staleFloorKeys(
      config,
      STATES.map(state => state.id),
    ),
    [],
  );
});

test('loadFloorConfig reads a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'floor-'));
  try {
    const file = join(dir, 'f.json');
    writeFileSync(file, JSON.stringify({ exempt: {}, minInteractive: { a: 1 } }));
    assert.deepEqual(loadFloorConfig(file).minInteractive, { a: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
