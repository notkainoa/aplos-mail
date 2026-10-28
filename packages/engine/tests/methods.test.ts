import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { engineAreas, getMethod, methodNames } from '@aplos/contract';
import { ContractError, NotImplementedError } from '@aplos/contract/contract-error';
import { dispatch, handlers } from '../src/methods/index';

const dir = join(import.meta.dirname, '..', 'src', 'methods');
const ctx = { caller: { kind: 'window' as const, scopes: [] }, signal: new AbortController().signal };

test('every engine method has exactly one handler entry, in its own area\'s file', async () => {
  const seen = new Map<string, string[]>();
  for (const area of engineAreas) {
    const module = await import(join(dir, `${area}.ts`)) as { handlers: Record<string, unknown> };
    for (const name of Object.keys(module.handlers)) {
      seen.set(name, [...(seen.get(name) ?? []), area]);
      assert.equal(getMethod(name).area, area, `${name} sits in ${area}.ts but belongs to ${getMethod(name).area}`);
    }
  }
  const engine = methodNames.filter(name => getMethod(name).host === 'engine');
  assert.deepEqual(engine.filter(name => seen.get(name)?.length !== 1), [], 'missing or duplicated handlers');
  assert.deepEqual([...seen.keys()].filter(name => getMethod(name).host !== 'engine'), [], 'desktop methods never reach the engine');
  assert.deepEqual(Object.keys(handlers).sort(), [...engine].sort());
});

test('there is one file per engine area and nothing else besides the table and its types', () => {
  const files = readdirSync(dir).map(f => f.replace(/\.ts$/, '')).sort();
  assert.deepEqual(files, [...engineAreas, 'index', 'types'].sort());
});

test('a stub rejects with notImplemented, and an unknown method with unsupported', async () => {
  await assert.rejects(dispatch('Thread/act', { opId: 'o1', ids: ['a1:t1'], action: { type: 'done' } }, ctx), (e: unknown) => e instanceof NotImplementedError && e.type === 'notImplemented');
  await assert.rejects(dispatch('File/save', {}, ctx), (e: unknown) => e instanceof ContractError && e.type === 'unsupported');
  await assert.rejects(dispatch('toString', {}, ctx), (e: unknown) => e instanceof ContractError && e.type === 'unsupported');
});
