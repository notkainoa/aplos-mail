/**
 * The log event catalog (Phase 0 artifact F7): the plain-data catalog and its types (`./events`, which the engine
 * imports directly so its bundle carries no zod for logging) and the zod/mini schemas derived from it (`./schema`).
 */
export * from './events';
export * from './schema';
