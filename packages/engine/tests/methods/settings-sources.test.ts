import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { accountWrite, tempDb } from '../store/helpers';
import { manualClock } from '../runtime.helpers';

async function world() {
  const file = tempDb();
  const clock = manualClock();
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  const log = createLogger({ sink: { write: () => undefined }, salt: 's', clock });
  const engine = await createEngine({ store, clock, log });
  const window = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    window.call(method, args) as Promise<Output<M>>;
  return { store, engine, call, clock, file };
}

test('Consent: get, grant (version-checked), drift reconsent, revoke', async () => {
  const w = await world();
  const empty = await w.call('Consent/get', {});
  assert.equal(empty.granted, false);
  assert.equal(empty.needsReconsent, false);
  const granted = await w.call('Consent/grant', {
    scope: 'background',
    version: empty.currentVersion,
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
  });
  assert.equal(granted.granted, true);
  assert.equal(granted.needsReconsent, false);
  await assert.rejects(
    w.call('Consent/grant', { scope: 'background', version: 99, provider: 'groq', model: 'x' }),
    /consent text changed/i,
  );
  // Drift: change a background feature's model, consent asks again.
  await w.call('Settings/set', {
    opId: 's1',
    patch: {
      ai: {
        features: {
          ask: { provider: 'groq', model: 'openai/gpt-oss-120b' },
          summaries: { provider: 'openai', model: 'gpt-5-mini' },
          drafts: { provider: 'groq', model: 'openai/gpt-oss-120b' },
          plans: { provider: 'groq', model: 'openai/gpt-oss-120b' },
          voice: { provider: 'groq', model: 'whisper-large-v3-turbo' },
        },
      },
    },
  });
  const drifted = await w.call('Consent/get', {});
  assert.equal(drifted.needsReconsent, true);
  assert.equal(drifted.currentVersion, granted.currentVersion + 1);
  // Re-consent lands at the bumped version (a repeated opId must never replay).
  const regranted = await w.call('Consent/grant', {
    scope: 'background',
    version: drifted.currentVersion,
    provider: 'openai',
    model: 'gpt-5-mini',
  });
  assert.equal(regranted.needsReconsent, false);
  assert.equal(regranted.granted, true);
  const revoked = await w.call('Consent/revoke', { scope: 'background' });
  assert.equal(revoked.granted, false);
  // Grant again after revoke — not a replay.
  const again = await w.call('Consent/grant', {
    scope: 'background',
    version: revoked.currentVersion,
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
  });
  assert.equal(again.granted, true);
});

test('Listener: off by default, set persists', async () => {
  const w = await world();
  assert.deepEqual(await w.call('Listener/get', {}), { enabled: false });
  await w.call('Listener/set', { enabled: true });
  assert.deepEqual(await w.call('Listener/get', {}), { enabled: true });
  // Toggling back and forth again must not replay the earlier commits.
  await w.call('Listener/set', { enabled: false });
  await w.call('Listener/set', { enabled: true });
  assert.deepEqual(await w.call('Listener/get', {}), { enabled: true });
});

test('Clients: list is empty, revoke unknown id is notFound, audit is empty', async () => {
  const w = await world();
  assert.deepEqual(await w.call('Clients/list', {}), { list: [] });
  assert.deepEqual(await w.call('Clients/audit', {}), { list: [] });
  await assert.rejects(w.call('Clients/revoke', { id: 'nope' }), /no longer allowed/);
});

test('Queue: empty list; retry/discard of a stored op re-dispatches', async () => {
  const w = await world();
  assert.deepEqual(await w.call('Queue/list', {}), { list: [] });
  await assert.rejects(w.call('Queue/retry', { id: 'op:nope' }), /no longer in the queue/);
  await assert.rejects(w.call('Queue/discard', { id: 'sub:nope' }), /no longer in the queue/);
});

test('Ai/providers: hosted rows report env key source or missingKey, never a key', async () => {
  const w = await world();
  const { list } = await w.call('Ai/providers', {});
  assert.equal(list.length, 9);
  const groq = list.find(p => p.id === 'groq')!;
  assert.equal(groq.envVar, 'GROQ_API_KEY');
  assert.ok(['missingKey', 'ready'].includes(groq.status));
  assert.ok(!('key' in groq));
  const custom = list.find(p => p.id === 'custom')!;
  assert.equal(custom.status, 'notConfigured');
});

test('Ai/models and Ai/usage read empty honestly', async () => {
  const w = await world();
  const models = await w.call('Ai/models', { provider: 'groq' });
  assert.ok(models.list.length > 0);
  const usage = await w.call('Ai/usage', {});
  assert.equal(usage.byModel.length, 0);
  const status = await w.call('Ai/status', {});
  assert.equal(status.features.length, 5);
});

test('Queue/list shows a stored op with namespaced id', async () => {
  const w = await world();
  w.store.commit({ opId: 'seed-account', origin: 'local', writes: [{ ...accountWrite }] });
  w.store.commit({
    opId: 'seed-op',
    origin: 'local',
    writes: [
      {
        kind: 'op',
        opId: 'op-1',
        accountId: 'acct-1',
        opKind: 'archive',
        targets: ['t1'],
        payload: '{}',
        effect: [],
        scope: 'triage',
      },
    ],
  });
  const { list } = await w.call('Queue/list', {});
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, 'op:op-1');
  assert.equal(list[0]!.scope, 'triage');
  await w.call('Queue/discard', { id: 'op:op-1' });
  assert.equal((await w.call('Queue/list', {})).list.length, 0);
});

test('Clients: a stored client lists; revoke stamps revokedAt and repeats fine', async () => {
  const w = await world();
  // No write kind creates a client yet (the listener transport will): seed the row on a second handle.
  const db = w.file.open();
  db.prepare(
    "INSERT INTO clients(id, name, kind, scopes, token_hash, created_at, last_seen_at, revoked_at) VALUES('cl-1', 'iPad', 'listener', '[\"read\"]', 'x', 1000, NULL, NULL)",
  ).run();
  db.close();
  const { list } = await w.call('Clients/list', {});
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, 'cl-1');
  await w.call('Clients/revoke', { id: 'cl-1' });
  const after = await w.call('Clients/list', {});
  assert.ok(after.list[0]!.revokedAt !== undefined);
  await w.call('Clients/revoke', { id: 'cl-1' }); // a second revoke does not replay a commit
});

test('Consent: changing a provider endpoint forces reconsent (fingerprint covers origin+path)', async () => {
  const w = await world();
  const grant = await w.call('Consent/grant', {
    scope: 'background',
    version: 1,
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
  });
  assert.equal(grant.granted, true);
  // Move the provider's address: the fingerprint drifts -> needsReconsent + a newer currentVersion.
  await w.call('Settings/set', {
    opId: 'addr1',
    patch: { ai: { providers: { groq: { address: 'https://other.example/v1' } } } },
  });
  const drifted = await w.call('Consent/get', {});
  assert.equal(drifted.needsReconsent, true);
  assert.ok(drifted.currentVersion > (drifted.version ?? 0));
});

test('Consent: a provider URL with credentials keys the same fingerprint as the bare origin', async () => {
  const w = await world();
  // URL userinfo and query are dropped by URL parsing — the fingerprint sees origin + path only, so
  // adding credentials never leaks them nor forces a needless re-consent.
  await w.call('Settings/set', {
    opId: 'addr2',
    patch: {
      ai: { providers: { groq: { address: 'https://api.groq.com/openai/v1?key=leak' } } },
    },
  });
  // Credentials in an address are refused at Settings/set now (#374), so the fingerprint never sees them.
  await assert.rejects(
    w.call('Settings/set', {
      opId: 'addr3',
      patch: {
        ai: { providers: { groq: { address: 'https://user:pass@api.groq.com/openai/v1' } } },
      },
    }),
    { type: 'validation' },
  );
  const same = await w.call('Consent/get', {});
  assert.equal(same.needsReconsent, false, 'URL userinfo/query never reach the fingerprint');
});

test('Settings/set refuses a provider address that is not a plain http(s) server address', async () => {
  const w = await world();
  for (const address of [
    'file:///etc/passwd',
    'ftp://example.test',
    'not a url',
    'http://u:p@localhost:11434',
  ]) {
    await assert.rejects(
      w.call('Settings/set', {
        opId: `bad-${address}`,
        patch: { ai: { providers: { ollama: { address } } } },
      }),
      { type: 'validation' },
      address,
    );
  }
  await w.call('Settings/set', {
    opId: 'good-local',
    patch: { ai: { providers: { ollama: { address: 'http://localhost:11434' } } } },
  });
});
