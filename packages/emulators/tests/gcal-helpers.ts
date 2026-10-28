import { SCOPE } from '../src/gmail';
import type { GmailEmulatorOptions } from '../src/gmail';
import { result, setup, type ApiResult, type Harness } from './gmail-helpers';

export const CAL = 'https://www.googleapis.com/calendar/v3';
export const ME = 'test.user@example.test';
export const CAL_SCOPES = ['openid', 'email', 'profile', SCOPE.calendarList, SCOPE.calendarEvents];

export interface CallInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  token?: string;
}

export interface CalHarness {
  h: Harness;
  emu: Harness['emu'];
  clock: Harness['clock'];
  /** Calls a path below /calendar/v3 with the signed-in token. */
  call(path: string, init?: CallInit): Promise<ApiResult>;
  /** Path of a calendar's events, with an optional event id and query. */
  events(
    calendarId: string,
    eventId?: string,
    query?: Record<string, string | number | boolean>,
  ): string;
}

/** An emulator with one signed-in user holding both Calendar scopes and a fast clock. */
export async function setupCal(
  options: Partial<GmailEmulatorOptions> & { scopes?: string[]; start?: number } = {},
): Promise<CalHarness> {
  const { scopes, ...rest } = options;
  const h = await setup({ scopes: scopes ?? CAL_SCOPES, ...rest });
  return {
    h,
    emu: h.emu,
    clock: h.clock,
    async call(path, init = {}) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${init.token ?? h.token}`,
        ...init.headers,
      };
      let body: string | undefined;
      if (init.body !== undefined) {
        body = JSON.stringify(init.body);
        headers['content-type'] ??= 'application/json';
      }
      return result(
        await h.emu.fetch(`${CAL}${path}`, { method: init.method ?? 'GET', headers, body }),
      );
    },
    events(calendarId, eventId, query) {
      const qs = query
        ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`
        : '';
      return `/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}${qs}`;
    },
  };
}

/** A timed event body in Los Angeles, easy to build in tests. */
export function timed(
  summary: string,
  startLocal: string,
  endLocal: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    summary,
    start: { dateTime: startLocal, timeZone: 'America/Los_Angeles' },
    end: { dateTime: endLocal, timeZone: 'America/Los_Angeles' },
    ...extra,
  };
}
