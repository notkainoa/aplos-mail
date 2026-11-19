import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { createGoogle } from '../src/main/google';
import { oauthEnv } from '../src/main/oauth-config';
import { resolveGoogleClient } from '../src/host/providers/oauth/client';
import { checkReleaseOAuth, oauthDefines } from '../scripts/oauth-defines.mjs';

const bundled = { clientId: 'bundled-id.apps.example.test', clientSecret: 'bundled-secret' };

async function withEnv<T>(
  patch: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

test('Google client: the .env value wins over the bundled one, which wins over none', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-oauth-'));
  // Which client a sign-in uses is visible in the authorization URL it opens.
  const clientFor = async (options: { bundled?: typeof bundled }) => {
    let opened = '';
    const google = await createGoogle({
      dataDir,
      ...options,
      encrypt: v => Buffer.from(v),
      decrypt: b => b.toString(),
      oauthTimeoutMs: 50,
      openExternal: async url => {
        opened = url;
      },
    });
    try {
      if (!google.available) return { available: false, reason: google.unavailableReason };
      await google.connect({ provider: 'google' }).catch(() => {});
      return { available: true, clientId: new URL(opened).searchParams.get('client_id') };
    } finally {
      google.close();
    }
  };
  try {
    await withEnv(
      { GOOGLE_CLIENT_ID: 'env-id.apps.example.test', GOOGLE_CLIENT_SECRET: 'env-secret' },
      async () => {
        assert.deepEqual(await clientFor({ bundled }), {
          available: true,
          clientId: 'env-id.apps.example.test',
        });
      },
    );
    await withEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: undefined }, async () => {
      assert.deepEqual(await clientFor({ bundled }), {
        available: true,
        clientId: bundled.clientId,
      });
      const none = await clientFor({ bundled: { clientId: '', clientSecret: '' } });
      assert.equal(none.available, false);
      assert.match(none.reason ?? '', /^Google sign-in isn’t available in this build\./);
      assert.match(
        none.reason ?? '',
        /GOOGLE_CLIENT_ID/,
        'a development build keeps the developer hint',
      );
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('release builds inline the OAuth clients from the build environment, and nothing in the repository carries them', async () => {
  const placeholder = `placeholder-${process.pid}-${Date.now()}`;
  const env = {
    GOOGLE_CLIENT_ID: `${placeholder}-id`,
    GOOGLE_CLIENT_SECRET: `${placeholder}-secret`,
    MICROSOFT_CLIENT_ID: '',
  };
  assert.equal(
    oauthDefines(env).__APLOS_GOOGLE_CLIENT_ID__,
    '""',
    'only a release build reads the build environment',
  );
  const dir = await mkdtemp(join(tmpdir(), 'aplos-oauth-build-'));
  try {
    const outfile = join(dir, 'oauth.cjs');
    await build({
      entryPoints: ['src/main/oauth-config.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      define: oauthDefines({ ...env, APLOS_RELEASE_BUILD: '1' }),
    });
    const out = await readFile(outfile, 'utf8');
    assert.ok(out.includes(env.GOOGLE_CLIENT_ID) && out.includes(env.GOOGLE_CLIENT_SECRET));
    const { bundledOAuth, releaseBuild } = createRequire(import.meta.url)(
      outfile,
    ) as typeof import('../src/main/oauth-config');
    assert.equal(releaseBuild, true);
    assert.deepEqual(bundledOAuth, {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      microsoft: { clientId: '' },
    });
    // Tracked and untracked-but-not-ignored files (dist/ and release/ are ignored), package.json included.
    // This file holds only the prefix, never the generated value. git grep exits 1 when nothing matches.
    const grep = spawnSync('git', ['grep', '--untracked', '-l', '-F', placeholder], {
      cwd: resolve('..', '..'),
      encoding: 'utf8',
    });
    assert.equal(grep.status, 1, `placeholder found in: ${grep.stdout}${grep.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a CI release without a Google client fails unless explicitly allowed', () => {
  assert.throws(
    () => checkReleaseOAuth({ CI: 'true', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }),
    /APLOS_ALLOW_NO_GOOGLE/,
  );
  assert.throws(
    () => checkReleaseOAuth({ CI: 'true', GOOGLE_CLIENT_ID: 'x' }),
    /GOOGLE_CLIENT_SECRET/,
  );
  assert.equal(
    checkReleaseOAuth({ CI: 'true', GOOGLE_CLIENT_ID: '', APLOS_ALLOW_NO_GOOGLE: '1' }).length,
    1,
  );
  assert.equal(
    checkReleaseOAuth({ GOOGLE_CLIENT_ID: '' }).length,
    1,
    'a local release build only warns',
  );
  assert.deepEqual(
    checkReleaseOAuth({ CI: 'true', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }),
    [],
  );
});

test('a release build ignores every OAuth override in the environment; development keeps them', () => {
  const env = {
    APLOS_GOOGLE_CLIENT_ID: 'env-id.apps.example.test',
    APLOS_GOOGLE_CLIENT_SECRET: 'env-secret',
    GOOGLE_CLIENT_ID: 'old-env-id.apps.example.test',
    APLOS_GOOGLE_TESTING_MODE: '0',
    MICROSOFT_CLIENT_ID: 'ms-env-id',
    MICROSOFT_TENANT: 'env-tenant',
  };
  const inRelease = resolveGoogleClient({ env: oauthEnv(env, true), bundled });
  assert.equal(inRelease.source, 'bundled');
  assert.equal(inRelease.clientId, bundled.clientId);
  assert.equal(
    inRelease.testingMode,
    true,
    'the Testing-mode flag is not an env switch in release',
  );
  assert.deepEqual(oauthEnv(env, true), {});
  const inDev = resolveGoogleClient({ env: oauthEnv(env, false), bundled });
  assert.equal(inDev.source, 'env');
  assert.equal(inDev.clientId, env.APLOS_GOOGLE_CLIENT_ID);
  assert.equal(inDev.testingMode, false);
});

test('in a built release bundle the environment cannot change the Google client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-oauth-env-'));
  try {
    const outfile = join(dir, 'oauth.cjs');
    await build({
      entryPoints: ['src/main/oauth-config.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      define: oauthDefines({
        APLOS_RELEASE_BUILD: '1',
        GOOGLE_CLIENT_ID: 'built-in-id',
        GOOGLE_CLIENT_SECRET: 'built-in-secret',
      }),
    });
    const mod = createRequire(import.meta.url)(
      outfile,
    ) as typeof import('../src/main/oauth-config');
    const env = { APLOS_GOOGLE_CLIENT_ID: 'from-dotenv', GOOGLE_CLIENT_ID: 'from-dotenv' };
    assert.equal(mod.releaseBuild, true);
    assert.deepEqual(mod.oauthEnv(env), {}, 'the default follows the build define');
    assert.equal(
      resolveGoogleClient({ env: mod.oauthEnv(env), bundled: mod.bundledOAuth.google }).clientId,
      'built-in-id',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
