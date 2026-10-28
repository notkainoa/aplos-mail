// Build-time OAuth client constants for the main and engine bundles (see src/main/oauth-config.ts).
// Only a release build (APLOS_RELEASE_BUILD=1) reads GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and MICROSOFT_CLIENT_ID
// from the build environment; every other build inlines empty strings and keeps reading .env at runtime.
// Values are inlined into dist/main/*.cjs only. Never print them.

/** GitHub Actions passes missing secrets as empty strings; treat those as absent. */
const value = (env, name) => env[name]?.trim() || '';

/** Throws when a CI release would ship without Google sign-in, unless APLOS_ALLOW_NO_GOOGLE=1. Returns warnings otherwise. */
export function checkReleaseOAuth(env) {
  const id = value(env, 'GOOGLE_CLIENT_ID'),
    secret = value(env, 'GOOGLE_CLIENT_SECRET');
  if (id && secret) return [];
  const problem = id
    ? 'GOOGLE_CLIENT_SECRET is not set but GOOGLE_CLIENT_ID is'
    : 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set';
  if (env.APLOS_ALLOW_NO_GOOGLE === '1')
    return [`${problem}; building without Google sign-in because APLOS_ALLOW_NO_GOOGLE=1.`];
  if (env.CI)
    throw new Error(
      `${problem}, so this release could not sign in to Google. Add the repository secrets, or set APLOS_ALLOW_NO_GOOGLE=1 for an intentionally unconfigured build.`,
    );
  return [
    `${problem}; this local release build will show "Google sign-in isn't available". Set them in your shell, or APLOS_ALLOW_NO_GOOGLE=1 to silence this.`,
  ];
}

/** esbuild `define` entries. */
export function oauthDefines(env) {
  const release = env.APLOS_RELEASE_BUILD === '1';
  const pick = name => JSON.stringify(release ? value(env, name) : '');
  return {
    __APLOS_RELEASE_BUILD__: JSON.stringify(release),
    __APLOS_GOOGLE_CLIENT_ID__: pick('GOOGLE_CLIENT_ID'),
    __APLOS_GOOGLE_CLIENT_SECRET__: pick('GOOGLE_CLIENT_SECRET'),
    __APLOS_MICROSOFT_CLIENT_ID__: pick('MICROSOFT_CLIENT_ID'),
  };
}
