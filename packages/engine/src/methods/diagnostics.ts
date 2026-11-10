import type { Input, Output } from '@aplos/contract';
import { buildBundle } from '../diag/bundle/build';
import { auditWrites } from '../host/audit';
import { nonce, type AreaHandlers, type MethodContext } from './types';

/**
 * The `diagnostics` area, owned by lane `eng-host`. `preview` and `export` build the content-free bundle
 * (`diag/bundle/build.ts`; the host re-checks it against `StrictDiagnosticsBundle` before it may leave).
 * `verbose` persists `meta.verbose_until` for the 15-minute protocol log: the host reads it for the log
 * level, so an engine restart ends a window that was still open and a stale one never turns logging on.
 */

/** The verbose protocol log's auto-off window (contract: "switching itself off after 15 minutes"). */
const VERBOSE_MS = 15 * 60_000;
const KEY = 'verbose_until';
const BUNDLE_NAME = 'aplos-diagnostics.json';

const bundle = (ctx: MethodContext) => buildBundle(ctx.services, ctx.services.clock.now());

function verbose(
  args: Input<'Diagnostics/verbose'>,
  ctx: MethodContext,
): Output<'Diagnostics/verbose'> {
  const until = args.on ? ctx.services.clock.now() + VERBOSE_MS : undefined;
  ctx.services.store.commit({
    opId: `diagnostics-verbose-${nonce(ctx)}`,
    origin: 'local',
    writes: [
      // `null` deletes the row: "off" and an elapsed window read the same way.
      { kind: 'meta', key: KEY, value: until === undefined ? null : String(until) },
      ...auditWrites(ctx.caller, 'Diagnostics/verbose'),
    ],
  });
  return until === undefined ? {} : { until };
}

export const handlers: AreaHandlers<'diagnostics'> = {
  'Diagnostics/preview': (_args, ctx) => bundle(ctx),
  'Diagnostics/export': async (_args, ctx) => {
    const bytes = new TextEncoder().encode(JSON.stringify(bundle(ctx)));
    const put = await ctx.services.blobs.put({
      caller: ctx.caller,
      connectionId: ctx.connectionId,
      kind: 'upload',
      bytes,
      mime: 'application/json',
      name: BUNDLE_NAME,
      signal: ctx.signal,
    });
    return { blobId: put.blobId, name: BUNDLE_NAME, size: put.size };
  },
  'Diagnostics/verbose': verbose,
};
