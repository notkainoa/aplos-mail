// A triage toast keeps the sender's name; a long name pushes "no date" out first.
// Run: cd apps/desktop && npx tsx --test src/renderer/screens/home/namedToast.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThreadRow } from '../../data';
import { namedToast } from './homeRows';
import { undated } from '../undoOperation';

function rowFrom(name: string): ThreadRow {
  return { fromName: name, participants: [] } as unknown as ThreadRow;
}

test('a short name keeps "no date", a long one gives it up before the name is cut', () => {
  const later = undated('Moved to Later');
  assert.match(namedToast(later, rowFrom('Maya Chen')), /^Moved to Later · no date · Maya Chen$/);
  const long = namedToast(later, rowFrom('Maple Library Community Services'));
  assert.equal(long, 'Moved to Later · Maple Library Community Services');
});
