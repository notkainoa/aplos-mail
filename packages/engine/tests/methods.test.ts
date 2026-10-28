import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { engineAreas, getMethod, methodNames, type Scope } from '@aplos/contract';
import { ContractError, NotImplementedError } from '@aplos/contract/contract-error';
import { listenerMethods, mcpMethods } from '@aplos/contract/allowlists';
import {
  dispatch,
  handlers,
  type Caller,
  type EngineServices,
  type MethodContext,
} from '../src/methods/index';

const dir = join(import.meta.dirname, '..', 'src', 'methods');
const grantable: Scope[] = ['read', 'triage', 'draft', 'send', 'ai', 'admin'];
const as = (caller: Caller): MethodContext => ({
  caller,
  signal: new AbortController().signal,
  services: {} as EngineServices,
});
const ctx = as({ kind: 'window', scopes: grantable });
const forbidden = (e: unknown) => e instanceof ContractError && e.type === 'forbidden';
const reached = (e: unknown) => e instanceof NotImplementedError;

test("every engine method has exactly one handler entry, in its own area's file", async () => {
  const seen = new Map<string, string[]>();
  for (const area of engineAreas) {
    const module = (await import(join(dir, `${area}.ts`))) as { handlers: Record<string, unknown> };
    for (const name of Object.keys(module.handlers)) {
      seen.set(name, [...(seen.get(name) ?? []), area]);
      assert.equal(
        getMethod(name).area,
        area,
        `${name} sits in ${area}.ts but belongs to ${getMethod(name).area}`,
      );
    }
  }
  const engine = methodNames.filter(name => getMethod(name).host === 'engine');
  assert.deepEqual(
    engine.filter(name => seen.get(name)?.length !== 1),
    [],
    'missing or duplicated handlers',
  );
  assert.deepEqual(
    [...seen.keys()].filter(name => getMethod(name).host !== 'engine'),
    [],
    'desktop methods never reach the engine',
  );
  assert.deepEqual(Object.keys(handlers).sort(), [...engine].sort());
});

test('there is one file per engine area and nothing else besides the table and its types', () => {
  const files = readdirSync(dir)
    .map(f => f.replace(/\.ts$/, ''))
    .sort();
  assert.deepEqual(files, [...engineAreas, 'index', 'types'].sort());
});

test('a stub rejects with notImplemented, and an unknown method with unsupported', async () => {
  await assert.rejects(
    dispatch('Thread/act', { opId: 'o1', ids: ['a1:t1'], action: { type: 'done' } }, ctx),
    (e: unknown) => e instanceof NotImplementedError && e.type === 'notImplemented',
  );
  await assert.rejects(
    dispatch('File/save', {}, ctx),
    (e: unknown) => e instanceof ContractError && e.type === 'unsupported',
  );
  await assert.rejects(
    dispatch('toString', {}, ctx),
    (e: unknown) => e instanceof ContractError && e.type === 'unsupported',
  );
});

test('dispatch denies by default: scope, host-only, uiOnly, secret and MCP are checked before any handler', async () => {
  const reader = as({ kind: 'listener', via: 'socket', clientId: 'c1', scopes: ['read'] });
  // A read-only listener can neither send nor reach main's own methods, whatever the transport checked.
  await assert.rejects(
    dispatch('Submission/set', { action: { type: 'send', id: 's1', revision: 1 } }, reader),
    forbidden,
  );
  await assert.rejects(dispatch('Mail/serve', {}, reader), forbidden);
  await assert.rejects(dispatch('Thread/get', {}, reader), reached, 'its own scope gets through');
  // Host methods need main's control connection even when a window claims the scope.
  await assert.rejects(
    dispatch('Notification/claim', {}, as({ kind: 'window', scopes: [...grantable, 'host'] })),
    forbidden,
  );
  await assert.rejects(
    dispatch('Notification/claim', {}, as({ kind: 'host', scopes: ['host'] })),
    reached,
  );
  // An admin listener still cannot reach a uiOnly (Data/export) or secret (Ai/setKey) method; a window can.
  const admin = as({ kind: 'listener', via: 'http', scopes: grantable });
  for (const method of ['Data/export', 'Ai/setKey']) {
    await assert.rejects(dispatch(method, {}, admin), forbidden, method);
    await assert.rejects(dispatch(method, {}, ctx), reached, method);
  }
  // A window without a scope is refused too: the grant, not the kind, carries permission.
  await assert.rejects(
    dispatch('Thread/act', {}, as({ kind: 'window', scopes: ['read'] })),
    forbidden,
  );
  // MCP clients reach only the MCP tools, even with a wider grant.
  const mcp = as({ kind: 'listener', via: 'mcp', scopes: grantable });
  const notTool = listenerMethods.find(m => !(mcpMethods as readonly string[]).includes(m))!;
  await assert.rejects(dispatch(notTool, {}, mcp), forbidden, notTool);
  await assert.rejects(dispatch(mcpMethods[0], {}, mcp), reached);
});

test('every engine method is refused to a caller that holds no scope', async () => {
  const none = as({ kind: 'host', scopes: [] });
  for (const name of Object.keys(handlers))
    await assert.rejects(dispatch(name, {}, none), forbidden, name);
});
