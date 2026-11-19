// Which Google OAuth client this build signs in with (plan 20 PV5). Official builds embed their own client; a source
// build or fork brings its own through the environment or Settings. Desktop client secrets are not confidential, but
// they are never printed or logged.

export interface OAuthClient {
  clientId?: string;
  clientSecret?: string;
}

export type ClientSource = 'env' | 'settings' | 'bundled' | 'none';

export interface ResolvedGoogleClient extends OAuthClient {
  source: ClientSource;
  /** A Google project in Testing mode expires refresh tokens after 7 days, which turns on `reconnectBy`. */
  testingMode: boolean;
}

export interface GoogleClientInputs {
  env: Readonly<Record<string, string | undefined>>;
  /** The id and secret the owner typed into Settings, if any. */
  settings?: OAuthClient;
  /** The client inlined at release build time. */
  bundled: OAuthClient;
}

const trimmed = (value: string | undefined) => value?.trim() || undefined;

/** A client id wins together with its own secret; a secret is never taken from a different source than its id. */
function pick(id: string | undefined, secret: string | undefined, source: ClientSource) {
  const clientId = trimmed(id);
  if (!clientId) return undefined;
  return { clientId, clientSecret: trimmed(secret), source };
}

function testingModeFrom(env: GoogleClientInputs['env']): boolean {
  const flag = trimmed(env.APLOS_GOOGLE_TESTING_MODE)?.toLowerCase();
  return flag !== '0' && flag !== 'false' && flag !== 'no';
}

/** Order: environment (`APLOS_GOOGLE_*`, then the older `GOOGLE_*`), Settings, the bundled client. */
export function resolveGoogleClient(inputs: GoogleClientInputs): ResolvedGoogleClient {
  const { env, settings, bundled } = inputs;
  const found =
    pick(env.APLOS_GOOGLE_CLIENT_ID, env.APLOS_GOOGLE_CLIENT_SECRET, 'env') ??
    pick(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, 'env') ??
    pick(settings?.clientId, settings?.clientSecret, 'settings') ??
    pick(bundled.clientId, bundled.clientSecret, 'bundled');
  const testingMode = testingModeFrom(env);
  return found ? { ...found, testingMode } : { source: 'none', testingMode };
}

/** The sentence shown when sign-in has no client. */
export const noGoogleClientMessage =
  'Google sign-in isn’t available in this build. Set APLOS_GOOGLE_CLIENT_ID and APLOS_GOOGLE_CLIENT_SECRET (a Desktop client from your own Google project), then restart.';
