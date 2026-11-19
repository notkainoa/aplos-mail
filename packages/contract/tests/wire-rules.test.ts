import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/mini';
import * as contract from '../src/index';
import { Bytes, getMethod, methodNames } from '../src/index';

/**
 * The wire rules (ARCH 9.3) as a lint over every registered schema: no tuples, no `Date`/`Map`/`Set`/`BigInt`, no
 * transforms, defaults or catches that change data, no lazy or intersection types, unions of objects only when
 * discriminated, and `Bytes` as the only custom type. Then every schema must convert to JSON Schema for OpenAPI.
 */
type Def = { type: string; [key: string]: unknown };
const defOf = (schema: unknown): Def => (schema as { _zod: { def: Def } })._zod.def;
const forbidden = new Set([
  'tuple',
  'date',
  'map',
  'set',
  'bigint',
  'transform',
  'pipe',
  'default',
  'prefault',
  'catch',
  'promise',
  'symbol',
  'nan',
  'file',
  'function',
  'lazy',
  'intersection',
  'undefined',
  'void',
]);
const wrappers = new Set(['optional', 'nullable', 'readonly', 'nonoptional']);

function unwrap(schema: unknown): Def {
  let def = defOf(schema);
  while (wrappers.has(def.type)) def = defOf(def.innerType);
  return def;
}

function lint(schema: unknown, path: string, problems: string[], seen = new Set<unknown>()): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const def = defOf(schema);
  if (forbidden.has(def.type)) problems.push(`${path}: ${def.type}`);
  if (def.type === 'custom' && schema !== Bytes)
    problems.push(`${path}: a custom type other than Bytes`);
  const children: [string, unknown][] = [];
  if (wrappers.has(def.type)) children.push(['', def.innerType]);
  if (def.type === 'object')
    for (const [key, value] of Object.entries(def.shape as Record<string, unknown>))
      children.push([`.${key}`, value]);
  if (def.type === 'array') children.push(['[]', def.element]);
  if (def.type === 'record') children.push(['{key}', def.keyType], ['{}', def.valueType]);
  if (def.type === 'union') {
    const options = def.options as unknown[];
    if (options.some(o => unwrap(o).type === 'object') && !def.discriminator)
      problems.push(`${path}: a union of objects without a discriminator`);
    options.forEach((o, i) => children.push([`|${i}`, o]));
  }
  for (const [suffix, child] of children) lint(child, path + suffix, problems, seen);
}

function allSchemas(): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const name of methodNames)
    out.push([`${name} input`, getMethod(name).input], [`${name} output`, getMethod(name).output]);
  for (const [name, value] of Object.entries(contract))
    if (value && typeof value === 'object' && '_zod' in value) out.push([name, value]);
  return out;
}

test('every registered schema follows the wire rules', () => {
  const problems: string[] = [];
  for (const [name, schema] of allSchemas()) lint(schema, name, problems);
  assert.deepEqual(problems, []);
});

test('the lint catches each forbidden shape', () => {
  const bad: [string, z.ZodMiniType][] = [
    ['tuple', z.tuple([z.string(), z.number()])],
    ['date', z.object({ at: z.date() })],
    ['map', z.map(z.string(), z.string())],
    ['bigint', z.bigint()],
    [
      'transform',
      z.pipe(
        z.string(),
        z.transform(v => v.length),
      ),
    ],
    ['default', z._default(z.string(), 'x')],
    ['union', z.union([z.object({ a: z.string() }), z.object({ b: z.string() })])],
    ['custom', z.custom<string>(() => true)],
  ];
  for (const [label, schema] of bad) {
    const problems: string[] = [];
    lint(schema, label, problems);
    assert.ok(problems.length > 0, `${label} should fail the lint`);
  }
});

test('every method input is an object, so HTTP bodies are JSON objects and fields can be added within v1', () => {
  const notObjects = methodNames.filter(name => defOf(getMethod(name).input).type !== 'object');
  assert.deepEqual(notObjects, []);
});

test('every registered schema converts to JSON Schema 2020-12', () => {
  // zod refuses custom types before an override runs, so `Bytes` is allowed by the lint above, not here.
  for (const [name, schema] of allSchemas()) {
    assert.doesNotThrow(
      () =>
        z.toJSONSchema(schema as z.ZodMiniType, {
          target: 'draft-2020-12',
          unrepresentable: 'any',
        }),
      name,
    );
  }
});
