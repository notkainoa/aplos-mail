// The one table of Google scopes Aplos may request: what each is for and the exact consent text (plan 20 PV5).
// Adding a scope forces every user to consent again, so a new scope needs a DECISIONS.md entry and a row here.

export type ScopeFeature = 'mail' | 'filters' | 'calendarList' | 'calendarEvents';

export interface ScopeEntry {
  scope: string;
  feature: ScopeFeature;
  /** Sign-in cannot finish without it. */
  required: boolean;
  /** What the owner is told before Google's screen opens. */
  consent: string;
}

const google = (name: string) => `https://www.googleapis.com/auth/${name}`;

export const identityScopes = ['openid', 'email', 'profile'] as const;

export const googleScopeManifest: readonly ScopeEntry[] = [
  {
    scope: google('gmail.modify'),
    feature: 'mail',
    required: true,
    consent: 'Read, label, archive and send your mail. Aplos never deletes mail permanently.',
  },
  {
    scope: google('gmail.settings.basic'),
    feature: 'filters',
    required: false,
    consent:
      'Create and edit Gmail filters and basic settings (Gmail groups filters with signature, vacation reply and send-as under one permission). Aplos uses it for filters, such as the ones it suggests for newsletters.',
  },
  {
    scope: google('calendar.calendarlist.readonly'),
    feature: 'calendarList',
    required: false,
    consent: 'See the list of your calendars.',
  },
  {
    scope: google('calendar.events'),
    feature: 'calendarEvents',
    required: false,
    consent: 'See, create, change and delete events on your calendars.',
  },
];

/** The `scope` parameter of the authorization URL. */
export function googleScopeParam(): string {
  return [...identityScopes, ...googleScopeManifest.map(entry => entry.scope)].join(' ');
}

/** A token response's `scope` string as a list; Google separates scopes with spaces. */
export function parseGrantedScopes(scope: unknown): string[] {
  if (typeof scope !== 'string') return [];
  return [...new Set(scope.split(/\s+/).filter(Boolean))];
}

/** Features the owner granted; a feature is on only when its scope was granted. */
export function grantedFeatures(granted: readonly string[]): Set<ScopeFeature> {
  const have = new Set(granted);
  return new Set(googleScopeManifest.filter(e => have.has(e.scope)).map(e => e.feature));
}

/** Manifest entries not granted, required ones first; drives "grant missing permissions". */
export function missingScopes(granted: readonly string[]): ScopeEntry[] {
  const have = new Set(granted);
  const missing = googleScopeManifest.filter(entry => !have.has(entry.scope));
  return [...missing.filter(e => e.required), ...missing.filter(e => !e.required)];
}

/** Connect and reconnect refuse a grant without these (`permission`, reason `missingRequiredScope`). */
export function missingRequiredScopes(granted: readonly string[]): ScopeEntry[] {
  return missingScopes(granted).filter(entry => entry.required);
}
