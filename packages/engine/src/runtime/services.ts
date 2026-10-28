import type {
  AccountActorHost,
  CalendarPort,
  Clock,
  DeadlineRegistry,
  DraftSyncPort,
  ImageProxy,
  KeyProvider,
  LaneFor,
  Logger,
  MailHtml,
  RulesPort,
  SendPort,
  StorePort,
} from '../ports';
import type { CommitExtension } from '../store/port';
import type { FrameBus } from './frames';

/**
 * The engine's services (seam 1), built once by `createEngine` and handed to every call: the only way a handler reaches
 * a port. Lanes call these and never construct their own. A lane adds its own service from its `module.ts` by
 * declaration merging, so no lane edits this file:
 *
 *   declare module '../runtime/services' { interface EngineServices { views: ViewEngine } }
 *
 * Ports the host has not injected yet (Providers' actors before `prov-gov` lands) are present as stand-ins that reject
 * every call with `unavailable`, so a handler never needs an `undefined` check.
 */
export interface EngineServices {
  /** The store, wrapped so every commit that lands queues its coalesced `state` frame. */
  store: StorePort;
  /** Account actors: connect, sync requests, leases, status, and the `ProviderPort` reads. */
  accounts: AccountActorHost;
  send: SendPort;
  drafts: DraftSyncPort;
  calendar: CalendarPort;
  rules: RulesPort;
  clock: Clock;
  /** The one timer loop's registry (`eng-time`'s `clock/module.ts`, or the host). */
  deadlines: DeadlineRegistry;
  log: Logger;
  html: MailHtml;
  laneFor: LaneFor;
  /** Injected by the host (Node networking); `Mail/serve`'s image route only. */
  images: ImageProxy;
  /** The data key that seals credentials, unwrapped by the host (`eng-host`). */
  keys: KeyProvider;
  /** Frames out to connections, stamped with `{dbEpoch, seq}`. */
  frames: FrameBus;
  /** Cryptographic randomness (Web Crypto by default; a phone host may supply its own). */
  randomBytes(n: number): Uint8Array;
}

/** What one lane's `module.ts` hands the composition root once the core services exist. */
export interface LaneModule {
  /** The lane's own `EngineServices` fields. A field the host injected or another lane set is refused at start. */
  services?: Partial<EngineServices>;
  /** After every module is created: register deadline sources, start loops. */
  start?(): void | Promise<void>;
  /** On `Engine.close`, in reverse order. */
  stop?(): void | Promise<void>;
}

/**
 * The shape of every lane `module.ts` (seam 1): `extensions` go to `openStore` (seam 2) before the engine is built, and
 * `createModule` runs once, in the root's fixed order, seeing every service built before it.
 */
export interface LaneModuleSource {
  lane: string;
  extensions: readonly CommitExtension[];
  createModule(services: EngineServices): LaneModule;
}
