import type { AreaHandlers } from './types';

/**
 * The `consent` area, owned by lane `eng-ai`. The handlers are thin dispatchers — the fingerprint logic and the
 * grant/revoke commits live in `ai/impl/consent-methods` (lazy-loaded; the engine's budget is real).
 */

const I = () => import('../ai/impl/consent-methods');

export const handlers: AreaHandlers<'consent'> = {
  'Consent/get': async (_args, ctx) => (await I()).readConsent(ctx),
  'Consent/grant': async (args, ctx) => (await I()).grant(args, ctx),
  'Consent/revoke': async (args, ctx) => (await I()).revoke(args, ctx),
};
