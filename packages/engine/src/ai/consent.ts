import type { Settings } from '@aplos/contract';
import type { CommitExtension, CommitExtensionTx } from '../store/port';
import { StoreError } from '../store/port';

/**
 * The background-AI consent record (ARCH 8.3, eng-ai): one row per scope in `consent`, and the fingerprint it was
 * granted against in `meta.consent_key`. `Consent/get` reports `needsReconsent` when the fingerprint no longer
 * matches the live settings (FR-5, R2B-4): changing a background feature's provider, model or provider address host
 * asks again, without a write path through Settings ever knowing the consent table.
 */

/** The features background jobs run on: summaries, plans, and drafts for follow-ups (R2B-4). */
const backgroundFeatures = ['summaries', 'plans', 'drafts'] as const;

/** What a grant covers: each background feature's provider, model and that provider's address host. */
export function consentKey(ai: Settings['ai']): string {
  return backgroundFeatures
    .map(feature => {
      const { provider, model } = ai.features[feature];
      const address = ai.providers[provider]?.address;
      let host = '';
      try {
        host = address ? new URL(address).host : '';
      } catch {
        /* an empty or malformed address */
      }
      return `${provider}${model}${host}`;
    })
    .join('');
}

export const CONSENT_KEY_META = 'consent_key';

declare module '../store/port' {
  interface ExtensionWrites {
    consent: ConsentWrite;
  }
}

/** One `consent` write: the granted record, or `remove` to drop it. */
export interface ConsentWrite {
  kind: 'consent';
  scope: string;
  version?: number;
  provider?: string;
  model?: string;
  grantedAt?: number;
  remove?: boolean;
}

function apply(write: { kind: string }, tx: CommitExtensionTx): void {
  const w = write as ConsentWrite;
  if (typeof w.scope !== 'string' || w.scope.length === 0 || w.scope.length > 60)
    throw new StoreError('invalid', 'A consent write names a scope');
  if (w.remove) {
    const gone = tx.run('DELETE FROM consent WHERE scope = ?', w.scope);
    if (gone.changes) tx.mark('Consent', w.scope, 'd');
    return;
  }
  tx.run(
    'INSERT INTO consent(scope, version, provider, model, granted_at) VALUES(?, ?, ?, ?, ?) ' +
      'ON CONFLICT(scope) DO UPDATE SET version = excluded.version, provider = excluded.provider, ' +
      'model = excluded.model, granted_at = excluded.granted_at',
    w.scope,
    w.version ?? 0,
    w.provider ?? null,
    w.model ?? null,
    w.grantedAt ?? tx.now(),
  );
  tx.mark('Consent', w.scope, 'u');
}

export const consentExtension: CommitExtension = {
  lane: 'eng-ai',
  kinds: ['consent'],
  changeTypes: ['Consent'],
  apply,
};

export interface ConsentRow {
  [key: string]: string | number | null | Uint8Array;
  scope: string;
  version: number;
  provider: string | null;
  model: string | null;
  granted_at: number | null;
}
