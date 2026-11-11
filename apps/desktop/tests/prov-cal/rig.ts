import { FakeClock, SCOPE, createGmailEmulator } from '@aplos/emulators';
import type { AdapterAccount, CalendarPort, ProviderAdapter } from '@aplos/engine/ports';
import {
  calendarListWrites,
  parseSyncSet,
} from '../../../../packages/engine/src/sync/calendar-facts';
import { createCalendarPort } from '../../../../packages/engine/src/calendar/write-port';
import { calendarTargetOf } from '../../../../packages/engine/src/calendar/write-target';
import { createGoogleCalendar } from '../../src/host/providers/google/calendar';
import {
  ACCOUNT_ID,
  CaptureLog,
  GMAIL_SCOPES,
  StubGovernor,
  TokenStub,
} from '../prov-gmail/harness';
import { RigStore } from '../prov-gmail/store-rig';

// A calendar-writing rig (prov-cal): the Google adapter's calendar half over the Gmail/Calendar emulator, the engine's
// real store, and the engine's own `CalendarPort` between them — the same path `Event/set` takes, minus the method.

export const READ_SCOPES = [SCOPE.calendarList, SCOPE.calendarEventsReadonly];
export const WRITE_SCOPES = [SCOPE.calendarList, SCOPE.calendarEvents];

export interface WriteRigOptions {
  scopes?: string[];
  newId?: () => string;
  writeTimeoutMs?: number;
  /** What the actor's `writeRefused()` answers (default: it records a gap exactly when the scope is missing). */
  actorRefuses?: boolean;
}

export async function writeRig(options: WriteRigOptions = {}) {
  const clock = new FakeClock();
  const emu = createGmailEmulator({ clock, retryAfter: 'none' });
  emu.oauth.addClient('prov-cal-tests.apps.example.test');
  const scopes = options.scopes ?? [...GMAIL_SCOPES, ...WRITE_SCOPES];
  const session = await emu.oauth.signIn({
    clientId: 'prov-cal-tests.apps.example.test',
    scopes,
    fetch: emu.fetch,
  });
  const tokens = new TokenStub(
    emu,
    session.accessToken,
    session.refreshToken!,
    clock.now() + 86400_000,
  );
  const governor = new StubGovernor(clock, tokens, 600, 10);
  const log = new CaptureLog();
  const user = emu.users()[0];
  const account: AdapterAccount = {
    id: ACCOUNT_ID,
    provider: 'google',
    address: user.email,
    grantedScopes: scopes,
    capabilities: {
      labels: true,
      folders: false,
      drafts: true,
      serverSearch: true,
      calendar: true,
      filters: false,
      push: false,
      sendAs: true,
      unsubscribeHeaders: true,
      threading: 'native',
    },
  };
  // Every request the adapter sends, so a test can show what did (not) go out.
  const requests: { method: string; url: string; ifMatch: string | null; body?: string }[] = [];
  // Test hook: answer the next write with this status and body instead of the emulator (Google's own error text).
  const forced: { status: number; body: string }[] = [];
  // Test hooks for a write whose answer never arrives: it LANDS on the emulator and then the connection drops, or it hangs.
  // Test hook: answer the next READ (GET) with this status instead of the emulator.
  const forcedReads: { status: number; body: string }[] = [];
  const faults: ('dropAnswer' | 'hang')[] = [];
  const spy: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const read = req.method === 'GET' && forcedReads.length > 0 ? forcedReads.shift() : undefined;
    if (read)
      return new Response(read.body, {
        status: read.status,
        headers: { 'content-type': 'application/json' },
      });
    const fault = req.method !== 'GET' && faults.length > 0 ? faults.shift() : undefined;
    if (fault === 'hang')
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
      );
    if (fault === 'dropAnswer') {
      await emu.fetch(input, init);
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }
    const next = req.method !== 'GET' && forced.length > 0 ? forced.shift() : undefined;
    if (next)
      return new Response(next.body, {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    requests.push({
      method: req.method,
      url: req.url,
      ifMatch: req.headers.get('if-match'),
      ...(init?.body ? { body: String(init.body) } : {}),
    });
    return emu.fetch(input, init);
  };
  // The adapter under test: the calendar half with a chosen event id source.
  const calendar = createGoogleCalendar({
    fetch: spy,
    userAgent: 'prov-cal-tests',
    closed: new AbortController().signal,
    ...(options.newId ? { newId: options.newId } : {}),
    ...(options.writeTimeoutMs ? { writeTimeoutMs: options.writeTimeoutMs } : {}),
  });
  const adapter = { calendar } as unknown as ProviderAdapter;
  const store = new RigStore(account, () => clock.now());
  const stopper = new AbortController();
  const ctx = () => ({
    account,
    governor,
    clock: {
      now: () => clock.now(),
      sleep: (ms: number, s?: AbortSignal) => clock.sleep(ms, s),
      timer: () => ({ cancel() {} }),
    },
    log: log.with({ account: ACCOUNT_ID }),
    signal: stopper.signal,
    lookup: store.lookup,
    memory: store.memory,
    generation: store.seq,
  });
  let refused = 0;
  let ids = 0;
  const port: CalendarPort = createCalendarPort(id =>
    id === ACCOUNT_ID
      ? calendarTargetOf({
          adapter,
          actor: {
            deps: { store: store.raw, newId: () => `rig-${ids++}` },
            context: ctx,
            calendarWriteRefused: () => {
              refused += 1;
              return options.actorRefuses ?? !scopes.includes(SCOPE.calendarEvents);
            },
          },
        })
      : undefined,
  );
  const seedCalendars = async () => {
    const result = await calendar.listCalendars(undefined, ctx());
    store.raw.commit({
      opId: `cal-${store.seq}`,
      origin: 'sync',
      changes: 'fine',
      writes: calendarListWrites(account.id, result, parseSyncSet(store.memory.get('cal.sync'))),
    });
  };
  const events = () =>
    store.raw.read(q =>
      q.all<{
        remote_id: string;
        recurrence_id: string;
        master_remote_id: string | null;
        status: string;
        etag: string | null;
        data: string;
      }>(
        'SELECT e.remote_id, e.recurrence_id, e.master_remote_id, e.status, e.etag, e.data FROM events e JOIN calendars c ON c.id = e.calendar_id ORDER BY e.remote_id, e.recurrence_id',
      ),
    );
  /** What is on the (emulated) calendar, listed the way Google would, shown deleted events too. */
  const remoteEvents = async (): Promise<{ id: string; summary?: string; status?: string }[]> => {
    const res = await emu.fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(account.address)}/events?showDeleted=true&maxResults=250`,
      { headers: { authorization: `Bearer ${session.accessToken}` } },
    );
    return (
      ((await res.json()) as { items?: { id: string; summary?: string; status?: string }[] })
        .items ?? []
    );
  };
  const close = () => {
    clock.auto(false);
    stopper.abort();
    store.close();
  };
  return {
    clock,
    emu,
    port,
    account,
    calendarId: account.address,
    requests,
    forced,
    faults,
    forcedReads,
    logLines: () => JSON.stringify(log.lines),
    refused: () => refused,
    seedCalendars,
    events,
    remoteEvents,
    store,
    ctx,
    close,
  };
}
