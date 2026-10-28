import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { conformance, testIds } from './suite';

conformance({ name: 'ids', create: () => Promise.reject(new Error('collect only')) }, [], {
  collect: true,
});

const dir = import.meta.dirname;
const runners = (name: string) => name.endsWith('.test.ts') && name !== 'rules.test.ts';

/** "No fixture-only assertions" (plan 10 section 4.1): the suite and its helpers import only the contract and Node's test tools. */
test('the suite imports no engine, so the stand-in and the real engine meet the same assertions', () => {
  for (const name of readdirSync(dir).filter(
    n => n.endsWith('.ts') && !runners(n) && n !== 'rules.test.ts',
  )) {
    const imports = [
      ...readFileSync(join(dir, name), 'utf8').matchAll(/(?:from|import)\s+'([^']+)'/g),
    ].map(m => m[1]!);
    for (const path of imports)
      assert.match(path, /^(node:|\.\/|\.\.\/\.\.\/src\/)/, `${name} imports ${path}`);
  }
});

test('every expected-fail list names real tests and has a runner', () => {
  const lists = readdirSync(dir).filter(n => /^expected-fail\.[\w-]+\.json$/.test(n));
  assert.ok(lists.includes('expected-fail.fixture.json'));
  for (const list of lists) {
    const engine = list.split('.')[1]!;
    assert.ok(
      readdirSync(dir).includes(`${engine}.test.ts`),
      `${list} has a runner ${engine}.test.ts`,
    );
    const ids = JSON.parse(readFileSync(join(dir, list), 'utf8')) as string[];
    for (const id of ids)
      assert.ok(testIds.has(id), `${list} names ${id}, which the suite does not have`);
  }
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, 'expected-fail.fixture.json'), 'utf8')),
    [],
    'the stand-in passes everything (C1)',
  );
});
