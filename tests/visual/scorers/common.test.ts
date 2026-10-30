import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  axeDetails,
  axeScore,
  axeSummaryLine,
  NORMALISER,
  openFailure,
  type AxeFinding,
} from './axe-score';
import {
  clampScore,
  isFresh,
  newestMtime,
  parseArgs,
  printScore,
  scoreLine,
  stateList,
} from './common';

function finding(over: Partial<AxeFinding> = {}): AxeFinding {
  return {
    state: 's',
    theme: 'light',
    rule: 'r',
    impact: 'serious',
    nodes: 1,
    target: '#a',
    known: false,
    ...over,
  };
}

test('printScore line clamps and rounds to 0.01', () => {
  assert.equal(JSON.parse(scoreLine(123, [])).score, 100);
  assert.equal(JSON.parse(scoreLine(-5, [])).score, 0);
  assert.equal(JSON.parse(scoreLine(Number.NaN, [])).score, 0);
  assert.equal(clampScore(87.126), 87.13);
  assert.equal(clampScore(0.004), 0);
});

test('the score line is one line of JSON, details capped at 20 and stripped of ANSI', () => {
  const details = Array.from({ length: 30 }, (_, i) => `\u001b[31mred ${i}\u001b[0m`);
  const line = scoreLine(50, details);
  assert.equal(line.includes('\n'), false);
  const parsed = JSON.parse(line) as { score: number; details: string[] };
  assert.equal(parsed.details.length, 20);
  assert.equal(parsed.details[0], 'red 0');
  assert.equal(line.includes('\u001b'), false);
});

test('printScore writes the JSON as the last stdout line', () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    printScore(12.345, ['x']);
  } finally {
    process.stdout.write = original;
  }
  const last = writes.join('').trimEnd().split('\n').at(-1) ?? '';
  assert.deepEqual(JSON.parse(last), { score: 12.35, details: ['x'] });
});

test('axeScore: clean is 100, impact weights and the node cap apply', () => {
  assert.equal(axeScore([], 1), 100);
  const one = (impact: string, nodes: number): number =>
    100 - axeScore([finding({ impact, nodes })], 1);
  const unit = 100 / NORMALISER;
  assert.ok(Math.abs(one('critical', 1) - 8 * unit) < 1e-9);
  assert.ok(Math.abs(one('serious', 1) - 5 * unit) < 1e-9);
  assert.ok(Math.abs(one('moderate', 1) - 2 * unit) < 1e-9);
  assert.ok(Math.abs(one('minor', 1) - 1 * unit) < 1e-9);
  assert.ok(Math.abs(one('serious', 3) - 15 * unit) < 1e-9);
  assert.equal(one('serious', 50), one('serious', 3));
});

test('axeScore: known defects count at half weight, 20 serious score about 0, floor 0', () => {
  const serious = finding({ nodes: 3 });
  assert.ok(Math.abs(100 - axeScore([finding({ known: true })], 1) - (5 / NORMALISER) * 50) < 1e-9);
  assert.equal(
    axeScore(
      Array.from({ length: 20 }, () => serious),
      1,
    ),
    0,
  );
  assert.equal(
    axeScore(
      Array.from({ length: 40 }, () => serious),
      1,
    ),
    0,
  );
  assert.ok(
    axeScore(
      Array.from({ length: 19 }, () => serious),
      1,
    ) > 0,
  );
});

test('axeDetails lists the worst first and labels known defects', () => {
  const lines = axeDetails([
    finding({ rule: 'minor-one', impact: 'minor' }),
    finding({ rule: 'known-one', known: true, nodes: 2, target: '.k' }),
    finding({ rule: 'crit', impact: 'critical' }),
  ]);
  assert.match(lines[0] ?? '', /^s light crit critical 1 #a$/);
  assert.match(lines[1] ?? '', /known-one known:serious 2 \.k$/);
  assert.match(lines[2] ?? '', /minor-one minor/);
});

test('parseArgs reads size, state, theme and reuse', () => {
  assert.deepEqual(parseArgs([]), {
    size: '1440x900',
    state: '',
    themes: ['light', 'dark'],
    reuse: false,
  });
  const args = parseArgs(['--size', '1100x760', '--state=shell-', '--theme', 'dark', '--reuse']);
  assert.deepEqual(args, { size: '1100x760', state: 'shell-', themes: ['dark'], reuse: true });
  assert.throws(() => parseArgs(['--theme', 'blue']));
  assert.throws(() => parseArgs(['--nope']));
});

test('stateList filters by id prefix and carries title and mockup', () => {
  const all = stateList();
  assert.ok(all.length > 10);
  const some = stateList('home-');
  assert.ok(some.length > 0 && some.length < all.length);
  assert.ok(some.every(s => s.id.startsWith('home-') && s.title && s.mockup));
});

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('axeScore: a page that failed to open or scan scores 0, however few violations the rest has', () => {
  const clean: AxeFinding[] = [];
  assert.equal(axeScore(clean, 96), 100);
  // One broken page among 96 is worse than a handful of serious violations elsewhere.
  const broken = [openFailure('home-full', 'light', 'timeout')];
  assert.equal(axeScore(broken, 96), 0);
  const lots = Array.from({ length: 10 }, () => finding({ nodes: 3 }));
  assert.ok(axeScore(lots, 96) > 0);
  assert.equal(axeScore([...lots, ...broken], 96), 0);
  assert.ok(axeScore(lots, 96) > axeScore(broken, 96));
});

test('axeScore: a run that visited no page never scores 100', () => {
  assert.equal(axeScore([], 0), 0);
});

test('axeSummaryLine says how many pages were scanned and failed', () => {
  assert.equal(axeSummaryLine(4, []), 'scanned 4 of 4 pages');
  assert.equal(
    axeSummaryLine(4, [openFailure('a', 'light', 'x'), openFailure('a', 'dark', 'y')]),
    'scanned 2 of 4 pages (2 failed to open, score 0)',
  );
});

test('axeDetails lists a failed page first', () => {
  const lines = axeDetails([finding({ nodes: 3 }), openFailure('z', 'dark', 'boom')]);
  assert.match(lines[0] ?? '', /^z dark state-failed-to-open critical/);
});

test('--reuse refuses a shot older than the newest source file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scorer-fresh-'));
  dirs.push(dir);
  const source = join(dir, 'src.ts');
  const shot = join(dir, 'shot.png');
  writeFileSync(source, 'x');
  writeFileSync(shot, 'x');
  const now = Date.now() / 1000;
  utimesSync(source, now - 100, now - 100);
  utimesSync(shot, now - 50, now - 50);
  const newest = newestMtime([dir]);
  assert.ok(newest > 0);
  assert.equal(isFresh(join(dir, 'missing.png'), 3_600_000, 0), false);
  assert.equal(isFresh(shot, 3_600_000, newest), true);
  // The source is edited after the shot was taken.
  utimesSync(source, now - 10, now - 10);
  assert.equal(isFresh(shot, 3_600_000, newestMtime([dir])), false);
  assert.equal(newestMtime([join(dir, 'nothing-here')]), 0);
});
