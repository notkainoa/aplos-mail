import type { LiveProvider, SmokeProbe, Tier } from '../types';
import { adapterSendFind } from './gmail-adapter-send';
import { archiveDeltaCost } from './gmail-archive-delta';
import { authResultsShape } from './gmail-auth-results';
import { calendarReadSync } from './gcal-r';
import { draftMessageIdAfterEdit } from './gmail-draft-message-id';
import { inboxWindowMetadata, profileAndLabels } from './gmail-r';
import { sendMessageId } from './gmail-send-message-id';

/** Every registered probe. Tier M and S-self probes are added here when they exist. */
export const PROBES: readonly SmokeProbe[] = [
  profileAndLabels,
  inboxWindowMetadata,
  archiveDeltaCost,
  authResultsShape,
  draftMessageIdAfterEdit,
  sendMessageId,
  adapterSendFind,
  calendarReadSync,
];

export function probesFor(
  provider: LiveProvider,
  tier: Tier,
  all: readonly SmokeProbe[] = PROBES,
): SmokeProbe[] {
  return all.filter(probe => probe.provider === provider && probe.tier === tier);
}
