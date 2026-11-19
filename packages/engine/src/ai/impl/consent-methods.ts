import type { Consent, Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { auditWrites } from '../../host/audit';
import { nonce, type MethodContext } from '../../methods/types';
import { parseStored, withDefaults } from '../../runtime/settings';
import { CONSENT_KEY_META, consentKey, type ConsentRow } from '../consent';
// Registers the lazy `job` handlers (the `wake` write below dispatches through them).
import './ai-writes';

/**
 * The `consent` area's working half (lazy-loaded by `methods/consent.ts`). The record lives in `consent`; the
 * fingerprint it was granted against (`consentKey` of the settings' background features) in `meta.consent_key`,
 * written in the same commit. `needsReconsent` is computed on read: the fingerprint drifting means the current
 * text is one version newer.
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
    return { ai: withDefaults(doc).ai, current: consentKey(withDefaults(doc).ai), stored };
  });

export function readConsent(ctx: MethodContext): Consent {
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
  // Fail closed: a consent row without its fingerprint (imported or pre-upgrade store) still re-asks.
  const drift = stored !== current;
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

export function grant(args: Input<'Consent/grant'>, ctx: MethodContext): Output<'Consent/grant'> {
  const now = readConsent(ctx);
  if (args.version !== now.currentVersion)
    throw new ContractError({
      type: 'stateMismatch',
      message: 'The consent text changed. Read it again before agreeing.',
    });
  const { ai, current } = keyOf(ctx);
  // The consent text named the live background picks; a grant binds to what the card showed, not to a
  // provider/model typed in afterwards — mismatch means the consent text changed.
  const bound = ['summaries', 'plans', 'drafts'] as const;
  const matches = bound.some(
    f => ai.features[f].provider === args.provider && ai.features[f].model === args.model,
  );
  if (!matches)
    throw new ContractError({
      type: 'stateMismatch',
      message: 'The consent text changed. Read it again before agreeing.',
    });
  ctx.services.store.commit({
    opId: `consent-grant-${args.scope}-${nonce(ctx)}`,
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
      { kind: 'job', action: 'wake' },
      // A grant can open the gate for mail that dead-lettered while it waited — the catch-up re-queues it.
      ...(args.scope === 'background'
        ? [
            {
              kind: 'job' as const,
              action: 'enqueue' as const,
              job: {
                kind: 'wake',
                key: 'ai:backfill',
                priority: 5,
                payload: '{}',
                nextAt: ctx.services.clock.now(),
              },
            },
          ]
        : []),
      ...auditWrites(ctx.caller, 'Consent/grant', args.scope),
    ],
  });
  ctx.services.deadlines.changed('jobs');
  return readConsent(ctx);
}

export function revoke(
  args: Input<'Consent/revoke'>,
  ctx: MethodContext,
): Output<'Consent/revoke'> {
  ctx.services.store.commit({
    opId: `consent-revoke-${args.scope}-${nonce(ctx)}`,
    origin: 'local',
    writes: [
      { kind: 'consent', scope: args.scope, remove: true },
      { kind: 'meta', key: CONSENT_KEY_META, value: null },
      ...auditWrites(ctx.caller, 'Consent/revoke', args.scope),
    ],
  });
  return readConsent(ctx);
}
