import test from 'node:test';
import assert from 'node:assert/strict';
import {
  desktopAreas,
  engineAreas,
  getMethod,
  isMethod,
  methodNames,
  methodsByArea,
  scopes,
} from '../src/index';

test('every method is Type/verb with a host, an owning area, a scope, a kind and a summary', () => {
  for (const name of methodNames) {
    const def = getMethod(name);
    assert.match(name, /^[A-Z][A-Za-z]*\/[a-z][A-Za-z]*$/, name);
    assert.ok(
      def.host === 'engine'
        ? (engineAreas as readonly string[]).includes(def.area)
        : (desktopAreas as readonly string[]).includes(def.area),
      `${name} area ${def.area}`,
    );
    assert.ok((scopes as readonly string[]).includes(def.scope), `${name} scope`);
    assert.ok(def.kind === 'query' || def.kind === 'command', `${name} kind`);
    assert.ok(def.summary.length > 10, `${name} summary`);
  }
});

test('every engine area owns at least one method, so each F5 area file has something to fill', () => {
  const byArea = methodsByArea();
  assert.deepEqual(
    engineAreas.filter(area => !byArea[area]?.length),
    [],
  );
});

test('secret and host methods never reach the listener; desktop methods never claim the host scope', () => {
  for (const name of methodNames) {
    const def = getMethod(name);
    if (def.host === 'desktop') assert.notEqual(def.scope, 'host', name);
    if (def.secret) assert.ok(def.scope === 'admin', `${name}: secrets are admin`);
  }
  assert.ok(
    getMethod('Ai/setKey').secret &&
      getMethod('Account/connect').secret &&
      getMethod('Ai/pasteKey').secret,
  );
});

/** The methods the plans name for C1 (plan 10 section 4.1, plan 30 section 8.1, plan 20 section 7, the F1 brief). */
const named = [
  'Session/get',
  'View/watch',
  'View/move',
  'View/unwatch',
  'View/hold',
  'View/release',
  'View/query',
  'Thread/get',
  'Thread/act',
  'Operation/undo',
  'MessageBody/get',
  'MessageBody/prefetch',
  'Mail/frame',
  'Mail/release',
  'Mail/toggleQuotes',
  'Draft/get',
  'Draft/set',
  'Submission/set',
  'Outbox/pending',
  'Setup/begin',
  'Setup/end',
  'Setup/status',
  'Ai/request',
  'Ask/run',
  'Settings/get',
  'Settings/set',
  'Account/connect',
  'Account/reconnect',
  'Account/grantPermissions',
  'Account/lease',
  'Account/disconnect',
  'Account/discover',
  'Sync/request',
  'Unsubscribe/run',
  'Event/set',
  'Event/rsvp',
  'Demo/load',
  'Demo/reset',
  'Demo/remove',
  'Queue/list',
  'Queue/retry',
  'Queue/discard',
  'Consent/get',
  'Consent/grant',
  'Consent/revoke',
  'Diagnostics/preview',
  'Listener/get',
  'Listener/set',
  'Clients/list',
  'Clients/grant',
  'Clients/revoke',
  'Blob/put',
  'Blob/get',
  'Ai/transcribe',
  'Ai/setKey',
  'Ai/providers',
  'SenderRule/block',
  'SenderRule/unblock',
  'Attachment/get',
  'Data/export',
  'Search/remote',
  'Reminder/list',
  'Later/presets',
  'Notification/claim',
];
test('every method the plans name exists', () => {
  assert.deepEqual(
    named.filter(name => !isMethod(name)),
    [],
  );
});
