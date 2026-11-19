import type { CommitExtension } from '../store/port';
import type { EngineServices, LaneModule } from '../runtime/services';
import { auditExtension } from './audit';
import { clientExtension } from './clients';

export { auditWrites } from './audit';

declare module '../runtime/services' {
  interface EngineServices {
    /** When the engine was composed (this module's `createModule` ran); `Diagnostics/preview`'s uptimeMs. */
    diagStartedAt?: number;
  }
}

/** Seam 1: lane `eng-host`'s module, imported by the composition root (`src/index.ts`). */
export const lane = 'eng-host';

/*
 * Body retention (ARCH 3.6) is a lazy module (`store/retention`), so the core holds only this: its loader, shared by the
 * start hook below and `Thread/open`, and a stub for its write kind that runs the module's writer. Both writers of the
 * kind load the module before they commit, so the writer is always there when a `retention` write runs.
 */
let retention: typeof import('../store/retention') | undefined;
export const loadRetention = async () => (retention ??= await import('../store/retention'));

/** The audit-log writer (seam 2); `clients` joins it with host-5; then retention's. */
export const extensions: readonly CommitExtension[] = [
  auditExtension,
  clientExtension,
  { lane, kinds: ['retention'], changeTypes: [], apply: (w, tx) => retention?.write(w, tx) },
];

export function createModule(services: EngineServices): LaneModule {
  const stopped = new AbortController();
  return {
    services: { diagStartedAt: services.clock.now() },
    // A retention pass every few hours, on a desktop host only (`retentionLoop`).
    start() {
      loadRetention()
        .then(r => r.retentionLoop(services, stopped.signal))
        .catch(() => undefined);
    },
    stop: () => stopped.abort(),
  };
}
