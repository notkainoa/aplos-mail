// Offline check of the eval dev/held-out split in apps/desktop/scripts/quality (roadmap 5.1c).
// Lives here rather than apps/desktop/tests/eng-ai/ because that folder has no OWNERS.md glob yet;
// packages/engine/tests/ai/** is the eng-ai lane's test home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { devCases } from '../../../../apps/desktop/scripts/quality/cases';
import { heldOutCases } from '../../../../apps/desktop/scripts/quality/heldout-cases';
import { askDevCases } from '../../../../apps/desktop/scripts/quality/ask-cases';
import { askHeldOutCases } from '../../../../apps/desktop/scripts/quality/ask-heldout-cases';
import {
  loadAskCases,
  loadQualityCases,
  ORDER,
  parseSplit,
  pickOnly,
  scoreLine,
  selectCases,
} from '../../../../apps/desktop/scripts/quality/splits';

type IdList = { id: string }[];
const suites: { name: string; dev: IdList; heldout: IdList; order: readonly string[] }[] = [
  { name: 'quality', dev: devCases, heldout: heldOutCases, order: ORDER.quality },
  { name: 'ask', dev: askDevCases, heldout: askHeldOutCases, order: ORDER.ask },
];
const allOf = (s: (typeof suites)[number]) => [...s.dev, ...s.heldout];

test('every case id is in exactly one split and ids are unique', () => {
  for (const s of suites) {
    const ids = allOf(s).map(c => c.id);
    assert.equal(new Set(ids).size, ids.length, `${s.name}: duplicate case ids`);
    const dev = new Set(selectCases(allOf(s), 'dev').map(c => c.id));
    const heldout = new Set(selectCases(allOf(s), 'heldout').map(c => c.id));
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
    const dev = selectCases(allOf(s), 'dev');
    const heldout = selectCases(allOf(s), 'heldout');
    assert.ok(dev.length > 0, `${s.name}: dev split is empty`);
    assert.ok(heldout.length > 0, `${s.name}: held-out split is empty`);
    assert.ok(
      dev.every(c => heldout.every(h => h.id !== c.id)),
      `${s.name}: splits overlap`,
    );
    const share = heldout.length / allOf(s).length;
    assert.ok(
      share >= 0.2 && share <= 0.45,
      `${s.name}: held-out share ${share.toFixed(2)} is not roughly 30%`,
    );
  }
});

test("'all' restores the pinned original order, whatever the input order", async () => {
  for (const s of suites) {
    assert.deepEqual(
      selectCases(allOf(s), 'all').map(c => c.id),
      s.order,
      `${s.name}: 'all' no longer matches the original order`,
    );
    assert.deepEqual(
      selectCases([...allOf(s)].reverse(), 'all').map(c => c.id),
      s.order,
      `${s.name}: 'all' must sort by the pinned order`,
    );
  }
  assert.deepEqual(
    (await loadQualityCases('all')).map(c => c.id),
    ORDER.quality,
  );
  assert.deepEqual(
    (await loadAskCases('all')).map(c => c.id),
    ORDER.ask,
  );
});

test('the loaders select the same cases the files define', async () => {
  assert.deepEqual(
    (await loadQualityCases('dev')).map(c => c.id),
    devCases.map(c => c.id),
  );
  assert.deepEqual(
    (await loadQualityCases('heldout')).map(c => c.id),
    heldOutCases.map(c => c.id),
  );
  assert.deepEqual(
    (await loadAskCases('dev')).map(c => c.id),
    askDevCases.map(c => c.id),
  );
  assert.deepEqual(
    (await loadAskCases('heldout')).map(c => c.id),
    askHeldOutCases.map(c => c.id),
  );
});

test('selectCases never returns a case twice', () => {
  for (const s of suites)
    for (const split of ['dev', 'heldout', 'all'] as const) {
      const picked = selectCases(allOf(s), split).map(c => c.id);
      assert.equal(new Set(picked).size, picked.length, `${s.name} ${split}: repeated case`);
    }
});

test('dev scoring works with the held-out files absent', async () => {
  // A hill-climb attempt worktree has the held-out files stripped; --split=dev must still load.
  // The copy lives under node_modules/.cache so bare @aplos/* imports keep resolving.
  const cache = fileURLToPath(new URL('../../../../node_modules/.cache/', import.meta.url));
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(join(cache, 'eval-splits-'));
  try {
    const qualityDir = new URL('../../../../apps/desktop/scripts/quality/', import.meta.url);
    for (const name of ['cases.ts', 'ask-cases.ts', 'splits.ts'])
      await copyFile(fileURLToPath(new URL(name, qualityDir)), join(dir, name));
    const stripped = (await import(
      pathToFileURL(join(dir, 'splits.ts')).href
    )) as typeof import('../../../../apps/desktop/scripts/quality/splits');
    assert.deepEqual(
      (await stripped.loadQualityCases('dev')).map(c => c.id),
      devCases.map(c => c.id),
    );
    assert.deepEqual(
      (await stripped.loadAskCases('dev')).map(c => c.id),
      askDevCases.map(c => c.id),
    );
    // Asking for the missing set fails loudly instead of scoring nothing.
    await assert.rejects(stripped.loadQualityCases('heldout'));
    await assert.rejects(stripped.loadAskCases('all'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nothing on the dev path statically imports a held-out module', async () => {
  // Mutation guard: a static `from './ask-heldout-cases'` (or any other held-out specifier) in a
  // dev entry point or shared module must fail this test; only dynamic import() is allowed.
  const staticHeldOut = /from\s+['"][^'"]*heldout|import\s+['"][^'"]*heldout/i;
  const qualityDir = new URL('../../../../apps/desktop/scripts/quality/', import.meta.url);
  const scriptsDir = new URL('../../../../apps/desktop/scripts/', import.meta.url);
  for (const [dir, name] of [
    [qualityDir, 'cases.ts'],
    [qualityDir, 'ask-cases.ts'],
    [qualityDir, 'splits.ts'],
    [scriptsDir, 'evaluate-groq.ts'],
    [scriptsDir, 'ask-live.ts'],
  ] as const) {
    const src = await readFile(new URL(name, dir), 'utf8');
    assert.equal(staticHeldOut.test(src), false, `${name} statically imports a held-out module`);
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

test('parseSplit rejects a bare, malformed or repeated --split', () => {
  assert.throws(() => parseSplit(['--split']), /Malformed option --split/);
  assert.throws(() => parseSplit(['--split', 'dev']), /Malformed option --split/);
  assert.throws(() => parseSplit(['--splitx']), /Malformed option --splitx/);
  assert.throws(() => parseSplit(['--split=allx']), /Unknown --split=allx/);
  assert.throws(() => parseSplit(['--split=dev', '--split=all']), /--split= only once/);
  assert.throws(() => parseSplit(['--split=dev', '--split=dev']), /--split= only once/);
});

test('pickOnly keeps the 1-based pick in list order and a miss is an error', () => {
  const list = ['a', 'b', 'c'];
  assert.deepEqual(pickOnly(list, undefined), list);
  assert.deepEqual(pickOnly(list, '1'), ['a']);
  assert.deepEqual(pickOnly(list, '3'), ['c']);
  assert.throws(() => pickOnly(list, '0'), /--only=0 picks no case/);
  assert.throws(() => pickOnly(list, '4'), /--only=4 picks no case/);
  assert.throws(() => pickOnly(list, 'x'), /--only=x picks no case/);
  assert.throws(() => pickOnly(list, ''), /--only= picks no case/);
});

test('scoreLine scores passed/total across every run', () => {
  const line = scoreLine([
    { id: 'a', passed: true },
    { id: 'b', passed: false, error: 'boom' },
    { id: 'a', passed: true },
    { id: 'b', passed: true },
  ]);
  assert.equal(line.score, 0.75);
  assert.deepEqual(line.details, [{ id: 'b', message: 'boom' }]);
});

test('scoreLine lists the first failure per case, capped at five', () => {
  const results = Array.from({ length: 7 }, (_, i) => ({
    id: `c${i}`,
    passed: false,
    error: `e${i}`,
  }));
  results.push({ id: 'c0', passed: false, error: 'e0-again' });
  const line = scoreLine(results);
  assert.equal(line.score, 0);
  assert.deepEqual(
    line.details,
    Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, message: `e${i}` })),
  );
  assert.deepEqual(scoreLine([{ id: 'a', passed: true }]), { score: 1, details: [] });
});

test('scoreLine refuses an empty selection instead of printing score 0', () => {
  assert.throws(() => scoreLine([]), /Nothing was selected to score/);
});

// Split membership is pinned by a count plus the sha256 of the sorted ids — deliberately not by the
// ids themselves, because a hill-climb attempt reading this test must not learn the held-out case
// ids. To move a case between splits on purpose, edit the case file, then update the count and the
// hash here; get the new hash by printing `hashIds(<list>)` from a scratch copy of this test.
const hashIds = (list: IdList) =>
  createHash('sha256')
    .update(
      list
        .map(c => c.id)
        .sort()
        .join('\n'),
    )
    .digest('hex');

test('the split assignment is pinned by count and hash; change it only deliberately', () => {
  assert.equal(heldOutCases.length, 3);
  assert.equal(
    hashIds(heldOutCases),
    'deba98314db766eda4976363215d10bd1875d06bd3c36677baa7e66c1ed2ed78',
  );
  assert.equal(askHeldOutCases.length, 2);
  assert.equal(
    hashIds(askHeldOutCases),
    '9d9eae0f5d7ed753333d6e5e339c745cb7881fccf7771f0c4832ebe37f5528a1',
  );
  assert.equal(devCases.length, 7);
  assert.equal(
    hashIds(devCases),
    'f0461ebdf643e42d7b21c3b71b13dd0a58f91b936e09a49ff52f7f949b58e32a',
  );
  assert.equal(askDevCases.length, 3);
  assert.equal(
    hashIds(askDevCases),
    'dc4de2a522f7e37229e44794bae0261d586549c315c9522dbbd4af242dd74961',
  );
});
