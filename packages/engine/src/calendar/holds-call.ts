import type { CalendarPort, CalendarWriteResult } from '../ports';
import type { HeldCall } from './holds-types';

/** Makes the `CalendarPort` call a `HeldCall` describes: at once for a write that tells no one, or when a hold's window ends. */
export function runCall(calendar: CalendarPort, call: HeldCall): Promise<CalendarWriteResult> {
  if (call.op === 'put') return calendar.put(call.account, call.change);
  if (call.op === 'remove') return calendar.remove(call.account, call.ref);
  return calendar.rsvp(call.account, call.ref, call.response, call.opts);
}
