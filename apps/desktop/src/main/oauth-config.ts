// Replaced by scripts/build-main.mjs (esbuild `define`). Under tsx (npm run dev, tests) they are not defined at all.
declare const __APLOS_RELEASE_BUILD__: boolean | undefined;
declare const __APLOS_GOOGLE_CLIENT_ID__: string | undefined;
declare const __APLOS_GOOGLE_CLIENT_SECRET__: string | undefined;
declare const __APLOS_MICROSOFT_CLIENT_ID__: string | undefined;

export interface OAuthClient {
  clientId?: string;
  clientSecret?: string;
}

/** True only in builds made by `npm run release:build` / `release:publish`; development hints are hidden there. */
export const releaseBuild = typeof __APLOS_RELEASE_BUILD__ === 'boolean' && __APLOS_RELEASE_BUILD__;

/** The app's own Desktop OAuth clients, inlined at release build time. Desktop client secrets are not confidential. */
export const bundledOAuth: { google: OAuthClient; microsoft: OAuthClient } = {
  google: {
    clientId: typeof __APLOS_GOOGLE_CLIENT_ID__ === 'string' ? __APLOS_GOOGLE_CLIENT_ID__ : '',
    clientSecret:
      typeof __APLOS_GOOGLE_CLIENT_SECRET__ === 'string' ? __APLOS_GOOGLE_CLIENT_SECRET__ : '',
  },
  microsoft: {
    clientId:
      typeof __APLOS_MICROSOFT_CLIENT_ID__ === 'string' ? __APLOS_MICROSOFT_CLIENT_ID__ : '',
  },
};

/**
 * The environment OAuth configuration may read. A release build gets an empty one: a `.env` (or a variable inherited
 * from a launcher) can't swap the client it signs in with, or flip the Testing-mode warning. Development keeps both.
 */
export function oauthEnv(
  env: Readonly<Record<string, string | undefined>>,
  release: boolean = releaseBuild,
): Readonly<Record<string, string | undefined>> {
  return release ? {} : env;
}

/** An ID set in the environment (.env) wins over the bundled client, together with its own secret; then the bundled one; else none. */
export function oauthClient(
  envId: string | undefined,
  envSecret: string | undefined,
  bundled: OAuthClient,
): OAuthClient {
  if (envId?.trim())
    return { clientId: envId.trim(), clientSecret: envSecret?.trim() || undefined };
  if (bundled.clientId)
    return { clientId: bundled.clientId, clientSecret: bundled.clientSecret || undefined };
  return {};
}
