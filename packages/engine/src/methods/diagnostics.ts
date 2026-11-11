import type { Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { auditWrites } from '../host/audit';
import { nonce, type AreaHandlers, type MethodContext } from './types';

/**
 * The `diagnostics` area, owned by lane `eng-host`. `preview` and `export` build the content-free bundle
 * (`diag/bundle/build.ts`) and run its production gate (`checkBundle`, FR-32 — zod cannot enter the engine,
 * so the strict shape the host applies in dev is enforced here on every call).
 * `verbose` persists `meta.verbose_until` as an absolute deadline for the 15-minute protocol log: the host
 * reads it for the log level at every event, so a restart inside the window keeps logging until the deadline
 * — the window is the deadline, not the process — and a stale one never turns logging on.
 */

/** The verbose protocol log's auto-off window (contract: "switching itself off after 15 minutes"). */
const VERBOSE_MS = 15 * 60_000;
const KEY = 'verbose_until';
const BUNDLE_NAME = 'aplos-diagnostics.json';

/** The bundle builder loads on first use (`diag/bundle/` is a lazy dir) and is strict-checked every call. */
const bundle = async (ctx: MethodContext) => {
  const built = await import('../diag/bundle/build');
  const out = built.buildBundle(ctx.services, ctx.services.clock.now());
  built.checkBundle(out);
  return out;
};

function verbose(
  args: Input<'Diagnostics/verbose'>,
  ctx: MethodContext,
): Output<'Diagnostics/verbose'> {
  // No `on` is a read: answer the stored deadline so a fresh Settings screen shows the real state. The same
  // window rule the level thunk uses: an expired deadline, or one further out than the window allows, reads
  // as off instead of handing the UI a deadline that cannot be real.
  if (args.on === undefined) {
    const stored = ctx.services.store.read(
      q => q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', KEY)?.value,
    );
    const until = stored === undefined ? undefined : Number(stored);
    const now = ctx.services.clock.now();
    return until !== undefined && Number.isFinite(until) && until > now && until - now <= VERBOSE_MS
      ? { until }
      : {};
  }
  // A listener may switch the protocol log OFF (safe, least privilege) but only the owner turns it on or
  // extends it — otherwise a tool could lengthen a window it never opened and keep the noisy log running.
  if (args.on && ctx.caller.kind === 'listener')
    throw new ContractError({
      type: 'forbidden',
      message: 'Only the app can turn verbose logging on.',
    });
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
    const bytes = new TextEncoder().encode(JSON.stringify(await bundle(ctx)));
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
