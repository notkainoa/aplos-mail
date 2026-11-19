import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS } from '../../src/host/ai/providers';
import { realComposeOptions, realHostPorts } from '../../src/main/engine-utility';

// Tripwires for the privacy page's "What leaves your Mac" list (apps/web claims.json `only-these-destinations`):
// Google, the AI providers you set up, image hosts through the proxy when images are allowed, and GitHub for updates.
// The rest of the audit is in that claim's evidence. If one of these fails, a new destination reached the real engine:
// update apps/web/src/Privacy.tsx and the claim before changing the expectation here.

test('the real engine gets no unsubscribe executor, so no sender-chosen unsubscribe URL is contacted', async t => {
  assert.deepEqual(Object.keys(realHostPorts()).sort(), ['html', 'images']);
  const dir = mkdtempSync(join(tmpdir(), 'aplos-destinations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bridge = { request: async () => undefined, power: new EventEmitter() };
  const composed = await realComposeOptions({ dataDir: dir, appVersion: '0.3.0-test' }, bridge);
  assert.equal(
    'unsubscribe' in (composed.ports ?? {}),
    false,
    'wiring one-click unsubscribe adds the sender’s server to the privacy page',
  );
});

test('AI requests go only to the listed providers or an address the owner sets', () => {
  const hosts = PROVIDERS.map(p => {
    const url = p.base ?? p.defaultAddress;
    return url ? new URL(url).host : `${p.id}: owner's address`;
  });
  assert.deepEqual(hosts, [
    'api.groq.com',
    'api.openai.com',
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
    'openrouter.ai',
    'opencode.ai',
    'localhost:11434',
    'localhost:1234',
    "custom: owner's address",
  ]);
  for (const p of PROVIDERS)
    if (p.modelsUrl) assert.equal(new URL(p.modelsUrl).host, new URL(p.base!).host);
});
