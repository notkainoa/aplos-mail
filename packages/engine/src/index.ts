import * as ai from './ai/module';
import * as clock from './clock/module';
import * as html from './mail/module';
import * as outbox from './outbox/module';
import * as views from './views/module';
import type { CommitExtension } from './store/port';
import { blobModule } from './runtime/blobs';
import { buildEngine, type Engine, type EngineOptions } from './runtime/engine';
import type { LaneModuleSource } from './runtime/services';

/**
 * The composition root (seam 1): the only file that names the lane modules. Order matters: `clock` first, because the
 * others register deadline sources with the timer loop it provides; `blobModule` before `outbox`, so the outbox can
 * take `services.blobs` when it is created.
 */
const modules: readonly LaneModuleSource[] = [clock, blobModule, views, outbox, ai, html];

/** Every lane's commit extensions, for the host's `openStore({extensions})` (seam 2). */
export function laneExtensions(): CommitExtension[] {
  return modules.flatMap(m => m.extensions);
}

/** Builds and starts the engine over a store the host opened with `laneExtensions()`. */
export function createEngine(options: EngineOptions): Promise<Engine> {
  return buildEngine(options, modules);
}

export { isAbsent, windowCaller } from './runtime/engine';
export type { Engine, EngineOptions, HostPorts } from './runtime/engine';
export type { ConnectedSession } from './runtime/connection';
export type { EngineServices, LaneModule, LaneModuleSource } from './runtime/services';
export { STATE_COALESCE_MS } from './runtime/frames';
export type { EngineFrame, FrameBus, ResetReason } from './runtime/frames';
