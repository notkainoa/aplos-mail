import type { CommitExtension } from '../store/port';
import type { EngineServices, LaneModule } from '../runtime/services';
import { isAbsent } from '../runtime/engine';
import { createCalendarHolds } from './holds-core';
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

export function createModule(services: EngineServices): LaneModule {
  // Held calendar writes (a write that tells guests waits its undo window): the thin core registers its deadline
  // source; the working half loads on the first hold. A host without a deadline loop gets none (writes go at once).
  if (isAbsent(services.deadlines) || isAbsent(services.calendar)) return {};
  return { services: { calendarHolds: createCalendarHolds(services) } };
}
