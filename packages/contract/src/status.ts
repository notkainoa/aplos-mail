import * as z from 'zod';
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
  z.object({ state: z.literal('backfilling'), done: z.number().int().nonnegative(), of: z.number().int().nonnegative().optional() }),
  /** Governor pause: epoch ms `until`, the error class and the provider's reason code (never copy). */
  z.object({ state: z.literal('paused'), until: z.number(), class: ErrorClassSchema, reason: z.string() }),
  /** The grant has expired or was revoked: Reconnect, with `login_hint`, no resync, queued changes kept. */
  z.object({ state: z.literal('needsReauth'), reason: z.string() }),
  z.object({ state: z.literal('needsPermission'), missingScopes: z.array(z.string()) }),
  z.object({ state: z.literal('needsAdmin'), reason: z.string() }),
  /** The provider's API is not configured for this app (`accessNotConfigured`): every account of that provider. */
  z.object({ state: z.literal('misconfigured'), reason: z.string() }),
  z.object({ state: z.literal('offline'), since: z.number().optional() }),
  z.object({ state: z.literal('error'), reason: z.string() }),
]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;
export type AccountState = AccountStatus['state'];

/**
 * Facts every account carries next to its status. `reconnectBy` is the token grant time plus 7 days while the Google
 * project is in Testing mode (ARCH 6.4, 12.5; roadmap N3) and is absent for other providers, so the UI can warn a day ahead.
 */
export const AccountHealthSchema = z.object({
  status: AccountStatusSchema,
  /** Epoch ms. */
  reconnectBy: z.number().optional(),
  /** Epoch ms of the last completed sync step. */
  lastSyncAt: z.number().optional(),
});
export type AccountHealth = z.infer<typeof AccountHealthSchema>;
