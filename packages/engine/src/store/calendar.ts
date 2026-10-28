import {
  StoreError,
  type CalendarDeleteWrite,
  type CalendarWrite,
  type EventDeleteWrite,
  type EventSweepWrite,
  type EventWrite,
} from './port';
import type { WriteScope } from './scope';

// Calendar facts (prov-cal, ARCH 5.5). Masters and overrides are stored, expanded on query (ADR-20). One `Event`
// change row per resource (master plus overrides), so a client re-reads the series.

/** The change-log id of an event resource. Provisional until FR-20 fixes the canonical event id; change it only here. */
export const eventChangeKey = (calendarRemoteId: string, remoteId: string) =>
  `${calendarRemoteId}/${remoteId}`;

function calendarRow(s: WriteScope, accountId: string, remoteId: string) {
  return s
    .q('SELECT id FROM calendars WHERE account_id = ? AND remote_id = ?')
    .get<{ id: number }>(accountId, remoteId)?.id;
}

export function calendar(s: WriteScope, w: CalendarWrite) {
  s.q(
    `INSERT INTO calendars(account_id, remote_id, name, color, is_primary, hidden, read_only, selected, time_zone, change_tag)
    VALUES(?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1), ?, ?)
    ON CONFLICT(account_id, remote_id) DO UPDATE SET name = excluded.name, color = excluded.color,
      is_primary = excluded.is_primary, hidden = excluded.hidden, read_only = excluded.read_only,
      selected = COALESCE(?, selected), time_zone = excluded.time_zone, change_tag = excluded.change_tag`,
  ).run(
    w.accountId,
    w.remoteId,
    w.name,
    w.color ?? null,
    Number(w.primary ?? false),
    Number(w.hidden),
    Number(w.readOnly),
    w.selected === undefined ? null : Number(w.selected),
    w.timeZone ?? null,
    w.changeTag ?? null,
    w.selected === undefined ? null : Number(w.selected),
  );
  s.mark('Calendar', w.accountId, w.remoteId, 'u');
}

export function calendarDelete(s: WriteScope, w: CalendarDeleteWrite) {
  const id = calendarRow(s, w.accountId, w.remoteId);
  if (id === undefined) return;
  for (const e of s
    .q('SELECT DISTINCT remote_id FROM events WHERE calendar_id = ?')
    .all<{ remote_id: string }>(id))
    s.mark('Event', w.accountId, eventChangeKey(w.remoteId, e.remote_id), 'd');
  s.q('DELETE FROM calendars WHERE id = ?').run(id); // cascades events
  s.mark('Calendar', w.accountId, w.remoteId, 'd');
}

export function event(s: WriteScope, w: EventWrite) {
  const cal = calendarRow(s, w.accountId, w.calendarRemoteId);
  if (cal === undefined) return s.missing(`Calendar ${w.calendarRemoteId}`);
  const keys = w.rows.map(r => r.recurrenceId ?? '');
  if (new Set(keys).size !== keys.length)
    throw new StoreError('invalid', `Event ${w.remoteId} repeats a recurrenceId`);
  s.q(
    'DELETE FROM events WHERE calendar_id = ? AND remote_id = ? AND recurrence_id NOT IN (SELECT value FROM json_each(?))',
  ).run(cal, w.remoteId, JSON.stringify(keys));
  const upsert = s.q(
    `INSERT INTO events(calendar_id, remote_id, recurrence_id, master_remote_id, status, etag, recurrence, start_utc,
      end_utc, all_day, data, ics, seen_gen) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(calendar_id, remote_id, recurrence_id) DO UPDATE SET master_remote_id = excluded.master_remote_id,
      status = excluded.status, etag = excluded.etag, recurrence = excluded.recurrence, start_utc = excluded.start_utc,
      end_utc = excluded.end_utc, all_day = excluded.all_day, data = excluded.data, ics = excluded.ics,
      seen_gen = CASE WHEN seen_gen IS NULL THEN excluded.seen_gen ELSE max(seen_gen, COALESCE(excluded.seen_gen, seen_gen)) END`,
  );
  for (const r of w.rows)
    upsert.run(
      cal,
      w.remoteId,
      r.recurrenceId ?? '',
      r.masterRemoteId ?? null,
      r.status,
      r.etag ?? null,
      r.recurrence ? JSON.stringify(r.recurrence) : null,
      r.startUtc ?? null,
      r.endUtc ?? null,
      Number(r.allDay),
      r.data,
      r.ics ?? null,
      w.seenGen ?? null,
    );
  s.mark(
    'Event',
    w.accountId,
    eventChangeKey(w.calendarRemoteId, w.remoteId),
    w.rows.length ? 'u' : 'd',
  );
}

export function eventDelete(s: WriteScope, w: EventDeleteWrite) {
  const cal = calendarRow(s, w.accountId, w.calendarRemoteId);
  if (cal === undefined) return;
  const gone = s
    .q('DELETE FROM events WHERE calendar_id = ? AND remote_id = ?')
    .run(cal, w.remoteId).changes;
  if (gone) s.mark('Event', w.accountId, eventChangeKey(w.calendarRemoteId, w.remoteId), 'd');
}

export function eventSweep(s: WriteScope, w: EventSweepWrite) {
  if (!Number.isInteger(w.generation))
    throw new StoreError('invalid', 'An event sweep needs an integer generation');
  const cal = calendarRow(s, w.accountId, w.calendarRemoteId);
  if (cal === undefined) return;
  const gone = s
    .q(
      `DELETE FROM events WHERE calendar_id = ?1 AND seen_gen IS NOT NULL AND seen_gen < ?2
      AND (?3 IS NULL OR start_utc >= ?3) AND (?4 IS NULL OR start_utc < ?4) RETURNING remote_id`,
    )
    .all<{ remote_id: string }>(cal, w.generation, w.from ?? null, w.to ?? null);
  for (const remoteId of new Set(gone.map(g => g.remote_id))) {
    const left = s
      .q('SELECT 1 FROM events WHERE calendar_id = ? AND remote_id = ? LIMIT 1')
      .get(cal, remoteId);
    s.mark('Event', w.accountId, eventChangeKey(w.calendarRemoteId, remoteId), left ? 'u' : 'd');
  }
}
