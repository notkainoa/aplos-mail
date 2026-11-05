import type { CommitExtension } from '../store/port';
import type { LaneModule } from '../runtime/services';
import { registerViewKind } from '../views/registry';
import { eventsPlan, plansPlan } from './views';

/** Seam 1: lane `prov-cal`'s module, imported by the composition root (`src/index.ts`). */
export const lane = 'prov-cal';

/** The lane's writers for its own tables (seam 2); none yet — sync writes land through the actor. */
export const extensions: readonly CommitExtension[] = [];

// Import-time, like the mail kinds in `views/registry.ts`: the registry is process state, while `createModule`
// runs once per engine instance (tests build several), so registering inside it would double-register.
registerViewKind('events', eventsPlan);
registerViewKind('plans', plansPlan);

export function createModule(): LaneModule {
  return {};
}
