// Errors the token source throws. Each is a `ProviderError` with a stable `reason` code and a `message` the UI may
// show. Nothing the token endpoint sends back is trusted to be free of secrets: echoed refresh tokens and client
// secrets are scrubbed before any text is kept.

import type { ClassifiedError, ErrorClass } from '@aplos/contract';
import { ProviderError } from '@aplos/engine/ports';
import { HttpFailure, type HttpResponse } from '../shared/http';
import { MAX_MESSAGE_LENGTH, parseGoogleError } from '../shared/google-error';
import { noGoogleClientMessage } from './client';

const method = 'oauth.token';

const classMessages = new Map<string, string>([
  ['auth', 'Google needs you to sign in to this account again. Choose Reconnect to keep syncing.'],
  ['config', 'Google refused this build’s sign-in setup. Check the Google client id and secret.'],
  ['permanent', 'Google refused to renew this account’s sign-in.'],
  ['transient', 'Google sign-in could not be renewed just now. Aplos will try again.'],
  ['cancelled', 'Google sign-in renewal was cancelled.'],
]);

const reasonMessages = new Map<string, string>([
  [
    'clientMismatch',
    'This account was connected with a different Google sign-in setup. Reconnect it to keep syncing.',
  ],
  ['noClient', noGoogleClientMessage],
  [
    'vaultWriteFailed',
    'Aplos could not save the renewed Google sign-in securely. Check the data directory and your keychain.',
  ],
  [
    'vaultReadFailed',
    'Aplos could not read the saved Google sign-in. Check the data directory and your keychain.',
  ],
]);

const fallbackMessage = 'Google sign-in could not be renewed.';

/** A `ProviderError` whose `message` is a sentence the UI may show; `error.reason` stays the stable code. */
export class TokenRefreshError extends ProviderError {
  constructor(error: ClassifiedError, scope: 'account' | 'project', message: string) {
    super(error, scope);
    this.message = message;
  }
}

export interface TokenErrorInit {
  extra?: Partial<ClassifiedError>;
  scope?: 'account' | 'project';
  /** Overrides the sentence picked from the reason and class. */
  message?: string;
}

export function tokenError(
  cls: ErrorClass,
  reason: string,
  init: TokenErrorInit = {},
): TokenRefreshError {
  const error: ClassifiedError = { class: cls, provider: 'oauth', method, reason, ...init.extra };
  const message =
    init.message ?? reasonMessages.get(reason) ?? classMessages.get(cls) ?? fallbackMessage;
  return new TokenRefreshError(error, init.scope ?? 'account', message);
}

export function cancelledError(): TokenRefreshError {
  return tokenError('cancelled', 'aborted', { extra: { uncertain: false } });
}

/** A grant replaced (reconnect, disconnect) while a refresh was out: its answer is not used. */
export function grantChangedError(): TokenRefreshError {
  return tokenError('transient', 'grantChanged', { extra: { uncertain: false } });
}

/** Refusals that only a new sign-in fixes (plan 20 section 3.3). */
const authReasons = new Set([
  'invalid_grant',
  'admin_policy_enforced',
  'interaction_required',
  'consent_required',
  'access_denied',
]);
/** Refusals of the client itself, which hit every account on the project. */
const configReasons = new Set([
  'invalid_client',
  'unauthorized_client',
  'invalid_request',
  'invalid_scope',
  'unsupported_grant_type',
]);

function refusalClass(status: number, reason: string): ErrorClass {
  if (authReasons.has(reason)) return 'auth';
  if (status === 408 || status === 429 || status >= 500) return 'transient';
  if (configReasons.has(reason)) return 'config';
  return 'permanent';
}

/** A cut tail shorter than this is not treated as the start of a secret. */
const minSecretTail = 4;

/**
 * Every form a secret can take when a server or a proxy echoes the request back: as is, JSON-escaped (`\/`), and
 * percent-encoded as the form body sent it (`URLSearchParams`) or as `encodeURIComponent` writes it.
 */
function secretForms(secrets: readonly string[]): string[] {
  const forms = secrets
    .filter(Boolean)
    .flatMap(secret => [
      secret,
      secret.replaceAll('/', '\\/'),
      encodeURIComponent(secret),
      new URLSearchParams({ s: secret }).toString().slice(2),
    ]);
  return [...new Set(forms)].sort((a, b) => b.length - a.length);
}

function replaceAll(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const form of secretForms(secrets)) clean = clean.split(form).join('[redacted]');
  return clean;
}

/** A field already cut at 300 characters may end in the start of a secret; that tail goes too. */
function dropSecretTail(text: string, secrets: readonly string[]): string {
  for (const secret of secretForms(secrets)) {
    for (let n = Math.min(secret.length - 1, text.length); n >= minSecretTail; n--) {
      if (text.endsWith(secret.slice(0, n))) return text.slice(0, -n);
    }
  }
  return text;
}

/** Whole secrets first, then a cut-off start of one, then the length cap. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  return dropSecretTail(replaceAll(text, secrets), secrets).slice(0, MAX_MESSAGE_LENGTH);
}

/** True for the token endpoint's own error shape, `{"error": "<code>", "error_description"?: "..."}`. */
function isOAuthErrorBody(text: string): boolean {
  try {
    const body: unknown = JSON.parse(text);
    return (
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
    );
  } catch {
    return false;
  }
}

/** Said instead of a body that is not an OAuth error (an HTML page from a proxy can quote the request). */
function fixedProviderMessage(status: number): string {
  return `The token endpoint answered ${Math.floor(status / 100)}xx without an OAuth error.`;
}

/**
 * `providerMessage` comes only from a parsed OAuth `error_description` (or `error`), scrubbed; any other body is
 * replaced by a fixed sentence and never kept.
 */
function providerMessage(raw: string, status: number, secrets: readonly string[]): string {
  if (!isOAuthErrorBody(raw)) return fixedProviderMessage(status);
  const info = parseGoogleError(status, raw);
  return scrubSecrets(info.oauthDescription ?? info.reason, secrets);
}

export function refusalError(
  response: HttpResponse,
  secrets: readonly string[],
): TokenRefreshError {
  // Scrub the raw body before the parser truncates it, then the parsed fields again.
  const raw = replaceAll(response.text(), secrets);
  const info = parseGoogleError(response.status, raw);
  const cls = refusalClass(response.status, info.reason);
  const extra: Partial<ClassifiedError> = {
    status: response.status,
    ...(response.retryAfterMs !== undefined ? { retryAfterMs: response.retryAfterMs } : {}),
    providerMessage: providerMessage(raw, response.status, secrets),
  };
  const scope = cls === 'config' ? 'project' : 'account';
  return tokenError(cls, scrubSecrets(info.reason, secrets), { extra, scope });
}

/** Only the failure's kind survives: a `cause` is not ours to vouch for, so nothing else is passed on. */
export function transportError(error: unknown): TokenRefreshError {
  const extra = { uncertain: false };
  if (!(error instanceof HttpFailure)) return tokenError('transient', 'requestFailed', { extra });
  if (error.kind === 'aborted') return cancelledError();
  return tokenError('transient', error.kind, { extra });
}
