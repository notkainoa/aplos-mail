import type { CommitExtension } from '../store/port';
import type { EngineServices, LaneModule } from '../runtime/services';
import { auditExtension } from './audit';
import { clientExtension } from './clients';

export { auditWrites } from './audit';

declare module '../runtime/services' {
  interface EngineServices {
    /** When the engine was composed (this module's `createModule` ran); `Diagnostics/preview`'s uptimeMs. */
    diagStartedAt?: number;
  }
}

/** Seam 1: lane `eng-host`'s module, imported by the composition root (`src/index.ts`). */
export const lane = 'eng-host';

/** The audit-log writer (seam 2); `clients` joins it with host-5. */
export const extensions: readonly CommitExtension[] = [auditExtension, clientExtension];

export function createModule(services: EngineServices): LaneModule {
  return { services: { diagStartedAt: services.clock.now() } };
}
