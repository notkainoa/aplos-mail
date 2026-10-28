import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiKeys } from '../src/main/ai-keys';
import { createCipher } from '../src/main/keyring';
import { createGroq } from '../src/main/groq';
import { createOpenRouter } from '../src/main/providers';
import { createService } from '../src/main/service';
import { createGoogle } from '../src/main/google';
import { checkKey } from '../src/main/llm';
import type { AppState } from '@aplos/contract/legacy/types';

const SAVED = 'gsk_saved_SYNTHETIC_key_0000000000wxyz',
  FROM_ENV = 'gsk_env_SYNTHETIC_key_000000000000abcd';
async function folder() {
  return mkdtemp(join(tmpdir(), 'aplos-keys-'));
}
function sealer() {
  const cipher = createCipher(randomBytes(32));
  return { encrypt: (v: string) => cipher.encrypt(v), decrypt: (v: Buffer) => cipher.decrypt(v) };
}
/** A fetch that records the bearer token each request carried. */
function recorder(status = 200, body: unknown = { data: [] }) {
  const seen: string[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(String(new Headers(init?.headers).get('authorization')));
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { seen, fetch };
}

test('a key saved in Settings wins over the environment, which wins over nothing, and providers read it per request', async () => {
  const dataDir = await folder();
  try {
    const env: Record<string, string | undefined> = {};
    const keys = await createAiKeys({ dataDir, ...sealer(), env });
    const net = recorder();
    const groq = createGroq({ apiKey: () => keys.resolve('groq'), fetch: net.fetch });
    // None: not available, and the error says where to add one.
    assert.equal(keys.resolve('groq'), undefined);
    assert.deepEqual(keys.info('groq'), {});
    assert.equal(groq.available, false);
    await assert.rejects(groq.check!(), /Add your Groq key in Settings → AI/);
    // Environment only.
    env.GROQ_API_KEY = FROM_ENV;
    assert.equal(keys.resolve('groq'), FROM_ENV);
    assert.deepEqual(keys.info('groq'), { source: 'environment', last4: 'abcd' });
    assert.equal(groq.available, true);
    await groq.check!();
    assert.equal(net.seen.at(-1), `Bearer ${FROM_ENV}`);
    // Saved beats environment, with no restart of the provider.
    await keys.set('groq', `  ${SAVED}\n`);
    assert.equal(keys.resolve('groq'), SAVED);
    assert.deepEqual(keys.info('groq'), { source: 'saved', last4: 'wxyz' });
    await groq.check!();
    assert.equal(net.seen.at(-1), `Bearer ${SAVED}`);
    // Other providers are untouched.
    assert.equal(keys.resolve('openai'), undefined);
    await assert.rejects(keys.set('groq', 'not a key'), /doesn’t look like an API key/);
    await assert.rejects(keys.set('nope' as 'groq', SAVED), /Choose an AI provider/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('saved keys are encrypted on disk, survive a restart and fall back to the environment once removed', async () => {
  const dataDir = await folder(),
    seal = sealer();
  try {
    const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: FROM_ENV };
    const first = await createAiKeys({ dataDir, ...seal, env });
    await first.set('openrouter', SAVED);
    for (const name of await readdir(dataDir))
      assert.ok(
        !(await readFile(join(dataDir, name), 'utf8')).includes(SAVED),
        `${name} holds the key in plain text`,
      );
    const reopened = await createAiKeys({ dataDir, ...seal, env });
    assert.equal(reopened.resolve('openrouter'), SAVED);
    const net = recorder(200, { data: { label: 'x' } });
    const router = createOpenRouter({
      apiKey: () => reopened.resolve('openrouter'),
      fetch: net.fetch,
    });
    await router.check!();
    assert.equal(net.seen.at(-1), `Bearer ${SAVED}`);
    await reopened.delete('openrouter');
    assert.deepEqual(reopened.info('openrouter'), { source: 'environment', last4: 'abcd' });
    await router.check!();
    assert.equal(net.seen.at(-1), `Bearer ${FROM_ENV}`);
    assert.equal(
      (await createAiKeys({ dataDir, ...seal, env: {} })).resolve('openrouter'),
      undefined,
    );
    // Without the keychain (the browser preview) nothing can be saved, and the reason says so.
    const preview = await createAiKeys({ dataDir, env });
    assert.equal(preview.secure, false);
    await assert.rejects(preview.set('groq', SAVED), /only be saved in the Aplos Mail desktop app/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the renderer sees only the key’s source and last four characters, never the key', async () => {
  const dataDir = await folder();
  try {
    const service = await createService({
      dataDir,
      ...sealer(),
      google: await createGoogle({ dataDir, clientId: '' }),
      groq: createGroq({ apiKey: '' }),
      autoSyncMs: 0,
      env: { GEMINI_API_KEY: FROM_ENV },
    });
    try {
      const info = await service.invoke('ai.key.set', { provider: 'anthropic', key: SAVED });
      assert.deepEqual(info, { source: 'saved', last4: 'wxyz' });
      const listed = (await service.invoke('ai.keys')) as {
        secure: boolean;
        providers: Record<string, { source?: string; last4?: string }>;
      };
      assert.equal(listed.secure, true);
      assert.deepEqual(listed.providers.anthropic, { source: 'saved', last4: 'wxyz' });
      assert.deepEqual(listed.providers.gemini, { source: 'environment', last4: 'abcd' });
      assert.deepEqual(listed.providers.openai, {});
      const everything = JSON.stringify([
        info,
        listed,
        (await service.invoke('state.get')) as AppState,
        await service.invoke('capabilities.get'),
      ]);
      assert.ok(!everything.includes(SAVED) && !everything.includes(FROM_ENV));
      assert.deepEqual(await service.invoke('ai.key.delete', { provider: 'anthropic' }), {});
      await assert.rejects(
        service.invoke('ai.key.test', { provider: 'openai' }),
        /Add your ChatGPT key first/,
      );
    } finally {
      await service.close();
    }
    // The browser preview has no keychain: saving explains where keys can be saved.
    const preview = await createService({
      dataDir,
      google: await createGoogle({ dataDir, clientId: '' }),
      groq: createGroq({ apiKey: '' }),
      autoSyncMs: 0,
      env: {},
    });
    try {
      assert.equal(((await preview.invoke('ai.keys')) as { secure: boolean }).secure, false);
      await assert.rejects(
        preview.invoke('ai.key.set', { provider: 'groq', key: SAVED }),
        /only be saved in the Aplos Mail desktop app/,
      );
    } finally {
      await preview.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a refused key shows the provider’s own reason with the key removed', async () => {
  const fetch = (async () =>
    new Response(
      JSON.stringify({
        error: { message: `Invalid API Key: ${SAVED} (sk-proj-ABCDEFGHIJKLmnop)` },
      }),
      { status: 401 },
    )) as typeof globalThis.fetch;
  await assert.rejects(
    checkKey({
      name: 'Groq',
      env: 'GROQ_API_KEY',
      baseUrl: 'https://groq.example',
      apiKey: SAVED,
      fetch,
    }),
    (error: Error) => {
      assert.match(error.message, /^Groq didn’t accept this key: Invalid API Key/);
      assert.ok(
        !error.message.includes(SAVED) && !error.message.includes('ABCDEFGHIJ'),
        error.message,
      );
      return true;
    },
  );
});

test('the welcome flow runs once on a fresh data folder and stays finished after a restart', async () => {
  const dataDir = await folder();
  const open = async () =>
    createService({
      dataDir,
      google: await createGoogle({ dataDir, clientId: '' }),
      groq: createGroq({ apiKey: '' }),
      autoSyncMs: 0,
      env: {},
    });
  try {
    let service = await open();
    try {
      assert.equal(
        ((await service.invoke('state.get')) as AppState).settings.onboardingDone,
        false,
      );
      await service.invoke('settings.update', { patch: { onboardingDone: true } });
    } finally {
      await service.close();
    }
    service = await open();
    try {
      assert.equal(((await service.invoke('state.get')) as AppState).settings.onboardingDone, true);
    } finally {
      await service.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
