import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appScopes,
  checkAccess,
  listenerCaller,
  principalOf,
  requireOriginating,
  requireScope,
  type Caller,
} from '../src/access';
import { ContractError, getMethod, methodNames, Operation, QueueItem } from '../src/index';
import * as tables from '../generated/methods.generated';

/** The default-deny rules of `@aplos/contract/access` (freeze FR-3, FR-4, FR-5, FR-6, FR-11). */
const window: Caller = { kind: 'window', scopes: appScopes };
const tool = (...scopes: string[]): Caller => ({
  kind: 'listener',
  via: 'socket',
  clientId: 'c1',
  scopes,
});
const refused = (type: string) => (fn: () => void) =>
  assert.throws(fn, (e: unknown) => e instanceof ContractError && e.type === type);
const denied = refused('forbidden');
const unsupported = refused('unsupported');

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
  for (const name of [
    'Operation/undo',
    'Operation/retry',
    'Queue/retry',
    'Queue/discard',
    'Draft/destroy',
  ]) {
    const def = getMethod(name);
    assert.equal(def.scopeRule, 'originating', name);
    assert.ok(def.audit, `${name} is audited`);
  }
  denied(() => requireScope(tool('triage'), 'send'));
  requireScope(tool('triage', 'send'), 'send');
  requireScope(window, 'send');
});

/** R2B-1: an operation whose scope was not recorded falls back to its method's scope, and is refused when unknown. */
test('the originating-scope check fails closed', () => {
  const triage = tool('read', 'triage');
  for (const method of ['Event/rsvp', 'Unsubscribe/run', 'Submission/set'])
    denied(() => requireOriginating(triage, { method }));
  requireOriginating(tool('triage', 'send'), { method: 'Event/rsvp' });
  denied(() => requireOriginating(triage, { scope: 'send', method: 'Thread/act' }));
  requireOriginating(triage, { scope: 'triage', method: 'Thread/act' });
  // Neither a recorded scope nor a known method: no listener passes, whatever it holds; a window does.
  denied(() => requireOriginating(tool(...appScopes), { method: 'Nope/nope' }));
  denied(() => requireOriginating(tool(...appScopes), { scope: '', method: 'Nope/nope' }));
  requireOriginating(window, { method: 'Nope/nope' });
  // Outputs must carry the scope, so an engine cannot leave it out.
  const op = {
    opId: 'o',
    kind: 'Event/rsvp',
    targets: [],
    state: 'queued',
    appliedState: { dbEpoch: 'e', seq: 1 },
    undoable: true,
    createdAt: 1,
  };
  assert.equal(Operation.safeParse(op).success, false, 'an Operation needs its scope');
  assert.equal(Operation.safeParse({ ...op, scope: 'send' }).success, true);
  const item = {
    id: 'q',
    kind: 'op',
    label: 'Rsvp 1 item',
    state: 'queued',
    attempts: 1,
    createdAt: 1,
    canRetry: false,
    canDiscard: true,
  };
  assert.equal(QueueItem.safeParse(item).success, false, 'a QueueItem needs its scope');
  assert.equal(QueueItem.safeParse({ ...item, scope: 'send' }).success, true);
});

/** R2B-3: who a listener is comes from its stored Client row, and a listener nobody identified gets nothing. */
test('a listener caller comes from the stored client; MCP limits follow the client, not the transport', () => {
  const row = { id: 'c9', kind: 'mcp', scopes: ['read', 'draft', 'send', 'host'] };
  // A listener method the client's scopes reach but MCP does not (a send).
  const notTool = (tables.listenerMethods as readonly string[]).find(
    m => !(tables.mcpMethods as readonly string[]).includes(m) && tables.methodScope[m] === 'send',
  )!;
  assert.ok(notTool);
  for (const transport of ['socket', 'http', 'mcp'] as const) {
    const caller = listenerCaller(row, transport);
    assert.equal(caller.via, 'mcp', `an mcp client over ${transport} is an MCP caller`);
    assert.equal(caller.clientId, 'c9');
    assert.ok(!caller.scopes.includes('host'), 'host is never a listener scope');
    denied(() => checkAccess(notTool, caller));
    checkAccess(
      tables.mcpMethods.find(m => tables.methodScope[m] === 'read')!,
      caller,
    );
  }
  const cli = listenerCaller({ id: 'c8', kind: 'cli', scopes: ['send'] }, 'socket');
  assert.equal(cli.via, 'socket');
  checkAccess(notTool, cli);
  denied(() => listenerCaller({ ...row, revokedAt: 5 }, 'socket'));
  // A transport that skipped `listenerCaller` is refused, and never shares a blob principal.
  const anonymous: Caller = { kind: 'listener', via: 'socket', scopes: ['read'] };
  denied(() => checkAccess('Thread/get', anonymous));
  denied(() => checkAccess('Thread/get', { kind: 'listener', clientId: 'c1', scopes: ['read'] }));
  denied(() => principalOf(anonymous));
  checkAccess('Thread/get', tool('read'));
});

/** R2H-3: no name outside the engine table slips through, and a listener gets nothing outside `listenerMethods`. */
test('checkAccess refuses desktop, unknown and prototype names instead of returning', () => {
  const all = tool(...appScopes);
  for (const name of [
    'Ai/pasteKey',
    'Shell/open',
    'System/login',
    'Fixture/control',
    'Nope/nope',
    'toString',
    '__proto__',
    'constructor',
    'hasOwnProperty',
  ]) {
    denied(() => checkAccess(name, all));
    denied(() => checkAccess(name, { ...all, via: 'mcp' }));
    unsupported(() => checkAccess(name, window));
    unsupported(() => checkAccess(name, { kind: 'host', scopes: appScopes }));
  }
  // A prototype key never reads as a recorded originating scope either.
  denied(() => requireOriginating(all, { method: 'toString' }));
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

test('Demo/* are window-only and audited; a listener holding every scope is refused all three', () => {
  const everything = tool(...appScopes.filter(scope => scope !== 'host'));
  for (const method of ['Demo/load', 'Demo/reset', 'Demo/remove']) {
    assert.ok(!(tables.listenerMethods as readonly string[]).includes(method), method);
    assert.ok((tables.uiOnlyMethods as readonly string[]).includes(method), method);
    assert.throws(() => checkAccess(method, everything), ContractError, method);
    assert.doesNotThrow(() => checkAccess(method, window), method);
  }
  // Reset deletes and rebuilds the demo accounts, as remove deletes them: both are audited (any non-window call would be).
  for (const method of ['Demo/reset', 'Demo/remove'])
    assert.ok((tables.auditMethods as readonly string[]).includes(method), method);
});
