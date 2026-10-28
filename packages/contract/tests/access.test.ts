import test from 'node:test';
import assert from 'node:assert/strict';
import { appScopes, checkAccess, principalOf, requireScope, type Caller } from '../src/access';
import { ContractError, getMethod, methodNames } from '../src/index';
import * as tables from '../generated/methods.generated';

/** The default-deny rules of `@aplos/contract/access` (freeze FR-3, FR-4, FR-5, FR-6, FR-11). */
const window: Caller = { kind: 'window', scopes: appScopes };
const tool = (...scopes: string[]): Caller => ({ kind: 'listener', clientId: 'c1', scopes });
const denied = (fn: () => void) =>
  assert.throws(fn, (e: unknown) => e instanceof ContractError && e.type === 'forbidden');

test('a listener holding read is refused a send, a host method and a UI-only method', () => {
  denied(() => checkAccess('Submission/set', tool('read')));
  denied(() => checkAccess('Mail/serve', tool('read', 'host')));
  denied(() => checkAccess('Clients/grant', tool('admin')));
  checkAccess('Thread/get', tool('read'));
  checkAccess('Clients/grant', window);
  denied(() => checkAccess('Notification/claim', window));
  checkAccess('Notification/claim', { kind: 'host', scopes: ['host'] });
});

/** FR-5: one admin-scoped tool must not grant consent or point AI at another server. */
test('listener clients cannot grant AI consent, change AI settings or opt an account into AI', () => {
  const admin = tool('admin', 'read');
  denied(() => checkAccess('Consent/grant', admin, {}));
  denied(() =>
    checkAccess('Settings/set', admin, {
      opId: 'o',
      patch: { ai: { providers: { ollama: { address: 'http://203.0.113.9:11434/v1' } } } },
    }),
  );
  denied(() => checkAccess('Account/set', admin, { opId: 'o', accountId: 'a', aiAllowed: true }));
  checkAccess('Settings/set', admin, { opId: 'o', patch: { ui: { theme: 'dark' } } });
  checkAccess('Account/set', admin, { opId: 'o', accountId: 'a', name: 'Work' });
  checkAccess('Settings/set', window, { opId: 'o', patch: { ai: { background: true } } });
});

/** FR-6: a frame URL is useless outside Electron, and listeners sharing the reader's token cap could evict its frames. */
test('mail frames are for Electron windows only', () => {
  for (const name of ['Mail/frame', 'Mail/release', 'Mail/toggleQuotes'])
    denied(() => checkAccess(name, tool('read')));
  assert.notEqual(principalOf(tool('read')), principalOf(window));
  assert.equal(principalOf({ kind: 'host', scopes: ['host'] }), principalOf(window));
});

/** FR-3: undo, retry and the queue act on another method's effect, so they carry that method's scope too. */
test('undo, retry and the queue are audited and need the originating scope', () => {
  for (const name of ['Operation/undo', 'Operation/retry', 'Queue/retry', 'Queue/discard']) {
    const def = getMethod(name);
    assert.equal(def.scopeRule, 'originating', name);
    assert.ok(def.audit, `${name} is audited`);
  }
  denied(() => requireScope(tool('triage'), 'send'));
  requireScope(tool('triage', 'send'), 'send');
  requireScope(window, 'send');
});

/** FR-4: a triage-scoped call must never carry who to invite or mail; that is `send`. */
test('no triage-reachable input carries attendees or recipients', () => {
  type Def = { type: string; [key: string]: unknown };
  const defOf = (s: unknown): Def => (s as { _zod: { def: Def } })._zod.def;
  const unwrap = (s: unknown) => {
    let def = defOf(s);
    while (def.innerType) def = defOf(def.innerType);
    return def;
  };
  /** Keys holding a list of people: an array of objects with an `address` (attendees, to, cc, bcc). */
  const people = (schema: unknown, out: string[], seen = new Set<unknown>()): string[] => {
    if (seen.has(schema)) return out;
    seen.add(schema);
    const def = unwrap(schema);
    if (def.type === 'object')
      for (const [k, v] of Object.entries(def.shape as Record<string, unknown>)) {
        const inner = unwrap(v);
        if (inner.type === 'array' && unwrap(inner.element).type === 'object')
          if ('address' in (unwrap(inner.element).shape as object)) out.push(k);
        people(v, out, seen);
      }
    if (def.type === 'array') people(def.element, out, seen);
    if (def.type === 'record') people(def.valueType, out, seen);
    for (const o of (def.options as unknown[] | undefined) ?? []) people(o, out, seen);
    return out;
  };
  assert.deepEqual(people(getMethod('Event/set').input, []).sort(), ['attendees', 'attendees']);
  for (const name of methodNames) {
    const def = getMethod(name);
    if (def.scope !== 'triage' && def.scope !== 'read') continue;
    const found = people(def.input, []);
    assert.deepEqual(found, [], `${name} (${def.scope}) takes ${found.join(', ')}`);
  }
  assert.equal(getMethod('Ask/decide').scopeRule, 'guests', 'accepting an invite needs send');
  assert.ok(getMethod('Plan/confirm').audit && getMethod('Ask/decide').audit);
  // A stray `attendees` from an old client is dropped, never written.
  const parsed = getMethod('Plan/confirm').input.parse({
    opId: 'o',
    id: 'p',
    fields: { attendees: [{ address: 'x@guest.example' }] },
  }) as { fields: Record<string, unknown> };
  assert.equal(parsed.fields.attendees, undefined);
});

test('the generated access tables agree with the registry', () => {
  for (const name of methodNames) {
    const def = getMethod(name);
    assert.equal(tables.methodScopeRule[name], def.scopeRule, name);
    assert.deepEqual(tables.windowOnlyArgs[name], def.windowOnlyArgs, name);
    assert.equal((tables.uiOnlyMethods as readonly string[]).includes(name), !!def.uiOnly, name);
  }
});
