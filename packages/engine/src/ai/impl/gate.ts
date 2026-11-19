import type { ModelRef, Settings } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { EngineServices } from '../../runtime/services';
import { CONSENT_KEY_META, consentKey } from '../consent';
import { parseStored, withDefaults } from '../../runtime/settings';
import { providerRow, trainsOnInputs } from '../providers';

/**
 * The privacy gate (ARCH 8.3, the integrator's eng-ai NOTICE): BEFORE any mail text reaches a provider —
 * - background features (summaries, plans, drafts/follow-ups) need `settings.ai.background`, a granted AND current
 *   `background` consent (the stored fingerprint must equal `consentKey` of the live settings — a provider, model or
 *   address-host change re-asks), `ai_allowed = 1` on the account, and a provider that does not train on inputs;
 * - interactive features that touch mail (Ask, polish, draft replies) need `ai_allowed` on every account they read
 *   and a non-`trainsOnInputs` provider, but no consent (the user asked);
 * - calls carrying no mail text (`Ai/test`, a key check) are ungated.
 * A refusal names a `reasonCode`, never provider text.
 */

export type AiFeature = 'ask' | 'summaries' | 'drafts' | 'plans' | 'voice';

export function aiSettings(services: EngineServices): Settings['ai'] {
  return services.store.read(
    q =>
      withDefaults(
        parseStored(q.get<{ data: string }>('SELECT data FROM settings WHERE id = 1')?.data),
      ).ai,
  );
}

/** The stored consent row and its fingerprint match against the live settings (readConsent's rule). */
export function backgroundConsent(services: EngineServices): {
  granted: boolean;
  current: boolean;
} {
  return services.store.read(q => {
    const row = q.get('SELECT scope FROM consent WHERE scope = ?', 'background');
    if (!row) return { granted: false, current: false };
    const doc = parseStored(
      q.get<{ data: string }>('SELECT data FROM settings WHERE id = 1')?.data,
    );
    const stored = q.get<{ value: string }>(
      'SELECT value FROM meta WHERE key = ?',
      CONSENT_KEY_META,
    )?.value;
    // Fail closed: a consent row without its fingerprint still re-asks.
    return { granted: true, current: stored === consentKey(withDefaults(doc).ai) };
  });
}

/** Accounts whose mail AI may read (`ai_allowed = 1`), and the asked-for ids left out. */
export function allowedAccounts(
  services: EngineServices,
  ids?: readonly string[],
): { allowed: string[]; excluded: string[] } {
  // `scope.accountIds` only narrows: absent means every allowed account; present (even empty) means only those.
  const rows =
    ids === undefined
      ? services.store.read(q =>
          q.all<{ id: string; ai_allowed: number }>('SELECT id, ai_allowed FROM accounts'),
        )
      : services.store.read(q =>
          q.all<{ id: string; ai_allowed: number }>(
            `SELECT id, ai_allowed FROM accounts WHERE id IN (${ids.map(() => '?').join(',')})`,
            ...ids,
          ),
        );
  const allowed: string[] = [],
    excluded: string[] = [];
  const wanted = ids !== undefined ? new Set(ids) : undefined;
  for (const r of rows) (r.ai_allowed === 1 ? allowed : excluded).push(r.id);
  // An id that is not an account at all stays out of `allowed`; the UI counts it as excluded either way.
  if (wanted) for (const id of wanted) if (!rows.some(r => r.id === id)) excluded.push(id);
  return { allowed, excluded };
}

function featureModel(ai: Settings['ai'], feature: AiFeature): ModelRef {
  return ai.features[feature] as ModelRef;
}

/** One sentence per refusal; `reasonCode` is the copy key. */
export function gateError(reasonCode: string, message: string): ContractError {
  return new ContractError({ type: 'forbidden', message, reasonCode });
}

/**
 * The interactive gate: the feature's provider must exist and not train on inputs when mail text is sent.
 * `withMail` is set by every caller whose prompt carries stored mail or a draft.
 */
export function interactiveModel(
  services: EngineServices,
  feature: AiFeature,
  opts: { withMail: boolean },
): ModelRef {
  const ai = aiSettings(services);
  const model = featureModel(ai, feature);
  if (!providerRow(model.provider))
    throw gateError('ai.noProvider', 'Choose an AI provider in Settings → AI.');
  if (opts.withMail && trainsOnInputs(model.provider, ai.providers[model.provider]?.paid))
    throw gateError(
      'ai.providerTrains',
      `${providerRow(model.provider)!.label} may use your text for training on this plan. Pick another model in Settings → AI, or mark the key paid.`,
    );
  return model;
}

/**
 * The background gate: everything `interactiveModel` checks, plus `settings.ai.background`, a granted and current
 * `background` consent, and `ai_allowed` on the job's account. Answers a reason instead of throwing so the runner
 * can pause rather than fail rows.
 */
export function backgroundGate(
  services: EngineServices,
  feature: AiFeature,
  accountId?: string,
): { ok: true; model: ModelRef } | { ok: false; reasonCode: string } {
  const ai = aiSettings(services);
  if (!ai.background) return { ok: false, reasonCode: 'ai.backgroundOff' };
  const consent = backgroundConsent(services);
  if (!consent.granted) return { ok: false, reasonCode: 'ai.noConsent' };
  if (!consent.current) return { ok: false, reasonCode: 'ai.needsReconsent' };
  const model = featureModel(ai, feature);
  if (!providerRow(model.provider)) return { ok: false, reasonCode: 'ai.noProvider' };
  if (trainsOnInputs(model.provider, ai.providers[model.provider]?.paid))
    return { ok: false, reasonCode: 'ai.providerTrains' };
  if (accountId !== undefined) {
    const row = services.store.read(q =>
      q.get<{ ai_allowed: number }>('SELECT ai_allowed FROM accounts WHERE id = ?', accountId),
    );
    if (row?.ai_allowed !== 1) return { ok: false, reasonCode: 'ai.accountExcluded' };
  }
  return { ok: true, model };
}

/** `Ai/request`'s account check: mail of an account kept out of AI is refused outright. */
export function accountAllowed(services: EngineServices, accountId: string): void {
  const row = services.store.read(q =>
    q.get<{ ai_allowed: number }>('SELECT ai_allowed FROM accounts WHERE id = ?', accountId),
  );
  if (row === undefined)
    throw new ContractError({ type: 'notFound', message: 'That account is not in Aplos.' });
  if (row.ai_allowed !== 1)
    throw gateError(
      'ai.accountExcluded',
      "This account's mail is kept out of AI. Turn it on in Settings → AI.",
    );
}

/**
 * Saved provider addresses: http(s) only, no embedded credentials, and a non-loopback host needs https whenever that
 * provider has a key saved — an API key can't ride plain http to another machine.
 */
export function checkProviderAddresses(
  providers: Record<string, { address?: string | undefined } | undefined>,
  services: EngineServices,
): void {
  for (const [id, row] of Object.entries(providers)) {
    if (!row?.address) continue;
    try {
      const u = new URL(row.address);
      if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
      if (u.username || u.password) throw new Error('userinfo');
      const loopback = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/.test(u.hostname);
      const keyed =
        services.ai?.transport().keySource(id as 'ollama' | 'lmstudio' | 'custom') !== 'none';
      if (u.protocol === 'http:' && !loopback && keyed)
        throw new ContractError({
          type: 'validation',
          message: `${id}: use an https:// address for a server that isn't on this Mac — an API key can't ride plain http.`,
        });
    } catch (e) {
      if (e instanceof ContractError) throw e;
      throw new ContractError({
        type: 'validation',
        message: `${id}: enter a full http(s):// server address without credentials.`,
      });
    }
  }
}
