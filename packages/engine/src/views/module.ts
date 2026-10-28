import type { CommitExtension } from '../store/port';
import type { EngineServices, LaneModule } from '../runtime/services';
import { createThreadOps, type ThreadOps } from './commands';
import { createViewEngine, type ViewEngine } from './windows';

declare module '../runtime/services' {
  interface EngineServices {
    /** The live windows (views-2): `View/*`, `Folder/get`, `Counts/get`, `SenderGroup/get`. */
    views: ViewEngine;
    /** The commands (views-3): `Thread/act`, `Operation/undo|retry|get`. */
    threadOps: ThreadOps;
  }
}

/**
 * Seam 1: lane `eng-views`'s module, imported by the composition root (`src/index.ts`) from this fixed path. It holds
 * the live windows (`ViewEngine`) and the commands (`ThreadOps`); sender rules join it in views-4.
 */
export const lane = 'eng-views';

/** The lane's writers for its own tables (seam 2); the host passes every module's list to `openStore`. */
export const extensions: readonly CommitExtension[] = [];

/** Builds the lane's services once the core services exist; runs once, in the root's fixed order. */
export function createModule(services: EngineServices): LaneModule {
  const views = createViewEngine({
    store: services.store,
    clock: services.clock,
    frames: services.frames,
    log: services.log,
    deadlines: services.deadlines,
    randomBytes: services.randomBytes,
  });
  const threadOps = createThreadOps({
    store: services.store,
    clock: services.clock,
    frames: services.frames,
    accounts: () => services.accounts,
    zone: views.zone,
  });
  return { services: { views, threadOps }, stop: () => views.close() };
}
