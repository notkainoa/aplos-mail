import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headers, sse, stubFetch, testHost } from './rig';

/**
 * Key resolution against a temp vault file. Every host here is built with an explicit `env` object, so the
 * real `process.env` is never read — and the vault file must never contain an environment key's characters.
 */

async function tempVault(): Promise<{ dir: string; vaultPath: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-eng-ai-'));
  return {
    dir,
    vaultPath: join(dir, 'keys.json'),
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

test('keySource is none, then keychain after setKey', async () => {
  const { vaultPath, done } = await tempVault();
  try {
    const { fetch } = stubFetch(() => sse(['[DONE]']));
    const host = testHost(fetch, {}, { vaultPath });
    assert.equal(host.keySource('groq'), 'none');
    assert.equal(await host.setKey('groq', 'gsk_saved_1'), 'keychain');
    assert.equal(host.keySource('groq'), 'keychain');
    const file = await stat(vaultPath);
    assert.equal(file.mode & 0o777, 0o600);
  } finally {
    await done();
  }
});

test('a saved key reaches the wire; env wins over the vault', async () => {
  const { vaultPath, done } = await tempVault();
  try {
    const { fetch, calls } = stubFetch(() => sse(['[DONE]']));
    const saved = testHost(fetch, {}, { vaultPath });
    await saved.setKey('groq', 'gsk_saved_2');
    await saved.chat({
      model: { provider: 'groq', model: 'openai/gpt-oss-120b' },
      messages: [{ role: 'user', content: 'Hi' }],
    });
    assert.equal(headers(calls.at(-1)!)['Authorization'], 'Bearer gsk_saved_2');

    const envHost = testHost(fetch, { GROQ_API_KEY: 'gsk_env_1' }, { vaultPath });
    assert.equal(envHost.keySource('groq'), 'env');
    await envHost.chat({
      model: { provider: 'groq', model: 'openai/gpt-oss-120b' },
      messages: [{ role: 'user', content: 'Hi' }],
    });
    assert.equal(headers(calls.at(-1)!)['Authorization'], 'Bearer gsk_env_1');
  } finally {
    await done();
  }
});

test('removeKey drops the vault entry; an env source still answers env', async () => {
  const { vaultPath, done } = await tempVault();
  try {
    const { fetch } = stubFetch(() => sse(['[DONE]']));
    const host = testHost(fetch, {}, { vaultPath });
    await host.setKey('groq', 'gsk_saved_3');
    assert.equal(await host.removeKey('groq'), 'none');
    assert.equal(host.keySource('groq'), 'none');

    const envHost = testHost(fetch, { GROQ_API_KEY: 'gsk_env_2' }, { vaultPath });
    await envHost.setKey('groq', 'gsk_saved_4');
    // Env provides, so removing cannot change the effective source; the stale entry is still cleared.
    assert.equal(await envHost.removeKey('groq'), 'env');
    const vault = JSON.parse(await readFile(vaultPath, 'utf8')) as Record<string, string>;
    assert.equal('groq' in vault, false);
  } finally {
    await done();
  }
});

test('the vault file never contains an environment key', async () => {
  const { vaultPath, done } = await tempVault();
  try {
    const { fetch } = stubFetch(() => sse(['[DONE]']));
    const host = testHost(fetch, { OPENAI_API_KEY: 'sk_env_secret_9' }, { vaultPath });
    await host.setKey('groq', 'gsk_saved_5');
    const raw = await readFile(vaultPath, 'utf8');
    assert.ok(!raw.includes('sk_env_secret_9'));
    assert.deepEqual(JSON.parse(raw), { groq: 'gsk_saved_5' });
  } finally {
    await done();
  }
});

test('setKey without a vault answers unavailable; bad input is invalid', async () => {
  const { fetch } = stubFetch(() => sse(['[DONE]']));
  const host = testHost(fetch, {});
  await assert.rejects(host.setKey('groq', 'gsk_saved_6'), (e: unknown) => {
    assert.equal((e as { code?: string }).code, 'unavailable');
    return true;
  });
  const { vaultPath, done } = await tempVault();
  try {
    const keyed = testHost(fetch, {}, { vaultPath });
    await assert.rejects(keyed.setKey('groq', 'two words'), (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'invalid');
      return true;
    });
  } finally {
    await done();
  }
});
