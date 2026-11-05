import type { Consent, Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { auditWrites } from '../host/audit';
import { CONSENT_KEY_META, consentKey, type ConsentRow } from '../ai/consent';
import { parseStored, withDefaults } from '../runtime/settings';
import type { AreaHandlers, MethodContext } from './types';

/**
 * The `consent` area, owned by lane `eng-ai`. The record lives in `consent`; the fingerprint it was granted against
 * (`consentKey` of the settings' background features) in `meta.consent_key`, written in the same commit.
 * `needsReconsent` is computed on read: the fingerprint drifting means the current text is one version newer.
 */

const keyOf = (ctx: MethodContext) =>
  ctx.services.store.read(q => {
    const doc = parseStored(
      q.get<{ data: string }>('SELECT data FROM settings WHERE id = 1')?.data,
    );
    const stored = q.get<{ value: string }>(
      'SELECT value FROM meta WHERE key = ?',
      CONSENT_KEY_META,
    )?.value;
    return { current: consentKey(withDefaults(doc).ai), stored };
  });

function readConsent(ctx: MethodContext): Consent {
  const row = ctx.services.store.read(q =>
    q.get<ConsentRow>(
      'SELECT scope, version, provider, model, granted_at FROM consent WHERE scope = ?',
      'background',
    ),
  );
  const { current, stored } = keyOf(ctx);
  if (!row)
    return {
      scope: 'background',
      granted: false,
      version: 0,
      currentVersion: 1,
      needsReconsent: false,
    };
  const drift = stored !== undefined && stored !== current;
  const out: Consent = {
    scope: 'background',
    granted: true,
    version: row.version,
    currentVersion: row.version + (drift ? 1 : 0),
    needsReconsent: drift,
    ...(row.provider ? { provider: row.provider as Consent['provider'] } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.granted_at !== null ? { grantedAt: row.granted_at } : {}),
  };
  return out;
}

function grant(args: Input<'Consent/grant'>, ctx: MethodContext): Output<'Consent/grant'> {
  const now = readConsent(ctx);
  if (args.version !== now.currentVersion)
    throw new ContractError({
      type: 'stateMismatch',
      message: 'The consent text changed. Read it again before agreeing.',
    });
  const { current } = keyOf(ctx);
  ctx.services.store.commit({
    opId: `consent-grant-${args.scope}`,
    origin: 'local',
    writes: [
      {
        kind: 'consent',
        scope: args.scope,
        version: now.currentVersion,
        provider: args.provider,
        model: args.model,
        grantedAt: ctx.services.clock.now(),
      },
      { kind: 'meta', key: CONSENT_KEY_META, value: current },
      ...auditWrites(ctx.caller, 'Consent/grant', args.scope),
    ],
  });
  return readConsent(ctx);
}

function revoke(args: Input<'Consent/revoke'>, ctx: MethodContext): Output<'Consent/revoke'> {
  ctx.services.store.commit({
    opId: `consent-revoke-${args.scope}`,
    origin: 'local',
    writes: [
      { kind: 'consent', scope: args.scope, remove: true },
      { kind: 'meta', key: CONSENT_KEY_META, value: null },
      ...auditWrites(ctx.caller, 'Consent/revoke', args.scope),
    ],
  });
  return readConsent(ctx);
}

export const handlers: AreaHandlers<'consent'> = {
  'Consent/get': (_args, ctx) => readConsent(ctx),
  'Consent/grant': grant,
  'Consent/revoke': revoke,
};
