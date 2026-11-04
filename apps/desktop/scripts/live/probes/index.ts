import type { LiveProvider, SmokeProbe, Tier } from '../types';
import { authResultsShape } from './gmail-auth-results';
import { draftMessageIdAfterEdit } from './gmail-draft-message-id';
import { inboxWindowMetadata, profileAndLabels } from './gmail-r';

/** Every registered probe. Tier M and S-self probes are added here when they exist. */
export const PROBES: readonly SmokeProbe[] = [
  profileAndLabels,
  inboxWindowMetadata,
  authResultsShape,
  draftMessageIdAfterEdit,
];

export function probesFor(
  provider: LiveProvider,
  tier: Tier,
  all: readonly SmokeProbe[] = PROBES,
): SmokeProbe[] {
  return all.filter(probe => probe.provider === provider && probe.tier === tier);
}
