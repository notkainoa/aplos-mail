/**
 * The Today tab (DESIGN §7.7 Today): `CalendarGrid`'s compact agenda for today, a dim "2 more" when later events are
 * folded, and "Open Calendar". Presentational: it takes `TodayModel` and reports intent through callbacks.
 */
import { CalendarGrid } from '../../ui/calendar';
import { Button } from '../../ui/buttons-keys';
import { Text } from '../../ui/surfaces';
import type { Announce } from '../../ui/props';
import type { TodayModel } from './today.model';

export interface TodayProps {
  model: TodayModel;
  selectedId?: string;
  onSelect: (id: string) => void;
  /** Return or a double click on an event: its detail. */
  onOpenEvent: (id: string, anchor: HTMLElement) => void;
  /** "Open Calendar" (⌃6). */
  onOpenCalendar: () => void;
  /** "New event · N" on an empty day. */
  onNewEvent: () => void;
  announce?: Announce;
}

const noop = () => undefined;

export function Today({
  model,
  selectedId,
  onSelect,
  onOpenEvent,
  onOpenCalendar,
  onNewEvent,
  announce,
}: TodayProps) {
  return (
    <div className="today-screen">
      <CalendarGrid
        view="agenda"
        agenda="today"
        start={model.day}
        events={model.events}
        now={model.now}
        weekStartsOn={0}
        selectedId={selectedId}
        onSelect={onSelect}
        onOpen={onOpenEvent}
        onCreate={noop}
        onMove={noop}
        onResize={noop}
        onOpenStack={noop}
        emptyAction={{
          label: 'New event',
          commandId: 'calendar.newEvent',
          onSelect: onNewEvent,
        }}
        label="Today"
        announce={announce}
      />
      {model.moreText ? (
        <div className="today-screen__more">
          <Text variant="small" tone="dim">
            {model.moreText}
          </Text>
        </div>
      ) : null}
      <div className="today-screen__open">
        <Button
          variant="text"
          icon="calendar"
          label="Open Calendar"
          commandId="nav.calendar"
          keyHint="always"
          onPress={onOpenCalendar}
        />
      </div>
    </div>
  );
}
