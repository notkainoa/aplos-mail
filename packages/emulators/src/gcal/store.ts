import type { Clock } from '../kit/clock';
import type { Random } from '../gmail/rng';
import { calNotFound } from './errors';
import type {
  AccessRole,
  CalendarListEntry,
  CalendarPatch,
  CalendarSpec,
  GcalEvent,
  GcalSettings,
  SentUpdate,
} from './types';

export interface EventRecord {
  event: GcalEvent;
  /** Value of the store's change counter at the last write; incremental syncs return rev > token. */
  rev: number;
  /** Creation order, the default list order. */
  seq: number;
  /**
   * An exception whose series changed shape (new start or rule). It stays as a cancelled tombstone so
   * sync clients hear about it, but it no longer overrides anything.
   */
  stale?: boolean;
}

export interface CalendarRecord {
  id: string;
  summary: string;
  description?: string;
  timeZone: string;
  accessRole: AccessRole;
  primary: boolean;
  selected: boolean;
  hidden: boolean;
  deleted: boolean;
  summaryOverride?: string;
  backgroundColor: string;
  colorId?: string;
  /** Change counter value of the last change a calendar-list client can see. */
  rev: number;
  seq: number;
  events: Map<string, EventRecord>;
}

export interface Owner {
  sub: string;
  email: string;
  name: string;
}

export interface StoreDeps {
  clock: Clock;
  random: Random;
  settings: () => GcalSettings;
  /** True for addresses with a Google account; `sendUpdates=externalOnly` skips them. */
  isGoogleAccount: (email: string) => boolean;
  sentUpdates: SentUpdate[];
}

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';
const PALETTE = [
  '#9fe1e7',
  '#b99aff',
  '#f83a22',
  '#fad165',
  '#92e1c0',
  '#ffad46',
  '#cabdbf',
  '#16a765',
];

/**
 * One user's calendars and events. A single change counter orders every visible change, so one
 * number is a sync cursor for the calendar list and for the events of any calendar.
 */
export class CalendarStore {
  readonly calendars = new Map<string, CalendarRecord>();
  rev = 0;
  private seq = 0;
  private readonly epochs = new Map<string, number>();

  constructor(
    readonly owner: Owner,
    readonly deps: StoreDeps,
  ) {}

  now(): number {
    return this.deps.clock.now();
  }

  nextRev(): number {
    return ++this.rev;
  }

  nextSeq(): number {
    return ++this.seq;
  }

  /** Google ids are lowercase base32hex, 26 characters when server-made. */
  newId(length = 26): string {
    let out = '';
    while (out.length < length) out += BASE32HEX[this.deps.random.int(0, 31)];
    return out;
  }

  // ---------- sync token epochs ----------

  /** Bumping a key makes every token issued under it before invalid. */
  expire(key: 'all' | 'list' | `events:${string}`): void {
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
  }

  epochFor(key: 'list' | `events:${string}`): number {
    return (this.epochs.get('all') ?? 0) + (this.epochs.get(key) ?? 0);
  }

  // ---------- calendars ----------

  /** A calendar the user can use: `primary` stands for the user's own, deleted entries are gone. */
  calendar(id: string): CalendarRecord {
    const cal = this.find(id);
    if (!cal || cal.deleted) throw calNotFound();
    return cal;
  }

  find(id: string): CalendarRecord | undefined {
    if (id === 'primary') return [...this.calendars.values()].find(c => c.primary);
    return this.calendars.get(id) ?? this.calendars.get(id.toLowerCase());
  }

  addCalendar(spec: CalendarSpec): CalendarRecord {
    const primary = spec.primary ?? false;
    const id =
      spec.id ?? (primary ? this.owner.email : `${this.newId(26)}@group.calendar.google.com`);
    const existing = this.calendars.get(id);
    const cal: CalendarRecord = existing ?? {
      id,
      summary: spec.summary,
      timeZone: spec.timeZone ?? 'America/Los_Angeles',
      accessRole: spec.accessRole ?? 'owner',
      primary,
      selected: spec.selected ?? true,
      hidden: spec.hidden ?? false,
      deleted: false,
      backgroundColor: spec.backgroundColor ?? PALETTE[this.calendars.size % PALETTE.length],
      rev: 0,
      seq: this.nextSeq(),
      events: new Map(),
    };
    // Subscribing again to a calendar that was removed brings the same entry back.
    if (existing)
      Object.assign(cal, {
        summary: spec.summary,
        deleted: false,
        selected: spec.selected ?? true,
        hidden: spec.hidden ?? false,
      });
    if (spec.description !== undefined) cal.description = spec.description;
    if (spec.summaryOverride !== undefined) cal.summaryOverride = spec.summaryOverride;
    if (spec.colorId !== undefined) cal.colorId = spec.colorId;
    cal.rev = this.nextRev();
    this.calendars.set(id, cal);
    return cal;
  }

  updateCalendar(id: string, patch: CalendarPatch): CalendarRecord {
    const cal = this.calendar(id);
    if (patch.hidden !== undefined) cal.hidden = patch.hidden;
    if (patch.selected !== undefined) cal.selected = patch.selected;
    if (patch.summaryOverride !== undefined) {
      if (patch.summaryOverride === null) delete cal.summaryOverride;
      else cal.summaryOverride = patch.summaryOverride;
    }
    if (patch.backgroundColor !== undefined) cal.backgroundColor = patch.backgroundColor;
    if (patch.colorId !== undefined) cal.colorId = patch.colorId;
    cal.rev = this.nextRev();
    return cal;
  }

  deleteCalendar(id: string): void {
    const cal = this.calendar(id);
    if (cal.primary) throw new Error('The primary calendar cannot be deleted');
    cal.deleted = true;
    cal.rev = this.nextRev();
  }

  /** The calendar's own title is read-only to list clients, so no sync entry results from it. */
  renameCalendar(id: string, summary: string): void {
    this.calendar(id).summary = summary;
  }

  entryView(cal: CalendarRecord): CalendarListEntry {
    return {
      kind: 'calendar#calendarListEntry',
      etag: `"${cal.rev.toString().padStart(8, '0')}${cal.seq.toString().padStart(4, '0')}000"`,
      id: cal.id,
      summary: cal.summary,
      ...(cal.summaryOverride !== undefined ? { summaryOverride: cal.summaryOverride } : {}),
      ...(cal.description !== undefined ? { description: cal.description } : {}),
      timeZone: cal.timeZone,
      ...(cal.colorId ? { colorId: cal.colorId } : {}),
      backgroundColor: cal.backgroundColor,
      foregroundColor: '#000000',
      accessRole: cal.accessRole,
      // Google leaves false flags out of the entry.
      ...(cal.selected ? { selected: true } : {}),
      ...(cal.hidden ? { hidden: true } : {}),
      ...(cal.primary ? { primary: true } : {}),
      ...(cal.deleted ? { deleted: true } : {}),
      defaultReminders: cal.primary ? [{ method: 'popup', minutes: 30 }] : [],
      conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] },
    };
  }
}
