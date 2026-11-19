import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATES } from '../states';
import { stateList } from './common';
import {
  CELL,
  colourSimilarity,
  compareImages,
  correlation,
  deltaE2000,
  detailLines,
  downsample,
  implRegion,
  mockupReport,
  overallScore,
  parseMockup,
  resolveMockupState,
  rgbToLab,
  unresolvedScore,
  worstBlock,
  type Rgba,
} from './mockup-diff-score';
import { loadExcluded, mockupTarget, staleExcludes } from './mockup';

const W = 320;
const H = 200;

type Colour = readonly [number, number, number];

function blank(colour: Colour = [255, 255, 255]): Rgba {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...colour, 255], i);
  return { data, width: W, height: H };
}

function fill(image: Rgba, x: number, y: number, w: number, h: number, colour: Colour): void {
  const data = image.data as Uint8ClampedArray;
  for (let row = y; row < y + h; row += 1)
    for (let col = x; col < x + w; col += 1) data.set([...colour, 255], (row * W + col) * 4);
}

/** A sidebar, a header band and 12 rows, each with a short "text" bar whose length is `lengths[i]`. */
function screen(lengths: readonly number[], offset = 0): Rgba {
  const image = blank();
  fill(image, 0, 0, 64, H, [238, 238, 240]);
  fill(image, 64, 0, W - 64, 24, [247, 247, 248]);
  lengths.forEach((length, i) => {
    fill(image, 80 + offset, 36 + i * 14, length, 5, [60, 60, 64]);
  });
  return image;
}

const LENGTHS = [150, 120, 170, 90, 140, 160, 110, 130, 100, 150, 120, 140];
const CHANGED = [130, 150, 110, 160, 120, 100, 150, 90, 140, 110, 160, 100];

test('identical images score 100', () => {
  const result = compareImages(screen(LENGTHS), screen(LENGTHS));
  assert.equal(result.score, 100);
  assert.equal(result.meanDeltaE, 0);
});

test('a blank or shifted image scores lower than the real one', () => {
  const real = screen(LENGTHS);
  const blankScore = compareImages(real, blank()).score;
  const shifted = compareImages(real, screen(LENGTHS, 40)).score;
  const dark = compareImages(real, blank([20, 20, 24])).score;
  assert.ok(blankScore < 75, `blank ${blankScore}`);
  assert.ok(shifted < 100 && shifted > blankScore, `shifted ${shifted}`);
  assert.ok(dark < blankScore, `a dark page is further than a white one: ${dark}`);
});

test('text-only changes (other words, same layout) stay above 90', () => {
  const score = compareImages(screen(LENGTHS), screen(CHANGED)).score;
  assert.ok(score > 90, `text change scored ${score}`);
});

test('a wrongly coloured sidebar costs more than changed text', () => {
  const real = screen(LENGTHS);
  const blueSidebar = screen(LENGTHS);
  fill(blueSidebar, 0, 0, 64, H, [20, 90, 220]);
  const sidebar = compareImages(real, blueSidebar).score;
  const text = compareImages(real, screen(CHANGED)).score;
  assert.ok(sidebar < text, `sidebar ${sidebar} text ${text}`);
});

test('downsample: cell grid shape and mean colour', () => {
  const image = blank();
  fill(image, 0, 0, CELL, CELL, [0, 0, 0]);
  const grid = downsample(image);
  assert.equal(grid.cols, W / CELL);
  assert.equal(grid.rows, H / CELL);
  assert.ok((grid.lab[0] ?? 100) < 1, 'first cell is black');
  assert.ok((grid.lab[3] ?? 0) > 99, 'second cell is white');
  assert.ok((grid.edge[0] ?? 0) > 0 && grid.edge[5 * grid.cols + 5] === 0);
});

test('downsample keeps partial cells at the edge', () => {
  const grid = downsample({
    data: new Uint8ClampedArray(10 * 10 * 4).fill(255),
    width: 10,
    height: 10,
  });
  assert.equal(grid.cols, 2);
  assert.equal(grid.rows, 2);
  assert.ok((grid.lab[3 * 3] ?? 0) > 99);
});

test('deltaE2000 matches published reference pairs (Sharma et al.)', () => {
  const near = deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485]);
  assert.ok(Math.abs(near - 2.0425) < 1e-3, `got ${near}`);
  const far = deltaE2000([50, 2.5, 0], [73, 25, -18]);
  assert.ok(Math.abs(far - 27.1492) < 1e-3, `got ${far}`);
  assert.equal(deltaE2000(rgbToLab(10, 20, 30), rgbToLab(10, 20, 30)), 0);
});

test('correlation: same, inverse, flat', () => {
  assert.ok(Math.abs(correlation([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-12);
  assert.ok(Math.abs(correlation([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-12);
  assert.equal(correlation([1, 1, 1], [5, 5, 5]), 1);
  assert.equal(correlation([1, 1, 1], [1, 2, 3]), 0);
});

test('colourSimilarity: 1 at 0, 0 at 40 and beyond', () => {
  assert.equal(colourSimilarity(0), 1);
  assert.equal(colourSimilarity(20), 0.5);
  assert.equal(colourSimilarity(55), 0);
});

test('worstBlock finds the block with the most difference, in pixels', () => {
  const cols = 10;
  const rows = 8;
  const deltas = new Float64Array(cols * rows);
  for (let r = 2; r < 6; r += 1) for (let c = 5; c < 9; c += 1) deltas[r * cols + c] = 20;
  assert.deepEqual(worstBlock(deltas, cols, rows), { x: 40, y: 16, width: 32, height: 32 });
});

test('overallScore is the mean; detail lines are worst first', () => {
  assert.equal(overallScore([]), 0);
  assert.equal(overallScore([100, 50]), 75);
  const lines = detailLines([
    { state: 'a', theme: 'light', score: 90, worst: { x: 1, y: 2, width: 3, height: 4 } },
    { state: 'b', theme: 'dark', score: 40.04, worst: { x: 8, y: 16, width: 32, height: 32 } },
  ]);
  assert.deepEqual(lines, ['b dark 40.0% worst 8,16,32,32', 'a light 90.0% worst 1,2,3,4']);
});

test('mockup labels resolve to the page state', () => {
  assert.deepEqual(parseMockup('empty.html (inbox zero)'), {
    file: 'empty.html',
    label: 'inbox zero',
  });
  assert.equal(parseMockup('n/a'), null);
  const listed = ['inbox-zero', 'first-mail'];
  assert.equal(resolveMockupState('inbox zero', listed), 'inbox-zero');
  assert.equal(resolveMockupState('default', listed), 'inbox-zero');
  assert.equal(resolveMockupState('default', []), '');
  assert.equal(resolveMockupState('status', listed), null);
});

test('implRegion: shell is the window, pane is inset by the shell padding, window is centred', () => {
  const viewport = { width: 1440, height: 900 };
  assert.deepEqual(implRegion('shell', viewport), { x: 0, y: 0, width: 1440, height: 900 });
  assert.deepEqual(implRegion('pane', viewport), { x: 8, y: 8, width: 1424, height: 884 });
  assert.deepEqual(implRegion('window', viewport), { x: 400, y: 150, width: 640, height: 600 });
});

const at = (state: string, score: number) => ({ state, theme: 'light', score, worst: null });

test('the exclude file only names states that exist in states.ts', () => {
  const excluded = loadExcluded();
  assert.ok(Object.keys(excluded).length > 0);
  assert.deepEqual(
    staleExcludes(
      excluded,
      STATES.map(state => state.id),
    ),
    [],
  );
  assert.deepEqual(staleExcludes({ gone: 'x', 'home-full': 'y' }, ['home-full']), ['gone']);
});

test('every state that is not excluded resolves to a mockup page', () => {
  const excluded = loadExcluded();
  const unresolved = stateList()
    .filter(entry => !(entry.id in excluded))
    .flatMap(entry => {
      const target = mockupTarget(entry, 'light');
      return typeof target === 'string' ? [`${entry.id}: ${target}`] : [];
    });
  assert.deepEqual(unresolved, []);
});

test('unresolved pages count as 0 and are flagged, so shrinking the set never raises the mean', () => {
  const resolved = [at('a', 90), at('b', 80)];
  const full = mockupReport(resolved, 2, 0);
  assert.equal(full.score, 85);
  assert.equal(full.details[0], 'compared 2 of 2 (excluded 0)');

  // A third page whose mockup string was edited away: it scores 0 instead of leaving the mean.
  const edited = mockupReport([...resolved, unresolvedScore('c', 'light', 'no mockup page')], 3, 0);
  assert.equal(edited.score, (90 + 80 + 0) / 3);
  assert.ok(edited.score < full.score);
  assert.equal(edited.details[0], 'compared 2 of 3 (excluded 0)');
  assert.match(edited.details[1] ?? '', /^c light 0\.0% mockup-unresolved no mockup page$/);

  // A page that produced no outcome at all is still in the denominator.
  assert.equal(mockupReport(resolved, 3, 0).score, 170 / 3);
  // Only listed exclusions leave the mean, and they are announced.
  const excluded = mockupReport(resolved, 5, 3);
  assert.equal(excluded.score, 85);
  assert.equal(excluded.details[0], 'compared 2 of 5 (excluded 3)');
});
