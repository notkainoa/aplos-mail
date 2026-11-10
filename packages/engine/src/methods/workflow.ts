import type { Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { auditWrites } from '../host/audit';
import { type AreaHandlers, type MethodContext } from './types';

/**
 * The `workflow` area, owned by lane `prov-gmail`: Done, Later and reminders syncing between the owner's
 * Macs over the sealed workflow channel (`sync/host.ts`, `google/workflow-state.ts`). The channel itself
 * already runs for the lease when the data key is present; what `Workflow/enable`'s pairing code must do —
 * carry that shared key to another Mac — has no port and no code format, so `enable` and `code` answer
 * `unavailable` honestly rather than mint a code that cannot join anything (eng-admin DECIDED 2026-11-10).
 * `status` reports the `meta.workflow_sync` flag and `available:false`; `disable` is the idempotent off.
 */

const KEY = 'workflow_sync';
const LATER = 'Syncing Done and Later between Macs arrives in a later version.';

const unavailable = () => {
  throw new ContractError({ type: 'unavailable', message: LATER });
};

const enabled = (ctx: MethodContext) =>
  ctx.services.store.read(
    q => q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', KEY)?.value === '1',
  );

function disable(_args: Input<'Workflow/disable'>, ctx: MethodContext): Output<'Workflow/disable'> {
  if (enabled(ctx))
    ctx.services.store.commit({
      opId: `workflow-disable-${ctx.services.clock.now()}`,
      origin: 'local',
      writes: [
        { kind: 'meta', key: KEY, value: '0' },
        ...auditWrites(ctx.caller, 'Workflow/disable'),
      ],
    });
  return { enabled: false };
}

export const handlers: AreaHandlers<'workflow'> = {
  'Workflow/status': (_args, ctx): Output<'Workflow/status'> => ({
    enabled: enabled(ctx),
    available: false,
    message: LATER,
  }),
  'Workflow/enable': unavailable,
  'Workflow/code': unavailable,
  'Workflow/disable': disable,
};
