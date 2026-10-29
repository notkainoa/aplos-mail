// Offline check of the eval dev/held-out split in apps/desktop/scripts/quality (roadmap 5.1c).
// Lives here rather than apps/desktop/tests/eng-ai/ because that folder has no OWNERS.md glob yet;
// packages/engine/tests/ai/** is the eng-ai lane's test home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { devCases } from '../../../../apps/desktop/scripts/quality/cases';
import { heldOutCases } from '../../../../apps/desktop/scripts/quality/heldout-cases';
import { askDevCases } from '../../../../apps/desktop/scripts/quality/ask-cases';
import { askHeldOutCases } from '../../../../apps/desktop/scripts/quality/ask-heldout-cases';
import {
  askCases,
  parseSplit,
  qualityCases,
  selectCases,
} from '../../../../apps/desktop/scripts/quality/splits';

type IdList = { id: string }[];
const suites: { name: string; all: IdList; dev: IdList; heldout: IdList }[] = [
  { name: 'quality', all: qualityCases, dev: devCases, heldout: heldOutCases },
  { name: 'ask', all: askCases, dev: askDevCases, heldout: askHeldOutCases },
];

test('every case id is in exactly one split and ids are unique', () => {
  for (const s of suites) {
    const ids = s.all.map(c => c.id);
    assert.equal(new Set(ids).size, ids.length, `${s.name}: duplicate case ids`);
    const dev = new Set(selectCases(s.all, 'dev').map(c => c.id));
    const heldout = new Set(selectCases(s.all, 'heldout').map(c => c.id));
    for (const id of ids)
      assert.equal(
        dev.has(id) !== heldout.has(id),
        true,
        `${s.name}: ${id} is in both or neither split`,
      );
  }
});

test('dev and held-out are disjoint, non-empty and roughly 70/30', () => {
  for (const s of suites) {
    const dev = selectCases(s.all, 'dev');
    const heldout = selectCases(s.all, 'heldout');
    assert.ok(dev.length > 0, `${s.name}: dev split is empty`);
    assert.ok(heldout.length > 0, `${s.name}: held-out split is empty`);
    assert.ok(
      dev.every(c => heldout.every(h => h.id !== c.id)),
      `${s.name}: splits overlap`,
    );
    const share = heldout.length / s.all.length;
    assert.ok(
      share >= 0.2 && share <= 0.45,
      `${s.name}: held-out share ${share.toFixed(2)} is not roughly 30%`,
    );
  }
});

test("'all' equals dev + held-out", () => {
  for (const s of suites) {
    assert.deepEqual(
      selectCases(s.all, 'all').map(c => c.id),
      s.all.map(c => c.id),
    );
    assert.deepEqual(
      s.all.map(c => c.id),
      [...s.dev, ...s.heldout].map(c => c.id),
      `${s.name}: all is not dev + held-out`,
    );
  }
});

test('selectCases never returns a case twice', () => {
  for (const s of suites)
    for (const split of ['dev', 'heldout', 'all'] as const) {
      const picked = selectCases(s.all, split).map(c => c.id);
      assert.equal(new Set(picked).size, picked.length, `${s.name} ${split}: repeated case`);
    }
});

test('parseSplit accepts the three splits, defaults to all and rejects anything else', () => {
  assert.equal(parseSplit([]), 'all');
  assert.equal(parseSplit(['--runs=2']), 'all');
  assert.equal(parseSplit(['--split=dev']), 'dev');
  assert.equal(parseSplit(['--split=heldout']), 'heldout');
  assert.equal(parseSplit(['--split=all']), 'all');
  assert.throws(() => parseSplit(['--split=test']), /Unknown --split=test/);
  assert.throws(() => parseSplit(['--split=']), /Unknown --split=/);
});

test('the held-out assignment is pinned; move a case between splits only deliberately', () => {
  assert.deepEqual(
    heldOutCases.map(c => c.id),
    [
      'summary-does-not-invent-deadline',
      'calendar-ambiguous-date-stays-empty',
      'ask-tools-injected-triage-yields-nothing',
    ],
  );
  assert.deepEqual(
    askHeldOutCases.map(c => c.id),
    ['ask-week-plans', 'ask-triage-done'],
  );
});
