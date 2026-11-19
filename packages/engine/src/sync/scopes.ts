import type { ConnectResult } from '../ports';

/**
 * The Google scope without which Aplos cannot work (Gmail read, label, archive and send).
 * DUPLICATED on purpose from `apps/desktop/src/host/providers/oauth/scopes.ts` (`googleScopeManifest`, the entry with
 * `required: true`): the engine core imports nothing from `apps/`. Change both together.
 */
export const REQUIRED_MAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

export const MISSING_MAIL_SCOPE =
  'Aplos needs permission to read and organise your Gmail to work. Try again and allow it on Google’s screen.';

export function hasRequiredScope(result: Pick<ConnectResult, 'grantedScopes'>): boolean {
  return result.grantedScopes.includes(REQUIRED_MAIL_SCOPE);
}
