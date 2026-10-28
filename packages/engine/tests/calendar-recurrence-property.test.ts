/**
 * Property check: the module against oracle B (the Calendar emulator's expander) on 300 seeded
 * random rules inside B's subset, three years each. B's answers (which oracle A also matched) are
 * frozen in fixtures/calendar/property-b.json by scripts/recurrence-oracle/generate.ts, so this
 * test runs without the emulator's worktree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expand, type Series } from '../src/calendar/recurrence';

interface PropertyRule {
  id: string;
  event: Series & { rrule: string };
  range: { from: number; to: number };
  count: number;
  hash: string;
  head: string[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'calendar', 'property-b.json'), 'utf8'),
) as { rules: PropertyRule[] };

function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

test('300 seeded random rules match oracle B over three years', () => {
  assert.equal(fixture.rules.length, 300);
  const failures: string[] = [];
  for (const r of fixture.rules) {
    const result = expand({ ...r.event, range: r.range });
    if (!result.ok) {
      failures.push(`${r.id} ${r.event.rrule}: refused (${result.reason})`);
      continue;
    }
    const keys = result.occurrences.map(o => o.recurrenceId);
    if (keys.length !== r.count || fnv(keys.join(' ')) !== r.hash) {
      const firstDiff = keys.findIndex((k, i) => k !== r.head[i]);
      failures.push(
        `${r.id} ${r.event.rrule} ${JSON.stringify(r.event.start)}: ${keys.length} vs ${r.count}, first difference at ${firstDiff} (${keys[firstDiff]} vs ${r.head[firstDiff]})`,
      );
    }
  }
  assert.deepEqual(failures, []);
});
