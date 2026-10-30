import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explicitPort, isIsolated, scorerEnv, VITE_NAMES } from './env';

const SECRETS = {
  GROQ_API_KEY: 'g',
  OPENAI_API_KEY: 'o',
  ANTHROPIC_API_KEY: 'a',
  GEMINI_API_KEY: 'm',
  OPENROUTER_API_KEY: 'r',
  OPENCODE_API_KEY: 'c',
  CUSTOM_AI_API_KEY: 'u',
  GITHUB_TOKEN: 't',
  NODE_AUTH_TOKEN: 'n',
  AWS_SECRET_ACCESS_KEY: 's',
  CLIENT_SECRET: 'x',
  CLAUDE_CODE_OAUTH_TOKEN: 'k',
  SSH_AUTH_SOCK: '/tmp/agent',
  DATABASE_URL: 'postgres://u:p@h/d',
  NODE_OPTIONS: '--require ./evil.js',
};

test('every allow-listed variable passes when present and none appears when absent', () => {
  const names = [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TERM',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TASTE_MODEL',
  ];
  const source = Object.fromEntries(names.map(name => [name, `v-${name}`]));
  assert.deepEqual(scorerEnv(source), source);
  assert.deepEqual(scorerEnv({}), {});
  assert.deepEqual(scorerEnv({ PATH: undefined }), {});
});

test('no secret and no unlisted variable gets through', () => {
  const env = scorerEnv({ ...SECRETS, PATH: '/bin', HOME: '/h' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('names are matched exactly and case-sensitively', () => {
  const env = scorerEnv({ path: '/x', Home: '/y', PATH2: '/z', MYPATH: '/w', PATH: '/ok' });
  assert.deepEqual(env, { PATH: '/ok' });
});

test('only CLAUDE_CONFIG_DIR of the CLAUDE_ variables passes, and the name is exact and case-sensitive', () => {
  const env = scorerEnv({
    CLAUDE_CONFIG_DIR: '/c',
    CLAUDE_BIN: '/bin/claude',
    CLAUDE_CODE_OAUTH_TOKEN: 'k',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: 'id',
    CLAUDE_CODE_MESSAGING_TOKEN: 'k',
    CLAUDE_API_KEY: 'k',
    CLAUDE_WEBHOOK_SECRET: 'k',
    CLAUDECODE: '1',
    CLAUDE_CONFIG_DIR2: '/x',
    claude_config_dir: '/lower',
    MY_CLAUDE_CONFIG_DIR: '1',
  });
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: '/c' });
});

test('the secret suffix rule ignores case and also applies to extra names', () => {
  const env = scorerEnv(
    { Foo_Api_Key: '1', BAR_token: '2', BAZ_Secret: '3', EXTRA_OK: '4', EXTRA_API_KEY: '5' },
    { names: ['Foo_Api_Key', 'BAR_token', 'BAZ_Secret', 'EXTRA_OK', 'EXTRA_API_KEY'] },
  );
  assert.deepEqual(env, { EXTRA_OK: '4' });
});

test('vite names add NODE_ENV but never NODE_OPTIONS, and set values win', () => {
  const env = scorerEnv(
    { ...SECRETS, NODE_ENV: 'test', npm_config_cache: '/c', PATH: '/bin', APLOS_VISUAL_PORT: '1' },
    { names: VITE_NAMES, set: { APLOS_VISUAL_PORT: '4999' } },
  );
  assert.deepEqual(env, {
    NODE_ENV: 'test',
    npm_config_cache: '/c',
    PATH: '/bin',
    APLOS_VISUAL_PORT: '4999',
  });
});

test('the source object is not modified', () => {
  const source = { ...SECRETS, PATH: '/bin' };
  const copy = { ...source };
  scorerEnv(source);
  assert.deepEqual(source, copy);
});

test('an explicit APLOS_VISUAL_PORT is used unless the run is isolated, unset or invalid', () => {
  assert.equal(explicitPort({ APLOS_VISUAL_PORT: '4999' }), 4999);
  assert.equal(explicitPort({}), 0);
  for (const bad of ['', 'abc', '0', '-5', '70000', '4999.5'])
    assert.equal(explicitPort({ APLOS_VISUAL_PORT: bad }), 0, bad);
});

test('SCORER_ISOLATED=1 (or true, yes) makes the scorer ignore APLOS_VISUAL_PORT', () => {
  for (const on of ['1', 'true', 'TRUE', 'yes', ' 1 ']) {
    assert.equal(isIsolated({ SCORER_ISOLATED: on }), true, on);
    assert.equal(explicitPort({ SCORER_ISOLATED: on, APLOS_VISUAL_PORT: '4999' }), 0, on);
  }
  for (const off of [undefined, '', '0', 'false', 'no'])
    assert.equal(isIsolated({ SCORER_ISOLATED: off }), false, String(off));
  assert.equal(explicitPort({ SCORER_ISOLATED: '0', APLOS_VISUAL_PORT: '4999' }), 4999);
});

test('claude: false leaves CLAUDE_ variables out for Vite and Chromium', () => {
  const source = { CLAUDE_CONFIG_DIR: '/c', PATH: '/bin' };
  assert.deepEqual(scorerEnv(source, { claude: false }), { PATH: '/bin' });
  assert.deepEqual(scorerEnv(source), source);
});
