import type { CommitExtension } from '../store/port';
import type { LaneModule } from '../runtime/services';
import { auditExtension } from './audit';
import { clientExtension } from './clients';

export { auditWrites } from './audit';

/** Seam 1: lane `eng-host`'s module, imported by the composition root (`src/index.ts`). */
export const lane = 'eng-host';

/** The audit-log writer (seam 2); `clients` joins it with host-5. */
export const extensions: readonly CommitExtension[] = [auditExtension, clientExtension];

export function createModule(): LaneModule {
  return {};
}
