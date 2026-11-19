/**
 * The Today tab's host (DESIGN §7.7 Today): today's events window, the calendars and the one clock in, `Today` out.
 * "Open Calendar" goes to the Calendar screen; opening an event does too until the calendar lane lands an event deep
 * link (REQUESTS.md in screens/ask).
 */
import { useEffect, useMemo, useState } from 'react';
import { api, useAgenda, useNow } from '../../data';
import type { Announce } from '../../ui/props';
import { navigate } from '../../shell';
import { Today } from './Today';
import { todayCalendar, todayModel, type TodayCalendar } from './today.model';
import './today.css';

export interface TodayHostProps {
  readonly announce?: Announce;
}

function dayRange(now: number): { from: number; to: number } {
  const d = new Date(now);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return { from, to };
}

/** Calendars by id for names and colours; refetched each time the host mounts (the tab does, on every visit). */
function useCalendars(): ReadonlyMap<string, TodayCalendar> {
  const [calendars, setCalendars] = useState<ReadonlyMap<string, TodayCalendar>>(() => new Map());
  useEffect(() => {
    let alive = true;
    api.calendar
      .get({})
      .then(({ list }) => {
        if (!alive) return;
        setCalendars(new Map(list.map(calendar => [calendar.id, todayCalendar(calendar)])));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return calendars;
}

export function TodayHost({ announce }: TodayHostProps) {
  const now = useNow({ granularity: 'minute' });
  const { from, to } = dayRange(now);
  const agenda = useAgenda({ kind: 'events', from, to });
  const calendars = useCalendars();
  const model = useMemo(
    () => todayModel(agenda.events, calendars, now),
    [agenda.events, calendars, now],
  );
  const [selected, setSelected] = useState<string | undefined>();
  return (
    <Today
      model={model}
      selectedId={selected}
      onSelect={setSelected}
      onOpenEvent={() => navigate('calendar')}
      onOpenCalendar={() => navigate('calendar')}
      onNewEvent={() => navigate('calendar')}
      announce={announce}
    />
  );
}
