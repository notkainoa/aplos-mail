import type { ClassifiedError } from '@aplos/contract';
// The zod-free half of the catalog: the Logger enforces each kind itself, so logging pulls no validator into the bundle.
import { logEvents, logLevels } from '@aplos/contract/log/events';
import type {
  LogContext,
  LogEventId,
  LogFieldSpec,
  LogFields,
  LogLevel,
  LogRecord,
} from '@aplos/contract/log/events';
import { cleanCode, cleanId, cleanScope, hashAddress, redactText } from './redact';

/**
 * The Logger port (plan 10 E0, ARCH 11; Phase 0 artifact F7). Every log line is one catalog event, and the root logger
 * redacts by allowlist: a field the event does not list is dropped and counted, each listed field must pass its kind,
 * addresses are written as salted hashes and only free-text positions pass the text redactor. Neutral code: the host
 * supplies the sink (JSON lines on disk), the per-install salt and the clock. Logging never throws.
 */
export interface Logger {
  event<Id extends LogEventId>(id: Id, fields: LogFields<Id>): void;
  /** A child whose lines carry `context` (merged over this logger's). */
  with(context: LogContext): Logger;
  /** False when `level` is below the logger's minimum, so a call site can skip building costly fields. */
  enabled(level: LogLevel): boolean;
}

/** Where finished lines go. Must not throw; the Logger catches it anyway and counts a failure. */
export interface LogSink {
  write(record: LogRecord): void;
}

export interface LoggerStats {
  lines: number;
  /** Fields refused: unlisted, of the wrong kind, or unreadable (a throwing getter). */
  droppedFields: number;
  /** Calls that wrote nothing: an unknown event id, an unreadable fields object, or a sink that threw. */
  failures: number;
}

export interface RootLogger extends Logger {
  stats(): LoggerStats;
}

export interface LoggerOptions {
  sink: LogSink;
  /** Per-install salt (kept in the store's `meta`); without it address hashes could be reversed by a dictionary. */
  salt: string;
  clock: { now(): number };
  /**
   * Minimum level written; `info` by default. The verbose protocol log turns on `debug`: pass a thunk read per
   * event so `Diagnostics/verbose` (its 15 minutes live in `meta.verbose_until`) takes effect without a restart.
   * A thunk answer that is not a level reads as `info`.
   */
  level?: LogLevel | (() => LogLevel);
}

const rank = (level: LogLevel) => logLevels.indexOf(level);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const nonNegative = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Reads an own property without letting a getter or proxy trap throw into the caller. */
function read(
  source: Record<string, unknown>,
  key: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return {
      ok: true,
      value: Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined,
    };
  } catch {
    return { ok: false };
  }
}

function ownKeys(source: Record<string, unknown>): string[] {
  try {
    return Object.keys(source);
  } catch {
    return [];
  }
}

/** The missingScopes list: at most 20 kept ids; refused (so `drop` runs) when any given one was unreadable. */
function cleanMissingScopes(scopes: unknown[], drop: () => void): string[] {
  const clean = scopes
    .slice(0, 20)
    .map(cleanScope)
    .filter((s): s is string => s !== undefined);
  if (clean.length < Math.min(scopes.length, 20)) drop();
  return clean;
}

/** Each named field through its check; a present-but-wrong value is refused. */
function setChecked<Out extends Record<string, unknown>>(
  get: (key: string) => unknown,
  keys: readonly string[],
  accepts: (value: unknown) => boolean,
  out: Out,
  drop: () => void,
) {
  for (const key of keys) {
    const value = get(key);
    if (accepts(value)) (out as Record<string, unknown>)[key] = value;
    else if (value !== undefined) drop();
  }
}

/** The ClassifiedError keys the Logger reads, each with its treatment. Anything else on the object (a `cause`, a `stack`, a body) is never read. */
function cleanError(value: unknown, salt: string, drop: () => void): ClassifiedError | undefined {
  if (!isObject(value)) return undefined;
  const get = (key: string) => {
    const r = read(value, key);
    if (!r.ok) drop();
    return r.ok ? r.value : undefined;
  };
  const code = (key: string) => {
    const raw = get(key);
    if (raw === undefined) return undefined;
    const clean = cleanCode(raw);
    if (clean === undefined) drop();
    return clean;
  };
  const known = new Set([
    'class',
    'provider',
    'method',
    'reason',
    'status',
    'code',
    'retryAfterMs',
    'resumeAt',
    'concurrency',
    'uncertain',
    'missingScopes',
    'item',
    'providerMessage',
  ]);
  for (const key of ownKeys(value)) if (!known.has(key)) drop();

  const out: ClassifiedError = {
    class: code('class') ?? 'unknown',
    provider: code('provider') ?? 'unknown',
    method: code('method') ?? 'unknown',
    reason: code('reason') ?? 'unknown',
  };
  const status = get('status');
  if (Number.isInteger(status) && (status as number) >= 0 && (status as number) < 1000)
    out.status = status as number;
  else if (status !== undefined) drop();
  const providerCode = code('code');
  if (providerCode !== undefined) out.code = providerCode;
  setChecked(get, ['retryAfterMs', 'resumeAt'] as const, nonNegative, out, drop);
  setChecked(get, ['concurrency', 'uncertain'] as const, b => typeof b === 'boolean', out, drop);
  const scopes = get('missingScopes');
  if (Array.isArray(scopes)) out.missingScopes = cleanMissingScopes(scopes, drop);
  else if (scopes !== undefined) drop();
  // A remote item id is the provider's, not ours: hashed like an address so lines still correlate.
  const item = get('item');
  if (typeof item === 'string' && item.length <= 512) out.item = hashAddress(salt, item);
  else if (item !== undefined) drop();
  const message = get('providerMessage');
  if (typeof message === 'string') out.providerMessage = redactText(message, salt);
  else if (message !== undefined) drop();
  return out;
}

/** One field through its kind's treatment; undefined means refused. */
function cleanField(spec: LogFieldSpec, value: unknown, salt: string, drop: () => void): unknown {
  switch (spec.kind) {
    case 'count':
      return Number.isSafeInteger(value) && (value as number) >= 0 ? value : undefined;
    case 'duration':
    case 'time':
      return nonNegative(value) ? value : undefined;
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
    case 'id':
      return cleanId(value);
    case 'code':
      return cleanCode(value);
    case 'enum':
      return typeof value === 'string' && spec.values?.includes(value) ? value : undefined;
    case 'address':
      return typeof value === 'string' && value.length <= 512
        ? hashAddress(salt, value)
        : undefined;
    case 'text':
      return typeof value === 'string' ? redactText(value, salt) : undefined;
    case 'error':
      return cleanError(value, salt, drop);
  }
}

function cleanContext(context: unknown): LogContext {
  const out: LogContext = {};
  if (!isObject(context)) return out;
  for (const key of ['account', 'lane'] as const) {
    const raw = read(context, key);
    const clean = raw.ok ? cleanId(raw.value) : undefined;
    if (clean) out[key] = clean;
  }
  return out;
}

export function createLogger({ sink, salt, clock, level = 'info' }: LoggerOptions): RootLogger {
  const stats: LoggerStats = { lines: 0, droppedFields: 0, failures: 0 };
  const min = () => {
    const at = rank(typeof level === 'function' ? level() : level);
    return at < 0 ? rank('info') : at;
  };
  const events: Record<string, { level: LogLevel; fields: Record<string, LogFieldSpec> }> =
    logEvents;

  function write(context: LogContext, id: string, fields: unknown) {
    try {
      const spec = Object.prototype.hasOwnProperty.call(events, id) ? events[id] : undefined;
      if (!spec || !isObject(fields)) {
        stats.failures++;
        return;
      }
      if (rank(spec.level) < min()) return;
      let dropped = 0;
      const drop = () => {
        dropped++;
      };
      const data: Record<string, unknown> = {};
      for (const key of ownKeys(fields))
        if (!Object.prototype.hasOwnProperty.call(spec.fields, key)) drop();
      for (const [key, fieldSpec] of Object.entries(spec.fields)) {
        const raw = read(fields, key);
        if (!raw.ok) {
          drop();
          continue;
        }
        if (raw.value === undefined) continue;
        const clean = cleanField(fieldSpec, raw.value, salt, drop);
        if (clean !== undefined) data[key] = clean;
        else drop();
      }
      const record: LogRecord = { t: clock.now(), level: spec.level, event: id, ...context, data };
      if (dropped) {
        record.dropped = dropped;
        stats.droppedFields += dropped;
      }
      sink.write(record);
      stats.lines++;
    } catch {
      stats.failures++;
    }
  }

  function make(context: LogContext): Logger {
    return {
      event: (id, fields) => write(context, id, fields),
      with: more => make({ ...context, ...cleanContext(more) }),
      enabled: l => rank(l) >= min(),
    };
  }

  return { ...make({}), stats: () => ({ ...stats }) };
}
