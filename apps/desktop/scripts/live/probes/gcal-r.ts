import { emptyResult, type ProbeContext, type ProbeResult, type SmokeProbe } from '../types';
import { errorClassOf, ProbeHttpError } from './http';

/**
 * Tier R Calendar probe: read-only and content-free — the same two GETs the syncer makes
 * (calendarList.list, then events.list on the primary calendar), keeping only counts and timings.
 * No event field, calendar name or id is stored or returned.
 */
const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

async function getJson(
  ctx: ProbeContext,
  path: string,
  query: Record<string, string | number | boolean>,
): Promise<{ json: Record<string, unknown>; ms: number }> {
  const start = ctx.now();
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const res = await ctx.fetch(`${CAL_BASE}${path}?${params}`, { method: 'GET' });
  const ms = ctx.now() - start;
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const errors = (json as { error?: { errors?: { reason?: string }[] } }).error?.errors;
    throw new ProbeHttpError(errorClassOf(res.status, errors?.[0]?.reason));
  }
  return { json, ms };
}

const FIELDS_LIST = 'kind,nextPageToken,nextSyncToken,items(id,primary,selected,hidden,accessRole)';
const FIELDS_EVENTS =
  'kind,nextPageToken,nextSyncToken,' +
  'items(id,status,start,end,recurrence,recurringEventId,originalStartTime,attendees,updated)';

export const calendarReadSync: SmokeProbe = {
  id: 'gcal.read-sync-shape',
  provider: 'gcal',
  tier: 'R',
  async run(ctx: ProbeContext): Promise<ProbeResult> {
    const result = emptyResult();
    try {
      const list = await getJson(ctx, '/users/me/calendarList', {
        maxResults: 250,
        showHidden: true,
        fields: FIELDS_LIST,
      });
      const entries = (Array.isArray(list.json.items) ? list.json.items : []) as {
        id?: string;
        primary?: boolean;
        hidden?: boolean;
        selected?: boolean;
      }[];
      result.counts.calendars = entries.length;
      result.counts.calendarPages = 1;
      result.counts.calendarsSyncable = entries.filter(
        e => (e.selected === true || e.primary === true) && e.hidden !== true,
      ).length;
      result.timingsMs.calendarList = list.ms;
      const primary = entries.find(e => e.primary === true);
      if (!primary?.id) {
        result.status = 'fail';
        return result;
      }

      // The real first-sync request shape: singleEvents=false, one page.
      const events = await getJson(ctx, `/calendars/${encodeURIComponent(primary.id)}/events`, {
        maxResults: 100,
        singleEvents: false,
        fields: FIELDS_EVENTS,
      });
      const items: Record<string, unknown>[] = Array.isArray(events.json.items)
        ? (events.json.items as Record<string, unknown>[])
        : [];
      result.counts.events = items.length;
      result.counts.eventPages = typeof events.json.nextPageToken === 'string' ? 2 : 1;
      result.counts.masters = items.filter(e => Array.isArray(e.recurrence)).length;
      result.counts.overrides = items.filter(e => typeof e.recurringEventId === 'string').length;
      result.counts.cancelled = items.filter(e => e.status === 'cancelled').length;
      result.counts.allDay = items.filter(
        e => typeof (e.start as { date?: string } | undefined)?.date === 'string',
      ).length;
      result.counts.zoned = items.filter(
        e => typeof (e.start as { timeZone?: string } | undefined)?.timeZone === 'string',
      ).length;
      result.counts.withAttendees = items.filter(e => Array.isArray(e.attendees)).length;
      result.counts.nextSyncToken = typeof events.json.nextSyncToken === 'string' ? 1 : 0;
      result.timingsMs.events = events.ms;
    } catch (error) {
      result.status = 'fail';
      const cls = error instanceof ProbeHttpError ? error.errorClass : 'other';
      result.errorClasses[cls] = (result.errorClasses[cls] ?? 0) + 1;
    }
    return result;
  },
};
