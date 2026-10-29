// Errors the Google sign-in flow throws. Each is a `ProviderError` with a stable `reason` and a sentence the UI may
// show. No authorization code, PKCE verifier, token or client secret is ever part of one: messages are fixed
// sentences, provider text is scrubbed, and no `cause` is attached.

import type { ClassifiedError, ErrorClass } from '@aplos/contract';
import { ProviderError } from '@aplos/engine/ports';
import { noGoogleClientMessage } from './client';

export type ConnectMethod = 'oauth.authorize' | 'oauth.token';

const classMessages = new Map<string, string>([
  ['auth', 'Google did not accept this sign-in. Try connecting again.'],
  ['config', 'Google refused this build’s sign-in setup. Check the Google client id and secret.'],
  ['permanent', 'Google sign-in could not finish. Try connecting again.'],
  ['transient', 'Google sign-in could not finish just now. Try again in a moment.'],
  ['cancelled', 'Google sign-in was cancelled.'],
]);

const reasonMessages = new Map<string, string>([
  ['noClient', noGoogleClientMessage],
  ['timedOut', 'Google sign-in timed out. Try connecting again.'],
  ['loopbackFailed', 'Aplos could not open its local sign-in callback. Try connecting again.'],
  ['browserFailed', 'Aplos could not open your browser for Google sign-in.'],
  [
    'noRefreshToken',
    'Google did not grant lasting access to this account. Try connecting again and allow access on Google’s screen.',
  ],
  ['invalidIdToken', 'Google’s answer did not identify the account. Try connecting again.'],
  [
    'admin_policy_enforced',
    'An administrator has blocked Aplos for this Google account. Ask them to allow it.',
  ],
  [
    'vaultWriteFailed',
    'Aplos could not save the Google sign-in securely. Check the data directory and your keychain.',
  ],
  [
    'vaultDeleteFailed',
    'Aplos could not remove a saved Google sign-in. Check the data directory and your keychain.',
  ],
  [
    'vaultReadFailed',
    'Aplos could not read its saved Google sign-ins. Check the data directory and your keychain.',
  ],
  ['notThisHostsCredential', 'Aplos will only remove a Google sign-in it has just saved.'],
  ['badConsentUrl', 'Aplos would not open a sign-in page that is not Google’s.'],
]);

const fallbackMessage = 'Google sign-in could not finish.';

/** A `ProviderError` whose `message` is a sentence the UI may show; `error.reason` stays the stable code. */
export class ConnectError extends ProviderError {
  constructor(error: ClassifiedError, scope: 'account' | 'project', message: string) {
    super(error, scope);
    this.message = message;
  }
}

export interface ConnectErrorInit {
  method?: ConnectMethod;
  extra?: Partial<ClassifiedError>;
  scope?: 'account' | 'project';
  message?: string;
}

export function connectError(
  cls: ErrorClass,
  reason: string,
  init: ConnectErrorInit = {},
): ConnectError {
  const method = init.method ?? 'oauth.authorize';
  const error: ClassifiedError = { class: cls, provider: 'oauth', method, reason, ...init.extra };
  const message =
    init.message ?? reasonMessages.get(reason) ?? classMessages.get(cls) ?? fallbackMessage;
  return new ConnectError(error, init.scope ?? 'account', message);
}

/** The same facts under the sign-in sentence: the token module's sentences speak of renewing, not connecting. */
export function asConnectError(error: ProviderError): ConnectError {
  const { class: cls, reason, ...extra } = error.error;
  // The wire enum is open; the token module only ever sets classes it knows.
  return connectError(cls as ErrorClass, reason, {
    method: 'oauth.token',
    extra,
    scope: error.scope,
  });
}

export function abortedError(): ConnectError {
  return connectError('cancelled', 'aborted', { extra: { uncertain: false } });
}

/** Google's redirect `error` is untrusted query text: only a plain OAuth code survives. */
export function redirectError(code: string): ConnectError {
  const reason = /^[a-z_]{1,64}$/.test(code) ? code : 'unknown';
  const cls: ErrorClass = reason === 'access_denied' ? 'cancelled' : 'auth';
  return connectError(cls, reason);
}
