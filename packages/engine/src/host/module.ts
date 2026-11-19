import type { CommitExtension } from '../store/port';
import type { EngineServices, LaneModule } from '../runtime/services';
import { auditExtension } from './audit';
import { clientExtension } from './clients';
import { retentionExtension } from './retention-ext';

export { auditWrites } from './audit';

declare module '../runtime/services' {
  interface EngineServices {
    /** When the engine was composed (this module's `createModule` ran); `Diagnostics/preview`'s uptimeMs. */
    diagStartedAt?: number;
  }
}

/** Seam 1: lane `eng-host`'s module, imported by the composition root (`src/index.ts`). */
export const lane = 'eng-host';

/** The audit-log writer (seam 2); `clients` joins it with host-5; retention's writers (ARCH 3.6). */
export const extensions: readonly CommitExtension[] = [
  auditExtension,
  clientExtension,
  retentionExtension,
];

export function createModule(services: EngineServices): LaneModule {
  const stopped = new AbortController();
  return {
    services: { diagStartedAt: services.clock.now() },
    // Body retention runs on a desktop host only, from a lazy module (`store/retention`), a pass every few hours.
    start() {
      if (services.host.capabilities.desktop)
        void import('../store/retention')
          .then(r => r.retentionLoop(services, stopped.signal))
          .catch(() => undefined);
    },
    stop: () => stopped.abort(),
  };
}
