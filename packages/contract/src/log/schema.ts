import * as z from 'zod/mini';
import { ClassifiedErrorSchema } from '../errors';
import {
  LOG_TEXT_MAX,
  logAddressHashPattern,
  logCodePattern,
  logEvents,
  logIdPattern,
  logLanes,
  logLevels,
} from './events';
import type { LogContext, LogEventId, LogFieldKind, LogFieldSpec, LogRecord } from './events';

/**
 * The zod/mini schemas of the log catalog, derived from the plain specs in `./events`: what a written line may hold.
 * Readers of a log (the diagnostics bundle, tests) validate with these; the engine's Logger enforces the same kinds
 * without zod, and tests assert every line it writes passes them.
 */

const kindSchemas: Record<Exclude<LogFieldKind, 'enum'>, () => z.ZodMiniType> = {
  count: () => z.int().check(z.nonnegative()),
  duration: () => z.number().check(z.nonnegative()),
  time: () => z.number().check(z.nonnegative()),
  bool: () => z.boolean(),
  id: () => z.string().check(z.regex(logIdPattern)),
  code: () => z.string().check(z.regex(logCodePattern)),
  address: () => z.string().check(z.regex(logAddressHashPattern)),
  text: () => z.string().check(z.maxLength(LOG_TEXT_MAX)),
  error: () => ClassifiedErrorSchema,
};

/** The schema of one field as written (an address as its hash). */
export function logFieldSchema(spec: LogFieldSpec): z.ZodMiniType {
  return spec.kind === 'enum'
    ? z.enum(spec.values as [string, ...string[]])
    : kindSchemas[spec.kind]();
}

const cache = new Map<string, z.ZodMiniType>();

/**
 * The strict schema of one event's written `data`: only the listed keys, each of its kind. Every key is optional here,
 * because the Logger still writes a line when it refuses a field (the refusal is counted in `dropped`); the call-site
 * type `LogFields` is what makes a field required.
 */
export function logEventSchema(id: LogEventId): z.ZodMiniType {
  let schema = cache.get(id);
  if (!schema) {
    const fields: Record<string, LogFieldSpec> = logEvents[id].fields;
    schema = z.strictObject(
      Object.fromEntries(Object.keys(fields).map(k => [k, z.optional(logFieldSchema(fields[k]))])),
    );
    cache.set(id, schema);
  }
  return schema;
}

const id = z.string().check(z.regex(logIdPattern));

export const LogContextSchema: z.ZodMiniType<LogContext> = z.object({
  account: z.optional(id),
  lane: z.optional(z.union([z.enum(logLanes), id])),
});

/** One written line. `data` is checked against its event with `logEventSchema`. */
export const LogRecordSchema: z.ZodMiniType<LogRecord> = z.object({
  t: z.number(),
  level: z.enum(logLevels),
  event: z.string(),
  account: z.optional(id),
  lane: z.optional(z.union([z.enum(logLanes), id])),
  data: z.record(z.string(), z.unknown()),
  dropped: z.optional(z.int().check(z.nonnegative())),
});
