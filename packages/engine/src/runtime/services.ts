import type {
  AccountActorHost,
  BlobFiles,
  CalendarPort,
  ClientTokens,
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
  UnsubscribePort,
} from '../ports';
import type { AttachmentFiles, CommitExtension } from '../store/port';
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
/** Facts only the host knows, for `Session/get`: the build, this Mac, what the desktop can do. Plain data, injected at start. */
export interface HostFacts {
  appVersion: string;
  device: { id: string; name: string };
  /** The engine keeps running with no window (the menu-bar mode). */
  resident: boolean;
  /** Capability keys the host adds (`desktop`, `notifications`, `loginItem`, `menuBar`, `microphone`); the engine adds its own. */
  capabilities: Readonly<Record<string, boolean>>;
  /**
   * The names of provider environment variables that are set (never their values): `Ai/providers` reports
   * `keySource: 'env'` from this list without the neutral engine ever reading process.env.
   */
  envKeys?: readonly string[];
}

export interface EngineServices {
  /** The host's AI transport when one was composed (`host/ai`); absent, `services.ai` stays on its detached stand-in. */
  aiTransport?: import('../ports/ai').AiTransport;
  /** What the host says about itself; defaults to a bare build so tests need not supply it. */
  host: HostFacts;
  /** The store, wrapped so every commit that lands queues its coalesced `state` frame. */
  store: StorePort;
  /** Account actors: connect, sync requests, leases, status, and the `ProviderPort` reads. */
  accounts: AccountActorHost;
  send: SendPort;
  drafts: DraftSyncPort;
  calendar: CalendarPort;
  /**
   * Held calendar writes (`calendar/holds-core.ts`, set by the calendar module): writes that tell guests wait their undo
   * window here. Optional; absent, every calendar write is sent at once and `methods/operation.ts` asks only the mail operations.
   */
  calendarHolds?: import('../calendar/holds-types').CalendarHolds;
  rules: RulesPort;
  clock: Clock;
  /** The one timer loop's registry (`eng-time`'s `clock/module.ts`, or the host). */
  deadlines: DeadlineRegistry;
  log: Logger;
  html: MailHtml;
  laneFor: LaneFor;
  /** Injected by the host (Node networking); `Mail/serve`'s image route only. */
  images: ImageProxy;
  /** Injected by the host (Node networking); `Unsubscribe/get` and `Unsubscribe/run` only. */
  unsubscribe: UnsubscribePort;
  /** The data key that seals credentials, unwrapped by the host (`eng-host`). */
  keys: KeyProvider;
  /** Writes a granted client's token to its 0600 file (`host/transports/auth.ts`, `eng-host`). Absent: `Clients/grant` is `unavailable`. */
  clientTokens: ClientTokens;
  /** Durable blob bytes (`host/blobs.ts`, `eng-host`); only the blob runtime calls it. Absent: `Blob/*` is `unavailable`. */
  blobFiles: BlobFiles;
  /** The attachment file cache (`host/files.ts`, eng-store); `Attachment/get` and `attachment` blob handles call it. Absent: `Attachment/get` is `unavailable`. */
  attachmentFiles: AttachmentFiles;
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
  /** A connection closed (a window went away): drop what the lane holds for that `connectionId`. Must not throw. */
  onConnectionClose?(connectionId: string): void;
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
