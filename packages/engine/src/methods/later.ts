import type { AreaHandlers } from './types';

/**
 * The `later` area, owned by lane `eng-time`. The choices are resolved by the engine's clock and the owner's zone
 * (`clock/sources/later.ts`), so every client shows the same times.
 */
export const handlers: AreaHandlers<'later'> = {
  'Later/presets': (_args, ctx) => ctx.services.later.presets(),
};
