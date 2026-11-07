import type { CommitExtension } from '../store/port';
import type { DeadlineSource } from '../ports';
import type { EngineServices, LaneModule } from '../runtime/services';
import { detachedTransport, type AiTransport } from './host';
import { consentExtension } from './consent';
import { aiWritesExtension } from './writes';

declare module '../runtime/services' {
  interface EngineServices {
    /** eng-ai's engine-side service: the bound host transport and interactive-run cancellation (ARCH 8). */
    ai: AiService;
  }
}

/**
 * The engine's AI service (seam 1). Thin on purpose: it holds the host's `AiTransport` (bound by `useTransport`,
 * absent until the host wires it) and the cancellation map for interactive runs. The gate, metering, enqueue and
 * runner live in `impl/` (lazy-loaded); methods and the `jobs` deadline source call into them.
 */
export interface AiService {
  /** Bind the host's provider transport once at start (`undefined` detaches again — a stopped host). */
  useTransport(transport: AiTransport | undefined): void;
  /** The bound transport, never undefined (a detached stand-in answers `unavailable`). */
  transport(): AiTransport;
  /** Register a cancellable interactive run (`requestId`, Ask `runId`); returns its abort signal. */
  track(id: string): AbortSignal;
  /** Cancel one tracked run, or every tracked run when `id` is absent. */
  cancel(id?: string): boolean;
  /** Drop the finished run's entry (`finally` of every runner). */
  release(id: string): void;
}

export function createAiService(): AiService {
  let transport: AiTransport = detachedTransport();
  const live = new Map<string, AbortController>();
  return {
    useTransport: t => void (transport = t ?? detachedTransport()),
    transport: () => transport,
    track(id) {
      const controller = new AbortController();
      live.get(id)?.abort();
      live.set(id, controller);
      return controller.signal;
    },
    cancel(id) {
      let hit = false;
      for (const k of id === undefined ? [...live.keys()] : [id]) {
        const c = live.get(k);
        if (!c) continue;
        c.abort();
        live.delete(k);
        hit = true;
      }
      return hit;
    },
    release: id => void live.delete(id),
  };
}

/**
 * Seam 1: lane `eng-ai`'s module, imported by the composition root (`src/index.ts`) from this fixed path. It holds
 * the heuristic Home lanes (`lanes.ts`), consent, the AI job queue and the interactive AI path. The heavy work —
 * gate, metering, the jobs runner, Ask — is lazy-loaded from `impl/` so the neutral engine stays inside its bundle
 * budget; this file stays a thin registration.
 */
export const lane = 'eng-ai';

/** The lane's writers for its own tables (seam 2); the host passes every module's list to `openStore`. */
export const extensions: readonly CommitExtension[] = [consentExtension, aiWritesExtension];

/** The earliest queued job's `next_at`: the `jobs` deadline the timer loop sleeps on. */
function jobsSource(services: EngineServices): DeadlineSource {
  return {
    id: 'jobs',
    next: () =>
      Promise.resolve(
        services.store.read(
          q =>
            q.get<{ at: number | null }>(
              "SELECT MIN(next_at) at FROM jobs WHERE state IN ('queued','failed')",
            )?.at ?? undefined,
        ),
      ),
    async fire(now: number) {
      const { runJobs } = await import('./impl/runner');
      await runJobs(services, now);
    },
  };
}

/** Builds the lane's services once the core services exist; runs once, in the root's fixed order. */
export function createModule(services: EngineServices): LaneModule {
  const ai = createAiService();
  // A host-composed transport binds here; absent, the service stays on the detached stand-in.
  if (services.aiTransport) ai.useTransport(services.aiTransport);
  return {
    services: { ai },
    start() {
      // Stranded 'running' rows from a crash are reclaimed lazily on the first fire (impl/runner), so this stays a
      // register: nothing commits on a store that never ran jobs.
      services.deadlines.register(jobsSource(services));
    },
  };
}
