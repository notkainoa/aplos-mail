import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { tempDb } from '../store/helpers';
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
