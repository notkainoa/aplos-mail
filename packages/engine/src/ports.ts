/**
 * The engine's ports (Phase 0 artifact F3): every interface a lane implements or calls across a lane boundary.
 * Types, small error classes, a few constants and one predicate (`sendsRemoteDraft`) that state a frozen rule; no other behaviour. Frozen at C1; after that, changes are additive and go through
 * CONTRACT-CHANGE-PROPOSED to `eng-contract`. `ports.walk.md` walks every provider through them.
 */
export * from './ports/base';
export * from './ports/time';
export * from './ports/governor';
export * from './ports/provider';
export * from './ports/calendar';
export * from './ports/engine';
export * from './ports/content';
// Defined beside their implementations (F4 store, F7 logger) and re-exported here so lanes import every port from one place.
export type {
  StorePort,
  StoreReader,
  CommitInput,
  CommitResult,
  CommitOrigin,
  StoreWrite,
} from './store/port';
export type { Logger, LogSink } from './diag/log';
