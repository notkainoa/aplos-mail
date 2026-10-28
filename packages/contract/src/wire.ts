import * as z from 'zod/mini';
import { ContractError, ErrorBodySchema, type ErrorBody } from './errors';
import { Count, EpochMs, Id, line, openEnum, Problem, text } from './schemas/common';
import { Operation, WindowBody } from './schemas/mail';
import { ConnectMode, ConnectState } from './schemas/account';
import { Draft } from './schemas/compose';
import { NotificationItem } from './schemas/session';
import { Citation, Proposal } from './schemas/ai';

/** The contract's major version. Additive changes only within it (ARCH 9.5); a breaking change bumps `v`. */
export const apiVersion = 1;

/**
 * One RPC call per method (ARCH 9.1): `{v:1, id, method, args}` → `{id, ok:true, result}` | `{id, ok:false, error}`.
 * `id` is per connection, for multiplexing only. Over HTTP the method is the path (`POST /v1/call/<Type>/<verb>`) and
 * `args.opId`, when present, is the `Idempotency-Key`.
 */
export const CallEnvelope = z.object({
  v: z.literal(apiVersion),
  id: z.union([z.string(), z.number()]),
  method: line(100),
  args: z.unknown(),
});
export type CallEnvelope = z.infer<typeof CallEnvelope>;

export const ReplyEnvelope = z.discriminatedUnion('ok', [
  z.object({ id: z.union([z.string(), z.number()]), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.union([z.string(), z.number()]), ok: z.literal(false), error: ErrorBodySchema }),
]);
export type ReplyEnvelope = z.infer<typeof ReplyEnvelope>;

/**
 * The first frame a socket client sends (ARCH 9.4, FR-16). `token` is the client's own token from the 0600 file
 * `Clients/grant` wrote: compared in constant time against the stored hash, never logged or echoed. Over HTTP the same
 * token is the `Authorization: Bearer` header instead (README "Scopes and transports"). `client` is self-declared and
 * only labels the connection: the caller is built from the stored `Client` row the token matched (`listenerCaller`,
 * freeze R2B-3), so `client.kind` never sets `via` or lifts the MCP limit.
 */
export const Hello = z.object({
  v: z.literal(apiVersion),
  apiVersion: z.int(),
  appVersion: z.optional(line(100)),
  client: z.object({ name: line(200), kind: line(30) }),
  token: z.optional(line(128)),
});
export type Hello = z.infer<typeof Hello>;

/**
 * The listener's answer to `Hello`: the session's state and the scopes it was granted, or a refusal. `unsupported` is an
 * incompatible `apiVersion` (the message says to update); `forbidden` is a missing, unknown or revoked token. A refused
 * connection closes after this frame.
 */
export const HelloReply = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    session: z.object({
      apiVersion: z.int(),
      dbEpoch: line(100),
      clientId: Id,
      scopes: z.array(line(30)),
    }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({ type: openEnum(['unsupported', 'forbidden']), message: z.string() }),
  }),
]);
export type HelloReply = z.infer<typeof HelloReply>;

/** Turns a host-side outcome into a reply envelope. Anything that is not a `ContractError` becomes `internal` with a safe sentence. */
export function toReply(
  id: string | number,
  outcome: { result: unknown } | { error: unknown },
): ReplyEnvelope {
  if ('result' in outcome) return { id, ok: true, result: outcome.result };
  const error: ErrorBody =
    outcome.error instanceof ContractError
      ? outcome.error.body
      : { type: 'internal', message: 'Something went wrong. Try again.' };
  return { id, ok: false, error };
}

/** Unwraps a reply envelope on the client side, throwing the same `ContractError` the host threw. */
export function fromReply(reply: ReplyEnvelope): unknown {
  if (reply.ok) return reply.result;
  throw new ContractError(reply.error);
}

/** Every frame carries the change-log position it was sent at (`{dbEpoch, seq}`), so ordering survives every transport. */
const at = { dbEpoch: line(100), seq: Count };

/** The types a `state` frame reports, so screens re-read singletons and caches whose token moved. */
export const ChangeType = openEnum([
  'Session',
  'Account',
  'Folder',
  'Counts',
  'Thread',
  'Message',
  'Draft',
  'Submission',
  'Operation',
  'Event',
  'Calendar',
  'Plan',
  'Summary',
  'AiJob',
  'AiProvider',
  'Conversation',
  'Settings',
  'Setup',
  'Consent',
  'SenderRule',
  'Client',
  'Queue',
]);

/**
 * Host-channel events (plan 10 E3 item 6): main receives them on its control connection, and windows receive `parked`,
 * `appearance` and `clock`. Main adds nothing to the data path.
 */
export const HostEvent = z.discriminatedUnion('type', [
  /** New notifications are waiting: main calls `Notification/claim`, posts them and acknowledges. */
  z.object({ type: z.literal('notify'), pending: Count }),
  z.object({ type: z.literal('badge'), count: Count }),
  z.object({ type: z.literal('appearance'), theme: openEnum(['light', 'dark', 'system']) }),
  /** A reminder came due; `wasDueAt` when it fired late because the Mac slept. */
  z.object({ type: z.literal('reminder'), item: NotificationItem }),
  /** The engine parked (repeated crashes, failed migration, damaged database): "Export diagnostics / Try again". */
  z.object({
    type: z.literal('parked'),
    reasonCode: line(60),
    message: z.string(),
    canRetry: z.boolean(),
    at: EpochMs,
  }),
  /** Open a provider sign-in page in the browser; main allows only provider sign-in origins. */
  z.object({ type: z.literal('openExternal'), url: text(4_000), purpose: openEnum(['oauth']) }),
  /** The engine's clock moved by more than normal ticking (a test clock, or a wake). */
  z.object({ type: z.literal('clock'), now: EpochMs }),
]);
export type HostEvent = z.infer<typeof HostEvent>;

/**
 * Events main sends a window itself, outside the engine's change log (so they carry no `{dbEpoch, seq}`): the window's
 * own lifecycle, and the engine's reachability, which only main can report when the engine cannot answer.
 */
export const DesktopEvent = z.discriminatedUnion('type', [
  /** The user closed the window or quit: save, then `Window/closeReady`, or `Window/closeCancel` to keep it open. */
  z.object({ type: z.literal('closeRequested'), quitting: z.boolean() }),
  /** The window became visible (Electron `ready-to-show`): the onboarding window starts its entrance here. */
  z.object({ type: z.literal('shown') }),
  /** Whether this window can reach the engine; `parked` and `unreachable` show the fatal screen with Restart and Copy diagnostics. */
  z.object({
    type: z.literal('engine'),
    state: openEnum(['connecting', 'ready', 'unreachable', 'parked']),
    reasonCode: z.optional(line(60)),
    /** The plain sentence, e.g. "Your disk is full." */
    message: z.optional(z.string()),
    canRetry: z.optional(z.boolean()),
    at: EpochMs,
  }),
]);
export type DesktopEvent = z.infer<typeof DesktopEvent>;

/** Push frames on a connection's one stream (ARCH 9.2). Discriminated by `frame`. */
export const Frame = z.discriminatedUnion('frame', [
  /** Coalesced over 50-250 ms: per type, the newest `seq` that touched it. */
  z.object({ frame: z.literal('state'), ...at, types: z.record(z.string(), Count) }),
  /** A watched window's ids changed (at most 4 per second per window). Rows come from `T/get`. */
  z.object({ frame: z.literal('window'), ...at, ...WindowBody.shape }),
  /**
   * Ephemeral progress for a run (Ask, remote search, polish, transcription, setup); never logged. `kind: 'done'`
   * ends the run; the lasting result arrives as a state change (e.g. the Conversation). Ask streams `step` and `text`,
   * and `citation` and `proposal` as each becomes known, so chips and cards appear before the turn is stored.
   */
  z.object({
    frame: z.literal('progress'),
    ...at,
    runId: Id,
    source: openEnum(['ask', 'search', 'ai', 'transcribe', 'setup']),
    kind: openEnum(['step', 'text', 'citation', 'proposal', 'done', 'error', 'usage']),
    step: z.optional(
      z.object({
        id: Id,
        text: line(500),
        state: openEnum(['running', 'done', 'error']),
        count: z.optional(Count),
      }),
    ),
    /** Streamed answer text to append. */
    delta: z.optional(text(100_000)),
    turnId: z.optional(Id),
    /** With `kind: 'citation'`. */
    citation: z.optional(Citation),
    /**
     * With `kind: 'citation'`: where its chip sits, as a character offset into the answer text streamed so far (all
     * `delta`s joined, no `[n]` markers; FR-30). Absent means at the end of the text so far.
     */
    at: z.optional(Count),
    /** With `kind: 'proposal'`. */
    proposal: z.optional(Proposal),
    problem: z.optional(Problem),
  }),
  /** Windows are void (another `dbEpoch`, below the change-log floor, a restore): re-open them and re-read. */
  z.object({
    frame: z.literal('reset'),
    ...at,
    reason: openEnum(['dbEpoch', 'cannotCalculateChanges', 'restore', 'restart']),
  }),
  /** A command's operation changed state after its receipt (failed, conflict, synced). */
  z.object({ frame: z.literal('operation'), ...at, operation: Operation }),
  /**
   * An account connect, reconnect or permission grant moved on (`Account/connect` returned its `connectId`). Frozen
   * (FR-23): `accountId` is on every `reconnect` and `grantPermissions` frame from `waiting` on, and on every
   * `connected`; every frame, `cancelled` and `failed` included, carries the flow's own `mode`.
   */
  z.object({
    frame: z.literal('connect'),
    ...at,
    connectId: Id,
    mode: ConnectMode,
    state: ConnectState,
    accountId: z.optional(Id),
    reasonCode: z.optional(line(60)),
  }),
  /** A draft changed elsewhere (another window or device); `conflict` when the open copy must choose. */
  z.object({
    frame: z.literal('Draft/changed'),
    ...at,
    draftId: Id,
    revision: Count,
    conflict: z.boolean(),
    draft: z.optional(Draft),
  }),
  z.object({ frame: z.literal('host'), ...at, event: HostEvent }),
  /** From main, on the desktop half of a window's connection (`routeByHost` merges it into the one stream). */
  z.object({ frame: z.literal('desktop'), event: DesktopEvent }),
]);
export type Frame = z.infer<typeof Frame>;
export type FrameKind = Frame['frame'];
