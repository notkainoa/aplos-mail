import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  googleScopeManifest,
  googleScopeParam,
  grantedFeatures,
  missingRequiredScopes,
  missingScopes,
  parseGrantedScopes,
} from '../../src/host/providers/oauth/scopes';
import { resolveGoogleClient } from '../../src/host/providers/oauth/client';
import {
  checkReconnectIdentity,
  checkRequiredScopes,
  grantFromTokenResponse,
  reconnectAuthParams,
  testingRefreshLifetimeMs,
  reconnectMarginMs,
} from '../../src/host/providers/oauth/grant';

const src = fileURLToPath(new URL('../../src', import.meta.url));
const mail = googleScopeManifest[0].scope;
const day = 24 * 60 * 60 * 1000;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs)$/.test(name) ? [path] : [];
  });
}

test('every Google scope requested in the source tree is in the manifest', () => {
  const known = new Set(googleScopeManifest.map(entry => entry.scope));
  const found = new Set<string>();
  for (const file of sourceFiles(src)) {
    if (file.includes('src/host/providers/oauth/')) continue;
    // Tests name scopes to prove what the UI recognises; only shipped code can request one.
    if (/\.test\.tsx?$/.test(file)) continue;
    for (const hit of readFileSync(file, 'utf8').matchAll(
      /https:\/\/www\.googleapis\.com\/auth\/[\w.]+/g,
    ))
      found.add(hit[0]);
  }
  assert.ok(found.size > 0, 'the scan should find the legacy request');
  // Google's umbrella calendar scope is never requested by Aplos; the calendar screen only recognises it when an older
  // grant already holds it (accountCalendarState.ts `editingOn`), so it may appear in the renderer and nowhere else.
  const recognisedOnly = new Set(['https://www.googleapis.com/auth/calendar']);
  for (const scope of found)
    assert.ok(
      known.has(scope) || recognisedOnly.has(scope),
      `${scope} is requested but not in the manifest`,
    );
});

test('the authorization scope parameter is the manifest, and the legacy request matches it', () => {
  const legacy = readFileSync(join(src, 'main/google.ts'), 'utf8');
  const writeCovers = 'https://www.googleapis.com/auth/calendar.events';
  const readOnly = `${writeCovers}.readonly`;
  const parts = googleScopeParam().split(' ');
  for (const part of parts)
    // The legacy sign-in writes events, so it correctly asks the broader calendar.events — which a
    // held grant of already covers the read-only scope Aplos asks for now.
    assert.ok(
      legacy.includes(part) || (part === readOnly && legacy.includes(writeCovers)),
      `${part} missing from google.ts`,
    );
  // The deferred write entry is declared but never requested: not a token of the param, and not
  // counted in the manifest length the param carries.
  assert.ok(
    !parts.includes(writeCovers),
    'the deferred calendar.events write scope must not be requested',
  );
  assert.equal(parts.length, 3 + googleScopeManifest.filter(e => !e.deferred).length);
});

test('every manifest row has consent text and exactly one required scope', () => {
  for (const entry of googleScopeManifest) assert.ok(entry.consent.length > 20);
  assert.deepEqual(
    googleScopeManifest.filter(e => e.required).map(e => e.feature),
    ['mail'],
  );
});

test('granted scopes switch features on and list what is missing', () => {
  const granted = parseGrantedScopes(`openid ${mail}  ${mail}`);
  assert.deepEqual(granted, ['openid', mail]);
  assert.deepEqual([...grantedFeatures(granted)], ['mail']);
  assert.equal(missingScopes(granted).length, googleScopeManifest.length - 1);
  assert.deepEqual(parseGrantedScopes(undefined), []);
});

test('a grant without the mail scope is refused in a plain sentence', () => {
  assert.equal(missingRequiredScopes(['openid']).length, 1);
  const check = checkRequiredScopes(['openid']);
  assert.ok(!check.ok && check.reason === 'missingRequiredScope' && /Gmail/.test(check.message));
  assert.deepEqual(checkRequiredScopes([mail]), { ok: true });
});

test('client resolution: environment, then Settings, then bundled; a secret stays with its id', () => {
  const bundled = { clientId: 'bundled-id', clientSecret: 'bundled-secret' };
  const settings = { clientId: 'settings-id', clientSecret: 'settings-secret' };
  const env = { APLOS_GOOGLE_CLIENT_ID: ' env-id ', APLOS_GOOGLE_CLIENT_SECRET: 'env-secret' };
  assert.deepEqual(resolveGoogleClient({ env, settings, bundled }), {
    clientId: 'env-id',
    clientSecret: 'env-secret',
    source: 'env',
    testingMode: true,
  });
  assert.equal(resolveGoogleClient({ env: { GOOGLE_CLIENT_ID: 'old' }, bundled }).clientId, 'old');
  assert.equal(resolveGoogleClient({ env: {}, settings, bundled }).source, 'settings');
  const onlyBundled = resolveGoogleClient({
    env: { APLOS_GOOGLE_CLIENT_SECRET: 'stray' },
    bundled,
  });
  assert.deepEqual([onlyBundled.source, onlyBundled.clientSecret], ['bundled', 'bundled-secret']);
  assert.equal(resolveGoogleClient({ env: {}, bundled: {} }).source, 'none');
});

test('Testing mode is the default and can be switched off for a published project', () => {
  assert.equal(resolveGoogleClient({ env: {}, bundled: {} }).testingMode, true);
  const env = { APLOS_GOOGLE_TESTING_MODE: 'false' };
  assert.equal(resolveGoogleClient({ env, bundled: {} }).testingMode, false);
});

test('reconnectBy is the earlier of grant + 7 days and the lifetime Google reports, less a margin', () => {
  const now = 1_000_000;
  const at = (testingMode: boolean, refresh_token_expires_in?: unknown) =>
    grantFromTokenResponse({ now, testingMode, response: { refresh_token_expires_in } })
      .refreshExpiresAt;
  assert.equal(at(true), now + testingRefreshLifetimeMs - reconnectMarginMs);
  assert.equal(at(true, 3600), now + 1800_000);
  assert.equal(at(true, '99999999'), now + 7 * day - reconnectMarginMs);
  assert.equal(at(false, 86400), now + day / 2);
  assert.equal(at(false), undefined);
  assert.equal(at(false, 'soon'), undefined);
  assert.equal(at(false, -5), undefined);
});

test('a grant records the client and the scopes the response carried', () => {
  const grant = grantFromTokenResponse({
    now: 5,
    testingMode: true,
    clientId: 'c',
    response: { scope: `openid ${mail}` },
  });
  assert.deepEqual(grant, {
    grantedAt: 5,
    refreshExpiresAt: 5 + 7 * day - reconnectMarginMs,
    client: 'c',
    scopes: ['openid', mail],
  });
});

test('a reconnect with a different account is refused; the same one passes', () => {
  assert.deepEqual(checkReconnectIdentity('sub-1', 'sub-1'), { ok: true });
  assert.deepEqual(checkReconnectIdentity(undefined, 'sub-2'), { ok: true });
  const refused = checkReconnectIdentity('sub-1', 'sub-2');
  assert.ok(!refused.ok && refused.reason === 'wrongAccount' && refused.kind === 'auth');
});

test('a reconnect preselects the account and still asks for consent so a refresh token comes back', () => {
  assert.deepEqual(reconnectAuthParams('a@example.test'), {
    access_type: 'offline',
    prompt: 'consent',
    login_hint: 'a@example.test',
  });
  assert.deepEqual(reconnectAuthParams(undefined), { access_type: 'offline', prompt: 'consent' });
});
