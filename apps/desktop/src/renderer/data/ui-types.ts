/**
 * The data surface's own types: vocabulary the UI needs that is not a wire type.
 *
 * Nothing here travels on the wire, and none of it duplicates a contract shape. Each type is either the UI's name for a
 * set of values the contract documents but does not type (Home's section keys), a selection over contract types (the
 * specs whose rows are threads, the row cache map), or renderer-only state (the overlay's lifecycle, the streams
 * `useFrames` serves). Wire types are in `./contract-shapes.ts`.
 */
import type {
  Account,
  ClockEvent,
  ConnectFrame,
  Conversation,
  Draft,
  Event,
  Message,
  Operation,
  Plan,
  ProgressFrame,
  SenderGroup,
  Submission,
  ThreadRow,
  ThreadSelector,
  ViewSpec,
} from './contract-shapes';

/**
 * The known values of a contract open enum (`'a' | 'b' | (string & {})` → `'a' | 'b'`): the closed set a screen can
 * switch over. A value a newer engine adds is not in it, so the caller maps it to a safe default.
 */
export type KnownValues<T> = T extends string ? (string extends T ? never : T) : never;

/** One view spec by kind, e.g. `ViewSpecOf<'events'>` is `{kind: 'events', from, to, calendarIds?, ...}`. */
export type ViewSpecOf<K extends ViewSpec['kind']> = Extract<ViewSpec, { kind: K }>;

/** The specs whose rows are thread rows: every list a thread action or a selector can target. The engine refuses a selector over any other kind at runtime; this type refuses it at compile time. */
export type ThreadListSpec = ViewSpecOf<
  | 'home'
  | 'homeSection'
  | 'oneByOne'
  | 'mailbox'
  | 'label'
  | 'later'
  | 'bookmarks'
  | 'replyState'
  | 'done'
  | 'search'
>;

/** A `ThreadSelector` narrowed to thread-row specs; still a contract `ThreadSelector`. */
export type ThreadListSelector = Omit<ThreadSelector, 'spec'> & { readonly spec: ThreadListSpec };

/** The sections `useHome` renders as lists, in display order (DESIGN 7.2). Low importance is the band, not a list. */
export type HomeSection = 'do' | 'update' | 'follow';

/** Section keys of the `home` window, in the contract's documented order (`WindowSection` comment). `fromLater` is Back from Later at the bottom of Do now; `low` is the count-only band. A newer engine may add keys: ignore unknown ones. */
export type HomeSectionKey = 'do' | 'fromLater' | 'update' | 'low' | 'follow';

/** Section keys of the `later` window, in order (DESIGN 7.3; `WindowSection` comment). */
export type LaterSectionKey = 'overdue' | 'today' | 'week' | 'someday';

/**
 * Rows the renderer caches, by contract type name: every window row type, plus accounts and operations, which
 * `useRow` reads through `Account/get` and `Operation/get`.
 */
export interface RowTypeMap {
  Thread: ThreadRow;
  Message: Message;
  Draft: Draft;
  Submission: Submission;
  Event: Event;
  Plan: Plan;
  Conversation: Conversation;
  SenderGroup: SenderGroup;
  Account: Account;
  Operation: Operation;
}

/** A cacheable row type name. The contract's `RowType` is open (a newer engine may add one); this is the closed set this renderer caches. */
export type CachedRowType = keyof RowTypeMap;

/** An optimistic operation as screens see it: `pending` until the receipt, `confirmed` after it, `failed` on rejection (after the overlay rolled back). Provider-side progress is `Operation['state']`. */
export type OperationState = 'pending' | 'confirmed' | 'failed';

/**
 * The streams `useFrames` serves, by name. `progress` and `connect` are the contract frames of those names; `clock`
 * is the `host` frame's clock event, unwrapped. First sync has no stream: `useSetupStatus` re-reads `Setup/status` on
 * a `state` frame. Window, state and reset frames are the data layer's own business and never reach screens.
 */
export interface StreamFrameMap {
  /** Streamed run progress (Ask, remote search, polish, transcription, setup steps). */
  progress: ProgressFrame;
  /** Account connect, reconnect and grant flows. */
  connect: ConnectFrame;
  /** The engine's clock jumps. */
  clock: ClockEvent;
}

/** A stream `useFrames` accepts. */
export type StreamKind = keyof StreamFrameMap;
