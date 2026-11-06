import type { Input, Output } from '@aplos/contract';
import { auditWrites } from '../host/audit';
import { nonce, type AreaHandlers, type MethodContext } from './types';

/**
 * The `listener` area, owned by lane `eng-host`. The on/off choice persists as `meta.listener_enabled`; the socket
 * itself is the host's (`host/transports/socket.ts`), which reads the flag at start. `socketPath` and `port` are
 * reported once the host serves them.
 */

const KEY = 'listener_enabled';

const enabled = (ctx: MethodContext) =>
  ctx.services.store.read(
    q => q.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', KEY)?.value === '1',
  );

export const handlers: AreaHandlers<'listener'> = {
  'Listener/get': (_args, ctx): Output<'Listener/get'> => ({ enabled: enabled(ctx) }),
  'Listener/set': (args: Input<'Listener/set'>, ctx): Output<'Listener/set'> => {
    if (enabled(ctx) === args.enabled) return { enabled: args.enabled };
    ctx.services.store.commit({
      opId: `listener-set-${nonce(ctx)}`,
      origin: 'local',
      writes: [
        { kind: 'meta', key: KEY, value: args.enabled ? '1' : '0' },
        ...auditWrites(ctx.caller, 'Listener/set'),
      ],
    });
    return { enabled: args.enabled };
  },
};
