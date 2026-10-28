/**
 * The Today tab's container (DESIGN §7.7 Today): today's events window and the one clock in, `Today` out. Calendars
 * (names and colours) come through a port until `ui-calendar`'s `useCalendars` lands.
 */
import { useMemo, useState } from 'react';
import { useAgenda, useNow } from '../../data';
import type { Announce } from '../../ui/props';
import { Today } from './Today';
import { todayModel, type TodayCalendar } from './today.model';
import './today.css';

export interface TodayPorts {
  readonly calendars: ReadonlyMap<string, TodayCalendar>;
  readonly openEvent: (eventId: string, anchor: HTMLElement) => void;
  /** Runs `nav.calendar` (⌃6). */
  readonly openCalendar: () => void;
  /** Runs `calendar.newEvent` on today. */
  readonly newEvent: () => void;
  readonly announce?: Announce;
}

function dayRange(now: number): { from: number; to: number } {
  const d = new Date(now);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return { from, to };
}

export function TodayContainer({ ports }: { ports: TodayPorts }) {
  const now = useNow({ granularity: 'minute' });
  const { from, to } = dayRange(now);
  const agenda = useAgenda({ kind: 'events', from, to });
  const model = useMemo(() => todayModel(agenda.events, ports.calendars, now), [agenda.events, ports.calendars, now]);
  const [selected, setSelected] = useState<string | undefined>();
  return (
    <Today
      model={model}
      selectedId={selected}
      onSelect={setSelected}
      onOpenEvent={ports.openEvent}
      onOpenCalendar={ports.openCalendar}
      onNewEvent={ports.newEvent}
      announce={ports.announce}
    />
  );
}
