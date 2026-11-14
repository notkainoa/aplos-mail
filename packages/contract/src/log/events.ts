import type { ClassifiedError } from '../errors';
import type { AccountState } from '../status';

/**
 * The log event catalog (plan 10 E0, ARCH 11; Phase 0 artifact F7). Every log line names one event id from here, and
 * each event lists the only fields it may carry, each with a kind the Logger enforces: a field the event does not list
 * is dropped, and only `text` fields (and an error's `providerMessage`) pass the free-text redactor. There is no field
 * for a subject, body, snippet, name, token, key or header, and no kind that could hold one.
 *
 * This module is plain data with no zod, so the engine's Logger adds no validator to the neutral bundle; the strict
 * zod/mini schema of each event is derived from the same specs in `./schema` (`logEventSchema`).
 *
 * Adding an event or an optional field is additive (round 2 adds its providers this way); renaming or retyping one
 * breaks every log reader, so don't. `emitters` names the Phase 1 lanes expected to log the event (roadmap 2.1, 2.2).
 */

/** Opaque local id: `acc_1`, a ULID. Never a provider id, address or name. */
export const logIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** A developer- or provider-chosen code: method ids, reason codes, model names. Never a URL. */
export const logCodePattern = /^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,99}$/;
/** An address field as written: the first 16 hex digits of SHA-256 over the per-install salt and the normalised address. */
export const logAddressHashPattern = /^[0-9a-f]{16}$/;
/** Longest free text written (the classified-error record's `providerMessage` limit). */
export const LOG_TEXT_MAX = 300;

/** The value each kind takes at the call site. `time` is epoch ms, `duration` milliseconds. */
export interface LogKindTypes {
  count: number;
  duration: number;
  time: number;
  bool: boolean;
  /** Opaque local id (`logIdPattern`). */
  id: string;
  /** Method id, reason code, model (`logCodePattern`). */
  code: string;
  /** One of the field's `values`. */
  enum: string;
  /** Written only as a salted hash. */
  address: string;
  /** Free text from a provider or the OS: redacted, then cut to 300 characters. */
  text: string;
  /** The classified-error record; its `providerMessage` is redacted, its `item` hashed like an address. */
  error: ClassifiedError;
}
export type LogFieldKind = keyof LogKindTypes;

export interface LogFieldSpec<K extends LogFieldKind = LogFieldKind> {
  kind: K;
  /** For `enum`: the closed list of values. */
  values?: readonly string[];
  optional?: true;
}

const spec =
  <K extends LogFieldKind>(kind: K) =>
  (): LogFieldSpec<K> => ({ kind });

/** Field constructors. */
export const logField = {
  count: spec('count'),
  duration: spec('duration'),
  time: spec('time'),
  bool: spec('bool'),
  id: spec('id'),
  code: spec('code'),
  address: spec('address'),
  text: spec('text'),
  error: spec('error'),
  oneOf: <const V extends readonly [string, ...string[]]>(
    values: V,
  ): LogFieldSpec<'enum'> & { values: V } => ({ kind: 'enum', values }),
};

/** Marks a field as optional. */
export const opt = <S extends LogFieldSpec>(s: S): S & { optional: true } => ({
  ...s,
  optional: true,
});

export const logLevels = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof logLevels)[number];

/** The Phase 1 lanes (roadmap 2.1, 2.2) and round 2's provider lanes. */
export type LogEmitter =
  | 'eng-contract'
  | 'eng-store'
  | 'eng-views'
  | 'eng-time'
  | 'eng-ai'
  | 'eng-html'
  | 'eng-host'
  | 'prov-gov'
  | 'prov-gmail'
  | 'prov-gmail-write'
  | 'prov-cal'
  | 'prov-imap'
  | 'prov-jmap'
  | 'prov-graph'
  | 'plat-release';

export interface LogEventSpec {
  level: LogLevel;
  emitters: readonly LogEmitter[];
  fields: Record<string, LogFieldSpec>;
}

const event = <const F extends Record<string, LogFieldSpec>>(
  level: LogLevel,
  emitters: readonly LogEmitter[],
  fields: F,
) => ({ level, emitters, fields });

const f = logField;

/** The account states of ARCH 6.4 (`AccountStatusSchema`'s discriminants). */
const accountStates = [
  'starting',
  'ok',
  'syncing',
  'backfilling',
  'paused',
  'needsReauth',
  'needsPermission',
  'needsAdmin',
  'misconfigured',
  'offline',
  'error',
] as const satisfies readonly AccountState[];
/** ARCH 7.1 / plan 10 E6. */
export const submissionStates = [
  'queued',
  'sending',
  'sent',
  'uncertain',
  'failed',
  'cancelled',
  'suspended',
] as const;
/** The provider families with their own sync events. Each is also a governor budget id. */
export const syncProviders = ['gmail', 'gcal', 'graph', 'imap', 'jmap', 'caldav'] as const;
export type SyncProvider = (typeof syncProviders)[number];
const syncEmitters: Record<SyncProvider, readonly LogEmitter[]> = {
  gmail: ['prov-gmail', 'prov-gmail-write'],
  gcal: ['prov-cal'],
  graph: ['prov-graph'],
  imap: ['prov-imap'],
  jmap: ['prov-jmap'],
  caldav: ['prov-cal'],
};

/**
 * The per-provider sync events: one shape, an id per provider family, so a line greps by provider and round 2 adds no
 * catalog code. Adapters log status, reason, method, units, pacer wait and pause class only (Providers port proposal).
 */
function syncEvents<P extends SyncProvider>(p: P) {
  const emitters = syncEmitters[p];
  const events = {
    /** One provider call, the verbose protocol log (ARCH 11): headers-level facts only. */
    request: event('debug', emitters, {
      method: f.code(),
      status: opt(f.count()),
      units: opt(f.count()),
      durationMs: f.duration(),
      waitMs: opt(f.duration()),
    }),
    /** The provider refused a call; `error.reason` is the provider's exact reason (E0: the 403 that explained nothing). */
    request_refused: event('warn', emitters, {
      error: f.error(),
      units: opt(f.count()),
      attempt: opt(f.count()),
      waitMs: opt(f.duration()),
    }),
    page_committed: event('info', emitters, {
      phase: f.oneOf(['first_window', 'backfill', 'incremental', 'resync']),
      threads: opt(f.count()),
      messages: opt(f.count()),
      events: opt(f.count()),
      units: opt(f.count()),
      durationMs: f.duration(),
    }),
    /** The provider invalidated our cursor (plan 20's informational `reset`). */
    cursor_reset: event('warn', emitters, {
      reset: f.oneOf([
        'cursorExpired',
        'uidValidityChanged',
        'syncTokenInvalid',
        'cannotCalculateChanges',
        'changeCapExceeded',
        'windowRolled',
      ]),
    }),
  };
  return Object.fromEntries(Object.entries(events).map(([k, v]) => [`sync.${p}.${k}`, v])) as {
    [K in keyof typeof events as `sync.${P}.${K & string}`]: (typeof events)[K];
  };
}

export const logEvents = {
  ...syncEvents('gmail'),
  ...syncEvents('gcal'),
  ...syncEvents('graph'),
  ...syncEvents('imap'),
  ...syncEvents('jmap'),
  ...syncEvents('caldav'),
  /** Rows Google sent that made no storable fact (e.g. a malformed override); ids only, never content. */
  'sync.gcal.items_dropped': event('warn', ['prov-cal'], {
    count: f.count(),
    ids: opt(f.text()),
  }),
  'sync.status_changed': event('info', ['prov-gov'], {
    from: f.oneOf(accountStates),
    to: f.oneOf(accountStates),
    class: opt(f.code()),
    reason: opt(f.code()),
  }),

  // Governor and lease (ARCH 6.2-6.5). `budget` is a BudgetId, including `ai:<provider>`.
  'governor.paused': event('warn', ['prov-gov', 'eng-ai'], {
    budget: f.code(),
    class: f.code(),
    reason: f.code(),
    pauseMs: f.duration(),
    until: opt(f.time()),
    step: opt(f.count()),
    concurrency: opt(f.bool()),
  }),
  'governor.resumed': event('info', ['prov-gov', 'eng-ai'], {
    budget: f.code(),
    pausedMs: f.duration(),
    why: f.oneOf(['timer', 'reconnect', 'wake', 'manual']),
  }),
  'governor.daily_stopped': event('warn', ['prov-gov', 'eng-ai'], {
    budget: f.code(),
    reason: f.code(),
    until: f.time(),
  }),
  'governor.target_changed': event('info', ['prov-gov'], {
    budget: f.code(),
    from: f.count(),
    to: f.count(),
    why: f.oneOf(['aimd_decrease', 'aimd_increase', 'concurrency_cap', 'quiet_reset']),
  }),
  'lease.changed': event('info', ['prov-gov'], {
    role: f.oneOf(['primary', 'secondary']),
    device: f.id(),
    why: f.oneOf(['acquired', 'lost', 'override', 'tie']),
  }),

  // Auth (ARCH 6.3-6.4, 12.5). `provider` is a BudgetId.
  'auth.reconnect_needed': event('warn', ['prov-gov', 'prov-gmail'], {
    provider: f.code(),
    reason: f.code(),
    testingExpiry: f.bool(),
  }),
  'auth.reconnected': event('info', ['prov-gov'], { provider: f.code(), resynced: f.bool() }),
  /** A reconnect signed in to a different account than the one it was for (`expectedSubject`); both only as hashes. */
  'auth.identity_mismatch': event('warn', ['prov-gov'], {
    provider: f.code(),
    expected: f.address(),
    got: f.address(),
  }),
  'auth.token_refreshed': event('debug', ['prov-gov'], {
    provider: f.code(),
    durationMs: f.duration(),
  }),
  'auth.refresh_failed': event('warn', ['prov-gov'], { error: f.error() }),

  // Sending (ARCH 7, plan 10 E6).
  'submission.state': event('info', ['eng-time'], {
    submission: f.id(),
    from: f.oneOf(submissionStates),
    to: f.oneOf(submissionStates),
    why: opt(f.code()),
  }),
  'send.sent': event('info', ['prov-gmail-write', 'eng-time'], {
    submission: f.id(),
    durationMs: f.duration(),
    recipients: f.count(),
    attachments: f.count(),
    bytes: f.count(),
  }),
  'send.uncertain': event('warn', ['prov-gmail-write', 'eng-time'], {
    submission: f.id(),
    method: f.code(),
    durationMs: f.duration(),
    error: opt(f.error()),
  }),
  'send.failed': event('warn', ['prov-gmail-write', 'eng-time'], {
    submission: f.id(),
    error: f.error(),
  }),
  'send.reconciled': event('info', ['eng-time'], {
    submission: f.id(),
    found: f.bool(),
    method: f.code(),
  }),
  'outbox.suspended': event('info', ['eng-time'], { submission: f.id(), lateMs: f.duration() }),
  'draft.sync_failed': event('warn', ['prov-gmail-write', 'eng-time'], {
    draft: f.id(),
    error: f.error(),
  }),
  'timer.fired': event('debug', ['eng-time'], {
    kind: f.oneOf(['send', 'later', 'reminder', 'snooze', 'deadline']),
    lateMs: f.duration(),
  }),
  'notification.posted': event('debug', ['eng-time'], {
    kind: f.oneOf(['mail', 'reminder', 'send_failed', 'reconnect']),
  }),

  // AI (ARCH 8, plan 10 E5). `model` is the provider's model id.
  'ai.job.done': event('debug', ['eng-ai'], {
    job: f.id(),
    feature: f.oneOf(['ask', 'summaries', 'drafts', 'plans', 'voice', 'triage']),
    provider: f.code(),
    model: f.code(),
    tokensIn: opt(f.count()),
    tokensOut: opt(f.count()),
    durationMs: f.duration(),
  }),
  'ai.job.failed': event('warn', ['eng-ai'], {
    job: f.id(),
    feature: f.oneOf(['ask', 'summaries', 'drafts', 'plans', 'voice', 'triage']),
    provider: f.code(),
    model: f.code(),
    error: f.error(),
  }),
  'ai.budget_exhausted': event('info', ['eng-ai'], { used: f.count(), limit: f.count() }),
  // The Setup/end backfill or the ingest enqueue failed inside its own catch — without it no summary job is
  // ever queued and nothing else says why.
  'ai.backfill_failed': event('warn', ['eng-ai'], { detail: f.text() }),

  // Store (ARCH 3, plan 10 E2).
  'store.opened': event('info', ['eng-store'], {
    schema: f.count(),
    durationMs: f.duration(),
    bytes: opt(f.count()),
    walBytes: opt(f.count()),
  }),
  'store.migrated': event('info', ['eng-store'], {
    from: f.count(),
    to: f.count(),
    durationMs: f.duration(),
  }),
  'store.import_done': event('info', ['eng-store'], {
    threads: f.count(),
    messages: f.count(),
    skipped: f.count(),
    durationMs: f.duration(),
  }),
  'store.integrity_failed': event('error', ['eng-store'], {
    check: f.oneOf(['quick', 'full']),
    reason: f.code(),
  }),
  'store.disk_full': event('error', ['eng-store'], { freeBytes: opt(f.count()) }),

  // Methods, views and operations (ARCH 9, plan 10 E1, E3). `method` is a contract method name.
  'rpc.invalid_input': event('warn', ['eng-contract'], { method: f.code(), issues: f.count() }),
  'rpc.failed': event('warn', ['eng-contract'], { method: f.code(), reason: f.code() }),
  'rpc.slow': event('info', ['eng-contract'], { method: f.code(), durationMs: f.duration() }),
  'view.window_slow': event('info', ['eng-views'], {
    view: f.code(),
    rows: f.count(),
    durationMs: f.duration(),
  }),
  'view.window_failed': event('warn', ['eng-views'], { kind: f.code(), type: f.code() }),
  'operation.failed': event('warn', ['eng-views'], {
    op: f.id(),
    kind: f.code(),
    error: opt(f.error()),
  }),
  'operation.undone': event('debug', ['eng-views'], { op: f.id(), kind: f.code() }),

  // HTML isolation (ARCH 10, plan 10 E4).
  'html.sanitized': event('debug', ['eng-html'], {
    removed: f.count(),
    bytesIn: f.count(),
    bytesOut: f.count(),
    durationMs: f.duration(),
  }),
  'html.blocked': event('info', ['eng-html'], {
    what: f.oneOf(['remote_image', 'script', 'frame', 'form', 'navigation', 'style']),
    count: f.count(),
  }),
  'proxy.image_failed': event('debug', ['eng-html'], { status: opt(f.count()), reason: f.code() }),

  // Engine host, resident mode, listener (ARCH 2, 11, 12.3; plan 10 E1, E7).
  'engine.started': event('info', ['eng-host'], {
    version: f.code(),
    mode: f.oneOf(['window', 'resident', 'test', 'selftest']),
    durationMs: f.duration(),
  }),
  'engine.stopping': event('info', ['eng-host'], {
    why: f.oneOf(['quit', 'update', 'restart', 'crash_guard']),
  }),
  'engine.parked': event('error', ['eng-host', 'eng-store'], {
    why: f.oneOf(['disk_full', 'corrupt', 'crash_loop', 'migration_failed', 'selftest_failed']),
    exits: opt(f.count()),
  }),
  'engine.watchdog': event('warn', ['eng-host', 'eng-time'], {
    kind: f.oneOf(['event_loop', 'actor_stalled', 'timer_drift']),
    lagMs: f.duration(),
    /** `timer_drift`: the deadline source's kind (`outbox`, `sync`, ...), never its account part. */
    source: opt(f.code()),
  }),
  'power.changed': event('info', ['eng-host'], {
    state: f.oneOf(['sleep', 'wake', 'lock', 'unlock', 'battery', 'ac']),
  }),
  'crash.recorded': event('error', ['eng-host'], {
    process: f.oneOf(['engine', 'main', 'renderer', 'gpu', 'utility']),
    why: f.code(),
  }),
  'listener.request_denied': event('warn', ['eng-host'], {
    transport: f.oneOf(['socket', 'http', 'port', 'mcp']),
    why: f.oneOf([
      'no_token',
      'bad_token',
      'bad_host',
      'bad_origin',
      'scope',
      'revoked',
      'unknown_method',
      'rate',
    ]),
    method: opt(f.code()),
    client: opt(f.id()),
  }),
  'listener.client_changed': event('info', ['eng-host'], {
    client: f.id(),
    change: f.oneOf(['paired', 'revoked', 'scopes']),
  }),
  'client.token_remove_failed': event('warn', ['eng-host'], {
    client: f.id(),
    error: f.code(),
  }),

  // Updates (plan 40).
  'update.checked': event('info', ['plat-release'], {
    available: f.bool(),
    version: opt(f.code()),
  }),
  'update.ready': event('info', ['plat-release'], { version: f.code() }),
  'update.failed': event('warn', ['plat-release'], { reason: f.code(), detail: opt(f.text()) }),

  /** Written by a log sink itself once it can write again, or for a line it refused (F7). */
  'log.lines_dropped': event('warn', ['eng-contract'], {
    lines: f.count(),
    why: f.oneOf(['disk', 'oversize']),
  }),
} satisfies Record<string, LogEventSpec>;

export type LogEvents = typeof logEvents;
export type LogEventId = keyof LogEvents;

type FieldsOf<Id extends LogEventId> = LogEvents[Id]['fields'];
type ValueOf<S> = S extends { kind: 'enum'; values: readonly (infer V)[] }
  ? V
  : S extends { kind: infer K extends LogFieldKind }
    ? LogKindTypes[K]
    : never;
type RequiredKeys<F> = { [K in keyof F]: F[K] extends { optional: true } ? never : K }[keyof F];

/** The fields `Logger.event(id, fields)` accepts for `id`: an unlisted key is a type error and is dropped at runtime. */
export type LogFields<Id extends LogEventId> = {
  [K in RequiredKeys<FieldsOf<Id>>]: ValueOf<FieldsOf<Id>[K]>;
} & { [K in Exclude<keyof FieldsOf<Id>, RequiredKeys<FieldsOf<Id>>>]?: ValueOf<FieldsOf<Id>[K]> };

/** The governor lanes (ARCH 4.1; `Lane` in the ports). */
export const logLanes = [
  'interactive',
  'opFlush',
  'incremental',
  'prefetch',
  'backfill',
  'enrichment',
] as const;

/** Context a child logger stamps on its lines (`Logger.with`): opaque ids only. */
export interface LogContext {
  account?: string;
  /** The governor lane; open, because the ports own that list. */
  lane?: (typeof logLanes)[number] | (string & {});
}

/** One line of the log, as a sink receives it and writes it (JSON, one per line). */
export interface LogRecord extends LogContext {
  /** Epoch ms. */
  t: number;
  level: LogLevel;
  event: string;
  data: Record<string, unknown>;
  /** Fields the Logger refused on this line: unlisted, or not of their kind. Their names are not written. */
  dropped?: number;
}
