import type { CommitExtension } from '../store/port';
import type { LaneModule } from '../runtime/services';
import { registerLazyViewKind } from '../views/registry';

/** Seam 1: lane `prov-cal`'s module, imported by the composition root (`src/index.ts`). */
export const lane = 'prov-cal';

/** The lane's writers for its own tables (seam 2); none yet — sync writes land through the actor. */
export const extensions: readonly CommitExtension[] = [];

// The events/plans compilers sit in a chunk of their own (the engine-bundle budget's seam): they load on the
// first `View/watch` for the kind, via `ensureViewKind`, and register themselves in `calendar/views.ts`. The
// registry is process state while `createModule` runs per engine, so registration happens here at import time.
const loadViews = () => import('./views');
registerLazyViewKind('events', loadViews);
registerLazyViewKind('plans', loadViews);

export function createModule(): LaneModule {
  return {};
}
