/**
 * The engine's ports (Phase 0 artifact F3): every interface a lane implements or calls across a lane boundary.
 * Types and small error classes only, no behaviour. Frozen at C1; after that, changes are additive and go through
 * CONTRACT-CHANGE-PROPOSED to `eng-contract`. `ports.walk.md` walks every provider through them.
 */
export * from './ports/base';
export * from './ports/time';
export * from './ports/governor';
export * from './ports/provider';
export * from './ports/calendar';
export * from './ports/engine';
export * from './ports/content';
