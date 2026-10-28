import * as z from 'zod/mini';

/**
 * Why a provider (or AI) call failed, as one class the governor acts on (ARCH 6.3).
 * Open enum on the wire: a newer engine may send a class an older client does not know; treat it as `transient`.
 * An edit that raced a remote change (Google Calendar's 412 `conditionNotMet`) is not a class: adapters return it as a
 * result (`CalendarWriteResult.conflict`, F3), and a reply that reaches the UI uses the `conflict` error type below.
 */
export const errorClasses = [
  'auth',
  'permission',
  'throttle',
  'daily',
  'send_limit',
  'anti_abuse',
  'config',
  'transient',
  'permanent',
  'cancelled',
] as const;
export type ErrorClass = (typeof errorClasses)[number];
export const ErrorClassSchema = z.union([z.enum(errorClasses), z.string()]);

/**
 * Where the failed call went: the governor budget it ran on (F3 `BudgetId`: `gmail`, `gcal`, `graph`, `imap`,
 * `imapBytes`, `jmap`, `caldav`, `oauth`, `ai:<provider>:<model>`), or the provider kind for a call outside a budget
 * (`google`, `microsoft`, `ai`). Open, so `ai:*` budgets and later providers fit.
 */
export const ErrorProviderSchema = z.union([
  z.enum([
    'gmail',
    'gcal',
    'graph',
    'imap',
    'imapBytes',
    'jmap',
    'caldav',
    'oauth',
    'google',
    'microsoft',
    'ai',
  ]),
  z.string(),
]);

/**
 * The classified-error record (plan 10 E0, ARCH 6.3; the Providers port proposal section 2).
 * The governor fills it, the Logger carries it, `Diagnostics/*` shows it. `providerMessage` is the provider's own text,
 * at most 300 characters after the Logger's redactor; it is never shown in the UI, which maps `class` and `reason` to copy.
 */
export const ClassifiedErrorSchema = z.object({
  class: ErrorClassSchema,
  provider: ErrorProviderSchema,
  /** Catalog method id of the call, e.g. `gmail.threads.get`, `oauth.token`. */
  method: z.string(),
  /** The provider's own reason code, verbatim: `rateLimitExceeded`, `invalid_grant`, `notFound`. */
  reason: z.string(),
  status: z.optional(z.int()),
  /** The provider's own error code when it differs from `status` (IMAP response code, AADSTS number). */
  code: z.optional(z.string()),
  retryAfterMs: z.optional(z.number().check(z.nonnegative())),
  /** Absolute end of a daily stop, epoch ms (Gmail: next midnight America/Los_Angeles). */
  resumeAt: z.optional(z.number()),
  /** The refusal was a concurrency cap: in-flight drops to 1. */
  concurrency: z.optional(z.boolean()),
  /** A write whose outcome is unknown (timed out after the request was written). */
  uncertain: z.optional(z.boolean()),
  missingScopes: z.optional(z.array(z.string())),
  /** For `permanent`: the remote item to quarantine. */
  item: z.optional(z.string()),
  providerMessage: z.optional(z.string().check(z.maxLength(300))),
});
export type ClassifiedError = z.infer<typeof ClassifiedErrorSchema>;

/**
 * Why a contract call failed, as the `type` of an error reply (ARCH 9.1). `message` is always the human sentence the UI
 * shows; `type` is what code branches on. Open on the wire: an unknown type from a newer engine is shown by its message.
 * - `validation`: the arguments failed the method's schema; `path` names the field.
 * - `stateMismatch`: an `ifInState` or draft `baseRevision` compare-and-set lost; re-read and retry.
 * - `conflict`: the change raced a remote edit (calendar 412, a draft edited on another device).
 * - `cannotCalculateChanges`: the client's state is below the change-log floor or from another `dbEpoch`; re-open windows.
 * - `unsupported`: an incompatible `apiVersion`, or a method this transport does not carry (e.g. a key method over HTTP).
 * - `forbidden`: the caller's scopes do not include the method's scope (ARCH 12.3), or what it acts on needs more
 *   (`scopeRule`), or it names an account the owner left out of AI (`reasonCode: 'ai.accountExcluded'`, FR-8).
 * - `paused`, `needsReauth`, `permission`: the account's state refuses the call (ARCH 6.4); `resumeAt` when known.
 * - `unavailable`: the engine is starting, parked or restarting, or the feature is not built yet in this version.
 * - `notConfigured`: an AI feature has no usable provider or key.
 */
export const errorTypes = [
  'validation',
  'notFound',
  'notImplemented',
  'stateMismatch',
  'conflict',
  'cannotCalculateChanges',
  'unsupported',
  'forbidden',
  'paused',
  'needsReauth',
  'permission',
  'unavailable',
  'notConfigured',
  'providerError',
  'rangeTooLarge',
  'tooLarge',
  'cancelled',
  'internal',
] as const;
export type ErrorType = (typeof errorTypes)[number];
export const ErrorTypeSchema = z.union([z.enum(errorTypes), z.string()]);

/** The `error` of a failed reply: `{id, ok:false, error}`. Everything but `type` and `message` is optional detail. */
export const ErrorBodySchema = z.object({
  type: ErrorTypeSchema,
  /** The sentence the UI shows, e.g. "Undo send must be between 0 and 60 seconds." */
  message: z.string(),
  /** For `validation`: the path of the offending field, e.g. `['patch', 'mail', 'undoSendSeconds']`. */
  path: z.optional(z.array(z.union([z.string(), z.number()]))),
  retryAfterMs: z.optional(z.number().check(z.nonnegative())),
  /** Epoch ms when a `paused` account or budget resumes. */
  resumeAt: z.optional(z.number()),
  /** Stable copy key (status.ts `ReasonCode`) when the error comes from an account or provider state. */
  reasonCode: z.optional(z.string()),
  /** The provider's classified error, for diagnostics only; never shown as copy. */
  classified: z.optional(ClassifiedErrorSchema),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export { ContractError, NotImplementedError } from './contract-error';
