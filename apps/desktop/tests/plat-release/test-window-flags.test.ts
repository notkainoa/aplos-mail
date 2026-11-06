import test from 'node:test';
import assert from 'node:assert/strict';
import { testFlags } from '../../src/main/test-mode';

// The APLOS_TEST_SHOW_WINDOWS / APLOS_TEST_CDP_PORT / APLOS_TEST_KEYCHAIN flags exist so a
// headless packaged run can be driven over loopback CDP and screenshot. Every one of them is
// inert without APLOS_TEST=1 — a normal launch must be byte-for-byte unchanged.

test('testFlags: nothing is reachable outside APLOS_TEST=1', () => {
  const env = {
    APLOS_TEST_SHOW_WINDOWS: '1',
    APLOS_TEST_CDP_PORT: '9260',
    APLOS_TEST_KEYCHAIN: 'login',
  } as NodeJS.ProcessEnv;
  const flags = testFlags(env, false);
  assert.equal(flags.showWindows, false);
  assert.equal(flags.cdpPort, undefined);
  assert.equal(flags.useLoginKeychain, false);
});

test('testFlags: test mode alone enables none of the flags', () => {
  const flags = testFlags({} as NodeJS.ProcessEnv, true);
  assert.equal(flags.showWindows, false);
  assert.equal(flags.cdpPort, undefined);
  assert.equal(flags.useLoginKeychain, false);
});

test('testFlags: APLOS_TEST_SHOW_WINDOWS=1 shows windows only in test mode', () => {
  assert.equal(
    testFlags({ APLOS_TEST_SHOW_WINDOWS: '1' } as NodeJS.ProcessEnv, true).showWindows,
    true,
  );
  assert.equal(
    testFlags({ APLOS_TEST_SHOW_WINDOWS: '0' } as NodeJS.ProcessEnv, true).showWindows,
    false,
  );
});

test('testFlags: APLOS_TEST_CDP_PORT parses a port and 0 for random', () => {
  assert.equal(testFlags({ APLOS_TEST_CDP_PORT: '9260' } as NodeJS.ProcessEnv, true).cdpPort, 9260);
  assert.equal(testFlags({ APLOS_TEST_CDP_PORT: '0' } as NodeJS.ProcessEnv, true).cdpPort, 0);
});

test('testFlags: an invalid APLOS_TEST_CDP_PORT disables the whole flag set', () => {
  for (const raw of ['65535', '65536', '-1', 'abc', '1.5', '', '  ', '0x1234', '1e3']) {
    const flags = testFlags(
      { APLOS_TEST_CDP_PORT: raw, APLOS_TEST_SHOW_WINDOWS: '1' } as NodeJS.ProcessEnv,
      true,
    );
    assert.equal(flags.cdpPort, undefined);
    assert.equal(flags.showWindows, false);
  }
});

test('testFlags: APLOS_TEST_KEYCHAIN only accepts the literal login', () => {
  assert.equal(
    testFlags({ APLOS_TEST_KEYCHAIN: 'login' } as NodeJS.ProcessEnv, true).useLoginKeychain,
    true,
  );
  assert.equal(
    testFlags({ APLOS_TEST_KEYCHAIN: '1' } as NodeJS.ProcessEnv, true).useLoginKeychain,
    false,
  );
});
