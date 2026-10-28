import * as z from 'zod';

/**
 * Why a provider (or AI) call failed, as one class the governor acts on (ARCH 6.3).
 * Open enum on the wire: a newer engine may send a class an older client does not know; treat it as `transient`.
 */
export const errorClasses = ['auth', 'permission', 'throttle', 'daily', 'send_limit', 'anti_abuse', 'config', 'transient', 'permanent', 'cancelled'] as const;
export type ErrorClass = typeof errorClasses[number];
export const ErrorClassSchema = z.union([z.enum(errorClasses), z.string()]);

/** The provider the failed call went to; `gcal`, `oauth` and `caldav` are separate budgets from the mail adapters. */
export const ErrorProviderSchema = z.union([z.enum(['google', 'microsoft', 'imap', 'jmap', 'gcal', 'oauth', 'caldav', 'ai']), z.string()]);

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
  status: z.number().int().optional(),
  /** The provider's own error code when it differs from `status` (IMAP response code, AADSTS number). */
  code: z.string().optional(),
  retryAfterMs: z.number().nonnegative().optional(),
  /** Absolute end of a daily stop, epoch ms (Gmail: next midnight America/Los_Angeles). */
  resumeAt: z.number().optional(),
  /** The refusal was a concurrency cap: in-flight drops to 1. */
  concurrency: z.boolean().optional(),
  /** A write whose outcome is unknown (timed out after the request was written). */
  uncertain: z.boolean().optional(),
  missingScopes: z.array(z.string()).optional(),
  /** For `permanent`: the remote item to quarantine. */
  item: z.string().optional(),
  providerMessage: z.string().max(300).optional(),
});
export type ClassifiedError = z.infer<typeof ClassifiedErrorSchema>;
