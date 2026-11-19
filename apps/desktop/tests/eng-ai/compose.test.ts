import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiCallError, type AiTransport, type AiChatTurn } from '@aplos/engine';
import { fakeClock } from '../../../../packages/engine/src/clock/fake';
import { composeEngineHost, type ComposeOptions } from '../../src/host/compose';
import { createAiHost } from '../../src/host/ai/index';
import { stubFetch } from './rig';
import { memoryVault } from '../prov-gov/flow-rig';

const T0 = Date.UTC(2026, 9, 27, 16, 0, 0);

function options(t: TestContext, aiTransport?: AiTransport): ComposeOptions {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-ai-bind-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dataDir: dir,
    fetch: stubFetch(() => new Response('{}')).fetch,
    clock: fakeClock(T0),
    deviceId: 'mac-ai-bind',
    power: new EventEmitter(),
    vault: memoryVault(),
    openExternal: () => undefined,
    googleClient: () => ({ env: {}, bundled: {} }),
    postNotification: () => 'posted',
    aiEnv: () => ({}),
    ...(aiTransport ? { aiTransport } : {}),
  };
}

test('an unbound compose leaves the detached stand-in: Ai/status answers honestly, chat is unavailable', async t => {
  const host = await composeEngineHost(options(t));
  t.after(() => host.close());
  const session = host.engine.connect();
  const status = (await session.call('Ai/status', {})) as {
    features: { feature: string; state: string }[];
  };
  assert.ok(
    status.features.every(f => f.state !== 'ready'),
    'no transport -> no feature reports ready, not a crash',
  );
  const turn = host.engine.services.ai.transport().chat;
  await assert.rejects(
    turn({ model: { provider: 'groq', model: 'x' }, messages: [] }),
    (e: unknown) => e instanceof AiCallError && e.code === 'unavailable',
  );
});

test('a bound fake transport answers through services.ai', async t => {
  const answer: AiChatTurn = { content: 'hello', toolCalls: [] };
  const fake: AiTransport = {
    chat: async () => answer,
    transcribe: async () => ({ text: '' }),
    models: async () => ({ list: [], live: false }),
    check: async () => undefined,
    setKey: async () => 'env' as const,
    removeKey: async () => 'none' as const,
    keySource: () => 'env' as const,
  };
  const host = await composeEngineHost(options(t, fake));
  t.after(() => host.close());
  assert.equal(
    await host.engine.services.ai
      .transport()
      .chat({ model: { provider: 'groq', model: 'x' }, messages: [] }),
    answer,
  );
});

test('createAiHost composed for real: env-first keys, vaultPath under dataDir, live addresses', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-ai-host-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let addressesCalls = 0;
  const host = createAiHost({
    fetch: stubFetch(() => new Response('{}')).fetch,
    env: { GROQ_API_KEY: 'gsk_test_key_value_ok' },
    vaultPath: join(dir, 'ai-keys.json'),
    addresses: () => (addressesCalls++, { ollama: 'http://127.0.0.1:11434' }),
  });
  assert.equal(host.keySource('groq'), 'env');
  await host.setKey('openai', 'sk-openai-fake-key-123');
  assert.equal(host.keySource('openai'), 'keychain');
  // The addresses thunk is read per request, so the local provider stays live when Settings changes.
  assert.ok(addressesCalls === 0, 'addresses read lazily, not at bind');
});
