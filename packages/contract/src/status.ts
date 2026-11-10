import * as z from 'zod/mini';
import { ErrorClassSchema } from './errors';

/**
 * One status vocabulary drives retry policy and the UI (ARCH 6.4). Only `offline` and `paused` resume on their own.
 * A discriminated union of named objects (ARCH 9.3 wire rules: no tuples); an unknown `state` from a newer engine
 * should be shown as `error`.
 */
export const AccountStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('starting') }),
  z.object({ state: z.literal('ok') }),
  z.object({ state: z.literal('syncing') }),
  /** Quiet history fill after the first window; never gates anything. `of` is absent when the provider gives no estimate. */
  z.object({
    state: z.literal('backfilling'),
    done: z.int().check(z.nonnegative()),
    of: z.optional(z.int().check(z.nonnegative())),
  }),
  /** Governor pause: epoch ms `until`, the error class and the provider's reason code (never copy). */
  z.object({
    state: z.literal('paused'),
    until: z.number(),
    class: ErrorClassSchema,
    reason: z.string(),
  }),
  /** The grant has expired or was revoked: Reconnect, with `login_hint`, no resync, queued changes kept. */
  z.object({ state: z.literal('needsReauth'), reason: z.string() }),
  z.object({ state: z.literal('needsPermission'), missingScopes: z.array(z.string()) }),
  z.object({ state: z.literal('needsAdmin'), reason: z.string() }),
  /** The provider's API is not configured for this app (`accessNotConfigured`): every account of that provider. */
  z.object({ state: z.literal('misconfigured'), reason: z.string() }),
  z.object({ state: z.literal('offline'), since: z.optional(z.number()) }),
  z.object({ state: z.literal('error'), reason: z.string() }),
]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;
export type AccountState = AccountStatus['state'];

/**
 * Stable keys the UI maps to DESIGN 7.15 copy, for account states, setup rows and error replies (Providers port proposal
 * section 5). Additive only; round-2 codes are listed now. Open on the wire: an unknown code is shown as `unknown`.
 */
export const reasonCodes = [
  'rate.minute',
  'rate.concurrency',
  'quota.daily',
  'quota.project',
  'quota.sendLimit',
  'quota.calendarAbuse',
  'quota.bandwidth',
  'auth.expired',
  'auth.revoked',
  'auth.adminPolicy',
  'auth.adminConsent',
  'auth.wrongAccount',
  'auth.testingModeExpiry',
  'auth.denied',
  'auth.cancelled',
  'auth.timeout',
  'permission.mailModify',
  'permission.filters',
  'permission.calendar',
  /** The account granted read-only calendar access and an event was created, changed, deleted or answered: Settings → Calendar offers "Enable editing" (`Account/grantPermissions` with `enable: 'calendarWrite'`). */
  'permission.calendarWrite',
  'permission.settings',
  'config.apiDisabled',
  'config.clientMissing',
  'net.offline',
  'server.unavailable',
  'server.connectionLimit',
  'server.limitedMode',
  'cursor.expired',
  'ai.noProvider',
  'ai.missingKey',
  'ai.unreachable',
  'ai.dailyCap',
  'ai.rateLimited',
  'ai.noConsent',
  'ai.trainsOnInputs',
  'ai.failed',
  /** The call named an account whose "Use this account's mail for AI" is off (freeze FR-8). */
  'ai.accountExcluded',
  /** A send missed its time while the Mac was off and waits for Send now or Reschedule (ARCH 7.3, FR-2). */
  'send.overdue',
  'unknown',
] as const;
export type ReasonCode = (typeof reasonCodes)[number];
export const ReasonCodeSchema = z.union([z.enum(reasonCodes), z.string()]);

/**
 * Facts every account carries next to its status. `reconnectBy` is when the refresh token stops working: the earlier
 * of the grant time plus 7 days while the Google project is in Testing mode and Google's `refresh_token_expires_in`
 * (ARCH 6.4, 12.5; roadmap N3; F3 `ConnectResult.grant.refreshExpiresAt`). Absent when neither applies (other
 * providers), so the UI can warn a day ahead.
 */
export const AccountHealthSchema = z.object({
  status: AccountStatusSchema,
  /** The copy key for the current status (added in contract v1); absent while `ok`. `status.reason` stays the provider's own code. */
  reasonCode: z.optional(ReasonCodeSchema),
  /** Epoch ms. */
  reconnectBy: z.optional(z.number()),
  /** Epoch ms of the last completed sync step. */
  lastSyncAt: z.optional(z.number()),
});
export type AccountHealth = z.infer<typeof AccountHealthSchema>;
