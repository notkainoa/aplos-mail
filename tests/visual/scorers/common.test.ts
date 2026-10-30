import assert from 'node:assert/strict';
import { test } from 'node:test';
import { axeDetails, axeScore, NORMALISER, type AxeFinding } from './axe-score';
import { clampScore, parseArgs, printScore, scoreLine, stateList } from './common';

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
  assert.equal(axeScore([]), 100);
  const one = (impact: string, nodes: number): number =>
    100 - axeScore([finding({ impact, nodes })]);
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
  assert.ok(Math.abs(100 - axeScore([finding({ known: true })]) - (5 / NORMALISER) * 50) < 1e-9);
  assert.equal(axeScore(Array.from({ length: 20 }, () => serious)), 0);
  assert.equal(axeScore(Array.from({ length: 40 }, () => serious)), 0);
  assert.ok(axeScore(Array.from({ length: 19 }, () => serious)) > 0);
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
