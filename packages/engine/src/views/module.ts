import type { CommitExtension } from '../store/port';
import type { EngineServices, LaneModule } from '../runtime/services';
import { createThreadOps, type ThreadOps } from './commands';
import { createJournal } from './ops';
import { createSenderOps, type SenderOps } from './sender-ops';
import { senderRuleExtension } from './senders';
import { createViewEngine, type ViewEngine } from './windows';

declare module '../runtime/services' {
  interface EngineServices {
    /** The live windows (views-2): `View/*`, `Folder/get`, `Counts/get`, `SenderGroup/get`. */
    views: ViewEngine;
    /** The commands (views-3): `Thread/act`, `Operation/undo|retry|get`. */
    threadOps: ThreadOps;
    /** The sender rules (views-4): `SenderRule/*`. */
    senders: SenderOps;
  }
}

/**
 * Seam 1: lane `eng-views`'s module, imported by the composition root (`src/index.ts`) from this fixed path. It holds
 * the live windows (`ViewEngine`) and the commands (`ThreadOps`); and the sender rules (`SenderRule/*`, plus the ingest hook that applies them to new mail).
 */
export const lane = 'eng-views';

/** The lane's writers for its own tables (seam 2); the host passes every module's list to `openStore`. */
export const extensions: readonly CommitExtension[] = [senderRuleExtension];

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
  const deps = {
    store: services.store,
    clock: services.clock,
    frames: services.frames,
    accounts: () => services.accounts,
    zone: views.zone,
    deadlines: services.deadlines,
  };
  // One journal, so a sender-rule commit is undone by `Operation/undo` like a `Thread/act`.
  const journal = createJournal();
  const threadOps = createThreadOps(deps, journal);
  const senders = createSenderOps({ ...deps, journal });
  const stopped = new AbortController();
  return {
    services: { views, threadOps, senders },
    // The search indexer is a lazy module (`store/fts-indexer`): loading it installs the row builder every commit
    // calls, then the backlog pass indexes mail stored before it existed, a batch per commit in the background.
    start: async () => {
      try {
        const fts = await import('../store/fts-indexer');
        void fts.indexBacklog(services, stopped.signal);
      } catch {
        services.log.event('rpc.failed', { method: 'Search/index', reason: 'load' });
      }
    },
    stop: () => {
      stopped.abort();
      views.close();
    },
  };
}
