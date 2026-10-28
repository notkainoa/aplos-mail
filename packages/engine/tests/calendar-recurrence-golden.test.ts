/**
 * The recurrence module against the golden corpus (PV8 acceptance). Every expected output was
 * produced by independent oracles (python-dateutil and the Calendar emulator's expander); see
 * scripts/recurrence-oracle/ and fixtures/calendar/disagreements.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expand, type EventTime, type ExpandRequest } from '../src/calendar/recurrence';

interface Expected {
  recurrenceId: string;
  start: string;
  end: string;
  overridden: boolean;
}
interface GoldenCase {
  id: string;
  tags: string[];
  oracles: string[];
  input: Omit<ExpandRequest, 'range'> & { range: { from: string; to: string } };
  expected:
    | { ok: true; occurrences: Expected[] }
    | { ok: false; refused: 'unsupported' | 'invalid'; occurrences: Expected[] };
}

const dir = join(import.meta.dirname, 'fixtures', 'calendar');
const load = (name: string): GoldenCase[] =>
  JSON.parse(readFileSync(join(dir, name), 'utf8')).cases;
const golden = load('golden.json');
const disputed = load('disputed.json');

const two = (n: number): string => String(n).padStart(2, '0');
/** EventTime to the corpus' key form, written here so the test does not lean on the module's own formatter. */
function key(t: EventTime): string {
  if ('date' in t) return t.date.replace(/-/g, '');
  if ('local' in t) return t.local.replace(/[-:]/g, '');
  const d = new Date(t.utc);
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
}

function run(c: GoldenCase) {
  const result = expand({
    ...c.input,
    range: { from: Date.parse(c.input.range.from), to: Date.parse(c.input.range.to) },
  });
  const occurrences = result.occurrences.map(o => ({
    recurrenceId: o.recurrenceId,
    start: key(o.start),
    end: key(o.end),
    overridden: o.overridden,
  }));
  return result.ok
    ? { ok: true, occurrences }
    : { ok: false, refused: result.refused, occurrences };
}

test('the corpus is big enough and covers what PV8 names', () => {
  assert.ok(golden.length >= 90, `${golden.length} golden cases`);
  const tags = new Set(golden.flatMap(c => c.tags));
  for (const tag of [
    'dst-la',
    'dst-london',
    'dst-sydney',
    'gap',
    'ambiguous',
    'ordinal',
    'bysetpos',
    'bymonthday',
    'leap',
    'wkst',
    'count',
    'until',
    'until-date',
    'override',
    'cancelled',
    'moved-day',
    'exdate',
    'rdate',
    'floating',
    'all-day',
  ]) {
    assert.ok(tags.has(tag), `a case tagged ${tag}`);
  }
  assert.ok(golden.filter(c => c.tags.includes('refused')).length >= 10, 'ten refused cases');
  assert.ok(
    golden.filter(c => c.oracles.length === 2).length >= 90,
    'at least 90 cases agreed by both oracles',
  );
});

for (const c of golden) {
  test(`golden ${c.id} [${c.oracles.join('+')}]`, () => {
    const { ok: _ok, ...expected } = c.expected as Record<string, unknown>;
    const actual = run(c);
    assert.equal(actual.ok, c.expected.ok);
    assert.deepEqual(
      { refused: (actual as { refused?: string }).refused, occurrences: actual.occurrences },
      { refused: expected.refused, occurrences: expected.occurrences },
    );
  });
}

for (const c of disputed) {
  test(`disputed ${c.id} follows the corpus side`, () => {
    assert.deepEqual(run(c), c.expected);
  });
}
