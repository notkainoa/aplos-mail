import * as z from 'zod/mini';
import { ClassifiedErrorSchema } from '../errors';
import { ReasonCodeSchema } from '../status';
import { Count, DurationMs, EpochMs, Id, line, openEnum, State } from './common';
import { AiProviderId } from './ai';

/**
 * Named feature flags, so a screen can say "Not available yet" instead of failing (plan 30 section 8.1 item 9). The map
 * is open: an absent key means unavailable, and a newer engine may add keys.
 */
export const capabilityKeys = [
  'desktop',
  'mailFrame',
  'listener',
  'clients',
  'mcp',
  'diagnostics',
  'queueInspector',
  'calendar',
  'calendarWrite',
  'remoteSearch',
  'transcribe',
  'microphone',
  'notifications',
  'loginItem',
  'menuBar',
  'workflowSync',
  'unsubscribeOneClick',
  'eventFollowingScope',
] as const;

/** `Session/get` (ARCH 9.5): the handshake facts every window reads first. */
export const Session = z.object({
  apiVersion: z.int(),
  appVersion: line(100),
  schemaVersion: z.int(),
  dbEpoch: line(100),
  state: State,
  /** `starting` until migrations or the import finish; `parked` after repeated crashes or a damaged database (ARCH 2.4). */
  engine: z.object({
    state: openEnum(['starting', 'ready', 'parked']),
    parked: z.optional(
      z.object({ reasonCode: line(60), message: z.string(), at: EpochMs, canRetry: z.boolean() }),
    ),
    /** The engine keeps running with no window (resident menu-bar mode, ARCH 2.2). */
    resident: z.boolean(),
  }),
  capabilities: z.record(line(60), z.boolean()),
  /** Which account kinds this build can connect, and why not when it cannot (today's `capabilities.get`). */
  providers: z.array(
    z.object({ kind: line(30), available: z.boolean(), unavailableReason: z.optional(z.string()) }),
  ),
  /** Any account exists, demo accounts included, so main chooses the onboarding or the mail window. */
  hasAccounts: z.boolean(),
  /** First-run facts: onboarding opens only when neither is set, so "Skip setup" with zero accounts does not reopen it forever. */
  setup: z.object({ completedAt: z.optional(EpochMs), skippedAt: z.optional(EpochMs) }),
  /** The engine's clock, which follows `APLOS_NOW` under test; the renderer's `useNow()` starts from it. */
  now: EpochMs,
  device: z.object({ id: line(200), name: line(200) }),
});
export type Session = z.infer<typeof Session>;

/**
 * `Setup/status`, per account, exactly as plan 10 section 4.1 states, plus the ids and done flag the onboarding needs.
 * `firstWindow.total` is the first-window target (about 50 threads), never the mailbox size; `found` is an estimate,
 * present only when the provider gives one; `ai` appears only with stored consent and a provider; `backfill` never gates
 * anything; `reconnectBy` is the Testing-mode expiry (grant + 7 days) for Google accounts.
 */
export const SetupAccount = z.object({
  accountId: Id,
  state: openEnum([
    'connecting',
    'finding',
    'reading',
    'sorting',
    'ready',
    'paused',
    'failed',
    'notConnected',
  ]),
  firstWindow: z.object({
    found: z.optional(Count),
    read: Count,
    total: Count,
    /** The first window is committed (`baselineDoneAt` set), even when it held fewer than `total` threads. */
    done: z.boolean(),
  }),
  ai: z.optional(
    z.object({
      sorted: Count,
      total: Count,
      capped: Count,
      failed: Count,
      model: z.optional(z.object({ provider: AiProviderId, model: line(200) })),
      reasonCode: z.optional(ReasonCodeSchema),
    }),
  ),
  backfill: z.object({ read: Count, target: Count }),
  pausedUntil: z.optional(EpochMs),
  reconnectBy: z.optional(EpochMs),
  /** The copy key for the row's current problem; absent when nothing is wrong. */
  reasonCode: z.optional(ReasonCodeSchema),
  /** Counters are monotonic within one run. */
  runId: Id,
});

export const SetupStatus = z.object({
  setupId: z.optional(Id),
  accounts: z.array(SetupAccount),
  /** Every account's first window is in and no AI pass is running. */
  done: z.boolean(),
  /** Something was paused, failed or capped: "Done" says "partly done" and Aplos does not open by itself (DESIGN 7.12). */
  partial: z.boolean(),
  errors: z.array(
    z.object({
      accountId: z.optional(Id),
      phase: openEnum(['connect', 'firstWindow', 'ai', 'backfill']),
      reasonCode: ReasonCodeSchema,
      at: EpochMs,
    }),
  ),
});
export type SetupStatus = z.infer<typeof SetupStatus>;

/** A block, lane or skip-Inbox rule for a sender, mirrored to Gmail filters or Graph rules where possible. */
export const SenderRule = z.object({
  id: Id,
  rev: Count,
  accountId: z.optional(Id),
  /** A full address or `@domain`. */
  match: line(320),
  action: openEnum(['block', 'lane', 'skipInbox']),
  lane: z.optional(openEnum(['do', 'update', 'low'])),
  /** The rule also lives at the provider, so it acts while the Mac sleeps. */
  atProvider: z.boolean(),
  createdAt: EpochMs,
});
export type SenderRule = z.infer<typeof SenderRule>;

/**
 * Local-listener scopes (ARCH 12.3): `read`, `draft`, `send` and `admin`, plus `triage` (reversible mailbox changes) and
 * `ai` (spends the AI budget and sends mail text to a provider), which fit none of the four without over-granting.
 * `host` methods are only for main's own control connection and are never granted.
 */
export const scopes = ['read', 'triage', 'draft', 'send', 'ai', 'admin', 'host'] as const;
export type Scope = (typeof scopes)[number];
export const GrantableScope = z.enum(['read', 'triage', 'draft', 'send', 'ai', 'admin'], {
  error: 'Invalid option.',
});

/** A tool on this Mac allowed through the listener. Its token lives only as a hash in the engine and in a 0600 file. */
export const Client = z.object({
  id: Id,
  name: line(200),
  kind: openEnum(['cli', 'mcp', 'preview', 'phone']),
  scopes: z.array(openEnum(scopes)),
  createdAt: EpochMs,
  lastSeenAt: z.optional(EpochMs),
  revokedAt: z.optional(EpochMs),
  /** Where the host wrote the token for this client to read; the token never crosses the contract. */
  tokenPath: z.optional(line(1_000)),
});
export type Client = z.infer<typeof Client>;

export const AuditEntry = z.object({
  id: Id,
  at: EpochMs,
  clientId: Id,
  method: line(100),
  target: z.optional(line(1_000)),
});

export const ListenerState = z.object({
  enabled: z.boolean(),
  socketPath: z.optional(line(1_000)),
  port: z.optional(z.int()),
});

/** A row of the queue inspector: an op, an AI job or a submission, with Retry and Discard (ARCH 11). */
export const QueueItem = z.object({
  id: Id,
  kind: openEnum(['op', 'job', 'submission']),
  /** A content-free label, e.g. "Archive 3 threads" or "Summary". */
  label: line(200),
  accountId: z.optional(Id),
  state: line(40),
  attempts: Count,
  nextAt: z.optional(EpochMs),
  createdAt: EpochMs,
  problem: z.optional(z.object({ reasonCode: line(60), message: z.optional(z.string()) })),
  canRetry: z.boolean(),
  canDiscard: z.boolean(),
});
export type QueueItem = z.infer<typeof QueueItem>;

/**
 * The diagnostics bundle (ARCH 11): content-free by construction. Nothing enters it except through this schema, so no
 * subject, body, snippet, token or plain address can (addresses appear only as salted hashes). Previewed before saving.
 */
export const DiagnosticsBundle = z.object({
  generatedAt: EpochMs,
  versions: z.object({
    app: line(100),
    api: z.int(),
    schema: z.int(),
    os: z.optional(line(100)),
    electron: z.optional(line(100)),
    sqlite: z.optional(line(40)),
  }),
  engine: z.object({
    state: line(40),
    uptimeMs: DurationMs,
    eventLoopP99Ms: z.optional(z.number()),
    parkedReason: z.optional(line(60)),
  }),
  accounts: z.array(
    z.object({
      accountHash: line(64),
      provider: line(30),
      state: line(40),
      reasonCode: z.optional(line(60)),
      cursorAgeMs: z.optional(DurationMs),
      lastSyncAt: z.optional(EpochMs),
      reconnectBy: z.optional(EpochMs),
      budgets: z.array(
        z.object({
          budget: line(60),
          target: z.optional(z.number()),
          unitsPerMinute: z.optional(z.number()),
          cooldownUntil: z.optional(EpochMs),
          dailyBlockUntil: z.optional(EpochMs),
        }),
      ),
    }),
  ),
  queues: z.object({ ops: Count, jobs: Count, submissions: Count, failed: Count }),
  /** Recent classified errors; `providerMessage` is already redacted by the Logger. */
  errors: z.array(z.object({ at: EpochMs, error: ClassifiedErrorSchema })),
  storage: z.object({
    dbBytes: Count,
    walBytes: Count,
    ftsBacklog: Count,
    bodyBytes: Count,
    attachmentBytes: Count,
  }),
  crashes: z.object({ count: Count, lastAt: z.optional(EpochMs) }),
});
export type DiagnosticsBundle = z.infer<typeof DiagnosticsBundle>;

/** A notification main posts for the engine (ARCH 7.6): durable, claimed once, never duplicated by a crash. */
export const NotificationItem = z.object({
  id: Id,
  kind: openEnum(['mail', 'reminder', 'later', 'send']),
  accountId: z.optional(Id),
  threadId: z.optional(Id),
  title: line(500),
  body: z.optional(line(1_000)),
  at: EpochMs,
  /** A reminder or Later item that fired late: "was due 9:00" (ARCH 7.5). */
  wasDueAt: z.optional(EpochMs),
});
export type NotificationItem = z.infer<typeof NotificationItem>;
