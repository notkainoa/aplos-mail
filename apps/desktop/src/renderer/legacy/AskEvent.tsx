import { useMemo, useState } from 'react';
import { CalendarDays, Check, Clock, MapPin, Undo2, Users } from './icons';
import type { Account, CalendarEvent } from '@aplos/contract/legacy/types';
import { invoke, uid } from './bridge';
import { Avatar, Button, Notice, Select, cx } from './ui';
import { dayKey, timeRange } from './calendarTime';
import type { Contact } from './Compose';

/** Demo accounts keep a local calendar; connected accounts save to their primary host calendar. */
export const calendarFor = (a: Account) =>
  a.provider !== 'demo' && a.calendarConnected ? 'primary' : `demo-${a.id}`;
const dayOf = (iso: string, allDay: boolean) =>
  new Date(allDay ? iso.slice(0, 10) + 'T00:00:00' : iso);

type Props = {
  proposal: Partial<CalendarEvent>;
  accounts: Account[];
  accountId: string;
  events: CalendarEvent[];
  contacts: Contact[];
  savedId?: string;
  onSaved: (id: string) => void;
  notify: (text: string) => void;
  onEdit: (event: Partial<CalendarEvent>) => void;
  onCalendar: () => void;
};

/**
 * An event Ask prepared, shown the way it will sit in the calendar: a date tile, the time, place and guests, and
 * whether it clashes with anything. Nothing is written until "Add to calendar"; afterwards the card says so and
 * offers Undo. Details are changed in the full event editor (Edit).
 */
export function AskEvent({
  proposal,
  accounts,
  accountId,
  events,
  contacts,
  savedId,
  onSaved,
  notify,
  onEdit,
  onCalendar,
}: Props) {
  const choices = accounts.filter(a => a.provider === 'demo' || a.calendarConnected);
  const options = choices.length ? choices : accounts;
  const first = options.find(a => a.id === accountId) ?? options[0];
  const [value, setValue] = useState<CalendarEvent>(() => ({
    id: uid(),
    accountId: first?.id ?? '',
    calendarId: first ? calendarFor(first) : 'primary',
    title: '',
    start: '',
    end: '',
    allDay: false,
    location: '',
    description: '',
    guests: [],
    ...proposal,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const names = useMemo(
    () => new Map(contacts.map(c => [c.email.toLowerCase(), c.name])),
    [contacts],
  );
  // Already in the calendar (added from this card earlier, even before a restart): the same title at the same start.
  const existing = savedId
    ? events.find(e => e.id === savedId)
    : events.find(
        e => e.title === value.title && e.start === value.start && e.accountId === value.accountId,
      );
  const saved = !!existing;
  const start = dayOf(value.start, value.allDay);
  const day = dayKey(value.start);
  const overlaps = value.allDay
    ? []
    : events.filter(
        e =>
          e.id !== existing?.id &&
          !e.allDay &&
          dayKey(e.start) === day &&
          +new Date(e.start) < +new Date(value.end) &&
          +new Date(e.end) > +new Date(value.start),
      );
  const account = accounts.find(a => a.id === value.accountId);
  async function save() {
    setBusy(true);
    setError('');
    try {
      const result = await invoke<CalendarEvent>('calendar.save', { event: value });
      onSaved(result.id);
      notify(
        value.guests.length
          ? `Added to your calendar with ${value.guests.length} guest${value.guests.length === 1 ? '' : 's'}`
          : 'Added to your calendar',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    if (!existing) return;
    setBusy(true);
    setError('');
    try {
      await invoke('calendar.delete', { id: existing.id });
      onSaved('');
      notify('Removed from your calendar');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={cx('ask-card ask-event', saved && 'is-done')}>
      <header className="ask-card-kind">
        {saved ? <Check size={13} className="ask-card-check" /> : <CalendarDays size={13} />}
        <span>{saved ? 'Added to your calendar' : 'New event'}</span>
      </header>
      <div className="ask-event-main">
        <span className="ask-event-date" aria-hidden="true">
          <small>{start.toLocaleDateString([], { month: 'short' })}</small>
          <strong>{start.getDate()}</strong>
        </span>
        <div className="ask-event-info">
          <strong className="ask-card-title">{value.title || 'Untitled event'}</strong>
          <p>
            <Clock size={12} />
            {start.toLocaleDateString([], { weekday: 'short' })} · {timeRange(value)}
          </p>
          {value.location && (
            <p>
              <MapPin size={12} />
              {value.location}
            </p>
          )}
          {!!value.guests.length && (
            <p className="ask-event-guests">
              <Users size={12} />
              <span className="ask-event-faces">
                {value.guests.slice(0, 4).map(g => (
                  <Avatar key={g} name={names.get(g.toLowerCase()) || g} size={16} />
                ))}
              </span>
              <span>
                {value.guests.map(g => names.get(g.toLowerCase())?.split(' ')[0] || g).join(', ')}
              </span>
            </p>
          )}
        </div>
      </div>
      {!saved && (
        <p className={cx('ask-event-fit', overlaps.length > 0 && 'is-conflict')}>
          {value.allDay
            ? 'All day'
            : overlaps.length
              ? `Overlaps ${overlaps.map(e => e.title).join(', ')}`
              : 'You’re free then'}
        </p>
      )}
      {error && <Notice>{error}</Notice>}
      <footer>
        {saved ? (
          <>
            <span className="ask-card-note">{account?.email}</span>
            <Button
              variant="text"
              size="sm"
              icon={Undo2}
              disabled={busy}
              onClick={() => void undo()}
            >
              Undo
            </Button>
            <Button variant="secondary" size="sm" onClick={onCalendar}>
              View
            </Button>
          </>
        ) : (
          <>
            {options.length > 1 ? (
              <Select
                variant="plain"
                label="Calendar"
                className="ask-card-select"
                value={value.accountId}
                options={options.map(a => [a.id, a.email] as [string, string])}
                onChange={id => {
                  const a = accounts.find(x => x.id === id);
                  if (a) setValue({ ...value, accountId: id, calendarId: calendarFor(a) });
                }}
              />
            ) : (
              <span className="ask-card-note">{account?.email}</span>
            )}
            <Button variant="text" size="sm" onClick={() => onEdit(value)}>
              Edit
            </Button>
            <Button variant="primary" size="sm" loading={busy} onClick={() => void save()}>
              Add to calendar
            </Button>
          </>
        )}
      </footer>
    </div>
  );
}
