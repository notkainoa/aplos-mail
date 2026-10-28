import type { Clock } from '../kit/clock';
import { Random, mixSeed } from '../gmail/rng';
import { UnitMeter } from '../gmail/meter';
import type { TestUser } from '../gmail/oauth';
import type { MeterHelpers } from '../gmail/types';
import {
  deleteEvent,
  getEvent,
  insertEvent,
  insertInvitation,
  patchEvent,
  type WriteOptions,
} from './events';
import {
  generateCalendars,
  type GenerateCalendarsOptions,
  type GeneratedCalendars,
} from './generate';
import { CalendarStore } from './store';
import type {
  AbuseState,
  CalendarHelpers,
  CalendarListEntry,
  CalendarPatch,
  CalendarSpec,
  ExpireOptions,
  GcalEvent,
  GcalOptions,
  GcalSettings,
  InvitationSpec,
  ResponseStatus,
  SendUpdates,
  SentUpdate,
} from './types';

export interface HubDeps {
  clock: Clock;
  seed: number;
  options: GcalOptions;
  /** Resolves an email or sub to a test user; the first user when omitted. Throws for unknown users. */
  account(who?: string): TestUser;
  users(): TestUser[];
}

/** All users' calendars, plus the per-user request meter, the anti-abuse switch and the sent-updates log. */
export class CalendarHub implements CalendarHelpers {
  readonly settings: GcalSettings;
  readonly sentUpdates: SentUpdate[] = [];
  readonly meter: MeterHelpers;
  readonly requests = new UnitMeter();
  private readonly stores = new Map<string, CalendarStore>();
  private abuseState: AbuseState | null = null;

  constructor(private readonly deps: HubDeps) {
    this.settings = {
      requestsPerMinute: 600,
      chargeRefused: false,
      throttleShape: 'rateLimitExceeded403',
      retryAfter: 'none',
      syncTokenHorizonMs: 30 * 86_400_000,
      expansionHorizonMs: 2 * 365 * 86_400_000,
      abuseDurationMs: null,
      ...deps.options,
    };
    this.meter = {
      unitsInWindow: who =>
        this.requests.unitsInWindow(this.deps.account(who).sub, this.deps.clock.now()),
      perMinuteSeries: who => this.requests.perMinuteSeries(this.deps.account(who).sub),
      peakWindow: who => this.requests.peakWindow(this.deps.account(who).sub),
      reset: () => this.requests.reset(),
    };
  }

  /** The user's store, made on first use. */
  storeFor(who?: string): CalendarStore {
    const user = this.deps.account(who);
    let store = this.stores.get(user.sub);
    if (!store) {
      store = new CalendarStore(
        { sub: user.sub, email: user.email, name: user.name },
        {
          clock: this.deps.clock,
          random: new Random(mixSeed(this.deps.seed, 900 + this.stores.size)),
          settings: () => this.settings,
          isGoogleAccount: email =>
            this.deps.users().some(u => u.email.toLowerCase() === email.toLowerCase()),
          sentUpdates: this.sentUpdates,
        },
      );
      this.stores.set(user.sub, store);
      // Every Google account has a primary calendar named after its address.
      store.addCalendar({
        id: user.email,
        summary: user.email,
        primary: true,
        timeZone: 'America/Los_Angeles',
      });
    }
    return store;
  }

  // ---------- anti-abuse ----------

  /** The state while it holds; clears itself once its clock time has passed. */
  activeAbuse(now: number): AbuseState | null {
    if (this.abuseState && now >= this.abuseState.until) this.abuseState = null;
    return this.abuseState;
  }

  setAbuse(on: boolean, options: { forMs?: number } = {}): void {
    const duration = options.forMs ?? this.settings.abuseDurationMs;
    this.abuseState = on
      ? { until: duration === null ? Infinity : this.deps.clock.now() + duration }
      : null;
  }

  abuse(): AbuseState | null {
    return this.activeAbuse(this.deps.clock.now());
  }

  // ---------- helpers for tests ----------

  seed(options: GenerateCalendarsOptions = {}): GeneratedCalendars {
    return generateCalendars(this.storeFor(options.user), options);
  }

  listCalendars(user?: string): CalendarListEntry[] {
    const store = this.storeFor(user);
    return [...store.calendars.values()].map(c => store.entryView(c));
  }

  addCalendar(spec: CalendarSpec, user?: string): CalendarListEntry {
    const store = this.storeFor(user);
    return store.entryView(store.addCalendar(spec));
  }

  updateCalendar(calendarId: string, patch: CalendarPatch, user?: string): CalendarListEntry {
    const store = this.storeFor(user);
    return store.entryView(store.updateCalendar(calendarId, patch));
  }

  hideCalendar(calendarId: string, user?: string): CalendarListEntry {
    return this.updateCalendar(calendarId, { hidden: true }, user);
  }

  deselectCalendar(calendarId: string, user?: string): CalendarListEntry {
    return this.updateCalendar(calendarId, { selected: false }, user);
  }

  deleteCalendar(calendarId: string, user?: string): void {
    this.storeFor(user).deleteCalendar(calendarId);
  }

  renameCalendar(calendarId: string, summary: string, user?: string): void {
    this.storeFor(user).renameCalendar(calendarId, summary);
  }

  private writeOptions(
    sendUpdates: SendUpdates = 'none',
    conferenceDataVersion: 0 | 1 = 1,
  ): WriteOptions {
    return { sendUpdates, conferenceDataVersion, trusted: true };
  }

  getEvent(calendarId: string, eventId: string, user?: string): GcalEvent | undefined {
    try {
      return getEvent(this.storeFor(user).calendar(calendarId), eventId);
    } catch {
      return undefined;
    }
  }

  addEvent(
    calendarId: string,
    body: Record<string, unknown>,
    options: { user?: string; sendUpdates?: SendUpdates; conferenceDataVersion?: 0 | 1 } = {},
  ): GcalEvent {
    const store = this.storeFor(options.user);
    return insertEvent(
      store,
      store.calendar(calendarId),
      body,
      this.writeOptions(options.sendUpdates, options.conferenceDataVersion),
    );
  }

  addInvitation(spec: InvitationSpec, user?: string): GcalEvent {
    const store = this.storeFor(user);
    const cal = store.calendar(spec.calendarId ?? 'primary');
    const { organizer, guests = [], id } = spec;
    const rest: Record<string, unknown> = { ...spec };
    delete rest.organizer;
    delete rest.guests;
    delete rest.calendarId;
    delete rest.id;
    return insertInvitation(store, cal, {
      id,
      organizer,
      fields: {
        ...rest,
        attendees: [
          { email: organizer.email, responseStatus: 'accepted' },
          { email: store.owner.email, responseStatus: 'needsAction' },
          ...guests.map(email => ({ email })),
        ],
      },
    });
  }

  editEvent(
    calendarId: string,
    eventId: string,
    patch: Record<string, unknown>,
    options: { user?: string; conferenceDataVersion?: 0 | 1 } = {},
  ): GcalEvent {
    const store = this.storeFor(options.user);
    return patchEvent(
      store,
      store.calendar(calendarId),
      eventId,
      patch,
      this.writeOptions('none', options.conferenceDataVersion),
    );
  }

  removeEvent(calendarId: string, eventId: string, user?: string): void {
    const store = this.storeFor(user);
    deleteEvent(store, store.calendar(calendarId), eventId, this.writeOptions());
  }

  respond(
    calendarId: string,
    eventId: string,
    email: string,
    responseStatus: ResponseStatus,
    user?: string,
  ): GcalEvent {
    const event = this.getEvent(calendarId, eventId, user);
    if (!event?.attendees?.some(a => a.email.toLowerCase() === email.toLowerCase()))
      throw new Error(`${email} is not a guest of ${eventId}`);
    const attendees = event.attendees.map(a =>
      a.email.toLowerCase() === email.toLowerCase() ? { ...a, responseStatus } : a,
    );
    return this.editEvent(calendarId, eventId, { attendees }, { user });
  }

  expireSyncTokens(options: ExpireOptions = {}): void {
    const stores = options.user
      ? [this.storeFor(options.user)]
      : this.deps.users().map(u => this.storeFor(u.sub));
    for (const store of stores) {
      if (!options.kind && !options.calendarId) store.expire('all');
      if (options.kind === 'calendarList') store.expire('list');
      if (options.kind !== 'calendarList' && (options.kind === 'events' || options.calendarId)) {
        const ids = options.calendarId
          ? [store.find(options.calendarId)?.id ?? options.calendarId]
          : [...store.calendars.keys()];
        for (const id of ids) store.expire(`events:${id}`);
      }
    }
  }
}
