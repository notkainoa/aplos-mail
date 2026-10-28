import { logEvents } from '@aplos/contract';
import type { LogEventId, LogFieldSpec, LogFields } from '@aplos/contract';

export const eventIds = Object.keys(logEvents) as LogEventId[];

/** Fields for `id`, every listed field filled (optional ones too) by `value(kind, spec, key)`. */
export function sampleFields<Id extends LogEventId>(
  id: Id,
  value: (spec: LogFieldSpec, key: string) => unknown,
): LogFields<Id> {
  const fields: Record<string, LogFieldSpec> = logEvents[id].fields;
  return Object.fromEntries(
    Object.entries(fields).map(([key, spec]) => [key, value(spec, key)]),
  ) as LogFields<Id>;
}

/** A well-formed value of each kind, so every catalog event can be logged without a drop. */
export function validValue(spec: LogFieldSpec): unknown {
  switch (spec.kind) {
    case 'count':
      return 3;
    case 'duration':
      return 12.5;
    case 'time':
      return 1_793_000_000_000;
    case 'bool':
      return true;
    case 'id':
      return 'acc_1';
    case 'code':
      return 'gmail.users.threads.get';
    case 'enum':
      return spec.values![0];
    case 'address':
      return 'owner@mail.example';
    case 'text':
      return 'Service unavailable';
    case 'error':
      return {
        class: 'throttle',
        provider: 'google',
        method: 'gmail.users.threads.get',
        reason: 'rateLimitExceeded',
        status: 403,
        providerMessage: 'User-rate limit exceeded',
      };
  }
}
