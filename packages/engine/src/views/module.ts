import type { CommitExtension } from '../store/port';
import type { EngineServices, LaneModule } from '../runtime/services';

/**
 * Seam 1: lane `eng-views`'s module, imported by the composition root (`src/index.ts`) from this fixed path. It will hold
 * the live windows (`ViewEngine`), `Thread/act`'s operations and sender rules. Add the lane's own services by declaration merging, so no other file changes:
 *
 *   declare module '../runtime/services' { interface EngineServices { myService: MyService } }
 *
 * Owned by `eng-views`; this empty stub was created by `eng-contract`'s contract-1 with the lane's approval.
 */
export const lane = 'eng-views';

/** The lane's writers for its own tables (seam 2); the host passes every module's list to `openStore`. */
export const extensions: readonly CommitExtension[] = [];

/** Builds the lane's services once the core services exist; runs once, in the root's fixed order. */
export function createModule(_services: EngineServices): LaneModule {
  return {};
}
