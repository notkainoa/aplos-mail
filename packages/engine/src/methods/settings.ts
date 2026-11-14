import type { Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { auditWrites } from '../host/audit';
import { requestAiCatchUp } from '../ai/writes';
import { parseStored, withDefaults } from '../runtime/settings';
import type { MethodContext } from './types';
import type { AreaHandlers } from './types';

/**
 * The `settings` area, owned by lane `eng-contract`. The singleton lives in `settings` (id 1) and is written through the
 * `settings` commit kind (`runtime/settings.ts`). Arguments arrive validated; the `ai` section is window-only (the access
 * layer refuses it for a listener before this runs).
 */

const readDoc = (ctx: MethodContext) =>
  ctx.services.store.read(q =>
    parseStored(q.get<{ data: string }>('SELECT data FROM settings WHERE id = 1')?.data),
  );

/**
 * The seq of the last commit that changed settings, or the compaction floor when the log no longer holds one: a state
 * below either may have missed a change, so it must not pass `ifInState`.
 */
function lastSettingsSeq(ctx: MethodContext): number {
  return ctx.services.store.read(q => {
    const last =
      q.get<{ seq: number | null }>("SELECT max(seq) AS seq FROM changes WHERE type = 'Settings'")
        ?.seq ?? 0;
    const floor = Number(
      q.get<{ value: string }>("SELECT value FROM meta WHERE key = 'change_floor_seq'")?.value ?? 0,
    );
    return Math.max(last, Number.isFinite(floor) ? floor : 0);
  });
}

/** Whether this opId was already applied: its retry gets the first receipt, not a staleness check against its own commit. */
const applied = (ctx: MethodContext, opId: string) =>
  ctx.services.store.read(
    q => q.get('SELECT 1 AS one FROM commits WHERE op_id = ?', opId) !== undefined,
  );

function getSettings(_args: Input<'Settings/get'>, ctx: MethodContext): Output<'Settings/get'> {
  return withDefaults(readDoc(ctx));
}

/**
 * A saved provider address is checked before it can steer a key or mail text at a server the owner did not mean
 * (`checkProviderAddresses`, in the lazy AI gate so the core stays inside its bundle budget).
 */
async function setSettings(
  args: Input<'Settings/set'>,
  ctx: MethodContext,
): Promise<Output<'Settings/set'>> {
  const providers = args.patch.ai?.providers;
  if (providers) (await import('../ai/impl/gate')).checkProviderAddresses(providers, ctx.services);
  return applySettings(args, ctx);
}

function applySettings(args: Input<'Settings/set'>, ctx: MethodContext): Output<'Settings/set'> {
  const { store, frames } = ctx.services;
  const { ifInState } = args;
  if (
    ifInState &&
    !applied(ctx, args.opId) &&
    (ifInState.dbEpoch !== store.dbEpoch ||
      ifInState.seq > store.seq() ||
      ifInState.seq < lastSettingsSeq(ctx))
  )
    throw new ContractError({
      type: 'stateMismatch',
      message: 'Settings changed in another window. Reopen them and try again.',
    });
  const before = withDefaults(readDoc(ctx));
  const result = store.commit({
    opId: args.opId,
    origin: 'local',
    writes: [
      { kind: 'settings', patch: args.patch },
      // `audit: true`: a listener client's change is logged, content-free, in the same commit.
      ...auditWrites(ctx.caller, 'Settings/set'),
    ],
  });
  // An `ai` patch can open summaries for mail that is already stored: the sentinel makes the runner catch up.
  if (args.patch.ai) requestAiCatchUp(store, ctx.services.clock.now());
  const settings = withDefaults(readDoc(ctx));
  // main follows the theme (nativeTheme) from the host channel; a repeat of the same theme says nothing.
  const theme = args.patch.ui?.theme;
  if (theme && theme !== before.ui.theme && !result.replayed)
    frames.emit({ frame: 'host', event: { type: 'appearance', theme } });
  return {
    settings,
    receipt: {
      opId: args.opId,
      appliedState: { dbEpoch: store.dbEpoch, seq: result.seq },
      undoable: false,
    },
  };
}

export const handlers: AreaHandlers<'settings'> = {
  'Settings/get': getSettings,
  'Settings/set': setSettings,
};
