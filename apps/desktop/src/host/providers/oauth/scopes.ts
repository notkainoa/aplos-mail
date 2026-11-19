// The one table of Google scopes Aplos may request: what each is for and the exact consent text (plan 20 PV5).
// Adding a scope forces every user to consent again, so a new scope needs a DECISIONS.md entry and a row here.

export type ScopeFeature =
  'mail' | 'filters' | 'calendarList' | 'calendarEvents' | 'calendarEventsWrite';

export interface ScopeEntry {
  scope: string;
  feature: ScopeFeature;
  /** Sign-in cannot finish without it. */
  required: boolean;
  /** What the owner is told before Google's screen opens. */
  consent: string;
  /**
   * Never part of a default request (least privilege — the consent screen must never promise "create, change and
   * delete" for a sync that only reads). It is asked for only when the owner opts in by name (`explicitScopes`:
   * Settings → Calendar → "Enable editing"). A grant that already holds a deferred scope keeps it on a reconnect.
   */
  deferred?: true;
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
    scope: google('calendar.events.readonly'),
    feature: 'calendarEvents',
    required: false,
    consent: 'See the events on your calendars.',
  },
  {
    scope: google('calendar.events'),
    feature: 'calendarEventsWrite',
    required: false,
    deferred: true,
    consent: 'See, create, change and delete events on your calendars.',
  },
];

/**
 * The opt-ins `Account/grantPermissions` may name (`ConnectRequest.enable`) and the optional features each asks for.
 * A deferred scope is requestable ONLY here, together with whatever it needs to be useful: `calendarWrite` adds
 * the calendar list (a write grant alone does not make the calendar capability true) and the write scope — never
 * mail filters or anything else that was not asked for.
 */
export const explicitEnables = {
  calendarWrite: ['calendarList', 'calendarEventsWrite'],
} as const satisfies Record<string, readonly ScopeFeature[]>;

export type ExplicitEnable = keyof typeof explicitEnables;

/** The scopes an explicit opt-in adds to a sign-in. */
export function explicitScopes(enable: ExplicitEnable): string[] {
  // The wire is open: a value this build does not know is refused before Google is asked, never guessed at.
  if (!Object.hasOwn(explicitEnables, enable)) throw new Error(`Not a known opt-in: ${enable}`);
  return scopesForFeatures(...explicitEnables[enable]);
}

/** The `scope` parameter of the authorization URL: never carries a `deferred` entry. */
export function googleScopeParam(): string {
  return [
    ...identityScopes,
    ...googleScopeManifest.filter(entry => !entry.deferred).map(entry => entry.scope),
  ].join(' ');
}

/**
 * The scopes a sign-in asks for: the identity scopes, every required scope, and the optional ones the caller picked.
 * A scope the manifest lacks, or names as required, is a programming error and is refused before Google is asked.
 */
export function connectScopes(optional: readonly string[] = []): string[] {
  const optionalKnown = new Set(googleScopeManifest.filter(e => !e.required).map(e => e.scope));
  const unknown = optional.filter(scope => !optionalKnown.has(scope));
  if (unknown.length)
    throw new Error(`Not an optional scope in the manifest: ${unknown.join(' ')}`);
  const required = googleScopeManifest.filter(entry => entry.required).map(entry => entry.scope);
  return [...new Set([...identityScopes, ...required, ...optional])];
}

/** The optional manifest scopes of the named features, in manifest order (e.g. both calendar scopes). */
export function scopesForFeatures(...features: ScopeFeature[]): string[] {
  const wanted = new Set<ScopeFeature>(features);
  return googleScopeManifest
    .filter(entry => !entry.required && wanted.has(entry.feature))
    .map(entry => entry.scope);
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
